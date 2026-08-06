import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topKCosine, fuseRRF, type VectorIndex } from '../src/search/vectors.ts';

/** Build a tiny index of unit vectors in a 4-dim space. */
function makeIndex(rows: { id: number; vec: number[] }[]): VectorIndex {
  const dim = rows[0].vec.length;
  const mat = new Float32Array(rows.length * dim);
  const ids = new Int32Array(rows.length);
  rows.forEach((r, i) => {
    const norm = Math.hypot(...r.vec) || 1;
    r.vec.forEach((v, j) => { mat[i * dim + j] = v / norm; });
    ids[i] = r.id;
  });
  return {
    dim, model: 'test', n: rows.length, ids, mat,
    maxWindowId: Math.max(...rows.map((r) => r.id)),
  };
}

const unit = (v: number[]) => {
  const n = Math.hypot(...v) || 1;
  return new Float32Array(v.map((x) => x / n));
};

test('ranks by cosine, best first', () => {
  const ix = makeIndex([
    { id: 1, vec: [1, 0, 0, 0] },
    { id: 2, vec: [0.9, 0.1, 0, 0] },
    { id: 3, vec: [0, 1, 0, 0] },
  ]);
  const hits = topKCosine(ix, unit([1, 0, 0, 0]), 3);
  assert.deepEqual(hits.map((h) => h.window_id), [1, 2, 3]);
  assert.ok(hits[0].sim > hits[1].sim && hits[1].sim > hits[2].sim);
});

/*
 * The reason the filter is applied inside the scan loop rather than to the
 * results: a query scoped to one chat, where that chat's windows are not in the
 * global top-k, must still return that chat's best windows — not nothing.
 */
test('metadata filter is applied before top-k, not after', () => {
  const ix = makeIndex([
    { id: 1, vec: [1, 0, 0, 0] },
    { id: 2, vec: [0.99, 0.01, 0, 0] },
    { id: 3, vec: [0.2, 0.98, 0, 0] },
  ]);
  const allowed = new Uint8Array(ix.maxWindowId + 1);
  allowed[3] = 1; // only the worst-matching window is permitted

  const hits = topKCosine(ix, unit([1, 0, 0, 0]), 2, allowed);
  assert.equal(hits.length, 1, 'must return the filtered set, not an empty top-k');
  assert.equal(hits[0].window_id, 3);
});

test('respects the similarity floor', () => {
  const ix = makeIndex([
    { id: 1, vec: [1, 0, 0, 0] },
    { id: 2, vec: [0, 1, 0, 0] },
  ]);
  const hits = topKCosine(ix, unit([1, 0, 0, 0]), 5, null, 0.5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].window_id, 1);
});

test('k larger than the corpus returns everything, still sorted', () => {
  const ix = makeIndex([
    { id: 7, vec: [0, 1, 0, 0] },
    { id: 8, vec: [1, 0, 0, 0] },
  ]);
  const hits = topKCosine(ix, unit([1, 0, 0, 0]), 50);
  assert.deepEqual(hits.map((h) => h.window_id), [8, 7]);
});

test('the replace-worst path keeps the ranking correct', () => {
  // More candidates than k, with the best ones arriving last — this exercises the
  // insertion path rather than the initial fill.
  const ix = makeIndex([
    { id: 1, vec: [0, 0, 1, 0] },
    { id: 2, vec: [0, 0, 0, 1] },
    { id: 3, vec: [0.5, 0.5, 0, 0] },
    { id: 4, vec: [0.9, 0.1, 0, 0] },
    { id: 5, vec: [1, 0, 0, 0] },
  ]);
  const hits = topKCosine(ix, unit([1, 0, 0, 0]), 2);
  assert.deepEqual(hits.map((h) => h.window_id), [5, 4]);
});

/*
 * The property that earns RRF its place: a result both arms agree is decent beats
 * one arm's confident winner that the other arm never saw at all. That is what
 * stops a BM25 accident on a single stray token from heading the results on a
 * query BM25 cannot actually serve.
 */
test('agreement across arms beats a single arm winner', () => {
  const fused = fuseRRF([
    { ids: [99, 20], weight: 1 },  // 99 leads here...
    { ids: [77, 20], weight: 1 },  // ...but is absent here; 20 is 2nd in both
  ], 20);
  const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]);
  assert.equal(ranked[0][0], 20);
});

/*
 * Not a bug, and documented so nobody "fixes" it: 1/(k+r) is convex, so an item
 * ranked 1st and 3rd scores marginally above one ranked 2nd twice (0.09110 vs
 * 0.09091 at k=20). RRF rewards presence in both lists, not centrality within
 * them — the ordering above is what matters, and this margin is noise.
 */
test('the reciprocal curve is convex, so extremes edge out middles', () => {
  const fused = fuseRRF([
    { ids: [10, 20, 30], weight: 1 },
    { ids: [30, 20, 10], weight: 1 },
  ], 20);
  assert.ok(fused.get(10)! > fused.get(20)!);
  assert.ok(Math.abs(fused.get(10)! - fused.get(20)!) < 0.001, 'the margin is negligible');
  assert.equal(fused.get(10), fused.get(30));
});

test('RRF weights shift the balance between arms', () => {
  const bm25Only = fuseRRF([{ ids: [1], weight: 1 }, { ids: [2], weight: 0 }]);
  assert.ok(bm25Only.get(1)! > bm25Only.get(2)!);

  const vecHeavy = fuseRRF([{ ids: [1], weight: 0.1 }, { ids: [2], weight: 1 }]);
  assert.ok(vecHeavy.get(2)! > vecHeavy.get(1)!);
});
