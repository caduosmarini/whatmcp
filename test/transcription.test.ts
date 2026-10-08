import { closeStores } from '../src/store.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIndex } from '../src/index/indexer.ts';
import { openStore } from '../src/db/index.ts';
import { runTranscription, importMediaManifest, inventoryAudio, refreshAudioMedia } from '../src/transcription/worker.ts';
import { resolveMediaPath, scanSourceMedia, hashFile } from '../src/transcription/media.ts';
import {getConversation,searchHybrid} from '../src/search/search.ts';
import {TRANSCRIPTION_REVISION} from '../src/transcription/identity.ts';
import {segmentBoundaries} from '../src/transcription/segments.ts';
import { reconcileProjectionModel, prepareReadyCandidates, publishCandidates } from '../src/transcription/projection.ts';
import { embedMissing } from '../src/index/embed.ts';
import { transcriptionLanguage, type Config } from '../src/config.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-audio-test-'));
  const mediaRoot = join(dir, 'media');
  mkdirSync(mediaRoot);
  writeFileSync(join(mediaRoot, 'voice.ogg'), 'fake audio bytes');
  const source = join(dir, 'source.sqlite');
  const db = new DatabaseSync(source);
  db.exec(`
    CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZCONTACTJID TEXT, ZPARTNERNAME TEXT);
    CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, ZMEMBERJID TEXT, ZCONTACTNAME TEXT);
    CREATE TABLE ZWAPROFILEPUSHNAME (ZJID TEXT, ZPUSHNAME TEXT);
    CREATE TABLE ZWAMEDIAITEM (Z_PK INTEGER PRIMARY KEY, ZMEDIALOCALPATH TEXT);
    CREATE TABLE ZWAMESSAGE (
      Z_PK INTEGER PRIMARY KEY, ZSTANZAID TEXT, ZISFROMME INTEGER, ZMESSAGETYPE INTEGER,
      ZTEXT TEXT, ZMESSAGEDATE REAL, ZCHATSESSION INTEGER, ZGROUPMEMBER INTEGER,
      ZPARENTMESSAGE INTEGER, ZMEDIAITEM INTEGER
    );
    INSERT INTO ZWACHATSESSION VALUES (1, '123@s.whatsapp.net', 'Ana');
    INSERT INTO ZWAMEDIAITEM VALUES (1, 'voice.ogg');
  `);
  const add = db.prepare('INSERT INTO ZWAMESSAGE VALUES (?,?,?,?,?,?,?,?,?,?)');
  const apple = (unix: number) => unix - 978307200;
  add.run(1, 'before', 0, 0, 'antes', apple(1_700_000_000), 1, null, null, null);
  add.run(2, 'voice', 0, 3, 'legenda', apple(1_700_000_001), 1, null, null, 1);
  add.run(3, 'after', 0, 0, 'depois', apple(1_700_000_002), 1, null, null, null);
  db.close();
  const store = join(dir, 'archive.sqlite');
  runIndex(store, { chatstorage: '', snapshotPath: source, mediaSourceId: 'import' });
  const cfg: Config = {
    store, chatstorage: source, openaiKey: null, openaiModel: 'text-embedding-3-small',
    openaiDims: 1536, syncIntervalHours: 0, transcriptionModel: 'apple-speech',
    transcriptionDefaultLanguage: 'pt-BR', mediaSourceId: 'import', mediaRoots: { import: mediaRoot },
    ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe',
  };
  return { dir, source, store, mediaRoot, cfg };
}

function mockOptions(transcribe: (n: number) => string | Promise<string>) {
  let n = 0;
  return {
    duration: async () => 601,
    convert: async (_cfg: Config, _src: string, _segment: number, dest: string) => {
      writeFileSync(dest, 'wav');
    },
    transcribe: async () => transcribe(n++),
  };
}

test('local worker reuses one persistent session across segments and closes it',async()=>{
  const f=fixture();let launches=0,requests=0,closes=0;
  try {
    const options=mockOptions(()=> 'unused');
    const {transcribe,...conversion}=options;
    const result=await runTranscription({...f.cfg,transcriptionModel:'faster-whisper'},{...conversion,
      localSessionFactory:async()=>{
        launches++;return {device:'cuda',transcribe:async()=>`local segment ${++requests}`,
          close:async()=>{closes++;}};
      },
    });
    assert.equal(result.processed,1);assert.equal(result.failed,0);
    assert.equal(launches,1);assert.equal(requests,2);assert.equal(closes,1);
    const db=openStore(f.store);
    assert.equal((db.prepare("SELECT text FROM audio_transcripts WHERE status='done'").get() as any).text,
      'local segment 1 local segment 2');db.close();
  }finally {rmSync(f.dir,{recursive:true,force:true});}
});

test('local worker closes a failed session and preserves completed segments',async()=>{
  const f=fixture();let requests=0,closes=0;
  try {
    const options=mockOptions(()=> 'unused');const {transcribe,...conversion}=options;
    const {TranscriptionError}=await import('../src/transcription/models.ts');
    const result=await runTranscription({...f.cfg,transcriptionModel:'faster-whisper'},{...conversion,
      localSessionFactory:async()=>({device:'cpu',transcribe:async()=>{
        if(requests++===0)return 'saved local words';
        throw new TranscriptionError('local inference failed',true,true);
      },close:async()=>{closes++;}}),
    });
    assert.equal(result.failed,1);assert.equal(closes,1);
    const db=openStore(f.store);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM transcript_segments').get() as any).n,1);
    assert.equal((db.prepare('SELECT status FROM audio_transcripts').get() as any).status,'retryable_error');
    db.close();
  }finally {rmSync(f.dir,{recursive:true,force:true});}
});

test('audio enters its chronological position; re-running keeps the same windows', async () => {
  const f = fixture();
  try {
    const result = await runTranscription(f.cfg, mockOptions((n) => ['fala um', 'fala dois'][n]));
    assert.equal(result.processed, 1);
    assert.equal(result.published, 1);
    const db = openStore(f.store);
    const first = db.prepare('SELECT id, text, content_hash FROM windows').all() as
      { id: number; text: string; content_hash: string }[];
    assert.equal(first.length, 1);
    assert.match(first[0].text, /antes.*legenda Áudio transcrito: fala um fala dois.*depois/s);
    assert.equal(Number((db.prepare('SELECT COUNT(*) n FROM window_message_parts').get() as any).n), 3);
    assert.equal(Number((db.prepare("SELECT COUNT(*) n FROM windows_fts WHERE windows_fts MATCH 'fala'").get() as any).n), 1);
    db.close();
    const again = await runTranscription(f.cfg, mockOptions(() => { throw new Error('duplicate work'); }));
    assert.equal(again.processed, 0);
    const check = openStore(f.store);
    assert.deepEqual(check.prepare('SELECT id, text, content_hash FROM windows').all(), first);
    check.close();
  } finally { closeStores();rmSync(f.dir, { recursive: true, force: true }); }
});

test('saved segments survive failure and resume without retranscribing', async () => {
  const f = fixture();
  try {
    const first = await runTranscription(f.cfg, mockOptions((n) => {
      if (n === 1) throw new Error('temporary model failure');
      return 'first segment';
    }));
    assert.equal(first.failed, 1);
    const db = openStore(f.store);
    assert.equal(Number((db.prepare('SELECT COUNT(*) n FROM transcript_segments').get() as any).n), 1);
    assert.equal(Number((db.prepare('SELECT COUNT(*) n FROM active_transcripts').get() as any).n), 0);
    db.exec("UPDATE audio_transcripts SET status = 'processing', lease_until = 1");
    db.close();
    let calls = 0;
    const second = await runTranscription(f.cfg, mockOptions(() => { calls++; return 'second segment'; }));
    assert.equal(second.processed, 1);
    assert.equal(calls, 1);
    const check = openStore(f.store);
    assert.equal((check.prepare('SELECT text FROM audio_transcripts WHERE status = ?').get('done') as any).text,
      'first segment second segment');
    check.close();
  } finally { closeStores();rmSync(f.dir, { recursive: true, force: true }); }
});

test('model switch retains old active windows until the new result is complete', async () => {
  const f = fixture();
  try {
    await runTranscription(f.cfg, mockOptions(() => 'old model'));
    const db = openStore(f.store);
    const old = (db.prepare('SELECT text FROM windows').get() as any).text;
    db.close();
    const switched = { ...f.cfg, transcriptionModel: 'apple-dictation' as const };
    const failed = await runTranscription(switched, {...mockOptions(() => {throw new Error('retry');}),reprocess:true});
    assert.equal(failed.published, 1);
    const interim = openStore(f.store);
    assert.equal((interim.prepare('SELECT text FROM windows').get() as any).text, old);
    interim.close();
    const done = await runTranscription(switched, mockOptions(() => 'new model'));
    assert.equal(done.published, 1);
    const final = openStore(f.store);
    assert.match((final.prepare('SELECT text FROM windows').get() as any).text, /new model/);
    assert.equal((final.prepare('SELECT model FROM active_transcripts').get() as any).model,
      'apple-dictation');
    final.close();
  } finally { closeStores();rmSync(f.dir, { recursive: true, force: true }); }
});

test('vector-pending state clears only after the published window hashes have vectors', async () => {
  const f = fixture();
  try {
    await runTranscription(f.cfg, mockOptions(() => 'spoken text'));
    const db = openStore(f.store);
    assert.equal((db.prepare('SELECT status FROM thread_projection_state').get() as any).status,
      'vectors_pending');
    const hashes = db.prepare('SELECT DISTINCT content_hash FROM windows').all() as
      { content_hash: string }[];
    for (const row of hashes) db.prepare(`INSERT INTO window_vectors
      (content_hash, model, dim, created_at, vec) VALUES (?, ?, ?, ?, ?)`)
      .run(row.content_hash, 'openai/text-embedding-3-small@1536', 1536, 0,
        new Uint8Array(1536 * 4));
    db.close();
    await embedMissing(f.store, { model: 'text-embedding-3-small', dimensions: 1536,
      apiKey: 'not-used' });
    const check = openStore(f.store);
    assert.equal((check.prepare('SELECT status FROM thread_projection_state').get() as any).status,
      'current');
    check.close();
  } finally { closeStores();rmSync(f.dir, { recursive: true, force: true }); }
});

test('permanent model errors require an explicit retry after correction', async () => {
  const f = fixture();
  try {
    const failed = await runTranscription(f.cfg, mockOptions(() => {
      throw new Error('model unavailable');
    }));
    assert.equal(failed.failed, 1);
    const db = openStore(f.store);
    db.exec("UPDATE audio_transcripts SET status = 'permanent_error'");
    db.close();
    const skipped = await runTranscription(f.cfg, mockOptions(() => {
      throw new Error('must not retry automatically');
    }));
    assert.equal(skipped.processed, 0);
    assert.equal(skipped.failed, 0);
    const retried = await runTranscription(f.cfg, {
      ...mockOptions(() => 'works after correction'), retryErrors: true,
    });
    assert.equal(retried.processed, 1);
  } finally { closeStores();rmSync(f.dir, { recursive: true, force: true }); }
});

test('explicit Windows-style manifest links only known messages and paths stay within root', () => {
  const f = fixture();
  try {
    const db = openStore(f.store);
    const manifest = join(f.dir, 'manifest.json');
    writeFileSync(manifest, JSON.stringify([
      { message_id: '123@s.whatsapp.net:voice', relative_path: 'voice.ogg' },
      { message_id: 'unknown', relative_path: 'voice.ogg' },
      { message_id: '123@s.whatsapp.net:voice', relative_path: '../escape.ogg' },
    ]));
    assert.deepEqual(importMediaManifest(db, 'import', f.mediaRoot, manifest),
      { imported: 0, rejected: 2 });
    db.close();
    assert.throws(() => resolveMediaPath(f.mediaRoot, '../escape.ogg'));
    const outside = join(f.dir, 'outside.ogg');
    writeFileSync(outside, 'bytes');
    symlinkSync(outside, join(f.mediaRoot, 'link.ogg'));
    assert.throws(() => resolveMediaPath(f.mediaRoot, 'link.ogg'));
  } finally { closeStores();rmSync(f.dir, { recursive: true, force: true }); }
});

test('one default language supports canonical tags and the legacy setting', () => {
  assert.equal(transcriptionLanguage({}), 'pt-BR');
  assert.equal(transcriptionLanguage({transcription_locale: 'en_US'}), 'en-US');
  assert.equal(transcriptionLanguage({transcription_default_language: 'es-es', transcription_locale: 'pt-BR'}), 'es-ES');
  assert.throws(() => transcriptionLanguage({transcription_default_language: 'pt,en'}));
  assert.throws(() => transcriptionLanguage({transcription_default_language: ['pt', 'en'] as any}));
});

test('returning to a cached language republishes its transcript', async () => {
  const f = fixture();
  try {
    await runTranscription(f.cfg, mockOptions(() => 'português'));
    await runTranscription({...f.cfg, transcriptionDefaultLanguage: 'en-US'}, {...mockOptions(() => 'English'),reprocess:true});
    const result = await runTranscription(f.cfg, mockOptions(() => { throw new Error('cached'); }));
    assert.equal(result.processed, 0);
    const db = openStore(f.store);
    assert.equal((db.prepare('SELECT locale FROM active_transcripts').get() as any).locale, 'pt-BR');
    db.close();
  } finally { closeStores();rmSync(f.dir, {recursive:true,force:true}); }
});

test('incremental media scan discovers paths added or changed below the watermark', () => {
  const f = fixture();
  try {
    const source = new DatabaseSync(f.source);
    source.exec('UPDATE ZWAMEDIAITEM SET ZMEDIALOCALPATH=NULL');
    const db = openStore(f.store);
    db.exec('DELETE FROM audio_media; DELETE FROM audio_media_sources');
    assert.equal(scanSourceMedia(db, f.source, 'import', 3), 0);
    source.exec("UPDATE ZWAMEDIAITEM SET ZMEDIALOCALPATH='voice.ogg'");
    assert.equal(scanSourceMedia(db, f.source, 'import', 3), 1);
    assert.equal(scanSourceMedia(db, f.source, 'import', 3), 0);
    source.exec("UPDATE ZWAMEDIAITEM SET ZMEDIALOCALPATH='new.ogg'");
    assert.equal(scanSourceMedia(db, f.source, 'import', 3), 1);
    assert.equal((db.prepare('SELECT relative_path FROM audio_media').get() as any).relative_path, 'new.ogg');
    source.close(); db.close();
  } finally { closeStores();rmSync(f.dir,{recursive:true,force:true}); }
});

function addAudio(f: ReturnType<typeof fixture>, id: string, bytes = 'different bytes') {
  const path = `${id}.ogg`;
  writeFileSync(join(f.mediaRoot,path), bytes);
  const db = openStore(f.store);
  db.prepare(`INSERT INTO messages(id,thread_id,ts,kind,is_from_me,first_seen_at)
    VALUES (?, '123@s.whatsapp.net', 1700000003, 'audio',0,0)`).run(`123@s.whatsapp.net:${id}`);
  db.prepare('INSERT INTO audio_media(message_id,source_id,relative_path) VALUES (?,?,?)')
    .run(`123@s.whatsapp.net:${id}`,'import',path);
  db.close();
}

test('one failed audio does not block usable transcripts from the same conversation', async () => {
  const f = fixture();
  try {
    addAudio(f,'broken');
    let n = 0;
    const result = await runTranscription(f.cfg, {duration: async () => 1,
      convert: mockOptions(() => '').convert,
      transcribe: async () => {if(n++ === 0) return 'usable spoken words'; throw new Error('broken');}});
    assert.equal(result.processed,1);
    const db = openStore(f.store);
    assert.match((db.prepare('SELECT text FROM windows').get() as any).text,/usable spoken words/);
    assert.equal((db.prepare('SELECT pending_audio FROM thread_projection_state').get() as any).pending_audio,1);
    assert.equal((db.prepare('SELECT status FROM thread_projection_state').get() as any).status,'partial');
    db.close();
  } finally {closeStores();rmSync(f.dir,{recursive:true,force:true});}
});

test('disabling processing and projecting keeps archived transcripts searchable', async () => {
  const f = fixture();
  try {
    await runTranscription(f.cfg,mockOptions(() => 'archived words'));
    const db = openStore(f.store);
    const before=db.prepare('SELECT text,content_hash FROM windows').all();
    const disabled={...f.cfg,transcriptionModel:null};
    reconcileProjectionModel(db,null);
    prepareReadyCandidates(db,disabled);publishCandidates(db,disabled);
    assert.deepEqual(db.prepare('SELECT text,content_hash FROM windows').all(),before);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM active_transcripts').get() as any).n,1);
    db.close();
  } finally {closeStores();rmSync(f.dir,{recursive:true,force:true});}
});

test('unchanged files skip hashing and forwarded audio shares the content cache', async () => {
  const f=fixture();
  try {
    addAudio(f,'forwarded','fake audio bytes');
    let calls=0,hashes=0;
    const options={duration:async()=>1,convert:mockOptions(()=> '').convert,
      transcribe:async()=>{calls++;return 'shared transcript';},
      hash:async(path:string)=>{hashes++;return hashFile(path);}};
    const first=await runTranscription(f.cfg,options);
    assert.equal(first.processed,2);assert.equal(first.reused,1);assert.equal(calls,1);assert.equal(hashes,2);
    await runTranscription(f.cfg,options);
    assert.equal(hashes,2);assert.equal(calls,1);
    await runTranscription(f.cfg,{...options,verifyFiles:true});
    assert.equal(hashes,4);assert.equal(calls,1);
  } finally {closeStores();rmSync(f.dir,{recursive:true,force:true});}
});

test('changing defaults preserves old work until historical reprocessing is requested', async () => {
  const f=fixture();
  try {
    await runTranscription(f.cfg,mockOptions(()=> 'old engine'));
    const cfg={...f.cfg,transcriptionModel:'apple-dictation' as const};
    const unchanged=await runTranscription(cfg,mockOptions(()=>{throw new Error('unrequested');}));
    assert.equal(unchanged.processed,0);
    const db=openStore(f.store);
    assert.equal((db.prepare('SELECT model FROM active_transcripts').get() as any).model,'apple-speech');db.close();
    const changed=await runTranscription(cfg,{...mockOptions(()=> 'new engine'),reprocess:true});
    assert.equal(changed.processed,1);
  } finally {closeStores();rmSync(f.dir,{recursive:true,force:true});}
});

test('publication occurs during a long batch and new file bytes are retranscribed', async () => {
  const f=fixture();
  try {
    for(let i=0;i<26;i++) addAudio(f,`voice-${i}`,`bytes-${i}`);
    let calls=0;
    await runTranscription(f.cfg,{duration:async()=>1,convert:mockOptions(()=> '').convert,
      transcribe:async()=>{
        if(++calls===26){const db=openStore(f.store);
          assert.match((db.prepare('SELECT text FROM windows LIMIT 1').get() as any).text,/published/);db.close();}
        return 'published';}});
    writeFileSync(join(f.mediaRoot,'voice.ogg'),'new content of different size');
    const result=await runTranscription(f.cfg,{duration:async()=>1,convert:mockOptions(()=> '').convert,transcribe:async()=> 'changed content'});
    assert.equal(result.processed,1);
  } finally {closeStores();rmSync(f.dir,{recursive:true,force:true});}
});

test('segment planning uses silence near boundaries without gaps or overlaps',()=>{
  assert.deepEqual(segmentBoundaries(1220,[590,1190]),[{start:0,end:590},{start:590,end:1190},{start:1190,end:1220}]);
});
test('GPT sends a supported short source directly and stores a reproducible segment plan',async()=>{
  const f=fixture();try{
    let conversions=0;
    await runTranscription({...f.cfg,transcriptionModel:'gpt-transcribe'}, {
      duration:async()=>20,convert:async()=>{conversions++;},
      transcribe:async(_m,_l,path)=>{assert.equal(path.endsWith('.ogg'),true);return 'direct upload';}});
    assert.equal(conversions,0);
    const db=openStore(f.store);
    const t=db.prepare('SELECT segment_plan,model_revision FROM audio_transcripts').get() as any;
    assert.equal(t.model_revision,TRANSCRIPTION_REVISION);
    assert.deepEqual(JSON.parse(t.segment_plan),[{start:0,end:20}]);db.close();
  }finally{closeStores();rmSync(f.dir,{recursive:true,force:true});}
});

test('cloud concurrency is bounded, deduplicates forwards and respects the batch limit',async()=>{
  const f=fixture();try{
    addAudio(f,'forwarded','fake audio bytes');addAudio(f,'other','another audio');addAudio(f,'third','third audio');
    let inFlight=0,max=0,calls=0;
    const cfg={...f.cfg,transcriptionModel:'gpt-transcribe' as const,transcriptionConcurrency:2};
    const adapter={duration:async()=>1,transcribe:async()=>{
      calls++;max=Math.max(max,++inFlight);await new Promise(r=>setTimeout(r,5));inFlight--;return 'cloud words';}};
    const first=await runTranscription(cfg,{...adapter,limit:1});
    assert.equal(first.processed,1);assert.equal(calls,1);
    const next=await runTranscription(cfg,adapter);
    assert.equal(next.processed,3);assert.equal(next.reused,1);assert.equal(calls,3);assert.equal(max,2);
  }finally{closeStores();rmSync(f.dir,{recursive:true,force:true});}
});

test('identical words from a different engine retain their embedding hash and expose provenance',async()=>{
  const f=fixture();try{
    await runTranscription(f.cfg,mockOptions(()=> 'same words'));
    const db=openStore(f.store);const before=db.prepare('SELECT content_hash FROM windows').all();db.close();
    await runTranscription({...f.cfg,transcriptionModel:'apple-dictation'}, {...mockOptions(()=> 'same words'),reprocess:true});
    const next=openStore(f.store);assert.deepEqual(next.prepare('SELECT content_hash FROM windows').all(),before);next.close();
    const msgs=getConversation({storePath:f.store,embedCfg:{model:f.cfg.openaiModel,dimensions:1536,apiKey:'unused'}},{thread_id:'123@s.whatsapp.net'});
    const voice=msgs.find(m=>m.kind==='audio')!;
    assert.equal(voice.transcription_model,'apple-dictation');assert.equal(voice.transcription_language,'pt-BR');
  }finally{closeStores();rmSync(f.dir,{recursive:true,force:true});}
});
test('failed audio state and valid transcript are visible through conversation reads and FTS',async()=>{
  const f=fixture();try{
    addAudio(f,'broken');let n=0;
    await runTranscription(f.cfg,{duration:async()=>1,convert:mockOptions(()=> '').convert,transcribe:async()=>{
      if(n++===0)return 'localizar reunião';throw new Error('failed');}});
    const ctx={storePath:f.store,embedCfg:{model:f.cfg.openaiModel,dimensions:1536,apiKey:'unused'}};
    const msgs=getConversation(ctx,{thread_id:'123@s.whatsapp.net'});
    assert.equal(msgs.find(m=>m.id.endsWith(':broken'))?.transcription_status,'retryable_error');
    assert.equal((await searchHybrid(ctx,{query:'reunião',mode:'bm25'})).hits.length,1);
  }finally{closeStores();rmSync(f.dir,{recursive:true,force:true});}
});

test('partial vector coverage is reported when only some published windows have embeddings',async()=>{
  const f=fixture();const original=globalThis.fetch;
  try {
    await runTranscription(f.cfg,{...mockOptions(()=> 'reunião '.repeat(700))});
    const db=openStore(f.store);
    const rows=db.prepare('SELECT content_hash FROM windows').all() as {content_hash:string}[];
    assert.ok(rows.length>1);
    const vector=new Float32Array(1536);vector[0]=1;
    db.prepare('INSERT INTO window_vectors(content_hash,model,dim,created_at,vec) VALUES (?, ?,1536,0,?)')
      .run(rows[0].content_hash,'openai/text-embedding-3-small@1536',new Uint8Array(vector.buffer));db.close();
    globalThis.fetch=async()=>new Response(JSON.stringify({data:[{index:0,embedding:Array.from(vector)}],usage:{total_tokens:1}}));
    const result=await searchHybrid({storePath:f.store,embedCfg:{model:f.cfg.openaiModel,dimensions:1536,apiKey:'test'}},{query:'reunião'});
    assert.match(result.degraded!,/coverage is incomplete/);assert.ok(result.hits.length);
  }finally{globalThis.fetch=original;closeStores();rmSync(f.dir,{recursive:true,force:true});}
});

test('completed audio has zero pending inference cost in setup inventory',async()=>{
  const f=fixture();try{
    await runTranscription(f.cfg,mockOptions(()=> 'completed'));
    const stats=await inventoryAudio({...f.cfg,transcriptionModel:'gpt-transcribe'});
    assert.equal(stats.available,1);assert.equal(stats.pending,0);assert.equal(stats.estimatedCostUSD,0);
    addAudio(f,'forwarded','fake audio bytes');
    const cache=await inventoryAudio(f.cfg);
    assert.equal(cache.pending,1);assert.equal(cache.reused,1);assert.equal(cache.estimatedSeconds,0);
  }finally{closeStores();rmSync(f.dir,{recursive:true,force:true});}
});

test('a cooldown survives restart and prevents immediate provider retries',async()=>{
  const f=fixture();try{
    const {TranscriptionError}=await import('../src/transcription/models.ts');
    let calls=0;
    const options={duration:async()=>1,convert:mockOptions(()=> '').convert,transcribe:async()=>{
      calls++;throw new TranscriptionError('rate limit',true,true,120);}};
    assert.equal((await runTranscription(f.cfg,options)).failed,1);
    assert.equal((await runTranscription(f.cfg,options)).failed,0);assert.equal(calls,1);
  }finally{closeStores();rmSync(f.dir,{recursive:true,force:true});}
});
test('interrupted reprocessing remains queued after restart without the flag',async()=>{
  const f=fixture();try{
    addAudio(f,'second');
    await runTranscription(f.cfg,{duration:async()=>1,convert:mockOptions(()=> '').convert,transcribe:async()=> 'old words'});
    const cfg={...f.cfg,transcriptionModel:'apple-dictation' as const};
    const first=await runTranscription(cfg,{duration:async()=>1,convert:mockOptions(()=> '').convert,transcribe:async()=> 'new words',limit:1,reprocess:true});
    assert.equal(first.processed,1);
    const second=await runTranscription(cfg,{duration:async()=>1,convert:mockOptions(()=> '').convert,transcribe:async()=> 'new words'});
    assert.equal(second.processed,1);
    const db=openStore(f.store);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM active_transcripts WHERE model='apple-dictation'").get() as any).n,2);db.close();
  }finally{closeStores();rmSync(f.dir,{recursive:true,force:true});}
});
test('a new text sync keeps published transcripts while audio replacement is pending',async()=>{
  const f=fixture();try{
    await runTranscription(f.cfg,mockOptions(()=> 'preserved words'));
    const source=new DatabaseSync(f.source);
    source.prepare('INSERT INTO ZWAMESSAGE VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(4,'new-text',0,0,'texto novo',1700000004-978307200,1,null,null,null);source.close();
    runIndex(f.store,{chatstorage:'',snapshotPath:f.source,mediaSourceId:'import'});
    const db=openStore(f.store);const text=(db.prepare('SELECT text FROM windows').get() as any).text;
    assert.match(text,/preserved words/);assert.match(text,/texto novo/);db.close();
  }finally{closeStores();rmSync(f.dir,{recursive:true,force:true});}
});


test('inventory does not overwrite a media reference replaced by concurrent sync', async () => {
  const f = fixture();
  const db = openStore(f.store);
  try {
    await refreshAudioMedia(db, f.cfg, {hash: async () => {
      db.prepare("UPDATE audio_media SET relative_path='replacement.ogg',sha256=NULL WHERE message_id=?")
        .run('123@s.whatsapp.net:voice');
      return 'old-content-hash';
    }});
    const row = db.prepare('SELECT relative_path,sha256 FROM audio_media').get() as any;
    assert.equal(row.relative_path, 'replacement.ogg');
    assert.equal(row.sha256, null);
  } finally {db.close();rmSync(f.dir,{recursive:true,force:true});}
});


test('an empty replacement cannot remove usable words for identical audio bytes', async () => {
  const f=fixture();
  try {
    await runTranscription(f.cfg,mockOptions(()=> 'palavras reconhecidas'));
    const replaced=await runTranscription({...f.cfg,transcriptionModel:'apple-dictation'},
      {...mockOptions(()=>''),reprocess:true});
    assert.equal(replaced.noSpeech,1);
    const db=openStore(f.store);
    assert.match((db.prepare('SELECT text FROM windows').get() as any).text,/palavras reconhecidas/);
    assert.equal((db.prepare('SELECT model FROM active_transcripts').get() as any).model,'apple-speech');
    assert.equal((db.prepare("SELECT status FROM audio_transcripts WHERE model='apple-dictation'").get() as any).status,'no_speech');
    db.close();
  } finally {closeStores();rmSync(f.dir,{recursive:true,force:true});}
});
