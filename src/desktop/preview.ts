// Browser QA only. Never exposes a real profile or a production listener.
import { createServer } from 'node:http';
import { DesktopService } from './service.ts';
if(process.env.WHATMCP_DESKTOP_MODE!=='demo'||!process.env.WHATMCP_HOME)throw new Error('Preview requires an isolated demo profile');
const service=new DesktopService();
createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');if(req.method!=='POST'||req.url!=='/api'){res.writeHead(404).end();return;}if(!req.headers['content-type']?.startsWith('application/json')||req.headers.origin&&!/^http:\/\/127\.0\.0\.1:(1420|1421)$/.test(req.headers.origin)){res.writeHead(403).end();return;}try{let text='';for await(const b of req){text+=b;if(text.length>65536)throw new Error('Request too large');}const {method,params}=JSON.parse(text);res.end(JSON.stringify({ok:true,result:await service.call(method,params)}));}catch(e){res.writeHead(400).end(JSON.stringify({ok:false,error:(e as Error).message}));}}).listen(1421,'127.0.0.1');
process.on('SIGTERM',async()=>{await service.call('shutdown');process.exit(0);});
