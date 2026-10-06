import test from 'node:test';
import assert from 'node:assert/strict';
import {APARTMENT_MODULE_PROFILE, createApartmentModuleLayout} from '../web/apartment-modules.mjs';

const building = {lengthM: 62, depthM: 22, heightM: 78.4, podiumHeightM: 4.8, floorHeightM: 3.2, facade: {baySpacingM: 7.75, dwellingGroupSize: 2, balconyDepthM: 1.4}};

test('default exterior has 23 residential floors, eight bays and four paired groups', () => {
  const layout = createApartmentModuleLayout(building);
  assert.equal(layout.floorCount, 24); assert.equal(layout.bayCount, 8); assert.equal(layout.groupCount, 4);
  assert.equal(layout.floorRows.length, 23); assert.equal(layout.bays[0].centreM, -27.125);
  assert.ok(Math.abs(layout.floorRows.at(-1).bottomM + layout.floorHeightM - 78.4) < 1e-10);
  assert.ok(layout.balconyWidthM > 0);
});

test('height comparisons rebuild complete floor rows and retain metre-sized doors', () => {
  for (const height of [18, 48, 78.4, 90]) {
    const layout = createApartmentModuleLayout(building, height);
    assert.ok(Math.abs(layout.floorRows.at(-1).bottomM + layout.floorHeightM - height) < 1e-9);
    assert.equal(layout.entrance.doorLeafWidthM, 1.48);
    for (const opening of layout.openings) assert.ok(opening.sillM + opening.heightM < layout.floorHeightM);
  }
});

test('module layout is detached, with immutable defaults and no dwelling-count claim', () => {
  const before = structuredClone(building), one = createApartmentModuleLayout(building);
  one.entrance.doorLeafWidthM = 50; one.floorRows[0].heightM = 50;
  assert.deepEqual(building, before); assert.equal(createApartmentModuleLayout(building).entrance.doorLeafWidthM, 1.48);
  assert.ok(Object.isFrozen(APARTMENT_MODULE_PROFILE.windows.living));
  assert.equal(one.status, 'exterior_repeat_layout_not_dwelling_count_or_internal_plan');
  assert.equal(one.dwellingCount, undefined);
});

test('bad dimensions, incomplete groups and invalid height fail closed', () => {
  for (const height of [NaN, Infinity, 17.9, 90.1]) assert.throws(() => createApartmentModuleLayout(building, height));
  for (const delta of [{lengthM: 0}, {depthM: Infinity}, {floorHeightM: 0}, {facade: {...building.facade, dwellingGroupSize: 3}}, {facade: {...building.facade, baySpacingM: NaN}}, {facade: {...building.facade, balconyDepthM: 5}}]) {
    assert.throws(() => createApartmentModuleLayout({...building, ...delta}));
  }
});
