import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSyncProcess } from '../src/sync-process.ts';

test('sync watchdog kills and reaps a child that ignores termination', async () => {
  const started = Date.now();
  const code = await runSyncProcess(
    process.execPath,
    ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    200,
    100,
  );
  assert.equal(code, 124);
  assert.ok(Date.now() - started < 5000);
});

test('sync watchdog preserves successful exit', async () => {
  let output = '';
  assert.equal(await runSyncProcess(process.execPath,
    ['-e', 'process.stdout.write("ready\\n")'], 1000, 100, chunk => { output += chunk; }), 0);
  assert.equal(output, 'ready\n');
});
