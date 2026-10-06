import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
import {worldPoint, createPolygonGeometry, createReferenceHuman} from '../web/pilot-geometry.mjs';

const near = (actual, expected, tolerance = 1e-5) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const scene = JSON.parse(await readFile(new URL('../docs/guil_2050_pilot3d.json', import.meta.url)));
const rectangle = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const courtyard = {type: 'Polygon', coordinates: [rectangle(100, 200, 110, 210), rectangle(103, 203, 107, 207)]};

function triangles(geometry) {
  const positions = geometry.getAttribute('position'), index = geometry.getIndex();
  const count = index ? index.count : positions.count;
  assert.equal(count % 3, 0);
  const result = [];
  for (let offset = 0; offset < count; offset += 3) result.push([0, 1, 2].map(step => new THREE.Vector3().fromBufferAttribute(positions, index ? index.getX(offset + step) : offset + step)));
  return result;
}

function horizontalArea(geometry, height = 0) {
  let area = 0;
  for (const [a, b, c] of triangles(geometry)) {
    if ([a, b, c].every(vertex => Math.abs(vertex.y - height) < 1e-5)) {
      area += Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) / 2;
      const centre = a.clone().add(b).add(c).divideScalar(3);
      assert.ok(!(centre.x > 3 && centre.x < 7 && centre.z > -7 && centre.z < -3), 'courtyard hole must not contain a triangle centre');
    }
  }
  return area;
}

test('worldPoint maps origin-relative metres to east/up/south without changing input', () => {
  const point = [107, 195], origin = [100, 200];
  const result = worldPoint(point, origin, 48);
  assert.ok(result instanceof THREE.Vector3);
  assert.deepEqual(result.toArray(), [7, 48, 5]);
  for (const coordinate of worldPoint([100, 200], origin).toArray()) near(coordinate, 0);
  assert.deepEqual(point, [107, 195]);
  assert.deepEqual(origin, [100, 200]);
});

test('original 118 extrusion preserves exact horizontal footprint and stands from ground 0 to 48m', () => {
  const input = structuredClone(scene.building.geometryLocalM), before = structuredClone(input);
  const origin = [...scene.coordinates.originLocalM];
  const geometry = createPolygonGeometry(input, origin, 48);
  assert.equal(geometry.type, 'ExtrudeGeometry');
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const ring = input.coordinates[0];
  near(box.min.x, Math.min(...ring.map(point => point[0])) - origin[0]);
  near(box.max.x, Math.max(...ring.map(point => point[0])) - origin[0]);
  near(box.min.z, origin[1] - Math.max(...ring.map(point => point[1])));
  near(box.max.z, origin[1] - Math.min(...ring.map(point => point[1])));
  near(box.min.y, 0);
  near(box.max.y, 48);
  for (const vertex of ring) {
    const expected = new THREE.Vector3(vertex[0] - origin[0], 0, origin[1] - vertex[1]);
    const vertices = triangles(geometry).flat();
    assert.ok(vertices.some(actual => actual.distanceTo(expected) < 1e-5), 'source footprint vertex must exist at ground level');
    assert.ok(vertices.some(actual => actual.distanceTo(expected.clone().setY(48)) < 1e-5), 'source footprint vertex must exist at roof level');
  }
  assert.deepEqual(input, before);
  assert.deepEqual(origin, scene.coordinates.originLocalM);
  geometry.dispose();
});

test('flat polygon triangulation leaves holes open for either source winding direction', () => {
  for (const reverse of [false, true]) {
    const input = structuredClone(courtyard);
    if (reverse) input.coordinates = input.coordinates.map(ring => ring.reverse());
    const before = structuredClone(input);
    const geometry = createPolygonGeometry(input, [100, 200], 0);
    assert.equal(geometry.type, 'ShapeGeometry');
    near(horizontalArea(geometry), 84);
    assert.ok(triangles(geometry).flat().every(vertex => Math.abs(vertex.y) < 1e-8));
    assert.deepEqual(input, before);
    geometry.dispose();
  }
});

test('multipolygon triangulation retains separated components and courtyard holes at ground and roof', () => {
  const input = {type: 'MultiPolygon', coordinates: [courtyard.coordinates, [rectangle(120, 200, 124, 204)]]};
  const before = structuredClone(input);
  for (const height of [0, 48]) {
    const geometry = createPolygonGeometry(input, [100, 200], height);
    near(horizontalArea(geometry, 0), 100);
    if (height > 0) near(horizontalArea(geometry, height), 100);
    for (const triangle of triangles(geometry)) {
      const x = triangle.map(vertex => vertex.x);
      assert.ok(x.every(value => value <= 10) || x.every(value => value >= 20), 'components must not be joined across empty ground');
    }
    geometry.computeBoundingBox();
    near(geometry.boundingBox.min.x, 0);
    near(geometry.boundingBox.max.x, 24);
    near(geometry.boundingBox.min.z, -10);
    near(geometry.boundingBox.max.z, 0);
    near(geometry.boundingBox.min.y, 0);
    near(geometry.boundingBox.max.y, height);
    assert.deepEqual(input, before);
    geometry.dispose();
  }
});

test('reference human mesh measures 1.8m and its feet stand on the selected ground position', () => {
  for (const height of [1.8, 2.1]) {
    const human = createReferenceHuman(height);
    assert.ok(human instanceof THREE.Group);
    assert.ok(human.children.length > 0);
    human.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(human, true);
    near(box.min.y, 0, 1e-7);
    near(box.max.y, height, 1e-7);
    near(box.max.y - box.min.y, height, 1e-7);
    const position = worldPoint(scene.referenceHuman.positionLocalM, scene.coordinates.originLocalM, scene.ground.elevationM);
    human.position.copy(position);
    human.updateWorldMatrix(true, true);
    const placedBox = new THREE.Box3().setFromObject(human, true);
    near(placedBox.min.y, scene.ground.elevationM, 1e-7);
    near(placedBox.max.y, scene.ground.elevationM + height, 1e-7);
    assert.ok(placedBox.min.x <= position.x && placedBox.max.x >= position.x);
    assert.ok(placedBox.min.z <= position.z && placedBox.max.z >= position.z);
    human.traverse(object => { if (object.geometry) object.geometry.dispose(); });
  }
});

test('renderer rejects malformed coordinate/geometry values and invalid extrusion/human heights', () => {
  for (const point of [null, [1], [1, 2, 3], [NaN, 1], [1, Infinity], ['1', 2]]) assert.throws(() => worldPoint(point, [0, 0]));
  assert.throws(() => worldPoint([1, 2], [NaN, 0]));
  assert.throws(() => worldPoint([1, 2], [0, 0], Infinity));
  for (const height of [-1, NaN, Infinity, '48']) assert.throws(() => createPolygonGeometry(courtyard, [100, 200], height));
  for (const height of [0, -1, NaN, Infinity, '1.8']) assert.throws(() => createReferenceHuman(height));
  for (const geometry of [
    null, {type: 'Point', coordinates: [1, 2]}, {type: 'Polygon', coordinates: []},
    {type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]]},
    {type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, NaN], [0, 0]]]},
    {type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]]}
  ]) assert.throws(() => createPolygonGeometry(geometry, [0, 0], 0));
  assert.throws(() => createPolygonGeometry(courtyard, [Infinity, 200], 0));
});
