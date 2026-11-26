import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { artifactHash } from "../../../skills/dispatch/scripts/toolkit/artifacts.ts";
import { foldLedger } from "../../../skills/dispatch/scripts/toolkit/ledger.ts";
import { defined } from "../../helpers/guards.ts";
import { CLEAN, fixture } from "../../helpers/review-fixture.ts";
import {
  anything,
  jsonObject,
  listOf,
  narrow,
  numeric,
  readJson,
  withFields,
  text,
} from "./helpers/json.ts";

// SECTION: Ceiling helpers shared with review.test.ts (duplicated for split)

test("review recurrence requires accepted earlier ruling and changed target", async () => {
  for (const variant of ["accepted", "unchanged", "rejected", "late"]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
    const f = await fixture();

    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
    const callResult = await f.call();

    try {
      assert.equal(callResult.exit, 0);

      if (variant !== "late") {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await f.add("ruling", {
          subject: "review:plan-work.plan:R1-F001",
          ruling: variant === "rejected" ? "rejected" : "accepted",
          rationale: "Resolution",
        });
      }

      if (variant !== "unchanged") {
        fs.appendFileSync(f.plan, "\n## Fixed\nChanged.\n");
      }

      if (variant === "late") {
        f.deps.hook = async (point) => {
          if (point === "fanout:after-slot") {
            delete f.deps.hook;
            await f.add("ruling", {
              subject: "review:plan-work.plan:R1-F001",
              ruling: "accepted",
              rationale: "Late",
            });
          }
        };
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const result = await f.call();
      assert.equal(result.exit, 0);

      const [finding] = narrow(
        f.read(2, "findings.json"),
        withFields({ findings: listOf(jsonObject) })
      ).findings;

      assert.ok(finding);
      assert.deepEqual(
        finding[variant === "accepted" ? "recurrence" : "unresolved"],
        { of: "R1-F001" }
      );
      assert.equal(
        foldLedger(f.session).records.filter((row) => row.kind === "escalation")
          .length,
        variant === "accepted" ? 1 : 0
      );

      if (variant === "accepted") {
        const escalation = defined(foldLedger(f.session).records.at(-1));
        assert.equal(escalation.by, "tool");
        assert.equal(
          escalation.data["id"],
          "recurrence:plan-work.plan:R2-F001:g1"
        );
        assert.equal(escalation.data["state"], "open");
        assert.match(result.output.summary, /1 recurrences/u);
      }
    } finally {
      f.cleanup();
    }
  }
});

test("review recurrence recovers durable boundaries and resolves superseded escalation", async () => {
  for (const [point, move] of [
    ["review:after-pending", false],
    ["review:after-append", true],
  ] as const) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
    const f = await fixture();

    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
    const callResult2 = await f.call();

    try {
      assert.equal(callResult2.exit, 0);
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await f.add("ruling", {
        subject: "review:plan-work.plan:R1-F001",
        ruling: "accepted",
        rationale: "Fixed",
      });
      fs.appendFileSync(f.plan, "\n## Fix\nFirst fix.\n");
      f.deps.hook = (p) => {
        if (p === point) {
          throw new Error("Interrupted boundary");
        }
      };

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const callResult3 = await f.call();

      assert.equal(callResult3.exit, 2);
      const launched = f.launches.length;
      delete f.deps.hook;

      if (move) {
        fs.appendFileSync(f.plan, "\n## Second fix\nMoved again.\n");
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const resumed = await f.call();
      assert.equal(resumed.exit, move ? 4 : 0);
      assert.equal(f.launches.length, launched);

      if (move) {
        assert.equal(resumed.output.reason, "target-moved");
        assert.equal(
          fs.existsSync(path.join(f.directory, "round-2/findings.json")),
          false
        );
        // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
        f.deps.delegate = () =>
          Promise.resolve({
            outcome: {
              status: "ok",
              text: CLEAN,
              resume: null,
              sessionId: null,
            },
            invocations: [],
          });
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        const callResult4 = await f.call();

        assert.equal(callResult4.exit, 0);
      }

      const escalations = foldLedger(f.session).records.filter(
        (row) => row.kind === "escalation"
      );

      const latest = new Map(
        escalations.map((row) => [row.data["id"], row.data["state"]])
      );

      if (move) {
        assert.deepEqual([...latest.values()], ["resolved"]);
      } else {
        assert.equal(
          [...latest.values()].filter((state) => state === "open").length,
          1
        );
      }
    } finally {
      f.cleanup();
    }
  }
});

test("review recurrence refuses changed bound spec before recovering pending findings", async () => {
  const f = await fixture();

  try {
    await f.call();
    await f.add("ruling", {
      subject: "review:plan-work.plan:R1-F001",
      ruling: "accepted",
      rationale: "Fixed",
    });
    fs.appendFileSync(f.plan, "\n## Fixed\nChanged.\n");
    f.deps.hook = (point) => {
      if (point === "review:after-pending") {
        throw new Error("Interrupted");
      }
    };

    const callResult5 = await f.call();

    assert.equal(callResult5.exit, 2);
    delete f.deps.hook;
    fs.appendFileSync(f.spec, "\n## New constraint\nChanged.\n");
    await f.add("edit", {
      artifact: "spec",
      before: narrow(
        f.read(1, "round.json"),
        withFields({ spec: withFields({ hash: text }) })
      ).spec.hash,
      after: artifactHash("spec", fs.readFileSync(f.spec, "utf-8")),
      class: "non-intent",
      affects: [],
      rationale: "Record the spec revision",
      diffRef: "test diff",
    });
    const count = f.launches.length;
    const callResult6 = await f.call();

    assert.equal(callResult6.output.reason, "target-moved");
    assert.equal(f.launches.length, count);
    assert.equal(
      fs.existsSync(path.join(f.directory, "round-2/findings.json")),
      false
    );
    assert.equal(
      foldLedger(f.session).records.filter((row) => row.kind === "escalation")
        .length,
      0
    );
  } finally {
    f.cleanup();
  }
});

test("review recurrence rejects invalid review ruling and keeps other subjects free text", async () => {
  const f = await fixture();

  try {
    await assert.rejects(
      f.add("ruling", {
        subject: "review:plan-work.plan:R1-F001",
        ruling: "fixed",
        rationale: "Fixed",
      }),
      { reason: "invalid-record" }
    );
    await f.add("ruling", {
      subject: "other",
      ruling: "fixed",
      rationale: "Fixed",
    });
    assert.equal(
      defined(foldLedger(f.session).records.at(-1)).data["ruling"],
      "fixed"
    );
  } finally {
    f.cleanup();
  }
});

test("bound code review supersedes unrecorded plan and design edits during native continuation", async () => {
  for (const artifact of ["plan", "design"]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
    const f = await fixture();

    try {
      const source = [
        "# Work",
        "## Task Map",
        "| ID | Title | Outcome | Prerequisites | Criteria |",
        "| --- | --- | --- | --- | --- |",
        "| T1 | File | Works | none | SC1 |",
        "## Proposed Changes",
        "### T1 � File",
        "#### [NEW] src/file.ts",
        "- Purpose: behavior.",
        "## Success Criteria",
        "- [SC1] Works",
        "  - Changes: src/file.ts",
        "  - Check: `node check`",
        "  - Evidence: check",
        "## Verification Plan",
        "### Automated Tests",
        "- `node contract`",
      ].join("\n");

      fs.writeFileSync(f.plan, source);

      const design = f.artifact(
        "work.design.md",
        "# Design\n## Boundaries\nBefore.\n"
      );

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await f.add("bind", {
        spec: "mission.spec.md",
        plan: "work.plan.md",
        design: "work.design.md",
      });
      const head = "a".repeat(40);
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await f.add("integrate", {
        phase: "opened",
        path: ".state/worktrees/integration",
        branch: "integration",
        base: head,
        dest: { path: f.root, branch: "main" },
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await f.add("integrate", { phase: "done", task: "T1", commit: head });
      // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
      f.deps.run = (argv) =>
        Promise.resolve({
          exit: 0,
          stdout: argv[1] === "diff" ? "src/file.ts\0" : head,
          stderr: "",
        });
      f.config(true);
      f.deps.liveness = {};
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
      f.deps.orchestrator = {
        platform: "codex",
        model: "native",
      } as typeof f.deps.orchestrator;
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const first = await f.call("code", "integration");
      assert.equal(first.output.reason, "native-pending");

      const dir = path.join(
        f.session,
        ".state/reviews/code-integration/round-1"
      );

      const before = readJson(
        path.join(dir, "round.json"),
        withFields({
          target: anything,
          artifacts: withFields({ [artifact]: text }),
        })
      );

      fs.appendFileSync(
        artifact === "plan" ? f.plan : design,
        "\n## Revision\nAfter.\n"
      );

      for (const slot of narrow(
        first.value,
        withFields({ pending: listOf(withFields({ replyPath: text })) })
      ).pending) {
        fs.writeFileSync(slot.replyPath, CLEAN);
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const second = await f.call("code", "integration");
      assert.equal(second.output.reason, "native-pending");

      const after = readJson(
        path.join(dir, "round.json"),
        withFields({
          generation: numeric,
          target: anything,
          artifacts: withFields({ [artifact]: text }),
        })
      );

      assert.equal(after.generation, 2);
      assert.notEqual(after.artifacts[artifact], before.artifacts[artifact]);
      assert.deepEqual(after.target, before.target);
      assert.ok(
        narrow(
          second.value,
          withFields({ pending: listOf(withFields({ replyPath: text })) })
        ).pending.every((slot) => slot.replyPath.includes("gen-2"))
      );
    } finally {
      f.cleanup();
    }
  }
});
