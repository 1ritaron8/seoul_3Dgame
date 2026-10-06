import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {exportApartmentAssets} from './apartment_asset_export.mjs';

const root = new URL('../', import.meta.url);
const plan = await readFile(new URL('docs/guil_2050_plan.json', root));
const scene = JSON.parse(await readFile(new URL('docs/guil_2050_pilot3d.json', root), 'utf8'));
if (scene.provenance?.planSha256 !== createHash('sha256').update(plan).digest('hex')) throw new Error('3D source is stale. Run build:pilot before exporting.');
const output = new URL('exports/guil2050_118/', root);
const {files, manifest} = await exportApartmentAssets(scene.futureDesign);
await mkdir(output, {recursive: true});
for (const file of files) {
  await writeFile(new URL(file.filename, output), file.bytes);
  manifest.assets.find(record => record.filename === file.filename).sha256 = createHash('sha256').update(file.bytes).digest('hex');
}
await writeFile(new URL('manifest.json', output), JSON.stringify(manifest, null, 2) + '\n');
console.log(`118 exterior: ${files.length} GLB files; ${manifest.assets[0].sourcePieces} source pieces baked to ${manifest.assets[0].mergedMeshCount} named meshes.`);
console.log('Output: exports/guil2050_118/ (no GIS/site source; Unreal import and performance remain unverified).');
