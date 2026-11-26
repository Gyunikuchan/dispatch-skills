import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  currentHashes,
  foldLedger,
} from "../../skills/dispatch/scripts/toolkit/ledger.ts";
import {
  arrayOf,
  defined,
  isString,
  narrow,
  objectWith,
} from "./helpers/json.ts";
import { planSource, toolkitRepo } from "./helpers/toolkit-repo.ts";

const twoTasks = planSource
  .replace(
    "| T1 | File | Works | none | SC1 |",
    "| T1 | File | Works | none | SC1 |\n| T2 | Other | Works | none | SC2 |"
  )
  .replace(
    "## Success Criteria",
    "### T2 — Other\n#### [MODIFY] src/file.ts\n- Purpose: other.\n\n## Success Criteria"
  )
  .replace(
    "## Verification Plan",
    '- [SC2] Other works\n  - Changes: src/file.ts\n  - Check: `node -e "process.exit(0)"`\n  - Evidence: check\n\n## Verification Plan'
  );

type Repo = Awaited<ReturnType<typeof toolkitRepo>>;

const rows = (r: Repo, phase: string) =>
  foldLedger(r.session).records.filter(
    (record) => record.kind === "integrate" && record.data["phase"] === phase
  );

const candidate = async (r: Repo, task = "T1", content = "writer\n") => {
  const made = await r.run(["worktree", "create", task]);

  assert.equal(made.exit, 0);

  const { path: wtPath } = narrow(made.value, objectWith({ path: isString }));

  fs.writeFileSync(path.join(r.session, wtPath, "src/file.ts"), content);

  const submitted = await r.run(["worktree", "submit", task]);

  assert.equal(submitted.exit, 0);

  return narrow(submitted.value, objectWith({ candidate: isString })).candidate;
};

const crash = (point: string) => (at: string) => {
  if (at === point) {
    throw new Error("simulated crash");
  }
};

describe("toolkit integration", () => {
  it("gates picks and reconciles a completed pick once", async () => {
    const r = await toolkitRepo();

    try {
      const hash = await candidate(r);

      const missing = await r.run(["worktree", "integrate", "T1"]);

      assert.equal(missing.output.reason, "missing-approval");

      await r.approve();

      const crashed = await r.run(
        ["worktree", "integrate", "T1"],
        crash("integrate:after-pick")
      );

      assert.equal(crashed.exit, 2);

      const integrated = await r.run(["worktree", "integrate", "T1"]);

      assert.equal(integrated.exit, 0);
      assert.equal(rows(r, "done").length, 1);
      assert.ok(
        r
          .git(["log", "-1", "--format=%B"], r.integration)
          .includes(`(cherry picked from commit ${hash})`)
      );

      const repeated = await r.run(["worktree", "integrate", "T1"]);

      assert.equal(repeated.output.reason, "no-candidate");
    } finally {
      r.cleanup();
    }
  });

  it("retries a recorded start before the pick and blocks another task", async () => {
    const r = await toolkitRepo(twoTasks);

    try {
      await r.level();
      await candidate(r);
      await candidate(r, "T2", "second\n");

      const base = r.deps.run;

      let stopped = false;

      r.deps.run = async (argv, opts) => {
        if (argv[1] === "cherry-pick" && argv[2] === "-x" && !stopped) {
          stopped = true;

          throw new Error("before pick");
        }

        return await base(argv, opts);
      };

      const failed = await r.run(["worktree", "integrate", "T1"]);

      assert.equal(failed.exit, 2);

      const blocked = await r.run(["worktree", "integrate", "T2"]);

      assert.equal(blocked.output.reason, "integration-pending");

      const integrated = await r.run(["worktree", "integrate", "T1"]);

      assert.equal(integrated.exit, 0);
      assert.equal(rows(r, "done").length, 1);
    } finally {
      r.cleanup();
    }
  });

  it("recovers continue after a resolved conflict commit", async () => {
    const r = await toolkitRepo(twoTasks);

    try {
      await r.level();
      await candidate(r);
      await candidate(r, "T2", "second\n");

      fs.writeFileSync(
        path.join(r.integration, "src/file.ts"),
        "integration\n"
      );

      const prepared = await r.run([
        "worktree",
        "commit",
        "--reason",
        "prepare conflict",
      ]);

      assert.equal(prepared.exit, 0);

      const conflict = await r.run(["worktree", "integrate", "T1"]);

      assert.equal(conflict.exit, 0);
      assert.equal(conflict.output.reason, "conflict");
      assert.deepEqual(
        narrow(conflict.value, objectWith({ paths: arrayOf(isString) })).paths,
        ["src/file.ts"]
      );

      const repeated = await r.run(["worktree", "integrate", "T1"]);

      assert.equal(repeated.output.reason, "conflict");

      const unresolved = await r.run(["worktree", "continue", "T1"]);

      assert.equal(unresolved.output.reason, "unresolved-conflict");

      fs.writeFileSync(path.join(r.integration, "src/file.ts"), "resolved\n");

      r.git(["add", "src/file.ts"], r.integration);

      const before = r.git(["write-tree"], r.integration);

      const beforeHead = r.git(["rev-parse", "HEAD"], r.integration);

      const ledger = fs.readFileSync(
        path.join(r.session, "ledger.jsonl"),
        "utf-8"
      );

      const continueWrong = await r.run(["worktree", "continue", "T2"]);

      assert.equal(continueWrong.output.reason, "wrong-task");

      const abortWrong = await r.run([
        "worktree",
        "abort",
        "T2",
        "--reason",
        "wrong",
      ]);

      assert.equal(abortWrong.output.reason, "wrong-task");
      assert.equal(r.git(["write-tree"], r.integration), before);
      assert.equal(
        fs.readFileSync(path.join(r.session, "ledger.jsonl"), "utf-8"),
        ledger
      );
      assert.equal(r.git(["rev-parse", "HEAD"], r.integration), beforeHead);

      const crashed = await r.run(
        ["worktree", "continue", "T1"],
        crash("continue:after-commit")
      );

      assert.equal(crashed.exit, 2);

      const head = r.git(["rev-parse", "HEAD"], r.integration);

      const recovered = await r.run(["worktree", "continue", "T1"]);

      assert.equal(recovered.exit, 0);
      assert.equal(r.git(["rev-parse", "HEAD"], r.integration), head);
      assert.equal(rows(r, "done").length, 1);
      assert.equal(rows(r, "abandoned").length, 0);
    } finally {
      r.cleanup();
    }
  });

  it("acknowledges staleness and rejects a dirty integration tree", async () => {
    const r = await toolkitRepo();

    try {
      await r.level();
      await candidate(r);

      const bind = defined(
        foldLedger(r.session).records.find((record) => record.kind === "bind"),
        "bind record"
      );

      const hashes = currentHashes(r.root, bind);

      await r.edit({
        artifact: "plan",
        before: hashes.plan,
        after: hashes.plan,
        class: "non-intent",
        affects: ["T1"],
        rationale: "changed context",
        diffRef: "none",
      });

      const stale = await r.run(["worktree", "integrate", "T1"]);

      assert.equal(stale.output.reason, "stale-candidate");

      fs.writeFileSync(path.join(r.integration, "extra"), "dirty");

      const dirty = await r.run([
        "worktree",
        "integrate",
        "T1",
        "--ack-stale",
        "reviewed",
      ]);

      assert.equal(dirty.output.reason, "integration-dirty");

      fs.rmSync(path.join(r.integration, "extra"));

      const integrated = await r.run([
        "worktree",
        "integrate",
        "T1",
        "--ack-stale",
        "reviewed",
      ]);

      assert.equal(integrated.exit, 0);

      const ruling = defined(
        foldLedger(r.session).records.find(
          (record) => record.kind === "ruling"
        ),
        "ruling record"
      );

      assert.equal(ruling.data["rationale"], "reviewed");
    } finally {
      r.cleanup();
    }
  });

  it("aborts conflicts and pending candidates while preserving their commits", async () => {
    const r = await toolkitRepo(twoTasks);

    try {
      await r.level();

      const hash = await candidate(r);
      const other = await candidate(r, "T2", "second\n");

      fs.writeFileSync(
        path.join(r.integration, "src/file.ts"),
        "integration\n"
      );

      const prepared = await r.run([
        "worktree",
        "commit",
        "--reason",
        "conflict",
      ]);

      assert.equal(prepared.exit, 0);

      await r.run(["worktree", "integrate", "T1"]);

      const aborted = await r.run([
        "worktree",
        "abort",
        "T1",
        "--reason",
        "reject",
      ]);

      assert.equal(aborted.exit, 0);

      const hashes = currentHashes(
        r.root,
        defined(
          foldLedger(r.session).records.find(
            (record) => record.kind === "bind"
          ),
          "bind record"
        )
      );

      await r.edit({
        artifact: "plan",
        before: hashes.plan,
        after: hashes.plan,
        class: "non-intent",
        affects: ["T2"],
        rationale: "changed context",
        diffRef: "none",
      });

      const stale = await r.run(["worktree", "integrate", "T2"]);

      assert.equal(stale.output.reason, "stale-candidate");

      const abortedOther = await r.run([
        "worktree",
        "abort",
        "T2",
        "--reason",
        "reject",
      ]);

      assert.equal(abortedOther.exit, 0);
      assert.equal(
        r.git(["rev-parse", "refs/dispatch/test/abandoned/T1-1"]),
        hash
      );
      assert.equal(
        r.git(["rev-parse", "refs/dispatch/test/abandoned/T2-1"]),
        other
      );

      const repeated = await r.run([
        "worktree",
        "abort",
        "T1",
        "--reason",
        "again",
      ]);

      assert.equal(repeated.output.reason, "no-candidate");

      const made = await r.run(["worktree", "create", "T1"]);

      assert.equal(made.exit, 0);

      const { path: wtPath } = narrow(
        made.value,
        objectWith({ path: isString })
      );

      assert.equal(
        r.git(["rev-parse", "HEAD"], path.join(r.session, wtPath)),
        r.git(["rev-parse", "HEAD"], r.integration)
      );
    } finally {
      r.cleanup();
    }
  });

  it("records already applied candidates when abort follows a pick crash", async () => {
    const r = await toolkitRepo();

    try {
      await r.level();
      await candidate(r);

      await r.run(
        ["worktree", "integrate", "T1"],
        crash("integrate:after-pick")
      );

      const aborted = await r.run([
        "worktree",
        "abort",
        "T1",
        "--reason",
        "recover",
      ]);

      assert.equal(aborted.output.reason, "already-integrated");
      assert.equal(rows(r, "done").length, 1);
      assert.equal(rows(r, "abandoned").length, 0);
    } finally {
      r.cleanup();
    }
  });

  it("recovers fix records only from matching fix trailers", async () => {
    const r = await toolkitRepo();

    try {
      await r.run(["worktree", "create", "T1"]);

      const empty = await r.run(["worktree", "commit", "--reason", "fix"]);

      assert.equal(empty.output.reason, "no-changes");

      fs.writeFileSync(path.join(r.integration, "src/file.ts"), "fixed\n");

      const crashed = await r.run(
        ["worktree", "commit", "--reason", "fix"],
        crash("commit:after-commit")
      );

      assert.equal(crashed.exit, 2);

      const head = r.git(["rev-parse", "HEAD"], r.integration);

      const fixed = await r.run(["worktree", "commit", "--reason", "fix"]);

      assert.equal(fixed.exit, 0);
      assert.equal(rows(r, "fix").length, 1);
      assert.equal(r.git(["rev-parse", "HEAD"], r.integration), head);

      r.git(
        ["commit", "--allow-empty", "-m", "fix(dispatch): other"],
        r.integration
      );

      const other = await r.run(["worktree", "commit", "--reason", "other"]);

      assert.equal(other.output.reason, "no-changes");
      assert.equal(rows(r, "fix").length, 1);

      const commitInvalid = await r.run(["worktree", "commit"]);

      assert.equal(commitInvalid.output.reason, "invalid-input");

      const abortInvalid = await r.run(["worktree", "abort", "T1"]);

      assert.equal(abortInvalid.output.reason, "invalid-input");
    } finally {
      r.cleanup();
    }
  });
});
