import { cleanupBinding, latestCleanup, criterionStatuses, eligibility } from './evidence.ts';
import {
  containedSessionPath,
  currentHashes,
  foldLedger,
  gate,
  gitObjectId,
  hasCleanupCheckpoint,
  latest,
  levelGate,
  type Fold,
} from './ledger.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { CliDeps, HandlerContext } from './cli.ts';
import { parsePlan } from './domain/plan.ts';
import { checks } from './plan-view.ts';
import { writerStates } from './writers.ts';
import { integrationEnded, integrationRecord } from './integration-state.ts';
import { gitOk, headTree, testedTree } from './git.ts';
import { admission, type ReviewBudget } from './findings.ts';
import { contentReports, closingNotesFor, rerunNotesFor, rerunCoverSeq, coversReport } from './findings.ts';
import type { FindingsValue } from './findings.ts';
import { applicableReviewIds } from './confirmations.ts';
import { readManifest } from '../lib/session.ts';
import { captureReviewTarget } from './review-capture.ts';
import {
  INTEGRATION_REVIEW as REVIEW,
  recoveryTargetHash,
  reviewDirectory,
  reviewRoot,
  reviewRoundDirectory,
  reviewRoundFile,
  reviewFindingsFile,
  reviewGenerationDirectory,
  reviewPointer,
  sameReviewCapture,
  reviewRulingSnapshot,
  type RecoverySelection,
  type Round,
  reviewRoundEntries,
  reviewRoundNumber,
} from './review-state.ts';
import { reviewIdentity } from './review-identity.ts';
import { parsePinsFlag, type SlotOutcome } from './fanout.ts';
import type { FanoutState } from './fanout/state.ts';
import { LEVELS } from './types.ts';
import { ToolError } from './output.ts';
import { loadRejections } from './confirmations.ts';
import { effectiveSeverity } from './domain/severity.ts';

export async function statusReport(
  session: string,
  repositoryRoot: string,
  deps: CliDeps,
  fold: Fold = foldLedger(session),
) {
  const level = latest(fold, 'level')?.data['level'] ?? 'medium';
  const bound = latest(fold, 'bind')?.data ?? {};
  const current = currentHashes(repositoryRoot, bound);
  const escalations = new Map<string, Record<string, unknown>>();
  for (const record of fold.records) {
    if (record.kind === 'escalation') escalations.set(record.data['id'], record.data);
  }
  // Advisory and recomputed from the latest ledger by the launch admission policy; it opens and grants nothing.
  const root = reviewRoot(session),
    reviews: Record<string, ReviewBudget> = {};
  const openRepositoryChanges: {
    review: string;
    round: number;
    reportSeq: number;
    repositoryChanges?: unknown;
    repositoryCheck?: unknown;
    rerunPending?: true;
  }[] = [];
  for (const entry of fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : []) {
    if (!entry.isDirectory()) continue;
    const review = entry.name;
    const { budget, rounds } = admission(
      session,
      fold,
      review,
      0,
      applicableReviewIds(readManifest(session), fold).get(review),
    );
    if (rounds) reviews[review] = budget;
    const reviewDir = path.join(root, review);
    let roundDirs: string[] = [];
    try {
      roundDirs = fs.readdirSync(reviewDir);
    } catch {
      continue;
    }
    const readRoundMeta = (
      round: number,
    ): { startSeq: number; roster: string[]; scope?: string; coverage?: 'open' | 'full' } | undefined => {
      try {
        const meta = JSON.parse(fs.readFileSync(reviewRoundFile(reviewRoundDirectory(reviewDir, round)), 'utf8')) as {
          startSeq?: number;
          roster?: { slot: string; reserve?: boolean }[];
          scope?: string;
          coverage?: 'open' | 'full';
        };
        if (typeof meta.startSeq !== 'number' || !Array.isArray(meta.roster)) return undefined;
        return {
          startSeq: meta.startSeq,
          roster: meta.roster.filter((slot) => !slot.reserve).map((slot) => slot.slot),
          ...(typeof meta.scope === 'string' ? { scope: meta.scope } : {}),
          ...(meta.coverage !== undefined ? { coverage: meta.coverage } : {}),
        };
      } catch {
        return undefined;
      }
    };
    for (const roundName of roundDirs) {
      const round = reviewRoundNumber(roundName);
      if (round === undefined) continue;
      // Every content report carries its own identity; covered reports drop
      // out before the merge, so one map accumulates every unacknowledged
      // attempt and generation together with the finalized findings report.
      const contents = contentReports(session, review, round);
      if (!contents.length) continue;
      const covered = (seq: number): boolean =>
        closingNotesFor(fold, review, round).some((note) => coversReport(note, seq));
      const satisfiedFor = (seq: number): boolean => {
        if (!rerunNotesFor(fold, review, round).some((note) => rerunCoverSeq(session, review, round, note) === seq))
          return false;
        if (!fs.existsSync(reviewFindingsFile(reviewRoundDirectory(reviewDir, round + 1)))) return false;
        const opened = readRoundMeta(round + 1);
        const required = readRoundMeta(round)?.roster;
        const wholeTarget = opened?.scope?.startsWith('Full review') === true || opened?.coverage !== undefined;
        return (
          opened !== undefined &&
          required !== undefined &&
          wholeTarget &&
          opened.startSeq >=
            Math.max(
              ...rerunNotesFor(fold, review, round)
                .filter((note) => rerunCoverSeq(session, review, round, note) === seq)
                .map((note) => note.seq),
            ) &&
          required.every((target) => opened.roster.includes(target))
        );
      };
      let uncovered = contents.filter((report) => !covered(report.seq) && !satisfiedFor(report.seq));
      if (!uncovered.length) continue;
      const pathsByCwd = new Map<string, Set<string>>();
      for (const report of uncovered) {
        if (!Array.isArray(report.repositoryChanges)) continue;
        for (const change of report.repositoryChanges as { cwd?: unknown; paths?: unknown }[]) {
          if (typeof change?.cwd !== 'string' || !Array.isArray(change?.paths)) continue;
          const paths = pathsByCwd.get(change.cwd) ?? new Set<string>();
          for (const file of change.paths) if (typeof file === 'string') paths.add(file);
          pathsByCwd.set(change.cwd, paths);
        }
      }
      let check: unknown;
      for (const report of uncovered) if (report.repositoryCheck) check = report.repositoryCheck;
      const reportSeq = Math.max(...uncovered.map((report) => report.seq));
      // A rerun decision binds only its covered report, and only while round
      // r+1 is unfinalized: past that window the report stays open for a
      // repository-changes note, with no lingering rerunPending.
      const nextOpen = !fs.existsSync(reviewFindingsFile(reviewRoundDirectory(reviewDir, round + 1)));
      const covering =
        nextOpen &&
        rerunNotesFor(fold, review, round).some((note) => rerunCoverSeq(session, review, round, note) === reportSeq);
      const rerunPending = covering ? { rerunPending: true as const } : {};
      openRepositoryChanges.push({
        review,
        round,
        reportSeq,
        ...(pathsByCwd.size
          ? { repositoryChanges: [...pathsByCwd].map(([cwd, paths]) => ({ cwd, paths: [...paths].sort() })) }
          : {}),
        ...(check ? { repositoryCheck: check } : {}),
        ...rerunPending,
      });
    }
  }
  openRepositoryChanges.sort((left, right) =>
    left.review < right.review ? -1 : left.review > right.review ? 1 : left.round - right.round,
  );
  let sections: object = {};
  const opened = integrationRecord(fold);
  if (opened || fold.records.some((record) => record.kind === 'writer')) {
    let plan: import('./domain/types.ts').ParsedPlan | undefined;
    let reason = 'No bound plan';
    if (bound['plan']) {
      try {
        const parsed = parsePlan(fs.readFileSync(path.resolve(repositoryRoot, bound['plan']), 'utf8'));
        if (parsed.ok) plan = parsed.plan;
        else reason = JSON.stringify(parsed.defects);
      } catch (error) {
        reason = 'Bound plan unreadable: ' + (error as Error).message;
      }
    }
    const unavailable = { state: 'unavailable', reason };
    const observations = new Map<string, { exists: boolean; dirty: boolean; head: string }>();
    for (const record of (plan ? fold.records : []).filter(
      (record) => record.kind === 'writer' && record.data['phase'] === 'launched',
    )) {
      const relative = record.data['path'] as string;
      if (observations.has(relative)) continue;
      const cwd = path.resolve(session, relative);
      const exists = fs.existsSync(cwd);
      observations.set(relative, {
        exists,
        dirty: exists ? !!(await gitOk(deps, cwd, ['status', '--porcelain'])) : false,
        head: exists ? await gitOk(deps, cwd, ['rev-parse', 'HEAD']) : '',
      });
    }
    const writers = plan
      ? writerStates(
          fold,
          plan.tasks.map((task) => task.id),
          (relative) => observations.get(relative)!,
        )
      : unavailable;
    let integration: object | null = null;
    let evidenceStatuses: import('./evidence.ts').CriterionStatus[] = [];
    let criteria: string[] | typeof unavailable = plan ? checks(plan).map((check) => check.criterion) : unavailable;
    if (opened) {
      const cwd = path.resolve(session, opened.data['path']);
      const exists = fs.existsSync(cwd);
      const head = exists ? await gitOk(deps, cwd, ['rev-parse', 'HEAD']) : null;
      const started = fold.records.findLast(
        (record) => record.kind === 'integrate' && record.data['phase'] === 'started',
      );
      const pending = started && !integrationEnded(fold, started.data['task'], started.seq);
      const conflict = pending
        ? (fold.records.findLast(
            (record) => record.kind === 'integrate' && record.data['phase'] === 'conflict' && record.seq > started!.seq,
          )?.data ?? null)
        : null;
      const delivered = fold.records.findLast(
        (record) => record.kind === 'integrate' && record.data['phase'] === 'delivered',
      );
      integration = {
        source: delivered?.data['source'] ?? null,
        to: null,
        path: opened.data['path'],
        branch: opened.data['branch'],
        head,
        state: exists ? 'present' : 'missing',
        pendingConflict: conflict,
        undelivered: head !== null && head !== (delivered?.data['source'] ?? opened.data['base']),
        closed: fold.records.some(
          (record) => record.kind === 'integrate' && record.data['phase'] === 'closed' && record.seq > opened.seq,
        ),
      };
      if (exists && plan) {
        try {
          const tree = { headTree: await headTree(deps, cwd), testedTree: await testedTree(deps, session, cwd) };
          const cleanup = cleanupBinding(fold),
            all = checks(plan);
          evidenceStatuses = criterionStatuses(fold, all, tree, cleanup);
          const kept = eligibility(
            fold,
            all.filter((check) => !cleanup?.removed.includes(check.criterion)),
            tree,
          );
          criteria = all
            .map(
              (check) =>
                evidenceStatuses.find(
                  (row) => row.criterion === check.criterion && cleanup?.removed.includes(check.criterion),
                ) ?? kept.find((row) => row.criterion === check.criterion)!,
            )
            .filter((row) => row.state !== 'verified')
            .map((row) => row.criterion);
        } catch {
          criteria = checks(plan).map((c) => c.criterion);
        }
      }
    }
    sections = { writers, integration, criteria, criterionStatuses: evidenceStatuses };
  }
  return {
    level,
    bound,
    current,
    approved: latest(fold, 'approval')?.data ?? {},
    gate: gate(fold, current, level),
    escalations: [...escalations.values()].filter((record) => record['state'] === 'open'),
    reviews,
    recordCount: fold.records.length,
    tornTail: fold.torn !== null,
    ...(openRepositoryChanges.length ? { openRepositoryChanges } : {}),
    testCleanup: (() => {
      const row = latestCleanup(fold);
      return row
        ? {
            from: row.data['from'],
            trees: row.data['trees'],
            removed: row.data['removed'],
            deleted: row.data['deleted'],
            merged: row.data['merged'],
          }
        : null;
    })(),
    ...sections,
  };
}

type ResumeView = {
  next: 'inspect' | 'adjudicate' | 'continue' | 'review';
  reason:
    | 'state-unreadable'
    | 'gate-blocked'
    | 'outside-review'
    | 'native-pending'
    | 'arguments-unavailable'
    | 'findings-pending'
    | 'review-settled'
    | 'round-pending'
    | 'target-moved'
    | 'review-required';
  evidence?: string;
  round?: string;
  cleanup?: 'checkpoint' | 'unbound';
};

function existingRecoveryPath(
  session: string,
  relative: string,
  kind: 'file' | 'directory' = 'file',
): string | undefined {
  try {
    fs.lstatSync(path.join(session, relative));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const file = containedSessionPath(session, relative);
  const info = fs.statSync(file);
  if (Buffer.byteLength(JSON.stringify(relative)) > 512 || !(kind === 'directory' ? info.isDirectory() : info.isFile()))
    throw new Error('Invalid recovery pointer');
  return file;
}

function readOptional<T>(session: string, relative: string): T | undefined {
  const file = existingRecoveryPath(session, relative);
  return file ? (JSON.parse(fs.readFileSync(file, 'utf8')) as T) : undefined;
}

export async function resumeStatus(
  ctx: HandlerContext,
): Promise<{ value: ResumeView; recoverySelection?: RecoverySelection; postFold?: Fold }> {
  const { session, manifest, deps } = ctx;
  let cleanup: ResumeView['cleanup'];
  let postFold: Fold | undefined;
  const result = (
    next: ResumeView['next'],
    reason: ResumeView['reason'],
    fields: Pick<ResumeView, 'round' | 'evidence'> = {},
    recoverySelection?: RecoverySelection,
  ) => ({
    value: { next, reason, ...fields, ...(cleanup ? { cleanup } : {}) },
    ...(recoverySelection ? { recoverySelection } : {}),
    ...(postFold ? { postFold } : {}),
  });
  try {
    // A missing ledger cannot support recovery, even though an empty fold is useful to other callers.
    containedSessionPath(session, 'ledger.jsonl');
    const fold = (postFold = foldLedger(session));
    if (fold.torn) return result('inspect', 'state-unreadable');
    const opened = integrationRecord(fold);
    if (!opened) return result('inspect', 'outside-review');
    cleanup = 'unbound';
    const delivered = fold.records.some(
      (row) => row.seq > opened.seq && row.kind === 'integrate' && ['closed', 'delivered'].includes(row.data['phase']),
    );
    if (delivered) return result('inspect', 'outside-review');
    const cwd = containedSessionPath(session, opened.data['path']);
    const head = await gitOk(deps, cwd, ['rev-parse', 'HEAD']);
    const base: unknown = opened.data['base'];
    if (!gitObjectId(head) || !gitObjectId(base)) return result('inspect', 'state-unreadable');
    if (await hasCleanupCheckpoint(session, fold, deps, cwd, head)) cleanup = 'checkpoint';

    const reviewDir = reviewDirectory(session, REVIEW);
    const directory = existingRecoveryPath(session, reviewPointer(session, reviewDir), 'directory');
    const numbers = directory
      ? reviewRoundEntries(fs.readdirSync(directory), 'canonical').map((entry) => entry.number)
      : [];
    const last = numbers.at(-1);
    if (last === undefined) {
      const current = currentHashes(manifest.repositoryRoot, latest(fold, 'bind'));
      return result('inspect', gate(fold, current).allowed ? 'outside-review' : 'gate-blocked');
    }
    const roundDir = reviewRoundDirectory(reviewDir, last);
    const round = reviewPointer(session, reviewRoundFile(roundDir));
    const saved = readOptional<Round>(session, round);
    if (
      !saved ||
      !Number.isSafeInteger(last) ||
      saved.round !== last ||
      !Number.isSafeInteger(saved.generation) ||
      saved.generation < 1 ||
      !LEVELS.includes(saved.level) ||
      !Number.isSafeInteger(saved.cap) ||
      saved.cap < 0 ||
      !Number.isSafeInteger(saved.startSeq) ||
      saved.startSeq < 0 ||
      typeof saved.scope !== 'string' ||
      !saved.spec ||
      typeof saved.spec.hash !== 'string' ||
      typeof saved.spec.path !== 'string' ||
      typeof saved.target !== 'object' ||
      !saved.target ||
      !gitObjectId(saved.target.base) ||
      !gitObjectId(saved.target.head) ||
      !Array.isArray(saved.roster) ||
      !saved.roster.length ||
      saved.roster.some((slot) => !slot || typeof slot.slot !== 'string' || !/^[A-Za-z0-9_-]+\[\d+\]$/.test(slot.slot))
    )
      return result('inspect', 'state-unreadable');
    const legacy = !Object.hasOwn(saved, 'pins');
    if (!legacy && saved.pins !== null && typeof saved.pins !== 'string') return result('inspect', 'state-unreadable');
    parsePinsFlag(saved.pins);
    const evidence = reviewPointer(session, reviewFindingsFile(roundDir));
    const findings = readOptional<FindingsValue>(session, evidence);
    if (
      findings !== undefined &&
      (!findings ||
        !Array.isArray(findings.findings) ||
        !Array.isArray(findings.failed) ||
        findings.findings.some((finding) => typeof finding?.id !== 'string'))
    )
      return result('inspect', 'state-unreadable');

    const bind = latest(fold, 'bind');
    const current = currentHashes(manifest.repositoryRoot, bind);
    if (
      !bind?.data['plan'] ||
      !current.plan ||
      !current.spec ||
      !gate(fold, current).allowed ||
      !levelGate(fold, saved.level).allowed
    )
      return result('inspect', 'gate-blocked');
    const applies = applicableReviewIds(manifest, fold).get(REVIEW);
    const { budget } = admission(session, fold, REVIEW, saved.cap, applies);
    if (budget.coverage?.state === 'unreadable') return result('inspect', 'state-unreadable');
    const rejections = loadRejections(session, fold, [REVIEW]);
    if (rejections.some((state) => state.state === 'escalated') || budget.state === 'escalation-open')
      return result('inspect', 'gate-blocked');
    const target = { base, head };
    const capture = await captureReviewTarget(ctx, 'code', 'integration', 'integration', false, false);
    if (JSON.stringify(capture.target) !== JSON.stringify(target)) return result('inspect', 'state-unreadable');
    const prior = numbers
      .filter((n) => n < last)
      .flatMap((n) => {
        const priorRoundDir = reviewRoundDirectory(reviewDir, n);
        const pointer = reviewPointer(session, reviewFindingsFile(priorRoundDir));
        const value = readOptional<FindingsValue>(session, pointer);
        const metadata = value && readOptional<Round>(session, reviewPointer(session, reviewRoundFile(priorRoundDir)));
        return value && metadata ? [{ value, metadata, pointer }] : [];
      });
    const rulingRows = fold.records.filter(
      (row) => row.kind === 'ruling' && row.data['subject'].startsWith('review:' + REVIEW + ':'),
    );
    const moved =
      !sameReviewCapture(saved, capture) ||
      (!findings &&
        saved.rulingSnapshot !== undefined &&
        saved.rulingSnapshot !==
          reviewRulingSnapshot(
            REVIEW,
            prior.map((row) => row.value),
            rulingRows,
          ));
    const incomplete = budget.nextRound === last;
    const selection = (): RecoverySelection => ({
      review: REVIEW,
      targetHash: recoveryTargetHash(target),
      round: budget.nextRound,
      generation: incomplete ? saved.generation + (moved ? 1 : 0) : 1,
    });

    if (incomplete && !moved && budget.state === 'allowed') {
      const generation = reviewPointer(session, reviewGenerationDirectory(roundDir, saved.generation));
      const slots = generation + '/slots';
      const slotsDir = existingRecoveryPath(session, slots, 'directory');
      if (slotsDir) {
        const names = fs.readdirSync(slotsDir).sort();
        for (const name of names) {
          if (!/^[A-Za-z0-9_-]+\[\d+\]\.json$/.test(name)) continue;
          const pointer = slots + '/' + name;
          const slot = readOptional<SlotOutcome>(session, pointer);
          if (!slot || slot.slot !== name.slice(0, -5) || !['native', 'done', 'failed'].includes(slot.state))
            return result('inspect', 'state-unreadable');
          if (slot.state !== 'native' || slot.cliFallback) continue;
          const reply =
            typeof slot.replyPath === 'string' && path.isAbsolute(slot.replyPath)
              ? path.relative(session, slot.replyPath).split(path.sep).join('/')
              : '';
          const parent = generation + '/replies';
          const attempt =
            typeof slot.attempt === 'string' ? /^([A-Za-z0-9_-]+\[\d+\])#([a-f0-9]{6})$/.exec(slot.attempt) : null;
          const physical = saved.roster.find((entry) => entry.slot === attempt?.[1]);
          const logical = saved.roster.find((entry) => entry.slot === slot.slot && !entry.reserve);
          if (
            !attempt ||
            !logical ||
            !physical ||
            physical.provider !== slot.provider ||
            (physical !== logical &&
              (physical !== saved.roster.find((entry) => entry.reserve) ||
                readOptional<FanoutState>(session, generation + '/fanout.json')?.reserveUsedBy !== slot.slot)) ||
            path.posix.dirname(reply) !== parent ||
            ![slot.slot + '.' + attempt[2] + '.md', slot.slot + '.md'].includes(path.posix.basename(reply))
          )
            return result('inspect', 'state-unreadable');
          containedSessionPath(session, parent);
          existingRecoveryPath(session, reply);
          return result('inspect', 'native-pending', { round, evidence: pointer }, legacy ? undefined : selection());
        }
      }
    }

    if ((!findings || moved) && legacy && budget.state === 'allowed')
      return result('inspect', 'arguments-unavailable', { round });
    const published = findings ? [...prior, { value: findings, metadata: saved, pointer: evidence }] : prior;
    const pending = published.findLast(
      ({ value, metadata }) =>
        applies?.(metadata) &&
        metadata.spec.hash === current.spec &&
        value.findings.some((finding) => {
          const history = rulingRows.filter((row) => row.data['subject'] === 'review:' + REVIEW + ':' + finding.id);
          const ruling = history.at(-1);
          if (!ruling?.data['rationale']?.trim()) return true;
          return (
            metadata.round === last &&
            !moved &&
            ruling.data['ruling'] === 'accepted' &&
            (finding.severity !== 'CONSIDER' || effectiveSeverity(finding, history) !== 'CONSIDER')
          );
        }),
    );
    if (pending) return result('adjudicate', 'findings-pending', { evidence: pending.pointer });

    if (findings) {
      try {
        await reviewIdentity(ctx, fold, cwd, head, base);
        return result('continue', 'review-settled');
      } catch (error) {
        if (!(error instanceof ToolError && error.reason === 'review-required')) throw error;
      }
    }

    if (budget.state !== 'allowed') return result('inspect', 'gate-blocked');
    if (legacy) return result('inspect', 'arguments-unavailable', { round });
    return result(
      'review',
      moved ? 'target-moved' : incomplete ? 'round-pending' : 'review-required',
      { round },
      selection(),
    );
  } catch (error) {
    if (error instanceof ToolError && ['nothing-to-review', 'review-confirmation-required'].includes(error.reason))
      return result('inspect', 'gate-blocked');
    return result('inspect', 'state-unreadable');
  }
}
