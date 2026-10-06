import {createHash} from 'node:crypto';
import {buildFutureApartment} from './future_apartment.mjs';
import {buildPilotEnvironment} from '../web/pilot-environment.mjs';

export const PILOT_BUILDING_ID = 'way/252997590';
export const PILOT_ROAD_ID = 'way/252921539';
export const PILOT_PROFILE_IDS = [
  `${PILOT_ROAD_ID}/curb-profile/part-0/segment-0/42.5-62.5`,
  `${PILOT_ROAD_ID}/curb-profile/part-0/segment-0/62.5-82.5`
];

const finitePoint = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
const check = (condition, message) => { if (!condition) throw new Error(message); };
const clone = value => structuredClone(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');

function checkPoint(pointLocalM, originLocalM, heightM) {
  check(finitePoint(pointLocalM) && finitePoint(originLocalM) && Number.isFinite(heightM), 'Finite east/north local point, origin and height are required.');
}

/** Absolute source-plan E/N metres -> origin-relative Three.js X east / Y up / Z south metres. */
export function toWebPoint(pointLocalM, originLocalM = [0, 0], heightM = 0) {
  checkPoint(pointLocalM, originLocalM, heightM);
  return [pointLocalM[0] - originLocalM[0], heightM, originLocalM[1] - pointLocalM[1]];
}

/** Absolute source-plan E/N metres -> origin-relative Unreal X east / Y north / Z up centimetres. */
export function toUnrealPoint(pointLocalM, originLocalM = [0, 0], heightM = 0) {
  checkPoint(pointLocalM, originLocalM, heightM);
  return [(pointLocalM[0] - originLocalM[0]) * 100, (pointLocalM[1] - originLocalM[1]) * 100, heightM * 100];
}

function geometryPoints(geometry) {
  if (geometry?.type === 'Point') {
    check(finitePoint(geometry.coordinates), 'Pilot point reference is invalid.');
    return [geometry.coordinates];
  }
  check(['Polygon', 'MultiPolygon'].includes(geometry?.type), 'Pilot geometry must be Polygon or MultiPolygon.');
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  check(Array.isArray(polygons) && polygons.length > 0, 'Pilot polygon geometry is empty.');
  for (const polygon of polygons) {
    check(Array.isArray(polygon) && polygon.length > 0, 'Pilot polygon has no outer ring.');
    for (const ring of polygon) {
      check(Array.isArray(ring) && ring.length >= 4 && ring.every(finitePoint), 'Pilot polygon contains an invalid ring.');
      check(ring[0].every((value, axis) => value === ring.at(-1)[axis]), 'Pilot polygon ring must retain its closed source geometry.');
    }
  }
  return polygons.flat(2);
}

function boundsForPoints(points) {
  check(points.length > 0 && points.every(finitePoint), 'Cannot calculate bounds for invalid coordinates.');
  return {
    minX: Math.min(...points.map(point => point[0])), minY: Math.min(...points.map(point => point[1])),
    maxX: Math.max(...points.map(point => point[0])), maxY: Math.max(...points.map(point => point[1]))
  };
}

function intersects(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function insideRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    const cross = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
    if (Math.abs(cross) < 1e-8 && point[0] >= Math.min(a[0], b[0]) && point[0] <= Math.max(a[0], b[0]) && point[1] >= Math.min(a[1], b[1]) && point[1] <= Math.max(a[1], b[1])) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function contains(point, geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some(polygon => insideRing(point, polygon[0]) && !polygon.slice(1).some(hole => insideRing(point, hole)));
}

function distanceToGeometry(point, geometry) {
  if (contains(point, geometry)) return 0;
  let nearest = Infinity;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const ring of polygons.flat()) {
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1], b = ring[i];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
      nearest = Math.min(nearest, Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy));
    }
  }
  return nearest;
}

function profilePoints(profile) {
  return [...profile.samples, ...profile.endpointChecks].flatMap(sample =>
    [sample.pointLocalM, ...['roadBoundaryLineLocalM', 'leftWalkwayLineLocalM', 'rightWalkwayLineLocalM', 'carriagewayLineLocalM'].flatMap(key => {
      check(Array.isArray(sample[key]) && sample[key].length === 2 && sample[key].every(finitePoint), `${profile.id}: original ${key} endpoints are missing.`);
      return sample[key];
    })]);
}

function buildingRecord(feature, sourceNames, heightM = null) {
  return {
    sourceId: feature.id,
    sourceName: sourceNames[feature.id] ?? (feature.id === PILOT_BUILDING_ID ? '118' : null),
    name: feature.name,
    complexId: feature.complexId ?? null,
    zoneId: feature.zoneId ?? null,
    spatialZoneId: feature.spatialZoneId ?? null,
    complexAssignmentStatus: feature.complexAssignmentStatus ?? null,
    complexMembershipEvidence: clone(feature.complexMembershipEvidence ?? null),
    sourceUse: clone(feature.sourceUse),
    geometryLocalM: clone(feature.geometry),
    geometryStatus: feature.geometryStatus,
    heightM,
    heightStatus: heightM === null ? 'unknown_not_extruded' : 'temporary_2050_design_not_existing_measurement'
  };
}

/** Build a deterministic local pilot. Source geometry and reviewed crosssections are copied, never clipped or re-centred. */
export function buildPilotScene(plan, provenance = {}) {
  check(Array.isArray(plan?.features) && Array.isArray(plan.zones) && Array.isArray(plan.residentialComplexes), 'Pilot needs the current plan features, zones and complex membership.');
  const target = plan.features.find(feature => feature.id === PILOT_BUILDING_ID);
  check(target?.category === 'building', 'Original 118 building way/252997590 is missing.');
  check(['Polygon', 'MultiPolygon'].includes(target.geometry?.type), '118 requires its original polygon footprint.');
  check(target.complexId === 'complex/way/439886810' && target.zoneId === '2050/way/439886810', '118 must retain its G05 Xi 2 complex/zone identity.');
  const complex = plan.residentialComplexes.find(item => item.id === target.complexId);
  check(complex?.memberFeatureIds.includes(target.id), '118 complex membership evidence is missing.');
  const road = plan.features.find(feature => feature.id === PILOT_ROAD_ID);
  const profiles = PILOT_PROFILE_IDS.map(id => {
    const profile = road?.roadCrossProfiles?.find(item => item.id === id);
    check(profile?.sourceId === PILOT_ROAD_ID && profile.partIndex === 0 && profile.originalSegmentIndex === 0, `Required original road profile missing: ${id}`);
    check(profile.reviewStatus === 'curb_layout_visually_reviewed' && profile.classification === 'curb_mapping_estimate_after_visual_layout_review', `Pilot profile is not visually reviewed: ${id}`);
    check(profile.samples?.length === 4 && profile.endpointChecks?.length === 2 && profile.components?.length === 4, `Reviewed profile data is incomplete: ${id}`);
    check(profile.evidence?.sourceSha256 === plan.sourceSha256, `Profile source hash differs from the current plan: ${id}`);
    return profile;
  });
  const coreBounds = boundsForPoints([...geometryPoints(target.geometry), ...profiles.flatMap(profilePoints)]);
  const marginM = 25;
  const boundsLocalM = {minX: coreBounds.minX - marginM, minY: coreBounds.minY - marginM, maxX: coreBounds.maxX + marginM, maxY: coreBounds.maxY + marginM};
  const sourceNames = provenance.sourceFeatureNames ?? {};
  const contextBuildings = plan.features.filter(feature => feature.category === 'building' && feature.id !== target.id && intersects(boundsForPoints(geometryPoints(feature.geometry)), boundsLocalM))
    .map(feature => buildingRecord(feature, sourceNames));
  const contextZones = plan.zones.filter(zone => intersects(boundsForPoints(geometryPoints(zone.geometry)), boundsLocalM)).map(zone => ({
    id: zone.id, sourceId: zone.sourceId, name: zone.name, kind: zone.kind, complexId: zone.complexId ?? null,
    sourceComplexName: zone.sourceComplexName ?? null, geometryLocalM: clone(zone.geometry), geometryStatus: zone.geometryStatus,
    architectureIdentity: clone(zone.architectureIdentity ?? null),
    heightM: null, heightStatus: 'unknown_not_extruded'
  }));
  const surfaces = (plan.roadSurvey?.surfaces ?? []).filter(surface => ['road_corridor', 'walkway'].includes(surface.kind) && intersects(boundsForPoints(geometryPoints(surface.geometry)), boundsLocalM))
    .map(surface => ({id: surface.id, kind: surface.kind, geometryLocalM: clone(surface.geometry), officialWidthM: surface.officialWidthM ?? null,
      geometryStatus: 'official_2025_mapping_not_ground_survey', widthStatus: 'original_surface_outline_not_verified_effective_width'}));
  const surfaceById = new Map(surfaces.map(surface => [surface.id, surface]));
  for (const profile of profiles) {
    const evidence = profile.evidenceIds.filter(id => id.startsWith('ngii/'));
    check(evidence.length === 3 && evidence.every(id => surfaceById.has(id)), `Reviewed profile surfaces are missing: ${profile.id}`);
    check(surfaceById.get(evidence[0]).kind === 'road_corridor' && evidence.slice(1).every(id => surfaceById.get(id).kind === 'walkway'), 'Profile A001/A003 evidence kind mismatch.');
  }

  // Each candidate is the exact midpoint of an existing confirmed sidewalk crosssection.
  // Stable profile/sample/side order resolves ties without moving the source centreline.
  const candidates = profiles.flatMap(profile => [...profile.samples, ...profile.endpointChecks].flatMap((sample, crossSectionIndex) => ['left', 'right'].map(side => {
    const crossSectionLocalM = sample[`${side}WalkwayLineLocalM`];
    const positionLocalM = [0, 1].map(axis => (crossSectionLocalM[0][axis] + crossSectionLocalM[1][axis]) / 2);
    return {positionLocalM, crossSectionLocalM, profileId: profile.id, side, crossSectionIndex, distanceToBuildingM: distanceToGeometry(positionLocalM, target.geometry)};
  }))).filter(candidate => candidate.distanceToBuildingM > 0);
  check(candidates.length > 0, 'No confirmed sidewalk midpoint outside building 118 is available.');
  candidates.sort((a, b) => a.distanceToBuildingM - b.distanceToBuildingM);
  const human = candidates[0];
  check(surfaces.some(surface => surface.kind === 'walkway' && contains(human.positionLocalM, surface.geometryLocalM)), 'Reference human midpoint lies outside retained A003 sidewalk geometry.');
  const selectedComplexIds = new Set([target.complexId, ...contextBuildings.map(feature => feature.complexId), ...contextZones.map(zone => zone.complexId)].filter(Boolean));
  const suppliedProvenance = clone(provenance);
  delete suppliedProvenance.sourceFeatureNames;
  delete suppliedProvenance.generationSha256;
  delete suppliedProvenance.siteEvidence;
  const scene = {
    schema: 'guil-pilot3d.v1', units: 'metres', title: '구일 2050 · 118동 상대 크기 검증',
    coordinates: {
      originLocalM: [(boundsLocalM.minX + boundsLocalM.maxX) / 2, (boundsLocalM.minY + boundsLocalM.maxY) / 2],
      sourceCoordinateSystem: clone(plan.coordinateSystem),
      webAxes: {x: 'east', y: 'up', z: 'south', units: 'metres'},
      unrealAxes: {x: 'east', y: 'north', z: 'up', units: 'centimetres'},
      originStatus: 'pilot_scope_bbox_center_no_source_geometry_shift',
      metricStatus: 'existing_local_linear_plan_metres_not_cadastral_or_ground_survey'
    },
    scope: {boundsLocalM, coreBoundsLocalM: coreBounds, marginM, selectionRule: 'bbox_intersection_full_geometry', renderClipping: 'gpu_scope_bounds_only', geometryPreservation: 'all_selected_source_vertices_rings_and_holes_retained',
      futureObstacleInventory: {surfaceIds: surfaces.map(surface => surface.id), buildingIds: contextBuildings.map(building => building.sourceId)}},
    ground: {elevationM: 0, status: 'flat_ground_temporary_assumption_not_surveyed'},
    building: buildingRecord(target, sourceNames, 48),
    contextBuildings, contextZones, surfaces,
    residentialComplexes: clone(plan.residentialComplexes.filter(item => selectedComplexIds.has(item.id))),
    roadProfiles: clone(profiles),
    referenceHuman: {...clone(human), heightM: 1.8, eyeHeightM: 1.65, placementStatus: 'nearest_confirmed_sidewalk_crosssection_exact_midpoint_not_verified_access_route'},
    provenance: {...suppliedProvenance, sourceFile: plan.sourceFile, sourceSha256: plan.sourceSha256, generationHashBasis: 'sha256_of_compact_scene_json_with_generationSha256_field_absent'},
    sources: clone(plan.sources),
    restrictions: {localOnly: true, publicationAllowed: false, sourceRestriction: plan.roadSurvey?.restrictions ?? 'Redistribution rights unverified; local reference only.', sourceLicenses: ['OpenStreetMap contributors · ODbL 1.0', 'NGII redistribution and overseas transfer rights not yet reviewed']},
    notices: [
      '118동 원자료 외곽과 G05 자이 2차 단지 소속을 보존한 2050 임시 부피 모델입니다.',
      '48m는 상대 크기 확인용 임시 2050 설계 높이이며 기존 실제 건물의 측정 높이·층수가 아닙니다.',
      '지면 0m와 평지는 임시 가정이며 고도·지형 조사값이 아닙니다.',
      '주변 건물은 높이가 미확인인 원자료 평면 윤곽으로 표시합니다.',
      '검토한 두 구간의 원본 단면 끝점을 보존하며 도로 전체로 폭을 복제하지 않습니다.',
      '사람 위치는 기존 확인 보도 단면의 중점입니다. 현장 장애물·출입구·연결 보행로는 미확인입니다.',
      '원자료 비교 모델에는 출입구·계단·주차장·지하 상세를 생성하지 않습니다. 별도 2050 시안도 인허가·구조 상세 설계가 아니며 모든 GIS 파생 자료는 로컬 전용입니다.'
    ]
  };
  scene.futureDesign = buildFutureApartment(scene);
  if (provenance.siteEvidence) {
    scene.siteEvidence = clone(provenance.siteEvidence);
    scene.futureDesign.conceptAnalysis = buildPilotEnvironment(scene, scene.siteEvidence);
  }
  scene.provenance.generationSha256 = sha256(JSON.stringify(scene));
  return scene;
}
