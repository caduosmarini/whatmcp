/**
 * OAuth 2.1 authorization server for the MCP endpoint.
 *
 * This exists because ChatGPT will not accept a static bearer token — it requires
 * OAuth with dynamic client registration and PKCE, and refuses machine-to-machine
 * grants. Claude Code and Claude Desktop are happy with the plain token, so this
 * layer is additive: the static token keeps working everywhere it already did.
 *
 * The unusual thing about this authorization server is that it has exactly one
 * user and no user database. "Logging in" is proving you hold the bearer token,
 * which is already the credential for this archive. So /authorize is a consent
 * screen with a token field, and everything downstream is standard OAuth.
 *
 * Design decisions that are load-bearing:
 *
 *   - PKCE with S256 is REQUIRED, not optional. OAuth 2.1 removes the implicit
 *     flow and mandates PKCE for public clients, and ChatGPT registers as one.
 *   - Codes and tokens are stored as SHA-256 hashes, never in the clear. This
 *     file lives on a laptop that syncs backups; a leaked oauth.db should not be
 *     a leaked archive.
 *   - Authorization codes are single-use with a 60-second TTL, bound to the
 *     client, the redirect URI, the PKCE challenge, and the resource. Replaying
 *     one is useless.
 *   - State is persisted to SQLite rather than kept in memory, because launchd
 *     restarts this process on crash and after reboot. In-memory tokens would
 *     silently log ChatGPT out at random intervals, which reads as "the
 *     connector is flaky" rather than as a design choice.
 *
 * NOTE ON EXPOSURE: /authorize is a public HTML form that accepts the archive's
 * bearer token. That is a new surface — see the rate limiter below, which is the
 * reason it is acceptable rather than an afterthought.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// A value import, not `import type`: express.urlencoded and express.json are
// called below, and type-stripping erases a type-only import entirely.
import express from 'express';

import { DATA_DIR, ensureDataDir } from '../config.ts';
import { emit } from './events.ts';

const CONSENT_HTML = readFileSync(join(import.meta.dirname, 'consent.html'), 'utf8');

const CODE_TTL_MS = 60_000;
const ACCESS_TTL_MS = 60 * 60 * 1000;        // 1 hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SCOPE = 'whatmcp:read';
const MAX_CLIENTS = 200;
const MAX_CLIENT_NAME = 120;
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI = 2048;
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
const REGISTRATIONS_PER_WINDOW = 10;
const MAX_ACCESS_TOKENS_PER_CLIENT = 20;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// --- storage -----------------------------------------------------------------

/**
 * Separate database file, deliberately.
 *
 * The MCP server opens the archive READ-ONLY, which is a property worth keeping —
 * it means a bug in tool handling cannot corrupt nine years of history. Writing
 * OAuth state into that same file would force a writable handle and throw that
 * guarantee away for the sake of one table.
 */
function openOAuthDb(): DatabaseSync {
  ensureDataDir();
  const path = join(DATA_DIR, 'oauth.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  chmodSync(path, 0o600);
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
    if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      client_id     TEXT PRIMARY KEY,
      name          TEXT,
      redirect_uris TEXT NOT NULL,   -- JSON array
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS codes (
      code_hash    TEXT PRIMARY KEY,
      client_id    TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      challenge    TEXT NOT NULL,    -- PKCE S256 challenge
      resource     TEXT,
      scope        TEXT NOT NULL,
      expires_at   INTEGER NOT NULL,
      used         INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tokens (
      token_hash TEXT PRIMARY KEY,
      client_id  TEXT NOT NULL,
      kind       TEXT NOT NULL,      -- 'access' | 'refresh'
      scope      TEXT NOT NULL,
      resource   TEXT,
      expires_at INTEGER NOT NULL,
      revoked    INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tokens_client ON tokens (client_id);
  `);
  return db;
}

export interface OAuthDeps {
  /** The static bearer token; proving possession of it is what /authorize checks. */
  token: string;
  /** Explicit public origin, e.g. https://x.trycloudflare.com. Derived if absent. */
  publicUrl?: string;
}

/**
 * The externally visible origin of this server.
 *
 * OAuth metadata must advertise URLs the client can actually reach, so this has
 * to be the tunnel's hostname rather than 127.0.0.1. `X-Forwarded-Proto` from
 * cloudflared is what makes the scheme https; `trust proxy` is set to loopback in
 * http.ts so only the local tunnel process can influence it.
 */
function originOf(req: express.Request, deps: OAuthDeps): string {
  if (deps.publicUrl) return deps.publicUrl.replace(/\/+$/, '');
  const proto = (req.get('x-forwarded-proto') ?? req.protocol ?? 'http').split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

export function consentSecurityHeaders(redirectUri: string): {
  redirectOrigin: string;
  headers: Record<string, string>;
} {
  let redirectOrigin = "'none'";
  try {
    redirectOrigin = new URL(redirectUri).origin;
  } catch {
    // Invalid redirect URIs are rejected before consent rendering. Keeping a
    // deny-all fallback makes this helper safe if a future call site gets it wrong.
  }
  return {
    redirectOrigin,
    headers: {
      'Content-Security-Policy':
        `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; ` +
        `form-action 'self' ${redirectOrigin}; frame-ancestors 'none'; base-uri 'none'`,
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'no-store',
    },
  };
}

/**
 * Brute-force damper for the public consent form.
 *
 * The token is 256 bits, so this is not what makes guessing infeasible — that is
 * arithmetic. This exists so that a sustained guessing campaign is visible in the
 * log and cheap to absorb, rather than an unbounded request flood against a form
 * that does a constant-time compare on every hit.
 */
class Attempts {
  private hits = new Map<string, { n: number; until: number }>();

  blockedFor(ip: string): number {
    const e = this.hits.get(ip);
    if (!e) return 0;
    return Math.max(0, e.until - Date.now());
  }

  fail(ip: string): void {
    const e = this.hits.get(ip) ?? { n: 0, until: 0 };
    e.n++;
    // 5 free attempts, then exponential lockout capped at 15 minutes.
    if (e.n > 5) e.until = Date.now() + Math.min(2 ** (e.n - 5) * 1000, 900_000);
    this.hits.set(ip, e);
  }

  succeed(ip: string): void {
    this.hits.delete(ip);
  }
}

/** Fixed-window limiter with bounded bookkeeping for unauthenticated endpoints. */
export class FixedWindowLimiter {
  private hits = new Map<string, { n: number; resetAt: number }>();
  private limit: number;
  private windowMs: number;
  private maxKeys: number;

  constructor(limit: number, windowMs: number, maxKeys = 10_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  take(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterMs: number } {
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.hits.size >= this.maxKeys) {
        for (const [k, v] of this.hits) {
          if (v.resetAt <= now) this.hits.delete(k);
        }
        if (this.hits.size >= this.maxKeys) {
          const oldest = this.hits.keys().next().value as string | undefined;
          if (oldest) this.hits.delete(oldest);
        }
      }
      entry = { n: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    if (entry.n >= this.limit) {
      return { ok: false, retryAfterMs: Math.max(1, entry.resetAt - now) };
    }
    entry.n++;
    return { ok: true };
  }
}

export interface Registration {
  name: string;
  redirectUris: string[];
}

/** Validate and bound every attacker-controlled value persisted by DCR. */
export function parseRegistration(body: any): Registration {
  const uris: unknown = body?.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    throw new Error(`redirect_uris must contain 1-${MAX_REDIRECT_URIS} URLs`);
  }

  const redirectUris: string[] = [];
  for (const value of uris) {
    const uri = String(value);
    if (uri.length > MAX_REDIRECT_URI) throw new Error('redirect_uri is too long');
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new Error('redirect_uri is not a URL');
    }
    const loopback = parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost' || parsed.hostname === '::1';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      throw new Error('redirect_uris must be https (or http on loopback)');
    }
    if (parsed.hash) throw new Error('redirect_uris must not contain fragments');
    redirectUris.push(uri);
  }

  const rawName = String(body?.client_name ?? 'unnamed');
  if (rawName.length > MAX_CLIENT_NAME) throw new Error('client_name is too long');
  // Keep durable logs single-line and free of terminal control characters.
  const name = rawName.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim() || 'unnamed';
  return { name, redirectUris };
}

function pruneClients(db: DatabaseSync): void {
  const now = Date.now();
  // Never-approved registrations are expendable after a day. Clients whose last
  // token expired are retained for 90 days so reconnecting clients remain stable.
  db.prepare(`
    DELETE FROM clients
    WHERE created_at < ?
      AND NOT EXISTS (SELECT 1 FROM tokens t WHERE t.client_id = clients.client_id)
  `).run(now - 24 * 60 * 60 * 1000);
  db.prepare(`
    DELETE FROM clients
    WHERE created_at < ?
      AND NOT EXISTS (
        SELECT 1 FROM tokens t
        WHERE t.client_id = clients.client_id AND t.revoked = 0 AND t.expires_at > ?
      )
  `).run(now - 90 * 24 * 60 * 60 * 1000, now);
}

export function mountOAuth(app: express.Express, deps: OAuthDeps): void {
  const db = openOAuthDb();
  shared = db;
  const attempts = new Attempts();
  const registrations = new FixedWindowLimiter(
    REGISTRATIONS_PER_WINDOW,
    REGISTRATION_WINDOW_MS,
  );
  const form = express.urlencoded({ extended: false, limit: '64kb' });
  const json = express.json({ limit: '64kb' });

  // --- discovery -------------------------------------------------------------

  /*
   * RFC 9728. A client that gets a 401 from /mcp reads the WWW-Authenticate
   * header, fetches this, and learns which authorization server to talk to.
   * Served at both the bare path and the /mcp-suffixed variant because clients
   * differ on which they probe.
   */
  const protectedResource = (req: express.Request, res: express.Response) => {
    const origin = originOf(req, deps);
    res.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
    });
  };
  app.get('/.well-known/oauth-protected-resource', protectedResource);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResource);

  /* RFC 8414 authorization server metadata. */
  const asMetadata = (req: express.Request, res: express.Response) => {
    const origin = originOf(req, deps);
    res.json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      revocation_endpoint: `${origin}/revoke`,
      scopes_supported: [SCOPE],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      // S256 only. OAuth 2.1 forbids "plain", and advertising it would invite a
      // client to downgrade to a challenge that protects nothing.
      code_challenge_methods_supported: ['S256'],
      // ChatGPT registers as a public client; there is no secret to present.
      token_endpoint_auth_methods_supported: ['none'],
    });
  };
  app.get('/.well-known/oauth-authorization-server', asMetadata);
  app.get('/.well-known/oauth-authorization-server/mcp', asMetadata);

  // --- dynamic client registration (RFC 7591) --------------------------------

  const registrationLimit: express.RequestHandler = (req, res, next) => {
    const result = registrations.take(req.ip ?? 'unknown');
    if (!result.ok) {
      res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      res.status(429).json({ error: 'too_many_requests' });
      return;
    }
    next();
  };

  app.post('/register', registrationLimit, json, (req, res) => {
    let registration: Registration;
    try {
      registration = parseRegistration(req.body ?? {});
    } catch (e) {
      res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: (e as Error).message,
      });
      return;
    }

    pruneClients(db);
    let count = Number((db.prepare('SELECT COUNT(*) c FROM clients').get() as any).c);
    if (count >= MAX_CLIENTS) {
      db.prepare(`
        DELETE FROM clients WHERE client_id IN (
          SELECT c.client_id FROM clients c
          WHERE NOT EXISTS (SELECT 1 FROM tokens t WHERE t.client_id = c.client_id)
          ORDER BY c.created_at ASC LIMIT 20
        )
      `).run();
      count = Number((db.prepare('SELECT COUNT(*) c FROM clients').get() as any).c);
    }
    if (count >= MAX_CLIENTS) {
      res.status(503).json({
        error: 'temporarily_unavailable',
        error_description: 'client registration capacity reached',
      });
      return;
    }

    const clientId = randomBytes(16).toString('hex');
    db.prepare('INSERT INTO clients (client_id, name, redirect_uris, created_at) VALUES (?,?,?,?)')
      .run(clientId, registration.name, JSON.stringify(registration.redirectUris), Date.now());

    console.error(`oauth: registered client ${clientId} (${registration.name})`);
    emit('oauth', `client registered: ${registration.name}`, {
      detail: { client_id: clientId },
    });
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: registration.redirectUris,
      client_name: registration.name,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  // --- authorization ---------------------------------------------------------

  interface AuthRequest {
    client_id: string;
    redirect_uri: string;
    state: string;
    challenge: string;
    resource: string;
    scope: string;
  }

  /**
   * Validate an /authorize request without yet deciding whether to grant it.
   *
   * Errors here must NOT redirect back to the client: if client_id or
   * redirect_uri is bad, the redirect target is exactly what we cannot trust, and
   * bouncing to it would turn this endpoint into an open redirect.
   */
  function parseAuthRequest(q: any): { ok: true; req: AuthRequest } | { ok: false; msg: string } {
    const clientId = String(q.client_id ?? '');
    const row = db.prepare('SELECT redirect_uris FROM clients WHERE client_id = ?').get(clientId) as
      | { redirect_uris: string }
      | undefined;
    if (!row) return { ok: false, msg: 'Unknown client_id. Register the client first.' };

    const redirectUri = String(q.redirect_uri ?? '');
    const registered: string[] = JSON.parse(row.redirect_uris);
    // Exact string match, per OAuth 2.1. Prefix or "startsWith" matching is the
    // classic way this becomes an open redirect.
    if (!registered.includes(redirectUri)) {
      return { ok: false, msg: 'redirect_uri does not exactly match a registered URI.' };
    }
    if (String(q.response_type ?? '') !== 'code') {
      return { ok: false, msg: 'Only response_type=code is supported.' };
    }
    if (String(q.code_challenge_method ?? '') !== 'S256') {
      return { ok: false, msg: 'PKCE with code_challenge_method=S256 is required.' };
    }
    const challenge = String(q.code_challenge ?? '');
    if (challenge.length < 43) return { ok: false, msg: 'Missing or malformed code_challenge.' };

    const requestedScope = String(q.scope ?? SCOPE).trim() || SCOPE;
    if (requestedScope !== SCOPE) {
      return { ok: false, msg: `Only scope=${SCOPE} is supported.` };
    }

    return {
      ok: true,
      req: {
        client_id: clientId,
        redirect_uri: redirectUri,
        state: String(q.state ?? ''),
        challenge,
        resource: String(q.resource ?? ''),
        scope: requestedScope,
      },
    };
  }

  function renderConsent(res: express.Response, vars: Record<string, string>, status = 200): void {
    /*
     * Derived here rather than at each call site, so it cannot be forgotten in
     * one of them — and a missing redirect_origin does not fail loudly, it just
     * makes the approve button do nothing (see the CSP comment in consent.html).
     */
    const { redirectOrigin, headers } = consentSecurityHeaders(vars.redirect_uri);
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    let html = CONSENT_HTML.replaceAll('{{redirect_origin}}', escapeHtml(redirectOrigin));
    for (const [k, v] of Object.entries(vars)) {
      // Values are escaped before substitution; they end up inside HTML attributes
      // and text nodes, and client_name in particular is attacker-supplied at
      // registration time.
      html = html.replaceAll(`{{${k}}}`, escapeHtml(v));
    }
    res.status(status).type('html').send(html);
  }

  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  app.get('/authorize', (req, res) => {
    const parsed = parseAuthRequest(req.query);
    if (!parsed.ok) {
      res.status(400).type('text').send(`Authorization request rejected: ${parsed.msg}`);
      return;
    }
    const client = db.prepare('SELECT name FROM clients WHERE client_id = ?').get(parsed.req.client_id) as
      | { name: string }
      | undefined;

    renderConsent(res, {
      client_name: client?.name ?? 'An application',
      client_id: parsed.req.client_id,
      redirect_uri: parsed.req.redirect_uri,
      state: parsed.req.state,
      code_challenge: parsed.req.challenge,
      resource: parsed.req.resource,
      scope: parsed.req.scope,
      error: '',
    });
  });

  app.post('/authorize', form, (req, res) => {
    const ip = req.ip ?? 'unknown';
    const blocked = attempts.blockedFor(ip);
    if (blocked > 0) {
      res.status(429).type('text').send(`Too many attempts. Try again in ${Math.ceil(blocked / 1000)}s.`);
      return;
    }

    const b = (req.body ?? {}) as any;
    const parsed = parseAuthRequest({
      client_id: b.client_id,
      redirect_uri: b.redirect_uri,
      response_type: 'code',
      code_challenge: b.code_challenge,
      code_challenge_method: 'S256',
      state: b.state,
      resource: b.resource,
      scope: b.scope,
    });
    if (!parsed.ok) {
      res.status(400).type('text').send(`Authorization request rejected: ${parsed.msg}`);
      return;
    }

    if (!safeEqual(String(b.token ?? ''), deps.token)) {
      attempts.fail(ip);
      console.error(`oauth: consent token rejected from ${ip} at ${new Date().toISOString()}`);
      emit('oauth', 'consent token rejected', { level: 'warn', detail: { ip } });
      const client = db.prepare('SELECT name FROM clients WHERE client_id = ?').get(parsed.req.client_id) as
        | { name: string }
        | undefined;
      renderConsent(
        res,
        {
          client_name: client?.name ?? 'An application',
          client_id: parsed.req.client_id,
          redirect_uri: parsed.req.redirect_uri,
          state: parsed.req.state,
          code_challenge: parsed.req.challenge,
          resource: parsed.req.resource,
          scope: parsed.req.scope,
          error: 'That token was not accepted.',
        },
        401,
      );
      return;
    }
    attempts.succeed(ip);

    const code = randomBytes(32).toString('base64url');
    db.prepare(`
      INSERT INTO codes (code_hash, client_id, redirect_uri, challenge, resource, scope, expires_at, used)
      VALUES (?,?,?,?,?,?,?,0)
    `).run(
      sha256(code), parsed.req.client_id, parsed.req.redirect_uri, parsed.req.challenge,
      parsed.req.resource || null, parsed.req.scope, Date.now() + CODE_TTL_MS,
    );

    const to = new URL(parsed.req.redirect_uri);
    to.searchParams.set('code', code);
    if (parsed.req.state) to.searchParams.set('state', parsed.req.state);
    console.error(`oauth: authorized ${parsed.req.client_id}`);
    emit('oauth', 'consent approved, authorization code issued', {
      detail: { client_id: parsed.req.client_id },
    });
    res.redirect(302, to.toString());
  });

  // --- token -----------------------------------------------------------------

  function issue(clientId: string, scope: string, resource: string | null) {
    const access = randomBytes(32).toString('base64url');
    const refresh = randomBytes(32).toString('base64url');
    const now = Date.now();
    db.prepare('DELETE FROM tokens WHERE revoked = 1 OR expires_at < ?').run(now);
    // A buggy or hostile client may refresh in a tight loop. Keep the database
    // and the number of simultaneously valid access tokens bounded per client.
    db.prepare(`
      DELETE FROM tokens WHERE token_hash IN (
        SELECT token_hash FROM tokens
        WHERE client_id = ? AND kind = 'access'
        ORDER BY created_at DESC
        LIMIT -1 OFFSET ?
      )
    `).run(clientId, MAX_ACCESS_TOKENS_PER_CLIENT - 1);
    const ins = db.prepare(`
      INSERT INTO tokens (token_hash, client_id, kind, scope, resource, expires_at, revoked, created_at)
      VALUES (?,?,?,?,?,?,0,?)
    `);
    ins.run(sha256(access), clientId, 'access', scope, resource, now + ACCESS_TTL_MS, now);
    ins.run(sha256(refresh), clientId, 'refresh', scope, resource, now + REFRESH_TTL_MS, now);
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refresh,
      scope,
    };
  }

  app.post('/token', form, (req, res) => {
    const b = (req.body ?? {}) as any;
    const grant = String(b.grant_type ?? '');

    if (grant === 'authorization_code') {
      const code = String(b.code ?? '');
      const row = db.prepare('SELECT * FROM codes WHERE code_hash = ?').get(sha256(code)) as any;
      if (!row) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'unknown code' });
        return;
      }
      /*
       * Single use, enforced by marking before any other check can fail. A code
       * presented twice is either a bug or an attacker replaying an intercepted
       * one; both mean this code must never work again.
       */
      db.prepare('UPDATE codes SET used = 1 WHERE code_hash = ?').run(sha256(code));
      if (row.used) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'code already used' });
        return;
      }
      if (row.expires_at < Date.now()) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'code expired' });
        return;
      }
      if (String(b.client_id ?? '') !== row.client_id) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'client mismatch' });
        return;
      }
      if (String(b.redirect_uri ?? '') !== row.redirect_uri) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        return;
      }
      // PKCE: S256(verifier) must equal the challenge captured at /authorize.
      const verifier = String(b.code_verifier ?? '');
      const computed = createHash('sha256').update(verifier).digest('base64url');
      if (!verifier || !safeEqual(computed, row.challenge)) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }

      emit('oauth', 'access token issued (authorization_code)', {
        detail: { client_id: row.client_id },
      });
      res.json(issue(row.client_id, row.scope, row.resource));
      return;
    }

    if (grant === 'refresh_token') {
      const rt = String(b.refresh_token ?? '');
      const row = db.prepare(
        "SELECT * FROM tokens WHERE token_hash = ? AND kind = 'refresh'",
      ).get(sha256(rt)) as any;
      if (!row || row.revoked || row.expires_at < Date.now()) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'invalid refresh token' });
        return;
      }
      // Rotate: the presented refresh token is burned as it is exchanged, so a
      // stolen copy is usable at most once and its use invalidates the real one.
      db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(sha256(rt));
      emit('oauth', 'access token refreshed (old one rotated out)', {
        detail: { client_id: row.client_id },
      });
      res.json(issue(row.client_id, row.scope, row.resource));
      return;
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  });

  app.post('/revoke', form, (req, res) => {
    const t = String((req.body as any)?.token ?? '');
    if (t) db.prepare('UPDATE tokens SET revoked = 1 WHERE token_hash = ?').run(sha256(t));
    // RFC 7009: always 200, so an attacker learns nothing about token validity.
    res.status(200).json({});
  });

  // Housekeeping on boot; these tables are tiny and this keeps them that way.
  db.prepare('DELETE FROM codes WHERE expires_at < ?').run(Date.now() - 3600_000);
  db.prepare('DELETE FROM tokens WHERE expires_at < ? OR revoked = 1').run(Date.now());
  pruneClients(db);
  db.prepare('DELETE FROM tokens WHERE client_id NOT IN (SELECT client_id FROM clients)').run();
}

/**
 * The handle mountOAuth opened, reused for validation.
 *
 * One connection rather than a second read-only one: tokens are written and read
 * in the same process microseconds apart, and two handles over a WAL database is
 * exactly the setup where a freshly issued token intermittently reads as invalid.
 */
let shared: DatabaseSync | null = null;

/** Validate an OAuth access token. Returns null when it is not valid. */
export function validateAccessToken(token: string): { client_id: string; scope: string } | null {
  if (!token || !shared) return null;

  const row = shared.prepare(
    "SELECT client_id, scope, expires_at, revoked FROM tokens WHERE token_hash = ? AND kind = 'access'",
  ).get(sha256(token)) as any;

  if (!row || row.revoked || row.expires_at < Date.now() || row.scope !== SCOPE) return null;
  return { client_id: row.client_id, scope: row.scope };
}

/** Registered clients and live token counts, for `wa oauth`. */
export function listClients(): { client_id: string; name: string; created_at: number; active: number }[] {
  const db = openOAuthDb();
  try {
    return db.prepare(`
      SELECT c.client_id, c.name, c.created_at,
             (SELECT COUNT(*) FROM tokens t
               WHERE t.client_id = c.client_id AND t.revoked = 0 AND t.expires_at > ?) AS active
      FROM clients c ORDER BY c.created_at DESC
    `).all(Date.now()) as any[];
  } finally {
    db.close();
  }
}

/** Revoke every token for a client, or for all clients when id is omitted. */
export function revokeClient(clientId?: string): number {
  const db = openOAuthDb();
  try {
    const r = clientId
      ? db.prepare('UPDATE tokens SET revoked = 1 WHERE client_id = ? AND revoked = 0').run(clientId)
      : db.prepare('UPDATE tokens SET revoked = 1 WHERE revoked = 0').run();
    return Number(r.changes);
  } finally {
    db.close();
  }
}
