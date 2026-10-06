import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {buildPilotScene, toWebPoint, toUnrealPoint} from '../tools/pilot_scene.mjs';

const jsonFile = async path => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url)));
const plan = await jsonFile('docs/guil_2050_plan.json');
const source = await jsonFile('docs/guro1_plan_2d.geojson');
const surfaceSource = await jsonFile('docs/reference/guil_ngii_road_surfaces.geojson');
const buildingId = 'way/252997590';
const roadId = 'way/252921539';
const profileIds = [42.5, 62.5].map(start => `${roadId}/curb-profile/part-0/segment-0/${start}-${start + 20}`);
const target = plan.features.find(feature => feature.id === buildingId);
const originalProfiles = plan.features.find(feature => feature.id === roadId).roadCrossProfiles.filter(profile => profileIds.includes(profile.id));
const sourceNames = Object.fromEntries(source.features.map(feature => [String(feature.id), feature.properties.name ?? null]));
const build = input => buildPilotScene(input ?? plan, {sourceFeatureNames: sourceNames});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const pointsOf = geometry => geometry.coordinates.flat(geometry.type === 'Polygon' ? 1 : 2);
const bbox = geometry => {
  const points = pointsOf(geometry);
  return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
};
const inScope = (geometry, bounds) => {
  const [west, south, east, north] = bbox(geometry);
  return east >= bounds.minX && west <= bounds.maxX && north >= bounds.minY && south <= bounds.maxY;
};

test('pilot retains original 118 footprint, G05 membership and explicitly temporary scale assumptions', () => {
  const scene = build();
  assert.equal(scene.schema, 'guil-pilot3d.v1');
  assert.equal(scene.units, 'metres');
  assert.equal(scene.building.sourceId, buildingId);
  assert.equal(scene.building.sourceName, '118');
  assert.equal(scene.building.complexId, 'complex/way/439886810');
  assert.equal(scene.building.zoneId, '2050/way/439886810');
  assert.match(scene.building.name, /G05.*자이 2차/);
  assert.deepEqual(scene.building.geometryLocalM, target.geometry);
  assert.deepEqual(scene.building.geometryLocalM, source.features.find(feature => String(feature.id) === buildingId).properties.local_geometry_m);
  assert.equal(scene.building.geometryLocalM.coordinates[0].length, 5);
  assert.equal(scene.building.heightM, 48);
  assert.equal(scene.building.heightStatus, 'temporary_2050_design_not_existing_measurement');
  assert.equal(scene.ground.elevationM, 0);
  assert.equal(scene.ground.status, 'flat_ground_temporary_assumption_not_surveyed');
  assert.ok(scene.residentialComplexes.find(complex => complex.id === scene.building.complexId).memberFeatureIds.includes(buildingId));
  assert.equal(scene.restrictions.localOnly, true);
  assert.equal(scene.restrictions.publicationAllowed, false);
  assert.match(scene.notices.join('\n'), /원자료 비교 모델에는 출입구·계단·주차장·지하 상세를 생성하지 않습니다/);
  assert.equal(scene.futureDesign.validation.status, 'passed');
  assert.notDeepEqual(scene.futureDesign.building.geometryLocalM, scene.building.geometryLocalM);
  for (const key of ['entrances', 'stairs', 'parking', 'underground']) assert.equal(Object.hasOwn(scene, key), false);
});

test('scope adds 25m to building and original cross-section endpoints, retaining every intersecting full source shape', () => {
  const scene = build();
  const corePoints = [...pointsOf(target.geometry), ...originalProfiles.flatMap(profile => [...profile.samples, ...profile.endpointChecks].flatMap(sample => [sample.pointLocalM, ...['roadBoundaryLineLocalM', 'leftWalkwayLineLocalM', 'rightWalkwayLineLocalM', 'carriagewayLineLocalM'].flatMap(key => sample[key])]))];
  const expectedCore = {
    minX: Math.min(...corePoints.map(p => p[0])), minY: Math.min(...corePoints.map(p => p[1])),
    maxX: Math.max(...corePoints.map(p => p[0])), maxY: Math.max(...corePoints.map(p => p[1]))
  };
  assert.deepEqual(scene.scope.coreBoundsLocalM, expectedCore);
  assert.equal(scene.scope.marginM, 25);
  for (const key of ['minX', 'minY', 'maxX', 'maxY']) near(scene.scope.boundsLocalM[key], expectedCore[key] + (key.startsWith('min') ? -25 : 25));
  const bounds = scene.scope.boundsLocalM;
  assert.deepEqual(scene.coordinates.originLocalM, [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2]);
  assert.equal(scene.scope.renderClipping, 'gpu_scope_bounds_only');
  const expectedBuildings = plan.features.filter(feature => feature.category === 'building' && feature.id !== buildingId && inScope(feature.geometry, bounds));
  assert.deepEqual(scene.contextBuildings.map(feature => feature.sourceId), expectedBuildings.map(feature => feature.id));
  for (const building of scene.contextBuildings) {
    assert.deepEqual(building.geometryLocalM, expectedBuildings.find(feature => feature.id === building.sourceId).geometry);
    assert.deepEqual(building.geometryLocalM, source.features.find(feature => String(feature.id) === building.sourceId).properties.local_geometry_m);
    assert.equal(building.heightM, null);
    assert.equal(building.heightStatus, 'unknown_not_extruded');
  }
  const expectedZones = plan.zones.filter(zone => inScope(zone.geometry, bounds));
  assert.deepEqual(scene.contextZones.map(zone => zone.id), expectedZones.map(zone => zone.id));
  for (const zone of scene.contextZones) {
    assert.deepEqual(zone.geometryLocalM, expectedZones.find(item => item.id === zone.id).geometry);
    assert.equal(zone.heightM, null);
  }
  const expectedSurfaces = plan.roadSurvey.surfaces.filter(surface => ['walkway', 'road_corridor'].includes(surface.kind) && inScope(surface.geometry, bounds));
  assert.deepEqual(scene.surfaces.map(surface => surface.id), expectedSurfaces.map(surface => surface.id));
  for (const surface of scene.surfaces) {
    assert.deepEqual(surface.geometryLocalM, expectedSurfaces.find(item => item.id === surface.id).geometry);
    assert.deepEqual(surface.geometryLocalM, surfaceSource.features.find(feature => String(feature.id) === surface.id).properties.local_geometry_m);
  }
  assert.ok(scene.surfaces.some(surface => pointsOf(surface.geometryLocalM).some(point => point[0] < bounds.minX || point[0] > bounds.maxX || point[1] < bounds.minY || point[1] > bounds.maxY)), 'full intersecting surfaces must extend outside the GPU render bounds');
});

test('two reviewed native road intervals retain all fields and asymmetric original endpoints', () => {
  const scene = build();
  assert.deepEqual(scene.roadProfiles.map(profile => profile.id), profileIds);
  assert.deepEqual(scene.roadProfiles, originalProfiles);
  for (const profile of scene.roadProfiles) {
    assert.equal(profile.sourceId, roadId);
    assert.equal(profile.distanceBasis, 'native_projected_metres_along_original_segment');
    assert.equal(profile.samples.length, 4);
    assert.equal(profile.endpointChecks.length, 2);
    assert.equal(profile.components.length, 4);
    assert.equal(profile.reviewStatus, 'curb_layout_visually_reviewed');
    assert.equal(profile.components.find(component => component.kind === 'carriageway').errorM, null);
    for (const sample of [...profile.samples, ...profile.endpointChecks]) {
      const [a, b] = sample.roadBoundaryLineLocalM;
      const midpoint = a.map((value, axis) => (value + b[axis]) / 2);
      assert.ok(Math.hypot(midpoint[0] - sample.pointLocalM[0], midpoint[1] - sample.pointLocalM[1]) > 1, 'the source centreline is not a symmetric road-width centre');
    }
  }
  scene.roadProfiles[0].samples[0].pointLocalM[0] += 1;
  scene.roadProfiles[0].review.images[0].sha256 = 'changed only in output';
  assert.notDeepEqual(scene.roadProfiles[0], originalProfiles[0]);
  assert.deepEqual(build().roadProfiles, originalProfiles);
});

function distanceToFootprint(point) {
  const ring = target.geometry.coordinates[0];
  return Math.min(...ring.slice(1).map((b, index) => {
    const a = ring[index], dx = b[0] - a[0], dy = b[1] - a[1];
    const fraction = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(point[0] - (a[0] + fraction * dx), point[1] - (a[1] + fraction * dy));
  }));
}

test('1.8m human stands at the nearest confirmed sidewalk midpoint to the building footprint', () => {
  const human = build().referenceHuman;
  assert.equal(human.heightM, 1.8);
  assert.equal(human.eyeHeightM, 1.65);
  assert.equal(human.profileId, profileIds[0]);
  assert.equal(human.side, 'right');
  assert.equal(human.crossSectionIndex, 1);
  const confirmedLine = originalProfiles[0].samples[1].rightWalkwayLineLocalM;
  assert.deepEqual(human.crossSectionLocalM, confirmedLine);
  assert.deepEqual(human.positionLocalM, confirmedLine[0].map((value, axis) => (value + confirmedLine[1][axis]) / 2));
  near(human.positionLocalM[0], 642.0242);
  near(human.positionLocalM[1], 698.4560);
  near(human.distanceToBuildingM, 7.299702, 1e-6);
  near(human.distanceToBuildingM, distanceToFootprint(human.positionLocalM));
  for (const profile of originalProfiles) for (const sample of [...profile.samples, ...profile.endpointChecks]) for (const side of ['left', 'right']) {
    const line = sample[`${side}WalkwayLineLocalM`];
    const candidate = line[0].map((value, axis) => (value + line[1][axis]) / 2);
    assert.ok(distanceToFootprint(candidate) >= human.distanceToBuildingM - 1e-8);
  }
});

test('builder and coordinate conversions do not mutate input and use metres versus centimetres consistently', () => {
  const input = structuredClone(plan), before = structuredClone(input);
  const provenance = {sourceFeatureNames: sourceNames, evidenceFiles: [{path: 'fixture', sha256: 'fixture'}]};
  const provenanceBefore = structuredClone(provenance);
  const scene = buildPilotScene(input, provenance);
  assert.deepEqual(input, before);
  assert.deepEqual(provenance, provenanceBefore);
  scene.building.geometryLocalM.coordinates[0][0][0] += 10;
  scene.surfaces[0].geometryLocalM.coordinates[0][0][0] += 10;
  scene.residentialComplexes[0].memberFeatureIds.push('test-only');
  assert.deepEqual(input, before);
  const point = [107, 195], origin = [100, 200];
  assert.deepEqual(toWebPoint(point, origin, 48), [7, 48, 5]);
  assert.deepEqual(toUnrealPoint(point, origin, 48), [700, -500, 4800]);
  assert.deepEqual(toWebPoint([2, 3]), [2, 0, -3]);
  assert.deepEqual(toUnrealPoint([2, 3]), [200, 300, 0]);
  assert.deepEqual(point, [107, 195]);
  assert.deepEqual(origin, [100, 200]);
  assert.deepEqual(build(), build());
});

test('saved deterministic scene provenance matches every actual local input and evidence file', async () => {
  const saved = await jsonFile('docs/guil_2050_pilot3d.json');
  const unsigned = structuredClone(saved);
  delete unsigned.provenance.generationSha256;
  assert.equal(saved.provenance.generationSha256, hash(JSON.stringify(unsigned)));
  const provenance = structuredClone(saved.provenance);
  delete provenance.generationSha256;
  assert.deepEqual(buildPilotScene(plan, {...provenance, sourceFeatureNames: sourceNames, siteEvidence: saved.siteEvidence}), saved);
  const files = [
    {path: saved.provenance.sourceFile, sha256: saved.provenance.sourceSha256},
    {path: saved.provenance.planFile, sha256: saved.provenance.planSha256},
    {path: saved.provenance.surfaceFile, sha256: saved.provenance.surfaceSha256},
    saved.provenance.siteEvidenceFile, ...saved.provenance.generatorFiles, ...saved.provenance.evidenceFiles
  ];
  assert.equal(saved.provenance.evidenceFiles.length, 4);
  for (const file of files) assert.equal(hash(await readFile(new URL(`../${file.path}`, import.meta.url))), file.sha256, file.path);
});

test('site evidence stays detached and approximate analysis never becomes safety approval', async () => {
  const evidence = await jsonFile('docs/reference/guil_pilot_site_evidence.json');
  const before = structuredClone(evidence);
  const scene = buildPilotScene(plan, {sourceFeatureNames: sourceNames, siteEvidence: evidence});
  const analysis = scene.futureDesign.conceptAnalysis;
  assert.equal(analysis.sunlight.sunCases.length, 6);
  assert.deepEqual(analysis.neighbourMasses.map(item => item.storeys), [12, 12]);
  for (const mass of analysis.neighbourMasses) {
    assert.equal(mass.physicalHeightM, null); near(mass.heightM, 38.4);
    assert.deepEqual(mass.geometryLocalM, scene.contextBuildings.find(item => item.sourceId === mass.sourceId).geometryLocalM);
  }
  assert.equal(analysis.drainage.rainfallCases[1].ramp.inflowLitresPerSecond, 6);
  assert.equal(analysis.drainage.pumpCapacityLitresPerSecond, null);
  assert.equal(analysis.engineeringSafetyConclusion, 'not_assessed');
  assert.equal(analysis.wind.windSpeedMPerSecond, null);
  assert.deepEqual(analysis.wind.neighbourGapToHeight.map(item => item.sourceId), scene.contextBuildings.map(item => item.sourceId));
  assert.equal(scene.futureDesign.modules.layout.floorCount, 24);
  scene.siteEvidence.buildingEvidence[0].storeys = 999;
  assert.deepEqual(evidence, before);
  assert.equal(scene.provenance.siteEvidence, undefined);
});

test('invalid coordinates and incomplete/unreviewed pilot evidence fail closed', () => {
  for (const transform of [toWebPoint, toUnrealPoint]) {
    for (const point of [null, [1], [1, 2, 3], [NaN, 2], [1, Infinity], ['1', 2]]) assert.throws(() => transform(point));
    assert.throws(() => transform([1, 2], [0, NaN]));
    assert.throws(() => transform([1, 2], [0, 0], Infinity));
  }
  for (const change of [
    input => { input.features = input.features.filter(feature => feature.id !== buildingId); },
    input => { input.features.find(feature => feature.id === buildingId).complexId = 'wrong-complex'; },
    input => { input.residentialComplexes.find(complex => complex.id === target.complexId).memberFeatureIds = []; },
    input => { input.features.find(feature => feature.id === roadId).roadCrossProfiles.find(profile => profile.id === profileIds[0]).reviewStatus = 'pending'; },
    input => { input.features.find(feature => feature.id === roadId).roadCrossProfiles.find(profile => profile.id === profileIds[0]).evidence.sourceSha256 = 'wrong-hash'; },
    input => { input.features.find(feature => feature.id === roadId).roadCrossProfiles.find(profile => profile.id === profileIds[0]).samples[0].leftWalkwayLineLocalM = null; },
    input => { input.features.find(feature => feature.id === buildingId).geometry.coordinates[0][0][0] = NaN; },
    input => { input.roadSurvey.surfaces = []; }
  ]) {
    const input = structuredClone(plan);
    change(input);
    assert.throws(() => build(input));
  }
});
