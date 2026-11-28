import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findingUnits,
  stepBackMark,
} from "../../../skills/dispatch/scripts/toolkit/findings.ts";
import { defined } from "../../helpers/guards.ts";

test("finding units classify and measure sections across rounds", () => {
  const rounds = [
    {
      findings: [{ id: "a", locus: "§ T1 — Old" }],
      text: "## Work\n### T1 — Old\na\n### T10 — Other\nb\n",
      startSeq: 1,
    },
    {
      findings: [{ id: "b", locus: "unresolved-locus: T1 – New" }],
      text: "## Work\n### T1 — New\na longer\n### T10 — Other\nb\n",
      startSeq: 3,
    },
  ];

  const units = findingUnits({
    kind: "plan",
    round: 2,
    rounds,
    planPath: "plan.md",
    ruling: (id, seq) => (id === "a" && seq >= 2 ? "accepted" : undefined),
  });

  assert.equal(defined(units[0]).unit, "T1");
  assert.equal(defined(units[0]).hot, true);
  assert.equal(defined(units[0]).hotStreak, 1);
  assert.ok(defined(defined(units[0]).delta) > 0);
});

test("finding units group locus variants and code findings", () => {
  const text =
    "## Success Criteria\ncriteria\n## Work\n### T1 — First title\none\n### T10 – Shared title\ntwo\n### AD-4 — Shared title\nthree\n";

  const loci = [
    "REQ-3",
    "DEC-15",
    "Spec: Purpose",
    "SC2",
    "unresolved-locus: T10 — wrong",
    "§ First title",
    "Shared title",
    "(none)",
  ];

  const rounds = [
    {
      findings: loci.map((locus, i) => ({ id: String(i), locus })),
      text,
      startSeq: 1,
    },
  ];

  const units = findingUnits({
    kind: "plan",
    round: 1,
    rounds,
    planPath: "work.plan.md",
    ruling: () => {},
  });

  assert.deepEqual(
    units.map((u) => u.unit),
    [
      "spec:REQ-3",
      "spec:DEC-15",
      "spec:Purpose",
      "§ Success Criteria",
      "T10",
      "T1",
      "artifact",
    ]
  );
  assert.deepEqual(defined(units.find((u) => u.unit === "T10")).findings, [
    "4",
    "6",
  ]);
  assert.equal(defined(units[0]).bytes, undefined);
  assert.equal(
    defined(units.find((u) => u.unit === "T1")).bytes,
    Buffer.byteLength("### T1 — First title\none\n")
  );

  const code = findingUnits({
    kind: "code",
    round: 1,
    rounds: [
      {
        findings: [
          { id: "a", locus: String.raw`src\x.ts:L4` },
          { id: "b", locus: "unresolved-locus: x" },
          { id: "c", locus: "absolute:L2", defect: "missing-red: T1 SC1" },
        ],
        startSeq: 0,
      },
    ],
    planPath: "work.plan.md",
    ruling: () => {},
  });

  assert.deepEqual(
    code.map((u) => u.unit),
    ["src/x.ts", "unresolved", "work.plan.md"]
  );
  assert.deepEqual(
    findingUnits({
      kind: "plan",
      round: 1,
      rounds: [{ findings: [], text, startSeq: 0 }],
      planPath: "",
      ruling: () => {},
    }),
    []
  );
});

const ruling = (id: string, seq: number) =>
  (id === "a" || id === "b") && seq >= 4 ? "accepted" : "rejected";

test("finding units preserve round start rulings and count growth without findings", () => {
  const rounds = [
    {
      findings: [
        { id: "a", locus: "T1" },
        { id: "x", locus: "unknown" },
      ],
      text: "### T1 — One\na\n",
      startSeq: 1,
    },
    {
      findings: [{ id: "b", locus: "T1" }],
      text: "### T1 — One\naa\n",
      startSeq: 3,
    },
    {
      findings: [
        { id: "c", locus: "T1" },
        { id: "y", locus: "unknown" },
      ],
      text: "### T1 — One\naaa\n",
      startSeq: 5,
    },
  ];

  const units = findingUnits({
    kind: "plan",
    round: 3,
    rounds,
    planPath: "",
    ruling,
  });

  const second = findingUnits({
    kind: "plan",
    round: 2,
    rounds,
    planPath: "",
    ruling,
  });

  assert.deepEqual(
    [defined(second[0]).hot, defined(second[0]).hotStreak],
    [false, 0]
  );
  assert.deepEqual(
    [
      defined(units[0]).hot,
      defined(units[0]).hotStreak,
      defined(units[0]).growthStreak,
    ],
    [true, 1, 2]
  );
  assert.deepEqual(
    [defined(units[1]).hot, defined(units[1]).growthStreak],
    [false, 2]
  );
});

test("finding units resolve renamed IDs and new sections across inputs", () => {
  const rounds = [
    {
      findings: [{ id: "a", locus: "§ AD-4 — Old" }],
      text: "## Design\n### AD-4 — Old\none\n",
      startSeq: 1,
    },
    { findings: [], text: "## Design\n### AD-4 — New\ntwo\n", startSeq: 3 },
    {
      findings: [
        { id: "b", locus: "unresolved-locus: A — AD-4 — New" },
        { id: "c", locus: "T10" },
        { id: "d", locus: "New title" },
      ],
      text: "## Design\n### AD-4 — New\nthree\n### T1 — First\nx\n### T10 — New title\ny\n",
      startSeq: 5,
    },
  ];

  const units = findingUnits({
    kind: "design",
    round: 3,
    rounds,
    planPath: "",
    ruling: () => "accepted",
  });

  assert.deepEqual(
    units.map((u) => u.unit),
    ["AD-4", "T10"]
  );
  assert.deepEqual(defined(units.find((u) => u.unit === "AD-4")).findings, [
    "b",
  ]);
  assert.deepEqual(defined(units.find((u) => u.unit === "T10")).findings, [
    "c",
    "d",
  ]);
  assert.equal(defined(units[0]).hot, false);
  assert.equal(defined(units[1]).delta, defined(units[1]).bytes);
  assert.equal(defined(units[1]).growthStreak, 1);
});

test("finding units require the whole heading title", () => {
  const text = "## New\n### T10 — New title\n";

  const findings = [
    { id: "a", locus: "New title extra" },
    { id: "b", locus: "new TITLE" },
    { id: "c", locus: "New" },
  ];

  const units = findingUnits({
    kind: "plan",
    round: 1,
    rounds: [{ findings, text, startSeq: 0 }],
    planPath: "",
    ruling: () => {},
  });

  assert.deepEqual(
    units.map((u) => [u.unit, u.findings]),
    [
      ["artifact", ["a"]],
      ["T10", ["b"]],
      ["§ New", ["c"]],
    ]
  );
});

test("finding units accept heading markers on exact loci", () => {
  const text = "## Key Interfaces & Data\n### Automated Tests\n";

  const findings = [
    { id: "a", locus: "unresolved-locus: ## Key Interfaces & Data" },
    { id: "b", locus: "unresolved-locus: ### Automated Tests" },
    { id: "c", locus: "§ ## Key Interfaces & Data" },
    { id: "d", locus: "§ ### Automated Tests" },
    { id: "e", locus: "unresolved-locus: ## Key Interfaces & Data extra" },
  ];

  const units = findingUnits({
    kind: "plan",
    round: 1,
    rounds: [{ findings, text, startSeq: 0 }],
    planPath: "",
    ruling: () => {},
  });

  assert.deepEqual(
    units.map((u) => [u.unit, u.findings]),
    [
      ["§ Key Interfaces & Data", ["a", "c"]],
      ["§ Automated Tests", ["b", "d"]],
      ["artifact", ["e"]],
    ]
  );
});

// SECTION: Step-back marker

const unitsAt = (...streaks: readonly (readonly [string, number])[]) =>
  streaks.map(([unit, hotStreak]) => ({ unit, hotStreak }));

const marked = (
  round: number,
  units: ReturnType<typeof unitsAt>,
  fixInduced: number,
  total: number
) => stepBackMark({ round, units, cause: { counts: { fixInduced } }, total });

test("step-back marker: a unit needs a streak of two and fix-induced findings need two and a majority", () => {
  assert.equal(marked(2, unitsAt(["T1", 1]), 0, 1), undefined);
  assert.deepEqual(marked(3, unitsAt(["T1", 2], ["T2", 1]), 0, 2), {
    units: ["T1"],
  });
  assert.deepEqual(marked(3, unitsAt(["T1", 3], ["T2", 2]), 0, 2), {
    units: ["T1", "T2"],
  });
  assert.equal(marked(2, [], 1, 1), undefined);
  assert.equal(marked(2, [], 2, 4), undefined);
  assert.deepEqual(marked(2, [], 2, 3), { units: [], fixInduced: [2, 3] });
  assert.deepEqual(marked(3, unitsAt(["T1", 2]), 5, 8), {
    units: ["T1"],
    fixInduced: [5, 8],
  });
});

test("step-back marker: round 1 and a round without cause carry none", () => {
  assert.equal(marked(1, unitsAt(["T1", 2]), 3, 3), undefined);
  assert.equal(
    stepBackMark({ round: 2, units: [], cause: undefined, total: 3 }),
    undefined
  );
  assert.deepEqual(
    stepBackMark({
      round: 2,
      units: unitsAt(["T1", 2]),
      cause: undefined,
      total: 3,
    }),
    { units: ["T1"] }
  );
});

// Compact per-round signals of a plan review over four rounds.
test("step-back marker: the recorded plan review is marked from round 2", () => {
  const rounds = [
    { round: 1, units: [], fixInduced: 0, total: 21, expected: undefined },
    {
      round: 2,
      units: unitsAt(
        ["T3", 1],
        ["§ Verification Plan", 0],
        ["§ Key Interfaces & Data", 1],
        ["T4", 1]
      ),
      fixInduced: 5,
      total: 8,
      expected: { units: [], fixInduced: [5, 8] },
    },
    {
      round: 3,
      units: unitsAt(
        ["§ Key Interfaces & Data", 2],
        ["T3", 2],
        ["T4", 2],
        ["artifact", 0]
      ),
      fixInduced: 9,
      total: 10,
      expected: {
        units: ["§ Key Interfaces & Data", "T3", "T4"],
        fixInduced: [9, 10],
      },
    },
    {
      round: 4,
      units: unitsAt(
        ["§ Key Interfaces & Data", 3],
        ["T3", 3],
        ["T5", 0],
        ["§ Success Criteria", 0]
      ),
      fixInduced: 3,
      total: 9,
      expected: { units: ["§ Key Interfaces & Data", "T3"] },
    },
  ];

  for (const { round, units, fixInduced, total, expected } of rounds) {
    assert.deepEqual(
      marked(round, units, fixInduced, total),
      expected,
      `round ${round}`
    );
  }
});

// A code-integration review that converges without churn stays unmarked.
test("step-back marker: a converging code review is never marked", () => {
  const rounds = [
    { round: 1, units: unitsAt(["unresolved", 0]), fixInduced: 0, total: 3 },
    {
      round: 2,
      units: unitsAt(["skills/dispatch/scripts/toolkit/diagnostics.ts", 0]),
      fixInduced: 0,
      total: 1,
    },
    { round: 3, units: [], fixInduced: 0, total: 0 },
  ];

  for (const { round, units, fixInduced, total } of rounds) {
    assert.equal(marked(round, units, fixInduced, total), undefined);
  }
});
