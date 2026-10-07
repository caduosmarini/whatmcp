/** Periodic capture -> bounded transcription -> normal supervised sync. */
import {spawn} from 'node:child_process';
import {constants} from 'node:os';
import {join} from 'node:path';
import {resolveTranscriptionBatchSize,type Config} from './config.ts';
import {isScheduledSyncPaused,runSyncProcess,syncTimeoutMs,syncWorkerCommand} from './sync-process.ts';

/** Transcription has its own per-segment timeout; the sync budget does not apply. */
export function runTranscriptionProcess(command: string, args: string[]): Promise<number> {
  return new Promise((resolve,reject) => {
    const child=spawn(command,args,{stdio:'inherit',windowsHide:true});
    let interrupted: 'SIGINT'|'SIGTERM'|undefined;
    let stopTimer: NodeJS.Timeout|undefined;
    const stop=(signal:'SIGINT'|'SIGTERM') => {
      interrupted=signal;
      if(child.exitCode!==null || child.signalCode!==null)return;
      child.kill(signal);
      stopTimer ??= setTimeout(() => {
        if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');
      },5000);
    };
    const onInt=()=>stop('SIGINT'),onTerm=()=>stop('SIGTERM');
    process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);
    const cleanup=()=>{
      process.off('SIGINT',onInt);process.off('SIGTERM',onTerm);
      if(stopTimer)clearTimeout(stopTimer);
    };
    child.once('error',error=>{cleanup();reject(error);});
    child.once('close',(code,signal)=>{
      cleanup();
      resolve(interrupted ? 128+constants.signals[interrupted]
        : code ?? (signal ? 128+(constants.signals[signal]??1) : 1));
    });
  });
}

export async function runScheduledSync(
  cfg: Pick<Config,'sourceType'|'syncTimeoutMinutes'|'transcriptionModel'|'transcriptionBatchSize'>,
  options: {
    sync?: typeof runSyncProcess;
    transcribe?: typeof runTranscriptionProcess;
    paused?: typeof isScheduledSyncPaused;
  } = {},
): Promise<number> {
  const sync=options.sync??runSyncProcess;
  const transcribe=options.transcribe??runTranscriptionProcess;
  if((options.paused??isScheduledSyncPaused)()) {
    console.error('scheduled sync paused after a timeout; run `npm run sync` manually to retry');
    return 76;
  }
  const watchdog={scheduled:true,timeoutMs:syncTimeoutMs(cfg.sourceType,cfg.syncTimeoutMinutes)};
  let transcriptionCode=0;
  if(cfg.transcriptionModel) {
    const batchSize=resolveTranscriptionBatchSize(cfg.transcriptionBatchSize);
    console.log('scheduled: capturing new messages and audio references');
    const [command,args]=syncWorkerCommand(false,true);
    const captureCode=await sync(command,args,watchdog);
    // Do not transcribe stale data after a failed, overlapping, or interrupted capture.
    if(captureCode!==0)return captureCode;
    console.log(`scheduled: transcribing up to ${batchSize} pending audio files`);
    try {
      transcriptionCode=await transcribe(process.execPath,[
        '--experimental-sqlite','--experimental-strip-types','--no-warnings',
        join(import.meta.dirname,'cli.ts'),'transcribe',`--limit=${batchSize}`,
      ]);
    }catch(error){
      console.error(`scheduled transcription could not start: ${(error as Error).message}`);
      transcriptionCode=1;
    }
    if([130,143].includes(transcriptionCode))return transcriptionCode;
    if(transcriptionCode!==0)console.error(`scheduled transcription failed (exit ${transcriptionCode}); continuing message sync`);
  }
  console.log('scheduled: syncing messages and embedding published transcripts');
  const [command,args]=syncWorkerCommand();
  // Keep the final stage embedding-only even when automatic imports are enabled.
  args.push('--skip-auto-transcription');
  const syncCode=await sync(command,args,watchdog);
  return syncCode || transcriptionCode;
}
