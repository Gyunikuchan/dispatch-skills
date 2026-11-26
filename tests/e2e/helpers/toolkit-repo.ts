import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isRecord } from "../../../skills/dispatch/scripts/lib/config.ts";
import type {
  JsonObject,
  JsonValue,
} from "../../../skills/dispatch/scripts/lib/config.ts";
import { parseJson } from "../../../skills/dispatch/scripts/lib/integrity.ts";
import { initSession } from "../../../skills/dispatch/scripts/lib/session.ts";
import { normalizeProvider } from "../../../skills/dispatch/scripts/policy/roster.ts";
import {
  main,
  nodeDeps,
} from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import type { CliDeps } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import {
  appendRecord,
  currentHashes,
  foldLedger,
  latest,
} from "../../../skills/dispatch/scripts/toolkit/ledger.ts";
import {
  isBoolean,
  isString,
  maybe,
  narrow,
  nullable,
  objectWith,
} from "./json.ts";

const envelopeGuard = objectWith({
  ok: isBoolean,
  summary: isString,
  reason: maybe(isString),
  path: maybe(nullable(isString)),
});

const readEnvelope = (raw: string) => narrow(parseJson(raw), envelopeGuard);

type Envelope = ReturnType<typeof readEnvelope>;

interface ConcurrentResult {
  exit: number;
  output: Envelope;
  value: JsonValue | null;
}

export const planSource = [
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
  '  - Check: `node -e "process.exit(0)"`',
  "  - Evidence: check",
  "",
  "## Verification Plan",
  "### Automated Tests",
  "- `node -e \"process.stdout.write('contract')\"`",
  "",
].join("\n");

// Plan and design lint require a sibling context map; Coverage stays empty so plan lint adds no coverage warnings.
export const contextMapSource = [
  "# Context map: work",
  "",
  "> **Commit:** 0000000",
  ">",
  "> **Tool:** text",
  "",
  "## Map",
  "",
  "## Coverage",
  "",
].join("\n");

let baseTemplate: string | null = null;

const getBaseTemplate = () => {
  if (baseTemplate === null) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolkit-template-"));
    baseTemplate = dir;
    process.on("exit", () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors on exit.
        // WARNING: template cleanup is best-effort; failures must not fail process exit.
      }
    });

    const git = (args: string[]) => {
      const r = spawnSync("git", args, {
        cwd: dir,
        encoding: "utf-8",
        windowsHide: true,
      });

      assert.equal(r.status, 0, r.stderr);

      return r.stdout.trim();
    };

    git(["init", "-b", "main"]);
    fs.appendFileSync(
      path.join(dir, ".git/config"),
      "\n[core]\n\tautocrlf = false\n[user]\n\tname = Toolkit Test\n\temail = test@example.test\n"
    );
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src/file.ts"), "initial\n");
    fs.writeFileSync(
      path.join(dir, ".gitignore"),
      "20261023T0000Z-test/\nignored\n"
    );
    fs.writeFileSync(path.join(dir, "work.plan.md"), planSource);
    fs.writeFileSync(path.join(dir, "work.plan.context.md"), contextMapSource);
    fs.writeFileSync(
      path.join(dir, "work.spec.md"),
      "# Spec\n## Requirements\n### REQ-1 — Work\n- Acceptance: works\n"
    );
    git(["add", "."]);
    git(["commit", "-m", "base"]);
  }

  if (baseTemplate === null) {
    throw new Error("base template missing");
  }

  return baseTemplate;
};

export const toolkitRepo = async (
  source = planSource,
  files: Record<string, string> = {}
) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "toolkit-git-"));
  const session = path.join(root, "20261023T0000Z-test");

  const git = (args: string[], cwd = root) => {
    const r = spawnSync("git", args, {
      cwd,
      encoding: "utf-8",
      windowsHide: true,
    });

    assert.equal(r.status, 0, r.stderr);

    return r.stdout.trim();
  };

  fs.cpSync(getBaseTemplate(), root, { recursive: true });

  if (source !== planSource || Object.keys(files).length > 0) {
    if (source !== planSource) {
      fs.writeFileSync(path.join(root, "work.plan.md"), source);
    }

    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    }

    git(["add", "."]);
    git(["commit", "--amend", "-m", "base"]);
  }

  fs.mkdirSync(session);
  fs.writeFileSync(
    path.join(session, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      folderName: path.basename(session),
      sessionId: "test",
      safeSessionId: "test",
      repositoryRoot: root,
    })
  );
  const deps: CliDeps = nodeDeps();
  // These tests stub `delegate`, so rosters must not depend on the host sandbox.
  delete deps.sandboxSupported;

  // Each session folder binds the same spec and plan and gets its own run helpers.
  const attach = async (target: string) => {
    await appendRecord(
      target,
      {
        kind: "bind",
        by: "orchestrator",
        key: "bind",
        data: { spec: "work.spec.md", plan: "work.plan.md" },
      },
      deps
    );
    const bound = currentHashes(root, latest(foldLedger(target), "bind"));
    await appendRecord(
      target,
      {
        kind: "confirm",
        by: "user",
        quote: "confirmed",
        key: "confirm",
        data: { spec: bound.spec },
      },
      deps
    );

    const approve = async () => {
      const hashes = currentHashes(root, latest(foldLedger(target), "bind"));
      await appendRecord(
        target,
        {
          kind: "confirm",
          by: "user",
          quote: "confirmed",
          key: `confirm:${foldLedger(target).lastSeq}`,
          data: { spec: hashes.spec },
        },
        deps
      );

      return await appendRecord(
        target,
        {
          kind: "approval",
          by: "user",
          quote: "approved",
          key: `approval:${foldLedger(target).lastSeq}`,
          data: hashes,
        },
        deps
      );
    };

    const level = async (value = "low") =>
      await appendRecord(
        target,
        {
          kind: "level",
          by: "orchestrator",
          key: `level:${foldLedger(target).lastSeq}`,
          data: { level: value },
        },
        deps
      );

    const edit = async (data: JsonObject) =>
      await appendRecord(
        target,
        {
          kind: "edit",
          by: "orchestrator",
          key: `edit:${foldLedger(target).lastSeq}`,
          data,
        },
        deps
      );

    const HOST_SENSITIVE = new Set([
      "doctor run",
      "review run",
      "ask run",
      "brief render",
      "brief explorer",
      "brief test-cleanup",
      "brief verifier",
      "brief fix-review-lite",
    ]);

    const withHost = (args: string[]) => {
      if (args.includes("--host")) {
        return args;
      }

      if (!HOST_SENSITIVE.has(`${args[0]} ${args[1]}`)) {
        return args;
      }

      const platform = deps.orchestrator?.platform;

      let host: string;

      if (platform === undefined) {
        try {
          const config = narrow(
            parseJson(
              fs.readFileSync(
                path.join(deps.skillRoot, "config.jsonc"),
                "utf-8"
              )
            ),
            objectWith({ "read-delegates": maybe(isRecord) })
          );

          const present = new Set(
            Object.keys(config["read-delegates"] ?? {}).map((key) =>
              normalizeProvider(key)
            )
          );

          host =
            ["opencode", "claude", "agy", "copilot", "codex"].find(
              (candidate) => !present.has(candidate)
            ) ?? "opencode";
        } catch {
          host = "opencode";
        }
      } else {
        host = normalizeProvider(platform);
      }

      return [...args, "--host", host];
    };

    const run = async (
      args: string[],
      hook?: CliDeps["hook"],
      seedVerification = true,
      gitRun = deps.run
    ) => {
      if (seedVerification && args[0] === "worktree" && args[1] === "deliver") {
        const fold = foldLedger(target);

        const opened = fold.records.findLast(
          (r) => r.kind === "integrate" && r.data["phase"] === "opened"
        );

        if (
          opened &&
          !fold.records.some(
            (r) =>
              r.seq > opened.seq &&
              r.kind === "integrate" &&
              r.data["phase"] === "verification"
          )
        ) {
          await appendRecord(
            target,
            {
              kind: "integrate",
              by: "orchestrator",
              data: {
                phase: "verification",
                cycle: 1,
                outcome: "no-op",
                head: opened.data["base"],
                reason: "fixture",
                open: [],
              },
            },
            deps
          );
        }
      }

      const lines: string[] = [];

      const exit = await main([...withHost(args), "--session", target], {
        ...deps,
        run: gitRun,
        stdout: (line) => {
          lines.push(line);
        },
        ...(hook && { hook }),
      });

      assert.equal(lines.length, 1);

      const [line] = lines;
      assert.ok(line !== undefined);

      const output = readEnvelope(line);
      assert.ok(Buffer.byteLength(output.summary) <= 1024);

      const value: JsonValue | null =
        output.path === undefined || output.path === null || output.path === ""
          ? null
          : parseJson(fs.readFileSync(output.path, "utf-8"));

      return { exit, output, value };
    };

    const spawned = (
      args: string[],
      entry = path.resolve("skills/dispatch/scripts/toolkit/cli.ts"),
      env?: NodeJS.ProcessEnv
    ) =>
      spawnSync(
        process.execPath,
        [entry, ...withHost(args), "--session", target],
        {
          encoding: "utf-8",
          windowsHide: true,
          env: env ?? process.env,
        }
      );

    const concurrent = async (
      args: string[],
      entry = path.resolve("skills/dispatch/scripts/toolkit/cli.ts"),
      env?: NodeJS.ProcessEnv
    ) => {
      const child = spawn(
        process.execPath,
        [entry, ...withHost(args), "--session", target],
        {
          windowsHide: true,
          env: env ?? process.env,
        }
      );

      let stdout = "";
      let stderr = "";
      let spawnError: Error | undefined;

      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });

      child.on("error", (cause) => {
        spawnError = cause;
      });

      await once(child, "close");

      if (spawnError !== undefined) {
        throw spawnError;
      }

      const lines = stdout.trim().split(/\r?\n/u);
      assert.equal(lines.length, 1, stderr);

      const [line] = lines;
      assert.ok(line !== undefined);

      const output = readEnvelope(line);
      assert.ok(Buffer.byteLength(output.summary) <= 1024);

      const value: JsonValue | null =
        output.path === undefined || output.path === null || output.path === ""
          ? null
          : parseJson(fs.readFileSync(output.path, "utf-8"));

      const result: ConcurrentResult = {
        exit: child.exitCode ?? 1,
        output,
        value,
      };

      return result;
    };

    return {
      session: target,
      run,
      spawned,
      concurrent,
      approve,
      level,
      edit,
      integration: path.join(target, ".state/worktrees/integration"),
    };
  };

  const first = await attach(session);

  // Opens another session folder in this repository, as `session init --session-id` does.
  const second = async (sessionId: string) => {
    const located: unknown = initSession({
      repositoryRoot: root,
      sessionId,
      sessionTitle: "second",
      now: new Date("2026-10-23T00:01:00Z"),
    });

    if (!isRecord(located) || !isString(located["path"])) {
      throw new Error("session init failed");
    }

    return await attach(located["path"]);
  };

  return {
    root,
    deps,
    git,
    ...first,
    second,
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
};

export const captureIntegrationReview = (
  r: Awaited<ReturnType<typeof toolkitRepo>>,
  round = 1,
  findings: JsonObject[] = []
) => {
  const dir = path.join(
    r.session,
    `.state/reviews/code-integration/round-${round}`
  );

  fs.mkdirSync(path.join(dir, "gen-1/slots"), { recursive: true });
  const hashes = currentHashes(r.root, latest(foldLedger(r.session), "bind"));

  const opened = foldLedger(r.session).records.find(
    (x) => x.data["phase"] === "opened"
  );

  assert.ok(opened, "opened integrate record");

  const { base } = opened.data;
  fs.writeFileSync(
    path.join(dir, "round.json"),
    JSON.stringify({
      round,
      startSeq: foldLedger(r.session).lastSeq,
      generation: 1,
      cap: 3,
      roster: [{ slot: "reviewer" }, { slot: "unused-reserve", reserve: true }],
      scope: "Full review",
      artifacts: hashes,
      spec: { path: path.join(r.root, "work.spec.md"), hash: hashes.spec },
      target: { base, head: r.git(["rev-parse", "HEAD"], r.integration) },
    })
  );
  fs.writeFileSync(
    path.join(dir, "gen-1/slots/reviewer.json"),
    JSON.stringify({
      slot: "reviewer",
      state: "done",
      text: '{"status":"CLEAN","findings":[]}',
    })
  );
  fs.writeFileSync(
    path.join(dir, "findings.json"),
    JSON.stringify({ review: "code-integration", round, failed: [], findings })
  );

  return dir;
};

export const setupTestSkill = (
  deps: CliDeps,
  session: string,
  name = "skill",
  config: JsonObject = {}
) => {
  const skill = path.join(session, name);
  fs.mkdirSync(path.join(skill, "references"), { recursive: true });
  fs.cpSync(
    path.join(deps.skillRoot, "references/templates"),
    path.join(skill, "references/templates"),
    {
      recursive: true,
    }
  );
  fs.copyFileSync(
    path.join(deps.skillRoot, "references/spec-stage.md"),
    path.join(skill, "references/spec-stage.md")
  );
  fs.writeFileSync(path.join(skill, "config.jsonc"), JSON.stringify(config));

  return skill;
};
