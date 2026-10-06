import * as THREE from 'three';
import {createPolygonGeometry, worldPoint} from './pilot-geometry.mjs';
import {APARTMENT_DETAIL_PROFILE, createApartmentModuleLayout, createFrameParts} from './apartment-modules.mjs';

const check = (condition, message) => { if (!condition) throw new Error(message); };
const finitePoint = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);

/** A fictional exterior, not a replica of the source apartment or a permitted construction design. */
export function createFutureApartment(design, originLocalM, options = {}) {
  check(design && finitePoint(originLocalM), 'Future apartment needs its validated design and metre origin.');
  check(design.schema === 'guil-future-apartment.v1' && design.validation?.status === 'passed', 'Future apartment placement validation must pass.');
  const building = design.building, frame = design.frame;
  check(design.architectureIdentity?.id === 'g05-living-terraces' && building?.facade?.style === design.architectureIdentity.id, 'The facade must use the retained G05 living-terrace identity.');
  check(building && frame && finitePoint(frame.centerLocalM) && finitePoint(frame.longAxisLocalM) && finitePoint(frame.shortAxisLocalM), 'Missing future apartment frame.');
  for (const axis of [frame.longAxisLocalM, frame.shortAxisLocalM]) check(Math.abs(Math.hypot(...axis) - 1) < 1e-6, 'Future frame axes must be unit vectors.');
  check(Math.abs(frame.longAxisLocalM[0] * frame.shortAxisLocalM[0] + frame.longAxisLocalM[1] * frame.shortAxisLocalM[1]) < 1e-6, 'Future frame axes must be orthogonal.');
  check(Math.abs(frame.longAxisLocalM[0] * frame.shortAxisLocalM[1] - frame.longAxisLocalM[1] * frame.shortAxisLocalM[0] - 1) < 1e-6, 'Future frame orientation must preserve east/north handedness.');
  check(Number.isFinite(building.lengthM) && building.lengthM > 0 && Number.isFinite(building.depthM) && building.depthM > 0, 'Invalid future footprint dimensions.');
  check(Number.isFinite(building.heightM) && building.heightM > 0 && Number.isInteger(building.floorCount) && building.floorCount >= 2, 'Invalid future height or floor count.');
  check(Number.isFinite(building.podiumHeightM) && building.podiumHeightM > 0 && Number.isFinite(building.floorHeightM) && building.floorHeightM > 0, 'Invalid future floor dimensions.');
  const footprint = building.geometryLocalM;
  check(footprint?.type === 'Polygon' && footprint.coordinates?.length === 1 && footprint.coordinates[0].length === 5 && footprint.coordinates[0].every(finitePoint), 'Future tower needs its validated rectangular footprint.');
  const projected = footprint.coordinates[0].slice(0, -1).map(point => {
    const delta = point.map((value, axis) => value - frame.centerLocalM[axis]);
    return [frame.longAxisLocalM, frame.shortAxisLocalM].map(direction => delta.reduce((sum, value, axis) => sum + value * direction[axis], 0));
  });
  for (const [axis, extent] of [[0, building.lengthM], [1, building.depthM]]) {
    check(Math.abs(Math.max(...projected.map(point => point[axis])) - extent / 2) < 1e-5 && Math.abs(Math.min(...projected.map(point => point[axis])) + extent / 2) < 1e-5, 'Future dimensions and centre must agree with the validated footprint.');
  }
  const heightM = options.heightM ?? building.heightM;
  check(Number.isFinite(heightM) && heightM >= 18 && heightM <= 90 && heightM > building.podiumHeightM, 'Future height must stay within the 18–90m preview range above the podium.');
  check(Number.isFinite(building.facade?.baySpacingM) && building.facade.baySpacingM >= 6.7 && building.facade.baySpacingM <= building.lengthM / 4, 'Residential facade modules need a finite, supported dwelling pitch.');
  check(Number.isFinite(building.safetyBufferM) && building.safetyBufferM === design.validation.facadeEnvelopeBufferM && building.safetyBufferM <= 1.6, 'Facade projection must agree with its validated placement envelope.');
  const moduleLayout = createApartmentModuleLayout(building, heightM);
  const {residentialFloorCount, floorHeightM} = moduleLayout;
  const ramp = design.parking?.ramp, deck = design.parking?.deck;
  check(ramp && deck && finitePoint(ramp.startLocalM) && finitePoint(ramp.endLocalM), 'Missing parking ramp centre endpoints.');
  check(Number.isFinite(ramp.startElevationM) && ramp.startElevationM === 0 && Number.isFinite(ramp.endElevationM) && ramp.endElevationM < 0, 'Parking ramp must descend from grade.');
  check(Number.isFinite(deck.elevationM) && deck.elevationM === ramp.endElevationM, 'Parking deck must meet the ramp elevation.');
  const group = new THREE.Group();
  group.name = 'future-apartment-2050';
  group.userData = {status: design.status, heightM, residentialFloorCount, floorCount: residentialFloorCount + 1, floorHeightM, architectureIdentityId: design.architectureIdentity.id, moduleProfileId: moduleLayout.profileId};
  const superstructure = new THREE.Group(); superstructure.name = 'future-superstructure'; group.add(superstructure);
  const parking = new THREE.Group(); parking.name = 'future-parking'; group.add(parking);
  const anchor = new THREE.Group();
  anchor.name = 'future-building-local';
  anchor.position.copy(worldPoint(frame.centerLocalM, originLocalM));
  anchor.rotation.y = Math.atan2(frame.longAxisLocalM[1], frame.longAxisLocalM[0]);
  superstructure.add(anchor);
  const material = (color, extra = {}) => new THREE.MeshStandardMaterial({color, roughness: .65, ...extra});
  const wall = material('#e5e2d7'), trim = material('#faf7ed'), glass = material('#526f79', {roughness: .38, metalness: .04});
  const stone = material('#bbae99'), bronze = material('#766b58', {roughness: .55, metalness: .25}), green = material('#6b8750');
  const railGlass = material('#8da7a5', {transparent: true, opacity: .48, roughness: .35, depthWrite: false});
  const gasket = material('#333e3d', {roughness: .85});
  for (const [name, surface] of Object.entries({wall, trim, glass, stone, bronze, green, railGlass, gasket})) surface.name = `M_Guil2050_${name}`;
  function box(parent, name, dimensions, position, surface = trim) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...dimensions), surface);
    mesh.name = name; mesh.position.set(...position); mesh.userData.dimensionsM = [...dimensions]; mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
  }
  function batches(parent, name, instances, surface) {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), surface, instances.length);
    mesh.name = name; mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.instances = instances.map(({side, floorIndex, bayIndex, groupIndex, role, framePart, postIndex}) => ({side, floorIndex, bayIndex, groupIndex, role, framePart, postIndex}));
    const dummy = new THREE.Object3D();
    instances.forEach((item, index) => {
      dummy.position.set(...item.position); dummy.rotation.set(0, item.rotationY || 0, item.rotationZ || 0); dummy.scale.set(...item.dimensions); dummy.updateMatrix(); mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingBox(); mesh.computeBoundingSphere(); parent.add(mesh); return mesh;
  }
  const length = building.lengthM, depth = building.depthM, podiumHeight = building.podiumHeightM;
  const detail = APARTMENT_DETAIL_PROFILE;
  anchor.userData = {moduleProfileId: moduleLayout.profileId, detailProfileId: detail.id, units: 'metres'};
  // Preserve the validated rectangular envelope, but remove the wall directly behind the door.
  // The 1.2m facade recess ends at a back wall; this is not an implemented building interior.
  const openingWidth = moduleLayout.entrance.frameWidthM - detail.door.outerFrameSectionM * 2;
  const openingTop = moduleLayout.entrance.frameHeightM - detail.door.outerFrameSectionM;
  const wingWidth = (length - openingWidth) / 2;
  const bodyParts = [
    {dimensions: [length, heightM - podiumHeight, depth], position: [0, (heightM + podiumHeight) / 2, 0]},
    ...[-1, 1].map(sign => ({dimensions: [wingWidth, podiumHeight, depth], position: [sign * (length + openingWidth) / 4, podiumHeight / 2, 0]})),
    {dimensions: [openingWidth, podiumHeight - openingTop, depth], position: [0, (podiumHeight + openingTop) / 2, 0]},
    {dimensions: [openingWidth, openingTop, depth - 1.2], position: [0, openingTop / 2, .6]}
  ];
  const bodyAttributes = {position: [], normal: [], uv: []};
  for (const part of bodyParts) {
    const indexed = new THREE.BoxGeometry(...part.dimensions), geometry = indexed.toNonIndexed();
    geometry.translate(...part.position);
    for (const key of Object.keys(bodyAttributes)) bodyAttributes[key].push(...geometry.getAttribute(key).array);
    indexed.dispose(); geometry.dispose();
  }
  const bodyGeometry = new THREE.BufferGeometry();
  for (const [key, values] of Object.entries(bodyAttributes)) bodyGeometry.setAttribute(key, new THREE.Float32BufferAttribute(values, key === 'uv' ? 2 : 3));
  bodyGeometry.computeBoundingBox(); bodyGeometry.computeBoundingSphere();
  const tower = new THREE.Mesh(bodyGeometry, wall);
  tower.name = 'future-tower'; tower.userData.entranceRecessDepthM = 1.2; tower.castShadow = true; tower.receiveShadow = true; anchor.add(tower);
  // Residential groups, not a full-height office window grid. Rebuild floors instead of squashing them.
  const {bayCount, bayPitchM: bayPitch, groupSize, balconyDepthM: balconyDepth, groupCount, groupPitchM: groupPitch} = moduleLayout;
  check(groupSize === 2 && bayCount % groupSize === 0 && balconyDepth >= 1.2 && balconyDepth + .1 <= building.safetyBufferM, 'Residential balconies must fit the validated facade envelope.');
  const windows = [], frames = [], gaskets = [], sills = [], balconyLedges = [], guards = [], railTops = [], railEnds = [], railPosts = [], railBases = [], screens = [], terracePlanters = [], privacyPanels = [], solarScreens = [];
  const podiumSideWidth = (length - moduleLayout.entrance.frameWidthM) / 2;
  for (const sign of [-1, 1]) box(anchor, 'warm-stone-podium-north', [podiumSideWidth, podiumHeight, .11], [sign * (length + moduleLayout.entrance.frameWidthM) / 4, podiumHeight / 2, -depth / 2 - .055], stone);
  box(anchor, 'warm-stone-podium-north-head', [moduleLayout.entrance.frameWidthM, podiumHeight - moduleLayout.entrance.frameHeightM, .11], [0, (podiumHeight + moduleLayout.entrance.frameHeightM) / 2, -depth / 2 - .055], stone);
  box(anchor, 'warm-stone-podium-south', [length, podiumHeight, .11], [0, podiumHeight / 2, depth / 2 + .055], stone);
  for (const sign of [-1, 1]) box(anchor, 'warm-stone-podium-end', [.11, podiumHeight, depth], [sign * (length / 2 + .055), podiumHeight / 2, 0], stone);
  const joints = [];
  for (const [side, sign] of [['north', -1], ['south', 1]]) {
    const spans = side === 'north' ? [[-length / 2, -moduleLayout.entrance.frameWidthM / 2], [moduleLayout.entrance.frameWidthM / 2, length / 2]] : [[-length / 2, length / 2]];
    for (const [start, end] of spans) {
      box(anchor, `podium-plinth-${side}`, [end - start, detail.podium.plinthHeightM, .13], [(start + end) / 2, detail.podium.plinthHeightM / 2, sign * (depth / 2 + .065)], bronze);
      for (let x = start + detail.podium.panelPitchM; x < end; x += detail.podium.panelPitchM) joints.push({side, position: [x, podiumHeight / 2, sign * (depth / 2 + .114)], dimensions: [detail.podium.jointWidthM, podiumHeight, .008]});
      for (let y = 1.2; y < podiumHeight; y += 1.2) joints.push({side, position: [(start + end) / 2, y, sign * (depth / 2 + .114)], dimensions: [end - start, detail.podium.jointWidthM, .008]});
    }
  }
  batches(anchor, 'podium-panel-joints', joints, gasket);
  function appendWindowFrame(target, item, width, windowHeight, centre, rotationY = 0, section = detail.window.frameSectionM, frameDepth = detail.window.frameDepthM) {
    for (const part of createFrameParts(width, windowHeight, section, frameDepth)) {
      const offset = new THREE.Vector3(...part.position).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotationY);
      target.push({...item, framePart: part.framePart, rotationY, dimensions: part.dimensions, position: centre.map((value, axis) => value + offset.getComponent(axis))});
    }
  }
  for (const [side, sign] of [['north', -1], ['south', 1]]) {
    if (side === 'north') {
      const wing = (10.8 - moduleLayout.entrance.frameWidthM) / 2;
      for (const edge of [-1, 1]) box(anchor, 'north-lobby-glass', [wing, 3.15, .12], [edge * (10.8 + moduleLayout.entrance.frameWidthM) / 4, 1.825, -depth / 2 - .19], glass);
    } else box(anchor, 'south-lobby-glass', [6, 3.15, .12], [0, 1.825, depth / 2 + .19], glass);
    for (let groupIndex = 1; groupIndex < groupCount; groupIndex++) {
      const x = -length / 2 + groupIndex * groupPitch;
      box(anchor, 'paired-dwelling-divider', [.52, heightM - podiumHeight, .12], [x, podiumHeight + (heightM - podiumHeight) / 2, sign * (depth / 2 + .065)], groupIndex % 2 ? stone : trim);
    }
    for (let floorIndex = 0; floorIndex < residentialFloorCount; floorIndex++) {
      const bottom = moduleLayout.floorRows[floorIndex].bottomM;
      for (let bayIndex = 0; bayIndex < bayCount; bayIndex++) {
        const x = moduleLayout.bays[bayIndex].centreM;
        const livingHeight = moduleLayout.openings.find(value => value.role === 'living').heightM;
        for (const {role, offsetM: offset, widthM: width, heightM: windowHeight, sillM} of moduleLayout.openings) {
          const y = bottom + sillM + windowHeight / 2;
          const item = {side, floorIndex, bayIndex, groupIndex: Math.floor(bayIndex / groupSize), role};
          windows.push({...item, position: [x + offset, y, sign * (depth / 2 + .15)], dimensions: [width, windowHeight, .1]});
          appendWindowFrame(frames, item, width + .2, windowHeight + .2, [x + offset, y, sign * (depth / 2 + .19)]);
          appendWindowFrame(gaskets, item, width + .035, windowHeight + .035, [x + offset, y, sign * (depth / 2 + .205)], 0, detail.window.gasketSectionM, .025);
          sills.push({...item, position: [x + offset, bottom + sillM - .1, sign * (depth / 2 + .2)], dimensions: [width + .25, detail.window.sillHeightM, detail.window.sillDepthM]});
        }
        screens.push({side, floorIndex, bayIndex, position: [x - .8, bottom + .3 + livingHeight / 2, sign * (depth / 2 + .22)], dimensions: [.075, livingHeight, .13]});
      }
      for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
        const x = moduleLayout.groups[groupIndex].centreM;
        const width = moduleLayout.balconyWidthM;
        const item = {side, floorIndex, groupIndex, bayIndex: groupIndex * groupSize};
        balconyLedges.push({...item, position: [x, bottom + .13, sign * (depth / 2 + balconyDepth / 2)], dimensions: [width, .18, balconyDepth]});
        guards.push({...item, position: [x, bottom + .75, sign * (depth / 2 + balconyDepth - .065)], dimensions: [width, 1.02, .1]});
        railTops.push({...item, position: [x, bottom + 1.3, sign * (depth / 2 + balconyDepth - .065)], dimensions: [width, .075, .12]});
        const intervals = Math.ceil((width - detail.balcony.postSectionM) / detail.balcony.maximumPostSpacingM);
        for (let postIndex = 0; postIndex <= intervals; postIndex++) {
          const postX = x - (width - detail.balcony.postSectionM) / 2 + postIndex * (width - detail.balcony.postSectionM) / intervals;
          railPosts.push({...item, postIndex, position: [postX, bottom + .75, sign * (depth / 2 + balconyDepth - .065)], dimensions: [detail.balcony.postSectionM, 1.04, detail.balcony.postSectionM]});
          railBases.push({...item, postIndex, position: [postX, bottom + .23, sign * (depth / 2 + balconyDepth - .065)], dimensions: [detail.balcony.basePlateWidthM, detail.balcony.basePlateHeightM, .12]});
        }
        for (const edge of [-1, 1]) {
          railEnds.push({...item, position: [x + edge * (width / 2 - .055), bottom + .75, sign * (depth / 2 + balconyDepth / 2)], dimensions: [.1, 1.02, balconyDepth]});
        }
        privacyPanels.push({...item, position: [x, bottom + .9, sign * (depth / 2 + balconyDepth / 2)], dimensions: [.12, 1.5, balconyDepth]});
        if (floorIndex % 6 === 5) {
          terracePlanters.push({...item, position: [x, bottom + .46, sign * (depth / 2 + balconyDepth - .31)], dimensions: [width - .4, .38, .46]});
          solarScreens.push({...item, position: [x, bottom + .19, sign * (depth / 2 + balconyDepth / 2)], dimensions: [width - .3, .07, balconyDepth - .15]});
        }
      }
    }
  }
  batches(anchor, 'long-facade-window-frames', frames, trim);
  batches(anchor, 'long-facade-windows', windows, glass);
  batches(anchor, 'long-facade-window-gaskets', gaskets, gasket);
  batches(anchor, 'long-facade-window-sills', sills, bronze);
  batches(anchor, 'balcony-sunshade-ledges', balconyLedges, trim);
  batches(anchor, 'balcony-glass-guards', guards, railGlass);
  batches(anchor, 'balcony-rail-top', railTops, bronze);
  batches(anchor, 'balcony-rail-ends', railEnds, bronze);
  batches(anchor, 'balcony-rail-posts', railPosts, bronze);
  batches(anchor, 'balcony-rail-bases', railBases, bronze);
  batches(anchor, 'paired-balcony-privacy-panels', privacyPanels, trim);
  batches(anchor, 'adaptive-facade-screens', screens, bronze);
  batches(anchor, 'terrace-planting-modules', terracePlanters, green);
  batches(anchor, 'six-floor-terrace-decks', solarScreens, stone);
  const endWindows = [], endFrames = [], endBayCount = 2;
  for (const [side, sign] of [['west', -1], ['east', 1]]) {
    box(anchor, `${side}-lobby-glass`, [.12, 3.15, 2.6], [sign * (length / 2 + .19), 1.825, 0], glass);
    box(anchor, 'end-solid-core-panel', [.12, heightM - podiumHeight, depth * .38], [sign * (length / 2 + .065), podiumHeight + (heightM - podiumHeight) / 2, 0], stone);
    for (let floorIndex = 0; floorIndex < residentialFloorCount; floorIndex++) {
      for (let bayIndex = 0; bayIndex < endBayCount; bayIndex++) {
        const z = (bayIndex === 0 ? -1 : 1) * depth * .34;
        const width = 1.65, windowHeight = Math.min(1.65, floorHeightM * .52);
        const y = podiumHeight + floorIndex * floorHeightM + .82 + windowHeight / 2;
        endWindows.push({side, floorIndex, bayIndex, rotationY: Math.PI / 2, position: [sign * (length / 2 + .15), y, z], dimensions: [width, windowHeight, .1]});
        const item = {side, floorIndex, bayIndex, role: 'end'};
        appendWindowFrame(endFrames, item, width + .24, windowHeight + .24, [sign * (length / 2 + .19), y, z], Math.PI / 2);
      }
    }
  }
  batches(anchor, 'end-facade-window-frames', endFrames, trim);
  batches(anchor, 'end-facade-windows', endWindows, glass);
  const entryModule = moduleLayout.entrance;
  const entry = new THREE.Group(); entry.name = 'double-leaf-entrance-module'; anchor.add(entry);
  entry.userData = {moduleId: 'double-leaf-entrance', detailProfileId: detail.id, doorType: 'communal_automatic_sliding_glass', doorLeafWidthM: entryModule.doorLeafWidthM, doorHeightM: entryModule.doorHeightM, doorLeafTravelM: detail.door.leafTravelM, animationExported: false, interiorImplemented: false};
  const entryFrame = new THREE.Group(); entryFrame.name = 'entrance-door-frame'; entry.add(entryFrame);
  for (const part of createFrameParts(entryModule.frameWidthM, entryModule.frameHeightM, detail.door.outerFrameSectionM, .16)) {
    const isSill = part.framePart === 'sill';
    const dimensions = isSill ? [part.dimensions[0], detail.door.thresholdHeightM, part.dimensions[2]] : part.dimensions;
    const y = isSill ? detail.door.thresholdHeightM / 2 : part.position[1] + entryModule.frameHeightM / 2;
    box(entryFrame, `entrance-frame-${part.framePart}`, dimensions, [part.position[0], y, -depth / 2 - .17], trim);
  }
  const leafSection = detail.door.leafFrameSectionM;
  for (const sign of [-1, 1]) {
    const leaf = new THREE.Group(); leaf.name = sign < 0 ? 'entrance-left-leaf' : 'entrance-right-leaf'; entry.add(leaf);
    leaf.position.set(sign * .78, entryModule.doorHeightM / 2 + .05, -depth / 2 - .3);
    for (const part of createFrameParts(entryModule.doorLeafWidthM, entryModule.doorHeightM, leafSection, detail.door.leafDepthM)) box(leaf, `entrance-leaf-${part.framePart}`, part.dimensions, part.position, bronze);
    box(leaf, 'entrance-double-glass-door', [entryModule.doorLeafWidthM - leafSection * 2, entryModule.doorHeightM - leafSection * 2, .035], [0, 0, 0], glass);
    box(leaf, 'entrance-leaf-bottom-rail', [entryModule.doorLeafWidthM - leafSection * 2, .12, .055], [0, -entryModule.doorHeightM / 2 + .16, -.03], bronze);
    box(leaf, 'entrance-glass-safety-band', [entryModule.doorLeafWidthM - leafSection * 2, .045, .006], [0, -.22, -.03], trim);
  }
  const trackLengthM = entryModule.doorLeafWidthM * 2 + .08 + detail.door.leafTravelM * 2 + .28;
  box(entry, 'entrance-automatic-door-track', [trackLengthM, .17, .2], [0, 2.745, -depth / 2 - .3], bronze);
  box(entry, 'entrance-threshold', [openingWidth, detail.door.thresholdHeightM, .32], [0, detail.door.thresholdHeightM / 2, -depth / 2 - .14], bronze);
  box(entry, 'keypad-mounting-mullion', [.09, 3.15, .1], [1.96, 1.825, -depth / 2 - .48], bronze);
  const reader = new THREE.Group(); reader.name = 'communal-entrance-keypad'; reader.position.set(1.96, detail.door.readerCentreHeightM, -depth / 2 - .54); entry.add(reader);
  reader.userData = {role: 'shared_lobby_access_reader', demoOnly: true};
  box(reader, 'keypad-reader-body', [detail.door.readerWidthM, detail.door.readerHeightM, .07], [0, 0, 0], bronze);
  box(reader, 'keypad-reader-face', [.27, .59, .012], [0, 0, -.044], gasket);
  const indicator = material('#bbedd5', {emissive: '#47725c', emissiveIntensity: .4, roughness: .5}); indicator.name = 'M_Guil2050_keypadDisplay';
  box(reader, 'keypad-reader-display', [.23, .09, .008], [0, .21, -.055], indicator);
  const segments = {0: 'abcedf', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgecd', 7: 'abc', 8: 'abcdefg', 9: 'abfgcd'};
  const segmentPositions = {a: [0, .023], b: [.014, .0115], c: [.014, -.0115], d: [0, -.023], e: [-.014, -.0115], f: [-.014, .0115], g: [0, 0]};
  const strokes = [];
  for (const [index, digit] of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].entries()) {
    const x = (index % 3 - 1) * .082, y = .08 - Math.floor(index / 3) * .076;
    box(reader, 'keypad-number-key', [.063, .063, .012], [x, y, -.059], glass);
    if (digit === '*') for (const rotationZ of [0, Math.PI / 4, Math.PI / 2, Math.PI * 3 / 4]) strokes.push({role: 'key-clear', rotationZ, position: [x, y, -.067], dimensions: [.033, .004, .003]});
    if (digit === '#') for (const sign of [-1, 1]) {
      strokes.push({role: 'key-confirm', position: [x, y + sign * .009, -.067], dimensions: [.036, .004, .003]});
      strokes.push({role: 'key-confirm', position: [x + sign * .009, y, -.067], dimensions: [.004, .042, .003]});
    }
    for (const segment of segments[digit] ?? '') {
      const [sx, sy] = segmentPositions[segment], horizontal = ['a', 'd', 'g'].includes(segment);
      strokes.push({role: `key-${digit}`, position: [x + sx, y + sy, -.067], dimensions: horizontal ? [.029, .004, .003] : [.004, .022, .003]});
    }
  }
  batches(reader, 'keypad-digit-strokes', strokes, trim);
  box(reader, 'keypad-call-button', [.16, .035, .012], [0, -.25, -.059], indicator);
  // Recessed crown and roof planting stay below the declared height rather than silently adding metres.
  box(anchor, 'roof-energy-band', [length - 1, .012, depth - 1], [0, heightM - .006, 0], trim);
  for (const x of [-length * .3, length * .3]) box(anchor, 'roof-garden-court', [15.5, .012, depth - 3], [x, heightM - .006, 0], green);
  box(anchor, 'roof-solar-court', [11, .012, 8], [0, heightM - .006, 0], glass);
  const site = new THREE.Group(); site.name = 'future-site-landscape'; group.add(site);
  const groundSurface = color => material(color, {roughness: .95, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4});
  const paving = groundSurface('#a8d4bb');
  for (const [name, geometry] of [['future-entrance-plaza', design.entrance?.geometryLocalM], ['future-access-path', design.entrance?.pathGeometryLocalM]]) {
    check(geometry, `Missing ${name}.`);
    const mesh = new THREE.Mesh(createPolygonGeometry(geometry, originLocalM), paving); mesh.name = name; mesh.position.y = .06; mesh.receiveShadow = true; mesh.renderOrder = 7; site.add(mesh);
  }
  // These small display offsets separate concept overlays from source surfaces, not surveyed kerb heights.
  function accessSurface(name, route, surface, displayOffsetM, centrelineColor) {
    check(route?.geometryLocalM, `Missing ${name} geometry.`);
    const mesh = new THREE.Mesh(createPolygonGeometry(route.geometryLocalM, originLocalM), surface);
    mesh.name = name; mesh.position.y = displayOffsetM; mesh.receiveShadow = true; mesh.renderOrder = 7;
    mesh.userData = {status: route.status, widthM: route.widthM, displayOffsetM}; site.add(mesh);
    if (route.centerLineLocalM) {
      check(Array.isArray(route.centerLineLocalM) && route.centerLineLocalM.length >= 2 && route.centerLineLocalM.every(finitePoint), `Invalid ${name} centreline.`);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(route.centerLineLocalM.map(point => worldPoint(point, originLocalM, displayOffsetM + .015))), new THREE.LineBasicMaterial({color: centrelineColor}));
      line.name = `${name}-centreline`; line.renderOrder = 8; line.userData.status = route.status; site.add(line);
    }
    return mesh;
  }
  if (design.maintenance) {
    const maintenance = design.maintenance, barrier = maintenance.barrier;
    check(Number.isFinite(maintenance.widthM) && maintenance.widthM > 0, 'Maintenance path needs a finite positive width.');
    accessSurface('future-maintenance-path', maintenance, groundSurface('#b9dec4'), .055, '#e7f4e9');
    check(barrier?.geometryLocalM && Number.isFinite(barrier.heightM) && barrier.heightM > 0 && Number.isFinite(barrier.elevationM), 'Ramp protection needs its finite concept dimensions and elevation.');
    const protection = new THREE.Mesh(createPolygonGeometry(barrier.geometryLocalM, originLocalM, barrier.heightM), material('#a3b7a6'));
    protection.name = 'future-ramp-protection'; protection.position.y = barrier.elevationM; protection.castShadow = true; protection.receiveShadow = true;
    protection.userData = {status: barrier.status, heightM: barrier.heightM, elevationM: barrier.elevationM}; site.add(protection);
  }
  if (design.access) {
    const access = design.access, vehicle = access.vehicle;
    check(vehicle?.approach && vehicle.turn && vehicle.lane && vehicle.exit && access.service && access.crossings?.length === 2, 'Concept access needs full through route, crossings and service review area.');
    const vehicleSurface = groundSurface('#778d94'), serviceSurface = groundSurface('#c9ad72');
    site.userData.accessStatus = access.status; site.userData.fireAccessStatus = access.fire?.status;
    accessSurface('future-vehicle-approach', {...vehicle.approach, status: vehicle.approach.status ?? vehicle.status}, vehicleSurface, .04, '#ead6a4');
    accessSurface('future-service-turn', {...vehicle.turn, status: vehicle.turn.status ?? vehicle.status}, vehicleSurface, .04, '#e2e8e6');
    accessSurface('future-service-lane', {...vehicle.lane, status: vehicle.lane.status ?? vehicle.status}, vehicleSurface, .04, '#e2e8e6');
    accessSurface('future-vehicle-exit', {...vehicle.exit, status: vehicle.status}, vehicleSurface, .04, '#ead6a4');
    accessSurface('future-service-pad', access.service, serviceSurface, .045, '#f6e6b9');
    for (const crossing of access.crossings) {
      check(crossing.pedestrianPriority === true && crossing.vehicleYieldRequired === true && crossing.gradeStatus === 'unverified', 'Crossing must retain priority and unknown grade.');
      const mesh = accessSurface(`future-pedestrian-crossing-${crossing.vehicleRouteName}`, crossing, groundSurface('#ead79a'), .075, '#fff0c6');
      mesh.userData.walkwayId = crossing.walkwayId;
      mesh.userData.pedestrianPriority = true;
      const outline = new THREE.Line(new THREE.BufferGeometry().setFromPoints(crossing.geometryLocalM.coordinates[0].map(point => worldPoint(point, originLocalM, .095))), new THREE.LineDashedMaterial({color: '#fffbea', dashSize: .4, gapSize: .22}));
      outline.name = `future-crossing-${crossing.vehicleRouteName}-marking`; outline.computeLineDistances(); outline.renderOrder = 9; site.add(outline);
    }
  }
  const entrancePoints = design.entrance.geometryLocalM.coordinates[0].slice(0, -1);
  const entranceCenter = entrancePoints.reduce((value, point) => value.map((component, axis) => component + point[axis] / entrancePoints.length), [0, 0]);
  const entrance = new THREE.Group(); entrance.name = 'future-entrance'; entrance.position.copy(worldPoint(entranceCenter, originLocalM)); entrance.rotation.copy(anchor.rotation); site.add(entrance);
  const entranceWidth = Math.min(6.8, Math.hypot(entrancePoints[0][0] - entrancePoints[1][0], entrancePoints[0][1] - entrancePoints[1][1]) * .8);
  box(entrance, 'entrance-canopy', [entranceWidth, .24, 2.4], [0, 3.25, 0], stone);
  for (const side of [-1, 1]) box(entrance, 'canopy-column', [.12, 3.15, .12], [side * (entranceWidth / 2 - .2), 1.575, .8], bronze);
  const rampCorners = ramp.geometryLocalM?.coordinates?.[0]?.slice(0, -1);
  check(rampCorners?.length === 4 && rampCorners.every(finitePoint), 'Ramp requires four finite start/end corners.');
  const rampPoints = rampCorners.map((point, index) => worldPoint(point, originLocalM, index < 2 ? ramp.startElevationM : ramp.endElevationM));
  const rampGeometry = new THREE.BufferGeometry();
  rampGeometry.setAttribute('position', new THREE.Float32BufferAttribute(rampPoints.flatMap(point => point.toArray()), 3));
  rampGeometry.setIndex([0, 1, 2, 0, 2, 3]); rampGeometry.computeVertexNormals(); rampGeometry.computeBoundingBox();
  const rampMesh = new THREE.Mesh(rampGeometry, material('#455354', {side: THREE.DoubleSide}));
  rampMesh.name = 'parking-ramp'; rampMesh.receiveShadow = true; parking.add(rampMesh);
  const rampAngle = Math.atan2(ramp.endLocalM[1] - ramp.startLocalM[1], ramp.endLocalM[0] - ramp.startLocalM[0]);
  for (const [start, end] of [[rampPoints[0], rampPoints[3]], [rampPoints[1], rampPoints[2]]]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(.12, .45, start.distanceTo(end)), trim);
    rail.name = 'parking-ramp-guard'; rail.position.copy(start).add(end).multiplyScalar(.5); rail.position.y += .25;
    rail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), end.clone().sub(start).normalize()); parking.add(rail);
  }
  const lineMaterial = new THREE.LineBasicMaterial({color: '#e1c47f'});
  const rampCentreLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([worldPoint(ramp.startLocalM, originLocalM, .02), worldPoint(ramp.endLocalM, originLocalM, ramp.endElevationM + .02)]), lineMaterial);
  rampCentreLine.name = 'parking-ramp-centreline'; parking.add(rampCentreLine);
  for (const inlet of design.conceptAnalysis?.drainage.proposedInlets ?? []) {
    check(inlet.lineLocalM?.length === 2 && inlet.lineLocalM.every(finitePoint) && Number.isFinite(inlet.elevationM), 'Drain concept must retain finite reference endpoints.');
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(inlet.lineLocalM.map(point => worldPoint(point, originLocalM, inlet.elevationM + .05))), new THREE.LineBasicMaterial({color: '#60c3de'}));
    line.name = `parking-drain-concept-${inlet.id}`; line.userData.status = 'concept_position_only_not_sized_or_connected'; parking.add(line);
  }
  const deckMesh = new THREE.Mesh(createPolygonGeometry(deck.geometryLocalM, originLocalM), material('#576e73', {side: THREE.DoubleSide}));
  deckMesh.name = 'parking-deck'; deckMesh.position.y = deck.elevationM; deckMesh.receiveShadow = true; parking.add(deckMesh);
  const deckEdge = new THREE.LineSegments(new THREE.EdgesGeometry(deckMesh.geometry), lineMaterial); deckEdge.name = 'parking-deck-outline'; deckEdge.position.y = deck.elevationM + .03; parking.add(deckEdge);
  if (design.parking.connector) {
    const connector = design.parking.connector;
    check(Number.isFinite(connector.elevationM) && connector.elevationM === deck.elevationM, 'Parking connector elevation must meet deck.');
    const mesh = new THREE.Mesh(createPolygonGeometry(connector.geometryLocalM, originLocalM), deckMesh.material); mesh.name = 'parking-connector'; mesh.position.y = connector.elevationM; parking.add(mesh);
  }
  const portal = new THREE.Group(); portal.name = 'parking-ramp-portal'; portal.position.copy(worldPoint(ramp.startLocalM, originLocalM));
  portal.rotation.y = rampAngle; parking.add(portal);
  box(portal, 'parking-entrance-header', [.24, .55, ramp.widthM], [0, 2.7, 0], glass);
  for (const sign of [-1, 1]) box(portal, 'parking-portal-post', [.24, 2.5, .2], [0, 1.25, sign * (ramp.widthM / 2 - .15)], trim);
  group.updateMatrixWorld(true);
  return group;
}

/** Cut only the displayed ground copy. Source GIS rings are never changed. */
export function withDisplayHole(geometryLocalM, holeGeometryLocalM) {
  check(geometryLocalM?.type === 'Polygon' && holeGeometryLocalM?.type === 'Polygon', 'Display cutout requires Polygon geometry.');
  const geometry = structuredClone(geometryLocalM);
  geometry.coordinates.push(structuredClone(holeGeometryLocalM.coordinates[0]));
  return geometry;
}

export function disposeArchitecture(group) {
  const geometries = new Set(), materials = new Set();
  group.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const surface of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) materials.add(surface);
  });
  geometries.forEach(geometry => geometry.dispose()); materials.forEach(surface => surface.dispose());
}
