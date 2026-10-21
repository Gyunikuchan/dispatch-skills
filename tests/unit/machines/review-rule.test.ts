import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import type { Event, HostEvent, Machine, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { resolutionRounds, reviewMachine, type ReviewState } from '../../../skills/dispatch/scripts/machines/review.ts';
import { parseReport } from '../../../skills/dispatch/scripts/domain/report.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { fakeHandlers, RUN_STARTED } from '../core/fixtures/machines.ts';

const CONFIG = {
  'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } },
  phases: { 'code-review': { rounds: { low: 2 }, targets: { low: 1 } } },
};
const started = (over: Partial<RunStartedEvent> = {}): RunStartedEvent => ({
  type: 'RUN_STARTED', verb: 'review', argument: '', level: 'low', levelSource: 'explicit', pins: null,
  orchestrator: 'claude', orchestratorModel: null, overrides: {}, config: CONFIG, repo: {}, ...over,
});
const finding = (id: string, over: Record<string, unknown> = {}) => ({
  id, severity: 'MUST', category: 'correctness', locus: 'src/a.ts:L3', defect: 'null deref', requiredChange: 'guard it', sources: ['codex[0]'], scope: 'in', ...over,
});
const prepared = (n: number): Event => ({ type: 'REVIEW_PREPARED', effectId: `review.prepare-review.${n}`, scope: {}, promptPaths: { 'codex[0]': 'p0' } });
const waveDone = (n: number, findings: unknown[]): Event => ({ type: 'WAVE_DONE', effectId: `review.wave.${n}`, round: n, slots: [{ slot: 'codex[0]', state: 'success' }], findings: findings as never });
const rulings = (map: Record<string, unknown>): HostEvent => ({ type: 'RULINGS', rulings: map as never });

test('ruling-reason: reject and downgrade require a nonblank string before consumption', () => {
  const state = drive([started(), prepared(1), waveDone(1, [finding('R1-F001', { severity: 'CONSIDER' })])]);
  for (const ruling of ['reject', 'downgrade']) {
    for (const reason of [undefined, '', '  ', 42]) {
      const event = rulings({ 'R1-F001': { ruling, reason } });
      assert.match(reviewMachine.validate?.(state, event) ?? '', /reason.*nonblank/);
      assert.deepEqual(reviewMachine.step(state, event).state, state);
    }
    const reason = ruling === 'reject' ? 'recorded decision D2; no new evidence' : 'Evidence in D2';
    const event = rulings({ 'R1-F001': { ruling, reason, severity: 'CONSIDER' } });
    assert.equal(reviewMachine.validate?.(state, event), null);
    const events: Event[] = [event];
    let next = reviewMachine.step(state, event).state;
    if (next.tag === 'decide-opt-in') {
      const decision = { type: 'DECISION', kind: 'opt-in', answer: [] } as const;
      events.push(decision);
      next = drive([decision], next);
    }
    assert.equal(next.tag, 'settled');
    assert.equal('c' in next && next.c.findings[0]?.resolution, reason);
    assert.equal('c' in next && next.c.findings[0]?.status, ruling === 'reject' ? 'rejected' : 'downgraded');
    assert.deepEqual(drive(events, state), next);
  }
});

function drive(events: readonly Event[], from: ReviewState = reviewMachine.initial()): ReviewState {
  return events.reduce((state, event) => reviewMachine.step(state, event).state, from);
}

for (const kind of ['plan', 'design'] as const) test(`spec ${kind} finding requires intent authority and spec revision retains history`, () => {
  const parsed = parseReport({ kind, source: 'codex[0]', text: JSON.stringify({ status: 'FINDINGS', findings: [{ severity: 'MUST', locus: '§ Spec: Requirements', tag: 'spec', defect: 'Requirement missing', requiredChange: 'Settle the requirement' }] }) });
  assert.ok(parsed.ok);
  const state = drive([started({ argument: `target.${kind}.md`, overrides: { kind } }), prepared(1), waveDone(1, [{ ...parsed.findings[0], id: 'R1-F001' }])]);
  assert.match(reviewMachine.validate?.(state, rulings({ 'R1-F001': { ruling: 'accept' } })) ?? '', /intent finding/);
  for (const ruling of ['accept', 'reject']) {
    const event = rulings({ 'R1-F001': { ruling, by: 'orchestrator', reason: 'DEC-1 settles this', fix: { affectedPaths: ['target.md'], dependsOn: [], verification: [] } } });
    assert.equal(reviewMachine.validate?.(state, event), null);
    const settled = reviewMachine.step(state, event).state;
    assert.equal(settled.tag, ruling === 'accept' ? 'fix' : 'settled');
    assert.ok('c' in settled); assert.equal(settled.c.findings[0]?.resolution, 'orchestrator: DEC-1 settles this');
  }
  const pending = drive([rulings({ 'R1-F001': { ruling: 'needs-user' } })], state);
  assert.equal(pending.tag, 'decide-needs-user');
  const identity = { path: 'revised.spec.md', hash: `sha256:${'b'.repeat(64)}` };
  let revised = reviewMachine.step(pending, { type: 'SPEC_SETTLED', ...identity });
  assert.equal(revised.state.tag, 'pin-check');
  revised = reviewMachine.step(revised.state, { type: 'ARTIFACT_PARSED', effectId: revised.effects[0]!.id, kind, hash: 'artifact-hash', parsed: {}, defects: [], governing: { pinned: identity.hash, current: identity.hash, design: null, reqIds: ['REQ-1'] } });
  assert.equal(revised.state.tag, 'prepare');
  assert.ok('c' in revised.state);
  assert.deepEqual(revised.state.c.spec.governingSpec, identity);
  assert.equal(revised.state.c.findings.length, 1);
  assert.equal(revised.state.c.findings[0]?.category, 'intent');
  assert.equal(revised.state.c.findings[0]?.status, 'superseded');
  assert.equal(revised.state.c.rounds.length, 1);
});

test('ruling validation: intent requires recorded authority', () => {
  const state = drive([started(), prepared(1), waveDone(1, [finding('R1-F001', { category: 'intent' })])]);
  const error = reviewMachine.validate?.(state, rulings({ 'R1-F001': { ruling: 'accept' } }));
  assert.equal(error, "event.rulings.R1-F001.ruling: expected needs-user, accept|reject with the user's quote, or accept|reject by orchestrator with a reason, for an intent finding");
  assert.doesNotMatch(error ?? '', /\n/);
  assert.equal(reviewMachine.validate?.(state, rulings({ 'R1-F001': { ruling: 'needs-user' } })), null);
  assert.match(reviewMachine.validate?.(state, rulings({})) ?? '', /missing ruling for R1-F001/);
});

test('ruling resolution: needs-user records the user ruling', () => {
  const state = drive([started(), prepared(1), waveDone(1, [finding('R1-F001', { category: 'intent' })]), rulings({ 'R1-F001': { ruling: 'needs-user' } })]);
  assert.equal(state.tag, 'decide-needs-user');
  const frame = reviewMachine.project(state);
  assert.equal(frame.data['kind'], 'needs-user');
  assert.equal(reviewMachine.awaitOf(state), 'decide');
  assert.match(reviewMachine.validate?.(state, { type: 'DECISION', kind: 'needs-user', answer: {} }) ?? '', /R1-F001/);
  const done = drive([{ type: 'DECISION', kind: 'needs-user', answer: { 'R1-F001': { ruling: 'reject', quote: 'keep the current API' } } }], state);
  assert.equal(done.tag, 'settled');
  assert.equal('c' in done && done.c.findings[0]?.resolution, 'user: keep the current API');
  assert.equal('c' in done && done.c.findings[0]?.status, 'rejected');
});

test('review-needs-user-accept: a user-accepted finding joins the fix batch', () => {
  const state = drive([started(), prepared(1), waveDone(1, [finding('R1-F001', { category: 'intent' })]), rulings({ 'R1-F001': { ruling: 'needs-user' } })]);
  assert.match(reviewMachine.validate?.(state, { type: 'DECISION', kind: 'needs-user', answer: { 'R1-F001': 'yes' } }) ?? '', /ruling: accept/);
  const fix = drive([{ type: 'DECISION', kind: 'needs-user', answer: { 'R1-F001': { ruling: 'accept', quote: 'yes', fix: { affectedPaths: ['src/a.ts'], dependsOn: [], verification: [] } } } }], state);
  assert.equal(fix.tag, 'fix');
  assert.deepEqual(fix.tag === 'fix' && fix.clusters.flatMap((cluster) => cluster.findingIds), ['R1-F001']);
});

test('regression → decide:escalation → escalated on stop', () => {
  const config = { ...CONFIG, phases: { 'code-review': { rounds: { low: 3 }, targets: { low: 1 } } } };
  const applyAndVerify = (fix: ReviewState, n: number): ReviewState => {
    assert.equal(fix.tag, 'fix');
    const clusterId = fix.tag === 'fix' ? fix.clusters[0]?.clusterId : '';
    return drive([
      { type: 'FIXES_APPLIED', clusters: [{ clusterId, status: 'applied' }] },
      { type: 'VERIFY_DONE', effectId: `review.verify.${n}`, purpose: 'fix-verify', results: [], fingerprint: {} },
    ], fix);
  };
  const round2 = applyAndVerify(drive([started({ config }), prepared(1), waveDone(1, [finding('R1-F001')]), rulings({ 'R1-F001': { ruling: 'accept' } })]), 1);
  assert.equal(round2.tag, 'prepare');
  const reopened = drive([prepared(2), waveDone(2, [finding('R2-F001')])], round2);
  assert.equal(reopened.tag, 'rule', 'the first match of an applied fix reopens it');
  const round3 = applyAndVerify(drive([rulings({ 'R2-F001': { ruling: 'accept' } })], reopened), 2);
  const halted = drive([prepared(3), waveDone(3, [finding('R3-F001')])], round3);
  assert.equal(halted.tag, 'decide-escalation');
  assert.deepEqual(reviewMachine.project(halted).data['items'], ['R1-F001']);
  assert.match(reviewMachine.validate?.(halted, { type: 'DECISION', kind: 'escalation', answer: 'go' }) ?? '', /only "stop"/);
  const escalated = drive([{ type: 'DECISION', kind: 'escalation', answer: 'stop' }], halted);
  assert.equal(escalated.tag, 'escalated');
  assert.equal(reviewMachine.project(escalated).data['outcome'], 'stopped');
});

test('deadlock: a pending rejection re-raised twice escalates', () => {
  const reject = (id: string) => rulings({ [id]: { ruling: 'reject', reason: 'intentional behavior; retained scenario evidence' } });
  const config = { ...CONFIG, phases: { 'code-review': { rounds: { low: 4 }, targets: { low: 1 } } } };
  const state = drive([started({ config }), prepared(1), waveDone(1, [finding('R1-F001')]), reject('R1-F001'),
    prepared(2), waveDone(2, [finding('R2-F001')]), reject('R2-F001'), prepared(3), waveDone(3, [finding('R3-F001')])]);
  assert.equal(state.tag, 'decide-escalation');
  assert.equal(state.tag === 'decide-escalation' && state.escalation.kind, 'deadlock');
});

// SECTION: Unknown tag recovery

const recovered = (id: string, over: Record<string, unknown> = {}) => finding(id, { category: 'uncategorized', originalTag: 'robustness', ...over });
const known = (id: string) => finding(id, { locus: 'src/b.ts:L40', defect: 'quadratic scan over rows', requiredChange: 'index the lookup' });

test('ruling parser: orchestrator accept and reject record settled intent', () => {
  for (const ruling of ['accept', 'reject'] as const) {
    const state = drive([started(), prepared(1), waveDone(1, [finding('R1-F001', { category: 'intent' })])]);
    const event = rulings({ 'R1-F001': { ruling, by: 'orchestrator', reason: 'settled decision D2', fix: { affectedPaths: ['src/a.ts', 'tests/a.test.ts'], dependsOn: [], verification: ['npm test'] } } });
    assert.equal(reviewMachine.validate?.(state, event), null, ruling);
    const next = reviewMachine.step(state, event).state;
    assert.equal(next.tag, ruling === 'accept' ? 'fix' : 'settled', ruling);
    assert.ok('c' in next);
    assert.equal(next.c.findings[0]?.resolution, 'orchestrator: settled decision D2', ruling);
    assert.equal(next.c.findings[0]?.status, ruling === 'accept' ? 'accepted' : 'rejected', ruling);
    assert.deepEqual(next.c.findings[0]?.fix, { paths: ['src/a.ts', 'tests/a.test.ts'], dependencies: [], verification: ['npm test'] }, ruling);
  }
});

test('ruling validation: orchestrator intent needs a nonblank reason', () => {
  const state = drive([started(), prepared(1), waveDone(1, [finding('R1-F001', { category: 'intent' })])]);
  for (const ruling of ['accept', 'reject', 'downgrade']) for (const reason of [undefined, '', '  ', 42]) {
    const event = rulings({ 'R1-F001': { ruling, by: 'orchestrator', reason } });
    assert.match(reviewMachine.validate?.(state, event) ?? '', /ruling: expected /);
    assert.deepEqual(reviewMachine.step(state, event).state, state);
  }
});

test('ruling validation: unsupported authority falls back to user validation', () => {
  const state = drive([started(), prepared(1), waveDone(1, [finding('R1-F001', { category: 'intent' })])]);
  for (const by of ['user', 'Orchestrator', 42]) {
    const event = rulings({ 'R1-F001': { ruling: 'reject', by, reason: 'D2' } });
    assert.match(reviewMachine.validate?.(state, event) ?? '', /ruling: expected /);
    assert.deepEqual(reviewMachine.step(state, event).state, state);
    const quoted = rulings({ 'R1-F001': { ruling: 'reject', by, quote: 'keep it' } });
    assert.equal(reviewMachine.validate?.(state, quoted), null);
    const next = reviewMachine.step(state, quoted).state;
    assert.equal('c' in next && next.c.findings[0]?.resolution, 'user: keep it');
  }
});

test('rule frame exposes recovered original tag for uncategorized finding', () => {
  const state = drive([started(), prepared(1), waveDone(1, [recovered('R1-F001'), known('R1-F002')])]);
  assert.equal(state.tag, 'rule');
  const findings = reviewMachine.project(state).data['findings'] as Record<string, unknown>[];
  assert.deepEqual(findings.map((item) => [item['id'], item['category'], item['originalTag'] ?? null]), [
    ['R1-F001', 'uncategorized', 'robustness'], ['R1-F002', 'correctness', null],
  ]);
  assert.ok(!('originalTag' in (findings[1] ?? {})));
});

test('uncategorized finding takes an ordinary ruling', () => {
  const state = drive([started(), prepared(1), waveDone(1, [recovered('R1-F001', { originalTag: 'Intent' })])]);
  const event = rulings({ 'R1-F001': { ruling: 'accept' } });
  assert.equal(reviewMachine.validate?.(state, event), null);
  const next = reviewMachine.step(state, event).state;
  const ruled = 'c' in next ? next.c.findings[0] : undefined;
  assert.deepEqual([ruled?.status, ruled?.category, ruled?.originalTag], ['accepted', 'uncategorized', 'Intent']);
});

test('resolution entries preserve original tag for uncategorized findings', () => {
  const state = drive([started(), prepared(1), waveDone(1, [recovered('R1-F001'), known('R1-F002')]),
    rulings({ 'R1-F001': { ruling: 'accept' }, 'R1-F002': { ruling: 'accept' } })]);
  assert.ok('c' in state);
  const entries = resolutionRounds(state.c)[0]?.entries ?? [];
  assert.deepEqual(entries.map((entry) => [entry.id, entry.originalTag ?? null]), [['R1-F001', 'robustness'], ['R1-F002', null]]);
  assert.ok(!('originalTag' in (entries[1] ?? {})));
});

test('ruling resolution: intent finding ruled with a user quote', () => {
  const review = drive([started(), prepared(1), waveDone(1, [finding('R1-F001', { category: 'intent' })])]);
  for (const quote of [undefined, '', '  ']) {
    const event = rulings({ 'R1-F001': { ruling: 'reject', reason: 'user declined', quote } });
    assert.match(reviewMachine.validate?.(review, event) ?? '', /^event\.rulings\.R1-F001\.ruling: expected /);
    assert.deepEqual(reviewMachine.step(review, event).state, review);
  }
  const downgrade = rulings({ 'R1-F001': { ruling: 'downgrade', reason: 'minor', severity: 'CONSIDER', quote: 'minor' } });
  assert.match(reviewMachine.validate?.(review, downgrade) ?? '', /expected /);
  const reject = rulings({ 'R1-F001': { ruling: 'reject', quote: 'keep the current API' } });
  assert.equal(reviewMachine.validate?.(review, reject), null);
  const settled = drive([reject], review);
  assert.equal(settled.tag, 'settled');
  const rejected = 'c' in settled ? settled.c.findings[0] : undefined;
  assert.deepEqual([rejected?.status, rejected?.resolution], ['rejected', 'user: keep the current API']);
  const accept = rulings({ 'R1-F001': { ruling: 'accept', quote: 'yes, rename it', fix: { affectedPaths: ['src/a.ts'], dependsOn: [], verification: [] } } });
  const fix = drive([accept], review);
  assert.equal(fix.tag, 'fix');
  assert.deepEqual(fix.tag === 'fix' && fix.clusters.flatMap((cluster) => cluster.findingIds), ['R1-F001']);
  assert.equal('c' in fix && fix.c.findings[0]?.resolution, 'user: yes, rename it');
});

// SECTION: Rule frame transport and fallback evidence

test('rule frame inlines finding text capped at 512 UTF-8 bytes while the findings file keeps the full text', async () => {
  const long = `a${'é'.repeat(400)}`;
  const exact = 'x'.repeat(512);
  const state = drive([started(), prepared(1), waveDone(1, [finding('R1-F001', { defect: long, requiredChange: exact })])]);
  assert.equal(state.tag, 'rule');
  const machine: Machine<number> = { transitions: [], initial: () => 0, step: (value) => ({ state: value, effects: [] }), awaitOf: () => 'rule', project: () => reviewMachine.project(state) };
  const ports = fakePorts(), runDir = path.join(tempDir(), 'runs', '001-review');
  const result = await start({ ports, runDir, runRel: 'runs/001-review', machine, handlers: fakeHandlers, runStarted: RUN_STARTED });
  const [row] = result.frame?.data['findings'] as Record<string, unknown>[];
  const defect = String(row?.['defect']);
  assert.match(defect, / \[truncated\]$/);
  assert.equal(Buffer.byteLength(defect), 511, 'cut on a code-point boundary within 512 bytes');
  assert.ok(long.startsWith(defect.slice(0, -' [truncated]'.length)));
  assert.equal(row?.['requiredChange'], exact, 'text at the cap is unchanged');
  assert.deepEqual([row?.['id'], row?.['severity'], row?.['category'], row?.['locus']], ['R1-F001', 'MUST', 'correctness', 'src/a.ts:L3']);
  const stored = JSON.parse(fs.readFileSync(path.join(runDir, 'rule.findings.json'), 'utf8')) as Record<string, unknown>[];
  assert.equal(stored[0]?.['defect'], long);
});

test('empty fallback slot concern - a fallback slot with no findings is reported, productive and primary slots are not', () => {
  const reserve = { slot: 'codex[0]', state: 'reserve', by: 'claude[0]', model: 'opus', record: 'reserve claude[0] for codex[0]', reason: 'quota' };
  const native = { slot: 'codex[0]', state: 'native', sourceKey: 'codex[0]#fallback', reason: 'quota', records: [] };
  const cases: [string, Record<string, unknown>, unknown[], string[]][] = [
    ['empty reserve', reserve, [], ['review slot codex[0]: no findings after fallback to opus']],
    ['empty native fallback', native, [], ['review slot codex[0]: no findings after fallback to native']],
    ['productive reserve', reserve, [finding('R1-F001', { sources: ['claude[0]'] })], []],
    ['productive native fallback', native, [finding('R1-F001', { sources: ['codex[0]'] })], []],
    ['empty primary', { slot: 'codex[0]', state: 'success' }, [], []],
  ];
  for (const [name, slot, findings, concerns] of cases) {
    const state = drive([started(), prepared(1), { type: 'WAVE_DONE', effectId: 'review.wave.1', round: 1, slots: [slot], findings: findings as never }]);
    assert.ok('c' in state, name);
    assert.deepEqual(state.c.concerns ?? [], concerns, name);
    const data = reviewMachine.project(state).data;
    const projected = state.tag === 'settled' ? (data['completion'] as Record<string, unknown>)['concerns'] : data['concerns'];
    assert.deepEqual(projected ?? [], concerns, name);
  }
});
