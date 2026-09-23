import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireWithWaren6, acquisitionComplete, withWindowsSyncLock } from '../src/index/windows-source.ts';
import type { Config } from '../src/config.ts';

test('a pending sync prevents a second dialog/acquisition and releases its lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-lock-'));
  const lock = join(dir, 'windows-sync.lock');
  try {
    assert.equal(await withWindowsSyncLock(lock, async () => {
      assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
      await assert.rejects(withWindowsSyncLock(lock, () => 'second'),
        /already running or awaiting approval/);
      return 'first';
    }), 'first');
    assert.equal(await withWindowsSyncLock(lock, () => 'later'), 'later');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dead process lock is recovered without suppressing the next sync', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-lock-'));
  const lock = join(dir, 'windows-sync.lock');
  try {
    writeFileSync(lock, '99999999');
    assert.equal(await withWindowsSyncLock(lock, () => 'recovered'), 'recovered');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WhatsApp is reopened only after WAren6 reports acquisition complete', () => {
  assert.equal(acquisitionComplete('[1/4] Acquisition & File Verification'), false);
  assert.equal(acquisitionComplete('[time] LocalState copy: 0,2s'), false);
  assert.equal(acquisitionComplete('+-- [2/4] Decryption Engine ---+'), true);
});

test('WAren6 acquisition callback fires before the long extraction finishes', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-acquire-'));
  const script = join(dir, 'waren6.ps1');
  try {
    writeFileSync(script, [
      'param([switch]$f,[switch]$n,[switch]$NoArchive,[switch]$KeepCaseDirectoryAfterArchive,[string]$d,[switch]$s)',
      "Write-Output '[1/4] Acquisition & File Verification'",
      "Write-Output '[2/4] Decryption Engine'",
      'Start-Sleep -Milliseconds 300',
      "Write-Output '[3/4] Unified Database Extractor'",
    ].join('\r\n'));
    const cfg = { windowsWaren6Path: dir, windowsOutputDir: dir } as Config;
    let wasCopied = false;
    let finished = false;
    await acquireWithWaren6(script, cfg, () => {
      assert.equal(finished, false);
      wasCopied = true;
    });
    finished = true;
    assert.equal(wasCopied, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
