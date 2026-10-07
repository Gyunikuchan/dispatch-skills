import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixture, defects, controls, scored, ids, high } from '../helpers/audit-calibration.ts';

test('audit calibration passes three of four defects when every high or critical defect is recovered', async () => {
  const summary = await scored((f) => {
    const lowFirst = ids(defects(f)).filter((id) => !high(f).includes(id));
    return ids(defects(f)).filter((id) => id !== lowFirst[0]);
  });
  assert.equal(summary.arms.new.recovered.length, 3);
  assert.equal(summary.arms.new.pass, true);
  assert.equal(summary.pass, true);
});

test('audit calibration fails when a high or critical defect is missed even at three of four', async () => {
  const summary = await scored((f) => ids(defects(f)).filter((id) => id !== high(f)[0]));
  assert.equal(summary.arms.new.recovered.length, 3);
  assert.deepEqual(summary.arms.new.highMissed, [high(fixture())[0]]);
  assert.equal(summary.pass, false);
});

test('audit calibration fails below three recovered defects', async () => {
  const summary = await scored((f) => high(f).slice(0, 2));
  assert.ok(summary.arms.new.recovered.length < 3);
  assert.equal(summary.pass, false);
});

test('audit calibration counts a defect claim against an intentional control as a false defect', async () => {
  const summary = await scored((f) => ids(defects(f)), { controlDefect: true });
  assert.equal(summary.arms.new.controlFalseDefects.length, 2);
  assert.equal(summary.pass, false);
});

test('audit calibration reports a case without results as missing and fails', async () => {
  const f = fixture();
  const summary = await scored((g) => ids(defects(g)), { skip: controls(f)[0].id });
  assert.deepEqual(summary.arms.new.missingCases, [controls(f)[0].id]);
  assert.equal(summary.pass, false);
});
