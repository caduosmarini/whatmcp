import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { tryAcquireSyncLock } from '../sync-lock.ts';

const path = z.string().max(4096).refine(v => !v || isAbsolute(v), 'Use an absolute path');
export const settingsSchema = z.object({
  openai_api_key:z.string().max(1024).optional(),
  openai_model:z.enum(['text-embedding-3-small','text-embedding-3-large']).optional(),
  openai_dims:z.number().int().min(1).max(3072).optional(),
  min_sim:z.number().min(0).max(1).optional(),strong_sim:z.number().min(0).max(1).optional(),
  transcription_model:z.enum(['apple-speech','apple-dictation','gpt-transcribe']).nullable().optional(),
  transcription_default_language:z.string().max(40).refine(v=>{try{return !!Intl.getCanonicalLocales(v)[0]}catch{return false}},'Use a language tag').optional(),
  transcription_concurrency:z.number().int().min(1).max(4).optional(),
  transcription_batch_size:z.number().int().min(1).max(10000).optional(),
  transcription_auto_after_import:z.boolean().optional(),
  sync_timeout_minutes:z.number().min(1).max(1000).optional(),
  source_type:z.enum(['chatstorage','windows-waren6']).optional(),
  windows_waren6_path:path.optional(),windows_source_path:path.optional(),windows_output_dir:path.optional(),
  ffmpeg_path:path.optional(),ffprobe_path:path.optional(),
  desktop_check_updates:z.boolean().optional(),
}).strict();
export function configSnapshot(file:string) {
  const raw=existsSync(file)?readFileSync(file,'utf8'):'{}';
  const saved=JSON.parse(raw);
  if(!saved || Array.isArray(saved) || typeof saved!=='object')throw new Error('Configuration must be an object');
  const values:Record<string,unknown>={};
  for(const key of Object.keys(settingsSchema.shape))if(key!=='openai_api_key' && key in saved)values[key]=saved[key];
  return {values,keyConfigured:!!saved.openai_api_key,revision:createHash('sha256').update(raw).digest('hex')};
}
export function saveSettings(file:string,patch:unknown,revision:string,platform=process.platform) {
  const valid=settingsSchema.parse(patch);
  if(platform!=='darwin' && valid.transcription_model?.startsWith('apple-'))throw new Error('Apple transcription requires macOS');
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  // Coordinate config writers and preserve fields belonging to MCP/HTTP/scheduling.
  const release=tryAcquireSyncLock(`${file}.desktop-lock.db`);
  if(!release)throw new Error('Configuration is being edited; reload and try again');
  const temp=`${file}.${randomUUID()}.tmp`;
  try {
    if(configSnapshot(file).revision!==revision)throw new Error('Configuration changed elsewhere; reload before saving');
    const saved=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
    writeFileSync(temp,JSON.stringify({...saved,...valid},null,2)+'\n',{mode:0o600,flag:'wx'});
    renameSync(temp,file);
    return configSnapshot(file);
  }finally{if(existsSync(temp))unlinkSync(temp);release();}
}
export function validateProfile(root:string) {
  if(!isAbsolute(root))throw new Error('Select an absolute profile folder');
  return realpathSync(resolve(root));
}
