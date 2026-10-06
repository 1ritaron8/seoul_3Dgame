import {clipLineToRing, cumulativeLength} from './road_widths.mjs';
import {crossSectionIntervals} from './measure_road_sections.mjs';

// This tolerance checks rounded coordinate consistency, not mapping accuracy.
const COORDINATE_TOLERANCE_M = 0.002;
const RANGE_STATUS = 'observed_sample_variation_not_accuracy';
const REVIEWED = 'curb_layout_visually_reviewed';
const CLASSIFICATION = 'curb_mapping_estimate_after_visual_layout_review';
const HASH = /^[a-f0-9]{64}$/;
const point = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const at = (origin, direction, value) => origin.map((coordinate, i) => coordinate + direction[i] * value);
const check = (condition, message) => { if (!condition) throw new Error(message); };
const close = (actual, expected, message) => check(Number.isFinite(actual) && Math.abs(actual - expected) <= COORDINATE_TOLERANCE_M, message);
const closePoint = (actual, expected, message) => check(point(actual) && distance(actual, expected) <= COORDINATE_TOLERANCE_M, message);
const parts = geometry => geometry?.type === 'LineString' ? [geometry.coordinates] : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
const round = value => Number(value.toFixed(4));

/** GRS80 transverse Mercator, Korea 2000 Central Belt 2010 (EPSG:5186).
 * Restricted to the existing Seoul reference area; no survey accuracy implied.
 */
export function projectProfilePointToNative(pointWgs84) {
  check(point(pointWgs84) && Math.abs(pointWgs84[0] - 127) < 1 && Math.abs(pointWgs84[1] - 38) < 1, 'Profile projection requires a WGS84 point in the existing Seoul reference area.');
  const radians = Math.PI / 180;
  const a = 6378137, flattening = 1 / 298.257222101;
  const e2 = flattening * (2 - flattening), ep2 = e2 / (1 - e2);
  const meridian = latitude => a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * latitude
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * latitude)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * latitude)
    - 35 * e2 ** 3 / 3072 * Math.sin(6 * latitude));
  const latitude = pointWgs84[1] * radians, longitudeOffset = (pointWgs84[0] - 127) * radians;
  const cosine = Math.cos(latitude), tangent = Math.tan(latitude);
  const n = a / Math.sqrt(1 - e2 * Math.sin(latitude) ** 2);
  const t = tangent ** 2, c = ep2 * cosine ** 2, A = cosine * longitudeOffset;
  return [200000 + n * (A + (1 - t + c) * A ** 3 / 6 + (5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * A ** 5 / 120),
    600000 + meridian(latitude) - meridian(38 * radians) + n * tangent * (A ** 2 / 2 + (5 - t + 9 * c + 4 * c ** 2) * A ** 4 / 24 + (61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * A ** 6 / 720)];
}

function toLocal(pointWgs84, coordinateSystem) {
  const [longitude, latitude] = coordinateSystem.origin_lon_lat;
  return [(pointWgs84[0] - longitude) * coordinateSystem.meters_per_degree_lon, (pointWgs84[1] - latitude) * coordinateSystem.meters_per_degree_lat];
}

function validatePosition(position, coordinateSystem, label) {
  check(position && point(position.native_epsg5186_m) && point(position.wgs84_lon_lat) && point(position.local_plan_m), `${label}: finite native/WGS84/local coordinates are required.`);
  closePoint(position.native_epsg5186_m, projectProfilePointToNative(position.wgs84_lon_lat), `${label}: native/WGS84 position mismatch.`);
  closePoint(position.local_plan_m, toLocal(position.wgs84_lon_lat, coordinateSystem), `${label}: local/WGS84 position mismatch.`);
}

function withinBoundary(line, boundary, label) {
  const clipped = clipLineToRing(line, boundary);
  const clippedLength = clipped.reduce((total, part) => total + cumulativeLength(part), 0);
  check(Math.abs(clippedLength - cumulativeLength(line)) < 0.00001, `${label}: geometry extends outside the approved boundary.`);
}

function validateSpan(span, sample, normal, coordinateSystem, label) {
  const interval = span?.signed_normal_interval_m;
  check(point(interval) && interval[1] > interval[0] && Number.isFinite(span.span_m) && span.span_m > 0, `${label}: nonzero finite ordered span is required.`);
  close(span.span_m, interval[1] - interval[0], `${label}: interval/span mismatch.`);
  check(Array.isArray(span.endpoints) && span.endpoints.length === 2, `${label}: two endpoints are required.`);
  span.endpoints.forEach((endpoint, i) => {
    validatePosition(endpoint, coordinateSystem, `${label} endpoint ${i}`);
    closePoint(endpoint.native_epsg5186_m, at(sample, normal, interval[i]), `${label}: endpoint does not match native normal interval.`);
  });
  close(distance(...span.endpoints.map(endpoint => endpoint.native_epsg5186_m)), span.span_m, `${label}: native endpoint width mismatch.`);
}

function validateMappedSpan(span, kind, sample, tangent, surfacesById, label) {
  const feature = surfacesById.get(span.ngii_polygon_id);
  check(feature?.properties.surfaceKind === kind, `${label}: missing or semantically wrong polygon evidence.`);
  check(['Polygon', 'MultiPolygon'].includes(feature.properties.native_geometry_m?.type), `${label}: native polygon geometry is required.`);
  const nativeGeometry = feature.properties.native_geometry_m;
  check(nativeGeometry.coordinates.flat(nativeGeometry.type === 'Polygon' ? 1 : 2).every(point), `${label}: polygon contains nonfinite native geometry.`);
  const intervals = crossSectionIntervals(sample, tangent, feature.properties.native_geometry_m, 80);
  check(intervals.some(interval => interval.every((value, i) => Math.abs(value - span.signed_normal_interval_m[i]) <= COORDINATE_TOLERANCE_M)), `${label}: supplied span differs from the referenced native polygon.`);
}

function nativeToLocal(native, seedWgs84, coordinateSystem) {
  let wgs = [...seedWgs84];
  for (let iteration = 0; iteration < 6; iteration++) {
    const projected = projectProfilePointToNative(wgs), offset = subtract(native, projected);
    if (Math.hypot(...offset) < 0.000001) return toLocal(wgs, coordinateSystem);
    const step = 1e-6;
    const lon = subtract(projectProfilePointToNative([wgs[0] + step, wgs[1]]), projected).map(value => value / step);
    const lat = subtract(projectProfilePointToNative([wgs[0], wgs[1] + step]), projected).map(value => value / step);
    const determinant = lon[0] * lat[1] - lat[0] * lon[1];
    check(Number.isFinite(determinant) && Math.abs(determinant) > 1, 'Cannot invert the native profile coordinate.');
    wgs = [wgs[0] + (offset[0] * lat[1] - lat[0] * offset[1]) / determinant,
      wgs[1] + (lon[0] * offset[1] - offset[0] * lon[1]) / determinant];
  }
  throw new Error('Native profile coordinate inversion did not converge.');
}

function endpointCheck(native, alongM, first, tangent, surfacesById, coordinateSystem, boundary, label) {
  const normal = [-tangent[1], tangent[0]], intervals = {};
  for (const kind of ['road_boundary', 'left_sidewalk', 'right_sidewalk']) {
    const geometry = surfacesById.get(first[kind].ngii_polygon_id).properties.native_geometry_m;
    const cuts = crossSectionIntervals(native, tangent, geometry, 80);
    if (kind !== 'road_boundary') check(!cuts.some(interval => interval[0] <= 0 && interval[1] >= 0), `${label}: endpoint sidewalk polygon contains the original centerline.`);
    const eligible = cuts.filter(interval => kind === 'road_boundary' ? interval[0] < 0 && interval[1] > 0
      : kind === 'left_sidewalk' ? interval[0] > 0 : interval[1] < 0);
    check(eligible.length > 0 && (kind !== 'road_boundary' || eligible.length === 1), `${label}: same polygon lacks a continuous ${kind} endpoint span.`);
    eligible.sort((a, b) => kind === 'right_sidewalk' ? b[1] - a[1] : a[0] - b[0]);
    intervals[kind] = eligible[0];
  }
  const road = intervals.road_boundary, left = intervals.left_sidewalk, right = intervals.right_sidewalk;
  check(road[1] - road[0] > 0 && road[1] - road[0] <= 45, `${label}: road endpoint span exceeds the candidate scope.`);
  for (const [side, interval] of [['left', left], ['right', right]]) {
    const width = interval[1] - interval[0];
    const overlap = Math.max(0, Math.min(interval[1], road[1]) - Math.max(interval[0], road[0]));
    const outerGap = side === 'left' ? road[1] - interval[1] : interval[0] - road[0];
    check(Number.isFinite(width) && width >= 0.7 && width <= 12 && overlap / width >= 0.85 && Math.abs(outerGap) <= 1.5, `${label}: paired endpoint sidewalk fails the 85% inclusion or outer-gap scope.`);
  }
  intervals.residual_interval = [right[1], left[0]];
  check(intervals.residual_interval[1] > intervals.residual_interval[0] && right[1] >= road[0] && left[0] <= road[1], `${label}: endpoint residual exceeds the mapped road or has invalid left/right semantics.`);
  const line = interval => interval.map(offset => nativeToLocal(at(native, normal, offset), first.samplepoint.wgs84_lon_lat, coordinateSystem));
  const lines = Object.fromEntries(Object.entries(intervals).map(([kind, interval]) => [kind, line(interval)]));
  for (const [kind, coordinates] of Object.entries(lines)) withinBoundary(coordinates, boundary, `${label} ${kind}`);
  return {alongOriginalSegmentM: alongM, pointNativeM: [...native], pointLocalM: nativeToLocal(native, first.samplepoint.wgs84_lon_lat, coordinateSystem),
    spans: Object.fromEntries(Object.entries(intervals).map(([kind, interval]) => [kind, {span_m: interval[1] - interval[0], signed_normal_interval_m: [...interval]}])),
    roadBoundaryLineLocalM: lines.road_boundary, leftWalkwayLineLocalM: lines.left_sidewalk, rightWalkwayLineLocalM: lines.right_sidewalk,
    candidateResidualLineLocalM: lines.residual_interval};
}

function validateReview(review, section, id, expectedHashes) {
  if (!review) return;
  check(review.id === id && review.sourceId === section.sourceId && review.originalPartIndex === section.partIndex && review.originalSegmentIndex === section.segmentIndex &&
    review.startAlongSegmentM === section.startM && review.endAlongSegmentM === section.endM, `${id}: review scope differs from the candidate interval.`);
  check([REVIEWED, 'pending'].includes(review.status), `${id}: unsupported review status.`);
  if (review.status !== REVIEWED) return;
  const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  check(validDay(review.observedOn), `${id}: review observation date is required.`);
  check(review.imageryDate === null || (typeof review.imageryDate === 'string' && (validDay(review.imageryDate) || /^\d{4}-(?:0[1-9]|1[0-2])$/.test(review.imageryDate))), `${id}: imagery date must be explicitly known or null.`);
  let url;
  try { url = new URL(review.sourceUrl); } catch { throw new Error(`${id}: review source URL is required.`); }
  check(['http:', 'https:'].includes(url.protocol), `${id}: review source URL must use HTTP(S).`);
  check(Array.isArray(review.observations) && review.observations.length > 0 && review.observations.every(observation => typeof observation === 'string' && observation.trim()), `${id}: visual layout observations are required.`);
  check(Array.isArray(review.images) && review.images.length > 0, `${id}: verified visual evidence is required.`);
  const seen = new Set();
  for (const image of review.images) {
    check(typeof image.path === 'string' && image.path.trim() && !seen.has(image.path) && HASH.test(image.sha256), `${id}: invalid or duplicate image evidence.`);
    seen.add(image.path);
    check(Object.hasOwn(expectedHashes.verifiedImageHashes || {}, image.path) && expectedHashes.verifiedImageHashes[image.path] === image.sha256, `${id}: image hash was not verified by the caller.`);
  }
}

function segmentDistance(a, b, c, d) {
  const ab = subtract(b, a), cd = subtract(d, c), ca = subtract(c, a), denominator = cross(ab, cd);
  if (Math.abs(denominator) > 1e-10) {
    const t = cross(ca, cd) / denominator, u = cross(ca, ab) / denominator;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  const pointDistance = (p, start, end) => {
    const direction = subtract(end, start), lengthSquared = dot(direction, direction);
    const fraction = lengthSquared ? Math.max(0, Math.min(1, dot(subtract(p, start), direction) / lengthSquared)) : 0;
    return distance(p, at(start, direction, fraction));
  };
  return Math.min(pointDistance(a, c, d), pointDistance(b, c, d), pointDistance(c, a, b), pointDistance(d, a, b));
}

// Short scopes must not evade a hidden notch or seam between their two display
// samples. Recompute native geometry, including holes and nearby other surfaces;
// an incoming scratch audit/pass flag is not trusted as verification.
function auditShortSection(startM, endM, origin, tangent, first, surfacesById, source, coordinateSystem, boundary, id) {
  const normal = [-tangent[1], tangent[0]], events = new Set(), nearby = [];
  for (const feature of surfacesById.values()) {
    if (!['road_corridor', 'walkway'].includes(feature.properties.surfaceKind)) continue;
    const geometry = feature.properties.native_geometry_m;
    check(['Polygon', 'MultiPolygon'].includes(geometry?.type), `${id}: native audit requires polygon geometry.`);
    const rings = geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat(1);
    const projected = rings.map(ring => ring.map(vertex => {
      check(point(vertex), `${id}: native audit encountered a nonfinite polygon vertex.`);
      const delta = subtract(vertex, origin);
      return [dot(delta, tangent), dot(delta, normal)];
    }));
    const vertices = projected.flat();
    const along = vertices.map(vertex => vertex[0]), offsets = vertices.map(vertex => vertex[1]);
    if (Math.max(...along) < startM || Math.min(...along) > endM || Math.max(...offsets) < -80 || Math.min(...offsets) > 80) continue;
    nearby.push(feature);
    const addEvent = value => { if (value > startM && value < endM) events.add(value); };
    for (const ring of projected) {
      for (const vertex of ring) if (Math.abs(vertex[1]) <= 80) addEvent(vertex[0]);
      for (let index = 1; index < ring.length; index++) {
        const a = ring[index - 1], b = ring[index];
        if (a[1] * b[1] < 0) addEvent(a[0] + (b[0] - a[0]) * (-a[1]) / (b[1] - a[1]));
      }
    }
  }
  const stations = new Set([startM, endM]);
  for (let step = 1; step < 100; step++) stations.add(startM + step * 0.05);
  for (const event of events) for (const offset of [-1e-6, 0, 1e-6]) {
    const station = event + offset;
    if (station > startM && station < endM) stations.add(station);
  }
  const topology = [startM, ...events, endM].sort((a, b) => a - b);
  for (let index = 1; index < topology.length; index++) stations.add((topology[index - 1] + topology[index]) / 2);
  const checks = [...stations].sort((a, b) => a - b).map(alongM => {
    const native = at(origin, tangent, alongM), label = `${id} native interior audit at ${alongM}m`;
    const result = endpointCheck(native, alongM, first, tangent, surfacesById, coordinateSystem, boundary, label);
    const cuts = nearby.flatMap(feature => crossSectionIntervals(native, tangent, feature.properties.native_geometry_m, 80).map(interval => ({feature, interval})));
    const centralRoads = cuts.filter(cut => cut.feature.properties.surfaceKind === 'road_corridor' && cut.interval[0] < 0 && cut.interval[1] > 0);
    check(centralRoads.length === 1 && centralRoads[0].feature.id === first.road_boundary.ngii_polygon_id, `${label}: multiple or missing A001 centerline surfaces.`);
    const road = result.spans.road_boundary.signed_normal_interval_m;
    const overlap = (a, b) => Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
    for (const cut of cuts) {
      const kind = cut.feature.properties.surfaceKind, interval = cut.interval;
      if (kind === 'road_corridor' && cut.feature.id !== first.road_boundary.ngii_polygon_id) {
        check(!(overlap(interval, road) > 0.2 || Math.abs(interval[0] - road[1]) < 0.2 || Math.abs(interval[1] - road[0]) < 0.2), `${label}: another A001 surface intersects or abuts the selected span.`);
      }
      if (kind !== 'walkway' || overlap(interval, road) <= 0.1) continue;
      check(!(interval[0] <= 0 && interval[1] >= 0), `${label}: A003 sidewalk contains the original centerline.`);
      for (const side of ['left_sidewalk', 'right_sidewalk']) if (cut.feature.id !== first[side].ngii_polygon_id) {
        check(overlap(interval, result.spans[side].signed_normal_interval_m) <= 0.2, `${label}: overlapping or seamed A003 sidewalk surfaces.`);
      }
      if (![first.left_sidewalk.ngii_polygon_id, first.right_sidewalk.ngii_polygon_id].includes(cut.feature.id)) {
        check(overlap(interval, result.spans.residual_interval.signed_normal_interval_m) <= 0.1, `${label}: another A003 surface intersects the candidate vehicle space.`);
      }
    }
    return result;
  });
  const boundedStart = at(origin, tangent, startM), boundedEnd = at(origin, tangent, endM);
  let clearanceM = Infinity;
  for (const feature of source.features) {
    if (String(feature.id) === first.original_road_id || feature.properties.category !== 'road') continue;
    for (const line of parts(feature.geometry)) for (let index = 1; index < line.length; index++) {
      const a = projectProfilePointToNative(line[index - 1]), b = projectProfilePointToNative(line[index]), length = distance(a, b);
      if (!length) continue;
      const direction = subtract(b, a).map(value => value / length);
      if (Math.abs(dot(direction, tangent)) < Math.cos(25 * Math.PI / 180)) clearanceM = Math.min(clearanceM, segmentDistance(boundedStart, boundedEnd, a, b));
    }
  }
  check(clearanceM >= 25, `${id}: short section has a nonparallel original road within the 25m junction guard.`);
  return {kind: 'native_vertex_events_and_0_05m_checks', clearanceM: Number.isFinite(clearanceM) ? clearanceM : null, eventCount: events.size, checks, sourceGeometryChanged: false};
}

function component(kind, spans, reviewed, endpoints = []) {
  const widths = spans.map(span => span.span_m).sort((a, b) => a - b);
  const observedWidths = [...widths, ...endpoints.map(span => span.span_m)].sort((a, b) => a - b);
  const rangeM = [observedWidths[0], observedWidths.at(-1)];
  const middle = widths.length / 2;
  const median = round((widths[middle - 1] + widths[middle]) / 2);
  const value = {kind, widthM: median, rangeM, rangeStatus: RANGE_STATUS, errorM: null, errorStatus: 'ground_and_mapping_accuracy_not_independently_verified'};
  if (kind === 'carriageway') {
    value.classification = reviewed ? CLASSIFICATION : 'unverified_candidate_not_carriageway';
    if (!reviewed) { value.widthM = null; value.rangeM = null; value.candidateRangeM = rangeM; }
  }
  return value;
}

/** Pure integration boundary. The caller hashes the actual source, surface and
 * image bytes; scratch provenance paths are never read or trusted as hashes.
 * Visual review identifies mapped curb layout, not ground-measured widths or
 * unobstructed walking width. Inputs and baseline geometries are never changed.
 */
export function buildRoadCrossProfiles(candidates, reviews, source, surfaces, expectedHashes) {
  check(candidates?.schema === 'main-road-cross-section-candidates.v1' && candidates.status === 'UNVERIFIED_CANDIDATE_ONLY' && candidates.metric_crs === 'EPSG:5186', 'Invalid candidate schema, status or metric CRS.');
  check(HASH.test(expectedHashes?.sourceSha256) && HASH.test(expectedHashes?.surfaceSha256) && candidates.source?.sha256 === expectedHashes.sourceSha256 && candidates.NGII?.sha256 === expectedHashes.surfaceSha256 && surfaces.metadata?.sourceSha256 === expectedHashes.sourceSha256, 'Profile source/surface checksum mismatch.');
  check(candidates.NGII.year === 2025 && surfaces.metadata.sourceYear === 2025 && surfaces.metadata.scale === '1:1000', 'Expected the existing 2025 1:1000 mapped geometry.');
  check(reviews?.schema === 'guil-curb-reviews.v1' && Array.isArray(reviews.records), 'Invalid curb review schema.');
  const coordinateSystem = source.metadata?.coordinate_system;
  check(point(coordinateSystem?.origin_lon_lat) && Number.isFinite(coordinateSystem.meters_per_degree_lon) && coordinateSystem.meters_per_degree_lon > 0 && Number.isFinite(coordinateSystem.meters_per_degree_lat) && coordinateSystem.meters_per_degree_lat > 0 && JSON.stringify(surfaces.metadata.localCoordinateSystem) === JSON.stringify(coordinateSystem), 'Profile local coordinate system mismatch.');
  const boundary = source.metadata?.local_provisional_boundary_m;
  check(Array.isArray(source.features) && Array.isArray(surfaces.features) && Array.isArray(boundary), 'Source geometry, surface geometry and approved boundary are required.');
  const sourcesById = new Map(source.features.map(feature => [String(feature.id), feature]));
  const surfacesById = new Map(surfaces.features.map(feature => [feature.id, feature]));
  check(sourcesById.size === source.features.length && surfacesById.size === surfaces.features.length, 'Duplicate source or surface ID.');
  const reviewsById = new Map();
  for (const review of reviews.records) {
    check(typeof review.id === 'string' && review.id.trim() && !reviewsById.has(review.id), 'Missing or duplicate curb review ID.');
    reviewsById.set(review.id, review);
  }
  check(Array.isArray(candidates.selected_roads) && candidates.selected_roads.length > 0 && candidates.selected_roads.every(road => typeof road?.road_name === 'string'), 'Selected bounded road sections with explicit road names are required.');
  const profiles = [], ids = new Set(), intervalsBySegment = new Map();
  for (const road of candidates.selected_roads) {
    const section = road.section;
    check(section && Array.isArray(section.profiles) && section.profiles.length >= 2, `${road.road_name}: cross-section samples are required.`);
    const first = section.profiles[0], sourceId = section.original_road_id, partIndex = first.original_part_index, segmentIndex = section.segment_index;
    const startM = section.start_along_segment_m, endM = section.end_along_segment_m;
    check(Number.isInteger(partIndex) && partIndex >= 0 && Number.isInteger(segmentIndex) && segmentIndex >= 0 && Number.isFinite(startM) && startM >= 0 && Number.isFinite(endM) && endM > startM, `${sourceId}: invalid source segment or interval.`);
    const sectionLengthM = endM - startM;
    const scheme = sectionLengthM === 20 ? {count: 4, offset: 2.5, step: 5} : sectionLengthM === 5 ? {count: 2, offset: 1.25, step: 2.5} : null;
    check(scheme, `${sourceId}: only exact bounded 20m or 5m sections are supported.`);
    check(section.profiles.length === scheme.count, `${sourceId}: expected ${scheme.count === 4 ? 'four' : 'two'} cross-section samples for the ${sectionLengthM}m section.`);
    const id = `${sourceId}/curb-profile/part-${partIndex}/segment-${segmentIndex}/${startM}-${endM}`;
    check(!ids.has(id), 'Duplicate cross-profile ID.');
    ids.add(id);
    const key = `${sourceId}/${partIndex}/${segmentIndex}`;
    const preceding = intervalsBySegment.get(key) || [];
    check(preceding.every(interval => Math.min(interval[1], endM) <= Math.max(interval[0], startM) + 1e-8), `${id}: overlapping cross-profile intervals.`);
    preceding.push([startM, endM]); intervalsBySegment.set(key, preceding);
    const original = sourcesById.get(sourceId), line = parts(original?.geometry)[partIndex];
    check(original?.properties.category === 'road' && (original.properties.name ?? '') === road.road_name && Array.isArray(line) && line[segmentIndex + 1], `${id}: original road segment does not exist or differs in identity.`);
    const a = projectProfilePointToNative(line[segmentIndex]), b = projectProfilePointToNative(line[segmentIndex + 1]);
    const length = distance(a, b);
    check(length > 0 && endM <= length + COORDINATE_TOLERANCE_M, `${id}: section exceeds its original native segment.`);
    if (sectionLengthM === 5) {
      const tags = original.properties.osm_tags || {};
      check(tags.bridge !== 'yes' && tags.tunnel !== 'yes' && (!tags.layer || tags.layer === '0'), `${id}: short profile needs verified ground-level road semantics.`);
      check(startM >= 12 && length - endM >= 12, `${id}: short section is within the original vertex/endpoint clearance.`);
    }
    const tangent = subtract(b, a).map(value => value / length), normal = [-tangent[1], tangent[0]];
    const localA = toLocal(line[segmentIndex], coordinateSystem), localB = toLocal(line[segmentIndex + 1], coordinateSystem);
    const localSourceLine = parts(original.properties.local_geometry_m)[partIndex];
    closePoint(localSourceLine?.[segmentIndex], localA, `${id}: baseline local geometry mismatch.`);
    closePoint(localSourceLine?.[segmentIndex + 1], localB, `${id}: baseline local geometry mismatch.`);
    withinBoundary([at(localA, subtract(localB, localA), startM / length), at(localA, subtract(localB, localA), endM / length)], boundary, id);
    const polygonTriples = new Set();
    const samples = section.profiles.map((sample, index) => {
      const label = `${id} sample ${index}`;
      check(sample.original_road_id === sourceId && sample.road_name === road.road_name && sample.original_part_index === partIndex && sample.original_segment_index === segmentIndex && sample.status === 'UNVERIFIED_CANDIDATE' && Array.isArray(sample.rejected_reasons) && !sample.rejected_reasons.length && sample.residual_interval?.actual_carriageway_width_m === null && sample.residual_interval.classification === 'UNVERIFIED_CANDIDATE_ONLY_NOT_VERIFIED_CARRIAGEWAY', `${label}: candidate identity/status must remain unverified and unrejected.`);
      close(sample.sample_along_original_segment_m, startM + scheme.offset + index * scheme.step, `${label}: sample position differs from the explicit ${sectionLengthM}m sampling scheme.`);
      validatePosition(sample.samplepoint, coordinateSystem, label);
      closePoint(sample.samplepoint.native_epsg5186_m, at(a, tangent, sample.sample_along_original_segment_m), `${label}: point does not lie on the original native segment.`);
      check(point(sample.normal_left_of_original_line) && distance(sample.normal_left_of_original_line, normal) < 1e-7, `${label}: normal direction or left/right orientation mismatch.`);
      const heading = (Math.atan2(tangent[0], tangent[1]) * 180 / Math.PI + 360) % 360;
      check(Number.isFinite(sample.heading_degrees_clockwise_from_native_north) && Math.abs(((sample.heading_degrees_clockwise_from_native_north - heading + 540) % 360) - 180) < 0.001, `${label}: native heading mismatch.`);
      const sampleNative = sample.samplepoint.native_epsg5186_m;
      for (const kind of ['road_boundary', 'left_sidewalk', 'right_sidewalk', 'residual_interval']) {
        validateSpan(sample[kind], sampleNative, normal, coordinateSystem, `${label} ${kind}`);
        withinBoundary(sample[kind].endpoints.map(endpoint => endpoint.local_plan_m), boundary, `${label} ${kind}`);
      }
      validateMappedSpan(sample.road_boundary, 'road_corridor', sampleNative, tangent, surfacesById, label);
      validateMappedSpan(sample.left_sidewalk, 'walkway', sampleNative, tangent, surfacesById, label);
      validateMappedSpan(sample.right_sidewalk, 'walkway', sampleNative, tangent, surfacesById, label);
      const roadInterval = sample.road_boundary.signed_normal_interval_m, left = sample.left_sidewalk.signed_normal_interval_m, right = sample.right_sidewalk.signed_normal_interval_m, residual = sample.residual_interval.signed_normal_interval_m;
      check(roadInterval[0] < 0 && roadInterval[1] > 0 && left[0] > 0 && right[1] < 0 && sample.left_sidewalk.ngii_polygon_id !== sample.right_sidewalk.ngii_polygon_id, `${label}: left/right sidewalk semantics mismatch.`);
      close(residual[0], right[1], `${label}: right inner curb mismatch.`);
      close(residual[1], left[0], `${label}: left inner curb mismatch.`);
      check(residual[0] >= roadInterval[0] && residual[1] <= roadInterval[1], `${label}: residual exceeds mapped road boundaries.`);
      check(sample.road_boundary.span_m <= 45, `${label}: road boundary span exceeds the bounded candidate scope.`);
      for (const [side, interval] of [['left', left], ['right', right]]) {
        const width = interval[1] - interval[0];
        const overlap = Math.max(0, Math.min(interval[1], roadInterval[1]) - Math.max(interval[0], roadInterval[0]));
        const outerGap = side === 'left' ? roadInterval[1] - interval[1] : interval[0] - roadInterval[0];
        check(width >= 0.7 && width <= 12 && overlap / width >= 0.85 && Math.abs(outerGap) <= 1.5, `${label}: paired sidewalk geometry fails the candidate scope.`);
      }
      polygonTriples.add([sample.road_boundary.ngii_polygon_id, sample.left_sidewalk.ngii_polygon_id, sample.right_sidewalk.ngii_polygon_id].join('|'));
      return {pointLocalM: [...sample.samplepoint.local_plan_m], roadBoundaryLineLocalM: sample.road_boundary.endpoints.map(endpoint => [...endpoint.local_plan_m]), leftWalkwayLineLocalM: sample.left_sidewalk.endpoints.map(endpoint => [...endpoint.local_plan_m]), rightWalkwayLineLocalM: sample.right_sidewalk.endpoints.map(endpoint => [...endpoint.local_plan_m]), candidateResidualLineLocalM: sample.residual_interval.endpoints.map(endpoint => [...endpoint.local_plan_m])};
    });
    check(polygonTriples.size === 1, `${id}: polygon evidence changes within the section.`);
    const endpointChecks = [startM, endM].map((alongM, index) => endpointCheck(at(a, tangent, alongM), alongM, first, tangent, surfacesById, coordinateSystem, boundary, `${id} endpoint ${index}`));
    const nativeInteriorAudit = sectionLengthM === 5 ? auditShortSection(startM, endM, a, tangent, first, surfacesById, source, coordinateSystem, boundary, id) : null;
    const rangeChecks = [...endpointChecks, ...(nativeInteriorAudit?.checks || [])];
    for (const [kind, maximumVariation] of [['road_boundary', 0.8], ['left_sidewalk', 0.5], ['right_sidewalk', 0.5], ['residual_interval', 0.8]]) {
      const widths = [...section.profiles.map(sample => sample[kind].span_m), ...rangeChecks.map(endpoint => endpoint.spans[kind].span_m)];
      check(Math.max(...widths) - Math.min(...widths) <= maximumVariation, `${id}: endpoint-inclusive ${kind} variation exceeds the selected stable section scope.`);
    }
    const review = reviewsById.get(id);
    validateReview(review, {sourceId, partIndex, segmentIndex, startM, endM}, id, expectedHashes);
    const reviewed = review?.status === REVIEWED;
    for (const sample of samples) sample.carriagewayLineLocalM = reviewed ? structuredClone(sample.candidateResidualLineLocalM) : null;
    for (const endpoint of endpointChecks) endpoint.carriagewayLineLocalM = reviewed ? structuredClone(endpoint.candidateResidualLineLocalM) : null;
    const evidenceIds = [...new Set(section.profiles.flatMap(sample => [sample.road_boundary.ngii_polygon_id, sample.left_sidewalk.ngii_polygon_id, sample.right_sidewalk.ngii_polygon_id]))];
    profiles.push({id, sourceId, roadName: road.road_name, partIndex, originalSegmentIndex: segmentIndex, startAlongSegmentM: startM, endAlongSegmentM: endM, sectionLengthM, sampleCount: scheme.count, samplingScheme: {...scheme}, nativeInteriorAudit, distanceBasis: 'native_projected_metres_along_original_segment', sideBasis: 'left_and_right_relative_to_original_digitization_heading', reviewStatus: reviewed ? REVIEWED : 'pending', classification: reviewed ? CLASSIFICATION : 'unverified_candidate_not_carriageway', evidenceIds: reviewed ? [...evidenceIds, review.id] : evidenceIds, evidence: {sourceSha256: expectedHashes.sourceSha256, surfaceSha256: expectedHashes.surfaceSha256, images: reviewed ? structuredClone(review.images) : []}, components: [component('mapped_road_boundary', section.profiles.map(sample => sample.road_boundary), reviewed, rangeChecks.map(endpoint => endpoint.spans.road_boundary)), component('left_walkway', section.profiles.map(sample => sample.left_sidewalk), reviewed, rangeChecks.map(endpoint => endpoint.spans.left_sidewalk)), component('right_walkway', section.profiles.map(sample => sample.right_sidewalk), reviewed, rangeChecks.map(endpoint => endpoint.spans.right_sidewalk)), component('carriageway', section.profiles.map(sample => sample.residual_interval), reviewed, rangeChecks.map(endpoint => endpoint.spans.residual_interval))], samples, endpointChecks, review: review ? structuredClone(review) : null});
  }
  check([...reviewsById.keys()].every(id => ids.has(id)), 'Review refers to an unknown cross-profile interval.');
  const reviewedProfiles = profiles.filter(profile => profile.reviewStatus === REVIEWED);
  return {profiles, summary: {profileCount: profiles.length, sampleCount: profiles.reduce((count, profile) => count + profile.samples.length, 0), visuallyReviewedProfileCount: reviewedProfiles.length, pendingProfileCount: profiles.length - reviewedProfiles.length, reviewedNativeSectionLengthM: round(reviewedProfiles.reduce((total, profile) => total + profile.endAlongSegmentM - profile.startAlongSegmentM, 0)), groundMeasuredWidthCount: 0, parentWayWidthsAssigned: 0, note: 'Widths are sampled mapping estimates. Visual review identifies curb layout only; ground measurement, mapping accuracy and unobstructed walking width remain unverified.'}};
}
