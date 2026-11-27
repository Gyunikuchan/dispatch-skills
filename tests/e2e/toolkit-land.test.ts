import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { parseJson } from "../../skills/dispatch/scripts/lib/integrity.ts";
import { main } from "../../skills/dispatch/scripts/toolkit/cli.ts";
import type { CliDeps } from "../../skills/dispatch/scripts/toolkit/cli.ts";
import {
  currentHashes,
  foldLedger,
} from "../../skills/dispatch/scripts/toolkit/ledger.ts";
import {
  arrayOf,
  defined,
  isBoolean,
  isNumber,
  isString,
  maybe,
  narrow,
  nullable,
  objectWith,
} from "./helpers/json.ts";
import { planSource, toolkitRepo } from "./helpers/toolkit-repo.ts";

type Repo = Awaited<ReturnType<typeof toolkitRepo>>;

const envelopeShape = objectWith({
  ok: isBoolean,
  summary: isString,
  path: maybe(nullable(isString)),
  reason: maybe(isString),
  step: maybe(isString),
  help: maybe(isString),
});

const landSummary = objectWith({
  task: isString,
  launch: isNumber,
  steps: objectWith({ submit: isString, integrate: isString, check: isString }),
  commit: isString,
  checks: objectWith({ passed: isNumber }),
});

// The shared test helper drops `step` and `help`, so this call reads the raw envelope.
const call = async (r: Repo, args: string[], hook?: CliDeps["hook"]) => {
  const lines: string[] = [];

  const exit = await main([...args, "--session", r.session], {
    ...r.deps,
    stdout: (line) => {
      lines.push(line);
    },
    ...(hook && { hook }),
  });

  assert.equal(lines.length, 1);

  const envelope = narrow(parseJson(defined(lines[0])), envelopeShape);

  assert.ok(Buffer.byteLength(envelope.summary) <= 1024);

  const value =
    envelope.path === undefined ||
    envelope.path === null ||
    envelope.path === ""
      ? null
      : parseJson(fs.readFileSync(envelope.path, "utf-8"));

  return { exit, envelope, value };
};

const exited = async (r: Repo, args: string[]) => {
  const { exit } = await r.run(args);

  return exit;
};

const shape = (r: Repo) =>
  foldLedger(r.session).records.map((record) => {
    const { phase } = record.data;

    return `${record.kind}:${typeof phase === "string" ? phase : ""}`;
  });

const rows = (r: Repo, kind: string, phase?: string) =>
  foldLedger(r.session).records.filter(
    (record) =>
      record.kind === kind &&
      (phase === undefined || record.data["phase"] === phase)
  );

const write = async (r: Repo, task = "T1", content = "writer\n") => {
  const made = await r.run(["worktree", "create", task]);

  assert.equal(made.exit, 0);

  const { path: wtPath } = narrow(
    defined(made.value),
    objectWith({ path: isString })
  );

  fs.writeFileSync(path.join(r.session, wtPath, "src/file.ts"), content);
};

const submitted = async (r: Repo, task = "T1", content = "writer\n") => {
  await write(r, task, content);

  const done = await r.run(["worktree", "submit", task]);

  assert.equal(done.exit, 0);
};

const crashAt = (point: string, nth = 1) => {
  let seen = 0;

  return (at: string) => {
    if (at === point) {
      seen += 1;

      if (seen === nth) {
        throw new Error("simulated crash");
      }
    }
  };
};

const conflictInIntegration = async (r: Repo) => {
  fs.writeFileSync(path.join(r.integration, "src/file.ts"), "integration\n");

  const prepared = await r.run(["worktree", "commit", "--reason", "prepare"]);

  assert.equal(prepared.exit, 0);
};

const twoCriteria = planSource
  .replace(
    "| T1 | File | Works | none | SC1 |",
    "| T1 | File | Works | none | SC1, SC2 |"
  )
  .replace(
    "## Verification Plan",
    '- [SC2] File works again\n  - Changes: src/file.ts\n  - Check: `node -e "process.exit(0)"`\n  - Evidence: check\n\n## Verification Plan'
  );

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

const failingCheck = planSource.replace(
  'Check: `node -e "process.exit(0)"`',
  'Check: `node -e "process.exit(1)"`'
);

const ledgerEvidence = (r: Repo) => rows(r, "evidence");

describe("worktree land", () => {
  it("lands a finished task in one call and leaves the records of the separate calls", async () => {
    const landed = await toolkitRepo(twoTasks);
    const twin = await toolkitRepo(twoTasks);

    try {
      await landed.level();
      await twin.level();
      await write(landed);
      await write(twin);

      const one = await call(landed, ["worktree", "land", "T1"]);

      assert.equal(one.exit, 0, JSON.stringify(one));
      assert.equal(one.envelope.ok, true);
      assert.equal(one.envelope.step, undefined);
      assert.equal(one.envelope.help, undefined);

      const summary = narrow(parseJson(one.envelope.summary), landSummary);

      assert.deepEqual(summary.steps, {
        submit: "done",
        integrate: "done",
        check: "done",
      });
      assert.equal(summary.task, "T1");
      assert.equal(summary.launch, 1);
      assert.equal(summary.checks.passed, 1);
      assert.equal(
        summary.commit,
        landed.git(["rev-parse", "HEAD"], landed.integration)
      );

      const checkValue = narrow(
        defined(one.value),
        objectWith({
          check: objectWith({
            executed: isNumber,
            failed: arrayOf(isString),
            checks: arrayOf(objectWith({ criterion: isString })),
          }),
        })
      ).check;

      assert.deepEqual(checkValue.failed, []);
      assert.equal(checkValue.executed, 1);
      assert.deepEqual(
        checkValue.checks.map((row) => row.criterion),
        ["SC1"]
      );
      assert.deepEqual(
        ledgerEvidence(landed).map((row) => row.data["criterion"]),
        ["SC1"]
      );

      assert.equal(await exited(twin, ["worktree", "submit", "T1"]), 0);
      assert.equal(await exited(twin, ["worktree", "integrate", "T1"]), 0);
      assert.equal(await exited(twin, ["check", "run", "--task", "T1"]), 0);
      assert.deepEqual(shape(landed), shape(twin));
      assert.equal(
        landed.git(["rev-parse", "HEAD^{tree}"], landed.integration),
        twin.git(["rev-parse", "HEAD^{tree}"], twin.integration)
      );
    } finally {
      landed.cleanup();
      twin.cleanup();
    }
  });

  it("refuses at submit with the submit step and its help heading", async () => {
    const r = await toolkitRepo();

    try {
      await r.level();

      const noLaunch = await call(r, ["worktree", "land", "T1"]);

      assert.equal(noLaunch.exit, 4);
      assert.equal(noLaunch.envelope.ok, false);
      assert.equal(noLaunch.envelope.reason, "no-open-launch");
      assert.equal(noLaunch.envelope.step, "submit");
      assert.equal(noLaunch.envelope.help, "worktree submit");
      assert.ok(noLaunch.envelope.summary.startsWith("submit: no-open-launch"));

      await r.run(["worktree", "create", "T1"]);

      const noChanges = await call(r, ["worktree", "land", "T1"]);

      assert.equal(noChanges.exit, 4);
      assert.equal(noChanges.envelope.reason, "no-changes");
      assert.equal(noChanges.envelope.step, "submit");
      assert.equal(rows(r, "writer", "finished").length, 0);

      const unknown = await call(r, ["worktree", "land", "T9"]);

      assert.equal(unknown.exit, 1);
      assert.equal(unknown.envelope.step, undefined);
    } finally {
      r.cleanup();
    }
  });

  it("stops at a conflict before the check and reruns like a separate integrate retry", async () => {
    const landed = await toolkitRepo();
    const twin = await toolkitRepo();

    try {
      for (const r of [landed, twin]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential setup builds identical session state
        await r.level();
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential setup builds identical session state
        await write(r);
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential setup builds identical session state
        await conflictInIntegration(r);
      }

      const first = await call(landed, ["worktree", "land", "T1"]);

      assert.equal(first.exit, 0);
      assert.equal(first.envelope.ok, false);
      assert.equal(first.envelope.reason, "conflict");
      assert.equal(first.envelope.step, "integrate");
      assert.equal(first.envelope.help, "worktree integrate");
      assert.ok(first.envelope.summary.startsWith("integrate: conflict"));
      assert.deepEqual(
        narrow(
          defined(first.value),
          objectWith({ paths: arrayOf(isString), reason: isString })
        ),
        { task: "T1", paths: ["src/file.ts"], reason: "conflict" }
      );
      assert.equal(ledgerEvidence(landed).length, 0);

      const rerun = await call(landed, ["worktree", "land", "T1"]);

      assert.equal(rerun.envelope.reason, "conflict");
      assert.equal(rerun.envelope.step, "integrate");

      assert.equal(await exited(twin, ["worktree", "submit", "T1"]), 0);
      await twin.run(["worktree", "integrate", "T1"]);
      await twin.run(["worktree", "integrate", "T1"]);
      assert.deepEqual(shape(landed), shape(twin));

      fs.writeFileSync(
        path.join(landed.integration, "src/file.ts"),
        "resolved\n"
      );
      landed.git(["add", "src/file.ts"], landed.integration);
      assert.equal(await exited(landed, ["worktree", "continue", "T1"]), 0);

      const resumed = await call(landed, ["worktree", "land", "T1"]);

      assert.equal(resumed.exit, 0, JSON.stringify(resumed));
      assert.deepEqual(
        narrow(parseJson(resumed.envelope.summary), landSummary).steps,
        { submit: "skipped", integrate: "skipped", check: "done" }
      );
      assert.equal(rows(landed, "integrate", "done").length, 1);
    } finally {
      landed.cleanup();
      twin.cleanup();
    }
  });

  it("reports a failed check with its evidence path and reruns only the check", async () => {
    const r = await toolkitRepo(failingCheck);

    try {
      await r.level();
      await write(r);

      const failed = await call(r, ["worktree", "land", "T1"]);

      assert.equal(failed.exit, 0);
      assert.equal(failed.envelope.ok, false);
      assert.equal(failed.envelope.reason, "checks-failed");
      assert.equal(failed.envelope.step, "check");
      assert.equal(failed.envelope.help, "check run");
      assert.match(
        failed.envelope.summary,
        /^check: checks-failed; .*SC1 \.state\/evidence\/[0-9a-f]+\.json/u
      );
      assert.deepEqual(
        narrow(defined(failed.value), objectWith({ failed: arrayOf(isString) }))
          .failed,
        ["SC1"]
      );
      assert.equal(ledgerEvidence(r).length, 1);

      const rerun = await call(r, ["worktree", "land", "T1"]);

      assert.equal(rerun.envelope.reason, "checks-failed");
      assert.equal(rerun.envelope.step, "check");
      assert.equal(ledgerEvidence(r).length, 2);
      assert.equal(rows(r, "writer", "finished").length, 1);
      assert.equal(rows(r, "integrate", "done").length, 1);
    } finally {
      r.cleanup();
    }
  });

  it("skips the steps whose records already exist", async () => {
    const r = await toolkitRepo();

    try {
      await r.level();
      await submitted(r);

      const afterSubmit = await call(r, ["worktree", "land", "T1"]);

      assert.equal(afterSubmit.exit, 0, JSON.stringify(afterSubmit));
      assert.deepEqual(
        narrow(parseJson(afterSubmit.envelope.summary), landSummary).steps,
        { submit: "skipped", integrate: "done", check: "done" }
      );

      const repeat = await call(r, ["worktree", "land", "T1"]);

      assert.equal(repeat.exit, 0);
      assert.deepEqual(
        narrow(parseJson(repeat.envelope.summary), landSummary).steps,
        { submit: "skipped", integrate: "skipped", check: "done" }
      );
      assert.equal(rows(r, "integrate", "done").length, 1);
      assert.equal(ledgerEvidence(r).length, 2);
    } finally {
      r.cleanup();
    }
  });

  it("recovers an interrupted pick like a separate integrate retry", async () => {
    const landed = await toolkitRepo();
    const twin = await toolkitRepo();

    try {
      for (const r of [landed, twin]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential setup builds identical session state
        await r.level();
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential setup builds identical session state
        await write(r);
      }

      const crashed = await call(
        landed,
        ["worktree", "land", "T1"],
        crashAt("integrate:after-pick")
      );

      assert.equal(crashed.exit, 2);
      assert.equal(crashed.envelope.reason, "fault");
      assert.equal(crashed.envelope.step, "integrate");
      assert.equal(crashed.envelope.help, "worktree integrate");
      assert.equal(rows(landed, "integrate", "done").length, 0);

      const head = landed.git(["rev-parse", "HEAD"], landed.integration);
      const rerun = await call(landed, ["worktree", "land", "T1"]);

      assert.equal(rerun.exit, 0, JSON.stringify(rerun));
      assert.deepEqual(
        narrow(parseJson(rerun.envelope.summary), landSummary).steps,
        { submit: "skipped", integrate: "done", check: "done" }
      );
      assert.equal(landed.git(["rev-parse", "HEAD"], landed.integration), head);

      assert.equal(await exited(twin, ["worktree", "submit", "T1"]), 0);
      await twin.run(
        ["worktree", "integrate", "T1"],
        crashAt("integrate:after-pick")
      );
      assert.equal(await exited(twin, ["worktree", "integrate", "T1"]), 0);
      assert.equal(await exited(twin, ["check", "run", "--task", "T1"]), 0);
      assert.deepEqual(shape(landed), shape(twin));
      assert.equal(
        landed.git(["rev-parse", "HEAD^{tree}"], landed.integration),
        twin.git(["rev-parse", "HEAD^{tree}"], twin.integration)
      );
    } finally {
      landed.cleanup();
      twin.cleanup();
    }
  });

  it("records fresh complete evidence after an interruption between criterion evidence appends", async () => {
    const r = await toolkitRepo(twoCriteria);

    try {
      await r.level();
      await write(r);

      const crashed = await call(
        r,
        ["worktree", "land", "T1"],
        crashAt("check:after-evidence", 2)
      );

      assert.equal(crashed.exit, 2);
      assert.equal(crashed.envelope.step, "check");
      assert.equal(crashed.envelope.help, "check run");
      assert.equal(ledgerEvidence(r).length, 1);

      const rerun = await call(r, ["worktree", "land", "T1"]);

      assert.equal(rerun.exit, 0, JSON.stringify(rerun));

      const summary = narrow(parseJson(rerun.envelope.summary), landSummary);

      assert.deepEqual(summary.steps, {
        submit: "skipped",
        integrate: "skipped",
        check: "done",
      });
      assert.equal(summary.checks.passed, 2);
      assert.equal(rows(r, "integrate", "done").length, 1);
      assert.deepEqual(
        ledgerEvidence(r)
          .slice(-2)
          .map((record) => record.data["criterion"]),
        ["SC1", "SC2"]
      );
      assert.equal(ledgerEvidence(r).length, 3);
    } finally {
      r.cleanup();
    }
  });

  it("refuses a stale candidate at integrate and passes --ack-stale through", async () => {
    const r = await toolkitRepo();

    try {
      await r.level();
      await submitted(r);

      const { plan } = currentHashes(
        r.root,
        defined(
          foldLedger(r.session).records.find((record) => record.kind === "bind")
        )
      );

      await r.edit({
        artifact: "plan",
        before: plan,
        after: plan,
        class: "non-intent",
        affects: ["T1"],
        rationale: "changed context",
        diffRef: "none",
      });

      const stale = await call(r, ["worktree", "land", "T1"]);

      assert.equal(stale.exit, 4);
      assert.equal(stale.envelope.reason, "stale-candidate");
      assert.equal(stale.envelope.step, "integrate");
      assert.equal(stale.envelope.help, "worktree integrate");
      assert.ok(
        stale.envelope.summary.startsWith("integrate: stale-candidate")
      );
      assert.equal(rows(r, "integrate").length, 1);

      const acked = await call(r, [
        "worktree",
        "land",
        "T1",
        "--ack-stale",
        "reviewed",
      ]);

      assert.equal(acked.exit, 0, JSON.stringify(acked));
      assert.equal(defined(rows(r, "ruling")[0]).data["rationale"], "reviewed");
    } finally {
      r.cleanup();
    }
  });

  it("lands the candidate of a second launch", async () => {
    const r = await toolkitRepo();

    try {
      await r.level();
      await write(r);
      const first = await call(r, ["worktree", "land", "T1"]);

      assert.equal(first.exit, 0);

      await write(r, "T1", "second\n");

      const second = await call(r, ["worktree", "land", "T1"]);

      assert.equal(second.exit, 0, JSON.stringify(second));

      const summary = narrow(parseJson(second.envelope.summary), landSummary);

      assert.equal(summary.launch, 2);
      assert.deepEqual(summary.steps, {
        submit: "done",
        integrate: "done",
        check: "done",
      });
      assert.equal(rows(r, "integrate", "done").length, 2);
    } finally {
      r.cleanup();
    }
  });

  it("stops at an abandoned integration and names worktree create", async () => {
    const r = await toolkitRepo();

    try {
      await r.level();
      await write(r);
      await conflictInIntegration(r);
      await r.run(["worktree", "land", "T1"]);

      const aborted = await r.run([
        "worktree",
        "abort",
        "T1",
        "--reason",
        "reject",
      ]);

      assert.equal(aborted.exit, 0);

      const before = shape(r);
      const stopped = await call(r, ["worktree", "land", "T1"]);

      assert.equal(stopped.exit, 0);
      assert.equal(stopped.envelope.ok, false);
      assert.equal(stopped.envelope.reason, "integration-abandoned");
      assert.equal(stopped.envelope.step, "integrate");
      assert.equal(stopped.envelope.help, "worktree create");
      assert.match(stopped.envelope.summary, /worktree create T1/u);

      const value = narrow(
        defined(stopped.value),
        objectWith({ task: isString, launch: isNumber, candidate: isString })
      );

      assert.equal(value.task, "T1");
      assert.equal(value.launch, 1);
      assert.equal(
        value.candidate,
        r.git(["rev-parse", "refs/dispatch/test/abandoned/T1-1"])
      );
      assert.deepEqual(shape(r), before);
    } finally {
      r.cleanup();
    }
  });
});
