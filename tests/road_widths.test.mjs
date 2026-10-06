import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {clipLineToRing, cumulativeLength, makeRoadInventory, applyRoadWidths} from '../tools/road_widths.mjs';
import {buildRoadWidthData} from '../tools/build_road_width_data.mjs';

const source = JSON.parse(await readFile(new URL('../docs/guro1_plan_2d.geojson', import.meta.url), 'utf8'));
const ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];

test('clipping handles crossing, boundary edges, corner touches and disconnected portions', () => {
  assert.deepEqual(clipLineToRing([[-5, 5], [15, 5]], ring), [[[0, 5], [10, 5]]]);
  assert.deepEqual(clipLineToRing([[-5, 0], [15, 0]], ring), [[[0, 0], [10, 0]]]);
  assert.deepEqual(clipLineToRing([[-5, 5], [0, 0], [5, -5]], ring), []);
  assert.deepEqual(clipLineToRing([[2, 2], [12, 2], [12, 8], [2, 8]], ring), [[[2, 2], [10, 2]], [[10, 8], [2, 8]]]);
  assert.deepEqual(clipLineToRing([[2, 2], [2, 2], [8, 8]], ring), [[[2, 2], [8, 8]]]);
  assert.equal(cumulativeLength([[0, 0], [3, 4], [3, 9]]), 10);
});

test('holes, open rings and invalid coordinates fail explicitly', () => {
  assert.throws(() => clipLineToRing([[0, 0], [1, 1]], [ring, ring]), /holes are unsupported/);
  assert.throws(() => clipLineToRing([[0, 0], [1, 1]], ring.slice(0, -1)), /closed/);
  assert.throws(() => clipLineToRing([[NaN, 0], [1, 1]], ring), /finite/);
  const withHoles = structuredClone(source);
  withHoles.metadata.provisional_boundary.coordinates.push(ring);
  assert.throws(() => makeRoadInventory(withHoles), /holes are unsupported/);
});

test('real inventory counts only nonzero inside road/path lines and matches independent clip totals', () => {
  const before = structuredClone(source);
  const records = makeRoadInventory(source);
  assert.equal(records.length, 244);
  const roads = records.filter(record => record.category === 'road');
  const paths = records.filter(record => record.category === 'path');
  assert.equal(roads.length, 153);
  assert.equal(paths.length, 91);
  assert.ok(Math.abs(roads.reduce((sum, record) => sum + record.insideLengthM, 0) - 23308.59335580615) < 1e-6);
  assert.ok(Math.abs(paths.reduce((sum, record) => sum + record.insideLengthM, 0) - 8330.898191928434) < 1e-6);
  assert.equal(records.filter(record => record.footway === 'sidewalk').length, 28);
  assert.equal(records.filter(record => record.service === 'parking_aisle').length, 41);
  assert.ok(records.every(record => record.insideLengthM > 0 && record.widthM === null && record.widthStatus === 'unmeasured'));
  assert.ok(records.some(record => record.sourceId === 'way/219866798' && record.insideLengthM < 0.2));
  assert.ok(records.some(record => record.sourceId === 'way/634881082' && record.osmTags.access === 'private'));
  assert.deepEqual(source, before);
  for (const record of records) {
    const original = source.features.find(feature => feature.id === record.sourceId);
    assert.deepEqual(record.localgeometry, original.properties.local_geometry_m);
    assert.deepEqual(record.WGS84geometry, original.geometry);
  }
});

const plan = {
  features: [
    {id: 'way/a', category: 'road', geometry: {type: 'LineString', coordinates: [[0, 0], [10, 10]]}, roadWidthM: null},
    {id: 'way/b', category: 'path', geometry: {type: 'LineString', coordinates: [[1, 0], [1, 10]]}, roadWidthM: null},
    {id: 'node/c', category: 'road', geometry: {type: 'Point', coordinates: [0, 0]}, roadWidthM: null}
  ]
};
const measurement = {sourceId: 'way/a', widthKind: 'carriageway', widthM: 8, status: 'measured_estimate', rangeM: [7, 9], evidenceIds: ['survey/1']};

test('width overlays preserve all IDs/geometries and never apply class constraints as actual widths', () => {
  const before = structuredClone(plan);
  const result = applyRoadWidths(plan, {records: [measurement], officialRoadClass: [{sourceId: 'way/b', rangeM: [12, 20]}]});
  assert.deepEqual(plan, before);
  assert.deepEqual(result.features.map(feature => [feature.id, feature.geometry]), before.features.map(feature => [feature.id, feature.geometry]));
  assert.equal(result.features[0].roadWidthM, 8);
  assert.equal(result.features[0].roadWidthStatus, 'measured_estimate');
  assert.equal(result.features[1].roadWidthM, null);
  assert.equal(result.metadata.roadWidths.explicitWidthCount, 1);
});

test('unmeasured stays null; inferred ranges do not invent a midpoint', () => {
  const records = [
    {...measurement, widthM: null, rangeM: null, status: 'unmeasured', evidenceIds: []},
    {sourceId: 'way/b', widthKind: 'walkway', widthM: null, rangeM: [2, 4], status: 'inferred_range', evidenceIds: ['map/1']}
  ];
  const result = applyRoadWidths(plan, {records});
  assert.equal(result.features[0].roadWidthM, null);
  assert.equal(result.features[1].roadWidthM, null);
  assert.deepEqual(result.features[1].roadWidthRangeM, [2, 4]);
});

test('invalid numeric widths, ranges, IDs, evidence and false unmeasured records are rejected', () => {
  for (const change of [
    {widthM: NaN}, {widthM: Infinity}, {widthM: -1}, {rangeM: [9, 7]}, {rangeM: [0, 9]},
    {rangeM: [7, NaN]}, {rangeM: [7]}, {widthM: 10}, {sourceId: 'unknown'},
    {sourceId: 'node/c'}, {status: 'unmeasured'}, {status: 'official_actual', widthM: null},
    {status: 'inferred_range', rangeM: null}, {evidenceIds: []}, {widthM: '8'}
  ]) assert.throws(() => applyRoadWidths(plan, {records: [{...measurement, ...change}]}));
  assert.throws(() => applyRoadWidths(plan, {records: [measurement, measurement]}), /Duplicate width ID/);
});

test('official administrative widths and map ribbon ranges remain separate from all actual widths', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../docs/reference/guil_official_road_widths.json', import.meta.url), 'utf8'));
  const north = JSON.parse(await readFile(new URL('../docs/reference/guro1_plan_north.json', import.meta.url), 'utf8'));
  const saved = JSON.parse(await readFile(new URL('../docs/guil_road_widths.json', import.meta.url), 'utf8'));
  const before = structuredClone(source);
  const result = buildRoadWidthData(source, snapshot, north, saved.sourceSha256);
  assert.deepEqual(result, saved);
  assert.deepEqual(source, before);
  assert.equal(result.records.length, 244);
  assert.ok(result.records.every(record => record.status === 'unmeasured' && record.widthM === null && record.rangeM === null));
  assert.equal(result.summary.actualMeasuredWidths, 0);
  assert.equal(result.matching.closeCandidateAudit.length, 37);
  assert.equal(result.mapRepresentationReferences.length, 5);
  assert.equal(result.mapRepresentationReferences.filter(ref => ref.status === 'inferred_range').length, 5);
  assert.equal(result.officialReferences.find(ref => ref.roadName === '서부간선로').corridorWidthM, 2);
  assert.ok(result.roadNameSummary.every(row => row.actualCarriagewayWidthM === null && row.actualSidewalkWidthM === null && row.widthChangeLocations === 'unavailable'));
  assert.equal(result.records.find(record => record.sourceId === 'way/219866798').officialAssociationStatus, 'insufficient_in_boundary_length');
  assert.equal(result.records.find(record => record.sourceId === 'way/520935924').officialAssociationStatus, 'requires_review');
  const baselinePlan = {features: source.features.map(feature => ({id: String(feature.id), category: feature.properties.category, geometry: feature.properties.local_geometry_m, roadWidthM: null}))};
  const applied = applyRoadWidths(baselinePlan, result);
  assert.ok(applied.features.every(feature => feature.roadWidthM === null));
  assert.equal(applied.metadata.roadWidths.officialReferences.length, result.officialReferences.length);
  assert.equal(applied.metadata.roadWidths.mapRepresentationReferences.length, 5);
});
