import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryAcquireSyncLock } from '../src/sync-lock.ts';

test('sync lock rejects a competing process immediately and recovers on release', t => {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-sync-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = join(dir, 'sync-lock.db');
  const release = tryAcquireSyncLock(lockPath);
  assert.ok(release);

  const probe = () => spawnSync(process.execPath, [
    '--experimental-sqlite', '--experimental-strip-types', '--no-warnings',
    '--input-type=module', '-e',
    `import { tryAcquireSyncLock } from ${JSON.stringify(new URL('../src/sync-lock.ts', import.meta.url).href)};
     const release = tryAcquireSyncLock(process.argv[1]);
     if (!release) process.exit(75);
     release();`,
    lockPath,
  ], { encoding: 'utf8', timeout: 3000 });

  const busy = probe();
  assert.equal(busy.status, 75, busy.stderr);
  release();
  const free = probe();
  assert.equal(free.status, 0, free.stderr);
});

test('killing a blocked worker releases its sync lock', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-killed-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = join(dir, 'sync-lock.db');
  const child = spawn(process.execPath, [
    '--experimental-sqlite', '--experimental-strip-types', '--no-warnings',
    '--input-type=module', '-e',
    `import { tryAcquireSyncLock } from ${JSON.stringify(new URL('../src/sync-lock.ts', import.meta.url).href)};
     const release = tryAcquireSyncLock(process.argv[1]);
     if (!release) process.exit(75);
     process.stdout.write('locked\\n');
     setInterval(() => {}, 1000);`,
    lockPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout!, 'data');
  assert.equal(tryAcquireSyncLock(lockPath), null);
  const closed = once(child, 'close');
  child.kill('SIGKILL');
  await closed;
  const release = tryAcquireSyncLock(lockPath);
  assert.ok(release);
  release();
});
