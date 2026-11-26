import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { nodeErrorCode } from "../../skills/dispatch/scripts/lib/fs-ext.ts";
import { parseJson } from "../../skills/dispatch/scripts/lib/integrity.ts";
import { currentPlatform } from "../../skills/dispatch/scripts/lib/platform.ts";
import { nodeProcess } from "../../skills/dispatch/scripts/providers/node-process.ts";
import { nativeOpencodeIntrospection } from "../../skills/dispatch/scripts/providers/opencode-runtime.ts";
import { opencode } from "../../skills/dispatch/scripts/providers/opencode.ts";
import {
  nodeProbeSpawn,
  probeProviders,
} from "../../skills/dispatch/scripts/providers/probe.ts";
import { runDelegate } from "../../skills/dispatch/scripts/providers/runner.ts";
import type {
  RunnerFs,
  RunnerPorts,
} from "../../skills/dispatch/scripts/providers/runner.ts";
import type {
  DelegateRequest,
  LifecycleStep,
} from "../../skills/dispatch/scripts/providers/types.ts";
import { nodeDeps } from "../../skills/dispatch/scripts/toolkit/cli.ts";
import { arrayOf, defined, isString, narrow } from "./helpers/json.ts";

type Scenario =
  | "inspect"
  | "hang"
  | "unsupported"
  | "success"
  | "failure"
  | "timeout"
  | "cap"
  | "exit-with-descendant"
  | "closed-stdio-success"
  | "closed-stdio-failure";

const pause = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const ownedProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ESRCH") {
      return false;
    }

    throw error;
  }
};

const assertOwnedProcessExited = async (
  pid: number,
  deadline = Date.now() + 2000
) => {
  assert.ok(
    Date.now() < deadline,
    `owned OpenCode descendant ${pid} remained alive after teardown`
  );

  if (!ownedProcessAlive(pid)) {
    return;
  }

  pause(20);

  await assertOwnedProcessExited(pid, deadline);
};

const makeFixture = (scenario: Scenario) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-lifecycle-"));

  const worktree = path.join(root, "worktree");

  fs.mkdirSync(worktree);

  const argsPath = path.join(root, "args.json");

  const childPidPath = path.join(root, "child.pid");

  const escapedCwd = JSON.stringify(path.dirname(process.execPath));

  const source = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
const reply = (text) => {
  if (!args.includes('--format')) return text;
  const event = (type, part) => JSON.stringify({ type, timestamp: 0, sessionID: 'lifecycle', part });
  return [
    event('text', { id: 'text-0', sessionID: 'lifecycle', messageID: 'msg', type: 'text', text }),
    event('step_finish', { id: 'step-0', sessionID: 'lifecycle', messageID: 'msg', type: 'step-finish', reason: 'stop', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
  ].join('\\n');
};
if (${JSON.stringify(scenario)} === 'unsupported') {
  process.stderr.write("error: unrecognized option '--standalone'\\n");
  process.exit(2);
}
if (!args.includes('--standalone')) {
  process.stderr.write("error: missing required --standalone flag\\n");
  process.exit(2);
}
if (args.includes('debug') && ${JSON.stringify(scenario)} === 'inspect') {
  process.stdout.write(JSON.stringify({ args, configDir: process.env.OPENCODE_CONFIG_DIR ?? null, hasApiKey: Object.hasOwn(process.env, 'OPENAI_API_KEY') }));
  process.exit(0);
}
if (args.includes('debug') && ${JSON.stringify(scenario)} === 'hang') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
  fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
  setInterval(() => {}, 1000);
} else if (${JSON.stringify(scenario)} === 'closed-stdio-success' || ${JSON.stringify(scenario)} === 'closed-stdio-failure') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: ${escapedCwd}, stdio: 'ignore', detached: process.platform === 'win32', windowsHide: true });
  fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
  process.stdout.write(args.includes('debug') ? '[]' : reply('private run complete'));
  process.exit(${JSON.stringify(scenario)} === 'closed-stdio-failure' ? 7 : 0);
} else if (${JSON.stringify(scenario)} === 'failure') {
  process.stderr.write('controlled provider failure\\n');
  process.exit(7);
} else if (${JSON.stringify(scenario)} === 'timeout' || ${JSON.stringify(scenario)} === 'cap') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
  fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
  if (${JSON.stringify(scenario)} === 'cap') process.stdout.write('x'.repeat(200000));
  else process.stdout.write('started\\n');
  setInterval(() => {}, 1000);
} else if (${JSON.stringify(scenario)} === 'exit-with-descendant') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: ${escapedCwd}, stdio: 'inherit', detached: process.platform === 'win32' });
  fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
  process.stdout.write(reply('private CLI exits while its server child stays open\\n'));
  process.exit(0);
} else if (args.includes('debug')) {
  process.stdout.write(JSON.stringify(args));
} else {
  process.stdout.write(reply('private run complete'));
}
`;

  const scriptPath = path.join(root, "fixture.cjs");

  fs.writeFileSync(scriptPath, source);

  let binary: string;

  if (process.platform === "win32") {
    binary = path.join(root, "opencode.cmd");

    fs.writeFileSync(
      binary,
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
    );
  } else {
    binary = path.join(root, "opencode");

    fs.writeFileSync(binary, `#!/usr/bin/env node\n${source}`, {
      mode: 0o700,
    });
  }

  const request: DelegateRequest = {
    promptPath: path.join(worktree, "prompt.md"),
    model: null,
    effort: null,
    sandbox: false,
    schemaPath: null,
    resume: null,
    cwd: worktree,
    timeoutMs:
      scenario === "timeout" || scenario === "exit-with-descendant"
        ? 400
        : 2500,
    agent: "explore",
    readOnlyVerified: true,
    outputCapBytes: scenario === "cap" ? 64 : 1024,
    attachments: [],
    logPath: path.join(worktree, "delegate.log"),
    briefPath: path.join(worktree, "brief.md"),
  };

  let descendantStopped = false;

  const stopDescendant = async () => {
    if (descendantStopped) {
      return;
    }

    if (fs.existsSync(childPidPath)) {
      const pid = Number(fs.readFileSync(childPidPath, "utf-8"));

      assert.ok(
        Number.isSafeInteger(pid) && pid > 0,
        "fixture wrote an invalid descendant PID"
      );

      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (nodeErrorCode(error) !== "ESRCH") {
          throw error;
        }
      }

      await assertOwnedProcessExited(pid);
    }

    descendantStopped = true;
  };

  const cleanup = async () => {
    await stopDescendant();

    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  };

  return {
    root,
    worktree,
    argsPath,
    childPidPath,
    binary,
    request,
    stopDescendant,
    cleanup,
  };
};

const runnerPorts = (
  binary: string,
  promptPath: string,
  body = "OpenCode lifecycle probe"
) => {
  const runnerFs: RunnerFs = {
    readText: (file) => (file === promptPath ? body : ""),
    writeText: (file, content) => {
      fs.writeFileSync(file, content);
    },
    realpath: (file) => {
      try {
        return fs.realpathSync(file);
      } catch {
        return null;
      }
    },
    readdir: (dir) => fs.readdirSync(dir),
    size: (file) => {
      try {
        return fs.statSync(file).size;
      } catch {
        return null;
      }
    },
    readPrefix: (file, max) => {
      try {
        return fs.readFileSync(file).subarray(0, max).toString("utf-8");
      } catch {
        return "";
      }
    },
  };

  return {
    process: nodeProcess,
    clock: {
      now: () => Date.now(),
      every: (ms, fn) => {
        const timer = setInterval(fn, ms);

        timer.unref();

        return () => {
          clearInterval(timer);
        };
      },
    },
    fs: runnerFs,
    env: process.env,
    platform: currentPlatform(),
    binary,
    nonce: () => "lifecycle-test",
  } satisfies RunnerPorts;
};

const withServiceSentinel = async (run: () => Promise<void>) => {
  const service = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    {
      stdio: "ignore",
    }
  );

  await once(service, "spawn");

  try {
    await run();

    assert.equal(service.exitCode, null);
    assert.equal(service.signalCode, null);
  } finally {
    if (service.exitCode === null && service.signalCode === null) {
      const exited = once(service, "exit");

      service.kill();

      await exited;
    }
  }
};

test("OpenCode inspection uses a private server and releases its directory", async () => {
  await withServiceSentinel(async () => {
    const fixture = makeFixture("inspect");

    try {
      const configDir = path.join(fixture.root, "private-config");

      const inspect = nativeOpencodeIntrospection(
        fixture.binary,
        fixture.request,
        {
          ...process.env,
          OPENCODE_CONFIG_DIR: configDir,
          OPENAI_API_KEY: "must-not-reach-the-child",
        },
        4000
      );

      const inspected = (command: string) => ({
        args: ["--standalone", "debug", command],
        configDir,
        hasApiKey: false,
      });

      assert.deepEqual(await inspect("config"), inspected("config"));
      assert.deepEqual(await inspect("agents"), inspected("agents"));
      assert.equal(
        fs.existsSync(`${fixture.request.logPath}.introspect-config`),
        false
      );
      assert.equal(
        fs.existsSync(`${fixture.request.logPath}.introspect-agents`),
        false
      );
      fs.rmSync(fixture.worktree, { recursive: true });
      assert.equal(fs.existsSync(fixture.worktree), false);
    } finally {
      await fixture.cleanup();
    }
  });
});

test("OpenCode inspection timeout settles its owned descendant and rejects unsupported standalone", async () => {
  await withServiceSentinel(async () => {
    const hanging = makeFixture("hang");

    try {
      const startedAt = Date.now();

      const inspect = nativeOpencodeIntrospection(
        hanging.binary,
        hanging.request,
        process.env,
        400
      );

      try {
        await inspect("config");

        assert.fail("expected introspection timeout");
      } catch (error) {
        assert.match(
          String(error),
          /effective-config-unverified: opencode-lifecycle-timeout/u
        );
      }

      assert.ok(Date.now() - startedAt < 2500);

      const childPid = Number(fs.readFileSync(hanging.childPidPath, "utf-8"));

      await assertOwnedProcessExited(childPid);
      fs.rmSync(hanging.worktree, { recursive: true });
    } finally {
      await hanging.cleanup();
    }

    const unsupported = makeFixture("unsupported");

    try {
      const inspect = nativeOpencodeIntrospection(
        unsupported.binary,
        unsupported.request,
        process.env,
        1500
      );

      await assert.rejects(
        inspect("config"),
        /OpenCode binary does not support --standalone/iu
      );
      assert.equal(
        fs.existsSync(`${unsupported.request.logPath}.introspect-config`),
        false
      );
      fs.rmSync(unsupported.worktree, { recursive: true });
    } finally {
      await unsupported.cleanup();
    }
  });
});

test("OpenCode private runs settle success, failure, timeout, and output cap", async () => {
  await withServiceSentinel(async () => {
    const scenarios = [
      "success",
      "failure",
      "timeout",
      "cap",
      "exit-with-descendant",
    ] as const;

    await Promise.all(
      scenarios.map(async (scenario) => {
        const fixture = makeFixture(scenario);

        try {
          const startedAt = Date.now();

          const ports = runnerPorts(fixture.binary, fixture.request.promptPath);

          const result = await runDelegate(
            opencode,
            fixture.request,
            "cli",
            ports
          );

          const args = narrow(
            parseJson(fs.readFileSync(fixture.argsPath, "utf-8")),
            arrayOf(isString)
          );

          assert.ok(
            args.includes("--standalone"),
            `${scenario} run did not request a private server`
          );

          const formatIndex = args.indexOf("--format");

          assert.ok(
            args.includes("--format") &&
              defined(args[formatIndex + 1], "format value") === "json",
            `${scenario} run did not request JSON output`
          );

          if (scenario === "success") {
            assert.equal(result.outcome.status, "ok");
          }

          if (scenario === "failure") {
            assert.equal(result.outcome.status, "fail");
          }

          if (scenario === "timeout") {
            assert.equal(result.outcome.status, "fail");
            assert.equal(
              result.outcome.status === "fail" ? result.outcome.cls : "",
              "timeout"
            );
          }

          if (scenario === "cap") {
            assert.equal(result.outcome.status, "fail");
            assert.equal(
              result.outcome.status === "fail" ? result.outcome.cls : "",
              "buffer"
            );
          }

          let removable = true;

          if (scenario === "exit-with-descendant") {
            assert.ok(
              Date.now() - startedAt < 3000,
              "private CLI descendant teardown exceeded its bound"
            );

            const childPid = Number(
              fs.readFileSync(fixture.childPidPath, "utf-8")
            );

            assert.equal(
              result.outcome.status,
              "fail",
              JSON.stringify({
                outcome: result.outcome,
                childAlive: ownedProcessAlive(childPid),
              })
            );
            assert.equal(
              result.outcome.status === "fail" ? result.outcome.cls : "",
              "timeout"
            );

            if (process.platform === "win32") {
              assert.equal(
                ownedProcessAlive(childPid),
                true,
                "fixture must expose the accepted escaped-child limit"
              );
              assert.match(
                result.outcome.status === "fail" ? result.outcome.detail : "",
                /retain the worktree and verify process exit/u
              );
              removable = false;
            } else {
              await assertOwnedProcessExited(childPid);
            }
          }

          if (scenario === "timeout" || scenario === "cap") {
            const childPid = Number(
              fs.readFileSync(fixture.childPidPath, "utf-8")
            );

            await assertOwnedProcessExited(childPid);
          }

          if (!removable) {
            assert.ok(fs.existsSync(fixture.worktree));

            return;
          }

          try {
            fs.rmSync(fixture.worktree, { recursive: true });
          } catch (error) {
            assert.fail(
              `${scenario} worktree removal failed after the run settled: ${String(error)}`
            );
          }

          assert.equal(fs.existsSync(fixture.worktree), false);
        } finally {
          await fixture.cleanup();
        }
      })
    );
  });
});

test("OpenCode closed-stdio descendants expose the accepted Windows limit and settle the POSIX group", async () => {
  await withServiceSentinel(async () => {
    const families = ["run", "config"] as const;
    const scenarios = ["closed-stdio-success", "closed-stdio-failure"] as const;

    const cases: {
      family: (typeof families)[number];
      scenario: (typeof scenarios)[number];
    }[] = [];

    for (const family of families) {
      for (const scenario of scenarios) {
        cases.push({ family, scenario });
      }
    }

    await Promise.all(
      cases.map(async ({ family, scenario }) => {
        const fixture = makeFixture(scenario);

        try {
          let lifecycleFailure = false;

          if (family === "run") {
            const result = await runDelegate(
              opencode,
              fixture.request,
              "cli",
              runnerPorts(fixture.binary, fixture.request.promptPath)
            );

            lifecycleFailure = result.result?.lifecycleError !== undefined;

            if (process.platform === "win32") {
              assert.equal(
                result.outcome.status,
                scenario === "closed-stdio-success" ? "ok" : "fail"
              );
            }
          } else {
            try {
              await nativeOpencodeIntrospection(
                fixture.binary,
                fixture.request,
                process.env,
                2500
              )(family);
            } catch (error) {
              lifecycleFailure = /opencode-lifecycle-timeout/u.test(
                String(error)
              );

              if (!lifecycleFailure) {
                assert.equal(scenario, "closed-stdio-failure");
              }
            }
          }

          const pid = Number(fs.readFileSync(fixture.childPidPath, "utf-8"));

          const alive = ownedProcessAlive(pid);

          if (process.platform === "win32") {
            assert.equal(
              alive,
              true,
              "fixture must expose the accepted detached-child limit"
            );
            assert.ok(fs.existsSync(fixture.worktree));
          } else {
            await assertOwnedProcessExited(pid);
            assert.equal(
              lifecycleFailure,
              false,
              "a confirmed POSIX process group exit must preserve the CLI result"
            );
            fs.rmSync(fixture.worktree, { recursive: true });
            assert.equal(fs.existsSync(fixture.worktree), false);
          }
        } finally {
          await fixture.cleanup();
        }
      })
    );
  });
});

test("OpenCode lifecycle diagnostics preserve deadlines and exit uncertainty", async () => {
  await withServiceSentinel(async () => {
    const hanging = makeFixture("hang");

    try {
      const steps: LifecycleStep[] = [];

      const startedAt = Date.now();

      await assert.rejects(
        nativeOpencodeIntrospection(
          hanging.binary,
          hanging.request,
          process.env,
          400,
          steps
        )("config"),
        /opencode-lifecycle-timeout/u
      );
      assert.ok(
        Date.now() - startedAt < 2500,
        "collection must not extend the introspection bound"
      );
      assert.deepEqual(
        steps.map(({ step, outcome, budgetMs }) => ({
          step,
          outcome,
          budgetMs,
        })),
        [
          {
            step: "debug-config",
            outcome: "timeout",
            budgetMs: defined(steps[0], "step").budgetMs,
          },
        ]
      );
      assert.ok(
        defined(steps[0], "step").budgetMs > 0 &&
          defined(steps[0], "step").budgetMs <= 400,
        "budget is the remaining request deadline, not a storage ceiling"
      );
      await assertOwnedProcessExited(
        Number(fs.readFileSync(hanging.childPidPath, "utf-8"))
      );
      fs.rmSync(hanging.worktree, { recursive: true });
    } finally {
      await hanging.cleanup();
    }

    const unsupported = makeFixture("unsupported");

    const originalPath = process.env["PATH"];

    process.env["PATH"] =
      `${path.dirname(unsupported.binary)}${path.delimiter}${originalPath ?? ""}`;

    try {
      const deps = nodeDeps();

      const checkLifecycle = async (collect: boolean) => {
        let request = { ...unsupported.request };

        if (collect) {
          request = { ...request, collectLifecycle: true };
        }

        const result = await deps.delegate("opencode", request, "cli");

        assert.deepEqual(
          result.invocations.map((invocation) => [
            invocation.launched,
            invocation.outcome,
            invocation.lifecycleSteps?.map((step) => [step.step, step.outcome]),
          ]),
          [
            [
              false,
              "config",
              collect ? [["debug-config", "failed"]] : undefined,
            ],
          ]
        );
      };

      await checkLifecycle(true);
      await checkLifecycle(false);
    } finally {
      process.env["PATH"] = originalPath;

      await unsupported.cleanup();
    }

    await Promise.all(
      [true, false].map(async (collect) => {
        const fixture = makeFixture("exit-with-descendant");

        try {
          let request = { ...fixture.request };

          if (collect) {
            request = { ...request, collectLifecycle: true };
          }

          const run = await runDelegate(
            opencode,
            request,
            "cli",
            runnerPorts(fixture.binary, fixture.request.promptPath)
          );

          const steps = run.invocations.flatMap(
            (invocation) => invocation.lifecycleSteps ?? []
          );

          if (collect) {
            const by = new Map<string, LifecycleStep>(
              steps.map((step) => [step.step, step])
            );

            assert.equal(by.size, steps.length, "one record per step");
            assert.ok(by.has("response") && by.has("teardown"));

            for (const step of steps) {
              assert.ok(
                Number.isSafeInteger(step.elapsedMs) &&
                  step.elapsedMs >= 0 &&
                  step.budgetMs > 0 &&
                  step.budgetMs <= fixture.request.timeoutMs + 2000,
                `${step.step} stays within its real bound`
              );
            }

            assert.equal(
              defined(by.get("teardown"), "teardown").outcome,
              run.result?.lifecycleError === undefined ? "ok" : "unconfirmed"
            );

            if (process.platform === "win32") {
              assert.equal(
                defined(by.get("teardown"), "teardown").outcome,
                "unconfirmed"
              );
            }

            assert.doesNotMatch(
              JSON.stringify(steps),
              /fixture|lifecycle-|\|\//u
            );
          } else {
            assert.deepEqual(
              steps,
              [],
              "disabled collection leaves no lifecycle steps"
            );
          }

          const childPid = Number(
            fs.readFileSync(fixture.childPidPath, "utf-8")
          );

          if (process.platform === "win32") {
            assert.equal(ownedProcessAlive(childPid), true);
          } else {
            await assertOwnedProcessExited(childPid);
            fs.rmSync(fixture.worktree, { recursive: true });
          }
        } finally {
          await fixture.cleanup();
        }
      })
    );
  });
});

test("stdout lines reach the line hook through a real process", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stdout-lines-"));

  try {
    const lines: string[] = [];

    const launch = {
      argv: [
        process.execPath,
        "-e",
        String.raw`process.stdout.write('one\r'); setTimeout(() => { process.stdout.write('\ntwo\nlast'); }, 20)`,
      ],
      stdin: null,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      ),
      cwd: root,
    };

    const result = await nodeProcess.start(launch, {
      logPath: path.join(root, "out.log"),
      capBytes: 1000,
      onLine: (line) => {
        lines.push(line);
      },
    }).done;

    assert.equal(result.exit, 0);
    assert.deepEqual(lines, ["one", "two", "last"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nodeProbeSpawn tears down a timed-out process tree, caps streams, and leaves no files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-probe-"));

  const probeCwd = path.join(root, "probe-cwd");

  const pidFile = path.join(root, "descendant.pid");

  fs.mkdirSync(probeCwd);

  const before = fs.readdirSync(probeCwd);

  try {
    const secret = "1.2.3-AbCdEf123456";

    const output = [
      "-e",
      `process.stdout.write(${JSON.stringify(secret)} + 'x'.repeat(200000)); process.stderr.write('y'.repeat(200000));`,
    ];

    const capped = await nodeProbeSpawn(process.execPath, output, {
      cwd: probeCwd,
      timeoutMs: 2500,
    });

    assert.deepEqual(
      [
        capped.exit,
        Buffer.byteLength(capped.stdout),
        Buffer.byteLength(capped.stderr),
      ],
      [0, 65_536, 65_536]
    );

    const { probes } = await probeProviders(
      [{ provider: "codex", sandboxRequired: false }],
      {
        cwd: probeCwd,
        discovery: {
          resolve: () => ({ status: "path", path: process.execPath }),
          doctor: () => [],
          probes: 0,
        },
        spawn: async (_binary, _args, launch) => {
          const out = await nodeProbeSpawn(process.execPath, output, launch);

          return out;
        },
      }
    );

    assert.equal(defined(probes[0], "probe").version, null);
    assert.equal(JSON.stringify(probes).includes(secret), false);

    await Promise.all(
      [false, true].map(async (overflow) => {
        const sources = {
          config: `process.stdout.write(JSON.stringify([{ value: ${JSON.stringify(secret)} + 'x'.repeat(100000) }]));`,
          agents: `const array = JSON.stringify([{ name: 'explore', description: 'x'.repeat(100000) }]);
          process.stdout.write(${overflow ? "array.padEnd(1024 * 1024) + '!'" : "array"});`,
        };

        const debugBytes: [number, number][] = [];

        const { probes: overflowProbes } = await probeProviders(
          [{ provider: "opencode", sandboxRequired: false }],
          {
            cwd: probeCwd,
            platform: { ...currentPlatform(), bubblewrap: false },
            discovery: {
              resolve: () => ({ status: "path", path: process.execPath }),
              doctor: () => [],
              probes: 0,
            },
            spawn: async (binary, args, launch) => {
              const probed = args.at(2);

              let sourceText = "process.stdout.write('1.2.3');";

              if (probed === "config" || probed === "agents") {
                sourceText = sources[probed];
              }

              const actual = await nodeProbeSpawn(
                binary,
                [
                  "-e",
                  `${sourceText}process.stderr.write('y'.repeat(200000));`,
                ],
                launch
              );

              if (probed === "config" || probed === "agents") {
                debugBytes.push([
                  Buffer.byteLength(actual.stdout),
                  Buffer.byteLength(actual.stderr),
                ]);
              }

              return actual;
            },
          }
        );

        assert.equal(
          defined(overflowProbes[0], "probe").readiness,
          overflow ? "error" : "ok"
        );
        assert.equal(
          defined(overflowProbes[0], "probe").failureCategory,
          overflow ? "config-error" : null
        );
        assert.deepEqual(
          debugBytes.map(([, stderr]) => stderr),
          [64 * 1024, 64 * 1024]
        );
        assert.ok(debugBytes.every(([stdout]) => stdout > 64 * 1024));

        if (overflow) {
          assert.equal(defined(debugBytes[1], "bytes")[0], 1024 * 1024);
        }

        assert.equal(JSON.stringify(overflowProbes).includes(secret), false);
      })
    );

    const source = `
      const descendant = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', windowsHide: true });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));
    `;

    const timedOut = await nodeProbeSpawn(
      process.execPath,
      ["-e", `${source}setInterval(() => {}, 1000);`],
      {
        cwd: probeCwd,
        timeoutMs: 1100,
      }
    );

    assert.equal(timedOut.timedOut, true);
    await assertOwnedProcessExited(Number(fs.readFileSync(pidFile, "utf-8")));
    assert.deepEqual(fs.readdirSync(probeCwd), before);
  } finally {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, "utf-8"));

      if (ownedProcessAlive(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }

    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

test(
  "nodeProbeSpawn runs Windows batch shims with a spaced path and argument",
  { skip: process.platform === "win32" ? false : "Windows .cmd shim test" },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch probe-"));

    try {
      const shim = path.join(root, "probe tool.cmd");

      const script = path.join(root, "probe.cjs");

      fs.writeFileSync(script, "process.stdout.write(process.argv[2]);");
      fs.writeFileSync(
        shim,
        `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      );

      const output = await nodeProbeSpawn(shim, ["version label"], {
        cwd: root,
        timeoutMs: 2500,
      });

      assert.deepEqual([output.exit, output.stdout], [0, "version label"]);
    } finally {
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  }
);

test(
  "nodeProbeSpawn tears down a POSIX process group after its leader exits",
  { skip: process.platform === "win32" ? "POSIX process-group test" : false },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-probe-"));

    const pidFile = path.join(root, "descendant.pid");

    try {
      const source = `
      const descendant = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));
      process.exit(0);
    `;

      const output = await nodeProbeSpawn(process.execPath, ["-e", source], {
        cwd: root,
        timeoutMs: 2500,
      });

      assert.equal(output.exit, 0);
      await assertOwnedProcessExited(Number(fs.readFileSync(pidFile, "utf-8")));
    } finally {
      if (fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, "utf-8"));

        if (ownedProcessAlive(pid)) {
          process.kill(pid, "SIGKILL");
        }
      }

      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  }
);
