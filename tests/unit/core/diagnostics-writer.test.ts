import assert from 'node:assert/strict';
import { test } from 'node:test';
import { send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import type { Handlers } from '../../../skills/dispatch/scripts/core/types.ts';
import { phaseFixture, hash, parsedPlan } from './fixtures/diagnostics.ts';

test('SC5: writer refresh retains the issued tests binding and applies to the production stage', async () => {
  const f = phaseFixture('implement'), command = 'node --test tests/feature.test.ts';
  const plan = { ...parsedPlan, criteria: [{ id: 'SC1', title: 'Behavior works', line: 1, changes: ['src/a.ts', 'tests/feature.test.ts'], verify: [{ command, final: false }], evidence: 'red', preExisting: false, redException: null, testRationale: 'Reject invalid behavior', review: null, enforcementInfeasibility: null }], changes: [...parsedPlan.changes, { action: 'NEW', path: 'tests/feature.test.ts', note: 'Behavior tests', command: null, line: 2 }], verification: { automated: [command], none: null, manual: [] } };
  const config = (model: string) => ({ ...f.runStarted.config, 'write-subagents': { claude: { low: { model } } } });
  let testsWritten = false;
  const fingerprint = () => ({ head: 'a'.repeat(40), index: 'index', worktree: testsWritten ? 'tests' : 'tree' });
  const handlers: Handlers = { ...f.options.handlers,
    'parse-artifact': async (effect) => [{ type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'plan', hash, parsed: plan, defects: [] }],
    snapshot: async (effect) => [{ type: 'SNAPSHOT', effectId: effect.id, fingerprint: fingerprint(), diff: { paths: testsWritten ? ['tests/feature.test.ts'] : [] } }],
    'check-envelope': async (effect) => { testsWritten = true; return [{ type: 'ENVELOPE_CHECKED', effectId: effect.id, envelope: { schemaVersion: 1, status: 'DONE', stage: 'RED_READY', summary: 'Tests added', evidence: ['RED-MATRIX SC1 | tests/feature.test.ts:behavior | exit 1 test:behavior'] }, defects: [], diff: { paths: ['tests/feature.test.ts'] } }]; },
    verify: async (effect) => [{ type: 'VERIFY_DONE', effectId: effect.id, purpose: effect.purpose, results: effect.commands.map((row) => ({ command: String(row['command']), exit: effect.purpose === 'red' ? 1 : 0, logPath: 'verification.log', failureId: effect.purpose === 'red' ? `${String(row['command'])}::test:behavior` : null, failedTests: effect.purpose === 'red' ? ['test:behavior'] : [], diagnostic: 'fixture', loadError: false, inputFingerprint: effect.purpose })), fingerprint: fingerprint() }],
  };
  const options = { ...f.options, handlers };
  let result = await start({ ...options, runStarted: { ...f.runStarted, argument: 'feature.plan.md', config: config('first'), overrides: { ...f.runStarted.overrides, path: 'feature.plan.md', settledPlan: { path: 'feature.plan.md', hash, outcome: 'settled' } } } });
  assert.equal(result.frame?.data['kind'], 'approval', JSON.stringify(result.frame));
  result = await send({ ...options, rawEvent: { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } } });
  assert.equal(result.frame?.await, 'write', JSON.stringify(result.frame));
  assert.equal(result.frame?.data['stage'], 'tests-only');
  const binding = { model: result.frame?.data['model'], envelopePath: result.frame?.data['envelopePath'], briefSha256: result.frame?.data['briefSha256'] };
  result = await send({ ...options, refreshConfig: true, configSource: () => config('second') });
  assert.equal((result.frame?.progress?.['executionConfig'] as { status: string }).status, 'deferred');
  assert.deepEqual({ model: result.frame?.data['model'], envelopePath: result.frame?.data['envelopePath'], briefSha256: result.frame?.data['briefSha256'] }, binding);
  assert.equal(binding.model, 'first');
  result = await send({ ...options, rawEvent: { type: 'WRITE_ENVELOPE', envelopePath: binding.envelopePath } });
  assert.equal(result.frame?.await, 'write', JSON.stringify(result.frame));
  assert.equal(result.frame?.data['stage'], 'production');
  assert.equal(result.frame?.data['model'], 'second');
  assert.equal((result.frame?.progress?.['executionConfig'] as { status: string }).status, 'applied');
});
