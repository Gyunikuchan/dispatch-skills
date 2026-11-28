import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isRecord } from "../lib/config.ts";
import { nodeErrorCode } from "../lib/fs-ext.ts";
import type { HandlerContext } from "./cli.ts";
import { loadRejections, applicableReviewIds } from "./confirmations.ts";
import { coverageState } from "./coverage.ts";
import { parseReport } from "./domain/report.ts";
import { effectiveSeverity } from "./domain/severity.ts";
import { stableValue } from "./domain/stable-value.ts";
import type { Severity } from "./domain/types.ts";
import { gitOk, gitPaths } from "./git.ts";
import type { Fold } from "./ledger.ts";
import { latest, currentHashes } from "./ledger.ts";
import { ToolError } from "./output.ts";
import type { ReviewFix } from "./records.ts";
import { validateReviewFix } from "./records.ts";
import { reviewFixFromCommit } from "./review-fix.ts";
import {
  INTEGRATION_REVIEW,
  reviewDirectory,
  reviewRoundFile,
  reviewFindingsFile,
  reviewGenerationDirectory,
  reviewSlotFile,
  reviewRoundEntries,
} from "./review-state.ts";

function refuse(reason: string): never {
  throw new ToolError(4, reason, reason);
}

const rejections = (ctx: HandlerContext, fold: Fold) => {
  try {
    return loadRejections(
      ctx.session,
      fold,
      applicableReviewIds(ctx.manifest, fold)
    );
  } catch (error) {
    if (
      error instanceof ToolError &&
      error.reason === "review-confirmation-required"
    ) {
      return refuse("review-required");
    }

    throw error;
  }
};

const reviewRead = <T>(read: () => T) => {
  try {
    return read();
  } catch (error) {
    if (error instanceof SyntaxError || nodeErrorCode(error) === "ENOENT") {
      refuse("review-required");
    }

    throw error;
  }
};

const reviewObject = (file: string) =>
  reviewRead(() => {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));

    if (!isRecord(value)) {
      refuse("review-required");
    }

    return value;
  });

const storedFinding = (value: unknown) => {
  if (!isRecord(value)) {
    refuse("review-required");
  }

  const { id, severity, locus, unresolved, recurrence } = value;

  if (
    typeof id !== "string" ||
    !id.trim() ||
    (severity !== "MUST" && severity !== "SHOULD" && severity !== "CONSIDER")
  ) {
    refuse("review-required");
  }

  return {
    id,
    severity,
    locus,
    unresolved: isRecord(unresolved) ? unresolved["of"] : undefined,
    recurrence: isRecord(recurrence) ? recurrence["of"] : undefined,
  } satisfies {
    id: string;
    severity: Severity;
    locus: unknown;
    unresolved: unknown;
    recurrence: unknown;
  };
};

const loadIdentityRound = (dir: string, number: number) => {
  const roundFile = reviewObject(reviewRoundFile(dir));
  const findingsFile = reviewObject(reviewFindingsFile(dir));

  const {
    target,
    spec,
    artifacts,
    round,
    generation,
    startSeq,
    scope,
    roster,
    cap,
    requests,
  } = roundFile;

  const { findings } = findingsFile;
  const rows: unknown[] = Array.isArray(findings) ? findings : [];

  return {
    dir,
    number,
    raw: { round: roundFile, findings: findingsFile },
    head: isRecord(target) ? target["head"] : undefined,
    base: isRecord(target) ? target["base"] : undefined,
    spec: isRecord(spec) ? spec["hash"] : undefined,
    artifacts,
    scope: typeof scope === "string" ? scope : "",
    round,
    generation,
    startSeq,
    roster,
    cap,
    requests,
    findings: rows.map(storedFinding),
    hasFindings:
      Array.isArray(findings) && Array.isArray(findingsFile["failed"]),
  };
};

type IdentityRound = ReturnType<typeof loadIdentityRound>;

const validateHeader = (
  entry: IdentityRound,
  scope: RegExp,
  baseline: string,
  base: string,
  hashes: unknown
) => {
  const { roster, round, generation, startSeq, artifacts } = entry;

  if (
    entry.head !== baseline ||
    entry.base !== base ||
    !equal(artifacts, hashes) ||
    entry.spec !== (isRecord(artifacts) ? artifacts["spec"] : undefined) ||
    !scope.test(entry.scope) ||
    typeof round !== "number" ||
    !Number.isSafeInteger(round) ||
    round !== entry.number ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    typeof startSeq !== "number" ||
    !Number.isSafeInteger(startSeq) ||
    startSeq < 0 ||
    !Array.isArray(roster) ||
    !roster.length ||
    !entry.hasFindings
  ) {
    refuse("review-required");
  }

  const seats: unknown[] = roster;

  return { ...entry, round, generation, startSeq, roster: seats };
};

const requestsForSlot = (value: unknown, slot: string) => {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    refuse("review-required");
  }

  const requests: unknown[] = value;

  return requests.flatMap((row) => {
    if (!isRecord(row)) {
      refuse("review-required");
    }

    const { sourceSlots, requestId } = row;

    if (!Array.isArray(sourceSlots) || typeof requestId !== "string") {
      refuse("review-required");
    }

    return sourceSlots.includes(slot) ? [requestId] : [];
  });
};

const rulingPrefix = `review:${INTEGRATION_REVIEW}:`;

const digest = (value: unknown) =>
  `sha256:${crypto
    .createHash("sha256")
    .update(stableValue(value))
    .digest("hex")}`;

const equal = (a: unknown, b: unknown) => stableValue(a) === stableValue(b);

interface ReviewCorrection {
  commit: string;
  seq: number;
  reason: string;
  reviewFix: ReviewFix;
  paths: string[];
}

export interface ReviewIdentity {
  identity: string;
  baseline: string;
  round: number;
  generation: number;
  startSeq: number;
  corrections: ReviewCorrection[];
}

const safeCorrectionPath = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const normalized = value.replaceAll("\\", "/");

  if (
    normalized.startsWith("/") ||
    /^[a-z]:/iu.test(normalized) ||
    normalized
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
    path.posix.normalize(normalized) !== normalized
  ) {
    return null;
  }

  return normalized;
};

const correctionScope = (
  finding: ReturnType<typeof storedFinding> | undefined,
  declared: unknown
) => {
  if (
    declared !== undefined &&
    declared !== null &&
    declared !== false &&
    declared !== "" &&
    declared !== 0
  ) {
    if (!Array.isArray(declared)) {
      return null;
    }

    const paths: string[] = [];
    const values: unknown[] = declared;

    for (const value of values) {
      const normalized = safeCorrectionPath(value);

      if (normalized === null) {
        return null;
      }

      paths.push(normalized);
    }

    return [...new Set(paths)];
  }

  const match =
    typeof finding?.locus === "string"
      ? /^(?<cap1>.+):L[1-9]\d*$/u.exec(finding.locus)
      : null;

  const file = match ? safeCorrectionPath(match[1]) : null;

  return file === null ? null : [file];
};

interface ReviewClosureFacts {
  reviewId: string;
  activeReviewId: string;
  pendingMustRejections: number;
  cleanPass: boolean;
  latestRecurrenceSeq: number;
  latestCeiling: { seq: number; state: unknown; summary: unknown } | undefined;
}

const CEILING_CLOSING_SUMMARY = /^(?:close|defer):/u;

/** Closes a non-active review with no pending MUST rejection and a clean pass or a close/defer ceiling newer than its latest recurrence. */
export const evaluateReviewClosed = (facts: ReviewClosureFacts) => {
  const { latestCeiling } = facts;

  const ceilingClosed =
    latestCeiling !== undefined &&
    latestCeiling.state === "resolved" &&
    typeof latestCeiling.summary === "string" &&
    CEILING_CLOSING_SUMMARY.test(latestCeiling.summary) &&
    latestCeiling.seq > facts.latestRecurrenceSeq;

  return (
    facts.reviewId !== facts.activeReviewId &&
    facts.pendingMustRejections === 0 &&
    (facts.cleanPass || ceilingClosed)
  );
};

const latestEscalation = (records: Fold["records"], prefix: string) =>
  records.findLast((record) => {
    const id: unknown = record.data["id"];

    return (
      record.kind === "escalation" &&
      typeof id === "string" &&
      id.startsWith(prefix)
    );
  });

const isDecision = (record: Fold["records"][number]) =>
  record.data["ruling"] === "accepted" ||
  record.data["ruling"] === "rejected" ||
  record.data["ruling"] === "duplicate";

// NOTE: unreadable closure evidence throws, which keeps resume refused (fail closed).
export const isReviewClosed = (
  session: string,
  fold: Fold,
  reviewId: string,
  activeReviewId: string
) => {
  const directory = reviewDirectory(session, reviewId);

  const entries = fs.existsSync(directory)
    ? reviewRead(() => reviewRoundEntries(fs.readdirSync(directory)))
    : [];

  const rounds = entries.map(({ name, number }) =>
    loadIdentityRound(path.join(directory, name), number)
  );

  const substantive = rounds.findLast(
    (round) => !/\(confirmation-only\)/iu.test(round.scope)
  );

  // NOTE: malformed findings evidence loads as zero rows, so it must not read as a clean pass.
  const cleanPass =
    substantive !== undefined &&
    substantive.hasFindings &&
    substantive.findings.every((finding) => {
      const rulings = fold.records.filter(
        (record) =>
          record.kind === "ruling" &&
          record.data["subject"] === `review:${reviewId}:${finding.id}`
      );

      if (effectiveSeverity(finding, rulings) !== "MUST") {
        return true;
      }

      const decision = rulings.findLast(isDecision);

      return decision !== undefined && decision.data["ruling"] !== "accepted";
    });

  const latestRecurrence = latestEscalation(
    fold.records,
    `recurrence:${reviewId}:`
  );

  const latestCeiling = latestEscalation(fold.records, `ceiling:${reviewId}:`);

  return evaluateReviewClosed({
    reviewId,
    activeReviewId,
    pendingMustRejections: loadRejections(session, fold, [reviewId]).filter(
      (state) => state.state !== "confirmed"
    ).length,
    cleanPass,
    latestRecurrenceSeq: latestRecurrence?.seq ?? 0,
    latestCeiling: latestCeiling && {
      seq: latestCeiling.seq,
      state: latestCeiling.data["state"],
      summary: latestCeiling.data["summary"],
    },
  });
};

// oxlint-disable-next-line eslint/complexity -- identity branches per confirmation state, coverage decision, and roster entry.
export const reviewIdentity = async (
  ctx: HandlerContext,
  fold: Fold,
  cwd: string,
  head: string,
  base: string
) => {
  const states = rejections(ctx, fold);

  if (states.some((state) => state.state !== "confirmed")) {
    refuse("review-required");
  }

  const directory = reviewDirectory(ctx.session, INTEGRATION_REVIEW);

  const entries = reviewRead(() =>
    reviewRoundEntries(fs.readdirSync(directory))
  );

  const rounds = entries.map(({ name, number }) =>
    loadIdentityRound(path.join(directory, name), number)
  );

  const latestRound = rounds.at(-1);

  // A confirmation-only round re-uses its predecessor's target, so identity and
  // settled findings anchor to the latest round that reviewed the target itself.
  const reviewed = rounds.findLast(
    (value) => !/\(confirmation-only\)/iu.test(value.scope)
  );

  const baseline = latestRound?.head;

  if (
    !latestRound ||
    !reviewed ||
    typeof baseline !== "string" ||
    !/^(?<cap1>[a-f0-9]{40}|[a-f0-9]{64})$/u.test(baseline)
  ) {
    refuse("review-required");
  }

  const hashes = currentHashes(
    ctx.manifest.repositoryRoot,
    latest(fold, "bind")
  );

  const last = validateHeader(
    latestRound,
    /^(?:Full review|Re-review round \d+ \((?:full|narrowed|coverage|confirmation-only)\))/iu,
    baseline,
    base,
    hashes
  );

  const substantive = validateHeader(
    reviewed,
    /^(?:Full review|Re-review round \d+ \((?:full|narrowed|coverage)\))/iu,
    baseline,
    base,
    hashes
  );

  // Coverage replaces the last-round failure check: majority or overridden slots pass; rerun, user and unreadable state refuse.
  let coverage;

  try {
    coverage = coverageState(
      ctx.session,
      fold,
      INTEGRATION_REVIEW,
      applicableReviewIds(ctx.manifest, fold).get(INTEGRATION_REVIEW)
    );
  } catch (error) {
    if (error instanceof ToolError && error.reason === "coverage-required") {
      refuse("review-required");
    }

    throw error;
  }

  if (coverage.decision === "rerun" || coverage.decision === "user") {
    refuse("review-required");
  }

  const covered = new Set([
    ...coverage.open,
    ...coverage.overridden.map((item) => item.slot),
  ]);

  const validateSlots = (
    entry: ReturnType<typeof validateHeader>,
    expected?: (slot: string) => readonly string[]
  ) => {
    const savedFiles = [];

    for (const seat of entry.roster) {
      if (!isRecord(seat)) {
        refuse("review-required");
      }

      if (
        seat["reserve"] !== undefined &&
        seat["reserve"] !== null &&
        seat["reserve"] !== false &&
        seat["reserve"] !== "" &&
        seat["reserve"] !== 0
      ) {
        continue;
      }

      const { slot } = seat;

      if (typeof slot !== "string") {
        refuse("review-required");
      }

      const saved = reviewObject(
        reviewSlotFile(
          reviewGenerationDirectory(entry.dir, entry.generation),
          slot
        )
      );

      const requestIds = expected?.(slot);

      if (
        saved["slot"] !== slot ||
        !(saved["state"] === "done"
          ? typeof saved["text"] === "string" &&
            parseReport({
              kind: "code",
              source: slot,
              text: saved["text"],
              ...(requestIds && { expectedRequestIds: requestIds }),
            }).ok
          : saved["state"] === "failed" && covered.has(slot))
      ) {
        refuse("review-required");
      }

      savedFiles.push(saved);
    }

    if (!savedFiles.length) {
      refuse("review-required");
    }

    return savedFiles;
  };

  const files = validateSlots(substantive);

  if (latestRound !== reviewed) {
    const lastFiles = validateSlots(last, (slot) =>
      requestsForSlot(last.requests, slot)
    );

    files.push(...lastFiles);

    if (!lastFiles.some((saved) => saved["state"] === "done")) {
      refuse("review-required");
    }
  }

  if (!files.some((saved) => saved["state"] === "done")) {
    refuse("review-required");
  }

  const round = substantive;
  const { findings } = substantive;
  const escalations = new Map<string, string>();

  for (const r of fold.records) {
    if (r.kind === "escalation") {
      const id: unknown = r.data["id"];
      const state: unknown = r.data["state"];

      if (typeof id === "string" && typeof state === "string") {
        escalations.set(id, state);
      }
    }
  }

  // NOTE: review ids hold no colon, so the second segment of a recurrence id names its review.
  const closedRecurrence = (id: string) => {
    const [kind, review] = id.split(":");

    return (
      kind === "recurrence" &&
      review !== undefined &&
      isReviewClosed(ctx.session, fold, review, INTEGRATION_REVIEW)
    );
  };

  if (
    [...escalations].some(
      ([id, state]) => state === "open" && !closedRecurrence(id)
    )
  ) {
    refuse("review-required");
  }

  const all = rounds.flatMap((r) => r.findings);

  if (new Set(findings.map((finding) => finding.id)).size !== findings.length) {
    refuse("review-required");
  }

  // The corrected severity of a code-integration finding, from every ruling recorded for it.
  const effective = (finding: ReturnType<typeof storedFinding>) =>
    effectiveSeverity(
      finding,
      fold.records.filter(
        (r) =>
          r.kind === "ruling" && r.data["subject"] === rulingPrefix + finding.id
      )
    );

  const settled = (
    finding: ReturnType<typeof storedFinding>,
    seen = new Set<string>()
  ): boolean => {
    if (seen.has(finding.id)) {
      return false;
    }

    seen.add(finding.id);

    const ruling = fold.records.findLast(
      (r) =>
        r.kind === "ruling" && r.data["subject"] === rulingPrefix + finding.id
    );

    const rationale: unknown = ruling?.data["rationale"];

    if (!ruling || typeof rationale !== "string" || !rationale.trim()) {
      return false;
    }

    if (ruling.data["ruling"] === "rejected") {
      return (
        effective(finding) !== "MUST" ||
        states.some(
          (state) =>
            state.request.review === INTEGRATION_REVIEW &&
            state.request.finding === finding.id &&
            state.state === "confirmed"
        )
      );
    }

    if (ruling.data["ruling"] === "duplicate") {
      const original = all.find(
        (f) => f.id !== finding.id && rationale.includes(f.id)
      );

      return !!original && settled(original, seen);
    }

    if (ruling.data["ruling"] === "accepted") {
      return (
        ruling.seq <= round.startSeq &&
        rounds.some(
          (r) =>
            typeof r.round === "number" &&
            r.round < round.round &&
            r.head !== baseline &&
            r.findings.some((f) => f.id === finding.id)
        ) &&
        !findings.some(
          (f) =>
            f.id === finding.id ||
            f.unresolved === finding.id ||
            f.recurrence === finding.id
        ) &&
        !last.findings.some(
          (f) =>
            f.id === finding.id ||
            f.unresolved === finding.id ||
            f.recurrence === finding.id
        )
      );
    }

    return false;
  };

  if (all.some((f) => effective(f) === "MUST" && !settled(f))) {
    refuse("review-required");
  }

  const corrections: ReviewCorrection[] = [];

  if (head !== baseline) {
    if (
      typeof round.cap !== "number" ||
      !Number.isSafeInteger(round.cap) ||
      round.cap < 1 ||
      round.round < round.cap
    ) {
      refuse("review-required");
    }

    const lines = await gitOk(ctx.deps, cwd, [
      "rev-list",
      "--reverse",
      "--parents",
      `${baseline}..${head}`,
    ]);

    const commits = lines
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => line.split(" "));

    if (!commits.length) {
      refuse("review-required");
    }

    let parent = baseline;
    let lastSeq = round.startSeq;

    const finalFindings = new Map(
      findings.map((finding) => [finding.id, finding])
    );

    for (const row of commits) {
      const [commit, ...parents] = row;

      if (
        commit === undefined ||
        commit === "" ||
        parents.length !== 1 ||
        parents[0] !== parent
      ) {
        refuse("review-required");
      }

      const matches = fold.records.filter(
        (record) =>
          record.kind === "integrate" &&
          record.data["phase"] === "fix" &&
          record.data["commit"] === commit
      );

      const [record] = matches;

      if (!record || matches.length !== 1) {
        refuse("review-required");
      }

      let metadata: ReviewFix;

      try {
        metadata = validateReviewFix(record.data["reviewFix"]);
      } catch {
        refuse("review-required");
      }

      if (
        record.by !== "tool" ||
        metadata.review !== INTEGRATION_REVIEW ||
        metadata.round !== round.round ||
        metadata.generation !== round.generation ||
        metadata.from !== baseline ||
        record.seq <= lastSeq
      ) {
        refuse("review-required");
      }

      for (const id of metadata.findings) {
        const finding = finalFindings.get(id);

        const ruling = fold.records.findLast(
          (candidate) =>
            candidate.kind === "ruling" &&
            candidate.data["subject"] === rulingPrefix + id
        );

        // NOTE: a finding corrected down to CONSIDER keeps its required fix; a reviewer-rated CONSIDER does not qualify.
        const qualifies =
          finding &&
          (effective(finding) === "SHOULD" ||
            (effective(finding) === "CONSIDER" &&
              finding.severity !== "CONSIDER"));

        if (
          qualifies !== true ||
          !ruling ||
          ruling.data["ruling"] !== "accepted" ||
          // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
          !String(ruling.data["rationale"] ?? "").trim() ||
          ruling.seq <= round.startSeq ||
          ruling.seq >= record.seq
        ) {
          refuse("review-required");
        }
      }

      const allowed = new Set<string>();

      for (const id of metadata.findings) {
        const declaration = fold.records.findLast(
          (candidate) =>
            candidate.kind === "ruling" &&
            candidate.data["subject"] === rulingPrefix + id &&
            candidate.data["ruling"] === "accepted" &&
            Object.hasOwn(candidate.data, "paths")
        );

        const paths = correctionScope(
          finalFindings.get(id),
          declaration?.data["paths"]
        );

        if (paths === null || paths.length === 0) {
          refuse("review-required");
        }

        for (const file of paths) {
          allowed.add(file);
        }
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
      const changes = await gitPaths(ctx.deps, cwd, [
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "--no-renames",
        "-r",
        "-z",
        commit,
      ]);

      if (
        !changes.length ||
        changes.some((file) => !allowed.has(file.replaceAll("\\", "/")))
      ) {
        refuse("review-required");
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
      const message = await gitOk(ctx.deps, cwd, [
        "log",
        "-1",
        "--format=%B",
        commit,
      ]);

      if (
        message.split(/\r?\n/u)[0] !==
          // oxlint-disable-next-line typescript/restrict-template-expressions, typescript/no-base-to-string -- reason is a validated record string field; interpolation renders its scalar text.
          `fix(dispatch): ${record.data["reason"]}` ||
        !message
          .split(/\r?\n/u)
          .includes(`Dispatch-Fix: ${ctx.manifest.safeSessionId}`)
      ) {
        refuse("review-required");
      }

      let committed: ReviewFix | undefined;

      try {
        committed = reviewFixFromCommit(message);
      } catch {
        refuse("review-required");
      }

      if (!committed || !equal(committed, metadata)) {
        refuse("review-required");
      }

      corrections.push({
        commit,
        seq: record.seq,
        // oxlint-disable-next-line typescript/no-base-to-string -- record data fields are schema-validated scalars; stringification renders their scalar text.
        reason: String(record.data["reason"]),
        reviewFix: metadata,
        paths: changes,
      });
      parent = commit;
      lastSeq = record.seq;
    }

    if (parent !== head) {
      refuse("review-required");
    }
  }

  const identity = digest({
    rounds: rounds.map((r) => r.raw),
    files,
    rulings: fold.records.filter((r) => {
      const subject: unknown = r.data["subject"];

      return (
        r.kind === "ruling" &&
        typeof subject === "string" &&
        subject.startsWith(rulingPrefix)
      );
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
};
