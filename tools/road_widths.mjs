const EPSILON = 1e-9;
const WIDTH_STATUSES = new Set(['measured_estimate', 'official_actual', 'inferred_range', 'unmeasured']);
const WIDTH_KINDS = new Set(['carriageway', 'walkway']);

function validateLine(line, name = 'line') {
  if (!Array.isArray(line) || line.length < 2 || !line.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) {
    throw new Error(`${name} must contain at least two finite XY coordinates.`);
  }
}

function validateRing(ring) {
  if (!Array.isArray(ring) || !Array.isArray(ring[0]) || !Number.isFinite(ring[0][0])) {
    throw new Error('Expected a single boundary ring; polygon holes are unsupported.');
  }
  validateLine(ring, 'boundary ring');
  if (ring.length < 4 || ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) {
    throw new Error('Boundary ring must be closed and contain at least four coordinates.');
  }
}

const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1]];
const interpolate = (a, vector, t) => [a[0] + vector[0] * t, a[1] + vector[1] * t];
const samePoint = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= EPSILON;

function insideOrOnRing(point, ring) {
  let inside = false;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1];
    const b = ring[i];
    const vector = subtract(b, a);
    const relative = subtract(point, a);
    const length = Math.hypot(...vector);
    if (Math.abs(cross(vector, relative)) <= EPSILON * Math.max(length, 1) &&
        point[0] >= Math.min(a[0], b[0]) - EPSILON && point[0] <= Math.max(a[0], b[0]) + EPSILON &&
        point[1] >= Math.min(a[1], b[1]) - EPSILON && point[1] <= Math.max(a[1], b[1]) + EPSILON) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
        point[0] < vector[0] * (point[1] - a[1]) / vector[1] + a[0]) inside = !inside;
  }
  return inside;
}

/** Clip a polyline without changing its original vertices or direction. Boundary edges count as inside. */
export function clipLineToRing(line, ring) {
  validateLine(line);
  validateRing(ring);
  const parts = [];
  let current = null;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const vector = subtract(b, a);
    const lengthSquared = vector[0] ** 2 + vector[1] ** 2;
    if (lengthSquared === 0) continue;
    const cuts = [0, 1];
    for (let edge = 1; edge < ring.length; edge++) {
      const c = ring[edge - 1];
      const edgeVector = subtract(ring[edge], c);
      const relative = subtract(c, a);
      const denominator = cross(vector, edgeVector);
      if (Math.abs(denominator) > EPSILON) {
        const t = cross(relative, edgeVector) / denominator;
        const u = cross(relative, vector) / denominator;
        if (t > 0 && t < 1 && u >= -EPSILON && u <= 1 + EPSILON) cuts.push(t);
      } else if (Math.abs(cross(relative, vector)) <= EPSILON * Math.max(Math.hypot(...vector), 1)) {
        // Collinear boundary edges contribute their endpoints as interval cuts.
        for (const point of [c, ring[edge]]) {
          const offset = subtract(point, a);
          const t = (offset[0] * vector[0] + offset[1] * vector[1]) / lengthSquared;
          if (t > 0 && t < 1) cuts.push(t);
        }
      }
    }
    cuts.sort((left, right) => left - right);
    const uniqueCuts = cuts.filter((value, index) => !index || value - cuts[index - 1] > EPSILON);
    for (let interval = 1; interval < uniqueCuts.length; interval++) {
      const start = uniqueCuts[interval - 1];
      const end = uniqueCuts[interval];
      if (!insideOrOnRing(interpolate(a, vector, (start + end) / 2), ring)) {
        current = null;
        continue;
      }
      const first = start === 0 ? [...a] : interpolate(a, vector, start);
      const last = end === 1 ? [...b] : interpolate(a, vector, end);
      if (samePoint(first, last)) continue;
      if (current && samePoint(current.at(-1), first)) current.push(last);
      else {
        current = [first, last];
        parts.push(current);
      }
    }
  }
  return parts;
}

export function cumulativeLength(line) {
  validateLine(line);
  let length = 0;
  for (let i = 1; i < line.length; i++) length += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return length;
}

export function makeRoadInventory(source) {
  const boundary = source.metadata?.provisional_boundary;
  if (boundary && (boundary.type !== 'Polygon' || boundary.coordinates?.length !== 1)) {
    throw new Error('Only one Polygon boundary ring is supported; polygon holes are unsupported.');
  }
  const ring = source.metadata?.local_provisional_boundary_m;
  validateRing(ring);
  if (!Array.isArray(source.features)) throw new Error('Source features are required.');
  const seen = new Set();
  const records = [];
  for (const feature of source.features) {
    const sourceId = String(feature.id);
    if (seen.has(sourceId)) throw new Error(`Duplicate source ID: ${sourceId}`);
    seen.add(sourceId);
    const properties = feature.properties || {};
    const localGeometry = properties.local_geometry_m;
    if (!['road', 'path'].includes(properties.category) || !['LineString', 'MultiLineString'].includes(localGeometry?.type)) continue;
    const lines = localGeometry.type === 'LineString' ? [localGeometry.coordinates] : localGeometry.coordinates;
    const insideSegments = lines.flatMap(line => clipLineToRing(line, ring));
    const insideLengthM = insideSegments.reduce((sum, line) => sum + cumulativeLength(line), 0);
    if (insideLengthM <= EPSILON) continue;
    const tags = properties.osm_tags || {};
    records.push({
      sourceId, name: properties.name || '', category: properties.category,
      highway: tags.highway || null, service: tags.service || null, footway: tags.footway || null,
      layer: tags.layer ?? null, tunnel: tags.tunnel ?? null, bridge: tags.bridge ?? null,
      osmLanes: tags.lanes ?? null, osmTags: structuredClone(tags),
      WGS84geometry: structuredClone(feature.geometry), localgeometry: structuredClone(localGeometry),
      insideSegments, insideLengthM, widthStatus: 'unmeasured', widthM: null, rangeM: null
    });
  }
  return records;
}

function validateWidth(record, label) {
  if (!WIDTH_STATUSES.has(record.status)) throw new Error(`${label}: invalid width status.`);
  if (!WIDTH_KINDS.has(record.widthKind)) throw new Error(`${label}: invalid width kind.`);
  if (record.widthM != null && (!Number.isFinite(record.widthM) || record.widthM <= 0)) throw new Error(`${label}: widthM must be a positive finite number.`);
  if (record.rangeM != null && (!Array.isArray(record.rangeM) || record.rangeM.length !== 2 ||
      !record.rangeM.every(value => Number.isFinite(value) && value > 0) || record.rangeM[0] > record.rangeM[1])) {
    throw new Error(`${label}: invalid width range.`);
  }
  if (!Array.isArray(record.evidenceIds) || !record.evidenceIds.every(value => typeof value === 'string' && value.trim())) {
    throw new Error(`${label}: evidenceIds must be an array of nonempty strings.`);
  }
  if (record.status === 'unmeasured') {
    if (record.widthM != null || record.rangeM != null) throw new Error(`${label}: unmeasured width must remain null.`);
  } else {
    if (!record.evidenceIds.length) throw new Error(`${label}: measured or inferred widths require evidenceIds.`);
    if (record.status === 'inferred_range' && record.rangeM == null) throw new Error(`${label}: inferred_range requires rangeM.`);
    if (record.status !== 'inferred_range' && record.widthM == null) throw new Error(`${label}: an actual width requires widthM.`);
    if (record.widthM != null && record.rangeM != null && (record.widthM < record.rangeM[0] || record.widthM > record.rangeM[1])) {
      throw new Error(`${label}: widthM lies outside rangeM.`);
    }
  }
}

/** Attach reviewed widths to a new plan; official road classes remain separate constraints. */
export function applyRoadWidths(plan, widthData) {
  if (!Array.isArray(plan.features) || !widthData || !Array.isArray(widthData.records)) throw new Error('Plan features and width records are required.');
  const features = new Map();
  for (const feature of plan.features) {
    if (features.has(feature.id)) throw new Error(`Duplicate plan ID: ${feature.id}`);
    features.set(feature.id, feature);
  }
  const records = new Map();
  for (const record of widthData.records) {
    if (typeof record.sourceId !== 'string' || !record.sourceId) throw new Error('Width record sourceId is required.');
    if (records.has(record.sourceId)) throw new Error(`Duplicate width ID: ${record.sourceId}`);
    const feature = features.get(record.sourceId);
    if (!feature) throw new Error(`Unknown width source ID: ${record.sourceId}`);
    if (!['road', 'path'].includes(feature.category) || !['LineString', 'MultiLineString'].includes(feature.geometry?.type)) {
      throw new Error(`Width source must be a road/path line: ${record.sourceId}`);
    }
    validateWidth(record, record.sourceId);
    if (record.segments != null) {
      if (!Array.isArray(record.segments)) throw new Error(`${record.sourceId}: segments must be an array.`);
      for (const [index, segment] of record.segments.entries()) {
        validateWidth({...record, ...segment}, `${record.sourceId} segment ${index}`);
        const geometry = segment.localGeometry || segment.geometry;
        if (geometry?.type !== 'LineString') throw new Error(`${record.sourceId}: segment requires a local LineString geometry.`);
        validateLine(geometry.coordinates, `${record.sourceId} segment ${index}`);
      }
    }
    records.set(record.sourceId, record);
  }
  const result = structuredClone(plan);
  const statusCounts = Object.fromEntries([...WIDTH_STATUSES].map(status => [status, 0]));
  for (const feature of result.features) {
    const record = records.get(feature.id);
    if (!record) continue;
    feature.roadWidthM = record.widthM ?? null;
    feature.roadWidthStatus = record.status;
    feature.roadWidthKind = record.widthKind;
    feature.roadWidthRangeM = record.rangeM == null ? null : [...record.rangeM];
    feature.evidenceIds = [...record.evidenceIds];
    feature.roadWidthEvidenceIds = [...record.evidenceIds];
    if (record.officialReferenceIds != null) feature.roadWidthOfficialReferenceIds = structuredClone(record.officialReferenceIds);
    if (record.mapRepresentationEvidenceIds != null) feature.roadWidthMapRepresentationEvidenceIds = structuredClone(record.mapRepresentationEvidenceIds);
    if (record.officialAssociationStatus != null) feature.roadWidthOfficialAssociationStatus = record.officialAssociationStatus;
    if (record.segments != null) feature.roadWidthSegments = structuredClone(record.segments);
    statusCounts[record.status]++;
  }
  result.metadata = {...result.metadata, roadWidths: {
    recordCount: records.size, explicitWidthCount: [...records.values()].filter(record => record.widthM != null).length,
    statusCounts, officialRoadClass: structuredClone(widthData.officialRoadClass ?? []),
    officialReferences: structuredClone(widthData.officialReferences ?? []),
    mapRepresentationReferences: structuredClone(widthData.mapRepresentationReferences ?? []),
    measurementStatus: widthData.measurementStatus ?? null,
    note: 'Widths describe only supplied evidence. Official road classes are planning constraints, not actual carriageway measurements.'
  }};
  return result;
}
