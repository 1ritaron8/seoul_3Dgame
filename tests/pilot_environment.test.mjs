import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createFutureApartment, disposeArchitecture} from '../web/pilot-architecture.mjs';
import {approximateSolarPosition, flatGroundShadowLengthM, directRainfallScenario, buildPilotEnvironment} from '../web/pilot-environment.mjs';

const site = {year: 2050, month: 12, day: 21, latitudeDeg: 37.491322803302985, longitudeDeg: 126.87558080483242, utcOffsetHours: 9};

test('Seoul solar directions are normalized, winter southward and morning/afternoon east/west', () => {
  const morning = approximateSolarPosition({...site, hour: 9}), noon = approximateSolarPosition({...site, hour: 12}), afternoon = approximateSolarPosition({...site, hour: 15});
  assert.ok(morning.directionEastNorthUp[0] > 0 && afternoon.directionEastNorthUp[0] < 0);
  assert.ok(noon.directionEastNorthUp[1] < 0 && noon.altitudeDeg > 27 && noon.altitudeDeg < 30);
  for (const sun of [morning, noon, afternoon]) assert.ok(Math.abs(Math.hypot(...sun.directionEastNorthUp) - 1) < 1e-12);
  assert.ok(approximateSolarPosition({...site, month: 6, hour: 12}).altitudeDeg > 72);
  assert.equal(approximateSolarPosition({...site, hour: 0}).aboveHorizon, false);
});

test('equatorial equinox approaches zenith and calendar/time/location inputs reject errors', () => {
  const equinox = approximateSolarPosition({year: 2024, month: 3, day: 20, hour: 12, latitudeDeg: 0, longitudeDeg: 0, utcOffsetHours: 0});
  assert.ok(equinox.altitudeDeg > 87);
  approximateSolarPosition({...site, year: 2024, month: 2, day: 29, hour: 12});
  for (const bad of [{year: 2025, month: 2, day: 29}, {hour: 24}, {hour: NaN}, {latitudeDeg: 90}, {longitudeDeg: 181}, {utcOffsetHours: 15}, {day: 0}, {month: 13}]) assert.throws(() => approximateSolarPosition({...site, hour: 12, ...bad}));
});

test('flat ground shadow is physical metres, scales with height, and unavailable at night', () => {
  assert.ok(Math.abs(flatGroundShadowLengthM(10, 45) - 10) < 1e-12);
  assert.ok(Math.abs(flatGroundShadowLengthM(20, 45) - 20) < 1e-12);
  assert.equal(flatGroundShadowLengthM(10, 0), null); assert.equal(flatGroundShadowLengthM(10, -1), null);
  assert.ok(flatGroundShadowLengthM(10, 90) < 1e-10);
  assert.throws(() => flatGroundShadowLengthM(0, 45)); assert.throws(() => flatGroundShadowLengthM(10, NaN));
});

test('direct-rain conversion uses litres/second and cubic metres without inventing pump capacity', () => {
  const ramp = directRainfallScenario({areaM2: 216, rainfallMmPerHour: 100, durationMinutes: 30, runoffCoefficient: 1});
  assert.equal(ramp.inflowLitresPerSecond, 6); assert.equal(ramp.volumeM3, 10.8);
  const zero = directRainfallScenario({areaM2: 216, rainfallMmPerHour: 100, durationMinutes: 30, runoffCoefficient: 0});
  assert.equal(zero.volumeM3, 0); assert.equal(ramp.pumpCapacityLitresPerSecond, undefined);
  for (const bad of [{areaM2: 0}, {rainfallMmPerHour: Infinity}, {durationMinutes: -1}, {runoffCoefficient: 1.1}]) assert.throws(() => directRainfallScenario({areaM2: 216, rainfallMmPerHour: 100, durationMinutes: 30, runoffCoefficient: 1, ...bad}));
});

test('environment refuses mismatched source provenance', () => {
  assert.throws(() => buildPilotEnvironment({futureDesign: {}, provenance: {sourceSha256: 'a'}}, {schema: 'guil-pilot-site-evidence.v1', localOnly: true, publicationAllowed: false, sourcePlanSha256: 'b'}), /match/);
});

test('rendered ramp drain concepts retain six-metre span, relative elevations and non-capacity status', async () => {
  const scene = JSON.parse(await readFile(new URL('../docs/guil_2050_pilot3d.json', import.meta.url)));
  const before = structuredClone(scene), origin = scene.coordinates.originLocalM;
  const group = createFutureApartment(scene.futureDesign, origin);
  try {
    for (const inlet of scene.futureDesign.conceptAnalysis.drainage.proposedInlets) {
      const line = group.getObjectByName(`parking-drain-concept-${inlet.id}`);
      assert.ok(line?.isLine); assert.equal(line.userData.status, 'concept_position_only_not_sized_or_connected');
      const position = line.geometry.getAttribute('position'); assert.equal(position.count, 2);
      assert.ok(Math.abs(Math.hypot(position.getX(1) - position.getX(0), position.getZ(1) - position.getZ(0)) - 6) < .00002);
      for (let index = 0; index < 2; index++) {
        assert.ok(Math.abs(position.getX(index) + origin[0] - inlet.lineLocalM[index][0]) < .00002);
        assert.ok(Math.abs(origin[1] - position.getZ(index) - inlet.lineLocalM[index][1]) < .00002);
        assert.ok(Math.abs(position.getY(index) - inlet.elevationM - .05) < .000001);
      }
    }
    assert.deepEqual(scene, before);
  } finally { disposeArchitecture(group); }
});
