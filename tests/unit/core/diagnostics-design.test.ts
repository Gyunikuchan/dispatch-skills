import assert from 'node:assert/strict';
import { test } from 'node:test';
import { send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { assessImplementation, deliverTasks, phaseFixture, hash, parsedPlan } from './fixtures/diagnostics.ts';
test('SC2: design increments retain their parent and separately identify embedded skipped reviews', async () => {
  const f = phaseFixture('implement', 0);
  const design = { title: 'Delivery', box: { 'TL;DR': 'Fixture behavior' }, governedText: '# Delivery', executionStatus: null, increments: [{ id: 'I01', priority: 1, summary: 'First', prerequisites: [], paths: ['src/a.ts'] }, { id: 'I02', priority: 2, summary: 'Second', prerequisites: ['I01'], paths: ['src/b.ts'] }], details: { I01: { Outcome: 'First behavior' }, I02: { Outcome: 'Second behavior' } } };
  const runStarted = { ...f.runStarted, argument: 'x.design.md', config: { ...f.runStarted.config, phases: { ...(f.runStarted.config['phases'] as object), 'design-review': { rounds: { low: 0 }, targets: { low: 1 } } } } };
  const options = { ...f.options, handlers: { ...f.options.handlers,
    'parse-artifact': async (effect: Extract<import('../../../skills/dispatch/scripts/core/types.ts').Effect, { kind: 'parse-artifact' }>) => {
      const increment = effect.path.includes('i02') ? 'I02' : 'I01';
      const file = increment === 'I01' ? 'src/a.ts' : 'src/b.ts';
      const plan = { ...parsedPlan, title: increment, box: { 'TL;DR': design.details[increment].Outcome }, changes: [{ ...parsedPlan.changes[0]!, path: file }], tasks: [{ ...parsedPlan.tasks[0]!, paths: [file] }], traceability: { Design: 'x.design.md', Revision: hash, Increment: increment, Outcome: design.details[increment].Outcome } };
      return [{ type: 'ARTIFACT_PARSED' as const, effectId: effect.id, kind: effect.artifact, hash, parsed: effect.artifact === 'design' ? design : plan, defects: [] }];
    },
    'check-envelope': async (effect: Extract<import('../../../skills/dispatch/scripts/core/types.ts').Effect, { kind: 'check-envelope' }>) => [{ type: 'ENVELOPE_CHECKED' as const, effectId: effect.id, envelope: { schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'Delivered', evidence: [] }, defects: [], diff: { paths: [effect.id.includes('i02') ? 'src/b.ts' : 'src/a.ts'] } }],
  } };
  let result = await start({ ...options, runStarted });
  assert.equal(result.frame?.data['kind'], 'approval', JSON.stringify(result.frame));
  result = await send({ ...options, rawEvent: { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Deliver', hash } } });
  for (let n = 0; n < 2; n++) {
    assert.equal(result.frame?.await, 'author', JSON.stringify(result.frame));
    result = await send({ ...options, rawEvent: { type: 'AUTHORED', path: result.frame?.data['path'] } });
    result = await assessImplementation(options, result);
    assert.equal(result.frame?.await, 'write', JSON.stringify(result.frame));
    result = await deliverTasks(options, result);
  }
  assert.equal(result.frame?.await, 'done', JSON.stringify(result.frame));
  const phases = f.capture().phases, outer = phases.find((p) => p.name === 'design')!;
  assert.equal(phases.filter((p) => p.name === 'design').length, 1);
  for (const id of ['i01', 'i02']) {
    const children = phases.filter((p) => p.id.includes(`/${id}`));
    assert.ok(children.some((p) => p.name === 'implementation'));
    assert.ok(children.some((p) => p.name === 'plan review' && p.outcome === 'skipped'));
    assert.ok(children.some((p) => p.name === 'code review' && p.outcome === 'skipped'));
    for (const child of children) assert.ok(child.start >= outer.start && child.end <= outer.end);
  }
});
