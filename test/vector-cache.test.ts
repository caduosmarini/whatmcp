import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../src/db/index.ts';
import {getStore,invalidate} from '../src/store.ts';
import {windowHash} from '../src/index/chunker.ts';

test('transcription progress reuses vectors, publication and embeddings invalidate them',()=>{
  const dir=mkdtempSync(join(tmpdir(),'whatmcp-cache-'));
  try {
    const path=join(dir,'archive.db');const db=openStore(path);
    db.exec("INSERT INTO threads(id,kind,first_seen_at,last_seen_at) VALUES('chat','dm',0,0)");
    const hash=windowHash({thread_id:'chat',speakers:'me',text:'me: hello'});
    db.prepare(`INSERT INTO windows(thread_id,start_ts,end_ts,msg_count,speakers,text,first_msg_id,last_msg_id,content_hash)
      VALUES('chat',0,0,1,'me','me: hello','m','m',?)`).run(hash);
    db.prepare('INSERT INTO window_vectors(content_hash,model,dim,created_at,vec) VALUES (?,?,4,0,?)')
      .run(hash,'test',new Uint8Array(new Float32Array([1,0,0,0]).buffer));
    const first=getStore(path,'test');assert.ok(first.vectors);
    db.exec("INSERT INTO messages(id,thread_id,ts,kind,is_from_me,first_seen_at) VALUES('audio','chat',0,'audio',0,0)");
    db.exec("INSERT INTO audio_transcripts(message_id,audio_sha256,model,model_revision,locale,status,updated_at) VALUES('audio','sha','apple-speech','v2','pt-BR','processing',0)");
    invalidate();const progress=getStore(path,'test');assert.equal(progress.vectors,first.vectors);
    db.exec("UPDATE windows SET text='me: changed' WHERE thread_id='chat'");
    const publication=getStore(path,'test');assert.notEqual(publication.vectors,first.vectors);
    db.exec('UPDATE window_vectors SET created_at=1');
    assert.notEqual(getStore(path,'test').vectors,publication.vectors);db.close();
  }finally{invalidate();rmSync(dir,{recursive:true,force:true});}
});
