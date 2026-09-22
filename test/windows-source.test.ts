import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withWindowsSyncLock } from '../src/index/windows-source.ts';

test('a pending sync prevents a second dialog/acquisition and releases its lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-lock-'));
  const lock = join(dir, 'windows-sync.lock');
  try {
    assert.equal(withWindowsSyncLock(lock, () => {
      assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
      assert.throws(() => withWindowsSyncLock(lock, () => 'second'),
        /already running or awaiting approval/);
      return 'first';
    }), 'first');
    assert.equal(withWindowsSyncLock(lock, () => 'later'), 'later');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dead process lock is recovered without suppressing the next sync', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-lock-'));
  const lock = join(dir, 'windows-sync.lock');
  try {
    writeFileSync(lock, '99999999');
    assert.equal(withWindowsSyncLock(lock, () => 'recovered'), 'recovered');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
