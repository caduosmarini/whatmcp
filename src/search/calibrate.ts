/**
 * Fitting the similarity thresholds to a corpus.
 *
 * The method needs no labelled data: embed queries about subjects guaranteed to
 * be absent from a personal chat history, and measure how similar the corpus's
 * *best* match to that nonsense is. That is the noise ceiling. A real hit scoring
 * above it is evidence; anything below the nonsense mid-field is not worth
 * returning at all.
 *
 * This lives in its own module because three callers need it and the numbers
 * matter too much to let them drift apart: `calibrate` runs it deliberately,
 * `setup` runs it after the first embed, and `embed`/`sync` run it the first time
 * an archive acquires vectors. The defaults compiled into search are a guess, and
 * the gap is not subtle — on the reference corpus the measured value was 0.306
 * against a hard-coded 0.42, which would have marked almost nothing as a
 * confident match.
 */

import { embedConfig, writeFileConfig, type Config } from '../config.ts';
import { getStore } from '../store.ts';
import { modelTag, embed as apiEmbed } from '../index/openai.ts';
import { topKCosine } from './vectors.ts';

/**
 * Subjects no personal chat history contains, spread across enough unrelated
 * domains that no single one of them can accidentally be on-topic for a given
 * user. Their best matches are, by construction, the corpus answering a question
 * it has nothing to say about.
 */
export const NOISE_PROBES = [
  'lattice gauge theory in quantum chromodynamics',
  'sourdough starter hydration ratio troubleshooting',
  'Tokyo subway fare adjustment machine instructions',
  'crop rotation practices in medieval Flanders',
  'tuning valve clearance on a diesel tractor engine',
  'Byzantine fault tolerance in distributed consensus',
  'care instructions for a tropical saltwater reef aquarium',
  'municipal zoning variance appeal procedure',
];

export interface Calibration {
  /** A hit above this beats anything nonsense retrieved, so it stands alone. */
  strong: number;
  /** Floor; only drops the pathological tail. */
  minSim: number;
  /** Best similarity each probe achieved. */
  top1: number[];
  /** 100th-result similarity for each probe. */
  p100: number[];
  /** How many vectors were probed. */
  n: number;
}

/**
 * Probe the corpus and write the fitted thresholds to the config file.
 *
 * Returns null when there is nothing to calibrate against — no vectors yet, or
 * every probe came back empty — rather than writing thresholds derived from an
 * empty sample.
 */
export async function calibrateThresholds(
  cfg: Config,
  opts: { onProbe?: (query: string, top1: number, p100: number) => void } = {},
): Promise<Calibration | null> {
  const ec = embedConfig(cfg);
  const ix = getStore(cfg.store, modelTag(ec)).vectors;
  if (!ix) return null;

  const top1: number[] = [];
  const p100: number[] = [];
  for (const q of NOISE_PROBES) {
    const { vectors } = await apiEmbed(ec, [q]);
    const hits = topKCosine(ix, vectors[0], 100);
    if (hits.length === 0) continue;
    const best = hits[0].sim;
    const tail = hits[hits.length - 1].sim;
    top1.push(best);
    p100.push(tail);
    opts.onProbe?.(q, best, tail);
  }
  if (top1.length === 0) return null;

  const max = (a: number[]) => a.reduce((x, y) => Math.max(x, y), -Infinity);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

  // A hit must beat the best match nonsense could find before it counts as
  // evidence on its own. The margin absorbs the fact that these probes are a
  // sample of the noise distribution, not the whole of it.
  const strong = Number((max(top1) + 0.02).toFixed(3));
  // The floor only removes the pathological tail: below the *typical* 100th
  // result of a nonsense query, a window is not plausibly about anything asked.
  const minSim = Number(mean(p100).toFixed(3));

  writeFileConfig({ strong_sim: strong, min_sim: minSim });
  return { strong, minSim, top1, p100, n: ix.n };
}
