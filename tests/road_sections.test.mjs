import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {crossSectionIntervals, unionIntervals, subtractIntervals, boundedSections, measureRoadSections} from '../tools/measure_road_sections.mjs';

const rectangle = (x1, y1, x2, y2) => ({type: 'Polygon', coordinates: [[[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]]});
const feature = (id, kind, geometry, width = null, attributes = {}) => ({id, geometry, properties: {surfaceKind: kind, local_geometry_m: geometry, evidenceId: id, officialWidthM: width, officialWidthKind: kind === 'walkway' ? 'walkway' : 'road_outer_curb_or_shoulder', attributes}});
function sourceLine(category = 'road', tags = {}, coordinates = [[10, 0], [90, 0]]) {
  return {metadata: {local_provisional_boundary_m: rectangle(0, -50, 100, 50).coordinates[0]}, features: [{id: 'way/test', geometry: {type: 'LineString', coordinates}, properties: {category, name: '', osm_tags: {highway: category === 'path' ? 'footway' : 'residential', ...tags}, local_geometry_m: {type: 'LineString', coordinates}}}]};
}
const centerline = feature('center', 'road_centerline', {type: 'LineString', coordinates: [[0, 0], [100, 0]]}, 10, {'분리대유무': '무'});

test('normal intersections handle angle, holes, multipolygons and interval exclusion', () => {
  assert.deepEqual(crossSectionIntervals([5, 5], [1, 0], rectangle(0, 0, 10, 10)), [[-5, 5]]);
  const polygon = rectangle(0, 0, 10, 10);
  polygon.coordinates.push(rectangle(3, 3, 7, 7).coordinates[0]);
  assert.deepEqual(crossSectionIntervals([5, 5], [1, 0], polygon), [[-5, -2], [2, 5]]);
  const diagonal = crossSectionIntervals([5, 5], [1, 1], rectangle(0, 0, 10, 10));
  assert.ok(Math.abs(diagonal[0][1] - diagonal[0][0] - Math.sqrt(200)) < 1e-8);
  assert.deepEqual(unionIntervals([[0, 2], [1, 3], [6, 9]]), [[0, 3], [6, 9]]);
  assert.deepEqual(subtractIntervals([[-5, 5]], [[-5, -3], [3, 5]]), [[-3, 3]]);
});

test('section geometries stay on original bends and exclude a short unsampled tail', () => {
  const sections = boundedSections([[0, 0], [10, 0], [10, 20]], 20);
  assert.deepEqual(sections[0].localGeometry.coordinates, [[0, 0], [10, 0], [10, 10]]);
  assert.deepEqual(sections[1].localGeometry.coordinates, [[10, 10], [10, 20]]);
  const source = sourceLine('path', {}, [[10, 0], [35, 0]]);
  const measured = measureRoadSections(source, {features: [feature('walk', 'walkway', rectangle(0, -2, 100, 2), 4)]});
  assert.equal(measured.records[0].segments.length, 1);
  assert.equal(measured.records[0].segments[0].endM, 20);
  assert.equal(measured.records[0].unmeasuredInsideLengthM, 5);
});

test('A001/A002 values and mapped sidewalk overlap never silently become carriageway widths', () => {
  const road = feature('road', 'road_corridor', rectangle(0, -5, 100, 5));
  const sidewalks = [feature('left', 'walkway', rectangle(0, -5, 100, -3), 2), feature('right', 'walkway', rectangle(0, 3, 100, 5), 2)];
  const result = measureRoadSections(sourceLine(), {features: [road, centerline, ...sidewalks]});
  assert.equal(result.summary.estimatedCarriagewaySections, 0);
  assert.equal(result.records[0].widthM, null);
  assert.equal(result.records[0].officialWidthSections.length, 4);
  const sample = result.records[0].sectionReviews[0].samples[0];
  assert.equal(sample.corridorWidthM, 10);
  assert.equal(sample.walkwayOverlapM, 4);
  assert.deepEqual(sample.afterMappedWalkwayExclusionIntervalsM, [[-3, 3]]);
  assert.equal(sample.widthM, null);
  const enabled = measureRoadSections(sourceLine(), {features: [road, centerline, ...sidewalks]}, {roadPolygonMeaning: 'corridor_including_sidewalks', semanticEvidenceId: 'review/corridor', walkwayCompletenessEvidenceId: 'review/sidewalk-coverage'});
  assert.equal(enabled.records[0].segments[0].widthM, 6);
  assert.equal(enabled.records[0].widthM, null);
  const roadOnly = feature('road-only', 'road_corridor', rectangle(0, -3, 100, 3));
  const excludedAlready = measureRoadSections(sourceLine(), {features: [roadOnly, centerline, ...sidewalks]});
  assert.equal(excludedAlready.records[0].sectionReviews[0].samples[0].walkwayOverlapM, 0);
});

test('variable walkway widths are bounded, sampled and never propagated over the whole source way', () => {
  const trapezoid = {type: 'Polygon', coordinates: [[[0, -1], [100, -2], [100, 2], [0, 1], [0, -1]]]};
  const source = sourceLine('path'), before = structuredClone(source);
  const result = measureRoadSections(source, {features: [feature('walk', 'walkway', trapezoid, 3)]}, {attributeDifferenceFractionMax: 0.5});
  assert.equal(result.records[0].segments.length, 4);
  assert.ok(result.records[0].segments[0].widthM < result.records[0].segments.at(-1).widthM);
  assert.ok(result.records[0].segments.every(segment => segment.sampleCount >= 3 && segment.rangeM[0] <= segment.widthM && segment.widthM <= segment.rangeM[1] && segment.errorM === null));
  assert.equal(result.records[0].widthM, null);
  assert.deepEqual(source, before);
});

test('parking aisles, crossings, bridges, multiple surfaces and conflicting widths remain null', () => {
  const road = feature('road', 'road_corridor', rectangle(0, -5, 100, 5));
  for (const tags of [{service: 'parking_aisle'}, {access: 'private'}, {bridge: 'yes'}, {tunnel: 'yes'}, {layer: '-1'}]) {
    const result = measureRoadSections(sourceLine('road', tags), {features: [road, centerline]}, {centerlineWidthMeaning: 'carriageway', semanticEvidenceId: 'review/meaning'});
    assert.equal(result.records[0].segments.length, 0);
  }
  const overlapping = measureRoadSections(sourceLine(), {features: [road, feature('duplicate-road', 'road_corridor', road.geometry), centerline]}, {centerlineWidthMeaning: 'carriageway', semanticEvidenceId: 'review/meaning'});
  assert.equal(overlapping.records[0].segments.length, 0);
  const conflict = measureRoadSections(sourceLine(), {features: [road, centerline, feature('different-width', 'road_centerline', centerline.geometry, 11)]});
  assert.equal(conflict.records[0].officialWidthSections.length, 0);
  const crossing = measureRoadSections(sourceLine('path', {footway: 'crossing'}), {features: [feature('walk', 'walkway', rectangle(0, -2, 100, 2), 4)]});
  assert.equal(crossing.records[0].segments.length, 0);
});

test('holes between samples and unsupported section endpoints cannot receive interpolated widths', () => {
  const polygon = rectangle(0, -2, 100, 2);
  polygon.coordinates.push(rectangle(28.8, -1, 29.1, 1).coordinates[0]);
  const result = measureRoadSections(sourceLine('path'), {features: [feature('walk', 'walkway', polygon, 4)]});
  assert.equal(result.records[0].sectionReviews[0].reason, 'section_not_continuously_inside_matched_surface');
  assert.equal(result.records[0].segments.length, 3);
  const truncated = measureRoadSections(sourceLine('path', {}, [[10, 0], [30, 0]]), {features: [feature('walk', 'walkway', rectangle(11, -2, 29, 2), 4)]});
  assert.equal(truncated.records[0].segments.length, 0);
  assert.throws(() => measureRoadSections(sourceLine('path'), {features: [feature('invalid', 'walkway', rectangle(0, -2, 100, 2), NaN)]}), /Invalid official width/);
});

test('tile acquisition completeness does not imply individual width verification', () => {
  const surfaces = {metadata: {audit: [{tile: 'tile-a'}, {tile: 'tile-b'}]}, features: []};
  const result = measureRoadSections(sourceLine(), surfaces, {expectedBoundaryTileCount: 2});
  assert.equal(result.tileAcquisition.status, 'all_requested_boundary_tiles_acquired');
  assert.equal(result.tileAcquisition.individualRoadWidthVerificationComplete, false);
  assert.equal(result.summary.estimatedSectionCount, 0);
  assert.throws(() => measureRoadSections(sourceLine(), surfaces, {expectedBoundaryTileCount: 3}), /Expected boundary tile count/);
  assert.throws(() => measureRoadSections(sourceLine(), surfaces, {minimumSamples: 2}), /At least three/);
});

test('A001 bounded surface geometry is a separate reference, including when A002 is missing', () => {
  const road = feature('road', 'road_corridor', rectangle(0, -5, 100, 5));
  const result = measureRoadSections(sourceLine(), {features: [road]});
  assert.equal(result.records[0].roadSurfaceSections.length, 4);
  assert.equal(result.summary.roadSurfaceReferenceLengthM, 80);
  assert.equal(result.summary.estimatedCarriagewaySections, 0);
  assert.equal(result.records[0].segments.length, 0);
  assert.equal(result.records[0].widthM, null);
  for (const section of result.records[0].roadSurfaceSections) {
    assert.equal(section.widthKind, 'road_surface_reference');
    assert.equal(section.status, 'geometry_estimate_not_verified_carriageway');
    assert.equal(section.eligibility, 'geometry_reference_only');
    assert.equal(section.widthM, 10);
    assert.deepEqual(section.rangeM, [10, 10]);
    assert.equal(section.sampleCount, 4);
    assert.equal(section.endpointChecks.length, 2);
    assert.deepEqual(section.evidenceIds, ['road']);
    assert.equal(section.rangeStatus, 'observed_section_variation_not_statistical_accuracy');
  }
});

test('A001 reference section lengths, widths and sample positions use native metres', () => {
  const transform = {toMetric: ([x, y]) => [x * 2, y * 3], toLocal: ([x, y]) => [x / 2, y / 3], geometryMode: 'native', metricCRS: 'test projected metres'};
  const road = feature('road', 'road_corridor', rectangle(0, -1, 100, 1));
  road.properties.native_geometry_m = rectangle(0, -9, 200, 9);
  const result = measureRoadSections(sourceLine('road', {}, [[10, 0], [30, 0]]), {features: [road]}, {metricTransform: transform});
  const sections = result.records[0].roadSurfaceSections;
  assert.equal(sections.length, 2);
  assert.deepEqual(sections.map(section => [section.startM, section.endM, section.widthM]), [[0, 20, 18], [20, 40, 18]]);
  assert.deepEqual(sections[0].localGeometry.coordinates, [[10, 0], [20, 0]]);
  assert.deepEqual(sections[0].samples.map(sample => sample.pointMetricM[0]), [22.5, 27.5, 32.5, 37.5]);
  assert.ok(sections.every(section => section.distanceBasis === 'native_projected_metres'));
});

test('A001 references reject seams, unsampled holes, overlaps, short tails and unsupported endpoints', () => {
  const source = sourceLine('road', {}, [[10, 0], [30, 0]]);
  const polygon = rectangle(0, -5, 100, 5);
  polygon.coordinates.push(rectangle(18.8, -1, 19.1, 1).coordinates[0]);
  const cases = [
    [feature('hole', 'road_corridor', polygon)],
    [feature('a', 'road_corridor', rectangle(0, -5, 20, 5)), feature('b', 'road_corridor', rectangle(20, -5, 100, 5))],
    [feature('a', 'road_corridor', rectangle(0, -5, 100, 5)), feature('b', 'road_corridor', rectangle(18.8, -1, 19.1, 1))],
    [feature('endpoints', 'road_corridor', rectangle(11, -5, 29, 5))]
  ];
  for (const features of cases) assert.equal(measureRoadSections(source, {features}).records[0].roadSurfaceSections.length, 0);
  const short = measureRoadSections(sourceLine('road', {}, [[10, 0], [35, 0]]), {features: [feature('road', 'road_corridor', rectangle(0, -5, 100, 5))]});
  assert.equal(short.records[0].roadSurfaceSections.length, 1);
  assert.equal(short.records[0].roadSurfaceSections[0].endM, 20);
});

test('A001 references reject divided roads, ambiguous divider attributes, junctions and vertical layers', () => {
  const road = feature('road', 'road_corridor', rectangle(0, -5, 100, 5));
  for (const tags of [{oneway: 'yes'}, {oneway: '-1'}, {bridge: 'yes'}, {tunnel: 'yes'}, {layer: '1'}, {access: 'private'}, {service: 'parking_aisle'}]) assert.equal(measureRoadSections(sourceLine('road', tags), {features: [road]}).records[0].roadSurfaceSections.length, 0);
  const divider = feature('divider', 'road_centerline', centerline.geometry, null, {'분리대유무': '유'});
  assert.equal(measureRoadSections(sourceLine(), {features: [road, centerline, divider]}).records[0].roadSurfaceSections.length, 0);
  const crossing = feature('junction', 'road_centerline', {type: 'LineString', coordinates: [[20, -10], [20, 10]]}, 10);
  const result = measureRoadSections(sourceLine('road', {}, [[10, 0], [30, 0]]), {features: [road, crossing]});
  assert.equal(result.records[0].roadSurfaceSections.length, 0);
  assert.equal(result.records[0].roadSurfaceReviews[0].reason, 'official_centerline_junction_needs_individual_review');
});

test('real NGII data retains all 244 original lines and cannot classify A001 as actual carriageway', async () => {
  const source = JSON.parse(await readFile(new URL('../docs/guro1_plan_2d.geojson', import.meta.url), 'utf8'));
  const surfaces = JSON.parse(await readFile(new URL('../docs/reference/guil_ngii_road_surfaces.geojson', import.meta.url), 'utf8'));
  const before = structuredClone(source);
  const result = measureRoadSections(source, surfaces);
  assert.equal(result.records.length, 244);
  assert.equal(result.summary.roadLines, 153);
  assert.equal(result.summary.pathLines, 91);
  assert.equal(result.summary.estimatedCarriagewaySections, 0);
  assert.equal(result.summary.parentWayWidthsAssigned, 0);
  assert.ok(result.records.every(record => record.widthM === null));
  assert.ok(result.summary.unmeasuredInsideLengthM > 0);
  assert.deepEqual(source, before);
});

test('saved native section references resolve evidence and preserve source checksum without parent widths', async () => {
  const sourceBytes = await readFile(new URL('../docs/guro1_plan_2d.geojson', import.meta.url));
  const surfaceBytes = await readFile(new URL('../docs/reference/guil_ngii_road_surfaces.geojson', import.meta.url));
  const surfaces = JSON.parse(surfaceBytes);
  const saved = JSON.parse(await readFile(new URL('../docs/reference/guil_ngii_road_sections.json', import.meta.url), 'utf8'));
  const evidenceIds = new Set(surfaces.features.map(feature => feature.properties.evidenceId || feature.id));
  assert.equal(saved.sourceSha256, createHash('sha256').update(sourceBytes).digest('hex'));
  assert.equal(saved.sourceSha256, 'f4081a9a33fa0f622ce7174fce5f2a3381291c5fba8d5c152a9e609f87ad7f43');
  assert.equal(saved.surfaceReferenceSha256, createHash('sha256').update(surfaceBytes).digest('hex'));
  assert.equal(saved.metricCRS, 'actual NGII PRJ projected metres');
  assert.equal(saved.tileAcquisition.acquiredTileCount, 13);
  assert.equal(saved.tileAcquisition.individualRoadWidthVerificationComplete, false);
  assert.equal(saved.records.length, 244);
  assert.ok(saved.summary.roadSurfaceReferenceSections > 0);
  assert.equal(saved.summary.roadSurfaceReferenceSections, saved.records.flatMap(record => record.roadSurfaceSections).length);
  assert.equal(saved.summary.estimatedWalkwaySections, 29);
  assert.equal(saved.summary.officialWidthReferenceSections, 357);
  for (const record of saved.records) {
    assert.equal(record.widthM, null);
    assert.equal(record.status, 'unmeasured');
    assert.equal(record.sectionReviews, undefined);
    for (const segment of record.segments) {
      assert.equal(segment.widthKind, 'walkway');
      assert.equal(segment.status, 'measured_estimate');
      assert.ok(segment.sampleCount >= 3);
      assert.ok(segment.rangeM[0] <= segment.widthM && segment.widthM <= segment.rangeM[1]);
      assert.equal(segment.errorM, null);
      assert.ok(segment.evidenceIds.every(id => evidenceIds.has(id)));
    }
    for (const reference of record.officialWidthSections) {
      assert.equal(reference.widthKind, 'road_outer_curb_or_shoulder');
      assert.equal(reference.status, 'official_attribute_spatially_matched_not_carriageway');
      assert.ok(reference.samples.length >= 3);
      assert.ok(reference.evidenceIds.every(id => evidenceIds.has(id)));
    }
    assert.equal(record.roadSurfaceReviews, undefined);
    for (const reference of record.roadSurfaceSections || []) {
      assert.equal(reference.widthKind, 'road_surface_reference');
      assert.equal(reference.status, 'geometry_estimate_not_verified_carriageway');
      assert.equal(reference.eligibility, 'geometry_reference_only');
      assert.equal(reference.distanceBasis, 'native_projected_metres');
      assert.ok(reference.sampleCount >= 3);
      assert.equal(reference.endpointChecks.length, 2);
      assert.ok(reference.evidenceIds.every(id => evidenceIds.has(id)));
      assert.ok(reference.rangeM[0] <= reference.widthM && reference.widthM <= reference.rangeM[1]);
      assert.ok(reference.endM - reference.startM <= 20.000001);
    }
  }
});
