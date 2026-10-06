import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// ESRI Shapefile Technical Description: mixed-endian headers and record offsets.
// Only the 2D PolyLine/Polygon types found in these NGII downloads are accepted.
function check(condition, message) { if (!condition) throw new Error(message); }
function bytes(buffer, offset, length, label) {
  check(Number.isInteger(offset) && offset >= 0 && length >= 0 && offset + length <= buffer.length,
    `Truncated ${label}`);
}
export function parseShp(buffer) {
  bytes(buffer, 0, 100, 'SHP header');
  check(buffer.readInt32BE(0) === 9994 && buffer.readInt32LE(28) === 1000, 'Invalid SHP header');
  check(buffer.readInt32BE(24) * 2 === buffer.length, 'SHP declared length mismatch');
  const shapeType = buffer.readInt32LE(32);
  check([3, 5].includes(shapeType), `Unsupported SHP shape type ${shapeType}; no silent Z/M loss`);
  const records = [];
  let offset = 100;
  while (offset < buffer.length) {
    bytes(buffer, offset, 8, 'SHP record header');
    const recordNumber = buffer.readInt32BE(offset);
    const contentBytes = buffer.readInt32BE(offset + 4) * 2;
    const start = offset + 8;
    bytes(buffer, start, contentBytes, 'SHP record');
    check(contentBytes >= 4 && recordNumber === records.length + 1, 'Invalid SHP record numbering/length');
    const type = buffer.readInt32LE(start);
    const record = { recordNumber, offsetWords: offset / 2, contentWords: contentBytes / 2, shapeType: type, geometry: null };
    if (type !== 0) {
      check(type === shapeType, 'Mixed SHP shape types');
      check(contentBytes >= 44, 'Truncated SHP parts header');
      const partCount = buffer.readInt32LE(start + 36);
      const pointCount = buffer.readInt32LE(start + 40);
      check(partCount > 0 && pointCount > 0 && 44 + partCount * 4 + pointCount * 16 === contentBytes,
        'Invalid SHP part/point counts or unexpected trailing dimensions');
      const starts = Array.from({ length: partCount }, (_, i) => buffer.readInt32LE(start + 44 + i * 4));
      check(starts[0] === 0 && starts.every((v, i) => v >= 0 && v < pointCount && (i === 0 || v > starts[i - 1])),
        'Invalid SHP part offsets');
      const pointsOffset = start + 44 + partCount * 4;
      const points = Array.from({ length: pointCount }, (_, i) => {
        const point = [buffer.readDoubleLE(pointsOffset + i * 16), buffer.readDoubleLE(pointsOffset + i * 16 + 8)];
        check(point.every(Number.isFinite), 'Non-finite SHP coordinate');
        return point;
      });
      const parts = starts.map((v, i) => points.slice(v, starts[i + 1] ?? pointCount));
      if (type === 3) {
        check(parts.every(p => p.length >= 2), 'Invalid PolyLine part');
        record.geometry = parts.length === 1 ? { type: 'LineString', coordinates: parts[0] }
          : { type: 'MultiLineString', coordinates: parts };
      } else record.geometry = ringsToPolygonGeometry(parts);
    } else check(contentBytes === 4, 'Invalid null-shape length');
    records.push(record);
    offset = start + contentBytes;
  }
  return { shapeType, records };
}

function ringArea(ring) {
  let sum = 0;
  // Translate to reduce cancellation for native coordinates around 200000/540000.
  const [ox, oy] = ring[0];
  for (let i = 1; i < ring.length; i++) {
    sum += (ring[i - 1][0] - ox) * (ring[i][1] - oy) - (ring[i][0] - ox) * (ring[i - 1][1] - oy);
  }
  return sum / 2;
}
function inRing(point, ring) {
  let inside = false;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i];
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
        point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
export function ringsToPolygonGeometry(rings) {
  const areas = rings.map(ring => {
    check(ring.length >= 4 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1], 'Unclosed SHP polygon ring');
    const area = ringArea(ring);
    check(area !== 0, 'Degenerate SHP polygon ring');
    return area;
  });
  // Containment, not input order/orientation, distinguishes holes and separate shells.
  const parents = rings.map((ring, i) => {
    const candidates = rings.map((other, j) => j).filter(j => j !== i && Math.abs(areas[j]) > Math.abs(areas[i]) && inRing(ring[0], rings[j]));
    return candidates.sort((a, b) => Math.abs(areas[a]) - Math.abs(areas[b]))[0] ?? -1;
  });
  const depth = i => parents[i] < 0 ? 0 : 1 + depth(parents[i]);
  const depths = rings.map((_, i) => depth(i));
  const orient = (ring, i, shell) => (areas[i] > 0) === shell ? ring : [...ring].reverse();
  const polygons = rings.flatMap((ring, i) => depths[i] % 2 !== 0 ? [] : [[
    orient(ring, i, true),
    ...rings.flatMap((hole, j) => parents[j] === i && depths[j] % 2 === 1 ? [orient(hole, j, false)] : []),
  ]]);
  return polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons };
}

export function parseDbf(buffer, encoding = 'euc-kr') {
  bytes(buffer, 0, 33, 'DBF header');
  const decoder = new TextDecoder(encoding, { fatal: true });
  const count = buffer.readUInt32LE(4), headerLength = buffer.readUInt16LE(8), recordLength = buffer.readUInt16LE(10);
  check(headerLength >= 33 && (headerLength - 33) % 32 === 0, 'Invalid DBF header length');
  bytes(buffer, 0, headerLength + count * recordLength, 'DBF records');
  check(buffer[headerLength - 1] === 13, 'Missing DBF field terminator');
  const fields = [];
  for (let offset = 32; offset < headerLength - 1; offset += 32) {
    const raw = buffer.subarray(offset, offset + 11), end = raw.indexOf(0);
    const name = decoder.decode(end < 0 ? raw : raw.subarray(0, end));
    const type = String.fromCharCode(buffer[offset + 11]), length = buffer[offset + 16], decimals = buffer[offset + 17];
    check(name && length > 0 && ['C', 'N', 'F', 'L', 'D'].includes(type), `Unsupported DBF field ${name}/${type}`);
    check(!fields.some(f => f.name === name), 'Duplicate DBF field name');
    fields.push({ name, type, length, decimals });
  }
  check(1 + fields.reduce((n, f) => n + f.length, 0) === recordLength, 'DBF record length mismatch');
  const records = Array.from({ length: count }, (_, index) => {
    let offset = headerLength + index * recordLength;
    check([32, 42].includes(buffer[offset]), 'Invalid DBF deletion flag');
    const deleted = buffer[offset++] === 42, values = {};
    for (const field of fields) {
      const value = decoder.decode(buffer.subarray(offset, offset + field.length)).replaceAll('\0', '').trim();
      offset += field.length;
      if (!value || (field.type === 'L' && value === '?')) values[field.name] = null;
      else if (['N', 'F'].includes(field.type)) {
        check(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value), `Invalid numeric DBF value in ${field.name}`);
        values[field.name] = Number(value);
        check(Number.isFinite(values[field.name]), 'Non-finite DBF number');
      } else if (field.type === 'L') {
        check(/^[YNTF]$/i.test(value), 'Invalid logical DBF value');
        values[field.name] = /^[YT]$/i.test(value);
      } else values[field.name] = value;
    }
    return { deleted, values };
  });
  return { fields, records, encoding: decoder.encoding, languageDriverId: buffer[29] };
}

export function validateShx(buffer, shp) {
  bytes(buffer, 0, 100, 'SHX header');
  check(buffer.readInt32BE(0) === 9994 && buffer.readInt32LE(28) === 1000 && buffer.readInt32LE(32) === shp.shapeType,
    'Invalid SHX header');
  check(buffer.readInt32BE(24) * 2 === buffer.length && buffer.length === 100 + shp.records.length * 8, 'SHX count/length mismatch');
  shp.records.forEach((r, i) => check(buffer.readInt32BE(100 + i * 8) === r.offsetWords &&
    buffer.readInt32BE(104 + i * 8) === r.contentWords, 'SHX/SHP record offset mismatch'));
}
export function mapGeometry(geometry, transform) {
  if (!geometry) return null;
  const map = coordinates => typeof coordinates[0] === 'number' ? transform(coordinates) : coordinates.map(map);
  return { type: geometry.type, coordinates: map(geometry.coordinates) };
}
export function toLocalGeometry(geometry, coordinateSystem) {
  const [lon, lat] = coordinateSystem.origin_lon_lat;
  return mapGeometry(geometry, p => [(p[0] - lon) * coordinateSystem.meters_per_degree_lon,
    (p[1] - lat) * coordinateSystem.meters_per_degree_lat]);
}
export function createCrsTransform(prj, proj4) {
  check(typeof prj === 'string' && /^PROJCS\[/.test(prj.trim()), 'Missing projected PRJ WKT');
  const converter = proj4(prj, 'WGS84');
  return point => {
    const result = converter.forward(point);
    check(result.length === 2 && result.every(Number.isFinite) && Math.abs(result[0]) <= 180 && Math.abs(result[1]) <= 90,
      'Invalid projected-to-WGS84 conversion');
    const back = converter.inverse(result);
    check(Math.hypot(back[0] - point[0], back[1] - point[1]) < 0.01, 'CRS roundtrip error exceeds 1 cm');
    return result;
  };
}
export function geometryBbox(geometry) {
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  mapGeometry(geometry, p => { bbox[0] = Math.min(bbox[0], p[0]); bbox[1] = Math.min(bbox[1], p[1]);
    bbox[2] = Math.max(bbox[2], p[0]); bbox[3] = Math.max(bbox[3], p[1]); return p; });
  return bbox;
}
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const LAYERS = {
  N1A_A0010000: 'road_corridor', N1A_A0033320: 'walkway',
  N1L_A0010000: 'road_boundary', N1L_A0020000: 'road_centerline',
};
export const NGII_1K_TILE_IDS = Object.freeze([
  '376082396', '376082397', '376120304', '376120305', '376120306', '376120307',
  '376120314', '376120315', '376120316', '376120317', '376120325', '376120326', '376120327',
]);
export function validateTileIds(tileIds, availableDirectories) {
  check(Array.isArray(tileIds) && tileIds.length > 0 && tileIds.every(id => typeof id === 'string'), 'Explicit input tile IDs are required');
  check(new Set(tileIds).size === tileIds.length, 'Duplicate input tile ID');
  check(tileIds.every(id => NGII_1K_TILE_IDS.includes(id)), 'Unapproved tile ID; only the 13 approved 1:1000 tiles are allowed');
  check(tileIds.every(id => availableDirectories.includes(id)), 'Requested tile directory is missing');
  check(availableDirectories.every(id => NGII_1K_TILE_IDS.includes(id)), 'Unapproved directory in 1:1000 input; do not mix scales');
  return [...tileIds].sort();
}
export function readLayer(directory, layer, { tile, proj4, coordinateSystem, bbox }) {
  check(Object.hasOwn(LAYERS, layer), 'Unapproved NGII layer');
  const read = extension => fs.readFileSync(path.join(directory, `${layer}.${extension}`));
  const shpBuffer = read('shp'), dbfBuffer = read('dbf'), prjBuffer = read('prj'), shxBuffer = read('shx');
  const shp = parseShp(shpBuffer), prj = prjBuffer.toString('utf8').trim();
  check(shp.shapeType === (layer.startsWith('N1A_') ? 5 : 3), 'NGII layer geometry type mismatch');
  validateShx(shxBuffer, shp);
  const cpgPath = path.join(directory, `${layer}.cpg`);
  let encoding = 'euc-kr';
  if (fs.existsSync(cpgPath)) {
    const cpg = fs.readFileSync(cpgPath, 'utf8').trim().toLowerCase();
    encoding = ['949', 'cp949', 'ms949', 'ansi 949'].includes(cpg) ? 'euc-kr' : cpg === '65001' ? 'utf-8' : cpg;
  }
  const dbf = parseDbf(dbfBuffer, encoding);
  check(dbf.fields.some(f => f.name === 'UFID' && f.type === 'C'), 'Missing NGII UFID field');
  const widthFieldName = layer === 'N1L_A0020000' ? '도로폭' : layer === 'N1A_A0033320' ? '폭' : null;
  check(!widthFieldName || dbf.fields.some(f => f.name === widthFieldName && f.type === 'N'), 'Missing NGII numeric width field');
  check(shp.records.length === dbf.records.length, 'SHP/DBF record count mismatch');
  const transform = createCrsTransform(prj, proj4), features = [];
  let deleted = 0, nullShapes = 0, outsideBbox = 0;
  shp.records.forEach((record, i) => {
    const attributes = dbf.records[i].values;
    if (dbf.records[i].deleted) { deleted++; return; }
    check(typeof attributes.UFID === 'string' && attributes.UFID.includes(tile), 'Missing UFID or UFID/tile mismatch');
    if (!record.geometry) { nullShapes++; return; }
    const geometry = mapGeometry(record.geometry, transform);
    if (!overlaps(geometryBbox(geometry), bbox)) { outsideBbox++; return; }
    const id = `ngii/${tile}/${layer}/${record.recordNumber}`;
    const width = layer === 'N1L_A0020000' ? attributes['도로폭'] : layer === 'N1A_A0033320' ? attributes['폭'] : null;
    features.push({ type: 'Feature', id, properties: {
      layer, surfaceKind: LAYERS[layer], tile, recordNumber: record.recordNumber,
      evidenceId: id, ufid: attributes.UFID ?? null, sourceYear: 2025,
      attributes, officialWidthM: Number.isFinite(width) && width > 0 ? width : null,
      officialWidthKind: layer === 'N1L_A0020000' ? 'road_outer_curb_or_shoulder' : layer === 'N1A_A0033320' ? 'walkway' : null,
      local_geometry_m: toLocalGeometry(geometry, coordinateSystem), native_geometry_m: record.geometry,
    }, geometry });
  });
  return { features, audit: { tile, layer, surfaceKind: LAYERS[layer], shapeType: shp.shapeType,
    inputRecords: shp.records.length, retainedRecords: features.length, deleted, nullShapes, outsideBbox,
    dbfFields: dbf.fields, dbfEncoding: dbf.encoding, encodingBasis: fs.existsSync(cpgPath) ? 'CPG' : 'No CPG; CP949 fallback; Korean field names and values decoded without replacement',
    dbfLanguageDriverId: dbf.languageDriverId, prjWkt: prj,
    sha256: { shp: hash(shpBuffer), dbf: hash(dbfBuffer), shx: hash(shxBuffer), prj: hash(prjBuffer) } } };
}
export function importNgii({ inputDirectory, proj4Path, planPath, tileIds, bbox = [126.867, 37.4845, 126.882, 37.501] }) {
  check(bbox.length === 4 && bbox.every(Number.isFinite) && bbox[0] < bbox[2] && bbox[1] < bbox[3], 'Invalid import bbox');
  const require = createRequire(import.meta.url), proj4 = require(path.resolve(proj4Path));
  const sourcePlanBuffer = fs.readFileSync(planPath);
  const coordinateSystem = JSON.parse(sourcePlanBuffer.toString('utf8')).metadata.coordinate_system;
  check(coordinateSystem && coordinateSystem.origin_lon_lat.length === 2 && coordinateSystem.origin_lon_lat.every(Number.isFinite) &&
    coordinateSystem.meters_per_degree_lon > 0 && coordinateSystem.meters_per_degree_lat > 0, 'Invalid project local coordinate system');
  const directories = fs.readdirSync(inputDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const tiles = validateTileIds(tileIds, directories);
  const features = [], audit = [];
  for (const tile of tiles) for (const layer of Object.keys(LAYERS)) {
    const result = readLayer(path.join(inputDirectory, tile), layer, { tile, proj4, coordinateSystem, bbox });
    features.push(...result.features); audit.push(result.audit);
  }
  check(new Set(features.map(f => f.id)).size === features.length, 'Duplicate NGII feature IDs');
  return { type: 'FeatureCollection', name: 'NGII 1:1000 Guro1 road and walkway reference', metadata: {
    schema: 'korea2050.ngii-road-reference.v1', source: 'NGII 국토정보플랫폼 user-authorized download',
    sourceURL: 'https://map.ngii.go.kr/', sourceYear: 2025, measurementDate: null,
    scale: '1:1000', sourceTiles: tiles, sourceTileCount: tiles.length, sourceSha256: hash(sourcePlanBuffer),
    coverageStatus: tiles.length === NGII_1K_TILE_IDS.length ? 'All 13 requested boundary tiles acquired; individual road widths are not yet fully verified' : 'Explicit subset of approved 1:1000 tiles; individual road widths are not yet fully verified',
    geometryCRS: 'WGS84 longitude latitude', nativeCRS: 'Actual per-layer PRJ WKT in audit',
    localCoordinateSystem: coordinateSystem, filterBboxWgs84: bbox,
    filtering: 'Bounding-box intersection; original geometry retained, not clipped; tile seams not merged',
    restrictions: 'Local reference only. Redistribution/licensing and overseas transfer restrictions not yet reviewed; do not publish/push original GIS or this derivative.',
    widthSemantics: 'A001 is a mapped road boundary surface; isolated carriageway and included components are not verified. A000 carriageway polygons are absent. A002 road width follows official outer-curb/shoulder definition, not assumed bidirectional carriageway; minor-road 0.5m is a symbolic value, not actual width. A0033320 is a mapped sidewalk, not verified obstacle-free walking width. Blank/zero values are not invented; do not propagate one record across an entire named road.',
    proj4Version: proj4.version, audit,
  }, features };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = Object.fromEntries(process.argv.slice(2).map((arg, i, list) => arg.startsWith('--') ? [arg.slice(2), list[i + 1]] : null).filter(Boolean));
  check(args.input && args.proj4 && args.plan && args.output && args.tiles, 'Usage: node tools/read_ngii_shp.mjs --input <extracted tile directory> --tiles <comma-separated approved tile IDs> --proj4 <existing public-proj4.js> --plan <plan.geojson> --output <reference.geojson> [--overwrite true]');
  check(args.overwrite === undefined || ['true', 'false'].includes(args.overwrite), 'Overwrite must explicitly be true or false');
  const collection = importNgii({ inputDirectory: path.resolve(args.input), tileIds: args.tiles.split(','), proj4Path: path.resolve(args.proj4), planPath: path.resolve(args.plan) });
  fs.writeFileSync(path.resolve(args.output), JSON.stringify(collection), { flag: args.overwrite === 'true' ? 'w' : 'wx' });
  console.log(JSON.stringify({ output: path.resolve(args.output), featureCount: collection.features.length,
    layers: collection.metadata.audit.map(a => ({ tile: a.tile, layer: a.layer, input: a.inputRecords, retained: a.retainedRecords })) }, null, 2));
}
