import { isRecord } from '../lib/config.ts';
import type { JsonValue } from '../lib/config.ts';
import { nodeErrorCode } from '../lib/fs-ext.ts';
import { parseJson } from '../lib/integrity.ts';
import { present, stringList, stringMap, textValue } from './narrow.ts';
import { validateReviewFix } from './records.ts';
import {
  INTEGRATION_REVIEW,
  reviewDirectory,
  reviewRoundFile,
  reviewFindingsFile,
  reviewGenerationDirectory,
  reviewRoundNumber,
} from './review-state.ts';
import { reviewIdentity } from './review-identity.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { HandlerContext, HandlerResult } from './cli.ts';
import { cleanupBinding, criterionStatusCounts, criterionStatuses, latestCleanup, verifiedStage } from './evidence.ts';
import type { CriterionStatus } from './evidence.ts';
import { git, gitOk, headTree, splitPaths, testedTree } from './git.ts';
import { integrationRecord } from './integration-state.ts';
import { currentHashes, foldLedger, latest, withLedger } from './ledger.ts';
import type { Fold } from './ledger.ts';
import { readArtifact } from './artifacts.ts';
import { checks, loadPlan, ownedPaths } from './plan-view.ts';
import { parseGlance } from './domain/plan.ts';
import { structuralLines } from './domain/markdown-structure.ts';
import { ToolError, writePrivateOutput } from './output.ts';
import { diagnosticsEnabled } from './diagnostics-capture.ts';
import { optionalDiagnostics, retroWarning } from './diagnostics.ts';
import { deliveredSourceRef } from './writers.ts';
import { renderWalkthrough } from './walkthrough.ts';
import type { WalkthroughView } from './walkthrough.ts';
import { reviewRows } from './review-findings.ts';
import type { LedgerRecord, ReviewFix } from './records.ts';
import type { ParsedPlan } from './domain/types.ts';

import { loadRejections, applicableReviewIds } from './confirmations.ts';
import type { RejectionState } from './confirmations.ts';
import { coverageState } from './coverage.ts';
type Current = { headTree: string; testedTree: string };
export type ReviewFixReport = {
  commit: string;
  reason: string;
  metadata: ReviewFix;
  status: 're-reviewed' | 'verified but not re-reviewed' | 'not verified';
  paths: Array<string>;
  verification?: { tree: string; criteria: Array<string>; contract: Array<string> };
};
type Snapshot = {
  risk: string;
  fold: Fold;
  bind: LedgerRecord;
  plan: ParsedPlan;
  planPath: string;
  planHash: string;
  planStem: string;
  specPath: string;
  specHash: string;
  designHash: string | undefined;
  integration: LedgerRecord | undefined;
  integrationPath: string | null;
  head: string | null;
  current: Current | null;
  statuses: Array<CriterionStatus>;
  delivered: LedgerRecord | undefined;
  deliveredAtHead: boolean;
  integrated: number;
  rejectionConfirmations: Array<RejectionState>;
  confirmationError: string | undefined;
  coverage: WalkthroughView['coverage'];
  reviewedCodeBaseline: string | undefined;
  reviewFixes: Array<ReviewFixReport>;
  testCleanup: WalkthroughView['testCleanup'];
};
type ReportFacts = Snapshot & { view: WalkthroughView };

function isDirectory(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory();
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

const destinationOf = (record: LedgerRecord) => {
  const dest: unknown = record.data['dest'];
  return isRecord(dest) ? dest : undefined;
};

function recordForDestination(fold: Fold, integration: LedgerRecord): LedgerRecord | undefined {
  const dest = destinationOf(integration);
  return fold.records.findLast(
    (record) =>
      record.kind === 'integrate' &&
      record.data['phase'] === 'delivered' &&
      destinationOf(record)?.['path'] === dest?.['path'] &&
      destinationOf(record)?.['branch'] === dest?.['branch'],
  );
}

function completedReviewHeads(session: string): Array<string> {
  const root = reviewDirectory(session, INTEGRATION_REVIEW);
  const heads = new Set<string>();
  if (!isDirectory(root)) {
    return [];
  }
  for (const name of fs.readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory() || reviewRoundNumber(name.name) === undefined) {
      continue;
    }
    const directory = path.join(root, name.name);
    if (!fs.existsSync(reviewFindingsFile(directory))) {
      continue;
    }
    const saved = readReviewJson(reviewRoundFile(directory));
    const round = isRecord(saved) ? saved : undefined;
    const target = round?.['target'];
    const head = isRecord(target) ? target['head'] : undefined;
    const generation = round?.['generation'];
    if (
      typeof head !== 'string' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) ||
      /\(confirmation-only\)/i.test(String(round?.['scope'] ?? '')) ||
      typeof generation !== 'number' ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    ) {
      continue;
    }
    const slots = path.join(reviewGenerationDirectory(directory, generation), 'slots');
    if (
      isDirectory(slots) &&
      fs.readdirSync(slots, { withFileTypes: true }).some((file) => {
        if (!file.isFile() || !file.name.endsWith('.json')) {
          return false;
        }
        const slot = readReviewJson(path.join(slots, file.name));
        return isRecord(slot) && slot['state'] === 'done';
      })
    ) {
      heads.add(head);
    }
  }
  return [...heads];
}

function readReviewJson(file: string): JsonValue | undefined {
  try {
    return parseJson(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError || nodeErrorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

const countValue = (value: unknown): number => {
  if (typeof value !== 'number') {
    throw new TypeError('Expected a number value, received ' + typeof value);
  }
  return value;
};

const testCleanupView = ({ data }: LedgerRecord): WalkthroughView['testCleanup'] => ({
  from: textValue(data['from']),
  trees: stringMap(data['trees']),
  removed: stringList(data['removed']),
  deleted: countValue(data['deleted']),
  merged: countValue(data['merged']),
});

/** Captures only the plan, ledger and Git facts needed to decide completion. */
async function capture(ctx: HandlerContext, fold: Fold): Promise<Snapshot> {
  const bind = latest(fold, 'bind');
  const plan = loadPlan(ctx.session, ctx.manifest);
  if (!bind) {
    throw new ToolError(4, 'lint-errors', 'No bound plan');
  }
  const planPath = String(bind.data['plan']);
  const specPath = String(bind.data['spec']);
  const hashes = currentHashes(ctx.manifest.repositoryRoot, bind);
  const specHash = hashes.spec ?? 'unavailable';
  const planHash = hashes.plan ?? 'unavailable';
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
  const cleanup = cleanupBinding(fold),
    cleanupRecord = latestCleanup(fold);
  const fixRecords = fold.records.filter(
    (record) => record.kind === 'integrate' && record.data['phase'] === 'fix' && record.data['reviewFix'],
  );
  let reviewedCodeBaseline: string | undefined;
  if (fixRecords.length && integrationPath && integration && head && typeof integration.data['base'] === 'string') {
    try {
      reviewedCodeBaseline = (await reviewIdentity(ctx, fold, integrationPath, head, integration.data['base']))
        .baseline;
    } catch (error) {
      if (!(error instanceof ToolError && error.reason === 'review-required')) {
        throw error;
      }
    }
  }
  const reviewHeads = fixRecords.length ? completedReviewHeads(ctx.session) : [];
  const hasCurrentVerification =
    fixRecords.length && current && checkRows.length && verifiedStage(fold, checkRows, current, cleanup);
  const reviewFixes: Array<ReviewFixReport> = [];
  const repository = ctx.manifest.repositoryRoot;
  for (const record of fixRecords) {
    const commit = String(record.data['commit']);
    const metadata = validateReviewFix(record.data['reviewFix']);
    const isAncestor = async (target: string) =>
      (await git(ctx.deps, repository, ['merge-base', '--is-ancestor', commit, target])).exit === 0;
    let reviewed = false;
    for (const target of reviewHeads) {
      if (await isAncestor(target)) {
        reviewed = true;
        break;
      }
    }
    const verification =
      !reviewed && head && hasCurrentVerification && (await isAncestor(head))
        ? {
            tree: present(current, 'the current integration trees').headTree,
            criteria: checkRows.filter((check) => check.criterion !== 'contract').map((check) => check.criterion),
            contract: checkRows.filter((check) => check.criterion === 'contract').map((check) => check.criterion),
          }
        : undefined;
    const names = await git(ctx.deps, repository, [
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '--no-renames',
      '-r',
      '-z',
      commit,
    ]);
    reviewFixes.push({
      commit,
      reason: String(record.data['reason']),
      metadata,
      status: reviewed ? 're-reviewed' : verification ? 'verified but not re-reviewed' : 'not verified',
      paths: names.exit === 0 ? splitPaths(names.stdout) : [],
      ...(verification && { verification }),
    });
  }
  const statusRows = criterionStatuses(fold, checkRows, current, cleanup);
  const delivered = integration ? recordForDestination(fold, integration) : undefined;
  const deliveredAtHead = Boolean(delivered && head && delivered.data['source'] === head);
  const planTaskIds = new Set(plan.tasks.map((task) => task.id));
  const integrated = new Set(
    fold.records.flatMap((record) =>
      record.kind === 'integrate' &&
      record.data['phase'] === 'done' &&
      typeof record.data['task'] === 'string' &&
      planTaskIds.has(record.data['task'])
        ? [record.data['task']]
        : [],
    ),
  );
  const riskToken = plan.box['Risk']?.trim().split(/\s+/, 1)[0];
  const risk = riskToken === 'med' || riskToken === 'high' ? riskToken : 'low';
  const planStem = path.basename(planPath).replace(/\.plan\.md$/i, '') || plan.title || 'walkthrough';
  let rejectionConfirmations: Array<RejectionState> = [],
    confirmationError: string | undefined;
  try {
    rejectionConfirmations = loadRejections(ctx.session, fold, applicableReviewIds(ctx.manifest, fold));
  } catch (error) {
    if (!(error instanceof ToolError && error.reason === 'review-confirmation-required')) {
      throw error;
    }
    confirmationError = error.message;
  }
  let coverage: WalkthroughView['coverage'];
  try {
    coverage = coverageState(
      ctx.session,
      fold,
      INTEGRATION_REVIEW,
      applicableReviewIds(ctx.manifest, fold).get(INTEGRATION_REVIEW),
    );
  } catch (error) {
    if (!(error instanceof ToolError && error.reason === 'coverage-required')) {
      throw error;
    }
    coverage = 'unreadable';
  }
  return {
    fold,
    bind,
    plan,
    planPath,
    planHash,
    planStem,
    specPath,
    specHash,
    designHash: hashes.design ?? undefined,
    risk,
    integration,
    integrationPath,
    head,
    current,
    statuses: statusRows,
    delivered,
    deliveredAtHead,
    integrated: integrated.size,
    rejectionConfirmations,
    confirmationError,
    coverage,
    reviewedCodeBaseline,
    reviewFixes,
    testCleanup: cleanupRecord ? testCleanupView(cleanupRecord) : undefined,
  };
}

function parseNameStatus(bytes: string): Array<{ status: string; path: string }> {
  const parts = bytes.split('\0').filter(Boolean);
  const changes: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < parts.length;) {
    const token = present(parts[index++], 'a name-status token');
    const tab = token.indexOf('\t');
    if (tab >= 0) {
      changes.push({ status: token.slice(0, tab), path: token.slice(tab + 1) });
    } else if (index < parts.length) {
      changes.push({ status: token, path: present(parts[index++], 'a name-status path') });
    }
  }
  return changes;
}

function userDataSummary(data: LedgerRecord['data']): string {
  try {
    return JSON.stringify(data);
  } catch {
    return '[unavailable]';
  }
}

type FocusBullets = Array<{ text: string; evidence: string }>;
const isFocusBullets = (value: unknown): value is FocusBullets =>
  Array.isArray(value) &&
  value.every(
    (bullet) => isRecord(bullet) && typeof bullet['text'] === 'string' && typeof bullet['evidence'] === 'string',
  );

function focusBulletsOf(record: LedgerRecord | undefined): FocusBullets {
  const bullets: unknown = record?.data['bullets'] ?? [];
  if (!isFocusBullets(bullets)) {
    throw new TypeError('Expected review focus bullets');
  }
  return bullets;
}

function runtimeProofView(
  fold: Fold,
  proof: LedgerRecord,
  settled: LedgerRecord | undefined,
): NonNullable<WalkthroughView['runtimeProof']> {
  const report: unknown = proof.data['report'];
  const artifacts: unknown = proof.data['artifacts'];
  const dirty: unknown = proof.data['dirty'];
  return {
    outcome: textValue(proof.data['outcome']),
    head: textValue(proof.data['head']),
    reason: textValue(proof.data['reason']),
    ...(report !== undefined && { report: textValue(report) }),
    ...(artifacts !== undefined && { artifacts: stringList(artifacts) }),
    ...(typeof dirty === 'boolean' && { dirty }),
    fixes: settled
      ? fold.records
          .filter((r) => r.seq > settled.seq && r.kind === 'integrate' && r.data['phase'] === 'fix')
          .map((r) => ({
            commit: textValue(r.data['commit']),
            reason: textValue(r.data['reason']),
            beforeLatest: r.seq < proof.seq,
          }))
      : [],
  };
}

/** Joins captured facts with changes and review results to form a rendered report. */
async function materialize(ctx: HandlerContext, snapshot: Snapshot): Promise<ReportFacts> {
  const changes: Array<WalkthroughView['changes'][number]> = [];
  const unplannedPaths: Array<string> = [];
  if (snapshot.integrationPath && snapshot.integration) {
    const result = await git(ctx.deps, snapshot.integrationPath, [
      'diff',
      '--name-status',
      '--no-renames',
      '-z',
      String(snapshot.integration.data['base']),
      snapshot.head ?? 'HEAD',
    ]);
    if (result.exit !== 0) {
      throw new ToolError(2, 'fault', result.stderr || result.stdout || 'Git diff failed');
    }
    for (const change of parseNameStatus(result.stdout)) {
      const relative = change.path.replaceAll('\\', '/');
      const owners = snapshot.plan.tasks
        .filter((task) => ownedPaths(snapshot.plan, task.id).includes(relative))
        .map((task) => ({ id: task.id, title: task.title }));
      if (!owners.length) {
        unplannedPaths.push(relative);
      }
      changes.push({
        action: change.status === 'A' ? 'NEW' : change.status === 'D' ? 'DELETE' : 'MODIFY',
        path: relative,
        owners,
      });
    }
  }
  const root = ctx.manifest.repositoryRoot;
  let bindingAtEdit: LedgerRecord | undefined;
  const edits = snapshot.fold.records
    .filter((record) => {
      if (record.kind === 'bind') {
        bindingAtEdit = record;
      }
      if (record.kind !== 'edit') {
        return false;
      }
      const artifact = textValue(record.data['artifact']);
      const bound: unknown = bindingAtEdit?.data[artifact];
      const reported: unknown = snapshot.bind.data[artifact];
      return (
        !!bound &&
        !!reported &&
        path.relative(path.resolve(root, textValue(reported)), path.resolve(root, textValue(bound))) === ''
      );
    })
    .map((record) => ({
      seq: record.seq,
      artifact: String(record.data['artifact']),
      class: String(record.data['class']),
      rationale: String(record.data['rationale']),
      diffRef: String(record.data['diffRef']),
      affects: Array.isArray(record.data['affects']) ? record.data['affects'].map(String) : [],
    }));
  const escalations = new Map<string, LedgerRecord>();
  for (const record of snapshot.fold.records) {
    if (record.kind === 'escalation') {
      escalations.set(String(record.data['id']), record);
    }
  }
  const openEscalations = [...escalations.values()].flatMap(({ data }) =>
    data['state'] === 'open' ? [{ id: String(data['id']), summary: String(data['summary']) }] : [],
  );
  const deferredEscalations = [...escalations.values()].flatMap((record) => {
    const summary = String(record.data['summary']);
    const id = String(record.data['id']);
    return record.data['state'] === 'resolved' && id.startsWith('ceiling:') && summary.startsWith('defer:')
      ? [{ id, summary }]
      : [];
  });
  const rulings = new Map<string, LedgerRecord>();
  for (const record of snapshot.fold.records) {
    if (record.kind === 'ruling') {
      rulings.set(String(record.data['subject']), record);
    }
  }
  const deferredRulings = [...rulings.values()].flatMap((record) => {
    const match = /^review:([^:]+):(.+)$/.exec(String(record.data['subject']));
    return record.data['ruling'] === 'deferred' && match
      ? [{ review: present(match[1], 'the review ID'), finding: present(match[2], 'the finding ID') }]
      : [];
  });
  const userRecords = snapshot.fold.records
    .filter((record) => record.by === 'user')
    .map((record) => ({
      seq: record.seq,
      kind: record.kind,
      summary: userDataSummary(record.data),
      quote: record.quote ?? '',
    }));
  let review: ReturnType<typeof reviewRows>;
  try {
    review = reviewRows(ctx.session, snapshot.fold, snapshot.rejectionConfirmations);
  } catch (error) {
    if (!snapshot.confirmationError || !(error instanceof ToolError && error.reason === 'review-corrupt')) {
      throw error;
    }
    snapshot.confirmationError += '; ' + error.message;
    review = { rows: [], rounds: [] };
  }
  const destination = snapshot.integration && destinationOf(snapshot.integration);
  const destBranch = String(destination?.['branch'] ?? '');
  const glance = snapshot.plan.glance;
  const focusRecord = latest(snapshot.fold, 'focus');
  const focusBullets = focusBulletsOf(focusRecord);
  const visualInput: unknown = focusRecord?.data['visual'];
  const focusVisual = typeof visualInput === 'string' ? visualInput : undefined;
  let visuals = glance?.visuals ?? '';
  const designPath: unknown = snapshot.bind.data['design'];
  if (!visuals && typeof designPath === 'string') {
    const source = readArtifact(ctx.manifest.repositoryRoot, designPath);
    if (source !== null) {
      visuals = parseGlance(structuralLines(source))?.visuals ?? '';
    }
  }

  const integrationSeq = snapshot.integration?.seq ?? 0;
  const proofRecords = snapshot.fold.records.filter(
    (r) => r.seq > integrationSeq && r.kind === 'integrate' && r.data['phase'] === 'verification',
  );
  const proof = proofRecords.at(-1);
  const settled = proofRecords.find((r) => {
    const open: unknown = r.data['open'];
    return Array.isArray(open) && open.length === 0;
  });
  const runtimeProof = proof ? runtimeProofView(snapshot.fold, proof, settled) : undefined;
  const source: unknown = snapshot.delivered?.data['source'] ?? null;
  const view: WalkthroughView = {
    title: snapshot.plan.title || snapshot.planStem,
    specPath: snapshot.specPath,
    specHash: snapshot.specHash,
    planPath: snapshot.planPath,
    planHash: snapshot.planHash,
    risk: snapshot.risk,
    delivered: snapshot.integration
      ? {
          integrated: snapshot.integrated,
          total: snapshot.plan.tasks.length,
          source: source === null ? null : textValue(source),
          branch: destBranch,
          ref: deliveredSourceRef(ctx.manifest.safeSessionId),
        }
      : null,
    glance: glance ? { what: glance.what, visuals: glance.visuals } : null,
    repositoryRoot: ctx.manifest.repositoryRoot,
    ...(typeof designPath === 'string' && { designPath, designHash: snapshot.designHash ?? 'unavailable' }),
    ...(runtimeProof && { runtimeProof }),
    visuals,
    focus: focusRecord ? { bullets: focusBullets, ...(focusVisual && { visual: focusVisual }) } : null,
    tasks: snapshot.plan.tasks.map((task) => ({ id: task.id, title: task.title, outcome: task.summary })),
    statuses: snapshot.statuses,
    changes,
    edits,
    unplannedPaths,
    openEscalations,
    deferredRulings,
    deferredEscalations,
    userRecords,
    reviewRows: review.rows,
    reviewRounds: review.rounds,
    reviewFixes: snapshot.reviewFixes,
    ...(snapshot.coverage && { coverage: snapshot.coverage }),
    ...(snapshot.reviewedCodeBaseline && { reviewedCodeBaseline: snapshot.reviewedCodeBaseline }),
    ...(snapshot.testCleanup && { testCleanup: snapshot.testCleanup }),
  };
  return { ...snapshot, view };
}

function resultValue(facts: ReportFacts, relativePath: string) {
  return {
    path: relativePath,
    statuses: facts.statuses,
    changes: facts.view.changes,
    deviations: { edits: facts.view.edits, unplannedPaths: facts.view.unplannedPaths },
    openEscalations: facts.view.openEscalations,
    deferredRulings: facts.view.deferredRulings,
    deferredEscalations: facts.view.deferredEscalations,
    userRecords: facts.view.userRecords,
    delivered: facts.view.delivered,
    rejectionConfirmations: facts.rejectionConfirmations,
    confirmationError: facts.confirmationError,
    reviewedCodeBaseline: facts.reviewedCodeBaseline,
    reviewFixes: facts.reviewFixes,
  };
}

function publishReport(
  ctx: HandlerContext,
  facts: ReportFacts,
  outcome: 'rendered' | 'complete',
  diagnostics: boolean,
): HandlerResult {
  const walkthroughPath = path.join(ctx.session, facts.planStem + '.walkthrough.md');
  writePrivateOutput(walkthroughPath, renderWalkthrough(facts.view, ctx.session));
  const diagnosticsPath = diagnostics
    ? optionalDiagnostics(ctx.session, facts.fold, outcome, { manifest: ctx.manifest, deps: ctx.deps })
    : undefined;
  const complete = outcome === 'complete';
  const warning = complete && diagnostics ? retroWarning(ctx.session) : undefined;
  const counts = criterionStatusCounts(facts.statuses);
  const relative = path.relative(ctx.session, walkthroughPath).split(path.sep).join('/');
  const deviations = facts.view.edits.length + facts.view.unplannedPaths.length;
  const summary = `walkthrough ${relative}; SC verified ${counts.verified}, manual ${counts.manual}, waived ${counts.waived}, missing ${counts.missing}; deviations ${deviations}; user records ${facts.view.userRecords.length}`;
  const confirmation =
    !complete && facts.confirmationError ? '; confirmation unavailable: ' + facts.confirmationError : '';
  return {
    ok: true,
    exit: 0,
    summary: (complete ? 'complete: ' : '') + summary + confirmation + (warning ? '; ' + warning : ''),
    value: {
      ...resultValue(facts, relative),
      ...(diagnosticsPath && { diagnostics: diagnosticsPath }),
      ...(warning && { warning }),
    },
    postFold: facts.fold,
  };
}

export async function reportRender(ctx: HandlerContext): Promise<HandlerResult> {
  if (ctx.args.length) {
    throw new ToolError(1, 'invalid-input', 'report render takes no positional arguments');
  }
  const diagnostics = diagnosticsEnabled(ctx.deps.skillRoot);
  const facts = await materialize(ctx, await capture(ctx, foldLedger(ctx.session)));
  return publishReport(ctx, facts, 'rendered', diagnostics);
}

function refusal(snapshot: Snapshot): ToolError | null {
  if (snapshot.confirmationError) {
    return new ToolError(4, 'review-confirmation-required', snapshot.confirmationError);
  }
  if (snapshot.rejectionConfirmations.some((state) => state.state !== 'confirmed')) {
    return new ToolError(
      4,
      'review-confirmation-required',
      'Rejected MUST findings need explicit reviewer confirmation',
    );
  }
  if (!snapshot.integration || !snapshot.integrationPath) {
    return new ToolError(4, 'no-integration', 'No integration worktree is available');
  }
  const missing = snapshot.statuses.filter((status) => status.state === 'missing').map((status) => status.criterion);
  const dirty = snapshot.current !== null && snapshot.current.testedTree !== snapshot.current.headTree;
  if (missing.length) {
    return new ToolError(
      4,
      'criteria-unmet',
      `Missing criteria: ${missing.join(', ')}${dirty ? '; dirty checkout (integration tree differs from HEAD tree)' : ''}`,
    );
  }
  if (!snapshot.deliveredAtHead) {
    return new ToolError(4, 'undelivered', `No delivery record matches integration HEAD ${snapshot.head ?? 'unknown'}`);
  }
  const risk = snapshot.risk;
  const focus = latest(snapshot.fold, 'focus');
  const bullets: unknown = focus?.data['bullets'];
  if ((risk === 'med' || risk === 'high') && (!Array.isArray(bullets) || bullets.length < 3)) {
    return new ToolError(
      4,
      'focus-required',
      'At least three review focus bullets are required for med- or high-risk plans',
    );
  }
  return null;
}

export async function reportComplete(ctx: HandlerContext): Promise<HandlerResult> {
  if (ctx.args.length) {
    throw new ToolError(1, 'invalid-input', 'report complete takes no positional arguments');
  }
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
        reviewedCodeBaseline: snapshot.reviewedCodeBaseline,
        reviewFixes: snapshot.reviewFixes,
        reason: captured.refusal.reason,
        message: captured.refusal.message,
      },
    };
  }
  const facts = await materialize(ctx, captured.snapshot);
  return publishReport(ctx, facts, 'complete', diagnosticsEnabled(ctx.deps.skillRoot));
}
