import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {buildPlan, contains, planSvg, readCrossProfileInputs} from '../tools/build_2050_plan.mjs';

const sourceBytes=await readFile(new URL('../docs/guro1_plan_2d.geojson',import.meta.url));
const source=JSON.parse(sourceBytes.toString());
const sourceHash=createHash('sha256').update(sourceBytes).digest('hex');
const plan=JSON.parse(await readFile(new URL('../docs/guil_2050_plan.json',import.meta.url),'utf8'));
const widthData=JSON.parse(await readFile(new URL('../docs/guil_road_widths.json',import.meta.url),'utf8'));
const surfaceBytes=await readFile(new URL('../docs/reference/guil_ngii_road_surfaces.geojson',import.meta.url));
const roadSurveyData={surfaces:JSON.parse(surfaceBytes),sections:JSON.parse(await readFile(new URL('../docs/reference/guil_ngii_road_sections.json',import.meta.url),'utf8')),surfaceSha256:createHash('sha256').update(surfaceBytes).digest('hex')};
Object.assign(roadSurveyData,await readCrossProfileInputs());

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
  assert.match(plan.features.find(f=>f.id==='way/252997596').name,/자이 2차/);
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
    if (building.id==='way/253000688') {
      assert.equal(zone.sourceId,'way/439886810');
      assert.equal(building.spatialZoneId,'2050/way/439886809');
      assert.equal(building.complexAssignmentStatus,'official_membership_override_source_parcel_conflict');
      assert.equal(building.complexMembershipEvidence.reference,'https://www.guro.go.kr/www/contents.do?key=1956');
      assert.deepEqual(building.geometry,source.features.find(f=>String(f.id)===building.id).properties.local_geometry_m);
      assert.ok(building.geometry.coordinates[0].every(p=>contains(p,byZone.get(building.spatialZoneId).geometry)));
      assert.ok(building.geometry.coordinates[0].some(p=>!contains(p,zone.geometry)));
      continue;
    }
    if (building.geometry.type==='Polygon') for (const p of building.geometry.coordinates[0]) assert.ok(contains(p,zone.geometry),`${building.id} outside ${zone.id}`);
  }
  assert.ok(plan.notices.some(n=>n.includes('출입구')));
});
test('each existing residential parcel has exactly one future compound with unique building membership',()=>{
  const parcelIds=source.features.filter(f=>f.properties.osm_tags?.landuse==='residential').map(f=>String(f.id));
  const compounds=plan.residentialComplexes;
  assert.equal(parcelIds.length,15);
  assert.equal(compounds.length,19);
  assert.equal(new Set(compounds.map(c=>c.id)).size,19);
  assert.equal(new Set(compounds.map(c=>c.sourceId)).size,19);
  assert.deepEqual(compounds.filter(c=>c.zoneId).map(c=>c.sourceId).sort(),parcelIds.sort());
  const byFeature=new Map(plan.features.map(f=>[f.id,f]));
  const byZone=new Map(plan.zones.map(z=>[z.id,z]));
  const memberOwners=new Map();
  for (const compound of compounds) {
    assert.equal(compound.id,`complex/${compound.sourceId}`);
    assert.ok(source.features.some(f=>String(f.id)===compound.sourceId));
    assert.ok(compound.memberFeatureIds.length>0);
    if (compound.zoneId) {
      const zone=byZone.get(compound.zoneId);
      assert.equal(zone.sourceId,compound.sourceId);
      assert.equal(zone.complexId,compound.id);
      assert.equal(zone.name,compound.futureName);
      assert.equal(zone.brand,compound.brand);
      assert.equal(zone.housingType,compound.housingType);
      assert.equal(zone.complexPreservation,'one_existing_compound_one_future_identity_no_merge_or_split');
    }
    for (const id of compound.memberFeatureIds) {
      assert.equal(memberOwners.has(id),false,`${id} belongs to more than one compound`);
      memberOwners.set(id,compound.id);
      const feature=byFeature.get(id);
      assert.equal(feature?.category,'building');
      assert.equal(feature.complexId,compound.id);
      const programmeZone=byZone.get(feature.zoneId);
      if (programmeZone?.kind==='residential') assert.equal(programmeZone.complexId,compound.id);
      else if (feature.zoneId) assert.equal(programmeZone.kind,'commercial');
      else assert.equal(compound.zoneId,null);
    }
  }
  for (const feature of plan.features.filter(f=>f.category==='building'&&f.complexId)) assert.equal(memberOwners.get(feature.id),feature.complexId);
});
test('official Jugong phases preserve 101–113 and 114–119 independently, including the documented 119 conflict',()=>{
  const first=plan.residentialComplexes.find(c=>c.sourceId==='way/439886812');
  const second=plan.residentialComplexes.find(c=>c.sourceId==='way/439886810');
  assert.notEqual(first.id,second.id);
  assert.equal(first.familyId,'family/guro-jugong');
  assert.equal(second.familyId,first.familyId);
  assert.equal(first.sourcePhase,1);
  assert.equal(second.sourcePhase,2);
  assert.match(first.futureName,/자이 1차/);
  assert.match(second.futureName,/자이 2차/);
  const sourceById=new Map(source.features.map(f=>[String(f.id),f]));
  const numbers=compound=>compound.memberFeatureIds.map(id=>Number(sourceById.get(id).properties.name)).sort((a,b)=>a-b);
  assert.deepEqual(numbers(first),Array.from({length:13},(_,i)=>101+i));
  assert.deepEqual(numbers(second),Array.from({length:6},(_,i)=>114+i));
  const building=plan.features.find(f=>f.id==='way/253000688');
  assert.equal(sourceById.get(building.id).properties.name,'119');
  assert.equal(building.zoneId,second.zoneId);
  assert.equal(building.complexId,second.id);
  assert.equal(building.spatialZoneId,'2050/way/439886809');
  assert.equal(building.complexMembershipEvidence.sourceId,second.sourceId);
  assert.equal(building.complexMembershipEvidence.reference,'https://www.guro.go.kr/www/contents.do?key=1956');
  assert.ok(plan.sources.some(s=>s.url===building.complexMembershipEvidence.reference));
  assert.equal(plan.residentialComplexes.find(c=>c.sourceId==='way/439886809').memberFeatureIds.includes(building.id),false);
  assert.deepEqual(plan.features.filter(f=>f.complexMembershipEvidence).map(f=>f.id),['way/253000688']);
});
test('officetel compounds retain one identity across towers and mixed-use annexes',()=>{
  for (const [sourceId,name,members] of [
    ['way/439886814','아이파크 오피스텔',['way/252997577','way/252997578']],
    ['way/901730989','롯데캐슬 오피스텔',['north/queens-main','north/queens-west-annex']]
  ]) {
    const compound=plan.residentialComplexes.find(c=>c.sourceId===sourceId);
    assert.equal(compound.housingType,'officetel');
    assert.ok(compound.futureName.includes(name));
    assert.deepEqual(compound.memberFeatureIds.slice().sort(),members.sort());
    for (const id of members) assert.equal(plan.features.find(f=>f.id===id).complexId,compound.id);
  }
  const annex=plan.features.find(f=>f.id==='north/queens-west-annex');
  assert.equal(annex.zoneId,'2050/north/queens-west-annex');
  const annexZone=plan.zones.find(z=>z.id===annex.zoneId);
  assert.equal(annexZone.kind,'commercial');
  assert.equal(annexZone.complexId,annex.complexId);
  assert.equal(annexZone.complexAssociationStatus,'spatial_program_association_actual_annex_membership_unverified');
  assert.equal(annex.complexAssignmentStatus,'source_parcel_membership_not_cadastral_verification');
  assert.equal(annex.complexMembershipEvidence,null);
  assert.equal(plan.features.find(f=>f.id==='way/840259337').sourceUse.building,'garage');
});
test('independent residential references remain unmerged and unnamed apartment identities remain unresolved',()=>{
  const ids=['way/252997564','way/252997565','way/253001672','north/hyeonjin-B'];
  assert.deepEqual(plan.residentialComplexes.filter(c=>c.zoneId===null).map(c=>c.sourceId).sort(),ids.sort());
  for (const id of ids) {
    const compound=plan.residentialComplexes.find(c=>c.sourceId===id);
    const feature=plan.features.find(f=>f.id===id);
    assert.equal(compound.brand,null);
    assert.equal(compound.housingType,'residential_reference');
    assert.equal(compound.boundaryStatus,'building_footprint_only_full_compound_extent_unverified');
    assert.deepEqual(compound.memberFeatureIds,[id]);
    assert.equal(feature.zoneId,null);
    assert.equal(feature.complexId,compound.id);
    assert.equal(feature.complexAssignmentStatus,'independent_reference_full_compound_extent_unverified');
    assert.match(feature.name,/명칭 미정/);
    assert.deepEqual(feature.geometry,source.features.find(f=>String(f.id)===id).properties.local_geometry_m);
    assert.equal(plan.zones.some(z=>z.sourceId===id),false);
  }
  const unresolved=plan.features.filter(f=>f.complexAssignmentStatus==='unresolved_do_not_merge');
  assert.deepEqual(unresolved.map(f=>f.id).sort(),['way/252997585','way/1450064672','way/1450066263','way/1450066264','way/1450066265'].sort());
  assert.ok(unresolved.every(f=>f.zoneId===null&&f.complexId===null));
});
test('compound membership is stable under source feature reordering and rejects a missing official override anchor',()=>{
  const reversed=structuredClone(source);
  reversed.features.reverse();
  const rebuilt=buildPlan(reversed,sourceHash);
  const memberships=p=>p.features.map(f=>[f.id,f.zoneId,f.spatialZoneId,f.complexId,f.complexAssignmentStatus]).sort((a,b)=>a[0].localeCompare(b[0]));
  assert.deepEqual(memberships(rebuilt),memberships(buildPlan(source,sourceHash)));
  const missing119=structuredClone(source);
  missing119.features=missing119.features.filter(f=>String(f.id)!=='way/253000688');
  assert.throws(()=>buildPlan(missing119,sourceHash),/Verified complex membership anchor missing/);
  const invalid119=structuredClone(source);
  invalid119.features.find(f=>String(f.id)==='way/253000688').properties.category='landuse';
  assert.throws(()=>buildPlan(invalid119,sourceHash),/Verified complex membership anchor missing/);
  const renamed119=structuredClone(source);
  renamed119.features.find(f=>String(f.id)==='way/253000688').properties.name='201';
  assert.throws(()=>buildPlan(renamed119,sourceHash),/Verified complex membership anchor missing/);
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
test('15 compounds have distinct creative architectural identities beyond facade colour',()=>{
  const proposed=buildPlan(source,sourceHash);
  const residential=proposed.zones.filter(zone=>zone.kind==='residential');
  assert.equal(residential.length,15);
  assert.equal(new Set(residential.map(zone=>zone.architectureIdentity.id)).size,15);
  assert.equal(new Set(residential.map(zone=>zone.architectureIdentity.name)).size,15);
  const keys=['dwellingModule','facadeRhythm','podium','skyLandscape','roofLandscape'];
  for (const zone of residential) {
    const identity=zone.architectureIdentity;
    assert.equal(identity.status,'fictional_2050_design_proposal_not_brand_product');
    assert.equal(identity.consistencyRule,'same_compound_shared_modules_and_materials_no_merge_or_split');
    assert.deepEqual(identity.features.map(feature=>feature.key),keys);
    assert.ok(identity.features.every(feature=>feature.label && feature.description.length>10));
    assert.match(identity.note,/치수/);
    assert.match(identity.note,/세대수.*허가사항.*확정하지/);
    assert.equal(proposed.residentialComplexes.find(compound=>compound.id===zone.complexId).architectureIdentityId,identity.id);
  }
  for (const key of keys) assert.equal(new Set(residential.map(zone=>zone.architectureIdentity.features.find(feature=>feature.key===key).description)).size,15);
  assert.ok(proposed.zones.filter(zone=>zone.kind!=='residential').every(zone=>!zone.architectureIdentity));
  assert.ok(proposed.residentialComplexes.filter(compound=>!compound.zoneId).every(compound=>!compound.architectureIdentityId));
});
test('Xi phases share an architectural family while retaining separate terrace and garden designs',()=>{
  const proposed=buildPlan(source,sourceHash);
  const first=proposed.zones.find(zone=>zone.sourceId==='way/439886812').architectureIdentity;
  const second=proposed.zones.find(zone=>zone.sourceId==='way/439886810').architectureIdentity;
  assert.equal(first.familyId,'architecture/xi-living');
  assert.equal(second.familyId,first.familyId);
  assert.notEqual(first.id,second.id);
  assert.equal(second.id,'g05-living-terraces');
  assert.equal(second.name,'생활 테라스형');
  const descriptions=Object.fromEntries(second.features.map(feature=>[feature.key,feature.description]));
  assert.match(descriptions.dwellingModule,/넓은 세대 창호/);
  assert.match(descriptions.facadeRhythm,/쌍으로 묶인 발코니/);
  assert.match(descriptions.podium,/따뜻한 석재/);
  assert.match(descriptions.skyLandscape,/6층 간격.*창작 시안/);
  assert.match(descriptions.roofLandscape,/옥상 정원/);
  assert.notDeepEqual(first.features,second.features);
});
test('architectural identities preserve baseline geometry, membership, schools and road metadata',()=>{
  const proposed=buildPlan(source,sourceHash,widthData,roadSurveyData);
  assert.deepEqual(proposed.features,plan.features);
  assert.deepEqual(proposed.boundary,plan.boundary);
  assert.deepEqual(proposed.roadSurvey,plan.roadSurvey);
  assert.deepEqual(proposed.metadata.roadWidths,plan.metadata.roadWidths);
  for (const zone of proposed.zones) {
    const existing=plan.zones.find(entry=>entry.id===zone.id);
    assert.deepEqual(zone.geometry,existing.geometry);
    assert.equal(zone.complexId,existing.complexId);
    assert.equal(zone.sourcePhase,existing.sourcePhase);
    if (zone.kind==='school') assert.deepEqual(zone,existing);
  }
  const membership=compound=>({id:compound.id,sourceId:compound.sourceId,zoneId:compound.zoneId,memberFeatureIds:compound.memberFeatureIds});
  assert.deepEqual(proposed.residentialComplexes.map(membership),plan.residentialComplexes.map(membership));
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
  assert.deepEqual(buildPlan(source,sourceHash,widthData,roadSurveyData),plan);
  const svg=planSvg(plan); assert.match(svg,/clipPath/); assert.match(svg,/N ↑/); assert.match(svg,/ODbL/); assert.doesNotMatch(svg,/NaN|undefined/);
});
test('official road and walkway surfaces remain separate from the unchanged baseline',()=>{
  assert.equal(plan.roadSurvey.tileIds.length,13);
  assert.equal(plan.roadSurvey.scale,'1:1000');
  assert.equal(plan.roadSurvey.sourceYear,2025);
  assert.equal(plan.roadSurvey.surfaces.length,1287);
  assert.equal(plan.metadata.roadWidths.sectionSummary.estimatedCarriagewaySections,0);
  assert.equal(plan.metadata.roadWidths.sectionSummary.estimatedWalkwaySections,29);
  assert.equal(plan.features.flatMap(feature=>feature.roadWidthOfficialSections||[]).length,357);
  const measured=plan.features.flatMap(feature=>feature.roadWidthSegments||[]);
  assert.equal(measured.length,29);
  assert.ok(measured.every(section=>section.widthKind==='walkway'&&section.rangeStatus==='observed_section_variation_not_statistical_accuracy'));
  assert.ok(plan.features.filter(feature=>feature.category==='road').every(feature=>feature.roadWidthM==null));
  assert.match(planSvg(plan),/data-survey-id="ngii\//);
  assert.throws(()=>buildPlan(source,sourceHash,widthData,{...roadSurveyData,sections:{...roadSurveyData.sections,sourceSha256:'wrong'}}),/different source/);
  assert.throws(()=>buildPlan(source,sourceHash,widthData,{...roadSurveyData,surfaceSha256:'wrong'}),/different surface file checksum/);
  const missingEvidence=structuredClone(roadSurveyData);
  const referencedId=missingEvidence.sections.records.flatMap(record=>record.segments)[0].evidenceIds[0];
  missingEvidence.surfaces.features=missingEvidence.surfaces.features.filter(feature=>feature.id!==referencedId);
  assert.throws(()=>buildPlan(source,sourceHash,widthData,missingEvidence),/missing surface evidence/);
});
test('width survey covers every road/path line without converting administrative widths into carriageway widths',()=>{
  const roads=plan.features.filter(f=>['road','path'].includes(f.category)&&['LineString','MultiLineString'].includes(f.geometry.type));
  assert.equal(roads.length,244);
  assert.equal(plan.metadata.roadWidths.recordCount,244);
  for (const road of roads) {
    const record=widthData.records.find(r=>r.sourceId===road.id);
    assert.ok(record);
    assert.equal(road.roadWidthM,record.widthM);
    assert.equal(road.roadWidthStatus,record.status);
    assert.deepEqual(road.roadWidthOfficialReferenceIds,record.officialReferenceIds);
  }
  assert.throws(()=>buildPlan(source,sourceHash,{...widthData,sourceSha256:'wrong'}),/different source/);
});

test('bounded road surface widths keep metric samples and never populate carriageway widths',()=>{
  const sections=plan.features.flatMap(feature=>feature.roadSurfaceSections || []);
  assert.equal(sections.length,166);
  assert.equal(plan.metadata.roadWidths.sectionSummary.roadSurfaceReferenceFeatures,24);
  assert.ok(Math.abs(sections.reduce((sum,section)=>sum+section.endM-section.startM,0)-3315.38907)<1e-5);
  const byEvidence=new Map(roadSurveyData.surfaces.features.map(feature=>[feature.id,feature]));
  for (const section of sections) {
    assert.equal(section.widthKind,'road_surface_reference');
    assert.equal(section.status,'geometry_estimate_not_verified_carriageway');
    assert.equal(section.distanceBasis,'native_projected_metres');
    assert.equal(section.errorM,null);
    assert.ok(section.evidenceIds.every(id=>byEvidence.get(id)?.properties.surfaceKind==='road_corridor'));
    assert.ok(section.crossSections.length>=3);
    assert.ok(section.crossSections.every(sample=>sample.line.length===2&&sample.line.every(point=>point.length===2&&point.every(Number.isFinite))));
  }
  assert.ok(plan.features.filter(feature=>feature.roadWidthStatus).every(feature=>feature.roadWidthM===null));
  const guil4=plan.features.find(feature=>feature.id==='way/252921539');
  assert.equal(guil4.roadSurfaceSections.length,12);
  assert.ok(guil4.roadSurfaceSections.some(section=>section.widthM>20&&section.widthM<20.2));
  assert.ok(guil4.roadSurfaceSections.some(section=>section.widthM>17.8&&section.widthM<18));
});

test('road surface integration rejects missing evidence, semantic promotion and invalid samples',()=>{
  const mutateSection=change=>{
    const altered=structuredClone(roadSurveyData);
    const section=altered.sections.records.flatMap(record=>record.roadSurfaceSections)[0];
    change(section);
    return altered;
  };
  assert.throws(()=>buildPlan(source,sourceHash,widthData,mutateSection(section=>section.evidenceIds=['ngii/missing'])),/missing surface evidence/);
  assert.throws(()=>buildPlan(source,sourceHash,widthData,mutateSection(section=>section.evidenceIds=[roadSurveyData.surfaces.features.find(feature=>feature.properties.surfaceKind==='walkway').id])),/road polygon evidence/);
  assert.throws(()=>buildPlan(source,sourceHash,widthData,mutateSection(section=>section.widthKind='carriageway')),/meaning or metric basis/);
  assert.throws(()=>buildPlan(source,sourceHash,widthData,mutateSection(section=>section.distanceBasis='local_reference_metres')),/meaning or metric basis/);
  assert.throws(()=>buildPlan(source,sourceHash,widthData,mutateSection(section=>section.widthM=-1)),/width or interval/);
  assert.throws(()=>buildPlan(source,sourceHash,widthData,mutateSection(section=>section.rangeM=[section.widthM+1,section.widthM+2])),/observed range/);
  assert.throws(()=>buildPlan(source,sourceHash,widthData,mutateSection(section=>section.samples[0].crossSectionLocalM[0][0]=NaN)),/geometry or samples/);
  const duplicate=structuredClone(roadSurveyData);
  const owner=duplicate.sections.records.find(record=>record.roadSurfaceSections.length);
  owner.roadSurfaceSections.push(structuredClone(owner.roadSurfaceSections[0]));
  assert.throws(()=>buildPlan(source,sourceHash,widthData,duplicate),/duplicate road surface section/);
});

test('reviewed cross-profiles stay in their exact 20m or 5m scopes and never assign whole-road widths',()=>{
  const profiles=plan.features.flatMap(feature=>feature.roadCrossProfiles||[]);
  assert.equal(profiles.length,roadSurveyData.profileCandidates.selected_roads.length);
  assert.equal(plan.metadata.roadWidths.crossProfileSummary.reviewedNativeSectionLengthM,profiles.reduce((sum,profile)=>sum+profile.endAlongSegmentM-profile.startAlongSegmentM,0));
  assert.equal(plan.metadata.roadWidths.crossProfileSummary.sampleCount,profiles.reduce((sum,profile)=>sum+profile.samples.length,0));
  assert.equal(profiles.filter(profile=>profile.endAlongSegmentM-profile.startAlongSegmentM===20).length,9);
  assert.equal(plan.metadata.roadWidths.crossProfileSummary.reviewedNativeSectionLengthM,185);
  assert.equal(plan.metadata.roadWidths.crossProfileSummary.sampleCount,38);
  assert.equal(plan.metadata.roadWidths.crossProfileSummary.groundMeasuredWidthCount,0);
  assert.equal(plan.metadata.roadWidths.crossProfileSummary.parentWayWidthsAssigned,0);
  const initialIds=new Set(['way/252921539/curb-profile/part-0/segment-0/42.5-62.5','way/520810607/curb-profile/part-0/segment-0/27.5-47.5','way/520810608/curb-profile/part-0/segment-1/47.5-67.5','way/252921546/curb-profile/part-0/segment-1/22.5-42.5']);
  const initialProfiles=profiles.filter(profile=>initialIds.has(profile.id));
  assert.equal(initialProfiles.length,4);
  const values=new Map(initialProfiles.map(profile=>[profile.roadName,profile.components.find(component=>component.kind==='carriageway').widthM]));
  assert.ok(Math.abs(values.get('구일로4길')-13.7335)<.001);
  assert.ok(Math.abs(values.get('구일로8길')-7)<.002);
  assert.ok(Math.abs(values.get('구일로10길')-11.3165)<.02);
  assert.ok(Math.abs(values.get('구일로')-8)<.002);
  assert.ok(profiles.filter(profile=>profile.endAlongSegmentM-profile.startAlongSegmentM===20).every(profile=>profile.review.imageryDate==='2026-07'&&profile.samples.length===4));
  const south=profiles.find(profile=>profile.id==='way/555380145/curb-profile/part-0/segment-16/40-45');
  assert.ok(south);
  assert.equal(south.review.imageryDate,'2025-07');
  assert.equal(south.review.observedOn,'2026-10-06');
  assert.equal(south.samples.length,2);
  assert.ok(south.nativeInteriorAudit.checks.length>=101);
  assert.equal(new Set(profiles.map(profile=>profile.id)).size,profiles.length);
  for (const profile of profiles) {
    assert.ok([5,20].includes(profile.endAlongSegmentM-profile.startAlongSegmentM));
    assert.equal(profile.components.find(component=>component.kind==='carriageway').errorM,null);
    assert.ok(profile.samples.every(sample=>sample.carriagewayLineLocalM!==null));
    assert.equal(profile.endpointChecks.length,2);
    assert.deepEqual(profile.endpointChecks.map(check=>check.alongOriginalSegmentM),[profile.startAlongSegmentM,profile.endAlongSegmentM]);
    assert.ok(profile.endpointChecks.every(check=>check.carriagewayLineLocalM!==null));
  }
  assert.ok(plan.features.filter(feature=>feature.roadWidthStatus).every(feature=>feature.roadWidthM===null));
  assert.match(planSvg(plan),/data-component="carriageway"/);
  const corrupted=structuredClone(roadSurveyData);
  corrupted.verifiedImageHashes[corrupted.curbReviews.records[0].images[0].path]='0'.repeat(64);
  assert.throws(()=>buildPlan(source,sourceHash,widthData,corrupted),/image hash/);
  const unreviewed=structuredClone(roadSurveyData); unreviewed.curbReviews.records=[];
  const candidatePlan=buildPlan(source,sourceHash,widthData,unreviewed);
  assert.equal(candidatePlan.metadata.roadWidths.crossProfileSummary.visuallyReviewedProfileCount,0);
  assert.ok(candidatePlan.features.flatMap(feature=>feature.roadCrossProfiles||[]).every(profile=>profile.components.find(component=>component.kind==='carriageway').widthM===null));
});

test('deferred width evidence remains visible without promoting an ambiguous aerial click into a road width',()=>{
  const northwest=plan.features.find(feature=>feature.id==='way/252921537');
  const scope=northwest.roadWidthDeferrals.find(scope=>scope.startAlongSegmentM===52.5);
  assert.equal(scope.actualCarriagewayWidthM,null);
  assert.equal(scope.manualAerialCandidate.distanceM,12.1);
  assert.equal(scope.manualAerialCandidate.exactGroundEndpointCoordinates,null);
  assert.equal(scope.status,'deferred_not_promoted');
  assert.equal(scope.images.length,6);
  assert.match(scope.summaryKo,/미확인/);
  assert.equal(northwest.roadWidthM,null);
  assert.ok(!northwest.roadCrossProfiles?.some(profile=>profile.id===scope.id));
  const corrupt=structuredClone(roadSurveyData);
  corrupt.verifiedImageHashes[scope.images[0].path]='0'.repeat(64);
  assert.throws(()=>buildPlan(source,sourceHash,widthData,corrupt),/Deferred width image hash/);
  const promoted=structuredClone(roadSurveyData);
  promoted.curbReviews.deferredScopes.find(value=>value.id===scope.id).actualCarriagewayWidthM=12.1;
  assert.throws(()=>buildPlan(source,sourceHash,widthData,promoted),/deferred scope cannot supply/);
});

test('east rail space is a 2050 station concept without fabricated station geometry or altered references',()=>{
  assert.equal(plan.transportConcept.status,'user_proposed_2050_concept_not_an_existing_station');
  assert.deepEqual(plan.transportConcept.geometry,source.features.find(feature=>String(feature.id)==='way/311747059').properties.local_geometry_m);
  assert.equal(plan.transportConcept.stationBuildingGeometry,null);
  assert.equal(plan.transportConcept.platformLayout,null);
  assert.equal(plan.transportConcept.entrances,null);
  assert.equal(plan.transportConcept.verticalConfiguration,null);
  assert.ok(plan.anchors.some(anchor=>anchor.id==='way/311747059'&&anchor.name.includes('지하철역')&&anchor.name.includes('구상')));
  assert.match(plan.features.find(feature=>feature.id==='way/311747059').futureUse,/2050 창작 구상/);
});
