import {readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {makeRoadInventory, cumulativeLength} from './road_widths.mjs';

const EPS = 1e-8;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const round = value => Number(value.toFixed(6));
const unique = values => [...new Set(values)];
const lineParts = geometry => geometry.type === 'LineString' ? [geometry.coordinates] : geometry.type === 'MultiLineString' ? geometry.coordinates : [];
const polygonParts = geometry => geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];

function inRing(point, ring) {
  let inside = false;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i], vector = sub(b, a), offset = sub(point, a);
    if (Math.abs(cross(vector, offset)) <= EPS * Math.max(1, Math.hypot(...vector)) &&
        point[0] >= Math.min(a[0], b[0]) - EPS && point[0] <= Math.max(a[0], b[0]) + EPS &&
        point[1] >= Math.min(a[1], b[1]) - EPS && point[1] <= Math.max(a[1], b[1]) + EPS) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < vector[0] * (point[1] - a[1]) / vector[1] + a[0]) inside = !inside;
  }
  return inside;
}
const contains = (point, geometry) => polygonParts(geometry).some(polygon => inRing(point, polygon[0]) && !polygon.slice(1).some(hole => inRing(point, hole)));

export function unionIntervals(intervals) {
  const result = [];
  for (const [start, end] of intervals.filter(pair => pair[1] - pair[0] > EPS).sort((a, b) => a[0] - b[0])) {
    if (result.length && start <= result.at(-1)[1] + EPS) result.at(-1)[1] = Math.max(result.at(-1)[1], end);
    else result.push([start, end]);
  }
  return result;
}

export function subtractIntervals(base, exclusions) {
  let result = base.map(pair => [...pair]);
  for (const [left, right] of unionIntervals(exclusions)) result = result.flatMap(([a, b]) => right <= a || left >= b ? [[a, b]] : [[a, Math.min(b, left)], [Math.max(a, right), b]].filter(pair => pair[1] - pair[0] > EPS));
  return result;
}

/** Signed distances along the normal, including polygon-hole exclusions. Distances are not road classifications. */
export function crossSectionIntervals(point, tangent, geometry, halfLengthM = 60) {
  if (!point?.every(Number.isFinite) || !tangent?.every(Number.isFinite) || point.length !== 2 || tangent.length !== 2 || !(halfLengthM > 0) || !Number.isFinite(halfLengthM)) throw new Error('Finite point/tangent and positive cross-section length are required.');
  const tangentLength = Math.hypot(...tangent);
  if (!tangentLength || !polygonParts(geometry).length) throw new Error('Nonzero tangent and Polygon/MultiPolygon required.');
  const normal = [-tangent[1] / tangentLength, tangent[0] / tangentLength];
  const cuts = [-halfLengthM, halfLengthM];
  for (const polygon of polygonParts(geometry)) for (const ring of polygon) {
    if (ring.length < 4 || ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) throw new Error('Unclosed cross-section polygon ring.');
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1], vector = sub(ring[i], a), denominator = cross(normal, vector), offset = sub(a, point);
      if (Math.abs(denominator) > EPS) {
        const t = cross(offset, vector) / denominator, u = cross(offset, normal) / denominator;
        if (u >= -EPS && u <= 1 + EPS && t > -halfLengthM && t < halfLengthM) cuts.push(t);
      } else if (Math.abs(cross(offset, normal)) <= EPS) {
        for (const endpoint of [a, ring[i]]) { const t = dot(sub(endpoint, point), normal); if (Math.abs(t) < halfLengthM) cuts.push(t); }
      }
    }
  }
  cuts.sort((a, b) => a - b);
  const clean = cuts.filter((value, index) => !index || value - cuts[index - 1] > EPS);
  const intervals = [];
  for (let i = 1; i < clean.length; i++) {
    const middle = (clean[i - 1] + clean[i]) / 2;
    if (contains([point[0] + middle * normal[0], point[1] + middle * normal[1]], geometry)) intervals.push([clean[i - 1], clean[i]]);
  }
  return unionIntervals(intervals);
}

function locate(line, distance) {
  let offset = 0;
  for (let i = 1; i < line.length; i++) {
    const vector = sub(line[i], line[i - 1]), length = Math.hypot(...vector);
    if (length && (offset + length >= distance - EPS || i === line.length - 1)) {
      const t = Math.max(0, Math.min(1, (distance - offset) / length));
      return {point: [line[i - 1][0] + vector[0] * t, line[i - 1][1] + vector[1] * t], tangent: vector, vertex: i};
    }
    offset += length;
  }
  throw new Error('Cannot locate a point on a zero-length line.');
}

export function boundedSections(line, sectionLengthM = 20) {
  if (!Number.isFinite(sectionLengthM) || sectionLengthM <= 0) throw new Error('Positive section length required.');
  const length = cumulativeLength(line), result = [];
  for (let start = 0; start < length - EPS; start += sectionLengthM) {
    const end = Math.min(length, start + sectionLengthM), a = locate(line, start), b = locate(line, end);
    const coordinates = [a.point, ...line.slice(a.vertex, b.vertex), b.point];
    result.push({startM: start, endM: end, localGeometry: {type: 'LineString', coordinates}});
  }
  return result;
}

export function createMetricTransform(coordinateSystem, proj4, prjWkt) {
  const converter = proj4('WGS84', prjWkt);
  const [lon, lat] = coordinateSystem.origin_lon_lat;
  return {
    toMetric: point => converter.forward([lon + point[0] / coordinateSystem.meters_per_degree_lon, lat + point[1] / coordinateSystem.meters_per_degree_lat]),
    toLocal: point => { const wgs = converter.inverse(point); return [(wgs[0] - lon) * coordinateSystem.meters_per_degree_lon, (wgs[1] - lat) * coordinateSystem.meters_per_degree_lat]; },
    geometryMode: 'native', metricCRS: 'actual NGII PRJ projected metres'
  };
}

function prepare(feature, mode) {
  const geometry = feature.properties[mode === 'native' ? 'native_geometry_m' : 'local_geometry_m'];
  if (!geometry) throw new Error(`Missing ${mode} geometry: ${feature.id}`);
  if (feature.properties.officialWidthM != null && (!Number.isFinite(feature.properties.officialWidthM) || feature.properties.officialWidthM <= 0)) throw new Error(`Invalid official width: ${feature.id}`);
  const segments = lineParts(geometry).flatMap(line => line.slice(1).map((b, i) => ({a: line[i], b, vector: sub(b, line[i]), length: Math.hypot(...sub(b, line[i]))}))).filter(segment => segment.length > EPS);
  return {feature, geometry, segments};
}

function nearestCenter(point, tangent, centers, config, record) {
  const unit = tangent.map(value => value / Math.hypot(...tangent)), candidates = [];
  for (const item of centers) {
    let best = null;
    for (const segment of item.segments) {
      const t = Math.max(0, Math.min(1, dot(sub(point, segment.a), segment.vector) / segment.length ** 2));
      const distance = Math.hypot(...sub(point, [segment.a[0] + t * segment.vector[0], segment.a[1] + t * segment.vector[1]]));
      const cosine = Math.abs(dot(unit, segment.vector) / segment.length);
      if (cosine >= Math.cos(config.headingMaxDegrees * Math.PI / 180) && distance <= config.centerDistanceMaxM && (!best || distance < best.distance)) best = {distance, cosine};
    }
    if (best) candidates.push({item, ...best});
  }
  candidates.sort((a, b) => a.distance - b.distance);
  const best = candidates[0];
  if (!best) return {reason: 'no_aligned_official_centerline'};
  const close = candidates.filter(candidate => candidate.distance <= best.distance + config.conflictDistanceM);
  const widths = unique(close.map(candidate => candidate.item.feature.properties.officialWidthM));
  if (widths.length !== 1 || widths[0] == null) return {reason: 'ambiguous_or_missing_official_width', candidates: close.map(candidate => candidate.item.feature.id)};
  const roadName = best.item.feature.properties.attributes?.['도로명'];
  if (record.name && roadName && record.name !== roadName) return {reason: 'official_road_name_conflict', candidates: close.map(candidate => candidate.item.feature.id)};
  return {id: best.item.feature.id, evidenceId: best.item.feature.properties.evidenceId || best.item.feature.id, widthM: widths[0], widthKind: best.item.feature.properties.officialWidthKind, distanceM: round(best.distance), headingCos: round(best.cosine), roadName: roadName || null, attributes: best.item.feature.properties.attributes, tile: best.item.feature.properties.tile};
}

const centerInterval = intervals => intervals.filter(([a, b]) => a < -EPS && b > EPS);
const intervalLength = intervals => intervals.reduce((sum, [a, b]) => sum + b - a, 0);

function continuouslyCovered(line, matchedSurfaces, transform) {
  for (let i = 1; i < line.length; i++) {
    const a = transform.toMetric(line[i - 1]), b = transform.toMetric(line[i]);
    const vector = sub(b, a), length = Math.hypot(...vector);
    if (length <= EPS) continue;
    const midpoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const intervals = unionIntervals(matchedSurfaces.flatMap(item => crossSectionIntervals(midpoint, [vector[1], -vector[0]], item.geometry, length / 2 + 1)));
    const coveredLength = intervalLength(intervals.map(([left, right]) => [Math.max(left, -length / 2), Math.min(right, length / 2)]).filter(([left, right]) => right - left > EPS));
    if (coveredLength < length - 1e-6) return false;
  }
  return true;
}

// A001 measurements describe the mapped surface only. No centreline width,
// sidewalk subtraction, or carriageway meaning is used to calculate them.
function roadSurfaceSample(point, tangent, prepared, config, transform) {
  const sample = {pointLocalM: transform.toLocal(point).map(round), pointMetricM: point.map(round), widthM: null, evidenceIds: []};
  const containing = prepared.roads.filter(item => contains(point, item.geometry));
  if (containing.length !== 1) return {...sample, reason: containing.length ? 'multiple_containing_surfaces_or_tile_seam' : 'no_containing_official_surface'};
  const item = containing[0], intervals = crossSectionIntervals(point, tangent, item.geometry, config.crossSectionHalfLengthM);
  sample.surfaceId = item.feature.id;
  sample.evidenceIds = [item.feature.properties.evidenceId || item.feature.id];
  if (intervals.length !== 1 || centerInterval(intervals).length !== 1) return {...sample, reason: 'multiple_or_hole_cross_section'};
  const [left, right] = intervals[0];
  if (left <= -config.crossSectionHalfLengthM + EPS || right >= config.crossSectionHalfLengthM - EPS) return {...sample, reason: 'cross_section_not_bounded'};
  const normal = [-tangent[1] / Math.hypot(...tangent), tangent[0] / Math.hypot(...tangent)];
  sample.crossSectionLocalM = [left, right].map(t => transform.toLocal([point[0] + t * normal[0], point[1] + t * normal[1]]).map(round));
  return {...sample, widthM: right - left, reason: null};
}

function crossesOfficialJunction(line, centers, config) {
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], vector = sub(line[i], a), length = Math.hypot(...vector);
    if (length <= EPS) continue;
    for (const item of centers) for (const segment of item.segments) {
      const denominator = cross(vector, segment.vector);
      const cosine = Math.abs(dot(vector, segment.vector) / (length * segment.length));
      if (Math.abs(denominator) <= EPS || cosine > Math.cos(config.junctionHeadingMinDegrees * Math.PI / 180)) continue;
      const offset = sub(segment.a, a), t = cross(offset, segment.vector) / denominator, u = cross(offset, vector) / denominator;
      if (t >= -config.junctionBufferM / length && t <= 1 + config.junctionBufferM / length && u >= -EPS && u <= 1 + EPS) return true;
    }
  }
  return false;
}

function hasAlignedDividedCenter(point, tangent, centers, config) {
  const length = Math.hypot(...tangent);
  return centers.some(item => item.feature.properties.attributes?.['분리대유무'] === '유' && item.segments.some(segment => {
    const t = Math.max(0, Math.min(1, dot(sub(point, segment.a), segment.vector) / segment.length ** 2));
    const distance = Math.hypot(...sub(point, [segment.a[0] + t * segment.vector[0], segment.a[1] + t * segment.vector[1]]));
    return distance <= config.centerDistanceMaxM && Math.abs(dot(tangent, segment.vector) / (length * segment.length)) >= Math.cos(config.headingMaxDegrees * Math.PI / 180);
  }));
}

function measureRoadSurfaceReference(record, nativeSection, id, prepared, config, transform) {
  const line = nativeSection.localGeometry.coordinates, length = nativeSection.endM - nativeSection.startM;
  const localGeometry = {type: 'LineString', coordinates: line.map(transform.toLocal)};
  const review = {id, startM: round(nativeSection.startM), endM: round(nativeSection.endM), localGeometry, reason: null};
  const count = Math.ceil(length / config.sampleSpacingM);
  if (length < config.minimumSectionLengthM || count < config.minimumSamples) return {...review, reason: 'section_too_short_for_multiple_samples'};
  if (record.osmTags.oneway === 'yes' || record.osmTags.oneway === '-1') return {...review, reason: 'divided_or_split_carriageway_width_unresolved'};
  if (crossesOfficialJunction(line, prepared.centers, config)) return {...review, reason: 'official_centerline_junction_needs_individual_review'};
  const locations = Array.from({length: count}, (_, i) => locate(line, length * (i + 0.5) / count));
  const endpoints = [locate(line, 0), locate(line, length)];
  const samples = locations.map(({point, tangent}) => roadSurfaceSample(point, tangent, prepared, config, transform));
  const endpointSamples = endpoints.map(({point, tangent}) => roadSurfaceSample(point, tangent, prepared, config, transform));
  const checks = [...samples, ...endpointSamples];
  if (checks.some(sample => sample.reason)) return {...review, reason: unique(checks.map(sample => sample.reason).filter(Boolean)).join('; ')};
  const ids = unique(checks.map(sample => sample.surfaceId));
  if (ids.length !== 1) return {...review, reason: 'surface_changes_or_tile_seam_inside_section'};
  const item = prepared.roads.find(surface => surface.feature.id === ids[0]);
  if (!continuouslyCovered(localGeometry.coordinates, [item], transform)) return {...review, reason: 'section_not_continuously_inside_matched_surface'};
  // Reject even a narrow overlap missed by the fixed sample locations.
  for (let i = 1; i < line.length; i++) {
    const vector = sub(line[i], line[i - 1]), span = Math.hypot(...vector);
    if (span <= EPS) continue;
    const middle = [(line[i][0] + line[i - 1][0]) / 2, (line[i][1] + line[i - 1][1]) / 2];
    for (const other of prepared.roads) if (other !== item && crossSectionIntervals(middle, [vector[1], -vector[0]], other.geometry, span / 2 + 1).some(([a, b]) => Math.min(b, span / 2) - Math.max(a, -span / 2) > EPS)) return {...review, reason: 'overlapping_surfaces_or_tile_seam_inside_section'};
  }
  for (const {point, tangent} of [...locations, ...endpoints]) {
    if (hasAlignedDividedCenter(point, tangent, prepared.centers, config)) return {...review, reason: 'divided_or_split_carriageway_width_unresolved'};
  }
  const widths = samples.map(sample => sample.widthM).sort((a, b) => a - b), median = widths[Math.floor(widths.length / 2)];
  const range = [Math.min(...checks.map(sample => sample.widthM)), Math.max(...checks.map(sample => sample.widthM))];
  if ((range[1] - range[0]) / median > config.widthVariationFractionMax) return {...review, reason: 'junction_or_large_width_variation_needs_smaller_reviewed_sections'};
  return {...review, widthM: round(median), rangeM: range.map(round), widthKind: 'road_surface_reference', status: 'geometry_estimate_not_verified_carriageway', eligibility: 'geometry_reference_only', evidenceIds: unique(samples.flatMap(sample => sample.evidenceIds)), sampleCount: count, errorM: null, errorStatus: 'absolute_position_and_width_accuracy_not_supplied', rangeStatus: 'observed_section_variation_not_statistical_accuracy', distanceBasis: transform.geometryMode === 'native' ? 'native_projected_metres' : 'local_reference_metres', method: transform.geometryMode === 'native' ? 'normal_intersection_of_A001_road_polygon_in_native_projected_metres' : 'normal_intersection_of_A001_road_polygon_in_local_reference_metres', samples: samples.map(sample => ({...sample, widthM: round(sample.widthM)})), endpointChecks: endpointSamples.map(sample => ({...sample, widthM: round(sample.widthM)}))};
}

function sampleMeasurement(record, localPoint, localTangent, prepared, config, transform) {
  const point = transform.toMetric(localPoint), next = transform.toMetric([localPoint[0] + localTangent[0], localPoint[1] + localTangent[1]]), tangent = sub(next, point);
  const sample = {pointLocalM: localPoint.map(round), pointMetricM: point.map(round), widthM: null, evidenceIds: []};
  const surfaces = record.category === 'path' ? prepared.walkways : prepared.roads;
  const containing = surfaces.filter(item => contains(point, item.geometry));
  if (containing.length !== 1) return {...sample, reason: containing.length ? 'multiple_containing_surfaces_or_tile_seam' : 'no_containing_official_surface'};
  const item = containing[0], intervals = crossSectionIntervals(point, tangent, item.geometry, config.crossSectionHalfLengthM), centered = centerInterval(intervals);
  sample.evidenceIds.push(item.feature.properties.evidenceId || item.feature.id);
  sample.surfaceId = item.feature.id;
  sample.intervalsM = intervals.map(pair => pair.map(round));
  if (intervals.length !== 1 || centered.length !== 1) return {...sample, reason: 'multiple_or_hole_cross_section'};
  const [left, right] = centered[0];
  if (left <= -config.crossSectionHalfLengthM + EPS || right >= config.crossSectionHalfLengthM - EPS) return {...sample, reason: 'cross_section_not_bounded'};
  const normal = [-tangent[1] / Math.hypot(...tangent), tangent[0] / Math.hypot(...tangent)];
  sample.crossSectionLocalM = [left, right].map(t => transform.toLocal([point[0] + t * normal[0], point[1] + t * normal[1]]).map(round));
  const width = right - left;
  if (record.category === 'path') {
    const officialWidthM = item.feature.properties.officialWidthM;
    sample.officialWidthM = officialWidthM;
    if (officialWidthM == null || Math.abs(officialWidthM - width) / officialWidthM > config.attributeDifferenceFractionMax) return {...sample, reason: 'walkway_attribute_geometry_disagreement'};
    return {...sample, widthM: width, widthKind: 'walkway', method: 'normal_intersection_of_official_walkway_polygon_checked_against_width_attribute', reason: null};
  }
  sample.corridorWidthM = round(width);
  const center = nearestCenter(point, tangent, prepared.centers, config, record);
  sample.centerlineReference = center;
  if (center.reason) return {...sample, reason: center.reason};
  sample.evidenceIds.push(center.evidenceId);
  const sidewalkIntervals = prepared.walkways.flatMap(walkway => crossSectionIntervals(point, tangent, walkway.geometry, config.crossSectionHalfLengthM).map(interval => ({interval, id: walkway.feature.id})));
  const overlapping = sidewalkIntervals.filter(({interval: [a, b]}) => a < right - EPS && b > left + EPS);
  sample.walkwayOverlapM = round(intervalLength(unionIntervals(overlapping.map(({interval: [a, b]}) => [Math.max(a, left), Math.min(b, right)]))));
  sample.walkwaySurfaceIds = unique(overlapping.map(entry => entry.id));
  const remaining = subtractIntervals([[left, right]], overlapping.map(entry => entry.interval));
  sample.afterMappedWalkwayExclusionIntervalsM = remaining.map(pair => pair.map(round));
  sample.afterMappedWalkwayExclusionMeaning = 'geometry diagnostic only; no automatic carriageway classification';
  if (record.osmTags.oneway === 'yes' || center.attributes?.['분리대유무'] === '유') return {...sample, reason: 'divided_or_split_carriageway_width_unresolved'};
  if (config.centerlineWidthMeaning === 'carriageway' && config.semanticEvidenceId) {
    if (Math.abs(center.widthM - width) / center.widthM > config.attributeDifferenceFractionMax) return {...sample, reason: 'road_attribute_surface_disagreement'};
    return {...sample, widthM: center.widthM, widthKind: 'carriageway', method: 'semantically_verified_official_centerline_width_on_bounded_matched_section', evidenceIds: [...sample.evidenceIds, config.semanticEvidenceId], reason: null};
  }
  if (config.roadPolygonMeaning === 'corridor_including_sidewalks' && config.semanticEvidenceId && config.walkwayCompletenessEvidenceId) {
    const leftSide = overlapping.some(({interval: [a, b]}) => a <= left + EPS && b < -EPS);
    const rightSide = overlapping.some(({interval: [a, b]}) => a > EPS && b >= right - EPS);
    if (!leftSide || !rightSide || remaining.length !== 1 || centerInterval(remaining).length !== 1) return {...sample, reason: 'sidewalk_exclusion_not_a_single_bounded_vehicle_space'};
    return {...sample, widthM: intervalLength(remaining), widthKind: 'carriageway', method: 'reviewed_corridor_minus_complete_mapped_sidewalk_cross_section', evidenceIds: unique([...sample.evidenceIds, ...sample.walkwaySurfaceIds, config.semanticEvidenceId, config.walkwayCompletenessEvidenceId]), reason: null};
  }
  return {...sample, reason: 'road_surface_and_outer_curb_width_are_not_verified_carriageway_width'};
}

export function measureRoadSections(source, surfaceData, options = {}) {
  const config = {sectionLengthM: 20, sampleSpacingM: 5, minimumSectionLengthM: 15, minimumSamples: 3, crossSectionHalfLengthM: 60, centerDistanceMaxM: 6, headingMaxDegrees: 20, conflictDistanceM: 1, attributeDifferenceFractionMax: 0.25, widthVariationFractionMax: 0.5, junctionHeadingMinDegrees: 45, junctionBufferM: 3, centerlineWidthMeaning: 'road_outer_curb_or_shoulder', roadPolygonMeaning: 'unverified_corridor', semanticEvidenceId: null, walkwayCompletenessEvidenceId: null, ...options};
  for (const key of ['sectionLengthM', 'sampleSpacingM', 'minimumSectionLengthM', 'minimumSamples', 'crossSectionHalfLengthM', 'centerDistanceMaxM']) if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error(`Invalid measurement option: ${key}`);
  if (!Number.isInteger(config.minimumSamples) || config.minimumSamples < 3) throw new Error('At least three integer cross-section samples are required.');
  for (const key of ['headingMaxDegrees', 'conflictDistanceM', 'attributeDifferenceFractionMax', 'widthVariationFractionMax', 'junctionHeadingMinDegrees', 'junctionBufferM']) if (!Number.isFinite(config[key]) || config[key] < 0) throw new Error(`Invalid measurement option: ${key}`);
  const transform = options.metricTransform || {toMetric: point => [...point], toLocal: point => [...point], geometryMode: 'local', metricCRS: 'existing local linear metres; not ground-survey CRS'};
  const prepared = {roads: [], walkways: [], centers: []};
  const seen = new Set();
  for (const feature of surfaceData.features) {
    if (seen.has(feature.id)) throw new Error(`Duplicate surface evidence ID: ${feature.id}`);
    seen.add(feature.id);
    const kind = feature.properties.surfaceKind;
    if (['road_corridor', 'walkway', 'road_centerline'].includes(kind)) prepared[kind === 'road_corridor' ? 'roads' : kind === 'walkway' ? 'walkways' : 'centers'].push(prepare(feature, transform.geometryMode));
  }
  const records = makeRoadInventory(source).map(record => {
    const output = {sourceId: record.sourceId, name: record.name, category: record.category, widthKind: record.category === 'path' ? 'walkway' : 'carriageway', status: 'unmeasured', widthM: null, rangeM: null, evidenceIds: [], insideLengthM: record.insideLengthM, segments: [], roadSurfaceSections: [], officialWidthSections: [], sectionReviews: [], roadSurfaceReviews: []};
    const excluded = record.service === 'parking_aisle' || record.osmTags.access === 'private' ? 'private_or_parking_aisle_not_verified' : record.bridge || record.tunnel || (record.layer && record.layer !== '0') ? 'vertical_alignment_unverified' : record.highway === 'steps' || record.highway === 'cycleway' || record.footway === 'crossing' ? 'stairs_cycleway_or_crossing_not_sidewalk_surface' : null;
    let partOffsetM = 0, metricPartOffsetM = 0;
    for (const [partIndex, line] of record.insideSegments.entries()) {
      for (const [sectionIndex, section] of boundedSections(line, config.sectionLengthM).entries()) {
        const length = section.endM - section.startM, count = Math.ceil(length / config.sampleSpacingM);
        const review = {id: `${record.sourceId}/part-${partIndex}/section-${sectionIndex}`, startM: round(partOffsetM + section.startM), endM: round(partOffsetM + section.endM), localGeometry: section.localGeometry, widthM: null, samples: [], reason: excluded};
        if (!review.reason && (length < config.minimumSectionLengthM || count < config.minimumSamples)) review.reason = 'section_too_short_for_multiple_samples';
        if (!review.reason) {
          review.samples = Array.from({length: count}, (_, i) => { const located = locate(section.localGeometry.coordinates, length * (i + 0.5) / count); return sampleMeasurement(record, located.point, located.tangent, prepared, config, transform); });
          const refs = review.samples.map(sample => sample.centerlineReference).filter(ref => ref && !ref.reason);
          if (refs.length === count) output.officialWidthSections.push({id: review.id, localGeometry: section.localGeometry, widthKind: 'road_outer_curb_or_shoulder', status: 'official_attribute_spatially_matched_not_carriageway', sourceWidthRangeM: [Math.min(...refs.map(ref => ref.widthM)), Math.max(...refs.map(ref => ref.widthM))], evidenceIds: unique(refs.map(ref => ref.evidenceId)), samples: refs});
          if (review.samples.some(sample => sample.reason)) review.reason = unique(review.samples.map(sample => sample.reason).filter(Boolean)).join('; ');
          else {
            const widths = review.samples.map(sample => sample.widthM).sort((a, b) => a - b), median = widths[Math.floor(widths.length / 2)], range = [widths[0], widths.at(-1)];
            const matchedIds = unique(review.samples.map(sample => sample.surfaceId));
            const matchedSurfaces = (record.category === 'path' ? prepared.walkways : prepared.roads).filter(item => matchedIds.includes(item.feature.id));
            if (!continuouslyCovered(section.localGeometry.coordinates, matchedSurfaces, transform)) review.reason = 'section_not_continuously_inside_matched_surface';
            else if ((range[1] - range[0]) / median > config.widthVariationFractionMax) review.reason = 'junction_or_large_width_variation_needs_smaller_reviewed_sections';
            else {
              review.widthM = round(median);
              output.segments.push({id: review.id, localGeometry: section.localGeometry, widthKind: output.widthKind, status: 'measured_estimate', widthM: review.widthM, rangeM: range.map(round), evidenceIds: unique(review.samples.flatMap(sample => sample.evidenceIds)), startM: review.startM, endM: review.endM, sampleCount: count, errorM: null, errorStatus: 'absolute_position_and_width_accuracy_not_supplied', rangeStatus: 'observed_section_variation_not_statistical_accuracy', method: review.samples[0].method, samples: review.samples});
            }
          }
        }
        output.sectionReviews.push(review);
      }
      if (record.category === 'road') {
        const metricLine = line.map(transform.toMetric);
        for (const [sectionIndex, section] of boundedSections(metricLine, config.sectionLengthM).entries()) {
          const review = excluded ? {id: `${record.sourceId}/surface-part-${partIndex}/section-${sectionIndex}`, startM: round(metricPartOffsetM + section.startM), endM: round(metricPartOffsetM + section.endM), reason: excluded} : measureRoadSurfaceReference(record, section, `${record.sourceId}/surface-part-${partIndex}/section-${sectionIndex}`, prepared, config, transform);
          if (!excluded) { review.startM = round(metricPartOffsetM + section.startM); review.endM = round(metricPartOffsetM + section.endM); }
          output.roadSurfaceReviews.push(review);
          if (!review.reason) { const {reason, ...reference} = review; output.roadSurfaceSections.push(reference); }
        }
        metricPartOffsetM += cumulativeLength(metricLine);
      }
      partOffsetM += cumulativeLength(line);
    }
    output.estimatedInsideLengthM = round(output.segments.reduce((sum, segment) => sum + segment.endM - segment.startM, 0));
    output.unmeasuredInsideLengthM = round(Math.max(0, output.insideLengthM - output.estimatedInsideLengthM));
    return output;
  });
  const segments = records.flatMap(record => record.segments);
  const sourceTiles = unique([...(surfaceData.metadata?.audit || []).map(audit => audit.tile), ...surfaceData.features.map(feature => feature.properties.tile)].filter(Boolean)).sort();
  const expectedTileCount = options.expectedBoundaryTileCount ?? null;
  if (expectedTileCount !== null && (!Number.isInteger(expectedTileCount) || expectedTileCount <= 0 || expectedTileCount !== sourceTiles.length)) throw new Error('Expected boundary tile count must match acquired audited tiles.');
  const tileAcquisition = {status: expectedTileCount === null ? 'not_asserted_complete' : 'all_requested_boundary_tiles_acquired', expectedTileCount, acquiredTileCount: sourceTiles.length, individualRoadWidthVerificationComplete: false};
  const reasons = {}, roadSurfaceReasons = {}, walkwayReasons = {};
  for (const review of records.flatMap(record => record.sectionReviews)) if (review.reason) reasons[review.reason] = (reasons[review.reason] || 0) + 1;
  for (const review of records.flatMap(record => record.roadSurfaceReviews)) if (review.reason) roadSurfaceReasons[review.reason] = (roadSurfaceReasons[review.reason] || 0) + 1;
  for (const review of records.filter(record => record.category === 'path').flatMap(record => record.sectionReviews)) if (review.reason) {
    const entry = walkwayReasons[review.reason] ||= {sectionCount: 0, insideLengthM: 0};
    entry.sectionCount++; entry.insideLengthM = round(entry.insideLengthM + review.endM - review.startM);
  }
  const roadSurfaceSections = records.flatMap(record => record.roadSurfaceSections);
  return {schema: 'korea2050.guil.bounded-road-section-widths.v1', sourceFile: 'docs/guro1_plan_2d.geojson', sourceSha256: createHash('sha256').update(JSON.stringify(source)).digest('hex'), sourceHashKind: 'parsed-JSON semantic hash; caller should attach original file SHA for integration', sourceGeometryChanged: false, metricCRS: transform.metricCRS, sourceYear: surfaceData.metadata?.sourceYear ?? null, measurementDate: surfaceData.metadata?.measurementDate ?? null, sourceTiles, tileAcquisition, config: Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'metricTransform')), records,
    summary: {roadLines: records.filter(record => record.category === 'road').length, pathLines: records.filter(record => record.category === 'path').length, parentWayWidthsAssigned: 0, estimatedSectionCount: segments.length, estimatedCarriagewaySections: segments.filter(segment => segment.widthKind === 'carriageway').length, estimatedWalkwaySections: segments.filter(segment => segment.widthKind === 'walkway').length, featuresWithEstimatedSections: records.filter(record => record.segments.length).length, officialWidthReferenceSections: records.reduce((sum, record) => sum + record.officialWidthSections.length, 0), roadSurfaceReferenceSections: roadSurfaceSections.length, roadSurfaceReferenceLengthM: round(roadSurfaceSections.reduce((sum, section) => sum + section.endM - section.startM, 0)), roadSurfaceReferenceFeatures: records.filter(record => record.roadSurfaceSections.length).length, roadSurfaceRejectionReasons: roadSurfaceReasons, estimatedInsideLengthM: round(records.reduce((sum, record) => sum + record.estimatedInsideLengthM, 0)), unmeasuredInsideLengthM: round(records.reduce((sum, record) => sum + record.unmeasuredInsideLengthM, 0)), rejectionReasons: reasons},
    diagnostics: {walkwayCoverage: {measuredSectionCount: segments.filter(segment => segment.widthKind === 'walkway').length, measuredInsideLengthM: round(segments.filter(segment => segment.widthKind === 'walkway').reduce((sum, section) => sum + section.endM - section.startM, 0)), rejectionReasons: walkwayReasons, interpretation: 'These reasons describe original path-line matching failures, not missing tiles or proof that sidewalks do not exist. Path lines include stairs, crossings, bridges and paths outside mapped A003 sidewalk polygons. Width attributes must agree with bounded cross-sections.'}},
    limitations: [expectedTileCount === null ? 'Downloaded tile completeness has not been asserted; no claim that every original road or sidewalk has been surveyed.' : `All ${expectedTileCount} requested boundary tiles are acquired; individual road and sidewalk width verification remains incomplete.`, 'A001 mapped road boundary surfaces have unverified included components and isolated-carriageway meaning; A002 outer-curb/shoulder widths remain separate references unless explicit reviewed semantic evidence enables a carriageway estimate.', 'No automatic A001 minus A003 subtraction; mapped overlap is only a diagnostic without corridor semantics and sidewalk-completeness evidence.', 'At least three cross-section samples are required for each bounded section. Parent ways never receive a single propagated numeric width.', 'Section range describes observed variation; absolute positional accuracy and ground measurement date are unconfirmed.', 'Private parking aisles, vertical-level ambiguity, multiple polygon intersections and incomplete matches remain unmeasured.', surfaceData.metadata?.restrictions || 'Local reference only; redistribution rights require separate review.']};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).flatMap((arg, i, list) => arg.startsWith('--') ? [[arg.slice(2), list[i + 1]]] : []));
  const sourceBytes = await readFile(path.join(root, 'docs/guro1_plan_2d.geojson'));
  const surfacePath = path.resolve(args.surfaces || path.join(root, 'docs/reference/guil_ngii_road_surfaces.geojson'));
  const surfaceBytes = await readFile(surfacePath);
  const source = JSON.parse(sourceBytes), surfaces = JSON.parse(surfaceBytes);
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  if (surfaces.metadata?.sourceSha256 && surfaces.metadata.sourceSha256 !== sourceSha256) throw new Error('Surface reference source SHA256 does not match the unchanged original plan.');
  if (!args.proj4) throw new Error('Use --proj4 <existing proj4.js> for native projected metre measurements; no dependency installation is required.');
  const require = createRequire(import.meta.url), proj4 = require(path.resolve(args.proj4));
  const prjs = unique(surfaces.metadata.audit.map(audit => audit.prjWkt));
  if (prjs.length !== 1) throw new Error('Multiple native PRJs need per-layer transforms before measurement.');
  const result = measureRoadSections(source, surfaces, {metricTransform: createMetricTransform(source.metadata.coordinate_system, proj4, prjs[0]), expectedBoundaryTileCount: args['expected-tile-count'] === undefined ? null : Number(args['expected-tile-count'])});
  result.sourceSha256 = sourceSha256;
  result.sourceHashKind = 'original file SHA256';
  result.surfaceReferenceFile = path.relative(root, surfacePath).split(path.sep).join('/');
  result.surfaceReferenceSha256 = createHash('sha256').update(surfaceBytes).digest('hex');
  if (args['omit-reviews'] === 'true') {
    for (const record of result.records) { delete record.sectionReviews; delete record.roadSurfaceReviews; }
    result.detailReviewStorage = 'Full rejected-section reviews omitted; bounded width/reference samples and rejection counts retained.';
  }
  if (args.output) await writeFile(path.resolve(args.output), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({summary: result.summary, sourceTiles: result.sourceTiles}, null, 2));
}
