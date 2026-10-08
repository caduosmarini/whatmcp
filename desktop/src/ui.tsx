import { useEffect,useState } from 'react';
import { Play, Copy, AudioLines, LoaderCircle } from 'lucide-react';
import { call } from './bridge';
import type { Message } from './types';
import { date,time } from './types';
export function Avatar({name}:{name:string}){const letters=name.split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase();const colors=['#aca7e9','#8bc1b1','#d6b59c','#98bee6','#a9c79d'];let hash=0;for(const c of name)hash+=c.charCodeAt(0);return <span className="avatar" style={{background:colors[hash%colors.length]}}>{letters}</span>}
export function Empty({title,detail}:{title:string;detail?:string}){return <div className="empty"><h3>{title}</h3>{detail?<p>{detail}</p>:null}</div>}
export function Loading(){return <div className="empty" role="status"><LoaderCircle className="spin"/> Carregando…</div>}
export function Highlight({text,query}:{text:string;query:string}){const terms=query.trim().split(/\s+/).filter(t=>t.length>2);if(!terms.length)return <>{text}</>;const escaped=terms.map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));const re=new RegExp(`(${escaped.join('|')})`,'gi');return <>{text.split(re).map((part,i)=>terms.some(t=>t.toLocaleLowerCase()===part.toLocaleLowerCase())?<mark key={i}>{part}</mark>:part)}</>}
export function AudioPlayer({id,onError}:{id:string;onError:(s:string)=>void}){
  const [src,setSrc]=useState(''),[loading,setLoading]=useState(false);
  useEffect(()=>()=>{if(src)URL.revokeObjectURL(src)},[src]);
  async function load(){setLoading(true);try{const media=await call<{base64:string;mime:string}>('media',{id});const bytes=Uint8Array.from(atob(media.base64),c=>c.charCodeAt(0));setSrc(URL.createObjectURL(new Blob([bytes],{type:media.mime})));}catch(e){onError(String(e))}finally{setLoading(false)}}
  return src?<audio controls autoPlay src={src} aria-label="Reproduzir áudio"/>:<button className="audio-control" onClick={load} disabled={loading}><span className="play-circle">{loading?<LoaderCircle className="spin" size={18}/>:<Play size={18} fill="currentColor"/>}</span><AudioLines size={32}/><span>Ouvir áudio</span></button>
}
export function Conversation({messages,onTranscribe,onError,highlight}:{messages:Message[];onTranscribe:(id:string)=>void;onError:(s:string)=>void;highlight?:number}){
  let lastDay='';return <div className="message-stream">{messages.map(m=>{const day=date(m.ts),divider=day!==lastDay;lastDay=day;const name=m.is_from_me?'Você':m.sender_name;return <div key={m.id}>
    {divider?<div className="day-divider"><span>{day}</span></div>:null}
    <article className="message"><Avatar name={name}/><div className="message-content"><div className="message-meta"><strong>{name}</strong><span>{time(m.ts)}</span><button className="icon-button copy-message" title="Copiar mensagem" aria-label="Copiar mensagem" onClick={()=>navigator.clipboard.writeText(m.text??m.transcription_text??'').catch(()=>onError('Não foi possível copiar.'))}><Copy size={15}/></button></div>
      {m.text?<div className={`bubble ${m.is_from_me?'mine':''} ${highlight!==undefined&&Math.abs(m.ts-highlight)<120?'highlighted':''}`}>{m.text}</div>:null}
      {m.kind==='audio'?<><AudioPlayer id={m.id} onError={onError}/>{m.transcription_text?<div className="transcript"><strong>Transcrição</strong><p>{m.transcription_text}</p>{m.transcription_stale?<small>O arquivo de áudio mudou; esta transcrição precisa de revisão.</small>:null}{m.index_pending?<small>Aguardando inclusão na busca.</small>:null}</div>:<div className="pending-audio"><span>Aguardando transcrição</span><button onClick={()=>onTranscribe(m.id)}>Transcrever este áudio</button></div>}</>:null}
      {!m.text&&m.kind!=='audio'?<div className="bubble muted">Mensagem de {m.kind}</div>:null}
    </div></article></div>})}</div>
}
