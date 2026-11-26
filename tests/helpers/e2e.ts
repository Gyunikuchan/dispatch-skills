import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { hashes } from "../../scripts/generate-hashes.ts";
import { SPEC_SOURCE } from "./spec-fixture.ts";
import { completedLaunch, recordedLaunches } from "./stub-provider.ts";
import type { Scenario } from "./stub-provider.ts";

export const CLEAN = { status: "CLEAN", findings: [] };

const EMPTY_SCENARIO: Scenario = { responses: [CLEAN] };

const ROOT = path.resolve(import.meta.dirname, "../..");
const STUB = path.resolve(ROOT, "tests/helpers/stub-provider.ts");

let baseRepoTemplate: string | null = null;
let baseOverlayTemplate: string | null = null;

const getBaseRepoTemplate = () => {
  if (
    baseRepoTemplate === undefined ||
    baseRepoTemplate === null ||
    baseRepoTemplate === ""
  ) {
    const created = fs.mkdtempSync(
      path.join(os.tmpdir(), "dispatch-e2e-base-repo-")
    );

    baseRepoTemplate = created;
    process.on("exit", () => {
      try {
        fs.rmSync(created, { recursive: true, force: true });
      } catch {
        /* NOTE: a held Windows handle leaves it for the OS. */
      }
    });

    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: created,
        encoding: "utf-8",
        windowsHide: true,
      });

    git("init", "-q");
    fs.appendFileSync(
      path.join(baseRepoTemplate, ".git/config"),
      "\n[core]\n\tautocrlf = false\n[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n"
    );
    fs.mkdirSync(path.join(baseRepoTemplate, "src"));
    fs.writeFileSync(
      path.join(baseRepoTemplate, "src/a.ts"),
      "export const value = 1;\n"
    );
    fs.writeFileSync(
      path.join(baseRepoTemplate, "governing.spec.md"),
      SPEC_SOURCE
    );
    fs.writeFileSync(path.join(baseRepoTemplate, ".gitignore"), ".scratch/\n");
    git("add", ".");
    git("commit", "-qm", "fixture");
  }

  return baseRepoTemplate;
};

const getBaseOverlayTemplate = () => {
  if (
    baseOverlayTemplate === undefined ||
    baseOverlayTemplate === null ||
    baseOverlayTemplate === ""
  ) {
    const created = fs.mkdtempSync(
      path.join(os.tmpdir(), "dispatch-e2e-base-overlay-")
    );

    baseOverlayTemplate = created;
    process.on("exit", () => {
      try {
        fs.rmSync(created, { recursive: true, force: true });
      } catch {
        /* NOTE: a held Windows handle leaves it for the OS. */
      }
    });
    fs.cpSync(
      path.join(ROOT, "skills/dispatch"),
      path.join(baseOverlayTemplate, "skills/dispatch"),
      {
        recursive: true,
      }
    );

    const config = {
      "read-delegates": {
        opencode: { sandbox: false, targets: [{ low: { model: "stub" } }] },
      },
      "write-subagents": {
        claude: { low: { model: "native-stub", effort: "low" } },
        codex: { low: { model: "native-stub", effort: "low" } },
        opencode: { low: { model: "stub" } },
        agy: { low: { model: "stub" } },
        copilot: { low: { model: "stub" } },
      },
      "utility-subagents": {
        claude: {
          model: "native-stub",
          effort: "low",
          "context-limit": 150_000,
        },
        codex: {
          model: "native-stub",
          effort: "low",
          "context-limit": 300_000,
        },
        opencode: { model: "stub", "context-limit": 300_000 },
        agy: { model: "stub", "context-limit": 300_000 },
        copilot: { model: "stub", "context-limit": 300_000 },
      },
      phases: {
        "plan-review": { rounds: { low: 1 }, targets: { low: 1 } },
        "code-review": { rounds: { low: 2 }, targets: { low: 1 } },
      },
    };

    fs.writeFileSync(
      path.join(baseOverlayTemplate, "skills/dispatch/config.local.jsonc"),
      JSON.stringify(config)
    );
    hashes(baseOverlayTemplate);
  }

  return baseOverlayTemplate;
};

const shellQuote = (value: string) =>
  `'${value.replaceAll("'", String.raw`'\''`)}'`;

export const fixture = (scenario: Scenario = EMPTY_SCENARIO) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-e2e-"));
  const repo = path.join(dir, "repo");
  const overlay = path.join(dir, "overlay");

  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  fs.cpSync(getBaseOverlayTemplate(), overlay, { recursive: true });

  const skill = path.join(overlay, "skills/dispatch");
  const bin = path.join(dir, "bin");
  const scenarioPath = path.join(dir, "scenario.json");

  fs.mkdirSync(bin);
  fs.writeFileSync(scenarioPath, JSON.stringify(scenario));

  const shim =
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${STUB}" "${scenarioPath}" %*\r\n`
      : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(STUB)} ${shellQuote(scenarioPath)} "$@"\n`;

  fs.writeFileSync(
    path.join(bin, process.platform === "win32" ? "opencode.cmd" : "opencode"),
    shim,
    { mode: 0o700 }
  );
  fs.cpSync(getBaseRepoTemplate(), repo, { recursive: true });

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf-8",
      windowsHide: true,
    });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
    NODE_OPTIONS: "",
    NODE_TEST_CONTEXT: "",
  };

  for (const key of Object.keys(env)) {
    if (
      /^DISPATCH_|^CLAUDE|^CODEX_THREAD|^ANTIGRAVITY|^COPILOT|^OPENCODE/u.test(
        key
      )
    ) {
      Reflect.deleteProperty(env, key);
    }
  }

  const entry = path.join(skill, "scripts/dispatch.ts");
  const running = new Set<ReturnType<typeof spawn>>();

  const HOST_SENSITIVE = new Set([
    "doctor run",
    "review run",
    "ask run",
    "brief render",
    "brief explorer",
    "brief test-cleanup",
    "brief fix-review-lite",
  ]);

  const withHost = (args: readonly string[]) => {
    if (args.includes("--host")) {
      return args;
    }

    if (!HOST_SENSITIVE.has(`${args[0]} ${args[1]}`)) {
      return args;
    }

    return [...args, "--host", "codex"];
  };

  const launch = (args: readonly string[]) => {
    const child = spawn(process.execPath, [entry, ...withHost(args)], {
      cwd: repo,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    running.add(child);

    let stderr = "";
    let stdout = "";

    child.stdout?.on("data", (bytes: Buffer) => {
      // eslint-disable-next-line typescript/restrict-plus-operands -- buffer is converted to text before concatenation at runtime.
      stdout += bytes;
    });
    child.stderr?.on("data", (bytes: Buffer) => {
      // eslint-disable-next-line typescript/restrict-plus-operands -- buffer is converted to text before concatenation at runtime.
      stderr += bytes;
    });

    // eslint-disable-next-line typescript/avoid-new -- intentional test pattern.
    const done = new Promise<{ exit: number; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`CLI timeout: ${args.join(" ")}\n${stderr}`));
        }, 25_000);

        child.once("error", (error) => {
          clearTimeout(timer);
          running.delete(child);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          running.delete(child);
          resolve({ exit: code ?? -1, stdout, stderr });
        });
      }
    );

    return { child, done };
  };

  const launches = () => recordedLaunches(scenarioPath);

  const cleanup = () => {
    for (const child of running) {
      child.kill("SIGKILL");
    }

    for (const row of launches()) {
      if (!completedLaunch(scenarioPath, row)) {
        try {
          process.kill(row.pid, "SIGKILL");
        } catch {
          /* completed */
        }
      }
    }

    // Fixture roots are isolated and owned by this harness.
    fs.rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  };

  return { dir, repo, skill, entry, git, launch, launches, cleanup };
};
