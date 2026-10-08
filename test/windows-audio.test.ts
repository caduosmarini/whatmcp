import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/db/index.ts';
import { importWindowsUnified } from '../src/index/windows-import.ts';
import { runTranscription } from '../src/transcription/worker.ts';

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'whatmcp-windows-audio-')), caseDir=join(dir,'case'), mediaRoot=join(dir,'durable');
  mkdirSync(caseDir);
  const source=join(caseDir,'unified_whatsapp.db'), archive=join(dir,'archive.db');
  const src=new DatabaseSync(source);
  src.exec(`CREATE TABLE messages(msg_id TEXT,chat_jid TEXT,chat_name TEXT,sender_jid TEXT,sender_name TEXT,
    from_me INTEGER,timestamp INTEGER,text TEXT,is_group INTEGER,msg_type TEXT,
    media_filename TEXT,media_case_path TEXT,media_sha256 TEXT,media_size INTEGER)`);
  const add=(id:string, path:string|null, filename=id+'.ogg', sha?:string)=>{
    const bytes=Buffer.from('synthetic audio '+id);
    if (path && !path.startsWith('../')) writeFileSync(join(caseDir,path),bytes);
    src.prepare('INSERT INTO messages(msg_id,chat_jid,chat_name,sender_jid,sender_name,from_me,timestamp,text,is_group,msg_type,media_filename,media_case_path,media_sha256,media_size) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,'chat','Chat','sender','Ana',0,1700000000,null,0,'ptt',filename,path,
        sha??createHash('sha256').update(bytes).digest('hex'),bytes.length);
  };
  return {dir,caseDir,mediaRoot,source,archive,src,add};
}

test('late Windows audio is verified, durable, transcribed and searchable after case deletion',async()=>{
  const f=fixture();
  try {
    f.add('voice',null);
    importWindowsUnified(f.archive,f.source,{full:true,mediaRoot:f.mediaRoot});
    // A watermark far newer than the voice must not hide its later local file.
    const db=openStore(f.archive);db.exec("UPDATE sync_state SET last_ts=1900000000");db.close();
    const bytes=Buffer.from('synthetic audio voice');writeFileSync(join(f.caseDir,'voice.ogg'),bytes);
    f.src.exec("UPDATE messages SET media_case_path='voice.ogg'");
    const r=importWindowsUnified(f.archive,f.source,{mediaRoot:f.mediaRoot});
    assert.equal(r.scanned,0);assert.equal(r.audioReferenced,1);
    const check=openStore(f.archive);
    const ref=check.prepare('SELECT * FROM audio_media').get() as any;
    assert.equal(ref.source_id,'windows');assert.deepEqual(readFileSync(join(f.mediaRoot,ref.relative_path)),bytes);
    const generation=(check.prepare('SELECT desired_generation n FROM thread_projection_state').get() as any).n;
    importWindowsUnified(f.archive,f.source,{mediaRoot:f.mediaRoot});
    assert.equal((check.prepare('SELECT desired_generation n FROM thread_projection_state').get() as any).n,generation);
    f.src.close();rmSync(f.caseDir,{recursive:true});
    const cfg={store:f.archive,mediaRoots:{windows:f.mediaRoot},transcriptionModel:'gpt-transcribe',
      transcriptionDefaultLanguage:'pt-BR',openaiKey:'synthetic',openaiModel:'test',openaiDims:4} as any;
    const result=await runTranscription(cfg,{limit:Infinity,duration:async()=>1,
      convert:async(_cfg,_src,_seg,dest)=>{writeFileSync(dest,'wav');},
      transcribe:async()=> 'prova de áudio preservado'});
    assert.equal(result.processed,1);
    assert.equal((check.prepare("SELECT COUNT(*) n FROM windows_fts WHERE windows_fts MATCH 'preservado'").get() as any).n,1);
    const again=await runTranscription(cfg,{duration:async()=>1,transcribe:async()=>{throw new Error('must not re-transcribe');}});
    assert.equal(again.processed,0);check.close();
  } finally {try{f.src.close();}catch{} rmSync(f.dir,{recursive:true,force:true});}
});

test('untrusted hashes, ambiguous filenames, traversal and missing files are skipped without losing messages',()=>{
  const f=fixture();
  try {
    f.add('bad','bad.ogg','bad.ogg','a'.repeat(64));
    f.add('one','one.ogg','shared.ogg');f.add('two','two.ogg','shared.ogg');
    f.add('escape','../outside.ogg');
    f.add('missing',null);f.src.exec("UPDATE messages SET media_case_path='absent.ogg' WHERE msg_id='missing'");
    if(process.platform!=='win32') {
      f.add('link',null);writeFileSync(join(f.dir,'outside.ogg'),'outside');
      symlinkSync(join(f.dir,'outside.ogg'),join(f.caseDir,'link.ogg'));
      f.src.exec("UPDATE messages SET media_case_path='link.ogg' WHERE msg_id='link'");
    }
    const r=importWindowsUnified(f.archive,f.source,{full:true,mediaRoot:f.mediaRoot});
    assert.equal(r.audioReferenced,0);assert.equal(r.audioRejected,process.platform==='win32'?5:6);
    const db=openStore(f.archive);assert.equal((db.prepare('SELECT COUNT(*) n FROM audio_media').get() as any).n,0);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM messages').get() as any).n,r.audioRejected);db.close();
    assert.equal(existsSync(f.mediaRoot),false);
  }finally{f.src.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('audio outside the selected import and durable history is not copied or hashed',()=>{
  const f=fixture();
  try {
    f.add('unarchived','voice.ogg');
    const db=openStore(f.archive);
    db.exec("INSERT INTO threads(id,kind,first_seen_at,last_seen_at) VALUES('existing','dm',0,0)");
    db.exec("INSERT INTO messages(id,thread_id,ts,text,kind,is_from_me,first_seen_at) VALUES('existing:text','existing',1700000001,'later history','text',0,0)");
    db.close();
    const r=importWindowsUnified(f.archive,f.source,{mediaRoot:f.mediaRoot});
    assert.equal(r.scanned,0);assert.equal(r.audioReferenced,0);assert.equal(r.audioRejected,0);
    assert.equal(existsSync(f.mediaRoot),false);
  }finally{f.src.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('message content hash links nameless and forwarded audio while rejecting a wrong identity hash',()=>{
  const f=fixture();
  try {
    f.src.exec('ALTER TABLE messages ADD COLUMN media_filehash TEXT');
    f.add('nameless','voice.ogg');
    f.src.exec("UPDATE messages SET media_filename=NULL,media_filehash=media_sha256");
    let r=importWindowsUnified(f.archive,f.source,{full:true,mediaRoot:f.mediaRoot});
    assert.equal(r.audioReferenced,1);
    f.add('bad-identity','bad.ogg');
    f.src.prepare("UPDATE messages SET media_filehash=? WHERE msg_id='bad-identity'").run('a'.repeat(64));
    r=importWindowsUnified(f.archive,f.source,{full:true,mediaRoot:f.mediaRoot});
    assert.equal(r.audioReferenced,1);assert.equal(r.audioRejected,1);
  } finally {f.src.close();rmSync(f.dir,{recursive:true,force:true});}
});
