#!/usr/bin/env node
/**
 * WhatMCP over Streamable HTTP.
 *
 * This transport exists because some agent frameworks can only speak to a URL.
 * Understand what it changes before using it: stdio has no network surface at all,
 * while this puts nine years of message history behind a single bearer token. That
 * token is not an API key in the ordinary sense — it is a password to everything
 * anyone has ever written to you, including people who never consented to this
 * archive existing. Treat losing it as equivalent to losing your unlocked phone.
 *
 * Controls implemented here, in the order they run:
 *
 *   1. Host/Origin allowlist — blocks DNS rebinding, where a webpage the user
 *      visits resolves an attacker domain to 127.0.0.1 and reads this server
 *      through the browser. A bearer token does NOT stop that on its own if a
 *      browser is willing to attach credentials, so the check is independent.
 *   2. Bearer token, compared in constant time.
 *   3. A body limit, so an unauthenticated caller cannot buffer memory.
 *
 * What is deliberately NOT here: TLS. Terminating TLS correctly (certificates,
 * renewal, cipher configuration) is not something this process should own. Bind to
 * loopback and put a tunnel or reverse proxy in front — see the boot warning.
 */

import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { loadConfig, embedConfig, readFileConfig, CONFIG_PATH } from '../config.ts';
import { buildServer } from './tools.ts';
import { mountDashboard } from './dashboard.ts';
import { mountOAuth, validateAccessToken } from './oauth.ts';
import { emit } from './events.ts';
import { stats } from '../search/search.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const cfg = loadConfig();
const file = readFileConfig();

const PORT = Number(process.env.WHATMCP_HTTP_PORT ?? file.http_port ?? 8787);
const HOST = process.env.WHATMCP_HTTP_HOST ?? file.http_host ?? '127.0.0.1';
const TOKEN = process.env.WHATMCP_HTTP_TOKEN ?? file.http_token ?? '';

const isLoopback = HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost';
/** Set this once you have a stable hostname; derived per-request otherwise. */
const PUBLIC_URL = (process.env.WHATMCP_PUBLIC_URL ?? file.public_url ?? '').replace(/\/+$/, '');

/*
 * Refuse to start without a strong token.
 *
 * Not a warning. A server that exposes an entire message history and starts
 * unauthenticated because a config field was blank is not a degraded mode worth
 * having — especially since the failure is invisible until someone finds it.
 */
if (!TOKEN) {
  console.error(
    'refusing to start: no HTTP token configured.\n' +
      'This endpoint exposes your entire WhatsApp history and does not run open.\n\n' +
      `Generate one:  npm run wa -- http-token\n` +
      `Stored 0600 in ${CONFIG_PATH}`,
  );
  process.exit(1);
}
if (TOKEN.length < 32) {
  console.error(
    `refusing to start: HTTP token is ${TOKEN.length} chars, minimum 32.\n` +
      'A short token is brute-forceable on an exposed endpoint. Regenerate:\n' +
      '  npm run wa -- http-token',
  );
  process.exit(1);
}

let embedCfg: { model: string; dimensions: number; apiKey: string } | null = null;
let keyError: string | null = null;
try {
  embedCfg = embedConfig(cfg);
} catch (e) {
  keyError = (e as Error).message;
}

// --- auth --------------------------------------------------------------------

const expected = Buffer.from(TOKEN);

/**
 * Two credentials are accepted, and the order matters.
 *
 * The static token is checked first because it is the fast path for Claude Code
 * and Claude Desktop, which have used it since before OAuth existed here. OAuth
 * access tokens are the ChatGPT path — ChatGPT refuses static bearer tokens
 * outright, which is the entire reason the authorization server exists.
 *
 * Both land in the same Authorization: Bearer header, so this cannot be told
 * apart by shape; it tries one, then the other.
 */
type Principal =
  | { kind: 'static' }
  | { kind: 'oauth'; clientId: string; scope: string };

function principalFor(req: express.Request): Principal | null {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;

  const got = Buffer.from(token);
  // Length check first: timingSafeEqual throws on mismatched lengths.
  if (got.length === expected.length && timingSafeEqual(got, expected)) return { kind: 'static' };

  const oauth = validateAccessToken(token);
  return oauth
    ? { kind: 'oauth', clientId: oauth.client_id, scope: oauth.scope }
    : null;
}

/**
 * Host and Origin allowlist.
 *
 * `allowedHosts` defaults to loopback names plus whatever host the operator
 * configured. A request whose Host header is not on the list is refused even with
 * a valid token, which is what defeats DNS rebinding: the attacker controls the
 * name that resolved to this address, not the Host value we accept.
 *
 * Any Origin header at all means a browser sent this, and no legitimate MCP client
 * is a browser page. Rejecting unknown origins outright costs nothing and removes
 * the whole class.
 */
const allowedHosts = new Set(
  (file.http_allowed_hosts ?? []).concat(['localhost', '127.0.0.1', '[::1]']),
);
if (!isLoopback) allowedHosts.add(HOST);

/*
 * Suffix matching exists for one specific case: a Cloudflare quick tunnel mints a
 * new random `*.trycloudflare.com` hostname on every restart, so an exact
 * allowlist would break on each reconnect and invite someone to "fix" it by
 * disabling the check entirely.
 *
 * Be honest about what this costs. Allowing a suffix means any hostname under
 * that domain passes the Host check, which weakens it as an anti-rebinding
 * control for that domain. It is an acceptable trade only because a public
 * tunnel already changes the threat model: the bearer token, not the Host header,
 * is what stands between the internet and the archive. Never add a suffix for a
 * domain you do not control the security properties of.
 */
const allowedSuffixes = (file.http_allowed_host_suffixes ?? []).map((s) => s.toLowerCase());

function hostAllowed(req: express.Request): boolean {
  const host = (req.get('host') ?? '').split(':')[0].toLowerCase();
  if (allowedHosts.has(host) || allowedHosts.has(`[${host}]`)) return true;
  return allowedSuffixes.some((sfx) => host.endsWith(sfx));
}

/** Did this request arrive on the loopback interface's own hostname? */
export function isLoopbackHost(req: express.Request): boolean {
  const host = (req.get('host') ?? '').split(':')[0].toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function originAllowed(req: express.Request): boolean {
  const origin = req.get('origin');
  if (!origin) return true; // non-browser client
  const allowed = file.http_allowed_origins ?? [];
  return allowed.includes(origin);
}

const app = express();
app.disable('x-powered-by');
// Loopback is the only trusted proxy hop, so req.ip stays honest in auth logs
// instead of reflecting whatever an attacker put in X-Forwarded-For.
app.set('trust proxy', 'loopback');

// Mounted per-route rather than globally so the guard order below is explicit.
const jsonBody = express.json({ limit: '4mb' });

function guard(req: express.Request, res: express.Response): boolean {
  if (!hostAllowed(req)) {
    res.status(403).json({
      jsonrpc: '2.0',
      error: { code: -32003, message: 'Host not allowed' },
      id: null,
    });
    return false;
  }
  if (!originAllowed(req)) {
    res.status(403).json({
      jsonrpc: '2.0',
      error: { code: -32003, message: 'Origin not allowed' },
      id: null,
    });
    return false;
  }
  if (!principalFor(req)) {
    console.error(`auth failure from ${req.ip} at ${new Date().toISOString()}`);
    emit('auth', 'rejected an unauthenticated /mcp request', {
      level: 'warn',
      detail: { ip: req.ip, host: req.get('host') },
    });
    /*
     * RFC 9728: point the client at the protected-resource metadata. Without this
     * header an MCP client that supports OAuth has no way to discover the
     * authorization server and simply reports "unauthorized" with no path
     * forward -- which is exactly how a working server looks broken.
     */
    const proto = (req.get('x-forwarded-proto') ?? req.protocol ?? 'http').split(',')[0].trim();
    const origin = PUBLIC_URL || `${proto}://${req.get('host')}`;
    res.setHeader(
      'WWW-Authenticate',
      `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    );
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    });
    return false;
  }
  return true;
}

const guarded: express.RequestHandler = (req, res, next) => {
  if (guard(req, res)) next();
};

/**
 * Liveness only, and deliberately contentless.
 *
 * An unauthenticated endpoint that reported message counts and date ranges would
 * leak real information about the owner — that they have 50k messages going back
 * to 2017 is not nothing. Counts require the token.
 */
/*
 * The app icon, served same-origin.
 *
 * Public rather than loopback-only, deliberately: the OAuth consent page IS
 * public — ChatGPT redirects a browser to it — so a loopback-only icon would
 * show as broken there. It reveals nothing the consent page does not already
 * state outright.
 *
 * Served as a route rather than inlined as a data: URI so both pages can keep
 * `img-src 'self'` instead of allowing data: URIs wholesale, and so the icon
 * stays a file that can be replaced without editing HTML.
 */
const FAVICON = readFileSync(join(import.meta.dirname, '../../assets/whatmcp.png'));
const sendIcon = (_req: express.Request, res: express.Response) => {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.end(FAVICON);
};
app.get('/favicon.png', sendIcon);
// Browsers request /favicon.ico unprompted; answering with the same bytes beats
// logging a 404 on every page load.
app.get('/favicon.ico', sendIcon);

app.get('/health', (_req, res) => {
  res.json({ ok: existsSync(cfg.store), service: 'whatmcp' });
});

app.get('/status', (req, res) => {
  if (!guard(req, res)) return;
  if (!existsSync(cfg.store)) {
    res.status(503).json({ ok: false, store: 'not built' });
    return;
  }
  res.json({
    ok: true,
    ...stats({
      storePath: cfg.store,
      embedCfg: embedCfg ?? { model: cfg.openaiModel, dimensions: cfg.openaiDims, apiKey: '' },
    }),
  });
});

/*
 * Stateless: a fresh server and transport per request.
 *
 * This server holds no per-client state worth keeping, and statelessness means
 * there is no session table to exhaust or leak, and no cross-request state for one
 * caller to observe from another.
 */
app.post('/mcp', guarded, jsonBody, async (req, res) => {
  // Which credential was used matters: it distinguishes a ChatGPT session from
  // Claude Code, which is otherwise invisible once both are just Bearer headers.
  const principal = principalFor(req)!;
  const viaOAuth = principal.kind === 'oauth';
  const method = (req.body as any)?.method;
  if (method && method !== 'initialize') {
    emit('mcp', `${method} via ${viaOAuth ? 'OAuth' : 'static token'}`, {
      detail: { host: req.get('host') },
    });
  }

  const server = buildServer({
    cfg,
    embedCfg,
    keyError,
    // OAuth consent grants whatmcp:read only. The static operator token retains
    // the historical sync capability; the local dashboard has its own sync gate.
    allowSync: principal.kind === 'static',
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('mcp request failed:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: null,
      });
    }
  }
});

// Stateless mode has no stream to resume and no session to delete.
const methodNotAllowed = (_req: express.Request, res: express.Response) =>
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed; use POST /mcp' },
    id: null,
  });
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

/*
 * The dashboard, mounted last.
 *
 * It brings its own auth (token -> HttpOnly SameSite=Strict session cookie),
 * because the /mcp rule above rejects anything carrying an Origin header and a
 * browser always sends one. Two different clients, two different threat models,
 * two separate gates — sharing one would mean loosening the strict one.
 */
/*
 * OAuth, mounted before the dashboard.
 *
 * Unlike the dashboard, /authorize MUST be publicly reachable: ChatGPT redirects
 * the user's own browser to it, and that browser resolves the tunnel hostname,
 * not loopback. So this is a public HTML form -- the one deliberately public
 * browser surface here -- and oauth.ts carries the rate limiting that makes that
 * acceptable.
 */
mountOAuth(app, { token: TOKEN, publicUrl: PUBLIC_URL || undefined });

if (process.env.WHATMCP_NO_DASHBOARD !== '1') {
  mountDashboard(app, { cfg, embedCfg, token: TOKEN, port: PORT });
}

const server = app.listen(PORT, HOST, () => {
  console.error(`whatmcp http on http://${HOST}:${PORT}/mcp`);
  console.error(`  archive: ${cfg.store}${existsSync(cfg.store) ? '' : ' (NOT BUILT)'}`);
  console.error(`  auth:    bearer token required (${TOKEN.length} chars)`);
  console.error(`  hosts:   ${[...allowedHosts].join(', ')}`);
  if (process.env.WHATMCP_NO_DASHBOARD !== '1') {
    console.error(`  dash:    http://${HOST}:${PORT}/  (loopback only)`);
  }
  console.error(`  oauth:   /authorize /token /register  (public)`);
  if (!PUBLIC_URL) {
    console.error(
      '           no public_url set - OAuth issuer is derived per request,\n' +
      '           so a rotating tunnel hostname will invalidate registrations.',
    );
  }
  if (keyError) console.error('  WARNING: no OpenAI key — semantic search disabled');

  if (!isLoopback) {
    console.error(
      `\n  !! BOUND TO ${HOST}, NOT LOOPBACK !!\n` +
        `  Traffic to this port is UNENCRYPTED. Anyone able to observe the network\n` +
        `  sees the bearer token and every message it returns, in cleartext.\n` +
        `  Prefer binding 127.0.0.1 and fronting it with a tunnel that terminates\n` +
        `  TLS (cloudflared, tailscale funnel, ngrok) instead of exposing it directly.\n`,
    );
  }
});

// Keepalive headroom for slow agent clients; headersTimeout still guards slowloris.
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
