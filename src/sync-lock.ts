import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.ts';

export const SYNC_LOCK_PATH = join(DATA_DIR, 'sync-lock.db');

/**
 * The worker owns this OS-backed lock for its entire lifetime. SQLite releases it
 * even if the worker is killed, so a stale PID file can never block future syncs.
 * A second worker fails immediately rather than waiting in a queue.
 */
export function tryAcquireSyncLock(path = SYNC_LOCK_PATH): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec('PRAGMA busy_timeout = 0');
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    db.close();
    if (/database is locked|SQLITE_BUSY/i.test(String(error))) return null;
    throw error;
  }
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    try { db.exec('ROLLBACK'); }
    finally { db.close(); }
  };
}
