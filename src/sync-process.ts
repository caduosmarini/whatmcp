import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { join } from 'node:path';

export const SYNC_TIMEOUT_MS = 5 * 60 * 1000;
const STOP_GRACE_MS = 5 * 1000;

export function syncWorkerCommand(full = false): [string, string[]] {
  return [process.execPath, [
    '--experimental-sqlite', '--experimental-strip-types', '--no-warnings',
    join(import.meta.dirname, 'cli.ts'), 'sync-worker',
    ...(full ? ['--full'] : []),
  ]];
}

/** Run sync in a child so a blocked synchronous SQLite copy cannot block its watchdog. */
export function runSyncProcess(
  command: string,
  args: string[],
  timeoutMs = SYNC_TIMEOUT_MS,
  graceMs = STOP_GRACE_MS,
  onOutput?: (chunk: string) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: onOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    if (onOutput) {
      child.stdout?.on('data', (data: Buffer) => onOutput(data.toString('utf8')));
      child.stderr?.on('data', (data: Buffer) => onOutput(data.toString('utf8')));
    }
    let timedOut = false;
    let forwardedSignal: 'SIGINT' | 'SIGTERM' | undefined;
    let stopTimer: NodeJS.Timeout | undefined;

    const stop = (signal: 'SIGINT' | 'SIGTERM') => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill(signal);
      stopTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, graceMs);
    };
    const onInterrupt = () => { forwardedSignal = 'SIGINT'; stop('SIGINT'); };
    const onTerminate = () => { forwardedSignal = 'SIGTERM'; stop('SIGTERM'); };
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);

    const timeout = setTimeout(() => {
      timedOut = true;
      console.error(`sync exceeded ${timeoutMs / 1000} seconds; stopping it`);
      stop('SIGTERM');
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      if (stopTimer) clearTimeout(stopTimer);
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (code, signal) => {
      cleanup();
      resolve(timedOut ? 124 : forwardedSignal
        ? 128 + constants.signals[forwardedSignal]
        : code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1));
    });
  });
}
