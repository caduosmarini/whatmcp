/** WAren6 is an external GPL-3.0 dependency, invoked as a separate process. */
import { execFileSync, spawn } from 'node:child_process';
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
export async function withWindowsSyncLock<T>(lock: string, action: () => T | Promise<T>): Promise<T> {
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
    return await action();
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
    "$answer = [System.Windows.Forms.MessageBox]::Show('O WhatMCP precisa fechar o WhatsApp para copiar os dados. Ele tentará reabrir a janela assim que a cópia terminar. Deseja continuar?', 'WhatMCP - sincronização', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)",
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
  // A background process alone does not mean the user can see the app.
  for (let attempt = 0; attempt < 10; attempt++) {
    const handle = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '@(Get-Process -Name WhatsApp.Root -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0).Count',
    ], { encoding: 'utf8' }).trim();
    if (Number(handle) > 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
  }
  throw new Error('WhatsApp process restarted, but no visible window appeared');
}

/** WAren6 prints this after all app files have been copied and ODUID captured. */
export function acquisitionComplete(output: string): boolean {
  return output.includes('[2/4] Decryption Engine');
}

export function acquireWithWaren6(
  script: string, cfg: Config, onCopied: () => void, progress?: (s: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-f', '-n', '-NoArchive', '-KeepCaseDirectoryAfterArchive', '-d', cfg.windowsOutputDir, '-s',
    ], { cwd: cfg.windowsWaren6Path!, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30 * 60_000 });
    let recent = '';
    let copied = false;
    const announced = new Set<string>();
    const output = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const combined = recent + text;
      for (const [marker, message] of [
        ['[3/4] Unified Database Extractor', 'WAren6 is building the unified database from the copy'],
        ['[4/4] Archiving & Cleanup', 'WAren6 is validating and finishing the case'],
      ]) {
        if (!announced.has(marker) && combined.includes(marker)) {
          announced.add(marker);
          progress?.(message);
        }
      }
      if (!copied && acquisitionComplete(combined)) {
        copied = true;
        progress?.('WAren6 acquisition complete; reopening WhatsApp while extraction continues');
        try { onCopied(); } catch (e) { progress?.(`WhatsApp reopen failed: ${(e as Error).message}`); }
      }
      recent = combined.slice(-8_000);
    };
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`WAren6 exited with ${signal ?? code}; recent output: ${recent.slice(-1_000)}`));
    });
  });
}

/** Acquire offline, without network or media, then import only a validated case. */
export async function runWindowsIndex(
  cfg: Config, opts: { full?: boolean; progress?: (s: string) => void } = {},
): Promise<WindowsImportResult> {
  if (process.platform !== 'win32') throw new Error('WAren6 source requires Windows');
  if (!cfg.windowsWaren6Path) {
    throw new Error('Set windows_waren6_path in config.json before syncing from Windows');
  }
  const script = join(cfg.windowsWaren6Path, 'waren6.ps1');
  if (!existsSync(script)) throw new Error(`WAren6 script not found: ${script}`);
  return withWindowsSyncLock(join(DATA_DIR, 'windows-sync.lock'), async () => {
  const running = whatsappRunning();
  if (running) confirmCloseWhatsApp();
  let reopened = false;
  const reopen = () => {
    if (!running || reopened) return;
    reopenWhatsApp();
    reopened = true;
  };
  try {
  mkdirSync(cfg.windowsOutputDir, { recursive: true, mode: 0o700 });
  const before = new Set(readdirSync(cfg.windowsOutputDir));
  opts.progress?.('WAren6 offline acquisition (no network, no media); this may take several minutes');
  await acquireWithWaren6(script, cfg, reopen, opts.progress);
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
    if (running && !reopened) {
      opts.progress?.('Reopening WhatsApp');
      reopen();
    }
  }
  });
}
