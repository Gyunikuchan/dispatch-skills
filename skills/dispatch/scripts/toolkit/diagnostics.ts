import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { renderDiagnostics, type InvocationFacts, type ReviewFacts, type RunFacts } from './domain/diagnostics.ts';
import { latest, type Fold } from './ledger.ts';
import { ToolError } from './output.ts';

type RosterSlot = {slot: string; provider?: string; model?: string | readonly string[]; native?: boolean; reserve?: boolean};
type SlotOutcome =
  | {slot: string; state: 'done'}
  | {slot: string; state: 'native'}
  | {slot: string; state: 'failed'; cls: string};
type ReviewedFinding = {
  id: string;
  recurrence?: {of: string};
  unresolved?: {of: string};
};
type FindingsFile = {review?: string; findings?: ReviewedFinding[]};
type RoundFile = {round: number; generation: number; cap: number; roster: RosterSlot[]};

export type ReviewRound = {
  review: string;
  round: number;
  cap: number;
  roster: RosterSlot[];
  generation: number;
  slots: SlotOutcome[];
  findings: FindingsFile | null;
};

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new ToolError(2, 'review-corrupt', `Malformed review JSON at ${file}`);
    throw error;
  }
}

function entriesOrEmpty(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, {withFileTypes: true});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Reads initialized rounds and their current-generation slot and findings files. */
export function readReviews(session: string): ReviewRound[] {
  const root = path.join(session, '.state', 'reviews');
  const rounds: ReviewRound[] = [];
  for (const reviewEntry of entriesOrEmpty(root).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const reviewRoot = path.join(root, reviewEntry.name);
    for (const roundEntry of entriesOrEmpty(reviewRoot).filter((entry) => entry.isDirectory())) {
      const roundRoot = path.join(reviewRoot, roundEntry.name);
      const round = readJson<RoundFile>(path.join(roundRoot, 'round.json'));
      if (!round) continue;
      const roster = Array.isArray(round.roster) ? round.roster : [];
      const rosterIds = new Set(roster.map((slot) => slot.slot));
      const slotRoot = path.join(roundRoot, `gen-${round.generation}`, 'slots');
      const bySlot = new Map<string, SlotOutcome>();
      for (const slotEntry of entriesOrEmpty(slotRoot).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) {
        const outcome = readJson<SlotOutcome>(path.join(slotRoot, slotEntry.name));
        if (outcome && rosterIds.has(outcome.slot)) bySlot.set(outcome.slot, outcome);
      }
      const slots = roster.flatMap((slot) => {
        const outcome = bySlot.get(slot.slot);
        return outcome ? [outcome] : [];
      });
      rounds.push({
        review: reviewEntry.name,
        round: round.round,
        cap: round.cap,
        roster,
        generation: round.generation,
        slots,
        findings: readJson<FindingsFile>(path.join(roundRoot, 'findings.json')),
      });
    }
  }
  return rounds.sort((a, b) => a.review.localeCompare(b.review) || a.round - b.round);
}

function invocation(round: ReviewRound, slot: SlotOutcome): InvocationFacts {
  const base = {
    phase: round.review,
    provider: 'unavailable',
    model: 'unavailable',
    launched: slot.state !== 'native',
    surface: slot.state === 'native' ? 'native' as const : 'cli' as const,
    slot: slot.slot,
  };
  if (slot.state === 'done') return {...base, outcome: 'ok'};
  if (slot.state === 'native') return {...base, outcome: 'native-pending'};
  return {...base, outcome: typeof slot.cls === 'string' ? slot.cls : 'unknown'};
}

function reviewFacts(round: ReviewRound, fold: Fold): ReviewFacts | null {
  const findings = round.findings?.findings;
  if (!findings) return null;
  let accepted = 0;
  let rejected = 0;
  const reraised = new Set<string>();
  for (const finding of findings) {
    const ruling = fold.records.findLast((record) => record.kind === 'ruling' && record.data['subject'] === `review:${round.review}:${finding.id}`);
    if (ruling?.data['ruling'] === 'accepted') accepted++;
    if (ruling?.data['ruling'] === 'rejected') rejected++;
    if (typeof finding.recurrence?.of === 'string') reraised.add(finding.recurrence.of);
    if (typeof finding.unresolved?.of === 'string') reraised.add(finding.unresolved.of);
  }
  return {phase: round.review, round: round.round, cap: round.cap, accepted, rejected, ...(reraised.size ? {reraised: [...reraised]} : {})};
}

/** Builds dispatch-owned diagnostics facts from the toolkit's ledger and result files. */
export function sessionFacts(session: string, fold: Fold, outcome: string): RunFacts {
  const rounds = readReviews(session);
  const level = latest(fold, 'level')?.data['level'];
  let observations: unknown;
  let hasObservations = true;
  try {
    observations = JSON.parse(fs.readFileSync(path.join(session, '.state', 'retro.json'), 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    hasObservations = false;
  }
  return {
    ...(typeof level === 'string' ? {level} : {}),
    verb: 'session',
    outcome,
    phases: [],
    hostGaps: [],
    invocations: rounds.flatMap((round) => round.slots.map((slot) => invocation(round, slot))),
    reviews: rounds.flatMap((round) => {
      const facts = reviewFacts(round, fold);
      return facts ? [facts] : [];
    }),
    rejectedEvents: [],
    ...(hasObservations ? {observations} : {}),
  };
}

/** Writes the compact diagnostics report with a rename so readers never see a partial file. */
export function writeDiagnostics(session: string, facts: RunFacts): string {
  const output = path.join(session, 'diagnostics.md');
  const temp = output + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, renderDiagnostics([facts]).text, {mode: 0o600});
    fs.renameSync(temp, output);
  } finally {
    fs.rmSync(temp, {force: true});
  }
  return output;
}
