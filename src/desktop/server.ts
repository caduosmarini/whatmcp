import { createInterface } from 'node:readline';
import { DesktopService } from './service.ts';
if(!process.env.WHATMCP_HOME||!['demo','archive','existing'].includes(process.env.WHATMCP_DESKTOP_MODE??''))throw new Error('Desktop runtime requires an explicit profile');
const service=new DesktopService();
for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
  try{if(line.length>65536)throw new Error('Request too large');const req=JSON.parse(line);const result=await service.call(req.method,req.params);console.log(JSON.stringify({ok:true,result}));}
  catch(error){console.log(JSON.stringify({ok:false,error:(error as Error).message}));}
}
await service.call('shutdown');
