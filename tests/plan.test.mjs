import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {buildPlan, contains, planSvg} from '../tools/build_2050_plan.mjs';

const sourceBytes=await readFile(new URL('../docs/guro1_plan_2d.geojson',import.meta.url));
const source=JSON.parse(sourceBytes.toString());
const sourceHash=createHash('sha256').update(sourceBytes).digest('hex');
const plan=JSON.parse(await readFile(new URL('../docs/guil_2050_plan.json',import.meta.url),'utf8'));

test('all 755 source IDs/geometries and the baseline checksum are preserved',()=>{
  assert.equal(sourceHash,'f4081a9a33fa0f622ce7174fce5f2a3381291c5fba8d5c152a9e609f87ad7f43');
  assert.equal(plan.sourceSha256,sourceHash);
  assert.equal(plan.features.length,755);
  assert.equal(new Set(plan.features.map(f=>f.id)).size,755);
  for (const feature of source.features) {
    const derived=plan.features.find(f=>f.id===String(feature.id));
    assert.deepEqual(derived.geometry,feature.properties.local_geometry_m);
    assert.equal(derived.category,feature.properties.category);
  }
  assert.deepEqual(plan.boundary.coordinates[0],source.metadata.local_provisional_boundary_m);
});
test('future parcels retain their source geometry and label inside both parcel and boundary',()=>{
  assert.deepEqual([plan.stats.residentialZones,plan.stats.schools],[15,3]);
  assert.equal(plan.stats.commercialZones,8);
  for (const zone of plan.zones) {
    assert.deepEqual(zone.geometry,source.features.find(f=>String(f.id)===zone.sourceId).properties.local_geometry_m);
    assert.ok(contains(zone.labelPoint,plan.boundary));
    assert.ok(contains(zone.labelPoint,zone.geometry));
    assert.equal(zone.undergroundStatus,'concept_zone_not_engineering_layout');
    assert.equal(zone.heightM,null);
  }
});
test('114 and the old commercial anchor remain in place with the latest brand assignment',()=>{
  assert.match(plan.features.find(f=>f.id==='way/252997596').name,/자이 1단지/);
  assert.equal(plan.features.find(f=>f.id==='south/shinyeong-footprint').name,'구일 코어 2050');
  assert.equal(plan.zones.find(z=>z.sourceId==='way/439886810').underground[0],'새 지하주차장 계획');
});
test('new apartment labels use real brands and do not retain discarded fictional names',()=>{
  const residential=plan.zones.filter(z=>z.kind==='residential');
  assert.equal(new Set(residential.map(z=>z.brand)).size,8);
  for (const zone of residential) {
    assert.ok(plan.brandReferences.some(reference=>reference.name===zone.brand));
    assert.ok(zone.name.includes(zone.brand));
    assert.equal(zone.brandAssignmentStatus,'real_brand_fictional_2050_site_assignment');
  }
  const names=[...plan.features.map(f=>f.name),...plan.zones.map(z=>z.name),...plan.anchors.map(a=>a.name)];
  for (const name of names) assert.doesNotMatch(name,/주공|현대|우성|퀸즈|SK|GS25|신영|한신|노블리안|참마음|유앤아이|하이츠|넥서스|오르빗|루멘|프라이빗/);
});
test('building assignment does not expand parcel geometry or fabricate features',()=>{
  const byZone=new Map(plan.zones.map(z=>[z.id,z]));
  const buildings=plan.features.filter(f=>f.category==='building'&&f.zoneId&&f.id!==byZone.get(f.zoneId).sourceId);
  for (const building of buildings) {
    const zone=byZone.get(building.zoneId);
    if (building.geometry.type==='Polygon') for (const p of building.geometry.coordinates[0]) assert.ok(contains(p,zone.geometry),`${building.id} outside ${zone.id}`);
  }
  assert.ok(plan.notices.some(n=>n.includes('출입구')));
});
test('polygon holes and missing anchors have explicit handling',()=>{
  const geometry={type:'Polygon',coordinates:[[[0,0],[10,0],[10,10],[0,10],[0,0]],[[3,3],[7,3],[7,7],[3,7],[3,3]]]};
  assert.ok(contains([1,1],geometry)); assert.equal(contains([5,5],geometry),false); assert.equal(contains([15,1],geometry),false);
  const incomplete=structuredClone(source);
  incomplete.features=incomplete.features.filter(f=>String(f.id)!=='south/shinyeong-footprint');
  assert.throws(()=>buildPlan(incomplete,sourceHash),/Required anchor missing/);
});
test('every residential zone proposes low-level shops and a new underground car park',()=>{
  for (const zone of plan.zones.filter(z=>z.kind==='residential')) {
    assert.ok(zone.future.some(s=>s.includes('저층부 창작 상업')));
    assert.ok(zone.underground.includes('새 지하주차장 계획'));
  }
});
test('nonresidential annexes and pump facilities are not silently converted into apartments',()=>{
  const garage=plan.features.find(f=>f.id==='way/840259337');
  assert.equal(garage.sourceUse.building,'garage');
  assert.match(garage.name,/부속동/);
  assert.match(garage.futureUse,/미확정/);
  for (const id of ['south/pumping-central-roof','south/pumping-south-roof']) {
    const pump=plan.features.find(f=>f.id===id);
    assert.match(pump.name,/수자원/);
    assert.match(pump.futureUse,/미정/);
  }
});
test('build is deterministic and static export is clipped, north-up and attributed',()=>{
  assert.deepEqual(buildPlan(source,sourceHash),plan);
  const svg=planSvg(plan); assert.match(svg,/clipPath/); assert.match(svg,/N ↑/); assert.match(svg,/ODbL/); assert.doesNotMatch(svg,/NaN|undefined/);
});
