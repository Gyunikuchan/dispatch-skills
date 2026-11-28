import fs from "node:fs";
import path from "node:path";

import type { RejectionRequest } from "./confirmations.ts";
import {
  EXECUTION_STATUS_TITLE,
  RESOLUTION_TITLE,
} from "./domain/document-lint.ts";
import { structuralLines } from "./domain/markdown-structure.ts";
import {
  assembleTemplate,
  extractTemplate,
  fillTemplate,
  interRoundSection,
  qualityBar,
  settledSection,
} from "./domain/prompt.ts";
import type {
  InterRound,
  SettledEntry,
  UserDecision,
} from "./domain/prompt.ts";
import { REVIEW_TAGS_BY_KIND } from "./domain/report.ts";
import type { ReviewKind } from "./domain/types.ts";
import { present } from "./narrow.ts";
import type { ReviewTarget } from "./review-state.ts";

export { settledSection, type Settled } from "./domain/prompt.ts";

const managedSections = new Set([RESOLUTION_TITLE, EXECUTION_STATUS_TITLE]);

interface PromptValues {
  [placeholder: string]: string;
}

const sections = (source: string, subsections: boolean) => {
  const byHeading = new Map<string, string>();

  let heading = "";
  let body: string[] = [];
  let ignored = false;

  const save = () => {
    if (heading) {
      byHeading.set(heading, body.join("\n").trim());
    }
  };

  for (const line of structuralLines(source)) {
    const match = line.fenced
      ? null
      : /^(?<cap1>#{2,3})\s+(?<cap2>.+?)\s*$/u.exec(line.text);

    if (subsections && match?.[1] === "##") {
      ignored = managedSections.has(present(match[2], "the heading text"));
    }

    if (match && (subsections || match[1] === "##")) {
      save();
      heading = ignored ? "" : present(match[2], "the heading text");
      body = [];
    } else if (!ignored) {
      body.push(line.original);
    }
  }

  save();

  return byHeading;
};

export const artifactSections = (source: string) => sections(source, false);

export const changedHeadings = (before: string, after: string) => {
  const previous = sections(before, true);
  const current = sections(after, true);

  return [...new Set([...current.keys(), ...previous.keys()])].filter(
    (heading) =>
      !managedSections.has(heading) &&
      previous.get(heading) !== current.get(heading)
  );
};

export const reviewPrompt = (
  kind: ReviewKind,
  context: {
    skillRoot: string;
    spec: { path: string; hash: string };
    artifact: string;
    planPath?: string;
    taskSummary?: string;
    scope: string;
    turnTarget: number;
    contextMapPath?: string;
    settled?: readonly SettledEntry[];
    interRound?: InterRound;
    requests?: readonly RejectionRequest[];
    rotation?: number;
    round: number;
  }
) => {
  const directory = path.join(context.skillRoot, "references/templates");

  const read = (name: string) =>
    fs.readFileSync(path.join(directory, name), "utf-8");

  const kindBlock = read(`review-prompt-${kind}.md`);
  const frameMarkdown = read("review-prompt.md");

  const specStage = fs.readFileSync(
    path.join(context.skillRoot, "references/spec-stage.md"),
    "utf-8"
  );

  const settled = settledSection(
    context.settled ?? [],
    false,
    new Set(context.interRound?.accepted.map((entry) => entry.id))
  );

  const isRereview = context.round > 1 || settled.length > 0;

  const rereviewBody = isRereview
    ? extractTemplate(frameMarkdown, "Re-review template").template
    : "";

  const preregisterBody =
    kind !== "code" && !isRereview
      ? extractTemplate(frameMarkdown, "Pre-registration template").template
      : "";

  const template = assembleTemplate(frameMarkdown, kindBlock, undefined, [
    qualityBar(read("quality-bar.md"), kind, context.rotation ?? 0, specStage),
    read("review-severity.md"),
    `## rereview\n\n${rereviewBody}`,
    `## preregister\n\n${preregisterBody}`,
  ]);

  const renderedTags = new Set([
    ...[...template.template.matchAll(/^- \*\*(?<cap1>[^*]+)\*\* —/gmu)].map(
      (match) => present(match[1], "the review tag")
    ),
    "standards",
    "adjacent",
  ]);

  if (
    renderedTags.size !== REVIEW_TAGS_BY_KIND[kind].size ||
    [...renderedTags].some((tag) => !REVIEW_TAGS_BY_KIND[kind].has(tag))
  ) {
    throw new Error(
      `Review tags for ${kind} differ from rendered families: ${[...renderedTags].join(", ")}`
    );
  }

  // NOTE: the map is a pre-change locator, so code reviews never receive it; a leading newline keeps an absent map from leaving a blank line.
  const contextMap =
    context.contextMapPath !== undefined && context.contextMapPath !== ""
      ? `\n- Context Map: ${context.contextMapPath} — pre-change locator, not a completeness claim: verify claims at source, and run your own consumer and caller search for each contract the artifact changes.`
      : "";

  let kindSection: PromptValues;

  if (kind === "plan") {
    kindSection = { "Plan Path": context.artifact, "Context Map": contextMap };
  } else if (kind === "design") {
    kindSection = {
      "Design Path": context.artifact,
      "Context Map": contextMap,
    };
  } else {
    kindSection = {
      "Plan Path": context.planPath ?? "None",
      "Task Summary": context.taskSummary ?? "Review the selected changes.",
    };
  }

  const values: PromptValues = {
    "Spec Path": context.spec.path,
    "Spec Hash": context.spec.hash,
    "Review Scope": context.scope,
    "User Focus Areas": "General review",
    "Tool Turn Budget": String(context.turnTarget),
    ...kindSection,
  };

  const requests = context.requests ?? [];

  const confirmation = requests.length
    ? `\n\n### Pending MUST rejection confirmation\nReview each original claim and the host evidence. Add \`confirmations\` to the JSON report with exactly \`requestId\`, \`decision\` (\`agree|disagree\`), and a nonblank evidence-backed \`rationale\`: [{"requestId":"<assigned ID>","decision":"agree|disagree","rationale":"<nonblank evidence-based reason>"}]. Answer every assigned request exactly once. Keep ordinary \`status\` and \`findings\`. A pending MUST rejection is open until explicit agreement; omission is not confirmation.\n${requests
        .map(
          (request) =>
            `\nRequest ID: \`${request.requestId}\`\nOriginal finding: ${request.finding} ${request.claim.locus}: ${request.claim.defect}\nProposed fix: ${request.claim.proposedFix}\nHost rejection: ${request.rationale}\n`
        )
        .join("")}`
    : "";

  const interRound = context.interRound
    ? `\n\n${interRoundSection(context.interRound, false)}\n`
    : "";

  return (
    fillTemplate(template.template, template.variables, values) +
    settled +
    interRound +
    confirmation
  );
};

/** A compact round that asks the assigned source slots to confirm or dispute one rejection each. */
export const confirmationPrompt = (
  kind: ReviewKind,
  context: {
    spec: { path: string; hash: string };
    artifact: string;
    target: ReviewTarget;
    cwd?: string;
    planPath?: string;
    taskSummary?: string;
    scope: string;
    interRound?: InterRound;
    requests: readonly RejectionRequest[];
    settled?: readonly UserDecision[];
  }
) => {
  const revision =
    typeof context.target === "string"
      ? context.target
      : `${context.target.base}..${context.target.head}`;

  let kindContext: string[];

  if (kind === "plan") {
    kindContext = [`- Plan: ${context.artifact}`];
  } else if (kind === "design") {
    kindContext = [`- Design: ${context.artifact}`];
  } else {
    kindContext = [
      `- Plan: ${context.planPath ?? "None"}`,
      `- Task: ${context.taskSummary ?? "Review the selected changes."}`,
    ];
  }

  const requests = context.requests.flatMap((request) => [
    `Request ID: \`${request.requestId}\``,
    `- Finding: ${request.finding}`,
    `- Target: ${request.claim.locus}`,
    `- Spec: ${context.spec.path}`,
    `- Original finding: ${request.claim.defect}`,
    `- Proposed fix: ${request.claim.proposedFix}`,
    `- Host rejection: ${request.rationale}`,
    "",
  ]);

  return `${[
    "Confirm or dispute the host's evidence-backed rejection of your earlier MUST finding(s) on this unchanged target.",
    "",
    "### Context",
    `- Spec Path: ${context.spec.path}`,
    `- Spec Hash: ${context.spec.hash}`,
    `- Target: ${context.artifact}`,
    `- Target Revision: ${revision}`,
    ...(context.cwd !== undefined && context.cwd !== ""
      ? [`- Checkout Path: ${context.cwd}`]
      : []),
    ...kindContext,
    `- Scope: ${context.scope}`,
    "",
    ...(context.interRound ? [interRoundSection(context.interRound), ""] : []),
    // NOTE: the compact prompt has no template, so it repeats the re-review template's closing sentence.
    ...(context.settled !== undefined && context.settled.length > 0
      ? [
          settledSection(context.settled).trim(),
          "Listed user decisions are closed; re-raise one only with evidence that was not available when the user decided.",
          "",
        ]
      : []),
    "### Inspection",
    "Inspect read-only: read files and run Git inspection commands in the foreground only. Do not edit or create files, write the ledger, launch subagents, or change the target, the session or the repository. Do not raise new findings; answer only the assigned requests below.",
    "",
    "### Pending MUST rejection confirmation",
    "Review each original claim and the host evidence. Add `confirmations` to the JSON report with exactly `requestId` (the assigned Request ID), `decision` (`agree|disagree`), and a nonblank evidence-backed `rationale`. Answer every assigned request exactly once. A pending MUST rejection is open until explicit agreement; omission is not confirmation. Reply with one JSON object and no other text:",
    '{"status":"CLEAN","findings":[],"confirmations":[{"requestId":"<assigned ID>","decision":"agree|disagree","rationale":"<nonblank evidence-based reason>"}]}',
    "",
    ...requests,
  ]
    .join("\n")
    .trimEnd()}\n`;
};
