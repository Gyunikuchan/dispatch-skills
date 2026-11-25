import fs from 'node:fs';
import { RESOLUTION_HEADING } from './domain/document-lint.ts';
import path from 'node:path';
import { nodeLinkFs } from '../lib/node-fs-ext.ts';
import type { Manifest } from '../lib/session.ts';
import { reviewId, loadRejections } from './confirmations.ts';
import type { RejectionState } from './confirmations.ts';
import { admission, renderBudget } from './findings.ts';
import { reviewDirectory, reviewFindingsFile, reviewPointer, reviewRoundDirectory } from './review-state.ts';
import { readReviews } from './review-storage.ts';
import type { ReviewRound } from './review-storage.ts';
import { foldLedger, latest } from './ledger.ts';
import type { Fold } from './ledger.ts';
import { effectiveSeverity, RANK } from './domain/severity.ts';
import type { Finding, Severity } from './domain/types.ts';
import { neutralizeComments } from './domain/sanitize.ts';
import { sectionRanges, structuralLines } from './domain/markdown-structure.ts';
import type { WalkthroughView } from './walkthrough.ts';
import { present } from './narrow.ts';

type ReviewRow = WalkthroughView['reviewRows'][number];
export type RoundLink = { review: string; round: number; findings: number; path: string };
type FindingsSectionStatus = 'updated' | 'unchanged' | 'skipped';
type ReviewRows = { rows: Array<ReviewRow>; rounds: Array<RoundLink> };
const RULINGS = ['accepted', 'rejected', 'duplicate', 'deferred'] as const;
const isSeverity = (value: string): value is Severity => value in RANK;

export const line = (value: unknown): string =>
  neutralizeComments(
    String(value ?? '')
      .replaceAll(/\r\n?/g, '\n')
      .replaceAll('\n', ' ')
      .trim(),
  );
const cell = (value: unknown): string =>
  neutralizeComments(
    String(value ?? '')
      .replaceAll(/\r\n?/g, '\n')
      .replaceAll('\n', ' ')
      .replaceAll('\\', String.raw`\\`)
      .replaceAll('|', String.raw`\|`)
      .trim(),
  );
// Only captured responder metadata identifies the model; roster effort needs a matching CLI slot.
const slotLabel = (round: ReviewRound, id: string): string => {
  const sourceSlot = round.roster.find((slot) => slot.slot === id);
  const outcome = round.slots.find((slot) => slot.slot === id);
  const responder = outcome?.state === 'done' ? outcome.responder : undefined;
  const physicalSlot = responder && round.roster.find((slot) => slot.slot === responder.slot);
  const provider = responder?.provider || sourceSlot?.provider || 'provider unavailable';
  const model =
    typeof responder?.model === 'string' && responder.model.trim()
      ? responder.model
      : `unknown (${provider}/${responder?.slot ?? id})`;
  const effort =
    responder?.native === true
      ? typeof responder.effort === 'string'
        ? responder.effort
        : undefined
      : responder?.native === false &&
          physicalSlot?.provider === responder.provider &&
          (physicalSlot as { native?: boolean }).native !== true
        ? (physicalSlot as { effort?: string }).effort
        : undefined;
  return typeof effort === 'string' ? `${model}/${effort}` : model;
};

const clip = (value: string, limit: number): string => {
  const chars = Array.from(line(value));
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : chars.join('');
};

export function reviewRows(
  session: string,
  fold: Fold,
  confirmations: ReadonlyArray<RejectionState>,
  reviews?: ReadonlyArray<string>,
): ReviewRows {
  const rows: Array<ReviewRow> = [];
  const selected = reviews ? new Set(reviews) : null;
  const rounds: Array<RoundLink> = [];
  for (const round of readReviews(session)) {
    if (selected && !selected.has(round.review)) {
      continue;
    }
    const findings = round.findings?.findings;
    if (!Array.isArray(findings)) {
      continue;
    }
    rounds.push({
      review: round.review,
      round: round.round,
      findings: findings.length,
      path: reviewPointer(
        session,
        reviewFindingsFile(reviewRoundDirectory(reviewDirectory(session, round.review), round.round)),
      ),
    });
    for (const raw of findings) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') {
        continue;
      }
      const finding = raw as {
        id: string;
        severity?: unknown;
        sources?: unknown;
        recurrence?: { of?: unknown };
        unresolved?: { of?: unknown };
        origin?: unknown;
      };
      const history = fold.records.filter(
        (record) => record.kind === 'ruling' && record.data['subject'] === `review:${round.review}:${finding.id}`,
      );
      const ruling = history.at(-1);
      const stored = typeof finding.severity === 'string' ? finding.severity : 'unknown';
      const severity: string = isSeverity(stored) ? effectiveSeverity({ severity: stored }, history) : stored;
      const rulingValue: unknown = ruling?.data['ruling'];
      const confirmation = confirmations.find(
        (state) => state.request.review === round.review && state.request.finding === finding.id,
      );
      rows.push({
        review: round.review,
        id: finding.id,
        round: round.round,
        severity,
        ...(isSeverity(stored) && isSeverity(severity) && RANK[severity] < RANK[stored] && { downgradedFrom: stored }),
        sources: (Array.isArray(finding.sources) ? finding.sources : [])
          .filter((id): id is string => typeof id === 'string')
          .map((id) => slotLabel(round, id)),
        ruling: RULINGS.find((value) => value === rulingValue) ?? null,
        rationale:
          (confirmation && confirmation.state !== 'confirmed' ? `[${confirmation.state} reviewer confirmation] ` : '') +
          (typeof ruling?.data['rationale'] === 'string' ? ruling.data['rationale'] : ''),
        ...(typeof finding.recurrence?.of === 'string' && { recurrence: finding.recurrence.of }),
        ...(typeof finding.unresolved?.of === 'string' && { unresolved: finding.unresolved.of }),
        ...((finding.origin === 'original' || finding.origin === 'fix-induced' || finding.origin === 'unknown') && {
          origin: finding.origin,
        }),
      });
    }
  }
  return { rows, rounds };
}

export function renderFindingsSection(
  rows: ReadonlyArray<ReviewRow>,
  rounds: ReadonlyArray<RoundLink>,
  fromDir: string,
  budget?: string,
): string {
  const out: Array<string> = [];
  if (rows.length) {
    out.push(
      '| Review | ID | Round | Severity | Source | Status | Ruling |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const row of rows) {
      const markers = [
        row.recurrence && `(recurs ${line(row.recurrence)})`,
        row.unresolved && `(unresolved ${line(row.unresolved)})`,
        row.origin && `(origin ${line(row.origin)})`,
      ].filter(Boolean);
      const rulingStatus = row.ruling ? row.ruling.charAt(0).toUpperCase() + row.ruling.slice(1) : 'Open';
      const status = [
        rulingStatus,
        ...(row.downgradedFrom ? [`(downgraded from ${line(row.downgradedFrom)})`] : []),
        ...markers,
      ].join(' ');
      out.push(
        `| ${cell(row.review)} | ${cell(row.id)} | ${row.round} | ${cell(row.severity)} | ${cell(row.sources?.length ? row.sources.join(', ') : '—')} | ${cell(status)} | ${cell(clip(row.rationale, 80))} |`,
      );
    }
  } else if (!rounds.length) {
    out.push('*No reviews conducted yet.*');
  }

  for (const round of rounds) {
    const target = path.isAbsolute(round.path) ? round.path : path.resolve(fromDir, round.path);
    const relative = path.relative(fromDir, target).split(path.sep).join('/') || path.basename(target);
    const link = encodeURI(relative).replaceAll('(', '%28').replaceAll(')', '%29');
    if (out.length) {
      out.push('');
    }
    out.push(`- Round ${round.round} (${line(round.review)}): ${round.findings} findings — [findings](${link})`);
  }
  if (budget) {
    out.push('', budget);
  }
  return out.join('\n');
}

const field = (value: unknown) => line(value) || '—';

export function renderFindingsFile(findings: ReadonlyArray<Finding>): string {
  if (!findings.length) {
    return 'No findings.\n';
  }
  const sorted = [...findings].sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  return (
    sorted
      .map((finding) =>
        [
          `### ${line(finding.id)} ${line(finding.severity)}`,
          `- Rating: ${field(finding.impact)}/${field(finding.trigger)}; category ${field(finding.category)}; scope ${field(finding.scope)}; origin ${field(finding.origin)}`,
          `- Locus: ${field(finding.locus)}`,
          `- Defect: ${field(finding.defect)}`,
          `- Required change: ${field(finding.requiredChange)}`,
          `- Sources: ${field(finding.sources?.join(', '))}`,
        ].join('\n'),
      )
      .join('\n\n') + '\n'
  );
}

export function rulingsTemplate(review: string, round: number, findings: ReadonlyArray<Finding>) {
  return findings.map(({ id }) => ({
    kind: 'ruling',
    by: 'orchestrator',
    key: `ruling:${review}:${round}:${id}`,
    data: { subject: `review:${review}:${id}`, ruling: '', rationale: '' },
  }));
}

function lineStarts(source: string, lines: ReturnType<typeof structuralLines>): Array<number> {
  let offset = 0;
  return lines.map(({ original }) => {
    const start = offset;
    offset += original.length;
    if (source.startsWith('\r\n', offset)) {
      offset += 2;
    } else if (source[offset] === '\n') {
      offset++;
    }
    return start;
  });
}

function replaceFindingsSection(source: string, body: string): string {
  const eol = /\r\n|\n/.exec(source)?.[0] ?? '\n';
  const rendered = body.replaceAll(/\r\n?/g, '\n').split('\n').join(eol);
  const lines = structuralLines(source);
  const range = sectionRanges(lines, RESOLUTION_HEADING)[0];
  if (!range) {
    const separator = !source ? '' : source.endsWith('\n') || source.endsWith('\r') ? eol : eol + eol;
    return `${source}${separator}${RESOLUTION_HEADING}${eol}${eol}${rendered}${eol}`;
  }

  const starts = lineStarts(source, lines);
  const headerStart = present(starts[range.start], 'the findings heading offset');
  const headerEnd = headerStart + present(lines[range.start], 'the findings heading line').original.length;
  const headerEol = source.startsWith('\r\n', headerEnd) ? '\r\n' : source[headerEnd] === '\n' ? '\n' : '';
  const bodyStart = headerEnd + headerEol.length;
  const end = range.end < starts.length ? present(starts[range.end], 'the next section offset') : source.length;
  const separator = headerEol || eol;
  return source.slice(0, bodyStart) + `${separator}${rendered}${separator}${separator}` + source.slice(end);
}

export function refreshFindingsSection(
  session: string,
  manifest: Manifest,
  review: string,
  onSkip?: (reason: string) => void,
): FindingsSectionStatus {
  const skip = (reason: string): FindingsSectionStatus => {
    onSkip?.(reason);
    return 'skipped';
  };
  try {
    const fold = foldLedger(session);
    const bound = latest(fold, 'bind');
    const artifact = (['plan', 'design'] as const).flatMap((kind) => {
      const relative: unknown = bound?.data[kind];
      if (typeof relative !== 'string') {
        return [];
      }
      const file = path.resolve(manifest.repositoryRoot, relative);
      return reviewId(kind, file) === review ? [file] : [];
    })[0];
    if (!artifact) {
      return skip(`No bound plan or design matches review ${review}.`);
    }

    const source = fs.readFileSync(artifact, 'utf8');
    const confirmations = loadRejections(session, fold, [review]);
    const current = reviewRows(session, fold, confirmations, [review]);
    const resolvedRounds = current.rounds.map((round) => ({ ...round, path: path.resolve(session, round.path) }));
    // Recomputed from the current ledger with the launch admission policy; showing it grants nothing.
    const budget = current.rounds.length
      ? `Budget (${line(review)}): ${renderBudget(admission(session, fold, review, 0).budget)}`
      : undefined;
    const body = renderFindingsSection(current.rows, resolvedRounds, path.dirname(artifact), budget);
    const updated = replaceFindingsSection(source, body);
    if (updated === source) {
      return 'unchanged';
    }
    nodeLinkFs.writeAtomic(artifact, updated);
    return 'updated';
  } catch (error) {
    return skip(error instanceof Error ? error.message : String(error));
  }
}

export function rulingReview(subject: string): string | null {
  return /^review:((?:plan|design)-[^:]+):R\d+-F\d+$/.exec(subject)?.[1] ?? null;
}
