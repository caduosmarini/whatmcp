/**
 * Brute-force vector search.
 *
 * No ANN index, no vector database, on purpose. ~5,000 windows × 1,536 dims × 4
 * bytes is ~30 MB held once per process, and a full scan is ~7.7M multiply-adds —
 * single-digit milliseconds, well inside any MCP latency budget. Approximate
 * search would trade exactness for nothing at this size, and an ANN structure
 * would make the metadata pre-filtering below awkward: here membership is tested
 * *inside* the scan loop, which is what makes chat-scoped and date-scoped queries
 * correct rather than "top-k globally, then filtered down to nothing".
 *
 * The scale where a real vector database starts earning its keep is ~1e6 vectors.
 * This is two to three orders of magnitude short of that.
 */

import type { DB } from '../db/index.ts';

export interface VectorIndex {
  dim: number;
  model: string;
  n: number;
  ids: Int32Array;   // window_id for row i
  mat: Float32Array; // n * dim, rows L2-normalized
  maxWindowId: number;
}

/**
 * Load every window's vector into one contiguous matrix.
 *
 * One allocation rather than n small Float32Arrays: the hot loop wants sequential
 * memory, and thousands of separate objects would be both slower and much heavier
 * on GC.
 *
 * The join emits one row per *window*, so windows sharing a content_hash each get
 * their own copy. That redundancy is deliberate — it keeps ids[i] a plain 1:1
 * mapping and spares the inner loop any hash fan-out.
 */
export function loadVectorIndex(db: DB, modelTag: string): VectorIndex | null {
  const rows = db
    .prepare(`
      SELECT w.id AS window_id, v.vec AS vec, v.dim AS dim
      FROM windows w
      JOIN window_vectors v
        ON v.content_hash = w.content_hash AND v.model = ?
      ORDER BY w.id
    `)
    .all(modelTag) as { window_id: number; vec: Uint8Array; dim: number }[];

  if (rows.length === 0) return null;

  const dim = Number(rows[0].dim);
  // The unrolled inner loop steps by 4 and relies on this dividing evenly.
  if (dim % 4 !== 0) throw new Error(`vector dim ${dim} must be a multiple of 4`);

  const n = rows.length;
  const mat = new Float32Array(n * dim);
  const ids = new Int32Array(n);
  let maxWindowId = 0;

  for (let i = 0; i < n; i++) {
    const r = rows[i];
    if (r.vec.byteLength !== dim * 4) {
      throw new Error(
        `window ${r.window_id}: vector is ${r.vec.byteLength} bytes, expected ${dim * 4}`,
      );
    }
    // memcpy through a Uint8Array view rather than constructing a Float32Array
    // over r.vec.buffer: alignment-safe regardless of how node:sqlite allocated
    // the BLOB.
    new Uint8Array(mat.buffer, i * dim * 4, dim * 4).set(r.vec);
    ids[i] = Number(r.window_id);
    if (ids[i] > maxWindowId) maxWindowId = ids[i];
  }

  return { dim, model: modelTag, n, ids, mat, maxWindowId };
}

export interface VecHit {
  window_id: number;
  sim: number;
}

/**
 * Top-k by cosine similarity.
 *
 * Cosine is a plain dot product here: every stored row and every query vector is
 * L2-normalized at encode time.
 *
 * `allowed`, when present, is a byte-per-window_id bitmap of the metadata-filtered
 * set. It MUST be tested inside the loop rather than applied to the results —
 * taking a global top-k and filtering afterwards returns nothing at all for a query
 * scoped to one chat, which is the common case.
 */
export function topKCosine(
  ix: VectorIndex,
  q: Float32Array,
  k: number,
  allowed: Uint8Array | null = null,
  minSim = -Infinity,
): VecHit[] {
  const { mat, ids, dim, n } = ix;
  const hits: VecHit[] = [];
  let worst = -Infinity;

  for (let i = 0; i < n; i++) {
    const wid = ids[i];
    if (allowed !== null && allowed[wid] === 0) continue;

    let s = 0;
    const base = i * dim;
    // Manual 4x unroll: measurably faster than the naive loop in V8, and the
    // reason a full scan stays in the low milliseconds.
    for (let j = 0; j < dim; j += 4) {
      s += mat[base + j] * q[j] +
           mat[base + j + 1] * q[j + 1] +
           mat[base + j + 2] * q[j + 2] +
           mat[base + j + 3] * q[j + 3];
    }

    if (s < minSim) continue;
    if (hits.length < k) {
      hits.push({ window_id: wid, sim: s });
      if (hits.length === k) {
        hits.sort((a, b) => b.sim - a.sim);
        worst = hits[k - 1].sim;
      }
    } else if (s > worst) {
      // Replace the current worst, then bubble it into place. k is small (≤200)
      // and this path is rare after the first pass, so insertion beats a heap.
      hits[k - 1] = { window_id: wid, sim: s };
      for (let j = k - 1; j > 0 && hits[j].sim > hits[j - 1].sim; j--) {
        const t = hits[j]; hits[j] = hits[j - 1]; hits[j - 1] = t;
      }
      worst = hits[k - 1].sim;
    }
  }

  if (hits.length < k) hits.sort((a, b) => b.sim - a.sim);
  return hits;
}

/**
 * Reciprocal Rank Fusion.
 *
 * Chosen over score normalization for a concrete reason: BM25 returns unbounded
 * negatives whose scale depends on corpus statistics, while cosine on normalized
 * embeddings lives in a narrow band. There is no stable mapping between them.
 * Min-max normalizing per query is the tempting fix and it fails badly — it forces
 * each arm's top hit to 1.0 *whether or not that arm found anything*, so on a query
 * BM25 cannot serve, its best garbage is promoted to a perfect score and dragged
 * into the fused head.
 *
 * RRF uses only ranks: scale-free, nothing to calibrate, and the right default
 * with zero labelled data.
 *
 * k defaults to 20 rather than the customary 60. That constant was tuned for
 * web-scale corpora; at this size k=60 leaves only a ~2.6x spread between rank 1
 * and rank 100, far too flat to separate a head.
 */
export function fuseRRF(arms: { ids: number[]; weight: number }[], k = 20): Map<number, number> {
  const fused = new Map<number, number>();
  for (const { ids, weight } of arms) {
    for (let r = 0; r < ids.length; r++) {
      fused.set(ids[r], (fused.get(ids[r]) ?? 0) + weight / (k + r + 1));
    }
  }
  return fused;
}
