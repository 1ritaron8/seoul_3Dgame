import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {buildPilotScene, PILOT_BUILDING_ID, PILOT_ROAD_ID, PILOT_PROFILE_IDS} from './pilot_scene.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLAN_FILE = 'docs/guil_2050_plan.json';
const SURFACE_FILE = 'docs/reference/guil_ngii_road_surfaces.geojson';
const OUTPUT_FILE = 'docs/guil_2050_pilot3d.json';
const SITE_EVIDENCE_FILE = 'docs/reference/guil_pilot_site_evidence.json';
const GENERATOR_FILES = ['tools/pilot_scene.mjs', 'tools/build_pilot_scene.mjs', 'tools/future_apartment.mjs', 'web/apartment-modules.mjs', 'web/pilot-environment.mjs'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };

export async function buildPilotSceneFile(rootDir = root) {
  const planBytes = await readFile(path.join(rootDir, PLAN_FILE));
  const plan = JSON.parse(planBytes);
  const sourceFile = plan.sourceFile;
  check(sourceFile === 'docs/guro1_plan_2d.geojson', 'Pilot source must remain the established local 2D source.');
  const [sourceBytes, surfaceBytes, siteEvidenceBytes, ...generatorBytes] = await Promise.all([
    sourceFile, SURFACE_FILE, SITE_EVIDENCE_FILE, ...GENERATOR_FILES
  ].map(file => readFile(path.join(rootDir, file))));
  check(hash(sourceBytes) === plan.sourceSha256, 'Current plan does not match the unchanged original 2D source.');
  const source = JSON.parse(sourceBytes), surfaceSource = JSON.parse(surfaceBytes);
  const siteEvidence = JSON.parse(siteEvidenceBytes);
  const target = source.features.find(feature => String(feature.id) === PILOT_BUILDING_ID);
  check(target?.properties.name === '118', 'Source way/252997590 must be original building 118.');
  const plannedTarget = plan.features.find(feature => feature.id === PILOT_BUILDING_ID);
  check(JSON.stringify(target.properties.local_geometry_m) === JSON.stringify(plannedTarget?.geometry), '118 source geometry changed in the plan.');
  const reviewed = plan.features.find(feature => feature.id === PILOT_ROAD_ID)?.roadCrossProfiles?.filter(profile => PILOT_PROFILE_IDS.includes(profile.id));
  check(reviewed?.length === 2, 'Pilot requires exactly the two scoped reviewed profiles.');
  const surfaceSha256 = hash(surfaceBytes);
  check(surfaceSource.metadata.sourceSha256 === plan.sourceSha256 && reviewed.every(profile => profile.evidence.surfaceSha256 === surfaceSha256), 'Reviewed surfaces do not match the actual current source bytes.');
  const evidencePaths = [...new Set(reviewed.flatMap(profile => profile.evidence.images.map(image => image.path)))].sort();
  const evidenceFiles = await Promise.all(evidencePaths.map(async file => {
    check(file.startsWith('docs/reference/road-width-evidence/') && !file.includes('..') && !path.isAbsolute(file), 'Pilot evidence path must stay in the established local evidence folder.');
    const sha256 = hash(await readFile(path.join(rootDir, file)));
    check(reviewed.flatMap(profile => profile.evidence.images).filter(image => image.path === file).every(image => image.sha256 === sha256), `Changed reviewed evidence image: ${file}`);
    return {path: file, sha256};
  }));
  const scene = buildPilotScene(plan, {
    planFile: PLAN_FILE, planSha256: hash(planBytes), surfaceFile: SURFACE_FILE, surfaceSha256,
    sourceFeatureNames: Object.fromEntries(source.features.map(feature => [String(feature.id), feature.properties.name ?? null])),
    generatorFiles: GENERATOR_FILES.map((file, index) => ({path: file, sha256: hash(generatorBytes[index])})),
    siteEvidence, siteEvidenceFile: {path: SITE_EVIDENCE_FILE, sha256: hash(siteEvidenceBytes)}, evidenceFiles
  });
  const sourceById = new Map(source.features.map(feature => [String(feature.id), feature]));
  for (const building of [scene.building, ...scene.contextBuildings]) {
    check(JSON.stringify(building.geometryLocalM) === JSON.stringify(sourceById.get(building.sourceId)?.properties.local_geometry_m), `Changed source building geometry: ${building.sourceId}`);
  }
  for (const zone of scene.contextZones) {
    check(JSON.stringify(zone.geometryLocalM) === JSON.stringify(sourceById.get(zone.sourceId)?.properties.local_geometry_m), `Changed source zone geometry: ${zone.sourceId}`);
  }
  const surfaceById = new Map(surfaceSource.features.map(feature => [String(feature.id), feature]));
  for (const surface of scene.surfaces) {
    check(JSON.stringify(surface.geometryLocalM) === JSON.stringify(surfaceById.get(surface.id)?.properties.local_geometry_m), `Changed source surface geometry: ${surface.id}`);
  }
  // Source files are read-only. Only this deterministic derivative is written.
  await writeFile(path.join(rootDir, OUTPUT_FILE), JSON.stringify(scene, null, 2) + '\n');
  return scene;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scene = await buildPilotSceneFile();
  console.log(`Built ${OUTPUT_FILE}: 118 + ${scene.contextBuildings.length} context outlines, ${scene.surfaces.length} full surfaces, ${scene.roadProfiles.length} reviewed profiles; local-only ${scene.provenance.generationSha256}`);
}
