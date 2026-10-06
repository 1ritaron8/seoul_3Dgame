import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDbf, parseShp, ringsToPolygonGeometry, toLocalGeometry, createCrsTransform, validateShx, validateTileIds, NGII_1K_TILE_IDS } from '../tools/read_ngii_shp.mjs';

function dbfFixture({ deleted = false, numeric = '3.5000', korean = false } = {}) {
  const fields = [Buffer.from(korean ? [0xc6, 0xf8] : 'width'), Buffer.from('UFID')];
  const header = 97, record = 1 + 16 + 8, b = Buffer.alloc(header + record + 1, 32);
  b.fill(0, 0, header); b[0] = 3; b.writeUInt32LE(1, 4); b.writeUInt16LE(header, 8); b.writeUInt16LE(record, 10);
  fields.forEach((name, i) => { const o = 32 + i * 32; name.copy(b, o); b[o + 11] = (i === 0 ? 'N' : 'C').charCodeAt(0); b[o + 16] = i === 0 ? 16 : 8; b[o + 17] = i === 0 ? 4 : 0; });
  b[96] = 13; b[97] = deleted ? 42 : 32; Buffer.from(numeric.padStart(16)).copy(b, 98); Buffer.from('tile-id ').copy(b, 114); b[b.length - 1] = 26;
  return b;
}
function shpFixture(type = 3, parts = [[[1, 2], [3, 4]]]) {
  const flat = parts.flat(), content = 44 + parts.length * 4 + flat.length * 16;
  const b = Buffer.alloc(108 + content); b.writeInt32BE(9994, 0); b.writeInt32BE(b.length / 2, 24); b.writeInt32LE(1000, 28); b.writeInt32LE(type, 32);
  b.writeInt32BE(1, 100); b.writeInt32BE(content / 2, 104); b.writeInt32LE(type, 108);
  b.writeInt32LE(parts.length, 144); b.writeInt32LE(flat.length, 148);
  let index = 0; parts.forEach((part, i) => { b.writeInt32LE(index, 152 + i * 4); index += part.length; });
  flat.forEach((p, i) => { b.writeDoubleLE(p[0], 152 + parts.length * 4 + i * 16); b.writeDoubleLE(p[1], 160 + parts.length * 4 + i * 16); });
  return b;
}
const square = (x, y, size) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];

test('DBF CP949 Korean field names and typed numeric values', () => {
  const result = parseDbf(dbfFixture({ korean: true }));
  assert.equal(result.fields[0].name, '폭'); assert.equal(result.records[0].values['폭'], 3.5);
  assert.equal(result.records[0].values.UFID, 'tile-id');
});
test('DBF blank numeric null and deleted rows keep ordinal correspondence', () => {
  const result = parseDbf(dbfFixture({ numeric: '', deleted: true }));
  assert.equal(result.records.length, 1); assert.equal(result.records[0].deleted, true); assert.equal(result.records[0].values.width, null);
});
test('DBF invalid numeric/truncation are rejected', () => {
  assert.throws(() => parseDbf(dbfFixture({ numeric: 'abc' })), /numeric/);
  assert.throws(() => parseDbf(dbfFixture().subarray(0, 110)), /Truncated/);
});
test('SHP mixed endianness and multipart lines preserve record number', () => {
  const result = parseShp(shpFixture(3, [[[1, 2], [3, 4]], [[5, 6], [7, 8]]]));
  assert.equal(result.records[0].recordNumber, 1); assert.equal(result.records[0].geometry.type, 'MultiLineString');
  assert.deepEqual(result.records[0].geometry.coordinates[1], [[5, 6], [7, 8]]);
});
test('SHP null shapes retain record ordinal instead of shifting DBF attributes', () => {
  const b = shpFixture().subarray(0, 112);
  b.writeInt32BE(56, 24); b.writeInt32BE(2, 104); b.writeInt32LE(0, 108);
  const result = parseShp(b);
  assert.equal(result.records.length, 1); assert.equal(result.records[0].recordNumber, 1);
  assert.equal(result.records[0].geometry, null);
});
test('polygon shells, hole and island classified regardless of part order/orientation', () => {
  const result = ringsToPolygonGeometry([square(2, 2, 6), square(20, 0, 4).reverse(), square(0, 0, 10).reverse(), square(3, 3, 1)]);
  assert.equal(result.type, 'MultiPolygon'); assert.deepEqual(result.coordinates.map(p => p.length).sort(), [1, 1, 2]);
  const parsed = parseShp(shpFixture(5, [square(0, 0, 10), square(2, 2, 3)]));
  assert.equal(parsed.records[0].geometry.coordinates.length, 2);
});
test('invalid unclosed polygon and unsupported dimensions rejected', () => {
  assert.throws(() => ringsToPolygonGeometry([[[0, 0], [1, 0], [1, 1], [0, 1]]]), /Unclosed/);
  const b = shpFixture(); b.writeInt32LE(13, 32); assert.throws(() => parseShp(b), /Unsupported/);
  assert.throws(() => parseShp(shpFixture().subarray(0, 110)), /length/);
});
test('SHX offsets cross-checked with SHP', () => {
  const shp = parseShp(shpFixture()), shx = Buffer.alloc(108);
  shx.writeInt32BE(9994, 0); shx.writeInt32BE(54, 24); shx.writeInt32LE(1000, 28); shx.writeInt32LE(3, 32);
  shx.writeInt32BE(50, 100); shx.writeInt32BE(shp.records[0].contentWords, 104); validateShx(shx, shp);
  shx.writeInt32BE(51, 100); assert.throws(() => validateShx(shx, shp), /offset/);
});
test('project local coordinate conversion and polygon structure preserved', () => {
  const geometry = { type: 'Polygon', coordinates: [square(126, 37, 0.01)] };
  const result = toLocalGeometry(geometry, { origin_lon_lat: [126, 37], meters_per_degree_lon: 100, meters_per_degree_lat: 200 });
  assert.deepEqual(result.coordinates[0][0], [0, 0]); assert.ok(Math.abs(result.coordinates[0][2][1] - 2) < 1e-10);
});
test('CRS conversion rejects missing PRJ and excessive roundtrip error', () => {
  assert.throws(() => createCrsTransform('', () => {}), /PRJ/);
  const fake = () => ({ forward: () => [127, 37], inverse: () => [0, 0] });
  assert.throws(() => createCrsTransform('PROJCS["test"]', fake)([100, 100]), /roundtrip/);
});
test('13 approved 1:1000 tiles accepted with explicit IDs; order deterministic', () => {
  assert.equal(NGII_1K_TILE_IDS.length, 13);
  assert.deepEqual(validateTileIds([...NGII_1K_TILE_IDS].reverse(), [...NGII_1K_TILE_IDS]), [...NGII_1K_TILE_IDS].sort());
  assert.deepEqual(validateTileIds(['376120315'], [...NGII_1K_TILE_IDS]), ['376120315']);
});
test('implicit, duplicate, missing, unapproved and mixed-scale tile IDs rejected', () => {
  assert.throws(() => validateTileIds(undefined, []), /Explicit/);
  assert.throws(() => validateTileIds(['376120315', '376120315'], ['376120315']), /Duplicate/);
  assert.throws(() => validateTileIds(['376120315'], []), /missing/);
  assert.throws(() => validateTileIds(['37612005'], ['37612005']), /Unapproved/);
  assert.throws(() => validateTileIds(['376120315'], ['376120315', '37612005']), /mix scales/);
  assert.throws(() => validateTileIds(['../376120315'], ['../376120315']), /Unapproved/);
});
