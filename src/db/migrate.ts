/**
 * Migrations, tracked by SQLite's own `user_version`.
 *
 * No migrations table: user_version is a 4-byte integer in the database header,
 * so it can be read from a read-only connection without any risk of the schema
 * check itself needing the schema to exist.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

interface Migration {
  version: number;
  name: string;
  sql: string;
}

function load(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => {
      const version = Number(f.slice(0, 3));
      if (!Number.isInteger(version) || version <= 0) {
        throw new Error(`migration "${f}" must start with a 3-digit version`);
      }
      return { version, name: f, sql: readFileSync(join(MIGRATIONS_DIR, f), 'utf8') };
    });
}

export function targetVersion(): number {
  const all = load();
  return all.length === 0 ? 0 : all[all.length - 1].version;
}

export function currentVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return Number(row.user_version);
}

export function migrate(db: DatabaseSync): number {
  const have = currentVersion(db);
  const pending = load().filter((m) => m.version > have);
  if (pending.length === 0) return have;

  for (const m of pending) {
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      // PRAGMA takes no bindings; the value is a validated integer from the
      // filename, never user input.
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.name} failed: ${(e as Error).message}`);
    }
  }
  return pending[pending.length - 1].version;
}
