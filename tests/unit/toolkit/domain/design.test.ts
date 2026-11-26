import assert from "node:assert/strict";
import { test } from "node:test";

import {
  asParsedDesign,
  designScopeGrew,
  governedDesignText,
  parseDesign,
  validateApproachRequirements,
} from "../../../../skills/dispatch/scripts/toolkit/domain/design.ts";
import {
  validateSpecTraceability,
  validateDesignTraceability,
} from "../../../../skills/dispatch/scripts/toolkit/domain/plan.ts";
import type {
  LintDefect,
  ParsedPlan,
} from "../../../../skills/dispatch/scripts/toolkit/domain/types.ts";
import { defined } from "../../../helpers/guards.ts";

const hasDefects = (
  result: ReturnType<typeof parseDesign>
): result is ReturnType<typeof parseDesign> & { defects: LintDefect[] } =>
  "defects" in result;

const detail = (id: string) => `### ${id} Step
- ${id} behaviour is implemented.
<details>

- Outcome: ${id} outcome delivered
- Scope: src/${id}.ts
- Non-scope: other modules
- Observable behavior: ${id} observable
- Affected contracts: ${id} contract
- Validation: node --test ${id}
- Rollback boundary: revert ${id}
- Parallel safety: unsafe beside others
</details>
`;

const DESIGN = `# Importer design

> **Parent:** \`governing.spec.md\` · sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> **Decide:** none
> **Risk:** med — touches ingestion
> **Increments:** 2

## At a Glance
- Stage the importer.

## Execution Status
| ID | State | Next Action |
| --- | --- | --- |
| I01 | completed | - |
| I02 | ready | implement:I02 |

Next Action: implement:I02

## Approach
REQ-1 strategy
What.

## Alternatives & Decisions
Chosen.

## Risks, Security & Operations
Risks.

## Architecture & Boundaries
How.

## Increment Dependency Graph
| ID | Priority | Summary | Prerequisites | Paths |
| --- | --- | --- | --- | --- |
| I01 | 1 | Parser | none | src/parse.ts |
| I02 | 2 | Loader | I01 | src/load.ts, src/db.ts |

## Increment Details
${detail("I01")}
${detail("I02")}
## Final Integration
Run everything.

## Review Findings & Resolutions
*No reviews conducted yet.*
`;

const codes = (source: string) => {
  const result = parseDesign(source);

  const defects = !result.ok && hasDefects(result) ? result.defects : [];

  return [...defects, ...("warnings" in result ? result.warnings : [])].map(
    (item) => item.code
  );
};

const designResult = parseDesign(DESIGN);

assert.ok(designResult.ok);

const { design } = designResult;

test("design increments parse behaviour bullets and warn on missing or file-count-only behaviour", () => {
  const source = DESIGN.replace(
    "<details>\n\n- Outcome",
    "<details>\n\n<summary>Hidden increment details</summary>\n\n- Outcome"
  );

  const result = parseDesign(source);
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(
    result.design.increments.map((row) => row.behaviour),
    [["I01 behaviour is implemented."], ["I02 behaviour is implemented."]]
  );
  assert.ok(
    !result.warnings.some((item) => item.code === "increment-behaviour")
  );

  const sources = [
    DESIGN.replace("- I01 behaviour is implemented.\n", ""),
    DESIGN.replace("- I01 behaviour is implemented.", "- 2 modified files."),
  ];

  for (const missing of sources) {
    const warned = parseDesign(missing);
    assert.ok(warned.ok, JSON.stringify(warned));
    assert.ok(
      warned.warnings.some((item) => item.code === "increment-behaviour"),
      JSON.stringify(warned.warnings)
    );
  }

  const accepted = parseDesign(
    DESIGN.replace(
      "- I01 behaviour is implemented.",
      "- 2 files are compared by content before delivery."
    )
  );

  assert.ok(accepted.ok);
  assert.deepEqual(accepted.design.increments[0]?.behaviour, [
    "2 files are compared by content before delivery.",
  ]);
  assert.ok(
    !accepted.warnings.some((item) => item.code === "increment-behaviour")
  );
});

test("design presentation findings warn without blocking", () => {
  // Optional grounding leads parse; filler leads warn.
  assert.deepEqual(designResult.warnings, []);
  assert.equal(design.details["I01"]?.["Grounding leads"], undefined);
  const lead = "Can the importer reuse the existing CSV reader?";

  const withLead = DESIGN.replace(
    "</details>",
    `- Grounding leads: ${lead}\n</details>`
  );

  const result = parseDesign(withLead);
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.warnings, []);
  assert.equal(result.design.details["I01"]?.["Grounding leads"], lead);
  assert.deepEqual(codes(withLead.replace(lead, "n/a")), ["filler-note"]);

  // Presentation findings are warnings.
  const presented = parseDesign(
    DESIGN.replace("> **Increments:** 2", "> **Increments:** 3").replace(
      "REQ-1 strategy",
      "Importer strategy"
    )
  );

  assert.ok(presented.ok, JSON.stringify(presented));
  assert.deepEqual(presented.warnings.map((item) => item.code).toSorted(), [
    "missing-requirement-ref",
    "summary-label",
  ]);

  // At a Glance is required first and long paragraphs warn.
  const glance = "## At a Glance\n- Stage the importer.\n\n";
  const missing = parseDesign(DESIGN.replace(glance, ""));
  assert.ok(missing.ok);
  assert.ok(
    missing.warnings.some(
      (item) =>
        item.code === "missing-section" &&
        item.message.includes("## At a Glance") &&
        item.severity === "warning"
    )
  );

  const moved = parseDesign(
    DESIGN.replace(glance, "").replace("## Approach", `${glance}## Approach`)
  );

  assert.ok(moved.ok);
  assert.ok(
    moved.warnings.some(
      (item) => item.code === "section-order" && item.severity === "warning"
    )
  );

  const source = DESIGN.replace(
    "What.",
    `\n${new Array(61).fill("word").join(" ")}`
  );

  const long = parseDesign(source);
  assert.ok(long.ok);
  assert.deepEqual(
    long.warnings
      .filter((item) => item.code === "long-paragraph")
      .map((item) => [item.line, item.severity]),
    [
      [
        source.split("\n").findIndex((line) => line.startsWith("word ")) + 1,
        "warning",
      ],
    ]
  );
  assert.deepEqual(long.design.increments, design.increments);
  assert.ok(long.design.governedText.includes(glance.trim()));
  assert.ok(!long.design.governedText.includes("## Execution Status"));
  assert.ok(
    !long.design.governedText.includes("## Review Findings & Resolutions")
  );
});

test("design: parses graph, details, and Execution Status", () => {
  const result = parseDesign(DESIGN);
  assert.ok(result.ok, JSON.stringify(result));
  // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
  const { design } = result;
  assert.deepEqual(
    design.increments.map((row) => [row.id, row.priority, row.prerequisites]),
    [
      ["I01", 1, []],
      ["I02", 2, ["I01"]],
    ]
  );
  assert.deepEqual(design.increments[1]?.paths, ["src/load.ts", "src/db.ts"]);
  assert.equal(design.details["I02"]?.["Outcome"], "I02 outcome delivered");
  assert.deepEqual(design.executionStatus?.rows, [
    { id: "I01", state: "complete", nextAction: "-" },
    { id: "I02", state: "ready", nextAction: "implement:I02" },
  ]);
  assert.equal(design.executionStatus?.nextAction, "implement:I02");

  const quoted = parseDesign(
    DESIGN.replace("| src/parse.ts |", "| `src/parse.ts`, `src/util/` |")
  );

  assert.ok(quoted.ok);
  assert.deepEqual(defined(quoted.design.increments[0]).paths, [
    "src/parse.ts",
    "src/util/",
  ]);
});

test("design: graph cycles are rejected", () => {
  assert.ok(
    codes(
      DESIGN.replace(
        "| I01 | 1 | Parser | none |",
        "| I01 | 1 | Parser | I02 |"
      )
    ).includes("cycle")
  );
  assert.ok(
    codes(
      DESIGN.replace("| I02 | 2 | Loader | I01 |", "| I02 | 2 | Loader | I07 |")
    ).includes("missing-prerequisite")
  );
  assert.ok(
    codes(
      DESIGN.replace("> **Increments:** 2", "> **Increments:** 3")
    ).includes("summary-label")
  );
  assert.ok(
    codes(DESIGN.replace("- Rollback boundary: revert I02\n", "")).includes(
      "missing-increment-field"
    )
  );
  assert.ok(
    codes(DESIGN.replace("## Final Integration\n", "## Finale\n")).includes(
      "missing-section"
    )
  );
});

test("design: unknown execution states are rejected", () => {
  assert.ok(
    codes(DESIGN.replace("| I02 | ready |", "| I02 | pending |")).includes(
      "execution-status"
    )
  );
  assert.ok(
    codes(DESIGN.replace("Next Action: implement:I02\n", "")).includes(
      "execution-status"
    )
  );
  assert.ok(
    codes(
      DESIGN.replace(
        "| I02 | ready | implement:I02 |",
        "| I02 | ready | implement:I02 |\n| I02 | ready | again |"
      )
    ).includes("execution-status")
  );
});

test("design: governed text excludes Execution Status and the resolution section", () => {
  const governed = governedDesignText(DESIGN);
  assert.ok(!governed.includes("## Execution Status"));
  assert.ok(!governed.includes("implement:I02"));
  assert.ok(!governed.includes("## Review Findings & Resolutions"));
  assert.ok(governed.includes("## Final Integration"));
});

test("design-section-order: old order fails and new order passes", () => {
  const status = DESIGN.slice(
    DESIGN.indexOf("## Execution Status"),
    DESIGN.indexOf("## Approach")
  );

  const architecture = DESIGN.slice(
    DESIGN.indexOf("## Architecture & Boundaries"),
    DESIGN.indexOf("## Increment Dependency Graph")
  );

  const oldOrder = DESIGN.replace(status, "")
    .replace(architecture, "")
    .replace(
      "## Alternatives & Decisions",
      `${architecture}## Alternatives & Decisions`
    )
    .replace("## Review Findings", `${status}## Review Findings`);

  const result = parseDesign(oldOrder);

  const defects = result.warnings.filter(
    (item) => item.code === "section-order"
  );

  const lines = oldOrder.split("\n");
  assert.deepEqual(
    defects.map((item) => item.line),
    [
      "## Alternatives & Decisions",
      "## Risks, Security & Operations",
      "## Execution Status",
    ].map((heading) => lines.indexOf(heading) + 1)
  );
  assert.match(
    defects[0]?.message ?? "",
    /Move "## Alternatives & Decisions" before "## Architecture & Boundaries"/u
  );
  assert.ok(parseDesign(DESIGN).ok);
});

const assertInvalidDesign = (payload: unknown) => {
  assert.equal(asParsedDesign(payload), null);
};

test("journal design admission rejects malformed objectives and dependency graphs", () => {
  assert.ok(asParsedDesign(design));
  const rows = design.increments;
  assertInvalidDesign({ ...design, box: { Parent: 1 } });
  assertInvalidDesign({
    ...design,
    increments: [{ ...defined(rows[0]), paths: [] }, defined(rows[1])],
  });
  assertInvalidDesign({
    ...design,
    increments: [defined(rows[0]), { ...defined(rows[1]), id: "I01" }],
  });
  assertInvalidDesign({
    ...design,
    increments: [defined(rows[0]), { ...defined(rows[1]), priority: 1 }],
  });
  assertInvalidDesign({
    ...design,
    increments: [
      { ...defined(rows[0]), prerequisites: ["I99"] },
      defined(rows[1]),
    ],
  });
  assertInvalidDesign({
    ...design,
    increments: [
      { ...defined(rows[0]), prerequisites: ["I02"] },
      defined(rows[1]),
    ],
  });
  assertInvalidDesign({ ...design, increments: [defined(rows[1])] });
  assertInvalidDesign({
    ...design,
    increments: [
      { ...defined(rows[0]), behaviour: undefined },
      defined(rows[1]),
    ],
  });
  assertInvalidDesign({
    ...design,
    increments: [
      { ...defined(rows[0]), behaviour: ["I01 outcome", 4] },
      defined(rows[1]),
    ],
  });
});

test("designScopeGrew compares validation case-insensitively", () => {
  const before = {
    ...design,
    details: {
      I01: { Outcome: "First behavior", validation: "npm test -- a" },
      I02: { Outcome: "Second behavior" },
    },
  };

  const sameCased = {
    ...design,
    details: {
      I01: { Outcome: "First behavior", Validation: "npm test -- a" },
      I02: { Outcome: "Second behavior" },
    },
  };

  const changedVal = {
    ...design,
    details: {
      I01: { Outcome: "First behavior", Validation: "npm test -- a and b" },
      I02: { Outcome: "Second behavior" },
    },
  };

  assert.equal(designScopeGrew(before, sameCased), false);
  assert.equal(designScopeGrew(before, changedVal), true);
});

const layeredDesign = () =>
  DESIGN.replace(
    /## Approach[\s\S]*?(?=## Alternatives)/u,
    "## Approach\nREQ-1 importer\n\n"
  );

test("design summary: Parent rejects invalid pins", () => {
  assert.ok(parseDesign(layeredDesign()).ok);

  for (const parent of [
    "user request",
    `\`notes.txt\` · sha256:${"a".repeat(64)}`,
    `governing.spec.md · sha256:${"a".repeat(64)}`,
    "`governing.design.md` · I01",
  ]) {
    assert.ok(
      codes(
        layeredDesign().replace(/`governing.spec.md` · sha256:a{64}/u, parent)
      ).includes("summary-label"),
      parent
    );
  }
});

const hash = `sha256:${"a".repeat(64)}`;

const binding = {
  path: "importer.design.md",
  revision: hash,
  increment: "I01",
  contract: { Outcome: "First behavior" },
  paths: ["src/a.ts"],
};

const makePlan = (overrides: Partial<ParsedPlan>) => ({
  title: null,
  box: {},
  glance: null,
  keyDecisions: [],
  criteria: [],
  tasks: [],
  changes: [],
  verification: { automated: [], none: null, manual: [] },
  seams: [],
  warnings: [],
  traceability: null,
  governedText: "",
  planIds: [],
  sharedContext: "",
  ...overrides,
});

const change = (file: string) => ({
  action: "MODIFY" as const,
  path: file,
  note: "",
  command: null,
  line: 1,
});

test("design traceability rejects stale revision and wrong increment", () => {
  const plan = makePlan({
    traceability: {
      Design: binding.path,
      Revision: hash,
      Increment: "I01",
      Outcome: "First behavior",
    },
  });

  assert.deepEqual(validateDesignTraceability(plan, binding), []);
  assert.ok(
    validateDesignTraceability(plan, { ...binding, increment: "I02" }).length
  );
  assert.ok(
    validateDesignTraceability(plan, {
      ...binding,
      revision: `sha256:${"b".repeat(64)}`,
    }).length
  );
});

const plan = (file: string) =>
  makePlan({
    traceability: {
      Design: binding.path,
      Revision: hash,
      Increment: "I01",
      Outcome: "First behavior",
    },
    changes: [change(file)],
  });

test("traceability scope admits directory and glob forms while rejecting escapes and sibling prefixes", () => {
  for (const [scope, allowed, denied] of [
    ["src/a.ts", "src/a.ts", "src/b.ts"],
    ["src/", "src/deep/a.ts", "src-other/a.ts"],
    ["src/**", "src/deep/a.ts", "src-other/a.ts"],
    ["src/*.ts", "src/a.ts", "src/deep/a.ts"],
    ["src/**/*.ts", "src/a.ts", "src/deep/a.js"],
    ["src/{a,b}.ts", "src/b.ts", "src/c.ts"],
  ]) {
    const scoped = { ...binding, paths: [defined(scope)] };
    assert.deepEqual(
      validateDesignTraceability(plan(defined(allowed)), scoped),
      []
    );
    assert.match(
      validateDesignTraceability(plan(defined(denied)), scoped).join(";"),
      /outside increment/u
    );
    assert.match(
      validateDesignTraceability(plan("src/../caller.ts"), scoped).join(";"),
      /outside increment/u
    );
  }
});

test("template traceability binds Parent path, revision, increment, contract and owned changes", () => {
  // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
  const plan = makePlan({
    box: { Parent: `\`${binding.path}\` · I01` },
    traceability: {
      "Approved revision": hash,
      "Increment ID and inherited contract": "I01 — First behavior",
      "Prerequisite evidence": "None",
      "Acceptance mapping": "src/a.ts → SC1",
    },
    changes: [change("src/a.ts")],
  });

  assert.deepEqual(validateDesignTraceability(plan, binding), []);

  for (const other of [
    { ...binding, path: "other.design.md" },
    { ...binding, revision: `sha256:${"b".repeat(64)}` },
    { ...binding, increment: "I02" },
    { ...binding, contract: { Outcome: "Other behavior" } },
    { ...binding, paths: ["src/b.ts"] },
  ]) {
    assert.ok(validateDesignTraceability(plan, other).length);
  }
});

const requirements = ["REQ-1", "REQ-2", "REQ-3"];

const tracedPlan = (ids: string[]) =>
  makePlan({
    criteria: [
      {
        id: "SC1",
        title: "Criterion 1",
        line: 12,
        satisfies: ids,
        changes: [],
        tests: [],
        verify: [],
        evidence: null,
        preExisting: null,
        redException: null,
        red: null,
        review: null,
        enforcementInfeasibility: null,
      },
    ],
  });

test("requirement references reject unknown requirements and report unsatisfied coverage", () => {
  assert.deepEqual(
    validateSpecTraceability(tracedPlan(requirements), requirements),
    []
  );
  const unknown = validateSpecTraceability(tracedPlan(["REQ-9"]), requirements);
  assert.deepEqual(
    unknown
      .filter((item) => item.code === "unknown-requirement")
      .map((item) => item.severity),
    ["warning"]
  );
  assert.match(defined(unknown[0]).message, /REQ-9/u);
  const uncited = validateSpecTraceability(tracedPlan(["REQ-1"]), requirements);
  assert.deepEqual(
    uncited.map((item) => [item.code, item.severity]),
    [
      ["unsatisfied-requirement", "warning"],
      ["unsatisfied-requirement", "warning"],
    ]
  );
  assert.match(defined(uncited[0]).message, /REQ-2/u);
  assert.match(defined(uncited[1]).message, /REQ-3/u);

  const defects = validateApproachRequirements(
    { ...design, approachRequirements: ["REQ-1", "REQ-9"] },
    requirements
  );

  assert.deepEqual(
    defects.map((item) => [item.code, item.severity]),
    [["unknown-requirement", "warning"]]
  );
  assert.match(defined(defects[0]).message, /REQ-9/u);
});
