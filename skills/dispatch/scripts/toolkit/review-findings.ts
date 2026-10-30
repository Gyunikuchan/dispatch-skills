import fs from 'node:fs';
import path from 'node:path';
import { nodeLinkFs } from '../lib/node-fs-ext.ts';
import type { Manifest } from '../lib/session.ts';
import { reviewId, loadRejections, type RejectionState } from './confirmations.ts';
import { readReviews, type ReviewRound } from './diagnostics.ts';
import { foldLedger, latest, type Fold } from './ledger.ts';
import { neutralizeComments } from './domain/sanitize.ts';
import { sectionRanges, structuralLines } from './domain/plan.ts';
import type { WalkthroughView } from './walkthrough.ts';

const FINDINGS_HEADING = '## Review Findings & Resolutions';
type ReviewRow = WalkthroughView['reviewRows'][number];
export type RoundLink = { review: string; round: number; findings: number; path: string };
export type FindingsSectionStatus = 'updated' | 'unchanged' | 'skipped';

const line = (value: unknown): string => neutralizeComments(String(value ?? '').replace(/\r\n?/g, '\n').replace(/\n/g, ' ').trim());
const cell = (value: unknown): string => neutralizeComments(String(value ?? '')
  .replace(/\r\n?/g, '\n').replace(/\n/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').trim());
// Only captured responder metadata identifies the model; roster effort needs a matching CLI slot.
const slotLabel = (round: ReviewRound, id: string): string => {
  const sourceSlot = round.roster.find(slot => slot.slot === id);
  const outcome = round.slots.find(slot => slot.slot === id);
  const responder = outcome?.state === 'done' ? outcome.responder : undefined;
  const physicalSlot = responder && round.roster.find(slot => slot.slot === responder.slot);
  const provider = responder?.provider || sourceSlot?.provider || 'provider unavailable';
  const model = typeof responder?.model === 'string' && responder.model.trim()
    ? responder.model
    : `unknown (${provider}/${responder?.slot ?? id})`;
  const effort = responder?.native === false && physicalSlot?.provider === responder.provider && physicalSlot.native !== true
    ? physicalSlot.effort
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
  confirmations: readonly RejectionState[],
  reviews?: readonly string[],
): { rows: ReviewRow[]; rounds: RoundLink[] } {
  const rows: ReviewRow[] = [];
  const selected = reviews ? new Set(reviews) : null;
  const rounds: RoundLink[] = [];
  for (const round of readReviews(session)) {
    if (selected && !selected.has(round.review)) continue;
    const findings = round.findings?.findings;
    if (!Array.isArray(findings)) continue;
    rounds.push({
      review: round.review,
      round: round.round,
      findings: findings.length,
      path: `.state/reviews/${round.review}/round-${round.round}/findings.json`,
    });
    for (const raw of findings) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') continue;
      const finding = raw as { id: string; severity?: unknown; sources?: unknown; recurrence?: { of?: unknown }; unresolved?: { of?: unknown } };
      const ruling = fold.records.findLast((record) => record.kind === 'ruling' && record.data['subject'] === `review:${round.review}:${finding.id}`);
      const rulingValue = ruling?.data['ruling'];
      const confirmation = confirmations.find(state => state.request.review === round.review && state.request.finding === finding.id);
      rows.push({
        review: round.review,
        id: finding.id,
        round: round.round,
        severity: typeof finding.severity === 'string' ? finding.severity : 'unknown',
        sources: (Array.isArray(finding.sources) ? finding.sources : []).filter((id): id is string => typeof id === 'string')
          .map((id) => slotLabel(round, id)),
        ruling: ['accepted', 'rejected', 'duplicate', 'deferred'].includes(rulingValue) ? rulingValue as ReviewRow['ruling'] : null,
        rationale: (confirmation && confirmation.state !== 'confirmed' ? `[${confirmation.state} reviewer confirmation] ` : '') +
          (typeof ruling?.data['rationale'] === 'string' ? ruling.data['rationale'] : ''),
        ...(typeof finding.recurrence?.of === 'string' ? { recurrence: finding.recurrence.of } : {}),
        ...(typeof finding.unresolved?.of === 'string' ? { unresolved: finding.unresolved.of } : {}),
      });
    }
  }
  return { rows, rounds };
}

export function renderFindingsSection(rows: readonly ReviewRow[], rounds: readonly RoundLink[], fromDir: string): string {
  const out: string[] = [];
  if (rows.length) {
    out.push('| Review | ID | Round | Severity | Source | Status | Ruling |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const row of rows) {
      const markers = [row.recurrence && `(recurs ${line(row.recurrence)})`, row.unresolved && `(unresolved ${line(row.unresolved)})`].filter(Boolean);
      const rulingStatus = row.ruling ? row.ruling[0]!.toUpperCase() + row.ruling.slice(1) : 'Open';
      const status = [rulingStatus, ...markers].join(' ');
      out.push(`| ${cell(row.review)} | ${cell(row.id)} | ${row.round} | ${cell(row.severity)} | ${cell(row.sources?.length ? row.sources.join(', ') : '—')} | ${cell(status)} | ${cell(clip(row.rationale, 80))} |`);
    }
  } else if (!rounds.length) out.push('*No reviews conducted yet.*');

  for (const round of rounds) {
    const target = path.isAbsolute(round.path) ? round.path : path.resolve(fromDir, round.path);
    const relative = path.relative(fromDir, target).split(path.sep).join('/') || path.basename(target);
    const link = encodeURI(relative).replace(/\(/g, '%28').replace(/\)/g, '%29');
    if (out.length) out.push('');
    out.push(`- Round ${round.round} (${line(round.review)}): ${round.findings} findings — [findings](${link})`);
  }
  return out.join('\n');
}

function lineStarts(source: string, lines: ReturnType<typeof structuralLines>): number[] {
  let offset = 0;
  return lines.map(({ original }) => {
    const start = offset;
    offset += original.length;
    if (source.startsWith('\r\n', offset)) offset += 2;
    else if (source[offset] === '\n') offset++;
    return start;
  });
}

function replaceFindingsSection(source: string, body: string): string {
  const eol = /\r\n|\n/.exec(source)?.[0] ?? '\n';
  const rendered = body.replace(/\r\n?/g, '\n').split('\n').join(eol);
  const lines = structuralLines(source);
  const range = sectionRanges(lines, FINDINGS_HEADING)[0];
  if (!range) {
    const separator = !source ? '' : source.endsWith('\n') || source.endsWith('\r') ? eol : eol + eol;
    return `${source}${separator}${FINDINGS_HEADING}${eol}${eol}${rendered}${eol}`;
  }

  const starts = lineStarts(source, lines);
  const headerEnd = starts[range.start]! + lines[range.start]!.original.length;
  const headerEol = source.startsWith('\r\n', headerEnd) ? '\r\n' : source[headerEnd] === '\n' ? '\n' : '';
  const bodyStart = headerEnd + headerEol.length;
  const end = range.end < starts.length ? starts[range.end]! : source.length;
  const separator = headerEol || eol;
  return source.slice(0, bodyStart) + `${separator}${rendered}${separator}${separator}` + source.slice(end);
}

export function refreshFindingsSection(session: string, manifest: Manifest, review: string, onSkip?: (reason: string) => void): FindingsSectionStatus {
  const skip = (reason: string): FindingsSectionStatus => { onSkip?.(reason); return 'skipped'; };
  try {
    const fold = foldLedger(session);
    const bound = latest(fold, 'bind');
    const artifact = (['plan', 'design'] as const).flatMap(kind => {
      const relative = bound?.data[kind];
      if (typeof relative !== 'string') return [];
      const file = path.resolve(manifest.repositoryRoot, relative);
      return reviewId(kind, file) === review ? [file] : [];
    })[0];
    if (!artifact) return skip(`No bound plan or design matches review ${review}.`);

    const source = fs.readFileSync(artifact, 'utf8');
    const confirmations = loadRejections(session, fold, [review]);
    const current = reviewRows(session, fold, confirmations, [review]);
    const resolvedRounds = current.rounds.map(round => ({ ...round, path: path.resolve(session, round.path) }));
    const body = renderFindingsSection(current.rows, resolvedRounds, path.dirname(artifact));
    const updated = replaceFindingsSection(source, body);
    if (updated === source) return 'unchanged';
    nodeLinkFs.writeAtomic(artifact, updated);
    return 'updated';
  } catch (error) {
    return skip(error instanceof Error ? error.message : String(error));
  }
}

export function rulingReview(subject: string): string | null {
  return /^review:((?:plan|design)-[^:]+):R\d+-F\d+$/.exec(subject)?.[1] ?? null;
}
