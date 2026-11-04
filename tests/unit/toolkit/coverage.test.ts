import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { coverageState } from '../../../skills/dispatch/scripts/toolkit/coverage.ts';
import { admission, renderBudget } from '../../../skills/dispatch/scripts/toolkit/findings.ts';
import type { Fold } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import type { LedgerRecord } from '../../../skills/dispatch/scripts/toolkit/records.ts';
import { memoryNodeFs } from '../../helpers/memory-node-fs.ts';

// SECTION: In-memory review tree

const REVIEW = 'code-integration', SPEC = {path: '/spec.md', hash: 'sha256:' + 'a'.repeat(64)};
type Attempt = {slot: string; seq: number; wholeTarget: boolean; outcome: unknown};
type Put = {
  n: number; roster: string[]; scope?: string; cap?: number; generation?: number;
  coverage?: 'open' | 'full'; coverageUse?: 'free' | 'grant'; base?: string;
  done?: string[]; failed?: string[]; native?: string[]; substitute?: string[];
  attempts?: Record<number, (Partial<Attempt> & {slot: string; seq: number})[]>;
  unfinished?: boolean; findings?: object[];
};
function tree() {
  const root = path.join(path.parse(os.tmpdir()).root, 'coverage-' + crypto.randomUUID()), cleanup = memoryNodeFs(root);
  const session = path.join(root, '.scratch/dispatch-skills/20261023T0000Z-test');
  fs.mkdirSync(session, {recursive: true});
  const write = (file: string, value: unknown) => {fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, JSON.stringify(value));};
  const put = (input: Put) => {
    const dir = path.join(session, '.state/reviews', REVIEW, 'round-' + input.n), generation = input.generation ?? 1;
    const scope = input.scope ?? (input.n === 1 ? 'Full review' : `Re-review round ${input.n} (narrowed) — changed: a.ts`);
    const whole = scope.startsWith('Full review') || input.coverage !== undefined;
    write(path.join(dir, 'round.json'), {
      round: input.n, generation, cap: input.cap ?? 2, level: 'medium', scope, startSeq: 0, spec: SPEC, target: {base: input.base ?? 'base', head: 'head' + input.n},
      roster: [...input.roster.map(slot => ({slot, provider: 'codex', index: 0, reserve: false})), {slot: 'reserve[9]', provider: 'opencode', index: 9, reserve: true}],
      ...(input.coverage ? {coverage: input.coverage} : {}), ...(input.coverageUse ? {coverageUse: input.coverageUse} : {}),
    });
    const slots = path.join(dir, 'gen-' + generation, 'slots');
    for (const slot of input.done ?? []) write(path.join(slots, slot + '.json'), {slot, state: 'done', text: 'report',
      ...(input.substitute?.includes(slot) ? {responder: {slot: 'reserve[9]', provider: 'opencode', model: null, native: false}} : {})});
    for (const slot of input.failed ?? []) write(path.join(slots, slot + '.json'), {slot, state: 'failed', cls: 'timeout', reason: 'slow'});
    for (const slot of input.native ?? []) write(path.join(slots, slot + '.json'), {slot, state: 'native', promptPath: 'p.md', replyPath: 'r.md'});
    // Each failed slot of the current generation carries its own failure entry, as the review run records it.
    const entries: Record<number, Attempt[]> = {[generation]: (input.failed ?? []).map(slot => ({slot, seq: input.n, wholeTarget: whole, outcome: 'timeout'}))};
    for (const [gen, list] of Object.entries(input.attempts ?? {})) entries[Number(gen)] = [...(entries[Number(gen)] ?? []), ...list.map(item => ({wholeTarget: whole, outcome: 'timeout', ...item}))];
    for (const [gen, list] of Object.entries(entries)) if (list.length) write(path.join(dir, 'gen-' + gen, 'attempts.json'), list);
    if (!input.unfinished) write(path.join(dir, 'findings.json'), {review: REVIEW, round: input.n, findings: input.findings ?? [], failed: []});
  };
  return {session, put, write, cleanup};
}
const user = (seq: number, summary: string, extra: object = {}): LedgerRecord => ({seq, key: 'coverage:' + REVIEW + ':' + seq, at: 't', kind: 'escalation', by: 'user', quote: 'user words ' + seq,
  data: {id: 'coverage:' + REVIEW + ':' + seq, state: 'resolved', summary}, ...extra});
const fold = (...records: LedgerRecord[]): Fold => ({records, lastSeq: records.at(-1)?.seq ?? 0, torn: null});
const [A, B, C, D] = ['codex[0]', 'opencode[1]', 'claude[2]', 'agy[3]'];
const withTree = (run: (t: ReturnType<typeof tree>) => void) => {const t = tree(); try {run(t);} finally {t.cleanup();}};

// SECTION: Slot state

test('slot stays open until whole-target completion across later rounds', () => withTree(t => {
  t.put({n: 1, roster: [A, B, C], done: [B, C], failed: [A]});
  const first = coverageState(t.session, fold(), REVIEW);
  assert.deepEqual([first.targets, first.completed, first.open, first.decision, first.incomplete], [[A, B, C], [B, C], [A], 'rerun', null]);
  // A clean changed-path round does not forget the failure.
  t.put({n: 2, roster: [B], done: [B]});
  assert.deepEqual(coverageState(t.session, fold(), REVIEW).open, [A]);
  // A whole-target completion through a substitute closes the slot.
  t.put({n: 3, roster: [A], done: [A], substitute: [A], coverage: 'open'});
  const closed = coverageState(t.session, fold(), REVIEW);
  assert.deepEqual([closed.open, closed.completed, closed.coverageRounds, closed.decision], [[], [A, B, C], [3], 'none']);
  // A later failure reopens the closed slot.
  t.put({n: 4, roster: [A, B, C], done: [B, C], failed: [A], scope: 'Full review — changed paths: a.ts'});
  const reopened = coverageState(t.session, fold(), REVIEW);
  assert.deepEqual([reopened.open, reopened.completed, reopened.decision], [[A], [B, C], 'rerun']);
}));

test('slot stays open until whole-target completion when a round fails every slot', () => {
  withTree(t => {
    t.put({n: 1, roster: [A, B], failed: [A, B]});
    const state = coverageState(t.session, fold(), REVIEW);
    assert.deepEqual([state.open, state.completed, state.incomplete], [[A, B], [], null]);
  });
  // The old unfinalized all-failed round keeps its slots open and is not reported as a round in flight.
  withTree(t => {
    t.put({n: 1, roster: [A, B], failed: [A, B], unfinished: true});
    const state = coverageState(t.session, fold(), REVIEW);
    assert.deepEqual([state.open, state.incomplete], [[A, B], null]);
  });
});

test('slot stays open until whole-target completion after a failure in a superseded generation', () => withTree(t => {
  t.put({n: 1, roster: [A, B], done: [A, B]});
  t.put({n: 2, roster: [B], generation: 2, done: [B], attempts: {1: [{slot: A, seq: 4}]}});
  assert.deepEqual(coverageState(t.session, fold(), REVIEW).open, [A]);
  t.put({n: 3, roster: [A], done: [A], coverage: 'open'});
  assert.deepEqual(coverageState(t.session, fold(), REVIEW).open, []);
}));

test('slot stays open until whole-target completion; reruns decide whether delivery continues', () => {
  // The slot failed in the first whole-target round and again in the coverage round: a first failure and a rerun.
  withTree(t => {
    t.put({n: 1, roster: [A, B, C], done: [B, C], failed: [A]});
    assert.equal(coverageState(t.session, fold(), REVIEW).decision, 'rerun');
    t.put({n: 2, roster: [A], failed: [A], coverage: 'open'});
    const state = coverageState(t.session, fold(), REVIEW);
    assert.deepEqual([state.open, state.decision], [[A], 'majority']);
  });
  // Two of four completed is not more than half.
  withTree(t => {
    t.put({n: 1, roster: [A, B, C, D], done: [C, D], failed: [A, B]});
    t.put({n: 2, roster: [A, B], failed: [A, B], coverage: 'open'});
    assert.equal(coverageState(t.session, fold(), REVIEW).decision, 'user');
  });
  // A same-round retry is a rerun.
  withTree(t => {
    t.put({n: 1, roster: [A, B, C], done: [B, C], failed: [A], attempts: {1: [{slot: A, seq: 1}]}});
    assert.equal(coverageState(t.session, fold(), REVIEW).decision, 'majority');
  });
  // A changed-path failure is not a whole-target rerun.
  withTree(t => {
    t.put({n: 1, roster: [A, B, C], done: [B, C], failed: [A]});
    t.put({n: 2, roster: [A], failed: [A]});
    assert.equal(coverageState(t.session, fold(), REVIEW).decision, 'rerun');
  });
});

test('slot stays open until whole-target completion; a round in flight is incomplete', () => withTree(t => {
  t.put({n: 1, roster: [A, B], done: [B], failed: [A]});
  t.put({n: 2, roster: [A], coverage: 'open', coverageUse: 'free', unfinished: true});
  const state = coverageState(t.session, fold(), REVIEW);
  assert.deepEqual([state.incomplete, state.freeUsed, state.coverageRounds], [2, false, [2]]);
  t.put({n: 2, roster: [A], done: [A], coverage: 'open', coverageUse: 'free'});
  t.put({n: 3, roster: [A, B], scope: 'Full review', done: [A], unfinished: true, native: [B]});
  const next = coverageState(t.session, fold(), REVIEW);
  assert.deepEqual([next.incomplete, next.freeUsed, next.decision], [3, true, 'rerun']);
  // Rounds that do not apply to the bound integration are ignored.
  fs.rmSync(path.join(t.session, '.state/reviews', REVIEW, 'round-3'), {recursive: true});
  t.put({n: 3, roster: [C], failed: [C], base: 'other'});
  const scoped = coverageState(t.session, fold(), REVIEW, metadata => (metadata.target as {base: string}).base === 'base');
  assert.deepEqual([scoped.targets, scoped.open, scoped.incomplete], [[A, B], [], null]);
}));

test('coverage state fails closed on unreadable round files', () => {
  const unreadable = (damage: (root: string) => void) => withTree(t => {
    t.put({n: 1, roster: [A, B], done: [B], failed: [A]});
    damage(path.join(t.session, '.state/reviews', REVIEW, 'round-1'));
    assert.throws(() => coverageState(t.session, fold(), REVIEW), {exit: 4, reason: 'coverage-required'});
  });
  unreadable(root => fs.rmSync(path.join(root, 'gen-1/attempts.json')));
  unreadable(root => fs.writeFileSync(path.join(root, 'gen-1/attempts.json'), '{'));
  unreadable(root => fs.writeFileSync(path.join(root, 'gen-1/attempts.json'), JSON.stringify([{slot: A}])));
  unreadable(root => fs.writeFileSync(path.join(root, 'round.json'), '{'));
  // A round directory without a round file was never started.
  withTree(t => {
    fs.mkdirSync(path.join(t.session, '.state/reviews', REVIEW, 'round-1/gen-1'), {recursive: true});
    assert.deepEqual(coverageState(t.session, fold(), REVIEW).targets, []);
  });
});

// SECTION: Overrides

test('coverage override covers only named slots and failures recorded before it', () => withTree(t => {
  t.put({n: 1, roster: [A, B, C], done: [C], failed: [A, B]});
  const covered = coverageState(t.session, fold(user(5, `accept: ${A}`)), REVIEW);
  assert.deepEqual([covered.open, covered.overridden], [[B], [{slot: A, quote: 'user words 5', seq: 5}]]);
  // A slot that is not a target covers nothing; a later failure, including an equal seq, stays open.
  assert.deepEqual(coverageState(t.session, fold(user(5, `accept: ${A}, ${B}, agy[3]`)), REVIEW).open, []);
  assert.deepEqual(coverageState(t.session, fold(user(5, 'accept: agy[3]')), REVIEW).open, [A, B]);
  t.put({n: 2, roster: [A], failed: [A], coverage: 'open', attempts: {1: [{slot: A, seq: 5}]}});
  assert.deepEqual(coverageState(t.session, fold(user(5, `accept: ${A}`)), REVIEW).open, [A, B]);
  t.put({n: 2, roster: [A], failed: [A], coverage: 'open', attempts: {1: [{slot: A, seq: 9}]}});
  assert.deepEqual(coverageState(t.session, fold(user(5, `accept: ${A}`)), REVIEW).open, [A, B]);
  assert.deepEqual(coverageState(t.session, fold(user(5, `accept: ${A}`), user(10, `accept: ${A}`)), REVIEW).overridden.map(row => row.seq), [10]);
}));

test('coverage override ignores records that are not a quoted user decision', () => withTree(t => {
  t.put({n: 1, roster: [A, B], done: [B], failed: [A]});
  const open = (record: LedgerRecord) => coverageState(t.session, fold(record), REVIEW).open;
  assert.deepEqual(open(user(5, `accept: ${A}`)), []);
  assert.deepEqual(open(user(5, `accept: ${A}`, {by: 'orchestrator'})), [A]);
  assert.deepEqual(open(user(5, `accept: ${A}`, {quote: ' '})), [A]);
  assert.deepEqual(open(user(5, `accept: ${A}`, {data: {id: 'coverage:' + REVIEW + ':5', state: 'open', summary: `accept: ${A}`}})), [A]);
  assert.deepEqual(open(user(5, `grant: provider restored`)), [A]);
  assert.deepEqual(open(user(5, `accept: ${A}`, {data: {id: 'ceiling:' + REVIEW + ':5', state: 'resolved', summary: `accept: ${A}`}})), [A]);
}));

// SECTION: Admission

const budgetOf = (t: ReturnType<typeof tree>, ...records: LedgerRecord[]) => admission(t.session, fold(...records), REVIEW, 0).budget;

test('coverage admission allows a rerun within the cap without using the coverage round', () => {
  withTree(t => {
    t.put({n: 1, roster: [A, B], done: [B], failed: [A], cap: 3});
    const budget = budgetOf(t);
    assert.equal(budget.state, 'allowed');
    assert.deepEqual(budget.coverage, {state: 'readable', open: [A], decision: 'rerun'});
    assert.match(renderBudget(budget), /coverage rerun, open: codex\[0\]/);
  });
  // No open slot and no round in flight: the budget carries no coverage key.
  withTree(t => {
    t.put({n: 1, roster: [A, B], done: [A, B], cap: 3});
    assert.equal('coverage' in budgetOf(t), false);
  });
});

test('coverage admission stops at a user decision within the cap', () => withTree(t => {
  t.put({n: 1, roster: [A, B, C, D], done: [C, D], failed: [A, B], cap: 3});
  t.put({n: 2, roster: [A, B], failed: [A, B], coverage: 'open', cap: 3});
  const stopped = budgetOf(t);
  assert.deepEqual([stopped.nextRound, stopped.state, stopped.coverage], [3, 'requires-coverage-decision', {state: 'readable', open: [A, B], decision: 'user'}]);
}));

test('coverage admission admits one past-cap round and refuses a second', () => withTree(t => {
  t.put({n: 1, roster: [A, B, C], done: [B, C], failed: [A], cap: 1});
  const free = budgetOf(t);
  assert.deepEqual([free.nextRound, free.state, free.coverage], [2, 'allowed', {state: 'readable', open: [A], decision: 'rerun', use: 'free'}]);
  // The free round ran and the slot failed again with a majority completed: the cap applies again.
  t.put({n: 2, roster: [A], failed: [A], coverage: 'open', coverageUse: 'free', cap: 1});
  const second = budgetOf(t);
  assert.deepEqual([second.nextRound, second.state, second.coverage], [3, 'requires-continuation', {state: 'readable', open: [A], decision: 'majority'}]);
}));

test('coverage admission requires a decision for a rerun after the coverage round was used', () => withTree(t => {
  t.put({n: 1, roster: [A, B, C], done: [B, C], failed: [A], cap: 1});
  t.put({n: 2, roster: [A], done: [A], coverage: 'open', coverageUse: 'free', cap: 1});
  // A different slot fails for the first time in a later full-roster round; a granted ceiling keeps the round in range.
  t.put({n: 3, roster: [A, B, C], done: [A, C], failed: [B], coverage: 'full', cap: 1});
  const ceiling = [
    {seq: 1, key: 'open', at: 't', kind: 'escalation', by: 'tool', data: {id: 'ceiling:' + REVIEW + ':3', state: 'open', summary: 'ceiling 3 reached'}},
    {seq: 2, key: 'grant', at: 't', kind: 'escalation', by: 'user', quote: 'go', data: {id: 'ceiling:' + REVIEW + ':3', state: 'resolved', summary: 're-author: split'}},
  ] satisfies LedgerRecord[];
  const budget = admission(t.session, fold(...ceiling), REVIEW, 0).budget;
  assert.deepEqual([budget.nextRound, budget.ceiling, budget.state, budget.coverage], [4, 5, 'requires-coverage-decision', {state: 'readable', open: [B], decision: 'rerun'}]);
}));

test('coverage admission consumes one grant per granted round and stays within the ceiling', () => {
  // Cap 2, ceiling 4: each granted round consumes one grant record.
  withTree(t => {
    t.put({n: 1, roster: [A, B, C, D], done: [C, D], failed: [A, B], cap: 2});
    t.put({n: 2, roster: [A, B], failed: [A, B], coverage: 'open', cap: 2});
    const use = (...records: LedgerRecord[]) => {const budget = budgetOf(t, ...records); return [budget.nextRound, budget.state, budget.coverage?.state === 'readable' ? budget.coverage.use : undefined];};
    assert.deepEqual(use(), [3, 'requires-coverage-decision', undefined]);
    assert.deepEqual(use(user(5, 'grant: restored')), [3, 'allowed', 'grant']);
    t.put({n: 3, roster: [A, B], failed: [A, B], coverage: 'open', coverageUse: 'grant', cap: 2});
    assert.deepEqual(use(user(5, 'grant: restored')), [4, 'requires-coverage-decision', undefined]);
    assert.deepEqual(use(user(5, 'grant: restored'), user(6, 'grant: again')), [4, 'allowed', 'grant']);
    t.put({n: 4, roster: [A, B], failed: [A, B], coverage: 'open', coverageUse: 'grant', cap: 2});
    assert.deepEqual(use(user(5, 'grant: restored'), user(6, 'grant: again'), user(7, 'grant: third')), [5, 'requires-coverage-decision', undefined]);
  });
  // A grant recorded before the free round stays usable afterwards.
  withTree(t => {
    const early = user(1, 'grant: restored');
    t.put({n: 1, roster: [A, B, C, D], done: [C, D], failed: [A, B], cap: 1});
    const free = budgetOf(t, early);
    assert.deepEqual([free.state, free.coverage?.state === 'readable' && free.coverage.use], ['allowed', 'free']);
    t.put({n: 2, roster: [A, B], failed: [A, B], coverage: 'open', coverageUse: 'free', cap: 1});
    const grant = budgetOf(t, early);
    assert.deepEqual([grant.nextRound, grant.state, grant.coverage?.state === 'readable' && grant.coverage.use], [3, 'allowed', 'grant']);
    t.put({n: 3, roster: [A, B], failed: [A, B], coverage: 'open', coverageUse: 'grant', cap: 1});
    assert.deepEqual([budgetOf(t, early).nextRound, budgetOf(t, early).ceiling, budgetOf(t, early).state], [4, 3, 'requires-coverage-decision']);
  });
});

test('coverage admission gives an accepted MUST its normal continuation', () => withTree(t => {
  t.put({n: 1, roster: [A, B, C, D], done: [C, D], failed: [A, B], cap: 1});
  t.put({n: 2, roster: [A, B], failed: [A, B], coverage: 'open', coverageUse: 'free', cap: 1, findings: [{id: 'R2-F001', severity: 'MUST', sources: []}]});
  const ruling: LedgerRecord = {seq: 2, key: 'ruling', at: 't', kind: 'ruling', by: 'orchestrator', data: {subject: 'review:' + REVIEW + ':R2-F001', ruling: 'accepted', rationale: 'fix'}};
  assert.equal(budgetOf(t).state, 'requires-coverage-decision');
  const accepted = budgetOf(t, ruling);
  assert.deepEqual([accepted.state, accepted.coverage], ['allowed', {state: 'readable', open: [A, B], decision: 'user'}]);
}));

test('coverage admission resumes a started round under its saved use when the decision becomes user', () => withTree(t => {
  t.put({n: 1, roster: [A, B, C, D], done: [D], failed: [A, B, C], cap: 1});
  t.put({n: 2, roster: [A, B, C], failed: [A, B], native: [C], coverage: 'open', coverageUse: 'free', cap: 1, unfinished: true});
  const before = budgetOf(t);
  assert.deepEqual([before.nextRound, before.state, before.coverage], [2, 'allowed', {state: 'readable', open: [A, B, C], decision: 'rerun', use: 'free'}]);
  const resumed = budgetOf(t, user(20, `accept: ${C}`));
  assert.deepEqual([resumed.state, resumed.coverage], ['allowed', {state: 'readable', open: [A, B], decision: 'rerun', use: 'free'}]);
}));

test('coverage admission reports unreadable state without throwing', () => withTree(t => {
  t.put({n: 1, roster: [A, B], done: [B], failed: [A], cap: 1});
  fs.rmSync(path.join(t.session, '.state/reviews', REVIEW, 'round-1/gen-1/attempts.json'));
  const budget = budgetOf(t);
  assert.deepEqual([budget.state, budget.coverage], ['requires-continuation', {state: 'unreadable'}]);
  assert.match(renderBudget(budget), /coverage unreadable/);
}));

test('coverage admission leaves plan and design budgets unchanged', () => withTree(t => {
  for (const review of ['plan-work.plan', 'design-work.design']) {
    const dir = path.join(t.session, '.state/reviews', review, 'round-1');
    t.write(path.join(dir, 'round.json'), {round: 1, cap: 1, startSeq: 0});
    t.write(path.join(dir, 'gen-1/attempts.json'), [{slot: A, seq: 1, wholeTarget: true, outcome: 'timeout'}]);
    t.write(path.join(dir, 'gen-1/slots', A + '.json'), {slot: A, state: 'failed', cls: 'timeout', reason: 'slow'});
    t.write(path.join(dir, 'findings.json'), {review, round: 1, cap: 1, findings: []});
    assert.deepEqual(admission(t.session, fold(), review, 0).budget, {cap: 1, ceiling: 3, nextRound: 2, asOfSeq: 0, state: 'requires-continuation'});
  }
}));

test('coverage decision stays rerun while a round is in flight, even with a majority', () => withTree(t => {
  t.put({n: 1, roster: [A, B, C, D], done: [B, C, D], failed: [A]});
  t.put({n: 2, roster: [A], failed: [A], coverage: 'open'});
  assert.equal(coverageState(t.session, fold(), REVIEW).decision, 'majority');
  t.put({n: 3, roster: [A], native: [A], coverage: 'open', unfinished: true});
  assert.equal(coverageState(t.session, fold(), REVIEW).decision, 'rerun');
}));

test('coverage admission requires a decision for a first failure in the ceiling round', () => withTree(t => {
  t.put({n: 1, roster: [A, B], done: [A, B], cap: 1});
  t.put({n: 2, roster: [A], done: [A], cap: 1});
  t.put({n: 3, roster: [A, B], done: [A], failed: [B], cap: 1});
  const budget = budgetOf(t);
  assert.deepEqual([budget.nextRound, budget.ceiling, budget.state, budget.coverage], [4, 3, 'requires-coverage-decision', {state: 'readable', open: [B], decision: 'rerun'}]);
}));
