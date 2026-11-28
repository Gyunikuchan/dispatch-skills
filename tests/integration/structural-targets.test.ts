import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { qualityCriteria } from "../../skills/dispatch/scripts/toolkit/domain/prompt.ts";
import type { QualityConsumer } from "../../skills/dispatch/scripts/toolkit/domain/prompt.ts";
import type { ReviewKind } from "../../skills/dispatch/scripts/toolkit/domain/types.ts";
import { reviewPrompt } from "../../skills/dispatch/scripts/toolkit/prompts.ts";
import {
  KINDS,
  validateRecord,
} from "../../skills/dispatch/scripts/toolkit/records.ts";
import { defined } from "../helpers/guards.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("toolkit stays within the structural size budgets", () => {
  const files = fs
    .readdirSync(path.join(root, "skills/dispatch/scripts"), {
      recursive: true,
    })
    .map(String)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));

  const lines = files.reduce(
    (total, file) =>
      total +
      fs
        .readFileSync(path.join(root, "skills/dispatch/scripts", file), "utf-8")
        .split("\n").length -
      1,
    0
  );

  // NOTE: 21960 covers bounded Copilot receipts, exact qualified models, physical effort, actor/billing reporting, and saved native projection/terminal state.
  // NOTE: 22399 also covers durable status, cleanup, and opt-in review recovery correlation, including saved CLI replies in native consume.
  // Oxfmt added 12254 lines to the baseline. Keep the original 16 lines of headroom.
  // The lint style migration added 3865 lines. Keep the same headroom.
  // The shared Node error-code guard and its imports add 18 net lines after consolidation.
  // Runtime guards for stored records and diagnostics add 8 net lines.
  // Verdict, roster, and slot guards for persisted delivery review evidence add 100 net lines.
  // Ledger binding and saved correction guards add 3 net lines.
  // Remaining Oxc type-safety compliance across production scripts adds 932 lines.
  // NOTE: Pre-wave HEAD (6c556ca1) measured 39583 against the 39600 budget (17 headroom; no pre-existing overage).
  // NOTE: The oxlint/oxfmt compliance wave (ac7c9cfc) adds 19649 net lines (formatter churn plus expanded guards and disables), reaching 59232.
  // NOTE: The review.ts -> review-round.ts split overhead sits inside that total. Budget 59248 keeps 16 lines of headroom.
  // NOTE: 59248 was measured after that wave's no-comments autofix stripped rationale comments; restoring them adds 1067 lines over the 59232 measure (60299). Budget 60315 keeps 16 lines of headroom.
  // NOTE: db995365 adds case-insensitive ComSpec resolution and the batch-launcher % path guard (code-scanning #25/#35), reaching 60326. Budget 60342 keeps 16 lines of headroom.
  // NOTE: The `worktree land` combined handler adds 230 lines (the combined handler, step plumbing in the CLI and output, and the hint branch), reaching 60556. Budget 60572 keeps 16 lines of headroom.
  // NOTE: The `lint run --fix-review-lite` and `review run --note` combined handlers add 230 lines (the brief chain, the note append and its step plumbing), reaching 60786. Budget 60802 keeps 16 lines of headroom.
  // NOTE: Code-review fixes to those handlers (note retry dedupe and artifact binding, stepped faults, receipt-first summaries, pins validated before the note append) add 24 lines over 60786, reaching 60810. Budget 60826 keeps 16 lines of headroom.
  // NOTE: Round cause (the `cause` type, pure `roundCause` and its call after the missing-RED append) adds 99 lines over 60810, reaching 60909. Budget 60925 keeps 16 lines of headroom.
  // NOTE: Rounds past cap (the `cause` fact, per-round `cap` in round timing, their allow-list gates and the `Rounds past cap` health bullet) add 56 lines over 60909, reaching 60965. Budget 60981 keeps 16 lines of headroom.
  // NOTE: Resume phase reasons (`RESUME_ROUTES`, `taskPhaseReason`, `keptAutomatedChecks`, pre-integration/terminal/check routing) and the shared section helper (`deriveStatusSections`, `inspectStoredPath`) add 474 lines over 60965, reaching 61439. Budget 61455 keeps 16 lines of headroom.
  // NOTE: Verified bug fixes add 552 net lines over 61439, reaching 61991: integrate conflict keys, lint review-lite target resolution, review-fix exclusivity and file hint, agy map launch hint, empty-output resume cap with the (provider, model) breaker and reprobe reset, closed-review escalation filter, recovery wave outcome emit, diagnostics aliasing and reserve attribution, and H11 thresholds. The lint-driven round timing helper extraction is included. Budget 62007 keeps 16 lines of headroom.
  // NOTE: The `review run` stale-findings preflight (`lacksProposedFix`, `refuseStaleFindings` and the target resolution that now precedes the note append) adds 26 net lines over 62004, reaching 62030. Budget 62046 keeps 16 lines of headroom.
  // NOTE: The `ruling` fix choice (`fix` field, its append-only validation and the pre-filled template field) adds 23 net lines over 62030, reaching 62053. Budget 62069 keeps 16 lines of headroom.
  // NOTE: The step-back marker (`stepBackMark`, the `step-back due` summary clause, the outcome skeleton, the `step-back:` ruling validation and the `ledger append` refusal) adds 175 net lines over 62053, reaching 62228. Budget 62244 keeps 16 lines of headroom.
  // NOTE: The diagnostics review choices (`reviewChoiceFacts`, its allow-list gate and type, the `reviewLabel` helper and the `Fix choices` and `Step-backs` health bullets) add 154 net lines over 62228, reaching 62382. Budget 62398 keeps 16 lines of headroom.
  const driverLocBudget = 62_398;
  assert.ok(
    lines <= driverLocBudget,
    `driver TS LOC ${lines} exceeds ${driverLocBudget} budget. Cut or consolidate first without squashing or stripping comments; a genuine new behaviour or rule may raise the budget with the reason recorded beside it and reported in the handoff; duplicates never justify a raise.`
  );
  assert.ok(
    KINDS.length <= 14,
    `ledger kinds ${KINDS.length} exceeds 14 budget. Cut or consolidate first without squashing or stripping comments; a genuine new behaviour or rule may raise the budget with the reason recorded beside it and reported in the handoff; duplicates never justify a raise.`
  );
  const bytes = fs.statSync(path.join(root, "skills/dispatch/SKILL.md")).size;
  // NOTE: 10100 covers the subagent role table, shared native subagent rules, research explorer inline limits, delegation thresholds, and retained explorer follow-up rules.
  assert.ok(
    bytes <= 10_100,
    `SKILL.md bytes ${bytes} exceeds 10100 budget. Move branch-specific detail to references first; a genuine rule that every branch needs may raise the budget with the reason recorded beside it and reported in the handoff, per AGENTS.md Documentation Standards; duplicates never justify a raise.`
  );
});

const readModule = (file: string) =>
  fs.readFileSync(
    path.join(root, "skills/dispatch/scripts/toolkit", file),
    "utf-8"
  );

const lineCount = (source: string) =>
  source.split("\n").length - Number(source.endsWith("\n"));

test("toolkit split modules own declarations behind bounded entry files", () => {
  const declaration =
    /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|type|interface|class|enum)\s+\w+/mu;

  for (const file of [
    "domain/diagnostics-types.ts",
    "domain/diagnostics-gates.ts",
    "domain/diagnostics-heuristics.ts",
    "domain/diagnostics-render.ts",
    "domain/plan-lint.ts",
    "domain/plan-parse.ts",
    "domain/plan-graph.ts",
    "review-capture.ts",
    "review-notices.ts",
  ]) {
    assert.match(
      readModule(file),
      declaration,
      `${file} owns an implementation or declaration`
    );
  }

  // These entry files expose named re-exports from their siblings.
  const reExports =
    /^\s*(?:export\s+(?:type\s+)?\{[^{}]+\}\s+from\s+['"]\.\/[^/'"]+\.ts['"];\s*)+$/u;

  for (const file of ["domain/plan.ts", "domain/diagnostics.ts"]) {
    const source = readModule(file);
    assert.ok(lineCount(source) <= 60, `${file} exceeds 60 lines`);
    assert.match(
      source.replaceAll(/^\s*\/\/[^\r\n]*/gmu, ""),
      reExports,
      `${file} contains only sibling re-exports`
    );
  }

  const review = readModule("review.ts");
  // NOTE: The ordered lifecycle includes argument capture and optional recovery observation at fan-out.
  // Oxfmt added 577 lines to the baseline. Keep the original 17 lines of headroom.
  // The lint style migration added 114 lines. Keep the same headroom.
  assert.ok(lineCount(review) <= 1295, "review.ts exceeds 1295 lines");

  const reviewOwners = {
    "review-capture.ts": ["writeSpecSnapshot", "writeReviewerInput"],
    "review-notices.ts": [
      "blockedEntries",
      "blockersFor",
      "blockedNotice",
      "hotUnitsNotice",
    ],
    "review-checkout.ts": [
      "comparedDirs",
      "baselineFileFor",
      "writeCheckoutReport",
      "writeBaselineIfMissing",
      "compareForRound",
    ],
    "review-round.ts": ["runReviewRound"],
  };

  for (const [file, names] of Object.entries(reviewOwners)) {
    const owner = readModule(file);

    for (const name of names) {
      const declares = new RegExp(
        `^[ \\t]*(?:export\\s+)?(?:async\\s+)?(?:function|const|let|var)\\s+${name}\\b`,
        "mu"
      );

      assert.match(owner, declares, `${file} declares ${name}`);
      assert.doesNotMatch(
        review,
        declares,
        `review.ts delegates ${name} to ${file}`
      );
    }
  }
});

const STEP_BUDGET = 37_067;
const PLAN_AUTHORING_BUDGET = 36_914;

const GUIDES = [
  "ask",
  "design",
  "plan",
  "implement",
  "review",
  "verify",
] as const;

const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");

// Byte size of a whole reference file, or of the section under an anchor heading.
const sectionBytes = (file: string, anchor: string | null) => {
  const text = fs.readFileSync(
    path.join(root, "skills/dispatch", file),
    "utf-8"
  );

  if (anchor === undefined || anchor === null || anchor === "") {
    return Buffer.byteLength(text);
  }

  const lines = text.split("\n");

  const start = lines.findIndex((line) => {
    const match = /^(?<g1>#{2,4})\s+(?<g2>.*?)\s*$/u.exec(line);

    return match !== null && slug(defined(match[2])) === anchor;
  });

  assert.ok(start !== -1, `${file}#${anchor} resolves to a heading`);

  const level = defined(
    defined(/^(?<g1>#{2,4})/u.exec(defined(lines[start])))[1]
  ).length;

  let end = lines.length;

  for (let index = start + 1; index < lines.length; index += 1) {
    const match = /^(?<g1>#{2,4})\s+/u.exec(defined(lines[index]));

    if (match && defined(match[1]).length <= level) {
      end = index;
      break;
    }
  }

  return Buffer.byteLength(lines.slice(start, end).join("\n"));
};

test("verb steps stay within the per-step byte budgets", () => {
  const skillBytes = fs.statSync(
    path.join(root, "skills/dispatch/SKILL.md")
  ).size;

  for (const guide of GUIDES) {
    const rel = `references/verbs/${guide}.md`;

    const text = fs.readFileSync(
      path.join(root, "skills/dispatch", rel),
      "utf-8"
    );

    const stepTable = text.split(/^## Step reads\s*$/mu)[1]?.split(/^## /mu)[0];
    assert.ok(
      stepTable !== undefined && stepTable !== null && stepTable !== "",
      `${rel} states its step table`
    );

    const rows = stepTable
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("| ") &&
          !line.startsWith("| Step") &&
          !line.startsWith("| ---")
      );

    assert.ok(rows.length > 0, `${rel} has step rows`);

    const guideBytes = fs.statSync(
      path.join(root, "skills/dispatch", rel)
    ).size;

    for (const row of rows) {
      const cells = row
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean);

      const links = [
        ...defined(cells[1]).matchAll(/\[(?<g1>[^\]]+)\]\((?<g2>[^)]+)\)/gu),
      ];

      assert.equal(
        links.length,
        1,
        `${guide} step links exactly one file: ${row}`
      );
      const target = defined(defined(links[0])[2]);
      assert.ok(
        !/^(?<g1>https?:|mailto:|<)/u.test(target),
        `${guide} step links a relative path: ${target}`
      );
      const [ref, anchor] = target.split("#");

      const file = path.posix.normalize(
        path.posix.join("references/verbs", defined(ref))
      );

      const total =
        sectionBytes(file, anchor ?? null) + skillBytes + guideBytes;

      assert.ok(
        total <= STEP_BUDGET,
        `${guide} step reads ${total} bytes exceed ${STEP_BUDGET}: ${row.trim()}`
      );

      if (guide === "plan") {
        assert.ok(
          total <= PLAN_AUTHORING_BUDGET,
          `plan authoring step reads ${total} bytes exceed ${PLAN_AUTHORING_BUDGET}: ${row.trim()}`
        );
      }
    }
  }
});

test("rendered packs stay within the per-actor byte budgets", () => {
  const skillRoot = path.join(root, "skills/dispatch");

  const templateBytes = (name: string) =>
    fs.statSync(path.join(skillRoot, "references/templates", name)).size;

  const bar = fs.readFileSync(
    path.join(skillRoot, "references/templates/quality-bar.md"),
    "utf-8"
  );

  const specStage = fs.readFileSync(
    path.join(skillRoot, "references/spec-stage.md"),
    "utf-8"
  );

  const qualityBytes = (consumer: QualityConsumer) =>
    Buffer.byteLength(qualityCriteria(bar, consumer, 0, specStage));

  const promptBytes = (kind: ReviewKind) =>
    Buffer.byteLength(
      reviewPrompt(kind, {
        skillRoot,
        spec: { path: "s", hash: "h" },
        artifact: "a",
        planPath: "None",
        taskSummary: "t",
        scope: "s",
        turnTarget: 1,
        round: 1,
      })
    );

  // NOTE: Pack budgets enforce totals and current component limits.
  // NOTE: The plan ceiling rose 17260 -> 17527 B for the quality-bar `Pins:` bullet (+267 B); `## plan` renders into neither the code prompt nor the writer pack.
  // NOTE: Code (16067) and plan (17260) ceilings reflect quality-bar.md compression (-299 B net in shared after restoring "partial failures and updates", +12 B), naming/comments and safe-DRY rules (+1174 B in code), and Shape/Prune updates (+280 B net in testing after restoring "for coverage", +24 B).
  assert.ok(
    promptBytes("code") <= 16_067,
    `code reviewer prompt exceeds 16067 budget`
  );
  assert.ok(
    promptBytes("plan") <= 17_527,
    `plan reviewer prompt exceeds 17527 budget`
  );
  // NOTE: 12734 covers the design altitude, severity, and advisory grounding-lead rules after consolidation.
  // NOTE: 12745 covers the design altitude, severity, and advisory grounding-lead rules after consolidation,
  // plus the quality-bar "requiring" restoration (+10 B over the formatter baseline).
  assert.ok(
    promptBytes("design") <= 12_745,
    `design reviewer prompt exceeds 12745 budget`
  );
  const writer = templateBytes("writer-brief.md") + qualityBytes("writer");
  // NOTE: 11757 reflects writer-brief.md compression + post-GREEN self-clean (3048 -> 3138 B, +90 B) and quality-bar updates (-299 B net shared after "partial failures and updates" restoration, +1174 B code, +256 B net testing excluding Prune).
  assert.ok(
    writer <= 11_757,
    `writer brief pack ${writer} exceeds 11757 budget`
  );
  const explorerBrief = templateBytes("explorer-brief.md");
  // NOTE: 7977 covers the explorer brief's split threshold, coherence, validation, reading, and output requirements.
  assert.ok(
    explorerBrief <= 7977,
    `explorer brief template ${explorerBrief} exceeds 7977 budget`
  );

  const explorer =
    explorerBrief + templateBytes("context-map.md") + qualityBytes("explorer");

  assert.ok(
    explorer <= 12_638,
    `explorer pack ${explorer} exceeds 12638 budget`
  );
  const cleanupQuality = qualityBytes("cleanup");
  // NOTE: 7964 (+3 B over 7961) reflects shared compression (-299 B net after "partial failures and updates" restoration) and Shape/Prune updates (+280 B net after "for coverage" restoration in Prune).
  assert.ok(
    cleanupQuality <= 7964,
    `test-cleanup rendered quality ${cleanupQuality} exceeds 7964 budget`
  );
  const verifierBrief = templateBytes("verifier-brief.md");
  assert.ok(verifierBrief <= 4096, "verifier brief exceeds 4096 bytes");
  // NOTE: 6765 and 10047 reflect shared compression (-299 B net after "partial failures and updates" restoration) offset by Shape test-design/amortization additions (+313 B in verifier's shared + testing subset without Prune or Writer focus).
  const verifierQuality = qualityBytes("verifier");
  assert.ok(
    verifierQuality <= 6765,
    `verifier rendered quality ${verifierQuality} exceeds 6765 budget`
  );
  const verifier = verifierBrief + verifierQuality;
  assert.ok(
    verifier <= 10_047,
    `verifier pack ${verifier} exceeds 10047 budget`
  );
  const cleanupBrief = templateBytes("test-cleanup-brief.md");
  // NOTE: 2426 and 10390 reflect test-cleanup-brief.md compression (2711 -> 2426 B, -285 B; net +183 B over 2243 B baseline) with cited-proof, keep-on-doubt, no-production-mutation, defect-concern, and Prune-aligned rules paired with cleanup quality (7964 B).
  assert.ok(
    cleanupBrief <= 2426,
    `test-cleanup brief template ${cleanupBrief} exceeds 2426 budget`
  );
  const cleanup = cleanupBrief + cleanupQuality;
  assert.ok(
    cleanup <= 10_390,
    `test-cleanup pack ${cleanup} exceeds 10390 budget`
  );
  // NOTE: The hand-filled brief needs its own budget for the child authority and reply contract.
  const incrementBrief = templateBytes("increment-orchestrator-brief.md");
  assert.ok(
    incrementBrief <= 4096,
    `increment orchestrator brief ${incrementBrief} exceeds 4096 bytes`
  );
});

type FieldValue =
  | string
  | number
  | boolean
  | FieldValue[]
  | { [field: string]: FieldValue };

interface Fields {
  [field: string]: FieldValue;
}

test("ledger authority is limited to approval, exceptions and user-selected levels", () => {
  const hash = `sha256:${"a".repeat(64)}`;
  const commit = "b".repeat(40);

  const dest = { branch: "main", path: "/repo" };

  const data = new Map<string, Fields[]>(
    Object.entries({
      bind: [{ spec: "spec.md", plan: "plan.md", design: "design.md" }],
      approval: [{ spec: hash, plan: hash, design: hash }],
      confirm: [{ spec: hash }],
      level: ["low", "medium", "high", "xhigh", "max"].map((level) => ({
        level,
      })),
      waiver: [{ criterion: "SC1", reason: "User accepted the limit" }],
      "manual-complete": [
        { criterion: "SC1", evidence: "User observed the result" },
      ],
      escalation: [
        { id: "decision", state: "open", summary: "Need an intent decision" },
      ],
      ruling: [
        {
          subject: "review:finding",
          ruling: "accepted",
          fix: "proposed",
          rationale: "Verified defect",
        },
      ],
      note: [{ text: "Resume from status" }],
      edit: [
        {
          artifact: "plan",
          before: hash,
          after: hash,
          class: "non-intent",
          affects: [],
          rationale: "Clarify command",
          diffRef: "diff.md",
        },
      ],
      evidence: [
        {
          criterion: "SC1",
          commandDigest: hash,
          tree: commit,
          clean: true,
          before: commit,
          after: commit,
          exit: 0,
          path: "result.json",
        },
      ],
      writer: [
        {
          phase: "launched",
          task: "task",
          path: "/writer",
          base: { commit, taskSection: hash, seq: 0 },
        },
        { phase: "finished", task: "task", launch: 1, candidate: commit },
        { phase: "abandoned", task: "task", launch: 1, reason: "Retry" },
      ],
      integrate: [
        {
          phase: "opened",
          path: "/integration",
          branch: "session",
          base: commit,
          dest,
        },
        {
          phase: "verification",
          cycle: 1,
          outcome: "no-op",
          head: commit,
          reason: "Nothing runnable",
          open: [],
        },
        { phase: "started", task: "task", candidate: commit },
        { phase: "conflict", task: "task", paths: ["source.ts"] },
        { phase: "done", task: "task", commit },
        {
          phase: "abandoned",
          task: "task",
          candidate: commit,
          reason: "Retry",
        },
        { phase: "fix", commit, reason: "Review repair" },
        {
          phase: "test-cleanup",
          from: commit,
          fromTree: commit,
          to: commit,
          removed: ["SC1"],
          deleted: 1,
          merged: 0,
          trees: { SC1: commit },
        },
        {
          phase: "deliver-started",
          mode: "uncommitted",
          dest,
          from: commit,
          source: commit,
        },
        {
          phase: "delivered",
          mode: "uncommitted",
          dest,
          from: commit,
          source: commit,
        },
        { phase: "closed", reason: "Session complete" },
      ],
      focus: [
        {
          bullets: [
            { text: "Review the completion gate", evidence: "src/report.ts" },
          ],
        },
      ],
    })
  );

  assert.deepEqual([...data.keys()].toSorted(), [...KINDS].toSorted());

  for (const kind of KINDS) {
    for (const value of defined(data.get(kind))) {
      const record = {
        kind,
        // eslint-disable-next-line typescript/no-base-to-string -- fixture value is a validated string at runtime.
        key: `${kind}:${String(value["phase"] ?? value["level"] ?? "record")}`,
        data: value,
      };

      const userOnly =
        ["approval", "confirm", "waiver", "manual-complete"].includes(kind) ||
        // eslint-disable-next-line typescript/no-base-to-string -- fixture value is a validated string at runtime.
        (kind === "level" && ["xhigh", "max"].includes(String(value["level"])));

      const label = record.key;
      assert.doesNotThrow(
        () =>
          validateRecord({
            ...record,
            by: "user",
            quote: "I approve this action.",
          }),
        label
      );

      if (userOnly) {
        for (const by of ["orchestrator", "tool"]) {
          assert.throws(
            () =>
              validateRecord({
                ...record,
                by,
                quote: "I approve this action.",
              }),
            { reason: "user-only" },
            `${label} rejects ${by}`
          );
        }

        for (const quote of [undefined, "", "   "]) {
          assert.throws(
            () =>
              validateRecord({
                ...record,
                by: "user",
                ...(!(quote === undefined) && { quote }),
              }),
            { reason: "user-only" },
            `${label} requires a user quote`
          );
        }
      } else {
        assert.doesNotThrow(
          () => validateRecord({ ...record, by: "orchestrator" }),
          label
        );
      }
    }
  }
});

// Split dense prose first; raise this cap only with the reason beside it.
test("reference prose lines stay within the line byte cap", () => {
  const skill = path.join(root, "skills/dispatch");

  const files = [
    "SKILL.md",
    ...fs
      .readdirSync(path.join(skill, "references"), { recursive: true })
      .map(String)
      .map((file) => `references/${file.replaceAll("\\", "/")}`)
      .filter(
        (file) =>
          file.endsWith(".md") &&
          !file.startsWith("references/readme/") &&
          file !== "references/templates/quality-bar.md"
      ),
  ];

  for (const file of files) {
    let fence: string | null = null;

    for (const [index, line] of fs
      .readFileSync(path.join(skill, file), "utf-8")
      .split(/\r?\n/u)
      .entries()) {
      const marker = /^\s*(?<g1>`{3,}|~{3,})/u.exec(line)?.[1];

      if (marker !== undefined && marker !== null && marker !== "") {
        if (fence === undefined || fence === null || fence === "") {
          fence = defined(marker[0]);
        } else if (marker.startsWith(fence)) {
          fence = null;
        }

        continue;
      }

      if (
        (fence !== undefined && fence !== null && fence !== "") ||
        /^\s*\|/u.test(line)
      ) {
        continue;
      }

      const bytes = Buffer.byteLength(line);
      assert.ok(
        bytes <= 1200,
        `${file}:${index + 1} is ${bytes} bytes; split first, else raise the cap with the reason beside it`
      );
    }
  }
});
