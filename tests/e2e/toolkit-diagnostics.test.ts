import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { measureRuns, parsePairs } from "../../scripts/measure-runs.ts";
import { isRecord } from "../../skills/dispatch/scripts/lib/config.ts";
import { parseJson } from "../../skills/dispatch/scripts/lib/integrity.ts";
import {
  arrayOf,
  defined,
  isString,
  maybe,
  narrow,
  nullable,
  objectWith,
} from "./helpers/json.ts";
import { toolkitRepo } from "./helpers/toolkit-repo.ts";

const outputGuard = objectWith({
  summary: isString,
  path: maybe(nullable(isString)),
  reason: maybe(isString),
});

test("diagnostics stay observational across CLI recovery and report completion", async () => {
  const f = await toolkitRepo();

  try {
    await f.level("low");

    const skill = path.join(f.session, "private-skill");

    fs.cpSync(f.deps.skillRoot, skill, { recursive: true });

    const configPath = path.join(skill, "config.local.jsonc");

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        diagnostics: true,
        "read-delegates": {
          codex: {
            nativeSubagentsOnly: true,
            targets: [{ low: { model: "native" } }],
          },
        },
        "write-subagents": {
          codex: { low: { model: "native", effort: "low" } },
        },
        "utility-subagents": {
          codex: { model: "native", effort: "low", "context-limit": 300_000 },
        },
        phases: { ask: { targets: { low: 1 }, rounds: { low: 1 } } },
      })
    );

    const {
      OPENCODE_CONFIG: _dropConfig,
      OPENCODE_CONFIG_DIR: _dropConfigDir,
      NODE_OPTIONS: _dropNodeOptions,
      NODE_TEST_CONTEXT: _dropTestContext,
      ...env
    } = process.env;

    const entry = path.join(skill, "scripts/dispatch.ts");

    // The host comes from `session init --host`; the fixture session predates it, so copy the recorded host over.
    const init = spawnSync(
      process.execPath,
      [
        entry,
        "session",
        "init",
        "--objective",
        "Declared host",
        "--session-id",
        "declared-host",
        "--host",
        "codex",
      ],
      { cwd: f.root, env, encoding: "utf-8" }
    );

    assert.equal(init.status, 0, init.stderr + init.stdout);

    const initOutput = narrow(
      parseJson(init.stdout),
      objectWith({ path: isString })
    );

    const manifestRaw = parseJson(
      fs.readFileSync(path.join(initOutput.path, "manifest.json"), "utf-8")
    );

    const declared = narrow(manifestRaw, objectWith({ host: isString })).host;

    assert.equal(declared, "codex");

    const manifestFile = path.join(f.session, "manifest.json");

    const sessionManifest = parseJson(fs.readFileSync(manifestFile, "utf-8"));

    if (!isRecord(sessionManifest)) {
      assert.fail("session manifest must be an object");
    }

    fs.writeFileSync(
      manifestFile,
      JSON.stringify({ ...sessionManifest, host: declared })
    );

    const run = (args: string[], expected = 0) => {
      const child = f.spawned(args, entry, env);

      assert.equal(child.status, expected, child.stderr + child.stdout);

      const lines = child.stdout.trim().split(/\r?\n/u);

      assert.equal(lines.length, 1);

      const output = narrow(parseJson(defined(lines[0])), outputGuard);

      assert.ok(Buffer.byteLength(output.summary) <= 1024);

      const value =
        output.path === undefined || output.path === null || output.path === ""
          ? null
          : parseJson(fs.readFileSync(output.path, "utf-8"));

      return { output, value };
    };

    const doctor = run(["doctor", "run", "--host", "codex"]);

    const doctorValue = narrow(
      defined(doctor.value),
      objectWith({ config: objectWith({ path: isString }) })
    );

    assert.equal(doctorValue.config.path, configPath);

    const question = path.join(f.session, "question.md");

    fs.writeFileSync(question, "Explain the fixture behavior");

    const pending = run(["ask", "run", question, "--host", "codex"], 4);

    const pendingValue = narrow(
      defined(pending.value),
      objectWith({ native: arrayOf(objectWith({ replyPath: isString })) })
    );

    assert.equal(pending.output.reason, "native-pending");
    assert.equal(pendingValue.native.length, 1);

    const reply = defined(pendingValue.native[0]).replyPath;

    fs.writeFileSync(reply, "Retained native answer");

    const captures = path.join(f.session, ".state/diagnostics");

    assert.ok(fs.readdirSync(captures).length > 0);

    // An interrupted optional collection must survive process readback as partial evidence.
    fs.writeFileSync(
      path.join(captures, "interrupted.json"),
      JSON.stringify({
        phases: [],
        invocations: [],
        reviews: [],
        capture: { state: "opened", start: 1 },
      })
    );

    const answered = run(["ask", "run", question, "--host", "codex"]);

    const answeredValue = narrow(
      defined(answered.value),
      objectWith({ answers: arrayOf(objectWith({ text: isString })) })
    );

    assert.deepEqual(
      answeredValue.answers.map((answer) => answer.text),
      ["Retained native answer"]
    );
    assert.equal(fs.readFileSync(reply, "utf-8"), "Retained native answer");

    fs.writeFileSync(path.join(f.session, ".state/retro.json"), "[]");

    const rendered = run(["report", "render"]);

    const renderedValue = narrow(
      defined(rendered.value),
      objectWith({ path: isString, diagnostics: isString })
    );

    assert.ok(fs.existsSync(path.resolve(f.session, renderedValue.path)));

    const report = fs.readFileSync(
      path.resolve(f.session, renderedValue.diagnostics),
      "utf-8"
    );

    assert.match(report, /Collection warning: partial[\s\S]*incomplete 1/iu);
    assert.match(report, /completed/iu);
    assert.doesNotMatch(
      report,
      /Explain the fixture behavior|Retained native answer/u
    );

    const writer = run(["worktree", "create", "T1"]);

    const writerValue = narrow(
      defined(writer.value),
      objectWith({ path: isString })
    );

    fs.writeFileSync(
      path.resolve(f.session, writerValue.path, "src/file.ts"),
      "delivered\n"
    );

    run(["worktree", "submit", "T1"]);
    run(["worktree", "integrate", "T1"]);
    run(["check", "run"]);

    const proof = path.join(f.session, "proof.json");

    fs.writeFileSync(
      proof,
      JSON.stringify({
        kind: "integrate",
        by: "orchestrator",
        data: {
          phase: "verification",
          cycle: 1,
          outcome: "no-op",
          head: f.git(["rev-parse", "HEAD"], f.integration),
          reason: "fixture",
          open: [],
        },
      })
    );

    run(["ledger", "append", proof]);
    run(["worktree", "deliver"]);

    const complete = run(["report", "complete"]);

    const completeValue = narrow(
      defined(complete.value),
      objectWith({
        path: isString,
        diagnostics: isString,
        statuses: arrayOf(objectWith({ criterion: isString })),
      })
    );

    assert.ok(fs.existsSync(path.resolve(f.session, completeValue.path)));
    assert.ok(
      completeValue.statuses.some((status) => status.criterion === "contract")
    );

    const pairs = parsePairs({
      pairs: [
        {
          name: "delivered",
          sides: [
            {
              label: "current",
              session: f.session,
              host: "codex",
              reportComplete: path
                .relative(f.session, complete.output.path ?? "")
                .split(path.sep)
                .join("/"),
            },
          ],
        },
      ],
    });

    const comparison = measureRuns(pairs, {
      baseDir: f.root,
      home: f.root,
      env,
      pricing: {
        path: "pricing.json",
        text: fs.readFileSync(
          path.join(skill, "references/pricing.json"),
          "utf-8"
        ),
      },
    });

    assert.deepEqual(
      comparison.pairs[0]?.sides[0]?.efficiency.verification?.criteria,
      [{ id: "SC1", state: "verified" }]
    );
    assert.equal(
      fs.readFileSync(path.join(f.root, "src/file.ts"), "utf-8"),
      "delivered\n"
    );

    run(["worktree", "cleanup"]);
  } finally {
    f.cleanup();
  }
});
