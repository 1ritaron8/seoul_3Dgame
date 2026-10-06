import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {buildPilotScene} from '../tools/pilot_scene.mjs';
import {buildFutureApartment, measurePlanarClearance, clipAccessCrossing} from '../tools/future_apartment.mjs';
import {createFutureApartment} from '../web/pilot-architecture.mjs';

const inputPaths = ['docs/guil_2050_plan.json', 'docs/guro1_plan_2d.geojson', 'docs/reference/guil_ngii_road_surfaces.geojson'];
const initialBytes = await Promise.all(inputPaths.map(path => readFile(new URL(`../${path}`, import.meta.url))));
const plan = JSON.parse(initialBytes[0]);
const source = JSON.parse(initialBytes[1]);
const officialSurfaces = JSON.parse(initialBytes[2]);
const sourceNames = Object.fromEntries(source.features.map(feature => [String(feature.id), feature.properties.name ?? null]));
const scene = () => buildPilotScene(plan, {sourceFeatureNames: sourceNames});
const near = (actual, expected, tolerance = 1e-5) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const polygons = geometry => geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
const rings = geometry => polygons(geometry).flat();
const vertices = geometry => rings(geometry).flat();
const rectangle = (west, south, east, north) => ({type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]});
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function insideRing(point, ring) {
  let winding = 0;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i];
    const side = cross(a, b, point);
    if (Math.abs(side) < 1e-8 && point[0] >= Math.min(a[0], b[0]) - 1e-8 && point[0] <= Math.max(a[0], b[0]) + 1e-8 && point[1] >= Math.min(a[1], b[1]) - 1e-8 && point[1] <= Math.max(a[1], b[1]) + 1e-8) return true;
    if (a[1] <= point[1] && b[1] > point[1] && side > 0) winding++;
    if (a[1] > point[1] && b[1] <= point[1] && side < 0) winding--;
  }
  return winding !== 0;
}

function contains(point, geometry) {
  return polygons(geometry).some(polygon => insideRing(point, polygon[0]) && !polygon.slice(1).some(hole => insideRing(point, hole)));
}

function assertContained(shape, site) {
  for (const ring of rings(shape)) for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i];
    for (let step = 0; step <= 100; step++) {
      const point = a.map((value, axis) => value + (b[axis] - value) * step / 100);
      assert.ok(contains(point, site), `design boundary leaves its own site at ${point}`);
    }
  }
  for (const polygon of polygons(site)) for (const hole of polygon.slice(1)) {
    assert.ok(!hole.some(point => contains(point, shape)), 'design must not cover a retained site hole');
  }
}

function properIntersection(a, b, c, d) {
  return cross(a, b, c) * cross(a, b, d) < -1e-10 && cross(c, d, a) * cross(c, d, b) < -1e-10;
}

function assertDisjoint(a, b, label) {
  for (const ringA of rings(a)) for (const ringB of rings(b)) {
    for (let i = 1; i < ringA.length; i++) for (let j = 1; j < ringB.length; j++) {
      assert.ok(!properIntersection(ringA[i - 1], ringA[i], ringB[j - 1], ringB[j]), `${label}: crossing polygon edges`);
    }
  }
  assert.ok(!vertices(a).some(point => contains(point, b)), `${label}: design vertex enters protected geometry`);
  assert.ok(!vertices(b).some(point => contains(point, a)), `${label}: design covers protected geometry`);
}

function onBoundary(point, geometry, tolerance = 1e-6) {
  return rings(geometry).some(ring => ring.slice(1).some((b, index) => {
    const a = ring[index], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return length > 0 && Math.abs(cross(a, b, point)) / length <= tolerance &&
      point[0] >= Math.min(a[0], b[0]) - tolerance && point[0] <= Math.max(a[0], b[0]) + tolerance &&
      point[1] >= Math.min(a[1], b[1]) - tolerance && point[1] <= Math.max(a[1], b[1]) + tolerance;
  }));
}

const strictlyContains = (point, geometry) => contains(point, geometry) && !onBoundary(point, geometry);
const interpolate = (a, b, fraction) => a.map((value, axis) => value + (b[axis] - value) * fraction);

function assertNoInteriorOverlap(a, b, label) {
  for (const ringA of rings(a)) for (const ringB of rings(b)) {
    for (let i = 1; i < ringA.length; i++) for (let j = 1; j < ringB.length; j++) {
      const first = [ringA[i - 1], ringA[i]], second = [ringB[j - 1], ringB[j]];
      const signedSide = (edge, point) => cross(...edge, point) / Math.hypot(...edge[1].map((value, axis) => value - edge[0][axis]));
      const signs = [signedSide(first, second[0]), signedSide(first, second[1]), signedSide(second, first[0]), signedSide(second, first[1])];
      // Source coordinates are near 680m. A coincident threshold has ~1e-13m
      // signed-side roundoff; require opposite physical sides beyond 1e-7m.
      const opposite = (left, right) => (left > 1e-7 && right < -1e-7) || (left < -1e-7 && right > 1e-7);
      assert.ok(!(opposite(signs[0], signs[1]) && opposite(signs[2], signs[3])), `${label}: crossing polygon edges`);
    }
  }
  for (const [from, to] of [[a, b], [b, a]]) for (const ring of rings(from)) for (let i = 1; i < ring.length; i++) {
    for (let step = 0; step <= 100; step++) {
      const point = interpolate(ring[i - 1], ring[i], step / 100);
      assert.ok(!strictlyContains(point, to), `${label}: boundary enters protected interior`);
      const length = Math.hypot(...ring[i].map((value, axis) => value - ring[i - 1][axis]));
      if (!length) continue;
      const normal = [(ring[i - 1][1] - ring[i][1]) / length, (ring[i][0] - ring[i - 1][0]) / length];
      for (const sign of [-1, 1]) {
        const offset = point.map((value, axis) => value + sign * normal[axis] * 1e-4);
        assert.ok(!(strictlyContains(offset, from) && strictlyContains(offset, to)), `${label}: shared boundary hides interior overlap`);
      }
    }
  }
}

function framePoint(design, long, short, original = false) {
  const center = original ? [679, 681] : design.frame.centerLocalM;
  return center.map((value, axis) => value + long * design.frame.longAxisLocalM[axis] + short * design.frame.shortAxisLocalM[axis]);
}

function frameBounds(geometry, design, original = false) {
  const center = original ? [679, 681] : design.frame.centerLocalM;
  const projected = vertices(geometry).map(point => [design.frame.longAxisLocalM, design.frame.shortAxisLocalM].map(direction =>
    direction.reduce((sum, value, axis) => sum + value * (point[axis] - center[axis]), 0)));
  return [Math.min(...projected.map(point => point[0])), Math.min(...projected.map(point => point[1])),
    Math.max(...projected.map(point => point[0])), Math.max(...projected.map(point => point[1]))];
}

function designShapes(design) {
  return [design.building.geometryLocalM, design.building.safetyEnvelopeGeometryLocalM, design.entrance.geometryLocalM, design.entrance.pathGeometryLocalM, design.parking.ramp.geometryLocalM, design.parking.deck.geometryLocalM, design.parking.connector.geometryLocalM,
    design.maintenance.geometryLocalM, design.maintenance.barrier.geometryLocalM, design.access.vehicle.turn.geometryLocalM,
    design.access.vehicle.lane.geometryLocalM, design.access.service.geometryLocalM];
}

test('planar clearance measures polygon areas, including edge interiors, holes and separate parts', () => {
  const donut = rectangle(0, 0, 10, 10);
  donut.coordinates.push(rectangle(2, 2, 8, 8).coordinates[0]);
  const multiple = {type: 'MultiPolygon', coordinates: [rectangle(-20, 0, -18, 2).coordinates, rectangle(0, 0, 2, 2).coordinates]};
  const duplicated = rectangle(0, 0, 2, 2);
  duplicated.coordinates[0].splice(1, 0, [...duplicated.coordinates[0][0]]);
  const cases = [
    [rectangle(0, 0, 2, 2), rectangle(5, 0, 7, 2), 3],
    [rectangle(0, 0, 1, 1), rectangle(4, 5, 6, 7), 5],
    [rectangle(0, 0, 10, 1), rectangle(4, 3, 6, 4), 2],
    [donut, rectangle(3, 4, 4, 5), 1],
    [multiple, rectangle(4, 0, 6, 2), 2],
    [duplicated, rectangle(5, 0, 7, 2), 3]
  ];
  for (const [a, b, expected] of cases) {
    const before = structuredClone([a, b]);
    for (const [from, to] of [[a, b], [b, a]]) {
      const result = measurePlanarClearance(from, to);
      near(result.distanceM, expected, 1e-8);
      assert.equal(result.intersects, false);
      for (const value of [result.fromPointLocalM, result.toPointLocalM]) assert.ok(value.length === 2 && value.every(Number.isFinite));
      near(Math.hypot(...result.fromPointLocalM.map((value, axis) => value - result.toPointLocalM[axis])), expected, 1e-8);
    }
    assert.deepEqual([a, b], before, 'measurement must preserve caller geometry');
  }
  const middle = measurePlanarClearance(cases[2][0], cases[2][1]);
  assert.deepEqual(middle.fromPointLocalM, [4, 1], 'nearest point lies inside the long edge, not at its vertices');
  assert.deepEqual(middle.toPointLocalM, [4, 3]);
});

test('planar contact, crossing and containment have zero distance without a safety conclusion', () => {
  const donut = rectangle(0, 0, 10, 10);
  donut.coordinates.push(rectangle(2, 2, 8, 8).coordinates[0]);
  for (const [a, b] of [
    [rectangle(0, 0, 2, 2), rectangle(2, 0, 4, 2)],
    [rectangle(0, 0, 2, 2), rectangle(2, 2, 4, 4)],
    [rectangle(-3, -1, 3, 1), rectangle(-1, -3, 1, 3)],
    [rectangle(0, 0, 10, 10), rectangle(3, 3, 4, 4)],
    [donut, rectangle(2, 4, 3, 5)]
  ]) for (const [from, to] of [[a, b], [b, a]]) {
    const result = measurePlanarClearance(from, to);
    assert.equal(result.distanceM, 0);
    assert.equal(result.intersects, true);
    assert.equal('safetyConclusion' in result, false);
  }
});

test('planar clearance rejects malformed geometry on either side instead of returning a usable distance', () => {
  const valid = rectangle(0, 0, 1, 1);
  const open = rectangle(0, 0, 1, 1); open.coordinates[0].pop();
  const nonfinite = rectangle(0, 0, 1, 1); nonfinite.coordinates[0][1][0] = Infinity;
  const notNumeric = rectangle(0, 0, 1, 1); notNumeric.coordinates[0][1][0] = '1';
  const nan = rectangle(0, 0, 1, 1); nan.coordinates[0][2][1] = NaN;
  const extraAxis = rectangle(0, 0, 1, 1); extraAxis.coordinates[0][1].push(0);
  const outsideHole = rectangle(0, 0, 2, 2); outsideHole.coordinates.push(rectangle(3, 3, 4, 4).coordinates[0]);
  const crossingHole = rectangle(0, 0, 2, 2); crossingHole.coordinates.push(rectangle(1, 1, 3, 3).coordinates[0]);
  const overlappingHoles = rectangle(0, 0, 10, 10);
  overlappingHoles.coordinates.push(rectangle(1, 1, 5, 5).coordinates[0], rectangle(4, 4, 7, 7).coordinates[0]);
  for (const malformed of [
    null, {}, {type: 'LineString', coordinates: [[0, 0], [1, 1]]}, {type: 'Polygon', coordinates: []},
    open, nonfinite, notNumeric, nan, extraAxis, outsideHole, crossingHole, overlappingHoles,
    {type: 'Polygon', coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]]},
    {type: 'Polygon', coordinates: [[[0, 0], [4, 4], [0, 3], [3, 0], [0, 0]]]},
    {type: 'MultiPolygon', coordinates: [rectangle(0, 0, 2, 2).coordinates, rectangle(1, 1, 3, 3).coordinates]}
  ]) {
    assert.throws(() => measurePlanarClearance(malformed, valid));
    assert.throws(() => measurePlanarClearance(valid, malformed));
  }
});

test('engineering review records both retained neighbours and the narrow facade-to-ramp interface as map distances', () => {
  const input = scene(), design = input.futureDesign, review = design.engineeringReview;
  const measured = review.clearances;
  assert.equal(measured.units, 'metres');
  assert.equal(measured.uncertainty, 'source_map_and_local_coordinate_accuracy_not_quantified');
  assert.deepEqual(measured.neighbourClearances.map(value => value.toFeatureId).sort(), input.scope.futureObstacleInventory.buildingIds.slice().sort());
  // Expected values were computed independently from source vertices before the public measurement implementation existed.
  const expectedNeighbours = {'way/252997589': 44.82358660921402, 'way/252997591': 22.71548187620641};
  for (const clearance of measured.neighbourClearances) near(clearance.distanceM, expectedNeighbours[clearance.toFeatureId], 1e-6);
  assert.equal(measured.nearestRoad.toFeatureId, 'ngii/376120316/N1A_A0010000/1');
  near(measured.nearestRoad.distanceM, 2.537390133858898, 1e-6);
  assert.equal(measured.nearestWalkway.toFeatureId, 'ngii/376120316/N1A_A0033320/22');
  near(measured.nearestWalkway.distanceM, 2.537390133858898, 1e-6);
  assert.equal(measured.rampClearance.toFeatureId, 'parking_ramp');
  near(measured.rampClearance.distanceM, 2.8, 1e-6);
  near(measurePlanarClearance(design.building.geometryLocalM, design.parking.ramp.geometryLocalM).distanceM, 4.4, 1e-6);
  near(design.building.safetyBufferM, 1.6);
  for (const clearance of [...measured.neighbourClearances, measured.nearestRoad, measured.nearestWalkway, measured.rampClearance]) {
    assert.equal(clearance.fromComponent, 'building_1_6m_envelope');
    assert.equal(clearance.status, 'measured_2d_not_engineering_clearance');
    assert.equal(clearance.intersects, false);
    near(Math.hypot(...clearance.fromPointLocalM.map((value, axis) => value - clearance.toPointLocalM[axis])), clearance.distanceM, 1e-6);
  }
});

test('passed polygon validation leaves engineering safety unassessed and repetition on hold without mutating source', async () => {
  const input = scene(), before = structuredClone(input), design = buildFutureApartment(input), review = design.engineeringReview;
  assert.equal(design.validation.status, 'passed');
  assert.equal(review.status, 'requires_multidisciplinary_review');
  assert.equal(review.safetyConclusion, 'not_assessed');
  assert.equal(review.replicationGate, 'hold_pending_review');
  assert.equal(review.scope, 'current_118_pilot_only_not_whole_complex_or_city');
  assert.equal(review.automaticScope, '2d_polygon_intersections_and_minimum_planar_distances_only');
  assert.equal(review.basis.designHeightM, design.building.heightM);
  for (const key of ['surroundingHeightsVerified', 'terrainVerified', 'fullInfluenceAreaCovered', 'cadastralBoundariesVerified', 'structureModelAvailable']) assert.equal(review.basis[key], false, key);
  const expectedStatuses = {
    structure_ground: 'unverified', sunlight_privacy: 'unverified', wind_heat: 'unverified', fire_access: 'needs_revision',
    pedestrian_vehicle: 'unverified', drainage_flood: 'unverified', energy_air_noise: 'unverified', maintenance_interfaces: 'unverified'
  };
  assert.deepEqual(Object.fromEntries(review.checks.map(value => [value.id, value.status])), expectedStatuses);
  assert.equal(review.checks.length, 8);
  for (const check of review.checks) assert.ok(check.interaction && check.missingEvidence.length > 0, `${check.id}: must explain interaction and missing evidence`);
  assert.match(review.checks.find(value => value.id === 'pedestrian_vehicle').resolvedGeometry, /0m/);
  assert.match(review.checks.find(value => value.id === 'maintenance_interfaces').resolvedGeometry, /2\.80m/);
  assert.match(review.checks.find(value => value.id === 'fire_access').knownIssue, /회차/);
  assert.deepEqual(review.resolvedGeometryIssues.map(value => [value.id, value.beforeDistanceM]), [['ramp_interface', .2], ['sidewalk_connection', .6]]);
  near(review.resolvedGeometryIssues[0].afterDistanceM, 2.8, 1e-6);
  near(review.resolvedGeometryIssues[1].afterDistanceM, 0);
  assert.deepEqual(input, before);
  review.clearances.neighbourClearances[0].fromPointLocalM[0] += 10;
  assert.deepEqual(input, before, 'review witnesses must be detached from source and prior scene');
  assert.deepEqual(buildFutureApartment(input), before.futureDesign);
  const currentBytes = await Promise.all(inputPaths.map(path => readFile(new URL(`../${path}`, import.meta.url))));
  currentBytes.forEach((bytes, index) => assert.equal(hash(bytes), hash(initialBytes[index]), inputPaths[index]));
});

test('reconstruction design changes its footprint while preserving every source anchor and complex identity', async () => {
  const output = scene();
  const design = output.futureDesign;
  assert.ok(design, 'pilot includes an explicit future reconstruction design');
  assert.equal(design.targetSourceId, output.building.sourceId);
  assert.equal(design.siteComplexId, 'complex/way/439886810');
  assert.equal(design.siteZoneId, '2050/way/439886810');
  assert.match(design.status, /2050|design|concept|reconstruction/);
  assert.notDeepEqual(design.building.geometryLocalM, output.building.geometryLocalM, 'current mapped dwelling outline is an anchor, not the new tower footprint');
  const target = plan.features.find(feature => feature.id === output.building.sourceId);
  assert.deepEqual(output.building.geometryLocalM, target.geometry);
  assert.deepEqual(output.building.geometryLocalM, source.features.find(feature => String(feature.id) === target.id).properties.local_geometry_m);
  assert.equal(output.building.complexId, target.complexId);
  assert.equal(output.building.zoneId, target.zoneId);
  for (const building of output.contextBuildings) assert.deepEqual(building.geometryLocalM, plan.features.find(feature => feature.id === building.sourceId).geometry);
  for (const zone of output.contextZones) assert.deepEqual(zone.geometryLocalM, plan.zones.find(item => item.id === zone.id).geometry);
  for (const surface of output.surfaces) assert.deepEqual(surface.geometryLocalM, officialSurfaces.features.find(feature => String(feature.id) === surface.id).properties.local_geometry_m);
  const road = plan.features.find(feature => feature.id === 'way/252921539');
  assert.deepEqual(output.roadProfiles, road.roadCrossProfiles.filter(profile => output.roadProfiles.some(item => item.id === profile.id)));
  assert.deepEqual(output.residentialComplexes, plan.residentialComplexes.filter(complex => output.residentialComplexes.some(item => item.id === complex.id)));
  assert.equal(output.restrictions.localOnly, true);
  assert.equal(output.restrictions.publicationAllowed, false);
  assert.match(design.notices.join('\n'), /설계|구상|concept|design/);
  const currentBytes = await Promise.all(inputPaths.map(path => readFile(new URL(`../${path}`, import.meta.url))));
  currentBytes.forEach((bytes, index) => assert.equal(hash(bytes), hash(initialBytes[index]), inputPaths[index]));
});

test('new building, entrance and underground parking stay inside G05 and avoid roads, sidewalks and preserved neighbours', () => {
  const input = scene(), design = input.futureDesign;
  near(design.building.lengthM, 62);
  near(design.building.depthM, 22);
  near(design.building.heightM, 78.4);
  assert.equal(design.building.floorCount, 24);
  assert.equal(design.building.residentialFloorCount, 23);
  near(design.parking.ramp.widthM, 6);
  near(design.parking.ramp.lengthM, 36);
  near(design.parking.deck.elevationM, -3.6);
  near(design.parking.deck.lengthM, 60);
  near(design.parking.deck.depthM, 20);
  const site = input.contextZones.find(zone => zone.id === design.siteZoneId);
  for (const shape of designShapes(design)) {
    assert.equal(shape.type, 'Polygon');
    assert.ok(vertices(shape).every(point => point.length === 2 && point.every(Number.isFinite)));
    assertContained(shape, site.geometryLocalM);
    for (const surface of input.surfaces) {
      if (shape === design.entrance.pathGeometryLocalM && ['ngii/376120316/N1A_A0033320/22', 'ngii/376120316/N1A_A0010000/1'].includes(surface.id)) {
        assertNoInteriorOverlap(shape, surface.geometryLocalM, surface.id);
      } else assertDisjoint(shape, surface.geometryLocalM, surface.id);
    }
    for (const building of input.contextBuildings) assertDisjoint(shape, building.geometryLocalM, building.sourceId);
    for (const zone of input.contextZones.filter(zone => zone.id !== design.siteZoneId)) assertDisjoint(shape, zone.geometryLocalM, zone.id);
  }
  near(Math.hypot(...design.frame.longAxisLocalM), 1);
  near(Math.hypot(...design.frame.shortAxisLocalM), 1);
  near(design.frame.longAxisLocalM.reduce((sum, value, axis) => sum + value * design.frame.shortAxisLocalM[axis], 0), 0);
  const dimensions = vertices(design.building.geometryLocalM).map(point => {
    const delta = point.map((value, axis) => value - design.frame.centerLocalM[axis]);
    return [design.frame.longAxisLocalM, design.frame.shortAxisLocalM].map(direction => delta.reduce((sum, value, axis) => sum + value * direction[axis], 0));
  });
  near(Math.max(...dimensions.map(point => point[0])) - Math.min(...dimensions.map(point => point[0])), design.building.lengthM);
  near(Math.max(...dimensions.map(point => point[1])) - Math.min(...dimensions.map(point => point[1])), design.building.depthM);
  assert.equal(design.building.floorCount, design.building.residentialFloorCount + 1);
  near(design.building.podiumHeightM + design.building.residentialFloorCount * design.building.floorHeightM, design.building.heightM);
  assert.ok(design.parking.ramp.startElevationM >= 0);
  assert.ok(design.parking.ramp.endElevationM < 0);
  near(design.parking.deck.elevationM, design.parking.ramp.endElevationM);
  assert.ok(design.parking.ramp.widthM > 0 && design.parking.ramp.lengthM > 0);
  near(Math.hypot(...design.parking.ramp.endLocalM.map((value, axis) => value - design.parking.ramp.startLocalM[axis])), design.parking.ramp.lengthM);
  near(Math.abs(design.parking.ramp.endElevationM - design.parking.ramp.startElevationM) / design.parking.ramp.lengthM, design.parking.ramp.slopeRatio);
  assert.deepEqual(design.parking.ramp.endLocalM, design.parking.connector.startLocalM);
  assert.ok(contains(design.parking.ramp.endLocalM, design.parking.connector.geometryLocalM), 'lower ramp end reaches the underground connector edge');
  assert.ok(contains(design.parking.connector.endLocalM, design.parking.deck.geometryLocalM), 'connector lower end reaches the underground concept deck');
});

test('future builder is deterministic, pure and returns detached geometry', () => {
  const input = scene(), before = structuredClone(input);
  const result = buildFutureApartment(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result, buildFutureApartment(input));
  result.building.geometryLocalM.coordinates[0][0][0] += 10;
  result.parking.ramp.geometryLocalM.coordinates[0][0][0] += 10;
  result.maintenance.geometryLocalM.coordinates[0][0][0] += 10;
  result.maintenance.centerLineLocalM[0][0] += 10;
  result.access.vehicle.turn.geometryLocalM.coordinates[0][0][0] += 10;
  result.access.vehicle.approach.centerLineLocalM[0][0] += 10;
  assert.deepEqual(input, before);
  assert.deepEqual(buildFutureApartment(input), before.futureDesign);
});

test('frontage approach joins the plaza and original sidewalk across its complete 2.4m terminal edge', () => {
  const input = scene(), design = input.futureDesign, entrance = design.entrance;
  near(entrance.sidewalkGapM, 0);
  near(entrance.pathWidthM, 2.4);
  assert.ok(strictlyContains(entrance.pathStartLocalM, entrance.geometryLocalM), 'the path starts inside the lobby plaza');
  const direction = entrance.pathEndLocalM.map((value, axis) => value - entrance.pathStartLocalM[axis]);
  const run = Math.hypot(...direction);
  const projected = entrance.pathGeometryLocalM.coordinates[0].slice(0, -1).map(point => ({point,
    distance: point.reduce((sum, value, axis) => sum + (value - entrance.pathStartLocalM[axis]) * direction[axis] / run, 0)}));
  const endDistance = Math.max(...projected.map(value => value.distance));
  const terminal = projected.filter(value => Math.abs(value.distance - endDistance) < 1e-6).map(value => value.point);
  assert.equal(terminal.length, 2, 'contact is a terminal edge, not an isolated nearest vertex');
  near(Math.hypot(...terminal[0].map((value, axis) => value - terminal[1][axis])), 2.4, 1e-6);
  terminal[0].forEach((_, axis) => near((terminal[0][axis] + terminal[1][axis]) / 2, entrance.pathEndLocalM[axis]));
  for (const id of ['ngii/376120316/N1A_A0033320/22', 'ngii/376120316/N1A_A0010000/1']) {
    const surface = input.surfaces.find(value => value.id === id);
    for (let step = 0; step <= 100; step++) assert.ok(onBoundary(interpolate(terminal[0], terminal[1], step / 100), surface.geometryLocalM), `${id}: full terminal edge must lie on the retained boundary`);
    assertNoInteriorOverlap(entrance.pathGeometryLocalM, surface.geometryLocalM, id);
    near(measurePlanarClearance(entrance.pathGeometryLocalM, surface.geometryLocalM).distanceM, 0);
  }
  for (let step = 0; step < 100; step++) {
    assert.ok(contains(interpolate(entrance.pathStartLocalM, entrance.pathEndLocalM, step / 100), entrance.pathGeometryLocalM));
  }
  assert.ok(onBoundary(entrance.doorLocalM, design.building.geometryLocalM));
  assert.ok(onBoundary(entrance.doorLocalM, entrance.geometryLocalM), 'lobby plaza meets the door threshold');
});

test('maintenance route has a continuous 2.4m strip, keeps the ramp fixed and adds an inspectable protection barrier', () => {
  const input = scene(), design = input.futureDesign, maintenance = design.maintenance;
  near(design.frame.centerLocalM[0], 679 + 2.6 * design.frame.shortAxisLocalM[0]);
  near(design.frame.centerLocalM[1], 681 + 2.6 * design.frame.shortAxisLocalM[1]);
  frameBounds(design.parking.ramp.geometryLocalM, design, true).forEach((value, index) => near(value, [-18, -18.8, 18, -12.8][index]));
  near(maintenance.widthM, 2.4);
  assertDisjoint(maintenance.geometryLocalM, design.building.safetyEnvelopeGeometryLocalM, 'maintenance versus facade envelope');
  assertDisjoint(maintenance.geometryLocalM, design.parking.ramp.geometryLocalM, 'maintenance versus ramp');
  for (const [long, short, normal] of [[0, -11.4, [0, 1]], [34, 0, [1, 0]], [20, 17.2, [0, 1]]]) {
    for (const sign of [-1, 1]) {
      assert.ok(contains(framePoint(design, long + sign * normal[0] * 1.2, short + sign * normal[1] * 1.2, true), maintenance.geometryLocalM), 'full nominal maintenance width remains in the route');
      assert.ok(!contains(framePoint(design, long + sign * normal[0] * 1.22, short + sign * normal[1] * 1.22, true), maintenance.geometryLocalM), 'nominal width is represented by actual polygon edges');
    }
  }
  assert.ok(Array.isArray(maintenance.centerLineLocalM) && maintenance.centerLineLocalM.length >= 3);
  for (let index = 1; index < maintenance.centerLineLocalM.length; index++) for (let step = 0; step <= 100; step++) {
    assert.ok(contains(interpolate(maintenance.centerLineLocalM[index - 1], maintenance.centerLineLocalM[index], step / 100), maintenance.geometryLocalM), 'maintenance centre line is continuous inside its polygon');
  }
  near(maintenance.barrier.heightM, 1.1);
  const barrierBounds = frameBounds(maintenance.barrier.geometryLocalM, design, true);
  near(barrierBounds[2] - barrierBounds[0], 36);
  near(barrierBounds[3] - barrierBounds[1], .12);
  assertDisjoint(maintenance.barrier.geometryLocalM, design.parking.ramp.geometryLocalM, 'barrier versus ramp');
  assertDisjoint(maintenance.barrier.geometryLocalM, maintenance.geometryLocalM, 'barrier versus usable route');
  for (let step = 0; step <= 100; step++) {
    const point = framePoint(design, 8, 16 + 2.4 * step / 100, true);
    assert.ok(onBoundary(point, maintenance.geometryLocalM) && onBoundary(point, design.entrance.geometryLocalM), 'maintenance route meets the plaza across its complete width');
  }
});

test('vehicle entry, ramp branch and through service route have full-width public-road endpoints and a separate lateral pad', () => {
  const input = scene(), design = input.futureDesign, vehicle = design.access.vehicle;
  const approach = vehicle.approach.geometryLocalM, turn = vehicle.turn.geometryLocalM, lane = vehicle.lane.geometryLocalM;
  near(vehicle.approach.widthM, 6);
  near(vehicle.turn.widthM, 6);
  near(vehicle.lane.widthM, 6);
  near(design.access.service.widthM, 6);
  near(design.access.service.lengthM, 12);
  frameBounds(approach, design, true).forEach((value, index) => near(value, [-54, -18.8, -18, -12.8][index]));
  frameBounds(lane, design, true).forEach((value, index) => near(value, [-39, -9.8, -33, 9.6][index]));
  frameBounds(design.access.service.geometryLocalM, design, true).forEach((value, index) => near(value, [-45, -4.5, -39, 7.5][index]));
  for (const [long, from, to] of [[-18, approach, design.parking.ramp.geometryLocalM]]) for (let step = 0; step <= 100; step++) {
    const point = framePoint(design, long, -18.8 + 6 * step / 100, true);
    assert.ok(onBoundary(point, from) && onBoundary(point, to), 'all six metres of the approach reach the ramp upper edge');
  }
  for (let step = 0; step <= 100; step++) {
    const point = framePoint(design, -39 + 6 * step / 100, -9.8, true);
    assert.ok(onBoundary(point, turn) && onBoundary(point, lane), 'curved branch joins the lane across its full width');
    assert.ok(contains(framePoint(design, -42, -18.8 + 6 * step / 100, true), approach));
    assert.ok(onBoundary(framePoint(design, -42, -18.8 + 6 * step / 100, true), turn));
  }
  assertNoInteriorOverlap(design.access.service.geometryLocalM, lane, 'lateral pad preserves through lane');
  assert.equal(design.access.service.separateFromThroughLane, true);
  for (let step = 0; step <= 100; step++) {
    const point = framePoint(design, -39, -4.5 + 12 * step / 100, true);
    assert.ok(onBoundary(point, lane) && onBoundary(point, design.access.service.geometryLocalM), 'pad shares its complete lateral entrance with lane');
  }
  const exit = vehicle.exit.geometryLocalM;
  frameBounds(exit, design, true).forEach((value, index) => near(value, [-39, 9.6, -33, 25][index]));
  for (let step = 0; step <= 100; step++) {
    const point = framePoint(design, -39 + 6 * step / 100, 9.6, true);
    assert.ok(onBoundary(point, lane) && onBoundary(point, exit), 'six-metre lane threshold reaches exit');
  }
  const exitRoad = input.surfaces.find(surface => surface.id === vehicle.exitRoadId);
  for (let step = 0; step <= 100; step++) {
    const point = interpolate(...vehicle.roadExitEdgeLocalM, step / 100);
    assert.ok(strictlyContains(point, exitRoad.geometryLocalM), 'whole exit edge lies inside mapped road residual');
    for (const surface of input.surfaces.filter(value => value.kind === 'walkway')) assert.ok(!contains(point, surface.geometryLocalM));
  }
  assert.deepEqual(input.surfaces.filter(surface => measurePlanarClearance(exit, surface.geometryLocalM).intersects).map(surface => surface.id).sort(), ['ngii/376120316/N1A_A0010000/1', 'ngii/376120316/N1A_A0033320/22']);
  assert.deepEqual(vehicle.exit.centerLineLocalM[0], vehicle.lane.centerLineLocalM.at(-1));
  assert.equal(design.access.fire.deadEndResolvedPlanar, true);
  assert.equal(design.access.fire.sweptVehicleEnvelopeVerified, false);
  assert.equal(design.access.fire.ladderOperatingSpaceVerified, false);
  const overlaps = input.surfaces.filter(surface => measurePlanarClearance(approach, surface.geometryLocalM).intersects).map(surface => surface.id).sort();
  assert.deepEqual(overlaps, ['ngii/376120316/N1A_A0010000/3', 'ngii/376120316/N1A_A0033320/23']);
  const road = input.surfaces.find(surface => surface.id === overlaps[0]);
  assert.ok(strictlyContains(framePoint(design, -54, -15.8, true), road.geometryLocalM), 'entry starts within the retained road surface');
  for (let step = 0; step <= 100; step++) {
    const point = framePoint(design, -54, -18.8 + 6 * step / 100, true);
    assert.ok(strictlyContains(point, road.geometryLocalM), 'full-width entry edge lies inside the retained road area');
    for (const surface of input.surfaces.filter(value => value.kind === 'walkway')) assert.ok(!contains(point, surface.geometryLocalM), 'road entry edge must be clear of every mapped sidewalk');
  }
  assert.ok(vertices(approach).some(point => !contains(point, input.contextZones.find(zone => zone.id === design.siteZoneId).geometryLocalM)), 'public approach is an explicit bounded extension beyond G05');
  const bounds = input.scope.boundsLocalM;
  assert.ok(vertices(approach).every(point => point[0] > bounds.minX && point[0] < bounds.maxX && point[1] > bounds.minY && point[1] < bounds.maxY));
  for (const building of input.contextBuildings) assertDisjoint(approach, building.geometryLocalM, building.sourceId);
  for (const zone of input.contextZones.filter(zone => zone.id !== design.siteZoneId)) assertDisjoint(approach, zone.geometryLocalM, zone.id);
  assert.equal(design.access.fire.turnaroundVerified, false);
  assert.equal(design.access.fire.status, 'needs_revision');
});

test('pedestrian protection concepts use precisely clipped source walkway areas without a safety or grade claim', () => {
  const input = scene(), design = input.futureDesign;
  assert.equal(design.access.crossings.length, 2);
  for (const crossing of design.access.crossings) {
    const walkway = input.surfaces.find(value => value.id === crossing.walkwayId).geometryLocalM;
    const route = design.access.vehicle[crossing.vehicleRouteName].geometryLocalM;
    assertContained(crossing.geometryLocalM, walkway);
    assertContained(crossing.geometryLocalM, route);
    assert.deepEqual(crossing.geometryLocalM, clipAccessCrossing(walkway, route));
    for (const point of vertices(crossing.geometryLocalM)) assert.ok(onBoundary(point, walkway) || onBoundary(point, route));
    assert.equal(crossing.vehicleYieldRequired, true);
    assert.equal(crossing.pedestrianPriority, true);
    assert.equal(crossing.gradeStatus, 'unverified');
    assert.equal(crossing.protection.physicalProtectionVerified, false);
    assert.equal(crossing.protection.visibilityVerified, false);
    near(crossing.widths.vehicleRouteM, 6);
    assert.equal(crossing.widths.mappedWalkwayM, null);
  }
});

test('convex route clipping preserves normal intersections and rejects boundary-only, holes, malformed and disconnected crossings', () => {
  const source = rectangle(0, 0, 10, 2), route = rectangle(4, -3, 6, 4), before = structuredClone([source, route]);
  assert.deepEqual(clipAccessCrossing(source, route), rectangle(4, 0, 6, 2));
  const reversed = structuredClone(source); reversed.coordinates[0].reverse();
  const clipped = clipAccessCrossing(reversed, route);
  assertContained(clipped, rectangle(4, 0, 6, 2));
  assert.deepEqual([source, route], before);
  const hole = rectangle(0, 0, 10, 10); hole.coordinates.push(rectangle(2, 2, 8, 8).coordinates[0]);
  const disconnected = {type: 'Polygon', coordinates: [[[0, 0], [6, 0], [6, 6], [4, 6], [4, 2], [2, 2], [2, 6], [0, 6], [0, 0]]]};
  const open = rectangle(0, 0, 10, 2); open.coordinates[0].pop();
  const nonfinite = structuredClone(source); nonfinite.coordinates[0][1][0] = NaN;
  for (const [a, b] of [
    [source, rectangle(10, 0, 12, 2)], [source, rectangle(20, 0, 22, 2)], [hole, route],
    [disconnected, rectangle(-1, 3, 7, 5)], [source, disconnected], [open, route], [nonfinite, route],
    [{type: 'MultiPolygon', coordinates: [source.coordinates, rectangle(20, 0, 30, 2).coordinates]}, route]
  ]) assert.throws(() => clipAccessCrossing(a, b));
});

test('exit interface refuses road holes, removed walkway contact, unregistered obstacles and coverage truncation', () => {
  const base = scene(), design = base.futureDesign;
  for (const change of [
    input => {
      const centre = framePoint(design, -36, 25, true);
      input.surfaces.find(value => value.id === design.access.vehicle.exitRoadId).geometryLocalM.coordinates.push(rectangle(centre[0] - .1, centre[1] - .1, centre[0] + .1, centre[1] + .1).coordinates[0]);
    },
    input => { input.surfaces.find(value => value.id === design.access.vehicle.exitCrossedWalkwayId).geometryLocalM = rectangle(100, 100, 101, 101); },
    input => { input.contextBuildings[0].geometryLocalM = structuredClone(design.access.vehicle.exit.geometryLocalM); },
    input => { input.scope.boundsLocalM.maxY = Math.max(...vertices(design.access.vehicle.exit.geometryLocalM).map(point => point[1])) - .01; },
    input => { input.contextZones.find(value => value.id === design.siteZoneId).geometryLocalM.coordinates.push(rectangle(640, 692, 641, 693).coordinates[0]); }
  ]) {
    const input = structuredClone(base); change(input); const before = structuredClone(input);
    assert.throws(() => buildFutureApartment(input));
    assert.deepEqual(input, before);
  }
});

test('missing source identity, boundary and obstacle evidence fail closed', () => {
  for (const change of [
    input => { delete input.building; },
    input => { input.building.sourceId = 'unrelated-source'; },
    input => { input.building.complexId = 'complex/way/439886809'; },
    input => { input.building.zoneId = '2050/way/439886809'; },
    input => { input.building.geometryLocalM.coordinates[0][0][0] = NaN; },
    input => { input.residentialComplexes = []; },
    input => { input.residentialComplexes.find(complex => complex.id === input.building.complexId).memberFeatureIds = []; },
    input => { input.contextZones = input.contextZones.filter(zone => zone.id !== input.building.zoneId); },
    input => { input.contextZones.find(zone => zone.id === input.building.zoneId).complexId = 'wrong-complex'; },
    input => { delete input.contextZones.find(zone => zone.id === input.building.zoneId).architectureIdentity; },
    input => { input.contextZones.find(zone => zone.id === input.building.zoneId).architectureIdentity.id = 'another-compound'; },
    input => { input.residentialComplexes.find(complex => complex.id === input.building.complexId).architectureIdentityId = 'another-compound'; },
    input => { input.contextZones.find(zone => zone.id === input.building.zoneId).geometryLocalM.coordinates.push(rectangle(0, 0, 1, 1).coordinates[0]); },
    input => { input.surfaces = []; },
    input => { input.surfaces[0].geometryLocalM.coordinates = []; },
    input => { input.contextBuildings = []; }
  ]) {
    const input = scene();
    change(input);
    assert.throws(() => buildFutureApartment(input), 'incomplete evidence must not produce an approved design');
  }
  for (const input of [null, {}, {building: {}}, {building: {geometryLocalM: rectangle(0, 0, 1, 1)}}]) assert.throws(() => buildFutureApartment(input));
});

test('site holes, narrow parcel and blocking roads or neighbours cannot silently approve conflicting designs', () => {
  const base = scene();
  const centre = base.futureDesign.frame.centerLocalM;
  const forbidden = rectangle(centre[0] - .1, centre[1] - .1, centre[0] + .1, centre[1] + .1);
  const holeInput = structuredClone(base);
  const holeSite = holeInput.contextZones.find(zone => zone.id === holeInput.building.zoneId);
  holeSite.geometryLocalM.coordinates.push(forbidden.coordinates[0]);
  // A hole wholly inside the tower defeats vertex-only containment checks.
  let holeResult;
  try { holeResult = buildFutureApartment(holeInput); } catch (error) { assert.ok(error instanceof Error); }
  if (holeResult) for (const shape of designShapes(holeResult)) assertContained(shape, holeSite.geometryLocalM);

  const narrowInput = structuredClone(base);
  narrowInput.contextZones.find(zone => zone.id === narrowInput.building.zoneId).geometryLocalM = rectangle(centre[0] - 1, centre[1] - 1, centre[0] + 1, centre[1] + 1);
  assert.throws(() => buildFutureApartment(narrowInput), 'a 2m-wide site cannot fit a residential tower and a vehicle ramp');

  for (const kind of ['road', 'neighbour']) {
    const input = structuredClone(base);
    const site = input.contextZones.find(zone => zone.id === input.building.zoneId);
    if (kind === 'road') input.surfaces.find(surface => surface.kind === 'road_corridor').geometryLocalM = structuredClone(site.geometryLocalM);
    else input.contextBuildings[0].geometryLocalM = structuredClone(site.geometryLocalM);
    assert.throws(() => buildFutureApartment(input), `${kind} occupying the entire site cannot be ignored`);
  }
});

test('interface exceptions fail closed for interior intrusion, missing contact and mismatched source kinds', () => {
  const base = scene();
  for (const change of [
    input => { input.surfaces.find(value => value.id === 'ngii/376120316/N1A_A0010000/1').geometryLocalM = structuredClone(input.futureDesign.entrance.pathGeometryLocalM); },
    input => { input.surfaces.find(value => value.id === 'ngii/376120316/N1A_A0033320/22').geometryLocalM = structuredClone(input.futureDesign.entrance.geometryLocalM); },
    input => { input.surfaces.find(value => value.id === 'ngii/376120316/N1A_A0010000/3').geometryLocalM = structuredClone(input.futureDesign.access.service.geometryLocalM); },
    input => { input.surfaces.find(value => value.id === 'ngii/376120316/N1A_A0033320/23').geometryLocalM = rectangle(700, 740, 701, 741); },
    input => { input.surfaces.find(value => value.id === 'ngii/376120316/N1A_A0010000/1').kind = 'walkway'; },
    input => { input.surfaces.find(value => value.id === 'ngii/376120316/N1A_A0033320/22').kind = 'road_corridor'; },
    input => { input.surfaces.find(value => value.id === 'ngii/376120316/N1A_A0010000/3').kind = 'walkway'; },
    input => { input.surfaces.find(value => value.id === 'ngii/376120316/N1A_A0033320/23').kind = 'road_corridor'; },
    input => { input.scope.boundsLocalM.minX = Math.min(...vertices(input.futureDesign.access.vehicle.approach.geometryLocalM).map(point => point[0])) + .01; }
  ]) {
    const input = structuredClone(base);
    change(input);
    const before = structuredClone(input);
    assert.throws(() => buildFutureApartment(input), 'a declared interface cannot become a blanket road or sidewalk overlap exemption');
    assert.deepEqual(input, before, 'failed generation preserves original scene records');
  }
  const expected = {
    entrance_approach: ['ngii/376120316/N1A_A0010000/1', 'ngii/376120316/N1A_A0033320/22'],
    vehicle_approach: ['ngii/376120316/N1A_A0010000/3', 'ngii/376120316/N1A_A0033320/23'],
    vehicle_exit: ['ngii/376120316/N1A_A0010000/1', 'ngii/376120316/N1A_A0033320/22']
  };
  for (const check of base.futureDesign.validation.checks) {
    assert.deepEqual(check.declaredInterfaces.map(value => value.sourceId).sort(), expected[check.component] ?? []);
    assert.equal(check.insideG05, !['vehicle_approach', 'vehicle_exit'].includes(check.component));
    assert.equal(check.testedObstacleCount, base.surfaces.length + base.contextBuildings.length);
    for (const value of check.declaredInterfaces) assert.equal(value.kind, check.component === 'entrance_approach' ? 'boundary_contact_only' : 'planned_driveway_area_crossing_not_existing_or_approved');
  }
});

function box(object) {
  object.updateWorldMatrix(true, true);
  return new THREE.Box3().setFromObject(object, true);
}

function dispose(group) {
  const materials = new Set();
  group.traverse(object => {
    object.geometry?.dispose();
    for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) materials.add(material);
  });
  materials.forEach(material => material.dispose());
}

function windowCentres(mesh) {
  assert.ok(mesh instanceof THREE.InstancedMesh, 'repeated facade windows use one inspectable instanced mesh');
  mesh.updateWorldMatrix(true, true);
  return Array.from({length: mesh.count}, (_, index) => {
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(index, matrix);
    return new THREE.Vector3().setFromMatrixPosition(matrix.premultiply(mesh.matrixWorld));
  });
}

function assertResidentialRows(centres, podiumHeight, heightM, floorCount) {
  const floorHeight = (heightM - podiumHeight) / floorCount;
  const floors = new Map();
  for (const centre of centres) {
    assert.ok(centre.y > podiumHeight && centre.y < heightM, 'actual window centre must lie on a residential floor');
    const floor = Math.floor((centre.y - podiumHeight) / floorHeight);
    if (!floors.has(floor)) floors.set(floor, []);
    floors.get(floor).push(centre.y - podiumHeight - floor * floorHeight);
  }
  assert.equal(floors.size, floorCount, 'every residential floor has actual openings');
  let referenceOffsets, referenceCount;
  for (let floor = 0; floor < floorCount; floor++) {
    assert.ok(floors.has(floor), `residential floor ${floor + 1} cannot be skipped`);
    const offsets = [...new Set(floors.get(floor).map(value => value.toFixed(4)))].map(Number).sort((a, b) => a - b);
    if (referenceOffsets) {
      assert.equal(offsets.length, referenceOffsets.length, 'living and bedroom window height patterns repeat per floor');
      offsets.forEach((offset, index) => near(offset, referenceOffsets[index], 2e-4));
      assert.equal(floors.get(floor).length, referenceCount, 'opening count repeats per floor');
    }
    referenceOffsets = offsets;
    referenceCount = floors.get(floor).length;
  }
}

// Inspect actual geometry after both the parent transform and each instance
// transform. These bounds do not depend on facade metadata or layout constants.
function facadeBounds(mesh, design, origin) {
  assert.ok(mesh?.isMesh, 'facade element must expose rendered geometry');
  mesh.updateWorldMatrix(true, true);
  const positions = mesh.geometry.getAttribute('position');
  return Array.from({length: mesh.isInstancedMesh ? mesh.count : 1}, (_, instance) => {
    const matrix = mesh.matrixWorld.clone();
    if (mesh.isInstancedMesh) {
      const local = new THREE.Matrix4();
      mesh.getMatrixAt(instance, local);
      matrix.multiply(local);
    }
    const bounds = new THREE.Box3();
    for (let vertex = 0; vertex < positions.count; vertex++) {
      const world = new THREE.Vector3().fromBufferAttribute(positions, vertex).applyMatrix4(matrix);
      const east = world.x + origin[0] - design.frame.centerLocalM[0];
      const north = origin[1] - world.z - design.frame.centerLocalM[1];
      bounds.expandByPoint(new THREE.Vector3(
        east * design.frame.longAxisLocalM[0] + north * design.frame.longAxisLocalM[1],
        world.y,
        east * design.frame.shortAxisLocalM[0] + north * design.frame.shortAxisLocalM[1]
      ));
    }
    return bounds;
  });
}

function intervalUnion(intervals) {
  const merged = [];
  for (const interval of intervals.slice().sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1] + 1e-5) previous[1] = Math.max(previous[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged;
}

function horizontalIntervals(bounds, axis, elevation) {
  return intervalUnion(bounds.filter(item => item.min.y <= elevation && item.max.y >= elevation).map(item => [item.min[axis], item.max[axis]]));
}

function assertRenderedEnvelope(superstructure, envelope, origin) {
  superstructure.updateWorldMatrix(true, true);
  superstructure.traverse(object => {
    if (!object.isMesh) return;
    const positions = object.geometry.getAttribute('position');
    const instances = object.isInstancedMesh ? object.count : 1;
    for (let instance = 0; instance < instances; instance++) {
      const matrix = object.matrixWorld.clone();
      if (object.isInstancedMesh) {
        const local = new THREE.Matrix4();
        object.getMatrixAt(instance, local);
        matrix.multiply(local);
      }
      for (let index = 0; index < positions.count; index++) {
        const point = new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(matrix);
        assert.ok(contains([point.x + origin[0], origin[1] - point.z], envelope), `${object.name}: actual rendered vertex exceeds the validated facade envelope`);
      }
    }
  });
}

function assertRenderedFootprint(mesh, geometry, origin) {
  assert.ok(mesh?.isMesh, 'access surface is independently inspectable');
  mesh.updateWorldMatrix(true, true);
  const positions = mesh.geometry.getAttribute('position');
  const actual = Array.from({length: positions.count}, (_, index) => {
    const point = new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld);
    return [point.x + origin[0], origin[1] - point.z];
  });
  for (const point of actual) assert.ok(contains(point, geometry) || onBoundary(point, geometry, 2e-5), `${mesh.name}: rendered vertex exceeds declared polygon`);
  for (const axis of [0, 1]) for (const extrema of [Math.min, Math.max]) {
    near(extrema(...actual.map(point => point[axis])), extrema(...vertices(geometry).map(point => point[axis])), 2e-5);
  }
  return actual;
}

test('rendered maintenance and access meshes preserve validated footprints, curve areas and barrier height', () => {
  const input = scene(), design = input.futureDesign, before = structuredClone(design), origin = input.coordinates.originLocalM;
  const group = createFutureApartment(design, origin);
  try {
    for (const [name, route] of [
      ['future-maintenance-path', design.maintenance], ['future-vehicle-approach', design.access.vehicle.approach],
      ['future-service-turn', design.access.vehicle.turn], ['future-service-lane', design.access.vehicle.lane], ['future-service-pad', design.access.service],
      ['future-vehicle-exit', design.access.vehicle.exit], ...design.access.crossings.map(item => [`future-pedestrian-crossing-${item.vehicleRouteName}`, item])
    ]) {
      const mesh = group.getObjectByName(name), actual = assertRenderedFootprint(mesh, route.geometryLocalM, origin);
      const indices = mesh.geometry.index ? Array.from(mesh.geometry.index.array) : actual.map((_, index) => index);
      let area = 0;
      for (let index = 0; index < indices.length; index += 3) area += Math.abs(cross(actual[indices[index]], actual[indices[index + 1]], actual[indices[index + 2]])) / 2;
      const ring = route.geometryLocalM.coordinates[0];
      const plannedArea = Math.abs(ring.slice(1).reduce((sum, point, index) => sum + ring[index][0] * point[1] - point[0] * ring[index][1], 0)) / 2;
      near(area, plannedArea, .001);
      const elevation = box(mesh);
      near(elevation.min.y, elevation.max.y, 1e-6);
      assert.ok(elevation.min.y > 0 && elevation.min.y < .1, 'overlay elevation is a small visual offset');
      if (route.centerLineLocalM) {
        const line = group.getObjectByName(`${name}-centreline`);
        assert.ok(line?.isLine);
        line.updateWorldMatrix(true, true);
        const points = line.geometry.getAttribute('position');
        assert.equal(points.count, route.centerLineLocalM.length);
        route.centerLineLocalM.forEach((point, index) => {
          const world = new THREE.Vector3().fromBufferAttribute(points, index).applyMatrix4(line.matrixWorld);
          near(world.x + origin[0], point[0], 2e-5);
          near(origin[1] - world.z, point[1], 2e-5);
        });
      }
    }
    const barrier = group.getObjectByName('future-ramp-protection');
    assertRenderedFootprint(barrier, design.maintenance.barrier.geometryLocalM, origin);
    near(box(barrier).min.y, design.maintenance.barrier.elevationM);
    near(box(barrier).max.y, design.maintenance.barrier.elevationM + design.maintenance.barrier.heightM);
    assert.deepEqual(design, before);
  } finally { dispose(group); }
});

test('renderer uses the new data footprint, exposes residential floors on all four facades and reaches the designed basement elevation', () => {
  const input = scene(), design = input.futureDesign;
  const before = structuredClone(design), origin = [...input.coordinates.originLocalM];
  const group = createFutureApartment(design, origin);
  assert.ok(group instanceof THREE.Group);
  assert.equal(group.name, 'future-apartment-2050');
  const tower = group.getObjectByName('future-tower');
  assert.ok(tower?.isMesh, 'tower is separately inspectable');
  const towerBox = box(tower), footprint = vertices(design.building.geometryLocalM);
  near(towerBox.min.x, Math.min(...footprint.map(point => point[0])) - origin[0]);
  near(towerBox.max.x, Math.max(...footprint.map(point => point[0])) - origin[0]);
  near(towerBox.min.z, origin[1] - Math.max(...footprint.map(point => point[1])));
  near(towerBox.max.z, origin[1] - Math.min(...footprint.map(point => point[1])));
  near(towerBox.max.y, design.building.heightM);
  assert.ok(towerBox.min.y >= -1e-5 && towerBox.min.y <= design.building.podiumHeightM + 1e-5);
  const superstructure = group.getObjectByName('future-superstructure');
  assert.ok(superstructure, 'validated building and facade have a shared inspectable group');
  assertRenderedEnvelope(superstructure, design.building.safetyEnvelopeGeometryLocalM, origin);
  near(box(superstructure).max.y, design.building.heightM);
  const centres = windowCentres(group.getObjectByName('long-facade-windows'));
  const sides = new Map([[-1, []], [1, []]]);
  for (const centre of centres) {
    const local = [centre.x + origin[0] - design.frame.centerLocalM[0], origin[1] - centre.z - design.frame.centerLocalM[1]];
    const depth = local.reduce((sum, value, axis) => sum + value * design.frame.shortAxisLocalM[axis], 0);
    near(Math.abs(depth), design.building.depthM / 2, .3);
    assert.ok(centre.y > design.building.podiumHeightM && centre.y < design.building.heightM);
    sides.get(Math.sign(depth)).push(centre);
  }
  for (const rows of sides.values()) {
    assert.ok(rows.length > 10, 'both broad facades contain repeated residential windows');
    assertResidentialRows(rows, design.building.podiumHeightM, design.building.heightM, design.building.residentialFloorCount);
  }
  assert.equal(sides.get(-1).length, sides.get(1).length);
  const endCentres = windowCentres(group.getObjectByName('end-facade-windows'));
  const endSides = new Map([[-1, []], [1, []]]);
  for (const centre of endCentres) {
    const delta = [centre.x + origin[0] - design.frame.centerLocalM[0], origin[1] - centre.z - design.frame.centerLocalM[1]];
    const along = delta.reduce((sum, value, axis) => sum + value * design.frame.longAxisLocalM[axis], 0);
    near(Math.abs(along), design.building.lengthM / 2, .3);
    assert.ok(centre.y > design.building.podiumHeightM && centre.y < design.building.heightM);
    endSides.get(Math.sign(along)).push(centre);
  }
  for (const rows of endSides.values()) {
    assert.ok(rows.length >= design.building.residentialFloorCount, 'both end walls retain actual residential windows');
    assertResidentialRows(rows, design.building.podiumHeightM, design.building.heightM, design.building.residentialFloorCount);
  }
  const ramp = group.getObjectByName('parking-ramp'), deck = group.getObjectByName('parking-deck');
  assert.ok(ramp?.isMesh && deck?.isMesh);
  const rampBox = box(ramp), deckBox = box(deck);
  near(rampBox.max.y, design.parking.ramp.startElevationM);
  near(rampBox.min.y, design.parking.ramp.endElevationM);
  assert.ok(rampBox.min.y < 0);
  near(deckBox.max.y, design.parking.deck.elevationM);
  const positions = ramp.geometry.getAttribute('position');
  const run = design.parking.ramp.endLocalM.map((value, axis) => value - design.parking.ramp.startLocalM[axis]);
  const runSquared = run.reduce((sum, value) => sum + value * value, 0);
  for (let index = 0; index < positions.count; index++) {
    const vertex = new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(ramp.matrixWorld);
    const point = [vertex.x + origin[0], origin[1] - vertex.z];
    const fraction = point.reduce((sum, value, axis) => sum + (value - design.parking.ramp.startLocalM[axis]) * run[axis], 0) / runSquared;
    near(vertex.y, design.parking.ramp.startElevationM + fraction * (design.parking.ramp.endElevationM - design.parking.ramp.startElevationM));
  }
  assert.deepEqual(design, before);
  assert.deepEqual(origin, input.coordinates.originLocalM);
  dispose(group);
});

test('podium keeps discrete entrances and windows instead of a continuous glass office ribbon', () => {
  const input = scene(), design = input.futureDesign, origin = input.coordinates.originLocalM;
  const group = createFutureApartment(design, origin);
  try {
    const glass = group.getObjectByName('long-facade-windows').material;
    const glazed = [];
    group.getObjectByName('future-superstructure').traverse(object => {
      if (object.isMesh && object.material === glass) glazed.push(...facadeBounds(object, design, origin));
    });
    const middleOfPodium = design.building.podiumHeightM / 2;
    for (const [normalAxis, spanAxis, offset, span] of [
      ['z', 'x', design.building.depthM / 2, design.building.lengthM],
      ['x', 'z', design.building.lengthM / 2, design.building.depthM]
    ]) {
      for (const sign of [-1, 1]) {
        const faceGlass = glazed.filter(bounds => Math.abs((bounds.min[normalAxis] + bounds.max[normalAxis]) / 2 - sign * offset) < .8);
        const intervals = horizontalIntervals(faceGlass, spanAxis, middleOfPodium);
        const widths = intervals.map(([start, end]) => end - start);
        assert.ok(widths.reduce((sum, width) => sum + width, 0) < span * .20, 'podium glazing must stay local to entrances and discrete windows');
        assert.ok(widths.every(width => width < span * .20), 'an entrance or window cannot span the whole podium face');
      }
    }
    const doors = [];
    group.traverse(object => { if (object.name === 'entrance-double-glass-door') doors.push(...facadeBounds(object, design, origin)); });
    assert.equal(doors.length, 2, 'a discrete usable-looking paired entrance remains visible');
    assert.ok(doors.every(bounds => bounds.min.y >= 0 && bounds.max.y > 2));
  } finally {
    dispose(group);
  }
});

test('residential long facades group window pairs with solid wall separation and keep end walls quieter', () => {
  const input = scene(), design = input.futureDesign, origin = input.coordinates.originLocalM;
  const group = createFutureApartment(design, origin);
  try {
    const longBounds = facadeBounds(group.getObjectByName('long-facade-windows'), design, origin);
    const endBounds = facadeBounds(group.getObjectByName('end-facade-windows'), design, origin);
    const firstRow = Math.min(...longBounds.map(bounds => (bounds.min.y + bounds.max.y) / 2));
    for (const sign of [-1, 1]) {
      const front = horizontalIntervals(longBounds.filter(bounds => Math.sign(bounds.min.z + bounds.max.z) === sign), 'x', firstRow);
      const ends = horizontalIntervals(endBounds.filter(bounds => Math.sign(bounds.min.x + bounds.max.x) === sign), 'z', firstRow);
      assert.ok(front.length >= 4, 'long facade needs multiple actual window openings');
      const gaps = front.slice(1).map(([start], index) => start - front[index][1]);
      assert.ok(gaps.every(gap => gap > .15), 'window openings have visible solid wall between them');
      const narrowGap = Math.min(...gaps), wideGap = Math.max(...gaps);
      assert.ok(narrowGap < 1.2 && wideGap >= 1.8 && wideGap > narrowGap * 1.5, 'paired household openings must be distinguishable from a uniform office grid');
      assert.ok(gaps.filter(gap => gap >= 1.8).length >= 2, 'at least three household groups are separated by solid wall');
      const frontRatio = front.reduce((sum, [start, end]) => sum + end - start, 0) / design.building.lengthM;
      const endRatio = ends.reduce((sum, [start, end]) => sum + end - start, 0) / design.building.depthM;
      assert.ok(ends.length >= 1 && endRatio < .30 && endRatio < frontRatio, 'end walls retain narrower openings and visibly more opaque wall than the long facades');
      assert.ok(!ends.some(([start, end]) => start < 4 && end > -4), 'end walls keep an eight-metre central opaque region instead of repeating the front grid');
      assert.ok(ends.every(([start, end]) => end - start < 2.6), 'end openings remain narrow residential windows');
    }
  } finally {
    dispose(group);
  }
});

test('paired residential balconies have actual projecting slabs and guards at every residential floor', () => {
  const input = scene(), design = input.futureDesign, origin = input.coordinates.originLocalM;
  const group = createFutureApartment(design, origin);
  try {
    const ledges = facadeBounds(group.getObjectByName('balcony-sunshade-ledges'), design, origin);
    const guards = facadeBounds(group.getObjectByName('balcony-glass-guards'), design, origin);
    for (const sign of [-1, 1]) {
      const sideLedges = ledges.filter(bounds => Math.sign(bounds.min.z + bounds.max.z) === sign);
      const sideGuards = guards.filter(bounds => Math.sign(bounds.min.z + bounds.max.z) === sign);
      const levels = [...new Set(sideLedges.map(bounds => bounds.min.y.toFixed(4)))].map(Number).sort((a, b) => a - b);
      assert.equal(levels.length, design.building.residentialFloorCount, 'balcony slabs repeat on every residential floor on both long facades');
      for (const level of levels) {
        const row = sideLedges.filter(bounds => Math.abs(bounds.min.y - level) < 1e-4).sort((a, b) => a.min.x - b.min.x);
        assert.ok(row.length >= 2, 'each floor has multiple distinct paired balcony groups');
        for (let index = 0; index < row.length; index++) {
          const slab = row[index];
          const width = slab.max.x - slab.min.x, depth = slab.max.z - slab.min.z;
          assert.ok(width >= 10 && width < 20, 'a balcony pair spans a household group rather than an isolated window or full facade');
          assert.ok(depth >= 1.2, 'actual balcony projection must read as usable space rather than a thin sunshade');
          assert.ok(Math.max(Math.abs(slab.min.z), Math.abs(slab.max.z)) >= design.building.depthM / 2 + 1.2, 'slab geometry projects beyond the tower wall');
          assert.ok(slab.max.y - slab.min.y >= .12 && slab.max.y - slab.min.y <= .4, 'balcony geometry is a horizontal slab');
          if (index) assert.ok(slab.min.x - row[index - 1].max.x >= .3, 'paired balconies remain separated by visible wall gaps');
          const guard = sideGuards.find(bounds =>
            Math.abs(bounds.min.x - slab.min.x) < .25 && Math.abs(bounds.max.x - slab.max.x) < .25 &&
            bounds.min.y >= slab.max.y - .1 && bounds.min.y <= slab.max.y + .2
          );
          assert.ok(guard, 'every projecting slab has a matching guard along its outward edge');
          assert.ok(guard.max.y - guard.min.y >= .9 && guard.max.y - guard.min.y <= 1.2, 'visible guard height remains human scale');
          assert.ok(sign === 1 ? guard.max.z >= slab.max.z - .2 : guard.min.z <= slab.min.z + .2, 'guard sits at the projecting edge rather than on the tower wall');
          assert.ok(guard.max.y < design.building.heightM, 'upper balcony guard stays below the declared roof');
        }
      }
    }
  } finally {
    dispose(group);
  }
});

test('height controls keep tower top and repeated window floor spacing consistent without changing source or parking', () => {
  const input = scene(), design = input.futureDesign, before = structuredClone(design);
  let referenceParkingBox;
  const referenceAccess = new Map();
  for (const heightM of [24, 48, 90]) {
    const group = createFutureApartment(design, input.coordinates.originLocalM, {heightM});
    near(box(group.getObjectByName('future-tower')).max.y, heightM);
    const floorCount = Math.max(1, Math.floor((heightM - design.building.podiumHeightM) / design.building.floorHeightM + 1e-8));
    for (const name of ['long-facade-windows', 'end-facade-windows']) {
      const windows = windowCentres(group.getObjectByName(name));
      assertResidentialRows(windows, design.building.podiumHeightM, heightM, floorCount);
    }
    const superstructure = group.getObjectByName('future-superstructure');
    assertRenderedEnvelope(superstructure, design.building.safetyEnvelopeGeometryLocalM, input.coordinates.originLocalM);
    near(box(superstructure).max.y, heightM);
    const bounds = box(group.getObjectByName('parking-ramp'));
    const parkingBox = [...bounds.min.toArray(), ...bounds.max.toArray()];
    if (referenceParkingBox) assert.deepEqual(parkingBox, referenceParkingBox);
    referenceParkingBox = parkingBox;
    for (const name of ['future-maintenance-path', 'future-ramp-protection', 'future-vehicle-approach', 'future-service-turn', 'future-service-lane', 'future-service-pad', 'future-vehicle-exit', 'future-pedestrian-crossing-approach', 'future-pedestrian-crossing-exit']) {
      const accessBox = box(group.getObjectByName(name)), value = [...accessBox.min.toArray(), ...accessBox.max.toArray()];
      if (referenceAccess.has(name)) assert.deepEqual(value, referenceAccess.get(name), `${name}: height rebuild must preserve ground access`);
      referenceAccess.set(name, value);
    }
    dispose(group);
  }
  assert.deepEqual(design, before);
});

test('renderer rejects unvalidated, nonfinite and inconsistent design dimensions', () => {
  const input = scene(), design = input.futureDesign;
  for (const heightM of [NaN, Infinity, '48', -1, 0, 17.9, 90.1, 1e6, design.building.podiumHeightM]) {
    assert.throws(() => createFutureApartment(design, input.coordinates.originLocalM, {heightM}));
  }
  assert.throws(() => createFutureApartment(design, [NaN, 0]));
  for (const change of [
    value => { value.validation.status = 'failed'; },
    value => { delete value.validation.status; },
    value => { value.validation.status = 'pending'; },
    value => { value.building.lengthM = NaN; },
    value => { value.building.lengthM += 20; },
    value => { value.building.depthM = -1; },
    value => { value.building.heightM = Infinity; },
    value => { value.building.floorCount = 0; },
    value => { value.building.facade.baySpacingM = 0; },
    value => { value.building.facade.baySpacingM = NaN; },
    value => { value.building.facade.baySpacingM = -1; },
    value => { value.building.facade.baySpacingM = .01; },
    value => { value.building.safetyBufferM = 3; },
    value => { value.building.facade.style = 'another-compound'; },
    value => { value.architectureIdentity.id = 'another-compound'; },
    value => { value.building.geometryLocalM.coordinates[0][0][0] = NaN; },
    value => { value.parking.ramp.endElevationM = 2; },
    value => { value.maintenance.widthM = NaN; },
    value => { value.maintenance.widthM = 0; },
    value => { value.maintenance.barrier.heightM = NaN; },
    value => { value.maintenance.barrier.heightM = -1; },
    value => { value.maintenance.barrier.elevationM = Infinity; },
    value => { value.access.vehicle.turn.centerLineLocalM[0][0] = NaN; }
  ]) {
    const value = structuredClone(design);
    change(value);
    assert.throws(() => createFutureApartment(value, input.coordinates.originLocalM));
  }
});
