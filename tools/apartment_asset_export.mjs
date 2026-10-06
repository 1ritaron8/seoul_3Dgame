import * as THREE from 'three';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {createFutureApartment, disposeArchitecture} from '../web/pilot-architecture.mjs';
import {APARTMENT_DETAIL_PROFILE, createApartmentModuleLayout} from '../web/apartment-modules.mjs';

const check = (condition, message) => { if (!condition) throw new Error(`Apartment export: ${message}`); };
const centimetres = value => Number((value * 100).toFixed(4));

// Three r180's binary exporter needs only this browser API for texture-free GLB output.
// No image/canvas polyfill, native executable, package installation or network fetch is used.
function ensureBinaryBlobReader() {
  if (globalThis.FileReader) return;
  globalThis.FileReader = class BinaryBlobReader {
    readAsArrayBuffer(blob) {
      check(blob instanceof Blob, 'binary reader requires a Blob.');
      blob.arrayBuffer().then(result => {
        this.result = result; this.onload?.({target: this}); this.onloadend?.({target: this});
      }).catch(error => { this.error = error; this.onerror?.({target: this}); this.onloadend?.({target: this}); });
    }
  };
}

const windowBatches = new Set(['long-facade-window-frames', 'long-facade-windows', 'long-facade-window-gaskets', 'long-facade-window-sills', 'adaptive-facade-screens']);
const balconyBatches = new Set(['balcony-sunshade-ledges', 'balcony-glass-guards', 'balcony-rail-top', 'balcony-rail-ends', 'balcony-rail-posts', 'balcony-rail-bases', 'paired-balcony-privacy-panels']);

/** Bake local transforms and instances into a modest number of named, ordinary meshes.
 * This deliberately avoids requiring EXT_mesh_gpu_instancing from the target importer.
 * It never traverses the GIS site, road, parking or neighbouring-building groups.
 */
export function prepareApartmentAsset(buildingRoot, selection) {
  check(buildingRoot?.name === 'future-building-local', 'only the authored, building-local exterior may be exported.');
  check(['building', 'entrance', 'window-bay', 'balcony-pair'].includes(selection?.id), 'unknown asset selection.');
  check(selection.pivotM?.length === 3 && selection.pivotM.every(Number.isFinite), 'asset pivot must be finite local metres.');
  buildingRoot.updateWorldMatrix(true, true);
  const inverseRoot = buildingRoot.matrixWorld.clone().invert();
  const toPivot = new THREE.Matrix4().makeTranslation(...selection.pivotM.map(value => -value));
  const buckets = new Map(), ownedMaterials = new Map();
  let sourcePieces = 0;
  const instanceMatrix = new THREE.Matrix4();
  function append(object, transform, metadata) {
    check(object.geometry?.getAttribute('position') && !Array.isArray(object.material) && object.material?.isMeshStandardMaterial, 'only single-material PBR geometry is supported.');
    check(!Object.values(object.material).some(value => value?.isTexture), 'texture assets require a separately verified export path.');
    const positions = object.geometry.getAttribute('position');
    check(Array.from(positions.array).every(Number.isFinite) && transform.elements.every(Number.isFinite) && transform.determinant() > 0, 'geometry or transform is invalid.');
    const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
    geometry.clearGroups(); geometry.applyMatrix4(toPivot.clone().multiply(transform));
    const leaf = ['entrance-left-leaf', 'entrance-right-leaf'].includes(object.parent?.name) ? object.parent.name : null;
    const key = `${leaf ?? 'fixed'}|${object.name}|${object.material.name}`;
    if (!buckets.has(key)) buckets.set(key, {name: object.name, leaf, material: object.material, geometries: [], sourcePieces: 0});
    const bucket = buckets.get(key);
    bucket.geometries.push(geometry); bucket.sourcePieces++;
    sourcePieces++;
  }
  buildingRoot.traverse(object => {
    if (!object.isMesh) return;
    const local = inverseRoot.clone().multiply(object.matrixWorld);
    if (selection.id === 'entrance') {
      let parent = object;
      while (parent && parent !== buildingRoot && parent.name !== 'double-leaf-entrance-module') parent = parent.parent;
      if (parent?.name !== 'double-leaf-entrance-module') return;
    }
    if (selection.id === 'window-bay' && !windowBatches.has(object.name)) return;
    if (selection.id === 'balcony-pair' && !balconyBatches.has(object.name)) return;
    if (object.isInstancedMesh) {
      check(object.userData.instances?.length === object.count, 'instance metadata count does not match geometry.');
      for (let index = 0; index < object.count; index++) {
        const metadata = object.userData.instances[index];
        if (['window-bay', 'balcony-pair'].includes(selection.id) && (metadata.side !== 'north' || metadata.floorIndex !== 0 ||
          (selection.id === 'window-bay' ? metadata.bayIndex !== 0 : metadata.groupIndex !== 0))) continue;
        object.getMatrixAt(index, instanceMatrix);
        append(object, local.clone().multiply(instanceMatrix), metadata);
      }
    } else append(object, local);
  });
  check(sourcePieces > 0, 'asset selection must not be empty.');
  const asset = new THREE.Group(); asset.name = selection.name;
  asset.userData = {units: 'metres', authoredExteriorOnly: true, detailProfileId: APARTMENT_DETAIL_PROFILE.id, selection: selection.id};
  const leaves = new Map();
  try {
    for (const bucket of buckets.values()) {
      const geometry = mergeGeometries(bucket.geometries, false);
      check(geometry, 'merged mesh attributes must agree.');
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      if (!ownedMaterials.has(bucket.material)) ownedMaterials.set(bucket.material, bucket.material.clone());
      const mesh = new THREE.Mesh(geometry, ownedMaterials.get(bucket.material));
      mesh.name = bucket.name; mesh.userData = {sourcePieces: bucket.sourcePieces};
      if (bucket.leaf) {
        if (!leaves.has(bucket.leaf)) { const group = new THREE.Group(); group.name = bucket.leaf; asset.add(group); leaves.set(bucket.leaf, group); }
        leaves.get(bucket.leaf).add(mesh);
      } else asset.add(mesh);
    }
    asset.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(asset, true);
    const triangleCount = [...buckets.values()].reduce((sum, bucket) => sum + bucket.geometries.reduce((value, geometry) => value + geometry.getAttribute('position').count / 3, 0), 0);
    asset.userData.summary = {
      sourcePieces, mergedMeshCount: buckets.size, triangleCount,
      boundsM: {min: bounds.min.toArray(), max: bounds.max.toArray()},
      materials: [...ownedMaterials.values()].map(value => value.name)
    };
    return asset;
  } catch (error) { disposeArchitecture(asset); throw error; }
  finally { for (const bucket of buckets.values()) bucket.geometries.forEach(geometry => geometry.dispose()); }
}

export async function encodeApartmentGlb(asset) {
  check(asset?.userData.authoredExteriorOnly === true, 'only a prepared authored exterior asset is accepted.');
  ensureBinaryBlobReader();
  const buffer = await new GLTFExporter().parseAsync(asset, {binary: true, onlyVisible: true, includeCustomExtensions: false, trs: true});
  check(buffer instanceof ArrayBuffer && buffer.byteLength > 20, 'export did not produce a GLB.');
  return new Uint8Array(buffer);
}

export function inspectApartmentGlb(bytes) {
  check(bytes instanceof Uint8Array && bytes.byteLength >= 28, 'GLB is missing or truncated.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  check(view.getUint32(0, true) === 0x46546c67 && view.getUint32(4, true) === 2 && view.getUint32(8, true) === bytes.byteLength, 'invalid GLB header.');
  let offset = 12;
  const chunks = [];
  while (offset < bytes.byteLength) {
    check(offset + 8 <= bytes.byteLength, 'truncated GLB chunk header.');
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
    check(length % 4 === 0 && offset + 8 + length <= bytes.byteLength, 'invalid GLB chunk length.');
    chunks.push({type, bytes: bytes.subarray(offset + 8, offset + 8 + length)}); offset += 8 + length;
  }
  check(chunks.length === 2 && chunks[0].type === 0x4e4f534a && chunks[1].type === 0x004e4942, 'expected embedded JSON and BIN chunks only.');
  const json = JSON.parse(new TextDecoder().decode(chunks[0].bytes));
  check(json.asset?.version === '2.0' && json.buffers?.length === 1 && !json.buffers[0].uri && json.buffers[0].byteLength <= chunks[1].bytes.byteLength, 'asset must be a self-contained glTF 2.0 buffer.');
  check(!json.images?.length && !json.textures?.length && !json.animations?.length && !json.skins?.length && !json.cameras?.length, 'only authored static texture-free exterior geometry is accepted.');
  check(!json.extensionsRequired?.length && !json.extensionsUsed?.includes('EXT_mesh_gpu_instancing'), 'export must not require GPU instancing or other extensions.');
  for (const bufferView of json.bufferViews ?? []) check(bufferView.buffer === 0 && (bufferView.byteOffset ?? 0) >= 0 && bufferView.byteLength > 0 && (bufferView.byteOffset ?? 0) + bufferView.byteLength <= json.buffers[0].byteLength, 'buffer view exceeds binary data.');
  return {json, binary: chunks[1].bytes};
}

/** Actually reload the generated file, not merely trust the exporter to keep the geometry. */
export async function verifyApartmentGlb(bytes, expected) {
  const {json} = inspectApartmentGlb(bytes);
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const loaded = await new GLTFLoader().parseAsync(data, '');
  try {
    let meshes = 0, triangles = 0;
    loaded.scene.traverse(object => {
      if (!object.isMesh) return;
      check(!object.isInstancedMesh, 'round trip must produce ordinary meshes.');
      meshes++;
      const positions = object.geometry.getAttribute('position'), normals = object.geometry.getAttribute('normal'), uv = object.geometry.getAttribute('uv');
      check(positions && normals?.count === positions.count && uv?.count === positions.count, 'position, normal and UV0 must survive.');
      for (const attribute of [positions, normals, uv]) check(Array.from(attribute.array).every(Number.isFinite), 'round-trip geometry contains a nonfinite value.');
      triangles += (object.geometry.index?.count ?? positions.count) / 3;
    });
    const box = new THREE.Box3().setFromObject(loaded.scene, true);
    check(meshes === expected.mergedMeshCount && triangles === expected.triangleCount, 'a mesh or repeated instance was lost during export.');
    for (const [key, point] of [['min', box.min], ['max', box.max]]) point.toArray().forEach((value, axis) => check(Math.abs(value - expected.boundsM[key][axis]) <= 1e-4, 'round-trip bounds changed.'));
    check(json.materials.length === expected.materials.length && expected.materials.every(name => json.materials.some(material => material.name === name)), 'named material slots were lost.');
    return {status: 'passed', meshCount: meshes, triangleCount: triangles, toleranceM: .0001};
  } finally { disposeArchitecture(loaded.scene); }
}

/** Return the whole exterior plus three identical-detail reusable component files. */
export async function exportApartmentAssets(design) {
  check(THREE.REVISION === '180', 'use the existing Three.js 0.180.0 runtime; no automatic installation.');
  const scene = createFutureApartment(design, design.frame.centerLocalM);
  const root = scene.getObjectByName('future-building-local');
  const layout = createApartmentModuleLayout(design.building);
  const definitions = [
    {id: 'building', name: 'SM_Guil2050_118_Exterior', filename: 'guil2050_118_exterior.glb', pivotM: [0, 0, 0]},
    {id: 'entrance', name: 'SM_Guil2050_DoubleEntrance', filename: 'module_double_entrance.glb', pivotM: [0, 0, -design.building.depthM / 2]},
    {id: 'window-bay', name: 'SM_Guil2050_WindowBay', filename: 'module_window_bay.glb', pivotM: [layout.bays[0].centreM, layout.floorRows[0].bottomM, -design.building.depthM / 2]},
    {id: 'balcony-pair', name: 'SM_Guil2050_BalconyPair', filename: 'module_balcony_pair.glb', pivotM: [layout.groups[0].centreM, layout.floorRows[0].bottomM, -design.building.depthM / 2]}
  ];
  const files = [], records = [];
  try {
    for (const definition of definitions) {
      const asset = prepareApartmentAsset(root, definition);
      try {
        const bytes = await encodeApartmentGlb(asset);
        const roundTrip = await verifyApartmentGlb(bytes, asset.userData.summary);
        files.push({filename: definition.filename, bytes});
        records.push({...definition, byteLength: bytes.byteLength, ...structuredClone(asset.userData.summary), roundTrip});
      } finally { disposeArchitecture(asset); }
    }
  } finally { disposeArchitecture(scene); }
  return {files, manifest: {
    schema: 'guil-apartment-assets.v1', status: 'glb_generated_and_local_roundtrip_tested_not_unreal_imported',
    generator: 'Three.js 0.180.0 GLTFExporter', units: 'metres', coordinateSystem: 'right_handed_y_up', frontDirection: '-Z',
    pivot: 'building_centre_at_ground_or_module_origin_no_map_placement',
    detailProfile: structuredClone(APARTMENT_DETAIL_PROFILE), nominalBuildingDimensionsM: {length: design.building.lengthM, depth: design.building.depthM, height: design.building.heightM},
    expectedUnrealDimensionsCm: {length: centimetres(design.building.lengthM), depth: centimetres(design.building.depthM), height: centimetres(design.building.heightM)},
    importChecks: {useGltfUnitConversionOnce: true, doNotApplyAnExtraActorScaleOf100: true, verifyDoorLeafCm: centimetres(layout.entrance.doorLeafWidthM), verifyBuildingHeightCm: centimetres(design.building.heightM)},
    geometry: 'project_authored_fictional_exterior_with_named_materials_and_uv0_no_external_assets',
    excluded: ['NGII_GIS', 'map_coordinates_and_georeferencing', 'roads_and_sidewalks', 'neighbouring_buildings', 'parking_and_site_landscape', 'third_party_photos_textures_logos', 'interior_and_collision'],
    entrance: {type: 'communal_automatic_sliding_glass', keypadIncluded: true, browserDemoCode: '2050', authenticationImplemented: false, animationIncludedInGlb: false},
    unfinished: ['actual_UE5_import', 'collision_and_UE_door_logic', 'interiors', 'LOD_HLOD_and_120fps_profile', 'production_textures_and_lightmap_UV'],
    documents: [
      'https://dev.epicgames.com/documentation/en-us/unreal-engine/importing-assets-using-interchange-in-unreal-engine',
      'https://dev.epicgames.com/documentation/en-us/unreal-engine/units-of-measurement-in-unreal-engine'
    ], assets: records
  }};
}
