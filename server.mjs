import http from 'node:http';
import {readFile, realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.dirname(fileURLToPath(import.meta.url));
const routes={
  '/':'web/index.html', '/index.html':'web/index.html', '/style.css':'web/style.css', '/map.mjs':'web/map.mjs',
  '/plan2050.json':'docs/guil_2050_plan.json', '/plan2050.svg':'docs/구일_2050_계획도.svg'
};
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'};
export function createServer() {
  return http.createServer(async(req,res)=>{
    if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405,{Allow:'GET, HEAD'}); res.end(); return; }
    let pathname;
    try { pathname=new URL(req.url,'http://127.0.0.1').pathname; } catch { res.writeHead(400); res.end(); return; }
    // Existing bookmarks no longer open the discarded 3D implementation.
    if (['/shinyeong','/shinyeong/'].includes(pathname)) { res.writeHead(302,{Location:'/','Cache-Control':'no-store'}); res.end(); return; }
    const file=routes[pathname];
    if (!file) { res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); res.end('Not found'); return; }
    try {
      const actual=await realpath(path.join(root,file));
      if (!actual.startsWith(root+path.sep)) throw new Error('Invalid file path');
      const bytes=await readFile(actual);
      res.writeHead(200,{
        'Content-Type':types[path.extname(actual)], 'Content-Length':bytes.length,
        'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      });
      res.end(req.method==='HEAD'?undefined:bytes);
    } catch { res.writeHead(500); res.end('Missing project file. Run npm run build:map.'); }
  });
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT||4173);
  const host=process.env.HOST||'127.0.0.1';
  if (!Number.isInteger(port)||port<1||port>65535) throw new Error('PORT must be 1..65535');
  const server=createServer();
  server.on('error',error=>{ console.error(`Cannot start preview: ${error.message}`); process.exitCode=1; });
  server.listen(port,host,()=>console.log(`Korea 2050 plan: http://${host}:${port}/`));
}
