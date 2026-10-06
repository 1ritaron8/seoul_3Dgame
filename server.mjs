import http from 'node:http';
import {readFile, realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.dirname(fileURLToPath(import.meta.url));
const routes={
  '/':'web/index.html', '/index.html':'web/index.html', '/style.css':'web/style.css', '/map.mjs':'web/map.mjs',
  '/plan2050.json':'docs/guil_2050_plan.json', '/plan2050.svg':'docs/구일_2050_계획도.svg',
  '/pilot/':'web/pilot.html', '/pilot/style.css':'web/pilot.css', '/pilot/view.mjs':'web/pilot.mjs',
  '/pilot/geometry.mjs':'web/pilot-geometry.mjs', '/pilot/data.json':'docs/guil_2050_pilot3d.json',
  '/pilot/architecture.mjs':'web/pilot-architecture.mjs', '/pilot/pilot-geometry.mjs':'web/pilot-geometry.mjs',
  '/pilot/apartment-modules.mjs':'web/apartment-modules.mjs',
  '/pilot/entrance-access.mjs':'web/entrance-access.mjs',
  '/pilot/pilot-environment.mjs':'web/pilot-environment.mjs',
  '/runtime/three/three.module.js':'node_modules/three/build/three.module.js',
  '/runtime/three/three.core.js':'node_modules/three/build/three.core.js',
  '/runtime/three/OrbitControls.js':'node_modules/three/examples/jsm/controls/OrbitControls.js'
};
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'};
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
      let scriptPolicy="script-src 'self'";
      if (pathname==='/pilot/') {
        // Only the exact local import-map bytes are allowed inline. No unsafe-inline.
        const match=bytes.toString('utf8').match(/<script type="importmap">([^<]+)<\/script>/);
        if (!match) throw new Error('Missing local 3D import map.');
        scriptPolicy+=` 'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`;
      }
      if (pathname==='/pilot/data.json') {
        const currentPlan=await readFile(path.join(root,'docs/guil_2050_plan.json'));
        const scene=JSON.parse(bytes);
        if (scene.provenance?.planSha256!==createHash('sha256').update(currentPlan).digest('hex')) {
          res.writeHead(409,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});
          res.end('3D 데이터의 2D 기준이 바뀌었습니다. npm.cmd run build:pilot으로 다시 생성하십시오.'); return;
        }
      }
      res.writeHead(200,{
        'Content-Type':types[path.extname(actual)], 'Content-Length':bytes.length,
        'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':`default-src 'self'; ${scriptPolicy}; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`
      });
      res.end(req.method==='HEAD'?undefined:bytes);
    } catch {
      res.writeHead(500,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});
      res.end(pathname.startsWith('/runtime/') ? '기존 Three.js 0.180.0 파일이 없습니다. 패키지 설치 승인 후 실행할 수 있습니다.'
        : pathname.startsWith('/pilot/') ? '3D 자료가 없습니다. npm.cmd run build:pilot으로 생성하십시오.' : 'Missing project file. Run npm run build:map.');
    }
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
