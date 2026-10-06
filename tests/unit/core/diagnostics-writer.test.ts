import assert from 'node:assert/strict';
import { test } from 'node:test';
import { send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import type { Handlers } from '../../../skills/dispatch/scripts/core/types.ts';
import { assessImplementation, phaseFixture, hash, parsedPlan } from './fixtures/diagnostics.ts';

test('SC5: writer refresh keeps the issued task binding and applies at the next idle launch', async () => {
  const f = phaseFixture('implement'), command = 'node --test tests/feature.test.ts';
  const criterion = (id: string, file: string) => ({ id, title: `${id} works`, line: 1, changes: [file], verify: [{ command, final: false }], evidence: 'verify', preExisting: false, redException: null, testRationale: null, review: null, enforcementInfeasibility: null });
  const task = (id: string, file: string, criteria: string[]) => ({ id, title: id, summary: `Deliver ${id}`, line: 1, prerequisites: [], criteria, paths: [file], generated: [] });
  const plan = { ...parsedPlan, criteria: [criterion('SC1', 'src/a.ts'), criterion('SC2', 'src/b.ts')], changes: [...parsedPlan.changes, { action: 'MODIFY', path: 'src/b.ts', note: 'Second', command: null, line: 2 }], verification: { automated: [command], none: null, manual: [] }, tasks: [task('T1', 'src/a.ts', ['SC1']), task('T2', 'src/b.ts', ['SC2'])] };
  const config = (model: string) => ({ ...f.runStarted.config, 'write-subagents': { claude: { low: { model } } } });
  const handlers: Handlers = { ...f.options.handlers,
    'parse-artifact': async (effect) => [{ type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'plan', hash, parsed: plan, defects: [] }],
    'check-envelope': async (effect) => [{ type: 'ENVELOPE_CHECKED', effectId: effect.id, envelope: { schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'Delivered', evidence: ['CRITERION SC1 | src/a.ts | works', 'CRITERION SC2 | src/b.ts | works'] }, defects: [], diff: { paths: [] } }],
    verify: async (effect) => [{ type: 'VERIFY_DONE', effectId: effect.id, purpose: effect.purpose, results: effect.commands.map((row) => ({ command: String(row['command']), exit: 0, logPath: 'verification.log', failureId: null, failedTests: [], diagnostic: 'fixture', loadError: false, inputFingerprint: effect.purpose })), fingerprint: { head: 'a'.repeat(40), index: 'index', worktree: 'tree' } }],
  };
  const options = { ...f.options, handlers };
  type Slot = { task: string; attempt: number; signature: string; handle: string | null; model: string; envelopePath: string; briefSha256: string };
  const slot = (frame: typeof result.frame) => (frame?.data['tasks'] as Slot[])[0]!;
  let result = await start({ ...options, runStarted: { ...f.runStarted, argument: 'feature.plan.md', config: config('first'), overrides: { ...f.runStarted.overrides, path: 'feature.plan.md', settledPlan: { path: 'feature.plan.md', hash, outcome: 'settled' } } } });
  assert.equal(result.frame?.data['kind'], 'approval', JSON.stringify(result.frame));
  result = await send({ ...options, rawEvent: { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } } });
  result = await assessImplementation(options, result);
  const pending = slot(result.frame);
  result = await send({ ...options, rawEvent: { type: 'WRITE_LAUNCHED', tasks: [{ task: 'T1', attempt: pending.attempt, signature: pending.signature, handle: 'agent-1', model: (pending as unknown as { model: string }).model, ...(typeof result.frame!.data['effort'] === 'string' ? { effort: result.frame!.data['effort'] as string } : {}) }] } });
  const binding = slot(result.frame);
  assert.equal(binding.model, 'first');
  result = await send({ ...options, refreshConfig: true, configSource: () => config('second') });
  assert.equal((result.frame?.progress?.['executionConfig'] as { status: string }).status, 'deferred');
  assert.deepEqual(slot(result.frame), binding);
  result = await send({ ...options, rawEvent: { type: 'WRITE_ENVELOPE', task: 'T1', attempt: binding.attempt, signature: binding.signature, handle: binding.handle!, envelopePath: binding.envelopePath } });
  assert.equal(result.frame?.await, 'write', JSON.stringify(result.frame));
  assert.deepEqual([slot(result.frame).task, slot(result.frame).model], ['T2', 'second']);
  assert.equal((result.frame?.progress?.['executionConfig'] as { status: string }).status, 'applied');
});
