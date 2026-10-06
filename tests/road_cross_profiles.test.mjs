import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {buildRoadCrossProfiles, projectProfilePointToNative} from '../tools/road_cross_profiles.mjs';
import {crossSectionIntervals} from '../tools/measure_road_sections.mjs';

const sourceBytes = await readFile(new URL('../docs/guro1_plan_2d.geojson', import.meta.url));
const surfaceBytes = await readFile(new URL('../docs/reference/guil_ngii_road_surfaces.geojson', import.meta.url));
const source = JSON.parse(sourceBytes), surfaces = JSON.parse(surfaceBytes);
const candidatePath = process.env.ROAD_PROFILE_CANDIDATES || new URL('../docs/reference/guil_road_cross_profile_candidates.json', import.meta.url);
const candidates = JSON.parse(await readFile(candidatePath));
// This file retains the original 20m/four-sample regression suite. The exact
// 5m/two-sample scheme and dense/event audits have their own test file.
const twentyMetreCandidates = structuredClone(candidates);
twentyMetreCandidates.selected_roads = twentyMetreCandidates.selected_roads.filter(road => road.section.end_along_segment_m - road.section.start_along_segment_m === 20);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedHashes = {sourceSha256: hash(sourceBytes), surfaceSha256: hash(surfaceBytes), verifiedImageHashes: {}};
const emptyReviews = {schema: 'guil-curb-reviews.v1', records: []};
const build = (input = candidates, reviews = emptyReviews, hashes = expectedHashes, sourceInput = source, surfacesInput = surfaces) => buildRoadCrossProfiles(input, reviews, sourceInput, surfacesInput, hashes);
const candidateClone = change => { const input = structuredClone(candidates); change(input); return input; };
const reviewedFixture = (index, input = candidates) => {
  const profile = build(input).profiles[index];
  // An in-memory fixture exercises the caller's already-verified image registry.
  // It does not assert that this synthetic image establishes a real curb review.
  const path = 'synthetic-test-evidence.png', sha256 = hash(Buffer.from('synthetic visual evidence'));
  return {review: {id: profile.id, sourceId: profile.sourceId, originalPartIndex: profile.partIndex, originalSegmentIndex: profile.originalSegmentIndex, startAlongSegmentM: profile.startAlongSegmentM, endAlongSegmentM: profile.endAlongSegmentM, status: 'curb_layout_visually_reviewed', observedOn: '2026-10-04', imageryDate: null, sourceUrl: 'https://example.test/curb-review', observations: ['Synthetic test review: paired curb boundaries checked.'], images: [{path, sha256}]}, hashes: {...expectedHashes, verifiedImageHashes: {[path]: sha256}}};
};

// Construct another real polygon cross section on the same immutable source
// segment. This is geometric test data, not an asserted additional visual review.
function sectionAtNativeInterval(road, startM) {
  const copy = structuredClone(road), first = road.section.profiles[0];
  const original = source.features.find(feature => feature.id === first.original_road_id);
  const line = original.geometry.type === 'LineString' ? original.geometry.coordinates : original.geometry.coordinates[first.original_part_index];
  const a = projectProfilePointToNative(line[first.original_segment_index]);
  const b = projectProfilePointToNative(line[first.original_segment_index + 1]);
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const tangent = [(b[0] - a[0]) / length, (b[1] - a[1]) / length], normal = [-tangent[1], tangent[0]];
  const nativeToPosition = native => {
    let wgs = [...first.samplepoint.wgs84_lon_lat];
    // Numerical inversion is only a fixture construction helper. The production
    // projection is separately compared against saved and existing proj4 results.
    for (let iteration = 0; iteration < 5; iteration++) {
      const projected = projectProfilePointToNative(wgs), dx = native[0] - projected[0], dy = native[1] - projected[1];
      const step = 1e-6;
      const longitude = projectProfilePointToNative([wgs[0] + step, wgs[1]]), latitude = projectProfilePointToNative([wgs[0], wgs[1] + step]);
      const xLon = (longitude[0] - projected[0]) / step, yLon = (longitude[1] - projected[1]) / step;
      const xLat = (latitude[0] - projected[0]) / step, yLat = (latitude[1] - projected[1]) / step;
      const determinant = xLon * yLat - xLat * yLon;
      wgs = [wgs[0] + (dx * yLat - xLat * dy) / determinant, wgs[1] + (xLon * dy - dx * yLon) / determinant];
    }
    const cs = source.metadata.coordinate_system;
    return {native_epsg5186_m: [...native], wgs84_lon_lat: wgs, local_plan_m: [(wgs[0] - cs.origin_lon_lat[0]) * cs.meters_per_degree_lon, (wgs[1] - cs.origin_lon_lat[1]) * cs.meters_per_degree_lat]};
  };
  copy.section.start_along_segment_m = startM;
  copy.section.end_along_segment_m = startM + 20;
  copy.section.profiles = Array.from({length: 4}, (_, index) => {
    const sample = structuredClone(first), along = startM + 2.5 + index * 5;
    const native = a.map((value, axis) => value + tangent[axis] * along);
    sample.sample_along_original_segment_m = along;
    sample.samplepoint = nativeToPosition(native);
    const span = interval => ({signed_normal_interval_m: interval, span_m: interval[1] - interval[0], endpoints: interval.map(offset => nativeToPosition(native.map((value, axis) => value + normal[axis] * offset)))});
    for (const kind of ['road_boundary', 'left_sidewalk', 'right_sidewalk']) {
      const geometry = surfaces.features.find(feature => feature.id === sample[kind].ngii_polygon_id).properties.native_geometry_m;
      const interval = crossSectionIntervals(native, tangent, geometry, 80).find(pair => kind === 'road_boundary' ? pair[0] < 0 && pair[1] > 0 : kind === 'left_sidewalk' ? pair[0] > 0 : pair[1] < 0);
      assert.ok(interval, `Fixture requires a ${kind} polygon cut.`);
      Object.assign(sample[kind], span(interval));
    }
    Object.assign(sample.residual_interval, span([sample.right_sidewalk.signed_normal_interval_m[1], sample.left_sidewalk.signed_normal_interval_m[0]]));
    return sample;
  });
  return copy;
}

test('selected 20m sections retain four mapped samples each and keep every unreviewed carriageway null', () => {
  const before = structuredClone({twentyMetreCandidates, source, surfaces, emptyReviews});
  const result = build(twentyMetreCandidates);
  assert.equal(result.profiles.length, twentyMetreCandidates.selected_roads.length);
  assert.equal(result.summary.sampleCount, twentyMetreCandidates.selected_roads.length * 4);
  assert.equal(result.summary.visuallyReviewedProfileCount, 0);
  assert.equal(result.summary.parentWayWidthsAssigned, 0);
  for (const profile of result.profiles) {
    assert.equal(profile.distanceBasis, 'native_projected_metres_along_original_segment');
    assert.equal(profile.reviewStatus, 'pending');
    assert.equal(profile.endAlongSegmentM - profile.startAlongSegmentM, 20);
    assert.equal(profile.samples.length, 4);
    assert.equal(profile.components.find(component => component.kind === 'carriageway').widthM, null);
    assert.equal(profile.components.find(component => component.kind === 'carriageway').rangeM, null);
    assert.ok(profile.components.find(component => component.kind === 'carriageway').candidateRangeM[0] > 0);
    assert.ok(profile.samples.every(sample => sample.carriagewayLineLocalM === null));
    assert.ok(profile.components.every(component => component.errorM === null && component.rangeStatus === 'observed_sample_variation_not_accuracy'));
    assert.equal(profile.endpointChecks.length, 2);
    assert.equal(profile.endpointChecks[0].alongOriginalSegmentM, profile.startAlongSegmentM);
    assert.equal(profile.endpointChecks[1].alongOriginalSegmentM, profile.endAlongSegmentM);
    assert.ok(profile.endpointChecks.every(endpoint => endpoint.carriagewayLineLocalM === null));
    const spanKinds = {mapped_road_boundary: 'road_boundary', left_walkway: 'left_sidewalk', right_walkway: 'right_sidewalk', carriageway: 'residual_interval'};
    for (const component of profile.components) {
      const range = component.rangeM || component.candidateRangeM;
      assert.ok(profile.endpointChecks.every(endpoint => endpoint.spans[spanKinds[component.kind]].span_m >= range[0] && endpoint.spans[spanKinds[component.kind]].span_m <= range[1]));
    }
  }
  assert.deepEqual({twentyMetreCandidates, source, surfaces, emptyReviews}, before);
});

test('only one scoped review with a caller-verified image promotes its residual into a mapping estimate', () => {
  const {review, hashes} = reviewedFixture(0);
  const reviews = {schema: emptyReviews.schema, records: [review]};
  const before = structuredClone(reviews);
  const result = build(candidates, reviews, hashes);
  assert.equal(result.summary.visuallyReviewedProfileCount, 1);
  assert.equal(result.summary.pendingProfileCount, candidates.selected_roads.length - 1);
  assert.equal(result.summary.reviewedNativeSectionLengthM, 20);
  assert.equal(result.summary.groundMeasuredWidthCount, 0);
  assert.equal(result.profiles[0].classification, 'curb_mapping_estimate_after_visual_layout_review');
  assert.ok(result.profiles[0].components.find(component => component.kind === 'carriageway').widthM > 0);
  assert.ok(result.profiles.slice(1).every(profile => profile.components.find(component => component.kind === 'carriageway').widthM === null));
  assert.deepEqual(reviews, before);
  result.profiles[0].review.observations.push('mutated output');
  assert.deepEqual(reviews, before);
  const pending = build(candidates, {schema: emptyReviews.schema, records: [{...review, status: 'pending', images: []}]}, expectedHashes);
  assert.equal(pending.summary.visuallyReviewedProfileCount, 0);
});

test('multiple nonoverlapping 20m sections on the same original road are accepted without propagating its first review', () => {
  const road = candidates.selected_roads.find(road => road.road_name === '구일로4길');
  const next = sectionAtNativeInterval(road, road.section.end_along_segment_m);
  // Isolate this pair: the saved cumulative candidate file may already contain
  // the neighboring section that this test constructs.
  const input = candidateClone(input => { input.selected_roads = [structuredClone(road), next]; });
  const before = structuredClone(input);
  const {review, hashes} = reviewedFixture(0, input);
  const result = build(input, {schema: emptyReviews.schema, records: [review]}, hashes);
  assert.equal(result.profiles.length, 2);
  const sameRoad = result.profiles.filter(profile => profile.sourceId === road.section.original_road_id);
  assert.equal(sameRoad.length, 2);
  assert.equal(sameRoad[0].endAlongSegmentM, sameRoad[1].startAlongSegmentM);
  assert.equal(sameRoad[1].reviewStatus, 'pending');
  assert.equal(sameRoad[1].components.find(component => component.kind === 'carriageway').widthM, null);
  assert.equal(result.summary.visuallyReviewedProfileCount, 1);
  assert.deepEqual(input, before);
});

test('duplicate sections and positive native overlap on the same source/part/segment are rejected', () => {
  const road = candidates.selected_roads[0];
  assert.throws(() => build(candidateClone(input => { input.selected_roads = [structuredClone(road), structuredClone(road)]; })), /Duplicate cross-profile ID/);
  const overlap = structuredClone(road);
  overlap.section.start_along_segment_m += 5;
  overlap.section.end_along_segment_m += 5;
  assert.throws(() => build(candidateClone(input => { input.selected_roads = [structuredClone(road), overlap]; })), /overlapping cross-profile intervals/);
});

test('road names and category must match the actual source rather than a hardcoded list', () => {
  const mismatched = candidateClone(input => { input.selected_roads[0].road_name = '구일로8길'; });
  assert.throws(() => build(mismatched), /differs in identity/);
  const nonroad = structuredClone(source);
  nonroad.features.find(feature => feature.id === candidates.selected_roads[0].section.original_road_id).properties.category = 'path';
  assert.throws(() => build(candidates, emptyReviews, expectedHashes, nonroad), /differs in identity/);
  // Synthetic parsed source fixtures retain all geometry while changing only
  // naming. Their byte hashes and surface/source provenance are recomputed.
  for (const actualName of ['추가 검증 도로', undefined]) {
    const sourceInput = structuredClone(source), surfacesInput = structuredClone(surfaces), input = structuredClone(candidates);
    input.selected_roads = [input.selected_roads[0]];
    sourceInput.features.find(feature => feature.id === input.selected_roads[0].section.original_road_id).properties.name = actualName;
    input.selected_roads[0].road_name = actualName ?? '';
    for (const sample of input.selected_roads[0].section.profiles) sample.road_name = actualName ?? '';
    const sourceSha256 = hash(Buffer.from(JSON.stringify(sourceInput)));
    surfacesInput.metadata.sourceSha256 = sourceSha256;
    const surfaceSha256 = hash(Buffer.from(JSON.stringify(surfacesInput)));
    input.source.sha256 = sourceSha256; input.NGII.sha256 = surfaceSha256;
    const result = build(input, emptyReviews, {sourceSha256, surfaceSha256, verifiedImageHashes: {}}, sourceInput, surfacesInput);
    assert.equal(result.profiles[0].roadName, actualName ?? '');
    assert.equal(result.profiles[0].reviewStatus, 'pending');
  }
});

test('raw source/surface hash provenance cannot be mismatched or replaced by a scratch path', () => {
  assert.throws(() => build(candidates, emptyReviews, {...expectedHashes, sourceSha256: '0'.repeat(64)}), /checksum/);
  assert.throws(() => build(candidates, emptyReviews, {...expectedHashes, surfaceSha256: '0'.repeat(64)}), /checksum/);
  const relocated = candidateClone(input => { input.source.path = 'missing-source-file'; input.NGII.path = 'missing-surface-file'; });
  assert.deepEqual(build(relocated), build());
});

test('review scope, dates, URLs, observations and actual-image hash registry are enforced', () => {
  const {review, hashes} = reviewedFixture(0);
  for (const change of [
    {id: 'unknown/profile'}, {sourceId: 'way/unknown'}, {originalPartIndex: 1}, {originalSegmentIndex: 1},
    {startAlongSegmentM: review.startAlongSegmentM + 1}, {endAlongSegmentM: review.endAlongSegmentM + 1},
    {status: 'official_actual'}, {observedOn: null}, {observedOn: '2026-02-31'}, {imageryDate: undefined}, {imageryDate: '2026-13'}, {sourceUrl: 'file:///untrusted'},
    {observations: []}, {images: []}, {images: [{path: 'unknown.png', sha256: '0'.repeat(64)}]},
    {images: [{...review.images[0], sha256: '0'.repeat(64)}]}, {images: [review.images[0], review.images[0]]}
  ]) assert.throws(() => build(candidates, {schema: emptyReviews.schema, records: [{...review, ...change}]}, hashes));
  assert.throws(() => build(candidates, {schema: emptyReviews.schema, records: [review, review]}, hashes), /duplicate/);
  assert.throws(() => build(candidates, {schema: emptyReviews.schema, records: [review]}, expectedHashes), /not verified/);
});

test('candidate samples cannot be reassigned, promoted, shifted, reversed or given inconsistent endpoints', () => {
  const mutations = [
    sample => { sample.original_road_id = 'way/unknown'; },
    sample => { sample.original_part_index = 999; },
    sample => { sample.original_segment_index += 1; },
    sample => { sample.status = 'VERIFIED'; },
    sample => { sample.rejected_reasons = ['junction']; },
    sample => { sample.residual_interval.actual_carriageway_width_m = sample.residual_interval.span_m; },
    sample => { sample.sample_along_original_segment_m += 1; },
    sample => { sample.normal_left_of_original_line = sample.normal_left_of_original_line.map(value => -value); },
    sample => { sample.heading_degrees_clockwise_from_native_north += 1; },
    sample => { sample.samplepoint.native_epsg5186_m[0] += 1; },
    sample => { sample.samplepoint.local_plan_m[0] += 1; },
    sample => { sample.road_boundary.span_m += 1; },
    sample => { sample.left_sidewalk.endpoints[0].native_epsg5186_m[0] += 1; },
    sample => { sample.right_sidewalk.endpoints[1].local_plan_m[0] = Infinity; },
    sample => { sample.residual_interval.signed_normal_interval_m.reverse(); },
    sample => { [sample.left_sidewalk, sample.right_sidewalk] = [sample.right_sidewalk, sample.left_sidewalk]; },
    sample => { sample.left_sidewalk.ngii_polygon_id = sample.road_boundary.ngii_polygon_id; }
  ];
  for (const mutation of mutations) assert.throws(() => build(candidateClone(input => mutation(input.selected_roads[0].section.profiles[0]))));
  assert.throws(() => build(candidateClone(input => input.selected_roads[0].section.profiles.pop())), /four cross-section/);
  assert.throws(() => build(candidateClone(input => { input.selected_roads[0].section.end_along_segment_m = Infinity; })), /interval/);
});

test('missing polygon evidence, altered native geometry and boundary expansion are rejected', () => {
  const polygonId = candidates.selected_roads[0].section.profiles[0].left_sidewalk.ngii_polygon_id;
  const missing = structuredClone(surfaces);
  missing.features = missing.features.filter(feature => feature.id !== polygonId);
  assert.throws(() => build(candidates, emptyReviews, expectedHashes, source, missing), /polygon evidence/);
  const shifted = structuredClone(surfaces);
  const geometry = shifted.features.find(feature => feature.id === polygonId).properties.native_geometry_m;
  for (const point of geometry.coordinates.flat(geometry.type === 'Polygon' ? 1 : 2)) point[0] += 20;
  assert.throws(() => build(candidates, emptyReviews, expectedHashes, source, shifted), /native polygon/);
  const narrowed = structuredClone(source);
  const sample = candidates.selected_roads[0].section.profiles[0].samplepoint.local_plan_m;
  narrowed.metadata.local_provisional_boundary_m = [[sample[0] - 1, sample[1] - 1], [sample[0] + 1, sample[1] - 1], [sample[0] + 1, sample[1] + 1], [sample[0] - 1, sample[1] + 1], [sample[0] - 1, sample[1] - 1]];
  assert.throws(() => build(candidates, emptyReviews, expectedHashes, narrowed), /approved boundary/);
});

test('an endpoint-only sidewalk notch or missing cut is rejected even when all four interior cuts remain unchanged', () => {
  const road = candidates.selected_roads.find(road => road.road_name === '구일로4길');
  const inputBase = candidateClone(input => { input.selected_roads = [structuredClone(road)]; });
  const base = build(inputBase).profiles[0], first = road.section.profiles[0];
  const original = source.features.find(feature => feature.id === first.original_road_id);
  const line = original.geometry.type === 'LineString' ? original.geometry.coordinates : original.geometry.coordinates[first.original_part_index];
  const a = projectProfilePointToNative(line[first.original_segment_index]), b = projectProfilePointToNative(line[first.original_segment_index + 1]);
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const tangent = [(b[0] - a[0]) / length, (b[1] - a[1]) / length], normal = [-tangent[1], tangent[0]];
  const native = (along, offset) => a.map((value, axis) => value + tangent[axis] * along + normal[axis] * offset);
  const {review, hashes: reviewHashes} = reviewedFixture(0, inputBase);
  for (const mode of ['narrow', 'missing', 'center_overlap']) {
    const input = structuredClone(inputBase), surfacesInput = structuredClone(surfaces);
    const start = {along: base.startAlongSegmentM + (mode === 'missing' ? 1 : 0), interval: [...base.endpointChecks[0].spans.left_sidewalk.signed_normal_interval_m]};
    if (mode === 'narrow') start.interval[0] += 0.75;
    const knots = [start, ...road.section.profiles.map(sample => ({along: sample.sample_along_original_segment_m, interval: sample.left_sidewalk.signed_normal_interval_m})),
      {along: base.endAlongSegmentM, interval: base.endpointChecks[1].spans.left_sidewalk.signed_normal_interval_m}];
    const ring = [...knots.map(knot => native(knot.along, knot.interval[0])), ...[...knots].reverse().map(knot => native(knot.along, knot.interval[1]))];
    ring.push([...ring[0]]);
    const polygon = surfacesInput.features.find(feature => feature.id === first.left_sidewalk.ngii_polygon_id);
    polygon.properties.native_geometry_m = {type: 'Polygon', coordinates: [ring]};
    if (mode === 'center_overlap') {
      const patch = [[base.startAlongSegmentM - 0.15, -0.1], [base.startAlongSegmentM + 0.15, -0.1], [base.startAlongSegmentM + 0.15, 0.1], [base.startAlongSegmentM - 0.15, 0.1]].map(([along, offset]) => native(along, offset));
      patch.push([...patch[0]]);
      polygon.properties.native_geometry_m = {type: 'MultiPolygon', coordinates: [[ring], [patch]]};
    }
    // The real source remains untouched; only this private polygon fixture is
    // rebuilt. Verify the four saved cuts still match, so the new endpoint check
    // rather than an interior-sample mismatch must expose the failure.
    for (const sample of road.section.profiles) {
      const cuts = crossSectionIntervals(sample.samplepoint.native_epsg5186_m, tangent, polygon.properties.native_geometry_m, 80);
      assert.ok(cuts.some(interval => interval.every((value, axis) => Math.abs(value - sample.left_sidewalk.signed_normal_interval_m[axis]) < 0.002)));
    }
    const surfaceSha256 = hash(Buffer.from(JSON.stringify(surfacesInput)));
    input.NGII.sha256 = surfaceSha256;
    const hashes = {...reviewHashes, surfaceSha256};
    const expected = mode === 'narrow' ? /endpoint-inclusive left_sidewalk variation/ : mode === 'missing' ? /continuous left_sidewalk endpoint span/ : /endpoint sidewalk polygon contains the original centerline/;
    assert.throws(() => build(input, emptyReviews, hashes, source, surfacesInput), expected);
    assert.throws(() => build(input, {schema: emptyReviews.schema, records: [review]}, hashes, source, surfacesInput), expected);
  }
});

test('projection agrees with the saved proj4-derived native positions at all sample cross sections', () => {
  for (const sample of candidates.selected_roads.flatMap(road => road.section.profiles)) {
    const positions = [sample.samplepoint, ...['road_boundary', 'left_sidewalk', 'right_sidewalk', 'residual_interval'].flatMap(kind => sample[kind].endpoints)];
    for (const position of positions) assert.ok(Math.hypot(...projectProfilePointToNative(position.wgs84_lon_lat).map((value, i) => value - position.native_epsg5186_m[i])) < 0.002);
  }
  assert.throws(() => projectProfilePointToNative([0, 0]), /Seoul reference/);
  assert.throws(() => projectProfilePointToNative([Infinity, 38]), /WGS84/);
});

test('optional existing proj4 verifies native original vertices and inverse round trips', {skip: !process.env.PROFILE_PROJ4_PATH}, () => {
  const proj4 = createRequire(import.meta.url)(process.env.PROFILE_PROJ4_PATH);
  const crs = '+ellps=GRS80 +proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +units=m +no_defs';
  for (const road of candidates.selected_roads) {
    const original = source.features.find(feature => feature.id === road.section.original_road_id);
    const line = original.geometry.type === 'LineString' ? original.geometry.coordinates : original.geometry.coordinates[road.section.profiles[0].original_part_index];
    for (const wgs of line) {
      const native = projectProfilePointToNative(wgs), reference = proj4('EPSG:4326', crs, wgs);
      assert.ok(Math.hypot(...native.map((value, i) => value - reference[i])) < 0.002);
      const back = proj4(crs, 'EPSG:4326', native);
      assert.ok(Math.hypot((back[0] - wgs[0]) * source.metadata.coordinate_system.meters_per_degree_lon, (back[1] - wgs[1]) * source.metadata.coordinate_system.meters_per_degree_lat) < 0.002);
    }
  }
});
