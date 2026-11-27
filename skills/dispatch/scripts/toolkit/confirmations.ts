import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isRecord } from "../lib/config.ts";
import type { Manifest } from "../lib/session.ts";
import { parseReport } from "./domain/report.ts";
import { effectiveSeverity } from "./domain/severity.ts";
import type { Finding, RosterSlot } from "./domain/types.ts";
import type { SlotOutcome } from "./fanout.ts";
import type { FindingsValue } from "./findings.ts";
import { integrationRecord } from "./integration-state.ts";
import { latest } from "./ledger.ts";
import type { Fold } from "./ledger.ts";
import { present, textValue } from "./narrow.ts";
import { ToolError } from "./output.ts";
import type { LedgerRecord } from "./records.ts";
import {
  canonical,
  INTEGRATION_REVIEW,
  reviewDirectory,
  reviewRoundFile,
  reviewFindingsFile,
  reviewGenerationDirectory,
  reviewSlotFile,
  reviewRoundEntries,
} from "./review-state.ts";
import type { ReviewTarget } from "./review-state.ts";

export interface RejectionRequest {
  requestId: string;
  review: string;
  finding: string;
  rulingSeq: number;
  claim: Finding;
  rationale: string;
  target: ReviewTarget;
  spec: { path: string; hash: string };
  sourceSlots: string[];
}

export type RejectionReply = RejectionRequest & {
  sourceSlot: string;
  responder?: Extract<SlotOutcome, { state: "done" }>["responder"];
  decision: "agree" | "disagree";
  replyRationale: string;
};

export interface RejectionState {
  request: RejectionRequest;
  state: "pending" | "confirmed" | "escalated";
  disagreements: number;
  noResponses: number;
}

export interface ConfirmationRound {
  review: string;
  metadata: {
    round: number;
    cap?: number;
    generation: number;
    startSeq: number;
    target: ReviewTarget;
    spec: { path: string; hash: string };
    artifactPath?: string;
    roster: RosterSlot[];
    requests?: readonly RejectionRequest[];
  };
  findings: FindingsValue;
}

const identity = (
  request: Omit<
    RejectionRequest,
    "requestId" | "claim" | "rationale" | "sourceSlots"
  >
) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        request.review,
        request.finding,
        request.rulingSeq,
        request.target,
        request.spec,
      ])
    )
    .digest("hex");

export const rejectionRequest = (
  request: Omit<RejectionRequest, "requestId">
) => ({ ...request, requestId: identity(request) });

/** Only attributed replies to the captured ruling can close a rejection. */
// oxlint-disable-next-line eslint/complexity -- rejection fold branches per round severity, ruling state, and reply confirmation.
export const rejectionState = (
  rounds: readonly ConfirmationRound[],
  rulings: readonly LedgerRecord[],
  escalations: readonly LedgerRecord[]
) => {
  const states: RejectionState[] = [];

  for (const round of rounds) {
    for (const finding of round.findings.findings) {
      const history = rulings.filter(
        (row) =>
          row.kind === "ruling" &&
          row.data["subject"] === `review:${round.review}:${finding.id}`
      );

      if (effectiveSeverity(finding, history) !== "MUST") {
        continue;
      }

      const ruling = history.findLast(
        (row) =>
          row.data["ruling"] === "accepted" || row.data["ruling"] === "rejected"
      );

      if (ruling?.data["ruling"] !== "rejected") {
        continue;
      }

      const current = present(
        rounds.findLast((value) => value.review === round.review),
        "review round"
      ).metadata;

      const sources = finding.sources.filter((slot) => slot !== "tool");

      const sourceSlots = sources.length
        ? sources
        : round.metadata.roster
            .filter((slot) => !slot.reserve)
            .slice(0, 1)
            .map((slot) => slot.slot);

      if (!sourceSlots.length) {
        throw new ToolError(
          4,
          "review-confirmation-required",
          `No saved reviewer can confirm tool finding ${finding.id}`
        );
      }

      let request = rejectionRequest({
        review: round.review,
        finding: finding.id,
        rulingSeq: ruling.seq,
        claim: finding,
        rationale: textValue(ruling.data["rationale"]),
        target: current.target,
        spec: current.spec,
        sourceSlots,
      });

      const accepted =
        history.findLast((row) => row.data["ruling"] === "accepted")?.seq ?? 0;

      const resolved =
        escalations.findLast(
          (row) =>
            row.kind === "escalation" &&
            row.data["id"] === `rejection:${round.review}:${finding.id}` &&
            row.data["state"] === "resolved"
        )?.seq ?? 0;

      let disagreements = 0;
      const unanswered = new Map<string, number>();
      const agreements = new Map<string, Set<string>>();
      let confirmed = false;

      for (const replyRound of rounds.filter(
        (value) => value.review === round.review
      )) {
        let agreement = false;
        let disagreed = false;

        const responded = new Set<string>();

        for (const reply of replyRound.findings.confirmations ?? []) {
          if (
            replyRound.metadata.requests?.some(
              (candidate) =>
                candidate.requestId === reply.requestId &&
                candidate.sourceSlots.includes(reply.sourceSlot)
            ) !== true ||
            reply.rulingSeq > replyRound.metadata.startSeq
          ) {
            continue;
          }

          if (
            reply.review !== round.review ||
            reply.finding !== finding.id ||
            reply.rulingSeq <= accepted ||
            !history.some(
              (row) =>
                row.seq === reply.rulingSeq && row.data["ruling"] === "rejected"
            ) ||
            !request.sourceSlots.includes(reply.sourceSlot) ||
            !reply.replyRationale?.trim() ||
            reply.requestId !== identity(reply)
          ) {
            continue;
          }

          if (
            JSON.stringify(reply.target) !==
              JSON.stringify(replyRound.metadata.target) ||
            JSON.stringify(reply.spec) !==
              JSON.stringify(replyRound.metadata.spec)
          ) {
            continue;
          }

          const { responder } = reply;

          if (
            !responder ||
            !replyRound.metadata.roster.some(
              (slot) => slot.slot === reply.sourceSlot && !slot.reserve
            )
          ) {
            continue;
          }

          if (
            !responder.native &&
            !replyRound.metadata.roster.some(
              (slot) =>
                slot.slot === responder.slot &&
                slot.provider === responder.provider &&
                (slot.slot === reply.sourceSlot || slot.reserve)
            )
          ) {
            continue;
          }

          if (responder.native && responder.slot !== reply.sourceSlot) {
            continue;
          }

          responded.add(reply.sourceSlot);
          const agreed = agreements.get(reply.requestId) ?? new Set<string>();
          agreements.set(reply.requestId, agreed);

          if (reply.decision === "agree") {
            agreement = true;

            if (reply.rulingSeq === ruling.seq) {
              agreed.add(reply.sourceSlot);
            }
          } else if (reply.decision === "disagree") {
            disagreed = true;
            agreed.delete(reply.sourceSlot);
          }

          if (!confirmed && sourceSlots.every((slot) => agreed.has(slot))) {
            confirmed = true;
            request = rejectionRequest({
              ...request,
              target: reply.target,
              spec: reply.spec,
            });
          }
        }

        if (disagreed) {
          disagreements += 1;
        } else if (agreement) {
          disagreements = 0;
        }

        if (replyRound.metadata.startSeq >= Math.max(accepted, resolved)) {
          for (const slot of sourceSlots) {
            if (
              replyRound.metadata.requests?.some(
                (value) =>
                  value.finding === finding.id &&
                  value.sourceSlots.includes(slot)
              ) !== true
            ) {
              continue;
            }

            const previous = unanswered.get(slot) ?? 0;
            unanswered.set(
              slot,
              responded.has(slot)
                ? 0
                : previous +
                    Number(
                      replyRound.metadata.round >
                        (replyRound.metadata.cap ?? Infinity)
                    )
            );
          }
        }
      }

      const escalation = escalations.findLast(
        (row) =>
          row.kind === "escalation" &&
          row.data["id"] === `rejection:${round.review}:${finding.id}`
      );

      let state: "confirmed" | "escalated" | "pending" = "pending";

      if (confirmed) {
        state = "confirmed";
      } else if (escalation?.data["state"] === "open") {
        state = "escalated";
      }

      states.push({
        request,
        state,
        disagreements,
        noResponses: Math.max(0, ...unanswered.values()),
      });
    }
  }

  return states;
};

export const reviewId = (
  kind: string,
  artifact: string,
  gitSeries?: string
) => {
  let slug = (
    kind === "code" ? artifact : path.basename(artifact, ".md")
  ).replaceAll(/[^A-Za-z0-9_.-]/gu, "-");

  if (gitSeries !== undefined) {
    slug += `-${crypto
      .createHash("sha256")
      .update(artifact + gitSeries)
      .digest("hex")}`;
  }

  if (!slug || slug === "." || slug === "..") {
    throw new ToolError(1, "invalid-input", "Invalid review target");
  }

  return `${kind}-${slug}`;
};

type Selection = ReadonlyMap<
  string,
  (metadata: ConfirmationRound["metadata"]) => boolean
>;

const isIdList = (
  selected: readonly string[] | Selection
): selected is readonly string[] => Array.isArray(selected);

// SECTION: Saved round validation
// Stored rounds are trusted past these checks: they prove what rejection confirmation reads.
const isRoundMetadata = (
  value: unknown
): value is ConfirmationRound["metadata"] =>
  isRecord(value) &&
  isRecord(value["spec"]) &&
  Boolean(value["spec"]["path"]) &&
  Boolean(value["target"]);

const SEVERITIES = new Set<unknown>(["MUST", "SHOULD", "CONSIDER"]);

const isConfirmableFinding = (value: unknown) =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  SEVERITIES.has(value["severity"]) &&
  Array.isArray(value["sources"]) &&
  value["sources"].every((source) => typeof source === "string");

const isSavedFindings = (value: unknown): value is FindingsValue =>
  isRecord(value) &&
  Array.isArray(value["findings"]) &&
  value["findings"].every(isConfirmableFinding);

/** A reply counts only when the saved slot report it came from still says the same. */
const isReplyBacked = (
  dir: string,
  review: string,
  metadata: ConfirmationRound["metadata"],
  reply: RejectionReply
) => {
  try {
    const saved: unknown = JSON.parse(
      fs.readFileSync(
        reviewSlotFile(
          reviewGenerationDirectory(dir, metadata.generation),
          reply.sourceSlot
        ),
        "utf-8"
      )
    );

    if (
      !isRecord(saved) ||
      saved["state"] !== "done" ||
      saved["slot"] !== reply.sourceSlot ||
      JSON.stringify(saved["responder"]) !== JSON.stringify(reply.responder)
    ) {
      return false;
    }

    const expectedRequestIds = (metadata.requests ?? []).flatMap((request) =>
      request.sourceSlots.includes(reply.sourceSlot) ? [request.requestId] : []
    );

    let reportKind: "code" | "design" | "plan" = "plan";

    if (review.startsWith("code-")) {
      reportKind = "code";
    } else if (review.startsWith("design-")) {
      reportKind = "design";
    }

    const parsed = parseReport({
      kind: reportKind,
      source: reply.sourceSlot,
      text: textValue(saved["text"]),
      expectedRequestIds,
    });

    return Boolean(
      parsed.ok &&
      parsed.confirmations?.some(
        (value) =>
          value.requestId === reply.requestId &&
          value.decision === reply.decision &&
          value.rationale === reply.replyRationale
      )
    );
  } catch {
    return false;
  }
};

export const applicableReviewIds = (manifest: Manifest, fold: Fold) => {
  const bind = latest(fold, "bind");

  const selected = new Map<
    string,
    (metadata: ConfirmationRound["metadata"]) => boolean
  >();

  if (!bind) {
    return selected;
  }

  const spec = canonical(
    path.resolve(manifest.repositoryRoot, textValue(bind.data["spec"]))
  );

  for (const kind of ["plan", "design"] as const) {
    if (typeof bind.data[kind] === "string") {
      const artifact = canonical(
        path.resolve(manifest.repositoryRoot, bind.data[kind])
      );

      selected.set(
        reviewId(kind, artifact),
        (metadata) =>
          canonical(metadata.spec.path) === spec &&
          (metadata.artifactPath === undefined ||
            metadata.artifactPath === "" ||
            canonical(metadata.artifactPath) === artifact)
      );
    }
  }

  const opened = integrationRecord(fold);

  if (opened) {
    selected.set(
      INTEGRATION_REVIEW,
      (metadata) =>
        canonical(metadata.spec.path) === spec &&
        typeof metadata.target !== "string" &&
        metadata.target.base === opened.data["base"]
    );
  }

  return selected;
};

export const loadRejections = (
  session: string,
  fold: Fold,
  selected: readonly string[] | Selection
) => {
  const rounds: ConfirmationRound[] = [];

  const entries = isIdList(selected)
    ? selected.map((id) => [id, () => true] as const)
    : [...selected];

  for (const [review, applies] of entries) {
    if (
      !fold.records.some(
        (row) =>
          row.kind === "ruling" &&
          textValue(row.data["subject"]).startsWith(`review:${review}:`) &&
          row.data["ruling"] === "rejected"
      )
    ) {
      continue;
    }

    const directory = reviewDirectory(session, review);

    if (!fs.existsSync(directory)) {
      continue;
    }

    for (const { name } of reviewRoundEntries(fs.readdirSync(directory))) {
      const dir = path.join(directory, name);

      if (
        !fs.existsSync(reviewRoundFile(dir)) &&
        fs.readdirSync(dir).length === 0
      ) {
        continue;
      }

      try {
        const metadata: unknown = JSON.parse(
          fs.readFileSync(reviewRoundFile(dir), "utf-8")
        );

        if (!isRoundMetadata(metadata)) {
          throw new Error("Invalid round");
        }

        if (!applies(metadata)) {
          continue;
        }

        if (!metadata.spec.hash || !Array.isArray(metadata.roster)) {
          throw new Error("Invalid round");
        }

        if (!fs.existsSync(reviewFindingsFile(dir))) {
          continue;
        }

        const findings: unknown = JSON.parse(
          fs.readFileSync(reviewFindingsFile(dir), "utf-8")
        );

        if (!isSavedFindings(findings)) {
          throw new Error("Invalid findings");
        }

        findings.confirmations = (
          Array.isArray(findings.confirmations) ? findings.confirmations : []
        ).filter((reply) => isReplyBacked(dir, review, metadata, reply));
        rounds.push({ review, metadata, findings });
      } catch {
        throw new ToolError(
          4,
          "review-confirmation-required",
          `Cannot establish rejection confirmation for ${review}/${name}`
        );
      }
    }
  }

  return rejectionState(rounds, fold.records, fold.records);
};
