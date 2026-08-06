import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, windowHash, DEFAULTS } from '../src/index/chunker.ts';

const msg = (id: string, ts: number, text: string, sender = 'A', thread = 't1') => ({
  message_id: id, thread_id: thread, sender_name: sender, ts, text,
});

test('splits on silence longer than the gap', () => {
  // The gap is measured against the PREVIOUS message, not the window start —
  // otherwise a long conversation would be chopped up on a fixed clock.
  const w = chunk([
    msg('1', 1000, 'hey'),
    msg('2', 1060, 'you around'),
    msg('3', 1060 + DEFAULTS.gapSeconds + 1, 'different topic'),
  ]);
  assert.equal(w.length, 2);
  assert.equal(w[0].msg_count, 2);
  assert.equal(w[1].msg_count, 1);
});

test('never merges across threads even at identical timestamps', () => {
  const w = chunk([
    msg('1', 1000, 'a', 'A', 'threadA'),
    msg('2', 1000, 'b', 'B', 'threadB'),
  ]);
  assert.equal(w.length, 2);
  assert.notEqual(w[0].thread_id, w[1].thread_id);
});

test('collapses consecutive turns from the same speaker', () => {
  const w = chunk([
    msg('1', 1000, 'one'),
    msg('2', 1001, 'two'),
    msg('3', 1002, 'three', 'B'),
  ]);
  assert.equal(w.length, 1);
  assert.equal(w[0].text, 'A: one two\nB: three');
});

test('caps a window by message count', () => {
  const many = Array.from({ length: DEFAULTS.maxMessages + 5 }, (_, i) =>
    msg(String(i), 1000 + i, 'x'),
  );
  const w = chunk(many);
  assert.equal(w.length, 2);
  assert.equal(w[0].msg_count, DEFAULTS.maxMessages);
});

test('caps a window by rendered length', () => {
  const long = 'y'.repeat(DEFAULTS.maxChars);
  const w = chunk([msg('1', 1000, long), msg('2', 1001, 'tail')]);
  assert.equal(w.length, 2, 'the second message must start a new window');
});

test('input need not be sorted', () => {
  const unsorted = chunk([msg('3', 1002, 'c'), msg('1', 1000, 'a'), msg('2', 1001, 'b')]);
  assert.equal(unsorted.length, 1);
  assert.equal(unsorted[0].text, 'A: a b c');
  assert.equal(unsorted[0].start_ts, 1000);
  assert.equal(unsorted[0].end_ts, 1002);
});

/*
 * The delimiter matters. Fields are joined before hashing, so with a printable
 * separator two genuinely different windows could produce identical input to the
 * hash — and would then share one embedding, silently returning the wrong chat.
 */
test('hash cannot be forged across field boundaries', () => {
  const a = windowHash({ thread_id: 'x@g.us', speakers: 'A,B', text: 'hello' });
  const b = windowHash({ thread_id: 'x@g.us,A', speakers: 'B', text: 'hello' });
  assert.notEqual(a, b);

  const c = windowHash({ thread_id: 'x', speakers: '', text: 'y:z' });
  const d = windowHash({ thread_id: 'x', speakers: 'y', text: 'z' });
  assert.notEqual(c, d);
});

test('hash ignores timestamps but tracks content', () => {
  const base = { thread_id: 't', speakers: 'A', text: 'same' };
  assert.equal(windowHash(base), windowHash({ ...base }));
  assert.notEqual(windowHash(base), windowHash({ ...base, text: 'other' }));
  assert.notEqual(windowHash(base), windowHash({ ...base, speakers: 'B' }));
});

test('identical bursts in one thread hash identically, enabling vector reuse', () => {
  const w = chunk([
    msg('1', 1000, 'on my way'),
    msg('2', 1000 + DEFAULTS.gapSeconds + 1, 'on my way'),
  ]);
  assert.equal(w.length, 2);
  assert.equal(windowHash(w[0]), windowHash(w[1]));
});
