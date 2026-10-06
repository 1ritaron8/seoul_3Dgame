import * as THREE from 'three';

function finitePoint(value) {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
}

/** The plan is east/north in metres; the viewer is east/up/south in metres. */
export function worldPoint(pointLocalM, originLocalM, heightM = 0) {
  if (!finitePoint(pointLocalM) || !finitePoint(originLocalM) || !Number.isFinite(heightM)) {
    throw new Error('Expected finite east/north metre coordinates and elevation.');
  }
  return new THREE.Vector3(pointLocalM[0] - originLocalM[0], heightM, -(pointLocalM[1] - originLocalM[1]));
}

function ringPath(ring, origin, hole = false) {
  if (!Array.isArray(ring) || ring.length < 4 || !ring.every(finitePoint)) throw new Error('Invalid closed polygon ring.');
  const first = ring[0], last = ring.at(-1);
  if (first[0] !== last[0] || first[1] !== last[1]) throw new Error('Polygon ring must be closed.');
  const path = hole ? new THREE.Path() : new THREE.Shape();
  path.moveTo(first[0] - origin[0], first[1] - origin[1]);
  for (const point of ring.slice(1, -1)) path.lineTo(point[0] - origin[0], point[1] - origin[1]);
  path.closePath();
  return path;
}

/** Retains separate polygon parts and holes. Never replaces a footprint with its bbox. */
export function createPolygonGeometry(geometryLocalM, originLocalM, heightM = 0) {
  if (!finitePoint(originLocalM) || !Number.isFinite(heightM) || heightM < 0) throw new Error('Invalid origin or height.');
  const polygons = geometryLocalM?.type === 'Polygon' ? [geometryLocalM.coordinates]
    : geometryLocalM?.type === 'MultiPolygon' ? geometryLocalM.coordinates : null;
  if (!polygons?.length) throw new Error('Expected a Polygon or MultiPolygon.');
  const shapes = polygons.map(polygon => {
    if (!Array.isArray(polygon) || !polygon.length) throw new Error('Polygon needs an exterior ring.');
    const shape = ringPath(polygon[0], originLocalM);
    shape.holes = polygon.slice(1).map(ring => ringPath(ring, originLocalM, true));
    return shape;
  });
  const geometry = heightM > 0
    ? new THREE.ExtrudeGeometry(shapes, {depth: heightM, steps: 1, bevelEnabled: false, curveSegments: 1})
    : new THREE.ShapeGeometry(shapes, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.computeBoundingBox();
  return geometry;
}

/** Stationary scale reference, not a player animation or a confirmed entrance marker. */
export function createReferenceHuman(heightM = 1.8) {
  if (!Number.isFinite(heightM) || heightM <= 0 || heightM > 3) throw new Error('Invalid reference human height.');
  const group = new THREE.Group();
  group.name = 'human-scale-reference';
  const jacket = new THREE.MeshStandardMaterial({color: '#efae48', roughness: .7});
  const trousers = new THREE.MeshStandardMaterial({color: '#244449', roughness: .9});
  const skin = new THREE.MeshStandardMaterial({color: '#bc896e', roughness: .9});
  function part(geometry, material, x, y, z = 0, tilt = 0) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.z = tilt;
    mesh.castShadow = true;
    group.add(mesh);
  }
  part(new THREE.SphereGeometry(.13, 16, 12), skin, 0, 1.67);
  part(new THREE.CapsuleGeometry(.18, .28, 4, 10), jacket, 0, 1.22);
  part(new THREE.CapsuleGeometry(.15, .1, 4, 10), trousers, 0, .88);
  for (const side of [-1, 1]) {
    part(new THREE.CapsuleGeometry(.08, .64, 4, 8), trousers, side * .105, .4);
    part(new THREE.BoxGeometry(.16, .08, .28), trousers, side * .105, .04, .04);
    part(new THREE.CapsuleGeometry(.055, .42, 4, 8), jacket, side * .24, 1.2, 0, side * .1);
    part(new THREE.SphereGeometry(.06, 8, 6), skin, side * .265, .925);
  }
  group.scale.setScalar(heightM / 1.8);
  group.userData.heightM = heightM;
  group.userData.status = 'stationary_scale_reference';
  return group;
}
