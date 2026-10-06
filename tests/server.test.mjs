import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
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

test('local 3D preview serves only its assets with a hashed import map and metre source data',async()=>{
  const server=createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const htmlResponse=await fetch(base+'/pilot/');
    assert.equal(htmlResponse.status,200);
    const html=await htmlResponse.text();
    const policy=htmlResponse.headers.get('content-security-policy');
    const importMap=html.match(/<script type="importmap">([^<]+)<\/script>/)?.[1];
    assert.ok(importMap);
    assert.ok(policy.includes(`'sha256-${createHash('sha256').update(importMap).digest('base64')}'`));
    assert.ok(!policy.includes('unsafe-inline') && !policy.includes('unsafe-eval'));
    assert.deepEqual(JSON.parse(importMap).imports,{
      three:'/runtime/three/three.module.js',
      'three/addons/controls/OrbitControls.js':'/runtime/three/OrbitControls.js'
    });
    for(const route of ['/pilot/style.css','/pilot/view.mjs','/pilot/geometry.mjs','/pilot/architecture.mjs','/pilot/pilot-geometry.mjs','/pilot/apartment-modules.mjs','/pilot/entrance-access.mjs','/pilot/pilot-environment.mjs','/runtime/three/three.module.js','/runtime/three/three.core.js','/runtime/three/OrbitControls.js']) {
      const response=await fetch(base+route); assert.equal(response.status,200,route);
      assert.ok((await response.text()).length>100);
      assert.equal(response.headers.get('cache-control'),'no-store');
      if(route.endsWith('.js')||route.endsWith('.mjs')) assert.match(response.headers.get('content-type'),/^text\/javascript/);
    }
    const data=await fetch(base+'/pilot/data.json'); assert.equal(data.status,200);
    const scene=await data.json(); assert.equal(scene.units,'metres'); assert.equal(scene.building.sourceId,'way/252997590');
    assert.equal(scene.referenceHuman.heightM,1.8); assert.equal(scene.roadProfiles.length,2);
    assert.equal(scene.futureDesign.validation.status,'passed');
    assert.equal(scene.futureDesign.siteComplexId,scene.building.complexId);
    for(const route of ['/runtime/three/package.json','/runtime/three/../../package.json','/node_modules/three/package.json','/pilot/../.git/config','/pilot/source.geojson','/tools/pilot_scene.mjs']) assert.equal((await fetch(base+route)).status,404,route);
    assert.equal((await fetch(base+'/pilot/data.json',{method:'POST'})).status,405);
    const head=await fetch(base+'/pilot/data.json',{method:'HEAD'}); assert.equal(head.status,200); assert.equal(await head.text(),'');
  } finally {server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));}
});
