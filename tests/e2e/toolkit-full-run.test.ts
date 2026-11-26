import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type { JsonObject } from "../../skills/dispatch/scripts/lib/config.ts";
import { isRecord } from "../../skills/dispatch/scripts/lib/config.ts";
import { parseJson } from "../../skills/dispatch/scripts/lib/integrity.ts";
import { artifactHash } from "../../skills/dispatch/scripts/toolkit/artifacts.ts";
import { foldLedger } from "../../skills/dispatch/scripts/toolkit/ledger.ts";
import { fixture, CLEAN } from "../helpers/e2e.ts";
import {
  arrayOf,
  defined,
  isBoolean,
  isString,
  maybe,
  narrow,
  nullable,
  objectWith,
  text,
} from "./helpers/json.ts";
import { contextMapSource, planSource } from "./helpers/toolkit-repo.ts";

const replyGuard = objectWith({
  path: maybe(isString),
  source: maybe(isString),
  from: maybe(isString),
  ref: maybe(isString),
  delivered: maybe(
    (value): value is boolean | JsonObject =>
      isBoolean(value) || isRecord(value)
  ),
  skipped: maybe(isBoolean),
  findings: maybe(arrayOf(isRecord)),
});

const outputGuard = objectWith({
  summary: isString,
  path: maybe(nullable(isString)),
  reason: maybe(isString),
});

const readReply = (file: string) =>
  narrow(parseJson(fs.readFileSync(file, "utf-8")), replyGuard);

test("uncommitted delivery through public entry preserves standalone review", async () => {
  const f = fixture({ responses: [CLEAN, CLEAN, CLEAN] });

  try {
    const plan = planSource
      .replaceAll("src/file.ts", "src/a.ts")
      .replace(
        'node -e "process.exit(0)"',
        `node -e "require('assert').match(require('fs').readFileSync('src/a.ts','utf-8'),/value = 2/)"`
      )
      .replace(
        "| T1 | File | Works | none | SC1 |",
        "| T1 | File | Works | none | SC1 |\n| T2 | Review | Source review is recorded | none | SC2 |"
      )
      .replace(
        "## Success Criteria",
        "### T2 — Review\n#### [NEW] docs/review.md\n- Purpose: records the review outcome.\n\n## Success Criteria"
      )
      .replace(
        "  - Evidence: check\n\n## Verification Plan",
        "  - Evidence: check\n- [SC2] Source review is complete\n  - Changes: docs/review.md\n  - Evidence: review\n  - Review: artifact: docs/review.md; scenario: inspect the delivered behavior; pass: the user records review evidence\n\n## Verification Plan"
      );

    fs.writeFileSync(path.join(f.repo, "work.plan.md"), plan);
    fs.writeFileSync(
      path.join(f.repo, "work.plan.context.md"),
      contextMapSource
    );
    f.git("add", "work.plan.md", "work.plan.context.md");
    f.git("commit", "-qm", "plan");

    const run = async (args: string[], expected = 0) => {
      const pending = f.launch(args);
      const result = await pending.done;

      assert.equal(result.exit, expected, result.stderr + result.stdout);

      const lines = result.stdout.trim().split(/\r?\n/u);

      assert.equal(lines.length, 1);

      const output = narrow(parseJson(defined(lines[0])), outputGuard);

      assert.ok(Buffer.byteLength(output.summary, "utf-8") <= 1024);

      for (const key of ["v", "run", "reply", "await", "at"]) {
        assert.equal(Object.hasOwn(output, key), false, key);
      }

      return output;
    };

    const sessionInit = await run([
      "session",
      "init",
      "--objective",
      "Toolkit delivery",
      "--session-id",
      "toolkit-full-run",
      "--host",
      "claude",
    ]);

    const session = text(defined(sessionInit.path));

    const tool = async (args: string[]) => {
      const output = await run([...args, "--session", session]);

      return readReply(text(defined(output.path)));
    };

    const bindFile = path.join(f.dir, "bind.json");

    fs.writeFileSync(
      bindFile,
      JSON.stringify({
        kind: "bind",
        key: "bind",
        by: "orchestrator",
        data: { spec: "governing.spec.md", plan: "work.plan.md" },
      })
    );

    await tool(["ledger", "append", bindFile]);

    const levelFile = path.join(f.dir, "level.json");

    fs.writeFileSync(
      levelFile,
      JSON.stringify({
        kind: "level",
        key: "level",
        by: "orchestrator",
        data: { level: "low" },
      })
    );

    await tool(["ledger", "append", levelFile]);

    const confirmFile = path.join(f.dir, "confirm.json");

    fs.writeFileSync(
      confirmFile,
      JSON.stringify({
        kind: "confirm",
        key: "confirm",
        by: "user",
        quote: "confirmed",
        data: {
          spec: artifactHash(
            "spec",
            fs.readFileSync(path.join(f.repo, "governing.spec.md"), "utf-8")
          ),
        },
      })
    );

    await tool(["ledger", "append", confirmFile]);
    await tool(["lint", "run", "work.plan.md"]);

    const review = async (args: string[]) => {
      const result = await tool(["review", "run", ...args, "--host", "codex"]);

      assert.equal(result.skipped, undefined);

      return readReply(text(defined(result.path)));
    };

    const reviewed = await review(["work.plan.md", "--kind", "plan"]);

    assert.equal(reviewed.skipped, undefined);
    assert.deepEqual(reviewed.findings, []);
    assert.equal(f.launches().length, 1, "plan review launches the stub");

    const writer = await tool(["worktree", "create", "T1"]);
    const brief = await tool(["brief", "render", "T1", "--host", "codex"]);

    assert.ok(
      fs.readFileSync(text(defined(brief.path)), "utf-8").includes("src/a.ts")
    );

    fs.writeFileSync(
      path.resolve(session, text(defined(writer.path)), "src/a.ts"),
      "export const value = 2;\n"
    );

    await tool(["worktree", "submit", "T1"]);
    await tool(["worktree", "integrate", "T1"]);

    const beforeReviewVerify = foldLedger(session).records.length;

    const reviewRefusal = await run(
      ["check", "run", "--criteria", "SC2", "--session", session],
      1
    );

    assert.equal(reviewRefusal.reason, "invalid-input");
    assert.match(reviewRefusal.summary, /review/iu);
    assert.equal(foldLedger(session).records.length, beforeReviewVerify);
    assert.equal(
      fs.existsSync(path.join(session, ".state", "evidence")),
      false
    );

    await tool(["check", "run"]);

    const toolEvidence = foldLedger(session).records.filter(
      (record) => record.kind === "evidence"
    );

    assert.deepEqual(
      toolEvidence.map((record) => text(defined(record.data["criterion"]))),
      ["SC1", "contract"]
    );

    const integrationReview = await review(["integration", "--kind", "code"]);

    assert.deepEqual(integrationReview.findings, []);

    const proofFile = path.join(f.dir, "proof.json");

    const openedRecord = defined(
      foldLedger(session).records.find((r) => r.data["phase"] === "opened"),
      "opened integrate record"
    );

    fs.writeFileSync(
      proofFile,
      JSON.stringify({
        kind: "integrate",
        by: "orchestrator",
        data: {
          phase: "verification",
          cycle: 1,
          outcome: "no-op",
          head: defined(openedRecord.data["base"], "opened base"),
          reason: "fixture",
          open: [],
        },
      })
    );

    await tool(["ledger", "append", proofFile]);

    const callerHead = f.git("rev-parse", "HEAD").trim();
    const delivered = await tool(["worktree", "deliver"]);

    assert.ok(isString(delivered.source));
    assert.equal(f.git("rev-parse", "HEAD").trim(), callerHead);
    assert.equal(delivered.from, callerHead);
    assert.equal(
      fs.readFileSync(path.join(f.repo, "src/a.ts"), "utf-8"),
      "export const value = 2;\n"
    );

    const incomplete = await run(
      ["report", "complete", "--session", session],
      4
    );

    assert.equal(incomplete.reason, "criteria-unmet");

    const manualFile = path.join(f.dir, "review-manual.json");

    fs.writeFileSync(
      manualFile,
      JSON.stringify({
        kind: "manual-complete",
        key: "review-manual",
        by: "user",
        quote: "I reviewed the delivered behavior against the scenario.",
        data: { criterion: "SC2", evidence: "manual/docs-review.md" },
      })
    );

    await tool(["ledger", "append", manualFile]);

    const report = await tool(["report", "complete"]);

    const walkthrough = fs.readFileSync(
      path.resolve(session, text(defined(report.path))),
      "utf-8"
    );

    assert.match(walkthrough, /Verified[\s\S]*SC1/u);
    assert.match(walkthrough, /Manual[\s\S]*SC2/u);

    await tool(["worktree", "cleanup"]);

    assert.equal(
      fs.existsSync(path.resolve(session, text(defined(writer.path)))),
      false
    );
    assert.equal(
      fs.readFileSync(path.join(f.repo, "src/a.ts"), "utf-8"),
      "export const value = 2;\n"
    );

    const retried = await tool(["worktree", "deliver"]);

    assert.equal(retried.delivered, false);
    assert.equal(retried.source, delivered.source);
    assert.equal(
      f.git("rev-parse", text(defined(delivered.ref))).trim(),
      delivered.source
    );

    const codeRange = `${delivered.from}..${delivered.ref}`;

    const codeReview = await review([
      codeRange,
      "--kind",
      "code",
      "--spec",
      "governing.spec.md",
    ]);

    assert.deepEqual(codeReview.findings, []);
    assert.equal(f.launches().length, 3);
  } finally {
    f.cleanup();
  }
});
