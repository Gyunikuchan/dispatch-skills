import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { Manifest } from "../../../skills/dispatch/scripts/lib/session.ts";
import { artifactHash } from "../../../skills/dispatch/scripts/toolkit/artifacts.ts";
import type { Finding } from "../../../skills/dispatch/scripts/toolkit/domain/types.ts";
import {
  appendRecords,
  foldLedger,
} from "../../../skills/dispatch/scripts/toolkit/ledger.ts";
import {
  renderFindingsFile,
  renderFindingsSection,
  reviewRows,
  refreshFindingsSection,
  rulingReview,
  rulingsTemplate,
} from "../../../skills/dispatch/scripts/toolkit/review-findings.ts";
import { defined } from "../../helpers/guards.ts";
import { narrow } from "./helpers/json.ts";
import type { JsonObject } from "./helpers/json.ts";

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-findings-"));

  const session = path.join(
    root,
    ".scratch",
    "dispatch-skills",
    "20261028T0000Z-review-findings"
  );

  const docs = path.join(root, "docs");
  fs.mkdirSync(session, { recursive: true });
  fs.mkdirSync(docs, { recursive: true });

  const manifest: Manifest = {
    schemaVersion: 1,
    folderName: "20261028T0000Z-review-findings",
    sessionId: "review-findings",
    safeSessionId: "review-findings",
    repositoryRoot: root,
    sessionTitle: "Review findings",
    createdAt: "2026-10-28T00:00:00.000Z",
    lastUsedAt: "2026-10-28T00:00:00.000Z",
    location: "workspace",
  };

  return {
    root,
    session,
    docs,
    manifest,
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
};

const addRound = (
  session: string,
  review: string,
  round: number,
  findings: readonly object[],
  roster: readonly object[] = [],
  generation = 1
) => {
  const directory = path.join(
    session,
    ".state",
    "reviews",
    review,
    `round-${round}`
  );

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "round.json"),
    JSON.stringify({ round, generation, cap: 2, roster })
  );
  fs.writeFileSync(
    path.join(directory, "findings.json"),
    JSON.stringify({ review, round, findings })
  );
};

const addSlotOutcome = (
  session: string,
  review: string,
  round: number,
  generation: number,
  physicalSlot: string,
  outcome: JsonObject
) => {
  const directory = path.join(
    session,
    ".state",
    "reviews",
    review,
    `round-${round}`,
    `gen-${generation}`,
    "slots"
  );

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `${physicalSlot}.json`),
    `${JSON.stringify(outcome)}\n`
  );
};

const bind = (f: ReturnType<typeof fixture>) => {
  const plan = path.join(f.docs, "work.plan.md");
  const design = path.join(f.docs, "strategy.design.md");
  fs.writeFileSync(
    path.join(f.session, "ledger.jsonl"),
    `${JSON.stringify({
      kind: "bind",
      by: "orchestrator",
      key: "bind",
      seq: 1,
      at: "2026-10-28T00:00:00.000Z",
      data: {
        spec: "mission.spec.md",
        plan: path.relative(f.root, plan),
        design: path.relative(f.root, design),
      },
    })}\n`
  );
};

test("completed CLEAN rounds render with per-round relative links", () => {
  const f = fixture();

  try {
    const review = "plan-work.plan";
    addRound(f.session, review, 1, [{ id: "R1-F001", severity: "SHOULD" }]);
    addRound(f.session, review, 2, []);
    const result = reviewRows(f.session, foldLedger(f.session), [], [review]);

    const rendered = renderFindingsSection(
      result.rows,
      result.rounds.map((round) => ({
        ...round,
        path: path.resolve(f.session, round.path),
      })),
      path.join(f.session, "docs")
    );

    assert.equal(result.rounds.length, 2);
    assert.match(
      rendered,
      /\| plan-work\.plan \| R1-F001 \| 1 \| SHOULD \| — \| Open \|/u
    );
    assert.match(
      rendered,
      /Round 1 \(plan-work\.plan\): 1 findings — \[findings\]\(\.\.\/\.state\/reviews\/plan-work\.plan\/round-1\/findings\.json\)/u
    );
    assert.match(
      rendered,
      /Round 2 \(plan-work\.plan\): 0 findings — \[findings\]\(\.\.\/\.state\/reviews\/plan-work\.plan\/round-2\/findings\.json\)/u
    );
    assert.doesNotMatch(rendered, /No reviews conducted yet/u);
  } finally {
    f.cleanup();
  }
});

test("findings sources use current responder metadata and explicit unknowns", () => {
  const f = fixture();

  try {
    const review = "plan-work.plan";

    const sources = [
      "reviewer[0]",
      "reserve-target[0]",
      "native[0]",
      "historical[0]",
      "null[0]",
    ];

    addRound(
      f.session,
      review,
      1,
      [{ id: "R1-F001", severity: "MUST", sources }],
      [
        {
          slot: "reviewer[0]",
          provider: "claude",
          model: ["configured-first", "configured-fallback"],
          effort: "low",
        },
        {
          slot: "reserve-target[0]",
          provider: "claude",
          model: ["target-configured"],
          effort: "low",
        },
        {
          slot: "reserve[0]",
          provider: "codex",
          model: ["reserve-configured"],
          effort: "xhigh",
          reserve: true,
        },
        {
          slot: "native[0]",
          provider: "codex",
          model: ["native-configured"],
          effort: "low",
          native: true,
        },
        {
          slot: "historical[0]",
          provider: "claude",
          model: ["legacy-first", "legacy-fallback"],
          effort: "medium",
        },
        {
          slot: "null[0]",
          provider: "opencode",
          model: ["opencode-configured"],
          effort: "medium",
        },
      ],
      2
    );
    addSlotOutcome(f.session, review, 1, 1, "reviewer[0]", {
      slot: "reviewer[0]",
      state: "done",
      text: "stale",
      responder: {
        slot: "reviewer[0]",
        provider: "claude",
        model: "stale-generation-model",
        native: false,
      },
    });
    addSlotOutcome(f.session, review, 1, 2, "reviewer[0]", {
      slot: "reviewer[0]",
      state: "done",
      text: "fallback response",
      responder: {
        slot: "reviewer[0]",
        provider: "claude",
        model: "actual-fallback",
        native: false,
      },
    });
    addSlotOutcome(f.session, review, 1, 2, "reserve[0]", {
      slot: "reserve-target[0]",
      state: "done",
      text: "reserve response",
      responder: {
        slot: "reserve[0]",
        provider: "codex",
        model: "reserve-actual",
        native: false,
      },
    });
    addSlotOutcome(f.session, review, 1, 2, "native[0]", {
      slot: "native[0]",
      state: "done",
      text: "native response",
      responder: {
        slot: "native[0]",
        provider: "codex",
        model: "native-model",
        native: true,
        effort: "high",
      },
    });
    addSlotOutcome(f.session, review, 1, 2, "historical[0]", {
      slot: "historical[0]",
      state: "done",
      text: "historical response",
    });
    addSlotOutcome(f.session, review, 1, 2, "null[0]", {
      slot: "null[0]",
      state: "done",
      text: "null-model response",
      responder: {
        slot: "null[0]",
        provider: "opencode",
        model: null,
        native: false,
      },
    });
    const result = reviewRows(f.session, foldLedger(f.session), [], [review]);

    const expected = [
      "actual-fallback/low",
      "reserve-actual/xhigh",
      "native-model/high",
      "unknown (claude/historical[0])",
      "unknown (opencode/null[0])/medium",
    ];

    assert.deepEqual(defined(result.rows[0]).sources, expected);
    const rendered = renderFindingsSection(result.rows, [], f.docs);
    assert.ok(rendered.includes(`| MUST | ${expected.join(", ")} | Open |`));
  } finally {
    f.cleanup();
  }
});

test("plan and design refresh only the findings section and preserve governed hashes", () => {
  const f = fixture();

  try {
    bind(f);
    const plan = path.join(f.docs, "work.plan.md");
    const design = path.join(f.docs, "strategy.design.md");

    const before = new Map([
      [
        plan,
        "# Work\r\n\r\n## Review Findings & Resolutions\r\nDriver notes\r\n\r\n## Next\r\nKeep this plan.\r\n",
      ],
      [
        design,
        "# Strategy\r\n\r\n## Review Findings & Resolutions\r\nOld findings\r\n\r\n## Next\r\nKeep this design.\r\n",
      ],
    ]);

    for (const [file, source] of before) {
      fs.writeFileSync(file, source);
    }

    addRound(
      f.session,
      "plan-work.plan",
      1,
      [{ id: "R1-F001", severity: "SHOULD", sources: ["plan-reviewer[0]"] }],
      [
        {
          slot: "plan-reviewer[0]",
          provider: "claude",
          model: ["configured-plan-reviewer"],
          effort: "medium",
        },
      ]
    );
    addRound(f.session, "design-strategy.design", 1, [
      { id: "R1-F001", severity: "MUST" },
    ]);
    addSlotOutcome(f.session, "plan-work.plan", 1, 1, "plan-reviewer[0]", {
      slot: "plan-reviewer[0]",
      state: "done",
      text: "plan finding",
      responder: {
        slot: "plan-reviewer[0]",
        provider: "claude",
        model: "actual-plan-reviewer",
        native: false,
      },
    });

    for (const [kind, file, review] of [
      ["plan", plan, "plan-work.plan"],
      ["design", design, "design-strategy.design"],
    ] as const) {
      const original = defined(before.get(file));
      const hash = artifactHash(kind, original);
      const suffix = original.slice(original.indexOf("## Next"));
      const first = refreshFindingsSection(f.session, f.manifest, review);
      assert.equal(first, "updated");
      const updated = fs.readFileSync(file, "utf-8");
      assert.equal(
        updated.slice(0, updated.indexOf("## Review Findings & Resolutions")),
        original.slice(0, original.indexOf("## Review Findings & Resolutions"))
      );
      assert.ok(updated.endsWith(suffix));
      assert.equal(artifactHash(kind, updated), hash);
      assert.match(updated, /Round 1/u);

      if (kind === "plan") {
        assert.match(
          updated,
          /\| SHOULD \| actual-plan-reviewer\/medium \| Open \|/u
        );
      }

      assert.equal(
        refreshFindingsSection(f.session, f.manifest, review),
        "unchanged"
      );
    }
  } finally {
    f.cleanup();
  }
});

test("refresh appends a missing findings section and skips unmatched reviews", () => {
  const f = fixture();

  try {
    bind(f);
    const plan = path.join(f.docs, "work.plan.md");
    fs.writeFileSync(plan, "# Work\n\n## Next\nKeep this plan.\n");
    addRound(f.session, "plan-work.plan", 1, [
      { id: "R1-F001", severity: "SHOULD" },
    ]);

    let reason = "";

    const unmatched = refreshFindingsSection(
      f.session,
      f.manifest,
      "plan-other.plan",
      (detail) => {
        reason = detail;
      }
    );

    assert.equal(unmatched, "skipped");
    assert.match(reason, /bound/iu);
    assert.equal(
      fs.readFileSync(plan, "utf-8"),
      "# Work\n\n## Next\nKeep this plan.\n"
    );

    const appended = refreshFindingsSection(
      f.session,
      f.manifest,
      "plan-work.plan"
    );

    assert.equal(appended, "updated");
    const source = fs.readFileSync(plan, "utf-8");
    assert.match(source, /## Review Findings & Resolutions/u);
    assert.match(source, /Round 1 \(plan-work\.plan\): 1 findings/u);
    assert.match(source, /## Next\nKeep this plan\./u);
  } finally {
    f.cleanup();
  }
});

test("rulingReview accepts only plan and design review finding subjects", () => {
  assert.equal(rulingReview("review:plan-work.plan:R1-F001"), "plan-work.plan");
  assert.equal(
    rulingReview("review:design-strategy.design:R12-F009"),
    "design-strategy.design"
  );
  assert.equal(rulingReview("review:code-src-file:R1-F001"), null);
  assert.equal(rulingReview("review:plan-work.plan:not-a-finding"), null);
});

// SECTION: Corrected severity in rendered rows

const ledgerWith = (
  f: ReturnType<typeof fixture>,
  rulings: readonly object[]
) => {
  const rows = rulings.map((data, index) => ({
    kind: "ruling",
    by: "orchestrator",
    key: `r${index}`,
    seq: index + 1,
    at: "2026-10-28T00:00:00.000Z",
    data: { subject: "review:plan-work.plan:R1-F001", ...data },
  }));

  fs.writeFileSync(
    path.join(f.session, "ledger.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
  );
};

const DEGRADES = {
  ruling: "accepted",
  impact: "degrades",
  trigger: "realistic",
  rationale: "impact: the Verify gate surfaces this gap",
};

const BLOCKS = {
  ruling: "accepted",
  impact: "blocks",
  trigger: "realistic",
  rationale: "impact: the promised outcome fails",
};

test("corrected severity: rows reflect latest corrected severity rules across accepted, deferred, and rejected rulings", () => {
  const cases: [
    string,
    string,
    readonly object[],
    string,
    string | undefined,
  ][] = [
    ["MUST", "blocks", [DEGRADES], "SHOULD", "MUST"],
    [
      "MUST",
      "blocks",
      [DEGRADES, { ruling: "deferred", rationale: "Later" }],
      "SHOULD",
      "MUST",
    ],
    [
      "MUST",
      "blocks",
      [DEGRADES, { ruling: "accepted", rationale: "Applied the fix" }],
      "SHOULD",
      "MUST",
    ],
    ["SHOULD", "degrades", [BLOCKS], "MUST", undefined],
    ["SHOULD", "degrades", [BLOCKS, DEGRADES], "SHOULD", undefined],
    ["MUST", "blocks", [], "MUST", undefined],
    [
      "MUST",
      "blocks",
      [DEGRADES, { ruling: "rejected", rationale: "The code prevents it" }],
      "MUST",
      undefined,
    ],
    [
      "SHOULD",
      "degrades",
      [BLOCKS, { ruling: "rejected", rationale: "The code prevents it" }],
      "MUST",
      undefined,
    ],
    [
      "SHOULD",
      "degrades",
      [DEGRADES, { ruling: "rejected", rationale: "The code prevents it" }],
      "SHOULD",
      undefined,
    ],
  ];

  const f = fixture();

  try {
    for (const [stored, impact, rulings, severity, downgradedFrom] of cases) {
      addRound(f.session, "plan-work.plan", 1, [
        { id: "R1-F001", severity: stored, impact, trigger: "realistic" },
      ]);
      ledgerWith(f, rulings);

      const [row] = reviewRows(
        f.session,
        foldLedger(f.session),
        [],
        ["plan-work.plan"]
      ).rows;

      assert.equal(defined(row).severity, severity, JSON.stringify(rulings));
      assert.equal(
        defined(row).downgradedFrom,
        downgradedFrom,
        JSON.stringify(rulings)
      );
    }
  } finally {
    f.cleanup();
  }
});

// SECTION: Budget summary

test("review summary refreshes budget from current ledger", () => {
  const f = fixture();

  try {
    bind(f);
    const plan = path.join(f.docs, "work.plan.md");
    fs.writeFileSync(
      plan,
      "# Work\n\n## Review Findings & Resolutions\nDriver notes\n"
    );
    addRound(f.session, "plan-work.plan", 1, []);
    addRound(f.session, "plan-work.plan", 2, [
      { id: "R2-F001", severity: "MUST" },
    ]);
    assert.equal(
      refreshFindingsSection(f.session, f.manifest, "plan-work.plan"),
      "updated"
    );
    assert.match(
      fs.readFileSync(plan, "utf-8"),
      /Budget \(plan-work\.plan\): next round 3 requires-continuation \(cap 2, ceiling 4\)/u
    );

    fs.appendFileSync(
      path.join(f.session, "ledger.jsonl"),
      `${JSON.stringify({
        kind: "ruling",
        by: "orchestrator",
        key: "accepted",
        seq: 2,
        at: "2026-10-28T00:00:00.000Z",
        data: {
          subject: "review:plan-work.plan:R2-F001",
          ruling: "accepted",
          rationale: "Fixed",
        },
      })}\n`
    );
    assert.equal(
      refreshFindingsSection(f.session, f.manifest, "plan-work.plan"),
      "updated"
    );
    assert.match(
      fs.readFileSync(plan, "utf-8"),
      /Budget \(plan-work\.plan\): next round 3 allowed \(cap 2, ceiling 4\)/u
    );
  } finally {
    f.cleanup();
  }
});

test("origin: marker renders beside a recurrence marker", () => {
  const f = fixture();

  try {
    const review = "plan-work.plan";
    addRound(f.session, review, 1, [
      { id: "R1-F001", severity: "SHOULD", origin: "original" },
      {
        id: "R1-F002",
        severity: "SHOULD",
        recurrence: { of: "R0-F001" },
        origin: "fix-induced",
      },
      { id: "R1-F003", severity: "SHOULD", origin: "invented" },
    ]);
    const result = reviewRows(f.session, foldLedger(f.session), [], [review]);
    assert.deepEqual(
      result.rows.map((row) => row.origin),
      ["original", "fix-induced", undefined]
    );
    const rendered = renderFindingsSection(result.rows, [], f.session);
    assert.match(rendered, /\| Open \(origin original\) \|/u);
    assert.match(
      rendered,
      /\| Open \(recurs R0-F001\) \(origin fix-induced\) \|/u
    );
    assert.match(rendered, /R1-F003 \| 1 \| SHOULD \| — \| Open \|/u);
  } finally {
    f.cleanup();
  }
});

const ratedFinding: Finding = {
  id: "R1-F002",
  severity: "MUST",
  impact: "blocks",
  trigger: "realistic",
  category: "reliability",
  locus: "§ Work",
  defect: "Lost write\n## heading",
  proposedFix: "Apply under lock",
  sources: ["agy[0]", "claude[0]"],
  scope: "in",
  origin: "fix-induced",
};

const legacyFinding = narrow(
  { id: "R1-F001", severity: "SHOULD" },
  (value): value is Finding =>
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "severity" in value
);

test("findings file: renders Markdown in severity order with neutralized text and missing ratings", () => {
  assert.equal(
    renderFindingsFile([legacyFinding, ratedFinding]),
    [
      "### R1-F002 MUST",
      "- Rating: blocks/realistic; category reliability; scope in; origin fix-induced",
      "- Locus: § Work",
      "- Defect: Lost write ## heading",
      "- Proposed fix: Apply under lock",
      "- Sources: agy[0], claude[0]",
      "",
      "### R1-F001 SHOULD",
      "- Rating: —/—; category —; scope —; origin —",
      "- Locus: —",
      "- Defect: —",
      "- Proposed fix: —",
      "- Sources: —",
      "",
    ].join("\n")
  );
  assert.equal(renderFindingsFile([]), "No findings.\n");
  assert.deepEqual(rulingsTemplate("plan-work.plan", 1, []), []);
});

test("rulings template: the step-back outcome skeleton follows the findings only for a marked round", () => {
  const review = "plan-work.plan";
  const plain = rulingsTemplate(review, 2, [ratedFinding]);
  assert.equal(plain.length, 1);
  assert.deepEqual(
    rulingsTemplate(review, 2, [ratedFinding], undefined),
    plain
  );

  const marked = rulingsTemplate(review, 2, [ratedFinding], { units: [] });

  assert.deepEqual(marked, [
    ...plain,
    {
      kind: "ruling",
      by: "orchestrator",
      key: "step-back:plan-work.plan:2",
      data: {
        subject: "step-back:plan-work.plan:2",
        ruling: "",
        rationale: "",
      },
    },
  ]);
  assert.deepEqual(
    rulingsTemplate(review, 2, [], { units: ["T1"], fixInduced: [2, 3] }),
    marked.slice(1)
  );
});

test("findings file: a filled batch appends and a later ruling needs a new key", async () => {
  const f = fixture();

  const deps = {
    pid: 42,
    host: "test",
    clock: () => 0,
    sleep: async () => {},
    isAlive: () => false,
  };

  try {
    fs.writeFileSync(
      path.join(f.session, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        folderName: path.basename(f.session),
        sessionId: "test",
        safeSessionId: "test",
        repositoryRoot: f.root,
      })
    );
    const review = "plan-work.plan";
    const template = rulingsTemplate(review, 1, [ratedFinding, legacyFinding]);
    assert.deepEqual(
      template,
      ["R1-F002", "R1-F001"].map((id) => ({
        kind: "ruling",
        by: "orchestrator",
        key: `ruling:plan-work.plan:1:${id}`,
        data: {
          subject: `review:plan-work.plan:${id}`,
          ruling: "",
          rationale: "",
          fix: "",
        },
      }))
    );
    await assert.rejects(appendRecords(f.session, template, deps), {
      reason: "invalid-record",
    });

    const filled = template.map((entry) => ({
      ...entry,
      data: {
        ...entry.data,
        ruling: "accepted",
        rationale: "Verified the defect",
        fix: "proposed",
      },
    }));

    const appendRecordsResult = await appendRecords(f.session, filled, deps);

    assert.equal(appendRecordsResult.seq, 2);
    const initial = defined(filled[0]);

    const later = {
      ...initial,
      data: {
        ...initial.data,
        ruling: "deferred",
        rationale: "Schedule separately",
        fix: "",
      },
    };

    await assert.rejects(appendRecords(f.session, later, deps), {
      reason: "key-conflict",
    });

    const appendRecordsResult2 = await appendRecords(
      f.session,
      { ...later, key: `${later.key}:2` },
      deps
    );

    assert.equal(appendRecordsResult2.seq, 3);
  } finally {
    f.cleanup();
  }
});
