import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {makeRoadInventory} from './road_widths.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const snapshotPath = path.join(root, 'docs/reference/guil_official_road_widths.json');
const criteria = {sampleIntervalM: 10, meanDistanceMaxM: 6, maxSampleDistanceMaxM: 12, endpointDistanceMaxM: 12, nearDistanceM: 8, headingMaxDegrees: 25, nearAlignedFractionMin: 0.8, conflictDistanceMarginM: 2, minimumInsideLengthM: 20};
const round = value => Number(value.toFixed(6));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const parts = geometry => geometry.type === 'LineString' ? [geometry.coordinates] : geometry.type === 'MultiLineString' ? geometry.coordinates : [];

function lineSegments(lines) {
  return lines.flatMap(line => line.slice(1).map((b, index) => {
    const a = line[index];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return {a, b, length};
  })).filter(segment => segment.length > 0);
}

function nearest(point, tangent, segments) {
  let distance = Infinity;
  let headingCos = 0;
  for (const segment of segments) {
    const dx = segment.b[0] - segment.a[0];
    const dy = segment.b[1] - segment.a[1];
    const t = Math.max(0, Math.min(1, ((point[0] - segment.a[0]) * dx + (point[1] - segment.a[1]) * dy) / segment.length ** 2));
    const candidateDistance = Math.hypot(point[0] - segment.a[0] - t * dx, point[1] - segment.a[1] - t * dy);
    if (candidateDistance < distance) {
      distance = candidateDistance;
      headingCos = Math.abs((tangent[0] * dx + tangent[1] * dy) / segment.length);
    }
  }
  return {distance, headingCos};
}

function samples(lines) {
  return lineSegments(lines).flatMap(segment => {
    const count = Math.max(1, Math.ceil(segment.length / criteria.sampleIntervalM));
    const dx = segment.b[0] - segment.a[0];
    const dy = segment.b[1] - segment.a[1];
    return Array.from({length: count}, (_, index) => ({
      point: [segment.a[0] + dx * (index + 0.5) / count, segment.a[1] + dy * (index + 0.5) / count],
      tangent: [dx / segment.length, dy / segment.length], weight: segment.length / count
    }));
  });
}

function metric(record, official, coordinateSystem) {
  const projected = parts(official.geometry).map(line => line.map(point => [
    (point[0] - coordinateSystem.origin_lon_lat[0]) * coordinateSystem.meters_per_degree_lon,
    (point[1] - coordinateSystem.origin_lon_lat[1]) * coordinateSystem.meters_per_degree_lat
  ]));
  const officialSegments = lineSegments(projected);
  if (!officialSegments.length) throw new Error(`Official line has no length: ${official.id}`);
  const matches = samples(record.insideSegments).map(sample => ({...nearest(sample.point, sample.tangent, officialSegments), weight: sample.weight}));
  const cosine = Math.cos(criteria.headingMaxDegrees * Math.PI / 180);
  const meanDistanceM = matches.reduce((sum, match) => sum + match.distance * match.weight, 0) / record.insideLengthM;
  const maxSampleDistanceM = Math.max(...matches.map(match => match.distance));
  const nearAlignedFraction = matches.filter(match => match.distance <= criteria.nearDistanceM && match.headingCos >= cosine).reduce((sum, match) => sum + match.weight, 0) / record.insideLengthM;
  const endpointDistancesM = record.insideSegments.flatMap(line => [nearest(line[0], [1, 0], officialSegments).distance, nearest(line.at(-1), [1, 0], officialSegments).distance]);
  const geometricallyClose = meanDistanceM <= criteria.meanDistanceMaxM && maxSampleDistanceM <= criteria.maxSampleDistanceMaxM && nearAlignedFraction >= criteria.nearAlignedFractionMin && endpointDistancesM.every(distance => distance <= criteria.endpointDistanceMaxM);
  return {meanDistanceM: round(meanDistanceM), maxSampleDistanceM: round(maxSampleDistanceM), nearAlignedFraction: round(nearAlignedFraction), endpointDistancesM: endpointDistancesM.map(round), insideLengthM: round(record.insideLengthM), sampleCount: matches.length, geometricallyClose};
}

export function buildRoadWidthData(source, snapshot, north, sourceSha256) {
  const inventory = makeRoadInventory(source);
  const official = new Map(snapshot.official.features.map(feature => [feature.id, feature]));
  if (official.size !== snapshot.official.features.length) throw new Error('Duplicate official feature IDs.');
  for (const feature of official.values()) {
    if (!Number.isFinite(feature.properties.road_bt) || feature.properties.road_bt <= 0) throw new Error(`Invalid official corridor width: ${feature.id}`);
    if (!parts(feature.geometry).length || !parts(feature.geometry).every(line => line.length >= 2 && line.every(point => point.length === 2 && point.every(Number.isFinite)))) throw new Error(`Invalid official WGS84 geometry: ${feature.id}`);
  }
  const report = snapshot.candidateReport;
  const originalCandidates = new Map(report.candidates.map(candidate => [candidate.original_feature_id, candidate]));
  if (originalCandidates.size !== report.candidates.length) throw new Error('Duplicate original candidate IDs.');
  const references = new Map();
  const closeAudit = [];
  function reference(feature) {
    if (!references.has(feature.id)) {
      const p = feature.properties;
      if (!Number.isFinite(p.road_bt) || p.road_bt <= 0) throw new Error(`Invalid official corridor width: ${feature.id}`);
      references.set(feature.id, {
        id: feature.id, sourceId: 'smap-roadname', roadName: p.rn, widthKind: 'road_corridor_reference', corridorWidthM: p.road_bt,
        status: 'official_administrative_attribute', sigCode: p.sig_cd, roadSectionId: p.rds_man_no, dependencyCode: p.rds_dpn_se,
        sourceWorkTimestamp: p.opert_de, sourceWorkTimestampMeaning: 'administrative update time; actual survey date unconfirmed',
        retrievedOn: snapshot.retrievedOn, associations: [],
        limitation: 'ROAD_BT represents the wider part of an administrative road section; carriageway/sidewalk separation and width-change locations are unavailable.'
      });
    }
    return references.get(feature.id);
  }
  const records = inventory.map(item => {
    const record = {...item, widthKind: item.category === 'path' ? 'walkway' : 'carriageway', status: 'unmeasured', widthM: null, rangeM: null, evidenceIds: [], officialReferenceIds: [], mapRepresentationEvidenceIds: []};
    const candidate = originalCandidates.get(item.sourceId);
    if (item.category === 'path') {
      record.officialAssociationStatus = 'no_sidewalk_width_geometry_available';
      record.officialCandidateReviews = [];
      return record;
    }
    if (!candidate) throw new Error(`Missing road candidate review: ${item.sourceId}`);
    record.originalAssociationStatus = candidate.association_status;
    const reviews = candidate.candidates.map(original => {
      const feature = official.get(original.official_feature_id);
      if (!feature) throw new Error(`Unknown official candidate: ${original.official_feature_id}`);
      if (original.road_width_admin_m !== feature.properties.road_bt) throw new Error(`Candidate width differs from official source: ${feature.id}`);
      const insideMetrics = metric(item, feature, source.metadata.coordinate_system);
      return {officialReferenceId: feature.id, roadName: feature.properties.rn, corridorWidthM: feature.properties.road_bt,
        nameEqual: item.name === feature.properties.rn && !!item.name, originalFullLineMetrics: structuredClone(original), insideMetrics};
    }).sort((a, b) => a.insideMetrics.meanDistanceM - b.insideMetrics.meanDistanceM);
    const best = reviews[0];
    const close = reviews.filter(review => review.insideMetrics.geometricallyClose && review.insideMetrics.meanDistanceM <= best.insideMetrics.meanDistanceM + criteria.conflictDistanceMarginM);
    const conflict = new Set(close.map(review => review.corridorWidthM)).size > 1;
    const initiallyClose = ['geometrically_close_candidate', 'multiple_width_candidates'].includes(candidate.association_status);
    record.officialAssociationStatus = item.insideLengthM < criteria.minimumInsideLengthM ? 'insufficient_in_boundary_length' : !initiallyClose || !best.insideMetrics.geometricallyClose ? 'requires_review' : conflict || candidate.association_status === 'multiple_width_candidates' ? 'multiple_width_references' : 'geometrically_close_reference';
    record.officialCandidateReviews = reviews;
    record.officialLevelStatus = item.tunnel || item.bridge || item.layer ? 'bridge_tunnel_or_layer_alignment_unverified' : 'official_vertical_alignment_unverified';
    if (['geometrically_close_reference', 'multiple_width_references'].includes(record.officialAssociationStatus)) {
      record.officialReferenceIds = close.map(review => review.officialReferenceId);
      // Retain original conflicts even when inside clipping changes the nearest rank.
      if (candidate.association_status === 'multiple_width_candidates') record.officialReferenceIds = [...new Set([...record.officialReferenceIds, ...candidate.candidates.filter(original => original.mean_distance_m <= candidate.candidates[0].mean_distance_m + criteria.conflictDistanceMarginM && original.within_8m_and_25deg_fraction >= criteria.nearAlignedFractionMin).map(original => original.official_feature_id)])];
    }
    for (const review of reviews) {
      const ref = reference(official.get(review.officialReferenceId));
      ref.associations.push({sourceId: item.sourceId, associationStatus: record.officialAssociationStatus, eligibleReference: record.officialReferenceIds.includes(ref.id), metrics: review.insideMetrics, levelStatus: record.officialLevelStatus});
    }
    if (candidate.association_status === 'geometrically_close_candidate') closeAudit.push({sourceId: item.sourceId, status: record.officialAssociationStatus, bestOfficialReferenceId: best.officialReferenceId, insideMetrics: best.insideMetrics});
    return record;
  });
  const mapRepresentationReferences = north.features.filter(feature => feature.properties.width_estimate_m != null).map(feature => {
    const p = feature.properties;
    if (p.width_status !== 'map_representation_range_not_ground_measurement' || !Array.isArray(p.width_estimate_m) || p.width_estimate_m.length !== 2 || !p.width_estimate_m.every(Number.isFinite)) throw new Error(`Invalid map representation width: ${feature.id}`);
    for (const id of p.source_geometry_ids || []) {
      const record = records.find(record => record.sourceId === id);
      if (!record) throw new Error(`Unknown map representation source: ${id}`);
      record.mapRepresentationEvidenceIds.push(feature.id);
    }
    return {id: feature.id, sourceId: 'north-map-representation', sourceIds: p.source_geometry_ids, name: p.name, status: 'inferred_range', widthKind: 'combined_map_representation', widthM: null, rangeM: [...p.width_estimate_m], observedOn: p.observed_on, sourceURL: p.sourceURL, limitation: 'Map-styled road/sidewalk ribbon estimate; no separate actual carriageway or sidewalk measurement.'};
  });
  const byName = new Map();
  for (const ref of references.values()) {
    if (!ref.associations.some(association => association.eligibleReference)) continue;
    if (!byName.has(ref.roadName)) byName.set(ref.roadName, []);
    byName.get(ref.roadName).push(ref);
  }
  const roadNameSummary = [...byName].map(([roadName, refs]) => ({roadName, corridorWidthsM: [...new Set(refs.map(ref => ref.corridorWidthM))].sort((a, b) => a - b), officialReferenceIds: refs.map(ref => ref.id), sourceIds: [...new Set(refs.flatMap(ref => ref.associations.filter(association => association.eligibleReference).map(association => association.sourceId)))], widthChangeLocations: 'unavailable', actualCarriagewayWidthM: null, actualSidewalkWidthM: null}));
  const statusCounts = records.reduce((counts, record) => ({...counts, [record.officialAssociationStatus]: (counts[record.officialAssociationStatus] || 0) + 1}), {});
  return {
    schema: 'korea2050.guil.road-width-evidence.v1', createdOn: snapshot.retrievedOn, sourceFile: 'docs/guro1_plan_2d.geojson', sourceSha256,
    scope: 'Every original road/path line with nonzero geometry inside the provisional boundary. Original coordinates are retained; derived intervals provide display scope only.',
    coordinateSystem: source.metadata.coordinate_system, boundaryStatus: source.metadata.boundary_status,
    measurementStatus: 'actual_carriageway_and_sidewalk_widths_unmeasured',
    records, officialReferences: [...references.values()],
    officialRoadClass: [...references.values()].filter(ref => ref.associations.some(association => association.eligibleReference)).map(ref => ({officialReferenceId: ref.id, roadName: ref.roadName, widthKind: 'road_corridor_reference', corridorWidthM: ref.corridorWidthM, sourceIds: ref.associations.filter(association => association.eligibleReference).map(association => association.sourceId), actualCarriagewayWidthM: null})),
    mapRepresentationReferences, roadNameSummary,
    sources: snapshot.sources,
    matching: {initialMethod: report.method, initialMetricCRS: report.metric_crs, insideMethod: 'Length-weighted midpoint samples <=10m, endpoint checks and tangent alignment in the existing local linear metre coordinates; original top-three candidates rechecked only. No new unreviewed associations are promoted.', criteria, initialSummary: report.summary, closeCandidateAudit: closeAudit},
    summary: {roadLines: records.filter(record => record.category === 'road').length, pathLines: records.filter(record => record.category === 'path').length, actualMeasuredWidths: 0, unmeasuredWidths: records.length, mapRepresentationRanges: mapRepresentationReferences.length, officialFeatureCount: snapshot.official.features.length, officialAssociationCounts: statusCounts, initialCloseCandidatesReviewed: closeAudit.length, roadNameReferenceCount: roadNameSummary.length},
    limitations: [
      'ROAD_BT is an administrative road-section corridor reference. It is never applied as measured carriageway or sidewalk width.',
      'Administrative timestamps do not establish the date of ground measurement. Width changes and left/right sidewalk boundaries have not been located.',
      'Geometric proximity does not verify elevation, access or the identity of overlapping ramps, bridges and tunnels.',
      'An inherited conflict remains unresolved; short boundary fragments below 20m are not promoted to a corridor association.',
      'The current official top-three candidate list may omit alternatives; rejected or unmatched lines remain unmeasured.',
      'Future authorized survey-map files can supply measured-estimate records and evidence IDs without changing original source geometry.'
    ]
  };
}

export async function writeRoadWidthData(officialDirectory = null) {
  const sourceBytes = await readFile(path.join(root, 'docs/guro1_plan_2d.geojson'));
  const source = JSON.parse(sourceBytes);
  const north = JSON.parse(await readFile(path.join(root, 'docs/reference/guro1_plan_north.json'), 'utf8'));
  let snapshot;
  if (officialDirectory) {
    const [official, candidateReport, manifest] = await Promise.all(['smap_guro1_roadname_centerlines.geojson', 'smap_road_width_match_candidates.json', 'acquisition_manifest.json'].map(async name => JSON.parse(await readFile(path.join(officialDirectory, name), 'utf8'))));
    const fields = ['rn', 'road_bt', 'sig_cd', 'rds_man_no', 'rds_dpn_se', 'opert_de'];
    snapshot = {schema: 'korea2050.guil.public-road-width-reference.v1', retrievedOn: manifest.retrieved_on,
      official: {type: 'FeatureCollection', coordinateSystem: 'WGS84 longitude, latitude (EPSG:4326)', features: official.features.map(feature => ({type: 'Feature', id: feature.id, geometry: feature.geometry, properties: Object.fromEntries(fields.map(field => [field, feature.properties[field]]))}))},
      candidateReport: {...candidateReport, source_original: 'docs/guro1_plan_2d.geojson'},
      sources: [{id: 'smap-roadname', title: '서울 S-Map 도로명주소 도로구간', url: manifest.smap_roadname.official_home, queryURL: manifest.smap_roadname.query_url, query: manifest.smap_roadname.query, retrievedOn: manifest.retrieved_on, widthField: 'ROAD_BT', unit: 'metres', unitSourceURL: manifest.smap_roadname.unit_source, semanticSourceURL: manifest.smap_roadname.width_semantic_constraint_source, reuseLicenseStatus: 'not established by WFS public-access declaration'}, {id: 'north-map-representation', title: '기존 북부 지도 도로띠 관찰', file: 'docs/reference/guro1_plan_north.json', observedOn: north.observed_on}]};
  } else snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  const result = buildRoadWidthData(source, snapshot, north, sha256(sourceBytes));
  if (officialDirectory) await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n');
  await writeFile(path.join(root, 'docs/guil_road_widths.json'), JSON.stringify(result, null, 2) + '\n');
  const afterHash = sha256(await readFile(path.join(root, 'docs/guro1_plan_2d.geojson')));
  if (afterHash !== result.sourceSha256) throw new Error('Original source changed during road-width generation.');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf('--official-dir');
  if (flag !== -1 && !process.argv[flag + 1]) throw new Error('--official-dir requires a path.');
  const result = await writeRoadWidthData(flag === -1 ? null : path.resolve(process.argv[flag + 1]));
  console.log(JSON.stringify({summary: result.summary, roadNameSummary: result.roadNameSummary}, null, 2));
}
