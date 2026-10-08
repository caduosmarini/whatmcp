import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {transcribeSegment,TranscriptionError,localWhisperPaths,createLocalWhisperSession} from '../src/transcription/models.ts';

function audio(){const dir=mkdtempSync(join(tmpdir(),'whatmcp-provider-'));const path=join(dir,'voice.ogg');writeFileSync(path,'audio');return {dir,path};}
function sessionFixture(script:string, overrides:Partial<Parameters<typeof createLocalWhisperSession>[2]> = {}) {
  let launches=0;
  const children:ReturnType<typeof spawn>[]=[];
  const adapter:typeof spawn=((command,args,options)=>{
    launches++;assert.equal(command,'offline-python');assert.ok(args?.includes('serve'));
    assert.equal(options?.windowsHide,true);
    const child=spawn(process.execPath,['--input-type=module','-e',script],options);
    children.push(child);return child;
  }) as typeof spawn;
  return {children,launches:()=>launches,start:()=>createLocalWhisperSession({transcriptionLocalPythonPath:'offline-python',
    transcriptionLocalModelPath:'offline-model'},'pt-BR',{spawn:adapter,readyTimeoutMs:3000,
      requestTimeoutMs:3000,closeTimeoutMs:100,...overrides})};
}
function pidAlive(pid:number):boolean {try {process.kill(pid,0);return true;}catch {return false;}}
function cleanOwnedFixture(pid:number|undefined):void {
  if(pid&&pidAlive(pid)) {
    try {execFileSync('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:2000});}
    catch {/* fixture already exited */}
  }
}
function treeFixture(overrides:Partial<Parameters<typeof createLocalWhisperSession>[2]> = {}) {
  const directory=mkdtempSync(join(tmpdir(),'whatmcp-session-tree-'));
  const pidFile=join(directory,'descendant.pid');
  const descendant=`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
    process.stdout.write('{"available":true,"device":"cpu"}\\n');
    process.stdin.resume();setInterval(()=>{},1000);`;
  const launcher=`import {spawn} from 'node:child_process';
    spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{windowsHide:true,stdio:['inherit','inherit','inherit']});`;
  const fixture=sessionFixture(launcher,{closeTimeoutMs:30,requestTimeoutMs:30,
    terminationTimeoutMs:1000,cleanupTimeoutMs:100,...overrides});
  return {...fixture,descendantPid:()=>Number(readFileSync(pidFile,'utf8')),cleanup:()=>{
    cleanOwnedFixture(fixture.children[0]?.pid);
    try {cleanOwnedFixture(Number(readFileSync(pidFile,'utf8')));}catch {/* startup may have failed */}
    rmSync(directory,{recursive:true,force:true});
  }};
}
test('Windows request timeout terminates the launcher and its inherited-stdio descendant',
  {skip:process.platform!=='win32'},async()=>{
    const fixture=treeFixture();let session:Awaited<ReturnType<typeof fixture.start>>|undefined;
    try {
      session=await fixture.start();const descendant=fixture.descendantPid();const started=Date.now();
      await assert.rejects(session.transcribe('pending.wav'),e=>e instanceof TranscriptionError&&e.pauseModel);
      await session.close();
      assert.ok(Date.now()-started<4000,'request failure and close must be bounded');
      assert.equal(pidAlive(descendant),false,'taskkill must terminate the interpreter descendant');
    }finally {await session?.close();fixture.cleanup();}
  });
test('Windows close terminates a descendant that ignores stdin EOF',
  {skip:process.platform!=='win32'},async()=>{
    const fixture=treeFixture();let session:Awaited<ReturnType<typeof fixture.start>>|undefined;
    try {
      session=await fixture.start();const descendant=fixture.descendantPid();const started=Date.now();
      await session.close();
      assert.ok(Date.now()-started<4000,'close must be bounded with inherited stdio');
      assert.equal(pidAlive(descendant),false);
    }finally {await session?.close();fixture.cleanup();}
  });
test('Windows broken tree executor cannot retain the session through inherited stdio',
  {skip:process.platform!=='win32'},async()=>{
    let attempts=0;
    const fixture=treeFixture({terminateTree:async()=>{attempts++;await new Promise<void>(()=>{});},
      terminationTimeoutMs:30});
    let session:Awaited<ReturnType<typeof fixture.start>>|undefined;
    try {
      session=await fixture.start();const started=Date.now();
      await assert.rejects(session.transcribe('pending.wav'),e=>e instanceof TranscriptionError&&e.pauseModel);
      await session.close();
      assert.ok(Date.now()-started<4000,'a hung executor must not retain the DB-owning caller');
      assert.equal(attempts,1);
    }finally {await session?.close();fixture.cleanup();}
  });
test('persistent local session reuses one helper and accepts split UTF-8 responses',async()=>{
  const fixture=sessionFixture(`import {createInterface} from 'node:readline';
    import {isAbsolute} from 'node:path';
    process.stdout.write(JSON.stringify({available:true,device:'cuda'})+'\\n');
    let requests=0;
    const input=createInterface({input:process.stdin});
    input.on('line',line=>{
      const {audio}=JSON.parse(line);if(!isAbsolute(audio))process.exit(2);
      const reply=Buffer.from(JSON.stringify({text:'  café '+(++requests)+'  '})+'\\n');
      const split=reply.indexOf(Buffer.from('é'))+1;
      process.stdout.write(reply.subarray(0,split));
      setImmediate(()=>process.stdout.write(reply.subarray(split)));
    });`);
  const session=await fixture.start();
  try {
    assert.equal(session.device,'cuda');
    assert.equal(await session.transcribe('audio-one.wav'),'café 1');
    assert.equal(await session.transcribe('audio-two.wav'),'café 2');
    assert.equal(fixture.launches(),1);
  }finally {await session.close();await session.close();}
});
test('local session initialization timeout terminates its helper',async()=>{
  const fixture=sessionFixture('setInterval(()=>{},1000);',{readyTimeoutMs:30});
  await assert.rejects(fixture.start(),e=>e instanceof TranscriptionError&&e.retryable&&e.pauseModel);
});
test('local session request timeout pauses local processing',async()=>{
  const fixture=sessionFixture(`import {createInterface} from 'node:readline';
    process.stdout.write('{"available":true,"device":"cpu"}\\n');
    createInterface({input:process.stdin}).on('line',()=>{});`,{requestTimeoutMs:30});
  const session=await fixture.start();
  try {await assert.rejects(session.transcribe('one.wav'),e=>e instanceof TranscriptionError&&e.retryable&&e.pauseModel);}
  finally {await session.close();}
});
test('local session rejects private helper errors without copying diagnostic fields',async()=>{
  const fixture=sessionFixture(`import {createInterface} from 'node:readline';
    process.stdout.write('{"available":true,"device":"cpu"}\\n');
    createInterface({input:process.stdin}).on('line',()=>process.stdout.write(JSON.stringify({available:false,
      reason:'private audio path and contents',error_type:'RuntimeError'})+'\\n'));`);
  const session=await fixture.start();
  try {
    await assert.rejects(session.transcribe('one.wav'),e=>e instanceof TranscriptionError&&e.pauseModel&&!e.message.includes('private'));
    await assert.rejects(session.transcribe('two.wav'),e=>e instanceof TranscriptionError&&e.pauseModel);
  }finally {await session.close();}
});
test('local session enforces the response output limit',async()=>{
  const fixture=sessionFixture(`import {createInterface} from 'node:readline';
    process.stdout.write('{"available":true,"device":"cpu"}\\n');
    createInterface({input:process.stdin}).on('line',()=>process.stdout.write(JSON.stringify({text:'x'.repeat(1000)})+'\\n'));`,{maxBuffer:200});
  const session=await fixture.start();
  try {await assert.rejects(session.transcribe('one.wav'),e=>e instanceof TranscriptionError&&e.pauseModel);}
  finally {await session.close();}
});
test('local Whisper uses configured runtime and model without OpenAI',async()=>{
  let calls=0;
  const text=await transcribeSegment('faster-whisper','pt-BR','local-audio.wav',null,{
    localPythonPath:'local-python.exe',localModelPath:'cached-model',
    fetch:async()=>{throw new Error('local transcription must not use network');},
    localExec:async(command,args)=>{
      calls++;assert.equal(command,'local-python.exe');
      assert.ok(args.includes('cached-model'));assert.ok(args.includes('local-audio.wav'));
      assert.deepEqual(args.slice(args.indexOf('--language'),args.indexOf('--language')+2),['--language','pt']);
      return {stdout:'{"text":"  fala local  "}'};
    },
  });
  assert.equal(text,'fala local');assert.equal(calls,1);
  assert.deepEqual(localWhisperPaths({transcriptionLocalPythonPath:'py',transcriptionLocalModelPath:'model'}),
    {python:'py',modelPath:'model'});
});
test('local Whisper failure pauses the local model without network fallback',async()=>{
  await assert.rejects(transcribeSegment('faster-whisper','pt-BR','voice.wav','unused-cloud-key',{
    localPythonPath:'py',localModelPath:'model',localExec:async()=>{throw new Error('private path error');},
    fetch:async()=>{throw new Error('must not call OpenAI');},
  }),e=>e instanceof TranscriptionError && e.pauseModel && !e.message.includes('private path'));
});
test('GPT upload sends its real audio format and one language hint',async()=>{
  const f=audio();try{
    const text=await transcribeSegment('gpt-transcribe','pt-BR',f.path,'test-key',{fetch:async(_url,init)=>{
      const body=init!.body as FormData;assert.equal(body.get('languages[]'),'pt');
      const file=body.get('file') as File;assert.equal(file.name,'voice.ogg');assert.equal(file.type,'audio/ogg');
      return new Response(JSON.stringify({text:'fala'}));}});
    assert.equal(text,'fala');
  }finally{rmSync(f.dir,{recursive:true,force:true});}
});
test('GPT respects Retry-After and stops on exhausted quota',async()=>{
  const f=audio();try{
    let calls=0;const waits:number[]=[];
    await transcribeSegment('gpt-transcribe','pt-BR',f.path,'test-key',{random:()=>0,
      sleep:async ms=>{waits.push(ms);},fetch:async()=>++calls===1?
        new Response('{}',{status:429,headers:{'Retry-After':'3'}}):new Response('{"text":"ok"}')});
    assert.deepEqual(waits,[3000]);assert.equal(calls,2);
    calls=0;
    await assert.rejects(transcribeSegment('gpt-transcribe','pt-BR',f.path,'test-key',{fetch:async()=>{
      calls++;return new Response('{"error":{"code":"insufficient_quota"}}',{status:429});}}),
      e=>e instanceof TranscriptionError && e.pauseModel && !e.retryable);
    assert.equal(calls,1);
    await assert.rejects(transcribeSegment('gpt-transcribe','pt-BR',f.path,'test-key',{fetch:async()=>
      new Response('{}',{status:429,headers:{'Retry-After':'120'}})}),
      e=>e instanceof TranscriptionError && e.retryAfterSeconds===120);
  }finally{rmSync(f.dir,{recursive:true,force:true});}
});
