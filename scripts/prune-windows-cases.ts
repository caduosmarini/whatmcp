/** Delete only directories explicitly owned by the hot-copy pipeline. */
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const MARKER = '.whatmcp-hotcopy.json';
export function pruneWindowsCases(root: string, currentRun?: string): string[] {
  if (!existsSync(root)) return [];
  const runs: {name:string;status:string}[]=[];
  for (const entry of readdirSync(root,{withFileTypes:true})) {
    if (!entry.isDirectory() || !/^\d{8}-\d{6}-\d+$/.test(entry.name)) continue;
    const path=join(root,entry.name);
    if (lstatSync(path).isSymbolicLink()) continue;
    try {
      const marker=join(path,MARKER);
      if(lstatSync(marker).isSymbolicLink()) continue;
      const value=JSON.parse(readFileSync(marker,'utf8').replace(/^\uFEFF/,''));
      if(value.schema==='whatmcp.hotcopy.v1' && value.run_id===entry.name) {
        runs.push({name:entry.name,status:value.status});
      }
    } catch { /* unknown directories belong to the user */ }
  }
  runs.sort((a,b)=>b.name.localeCompare(a.name));
  const keep=new Set(runs.slice(0,2).map(r=>r.name));
  const lastGood=runs.find(r=>r.status==='ok');
  if(lastGood)keep.add(lastGood.name);
  if(currentRun)keep.add(currentRun);
  const removed:string[]=[];
  for(const run of runs) {
    if(keep.has(run.name))continue;
    rmSync(join(root,run.name),{recursive:true});removed.push(run.name);
  }
  return removed;
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [root,currentRun]=process.argv.slice(2);
  if(!root)throw new Error('Expected owned case directory');
  console.log(JSON.stringify({removed:pruneWindowsCases(root,currentRun)}));
}
