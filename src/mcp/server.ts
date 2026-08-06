#!/usr/bin/env node
/**
 * WhatMCP over stdio — the default, and the most secure transport available.
 *
 * The client spawns this process on the same machine and speaks to nobody else:
 * no port to bind, no token to leak, no network surface to authenticate. Tools
 * live in ./tools.ts, shared with the HTTP transport so the two can never drift.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, embedConfig } from '../config.ts';
import { buildServer } from './tools.ts';
import { existsSync } from 'node:fs';

const cfg = loadConfig();

/*
 * Resolve the embed config at boot, but do not die without a key.
 *
 * A missing key must not stop the server starting: the client (Claude Desktop,
 * Claude Code) reports a failed MCP server as an opaque connection error, which is
 * a terrible way to learn that a config file needs one line. So it starts, and
 * every tool explains the problem in words the model will relay.
 */
let embedCfg: { model: string; dimensions: number; apiKey: string } | null = null;
let keyError: string | null = null;
try {
  embedCfg = embedConfig(cfg);
} catch (e) {
  keyError = (e as Error).message;
}

/*
 * stdout is the MCP transport. Anything written to it that is not a JSON-RPC frame
 * corrupts the stream and the client drops the connection with an opaque parse
 * error, so every diagnostic in this process must go to stderr. This is the single
 * easiest way to break a stdio MCP server, and it is worth stating loudly rather
 * than relying on nobody ever adding a console.log.
 */
console.error(
  `whatmcp: archive ${cfg.store}${existsSync(cfg.store) ? '' : ' (not built yet)'}, ` +
    `model ${cfg.openaiModel}@${cfg.openaiDims}` +
    (keyError ? ' — NO API KEY, semantic search disabled' : ''),
);

await buildServer({ cfg, embedCfg, keyError }).connect(new StdioServerTransport());
