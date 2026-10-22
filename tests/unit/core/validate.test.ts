import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JOURNAL_PROTOCOL_REVISION } from '../../../skills/dispatch/scripts/core/types.ts';
import { arr, AWAIT_ACCEPTS, lit, num, obj, oneOf, opt, rec, str, validateHostEvent } from '../../../skills/dispatch/scripts/core/validate.ts';

const IDENTITY = { task: 'T1', attempt: 1, signature: 'sig', handle: 'writer-T1' } as const;
const AMEND = { type: 'AMEND', delta: [{ kind: 'modify', target: 'T2', current: 'old', proposed: 'new' }], notify: [{ task: 'T2', notice: 'T2 owns src/b.ts now' }], rationale: 'T1 needs the shared helper' } as const;

test('level-recommendation decisions are rejected', () => {
  assert.equal(validateHostEvent('decide', { type: 'DECISION', kind: 'level-recommendation', answer: { choice: 'retain', quote: 'Keep medium.' } }).ok, false);
});

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
    { ok: false, error: 'event.type: RULINGS is not accepted at await author; expected AUTHORED|REVISE|SPEC_REVISED' });
  assert.deepEqual(validateHostEvent('done', { type: 'AUTHORED', path: 'p' }),
    { ok: false, error: 'event.type: AUTHORED is not accepted at await done; expected no event' });
});

test('unknown event types and non-objects are rejected', () => {
  assert.equal(validateHostEvent('author', { type: 'NOPE' }).ok, false);
  assert.deepEqual(validateHostEvent('author', 'text'), { ok: false, error: 'event: expected object, got "text"' });
});

test('an events wrapper reply is rejected with guidance to send one element of the events array', () => {
  const decision = { type: 'DECISION', kind: 'failure', answer: { by: 'orchestrator', action: 'retry', rationale: 'flaky fixture fixed' } };
  for (const wrapped of [{ events: [decision] }, { v: 1, await: 'decide', events: [decision] }]) {
    assert.deepEqual(validateHostEvent('decide', wrapped), { ok: false, error: 'event: send one event object from the frame events array, not the frame or an events wrapper.' }, JSON.stringify(wrapped));
  }
  assert.equal(validateHostEvent('decide', decision).ok, true, 'the unwrapped element is accepted');
});

test('shape guards cover every accepted host event', () => {
  const samples = [
    ['author', { type: 'AUTHORED', path: 'plan.md' }],
    ['author', { type: 'SPEC_REVISED', path: 's.spec.md' }],
    ['native', { type: 'NATIVE_RESULTS', slots: [{ slot: 'claude[0]' }] }],
    ['rule', { type: 'RULINGS', rulings: { F1: { ruling: 'accept' } } }],
    ['fix', { type: 'FIXES_APPLIED', clusters: [] }],
    ['write', { type: 'WRITE_RECEIPT', status: 'submitted', envelopePath: 'e.json' }],
    ['write', { type: 'WRITE_RECEIPT', status: 'failed', detail: 'quota' }],
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
  const receipt = { type: 'WRITE_RECEIPT', status: 'submitted', envelopePath: 'e.json', briefHash: 'sha256:b', model: 'm', ...IDENTITY };
  for (const [current, event] of [
    ['native', { type: 'NATIVE_RESULTS', slots: [{ slot: 'claude[0]', tokens: 1200, durationMs: 0 }] }],
    ['write', { ...receipt, tokens: 10, durationMs: 20 }],
    ['write', { type: 'WRITE_RECEIPT', status: 'failed', detail: 'quota', tokens: 3 }],
    ['write', { type: 'WRITE_RECEIPT', status: 'cancelled', ...IDENTITY, durationMs: 5 }],
  ] as const) assert.deepEqual(validateHostEvent(current, event), { ok: true, value: event });
  for (const [current, event] of [
    ['native', { type: 'NATIVE_RESULTS', slots: [{ slot: 'claude[0]', tokens: -1 }] }],
    ['native', { type: 'NATIVE_RESULTS', slots: [{ slot: 'claude[0]', durationMs: 1.5 }] }],
    ['write', { ...receipt, tokens: '10' }],
  ] as const) assert.equal(validateHostEvent(current, event).ok, false, JSON.stringify(event));
});

test('level-journal: strict schemas enforce bounded rationale, attribution, and closed decision shapes', () => {
  const valid = { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'medium', rationale: 'bounded risk', gateScopeHash: 'sha256:' + 'a'.repeat(64) } };
  assert.equal(validateHostEvent('decide', valid).ok, true);
  assert.equal(validateHostEvent('decide', { ...valid, answer: { ...valid.answer, rationale: `${'x'.repeat(500)}  \n` } }).ok, true);
  for (const answer of [null, {}, { ...valid.answer, extra: true }, { ...valid.answer, rationale: 'x'.repeat(501) }, { ...valid.answer, rationale: '   ' }]) {
    assert.equal(validateHostEvent('decide', { type: 'DECISION', kind: 'level-classification', answer }).ok, false);
  }
  for (const [kind, answer] of [
    ['level-recommendation', { choice: 'maybe', quote: 'user said so' }],
    ['request', { by: 'user', action: 'approve', rationale: 'scope' }],
    ['request-user', { by: 'orchestrator', requestId: 'r1', choice: 'accept', quote: 'yes' }],
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

test('accepts each write receipt status', () => {
  for (const event of [
    { type: 'WRITE_RECEIPT', status: 'launched', ...IDENTITY, model: 'm', effort: 'high' },
    { type: 'WRITE_RECEIPT', status: 'launched', ...IDENTITY, model: 'm2', substitution: 'configured model unavailable' },
    { type: 'WRITE_RECEIPT', status: 'submitted', ...IDENTITY, envelopePath: 'e.json', briefHash: 'sha256:b', model: 'm', effort: 'high' },
    { type: 'WRITE_RECEIPT', status: 'failed', ...IDENTITY, detail: 'quota exhausted', model: 'm' },
    { type: 'WRITE_RECEIPT', status: 'cancelled', ...IDENTITY },
    { type: 'WRITE_RECEIPT', status: 'submitted', envelopePath: 'hotfix.json' },
    { type: 'WRITE_RECEIPT', status: 'failed', detail: 'hotfix writer crashed' },
  ]) assert.deepEqual(validateHostEvent('write', event), { ok: true, value: event }, JSON.stringify(event));
  assert.deepEqual(validateHostEvent('write', { type: 'WRITE_RECEIPT', status: 'submitted', ...IDENTITY, envelopePath: 'e.json', model: 'm' }),
    { ok: false, error: 'event.briefHash: expected non-empty string, got nothing' });
  assert.deepEqual(validateHostEvent('write', { type: 'WRITE_RECEIPT', status: 'cancelled', ...IDENTITY, reason: 'r' }),
    { ok: false, error: 'event.reason: unexpected field' });
  assert.equal(validateHostEvent('write', { type: 'WRITE_RECEIPT', status: 'running', ...IDENTITY }).ok, false);
});

test('rejects removed write event types', () => {
  for (const type of ['WRITE_LAUNCHED', 'WRITE_ENVELOPE', 'WRITE_FAILED', 'WRITE_CANCELLED']) {
    const result = validateHostEvent('write', { type, ...IDENTITY, envelopePath: 'e.json' });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : '', new RegExp(`^event\\.type: expected one of .*, got "${type}"$`));
  }
});

test('accepts request event', () => {
  const event = { type: 'REQUEST', task: 'T1', attempt: 1, need: 'edit the shared helper', paths: ['src/shared.ts'], rationale: 'T1 cannot pass SC1 without it' };
  assert.deepEqual(validateHostEvent('write', event), { ok: true, value: event });
  assert.deepEqual(validateHostEvent('write', { ...event, need: ' ' }), { ok: false, error: 'event.need: expected non-empty trimmed string, got " "' });
  assert.deepEqual(validateHostEvent('write', { ...event, extra: 1 }), { ok: false, error: 'event.extra: unexpected field' });
});

test('accepts amend event', () => {
  assert.deepEqual(validateHostEvent('write', AMEND), { ok: true, value: AMEND });
  const gated = { ...AMEND, delta: [{ kind: 'remove', target: 'T3' }], notify: [], by: { by: 'user', quote: 'drop T3' } };
  assert.deepEqual(validateHostEvent('write', gated), { ok: true, value: gated });
  assert.deepEqual(validateHostEvent('write', { ...AMEND, delta: [] }), { ok: false, error: 'event.delta: expected non-empty array, got array' });
  assert.deepEqual(validateHostEvent('write', { ...AMEND, by: { by: 'orchestrator', quote: 'q' } }), { ok: false, error: 'event.by.by: expected one of "user", got "orchestrator"' });
  assert.deepEqual(validateHostEvent('write', { ...AMEND, delta: [{ kind: 'rename', target: 'T2' }] }), { ok: false, error: 'event.delta[0].kind: expected one of "modify"|"remove"|"add", got "rename"' });
});

test('accepts generic orchestrator decision', () => {
  const ruling = (kind: string, action: string, extra: object = {}) => ({ type: 'DECISION', kind, answer: { by: 'orchestrator', action, rationale: 'evidence-backed ruling', ...extra } });
  for (const event of [
    ruling('integration-conflict', 'resolve'),
    ruling('integration-conflict', 'discard', { amendment: 'sha256:amended' }),
    ruling('request', 'approve'), ruling('request', 'decline'), ruling('request', 'escalate'),
    ruling('failure', 'stop'), ruling('failure', 'retry'),
    ruling('failure', 'hotfix', { mode: 'writer', external: [{ path: 'vendor/x.ts', reason: 'generated' }] }),
    { type: 'DECISION', kind: 'failure', answer: { by: 'user', action: 'manual-complete', quote: 'mark SC1 done', criteria: { SC1: { outcome: 'pass' } } } },
    { type: 'DECISION', kind: 'request-user', answer: { by: 'user', requestId: 'r1', choice: 'decline', quote: 'no' } },
  ]) assert.deepEqual(validateHostEvent('decide', event), { ok: true, value: event }, JSON.stringify(event));
  for (const [event, error] of [
    [ruling('integration-conflict', 'delegate'), 'event.answer.action: expected one of "resolve"|"discard", got "delegate"'],
    [ruling('failure', 'retry', { rootCause: 'flaky' }), 'event.answer.rootCause: unexpected field'],
    [ruling('failure', 'hotfix', { external: [] }), 'event.answer.mode: expected one of "inline"|"writer", got nothing'],
    [{ type: 'DECISION', kind: 'request', answer: { by: 'orchestrator', action: 'approve' } }, 'event.answer.rationale: expected non-empty trimmed string, got nothing'],
    [{ type: 'DECISION', kind: 'request-user', answer: { by: 'user', requestId: 'r1', choice: 'accept' } }, 'event.answer.quote: expected non-empty trimmed string, got nothing'],
  ] as const) assert.deepEqual(validateHostEvent('decide', event), { ok: false, error }, JSON.stringify(event));
  for (const kind of ['scope-deviation', 'scope-deviation-user']) assert.equal(validateHostEvent('decide', { type: 'DECISION', kind, answer: {} }).ok, false);
});

test('write await accepts receipt request amend', () => {
  assert.deepEqual(AWAIT_ACCEPTS.write, ['WRITE_RECEIPT', 'REQUEST', 'AMEND', 'REPLACE_PLAN']);
  assert.deepEqual(validateHostEvent('write', { type: 'REVISE', artifact: 'plan', reason: 'r', evidence: 'e' }),
    { ok: false, error: 'event.type: REVISE is not accepted at await write; expected WRITE_RECEIPT|REQUEST|AMEND|REPLACE_PLAN' });
});

test('decide await accepts amend', () => {
  assert.deepEqual(AWAIT_ACCEPTS.decide, ['DECISION', 'AMEND', 'REPLACE_PLAN', 'REVISE', 'REVIEW_USE', 'SPEC_REVISED']);
  assert.deepEqual(validateHostEvent('decide', AMEND), { ok: true, value: AMEND });
  assert.equal(validateHostEvent('decide', { type: 'REQUEST', task: 'T1', attempt: 1, need: 'n', paths: [], rationale: 'r' }).ok, false);
});

test('host events: spec revision is accepted at author, rule, evidence and decide only', () => {
  const event = { type: 'SPEC_REVISED', path: 'session/s.spec.md' };
  for (const current of ['author', 'rule', 'evidence', 'decide'] as const) assert.deepEqual(validateHostEvent(current, event), { ok: true, value: event }, current);
  for (const current of ['native', 'write', 'fix'] as const) assert.match(String((validateHostEvent(current, event) as { error?: string }).error), /SPEC_REVISED is not accepted/, current);
  assert.equal(validateHostEvent('author', { type: 'SPEC_REVISED', path: ' ' }).ok, false);
});

test('host events: spec approval requires a user quote and hash or stop', () => {
  const answer = { by: 'user', quote: 'Approve', hash: 'sha256:abc' };
  assert.equal(validateHostEvent('decide', { type: 'DECISION', kind: 'spec-approval', answer }).ok, true);
  assert.equal(validateHostEvent('decide', { type: 'DECISION', kind: 'spec-approval', answer: 'stop' }).ok, true);
  assert.equal(validateHostEvent('decide', { type: 'DECISION', kind: 'spec-approval', answer: { ...answer, quote: ' ' } }).ok, false);
  assert.equal(validateHostEvent('decide', { type: 'DECISION', kind: 'spec-approval', answer: { by: 'user', quote: 'yes' } }).ok, false);
  assert.equal(validateHostEvent('decide', { type: 'DECISION', kind: 'spec-approval', answer: { ...answer, by: 'orchestrator' } }).ok, false);
  assert.equal(JOURNAL_PROTOCOL_REVISION, 11);
});
