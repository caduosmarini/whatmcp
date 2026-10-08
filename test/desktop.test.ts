import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,statSync,mkdirSync,symlinkSync,existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn,execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { configSnapshot,saveSettings } from '../src/desktop/settings.ts';

const root=mkdtempSync(join(tmpdir(),'whatmcp-desktop-test-'));
function settings(){const folder=mkdtempSync(join(root,'settings-')),file=join(folder,'config.json');writeFileSync(file,JSON.stringify({openai_api_key:'fixture-secret',unknown:{preserve:true},http_port:8111}));return file;}
test('settings redact credentials and preserve unknown fields',()=>{const file=settings(),before=configSnapshot(file);assert.equal(before.keyConfigured,true);assert.equal(JSON.stringify(before).includes('fixture-secret'),false);const result=saveSettings(file,{transcription_batch_size:10},before.revision);assert.notEqual(result.revision,before.revision);const raw=JSON.parse(readFileSync(file,'utf8'));assert.deepEqual(raw.unknown,{preserve:true});assert.equal(raw.http_port,8111);assert.equal(raw.openai_api_key,'fixture-secret');if(process.platform!=='win32')assert.equal(statSync(file).mode&0o777,0o600);});
test('settings reject stale edits without replacing a changed file',()=>{const file=settings(),before=configSnapshot(file);writeFileSync(file,'{"external":true}');assert.throws(()=>saveSettings(file,{transcription_batch_size:5},before.revision),/changed elsewhere/);assert.equal(readFileSync(file,'utf8'),'{"external":true}');});
test('settings reject unsupported options, invalid sizes and Apple models on Windows',()=>{const file=settings(),revision=configSnapshot(file).revision;for(const patch of [{store:'/arbitrary'},{transcription_concurrency:9},{transcription_batch_size:0},{ffmpeg_path:'relative'}])assert.throws(()=>saveSettings(file,patch,revision));assert.throws(()=>saveSettings(file,{transcription_model:'apple-speech'},revision,'win32'),/macOS/);});

test('desktop archive commands and jobs work entirely with synthetic fixtures',async()=>{
  const home=join(root,'home'),profile=join(root,'demo');mkdirSync(home,{recursive:true});
  const child=spawn(process.execPath,['--experimental-sqlite','--experimental-strip-types','--no-warnings',fileURLToPath(new URL('../src/desktop/server.ts',import.meta.url))],{env:{...process.env,HOME:home,USERPROFILE:home,WHATMCP_HOME:profile,WHATMCP_DESKTOP_MODE:'demo',OPENAI_API_KEY:''},stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();let stderr='';child.stderr.on('data',b=>stderr+=b);
  async function request(method:string,params:unknown={}){child.stdin.write(JSON.stringify({method,params})+'\n');const line=await lines.next();assert.ok(line.value,stderr);return JSON.parse(line.value);}
  async function api(method:string,params:unknown={}){const r=await request(method,params);assert.equal(r.ok,true,r.error);return r.result;}
  async function job(kind:string,params:unknown={}){await api('start-job',{kind,...params as object});for(let i=0;i<120;i++){const s=await api('overview');if(s.jobs[0].state!=='running'){assert.equal(s.jobs[0].state,'done',s.jobs[0].detail);return s;}await new Promise(r=>setTimeout(r,50));}assert.fail('Fixture job timed out');}
  try{
    const before=await api('overview');assert.equal(before.demo,true);assert.equal(before.messages,14);assert.equal(before.audioPending,3);assert.equal(before.audioAvailable,2);assert.ok(before.pendingSegments>0);
    assert.equal((await request('execute',{command:'anything'})).ok,false);
    assert.equal((await request('search',{query:'x',limit:1000})).ok,false);
    const text=await api('search',{query:'pagamento',mode:'bm25'});assert.ok(text.hits.length>0);
    const semantic=await api('search',{query:'dinheiro',mode:'vector'});assert.ok(semantic.hits.length>0);assert.equal(semantic.demoSemantic,true);assert.ok(semantic.hits.some((h:any)=>!h.text.includes('dinheiro')));
    const first=await api('feed',{thread_id:'aurora',limit:2});assert.equal(first.messages.length,2);assert.equal(first.hasMore,true);const tail=first.messages.at(-1);const next=await api('feed',{thread_id:'aurora',limit:2,last:{ts:tail.ts,id:tail.id}});assert.equal(next.messages.some((m:any)=>m.id===tail.id),false);
    assert.ok((await api('media',{id:'demo-2'})).base64);assert.equal((await request('media',{id:'demo-13'})).ok,false);
    const targeted=await job('transcribe',{messageId:'demo-2'});assert.equal(targeted.audioPending,2);const audio=await api('audio');assert.equal(audio.find((a:any)=>a.id==='demo-2').done,1);assert.equal(audio.find((a:any)=>a.id==='demo-3').done,0);
    const indexed=await job('embed');assert.equal(indexed.pendingSegments,0);assert.deepEqual(await api('pending-windows'),[]);
    const synced=await job('sync');assert.equal(synced.messages,15);
    const cfg=await api('settings');assert.equal(JSON.stringify(cfg).includes('fixture-secret'),false);assert.equal((await request('save-settings',{revision:cfg.revision,patch:{openai_dims:1536}})).ok,false);
    assert.ok((await api('grant-capture')).expiresAt>Date.now());assert.equal((await api('revoke-capture')).expiresAt,0);
    await api('start-job',{kind:'embed'});assert.equal((await request('start-job',{kind:'sync'})).ok,false);await api('cancel-job');assert.equal((await api('overview')).jobs[0].state,'cancelled');
    const lock=new DatabaseSync(join(profile,'sync-lock.db'));lock.exec('BEGIN IMMEDIATE');
    await api('start-job',{kind:'sync'});let lockJob:any;for(let i=0;i<60;i++){lockJob=(await api('overview')).jobs[0];if(lockJob.state!=='running')break;await new Promise(r=>setTimeout(r,50));}assert.equal(lockJob.state,'failed');assert.match(lockJob.detail,/Another sync/);lock.exec('ROLLBACK');lock.close();
    await api('shutdown');
  }finally{child.stdin.end();await new Promise<void>(r=>child.once('close',()=>r()));}
});

test('macOS collector reads only a synthetic source and rejects expired and symlink paths',{skip:process.platform!=='darwin'||!process.env.WHATMCP_TEST_COLLECTOR},()=>{
  const binary=process.env.WHATMCP_TEST_COLLECTOR!,home=mkdtempSync(join(root,'source-')),group=join(home,'Library/Group Containers/group.net.whatsapp.WhatsApp.shared');mkdirSync(group,{recursive:true});
  const live=new DatabaseSync(join(group,'ChatStorage.sqlite'));live.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE fixture(id INTEGER);INSERT INTO fixture VALUES(42)');
  const source=readFileSync(join(group,'ChatStorage.sqlite'));
  const wal=readFileSync(join(group,'ChatStorage.sqlite-wal')),shm=readFileSync(join(group,'ChatStorage.sqlite-shm'));
  const request={sourceHome:home,output:join(root,'capture'),mediaOutput:join(root,'copied-media'),expiresAt:Date.now()+60_000};
  const receipt=JSON.parse(execFileSync(binary,[],{input:JSON.stringify(request),encoding:'utf8'}));assert.ok(receipt.snapshot);assert.deepEqual(readFileSync(join(group,'ChatStorage.sqlite')),source);
  const snapshot=new DatabaseSync(receipt.snapshot,{readOnly:true});assert.equal((snapshot.prepare('SELECT id FROM fixture').get() as any).id,42);snapshot.close();
  assert.throws(()=>execFileSync(binary,[],{input:JSON.stringify({...request,output:join(root,'expired'),expiresAt:Date.now()-1}),stdio:['pipe','pipe','pipe']}));
  // A source-side SQLite shared-memory file must never be created.
  assert.deepEqual(readFileSync(join(group,'ChatStorage.sqlite-wal')),wal);assert.deepEqual(readFileSync(join(group,'ChatStorage.sqlite-shm')),shm);live.close();
  const linked=join(root,'linked-output');symlinkSync(group,linked);assert.throws(()=>execFileSync(binary,[],{input:JSON.stringify({...request,output:linked}),stdio:['pipe','pipe','pipe']}));
});
