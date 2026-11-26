import fs from "node:fs";
import path from "node:path";

import { nodeLinkFs } from "../lib/node-fs-ext.ts";
import type { Manifest } from "../lib/session.ts";
import { reviewId, loadRejections } from "./confirmations.ts";
import type { RejectionState } from "./confirmations.ts";
import { RESOLUTION_HEADING } from "./domain/document-lint.ts";
import { sectionRanges, structuralLines } from "./domain/markdown-structure.ts";
import { neutralizeComments } from "./domain/sanitize.ts";
import { effectiveSeverity, RANK } from "./domain/severity.ts";
import type { Finding, Severity } from "./domain/types.ts";
import { admission, renderBudget } from "./findings.ts";
import { foldLedger, latest } from "./ledger.ts";
import type { Fold } from "./ledger.ts";
import { present } from "./narrow.ts";
import {
  reviewDirectory,
  reviewFindingsFile,
  reviewPointer,
  reviewRoundDirectory,
} from "./review-state.ts";
import { readReviews } from "./review-storage.ts";
import type { ReviewRound } from "./review-storage.ts";
import type { WalkthroughView } from "./walkthrough.ts";

type ReviewRow = WalkthroughView["reviewRows"][number];

export interface RoundLink {
  review: string;
  round: number;
  findings: number;
  path: string;
}

const RULINGS = ["accepted", "rejected", "duplicate", "deferred"] as const;
const isSeverity = (value: string): value is Severity => value in RANK;

export const line = (value: unknown) =>
  neutralizeComments(
    // oxlint-disable-next-line typescript/no-base-to-string -- renderer input is a scalar string or nullish; String renders its scalar text.
    String(value ?? "")
      .replaceAll(/\r\n?/gu, "\n")
      .replaceAll("\n", " ")
      .trim()
  );

const cell = (value: unknown) =>
  neutralizeComments(
    // oxlint-disable-next-line typescript/no-base-to-string -- renderer input is a scalar string or nullish; String renders its scalar text.
    String(value ?? "")
      .replaceAll(/\r\n?/gu, "\n")
      .replaceAll("\n", " ")
      .replaceAll("\\", String.raw`\\`)
      .replaceAll("|", String.raw`\|`)
      .trim()
  );

// Only captured responder metadata identifies the model; roster effort needs a matching CLI slot.
// oxlint-disable-next-line eslint/complexity -- label branches per responder nativeness, physical-slot match, and effort presence.
const slotLabel = (round: ReviewRound, id: string) => {
  const sourceSlot = round.roster.find((slot) => slot.slot === id);
  const outcome = round.slots.find((slot) => slot.slot === id);
  const responder = outcome?.state === "done" ? outcome.responder : undefined;

  const physicalSlot =
    responder && round.roster.find((slot) => slot.slot === responder.slot);

  const provider =
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing, typescript/strict-boolean-expressions -- empty provider strings fall through to the next source.
    responder?.provider || sourceSlot?.provider || "provider unavailable";

  const model =
    typeof responder?.model === "string" && responder.model.trim()
      ? responder.model
      : `unknown (${provider}/${responder?.slot ?? id})`;

  let effort: string | undefined;

  if (responder?.native === true) {
    effort =
      typeof responder.effort === "string" ? responder.effort : undefined;
  } else if (
    responder?.native === false &&
    physicalSlot?.provider === responder.provider &&
    // SAFETY: the provider-equality guard above narrows physicalSlot to a defined roster entry; the assertion only reads its optional native flag.
    (physicalSlot as { native?: boolean }).native !== true
  ) {
    // SAFETY: the provider-equality guard above narrows physicalSlot to a defined roster entry; the assertion only reads its optional effort field.
    ({ effort } = physicalSlot as { effort?: string });
  } else {
    effort = undefined;
  }

  return typeof effort === "string" ? `${model}/${effort}` : model;
};

const clip = (value: string, limit: number) => {
  const chars: string[] = [];

  for (const character of line(value)) {
    chars.push(character);
  }

  return chars.length > limit
    ? `${chars.slice(0, limit - 1).join("")}…`
    : chars.join("");
};

// oxlint-disable-next-line eslint/complexity -- row assembly branches per round selection, findings shape, and raw entry.
export const reviewRows = (
  session: string,
  fold: Fold,
  confirmations: readonly RejectionState[],
  reviews?: readonly string[]
) => {
  const rows: ReviewRow[] = [];
  const selected = reviews ? new Set(reviews) : null;
  const rounds: RoundLink[] = [];

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
        reviewFindingsFile(
          reviewRoundDirectory(
            reviewDirectory(session, round.review),
            round.round
          )
        )
      ),
    });

    for (const raw of findings) {
      if (
        raw === null ||
        raw === undefined ||
        typeof raw !== "object" ||
        typeof raw.id !== "string"
      ) {
        continue;
      }

      // SAFETY: the object/id guard above narrows raw to a finding-shaped record; the assertion only names its optional finding fields.
      const finding = raw as {
        id: string;
        severity?: unknown;
        sources?: unknown;
        recurrence?: { of?: unknown };
        unresolved?: { of?: unknown };
        origin?: unknown;
      };

      const history = fold.records.filter(
        (record) =>
          record.kind === "ruling" &&
          record.data["subject"] === `review:${round.review}:${finding.id}`
      );

      const ruling = history.at(-1);

      const stored =
        typeof finding.severity === "string" ? finding.severity : "unknown";

      const severity: string = isSeverity(stored)
        ? effectiveSeverity({ severity: stored }, history)
        : stored;

      const rulingValue: unknown = ruling?.data["ruling"];

      const confirmation = confirmations.find(
        (state) =>
          state.request.review === round.review &&
          state.request.finding === finding.id
      );

      rows.push({
        review: round.review,
        id: finding.id,
        round: round.round,
        severity,
        ...(isSeverity(stored) &&
          isSeverity(severity) &&
          RANK[severity] < RANK[stored] && { downgradedFrom: stored }),
        sources: (Array.isArray(finding.sources) ? finding.sources : [])
          .filter((id): id is string => typeof id === "string")
          .map((id) => slotLabel(round, id)),
        ruling: RULINGS.find((value) => value === rulingValue) ?? null,
        rationale:
          (confirmation && confirmation.state !== "confirmed"
            ? `[${confirmation.state} reviewer confirmation] `
            : "") +
          (typeof ruling?.data["rationale"] === "string"
            ? ruling.data["rationale"]
            : ""),
        ...(typeof finding.recurrence?.of === "string" && {
          recurrence: finding.recurrence.of,
        }),
        ...(typeof finding.unresolved?.of === "string" && {
          unresolved: finding.unresolved.of,
        }),
        ...((finding.origin === "original" ||
          finding.origin === "fix-induced" ||
          finding.origin === "unknown") && {
          origin: finding.origin,
        }),
      });
    }
  }

  return { rows, rounds };
};

// oxlint-disable-next-line eslint/complexity -- section branches per row/round presence and budget label.
export const renderFindingsSection = (
  rows: readonly ReviewRow[],
  rounds: readonly RoundLink[],
  fromDir: string,
  budget?: string
) => {
  const out: string[] = [];

  if (rows.length) {
    out.push(
      "| Review | ID | Round | Severity | Source | Status | Ruling |",
      "| --- | --- | --- | --- | --- | --- | --- |"
    );

    for (const row of rows) {
      const markers = [
        row.recurrence !== undefined &&
          row.recurrence !== "" &&
          `(recurs ${line(row.recurrence)})`,
        row.unresolved !== undefined &&
          row.unresolved !== "" &&
          `(unresolved ${line(row.unresolved)})`,
        row.origin !== undefined &&
          row.origin !== "" &&
          `(origin ${line(row.origin)})`,
      ].filter(Boolean);

      const rulingStatus =
        row.ruling === null
          ? "Open"
          : row.ruling.charAt(0).toUpperCase() + row.ruling.slice(1);

      const status = [
        rulingStatus,
        ...(row.downgradedFrom !== undefined && row.downgradedFrom !== ""
          ? [`(downgraded from ${line(row.downgradedFrom)})`]
          : []),
        ...markers,
      ].join(" ");

      out.push(
        `| ${cell(row.review)} | ${cell(row.id)} | ${row.round} | ${cell(row.severity)} | ${cell(row.sources !== undefined && row.sources.length > 0 ? row.sources.join(", ") : "—")} | ${cell(status)} | ${cell(clip(row.rationale, 80))} |`
      );
    }
  } else if (!rounds.length) {
    out.push("*No reviews conducted yet.*");
  }

  for (const round of rounds) {
    const target = path.isAbsolute(round.path)
      ? round.path
      : path.resolve(fromDir, round.path);

    const relative =
      path.relative(fromDir, target).split(path.sep).join("/") ||
      path.basename(target);

    const link = encodeURI(relative)
      .replaceAll("(", "%28")
      .replaceAll(")", "%29");

    if (out.length) {
      out.push("");
    }

    out.push(
      `- Round ${round.round} (${line(round.review)}): ${round.findings} findings — [findings](${link})`
    );
  }

  if (budget !== undefined && budget !== "") {
    out.push("", budget);
  }

  return out.join("\n");
};

const field = (value: unknown) => line(value) || "—";

export const renderFindingsFile = (findings: readonly Finding[]) => {
  if (!findings.length) {
    return "No findings.\n";
  }

  const sorted = [...findings].toSorted(
    (a, b) => RANK[b.severity] - RANK[a.severity]
  );

  return `${sorted
    .map((finding) =>
      [
        `### ${line(finding.id)} ${line(finding.severity)}`,
        `- Rating: ${field(finding.impact)}/${field(finding.trigger)}; category ${field(finding.category)}; scope ${field(finding.scope)}; origin ${field(finding.origin)}`,
        `- Locus: ${field(finding.locus)}`,
        `- Defect: ${field(finding.defect)}`,
        `- Required change: ${field(finding.requiredChange)}`,
        `- Sources: ${field(finding.sources?.join(", "))}`,
      ].join("\n")
    )
    .join("\n\n")}\n`;
};

export const rulingsTemplate = (
  review: string,
  round: number,
  findings: readonly Finding[]
) =>
  findings.map(({ id }) => ({
    kind: "ruling",
    by: "orchestrator",
    key: `ruling:${review}:${round}:${id}`,
    data: { subject: `review:${review}:${id}`, ruling: "", rationale: "" },
  }));

const lineStarts = (
  source: string,
  lines: ReturnType<typeof structuralLines>
) => {
  let offset = 0;

  return lines.map(({ original }) => {
    const start = offset;
    offset += original.length;

    if (source.startsWith("\r\n", offset)) {
      offset += 2;
    } else if (source[offset] === "\n") {
      offset += 1;
    }

    return start;
  });
};

const replaceFindingsSection = (source: string, body: string) => {
  const eol = /\r\n|\n/u.exec(source)?.[0] ?? "\n";
  const rendered = body.replaceAll(/\r\n?/gu, "\n").split("\n").join(eol);
  const lines = structuralLines(source);
  const [range] = sectionRanges(lines, RESOLUTION_HEADING);

  if (!range) {
    let separator = "";

    if (source) {
      separator =
        source.endsWith("\n") || source.endsWith("\r") ? eol : eol + eol;
    }

    return `${source}${separator}${RESOLUTION_HEADING}${eol}${eol}${rendered}${eol}`;
  }

  const starts = lineStarts(source, lines);

  const headerStart = present(
    starts[range.start],
    "the findings heading offset"
  );

  const headerEnd =
    headerStart +
    present(lines[range.start], "the findings heading line").original.length;

  let headerEol = "";

  if (source.startsWith("\r\n", headerEnd)) {
    headerEol = "\r\n";
  } else if (source[headerEnd] === "\n") {
    headerEol = "\n";
  }

  const bodyStart = headerEnd + headerEol.length;

  const end =
    range.end < starts.length
      ? present(starts[range.end], "the next section offset")
      : source.length;

  const separator = headerEol || eol;

  return `${source.slice(
    0,
    bodyStart
  )}${separator}${rendered}${separator}${separator}${source.slice(end)}`;
};

export const refreshFindingsSection = (
  session: string,
  manifest: Manifest,
  review: string,
  onSkip?: (reason: string) => void
) => {
  const skip = (reason: string) => {
    onSkip?.(reason);

    return "skipped";
  };

  try {
    const fold = foldLedger(session);
    const bound = latest(fold, "bind");

    const [artifact] = (["plan", "design"] as const).flatMap((kind) => {
      const relative: unknown = bound?.data[kind];

      if (typeof relative !== "string") {
        return [];
      }

      const file = path.resolve(manifest.repositoryRoot, relative);

      return reviewId(kind, file) === review ? [file] : [];
    });

    if (artifact === undefined || artifact === "") {
      return skip(`No bound plan or design matches review ${review}.`);
    }

    const source = fs.readFileSync(artifact, "utf-8");
    const confirmations = loadRejections(session, fold, [review]);
    const current = reviewRows(session, fold, confirmations, [review]);

    const resolvedRounds = current.rounds.map((round) => ({
      ...round,
      path: path.resolve(session, round.path),
    }));

    // Recomputed from the current ledger with the launch admission policy; showing it grants nothing.
    const budget = current.rounds.length
      ? `Budget (${line(review)}): ${renderBudget(admission(session, fold, review, 0).budget)}`
      : undefined;

    const body = renderFindingsSection(
      current.rows,
      resolvedRounds,
      path.dirname(artifact),
      budget
    );

    const updated = replaceFindingsSection(source, body);

    if (updated === source) {
      return "unchanged";
    }

    nodeLinkFs.writeAtomic(artifact, updated);

    return "updated";
  } catch (error) {
    return skip(error instanceof Error ? error.message : String(error));
  }
};

export const rulingReview = (subject: string) =>
  /^review:(?<cap1>(?:plan|design)-[^:]+):R\d+-F\d+$/u.exec(subject)?.[1] ??
  null;
