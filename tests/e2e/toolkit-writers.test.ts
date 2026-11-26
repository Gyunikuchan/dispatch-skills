import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  appendRecord,
  foldLedger,
} from "../../skills/dispatch/scripts/toolkit/ledger.ts";
import {
  defined,
  isBoolean,
  isString,
  narrow,
  objectWith,
  text,
} from "./helpers/json.ts";
import { planSource, toolkitRepo } from "./helpers/toolkit-repo.ts";

const isMessage = objectWith({ message: isString });

const records = (r: Awaited<ReturnType<typeof toolkitRepo>>) =>
  foldLedger(r.session).records.filter((record) => record.kind === "writer");

const launchPath = (r: Awaited<ReturnType<typeof toolkitRepo>>) =>
  path.resolve(
    r.session,
    text(
      defined(
        records(r).findLast((record) => record.data["phase"] === "launched")
          ?.data["path"],
        "launched writer path"
      )
    )
  );

const crash = (point: string) => (at: string) => {
  if (at === point) {
    throw new Error("crash");
  }
};

const twoTaskPlan = (prerequisite: string) =>
  planSource
    .replace(
      "| T1 | File | Works | none | SC1 |",
      `| T1 | File | Works | none | SC1 |\n| T2 | Other | Works | ${prerequisite} | SC2 |`
    )
    .replace(
      "## Success Criteria",
      "### T2 — Other\n#### [MODIFY] other\n- Purpose: other.\n\n## Success Criteria"
    )
    .replace(
      "## Verification Plan",
      '- [SC2] Other works\n  - Changes: other\n  - Check: `node -e "process.exit(0)"`\n  - Evidence: check\n\n## Verification Plan'
    );

describe("toolkit writer worktrees", () => {
  it("creates records, refuses duplicate work, restores missing paths and uses fresh abandoned paths", async (t) => {
    const r = await toolkitRepo();

    t.after(r.cleanup);

    const relaunchMissing = await r.run([
      "worktree",
      "create",
      "T1",
      "--relaunch",
    ]);

    assert.equal(relaunchMissing.output.reason, "no-open-launch");
    assert.equal(records(r).length, 0);
    assert.equal(fs.existsSync(r.integration), false);

    const abandonMissing = await r.run([
      "worktree",
      "abandon",
      "T1",
      "--reason",
      "stop",
    ]);

    assert.equal(abandonMissing.output.reason, "no-open-launch");
    assert.equal(records(r).length, 0);
    assert.equal(fs.existsSync(r.integration), false);

    const created = await r.run(["worktree", "create", "T1"]);

    assert.equal(created.exit, 0);

    const cwd = launchPath(r);
    const base = r.git(["rev-parse", "HEAD"], cwd);

    assert.equal(base, r.git(["rev-parse", "HEAD"], r.integration));

    const duplicate = await r.run(["worktree", "create", "T1"]);

    assert.equal(duplicate.output.reason, "writer-open");

    fs.rmSync(cwd, { recursive: true, force: true });

    const restored = await r.run(["worktree", "create", "T1"]);

    assert.equal(restored.exit, 0);
    assert.equal(records(r).length, 1);
    assert.equal(r.git(["rev-parse", "HEAD"], cwd), base);

    const noChanges = await r.run(["worktree", "submit", "T1"]);

    assert.equal(noChanges.output.reason, "no-changes");

    fs.writeFileSync(path.join(cwd, "src/file.ts"), "changed\n");

    const relaunched = await r.run(["worktree", "create", "T1", "--relaunch"]);

    assert.equal(relaunched.exit, 0);
    assert.equal(launchPath(r), cwd);
    assert.equal(records(r).length, 2);
    assert.equal(
      narrow(
        defined(records(r)[1]?.data["base"], "second launch base"),
        objectWith({ commit: isString })
      ).commit,
      base
    );
    assert.equal(
      fs.readFileSync(path.join(cwd, "src/file.ts"), "utf-8"),
      "changed\n"
    );

    fs.writeFileSync(path.join(cwd, "extra"), "untracked");

    const abandoned = await r.run([
      "worktree",
      "abandon",
      "T1",
      "--reason",
      "stop",
    ]);

    assert.equal(abandoned.exit, 0);

    const ref = "refs/dispatch/test/abandoned/T1-2";

    assert.equal(r.git(["show", `${ref}:extra`]), "untracked");
    assert.equal(r.git(["show", `${ref}:src/file.ts`]), "changed");
    assert.equal(r.git(["rev-parse", "HEAD"], cwd), base);
    assert.equal(
      fs.readFileSync(path.join(cwd, "extra"), "utf-8"),
      "untracked"
    );

    const fresh = await r.run(["worktree", "create", "T1"]);

    assert.equal(fresh.exit, 0);
    assert.notEqual(launchPath(r), cwd);
  });

  it("refuses until prerequisites integrate except relaunch or restore of an open launch", async (t) => {
    const r = await toolkitRepo(twoTaskPlan("none"));

    t.after(r.cleanup);

    const created = await r.run(["worktree", "create", "T2"]);

    assert.equal(created.exit, 0);

    const cwd = launchPath(r);

    fs.writeFileSync(path.join(r.root, "work.plan.md"), twoTaskPlan("T1"));

    const relaunched = await r.run(["worktree", "create", "T2", "--relaunch"]);

    assert.equal(relaunched.exit, 0, JSON.stringify(relaunched));

    fs.rmSync(cwd, { recursive: true, force: true });

    const restored = await r.run(["worktree", "create", "T2"]);

    assert.equal(restored.exit, 0, JSON.stringify(restored));
    assert.equal(
      narrow(restored.value, objectWith({ restored: isBoolean })).restored,
      true
    );
    assert.equal(fs.existsSync(cwd), true);

    const abandoned = await r.run([
      "worktree",
      "abandon",
      "T2",
      "--reason",
      "stop",
    ]);

    assert.equal(abandoned.exit, 0);

    await r.level();

    const before = foldLedger(r.session).lastSeq;

    const refused = await r.run(["worktree", "create", "T2"]);

    assert.equal(refused.exit, 4, JSON.stringify(refused));
    assert.equal(
      refused.output.reason,
      "prerequisite-pending",
      JSON.stringify(refused)
    );
    assert.match(narrow(refused.value, isMessage).message, /\bT1\b/u);
    assert.equal(foldLedger(r.session).lastSeq, before);
    assert.equal(
      fs.existsSync(path.join(r.session, ".state/worktrees/T2-2")),
      false
    );

    const first = await r.run(["worktree", "create", "T1"]);

    assert.equal(first.exit, 0);

    fs.writeFileSync(path.join(launchPath(r), "src/file.ts"), "integrated\n");

    const submitted = await r.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const integrated = await r.run(["worktree", "integrate", "T1"]);

    assert.equal(integrated.exit, 0);

    const second = await r.run(["worktree", "create", "T2"]);

    assert.equal(second.exit, 0);
    assert.equal(
      fs.readFileSync(path.join(launchPath(r), "src/file.ts"), "utf-8"),
      "integrated\n"
    );
  });

  it("refuses to adopt a crash worktree that predates a prerequisite and keeps it until removed", async (t) => {
    const r = await toolkitRepo(twoTaskPlan("none"));

    t.after(r.cleanup);

    const crashed = await r.run(
      ["worktree", "create", "T2"],
      crash("create:after-add")
    );

    assert.equal(crashed.exit, 2);

    const stale = path.join(r.session, ".state/worktrees/T2-1");

    fs.writeFileSync(path.join(r.root, "work.plan.md"), twoTaskPlan("T1"));

    await r.level();

    const first = await r.run(["worktree", "create", "T1"]);

    assert.equal(first.exit, 0);

    fs.writeFileSync(path.join(launchPath(r), "src/file.ts"), "integrated\n");

    const submitted = await r.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);

    const integrated = await r.run(["worktree", "integrate", "T1"]);

    assert.equal(integrated.exit, 0);

    const refused = await r.run(["worktree", "create", "T2"]);

    assert.equal(refused.exit, 4, JSON.stringify(refused));
    assert.equal(
      refused.output.reason,
      "stale-worktree",
      JSON.stringify(refused)
    );
    assert.match(
      narrow(refused.value, isMessage).message,
      /untracked or ignored/u
    );
    assert.equal(fs.existsSync(stale), true);

    r.git(["worktree", "remove", stale]);

    const created = await r.run(["worktree", "create", "T2"]);

    assert.equal(created.exit, 0);
    assert.equal(
      fs.readFileSync(path.join(stale, "src/file.ts"), "utf-8"),
      "integrated\n"
    );
  });

  it("adopts only the predicted crash worktree despite other ledger records and launches", async (t) => {
    const r = await toolkitRepo(twoTaskPlan("none"));

    t.after(r.cleanup);

    const first = await r.run(["worktree", "create", "T1"]);

    assert.equal(first.exit, 0);

    const abandoned = await r.run([
      "worktree",
      "abandon",
      "T1",
      "--reason",
      "stop",
    ]);

    assert.equal(abandoned.exit, 0);

    const interrupted = await r.run(
      ["worktree", "create", "T1"],
      crash("create:after-add")
    );

    assert.equal(interrupted.exit, 2, JSON.stringify(interrupted));
    assert.equal(
      narrow(interrupted.value, isMessage).message,
      "crash",
      JSON.stringify(interrupted)
    );

    const predicted = path.join(r.session, ".state/worktrees/T1-2");
    const head = r.git(["rev-parse", "HEAD"], predicted);

    await appendRecord(
      r.session,
      {
        kind: "note",
        by: "orchestrator",
        key: "intervening",
        data: { text: "intervening" },
      },
      r.deps
    );

    const other = await r.run(["worktree", "create", "T2"]);

    assert.equal(other.exit, 0);

    const adopted = await r.run(["worktree", "create", "T1"]);

    assert.equal(adopted.exit, 0);
    assert.equal(launchPath(r), predicted);
    assert.equal(
      records(r).filter(
        (record) => record.data["path"] === ".state/worktrees/T1-2"
      ).length,
      1
    );
    assert.equal(
      narrow(
        defined(records(r).at(-1)?.data["base"], "adopted base"),
        objectWith({ commit: isString })
      ).commit,
      head
    );
  });

  it("submits modifications additions deletions and untracked files within ownership", async (t) => {
    const source = planSource.replace(
      "#### [MODIFY] src/file.ts",
      "#### [MODIFY] src/file.ts\n- Purpose: file.\n#### [NEW] src/add.ts\n- Purpose: addition.\n#### [DELETE] src/delete.ts\n- Purpose: deletion.\n#### [NEW] src/untracked.ts"
    );

    const r = await toolkitRepo(source);

    t.after(r.cleanup);

    fs.writeFileSync(path.join(r.root, "src/delete.ts"), "delete");

    r.git(["add", "."]);
    r.git(["commit", "-m", "fixture"]);

    const created = await r.run(["worktree", "create", "T1"]);

    assert.equal(created.exit, 0);

    const cwd = launchPath(r);
    const hooks = path.join(r.root, ".test-hooks");

    fs.mkdirSync(hooks);
    fs.writeFileSync(
      path.join(hooks, "pre-commit"),
      "#!/bin/sh\necho generated > unowned.txt\ngit add unowned.txt\n",
      {
        mode: 0o755,
      }
    );

    r.git(["config", "core.hooksPath", hooks]);
    fs.writeFileSync(path.join(cwd, "src/file.ts"), "changed");
    fs.writeFileSync(path.join(cwd, "src/add.ts"), "added");

    r.git(["add", "src/add.ts"], cwd);
    fs.unlinkSync(path.join(cwd, "src/delete.ts"));
    fs.writeFileSync(path.join(cwd, "src/untracked.ts"), "new");

    const interrupted = await r.run(
      ["worktree", "submit", "T1"],
      crash("submit:after-commit")
    );

    assert.equal(interrupted.exit, 2, JSON.stringify(interrupted));
    assert.equal(
      narrow(interrupted.value, isMessage).message,
      "crash",
      JSON.stringify(interrupted)
    );

    const committed = r.git(["rev-parse", "HEAD"], cwd);

    const submitted = await r.run(["worktree", "submit", "T1"]);

    assert.equal(submitted.exit, 0);
    assert.equal(r.git(["rev-parse", "HEAD"], cwd), committed);

    const finished = defined(records(r).at(-1), "finished writer record");

    assert.equal(finished.data["phase"], "finished");
    assert.equal(
      r.git(["rev-parse", "refs/dispatch/test/candidates/T1-1"]),
      finished.data["candidate"]
    );
    assert.equal(r.git(["show", "HEAD:src/untracked.ts"], cwd), "new");
    assert.equal(r.git(["status", "--porcelain"], cwd), "");
    assert.equal(
      r.git(["log", "-1", "--format=%s"], cwd),
      "chore(dispatch): T1 launch 1"
    );
    assert.deepEqual(
      r
        .git(["diff", "--name-only", "HEAD^", "HEAD"], cwd)
        .split("\n")
        .toSorted(),
      ["src/add.ts", "src/delete.ts", "src/file.ts", "src/untracked.ts"]
    );

    const pending = await r.run(["worktree", "create", "T1"]);

    assert.equal(pending.output.reason, "candidate-pending");
  });

  it("refuses out of scope changes before committing and recovers committed submissions", async (t) => {
    const r = await toolkitRepo();

    t.after(r.cleanup);

    const created = await r.run(["worktree", "create", "T1"]);

    assert.equal(created.exit, 0);

    const cwd = launchPath(r);
    const base = r.git(["rev-parse", "HEAD"], cwd);

    fs.writeFileSync(path.join(cwd, "outside"), "outside");

    const refused = await r.run(["worktree", "submit", "T1"]);

    assert.equal(
      refused.output.reason,
      "out-of-scope",
      JSON.stringify(refused)
    );
    assert.ok(
      JSON.stringify(refused.value).includes("outside"),
      JSON.stringify(refused)
    );
    assert.equal(r.git(["rev-parse", "HEAD"], cwd), base);

    fs.unlinkSync(path.join(cwd, "outside"));
    fs.writeFileSync(path.join(cwd, "src/file.ts"), "submitted");

    const interrupted = await r.run(["worktree", "submit", "T1"], (at) => {
      if (at === "submit:after-commit") {
        fs.writeFileSync(path.join(cwd, "src/file.ts"), "later");

        throw new Error("crash");
      }
    });

    assert.equal(interrupted.exit, 2, JSON.stringify(interrupted));
    assert.equal(
      narrow(interrupted.value, isMessage).message,
      "crash",
      JSON.stringify(interrupted)
    );

    const committed = r.git(["rev-parse", "HEAD"], cwd);

    const relaunched = await r.run(["worktree", "create", "T1", "--relaunch"]);

    assert.equal(
      relaunched.output.reason,
      "submit-pending",
      JSON.stringify(relaunched)
    );

    const abandoned = await r.run([
      "worktree",
      "abandon",
      "T1",
      "--reason",
      "stop",
    ]);

    assert.equal(
      abandoned.output.reason,
      "submit-pending",
      JSON.stringify(abandoned)
    );

    const recovered = await r.run(["worktree", "submit", "T1"]);

    assert.equal(recovered.exit, 0, JSON.stringify(recovered));
    assert.equal(r.git(["rev-parse", "HEAD"], cwd), committed);
    assert.equal(
      defined(records(r).at(-1), "recovered writer record").data["candidate"],
      committed
    );
    assert.equal(
      fs.readFileSync(path.join(cwd, "src/file.ts"), "utf-8"),
      "later"
    );
    assert.notEqual(r.git(["status", "--porcelain"], cwd), "");
  });

  it("soft resets an unrecorded submit whose committed diff exceeds ownership", async (t) => {
    const r = await toolkitRepo();

    t.after(r.cleanup);

    await r.run(["worktree", "create", "T1"]);

    const cwd = launchPath(r);
    const base = r.git(["rev-parse", "HEAD"], cwd);

    fs.writeFileSync(path.join(cwd, "src/file.ts"), "submitted");

    const interrupted = await r.run(
      ["worktree", "submit", "T1"],
      crash("submit:after-commit")
    );

    assert.equal(interrupted.exit, 2, JSON.stringify(interrupted));
    assert.equal(
      narrow(interrupted.value, isMessage).message,
      "crash",
      JSON.stringify(interrupted)
    );

    fs.writeFileSync(path.join(cwd, "outside"), "outside");

    r.git(["add", "outside"], cwd);
    r.git(["commit", "--amend", "--no-edit"], cwd);

    const refused = await r.run(["worktree", "submit", "T1"]);

    assert.equal(refused.output.reason, "out-of-scope");
    assert.equal(r.git(["rev-parse", "HEAD"], cwd), base);
    assert.equal(
      fs.readFileSync(path.join(cwd, "outside"), "utf-8"),
      "outside"
    );
    assert.equal(
      records(r).filter((record) => record.data["phase"] === "finished").length,
      0
    );
  });
});
