import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { acquireWindowsAudio } from '../src/index/windows-download.ts';
const sourceArgument=process.argv.slice(2).find(a=>a.startsWith('--source='));
const source=sourceArgument?.slice('--source='.length)??process.argv[2];if(!source)throw new Error('source database required');
const cfg=loadConfig();
if(cfg.transcriptionAutoAfterImport && cfg.transcriptionModel) {
  const started=Date.now();
  const requestedAfter=Number(process.env.WHATMCP_AUDIO_BACKFILL_AFTER);
  const backfill=Number.isSafeInteger(requestedAfter) && requestedAfter>0 && requestedAfter<Math.floor(Date.now()/1000);
  const after=backfill?requestedAfter:Math.floor(Date.now()/1000)-7*86400;
  const limit=backfill?2000:200;
  let metadata;
  if(process.argv.includes('--metadata-stdin')) {
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of process.stdin) { size+=chunk.length;if(size>2*1024*1024)throw new Error('audio metadata exceeds bounded input');chunks.push(Buffer.from(chunk)); }
    metadata=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!Array.isArray(metadata))throw new Error('audio metadata array required');
  }
  const python=process.env.WHATMCP_AUDIO_CACHE_PYTHON,cache=process.env.WHATMCP_AUDIO_CACHE_PATH,vendor=process.env.WHATMCP_AUDIO_CACHE_VENDOR;
  if(python && cache && vendor) {
    // Helper emits only counters; private cache keys never become output.
    const days=Math.ceil((Date.now()/1000-after)/86400)+1;
    spawnSync(python,[fileURLToPath(new URL('./windows-cache-audio.py',import.meta.url)),'--source',source,'--cache',cache,'--vendor',vendor,'--days',String(days),'--limit',String(limit)],{stdio:'pipe',windowsHide:true,timeout:30000});
  }
  console.log(JSON.stringify(await acquireWindowsAudio(source,cfg.mediaRoots?.windows??join(process.env.WHATMCP_HOME??'.','media','windows'),{metadata,after,limit,budgetMs:Math.max(0,100000-(Date.now()-started))})));
} else console.log(JSON.stringify({downloaded:0,reused:0,failed:0,eligible:0,disabled:true}));
