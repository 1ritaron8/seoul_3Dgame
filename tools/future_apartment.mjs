import {APARTMENT_MODULE_PROFILE, createApartmentModuleLayout} from '../web/apartment-modules.mjs';

const TARGET_ID = 'way/252997590';
const COMPLEX_ID = 'complex/way/439886810';
const ZONE_ID = '2050/way/439886810';
const EPS = 1e-7;
const assert = (condition, message) => { if (!condition) throw new Error(`Future apartment: ${message}`); };
const point = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= EPS;
const onSegment = (p, a, b) => Math.abs(cross(a, b, p)) <= EPS && p[0] >= Math.min(a[0], b[0]) - EPS && p[0] <= Math.max(a[0], b[0]) + EPS && p[1] >= Math.min(a[1], b[1]) - EPS && p[1] <= Math.max(a[1], b[1]) + EPS;

function segmentsIntersect(a, b, c, d) {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (((abC > EPS && abD < -EPS) || (abC < -EPS && abD > EPS)) && ((cdA > EPS && cdB < -EPS) || (cdA < -EPS && cdB > EPS))) return true;
  return onSegment(c, a, b) || onSegment(d, a, b) || onSegment(a, c, d) || onSegment(b, c, d);
}

function polygons(geometry, label) {
  assert(['Polygon', 'MultiPolygon'].includes(geometry?.type), `${label} requires polygon geometry.`);
  const values = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  assert(Array.isArray(values) && values.length > 0, `${label} has no polygons.`);
  const result = values.map(polygon => {
    assert(Array.isArray(polygon) && polygon.length > 0, `${label} has no rings.`);
    return polygon.map(ring => {
      assert(Array.isArray(ring) && ring.length >= 4 && ring.every(point), `${label} has non-finite or missing ring coordinates.`);
      assert(same(ring[0], ring.at(-1)), `${label} has an open ring.`);
      // Consecutive duplicate source vertices are retained in the scene but skipped by predicates.
      const clean = ring.filter((value, index) => index === 0 || !same(value, ring[index - 1]));
      assert(clean.length >= 4 && same(clean[0], clean.at(-1)), `${label} has a degenerate ring.`);
      const area2 = clean.slice(1).reduce((sum, value, index) => sum + clean[index][0] * value[1] - value[0] * clean[index][1], 0);
      assert(Math.abs(area2) > EPS, `${label} has a zero-area ring.`);
      for (let i = 0; i < clean.length - 1; i++) for (let j = i + 1; j < clean.length - 1; j++) {
        if (j === i + 1 || (i === 0 && j === clean.length - 2)) continue;
        assert(!segmentsIntersect(clean[i], clean[i + 1], clean[j], clean[j + 1]), `${label} has a self-intersecting ring.`);
      }
      return clean;
    });
  });
  for (const polygon of result) {
    for (const hole of polygon.slice(1)) {
      assert(hole.every(p => inRing(p, polygon[0]) === 1) && !boundariesIntersect([[hole]], [[polygon[0]]]), `${label} has a hole outside or crossing its outer ring.`);
    }
    for (let i = 1; i < polygon.length; i++) for (let j = i + 1; j < polygon.length; j++) {
      assert(!overlap([[polygon[i]]], [[polygon[j]]]), `${label} has overlapping holes.`);
    }
  }
  for (let i = 0; i < result.length; i++) for (let j = i + 1; j < result.length; j++) {
    assert(!overlap([result[i]], [result[j]]), `${label} has touching or overlapping polygon parts.`);
  }
  return result;
}

function inRing(p, ring) {
  let inside = false;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i];
    if (onSegment(p, a, b)) return 0;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside ? 1 : -1;
}

function inside(p, shape) {
  return shape.some(polygon => inRing(p, polygon[0]) === 1 && polygon.slice(1).every(hole => inRing(p, hole) === -1));
}

function boundariesIntersect(a, b) {
  for (const ringA of a.flat()) for (const ringB of b.flat()) for (let i = 1; i < ringA.length; i++) for (let j = 1; j < ringB.length; j++) {
    if (segmentsIntersect(ringA[i - 1], ringA[i], ringB[j - 1], ringB[j])) return true;
  }
  return false;
}

function overlap(a, b) {
  return boundariesIntersect(a, b) || a.some(polygon => inside(polygon[0][0], b)) || b.some(polygon => inside(polygon[0][0], a));
}

function contained(a, b) {
  // Vertex tests alone miss concave notches and enclosed holes. All edges and both directions are checked.
  return a.flat().every(ring => ring.every(p => inside(p, b))) && !boundariesIntersect(a, b) && b.some(polygon =>
    a.flat().every(ring => ring.every(p => inRing(p, polygon[0]) === 1)) && polygon.slice(1).every(hole => !inside(hole[0], a)));
}

function closestPoint(p, shape) {
  let result = null;
  for (const ring of shape.flat()) for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i], dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    const candidate = [a[0] + dx * t, a[1] + dy * t];
    const distanceM = Math.hypot(candidate[0] - p[0], candidate[1] - p[1]);
    if (!result || distanceM < result.distanceM) result = {pointLocalM: candidate, distanceM, edgeLocalM: [[...a], [...b]], edgeFraction: t};
  }
  return result;
}

function shapeClearance(a, b) {
  if (overlap(a, b)) return {distanceM: 0, intersects: true, fromPointLocalM: null, toPointLocalM: null};
  let result = null;
  for (const [from, to, reverse] of [[a, b, false], [b, a, true]]) {
    for (const ring of from.flat()) for (const p of ring.slice(0, -1)) {
      const candidate = closestPoint(p, to);
      if (!result || candidate.distanceM < result.distanceM) {
        result = {distanceM: candidate.distanceM, intersects: false,
          fromPointLocalM: [...(reverse ? candidate.pointLocalM : p)],
          toPointLocalM: [...(reverse ? p : candidate.pointLocalM)]};
      }
    }
  }
  return result;
}

/** Minimum distance between polygon areas in the local metre plane. Not a statutory setback or safety result. */
export function measurePlanarClearance(geometryA, geometryB) {
  return shapeClearance(polygons(geometryA, 'clearance from'), polygons(geometryB, 'clearance to'));
}

const ringArea = ring => Math.abs(ring.slice(1).reduce((sum, p, i) => sum + cross([0, 0], ring[i], p), 0)) / 2;
const inOrOn = (p, shape) => inside(p, shape) || shape.flat().some(ring => ring.slice(1).some((q, i) => onSegment(p, ring[i], q)));

function convexRing(ring) {
  let sign = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const value = cross(ring[i], ring[(i + 1) % (ring.length - 1)], ring[(i + 2) % (ring.length - 1)]);
    if (Math.abs(value) <= EPS) continue;
    if (sign && Math.sign(value) !== sign) return false;
    sign = Math.sign(value);
  }
  return Boolean(sign);
}

function coveredEdge(a, b, shape) {
  const fractions = [0, 1], dx = b[0] - a[0], dy = b[1] - a[1];
  for (const ring of shape.flat()) for (let i = 1; i < ring.length; i++) {
    const c = ring[i - 1], d = ring[i], ex = d[0] - c[0], ey = d[1] - c[1], denominator = dx * ey - dy * ex;
    if (Math.abs(denominator) <= EPS) {
      for (const p of [c, d]) if (onSegment(p, a, b)) fractions.push(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy));
    } else {
      const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / denominator;
      const u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / denominator;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) fractions.push(t);
    }
  }
  fractions.sort((x, y) => x - y);
  return fractions.every(t => inOrOn([a[0] + dx * t, a[1] + dy * t], shape)) && fractions.slice(1).every((t, i) => {
    const middle = (t + fractions[i]) / 2;
    return inOrOn([a[0] + dx * middle, a[1] + dy * middle], shape);
  });
}

/** Exact local-plane intersection for a single hole-free source polygon and convex route.
 * Unsupported holes, separate parts, disconnected results and mere boundary contact fail closed. */
function clipAccessPolygon(sourceGeometry, routeGeometry, allowEmpty = false) {
  const source = polygons(sourceGeometry, 'crossing source'), route = polygons(routeGeometry, 'crossing route');
  assert(source.length === 1 && source[0].length === 1 && route.length === 1 && route[0].length === 1, 'crossing clipping requires single hole-free polygons.');
  const clip = route[0][0];
  assert(convexRing(clip), 'crossing route must be convex.');
  const orientation = Math.sign(clip.slice(1).reduce((sum, p, i) => sum + cross([0, 0], clip[i], p), 0));
  let output = source[0][0].slice(0, -1);
  for (let i = 1; i < clip.length; i++) {
    const a = clip[i - 1], b = clip[i], input = output;
    output = [];
    if (!input.length) break;
    for (let j = 0; j < input.length; j++) {
      const p = input[(j + input.length - 1) % input.length], q = input[j];
      const cp = orientation * cross(a, b, p), cq = orientation * cross(a, b, q);
      if ((cp >= -EPS) !== (cq >= -EPS)) {
        const t = cp / (cp - cq);
        output.push(p.map((value, axis) => value + t * (q[axis] - value)));
      }
      if (cq >= -EPS) output.push([...q]);
    }
    output = output.filter((p, index) => index === 0 || !same(p, output[index - 1]));
    if (output.length > 1 && same(output[0], output.at(-1))) output.pop();
  }
  if (output.length < 3) {
    assert(allowEmpty, 'crossing has no positive-area intersection.');
    return null;
  }
  output.push([...output[0]]);
  if (ringArea(output) <= EPS) {
    assert(allowEmpty, 'crossing has no positive-area intersection.');
    return null;
  }
  const geometry = {type: 'Polygon', coordinates: [output]};
  polygons(geometry, 'clipped crossing');
  assert(ringArea(output) > EPS && output.slice(1).every((p, i) => coveredEdge(output[i], p, source)), 'crossing intersection is disconnected or unsupported.');
  return geometry;
}

export function clipAccessCrossing(sourceGeometry, routeGeometry) {
  return clipAccessPolygon(sourceGeometry, routeGeometry);
}

function publicInterfaceCovered(geometry, siteGeometry, roadGeometry, walkwayGeometry) {
  const clips = [siteGeometry, roadGeometry, walkwayGeometry].map(value => clipAccessCrossing(value, geometry));
  assert(clips.every(value => convexRing(value.coordinates[0])), 'public interface requires connected convex site/road/walkway coverage.');
  const area = value => value ? ringArea(value.coordinates[0]) : 0;
  const pairs = [[0, 1], [0, 2], [1, 2]].map(([a, b]) => clipAccessPolygon(clips[a], clips[b], true));
  const triple = pairs[0] ? clipAccessPolygon(pairs[0], clips[2], true) : null;
  const unionArea = clips.reduce((sum, value) => sum + area(value), 0) - pairs.reduce((sum, value) => sum + area(value), 0) + area(triple);
  assert(Math.abs(unionArea - ringArea(geometry.coordinates[0])) < 1e-5, 'public interface includes undeclared land or an uncovered boundary/hole.');
}

function roadEdgeClear(edge, road, obstacles) {
  return edge.every(p => inside(p, road.shape)) && !boundariesIntersect([[edge]], road.shape) && obstacles.filter(value => value.kind === 'walkway').every(value =>
    edge.every(p => !inOrOn(p, value.shape)) && !boundariesIntersect([[edge]], value.shape));
}

function boundaryContactOnly(a, b, allowedSegment) {
  // Permit only the named threshold edge, never an area overlap or an arbitrary touching point.
  const samples = shape => shape.flat().flatMap(ring => ring.slice(0, -1).flatMap((p, index) => [p, [(p[0] + ring[index + 1][0]) / 2, (p[1] + ring[index + 1][1]) / 2]]));
  if (samples(a).some(p => inside(p, b)) || samples(b).some(p => inside(p, a))) return false;
  let touched = false;
  for (const ra of a.flat()) for (const rb of b.flat()) for (let i = 1; i < ra.length; i++) for (let j = 1; j < rb.length; j++) {
    const [p, q, r, s] = [ra[i - 1], ra[i], rb[j - 1], rb[j]];
    if (!segmentsIntersect(p, q, r, s)) continue;
    const abC = cross(p, q, r), abD = cross(p, q, s), cdA = cross(r, s, p), cdB = cross(r, s, q);
    if (((abC > EPS && abD < -EPS) || (abC < -EPS && abD > EPS)) && ((cdA > EPS && cdB < -EPS) || (cdA < -EPS && cdB > EPS))) return false;
    const contacts = [p, q, r, s].filter(value => onSegment(value, p, q) && onSegment(value, r, s));
    if (!contacts.length || contacts.some(value => !onSegment(value, ...allowedSegment))) return false;
    touched = true;
  }
  return touched;
}

function engineeringReview(scene, proposed, obstacles, sidewalkGapM) {
  const envelope = proposed.find(value => value.name === 'building_1_6m_envelope');
  const ramp = proposed.find(value => value.name === 'parking_ramp');
  const measured = (id, label, from, obstacle) => ({id, label, fromComponent: from.name, toFeatureId: obstacle.id,
    ...shapeClearance(from.shape, obstacle.shape), status: 'measured_2d_not_engineering_clearance'});
  const neighbourClearances = obstacles.filter(value => value.kind === 'retained_building').map(value =>
    measured(`neighbour/${value.id}`, `${scene.contextBuildings.find(building => building.sourceId === value.id)?.sourceName ?? value.id}까지`, envelope, value));
  const nearestSurface = kind => {
    const values = obstacles.filter(value => value.kind === kind).map(value => measured(`nearest/${kind}`, kind === 'walkway' ? '가장 가까운 지도 보도면까지' : '가장 가까운 지도 도로면까지', envelope, value));
    return values.reduce((nearest, value) => !nearest || value.distanceM < nearest.distanceM ? value : nearest, null);
  };
  const rampClearance = measured('facade_ramp', '입면 검사용 외곽 ↔ 주차장 램프', envelope, {id: 'parking_ramp', shape: ramp.shape});
  const checks = [
    {id: 'structure_ground', label: '구조·내진·지반', status: 'unverified', interaction: '인접 기초와 지하 굴착, 옥상·발코니 식재 하중까지 함께 검토', missingEvidence: ['구조 골조·재료·하중 조합', '지반·지하수·인접 기초', '내진·풍하중·굴착 영향 계산']},
    {id: 'sunlight_privacy', label: '일조·채광·사생활', status: 'unverified', interaction: '서로 마주 보는 창·발코니와 주변 동·학교에 생기는 그림자 검토', missingEvidence: ['영향 범위 전체의 높이·창 방향', '동지 등 시간별 일조 계산', '적용 용도지역·지적 경계·기준']},
    {id: 'wind_heat', label: '바람·열환경', status: 'unverified', interaction: '동 사이 바람 집중, 하강풍과 광장·보도의 여름 열환경 검토', missingEvidence: ['주변 3D 형태·수목·지형', '바람·온도 조건', '보행 높이 풍환경·열환경 해석']},
    {id: 'fire_access', label: '피난·소방 접근', status: 'needs_revision', interaction: '각 동에서 안전한 지상 공간까지 피난과 소방·구급 접근 검토', knownIssue: '도로 3→서비스 통로→도로 1 평면 통과 동선으로 막다른 구간은 해소했으나 소방 차량 회차·주행 궤적·사다리차 활동 공간은 미검증', resolvedGeometry: '6m 전폭 통과 동선과 통로 옆 별도 6×12m 서비스 후보 면', missingEvidence: ['피난계단·방화구획·출구', '차종별 회전 궤적·회차·활동 공간', '소방차 하중·문주 통과·지하 주차장 방재']},
    {id: 'pedestrian_vehicle', label: '보행·무장애·차량', status: 'unverified', interaction: '공공 보도→로비의 연속 보행과 램프·배송차량 교차를 함께 설계', resolvedGeometry: `보도 접점 간격 ${sidewalkGapM}m; 보도 23·22의 실제 교차 면에 보행 우선·차량 양보 시안`, missingEvidence: ['실제 지면 고도·단차·도로 차도 경계', '횡단 우선권·시야·경사·보호 시설', '차종별 진입·회전 궤적과 부지 밖 연결 권원']},
    {id: 'drainage_flood', label: '배수·침수·물순환', status: 'unverified', interaction: '옥상·정원·도로의 빗물이 인접 부지나 지하 램프에 집중되지 않게 검토', missingEvidence: ['강우·지형 고도·집수구·배수 관망', '침투·저류·비상 월류 경로', '지하수·램프 차수·펌프 계획']},
    {id: 'energy_air_noise', label: '에너지·설비·소음', status: 'unverified', interaction: '태양광 상호 음영, 환기·배기와 주거 창·공공 공간의 관계 검토', missingEvidence: ['열부하·일사·발전량 계산', '전기·상하수도·환기 용량/연결', '주차·교통·기계설비 소음·배출 위치']},
    {id: 'maintenance_interfaces', label: '유지관리·외피·램프', status: 'unverified', interaction: '발코니·차양·식재와 차량 램프 사이 유지관리·낙하물·보호 시설 검토', resolvedGeometry: `평면 간격 약 ${rampClearance.distanceM.toFixed(2)}m 안에 2.4m 관리 통로와 보호 경계 시안 배치`, missingEvidence: ['난간·방호 시설의 충격·낙하물·접합부 계산', '외피·차양·식재 접합부와 배수', '현장 고도·관리 작업·실제 유효폭']}
  ];
  return {
    schema: 'guil-engineering-review.v1', status: 'requires_multidisciplinary_review', safetyConclusion: 'not_assessed', replicationGate: 'hold_pending_review',
    scope: 'current_118_pilot_only_not_whole_complex_or_city', automaticScope: '2d_polygon_intersections_and_minimum_planar_distances_only',
    basis: {designHeightM: 78.4, surroundingHeightsVerified: false, terrainVerified: false, fullInfluenceAreaCovered: false, cadastralBoundariesVerified: false, structureModelAvailable: false},
    clearances: {method: 'minimum_distance_between_closed_polygon_areas_including_holes_and_multipolygon_parts', units: 'metres', uncertainty: 'source_map_and_local_coordinate_accuracy_not_quantified', neighbourClearances, nearestRoad: nearestSurface('road_corridor'), nearestWalkway: nearestSurface('walkway'), rampClearance},
    checks,
    resolvedGeometryIssues: [
      {id: 'ramp_interface', beforeDistanceM: .2, afterDistanceM: rampClearance.distanceM, result: '2_4m_maintenance_path_and_concept_barrier_added_not_engineered'},
      {id: 'sidewalk_connection', beforeDistanceM: .6, afterDistanceM: sidewalkGapM, result: 'full_width_planar_threshold_connected_terrain_and_permission_unverified'}
    ],
    acceptanceRule: 'Geometric non-overlap alone never passes engineering review. Resolve known interface issues, obtain missing evidence and record separate discipline results before repeating this design.',
    notices: [
      '거리 수치는 지도 평면 계산이며 실측·법정 이격·공학적 안전 판정이 아닙니다.',
      '고정 조명은 시각 효과입니다. 별도 날짜·위치 기반 태양 방향과 가정 높이 그림자 비교도 연속 일조시간·법적 적합성 검증은 아닙니다.',
      '건물 높이를 바꾸면 일조·바람·피난·구조·설비를 다시 검토해야 합니다. 거리 검사 통과만으로 결과를 승계하지 않습니다.',
      '현행 공식 기준은 참고 출발점이며 2050년 법규나 미래 재개발 승인으로 취급하지 않습니다.'
    ]
  };
}

function rectangle(center, longAxis, shortAxis, length, depth) {
  const ring = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => [
    center[0] + x * length / 2 * longAxis[0] + y * depth / 2 * shortAxis[0],
    center[1] + x * length / 2 * longAxis[1] + y * depth / 2 * shortAxis[1]
  ]);
  ring.push([...ring[0]]);
  return {type: 'Polygon', coordinates: [ring]};
}

/** A single fictional 2050 option. All coordinates stay in the source E/N metre plane; source records are read-only. */
export function buildFutureApartment(scene) {
  assert(scene?.units === 'metres' && scene.building?.sourceId === TARGET_ID, 'the original 118 target is required.');
  assert(scene.building.complexId === COMPLEX_ID && scene.building.zoneId === ZONE_ID, '118 must retain G05 complex and zone identity.');
  assert(Array.isArray(scene.contextZones) && Array.isArray(scene.contextBuildings) && Array.isArray(scene.surfaces), 'complete site and obstacle records are required.');
  const complex = scene.residentialComplexes?.find(value => value.id === COMPLEX_ID);
  assert(complex?.zoneId === ZONE_ID && complex.memberFeatureIds?.includes(TARGET_ID), 'original G05 membership evidence is required.');
  const site = scene.contextZones.find(value => value.id === ZONE_ID);
  assert(site?.complexId === COMPLEX_ID && site.sourceId === 'way/439886810', 'the original G05 site boundary is required.');
  const identity = site.architectureIdentity;
  assert(identity?.id === 'g05-living-terraces' && identity.status === 'fictional_2050_design_proposal_not_brand_product', 'G05 needs its own living-terrace exterior identity.');
  assert(complex.architectureIdentityId === identity.id && Array.isArray(identity.features) && identity.features.length === 5, 'complex exterior identity is inconsistent or incomplete.');
  const siteShape = polygons(site.geometryLocalM, 'G05 site');
  const sourceShape = polygons(scene.building.geometryLocalM, '118 source');
  assert(sourceShape.length === 1 && sourceShape[0].length === 1 && sourceShape[0][0].length === 5, '118 source frame requires the original four-corner outline.');
  for (const id of ['way/252997589', 'way/252997591']) assert(scene.contextBuildings.some(value => value.sourceId === id), `retained neighbouring building missing: ${id}`);
  const inventory = scene.scope?.futureObstacleInventory;
  assert(inventory && Array.isArray(inventory.surfaceIds) && Array.isArray(inventory.buildingIds), 'source obstacle inventory is required to detect missing records.');
  assert(inventory.surfaceIds.length === scene.surfaces.length && new Set(inventory.surfaceIds).size === inventory.surfaceIds.length && inventory.surfaceIds.every(id => scene.surfaces.some(value => value.id === id)), 'source road/walkway inventory changed or is incomplete.');
  assert(inventory.buildingIds.length === scene.contextBuildings.length && new Set(inventory.buildingIds).size === inventory.buildingIds.length && inventory.buildingIds.every(id => scene.contextBuildings.some(value => value.sourceId === id)), 'source building inventory changed or is incomplete.');
  assert(scene.surfaces.some(value => value.kind === 'road_corridor') && scene.surfaces.some(value => value.kind === 'walkway'), 'road and sidewalk surface evidence is required.');
  const obstacles = [
    ...scene.contextBuildings.map(value => ({id: value.sourceId, kind: 'retained_building', shape: polygons(value.geometryLocalM, value.sourceId)})),
    ...scene.surfaces.map(value => {
      assert(['road_corridor', 'walkway'].includes(value.kind), `unknown surface kind: ${value.id}`);
      return {id: value.id, kind: value.kind, shape: polygons(value.geometryLocalM, value.id)};
    })
  ];
  const corners = sourceShape[0][0].slice(0, -1);
  const edges = corners.map((a, index) => { const b = corners[(index + 1) % corners.length]; return [b[0] - a[0], b[1] - a[1]]; });
  const longest = edges.sort((a, b) => Math.hypot(...b) - Math.hypot(...a))[0];
  const sign = longest[0] >= 0 ? 1 : -1;
  const longAxisLocalM = longest.map(value => sign * value / Math.hypot(...longest));
  const shortAxisLocalM = [-longAxisLocalM[1], longAxisLocalM[0]];
  const sourceCenter = [0, 1].map(axis => corners.reduce((sum, value) => sum + value[axis], 0) / corners.length);
  const rampAnchorLocalM = [sourceCenter[0] + 1.01665, sourceCenter[1] - 5.348425];
  const relocationM = 2.6;
  const centerLocalM = rampAnchorLocalM.map((value, axis) => value + relocationM * shortAxisLocalM[axis]);
  const at = (long, short) => [centerLocalM[0] + long * longAxisLocalM[0] + short * shortAxisLocalM[0], centerLocalM[1] + long * longAxisLocalM[1] + short * shortAxisLocalM[1]];
  const rampAt = (long, short) => [rampAnchorLocalM[0] + long * longAxisLocalM[0] + short * shortAxisLocalM[0], rampAnchorLocalM[1] + long * longAxisLocalM[1] + short * shortAxisLocalM[1]];
  const rampPolygon = pairs => {
    const ring = pairs.map(([long, short]) => rampAt(long, short));
    ring.push([...ring[0]]);
    return {type: 'Polygon', coordinates: [ring]};
  };
  const buildingGeometry = rectangle(centerLocalM, longAxisLocalM, shortAxisLocalM, 62, 22);
  const buildingEnvelopeGeometry = rectangle(centerLocalM, longAxisLocalM, shortAxisLocalM, 65.2, 25.2);
  const entranceGeometry = rectangle(at(0, 14), longAxisLocalM, shortAxisLocalM, 16, 6);
  // Start inside the plaza so the whole-width path, not just its centre point, is connected.
  const pathAim = at(0, 16.2);
  const sidewalk = obstacles.find(value => value.id === 'ngii/376120316/N1A_A0033320/22' && value.kind === 'walkway');
  assert(sidewalk, 'the retained frontage sidewalk 22 is required.');
  const connection = closestPoint(pathAim, sidewalk.shape);
  assert(connection?.distanceM > 2, 'insufficient room for an in-site entrance approach.');
  const [edgeStart, edgeEnd] = connection.edgeLocalM;
  const edgeLength = Math.hypot(edgeEnd[0] - edgeStart[0], edgeEnd[1] - edgeStart[1]);
  assert(edgeLength > 2.6, 'frontage edge is too short for the 2.4m pedestrian threshold and corner margin.');
  // A nearest-point projection may sit at a pavement corner. Move the full-width endpoint
  // along that same mapped edge, then intersect its normal with the plaza start line.
  const edgeTangent = edgeEnd.map((value, axis) => (value - edgeStart[axis]) / edgeLength);
  const edgeFraction = Math.max(1.3 / edgeLength, Math.min(1 - 1.3 / edgeLength, connection.edgeFraction));
  connection.pointLocalM = edgeStart.map((value, axis) => value + edgeFraction * (edgeEnd[axis] - value));
  connection.edgeFraction = edgeFraction;
  const direction = [-edgeTangent[1], edgeTangent[0]];
  const alignment = direction.reduce((sum, value, axis) => sum + value * shortAxisLocalM[axis], 0);
  assert(alignment > .5, 'frontage sidewalk must remain on the plaza side of the candidate.');
  const endShort = connection.pointLocalM.reduce((sum, value, axis) => sum + (value - centerLocalM[axis]) * shortAxisLocalM[axis], 0);
  const pathLengthM = (endShort - 16.2) / alignment;
  assert(pathLengthM > 2, 'insufficient room for the full-width entrance approach.');
  const pathStart = connection.pointLocalM.map((value, axis) => value - direction[axis] * pathLengthM);
  const gapM = 0;
  const pathEnd = [...connection.pointLocalM];
  const pathCenter = pathStart.map((value, axis) => (value + pathEnd[axis]) / 2);
  const pathGeometry = rectangle(pathCenter, direction, [-direction[1], direction[0]], pathLengthM, 2.4);
  const sidewalkContactEdge = pathGeometry.coordinates[0].slice(1, 3);
  assert(connection.edgeFraction > 0 && connection.edgeFraction < 1 && sidewalkContactEdge.every(p => onSegment(p, ...connection.edgeLocalM)), 'the whole-width path threshold must lie on one retained sidewalk edge.');
  const frontageRoad = obstacles.find(value => value.id === 'ngii/376120316/N1A_A0010000/1' && value.kind === 'road_corridor');
  assert(frontageRoad, 'the frontage mapped road 1 is required.');
  // The mapped south sidewalk excludes the initial -19m candidate. The -15.8m strip leaves about 1.25m to that preserved outline.
  const rampStart = rampAt(-18, -15.8), rampEnd = rampAt(18, -15.8);
  const rampRing = [rampAt(-18, -12.8), rampAt(-18, -18.8), rampAt(18, -18.8), rampAt(18, -12.8)];
  rampRing.push([...rampRing[0]]);
  const rampGeometry = {type: 'Polygon', coordinates: [rampRing]};
  const deckGeometry = rectangle(centerLocalM, longAxisLocalM, shortAxisLocalM, 60, 20);
  const connectorEnd = at(18, -9.5);
  const connectorGeometry = rectangle(rampAt(18, -11.35), shortAxisLocalM, longAxisLocalM, 8.9, 6);
  const maintenanceGeometry = rampPolygon([[-18, -12.6], [35.2, -12.6], [35.2, 18.4], [8, 18.4], [8, 16], [32.8, 16], [32.8, -10.2], [-18, -10.2]]);
  const maintenanceCenterLine = [[8, 17.2], [34, 17.2], [34, -11.4], [-18, -11.4]].map(([long, short]) => rampAt(long, short));
  const barrierGeometry = rectangle(rampAt(0, -12.7), longAxisLocalM, shortAxisLocalM, 36, .12);
  // This is a new 2050 driveway concept, not evidence of an existing driveway or public-road approval.
  const vehicleGeometry = rectangle(rampAt(-36, -15.8), longAxisLocalM, shortAxisLocalM, 36, 6);
  const entryRoad = obstacles.find(value => value.id === 'ngii/376120316/N1A_A0010000/3' && value.kind === 'road_corridor');
  const crossedWalkway = obstacles.find(value => value.id === 'ngii/376120316/N1A_A0033320/23' && value.kind === 'walkway');
  assert(entryRoad && crossedWalkway, 'the vehicle connection requires retained mapped road 3 and sidewalk 23.');
  const vehicleStart = rampAt(-54, -15.8);
  const entryEdge = [rampAt(-54, -18.8), rampAt(-54, -12.8)];
  assert(roadEdgeClear(entryEdge, entryRoad, obstacles), 'whole vehicle entry edge must lie in mapped road area outside all mapped walkways; carriageway and curb levels remain unverified.');
  // The retained entry source contains an unmapped strip before G05. The explicit
  // approach footprint is kept as a proposal; this is recorded below, never land/rights evidence.
  const turnCenter = [-42, -9.8], turnSteps = 24;
  const turnPoints = radius => Array.from({length: turnSteps + 1}, (_, i) => {
    const angle = -Math.PI / 2 + Math.PI / 2 * i / turnSteps;
    return [turnCenter[0] + radius * Math.cos(angle), turnCenter[1] + radius * Math.sin(angle)];
  });
  const turnGeometry = rampPolygon([...turnPoints(9), ...turnPoints(3).reverse()]);
  const turnCenterLine = turnPoints(6).map(([long, short]) => rampAt(long, short));
  const laneGeometry = rectangle(rampAt(-36, -.1), shortAxisLocalM, longAxisLocalM, 19.4, 6);
  const laneStart = rampAt(-36, -9.8), laneEnd = rampAt(-36, 9.6);
  const serviceGeometry = rectangle(rampAt(-42, 1.5), shortAxisLocalM, longAxisLocalM, 12, 6);
  const exitEnd = rampAt(-36, 25), exitEdge = [rampAt(-39, 25), rampAt(-33, 25)];
  const exitGeometry = rampPolygon([[-39, 9.6], [-33, 9.6], [-33, 25], [-39, 25]]);
  assert(roadEdgeClear(exitEdge, frontageRoad, obstacles), 'whole vehicle exit edge must lie in mapped road 1 outside all mapped walkways.');
  publicInterfaceCovered(exitGeometry, site.geometryLocalM, scene.surfaces.find(value => value.id === frontageRoad.id).geometryLocalM, scene.surfaces.find(value => value.id === sidewalk.id).geometryLocalM);
  const crossings = [[crossedWalkway, vehicleGeometry, 'approach'], [sidewalk, exitGeometry, 'exit']].map(([walkway, route, vehicleRouteName]) => ({
    id: `crossing/${vehicleRouteName}`, walkwayId: walkway.id, vehicleRouteName,
    geometryLocalM: clipAccessCrossing(scene.surfaces.find(value => value.id === walkway.id).geometryLocalM, route),
    widths: {vehicleRouteM: 6, pedestrianApproachM: 2.4, mappedWalkwayM: null},
    gradeStatus: 'unverified', vehicleYieldRequired: true, pedestrianPriority: true,
    protection: {treatment: 'continuous_walkway_marking_and_vehicle_yield_concept', raisedSurfaceVerified: false, visibilityVerified: false, physicalProtectionVerified: false},
    status: '2050_pedestrian_priority_crossing_concept_not_approved_or_safety_verified'
  }));
  const proposed = [
    ['building', buildingGeometry], ['building_1_6m_envelope', buildingEnvelopeGeometry], ['entrance_plaza', entranceGeometry], ['entrance_approach', pathGeometry],
    ['parking_ramp', rampGeometry], ['underground_deck', deckGeometry], ['underground_connector', connectorGeometry],
    ['maintenance_path', maintenanceGeometry], ['ramp_protection', barrierGeometry], ['vehicle_approach', vehicleGeometry], ['service_turn', turnGeometry], ['service_lane', laneGeometry], ['service_pad', serviceGeometry], ['vehicle_exit', exitGeometry]
  ].map(([name, geometry]) => ({name, geometry, shape: polygons(geometry, name)}));
  const bounds = scene.scope?.boundsLocalM;
  assert(bounds && ['minX', 'minY', 'maxX', 'maxY'].every(key => Number.isFinite(bounds[key])), 'the retained obstacle coverage bounds are required.');
  const checks = proposed.map(value => {
    const insideG05 = contained(value.shape, siteShape);
    if (['vehicle_approach', 'vehicle_exit'].includes(value.name)) {
      assert(siteShape.length === 1 && siteShape[0].slice(1).every(hole => !overlap(value.shape, [[hole]])), 'public interface may cross only the outer site boundary, never a site hole or detached part.');
    }
    if (value.name === 'vehicle_approach') {
      assert(!insideG05 && boundariesIntersect(value.shape, siteShape) && inside(rampStart, siteShape) && entryEdge.every(p => !inside(p, siteShape)), 'vehicle approach must be the declared road-to-site interface, not an unregistered off-site component.');
    } else if (value.name === 'vehicle_exit') {
      assert(!insideG05 && boundariesIntersect(value.shape, siteShape) && inside(laneEnd, siteShape) && exitEdge.every(p => !inside(p, siteShape)), 'vehicle exit must be the declared site-to-road interface, not an unregistered off-site component.');
    } else assert(insideG05, `${value.name} leaves G05 or crosses its boundary/hole; no geometry generated.`);
    assert(value.shape.flat(2).every(p => p[0] > bounds.minX && p[0] < bounds.maxX && p[1] > bounds.minY && p[1] < bounds.maxY), `${value.name} exceeds the retained obstacle coverage; no geometry generated.`);
    const interfaces = [];
    for (const obstacle of obstacles) {
      if (value.name === 'entrance_approach' && [sidewalk.id, frontageRoad.id].includes(obstacle.id)) {
        assert(boundaryContactOnly(value.shape, obstacle.shape, sidewalkContactEdge), `${value.name} must only meet ${obstacle.id} along its terminal threshold; no area intrusion permitted.`);
        interfaces.push({sourceId: obstacle.id, kind: 'boundary_contact_only', contactEdgeLocalM: structuredClone(sidewalkContactEdge)});
      } else if (value.name === 'vehicle_approach' && [entryRoad.id, crossedWalkway.id].includes(obstacle.id)) {
        assert(overlap(value.shape, obstacle.shape), `vehicle approach no longer meets declared ${obstacle.id}.`);
        assert(obstacle.shape.length === 1 && obstacle.shape[0].slice(1).every(hole => !overlap(value.shape, [[hole]])), 'vehicle approach cannot ignore detached public surfaces or holes.');
        interfaces.push({sourceId: obstacle.id, kind: 'planned_driveway_area_crossing_not_existing_or_approved'});
      } else if (value.name === 'vehicle_exit' && [frontageRoad.id, sidewalk.id].includes(obstacle.id)) {
        assert(overlap(value.shape, obstacle.shape), `vehicle exit no longer meets declared ${obstacle.id}.`);
        interfaces.push({sourceId: obstacle.id, kind: 'planned_driveway_area_crossing_not_existing_or_approved'});
      } else assert(!overlap(value.shape, obstacle.shape), `${value.name} intersects ${obstacle.kind} ${obstacle.id}; no geometry generated.`);
    }
    return {component: value.name, insideG05, roadWalkwayAndNeighbourConflict: false, declaredInterfaces: interfaces, testedObstacleCount: obstacles.length};
  });
  const byName = new Map(proposed.map(value => [value.name, value.shape]));
  for (const [a, b] of [['building', 'parking_ramp'], ['building_1_6m_envelope', 'parking_ramp'], ['entrance_plaza', 'parking_ramp'], ['entrance_approach', 'parking_ramp'], ['building', 'entrance_approach'],
    ...['maintenance_path', 'ramp_protection', 'vehicle_approach', 'service_turn', 'service_lane', 'service_pad', 'vehicle_exit'].flatMap(name => [['building_1_6m_envelope', name], ['entrance_approach', name]]),
    ['maintenance_path', 'parking_ramp'], ['maintenance_path', 'ramp_protection'], ['maintenance_path', 'vehicle_approach'], ['maintenance_path', 'service_turn'], ['maintenance_path', 'service_lane'],
    ...['vehicle_approach', 'service_turn', 'vehicle_exit', 'maintenance_path', 'parking_ramp', 'entrance_plaza'].map(name => ['service_pad', name])]) {
    assert(!overlap(byName.get(a), byName.get(b)), `${a} conflicts with ${b}.`);
  }
  const doorLocalM = at(0, 11);
  assert(onSegment(doorLocalM, entranceGeometry.coordinates[0][0], entranceGeometry.coordinates[0][1]) && onSegment(doorLocalM, buildingGeometry.coordinates[0][2], buildingGeometry.coordinates[0][3]), 'entrance plaza must meet the building entrance at the shared threshold.');
  assert(onSegment(rampEnd, connectorGeometry.coordinates[0][0], connectorGeometry.coordinates[0][3]) && inside(connectorEnd, byName.get('underground_deck')), 'ramp lower end must connect through the underground connector to the concept deck.');
  assert(inside(pathStart, byName.get('entrance_plaza')), 'entrance approach must start inside the plaza.');
  const maintenanceEntryEdge = [rampAt(8, 16), rampAt(8, 18.4)];
  assert(boundaryContactOnly(byName.get('maintenance_path'), byName.get('entrance_plaza'), maintenanceEntryEdge), 'maintenance path must connect at its full-width plaza opening.');
  const rampEntryEdge = [rampRing[0], rampRing[1]];
  assert(boundaryContactOnly(byName.get('vehicle_approach'), byName.get('parking_ramp'), rampEntryEdge), 'vehicle approach must connect to the whole ramp entry edge.');
  const serviceContactEdge = [rampAt(-39, -4.5), rampAt(-39, 7.5)], exitContactEdge = [rampAt(-39, 9.6), rampAt(-33, 9.6)];
  assert(inside(turnCenterLine[0], byName.get('vehicle_approach')) && same(turnCenterLine.at(-1), laneStart), 'service branch and lane must remain connected.');
  assert(boundaryContactOnly(byName.get('service_pad'), byName.get('service_lane'), serviceContactEdge), 'service candidate must share its complete lateral edge with the lane without occupying the through route.');
  assert(boundaryContactOnly(byName.get('service_lane'), byName.get('vehicle_exit'), exitContactEdge), 'exit must join the lane across its complete six-metre edge.');
  const design = {
    schema: 'guil-future-apartment.v1', status: 'concept_2050_not_permitted_or_engineered', targetSourceId: TARGET_ID, siteComplexId: COMPLEX_ID, siteZoneId: ZONE_ID,
    architectureIdentity: structuredClone(identity),
    engineeringReview: engineeringReview(scene, proposed, obstacles, gapM),
    frame: {centerLocalM, longAxisLocalM, shortAxisLocalM, sourceCenterLocalM: sourceCenter, rampAnchorLocalM, relocationAlongShortAxisM: relocationM, axesStatus: 'source_long_edge_orientation_new_dimensions_and_position'},
    building: {geometryLocalM: buildingGeometry, safetyEnvelopeGeometryLocalM: buildingEnvelopeGeometry, safetyBufferM: 1.6, lengthM: 62, depthM: 22, heightM: 78.4, floorCount: 24, floorHeightM: APARTMENT_MODULE_PROFILE.floor.residentialHeightM, podiumHeightM: APARTMENT_MODULE_PROFILE.floor.podiumHeightM, residentialFloorCount: 23, floorCountIncludesPodium: true, elevationM: 0,
      designStatus: 'new_2050_dimensions_not_existing_measurement', facade: {style: identity.id, baySpacingM: APARTMENT_MODULE_PROFILE.facade.bayPitchM, dwellingGroupSize: APARTMENT_MODULE_PROFILE.facade.pairedBayCount, balconyDepthM: APARTMENT_MODULE_PROFILE.facade.balconyDepthM, balconyStatus: 'projection_within_validated_1_6m_envelope', roofGardenStatus: 'visual_concept_within_envelope', dwellingLayoutStatus: 'facade_modules_not_confirmed_unit_plans_or_unit_count'}},
    entrance: {geometryLocalM: entranceGeometry, pathGeometryLocalM: pathGeometry, doorLocalM, plazaLengthM: 16, plazaDepthM: 6, pathWidthM: 2.4, pathStartLocalM: pathStart, pathEndLocalM: pathEnd,
      sidewalkSourceId: sidewalk.id, frontageRoadSourceId: frontageRoad.id, sidewalkContactEdgeLocalM: sidewalkContactEdge, sidewalkEdgePointLocalM: connection.pointLocalM, sidewalkGapM: gapM, status: 'full_width_planar_sidewalk_to_plaza_to_lobby_connection_terrain_unverified'},
    maintenance: {geometryLocalM: maintenanceGeometry, widthM: 2.4, centerLineLocalM: maintenanceCenterLine, plazaContactEdgeLocalM: maintenanceEntryEdge,
      barrier: {geometryLocalM: barrierGeometry, heightM: 1.1, elevationM: 0, status: 'concept_protection_not_impact_or_fall_certified'},
      status: 'planar_maintenance_access_connected_to_plaza_actual_clearance_and_safety_unverified'},
    access: {
      vehicle: {approach: {geometryLocalM: vehicleGeometry, centerLineLocalM: [vehicleStart, rampStart], widthM: 6},
        turn: {geometryLocalM: turnGeometry, centerLineLocalM: turnCenterLine, widthM: 6, centerRadiusM: 6, innerRadiusM: 3, outerRadiusM: 9},
        lane: {geometryLocalM: laneGeometry, centerLineLocalM: [laneStart, laneEnd], widthM: 6},
        exit: {geometryLocalM: exitGeometry, centerLineLocalM: [laneEnd, exitEnd], widthM: 6},
        sourceRoadId: entryRoad.id, crossedWalkwayId: crossedWalkway.id, roadEntryEdgeLocalM: entryEdge,
        exitRoadId: frontageRoad.id, exitCrossedWalkwayId: sidewalk.id, roadExitEdgeLocalM: exitEdge,
        publicConnection: {entryRoadId: entryRoad.id, exitRoadId: frontageRoad.id, status: 'continuous_full_width_2d_through_route_not_approved_or_vehicle_sweep_verified', exitMappedCoverage: 'whole_exit_polygon_covered_by_G05_road1_and_walkway22', entryLandConnectionStatus: 'unmapped_strip_between_source_road_and_site_rights_unverified'},
        status: 'planar_road_to_ramp_and_service_through_connection_not_existing_driveway_or_approved_crossing'},
      crossings,
      service: {geometryLocalM: serviceGeometry, widthM: 6, lengthM: 12, laneContactEdgeLocalM: serviceContactEdge, separateFromThroughLane: true, status: 'lateral_service_fire_review_candidate_not_certified'},
      fire: {status: 'needs_revision', turnaroundVerified: false, sweptVehicleEnvelopeVerified: false, ladderOperatingSpaceVerified: false,
        deadEndResolvedPlanar: true, knownIssue: 'through_route_and_lateral_candidate_added_large_vehicle_sweeps_and_operating_space_unverified'},
      status: '2050_flat_ground_access_concept_not_traffic_fire_or_accessibility_approval',
      assumptions: ['지상 동선은 지반고 0m의 2050 개념면입니다. 현황 단차·연석·경사는 미확인입니다.', '지도 도로면에는 보도가 포함될 수 있으므로 도로 잔여 면을 확인했어도 차도 실측으로 간주하지 않음.', '차량 접근·진출은 부지 경계를 넘어 보도 23·22를 횡단함. 소유·통행 권원·도로 연결 승인·보행 보호는 미검증.', '진입 도로 3과 G05 사이 원자료에 포함되지 않은 띠 공간은 접근 후보 범위에만 포함되며 토지·통행 권원은 미확인입니다.', '6m 통로·중심 반경 6m·통로 옆 6×12m 서비스 면은 창작 검토 치수이며 소방차 기준이나 회전 궤적 검증값이 아님.']},
    parking: {ramp: {geometryLocalM: rampGeometry, widthM: 6, lengthM: 36, startLocalM: rampStart, endLocalM: rampEnd, startCentreLocalM: [...rampStart], endCentreLocalM: [...rampEnd], edgeOrder: 'start_left_start_right_end_right_end_left_closed', normalLocalM: [...shortAxisLocalM], startElevationM: 0, endElevationM: -3.6, slopeRatio: 0.1, directionLocalM: [...longAxisLocalM], status: 'in_site_slope_concept_external_vehicle_access_unverified'},
      deck: {geometryLocalM: deckGeometry, centerLocalM, lengthM: 60, depthM: 20, elevationM: -3.6, slabBottomElevationM: -3.9, floorToFloorM: 3.6, levelCount: 1, stallCount: null, status: 'underground_concept_footprint_not_excavation_or_parking_capacity'},
      connector: {geometryLocalM: connectorGeometry, elevationM: -3.6, slabBottomElevationM: -3.9, widthM: 6, lengthM: 8.9, startLocalM: [...rampEnd], endLocalM: connectorEnd, directionLocalM: [...shortAxisLocalM], clearanceHeightM: null, status: 'underground_access_link_clearance_structure_and_turning_unverified'},
      status: 'concept_planar_external_connection_added_turning_fire_structure_and_waterproofing_unverified'},
    validation: {status: 'passed', method: 'all_polygon_edges_vertices_holes_and_obstacle_intersections_with_explicit_threshold_and_driveway_interfaces', epsilonM: EPS, scope: 'retained_G05_boundary_and_current_pilot_road_walkway_neighbour_polygons',
      checks, checkedSurfaceIds: scene.surfaces.map(value => value.id), checkedBuildingIds: scene.contextBuildings.map(value => value.sourceId), sourceMutation: false,
      rampDeckConnection: 'lower_end_on_connector_edge_connector_end_inside_deck', facadeEnvelopeBufferM: 1.6, envelopePurpose: 'facade_projection_check_only_not_safety_setback', excludedClaims: ['cadastral_boundary', 'floor_area_or_far', 'planning_permission', 'parking_capacity', 'street_vehicle_access', 'fire_access', 'structure', 'ground_levels', 'daylight_compliance', 'wind_comfort', 'drainage_capacity', 'energy_performance', 'noise_compliance']},
    notices: [
      '118동 한 동의 2050 재건축 외관 시안입니다. 원본 외곽과 비교용 48m 모델은 별도 보존합니다.',
      '새 동 62×22m·78.4m·24층은 창작 설계 가정입니다. 기존 평수·측정 높이·허가된 층수가 아닙니다.',
      'G05 생활 테라스형: 쌍 발코니·거실/침실 창호·석재 저층·6층 간격 공중 녹화·옥상 정원은 이 단지의 창작 외관 기준입니다. 세대 수나 실제 평면을 확정하지 않습니다.',
      '건물·광장·관리 통로·램프·지하 개념면·서비스 후보 면은 G05 원자료 경계 안입니다. 차량 진입·진출 후보 구간만 부지 밖 연결로 구분해 나머지 도로·보도·주변 동 충돌을 차단했습니다.',
      '2.4m 보행 접근로는 지도 보도 22의 경계에 전폭 연결했습니다. 지형 고도·단차·무장애 성능·현장 출입구 검증은 아닙니다.',
      '램프는 기존 개념 위치에 두고 건물·광장·지하 개념면을 2.6m 이동해 입면 검사용 외곽과 램프 사이 2.8m를 확보했습니다. 관리 통로 2.4m와 1.1m 보호 경계는 안전 인증이 없는 시안입니다.',
      '6m 폭 차량 접근은 지도 도로 3에서 보도 23을 횡단해 램프로 이어지고 서비스 통로는 보도 22를 건너 도로 1로 진출합니다. 전폭 도로 접점은 모든 지도 보도 밖이며 실제 차도·단차·통행 승인·회전 궤적은 미확인입니다.',
      '보도 23·22의 차량 교차 면은 원자료와 후보 동선의 교집합으로 표시하며 보행 우선·차량 양보 시안을 적용합니다. 표시는 경사·시야·방호·교통 안전 인증이 아닙니다.',
      '서비스 통로의 막다른 구간은 평면에서 해소하고 통로 옆 별도 6×12m 후보 면을 배치했습니다. 소방 차량 주행 궤적·회차와 사다리차 활동 공간은 미검증이므로 소방 안전 통과로 취급하지 않습니다.',
      '지하 주차면은 배치 개념입니다. 주차대수·용적률·법규·소방·구조·굴착·방수·지형·인허가를 검증하지 않았습니다.',
      '다른 단지와 합치거나 나누지 않습니다. 학교·공공 도로·보도 원자료는 보존하며 모든 GIS 파생 결과는 로컬 전용입니다.'
    ]
  };
  design.modules = {profile: structuredClone(APARTMENT_MODULE_PROFILE), layout: createApartmentModuleLayout(design.building), replicationStatus: 'reusable_exterior_components_not_site_placement_or_safety_approval'};
  return design;
}
