import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import type { JsonValue } from "../../skills/dispatch/scripts/lib/config.ts";
import { appendRecord } from "../../skills/dispatch/scripts/toolkit/ledger.ts";
import {
  defined,
  isString,
  maybe,
  narrow,
  objectWith,
} from "./helpers/json.ts";
import { toolkitRepo } from "./helpers/toolkit-repo.ts";

type Repo = Awaited<ReturnType<typeof toolkitRepo>>;

const exitOf = async (r: Repo, args: string[]) => {
  const result = await r.run(args);

  return result.exit;
};

const resumeGuard = objectWith({
  next: isString,
  reason: isString,
  action: isString,
  cleanup: maybe(isString),
  round: maybe(isString),
  evidence: maybe(isString),
});

const resume = async (r: Repo) => {
  const status = await r.run(["status", "show", "--resume"]);

  assert.equal(status.exit, 0, JSON.stringify(status.output));

  return narrow(status.value, resumeGuard);
};

const dependentPlan = [
  "# Work",
  "",
  "## Task Map",
  "| ID | Title | Outcome | Prerequisites | Criteria |",
  "| --- | --- | --- | --- | --- |",
  "| T1 | File | Works | none | SC1 |",
  "| T2 | Other | Works | T1 | SC2 |",
  "",
  "## Proposed Changes",
  "### T1 — File",
  "#### [MODIFY] src/file.ts",
  "- Purpose: implements file.",
  "",
  "### T2 — Other",
  "#### [MODIFY] src/other.ts",
  "- Purpose: implements other.",
  "",
  "## Success Criteria",
  "- [SC1] File works",
  "  - Changes: src/file.ts",
  "  - Check: `node -e \"const fs=require('node:fs');process.exit(fs.readFileSync('src/file.ts','utf8').includes('fail-sc1')?1:0)\"`",
  "  - Evidence: check",
  "- [SC2] Other works",
  "  - Changes: src/other.ts",
  "  - Check: `node -e \"const fs=require('node:fs');process.exit(fs.readFileSync('src/other.ts','utf8').includes('fail-sc2')?1:0)\"`",
  "  - Evidence: check",
  "",
  "## Verification Plan",
  "### Automated Tests",
  "- `node -e \"process.stdout.write('contract')\"`",
  "",
].join("\n");

const createdPath = (value: JsonValue | null) =>
  narrow(defined(value), objectWith({ path: isString })).path;

describe("status show --resume across implementation phases", () => {
  it("routes every open-integration writer, check, verification, and cleanup phase with its action", async () => {
    const r = await toolkitRepo(dependentPlan, {
      "src/other.ts": "initial other\n",
    });

    try {
      await r.level();

      // Baseline check opens integration while both tasks remain unlaunched.
      const baseline = await r.run(["check", "run"]);
      assert.equal(baseline.exit, 0);
      assert.deepEqual(await resume(r), {
        next: "continue",
        reason: "task-ready",
        action: "worktree create T1",
        cleanup: "unbound",
      });

      const created1 = await r.run(["worktree", "create", "T1"]);
      assert.equal(created1.exit, 0);
      const wt1 = path.join(r.session, createdPath(created1.value));

      assert.deepEqual(await resume(r), {
        next: "inspect",
        reason: "writer-open",
        action: "writer T1",
        cleanup: "unbound",
      });

      // Missing worktree before submit routes to worktree create.
      fs.rmSync(wt1, { recursive: true, force: true });
      assert.deepEqual(await resume(r), {
        next: "continue",
        reason: "worktree-missing",
        action: "worktree create T1",
        cleanup: "unbound",
      });

      const restored1 = await r.run(["worktree", "create", "T1"]);
      assert.equal(restored1.exit, 0);

      fs.writeFileSync(path.join(wt1, "src/file.ts"), "writer-1\n");
      assert.deepEqual(await resume(r), {
        next: "inspect",
        reason: "writer-open",
        action: "writer T1",
        cleanup: "unbound",
      });

      assert.equal(await exitOf(r, ["worktree", "submit", "T1"]), 0);
      assert.deepEqual(await resume(r), {
        next: "continue",
        reason: "candidate-ready",
        action: "worktree land T1",
        cleanup: "unbound",
      });

      // Conflict in integration routes to worktree continue.
      fs.writeFileSync(
        path.join(r.integration, "src/file.ts"),
        "integration\n"
      );
      assert.equal(
        await exitOf(r, ["worktree", "commit", "--reason", "conflict"]),
        0
      );
      const conflicted = await r.run(["worktree", "integrate", "T1"]);
      assert.equal(conflicted.output.reason, "conflict");
      assert.deepEqual(await resume(r), {
        next: "inspect",
        reason: "integration-conflict",
        action: "worktree continue T1",
        cleanup: "unbound",
      });

      // Aborting conflicted integration routes to worktree create.
      assert.equal(
        await exitOf(r, [
          "worktree",
          "abort",
          "T1",
          "--reason",
          "abort conflict",
        ]),
        0
      );
      assert.deepEqual(await resume(r), {
        next: "inspect",
        reason: "integration-abandoned",
        action: "worktree create T1",
        cleanup: "unbound",
      });

      // Relaunch, abandon, then relaunch again: open launch must report writer-open, not task-ready.
      const created2 = await r.run(["worktree", "create", "T1"]);
      assert.equal(created2.exit, 0);
      assert.equal(
        await exitOf(r, [
          "worktree",
          "abandon",
          "T1",
          "--reason",
          "retry launch",
        ]),
        0
      );
      assert.deepEqual(await resume(r), {
        next: "continue",
        reason: "task-ready",
        action: "worktree create T1",
        cleanup: "unbound",
      });

      const created3 = await r.run(["worktree", "create", "T1"]);
      assert.equal(created3.exit, 0);
      const wt3 = path.join(r.session, createdPath(created3.value));
      assert.deepEqual(await resume(r), {
        next: "inspect",
        reason: "writer-open",
        action: "writer T1",
        cleanup: "unbound",
      });

      // Integrate T1 with failing task check, then verify task-check-pending before and after check run.
      fs.writeFileSync(path.join(wt3, "src/file.ts"), "fail-sc1\n");
      assert.equal(await exitOf(r, ["worktree", "submit", "T1"]), 0);
      const integratedT1 = await r.run(["worktree", "integrate", "T1"]);
      assert.equal(integratedT1.exit, 0, JSON.stringify(integratedT1.output));
      assert.equal(
        integratedT1.output.ok,
        true,
        JSON.stringify(integratedT1.output)
      );
      assert.deepEqual(await resume(r), {
        next: "inspect",
        reason: "task-check-pending",
        action: "check run --task T1",
        cleanup: "unbound",
      });

      const failedTaskCheck = await r.run(["check", "run", "--task", "T1"]);
      assert.equal(failedTaskCheck.output.ok, false);
      assert.deepEqual(await resume(r), {
        next: "inspect",
        reason: "task-check-pending",
        action: "check run --task T1",
        cleanup: "unbound",
      });

      fs.writeFileSync(path.join(r.integration, "src/file.ts"), "ok-sc1\n");
      assert.equal(
        await exitOf(r, ["worktree", "commit", "--reason", "repair sc1"]),
        0
      );
      assert.equal(await exitOf(r, ["check", "run", "--task", "T1"]), 0);

      // Dependent task T2 becomes task-ready once prerequisite T1 is integrated and checked.
      assert.deepEqual(await resume(r), {
        next: "continue",
        reason: "task-ready",
        action: "worktree create T2",
        cleanup: "unbound",
      });

      const createdT2 = await r.run(["worktree", "create", "T2"]);
      assert.equal(createdT2.exit, 0);
      const wtT2 = path.join(r.session, createdPath(createdT2.value));
      fs.writeFileSync(path.join(wtT2, "src/other.ts"), "fail-sc2\n");
      assert.equal(await exitOf(r, ["worktree", "submit", "T2"]), 0);
      assert.equal(await exitOf(r, ["worktree", "integrate", "T2"]), 0);

      const failedAll = await r.run(["check", "run"]);
      assert.equal(failedAll.output.ok, false);
      assert.deepEqual(await resume(r), {
        next: "continue",
        reason: "checks-pending",
        action: "check run",
        cleanup: "unbound",
      });

      fs.writeFileSync(path.join(r.integration, "src/other.ts"), "ok-sc2\n");
      assert.equal(
        await exitOf(r, ["worktree", "commit", "--reason", "repair sc2"]),
        0
      );
      assert.equal(await exitOf(r, ["check", "run"]), 0);
      assert.deepEqual(await resume(r), {
        next: "continue",
        reason: "verification-pending",
        action: "brief verifier",
        cleanup: "unbound",
      });

      await appendRecord(
        r.session,
        {
          kind: "integrate",
          by: "orchestrator",
          data: {
            phase: "verification",
            cycle: 1,
            outcome: "no-op",
            head: r.git(["rev-parse", "HEAD"], r.integration),
            reason: "verified",
            open: [],
          },
        },
        r.deps
      );
      assert.deepEqual(await resume(r), {
        next: "continue",
        reason: "cleanup-pending",
        action: "test-cleanup",
        cleanup: "unbound",
      });

      // Cleanup commit moves HEAD, keeping cleanup=checkpoint while requiring a fresh check run.
      fs.writeFileSync(path.join(r.integration, "src/other.ts"), "cleaned\n");
      assert.equal(
        await exitOf(r, [
          "worktree",
          "commit",
          "--reason",
          "clean redundant tests",
          "--test-cleanup-json",
          JSON.stringify({ removed: [], deleted: 1, merged: 0 }),
        ]),
        0
      );
      assert.deepEqual(await resume(r), {
        next: "continue",
        reason: "checks-pending",
        action: "check run",
        cleanup: "checkpoint",
      });

      assert.equal(await exitOf(r, ["check", "run"]), 0);
      assert.deepEqual(await resume(r), {
        next: "review",
        reason: "review-pending",
        action: "review run",
        cleanup: "checkpoint",
      });
    } finally {
      r.cleanup();
    }
  });

  it("keeps checks-pending when a later task integrates on a new tree while earlier task evidence stays on the previous tree", async () => {
    const r = await toolkitRepo(dependentPlan, {
      "src/other.ts": "initial other\n",
    });

    try {
      await r.level();
      const c1 = await r.run(["worktree", "create", "T1"]);
      fs.writeFileSync(
        path.join(r.session, createdPath(c1.value), "src/file.ts"),
        "t1-ok\n"
      );
      assert.equal(await exitOf(r, ["worktree", "land", "T1"]), 0);

      const c2 = await r.run(["worktree", "create", "T2"]);
      fs.writeFileSync(
        path.join(r.session, createdPath(c2.value), "src/other.ts"),
        "t2-ok\n"
      );
      assert.equal(await exitOf(r, ["worktree", "land", "T2"]), 0);
      assert.equal(
        await exitOf(r, ["check", "run", "--criteria", "SC2,contract"]),
        0
      );

      assert.deepEqual(await resume(r), {
        next: "continue",
        reason: "checks-pending",
        action: "check run",
        cleanup: "unbound",
      });
    } finally {
      r.cleanup();
    }
  });

  it("routes delivery interruption, delivery completion, and closed-wins terminal orders", async () => {
    // Crash at deliver:after-started -> delivery-pending -> delivered -> delivered-then-closed
    {
      const r = await toolkitRepo();

      try {
        await r.level();
        const c1 = await r.run(["worktree", "create", "T1"]);
        fs.writeFileSync(
          path.join(r.session, createdPath(c1.value), "src/file.ts"),
          "deliver\n"
        );
        assert.equal(await exitOf(r, ["worktree", "land", "T1"]), 0);
        assert.equal(await exitOf(r, ["check", "run"]), 0);

        const crashed = await r.run(["worktree", "deliver"], (at) => {
          if (at === "deliver:after-started") {
            throw new Error("simulated crash");
          }
        });

        assert.equal(crashed.exit, 2);
        assert.deepEqual(await resume(r), {
          next: "continue",
          reason: "delivery-pending",
          action: "worktree deliver",
          cleanup: "unbound",
        });

        assert.equal(await exitOf(r, ["worktree", "deliver"]), 0);
        assert.deepEqual(await resume(r), {
          next: "continue",
          reason: "delivered",
          action: "report complete",
          cleanup: "unbound",
        });

        assert.equal(
          await exitOf(r, [
            "worktree",
            "close",
            "--reason",
            "delivered then closed",
          ]),
          0
        );
        assert.deepEqual(await resume(r), {
          next: "inspect",
          reason: "closed",
          action: "worktree cleanup",
          cleanup: "unbound",
        });
      } finally {
        r.cleanup();
      }
    }

    // committed-then-closed
    {
      const r = await toolkitRepo();

      try {
        await r.level();
        const c1 = await r.run(["worktree", "create", "T1"]);
        fs.writeFileSync(
          path.join(r.session, createdPath(c1.value), "src/file.ts"),
          "commit\n"
        );
        assert.equal(await exitOf(r, ["worktree", "land", "T1"]), 0);
        assert.equal(await exitOf(r, ["check", "run"]), 0);
        assert.equal(await exitOf(r, ["worktree", "deliver"]), 0);
        assert.equal(
          await exitOf(r, ["worktree", "deliver", "--message", "deliver"]),
          0
        );
        assert.deepEqual(await resume(r), {
          next: "continue",
          reason: "delivered",
          action: "report complete",
          cleanup: "unbound",
        });
        assert.equal(
          await exitOf(r, [
            "worktree",
            "close",
            "--reason",
            "committed then closed",
          ]),
          0
        );
        assert.deepEqual(await resume(r), {
          next: "inspect",
          reason: "closed",
          action: "worktree cleanup",
          cleanup: "unbound",
        });
      } finally {
        r.cleanup();
      }
    }

    // closed-then-delivered and closed-then-committed
    {
      const r = await toolkitRepo();

      try {
        await r.level();
        const c1 = await r.run(["worktree", "create", "T1"]);
        fs.writeFileSync(
          path.join(r.session, createdPath(c1.value), "src/file.ts"),
          "close-first\n"
        );
        assert.equal(await exitOf(r, ["worktree", "land", "T1"]), 0);
        assert.equal(await exitOf(r, ["check", "run"]), 0);
        assert.equal(
          await exitOf(r, ["worktree", "close", "--reason", "close early"]),
          0
        );
        assert.equal(await exitOf(r, ["worktree", "deliver"]), 0);
        assert.deepEqual(await resume(r), {
          next: "inspect",
          reason: "closed",
          action: "worktree cleanup",
          cleanup: "unbound",
        });

        assert.equal(
          await exitOf(r, ["worktree", "deliver", "--message", "after close"]),
          0
        );
        assert.deepEqual(await resume(r), {
          next: "inspect",
          reason: "closed",
          action: "worktree cleanup",
          cleanup: "unbound",
        });
      } finally {
        r.cleanup();
      }
    }
  });
});
