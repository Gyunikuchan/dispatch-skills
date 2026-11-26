import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import type { JsonValue } from "../../skills/dispatch/scripts/lib/config.ts";
import { parseJson } from "../../skills/dispatch/scripts/lib/integrity.ts";
import {
  currentHashes,
  foldLedger,
  latest,
} from "../../skills/dispatch/scripts/toolkit/ledger.ts";
import { fixture } from "../helpers/e2e.ts";
import {
  arrayOf,
  defined,
  isBoolean,
  isString,
  maybe,
  narrow,
  nullable,
  objectWith,
} from "./helpers/json.ts";
import { toolkitRepo } from "./helpers/toolkit-repo.ts";

const CLI_ENTRY = path.resolve("skills/dispatch/scripts/toolkit/cli.ts");

const runCli = (
  args: string[],
  options: {
    cwd: string;
    stdin?: string;
    env?: NodeJS.ProcessEnv;
    entry?: string;
  }
) => {
  const res = spawnSync(
    process.execPath,
    [options.entry ?? CLI_ENTRY, ...args],
    {
      cwd: options.cwd,
      env: options.env ?? process.env,
      input: options.stdin,
      encoding: "utf-8",
      windowsHide: true,
    }
  );

  assert.equal(res.error, undefined, res.error?.message);

  const lines = res.stdout.trim().split(/\r?\n/u).filter(Boolean);

  assert.equal(
    lines.length,
    1,
    `Expected 1 JSON stdout line, got:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`
  );

  const output = narrow(
    parseJson(defined(lines[0], "cli line")),
    objectWith({
      ok: isBoolean,
      summary: isString,
      path: nullable(isString),
      reason: maybe(isString),
      hint: maybe(isString),
    })
  );

  const value: JsonValue | null =
    output.path === null || output.path === ""
      ? null
      : parseJson(
          fs.readFileSync(defined(output.path, "output path"), "utf-8")
        );

  return {
    exit: res.status ?? -1,
    output,
    value,
    stderr: res.stderr,
  };
};

const hasShell = (cmd: string, args: string[]) => {
  const res = spawnSync(cmd, args, { encoding: "utf-8", windowsHide: true });

  return res.error === undefined && res.status === 0;
};

const HAS_POWERSHELL =
  process.platform === "win32" &&
  hasShell("powershell.exe", [
    "-NoProfile",
    "-Command",
    "$PSVersionTable.PSVersion.Major",
  ]);

const HAS_SH = hasShell("sh", ["-c", "true"]);

const shQuote = (value: string) =>
  `'${value.replaceAll("'", String.raw`'\''`)}'`;

const briefPathOf = (value: JsonValue | null) =>
  narrow(defined(value, "brief value"), objectWith({ briefPath: isString }))
    .briefPath;

describe("CLI payload matrix and shell quoting", () => {
  test("brief explorer, brief test-cleanup, brief verifier, and lint run accept file, stdin -, inline flags, and fail closed on conflicts", async () => {
    const r = await toolkitRepo();

    try {
      await r.approve();
      await r.level("low");

      const base = r.git(["rev-parse", "HEAD"]);

      const expPayload = {
        objective: "Map inputs",
        questions: ["How do inputs parse?"],
        outputPath: path.join(r.session, "exp.context.md"),
      };

      const expFile = path.join(r.root, "explorer.json");

      fs.writeFileSync(expFile, JSON.stringify(expPayload));

      const expFileRes = runCli(
        [
          "brief",
          "explorer",
          expFile,
          "--session",
          r.session,
          "--host",
          "codex",
        ],
        { cwd: r.root }
      );

      assert.equal(expFileRes.exit, 0, "file");
      assert.equal(expFileRes.output.ok, true, "file");
      assert.match(
        fs.readFileSync(briefPathOf(expFileRes.value), "utf-8"),
        /How do inputs parse\?/u
      );

      const expStdinRes = runCli(
        ["brief", "explorer", "-", "--session", r.session, "--host", "codex"],
        { cwd: r.root, stdin: `﻿${JSON.stringify(expPayload)}` }
      );

      assert.equal(expStdinRes.exit, 0, "stdin");
      assert.equal(expStdinRes.output.ok, true, "stdin");
      assert.match(
        fs.readFileSync(briefPathOf(expStdinRes.value), "utf-8"),
        /How do inputs parse\?/u
      );

      const expInlineRes = runCli(
        [
          "brief",
          "explorer",
          "--json",
          JSON.stringify(expPayload),
          "--session",
          r.session,
          "--host",
          "codex",
        ],
        { cwd: r.root }
      );

      assert.equal(expInlineRes.exit, 0, "inline");
      assert.equal(expInlineRes.output.ok, true, "inline");
      assert.match(
        fs.readFileSync(briefPathOf(expInlineRes.value), "utf-8"),
        /How do inputs parse\?/u
      );

      const expConflict = runCli(
        [
          "brief",
          "explorer",
          expFile,
          "--json",
          JSON.stringify(expPayload),
          "--session",
          r.session,
          "--host",
          "codex",
        ],
        { cwd: r.root }
      );

      assert.equal(expConflict.exit, 1);
      assert.equal(expConflict.output.reason, "invalid-input");

      const tcPayload = { base, integrationPath: r.integration };

      const tcFile = path.join(r.root, "test-cleanup.json");

      fs.writeFileSync(tcFile, JSON.stringify(tcPayload));

      const tcFileRes = runCli(
        [
          "brief",
          "test-cleanup",
          tcFile,
          "--session",
          r.session,
          "--host",
          "codex",
        ],
        { cwd: r.root }
      );

      assert.equal(tcFileRes.exit, 0, "file");
      assert.equal(tcFileRes.output.ok, true, "file");
      assert.ok(
        fs.readFileSync(briefPathOf(tcFileRes.value), "utf-8").includes(base)
      );

      const tcStdinRes = runCli(
        [
          "brief",
          "test-cleanup",
          "-",
          "--session",
          r.session,
          "--host",
          "codex",
        ],
        { cwd: r.root, stdin: JSON.stringify(tcPayload) }
      );

      assert.equal(tcStdinRes.exit, 0, "stdin");
      assert.equal(tcStdinRes.output.ok, true, "stdin");
      assert.ok(
        fs.readFileSync(briefPathOf(tcStdinRes.value), "utf-8").includes(base)
      );

      const tcInlineRes = runCli(
        [
          "brief",
          "test-cleanup",
          "--json",
          JSON.stringify(tcPayload),
          "--session",
          r.session,
          "--host",
          "codex",
        ],
        { cwd: r.root }
      );

      assert.equal(tcInlineRes.exit, 0, "inline");
      assert.equal(tcInlineRes.output.ok, true, "inline");
      assert.ok(
        fs.readFileSync(briefPathOf(tcInlineRes.value), "utf-8").includes(base)
      );

      const tcDirectRes = runCli(
        [
          "brief",
          "test-cleanup",
          "--base",
          base,
          "--integration-path",
          r.integration,
          "--session",
          r.session,
          "--host",
          "codex",
        ],
        { cwd: r.root }
      );

      assert.equal(tcDirectRes.exit, 0, "direct");
      assert.equal(tcDirectRes.output.ok, true, "direct");
      assert.ok(
        fs.readFileSync(briefPathOf(tcDirectRes.value), "utf-8").includes(base)
      );

      const badCases = [
        [
          "brief",
          "test-cleanup",
          "--base",
          base,
          "--session",
          r.session,
          "--host",
          "codex",
        ],
        [
          "brief",
          "test-cleanup",
          "--integration-path",
          r.integration,
          "--session",
          r.session,
          "--host",
          "codex",
        ],
        [
          "brief",
          "test-cleanup",
          tcFile,
          "--base",
          base,
          "--integration-path",
          r.integration,
          "--session",
          r.session,
          "--host",
          "codex",
        ],
        [
          "brief",
          "test-cleanup",
          "--json",
          JSON.stringify(tcPayload),
          "--base",
          base,
          "--integration-path",
          r.integration,
          "--session",
          r.session,
          "--host",
          "codex",
        ],
      ];

      for (const badArgs of badCases) {
        const bad = runCli(badArgs, { cwd: r.root });

        assert.equal(bad.exit, 1, badArgs.join(" "));
        assert.equal(bad.output.reason, "invalid-input", badArgs.join(" "));
      }

      const verPayload = {
        checkoutPath: r.integration,
        base,
        specPath: path.join(r.root, "work.spec.md"),
        focus: "Check CLI inputs",
      };

      const verFile = path.join(r.root, "verifier.json");

      fs.writeFileSync(verFile, JSON.stringify(verPayload));

      const verFileRes = runCli(
        [
          "brief",
          "verifier",
          verFile,
          "--session",
          r.session,
          "--host",
          "codex",
        ],
        { cwd: r.root }
      );

      assert.equal(verFileRes.exit, 0, "file");
      assert.equal(verFileRes.output.ok, true, "file");
      assert.match(
        fs.readFileSync(briefPathOf(verFileRes.value), "utf-8"),
        /Check CLI inputs/u
      );

      const verStdinRes = runCli(
        ["brief", "verifier", "-", "--session", r.session, "--host", "codex"],
        { cwd: r.root, stdin: JSON.stringify(verPayload) }
      );

      assert.equal(verStdinRes.exit, 0, "stdin");
      assert.equal(verStdinRes.output.ok, true, "stdin");
      assert.match(
        fs.readFileSync(briefPathOf(verStdinRes.value), "utf-8"),
        /Check CLI inputs/u
      );

      const verInlineRes = runCli(
        [
          "brief",
          "verifier",
          "--json",
          JSON.stringify(verPayload),
          "--session",
          r.session,
          "--host",
          "codex",
        ],
        { cwd: r.root }
      );

      assert.equal(verInlineRes.exit, 0, "inline");
      assert.equal(verInlineRes.output.ok, true, "inline");
      assert.match(
        fs.readFileSync(briefPathOf(verInlineRes.value), "utf-8"),
        /Check CLI inputs/u
      );

      const verConflict = runCli(
        [
          "brief",
          "verifier",
          verFile,
          "--json",
          JSON.stringify(verPayload),
          "--session",
          r.session,
          "--host",
          "codex",
        ],
        { cwd: r.root }
      );

      assert.equal(verConflict.exit, 1);
      assert.equal(verConflict.output.reason, "invalid-input");

      const planFile = path.join(r.root, "work.plan.md");

      const initialPlanHash = defined(
        currentHashes(r.root, latest(foldLedger(r.session), "bind")).plan,
        "plan hash"
      );

      const editFile = path.join(r.root, "edit.json");

      const edit1 = {
        class: "non-intent",
        affects: ["T1"],
        rationale: "Edit via file",
        diffRef: "d1",
        before: initialPlanHash,
      };

      fs.writeFileSync(editFile, JSON.stringify(edit1));

      fs.writeFileSync(
        planFile,
        fs
          .readFileSync(planFile, "utf-8")
          .replace("implements behavior.", "implements behavior 1.")
      );

      const lintFileRes = runCli(
        ["lint", "run", planFile, "--edit", editFile, "--session", r.session],
        { cwd: r.root }
      );

      assert.equal(lintFileRes.exit, 0);
      assert.equal(
        narrow(
          defined(lintFileRes.value, "lint value"),
          objectWith({ edit: objectWith({ deduped: isBoolean }) })
        ).edit.deduped,
        false
      );

      fs.writeFileSync(
        planFile,
        fs
          .readFileSync(planFile, "utf-8")
          .replace("implements behavior 1.", "implements behavior 2.")
      );

      const edit2 = {
        class: "non-intent",
        affects: ["T1"],
        rationale: "Edit via stdin",
        diffRef: "d2",
      };

      const lintStdinRes = runCli(
        ["lint", "run", planFile, "--edit", "-", "--session", r.session],
        { cwd: r.root, stdin: `﻿${JSON.stringify(edit2)}` }
      );

      assert.equal(lintStdinRes.exit, 0);
      assert.equal(
        narrow(
          defined(lintStdinRes.value, "lint value"),
          objectWith({ edit: objectWith({ deduped: isBoolean }) })
        ).edit.deduped,
        false
      );

      fs.writeFileSync(
        planFile,
        fs
          .readFileSync(planFile, "utf-8")
          .replace("implements behavior 2.", "implements behavior 3.")
      );

      const edit3 = {
        class: "non-intent",
        affects: ["T1"],
        rationale: "Edit via inline json",
        diffRef: "d3",
      };

      const lintInlineRes = runCli(
        [
          "lint",
          "run",
          planFile,
          "--json",
          JSON.stringify(edit3),
          "--session",
          r.session,
        ],
        { cwd: r.root }
      );

      assert.equal(lintInlineRes.exit, 0);
      assert.equal(
        narrow(
          defined(lintInlineRes.value, "lint value"),
          objectWith({ edit: objectWith({ deduped: isBoolean }) })
        ).edit.deduped,
        false
      );

      const lintConflict = runCli(
        [
          "lint",
          "run",
          planFile,
          "--edit",
          editFile,
          "--json",
          JSON.stringify(edit3),
          "--session",
          r.session,
        ],
        { cwd: r.root }
      );

      assert.equal(lintConflict.exit, 1);
      assert.equal(lintConflict.output.reason, "invalid-input");
    } finally {
      r.cleanup();
    }
  });

  test("worktree commit (--review-fix, --test-cleanup) and worktree deliver accept file, stdin -, inline flags, and fail closed on conflicts", async () => {
    const planWithTest = [
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
      "  - Tests: tests/step.test.ts",
      '  - Check: `node -e "process.exit(0)"`',
      "  - Evidence: check",
      "",
      "## Verification Plan",
      "### Automated Tests",
      '- `node -e "process.exit(0)"`',
      "",
    ].join("\n");

    const r = await toolkitRepo(planWithTest, {
      "tests/step.test.ts": "test();\n",
    });

    try {
      await r.approve();
      await r.level("low");

      const checked = await r.run(["check", "run"]);

      assert.equal(checked.exit, 0);

      const created = await r.run(["worktree", "create", "T1"]);

      assert.equal(created.exit, 0);

      const wt = path.join(r.session, ".state/worktrees/T1-1");

      fs.writeFileSync(path.join(wt, "src/file.ts"), "updated\n");

      const submitted = await r.run(["worktree", "submit", "T1"]);

      assert.equal(submitted.exit, 0);

      const integrated = await r.run(["worktree", "integrate", "T1"]);

      assert.equal(integrated.exit, 0);

      const base = r.git(["rev-parse", "HEAD"], r.integration);

      const rf1 = {
        review: "code-integration",
        round: 1,
        generation: 1,
        findings: ["R1-F001"],
        from: base,
      };

      const rfFile = path.join(r.root, "rf.json");

      fs.writeFileSync(rfFile, JSON.stringify(rf1));
      fs.writeFileSync(path.join(r.integration, "src/file.ts"), "fix 1\n");

      const rfFileRes = runCli(
        [
          "worktree",
          "commit",
          "--reason",
          "fix 1",
          "--review-fix",
          rfFile,
          "--session",
          r.session,
        ],
        { cwd: r.root }
      );

      assert.equal(rfFileRes.exit, 0);

      fs.writeFileSync(path.join(r.integration, "src/file.ts"), "fix 2\n");

      const rfStdinRes = runCli(
        [
          "worktree",
          "commit",
          "--reason",
          "fix 2",
          "--review-fix",
          "-",
          "--session",
          r.session,
        ],
        { cwd: r.root, stdin: `﻿${JSON.stringify(rf1)}` }
      );

      assert.equal(rfStdinRes.exit, 0);

      fs.writeFileSync(path.join(r.integration, "src/file.ts"), "fix 3\n");

      const rfInlineRes = runCli(
        [
          "worktree",
          "commit",
          "--reason",
          "fix 3",
          "--review-fix-json",
          JSON.stringify(rf1),
          "--session",
          r.session,
        ],
        { cwd: r.root }
      );

      assert.equal(rfInlineRes.exit, 0);

      const rfConflict = runCli(
        [
          "worktree",
          "commit",
          "--reason",
          "fix 4",
          "--review-fix",
          rfFile,
          "--review-fix-json",
          JSON.stringify(rf1),
          "--session",
          r.session,
        ],
        { cwd: r.root }
      );

      assert.equal(rfConflict.exit, 1);
      assert.equal(rfConflict.output.reason, "invalid-input");

      const rechecked = await r.run(["check", "run"]);

      assert.equal(rechecked.exit, 0);

      const tcData = { removed: ["SC1"], deleted: 1, merged: 0 };

      const tcFile = path.join(r.root, "tc.json");

      fs.writeFileSync(tcFile, JSON.stringify(tcData));

      const tcConflict = runCli(
        [
          "worktree",
          "commit",
          "--reason",
          "cleanup",
          "--test-cleanup",
          tcFile,
          "--test-cleanup-json",
          JSON.stringify(tcData),
          "--session",
          r.session,
        ],
        { cwd: r.root }
      );

      assert.equal(tcConflict.exit, 1);
      assert.equal(tcConflict.output.reason, "invalid-input");

      const modes = ["file", "stdin", "inline"] as const;

      await Promise.all(
        modes.map(async (mode) => {
          const sub = await r.second(`tc-${mode}`);

          await sub.approve();
          await sub.level("low");

          const subChecked = await sub.run(["check", "run"]);

          assert.equal(subChecked.exit, 0);

          fs.rmSync(path.join(sub.integration, "tests/step.test.ts"));

          let args: string[];

          if (mode === "file") {
            args = [
              "worktree",
              "commit",
              "--reason",
              `cleanup ${mode}`,
              "--test-cleanup",
              tcFile,
              "--session",
              sub.session,
            ];
          } else if (mode === "stdin") {
            args = [
              "worktree",
              "commit",
              "--reason",
              `cleanup ${mode}`,
              "--test-cleanup",
              "-",
              "--session",
              sub.session,
            ];
          } else {
            args = [
              "worktree",
              "commit",
              "--reason",
              `cleanup ${mode}`,
              "--test-cleanup-json",
              JSON.stringify(tcData),
              "--session",
              sub.session,
            ];
          }

          const res =
            mode === "stdin"
              ? runCli(args, {
                  cwd: r.root,
                  stdin: JSON.stringify(tcData),
                })
              : runCli(args, { cwd: r.root });

          assert.equal(res.exit, 0, mode);
          assert.deepEqual(
            narrow(
              defined(res.value, "commit value"),
              objectWith({ removed: arrayOf(isString) })
            ).removed,
            ["SC1"],
            mode
          );
        })
      );

      const msgFile = path.join(r.root, "commit-msg.txt");

      fs.writeFileSync(msgFile, "feat: deliver via file\n");

      const deliverConflict = runCli(
        [
          "worktree",
          "deliver",
          "--commit",
          msgFile,
          "--message",
          "dup",
          "--session",
          r.session,
        ],
        { cwd: r.root }
      );

      assert.equal(deliverConflict.exit, 1);
      assert.equal(deliverConflict.output.reason, "invalid-input");

      const uncommitted = await r.run(["worktree", "deliver"]);

      assert.equal(uncommitted.exit, 0);

      const inlineDeliver = runCli(
        [
          "worktree",
          "deliver",
          "--message",
          "feat: deliver via inline message",
          "--session",
          r.session,
        ],
        { cwd: r.root }
      );

      assert.equal(inlineDeliver.exit, 0);
      assert.equal(
        r.git(["log", "-1", "--format=%B"]).trim(),
        "feat: deliver via inline message"
      );

      await Promise.all(
        (["file", "stdin"] as const).map(async (mode) => {
          const subRepo = await toolkitRepo();

          try {
            await subRepo.approve();
            await subRepo.level("low");

            const subChecked = await subRepo.run(["check", "run"]);

            assert.equal(subChecked.exit, 0);

            const subCreated = await subRepo.run(["worktree", "create", "T1"]);

            assert.equal(subCreated.exit, 0);

            fs.writeFileSync(
              path.join(subRepo.session, ".state/worktrees/T1-1/src/file.ts"),
              `update ${mode}\n`
            );

            const subSubmitted = await subRepo.run([
              "worktree",
              "submit",
              "T1",
            ]);

            assert.equal(subSubmitted.exit, 0);

            const subIntegrated = await subRepo.run([
              "worktree",
              "integrate",
              "T1",
            ]);

            assert.equal(subIntegrated.exit, 0);

            const subCheckedAgain = await subRepo.run(["check", "run"]);

            assert.equal(subCheckedAgain.exit, 0);

            const subDelivered = await subRepo.run(["worktree", "deliver"]);

            assert.equal(subDelivered.exit, 0);

            const commitText = `feat: deliver via ${mode}\n`;

            const res =
              mode === "file"
                ? runCli(
                    [
                      "worktree",
                      "deliver",
                      "--commit",
                      msgFile,
                      "--session",
                      subRepo.session,
                    ],
                    { cwd: subRepo.root }
                  )
                : runCli(
                    [
                      "worktree",
                      "deliver",
                      "--commit",
                      "-",
                      "--session",
                      subRepo.session,
                    ],
                    { cwd: subRepo.root, stdin: `﻿${commitText}` }
                  );

            assert.equal(res.exit, 0, mode);
            assert.equal(
              subRepo.git(["log", "-1", "--format=%B"]).trim(),
              mode === "file" ? "feat: deliver via file" : commitText.trim(),
              mode
            );
          } finally {
            subRepo.cleanup();
          }
        })
      );
    } finally {
      r.cleanup();
    }
  });

  test("ask run accepts file, stdin -, inline --text, and rejects conflicts", async () => {
    const f = fixture({
      responses: [
        { text: "answer from file" },
        { text: "answer from stdin" },
        { text: "answer from inline" },
      ],
    });

    try {
      const initRes = await f.launch([
        "session",
        "init",
        "--objective",
        "Ask payload matrix",
        "--host",
        "codex",
      ]).done;

      assert.equal(initRes.exit, 0, initRes.stderr);

      const session = narrow(
        parseJson(initRes.stdout.trim()),
        objectWith({ path: isString })
      ).path;

      const qFile = path.join(f.repo, "question.md");

      fs.writeFileSync(qFile, "Question via file");

      const binDir = path.dirname(
        path.join(
          f.dir,
          "bin",
          process.platform === "win32" ? "opencode.cmd" : "opencode"
        )
      );

      const pathValue = process.env["PATH"] ?? "";

      const env = {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${pathValue}`,
      };

      const fileRes = runCli(
        [
          "ask",
          "run",
          qFile,
          "--session",
          session,
          "--host",
          "codex",
          "--level",
          "low",
        ],
        { cwd: f.repo, env, entry: f.entry }
      );

      assert.equal(fileRes.exit, 0, "file");
      assert.equal(fileRes.output.ok, true, "file");

      const fileDigest = crypto
        .createHash("sha256")
        .update("Question via file")
        .digest("hex")
        .slice(0, 16);

      assert.equal(
        fs.existsSync(
          path.join(
            session,
            ".state",
            "asks",
            fileDigest,
            "attempt-1",
            "answers.json"
          )
        ),
        true,
        "file"
      );

      const stdinRes = runCli(
        [
          "ask",
          "run",
          "-",
          "--session",
          session,
          "--host",
          "codex",
          "--level",
          "low",
        ],
        { cwd: f.repo, env, entry: f.entry, stdin: "﻿Question via stdin" }
      );

      assert.equal(stdinRes.exit, 0, "stdin");
      assert.equal(stdinRes.output.ok, true, "stdin");

      const stdinDigest = crypto
        .createHash("sha256")
        .update("Question via stdin")
        .digest("hex")
        .slice(0, 16);

      assert.equal(
        fs.existsSync(
          path.join(
            session,
            ".state",
            "asks",
            stdinDigest,
            "attempt-1",
            "answers.json"
          )
        ),
        true,
        "stdin"
      );

      const inlineRes = runCli(
        [
          "ask",
          "run",
          "--text",
          "Question via inline",
          "--session",
          session,
          "--host",
          "codex",
          "--level",
          "low",
        ],
        { cwd: f.repo, env, entry: f.entry }
      );

      assert.equal(inlineRes.exit, 0, "inline");
      assert.equal(inlineRes.output.ok, true, "inline");

      const inlineDigest = crypto
        .createHash("sha256")
        .update("Question via inline")
        .digest("hex")
        .slice(0, 16);

      assert.equal(
        fs.existsSync(
          path.join(
            session,
            ".state",
            "asks",
            inlineDigest,
            "attempt-1",
            "answers.json"
          )
        ),
        true,
        "inline"
      );

      const conflict = runCli(
        [
          "ask",
          "run",
          qFile,
          "--text",
          "dup",
          "--session",
          session,
          "--host",
          "codex",
          "--level",
          "low",
        ],
        { cwd: f.repo, env, entry: f.entry }
      );

      assert.equal(conflict.exit, 1);
      assert.equal(conflict.output.reason, "invalid-input");
    } finally {
      f.cleanup();
    }
  });

  test(
    "Windows PowerShell 5.1 non-ASCII UTF-8 stdin and inline quoting",
    { skip: HAS_POWERSHELL ? false : "powershell.exe unavailable" },
    async () => {
      const f = fixture({ responses: [{ text: "ps answer" }] });
      const r = await toolkitRepo();

      try {
        await r.approve();
        await r.level("low");

        const checked = await r.run(["check", "run"]);

        assert.equal(checked.exit, 0);

        const created = await r.run(["worktree", "create", "T1"]);

        assert.equal(created.exit, 0);

        fs.writeFileSync(
          path.join(r.session, ".state/worktrees/T1-1/src/file.ts"),
          "ps utf8 change\n"
        );

        const submitted = await r.run(["worktree", "submit", "T1"]);

        assert.equal(submitted.exit, 0);

        const integrated = await r.run(["worktree", "integrate", "T1"]);

        assert.equal(integrated.exit, 0);

        const rechecked = await r.run(["check", "run"]);

        assert.equal(rechecked.exit, 0);

        const delivered = await r.run(["worktree", "deliver"]);

        assert.equal(delivered.exit, 0);

        const utf8Msg = "feat(ps): 日本語 café — αβγ";

        const msgB64 = Buffer.from(utf8Msg, "utf-8").toString("base64");

        const psScript = [
          "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
          "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
          `$msg = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${msgB64}'))`,
          `$msg | & '${process.execPath.replaceAll("'", "''")}' '${CLI_ENTRY.replaceAll("'", "''")}' worktree deliver --commit - --session '${r.session.replaceAll("'", "''")}'`,
        ].join("; ");

        const psDeliver = spawnSync(
          "powershell.exe",
          ["-NoProfile", "-Command", psScript],
          {
            cwd: r.root,
            encoding: "utf-8",
            windowsHide: true,
          }
        );

        assert.equal(
          psDeliver.status,
          0,
          defined(psDeliver.stderr ?? psDeliver.stdout, "ps output")
        );
        assert.equal(r.git(["log", "-1", "--format=%B"]).trim(), utf8Msg);

        const initRes = await f.launch([
          "session",
          "init",
          "--objective",
          "PS inline quoting",
          "--host",
          "codex",
        ]).done;

        assert.equal(initRes.exit, 0, initRes.stderr);

        const session = narrow(
          parseJson(initRes.stdout.trim()),
          objectWith({ path: isString })
        ).path;

        const binDir = path.dirname(path.join(f.dir, "bin", "opencode.cmd"));

        const pathValue = process.env["PATH"] ?? "";

        const env = {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${pathValue}`,
        };

        const inlineQuestion = 'Quote "check" & path/to/file?';

        const psAsk = `& '${process.execPath.replaceAll("'", "''")}' '${f.entry.replaceAll("'", "''")}' ask run --text 'Quote \\"check\\" & path/to/file?' --session '${session.replaceAll("'", "''")}' --host codex --level low`;

        const askOut = spawnSync(
          "powershell.exe",
          ["-NoProfile", "-Command", psAsk],
          {
            cwd: f.repo,
            env,
            encoding: "utf-8",
            windowsHide: true,
          }
        );

        assert.equal(
          askOut.status,
          0,
          defined(askOut.stderr ?? askOut.stdout, "ps output")
        );

        const askDigest = crypto
          .createHash("sha256")
          .update(inlineQuestion)
          .digest("hex")
          .slice(0, 16);

        assert.equal(
          fs.existsSync(
            path.join(
              session,
              ".state",
              "asks",
              askDigest,
              "attempt-1",
              "answers.json"
            )
          ),
          true
        );

        const psPlanPath = path.join(r.root, "work.plan.md");

        const beforeHash = defined(
          currentHashes(r.root, latest(foldLedger(r.session), "bind")).plan,
          "plan hash"
        );

        fs.writeFileSync(
          psPlanPath,
          fs
            .readFileSync(psPlanPath, "utf-8")
            .replace("implements behavior.", "implements ps inline.")
        );

        const jsonObj = JSON.stringify({
          class: "non-intent",
          affects: ["T1"],
          rationale: 'PowerShell "quoted" edit',
          diffRef: "ps-diff",
          before: beforeHash,
        });

        const psEscapedJson = jsonObj.replaceAll(
          /(?<slashes>\\*)"/gu,
          String.raw`$<slashes>$<slashes>\"`
        );

        const psLint = `& '${process.execPath.replaceAll("'", "''")}' '${CLI_ENTRY.replaceAll("'", "''")}' lint run '${psPlanPath.replaceAll("'", "''")}' --% --json "${psEscapedJson}" --session "${r.session}"`;

        const lintOut = spawnSync(
          "powershell.exe",
          ["-NoProfile", "-Command", psLint],
          {
            cwd: r.root,
            encoding: "utf-8",
            windowsHide: true,
          }
        );

        assert.equal(
          lintOut.status,
          0,
          defined(lintOut.stderr ?? lintOut.stdout, "ps output")
        );

        const lastEdit = defined(
          foldLedger(r.session).records.findLast((row) => row.kind === "edit"),
          "last edit"
        );

        assert.equal(lastEdit.data["rationale"], 'PowerShell "quoted" edit');
      } finally {
        f.cleanup();
        r.cleanup();
      }
    }
  );

  test(
    "POSIX sh inline quoting",
    { skip: HAS_SH ? false : "sh unavailable" },
    async () => {
      const r = await toolkitRepo();

      try {
        await r.approve();
        await r.level("low");

        const checked = await r.run(["check", "run"]);

        assert.equal(checked.exit, 0);

        const created = await r.run(["worktree", "create", "T1"]);

        assert.equal(created.exit, 0);

        fs.writeFileSync(
          path.join(r.session, ".state/worktrees/T1-1/src/file.ts"),
          "sh change\n"
        );

        const submitted = await r.run(["worktree", "submit", "T1"]);

        assert.equal(submitted.exit, 0);

        const integrated = await r.run(["worktree", "integrate", "T1"]);

        assert.equal(integrated.exit, 0);

        const rechecked = await r.run(["check", "run"]);

        assert.equal(rechecked.exit, 0);

        const delivered = await r.run(["worktree", "deliver"]);

        assert.equal(delivered.exit, 0);

        const planPath = path.join(r.root, "work.plan.md");

        const beforeHash = defined(
          currentHashes(r.root, latest(foldLedger(r.session), "bind")).plan,
          "plan hash"
        );

        fs.writeFileSync(
          planPath,
          fs
            .readFileSync(planPath, "utf-8")
            .replace("implements behavior.", "implements sh inline.")
        );

        const editJson = JSON.stringify({
          class: "non-intent",
          affects: ["T1"],
          rationale: "POSIX 'quoted' & spaced",
          diffRef: "sh-diff",
          before: beforeHash,
        });

        const shLintCmd = `${shQuote(process.execPath)} ${shQuote(CLI_ENTRY)} lint run ${shQuote(planPath)} --json ${shQuote(editJson)} --session ${shQuote(r.session)}`;

        const shLint = spawnSync("sh", ["-c", shLintCmd], {
          cwd: r.root,
          encoding: "utf-8",
          windowsHide: true,
        });

        assert.equal(
          shLint.status,
          0,
          defined(shLint.stderr ?? shLint.stdout, "sh output")
        );

        const lastEdit = defined(
          foldLedger(r.session).records.findLast((row) => row.kind === "edit"),
          "last edit"
        );

        assert.equal(lastEdit.data["rationale"], "POSIX 'quoted' & spaced");

        const msg = "feat(sh): POSIX 'quoted' message";

        const shDeliverCmd = `${shQuote(process.execPath)} ${shQuote(CLI_ENTRY)} worktree deliver --message ${shQuote(msg)} --session ${shQuote(r.session)}`;

        const shDeliver = spawnSync("sh", ["-c", shDeliverCmd], {
          cwd: r.root,
          encoding: "utf-8",
          windowsHide: true,
        });

        assert.equal(
          shDeliver.status,
          0,
          defined(shDeliver.stderr ?? shDeliver.stdout, "sh output")
        );
        assert.equal(r.git(["log", "-1", "--format=%B"]).trim(), msg);
      } finally {
        r.cleanup();
      }
    }
  );
});
