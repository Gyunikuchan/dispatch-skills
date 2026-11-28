import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  askPrompt,
  assembleTemplate,
  extractDocumentLayers,
  extractTemplate,
  fillTemplate,
  qualityBar,
  qualityCriteria,
  qualitySections,
  settledSection,
} from "../../../../skills/dispatch/scripts/toolkit/domain/prompt.ts";
import type {
  QualityConsumer,
  Settled,
} from "../../../../skills/dispatch/scripts/toolkit/domain/prompt.ts";
import {
  confirmationPrompt,
  reviewPrompt,
} from "../../../../skills/dispatch/scripts/toolkit/prompts.ts";
import { REVIEW_PROMPT_INPUTS } from "../../../fixtures/review-prompt-inputs.ts";
import { defined } from "../../../helpers/guards.ts";
import {
  flag,
  listOf,
  narrow,
  optional,
  readJson,
  withFields,
  text,
} from "../helpers/json.ts";

const settledRows = (section: string) =>
  section.split("\n").filter((line) => line.startsWith("- "));

const rawConsumer = (value: string) =>
  narrow(
    value,
    (candidate): candidate is QualityConsumer => typeof candidate === "string"
  );

function gcd(left: number, right: number) {
  let a = left;
  let b = right;

  while (b) {
    [a, b] = [b, a % b];
  }

  return a;
}

function compliantBar() {
  return [
    "## shared",
    "<!-- for: all -->",
    "- Host rule files: host rules.",
    "<!-- for: all -->",
    "- Precedence: precedence.",
    "<!-- for: all -->",
    "- Evidence: evidence.",
    "<!-- for: writer,cleanup,verifier -->",
    "- Report host-rule/brief conflicts under concerns or limits.",
    "<!-- for: code,plan,design -->",
    "- Exclude host-rule/brief conflicts from findings.",
    "<!-- for: writer,cleanup -->",
    "- Run no Git write commands (add, stash, commit, checkout, reset, restore).",
    "- Untagged shared. Check [document layers](../spec-stage.md#readers-and-document-layers); cite upstream IDs, not earlier layers. tail.",
    "<!-- for: author -->",
    "- Author-only: never rendered.",
    "## spec",
    "- Spec rule.",
    "## code",
    "- Code rule.",
    "## testing",
    "<!-- for: writer -->",
    "- Writer focus.",
    "<!-- for: code,plan,design,cleanup -->",
    "- Prune: prune.",
    "- Untagged testing.",
    "## plan",
    "- Plan rule.",
    "## design",
    "- Design rule.",
  ].join("\n");
}

function removeSection(bar: string, section: string) {
  const lines = bar.split("\n");
  const out: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const heading = /^##\s+(?<g2>\S.*?)\s*$/u.exec(line)?.[1];

    if ((heading ?? "").length > 0) {
      skipping = heading === section;
    }

    if (!skipping) {
      out.push(line);
    }
  }

  return out.join("\n");
}

function emptySection(bar: string, section: string) {
  const lines = bar.split("\n");
  const out: string[] = [];
  let inside = false;

  for (const line of lines) {
    const heading = /^##\s+(?<g3>\S.*?)\s*$/u.exec(line)?.[1];

    if ((heading ?? "").length > 0) {
      inside = heading === section;
      out.push(line);
      continue;
    }

    if (inside) {
      continue;
    }

    out.push(line);
  }

  return out.join("\n");
}

function fencedBar() {
  return [
    "## shared",
    "<!-- for: all -->",
    "- Host rule files: host rules.",
    "<!-- for: all -->",
    "- Precedence: precedence.",
    "<!-- for: all -->",
    "- Evidence: evidence.",
    "<!-- for: writer,cleanup,verifier -->",
    "- Report host-rule/brief conflicts under concerns or limits.",
    "<!-- for: code,plan,design -->",
    "- Exclude host-rule/brief conflicts from findings.",
    "<!-- for: writer,cleanup -->",
    "- Run no Git write commands (add, stash, commit, checkout, reset, restore).",
    "- Untagged shared. Check [document layers](../spec-stage.md#readers-and-document-layers); cite upstream IDs, not earlier layers. tail.",
    "## code",
    "```markdown",
    "## code",
    "fenced",
    "```",
    "real",
    "## testing",
    "<!-- for: writer -->",
    "- Writer focus.",
    "<!-- for: code,plan,design,cleanup -->",
    "- Prune: prune.",
    "- Untagged testing.",
  ].join("\n");
}

test("settled rows render accepted, duplicate, rejected and unconfirmed rulings", () => {
  const pending = {
    id: "R1-F001",
    locus: "§ Work",
    defect: "Unbounded writes",
    ruling: "rejected",
    reason: "Writes have a bound",
    severity: "MUST",
  };

  assert.equal(settledSection([pending]), "");
  assert.match(
    settledSection([{ ...pending, rejectionConfirmed: true }]),
    /Settled in earlier rounds/u
  );
  assert.match(
    settledSection([{ ...pending, severity: "SHOULD" }]),
    /R1-F001/u
  );

  // Accepted rows show the ruling rationale; rows accepted since the previous round are marked new.
  const accepted = {
    id: "R3-F001",
    locus: "§ Tasks",
    defect: "First line of the defect.\nSecond line elaborates.",
    ruling: "accepted",
    reason: "Applied the fix in the reworked section.",
  };

  assert.deepEqual(settledRows(settledSection([accepted])), [
    "- R3-F001 § Tasks: First line of the defect. — accepted: Applied the fix in the reworked section.",
  ]);

  const clipped = {
    ...accepted,
    id: "R3-F002",
    defect: `${"x".repeat(130)}\nmore`,
  };

  assert.deepEqual(settledRows(settledSection([clipped])), [
    `- R3-F002 § Tasks: ${"x".repeat(119)}… — accepted: Applied the fix in the reworked section.`,
  ]);
  assert.match(
    settledSection([{ ...accepted, revision: "abc1234" }], true),
    /— accepted: Applied the fix in the reworked section\. \(reviewed revision abc1234\)$/mu
  );
  assert.match(
    settledSection([{ ...accepted, reason: `${"r".repeat(130)}\nignored` }]),
    new RegExp(`accepted: ${"r".repeat(119)}…`, "u")
  );
  assert.deepEqual(
    settledRows(
      settledSection(
        [{ ...accepted, reason: "" }],
        false,
        new Set([accepted.id])
      )
    ),
    ["- R3-F001 § Tasks: First line of the defect. — accepted (new)"]
  );

  const older: Settled = {
    id: "R1-F001",
    locus: "§ Scope",
    defect: "Older accepted defect.",
    ruling: "accepted",
    reason: "Fixed earlier",
  };

  const fresh: Settled = {
    id: "R2-F001",
    locus: "§ Tasks",
    defect: "Step order skips lint",
    ruling: "accepted",
    reason: "Fixed now",
  };

  const freshMust: Settled = {
    id: "R2-F002",
    locus: "§ Guard",
    severity: "MUST",
    defect: `${"m".repeat(130)}\nKeep full MUST detail.`,
    ruling: "accepted",
    reason: "Fixed guard",
  };

  const rendered = settledSection(
    [older, fresh, freshMust],
    false,
    new Set(["R2-F001", "R2-F002"])
  );

  assert.ok(
    rendered.includes(
      "- R1-F001 § Scope: Older accepted defect. — accepted: Fixed earlier\n"
    ),
    "older accepted row omits (new)"
  );
  assert.ok(
    rendered.includes(
      "- R2-F001 § Tasks: Step order skips lint — accepted (new): Fixed now\n"
    ),
    "accepted-since row marked (new)"
  );
  assert.ok(
    rendered.includes(
      `- R2-F002 § Guard: ${"m".repeat(130)}\nKeep full MUST detail. — accepted (new): Fixed guard\n`
    ),
    "accepted MUST keeps full defect and (new)"
  );

  const prompt = reviewPrompt("plan", {
    ...reviewContext("plan"),
    round: 2,
    settled: [older, fresh],
    interRound: {
      diff: "inter-round.diff",
      accepted: [{ id: "R2-F001", locus: "§ Tasks" }],
    },
  });

  assert.ok(
    prompt.includes(
      "- R1-F001 § Scope: Older accepted defect. — accepted: Fixed earlier\n"
    )
  );
  assert.ok(
    prompt.includes(
      "- R2-F001 § Tasks: Step order skips lint — accepted (new): Fixed now\n"
    )
  );
  assert.ok(
    prompt.includes(
      "### Since the previous round\nInter-round diff: inter-round.diff\n"
    )
  );
  assert.doesNotMatch(prompt, /Check these accepted-finding loci/u);

  // Duplicate rows resolve the original finding id or keep the reason.
  const duplicate = {
    id: "R4-F002",
    locus: "§ Tasks",
    defect: "A repeated defect.",
    ruling: "duplicate",
    reason: "Duplicate of R1-F004.",
  };

  assert.deepEqual(settledRows(settledSection([duplicate])), [
    "- R4-F002 § Tasks — duplicate of R1-F004",
  ]);

  for (const [id, reason, expected, absent] of [
    [
      "R4-F004",
      `R4-F004 repeats the point. ${"z".repeat(130)} R1-F004`,
      "- R4-F004 § Tasks — duplicate of R1-F004",
      undefined,
    ],
    [
      "R4-F005",
      `${"z".repeat(130)} Duplicate of R1-F006`,
      "- R4-F005 § Tasks — duplicate of R1-F006",
      undefined,
    ],
    [
      "R4-F007",
      `Duplicate of R1-F004. ${"z".repeat(130)} R2-F005`,
      "- R4-F007 § Tasks — duplicate of R1-F004",
      /R2-F005/u,
    ],
    [
      "R4-F008",
      `Duplicate of R4-F008. ${"z".repeat(130)} R1-F006`,
      "- R4-F008 § Tasks — duplicate of R1-F006",
      undefined,
    ],
    [
      "R4-F009",
      `Duplicate of R1-F001 ${"z".repeat(110)} R2-F009`,
      "- R4-F009 § Tasks — duplicate of R1-F001",
      /R2-F009/u,
    ],
  ] as const) {
    const row = defined(
      settledRows(
        settledSection([
          {
            id,
            locus: "§ Tasks",
            defect: "A repeated defect.",
            ruling: "duplicate",
            reason,
          },
        ])
      )[0]
    );

    assert.equal(row, expected, id);

    if (absent) {
      assert.doesNotMatch(row, absent, id);
    }
  }

  assert.deepEqual(
    settledRows(
      settledSection([
        {
          id: "R4-F006",
          locus: "§ Tasks",
          defect: "A repeated defect.",
          ruling: "duplicate",
          reason: "No original id.",
        },
      ])
    ),
    ["- R4-F006 § Tasks — duplicate: No original id."]
  );
  assert.deepEqual(
    settledRows(
      settledSection([
        {
          id: "R4-F003",
          locus: "§ Tasks",
          defect: "A repeated defect.",
          ruling: "duplicate",
          reason: "z".repeat(140),
        },
      ])
    ),
    [`- R4-F003 § Tasks — duplicate: ${"z".repeat(119)}…`]
  );
  assert.deepEqual(
    settledRows(
      settledSection([
        {
          id: "R4-F010",
          locus: "§ Tasks",
          defect: "A repeated defect.",
          ruling: "duplicate",
          reason: "Duplicate of R4-F010.",
        },
      ])
    ),
    ["- R4-F010 § Tasks — duplicate: Duplicate of R4-F010."]
  );

  // Rejected and deferred rows keep the full rationale text.
  const rejected = {
    id: "R1-F003",
    locus: "§ T2",
    defect: "Full defect text\nwith a second line.",
    ruling: "rejected",
    reason: "Full rationale that explains the rejection.",
  };

  const deferred = {
    ...rejected,
    id: "R1-F004",
    defect: "Deferred defect.",
    ruling: "deferred",
    reason: "Deferred as a follow-up.",
  };

  const section = settledSection([rejected, deferred]);

  for (const entry of [rejected, deferred]) {
    assert.ok(
      section.includes(
        `- ${entry.id} ${entry.locus}: ${entry.defect} — ${entry.ruling}: ${entry.reason}`
      ),
      entry.id
    );
  }

  assert.ok(!section.includes("…"), "ruled rows keep the full text");
});

// Rendered size of this fixture under the pre-compaction row format, recorded before the format changed.
const SETTLED_ROUND_7_BASELINE_BYTES = 25_570;

test("settled section stays within its round-7 budget", () => {
  const settled: Settled[] = readJson(
    fileURLToPath(new URL("fixtures/settled-round-7.json", import.meta.url)),
    listOf(
      withFields({
        id: text,
        locus: text,
        defect: text,
        ruling: text,
        reason: text,
        revision: optional(text),
        severity: optional(text),
        rejectionConfirmed: optional(flag),
      })
    )
  ).map((row) => {
    const entry: Settled = {
      id: row.id,
      locus: row.locus,
      defect: row.defect,
      ruling: row.ruling,
      reason: row.reason,
    };

    if (row.revision !== undefined) {
      entry.revision = row.revision;
    }

    if (row.severity !== undefined) {
      entry.severity = row.severity;
    }

    if (row.rejectionConfirmed !== undefined) {
      entry.rejectionConfirmed = row.rejectionConfirmed;
    }

    return entry;
  });

  assert.equal(settled.length, 49, "fixture keeps the recorded settled set");
  const bytes = Buffer.byteLength(settledSection(settled), "utf-8");
  // Accepted ruling rationales add bytes to the compact settled rows.
  assert.ok(
    bytes <= 16_500 && bytes < SETTLED_ROUND_7_BASELINE_BYTES,
    `${bytes} B exceeds the round-7 budget`
  );
});

const DECISION = {
  id: "ceiling:plan-x.plan:4",
  summary: "re-author: Keep the compact stdout line",
  quote: "approve",
};

const DECISION_ROW =
  '- ceiling:plan-x.plan:4 — user decision: re-author: Keep the compact stdout line — quote: "approve"';

const CLOSED =
  "Listed user decisions are closed; re-raise one only with evidence that was not available when the user decided.";

const confirmation = (settled?: readonly (typeof DECISION)[]) =>
  confirmationPrompt("plan", {
    spec: { path: "mission.spec.md", hash: `sha256:${"a".repeat(64)}` },
    artifact: "work.plan.md",
    target: { base: "b".repeat(40), head: "c".repeat(40) },
    scope: "Re-review round 2 (confirmation-only)",
    requests: [],
    ...(settled && { settled }),
  });

test("user decision: settled rows render the resolution summary and quote after ruling rows", () => {
  const ruling = {
    id: "R1-F001",
    locus: "§ Work",
    defect: "Unbounded writes",
    ruling: "accepted",
    reason: "Bounded",
  };

  assert.deepEqual(settledRows(settledSection([ruling, DECISION])), [
    "- R1-F001 § Work: Unbounded writes — accepted: Bounded",
    DECISION_ROW,
  ]);
});

test("user decision: summary and quote keep only their first line, clipped to 120 characters", () => {
  const decision = {
    id: "recurrence:plan-x.plan:R2-F001:g1",
    summary: "s".repeat(130),
    quote: `${"q".repeat(130)}\n- R9-F009 forged row`,
  };

  assert.deepEqual(settledRows(settledSection([decision])), [
    `- recurrence:plan-x.plan:R2-F001:g1 — user decision: ${"s".repeat(119)}… — quote: "${"q".repeat(119)}…"`,
  ]);
});

test("user decision: confirmation prompt lists decisions before inspection and stays unchanged without them", () => {
  const plain = confirmation();
  assert.doesNotMatch(
    plain,
    /Settled in earlier rounds|Listed user decisions/u
  );
  assert.equal(confirmation([]), plain);
  assert.ok(
    confirmation([DECISION]).includes(
      `### Settled in earlier rounds\n${DECISION_ROW}\n${CLOSED}\n\n### Inspection`
    )
  );
});

const templates = new URL(
  "../../../../skills/dispatch/references/templates/",
  import.meta.url
);

const golden = new URL(
  "../../../fixtures/review-prompt-golden/",
  import.meta.url
);

const read = (base: URL, name: string) =>
  readFileSync(new URL(name, base), "utf-8");

const specStage = read(templates, "../spec-stage.md");

const shared = (kind: QualityConsumer) => [
  qualityBar(read(templates, "quality-bar.md"), kind, 0, specStage),
  read(templates, "review-severity.md"),
  "## rereview\n",
  "## preregister\n",
];

test("prompt fill validates declared values single-pass", () => {
  assert.throws(
    () => fillTemplate("<A> <B>", ["A", "B"], { A: "1" }),
    /Missing value\(s\) for declared variable\(s\): B/u
  );
  assert.throws(
    () => fillTemplate("<A>", ["A"], { A: "1", C: "3" }),
    /Unknown variable\(s\).*C/u
  );
  assert.equal(
    fillTemplate("<A> at <file>:L<line> tag <tag>", ["A"], { A: "<A> <tag>" }),
    "<A> <tag> at <file>:L<line> tag <tag>"
  );
});

test("prompt: declared variables and body are extracted from the Markdown template", () => {
  const { variables, template } = extractTemplate(
    "# X\n\n## Prompt template\n- `<Name>` — who\n````markdown\nHi <Name>\n````\n"
  );

  assert.deepEqual(variables, ["Name"]);
  assert.equal(fillTemplate(template, variables, { Name: "Ada" }), "Hi Ada");
});

test("assembles prompt matching golden per review kind; design reviewer prompt asks contracts to name input producers", () => {
  const frame = read(templates, "review-prompt.md");

  const standardsRule =
    "Report host-rule violations on changed lines or sections as `standards`; elsewhere, report them as `adjacent`.";

  const specRouting =
    "Report unmet or contradicted intent as `intent` and a defect in the governing spec text as `spec` (locus `§ Spec: <heading>`), before other tags.";

  const reuseCitation =
    "Anchor reuse findings on the new symbol and cite the existing equivalent as `path:L<line>` in `defect`";

  const codeSpecCitation =
    "Anchor a code `spec` finding on the changed code line and cite `§ Spec: <heading>` in `defect`";

  const inputProducerClause =
    "Each new contract names the existing code that produces each input it reads.";

  for (const kind of ["code", "design", "plan"] as const) {
    const { variables, template } = assembleTemplate(
      frame,
      read(templates, `review-prompt-${kind}.md`),
      undefined,
      shared(kind)
    );

    assert.equal(
      `${fillTemplate(template, variables, REVIEW_PROMPT_INPUTS[kind])}\n`,
      read(golden, `${kind}.md`),
      kind
    );

    const prompt = fillTemplate(
      template,
      variables,
      REVIEW_PROMPT_INPUTS[kind]
    );

    assert.equal(
      reviewPrompt(kind, reviewContext(kind)).includes(inputProducerClause),
      kind === "design",
      kind
    );
    assert.match(prompt, /Read the whole spec/u);
    assert.doesNotMatch(prompt, /\]\(quality-bar\.md/u, kind);
    assert.ok(
      prompt.includes(defined(REVIEW_PROMPT_INPUTS[kind]["Spec Hash"]))
    );
    assert.equal(
      prompt.split(standardsRule).length - 1,
      1,
      `${kind}: standards rule`
    );
    assert.match(
      prompt,
      /A reviewer may run a host read tool that creates or updates only its own cache or index/u
    );
    assert.doesNotMatch(prompt, /A native reviewer/u);
    assert.equal(
      prompt.split("Read directly; launch no subagents.").length - 1,
      1,
      `${kind}: reviewer subagent bar`
    );
    assert.doesNotMatch(prompt, /delegation already permitted/u, kind);

    if (kind === "code") {
      const against = defined(
        defined(
          read(templates, "review-prompt-code.md").split(/^## against$/mu)[1]
        ).split(/^## inspection$/mu)[0]
      );

      assert.ok(against.includes(reuseCitation));
      assert.ok(against.includes(codeSpecCitation));
      assert.ok(prompt.includes(reuseCitation));
      assert.ok(prompt.includes(codeSpecCitation));
    } else {
      assert.ok(prompt.includes(specRouting), kind);
      assert.match(prompt, /§ Spec: <heading>/u);
    }
  }
});

const reviewKinds = ["code", "plan", "design"] as const;

const familyOrder = {
  shared: [
    "intent",
    "maintainability",
    "correctness",
    "reliability",
    "security",
    "performance",
    "compatibility",
    "operability",
    "usability",
  ],
  spec: ["spec"],
  code: ["spec"],
  testing: ["testing"],
  plan: ["architecture", "decomposition"],
  design: ["architecture", "testing", "decomposition"],
} as const;

const rotateExpected = <T>(items: readonly T[], by: number) => {
  const shift = items.length
    ? ((by % items.length) + items.length) % items.length
    : 0;

  return [...items.slice(shift), ...items.slice(0, shift)];
};

const reviewContext = (kind: (typeof reviewKinds)[number], rotation = 0) => ({
  skillRoot: path.resolve("skills/dispatch"),
  spec: {
    path: defined(REVIEW_PROMPT_INPUTS[kind]["Spec Path"]),
    hash: defined(REVIEW_PROMPT_INPUTS[kind]["Spec Hash"]),
  },
  artifact: defined(
    REVIEW_PROMPT_INPUTS[kind][kind === "design" ? "Design Path" : "Plan Path"]
  ),
  ...(kind === "code" && {
    planPath: defined(REVIEW_PROMPT_INPUTS.code["Plan Path"]),
    taskSummary: defined(REVIEW_PROMPT_INPUTS.code["Task Summary"]),
  }),
  scope: defined(REVIEW_PROMPT_INPUTS[kind]["Review Scope"]),
  turnTarget: 10,
  rotation,
  round: 1,
});

const familyBullets = (prompt: string) =>
  [...prompt.matchAll(/^- \*\*(?<g1>[^*]+)\*\* —/gmu)].map((match) =>
    defined(match[1])
  );

const linePositions = (prompt: string, marker: string) =>
  prompt
    .split("\n")
    .flatMap((line, index) => (line.includes(marker) ? [index] : []));

test("review voices receive identical guidance in rotated axis order", () => {
  const sharedFixedLines = [
    "Precedence: Applicable host rule files govern first.",
    "- Exclude host-rule/brief conflicts from findings.",
    "- Altitude: check document layers (",
  ];

  for (const kind of reviewKinds) {
    const base = reviewPrompt(kind, reviewContext(kind));

    const tagsSection = defined(
      defined(base.split("### Tags\n")[1]).split("\n### ")[0]
    )
      .trim()
      .split("\n");

    assert.equal(tagsSection.length, 1, `${kind}: one Tags line`);

    const fixedLines = [
      ...sharedFixedLines,
      ...(kind === "code" || kind === "plan"
        ? [
            "- Tooling: skip issues that configured linters, formatters, or type checkers enforce.",
          ]
        : []),
      ...(kind === "plan"
        ? [
            "- Shared criteria: apply the shared section to proposed changes and touched interfaces at planning altitude; do not require written implementation.",
          ]
        : []),
      ...(kind === "design" ? ["- Shared criteria:"] : []),
      ...(kind === "plan" || kind === "design"
        ? ["- Visuals, summaries, and callouts:"]
        : []),
    ];

    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
    const familySections = qualitySections[
      kind
    ] as readonly (keyof typeof familyOrder)[];

    const familyCounts = familySections.map(
      (section) => familyOrder[section].length
    );

    const cycle = familyCounts.reduce<number>(
      (left, right) => (left / gcd(left, right)) * right,
      1
    );

    for (const rotation of [0, 1, 2, cycle]) {
      const prompt = reviewPrompt(kind, reviewContext(kind, rotation));
      const actualFamilies = familyBullets(prompt);
      let offset = 0;

      for (let index = 0; index < familySections.length; index += 1) {
        const section = defined(familySections[index]);
        const count = defined(familyCounts[index]);
        assert.deepEqual(
          actualFamilies.slice(offset, offset + count),
          rotateExpected(familyOrder[section], rotation),
          `${kind}: ${section} at rotation ${rotation}`
        );
        offset += count;
      }

      assert.deepEqual(
        prompt.split("\n").toSorted(),
        base.split("\n").toSorted(),
        `${kind}: line multiset at rotation ${rotation}`
      );

      for (const marker of fixedLines) {
        const positions = linePositions(base, marker);
        assert.ok(positions.length, `${kind}: missing fixed line ${marker}`);
        assert.deepEqual(
          linePositions(prompt, marker),
          positions,
          `${kind}: fixed line ${marker}`
        );
      }

      if (rotation === cycle) {
        assert.equal(prompt, base, `${kind}: wraparound`);
      }
    }
  }
});

test("design prompt calibrates altitude, severity, and advisory Grounding leads", () => {
  const prompt = reviewPrompt("design", reviewContext("design"));
  assert.match(
    prompt,
    /^- Shared criteria: .*design altitude.*feasibility.*file-by-file plans/mu
  );
  assert.match(prompt, /a verifiable acceptance strategy/u);
  assert.match(
    prompt,
    /Feasibility and architectural contract defects are `blocks`\.\s+Plan-level mechanics safely decidable during increment planning are out of altitude\./u
  );
  assert.match(
    prompt,
    /Grounding leads:.*advisory.*binding .*REQ.*DEC.*invariant.*known dead ends/u
  );
});

test("assembleTemplate binds slots and rejects mismatches", () => {
  const frame =
    "## Prompt template\n````markdown\n<<slot:a>> <<slot:b>>\n````\n";

  const single = "## Prompt template\n````markdown\n<<slot:a>>\n````\n";
  assert.throws(
    () => assembleTemplate(single, "## b\ntext\n"),
    /no section for slot/u
  );
  assert.throws(
    () => assembleTemplate(single, "## a\nx\n## b\ny\n"),
    /no frame slot/u
  );
  assert.throws(
    () =>
      assembleTemplate(frame, "## a\nx\n## b\ny\n", undefined, ["## b\nz\n"]),
    /declares section "b" twice/u
  );
  assert.throws(
    () =>
      assembleTemplate(frame, "## a\nx\n", undefined, [
        "## b\ny\n",
        "## b\nz\n",
      ]),
    /declares section "b" twice/u
  );

  const { variables, template } = assembleTemplate(
    "## Prompt template\n- `<A>` — frame\n````markdown\n<<slot:a>> <<slot:b>>\n````\n",
    "## a\nkind\n",
    undefined,
    ["- `<S>` — shared\n\n## b\nshared <S>\n"]
  );

  assert.equal(template, "kind shared <S>");
  assert.deepEqual(variables, ["A", "S"]);
});

// SECTION: Severity rubric

const CALIBRATION =
  "In plan reviews, `blocks` means the plan as written cannot deliver its outcome or breaks a binding constraint. A gap that the plan's own Check gates would surface deterministically during implementation, such as a fixture update or a test assertion, is `degrades`, not `blocks`.";

const assembled = (kind: QualityConsumer) =>
  assembleTemplate(
    read(templates, "review-prompt.md"),
    read(templates, `review-prompt-${kind}.md`),
    undefined,
    shared(kind)
  ).template;

const rubricBody = () =>
  defined(
    read(templates, "review-severity.md").split(/^## rubric$/mu)[1]
  ).trim();

test("all kinds share an identical severity rubric", () => {
  const rubric = rubricBody();

  for (const kind of ["code", "design", "plan"] as const) {
    const prompt = readFileSync(new URL(`${kind}.md`, golden), "utf-8");
    assert.ok(prompt.includes(rubric), `${kind}: rubric text`);

    const reply = defined(
      prompt.split("\n").find((line) => line.startsWith('{"status":"FINDINGS"'))
    );

    assert.ok(
      reply.includes(
        '"findings":[{"impact":"critical|blocks|degrades|minor","trigger":"realistic|contrived","locus"'
      ),
      kind
    );
    assert.doesNotMatch(reply, /"severity"/u, kind);
  }

  assert.ok(flat("plan").includes(CALIBRATION));

  for (const kind of ["code", "design"] as const) {
    const template = assembled(kind);
    assert.ok(
      !template.includes("Check gates") && !template.includes("<<slot:"),
      kind
    );
  }
});

// SECTION: Grounding, tooling, and reuse rules

const flat = (kind: QualityConsumer) =>
  assembled(kind).replaceAll(/\s+/gu, " ");

test("review prompts: every kind grounds findings and reports a defective local convention once", () => {
  for (const kind of ["code", "design", "plan"] as const) {
    // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
    const text = flat(kind);

    for (const rule of [
      "Ground each finding in a concrete failure scenario, a host rule, a measurable cost, or a known vulnerability class.",
      "Preference is not a finding; between technically equivalent approaches, the author's choice stands.",
      "Simplicity findings name the cost removed: concepts, files, or code paths.",
      "A pattern that matches established local convention is not a finding; when the convention itself is defective, report it once and name the other instances in `defect`.",
    ]) {
      assert.ok(text.includes(rule), `${kind}: ${rule}`);
    }
  }
});

const ruleText = (kind: QualityConsumer) =>
  qualityBar(read(templates, "quality-bar.md"), kind, 0, specStage).replaceAll(
    /\s+/gu,
    " "
  );

test("quality selection covers every consumer and includes each selected rule once", () => {
  for (const kind of ["code", "plan", "design"] as const) {
    assert.ok(
      flat(kind).includes(
        "search the repository by name and behaviour for an existing equivalent"
      )
    );
    assert.equal(
      flat(kind).includes(
        "skip issues that configured linters, formatters, or type checkers enforce."
      ),
      kind !== "design"
    );
    assert.equal(
      flat(kind).includes(
        "Anchor reuse findings on the new symbol and cite the existing equivalent as `path:L<line>` in `defect`"
      ),
      kind === "code"
    );
    assert.equal(
      flat(kind).includes("Reuse searches do not count toward the target."),
      kind === "code"
    );
  }

  for (const kind of ["code", "plan"] as const) {
    for (const term of [
      "N+1",
      "unpaginated reads",
      "index new filter or sort columns",
      "object ownership",
      "sensitive data in logs",
    ]) {
      assert.ok(ruleText(kind).includes(term), `${kind}: ${term}`);
    }
  }

  const bar = read(templates, "quality-bar.md");

  const sectionMarkers = [
    ["shared", "gold-plating"],
    ["spec", "IEEE 29148 quality"],
    ["code", "Treat ambiguous or contradictory governing text"],
    ["testing", "Unique kill"],
    ["plan", "INVEST task sizing"],
    ["design", "Weigh alternatives"],
  ] as const;

  for (const kind of ["code", "plan", "design"] as const) {
    const prompt = assembled(kind);

    const quality = defined(
      qualityBar(bar, kind, 0, specStage).split("## quality\n\n")[1]
    );

    assert.equal(prompt.split(quality).length, 2, kind);

    for (const [section, marker] of sectionMarkers) {
      assert.equal(
        prompt.split(marker).length - 1,
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
        (qualitySections[kind] as readonly string[]).includes(section) ? 1 : 0,
        `${kind}: ${section}`
      );
    }
  }
});

// SECTION: Quality bar and host-rule precedence

test("quality selection and audience filtering fail closed and hide tags", () => {
  const expected = {
    code: ["shared", "code", "testing"],
    writer: ["shared", "code", "testing"],
    plan: ["shared", "spec", "plan", "testing"],
    design: ["shared", "spec", "design"],
    cleanup: ["shared", "testing"],
    verifier: ["shared", "testing"],
    explorer: ["shared"],
  };

  assert.deepEqual(qualitySections, expected);
  const bar = compliantBar();

  const consumers: readonly QualityConsumer[] = [
    "code",
    "writer",
    "plan",
    "design",
    "cleanup",
    "verifier",
    "explorer",
  ];

  for (const consumer of consumers) {
    const rendered = qualityBar(bar, consumer, 0, specStage);
    assert.doesNotMatch(
      rendered,
      /for:/u,
      `${consumer}: no audience tag leaks`
    );
    assert.doesNotMatch(rendered, /<!--/u, `${consumer}: no comment leaks`);
  }

  for (const consumer of consumers) {
    for (const section of expected[consumer]) {
      const missingBar = removeSection(bar, section);
      assert.throws(() => qualityBar(missingBar, consumer, 0, specStage), {
        message: `Missing quality section: ${section}`,
      });
      const emptyBar = emptySection(bar, section);
      assert.throws(
        () => qualityBar(emptyBar, consumer, 0, specStage),
        /Empty quality section|Tagged bullet count/u
      );
    }
  }

  assert.throws(
    () => qualityBar(`${bar}\n## shared\nagain`, "code", 0, specStage),
    /declares section "shared" twice/u
  );

  for (const consumer of ["ask", "__proto__", "toString"]) {
    assert.throws(() => qualityBar(bar, rawConsumer(consumer), 0, specStage), {
      message: `Unknown quality consumer: ${consumer}`,
    });
  }

  assert.ok(
    qualityBar(fencedBar(), "code", 0, specStage).includes("real"),
    "fenced heading does not split sections"
  );

  const criteriaBar = compliantBar();

  for (const consumer of ["ask", "bogus", "__proto__"] as const) {
    assert.throws(
      () => qualityCriteria(criteriaBar, rawConsumer(consumer), 0, specStage),
      /Unknown quality consumer/u
    );
  }

  assert.throws(
    () =>
      qualityCriteria(
        criteriaBar.replace("<!-- for: all -->", "<!-- for: bogus -->"),
        "code",
        0,
        specStage
      ),
    /Unknown audience tag/u
  );
  assert.throws(
    () =>
      qualityCriteria(
        "## shared\n<!-- for: writer -->\n- Only writer.\n## code\n- Code.\n## testing\n- Testing.",
        "code",
        0,
        specStage
      ),
    /Empty quality section|Tagged bullet count/u
  );
  assert.throws(
    () =>
      qualityCriteria(
        "## shared\n- shared without layers link\n## code\n- Code.\n## testing\n- Testing.",
        "code",
        0,
        specStage
      ),
    /document layers|Tagged bullet count/u
  );

  const noLayers = criteriaBar.replace(
    "[document layers](../spec-stage.md#readers-and-document-layers); cite upstream IDs, not earlier layers.",
    "document layers missing."
  );

  assert.throws(
    () => qualityCriteria(noLayers, "code", 0, specStage),
    /document layers/u
  );

  const dangling = criteriaBar.replace(
    "<!-- for: writer,cleanup,verifier -->\n- Report host-rule/brief conflicts under concerns or limits.",
    "<!-- for: writer,cleanup,verifier -->"
  );

  assert.throws(
    () => qualityCriteria(dangling, "writer", 0, specStage),
    /Audience tag|Tagged bullet count|Empty quality section/u
  );
  assert.throws(
    () =>
      qualityCriteria(
        criteriaBar.replace(
          "<!-- for: code,plan,design,cleanup -->\n- Prune: prune.",
          "- Prune: prune."
        ),
        "code",
        0,
        specStage
      ),
    /Tagged bullet count/u
  );
  assert.throws(
    () =>
      qualityCriteria(
        criteriaBar.replace(
          "<!-- for: all -->\n- Evidence: evidence.",
          "- Evidence: evidence."
        ),
        "explorer",
        0,
        specStage
      ),
    /Tagged bullet count/u
  );

  // Audience tags select bullets per consumer and hide tags and author text.
  for (const consumer of [
    "code",
    "writer",
    "plan",
    "design",
    "cleanup",
    "verifier",
    "explorer",
  ] as const) {
    const criteria = qualityCriteria(bar, consumer, 0, specStage);
    assert.doesNotMatch(criteria, /<!--/u, `${consumer}: no tag comment leaks`);
    assert.doesNotMatch(criteria, /for:/u, `${consumer}: no tag text leaks`);
    assert.doesNotMatch(
      criteria,
      /Author-only/u,
      `${consumer}: author text never renders`
    );
  }

  const writer = qualityCriteria(bar, "writer", 0, specStage);
  assert.ok(
    writer.includes(
      "Report host-rule/brief conflicts under concerns or limits."
    ),
    "writer report clause"
  );
  assert.ok(writer.includes("Run no Git write commands"), "writer git rule");
  assert.ok(writer.includes("Writer focus"), "writer focus");
  assert.doesNotMatch(
    writer,
    /Exclude host-rule\/brief conflicts from findings\./u,
    "writer no reviewer clause"
  );
  assert.doesNotMatch(writer, /^- Prune:/mu, "writer no prune");

  for (const consumer of ["code", "plan", "design"] as const) {
    const criteria = qualityCriteria(bar, consumer, 0, specStage);
    assert.ok(
      criteria.includes("Exclude host-rule/brief conflicts from findings."),
      `${consumer} reviewer clause`
    );
    assert.doesNotMatch(
      criteria,
      /Report host-rule\/brief conflicts under concerns or limits\./u,
      `${consumer} no writer clause`
    );
  }

  assert.ok(
    qualityCriteria(bar, "code", 0, specStage).includes("Prune:"),
    "code prune"
  );
  assert.ok(
    qualityCriteria(bar, "cleanup", 0, specStage).includes(
      "Run no Git write commands"
    ),
    "cleanup git rule"
  );
  assert.ok(
    qualityCriteria(bar, "cleanup", 0, specStage).includes("Prune:"),
    "cleanup prune"
  );
  assert.ok(
    qualityCriteria(bar, "cleanup", 0, specStage).includes(
      "Report host-rule/brief conflicts under concerns or limits."
    ),
    "cleanup report clause"
  );
  const verifier = qualityCriteria(bar, "verifier", 0, specStage);
  assert.ok(
    verifier.includes(
      "Report host-rule/brief conflicts under concerns or limits."
    ),
    "verifier report clause"
  );
  assert.doesNotMatch(
    verifier,
    /Run no Git write commands/u,
    "verifier no git rule"
  );
  assert.doesNotMatch(verifier, /Writer focus/u, "verifier no writer focus");
  assert.doesNotMatch(verifier, /^- Prune:/mu, "verifier no prune");
  assert.ok(verifier.includes("Untagged testing."), "verifier testing");
  const explorer = qualityCriteria(bar, "explorer", 0, specStage);
  assert.ok(explorer.includes("Host rule files"), "explorer host rules");
  assert.ok(explorer.includes("Precedence"), "explorer precedence");
  assert.ok(explorer.includes("Evidence"), "explorer evidence");
  assert.doesNotMatch(explorer, /Untagged shared/u, "explorer drops untagged");
  assert.doesNotMatch(
    explorer,
    /Report host-rule/u,
    "explorer drops writer clause"
  );
  assert.doesNotMatch(
    explorer,
    /Exclude host-rule/u,
    "explorer drops reviewer clause"
  );
  const realBar = read(templates, "quality-bar.md");

  for (const consumer of [
    "code",
    "writer",
    "plan",
    "design",
    "cleanup",
    "verifier",
    "explorer",
  ] as const) {
    assert.doesNotMatch(
      qualityCriteria(realBar, consumer, 0, specStage),
      /<!--/u,
      `${consumer}: real bar hides tags`
    );
  }

  assert.ok(
    qualityCriteria(realBar, "writer", 0, specStage).includes(
      "Run no Git write commands"
    ),
    "real writer git"
  );
  assert.ok(
    qualityCriteria(realBar, "cleanup", 0, specStage).includes(
      "Run no Git write commands"
    ),
    "real cleanup git"
  );
});

test("review prompts: host rules take precedence over dispatch defaults in every kind", () => {
  const bar = read(templates, "quality-bar.md");

  const discoveryRule =
    "before judging or editing, find every file that sets conventions for in-scope paths";

  for (const kind of ["code", "design", "plan"] as const) {
    // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
    const text = flat(kind);
    assert.equal(
      text.split("Applicable host rule files govern first.").length,
      2,
      kind
    );
    assert.equal(
      text.split(
        "This bar supplements host rules where they are silent and yields where they conflict."
      ).length,
      2,
      kind
    );
    assert.equal(
      text.split(discoveryRule).length - 1,
      1,
      `${kind}: host-rule discovery`
    );
  }

  assert.equal(
    qualityCriteria(bar, "writer", 0, specStage).split(discoveryRule).length -
      1,
    1,
    "writer: host-rule discovery"
  );

  const inspection = defined(
    defined(
      read(templates, "review-prompt.md").split(/^### Inspection\s*$/mu)[1]
    ).split(/^### /mu)[0]
  );

  assert.doesNotMatch(inspection, /AGENTS\.md/u);
});

// SECTION: Durable test bar and plan-free naming

test("quality selection keeps artifact finding loci in review kind blocks", () => {
  const bar = read(templates, "quality-bar.md");

  for (const consumer of ["code", "writer", "plan", "design"] as const) {
    assert.doesNotMatch(
      qualityBar(bar, consumer, 0, specStage),
      /Adjacent findings|nearest plan|nearest design/u
    );
  }

  for (const consumer of ["plan", "design"] as const) {
    const kindBlock = read(templates, `review-prompt-${consumer}.md`);
    assert.match(
      kindBlock,
      new RegExp(`nearest ${consumer} heading as locus`, "u")
    );
    assert.doesNotMatch(
      kindBlock,
      new RegExp(
        `nearest ${consumer === "plan" ? "design" : "plan"} heading`,
        "u"
      )
    );
  }
});

test("plan authors and reviewers share the binding decision standard", () => {
  const bar = read(templates, "quality-bar.md");

  const planSection = defined(
    defined(bar.split(/^## plan$/mu)[1]).split(/^## design$/mu)[0]
  );

  const standards = planSection
    .split("\n")
    .filter((line) => line.startsWith("- Plan standard:"));

  assert.equal(standards.length, 1, "one canonical plan standard");
  const standard = defined(standards[0]).replaceAll(/\s+/gu, " ");

  for (const term of [
    "observable outcomes",
    "binding interfaces and invariants",
    "ownership",
    "dependencies",
    "failure behavior",
    "verification",
    "exact algorithm",
  ]) {
    assert.ok(standard.includes(term), term);
  }

  // Reviewers receive the standard once; other kinds do not.
  assert.equal(
    flat("plan").split(standard).length - 1,
    1,
    "plan review prompt"
  );

  for (const kind of ["code", "design"] as const) {
    assert.ok(!flat(kind).includes(standard), kind);
  }

  // Authors read it through pointers, without a second copy.
  for (const name of ["plan.md", "../verbs/plan.md"]) {
    const author = read(templates, name);
    assert.ok(
      author.includes("quality-bar.md#plan"),
      `${name}: points to the canonical plan standard`
    );
    assert.ok(
      !author.includes("exact algorithm"),
      `${name}: no restated standard`
    );
  }

  // Reviewers separate a decision that blocks safe implementation from a routine writer choice.
  const reviewer = flat("plan");
  assert.match(reviewer, /missing decision that prevents safe implementation/u);
  assert.match(
    reviewer,
    /routine writer choice[^.]*only with a concrete consequence/u
  );
});

// SECTION: Computed turn target and context map

test("writer quality criteria omit prune directive while code and plan keep it", () => {
  const bar = read(templates, "quality-bar.md");
  const cleanup = read(templates, "test-cleanup-brief.md");
  const writer = qualityCriteria(bar, "writer", 0, specStage);

  for (const gate of ["Contract:", "Defect:", "Oracle:", "Unique kill:"]) {
    assert.ok(writer.includes(gate), `writer: ${gate}`);
  }

  assert.ok(writer.includes("Shape:"), "writer: Shape");
  assert.ok(writer.includes("Naming:"), "writer: Naming");
  assert.ok(writer.includes("Writer focus"), "writer: Writer focus");
  assert.match(writer, /free reign/iu, "writer: explicit free reign");
  assert.match(
    writer,
    /defer[^.\n]*pruning[^.\n]*downgrades/iu,
    "writer: defers pruning/downgrades to cleanup"
  );
  const writerBeforeFocus = defined(writer.split("- Writer focus")[0]);

  const writerTestingLead = defined(
    writerBeforeFocus.split("- **testing** —")[1]
  );

  assert.doesNotMatch(
    writerTestingLead,
    /Retain a regression-spec test only|default-delete|downgrade/iu,
    "writer untagged testing has no retain/prune/downgrade mandate"
  );
  assert.doesNotMatch(writer, /^- Prune:/mu);
  assert.doesNotMatch(writer, /disposable/u);

  const verifier = qualityCriteria(bar, "verifier", 0, specStage);

  for (const gate of ["Contract:", "Defect:", "Oracle:", "Unique kill:"]) {
    assert.ok(verifier.includes(gate), `verifier: ${gate}`);
  }

  assert.ok(verifier.includes("Shape:"), "verifier: Shape");
  assert.ok(verifier.includes("Naming:"), "verifier: Naming");
  assert.ok(
    verifier.includes(
      "Report host-rule/brief conflicts under concerns or limits."
    ),
    "verifier: conflicts under concerns or limits"
  );
  assert.doesNotMatch(verifier, /^- Prune:/mu, "verifier omits Prune");
  assert.doesNotMatch(verifier, /Writer focus/u, "verifier omits Writer focus");
  assert.doesNotMatch(
    verifier,
    /Run no Git write commands/u,
    "verifier omits non-verifier Git-write bullet"
  );

  for (const consumer of ["code", "plan", "cleanup"] as const) {
    const criteria = qualityCriteria(bar, consumer, 0, specStage);
    assert.match(criteria, /^- Prune:/mu, `${consumer}: Prune`);
    assert.doesNotMatch(criteria, /Writer focus/u, `${consumer}: Writer focus`);

    const pruneLine = defined(
      criteria.split("\n").find((line) => line.startsWith("- Prune:"))
    );

    for (const pattern of [
      /default-delete|default to deleting/iu,
      /downgrade/iu,
      /over-tiered/iu,
      /undocumented external contract/iu,
      /the past/iu,
      /nothing/iu,
      /the implementation/iu,
      /straight-line|lightly-branching/iu,
      /nested control flow/iu,
      /compound boolean/iu,
      /regex/iu,
      /parser/iu,
      /formula/iu,
      /simplicity-floor/iu,
      /cheapest|lowest/iu,
      /test-only.*helper/iu,
      /code review/iu,
    ]) {
      assert.match(pruneLine, pattern, `${consumer} Prune missing ${pattern}`);
    }
  }

  for (const forbidden of ["cccc", "prune-tests", "caldoai"]) {
    assert.ok(
      !bar.toLowerCase().includes(forbidden),
      `quality-bar omits ${forbidden}`
    );
  }

  assert.match(cleanup, /executing `- Prune:` and ignoring `- Writer focus`/u);
});

test("code and writer receive naming, comments, and safe DRY rules", () => {
  const bar = read(templates, "quality-bar.md");

  for (const consumer of ["code", "writer"] as const) {
    const criteria = qualityCriteria(bar, consumer, 0, specStage);

    const namingLine = defined(
      criteria
        .split("\n")
        .find((line) => line.startsWith("- Naming & comments:"))
    );

    const safeDryLine = defined(
      criteria.split("\n").find((line) => line.startsWith("- Safe DRY:"))
    );

    for (const pattern of [
      /one concept/iu,
      /domain meaning with units\/qualifiers/iu,
      /filler.*data.*info.*manager.*helper.*util.*temp/iu,
      /numeric suffix/iu,
      /rename for meaning.*taste/iu,
      /external contracts/iu,
      /glossar/iu,
      /rationale or .*external facts/iu,
      /lift .*facts into names/iu,
      /narrating.*section-label.*dead-code/iu,
      /\/\/ SECTION:/u,
      /TODO:.*FIXME:/u,
      /linter\/doc directives/iu,
    ]) {
      assert.match(
        namingLine,
        pattern,
        `${consumer}: naming missing ${pattern}`
      );
    }

    for (const pattern of [
      /intent.*not text/iu,
      /pass-through wrappers/iu,
      /`utils`\/`helpers`/iu,
      /five axes—boundaries\/rounding\/units,\s*empty\/null\/invalid inputs,\s*timezone\/locale\/text,\s*errors,\s*and side-effect ordering\/logging/iu,
      /call-site nuances before migrating callers/iu,
      /leave copies separate and report/iu,
      /coincidental/iu,
      />2–3 options/iu,
      /money.*auth\/permissions.*migrations.*concurrency\/locking/iu,
    ]) {
      assert.match(
        safeDryLine,
        pattern,
        `${consumer}: safe DRY missing ${pattern}`
      );
    }
  }

  for (const consumer of [
    "plan",
    "design",
    "verifier",
    "explorer",
    "cleanup",
  ] as const) {
    const criteria = qualityCriteria(bar, consumer, 0, specStage);
    assert.doesNotMatch(
      criteria,
      /^- Naming & comments:/mu,
      `${consumer}: omits naming`
    );
    assert.doesNotMatch(
      criteria,
      /^- Safe DRY:/mu,
      `${consumer}: omits safe DRY`
    );
  }
});

test("testing consumers receive stack-neutral test design and setup amortization rules", () => {
  const bar = read(templates, "quality-bar.md");

  for (const consumer of [
    "code",
    "writer",
    "plan",
    "cleanup",
    "verifier",
  ] as const) {
    const criteria = qualityCriteria(bar, consumer, 0, specStage);

    const shapeLine = defined(
      criteria.split("\n").find((line) => line.startsWith("- Shape:"))
    );

    for (const pattern of [
      /fastest-first ladder/iu,
      /pure logic.*unit\/service.*integration\/route\/component.*end-to-end\/browser/iu,
      /typed boundary fakes/iu,
      /contract\/round-trip/iu,
      /state over .*call counts/iu,
      /exact literal values/iu,
      /format-pattern assertions over type-only matchers/iu,
      /amortize expensive setup at the highest viable level/iu,
      /Run > File > Test/u,
      /never add a browser\/E2E harness/iu,
    ]) {
      assert.match(shapeLine, pattern, `${consumer} Shape missing ${pattern}`);
    }

    assert.doesNotMatch(
      shapeLine,
      /\b(?:vitest|playwright|pnpm)\b/iu,
      `${consumer}: stack-neutral`
    );
  }

  for (const consumer of ["code", "plan", "cleanup"] as const) {
    const criteria = qualityCriteria(bar, consumer, 0, specStage);

    const pruneLine = defined(
      criteria.split("\n").find((line) => line.startsWith("- Prune:"))
    );

    assert.match(
      pruneLine,
      /key-shape-only without values/iu,
      `${consumer}: prune oracle precision`
    );
    assert.match(
      pruneLine,
      /cheapest layer/iu,
      `${consumer}: prune cheapest layer`
    );
  }

  for (const consumer of ["design", "explorer"] as const) {
    const criteria = qualityCriteria(bar, consumer, 0, specStage);
    assert.doesNotMatch(criteria, /Run > File > Test/u, `${consumer}: no Run`);
    assert.doesNotMatch(
      criteria,
      /typed boundary fakes/iu,
      `${consumer}: no boundary fakes`
    );
    assert.doesNotMatch(
      criteria,
      /browser\/E2E harness/iu,
      `${consumer}: no E2E harness`
    );
  }
});

test("reviewPrompt renders MUST rejection confirmation instructions only when requests are assigned", () => {
  for (const kind of reviewKinds) {
    for (const context of [
      reviewContext(kind),
      { ...reviewContext(kind), requests: [] },
    ]) {
      assert.doesNotMatch(
        reviewPrompt(kind, context),
        /Pending MUST rejection confirmation|confirmations/u
      );
    }

    const request: NonNullable<
      Parameters<typeof reviewPrompt>[1]["requests"]
    >[number] = {
      requestId: "R1-F001",
      review: kind === "code" ? "code-integration" : `${kind}-work.${kind}`,
      finding: "F001",
      rulingSeq: 1,
      claim: {
        id: "F001",
        severity: "MUST",
        impact: "blocks",
        trigger: "realistic",
        category: "correctness",
        locus: "src/api.ts:L1",
        defect: "Unbounded writes",
        proposedFix: "Bound writes",
        sources: ["reviewer"],
        scope: "in",
      },
      rationale: "The caller supplies the bound",
      target: { base: "a".repeat(40), head: "b".repeat(40) },
      spec: { path: "mission.spec.md", hash: `sha256:${"a".repeat(64)}` },
      sourceSlots: ["reviewer"],
    };

    const prompt = reviewPrompt(kind, {
      ...reviewContext(kind),
      requests: [request],
    });

    for (const rule of [
      "Pending MUST rejection confirmation",
      "confirmations",
      "requestId",
      "decision",
      "agree|disagree",
      "rationale",
      "nonblank evidence-backed",
      "Answer every assigned request exactly once",
      "Keep ordinary `status` and `findings`",
      "A pending MUST rejection is open until explicit agreement",
      "omission is not confirmation",
      request.requestId,
      request.claim.defect,
      `Proposed fix: ${request.claim.proposedFix}`,
      request.rationale,
    ]) {
      assert.ok(prompt.includes(rule), `${kind}: ${rule}`);
    }
  }
});

test("extractDocumentLayers inlines spec-stage layers and qualityCriteria filters reviewer rules", () => {
  const bar = read(templates, "quality-bar.md");
  // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
  const specStage = read(templates, "../spec-stage.md");
  const layers = extractDocumentLayers(specStage);
  assert.ok(layers.startsWith("Spec owns intent"), "layers paragraph");
  assert.ok(
    layers.includes("Cite upstream IDs instead of restating their layer."),
    "layers tail"
  );
  const modified = specStage.replace("Spec owns intent", "Spec owns purpose");
  assert.ok(
    extractDocumentLayers(modified).startsWith("Spec owns purpose"),
    "reflects input without hardcoded fallback"
  );

  const dollar = specStage.replace(
    "Spec owns intent",
    () => "Spec owns intent ($&, $', $$)"
  );

  const dollarLayers = extractDocumentLayers(dollar);
  assert.ok(
    dollarLayers.includes("Spec owns intent ($&, $', $$)"),
    "layers keep $ tokens"
  );
  assert.ok(
    qualityCriteria(bar, "code", 0, dollar).includes(
      `document layers (${dollarLayers})`
    ),
    "code: $ tokens preserved verbatim"
  );
  assert.throws(
    () => extractDocumentLayers("no heading here"),
    /Readers and document layers|heading/iu
  );

  for (const kind of ["code", "plan", "design"] as const) {
    const criteria = qualityCriteria(bar, kind, 0, specStage);
    assert.ok(
      criteria.includes(`document layers (${layers})`),
      `${kind}: inlined layers`
    );
    assert.doesNotMatch(criteria, /\.\.\//u, `${kind}: no relative link`);
    assert.doesNotMatch(
      criteria,
      /\(templates\//u,
      `${kind}: no templates link`
    );
    assert.doesNotMatch(
      criteria,
      /Treat settled DECs, non-goals, and prior accepted or rejected rulings/u,
      `${kind}: no settled-ruling text`
    );

    if (kind === "code") {
      assert.ok(
        criteria.includes("Exclude host-rule/brief conflicts from findings."),
        "code reviewer filter"
      );
      assert.doesNotMatch(
        criteria,
        /Writers report host-rule\/brief conflicts/u,
        "code no writer clause"
      );
    } else {
      assert.ok(
        criteria.includes("Exclude host-rule/brief conflicts from findings."),
        `${kind}: reviewer filter`
      );
    }
  }

  {
    const writer = qualityCriteria(bar, "writer", 0, specStage);
    assert.ok(
      writer.includes(
        "Report host-rule/brief conflicts under concerns or limits."
      ),
      "writer filter"
    );
    assert.ok(
      writer.includes(`document layers (${layers})`),
      "writer inlined layers"
    );
    assert.doesNotMatch(
      writer,
      /Treat settled DECs, non-goals, and prior accepted or rejected rulings/u,
      "writer no settled text"
    );
  }

  for (const kind of ["plan", "design"] as const) {
    const criteria = qualityCriteria(bar, kind, 0, specStage);
    assert.ok(
      criteria.includes("- Visuals, summaries, and callouts:"),
      `${kind}: reviewer visual check`
    );
    assert.ok(criteria.includes("stale"), `${kind}: stale`);
    assert.ok(criteria.includes("contradicts"), `${kind}: contradictory`);
    assert.ok(criteria.includes("decorative"), `${kind}: decorative`);
    assert.ok(criteria.includes("duplicate"), `${kind}: duplicate`);
    assert.ok(criteria.includes("[!NOTE]"), `${kind}: NOTE definition`);
    assert.ok(
      criteria.includes("[!IMPORTANT]"),
      `${kind}: IMPORTANT definition`
    );
    assert.ok(
      criteria.includes("misused") || criteria.includes("misuse"),
      `${kind}: misuse`
    );
    assert.doesNotMatch(
      criteria,
      /- Artifact layout:/u,
      `${kind}: no authoring layout`
    );
    assert.doesNotMatch(
      criteria,
      /### Visual-aid bar/u,
      `${kind}: no visual-aid bar`
    );
  }

  for (const kind of reviewKinds) {
    const prompt = reviewPrompt(kind, { ...reviewContext(kind), round: 1 });
    assert.doesNotMatch(
      prompt,
      /\(\.\.\//u,
      `${kind}: compiled prompt has no relative link`
    );
    assert.doesNotMatch(
      prompt,
      /\(templates\//u,
      `${kind}: compiled prompt has no templates link`
    );
    assert.ok(
      prompt.includes(
        "When all requirements, invariants, and boundaries hold, return `CLEAN`"
      ),
      `${kind}: CLEAN calibration`
    );
  }
});

test("reviewPrompt renders round-conditional blocks once and narrows the settled sentence", () => {
  for (const kind of reviewKinds) {
    const first = reviewPrompt(kind, {
      ...reviewContext(kind),
      round: 1,
      scope: "Full review",
    });

    assert.doesNotMatch(
      first,
      /On re-review,/u,
      `${kind} round 1: no re-review`
    );
    assert.doesNotMatch(
      first,
      /Settled in earlier rounds/u,
      `${kind} round 1: no settled section`
    );

    const narrowed = reviewPrompt(kind, {
      ...reviewContext(kind),
      round: 2,
      scope:
        "Re-review round 2 (narrowed) — changed: New work; comparison: a..b",
    });

    assert.equal(
      narrowed.split("On re-review,").length - 1,
      1,
      `${kind} round 2 narrowed: single re-review block`
    );
    assert.ok(
      narrowed.includes("Settled in earlier rounds"),
      `${kind} round 2 narrowed settles earlier rounds`
    );

    const rerun = reviewPrompt(kind, {
      ...reviewContext(kind),
      round: 2,
      scope: "Full review — changed paths: src/a.ts; comparison: a..b",
      settled: [],
    });

    assert.equal(
      rerun.split("On re-review,").length - 1,
      1,
      `${kind} round 2 rerun: single re-review block`
    );
    assert.doesNotMatch(
      rerun,
      /Read the full review history/u,
      `${kind} rerun: no external log instruction`
    );

    const withSettled = reviewPrompt(kind, {
      ...reviewContext(kind),
      round: 1,
      scope: "Full review",
      settled: [
        {
          id: "R1-F001",
          locus: "§ Work",
          defect: "Defect text",
          ruling: "accepted",
          reason: "Fixed",
        },
      ],
    });

    assert.equal(
      withSettled.split("On re-review,").length - 1,
      1,
      `${kind} round 1 with settled: single re-review block`
    );
  }

  const marker =
    "Before you open the artifact under review or the context map,";

  for (const kind of reviewKinds) {
    const first = reviewPrompt(kind, {
      ...reviewContext(kind),
      round: 1,
      scope: "Full review",
    });

    assert.equal(
      first.split(marker).length - 1,
      kind === "code" ? 0 : 1,
      `${kind} round 1`
    );

    const round2 = reviewPrompt(kind, {
      ...reviewContext(kind),
      round: 2,
      scope:
        "Re-review round 2 (narrowed) — changed: New work; comparison: a..b",
    });

    assert.equal(round2.split(marker).length - 1, 0, `${kind} round 2`);

    const withSettled = reviewPrompt(kind, {
      ...reviewContext(kind),
      round: 1,
      scope: "Full review",
      settled: [
        {
          id: "R1-F001",
          locus: "§ Work",
          defect: "Defect text",
          ruling: "accepted",
          reason: "Fixed",
        },
      ],
    });

    assert.equal(
      withSettled.split(marker).length - 1,
      0,
      `${kind} round 1 with settled`
    );
  }

  const settledSentence =
    "The governing spec's Decisions and Non-goals, and decisions recorded in an approved governing design or plan other than the artifact under review, are settled:";

  for (const kind of reviewKinds) {
    const prompt = reviewPrompt(kind, {
      ...reviewContext(kind),
      round: 1,
      scope: "Full review",
    });

    assert.ok(
      prompt.includes(settledSentence),
      `${kind}: narrowed settled sentence`
    );
  }
});

test("user decision: re-review prompt lists decisions and closes them unless new evidence exists", () => {
  for (const kind of reviewKinds) {
    const prompt = reviewPrompt(kind, {
      ...reviewContext(kind),
      round: 2,
      scope:
        "Re-review round 2 (narrowed) — changed: New work; comparison: a..b",
      settled: [DECISION],
    });

    assert.ok(
      prompt.split("\n").includes(DECISION_ROW),
      `${kind}: decision row`
    );
    assert.ok(prompt.includes(CLOSED), `${kind}: closed sentence`);
  }
});

test("plan and design context map renders locator wording with own-search instruction", () => {
  for (const kind of ["plan", "design"] as const) {
    const prompt = reviewPrompt(kind, {
      ...reviewContext(kind),
      round: 1,
      contextMapPath: ".scratch/session/context-map.md",
    });

    assert.ok(
      prompt.includes(
        "- Context Map: .scratch/session/context-map.md — pre-change locator, not a completeness claim: verify claims at source, and run your own consumer and caller search for each contract the artifact changes."
      ),
      kind
    );
  }
});

test("reviewPrompt throws when rendered families diverge from REVIEW_TAGS_BY_KIND", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prompt-tags-"));

  try {
    cpSync(
      path.resolve("skills/dispatch/references"),
      path.join(dir, "references"),
      { recursive: true }
    );

    const codeBlockPath = path.join(
      dir,
      "references/templates/review-prompt-code.md"
    );

    writeFileSync(
      codeBlockPath,
      readFileSync(codeBlockPath, "utf-8").replace(
        "## closing\n",
        "## closing\n- **extra** — unexpected family\n"
      )
    );
    assert.throws(
      () => reviewPrompt("code", { ...reviewContext("code"), skillRoot: dir }),
      /Review tags for code differ from rendered families:/u
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askPrompt includes deadline and wrap-up stop-tool-calls guidance", () => {
  const prompt = askPrompt("Why?", "Context");
  assert.ok(
    prompt.includes("[DEADLINE]"),
    "askPrompt must reference [DEADLINE]"
  );
  assert.ok(
    prompt.includes("stop tool calls"),
    "askPrompt must instruct stopping tool calls on wrap-up"
  );
});
