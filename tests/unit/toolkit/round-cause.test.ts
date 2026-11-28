import assert from "node:assert/strict";
import { test } from "node:test";

import type { SlotOutcome } from "../../../skills/dispatch/scripts/toolkit/fanout.ts";
import { roundCause } from "../../../skills/dispatch/scripts/toolkit/findings.ts";
import type { FindingsValue } from "../../../skills/dispatch/scripts/toolkit/findings.ts";

type Saved = FindingsValue["findings"][number];

const finding = (id: string, extra: Partial<Saved> = {}): Saved => ({
  id,
  severity: "SHOULD",
  impact: "degrades",
  trigger: "realistic",
  category: "correctness",
  locus: "§ Work",
  defect: `Defect ${id}`,
  proposedFix: "Fix it",
  sources: ["agy[0]"],
  scope: "in",
  origin: "original",
  ...extra,
});

const done: SlotOutcome = { slot: "agy[0]", state: "done", text: "{}" };

const failed: SlotOutcome = {
  slot: "claude[0]",
  state: "failed",
  cls: "timeout",
  reason: "timed out",
};

const noCounts = {
  fixInduced: 0,
  recurring: 0,
  unknownOrigin: 0,
  new: 0,
  failed: 0,
};

const cause = (
  findings: readonly Saved[],
  replies: readonly SlotOutcome[] = [done],
  scope: "standard" | "confirmation" | "coverage" = "standard"
) => roundCause({ scope, findings, replies });

test("roundCause: each primary reports the matching partition counts", () => {
  assert.deepEqual(cause([]), { primary: "clean", counts: noCounts });
  assert.deepEqual(cause([finding("R2-F001")]), {
    primary: "new",
    counts: { ...noCounts, new: 1 },
  });
  assert.deepEqual(cause([finding("R2-F001", { origin: "fix-induced" })]), {
    primary: "fix-induced",
    counts: { ...noCounts, fixInduced: 1 },
  });
  assert.deepEqual(
    cause([finding("R2-F001", { recurrence: { of: "R1-F001" } })]),
    { primary: "recurring", counts: { ...noCounts, recurring: 1 } }
  );
  assert.deepEqual(
    cause([finding("R2-F001", { unresolved: { of: "R1-F001" } })]),
    { primary: "recurring", counts: { ...noCounts, recurring: 1 } }
  );
  assert.deepEqual(cause([finding("R2-F001", { origin: "unknown" })]), {
    primary: "unknown-origin",
    counts: { ...noCounts, unknownOrigin: 1 },
  });
  assert.deepEqual(cause([], [done, failed]), {
    primary: "failed",
    counts: { ...noCounts, failed: 1 },
  });
});

test("roundCause: a finding without origin counts as unknown-origin", () => {
  const { origin: _origin, ...bare } = finding("R2-F001");

  assert.deepEqual(cause([bare]), {
    primary: "unknown-origin",
    counts: { ...noCounts, unknownOrigin: 1 },
  });
});

test("roundCause: each finding counts once, in precedence order", () => {
  const value = cause([
    finding("R2-F001", {
      origin: "fix-induced",
      recurrence: { of: "R1-F001" },
    }),
    finding("R2-F002", { origin: "unknown", unresolved: { of: "R1-F002" } }),
    finding("R2-F003", { origin: "unknown" }),
    finding("R2-F004"),
    finding("R2-F005"),
  ]);

  assert.deepEqual(value, {
    primary: "fix-induced",
    counts: {
      fixInduced: 1,
      recurring: 1,
      unknownOrigin: 1,
      new: 2,
      failed: 0,
    },
  });
});

test("roundCause: the primary follows the precedence order", () => {
  const fixInduced = finding("R2-F001", { origin: "fix-induced" });
  const recurring = finding("R2-F002", { recurrence: { of: "R1-F001" } });
  const fresh = finding("R2-F003");
  const unknown = finding("R2-F004", { origin: "unknown" });

  assert.equal(
    cause([recurring, fresh, unknown, fixInduced]).primary,
    "fix-induced"
  );
  assert.equal(cause([fresh, unknown, recurring]).primary, "recurring");
  assert.equal(cause([unknown, fresh]).primary, "new");
  assert.equal(cause([unknown]).primary, "unknown-origin");
  assert.equal(
    cause([fixInduced], [done, failed], "confirmation").primary,
    "confirmation"
  );
  assert.equal(
    cause([fixInduced], [done, failed], "coverage").primary,
    "coverage"
  );
  assert.equal(cause([fixInduced], [done, failed]).primary, "fix-induced");
  assert.equal(cause([], [done], "confirmation").primary, "confirmation");
  assert.equal(cause([], [done], "coverage").primary, "coverage");
});

test("roundCause: failed needs a failed slot and either no done reply or no findings", () => {
  assert.equal(cause([finding("R2-F001")], [failed]).primary, "failed");
  assert.equal(cause([], [failed]).primary, "failed");
  assert.deepEqual(cause([finding("R2-F001")], [done, failed]), {
    primary: "new",
    counts: { ...noCounts, new: 1, failed: 1 },
  });
});

test("roundCause: a failed slot beside a done reply that kept a missing-RED gap is not failed", () => {
  const gap = finding("R2-RED01", { origin: "unknown", category: "testing" });

  assert.deepEqual(cause([gap], [done, failed]), {
    primary: "unknown-origin",
    counts: { ...noCounts, unknownOrigin: 1, failed: 1 },
  });
});
