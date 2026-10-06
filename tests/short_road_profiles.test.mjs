import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {buildRoadCrossProfiles, projectProfilePointToNative} from '../tools/road_cross_profiles.mjs';
import {crossSectionIntervals} from '../tools/measure_road_sections.mjs';

// Read integrated repository inputs. A personal scratch candidate or its saved
// audit must never become a production test dependency or geometric authority.
const sourceBytes = await readFile(new URL('../docs/guro1_plan_2d.geojson', import.meta.url));
const surfaceBytes = await readFile(new URL('../docs/reference/guil_ngii_road_surfaces.geojson', import.meta.url));
const candidates = JSON.parse(await readFile(new URL('../docs/reference/guil_road_cross_profile_candidates.json', import.meta.url)));
const source = JSON.parse(sourceBytes), surfaces = JSON.parse(surfaceBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedHashes = {sourceSha256: hash(sourceBytes), surfaceSha256: hash(surfaceBytes), verifiedImageHashes: {}};
const emptyReviews = {schema: 'guil-curb-reviews.v1', records: []};
const shortRoad = candidates.selected_roads.find(road => road.section.original_road_id === 'way/555380145'
  && road.section.segment_index === 16 && road.section.profiles[0].original_part_index === 0
  && road.section.start_along_segment_m === 40 && road.section.end_along_segment_m === 45);
assert.ok(shortRoad, 'The integrated candidate must contain the exact southern Guil-ro 40–45m section.');
const shortInput = () => ({...structuredClone(candidates), selected_roads: [structuredClone(shortRoad)]});
const build = (input = shortInput(), reviews = emptyReviews, hashes = expectedHashes, sourceInput = source, surfacesInput = surfaces) =>
  buildRoadCrossProfiles(input, reviews, sourceInput, surfacesInput, hashes);
const first = shortRoad.section.profiles[0];
const original = source.features.find(feature => feature.id === 'way/555380145');
const line = original.geometry.type === 'LineString' ? original.geometry.coordinates : original.geometry.coordinates[0];
const a = projectProfilePointToNative(line[16]), b = projectProfilePointToNative(line[17]);
const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
const tangent = [(b[0] - a[0]) / length, (b[1] - a[1]) / length], normal = [-tangent[1], tangent[0]];
const native = (along, offset = 0) => a.map((value, axis) => value + tangent[axis] * along + normal[axis] * offset);
const spanKinds = ['road_boundary', 'left_sidewalk', 'right_sidewalk', 'residual_interval'];

function reviewFixture(input = shortInput()) {
  const section = input.selected_roads[0].section;
  const path = 'synthetic-short-profile-evidence.png', sha256 = hash(Buffer.from('synthetic short profile visual evidence'));
  return {reviews: {schema: emptyReviews.schema, records: [{
    id: 'way/555380145/curb-profile/part-0/segment-16/40-45', sourceId: 'way/555380145',
    originalPartIndex: 0, originalSegmentIndex: 16, startAlongSegmentM: section.start_along_segment_m,
    endAlongSegmentM: section.end_along_segment_m, status: 'curb_layout_visually_reviewed',
    observedOn: '2026-10-06', imageryDate: null, sourceUrl: 'https://example.test/short-curb-review',
    observations: ['Synthetic review exercises exact scope and caller-verified image binding.'], images: [{path, sha256}]
  }]}, hashes: {...expectedHashes, verifiedImageHashes: {[path]: sha256}}};
}

// Rehash serialized synthetic fixtures, so a geometry failure cannot merely be
// the provenance guard rejecting deliberately stale checksums.
function rehash(input, sourceInput, surfacesInput, baseHashes = expectedHashes) {
  const sourceSha256 = hash(Buffer.from(JSON.stringify(sourceInput)));
  surfacesInput.metadata.sourceSha256 = sourceSha256;
  const surfaceSha256 = hash(Buffer.from(JSON.stringify(surfacesInput)));
  input.source.sha256 = sourceSha256;
  input.NGII.sha256 = surfaceSha256;
  return {...baseHashes, sourceSha256, surfaceSha256};
}

function cutsAt(along, kind, surfacesInput = surfaces) {
  const feature = surfacesInput.features.find(feature => feature.id === first[kind].ngii_polygon_id);
  const cuts = crossSectionIntervals(native(along), tangent, feature.properties.native_geometry_m, 80);
  return cuts.find(interval => kind === 'road_boundary' ? interval[0] < 0 && interval[1] > 0
    : kind === 'left_sidewalk' ? interval[0] > 0 : interval[1] < 0);
}

function assertSavedCutsAndEndpointsUnchanged(surfacesInput) {
  for (const along of [40, 41.25, 43.75, 45]) {
    for (const kind of ['road_boundary', 'left_sidewalk', 'right_sidewalk']) {
      const actual = cutsAt(along, kind, surfacesInput), before = cutsAt(along, kind);
      assert.ok(actual && before, `${kind} fixture must retain cut at ${along}m.`);
      assert.ok(actual.every((value, index) => Math.abs(value - before[index]) < 0.002), `${kind} at ${along}m must remain unchanged.`);
    }
  }
}

function rectangle(start, end, lower, upper) {
  const ring = [[start, lower], [end, lower], [end, upper], [start, upper]].map(([along, offset]) => native(along, offset));
  ring.push([...ring[0]]);
  return {type: 'Polygon', coordinates: [ring]};
}

function addNativePolygon(surfacesInput, kind, geometry) {
  const template = surfacesInput.features.find(feature => feature.properties.surfaceKind === kind);
  const polygon = structuredClone(template);
  polygon.id = `synthetic/${kind}/interior-patch`;
  polygon.properties.evidenceId = polygon.id;
  polygon.properties.native_geometry_m = geometry;
  surfacesInput.features.push(polygon);
}

function inverseNative(nativePoint) {
  let wgs = [...first.samplepoint.wgs84_lon_lat];
  for (let iteration = 0; iteration < 6; iteration++) {
    const projected = projectProfilePointToNative(wgs), dx = nativePoint[0] - projected[0], dy = nativePoint[1] - projected[1];
    const step = 1e-6;
    const lon = projectProfilePointToNative([wgs[0] + step, wgs[1]]), lat = projectProfilePointToNative([wgs[0], wgs[1] + step]);
    const xLon = (lon[0] - projected[0]) / step, yLon = (lon[1] - projected[1]) / step;
    const xLat = (lat[0] - projected[0]) / step, yLat = (lat[1] - projected[1]) / step;
    const determinant = xLon * yLat - xLat * yLon;
    wgs = [wgs[0] + (dx * yLat - xLat * dy) / determinant, wgs[1] + (xLon * dy - dx * yLon) / determinant];
  }
  assert.ok(Math.hypot(...projectProfilePointToNative(wgs).map((value, axis) => value - nativePoint[axis])) < 0.00001);
  return wgs;
}

test('the nine original 20m/four-sample sections and exact 5m/two-sample section coexist without input mutation', () => {
  const before = structuredClone({candidates, source, surfaces});
  const result = build(candidates);
  const oldProfiles = result.profiles.filter(profile => profile.endAlongSegmentM - profile.startAlongSegmentM === 20);
  assert.equal(oldProfiles.length, 9);
  assert.ok(oldProfiles.every(profile => profile.samples.length === 4));
  assert.equal(result.profiles.length, 10);
  assert.equal(result.summary.sampleCount, 38);
  assert.equal(result.summary.visuallyReviewedProfileCount, 0);
  assert.equal(result.summary.parentWayWidthsAssigned, 0);
  assert.deepEqual({candidates, source, surfaces}, before);
});

test('the saved short fixture retains its two actual native cuts, widths and endpoint positions', () => {
  assert.deepEqual(shortRoad.section.profiles.map(sample => sample.sample_along_original_segment_m), [41.25, 43.75]);
  assert.deepEqual(shortRoad.section.profiles.map(sample => sample.residual_interval.span_m), [13.5749, 13.628]);
  assert.deepEqual(shortRoad.section.profiles.map(sample => sample.samplepoint.native_epsg5186_m), [[189028.477, 543380.5341], [189027.1545, 543382.6556]]);
  assert.deepEqual(shortRoad.section.profiles.map(sample => sample.residual_interval.endpoints.map(endpoint => endpoint.native_epsg5186_m)), [
    [[189035.8795, 543385.1484], [189024.3595, 543377.9674]],
    [[189034.5953, 543387.2939], [189023.0302, 543380.0848]]
  ]);
});

test('short pending profiles remain null and an exactly scoped review yields the finite two-sample median', () => {
  const pending = build().profiles[0], {reviews, hashes} = reviewFixture();
  const reviewed = build(shortInput(), reviews, hashes);
  const profile = reviewed.profiles[0];
  assert.equal(pending.reviewStatus, 'pending');
  const pendingCarriageway = pending.components.find(component => component.kind === 'carriageway');
  assert.equal(pendingCarriageway.widthM, null);
  assert.equal(pendingCarriageway.rangeM, null);
  assert.ok(pending.samples.every(sample => sample.carriagewayLineLocalM === null));
  assert.ok(pending.endpointChecks.every(endpoint => endpoint.carriagewayLineLocalM === null));
  // Preserve the existing four-decimal toFixed display rule at this floating
  // midpoint; this rounding is not a statement of mapping accuracy.
  assert.equal(profile.components.find(component => component.kind === 'carriageway').widthM, 13.6014);
  assert.ok(profile.components.every(component => Number.isFinite(component.widthM)));
  assert.equal(reviewed.summary.reviewedNativeSectionLengthM, 5);
  assert.equal(reviewed.summary.visuallyReviewedProfileCount, 1);
  assert.equal(reviewed.summary.groundMeasuredWidthCount, 0);
  assert.equal(profile.classification, 'curb_mapping_estimate_after_visual_layout_review');
  for (const delta of [{startAlongSegmentM: 39}, {endAlongSegmentM: 46}, {endAlongSegmentM: 60}, {originalSegmentIndex: 15}]) {
    const wrong = structuredClone(reviews);
    Object.assign(wrong.records[0], delta);
    assert.throws(() => build(shortInput(), wrong, hashes), /review scope/);
  }
});

test('short interior audit recomputes endpoints, dense native cuts and component observed ranges', () => {
  const input = shortInput();
  delete input.selected_roads[0].section.interior_native_audit;
  delete input.selected_roads[0].section.endpoint_guard_profiles;
  const profile = build(input).profiles[0];
  const audit = profile.nativeInteriorAudit;
  assert.ok(audit && Array.isArray(audit.checks));
  assert.equal(audit.kind, 'native_vertex_events_and_0_05m_checks');
  assert.ok(Number.isFinite(audit.clearanceM) && audit.clearanceM >= 25);
  assert.equal(audit.sourceGeometryChanged, false);
  assert.ok(Number.isInteger(audit.eventCount) && audit.eventCount > 0);
  assert.ok(audit.checks.length >= 101);
  const stations = [...new Set(audit.checks.map(check => check.alongOriginalSegmentM))].sort((a, b) => a - b);
  assert.equal(stations[0], 40);
  assert.equal(stations.at(-1), 45);
  for (let index = 1; index < stations.length; index++) assert.ok(stations[index] - stations[index - 1] <= 0.05000001);
  const componentKinds = {mapped_road_boundary: 'road_boundary', left_walkway: 'left_sidewalk', right_walkway: 'right_sidewalk', carriageway: 'residual_interval'};
  for (const component of profile.components) {
    const range = component.rangeM || component.candidateRangeM;
    for (const check of audit.checks) {
      const width = check.spans[componentKinds[component.kind]].span_m;
      assert.ok(Number.isFinite(width));
      assert.ok(width >= range[0] - 1e-4 && width <= range[1] + 1e-4);
    }
  }
  assert.deepEqual(profile.endpointChecks.map(check => check.alongOriginalSegmentM), [40, 45]);
});

test('only exact allowed section lengths, sample counts and quarter-section native stations are accepted', () => {
  for (const end of [44, 45.001, 50, 60]) {
    const input = shortInput(); input.selected_roads[0].section.end_along_segment_m = end;
    assert.throws(() => build(input));
  }
  for (const count of [0, 1, 3, 4]) {
    const input = shortInput(), profiles = input.selected_roads[0].section.profiles;
    input.selected_roads[0].section.profiles = Array.from({length: count}, (_, index) => structuredClone(profiles[index % 2]));
    assert.throws(() => build(input), /samples|sample|section/);
  }
  for (const index of [0, 1]) {
    const input = shortInput(); input.selected_roads[0].section.profiles[index].sample_along_original_segment_m += 0.1;
    assert.throws(() => build(input), /sample|point/);
  }
});

test('short duplicate, overlapping and mismatched provenance are rejected', () => {
  const duplicate = shortInput(); duplicate.selected_roads.push(structuredClone(shortRoad));
  assert.throws(() => build(duplicate), /Duplicate cross-profile/);
  const overlap = shortInput(), next = structuredClone(shortRoad);
  next.section.start_along_segment_m = 42.5; next.section.end_along_segment_m = 47.5;
  overlap.selected_roads.push(next);
  assert.throws(() => build(overlap), /overlapping cross-profile/);
  assert.throws(() => build(shortInput(), emptyReviews, {...expectedHashes, sourceSha256: '0'.repeat(64)}), /checksum/);
  assert.throws(() => build(shortInput(), emptyReviews, {...expectedHashes, surfaceSha256: '0'.repeat(64)}), /checksum/);
  const {reviews} = reviewFixture();
  assert.throws(() => build(shortInput(), reviews), /not verified/);
});

test('a sub-grid interior-only sidewalk notch fails despite unchanged display cuts and endpoints', () => {
  const input = shortInput(), surfacesInput = structuredClone(surfaces);
  const polygon = surfacesInput.features.find(feature => feature.id === first.left_sidewalk.ngii_polygon_id);
  const stations = [39.9, 40, 41.25, 42.501, 42.5051, 42.509, 43.75, 45, 45.1];
  const knots = stations.map(along => ({along, interval: [...cutsAt(along, 'left_sidewalk')]}));
  knots.find(knot => knot.along === 42.5051).interval[0] += 0.9;
  const ring = [...knots.map(knot => native(knot.along, knot.interval[0])), ...[...knots].reverse().map(knot => native(knot.along, knot.interval[1]))];
  ring.push([...ring[0]]);
  polygon.properties.native_geometry_m = {type: 'Polygon', coordinates: [ring]};
  assertSavedCutsAndEndpointsUnchanged(surfacesInput);
  assert.ok(cutsAt(42.5051, 'left_sidewalk', surfacesInput)[0] - cutsAt(42.5051, 'left_sidewalk')[0] > 0.89);
  const {reviews, hashes: reviewHashes} = reviewFixture(input);
  const hashes = rehash(input, source, surfacesInput, reviewHashes);
  assert.throws(() => build(input, emptyReviews, hashes, source, surfacesInput), /variation|stable section/);
  assert.throws(() => build(input, reviews, hashes, source, surfacesInput), /variation|stable section/);
});

test('other A001 short interior overlap, center overlap and a seam within the existing 0.2m guard fail between saved cuts', () => {
  const outer = cutsAt(42.5, 'road_boundary')[1];
  // Each patch is only 6mm long along the section. Its lateral intrusion uses
  // the existing kernel's 0.2m guard rather than introducing a new threshold.
  for (const [label, lower, upper] of [['short-overlap', 1, 1.201], ['center-overlap', -0.01, 0.01], ['near-seam', outer + 0.1, outer + 0.15]]) {
    const input = shortInput(), surfacesInput = structuredClone(surfaces);
    addNativePolygon(surfacesInput, 'road_corridor', rectangle(42.497, 42.503, lower, upper));
    assertSavedCutsAndEndpointsUnchanged(surfacesInput);
    const hashes = rehash(input, source, surfacesInput);
    assert.throws(() => build(input, emptyReviews, hashes, source, surfacesInput), /A001|road corridor|road-corridor|seam|overlap|centerline/i, label);
  }
});

test('other A003 overlapping the residual or paired sidewalk fails between display samples', () => {
  const inner = cutsAt(42.5, 'left_sidewalk')[0];
  for (const [lower, upper] of [[1, 1.101], [inner + 0.1, inner + 0.301]]) {
    const input = shortInput(), surfacesInput = structuredClone(surfaces);
    addNativePolygon(surfacesInput, 'walkway', rectangle(42.497, 42.503, lower, upper));
    assertSavedCutsAndEndpointsUnchanged(surfacesInput);
    const hashes = rehash(input, source, surfacesInput);
    assert.throws(() => build(input, emptyReviews, hashes, source, surfacesInput), /A003|walkway|sidewalk|residual|overlap/i);
  }
});

test('a nonparallel original road closer than 25m fails even when the display samples stay farther away', () => {
  const input = shortInput(), sourceInput = structuredClone(source), surfacesInput = structuredClone(surfaces);
  const near = [native(42.499, 24.999), native(42.499, 35)];
  // At both saved display stations this perpendicular road is farther than 25m;
  // the whole original line is only 24.999m from the section between those cuts.
  assert.ok(Math.hypot(41.25 - 42.499, 24.999) > 25);
  assert.ok(Math.hypot(43.75 - 42.499, 24.999) > 25);
  const feature = structuredClone(original), wgs = near.map(inverseNative), cs = source.metadata.coordinate_system;
  feature.id = 'synthetic/nonparallel-original-road';
  feature.properties.name = 'Synthetic nonparallel road';
  feature.geometry = {type: 'LineString', coordinates: wgs};
  feature.properties.local_geometry_m = {type: 'LineString', coordinates: wgs.map(position => [(position[0] - cs.origin_lon_lat[0]) * cs.meters_per_degree_lon, (position[1] - cs.origin_lon_lat[1]) * cs.meters_per_degree_lat])};
  sourceInput.features.push(feature);
  const hashes = rehash(input, sourceInput, surfacesInput);
  assert.throws(() => build(input, emptyReviews, hashes, sourceInput, surfacesInput), /nonparallel|25m|clearance|original.road/i);
});
