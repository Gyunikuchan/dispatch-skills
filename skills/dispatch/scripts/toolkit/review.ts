import { INTEGRATION_REVIEW, reviewDirectory, reviewRoundDirectory, reviewRoundFile, reviewPendingFile, reviewFindingsFile, reviewGenerationDirectory, sameReviewCapture, reviewRulingSnapshot, readStoredJson, type Round, type ReviewTarget } from './review-state.ts';
import fs from 'node:fs';
import path from 'node:path';
import { nodeLinkFs, renameRetrying } from '../lib/node-fs-ext.ts';
import { atomic } from './fanout/state.ts';
import { stripBom } from '../lib/fs-ext.ts';
import type { HandlerContext, HandlerResult } from './cli.ts';
import { artifactKind } from './artifacts.ts';
import { confirmGate, foldLedger, latest, levelGate, withLedger, hasCleanupCheckpoint, type Fold } from './ledger.ts';
import { withLockFile } from './lock.ts';
import { assertHostNotSandboxed, fanOutComplete, nativeSummaryItems, parsePinsFlag, resolveSlots, underfillNote, cliWaveState, nativePendingNote, type SlotOutcome, type Validation } from './fanout.ts';
import { isUnresolvedLocus, parseReport } from './domain/report.ts';
import { effectiveSeverity, severityOf } from './domain/severity.ts';
import { parsePlan } from './domain/plan.ts';
import { structuralLines } from './domain/markdown-structure.ts';
import { parseIncrementGraph } from './domain/design.ts';
import type { Finding, ReviewKind, RosterSlot } from './domain/types.ts';
import type { InterRound } from './domain/prompt.ts';
import { changedHeadings, confirmationPrompt, reviewPrompt, type Settled } from './prompts.ts';
import { admission, finalizeRound, findingUnits, reportSeqs, isReportsClosed, rerunGranted, rerunNotesFor, renderBudget, repositoryRerunRounds, type Finalized, type FindingsValue } from './findings.ts';
import { git, gitPaths } from './git.ts';
import { CODE_TARGETS, captureReviewTarget, reviewerInputPath, specHashFor, writeReviewerInput, writeRoundSnapshots, type Capture } from './review-capture.ts';
import { carryCheckoutBaseline, compareForRound, comparedDirsFor, writeBaselineIfMissing, writeCheckoutReport } from './review-checkout.ts';
import { blockedNotice, blockedStateFor, hotUnitsNotice, userDecisions, type BlockedState } from './review-notices.ts';
import { currentRuntimeVerification, integrationRecord } from './integration-state.ts';
import { loadPlan, ownedPaths } from './plan-view.ts';
import { LEVELS, type Level } from './types.ts';
import { clipBytes, summaryWithItems, ToolError } from './output.ts';
import { redGaps } from './red.ts';
import { applicableReviewIds, loadRejections, reviewId, rejectionRequest, type RejectionRequest, type ConfirmationRound } from './confirmations.ts';
import { refreshFindingsSection, renderFindingsFile, rulingsTemplate } from './review-findings.ts';
import { coverageState } from './coverage.ts';
import { failureReasonEvidence } from './domain/blocker.ts';
import { lintCitations } from './domain/citations.ts';
import { repositoryReader } from './lint.ts';

import type { LedgerRecord } from './records.ts';
import { launches } from './writers.ts';

const label = (target: ReviewTarget) => typeof target === 'string' ? target : target.head;
const UNCHANGED_TARGET = 'none; the target is unchanged since the previous round.';
const UNCHANGED_TEXT = 'none; the governed text is unchanged since the previous round.';

// SECTION: Turn targets
// NOTE: a plan that fails lint has no parsed file entries, so its target counts zero paths; the review still reports its defects.
const planPaths = (source: string) => {const parsed = parsePlan(source); return parsed.ok ? parsed.plan.changes.map(change => change.path) : [];};
const designPaths = (source: string) => parseIncrementGraph(structuralLines(source)).increments.flatMap(increment => increment.paths);
const turnTarget = (paths: string[]) => 6 + 2 * new Set(paths).size;

async function cleanupComplete(ctx: HandlerContext, records: Fold['records'], cwd: string): Promise<boolean> {
  if (records.some(row => (row.kind === 'integrate' && row.data['phase'] === 'test-cleanup') ||
      (row.kind === 'note' && row.key === 'test-cleanup:skip'))) return true;
  try {
    const report = JSON.parse(stripBom(fs.readFileSync(path.join(ctx.session, '.state/test-cleanup.json'), 'utf8')));
    if (!Array.isArray(report?.removed) || report.removed.length || report.deleted !== 0 || report.merged !== 0) return false;
    const status = await git(ctx.deps, cwd, ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all']);
    return status.exit === 0 && !status.stdout;
  } catch {
    // Unreadable evidence still permits review.
    return false;
  }
}

async function reviewWarning(ctx: HandlerContext, target: string, cwd: string, head: string): Promise<string> {
  const fold = foldLedger(ctx.session);
  if (target === 'worktree' && latest(fold, 'bind')?.data['plan'] &&
      fold.records.some(row => row.kind === 'integrate' && row.data['phase'] === 'done'))
    return 'implement code review targets integration, not worktree';
  if (target !== 'integration') return '';
  const opened = integrationRecord(fold)!;
  // Use the delivery proof rule so a subsequent cleanup commit preserves verification.
  const warnings: string[] = [];
  if (!currentRuntimeVerification(fold, opened.seq))
    warnings.push('no current runtime verification recorded before integration review');
  if (!(await cleanupComplete(ctx, fold.records, cwd)) &&
      !(await hasCleanupCheckpoint(ctx.session, fold, ctx.deps, cwd, head)))
    warnings.push('no test cleanup recorded before integration review');
  return warnings.join('; ');
}

export async function reviewRun(ctx: HandlerContext): Promise<HandlerResult> {
  const {session, manifest, deps} = ctx;
  if (ctx.args.length !== 1) throw new ToolError(1, 'invalid-input', 'One review target is required: ' + CODE_TARGETS + '; plan and design targets are artifact paths');
  const requested = ctx.args[0]!;
  const inferred = artifactKind(requested);
  const kind = (ctx.values['kind'] ?? (inferred === 'plan' || inferred === 'design' ? inferred : 'code')) as ReviewKind;
  if (!['code', 'plan', 'design'].includes(kind)) throw new ToolError(1, 'invalid-input', 'Review kind must be code, plan or design');
  const fold = foldLedger(session);
  const level = (ctx.values['level'] ?? latest(fold, 'level')?.data['level'] ?? 'medium') as Level;
  if (!LEVELS.includes(level)) throw new ToolError(1, 'invalid-input', 'Unknown level');
  const gate = levelGate(fold, level);
  if (!gate.allowed) throw new ToolError(4, gate.reason!, gate.reason!);
  const confirmInput = ctx.values['spec'] ?? latest(fold, 'bind')?.data['spec'];
  if (kind !== 'code') {
    // Refuse before the zero-round skip so plan/design review never bypasses confirmation.
    if (typeof confirmInput !== 'string') throw new ToolError(4, 'lint-errors', 'Review needs --spec or a bound spec');
    const confirmation = confirmGate(fold, specHashFor(manifest.repositoryRoot, confirmInput));
    if (!confirmation.allowed) throw new ToolError(4, confirmation.reason!, confirmation.reason!);
  }
  const pins = parsePinsFlag(ctx.values['pins']);
  const roster = resolveSlots(kind, level, deps, pins), cap = roster.rounds;
  const nativeFailures = ctx.nativeFailures ?? [];
  assertHostNotSandboxed(deps, roster, nativeFailures.length > 0);
  const noReviewer = () => cap > 0 ? 'No live or usable reviewer is configured for this review; restore a provider or configure one' + underfillNote(roster) : 'Review at ' + level + ' has no reviewers; raise the level to continue';
  const artifact = kind === 'code' ? requested : path.resolve(manifest.repositoryRoot, requested);
  const bound = latest(fold, 'bind');
  let taskTarget = false;
  if (kind === 'code' && bound && requested !== 'integration' && requested !== 'worktree' && !requested.includes('..')) {
    try {taskTarget = loadPlan(session, manifest).tasks.some(task => task.id === requested);}
    catch (error) {
      // An unusable plan cannot classify tasks, but standalone revision review still works.
      if (!(error instanceof ToolError && error.reason === 'lint-errors') &&
          !['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  const gitTarget = kind === 'code' && requested !== 'integration' && !taskTarget;
  // Worktree rounds count per HEAD, so a commit starts a new series instead of inheriting an older change's cap.
  let series = '';
  if (requested === 'worktree') {
    const head = await git(deps, manifest.repositoryRoot, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
    if (head.exit) throw new ToolError(1, 'invalid-input', 'Cannot resolve revision HEAD; ' + CODE_TARGETS);
    series = '@' + head.stdout.trim();
  }
  const review = reviewId(kind,artifact,gitTarget?series:undefined);
  const rejectionStates=()=>loadRejections(session,foldLedger(session),[review]);
  const initialRejections=rejectionStates();
  if(initialRejections.some(state=>state.state==='escalated'))throw new ToolError(4,'escalation-open','Resolve the disputed MUST rejection before another confirmation round');
  const directory = reviewDirectory(session, review);
  fs.mkdirSync(directory, {recursive: true});

  const capture = () => captureReviewTarget(ctx, kind, artifact, requested, taskTarget, gitTarget);

  // Coverage applies to the integration review alone; every admission caller passes the same predicate.
  const applies = review === INTEGRATION_REVIEW ? applicableReviewIds(manifest, fold).get(review) : undefined;
  return withLockFile(path.join(directory, 'claim'), 'review', deps, 0, async () => {
    const {budget: admitted, rounds} = admission(session, foldLedger(session), review, cap, applies), n = admitted.nextRound, cap1 = admitted.cap;
    // Computed once after the slots exist: every return path reports the same blocked state.
    let blockedState: BlockedState | undefined;
    const blockedStateOf = (): BlockedState => blockedState ??= blockedStateFor(directory, n);
    const publicBlocked = () => blockedStateOf().blocked.map(({slot, provider, model, reason}) => ({slot, provider, model, reason}));
    // The corrected severity of a finding, from every ruling recorded for it.
    const effective = (finding: Finding, rows: readonly LedgerRecord[]) => effectiveSeverity(finding, rows.filter(row => row.data['subject'] === 'review:' + review + ':' + finding.id));
    // A fresh review may skip at a zero-round level; an existing review runs the saved-cap checks below.
    if (!cap && !rounds) return {ok: true, exit: 0, value: {skipped: true}, summary: 'review skipped at ' + level};
    // An incomplete round is reused before the ceiling checks; the round-cap predicate still applies.
    if (admitted.state === 'escalation-open') throw new ToolError(4, 'escalation-open', 'Resolve the review ceiling escalation before another round');
    if (admitted.state === 'requires-continuation') throw new ToolError(4, 'round-cap', 'Review reached round cap ' + cap1);
    if (admitted.state === 'requires-ceiling-resolution') {
      const id = 'ceiling:' + review + ':' + admitted.ceiling;
      await withLedger(session, 'review ceiling', deps, async tx => {
        await tx.append({kind: 'escalation', by: 'tool', key: id, data: {id, state: 'open', summary: 'ceiling ' + admitted.ceiling + ' reached'}});
      });
      throw new ToolError(4, 'review-ceiling', 'Review reached ceiling ' + admitted.ceiling + '; resolve the review escalation before another round');
    }
    if (admitted.coverage?.state === 'unreadable') throw new ToolError(4, 'coverage-required', 'Cannot establish coverage for ' + review);
    // NOTE: a started all-failed round has no findings.json and counts as neither complete nor incomplete, so its reuse skips the new-round decision.
    if (admitted.state === 'requires-coverage-decision') throw new ToolError(4, 'coverage-decision', 'Coverage stays open for ' + (admitted.coverage?.state === 'readable' ? admitted.coverage.open.join(', ') : review) + '; ask the user to accept reduced coverage (user escalation coverage:' + review + ':<key>, summary "accept: <slot>[, <slot>]")' + (n > admitted.ceiling ? '; no round fits within ceiling ' + admitted.ceiling : ' or grant one more coverage round (summary "grant: <reason>")') + ', with their quote');
    // A zero-round level reuses an incomplete round or pending rejection's saved source slots, but refuses a new unstaffed round.
    const existingRound = readStoredJson<Round>(reviewRoundFile(reviewRoundDirectory(directory, n)));
    if (!cap && !existingRound && !rejectionStates().some(state => state.state === 'pending'))
      throw new ToolError(4, 'level-unapproved', 'Review at ' + level + ' has no reviewers; raise the level to continue');
    const dir = reviewRoundDirectory(directory, n);
    const current = await capture();
    fs.mkdirSync(dir, {recursive: true});
    const roundFile = reviewRoundFile(dir), pendingFile = reviewPendingFile(dir);
    let round = readStoredJson<Round>(roundFile);
    if (series && '@' + (current.target as {base: string}).base !== series) throw new ToolError(4, 'target-moved', 'HEAD moved before worktree capture');
    const warning = kind === 'code' && (requested === 'integration' || requested === 'worktree')
      ? await reviewWarning(ctx, requested, current.cwd, label(current.target)) : '';
    const warningPrefix = warning ? 'warning: ' + warning + '; ' : '';
    const warningValue = warning ? {warning} : {};
    const prior: FindingsValue[] = [], priorTargets: Record<number, ReviewTarget> = {}, confirmationRounds:ConfirmationRound[]=[];
    for (let i = 1; i < n; i++) {
      const value = readStoredJson<FindingsValue>(reviewFindingsFile(reviewRoundDirectory(directory, i)));
      const metadata = readStoredJson<Round>(reviewRoundFile(reviewRoundDirectory(directory, i)));
      if (value && metadata) {prior.push(value); priorTargets[i] = metadata.target;confirmationRounds.push({review,metadata,findings:value});}
    }
    const rulingRows = () => foldLedger(session).records.filter(row => row.kind === 'ruling' && row.data['subject'].startsWith('review:' + review + ':'));
    const rulingSnapshot = () => reviewRulingSnapshot(review, prior, rulingRows());
    const settledRulings=rulingRows(),settledRejections=rejectionStates();
    const settled: Settled[] = prior.flatMap(value => value.findings.flatMap(finding => {
      const ruling = settledRulings.findLast(row => row.data['subject'] === 'review:' + review + ':' + finding.id);
      const state=settledRejections.find(state=>state.request.finding===finding.id);
      return ruling ? [{id: finding.id, locus: finding.locus, defect: finding.defect, severity:effective(finding,settledRulings),...(state?{rejectionConfirmed:state.state==='confirmed'}:{}),ruling: ruling.data['ruling'], reason: ruling.data['rationale']}] : [];
    }));

    // Maps are per-session, keyed by artifact basename (phase-named); code reviews never receive one because the pre-change map is stale for code.
    const contextMapFile = kind === 'code' ? undefined : path.join(session, path.basename(artifact).replace(/\.md$/, '.context.md'));
    const savedSlot = (name: string) => [...confirmationRounds.flatMap(value => value.metadata.roster), ...(round?.roster ?? [])].find(slot => slot.slot === name);
    // A confirmation-only round re-uses the previous target, so later rounds anchor
    // target selection and decisive rulings to the latest substantive round.
    const confirmationOnly = (value: ConfirmationRound) => /\(confirmation-only\)/i.test((value.metadata as {scope?: string}).scope ?? '');
    const latestSubstantive = (): ConfirmationRound | undefined => n > 1
      ? confirmationRounds.filter(value => value.metadata.round < n && !confirmationOnly(value)).at(-1) : undefined;
    const decisiveRound = (value: ConfirmationRound | undefined): boolean => {
      if (!value) return false;
      const rulings = rulingRows();
      return value.findings.findings.some(finding => rulings.findLast(row => row.data['subject'] === 'review:' + review + ':' + finding.id)?.data['ruling'] === 'accepted'
        && (effective(finding, rulings) === 'MUST' || (effective(finding, rulings) === 'SHOULD' && value.metadata.round < cap1)));
    };
    function isRerunRound(): boolean {
      if (n <= 1) return false;
      const fold = foldLedger(session);
      if (!repositoryRerunRounds(fold, review).includes(n - 1)) return false;
      if (!rerunNotesFor(fold, review, n - 1).length) return false;
      // The decision binds to the report it acknowledges: a stale decision
      // for an earlier report under a reused number grants nothing for the
      // current one.
      if (!rerunGranted(session, fold, review, n - 1)) return false;
      // The close decision binds to the actual report acknowledged: a later
      // report under a reused round number still admits the rerun, including
      // the equal-seq case with no intervening ledger record.
      const seqs = reportSeqs(session, review, n - 1);
      if (!seqs.length) return false;
      if (isReportsClosed(fold, review, n - 1, seqs)) return false;
      return true;
    }
    function replacement(): { targets: readonly RosterSlot[]; narrowed: boolean; coverage?: 'open' | 'full' } {
      if (pins) return {targets: roster.targets, narrowed: false};
      const previous = latestSubstantive();
      // A rerun note admits its named round + 1 at whole-target scope with every
      // logical target of the named round on its current route. Earlier findings stay
      // in `prior`; the next round uses normal targets.
      if (isRerunRound()) {
        const logical = previous?.metadata.roster.filter(slot => !slot.reserve) ?? [];
        if (logical.length) return {targets: logical, narrowed: false};
        // An all-failed named round has no findings and no confirmation
        // round: its saved round.json keeps the roster for the same
        // whole-target rerun, and its failed report stays open until that
        // rerun finalizes.
        const failedRound = readStoredJson<Round>(reviewRoundFile(reviewRoundDirectory(directory, n - 1)));
        const failedLogical = failedRound?.roster.filter(slot => !slot.reserve) ?? [];
        if (failedLogical.length) return {targets: failedLogical, narrowed: false};
      }
      const target = previous?.metadata.roster.find(slot => !slot.reserve);
      const decisive = decisiveRound(previous);
      // Open coverage replaces the narrowed slot, and a decisive finding keeps the full roster; both run at whole-target scope.
      const open = review === INTEGRATION_REVIEW ? coverageState(session, foldLedger(session), review, applies).open : [];
      if (open.length && n > 1) return {targets: target && !decisive ? open.flatMap(name => { const slot = savedSlot(name); return slot ? [{...slot, reserve: false}] : []; }) : roster.targets, narrowed: false, coverage: target && !decisive ? 'open' : 'full'};
      return {targets: target && !decisive ? [target] : roster.targets, narrowed: !!target && !decisive};
    }
    // Accepted findings that no reviewer has checked yet: accepted after the latest round that reviewed a target.
    function acceptedSinceReview(): InterRound['accepted'] {
      const window = latestSubstantive()?.metadata.startSeq;
      if (window === undefined) return [];
      const rows = rulingRows();
      return prior.flatMap(value => value.findings.flatMap(finding => {
        const ruling = rows.findLast(row => row.data['subject'] === 'review:' + review + ':' + finding.id);
        return ruling?.data['ruling'] === 'accepted' && ruling.seq > window ? [{id: finding.id, locus: finding.locus}] : [];
      }));
    }
    // NOTE: a failed diff never refuses the round; REQ-4 keeps every gate, so extra information adds none.
    async function interRoundDiff(captured: Capture, confirmationOnlyRound: boolean): Promise<string> {
      if (confirmationOnlyRound) return UNCHANGED_TARGET;
      try {
        const previous = readStoredJson<Round>(reviewRoundFile(reviewRoundDirectory(directory, n - 1)));
        if (!previous) return 'unavailable.';
        if (kind === 'code') return label(previous.target) === label(captured.target) ? UNCHANGED_TARGET : '`git diff ' + label(previous.target) + ' ' + label(captured.target) + '`';
        const before = reviewerInputPath(directory, n - 1), after = reviewerInputPath(directory, n);
        if (!fs.existsSync(before) || !fs.existsSync(after)) return 'unavailable.';
        if (fs.readFileSync(before).equals(fs.readFileSync(after))) return UNCHANGED_TEXT;
        const result = await git(deps, directory, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', before, after]);
        // --no-index also exits 1 on an inaccessible path, so exit 1 needs output.
        if (result.exit !== 1 || !result.stdout) return 'unavailable.';
        const file = path.resolve(dir, 'inter-round.diff');
        fs.writeFileSync(file, result.stdout);
        return '`' + file + '` (unified diff of the governed text)';
      } catch { return 'unavailable.'; }
    }
    async function start(generation: number, captured: Capture): Promise<Round> {
      const rerun = isRerunRound();
      const {targets, narrowed, coverage} = replacement(); const requests=rejectionStates().filter(state=>state.state==='pending').map(state=>rejectionRequest({...state.request,target:captured.target,spec:captured.spec}));
      const previousRound = n > 1 ? confirmationRounds.find(value => value.metadata.round === n - 1) : undefined;
      // The fast path needs the captured identity the previous round reviewed; a
      // rerun, coverage grant, decisive ruling or moved target keeps the standard prompt.
      const confirmationOnlyRound = n > 1 && !rerun && !coverage && requests.length > 0 && !decisiveRound(latestSubstantive())
        && previousRound !== undefined && sameReviewCapture(previousRound.metadata as Round, captured);
      let scope = 'Full review', changedPaths = captured.changed; const changedHeadingsSince = (round: number): string[] => {const snapshot = path.join(reviewRoundDirectory(directory, round), 'target.snapshot.md'); return kind !== 'code' && captured.source !== undefined && fs.existsSync(snapshot) ? changedHeadings(fs.readFileSync(snapshot, 'utf8'), captured.source) : [];};
      if (confirmationOnlyRound) {
        scope = `Re-review round ${n} (confirmation-only) — comparison: ${label(priorTargets[n - 1]!)}..${label(captured.target)}`;
      } else if (rerun && !coverage) {
        const comparison = typeof captured.target === 'string' ? captured.target : (captured.target as {base: string}).base + '..' + label(captured.target); scope += kind === 'code' ? ' — changed paths: ' + captured.changed.join(', ') + '; comparison: ' + comparison : (changed => changed.length ? ' — changed: ' + changed.join(', ') + '; comparison: ' + comparison : ' — comparison: ' + comparison)(changedHeadingsSince(n - 1));
      } else if (coverage) scope = `Re-review round ${n} (coverage) — changed paths: ${captured.changed.join(', ')}; comparison: ${(captured.target as {base: string}).base}..${label(captured.target)}`;
      else if (n > 1) {
        changedPaths = kind === 'code' ? await gitPaths(deps, manifest.repositoryRoot, ['diff', '--name-only', '-z', label(priorTargets[n - 1]!), label(captured.target)]) : [];
        const changed = kind === 'code' ? 'changed paths: ' + changedPaths.join(', ') : (headings => headings.length ? 'changed: ' + headings.join(', ') : '')(changedHeadingsSince(n - 1)); scope = `Re-review round ${n} (full) — ${changed ? changed + '; ' : ''}comparison: ${label(priorTargets[n - 1]!)}..${label(captured.target)}`;
      } else if (kind === 'code') {
        const target = captured.target as {base: string; head: string};
        scope += ' — changed paths: ' + captured.changed.join(', ') + '; comparison: ' + target.base + '..' + target.head;
      }
      // Narrowing reads the previous round's own findings: a MUST accepted there, or a SHOULD accepted before the cap, keeps the full roster.
      if (narrowed && !confirmationOnlyRound) scope = scope.replace('(full)', '(narrowed)');
      const turnPaths = kind === 'code' ? changedPaths : kind === 'plan' ? planPaths(captured.source!) : designPaths(captured.source!);
      let slots: RosterSlot[];
      if (confirmationOnlyRound) {
        // Only the assigned source slots and configured reserves are staffed; the
        // reserves answer the source slot's own prompt when that slot fails.
        const resolved: RosterSlot[] = [];
        for (const source of [...new Set(requests.flatMap(request => request.sourceSlots))]) {
          const saved = savedSlot(source);
          if (!saved) throw new ToolError(4, 'review-confirmation-required', 'Missing original reviewer slot ' + source);
          if (!resolved.some(slot => slot.slot === source)) resolved.push({...saved, reserve: false});
        }
        slots = [...resolved, ...roster.reserves.filter(reserve => !resolved.some(slot => slot.slot === reserve.slot))];
      } else {
        slots = [...targets, ...roster.reserves.filter(reserve => !targets.some(slot => slot.slot === reserve.slot))];
        for (const request of requests) for (const source of request.sourceSlots) if (!slots.some(slot => slot.slot === source && !slot.reserve)) {
          const saved = savedSlot(source);
          if (!saved) throw new ToolError(4, 'review-confirmation-required', 'Missing original reviewer slot ' + source);
          const existing = slots.findIndex(slot => slot.slot === source); if (existing >= 0) slots.splice(existing, 1);
          slots.push({...saved, reserve: false});
        }
      }
      const contextMapPath = contextMapFile && fs.existsSync(contextMapFile) ? contextMapFile : undefined;
      const value: Round = {round: n, generation, cap: cap1, level, pins: (ctx.values['pins'] as string | undefined) ?? null, roster: slots, requests,rulingSnapshot:rulingSnapshot(),scope, startSeq: foldLedger(session).lastSeq, spec: captured.spec, target: captured.target, turnTarget: turnTarget(turnPaths), ...(contextMapPath?{contextMapPath}:{}), ...(captured.artifactPath?{artifactPath:captured.artifactPath}:{}),...(captured.artifacts?{artifacts:captured.artifacts}:{}),...(roster.underfill?{underfill:roster.underfill}:{}),...(coverage?{coverage}:{}),...(admitted.coverage?.state==='readable'&&admitted.coverage.use?{coverageUse:admitted.coverage.use}:{})};
      if (!slots.some(entry => !entry.reserve)) throw new ToolError(4, 'level-unapproved', noReviewer());
      // The reviewer input is governed text only; artifactHash and review identity keep the original artifact.
      if ((kind === 'plan' || kind === 'design') && captured.source !== undefined) writeReviewerInput(directory, n, kind, captured.source);
      if (n > 1) value.interRound = {diff: await interRoundDiff(captured, confirmationOnlyRound), accepted: acceptedSinceReview()};
      fs.mkdirSync(reviewGenerationDirectory(dir, generation), {recursive: true});
      writeRoundSnapshots(dir, kind, captured);
      atomic(roundFile, value);
      return value;
    }

    const assertCitations = (source: string | undefined) => {
      if ((kind !== 'plan' && kind !== 'design') || source === undefined) return;
      const defects = lintCitations(source, kind, repositoryReader(manifest.repositoryRoot));
      if (defects.length) throw new ToolError(4, 'lint-errors', JSON.stringify(defects));
    };

    async function supersede(captured: Capture) {
      assertCitations(captured.source);
      const staffed = replacement().targets.some(slot => !slot.reserve)
        || rejectionStates().filter(state => state.state === 'pending').some(state => state.request.sourceSlots.some(source => confirmationRounds.some(round => round.metadata.roster.some(slot => slot.slot === source))));
      if (!staffed) throw new ToolError(4, 'level-unapproved', noReviewer());
      const previousGeneration = round!.generation;
      const pending = readStoredJson<Finalized>(pendingFile);
      if (pending) {
        await withLedger(session, 'review supersede', deps, async tx => {
          for (const escalation of pending.escalations) {
            if(String(escalation.data['id']).startsWith('rejection:'))continue;
            if (!tx.fold.records.some(row => row.key === escalation.key)) continue;
            await tx.append({kind: 'escalation', by: 'tool', key: escalation.key + ':superseded', data: {id: escalation.data['id'], state: 'resolved', summary: 'superseded: target moved'}});
          }
        });
        fs.rmSync(pendingFile, {force: true});
      }
      carryCheckoutBaseline(dir, previousGeneration);
      round = await start(previousGeneration + 1, captured);
      // A change made before target movement reaches a later compare: a carried
      // baseline also lists the target's own change, which the orchestrator explains.
    }
    const hadPending = fs.existsSync(pendingFile);
    if (!round) {
      if (!hadPending) assertCitations(current.source);
      round = await start(1, current);
    }
    else if (!sameReviewCapture(round, current) || (round.rulingSnapshot!==undefined && round.rulingSnapshot!==rulingSnapshot())) {
      await supersede(current);
      if (hadPending) throw new ToolError(4, 'target-moved', 'Review target moved during finalization');
    }
    // Plan and design reviewers read governed text only; a resumed round reuses the same path and bytes.
    let reviewerArtifact = artifact;
    if (kind === 'plan' || kind === 'design') {
      const inputPath = reviewerInputPath(directory, n);
      if (!fs.existsSync(inputPath)) {
        if (current.source === undefined) throw new ToolError(2, 'review-failed', 'Cannot write reviewer input ' + inputPath + ': missing source');
        writeReviewerInput(directory, n, kind, current.source);
      }
      reviewerArtifact = inputPath;
    }
    let pending = readStoredJson<Finalized>(pendingFile);
    const ignoredFailureReports: string[] = [];
    const computeUnits = () => {
      const rows = rulingRows();
      const rounds = Array.from({length: n}, (_, i) => {
        const number = i + 1;
        const value = number === n ? pending : prior.find(item => item.round === number);
        const metadata = number === n ? round : readStoredJson<Round>(reviewRoundFile(reviewRoundDirectory(directory, number)));
        let text: string | undefined;
        if (kind !== 'code') {try {text = fs.readFileSync(reviewerInputPath(directory, number), 'utf8');} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}}
        return {findings: value?.findings ?? [], ...(text === undefined ? {} : {text}), startSeq: metadata?.startSeq ?? 0};
      });
      const bind = latest(foldLedger(session), 'bind');
      return findingUnits({kind, round: n, rounds, planPath: bind ? path.relative(manifest.repositoryRoot, path.resolve(manifest.repositoryRoot, String(bind.data['plan']))) : '', ruling: (id, seq) => rows.findLast(row => row.seq <= seq && row.data['subject'] === 'review:' + review + ':' + id)?.data['ruling'] as string | undefined});
    };
    const fanoutDir = reviewGenerationDirectory(dir, round.generation);
    const observeRecovery = review === INTEGRATION_REVIEW && typeof round.target !== 'string' ? deps.recovery?.(
      ctx.values['resume-ref'], {review, target: round.target, round: n, generation: round.generation}, fanoutDir,
    ) : undefined;
    if (!pending) {
      const bind = latest(foldLedger(session), 'bind');
      const requestsBySlot=new Map<string,RejectionRequest[]>();
      for(const request of round.requests ?? [])for(const slot of request.sourceSlots)requestsBySlot.set(slot,[...(requestsBySlot.get(slot) ?? []),request]);
      const targets = round!.roster.filter(entry => !entry.reserve);
      const confirmationRound = round!.scope.includes('(confirmation-only)');
      const interRound = round!.interRound ? {interRound: round!.interRound} : {};
      // Decisions use the round's own start: a re-entered round keeps the list it first received.
      const decisions = userDecisions(foldLedger(session).records, review, round!.startSeq);
      const prompt = (slot:RosterSlot)=>{
        if (confirmationRound) return confirmationPrompt(kind, {...interRound, spec: round!.spec, artifact: reviewerArtifact, target: round!.target, cwd: current.cwd, scope: round!.scope, taskSummary: current.taskSummary,
          ...(bind?.data['plan'] ? {planPath: path.resolve(manifest.repositoryRoot, bind.data['plan'])} : {}), requests: requestsBySlot.get(slot.slot) ?? [], settled: decisions});
        const position=targets.findIndex(entry=>entry.slot===slot.slot);
        return reviewPrompt(kind, {skillRoot: deps.skillRoot, spec: round!.spec, artifact: reviewerArtifact, scope: round!.scope, taskSummary: current.taskSummary, turnTarget: round!.turnTarget,
          ...(round!.contextMapPath ? {contextMapPath: round!.contextMapPath} : {}),
          ...(bind?.data['plan'] ? {planPath: path.resolve(manifest.repositoryRoot, bind.data['plan'])} : {}), settled: [...settled, ...decisions],...interRound,requests:requestsBySlot.get(slot.slot) ?? [], rotation:position<0?0:position, round:round!.round});
      };
      const validate = (text: string,logicalSlot:string): Validation => {
        const parsed = parseReport({kind, source: logicalSlot, text,expectedRequestIds:(requestsBySlot.get(logicalSlot) ?? []).map(request=>request.requestId)});
        if (parsed.ok) return {ok: true};
        if (parsed.failure.kind === 'blocked') {
          const blocked = failureReasonEvidence(parsed.failure.detail.trim());
          return {ok: false, cls: 'blocked', reason: 'blocked: ' + blocked.reason, blocked};
        }
        const cls = parsed.failure.kind === 'uncovered-scope' ? 'no-report' : parsed.failure.kind;
        return {ok: false, cls, reason: parsed.failure.kind + ': ' + parsed.failure.detail};
      };
      // NOTE: the entry precedes the failed slot file; coverage state reads a failed file without an entry as unreadable.
      const onFailed = (slot: string, outcome: {cls: string}) => { const file = path.join(reviewGenerationDirectory(dir, round!.generation), 'attempts.json');
        atomic(file, [...(readStoredJson<object[]>(file) ?? []), {slot, seq: foldLedger(session).lastSeq, wholeTarget: round!.scope.startsWith('Full review') || round!.coverage !== undefined, outcome: outcome.cls}]); };
      const replies = await fanOutComplete({dir: fanoutDir, slots: round.roster, prompt, validate, cwd: current.cwd, sessionRoot: session, onFailed,
        nativeFirstProviders: roster.nativeFirstProviders, nativeFailures,
        onIgnoredReport: attempt => { ignoredFailureReports.push(attempt); }}, deps);
      observeRecovery?.(replies);
      const captured = await capture();
      if (!sameReviewCapture(round, captured) || round.rulingSnapshot!==rulingSnapshot()) {await supersede(captured); throw new ToolError(4, 'target-moved', 'Review target or ruling moved during fan-out');}
      // fanOut never returns a fallback marker, so every native here is launchable.
      const native = replies.filter((reply): reply is Extract<SlotOutcome, {state: 'native'}> => reply.state === 'native');
      if (native.length) {
        // A round that returns a native descriptor saves a baseline of each
        // compared directory before native launch, keeping any existing file.
        // Every native descriptor triggers the change check, including
        // native-only voices, which run with the same write-capable boundary.
        const {dirs: baselineDirs} = comparedDirsFor(session, manifest.repositoryRoot, current.cwd, taskTarget, requested);
        await writeBaselineIfMissing(dir, round.generation, baselineDirs, session, deps);
        const state = blockedStateOf(), notice = blockedNotice(state.blocked, state.blockers);
        const wave = cliWaveState(fanoutDir);
        return {ok: false, exit: 4, reason: 'native-pending', value: {review, round: n, pending: native, ...warningValue, ...(wave !== undefined ? {cliWave: wave} : {}), ...(ignoredFailureReports.length ? {ignoredFailureReports} : {}), ...(state.blocked.length ? {blocked: publicBlocked()} : {}), ...(state.blockers.length ? {blockers: state.blockers} : {}), ...(round.underfill ? {underfill: round.underfill} : {})}, summary: summaryWithItems(warningPrefix + 'review ' + review + ': ' + nativePendingNote(native.length, wave) + (notice ? '; ' + notice : '') + underfillNote(round), nativeSummaryItems(native))};
      }
      // A capture or compare failure never blocks finalization: it keeps all
      // replies and reports repositoryCheck. Runs after the existing same check,
      // so target-moved wins.
      const {dirs: compareDirs, absentWorktree} = comparedDirsFor(session, manifest.repositoryRoot, captured.cwd, taskTarget, requested);
      const checkout = {...(await compareForRound(dir, round.generation, compareDirs, session, absentWorktree, deps)), asOfSeq: foldLedger(session).lastSeq};
      // An all-failed open-only or narrowed integration round finalizes as used, so its open slots get a whole-target rerun; a full-roster round keeps its number.
      if (!replies.some(reply => reply.state === 'done') && round.coverage !== 'open' && !(review === INTEGRATION_REVIEW && /^Re-review round \d+ \(narrowed\)/.test(round.scope))) {
        const state = blockedStateOf(), notice = blockedNotice(state.blocked, state.blockers);
        const changedPaths = (checkout.repositoryChanges ?? []).flatMap(entry => entry.paths).sort();
        const changedSuffix = changedPaths.length ? '; repository changes: ' + changedPaths.join(', ') : '';
        const checkSuffix = checkout.repositoryCheck ? '; repository check unavailable: ' + checkout.repositoryCheck.reason : '';
        const ignoredSuffix = ignoredFailureReports.length ? '; ignored reports: ' + ignoredFailureReports.join(', ') : '';
        const failedSummary = (notice ? notice + '; ' : '') + 'Every review slot failed' + underfillNote(round) + changedSuffix + checkSuffix + ignoredSuffix;
        try {
          writeCheckoutReport(dir, round.generation, checkout);
        } catch (error) {
          throw new ToolError(2, 'review-failed', failedSummary + '; checkout report unavailable: ' + (error instanceof Error ? error.message : String(error)));
        }
        throw new ToolError(2, 'review-failed', failedSummary);
      }
      const changedSince: Record<number, string[]> = {}, owners: Record<string, string[]> = {};
      if (kind === 'code' && requested === 'integration') {
        for (const [number, target] of Object.entries(priorTargets)) changedSince[Number(number)] = await gitPaths(deps, manifest.repositoryRoot, ['diff', '--name-only', '-z', label(target), label(round.target)]);
        const plan = loadPlan(session, manifest);
        for (const task of plan.tasks) owners[task.id] = ownedPaths(plan, task.id);
      }
      pending = finalizeRound({review, round: n, generation: round.generation, cap: round.cap, level: round.level, startSeq: round.startSeq, replies,
        prior, priorTargets, changedSince, owners, escalationRecords:foldLedger(session).records.filter(row=>row.kind==='escalation'),rulings: rulingRows(), kind, artifact, target: round.target,requests:round.requests ?? [],confirmationRounds,spec:round.spec,roster:round.roster,
        ...(checkout.repositoryChanges ? {repositoryChanges: checkout.repositoryChanges} : {}),
        ...(checkout.repositoryCheck ? {repositoryCheck: checkout.repositoryCheck} : {})});
      try {
        writeCheckoutReport(dir, round.generation, checkout);
      } catch {
        // Best effort; findings.json already carries the report.
      }
      if (kind === 'code' && !gitTarget) {
        const plan = loadPlan(session, manifest), currentFold = foldLedger(session);
        const bind = latest(currentFold, 'bind')!;
        const tasks = requested === 'integration' ? [...new Set(currentFold.records.filter(row => row.kind === 'integrate' && row.data['phase'] === 'done').map(row => row.data['task'] as string))] : [requested];
        let redCount = 0;
        for (const task of tasks) {
          const integrated = currentFold.records.findLast(row => row.kind === 'integrate' && row.data['phase'] === 'done' && row.data['task'] === task);
          const launch = launches(currentFold, task).findLast(launch => launch.finished && (requested !== 'integration' || launch.finished.seq < (integrated?.seq ?? 0)));
          const reportFile = path.join(session, '.state/briefs', task + '-' + launch?.launch + '.report.md');
          const report = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, 'utf8') : undefined;
          const taskCriteria = plan.tasks.find(candidate => candidate.id === task)?.criteria;
          const redCriteria = plan.criteria.filter(criterion => taskCriteria?.includes(criterion.id) && criterion.evidence === 'red' && criterion.red && !criterion.redException);
          const redExits = new Map<string, number | null>();
          for (const criterion of redCriteria) {
            let wrapper: {status?: unknown} | null;
            try { wrapper = readStoredJson(path.join(session, '.state/briefs', task + '-' + launch?.launch + '.red', criterion.id + '.exit')); }
            catch (error) { if (error instanceof SyntaxError) continue; throw error; }
            if (wrapper && (typeof wrapper.status === 'number' || wrapper.status === null)) redExits.set(criterion.id, wrapper.status);
          }
          for (const gap of redGaps({plan, task, changed: captured.changed, report, redExits})) {
            const defect = 'missing-red: ' + task + ' ' + gap.criterion;
            const priorGaps = [...prior].reverse().flatMap(value => value.findings.map(finding => ({round: value.round, finding})))
              .filter(value => value.finding.defect.startsWith(defect + ';'));
            if (priorGaps.some(({finding}) => settledRulings.some(row => row.data['subject'] === 'review:' + review + ':' + finding.id && row.data['ruling'] === 'rejected'))) continue;
            const file = path.resolve(manifest.repositoryRoot, bind.data['plan']);
            const finding: Finding & {unresolved?: {of: string}} = {
              id: 'R' + n + '-RED' + String(++redCount).padStart(2, '0'), impact: 'degrades', trigger: 'realistic', severity: severityOf('degrades', 'realistic'), category: 'testing',
              locus: file + ':L' + gap.line, defect: defect + '; Tests touched: ' + (gap.testsTouched ? 'yes' : 'no'),
              requiredChange: "Show the criterion's test failing before the fix in the writer report", sources: ['tool'], scope: 'in', origin: n === 1 ? 'original' : 'unknown',
            };
            const previous = priorGaps[0];
            if (previous) {
              const previousTarget = priorTargets[previous.round];
              const changed = requested === 'integration'
                ? (changedSince[previous.round] ?? []).some(file => ownedPaths(plan, task).includes(file))
                : typeof previousTarget !== 'string' && previousTarget?.head !== (round.target as {head: string}).head;
              if (changed) {
                const id = 'missing-red:' + review + ':' + task + ':' + gap.criterion + ':R' + n + ':g' + round.generation;
                pending.escalations.push({kind: 'escalation', by: 'tool', key: id, data: {id, state: 'open', summary: finding.defect}});
              } else finding.unresolved = {of: previous.finding.id};
            }
            pending.findings.push(finding);
            const cluster = pending.clusters.find(cluster => cluster.file === file);
            if (cluster) cluster.findings.push(finding.id);
            else pending.clusters.push({file, findings: [finding.id]});
          }
        }
      }
      // The finalized findings copy carries the same durable report identity as
      // the per-generation checkout report, so one per-report decision closes
      // both copies.
      pending.units = computeUnits();
      atomic(pendingFile, {...pending, asOfSeq: checkout.asOfSeq});
      await deps.hook?.('review:after-pending');
    }
    if (!pending.units) {pending.units = computeUnits(); atomic(pendingFile, pending);}
    if(round.rulingSnapshot!==rulingSnapshot()){await supersede(await capture());throw new ToolError(4,'target-moved','Review ruling moved during finalization');}
    await withLedger(session, 'review finalize', deps, async tx => {for (const escalation of pending!.escalations) await tx.append(escalation);});
    await deps.hook?.('review:after-append');
    const finalCapture = await capture();
    if (!sameReviewCapture(round, finalCapture) || round.rulingSnapshot!==rulingSnapshot()) {await supersede(finalCapture); throw new ToolError(4, 'target-moved', 'Review target or ruling moved during finalization');}
    const relativeDir = path.relative(session, dir).split(path.sep).join('/');
    const findingsFile = relativeDir + '/findings.md', rulingsFile = relativeDir + '/rulings.json';
    nodeLinkFs.writeAtomic(path.join(session, findingsFile), renderFindingsFile(pending.findings));
    atomic(path.join(session, rulingsFile), rulingsTemplate(review, n, pending.findings));
    renameRetrying(pendingFile, reviewFindingsFile(dir));
    const counts = (severity: string) => pending!.findings.filter(finding => finding.severity === severity).length;
    const recurrences = pending.findings.filter(finding => finding.recurrence).length;
    const fixInduced = pending.findings.filter(finding => finding.origin === 'fix-induced').length;
    const file = reviewFindingsFile(dir);
    let findingsSectionReason: string | undefined;
    const findings = kind === 'plan' || kind === 'design'
      ? refreshFindingsSection(session, manifest, review, reason => { findingsSectionReason = reason; })
      : null;
    const state = blockedStateOf(), blockedSummary = blockedNotice(state.blocked, state.blockers);
    const bySeverity = ['MUST', 'SHOULD', 'CONSIDER'].flatMap(severity => pending!.findings.filter(finding => finding.severity === severity));
    const unresolved = bySeverity.filter(finding => isUnresolvedLocus(finding.locus));
    // Advisory only: reporting a boundary opens no escalation and grants no round.
    const {budget} = admission(session, foldLedger(session), review, cap, applies);
    const changedPaths = (pending.repositoryChanges ?? []).flatMap(entry => entry.paths).sort();
    const changedSuffix = changedPaths.length ? `, repository changes: ${changedPaths.join(', ')}` : '';
    const checkSuffix = pending.repositoryCheck ? `, repository check unavailable: ${pending.repositoryCheck.reason}` : '';
    const countsAndFiles = ` round ${n}/${round.cap}: ${counts('MUST')} MUST, ${counts('SHOULD')} SHOULD, ${counts('CONSIDER')} CONSIDER, ${recurrences} recurrences, ${renderBudget(budget)}, ${pending.failed.length} failed slots${unresolved.length ? `, ${unresolved.length} unresolved loci` : ''}${fixInduced ? `, ${fixInduced} fix-induced` : ''}; findings ${findingsFile}; rulings ${rulingsFile}`;
    // Leave room for the cap's ellipsis if the notices push the summary over budget.
    const summaryReview = Buffer.byteLength(warningPrefix + 'review ' + review + countsAndFiles, 'utf8') > 1021 ? clipBytes(review, 40) : review;
    const countsHead = warningPrefix + 'review ' + summaryReview + countsAndFiles + (blockedSummary ? '; ' + blockedSummary : '') + underfillNote(round);
    const suffixes = changedSuffix + checkSuffix;
    const summaryHead = countsHead + hotUnitsNotice(pending.units, Buffer.byteLength(countsHead + suffixes, 'utf8')) + suffixes;
    return {
      ok: true, exit: 0,
      value: {
        path: file, review, round: n, budget, findingsFile, rulingsFile, ...warningValue,
        ...(ignoredFailureReports.length ? {ignoredFailureReports} : {}),
        ...(pending.repositoryChanges ? {repositoryChanges: pending.repositoryChanges} : {}),
        ...(pending.repositoryCheck ? {repositoryCheck: pending.repositoryCheck} : {}),
        ...(findings ? { findingsSection: findings, ...(findingsSectionReason ? { findingsSectionReason } : {}) } : {}),
        ...(state.blocked.length ? { blocked: publicBlocked() } : {}),
        ...(state.blockers.length ? { blockers: state.blockers } : {}),
        ...(round.underfill ? { underfill: round.underfill } : {}),
        // The summary is bounded, so only this list names every marked finding.
        ...(unresolved.length ? { unresolvedLoci: unresolved.map(({id, locus}) => ({id, locus})) } : {}),
      },
      summary: summaryWithItems(summaryHead,
        [...unresolved.map(finding => `${finding.id} ${finding.severity}: ${finding.locus} — ${finding.defect}`),
          ...bySeverity.filter(finding => !isUnresolvedLocus(finding.locus)).map(finding => `${finding.id} ${finding.severity}: ${finding.defect}`)]),
    };
  });
}
