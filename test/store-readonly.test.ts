import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, openStoreRO } from '../src/db/index.ts';

test('read-only archive access works when file permission changes are denied', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'whatmcp-readonly-test-'));
  const path = join(dir, 'archive.db');
  const writer = openStore(path);
  writer.close();

  const chmod = mock.method(fs, 'chmodSync', () => {
    throw Object.assign(new Error('permission changes denied'), { code: 'EPERM' });
  });
  syncBuiltinESMExports();
  try {
    const reader = openStoreRO(path);
    try {
      assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n, 0);
      assert.throws(() => reader.exec('CREATE TABLE forbidden (id INTEGER)'), /readonly/i);
      assert.equal(chmod.mock.callCount(), 0);
    } finally {
      reader.close();
    }
  } finally {
    chmod.mock.restore();
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
