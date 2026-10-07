import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../src/db/index.ts';
import {rebuildWindows} from '../src/index/indexer.ts';
import {windowHash} from '../src/index/chunker.ts';
import {estimateTokens} from '../src/index/openai.ts';
import {markProjectionDirty} from '../src/transcription/media.ts';
import {prepareReadyCandidates,publishCandidates} from '../src/transcription/projection.ts';
test('legacy oversized windows rewindow from the archive and invalidate old candidates',()=>{
 const dir=mkdtempSync(join(tmpdir(),'whatmcp-rewindow-'));
 try {
  const db=openStore(join(dir,'archive.db'));
  const text='﷽'.repeat(3000)+' final';
  db.exec("INSERT INTO threads(id,kind,first_seen_at,last_seen_at) VALUES('chat','dm',0,0)");
  db.prepare("INSERT INTO messages(id,thread_id,ts,text,kind,is_from_me,first_seen_at) VALUES('m','chat',0,?,'text',1,0)").run(text);
  const payload={thread_id:'chat',speakers:'me',text:'me: '+text};
  db.prepare("INSERT INTO windows(thread_id,start_ts,end_ts,msg_count,text,speakers,content_hash) VALUES('chat',0,0,1,?,'me',?)").run(payload.text,windowHash(payload));
  markProjectionDirty(db,'chat');
  const cfg={openaiModel:'test',openaiDims:4,openaiKey:null} as any;
  prepareReadyCandidates(db,cfg);
  rebuildWindows(db,['chat'],{invalidateCandidates:true});
  assert.equal(publishCandidates(db,cfg),0);
  const windows=db.prepare('SELECT text FROM windows').all() as {text:string}[];
  assert.ok(windows.length>1);assert.ok(windows.every(w=>estimateTokens(w.text)<=8000));
  assert.ok(windows.map(w=>w.text.slice(4)).join('').replaceAll(' ','')===text.replaceAll(' ',''));
  prepareReadyCandidates(db,cfg);assert.equal(publishCandidates(db,cfg),1);
  assert.ok((db.prepare('SELECT text FROM windows').all() as {text:string}[]).every(w=>estimateTokens(w.text)<=8000));
  db.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
