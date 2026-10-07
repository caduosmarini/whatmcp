/** Local cl100k_base tokenizer used by text-embedding-3-* (no network calls). */
import { Tiktoken } from 'js-tiktoken/lite';
import cl100k from 'js-tiktoken/ranks/cl100k_base';
let encoder: Tiktoken | undefined;
const counts = new Map<string, number>();
export const MAX_INPUT_TOKENS = 8_000; // margin below 8192
export function tokenCount(text: string): number {
  const cached = counts.get(text);
  if (cached !== undefined) return cached;
  encoder ??= new Tiktoken(cl100k);
  // WhatsApp text may literally contain special-token markers; encode as text.
  const count = encoder.encode(text, [], []).length;
  if (text.length <= 16000) {
    if (counts.size >= 256) counts.delete(counts.keys().next().value!);
    counts.set(text, count);
  }
  return count;
}
export function exceedsTokens(text: string, maximum = MAX_INPUT_TOKENS): boolean {
  // UTF-8 bytes are a safe upper bound; avoid tokenization for ordinary windows.
  return Buffer.byteLength(text, 'utf8') > maximum && tokenCount(text) > maximum;
}

/** Split by Unicode code points without discarding the tail of a transcript. */
export function splitTokenText(text: string, maximum: number): string[] {
  if (!exceedsTokens(text, maximum)) return [text];
  const points = Array.from(text), parts: string[] = [];
  let start = 0;
  while (start < points.length) {
    let low = 1, high = points.length - start, best = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (!exceedsTokens(points.slice(start, start + mid).join(''), maximum)) {
        best = mid; low = mid + 1;
      } else high = mid - 1;
    }
    if (!best) throw new Error('Token allowance cannot fit one Unicode code point');
    parts.push(points.slice(start, start + best).join(''));
    start += best;
  }
  return parts;
}
