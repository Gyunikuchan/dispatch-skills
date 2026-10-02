import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EFFECT_ID_PATTERN } from '../../../skills/dispatch/scripts/core/effect-id.ts';
import type { Effect, Event, Machine, RunStartedEvent, Verb } from '../../../skills/dispatch/scripts/core/types.ts';
import { askMachine } from '../../../skills/dispatch/scripts/machines/ask.ts';
import { planMachine } from '../../../skills/dispatch/scripts/machines/plan.ts';
import { reviewMachine } from '../../../skills/dispatch/scripts/machines/review.ts';
import { implementMachine } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { rootMachine } from '../../../skills/dispatch/scripts/machines/root.ts';
import { beginRevision } from '../../../skills/dispatch/scripts/machines/revision.ts';
import { started } from './design-delivery.test.ts';
import { integration } from './design-integration.test.ts';
import { hash as designHash, design, run as designRun, approval as designApproval } from './design.test.ts';
import { beginDesign, stepDesign, transitions as designTransitions, type DesignState } from '../../../skills/dispatch/scripts/machines/design.ts';
import { beginDesignRevision, stepDesignRevision, transitions as designRevisionTransitions, type DesignRevisionState } from '../../../skills/dispatch/scripts/machines/design-revision.ts';
import { beginReview, type ReviewState } from '../../../skills/dispatch/scripts/machines/review.ts';

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

const IMPLEMENT_HASH = `sha256:${'a'.repeat(64)}`;
const implementPlan = (withEvidence = false) => ({
  title: 'Example', box: { 'TL;DR': 'Deliver example' }, keyDecisions: [],
  criteria: withEvidence ? [{ id: 'SC1', title: 'Works', line: 1, changes: ['src/a.ts'], verify: [], evidence: 'review' as const, preExisting: false, redException: null, testRationale: null, review: null, enforcementInfeasibility: null }] : [],
  changes: withEvidence ? [{ action: 'MODIFY' as const, path: 'src/a.ts', note: 'Add behavior', command: null, line: 1 }] : [],
  verification: { automated: [], none: null, manual: [] }, tasks: [], finalCommands: [], traceability: null, governedText: '# Example',
});
const implementRun = (withEvidence = false): RunStartedEvent => run('implement', {
  argument: 'x.plan.md', overrides: { path: 'x.plan.md', sessionDir: '/session', settledPlan: { path: 'x.plan.md', hash: IMPLEMENT_HASH, outcome: 'settled' } },
  config: { 'write-subagents': { claude: { low: { model: 'writer' } } }, 'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } }, phases: { 'plan-review': { rounds: { low: 1 }, targets: { low: 1 } }, 'code-review': { rounds: { low: 0 }, targets: { low: 1 } } } },
});
const implementSnapshot: Step = (effect) => ({ type: 'SNAPSHOT', effectId: id(effect), fingerprint: { head: 'h', index: 'i', worktree: 'w' }, diff: { paths: [] } });
const implementParsed = (withEvidence = false): Step => (effect) => ({ type: 'ARTIFACT_PARSED', effectId: id(effect), kind: 'plan', hash: IMPLEMENT_HASH, parsed: implementPlan(withEvidence), defects: [] });
const implementBadParsed: Step = (effect) => ({ type: 'ARTIFACT_PARSED', effectId: id(effect), kind: 'plan', hash: IMPLEMENT_HASH, parsed: {}, defects: [] });
const implementVerified: Step = (effect) => ({ type: 'VERIFY_DONE', effectId: id(effect), purpose: effect?.kind === 'verify' ? effect.purpose : 'baseline', results: [], fingerprint: { head: 'h', index: 'i', worktree: 'w' } });
const implementBrief: Step = (effect) => ({ type: 'BRIEF_READY', effectId: id(effect), stage: 'production', path: 'run/brief.md', sha256: IMPLEMENT_HASH, envelopePath: 'run/outcome.json' });
const implementEnvelope: Step = { type: 'WRITE_ENVELOPE', envelopePath: 'run/outcome.json' };
const implementChecked = (withEvidence = false): Step => (effect) => ({ type: 'ENVELOPE_CHECKED', effectId: id(effect), envelope: { schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'Implemented', evidence: withEvidence ? ['CRITERION SC1 | src/a.ts | delivered behavior'] : [] }, defects: [], diff: { paths: [] } });
const implementApprovalStop: Step = { type: 'DECISION', kind: 'approval', answer: 'stop' };
const implementApproval: Step = { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } };
const implementEvidence: Step = { type: 'EVIDENCE', criteria: { SC1: { outcome: 'pass', evidence: 'reviewed behavior' } } };
const implementHandoff: Step = (effect) => ({ type: 'HANDOFF_DONE', effectId: id(effect), destination: '/t', warning: null });

function implementsToTerminal(withEvidence: boolean): Step[] {
  return [implementRun(withEvidence), implementSnapshot, implementParsed(withEvidence), implementSnapshot, implementVerified, implementSnapshot, implementApproval,
    implementBrief, implementSnapshot, implementEnvelope, implementChecked(withEvidence), implementSnapshot, implementSnapshot,
    implementVerified, ...(withEvidence ? [implementEvidence] : [])];
}

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
    const pending = state as unknown as { tag: string; child?: { tag: string }; c?: { lastFingerprint?: Record<string, unknown> } };
    if (pending.tag === 'checking-host-event' || pending.child?.tag === 'checking-host-event') {
      const snapshot = result.effects.find((effect) => effect.kind === 'snapshot');
      assert.ok(snapshot);
      const resumed = machine.step(state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: { head: 'h', index: 'i', worktree: 'w' }, diff: { paths: [] } });
      const nextTag = (resumed.state as Tagged).tag;
      if (pending.tag !== nextTag) triples.add(`${pending.tag} --SNAPSHOT--> ${nextTag}`);
      state = resumed.state; open.push(...resumed.effects); ids.push(...resumed.effects.map((effect) => effect.id));
    }
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
    [run('ask', badPins)],
    [implementRun(), implementSnapshot, implementParsed(), implementSnapshot, implementVerified, implementSnapshot,
      { type: 'REVISE', artifact: 'plan', reason: 'blocked-by-plan', evidence: 'check report' }, { type: 'AUTHORED', path: '/session/revision-1.plan.md' }, implementParsed()],
    [run('ask'), prepared, wave([]), handed], [run('ask'), failed, failed],
    [run('implement'), failed], [run('implement', { argument: 'x.plan.md', overrides: { path: 'x.plan.md', settledPlan: { path: 'x.plan.md', hash: IMPLEMENT_HASH, outcome: 'settled' } }, config: implementRun().config }), implementSnapshot, implementBadParsed, implementSnapshot, { type: 'DECISION', kind: 'failure', answer: 'stop' }],
    [implementRun(), implementSnapshot, implementParsed(), implementSnapshot, implementVerified, implementSnapshot, implementApprovalStop],
    implementsToTerminal(false), implementsToTerminal(true), [run('design'), { type: 'AUTHORED', path: 'dispatch.design.md' }, failed],
    [designRun(), { type: 'AUTHORED', path: 'x.design.md' }, (effect) => ({ type: 'ARTIFACT_PARSED', effectId: id(effect), kind: 'design', hash: designHash, parsed: design, defects: [] }), (effect) => ({ type: 'ARTIFACT_PARSED', effectId: id(effect), kind: 'design', hash: designHash, parsed: design, defects: [] }), { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Approved', hash: designHash } }],
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

test('implementation transition declarations include every observed reducer boundary', () => {
  const scenarios: readonly (readonly Step[])[] = [
    [implementRun(), implementSnapshot, implementBadParsed, implementSnapshot],
    [implementRun(), implementSnapshot, implementParsed(), implementSnapshot, implementVerified, implementSnapshot, implementApprovalStop],
  ];
  const observed = new Set(scenarios.flatMap((scenario) => [...replay(implementMachine, scenario).triples]));
  const declared = new Set(implementMachine.transitions.map((row) => `${row.from} --${row.on}--> ${row.to}`));
  assert.deepEqual([...observed].filter((triple) => !declared.has(triple)), []);
  assert.ok(declared.has('booting --RUN_STARTED--> starting'));
  assert.ok(declared.has('parsing --ARTIFACT_PARSED--> baseline-preflight'));
  assert.ok(declared.has('approval --DECISION--> stopped'));
  assert.ok(declared.has('approval --DECISION--> checking-host-event'));
  assert.ok(declared.has('cascade-snapshot --SNAPSHOT--> restoring'));
  assert.ok(declared.has('restoring --RESTORED--> write'));
});

test('effect ids match EFFECT_ID_PATTERN and are unique across a journal with a second review round', () => {
  const journal = replay(rootMachine, [run('plan'), authored, parsed(), ...regression.slice(0, 3), applied, parsed(), prepared, wave([]), handed]);
  assert.ok(journal.ids.includes('plan.review.prepare-review.2'), journal.ids.join(', '));
  for (const effectId of journal.ids) assert.match(effectId, EFFECT_ID_PATTERN);
  assert.equal(new Set(journal.ids).size, journal.ids.length);
  assert.equal(journal.ids.at(-1), 'root.handoff.1');
});
test('every design and design revision transition row has a reducer fixture', () => {
  const authored = beginDesign(designRun()).state;
  const parsing = stepDesign(authored, { type: 'AUTHORED', path: 'x.design.md' }).state;
  if (parsing.tag !== 'parse') throw new Error('parse');
  const good: Event = { type: 'ARTIFACT_PARSED', effectId: parsing.effectId, kind: 'design', hash: designHash, parsed: design, defects: [] };
  const failure: Event = { type: 'EFFECT_FAILED', effectId: parsing.effectId, cls: 'io', detail: 'Read failed' };
  const reviewRun = { ...designRun(), config: { ...designRun().config, phases: { 'plan-review': { rounds: { low: 1 }, targets: { low: 1 } } } } };
  const approve: Event = { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Approved', hash: designHash } };
  const baseline = stepDesign(designApproval('implement'), approve).state;
  if (baseline.tag !== 'baseline') throw new Error('baseline');
  const pairs: readonly [DesignState, Event][] = [
    [authored, { type: 'AUTHORED', path: 'x.design.md' }],
    [parsing, { ...good, defects: [{ message: 'Lint' }] }], [parsing, failure],
    [{ ...parsing, c: { ...parsing.c, run: reviewRun } }, good], [{ ...parsing, afterReview: true }, good],
    [designApproval(), approve], [designApproval('implement'), approve], [designApproval(), { type: 'DECISION', kind: 'approval', answer: 'stop' }],
    [baseline, { type: 'SNAPSHOT', effectId: baseline.effectId, fingerprint: { head: 'a'.repeat(40) }, diff: {} }],
    [baseline, { type: 'SNAPSHOT', effectId: baseline.effectId, fingerprint: { head: null }, diff: {} }],
    [baseline, { type: 'EFFECT_FAILED', effectId: baseline.effectId, cls: 'io', detail: 'Read failed' }],
  ];
  const observed = pairs.map(([state, event]) => `${state.tag} --${event.type}--> ${stepDesign(state, event).state.tag}`);
  const c = { ...designApproval().c, run: reviewRun };
  const author = beginDesignRevision(c, { type: 'REVISE', artifact: 'design', reason: 'repair', evidence: 'finding' }).state;
  const parse = stepDesignRevision(author, { type: 'AUTHORED', path: author.workingPath }).state;
  if (parse.tag !== 'parse') throw new Error('revision parse');
  const revisionParsed: Event = { type: 'ARTIFACT_PARSED', kind: 'design', effectId: parse.effectId, hash: `sha256:${'b'.repeat(64)}`, parsed: { ...design, details: { ...design.details, I02: { Outcome: 'Changed' } } }, defects: [] };
  const begun = beginReview({ kind: 'design', mode: 'fix', target: author.workingPath, cap: 1, breadth: 1, context: '', roster: [], timeoutMs: 1000 }, 'design.revision.review', c.counters).state;
  if (!('c' in begun)) throw new Error('review context');
  const rc = { ...begun.c, effectId: 'review-result', round: 1, optInAsked: true };
  const review = (state: ReviewState): DesignRevisionState => ({ tag: 'review', c, workingPath: author.workingPath, reason: 'repair', evidence: 'finding', review: state });
  const revisions: readonly [DesignRevisionState, Event][] = [
    [author, { type: 'AUTHORED', path: author.workingPath }], [parse, revisionParsed],
    [parse, { ...revisionParsed, defects: [{ message: 'Lint' }] }],
    [parse, { ...revisionParsed, parsed: { ...design, box: { 'TL;DR': 'New objective' } } }],
    [{ ...parse, afterReview: true }, revisionParsed],
    [parse, { type: 'EFFECT_FAILED', effectId: parse.effectId, cls: 'io', detail: 'Read failed' }],
    [review({ tag: 'wave', c: rc, phase: 'cli' }), { type: 'WAVE_DONE', effectId: 'review-result', round: 1, findings: [], slots: [{ slot: 'reviewer', state: 'success' }] }],
    [review({ tag: 'rule', c: rc }), { type: 'RULINGS', rulings: {} }],
    [review({ tag: 'fix-verify', c: rc, clusters: [], pass: 'main' }), { type: 'ARTIFACT_PARSED', effectId: 'review-result', kind: 'design', hash: designHash, parsed: design, defects: [] }],
    [review({ tag: 'decide-opt-in', c: rc, items: [] }), { type: 'DECISION', kind: 'opt-in', answer: [] }],
    [review({ tag: 'prepare', c: rc }), { type: 'REVIEW_PREPARED', effectId: 'review-result', scope: { empty: true }, promptPaths: {} }],
    [review({ tag: 'decide-escalation', c: rc, escalation: { kind: 'regression', ids: [] } }), { type: 'DECISION', kind: 'escalation', answer: 'stop' }],
    [review({ tag: 'prepare', c: rc }), { type: 'EFFECT_FAILED', effectId: 'review-result', cls: 'io', detail: 'Read failed' }],
  ];
  const seen = revisions.map(([state, event]) => `${state.tag} --${event.type}--> ${stepDesignRevision(state, event).state.tag}`);
  assert.deepEqual(new Set(seen), new Set(designRevisionTransitions.map((row) => `${row.from} --${row.on}--> ${row.to}`)));

  const extra: [DesignState, Event][] = [];
  const dReview = (child: ReviewState): DesignState => ({ tag: 'review', c, review: child });
  for (const [child, event] of [
    [{ tag: 'wave', c: rc, phase: 'cli' }, { type: 'WAVE_DONE', effectId: 'review-result', round: 1, findings: [], slots: [{ slot: 'reviewer', state: 'success' }] }],
    [{ tag: 'rule', c: rc }, { type: 'RULINGS', rulings: {} }],
    [{ tag: 'fix-verify', c: rc, clusters: [], pass: 'main' }, { type: 'ARTIFACT_PARSED', effectId: 'review-result', kind: 'design', hash: designHash, parsed: design, defects: [] }],
    [{ tag: 'decide-opt-in', c: rc, items: [] }, { type: 'DECISION', kind: 'opt-in', answer: [] }],
    [{ tag: 'prepare', c: rc }, { type: 'REVIEW_PREPARED', effectId: 'review-result', scope: { empty: true }, promptPaths: {} }],
    [{ tag: 'decide-escalation', c: rc, escalation: { kind: 'regression', ids: [] } }, { type: 'DECISION', kind: 'escalation', answer: 'stop' }],
    [{ tag: 'prepare', c: rc }, { type: 'EFFECT_FAILED', effectId: 'review-result', cls: 'io', detail: 'Read failed' }],
  ] as readonly [ReviewState, Event][]) extra.push([dReview(child), event]);
  extra.push([{ ...parsing, c: { ...parsing.c, run: { ...parsing.c.run, verb: 'implement' }, approval: { by: 'user', quote: 'Approved', hash: designHash } } }, good]);
  extra.push([{ tag: 'approval', c: { ...designApproval('implement').c, baseline: 'a'.repeat(40) } }, approve]);
  extra.push([{ tag: 'approval', c: { ...designApproval('implement').c, baseline: 'a'.repeat(40), completed: ['I01', 'I02'], ownership: { I01: ['src/a.ts'], I02: ['src/b.ts'] } } }, approve]);

  const active = started();
  if (active.tag !== 'increment' || !('c' in active.child) || !active.child.c) throw new Error('active increment');
  const fingerprint = { head: 'h', index: 'i', worktree: 'w' };
  const binding = active.child.c.designBinding!;
  const boundPlan = { ...implementPlan(), traceability: { Design: binding.path, Revision: binding.revision, Increment: binding.increment, ...binding.contract } };
  const context = { ...active.child.c, plan: boundPlan, planHash: IMPLEMENT_HASH, lastFingerprint: fingerprint, startFingerprint: fingerprint };
  const activeParent: DesignState = { ...active, child: { tag: 'author', c: context, defects: [] } };
  const planRevision = stepDesign(activeParent, { type: 'REVISE', artifact: 'plan', reason: 'repair', evidence: 'finding' });
  extra.push([planRevision.state, { type: 'SNAPSHOT', effectId: planRevision.effects[0]!.id, fingerprint, diff: { paths: [] } }]);
  const stop = stepDesign({ ...active, child: { tag: 'failure', c: context, reason: 'Stop', changedPaths: [] } }, { type: 'DECISION', kind: 'failure', answer: { action: 'stop' } });
  extra.push([stop.state, { type: 'SNAPSHOT', effectId: stop.effects[0]!.id, fingerprint, diff: { paths: [] } }]);
  extra.push([{ ...active, c: { ...active.c, completed: ['I02'], ownership: { I02: ['src/b.ts'] } }, child: { tag: 'final-verify', c: { ...context, changedPaths: ['src/a.ts'] }, effectId: 'final', before: fingerprint } }, { type: 'VERIFY_DONE', effectId: 'final', purpose: 'final', results: [], fingerprint }]);
  const revision = beginRevision({ tag: 'author', c: context, defects: [] }, { type: 'REVISE', artifact: 'plan', reason: 'repair', evidence: 'finding' }).state;
  if (!('r' in revision)) throw new Error('revision context');
  const planParent: DesignState = { tag: 'plan-revision', c: active.c, increment: 'I01', child: { tag: 'parse', r: revision.r, effectId: 'plan-result', afterReview: true } };
  extra.push([planParent, { type: 'ARTIFACT_PARSED', kind: 'plan', effectId: 'plan-result', hash: IMPLEMENT_HASH, parsed: boundPlan, defects: [] }]);
  extra.push([{ ...planParent, child: { tag: 'drift', r: revision.r, parent: revision, parked: { type: 'AUTHORED', path: revision.r.workingPath }, paths: ['caller.ts'], fingerprint } }, { type: 'DECISION', kind: 'drift', answer: { 'caller.ts': 'stop' } }]);

  const integrated = integration();
  if (integrated.tag !== 'integration' || !('c' in integrated.review)) throw new Error('integration');
  const codeCtx = { ...rc, spec: { ...rc.spec, kind: 'code' as const, mode: 'report' as const } };
  const iReview = (child: ReviewState): DesignState => ({ ...integrated, review: child });
  extra.push([integrated, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' } } }]);
  extra.push([{ ...integrated, c: { ...integrated.c, ownership: {} } }, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' } } }]);
  extra.push([{ ...integrated, review: { ...integrated.review, c: { ...integrated.review.c, findings: integrated.review.c.findings.map((row) => ({ ...row, fix: { paths: ['src/a.ts', 'src/b.ts'], dependencies: [], verification: [] } })) } } }, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' } } }]);
  extra.push([iReview({ tag: 'rule', c: codeCtx }), { type: 'RULINGS', rulings: {} }]);
  extra.push([iReview({ tag: 'wave', c: codeCtx, phase: 'cli' }), { type: 'WAVE_DONE', effectId: 'review-result', round: 1, findings: [], slots: [{ slot: 'reviewer', state: 'success' }] }]);
  extra.push([iReview({ tag: 'decide-opt-in', c: codeCtx, items: [] }), { type: 'DECISION', kind: 'opt-in', answer: [] }]);
  extra.push([iReview({ tag: 'decide-escalation', c: codeCtx, escalation: { kind: 'regression', ids: [] } }), { type: 'DECISION', kind: 'escalation', answer: 'stop' }]);
  extra.push([iReview({ tag: 'prepare', c: codeCtx }), { type: 'EFFECT_FAILED', effectId: 'review-result', cls: 'io', detail: 'Read failed' }]);
  extra.push([iReview({ tag: 'prepare', c: codeCtx }), { type: 'REVIEW_PREPARED', effectId: 'review-result', scope: { empty: true }, promptPaths: {} }]);
  const skipped: DesignState = { ...integrated, scopeEffectId: 'scope', review: { tag: 'skipped', c: codeCtx } };
  extra.push([skipped, { type: 'REVIEW_PREPARED', effectId: 'scope', scope: { empty: false, paths: ['src/a.ts'] }, promptPaths: {} }]);

  const request: Event = { type: 'REVISE', artifact: 'design', reason: 'repair', evidence: 'finding' };
  for (const parent of [{ tag: 'author', c, defects: [] }, dReview({ tag: 'rule', c: rc }), designApproval(), activeParent, integrated] as DesignState[]) {
    extra.push([parent, request]);
    const begun = stepDesign(parent, request).state;
    if (begun.tag !== 'revision') throw new Error('design revision');
    const parsed = stepDesign(begun, { type: 'AUTHORED', path: begun.child.workingPath });
    extra.push([parsed.state, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: parsed.effects[0]!.id, hash: designHash, parsed: { ...design, box: { 'TL;DR': 'Other objective' } }, defects: [] }]);
  }
  const rStart = beginDesignRevision(active.c, { type: 'REVISE', artifact: 'design', reason: 'repair', evidence: 'finding' }).state;
  const rParsed = stepDesignRevision(rStart, { type: 'AUTHORED', path: rStart.workingPath });
  if (rParsed.state.tag !== 'parse') throw new Error('parse');
  extra.push([{ tag: 'revision', c: active.c, child: rParsed.state }, { type: 'EFFECT_FAILED', effectId: rParsed.state.effectId, cls: 'io', detail: 'Read failed' }]);
  extra.push([{ tag: 'revision', c: { ...active.c, approval: null }, child: { ...rParsed.state, c: { ...active.c, approval: null }, afterReview: true } }, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: rParsed.state.effectId, hash: designHash, parsed: design, defects: [] }]);
  extra.push([{ tag: 'revision', c: integrated.c, child: { ...rParsed.state, c: integrated.c, afterReview: true } }, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: rParsed.state.effectId, hash: designHash, parsed: design, defects: [] }]);
  const scopeGrownDesign = { ...design, increments: [{ ...design.increments[0]!, paths: ['src/a.ts', 'src/new.ts'] }, design.increments[1]!] };
  extra.push([{ tag: 'revision', c: active.c, child: { ...rParsed.state, c: active.c, afterReview: true } }, { type: 'ARTIFACT_PARSED', kind: 'design', effectId: rParsed.state.effectId, hash: designHash, parsed: scopeGrownDesign, defects: [] }]);
  const all = [...observed, ...extra.map(([state, event]) => `${state.tag} --${event.type}--> ${stepDesign(state, event).state.tag}`)];
  assert.deepEqual(new Set(all), new Set(designTransitions.map((row) => `${row.from} --${row.on}--> ${row.to}`)));
});
