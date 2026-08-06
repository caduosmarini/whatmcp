import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate, currentVersion, targetVersion } from './migrate.ts';

export type DB = DatabaseSync;

/** Open the archive for writing, creating and migrating it if needed. */
export function openStore(path: string): DB {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const db = new DatabaseSync(path);
  // Before migrate(): journal_mode is database-level and SQLite refuses to change
  // it from inside a transaction, which is where migrations run.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate(db);
  return db;
}

/**
 * Open the archive read-only, running no DDL.
 *
 * Fails loudly when the file is missing, and that matters more than it looks:
 * `new DatabaseSync(path)` *creates* an absent database, so a typo'd path or a
 * not-yet-built archive would otherwise leave the MCP server cheerfully answering
 * "no matches" for every query — indistinguishable, to a model or a person, from a
 * genuinely empty history. Silent wrong answers are the worst failure this tool
 * can have, so this path refuses to guess.
 */
export function openStoreRO(path: string): DB {
  if (!existsSync(path)) {
    throw new Error(
      `WhatMCP archive not found: ${path}\n` +
        `Refusing to open an empty database rather than report "no results" for everything.\n` +
        `Build it first:  npm run sync`,
    );
  }

  const db = new DatabaseSync(path, { readOnly: true });
  const have = currentVersion(db);
  const want = targetVersion();
  if (have !== want) {
    db.close();
    throw new Error(
      `archive schema is v${have}, this build expects v${want}: ${path}\n` +
        (have < want
          ? `Run 'npm run sync' to migrate it.`
          : `The archive is newer than this code; update the checkout.`),
    );
  }
  return db;
}

/**
 * Open a WhatsApp store read-only.
 *
 * Callers must pass a snapshot, never the live path: ChatStorage.sqlite is
 * WAL-mode and written continuously by the running app.
 */
export function openSourceRO(path: string): DB {
  return new DatabaseSync(path, { readOnly: true });
}
