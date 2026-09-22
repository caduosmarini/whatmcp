/** WAren6 is an external GPL-3.0 dependency, invoked as a separate process. */
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR, type Config } from '../config.ts';
import { importWindowsUnified, type WindowsImportResult } from './windows-import.ts';

function whatsappRunning(): boolean {
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '@(Get-Process -Name WhatsApp.Root -ErrorAction SilentlyContinue).Count',
  ], { encoding: 'utf8' }).trim();
  return Number(out) > 0;
}

/** Shared across CLI, MCP, and scheduled invocations, including a pending dialog. */
export function withWindowsSyncLock<T>(lock: string, action: () => T): T {
  mkdirSync(dirname(lock), { recursive: true });
  let fd: number | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fd = openSync(lock, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let pid = 0;
      try { pid = Number(readFileSync(lock, 'utf8').trim()); } catch { /* incomplete lock */ }
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          throw new Error('Windows sync is already running or awaiting approval');
        } catch (probe) {
          if (!(probe instanceof Error) || !('code' in probe) || probe.code !== 'ESRCH') throw probe;
        }
      } else {
        // A creator may still be writing the PID; never steal a fresh lock.
        if (Date.now() - statSync(lock).mtimeMs < 60_000) {
          throw new Error('Windows sync is already running or awaiting approval');
        }
      }
      unlinkSync(lock);
    }
  }
  if (fd === undefined) throw new Error('Windows sync is already running or awaiting approval');
  try {
    writeFileSync(fd, String(process.pid));
    return action();
  } finally {
    closeSync(fd);
    try {
      if (readFileSync(lock, 'utf8').trim() === String(process.pid)) unlinkSync(lock);
    } catch { /* preserve another owner's lock */ }
  }
}

function confirmCloseWhatsApp(): void {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    "$answer = [System.Windows.Forms.MessageBox]::Show('O WhatMCP precisa fechar o WhatsApp para sincronizar. Ele será reaberto ao terminar, mesmo se houver erro. Deseja continuar?', 'WhatMCP - sincronização', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)",
    'if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) { exit 0 } else { exit 2 }',
  ].join('; ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Sta', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { stdio: 'ignore' });
  } catch {
    throw new Error('Windows sync cancelled or confirmation dialog unavailable; WhatsApp was not closed');
  }
}

function reopenWhatsApp(): void {
  execFileSync('explorer.exe', ['shell:AppsFolder\\5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App'],
    { stdio: 'ignore', timeout: 15_000 });
}

/** Acquire offline, without network or media, then import only a validated case. */
export function runWindowsIndex(
  cfg: Config, opts: { full?: boolean; progress?: (s: string) => void } = {},
): WindowsImportResult {
  if (process.platform !== 'win32') throw new Error('WAren6 source requires Windows');
  if (!cfg.windowsWaren6Path) {
    throw new Error('Set windows_waren6_path in config.json before syncing from Windows');
  }
  const script = join(cfg.windowsWaren6Path, 'waren6.ps1');
  if (!existsSync(script)) throw new Error(`WAren6 script not found: ${script}`);
  return withWindowsSyncLock(join(DATA_DIR, 'windows-sync.lock'), () => {
  const running = whatsappRunning();
  if (running) confirmCloseWhatsApp();
  try {
  mkdirSync(cfg.windowsOutputDir, { recursive: true, mode: 0o700 });
  const before = new Set(readdirSync(cfg.windowsOutputDir));
  opts.progress?.('WAren6 offline acquisition (no network, no media); this may take several minutes');
  execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-f', '-n', '-NoArchive', '-KeepCaseDirectoryAfterArchive', '-d', cfg.windowsOutputDir, '-s',
  ], { cwd: cfg.windowsWaren6Path, stdio: 'inherit', timeout: 30 * 60_000 });
  const cases = readdirSync(cfg.windowsOutputDir)
    .filter(name => name.startsWith('WAren6_') && !before.has(name))
    .sort().reverse();
  for (const name of cases) {
    const dir = join(cfg.windowsOutputDir, name);
    const reportPath = join(dir, 'validation_report.json');
    const dbPath = join(dir, 'unified_whatsapp.db');
    if (!existsSync(reportPath) || !existsSync(dbPath)) continue;
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { status?: string; errors?: unknown[] };
    if (report.status !== 'ok' || report.errors?.length) {
      throw new Error(`WAren6 validation failed for ${dir}; archive was not changed`);
    }
    return importWindowsUnified(cfg.store, dbPath, opts);
  }
  throw new Error('WAren6 did not produce a validated unified_whatsapp.db; archive was not changed');
  } finally {
    if (running && !whatsappRunning()) {
      opts.progress?.('Reopening WhatsApp');
      reopenWhatsApp();
    }
  }
  });
}
