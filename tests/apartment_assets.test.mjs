import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
import {createFutureApartment, disposeArchitecture} from '../web/pilot-architecture.mjs';
import {APARTMENT_DETAIL_PROFILE, createApartmentModuleLayout, createFrameParts} from '../web/apartment-modules.mjs';
import {exportApartmentAssets, inspectApartmentGlb, prepareApartmentAsset, verifyApartmentGlb} from '../tools/apartment_asset_export.mjs';

const input = JSON.parse(await readFile(new URL('../docs/guil_2050_pilot3d.json', import.meta.url), 'utf8'));
const before = structuredClone(input);
const exported = await exportApartmentAssets(input.futureDesign);
const near = (value, expected, tolerance = 1e-5) => assert.ok(Math.abs(value - expected) < tolerance, `${value} != ${expected}`);
function building() {
  const group = createFutureApartment(input.futureDesign, input.futureDesign.frame.centerLocalM);
  const root = group.getObjectByName('future-building-local');
  root.rotation.set(0, 0, 0); root.position.set(0, 0, 0); group.updateMatrixWorld(true);
  return {group, root};
}
const size = object => new THREE.Box3().setFromObject(object, true).getSize(new THREE.Vector3());

test('frame specifications keep an empty centre, immutable metre defaults and explicit invalid cases', () => {
  const parts = createFrameParts(3.4, 2.95, .12, .16);
  assert.deepEqual(parts.map(part => part.framePart), ['left', 'right', 'head', 'sill']);
  for (const part of parts) assert.ok(part.position.some((coordinate, axis) => axis < 2 && Math.abs(coordinate) > part.dimensions[axis] / 2), 'no frame bar fills the centre');
  assert.ok(Object.isFrozen(APARTMENT_DETAIL_PROFILE.door));
  for (const args of [[0, 3, .1, .1], [2, Infinity, .1, .1], [2, 2, 1, .1], [2, 2, .1, NaN]]) assert.throws(() => createFrameParts(...args));
});

test('shared-lobby automatic leaves stay human-scaled and have a mounted numeric reader, not domestic handles or hinges', () => {
  const {group, root} = building();
  try {
    const leaves = ['entrance-left-leaf', 'entrance-right-leaf'].map(name => root.getObjectByName(name));
    for (const leaf of leaves) {
      near(size(leaf).x, 1.48); near(size(leaf).y, 2.6);
      assert.equal(leaf.getObjectByName('entrance-pull-handle'), undefined);
      assert.equal(leaf.getObjectByName('entrance-leaf-hinge'), undefined);
      assert.ok(leaf.getObjectByName('entrance-glass-safety-band'));
    }
    near(leaves[0].position.x, -leaves[1].position.x);
    const entry = root.getObjectByName('double-leaf-entrance-module');
    assert.equal(entry.userData.doorType, 'communal_automatic_sliding_glass'); assert.equal(entry.userData.interiorImplemented, false);
    near(entry.userData.doorLeafTravelM, 1.5);
    const track = entry.getObjectByName('entrance-automatic-door-track'); assert.ok(track);
    const reader = entry.getObjectByName('communal-entrance-keypad');
    near(reader.position.y, 1.38); near(size(reader.getObjectByName('keypad-reader-body')).x, .3);
    assert.equal(reader.children.filter(object => object.name === 'keypad-number-key').length, 12);
    assert.ok(reader.getObjectByName('keypad-digit-strokes').count > 40);
    const mountingMullion = entry.getObjectByName('keypad-mounting-mullion');
    for (const fraction of [0, .5, 1]) {
      leaves.forEach((leaf, index) => { leaf.position.x = (index === 0 ? -1 : 1) * (.78 + entry.userData.doorLeafTravelM * fraction); });
      group.updateMatrixWorld(true);
      const trackBounds = new THREE.Box3().setFromObject(track, true);
      for (const leaf of leaves) {
        const bounds = new THREE.Box3().setFromObject(leaf, true);
        assert.ok(!bounds.intersectsBox(new THREE.Box3().setFromObject(reader, true)), 'sliding leaves must clear the fixed keypad');
        assert.ok(!bounds.intersectsBox(new THREE.Box3().setFromObject(mountingMullion, true)), 'sliding leaves must clear the keypad mounting mullion');
        assert.ok(bounds.min.x >= trackBounds.min.x && bounds.max.x <= trackBounds.max.x, 'the rail must cover the full sliding travel');
      }
    }
    near(size(root.getObjectByName('entrance-threshold')).y, .025);
  } finally { disposeArchitecture(group); }
});

test('entrance frame is open in its centre and the building has a facade recess instead of a wall behind the glass', () => {
  const {group, root} = building();
  try {
    const frame = root.getObjectByName('entrance-door-frame');
    near(size(frame).x, 3.4); near(size(frame).y, 2.95); assert.equal(frame.children.length, 4);
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 1.65, -12), new THREE.Vector3(0, 0, 1), 0, 5);
    assert.equal(ray.intersectObject(frame, true).length, 0, 'an empty door frame must not behave as a solid slab');
    const hits = ray.intersectObject(root.getObjectByName('future-tower'));
    assert.ok(hits.length > 0, 'a back wall keeps the unimplemented interior closed'); near(hits[0].distance, 2.2);
    const upper = new THREE.Raycaster(new THREE.Vector3(0, 4, -12), new THREE.Vector3(0, 0, 1), 0, 5);
    near(upper.intersectObject(root.getObjectByName('future-tower'))[0].distance, 1);
  } finally { disposeArchitecture(group); }
});

test('every long window has four separate frame bars and every balcony has contacting bases and regular posts', () => {
  const {group, root} = building();
  try {
    const windows = root.getObjectByName('long-facade-windows'), frames = root.getObjectByName('long-facade-window-frames');
    assert.equal(frames.count, windows.count * 4); assert.equal(root.getObjectByName('long-facade-window-gaskets').count, windows.count * 4);
    assert.equal(root.getObjectByName('long-facade-window-sills').count, windows.count);
    const matrix = new THREE.Matrix4(); windows.getMatrixAt(0, matrix);
    const centre = new THREE.Vector3().setFromMatrixPosition(matrix); centre.z = -14;
    assert.equal(new THREE.Raycaster(centre, new THREE.Vector3(0, 0, 1), 0, 3).intersectObject(frames).length, 0);
    const posts = root.getObjectByName('balcony-rail-posts'), bases = root.getObjectByName('balcony-rail-bases'), xs = [];
    assert.equal(posts.count, bases.count);
    posts.userData.instances.forEach((metadata, index) => {
      if (metadata.side !== 'north' || metadata.floorIndex !== 0 || metadata.groupIndex !== 0) return;
      posts.getMatrixAt(index, matrix); xs.push(matrix.elements[12]);
      const postBox = new THREE.Box3().setFromBufferAttribute(posts.geometry.getAttribute('position')).applyMatrix4(matrix);
      near(postBox.min.y, 4.8 + .23);
      bases.getMatrixAt(index, matrix);
      const baseBox = new THREE.Box3().setFromBufferAttribute(bases.geometry.getAttribute('position')).applyMatrix4(matrix);
      near(baseBox.min.y, 4.8 + .22); near(baseBox.max.y, 4.8 + .24);
    });
    xs.sort((a, b) => a - b); assert.ok(xs.length >= 2);
    for (let index = 1; index < xs.length; index++) assert.ok(xs[index] - xs[index - 1] <= 1.6 + 1e-5);
  } finally { disposeArchitecture(group); }
});

test('four exported assets round-trip with normals, UVs, named PBR materials and no instancing extension or external files', async () => {
  assert.deepEqual(exported.files.map(file => file.filename), ['guil2050_118_exterior.glb', 'module_double_entrance.glb', 'module_window_bay.glb', 'module_balcony_pair.glb']);
  for (const file of exported.files) {
    const record = exported.manifest.assets.find(asset => asset.filename === file.filename), {json} = inspectApartmentGlb(file.bytes);
    assert.equal(record.roundTrip.status, 'passed'); assert.equal(record.roundTrip.triangleCount, record.triangleCount);
    assert.ok(!json.extensionsRequired?.length && !json.images?.length && !json.textures?.length);
    assert.ok(json.meshes.every(mesh => mesh.primitives.every(primitive => primitive.attributes.POSITION !== undefined && primitive.attributes.NORMAL !== undefined && primitive.attributes.TEXCOORD_0 !== undefined)));
    assert.equal(json.buffers.length, 1); assert.equal(json.buffers[0].uri, undefined);
    for (const surface of json.materials) assert.ok(surface.name.startsWith('M_Guil2050_'));
    assert.ok(!/geometryLocalM|originLocalM|NGII|ngii\/|future-parking|future-site-landscape/.test(JSON.stringify(json)), 'no GIS geometry or world placement is embedded');
    await verifyApartmentGlb(file.bytes, record);
  }
  const balconyFile = exported.files.find(file => file.filename === 'module_balcony_pair.glb');
  const balconyMaterials = inspectApartmentGlb(balconyFile.bytes).json.materials;
  assert.equal(balconyMaterials.find(surface => surface.name === 'M_Guil2050_railGlass').alphaMode, 'BLEND');
  assert.deepEqual(input, before);
  const entrance = inspectApartmentGlb(exported.files[1].bytes).json;
  assert.ok(entrance.nodes.some(node => node.name === 'keypad-digit-strokes'), 'numeric strokes survive the non-GPU-instanced entrance export');
  assert.ok(entrance.nodes.some(node => node.name === 'keypad-reader-body'));
});

test('full model preserves every rendered instance and metre dimensions; components use grounded local pivots', () => {
  const {group, root} = building();
  try {
    let pieces = 0; root.traverse(object => { if (object.isMesh) pieces += object.isInstancedMesh ? object.count : 1; });
    const full = exported.manifest.assets[0]; assert.equal(full.sourcePieces, pieces);
    assert.ok(full.mergedMeshCount < 80 && full.sourcePieces > 10000, 'do not create a static mesh per tiny repeated bar');
    const bounds = new THREE.Box3().setFromObject(root, true);
    ['min', 'max'].forEach(key => bounds[key].toArray().forEach((value, axis) => near(value, full.boundsM[key][axis])));
    near(full.boundsM.max[1], 78.4); near(full.boundsM.min[1], 0);
    assert.deepEqual(exported.manifest.nominalBuildingDimensionsM, {length: 62, depth: 22, height: 78.4});
    assert.deepEqual(exported.manifest.expectedUnrealDimensionsCm, {length: 6200, depth: 2200, height: 7840});
    assert.equal(exported.manifest.importChecks.verifyDoorLeafCm, 148);
    const layout = createApartmentModuleLayout(input.futureDesign.building);
    assert.deepEqual(exported.manifest.assets[2].pivotM, [layout.bays[0].centreM, 4.8, -11]);
    assert.deepEqual(exported.manifest.assets[3].pivotM, [layout.groups[0].centreM, 4.8, -11]);
    assert.ok(exported.manifest.unfinished.includes('actual_UE5_import') && exported.manifest.unfinished.includes('LOD_HLOD_and_120fps_profile'));
  } finally { disposeArchitecture(group); }
});

test('bad selections, invalid geometry, external textures, truncated GLB and lost geometry fail closed', async () => {
  const {group, root} = building();
  try {
    assert.throws(() => prepareApartmentAsset(group, {id: 'building', pivotM: [0, 0, 0]}));
    for (const selection of [{id: 'roads', pivotM: [0, 0, 0]}, {id: 'building', pivotM: [Infinity, 0, 0]}]) assert.throws(() => prepareApartmentAsset(root, selection));
    const tower = root.getObjectByName('future-tower'), texture = new THREE.Texture();
    tower.material.map = texture;
    assert.throws(() => prepareApartmentAsset(root, {id: 'building', pivotM: [0, 0, 0]}), /texture/);
    tower.material.map = null; texture.dispose();
    const positions = tower.geometry.getAttribute('position'), original = positions.array[0]; positions.array[0] = NaN;
    assert.throws(() => prepareApartmentAsset(root, {id: 'building', pivotM: [0, 0, 0]}), /invalid/); positions.array[0] = original;
  } finally { disposeArchitecture(group); }
  const file = exported.files[1], record = exported.manifest.assets[1];
  assert.throws(() => inspectApartmentGlb(file.bytes.subarray(0, 50)), /header/);
  const bad = file.bytes.slice(); new DataView(bad.buffer).setUint32(12, bad.byteLength, true);
  assert.throws(() => inspectApartmentGlb(bad), /chunk/);
  await assert.rejects(() => verifyApartmentGlb(file.bytes, {...record, triangleCount: record.triangleCount + 1}), /lost/);
  await assert.rejects(() => verifyApartmentGlb(file.bytes, {...record, boundsM: {min: [0, 0, 0], max: [0, 0, 0]}}), /bounds/);
});
