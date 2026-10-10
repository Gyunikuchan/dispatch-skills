import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arr, AWAIT_ACCEPTS, lit, num, obj, oneOf, opt, rec, str, validateHostEvent } from '../../../skills/dispatch/scripts/core/validate.ts';

test('combinators accept matching values and name the failing path', () => {
  const shape = obj({ name: str, count: num, mode: lit('a', 'b'), tags: arr(str), meta: rec(num), note: opt(str), pick: oneOf<unknown>(num, str) });
  assert.deepEqual(shape({ name: 'x', count: 1, mode: 'a', tags: ['t'], meta: { k: 2 }, pick: 's' }, 'v').ok, true);
  assert.deepEqual(shape({ name: 'x', count: 1, mode: 'c', tags: [], meta: {}, pick: 1 }, 'v'), { ok: false, error: 'v.mode: expected one of "a"|"b", got "c"' });
  assert.deepEqual(shape({ name: 'x', count: 1, mode: 'a', tags: [3], meta: {}, pick: 1 }, 'v'), { ok: false, error: 'v.tags[0]: expected non-empty string, got number' });
  assert.deepEqual(shape({ name: 'x', count: 1, mode: 'a', tags: [], meta: { k: 'z' }, pick: 1 }, 'v'), { ok: false, error: 'v.meta.k: expected number, got "z"' });
  assert.deepEqual(shape({ name: 'x', count: 1, mode: 'a', tags: [], meta: {}, pick: 1, extra: 1 }, 'v'), { ok: false, error: 'v.extra: unexpected field' });
  assert.deepEqual(shape({ count: 1, mode: 'a', tags: [], meta: {}, pick: 1 }, 'v'), { ok: false, error: 'v.name: expected non-empty string, got nothing' });
});

test('an event type the current await does not accept names the expected types', () => {
  assert.deepEqual(validateHostEvent('author', { type: 'RULINGS', rulings: {} }),
    { ok: false, error: 'event.type: RULINGS is not accepted at await author; expected AUTHORED|REVISE' });
  assert.deepEqual(validateHostEvent('done', { type: 'AUTHORED', path: 'p' }),
    { ok: false, error: 'event.type: AUTHORED is not accepted at await done; expected no event' });
});

test('unknown event types and non-objects are rejected', () => {
  assert.equal(validateHostEvent('author', { type: 'NOPE' }).ok, false);
  assert.deepEqual(validateHostEvent('author', 'text'), { ok: false, error: 'event: expected object, got "text"' });
});

test('shape guards cover every accepted host event', () => {
  const samples = [
    ['author', { type: 'AUTHORED', path: 'plan.md' }],
    ['native', { type: 'NATIVE_RESULTS', slots: [{ slot: 'claude[0]' }] }],
    ['rule', { type: 'RULINGS', rulings: { F1: { ruling: 'accept' } } }],
    ['fix', { type: 'FIXES_APPLIED', clusters: [] }],
    ['write', { type: 'WRITE_ENVELOPE', envelopePath: 'e.json' }],
    ['write', { type: 'WRITE_FAILED', model: 'm', kind: 'quota', reason: 'r' }],
    ['evidence', { type: 'EVIDENCE', criteria: { SC1: {} } }],
    ['decide', { type: 'DECISION', kind: 'approval', answer: { by: 'u', quote: 'yes' } }],
    ['decide', { type: 'REVISE', artifact: 'plan', reason: 'r', evidence: 'e' }],
    ['retro', { type: 'RETRO', observations: [] }],
  ] as const;
  for (const [current, event] of samples) assert.deepEqual(validateHostEvent(current, event), { ok: true, value: event });
  assert.deepEqual(validateHostEvent('decide', { type: 'DECISION', kind: 'maybe', answer: 1 }).ok, false);
  assert.deepEqual(Object.keys(AWAIT_ACCEPTS).sort(), ['author', 'decide', 'done', 'evidence', 'fix', 'native', 'retro', 'rule', 'write']);
});

test('RETRO requires an observations array and leaves item gating to the report', () => {
  assert.equal(validateHostEvent('retro', { type: 'RETRO', observations: [{ anything: 1 }, 'text'] }).ok, true);
  assert.equal(validateHostEvent('retro', { type: 'RETRO' }).ok, false);
  assert.equal(validateHostEvent('retro', { type: 'RETRO', observations: {} }).ok, false);
});

test('native slots and task write receipts accept attested tokens and durationMs as non-negative integers', () => {
  const receipt = { envelopePath: 'e.json', task: 'T1', attempt: 1, signature: 's', handle: 'h' };
  for (const [current, event] of [
    ['native', { type: 'NATIVE_RESULTS', slots: [{ slot: 'claude[0]', tokens: 1200, durationMs: 0 }] }],
    ['write', { type: 'WRITE_ENVELOPE', ...receipt, tokens: 10, durationMs: 20 }],
    ['write', { type: 'WRITE_FAILED', model: 'm', kind: 'quota', reason: 'r', tokens: 3 }],
    ['write', { type: 'WRITE_CANCELLED', task: 'T1', attempt: 1, signature: 's', handle: 'h', reason: 'r', durationMs: 5 }],
  ] as const) assert.deepEqual(validateHostEvent(current, event), { ok: true, value: event });
  for (const [current, event] of [
    ['native', { type: 'NATIVE_RESULTS', slots: [{ slot: 'claude[0]', tokens: -1 }] }],
    ['native', { type: 'NATIVE_RESULTS', slots: [{ slot: 'claude[0]', durationMs: 1.5 }] }],
    ['write', { type: 'WRITE_ENVELOPE', ...receipt, tokens: '10' }],
  ] as const) assert.equal(validateHostEvent(current, event).ok, false, JSON.stringify(event));
});

test('level-journal: strict schemas enforce bounded rationale, attribution, and closed decision shapes', () => {
  const scope = {
    planHash: 'sha256:' + 'a'.repeat(64), objective: 'ship', invariants: [], criteria: [], approvedPaths: [],
    commandMappings: [], baselineEvidence: [], phaseObligations: { writer: [], review: [] }, remainingIncrements: [], design: null,
  };
  const valid = { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'medium', rationale: 'bounded risk', gateScope: scope } };
  assert.equal(validateHostEvent('decide', valid).ok, true);
  assert.equal(validateHostEvent('decide', { ...valid, answer: { ...valid.answer, rationale: `${'x'.repeat(500)}  \n` } }).ok, true);
  for (const answer of [null, {}, { ...valid.answer, extra: true }, { ...valid.answer, rationale: 'x'.repeat(501) }, { ...valid.answer, rationale: '   ' }]) {
    assert.equal(validateHostEvent('decide', { type: 'DECISION', kind: 'level-classification', answer }).ok, false);
  }
  for (const [kind, answer] of [
    ['level-recommendation', { choice: 'maybe', quote: 'user said so' }],
    ['scope-deviation', { by: 'user', request: {}, ruling: 'approve', rationale: 'scope' }],
    ['scope-deviation-user', { by: 'orchestrator', requestId: 'r1', choice: 'accept', quote: 'yes' }],
    ['run-stop', null],
  ] as const) assert.equal(validateHostEvent('decide', { type: 'DECISION', kind, answer }).ok, false);
  assert.equal(validateHostEvent('decide', { type: 'DECISION', kind: 'run-stop', answer: { by: 'user', quote: 'stop now' } }).ok, true);
});

test('the machine check hook runs after shape and acceptance', () => {
  assert.deepEqual(validateHostEvent('author', { type: 'AUTHORED', path: 'x' }, () => 'event.path: expected a known path'),
    { ok: false, error: 'event.path: expected a known path' });
});

test('drift decision missing evidenceIds names evidenceIds', () => {
  const answer = { by: 'orchestrator', noticeId: 'n1', afterHash: 'sha256:abc', action: 'preserve', rationale: 'Unrelated edit.' };
  assert.deepEqual(validateHostEvent('decide', { type: 'DECISION', kind: 'drift', answer }),
    { ok: false, error: 'event.answer.evidenceIds: expected array, got nothing' });
  assert.equal(validateHostEvent('decide', { type: 'DECISION', kind: 'drift', answer: { ...answer, evidenceIds: [] } }).ok, true);
});
