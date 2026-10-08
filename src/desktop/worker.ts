import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, loadConfig, embedConfig } from '../config.ts';
import { tryAcquireSyncLock } from '../sync-lock.ts';
import { runIndex } from '../index/indexer.ts';
import { runWindowsIndex } from '../index/windows-source.ts';
import { embedMissing } from '../index/embed.ts';
import { runTranscription } from '../transcription/worker.ts';
import { installAppleModel } from '../transcription/models.ts';
import { syncDemo,transcribeDemo,embedDemo } from './demo.ts';

const request=JSON.parse(readFileSync(0,'utf8'));
const say=(value:unknown)=>console.log(JSON.stringify({progress:value}));
const demo=process.env.WHATMCP_DESKTOP_MODE==='demo';
const cfg=loadConfig();
// Node never reads live macOS protected media; capture copies are the only input.
if(process.platform==='darwin'&&!demo)cfg.mediaRoots={...cfg.mediaRoots,macos:join(DATA_DIR,'media','macos')};
const release=tryAcquireSyncLock();
try{
  if(!release)throw new Error('Another sync, import or transcription is running; try again after it finishes.');
  if(request.kind==='sync'){
    if(demo)say(syncDemo(cfg));
    else if(process.platform==='win32')say(await runWindowsIndex(cfg,{progress:say}));
    else if(process.platform==='darwin'){
      if(!request.expiresAt||Date.now()>=request.expiresAt)throw new Error('Capture authorization expired; authorize again in Settings.');
      const collector=process.env.WHATMCP_COLLECTOR;
      if(!collector)throw new Error('macOS collector is not bundled');
      const output=join(DATA_DIR,'captures',randomUUID());mkdirSync(output,{recursive:true,mode:0o700});
      try{const capture=JSON.parse(execFileSync(collector,[],{input:JSON.stringify({sourceHome:process.env.WHATMCP_USER_HOME,output,mediaOutput:join(DATA_DIR,'media','macos'),expiresAt:request.expiresAt}),encoding:'utf8',timeout:Math.max(1,request.expiresAt-Date.now()),maxBuffer:65536}));
        say(runIndex(cfg.store,{chatstorage:'',snapshotPath:capture.snapshot,mediaSourceId:'macos',onProgress:say}));}finally{rmSync(output,{recursive:true,force:true});}
    }else throw new Error('Live collection is supported on macOS and Windows');
    if(cfg.transcriptionAutoAfterImport&&cfg.transcriptionModel){say('Transcribing after import');if(demo)say(await transcribeDemo(cfg,undefined,false,say));else say(await runTranscription(cfg,{limit:cfg.transcriptionBatchSize,onProgress:say}));}
  }else if(request.kind==='transcribe'){
    if(demo)say(await transcribeDemo(cfg,request.messageId,request.retry,say));
    else{const result=await runTranscription(cfg,{messageId:request.messageId,retryErrors:!!request.retry,limit:cfg.transcriptionBatchSize,onProgress:say});say(result);if(result.failed)throw new Error(`${result.failed} recording(s) failed; completed progress is saved.`);}
  }else if(request.kind==='embed'){
    if(demo)say(embedDemo(cfg,say));else{const r=await embedMissing(cfg.store,embedConfig(cfg),{onProgress:say});say(r);if(r.failed)throw new Error(`${r.failed} segments remain pending; retry later.`);}
  }else if(request.kind==='install-model'){
    if(demo)say('Demonstração: nenhum modelo foi instalado');else{if(!cfg.transcriptionModel)throw new Error('Choose a model first');await installAppleModel(cfg.transcriptionModel,cfg.transcriptionDefaultLanguage??'pt-BR');say('Speech assets installed');}
  }else throw new Error('Unknown job');
}catch(error){console.error((error as Error).message);process.exitCode=1;}finally{release?.();}
