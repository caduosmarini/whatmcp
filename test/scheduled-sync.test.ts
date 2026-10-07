import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {runScheduledSync,runTranscriptionProcess} from '../src/scheduled-sync.ts';

const cfg={sourceType:'chatstorage' as const,transcriptionModel:'apple-speech' as const,syncTimeoutMinutes:12};

test('new audio is captured before transcription and embedded in the same cycle',async()=>{
  let captured=false,published=false;
  const events:string[]=[];
  const code=await runScheduledSync(cfg,{
    paused:()=>false,
    sync:async(_command,args,options)=>{
      assert.equal(options?.timeoutMs,720000);
      assert.equal(options?.scheduled,true);
      if(args.includes('--index-only')){captured=true;events.push('capture');}
      else{assert.ok(published);events.push('sync');}
      return 0;
    },
    transcribe:async(_command,args)=>{
      assert.ok(captured,'fresh media must exist before the worker selects it');
      assert.ok(args.includes('--limit=100'),'each tick must bound the historical backlog');
      published=true;events.push('transcribe');return 0;
    },
  });
  assert.equal(code,0);assert.deepEqual(events,['capture','transcribe','sync']);
});

test('audio failure is reported but does not starve message capture or embeddings',async()=>{
  for(const throws of [false,true]){
    let syncs=0;
    const code=await runScheduledSync(cfg,{
      paused:()=>false,sync:async()=>{syncs++;return 0;},
      transcribe:async()=>{if(throws)throw new Error('speech engine unavailable');return 1;},
    });
    assert.equal(syncs,2);assert.equal(code,1);
  }
});

test('failed capture never starts transcription of an outdated archive',async()=>{
  for(const captureCode of [75,124,143]){
    let calls=0;
    assert.equal(await runScheduledSync(cfg,{
      paused:()=>false,sync:async()=>{calls++;return captureCode;},
      transcribe:async()=>{assert.fail('transcription should not start');},
    }),captureCode);
    assert.equal(calls,1);
  }
});

test('a paused schedule performs no source read or model call',async()=>{
  assert.equal(await runScheduledSync(cfg,{
    paused:()=>true,sync:async()=>{assert.fail('sync should not start');},
    transcribe:async()=>{assert.fail('transcription should not start');},
  }),76);
});

test('disabled transcription preserves the previous single-sync workflow',async()=>{
  let calls=0;
  assert.equal(await runScheduledSync({...cfg,transcriptionModel:null},{
    paused:()=>false,sync:async(_command,args)=>{calls++;assert.ok(!args.includes('--index-only'));return 0;},
    transcribe:async()=>{assert.fail('disabled model should not run');},
  }),0);
  assert.equal(calls,1);
});

test('interrupting transcription does not start sync after cancellation',async()=>{
  let calls=0;
  assert.equal(await runScheduledSync(cfg,{
    paused:()=>false,sync:async()=>{calls++;return 0;},transcribe:async()=>143,
  }),143);
  assert.equal(calls,1);
});

test('transcription subprocess preserves failures and forwards termination',async()=>{
  assert.equal(await runTranscriptionProcess(process.execPath,['-e','process.exit(13)']),13);
  const script=`import {runTranscriptionProcess} from './src/scheduled-sync.ts';
    const running=runTranscriptionProcess(process.execPath,['-e','setInterval(()=>{},1000)']);
    setTimeout(()=>process.kill(process.pid,'SIGTERM'),200);
    console.log(await running);`;
  const output=execFileSync(process.execPath,[
    '--experimental-sqlite','--experimental-strip-types','--no-warnings','--input-type=module','-e',script,
  ],{cwd:join(import.meta.dirname,'..'),encoding:'utf8',timeout:5000});
  assert.equal(output.trim(),'143');
});
