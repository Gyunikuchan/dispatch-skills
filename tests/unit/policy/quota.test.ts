import assert from 'node:assert/strict';
import { test } from 'node:test';
import { H, quotaSnapshot } from '../../../skills/dispatch/scripts/policy/quota.ts';
import type { QuotaGeneration, QuotaKey, QuotaObservation } from '../../../skills/dispatch/scripts/core/types.ts';

test('quota eligibility preserves exact keys and bounded expiry', async (t) => {
  const key: QuotaKey = { provider: 'codex', model: null, mode: 'cli' };
  const marker: QuotaGeneration = { schemaVersion: 1, key, generation: '00000000-0000-4000-8000-000000000001' };
  const observation: QuotaObservation = { ...marker, bucket: 3, observedAt: 4 * H - 1 };
  const decide = (now: number, rows: readonly unknown[] = [observation], markers: readonly unknown[] = [marker]) => quotaSnapshot([key], markers, rows, now).decisions[0]!;
  await t.test('only the exact provider model and mode are suppressed in configured order', () => {
    const keys = [key, { ...key, provider: 'claude' }, { ...key, model: 'default' }, { ...key, model: '../alias' }, { ...key, mode: 'desktop' }];
    const result = quotaSnapshot(keys, [marker], [observation], 4 * H);
    assert.deepEqual(result.decisions.map((row) => row.key), keys);
    assert.deepEqual(result.decisions.map((row) => row.skipped), [true, false, false, false, false]);
    assert.equal(result.policyVersion, 1);
    assert.equal(result.decidedAt, 4 * H);
    assert.equal(result.decisions[0]!.reason, 'quota-cooldown');
    assert.equal(decide(4 * H).expiresAt, observation.observedAt + H);
  });
  await t.test('next bucket retains evidence until exact expiry and a backwards clock never suppresses', () => {
    assert.equal(decide(4 * H).skipped, true);
    assert.equal(decide(observation.observedAt + H - 1).skipped, true);
    assert.equal(decide(observation.observedAt + H).skipped, false);
    assert.equal(decide(observation.observedAt - 1).skipped, false);
    assert.equal(decide(Number.NaN).skipped, false);
  });
  await t.test('changed generation and invalid evidence cannot suppress', () => {
    const invalid = [null, {}, { ...observation, schemaVersion: 2 }, { ...observation, key: { ...key, model: 'default' } },
      { ...observation, generation: '00000000-0000-4000-8000-000000000002' }, { ...observation, bucket: 2 },
      { ...observation, observedAt: Number.POSITIVE_INFINITY }, { ...observation, extra: 'x'.repeat(4096) }];
    for (const row of invalid) assert.equal(decide(4 * H, [row]).skipped, false);
    assert.equal(decide(4 * H, [observation], [{ ...marker, generation: '00000000-0000-4000-8000-000000000002' }]).skipped, false);
    assert.equal(decide(4 * H, [observation], [{ ...marker, extra: 'x'.repeat(8192) }]).skipped, false);
    assert.equal(decide(4 * H, [observation], []).skipped, false);
  });
  await t.test('later failures cannot extend the first observation cooldown', () => {
    const earlier = { ...observation, observedAt: 3 * H + 1 };
    assert.equal(decide(4 * H, [observation, earlier]).expiresAt, earlier.observedAt + H);
  });
});
