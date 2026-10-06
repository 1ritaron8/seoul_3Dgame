import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemoEntranceAccess} from '../web/entrance-access.mjs';

test('shared entrance remains closed on wrong or empty input and opens only for the public demo code', () => {
  const control = createDemoEntranceAccess();
  assert.equal(control.snapshot().state, 'closed');
  assert.equal(control.submit(100).state, 'error');
  control.input('1111'); assert.equal(control.submit(200).state, 'error');
  assert.equal(control.snapshot().closeAtMs, null);
  assert.equal(control.input('2050').maskedDigits, '●●●●');
  const open = control.submit(1000); assert.equal(open.state, 'open'); assert.equal(open.closeAtMs, 6000);
  assert.equal(open.digitCount, 0); assert.equal(open.digits, undefined);
});

test('automatic door stays open for five seconds, closes at the boundary and can be reopened or cancelled', () => {
  const control = createDemoEntranceAccess(); control.input('2050'); control.submit(1000);
  assert.equal(control.update(5999).state, 'open'); assert.equal(control.update(6000).state, 'closed');
  assert.equal(control.update(8000).closeAtMs, null);
  control.input('2050'); assert.equal(control.submit(9000).state, 'open');
  assert.equal(control.input('1234').state, 'open'); assert.equal(control.clear().state, 'open');
  assert.equal(control.close().state, 'closed');
  control.input('123'); assert.equal(control.clear().digitCount, 0);
});

test('demo controller rejects nonnumeric or overlong input, bad timing and invalid settings without widening access', () => {
  for (const options of [{demoCode: 'abc'}, {demoCode: 2050}, {demoCode: '12'}, {demoCode: '1234567'}, {openDurationMs: NaN}, {openDurationMs: 0}]) assert.throws(() => createDemoEntranceAccess(options));
  const control = createDemoEntranceAccess();
  for (const value of ['12x', '1234567', 2050, null]) assert.throws(() => control.input(value));
  control.input('2050'); for (const now of [-1, Infinity, NaN, '0']) assert.throws(() => control.submit(now));
  assert.equal(control.snapshot().state, 'entering');
  const detached = control.snapshot(); detached.state = 'open'; assert.equal(control.snapshot().state, 'entering');
  control.clear(); assert.equal(control.snapshot().state, 'closed');
  control.update(100); assert.throws(() => control.update(99), /monotonic/);
});
