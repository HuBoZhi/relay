// Serve only this prototype directory, on loopback. No repository or application API exposure.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {dirname,extname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.RELAY_PREVIEW_PORT||4318);
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.md':'text/plain; charset=utf-8'};
http.createServer(async(request,response)=>{
  try{
    const url=new URL(request.url,'http://127.0.0.1:'+port);
    const path=resolve(root,decodeURIComponent(url.pathname).replace(/^\/+/, '')||'index.html');
    if(!path.startsWith(root+sep)||!types[extname(path)]||!['GET','HEAD'].includes(request.method)){response.writeHead(403);response.end('Forbidden');return;}
    const body=await readFile(path);
    response.writeHead(200,{'Content-Type':types[extname(path)],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    response.end(request.method==='HEAD'?undefined:body);
  }catch{response.writeHead(404);response.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log('Relay design preview: http://127.0.0.1:'+port));
