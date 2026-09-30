// @ts-check

import type { Await, Effect, Event, HostEvent, Machine, RunStartedEvent, TreeFingerprint, VerifyCommand } from '../core/types.ts';
import { renderWalkthrough } from '../domain/render.ts';
import type { ParsedPlan, PlanCriterion, WalkthroughView } from '../domain/types.ts';
import { generatedCommands, approvedPaths, approvalAnswer, asParsedPlan, commandEffect, commandMappings, criterionEvidenceRows, isFingerprint, isTestPath, isWriterEnvelope, parseRedMatrix, redactOneLine, sameFingerprint, settledPlanInput, writerConfig, type CommandMapping, type EvidenceRecord, type ImplementStage, type RedMatrixRow, type VerifyRecord, type WriterConfig, type WriterEnvelope } from './implement-types.ts';
import { beginReview, isReviewTerminal, resolutionRounds, reviewAwait, reviewData, reviewSpecFromRun, stepReview, validateReview, type ReviewState } from './review.ts';
import { answers, isRecord, never, nextId, stay, type Counters, type Step } from './types.ts';

export const IMPLEMENT_TEMPLATE = 'references/templates/plan.md';
export const MAX_WRITE_ATTEMPTS = 3;

type PlanReviewResult = 'initial' | 'rebind';
type Context = {
  run: RunStartedEvent;
  planPath: string;
  counters: Counters;
  writer: WriterConfig | null;
  writerError: string | null;
  plan: ParsedPlan | null;
  planHash: string | null;
  planReview: ReviewState | null;
  codeReview: ReviewState | null;
  startFingerprint: TreeFingerprint | null;
  lastFingerprint: TreeFingerprint | null;
  mutationEpoch: number;
  criterionMutation: Readonly<Record<string, number>>;
  baseline: readonly VerifyRecord[];
  acceptedBaseline: readonly string[];
  records: Readonly<Record<string, VerifyRecord>>;
  evidence: Readonly<Record<string, EvidenceRecord>>;
  redMatrix: readonly RedMatrixRow[];
  concerns: readonly string[];
  approvedRedExceptions: readonly string[];
  redExceptionRulings: Readonly<Record<string, { decision: 'accept'; by: string; quote: string }>>;
  concernRulings: Readonly<Record<string, { decision: 'accept'; by: string; quote: string }>>;
  redQualityRepairUsed: boolean;
  activeRedWriterModel: string | null;
  attempts: Readonly<Record<ImplementStage, number>>;
  approval: { by: string; quote: string } | null;
  changedPaths: readonly string[];
  finalGate: string;
  failureReason: string | null;
};

type WriteInfo = {
  stage: ImplementStage;
  attempt: number;
  models: readonly string[];
  modelIndex: number;
  briefPath: string;
  briefSha256: string;
  envelopePath: string;
  preFingerprint: TreeFingerprint;
  repair: boolean;
};

export type ImplementState =
  | { tag: 'booting'; counters: Counters }
  | { tag: 'starting'; c: Context; effectId: string; next: 'author' | 'parse' }
  | { tag: 'author'; c: Context; defects: readonly Readonly<Record<string, unknown>>[] }
  | { tag: 'parsing'; c: Context; effectId: string; phase: PlanReviewResult }
  | { tag: 'plan-review'; c: Context; review: ReviewState }
  | { tag: 'baseline-preflight'; c: Context; effectId: string }
  | { tag: 'baseline'; c: Context; effectId: string }
  | { tag: 'baseline-snapshot'; c: Context; effectId: string; results: readonly VerifyRecord[] }
  | { tag: 'baseline-decision'; c: Context; items: readonly VerifyRecord[] }
  | { tag: 'approval'; c: Context }
  | { tag: 'needs-user'; c: Context; ids: readonly string[] }
  | { tag: 'writing-brief'; c: Context; effectId: string; stage: ImplementStage; attempt: number; modelLimit: readonly string[] | null; repair: boolean; admissionDefects: readonly string[] }
  | { tag: 'snapshot-before-write'; c: Context; stage: ImplementStage; attempt: number; models: readonly string[]; repair: boolean; briefPath: string; briefSha256: string; envelopePath: string; effectId: string }
  | { tag: 'write'; c: Context; info: WriteInfo }
  | { tag: 'cascade-snapshot'; c: Context; info: WriteInfo; effectId: string; nextModelIndex: number | null; reason: string }
  | { tag: 'checking-envelope'; c: Context; info: WriteInfo; effectId: string }
  | { tag: 'snapshot-after-write'; c: Context; stage: ImplementStage; info: WriteInfo; envelope: WriterEnvelope; changedPaths: readonly string[]; effectId: string }
  | { tag: 'red-verify'; c: Context; effectId: string; rows: readonly RedMatrixRow[] }
  | { tag: 'scoped-snapshot'; c: Context; effectId: string; changedPaths: readonly string[] }
  | { tag: 'scoped-verify'; c: Context; effectId: string; changedPaths: readonly string[]; before: TreeFingerprint }
  | { tag: 'evidence'; c: Context; purpose: 'scoped' | 'final'; ids: readonly string[]; verify: readonly VerifyRecord[] }
  | { tag: 'concerns'; c: Context; items: readonly string[] }
  | { tag: 'code-review'; c: Context; review: ReviewState }
  | { tag: 'post-review-snapshot'; c: Context; effectId: string }
  | { tag: 'generated-verify'; c: Context; effectId: string; count: number; before: TreeFingerprint }
  | { tag: 'generated-snapshot'; c: Context; effectId: string; before: TreeFingerprint; paths: readonly string[] }
  | { tag: 'final-verify'; c: Context; effectId: string; before: TreeFingerprint }
  | { tag: 'failure-snapshot'; c: Context; effectId: string; reason: string }
  | { tag: 'failure'; c: Context; reason: string; changedPaths: readonly string[] }
  | { tag: 'complete'; c: Context; summary: string }
  | { tag: 'stopped'; c: Context; summary: string }
  | { tag: 'failed'; c: Context | null; summary: string };

type S = Step<ImplementState>;
const emptyCounters: Counters = {};
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function planPathFromRun(run: RunStartedEvent): string {
  const override = run.overrides['path'];
  if (typeof override === 'string' && override.trim()) return override.trim();
  const argument = run.argument.trim();
  if (/\.plan\.md$/i.test(argument)) return argument;
  const settled = settledPlanInput(run.overrides['settledPlan']);
  if (settled) return settled.path;
  const slug = argument.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '') || 'implementation';
  return `${slug}.plan.md`;
}

function diffPaths(event: Event): string[] {
  if (!('diff' in event) || !isRecord(event['diff'])) return [];
  const paths = event['diff']['paths'];
  return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : [];
}

function baseContext(run: RunStartedEvent): Context {
  const planPath = planPathFromRun(run);
  const writer = writerConfig(run.config, run.orchestrator, run.level);
  return {
    run, planPath, counters: {}, writer: writer.ok ? writer.value : null, writerError: writer.ok ? null : writer.error,
    plan: null, planHash: null, planReview: null, codeReview: null, startFingerprint: null, lastFingerprint: null,
    mutationEpoch: 0, criterionMutation: {}, baseline: [], acceptedBaseline: [], records: {}, evidence: {}, redMatrix: [], concerns: [],
    approvedRedExceptions: [], redExceptionRulings: {}, concernRulings: {}, redQualityRepairUsed: false, activeRedWriterModel: null,
    attempts: { 'tests-only': 0, production: 0 }, approval: null, changedPaths: [], finalGate: 'pending', failureReason: null,
  };
}

function effectId(c: Context, kind: Effect['kind']): { c: Context; id: string } {
  const next = nextId(c.counters, 'implement', kind);
  return { c: { ...c, counters: next.counters }, id: next.id };
}

function snapshot(c0: Context, next: 'author' | 'parse'): S {
  const { c, id } = effectId(c0, 'snapshot');
  return { state: { tag: 'starting', c, effectId: id, next }, effects: [{ kind: 'snapshot', id, since: null }] };
}

function parsePlan(c0: Context, phase: PlanReviewResult): S {
  const { c, id } = effectId(c0, 'parse-artifact');
  return { state: { tag: 'parsing', c, effectId: id, phase }, effects: [{ kind: 'parse-artifact', id, path: c.planPath, artifact: 'plan' }] };
}

function authorPlan(c: Context, defects: readonly Readonly<Record<string, unknown>>[] = []): S {
  return stay({ tag: 'author', c, defects });
}

function beginFailure(c0: Context, reason: string): S {
  const { c, id } = effectId(c0, 'snapshot');
  return { state: { tag: 'failure-snapshot', c, effectId: id, reason }, effects: [{ kind: 'snapshot', id, since: c.lastFingerprint }] };
}

function fail(c: Context | null, summary: string): S { return stay({ tag: 'failed', c, summary }); }
function stop(c: Context, summary: string): S { return stay({ tag: 'stopped', c, summary }); }

function reviewCtxCounters(review: ReviewState, fallback: Counters): Counters {
  return 'c' in review ? review.c.counters : fallback;
}

function startReview(c0: Context): S {
  const built = reviewSpecFromRun(c0.run, 'plan', 'fix', c0.planPath);
  if (!built.ok) return beginFailure(c0, built.error);
  const result = beginReview(built.spec, 'implement.plan-review', c0.counters);
  return fromPlanReview(c0, result);
}

function fromPlanReview(c0: Context, result: Step<ReviewState>): S {
  const review = result.state;
  const c = { ...c0, counters: reviewCtxCounters(review, c0.counters), planReview: review };
  switch (review.tag) {
    case 'settled': case 'skipped': return parsePlan(c, 'rebind');
    case 'failed': return beginFailure(c, `plan review failed: ${review.detail}`);
    case 'escalated': case 'empty': return beginFailure(c, `plan review did not settle: ${review.tag}`);
    case 'booting': case 'prepare': case 'wave': case 'native': case 'rule': case 'decide-needs-user': case 'fix': case 'fix-verify':
    case 'decide-escalation': case 'decide-opt-in': return { state: { tag: 'plan-review', c, review }, effects: result.effects };
    default: return never(review, 'plan review state');
  }
}

function beginBaseline(c0: Context): S {
  const { c, id } = effectId(c0, 'snapshot');
  return { state: { tag: 'baseline-preflight', c, effectId: id }, effects: [{ kind: 'snapshot', id, since: c0.lastFingerprint }] };
}

function runBaseline(c0: Context): S {
  const mappings = commandMappings(c0.plan as ParsedPlan);
  const commands = mappings.map((mapping) => commandEffect(mapping.command, mapping, approvedPaths(c0.plan as ParsedPlan), environmentKey(c0)));
  const { c, id } = effectId(c0, 'verify');
  return { state: { tag: 'baseline', c, effectId: id }, effects: [{ kind: 'verify', id, purpose: 'baseline', commands }] };
}

function environmentKey(c: Context): string {
  return JSON.stringify({ platform: c.run.orchestrator, model: c.run.orchestratorModel, level: c.run.level, repo: c.run.repo });
}

function recordsFrom(results: readonly Readonly<Record<string, unknown>>[], c: Context, purpose: 'baseline' | 'red' | 'scoped' | 'final' | 'generated'): VerifyRecord[] | null {
  const rows: VerifyRecord[] = [];
  for (const raw of results) {
    if (!nonEmpty(raw['command']) || typeof raw['exit'] !== 'number' || !nonEmpty(raw['logPath'])) return null;
    const failureId = typeof raw['failureId'] === 'string' ? raw['failureId'] : null;
    const failedTests = Array.isArray(raw['failedTests']) ? raw['failedTests'].filter((item): item is string => typeof item === 'string') : [];
    const status = raw['exit'] === 0 ? 'pass' : purpose === 'baseline' ? 'red' : failureId && c.acceptedBaseline.includes(failureId) ? 'known-red — unchanged' : 'regression';
    rows.push({
      command: raw['command'], exit: raw['exit'], logPath: raw['logPath'], failureId, failedTests,
      diagnostic: typeof raw['diagnostic'] === 'string' ? raw['diagnostic'] : '', loadError: raw['loadError'] === true,
      inputFingerprint: typeof raw['inputFingerprint'] === 'string' ? raw['inputFingerprint'] : '', mutationEpoch: c.mutationEpoch, status,
    });
  }
  return rows;
}

function resultEventRows(event: Extract<Event, { type: 'VERIFY_DONE' }>): Readonly<Record<string, unknown>>[] {
  return event.results.map((result) => result as Readonly<Record<string, unknown>>);
}

function failingBaselineIds(rows: readonly VerifyRecord[]): string[] {
  return [...new Set(rows.flatMap((row) => row.exit === 0 || row.failureId === null ? [] : [row.failureId]))].sort();
}

function afterBaseline(c: Context, results: readonly VerifyRecord[]): S {
  if (!c.startFingerprint) return beginFailure(c, 'Initial repository fingerprint is missing before baseline verification.');
  const { c: next, id } = effectId({ ...c, baseline: results }, 'snapshot');
  return { state: { tag: 'baseline-snapshot', c: next, effectId: id, results }, effects: [{ kind: 'snapshot', id, since: c.startFingerprint }] };
}

function beginApproval(c: Context): S { return stay({ tag: 'approval', c }); }

function redCriteria(c: Context): PlanCriterion[] {
  return (c.plan?.criteria ?? []).filter((criterion) => criterion.evidence === 'red');
}

function activeRedCriteria(c: Context): PlanCriterion[] { return redCriteria(c).filter((criterion) => !criterion.redException); }

function beginPostApproval(c: Context): S {
  const exceptionIds = redCriteria(c).filter((criterion) => criterion.redException).map((criterion) => criterion.id);
  if (exceptionIds.some((id) => !c.approvedRedExceptions.includes(id))) return stay({ tag: 'needs-user', c, ids: exceptionIds.filter((id) => !c.approvedRedExceptions.includes(id)) });
  return activeRedCriteria(c).length ? startWriter(c, 'tests-only', false, null, []) : startWriter(c, 'production', false, null, []);
}

function briefInput(c: Context, stage: ImplementStage, repair: boolean, admissionDefects: readonly string[]): Readonly<Record<string, unknown>> {
  const plan = c.plan as ParsedPlan;
  const selected = stage === 'tests-only' ? activeRedCriteria(c) : plan.criteria;
  const paths = stage === 'tests-only'
    ? [...new Set(selected.flatMap((criterion) => criterion.changes.filter(isTestPath)))].sort()
    : approvedPaths(plan);
  const evidenceFormat = stage === 'tests-only'
    ? 'RED-MATRIX <SC#> | <approved-test-path>:<leaf test> | exit <nonzero> test:<observed failure identifier>'
    : 'CRITERION <SC#> | <one path from that criterion Changes list> | <delivered behavior>';
  const evidence = [
    ...c.baseline.map((row) => `BASELINE ${row.command} | ${row.status} | ${row.failureId ?? row.logPath}`),
    ...Object.values(c.evidence).map((row) => `EVIDENCE ${row.id} | ${String(row['outcome'] ?? 'recorded')} | ${String(row['evidence'] ?? '')}`),
  ];
  return {
    planPath: c.planPath, planHash: c.planHash,
    governingOutcome: { title: plan.title, outcome: plan.box['TL;DR'] ?? plan.title ?? c.planPath },
    settledScope: { paths, approvedPaths: stage === 'production' ? approvedPaths(plan) : paths, changes: stage === 'production' ? plan.changes : plan.changes.filter((change) => paths.includes(change.path)) },
    criteria: selected.map((criterion) => ({ id: criterion.id, title: criterion.title, changes: criterion.changes, verify: criterion.verify, evidence: criterion.evidence, preExisting: criterion.preExisting, redException: criterion.redException, testRationale: criterion.testRationale })),
    envelopeSchema: {
      schemaVersion: 1, stage: stage === 'tests-only' ? 'RED_READY' : 'COMPLETE',
      status: ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'], summary: 'non-empty string',
      evidence: evidenceFormat, concerns: 'required non-empty string array only for DONE_WITH_CONCERNS',
      missingContext: 'required non-empty string array only for NEEDS_CONTEXT', blockers: 'required non-empty string array only for BLOCKED',
      files: 'optional array of { path, note }; each path must be approved and each note a short clause',
    },
    existingRedMatrix: stage === 'tests-only' && repair ? c.redMatrix : undefined,
    rules: { keyDecisions: plan.keyDecisions, repository: c.run.repo, approval: c.approval, writerStage: stage, testsOnly: stage === 'tests-only' },
    priorFindings: c.planReview && 'c' in c.planReview ? resolutionRounds(c.planReview.c) : [],
    evidence: stage === 'tests-only' ? [] : evidence,
    admissionDefects: repair ? admissionDefects : undefined,
    selfCheck: typeof c.run.overrides['selfCheckCommand'] === 'string' ? c.run.overrides['selfCheckCommand'] : 'dispatch --check-envelope <Expected Envelope Path>',
  };
}

function startWriter(c0: Context, stage: ImplementStage, repair: boolean, modelLimit: readonly string[] | null, admissionDefects: readonly string[]): S {
  if (!c0.plan || !c0.planHash) return beginFailure(c0, 'Cannot start a write stage before the governed plan is bound.');
  if (!c0.writer) return beginFailure(c0, c0.writerError ?? 'Implementation writer model is not configured.');
  const attempt = c0.attempts[stage] + 1;
  if (attempt > MAX_WRITE_ATTEMPTS) return beginFailure(c0, `${stage} writer exhausted the ${MAX_WRITE_ATTEMPTS}-attempt limit.`);
  const nextAttempts = { ...c0.attempts, [stage]: attempt };
  const c = { ...c0, attempts: nextAttempts };
  const { c: withId, id } = effectId(c, 'write-brief');
  const effect: Effect = { kind: 'write-brief', id, stage, input: briefInput(c, stage, repair, admissionDefects) };
  return { state: { tag: 'writing-brief', c: withId, effectId: id, stage, attempt, modelLimit, repair, admissionDefects }, effects: [effect] };
}

function snapshotBeforeWrite(state: Extract<ImplementState, { tag: 'writing-brief' }>, event: Extract<Event, { type: 'BRIEF_READY' }>): S {
  if (event.stage !== state.stage || !nonEmpty(event.path) || !/^sha256:[a-f0-9]{64}$/.test(event.sha256) || !nonEmpty(event.envelopePath)) {
    return beginFailure(state.c, 'write-brief returned a mismatched stage, invalid hash, or missing envelope path.');
  }
  const models = state.modelLimit ?? state.c.writer?.models ?? [];
  if (!models.length) return beginFailure(state.c, state.c.writerError ?? 'Implementation writer has no configured model.');
  const { c, id } = effectId(state.c, 'snapshot');
  return { state: { tag: 'snapshot-before-write', c, stage: state.stage, attempt: state.attempt, models, repair: state.repair, briefPath: event.path, briefSha256: event.sha256, envelopePath: event.envelopePath, effectId: id }, effects: [{ kind: 'snapshot', id, since: state.c.lastFingerprint }] };
}

function markMutation(c: Context, paths: readonly string[]): Context {
  const epoch = c.mutationEpoch + 1;
  const criteria = c.plan?.criteria ?? [];
  const criterionMutation = { ...c.criterionMutation };
  for (const criterion of criteria) if (!paths.length || criterion.changes.some((file) => paths.includes(file))) criterionMutation[criterion.id] = epoch;
  return { ...c, mutationEpoch: epoch, criterionMutation };
}

function beginVerify(c0: Context, purpose: 'red' | 'scoped' | 'final' | 'generated', commands: readonly { command: string; mapping?: CommandMapping | null; reuse?: VerifyRecord | null }[]): { c: Context; id: string; effect: Effect } {
  const mappings = commandMappings(c0.plan as ParsedPlan);
  const prepared: VerifyCommand[] = commands.map((item) => {
    const mapping = item.mapping ?? mappings.find((row) => row.command === item.command) ?? null;
    const command = commandEffect(item.command, mapping, approvedPaths(c0.plan as ParsedPlan), environmentKey(c0));
    return { ...command, planHash: c0.planHash, ...(item.reuse && item.reuse.exit === 0 && item.reuse.mutationEpoch === c0.mutationEpoch ? { reuse: { inputFingerprint: item.reuse.inputFingerprint, exit: item.reuse.exit, logPath: item.reuse.logPath } } : {}) };
  });
  const { c, id } = effectId(c0, 'verify');
  return { c, id, effect: { kind: 'verify', id, purpose, commands: prepared } };
}

function startRedVerify(c0: Context, rows: readonly RedMatrixRow[]): S {
  const plan = c0.plan as ParsedPlan;
  const criteria = activeRedCriteria(c0);
  const mappings = commandMappings(plan);
  const commands = new Map<string, { command: string; mapping: CommandMapping | null }>();
  for (const criterion of criteria) {
    const paths = [...new Set(rows.filter((row) => row.id === criterion.id).map((row) => row.path))];
    for (const verify of criterion.verify) {
      const mapping = mappings.find((entry) => entry.command === verify.command) ?? null;
      if (!mapping) return beginFailure(c0, `RED command ${verify.command} has no criterion mapping.`);
      const narrowed = narrowToTests(verify.command, paths);
      if (!narrowed) return beginFailure(c0, `RED command cannot be narrowed safely to ${paths.join(', ')}: ${verify.command}`);
      commands.set(narrowed, { command: narrowed, mapping });
    }
  }
  const batch = beginVerify(c0, 'red', [...commands.values()]);
  return { state: { tag: 'red-verify', c: batch.c, effectId: batch.id, rows }, effects: [batch.effect] };
}

function quoteArg(value: string): string { return `"${value.replace(/"/g, '\\"')}"`; }

function narrowToTests(command: string, paths: readonly string[]): string | null {
  if (!paths.length || /[;&|<>`$\r\n]/.test(command) || paths.some((file) => /["`$%\r\n]/.test(file))) return null;
  const tokenPattern = /--[a-z-]+=(?:"[^"\n]*"|'[^'\n]*')|"[^"\n]*"|'[^'\n]*'|[^\s"']+/g;
  const tokens: string[] = command.match(tokenPattern) ?? [];
  if (command.replace(tokenPattern, '').trim()) return null;
  if (!/^node(?:\.exe)?$/i.test(tokens[0] ?? '') || !tokens.includes('--test')) return null;
  const kept = [tokens[0] as string];
  const valued = new Set(['--import', '--require', '-r', '--loader', '--test-reporter', '--test-reporter-destination', '--test-name-pattern', '--test-concurrency', '--test-shard', '--test-timeout', '--conditions']);
  const boolean = new Set(['--test', '--test-only', '--test-force-exit', '--experimental-strip-types', '--no-warnings']);
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index] as string;
    if (token === '--') { kept.push(token); break; }
    if (valued.has(token)) {
      const value = tokens[++index];
      if (!value || value.startsWith('-')) return null;
      kept.push(token, value);
    } else if (boolean.has(token) || /^--[a-z-]+=/.test(token)) kept.push(token);
    else if (token.startsWith('-')) return null;
  }
  return `${kept.join(' ')} ${paths.map(quoteArg).join(' ')}`;
}

function redQuality(c: Context, reason: string): S {
  if (c.attempts['tests-only'] < MAX_WRITE_ATTEMPTS && !c.redQualityRepairUsed && c.activeRedWriterModel) {
    return startWriter({ ...c, redQualityRepairUsed: true }, 'tests-only', true, [c.activeRedWriterModel], [reason]);
  }
  return beginFailure(c, reason);
}

function actualRedDefects(c: Context, rows: readonly RedMatrixRow[], records: readonly VerifyRecord[]): string[] {
  const defects: string[] = [];
  const criteria = activeRedCriteria(c);
  for (const row of rows) {
    const criterion = criteria.find((item) => item.id === row.id);
    const commands = criterion?.verify.map((item) => narrowToTests(item.command, [row.path])).filter((command): command is string => command !== null) ?? [];
    const results = records.filter((record) => commands.includes(record.command));
    if (!results.length) defects.push(`${row.id} has no RED verification result.`);
    if (results.some((record) => record.exit !== 0 && record.loadError)) defects.push(`${row.id} RED run contains a load, syntax, or missing-file error.`);
    const observed = new Set(results.flatMap((record) => record.failedTests));
    if (!row.tests.every((identifier) => observed.has(identifier))) defects.push(`${row.id} expected failures were not observed: ${row.tests.filter((identifier) => !observed.has(identifier)).join(', ')}.`);
    if (!results.some((record) => record.exit !== 0 && record.failedTests.some((identifier) => identifier.startsWith('test:')))) defects.push(`${row.id} did not produce a discriminating asserted test failure.`);
    const baselineCommands = criterion?.verify.map((item) => item.command) ?? [];
    const baseline = c.baseline.filter((record) => baselineCommands.includes(record.command) && record.exit !== 0);
    const redFailures = results.filter((record) => record.exit !== 0 && record.failureId !== null);
    if (baseline.length && redFailures.length && redFailures.some((red) => baseline.some((prior) => prior.failedTests.some((identifier) => red.failedTests.includes(identifier)))) && criterion?.preExisting !== true) {
      defects.push(`${row.id} collides with a pre-existing baseline failure; declare Pre-existing: yes only when this is the intended signal.`);
    }
  }
  return defects;
}

function scopedMappings(c: Context, changedPaths: readonly string[]): CommandMapping[] {
  const plan = c.plan as ParsedPlan;
  return commandMappings(plan).filter((mapping) => !mapping.final && mapping.criteria.some((id) => {
    const criterion = plan.criteria.find((entry) => entry.id === id);
    return Boolean(criterion && (changedPaths.length === 0 || criterion.changes.some((file) => changedPaths.includes(file))));
  }));
}

function scopedSnapshot(c: Context, changedPaths: readonly string[]): S {
  if (!scopedMappings(c, changedPaths).length) return askEvidence(c, 'scoped', changedPaths, []);
  const { c: next, id } = effectId(c, 'snapshot');
  return { state: { tag: 'scoped-snapshot', c: next, effectId: id, changedPaths }, effects: [{ kind: 'snapshot', id, since: c.lastFingerprint }] };
}

function scopedVerify(c0: Context, changedPaths: readonly string[], before: TreeFingerprint): S {
  const mappings = scopedMappings(c0, changedPaths);
  const batch = beginVerify(c0, 'scoped', mappings.map((mapping) => ({ command: mapping.command, mapping })));
  return { state: { tag: 'scoped-verify', c: batch.c, effectId: batch.id, changedPaths, before }, effects: [batch.effect] };
}

function askEvidence(c0: Context, purpose: 'scoped' | 'final', changedPaths: readonly string[], verify: readonly VerifyRecord[]): S {
  const plan = c0.plan as ParsedPlan;
  let ids: string[];
  if (purpose === 'scoped') {
    const touched = new Set(plan.criteria.filter((criterion) => changedPaths.length === 0 || criterion.changes.some((file) => changedPaths.includes(file))).map((criterion) => criterion.id));
    const covered = new Set(verify.flatMap((row) => commandMappings(plan).find((mapping) => mapping.command === row.command)?.criteria ?? []));
    ids = plan.criteria.filter((criterion) => criterion.evidence === 'verify' && touched.has(criterion.id) && covered.has(criterion.id)).map((criterion) => criterion.id);
  } else {
    ids = plan.criteria.filter((criterion) => {
      const evidence = c0.evidence[criterion.id];
      const requiredEpoch = c0.criterionMutation[criterion.id] ?? 0;
      return !evidence || evidence.planHash !== c0.planHash || evidence.mutationEpoch < requiredEpoch;
    }).map((criterion) => criterion.id);
  }
  if (!ids.length) return purpose === 'scoped' ? continueAfterScopedEvidence(c0, verify) : finishEvidence(c0, verify);
  return stay({ tag: 'evidence', c: c0, purpose, ids, verify });
}

function continueAfterScopedEvidence(c: Context, _verify: readonly VerifyRecord[]): S {
  return c.concerns.length ? stay({ tag: 'concerns', c, items: c.concerns }) : startCodeReview(c);
}

function startCodeReview(c0: Context): S {
  const built = reviewSpecFromRun(c0.run, 'code', 'fix', '');
  if (!built.ok) return beginFailure(c0, built.error);
  const result = beginReview(built.spec, 'implement.code-review', c0.counters);
  return fromCodeReview(c0, result);
}

function fromCodeReview(c0: Context, result: Step<ReviewState>): S {
  const review = result.state;
  const c = { ...c0, counters: reviewCtxCounters(review, c0.counters), codeReview: review };
  switch (review.tag) {
    case 'settled': case 'skipped': case 'empty': return startGeneratedOrFinal(c);
    case 'failed': return beginFailure(c, `code review failed: ${review.detail}`);
    case 'escalated': return beginFailure(c, `code review did not settle: ${review.tag}`);
    case 'booting': case 'prepare': case 'wave': case 'native': case 'rule': case 'decide-needs-user': case 'fix': case 'fix-verify':
    case 'decide-escalation': case 'decide-opt-in': return { state: { tag: 'code-review', c, review }, effects: result.effects };
    default: return never(review, 'code review state');
  }
}

function startGeneratedOrFinal(c0: Context): S {
  const { c, id } = effectId(c0, 'snapshot');
  return { state: { tag: 'post-review-snapshot', c, effectId: id }, effects: [{ kind: 'snapshot', id, since: c0.lastFingerprint }] };
}

function runGeneratedOrFinal(c0: Context): S {
  const generated = generatedCommands(c0.plan as ParsedPlan);
  if (!generated.length) return startFinalVerify(c0);
  const batch = beginVerify(c0, 'generated', generated.map((item) => ({ command: item.command, mapping: null })));
  const before = c0.lastFingerprint;
  if (!before) return beginFailure(c0, 'No tree fingerprint is available before generated verification.');
  return { state: { tag: 'generated-verify', c: batch.c, effectId: batch.id, count: generated.length, before }, effects: [batch.effect] };
}

function startFinalVerify(c0: Context): S {
  const mappings = commandMappings(c0.plan as ParsedPlan);
  const batch = beginVerify(c0, 'final', mappings.map((mapping) => ({ command: mapping.command, mapping, reuse: c0.records[mapping.command] ?? null })));
  const before = c0.lastFingerprint;
  if (!before) return beginFailure(c0, 'No tree fingerprint is available before final verification.');
  return { state: { tag: 'final-verify', c: batch.c, effectId: batch.id, before }, effects: [batch.effect] };
}

function finishEvidence(c: Context, verify: readonly VerifyRecord[]): S {
  const plan = c.plan as ParsedPlan;
  const stale = plan.criteria.filter((criterion) => {
    const item = c.evidence[criterion.id];
    return !item || item.planHash !== c.planHash || item.mutationEpoch < (c.criterionMutation[criterion.id] ?? 0);
  });
  if (stale.length) return stay({ tag: 'evidence', c, purpose: 'final', ids: stale.map((criterion) => criterion.id), verify });
  const summary = `${plan.criteria.length}/${plan.criteria.length} criteria evidenced; ${Object.keys(c.records).filter((key) => !key.startsWith('__')).length} verification records current.`;
  return stay({ tag: 'complete', c, summary });
}

function recordEvidence(c: Context, ids: readonly string[], values: Readonly<Record<string, unknown>>): Context | null {
  if (Object.keys(values).length !== ids.length || ids.some((id) => !Object.prototype.hasOwnProperty.call(values, id))) return null;
  const evidence = { ...c.evidence };
  for (const id of ids) {
    const value = values[id];
    if (!isRecord(value) || !nonEmpty(value['outcome']) || !nonEmpty(value['evidence'])) return null;
    evidence[id] = { ...value, id, planHash: c.planHash ?? '', mutationEpoch: c.mutationEpoch, source: c.plan?.criteria.find((criterion) => criterion.id === id)?.evidence ?? 'verify' } as EvidenceRecord;
  }
  return { ...c, evidence };
}

function completeVerification(c0: Context, results: readonly VerifyRecord[]): S {
  return askEvidence(c0, 'final', c0.changedPaths, results);
}

function needsUserRuling(c: Context, ids: readonly string[], answer: unknown): { decision: 'accept' | 'stop'; by: string; quote: string } | null {
  if (!isRecord(answer) || !['accept', 'stop'].includes(String(answer['decision'])) || !nonEmpty(answer['by']) || !nonEmpty(answer['quote'])) return null;
  if (!ids.length) return null;
  return { decision: answer['decision'] as 'accept' | 'stop', by: answer['by'].trim(), quote: answer['quote'].trim() };
}

function startFailureFromEffect(c: Context, cls: string, detail: string): S {
  return beginFailure(c, `${cls}: ${detail}`);
}

export function initialImplement(): ImplementState { return { tag: 'booting', counters: emptyCounters }; }

export function stepImplement(state: ImplementState, event: Event): S {
  switch (state.tag) {
    case 'booting': {
      if (event.type !== 'RUN_STARTED' || event.verb !== 'implement') return stay(state);
      const c = baseContext(event);
      const candidate = /\.plan\.md$/i.test(c.planPath) || settledPlanInput(event.overrides['settledPlan']) !== null;
      return snapshot(c, candidate ? 'parse' : 'author');
    }
    case 'starting': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return fail(state.c, `initial snapshot failed: ${event.cls}: ${event.detail}`);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      const c = { ...state.c, startFingerprint: event.fingerprint, lastFingerprint: event.fingerprint };
      return state.next === 'parse' ? parsePlan(c, 'initial') : authorPlan(c);
    }
    case 'author': {
      if (event.type !== 'AUTHORED' || event.path !== state.c.planPath) return stay(state);
      return parsePlan(state.c, 'initial');
    }
    case 'parsing': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) {
        if (state.phase === 'initial' && /not found/i.test(event.detail)) return authorPlan(state.c);
        return startFailureFromEffect(state.c, event.cls, event.detail);
      }
      if (event.type !== 'ARTIFACT_PARSED' || !answers(event, state.effectId) || event.kind !== 'plan') return stay(state);
      if (event.defects.length) return authorPlan(state.c, event.defects as readonly Readonly<Record<string, unknown>>[]);
      const plan = asParsedPlan(event.parsed);
      if (!plan || !/^sha256:[a-f0-9]{64}$/.test(event.hash)) return beginFailure(state.c, 'Plan parser returned an invalid payload or governed hash.');
      const c = { ...state.c, plan, planHash: event.hash, planPath: state.c.planPath };
      const settled = settledPlanInput(state.c.run.overrides['settledPlan']);
      if (state.phase === 'initial' && settled && settled.path === c.planPath && settled.hash === event.hash) return beginBaseline(c);
      if (state.phase === 'rebind') return beginBaseline(c);
      return startReview(c);
    }
    case 'baseline-preflight': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      return runBaseline({ ...state.c, startFingerprint: event.fingerprint, lastFingerprint: event.fingerprint });
    }
    case 'plan-review': {
      if (event.type === 'FIXES_APPLIED') {
        const c = markMutation(state.c, []);
        return fromPlanReview(c, stepReview(state.review, event));
      }
      return fromPlanReview(state.c, stepReview(state.review, event));
    }
    case 'baseline': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'VERIFY_DONE' || !answers(event, state.effectId) || event.purpose !== 'baseline' || !isFingerprint(event.fingerprint)) return stay(state);
      const rows = recordsFrom(resultEventRows(event), state.c, 'baseline');
      if (!rows) return beginFailure(state.c, 'Baseline verification returned malformed command results.');
      return afterBaseline({ ...state.c, lastFingerprint: event.fingerprint }, rows);
    }
    case 'baseline-snapshot': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return fail(state.c, `baseline snapshot failed: ${event.cls}: ${event.detail}`);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      if (!state.c.startFingerprint || !sameFingerprint(event.fingerprint, state.c.startFingerprint)) return beginFailure({ ...state.c, lastFingerprint: event.fingerprint }, `Baseline commands changed the repository: ${diffPaths(event).join(', ') || 'fingerprint changed'}.`);
      const c = { ...state.c, lastFingerprint: event.fingerprint };
      const failures = failingBaselineIds(state.results);
      return failures.length ? stay({ tag: 'baseline-decision', c, items: state.results.filter((row) => row.exit !== 0) }) : beginApproval(c);
    }
    case 'baseline-decision': {
      if (event.type !== 'DECISION' || event.kind !== 'baseline') return stay(state);
      if (event.answer === 'stop') return stop(state.c, 'User stopped after baseline failures; repository work is preserved.');
      const available = failingBaselineIds(state.items);
      if (!isRecord(event.answer) || event.answer['action'] !== 'accept-known-red' || !Array.isArray(event.answer['ids'])) return stay(state);
      const ids = event.answer['ids'];
      if (ids.length !== available.length || new Set(ids).size !== ids.length || available.some((id) => !ids.includes(id))) return stay(state);
      return beginApproval({ ...state.c, acceptedBaseline: available });
    }
    case 'approval': {
      if (event.type !== 'DECISION' || event.kind !== 'approval') return stay(state);
      if (event.answer === 'stop') return stop(state.c, 'User declined implementation approval; repository work is preserved.');
      const approval = approvalAnswer(event.answer);
      return approval ? beginPostApproval({ ...state.c, approval }) : stay(state);
    }
    case 'needs-user': {
      if (event.type !== 'DECISION' || event.kind !== 'needs-user') return stay(state);
      const ruling = needsUserRuling(state.c, state.ids, event.answer);
      if (!ruling) return stay(state);
      if (ruling.decision === 'stop') return stop(state.c, `User stopped at RED exception ruling for ${state.ids.join(', ')}.`);
      const redExceptionRulings = { ...state.c.redExceptionRulings, ...Object.fromEntries(state.ids.map((id) => [id, { decision: 'accept' as const, by: ruling.by, quote: ruling.quote }])) };
      const c = { ...state.c, redExceptionRulings, approvedRedExceptions: [...new Set([...state.c.approvedRedExceptions, ...state.ids])] };
      return activeRedCriteria(c).length ? startWriter(c, 'tests-only', false, null, []) : startWriter(c, 'production', false, null, []);
    }
    case 'writing-brief': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'BRIEF_READY' || !answers(event, state.effectId)) return stay(state);
      return snapshotBeforeWrite(state, event);
    }
    case 'snapshot-before-write': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      if (state.c.lastFingerprint && !sameFingerprint(event.fingerprint, state.c.lastFingerprint)) return beginFailure({ ...state.c, lastFingerprint: event.fingerprint }, `Repository changed before ${state.stage} writer launch: ${diffPaths(event).join(', ') || 'fingerprint changed'}.`);
      const c = { ...state.c, lastFingerprint: event.fingerprint };
      const info: WriteInfo = { stage: state.stage, attempt: state.attempt, models: state.models, modelIndex: 0, briefPath: state.briefPath, briefSha256: state.briefSha256, envelopePath: state.envelopePath, preFingerprint: event.fingerprint, repair: state.repair };
      return stay({ tag: 'write', c, info });
    }
    case 'write': {
      if (event.type === 'WRITE_ENVELOPE') {
        if (event.envelopePath !== state.info.envelopePath) return stay(state);
        const { c, id } = effectId(state.c, 'check-envelope');
        const effect = { kind: 'check-envelope' as const, id, envelopePath: state.info.envelopePath, permitted: state.info.stage === 'tests-only' ? redTestPaths(state.c) : approvedPaths(state.c.plan as ParsedPlan), since: state.info.preFingerprint };
        return { state: { tag: 'checking-envelope', c, info: state.info, effectId: id }, effects: [effect] };
      }
      if (event.type === 'WRITE_FAILED') {
        const model = state.info.models[state.info.modelIndex];
        if (!model || event.model !== model) return stay(state);
        const terminal = event.kind === 'sandbox-unsupported' || event.kind === 'integrity';
        const nextModelIndex = terminal || state.info.modelIndex + 1 >= state.info.models.length ? null : state.info.modelIndex + 1;
        const { c, id } = effectId(state.c, 'snapshot');
        return { state: { tag: 'cascade-snapshot', c, info: state.info, effectId: id, nextModelIndex, reason: `${event.model}: ${event.kind}: ${event.reason}` }, effects: [{ kind: 'snapshot', id, since: state.info.preFingerprint }] };
      }
      return stay(state);
    }
    case 'cascade-snapshot': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return beginFailure(state.c, `writer-failure snapshot failed: ${event.cls}: ${event.detail}`);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      if (!sameFingerprint(event.fingerprint, state.info.preFingerprint) || diffPaths(event).length) return beginFailure({ ...state.c, lastFingerprint: event.fingerprint }, `Writer changed the repository before failing; stopped the cascade. ${diffPaths(event).join(', ')}`);
      if (state.nextModelIndex === null) return beginFailure({ ...state.c, lastFingerprint: event.fingerprint }, `Writer cascade exhausted or reached a terminal failure: ${state.reason}`);
      return stay({ tag: 'write', c: { ...state.c, lastFingerprint: event.fingerprint }, info: { ...state.info, modelIndex: state.nextModelIndex, preFingerprint: event.fingerprint } });
    }
    case 'checking-envelope': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return beginFailure(state.c, `envelope check failed: ${event.cls}: ${event.detail}`);
      if (event.type !== 'ENVELOPE_CHECKED' || !answers(event, state.effectId)) return stay(state);
      const envelope = event.envelope;
      if (event.defects.length || !isWriterEnvelope(envelope)) return beginFailure(state.c, `Envelope rejected: ${event.defects.join('; ') || 'malformed envelope.'}`);
      const permitted = state.info.stage === 'tests-only' ? redTestPaths(state.c) : approvedPaths(state.c.plan as ParsedPlan);
      const reportedOutside = diffPaths(event).filter((file) => !permitted.includes(file));
      if (reportedOutside.length) return beginFailure(state.c, `Accepted writer changed out-of-scope paths: ${reportedOutside.join(', ')}.`);
      const expectedStage = state.info.stage === 'tests-only' ? 'RED_READY' : 'COMPLETE';
      if (envelope.stage !== expectedStage) return beginFailure(state.c, `Envelope stage must be ${expectedStage}; got ${envelope.stage}.`);
      if (envelope.status === 'NEEDS_CONTEXT' || envelope.status === 'BLOCKED') return beginFailure(state.c, `Writer returned ${envelope.status}: ${envelope.summary}`);
      const writerContext = state.info.stage === 'tests-only' ? { ...state.c, activeRedWriterModel: state.info.models[state.info.modelIndex] ?? null } : state.c;
      if (state.info.stage === 'production') {
        const missing = criterionEvidenceRows(envelope.evidence, (writerContext.plan as ParsedPlan).criteria);
        if (missing.length) return beginFailure(state.c, `Production evidence is missing criterion rows for ${missing.join(', ')}.`);
      }
      let c: Context = { ...writerContext, concerns: [...new Set([...writerContext.concerns, ...(envelope.status === 'DONE_WITH_CONCERNS' ? envelope.concerns ?? [] : [])])] };
      let redMatrix = c.redMatrix;
      if (state.info.stage === 'tests-only') {
        const admission = parseRedMatrix(envelope.evidence, activeRedCriteria(c));
        if (admission.defects.length) {
          if (!c.redQualityRepairUsed) {
            c = { ...c, redQualityRepairUsed: true };
            c = { ...c, redMatrix: admission.rows };
            return startWriter(c, 'tests-only', true, [state.info.models[state.info.modelIndex] as string], admission.defects);
          }
          return beginFailure(c, `RED matrix rejected after the bounded repair: ${admission.defects.join('; ')}`);
        }
        redMatrix = admission.rows;
      }
      c = markMutation({ ...c, redMatrix, changedPaths: diffPaths(event) }, diffPaths(event));
      const { c: next, id } = effectId(c, 'snapshot');
      return { state: { tag: 'snapshot-after-write', c: next, stage: state.info.stage, info: state.info, envelope, changedPaths: diffPaths(event), effectId: id }, effects: [{ kind: 'snapshot', id, since: state.info.preFingerprint }] };
    }
    case 'snapshot-after-write': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return beginFailure(state.c, `post-write snapshot failed: ${event.cls}: ${event.detail}`);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      const allowed = state.stage === 'tests-only' ? redTestPaths(state.c) : approvedPaths(state.c.plan as ParsedPlan);
      const changed = diffPaths(event);
      const outside = changed.filter((file) => !allowed.includes(file));
      if (outside.length) return beginFailure({ ...state.c, lastFingerprint: event.fingerprint }, `Accepted writer changed out-of-scope paths: ${outside.join(', ')}.`);
      const c = { ...state.c, lastFingerprint: event.fingerprint, changedPaths: state.changedPaths };
      return state.stage === 'tests-only' ? startRedVerify(c, c.redMatrix) : scopedSnapshot(c, state.changedPaths);
    }
    case 'red-verify': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'VERIFY_DONE' || !answers(event, state.effectId) || event.purpose !== 'red' || !isFingerprint(event.fingerprint)) return stay(state);
      const rows = recordsFrom(resultEventRows(event), state.c, 'red');
      if (!rows) return beginFailure(state.c, 'RED verification returned malformed command results.');
      if (state.c.lastFingerprint && !sameFingerprint(event.fingerprint, state.c.lastFingerprint)) return beginFailure({ ...state.c, lastFingerprint: event.fingerprint }, 'RED verification changed the repository.');
      const defects = actualRedDefects(state.c, state.rows, rows);
      if (defects.length) {
        if (!state.c.redQualityRepairUsed) return redQuality(state.c, defects.join('; '));
        return beginFailure(state.c, `RED verification still fails after quality repair: ${defects.join('; ')}`);
      }
      const records = { ...state.c.records, ...Object.fromEntries(rows.map((row) => [row.command, row])) };
      return startWriter({ ...state.c, records, lastFingerprint: event.fingerprint }, 'production', false, null, []);
    }
    case 'scoped-snapshot': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      if (state.c.lastFingerprint && !sameFingerprint(event.fingerprint, state.c.lastFingerprint)) return beginFailure({ ...state.c, lastFingerprint: event.fingerprint }, `Repository changed before scoped verification: ${diffPaths(event).join(', ') || 'fingerprint changed'}.`);
      return scopedVerify({ ...state.c, lastFingerprint: event.fingerprint }, state.changedPaths, event.fingerprint);
    }
    case 'scoped-verify': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'VERIFY_DONE' || !answers(event, state.effectId) || event.purpose !== 'scoped' || !isFingerprint(event.fingerprint)) return stay(state);
      const rows = recordsFrom(resultEventRows(event), state.c, 'scoped');
      if (!rows) return beginFailure(state.c, 'Scoped verification returned malformed command results.');
      if (!sameFingerprint(event.fingerprint, state.before)) return beginFailure({ ...state.c, lastFingerprint: event.fingerprint }, 'Scoped verification changed the repository; evidence is stale.');
      const regression = rows.filter((row) => row.status === 'regression');
      if (regression.length) return beginFailure({ ...state.c, lastFingerprint: event.fingerprint }, `Scoped verification failed: ${regression.map((row) => `${row.command} (${row.failureId ?? row.logPath})`).join('; ')}`);
      const c = { ...state.c, lastFingerprint: event.fingerprint, records: { ...state.c.records, ...Object.fromEntries(rows.map((row) => [row.command, row])) } };
      return askEvidence(c, 'scoped', state.changedPaths, rows);
    }
    case 'evidence': {
      if (event.type !== 'EVIDENCE') return stay(state);
      const c = recordEvidence(state.c, state.ids, event.criteria);
      if (!c) return stay(state);
      if (state.purpose === 'scoped') return continueAfterScopedEvidence(c, state.verify);
      return finishEvidence(c, state.verify);
    }
    case 'concerns': {
      if (event.type !== 'DECISION' || event.kind !== 'concerns') return stay(state);
      const ruling = needsUserRuling(state.c, state.items, event.answer);
      if (!ruling) return stay(state);
      if (ruling.decision === 'stop') return stop(state.c, `User stopped with unresolved implementation concerns: ${state.items.join('; ')}`);
      const concernRulings = { ...state.c.concernRulings, ...Object.fromEntries(state.items.map((item) => [item, { decision: 'accept' as const, by: ruling.by, quote: ruling.quote }])) };
      return startCodeReview({ ...state.c, concernRulings });
    }
    case 'code-review': {
      const c = event.type === 'FIXES_APPLIED' ? markMutation(state.c, reviewPaths(event)) : state.c;
      return fromCodeReview(c, stepReview(state.review, event));
    }
    case 'post-review-snapshot': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      return runGeneratedOrFinal({ ...state.c, lastFingerprint: event.fingerprint });
    }
    case 'generated-verify': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'VERIFY_DONE' || !answers(event, state.effectId) || event.purpose !== 'generated' || !isFingerprint(event.fingerprint)) return stay(state);
      const rows = recordsFrom(resultEventRows(event), state.c, 'generated');
      if (!rows || rows.some((row) => row.exit !== 0)) return beginFailure(state.c, `Generated command failed: ${rows?.filter((row) => row.exit !== 0).map((row) => `${row.command} (${row.logPath})`).join('; ') ?? 'invalid results'}`);
      const paths = generatedCommands(state.c.plan as ParsedPlan).map((item) => item.path);
      const { c, id } = effectId({ ...state.c, lastFingerprint: event.fingerprint }, 'snapshot');
      return { state: { tag: 'generated-snapshot', c, effectId: id, before: state.before, paths }, effects: [{ kind: 'snapshot', id, since: state.before }] };
    }
    case 'generated-snapshot': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId) || !isFingerprint(event.fingerprint)) return stay(state);
      const changed = diffPaths(event);
      const outside = changed.filter((file) => !state.paths.includes(file));
      if (outside.length) return beginFailure({ ...state.c, lastFingerprint: event.fingerprint }, `Generated verification changed out-of-scope paths: ${outside.join(', ')}.`);
      if (!sameFingerprint(event.fingerprint, state.before) && !changed.length) return beginFailure({ ...state.c, lastFingerprint: event.fingerprint }, 'Generated verification changed the repository without attributable paths.');
      const c = sameFingerprint(event.fingerprint, state.before) ? { ...state.c, lastFingerprint: event.fingerprint } : markMutation({ ...state.c, lastFingerprint: event.fingerprint }, changed);
      return startFinalVerify(c);
    }
    case 'final-verify': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return startFailureFromEffect(state.c, event.cls, event.detail);
      if (event.type !== 'VERIFY_DONE' || !answers(event, state.effectId) || event.purpose !== 'final' || !isFingerprint(event.fingerprint)) return stay(state);
      const rows = recordsFrom(resultEventRows(event), state.c, 'final');
      if (!rows) return beginFailure(state.c, 'Final verification returned malformed command results.');
      if (!sameFingerprint(event.fingerprint, state.before)) return beginFailure({ ...state.c, lastFingerprint: event.fingerprint }, 'Final verification changed the repository; evidence is stale.');
      const regression = rows.filter((row) => row.status === 'regression');
      if (regression.length) return beginFailure({ ...state.c, lastFingerprint: event.fingerprint }, `Final verification failed: ${regression.map((row) => `${row.command} (${row.failureId ?? row.logPath})`).join('; ')}`);
      const records = { ...state.c.records, ...Object.fromEntries(rows.map((row) => [row.command, row])) };
      const c = { ...state.c, lastFingerprint: event.fingerprint, records, finalGate: `${rows.length} commands checked; ${rows.filter((row) => row.status === 'pass' || row.status === 'known-red — unchanged').length} accepted.` };
      return completeVerification(c, rows);
    }
    case 'failure-snapshot': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) return fail(state.c, `${state.reason} (snapshot failed: ${event.cls}: ${event.detail})`);
      if (event.type !== 'SNAPSHOT' || !answers(event, state.effectId)) return stay(state);
      return stay({ tag: 'failure', c: isFingerprint(event.fingerprint) ? { ...state.c, lastFingerprint: event.fingerprint } : state.c, reason: state.reason, changedPaths: diffPaths(event) });
    }
    case 'failure': {
      if (event.type !== 'DECISION' || event.kind !== 'failure' || event.answer !== 'stop') return stay(state);
      return stop(state.c, `Stopped after failure: ${state.reason}. Work preserved; changed paths: ${state.changedPaths.join(', ') || 'none reported'}.`);
    }
    case 'complete': case 'stopped': case 'failed': return stay(state);
    default: return never(state, 'implement state');
  }
}

function redTestPaths(c: Context): string[] { return [...new Set(activeRedCriteria(c).flatMap((criterion) => criterion.changes.filter(isTestPath)))].sort(); }

function reviewPaths(event: Extract<Event, { type: 'FIXES_APPLIED' }>): string[] {
  return event.clusters.flatMap((cluster) => Array.isArray(cluster['affectedPaths']) ? cluster['affectedPaths'].filter((file): file is string => typeof file === 'string') : []);
}

function decideData(kind: string, question: string, options: readonly string[], items?: readonly unknown[]): Readonly<Record<string, unknown>> {
  return { kind, question, options, ...(items ? { items } : {}) };
}

export function implementAwait(state: ImplementState): Await | null {
  switch (state.tag) {
    case 'author': return 'author';
    case 'plan-review': case 'code-review': return reviewAwait(state.review);
    case 'write': return 'write';
    case 'baseline-decision': return 'decide';
    case 'approval': case 'needs-user': case 'concerns': case 'failure': return 'decide';
    case 'evidence': return 'evidence';
    case 'complete': case 'stopped': case 'failed': return 'done';
    case 'booting': case 'starting': case 'parsing': case 'baseline-preflight': case 'baseline': case 'baseline-snapshot': case 'writing-brief': case 'snapshot-before-write':
    case 'cascade-snapshot': case 'checking-envelope': case 'snapshot-after-write': case 'red-verify': case 'scoped-snapshot': case 'scoped-verify':
    case 'post-review-snapshot': case 'generated-verify': case 'generated-snapshot': case 'final-verify': case 'failure-snapshot': return null;
    default: return never(state, 'implement state');
  }
}

export function implementData(state: ImplementState): Readonly<Record<string, unknown>> {
  switch (state.tag) {
    case 'author': return { artifact: 'plan', path: state.c.planPath, template: IMPLEMENT_TEMPLATE, ...(state.defects.length ? { defects: state.defects } : {}) };
    case 'plan-review': case 'code-review': return reviewData(state.review);
    case 'write': return {
      stage: state.info.stage, attempt: state.info.attempt, briefPath: state.info.briefPath, briefSha256: state.info.briefSha256,
      envelopePath: state.info.envelopePath, models: state.info.models, model: state.info.models[state.info.modelIndex], effort: state.c.writer?.effort,
      paths: state.info.stage === 'tests-only' ? redTestPaths(state.c) : approvedPaths(state.c.plan as ParsedPlan),
    };
    case 'baseline-decision': return decideData('baseline', 'The baseline has nonzero results. Accept every listed failure identity as known red or stop.', ['accept-known-red', 'stop'], state.items.map((row) => ({ command: row.command, failureId: row.failureId, diagnostic: row.diagnostic, logPath: row.logPath })));
    case 'approval': return decideData('approval', 'Approve these plan paths and verification commands before any writer stage.', ['approve', 'stop'], [{ by: 'required', quote: 'required', paths: state.c.plan ? approvedPaths(state.c.plan) : [], commands: state.c.plan ? commandMappings(state.c.plan).map((row) => row.command) : [] }]);
    case 'needs-user': return decideData('needs-user', `Rule on RED exceptions for ${state.ids.join(', ')} before production work.`, ['accept', 'stop'], state.ids);
    case 'concerns': return decideData('concerns', 'Resolve the writer concerns before code review.', ['accept', 'stop'], state.items);
    case 'failure': return decideData('failure', state.reason, ['stop'], [{ changedPaths: state.changedPaths, workPreserved: true }]);
    case 'evidence': return {
      purpose: state.purpose,
      summary: state.verify.map((row) => ({ command: row.command, exit: row.exit, logPath: row.logPath, diagnostic: row.diagnostic, status: row.status, failureId: row.failureId })),
      criteria: state.ids.map((id) => {
        const criterion = state.c.plan?.criteria.find((entry) => entry.id === id);
        return { id, title: criterion?.title ?? id, evidenceClass: criterion?.evidence, planHash: state.c.planHash, mutationEpoch: state.c.mutationEpoch };
      }),
    };
    case 'complete': return { outcome: 'complete', summary: state.summary, completion: completionData(state.c) };
    case 'stopped': return { outcome: 'stopped', summary: state.summary, completion: completionData(state.c) };
    case 'failed': return { outcome: 'failed', summary: state.summary, completion: state.c ? completionData(state.c) : {} };
    default: return {};
  }
}

function completionData(c: Context): Readonly<Record<string, unknown>> {
  const review = c.codeReview ? reviewData(c.codeReview) : {};
  return {
    planPath: c.planPath, planHash: c.planHash, mutationEpoch: c.mutationEpoch, acceptedBaseline: c.acceptedBaseline,
    approval: c.approval, redExceptionRulings: c.redExceptionRulings, concernRulings: c.concernRulings,
    criteria: (c.plan?.criteria ?? []).map((criterion) => ({ id: criterion.id, evidence: c.evidence[criterion.id] ?? null, lastMutation: c.criterionMutation[criterion.id] ?? 0 })),
    review: review['completion'] ?? review, limitations: c.concerns, finalGate: c.finalGate,
  };
}

export function validateImplement(state: ImplementState, event: HostEvent): string | null {
  if (event.type === 'REVISE') return 'event.type: REVISE is not available in implement until I06.';
  if (state.tag === 'author' && event.type === 'AUTHORED' && event.path !== state.c.planPath) return `event.path: expected ${state.c.planPath}.`;
  if (state.tag === 'write' && event.type === 'WRITE_ENVELOPE' && event.envelopePath !== state.info.envelopePath) return 'event.envelopePath: expected the exact path from the current write frame.';
  if (state.tag === 'write' && event.type === 'WRITE_FAILED' && event.model !== state.info.models[state.info.modelIndex]) return 'event.model: expected the current configured model id.';
  if (state.tag === 'plan-review' || state.tag === 'code-review') return validateReview(state.review, event);
  if (state.tag === 'approval' && event.type === 'DECISION' && event.kind === 'approval' && event.answer !== 'stop' && !approvalAnswer(event.answer)) return 'event.answer: approval requires non-empty user-attributed by and quote.';
  if (state.tag === 'baseline-decision' && event.type === 'DECISION' && event.kind === 'baseline' && event.answer !== 'stop') {
    const ids = isRecord(event.answer) && Array.isArray(event.answer['ids']) ? event.answer['ids'] : [];
    const available = failingBaselineIds(state.items);
    if (!isRecord(event.answer) || event.answer['action'] !== 'accept-known-red' || ids.length !== available.length || new Set(ids).size !== ids.length || available.some((id) => !ids.includes(id))) return 'event.answer: accept-known-red must name every distinct baseline failure identity.';
  }
  if (state.tag === 'needs-user' && event.type === 'DECISION' && event.kind === 'needs-user' && !needsUserRuling(state.c, state.ids, event.answer)) return 'event.answer: RED exception ruling requires accept or stop, by, and quote.';
  if (state.tag === 'concerns' && event.type === 'DECISION' && event.kind === 'concerns' && !needsUserRuling(state.c, state.items, event.answer)) return 'event.answer: concerns ruling requires accept or stop, by, and quote.';
  if (state.tag === 'failure' && event.type === 'DECISION' && event.kind === 'failure' && event.answer !== 'stop') return 'event.answer: I05 supports stop at decide:failure.';
  if (state.tag === 'evidence' && event.type === 'EVIDENCE' && !recordEvidence(state.c, state.ids, event.criteria)) return `event.criteria: provide one bound evidence item for each of ${state.ids.join(', ')}.`;
  return null;
}

export const implementTransitions = [
  { from: 'code-review', on: 'REVIEW_PREPARED', to: 'post-review-snapshot' },
  { from: 'code-review', on: 'VERIFY_DONE', to: 'post-review-snapshot' },
  { from: 'code-review', on: 'DECISION', to: 'post-review-snapshot' },
  { from: 'code-review', on: 'DECISION', to: 'failure-snapshot' },
  { from: 'plan-review', on: 'REVIEW_PREPARED', to: 'parsing' },
  { from: 'plan-review', on: 'VERIFY_DONE', to: 'parsing' },
  { from: 'plan-review', on: 'DECISION', to: 'parsing' },
  { from: 'plan-review', on: 'DECISION', to: 'failure-snapshot' },
  { from: 'booting', on: 'RUN_STARTED', to: 'starting' },
  { from: 'starting', on: 'SNAPSHOT', to: 'author' }, { from: 'starting', on: 'SNAPSHOT', to: 'parsing' }, { from: 'starting', on: 'EFFECT_FAILED', to: 'failed' },
  { from: 'author', on: 'AUTHORED', to: 'parsing' },
  { from: 'parsing', on: 'ARTIFACT_PARSED', to: 'plan-review' }, { from: 'parsing', on: 'ARTIFACT_PARSED', to: 'baseline-preflight' }, { from: 'parsing', on: 'ARTIFACT_PARSED', to: 'author' }, { from: 'parsing', on: 'ARTIFACT_PARSED', to: 'failure-snapshot' },
  { from: 'parsing', on: 'EFFECT_FAILED', to: 'author' }, { from: 'parsing', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'plan-review', on: 'RULINGS', to: 'parsing' }, { from: 'plan-review', on: 'FIXES_APPLIED', to: 'plan-review' }, { from: 'plan-review', on: 'WAVE_DONE', to: 'parsing' }, { from: 'plan-review', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'baseline-preflight', on: 'SNAPSHOT', to: 'baseline' }, { from: 'baseline-preflight', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'baseline', on: 'VERIFY_DONE', to: 'baseline-snapshot' }, { from: 'baseline', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'baseline-snapshot', on: 'SNAPSHOT', to: 'baseline-decision' }, { from: 'baseline-snapshot', on: 'SNAPSHOT', to: 'approval' }, { from: 'baseline-snapshot', on: 'EFFECT_FAILED', to: 'failed' },
  { from: 'baseline-decision', on: 'DECISION', to: 'approval' }, { from: 'baseline-decision', on: 'DECISION', to: 'stopped' }, { from: 'approval', on: 'DECISION', to: 'writing-brief' }, { from: 'approval', on: 'DECISION', to: 'needs-user' }, { from: 'approval', on: 'DECISION', to: 'stopped' },
  { from: 'needs-user', on: 'DECISION', to: 'writing-brief' }, { from: 'needs-user', on: 'DECISION', to: 'stopped' },
  { from: 'writing-brief', on: 'BRIEF_READY', to: 'snapshot-before-write' }, { from: 'writing-brief', on: 'EFFECT_FAILED', to: 'failure-snapshot' }, { from: 'snapshot-before-write', on: 'SNAPSHOT', to: 'write' }, { from: 'snapshot-before-write', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'write', on: 'WRITE_ENVELOPE', to: 'checking-envelope' }, { from: 'write', on: 'WRITE_FAILED', to: 'cascade-snapshot' }, { from: 'cascade-snapshot', on: 'SNAPSHOT', to: 'write' }, { from: 'cascade-snapshot', on: 'SNAPSHOT', to: 'failure-snapshot' }, { from: 'cascade-snapshot', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'checking-envelope', on: 'ENVELOPE_CHECKED', to: 'snapshot-after-write' }, { from: 'checking-envelope', on: 'ENVELOPE_CHECKED', to: 'failure-snapshot' }, { from: 'checking-envelope', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'snapshot-after-write', on: 'SNAPSHOT', to: 'red-verify' }, { from: 'snapshot-after-write', on: 'SNAPSHOT', to: 'scoped-snapshot' }, { from: 'snapshot-after-write', on: 'SNAPSHOT', to: 'failure-snapshot' }, { from: 'snapshot-after-write', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'red-verify', on: 'VERIFY_DONE', to: 'writing-brief' }, { from: 'red-verify', on: 'VERIFY_DONE', to: 'failure-snapshot' }, { from: 'red-verify', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'scoped-snapshot', on: 'SNAPSHOT', to: 'scoped-verify' }, { from: 'scoped-snapshot', on: 'SNAPSHOT', to: 'evidence' }, { from: 'scoped-snapshot', on: 'SNAPSHOT', to: 'failure-snapshot' }, { from: 'scoped-snapshot', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'scoped-verify', on: 'VERIFY_DONE', to: 'evidence' }, { from: 'scoped-verify', on: 'VERIFY_DONE', to: 'failure-snapshot' }, { from: 'scoped-verify', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'evidence', on: 'EVIDENCE', to: 'evidence' }, { from: 'evidence', on: 'EVIDENCE', to: 'concerns' }, { from: 'evidence', on: 'EVIDENCE', to: 'code-review' }, { from: 'evidence', on: 'EVIDENCE', to: 'complete' },
  { from: 'concerns', on: 'DECISION', to: 'code-review' }, { from: 'concerns', on: 'DECISION', to: 'stopped' },
  { from: 'code-review', on: 'RULINGS', to: 'post-review-snapshot' }, { from: 'code-review', on: 'WAVE_DONE', to: 'post-review-snapshot' }, { from: 'code-review', on: 'FIXES_APPLIED', to: 'code-review' }, { from: 'code-review', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'post-review-snapshot', on: 'SNAPSHOT', to: 'generated-verify' }, { from: 'post-review-snapshot', on: 'SNAPSHOT', to: 'final-verify' }, { from: 'post-review-snapshot', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'generated-verify', on: 'VERIFY_DONE', to: 'generated-snapshot' }, { from: 'generated-verify', on: 'VERIFY_DONE', to: 'failure-snapshot' }, { from: 'generated-verify', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'generated-snapshot', on: 'SNAPSHOT', to: 'final-verify' }, { from: 'generated-snapshot', on: 'SNAPSHOT', to: 'failure-snapshot' }, { from: 'generated-snapshot', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'final-verify', on: 'VERIFY_DONE', to: 'evidence' }, { from: 'final-verify', on: 'VERIFY_DONE', to: 'failure-snapshot' }, { from: 'final-verify', on: 'EFFECT_FAILED', to: 'failure-snapshot' },
  { from: 'failure-snapshot', on: 'SNAPSHOT', to: 'failure' }, { from: 'failure-snapshot', on: 'SNAPSHOT', to: 'failed' }, { from: 'failure-snapshot', on: 'EFFECT_FAILED', to: 'failed' },
  { from: 'failure', on: 'DECISION', to: 'stopped' },
] as const;

export function implementWalkthrough(state: ImplementState): WalkthroughView | null {
  if (state.tag !== 'complete' && state.tag !== 'stopped' && state.tag !== 'failed') return null;
  if (!state.c || !state.c.plan) return null;
  const c = state.c;
  const plan = c.plan;
  if (!plan) return null;
  const status = state.tag === 'complete' ? 'complete' : state.tag;
  const planRounds = c.planReview && 'c' in c.planReview ? resolutionRounds(c.planReview.c) : [];
  const codeRounds = c.codeReview && 'c' in c.codeReview ? resolutionRounds(c.codeReview.c) : [];
  return {
    title: plan.title ?? c.planPath, delivered: plan.box['TL;DR'] ?? plan.title ?? c.planPath, parent: c.planPath, status,
    changes: plan.changes.map((change) => ({ action: change.action, path: change.path, note: change.note || `Plan ${change.action.toLowerCase()} entry.` })),
    verification: plan.criteria.flatMap((criterion) => {
      const item = c.evidence[criterion.id];
      return item ? [{ sc: criterion.id, outcome: String(item['outcome'] ?? 'recorded'), evidence: String(item['evidence'] ?? item.source) }] : [];
    }),
    finalGate: c.finalGate, deviations: c.concerns, followUps: plan.verification.manual,
    revisions: [], rounds: [...planRounds, ...codeRounds],
  };
}

export function renderImplementWalkthrough(state: ImplementState): string | null {
  const view = implementWalkthrough(state);
  return view ? renderWalkthrough(view) : null;
}

export const implementMachine: Machine<ImplementState> = {
  initial: initialImplement,
  step: stepImplement,
  awaitOf: implementAwait,
  project: (state) => ({ at: `implement › ${state.tag}${state.tag === 'plan-review' || state.tag === 'code-review' ? ` › ${state.review.tag}` : ''}`, data: implementData(state) }),
  transitions: implementTransitions,
  validate: validateImplement,
};


