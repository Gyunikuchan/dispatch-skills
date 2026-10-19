import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Effect, Event, RunStartedEvent } from '../../../../skills/dispatch/scripts/core/types.ts';
import type { ParsedPlan, PlanCriterion, PlanTask } from '../../../../skills/dispatch/scripts/domain/types.ts';
import { parseRedMatrix } from '../../../../skills/dispatch/scripts/machines/implement-types.ts';
import { implementData, initialImplement, stepImplement, validateImplement, type ImplementState } from '../../../../skills/dispatch/scripts/machines/implement.ts';
import { reconcileTasks, taskSignature } from '../../../../skills/dispatch/scripts/machines/implement-tasks.ts';
import { launchOf } from '../../../helpers/launch.ts';

// SECTION: Fixture plan — T1 (RED) and T2 are independent; T3 depends on T1.

export const HASH = `sha256:${'a'.repeat(64)}`;
/** Unique per brief effect so stale-brief checks can tell rebriefs apart. */
export const briefSha = (effectId: string) => `sha256:${createHash('sha256').update(effectId).digest('hex')}`;
export const FP = { head: 'h', index: 'i', worktree: 'w' };
export const criterion = (id: string, file: string, evidence: 'red' | 'verify', extra: string[] = []): PlanCriterion => ({
  id, title: `${id} works`, line: 1, changes: [file, ...extra], verify: [{ command: `node --test tests/${id.toLowerCase()}.test.ts`, final: false }],
  evidence, preExisting: false, tests: [], red: null, redException: null, testRationale: evidence === 'red' ? 'discriminates' : null, review: null, enforcementInfeasibility: null, retain: 'durable', coveredBy: null,
});
export const task = (id: string, paths: string[], criteria: string[], prerequisites: string[] = []): PlanTask => ({ id, title: id, summary: `Deliver ${id}`, line: 1, paths, criteria, prerequisites, generated: [], overlaps: [] });
export const PLAN: ParsedPlan = {
  title: 'Tasks', box: { 'TL;DR': 'Deliver tasks' }, keyDecisions: [],
  criteria: [{ ...criterion('SC1', 'src/a.ts', 'red', ['tests/validation.test.ts']), tests: ['tests/validation.test.ts'], red: 'node --test {files}' }, criterion('SC2', 'src/b.ts', 'verify'), criterion('SC3', 'src/c.ts', 'verify')],
  changes: [{ action: 'MODIFY', path: 'src/a.ts', note: 'a', command: null, line: 1 }, { action: 'NEW', path: 'tests/validation.test.ts', note: 'tests', command: null, line: 2 }, { action: 'MODIFY', path: 'src/b.ts', note: 'b', command: null, line: 3 }, { action: 'MODIFY', path: 'src/c.ts', note: 'c', command: null, line: 4 }],
  verification: { automated: [], none: null, manual: [] }, finalCommands: [], traceability: null, governedText: '# Tasks', planIds: ['SC1', 'SC2', 'SC3'], sharedContext: '# Tasks', seams: [], warnings: [],
  tasks: [task('T1', ['src/a.ts', 'tests/validation.test.ts'], ['SC1']), task('T2', ['src/b.ts'], ['SC2']), task('T3', ['src/c.ts'], ['SC3'], ['T1'])],
};
export const run = (concurrency: number, reviewRounds = 0): RunStartedEvent => ({
  type: 'RUN_STARTED', verb: 'implement', argument: 'x.plan.md', level: 'low', levelSource: 'explicit', pins: null, orchestrator: 'claude', orchestratorModel: null, repo: {},
  overrides: { sessionDir: 'session', settledPlan: { path: 'x.plan.md', hash: HASH, outcome: 'settled' } },
  config: { 'write-concurrency': concurrency, 'write-subagents': { claude: { low: { model: ['writer-a', 'writer-b'] } } }, 'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } }, phases: { 'plan-review': { rounds: { low: 1 }, targets: { low: 1 } }, 'code-review': { rounds: { low: reviewRounds }, targets: { low: 1 } } } },
});
export const RED_ROW = 'RED-MATRIX SC1 | tests/validation.test.ts:rejects bad input | exit 1 test:rejects bad input';

// SECTION: Simulated driver — answers every effect, stopping at host awaits

export type Outcome = { exit: number; failedTests?: string[]; baselineHits?: string[]; scanUnreadable?: string[] };
export type Sim = {
  plan?: ParsedPlan;
  planHash?: string;
  reviewRounds?: number;
  envelope?: (id: string) => Record<string, unknown>;
  diff?: (id: string) => string[];
  commitPaths?: (id: string) => string[];
  /** `cwd` tells the task worktree (green) from the integration tree for the shared `scoped` purpose. */
  verify?: (purpose: string, command: string, task: string | null, cwd?: string) => Outcome;
  conflict?: string[];
  /** Paths the conflicting integration reports; defaults to a file no task owns. */
  conflictPaths?: string[];
  redDefects?: string[];
  resolve?: (input: Record<string, unknown>) => Record<string, unknown>;
  /** Parse results for `REPLACE_PLAN` files, keyed by path; other parses return the run plan. */
  replacements?: Record<string, { plan: ParsedPlan; hash: string; defects?: Record<string, unknown>[] }>;
};
export type Result = { state: ImplementState; effects: readonly Effect[] };
export type Trace = { effects: Effect[]; events: Event[] };

export const taskOf = (state: ImplementState): string | null => 'task' in state && typeof state.task === 'string' ? state.task : null;
export const pathsOf = (id: string, plan: ParsedPlan = PLAN) => plan.tasks.find((row) => row.id === id)!.paths;
/** Automated Tests commands no criterion lists; writers self-check them and integration gates them. */
export const CONTRACT_PLAN: ParsedPlan = { ...PLAN, verification: { ...PLAN.verification, automated: ['npm run lint'] } };
const contractOf = (plan: ParsedPlan) => plan.verification.automated.filter((command) => !plan.criteria.some((row) => row.verify.some((entry) => entry.command === command)));
export const checkRows = (plan: ParsedPlan, exit = 0) => contractOf(plan).map((command) => `CHECK ${command} | exit ${exit}`);
export const defaultEnvelope = (id: string, plan: ParsedPlan = PLAN) => ({ schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: `Delivered ${id}`, evidence: [...plan.tasks.find((row) => row.id === id)!.criteria.map((sc) => `CRITERION ${sc} | ${plan.criteria.find((row) => row.id === sc)!.changes[0]} | behavior`), ...(id === 'T1' ? [RED_ROW] : []), ...checkRows(plan)] });
export const defaultVerify = (purpose: string): Outcome => purpose === 'red' ? { exit: 1, failedTests: ['test:rejects bad input'] } : { exit: 0 };

export function answer(state: ImplementState, effect: Effect, sim: Sim): Event | null {
  const id = taskOf(state), plan = sim.plan ?? PLAN;
  switch (effect.kind) {
    case 'snapshot': return { type: 'SNAPSHOT', effectId: effect.id, fingerprint: FP, diff: { paths: [] } };
    case 'parse-artifact': {
      const replacement = sim.replacements?.[effect.path];
      if (replacement) return { type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'plan', hash: replacement.hash, parsed: replacement.plan, defects: (replacement.defects ?? []) as never };
      return { type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'plan', hash: sim.planHash ?? HASH, parsed: sim.plan ?? PLAN, defects: [] };
    }
    case 'write-brief': return {
      type: 'BRIEF_READY', effectId: effect.id, stage: 'task', path: `run/${id}.brief.md`, sha256: briefSha(effect.id), envelopePath: `run/${id}-${effect.id}.outcome.json`,
      ...(effect.input['deltaBase'] ? { delta: { path: `run/${id}.delta.md`, sha256: briefSha(`${effect.id}.delta`) } } : {}),
    };
    case 'check-envelope': return { type: 'ENVELOPE_CHECKED', effectId: effect.id, envelope: sim.envelope ? sim.envelope(id!) : defaultEnvelope(id!, plan), defects: [], diff: { paths: sim.diff ? sim.diff(id!) : pathsOf(id!, plan) } };
    case 'verify': return {
      type: 'VERIFY_DONE', effectId: effect.id, purpose: effect.purpose, fingerprint: FP,
      results: effect.commands.map((row) => {
        const outcome = sim.verify?.(effect.purpose, String(row['command']), id, effect.cwd) ?? defaultVerify(effect.purpose);
        const failed = outcome.failedTests ?? [];
        return { command: String(row['command']), exit: outcome.exit, logPath: `${effect.id}.log`, failedTests: failed, failureId: outcome.exit ? `${row['command']}::${failed[0] ?? 'exit'}` : null, diagnostic: '', baselineHits: outcome.baselineHits ?? [], scanUnreadable: outcome.scanUnreadable ?? [], inputFingerprint: effect.id };
      }),
    };
    case 'checkout': {
      const input = effect.input as Record<string, unknown>;
      const results: Record<string, Record<string, unknown>> = {
        init: { path: 'run/wt/integration', base: 'b0', manifest: { linked: [] } },
        task: { path: `run/wt/${input['name']}`, revision: input['revision'] },
        commit: { revision: `c-${id}`, paths: sim.commitPaths ? sim.commitPaths(id ?? 'T1') : pathsOf(id ?? 'T1', plan) },
        red: { path: `run/wt/${input['name']}`, defects: sim.redDefects?.includes(id ?? '') ? ['checkpoint names an unapproved path'] : [], files: [] },
        'scope-rebase': { path: `run/wt/${input['name']}`, revision: input['revision'], conflict: false, conflicts: [] },
        integrate: sim.conflict?.includes(id ?? '') ? { conflict: true, paths: sim.conflictPaths ?? ['src/shared.ts'], detail: 'both modified' } : { revision: `i-${id}`, conflict: false, paths: [] },
        resolve: sim.resolve ? sim.resolve(input) : { revision: `r-${String(input['attempt'])}`, paths: ['src/shared.ts'] },
        trim: { trimmed: input['allowed'] ?? [], already: [], refused: [] },
        reset: { path: `run/wt/${input['name']}` }, deliver: { conflicts: [], transferred: ['src/a.ts'], already: [], blobs: Object.fromEntries(plan.criteria.flatMap((row) => row.changes).map((file) => [file, `blob-${file}`])) }, cleanup: {},
      };
      return { type: 'CHECKOUT_DONE', effectId: effect.id, op: effect.op, result: results[effect.op] ?? {} };
    }
    default: return null;
  }
}

/** Answers driver effects until the machine awaits the host or emits an effect the simulation leaves to the test. */
export function pump(result: Result, sim: Sim, trace: Trace): Result {
  for (let guard = 0; result.effects.length; guard++) {
    assert.ok(guard < 200, 'driver loop did not settle');
    const effect = result.effects[0]!;
    const event = answer(result.state, effect, sim);
    if (!event) return result;
    trace.effects.push(effect);
    trace.events.push(event);
    result = stepImplement(result.state, event);
  }
  return result;
}

export function host(result: Result, event: Event, sim: Sim, trace: Trace): Result {
  assert.equal(validateImplement(result.state, event as never), null);
  trace.events.push(event);
  return pump(stepImplement(result.state, event), sim, trace);
}

export function classify(result: Result, sim: Sim, trace: Trace): Result {
  if (result.state.tag !== 'level-classification') return result;
  const gateScope = implementData(result.state)['gateScope'];
  return host(result, { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'low', rationale: 'Bounded task with local and recoverable effects.', gateScope } }, sim, trace);
}

export function start(concurrency: number, sim: Sim = {}): { result: Result; trace: Trace } {
  const trace: Trace = { effects: [], events: [] };
  const started = run(concurrency, sim.reviewRounds);
  if (sim.planHash) started.overrides = { ...started.overrides, settledPlan: { path: 'x.plan.md', hash: sim.planHash, outcome: 'settled' } };
  let result = pump(stepImplement(initialImplement(), started), sim, trace);
  assert.equal(result.state.tag, 'approval');
  result = host(result, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } }, sim, trace);
  result = classify(result, sim, trace);
  return { result, trace };
}

export type Slot = { task: string; action: string; handle: string | null; attempt: number; signature: string; model: string; envelopePath: string; worktree: string; briefHash: string };
export type FrameRow = { task: string; action: string; attempt: number; handle: string | null; launchPath: string };
/** Compact tasks-frame rows as the host reads them. */
export const frameRows = (result: Result): FrameRow[] => result.state.tag === 'tasks' ? (implementData(result.state)['tasks'] as FrameRow[]) : [];
/** Each compact row merged with its launch record, so receipts copy launch fields. */
export const slots = (result: Result): Slot[] => frameRows(result).map((row) => ({ ...row, ...launchOf(result.state, row.task) }) as unknown as Slot);
export const record = (result: Result, id: string) => 'c' in result.state && result.state.c ? result.state.c.tasks[id] : undefined;
export const launch = (result: Result, sim: Sim, trace: Trace): Result => {
  for (const slot of slots(result).filter((item) => item.action === 'launch')) result = host(result, { type: 'WRITE_RECEIPT', status: 'launched', task: slot.task, attempt: slot.attempt, signature: slot.signature, handle: `agent-${slot.task}-${slot.attempt}`, model: slot.model }, sim, trace);
  return result;
};
export const submit = (result: Result, id: string, sim: Sim, trace: Trace): Result => {
  const slot = slots(result).find((item) => item.task === id)!;
  return host(result, { type: 'WRITE_RECEIPT', status: 'submitted', task: id, attempt: slot.attempt, signature: slot.signature, handle: slot.handle!, model: slot.model, envelopePath: slot.envelopePath, briefHash: slot.briefHash }, sim, trace);
};
export const launchedTasks = (trace: Trace) => trace.effects.flatMap((effect) => effect.kind === 'checkout' && effect.op === 'task' ? [String(effect.input['name'])] : []);

// SECTION: Scheduling
