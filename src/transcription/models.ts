import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, renameSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join, extname, basename, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, type Config, type TranscriptionModel,
  TRANSCRIPTION_MODELS } from '../config.ts';

const exec = promisify(execFile);
const SWIFT_SOURCE = join(import.meta.dirname, 'AppleTranscribe.swift');
const APPLE_BINARY = join(DATA_DIR, 'bin', 'apple-transcribe');
const LOCAL_HELPER = join(import.meta.dirname, 'local-whisper.py');

export function localWhisperPaths(cfg: Pick<Config,'transcriptionLocalPythonPath'|'transcriptionLocalModelPath'> = {}): {python: string; modelPath: string} {
  const python = cfg.transcriptionLocalPythonPath ?? process.env.WHATMCP_LOCAL_PYTHON_PATH ??
    join(DATA_DIR,'local-whisper',process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python');
  if(cfg.transcriptionLocalModelPath)return {python,modelPath:cfg.transcriptionLocalModelPath};
  if(process.env.WHATMCP_LOCAL_MODEL_PATH)return {python,modelPath:process.env.WHATMCP_LOCAL_MODEL_PATH};
  for(const repo of ['models--mobiuslabsgmbh--faster-whisper-large-v3-turbo','models--Systran--faster-whisper-small']) {
    const snapshots=join(homedir(),'.cache','huggingface','hub',repo,'snapshots');
    if(!existsSync(snapshots))continue;
    for(const revision of readdirSync(snapshots).sort().reverse()) {
      const modelPath=join(snapshots,revision);
      if(existsSync(join(modelPath,'model.bin')) && statSync(join(modelPath,'model.bin')).size>0)return {python,modelPath};
    }
  }
  return {python,modelPath:''};
}

function appleBinary(): string {
  if (process.platform !== 'darwin') throw new Error('Apple transcription requires macOS');
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
  if (!['apple-speech','apple-dictation'].includes(model) || process.platform !== 'darwin') {
    throw new Error('Apple speech assets require macOS and an Apple model');
  }
  await exec(appleBinary(), ['install', model, locale], { timeout: 600_000 });
}

export async function availableModels(cfg: Config): Promise<ModelAvailability[]> {
  const locale = cfg.transcriptionDefaultLanguage ?? 'pt-BR';
  const out: ModelAvailability[] = [];
  for (const model of TRANSCRIPTION_MODELS) {
    if(model === 'faster-whisper') {
      const paths=localWhisperPaths(cfg);
      if(!existsSync(paths.python)||!paths.modelPath) {
        out.push({model,available:false,reason:'local Python environment or cached Whisper model missing'});
        continue;
      }
      try {
        const {stdout}=await exec(paths.python,[LOCAL_HELPER,'probe','--model-path',paths.modelPath],
          {timeout:30_000,maxBuffer:1024*1024,windowsHide:true});
        const result=JSON.parse(stdout) as {available:boolean;reason:string};
        out.push({model,...result});
      }catch {
        out.push({model,available:false,reason:'local faster-whisper runtime or model unavailable'});
      }
    } else if (model === 'gpt-transcribe') {
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

export interface LocalWhisperSession {
  device: 'cuda'|'cpu';
  transcribe(audioPath:string):Promise<string>;
  close():Promise<void>;
}

/** One helper owns the loaded model for a sequential local transcription run. */
export async function createLocalWhisperSession(
  cfg: Pick<Config,'transcriptionLocalPythonPath'|'transcriptionLocalModelPath'>,
  locale:string,
  options: {spawn?:typeof spawn;readyTimeoutMs?:number;requestTimeoutMs?:number;
    closeTimeoutMs?:number;maxBuffer?:number} = {},
):Promise<LocalWhisperSession> {
  const paths=localWhisperPaths(cfg);
  if(!paths.modelPath)throw new TranscriptionError('local Whisper model missing',false,true);
  const child=(options.spawn??spawn)(paths.python,[LOCAL_HELPER,'serve','--model-path',paths.modelPath,
    '--language',locale.split('-')[0]],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const decoder=new StringDecoder('utf8');
  let buffer='',failure:TranscriptionError|undefined,closing=false,closed=false;
  let pending: {resolve:(result:Record<string,unknown>)=>void;reject:(error:Error)=>void;
    timer:NodeJS.Timeout}|undefined;
  let markClosed!:()=>void;
  const completion=new Promise<void>(r=>{markClosed=r;});
  const fail=(message:string,retryable=false):void=>{
    failure??=new TranscriptionError(message,retryable,true);
    if(pending){clearTimeout(pending.timer);pending.reject(failure);pending=undefined;}
    if(!closed)child.kill();
  };
  const waitForReply=(timeout:number):Promise<Record<string,unknown>>=>new Promise((resolveReply,reject)=>{
    if(failure){reject(failure);return;}
    if(closed||closing){reject(new TranscriptionError('local Whisper session closed',true,true));return;}
    if(pending){reject(new Error('local Whisper session requires sequential requests'));return;}
    pending={resolve:resolveReply,reject,timer:setTimeout(()=>fail('local Whisper helper timed out',true),timeout)};
  });
  child.stdout!.on('data',(chunk:Buffer)=>{
    buffer+=decoder.write(chunk);
    if(Buffer.byteLength(buffer,'utf8')>(options.maxBuffer??4*1024*1024)) {
      fail('local Whisper response exceeded the output limit');return;
    }
    let newline:number;
    while((newline=buffer.indexOf('\n'))>=0) {
      const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);
      if(!line)continue;
      let result:unknown;
      try {result=JSON.parse(line);}catch {fail('local Whisper helper returned invalid JSON');return;}
      if(!result||typeof result!=='object'||Array.isArray(result)||!pending) {
        fail('local Whisper helper returned an unexpected response');return;
      }
      const reply=pending;pending=undefined;clearTimeout(reply.timer);
      reply.resolve(result as Record<string,unknown>);
    }
  });
  // Drain diagnostics without copying private audio contents or paths into logs.
  child.stderr!.resume();
  child.stdin!.on('error',()=>fail('local Whisper input stream failed',true));
  child.on('error',()=>fail('local Whisper helper could not start',true));
  child.once('close',()=>{
    closed=true;
    if(!closing)fail('local Whisper helper exited before completing the request',true);
    markClosed();
  });
  let closePromise:Promise<void>|undefined;
  const close=():Promise<void>=>closePromise??=(async()=>{
    closing=true;
    if(pending){clearTimeout(pending.timer);pending.reject(new TranscriptionError('local Whisper session closed',true,true));pending=undefined;}
    if(!closed)child.stdin!.end();
    const timer=setTimeout(()=>{if(!closed)child.kill();},options.closeTimeoutMs??2000);
    const force=setTimeout(()=>{if(!closed)child.kill('SIGKILL');},(options.closeTimeoutMs??2000)+1000);
    try {await completion;}finally {clearTimeout(timer);clearTimeout(force);}
  })();
  try {
    const ready=await waitForReply(options.readyTimeoutMs??90_000);
    if(ready.available!==true||!['cuda','cpu'].includes(String(ready.device))) {
      throw new TranscriptionError('local Whisper model could not initialize',false,true);
    }
    return {
      device:ready.device as 'cuda'|'cpu',
      async transcribe(audioPath:string):Promise<string> {
        if(pending)throw new Error('local Whisper session requires sequential requests');
        const response=waitForReply(options.requestTimeoutMs??600_000);
        if(!failure&&!closed&&!closing)child.stdin!.write(JSON.stringify({audio:resolve(audioPath)})+'\n');
        const result=await response;
        if(typeof result.text!=='string') {
          fail('local Whisper transcription failed; check local runtime and model');
          throw failure!;
        }
        return result.text.trim();
      },
      close,
    };
  }catch(error) {
    await close();throw error;
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
  localPythonPath?: string;
  localModelPath?: string;
  /** Offline provider adapter for command construction and failure tests. */
  localExec?: (command:string,args:string[])=>Promise<{stdout:string}>;
}

export async function transcribeSegment(model: TranscriptionModel, locale: string,
  audioPath: string, apiKey: string | null, transport: TranscriptionTransport = {}): Promise<string> {
  if(model === 'faster-whisper') {
    const paths=localWhisperPaths({transcriptionLocalPythonPath:transport.localPythonPath,
      transcriptionLocalModelPath:transport.localModelPath});
    if(!paths.modelPath)throw new TranscriptionError('local Whisper model missing',false,true);
    try {
      const args=[LOCAL_HELPER,'transcribe','--model-path',paths.modelPath,
        '--language',locale.split('-')[0],'--audio',audioPath];
      const {stdout}=await (transport.localExec ?? ((command,args)=>exec(command,args,
        {timeout:600_000,maxBuffer:4*1024*1024,windowsHide:true})))(paths.python,args);
      const result=JSON.parse(stdout) as {text?:string};
      if(typeof result.text!=='string')throw new Error('local transcription returned no text');
      return result.text.trim();
    }catch(e) {
      const error=e as NodeJS.ErrnoException & {killed?:boolean};
      throw new TranscriptionError(error.killed ? 'local Whisper transcription timed out'
        : 'local Whisper transcription failed; check local runtime and model',!!error.killed,!error.killed);
    }
  }
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
