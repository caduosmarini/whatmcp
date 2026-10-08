import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac, hkdfSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireWindowsAudio, audioUrl, decryptAudio } from '../src/index/windows-download.ts';

function audio() {
  const key=Buffer.alloc(32,7),plain=Buffer.from('OggS synthetic voice');
  const expanded=Buffer.from(hkdfSync('sha256',key,Buffer.alloc(32),'WhatsApp Audio Keys',112));
  const cipher=createCipheriv('aes-256-cbc',expanded.subarray(16,48),expanded.subarray(0,16));
  const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
  const mac=createHmac('sha256',expanded.subarray(48,80)).update(expanded.subarray(0,16)).update(encrypted).digest().subarray(0,10);
  const bytes=Buffer.concat([encrypted,mac]);
  const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
  return {plain,bytes,key:key.toString('base64'),hash:hash(plain),encHash:hash(bytes)};
}

test('authenticated WhatsApp audio rejects altered ciphertext, content hash and media key',()=>{
  const a=audio();assert.deepEqual(decryptAudio(a.bytes,a.key,a.hash,a.encHash),a.plain);
  const altered=Buffer.from(a.bytes);altered[0]^=1;
  assert.throws(()=>decryptAudio(altered,a.key,a.hash,a.encHash),/encrypted hash/);
  assert.throws(()=>decryptAudio(altered,a.key,a.hash,null),/authentication/);
  assert.throws(()=>decryptAudio(a.bytes,Buffer.alloc(32,8).toString('base64'),a.hash,a.encHash),/authentication/);
  assert.throws(()=>decryptAudio(a.bytes,a.key,'00'.repeat(32),a.encHash),/content hash/);
});

test('media acquisition restricts HTTPS endpoints and rejects credentials or hostile hosts',()=>{
  assert.match(audioUrl('/v/t62/a.enc',null),/^https:\/\/mmg.whatsapp.net\//);
  for(const url of ['http://mmg.whatsapp.net/a','https://whatsapp.net.attacker.example/a','https://127.0.0.1/a','https://user:pass@mmg.whatsapp.net/a'])assert.throws(()=>audioUrl(null,url));
});

test('download publishes only verified audio and reuses durable bytes after a case loses its link',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'whatmcp-acquire-')),source=join(dir,'unified.db'),root=join(dir,'durable'),a=audio();
  const db=new DatabaseSync(source);
  db.exec(`CREATE TABLE messages(msg_id TEXT,chat_jid TEXT,timestamp INTEGER,msg_type TEXT,media_filename TEXT,media_case_path TEXT,
    media_sha256 TEXT,media_status TEXT,media_filehash TEXT,media_enc_filehash TEXT,media_key TEXT,media_direct_path TEXT,media_url TEXT,media_size INTEGER,media_mime_type TEXT)`);
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('voice','chat',Math.floor(Date.now()/1000),'audio',null,null,null,null,a.hash,a.encHash,a.key,'/voice.enc',null,a.plain.length,'audio/ogg');
  let calls=0;
  const fetcher=(async()=>{calls++;return new Response(a.bytes);}) as typeof fetch;
  try {
    const first=await acquireWindowsAudio(source,root,{fetcher});assert.equal(first.downloaded,1);assert.equal(first.failed,0);
    const row=db.prepare('SELECT * FROM messages').get() as any;
    assert.deepEqual(readFileSync(join(dir,row.media_case_path)),a.plain);
    assert.deepEqual(readFileSync(join(root,row.media_filename)),a.plain);
    db.exec('UPDATE messages SET media_case_path=NULL');
    const next=await acquireWindowsAudio(source,root,{fetcher});assert.equal(next.reused,1);assert.equal(calls,1);
    db.exec("UPDATE messages SET media_case_path=NULL,media_size=999");
    const invalid=await acquireWindowsAudio(source,root,{fetcher});assert.equal(invalid.failed,1);
    assert.equal((db.prepare('SELECT media_case_path FROM messages').get() as any).media_case_path,null);
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});

test('plaintext cache is recoverable without a media key or network endpoint',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'whatmcp-plain-')),source=join(dir,'unified.db'),a=audio();
  const db=new DatabaseSync(source);
  db.exec(`CREATE TABLE messages(msg_id TEXT,chat_jid TEXT,timestamp INTEGER,msg_type TEXT,media_filename TEXT,media_case_path TEXT,
    media_sha256 TEXT,media_status TEXT,media_filehash TEXT,media_enc_filehash TEXT,media_size INTEGER,media_mime_type TEXT)`);
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('voice','chat',Math.floor(Date.now()/1000),'audio',null,null,null,null,a.hash,null,a.plain.length,'audio/ogg');
  mkdirSync(join(dir,'.whatmcp-plain'));writeFileSync(join(dir,'.whatmcp-plain',a.hash),a.plain);
  try {
    const r=await acquireWindowsAudio(source,join(dir,'durable'),{fetcher:(async()=>{throw new Error('network forbidden');}) as typeof fetch});
    assert.equal(r.downloaded,1);assert.equal(r.failed,0);
    assert.deepEqual(readFileSync(join(dir,(db.prepare('SELECT media_case_path FROM messages').get() as any).media_case_path)),a.plain);
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});

test('media key and signed endpoint remain in memory when the source stores hashes only',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'whatmcp-pipe-')),source=join(dir,'unified.db'),a=audio();
  const db=new DatabaseSync(source);
  db.exec(`CREATE TABLE messages(msg_id TEXT,chat_jid TEXT,timestamp INTEGER,msg_type TEXT,media_filename TEXT,media_case_path TEXT,
    media_sha256 TEXT,media_status TEXT,media_filehash TEXT,media_enc_filehash TEXT,media_size INTEGER,media_mime_type TEXT)`);
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('voice','chat',Math.floor(Date.now()/1000),'audio',null,null,null,null,a.hash,a.encHash,a.plain.length,'audio/ogg');
  try {
    const r=await acquireWindowsAudio(source,join(dir,'durable'),{metadata:[{msg_id:'voice',chat_jid:'chat',media_key:a.key,media_direct_path:'/voice.enc?token=private',media_url:null}],fetcher:(async()=>new Response(a.bytes)) as typeof fetch});
    assert.equal(r.downloaded,1);assert.equal(r.failed,0);
    const bytes=readFileSync(source).toString('utf8');assert.equal(bytes.includes(a.key),false);assert.equal(bytes.includes('token=private'),false);
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});
