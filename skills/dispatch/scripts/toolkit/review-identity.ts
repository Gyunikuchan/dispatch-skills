import { nodeErrorCode } from '../lib/fs-ext.ts';
import { isRecord } from '../lib/config.ts';
import {
  INTEGRATION_REVIEW,
  reviewDirectory,
  reviewRoundFile,
  reviewFindingsFile,
  reviewGenerationDirectory,
  reviewSlotFile,
  reviewRoundEntries,
} from './review-state.ts';
import { loadRejections, applicableReviewIds } from './confirmations.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { HandlerContext } from './cli.ts';
import type { Fold } from './ledger.ts';
import { latest, currentHashes } from './ledger.ts';
import { stableValue } from './domain/stable-value.ts';
import { parseReport } from './domain/report.ts';
import { effectiveSeverity } from './domain/severity.ts';
import type { Severity } from './domain/types.ts';
import { reviewFixFromCommit } from './review-fix.ts';
import { coverageState } from './coverage.ts';
import type { ReviewFix } from './records.ts';
import { validateReviewFix } from './records.ts';
import { gitOk, gitPaths } from './git.ts';
import { ToolError } from './output.ts';
function refuse(reason: string): never {
  throw new ToolError(4, reason, reason);
}
function rejections(ctx: HandlerContext, fold: Fold) {
  try {
    return loadRejections(ctx.session, fold, applicableReviewIds(ctx.manifest, fold));
  } catch (error) {
    if (error instanceof ToolError && error.reason === 'review-confirmation-required') {
      return refuse('review-required');
    }
    throw error;
  }
}
function reviewRead<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof SyntaxError || nodeErrorCode(error) === 'ENOENT') {
      refuse('review-required');
    }
    throw error;
  }
}
const reviewObject = (file: string) =>
  reviewRead(() => {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isRecord(value)) {
      refuse('review-required');
    }
    return value;
  });

function storedFinding(value: unknown) {
  if (!isRecord(value)) {
    refuse('review-required');
  }
  const { id, severity, locus, unresolved, recurrence } = value;
  if (
    typeof id !== 'string' ||
    !id.trim() ||
    (severity !== 'MUST' && severity !== 'SHOULD' && severity !== 'CONSIDER')
  ) {
    refuse('review-required');
  }
  return {
    id,
    severity,
    locus,
    unresolved: isRecord(unresolved) ? unresolved['of'] : undefined,
    recurrence: isRecord(recurrence) ? recurrence['of'] : undefined,
  } satisfies { id: string; severity: Severity; locus: unknown; unresolved: unknown; recurrence: unknown };
}

function loadIdentityRound(dir: string, number: number) {
  const roundFile = reviewObject(reviewRoundFile(dir));
  const findingsFile = reviewObject(reviewFindingsFile(dir));
  const { target, spec, artifacts, round, generation, startSeq, scope, roster, cap, requests } = roundFile;
  const findings = findingsFile['findings'];
  const rows: Array<unknown> = Array.isArray(findings) ? findings : [];
  return {
    dir,
    number,
    raw: { round: roundFile, findings: findingsFile },
    head: isRecord(target) ? target['head'] : undefined,
    base: isRecord(target) ? target['base'] : undefined,
    spec: isRecord(spec) ? spec['hash'] : undefined,
    artifacts,
    scope: typeof scope === 'string' ? scope : '',
    round,
    generation,
    startSeq,
    roster,
    cap,
    requests,
    findings: rows.map(storedFinding),
    hasFindings: Array.isArray(findings) && Array.isArray(findingsFile['failed']),
  };
}

type IdentityRound = ReturnType<typeof loadIdentityRound>;

function validateHeader(entry: IdentityRound, scope: RegExp, baseline: string, base: string, hashes: unknown) {
  const { roster, round, generation, startSeq, artifacts } = entry;
  if (
    entry.head !== baseline ||
    entry.base !== base ||
    !equal(artifacts, hashes) ||
    entry.spec !== (isRecord(artifacts) ? artifacts['spec'] : undefined) ||
    !scope.test(entry.scope) ||
    typeof round !== 'number' ||
    !Number.isSafeInteger(round) ||
    round !== entry.number ||
    typeof generation !== 'number' ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    typeof startSeq !== 'number' ||
    !Number.isSafeInteger(startSeq) ||
    startSeq < 0 ||
    !Array.isArray(roster) ||
    !roster.length ||
    !entry.hasFindings
  ) {
    refuse('review-required');
  }
  const seats: Array<unknown> = roster;
  return { ...entry, round, generation, startSeq, roster: seats };
}

function requestsForSlot(value: unknown, slot: string): Array<string> {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    refuse('review-required');
  }
  const requests: Array<unknown> = value;
  return requests.flatMap((row) => {
    if (!isRecord(row)) {
      refuse('review-required');
    }
    const { sourceSlots, requestId } = row;
    if (!Array.isArray(sourceSlots) || typeof requestId !== 'string') {
      refuse('review-required');
    }
    return sourceSlots.includes(slot) ? [requestId] : [];
  });
}
const rulingPrefix = 'review:' + INTEGRATION_REVIEW + ':';
const digest = (value: unknown) => 'sha256:' + crypto.createHash('sha256').update(stableValue(value)).digest('hex');
const equal = (a: unknown, b: unknown) => stableValue(a) === stableValue(b);
type ReviewCorrection = { commit: string; seq: number; reason: string; reviewFix: ReviewFix; paths: Array<string> };
export type ReviewIdentity = {
  identity: string;
  baseline: string;
  round: number;
  generation: number;
  startSeq: number;
  corrections: Array<ReviewCorrection>;
};
function safeCorrectionPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    /^[a-z]:/i.test(normalized) ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..') ||
    path.posix.normalize(normalized) !== normalized
  ) {
    return null;
  }
  return normalized;
}
function correctionScope(
  finding: ReturnType<typeof storedFinding> | undefined,
  declared: unknown,
): Array<string> | null {
  if (declared) {
    if (!Array.isArray(declared)) {
      return null;
    }
    const paths: Array<string> = [];
    const values: Array<unknown> = declared;
    for (const value of values) {
      const normalized = safeCorrectionPath(value);
      if (!normalized) {
        return null;
      }
      paths.push(normalized);
    }
    return [...new Set(paths)];
  }
  const match = typeof finding?.locus === 'string' ? /^(.+):L[1-9]\d*$/.exec(finding.locus) : null;
  const file = match ? safeCorrectionPath(match[1]) : null;
  return file ? [file] : null;
}
export async function reviewIdentity(
  ctx: HandlerContext,
  fold: Fold,
  cwd: string,
  head: string,
  base: string,
): Promise<ReviewIdentity> {
  const states = rejections(ctx, fold);
  if (states.some((state) => state.state !== 'confirmed')) {
    refuse('review-required');
  }
  const directory = reviewDirectory(ctx.session, INTEGRATION_REVIEW);
  const entries = reviewRead(() => reviewRoundEntries(fs.readdirSync(directory)));
  const rounds = entries.map(({ name, number }) => loadIdentityRound(path.join(directory, name), number));
  const latestRound = rounds.at(-1);
  // A confirmation-only round re-uses its predecessor's target, so identity and
  // settled findings anchor to the latest round that reviewed the target itself.
  const reviewed = rounds.findLast((value) => !/\(confirmation-only\)/i.test(value.scope));
  const baseline = latestRound?.head;
  if (!latestRound || !reviewed || typeof baseline !== 'string' || !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(baseline)) {
    refuse('review-required');
  }
  const hashes = currentHashes(ctx.manifest.repositoryRoot, latest(fold, 'bind'));
  const last = validateHeader(
    latestRound,
    /^(?:Full review|Re-review round \d+ \((?:full|narrowed|coverage|confirmation-only)\))/i,
    baseline,
    base,
    hashes,
  );
  const substantive = validateHeader(
    reviewed,
    /^(?:Full review|Re-review round \d+ \((?:full|narrowed|coverage)\))/i,
    baseline,
    base,
    hashes,
  );
  // Coverage replaces the last-round failure check: majority or overridden slots pass; rerun, user and unreadable state refuse.
  let coverage;
  try {
    coverage = coverageState(
      ctx.session,
      fold,
      INTEGRATION_REVIEW,
      applicableReviewIds(ctx.manifest, fold).get(INTEGRATION_REVIEW),
    );
  } catch (error) {
    if (error instanceof ToolError && error.reason === 'coverage-required') {
      refuse('review-required');
    }
    throw error;
  }
  if (coverage.decision === 'rerun' || coverage.decision === 'user') {
    refuse('review-required');
  }
  const covered = new Set([...coverage.open, ...coverage.overridden.map((item) => item.slot)]);
  const validateSlots = (
    entry: ReturnType<typeof validateHeader>,
    expected?: (slot: string) => ReadonlyArray<string>,
  ) => {
    const savedFiles = [];
    for (const seat of entry.roster) {
      if (!isRecord(seat)) {
        refuse('review-required');
      }
      if (seat['reserve']) {
        continue;
      }
      const slot = seat['slot'];
      if (typeof slot !== 'string') {
        refuse('review-required');
      }
      const saved = reviewObject(reviewSlotFile(reviewGenerationDirectory(entry.dir, entry.generation), slot));
      const requestIds = expected?.(slot);
      if (
        saved['slot'] !== slot ||
        !(saved['state'] === 'done'
          ? typeof saved['text'] === 'string' &&
            parseReport({
              kind: 'code',
              source: slot,
              text: saved['text'],
              ...(requestIds && { expectedRequestIds: requestIds }),
            }).ok
          : saved['state'] === 'failed' && covered.has(slot))
      ) {
        refuse('review-required');
      }
      savedFiles.push(saved);
    }
    if (!savedFiles.length) {
      refuse('review-required');
    }
    return savedFiles;
  };
  const files = validateSlots(substantive);
  if (latestRound !== reviewed) {
    const lastFiles = validateSlots(last, (slot) => requestsForSlot(last.requests, slot));
    files.push(...lastFiles);
    if (!lastFiles.some((saved) => saved['state'] === 'done')) {
      refuse('review-required');
    }
  }
  if (!files.some((saved) => saved['state'] === 'done')) {
    refuse('review-required');
  }
  const round = substantive;
  const findings = substantive.findings;
  const escalations = new Map<string, string>();
  for (const r of fold.records) {
    if (r.kind === 'escalation') {
      const id: unknown = r.data['id'];
      const state: unknown = r.data['state'];
      if (typeof id === 'string' && typeof state === 'string') {
        escalations.set(id, state);
      }
    }
  }
  if ([...escalations.values()].includes('open')) {
    refuse('review-required');
  }
  const all = rounds.flatMap((r) => r.findings);
  if (new Set(findings.map((finding) => finding.id)).size !== findings.length) {
    refuse('review-required');
  }
  // The corrected severity of a code-integration finding, from every ruling recorded for it.
  const effective = (finding: ReturnType<typeof storedFinding>) =>
    effectiveSeverity(
      finding,
      fold.records.filter((r) => r.kind === 'ruling' && r.data['subject'] === rulingPrefix + finding.id),
    );
  const settled = (finding: ReturnType<typeof storedFinding>, seen = new Set<string>()): boolean => {
    if (seen.has(finding.id)) {
      return false;
    }
    seen.add(finding.id);
    const ruling = fold.records.findLast((r) => r.kind === 'ruling' && r.data['subject'] === rulingPrefix + finding.id);
    const rationale: unknown = ruling?.data['rationale'];
    if (!ruling || typeof rationale !== 'string' || !rationale.trim()) {
      return false;
    }
    if (ruling.data['ruling'] === 'rejected') {
      return (
        effective(finding) !== 'MUST' ||
        states.some(
          (state) =>
            state.request.review === INTEGRATION_REVIEW &&
            state.request.finding === finding.id &&
            state.state === 'confirmed',
        )
      );
    }
    if (ruling.data['ruling'] === 'duplicate') {
      const original = all.find((f) => f.id !== finding.id && rationale.includes(f.id));
      return !!original && settled(original, seen);
    }
    if (ruling.data['ruling'] === 'accepted') {
      return (
        ruling.seq <= round.startSeq &&
        rounds.some(
          (r) =>
            typeof r.round === 'number' &&
            r.round < round.round &&
            r.head !== baseline &&
            r.findings.some((f) => f.id === finding.id),
        ) &&
        !findings.some((f) => f.id === finding.id || f.unresolved === finding.id || f.recurrence === finding.id) &&
        !last.findings.some((f) => f.id === finding.id || f.unresolved === finding.id || f.recurrence === finding.id)
      );
    }
    return false;
  };
  if (all.some((f) => effective(f) === 'MUST' && !settled(f))) {
    refuse('review-required');
  }
  const corrections: Array<ReviewCorrection> = [];
  if (head !== baseline) {
    if (typeof round.cap !== 'number' || !Number.isSafeInteger(round.cap) || round.cap < 1 || round.round < round.cap) {
      refuse('review-required');
    }
    const lines = await gitOk(ctx.deps, cwd, ['rev-list', '--reverse', '--parents', baseline + '..' + head]);
    const commits = lines
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split(' '));
    if (!commits.length) {
      refuse('review-required');
    }
    let parent = baseline,
      lastSeq = round.startSeq;
    const finalFindings = new Map(findings.map((finding) => [finding.id, finding]));
    for (const row of commits) {
      const [commit, ...parents] = row;
      if (!commit || parents.length !== 1 || parents[0] !== parent) {
        refuse('review-required');
      }
      const matches = fold.records.filter(
        (record) => record.kind === 'integrate' && record.data['phase'] === 'fix' && record.data['commit'] === commit,
      );
      const [record] = matches;
      if (!record || matches.length !== 1) {
        refuse('review-required');
      }
      let metadata: ReviewFix;
      try {
        metadata = validateReviewFix(record.data['reviewFix']);
      } catch {
        refuse('review-required');
      }
      if (
        record.by !== 'tool' ||
        metadata.review !== INTEGRATION_REVIEW ||
        metadata.round !== round.round ||
        metadata.generation !== round.generation ||
        metadata.from !== baseline ||
        record.seq <= lastSeq
      ) {
        refuse('review-required');
      }
      for (const id of metadata.findings) {
        const finding = finalFindings.get(id);
        const ruling = fold.records.findLast(
          (candidate) => candidate.kind === 'ruling' && candidate.data['subject'] === rulingPrefix + id,
        );
        // NOTE: a finding corrected down to CONSIDER keeps its required fix; a reviewer-rated CONSIDER does not qualify.
        const qualifies =
          finding &&
          (effective(finding) === 'SHOULD' || (effective(finding) === 'CONSIDER' && finding.severity !== 'CONSIDER'));
        if (
          !qualifies ||
          !ruling ||
          ruling.data['ruling'] !== 'accepted' ||
          !String(ruling.data['rationale'] ?? '').trim() ||
          ruling.seq <= round.startSeq ||
          ruling.seq >= record.seq
        ) {
          refuse('review-required');
        }
      }
      const allowed = new Set<string>();
      for (const id of metadata.findings) {
        const declaration = fold.records.findLast(
          (candidate) =>
            candidate.kind === 'ruling' &&
            candidate.data['subject'] === rulingPrefix + id &&
            candidate.data['ruling'] === 'accepted' &&
            Object.hasOwn(candidate.data, 'paths'),
        );
        const paths = correctionScope(finalFindings.get(id), declaration?.data['paths']);
        if (!paths?.length) {
          refuse('review-required');
        }
        for (const file of paths) {
          allowed.add(file);
        }
      }
      const changes = await gitPaths(ctx.deps, cwd, [
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '--no-renames',
        '-r',
        '-z',
        commit,
      ]);
      if (!changes.length || changes.some((file) => !allowed.has(file.replaceAll('\\', '/')))) {
        refuse('review-required');
      }
      const message = await gitOk(ctx.deps, cwd, ['log', '-1', '--format=%B', commit]);
      if (
        message.split(/\r?\n/)[0] !== 'fix(dispatch): ' + record.data['reason'] ||
        !message.split(/\r?\n/).includes('Dispatch-Fix: ' + ctx.manifest.safeSessionId)
      ) {
        refuse('review-required');
      }
      let committed: ReviewFix | undefined;
      try {
        committed = reviewFixFromCommit(message);
      } catch {
        refuse('review-required');
      }
      if (!committed || !equal(committed, metadata)) {
        refuse('review-required');
      }
      corrections.push({
        commit,
        seq: record.seq,
        reason: String(record.data['reason']),
        reviewFix: metadata,
        paths: changes,
      });
      parent = commit;
      lastSeq = record.seq;
    }
    if (parent !== head) {
      refuse('review-required');
    }
  }
  const identity = digest({
    rounds: rounds.map((r) => r.raw),
    files,
    rulings: fold.records.filter((r) => {
      const subject: unknown = r.data['subject'];
      return r.kind === 'ruling' && typeof subject === 'string' && subject.startsWith(rulingPrefix);
    }),
    baseline,
    corrections,
  });
  return {
    identity,
    baseline,
    round: round.round,
    generation: round.generation,
    startSeq: round.startSeq,
    corrections,
  };
}
