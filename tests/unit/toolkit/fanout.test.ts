import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { resolveRoster } from "../../../skills/dispatch/scripts/policy/roster.ts";
import type { DiagnosticEvent } from "../../../skills/dispatch/scripts/toolkit/domain/diagnostics.ts";
import type { RosterSlot } from "../../../skills/dispatch/scripts/toolkit/domain/types.ts";
import {
  cliWaveState,
  fanOut,
  fanOutComplete,
  parsePinsFlag,
  resolveSlots,
  underfillNote,
} from "../../../skills/dispatch/scripts/toolkit/fanout.ts";
import type {
  SlotOutcome,
  Validation,
} from "../../../skills/dispatch/scripts/toolkit/fanout.ts";
import type { FanOutInput } from "../../../skills/dispatch/scripts/toolkit/fanout/state.ts";
import { ToolError } from "../../../skills/dispatch/scripts/toolkit/output.ts";
import { defined } from "../../helpers/guards.ts";
import { flag, narrow, withFields } from "./helpers/json.ts";
import { sessionFixture } from "./helpers/session.ts";

const slot = (
  provider: string,
  model: string | string[] = "good",
  reserve = false,
  native = false
) => ({
  slot: `${provider}[0]`,
  provider,
  index: 0,
  model,
  reserve,
  native,
});

const validate = (text: string) =>
  text.trim()
    ? { ok: true as const, text: text.trim() }
    : { ok: false as const, cls: "empty-output" as const, reason: "empty" };

const quota = {
  schemaVersion: 1 as const,
  policyVersion: 1 as const,
  decidedAt: 0,
  decisions: [],
};

const gate = () => {
  let resolve!: () => void;

  // oxlint-disable-next-line promise/avoid-new, promise/param-names -- deferred handle needs an externally-resolved promise; release assigns the outer resolver
  const promise = new Promise<void>((release) => {
    resolve = release;
  });

  return { promise, resolve };
};

const nativeOf = (outcome: SlotOutcome | undefined) => {
  assert.equal(outcome?.state, "native");

  return outcome;
};

const hasBlockedReason = (outcome: unknown, reasonHash: string) =>
  typeof outcome === "object" &&
  outcome !== null &&
  "blocked" in outcome &&
  Array.isArray(outcome.blocked) &&
  outcome.blocked.some(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      "reasonHash" in entry &&
      entry.reasonHash === reasonHash
  );

test("Copilot native effort follows physical launches and saved replay", async () => {
  for (const nativeOnly of [true, false]) {
    const f = sessionFixture({ memory: true });

    try {
      f.deps.orchestrator = { platform: "copilot", model: null };
      const events: DiagnosticEvent[] = [];
      f.deps.diagnostics = (event) => {
        events.push(event);
      };

      const target = {
        ...slot("copilot", "physical-model", false, nativeOnly),
        effort: "max",
      };

      const dir = path.join(f.session, "native-effort");

      const input = {
        dir,
        slots: [target],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: nativeOnly ? [] : ["copilot"],
      };

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const first = await fanOutComplete(input, f.deps);
      const pending = first.find((r) => r.state === "native");
      assert.ok(pending?.state === "native");
      fs.writeFileSync(pending.replyPath, "answer");
      events.length = 0;
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await fanOutComplete(
        {
          ...input,
          slots: [{ ...target, model: "changed-model", effort: "low" }],
        },
        f.deps
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await fanOutComplete(
        {
          ...input,
          slots: [{ ...target, model: "changed-model", effort: "low" }],
        },
        f.deps
      );

      const completed = events.find(
        (e) => e.kind === "native" && e.state === "completed"
      );

      assert.equal(completed?.model, "physical-model");
      assert.equal(completed?.effort, "max");
    } finally {
      f.cleanup();
    }
  }

  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "copilot", model: null };
    f.script("claude", "logical-model", {
      status: "fail",
      cls: "auth",
      detail: "unavailable",
    });
    const events: DiagnosticEvent[] = [];
    f.deps.diagnostics = (e) => {
      events.push(e);
    };

    const target = { ...slot("claude", "logical-model"), effort: "low" };

    const reserve = {
      ...slot("copilot", "reserve-model", true),
      effort: "xhigh",
    };

    const input = {
      dir: path.join(f.session, "reserve-effort"),
      slots: [target, reserve],
      prompt: "question",
      validate,
      quota,
      sessionRoot: f.session,
      nativeFirstProviders: ["copilot"],
    };

    const first = await fanOutComplete(input, f.deps);
    const native = first.find((r) => r.state === "native");
    assert.ok(native?.state === "native");
    fs.writeFileSync(native.replyPath, "answer");
    events.length = 0;
    await fanOutComplete(
      {
        ...input,
        slots: [target, { ...reserve, model: "changed", effort: "low" }],
      },
      f.deps
    );
    await fanOutComplete(
      {
        ...input,
        slots: [target, { ...reserve, model: "changed", effort: "low" }],
      },
      f.deps
    );

    const completed = events.find(
      (e) => e.kind === "native" && e.state === "completed"
    );

    assert.equal(completed?.slot, target.slot);
    assert.equal(completed?.model, "reserve-model");
    assert.equal(completed?.effort, "xhigh");
  } finally {
    f.cleanup();
  }
});

test("rejected MUST validation retains logical source across direct reserve native and replay", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const seen: string[] = [];

    const check = (text: string, source: string) => {
      seen.push(source);

      return validate(text);
    };

    f.script("claude", "good", "direct");
    f.script("opencode", "good", {
      status: "fail",
      cls: "auth",
      detail: "unavailable",
    });
    f.script("copilot", "good", "reserve");

    const dir = path.join(f.session, "confirmation");

    const slots = [
      slot("claude"),
      slot("opencode"),
      slot("copilot", "good", true),
      slot("codex", "good", false, true),
    ];

    const first = await fanOut(
      { dir, slots, prompt: "confirm", validate: check, quota },
      f.deps
    );

    assert.deepEqual(seen, ["claude[0]", "opencode[0]"]);
    const reserved = first.find((reply) => reply.slot === "opencode[0]");
    assert.ok(reserved?.state === "done");
    assert.equal(reserved.responder?.slot, "copilot[0]");
    const native = first.find((reply) => reply.state === "native");
    assert.ok(native?.state === "native");
    fs.writeFileSync(native.replyPath, "native");
    seen.length = 0;
    await fanOut(
      { dir, slots, prompt: "confirm", validate: check, quota },
      f.deps
    );
    assert.ok(seen.includes("codex[0]"));
    assert.ok(seen.includes("opencode[0]"));
    assert.ok(!seen.includes("copilot[0]"));
  } finally {
    f.cleanup();
  }
});

test("diagnostics retain terminal routing and unlaunched failure classes", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const events: DiagnosticEvent[] = [];
    f.deps.diagnostics = (e) => {
      events.push(e);
    };

    f.deps.modes = () => [];

    const result = await fanOut(
      {
        dir: path.join(f.session, "unlaunched"),
        slots: [slot("claude")],
        prompt: "question",
        validate,
        quota,
      },
      f.deps
    );

    assert.equal(result[0]?.state, "failed");
    assert.equal(f.launches.length, 0);
    assert.ok(
      events.some(
        (e: DiagnosticEvent) =>
          e.kind === "routing" && e.state === "stop" && e.cls === "not-found"
      )
    );
    assert.ok(
      events.some(
        (e: DiagnosticEvent) =>
          e.kind === "slot" && e.state === "failed" && e.cls === "not-found"
      )
    );
    events.length = 0;
    f.deps.modes = () => ["cli"];
    f.script("claude", "good", {
      status: "fail",
      cls: "auth",
      detail: "private",
    });
    await fanOut(
      {
        dir: path.join(f.session, "terminal"),
        slots: [slot("claude")],
        prompt: "question",
        validate,
        quota,
      },
      f.deps
    );
    assert.equal(
      events.filter(
        (e: DiagnosticEvent) =>
          e.kind === "routing" && e.state === "stop" && e.cls === "auth"
      ).length,
      2,
      "voice and wave exhaustion use the same terminal contract"
    );
  } finally {
    f.cleanup();
  }
});

test("fan-out launches concurrent slots in roster order and persists before hooks", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const dir = path.join(f.session, ".state", "fanout");
    const waiting: (() => void)[] = [];
    f.deps.delegate = async (_provider, request) => {
      assert.equal(fs.readFileSync(request.promptPath, "utf-8"), "question");
      // oxlint-disable-next-line promise/avoid-new -- barrier coordinates three concurrent delegates; no async rewrite preserves the rendezvous
      await new Promise<void>((resolve) => {
        waiting.push(resolve);

        if (waiting.length === 3) {
          for (const done of waiting) {
            done();
          }
        }
      });

      return {
        outcome: {
          status: "ok",
          text: "answer",
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    let hooks = 0;
    f.deps.hook = () => {
      hooks += 1;

      if (hooks === 1) {
        throw new Error("crash");
      }
    };

    await assert.rejects(
      fanOut(
        {
          dir,
          slots: [slot("claude"), slot("agy"), slot("codex")],
          prompt: "question",
          validate,
          quota,
        },
        f.deps
      ),
      /crash/u
    );
    assert.equal(hooks, 3);
    assert.equal(fs.readdirSync(path.join(dir, "slots")).length, 3);
    f.deps.delegate = () => {
      throw new Error("must reuse");
    };

    delete f.deps.hook;

    const fanOutResult = await fanOut(
      {
        dir,
        slots: [slot("claude"), slot("agy"), slot("codex")],
        prompt: "question",
        validate,
        quota,
      },
      f.deps
    );

    assert.deepEqual(
      fanOutResult.map((x) => x.state),
      ["done", "done", "done"]
    );
  } finally {
    f.cleanup();
  }
});

test("fan-out cascades validation models modes quota and one reserve", async () => {
  const f = sessionFixture();

  try {
    f.script("claude", "bad", {
      status: "fail",
      cls: "model-not-found",
      detail: "missing",
    });
    f.script("claude", "good", "accepted");
    f.script("agy", "bad", { status: "fail", cls: "quota", detail: "quota" });
    f.script("agy", "good", "");
    f.script("copilot", "good", "reserve answer");
    f.script("opencode", "good", {
      status: "fail",
      cls: "auth",
      detail: "auth",
    });

    const slots = [
      slot("claude", ["bad", "good"]),
      slot("agy", ["bad", "good"]),
      slot("opencode"),
      slot("copilot", "good", true),
    ];

    const outcomes = await fanOut(
      {
        dir: path.join(f.session, "fanout"),
        slots,
        prompt: "question",
        validate,
      },
      f.deps
    );

    assert.deepEqual(
      outcomes.map((x) => x.state),
      ["done", "failed", "done"]
    );
    assert.deepEqual(
      f.launches.map((x) => `${x.provider}:${x.request.model}`),
      [
        "claude:bad",
        "agy:bad",
        "opencode:good",
        "claude:good",
        "agy:good",
        "copilot:good",
      ]
    );
    const outcome = defined(outcomes[2]);

    assert.equal(outcome.state === "done" && outcome.text, "reserve answer");
    const quotaDir = path.join(f.session, ".state", "quota");

    // Empty-output breaker directories hold streak records, not cooldown observations.
    const observations = fs
      .readdirSync(quotaDir)
      .filter((name) => !name.startsWith("empty-output-"))
      .flatMap((name) =>
        fs
          .readdirSync(path.join(quotaDir, name))
          .filter((file) => file !== "generation.json")
      );

    assert.equal(observations.length, 1);
    f.deps.modes = () => ["cli", "desktop"];
    // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
    f.deps.delegate = async (_provider, _request, mode) => ({
      outcome:
        mode === "cli"
          ? { status: "fail", cls: "quota", detail: "quota" }
          : { status: "ok", text: "desktop", resume: null, sessionId: null },
      invocations: [],
    });

    const modes = await fanOut(
      {
        dir: path.join(f.session, "modes"),
        slots: [slot("agy")],
        prompt: "question",
        validate,
        quota,
      },
      f.deps
    );

    const modeOutcome = defined(modes[0]);

    assert.equal(modeOutcome.state === "done" && modeOutcome.text, "desktop");
  } finally {
    f.cleanup();
  }
});

test("fan-out reruns failed slots and only missing crash outcomes", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const dir = path.join(f.session, "fanout");
    const slots = [slot("claude"), slot("agy"), slot("codex")];

    f.script("claude", "good", "one");
    f.script("agy", "good", "two");
    f.script("codex", "good", {
      status: "fail",
      cls: "auth",
      detail: "failed",
    });
    await fanOut({ dir, slots, prompt: "question", validate, quota }, f.deps);
    f.launches.length = 0;
    f.script("codex", "good", "three");

    const fanOutResult2 = await fanOut(
      { dir, slots, prompt: "question", validate, quota },
      f.deps
    );

    assert.deepEqual(
      fanOutResult2.map((x) => x.state),
      ["done", "done", "done"]
    );
    assert.deepEqual(
      f.launches.map((x) => x.provider),
      ["codex"]
    );
    fs.unlinkSync(path.join(dir, "slots", "codex[0].json"));
    f.launches.length = 0;
    await fanOut({ dir, slots, prompt: "question", validate, quota }, f.deps);
    assert.deepEqual(
      f.launches.map((x) => x.provider),
      ["codex"]
    );
  } finally {
    f.cleanup();
  }
});

test("fan-out native-only roster remains available on its host", () => {
  const f = sessionFixture({ memory: true });

  try {
    const skillRoot = path.join(f.root, "skill");
    fs.mkdirSync(skillRoot);
    fs.writeFileSync(
      path.join(skillRoot, "config.jsonc"),
      JSON.stringify({
        "read-delegates": {
          codex: { nativeSubagentsOnly: true, targets: [{ medium: {} }] },
        },
        phases: {
          "plan-review": { targets: { medium: 1 }, rounds: { medium: 2 } },
        },
      })
    );
    f.deps.skillRoot = skillRoot;
    f.deps.orchestrator = { platform: "codex", model: null };
    f.deps.liveness = { codex: false };
    const roster = resolveSlots("plan", "medium", f.deps);
    assert.equal(roster.rounds, 2);
    assert.equal(roster.targets.length, 1);
    assert.equal(defined(roster.targets[0]).native, true);
  } finally {
    f.cleanup();
  }
});

test("resolveSlots applies pins and maps invalid pin errors to invalid-input", () => {
  const f = sessionFixture({ memory: true });

  try {
    const skillRoot = path.join(f.root, "skill");
    fs.mkdirSync(skillRoot);
    fs.writeFileSync(
      path.join(skillRoot, "config.jsonc"),
      JSON.stringify({
        "read-delegates": {
          claude: { targets: [{ medium: { model: "c" } }] },
          codex: { targets: [{ medium: { model: "x" } }] },
          agy: { targets: [{ medium: { model: "a" } }] },
        },
        phases: {
          "plan-review": { targets: { medium: 1 }, rounds: { medium: 2 } },
        },
      })
    );
    f.deps.skillRoot = skillRoot;
    f.deps.orchestrator = { platform: "opencode", model: null };
    f.deps.liveness = { claude: true, codex: true, agy: true };
    assert.equal(parsePinsFlag(undefined), null);
    assert.equal(
      resolveSlots("plan", "medium", f.deps, parsePinsFlag("(all)")).targets
        .length,
      3
    );
    assert.equal(
      resolveSlots("plan", "medium", f.deps, parsePinsFlag("(2)")).targets
        .length,
      2
    );
    assert.deepEqual(
      resolveSlots(
        "plan",
        "medium",
        f.deps,
        parsePinsFlag("(codex,agy)")
      ).targets.map((s) => s.provider),
      ["codex", "agy"]
    );
    assert.throws(
      () => parsePinsFlag("(all,codex)"),
      (e: unknown) =>
        e instanceof ToolError && e.exit === 1 && e.reason === "invalid-input"
    );
    assert.throws(
      () => resolveSlots("plan", "medium", f.deps, parsePinsFlag("(unknown)")),
      (e: unknown) =>
        e instanceof ToolError && e.exit === 1 && e.reason === "invalid-input"
    );
  } finally {
    f.cleanup();
  }
});

test("voice deadline: targets share the wave budget across validation retries", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const budgets: number[] = [];
    let now = 0;
    f.deps.clock = () => now;
    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.delegate = (_provider, request) => {
      budgets.push(request.timeoutMs);
      now += 100;

      return Promise.resolve({
        outcome: {
          status: "ok",
          text: request.model === "bad" ? "" : "accepted",
          resume: null,
          sessionId: null,
        },
        invocations: [],
      });
    };

    const outcomes = await fanOut(
      {
        dir: path.join(f.session, "validate"),
        slots: [slot("claude", ["bad", "good"])],
        prompt: "question",
        validate,
        quota,
      },
      f.deps
    );

    assert.deepEqual(outcomes, [
      {
        slot: "claude[0]",
        state: "done",
        text: "accepted",
        responder: {
          slot: "claude[0]",
          provider: "claude",
          model: "good",
          native: false,
        },
      },
    ]);
    assert.deepEqual(budgets, [1_800_000, 1_799_900]);
  } finally {
    f.cleanup();
  }
});

test("no-report resume retries the session report, defers other verdicts, resets per model and honors the voice deadline", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const dir = path.join(f.session, "no-report");
    const reason = "uncovered-scope: no JSON report object found";

    const check = (text: string): Validation =>
      text === "FINAL"
        ? { ok: true, text }
        : { ok: false, cls: "no-report", reason };

    const texts = ["Draft one", "Draft two", "FINAL"];
    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.delegate = (provider, request, mode) => {
      f.launches.push({ provider, request, mode });
      const index = f.launches.length - 1;
      fs.appendFileSync(request.logPath, `launch ${index + 1}\n`);

      return Promise.resolve({
        outcome: {
          status: "ok",
          text: defined(texts[index]),
          resume: null,
          sessionId: index === 0 ? "session-one" : null,
        },
        // A report resume launch is itself a nudge; only later stall resumes count against the runner limit.
        invocations: [
          {
            provider,
            model: request.model,
            mode,
            effort: null,
            launched: true,
            outcome: "ok",
            ...(!(index === 0) && { nudge: true as const }),
          },
          ...(index < 2
            ? [
                {
                  provider,
                  model: request.model,
                  mode,
                  effort: null,
                  launched: true,
                  outcome: "timeout",
                  nudge: true as const,
                },
              ]
            : []),
        ],
      });
    };

    const outcomes = await fanOut(
      {
        dir,
        slots: [slot("claude")],
        prompt: "question",
        validate: check,
        quota,
      },
      f.deps
    );

    assert.equal(outcomes[0]?.state, "done");
    assert.equal(f.launches.length, 3);
    assert.deepEqual(
      f.launches.map((launch) => launch.request.resumesUsed),
      [0, 1, 2]
    );
    assert.deepEqual(
      f.launches.map((launch) => launch.request.resume),
      [null, "session-one", "session-one"],
      "a resume without a new session id keeps the last valid one"
    );
    assert.notEqual(
      defined(f.launches[1]).request.promptPath,
      defined(f.launches[0]).request.promptPath
    );
    assert.equal(
      defined(f.launches[1]).request.promptPath,
      defined(f.launches[2]).request.promptPath
    );

    const prompt = fs.readFileSync(
      defined(f.launches[1]).request.promptPath,
      "utf-8"
    );

    assert.match(prompt, /uncovered-scope: no JSON report object found/u);
    assert.match(prompt, /final JSON report/iu);
    assert.match(prompt, /confirmations/iu);
    assert.match(prompt, /requestId/u);
    assert.match(prompt, /decision/u);
    assert.match(prompt, /rationale/u);

    for (const key of ["agent", "sandbox", "cwd", "model", "effort"] as const) {
      assert.deepEqual(
        defined(f.launches[1]).request[key],
        defined(f.launches[0]).request[key],
        key
      );
    }

    assert.equal(
      fs.readFileSync(
        path.join(dir, "logs", "claude[0].log.no-report"),
        "utf-8"
      ),
      "launch 1\nlaunch 2\n",
      "the slot log is copied before the resumed launch"
    );
    assert.ok(
      fs.existsSync(path.join(dir, "logs", "claude[0].log")),
      "the slot log path stays in place"
    );
    const resumeBase = f.launches.length;
    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.delegate = (provider, request, mode) => {
      f.launches.push({ provider, request, mode });

      return Promise.resolve({
        outcome: {
          status: "ok",
          text: "still prose",
          resume: null,
          sessionId: "session-one",
        },
        invocations: [],
      });
    };

    const exhausted = await fanOut(
      {
        dir: path.join(f.session, "limit"),
        slots: [slot("claude")],
        prompt: "question",
        validate: check,
        quota,
      },
      f.deps
    );

    assert.equal(exhausted[0]?.state, "failed");
    assert.equal(
      exhausted[0]?.state === "failed" && exhausted[0].cls,
      "no-report"
    );
    assert.deepEqual(
      f.launches.slice(resumeBase).map((launch) => launch.request.resume),
      [null, "session-one", "session-one", "session-one"]
    );
  } finally {
    f.cleanup();
  }

  // refusal and blocked answers stay with the cascade instead of a report resume
  for (const item of [
    {
      cls: "refusal" as const,
      reason: "refusal: I cannot review this plan.",
    },
    { cls: "blocked" as const, reason: "blocked: artifact denied" },
  ]) {
    // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
    const f = sessionFixture({ memory: true });

    try {
      f.deps.delegate = async (provider, request, mode) => {
        await Promise.resolve();
        f.launches.push({ provider, request, mode });

        return {
          outcome: {
            status: "ok",
            text: "answer",
            resume: null,
            sessionId: "session-one",
          },
          invocations: [],
        };
      };

      const check = (): Validation => ({
        ok: false,
        cls: item.cls,
        reason: item.reason,
      });

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const outcomes = await fanOut(
        {
          dir: path.join(f.session, "cascade"),
          slots: [slot("claude")],
          prompt: "question",
          validate: check,
          quota,
        },
        f.deps
      );

      assert.equal(outcomes[0]?.state, "failed");
      assert.equal(
        outcomes[0]?.state === "failed" && outcomes[0].cls,
        item.cls
      );
      assert.equal(f.launches.length, 1);
    } finally {
      f.cleanup();
    }
  }

  // the resume limit resets for the next model
  {
    // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
    const f = sessionFixture({ memory: true });

    try {
      let now = 0;
      f.deps.clock = () => now;
      const reason = "uncovered-scope: no JSON report object found";

      const check = (text: string): Validation =>
        text === "FINAL"
          ? { ok: true, text }
          : { ok: false, cls: "no-report", reason };

      // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
      f.deps.delegate = (provider, request, mode) => {
        f.launches.push({ provider, request, mode });
        now += 100;

        const invocations = [
          {
            provider,
            model: request.model,
            mode,
            effort: null,
            launched: true,
            outcome: "ok",
            ...((request.resume ?? "") !== "" && { nudge: true as const }),
          },
          {
            provider,
            model: request.model,
            mode,
            effort: null,
            launched: true,
            outcome: "timeout",
            nudge: true as const,
          },
        ];

        return Promise.resolve(
          request.model === "second"
            ? {
                outcome: {
                  status: "ok",
                  text: "FINAL",
                  resume: null,
                  sessionId: null,
                },
                invocations,
              }
            : {
                outcome: {
                  status: "ok",
                  text: "draft",
                  resume: null,
                  sessionId: "first-session",
                },
                invocations,
              }
        );
      };

      const outcomes = await fanOut(
        {
          dir: path.join(f.session, "models"),
          slots: [slot("claude", ["first", "second"])],
          prompt: "question",
          validate: check,
          quota,
        },
        f.deps
      );

      assert.equal(outcomes[0]?.state, "done");
      assert.deepEqual(
        f.launches.map((launch) => launch.request.model),
        ["first", "first", "first", "first", "second"]
      );
      assert.deepEqual(
        f.launches.map((launch) => launch.request.resume),
        [null, "first-session", "first-session", "first-session", null]
      );
      assert.deepEqual(
        f.launches.map((launch) => launch.request.resumesUsed),
        [0, 1, 2, 3, 0]
      );
    } finally {
      f.cleanup();
    }
  }

  // no launch starts after the voice deadline
  {
    // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
    const f = sessionFixture({ memory: true });

    try {
      let now = 0;
      f.deps.clock = () => now;
      const reason = "uncovered-scope: no JSON report object found";
      const check = (): Validation => ({ ok: false, cls: "no-report", reason });
      f.deps.delegate = async (provider, request, mode) => {
        await Promise.resolve();
        f.launches.push({ provider, request, mode });
        now = 30 * 60 * 1000;

        return {
          outcome: {
            status: "ok",
            text: "draft",
            resume: null,
            sessionId: "session-one",
          },
          invocations: [],
        };
      };

      const outcomes = await fanOut(
        {
          dir: path.join(f.session, "deadline"),
          slots: [slot("claude", ["first", "second"])],
          prompt: "question",
          validate: check,
          quota,
        },
        f.deps
      );

      assert.equal(f.launches.length, 1);
      assert.equal(outcomes[0]?.state, "failed");
      assert.equal(
        outcomes[0]?.state === "failed" && outcomes[0].cls,
        "timeout"
      );
    } finally {
      f.cleanup();
    }
  }
});

test("reserve deadline gives a CLI reserve its own 30 minutes after the wave deadline", async () => {
  const f = sessionFixture({ memory: true });

  try {
    let now = 0;
    f.deps.clock = () => now;
    const budgets: number[] = [];
    f.deps.delegate = async (provider, request, mode) => {
      await Promise.resolve();
      f.launches.push({ provider, request, mode });
      budgets.push(request.timeoutMs);

      if (provider === "claude") {
        now += 31 * 60 * 1000;

        return {
          outcome: { status: "fail", cls: "auth", detail: "unavailable" },
          invocations: [],
        };
      }

      return {
        outcome: {
          status: "ok",
          text: "reserve answer",
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    const outcomes = await fanOut(
      {
        dir: path.join(f.session, "reserve"),
        slots: [slot("claude"), slot("copilot", "good", true)],
        prompt: "question",
        validate,
        quota,
      },
      f.deps
    );

    const served = outcomes.find((outcome) => outcome.slot === "claude[0]");
    assert.equal(served?.state, "done");
    assert.deepEqual(
      f.launches.map((launch) => launch.provider),
      ["claude", "copilot"]
    );
    assert.deepEqual(
      budgets,
      [1_800_000, 1_800_000],
      "the reserve starts after the wave deadline with a fresh 30-minute budget"
    );

    f.launches.length = 0;
    f.deps.delegate = async (provider, request, mode) => {
      await Promise.resolve();
      f.launches.push({ provider, request, mode });
      budgets.push(request.timeoutMs);

      if (request.model === "slow") {
        now += 60 * 1000;

        return {
          outcome: { status: "fail", cls: "auth", detail: "unavailable" },
          invocations: [],
        };
      }

      return {
        outcome: {
          status: "ok",
          text: "answer",
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    budgets.length = 0;

    const targeted = await fanOut(
      {
        dir: path.join(f.session, "targets"),
        slots: [slot("claude", ["slow", "good"])],
        prompt: "question",
        validate,
        quota,
      },
      f.deps
    );

    assert.equal(targeted[0]?.state, "done");
    assert.deepEqual(
      budgets,
      [1_800_000, 1_740_000],
      "targets keep the shared wave deadline"
    );
  } finally {
    f.cleanup();
  }
});

test("voice deadline: a reserve started at minute 20 gets a fresh budget", async () => {
  const f = sessionFixture({ memory: true });

  try {
    let now = 0;
    f.deps.clock = () => now;
    f.deps.delegate = async (provider, request, mode) => {
      await Promise.resolve();
      f.launches.push({ provider, request, mode });

      if (provider === "claude") {
        now = 20 * 60 * 1000;

        return {
          outcome: { status: "fail", cls: "auth", detail: "unavailable" },
          invocations: [],
        };
      }

      return {
        outcome: {
          status: "ok",
          text: "reserve answer",
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    await fanOut(
      {
        dir: path.join(f.session, "reserve"),
        slots: [slot("claude"), slot("copilot", "good", true)],
        prompt: "question",
        validate,
        quota,
      },
      f.deps
    );
    const reserve = f.launches.find((launch) => launch.provider === "copilot");
    assert.equal(reserve?.request.timeoutMs, 1_800_000);
  } finally {
    f.cleanup();
  }
});

test("terminal failures take no reserve and publish no cooldown", async () => {
  const f = sessionFixture();

  try {
    f.script("claude", "good", {
      status: "fail",
      cls: "config",
      detail: "bad config",
    });
    f.script("copilot", "good", "reserve answer");

    const terminal = await fanOut(
      {
        dir: path.join(f.session, "terminal"),
        slots: [slot("claude"), slot("copilot", "good", true)],
        prompt: "question",
        validate,
        quota,
        nativeFirstProviders: [],
      },
      f.deps
    );

    assert.equal(
      terminal.find((outcome) => outcome.slot === "claude[0]")?.state,
      "failed"
    );
    assert.deepEqual(
      f.launches.map((launch) => launch.provider),
      ["claude"],
      "a terminal config failure never spends the reserve"
    );
    f.launches.length = 0;
    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.delegate = (provider, request, mode) => {
      f.launches.push({ provider, request, mode });

      return Promise.resolve({
        outcome: {
          status: "fail",
          cls: "capacity",
          detail: "at capacity",
          retryAfterMs: 30_000,
        },
        invocations: [],
      });
    };

    const outcomes = await fanOut(
      {
        dir: path.join(f.session, "capacity"),
        slots: [slot("claude")],
        prompt: "question",
        validate,
      },
      f.deps
    );

    assert.equal(outcomes[0]?.state, "failed");
    assert.equal(
      outcomes[0]?.state === "failed" && outcomes[0].cls,
      "capacity"
    );
    const quotaDir = path.join(f.session, ".state", "quota");
    assert.ok(
      fs.existsSync(quotaDir),
      "the quota store is consulted before the failure"
    );

    // Empty-output breaker directories hold streak records, not cooldown observations.
    const observations = fs
      .readdirSync(quotaDir)
      .filter((name) => !name.startsWith("empty-output-"))
      .flatMap((name) =>
        fs
          .readdirSync(path.join(quotaDir, name))
          .filter((file) => file !== "generation.json")
      );

    assert.deepEqual(observations, []);
  } finally {
    f.cleanup();
  }
});

test("diagnostics observe validation routing and native replay without changing slots", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const events: DiagnosticEvent[] = [];
    f.deps.diagnostics = (e) => {
      events.push(e);
    };

    const dir = path.join(f.session, "observed");
    const slots = [slot("claude", "good", false, true)];

    const pending = await fanOut(
      { dir, slots, prompt: "question", validate, quota },
      f.deps
    );

    assert.equal(pending[0]?.state, "native");
    assert.ok(events.some((e) => e.kind === "native" && e.state === "pending"));
    fs.writeFileSync(path.join(dir, "replies", "claude[0].md"), " ");
    await fanOut({ dir, slots, prompt: "question", validate, quota }, f.deps);
    assert.ok(events.some((e) => e.kind === "native" && e.state === "invalid"));
    fs.writeFileSync(path.join(dir, "replies", "claude[0].md"), "answer");

    const done = await fanOut(
      { dir, slots, prompt: "question", validate, quota },
      f.deps
    );

    assert.equal(done[0]?.state, "done");
    assert.ok(
      events.some((e) => e.kind === "native" && e.state === "completed")
    );
    f.script("claude", "good", "");
    await fanOut(
      {
        dir: path.join(f.session, "invalid-output"),
        slots: [slot("claude")],
        prompt: "question",
        validate,
        quota,
      },
      f.deps
    );
    assert.ok(
      events.some(
        (e) => e.kind === "validation" && e.outcome === "empty-output"
      )
    );
    f.script("opencode", "good", {
      status: "fail",
      cls: "auth",
      detail: "private",
    });
    f.script("copilot", "good", "reserve answer");

    const reserved = await fanOut(
      {
        dir: path.join(f.session, "reserve"),
        slots: [slot("opencode"), slot("copilot", "good", true)],
        prompt: "question",
        validate,
        quota,
      },
      f.deps
    );

    assert.equal(reserved[0]?.state, "done");
    assert.ok(
      events.some((e) => e.kind === "slot" && e.targetSlot === "opencode[0]")
    );
    f.deps.orchestrator = { platform: "agy", model: null };
    f.script("claude", "good", {
      status: "fail",
      cls: "auth",
      detail: "private",
    });

    const fallback = await fanOut(
      {
        dir: path.join(f.session, "fallback"),
        slots: [slot("claude")],
        prompt: "question",
        validate,
        quota,
      },
      f.deps
    );

    assert.equal(fallback[0]?.state, "failed");
    assert.ok(events.some((e) => e.kind === "routing" && e.state === "stop"));
    f.deps.diagnostics = () => {
      throw new Error("observer");
    };

    assert.deepEqual(
      await fanOut({ dir, slots, prompt: "question", validate, quota }, f.deps),
      done
    );
  } finally {
    f.cleanup();
  }
});

test("fan-out forwards session root and read commands to delegate request", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.artifact(
      "config.local.jsonc",
      JSON.stringify({
        "read-delegates": { claude: { targets: [{ low: { model: "good" } }] } },
        "read-commands": ["codegraph explore"],
      })
    );
    f.deps.skillRoot = f.root;
    f.script("claude", "good", "answer");
    await fanOut(
      {
        dir: path.join(f.session, "commands"),
        slots: [slot("claude")],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
      },
      f.deps
    );
    assert.deepEqual(f.launches[0]?.request.readCommands, [
      "codegraph explore",
    ]);
    assert.equal(f.launches[0]?.request.sessionRoot, f.session);
  } finally {
    f.cleanup();
  }
});

test("blocked attempt metadata is preserved across alias, reserve, and retry fallbacks", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const check = (text: string): Validation =>
      text === "BLOCKED"
        ? {
            ok: false,
            cls: "blocked",
            reason: "blocked: Artifact denied",
            blocked: { reason: "Artifact denied", reasonHash: "hash-1" },
          }
        : validate(text);

    // Alias fallback
    f.script("claude", "bad", "BLOCKED");
    f.script("claude", "good", "answer");

    const aliasOutcomes = await fanOut(
      {
        dir: path.join(f.session, "alias"),
        slots: [slot("claude", ["bad", "good"])],
        prompt: "question",
        validate: check,
        quota,
      },
      f.deps
    );

    assert.equal(aliasOutcomes[0]?.state, "done");
    assert.deepEqual(aliasOutcomes[0]?.blocked, [
      {
        provider: "claude",
        model: "bad",
        reason: "Artifact denied",
        reasonHash: "hash-1",
      },
    ]);

    // Reserve fallback
    f.script("claude", "good", "BLOCKED");
    f.script("copilot", "good", "reserve answer");

    const reserveOutcomes = await fanOut(
      {
        dir: path.join(f.session, "reserve"),
        slots: [slot("claude"), slot("copilot", "good", true)],
        prompt: "question",
        validate: check,
        quota,
      },
      f.deps
    );

    const served = reserveOutcomes.find(
      (outcome) => outcome.slot === "claude[0]"
    );

    assert.equal(served?.state, "done");
    assert.equal(served.state === "done" && served.text, "reserve answer");
    assert.deepEqual(served?.blocked, [
      {
        provider: "claude",
        model: "good",
        reason: "Artifact denied",
        reasonHash: "hash-1",
      },
    ]);

    // Failed slot retry
    f.deps.orchestrator = null;
    f.script("claude", "good", "BLOCKED");

    const retryDir = path.join(f.session, "retry");
    const retrySlots = [slot("claude")];

    const failed = await fanOut(
      {
        dir: retryDir,
        slots: retrySlots,
        prompt: "question",
        validate: check,
        quota,
      },
      f.deps
    );

    assert.equal(failed[0]?.state, "failed");
    assert.equal(failed[0]?.state === "failed" && failed[0].cls, "blocked");
    f.script("claude", "good", "answer");

    const retryDone = await fanOut(
      {
        dir: retryDir,
        slots: retrySlots,
        prompt: "question",
        validate: check,
        quota,
      },
      f.deps
    );

    assert.equal(retryDone[0]?.state, "done");
    assert.deepEqual(retryDone[0]?.blocked, [
      {
        provider: "claude",
        model: "good",
        reason: "Artifact denied",
        reasonHash: "hash-1",
      },
    ]);
  } finally {
    f.cleanup();
  }
});

test("blocked evidence deduplicates retries and keeps long alias chains", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const check = (text: string): Validation =>
      text === "BLOCKED"
        ? {
            ok: false,
            cls: "blocked",
            reason: "blocked: Artifact denied",
            blocked: { reason: "Artifact denied", reasonHash: "hash-1" },
          }
        : validate(text);

    f.script("claude", "bad", "BLOCKED");
    f.script("claude", "good", {
      status: "fail",
      cls: "auth",
      detail: "denied",
    });

    const dir = path.join(f.session, "single");
    const slots = [slot("claude", ["bad", "good"])];

    const fanOutResult3 = await fanOut(
      { dir, slots, prompt: "question", validate: check, quota },
      f.deps
    );

    assert.equal(fanOutResult3[0]?.state, "failed");
    f.script("claude", "good", "answer");

    const done = await fanOut(
      { dir, slots, prompt: "question", validate: check, quota },
      f.deps
    );

    assert.equal(done[0]?.state, "done");
    assert.deepEqual(done[0]?.blocked, [
      {
        provider: "claude",
        model: "bad",
        reason: "Artifact denied",
        reasonHash: "hash-1",
      },
    ]);
    const models = Array.from({ length: 10 }, (_, index) => `m${index}`);

    const manyCheck = (text: string): Validation =>
      text === "BLOCKED"
        ? {
            ok: false,
            cls: "blocked",
            reason: "blocked: denied",
            blocked: { reason: "denied", reasonHash: "hash-1" },
          }
        : validate(text);

    // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
    f.deps.delegate = async () => ({
      outcome: { status: "ok", text: "BLOCKED", resume: null, sessionId: null },
      invocations: [],
    });

    const failed = await fanOut(
      {
        dir: path.join(f.session, "many"),
        slots: [slot("claude", models)],
        prompt: "question",
        validate: manyCheck,
        quota,
      },
      f.deps
    );

    assert.equal(failed[0]?.state, "failed");
    assert.equal(failed[0]?.blocked?.length, 10);
  } finally {
    f.cleanup();
  }
});

test("reserve attempts carry target slot", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.script("claude", "good", {
      status: "fail",
      cls: "auth",
      detail: "unavailable",
    });
    f.script("copilot", "good", "reserve answer");
    await fanOut(
      {
        dir: path.join(f.session, "target"),
        slots: [slot("claude"), slot("copilot", "good", true)],
        prompt: "question",
        validate,
        quota,
      },
      f.deps
    );
    assert.equal(
      f.launches.find((launch) => launch.provider === "claude")?.request
        .targetSlot,
      undefined
    );
    assert.equal(
      f.launches.find((launch) => launch.provider === "copilot")?.request
        .targetSlot,
      "claude[0]"
    );
  } finally {
    f.cleanup();
  }
});

test("coverage round failure evidence is written before the failed slot file, including retries", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.script("claude", "good", {
      status: "fail",
      cls: "auth",
      detail: "unavailable",
    });
    f.script("agy", "good", "answer");

    const dir = path.join(f.session, "coverage");
    const file = path.join(dir, "slots", "claude[0].json");
    const seen: string[] = [];

    const input = {
      dir,
      slots: [slot("claude"), slot("agy")],
      prompt: "question",
      validate,
      quota,
      onFailed: (name: string, outcome: { cls: string }) => {
        seen.push(`${name}:${outcome.cls}:${fs.existsSync(file)}`);
      },
    };

    const first = await fanOut(input, f.deps);
    assert.deepEqual(
      first.map((reply) => reply.state),
      ["failed", "done"]
    );
    assert.deepEqual(seen, ["claude[0]:auth:false"]);
    await fanOut(input, f.deps);
    assert.deepEqual(
      seen,
      ["claude[0]:auth:false", "claude[0]:auth:true"],
      "a retry reports again before it overwrites the saved failure"
    );
  } finally {
    f.cleanup();
  }
});

test("native-first launch defers CLI work and consume replays its saved result", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("claude", "good", "answer");
    f.script("agy", "good", "cli answer");
    const dir = path.join(f.session, "launch-order");
    const slots = [slot("claude"), slot("agy")];
    const replayed: string[] = [];
    f.deps.diagnostics = (event) => {
      if (
        event.kind === "slot" &&
        event.state === "done" &&
        event.replay === true
      ) {
        replayed.push(event.slot);
      }
    };

    const input = {
      dir,
      slots,
      prompt: "question",
      validate,
      quota,
      sessionRoot: f.session,
      nativeFirstProviders: ["claude"],
    };

    const first = await fanOut(input, f.deps);
    assert.equal(f.launches.length, 0);
    const native = first.filter((outcome) => outcome.state === "native");
    assert.equal(native.length, 1);
    assert.equal(defined(native[0]).slot, "claude[0]");
    assert.ok(
      narrow(
        JSON.parse(fs.readFileSync(path.join(dir, "fanout.json"), "utf-8")),
        withFields({ nativeFirst: flag })
      ).nativeFirst
    );
    await fanOut(input, f.deps);
    assert.deepEqual(
      f.launches.map((launch) => launch.provider),
      ["agy"]
    );
    assert.ok(
      narrow(
        JSON.parse(fs.readFileSync(path.join(dir, "fanout.json"), "utf-8")),
        withFields({ cliWaveDone: flag })
      ).cliWaveDone
    );
    replayed.length = 0;
    const resumed = await fanOut(input, f.deps);
    assert.deepEqual(
      resumed.map((outcome) => [outcome.slot, outcome.state]),
      [
        ["claude[0]", "native"],
        ["agy[0]", "done"],
      ]
    );
    assert.deepEqual(
      f.launches.map((launch) => launch.provider),
      ["agy"]
    );
    assert.deepEqual(replayed, ["agy[0]"]);
  } finally {
    f.cleanup();
  }
});

test("native-first failure on host change runs the cli cascade", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("claude", "good", "cli answer");
    const dir = path.join(f.session, "host-change");
    const slots = [slot("claude")];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    const pending = first.find((outcome) => outcome.state === "native");
    assert.ok(pending?.state === "native");
    fs.writeFileSync(
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
      (pending as { replyPath: string }).replyPath,
      "valid answer"
    );
    f.deps.orchestrator = { platform: "agy", model: null };

    const second = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        nativeFirstProviders: [],
      },
      f.deps
    );

    assert.ok(f.launches.length > 0);
    assert.equal(
      second.find((outcome) => outcome.slot === "claude[0]")?.state,
      "done"
    );
    assert.ok(
      fs.existsSync(
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
        `${(pending as { replyPath: string }).replyPath}.invalid-1`
      ),
      "a host change invalidates the pending reply"
    );
  } finally {
    f.cleanup();
  }
});

test("native descriptor carries cwd model effort and guarded prompt", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("claude", "a", "answer-a");
    f.script("claude", "b", "answer-b");
    const dir = path.join(f.session, "descriptor");

    const slots = [
      {
        slot: "claude[0]",
        provider: "claude",
        index: 0,
        model: ["a", "b"],
        effort: "high",
        native: false,
        reserve: false,
      },
    ];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        cwd: f.root,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    const native = first.find((outcome) => outcome.state === "native");
    assert.ok(native?.state === "native");
    assert.ok(native !== undefined && native !== null);
    assert.equal(native.cwd, f.root);
    assert.deepEqual(native.model, ["a", "b"]);
    assert.equal(native.effort, "high");
    assert.ok(
      typeof native.attempt === "string" &&
        native.attempt.startsWith("claude[0]#")
    );
    const promptText = fs.readFileSync(native.promptPath, "utf-8");
    assert.match(promptText, /\[PRIMARY WORKSPACE\]/u);
    assert.match(promptText, /\[SESSION ARTIFACTS\]/u);

    const baseText = fs.readFileSync(
      path.join(dir, "prompts", "claude[0].md"),
      "utf-8"
    );

    assert.doesNotMatch(baseText, /\[PRIMARY WORKSPACE\]/u);
  } finally {
    f.cleanup();
  }
});

test("stale and replayed reports are ignored without ending a later launch", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("claude", "good", "cli answer");
    f.script("agy", "good", "cli answer");
    const dir = path.join(f.session, "stale");
    const slots = [slot("claude"), slot("agy")];
    const ignored: string[] = [];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
        nativeFailures: [
          { attempt: "claude[0]#deadbe", reason: "gone", reasonHash: "h" },
        ],
        onIgnoredReport: (attempt: string) => {
          ignored.push(attempt);
        },
      },
      f.deps
    );

    assert.deepEqual(ignored, ["claude[0]#deadbe"]);
    assert.equal(
      first.filter((outcome) => outcome.state === "native").length,
      1
    );
    assert.equal(cliWaveState(dir), "pending");
    const native = first.find((outcome) => outcome.state === "native");
    assert.ok(native?.state === "native");
    const waveIgnored: string[] = [];
    await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
        nativeFailures: [
          { attempt: "claude[0]#deadbe", reason: "gone", reasonHash: "h" },
        ],
        onIgnoredReport: (attempt: string) => {
          waveIgnored.push(attempt);
        },
      },
      f.deps
    );
    assert.deepEqual(waveIgnored, ["claude[0]#deadbe"]);
    assert.equal(cliWaveState(dir), "done");
    fs.writeFileSync(native.replyPath, "valid answer");
    const doneIgnored: string[] = [];

    const third = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
        nativeFailures: [
          { attempt: native.attempt, reason: "late", reasonHash: "h2" },
        ],
        onIgnoredReport: (attempt: string) => {
          doneIgnored.push(attempt);
        },
      },
      f.deps
    );

    assert.equal(
      third.find((outcome) => outcome.slot === "claude[0]")?.state,
      "failed"
    );
    assert.ok(
      !f.launches.some((launch) => launch.provider === "claude"),
      "no host CLI launches"
    );
    const replayIgnored: string[] = [];
    await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
        nativeFailures: [
          { attempt: native.attempt, reason: "late", reasonHash: "h2" },
        ],
        onIgnoredReport: (attempt: string) => {
          replayIgnored.push(attempt);
        },
      },
      f.deps
    );
    assert.deepEqual(replayIgnored, [native.attempt]);
    assert.deepEqual(doneIgnored, []);
  } finally {
    f.cleanup();
  }
});

test("cli-only roster reports no wave state", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.script("claude", "good", "answer");
    const dir = path.join(f.session, "cli-only");

    const outcomes = await fanOut(
      { dir, slots: [slot("claude")], prompt: "question", validate, quota },
      f.deps
    );

    assert.equal(outcomes[0]?.state, "done");
    assert.equal(cliWaveState(dir), undefined);
  } finally {
    f.cleanup();
  }
});

test("blocked report shares one identity with a native reply and wins over the file", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("claude", "good", "cli answer");
    const dir = path.join(f.session, "blocked-identity");
    const slots = [slot("claude")];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    const pending = first.find((outcome) => outcome.state === "native");
    assert.ok(pending?.state === "native");
    assert.ok(pending !== undefined && pending !== null);
    fs.writeFileSync(pending.replyPath, "valid answer");
    const raw = "denied access";
    const hash = createHash("sha256").update(raw).digest("hex");
    await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );
    const ignored: string[] = [];

    const third = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
        nativeFailures: [
          {
            attempt: pending.attempt,
            reason: `BLOCKED: ${raw}`,
            reasonHash: hash,
          },
        ],
        onIgnoredReport: (attempt: string) => {
          ignored.push(attempt);
        },
      },
      f.deps
    );

    assert.deepEqual(ignored, []);
    const outcome = defined(third.find((entry) => entry.slot === "claude[0]"));
    assert.equal(outcome.state, "failed");
    assert.equal(f.launches.length, 0, "no host CLI launches");
    assert.ok(fs.existsSync(`${pending.replyPath}.invalid-1`));
  } finally {
    f.cleanup();
  }
});

test("cli-only failed slot retries its cli and retakes a free reserve", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.script("agy", "good", { status: "fail", cls: "auth", detail: "denied" });
    f.script("claude", "good", {
      status: "fail",
      cls: "auth",
      detail: "denied",
    });
    const dir = path.join(f.session, "cli-retake");
    const slots = [slot("agy"), { ...slot("claude"), reserve: true }];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        nativeFirstProviders: [],
      },
      f.deps
    );

    assert.equal(
      first.find((outcome) => outcome.slot === "agy[0]")?.state,
      "failed"
    );
    assert.equal(
      f.launches.length,
      2,
      "the failed substitute spends the reserve once"
    );
    f.launches.length = 0;
    f.script("agy", "good", { status: "fail", cls: "auth", detail: "denied" });
    f.script("claude", "good", {
      status: "fail",
      cls: "auth",
      detail: "denied",
    });

    const second = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        nativeFirstProviders: [],
      },
      f.deps
    );

    assert.equal(
      second.find((outcome) => outcome.slot === "agy[0]")?.state,
      "failed",
      "a later failure takes no second reserve"
    );
    assert.equal(f.launches.length, 2);
    assert.deepEqual(
      f.launches.map((launch) => launch.provider),
      ["agy", "claude"]
    );
  } finally {
    f.cleanup();
  }
});

test("non-host target consumes a host reserve reply under its logical slot", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("agy", "good", { status: "fail", cls: "auth", detail: "denied" });
    f.script("claude", "good", "reserve cli answer");
    const dir = path.join(f.session, "reserve-consume");
    const slots = [slot("agy"), { ...slot("claude"), reserve: true }];
    const providers = ["claude"];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: providers,
      },
      f.deps
    );

    const pending = first.find((outcome) => outcome.slot === "agy[0]");
    assert.ok(pending?.state === "native");
    assert.equal(pending.provider, "claude");
    const { attempt } = pending;
    assert.ok(attempt.startsWith("claude[0]#"));

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const { reserveUsedBy, nativeLaunched } = JSON.parse(
      fs.readFileSync(path.join(dir, "fanout.json"), "utf-8")
    );

    assert.deepEqual(
      // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
      { reserveUsedBy, nativeLaunched },
      { reserveUsedBy: "agy[0]", nativeLaunched: true }
    );
    const { replyPath } = pending;

    const waved = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: providers,
      },
      f.deps
    );

    assert.equal(
      waved.find((outcome) => outcome.slot === "agy[0]")?.state,
      "native"
    );
    fs.writeFileSync(replyPath, "reserve answer");

    const done = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: providers,
      },
      f.deps
    );

    const finished = done.find((entry) => entry.slot === "agy[0]");
    assert.equal(finished?.state, "done");
    assert.equal(finished.text, "reserve answer");
    assert.equal(finished.responder?.provider, "claude");
    assert.equal(finished.responder?.slot, "agy[0]");
  } finally {
    f.cleanup();
  }
});

test("host change while a native reserve is pending runs the reserve cli", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("agy", "good", { status: "fail", cls: "auth", detail: "denied" });
    f.script("claude", "good", "reserve cli answer");
    const dir = path.join(f.session, "reserve-host-change");
    const slots = [slot("agy"), { ...slot("claude"), reserve: true }];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    const pending = first.find((outcome) => outcome.slot === "agy[0]");
    assert.ok(pending?.state === "native");
    f.deps.orchestrator = { platform: "opencode", model: null };
    f.script("claude", "good", "reserve fallback answer");
    f.script("agy", "good", "target fallback answer");

    const second = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["opencode"],
      },
      f.deps
    );

    const outcome = second.find((entry) => entry.slot === "agy[0]");
    assert.equal(outcome?.state, "done");
    assert.equal(outcome.text, "reserve fallback answer");
    assert.ok(
      f.launches.some(
        (launch) =>
          launch.provider === "claude" && launch.request.targetSlot === "agy[0]"
      )
    );
  } finally {
    f.cleanup();
  }
});

for (const [title, nativeFirstProviders] of [
  ["CLI-only concurrent failures claim one reserve", []],
  ["native wave concurrent failures claim one reserve", ["codex"]],
] as const) {
  test(title, async () => {
    const f = sessionFixture({ memory: true });

    try {
      const dir = path.join(f.session, "concurrent-reserve");

      const slots = [
        slot("agy"),
        slot("claude"),
        slot("copilot", "good", true),
      ];

      if (nativeFirstProviders.length) {
        slots.push(slot("codex"));
      }

      f.script("agy", "good", {
        status: "fail",
        cls: "auth",
        detail: "denied",
      });
      f.script("claude", "good", {
        status: "fail",
        cls: "auth",
        detail: "denied",
      });
      f.script("copilot", "good", "reserve answer");
      const secondTargetStarted = gate();
      const ownerReserveStarted = gate();
      const contenderFinished = gate();
      const ownersAtLaunch: (string | undefined)[] = [];
      const { delegate } = f.deps;
      f.deps.delegate = async (provider, request, mode) => {
        if (provider === "copilot") {
          const statePath = path.join(dir, "fanout.json");

          // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
          const saved = fs.existsSync(statePath)
            ? JSON.parse(fs.readFileSync(statePath, "utf-8"))
            : undefined;

          // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
          ownersAtLaunch.push(saved?.reserveUsedBy);
        }

        const result = await delegate(provider, request, mode);

        if (provider === "agy") {
          await secondTargetStarted.promise;
        }

        if (provider === "claude") {
          secondTargetStarted.resolve();
          await ownerReserveStarted.promise;
        }

        if (provider === "copilot") {
          ownerReserveStarted.resolve();

          // Keep the owner's substitute pending until the contender has tried the reserve.
          if (request.targetSlot === "agy[0]") {
            await contenderFinished.promise;
          } else {
            contenderFinished.resolve();
          }
        }

        return result;
      };

      const input = {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        nativeFirstProviders,
        onFailed: (logical: string) => {
          if (logical === "claude[0]") {
            contenderFinished.resolve();
          }
        },
      };

      if (nativeFirstProviders.length) {
        const initial = await fanOut(input, f.deps);
        assert.ok(
          initial.some(
            (outcome) =>
              outcome.slot === "codex[0]" && outcome.state === "native"
          )
        );
        assert.deepEqual(f.launches, []);
      }

      const outcomes = await fanOut(input, f.deps);
      assert.deepEqual(ownersAtLaunch, ["agy[0]"]);

      const reserveLaunches = f.launches.filter(
        (launch) => launch.provider === "copilot"
      );

      assert.deepEqual(
        reserveLaunches.map((launch) => launch.request.targetSlot),
        ["agy[0]"]
      );
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(dir, "fanout.json"), "utf-8"))
          // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
          .reserveUsedBy,
        "agy[0]"
      );
      const owner = outcomes.find((outcome) => outcome.slot === "agy[0]");
      assert.ok(owner?.state === "done");
      assert.equal(owner.text, "reserve answer");
      assert.deepEqual(owner.responder, {
        slot: "copilot[0]",
        provider: "copilot",
        model: "good",
        native: false,
      });
      assert.equal(
        outcomes.find((outcome) => outcome.slot === "claude[0]")?.state,
        "failed"
      );
    } finally {
      f.cleanup();
    }
  });
}

test("interrupted reservation resumes for its recorded owner only", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.script("agy", "good", { status: "fail", cls: "auth", detail: "denied" });
    f.script("claude", "good", {
      status: "fail",
      cls: "auth",
      detail: "denied",
    });
    const dir = path.join(f.session, "interrupted-reserve");
    const reserve = { ...slot("copilot"), reserve: true };
    // No copilot script: the reserve launch throws, simulating a crash
    // between persisting reserveUsedBy and launching the substitute.
    await assert.rejects(
      fanOut(
        {
          dir,
          slots: [slot("agy"), reserve],
          prompt: "question",
          validate,
          quota,
          nativeFirstProviders: [],
        },
        f.deps
      ),
      /Unscripted delegate/u
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, "fanout.json"), "utf-8"))
        // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
        .reserveUsedBy,
      "agy[0]"
    );
    assert.equal(fs.existsSync(path.join(dir, "slots", "agy[0].json")), false);
    // On retry a second failing target joins: only the recorded owner resumes the reserve.
    f.script("copilot", "good", "reserve answer");
    f.script("codex", "good", {
      status: "fail",
      cls: "auth",
      detail: "denied",
    });
    f.launches.length = 0;

    const second = await fanOut(
      {
        dir,
        slots: [slot("agy"), slot("codex"), reserve],
        prompt: "question",
        validate,
        quota,
        nativeFirstProviders: [],
      },
      f.deps
    );

    assert.equal(
      second.find((outcome) => outcome.slot === "agy[0]")?.state,
      "done"
    );
    assert.equal(
      second.find((outcome) => outcome.slot === "codex[0]")?.state,
      "failed"
    );

    const reserveLaunches = f.launches.filter(
      (launch) => launch.provider === "copilot"
    );

    assert.equal(reserveLaunches.length, 1);
    assert.equal(defined(reserveLaunches[0]).request.targetSlot, "agy[0]");
  } finally {
    f.cleanup();
  }
});

// Crash state after the native prompt and owner record, before the descriptor save.
const interruptedNativeReserve = async (
  f: ReturnType<typeof sessionFixture>,
  dir: string
) => {
  const run = async (slots: RosterSlot[]) =>
    await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

  f.script("agy", "good", {
    status: "fail",
    cls: "config",
    detail: "bad config",
  });
  await run([slot("agy"), { ...slot("claude"), reserve: true }]);
  fs.writeFileSync(
    path.join(dir, "prompts", "agy[0].native.md"),
    "interrupted native prompt"
  );
  fs.writeFileSync(
    path.join(dir, "fanout.json"),
    JSON.stringify({ reserveUsedBy: "agy[0]" })
  );
  f.script("agy", "good", { status: "fail", cls: "auth", detail: "denied" });

  return run;
};

test("interrupted native reservation resumes for its recorded owner", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const run = await interruptedNativeReserve(
      f,
      path.join(f.session, "interrupted-owner")
    );

    const resumed = await run([
      slot("agy"),
      { ...slot("claude"), reserve: true },
    ]);

    const owner = resumed.find((entry) => entry.slot === "agy[0]");
    assert.ok(owner?.state === "native");
    assert.deepEqual(
      [owner?.state, owner?.provider],
      ["native", "claude"],
      `the recorded owner resumes its reserve: ${JSON.stringify(resumed)}`
    );
  } finally {
    f.cleanup();
  }

  const g = sessionFixture({ memory: true });

  try {
    const run = await interruptedNativeReserve(
      g,
      path.join(g.session, "interrupted-no-steal")
    );

    g.script("codex", "good", {
      status: "fail",
      cls: "auth",
      detail: "denied",
    });

    // The other target checks the reserve before the owner's retry saves its outcome.
    const second = await run([
      slot("codex"),
      slot("agy"),
      { ...slot("claude"), reserve: true },
    ]);

    const owner = second.find((entry) => entry.slot === "agy[0]");
    assert.ok(owner?.state === "native");
    assert.deepEqual(
      [owner?.state, owner?.provider],
      ["native", "claude"],
      `the recorded owner keeps its reserve: ${JSON.stringify(second)}`
    );
    assert.equal(
      second.find((entry) => entry.slot === "codex[0]")?.state,
      "failed",
      "a second target does not take the held reserve"
    );
    assert.ok(
      !g.launches.some((launch) => launch.provider === "claude"),
      "the stolen reserve never launches"
    );
  } finally {
    g.cleanup();
  }
});

test("late write from an earlier attempt is not read as the reserve reply", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("claude", "good", {
      status: "fail",
      cls: "auth",
      detail: "denied",
    });
    const dir = path.join(f.session, "late-write");
    const slots = [slot("claude"), { ...slot("agy"), reserve: true }];
    const providers = ["claude", "agy"];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: providers,
      },
      f.deps
    );

    const pending = first.find((outcome) => outcome.state === "native");
    assert.ok(pending?.state === "native");
    assert.ok(pending !== undefined && pending !== null);

    // Reporting the launch attempt failed falls back to the CLI, which fails,
    // so the host reserve takes a native descriptor with its own reply path.
    const waved = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: providers,
        nativeFailures: [
          { attempt: pending.attempt, reason: "stale voice", reasonHash: "h1" },
        ],
      },
      f.deps
    );

    const reserve = waved.find((outcome) => outcome.slot === "claude[0]");
    assert.ok(reserve?.state === "native");
    assert.notEqual(reserve.attempt, pending.attempt);
    assert.notEqual(reserve.replyPath, pending.replyPath);
    // A late write lands at the earlier attempt's path after the reserve wrote.
    fs.writeFileSync(pending.replyPath, "late answer");

    const consumed = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: providers,
      },
      f.deps
    );

    const outcome = defined(
      consumed.find((entry) => entry.slot === "claude[0]")
    );

    assert.equal(outcome.state, "native");
    assert.ok(
      fs.existsSync(pending.replyPath),
      "late file is left alone, never consumed or invalidated"
    );
    // The reserve reply still completes the slot.
    fs.writeFileSync(reserve.replyPath, "reserve answer");

    const done = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: providers,
      },
      f.deps
    );

    const finished = done.find((entry) => entry.slot === "claude[0]");
    assert.equal(finished?.state, "done");
    assert.equal(finished.text, "reserve answer");
  } finally {
    f.cleanup();
  }
});

test("underfill names the sandbox gap through resolveSlots and the note", () => {
  const f = sessionFixture({ memory: true });

  try {
    const skillRoot = path.join(f.root, "skill");
    fs.mkdirSync(skillRoot);
    fs.writeFileSync(
      path.join(skillRoot, "config.jsonc"),
      JSON.stringify({
        "read-delegates": {
          opencode: { targets: [{ medium: {} }] },
          codex: { targets: [{ medium: {} }] },
        },
        phases: {
          "plan-review": { targets: { medium: 1 }, rounds: { medium: 1 } },
        },
      })
    );
    f.deps.skillRoot = skillRoot;
    f.deps.orchestrator = { platform: "claude", model: null };
    f.deps.sandboxSupported = { opencode: false };
    const roster = resolveSlots("plan", "medium", f.deps);
    assert.deepEqual(
      roster.targets.map((item) => item.slot),
      ["codex[0]"]
    );
    assert.deepEqual(roster.reserves, []);
    assert.equal(
      underfillNote(roster),
      "; underfill 1/1 targets, host claude, excluded native-only: none, sandbox unsupported: opencode"
    );
  } finally {
    f.cleanup();
  }
});

test("cli-only native-only report returns failed without minting a fresh descriptor", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const dir = path.join(f.session, "native-only-report");
    const slots = [slot("codex", "good", false, true)];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        nativeFirstProviders: [],
      },
      f.deps
    );

    const pending = first.find((outcome) => outcome.slot === "codex[0]");
    assert.ok(pending?.state === "native");
    const { attempt } = pending;
    const { replyPath } = pending;
    fs.writeFileSync(replyPath, "partial");
    const ignored: string[] = [];

    const second = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        nativeFirstProviders: [],
        nativeFailures: [{ attempt, reason: "gone", reasonHash: "h1" }],
        // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
        onIgnoredReport: (attempt: string) => {
          ignored.push(attempt);
        },
      },
      f.deps
    );

    assert.deepEqual(ignored, []);
    const failed = second.find((outcome) => outcome.slot === "codex[0]");
    assert.equal(failed?.state, "failed");
    assert.ok(
      !fs.existsSync(replyPath),
      "report quarantines the partial reply"
    );
    assert.ok(
      fs.existsSync(`${replyPath}.invalid-1`),
      "report quarantines the partial reply as .invalid-1"
    );

    const third = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        nativeFirstProviders: [],
      },
      f.deps
    );

    assert.equal(
      third.find((outcome) => outcome.slot === "codex[0]")?.state,
      "native"
    );
  } finally {
    f.cleanup();
  }
});

test("reply quarantine failure preserves evidence or surfaces instead of silently continuing", async (t) => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("claude", "good", "cli answer");

    const launch = async (dir: string) => {
      const slots = [slot("claude")];

      const first = await fanOut(
        {
          dir,
          slots,
          prompt: "question",
          validate,
          quota,
          sessionRoot: f.session,
          nativeFirstProviders: ["claude"],
        },
        f.deps
      );

      const pending = first.find((outcome) => outcome.state === "native");
      assert.ok(pending?.state === "native");
      assert.ok(pending !== undefined && pending !== null);
      fs.writeFileSync(pending.replyPath, "   ");
      await fanOut(
        {
          dir,
          slots,
          prompt: "question",
          validate,
          quota,
          sessionRoot: f.session,
          nativeFirstProviders: ["claude"],
        },
        f.deps
      );

      return pending;
    };

    const realRename = fs.renameSync;

    const failReplies = (source: fs.PathLike, target: fs.PathLike) => {
      if (String(source).includes("replies")) {
        throw new Error("locked by another process");
      }

      realRename(source, target);
    };

    const pending = await launch(path.join(f.session, "quarantine-copy"));
    const copyRename = t.mock.method(fs, "renameSync", failReplies);

    try {
      const done = await fanOut(
        {
          dir: path.join(f.session, "quarantine-copy"),
          slots: [slot("claude")],
          prompt: "question",
          validate,
          quota,
          sessionRoot: f.session,
          nativeFirstProviders: ["claude"],
        },
        f.deps
      );

      assert.equal(
        done.find((outcome) => outcome.slot === "claude[0]")?.state,
        "failed"
      );
      assert.ok(
        // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
        !f.launches.some((launch) => launch.provider === "claude"),
        "no host CLI launches"
      );
      assert.equal(
        fs.readFileSync(`${pending.replyPath}.invalid-1`, "utf-8"),
        "   "
      );
      assert.ok(!fs.existsSync(pending.replyPath));
    } finally {
      copyRename.mock.restore();
    }

    const pending2 = await launch(path.join(f.session, "quarantine-surfaces"));
    const realRm = fs.rmSync;
    const failingRename = t.mock.method(fs, "renameSync", failReplies);

    const remove = t.mock.method(
      fs,
      "rmSync",
      (...args: Parameters<typeof realRm>) => {
        if (String(args[0]).includes("replies")) {
          throw new Error("permission denied");
        }

        realRm(...args);
      }
    );

    try {
      await assert.rejects(
        fanOut(
          {
            dir: path.join(f.session, "quarantine-surfaces"),
            slots: [slot("claude")],
            prompt: "question",
            validate,
            quota,
            sessionRoot: f.session,
            nativeFirstProviders: ["claude"],
          },
          f.deps
        ),
        /Cannot quarantine rejected reply/u
      );
    } finally {
      remove.mock.restore();
      failingRename.mock.restore();
    }

    assert.ok(pending2 !== undefined && pending2 !== null);
  } finally {
    f.cleanup();
  }
});

test("wave consumes a report for a reserve substitute under a non-first target", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("agy", "good", { status: "fail", cls: "auth", detail: "denied" });
    f.script("claude", "good", "substitute cli answer");
    const dir = path.join(f.session, "wave-substitute-report");

    const reserve = {
      slot: "claude[1]",
      provider: "claude",
      index: 1,
      model: "good",
      reserve: true,
      native: false,
    };

    const slots = [slot("claude"), slot("agy"), slot("codex"), reserve];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    assert.ok(
      first.find((outcome) => outcome.slot === "claude[0]")?.state === "native"
    );
    // Interrupt the wave between the substitute save and cliWaveDone: the
    // unscripted codex delegate rejects the batch after agy minted.
    await assert.rejects(
      fanOut(
        {
          dir,
          slots,
          prompt: "question",
          validate,
          quota,
          sessionRoot: f.session,
          nativeFirstProviders: ["claude"],
        },
        f.deps
      ),
      /Unscripted delegate/u
    );

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const substitute = JSON.parse(
      fs.readFileSync(path.join(dir, "slots", "agy[0].json"), "utf-8")
    );

    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(substitute.state, "native");
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    const attempt: unknown = substitute.attempt;
    assert.ok(
      typeof attempt === "string" && attempt.startsWith("claude[1]#"),
      JSON.stringify(attempt)
    );
    f.script("codex", "good", "codex answer");
    const ignored: string[] = [];

    const third = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
        nativeFailures: [
          {
            // eslint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
            attempt: substitute.attempt,
            reason: "launch gone",
            reasonHash: "h1",
          },
        ],
        // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
        onIgnoredReport: (attempt: string) => {
          ignored.push(attempt);
        },
      },
      f.deps
    );

    const done = third.find((outcome) => outcome.slot === "agy[0]");
    assert.equal(done?.state, "failed");
    assert.deepEqual(
      ignored,
      [],
      "a reported attempt is never left pending or ignored"
    );
    assert.equal(
      f.launches.filter(
        (launch) =>
          launch.provider === "claude" && launch.request.targetSlot === "agy[0]"
      ).length,
      0,
      "no host CLI launches for the substitute"
    );
    assert.equal(
      third.find((outcome) => outcome.slot === "claude[0]")?.state,
      "native"
    );
  } finally {
    f.cleanup();
  }
});

test("report on a native reserve attempt saves failed without host CLI", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("agy", "good", { status: "fail", cls: "auth", detail: "denied" });
    f.script("claude", "good", "reserve cli answer");
    const dir = path.join(f.session, "reserve-report-done");
    const slots = [slot("agy"), { ...slot("claude"), reserve: true }];
    const providers = ["claude"];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: providers,
      },
      f.deps
    );

    const pending = first.find((outcome) => outcome.slot === "agy[0]");
    assert.ok(pending?.state === "native");
    const ignored: string[] = [];

    const second = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: providers,
        nativeFailures: [
          { attempt: pending.attempt, reason: "launch gone", reasonHash: "h1" },
        ],
        onIgnoredReport: (attempt: string) => {
          ignored.push(attempt);
        },
      },
      f.deps
    );

    const done = second.find((outcome) => outcome.slot === "agy[0]");
    assert.equal(done?.state, "failed");
    assert.deepEqual(ignored, []);
    assert.equal(
      f.launches.filter((launch) => launch.provider === "claude").length,
      0,
      "no host CLI launches"
    );
  } finally {
    f.cleanup();
  }
});

test("host change while a native-only reserve is pending saves failed without a new descriptor", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "codex", model: null };
    f.script("agy", "good", { status: "fail", cls: "auth", detail: "denied" });
    const dir = path.join(f.session, "native-only-host-change");

    const slots = [
      slot("agy"),
      { ...slot("codex"), reserve: true, native: true },
    ];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: [],
      },
      f.deps
    );

    const pending = first.find((outcome) => outcome.slot === "agy[0]");
    assert.ok(pending?.state === "native");
    assert.ok(pending.attempt.startsWith("codex[0]#"));

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const { reserveUsedBy, nativeLaunched } = JSON.parse(
      fs.readFileSync(path.join(dir, "fanout.json"), "utf-8")
    );

    assert.deepEqual(
      // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
      { reserveUsedBy, nativeLaunched },
      { reserveUsedBy: "agy[0]", nativeLaunched: true }
    );
    f.deps.orchestrator = { platform: "opencode", model: null };
    f.launches.length = 0;

    const second = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["opencode"],
      },
      f.deps
    );

    const failed = second.find((outcome) => outcome.slot === "agy[0]");
    assert.equal(failed?.state, "failed");
    assert.equal(
      f.launches.length,
      0,
      "neither the logical nor the reserve cli runs"
    );
    assert.ok(!("attempt" in failed), "no fresh descriptor minted");
  } finally {
    f.cleanup();
  }
});

test("reported native-only reserve stays failed across retries", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "codex", model: null };
    f.script("agy", "good", { status: "fail", cls: "auth", detail: "denied" });
    const dir = path.join(f.session, "native-only-stays-failed");

    const slots = [
      slot("agy"),
      { ...slot("codex"), reserve: true, native: true },
    ];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: [],
      },
      f.deps
    );

    const pending = first.find((outcome) => outcome.slot === "agy[0]");
    assert.ok(pending?.state === "native");

    const second = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: [],
        nativeFailures: [
          { attempt: pending.attempt, reason: "launch gone", reasonHash: "h1" },
        ],
      },
      f.deps
    );

    const failed = second.find((outcome) => outcome.slot === "agy[0]");
    assert.equal(failed?.state, "failed");
    assert.equal(
      failed.cliOnly,
      undefined,
      "native history bars the cli-only retake marker"
    );
    const launchesBefore = f.launches.length;

    const third = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: [],
      },
      f.deps
    );

    assert.equal(
      third.find((outcome) => outcome.slot === "agy[0]")?.state,
      "failed"
    );
    assert.equal(
      f.launches.length - launchesBefore,
      1,
      "only the target cli reruns, no second descriptor"
    );
    assert.ok(
      !f.launches
        .slice(launchesBefore)
        .some((launch) => launch.provider === "codex")
    );
  } finally {
    f.cleanup();
  }
});

test("cli-only failed slot releases its reserve for another target after recovering", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.script("agy", "good", { status: "fail", cls: "auth", detail: "denied" });
    f.script("copilot", "good", {
      status: "fail",
      cls: "auth",
      detail: "denied",
    });
    const dir = path.join(f.session, "cli-retake-cross-owner");
    const reserve = { ...slot("copilot"), reserve: true };

    const first = await fanOut(
      {
        dir,
        slots: [slot("agy"), reserve],
        prompt: "question",
        validate,
        quota,
        nativeFirstProviders: [],
      },
      f.deps
    );

    assert.equal(
      first.find((outcome) => outcome.slot === "agy[0]")?.state,
      "failed"
    );
    f.script("agy", "good", "recovered");
    f.script("codex", "good", {
      status: "fail",
      cls: "auth",
      detail: "denied",
    });
    f.script("copilot", "good", "reserve answer");

    const second = await fanOut(
      {
        dir,
        slots: [slot("agy"), slot("codex"), reserve],
        prompt: "question",
        validate,
        quota,
        nativeFirstProviders: [],
      },
      f.deps
    );

    assert.equal(
      second.find((outcome) => outcome.slot === "agy[0]")?.state,
      "done"
    );
    const served = second.find((outcome) => outcome.slot === "codex[0]");
    assert.equal(served?.state, "done");
    assert.equal(served.text, "reserve answer");
    assert.ok(
      f.launches.some(
        (launch) =>
          launch.provider === "copilot" &&
          launch.request.targetSlot === "codex[0]"
      )
    );
  } finally {
    f.cleanup();
  }
});

test("consume runs independent fallback cascades concurrently", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "opencode", model: null };
    const dir = path.join(f.session, "consume-concurrent");
    const slots = [slot("claude"), slot("agy")];
    const providers = ["claude", "agy"];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: providers,
      },
      f.deps
    );

    assert.equal(
      first.filter((outcome) => outcome.state === "native").length,
      2
    );
    await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: providers,
      },
      f.deps
    );

    const attempts = first.flatMap((outcome) => {
      if (outcome.slot !== "claude[0]" && outcome.slot !== "agy[0]") {
        return [];
      }

      assert.equal(outcome.state, "native");

      return [outcome.attempt];
    });

    // The gate fails a cascade that runs alone: only concurrent cascades both pass.
    const arrivals: string[] = [];
    f.deps.delegate = async (provider) => {
      arrivals.push(provider);
      await Promise.resolve();

      if (arrivals.length < 2) {
        return {
          outcome: { status: "fail", cls: "auth", detail: "gated" } as const,
          invocations: [],
        };
      }

      return {
        outcome: {
          status: "ok",
          text: `${provider} answer`,
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };

    const third = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: providers,
        nativeFailures: attempts.map((attempt) => ({
          attempt,
          reason: "launch gone",
          reasonHash: "h1",
        })),
      },
      f.deps
    );

    assert.deepEqual(
      third.map((outcome) => outcome.state),
      ["done", "done"]
    );
    assert.deepEqual(arrivals.toSorted(), ["agy", "claude"]);
  } finally {
    f.cleanup();
  }
});

test("last-pending-settles retry carries forward saved blocked evidence", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };

    const check = (text: string): Validation =>
      text === "BLOCKED"
        ? {
            ok: false,
            cls: "blocked",
            reason: "blocked: Artifact denied",
            blocked: { reason: "Artifact denied", reasonHash: "hash-1" },
          }
        : validate(text);

    f.script("agy", "good", "BLOCKED");
    const dir = path.join(f.session, "retry-blocked");
    const slots = [slot("claude"), slot("agy")];
    const providers = ["claude"];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate: check,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: providers,
      },
      f.deps
    );

    assert.ok(
      first.find((outcome) => outcome.slot === "claude[0]")?.state === "native"
    );
    await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate: check,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: providers,
      },
      f.deps
    );
    const pending = first.find((outcome) => outcome.slot === "claude[0]");
    assert.ok(pending?.state === "native");
    fs.writeFileSync(pending.replyPath, "valid answer");
    f.script("agy", "good", "answer");

    const third = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate: check,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: providers,
      },
      f.deps
    );

    const done = third.find((outcome) => outcome.slot === "agy[0]");
    assert.equal(done?.state, "done");
    assert.deepEqual(done?.blocked, [
      {
        provider: "agy",
        model: "good",
        reason: "Artifact denied",
        reasonHash: "hash-1",
      },
    ]);
  } finally {
    f.cleanup();
  }
});

test("a failed-slot retry rewrites a base prompt modified by a native-only reserve", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "codex", model: null };
    f.script("agy", "good", { status: "fail", cls: "auth", detail: "denied" });
    const seen: string[] = [];
    const { delegate } = f.deps;
    f.deps.delegate = async (provider, request, mode) => {
      seen.push(fs.readFileSync(request.promptPath, "utf-8"));

      return await delegate(provider, request, mode);
    };

    const dir = path.join(f.session, "retry-prompt-rewrite");

    const reserve = {
      slot: "codex[0]",
      provider: "codex",
      index: 0,
      model: "good",
      reserve: true,
      native: true,
    };

    const slots = [slot("claude"), slot("agy"), reserve];
    const providers = ["claude"];

    const waveInput = {
      dir,
      slots,
      prompt: "question",
      validate,
      quota,
      sessionRoot: f.session,
      nativeFirstProviders: providers,
    };

    const launched = await fanOut(waveInput, f.deps);

    const nativeClaude = launched.find(
      (outcome) => outcome.slot === "claude[0]"
    );

    assert.ok(nativeClaude?.state === "native");
    assert.equal(
      launched.find((outcome) => outcome.slot === "claude[0]")?.state,
      "native"
    );
    const waved = await fanOut(waveInput, f.deps);
    const substitute = waved.find((outcome) => outcome.slot === "agy[0]");
    assert.ok(substitute?.state === "native");
    assert.equal(
      substitute?.state,
      "native",
      "the cli failure mints the host native-only reserve"
    );
    assert.ok(substitute.attempt.startsWith("codex[0]#"));
    assert.match(
      fs.readFileSync(path.join(dir, "prompts", "agy[0].md"), "utf-8"),
      /## Native reply/u,
      "the reserve mint appends the native reply section to the base prompt"
    );
    fs.writeFileSync(nativeClaude.replyPath, "native answer");
    const consumed = await fanOut(waveInput, f.deps);
    assert.equal(
      consumed.find((outcome) => outcome.slot === "claude[0]")?.state,
      "done"
    );
    assert.equal(
      consumed.find((outcome) => outcome.slot === "agy[0]")?.state,
      "native"
    );

    // A plain report ends the pending substitute; the next call retries it.
    const reported = await fanOut(
      {
        ...waveInput,
        nativeFailures: [
          {
            attempt: substitute.attempt,
            reason: "launch gone",
            reasonHash: "h-rewrite",
          },
        ],
      },
      f.deps
    );

    assert.equal(
      reported.find((outcome) => outcome.slot === "agy[0]")?.state,
      "failed"
    );
    f.script("agy", "good", "recovered");
    seen.length = 0;
    const retried = await fanOut(waveInput, f.deps);
    assert.equal(
      retried.find((outcome) => outcome.slot === "agy[0]")?.state,
      "done"
    );
    assert.ok(seen.length > 0, "the retry relaunches the cli");

    for (const prompt of seen) {
      assert.doesNotMatch(
        prompt,
        /## Native reply/u,
        "the retry hands the cli the base prompt, not the reserve-modified file"
      );
    }

    assert.ok(seen.some((prompt) => prompt === "question"));
  } finally {
    f.cleanup();
  }
});

test("interrupted fallback with ownership resumes for its owner", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("claude", "good", {
      status: "fail",
      cls: "auth",
      detail: "denied",
    });
    f.script("agy", "good", "cli answer");
    const dir = path.join(f.session, "fallback-owner");
    const slots = [slot("claude")];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    const pending = first.find((outcome) => outcome.state === "native");
    assert.ok(pending?.state === "native");
    assert.ok(pending !== undefined && pending !== null);
    f.script("claude", "good", {
      status: "fail",
      cls: "auth",
      detail: "denied",
    });
    const withReserve = [slot("claude"), { ...slot("copilot"), reserve: true }];
    await assert.rejects(
      fanOut(
        {
          dir,
          slots: withReserve,
          prompt: "question",
          validate,
          quota,
          sessionRoot: f.session,
          nativeFirstProviders: ["claude"],
          nativeFailures: [
            { attempt: pending.attempt, reason: "gone", reasonHash: "h1" },
          ],
        },
        f.deps
      ),
      /Unscripted delegate/u
    );

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, "slots", "claude[0].json"), "utf-8")
    );

    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(saved.state, "native");
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(saved.cliFallback, true);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, "fanout.json"), "utf-8"))
        // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
        .reserveUsedBy,
      "claude[0]"
    );
    f.launches.length = 0;
    f.script("claude", "good", "resumed answer");
    f.script("copilot", "good", "reserve answer");

    const resumed = await fanOut(
      {
        dir,
        slots: withReserve,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    assert.ok(f.launches.length > 0);
    assert.equal(
      resumed.find((outcome) => outcome.slot === "claude[0]")?.state,
      "done"
    );
  } finally {
    f.cleanup();
  }
});

test("wave resumes a cli fallback marker without requiring the report", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("claude", "good", "cli answer");
    f.script("agy", "good", "cli answer");
    const dir = path.join(f.session, "wave-resume");
    const slots = [slot("claude"), slot("agy")];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    const pending = first.find((outcome) => outcome.slot === "claude[0]");
    assert.ok(pending?.state === "native");
    assert.ok(pending !== undefined && pending !== null);

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, "slots", "claude[0].json"), "utf-8")
    );

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const withFallback = { ...saved, cliFallback: true, nativeError: "gone" };
    fs.writeFileSync(
      path.join(dir, "slots", "claude[0].json"),
      JSON.stringify(withFallback)
    );
    fs.writeFileSync(pending.replyPath, "stale");
    f.launches.length = 0;

    const noReport = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    assert.equal(
      f.launches.filter((launch) => launch.provider === "claude").length,
      0,
      "no host CLI launches"
    );
    assert.equal(
      noReport.find((outcome) => outcome.slot === "claude[0]")?.state,
      "failed"
    );
  } finally {
    f.cleanup();
  }
});

test("wave runs fallback cascades alongside cli targets", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("claude", "good", "cli answer");
    f.script("agy", "good", "cli answer");
    f.script("codex", "good", "cli answer");
    const dir = path.join(f.session, "wave-concurrent");
    const slots = [slot("claude"), slot("agy"), slot("codex")];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    const pending = first.find((outcome) => outcome.slot === "claude[0]");
    assert.ok(pending?.state === "native");
    assert.ok(pending !== undefined && pending !== null);

    const second = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
        nativeFailures: [
          { attempt: pending.attempt, reason: "gone", reasonHash: "h1" },
        ],
      },
      f.deps
    );

    assert.equal(
      second.find((outcome) => outcome.slot === "claude[0]")?.state,
      "failed"
    );
    assert.equal(
      second.find((outcome) => outcome.slot === "agy[0]")?.state,
      "done"
    );
    assert.equal(
      second.find((outcome) => outcome.slot === "codex[0]")?.state,
      "done"
    );
    assert.equal(
      f.launches.filter((launch) => launch.provider === "claude").length,
      0,
      "no host CLI launches"
    );
    assert.ok(f.launches.some((launch) => launch.provider === "agy"));
    assert.ok(f.launches.some((launch) => launch.provider === "codex"));
  } finally {
    f.cleanup();
  }
});

test("completed substitute does not release the reserve to a second target", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.script("agy", "good", { status: "fail", cls: "auth", detail: "denied" });
    f.script("copilot", "good", "reserve answer");
    const dir = path.join(f.session, "substitute-holds");
    const reserve = { ...slot("copilot"), reserve: true };

    const first = await fanOut(
      {
        dir,
        slots: [slot("agy"), reserve],
        prompt: "question",
        validate,
        quota,
        nativeFirstProviders: [],
      },
      f.deps
    );

    const owned = first.find((outcome) => outcome.slot === "agy[0]");
    assert.equal(owned?.state, "done");
    assert.equal(owned.responder?.slot, "copilot[0]");
    f.script("agy", "good", "recovered");
    f.script("codex", "good", {
      status: "fail",
      cls: "auth",
      detail: "denied",
    });
    f.script("copilot", "good", "second answer");

    const second = await fanOut(
      {
        dir,
        slots: [slot("agy"), slot("codex"), reserve],
        prompt: "question",
        validate,
        quota,
        nativeFirstProviders: [],
      },
      f.deps
    );

    assert.equal(
      second.find((outcome) => outcome.slot === "codex[0]")?.state,
      "failed"
    );
    assert.ok(
      !f.launches.some(
        (launch) =>
          launch.provider === "copilot" &&
          launch.request.targetSlot === "codex[0]"
      ),
      "the consumed reserve serves no second target"
    );
  } finally {
    f.cleanup();
  }

  const g = sessionFixture({ memory: true });

  try {
    g.deps.orchestrator = { platform: "claude", model: null };
    g.script("agy", "good", { status: "fail", cls: "auth", detail: "denied" });
    const dir = path.join(g.session, "native-substitute-holds");
    const reserve = { ...slot("claude"), reserve: true };
    const providers = ["claude"];

    const input = {
      dir,
      slots: [slot("agy"), reserve],
      prompt: "question",
      validate,
      quota,
      sessionRoot: g.session,
      nativeFirstProviders: providers,
    } satisfies FanOutInput;

    const first = await fanOut(input, g.deps);
    const pending = first.find((outcome) => outcome.slot === "agy[0]");
    assert.ok(pending?.state === "native");
    assert.ok(pending.attempt.startsWith("claude[0]#"));
    fs.writeFileSync(pending.replyPath, "reserve answer");
    const done = await fanOut(input, g.deps);
    const finished = done.find((entry) => entry.slot === "agy[0]");
    assert.equal(finished?.state, "done");
    assert.deepEqual(finished.responder, {
      slot: "agy[0]",
      provider: "claude",
      model: "good",
      native: true,
    });
    g.script("codex", "good", {
      status: "fail",
      cls: "auth",
      detail: "denied",
    });

    const third = await fanOut(
      {
        dir,
        slots: [slot("agy"), slot("codex"), reserve],
        prompt: "question",
        validate,
        quota,
        sessionRoot: g.session,
        nativeFirstProviders: providers,
      },
      g.deps
    );

    assert.equal(
      third.find((outcome) => outcome.slot === "codex[0]")?.state,
      "failed"
    );
    assert.ok(
      !g.launches.some(
        (launch) =>
          launch.provider === "claude" &&
          launch.request.targetSlot === "codex[0]"
      ),
      "the consumed native reserve serves no second target"
    );
  } finally {
    g.cleanup();
  }
});

test("interrupted cli fallback resumes without its report in the cli-only path", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.script("claude", "good", "fallback answer");
    const dir = path.join(f.session, "cli-fallback-resume");
    fs.mkdirSync(path.join(dir, "slots"), { recursive: true });
    fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
    fs.mkdirSync(path.join(dir, "replies"), { recursive: true });
    fs.writeFileSync(path.join(dir, "prompts", "agy[0].md"), "question");
    const replyPath = path.join(dir, "replies", "agy[0].m1.md");
    fs.writeFileSync(
      path.join(dir, "slots", "agy[0].json"),
      JSON.stringify({
        slot: "agy[0]",
        state: "native",
        promptPath: path.join(dir, "prompts", "agy[0].native.md"),
        replyPath,
        provider: "claude",
        attempt: "claude[1]#m1",
        cwd: f.session,
        model: "good",
        cliFallback: true,
        nativeError: "gone",
      })
    );
    fs.writeFileSync(replyPath, "stale answer");

    const reserve = {
      slot: "claude[1]",
      provider: "claude",
      index: 1,
      model: "good",
      reserve: true,
      native: false,
    };

    const outcomes = await fanOut(
      {
        dir,
        slots: [slot("agy"), reserve],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    const done = outcomes.find((outcome) => outcome.slot === "agy[0]");
    assert.equal(done?.state, "done");
    assert.equal(done.text, "fallback answer");
    assert.ok(
      !fs.existsSync(replyPath) && fs.existsSync(`${replyPath}.invalid-1`),
      "a late reply is quarantined, never consumed"
    );
    assert.ok(
      f.launches.some(
        (launch) =>
          launch.provider === "claude" && launch.request.targetSlot === "agy[0]"
      )
    );
  } finally {
    f.cleanup();
  }
});

test("host change to a native-first logical slot runs the physical cli", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("agy", "good", { status: "fail", cls: "auth", detail: "denied" });
    const dir = path.join(f.session, "host-to-logical");
    const reserve = { ...slot("claude"), reserve: true };

    const first = await fanOut(
      {
        dir,
        slots: [slot("agy"), reserve],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    const pending = first.find((outcome) => outcome.slot === "agy[0]");
    assert.ok(pending?.state === "native");
    assert.ok(pending.attempt.startsWith("claude[0]#"));
    f.deps.orchestrator = { platform: "agy", model: null };
    f.script("claude", "good", "reserve cli answer");

    // The launch defers the host-changed fallback instead of running it
    // before the new descriptors return; the wave resumes it next.
    const second = await fanOut(
      {
        dir,
        slots: [slot("agy"), reserve],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["agy"],
      },
      f.deps
    );

    assert.ok(
      !second.some((outcome) => outcome.slot === "agy[0]"),
      `the deferred fallback never returns as pending: ${JSON.stringify(
        second.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    assert.ok(
      !f.launches.some((launch) => launch.provider === "claude"),
      "no cli runs before the deferred return"
    );

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, "slots", "agy[0].json"), "utf-8")
    );

    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(saved.cliFallback, true);
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(saved.nativeError, "host changed");

    const third = await fanOut(
      {
        dir,
        slots: [slot("agy"), reserve],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["agy"],
      },
      f.deps
    );

    const done = third.find((entry) => entry.slot === "agy[0]");
    assert.equal(done?.state, "done");
    assert.equal(done.text, "reserve cli answer");
    assert.ok(
      f.launches.some(
        (launch) =>
          launch.provider === "claude" && launch.request.targetSlot === "agy[0]"
      )
    );
  } finally {
    f.cleanup();
  }
});

test("consume keeps a host native-only reserve substitute pending", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "codex", model: null };
    const dir = path.join(f.session, "consume-native-only-route");
    fs.mkdirSync(path.join(dir, "slots"), { recursive: true });
    fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
    fs.mkdirSync(path.join(dir, "replies"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "fanout.json"),
      JSON.stringify({ nativeFirst: true })
    );
    fs.writeFileSync(path.join(dir, "prompts", "agy[0].md"), "question");
    const replyPath = path.join(dir, "replies", "agy[0].m1.md");
    fs.writeFileSync(
      path.join(dir, "slots", "agy[0].json"),
      JSON.stringify({
        slot: "agy[0]",
        state: "native",
        promptPath: path.join(dir, "prompts", "agy[0].native.md"),
        replyPath,
        provider: "codex",
        attempt: "codex[0]#m1",
        cwd: f.session,
        model: "good",
      })
    );

    const reserve = {
      slot: "codex[0]",
      provider: "codex",
      index: 0,
      model: "good",
      reserve: true,
      native: true,
    };

    const waveInput = {
      dir,
      slots: [slot("agy"), reserve],
      prompt: "question",
      validate,
      quota,
      sessionRoot: f.session,
      nativeFirstProviders: ["claude"],
    } satisfies FanOutInput;

    const waved = await fanOut(waveInput, f.deps);
    assert.equal(
      waved.find((outcome) => outcome.slot === "agy[0]")?.state,
      "native",
      "the wave keeps the host native-only substitute pending"
    );
    assert.equal(
      f.launches.filter((launch) => launch.provider === "codex").length,
      0
    );
    fs.writeFileSync(
      path.join(dir, "fanout.json"),
      JSON.stringify({ nativeFirst: true, cliWaveDone: true })
    );

    const input = {
      dir,
      slots: [slot("agy"), reserve],
      prompt: "question",
      validate,
      quota,
      sessionRoot: f.session,
      nativeFirstProviders: [],
    } satisfies FanOutInput;

    const outcomes = await fanOut(input, f.deps);
    assert.equal(
      outcomes.find((outcome) => outcome.slot === "agy[0]")?.state,
      "native"
    );
    fs.writeFileSync(replyPath, "reserve answer");
    const done = await fanOut(input, f.deps);
    const finished = done.find((entry) => entry.slot === "agy[0]");
    assert.equal(finished?.state, "done");
    assert.equal(finished.text, "reserve answer");
    assert.deepEqual(finished.responder, {
      slot: "agy[0]",
      provider: "codex",
      model: "good",
      native: true,
    });
  } finally {
    f.cleanup();
  }
});

test("wave launches a newly native-first target that has no saved slot", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("claude", "good", "cli answer");
    const dir = path.join(f.session, "wave-new-native-first");
    const slots = [slot("claude"), slot("agy")];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    assert.equal(first.length, 1);
    // The host changes before the CLI wave: the previously CLI target is now
    // native-first with no saved slot, while the old native target falls back.
    // The new descriptor returns before the slow fallback settles; the next
    // call resumes the deferred fallback.
    f.deps.orchestrator = { platform: "agy", model: null };

    const waved = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["agy"],
      },
      f.deps
    );

    assert.equal(
      waved.length,
      1,
      `the stale attempt never returns as pending: ${JSON.stringify(waved.map((outcome) => outcome.slot))}`
    );
    const fresh = waved.find((outcome) => outcome.slot === "agy[0]");
    assert.ok(fresh?.state === "native");
    assert.ok(fresh.attempt.startsWith("agy[0]#"));
    assert.ok(
      !waved.some((outcome) => outcome.slot === "claude[0]"),
      `the stale attempt stays out of the early return: ${JSON.stringify(
        waved.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );

    const settled = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["agy"],
      },
      f.deps
    );

    assert.equal(
      settled.find((outcome) => outcome.slot === "claude[0]")?.state,
      "done"
    );
  } finally {
    f.cleanup();
  }
});

test("launch replays every saved outcome when the host changes past a pending reserve", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("agy", "good", "target answer");
    f.script("codex", "good", {
      status: "fail",
      cls: "auth",
      detail: "denied",
    });
    f.script("claude", "good", "reserve cli answer");
    const dir = path.join(f.session, "launch-nonfirst-host-change");
    const reserve = { ...slot("claude"), reserve: true };
    const slots = [slot("agy"), slot("codex"), reserve];
    await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const savedCodex = JSON.parse(
      fs.readFileSync(path.join(dir, "slots", "codex[0].json"), "utf-8")
    );

    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(savedCodex.state, "native");
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    const attempt: unknown = savedCodex.attempt;
    assert.ok(typeof attempt === "string" && attempt.startsWith("claude[0]#"));
    // The session moves to the agy host: agy turns native-first while codex
    // keeps its pending claude reserve attempt with a matching BLOCKED report.
    f.deps.orchestrator = { platform: "agy", model: null };
    const ignored: string[] = [];

    const second = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["agy"],
        nativeFailures: [
          {
            // eslint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
            attempt: savedCodex.attempt,
            reason: "BLOCKED: old host denied",
            reasonHash: "rh-launch",
          },
        ],
        // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
        onIgnoredReport: (attempt: string) => {
          ignored.push(attempt);
        },
      },
      f.deps
    );

    assert.deepEqual(
      ignored,
      [],
      "the matching report is consumed, not ignored"
    );
    const replayed = second.find((outcome) => outcome.slot === "agy[0]");
    assert.equal(
      replayed?.state,
      "done",
      `every saved outcome returns, not only native-first slots: ${JSON.stringify(
        second.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    // The launch defers the reported reserve instead of running its cli: the
    // marker persists with the reported reason and the wave resumes it next.
    assert.ok(
      !second.some((outcome) => outcome.slot === "codex[0]"),
      `the reported reserve defers, never pending: ${JSON.stringify(
        second.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    assert.ok(
      !f.launches.some((launch) => launch.provider === "claude"),
      "no cli runs before the deferred return"
    );

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const marked = JSON.parse(
      fs.readFileSync(path.join(dir, "slots", "codex[0].json"), "utf-8")
    );

    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(marked.cliFallback, true);
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(marked.nativeError, "BLOCKED: old host denied");

    const third = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["agy"],
      },
      f.deps
    );

    const done = third.find((outcome) => outcome.slot === "codex[0]");
    assert.ok(done?.state === "done");
    assert.equal(
      done?.state,
      "done",
      `the pending reserve routes by its physical provider: ${JSON.stringify(
        second.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    assert.equal(done.text, "reserve cli answer");
    assert.ok(
      (done.blocked ?? []).some((entry) => entry.reasonHash === "rh-launch"),
      `the matching report is retained: ${JSON.stringify(done.blocked)}`
    );
    assert.ok(
      f.launches.some(
        (launch) =>
          launch.provider === "claude" &&
          launch.request.targetSlot === "codex[0]"
      )
    );
  } finally {
    f.cleanup();
  }
});

test("native responder keeps the launched model and effort when the roster changes before consumption", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    const dir = path.join(f.session, "launch-config-keep");

    const launched = [
      {
        slot: "claude[0]",
        provider: "claude",
        index: 0,
        model: ["launch-model"],
        effort: "high",
        reserve: false,
        native: false,
      },
    ];

    const first = await fanOut(
      {
        dir,
        slots: launched,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    const pending = first.find((outcome) => outcome.state === "native");
    assert.ok(pending?.state === "native");
    assert.ok(pending !== undefined && pending !== null);

    // The configured model and effort change while the native answer is pending.
    const changed = [
      {
        slot: "claude[0]",
        provider: "claude",
        index: 0,
        model: ["changed-model"],
        effort: "low",
        reserve: false,
        native: false,
      },
    ];

    const second = await fanOut(
      {
        dir,
        slots: changed,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    assert.equal(
      second.find((outcome) => outcome.slot === "claude[0]")?.state,
      "native"
    );
    fs.writeFileSync(pending.replyPath, "valid answer");

    const third = await fanOut(
      {
        dir,
        slots: changed,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    const done = third.find((outcome) => outcome.slot === "claude[0]");
    assert.equal(done?.state, "done");
    assert.deepEqual(done.responder, {
      slot: "claude[0]",
      provider: "claude",
      model: "launch-model",
      native: true,
      effort: "high",
    });
  } finally {
    f.cleanup();
  }
});

test("cli wave mints a native descriptor for a host native-only reserve", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "codex", model: null };
    f.script("agy", "good", { status: "fail", cls: "auth", detail: "denied" });
    f.script("codex", "good", "codex cli answer");
    const dir = path.join(f.session, "wave-native-only-reserve");

    const reserve = {
      slot: "codex[0]",
      provider: "codex",
      index: 0,
      model: "good",
      reserve: true,
      native: true,
    };

    const slots = [slot("claude"), slot("agy"), reserve];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    assert.equal(
      first.find((outcome) => outcome.slot === "claude[0]")?.state,
      "native"
    );

    const waved = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    const substitute = waved.find((outcome) => outcome.slot === "agy[0]");
    assert.ok(substitute?.state === "native");
    assert.equal(substitute?.state, "native", JSON.stringify(waved));
    assert.equal(substitute.provider, "codex");
    assert.ok(substitute.attempt.startsWith("codex[0]#"));
    assert.equal(
      f.launches.filter((launch) => launch.provider === "codex").length,
      0,
      "no cli runs for the native-only reserve"
    );
    const mintedPrompt = fs.readFileSync(substitute.promptPath, "utf-8");
    assert.ok(
      mintedPrompt.includes(
        `Work in \`${substitute.cwd}\` for reads and Git commands.`
      ),
      "a reserve-minted native-only prompt names the working directory"
    );
  } finally {
    f.cleanup();
  }
});

test("launch applies a matching failure report to a saved native-only attempt", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "agy", model: null };
    // A native-only voice saved under the old host; the new host resumes with
    // a matching BLOCKED report for that attempt.
    const dir = path.join(f.session, "launch-native-only-report");
    fs.mkdirSync(path.join(dir, "slots"), { recursive: true });
    fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
    fs.mkdirSync(path.join(dir, "replies"), { recursive: true });
    fs.writeFileSync(path.join(dir, "prompts", "claude[0].md"), "question");
    const replyPath = path.join(dir, "replies", "claude[0].md");
    fs.writeFileSync(
      path.join(dir, "slots", "claude[0].json"),
      JSON.stringify({
        slot: "claude[0]",
        state: "native",
        promptPath: path.join(dir, "prompts", "claude[0].md"),
        replyPath,
        provider: "claude",
        attempt: "claude[0]#m1",
        cwd: f.session,
        model: "good",
      })
    );
    const only = { ...slot("claude"), native: true };
    const ignored: string[] = [];

    const outcomes = await fanOut(
      {
        dir,
        slots: [slot("agy"), only],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["agy"],
        nativeFailures: [
          {
            attempt: "claude[0]#m1",
            reason: "BLOCKED: host unavailable",
            reasonHash: "rh-only1",
          },
        ],
        onIgnoredReport: (attempt: string) => {
          ignored.push(attempt);
        },
      },
      f.deps
    );

    assert.deepEqual(
      ignored,
      [],
      "the matching report is consumed, not ignored"
    );
    const saved = outcomes.find((outcome) => outcome.slot === "claude[0]");
    assert.ok(saved?.state === "failed");
    assert.equal(saved?.state, "failed", JSON.stringify(outcomes));
    assert.equal(saved.cls, "blocked");
    assert.ok(
      (saved.blocked ?? []).some((entry) => entry.reasonHash === "rh-only1"),
      `blocked evidence is retained: ${JSON.stringify(saved.blocked)}`
    );
  } finally {
    f.cleanup();
  }
});

test("wave creates a newly eligible native-only target after a host and roster change", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("claude", "good", "claude cli answer");
    const dir = path.join(f.session, "wave-new-native-only");

    const first = await fanOut(
      {
        dir,
        slots: [slot("claude")],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    assert.equal(
      first.find((outcome) => outcome.slot === "claude[0]")?.state,
      "native"
    );
    // The session moves to a host whose native-only provider joins the roster
    // with no saved slot while the old native target is still pending.
    f.deps.orchestrator = { platform: "codex", model: null };
    const only = { ...slot("codex"), native: true };

    const waved = await fanOut(
      {
        dir,
        slots: [slot("claude"), only],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["codex"],
      },
      f.deps
    );

    const fresh = waved.find((outcome) => outcome.slot === "codex[0]");
    assert.ok(fresh?.state === "native");
    assert.equal(
      fresh?.state,
      "native",
      `the newly eligible native-only target gets a descriptor: ${JSON.stringify(
        waved.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    assert.equal(fresh.provider, "codex");

    // A later wave call settles the old target through its cli cascade.
    const settled = await fanOut(
      {
        dir,
        slots: [slot("claude"), only],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["codex"],
      },
      f.deps
    );

    assert.equal(
      settled.find((outcome) => outcome.slot === "claude[0]")?.state,
      "done"
    );
    assert.equal(
      settled.find((outcome) => outcome.slot === "codex[0]")?.state,
      "native"
    );
  } finally {
    f.cleanup();
  }
});

test("consume keeps a wave-created native-only reserve pending on blocked and invalid replies", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "codex", model: null };
    const dir = path.join(f.session, "consume-native-only-replies");
    fs.mkdirSync(path.join(dir, "slots"), { recursive: true });
    fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
    fs.mkdirSync(path.join(dir, "replies"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "fanout.json"),
      JSON.stringify({ nativeFirst: true, cliWaveDone: true })
    );
    fs.writeFileSync(path.join(dir, "prompts", "agy[0].md"), "question");
    const replyPath = path.join(dir, "replies", "agy[0].m1.md");
    // A native-only reserve substitute saved under a non-native logical slot,
    // as the wave mints it after a host change.
    fs.writeFileSync(
      path.join(dir, "slots", "agy[0].json"),
      JSON.stringify({
        slot: "agy[0]",
        state: "native",
        promptPath: path.join(dir, "prompts", "agy[0].native.md"),
        replyPath,
        provider: "codex",
        attempt: "codex[0]#m1",
        cwd: f.session,
        model: "good",
      })
    );

    const reserve = {
      slot: "codex[0]",
      provider: "codex",
      index: 0,
      model: "good",
      reserve: true,
      native: true,
    };

    const input = {
      dir,
      slots: [slot("agy"), reserve],
      prompt: "question",
      validate,
      quota,
      sessionRoot: f.session,
      nativeFirstProviders: ["claude"],
    } satisfies FanOutInput;

    fs.writeFileSync(replyPath, "BLOCKED: host cannot write");
    const blocked = await fanOut(input, f.deps);
    assert.equal(
      blocked.find((outcome) => outcome.slot === "agy[0]")?.state,
      "failed",
      `a blocked reply saves failed: ${JSON.stringify(blocked.map((outcome) => `${outcome.slot}:${outcome.state}`))}`
    );
    // Reset to the pending substitute so the invalid reply is consumed from a
    // native attempt, not from the failed save above.
    fs.writeFileSync(
      path.join(dir, "slots", "agy[0].json"),
      JSON.stringify({
        slot: "agy[0]",
        state: "native",
        promptPath: path.join(dir, "prompts", "agy[0].native.md"),
        replyPath,
        provider: "codex",
        attempt: "codex[0]#m1",
        cwd: f.session,
        model: "good",
      })
    );
    fs.writeFileSync(replyPath, "   ");
    const invalid = await fanOut(input, f.deps);
    assert.equal(
      invalid.find((outcome) => outcome.slot === "agy[0]")?.state,
      "native",
      `an invalid reply stays pending-native: ${JSON.stringify(
        invalid.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    assert.equal(
      f.launches.filter((launch) => launch.provider === "codex").length,
      0,
      "no cli runs for the native-only reserve"
    );
  } finally {
    f.cleanup();
  }
});

test("a reported native-first attempt defers to the cli fallback instead of failing", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("claude", "good", "cli answer");
    const dir = path.join(f.session, "wave-early-report");

    const first = await fanOut(
      {
        dir,
        slots: [slot("claude"), slot("agy")],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    const pending = first.find((outcome) => outcome.slot === "claude[0]");
    assert.ok(pending?.state === "native");
    // The host changes: agy becomes native-first with no saved slot while the
    // old claude attempt carries a matching BLOCKED report.
    f.deps.orchestrator = { platform: "agy", model: null };
    const ignored: string[] = [];
    const failed: string[] = [];

    const waved = await fanOut(
      {
        dir,
        slots: [slot("claude"), slot("agy")],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["agy"],
        nativeFailures: [
          {
            attempt: pending.attempt,
            reason: "BLOCKED: old host denied",
            reasonHash: "rh-early",
          },
        ],
        onIgnoredReport: (attempt: string) => {
          ignored.push(attempt);
        },
        // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
        onFailed: (slot: string) => {
          failed.push(slot);
        },
      },
      f.deps
    );

    assert.equal(
      f.launches.length,
      0,
      "no cli launches before the new descriptors return"
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, "fanout.json"), "utf-8"))
        // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
        .cliWaveDone,
      undefined,
      "the wave stays recoverable"
    );
    const fresh = waved.find((outcome) => outcome.slot === "agy[0]");
    assert.ok(fresh?.state === "native");
    assert.equal(
      fresh?.state,
      "native",
      "the new host voice is returned without waiting"
    );
    assert.ok(fresh.attempt.startsWith("agy[0]#"));
    assert.ok(
      !waved.some((outcome) => outcome.slot === "claude[0]"),
      `a reported attempt is deferred, never pending or failed: ${JSON.stringify(
        waved.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    assert.deepEqual(failed, [], "the deferred fallback marks no failure");

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, "slots", "claude[0].json"), "utf-8")
    );

    assert.equal(
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      saved.cliFallback,
      true,
      `the deferred fallback marker persists: ${JSON.stringify(saved)}`
    );
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(saved.nativeError, "BLOCKED: old host denied");
    assert.ok(
      hasBlockedReason(saved, "rh-early"),
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      `blocked evidence is retained: ${JSON.stringify(saved.blocked)}`
    );
    assert.deepEqual(
      ignored,
      [],
      "the matching report is consumed, not ignored"
    );

    // The next call runs the deferred fallback through the cli.
    const resumed = await fanOut(
      {
        dir,
        slots: [slot("claude"), slot("agy")],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["agy"],
      },
      f.deps
    );

    const done = resumed.find((outcome) => outcome.slot === "claude[0]");
    assert.equal(
      done?.state,
      "done",
      `the wave runs the deferred fallback: ${JSON.stringify(
        resumed.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    assert.equal(done.text, "cli answer");
    assert.ok(f.launches.some((launch) => launch.provider === "claude"));
  } finally {
    f.cleanup();
  }
});

test("early-wave blocked reports defer substitutes and fail native-only attempts without CLI", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("claude", "good", "substitute cli answer");
    const dir = path.join(f.session, "wave-early-substitute");
    fs.mkdirSync(path.join(dir, "slots"), { recursive: true });
    fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
    fs.mkdirSync(path.join(dir, "replies"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "fanout.json"),
      JSON.stringify({ nativeFirst: true })
    );
    fs.writeFileSync(path.join(dir, "prompts", "agy[0].md"), "question");
    const replyPath = path.join(dir, "replies", "agy[0].m1.md");
    fs.writeFileSync(
      path.join(dir, "slots", "agy[0].json"),
      JSON.stringify({
        slot: "agy[0]",
        state: "native",
        promptPath: path.join(dir, "prompts", "agy[0].native.md"),
        replyPath,
        provider: "claude",
        attempt: "claude[1]#m1",
        cwd: f.session,
        model: "good",
      })
    );

    const reserve = {
      slot: "claude[1]",
      provider: "claude",
      index: 1,
      model: "good",
      reserve: true,
      native: false,
    };

    // codex turns native-first with no saved slot while the agy substitute
    // carries a matching BLOCKED report.
    const failed: string[] = [];

    const waved = await fanOut(
      {
        dir,
        slots: [slot("agy"), slot("codex"), reserve],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["codex"],
        nativeFailures: [
          {
            attempt: "claude[1]#m1",
            reason: "BLOCKED: substitute host denied",
            reasonHash: "rh-sub",
          },
        ],
        // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
        onFailed: (slot: string) => {
          failed.push(slot);
        },
      },
      f.deps
    );

    assert.equal(
      f.launches.length,
      0,
      "no cli launches before the new descriptors return"
    );
    const fresh = waved.find((outcome) => outcome.slot === "codex[0]");
    assert.equal(fresh?.state, "native");
    assert.ok(
      !waved.some((outcome) => outcome.slot === "agy[0]"),
      `the substitute defers, never pending or failed: ${JSON.stringify(
        waved.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    assert.deepEqual(failed, [], "the deferred substitute marks no failure");

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, "slots", "agy[0].json"), "utf-8")
    );

    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(saved.cliFallback, true);
    assert.ok(
      hasBlockedReason(saved, "rh-sub"),
      "blocked evidence is retained"
    );

    const resumed = await fanOut(
      {
        dir,
        slots: [slot("agy"), slot("codex"), reserve],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["codex"],
      },
      f.deps
    );

    const done = resumed.find((outcome) => outcome.slot === "agy[0]");
    assert.equal(
      done?.state,
      "failed",
      "the host substitute saves failed without its CLI"
    );
    assert.equal(
      f.launches.filter((launch) => launch.provider === "claude").length,
      0,
      "no host CLI launches for the substitute"
    );
    f.deps.orchestrator = { platform: "codex", model: null };
    const onlyDir = path.join(f.session, "wave-early-native-only");
    fs.mkdirSync(path.join(onlyDir, "slots"), { recursive: true });
    fs.mkdirSync(path.join(onlyDir, "prompts"), { recursive: true });
    fs.mkdirSync(path.join(onlyDir, "replies"), { recursive: true });
    fs.writeFileSync(
      path.join(onlyDir, "fanout.json"),
      JSON.stringify({ nativeFirst: true })
    );
    fs.writeFileSync(path.join(onlyDir, "prompts", "agy[0].md"), "question");
    const onlyReply = path.join(onlyDir, "replies", "agy[0].m1.md");
    fs.writeFileSync(
      path.join(onlyDir, "slots", "agy[0].json"),
      JSON.stringify({
        slot: "agy[0]",
        state: "native",
        promptPath: path.join(onlyDir, "prompts", "agy[0].native.md"),
        replyPath: onlyReply,
        provider: "codex",
        attempt: "codex[1]#m1",
        cwd: f.session,
        model: "good",
      })
    );

    const onlyReserve = {
      slot: "codex[1]",
      provider: "codex",
      index: 1,
      model: "good",
      reserve: true,
      native: true,
    };

    const only = { ...slot("codex"), native: true };
    const onlyFailed: string[] = [];

    const onlyWaved = await fanOut(
      {
        dir: onlyDir,
        slots: [slot("agy"), only, onlyReserve],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: [],
        nativeFailures: [
          {
            attempt: "codex[1]#m1",
            reason: "BLOCKED: native host denied",
            reasonHash: "rh-only",
          },
        ],
        // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
        onFailed: (slot: string) => {
          onlyFailed.push(slot);
        },
      },
      f.deps
    );

    assert.equal(
      onlyWaved.find((outcome) => outcome.slot === "codex[0]")?.state,
      "native"
    );
    const onlyReported = onlyWaved.find((outcome) => outcome.slot === "agy[0]");
    assert.ok(onlyReported?.state === "failed");
    assert.equal(
      onlyReported?.state,
      "failed",
      `a native-only attempt keeps its failed save: ${JSON.stringify(
        onlyWaved.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    assert.equal(onlyReported.cls, "blocked");
    assert.ok(
      (onlyReported.blocked ?? []).some(
        (entry) => entry.reasonHash === "rh-only"
      )
    );
    assert.deepEqual(
      onlyFailed,
      ["agy[0]"],
      "the native-only failure still marks its slot"
    );
  } finally {
    f.cleanup();
  }
});

test("off-host retries keep the failed outcome without launching the wrong reserve", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "codex", model: null };
    f.script("agy", "good", { status: "fail", cls: "auth", detail: "denied" });
    const dir = path.join(f.session, "cli-only-offhost-reserve");

    // The first attempt fails with no reserve in the roster, so the failure
    // is a plain cli-only save with no native history.
    const first = await fanOut(
      {
        dir,
        slots: [slot("agy")],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: [],
      },
      f.deps
    );

    assert.equal(
      first.find((outcome) => outcome.slot === "agy[0]")?.state,
      "failed"
    );
    // The round is interrupted and resumes on another host whose roster adds a
    // native-only reserve for the old host. The retry fails again: the saved
    // old-host reserve must not launch off its host.
    f.deps.orchestrator = { platform: "claude", model: null };

    const reserve = {
      slot: "codex[0]",
      provider: "codex",
      index: 0,
      model: "good",
      reserve: true,
      native: true,
    };

    const second = await fanOut(
      {
        dir,
        slots: [slot("agy"), reserve],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: [],
      },
      f.deps
    );

    const retried = second.find((outcome) => outcome.slot === "agy[0]");
    assert.equal(
      retried?.state,
      "failed",
      `the off-host reserve keeps the failed outcome: ${JSON.stringify(
        second.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    assert.equal(
      f.launches.filter((launch) => launch.provider === "codex").length,
      0,
      "no cli runs for the off-host native-only reserve"
    );
    const g = sessionFixture({ memory: true });

    try {
      g.deps.orchestrator = { platform: "codex", model: null };
      g.script("agy", "good", {
        status: "fail",
        cls: "auth",
        detail: "denied",
      });
      const gdir = path.join(g.session, "missing-physical-fail-closed");

      const gslots = [
        slot("agy"),
        { ...slot("codex"), reserve: true, native: true },
      ];

      const gfirst = await fanOut(
        {
          dir: gdir,
          slots: gslots,
          prompt: "question",
          validate,
          quota,
          sessionRoot: g.session,
          nativeFirstProviders: [],
        },
        g.deps
      );

      const gpending = gfirst.find((outcome) => outcome.slot === "agy[0]");
      assert.ok(gpending?.state === "native");
      assert.ok(gpending.attempt.startsWith("codex[0]#"));
      g.deps.orchestrator = { platform: "opencode", model: null };
      g.launches.length = 0;

      const gsecond = await fanOut(
        {
          dir: gdir,
          slots: [slot("agy")],
          prompt: "question",
          validate,
          quota,
          sessionRoot: g.session,
          nativeFirstProviders: ["opencode"],
        },
        g.deps
      );

      const gfailed = gsecond.find((outcome) => outcome.slot === "agy[0]");
      assert.equal(
        gfailed?.state,
        "failed",
        `the missing physical saves failed: ${JSON.stringify(
          gsecond.map((outcome) => `${outcome.slot}:${outcome.state}`)
        )}`
      );
      assert.equal(g.launches.length, 0, "no cli runs under the wrong voice");
      assert.ok(!("attempt" in gfailed), "no fresh descriptor minted");
    } finally {
      g.cleanup();
    }
  } finally {
    f.cleanup();
  }
});

test("wave early return omits a saved fallback marker and resumes it next call", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "agy", model: null };
    f.script("claude", "good", "cli answer");
    const dir = path.join(f.session, "wave-early-marker");
    fs.mkdirSync(path.join(dir, "slots"), { recursive: true });
    fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
    fs.mkdirSync(path.join(dir, "replies"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "fanout.json"),
      JSON.stringify({ nativeFirst: true })
    );
    fs.writeFileSync(path.join(dir, "prompts", "agy[0].md"), "question");
    const replyPath = path.join(dir, "replies", "claude[0].m1.md");
    // An interrupted fallback marker saved before this call; the host change
    // makes agy newly native-first with no saved slot.
    fs.writeFileSync(
      path.join(dir, "slots", "claude[0].json"),
      JSON.stringify({
        slot: "claude[0]",
        state: "native",
        promptPath: path.join(dir, "prompts", "claude[0].native.md"),
        replyPath,
        provider: "claude",
        attempt: "claude[0]#m1",
        cwd: f.session,
        model: "good",
        cliFallback: true,
        nativeError: "stopped mid fallback",
      })
    );

    const waved = await fanOut(
      {
        dir,
        slots: [slot("claude"), slot("agy")],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["agy"],
      },
      f.deps
    );

    const fresh = waved.find((outcome) => outcome.slot === "agy[0]");
    assert.ok(fresh?.state === "native");
    assert.equal(
      fresh?.state,
      "native",
      `the newly eligible native target returns first: ${JSON.stringify(
        waved.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    assert.ok(
      !waved.some((outcome) => outcome.slot === "claude[0]"),
      `an interrupted marker never returns as pending: ${JSON.stringify(
        waved.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const kept = JSON.parse(
      fs.readFileSync(path.join(dir, "slots", "claude[0].json"), "utf-8")
    );

    assert.equal(
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      kept.cliFallback,
      true,
      `the marker stays saved for the wave: ${JSON.stringify(kept)}`
    );

    const settled = await fanOut(
      {
        dir,
        slots: [slot("claude"), slot("agy")],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["agy"],
      },
      f.deps
    );

    assert.equal(
      settled.find((outcome) => outcome.slot === "claude[0]")?.state,
      "done",
      `the wave resumes the marker through the cli: ${JSON.stringify(
        settled.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    assert.equal(
      settled.find((outcome) => outcome.slot === "agy[0]")?.state,
      "native"
    );
  } finally {
    f.cleanup();
  }
});

test("deferred fallback persists its marker before quarantining the reply", async (t) => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("claude", "good", "cli answer");
    const dir = path.join(f.session, "defer-marker-order");

    const first = await fanOut(
      {
        dir,
        slots: [slot("claude"), slot("agy")],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    const pending = first.find((outcome) => outcome.slot === "claude[0]");
    assert.ok(pending?.state === "native");
    fs.writeFileSync(pending.replyPath, "partial answer");
    // Crash between the two durable operations: the marker write must already
    // persist when quarantining the reply fails.
    f.deps.orchestrator = { platform: "agy", model: null };
    const realRename = fs.renameSync;
    let renames = 0;

    const rename = t.mock.method(
      fs,
      "renameSync",
      (...args: Parameters<typeof realRename>) => {
        renames += 1;

        if (renames >= 3) {
          throw new Error("crash before quarantine");
        }

        realRename(...args);
      }
    );

    const copy = t.mock.method(fs, "copyFileSync", () => {
      throw new Error("crash before quarantine");
    });

    const input = {
      dir,
      slots: [slot("claude"), slot("agy")],
      prompt: "question",
      validate,
      quota,
      sessionRoot: f.session,
      nativeFirstProviders: ["agy"],
      nativeFailures: [
        {
          attempt: pending.attempt,
          reason: "BLOCKED: old host denied",
          reasonHash: "rh-order",
        },
      ],
    } satisfies FanOutInput;

    try {
      await assert.rejects(fanOut(input, f.deps), /crash before quarantine/u);
    } finally {
      copy.mock.restore();
      rename.mock.restore();
    }

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, "slots", "claude[0].json"), "utf-8")
    );

    assert.equal(
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      saved.cliFallback,
      true,
      `the marker persists before the quarantine: ${JSON.stringify(saved)}`
    );
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(saved.nativeError, "BLOCKED: old host denied");
    assert.ok(
      hasBlockedReason(saved, "rh-order"),
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      `the reported evidence persists: ${JSON.stringify(saved.blocked)}`
    );
    assert.ok(
      fs.existsSync(pending.replyPath),
      "the reply stays until the marker write survives"
    );

    const resumed = await fanOut(
      {
        dir,
        slots: [slot("claude"), slot("agy")],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["agy"],
      },
      f.deps
    );

    const done = resumed.find((outcome) => outcome.slot === "claude[0]");
    assert.ok(done?.state === "done");
    assert.equal(
      done?.state,
      "done",
      `the retry falls back with the reported reason: ${JSON.stringify(
        resumed.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    assert.equal(done.text, "cli answer");
    assert.ok(
      (done.blocked ?? []).some((entry) => entry.reasonHash === "rh-order"),
      "the retried fallback keeps the reported evidence"
    );
    assert.ok(
      fs.existsSync(`${pending.replyPath}.invalid-1`),
      "the retry quarantines the reply"
    );
  } finally {
    f.cleanup();
  }
});

test("a launch with no launchable native falls through to the cli wave in the same call", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("agy", "good", "cli answer");
    const dir = path.join(f.session, "launch-fallthrough");
    fs.mkdirSync(path.join(dir, "slots"), { recursive: true });
    fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
    fs.mkdirSync(path.join(dir, "replies"), { recursive: true });
    fs.writeFileSync(path.join(dir, "prompts", "claude[0].md"), "question");
    fs.writeFileSync(
      path.join(dir, "slots", "claude[0].json"),
      JSON.stringify({
        slot: "claude[0]",
        state: "done",
        text: "kept",
        responder: {
          slot: "claude[0]",
          provider: "claude",
          model: "good",
          native: false,
        },
      })
    );

    const outcomes = await fanOutComplete(
      {
        dir,
        slots: [slot("claude"), slot("agy")],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    assert.equal(
      outcomes.find((outcome) => outcome.slot === "claude[0]")?.state,
      "done"
    );
    assert.equal(
      outcomes.find((outcome) => outcome.slot === "agy[0]")?.state,
      "done",
      `the cli wave runs in the same call: ${JSON.stringify(
        outcomes.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    assert.ok(
      f.launches.some((launch) => launch.provider === "agy"),
      "the unsaved cli voice launches"
    );
  } finally {
    f.cleanup();
  }
});

test("a lowercase blocked report for a native-only reserve saves refusal without evidence", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "codex", model: null };
    f.script("agy", "good", { status: "fail", cls: "auth", detail: "denied" });
    const dir = path.join(f.session, "wave-native-only-lowercase");

    const reserve = {
      slot: "codex[0]",
      provider: "codex",
      index: 0,
      model: "good",
      reserve: true,
      native: true,
    };

    const slots = [slot("claude"), slot("agy"), reserve];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    assert.equal(
      first.find((outcome) => outcome.slot === "claude[0]")?.state,
      "native"
    );

    const waved = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    const substitute = waved.find((outcome) => outcome.slot === "agy[0]");
    assert.ok(substitute?.state === "native");
    assert.ok(substitute.attempt.startsWith("codex[0]#"));

    const reported = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
        nativeFailures: [
          {
            attempt: substitute.attempt,
            reason: "blocked: reserve denied",
            reasonHash: "rh-wave-lower",
          },
        ],
      },
      f.deps
    );

    const failed = reported.find((outcome) => outcome.slot === "agy[0]");
    assert.ok(failed?.state === "failed");
    assert.equal(
      failed.cls,
      "refusal",
      `a differently-cased prefix is not the BLOCKED protocol marker: ${JSON.stringify(failed)}`
    );
    assert.equal(
      failed.blocked,
      undefined,
      `no blocked evidence without the exact marker: ${JSON.stringify(failed)}`
    );
    assert.equal(
      failed.reason,
      "refusal: blocked: reserve denied",
      `the saved reason keeps the delegate wording: ${JSON.stringify(failed)}`
    );
    assert.ok(failed.reason.startsWith("refusal: "), JSON.stringify(failed));
    assert.equal(
      f.launches.filter((launch) => launch.provider === "codex").length,
      0,
      "no cli runs for the native-only reserve"
    );
  } finally {
    f.cleanup();
  }
});

test("a launchable native returns before the cli wave when a saved orphan waits", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("agy", "good", "cli answer");
    const dir = path.join(f.session, "complete-orphan-launchable");
    fs.mkdirSync(path.join(dir, "slots"), { recursive: true });
    fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
    fs.mkdirSync(path.join(dir, "replies"), { recursive: true });
    fs.writeFileSync(path.join(dir, "prompts", "codex[0].md"), "question");
    // A saved done orphan whose provider left the recomputed roster.
    fs.writeFileSync(
      path.join(dir, "slots", "codex[0].json"),
      JSON.stringify({
        slot: "codex[0]",
        state: "done",
        text: "kept",
        responder: {
          slot: "codex[0]",
          provider: "codex",
          model: "good",
          native: false,
        },
      })
    );

    const outcomes = await fanOutComplete(
      {
        dir,
        slots: [slot("claude"), slot("agy")],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    assert.equal(
      outcomes.find((outcome) => outcome.slot === "claude[0]")?.state,
      "native"
    );
    assert.ok(
      !outcomes.some((outcome) => outcome.slot === "agy[0]"),
      `the cli target waits for the next call: ${JSON.stringify(
        outcomes.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    assert.equal(
      f.launches.length,
      0,
      "no cli launches while a native is launchable"
    );
    assert.equal(fs.existsSync(path.join(dir, "fanout.json")), true);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, "fanout.json"), "utf-8"))
        // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
        .cliWaveDone,
      undefined,
      "the wave stays recoverable"
    );
  } finally {
    f.cleanup();
  }
});

test("a last-pending retry carries saved blocked evidence into the reserve descriptor", async (t) => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("agy", "good", { status: "fail", cls: "auth", detail: "denied" });
    const dir = path.join(f.session, "retry-prior-blocked");

    const reserve = {
      slot: "claude[1]",
      provider: "claude",
      index: 1,
      model: "good",
      reserve: true,
      native: false,
    };

    const slots = [slot("claude"), slot("agy"), reserve];
    fs.mkdirSync(path.join(dir, "slots"), { recursive: true });
    fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
    fs.mkdirSync(path.join(dir, "replies"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "fanout.json"),
      JSON.stringify({ nativeFirst: true, cliWaveDone: true })
    );
    const replyPath = path.join(dir, "replies", "claude[0].r1.md");
    fs.writeFileSync(
      path.join(dir, "slots", "claude[0].json"),
      JSON.stringify({
        slot: "claude[0]",
        state: "native",
        promptPath: path.join(dir, "prompts", "claude[0].native.md"),
        replyPath,
        provider: "claude",
        attempt: "claude[0]#r1",
        cwd: f.session,
        model: "good",
      })
    );
    fs.writeFileSync(replyPath, "native answer");
    fs.writeFileSync(
      path.join(dir, "slots", "agy[0].json"),
      JSON.stringify({
        slot: "agy[0]",
        state: "failed",
        cls: "auth",
        reason: "denied",
        blocked: [
          {
            provider: "agy",
            model: "good",
            reason: "earlier refusal",
            reasonHash: "rh-prior",
          },
        ],
      })
    );
    // Capture the slot file at every atomic write: the first agy write is
    // the reserve descriptor itself, before any later merge could persist.
    const realRename = fs.renameSync;
    const writes: string[] = [];

    const rename = t.mock.method(
      fs,
      "renameSync",
      (source: fs.PathLike, destination: fs.PathLike) => {
        if (String(destination).endsWith("agy[0].json")) {
          try {
            writes.push(fs.readFileSync(source, "utf-8"));
          } catch {
            // No persisted bytes to capture when the temp file is already gone.
            // rename probe target absent on this branch; ignore and continue
          }
        }

        realRename(source, destination);
      }
    );

    try {
      const outcomes = await fanOut(
        {
          dir,
          slots,
          prompt: "question",
          validate,
          quota,
          sessionRoot: f.session,
          nativeFirstProviders: ["claude"],
        },
        f.deps
      );

      assert.equal(
        outcomes.find((outcome) => outcome.slot === "agy[0]")?.state,
        "native"
      );
    } finally {
      rename.mock.restore();
    }

    assert.ok(writes.length >= 1, "the retry persists the reserve descriptor");
    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const descriptor = JSON.parse(defined(writes[0]));
    assert.ok(
      hasBlockedReason(descriptor, "rh-prior"),
      `the persisted descriptor keeps earlier blocked evidence: ${writes[0]}`
    );
  } finally {
    f.cleanup();
  }
});

test("off-host native-only reserve stops routing in cli-only and wave paths", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("agy", "good", { status: "fail", cls: "auth", detail: "denied" });
    f.script("codex", "good", "reserve cli answer");
    const events: DiagnosticEvent[] = [];
    f.deps.diagnostics = (event) => {
      events.push(event);
    };

    const reserve = {
      slot: "codex[0]",
      provider: "codex",
      index: 0,
      model: "good",
      reserve: true,
      native: true,
    };

    const cliOnly = await fanOut(
      {
        dir: path.join(f.session, "cli-only-offhost-reserve-routing"),
        slots: [slot("agy"), reserve],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: [],
      },
      f.deps
    );

    const cliRetried = cliOnly.find((outcome) => outcome.slot === "agy[0]");
    assert.equal(
      cliRetried?.state,
      "failed",
      `the off-host reserve keeps the failed outcome: ${JSON.stringify(
        cliOnly.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    assert.equal(
      f.launches.filter((launch) => launch.provider === "codex").length,
      0,
      "no cli runs for the off-host native-only reserve"
    );
    assert.ok(
      !events.some(
        (event) =>
          event.kind === "routing" &&
          event.state === "reserve" &&
          event.slot === "agy[0]"
      ),
      `an off-host reserve emits no reserve routing: ${JSON.stringify(
        events.filter((event) => event.kind === "routing")
      )}`
    );
    events.length = 0;
    f.launches.length = 0;
    const dir = path.join(f.session, "wave-offhost-reserve-routing");
    const slots = [slot("claude"), slot("agy"), reserve];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    assert.equal(
      first.find((outcome) => outcome.slot === "claude[0]")?.state,
      "native"
    );

    const waved = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    const retried = waved.find((outcome) => outcome.slot === "agy[0]");
    assert.equal(
      retried?.state,
      "failed",
      `the off-host reserve keeps the failed outcome: ${JSON.stringify(
        waved.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    assert.equal(
      f.launches.filter((launch) => launch.provider === "codex").length,
      0,
      "no cli runs for the off-host native-only reserve"
    );
    assert.ok(
      !events.some(
        (event) =>
          event.kind === "routing" &&
          event.state === "reserve" &&
          event.slot === "agy[0]"
      ),
      `an off-host reserve emits no reserve routing: ${JSON.stringify(
        events.filter((event) => event.kind === "routing")
      )}`
    );
  } finally {
    f.cleanup();
  }
});

test("deferred ignores wait for reconciled orphans before reaching the callback", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("agy", "good", "cli answer");
    const dir = path.join(f.session, "complete-defer-ignored");
    fs.mkdirSync(path.join(dir, "slots"), { recursive: true });
    fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
    fs.mkdirSync(path.join(dir, "replies"), { recursive: true });
    fs.writeFileSync(path.join(dir, "prompts", "claude[0].md"), "question");
    const orphanReply = path.join(dir, "replies", "agy[0].orphan.md");
    fs.writeFileSync(
      path.join(dir, "slots", "agy[0].json"),
      JSON.stringify({
        slot: "agy[0]",
        state: "native",
        promptPath: path.join(dir, "prompts", "agy[0].native.md"),
        replyPath: orphanReply,
        provider: "agy",
        attempt: "agy[0]#orphan1",
        cwd: f.session,
        model: "good",
      })
    );
    const ignored: string[] = [];

    const input = {
      dir,
      slots: [slot("claude")],
      prompt: "question",
      validate,
      quota,
      sessionRoot: f.session,
      nativeFirstProviders: ["claude"],
      nativeFailures: [
        {
          attempt: "agy[0]#orphan1",
          reason: "BLOCKED: gone",
          reasonHash: "rh-orphan",
        },
      ],
      onIgnoredReport: (attempt: string) => {
        ignored.push(attempt);
      },
    };

    const first = await fanOutComplete(input, f.deps);
    assert.ok(
      first.some(
        (outcome) => outcome.slot === "claude[0]" && outcome.state === "native"
      ),
      `the launchable native returns: ${JSON.stringify(first.map((outcome) => `${outcome.slot}:${outcome.state}`))}`
    );
    assert.ok(
      !first.some((outcome) => outcome.slot === "agy[0]"),
      `the orphan waits for the next call: ${JSON.stringify(
        first.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    assert.equal(
      f.launches.length,
      0,
      "no cli launches while a native is launchable"
    );
    assert.deepEqual(
      ignored,
      [],
      "the orphan report defers instead of reaching the callback"
    );

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const marked = JSON.parse(
      fs.readFileSync(path.join(dir, "slots", "agy[0].json"), "utf-8")
    );

    assert.equal(
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      marked.cliFallback,
      true,
      `the orphan failure persists its fallback marker: ${JSON.stringify(marked)}`
    );
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(marked.nativeError, "BLOCKED: gone");
    assert.ok(
      hasBlockedReason(marked, "rh-orphan"),
      // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      `the marker keeps the reported evidence: ${JSON.stringify(marked.blocked)}`
    );
    // A partial native reply present during the deferred wave call stays unread.
    const pending = first.find((outcome) => outcome.slot === "claude[0]");
    assert.ok(pending?.state === "native");
    fs.writeFileSync(pending.replyPath, "partial answer");
    f.launches.length = 0;

    const second = await fanOutComplete(
      { ...input, nativeFailures: [] },
      f.deps
    );

    assert.equal(
      second.find((outcome) => outcome.slot === "claude[0]")?.state,
      "native",
      `the wave never consumes a partial reply: ${JSON.stringify(
        second.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    const run = second.find((outcome) => outcome.slot === "agy[0]");
    assert.ok(run?.state === "done");
    assert.equal(
      run?.state,
      "done",
      `the marked fallback runs its cli cascade in the wave: ${JSON.stringify(
        second.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    assert.equal(run.text, "cli answer");
    assert.ok(
      (run.blocked ?? []).some((entry) => entry.reasonHash === "rh-orphan"),
      `the marker keeps its reported evidence: ${JSON.stringify(run.blocked)}`
    );
    assert.ok(
      f.launches.some((launch) => launch.provider === "agy"),
      "the marked fallback launches its cli while a native stays pending"
    );
    assert.ok(
      !f.launches.some((launch) => launch.provider === "claude"),
      "no cli launches for the still-pending native"
    );
    assert.equal(
      fs.readFileSync(pending.replyPath, "utf-8"),
      "partial answer",
      "the partial reply stays unread"
    );
    assert.ok(
      !fs.existsSync(`${pending.replyPath}.invalid-1`),
      "the partial reply is never quarantined by the wave"
    );
    assert.deepEqual(
      ignored,
      [],
      "the consumed report never reaches the callback"
    );
    // Once the native answer lands, the next call consumes it and reconciles
    // the marked orphan through the deferred cascade with its evidence.
    fs.writeFileSync(pending.replyPath, "native answer");

    const third = await fanOutComplete(
      { ...input, nativeFailures: [] },
      f.deps
    );

    assert.equal(
      third.find((outcome) => outcome.slot === "claude[0]")?.state,
      "done"
    );
    const reconciled = third.find((outcome) => outcome.slot === "agy[0]");
    assert.ok(reconciled?.state === "done");
    assert.equal(
      reconciled?.state,
      "done",
      `the orphan reconciles once the native settles: ${JSON.stringify(
        third.map((outcome) => `${outcome.slot}:${outcome.state}`)
      )}`
    );
    assert.equal(reconciled.text, "cli answer");
    assert.ok(
      (reconciled.blocked ?? []).some(
        (entry) => entry.reasonHash === "rh-orphan"
      ),
      `the reported evidence survives the deferred cascade: ${JSON.stringify(reconciled.blocked)}`
    );
    assert.deepEqual(
      ignored,
      [],
      "the consumed report never reaches the callback"
    );
  } finally {
    f.cleanup();
  }
});

test("a launchable native returns first and defers unrelated orphans while forwarding stale reports", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("agy", "good", "cli answer");
    const dir = path.join(f.session, "complete-stale-report");

    for (const sub of ["slots", "prompts", "replies"]) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
    }

    fs.writeFileSync(
      path.join(dir, "slots", "agy[0].json"),
      JSON.stringify({
        slot: "agy[0]",
        state: "native",
        promptPath: path.join(dir, "prompts", "agy[0].native.md"),
        replyPath: path.join(dir, "replies", "agy[0].unrelated.md"),
        provider: "agy",
        attempt: "agy[0]#unrelated",
        cwd: f.session,
        model: "good",
      })
    );
    const ignored: string[] = [];

    const input = {
      dir,
      slots: [slot("claude")],
      prompt: "question",
      validate,
      quota,
      sessionRoot: f.session,
      nativeFirstProviders: ["claude"],
      nativeFailures: [
        {
          attempt: "codex[0]#stale",
          reason: "BLOCKED: gone",
          reasonHash: "rh-stale",
        },
      ],
      onIgnoredReport: (attempt: string) => {
        ignored.push(attempt);
      },
    };

    const first = await fanOutComplete(input, f.deps);
    assert.ok(
      first.some(
        (outcome) => outcome.slot === "claude[0]" && outcome.state === "native"
      ),
      `the launchable native returns: ${JSON.stringify(first.map((outcome) => `${outcome.slot}:${outcome.state}`))}`
    );
    assert.equal(
      f.launches.length,
      0,
      "no cli launch on the call that returns a launchable native"
    );
    assert.ok(
      !first.some((outcome) => outcome.slot === "agy[0]"),
      "the unrelated orphan waits for the next call"
    );
    assert.deepEqual(
      ignored,
      ["codex[0]#stale"],
      "the stale report reaches the callback on the returning call"
    );
  } finally {
    f.cleanup();
  }
});

test("host voice launches native for every nativeSubagentsOnly value", async () => {
  for (const only of [true, false, undefined] as const) {
    const delegate = {
      targets: [{ low: { model: "m" } }],
      ...(only !== undefined && { nativeSubagentsOnly: only }),
    };

    const roster = resolveRoster({
      level: "low",
      readDelegates: {
        claude: delegate,
        agy: { targets: [{ low: { model: "a" } }] },
      },
      policy: { rounds: { low: 1 }, targets: { low: 2 } },
      orchestrator: { platform: "claude" },
      liveness: { claude: false, agy: true },
    });

    const hasHost =
      roster.targets.some((item) => item.provider === "claude") ||
      roster.reserves.some((item) => item.provider === "claude");

    assert.ok(
      hasHost,
      `roster keeps host for only=${String(only)}: ${JSON.stringify(roster)}`
    );
    const f = sessionFixture({ memory: true });

    try {
      f.deps.orchestrator = { platform: "claude", model: null };
      const dir = path.join(f.session, `host-native-${String(only)}`);

      const slotDef =
        only === true ? slot("claude", "good", false, true) : slot("claude");

      const nativeFirst = only === true ? [] : ["claude"];

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const outcomes = await fanOut(
        {
          dir,
          slots: [slotDef],
          prompt: "question",
          validate,
          quota,
          sessionRoot: f.session,
          nativeFirstProviders: nativeFirst,
        },
        f.deps
      );

      assert.equal(
        outcomes[0]?.state,
        "native",
        `native descriptor for only=${String(only)}`
      );
      assert.equal(f.launches.length, 0, `no CLI for only=${String(only)}`);
    } finally {
      f.cleanup();
    }
  }
});

test("host native failure routes by reserve presence without host CLI", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("copilot", "good", "reserve answer");
    const dir = path.join(f.session, "host-failure-reserve");
    const slots = [slot("claude"), { ...slot("copilot"), reserve: true }];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    const pending = first.find((outcome) => outcome.slot === "claude[0]");
    assert.ok(pending?.state === "native");

    const second = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
        nativeFailures: [
          { attempt: pending.attempt, reason: "launch gone", reasonHash: "h1" },
        ],
      },
      f.deps
    );

    const outcome = second.find((entry) => entry.slot === "claude[0]");
    assert.equal(
      outcome?.state,
      "done",
      `reserve CLI: ${JSON.stringify(second.map((entry) => `${entry.slot}:${entry.state}`))}`
    );
    assert.equal(
      outcome.text,
      "reserve answer",
      `reserve answer: ${JSON.stringify(outcome)}`
    );
    assert.equal(
      outcome.responder?.provider,
      "copilot",
      `reserve provider: ${JSON.stringify(outcome)}`
    );
    assert.equal(
      f.launches.filter((launch) => launch.provider === "claude").length,
      0,
      "no host CLI"
    );
    const aloneDir = path.join(f.session, "host-failure-noreserve");

    const aloneFirst = await fanOut(
      {
        dir: aloneDir,
        slots: [slot("claude")],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
      },
      f.deps
    );

    const alonePending = aloneFirst.find(
      // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
      (outcome) => outcome.slot === "claude[0]"
    );

    assert.ok(alonePending?.state === "native");

    const aloneSecond = await fanOut(
      {
        dir: aloneDir,
        slots: [slot("claude")],
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["claude"],
        nativeFailures: [
          {
            attempt: alonePending.attempt,
            reason: "launch gone",
            reasonHash: "h2",
          },
        ],
      },
      f.deps
    );

    assert.equal(
      aloneSecond.find((entry) => entry.slot === "claude[0]")?.state,
      "failed",
      "no reserve saves failed"
    );
    assert.equal(
      f.launches.filter((launch) => launch.provider === "claude").length,
      0,
      "no host CLI"
    );
  } finally {
    f.cleanup();
  }

  // a native-only report or reply routes by reserve presence
  {
    // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
    const f = sessionFixture({ memory: true });

    try {
      f.deps.orchestrator = { platform: "codex", model: null };
      f.script("copilot", "good", "reserve answer");
      const only = { ...slot("codex"), native: true };
      const reserve = { ...slot("copilot"), reserve: true };

      const first = await fanOut(
        {
          dir: path.join(f.session, "host-nativeonly-blocked-reserve"),
          slots: [only, reserve],
          prompt: "question",
          validate,
          quota,
          sessionRoot: f.session,
          nativeFirstProviders: [],
        },
        f.deps
      );

      const blockedPending = first.find(
        (outcome) => outcome.slot === "codex[0]"
      );

      assert.ok(blockedPending?.state === "native");
      fs.writeFileSync(blockedPending.replyPath, "BLOCKED: host cannot write");

      const blockedDir = path.join(
        f.session,
        "host-nativeonly-blocked-reserve"
      );

      const blockedOutcomes = await fanOut(
        {
          dir: blockedDir,
          slots: [only, reserve],
          prompt: "question",
          validate,
          quota,
          sessionRoot: f.session,
          nativeFirstProviders: [],
        },
        f.deps
      );

      const blockedOutcome = blockedOutcomes.find(
        (entry) => entry.slot === "codex[0]"
      );

      assert.equal(
        blockedOutcome?.state,
        "done",
        `reserve takes over BLOCKED: ${JSON.stringify(blockedOutcome)}`
      );
      assert.equal(blockedOutcome.text, "reserve answer");
      assert.equal(
        f.launches.filter((launch) => launch.provider === "codex").length,
        0,
        "no host CLI"
      );
      const reportDir = path.join(f.session, "host-nativeonly-report-reserve");

      const reportFirst = await fanOut(
        {
          dir: reportDir,
          slots: [only, reserve],
          prompt: "question",
          validate,
          quota,
          sessionRoot: f.session,
          nativeFirstProviders: [],
        },
        f.deps
      );

      const reportPending = reportFirst.find(
        (outcome) => outcome.slot === "codex[0]"
      );

      assert.ok(reportPending?.state === "native");

      const second = await fanOut(
        {
          dir: reportDir,
          slots: [only, reserve],
          prompt: "question",
          validate,
          quota,
          sessionRoot: f.session,
          nativeFirstProviders: [],
          nativeFailures: [
            {
              attempt: reportPending.attempt,
              reason: "BLOCKED: denied",
              reasonHash: "rh1",
            },
          ],
        },
        f.deps
      );

      const outcome = second.find((entry) => entry.slot === "codex[0]");
      assert.ok(
        outcome?.state === "native" || outcome?.state === "done",
        `reserve or done: ${JSON.stringify(outcome)}`
      );
      assert.equal(
        f.launches.filter((launch) => launch.provider === "codex").length,
        0,
        "no host CLI"
      );

      const aloneDir = path.join(
        f.session,
        "host-nativeonly-blocked-noreserve"
      );

      fs.mkdirSync(path.join(aloneDir, "slots"), { recursive: true });
      fs.mkdirSync(path.join(aloneDir, "prompts"), { recursive: true });
      fs.mkdirSync(path.join(aloneDir, "replies"), { recursive: true });
      fs.writeFileSync(
        path.join(aloneDir, "fanout.json"),
        JSON.stringify({ nativeFirst: true, cliWaveDone: true })
      );
      fs.writeFileSync(path.join(aloneDir, "prompts", "agy[0].md"), "question");
      const aloneReply = path.join(aloneDir, "replies", "agy[0].m1.md");
      fs.writeFileSync(
        path.join(aloneDir, "slots", "agy[0].json"),
        JSON.stringify({
          slot: "agy[0]",
          state: "native",
          promptPath: path.join(aloneDir, "prompts", "agy[0].native.md"),
          replyPath: aloneReply,
          provider: "codex",
          attempt: "codex[0]#m1",
          cwd: f.session,
          model: "good",
        })
      );
      fs.writeFileSync(aloneReply, "BLOCKED: host cannot write");

      const aloneOutcomes = await fanOut(
        {
          dir: aloneDir,
          slots: [slot("agy")],
          prompt: "question",
          validate,
          quota,
          sessionRoot: f.session,
          nativeFirstProviders: ["claude"],
        },
        f.deps
      );

      assert.equal(
        aloneOutcomes.find((entry) => entry.slot === "agy[0]")?.state,
        "failed",
        "no reserve saves failed"
      );
      assert.equal(
        f.launches.filter((launch) => launch.provider === "codex").length,
        0,
        "no host CLI"
      );
    } finally {
      f.cleanup();
    }
  }

  // a saved failure retakes without host CLI
  {
    // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
    const f = sessionFixture({ memory: true });

    try {
      f.deps.orchestrator = { platform: "claude", model: null };
      const dir = path.join(f.session, "host-saved-failed-retake");
      const slots = [slot("claude")];

      const first = await fanOut(
        {
          dir,
          slots,
          prompt: "question",
          validate,
          quota,
          sessionRoot: f.session,
          nativeFirstProviders: ["claude"],
        },
        f.deps
      );

      const pending = first.find((outcome) => outcome.slot === "claude[0]");
      assert.ok(pending?.state === "native");

      const second = await fanOut(
        {
          dir,
          slots,
          prompt: "question",
          validate,
          quota,
          sessionRoot: f.session,
          nativeFirstProviders: ["claude"],
          nativeFailures: [
            {
              attempt: pending.attempt,
              reason: "launch gone",
              reasonHash: "h3",
            },
          ],
        },
        f.deps
      );

      assert.equal(
        second.find((entry) => entry.slot === "claude[0]")?.state,
        "failed"
      );
      f.launches.length = 0;
      f.script("claude", "good", "should not run");

      const third = await fanOut(
        {
          dir,
          slots,
          prompt: "question",
          validate,
          quota,
          sessionRoot: f.session,
          nativeFirstProviders: ["claude"],
        },
        f.deps
      );

      assert.equal(
        third.find((entry) => entry.slot === "claude[0]")?.state,
        "failed"
      );
      assert.equal(
        f.launches.filter((launch) => launch.provider === "claude").length,
        0,
        "no host CLI on retake"
      );
    } finally {
      f.cleanup();
    }
  }

  // a saved CLI failure mints a fresh native attempt after the host change
  {
    // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
    const f = sessionFixture({ memory: true });

    try {
      f.script("claude", "good", {
        status: "fail",
        cls: "auth",
        detail: "denied",
      });
      const dir = path.join(f.session, "host-cli-saved-hostchange");

      const first = await fanOut(
        {
          dir,
          slots: [slot("claude")],
          prompt: "question",
          validate,
          quota,
          sessionRoot: f.session,
          nativeFirstProviders: [],
        },
        f.deps
      );

      assert.equal(
        first.find((outcome) => outcome.slot === "claude[0]")?.state,
        "failed"
      );
      f.deps.orchestrator = { platform: "claude", model: null };
      f.launches.length = 0;
      f.script("claude", "good", "should not run");
      f.script("agy", "good", "reserve answer");
      const reserve = { ...slot("agy"), reserve: true };

      const second = await fanOut(
        {
          dir,
          slots: [slot("claude"), reserve],
          prompt: "question",
          validate,
          quota,
          sessionRoot: f.session,
          nativeFirstProviders: ["claude"],
        },
        f.deps
      );

      const outcome = second.find((entry) => entry.slot === "claude[0]");
      assert.equal(
        outcome?.state,
        "native",
        `saved CLI failure mints a fresh host native attempt: ${JSON.stringify(outcome)}`
      );
      assert.equal(
        f.launches.filter((launch) => launch.provider === "claude").length,
        0,
        "no host CLI after host change"
      );
    } finally {
      f.cleanup();
    }
  }
});

test("off-host saved native attempt keeps CLI cascade", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    const dir = path.join(f.session, "offhost-keeps-cli");
    const slots = [slot("agy")];

    const first = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["agy"],
      },
      f.deps
    );

    const pending = first.find((outcome) => outcome.slot === "agy[0]");
    assert.ok(pending?.state === "native");
    f.deps.orchestrator = { platform: "opencode", model: null };
    f.launches.length = 0;
    f.script("agy", "good", "cli answer after host change");

    const second = await fanOut(
      {
        dir,
        slots,
        prompt: "question",
        validate,
        quota,
        sessionRoot: f.session,
        nativeFirstProviders: ["agy"],
        nativeFailures: [
          { attempt: pending.attempt, reason: "launch gone", reasonHash: "h1" },
        ],
      },
      f.deps
    );

    const outcome = second.find((entry) => entry.slot === "agy[0]");
    assert.equal(
      outcome?.state,
      "done",
      `CLI cascade kept off host: ${JSON.stringify(outcome)}`
    );
    assert.equal(outcome.text, "cli answer after host change");
    assert.deepEqual(
      f.launches.map((launch) => launch.provider),
      ["agy"],
      "off-host CLI runs"
    );
  } finally {
    f.cleanup();
  }
});

test("native descriptors carry host-specific launchAs lines and normalize legacy saved outcomes", async () => {
  // Native-only descriptor with effort carries opencode launchAs and no subagentModels.
  {
    const f = sessionFixture({ memory: true });

    try {
      f.deps.orchestrator = { platform: "opencode", model: null };
      const dir = path.join(f.session, "native-only-effort");

      const slots = [
        {
          slot: "opencode[0]",
          provider: "opencode",
          index: 0,
          model: "prov/model",
          effort: "my-eff",
          native: true,
          reserve: false,
        },
      ];

      const first = await fanOut(
        { dir, slots, prompt: "question", validate, quota },
        f.deps
      );

      const native = nativeOf(
        first.find((outcome) => outcome.slot === "opencode[0]")
      );

      assert.equal(native.state, "native");
      assert.equal(native.model, "prov/model");
      assert.equal(native.effort, "my-eff");
      assert.equal(
        native.launchAs,
        'launch: `subagent` with `model: "prov/model#my-eff"` (user-configured; set it despite the tool\'s default guidance)'
      );
      assert.equal("subagentModels" in native, false);
    } finally {
      f.cleanup();
    }
  }

  // Native-only descriptor without effort carries plain fallback models, and agy carries its Model instruction.
  {
    const f = sessionFixture({ memory: true });

    try {
      f.deps.orchestrator = { platform: "opencode", model: null };
      const dir = path.join(f.session, "native-only-plain");

      const slots = [
        {
          slot: "opencode[0]",
          provider: "opencode",
          index: 0,
          model: ["a", "b"],
          native: true,
          reserve: false,
        },
      ];

      const first = await fanOut(
        { dir, slots, prompt: "question", validate, quota },
        f.deps
      );

      const native = nativeOf(
        first.find((outcome) => outcome.slot === "opencode[0]")
      );

      assert.equal(
        native.launchAs,
        'launch: `subagent` with `model: "a"` (user-configured; set it despite the tool\'s default guidance), else "b"'
      );
      assert.equal("subagentModels" in native, false);
      const g = sessionFixture({ memory: true });

      try {
        const adir = path.join(g.session, "native-only-agy");

        const aslots = [
          {
            slot: "agy[0]",
            provider: "agy",
            index: 0,
            model: "gemini-4-hydrogen",
            effort: "high",
            native: true,
            reserve: false,
          },
        ];

        const aout = await fanOut(
          { dir: adir, slots: aslots, prompt: "question", validate, quota },
          g.deps
        );

        const agyNative = nativeOf(
          aout.find((outcome) => outcome.slot === "agy[0]")
        );

        assert.equal(
          agyNative.launchAs,
          "launch: closest `Model` (`inherit`, `flash_lite`, `flash`, `pro`) to gemini-4-hydrogen, effort high"
        );
        assert.equal("subagentModels" in agyNative, false);
      } finally {
        g.cleanup();
      }
    } finally {
      f.cleanup();
    }
  }

  // Native-first descriptor shares the same launch fields.
  {
    const f = sessionFixture({ memory: true });

    try {
      f.deps.orchestrator = { platform: "opencode", model: null };
      const dir = path.join(f.session, "native-first-value");

      const slots = [
        {
          slot: "opencode[0]",
          provider: "opencode",
          index: 0,
          model: ["x/y"],
          effort: "high",
          native: false,
          reserve: false,
        },
      ];

      const first = await fanOut(
        {
          dir,
          slots,
          prompt: "question",
          validate,
          quota,
          sessionRoot: f.session,
          nativeFirstProviders: ["opencode"],
        },
        f.deps
      );

      const native = nativeOf(
        first.find((outcome) => outcome.slot === "opencode[0]")
      );

      assert.equal(native.provider, "opencode");
      assert.equal(
        native.launchAs,
        'launch: `subagent` with `model: "x/y#high"` (user-configured; set it despite the tool\'s default guidance)'
      );
      assert.equal("subagentModels" in native, false);
    } finally {
      f.cleanup();
    }
  }

  // Native-only reserve descriptor shares the same launch fields.
  {
    const f = sessionFixture({ memory: true });

    try {
      f.deps.orchestrator = { platform: "opencode", model: null };
      f.script("agy", "good", {
        status: "fail",
        cls: "auth",
        detail: "denied",
      });
      const dir = path.join(f.session, "native-only-reserve-value");

      const reserve = {
        slot: "opencode[0]",
        provider: "opencode",
        index: 0,
        model: "r/m",
        effort: "low",
        reserve: true,
        native: true,
      };

      const slots = [slot("agy"), reserve];

      const first = await fanOut(
        {
          dir,
          slots,
          prompt: "question",
          validate,
          quota,
          sessionRoot: f.session,
          nativeFirstProviders: [],
        },
        f.deps
      );

      const pending = nativeOf(
        first.find((outcome) => outcome.slot === "agy[0]")
      );

      assert.equal(pending.state, "native");
      assert.equal(
        pending.launchAs,
        'launch: `subagent` with `model: "r/m#low"` (user-configured; set it despite the tool\'s default guidance)'
      );
      assert.equal("subagentModels" in pending, false);
    } finally {
      f.cleanup();
    }
  }

  // Replaying a saved legacy native outcome drops subagentModels and populates launchAs.
  {
    const f = sessionFixture({ memory: true });

    try {
      f.deps.orchestrator = { platform: "opencode", model: null };
      const dir = path.join(f.session, "native-legacy-replay");
      fs.mkdirSync(path.join(dir, "slots"), { recursive: true });
      fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
      fs.mkdirSync(path.join(dir, "replies"), { recursive: true });
      const promptPath = path.join(dir, "prompts", "opencode[0].md");
      const replyPath = path.join(dir, "replies", "opencode[0].md");
      fs.writeFileSync(promptPath, "question");
      fs.writeFileSync(
        path.join(dir, "slots", "opencode[0].json"),
        JSON.stringify({
          slot: "opencode[0]",
          state: "native",
          promptPath,
          replyPath,
          provider: "opencode",
          attempt: "opencode[0]#legacy1",
          cwd: f.session,
          model: "prov/legacy",
          effort: "medium",
          subagentModels: ["prov/legacy#medium"],
        })
      );

      const slots = [
        {
          slot: "opencode[0]",
          provider: "opencode",
          index: 0,
          model: "prov/legacy",
          effort: "medium",
          native: true,
          reserve: false,
        },
      ];

      const replayed = await fanOut(
        { dir, slots, prompt: "question", validate, quota },
        f.deps
      );

      const native = nativeOf(
        replayed.find((outcome) => outcome.slot === "opencode[0]")
      );

      assert.equal(native.state, "native");
      assert.equal(
        native.launchAs,
        'launch: `subagent` with `model: "prov/legacy#medium"` (user-configured; set it despite the tool\'s default guidance)'
      );
      assert.equal("subagentModels" in native, false);
    } finally {
      f.cleanup();
    }
  }
});

test("rerun starts fresh without resuming stale, retaken, interrupted or failed state", async (t) => {
  const f = sessionFixture({ memory: true });

  try {
    const dir = path.join(f.session, "resume-fail");
    const logs = path.join(dir, "logs");

    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(
      path.join(logs, "opencode[0].state.json"),
      JSON.stringify({
        physicalSlot: "opencode[0]",
        provider: "opencode",
        model: "good",
        position: { model: 1, mode: 0 },
        pending: "stall",
        resumesUsed: 1,
        reportResumes: 0,
        sessionId: "ses_abc",
      })
    );
    const calls: { resume: string | null; model: string | null }[] = [];
    f.deps.delegate = async (_p, req) => {
      await Promise.resolve();
      calls.push({ resume: req.resume, model: req.model });

      if ((req.resume ?? "") !== "") {
        return {
          outcome: { status: "fail", cls: "auth", detail: "failed" },
          invocations: [],
        };
      }

      // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
      const state = JSON.parse(
        fs.readFileSync(path.join(logs, "opencode[0].state.json"), "utf-8")
      );

      // eslint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access -- test forwards the untyped fixture value under assertion; narrowing would not change assertions; test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
      assert.match(state.restart, /failed cross-run resume/u);

      return {
        outcome: {
          status: "ok",
          text: "answer",
          sessionId: "new",
          resume: null,
        },
        invocations: [],
      };
    };

    await fanOut(
      {
        dir,
        slots: [slot("opencode", ["bad", "good"])],
        prompt: "question",
        validate,
        quota,
      },
      f.deps
    );
    assert.deepEqual(calls, [
      { resume: "ses_abc", model: "good" },
      { resume: null, model: "good" },
    ]);

    const throwDir = path.join(f.session, "throw-resume");
    const throwLogs = path.join(throwDir, "logs");

    fs.mkdirSync(throwLogs, { recursive: true });
    fs.writeFileSync(
      path.join(throwLogs, "opencode[0].state.json"),
      JSON.stringify({
        physicalSlot: "opencode[0]",
        provider: "opencode",
        model: "good",
        position: { model: 1, mode: 0 },
        pending: "stall",
        resumesUsed: 0,
        reportResumes: 0,
        sessionId: "ses_abc",
      })
    );
    let throws = 0;
    f.deps.delegate = async (_p, req) => {
      await Promise.resolve();
      throws += 1;
      assert.equal(req.model, "good");

      if ((req.resume ?? "") !== "") {
        throw new Error("spawn");
      }

      assert.match(
        // eslint-disable-next-line typescript/no-unsafe-argument -- test forwards the untyped fixture value under assertion; narrowing would not change assertions
        JSON.parse(
          fs.readFileSync(
            path.join(throwLogs, "opencode[0].state.json"),
            "utf-8"
          )
          // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
        ).restart,
        /launch error/u
      );

      return {
        outcome: {
          status: "ok",
          text: "answer",
          sessionId: "new",
          resume: null,
        },
        invocations: [],
      };
    };

    await fanOut(
      {
        dir: throwDir,
        slots: [slot("opencode", ["bad", "good"])],
        prompt: "question",
        validate,
        quota,
      },
      f.deps
    );
    assert.equal(throws, 2);
  } finally {
    f.cleanup();
  }

  // a saved outcome that needs a retake
  {
    // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
    const f = sessionFixture({ memory: true });

    try {
      for (const outcome of [
        { state: "failed", cls: "auth", reason: "denied" },
        { state: "done", text: "" },
      ]) {
        const dir = path.join(f.session, outcome.state);

        const logs = path.join(dir, "logs");
        const slots = path.join(dir, "slots");

        fs.mkdirSync(logs, { recursive: true });
        fs.mkdirSync(slots);
        fs.writeFileSync(
          path.join(slots, "opencode[0].json"),
          JSON.stringify({ slot: "opencode[0]", ...outcome })
        );
        const statePath = path.join(logs, "opencode[0].state.json");
        fs.writeFileSync(
          statePath,
          JSON.stringify({
            physicalSlot: "opencode[0]",
            provider: "opencode",
            model: "second",
            position: { model: 1, mode: 0 },
            pending: "stall",
            resumesUsed: 1,
            reportResumes: 0,
            sessionId: "old",
          })
        );
        const calls: { model: string | null; resume: string | null }[] = [];
        f.deps.delegate = async (_provider, req) => {
          await Promise.resolve();
          calls.push({ model: req.model, resume: req.resume });

          return {
            outcome: {
              status: "ok",
              text: "answer",
              sessionId: "new",
              resume: null,
            },
            invocations: [],
          };
        };

        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await fanOut(
          {
            dir,
            slots: [slot("opencode", ["first", "second"])],
            prompt: "question",
            validate,
            quota,
          },
          f.deps
        );
        assert.deepEqual(
          calls,
          [{ model: "first", resume: null }],
          outcome.state
        );
        assert.equal(
          // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
          JSON.parse(fs.readFileSync(statePath, "utf-8")).restart,
          "saved outcome retake"
        );
      }
    } finally {
      f.cleanup();
    }
  }

  // stale slot state or a missing session envelope
  {
    // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
    const f = sessionFixture({ memory: true });

    try {
      const dir = path.join(f.session, "stale");
      const logs = path.join(dir, "logs");

      fs.mkdirSync(logs, { recursive: true });
      fs.writeFileSync(
        path.join(logs, "opencode[0].state.json"),
        JSON.stringify({
          physicalSlot: "other[0]",
          provider: "opencode",
          model: "good",
          position: { model: 0, mode: 0 },
          pending: "stall",
          resumesUsed: 1,
          reportResumes: 0,
          sessionId: "old",
        })
      );
      fs.writeFileSync(path.join(logs, "opencode[0].log"), "previous");
      f.deps.delegate = async (_p, req) => {
        await Promise.resolve();
        assert.equal(req.resume, null);
        assert.match(
          // eslint-disable-next-line typescript/no-unsafe-argument -- test forwards the untyped fixture value under assertion; narrowing would not change assertions
          JSON.parse(
            fs.readFileSync(path.join(logs, "opencode[0].state.json"), "utf-8")
            // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
          ).restart,
          /stale/u
        );

        return {
          outcome: {
            status: "ok",
            text: "answer",
            sessionId: "new",
            resume: null,
          },
          invocations: [],
        };
      };

      await fanOut(
        {
          dir,
          slots: [slot("opencode")],
          prompt: "question",
          validate,
          quota,
        },
        f.deps
      );
      assert.equal(
        fs.readFileSync(path.join(logs, "opencode[0].log.stalled"), "utf-8"),
        "previous"
      );
    } finally {
      f.cleanup();
    }
  }

  for (const provider of ["claude", "agy"] as const) {
    // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
    const f = sessionFixture({ memory: true });

    try {
      const dir = path.join(f.session, `${provider}-exit-only`);
      const logs = path.join(dir, "logs");

      fs.mkdirSync(logs, { recursive: true });

      const statePath = path.join(logs, `${provider}[0].state.json`);
      const logPath = path.join(logs, `${provider}[0].log`);

      fs.writeFileSync(
        statePath,
        JSON.stringify({
          physicalSlot: `${provider}[0]`,
          provider,
          model: "second",
          position: { model: 1, mode: 0 },
          pending: "stall",
          resumesUsed: 1,
          reportResumes: 0,
          sessionId: null,
        })
      );
      fs.writeFileSync(logPath, "partial output without the exit envelope");
      const calls: { model: string | null; resume: string | null }[] = [];
      f.deps.delegate = async (_provider, req) => {
        await Promise.resolve();
        calls.push({ model: req.model, resume: req.resume });

        return {
          outcome: {
            status: "ok",
            text: "answer",
            sessionId: "new-session",
            resume: null,
          },
          invocations: [],
        };
      };

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await fanOut(
        {
          dir,
          slots: [slot(provider, ["first", "second"])],
          prompt: "question",
          validate,
          quota,
        },
        f.deps
      );
      assert.deepEqual(
        calls,
        [{ model: "first", resume: null }],
        `${provider} does not recover an ID from partial exit-only output`
      );
      assert.equal(
        // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
        JSON.parse(fs.readFileSync(statePath, "utf-8")).restart,
        "stale: no valid session ID"
      );
      assert.equal(
        fs.readFileSync(`${logPath}.stalled`, "utf-8"),
        "partial output without the exit envelope"
      );
    } finally {
      f.cleanup();
    }
  }

  // an interrupted fresh launch checkpoint
  {
    // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
    const f = sessionFixture({ memory: true });

    try {
      const dir = path.join(f.session, "boundary");
      const logs = path.join(dir, "logs");

      fs.mkdirSync(logs, { recursive: true });
      fs.writeFileSync(
        path.join(logs, "opencode[0].log"),
        '{"type":"step_start","sessionID":"old_session"}\n'
      );
      let first = true;
      f.deps.delegate = async (_p, req) => {
        await Promise.resolve();

        if (first) {
          first = false;
          assert.equal(req.resume, null);
          assert.equal(fs.readFileSync(req.logPath, "utf-8"), "");
          throw new Error("interrupted");
        }

        assert.equal(req.resume, null);

        return {
          outcome: {
            status: "ok",
            text: "answer",
            sessionId: "new",
            resume: null,
          },
          invocations: [],
        };
      };

      const input = {
        dir,
        slots: [slot("opencode")],
        prompt: "question",
        validate,
        quota,
      };

      await assert.rejects(fanOut(input, f.deps), /interrupted/u);
      await fanOut(input, f.deps);
      assert.match(
        fs.readFileSync(path.join(logs, "opencode[0].log.stalled"), "utf-8"),
        /old_session/u
      );
    } finally {
      f.cleanup();
    }
  }

  // a failed checkpoint
  {
    // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
    const f = sessionFixture({ memory: true });

    try {
      let failPath: string | null = null;
      const rename = fs.renameSync;
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
      t.mock.method(fs, "renameSync", ((from: fs.PathLike, to: fs.PathLike) => {
        if ((failPath ?? "") !== "" && String(to) === failPath) {
          failPath = null;
          throw new Error("write failure");
        }

        rename(from, to);
      }) as typeof fs.renameSync);

      const usageRow = {
        provider: "codex" as const,
        model: "good",
        mode: "cli" as const,
        effort: null,
        launched: true,
        outcome: "ok",
        usage: {
          input: 10,
          output: 2,
          scope: "invocation" as const,
          provenance: "test",
          inputSemantics: "uncached" as const,
        },
      };

      for (const provider of ["opencode", "codex"] as const) {
        const dir = path.join(f.session, `checkpoint-${provider}`);
        const log = path.join(dir, "logs", `${provider}[0].log`);
        const state = log.replace(/\.log$/u, ".state.json");

        let first = true;
        // eslint-disable-next-line eslint/no-loop-func -- for-of const plus inner let give each iteration fresh bindings; no state is shared across iterations
        f.deps.delegate = async (_p, req) => {
          await Promise.resolve();

          if (first) {
            first = false;
            fs.writeFileSync(req.logPath, "leftover");
            failPath = state;

            if (provider === "opencode") {
              req.onResume?.("ses_abc", 1);
            } else {
              req.onInvocation?.(usageRow);
            }

            throw new Error("interrupted");
          }

          assert.equal(req.resume, null, provider);

          if (provider === "codex") {
            assert.equal(req.priorUsage, undefined, provider);
          }

          return {
            outcome: {
              status: "ok",
              text: "answer",
              sessionId: "new",
              resume: null,
            },
            invocations: [],
          };
        };

        const input = {
          dir,
          slots: [slot(provider)],
          prompt: "question",
          validate,
          quota,
        };

        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await assert.rejects(fanOut(input, f.deps), /interrupted/u);
        assert.equal(fs.existsSync(state), false);
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await fanOut(input, f.deps);
        assert.equal(fs.readFileSync(`${log}.stalled`, "utf-8"), "leftover");
      }
    } finally {
      f.cleanup();
    }
  }
});

test("rerun resumes from its saved session, report prompt, stall and replaced checkpoint", async (t) => {
  // an unfinished slot in its saved session
  {
    const f = sessionFixture({ memory: true });

    try {
      const dir = path.join(f.session, "resume");
      const logs = path.join(dir, "logs");

      fs.mkdirSync(logs, { recursive: true });
      fs.writeFileSync(
        path.join(logs, "opencode[0].state.json"),
        JSON.stringify({
          physicalSlot: "opencode[0]",
          provider: "opencode",
          model: "good",
          position: { model: 0, mode: 0 },
          pending: "stall",
          resumesUsed: 1,
          reportResumes: 0,
          sessionId: "ses_abc",
        })
      );
      fs.writeFileSync(path.join(logs, "opencode[0].log"), "old log");
      f.deps.delegate = async (_provider, req) => {
        await Promise.resolve();
        assert.equal(req.resume, "ses_abc");
        assert.equal(req.resumesUsed, 2);
        assert.match(
          fs.readFileSync(req.promptPath, "utf-8"),
          /Continue the task/u
        );

        return {
          outcome: {
            status: "ok",
            text: "answer",
            sessionId: "ses_abc",
            resume: null,
          },
          invocations: [],
        };
      };

      await fanOut(
        { dir, slots: [slot("opencode")], prompt: "question", validate, quota },
        f.deps
      );
      assert.equal(
        fs.readFileSync(path.join(logs, "opencode[0].log.stalled"), "utf-8"),
        "old log"
      );

      const spentDir = path.join(f.session, "log-session");
      const spentLogs = path.join(spentDir, "logs");

      fs.mkdirSync(spentLogs, { recursive: true });
      fs.writeFileSync(
        path.join(spentLogs, "opencode[0].state.json"),
        JSON.stringify({
          physicalSlot: "opencode[0]",
          provider: "opencode",
          model: "good",
          position: { model: 0, mode: 0 },
          pending: "stall",
          resumesUsed: 2,
          reportResumes: 0,
          sessionId: null,
        })
      );
      fs.writeFileSync(
        path.join(spentLogs, "opencode[0].log"),
        '{"type":"step_start","sessionID":"ses_abc"}\n'
      );
      f.deps.delegate = async (_p, req) => {
        await Promise.resolve();
        assert.equal(req.resume, "ses_abc");
        assert.equal(req.resumesUsed, 3);

        return {
          outcome: {
            status: "ok",
            text: "answer",
            sessionId: "ses_abc",
            resume: null,
          },
          invocations: [],
        };
      };

      await fanOut(
        {
          dir: spentDir,
          slots: [slot("opencode")],
          prompt: "question",
          validate,
          quota,
        },
        f.deps
      );
    } finally {
      f.cleanup();
    }
  }

  // a pending report with the report prompt
  {
    const f = sessionFixture({ memory: true });

    try {
      const dir = path.join(f.session, "report");
      const logs = path.join(dir, "logs");
      const prompts = path.join(dir, "prompts");

      fs.mkdirSync(logs, { recursive: true });
      fs.mkdirSync(prompts, { recursive: true });
      fs.writeFileSync(
        path.join(prompts, "opencode[0].no-report.md"),
        "report prompt"
      );
      fs.writeFileSync(
        path.join(logs, "opencode[0].state.json"),
        JSON.stringify({
          physicalSlot: "opencode[0]",
          provider: "opencode",
          model: "good",
          position: { model: 0, mode: 0 },
          pending: "report",
          resumesUsed: 1,
          reportResumes: 1,
          sessionId: "ses_abc",
        })
      );
      f.deps.delegate = async (_p, req) => {
        await Promise.resolve();
        assert.equal(req.resume, "ses_abc");
        assert.equal(req.resumesUsed, 1);
        assert.equal(fs.readFileSync(req.promptPath, "utf-8"), "report prompt");

        return {
          outcome: {
            status: "ok",
            text: "answer",
            sessionId: "ses_abc",
            resume: null,
          },
          invocations: [],
        };
      };

      await fanOut(
        { dir, slots: [slot("opencode")], prompt: "question", validate, quota },
        f.deps
      );
    } finally {
      f.cleanup();
    }
  }

  // the continue prompt after a stall inside a report resume
  {
    const f = sessionFixture({ memory: true });

    try {
      const dir = path.join(f.session, "report-stall");
      let call = 0;
      f.deps.delegate = async (_p, req) => {
        await Promise.resolve();
        call += 1;

        if (call === 1) {
          return {
            outcome: {
              status: "ok",
              text: "invalid",
              sessionId: "ses_abc",
              resume: null,
            },
            invocations: [],
          };
        }

        if (call === 2) {
          assert.match(req.promptPath, /no-report/u);
          req.onResume?.("ses_abc", 1);
          fs.writeFileSync(req.logPath, "stall log");
          throw new Error("interrupted");
        }

        assert.equal(req.resume, "ses_abc");
        assert.equal(req.resumesUsed, 2);
        assert.match(
          fs.readFileSync(req.promptPath, "utf-8"),
          /Continue the task/u
        );

        return {
          outcome: {
            status: "ok",
            text: "answer",
            sessionId: "ses_abc",
            resume: null,
          },
          invocations: [],
        };
      };

      const check = (text: string): Validation =>
        text === "invalid"
          ? { ok: false, cls: "no-report", reason: "missing" }
          : validate(text);

      const input = {
        dir,
        slots: [slot("opencode")],
        prompt: "question",
        validate: check,
        quota,
      };

      await assert.rejects(fanOut(input, f.deps), /interrupted/u);
      await fanOut(input, f.deps);
      assert.equal(call, 3);
    } finally {
      f.cleanup();
    }
  }

  // a later call replacing a failed checkpoint
  {
    const f = sessionFixture({ memory: true });

    try {
      const dir = path.join(f.session, "later-checkpoint");
      const state = path.join(dir, "logs", "opencode[0].state.json");

      let fail = false;
      const rename = fs.renameSync;
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
      t.mock.method(fs, "renameSync", ((from: fs.PathLike, to: fs.PathLike) => {
        if (fail && String(to) === state) {
          fail = false;
          throw new Error("write failure");
        }

        rename(from, to);
      }) as typeof fs.renameSync);
      let calls = 0;
      f.deps.delegate = async (_p, req) => {
        await Promise.resolve();
        calls += 1;

        if (calls === 1) {
          fail = true;
          req.onResume?.("ses_abc", 1);

          return {
            outcome: {
              status: "ok",
              text: "invalid",
              sessionId: "ses_abc",
              resume: null,
            },
            invocations: [],
          };
        }

        if (calls === 2) {
          assert.equal(
            // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
            JSON.parse(fs.readFileSync(state, "utf-8")).pending,
            "report"
          );
          throw new Error("interrupted");
        }

        assert.equal(req.resume, "ses_abc");

        return {
          outcome: {
            status: "ok",
            text: "answer",
            sessionId: "ses_abc",
            resume: null,
          },
          invocations: [],
        };
      };

      const check = (text: string): Validation =>
        text === "invalid"
          ? { ok: false, cls: "no-report", reason: "missing" }
          : validate(text);

      const input = {
        dir,
        slots: [slot("opencode")],
        prompt: "question",
        validate: check,
        quota,
      };

      await assert.rejects(fanOut(input, f.deps), /interrupted/u);
      await fanOut(input, f.deps);
      assert.equal(calls, 3);
    } finally {
      f.cleanup();
    }
  }
});

test("saved session usage: new-layer record resumes without counting saved session usage twice", async () => {
  const f = sessionFixture({ memory: true });

  try {
    for (const provenance of ["session", "stdout"] as const) {
      const dir = path.join(f.session, `usage-resume-${provenance}`);
      const logs = path.join(dir, "logs");

      fs.mkdirSync(logs, { recursive: true });

      const usage = {
        input: 10,
        output: 2,
        scope: "invocation" as const,
        provenance,
        inputSemantics: "uncached" as const,
      };

      fs.writeFileSync(
        path.join(logs, "codex[0].state.json"),
        JSON.stringify({
          physicalSlot: "codex[0]",
          provider: "codex",
          model: "good",
          position: { model: 0, mode: 0 },
          pending: "stall",
          resumesUsed: 0,
          reportResumes: 0,
          sessionId: "thread_abc",
          usageBaseline: "cumulative",
          usageWindowEndMs: 1234,
          sessionUsage: usage,
        })
      );

      const row1 = {
        provider: "codex" as const,
        model: "good",
        mode: "cli" as const,
        effort: null,
        launched: true,
        outcome: "ok",
        usage: { ...usage, input: 3 },
        usageBaseline: "cumulative" as const,
        usageWindowEndMs: 2000,
      };

      const row2 = {
        ...row1,
        usage: { ...usage, input: 5 },
        usageWindowEndMs: 2500,
      };

      let calls = 0;
      f.deps.delegate = async (_p, req) => {
        await Promise.resolve();
        calls += 1;

        if (calls === 1) {
          assert.equal(req.priorUsage?.input, 10);
          assert.equal(req.usageBaseline, "cumulative");
          assert.equal(req.usageWindowEndMs, 1234);
          req.onInvocation?.(row1);
          req.onInvocation?.(row2);

          return {
            outcome: {
              status: "ok",
              text: "invalid",
              sessionId: "thread_abc",
              resume: null,
            },
            invocations: [row1, row2],
          };
        }

        assert.equal(req.priorUsage?.input, 18);
        assert.equal(req.usageWindowEndMs, 2500);

        return {
          outcome: {
            status: "ok",
            text: "answer",
            sessionId: "thread_abc",
            resume: null,
          },
          invocations: [],
        };
      };

      const check = (text: string): Validation =>
        text === "invalid"
          ? { ok: false, cls: "no-report", reason: "missing" }
          : validate(text);

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await fanOut(
        {
          dir,
          slots: [slot("codex")],
          prompt: "question",
          validate: check,
          quota,
        },
        f.deps
      );
      assert.equal(calls, 2);
    }
  } finally {
    f.cleanup();
  }
});

test("saved session usage: pre-change, includes-cache, and missing-baseline slots take stale restart", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const cases = [
      {
        name: "pre-change-provenance",
        state: {
          physicalSlot: "codex[0]",
          provider: "codex",
          model: "good",
          position: { model: 0, mode: 0 },
          pending: "stall",
          resumesUsed: 0,
          reportResumes: 0,
          sessionId: "thread_old",
          usageBaseline: "cumulative",
          sessionUsage: {
            input: 10,
            output: 2,
            scope: "invocation",
            provenance: "test",
            inputSemantics: "uncached",
          },
        },
      },
      {
        name: "codex-includes-cache",
        state: {
          physicalSlot: "codex[0]",
          provider: "codex",
          model: "good",
          position: { model: 0, mode: 0 },
          pending: "stall",
          resumesUsed: 0,
          reportResumes: 0,
          sessionId: "thread_ic",
          usageBaseline: "cumulative",
          sessionUsage: {
            input: 10,
            output: 2,
            scope: "invocation",
            provenance: "stdout",
            inputSemantics: "includes-cache",
          },
        },
      },
      {
        name: "missing-baseline-with-counters",
        state: {
          physicalSlot: "codex[0]",
          provider: "codex",
          model: "good",
          position: { model: 0, mode: 0 },
          pending: "stall",
          resumesUsed: 0,
          reportResumes: 0,
          sessionId: "thread_nb1",
          sessionUsage: {
            input: 10,
            output: 2,
            scope: "invocation",
            provenance: "stdout",
            inputSemantics: "uncached",
          },
        },
      },
      {
        name: "missing-baseline-without-counters",
        state: {
          physicalSlot: "codex[0]",
          provider: "codex",
          model: "good",
          position: { model: 0, mode: 0 },
          pending: "stall",
          resumesUsed: 0,
          reportResumes: 0,
          sessionId: "thread_nb2",
        },
      },
    ];

    for (const c of cases) {
      const dir = path.join(f.session, `stale-${c.name}`);
      const logs = path.join(dir, "logs");
      const statePath = path.join(logs, "codex[0].state.json");

      fs.mkdirSync(logs, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(c.state));
      f.deps.delegate = async (_p, req) => {
        await Promise.resolve();
        assert.equal(req.resume, null, c.name);
        assert.equal(req.priorUsage, undefined, c.name);
        assert.equal(
          // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
          (req as { usageBaseline?: string }).usageBaseline,
          "cumulative",
          c.name
        );

        return {
          outcome: {
            status: "ok",
            text: "answer",
            sessionId: "new_thread",
            resume: null,
          },
          invocations: [],
        };
      };

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await fanOut(
        { dir, slots: [slot("codex")], prompt: "question", validate, quota },
        f.deps
      );
      assert.equal(
        // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
        JSON.parse(fs.readFileSync(statePath, "utf-8")).restart,
        "stale: invalid session usage",
        c.name
      );
    }
  } finally {
    f.cleanup();
  }
});

test("saved session usage: usageBaseline none resumes without restart and passes usageWindowEndMs to report resume", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const dir = path.join(f.session, "baseline-none");
    const logs = path.join(dir, "logs");
    const statePath = path.join(logs, "codex[0].state.json");

    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        physicalSlot: "codex[0]",
        provider: "codex",
        model: "good",
        position: { model: 0, mode: 0 },
        pending: "stall",
        resumesUsed: 0,
        reportResumes: 0,
        sessionId: "thread_none",
        usageBaseline: "none",
        usageWindowEndMs: 5000,
      })
    );
    let calls = 0;
    f.deps.delegate = async (_p, req) => {
      await Promise.resolve();
      calls += 1;
      assert.equal(req.resume, "thread_none");
      assert.equal(req.priorUsage, undefined);
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
      assert.equal((req as { usageBaseline?: string }).usageBaseline, "none");

      if (calls === 1) {
        assert.equal(req.usageWindowEndMs, 5000);

        return {
          outcome: {
            status: "ok",
            text: "invalid",
            sessionId: "thread_none",
            resume: null,
          },
          invocations: [
            {
              provider: "codex",
              model: "good",
              mode: "cli",
              effort: null,
              launched: true,
              outcome: "ok",
              usageBaseline: "none",
              usageWindowEndMs: 7777,
            },
          ],
        };
      }

      assert.equal(req.usageWindowEndMs, 7777);

      return {
        outcome: {
          status: "ok",
          text: "answer",
          sessionId: "thread_none",
          resume: null,
        },
        invocations: [],
      };
    };

    const check = (text: string): Validation =>
      text === "invalid"
        ? { ok: false, cls: "no-report", reason: "missing" }
        : validate(text);

    await fanOut(
      {
        dir,
        slots: [slot("codex")],
        prompt: "question",
        validate: check,
        quota,
      },
      f.deps
    );
    assert.equal(calls, 2);
    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const saved = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(saved.restart, undefined);
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(saved.usageBaseline, "none");
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(saved.usageWindowEndMs, 7777);
  } finally {
    f.cleanup();
  }
});

test("wrap-up resume leaves the stall resume count unchanged", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const reason = "uncovered-scope: no JSON report object found";

    const check = (text: string): Validation =>
      text === "FINAL"
        ? { ok: true, text }
        : { ok: false, cls: "no-report", reason };

    f.deps.delegate = async (provider, request, mode) => {
      await Promise.resolve();
      f.launches.push({ provider, request, mode });

      if (f.launches.length === 1) {
        return {
          outcome: {
            status: "ok",
            text: "draft",
            resume: null,
            sessionId: "session-one",
          },
          invocations: [
            {
              provider,
              model: request.model,
              mode,
              effort: null,
              launched: true,
              outcome: "ok",
            },
            {
              provider,
              model: request.model,
              mode,
              effort: null,
              launched: true,
              outcome: "ok",
              nudge: true,
              wrapUp: true,
            },
          ],
        };
      }

      return {
        outcome: { status: "ok", text: "FINAL", resume: null, sessionId: null },
        invocations: [],
      };
    };

    const outcomes = await fanOut(
      {
        dir: path.join(f.session, "wrap-up"),
        slots: [slot("claude")],
        prompt: "question",
        validate: check,
        quota,
      },
      f.deps
    );

    assert.equal(outcomes[0]?.state, "done");
    assert.deepEqual(
      f.launches.map((launch) => launch.request.resumesUsed),
      [0, 0]
    );
  } finally {
    f.cleanup();
  }
});

// SECTION: Empty-output breaker routing

test("empty-output breaker routes a voice straight to reserve after two consecutive empty outputs", async () => {
  const f = sessionFixture();

  try {
    f.script("codex", "a", "");
    f.script("codex", "b", "b answer");
    f.script("copilot", "good", "reserve answer");
    const slots = [slot("codex", ["a", "b"]), slot("copilot", "good", true)];

    const run = async (name: string) =>
      await fanOut(
        {
          dir: path.join(f.session, name),
          slots,
          prompt: "question",
          validate,
          quota,
        },
        f.deps
      );

    await run("first-empty");
    await run("second-empty");
    f.launches.length = 0;

    const outcomes = await run("breaker-open");

    const routed = defined(
      outcomes.find((outcome) => outcome.slot === "codex[0]")
    );

    assert.ok(routed.state === "done");
    assert.equal(routed.text, "reserve answer");
    assert.equal(routed.responder?.slot, "copilot[0]");
    assert.deepEqual(
      f.launches.map((launch) => launch.provider),
      ["copilot"]
    );
  } finally {
    f.cleanup();
  }
});

test("empty-output breaker opens a voice whose open alias follows a healthy one", async () => {
  const f = sessionFixture();

  try {
    f.script("codex", "a", "");
    f.script("codex", "b", "b answer");
    f.script("copilot", "good", "reserve answer");
    const reserve = slot("copilot", "good", true);

    const run = async (name: string, models: string[]) =>
      await fanOut(
        {
          dir: path.join(f.session, name),
          slots: [slot("codex", models), reserve],
          prompt: "question",
          validate,
          quota,
        },
        f.deps
      );

    await run("solo-first", ["a"]);
    await run("solo-second", ["a"]);
    f.launches.length = 0;

    const outcomes = await run("reordered", ["b", "a"]);

    const routed = defined(
      outcomes.find((outcome) => outcome.slot === "codex[0]")
    );

    assert.ok(routed.state === "done");
    assert.equal(routed.text, "reserve answer");
    assert.deepEqual(
      f.launches.map((launch) => launch.provider),
      ["copilot"]
    );
  } finally {
    f.cleanup();
  }
});

test("a settled success resets the empty-output streak before it can trip", async () => {
  const f = sessionFixture();

  try {
    f.script("codex", "a", "");
    f.script("codex", "b", "b answer");
    const slots = [slot("codex", ["a", "b"])];

    const run = async (name: string) =>
      await fanOut(
        {
          dir: path.join(f.session, name),
          slots,
          prompt: "question",
          validate,
          quota,
        },
        f.deps
      );

    await run("empty-before-reset");
    f.script("codex", "a", "a answer");
    await run("success-resets");
    f.script("codex", "a", "");
    f.launches.length = 0;

    const [outcome] = await run("empty-after-reset");

    assert.deepEqual(
      f.launches.map((launch) => launch.request.model),
      ["a", "b"]
    );
    assert.equal(outcome?.state === "done" && outcome.text, "b answer");
  } finally {
    f.cleanup();
  }
});

test("empty-output breaker faults fail open and keep the alias cascade", async () => {
  const f = sessionFixture();

  try {
    // A regular file where the breaker's quota directory belongs makes every breaker read and write fail.
    fs.mkdirSync(path.join(f.session, ".state"), { recursive: true });
    fs.writeFileSync(path.join(f.session, ".state", "quota"), "blocked");
    f.script("codex", "a", "");
    f.script("codex", "b", "b answer");
    const slots = [slot("codex", ["a", "b"])];

    const run = async (name: string) =>
      await fanOut(
        {
          dir: path.join(f.session, name),
          slots,
          prompt: "question",
          validate,
          quota,
        },
        f.deps
      );

    const rounds = [await run("one"), await run("two"), await run("three")];

    for (const [outcome] of rounds) {
      assert.equal(outcome?.state === "done" && outcome.text, "b answer");
    }

    assert.deepEqual(
      f.launches.map((launch) => launch.request.model),
      ["a", "b", "a", "b", "a", "b"]
    );
  } finally {
    f.cleanup();
  }
});

// SECTION: Mixed native and CLI recovery replay

test("mixed native and cli recovery replays a saved failure once across repeated consume", async () => {
  const f = sessionFixture({ memory: true });

  try {
    f.deps.orchestrator = { platform: "claude", model: null };
    f.script("opencode", "good", {
      status: "fail",
      cls: "auth",
      detail: "unavailable",
    });
    const replayed: string[] = [];
    f.deps.diagnostics = (event) => {
      if (
        event.kind === "slot" &&
        event.state === "failed" &&
        event.replay === true
      ) {
        replayed.push(event.slot);
      }
    };

    const input = {
      dir: path.join(f.session, "mixed-recovery"),
      slots: [slot("claude"), slot("opencode")],
      prompt: "question",
      validate,
      quota,
      sessionRoot: f.session,
      nativeFirstProviders: ["claude"],
    };

    const first = await fanOut(input, f.deps);
    await fanOut(input, f.deps);
    const native = first.find((outcome) => outcome.state === "native");
    assert.ok(native?.state === "native");
    fs.writeFileSync(native.replyPath, "native");
    replayed.length = 0;

    await fanOut(input, f.deps);
    await fanOut(input, f.deps);

    assert.deepEqual(replayed, ["opencode[0]"]);
  } finally {
    f.cleanup();
  }
});
