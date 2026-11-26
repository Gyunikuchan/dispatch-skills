import fs from "node:fs";
import path from "node:path";

import { nodeErrorCode } from "../lib/fs-ext.ts";
import { ToolError } from "./output.ts";
import {
  readStoredJson,
  reviewDirectory,
  reviewFindingsFile,
  reviewRoot,
  reviewRoundFile,
  reviewSlotsDirectory,
} from "./review-state.ts";

export { reviewSlotsDirectory } from "./review-state.ts";

interface RosterSlot {
  slot: string;
  provider?: string;
  model?: string | readonly string[];
  effort?: string;
  native?: boolean;
  reserve?: boolean;
}

export type SlotOutcome =
  | {
      slot: string;
      state: "done";
      responder?: {
        slot: string;
        provider: string;
        model: string | null;
        native: boolean;
        effort?: string;
      };
    }
  | {
      slot: string;
      state: "native";
      provider?: string;
      model?: string | readonly string[];
      effort?: string;
      error?: string;
      cliFallback?: true;
    }
  | { slot: string; state: "failed"; cls: string };

interface ReviewedFinding {
  id: string;
  severity?: string;
  sources?: string[];
  recurrence?: { of: string };
  unresolved?: { of: string };
  origin?: string;
}

export interface FindingsFile {
  review?: string;
  findings?: ReviewedFinding[];
}

export interface RoundFile {
  round: number;
  generation: number;
  cap: number;
  roster: RosterSlot[];
}

export type ReviewRound = RoundFile & {
  review: string;
  slots: SlotOutcome[];
  findings: FindingsFile | null;
};

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- callers instantiate T explicitly (readReviewJson<RoundFile>); the parameter forwards to the typed boundary reader.
export const readReviewJson = <T>(file: string) => {
  try {
    return readStoredJson<T>(file);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ToolError(
        2,
        "review-corrupt",
        `Malformed review JSON at ${file}`
      );
    }

    throw error;
  }
};

export const entriesOrEmpty = (directory: string) => {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return [];
    }

    throw error;
  }
};

export const reviewDirectories = (
  directory: string,
  entries: typeof entriesOrEmpty
) => entries(directory).filter((entry) => entry.isDirectory());

export const reviewSlotEntries = (
  directory: string,
  entries: typeof entriesOrEmpty
) =>
  entries(directory)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .toSorted((a, b) => a.name.localeCompare(b.name));

/** Reads initialized rounds and their current-generation slot and findings files. */
export const readReviews = (session: string) => {
  const rounds: ReviewRound[] = [];

  for (const reviewEntry of reviewDirectories(
    reviewRoot(session),
    entriesOrEmpty
  ).toSorted((a, b) => a.name.localeCompare(b.name))) {
    const reviewDir = reviewDirectory(session, reviewEntry.name);

    for (const roundEntry of reviewDirectories(reviewDir, entriesOrEmpty)) {
      const roundRoot = path.join(reviewDir, roundEntry.name);
      const round = readReviewJson<RoundFile>(reviewRoundFile(roundRoot));

      if (!round) {
        continue;
      }

      const roster = Array.isArray(round.roster) ? round.roster : [];
      const rosterIds = new Set(roster.map((slot) => slot.slot));
      const slotRoot = reviewSlotsDirectory(roundRoot, round.generation);
      const bySlot = new Map<string, SlotOutcome>();

      for (const slotEntry of reviewSlotEntries(slotRoot, entriesOrEmpty)) {
        const outcome = readReviewJson<SlotOutcome>(
          path.join(slotRoot, slotEntry.name)
        );

        if (outcome && rosterIds.has(outcome.slot)) {
          bySlot.set(outcome.slot, outcome);
        }
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
        findings: readReviewJson<FindingsFile>(reviewFindingsFile(roundRoot)),
      });
    }
  }

  return rounds.toSorted(
    (a, b) => a.review.localeCompare(b.review) || a.round - b.round
  );
};
