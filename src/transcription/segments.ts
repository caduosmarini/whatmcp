import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {Config} from '../config.ts';
const exec=promisify(execFile);
export interface AudioSegment {start:number;end:number;}

/** Prefer silence in the last 30 seconds before each ten-minute boundary. */
export function segmentBoundaries(duration:number,silences:number[]=[]):AudioSegment[]{
  const out:AudioSegment[]=[];
  let start=0;
  while(duration-start>600){
    const cap=start+600;
    const end=silences.filter(s=>s>=cap-30 && s<=cap).sort((a,b)=>b-a)[0] ?? cap;
    out.push({start,end});start=end;
  }
  out.push({start,end:duration});return out;
}

export async function planSegments(cfg:Config,path:string,duration:number):Promise<AudioSegment[]>{
  if(duration<=600)return segmentBoundaries(duration);
  const silences:number[]=[];
  try {
    const {stderr}=await exec(cfg.ffmpegPath ?? 'ffmpeg',[
      '-nostdin','-hide_banner','-i',path,'-af','silencedetect=noise=-35dB:d=0.25','-f','null','-',
    ],{timeout:300_000,maxBuffer:4*1024*1024,windowsHide:true});
    let start:number|null=null;
    for(const line of stderr.split('\n')){
      const a=line.match(/silence_start: ([\d.]+)/);if(a)start=Number(a[1]);
      const b=line.match(/silence_end: ([\d.]+)/);if(b && start!==null){
        silences.push((start+Number(b[1]))/2);start=null;
      }
    }
  } catch { /* Silence analysis is optional; conversion still validates the audio. */ }
  return segmentBoundaries(duration,silences);
}
