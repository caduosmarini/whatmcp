import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../db/index.ts';
import { rebuildWindows } from '../index/indexer.ts';
import { packVector } from '../index/embed.ts';
import { modelTag } from '../index/openai.ts';
import type { Config } from '../config.ts';
import { runTranscription } from '../transcription/worker.ts';

// Offline, synthetic semantic space. Never presented as production embeddings.
const concepts=[['pagamento','pagar','parcelas','transferência','comprovante','dinheiro'],['orçamento','valores','custos','preço'],['sexta','quinta','amanhã','prazo','apresentação'],['viagem','passagens','feriado','família'],['produto','ferramenta','reunião','passos']];
export function demoVector(text:string):Float32Array {
  const words=text.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const v=new Float32Array(16);
  concepts.forEach((group,i)=>{for(const word of group)if(words.includes(word.normalize('NFD').replace(/[\u0300-\u036f]/g,'')))v[i]+=1;});
  for(const word of words.match(/[a-z]{3,}/g)??[])v[5+(createHash('sha256').update(word).digest()[0]%11)]+=.12;
  const norm=Math.hypot(...v)||1;return v.map(x=>x/norm);
}
export function embedDemo(cfg:Config,progress:(s:string)=>void=()=>{}) {
  const db=openStore(cfg.store);let done=0;
  try{const rows=db.prepare('SELECT text,content_hash FROM windows').all() as {text:string;content_hash:string}[];
    for(const row of rows){const r=db.prepare('INSERT OR IGNORE INTO window_vectors(content_hash,model,dim,vec,created_at) VALUES(?,?,?,?,?)')
      .run(row.content_hash,modelTag({model:cfg.openaiModel,dimensions:cfg.openaiDims}),16,packVector(demoVector(row.text)),Math.floor(Date.now()/1000));done+=Number(r.changes);}
    progress(`${done} trechos indexados na demonstração`);return {embedded:done};
  }finally{db.close();}
}
export function seedDemo(root:string) {
  const store=join(root,'archive.db');if(existsSync(store))return;
  mkdirSync(join(root,'media'),{recursive:true,mode:0o700});
  const cfg={store,chatstorage:join(root,'unused.sqlite'),openaiKey:null,openaiModel:'demo-local',openaiDims:16,
    sourceType:'chatstorage',windowsWaren6Path:null,windowsOutputDir:join(root,'cases'),syncIntervalHours:0,
    transcriptionModel:'gpt-transcribe',transcriptionDefaultLanguage:'pt-BR',mediaRoots:{demo:join(root,'media')},mediaSourceId:'demo'} satisfies Config;
  writeFileSync(join(root,'config.json'),JSON.stringify({store,openai_model:'demo-local',openai_dims:16,transcription_model:'gpt-transcribe',media_source_id:'demo',media_roots:cfg.mediaRoots},null,2),{mode:0o600});
  const db=openStore(store);const base=Date.UTC(2026,9,6,12)/1000;
  try {
    const people=[['clara','Clara'],['rafael','Rafael'],['bruno','Bruno'],['me','Você']];
    for(const [id,name]of people)db.prepare('INSERT INTO senders(id,display_name,is_self,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)').run(id,name,id==='me'?1:0,base,base);
    const chats=[['aurora','Projeto Aurora','group'],['clara','Clara','dm'],['reforma','Reforma do apartamento','group'],['produto','Equipe de produto','group'],['viagem','Viagem em família','group']];
    for(const [id,title,kind]of chats)db.prepare('INSERT INTO threads(id,title,kind,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)').run(id,title,kind,base,base);
    const rows=[['aurora','clara','A apresentação pode ficar pronta até sexta?'],['aurora','me','Sim, envio uma versão amanhã.'],['aurora','rafael',null],['aurora','clara',null],['aurora','rafael','Perfeito. Assim conseguimos levar para a reunião com mais clareza.'],['aurora','clara','Fechamos a proposta?'],['aurora','me','Sim. Como fica o pagamento?'],['aurora','clara','Podemos dividir em duas parcelas. A primeira fica para sexta.'],['aurora','me','Combinado, envio o comprovante.'],['clara','clara','A apresentação pode ficar pronta até sexta?'],['reforma','rafael','O pagamento pode ser feito por transferência bancária, como combinamos na reunião.'],['produto','bruno','Falamos sobre o pagamento da ferramenta e os próximos passos.'],['viagem','clara','Já comprei as passagens para o feriado.'],['reforma','rafael',null]];
    rows.forEach(([thread,sender,text],i)=>db.prepare('INSERT INTO messages(id,thread_id,sender_id,ts,text,is_from_me,kind,first_seen_at) VALUES(?,?,?,?,?,?,?,?)').run(`demo-${i}`,thread,sender,base+i*60+(i>=5?18000:0),text,sender==='me'?1:0,text?'text':'audio',base));
    for(const [id]of chats)db.prepare('UPDATE threads SET msg_count=(SELECT COUNT(*) FROM messages WHERE thread_id=?),first_ts=(SELECT MIN(ts) FROM messages WHERE thread_id=?),last_ts=(SELECT MAX(ts) FROM messages WHERE thread_id=?) WHERE id=?').run(id,id,id,id);
    const wav=Buffer.alloc(44+16000*2*3);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
    for(const i of [2,3,13]){wav[44]=i;const file=`${i}.wav`;if(i!==13)writeFileSync(join(root,'media',file),wav);db.prepare('INSERT INTO audio_media(message_id,source_id,relative_path,sha256,availability,duration_s) VALUES(?,?,?,?,?,?)').run(`demo-${i}`,'demo',file,createHash('sha256').update(wav).digest('hex'),i===13?'missing':'available',3);}
    rebuildWindows(db,chats.map(x=>x[0]));
    db.prepare("INSERT INTO sync_state(id,last_run_at) VALUES('whatsapp',?)").run(base);
  }finally{db.close();}
  // Leave one conversation without a vector so the backlog is meaningful.
  embedDemo(cfg);const partial=openStore(store);try{partial.prepare('DELETE FROM window_vectors WHERE content_hash IN (SELECT content_hash FROM windows WHERE thread_id=?)').run('viagem');}finally{partial.close();}
}
export async function transcribeDemo(cfg:Config,messageId?:string,retry=false,progress:(s:string)=>void=()=>{}) {
  return runTranscription(cfg,{messageId,retryErrors:retry,limit:cfg.transcriptionBatchSize??100,
    transcribe:async()=> 'Podemos revisar o orçamento na quinta. Vou separar os valores por etapa.',
    duration:async()=>3,convert:async(_cfg,source,_segment,output)=>copyFileSync(source,output),onProgress:progress});
}
export function syncDemo(cfg:Config) {
  const db=openStore(cfg.store);try{const ts=Math.floor(Date.now()/1000);db.prepare('INSERT OR IGNORE INTO messages(id,thread_id,sender_id,ts,text,is_from_me,kind,first_seen_at) VALUES(?,?,?,?,?,?,?,?)').run('demo-sync','aurora','clara',ts,'Atualização da demonstração: orçamento revisado.',0,'text',ts);db.prepare("UPDATE threads SET msg_count=(SELECT COUNT(*) FROM messages WHERE thread_id='aurora'),last_ts=? WHERE id='aurora'").run(ts);rebuildWindows(db,['aurora']);db.prepare("UPDATE sync_state SET last_run_at=? WHERE id='whatsapp'").run(ts);return {messages:1};}finally{db.close();}
}
