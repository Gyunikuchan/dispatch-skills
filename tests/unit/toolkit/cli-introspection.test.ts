import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { readManifest } from "../../../skills/dispatch/scripts/lib/session.ts";
import { nodeProcess } from "../../../skills/dispatch/scripts/providers/node-process.ts";
import { nativeOpencodeIntrospection } from "../../../skills/dispatch/scripts/providers/opencode-runtime.ts";
import type {
  DelegateRequest,
  ProcessResult,
} from "../../../skills/dispatch/scripts/providers/types.ts";
import type { CliDeps } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import {
  main,
  nodeDeps,
} from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import { defined } from "../../helpers/guards.ts";
import { narrow } from "./helpers/json.ts";
import { sessionFixture } from "./helpers/session.ts";

const withSettleGroup = (port: typeof nodeProcess) =>
  narrow(
    port,
    (value): value is Required<typeof nodeProcess> =>
      typeof value === "object" &&
      value !== null &&
      "settleGroup" in value &&
      typeof value.settleGroup === "function"
  );

const unusedRequest = () => ({
  promptPath: "/unused",
  model: null,
  effort: null,
  sandbox: true,
  schemaPath: null,
  resume: null,
  cwd: process.cwd(),
  timeoutMs: 1000,
  outputCapBytes: 1024,
  attachments: [],
  logPath: "/unused",
  briefPath: "/unused",
});

const deferredResult = () => {
  let resolve!: (value: ProcessResult) => void;

  // oxlint-disable-next-line promise/avoid-new, promise/param-names -- deferred handle needs an externally-resolved promise; settle assigns the outer resolver
  const done = new Promise<ProcessResult>((settle) => {
    resolve = settle;
  });

  return { done, resolve };
};

const taskResult = (stderrTail = "", stdout = "[]") => ({
  exit: stderrTail ? 2 : 0,
  signal: null,
  stdout,
  stdoutPath: "/unused",
  stderrTail,
  durationMs: 0,
  timedOut: false,
  truncated: false,
});

const flush = async () => {
  for (let i = 0; i < 12; i += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
    await Promise.resolve();
  }
};

test("OpenCode preparation classifies bounded lifecycle failures through the native delegate caller", async (t) => {
  const request: DelegateRequest = {
    promptPath: "/prompt",
    model: null,
    effort: null,
    sandbox: false,
    schemaPath: null,
    resume: null,
    cwd: process.cwd(),
    timeoutMs: 60_000,
    agent: null,
    outputCapBytes: 1000,
    attachments: [],
    logPath: "/unused",
    briefPath: "/unused",
  };

  t.mock.timers.enable();
  t.mock.method(fs, "existsSync", () => true);
  t.mock.method(fs, "statSync", () => ({ isFile: () => true, mode: 0o755 }));
  t.mock.method(fs, "readdirSync", () => []);
  t.mock.method(fs, "unlinkSync", () => {});
  let currentScenario = "";
  let child = deferredResult();
  let launches: string[][] = [];
  t.mock.method(nodeProcess, "start", (launch: { argv: string[] }) => {
    launches.push(launch.argv);

    if (launch.argv[0] === "taskkill") {
      if (currentScenario === "killer-unconfirmed") {
        child.resolve(taskResult());

        // oxlint-disable-next-line promise/avoid-new -- never-resolving promise models a hung child; the scenario driver settles the outer flow
        return { pid: 2, done: new Promise(() => {}) };
      }

      if (currentScenario === "timeout") {
        child.resolve(taskResult("terminated"));
      }

      return { pid: 2, done: Promise.resolve(taskResult()) };
    }

    let { done } = child;

    if (currentScenario === "unsupported") {
      done = Promise.resolve(
        taskResult(
          "Unrecognized flag: --standalone in command opencode debug config"
        )
      );
    } else if (currentScenario === "permission") {
      done = Promise.resolve(taskResult("permission denied"));
    } else if (currentScenario === "group-unconfirmed") {
      done = Promise.resolve(taskResult());
    } else if (currentScenario === "invalid-json") {
      done = Promise.resolve(taskResult("", "credential-must-not-leak"));
    }

    return {
      pid: currentScenario === "spawn-failure" ? -1 : 50,
      done,
    };
  });
  t.mock.method(
    withSettleGroup(nodeProcess),
    "settleGroup",
    () => currentScenario !== "group-unconfirmed"
  );
  let signals = 0;
  t.mock.method(nodeProcess, "signal", () => {
    signals += 1;

    if (currentScenario === "timeout") {
      child.resolve(taskResult("terminated"));
    }
  });

  for (const scenario of [
    "child-unconfirmed",
    "killer-unconfirmed",
    "timeout",
    "unsupported",
    "permission",
    "invalid-json",
    "group-unconfirmed",
    "spawn-failure",
  ] as const) {
    if (scenario === "killer-unconfirmed" && process.platform !== "win32") {
      continue;
    }

    currentScenario = scenario;
    signals = 0;
    launches = [];
    child = deferredResult();
    let restorePlatform: (() => void) | undefined;

    if (scenario === "group-unconfirmed") {
      const descriptor = defined(
        Object.getOwnPropertyDescriptor(process, "platform")
      );

      Object.defineProperty(process, "platform", {
        ...descriptor,
        value: "linux",
      });
      restorePlatform = () => {
        Object.defineProperty(process, "platform", descriptor);
      };
    }

    try {
      const pending = nodeDeps().delegate("opencode", request, "cli");

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await flush();

      if (
        [
          "child-unconfirmed",
          "killer-unconfirmed",
          "timeout",
          "spawn-failure",
        ].includes(scenario)
      ) {
        t.mock.timers.tick(10_000);
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await flush();

        if (scenario === "spawn-failure") {
          child.resolve(taskResult("spawn opencode ENOENT"));
        } else {
          t.mock.timers.tick(1000);
          // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
          await flush();
        }
      }

      let settled = false;
      void pending.then(() => {
        settled = true;

        return true;
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await flush();
      assert.equal(
        settled,
        true,
        "inspection must settle at the per-command deadline plus grace"
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const run = await pending;
      assert.equal(run.outcome.status, "fail");

      if (run.outcome.status !== "fail") {
        return;
      }

      assert.equal(
        run.outcome.cls,
        [
          "child-unconfirmed",
          "killer-unconfirmed",
          "timeout",
          "group-unconfirmed",
        ].includes(scenario)
          ? "timeout"
          : "config",
        run.outcome.detail
      );
      assert.doesNotMatch(run.outcome.detail, /credential-must-not-leak/u);

      if (run.outcome.cls === "timeout") {
        assert.match(
          run.outcome.detail,
          /effective-config-unverified: opencode-lifecycle-timeout/u
        );
      }

      assert.equal(run.invocations[0]?.launched, false);
      assert.equal(launches.filter((argv) => argv[0] !== "taskkill").length, 1);
      assert.deepEqual(launches[0]?.slice(-3), [
        "--standalone",
        "debug",
        "config",
      ]);

      if (scenario === "spawn-failure") {
        assert.equal(signals, 0);
        assert.equal(
          launches.some((argv) => argv[0] === "taskkill"),
          false
        );
      }
    } finally {
      restorePlatform?.();
    }
  }
});

test("OpenCode inspection preserves an in-budget result when confirmed group settlement uses its grace", async (t) => {
  t.mock.timers.enable();

  const descriptor = defined(
    Object.getOwnPropertyDescriptor(process, "platform")
  );

  Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
  t.mock.method(fs, "unlinkSync", () => {});
  const request = unusedRequest();

  for (const scenario of ["success", "nonzero", "truncated"] as const) {
    let finish!: (result: ProcessResult) => void;
    let confirm!: (value: boolean) => void;
    t.mock.method(nodeProcess, "start", () => ({
      pid: 50,
      // oxlint-disable-next-line promise/avoid-new -- deferred handle settles the mocked child from the scenario driver
      done: new Promise<ProcessResult>((resolve) => {
        finish = resolve;
      }),
    }));
    t.mock.method(
      withSettleGroup(nodeProcess),
      "settleGroup",
      async () =>
        // oxlint-disable-next-line promise/avoid-new -- deferred handle settles the confirmation gate from the scenario driver
        await new Promise<boolean>((resolve) => {
          confirm = resolve;
        })
    );

    const pending = nativeOpencodeIntrospection(
      "opencode",
      request,
      {},
      100
    )("config");

    const checked = (async () => {
      try {
        const value = await pending;

        return { value, error: null };
      } catch (error: unknown) {
        return { value: null, error: String(error) };
      }
    })();

    t.mock.timers.tick(90);
    finish({
      exit: scenario === "nonzero" ? 7 : 0,
      signal: null,
      stdout: "[]",
      stdoutPath: "/unused",
      stderrTail: "",
      durationMs: 90,
      timedOut: false,
      truncated: scenario === "truncated",
    });

    for (let i = 0; i < 8; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await Promise.resolve();
    }

    t.mock.timers.tick(100);
    confirm(true);
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
    const result = await checked;

    if (scenario === "success") {
      assert.deepEqual(result, { value: [], error: null });
    } else {
      assert.match(
        result.error ?? "",
        /effective-config-unverified: native introspection failed/u
      );
    }
  }
});

test("tool calls take the orchestrator from the recorded host and ignore env platform markers", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const manifestFile = path.join(f.session, "manifest.json");

    const setHost = (host: unknown) => {
      fs.writeFileSync(
        manifestFile,
        JSON.stringify({ ...readManifest(f.session), host })
      );
    };

    const seen: unknown[] = [];

    const base = {
      ...f.deps,
      handler: ({ deps }: { deps: { orchestrator: unknown } }) => {
        seen.push(deps.orchestrator);

        return { ok: true, value: null, summary: "seen", exit: 0 as const };
      },
    };

    const call = async (deps: typeof base) => {
      f.lines.length = 0;
      assert.equal(
        await main(
          ["lint", "run", "x", "--session", f.session],
          // SAFETY: base spreads the live CliDeps fixture, so the unknown step preserves the CliDeps shape.
          //oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- fixture double reaches CliDeps only through unknown; the direct assertion lacks overlap; test restores the static fixture type the double was built with; the runtime shape is asserted below
          deps as unknown as CliDeps
        ),
        0
      );
    };

    setHost("copilot");
    await call({ ...base, env: { CLAUDECODE: "1", COPILOT_MODEL: "gpt-5" } });
    assert.deepEqual(seen.pop(), { platform: "copilot", model: "gpt-5" });

    const injected = {
      ...base,
      orchestrator: { platform: "claude" as const, model: null },
      env: {},
    };

    await call(injected);
    assert.deepEqual(seen.pop(), { platform: "copilot", model: null });
    assert.deepEqual(injected.orchestrator, {
      platform: "claude",
      model: null,
    });

    for (const host of [undefined, "github-copilot", 3]) {
      setHost(host);
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await call({ ...base, env: { CODEX_THREAD_ID: "t", CLAUDECODE: "1" } });
      assert.equal(seen.pop(), null, String(host));
    }

    await call({ ...injected, env: { CLAUDECODE: "1" } });
    assert.deepEqual(seen.pop(), { platform: "claude", model: null });

    assert.equal(nodeDeps().orchestrator, null);
  } finally {
    f.cleanup();
  }
});

test("blocked sandbox starts no introspection and returns the runner refusal", async (t) => {
  t.mock.method(fs, "existsSync", () => true);
  t.mock.method(fs, "statSync", () => ({ isFile: () => true, mode: 0o755 }));
  t.mock.method(fs, "readdirSync", () => []);

  const descriptor = defined(
    Object.getOwnPropertyDescriptor(process, "platform")
  );

  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
  const started: string[][] = [];
  t.mock.method(nodeProcess, "start", (launch: { argv: string[] }) => {
    started.push(launch.argv);

    return {
      pid: 50,
      done: Promise.resolve({
        exit: 0,
        signal: null,
        stdout: "[]",
        stdoutPath: "/unused",
        stderrTail: "",
        durationMs: 0,
        timedOut: false,
        truncated: false,
      }),
    };
  });
  const deps = nodeDeps();

  const request: DelegateRequest = {
    promptPath: "/prompt",
    model: null,
    effort: null,
    sandbox: true,
    schemaPath: null,
    resume: null,
    cwd: process.cwd(),
    timeoutMs: 60_000,
    agent: null,
    outputCapBytes: 1000,
    attachments: [],
    logPath: "/unused",
    briefPath: "/unused",
  };

  const run = await deps.delegate("opencode", request, "cli");
  assert.deepEqual(started, []);
  assert.equal(run.outcome.status, "fail");

  if (run.outcome.status === "fail") {
    assert.equal(run.outcome.cls, "sandbox-unsupported");
  }

  assert.equal(run.invocations[0]?.launched, false);
  assert.deepEqual(deps.sandboxSupported, {
    claude: false,
    agy: true,
    copilot: true,
    opencode: false,
    codex: true,
  });
});

const streamResult = (stdout: string, stderrTail = "") => ({
  exit: stderrTail ? 137 : 0,
  signal: null,
  stdout,
  stdoutPath: "/unused",
  stderrTail,
  durationMs: 0,
  timedOut: false,
  truncated: false,
});

test("introspection allows 10000 ms per command and fails past it", async (t) => {
  t.mock.timers.enable();

  const descriptor = defined(
    Object.getOwnPropertyDescriptor(process, "platform")
  );

  Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
  t.mock.method(fs, "unlinkSync", () => {});
  t.mock.method(withSettleGroup(nodeProcess), "settleGroup", () => true);

  let finish!: (value: ProcessResult) => void;
  t.mock.method(nodeProcess, "start", () => ({
    pid: 50,
    // oxlint-disable-next-line promise/avoid-new -- deferred handle settles the mocked child from the timeout driver
    done: new Promise<ProcessResult>((resolve) => {
      finish = resolve;
    }),
  }));
  t.mock.method(nodeProcess, "signal", () => {
    finish(streamResult("", "killed"));
  });
  const request = unusedRequest();

  const inspect = async () =>
    await nativeOpencodeIntrospection(
      "opencode",
      request,
      {},
      60_000
    )("config")
      .then((value) => ({ value, error: "" }))
      .catch((error: unknown) => ({ value: null, error: String(error) }));

  const slow = inspect();
  t.mock.timers.tick(9999);
  await flush();
  finish(streamResult("[]"));
  await flush();
  assert.deepEqual(await slow, { value: [], error: "" });

  const hung = inspect();
  t.mock.timers.tick(10_000);
  await flush();
  const hungResult = await hung;

  assert.match(
    hungResult.error,
    /effective-config-unverified: opencode-lifecycle-timeout/u
  );
});
