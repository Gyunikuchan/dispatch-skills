import assert from "node:assert/strict";
import { test } from "node:test";

import type { CoverageState } from "../../../skills/dispatch/scripts/toolkit/coverage.ts";
import { renderWalkthrough } from "../../../skills/dispatch/scripts/toolkit/walkthrough.ts";
import type { WalkthroughView } from "../../../skills/dispatch/scripts/toolkit/walkthrough.ts";
import { defined } from "../../helpers/guards.ts";

const view = (overrides: Partial<WalkthroughView> = {}) => ({
  title: "Report plan",
  specPath: "spec/report.spec.md",
  specHash: `sha256:${"a".repeat(64)}`,
  planPath: "plans/report.plan.md",
  planHash: `sha256:${"b".repeat(64)}`,
  delivered: {
    integrated: 2,
    total: 2,
    source: "123456abcdef7890",
    branch: "main",
    ref: "refs/dispatch/x/delivered-source",
  },
  glance: {
    what: "The plan behaviour is visible to readers.",
    how: "The renderer copies the plan details.",
    visuals: "",
  },
  risk: "med",
  focus: { bullets: [] },
  tasks: [
    {
      id: "T1",
      title: "Render reports",
      outcome: "The report stays readable.",
      behaviour: ["Readers see the outcome first."],
    },
  ],
  statuses: [],
  changes: [],
  edits: [],
  unplannedPaths: [],
  openEscalations: [],
  deferredRulings: [],
  deferredEscalations: [],
  userRecords: [],
  reviewRows: [],
  reviewRounds: [],
  reviewFixes: [],
  ...overrides,
});

const section = (rendered: string, heading: string, nextHeading?: string) => {
  const start = rendered.indexOf(heading);

  const end =
    (nextHeading ?? "").length > 0
      ? rendered.indexOf(defined(nextHeading), start + heading.length)
      : rendered.length;

  assert.notEqual(start, -1, `missing ${heading}`);
  assert.notEqual(end, -1, `missing ${nextHeading}`);

  return rendered.slice(start, end);
};

test("walkthrough follows reviewer order and states counts once", () => {
  const rendered = renderWalkthrough(
    view({
      risk: "low",
      statuses: [
        {
          criterion: "SC1",
          state: "verified" as const,
          evidence: "evidence/sc1.json",
        },
      ],
      changes: [
        {
          action: "MODIFY" as const,
          path: "src/report.ts",
          owners: [{ id: "T1", title: "Render reports" }],
        },
      ],
    })
  );

  assert.deepEqual(
    [...rendered.matchAll(/^## .+$/gmu)].map((match) => match[0]),
    [
      "## At a Glance",
      "## Visuals",
      "## Review Focus",
      "## Behaviour Changes",
      "## Verification",
      "## Runtime Proof",
      "## Deviations & Follow-ups",
      "## Review Findings & Resolutions",
      "## Appendix",
    ]
  );
  const glance = section(rendered, "## At a Glance", "## Visuals");
  assert.match(
    glance,
    /- \*\*What:\*\* The plan behaviour is visible to readers\./u
  );
  assert.match(glance, /- \*\*Artifacts:\*\* \[spec\]/u);

  const counts = defined(
    glance.split("<details>\n<summary>Detailed counts</summary>\n\n")[1]
  );

  assert.equal((counts.match(/^- \*\*Counts:\*\*/gmu) ?? []).length, 1);

  for (const count of [
    "1/1 criteria",
    "1 files",
    "0 recorded edits",
    "0 unplanned paths",
    "0 findings",
  ]) {
    assert.equal(
      (counts.match(new RegExp(count, "gu")) ?? []).length,
      1,
      count
    );
  }

  assert.equal(
    section(rendered, "## Review Focus", "## Behaviour Changes"),
    "## Review Focus\n\n- Risk: low · Delivery matched the plan and all criteria are verified.\n\n"
  );

  const verification = section(
    rendered,
    "## Verification",
    "## Deviations & Follow-ups"
  );

  assert.match(verification, /- \*\*Status:\*\* complete/u);
  assert.doesNotMatch(verification, /\d+\/\d+|\d+ files|\d+ findings/u);
});

test("renderWalkthrough keeps human summary and follow-ups visible while collapsing verbose audit details", () => {
  const deferredRulings = [{ review: "review-alpha", finding: "R1-F001" }];

  const deferredEscalations = [
    { id: "E-2", summary: "Confirm after release." },
  ];

  for (const [followUps, pointer] of [
    [{ deferredRulings }, "Deferred finding review-alpha:R1-F001"],
    [{ deferredEscalations }, "Deferred escalation E-2"],
  ] as const) {
    const focus = section(
      renderWalkthrough(view(followUps)),
      "## Review Focus",
      "## Behaviour Changes"
    );

    assert.doesNotMatch(focus, /Delivery matched the plan/u);
    assert.ok(focus.includes(`- ${pointer} — see Deviations & Follow-ups`));
  }

  const rendered = renderWalkthrough(
    view({
      deferredRulings,
      deferredEscalations,
      statuses: [
        { criterion: "SC1", state: "verified", evidence: "evidence/sc1.json" },
      ],
      changes: [{ action: "MODIFY", path: "src/a.ts", owners: [] }],
      edits: [
        {
          seq: 1,
          artifact: "plan",
          class: "non-intent",
          rationale: "Clarified scope.",
          diffRef: "diff/plan.patch",
          affects: ["T1"],
        },
      ],
      reviewRows: [
        {
          review: "review-alpha",
          id: "R1-F001",
          round: 1,
          severity: "SHOULD",
          ruling: "deferred",
          rationale: "Confirm later.",
        },
      ],
      reviewRounds: [
        {
          review: "review-alpha",
          round: 1,
          findings: 1,
          path: "review/findings.json",
        },
      ],
      coverage: "unreadable",
    })
  );

  const glance = section(rendered, "## At a Glance", "## Visuals");
  assert.match(
    glance,
    /- \*\*Summary:\*\* 1\/1 criteria satisfied · 1 files changed · 0 open findings · 2 deferred follow-ups\n\n<details>/u
  );

  const deviations = section(
    rendered,
    "## Deviations & Follow-ups",
    "## Review Findings & Resolutions"
  );

  assert.match(
    deviations,
    /- Follow-up: deferred review-alpha:R1-F001\n- Follow-up: deferred escalation E-2: Confirm after release\.\n\n<details>\n<summary>Deviations \(1\)<\/summary>\n\n- Deviation: .*diff\/plan\.patch.*\n\n<\/details>/u
  );

  const findings = section(
    rendered,
    "## Review Findings & Resolutions",
    "## Appendix"
  );

  assert.match(
    findings,
    /1 findings across 1 rounds \(0 open\)\n\n- Coverage state unreadable\n\n<details>\n<summary>Findings table \(1\)<\/summary>\n\n\| Review \| ID \|/u
  );
  assert.match(
    findings,
    /\| Deferred \| Confirm later\. \|\n\n- Round 1 .*\[findings\]\(review\/findings\.json\)\n\n<\/details>/u
  );
});

test("walkthrough review focus points to attention details in their owning sections", () => {
  const rendered = renderWalkthrough(
    view({
      risk: "high",
      focus: {
        bullets: [
          {
            text: "Inspect this<!-- hidden --> path.",
            evidence: "notes/review-focus.md",
          },
        ],
      },
      statuses: [
        {
          criterion: "SC1",
          state: "verified" as const,
          evidence: "evidence/sc1.json",
        },
        {
          criterion: "SC2",
          state: "manual" as const,
          seq: 2,
          evidence: "manual/proof.md",
          quote: "manual approval",
        },
        {
          criterion: "SC3",
          state: "waived" as const,
          seq: 3,
          reason: "approved exception",
          quote: "waived by user",
        },
        { criterion: "SC4", state: "missing" as const },
      ],
      edits: [
        {
          seq: 1,
          artifact: "plan",
          class: "non-intent",
          rationale: "No user decision is needed.",
          diffRef: "diff/plan.patch",
          affects: ["T1"],
        },
        {
          seq: 2,
          artifact: "plan",
          class: "intent",
          rationale: "The user must approve this intent change.",
          diffRef: "diff/intent.patch",
          affects: ["T1"],
        },
        {
          seq: 3,
          artifact: "design",
          class: "dependency",
          rationale: "The user must approve this dependency.",
          diffRef: "diff/dependency.patch",
          affects: ["T1"],
        },
        {
          seq: 4,
          artifact: "plan",
          class: "discard",
          rationale: "The user must approve this discard.",
          diffRef: "diff/discard.patch",
          affects: ["T1"],
        },
      ],
      unplannedPaths: ["src/orphan.ts"],
      openEscalations: [{ id: "E-1", summary: "Confirm the remaining owner." }],
      deferredRulings: [{ review: "review-alpha", finding: "R1-F011" }],
      reviewRows: [
        {
          review: "review-alpha",
          id: "R1-F009",
          round: 1,
          severity: "MUST",
          ruling: null,
          rationale: "",
        },
        {
          review: "review-alpha",
          id: "R1-F010",
          round: 1,
          severity: "SHOULD",
          ruling: "rejected" as const,
          rationale: "The proposed change is not needed.",
        },
        {
          review: "review-alpha",
          id: "R1-F011",
          round: 1,
          severity: "SHOULD",
          ruling: "deferred" as const,
          rationale: "The evidence is incomplete.",
        },
        {
          review: "review-alpha",
          id: "R1-F012",
          round: 1,
          severity: "CONSIDER",
          ruling: "rejected" as const,
          rationale: "The rejected CONSIDER stays with findings.",
        },
      ],
      reviewFixes: [
        {
          commit: "d".repeat(40),
          reason: "repair accepted SHOULD",
          metadata: {
            review: "review-alpha",
            round: 2,
            generation: 1,
            findings: ["R2-F001"],
            from: "c".repeat(40),
          },
          status: "verified but not re-reviewed",
          paths: ["src/report.ts"],
        },
        {
          commit: "e".repeat(40),
          reason: "unverified correction",
          metadata: {
            review: "review-alpha",
            round: 2,
            generation: 1,
            findings: ["R2-F002"],
            from: "c".repeat(40),
          },
          status: "not verified",
          paths: [],
        },
      ],
    })
  );

  const focus = section(rendered, "## Review Focus", "## Behaviour Changes");
  assert.deepEqual(
    focus.split("\n").filter((line) => line.startsWith("- ")),
    [
      "- Risk: high",
      "- Open escalation E-1 — see Deviations & Follow-ups",
      "- Deferred finding review-alpha:R1-F011 — see Deviations & Follow-ups",
      "- Open finding review-alpha:R1-F009 (MUST) — see Review Findings & Resolutions",
      "- Manual criterion SC2 — see Verification",
      "- Waived criterion SC3 — see Verification",
      "- Missing criterion SC4 — see Verification",
      "- Review fix R2-F001: verified but not re-reviewed — see Deviations & Follow-ups",
      "- Review fix R2-F002: not verified — see Deviations & Follow-ups",
      "- Unplanned path src/orphan.ts — see Deviations & Follow-ups",
      "- Rejected SHOULD finding review-alpha:R1-F010 — see Review Findings & Resolutions",
      "- Plan edit (intent) seq 2 — see Deviations & Follow-ups",
      "- Design edit (dependency) seq 3 — see Deviations & Follow-ups",
      "- Plan edit (discard) seq 4 — see Deviations & Follow-ups",
      "- Inspect this&lt;!-- hidden --&gt; path. — Evidence: [notes/review-focus.md](notes/review-focus.md)",
    ]
  );

  const verification = section(
    rendered,
    "## Verification",
    "## Deviations & Follow-ups"
  );

  for (const detail of ["manual approval", "approved exception", "SC4"]) {
    assert.ok(verification.includes(detail), detail);
  }

  const deviations = section(
    rendered,
    "## Deviations & Follow-ups",
    "## Review Findings & Resolutions"
  );

  for (const detail of [
    "No user decision is needed.",
    "diff/plan.patch",
    "Confirm the remaining owner.",
    "review-alpha:R1-F011",
    "src/orphan.ts",
    "- Deviation: review fix R2-F001: verified but not re-reviewed; commit dddddddddddd; paths src/report.ts",
    "- Deviation: review fix R2-F002: not verified; commit eeeeeeeeeeee; paths none",
  ]) {
    assert.ok(deviations.includes(detail), detail);
  }

  const findings = section(
    rendered,
    "## Review Findings & Resolutions",
    "## Appendix"
  );

  for (const detail of [
    "R1-F011",
    "The evidence is incomplete.",
    "R1-F012",
    "The rejected CONSIDER stays with findings.",
  ]) {
    assert.ok(findings.includes(detail), detail);
  }
});

test("walkthrough links planned visuals or shows the recorded replacement", () => {
  const planVisuals = [
    "- Text summary: The map shows the request boundary.",
    "- Note: Ignore this <!-- hidden --> marker.",
    "",
    "| Component | Role |",
    "| --- | --- |",
    "| Gateway | Accepts requests |",
    "| Store | Persists responses |",
    "",
    "```mermaid",
    "flowchart LR",
    "  Gateway --> Store",
    "```",
  ].join("\n");

  const copied = renderWalkthrough(
    view({
      glance: {
        what: "The feature works.",
        how: "The map shows the request path.",
        visuals: planVisuals,
      },
    })
  );

  const copiedVisuals = section(copied, "## Visuals", "## Review Focus");
  assert.ok(
    copiedVisuals.includes(
      "See [plan visuals](plans/report.plan.md#at-a-glance)."
    )
  );
  assert.ok(!copiedVisuals.includes("Gateway --> Store"));

  const replacement = [
    "- Text summary: The replacement shows the delivered retry path.",
    "",
    "```mermaid",
    "sequenceDiagram",
    "  Client->>Gateway: retry",
    "```",
  ].join("\n");

  const replaced = renderWalkthrough(
    view({
      glance: {
        what: "The feature works.",
        how: "The map shows the request path.",
        visuals: planVisuals,
      },
      focus: { bullets: [], visual: replacement },
    })
  );

  const visuals = section(replaced, "## Visuals", "## Review Focus");
  assert.ok(visuals.includes(replacement));
  assert.ok(!visuals.includes("Gateway --> Store"));
});

test("walkthrough appendix keeps evidence, user records, deviations, findings, provenance and review fixes", () => {
  const rendered = renderWalkthrough(
    view({
      statuses: [
        {
          criterion: "SC1",
          state: "verified" as const,
          evidence: "evidence/first.json",
          reason: "verified at fedcba6543210987; tests removed in cleanup",
        },
        {
          criterion: "SC2",
          state: "manual" as const,
          seq: 3,
          quote: "manual | quote<!-- hidden -->",
          evidence: "manual/proof.md",
        },
        {
          criterion: "SC3",
          state: "waived" as const,
          seq: 4,
          quote: "waiver quote",
          reason: "accepted exception",
        },
        { criterion: "SC4", state: "missing" as const },
      ],
      changes: [
        {
          action: "MODIFY" as const,
          path: "src/report.ts",
          owners: [{ id: "T1", title: "Render reports" }],
        },
      ],
      edits: [
        {
          seq: 1,
          artifact: "plan",
          class: "clarification",
          rationale: "Added an evidence edge case.",
          diffRef: "diff/1.patch",
          affects: ["T1"],
        },
      ],
      unplannedPaths: ["src/orphan.ts"],
      openEscalations: [{ id: "E-1", summary: "Confirm the remaining owner." }],
      deferredRulings: [{ review: "review-alpha", finding: "R1-F010" }],
      deferredEscalations: [
        { id: "E-2", summary: "defer: confirm after release" },
      ],
      userRecords: [
        {
          seq: 7,
          kind: "manual-complete",
          summary: "manual-result evidence",
          quote: "the user approved this row | <!-- literal -->",
        },
      ],
      reviewRows: [
        {
          review: "review-alpha",
          id: "R1-F001",
          round: 1,
          severity: "SHOULD",
          ruling: "accepted" as const,
          recurrence: "R1-F001",
          rationale: "bounded fix accepted",
        },
        {
          review: "review-alpha",
          id: "R1-F002",
          round: 1,
          severity: "MUST",
          ruling: null,
          unresolved: "R1-F002",
          rationale: "Awaiting evidence.",
        },
      ],
      reviewRounds: [
        {
          review: "review-alpha",
          round: 1,
          findings: 2,
          path: ".state/reviews/review-alpha/round-1/findings.json",
        },
      ],
      reviewFixes: [
        {
          commit: "d".repeat(40),
          reason: "repair accepted SHOULD",
          metadata: {
            review: "review-alpha",
            round: 1,
            generation: 1,
            findings: ["R1-F001"],
            from: "c".repeat(40),
          },
          status: "verified but not re-reviewed",
          paths: ["src/report.ts"],
          verification: {
            tree: "e".repeat(40),
            criteria: ["SC1"],
            contract: ["contract"],
          },
        },
      ],
      reviewedCodeBaseline: "c".repeat(40),
      testCleanup: {
        from: "123456abcdef7890",
        trees: { SC1: "fedcba6543210987" },
        removed: ["SC1"],
        deleted: 3,
        merged: 1,
      },
    })
  );

  const appendix = section(rendered, "## Appendix");

  for (const detail of [
    "<details>\n\n<summary>Audit records</summary>",
    "### Provenance",
    `Spec: [spec/report.spec.md](spec/report.spec.md) · sha256:${"a".repeat(12)}`,
    `Plan: [plans/report.plan.md](plans/report.plan.md) · sha256:${"b".repeat(12)}`,
    "Integration: source 123456abcdef7890 · branch main · ref refs/dispatch/x/delivered-source",
    "### Verified Evidence",
    "[source evidence](evidence/first.json)",
    "verified at fedcba6543210987; tests removed in cleanup",
    "### User-Attributed Records",
    String.raw`the user approved this row \| &lt;!-- literal --&gt;`,
    "</details>",
  ]) {
    assert.ok(appendix.includes(detail), detail);
  }

  assert.ok(
    section(rendered, "## Verification", "## Deviations & Follow-ups").includes(
      "- **Test cleanup:** deleted 3 · merged 1 tests; criteria with tests removed: SC1 at fedcba654321"
    )
  );
  const deviations = section(rendered, "## Deviations & Follow-ups");
  assert.match(
    deviations,
    /^- Follow-up: deferred escalation E-2: defer: confirm after release$/mu
  );
  assert.match(
    section(rendered, "## At a Glance"),
    /; 1 deferred rulings; 1 deferred escalations;/u
  );
  assert.match(
    section(rendered, "## Review Focus", "## Behaviour Changes"),
    /- Review fix R1-F001: verified but not re-reviewed — see Deviations & Follow-ups/u
  );
  assert.match(
    deviations,
    /- Deviation: review fix R1-F001: verified but not re-reviewed; commit dddddddddddd; paths src\/report\.ts/u
  );

  for (const detail of [
    "diff/1.patch",
    "src/orphan.ts",
    "Confirm the remaining owner.",
    "review-alpha:R1-F010",
  ]) {
    assert.ok(deviations.includes(detail), detail);
  }

  const findings = section(rendered, "## Review Findings & Resolutions");

  for (const detail of [
    "| review-alpha | R1-F001 | 1 | SHOULD | — | Accepted (recurs R1-F001) |",
    "[findings](.state/reviews/review-alpha/round-1/findings.json)",
  ]) {
    assert.ok(findings.includes(detail), detail);
  }

  assert.ok(
    !appendix.includes("Review Findings & Resolutions") &&
      !appendix.includes("Deviations & Follow-ups")
  );
  assert.ok(
    rendered.indexOf("## Verification") <
      rendered.indexOf("## Deviations & Follow-ups") &&
      rendered.indexOf("## Review Findings & Resolutions") <
        rendered.indexOf("## Appendix")
  );
});

test("walkthrough lists a re-reviewed fix only in deviations", () => {
  const rendered = renderWalkthrough(
    view({
      reviewFixes: [
        {
          commit: "d".repeat(40),
          reason: "repair",
          status: "re-reviewed",
          paths: ["src/report.ts"],
          metadata: {
            review: "code-integration",
            round: 1,
            generation: 1,
            findings: ["R1-F001"],
            from: "c".repeat(40),
          },
        },
      ],
    })
  );

  assert.doesNotMatch(
    section(rendered, "## Review Focus", "## Behaviour Changes"),
    /R1-F001/u
  );
  assert.match(
    section(rendered, "## Deviations & Follow-ups"),
    /- Deviation: review fix R1-F001: re-reviewed; commit dddddddddddd; paths src\/report\.ts/u
  );
});

test("walkthrough names the evidence tree of removed criteria", () => {
  const rendered = renderWalkthrough(
    view({
      testCleanup: {
        from: "1111111111111111",
        trees: { SC1: "aaaa111122223333", SC2: "bbbb444455556666" },
        removed: ["SC1", "SC2"],
        deleted: 2,
        merged: 1,
      },
    })
  );

  const verification = section(rendered, "## Verification", "## Runtime Proof");
  assert.ok(
    verification.includes(
      "- **Test cleanup:** deleted 2 · merged 1 tests; criteria with tests removed: SC1 at aaaa11112222, SC2 at bbbb44445555"
    )
  );
  assert.ok(!verification.includes("111111111111"));
});

test("downgraded finding: a downgraded row appears in attention and in the findings table, whatever the ruling", () => {
  for (const ruling of ["accepted", "deferred"] as const) {
    const rendered = renderWalkthrough(
      view({
        reviewRows: [
          {
            review: "review-alpha",
            id: "R1-F001",
            round: 1,
            severity: "SHOULD",
            downgradedFrom: "MUST",
            ruling,
            rationale: "impact: the gate surfaces it",
          },
          {
            review: "review-alpha",
            id: "R1-F002",
            round: 1,
            severity: "SHOULD",
            ruling: "accepted" as const,
            rationale: "Fixed",
          },
        ],
      })
    );

    const focus = section(rendered, "## Review Focus", "## Behaviour Changes");
    assert.match(
      focus,
      /^- Downgraded finding review-alpha:R1-F001 \(MUST to SHOULD\) — see Review Findings & Resolutions$/mu
    );
    assert.doesNotMatch(focus, /R1-F002/u);

    const findings = section(
      rendered,
      "## Review Findings & Resolutions",
      "## Appendix"
    );

    const label = ruling === "accepted" ? "Accepted" : "Deferred";
    assert.ok(
      findings.includes(`| ${label} (downgraded from MUST) |`),
      findings
    );
    assert.ok(
      findings.includes("| R1-F002 | 1 | SHOULD | — | Accepted |"),
      findings
    );
  }
});

const coverage = (overrides: Partial<CoverageState> = {}): CoverageState => ({
  targets: ["codex[0]", "opencode[1]", "claude[2]", "agy[3]"],
  completed: ["claude[2]", "agy[3]"],
  open: [],
  overridden: [],
  coverageRounds: [],
  freeUsed: false,
  unusedGrant: false,
  incomplete: null,
  decision: "none",
  ...overrides,
});

const findings = (rendered: string) =>
  section(rendered, "## Review Findings & Resolutions", "## Appendix");

test("walkthrough reports coverage open slots, overrides, rounds, unreadable and clean states", () => {
  {
    const majority = findings(
      renderWalkthrough(
        view({
          reviewRounds: [
            {
              review: "code-integration",
              round: 1,
              findings: 0,
              path: ".state/reviews/code-integration/round-1/findings.json",
            },
          ],
          coverage: coverage({
            targets: ["codex[0]", "opencode[1]", "claude[2]"],
            completed: ["opencode[1]", "claude[2]"],
            open: ["codex[0]"],
            coverageRounds: [2, 3],
            decision: "majority",
          }),
        })
      )
    );

    assert.match(
      majority,
      /^- Open coverage slots: codex\[0\]; reduced coverage accepted under the majority rule \(2 of 3 target slots completed\)$/mu
    );
    assert.match(
      majority,
      /^- Round 1 \(code-integration\): 0 findings — \[findings\]\(.+\)$/mu
    );
    assert.doesNotMatch(majority, /<details>/u);
    assert.match(majority, /^- Coverage rounds: 2, 3$/mu);

    const overridden = findings(
      renderWalkthrough(
        view({
          coverage: coverage({
            open: ["agy[3]"],
            overridden: [
              { slot: "codex[0]", quote: "ship it | <!-- x -->", seq: 9 },
            ],
            coverageRounds: [2],
            decision: "user",
          }),
        })
      )
    );

    assert.match(overridden, /^- Open coverage slots: agy\[3\]$/mu);
    assert.doesNotMatch(overridden, /majority/u);
    assert.match(
      overridden,
      /^- Coverage override: codex\[0\] at seq 9; user quote: ship it \| &lt;!-- x --&gt;$/mu
    );
  }

  {
    assert.match(
      findings(renderWalkthrough(view({ coverage: "unreadable" }))),
      /^- Coverage state unreadable$/mu
    );
    const plain = renderWalkthrough(view());
    assert.equal(renderWalkthrough(view({ coverage: coverage() })), plain);
    assert.doesNotMatch(plain, /overage/u);
  }
});

const linkFixture = () =>
  view({
    repositoryRoot: "/repo",
    designPath: "designs/report.design.md",
    designHash: `sha256:${"c".repeat(64)}`,
    glance: {
      what: "Delivered.",
      how: "Copied explanation should disappear.",
      visuals: "Plan diagram content. ".repeat(30),
    },
    tasks: [1, 2, 3].map((n) => ({
      id: `T${n}`,
      title: "Path bytes",
      outcome: `Outcome ${n}`,
      behaviour: [
        `Copied behaviour ${n} with detailed explanation. `.repeat(8),
      ],
    })),
  });

test("walkthrough links governing artifacts instead of restating them", () => {
  const rendered = renderWalkthrough(linkFixture(), "/sessions/run");

  for (const expected of [
    "[spec](../../repo/spec/report.spec.md)",
    "[plan](../../repo/plans/report.plan.md)",
    "[design](../../repo/designs/report.design.md)",
    "[plan visuals](../../repo/plans/report.plan.md#at-a-glance)",
    "Outcome 1 ([plan task](../../repo/plans/report.plan.md#t1--path-bytes))",
    "[spec/report.spec.md](../../repo/spec/report.spec.md)",
    "[designs/report.design.md](../../repo/designs/report.design.md)",
  ]) {
    assert.ok(rendered.includes(expected), expected);
  }

  assert.doesNotMatch(
    rendered,
    /Copied explanation|Copied behaviour|Plan diagram content/u
  );

  const noDesign = renderWalkthrough(
    view({
      repositoryRoot: "/repo",
      glance: { what: "Done", how: "", visuals: "" },
      visuals: "Design visual",
    }),
    "/sessions/run"
  );

  assert.doesNotMatch(noDesign, /\[design\]\(/u);

  const replacement = renderWalkthrough(
    view({
      focus: { visual: "Replacement visual" },
      glance: { what: "Done", how: "", visuals: "Original visual" },
    })
  );

  assert.match(replacement, /Replacement visual/u);
  assert.doesNotMatch(replacement, /Original visual/u);

  const designVisual = renderWalkthrough(
    view({
      designPath: "designs/report.design.md",
      visuals: "Design visual",
      glance: { what: "Done", how: "", visuals: "" },
    })
  );

  assert.match(
    designVisual,
    /\[design visuals\]\(designs\/report.design.md#at-a-glance\)/u
  );
});

test("walkthrough fixture render stays below its pre-link byte size", () => {
  const bytes = Buffer.byteLength(
    renderWalkthrough(linkFixture(), "/sessions/run")
  );

  assert.ok(bytes < 2910, `render bytes: ${bytes}`);
});
