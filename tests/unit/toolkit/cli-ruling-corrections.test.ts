import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { main } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import type { JsonObject } from "./helpers/json.ts";
import { optional, parseJson, withFields, text } from "./helpers/json.ts";
import {
  sessionFixture,
  useMemoryAtomicWrite as mockAtomicWrite,
} from "./helpers/session.ts";

interface Seeded {
  id: string;
  severity: string;
  impact?: string;
  trigger?: string;
}

const storedRow = withFields({
  kind: text,
  data: withFields({ impact: optional(text), trigger: optional(text) }),
});

const correctionHarness = () => {
  const f = sessionFixture({ memory: true });
  const restoreAtomicWrite = mockAtomicWrite();
  let keyCount = 0;

  const append = async (record: JsonObject) => {
    const file = path.join(f.root, "record.json");
    fs.writeFileSync(file, JSON.stringify(record));
    f.lines.length = 0;

    const exit = await main(
      ["ledger", "append", file, "--session", f.session],
      f.deps
    );

    return { exit, output: f.output() };
  };

  const seed = (review: string, findings: readonly Seeded[]) => {
    const directory = path.join(
      f.session,
      ".state",
      "reviews",
      review,
      "round-1"
    );

    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "round.json"),
      JSON.stringify({ round: 1, generation: 1, cap: 2, roster: [] })
    );
    fs.writeFileSync(
      path.join(directory, "findings.json"),
      JSON.stringify({ review, round: 1, findings })
    );
  };

  const ruling = async (subject: string, data: JsonObject = {}) =>
    await append({
      kind: "ruling",
      by: "orchestrator",
      key: `ruling-${(keyCount += 1) - 1}`,
      data: {
        subject,
        ruling: "accepted",
        fix: "proposed",
        rationale: "impact: the Verify gate surfaces this gap",
        ...data,
      },
    });

  const ready = async () => {
    await Promise.resolve();
    f.artifact("mission.spec.md", "# Mission\n");
    f.artifact(
      "work.plan.md",
      "# Work\n\n## Review Findings & Resolutions\nDriver note.\n"
    );

    const bind = {
      seq: 1,
      at: new Date().toISOString(),
      kind: "bind",
      by: "orchestrator",
      key: "bind",
      data: { spec: "mission.spec.md", plan: "work.plan.md" },
    };

    fs.writeFileSync(
      path.join(f.session, "ledger.jsonl"),
      `${JSON.stringify(bind)}\n`
    );
  };

  const stored = () =>
    fs
      .readFileSync(path.join(f.session, "ledger.jsonl"), "utf-8")
      .trim()
      .split(/\r?\n/u)
      .map((row) => parseJson(row, storedRow));

  return {
    f,
    append,
    seed,
    ruling,
    ready,
    stored,
    cleanup: () => {
      restoreAtomicWrite();
      f.cleanup();
    },
  };
};

const SHOULD_FINDING: Seeded = {
  id: "R1-F001",
  severity: "SHOULD",
  impact: "degrades",
  trigger: "realistic",
};

const PLAN = "plan-work.plan";

describe("severity corrections through the CLI", () => {
  test("correction recorded: plan, code-integration and tool RED findings", async () => {
    const h = correctionHarness();

    try {
      await h.ready();
      h.seed(PLAN, [SHOULD_FINDING, { ...SHOULD_FINDING, id: "R1-RED01" }]);
      h.seed("code-integration", [
        {
          id: "R1-F001",
          severity: "MUST",
          impact: "blocks",
          trigger: "realistic",
        },
      ]);
      const raise = { impact: "blocks", trigger: "realistic" };

      const results = [
        await h.ruling(`review:${PLAN}:R1-F001`, raise),
        await h.ruling(`review:${PLAN}:R1-RED01`, raise),
        await h.ruling("review:code-integration:R1-F001", {
          impact: "degrades",
          trigger: "realistic",
        }),
      ];

      for (const result of results) {
        assert.equal(result.exit, 0, result.output.summary);
      }

      const rulings = h.stored().filter((record) => record.kind === "ruling");
      assert.deepEqual(
        rulings.map((record) => [record.data.impact, record.data.trigger]),
        [
          ["blocks", "realistic"],
          ["blocks", "realistic"],
          ["degrades", "realistic"],
        ]
      );
    } finally {
      h.cleanup();
    }
  });

  test("critical correction refused: one reached by correction", async () => {
    const h = correctionHarness();

    try {
      await h.ready();
      h.seed(PLAN, [
        {
          id: "R1-F001",
          severity: "MUST",
          impact: "critical",
          trigger: "contrived",
        },
      ]);

      const originalRefused = await h.ruling(`review:${PLAN}:R1-F001`, {
        impact: "blocks",
        trigger: "contrived",
      });

      assert.equal(originalRefused.exit, 1);
      assert.equal(originalRefused.output.reason, "invalid-record");
      assert.match(originalRefused.output.summary, /reject/iu);

      h.seed(PLAN, [SHOULD_FINDING]);

      const raised = await h.ruling(`review:${PLAN}:R1-F001`, {
        impact: "critical",
        trigger: "realistic",
        rationale:
          "impact: the defect leaks credentials across the trust boundary",
      });

      assert.equal(raised.exit, 0, raised.output.summary);

      const lowered = await h.ruling(`review:${PLAN}:R1-F001`, {
        impact: "blocks",
        trigger: "realistic",
        rationale: "impact: the leak needs a second fault",
      });

      assert.equal(lowered.exit, 1);
      assert.match(lowered.output.summary, /reject/iu);
    } finally {
      h.cleanup();
    }
  });

  test("correction refused: a missing stored finding", async () => {
    const h = correctionHarness();

    try {
      await h.ready();

      const absent = await h.ruling(`review:${PLAN}:R1-F001`, {
        impact: "blocks",
        trigger: "realistic",
      });

      assert.equal(absent.exit, 1);
      assert.equal(absent.output.reason, "invalid-record");
      h.seed(PLAN, [SHOULD_FINDING]);

      const unknownId = await h.ruling(`review:${PLAN}:R1-F009`, {
        impact: "blocks",
        trigger: "realistic",
      });

      assert.equal(unknownId.exit, 1);
      fs.writeFileSync(
        path.join(
          h.f.session,
          ".state",
          "reviews",
          PLAN,
          "round-1",
          "findings.json"
        ),
        "{broken"
      );

      const unreadable = await h.ruling(`review:${PLAN}:R1-F001`, {
        impact: "blocks",
        trigger: "realistic",
      });

      assert.equal(unreadable.exit, 1);
      assert.equal(unreadable.output.reason, "invalid-record");

      h.seed(PLAN, [{ id: "R1-F001", severity: "MUST" }]);

      const noImpact = await h.ruling(`review:${PLAN}:R1-F001`, {
        impact: "degrades",
        trigger: "realistic",
      });

      assert.equal(noImpact.exit, 1);
      assert.equal(noImpact.output.reason, "invalid-record");
      assert.match(noImpact.output.summary, /impact/u);

      for (const subject of ["review:..:R1-F001", "review:plan-work.plan"]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        const malformed = await h.ruling(subject, {
          impact: "blocks",
          trigger: "realistic",
        });

        assert.equal(malformed.exit, 1, subject);
        assert.equal(malformed.output.reason, "invalid-record", subject);
      }
    } finally {
      h.cleanup();
    }
  });

  test("correction refused: an unchanged rating or a wrong-dimension rationale", async () => {
    const h = correctionHarness();

    try {
      await h.ready();
      h.seed(PLAN, [SHOULD_FINDING]);
      const subject = `review:${PLAN}:R1-F001`;

      const unchanged = await h.ruling(subject, {
        impact: "degrades",
        trigger: "realistic",
      });

      assert.equal(unchanged.exit, 1);
      assert.equal(unchanged.output.reason, "invalid-record");
      assert.match(unchanged.output.summary, /unchanged|no change/iu);

      const wrongRationale = await h.ruling(subject, {
        impact: "blocks",
        trigger: "realistic",
        rationale: "trigger: a contrived path",
      });

      assert.equal(wrongRationale.exit, 1);
      assert.match(wrongRationale.output.summary, /impact/u);

      const both = await h.ruling(subject, {
        impact: "blocks",
        trigger: "contrived",
        rationale: "Impact is wider but the trigger is rare",
      });

      assert.equal(both.exit, 0, both.output.summary);
    } finally {
      h.cleanup();
    }
  });

  test("correction recorded: a rationale-only ruling after a correction reads no stored finding", async () => {
    const h = correctionHarness();

    try {
      await h.ready();
      h.seed(PLAN, [SHOULD_FINDING]);

      const rulingResult = await h.ruling(`review:${PLAN}:R1-F001`, {
        impact: "blocks",
        trigger: "realistic",
      });

      assert.equal(rulingResult.exit, 0);
      fs.rmSync(path.join(h.f.session, ".state", "reviews", PLAN), {
        recursive: true,
      });

      const plain = await h.ruling(`review:${PLAN}:R1-F001`, {
        rationale: "Applied the fix",
      });

      assert.equal(plain.exit, 0, plain.output.summary);
    } finally {
      h.cleanup();
    }
  });
});
