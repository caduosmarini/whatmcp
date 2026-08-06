/**
 * In-process activity log, for the dashboard's live view.
 *
 * A ring buffer plus a subscriber set — no file, no rotation, no dependency. The
 * point is to answer "what is the server doing right now", which is a question
 * about the last few minutes, not about history. `~/.whatmcp/logs/server.log`
 * already keeps the durable record.
 *
 * WHAT MUST NOT GO IN HERE: message content. The dashboard renders these lines,
 * and search results are the one thing this project treats as untrusted
 * third-party data everywhere else. Events carry queries, counts, timings and
 * tool names — never the text that came back. That keeps the activity log safe to
 * render as plain text and keeps a stray `<script>` in someone's WhatsApp message
 * from reaching a second surface.
 */

const RING = 400;

export type Level = 'info' | 'warn' | 'error';

export interface LogEvent {
  seq: number;
  t: number;
  level: Level;
  /** Coarse category: 'tool' | 'auth' | 'oauth' | 'sync' | 'server'. */
  kind: string;
  msg: string;
  /** Optional structured extras. Must not contain message content. */
  detail?: Record<string, unknown>;
}

const buf: LogEvent[] = [];
const subs = new Set<(e: LogEvent) => void>();
let seq = 0;

export function emit(
  kind: string,
  msg: string,
  opts: { level?: Level; detail?: Record<string, unknown> } = {},
): void {
  const e: LogEvent = {
    seq: ++seq,
    t: Date.now(),
    level: opts.level ?? 'info',
    kind,
    msg,
    detail: opts.detail,
  };
  buf.push(e);
  if (buf.length > RING) buf.shift();
  // A slow or broken subscriber must never break the thing it is observing.
  for (const fn of subs) {
    try { fn(e); } catch { /* ignore */ }
  }
}

export function recent(n = 100): LogEvent[] {
  return buf.slice(-n);
}

export function subscribe(fn: (e: LogEvent) => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

/**
 * Compact a tool's arguments for display.
 *
 * Deliberately lossy: long strings are truncated and only known-safe keys are
 * shown. Arguments are model-supplied, so this is also the boundary that keeps a
 * hostile 10 KB "query" from being echoed into the dashboard verbatim.
 */
export function summarizeArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') out[k] = v.length > 80 ? v.slice(0, 80) + '…' : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/**
 * A one-line gist of a tool result.
 *
 * Takes only the FIRST line, which by construction is the tool's own summary
 * ("12 result(s) for X (7 strong)") and never fenced message content — that
 * always begins on a later line. Capped regardless, so a change in tool output
 * cannot start leaking transcript text into this log by accident.
 */
export function summarizeResult(res: unknown): string {
  const content = (res as { content?: { type: string; text?: string }[] })?.content;
  const first = content?.[0]?.text ?? '';
  const line = first.split('\n', 1)[0] ?? '';
  return line.length > 120 ? line.slice(0, 120) + '…' : line;
}
