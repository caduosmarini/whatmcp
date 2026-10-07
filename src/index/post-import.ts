import { embedConfig, type Config } from '../config.ts';
import { openStore } from '../db/index.ts';
import { runTranscription } from '../transcription/worker.ts';
import { embedMissing, vectorCoverage, type ProgressEvent } from './embed.ts';

/** Called under the import/sync lock, after acquisition has finished. */
export async function processImportedArchive(cfg: Config, options: {
  onProgress?: (message: string) => void;
  onEmbeddingProgress?: (event: ProgressEvent) => void;
  calibrate?: (cfg: Config, embedded: number) => Promise<void>;
  // Offline test adapters, with the same resumable production implementations by default.
  transcribe?: typeof runTranscription;
  embed?: typeof embedMissing;
} = {}): Promise<void> {
  const say = options.onProgress ?? (() => {});
  let audioError: Error | undefined;
  if (cfg.transcriptionAutoAfterImport && cfg.transcriptionModel) {
    say('transcribing pending audio');
    try {
      const r = await (options.transcribe ?? runTranscription)(cfg, {
        limit: Infinity, onProgress: say,
      });
      say(`audio: ${r.processed} processed, ${r.noSpeech} without speech, ${r.reused} reused, ${r.failed} failed`);
      if (r.failed) audioError = new Error(`${r.failed} audio transcription(s) failed; progress is saved for a later retry.`);
    } catch (error) {
      audioError = error instanceof Error ? error : new Error(String(error));
      say(`audio processing incomplete: ${audioError.message}`);
    }
  }
  // Publish vectors for successful audio and new text even if some audio failed.
  if (cfg.openaiKey) {
    say('embedding pending windows');
    const ec = embedConfig(cfg);
    const result = await (options.embed ?? embedMissing)(cfg.store, ec, {
      onProgress: options.onEmbeddingProgress,
    });
    if (result.failed) throw new Error(`${result.failed} embedding window(s) remain pending; retry processing.`);
    const db = openStore(cfg.store);
    try {
      const cov = vectorCoverage(db, ec);
      say(`coverage: ${cov.embedded}/${cov.windows} (${cov.pct}%)`);
      await options.calibrate?.(cfg, cov.embedded);
    } finally { db.close(); }
  } else {
    say('embedding skipped: no OpenAI key; FTS remains available');
  }
  if (audioError) throw audioError;
}
