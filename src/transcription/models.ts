import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, renameSync, statSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, type Config, type TranscriptionModel,
  TRANSCRIPTION_MODELS } from '../config.ts';

const exec = promisify(execFile);
const SWIFT_SOURCE = join(import.meta.dirname, 'AppleTranscribe.swift');
const APPLE_BINARY = join(DATA_DIR, 'bin', 'apple-transcribe');

function appleBinary(): string {
  if (process.platform !== 'darwin') throw new Error('Apple transcription requires macOS');
  // Desktop builds ship this helper; end users do not need Xcode or swiftc.
  const bundled = process.env.WHATMCP_APPLE_BINARY;
  if (bundled && existsSync(bundled)) return bundled;
  if (existsSync(APPLE_BINARY) && statSync(APPLE_BINARY).mtimeMs >= statSync(SWIFT_SOURCE).mtimeMs) {
    return APPLE_BINARY;
  }
  mkdirSync(join(DATA_DIR, 'bin'), { recursive: true, mode: 0o700 });
  const temp = `${APPLE_BINARY}.${randomUUID()}`;
  try {
    execFileSync('swiftc', ['-parse-as-library', '-O', SWIFT_SOURCE, '-o', temp],
      { timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
    renameSync(temp, APPLE_BINARY);
  } catch (e) {
    throw new Error(`Cannot compile Apple transcription helper: ${(e as Error).message}`);
  }
  return APPLE_BINARY;
}

export interface ModelAvailability { model: TranscriptionModel; available: boolean; reason: string }

/** Asset download is always an explicit setup/CLI action, never a transcription fallback. */
export async function installAppleModel(model: TranscriptionModel, locale: string): Promise<void> {
  if (model === 'gpt-transcribe' || process.platform !== 'darwin') {
    throw new Error('Apple speech assets require macOS and an Apple model');
  }
  await exec(appleBinary(), ['install', model, locale], { timeout: 600_000 });
}

export async function availableModels(cfg: Config): Promise<ModelAvailability[]> {
  const locale = cfg.transcriptionDefaultLanguage ?? 'pt-BR';
  const out: ModelAvailability[] = [];
  for (const model of TRANSCRIPTION_MODELS) {
    if (model === 'gpt-transcribe') {
      out.push({ model, available: !!cfg.openaiKey,
        reason: cfg.openaiKey ? 'API key configured; project access checked on use'
          : 'OpenAI API key missing' });
    } else if (process.platform !== 'darwin') {
      out.push({ model, available: false, reason: 'requires macOS' });
    } else {
      try {
        const { stdout } = await exec(appleBinary(), ['probe', model, locale], { timeout: 30_000 });
        const result = JSON.parse(stdout) as { available: boolean; reason: string };
        out.push({ model, ...result });
      } catch (e) {
        out.push({ model, available: false, reason: (e as Error).message.split('\n')[0] });
      }
    }
  }
  return out;
}

export class TranscriptionError extends Error {
  retryable: boolean;
  pauseModel: boolean;
  retryAfterSeconds: number;
  constructor(message: string, retryable: boolean, pauseModel = false, retryAfterSeconds = 0) {
    super(message);
    this.retryable = retryable;
    this.pauseModel = pauseModel;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const AUDIO_TYPES: Record<string,string> = {
  '.wav':'audio/wav','.mp3':'audio/mpeg','.mp4':'audio/mp4','.m4a':'audio/mp4',
  '.mpeg':'audio/mpeg','.mpga':'audio/mpeg','.webm':'audio/webm','.ogg':'audio/ogg','.flac':'audio/flac',
};
export function canUploadDirect(path:string,size:number): boolean {
  return !!AUDIO_TYPES[extname(path).toLowerCase()] && size <= 25_000_000;
}

/** Injectable transport keeps provider tests offline and cost-free. */
export interface TranscriptionTransport {
  fetch?: typeof fetch;
  sleep?: (ms:number)=>Promise<void>;
  random?: ()=>number;
  prompt?: string;
}

export async function transcribeSegment(model: TranscriptionModel, locale: string,
  audioPath: string, apiKey: string | null, transport: TranscriptionTransport = {}): Promise<string> {
  if (model !== 'gpt-transcribe') {
    try {
      const { stdout } = await exec(appleBinary(), ['transcribe', model, locale, audioPath],
        { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
      return (JSON.parse(stdout) as { text: string }).text.trim();
    } catch (e) {
      const error = e as NodeJS.ErrnoException & { killed?: boolean };
      throw new TranscriptionError(error.killed
        ? 'Apple transcription timed out after five minutes'
        : 'Apple transcription failed; check Speech permission and language asset',
      !!error.killed, !error.killed);
    }
  }
  if (!apiKey) throw new TranscriptionError('OpenAI API key missing', false, true);
  const bytes = readFileSync(audioPath);
  if (!canUploadDirect(audioPath,bytes.byteLength)) {
    throw new TranscriptionError('audio format unsupported or file exceeds 25 MB', false);
  }
  const body = new FormData();
  body.append('model', 'gpt-transcribe');
  body.append('languages[]', locale.split('-')[0]);
  if(transport.prompt)body.append('prompt',transport.prompt);
  body.append('file', new Blob([bytes], { type: AUDIO_TYPES[extname(audioPath).toLowerCase()] }), basename(audioPath));
  const send=transport.fetch ?? fetch;
  const sleep=transport.sleep ?? ((ms:number)=>new Promise<void>(r=>setTimeout(r,ms)));
  const random=transport.random ?? Math.random;
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      response = await send('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body,
        signal: AbortSignal.timeout(300_000),
      });
    } catch {
      if (attempt === 0) {await sleep(1000+500*random());continue;}
      throw new TranscriptionError('transcription network/timeout error', true,true,30);
    }
    if (response.ok) {
      const result = await response.json() as { text?: string };
      if (typeof result.text !== 'string') {
        throw new TranscriptionError('OpenAI transcription response had no text field', true,true,30);
      }
      return result.text.trim();
    }
    let code='';
    try { code=(await response.json() as {error?:{code?:string}}).error?.code ?? ''; } catch { /* no JSON */ }
    if(response.status===429 && code==='insufficient_quota') {
      throw new TranscriptionError('OpenAI transcription quota exhausted',false,true);
    }
    if ([403, 429].includes(response.status) || response.status >= 500) {
      const header=response.headers.get('retry-after');
      const seconds=header ? (/^\d+(\.\d+)?$/.test(header) ? Number(header) :
        Math.max(0,(Date.parse(header)-Date.now())/1000)) : 0;
      const delay=Math.max(Number.isFinite(seconds)?seconds:0,1.5+random());
      // Persist long waits instead of occupying a worker for minutes.
      if (attempt === 0 && delay<=30) { await sleep(delay*1000);continue; }
      throw new TranscriptionError(`OpenAI transcription HTTP ${response.status}`,
        response.status!==403,true,Math.ceil(delay));
    }
    throw new TranscriptionError(`OpenAI transcription HTTP ${response.status}`, false,
      response.status === 401);
  }
  throw new TranscriptionError('transcription retry exhausted', true,true,30);
}
