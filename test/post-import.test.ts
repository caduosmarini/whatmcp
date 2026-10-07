import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { Config } from '../src/config.ts';
import { openStore } from '../src/db/index.ts';
import { processImportedArchive } from '../src/index/post-import.ts';

const audioResult = { processed: 150, noSpeech: 0, reused: 0, unavailable: 0,
  failed: 0, prepared: 1, published: 0 };
const embedResult = { embedded: 0, failed: 0, skipped: 0, pending: 0,
  truncated: 0, tokens: 0, costUSD: 0, elapsedMs: 0 };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-post-import-'));
  const store = join(dir, 'archive.db');
  openStore(store).close();
  const cfg: Config = { store, chatstorage: join(dir, 'source.db'), sourceType: 'chatstorage',
    windowsWaren6Path: null, windowsOutputDir: dir, openaiKey: 'offline-test-only',
    openaiModel: 'text-embedding-3-small', openaiDims: 1536, syncIntervalHours: 0,
    transcriptionModel: 'gpt-transcribe', transcriptionAutoAfterImport: true };
  return { dir, cfg, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('automatic post-import transcribes every pending audio before embedding and calibrating', async () => {
  const f = fixture();
  try {
    const calls: string[] = [];
    await processImportedArchive(f.cfg, {
      transcribe: async (cfg, options) => {
        assert.equal(cfg, f.cfg);
        assert.equal(options?.limit, Infinity, 'automatic imports must not stop at the CLI default of 100');
        assert.equal(options?.reprocess, undefined);
        assert.equal(options?.retryErrors, undefined);
        calls.push('transcribe');
        return audioResult;
      },
      embed: async (store) => { assert.equal(store, f.cfg.store); calls.push('embed'); return embedResult; },
      calibrate: async (_, count) => { assert.equal(count, 0); calls.push('calibrate'); },
    });
    assert.deepEqual(calls, ['transcribe', 'embed', 'calibrate']);
  } finally { f.cleanup(); }
});

test('post-import audio remains opt-in while normal embedding still runs', async () => {
  const f = fixture();
  try {
    f.cfg.transcriptionAutoAfterImport = false;
    let embedded = false;
    await processImportedArchive(f.cfg, {
      transcribe: async () => { assert.fail('audio must not run without opt-in'); },
      embed: async () => { embedded = true; return embedResult; },
    });
    assert.equal(embedded, true);
  } finally { f.cleanup(); }
});

for (const mode of ['reported', 'thrown'] as const) {
  test(`post-import ${mode} audio failure still embeds successful work and then reports failure`, async () => {
    const f = fixture();
    try {
      const calls: string[] = [];
      await assert.rejects(processImportedArchive(f.cfg, {
        transcribe: async () => {
          calls.push('transcribe');
          if (mode === 'thrown') throw new Error('offline provider unavailable');
          return { ...audioResult, failed: 2 };
        },
        embed: async () => { calls.push('embed'); return embedResult; },
      }), mode === 'thrown' ? /offline provider unavailable/ : /2 audio transcription\(s\) failed/);
      assert.deepEqual(calls, ['transcribe', 'embed']);
    } finally { f.cleanup(); }
  });
}

function sourceFixture(dir: string): string {
  const path = join(dir, 'unified_whatsapp.db');
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE messages(msg_id TEXT,chat_jid TEXT,chat_name TEXT,sender_jid TEXT,sender_name TEXT,from_me INTEGER,timestamp INTEGER,text TEXT,is_group INTEGER,msg_type TEXT)');
    db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('new', '123@s.whatsapp.net', 'Fixture', null, null, 0, 1700000000, 'offline import', 0, 'chat');
  } finally { db.close(); }
  return path;
}

function cliImport(dir: string, source: string, args: string[]) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('WHATMCP_') || key === 'OPENAI_API_KEY') delete env[key];
  }
  env.WHATMCP_HOME = dir;
  return spawnSync(process.execPath, ['--experimental-sqlite', '--experimental-strip-types', '--no-warnings',
    resolve(import.meta.dirname, '../src/cli.ts'), 'import-windows', source, '--json', ...args],
  { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
}

test('manual import-windows --json preserves the final JSON result', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'config.json'), JSON.stringify({ store: f.cfg.store,
      transcription_auto_after_import: true, transcription_model: null }));
    const result = cliImport(f.dir, sourceFixture(f.dir), []);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split(/\r?\n/);
    assert.ok(lines.some(line => line.includes('embedding skipped: no OpenAI key')));
    assert.equal(JSON.parse(lines.at(-1)!).added, 1);
  } finally { f.cleanup(); }
});

test('internal import-only bypasses held parent sync lock and automatic audio uploads', () => {
  const f = fixture();
  let lock: DatabaseSync | undefined;
  try {
    writeFileSync(join(f.dir, 'config.json'), JSON.stringify({ store: f.cfg.store,
      transcription_auto_after_import: true, transcription_model: 'gpt-transcribe' }));
    const source = sourceFixture(f.dir);
    lock = new DatabaseSync(join(f.dir, 'sync-lock.db'));
    lock.exec('BEGIN IMMEDIATE');
    const result = cliImport(f.dir, source, ['--import-only']);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 1, 'internal import must not print audio or embedding progress');
    assert.equal(JSON.parse(lines[0]).added, 1);
  } finally {
    if (lock) { lock.exec('ROLLBACK'); lock.close(); }
    f.cleanup();
  }
});

 test('scheduled final sync embeds without a second automatic transcription pass', async () => {
  const f = fixture();
  try {
    let embedded = false;
    await processImportedArchive(f.cfg, {
      skipTranscription: true,
      transcribe: async () => { assert.fail('scheduled batch already transcribed'); },
      embed: async () => { embedded = true; return embedResult; },
    });
    assert.equal(embedded, true);
  } finally { f.cleanup(); }
});

test('scheduled index-only capture skips automatic audio and embedding calls', () => {
  const f = fixture();
  try {
    const source = join(f.dir, 'ChatStorage.sqlite');
    const db = new DatabaseSync(source);
    db.exec(`CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY,ZCONTACTJID TEXT,ZPARTNERNAME TEXT);
      CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY,ZMEMBERJID TEXT,ZCONTACTNAME TEXT);
      CREATE TABLE ZWAPROFILEPUSHNAME (ZJID TEXT,ZPUSHNAME TEXT);
      CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY,ZSTANZAID TEXT,ZISFROMME INTEGER,
        ZMESSAGETYPE INTEGER,ZTEXT TEXT,ZMESSAGEDATE REAL,ZCHATSESSION INTEGER,
        ZGROUPMEMBER INTEGER,ZPARENTMESSAGE INTEGER);
      INSERT INTO ZWACHATSESSION VALUES(1,'123@s.whatsapp.net','Fixture');
      INSERT INTO ZWAMESSAGE VALUES(1,'fresh',0,0,'fresh message',700000000,1,NULL,NULL);`);
    db.close();
    writeFileSync(join(f.dir,'config.json'),JSON.stringify({store:f.cfg.store,chatstorage:source,
      transcription_auto_after_import:true,transcription_model:'gpt-transcribe',
      openai_api_key:'offline-test-only'}));
    const env={...process.env};
    for(const key of Object.keys(env))if(key.startsWith('WHATMCP_')||key==='OPENAI_API_KEY')delete env[key];
    env.WHATMCP_HOME=f.dir;
    const result=spawnSync(process.execPath,['--experimental-sqlite','--experimental-strip-types','--no-warnings',
      resolve(import.meta.dirname,'../src/cli.ts'),'sync-worker','--index-only'],
      {env,encoding:'utf8',timeout:30000,windowsHide:true});
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/processing deferred/);
    assert.doesNotMatch(result.stdout,/transcribing pending|embedding pending/);
    const archive=new DatabaseSync(f.cfg.store,{readOnly:true});
    try{assert.equal(archive.prepare('SELECT COUNT(*) n FROM messages').get().n,1);}
    finally{archive.close();}
  }finally{f.cleanup();}
});
