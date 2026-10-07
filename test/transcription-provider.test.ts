import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {transcribeSegment,TranscriptionError} from '../src/transcription/models.ts';

function audio(){const dir=mkdtempSync(join(tmpdir(),'whatmcp-provider-'));const path=join(dir,'voice.ogg');writeFileSync(path,'audio');return {dir,path};}
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
