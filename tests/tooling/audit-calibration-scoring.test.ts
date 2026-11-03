import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixture, defects, controls, scored, ids, high } from '../helpers/audit-calibration.ts';

test('audit calibration evaluates recovery thresholds and high-severity requirements', async () => {
  const passSummary = await scored((f) => {
    const lowFirst = ids(defects(f)).filter((id) => !high(f).includes(id));
    return ids(defects(f)).filter((id) => id !== lowFirst[0]);
  });
  assert.equal(passSummary.arms.new.recovered.length, 3);
  assert.equal(passSummary.arms.new.pass, true);
  assert.equal(passSummary.pass, true);

  const missHighSummary = await scored((f) => ids(defects(f)).filter((id) => id !== high(f)[0]));
  assert.equal(missHighSummary.arms.new.recovered.length, 3);
  assert.deepEqual(missHighSummary.arms.new.highMissed, [high(fixture())[0]]);
  assert.equal(missHighSummary.pass, false);

  const lowCountSummary = await scored((f) => high(f).slice(0, 2));
  assert.ok(lowCountSummary.arms.new.recovered.length < 3);
  assert.equal(lowCountSummary.pass, false);

  const controlSummary = await scored((f) => ids(defects(f)), { controlDefect: true });
  assert.equal(controlSummary.arms.new.controlFalseDefects.length, 2);
  assert.equal(controlSummary.pass, false);

  const f = fixture();
  const missingSummary = await scored((g) => ids(defects(g)), { skip: controls(f)[0].id });
  assert.deepEqual(missingSummary.arms.new.missingCases, [controls(f)[0].id]);
  assert.equal(missingSummary.pass, false);
});
