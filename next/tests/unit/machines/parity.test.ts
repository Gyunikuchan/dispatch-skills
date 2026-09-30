import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EFFECT_ID_PATTERN } from '../../../skills/dispatch/scripts/core/effect-id.ts';
import type { Effect, Event, Machine, RunStartedEvent, Verb } from '../../../skills/dispatch/scripts/core/types.ts';
import { askMachine } from '../../../skills/dispatch/scripts/machines/ask.ts';
import { planMachine } from '../../../skills/dispatch/scripts/machines/plan.ts';
import { reviewMachine } from '../../../skills/dispatch/scripts/machines/review.ts';
import { rootMachine } from '../../../skills/dispatch/scripts/machines/root.ts';

// SECTION: Scenario vocabulary (each step answers the newest open effect)

type Step = Event | ((effect: Effect | undefined, state: unknown) => Event);
type Tagged = { tag: string };

const phases = (rounds: number) => ({ rounds: { low: rounds }, targets: { low: 1 } });
const run = (verb: Verb, over: Partial<RunStartedEvent> = {}, rounds = 2): RunStartedEvent => ({
  type: 'RUN_STARTED', verb, argument: '', level: 'low', levelSource: 'explicit', pins: null, fix: true, orchestrator: 'claude', orchestratorModel: null,
  overrides: {}, repo: {}, config: { 'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } }, phases: { 'code-review': phases(rounds), 'plan-review': phases(rounds) } }, ...over,
});
const badPins: Partial<RunStartedEvent> = { pins: { kind: 'providers', keys: ['nope'] } };
const id = (effect: Effect | undefined) => effect?.id ?? 'none';
const f = (n: number, over: Record<string, unknown> = {}) => ({ id: `R${n}-F001`, severity: 'MUST', category: 'correctness', locus: 'src/a.ts:L3', defect: 'null deref in parser', requiredChange: 'guard the value', sources: ['codex[0]'], scope: 'in', ...over });

const prepared: Step = (effect) => ({ type: 'REVIEW_PREPARED', effectId: id(effect), scope: {}, promptPaths: { 'codex[0]': 'p0' } });
const empty: Step = (effect) => ({ type: 'REVIEW_PREPARED', effectId: id(effect), scope: { empty: true }, promptPaths: {} });
const wave = (findings: unknown[], slots: unknown[] = [{ slot: 'codex[0]', state: 'success', claim: 'c' }]): Step => (effect) =>
  ({ type: 'WAVE_DONE', effectId: id(effect), round: effect?.kind === 'wave' ? effect.round : 1, slots: slots as never, findings: findings as never });
const nativeWave = wave([], [{ slot: 'codex[0]', state: 'native', descriptor: { sourceKey: 'codex[0]#fallback', substitutesFor: 'codex[0]', outputPath: 'o' } }]);
const natives: Step = { type: 'NATIVE_RESULTS', slots: [{ slot: 'codex[0]', sourceKey: 'codex[0]#fallback', outputPath: 'o' }] };
const failed: Step = (effect) => ({ type: 'EFFECT_FAILED', effectId: id(effect), cls: 'io', detail: 'x' });
const rule = (ruling: string, n = 1): Step => ({ type: 'RULINGS', rulings: { [`R${n}-F001`]: { ruling } } });
const applied: Step = (_effect, state) => {
  const found = JSON.stringify(state).match(/"clusterId":"([^"]+)"/);
  return { type: 'FIXES_APPLIED', clusters: [{ clusterId: found?.[1] ?? '' }] };
};
const verified = (exit = 0): Step => (effect) => ({ type: 'VERIFY_DONE', effectId: id(effect), purpose: 'fix-verify', results: [{ command: 'c', exit, logPath: 'l' }], fingerprint: {} });
const parsed = (defects: unknown[] = []): Step => (effect) => ({ type: 'ARTIFACT_PARSED', effectId: id(effect), kind: 'plan', hash: 'h', parsed: {}, defects: defects as never });
const decide = (kind: 'escalation' | 'needs-user' | 'opt-in', answer: unknown): Step => ({ type: 'DECISION', kind, answer });
const handed: Step = (effect) => ({ type: 'HANDOFF_DONE', effectId: id(effect), destination: '/t', warning: null });
const authored: Step = { type: 'AUTHORED', path: 'x.plan.md' };
const plan = { argument: 'x.plan.md', overrides: { kind: 'plan' } };
const regression = [prepared, wave([f(1)]), rule('accept'), applied, verified(), prepared, wave([f(2)])];

// SECTION: Replay

type Journal = { triples: Set<string>; ids: string[] };

function replay<S>(machine: Machine<S>, steps: readonly Step[]): Journal {
  let state = machine.initial();
  const open: Effect[] = [];
  const triples = new Set<string>();
  const ids: string[] = [];
  for (const step of steps) {
    const event = typeof step === 'function' ? step(open.at(-1), state) : step;
    const result = machine.step(state, event);
    const from = (state as Tagged).tag;
    const to = (result.state as Tagged).tag;
    if (from !== to) triples.add(`${from} --${event.type}--> ${to}`);
    state = result.state;
    open.push(...result.effects);
    ids.push(...result.effects.map((effect) => effect.id));
  }
  return { triples, ids };
}

function parity<S>(machine: Machine<S>, scenarios: readonly (readonly Step[])[]): void {
  const observed = new Set<string>();
  for (const scenario of scenarios) for (const triple of replay(machine, scenario).triples) observed.add(triple);
  const table = new Set(machine.transitions.map((row) => `${row.from} --${row.on}--> ${row.to}`));
  assert.deepEqual([...observed].filter((triple) => !table.has(triple)), [], 'observed tag changes missing from the table');
  assert.deepEqual([...table].filter((triple) => !observed.has(triple)), [], 'table rows no fixture drives');
}

// SECTION: Tests

test('review transitions table matches step', () => {
  parity(reviewMachine, [
    [run('review', {}, 0)], [run('review', badPins)], [run('review'), failed], [run('review'), empty],
    [run('review'), prepared, failed], [run('review'), prepared, nativeWave, natives, wave([f(1)])],
    [run('review'), prepared, wave([])], [run('review'), ...regression, decide('escalation', 'stop')],
    [run('review'), prepared, wave([f(1)]), rule('reject'), prepared, wave([])],
    [run('review', { fix: false }), prepared, wave([f(1)]), rule('accept')],
    [run('review', { fix: false }), prepared, wave([f(1)]), rule('needs-user'), decide('needs-user', { 'R1-F001': 'no' })],
    [run('review'), prepared, wave([f(1, { category: 'intent' }), f(1, { id: 'R1-F002', locus: 'b' })]),
      { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'needs-user' }, 'R1-F002': { ruling: 'accept' } } },
      decide('needs-user', { 'R1-F001': 'keep' }), applied, verified(1), applied, failed],
    [run('review'), prepared, wave([f(1, { scope: 'adjacent' })]), rule('accept'), decide('opt-in', ['R1-F001']), applied, verified()],
    [run('review'), prepared, wave([f(1, { scope: 'adjacent' })]), rule('accept'), decide('opt-in', [])],
    [run('review'), prepared, wave([f(1), f(1, { id: 'R1-F002', scope: 'adjacent', locus: 'b' })]),
      { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' }, 'R1-F002': { ruling: 'accept' } } }, applied, verified(), prepared, wave([])],
    [run('review', {}, 1), prepared, wave([f(1, { severity: 'SHOULD' })]), rule('accept'), applied, verified()],
    [run('review', { ...plan }), prepared, wave([f(1)]), rule('accept'), applied, parsed([{ message: 'm' }]), applied, parsed()],
    [run('review', { ...plan }, 1), prepared, wave([f(1, { severity: 'SHOULD' })]), rule('accept'), applied, parsed()],
    [run('review', {}, 1), prepared, wave([f(1, { severity: 'SHOULD' }), f(1, { id: 'R1-F002', scope: 'adjacent', locus: 'b' })]),
      { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' }, 'R1-F002': { ruling: 'accept' } } }, applied, verified()],
    [run('review', { ...plan }, 1), prepared, wave([f(1, { severity: 'SHOULD' }), f(1, { id: 'R1-F002', scope: 'adjacent', locus: 'b' })]),
      { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' }, 'R1-F002': { ruling: 'accept' } } }, applied, parsed()],
    [run('review'), prepared, wave([f(1), f(1, { id: 'R1-F002', locus: 'b' })]),
      { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'needs-user' }, 'R1-F002': { ruling: 'reject' } } }, decide('needs-user', { 'R1-F001': 'no' })],
    [run('review', {}, 1), prepared, wave([f(1, { severity: 'CONSIDER' })]), rule('needs-user'), decide('needs-user', { 'R1-F001': 'later' })],
  ]);
});

test('ask transitions table matches step', () => {
  parity(askMachine, [
    [run('ask', badPins)], [run('ask'), failed], [run('ask'), prepared, failed],
    [run('ask'), prepared, wave([])], [run('ask'), prepared, nativeWave, natives, wave([])],
  ]);
});

test('plan transitions table matches step', () => {
  parity(planMachine, [
    [run('plan', badPins)], [run('plan'), authored, failed], [run('plan'), authored, parsed([{ message: 'm' }])],
    [run('plan', {}, 0), authored, parsed()], [run('plan'), authored, parsed(), prepared, wave([])],
    [run('plan'), authored, parsed(), prepared, failed],
    [run('plan'), authored, parsed(), prepared, wave([f(1, { severity: 'CONSIDER' })]), rule('reject')],
    [run('plan', {}, 1), authored, parsed(), prepared, wave([f(1, { severity: 'SHOULD' })]), rule('accept'), applied, parsed()],
    [run('plan', {}, 1), authored, parsed(), prepared, wave([f(1, { scope: 'adjacent' })]), rule('accept'), decide('opt-in', [])],
    [run('plan'), authored, parsed(), ...regression.slice(0, 3), applied, parsed(), prepared, wave([f(2)]), decide('escalation', 'stop')],
  ]);
});

test('root transitions table matches step', () => {
  parity(rootMachine, [
    [run('ask'), prepared, wave([]), handed], [run('ask'), failed, failed],
    [run('implement'), handed], [run('design'), failed],
    [run('plan', {}, 0), authored, parsed()], [run('plan'), authored, failed], [run('plan'), authored, parsed(), prepared, wave([])],
    [run('plan'), authored, parsed(), prepared, wave([f(1, { severity: 'CONSIDER' })]), rule('reject')],
    [run('plan'), authored, parsed(), ...regression.slice(0, 3), applied, parsed(), prepared, wave([f(2)]), decide('escalation', 'stop')],
    [run('review'), empty], [run('review'), prepared, wave([])], [run('review'), prepared, failed],
    [run('review', { fix: false }), prepared, wave([f(1)]), rule('accept')],
    [run('review'), ...regression, decide('escalation', 'stop')],
    [run('review', {}, 1), prepared, wave([f(1, { severity: 'SHOULD' })]), rule('accept'), applied, verified()],
    [run('review', { ...plan }, 1), prepared, wave([f(1, { severity: 'SHOULD' })]), rule('accept'), applied, parsed()],
  ]);
});

test('effect ids match EFFECT_ID_PATTERN and are unique across a journal with a second review round', () => {
  const journal = replay(rootMachine, [run('plan'), authored, parsed(), ...regression.slice(0, 3), applied, parsed(), prepared, wave([]), handed]);
  assert.ok(journal.ids.includes('plan.review.prepare-review.2'), journal.ids.join(', '));
  for (const effectId of journal.ids) assert.match(effectId, EFFECT_ID_PATTERN);
  assert.equal(new Set(journal.ids).size, journal.ids.length);
  assert.equal(journal.ids.at(-1), 'root.handoff.1');
});
