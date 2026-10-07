/** Opt-in native integration test: generated speech only, no live WhatsApp or cloud. */
import {execFileSync} from 'node:child_process';
import {availableModels} from '../src/transcription/models.ts';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIndex } from '../src/index/indexer.ts';
import { openStore } from '../src/db/index.ts';
import { runTranscription } from '../src/transcription/worker.ts';
import {getConversation} from '../src/search/search.ts';
import { type Config } from '../src/config.ts';

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


if (process.platform !== 'darwin' || !process.env.WHATMCP_HOME) {
  throw new Error('Use macOS with WHATMCP_HOME set to a new temporary directory; see docs/AUDIO.md');
}
const f = fixture();
try {

execFileSync('/usr/bin/say',['-v','Eddy (Portuguese (Brazil))','-o',join(f.dir,'phrase.aiff'),
  'Bom dia. A reunião sobre manutenção será amanhã às dez horas. Precisamos revisar o orçamento e falar com o síndico sobre o portão da garagem. Por favor, confirme se você pode participar da reunião. Obrigado.']);
execFileSync(f.cfg.ffmpegPath,['-hide_banner','-loglevel','error','-y','-i',join(f.dir,'phrase.aiff'),
  '-c:a','libopus',join(f.mediaRoot,'voice.ogg')]);
console.log('Fixture',f.dir);
const models=await availableModels(f.cfg);
console.log('Availability',JSON.stringify(models));
assert.equal(models.filter(m=>m.available && m.model!=='gpt-transcribe').length,2,
  'Both Apple pt-BR assets must already be installed; this test never downloads them');
for(const model of models.filter(m=>m.available && m.model!=='gpt-transcribe')) {
  const cfg={...f.cfg,transcriptionModel:model.model};
  const result=await runTranscription(cfg,{reprocess:true,onProgress:console.log});
  const db=openStore(f.store);
  const rows=db.prepare('SELECT model,status,text,error_code FROM audio_transcripts').all();
  const windows=db.prepare('SELECT id,text,content_hash FROM windows').all();
  const conversation=getConversation({storePath:f.store,embedCfg:{model:f.cfg.openaiModel,dimensions:f.cfg.openaiDims,apiKey:''}}, {thread_id:'123@s.whatsapp.net'});
  assert.match(conversation.find((m:any)=>m.kind==='audio')?.transcription_text ?? '', /orçamento/i);
  const hits=db.prepare("SELECT COUNT(*) n FROM windows_fts WHERE windows_fts MATCH 'orçamento'").get();
  db.close();
  console.log('Result',JSON.stringify({model:model.model,result,rows,windows,hits}));
  const again=await runTranscription(cfg);
  console.log('Idempotency',JSON.stringify(again));
  const check=openStore(f.store);
  assert.deepEqual(check.prepare('SELECT id,text,content_hash FROM windows').all(),windows);
  check.close();
  const recognized=rows.find((row:any)=>row.model===model.model) as any;
  assert.equal(recognized.status,'done');
  assert.match(recognized.text,/orçamento/i);
  assert.equal(result.failed,0);
  assert.equal(result.processed,1);
  assert.equal(again.processed,0);
  assert.equal(Number((hits as any).n),1);
}
console.log('Native audio smoke test passed');
} finally {rmSync(f.dir,{recursive:true,force:true});}
