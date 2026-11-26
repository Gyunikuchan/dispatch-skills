import path from "node:path";

import type { CoverageState } from "./coverage.ts";
import {
  RESOLUTION_HEADING,
  RESOLUTION_TITLE,
} from "./domain/document-lint.ts";
import { neutralizeComments } from "./domain/sanitize.ts";
import { criterionStatusCounts } from "./evidence.ts";
import type { CriterionStatus } from "./evidence.ts";
import type { ReviewFixReport } from "./report.ts";
import { renderFindingsSection } from "./review-findings.ts";
import type { RoundLink } from "./review-findings.ts";

type Status = CriterionStatus;

interface Owner {
  id: string;
  title: string;
}

export interface WalkthroughView {
  title: string;
  specPath: string;
  specHash: string;
  planPath: string;
  planHash?: string;
  repositoryRoot?: string;
  designPath?: string;
  designHash?: string;
  risk?: string;
  delivered: {
    integrated: number;
    total: number;
    source: string | null;
    branch: string;
    ref: string;
  } | null;
  glance?: { what: string; how?: string; visuals?: string } | null;
  /** Parent-design visuals used only when the bound plan has no At a Glance visuals. */
  visuals?: string;
  focus?: {
    bullets?: readonly { text: string; evidence: string }[];
    visual?: string;
  } | null;
  tasks?: readonly {
    id: string;
    title: string;
    outcome: string;
    behaviour?: readonly string[];
  }[];
  statuses: readonly Status[];
  changes: readonly {
    action: "NEW" | "MODIFY" | "DELETE";
    path: string;
    owners: readonly Owner[];
  }[];
  edits: readonly {
    seq: number;
    artifact: string;
    class: string;
    rationale: string;
    diffRef: string;
    affects: readonly string[];
  }[];
  unplannedPaths: readonly string[];
  openEscalations: readonly { id: string; summary: string }[];
  deferredRulings: readonly { review: string; finding: string }[];
  deferredEscalations: readonly { id: string; summary: string }[];
  userRecords: readonly {
    seq: number;
    kind: string;
    summary: string;
    quote: string;
  }[];
  reviewRows: readonly {
    review: string;
    id: string;
    round: number;
    severity: string;
    /** The reviewer's severity when a ruling correction lowered it. */
    downgradedFrom?: string;
    /** `model/effort` of each source slot, or the slot id when the roster lacks it. */
    sources?: readonly string[];
    ruling: "accepted" | "rejected" | "duplicate" | "deferred" | null;
    rationale: string;
    recurrence?: string;
    unresolved?: string;
    origin?: string;
  }[];
  reviewRounds: readonly RoundLink[];
  reviewFixes?: readonly ReviewFixReport[];
  coverage?: CoverageState | "unreadable";
  reviewedCodeBaseline?: string;
  runtimeProof?: {
    outcome: string;
    head: string;
    reason: string;
    report?: string;
    artifacts?: string[];
    dirty?: boolean;
    fixes: { commit: string; reason: string; beforeLatest: boolean }[];
  };
  /** Criteria whose tests the cleanup commit removed keep evidence at their recorded `trees` entry. */
  testCleanup?: {
    from: string;
    trees: Readonly<Record<string, string>>;
    removed: readonly string[];
    deleted: number;
    merged: number;
  };
}

const line = (value: unknown) =>
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

const code = (value: string) => {
  const text = line(value);

  const delimiter = "`".repeat(
    Math.max(0, ...(text.match(/`+/gu) ?? []).map((run) => run.length)) + 1
  );

  return `${delimiter}${text}${delimiter}`;
};

// Escaped comment openers are inert, so keep Mermaid arrows and similar `-->` text intact.
const visualLine = (value: string) =>
  neutralizeComments(value).replaceAll("--&gt;", "-->");

const markdownLines = (value: string) =>
  value
    .replaceAll(/\r\n?/gu, "\n")
    .replaceAll(/^(?:\n)+|(?:\n)+$/gu, "")
    .split("\n")
    .map(visualLine);

const hashPrefix = (value: string | undefined) => {
  if (value === undefined || value === "" || value === "unavailable") {
    return "unavailable";
  }

  const hex = value.replace(/^sha256:/u, "");

  return `sha256:${hex.slice(0, 12)}`;
};

const reviewFixFindings = (fix: ReviewFixReport) =>
  fix.metadata.findings.length
    ? fix.metadata.findings.map(line).join(", ")
    : line(fix.commit).slice(0, 12);

const statusTable = (statuses: readonly Status[], state: Status["state"]) => {
  const rows = statuses.filter((row) => row.state === state);

  if (!rows.length) {
    return ["None."];
  }

  const out = ["| SC | Evidence |", "| --- | --- |"];

  for (const row of rows) {
    let evidence = "no eligible evidence";

    if (row.state === "verified") {
      evidence =
        (row.reason?.endsWith("tests removed in cleanup") === true &&
        row.evidence !== undefined &&
        row.evidence !== ""
          ? `[source evidence](${row.evidence})`
          : (row.evidence ?? "verified evidence")) +
        (row.reason !== undefined && row.reason !== ""
          ? `; ${row.reason}`
          : "");
    }

    out.push(`| ${cell(row.criterion)} | ${cell(evidence)} |`);
  }

  return out;
};

const exceptionSection = (
  statuses: readonly Status[],
  state: Extract<Status["state"], "manual" | "waived" | "missing">
) => {
  const rows = statuses.filter((row) => row.state === state);

  if (!rows.length) {
    return [];
  }

  const title = state.charAt(0).toUpperCase() + state.slice(1);

  const details = rows.map((row) => {
    if (row.state === "manual") {
      return `- ${cell(row.criterion)} · User evidence: ${cell(row.evidence ?? "not supplied")}; quote: ${cell(row.quote ?? "")}`;
    }

    if (row.state === "waived") {
      return `- ${cell(row.criterion)} · Reason: ${cell(row.reason ?? "")}; quote: ${cell(row.quote ?? "")}`;
    }

    return `- ${cell(row.criterion)} · ${cell(row.reason ?? "no eligible evidence")}`;
  });

  return [`### ${title}`, "", ...details, ""];
};

// oxlint-disable-next-line eslint/complexity -- focus branches per escalation bucket, review-row state, and fix presence.
const reviewFocus = (view: WalkthroughView) => {
  const tier = view.risk ?? "low";
  const attention: string[] = [];

  for (const item of view.openEscalations) {
    attention.push(
      `- Open escalation ${line(item.id)} — see Deviations & Follow-ups`
    );
  }

  for (const item of view.deferredRulings) {
    attention.push(
      `- Deferred finding ${line(item.review)}:${line(item.finding)} — see Deviations & Follow-ups`
    );
  }

  for (const item of view.deferredEscalations) {
    attention.push(
      `- Deferred escalation ${line(item.id)} — see Deviations & Follow-ups`
    );
  }

  for (const row of view.reviewRows) {
    if (row.ruling === null) {
      attention.push(
        `- Open finding ${line(row.review)}:${line(row.id)} (${line(row.severity)}) — see ${RESOLUTION_TITLE}`
      );
    }
  }

  for (const row of view.statuses) {
    if (row.state === "verified") {
      continue;
    }

    const label = row.state.charAt(0).toUpperCase() + row.state.slice(1);
    attention.push(
      `- ${label} criterion ${line(row.criterion)} — see Verification`
    );
  }

  for (const fix of view.reviewFixes ?? []) {
    if (fix.status !== "re-reviewed") {
      attention.push(
        `- Review fix ${reviewFixFindings(fix)}: ${fix.status} — see Deviations & Follow-ups`
      );
    }
  }

  for (const file of view.unplannedPaths) {
    attention.push(
      `- Unplanned path ${line(file)} — see Deviations & Follow-ups`
    );
  }

  for (const row of view.reviewRows) {
    if (
      row.ruling === "rejected" &&
      (row.severity === "MUST" || row.severity === "SHOULD")
    ) {
      attention.push(
        `- Rejected ${line(row.severity)} finding ${line(row.review)}:${line(row.id)} — see ${RESOLUTION_TITLE}`
      );
    }
  }

  for (const row of view.reviewRows) {
    if (row.downgradedFrom !== undefined && row.downgradedFrom !== "") {
      attention.push(
        `- Downgraded finding ${line(row.review)}:${line(row.id)} (${line(row.downgradedFrom)} to ${line(row.severity)}) — see ${RESOLUTION_TITLE}`
      );
    }
  }

  for (const edit of view.edits) {
    if (!["intent", "dependency", "discard"].includes(edit.class)) {
      continue;
    }

    let artifact: string;

    if (edit.artifact === "plan") {
      artifact = "Plan";
    } else if (edit.artifact === "design") {
      artifact = "Design";
    } else {
      artifact = line(edit.artifact);
    }

    attention.push(
      `- ${artifact} edit (${line(edit.class)}) seq ${edit.seq} — see Deviations & Follow-ups`
    );
  }

  const lines = attention.length
    ? [`- Risk: ${tier}`, ...attention]
    : [
        `- Risk: ${tier} · Delivery matched the plan and all criteria are verified.`,
      ];

  for (const bullet of view.focus?.bullets ?? []) {
    const evidence = line(bullet.evidence);
    lines.push(`- ${line(bullet.text)} — Evidence: [${evidence}](${evidence})`);
  }

  return lines;
};

const coverageLines = (state: WalkthroughView["coverage"]) => {
  if (state === undefined) {
    return [];
  }

  const lines =
    state === "unreadable"
      ? ["- Coverage state unreadable"]
      : [
          ...(state.open.length
            ? [
                `- Open coverage slots: ${state.open.map(line).join(", ")}${state.decision === "majority" ? `; reduced coverage accepted under the majority rule (${state.completed.length} of ${state.targets.length} target slots completed)` : ""}`,
              ]
            : []),
          ...state.overridden.map(
            (item) =>
              `- Coverage override: ${line(item.slot)} at seq ${item.seq}; user quote: ${line(item.quote)}`
          ),
          ...(state.coverageRounds.length
            ? [`- Coverage rounds: ${state.coverageRounds.join(", ")}`]
            : []),
        ];

  return lines.length ? ["", ...lines] : [];
};

// oxlint-disable-next-line eslint/complexity -- walkthrough branches per delivered state, glance visuals, and criterion counts.
export const renderWalkthrough = (view: WalkthroughView, fromDir = ".") => {
  const { statuses } = view;
  const criteria = statuses.filter((row) => row.criterion !== "contract");
  const { verified, manual, waived, missing } = criterionStatusCounts(criteria);
  const satisfied = verified + manual + waived;
  const added = view.changes.filter((change) => change.action === "NEW").length;

  const modified = view.changes.filter(
    (change) => change.action === "MODIFY"
  ).length;

  const deleted = view.changes.filter(
    (change) => change.action === "DELETE"
  ).length;

  const changeSummary = `${view.changes.length} files (${added} new · ${modified} modified · ${deleted} deleted)`;

  const openReviews = view.reviewRows.filter(
    (row) => row.ruling === null
  ).length;

  const deferredFollowUps =
    view.deferredRulings.length + view.deferredEscalations.length;

  let integration: string;

  if (view.delivered === null) {
    integration = "not delivered";
  } else if (view.delivered.source === null) {
    integration = `${view.delivered.integrated} of ${view.delivered.total} tasks integrated; not delivered`;
  } else {
    integration = `${view.delivered.integrated} of ${view.delivered.total} tasks integrated; uncommitted changes from source ${line(view.delivered.source).slice(0, 12)} in ${line(view.delivered.branch)} working tree; ref ${line(view.delivered.ref)}`;
  }

  const delivered = line(view.glance?.what) || integration;

  const exceptionCount = statuses.filter(
    (row) => row.state !== "verified"
  ).length;

  const href = (artifact: string) =>
    path
      .relative(fromDir, path.resolve(view.repositoryRoot ?? fromDir, artifact))
      .replaceAll("\\", "/");

  const planHref = href(view.planPath);

  const replacement =
    view.focus?.visual !== undefined && view.focus.visual.trim() !== ""
      ? view.focus.visual
      : "";

  let plannedVisual: string;

  if (view.glance?.visuals !== undefined && view.glance?.visuals !== "") {
    plannedVisual = `See [plan visuals](${planHref}#at-a-glance).`;
  } else if (
    view.visuals !== undefined &&
    view.visuals !== "" &&
    view.designPath !== undefined &&
    view.designPath !== ""
  ) {
    plannedVisual = `See [design visuals](${href(view.designPath)}#at-a-glance).`;
  } else {
    plannedVisual = "None.";
  }

  const out = [
    `# ${line(view.title)}`,
    "",
    "## At a Glance",
    "",
    `- **What:** ${delivered}`,
    `- **Artifacts:** [spec](${href(view.specPath)}) · [plan](${planHref})${view.designPath !== undefined && view.designPath !== "" ? ` · [design](${href(view.designPath)})` : ""}`,
    `- **Summary:** ${satisfied}/${criteria.length} criteria satisfied · ${view.changes.length} files changed · ${openReviews} open findings · ${deferredFollowUps} deferred follow-ups`,
    "",
    "<details>",
    "<summary>Detailed counts</summary>",
    "",
    `- **Counts:** ${satisfied}/${criteria.length} criteria (verified ${verified} · manual ${manual} · waived ${waived} · missing ${missing}); ${changeSummary}; ${view.edits.length} recorded edits; ${view.unplannedPaths.length} unplanned paths; ${view.openEscalations.length} open escalations; ${view.deferredRulings.length} deferred rulings; ${view.deferredEscalations.length} deferred escalations; ${view.reviewRows.length} findings (${openReviews} open)`,
    "",
    "</details>",
    "",
    "## Visuals",
    "",
    ...(replacement ? markdownLines(replacement) : [plannedVisual]),
    "",
    "## Review Focus",
    "",
    ...reviewFocus(view),
    "",
    "## Behaviour Changes",
    "",
  ];

  const tasks = view.tasks ?? [];

  const actionLabel: Record<
    WalkthroughView["changes"][number]["action"],
    string
  > = {
    NEW: "created",
    MODIFY: "modified",
    DELETE: "deleted",
  };

  const changeLine = (change: WalkthroughView["changes"][number]) =>
    `- ${code(change.path)} · ${actionLabel[change.action]}`;

  if (!tasks.length && !view.changes.length) {
    out.push("None.", "");
  }

  for (const task of tasks) {
    out.push(`### ${line(task.id)} — ${line(task.title)}`, "");

    const fragment = `${line(task.id)} — ${line(task.title)}`
      .toLowerCase()
      .replaceAll(/[^\p{L}\p{N} _-]/gu, "")
      .replaceAll(" ", "-");

    out.push(
      `- ${line(task.outcome)} ([plan task](${planHref}#${fragment}))`,
      "",
      "<details>",
      ""
    );

    const taskChanges = view.changes.filter((change) =>
      change.owners.some((owner) => owner.id === task.id)
    );

    out.push(
      ...(taskChanges.length ? taskChanges.map(changeLine) : ["None."]),
      "",
      "</details>",
      ""
    );
  }

  const taskIds = new Set(tasks.map((task) => task.id));

  const unplannedChanges = view.changes.filter(
    (change) => !change.owners.some((owner) => taskIds.has(owner.id))
  );

  if (unplannedChanges.length) {
    out.push(
      "### Unplanned changes",
      "",
      "- No planned task owns these changed paths.",
      "",
      "<details>",
      "",
      ...unplannedChanges.map(changeLine),
      "",
      "</details>",
      ""
    );
  }

  out.push(
    "## Verification",
    "",
    `- **Status:** ${exceptionCount ? "exceptions recorded" : "complete"}`
  );

  if (view.testCleanup) {
    const cleanup = view.testCleanup;

    const removed = cleanup.removed.length
      ? cleanup.removed
          .map(
            (id) =>
              `${line(id)} at ${line(cleanup.trees[id] ?? "").slice(0, 12)}`
          )
          .join(", ")
      : "none";

    out.push(
      `- **Test cleanup:** deleted ${cleanup.deleted} · merged ${cleanup.merged} tests; criteria with tests removed: ${removed}`
    );
  }

  out.push(
    "",
    ...exceptionSection(statuses, "manual"),
    ...exceptionSection(statuses, "waived"),
    ...exceptionSection(statuses, "missing"),
    "## Runtime Proof",
    ""
  );

  if (view.runtimeProof) {
    const proof = view.runtimeProof;
    out.push(
      `- **Outcome:** ${line(proof.outcome)}`,
      `- **HEAD:** ${code(proof.head)}${proof.dirty === true ? " plus uncommitted changes" : ""}`,
      `- **Reason:** ${line(proof.reason)}`
    );

    for (const link of [proof.report, ...(proof.artifacts ?? [])]) {
      if (link !== undefined && link !== "") {
        out.push(`- [${line(link)}](${link})`);
      }
    }

    for (const fix of proof.fixes) {
      out.push(
        `- Fix ${code(fix.commit)}: ${line(fix.reason)}${fix.beforeLatest ? " (before latest re-check; see report)" : ""}`
      );
    }

    out.push("");
  } else {
    out.push("Not recorded.", "");
  }

  const deviations = view.edits.map(
    (edit) =>
      `- Deviation: ${line(edit.artifact)} edit (${line(edit.class)}) seq ${edit.seq}: ${line(edit.rationale)}; diff ${line(edit.diffRef)}; affects ${edit.affects.length ? edit.affects.map(line).join(", ") : "none"}`
  );

  deviations.push(
    ...view.unplannedPaths.map(
      (unplanned) => `- Deviation: unplanned change ${line(unplanned)}`
    ),
    ...(view.reviewFixes ?? []).map(
      (fix) =>
        `- Deviation: review fix ${reviewFixFindings(fix)}: ${fix.status}; commit ${line(fix.commit).slice(0, 12)}; paths ${fix.paths.length ? fix.paths.map(line).join(", ") : "none"}`
    )
  );

  const followUps = [
    ...view.openEscalations.map(
      (item) =>
        `- Follow-up: escalation ${line(item.id)}: ${line(item.summary)}`
    ),
    ...view.deferredRulings.map(
      (item) =>
        `- Follow-up: deferred ${line(item.review)}:${line(item.finding)}`
    ),
    ...view.deferredEscalations.map(
      (item) =>
        `- Follow-up: deferred escalation ${line(item.id)}: ${line(item.summary)}`
    ),
  ];

  let integrationRecord: string;

  if (view.delivered === null) {
    integrationRecord = "not delivered";
  } else if (view.delivered.source === null) {
    integrationRecord = `${view.delivered.integrated} of ${view.delivered.total} tasks integrated; not delivered`;
  } else {
    integrationRecord = `source ${line(view.delivered.source)} · branch ${line(view.delivered.branch)} · ref ${line(view.delivered.ref)}`;
  }

  out.push("## Deviations & Follow-ups", "");

  if (followUps.length) {
    out.push(...followUps, "");
  }

  if (deviations.length) {
    out.push(
      "<details>",
      `<summary>Deviations (${deviations.length})</summary>`,
      "",
      ...deviations,
      "",
      "</details>",
      ""
    );
  }

  if (!deviations.length && !followUps.length) {
    out.push("None.", "");
  }

  const findingCount = view.reviewRows.length;

  const findings = renderFindingsSection(
    view.reviewRows,
    view.reviewRounds,
    fromDir
  );

  out.push(
    RESOLUTION_HEADING,
    "",
    `${findingCount} findings across ${view.reviewRounds.length} rounds (${openReviews} open)`,
    ...coverageLines(view.coverage),
    ""
  );

  if (findingCount) {
    out.push(
      "<details>",
      `<summary>Findings table (${findingCount})</summary>`,
      "",
      findings,
      "",
      "</details>",
      ""
    );
  } else {
    out.push(findings, "");
  }

  out.push(
    "## Appendix",
    "",
    "<details>",
    "",
    "<summary>Audit records</summary>",
    "",
    "### Provenance",
    "",
    `- Spec: [${line(view.specPath)}](${href(view.specPath)}) · ${hashPrefix(view.specHash)}`,
    `- Plan: [${line(view.planPath)}](${planHref}) · ${hashPrefix(view.planHash)}`,
    ...(view.designPath !== undefined && view.designPath !== ""
      ? [
          `- Design: [${line(view.designPath)}](${href(view.designPath)}) · ${hashPrefix(view.designHash)}`,
        ]
      : []),
    `- Integration: ${integrationRecord}`,
    "",
    "### Verified Evidence",
    "",
    ...statusTable(statuses, "verified"),
    "",
    "### User-Attributed Records",
    ""
  );

  if (view.userRecords.length) {
    out.push(
      "| Seq | Kind | Record | User quote |",
      "| --- | --- | --- | --- |"
    );

    for (const record of view.userRecords) {
      out.push(
        `| ${record.seq} | ${cell(record.kind)} | ${cell(record.summary)} | ${cell(record.quote)} |`
      );
    }

    out.push("");
  } else {
    out.push("None.", "");
  }

  out.push("</details>");

  return `${out.join("\n").replace(/\s+$/u, "")}\n`;
};
