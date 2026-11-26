import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { isRecord } from "../../skills/dispatch/scripts/lib/config.ts";
import { parseJson } from "../../skills/dispatch/scripts/lib/integrity.ts";
import { foldLedger } from "../../skills/dispatch/scripts/toolkit/ledger.ts";
import {
  arrayOf,
  defined,
  isNumber,
  isString,
  narrow,
  nullable,
  objectWith,
  text,
} from "./helpers/json.ts";
import { planSource, toolkitRepo } from "./helpers/toolkit-repo.ts";

const isStatuses = arrayOf(
  objectWith({ criterion: isString, state: isString })
);

const isCheckRun = objectWith({
  executed: isNumber,
  reused: isNumber,
  checks: arrayOf(objectWith({ path: isString, logPath: isString })),
});

const isCommand = objectWith({
  mode: isString,
  execId: nullable(isString),
  cacheHex: nullable(isString),
  logPath: isString,
});

const isEvidence = objectWith({ commands: arrayOf(isCommand) });

const shared = (target: string) =>
  planSource
    .replace("| SC1 |", "| SC1, SC2 |")
    .replace(
      '`node -e "process.exit(0)"`',
      `\`node -e "require('fs').appendFileSync('${target}','x')"\``
    )
    .replace(
      "\n## Verification Plan",
      (match) =>
        `- [SC2] File still works\n  - Changes: src/file.ts\n  - Check: \`node -e "require('fs').appendFileSync('${target}','x')"\`\n  - Evidence: check\n${match}`
    );

const setMode = (dir: string, mode: "pass" | "fail") => {
  fs.writeFileSync(path.join(dir, "ignored"), mode);
};

const indexFiles = (session: string) => {
  const dir = path.join(session, ".state/evidence/commands/index");

  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

const evidenceOf = (session: string, evidencePath: string) =>
  narrow(
    parseJson(fs.readFileSync(path.join(session, evidencePath), "utf-8")),
    isEvidence
  );

describe("toolkit check", () => {
  test("records selected tree bound evidence and adopts the integration worktree on rerun", async () => {
    const f = await toolkitRepo();

    try {
      const firstRun = await f.run(["check", "run"]);

      assert.equal(firstRun.exit, 0);
      assert.equal(firstRun.output.ok, true);

      const rows = () => foldLedger(f.session).records;

      assert.equal(rows().filter((row) => row.kind === "evidence").length, 2);
      assert.equal(
        rows().filter((row) => row.data["phase"] === "opened").length,
        1
      );
      assert.equal(
        f.git(["branch", "--show-current"], f.integration),
        "dispatch/test/integration"
      );

      const first = defined(
        rows().find((row) => row.kind === "evidence"),
        "evidence"
      ).data;

      assert.equal(
        first["tree"],
        f.git(["rev-parse", "HEAD^{tree}"], f.integration)
      );
      assert.equal(first["clean"], true);
      assert.equal(first["exit"], 0);
      assert.match(
        text(defined(first["commandDigest"], "commandDigest")),
        /^sha256:/u
      );

      await f.run(["check", "run"]);
      assert.equal(rows().length, 7);
      assert.equal(
        rows().filter((row) => row.data["phase"] === "opened").length,
        1
      );
      assert.equal(defined(rows().at(-1), "row").data["tree"], first["tree"]);

      fs.writeFileSync(path.join(f.integration, "ignored"), "ignored");

      await f.run(["check", "run", "--criteria", "SC1"]);
      assert.equal(rows().length, 8);
      assert.equal(defined(rows().at(-1), "row").data["clean"], true);
      assert.equal(defined(rows().at(-1), "row").data["tree"], first["tree"]);

      fs.writeFileSync(path.join(f.integration, "new.txt"), "new");

      const dirty = await f.run(["check", "run", "--criteria", "SC1"]);

      assert.equal(dirty.output.reason, "dirty");
      assert.equal(defined(rows().at(-1), "row").data["clean"], false);
      assert.notEqual(
        defined(rows().at(-1), "row").data["tree"],
        first["tree"]
      );

      const unknownCriterion = await f.run([
        "check",
        "run",
        "--criteria",
        "SC99",
      ]);

      assert.equal(unknownCriterion.output.reason, "invalid-input");

      fs.rmSync(path.join(f.integration, "new.txt"));

      const trimmed = await f.run(["check", "run", "--criteria", " SC1, "]);

      assert.equal(trimmed.exit, 0);
      assert.equal(trimmed.output.ok, true);

      const before = rows().length;

      const refused = await f.run([
        "check",
        "run",
        "--criteria",
        "SC9, SC1, SC8",
      ]);

      assert.equal(refused.exit, 1);
      assert.equal(refused.output.reason, "invalid-input");
      assert.equal(
        refused.output.summary,
        "Unknown criterion: SC9, SC8; valid: SC1, contract"
      );
      assert.equal(rows().length, before);
    } finally {
      f.cleanup();
    }
  });

  test("records mutation and stops a criterion at its first failing command", async () => {
    const cases = [
      {
        command: `node -e "require('fs').writeFileSync('src/file.ts','changed')"`,
        reason: "mutated",
        exit: 0,
      },
      {
        command: `node -e "process.exit(7)"`,
        reason: "checks-failed",
        exit: 7,
      },
    ] as const;

    await Promise.all(
      cases.map(async ({ command, reason, exit }) => {
        const source =
          reason === "checks-failed"
            ? planSource
                .replace('node -e "process.exit(0)"', command)
                .replace(
                  "  - Evidence: check",
                  "  - Check: `node -e \"require('fs').writeFileSync('src/should-not-run','bad')\"`\n  - Evidence: check"
                )
            : planSource.replace('node -e "process.exit(0)"', command);

        const f = await toolkitRepo(source);

        try {
          const run = await f.run(["check", "run", "--criteria", "SC1"]);

          assert.equal(run.exit, 0);
          assert.equal(run.output.ok, false);
          assert.equal(run.output.reason, reason);

          const evidence = foldLedger(f.session).records.filter(
            (row) => row.kind === "evidence"
          );

          assert.equal(evidence.length, 1);

          const { data } = defined(evidence[0], "evidence");

          assert.equal(data["exit"], exit);

          if (reason === "mutated") {
            assert.notEqual(data["before"], data["after"]);
          }

          if (reason === "checks-failed") {
            assert.equal(
              fs.existsSync(path.join(f.integration, "src/should-not-run")),
              false
            );
          }
        } finally {
          f.cleanup();
        }
      })
    );
  });

  test("runs a command shared by criteria once per tree and records evidence for each", async () => {
    const cases = [
      { target: "ignored", expected: "x", reason: undefined },
      { target: "src/file.ts", expected: "initial\nxx", reason: "mutated" },
    ] as const;

    await Promise.all(
      cases.map(async ({ target, expected, reason }) => {
        const f = await toolkitRepo(shared(target));

        try {
          const run = await f.run(["check", "run", "--criteria", "SC1,SC2"]);

          assert.equal(run.exit, 0, JSON.stringify(run));
          assert.equal(run.output.reason, reason);
          assert.equal(
            fs
              .readFileSync(path.join(f.integration, target), "utf-8")
              .replaceAll("\r\n", "\n"),
            expected
          );
          assert.deepEqual(
            foldLedger(f.session)
              .records.filter((row) => row.kind === "evidence")
              .map((row) => text(defined(row.data["criterion"], "criterion"))),
            ["SC1", "SC2"]
          );
        } finally {
          f.cleanup();
        }
      })
    );
  });

  test("recovers an evidence file written before a crash, then records each later check run", async () => {
    const f = await toolkitRepo();

    try {
      const crash = await f.run(
        ["check", "run", "--criteria", "SC1"],
        (point) => {
          if (point === "check:after-evidence") {
            throw new Error("crash");
          }
        }
      );

      assert.equal(crash.exit, 2, JSON.stringify(crash));
      assert.equal(
        narrow(crash.value, objectWith({ message: isString })).message,
        "crash",
        JSON.stringify(crash)
      );
      assert.equal(
        foldLedger(f.session).records.filter((row) => row.kind === "evidence")
          .length,
        0,
        JSON.stringify(crash)
      );
      assert.ok(
        fs
          .readdirSync(path.join(f.session, ".state/evidence"))
          .some((entry) => entry.endsWith(".json")),
        JSON.stringify(crash)
      );

      const recovered = await f.run(["check", "run", "--criteria", "SC1"]);

      const repeated = await f.run(["check", "run", "--criteria", "SC1"]);

      assert.equal(recovered.exit, 0, JSON.stringify(recovered));
      assert.equal(repeated.exit, 0, JSON.stringify(repeated));

      const evidence = foldLedger(f.session).records.filter(
        (row) => row.kind === "evidence"
      );

      assert.equal(evidence.length, 2, JSON.stringify({ recovered, repeated }));
      assert.notEqual(
        defined(evidence[0], "evidence").key,
        defined(evidence[1], "evidence").key
      );
      assert.notEqual(
        defined(evidence[0], "evidence").data["path"],
        defined(evidence[1], "evidence").data["path"]
      );
    } finally {
      f.cleanup();
    }
  });

  test("refuses a detached caller without creating an integration worktree", async () => {
    const f = await toolkitRepo();

    try {
      f.git(["checkout", "--detach"]);

      const run = await f.run(["check", "run"]);

      assert.equal(run.exit, 4);
      assert.equal(run.output.reason, "caller-detached");
      assert.equal(fs.existsSync(f.integration), false);
    } finally {
      f.cleanup();
    }
  });

  test("check run --task runs only the selected task criteria without contract and refuses invalid selectors", async () => {
    const multiTaskPlan = [
      "# Work",
      "",
      "## Task Map",
      "| ID | Title | Outcome | Prerequisites | Criteria |",
      "| --- | --- | --- | --- | --- |",
      "| T1 | First | First works | none | SC1, SC2 |",
      "| T2 | Second | Second works | none | SC3 |",
      "",
      "## Proposed Changes",
      "### T1 — First",
      "#### [MODIFY] src/file.ts",
      "- Purpose: updates first.",
      "### T2 — Second",
      "#### [NEW] src/other.ts",
      "- Purpose: adds second.",
      "",
      "## Success Criteria",
      "- [SC1] First works",
      "  - Changes: src/file.ts",
      '  - Check: `node -e "process.exit(0)"`',
      "  - Evidence: check",
      "- [SC2] First manual check",
      "  - Changes: src/file.ts",
      '  - Check: `node -e "process.exit(0)"`',
      "  - Evidence: review",
      "  - Review: artifact: src/file.ts; scenario: inspect; pass: ok",
      "- [SC3] Second works",
      "  - Changes: src/other.ts",
      '  - Check: `node -e "process.exit(0)"`',
      "  - Evidence: check",
      "",
      "## Verification Plan",
      "### Automated Tests",
      '- `node -e "process.exit(0)"`',
      "- `node -e \"process.stdout.write('contract')\"`",
      "",
    ].join("\n");

    const f = await toolkitRepo(multiTaskPlan);

    try {
      const run = await f.run(["check", "run", "--task", "T1"]);

      assert.equal(run.exit, 0, JSON.stringify(run));
      assert.equal(run.output.ok, true);

      const recorded = foldLedger(f.session)
        .records.filter((row) => row.kind === "evidence")
        .map((row) => text(defined(row.data["criterion"], "criterion")));

      assert.deepEqual(recorded, ["SC1"]);

      const both = await f.run([
        "check",
        "run",
        "--task",
        "T1",
        "--criteria",
        "SC1",
      ]);

      assert.equal(both.exit, 1);
      assert.equal(both.output.reason, "invalid-input");
      assert.match(both.output.summary, /check run/u);

      const unknownTask = await f.run(["check", "run", "--task", "T99"]);

      assert.equal(unknownTask.exit, 1);
      assert.equal(unknownTask.output.reason, "invalid-input");
      assert.match(unknownTask.output.summary, /T1.*T2/u);
    } finally {
      f.cleanup();
    }
  });

  test("refuses a non-contract criterion with zero Check commands while allowing an empty contract row", async () => {
    const noCommandPlan = [
      "# Work",
      "",
      "## Task Map",
      "| ID | Title | Outcome | Prerequisites | Criteria |",
      "| --- | --- | --- | --- | --- |",
      "| T1 | File | Works | none | SC1 |",
      "",
      "## Proposed Changes",
      "### T1 — File",
      "#### [MODIFY] src/file.ts",
      "- Purpose: implements behavior.",
      "",
      "## Success Criteria",
      "- [SC1] File works",
      "  - Changes: src/file.ts",
      "  - Evidence: check",
      "",
      "## Verification Plan",
      "### Automated Tests",
      "- None: all checks are in criteria.",
      "",
    ].join("\n");

    const f1 = await toolkitRepo(noCommandPlan);

    try {
      const run = await f1.run(["check", "run", "--criteria", "SC1"]);

      assert.equal(run.exit, 1);
      assert.equal(run.output.reason, "invalid-input");
      assert.match(run.output.summary, /SC1/u);
      assert.equal(fs.existsSync(f1.integration), false);
    } finally {
      f1.cleanup();
    }

    const emptyContractPlan = noCommandPlan.replace(
      "  - Evidence: check",
      '  - Check: `node -e "process.exit(0)"`\n  - Evidence: check'
    );

    const f2 = await toolkitRepo(emptyContractPlan);

    try {
      const run = await f2.run(["check", "run"]);

      assert.equal(run.exit, 0, JSON.stringify(run));
      assert.equal(run.output.ok, true);
      assert.equal(
        narrow(run.value, objectWith({ executed: isNumber })).executed,
        1
      );
      assert.match(run.output.summary, /\(1 commands\)/u);
    } finally {
      f2.cleanup();
    }
  });

  test("reports zero executed commands when all criteria are review and Automated Tests is None", async () => {
    const reviewOnlyPlan = [
      "# Work",
      "",
      "## Task Map",
      "| ID | Title | Outcome | Prerequisites | Criteria |",
      "| --- | --- | --- | --- | --- |",
      "| T1 | File | Works | none | SC1 |",
      "",
      "## Proposed Changes",
      "### T1 — File",
      "#### [MODIFY] src/file.ts",
      "- Purpose: implements behavior.",
      "",
      "## Success Criteria",
      "- [SC1] File works",
      "  - Changes: src/file.ts",
      "  - Evidence: review",
      "  - Review: artifact: src/file.ts; scenario: inspect; pass: ok",
      "",
      "## Verification Plan",
      "### Automated Tests",
      "- None: manual review only.",
      "",
    ].join("\n");

    const f = await toolkitRepo(reviewOnlyPlan);

    try {
      const run = await f.run(["check", "run"]);

      assert.equal(run.exit, 0, JSON.stringify(run));
      assert.equal(run.output.ok, true);
      assert.equal(
        narrow(run.value, objectWith({ executed: isNumber })).executed,
        0
      );
      assert.match(run.output.summary, /\(0 commands\)/u);
    } finally {
      f.cleanup();
    }
  });

  test("refuses an empty --criteria list without creating integration", async () => {
    await Promise.all(
      ["", " , "].map(async (criteria) => {
        const f = await toolkitRepo();

        try {
          const run = await f.run(["check", "run", "--criteria", criteria]);

          assert.equal(run.exit, 1);
          assert.equal(run.output.reason, "invalid-input");
          assert.match(run.output.summary, /check run --criteria/u);
          assert.equal(fs.existsSync(f.integration), false);
        } finally {
          f.cleanup();
        }
      })
    );
  });

  test("deduplicates shared commands within a check run and bypasses dedup with --fresh", async () => {
    const sharedCmd = `node -e "require('fs').appendFileSync('ignored','1')"`;

    const distinctCmd = `node -e "require('fs').appendFileSync('ignored','2')"`;

    const sharedPlan = planSource
      .replace("| SC1 |", "| SC1, SC2 |")
      .replace('`node -e "process.exit(0)"`', `\`${sharedCmd}\``)
      .replace(
        "\n## Verification Plan",
        (match) =>
          `- [SC2] Second criterion shares command\n  - Changes: src/file.ts\n  - Check: \`${sharedCmd}\`\n  - Check: \`${distinctCmd}\`\n  - Evidence: check\n${match}`
      );

    const f = await toolkitRepo(sharedPlan);

    try {
      const deduped = await f.run(["check", "run", "--criteria", "SC1,SC2"]);

      assert.equal(deduped.exit, 0, JSON.stringify(deduped));
      assert.equal(deduped.output.ok, true);

      const dedupedVal = narrow(deduped.value, isCheckRun);

      assert.equal(dedupedVal.executed, 2);
      assert.equal(dedupedVal.reused, 0);
      assert.equal(
        fs.readFileSync(path.join(f.integration, "ignored"), "utf-8"),
        "12"
      );

      const sc1Ev = evidenceOf(
        f.session,
        defined(dedupedVal.checks[0], "check").path
      );

      const sc2Ev = evidenceOf(
        f.session,
        defined(dedupedVal.checks[1], "check").path
      );

      const sc1Cmd = defined(sc1Ev.commands[0], "command");

      const sc2First = defined(sc2Ev.commands[0], "command");

      const sc2Second = defined(sc2Ev.commands[1], "command");

      assert.equal(sc1Cmd.mode, "fresh");
      assert.equal(sc2First.mode, "dedup");
      assert.equal(sc2First.execId, sc1Cmd.execId);
      assert.equal(sc2First.cacheHex, sc1Cmd.cacheHex);
      assert.equal(sc2Second.mode, "fresh");

      const fresh = await f.run([
        "check",
        "run",
        "--criteria",
        "SC1,SC2",
        "--fresh",
      ]);

      assert.equal(fresh.exit, 0, JSON.stringify(fresh));
      assert.equal(fresh.output.ok, true);

      const freshVal = narrow(fresh.value, isCheckRun);

      assert.equal(freshVal.executed, 3);
      assert.equal(freshVal.reused, 0);
      assert.equal(
        fs.readFileSync(path.join(f.integration, "ignored"), "utf-8"),
        "12112"
      );

      const freshSc1 = evidenceOf(
        f.session,
        defined(freshVal.checks[0], "check").path
      );

      const freshSc2 = evidenceOf(
        f.session,
        defined(freshVal.checks[1], "check").path
      );

      assert.equal(defined(freshSc1.commands[0], "command").mode, "fresh");
      assert.equal(defined(freshSc2.commands[0], "command").mode, "fresh");
      assert.notEqual(
        defined(freshSc1.commands[0], "command").execId,
        defined(freshSc2.commands[0], "command").execId
      );
    } finally {
      f.cleanup();
    }
  });

  test("reuses cached command evidence only with --reuse and preserves immutable provenance", async () => {
    const sharedCmd = `node -e "require('fs').appendFileSync('ignored','x')"`;

    const plan = planSource
      .replace("| SC1 |", "| SC1, SC2 |")
      .replace('`node -e "process.exit(0)"`', `\`${sharedCmd}\``)
      .replace(
        "\n## Verification Plan",
        (match) =>
          `- [SC2] Second shares\n  - Changes: src/file.ts\n  - Check: \`${sharedCmd}\`\n  - Evidence: check\n${match}`
      );

    const f = await toolkitRepo(plan);

    try {
      const first = await f.run(["check", "run"]);

      assert.equal(first.exit, 0, JSON.stringify(first));

      const firstVal = narrow(first.value, isCheckRun);

      assert.equal(firstVal.executed, 2);
      assert.equal(firstVal.reused, 0);
      assert.equal(
        fs.readFileSync(path.join(f.integration, "ignored"), "utf-8"),
        "x"
      );

      const sc1FirstPath = path.join(
        f.session,
        defined(firstVal.checks[0], "check").path
      );

      const sc1First = evidenceOf(
        f.session,
        defined(firstVal.checks[0], "check").path
      );

      const firstCmd = defined(sc1First.commands[0], "command");

      const execId1 = defined(firstCmd.execId, "execId");

      const cacheHex = defined(firstCmd.cacheHex, "cacheHex");

      assert.ok(execId1.length > 0);
      assert.equal(cacheHex.length, 64);

      const exec1JsonPath = path.join(
        f.session,
        ".state/evidence/commands",
        `${execId1}.json`
      );

      const exec1LogPath = path.join(
        f.session,
        ".state/evidence/commands",
        `${execId1}.log`
      );

      const exec1Snapshot = fs.readFileSync(exec1JsonPath, "utf-8");

      assert.ok(fs.existsSync(exec1LogPath));

      const secondNoFlag = await f.run(["check", "run"]);

      assert.equal(secondNoFlag.exit, 0, JSON.stringify(secondNoFlag));

      const secondVal = narrow(secondNoFlag.value, isCheckRun);

      assert.equal(secondVal.executed, 2);
      assert.equal(secondVal.reused, 0);
      assert.equal(
        fs.readFileSync(path.join(f.integration, "ignored"), "utf-8"),
        "xx"
      );

      const sc1Second = evidenceOf(
        f.session,
        defined(secondVal.checks[0], "check").path
      );

      const execId2 = defined(
        defined(sc1Second.commands[0], "command").execId,
        "execId"
      );

      assert.notEqual(execId2, execId1);
      assert.equal(fs.readFileSync(exec1JsonPath, "utf-8"), exec1Snapshot);

      const thirdReuse = await f.run(["check", "run", "--reuse"]);

      assert.equal(thirdReuse.exit, 0, JSON.stringify(thirdReuse));
      assert.equal(thirdReuse.output.ok, true);

      const thirdVal = narrow(thirdReuse.value, isCheckRun);

      assert.equal(thirdVal.executed, 0);
      assert.equal(thirdVal.reused, 2);
      assert.match(thirdReuse.output.summary, /; reused 2\b/u);
      assert.equal(
        fs.readFileSync(path.join(f.integration, "ignored"), "utf-8"),
        "xx"
      );

      for (const item of thirdVal.checks) {
        assert.ok(fs.existsSync(item.logPath), item.logPath);
      }

      const sc1ReusedPath = path.join(
        f.session,
        defined(thirdVal.checks[0], "check").path
      );

      const sc1ReusedSnapshot = fs.readFileSync(sc1ReusedPath, "utf-8");

      const sc1Reused = narrow(parseJson(sc1ReusedSnapshot), isEvidence);

      const sc2Dedup = evidenceOf(
        f.session,
        defined(thirdVal.checks[1], "check").path
      );

      const reusedCmd = defined(sc1Reused.commands[0], "command");

      const dedupCmd = defined(sc2Dedup.commands[0], "command");

      assert.equal(reusedCmd.mode, "reused");
      assert.equal(reusedCmd.execId, execId2);
      assert.equal(reusedCmd.cacheHex, cacheHex);
      assert.equal(dedupCmd.mode, "dedup");
      assert.equal(dedupCmd.execId, execId2);
      assert.equal(dedupCmd.cacheHex, cacheHex);

      const evidenceRecords = foldLedger(f.session).records.filter(
        (row) => row.kind === "evidence"
      );

      assert.equal(evidenceRecords.length, 9);

      for (const row of evidenceRecords) {
        assert.deepEqual(Object.keys(row.data).toSorted(), [
          "after",
          "before",
          "clean",
          "commandDigest",
          "criterion",
          "exit",
          "path",
          "tree",
        ]);
      }

      const status = await f.run(["status", "show"]);

      assert.equal(status.exit, 0);

      const statusVal = narrow(
        status.value,
        objectWith({
          criteria: arrayOf(isString),
          criterionStatuses: isStatuses,
        })
      );

      assert.deepEqual(statusVal.criteria, []);
      assert.ok(
        statusVal.criterionStatuses.every((row) => row.state === "verified")
      );

      // A later fresh execution updates index/<cacheHex>.json without mutating earlier reused provenance.
      const fourthFresh = await f.run(["check", "run"]);

      assert.equal(fourthFresh.exit, 0, JSON.stringify(fourthFresh));

      const fourthVal = narrow(fourthFresh.value, isCheckRun);

      assert.equal(fourthVal.executed, 2);
      assert.equal(fourthVal.reused, 0);

      const sc1Fourth = evidenceOf(
        f.session,
        defined(fourthVal.checks[0], "check").path
      );

      assert.notEqual(
        defined(sc1Fourth.commands[0], "command").execId,
        execId2
      );
      assert.equal(fs.readFileSync(sc1ReusedPath, "utf-8"), sc1ReusedSnapshot);
      assert.ok(
        fs.existsSync(
          path.join(f.session, ".state/evidence/commands", `${execId2}.json`)
        )
      );
      assert.ok(
        fs.existsSync(
          path.join(f.session, ".state/evidence/commands", `${execId2}.log`)
        )
      );

      const pointer = narrow(
        parseJson(
          fs.readFileSync(
            path.join(
              f.session,
              ".state/evidence/commands/index",
              `${cacheHex}.json`
            ),
            "utf-8"
          )
        ),
        objectWith({ execId: isString })
      );

      assert.equal(
        pointer.execId,
        defined(sc1Fourth.commands[0], "command").execId
      );

      assert.ok(fs.existsSync(sc1FirstPath));
    } finally {
      f.cleanup();
    }
  });

  test("enforces pass-fail-pass and fail-pass-fail latest-record ordering on the same tree", async () => {
    const toggleCmd = `node -e "process.exit(require('fs').readFileSync('ignored','utf-8').trim()==='pass'?0:1)"`;

    const plan = planSource.replace(
      '`node -e "process.exit(0)"`',
      `\`${toggleCmd}\``
    );

    const f = await toolkitRepo(plan);

    try {
      const sc1State = async () => {
        const status = await f.run(["status", "show"]);

        assert.equal(status.exit, 0);

        return narrow(
          status.value,
          objectWith({ criterionStatuses: isStatuses })
        ).criterionStatuses.find((row) => row.criterion === "SC1")?.state;
      };

      const contractRun = await f.run([
        "check",
        "run",
        "--criteria",
        "contract",
      ]);

      assert.equal(contractRun.exit, 0);

      // pass -> fail -> pass on the exact same clean Git tree
      setMode(f.integration, "pass");

      const pass1 = await f.run(["check", "run", "--criteria", "SC1"]);

      assert.equal(pass1.output.ok, true);
      assert.equal(await sc1State(), "verified");

      const pass1Ev = evidenceOf(
        f.session,
        defined(narrow(pass1.value, isCheckRun).checks[0], "check").path
      );

      const pass1Cmd = defined(pass1Ev.commands[0], "command");

      const pass1ExecId = defined(pass1Cmd.execId, "execId");

      const pass1CacheHex = defined(pass1Cmd.cacheHex, "cacheHex");

      const pass1ExecJson = path.join(
        f.session,
        ".state/evidence/commands",
        `${pass1ExecId}.json`
      );

      const pass1ExecLog = path.join(
        f.session,
        ".state/evidence/commands",
        `${pass1ExecId}.log`
      );

      const pass1Snapshot = fs.readFileSync(pass1ExecJson, "utf-8");

      setMode(f.integration, "fail");

      const fail1 = await f.run(["check", "run", "--criteria", "SC1"]);

      assert.equal(fail1.output.ok, false);
      assert.equal(fail1.output.reason, "checks-failed");
      assert.equal(await sc1State(), "missing");
      // Failing on the same clean tree invalidates index/<cacheHex>.json while keeping immutable <execId>.{json,log}.
      assert.equal(
        fs.existsSync(
          path.join(
            f.session,
            ".state/evidence/commands/index",
            `${pass1CacheHex}.json`
          )
        ),
        false
      );
      assert.equal(fs.readFileSync(pass1ExecJson, "utf-8"), pass1Snapshot);
      assert.ok(fs.existsSync(pass1ExecLog));

      // Subsequent --reuse executes freshly and does NOT resurrect the older pass.
      const reuseAfterFail = await f.run([
        "check",
        "run",
        "--criteria",
        "SC1",
        "--reuse",
      ]);

      assert.equal(reuseAfterFail.output.ok, false);
      assert.equal(reuseAfterFail.output.reason, "checks-failed");

      const reuseAfterFailVal = narrow(reuseAfterFail.value, isCheckRun);

      assert.equal(reuseAfterFailVal.executed, 1);
      assert.equal(reuseAfterFailVal.reused, 0);
      assert.equal(await sc1State(), "missing");

      setMode(f.integration, "pass");

      const passAgain = await f.run(["check", "run", "--criteria", "SC1"]);

      assert.equal(passAgain.output.ok, true);
      assert.equal(await sc1State(), "verified");

      // fail -> pass -> fail on a fresh session on the same clean Git tree
      const s2 = await f.second("20261023T0001Z-second");

      const s2Contract = await s2.run([
        "check",
        "run",
        "--criteria",
        "contract",
      ]);

      assert.equal(s2Contract.exit, 0);

      const s2State = async () => {
        const status = await s2.run(["status", "show"]);

        assert.equal(status.exit, 0);

        return narrow(
          status.value,
          objectWith({ criterionStatuses: isStatuses })
        ).criterionStatuses.find((row) => row.criterion === "SC1")?.state;
      };

      setMode(s2.integration, "fail");

      const s2Fail1 = await s2.run(["check", "run", "--criteria", "SC1"]);

      assert.equal(s2Fail1.output.ok, false);
      assert.equal(await s2State(), "missing");

      setMode(s2.integration, "pass");

      const s2Pass = await s2.run(["check", "run", "--criteria", "SC1"]);

      assert.equal(s2Pass.output.ok, true);
      assert.equal(await s2State(), "verified");

      setMode(s2.integration, "fail");

      const s2Fail2 = await s2.run(["check", "run", "--criteria", "SC1"]);

      assert.equal(s2Fail2.output.ok, false);
      assert.equal(await s2State(), "missing");
    } finally {
      f.cleanup();
    }
  });

  test("falls back to fresh execution on misdirected index, torn JSON, malformed cache fields, or stale log", async () => {
    const cmd = `node -e "require('fs').appendFileSync('ignored','r')"`;

    const plan = planSource.replace(
      '`node -e "process.exit(0)"`',
      `\`${cmd}\``
    );

    const f = await toolkitRepo(plan);

    try {
      const seed = async () => {
        const run = await f.run(["check", "run", "--criteria", "SC1"]);

        assert.equal(run.exit, 0);

        const evidence = evidenceOf(
          f.session,
          defined(narrow(run.value, isCheckRun).checks[0], "check").path
        );

        const seededCmd = defined(evidence.commands[0], "command");

        return {
          execId: defined(seededCmd.execId, "execId"),
          cacheHex: defined(seededCmd.cacheHex, "cacheHex"),
        };
      };

      const verifyFallback = async (label: string) => {
        const before = fs.readFileSync(
          path.join(f.integration, "ignored"),
          "utf-8"
        );

        const run = await f.run([
          "check",
          "run",
          "--criteria",
          "SC1",
          "--reuse",
        ]);

        assert.equal(run.exit, 0, label);
        assert.equal(run.output.ok, true, label);

        const val = narrow(run.value, isCheckRun);

        assert.equal(val.executed, 1, label);
        assert.equal(val.reused, 0, label);
        assert.equal(
          fs.readFileSync(path.join(f.integration, "ignored"), "utf-8"),
          `${before}r`,
          label
        );
      };

      // 1. Misdirected index -> non-existent UUID
      let seeded = await seed();

      const indexFile = path.join(
        f.session,
        ".state/evidence/commands/index",
        `${seeded.cacheHex}.json`
      );

      fs.writeFileSync(
        indexFile,
        JSON.stringify({ execId: crypto.randomUUID() })
      );
      await verifyFallback("misdirected missing UUID");

      // 2. Invalid UUID shape (path traversal attempt)
      seeded = await seed();
      fs.writeFileSync(indexFile, JSON.stringify({ execId: "../escape" }));
      await verifyFallback("invalid UUID shape");

      // 3. Torn JSON in index and in exec record
      seeded = await seed();
      fs.writeFileSync(indexFile, "{torn");
      await verifyFallback("torn index JSON");

      seeded = await seed();

      const execFile = path.join(
        f.session,
        ".state/evidence/commands",
        `${seeded.execId}.json`
      );

      fs.writeFileSync(execFile, "{torn");
      await verifyFallback("torn exec JSON");

      // 4. Malformed cache fields (wrong type / tampered logPath / mismatched command)
      seeded = await seed();

      const execPath4 = path.join(
        f.session,
        ".state/evidence/commands",
        `${seeded.execId}.json`
      );

      const validExec = parseJson(fs.readFileSync(execPath4, "utf-8"));

      if (!isRecord(validExec)) {
        assert.fail("exec record must be an object");
      }

      fs.writeFileSync(execPath4, JSON.stringify({ ...validExec, exit: "0" }));
      await verifyFallback("wrong exit type");

      seeded = await seed();

      const execPath5 = path.join(
        f.session,
        ".state/evidence/commands",
        `${seeded.execId}.json`
      );

      const validExec5 = parseJson(fs.readFileSync(execPath5, "utf-8"));

      if (!isRecord(validExec5)) {
        assert.fail("exec record must be an object");
      }

      fs.writeFileSync(
        execPath5,
        JSON.stringify({
          ...validExec5,
          logPath: ".state/evidence/commands/other.log",
        })
      );
      await verifyFallback("tampered logPath");

      seeded = await seed();

      const execPath6 = path.join(
        f.session,
        ".state/evidence/commands",
        `${seeded.execId}.json`
      );

      const validExec6 = parseJson(fs.readFileSync(execPath6, "utf-8"));

      if (!isRecord(validExec6)) {
        assert.fail("exec record must be an object");
      }

      fs.writeFileSync(
        execPath6,
        JSON.stringify({ ...validExec6, command: 'node -e "process.exit(0)"' })
      );
      await verifyFallback("mismatched command");

      // 5. Stale / modified log file (logSha256 mismatch) and missing log
      seeded = await seed();
      fs.writeFileSync(
        path.join(
          f.session,
          ".state/evidence/commands",
          `${seeded.execId}.log`
        ),
        "tampered log"
      );
      await verifyFallback("stale log hash");

      seeded = await seed();
      fs.rmSync(
        path.join(f.session, ".state/evidence/commands", `${seeded.execId}.log`)
      );
      await verifyFallback("missing log file");
    } finally {
      f.cleanup();
    }
  });

  test("never caches or reuses dirty, mutating, restore-pair, or non-zero commands", async () => {
    // Dirty checkout
    const fDirty = await toolkitRepo();

    try {
      await fDirty.run(["check", "run", "--criteria", "contract"]);

      fs.writeFileSync(path.join(fDirty.integration, "dirty.txt"), "dirty");

      const run = await fDirty.run(["check", "run", "--criteria", "SC1"]);

      assert.equal(run.output.ok, false);
      assert.equal(run.output.reason, "dirty");

      const evidence = evidenceOf(
        fDirty.session,
        defined(narrow(run.value, isCheckRun).checks[0], "check").path
      );

      const dirtyCmd = defined(evidence.commands[0], "command");

      assert.equal(dirtyCmd.execId, null);
      assert.equal(dirtyCmd.cacheHex, null);
      assert.match(dirtyCmd.logPath, /^\.state\/evidence\/runs\//u);

      fs.rmSync(path.join(fDirty.integration, "dirty.txt"));

      const retry = await fDirty.run([
        "check",
        "run",
        "--criteria",
        "SC1",
        "--reuse",
      ]);

      const retryVal = narrow(retry.value, isCheckRun);

      assert.equal(retryVal.executed, 1);
      assert.equal(retryVal.reused, 0);
    } finally {
      fDirty.cleanup();
    }

    // Mutating command
    const mutatingPlan = planSource.replace(
      '`node -e "process.exit(0)"`',
      "`node -e \"require('fs').writeFileSync('src/file.ts','mutated')\"`"
    );

    const fMut = await toolkitRepo(mutatingPlan);

    try {
      const run = await fMut.run(["check", "run", "--criteria", "SC1"]);

      assert.equal(run.output.reason, "mutated");
      assert.deepEqual(indexFiles(fMut.session), []);

      const evidence = evidenceOf(
        fMut.session,
        defined(narrow(run.value, isCheckRun).checks[0], "check").path
      );

      const mutCmd = defined(evidence.commands[0], "command");

      assert.equal(mutCmd.execId, null);
      assert.equal(mutCmd.cacheHex, null);
    } finally {
      fMut.cleanup();
    }

    // Restore-pair (cmd1 mutates src/file.ts, cmd2 restores it)
    const restorePlan = planSource.replace(
      '  - Check: `node -e "process.exit(0)"`',
      [
        "  - Check: `node -e \"require('fs').writeFileSync('src/file.ts','mutated')\"`",
        "  - Check: `node -e \"require('fs').writeFileSync('src/file.ts','initial\\n')\"`",
      ].join("\n")
    );

    const fRestore = await toolkitRepo(restorePlan);

    try {
      const first = await fRestore.run(["check", "run", "--criteria", "SC1"]);

      assert.equal(first.exit, 0, JSON.stringify(first));

      const firstVal = narrow(first.value, isCheckRun);

      assert.equal(firstVal.executed, 2);
      assert.deepEqual(indexFiles(fRestore.session), []);

      const evidence = evidenceOf(
        fRestore.session,
        defined(firstVal.checks[0], "check").path
      );

      assert.equal(defined(evidence.commands[0], "command").execId, null);
      assert.equal(defined(evidence.commands[1], "command").execId, null);

      const second = await fRestore.run([
        "check",
        "run",
        "--criteria",
        "SC1",
        "--reuse",
      ]);

      const secondVal = narrow(second.value, isCheckRun);

      assert.equal(secondVal.executed, 2);
      assert.equal(secondVal.reused, 0);
    } finally {
      fRestore.cleanup();
    }

    // Non-zero command
    const failPlan = planSource.replace(
      '`node -e "process.exit(0)"`',
      '`node -e "process.exit(7)"`'
    );

    const fFail = await toolkitRepo(failPlan);

    try {
      const first = await fFail.run(["check", "run", "--criteria", "SC1"]);

      assert.equal(first.output.reason, "checks-failed");
      assert.deepEqual(indexFiles(fFail.session), []);

      const evidence = evidenceOf(
        fFail.session,
        defined(narrow(first.value, isCheckRun).checks[0], "check").path
      );

      const failCmd = defined(evidence.commands[0], "command");

      assert.equal(failCmd.execId, null);
      assert.equal(failCmd.cacheHex, null);
      assert.match(failCmd.logPath, /^\.state\/evidence\/runs\//u);

      const second = await fFail.run([
        "check",
        "run",
        "--criteria",
        "SC1",
        "--reuse",
      ]);

      const secondVal = narrow(second.value, isCheckRun);

      assert.equal(secondVal.executed, 1);
      assert.equal(secondVal.reused, 0);
    } finally {
      fFail.cleanup();
    }
  });
});
