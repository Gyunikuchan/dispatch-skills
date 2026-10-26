import { pruneTransition } from './prune.ts';
import { hasTransient } from './plan-view.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { HandlerContext, HandlerResult } from './cli.ts';
import { criterionStatuses, type CriterionStatus } from './evidence.ts';
import { git, gitOk, headTree, testedTree } from './git.ts';
import { integrationRecord } from './integration.ts';
import { currentHashes, foldLedger, latest, withLedger, type Fold } from './ledger.ts';
import { checks, loadPlan, ownedPaths } from './plan-view.ts';
import { ToolError } from './output.ts';
import { diagnosticsEnabled, readReviews, optionalDiagnostics } from './diagnostics.ts';
import { renderWalkthrough, type WalkthroughView } from './walkthrough.ts';
import type { LedgerRecord } from './records.ts';
import type { ParsedPlan } from './domain/types.ts';

type Current = { headTree: string; testedTree: string };
type Snapshot = {
  fold: Fold;
  bind: LedgerRecord;
  plan: ParsedPlan;
  planPath: string;
  planStem: string;
  specPath: string;
  specHash: string;
  integration: LedgerRecord | undefined;
  integrationPath: string | null;
  head: string | null;
  current: Current | null;
  statuses: CriterionStatus[];
  delivered: LedgerRecord | undefined;
  deliveredAtHead: boolean;
  integrated: number;
};
type ReportFacts = Snapshot & {
  view: WalkthroughView;
  edits: WalkthroughView['edits'];
  unplannedPaths: string[];
  openEscalations: WalkthroughView['openEscalations'];
  deferredRulings: WalkthroughView['deferredRulings'];
  userRecords: WalkthroughView['userRecords'];
};

function isDirectory(directory: string): boolean {
  try { return fs.statSync(directory).isDirectory(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function recordForDestination(fold: Fold, integration: LedgerRecord): LedgerRecord | undefined {
  const dest = integration.data['dest'] as { path?: unknown; branch?: unknown } | undefined;
  return fold.records.findLast((record) => record.kind === 'integrate' && record.data['phase'] === 'delivered' &&
    record.data['dest']?.path === dest?.path && record.data['dest']?.branch === dest?.branch);
}

/** Captures only the plan, ledger and Git facts needed to decide completion. */
async function capture(ctx: HandlerContext, fold: Fold): Promise<Snapshot> {
  const bind = latest(fold, 'bind');
  const plan = loadPlan(ctx.session, ctx.manifest);
  if (!bind) throw new ToolError(4, 'lint-errors', 'No bound plan');
  const planPath = String(bind.data['plan']);
  const specPath = String(bind.data['spec']);
  const specHash = currentHashes(ctx.manifest.repositoryRoot, bind).spec ?? 'unavailable';
  const integration = integrationRecord(fold);
  let integrationPath: string | null = null;
  let head: string | null = null;
  let current: Current | null = null;
  if (integration) {
    const candidate = path.resolve(ctx.session, String(integration.data['path']));
    if (isDirectory(candidate)) {
      integrationPath = candidate;
      head = await gitOk(ctx.deps, candidate, ['rev-parse', 'HEAD']);
      const headTreeValue = await headTree(ctx.deps, candidate);
      const testedTreeValue = await testedTree(ctx.deps, ctx.session, candidate);
      current = { headTree: headTreeValue, testedTree: testedTreeValue };
    }
  }
  const checkRows = checks(plan);
  let transition;
  let invalidPruning=false;
  if(hasTransient(plan)) {try{transition=await pruneTransition(ctx,fold,plan,true);}catch(error){if(!(error instanceof ToolError && error.exit===4))throw error;invalidPruning=true;}}
  const statusRows = invalidPruning?checkRows.map(c=>({criterion:c.criterion,state:'missing' as const,reason:'pruning or final verification required'})):criterionStatuses(fold, checkRows, current,transition);
  const delivered = integration ? recordForDestination(fold, integration) : undefined;
  const deliveredAtHead = Boolean(delivered && head && (delivered.data['source'] ?? delivered.data['to']) === head);
  const planTaskIds = new Set(plan.tasks.map((task) => task.id));
  const integrated = new Set(fold.records.flatMap((record) =>
    record.kind === 'integrate' && record.data['phase'] === 'done' && typeof record.data['task'] === 'string' &&
      planTaskIds.has(record.data['task']) ? [record.data['task'] as string] : []));
  const planStem = path.basename(planPath).replace(/\.plan\.md$/i, '') || plan.title || 'walkthrough';
  return {
    fold, bind, plan, planPath, planStem, specPath, specHash,
    integration, integrationPath, head, current, statuses: statusRows, delivered, deliveredAtHead,
    integrated: integrated.size,
  };
}

function parseNameStatus(bytes: string): { status: string; path: string }[] {
  const parts = bytes.split('\0').filter(Boolean);
  const changes: { status: string; path: string }[] = [];
  for (let index = 0; index < parts.length;) {
    const token = parts[index++]!;
    const tab = token.indexOf('\t');
    if (tab >= 0) changes.push({ status: token.slice(0, tab), path: token.slice(tab + 1) });
    else if (index < parts.length) changes.push({ status: token, path: parts[index++]! });
  }
  return changes;
}

function userDataSummary(data: Record<string, unknown>): string {
  try { return JSON.stringify(data); }
  catch { return '[unavailable]'; }
}

function reviewRows(fold: Fold, session: string) {
  const rows: WalkthroughView['reviewRows'][number][] = [];
  const findingsPaths = new Map<string, string>();
  for (const round of readReviews(session)) {
    const findings = round.findings?.findings;
    if (!Array.isArray(findings)) continue;
    const path = `.state/reviews/${round.review}/round-${round.round}/findings.json`;
    findingsPaths.set(round.review, path);
    for (const raw of findings) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') continue;
      const finding = raw as { id: string; severity?: unknown; recurrence?: { of?: unknown }; unresolved?: { of?: unknown } };
      const ruling = fold.records.findLast((record) => record.kind === 'ruling' && record.data['subject'] === `review:${round.review}:${finding.id}`);
      const rulingValue = ruling?.data['ruling'];
      rows.push({
        review: round.review,
        id: finding.id,
        round: round.round,
        severity: typeof finding.severity === 'string' ? finding.severity : 'unknown',
        ruling: ['accepted', 'rejected', 'duplicate', 'deferred'].includes(rulingValue) ? rulingValue as 'accepted' | 'rejected' | 'duplicate' | 'deferred' : null,
        rationale: typeof ruling?.data['rationale'] === 'string' ? ruling.data['rationale'] : '',
        ...(typeof finding.recurrence?.of === 'string' ? { recurrence: finding.recurrence.of } : {}),
        ...(typeof finding.unresolved?.of === 'string' ? { unresolved: finding.unresolved.of } : {}),
      });
    }
  }
  return { rows, findingsPaths: [...findingsPaths].map(([review, path]) => ({review, path})) };
}

/** Joins captured facts with changes and review results to form a rendered report. */
async function materialize(ctx: HandlerContext, snapshot: Snapshot): Promise<ReportFacts> {
  const changes: WalkthroughView['changes'][number][] = [];
  const unplannedPaths: string[] = [];
  if (snapshot.integrationPath && snapshot.integration) {
    const result = await git(ctx.deps, snapshot.integrationPath, [
      'diff', '--name-status', '--no-renames', '-z', String(snapshot.integration.data['base']), snapshot.head ?? 'HEAD',
    ]);
    if (result.exit !== 0) throw new ToolError(2, 'fault', result.stderr || result.stdout || 'Git diff failed');
    for (const change of parseNameStatus(result.stdout)) {
      const relative = change.path.replaceAll('\\', '/');
      const owners = snapshot.plan.tasks.filter((task) => ownedPaths(snapshot.plan, task.id).includes(relative))
        .map((task) => ({ id: task.id, title: task.title }));
      if (!owners.length) unplannedPaths.push(relative);
      changes.push({
        action: change.status === 'A' ? 'NEW' : change.status === 'D' ? 'DELETE' : 'MODIFY',
        path: relative,
        owners,
      });
    }
  }
  const edits = snapshot.fold.records.filter((record) => record.kind === 'edit').map((record) => ({
    seq: record.seq,
    artifact: String(record.data['artifact']),
    class: String(record.data['class']),
    rationale: String(record.data['rationale']),
    diffRef: String(record.data['diffRef']),
    affects: Array.isArray(record.data['affects']) ? record.data['affects'].map(String) : [],
  }));
  const escalations = new Map<string, LedgerRecord>();
  for (const record of snapshot.fold.records) if (record.kind === 'escalation') escalations.set(String(record.data['id']), record);
  const openEscalations = [...escalations.values()].filter((record) => record.data['state'] === 'open').map((record) => ({
    id: String(record.data['id']), summary: String(record.data['summary']),
  }));
  const rulings = new Map<string, LedgerRecord>();
  for (const record of snapshot.fold.records) if (record.kind === 'ruling') rulings.set(String(record.data['subject']), record);
  const deferredRulings = [...rulings.values()].flatMap((record) => {
    const match = /^review:([^:]+):(.+)$/.exec(String(record.data['subject']));
    return record.data['ruling'] === 'deferred' && match ? [{ review: match[1]!, finding: match[2]! }] : [];
  });
  const userRecords = snapshot.fold.records.filter((record) => record.by === 'user').map((record) => ({
    seq: record.seq,
    kind: record.kind,
    summary: userDataSummary(record.data),
    quote: record.quote ?? '',
  }));
  const review = reviewRows(snapshot.fold, ctx.session);
  const destBranch = String(snapshot.integration?.data['dest']?.branch ?? '');
  const view: WalkthroughView = {
    title: snapshot.plan.title || snapshot.planStem,
    specPath: snapshot.specPath,
    specHash: snapshot.specHash,
    planPath: snapshot.planPath,
    delivered: snapshot.integration ? {
      integrated: snapshot.integrated,
      total: snapshot.plan.tasks.length,
      source: snapshot.delivered?.data['source'] ?? snapshot.delivered?.data['to'] ?? null,
      to: typeof snapshot.delivered?.data['to'] === 'string' ? snapshot.delivered.data['to'] : null,
      branch: destBranch,
    } : null,
    statuses: snapshot.statuses,
    changes,
    edits,
    unplannedPaths,
    openEscalations,
    deferredRulings,
    userRecords,
    reviewRows: review.rows,
    findingsPaths: review.findingsPaths,
  };
  return { ...snapshot, view, edits, unplannedPaths, openEscalations, deferredRulings, userRecords };
}

/** Reads the un-locked facts used by `report render`. */
export async function reportFacts(ctx: HandlerContext): Promise<ReportFacts> {
  return materialize(ctx, await capture(ctx, foldLedger(ctx.session)));
}

function writeWalkthrough(session: string, stem: string, text: string): string {
  const output = path.join(session, stem + '.walkthrough.md');
  const temporary = output + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, text, { mode: 0o600 });
    fs.renameSync(temporary, output);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return output;
}

function statusCounts(statuses: readonly CriterionStatus[]) {
  return {
    verified: statuses.filter((status) => status.state === 'verified').length,
    manual: statuses.filter((status) => status.state === 'manual').length,
    waived: statuses.filter((status) => status.state === 'waived').length,
    missing: statuses.filter((status) => status.state === 'missing').length,
  };
}

function resultValue(facts: ReportFacts, session: string, walkthroughPath: string) {
  return {
    path: path.relative(session, walkthroughPath).split(path.sep).join('/'),
    statuses: facts.statuses,
    changes: facts.view.changes,
    deviations: { edits: facts.edits, unplannedPaths: facts.unplannedPaths },
    openEscalations: facts.openEscalations,
    deferredRulings: facts.deferredRulings,
    userRecords: facts.userRecords,
    delivered: facts.view.delivered,
  };
}

export async function reportRender(ctx: HandlerContext): Promise<HandlerResult> {
  if (ctx.args.length) throw new ToolError(1, 'invalid-input', 'report render takes no positional arguments');
  const writeDiagnosticsEnabled = diagnosticsEnabled(ctx.deps.skillRoot);
  const facts = await reportFacts(ctx);
  const walkthroughPath = writeWalkthrough(ctx.session, facts.planStem, renderWalkthrough(facts.view));
  const diagnosticsPath = writeDiagnosticsEnabled ? optionalDiagnostics(ctx.session, facts.fold, 'rendered') : undefined;
  const counts = statusCounts(facts.statuses);
  const relative = path.relative(ctx.session, walkthroughPath).split(path.sep).join('/');
  const deviationCount = facts.edits.length + facts.unplannedPaths.length;
  return {
    ok: true,
    exit: 0,
    summary: `walkthrough ${relative}; SC verified ${counts.verified}, manual ${counts.manual}, waived ${counts.waived}, missing ${counts.missing}; deviations ${deviationCount}; user records ${facts.userRecords.length}`,
    value: { ...resultValue(facts, ctx.session, walkthroughPath), ...(diagnosticsPath ? {diagnostics: diagnosticsPath} : {}) },
  };
}

function refusal(snapshot: Snapshot): ToolError | null {
  if (!snapshot.integration || !snapshot.integrationPath) return new ToolError(4, 'no-integration', 'No integration worktree is available');
  const missing = snapshot.statuses.filter((status) => status.state === 'missing').map((status) => status.criterion);
  const dirty = snapshot.current !== null && snapshot.current.testedTree !== snapshot.current.headTree;
  if (missing.length) return new ToolError(4, 'criteria-unmet', `Missing criteria: ${missing.join(', ')}${dirty ? '; dirty checkout (integration tree differs from HEAD tree)' : ''}`);
  if (!snapshot.deliveredAtHead) return new ToolError(4, 'undelivered', `No delivery record matches integration HEAD ${snapshot.head ?? 'unknown'}`);
  return null;
}

export async function reportComplete(ctx: HandlerContext): Promise<HandlerResult> {
  if (ctx.args.length) throw new ToolError(1, 'invalid-input', 'report complete takes no positional arguments');
  const captured = await withLedger(ctx.session, 'report complete', ctx.deps, async (tx) => {
    const snapshot = await capture(ctx, tx.fold);
    return { snapshot, refusal: refusal(snapshot) };
  });
  if (captured.refusal) {
    const snapshot = captured.snapshot;
    const walkthroughPath = path.join(ctx.session, snapshot.planStem + '.walkthrough.md');
    return {
      ok: false,
      exit: captured.refusal.exit,
      reason: captured.refusal.reason,
      summary: captured.refusal.message,
      value: {
        path: path.relative(ctx.session, walkthroughPath).split(path.sep).join('/'),
        statuses: snapshot.statuses,
        reason: captured.refusal.reason,
        message: captured.refusal.message,
      },
    };
  }
  const facts = await materialize(ctx, captured.snapshot);
  const diagnostics = diagnosticsEnabled(ctx.deps.skillRoot);
  const walkthroughPath = writeWalkthrough(ctx.session, facts.planStem, renderWalkthrough(facts.view));
  const diagnosticsPath = diagnostics ? optionalDiagnostics(ctx.session, facts.fold, 'complete') : undefined;
  const counts = statusCounts(facts.statuses);
  const relative = path.relative(ctx.session, walkthroughPath).split(path.sep).join('/');
  const deviationCount = facts.edits.length + facts.unplannedPaths.length;
  return {
    ok: true,
    exit: 0,
    summary: `complete: walkthrough ${relative}; SC verified ${counts.verified}, manual ${counts.manual}, waived ${counts.waived}, missing ${counts.missing}; deviations ${deviationCount}; user records ${facts.userRecords.length}`,
    value: { ...resultValue(facts, ctx.session, walkthroughPath), ...(diagnosticsPath ? {diagnostics: diagnosticsPath} : {}) },
  };
}
