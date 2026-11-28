import assert from "node:assert/strict";
import { test } from "node:test";

import type { HostUsageFs } from "../../../skills/dispatch/scripts/lib/usage/rows.ts";
import { agy } from "../../../skills/dispatch/scripts/providers/agy.ts";
import { claude } from "../../../skills/dispatch/scripts/providers/claude.ts";
import { codex } from "../../../skills/dispatch/scripts/providers/codex.ts";
import { copilot } from "../../../skills/dispatch/scripts/providers/copilot.ts";
import { opencode } from "../../../skills/dispatch/scripts/providers/opencode.ts";
import {
  CONTINUE_PROMPT,
  IDLE_TIMEOUT_MS,
  runDelegate,
} from "../../../skills/dispatch/scripts/providers/runner.ts";
import type { RunnerPorts } from "../../../skills/dispatch/scripts/providers/runner.ts";
import type {
  DelegateRequest,
  Launch,
  PlatformEnv,
  ProcessResult,
  ProviderSpec,
} from "../../../skills/dispatch/scripts/providers/types.ts";

const defaultFiles = () => ({
  "/r/p.md": "Review it",
});

const EMPTY_FILES: Record<string, string | Buffer> = {};
const EMPTY_USAGE_FS: Partial<HostUsageFs> = {};

function memUsageFs(
  files: Record<string, string | Buffer> = EMPTY_FILES,
  extra: Partial<HostUsageFs> = EMPTY_USAGE_FS
): HostUsageFs {
  const find = (file: string) => {
    const norm = file.replaceAll("\\", "/");
    const val = files[norm] ?? files[file];

    // eslint-disable-next-line eslint/no-nested-ternary -- compact fixture expectation table.
    return val === undefined
      ? undefined
      : typeof val === "string"
        ? Buffer.from(val, "utf-8")
        : val;
  };

  return {
    list: (dir) => {
      const prefix = `${dir.replaceAll("\\", "/").replace(/\/$/u, "")}/`;
      const names = new Set<string>();

      for (const rawKey of Object.keys(files)) {
        const k = rawKey.replaceAll("\\", "/");

        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length);
          // eslint-disable-next-line eslint/prefer-destructuring -- intentional test pattern.
          const seg = rest.split("/")[0];

          if (seg !== undefined && seg !== null && seg !== "") {
            names.add(seg);
          }
        }
      }

      return [...names];
    },
    stat: (file) => {
      const buf = find(file);

      return buf ? { size: buf.length, mtimeMs: 0 } : null;
    },
    read: (file, maxBytes) => {
      const buf = find(file);

      if (!buf) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }

      return buf.subarray(0, maxBytes);
    },
    decompress: null,
    ...extra,
  };
}

const posix: PlatformEnv = {
  os: "linux",
  arch: "x64",
  wsl: false,
  bubblewrap: true,
  argvLimit: 100_000,
  home: "/h",
  path: [],
  pathExt: [],
};

const req: DelegateRequest = {
  promptPath: "/r/p.md",
  model: null,
  effort: null,
  sandbox: false,
  schemaPath: null,
  resume: null,
  cwd: "/repo",
  timeoutMs: 5000,
  outputCapBytes: 100,
  attachments: [],
  logPath: "/r/log",
  briefPath: "/r/brief.md",
};

const ok = (over: Partial<ProcessResult> = {}) => ({
  exit: 0,
  signal: null,
  stdout: '{"result":"R"}',
  stdoutPath: "/r/log",
  stderrTail: "",
  durationMs: 1,
  timedOut: false,
  truncated: false,
  ...over,
});

const memFs = (
  files: Record<string, string>,
  links: Record<string, string> = {}
) => {
  const map = new Map(Object.entries(files));

  return {
    files: map,
    // eslint-disable-next-line typescript/no-unsafe-argument -- fixture/mock boundary: values are validated by helpers before use.
    readText: (f: string) => map.get(f) ?? "",
    writeText: (f: string, t: string) => {
      // eslint-disable-next-line typescript/no-unsafe-argument -- fixture/mock boundary: values are validated by helpers before use.
      map.set(f, t);
    },
    // eslint-disable-next-line typescript/no-unsafe-return, typescript/no-unsafe-member-access, typescript/no-unsafe-argument -- fixture/mock boundary: values are validated by helpers before use.
    realpath: (f: string) => links[f] ?? (map.has(f) ? f : null),
    readdir: () => [],
    // eslint-disable-next-line typescript/no-unsafe-argument -- fixture/mock boundary: values are validated by helpers before use.
    size: (f: string) =>
      map.has(f) ? Buffer.byteLength(map.get(f) ?? "") : null,
    readPrefix: (f: string, n: number) =>
      // eslint-disable-next-line typescript/no-unsafe-argument -- fixture/mock boundary: values are validated by helpers before use.
      Buffer.from(map.get(f) ?? "")
        // eslint-disable-next-line typescript/no-unsafe-argument -- fixture/mock boundary: values are validated by helpers before use.
        .subarray(0, n)
        .toString("utf-8"),
  };
};

/** Placeholder until the fake process registers its real callback. */
const noop = () => {};

/** Manual clock: timers fire only when the test advances time. */
const manualClock = () => {
  let now = 0;

  const timers: { at: number; ms: number; fn: () => void; live: boolean }[] =
    [];

  return {
    now: () => now,
    every: (ms: number, fn: () => void) => {
      const t = { at: now + ms, ms, fn, live: true };
      timers.push(t);

      return () => {
        t.live = false;
      };
    },
    advance(ms: number) {
      now += ms;

      // SAFETY: snapshot because t.fn() may mutate timers while iterating.
      // eslint-disable-next-line unicorn/no-useless-spread
      for (const t of [...timers]) {
        while (t.live && t.at <= now) {
          t.at += t.ms;
          t.fn();
        }
      }
    },
  };
};

const harness = (
  platform: PlatformEnv,
  files: Record<string, string> = defaultFiles()
) => {
  const launches: Launch[] = [];
  const signals: string[] = [];
  const clock = manualClock();
  let finish: (r: ProcessResult) => void = noop;
  let activity: () => void = noop;
  let line: (value: string, fragment?: boolean) => void = noop;
  const fs = memFs(files);

  const ports: RunnerPorts = {
    process: {
      start: (launch, io) => {
        launches.push(launch);

        if (io.onActivity) {
          activity = io.onActivity;
        }

        if (io.onLine) {
          line = io.onLine;
        }

        if (launch.argv[0] === "taskkill") {
          return { pid: 99, done: Promise.resolve(ok()) };
        }

        return {
          pid: 50,
          // eslint-disable-next-line typescript/avoid-new -- intentional test pattern.
          done: new Promise<ProcessResult>((resolve) => {
            finish = resolve;
          }),
        };
      },
      signal: (pid, sig) => {
        signals.push(`${pid}:${sig}`);
      },
    },
    clock,
    fs,
    usageFs: memUsageFs({}),
    platform,
    binary: "claude",
    nonce: () => "N0NCE",
    env: {
      PATH: "/bin",
      HOME: "/h",
      ANTHROPIC_API_KEY: "sk-1",
      GITHUB_TOKEN: "ghp",
      AWS_SECRET_ACCESS_KEY: "x",
      HTTPS_PROXY: "http://p",
    },
  };

  return {
    ports,
    launches,
    signals,
    clock,
    fs,
    finish: (r: ProcessResult) => {
      finish(r);
    },
    activity: () => {
      activity();
    },
    line: (value: string, fragment?: boolean) => {
      activity();
      line(value, fragment);
    },
  };
};

const flush = async () => {
  // eslint-disable-next-line typescript/avoid-new -- intentional test pattern.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

const { silentUntilExit: _silent, ...nudgeBase } = claude;

const makeNudgeSpec = (sessionId: string | null) => ({
  ...nudgeBase,
  id: "codex" as const,
  attemptSession: () => sessionId,
  parse: (out: ProcessResult) =>
    out.stdout.includes("FINAL")
      ? {
          status: "ok" as const,
          text: "FINAL",
          sessionId: "sess1",
          resume: null,
        }
      : {
          status: "fail" as const,
          cls: "empty-output" as const,
          detail: "empty",
        },
  // eslint-disable-next-line typescript/no-explicit-any -- intentional partial mock widened to exercise runner edge cases.
  argv: (r: any) => ({
    // eslint-disable-next-line typescript/strict-boolean-expressions, typescript/no-unsafe-member-access -- test predicate intentionally checks fixture value truthiness.
    argv: ["bin", r.resume ? `resume:${r.resume}` : "fresh", r.prompt],
    stdin: null,
    env: {},
    // eslint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access -- fixture/mock boundary: values are validated by helpers before use.
    cwd: r.cwd,
  }),
});

// T2 wrap-up RED: deadline notice, stop/resume, budget, fallback.

test("fresh and resumed launches state the same run deadline", async () => {
  const h = harness(posix);

  const run = runDelegate(
    claude,
    { ...req, timeoutMs: 1_800_000 },
    "cli",
    h.ports
  );

  await flush();
  const prompt = h.launches[0]?.argv[2] ?? "";
  const deadlineIso = new Date(1_800_000).toISOString();
  const wrapUpIso = new Date(1_500_000).toISOString();
  assert.ok(
    prompt.includes(
      `[DEADLINE]: ${deadlineIso} (30m remaining; wrap-up at ${wrapUpIso})`
    ),
    `unexpected deadline notice in: ${prompt}`
  );
  h.finish(
    ok({
      stdout: JSON.stringify({
        type: "result",
        result: "R",
        session_id: "sess-1",
      }),
    })
  );
  await run;
  {
    // resumed launch prompt states the same run deadline
    const resumed = harness(posix);

    const resumedRun = runDelegate(
      makeNudgeSpec("sess1"),
      { ...req, timeoutMs: 1_800_000 },
      "cli",
      resumed.ports
    );

    await flush();
    resumed.finish(ok({ exit: 1, stdout: "empty" }));
    await flush();
    await flush();
    const iso = new Date(1_800_000).toISOString();
    assert.ok((resumed.launches[0]?.argv[2] ?? "").includes("[DEADLINE]:"));
    assert.ok((resumed.launches[0]?.argv[2] ?? "").includes(iso));
    assert.ok((resumed.launches[1]?.argv[2] ?? "").includes("[DEADLINE]:"));
    assert.ok((resumed.launches[1]?.argv[2] ?? "").includes(iso));
    resumed.finish(ok({ stdout: "FINAL" }));
    await resumedRun;
  }
});

test("wrap-up stop: Claude preset launch stops at deadline minus five and resumes with wrap-up", async () => {
  const h = harness(posix);

  const run = runDelegate(
    claude,
    { ...req, timeoutMs: 1_800_000 },
    "cli",
    h.ports
  );

  await flush();
  assert.ok((h.launches[0]?.argv ?? []).includes("--session-id"));
  h.clock.advance(1_500_000);
  await flush();
  assert.deepEqual(h.signals, ["-50:SIGTERM"]);
  h.finish(ok({ exit: null, signal: "SIGTERM", stdout: "partial" }));
  await flush();
  await flush();
  assert.equal(h.launches.length, 2);
  const resumeArgv = h.launches[1]?.argv ?? [];
  assert.ok(resumeArgv.includes("--resume"));
  assert.ok(!resumeArgv.includes("--session-id"));
  const wrapPrompt = (h.launches[1]?.argv ?? []).join("\n");
  const deadlineIso = new Date(1_800_000).toISOString();
  assert.ok(
    wrapPrompt.includes("Make no further tool calls"),
    "wrap-up prompt must forbid further tool calls"
  );
  assert.ok(
    wrapPrompt.includes(`[DEADLINE]: ${deadlineIso} (5m remaining)`),
    "wrap-up launch must show 5m remaining"
  );
  assert.ok(
    !wrapPrompt.includes("wrap-up at"),
    "wrap-up launch must omit wrap-up timestamp"
  );
  h.finish(
    ok({
      stdout: JSON.stringify({
        type: "result",
        result: "FINAL",
        session_id: "sess-1",
      }),
    })
  );
  const done = await run;
  assert.equal(done.outcome.status, "ok");
  assert.equal(done.outcome.status === "ok" && done.outcome.text, "FINAL");
});

test("deadline notice: continue-resume omits wrap-up time once wrap-up instant has passed", async () => {
  const h = harness(posix);

  const spec = {
    ...makeNudgeSpec("sess-late"),
    // eslint-disable-next-line typescript/no-explicit-any -- intentional partial mock widened to exercise runner edge cases.
    attemptSession: (out: any) =>
      // eslint-disable-next-line typescript/no-unsafe-member-access -- fixture/mock boundary: values are validated by helpers before use.
      String(typeof out === "string" ? out : (out?.stdout ?? "")).includes(
        "partial"
      )
        ? "sess-late"
        : null,
  };

  const run = runDelegate(
    spec,
    { ...req, timeoutMs: 2_100_000 },
    "cli",
    h.ports
  );

  await flush();

  for (let t = 0; t < 1_920_000; t += 60_000) {
    h.clock.advance(60_000);
    h.activity();
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }

  h.finish(ok({ exit: 1, stdout: "partial" }));
  await flush();
  await flush();
  assert.equal(h.launches.length, 2);
  const resumePrompt = h.launches[1]?.argv[2] ?? "";
  assert.ok(
    resumePrompt.includes(CONTINUE_PROMPT),
    "second launch must use CONTINUE_PROMPT"
  );
  assert.ok(
    !resumePrompt.includes("Make no further tool calls"),
    "second launch must not use WRAP_UP_PROMPT"
  );
  assert.ok(
    resumePrompt.includes("(3m remaining)"),
    "continue-resume must show 3m remaining"
  );
  assert.ok(
    !resumePrompt.includes("wrap-up at"),
    "continue-resume must omit past wrap-up timestamp"
  );
  h.finish(ok({ stdout: "FINAL" }));
  const done = await run;
  assert.equal(done.outcome.status, "ok");
});

test("wrap-up stop: Codex thread event stops and resumes with wrap-up inside five minutes", async () => {
  const h = harness(posix);

  const run = runDelegate(
    codex,
    { ...req, timeoutMs: 1_800_000 },
    "cli",
    h.ports
  );

  await flush();
  h.fs.writeText(
    "/r/log",
    '{"type":"thread.started","thread_id":"thread-abc123"}\npartial'
  );

  for (let t = 0; t < 1_500_000; t += 60_000) {
    h.clock.advance(60_000);
    h.activity();
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }

  assert.ok(h.signals.length > 0, "expected wrap-up stop signal");
  h.finish(
    ok({
      exit: null,
      signal: "SIGTERM",
      stdout: '{"type":"thread.started","thread_id":"thread-abc123"}\npartial',
    })
  );
  await flush();
  await flush();
  assert.equal(h.launches.length, 2);
  assert.ok((h.launches[1]?.argv ?? []).join("\n").includes("Wrap up"));
  h.finish(
    ok({
      exit: 0,
      stdout:
        '{"type":"thread.started","thread_id":"thread-abc123"}\n{"type":"item.completed","item":{"type":"agent_message","text":"FINAL"}}',
    })
  );
  const done = await run;
  assert.equal(done.outcome.status, "ok");
});

test("wrap-up stop: a run without a nameable session runs to the deadline kill", async () => {
  const h = harness(posix);

  const run = runDelegate(
    codex,
    { ...req, timeoutMs: 1_800_000 },
    "cli",
    h.ports
  );

  await flush();
  h.fs.writeText("/r/log", "");

  for (let t = 0; t < 1_500_000; t += 60_000) {
    h.clock.advance(60_000);
    h.activity();
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }

  assert.deepEqual(h.signals, []);
  assert.ok((h.launches[0]?.argv ?? []).join("\n").includes("[DEADLINE]:"));
  h.clock.advance(300_000);
  await flush();
  assert.ok(h.signals.length > 0);
  h.finish(
    ok({ exit: null, signal: "SIGTERM", stdout: "partial", timedOut: true })
  );
  const done = await run;
  assert.equal(h.launches.length, 1);
  assert.equal(done.outcome.status === "fail" && done.outcome.cls, "timeout");
});

test("wrap-up stop: a run under ten minutes never stops early", async () => {
  const h = harness(posix);

  const run = runDelegate(
    codex,
    { ...req, timeoutMs: 9 * 60_000 },
    "cli",
    h.ports
  );

  await flush();
  h.fs.writeText(
    "/r/log",
    '{"type":"thread.started","thread_id":"thread-abc123"}'
  );

  for (let t = 0; t < 4 * 60_000; t += 60_000) {
    h.clock.advance(60_000);
    h.activity();
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }

  assert.deepEqual(h.signals, []);
  const shortPrompt = (h.launches[0]?.argv ?? []).join("\n");
  assert.ok(
    shortPrompt.includes(
      `[DEADLINE]: ${new Date(9 * 60_000).toISOString()} (9m remaining)`
    )
  );
  assert.ok(
    !shortPrompt.includes("wrap-up at"),
    "short run under floor must omit wrap-up timestamp"
  );
  h.clock.advance(5 * 60_000);
  await flush();
  h.finish(
    ok({ exit: null, signal: "SIGTERM", stdout: "partial", timedOut: true })
  );
  const done = await run;
  assert.equal(h.launches.length, 1);
  assert.equal(done.outcome.status === "fail" && done.outcome.cls, "timeout");
});

test("wrap-up stop: a fresh Antigravity launch never stops early", async () => {
  const h = harness(posix);

  const run = runDelegate(
    agy,
    { ...req, timeoutMs: 1_800_000 },
    "cli",
    h.ports
  );

  await flush();
  h.fs.writeText("/r/log", "");
  h.clock.advance(1_500_000);
  await flush();
  assert.deepEqual(h.signals, []);
  assert.ok(
    (h.launches[0]?.argv[2] ?? h.launches[0]?.argv.join(" ") ?? "").includes(
      "[DEADLINE]:"
    )
  );
  h.clock.advance(300_000);
  await flush();
  h.finish(
    ok({ exit: null, signal: "SIGTERM", stdout: "partial", timedOut: true })
  );
  const done = await run;
  assert.equal(h.launches.length, 1);
  assert.equal(done.outcome.status === "fail" && done.outcome.cls, "timeout");
});

test("wrap-up stop: a stall-resumed Antigravity run is never stopped for wrap-up", async () => {
  const h = harness(posix);
  let calls = 0;

  const spec: ProviderSpec = {
    ...agy,
    attemptSession: () => ((calls += 1) === 1 ? "conv-stall-1" : null),
    parse: (out: ProcessResult) =>
      out.stdout.includes("FINAL")
        ? { status: "ok" as const, text: "FINAL", sessionId: "c", resume: null }
        : {
            status: "fail" as const,
            cls: "empty-output" as const,
            detail: "empty",
          },
    argv: (r: { resume?: string | null; prompt: string; cwd: string }) => ({
      argv: [
        "bin",
        r.resume !== undefined && r.resume !== null && r.resume !== ""
          ? `resume:${r.resume}`
          : "fresh",
        r.prompt,
      ],
      stdin: null,
      env: {},
      cwd: r.cwd,
    }),
  };

  const run = runDelegate(
    spec,
    { ...req, timeoutMs: 1_800_000 },
    "cli",
    h.ports
  );

  await flush();
  h.finish(ok({ exit: 1, stdout: "empty one" }));
  await flush();
  await flush();
  assert.equal(h.launches.length, 2);
  h.fs.writeText("/r/log", "");
  h.clock.advance(1_500_000 - h.clock.now());
  await flush();
  assert.deepEqual(h.signals, []);
  h.clock.advance(300_000);
  await flush();
  h.finish(
    ok({ exit: null, signal: "SIGTERM", stdout: "partial", timedOut: true })
  );
  const finished = await run;
  assert.equal(h.launches.length, 2);
  assert.equal(
    finished.outcome.status === "fail" && finished.outcome.cls,
    "timeout"
  );
});

test("wrap-up stop: stall-resumed launch reuses resume id when partial log names no session", async () => {
  for (const base of [claude, codex, opencode] as const) {
    const h = harness(posix);
    let calls = 0;

    // eslint-disable-next-line typescript/no-explicit-any -- intentional partial mock widened to exercise runner edge cases.
    const spec: any = {
      ...base,
      attemptSession: () => ((calls += 1) === 1 ? "sess-stall-1" : null),
      parse: (out: ProcessResult) =>
        out.stdout.includes("FINAL")
          ? {
              status: "ok" as const,
              text: "FINAL",
              sessionId: "s",
              resume: null,
            }
          : {
              status: "fail" as const,
              cls: "empty-output" as const,
              detail: "empty",
            },
      // eslint-disable-next-line typescript/no-explicit-any -- intentional partial mock widened to exercise runner edge cases.
      argv: (r: any) => ({
        // eslint-disable-next-line typescript/strict-boolean-expressions, typescript/no-unsafe-member-access -- test predicate intentionally checks fixture value truthiness.
        argv: ["bin", r.resume ? `resume:${r.resume}` : "fresh", r.prompt],
        stdin: null,
        env: {},
        // eslint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access -- fixture/mock boundary: values are validated by helpers before use.
        cwd: r.cwd,
      }),
    };

    const run = runDelegate(
      // eslint-disable-next-line typescript/no-unsafe-argument -- fixture/mock boundary: values are validated by helpers before use.
      spec,
      { ...req, timeoutMs: 1_800_000 },
      "cli",
      h.ports
    );

    // eslint-disable-next-line no-await-in-loop
    await flush();
    h.finish(ok({ exit: 1, stdout: "empty one" }));
    // eslint-disable-next-line no-await-in-loop
    await flush();
    // eslint-disable-next-line no-await-in-loop
    await flush();
    assert.match(h.launches[1]?.argv[1] ?? "", /resume:sess-stall-1/u);
    h.fs.writeText("/r/log", "");

    for (let t = h.clock.now(); t < 1_500_000; t += 60_000) {
      h.clock.advance(60_000);
      h.activity();
      // eslint-disable-next-line no-await-in-loop
      await flush();
    }

    assert.deepEqual(h.signals, ["-50:SIGTERM"]);
    h.finish(ok({ exit: null, signal: "SIGTERM", stdout: "" }));
    // eslint-disable-next-line no-await-in-loop
    await flush();
    // eslint-disable-next-line no-await-in-loop
    await flush();
    assert.equal(h.launches.length, 3);
    assert.match(h.launches[2]?.argv[1] ?? "", /resume:sess-stall-1/u);
    assert.ok((h.launches[2]?.argv[2] ?? "").includes("Wrap up"));
    h.finish(ok({ stdout: "FINAL" }));
    // eslint-disable-next-line no-await-in-loop, unicorn/no-await-expression-member -- sequential settle await is required and asserted directly.
    assert.equal((await run).outcome.status, "ok");
  }
});

test("wrap-up budget: wrap-up happens at most once per run", async () => {
  const h = harness(posix);
  const spec = makeNudgeSpec("sess1");
  spec.attemptSession = () => "sess1";

  const run = runDelegate(
    spec,
    { ...req, timeoutMs: 1_800_000 },
    "cli",
    h.ports
  );

  await flush();

  for (let t = 0; t < 1_500_000; t += 60_000) {
    h.clock.advance(60_000);
    h.activity();
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }

  h.finish(ok({ exit: null, signal: "SIGTERM", stdout: "partial" }));
  await flush();
  await flush();
  assert.equal(h.launches.length, 2);
  assert.ok((h.launches[1]?.argv[2] ?? "").includes("Wrap up"));
  h.clock.advance(300_000);
  await flush();
  h.finish(
    ok({ exit: null, signal: "SIGTERM", stdout: "partial", timedOut: true })
  );
  const done = await run;
  assert.equal(h.launches.length, 2);
  assert.equal(done.outcome.status === "fail" && done.outcome.cls, "timeout");
});

test("wrap-up budget: wrap-up after three stall resumes records nudge and wrapUp without consuming stall budget", async () => {
  const h = harness(posix);
  const resumes: string[] = [];
  const spec = makeNudgeSpec("sess1");

  const run = runDelegate(
    spec,
    {
      ...req,
      timeoutMs: 1_800_000,
      onResume: (id: string) => {
        resumes.push(id);
      },
    },
    "cli",
    h.ports
  );

  await flush();

  for (let i = 0; i < 3; i += 1) {
    h.finish(
      ok({
        exit: null,
        signal: "SIGTERM",
        stdout: `empty ${i}`,
        timedOut: true,
        idleMs: IDLE_TIMEOUT_MS,
      })
    );
    // eslint-disable-next-line no-await-in-loop
    await flush();
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }

  assert.equal(h.launches.length, 4);
  assert.deepEqual(resumes, ["sess1", "sess1", "sess1"]);
  h.fs.writeText("/r/log", "partial");

  for (let t = h.clock.now(); t < 1_500_000; t += 60_000) {
    h.clock.advance(60_000);
    h.activity();
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }

  h.finish(ok({ exit: null, signal: "SIGTERM", stdout: "partial" }));
  await flush();
  await flush();
  assert.equal(h.launches.length, 5);
  assert.deepEqual(resumes, ["sess1", "sess1", "sess1"]);
  h.finish(ok({ stdout: "FINAL" }));
  const done = await run;
  assert.equal(done.outcome.status, "ok");
  assert.equal(done.invocations[4]?.nudge, true);
  assert.equal(done.invocations[4]?.wrapUp, true);
});

test("wrap-up fallback failures return timeout with the partial path", async () => {
  for (const reachesDeadline of [false, true]) {
    const h = harness(posix);

    const spec: ProviderSpec = {
      ...claude,
      parse: (out: ProcessResult, r: { resume?: string | null }) =>
        r.resume !== undefined && r.resume !== null && r.resume !== ""
          ? {
              status: "fail" as const,
              cls: "empty-output" as const,
              detail: "resume empty",
            }
          : {
              status: "fail" as const,
              cls: "config" as const,
              detail: "first config",
            },
      argv: (r: { resume?: string | null; prompt: string; cwd: string }) => ({
        argv: [
          "bin",
          r.resume !== undefined && r.resume !== null && r.resume !== ""
            ? `resume:${r.resume}`
            : "fresh",
          r.prompt,
        ],
        stdin: null,
        env: {},
        cwd: r.cwd,
      }),
      attemptSession: () => "sess1",
    };

    const run = runDelegate(
      spec,
      { ...req, timeoutMs: 1_800_000 },
      "cli",
      h.ports
    );

    // eslint-disable-next-line no-await-in-loop
    await flush();
    h.clock.advance(1_500_000);
    // eslint-disable-next-line no-await-in-loop
    await flush();
    h.finish(ok({ exit: 1, stdout: "first config" }));
    // eslint-disable-next-line no-await-in-loop
    await flush();
    // eslint-disable-next-line no-await-in-loop
    await flush();
    assert.equal(h.launches.length, 2, String(reachesDeadline));

    if (reachesDeadline) {
      h.clock.advance(300_000);
      // eslint-disable-next-line no-await-in-loop
      await flush();
    }

    h.finish(
      ok(
        reachesDeadline
          ? { exit: null, signal: "SIGTERM", stdout: "partial", timedOut: true }
          : { exit: 1, stdout: "resume empty" }
      )
    );
    // eslint-disable-next-line no-await-in-loop
    const done = await run;
    assert.equal(h.launches.length, 2, String(reachesDeadline));
    assert.equal(
      done.outcome.status === "fail" && done.outcome.cls,
      "timeout",
      String(reachesDeadline)
    );
    assert.match(
      done.outcome.status === "fail" ? done.outcome.detail : "",
      /partial output at/u,
      String(reachesDeadline)
    );
  }

  const argvBoom = harness(posix);

  const argvSpec: ProviderSpec = {
    ...claude,
    parse: () => ({
      status: "fail" as const,
      cls: "config" as const,
      detail: "first config",
    }),
    argv: (r: { resume?: string | null; prompt: string; cwd: string }) => {
      if (r.resume !== undefined && r.resume !== null && r.resume !== "") {
        throw new Error("argv boom");
      }

      return {
        argv: ["bin", "fresh", r.prompt],
        stdin: null,
        env: {},
        cwd: r.cwd,
      };
    },
    attemptSession: () => "sess1",
  };

  const argvRun = runDelegate(
    argvSpec,
    { ...req, timeoutMs: 1_800_000 },
    "cli",
    argvBoom.ports
  );

  await flush();
  argvBoom.clock.advance(1_500_000);
  await flush();
  argvBoom.finish(ok({ exit: 1, stdout: "first config" }));
  const argvDone = await argvRun;
  assert.equal(
    argvDone.outcome.status === "fail" && argvDone.outcome.cls,
    "timeout"
  );
  assert.match(
    argvDone.outcome.status === "fail" ? argvDone.outcome.detail : "",
    /partial output at/u
  );
});

test("wrap-up stop: Copilot with streamed output stops and resumes with wrap-up", async () => {
  const h = harness(posix);
  h.ports.nonce = () => "preset123";

  const run = runDelegate(
    copilot,
    { ...req, timeoutMs: 1_800_000 },
    "cli",
    h.ports
  );

  await flush();
  assert.ok((h.launches[0]?.argv ?? []).includes("--session-id"));
  h.fs.writeText("/r/log", "streamed partial output");

  for (let t = 0; t < 1_500_000; t += 60_000) {
    h.clock.advance(60_000);
    h.activity();
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }

  assert.deepEqual(h.signals, ["-50:SIGTERM"]);
  h.finish(
    ok({ exit: null, signal: "SIGTERM", stdout: "streamed partial output" })
  );
  await flush();
  await flush();
  assert.equal(h.launches.length, 2);
  const resumeArgv = h.launches[1]?.argv ?? [];
  assert.ok(resumeArgv.includes("--resume"));
  assert.ok(!resumeArgv.includes("--session-id"));
  const wrapPrompt = (h.launches[1]?.argv ?? []).join("\n");
  const deadlineIso = new Date(1_800_000).toISOString();
  assert.ok(
    wrapPrompt.includes("Make no further tool calls"),
    "wrap-up prompt must forbid further tool calls"
  );
  assert.ok(
    wrapPrompt.includes(`[DEADLINE]: ${deadlineIso} (5m remaining)`),
    "wrap-up launch must show 5m remaining"
  );
  assert.ok(
    !wrapPrompt.includes("wrap-up at"),
    "wrap-up launch must omit wrap-up timestamp"
  );
  h.finish(ok({ exit: 0, stdout: "FINAL answer", stderrTail: "" }));
  const finished = await run;
  assert.equal(finished.outcome.status, "ok");
});

test("wrap-up stop: Copilot without streamed output runs to the deadline kill", async () => {
  const h = harness(posix);

  const run = runDelegate(
    copilot,
    { ...req, timeoutMs: 1_800_000 },
    "cli",
    h.ports
  );

  await flush();
  h.fs.writeText("/r/log", "");

  for (let t = 0; t < 1_500_000; t += 60_000) {
    h.clock.advance(60_000);
    h.activity();
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }

  assert.deepEqual(h.signals, []);
  h.clock.advance(300_000);
  await flush();
  h.finish(ok({ exit: null, signal: "SIGTERM", stdout: "", timedOut: true }));
  const finished = await run;
  assert.equal(h.launches.length, 1);
  assert.equal(
    finished.outcome.status === "fail" && finished.outcome.cls,
    "timeout"
  );
});

test("wrap-up stop: OpenCode session event stops and resumes with wrap-up", async () => {
  const h = harness(posix);

  const run = runDelegate(
    opencode,
    { ...req, timeoutMs: 1_800_000 },
    "cli",
    h.ports
  );

  await flush();
  h.fs.writeText(
    "/r/log",
    '{"sessionID":"sess-op-123","type":"text","part":{"text":"hi"}}\n'
  );

  for (let t = 0; t < 1_500_000; t += 60_000) {
    h.clock.advance(60_000);
    h.activity();
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }

  assert.ok(h.signals.length > 0, "expected wrap-up stop signal");
  h.finish(
    ok({ exit: null, signal: "SIGTERM", stdout: '{"sessionID":"sess-op-123"}' })
  );
  await flush();
  await flush();
  assert.equal(h.launches.length, 2);
  assert.ok((h.launches[1]?.argv ?? []).join("\n").includes("Wrap up"));
  h.finish(
    ok({
      exit: 0,
      stdout:
        '{"sessionID":"sess-op-123","type":"text","part":{"text":"FINAL"}}',
    })
  );
  const finished = await run;
  assert.equal(finished.outcome.status, "ok");
});

test("wrap-up stop: failed tree kill keeps the deadline kill and returns timeout with no resume", async () => {
  const h = harness(posix);
  let calls = 0;
  const { signal } = h.ports.process;
  h.ports.process.signal = (pid: number, sig: "SIGTERM" | "SIGKILL") => {
    calls += 1;

    if (calls === 1) {
      throw new Error("kill ESRCH");
    }

    signal(pid, sig);
  };

  const run = runDelegate(
    claude,
    { ...req, timeoutMs: 1_800_000 },
    "cli",
    h.ports
  );

  await flush();
  h.clock.advance(1_500_000);
  await flush();
  assert.equal(h.launches.length, 1);
  assert.deepEqual(h.signals, []);
  h.clock.advance(300_000);
  await flush();
  assert.deepEqual(h.signals, ["-50:SIGTERM"]);
  h.finish(
    ok({ exit: null, signal: "SIGTERM", stdout: "partial", timedOut: true })
  );
  const done = await run;
  assert.equal(h.launches.length, 1);
  assert.equal(done.outcome.status === "fail" && done.outcome.cls, "timeout");
  assert.match(
    done.outcome.status === "fail" ? done.outcome.detail : "",
    /partial output at/u
  );
});

test("wrap-up stop: teardown failure returns timeout with no resume", async () => {
  const h = harness(posix);
  h.ports.process.settleGroup = async () => {
    await Promise.resolve();

    return false;
  };

  const run = runDelegate(
    opencode,
    { ...req, timeoutMs: 1_800_000 },
    "cli",
    h.ports
  );

  await flush();
  h.fs.writeText(
    "/r/log",
    '{"sessionID":"sess-op-123","type":"text","part":{"text":"hi"}}\n'
  );

  for (let t = 0; t < 1_500_000; t += 60_000) {
    h.activity();
    h.clock.advance(60_000);
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }

  assert.ok(h.signals.length > 0, "expected wrap-up stop signal");
  h.finish(
    ok({ exit: null, signal: "SIGTERM", stdout: '{"sessionID":"sess-op-123"}' })
  );
  const done = await run;
  assert.equal(done.result?.wrapUpStop, true);
  assert.equal(h.launches.length, 1);
  assert.equal(done.outcome.status === "fail" && done.outcome.cls, "timeout");
  assert.match(
    done.outcome.status === "fail" ? done.outcome.detail : "",
    /partial output at/u
  );
  assert.ok(
    done.result?.lifecycleError !== undefined &&
      done.result?.lifecycleError !== null &&
      done.result?.lifecycleError !== ""
  );
});

test("wrap-up stop: sandbox-inactive result returns sandbox-unsupported with no resume", async () => {
  const h = harness(posix);

  const run = runDelegate(
    claude,
    { ...req, timeoutMs: 1_800_000, sandbox: true },
    "cli",
    h.ports
  );

  await flush();
  h.clock.advance(1_500_000);
  await flush();
  assert.deepEqual(h.signals, ["-50:SIGTERM"]);
  h.finish(
    ok({
      exit: null,
      signal: "SIGTERM",
      stdout: "partial",
      stderrTail: "Sandbox disabled, sandbox not active",
    })
  );
  await flush();
  await flush();
  const done = await run;
  assert.equal(h.launches.length, 1);
  assert.equal(
    done.outcome.status === "fail" && done.outcome.cls,
    "sandbox-unsupported"
  );
});

test("deadline notice: effort retry draws a fresh preset id and resumes send none", async () => {
  const h = harness(posix);
  let n = 0;
  h.ports.nonce = () => `preset-${(n += 1)}`;

  // eslint-disable-next-line typescript/no-explicit-any -- intentional partial mock widened to exercise runner edge cases.
  const spec: any = {
    ...claude,
    // eslint-disable-next-line typescript/no-explicit-any -- intentional partial mock widened to exercise runner edge cases.
    parse: (out: ProcessResult, launch: any) =>
      // eslint-disable-next-line typescript/strict-boolean-expressions, typescript/no-unsafe-member-access -- test predicate intentionally checks fixture value truthiness.
      launch.effort
        ? {
            status: "fail" as const,
            cls: "config" as const,
            detail: "effort unsupported",
            retryWithoutEffort: true,
          }
        : // eslint-disable-next-line typescript/no-unsafe-argument -- fixture/mock boundary: values are validated by helpers before use.
          claude.parse(out, launch),
  };

  const run = runDelegate(
    // eslint-disable-next-line typescript/no-unsafe-argument -- fixture/mock boundary: values are validated by helpers before use.
    spec,
    { ...req, model: "m", effort: "high" },
    "cli",
    h.ports
  );

  await flush();
  h.finish(ok({ durationMs: 7 }));
  await flush();
  await flush();
  h.finish(
    ok({
      stdout: JSON.stringify({
        type: "result",
        result: "R",
        session_id: "sess-1",
      }),
    })
  );
  await run;
  const first = (h.launches[0]?.argv ?? []).join(" ");
  const second = (h.launches[1]?.argv ?? []).join(" ");
  assert.match(first, /--session-id preset-1/u);
  assert.match(second, /--session-id preset-2/u);
  assert.ok(!first.includes("--resume"));
  assert.ok(!second.includes("--resume"));
});
