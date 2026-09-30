import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { beginDesign, stepDesign, validateDesign, type DesignState } from '../../../skills/dispatch/scripts/machines/design.ts';
import { asParsedDesign } from '../../../skills/dispatch/scripts/domain/design.ts';

export const hash = `sha256:${'a'.repeat(64)}`;
export const design = { title: 'Delivery', box: { 'TL;DR': 'Deliver feature' }, governedText: '# Delivery', executionStatus: null, increments: [{ id: 'I01', priority: 1, summary: 'First', prerequisites: [], paths: ['src/a.ts'] }, { id: 'I02', priority: 2, summary: 'Second', prerequisites: ['I01'], paths: ['src/b.ts'] }], details: { I01: { Outcome: 'First behavior' }, I02: { Outcome: 'Second behavior' } } };
export const run = (verb: 'design' | 'implement' = 'design'): RunStartedEvent => ({ type: 'RUN_STARTED', verb, argument: 'x.design.md', level: 'low', levelSource: 'explicit', pins: null, fix: true, orchestrator: 'claude', orchestratorModel: null, overrides: { sessionDir: '/session' }, repo: {}, config: { 'write-subagents': { claude: { low: { model: 'writer' } } }, 'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } }, phases: { 'design-review': { rounds: { low: 0 }, targets: { low: 1 } }, 'plan-review': { rounds: { low: 0 }, targets: { low: 1 } }, 'code-review': { rounds: { low: 0 }, targets: { low: 1 } } } } });
export function approval(verb: 'design' | 'implement' = 'design'): DesignState {
  let result = beginDesign(run(verb));
  if (result.state.tag === 'author') result = stepDesign(result.state, { type: 'AUTHORED', path: 'x.design.md' });
  result = stepDesign(result.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: result.effects[0]!.id, hash, parsed: design, defects: [] });
  return stepDesign(result.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: result.effects[0]!.id, hash, parsed: design, defects: [] }).state;
}
test('design-stops-at-approval: hash-bound authoring completes without production effects', () => {
  const state = approval();
  assert.equal(state.tag, 'approval');
  const result = stepDesign(state, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Approved', hash } });
  assert.equal(result.state.tag, 'complete');
  assert.deepEqual(result.effects, []);
});
test('design-governed-hash: stale or unattributed approval and lint failure cannot authorize delivery', () => {
  const state = approval('implement');
  for (const answer of [{ by: 'user', quote: 'yes', hash: `sha256:${'b'.repeat(64)}` }, { by: 'agent', quote: 'yes', hash }]) {
    const event = { type: 'DECISION' as const, kind: 'approval' as const, answer };
    assert.match(validateDesign(state, event)!, /current governed hash/);
    assert.equal(stepDesign(state, event).state, state);
  }
  const parsing = stepDesign(beginDesign(run()).state, { type: 'AUTHORED', path: 'x.design.md' });
  assert.equal(stepDesign(parsing.state, { type: 'ARTIFACT_PARSED', effectId: parsing.effects[0]!.id, kind: 'design', hash, parsed: design, defects: [{ message: 'lint' }] }).state.tag, 'author');
});
test('post-review hash changes require approval of the reparsed hash', () => {
  const parsing = stepDesign(beginDesign(run()).state, { type: 'AUTHORED', path: 'x.design.md' });
  const reviewed = stepDesign(parsing.state, { type: 'ARTIFACT_PARSED', effectId: parsing.effects[0]!.id, kind: 'design', hash, parsed: design, defects: [] });
  const newer = `sha256:${'b'.repeat(64)}`;
  const state = stepDesign(reviewed.state, { type: 'ARTIFACT_PARSED', effectId: reviewed.effects[0]!.id, kind: 'design', hash: newer, parsed: design, defects: [] }).state;
  assert.equal(state.c.hash, newer);
  assert.ok(validateDesign(state, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'old', hash } }));
});

test('journal design admission rejects malformed objectives and dependency graphs', () => {
  assert.ok(asParsedDesign(design));
  const rows = design.increments;
  const invalid = [
    { ...design, box: {} }, { ...design, box: { 'TL;DR': ' ' } },
    { ...design, increments: [{ ...rows[0]!, paths: [] }, rows[1]!] },
    { ...design, increments: [rows[0]!, { ...rows[1]!, id: 'I01' }] },
    { ...design, increments: [rows[0]!, { ...rows[1]!, priority: 1 }] },
    { ...design, increments: [{ ...rows[0]!, prerequisites: ['I99'] }, rows[1]!] },
    { ...design, increments: [{ ...rows[0]!, prerequisites: ['I02'] }, rows[1]!] },
    { ...design, increments: [rows[1]!] },
  ];
  for (const payload of invalid) assert.equal(asParsedDesign(payload), null);
});
