import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { nodeErrorCode } from "../lib/fs-ext.ts";
import type { Underfill } from "../policy/roster.ts";
import type { RejectionRequest } from "./confirmations.ts";
import type { InterRound } from "./domain/prompt.ts";
import { effectiveSeverity } from "./domain/severity.ts";
import type { RosterSlot } from "./domain/types.ts";
import type { FindingsValue } from "./findings.ts";
import type { Hashes } from "./ledger.ts";
import type { LedgerRecord } from "./records.ts";
import type { Level } from "./types.ts";

export const INTEGRATION_REVIEW = "code-integration";

/** Real path when it resolves, else the resolved input, so a missing file still compares by path. */
export const canonical = (file: string) => {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
};

export const reviewRoot = (session: string) =>
  path.join(session, ".state", "reviews");

export const reviewDirectory = (session: string, review: string) =>
  path.join(reviewRoot(session), review);

export const reviewRoundDirectory = (
  reviewDir: string,
  round: number | string
) => path.join(reviewDir, `round-${round}`);

export const reviewGenerationDirectory = (
  roundDir: string,
  generation: number
) => path.join(roundDir, `gen-${generation}`);

export const reviewSlotsDirectory = (roundDir: string, generation: number) =>
  path.join(reviewGenerationDirectory(roundDir, generation), "slots");

export const reviewRoundFile = (roundDir: string) =>
  path.join(roundDir, "round.json");

export const reviewFindingsFile = (roundDir: string) =>
  path.join(roundDir, "findings.json");

export const reviewPendingFile = (roundDir: string) =>
  path.join(roundDir, "pending.json");

export const reviewSlotFile = (generationDir: string, slot: string) =>
  path.join(generationDir, "slots", `${slot}.json`);

export const reviewRoundNumber = (name: string) => {
  const match = /^round-(?<cap1>\d+)$/u.exec(name);

  return match ? Number(match[1]) : undefined;
};

export const reviewRoundEntries = (
  names: readonly string[],
  format?: "canonical"
) =>
  names
    .flatMap((name) => {
      const number = reviewRoundNumber(name);

      if (
        number === undefined ||
        (format === "canonical" && !/^round-[1-9]\d*$/u.test(name))
      ) {
        return [];
      }

      return [{ name, number }];
    })
    .toSorted((left, right) => left.number - right.number);

export const reviewPointer = (session: string, file: string) =>
  path.relative(session, file).split(path.sep).join("/");

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- callers instantiate T explicitly (readStoredJson<Round>); the parameter is load-bearing.
export const readStoredJson = <T>(file: string) => {
  try {
    // SAFETY: file bytes are JSON parsed at the I/O boundary; callers instantiate T to the persisted schema they then validate.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- generic boundary reader; callers specify the persisted schema type
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return null;
    }

    throw error;
  }
};

export type ReviewTarget = string | { base: string; head: string };

export interface ReviewSnapshot {
  artifactPath?: string;
  artifacts?: Hashes;
  spec: { path: string; hash: string };
  target: ReviewTarget;
}

export type Round = ReviewSnapshot & {
  round: number;
  generation: number;
  cap: number;
  level: Level;
  pins?: string | null;
  roster: RosterSlot[];
  scope: string;
  startSeq: number;
  underfill?: Underfill;
  turnTarget: number;
  contextMapPath?: string;
  coverage?: "open" | "full";
  coverageUse?: "free" | "grant";
  interRound?: InterRound;
  requests?: RejectionRequest[];
  rulingSnapshot?: string;
};

export const sameReviewCapture = (
  round: ReviewSnapshot,
  capture: ReviewSnapshot
) =>
  (round.artifactPath === undefined ||
    round.artifactPath === "" ||
    round.artifactPath === capture.artifactPath) &&
  round.spec.hash === capture.spec.hash &&
  round.spec.path === capture.spec.path &&
  JSON.stringify(round.target) === JSON.stringify(capture.target) &&
  JSON.stringify(round.artifacts) === JSON.stringify(capture.artifacts);

export const reviewRulingSnapshot = (
  review: string,
  prior: FindingsValue[],
  rows: readonly LedgerRecord[]
) => {
  const matches = (row: LedgerRecord, id: string) =>
    row.data["subject"] === `review:${review}:${id}`;

  return JSON.stringify(
    prior.flatMap((value) =>
      value.findings.flatMap((finding) => {
        const history = rows.filter((row) => matches(row, finding.id));

        return effectiveSeverity(finding, history) === "MUST"
          ? [[finding.id, history.at(-1)?.seq ?? 0]]
          : [];
      })
    )
  );
};

export interface RecoverySelection {
  review: typeof INTEGRATION_REVIEW;
  targetHash: string;
  round: number;
  generation: number;
}

export const recoveryTargetHash = ({
  base,
  head,
}: {
  base: string;
  head: string;
}) => createHash("sha256").update(JSON.stringify({ base, head })).digest("hex");

export const label = (target: ReviewTarget) =>
  typeof target === "string" ? target : target.head;

// An artifact target is a bare hash, so it has no base or head.
export const baseOf = (target: ReviewTarget) =>
  typeof target === "string" ? undefined : target.base;

export const headOf = (target: ReviewTarget) =>
  typeof target === "string" ? undefined : target.head;
