import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from '../server.mjs';

test('new plan routes, legacy redirect and private-file/method boundaries',async()=>{
  const server=createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    for (const route of ['/','/style.css','/map.mjs','/plan2050.json','/plan2050.svg']) {
      const response=await fetch(base+route); assert.equal(response.status,200,route);
      assert.match(response.headers.get('content-security-policy'),/script-src 'self'/);
      assert.equal(response.headers.get('cache-control'),'no-store'); assert.ok((await response.text()).length>10);
    }
    const legacy=await fetch(base+'/shinyeong/?building=114',{redirect:'manual'});
    assert.equal(legacy.status,302); assert.equal(legacy.headers.get('location'),'/');
    for (const route of ['/.git/config','/package.json','/game.mjs','/prototype/scene.json','/%2e%2e/.git/config']) assert.equal((await fetch(base+route)).status,404,route);
    assert.equal((await fetch(base+'/',{method:'POST'})).status,405);
    const head=await fetch(base+'/plan2050.json',{method:'HEAD'}); assert.equal(head.status,200); assert.equal(await head.text(),'');
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});
