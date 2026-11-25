import fs from 'node:fs';
import path from 'node:path';
import { ToolError } from './output.ts';
import {
  readStoredJson,
  reviewDirectory,
  reviewFindingsFile,
  reviewRoot,
  reviewRoundFile,
  reviewSlotsDirectory,
} from './review-state.ts';
export { reviewSlotsDirectory } from './review-state.ts';

type RosterSlot = {
  slot: string;
  provider?: string;
  model?: string | readonly string[];
  effort?: string;
  native?: boolean;
  reserve?: boolean;
};
export type SlotOutcome =
  | {
      slot: string;
      state: 'done';
      responder?: { slot: string; provider: string; model: string | null; native: boolean; effort?: string };
    }
  | {
      slot: string;
      state: 'native';
      provider?: string;
      model?: string | readonly string[];
      effort?: string;
      error?: string;
      cliFallback?: true;
    }
  | { slot: string; state: 'failed'; cls: string };
type ReviewedFinding = {
  id: string;
  severity?: string;
  sources?: string[];
  recurrence?: { of: string };
  unresolved?: { of: string };
  origin?: string;
};
export type FindingsFile = { review?: string; findings?: ReviewedFinding[] };
export type RoundFile = { round: number; generation: number; cap: number; roster: RosterSlot[] };

export type ReviewRound = RoundFile & {
  review: string;
  slots: SlotOutcome[];
  findings: FindingsFile | null;
};

export function readReviewJson<T>(file: string): T | null {
  try {
    return readStoredJson<T>(file);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ToolError(2, 'review-corrupt', `Malformed review JSON at ${file}`);
    throw error;
  }
}

export function entriesOrEmpty(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export const reviewDirectories = (directory: string, entries: typeof entriesOrEmpty): fs.Dirent[] =>
  entries(directory).filter((entry) => entry.isDirectory());

export const reviewSlotEntries = (directory: string, entries: typeof entriesOrEmpty): fs.Dirent[] =>
  entries(directory)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name));

/** Reads initialized rounds and their current-generation slot and findings files. */
export function readReviews(session: string): ReviewRound[] {
  const rounds: ReviewRound[] = [];
  for (const reviewEntry of reviewDirectories(reviewRoot(session), entriesOrEmpty).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const reviewRoot = reviewDirectory(session, reviewEntry.name);
    for (const roundEntry of reviewDirectories(reviewRoot, entriesOrEmpty)) {
      const roundRoot = path.join(reviewRoot, roundEntry.name);
      const round = readReviewJson<RoundFile>(reviewRoundFile(roundRoot));
      if (!round) continue;
      const roster = Array.isArray(round.roster) ? round.roster : [];
      const rosterIds = new Set(roster.map((slot) => slot['slot']));
      const slotRoot = reviewSlotsDirectory(roundRoot, round.generation);
      const bySlot = new Map<string, SlotOutcome>();
      for (const slotEntry of reviewSlotEntries(slotRoot, entriesOrEmpty)) {
        const outcome = readReviewJson<SlotOutcome>(path.join(slotRoot, slotEntry.name));
        if (outcome && rosterIds.has(outcome.slot)) bySlot.set(outcome.slot, outcome);
      }
      const slots = roster.flatMap((slot) => {
        const outcome = bySlot.get(slot['slot']);
        return outcome ? [outcome] : [];
      });
      rounds.push({
        review: reviewEntry.name,
        round: round.round,
        cap: round.cap,
        roster,
        generation: round.generation,
        slots,
        findings: readReviewJson<FindingsFile>(reviewFindingsFile(roundRoot)),
      });
    }
  }
  return rounds.sort((a, b) => a.review.localeCompare(b.review) || a.round - b.round);
}
