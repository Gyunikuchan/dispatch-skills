import { bindingHash } from '../../../skills/dispatch/scripts/machines/change-resolution.ts';
import type { ChangeNotice } from '../../../skills/dispatch/scripts/core/types.ts';
const notice: ChangeNotice = { id: 'change', phase: 'review', pendingId: 'check', beforeHash: 'before', afterHash: 'after', rawDeltaRef: { version: 1, sha256: 'a'.repeat(64), bytes: 10, path: 'recovery-deltas/a.json' }, paths: ['target.plan.md'], pathCount: 1, relevance: 'relevant', reason: 'Reviewed input changed', affectedEvidence: [] };
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EFFECT_ID_PATTERN } from '../../../skills/dispatch/scripts/core/effect-id.ts';
import type { Effect, Event, Machine, RunStartedEvent, Verb } from '../../../skills/dispatch/scripts/core/types.ts';
import { askMachine } from '../../../skills/dispatch/scripts/machines/ask.ts';
import { planMachine } from '../../../skills/dispatch/scripts/machines/plan.ts';
import { reviewMachine } from '../../../skills/dispatch/scripts/machines/review.ts';
import { implementData, implementMachine, type ImplementState } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { rootMachine, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import { beginRevision, stepRevision, type RevisionState } from '../../../skills/dispatch/scripts/machines/revision.ts';
import { approvalState } from './fixtures/implement-recovery.ts';
import { started } from './fixtures/design-delivery.ts';
import { integration } from './fixtures/design-integration.ts';
import { hash as designHash, design, run as designRun, approval as designApproval } from './fixtures/design.ts';
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
const natives: Step = { type: 'NATIVE_RESULTS', slots: [{ slot: 'codex[0]', sourceKey: 'codex[0]#fallback', outputPath: 'o', mapping: { launcherModel: 'host-default' } }] };
const failed: Step = (effect) => ({ type: 'EFFECT_FAILED', effectId: id(effect), cls: 'io', detail: 'x' });
const rule = (ruling: string, n = 1): Step => ({ type: 'RULINGS', rulings: { [`R${n}-F001`]: { ruling, reason: 'intentional behavior; scenario evidence' } } });
const applied: Step = (_effect, state) => {
  const found = JSON.stringify(state).match(/"clusterId":"([^"]+)"/);
  return { type: 'FIXES_APPLIED', clusters: [{ clusterId: found?.[1] ?? '' }] };
};
const applyFailed: Step = (_effect, state) => {
  const found = JSON.stringify(state).match(/"clusterId":"([^"]+)"/);
  return { type: 'FIXES_APPLIED', clusters: [{ clusterId: found?.[1] ?? '', status: 'failed' }] };
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
  verification: { automated: [], none: null, manual: [] }, finalCommands: [], traceability: null, governedText: '# Example',
  tasks: withEvidence ? [{ id: 'T1', title: 'Deliver', line: 1, summary: 'Deliver behavior', paths: ['src/a.ts'], criteria: ['SC1'], prerequisites: [], generated: [] }] : [],
});
const implementRun = (): RunStartedEvent => run('implement', {
  argument: 'x.plan.md', overrides: { path: 'x.plan.md', sessionDir: '/session', settledPlan: { path: 'x.plan.md', hash: IMPLEMENT_HASH, outcome: 'settled' } },
  config: { 'write-subagents': { claude: { low: { model: 'writer' } } }, 'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } }, phases: { 'plan-review': { rounds: { low: 1 }, targets: { low: 1 } }, 'code-review': { rounds: { low: 0 }, targets: { low: 1 } } } },
});
const implementSnapshot: Step = (effect) => ({ type: 'SNAPSHOT', effectId: id(effect), fingerprint: { head: 'h', index: 'i', worktree: 'w' }, diff: { paths: [] } });
const implementParsed = (withEvidence = false): Step => (effect) => ({ type: 'ARTIFACT_PARSED', effectId: id(effect), kind: 'plan', hash: IMPLEMENT_HASH, parsed: implementPlan(withEvidence), defects: [] });
const implementBadParsed: Step = (effect) => ({ type: 'ARTIFACT_PARSED', effectId: id(effect), kind: 'plan', hash: IMPLEMENT_HASH, parsed: {}, defects: [] });
const implementVerified: Step = (effect) => ({ type: 'VERIFY_DONE', effectId: id(effect), purpose: effect?.kind === 'verify' ? effect.purpose : 'baseline', results: [], fingerprint: { head: 'h', index: 'i', worktree: 'w' } });
const checkoutResults: Record<string, Record<string, unknown>> = {
  init: { path: 'wt/integration', base: 'b0', manifest: { linked: [] } }, task: { path: 'wt/task-t1', revision: 'b0' }, commit: { revision: 'c1', paths: ['src/a.ts'] },
  integrate: { revision: 'i1', conflict: false, paths: [] }, deliver: { conflicts: [], transferred: ['src/a.ts'], already: [] }, cleanup: {},
};
const implementCheckout: Step = (effect) => ({ type: 'CHECKOUT_DONE', effectId: id(effect), op: effect?.kind === 'checkout' ? effect.op : 'init', result: checkoutResults[effect?.kind === 'checkout' ? effect.op : 'init'] ?? {} });
const implementBrief: Step = (effect) => ({ type: 'BRIEF_READY', effectId: id(effect), stage: 'task', path: 'run/brief.md', sha256: IMPLEMENT_HASH, envelopePath: 'run/outcome.json' });
const implementClassification: Step = (_effect, state) => {
  const raw = state as { tag: string; child?: ImplementState };
  const current = raw.tag === 'implement' && raw.child ? raw.child : state as ImplementState;
  return { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'low', rationale: 'One bounded local behavior change.', gateScope: implementData(current)['gateScope'] } };
};
const implementLaunched: Step = (_effect, state) => {
  const raw = state as { tag: string; child?: ImplementState };
  const current = raw.tag === 'implement' && raw.child ? raw.child : state as ImplementState;
  const task = (current as Extract<ImplementState, { tag: 'tasks' }>).c.tasks['T1']!;
  return { type: 'WRITE_LAUNCHED', tasks: [{ task: 'T1', attempt: task.attempt, signature: task.signature, handle: 'agent-1', model: (current as Extract<ImplementState, { tag: 'tasks' }>).c.writer!.models[task.modelIndex]! }] };
};
const implementEnvelope: Step = (_effect, state) => {
  const raw = state as { tag: string; child?: ImplementState };
  const current = raw.tag === 'implement' && raw.child ? raw.child : state as ImplementState;
  const task = (current as Extract<ImplementState, { tag: 'tasks' }>).c.tasks['T1']!;
  return { type: 'WRITE_ENVELOPE', envelopePath: 'run/outcome.json', task: 'T1', attempt: task.attempt, signature: task.signature, handle: task.handle! };
};
const implementChecked: Step = (effect) => ({ type: 'ENVELOPE_CHECKED', effectId: id(effect), envelope: { schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'Implemented', evidence: ['CRITERION SC1 | src/a.ts | delivered behavior'] }, defects: [], diff: { paths: ['src/a.ts'] } });
const implementApprovalStop: Step = { type: 'DECISION', kind: 'approval', answer: 'stop' };
const implementApproval: Step = { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } };
const implementEvidence: Step = { type: 'EVIDENCE', criteria: { SC1: { outcome: 'pass', evidence: 'reviewed behavior' } } };

function implementsToTerminal(withEvidence: boolean): Step[] {
  return [implementRun(), implementSnapshot, implementParsed(withEvidence), implementSnapshot, implementVerified, implementSnapshot, implementApproval, implementClassification,
    implementCheckout, ...(withEvidence ? [implementCheckout, implementSnapshot, implementBrief, implementLaunched, implementEnvelope, implementChecked, implementCheckout, implementCheckout] : []),
    implementCheckout, implementCheckout, implementSnapshot, implementSnapshot, implementVerified, ...(withEvidence ? [implementEvidence] : [])];
}

// SECTION: Replay

type Journal = { triples: Set<string>; ids: string[] };

function replay<S>(machine: Machine<S>, steps: readonly Step[], bindReview = false): Journal {
  let state = machine.initial();
  const open: Effect[] = [];
  const triples = new Set<string>();
  const ids: string[] = [];
  for (const step of steps) {
    let event = typeof step === 'function' ? step(open.at(-1), state) : step;
    if (bindReview && event.type === 'REVIEW_PREPARED') event = { ...event, scope: { ...event.scope, manifestPath: 'binding.json' } };
    const result = machine.step(state, event);
    const from = (state as Tagged).tag;
    const to = (result.state as Tagged).tag;
    if (from !== to) triples.add(`${from} --${event.type}--> ${to}`);
    state = result.state;
    open.push(...result.effects);
    ids.push(...result.effects.map((effect) => effect.id));
    if ((state as Tagged).tag === 'target-check') {
      const check = result.effects.find((effect) => effect.kind === 'check-review-target'); assert.ok(check);
      const resumed = machine.step(state, { type: 'REVIEW_TARGET_CHECKED', effectId: check.id, manifestPath: 'checked.json' });
      triples.add(`target-check --REVIEW_TARGET_CHECKED--> ${(resumed.state as Tagged).tag}`);
      state = resumed.state; open.push(...resumed.effects); ids.push(...resumed.effects.map((effect) => effect.id));
    }
    const pending = state as unknown as { tag: string; child?: { tag: string }; c?: { lastFingerprint?: Record<string, unknown> } };
    if (pending.tag === 'checking-host-event' || pending.child?.tag === 'checking-host-event') {
      const snapshot = result.effects.find((effect) => effect.kind === 'snapshot');
      assert.ok(snapshot);
      const resumed = machine.step(state, { type: 'SNAPSHOT', effectId: snapshot.id, fingerprint: { head: 'h', index: 'i', worktree: 'w' }, diff: { paths: [] } });
      const nextTag = (resumed.state as Tagged).tag;
      if (pending.tag !== nextTag) triples.add(`${pending.tag} --SNAPSHOT--> ${nextTag}`);
      state = resumed.state; open.push(...resumed.effects); ids.push(...resumed.effects.map((effect) => effect.id));
    }
    const assessment = open.at(-1);
    if (assessment?.kind === 'assess-recovery') {
      const beforeHash=bindingHash(assessment.before), afterHash=bindingHash(assessment.after);
      const from=(state as Tagged).tag;
      const resumed=machine.step(state,{type:'RECOVERY_ASSESSED',effectId:assessment.id,purpose:assessment.purpose,beforeHash,afterHash,notice:{id:'fixture',phase:assessment.phase,pendingId:assessment.pendingId,beforeHash,afterHash,rawDeltaRef:{version:1,sha256:'b'.repeat(64),bytes:10,path:'recovery-deltas/b.json'},paths:[],pathCount:0,relevance:'expected',reason:'No delta',affectedEvidence:[]}});
      const to=(resumed.state as Tagged).tag;
      if(from!==to) triples.add(`${from} --RECOVERY_ASSESSED--> ${to}`);
      state=resumed.state;open.push(...resumed.effects);ids.push(...resumed.effects.map((effect)=>effect.id));
    }
  }
  return { triples, ids };
}

function parity<S>(machine: Machine<S>, scenarios: readonly (readonly Step[])[], direct: readonly (readonly [S, Event])[] = []): void {
  const observed = new Set<string>();
  for (const scenario of scenarios) for (const triple of replay(machine, scenario).triples) observed.add(triple);
  if (machine === reviewMachine as unknown as Machine<S>) for (const scenario of scenarios) for (const triple of replay(machine, scenario, true).triples) observed.add(triple);
  for (const [state, event] of direct) {
    const next = machine.step(state, event).state;
    observed.add(`${(state as Tagged).tag} --${event.type}--> ${(next as Tagged).tag}`);
  }
  const table = new Set(machine.transitions.map((row) => `${row.from} --${row.on}--> ${row.to}`));
  assert.deepEqual([...observed].filter((triple) => !table.has(triple)), [], 'observed tag changes missing from the table');
  assert.deepEqual([...table].filter((triple) => !observed.has(triple)), [], 'table rows no fixture drives');
}

function materialResolution(parent: ImplementState, action: 'reconcile' | 'escalate'): readonly [ImplementState, Event] {
  if (!('c' in parent) || !parent.c?.lastFingerprint) throw new Error('observation context');
  const c = parent.c, fingerprint = { ...c.lastFingerprint, worktree: 'material-change' };
  const beforeHash = bindingHash(c.lastFingerprint), afterHash = bindingHash(fingerprint);
  const boundNotice = { ...notice, beforeHash, afterHash, phase: parent.tag, pendingId: 'AUTHORED' };
  return [{ tag: 'assessing-host-event', c, parent, parked: { type: 'AUTHORED', path: c.planPath }, effectId: 'assessment', fingerprint,
    resolution: { by: 'orchestrator', noticeId: boundNotice.id, afterHash, action, rationale: 'Resolve changed input', evidenceIds: [] } },
  { type: 'RECOVERY_ASSESSED', effectId: 'assessment', purpose: 'drift', beforeHash, afterHash, notice: boundNotice }];
}

// SECTION: Tests

test('review-target transitions table matches step', () => {
  const boot = reviewMachine.step(reviewMachine.initial(), run('review', {}, 1));
  const launch = reviewMachine.step(boot.state, { type: 'REVIEW_PREPARED', effectId: boot.effects[0]!.id, scope: { manifestPath: 'binding.json' }, promptPaths: {} });
  const completed: Event = { type: 'WAVE_STARTED', effectId: launch.effects[0]!.id, waveKey: 'wave', attempt: 0, roster: [], native: [], early: [], claimPath: null, inputPath: '', completed: { type: 'WAVE_DONE', effectId: launch.effects[0]!.id, round: 1, slots: [{ slot: 'codex[0]', state: 'success' }], findings: [] } } as Event;
  const checking = reviewMachine.step(launch.state, completed);
  if (checking.state.tag !== 'target-check') throw new Error('target check');
  const changed: Event = { type: 'REVIEW_TARGET_CHECKED', effectId: checking.state.effectId, manifestPath: 'changed.json', result: 'changed', notice };
  const resolving = reviewMachine.step(checking.state, changed);
  const answer = { by: 'orchestrator', noticeId: notice.id, afterHash: notice.afterHash, action: 'refresh' as const, rationale: 'Refresh changed input', evidenceIds: [] };
  const rechecking = reviewMachine.step(resolving.state, { type: 'DECISION', kind: 'drift', answer });
  if (rechecking.state.tag !== 'target-check') throw new Error('target recheck');
  const emptyParent: ReviewState = { tag: 'prepare', c: { ...checking.state.c, effectId: 'prepare' } };
  const emptyPrepared = reviewMachine.step(emptyParent, { type: 'REVIEW_PREPARED', effectId: 'prepare', scope: { empty: true }, promptPaths: {} });
  if (emptyPrepared.state.tag !== 'target-check') throw new Error('empty target check');
  const emptyCheck = emptyPrepared.state;
  parity(reviewMachine, [
    [run('review'), prepared, wave([f(1)]), rule('accept'), applyFailed, applyFailed, applyFailed],
    [run('review'), prepared, wave([f(1)]), rule('accept'), applied, verified(1), applied, verified(1), applied, verified(1)],
    [run('review', { ...plan }), prepared, wave([f(1)]), rule('accept'), applied, parsed([{ message: 'm' }]), applied, parsed([{ message: 'm' }]), applied, parsed([{ message: 'm' }])],
    [run('review', {}, 0)], [run('review', badPins)], [run('review'), failed], [run('review'), empty],
    [run('review'), prepared, failed], [run('review'), prepared, nativeWave, natives, wave([f(1)])],
    [run('review'), prepared, wave([])], [run('review'), ...regression, decide('escalation', 'stop')],
    [run('review'), prepared, wave([f(1)]), rule('reject'), prepared, wave([])],
    [run('review', { fix: false }), prepared, wave([f(1)]), rule('accept')],
    [run('review', { fix: false }), prepared, wave([f(1)]), rule('needs-user'), decide('needs-user', { 'R1-F001': { ruling: 'reject', quote: 'no' } })],
    [run('review'), prepared, wave([f(1, { category: 'intent' }), f(1, { id: 'R1-F002', locus: 'b' })]),
      { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'needs-user' }, 'R1-F002': { ruling: 'accept' } } },
      decide('needs-user', { 'R1-F001': { ruling: 'reject', quote: 'keep' } }), applied, verified(1), applied, failed],
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
      { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'needs-user' }, 'R1-F002': { ruling: 'reject', reason: 'intentional behavior; retained scenario evidence' } } }, decide('needs-user', { 'R1-F001': { ruling: 'reject', quote: 'no' } })],
    [run('review', {}, 1), prepared, wave([f(1, { severity: 'CONSIDER' })]), rule('needs-user'), decide('needs-user', { 'R1-F001': { ruling: 'accept', quote: 'later' } })],
  ], [[launch.state, completed], [checking.state, { type: 'EFFECT_FAILED', effectId: checking.effects[0]!.id, cls: 'integrity', detail: 'target-changed' }],
    [checking.state, changed], [resolving.state, { type: 'DECISION', kind: 'drift', answer }],
    [rechecking.state, { ...changed, effectId: rechecking.state.effectId }],
    [emptyCheck, { type: 'REVIEW_TARGET_CHECKED', effectId: emptyCheck.effectId, manifestPath: 'empty.json', result: 'unchanged' }]]);
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
  const revisionStart = beginRevision(approvalState(), { type: 'REVISE', artifact: 'plan', reason: 'parity', evidence: 'fixture' }).state;
  const r = revisionStart.r;
  const runInfo = { verb: 'implement' as const, argument: 'x.plan.md', slug: 'x' };
  const settled: RevisionState = { tag: 'resume', r: { ...r, plan: r.original, hash: r.originalHash, changed: [], removed: [], grew: false } };
  const stopped: RevisionState = { tag: 'stopped', r, summary: 'Stopped after scope adjudication.' };
  const refused: RevisionState = { tag: 'refused', r, error: 'Revision refused.' };
  const terminalRevisionEvents: readonly (readonly [RootState, Event])[] = [
    [{ tag: 'revision', run: runInfo, child: settled }, { type: 'SNAPSHOT', effectId: 'revision.snapshot', fingerprint: { head: 'h', index: 'i', worktree: 'w' }, diff: { paths: [] } }],
    [{ tag: 'revision', run: runInfo, child: stopped }, { type: 'SNAPSHOT', effectId: 'revision.snapshot', fingerprint: { head: 'h', index: 'i', worktree: 'w' }, diff: { paths: [] } }],
    [{ tag: 'revision', run: runInfo, child: refused }, { type: 'DECISION', kind: 'scope-deviation', answer: {} }],
    ...(['reconcile', 'escalate'] as const).map((action): readonly [RootState, Event] => { const [child, event] = materialResolution(approvalState(), action); return [{ tag: 'implement', run: runInfo, child }, event]; }),
  ];
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
  ], terminalRevisionEvents);
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
  assert.ok(declared.has('task-checkout --CHECKOUT_DONE--> task-brief'));
  assert.ok(declared.has('tasks --WRITE_ENVELOPE--> task-envelope'));
});

test('level-journal: machine parity includes classification, scope-adjudication, scope-user-decision and scope-draining states', () => {
  const declared = new Set(implementMachine.transitions.map((row) => `${row.from} --${row.on}--> ${row.to}`));
  for (const edge of [
    'baseline-decision --DECISION--> level-classification',
    'approval --DECISION--> level-classification',
    'level-classification --DECISION--> checking-host-event',
    'level-recommendation --DECISION--> checking-host-event',
    'checking-host-event --SNAPSHOT--> baseline-decision',
    'checking-host-event --SNAPSHOT--> scope-adjudication',
    'task-envelope --ENVELOPE_CHECKED--> scope-adjudication',
    'scope-adjudication --DECISION--> scope-user-decision',
    'scope-user-decision --DECISION--> scope-draining',
    'scope-draining --WRITE_ENVELOPE--> scope-drain-envelope',
    'scope-drain-envelope --ENVELOPE_CHECKED--> scope-draining',
    'scope-adjudication --DECISION--> stopped',
    'scope-user-decision --DECISION--> stopped',
    'scope-draining --WRITE_CANCELLED--> stopped',
  ]) assert.ok(declared.has(edge), `missing declared edge: ${edge}`);
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
  const c = { ...designApproval().c, run: reviewRun, levelGatePassed: true };
  const author = beginDesignRevision(c, { type: 'REVISE', artifact: 'design', reason: 'repair', evidence: 'finding' }).state;
  const parse = stepDesignRevision(author, { type: 'AUTHORED', path: author.workingPath }).state;
  if (parse.tag !== 'parse') throw new Error('revision parse');
  const revisionParsed: Event = { type: 'ARTIFACT_PARSED', kind: 'design', effectId: parse.effectId, hash: `sha256:${'b'.repeat(64)}`, parsed: { ...design, details: { ...design.details, I02: { Outcome: 'Changed' } } }, defects: [] };
  const unchangedDesign: Event = { ...revisionParsed, hash: c.hash!, parsed: design };
  const scopeState = stepDesignRevision({ ...parse, afterReview: true }, revisionParsed).state;
  if (scopeState.tag !== 'scope-adjudication') throw new Error('scope adjudication');
  const disagree: Event = { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: scopeState.request, ruling: 'disagree', rationale: 'The requested change exceeds the design intent.' } };
  const userScopeState = stepDesignRevision(scopeState, disagree).state;
  if (userScopeState.tag !== 'scope-user-decision') throw new Error('scope user decision');
  const begun = beginReview({ kind: 'design', mode: 'fix', target: author.workingPath, cap: 1, breadth: 1, context: '', roster: [], timeoutMs: 1000 }, 'design.revision.review', c.counters).state;
  if (!('c' in begun)) throw new Error('review context');
  const rc = { ...begun.c, effectId: 'review-result', round: 1, optInAsked: true };
  const review = (state: ReviewState): DesignRevisionState => ({ tag: 'review', c, workingPath: author.workingPath, reason: 'repair', evidence: 'finding', review: state });
  const revisions: readonly [DesignRevisionState, Event][] = [
    [author, { type: 'AUTHORED', path: author.workingPath }], [parse, revisionParsed],
    [parse, unchangedDesign],
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
    [scopeState, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: scopeState.request, ruling: 'approve', rationale: 'The proposed increment change is necessary.' } }],
    [scopeState, disagree], [scopeState, { type: 'DECISION', kind: 'run-stop', answer: { by: 'user', quote: 'Stop here.' } }],
    [userScopeState, { type: 'DECISION', kind: 'scope-deviation-user', answer: { by: 'user', requestId: scopeState.request.requestId, choice: 'accept', quote: 'Accept the additional increment.' } }],
    [userScopeState, { type: 'DECISION', kind: 'scope-deviation-user', answer: { by: 'user', requestId: scopeState.request.requestId, choice: 'decline', quote: 'Keep the current design.' } }],
    [userScopeState, { type: 'DECISION', kind: 'run-stop', answer: { by: 'user', quote: 'Stop here.' } }],
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
  const context = { ...active.child.c, levelGatePassed: true, plan: boundPlan, planHash: IMPLEMENT_HASH, lastFingerprint: fingerprint, startFingerprint: fingerprint };
  const activeParent: DesignState = { ...active, child: { tag: 'author', c: context, defects: [] } };
  for (const action of ['reconcile', 'escalate'] as const) { const [child, event] = materialResolution(activeParent.child, action); extra.push([{ ...active, child }, event]); }
  const planRevision = stepDesign(activeParent, { type: 'REVISE', artifact: 'plan', reason: 'repair', evidence: 'finding' });
  extra.push([planRevision.state, { type: 'SNAPSHOT', effectId: planRevision.effects[0]!.id, fingerprint, diff: { paths: [] } }]);
  const stop = stepDesign({ ...active, child: { tag: 'failure', c: context, reason: 'Stop', changedPaths: [] } }, { type: 'DECISION', kind: 'failure', answer: { action: 'stop' } });
  extra.push([stop.state, { type: 'SNAPSHOT', effectId: stop.effects[0]!.id, fingerprint, diff: { paths: [] } }]);
  extra.push([{ ...active, c: { ...active.c, completed: ['I02'], ownership: { I02: ['src/b.ts'] } }, child: { tag: 'final-verify', c: { ...context, changedPaths: ['src/a.ts'] }, effectId: 'final', before: fingerprint } }, { type: 'VERIFY_DONE', effectId: 'final', purpose: 'final', results: [], fingerprint }]);
  const revision = beginRevision({ tag: 'author', c: context, defects: [] }, { type: 'REVISE', artifact: 'plan', reason: 'repair', evidence: 'finding' }).state;
  if (!('r' in revision)) throw new Error('revision context');
  const planParent: DesignState = { tag: 'plan-revision', c: active.c, increment: 'I01', child: { tag: 'parse', r: revision.r, effectId: 'plan-result', afterReview: true } };
  extra.push([planParent, { type: 'ARTIFACT_PARSED', kind: 'plan', effectId: 'plan-result', hash: IMPLEMENT_HASH, parsed: boundPlan, defects: [] }]);
  const expandedPlan = { ...boundPlan, keyDecisions: ['Preserve compatibility for the added behavior.'] };
  const expandedPlanEvent: Event = { type: 'ARTIFACT_PARSED', kind: 'plan', effectId: 'plan-result', hash: `sha256:${'b'.repeat(64)}`, parsed: expandedPlan, defects: [] };
  const planScopeChild = stepRevision(planParent.child, expandedPlanEvent);
  if (planScopeChild.state.tag !== 'scope-adjudication') throw new Error(`plan scope adjudication: ${planScopeChild.state.tag}`);
  extra.push([planParent, expandedPlanEvent]);
  const planScopeParent: DesignState = { ...planParent, child: planScopeChild.state };
  const planDisagreement = stepRevision(planScopeChild.state, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: planScopeChild.state.request, ruling: 'disagree', rationale: 'Needs user intent decision' } });
  if (planDisagreement.state.tag !== 'checking-host-event') throw new Error('scope observation');
  const planDisagreed = stepRevision(planDisagreement.state, { type: 'SNAPSHOT', effectId: planDisagreement.effects[0]!.id, fingerprint, diff: { paths: [] } }).state;
  if (planDisagreed.tag !== 'scope-user-decision') throw new Error('scope user decision');
  const declined = stepDesign({ ...planParent, child: planDisagreed }, { type: 'DECISION', kind: 'scope-deviation-user', answer: { by: 'user', requestId: planScopeChild.state.request.requestId, choice: 'decline', quote: 'Keep approved scope.' } });
  extra.push([declined.state, { type: 'SNAPSHOT', effectId: declined.effects[0]!.id, fingerprint, diff: { paths: [] } }]);
  extra.push([planScopeParent, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: planScopeChild.state.request, ruling: 'approve', rationale: 'The added path is required by the settled outcome.' } }]);
  extra.push([planScopeParent, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: planScopeChild.state.request, ruling: 'disagree', rationale: 'The added path is not needed for this outcome.' } }]);
  extra.push([planScopeParent, { type: 'DECISION', kind: 'run-stop', answer: { by: 'user', quote: 'Stop the revision.' } }]);
  const stoppingPlanRevision = stepDesign(planScopeParent, { type: 'DECISION', kind: 'run-stop', answer: { by: 'user', quote: 'Stop the revision.' } });
  extra.push([stoppingPlanRevision.state, { type: 'SNAPSHOT', effectId: stoppingPlanRevision.effects[0]!.id, fingerprint, diff: { paths: [] } }]);
  extra.push([{ ...planParent, child: { tag: 'drift', r: revision.r, parent: revision, parked: { type: 'AUTHORED', path: revision.r.workingPath }, paths: ['caller.ts'], fingerprint, notice: { id: 'n', phase: 'revision', pendingId: 'AUTHORED', beforeHash: 'before', afterHash: 'after', rawDeltaRef: { version: 1, sha256: 'b'.repeat(64), bytes: 10, path: 'recovery-deltas/b.json' }, paths: ['caller.ts'], pathCount: 1, relevance: 'unknown', reason: 'dependency coverage', affectedEvidence: [] } } }, { type: 'DECISION', kind: 'drift', answer: { 'caller.ts': 'stop' } }]);

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
  const designScopeEvent: Event = { type: 'ARTIFACT_PARSED', kind: 'design', effectId: rParsed.state.effectId, hash: `sha256:${'c'.repeat(64)}`, parsed: scopeGrownDesign, defects: [] };
  const settledDesign = { ...active.c, levelGatePassed: true };
  const designScopeChild = stepDesignRevision({ ...rParsed.state, c: settledDesign, afterReview: true }, designScopeEvent).state;
  if (designScopeChild.tag !== 'scope-adjudication') throw new Error('design scope adjudication');
  extra.push([{ tag: 'revision', c: settledDesign, child: { ...rParsed.state, c: settledDesign, afterReview: true } }, designScopeEvent]);
  const designScopeParent: DesignState = { tag: 'revision', c: settledDesign, child: designScopeChild };
  const designDisagree: Event = { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: designScopeChild.request, ruling: 'disagree', rationale: 'The path addition is not required.' } };
  const designUserScopeChild = stepDesignRevision(designScopeChild, designDisagree).state;
  if (designUserScopeChild.tag !== 'scope-user-decision') throw new Error('design scope user decision');
  const designUserScopeParent: DesignState = { tag: 'revision', c: settledDesign, child: designUserScopeChild };
  extra.push([designScopeParent, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: designScopeChild.request, ruling: 'approve', rationale: 'The accepted outcome requires the added path.' } }]);
  extra.push([designScopeParent, designDisagree]);
  extra.push([designScopeParent, { type: 'DECISION', kind: 'run-stop', answer: { by: 'user', quote: 'Stop design revision.' } }]);
  extra.push([designUserScopeParent, { type: 'DECISION', kind: 'scope-deviation-user', answer: { by: 'user', requestId: designScopeChild.request.requestId, choice: 'accept', quote: 'Accept the required path.' } }]);
  extra.push([designUserScopeParent, { type: 'DECISION', kind: 'scope-deviation-user', answer: { by: 'user', requestId: designScopeChild.request.requestId, choice: 'decline', quote: 'Keep the current scope.' } }]);
  extra.push([designUserScopeParent, { type: 'DECISION', kind: 'run-stop', answer: { by: 'user', quote: 'Stop design revision.' } }]);
  const withinScopeChild = stepDesignRevision({ ...rParsed.state, c: settledDesign, afterReview: true }, revisionParsed).state;
  if (withinScopeChild.tag !== 'scope-adjudication') throw new Error('within-scope design adjudication');
  const withinScopeParent: DesignState = { tag: 'revision', c: settledDesign, child: withinScopeChild, parent: active };
  extra.push([withinScopeParent, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: withinScopeChild.request, ruling: 'approve', rationale: 'The acceptance detail is required within this increment.' } }]);
  const settledIntegration = { ...integrated.c, levelGatePassed: true };
  const integrationRevision = beginDesignRevision(settledIntegration, { type: 'REVISE', artifact: 'design', reason: 'repair integration', evidence: 'Update acceptance detail' }).state;
  const integrationParse = stepDesignRevision(integrationRevision, { type: 'AUTHORED', path: integrationRevision.workingPath }).state;
  if (integrationParse.tag !== 'parse') throw new Error('integration revision parse');
  const integrationRevisionParsed = { ...revisionParsed, effectId: integrationParse.effectId };
  const integrationScopeChild = stepDesignRevision({ ...integrationParse, afterReview: true }, integrationRevisionParsed).state;
  if (integrationScopeChild.tag !== 'scope-adjudication') throw new Error('integration revision adjudication');
  const integrationRevisionParent: DesignState = { tag: 'revision', c: settledIntegration, child: integrationScopeChild, parent: { ...integrated, c: settledIntegration } };
  extra.push([integrationRevisionParent, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request: integrationScopeChild.request, ruling: 'approve', rationale: 'The revised acceptance detail resolves the integration concern.' } }]);
  const all = [...observed, ...extra.map(([state, event]) => `${state.tag} --${event.type}--> ${stepDesign(state, event).state.tag}`)];
  assert.deepEqual(new Set(all), new Set(designTransitions.map((row) => `${row.from} --${row.on}--> ${row.to}`)));
});
