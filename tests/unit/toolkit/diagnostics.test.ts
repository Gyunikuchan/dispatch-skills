import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { isRecord } from "../../../skills/dispatch/scripts/lib/config.ts";
import { readManifest } from "../../../skills/dispatch/scripts/lib/session.ts";
import { main } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import {
  hostThreadId,
  observeTool,
} from "../../../skills/dispatch/scripts/toolkit/diagnostics-capture.ts";
import {
  sessionFacts,
  stageMilestones,
  writeDiagnostics,
} from "../../../skills/dispatch/scripts/toolkit/diagnostics.ts";
import {
  heuristics,
  normalizeUsage,
  sanitizeFacts,
} from "../../../skills/dispatch/scripts/toolkit/domain/diagnostics.ts";
import { fanOut } from "../../../skills/dispatch/scripts/toolkit/fanout.ts";
import type { Fold } from "../../../skills/dispatch/scripts/toolkit/ledger.ts";
import { ToolError } from "../../../skills/dispatch/scripts/toolkit/output.ts";
import { readReviews } from "../../../skills/dispatch/scripts/toolkit/review-storage.ts";
import { defined } from "../../helpers/guards.ts";
import { memoryFs } from "../lib/usage/helpers/memory-fs.ts";
import { narrow, text } from "./helpers/json.ts";
import { sessionFixture } from "./helpers/session.ts";

const requestForLog = (logPath: string) => {
  const cwd = path.dirname(path.dirname(logPath));

  return {
    logPath,
    cwd,
    promptPath: path.join(cwd, "prompt.md"),
    briefPath: path.join(cwd, "brief.md"),
    attachments: [],
    model: null,
    effort: null,
    sandbox: true,
    schemaPath: null,
    resume: null,
    timeoutMs: 1000,
    outputCapBytes: 1024,
  };
};

const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
};

const readCapture = (file: string) => {
  const captured: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.ok(isRecord(captured));

  return captured;
};

const isoTime = (ms: number) => new Date(ms).toISOString();

const stageCapture = (name: string, start: number, end: number) => ({
  capture: { state: "completed" as const, start, end },
  phases: [{ key: name, name }],
  invocations: [],
  reviews: [],
});

test("Copilot diagnostics retains billing evidence without disabled reads", async () => {
  for (const enabled of [false, true]) {
    const f = sessionFixture({ memory: true });

    try {
      const skill = path.join(f.root, "skill");
      fs.mkdirSync(skill);
      fs.writeFileSync(
        path.join(skill, "config.jsonc"),
        JSON.stringify({ diagnostics: enabled })
      );
      f.deps.skillRoot = skill;
      const usageFs = memoryFs({});
      usageFs.stat = () => {
        throw new Error("disabled collection must not read");
      };

      f.deps.hostUsageFs = usageFs;
      // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
      f.deps.delegate = () =>
        Promise.resolve({
          outcome: {
            status: "ok",
            text: "answer",
            sessionId: null,
            resume: null,
          },
          invocations: [
            {
              provider: "copilot",
              model: "custom/model",
              mode: "cli",
              effort: null,
              configuredEffort: "high",
              launched: true,
              outcome: "ok",
              usage: {
                input: 10,
                output: 2,
                scope: "invocation",
                provenance: "session",
                inputSemantics: "uncached",
                copilot: {
                  tokenCoverage: "complete",
                  lineageCoverage: "unknown",
                  actorCoverage: "complete",
                  billing: {
                    coverage: "partial",
                    totalNanoAiu: 50,
                    statuses: ["pending"],
                    multipliers: [2],
                  },
                },
              },
            },
          ],
        });

      if (enabled) {
        const observer = defined(
          observeTool(f.session, "ask", "run", undefined, f.deps)
        );

        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await observer.deps.delegate(
          "copilot",
          {
            promptPath: "/brief",
            model: null,
            effort: "high",
            sandbox: false,
            schemaPath: null,
            resume: null,
            cwd: f.session,
            timeoutMs: 1000,
            outputCapBytes: 100,
            attachments: [],
            logPath: path.join(f.session, "logs", "copilot[0].log"),
            briefPath: "/spill",
          },
          "cli"
        );
        observer.finish({ ok: true, exit: 0, summary: "done", value: null });

        const facts = sessionFacts(
          f.session,
          { records: [], lastSeq: 0, torn: null },
          "complete"
        );

        assert.equal(facts.invocations[0]?.configuredEffort, "high");
        assert.equal(
          facts.invocations[0]?.usage?.copilot?.billing.totalNanoAiu,
          50
        );
      } else {
        assert.equal(
          observeTool(f.session, "ask", "run", undefined, f.deps),
          undefined
        );
        assert.deepEqual(usageFs.reads, []);
      }
    } finally {
      f.cleanup();
    }
  }
});

// eslint-disable-next-line typescript/no-unnecessary-type-parameters -- generic preserves each caller's exact slot-row shape; concrete unions reject the partial fixture rows
function saveRound<Outcome extends { slot: string; state: string }>(input: {
  session: string;
  review: string;
  round: number;
  roster: ReturnType<typeof rosterSlot>[];
  outcomes: Outcome[];
  findings?: unknown[];
  generation?: number;
}) {
  const generation = input.generation ?? 1;
  const reviewDir = path.join(input.session, ".state", "reviews", input.review);
  const roundDir = path.join(reviewDir, `round-${input.round}`);
  writeJson(path.join(roundDir, "round.json"), {
    round: input.round,
    generation,
    cap: 4,
    level: "high",
    roster: input.roster,
    scope: "Full review",
    startSeq: 0,
    spec: { path: "spec.md", hash: `sha256:${"a".repeat(64)}` },
    target: { base: "a".repeat(40), head: "b".repeat(40) },
  });

  for (const outcome of input.outcomes) {
    writeJson(
      slotFile(reviewDir, input.round, outcome.slot, generation),
      outcome
    );
  }

  if (input.findings) {
    writeJson(path.join(roundDir, "findings.json"), {
      review: input.review,
      round: input.round,
      cap: 4,
      level: "high",
      findings: input.findings,
      clusters: [],
      failed: input.outcomes.filter((outcome) => outcome.state === "failed"),
    });
  }
}

test("Copilot native replacement clears primary effort in persistence and saved replay", async () => {
  const { fanOutComplete } =
    await import("../../../skills/dispatch/scripts/toolkit/fanout.ts");

  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill);
    writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
    f.deps.skillRoot = skill;
    f.deps.orchestrator = { platform: "copilot", model: null };

    const primary = {
      ...rosterSlot("copilot[0]", "copilot", {
        native: true,
        model: "primary",
      }),
      effort: "high",
    };

    const reserve = {
      ...rosterSlot("copilot[1]", "copilot", {
        native: true,
        reserve: true,
        model: "reserve",
      }),
      index: 1,
    };

    const dir = path.join(
      f.session,
      ".state",
      "reviews",
      "code-alpha",
      "round-1",
      "gen-1"
    );

    const input = {
      dir,
      slots: [primary, reserve],
      prompt: "question",
      validate: (value: string) => ({ ok: true as const, text: value }),
      sessionRoot: f.session,
    };

    const observer = defined(
      observeTool(f.session, "review", "run", undefined, f.deps)
    );

    const first = await fanOutComplete(input, observer.deps);
    const pending = first.find((r) => r.state === "native");
    assert.ok(pending?.state === "native");

    const second = await fanOutComplete(
      {
        ...input,
        nativeFailures: [
          {
            attempt: pending.attempt,
            reason: "unavailable",
            reasonHash: "synthetic",
          },
        ],
      },
      observer.deps
    );

    const replacement = second.find((r) => r.state === "native");
    assert.ok(replacement?.state === "native");
    assert.equal(replacement.model, "reserve");
    assert.equal(replacement.effort, undefined);
    observer.finish({
      ok: false,
      exit: 4,
      reason: "native-pending",
      summary: "pending",
      value: null,
    });
    const directory = path.join(f.session, ".state", "diagnostics");
    const [file] = fs.readdirSync(directory);
    assert.ok((file ?? "").length > 0);
    const capture = readCapture(path.join(directory, defined(file)));
    assert.ok(Array.isArray(capture["invocations"]));
    const invocations: unknown[] = capture["invocations"];

    const native = invocations.find(
      (invocation) => isRecord(invocation) && invocation["surface"] === "native"
    );

    assert.ok(isRecord(native));
    assert.equal(native["effort"], undefined);
    captureRuns(f.session, [
      {
        phase: "code-review",
        subject: roundSubject(f.session, "code-alpha", 1),
        slot: primary.slot,
        surface: "native",
        provider: "copilot",
        model: "primary",
        effort: "high",
        launched: false,
        outcome: "native-failed",
        nativeState: "failed",
        attempt: 1,
      },
    ]);
    saveRound({
      session: f.session,
      review: "code-alpha",
      round: 1,
      roster: [primary, reserve],
      outcomes: [replacement],
    });

    let facts = sessionFacts(
      f.session,
      { records: [], lastSeq: 0, torn: null },
      "complete"
    );

    const pendingReplay = defined(
      facts.invocations.find((i) => i.surface === "native")
    );

    assert.deepEqual(
      [
        pendingReplay.provider,
        pendingReplay.model,
        pendingReplay.effort,
        pendingReplay.nativeState,
        pendingReplay.attempt,
      ],
      ["copilot", "reserve", undefined, "pending", undefined]
    );
    captureRuns(f.session, [
      {
        phase: "code-review",
        subject: roundSubject(f.session, "code-alpha", 1),
        slot: primary.slot,
        surface: "native",
        provider: "copilot",
        model: "reserve",
        launched: false,
        outcome: "native-failed",
        nativeState: "failed",
        attempt: 2,
      },
    ]);
    saveRound({
      session: f.session,
      review: "code-alpha",
      round: 1,
      roster: [primary, reserve],
      outcomes: [replacement],
    });
    facts = sessionFacts(
      f.session,
      { records: [], lastSeq: 0, torn: null },
      "complete"
    );

    const matchingTerminal = defined(
      facts.invocations.find((i) => i.surface === "native")
    );

    assert.deepEqual(
      [
        matchingTerminal.model,
        matchingTerminal.effort,
        matchingTerminal.nativeState,
        matchingTerminal.attempt,
      ],
      ["reserve", undefined, "failed", 2]
    );
    captureRuns(f.session, [
      {
        phase: "code-review",
        subject: roundSubject(f.session, "code-alpha", 1),
        slot: primary.slot,
        surface: "native",
        provider: "copilot",
        model: "primary",
        effort: "high",
        launched: false,
        outcome: "native-pending",
        nativeState: "pending",
        attempt: 1,
      },
    ]);
    saveRound({
      session: f.session,
      review: "code-alpha",
      round: 1,
      roster: [primary, reserve],
      outcomes: [
        {
          slot: primary.slot,
          state: "done",
          responder: {
            slot: reserve.slot,
            provider: "copilot",
            model: "reserve",
            native: true,
          },
        },
      ],
    });
    facts = sessionFacts(
      f.session,
      { records: [], lastSeq: 0, torn: null },
      "complete"
    );

    const replay = defined(
      facts.invocations.find((i) => i.surface === "native")
    );

    assert.deepEqual(
      [replay.model, replay.effort, replay.nativeState, replay.attempt],
      ["reserve", undefined, "completed", undefined]
    );
    const changedPrimary = { ...primary, model: "changed", effort: "low" };
    saveRound({
      session: f.session,
      review: "code-alpha",
      round: 1,
      roster: [changedPrimary, reserve],
      outcomes: [
        {
          slot: primary.slot,
          state: "done",
          responder: {
            slot: primary.slot,
            provider: "copilot",
            model: "primary",
            native: true,
            effort: "high",
          },
        },
      ],
    });

    const saved = defined(
      sessionFacts(
        f.session,
        { records: [], lastSeq: 0, torn: null },
        "complete"
      ).invocations.find((i) => i.surface === "native")
    );

    assert.deepEqual(
      [saved.model, saved.effort, saved.nativeState, saved.attempt],
      ["primary", "high", "completed", 1]
    );
  } finally {
    f.cleanup();
  }
});

test("native failed slots retain captured physical settings after roster changes", async () => {
  const { fanOutComplete } =
    await import("../../../skills/dispatch/scripts/toolkit/fanout.ts");

  for (const failReserve of [true, false]) {
    const f = sessionFixture({ memory: true });

    try {
      const skill = path.join(f.root, "skill");
      fs.mkdirSync(skill);
      writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
      f.deps.skillRoot = skill;
      f.deps.orchestrator = { platform: "copilot", model: null };

      const primary = {
        ...rosterSlot("copilot[0]", "copilot", {
          native: true,
          model: "primary-model",
        }),
        effort: "high",
      };

      const reserve = {
        ...rosterSlot("copilot[1]", "copilot", {
          native: true,
          reserve: true,
          model: "reserve-model",
        }),
        index: 1,
        effort: "medium",
      };

      const roster = failReserve ? [primary, reserve] : [primary];

      const review = failReserve
        ? "code-failed-reserve"
        : "code-failed-primary";

      const dir = path.join(
        f.session,
        ".state",
        "reviews",
        review,
        "round-1",
        "gen-1"
      );

      const input = {
        dir,
        slots: roster,
        prompt: "question",
        validate: (value: string) => ({ ok: true as const, text: value }),
        sessionRoot: f.session,
      };

      const observer = defined(
        observeTool(f.session, "review", "run", undefined, f.deps)
      );

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const fanOutCompleteResult = await fanOutComplete(input, observer.deps);
      let native = fanOutCompleteResult.find((row) => row.state === "native");
      assert.ok(native?.state === "native");

      if (failReserve) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        const fanOutCompleteResult2 = await fanOutComplete(
          {
            ...input,
            nativeFailures: [
              {
                attempt: native.attempt,
                reason: "unavailable",
                reasonHash: "primary",
              },
            ],
          },
          observer.deps
        );

        native = fanOutCompleteResult2.find((row) => row.state === "native");
        assert.ok(native?.state === "native");
        assert.equal(native.model, "reserve-model");
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      const fanOutCompleteResult3 = await fanOutComplete(
        {
          ...input,
          nativeFailures: [
            {
              attempt: native.attempt,
              reason: "unavailable",
              reasonHash: "failed",
            },
          ],
        },
        observer.deps
      );

      const failed = fanOutCompleteResult3.find(
        (row) => row.slot === primary.slot
      );

      assert.equal(failed?.state, "failed");
      observer.finish({
        ok: false,
        exit: 4,
        reason: "refusal",
        summary: "failed",
        value: null,
      });

      const changedRoster = roster.map((slot) => ({
        ...slot,
        model: `changed-${slot.slot}`,
        effort: "low",
      }));

      saveRound({
        session: f.session,
        review,
        round: 1,
        roster: changedRoster,
        outcomes: [failed],
      });

      const row = defined(
        sessionFacts(
          f.session,
          { records: [], lastSeq: 0, torn: null },
          "complete"
        ).invocations.find(
          (invocation) =>
            invocation.surface === "native" && invocation.slot === primary.slot
        )
      );

      assert.deepEqual(
        [row.provider, row.model, row.effort, row.nativeState, row.outcome],
        [
          "copilot",
          failReserve ? "reserve-model" : "primary-model",
          failReserve ? "medium" : "high",
          "failed",
          "native-failed",
        ]
      );
    } finally {
      f.cleanup();
    }
  }
});

test("saved invalid and interrupted native fallback markers remain terminal", async (t) => {
  const { fanOutComplete } =
    await import("../../../skills/dispatch/scripts/toolkit/fanout.ts");

  const invalidFixture = sessionFixture({ memory: true });

  try {
    const skill = path.join(invalidFixture.root, "skill");
    fs.mkdirSync(skill);
    writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
    invalidFixture.deps.skillRoot = skill;
    invalidFixture.deps.orchestrator = { platform: "copilot", model: null };

    const primary = {
      ...rosterSlot("copilot[0]", "copilot", {
        native: true,
        model: "saved-model",
      }),
      effort: "high",
    };

    const review = "code-invalid-saved";

    const dir = path.join(
      invalidFixture.session,
      ".state",
      "reviews",
      review,
      "round-1",
      "gen-1"
    );

    const input = {
      dir,
      slots: [primary],
      prompt: "question",
      validate: (value: string) => ({ ok: true as const, text: value }),
      sessionRoot: invalidFixture.session,
    };

    const observer = defined(
      observeTool(
        invalidFixture.session,
        "review",
        "run",
        undefined,
        invalidFixture.deps
      )
    );

    const fanOutCompleteResult4 = await fanOutComplete(input, observer.deps);

    const launched = fanOutCompleteResult4.find(
      (row) => row.state === "native"
    );

    assert.ok(launched?.state === "native");
    fs.writeFileSync(launched.replyPath, "invalid reply");

    const fanOutCompleteResult5 = await fanOutComplete(
      {
        ...input,
        validate: () => ({
          ok: false as const,
          cls: "refusal" as const,
          reason: "invalid reply",
        }),
      },
      observer.deps
    );

    const invalid = fanOutCompleteResult5.find(
      (row) => row.slot === primary.slot
    );

    assert.ok(invalid?.state === "native");
    assert.equal(invalid.error, "invalid reply");
    saveRound({
      session: invalidFixture.session,
      review,
      round: 1,
      roster: [primary],
      outcomes: [invalid],
    });

    const row = defined(
      sessionFacts(
        invalidFixture.session,
        { records: [], lastSeq: 0, torn: null },
        "complete"
      ).invocations.find((invocation) => invocation.surface === "native")
    );

    assert.deepEqual(
      [row.model, row.effort, row.nativeState, row.outcome],
      ["saved-model", "high", "invalid", "native-invalid"]
    );

    fs.writeFileSync(launched.replyPath, "corrected reply");
    const nativeSlotPath = path.join(dir, "slots", `${primary.slot}.json`);
    const rename = fs.renameSync;

    const interruptedSave = Object.assign(new Error("interrupted done save"), {
      code: "EIO",
    });

    const interruptedRename = t.mock.method(
      fs,
      "renameSync",
      (from: fs.PathLike, to: fs.PathLike) => {
        if (to === nativeSlotPath) {
          throw interruptedSave;
        }

        rename(from, to);
      }
    );

    try {
      await assert.rejects(
        fanOutComplete(input, observer.deps),
        /interrupted done save/u
      );
    } finally {
      interruptedRename.mock.restore();
    }

    observer.finish({
      ok: false,
      exit: 4,
      reason: "native-pending",
      summary: "interrupted",
      value: null,
    });
    saveRound({
      session: invalidFixture.session,
      review,
      round: 1,
      roster: [primary],
      outcomes: [invalid],
    });

    const interrupted = defined(
      sessionFacts(
        invalidFixture.session,
        { records: [], lastSeq: 0, torn: null },
        "complete"
      ).invocations.find((invocation) => invocation.surface === "native")
    );

    assert.deepEqual(
      [
        interrupted.model,
        interrupted.effort,
        interrupted.nativeState,
        interrupted.outcome,
      ],
      ["saved-model", "high", "completed", "ok"]
    );
  } finally {
    invalidFixture.cleanup();
  }

  const fallbackFixture = sessionFixture({ memory: true });

  try {
    const skill = path.join(fallbackFixture.root, "skill");
    fs.mkdirSync(skill);
    writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
    fallbackFixture.deps.skillRoot = skill;
    fallbackFixture.deps.orchestrator = { platform: "copilot", model: null };

    const original = {
      ...rosterSlot("copilot[0]", "copilot", {
        native: true,
        model: "saved-model",
      }),
      effort: "high",
    };

    const replacement = {
      ...rosterSlot("copilot[1]", "copilot", {
        native: true,
        model: "replacement-model",
      }),
      index: 1,
    };

    const review = "code-interrupted-fallback";

    const dir = path.join(
      fallbackFixture.session,
      ".state",
      "reviews",
      review,
      "round-1",
      "gen-1"
    );

    const input = {
      dir,
      slots: [original],
      prompt: "question",
      validate: (value: string) => ({ ok: true as const, text: value }),
      sessionRoot: fallbackFixture.session,
    };

    const observer = defined(
      observeTool(
        fallbackFixture.session,
        "review",
        "run",
        undefined,
        fallbackFixture.deps
      )
    );

    const fanOutCompleteResult6 = await fanOutComplete(input, observer.deps);

    const launched = fanOutCompleteResult6.find(
      (row) => row.state === "native"
    );

    assert.ok(launched?.state === "native");

    const next = await fanOutComplete(
      {
        ...input,
        slots: [replacement],
        nativeFailures: [
          {
            attempt: launched.attempt,
            reason: "interrupted",
            reasonHash: "interrupted",
          },
        ],
      },
      observer.deps
    );

    const savedPath = path.join(dir, "slots", `${original.slot}.json`);
    const marked: unknown = JSON.parse(fs.readFileSync(savedPath, "utf-8"));
    assert.ok(isRecord(marked));
    const { slot: savedSlot, state, cliFallback } = marked;
    assert.equal(savedSlot, original.slot);
    assert.ok(typeof state === "string");
    assert.equal(cliFallback, true);

    const newPending = defined(
      next.find((row) => row.slot === replacement.slot)
    );

    observer.finish({
      ok: false,
      exit: 4,
      reason: "native-pending",
      summary: "fallback interrupted",
      value: null,
    });

    const changedOriginal = {
      ...original,
      model: "changed-roster-model",
      effort: "low",
    };

    saveRound({
      session: fallbackFixture.session,
      review,
      round: 1,
      roster: [changedOriginal, replacement],
      outcomes: [{ ...marked, slot: savedSlot, state }, newPending],
    });

    const row = defined(
      sessionFacts(
        fallbackFixture.session,
        { records: [], lastSeq: 0, torn: null },
        "complete"
      ).invocations.find(
        (invocation) =>
          invocation.surface === "native" && invocation.slot === original.slot
      )
    );

    assert.deepEqual(
      [row.model, row.effort, row.nativeState, row.outcome],
      ["saved-model", "high", "failed", "native-failed"]
    );
  } finally {
    fallbackFixture.cleanup();
  }
});

const rosterSlot = (
  slot: string,
  provider: string,
  options: { native?: boolean; reserve?: boolean; model?: string } = {}
) => ({
  slot,
  provider,
  index: 0,
  native: options.native ?? false,
  reserve: options.reserve ?? false,
  model: options.model ?? "model-a",
});

const finding = (
  id: string,
  marker: {
    recurrence?: { of: string };
    unresolved?: { of: string };
    severity?: string;
    sources?: string[];
  } = {}
) => ({
  id,
  severity: marker.severity ?? "SHOULD",
  category: "correctness",
  locus: "scripts/dispatch.ts:L1",
  defect: `Finding ${id} describes a repeat`,
  requiredChange: `Resolve ${id}`,
  sources: marker.sources ?? ["claude[0]"],
  scope: "in",
  ...(marker.recurrence && { recurrence: marker.recurrence }),
  ...(marker.unresolved && { unresolved: marker.unresolved }),
});

const slotFile = (
  reviewDir: string,
  round: number,
  slot: string,
  generation = 1
) =>
  path.join(
    reviewDir,
    `round-${round}`,
    `gen-${generation}`,
    "slots",
    `${slot}.json`
  );

const roundSubject = (
  session: string,
  review: string,
  round: number,
  generation = 1
) =>
  crypto
    .createHash("sha256")
    .update(
      path.join(
        session,
        ".state",
        "reviews",
        review,
        `round-${round}`,
        `gen-${generation}`
      )
    )
    .digest("hex")
    .slice(0, 16);

const captureRuns = (session: string, invocations: unknown[]) => {
  writeJson(path.join(session, ".state", "diagnostics", "run-1.json"), {
    capture: { state: "completed", start: 0, end: 1 },
    phases: [],
    invocations,
    reviews: [],
  });
};

test("diagnostic storage failure preserves durable attempts and reports one bounded failure", async (t) => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill);
    writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
    f.deps.skillRoot = skill;
    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.delegate = () =>
      Promise.resolve({
        outcome: {
          status: "ok",
          text: "answer",
          resume: null,
          sessionId: null,
        },
        invocations: [
          {
            provider: "claude",
            model: "m",
            effort: null,
            mode: "cli",
            launched: true,
            outcome: "ok",
          },
        ],
      });

    const observer = defined(
      observeTool(f.session, "ask", "run", undefined, f.deps)
    );

    const dir = path.join(f.session, "work");
    await observer.deps.delegate(
      "claude",
      requestForLog(path.join(dir, "logs", "claude[0].log")),
      "cli"
    );

    const directory = path.join(f.session, ".state", "diagnostics");
    const file = path.join(directory, defined(fs.readdirSync(directory)[0]));

    const previous = fs.readFileSync(file);

    const rename = fs.renameSync;
    const write = fs.writeFileSync;

    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
    t.mock.method(fs, "renameSync", ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === file) {
        throw new Error("rename failure");
      }

      rename(from, to);
    }) as typeof fs.renameSync);
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
    t.mock.method(fs, "writeFileSync", ((
      target: fs.PathOrFileDescriptor,
      ...args: unknown[]
    ) => {
      if (String(target) === file) {
        write(file, "{partial");
        throw new Error("partial write");
      }

      //oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- test fixture establishes this shape before the assertion; test restores the static fixture type the double was built with; the runtime shape is asserted below
      (write as (...args: unknown[]) => void)(target, ...args);
    }) as typeof fs.writeFileSync);
    defined(defined(observer).deps.diagnostics)({
      kind: "routing",
      state: "stop",
      subject: dir,
      slot: "claude[0]",
      provider: "claude",
      model: "m",
      attempt: 1,
    });
    assert.deepEqual(
      fs.readFileSync(file),
      previous,
      "failed optional update cannot truncate the durable capture"
    );
    const fold = { records: [], lastSeq: 0, torn: null };
    let facts = sessionFacts(f.session, fold, "complete");
    assert.equal(facts.invocations.length, 1);
    assert.equal(facts.collection?.storageFailed, 1);
    t.mock.restoreAll();
    observer.finish({ ok: true, exit: 0, summary: "done", value: null });
    facts = sessionFacts(f.session, fold, "complete");
    assert.equal(facts.invocations.length, 1);
    assert.equal(
      facts.collection?.storageFailed,
      1,
      "capture and marker describe one storage failure"
    );
  } finally {
    t.mock.restoreAll();
    f.cleanup();
  }
});

test("diagnostics persist unlaunched failures and CLI fallback consequences independently", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill);
    writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
    f.deps.skillRoot = skill;
    f.deps.modes = () => [];

    const first = defined(
      observeTool(f.session, "ask", "run", undefined, f.deps)
    );

    await fanOut(
      {
        dir: path.join(f.session, "unlaunched"),
        slots: [
          rosterSlot("claude[0]", "claude"),
          rosterSlot("codex[0]", "codex", { native: true }),
        ],
        prompt: "question",
        validate: () => ({ ok: true }),
      },
      first.deps
    );
    first.finish({
      ok: false,
      exit: 4,
      reason: "native-pending",
      summary: "pending",
      value: null,
    });
    const fold = { records: [], lastSeq: 0, torn: null };
    let facts = sessionFacts(f.session, fold, "pending");
    const unlaunched = facts.invocations.find((i) => i.surface === "cli");
    assert.equal(unlaunched?.outcome, "not-found");
    assert.equal(unlaunched.launched, false);
    assert.equal(unlaunched.routingOutcome, "stop");
    assert.equal(unlaunched.slotState, "failed");
    assert.equal(unlaunched.usage, undefined);
    assert.equal(unlaunched.durationMs, undefined);
    assert.equal(
      facts.invocations.filter((i) => i.slot === "codex[0]").length,
      1,
      "configured native work does not fabricate a CLI row"
    );
    f.deps.modes = () => ["cli"];

    const cooldown = defined(
      observeTool(f.session, "ask", "run", undefined, f.deps)
    );

    await fanOut(
      {
        dir: path.join(f.session, "cooldown"),
        slots: [rosterSlot("copilot[0]", "copilot")],
        prompt: "question",
        validate: () => ({ ok: true }),
        quota: {
          schemaVersion: 1,
          policyVersion: 1,
          decidedAt: 0,
          decisions: [
            {
              key: { provider: "copilot", model: "model-a", mode: "cli" },
              generation: null,
              skipped: true,
              reason: "quota-cooldown",
              observedAt: 0,
              expiresAt: 3_600_000,
            },
          ],
        },
      },
      cooldown.deps
    );
    cooldown.finish({
      ok: false,
      exit: 2,
      reason: "ask-failed",
      summary: "failed",
      value: null,
    });

    const skipped = sessionFacts(f.session, fold, "pending").invocations.find(
      (i) => i.provider === "copilot"
    );

    assert.equal(skipped?.outcome, "quota");
    assert.equal(skipped?.launched, false);
    assert.equal(skipped?.routingOutcome, "stop");
    assert.equal(skipped?.slotState, "failed");
    f.deps.modes = () => ["cli"];
    f.deps.orchestrator = { platform: "agy", model: null };
    // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
    f.deps.delegate = async () => ({
      outcome: { status: "fail", cls: "auth", detail: "private" },
      invocations: [
        {
          provider: "claude",
          model: "model-a",
          effort: null,
          mode: "cli",
          launched: true,
          outcome: "auth",
          durationMs: 10,
        },
      ],
    });

    const second = defined(
      observeTool(f.session, "ask", "run", undefined, f.deps)
    );

    await fanOut(
      {
        dir: path.join(f.session, "fallback"),
        slots: [rosterSlot("claude[0]", "claude")],
        prompt: "question",
        validate: () => ({ ok: true }),
      },
      second.deps
    );
    second.finish({
      ok: false,
      exit: 2,
      reason: "ask-failed",
      summary: "failed",
      value: null,
    });
    facts = sessionFacts(f.session, fold, "pending");
    const cli = facts.invocations.find((i) => i.launched);
    assert.equal(cli?.routingOutcome, "stop");
    assert.equal(cli?.slotState, "failed");
    const report = fs.readFileSync(writeDiagnostics(f.session, facts), "utf-8");
    assert.match(report, /not-found.*routing stop.*slot failed.*not launched/u);
    assert.match(report, /auth.*routing stop.*slot failed/u);
  } finally {
    f.cleanup();
  }
});

test("diagnostics distinguish healthy observed captures from absent and damaged collection", () => {
  const f = sessionFixture({ memory: true });

  try {
    const fold = { records: [], lastSeq: 0, torn: null };

    const render = () =>
      fs.readFileSync(
        writeDiagnostics(f.session, sessionFacts(f.session, fold, "complete")),
        "utf-8"
      );

    assert.match(render(), /Collection health: unknown/u);
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill);
    writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
    f.deps.skillRoot = skill;

    const observer = defined(
      observeTool(f.session, "ask", "run", undefined, f.deps)
    );

    assert.match(render(), /Collection health: partial/u);
    observer.finish({ ok: true, exit: 0, summary: "done", value: null });
    assert.match(
      render(),
      /Collection health: complete for observed captures/u
    );
    assert.equal(
      sessionFacts(f.session, fold, "complete").collection?.completed,
      1
    );
    fs.writeFileSync(
      path.join(f.session, ".state", "diagnostics", "bad.json"),
      "{bad"
    );
    assert.match(render(), /Collection health: partial/u);
  } finally {
    f.cleanup();
  }
});

test("diagnostics aggregate subjects provenance and partial collection deterministically", () => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill);
    f.deps.skillRoot = skill;
    const fold = { records: [], lastSeq: 0, torn: null };
    let now = 0;
    f.deps.clock = () => now;

    for (const [version, concurrency] of [
      ["1.2.3", 2],
      ["1.2.4", 3],
    ] as const) {
      fs.writeFileSync(path.join(skill, "SKILL.md"), `skill ${version}`);
      writeJson(path.join(skill, "skill-hashes.json"), { $version: version });
      writeJson(path.join(skill, "config.jsonc"), {
        diagnostics: true,
        "write-concurrency": concurrency,
      });

      const o = defined(
        observeTool(f.session, "ask", "run", undefined, f.deps)
      );

      now += 1000;
      o.finish({
        ok: concurrency === 2,
        exit: concurrency === 2 ? 0 : 4,
        reason: "native-pending",
        summary: "done",
        value: null,
      });
    }

    const directory = path.join(f.session, ".state", "diagnostics");
    const files = fs.readdirSync(directory);

    const captures = files.map((file) =>
      readCapture(path.join(directory, file))
    );

    const versions = captures.map((capture) => capture["version"]);
    assert.equal(versions.length, 2);
    assert.deepEqual(new Set(versions), new Set(["1.2.3", "1.2.4"]));
    assert.notEqual(captures[0]?.["build"], captures[1]?.["build"]);

    for (const capture of captures) {
      const { version } = capture;
      assert.equal(typeof version, "string");

      const contentHash = crypto
        .createHash("sha256")
        .update(`skill ${narrow(version, text)}`)
        .digest("hex");

      const build = crypto
        .createHash("sha256")
        .update(JSON.stringify([["SKILL.md", contentHash]]))
        .digest("hex")
        .slice(0, 12);

      assert.equal(
        capture["build"],
        build,
        "stored build measures the collecting tree"
      );
    }

    const nativeDir = path.join(
      f.session,
      ".state",
      "asks",
      "subject",
      "attempt-1"
    );

    for (const state of ["pending", "completed", "completed"] as const) {
      const o = defined(
        observeTool(f.session, "ask", "run", undefined, f.deps)
      );

      defined(defined(o).deps.diagnostics)({
        kind: "native",
        subject: nativeDir,
        slot: "codex[0]",
        provider: "codex",
        model: "m",
        attempt: state === "pending" ? 1 : 0,
        state,
        replay: state === "completed",
      });
      o.finish({ ok: true, exit: 0, summary: "done", value: null });
    }

    fs.writeFileSync(path.join(directory, "corrupt.json"), "{bad");
    writeJson(path.join(directory, "invalid.json"), null);
    writeJson(path.join(directory, "open.json"), {
      phases: [],
      invocations: [],
      reviews: [],
      capture: { state: "opened", start: 0 },
    });
    saveRound({
      session: f.session,
      review: "code-alpha",
      round: 1,
      roster: [rosterSlot("codex[0]", "codex", { native: true })],
      outcomes: [{ slot: "codex[0]", state: "done" }],
      findings: [finding("F1", { recurrence: { of: "F0" } })],
    });
    saveRound({
      session: f.session,
      review: "plan-beta",
      round: 1,
      roster: [],
      outcomes: [],
      findings: [],
    });

    const broken = path.join(
      f.session,
      ".state",
      "reviews",
      "bad",
      "round-1",
      "round.json"
    );

    fs.mkdirSync(path.dirname(broken), { recursive: true });
    fs.writeFileSync(broken, "{bad");
    const facts = sessionFacts(f.session, fold, "complete");
    assert.equal(facts.provenance?.length, 3);
    assert.deepEqual(
      facts.provenance
        ?.filter((p) => (p.version ?? "").length > 0)
        .map((p) => [p.version, p.config?.["write-concurrency"]])
        .toSorted((left, right) =>
          narrow(left[0], text).localeCompare(narrow(right[0], text))
        ),
      [
        ["1.2.3", 2],
        ["1.2.4", 3],
      ]
    );
    assert.ok((facts.collection?.corrupt ?? 0) >= 3);
    assert.equal(facts.collection?.incomplete, 1);
    assert.equal(facts.phases.find((p) => p.name === "ask")?.outcome, "mixed");
    assert.equal(facts.phases.find((p) => p.name === "ask")?.wallMs, 2000);
    assert.equal(
      facts.invocations.filter((i) => i.surface === "native").length,
      2,
      "native replay and later completion share one logical slot"
    );
    assert.ok(
      facts.invocations
        .filter((i) => i.surface === "native")
        .every((i) => i.nativeState === "completed" && !i.launched && !i.usage)
    );
    assert.equal(facts.retroState, "missing");
    writeJson(path.join(f.session, ".state", "retro.json"), {});
    assert.equal(
      sessionFacts(f.session, fold, "complete").retroState,
      "invalid"
    );
    fs.rmSync(path.join(f.session, ".state", "retro.json"));
    fs.mkdirSync(path.join(f.session, ".state", "retro.json"));
    assert.equal(
      sessionFacts(f.session, fold, "complete").retroState,
      "unreadable"
    );
    assert.equal(
      facts.invocations.find((i) => i.surface === "native")?.nativeState,
      "completed"
    );
    const report = fs.readFileSync(writeDiagnostics(f.session, facts), "utf-8");
    assert.match(report, /code review/u);
    assert.match(report, /plan review/u);
    assert.match(report, /subject [a-f0-9]{16}/u);
    assert.match(report, /unknown historical/u);

    for (let i = 0; i < files.length; i += 1) {
      fs.renameSync(
        path.join(directory, defined(files[i])),
        path.join(directory, `shuffled-${files.length - i}.json`)
      );
    }

    assert.deepEqual(
      sessionFacts(f.session, fold, "complete").phases,
      facts.phases
    );
  } finally {
    f.cleanup();
  }
});

test("diagnostics detect toolkit rejection and writer relaunch evidence", () => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill);
    writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
    f.deps.skillRoot = skill;

    for (const reason of [
      "native-pending",
      "approval-required",
      "invalid-record",
      "invalid-record",
    ]) {
      defined(
        observeTool(f.session, "record", "append", undefined, f.deps)
      ).finish({
        ok: false,
        exit: 4,
        reason,
        summary: "private",
        value: null,
      });
    }

    const records = [
      ["A", "launched", "one"],
      ["B", "launched", "two"],
      ["A", "launched", "three"],
    ].map(([task, phase, key], n) => ({
      seq: n + 1,
      key: defined(key),
      at: "2026-01-01T00:00:00Z",
      kind: "writer",
      by: "tool",
      data: {
        task,
        phase,
        path: key,
        base: {
          commit: "a".repeat(40),
          seq: 0,
          taskSection: `sha256:${"b".repeat(64)}`,
        },
      },
    }));

    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
    const fold = {
      records: records.slice(0, 2),
      lastSeq: 2,
      torn: null,
    } as Fold;

    assert.equal(sessionFacts(f.session, fold, "complete").relaunches, 0);
    fold.records = records;
    fold.lastSeq = 3;
    const facts = sessionFacts(f.session, fold, "complete");
    assert.equal(facts.relaunches, 1);
    assert.deepEqual(facts.rejectedTools, [
      { tool: "record", action: "append", cls: "invalid-record" },
      { tool: "record", action: "append", cls: "invalid-record" },
    ]);
    const report = fs.readFileSync(writeDiagnostics(f.session, facts), "utf-8");
    assert.match(report, /toolkit operation.*rejected/u);
    assert.doesNotMatch(report, /- Source: H9/u);
    assert.match(report, /writer relaunches 1/u);
    assert.equal(facts.verb, "implement");
    assert.equal(
      sessionFacts(f.session, { ...fold, records: [] }, "complete").verb,
      undefined
    );
    assert.doesNotMatch(report, /defective writer|private/u);
  } finally {
    f.cleanup();
  }
});

test("session diagnostics include producer rounds, invocations, and gated retro findings", () => {
  const fixture = sessionFixture({ memory: true });
  const empty = sessionFixture({ memory: true });

  try {
    const a = "review-alpha";
    const first = [finding("F001"), finding("F002")];

    const reraised = [
      finding("F003", { recurrence: { of: "F001" } }),
      finding("F004", { unresolved: { of: "F002" } }),
    ];

    saveRound({
      session: fixture.session,
      review: a,
      round: 1,
      roster: [rosterSlot("claude[0]", "claude"), rosterSlot("agy[0]", "agy")],
      outcomes: [
        { slot: "claude[0]", state: "done", text: "review complete" },
        {
          slot: "agy[0]",
          state: "failed",
          cls: "timeout",
          reason: "review timed out",
        },
      ],
      findings: first,
    });
    saveRound({
      session: fixture.session,
      review: a,
      round: 2,
      roster: [
        rosterSlot("claude[0]", "claude"),
        rosterSlot("copilot[0]", "copilot", { reserve: true }),
      ],
      outcomes: [
        {
          slot: "claude[0]",
          state: "failed",
          cls: "config",
          reason: "provider unavailable",
        },
        { slot: "copilot[0]", state: "done", text: "reserve review complete" },
      ],
      findings: reraised,
    });
    saveRound({
      session: fixture.session,
      review: a,
      round: 3,
      roster: [rosterSlot("codex[0]", "codex", { native: true })],
      outcomes: [
        {
          slot: "codex[0]",
          state: "native",
          promptPath: "prompts/codex[0].md",
          replyPath: "replies/codex[0].md",
        },
      ],
    });
    saveRound({
      session: fixture.session,
      review: "review-beta",
      round: 1,
      roster: [rosterSlot("agy[0]", "agy"), rosterSlot("claude[0]", "claude")],
      outcomes: [
        {
          slot: "agy[0]",
          state: "failed",
          cls: "not-found",
          reason: "provider missing",
        },
        {
          slot: "claude[0]",
          state: "failed",
          cls: "timeout",
          reason: "review timed out",
        },
      ],
    });

    const observations = [
      {
        id: "retro-1",
        component: "references/toolkit.md",
        category: "correctness",
        evidence: "One bounded observation.",
        impact: "One review repeated work.",
        proposedFix: "Use the prior ruling.",
      },
      {
        id: "retro-2",
        component: "outside-component.ts",
        category: "correctness",
        evidence: "Invalid component.",
        impact: "Not dispatch owned.",
        proposedFix: "No change.",
      },
    ];

    writeJson(path.join(fixture.session, ".state", "retro.json"), observations);

    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
    const fold = {
      records: [
        {
          seq: 1,
          key: "ruling-1",
          at: "2026-01-01T00:00:00Z",
          kind: "ruling",
          by: "tool",
          data: {
            subject: "review:review-alpha:F001",
            ruling: "accepted",
            rationale: "Matches the bound rules.",
          },
        },
        {
          seq: 2,
          key: "ruling-2",
          at: "2026-01-01T00:00:01Z",
          kind: "ruling",
          by: "tool",
          data: {
            subject: "review:review-alpha:F002",
            ruling: "rejected",
            rationale: "Outside the requirement.",
          },
        },
      ],
      lastSeq: 2,
      torn: null,
    } as Fold;

    const rounds = readReviews(fixture.session);
    assert.deepEqual(
      rounds.map((round) => [round.review, round.round]),
      [
        ["review-alpha", 1],
        ["review-alpha", 2],
        ["review-alpha", 3],
        ["review-beta", 1],
      ]
    );
    assert.equal(rounds[0]?.findings?.findings?.length, 2);
    assert.equal(rounds[2]?.findings, null);
    assert.equal(rounds[3]?.findings, null);

    const facts = sessionFacts(fixture.session, fold, "pass");
    assert.deepEqual(facts.reviews, [
      {
        phase: defined(facts.reviews[0]).phase,
        round: 1,
        cap: 4,
        accepted: 1,
        rejected: 1,
        recurring: 0,
      },
      {
        phase: defined(facts.reviews[0]).phase,
        round: 2,
        cap: 4,
        accepted: 0,
        rejected: 0,
        recurring: 2,
        reraised: ["F001", "F002"],
      },
    ]);
    assert.deepEqual(facts.observations, observations);
    assert.equal(facts.phases.length, 2);
    assert.ok(facts.phases.every((p) => p.name === "code review"));
    assert.deepEqual(facts.rejectedTools, []);

    const invocations = [...facts.invocations].toSorted((left, right) =>
      `${left.phase}:${left.slot}:${left.outcome}`.localeCompare(
        `${right.phase}:${right.slot}:${right.outcome}`
      )
    );

    assert.deepEqual(
      invocations.map(({ phase, slot, outcome, launched, surface }) => ({
        phase,
        slot,
        outcome,
        launched,
        surface,
      })),
      [
        {
          phase: defined(facts.reviews[0]).phase,
          slot: "codex[0]",
          outcome: "native-pending",
          launched: false,
          surface: "native",
        },
      ]
    );
    assert.equal(invocations[0]?.provider, "codex");

    const outputPath = writeDiagnostics(fixture.session, facts);
    assert.equal(path.basename(outputPath), "diagnostics.md");
    const report = fs.readFileSync(outputPath, "utf-8");
    assert.ok(report.startsWith("# Dispatch diagnostics"));
    assert.match(report, /Host retro: collected · 1 accepted · 1 rejected/u);
    assert.match(report, /Review convergence/u);
    assert.match(report, /F001/u);

    fs.writeFileSync(
      path.join(fixture.session, ".state", "retro.json"),
      "{invalid"
    );
    const malformedRetroFacts = sessionFacts(fixture.session, fold, "pass");
    assert.equal("observations" in malformedRetroFacts, false);

    const malformedRetroPath = writeDiagnostics(
      fixture.session,
      malformedRetroFacts
    );

    assert.match(
      fs.readFileSync(malformedRetroPath, "utf-8"),
      /Host retro: malformed/u
    );

    const emptyRounds = readReviews(empty.session);

    const emptyFacts = sessionFacts(
      empty.session,
      { records: [], lastSeq: 0, torn: null },
      "pass"
    );

    assert.deepEqual(emptyRounds, []);
    assert.deepEqual(emptyFacts.reviews, []);
    assert.deepEqual(emptyFacts.invocations, []);
    const emptyPath = writeDiagnostics(empty.session, emptyFacts);
    assert.match(fs.readFileSync(emptyPath, "utf-8"), /Host retro: missing/u);
  } finally {
    empty.cleanup();
    fixture.cleanup();
  }
});

test("review JSON errors identify malformed round, findings, and slot files", () => {
  const malformedFile = [
    (session: string) => {
      const file = path.join(
        session,
        ".state",
        "reviews",
        "round-review",
        "round-1",
        "round.json"
      );

      fs.mkdirSync(path.dirname(file), { recursive: true });

      return file;
    },
    (session: string) => {
      saveRound({
        session,
        review: "findings-review",
        round: 1,
        roster: [],
        outcomes: [],
      });

      return path.join(
        session,
        ".state",
        "reviews",
        "findings-review",
        "round-1",
        "findings.json"
      );
    },
    (session: string) => {
      saveRound({
        session,
        review: "slot-review",
        round: 1,
        roster: [rosterSlot("claude[0]", "claude")],
        outcomes: [
          { slot: "claude[0]", state: "done", text: "review complete" },
        ],
      });

      return slotFile(
        path.join(session, ".state", "reviews", "slot-review"),
        1,
        "claude[0]"
      );
    },
  ];

  for (const createPath of malformedFile) {
    const fixture = sessionFixture({ memory: true });

    try {
      const file = createPath(fixture.session);
      fs.writeFileSync(file, "{invalid");
      assert.throws(
        () => readReviews(fixture.session),
        // oxlint-disable-next-line promise/prefer-await-to-callbacks -- assert.throws validator must stay synchronous; an async rewrite would change the assertion contract
        (error: unknown) =>
          error instanceof ToolError &&
          error.exit === 2 &&
          error.reason === "review-corrupt" &&
          error.message.includes(file)
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("enabled toolkit diagnostics retain attempts, normalized usage, time and reserve identity without replay duplication", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, "config.jsonc"), '{"diagnostics":true}');
    f.deps.skillRoot = skill;
    let now = 0;
    f.deps.clock = () => now;
    // eslint-disable-next-line typescript/promise-function-async -- mock returns a Promise; async would require a no-op await
    f.deps.delegate = (provider, request, mode) => {
      now += 1200;

      const outcome =
        provider === "claude"
          ? {
              status: "fail" as const,
              cls: "auth" as const,
              detail: "private failure",
            }
          : {
              status: "ok" as const,
              text: "private answer",
              sessionId: null,
              resume: null,
            };

      return Promise.resolve({
        outcome,
        invocations: [
          {
            provider,
            model: request.model,
            effort: request.effort,
            mode,
            launched: true,
            durationMs: 1200,
            outcome: outcome.status === "ok" ? "ok" : "auth",
            usage: {
              input: 100,
              cacheRead: 40,
              output: 10,
              scope: "invocation",
              provenance: "private provenance",
              inputSemantics: "includes-cache",
              actualModels: ["actual-model"],
            },
          },
        ],
      });
    };

    f.deps.handler = async ({ deps }) => {
      const value = await fanOut(
        {
          dir: path.join(f.session, ".state", "ask"),
          slots: [
            { ...rosterSlot("claude[0]", "claude"), index: 0 },
            {
              ...rosterSlot("copilot[0]", "copilot", { reserve: true }),
              index: 0,
            },
          ],
          prompt: "private question",
          validate: () => ({ ok: true }),
        },
        deps
      );

      return { ok: true, exit: 0, summary: "done", value };
    };

    for (let i = 0; i < 2; i += 1) {
      f.lines.length = 0;
      assert.equal(
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await main(
          ["ask", "run", "--session", f.session, "--host", "claude"],
          f.deps
        ),
        0
      );
    }

    const facts = sessionFacts(
      f.session,
      { records: [], lastSeq: 0, torn: null },
      "complete"
    );

    assert.deepEqual(
      facts.invocations.map((i) => [
        i.provider,
        i.model,
        i.outcome,
        i.durationMs,
        i.usage?.input,
        i.usage?.cacheRead,
        i.usage?.output,
      ]),
      [
        ["claude", "model-a", "auth", 1200, 60, 40, 10],
        ["copilot", "model-a", "ok", 1200, 60, 40, 10],
      ]
    );
    assert.deepEqual(
      facts.invocations.map((i) => i.reportedModels),
      [["actual-model"], ["actual-model"]]
    );
    assert.equal(
      facts.phases.reduce((n, p) => n + (p.wallMs ?? 0), 0),
      2400
    );
    const dir = path.join(f.session, ".state", "diagnostics");

    const bytes = fs
      .readdirSync(dir)
      .map((file) => fs.readFileSync(path.join(dir, file), "utf-8"))
      .join("");

    assert.doesNotMatch(bytes, /private|promptPath|logPath|sessionId/u);
  } finally {
    f.cleanup();
  }
});

test("disabled toolkit diagnostics add no fields or artifacts and diagnostic I/O cannot change a result", async () => {
  for (const enabled of [false, true]) {
    const f = sessionFixture({ memory: true });

    try {
      const skill = path.join(f.root, "skill");
      fs.mkdirSync(skill);
      fs.writeFileSync(
        path.join(skill, "config.jsonc"),
        JSON.stringify({ diagnostics: enabled })
      );
      f.deps.skillRoot = skill;

      if (enabled) {
        fs.mkdirSync(path.join(f.session, ".state"), { recursive: true });
        fs.writeFileSync(
          path.join(f.session, ".state", "diagnostics"),
          "blocked"
        );
      }

      // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
      f.deps.handler = async ({ deps }) => {
        assert.equal(deps.delegate === f.deps.delegate, !enabled);

        return {
          ok: false,
          exit: 4,
          reason: "native-pending",
          summary: "pending",
          value: { pending: [] },
        };
      };

      assert.equal(
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
        await main(
          ["review", "run", "--session", f.session, "--host", "codex"],
          f.deps
        ),
        4
      );
      assert.equal(f.output().reason, "native-pending");
      assert.doesNotMatch(defined(f.lines[0]), /diagnostic|retro/u);

      if (!enabled) {
        assert.equal(
          fs.existsSync(path.join(f.session, ".state", "diagnostics")),
          false
        );
      }
    } finally {
      f.cleanup();
    }
  }
});

test("diagnostics keep durable attempts across a later crash and exclude cumulative or unlaunched usage", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, "config.jsonc"), '{"diagnostics":true}');
    f.deps.skillRoot = skill;
    let now = 0;
    f.deps.clock = () => now;
    // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
    f.deps.delegate = async () => {
      now += 1500;

      return {
        outcome: {
          status: "ok",
          text: "answer",
          resume: null,
          sessionId: null,
        },
        invocations: [
          {
            provider: "codex",
            model: "first",
            effort: "high",
            mode: "cli",
            launched: false,
            outcome: "config",
            usage: {
              input: 90,
              output: 10,
              scope: "invocation",
              provenance: "test",
              inputSemantics: "uncached",
            },
          },
          {
            provider: "codex",
            model: "second",
            effort: "high",
            mode: "cli",
            launched: true,
            outcome: "ok",
            durationMs: 1500,
            usage: {
              input: 90,
              output: 10,
              scope: "session-cumulative",
              provenance: "test",
              inputSemantics: "uncached",
            },
          },
        ],
      };
    };

    f.deps.handler = async ({ deps }) => {
      await deps.delegate(
        "codex",
        {
          promptPath: "unused",
          model: "second",
          effort: "high",
          sandbox: true,
          schemaPath: null,
          resume: null,
          cwd: f.root,
          timeoutMs: 10_000,
          outputCapBytes: 1024,
          attachments: [],
          logPath: "codex[0].log",
          briefPath: "unused",
        },
        "cli"
      );

      const facts = sessionFacts(
        f.session,
        { records: [], lastSeq: 0, torn: null },
        "running"
      );

      assert.equal(
        facts.invocations.length,
        2,
        "attempts persisted before handler completion"
      );
      throw new Error("after durable slot boundary");
    };

    assert.equal(
      await main(
        [
          "review",
          "run",
          "example.plan.md",
          "--session",
          f.session,
          "--host",
          "codex",
        ],
        f.deps
      ),
      2
    );
    const dir = path.join(f.session, ".state", "diagnostics");
    fs.writeFileSync(path.join(dir, "corrupt.json"), "{invalid");

    const facts = sessionFacts(
      f.session,
      { records: [], lastSeq: 0, torn: null },
      "fault"
    );

    assert.equal(facts.invocations.length, 2);
    assert.ok(facts.invocations.every((i) => i.usage === undefined));
    assert.deepEqual(
      facts.invocations.map((i) => [i.model, i.mode, i.effort, i.launched]),
      [
        ["first", "cli", "high", false],
        ["second", "cli", "high", true],
      ]
    );
    assert.equal(facts.phases[0]?.name, "plan review");
    assert.equal(facts.phases[0]?.outcome, "fault");
    const report = fs.readFileSync(writeDiagnostics(f.session, facts), "utf-8");
    assert.match(report, /delegates 0\/1/u);
    assert.match(report, /Timing scope: summed tool-call durations/u);
  } finally {
    f.cleanup();
  }
});

test("diagnostics preserve exception attempts and durable capture boundaries", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, "config.jsonc"), '{"diagnostics":true}');
    f.deps.skillRoot = skill;

    const error = Object.assign(new Error("private error"), {
      invocations: [
        {
          provider: "claude",
          model: "m",
          mode: "cli",
          launched: true,
          outcome: "ok",
        },
      ],
    });

    f.deps.delegate = () => {
      throw error;
    };

    const observer = defined(
      observeTool(f.session, "ask", "run", undefined, f.deps)
    );

    const directory = path.join(f.session, ".state", "diagnostics");
    const files = fs.readdirSync(directory);
    const [file] = files;
    assert.equal(files.length, 1);
    assert.ok((file ?? "").length > 0);
    await assert.rejects(
      observer.deps.delegate(
        "claude",
        requestForLog(path.join(f.session, "logs", "claude[0].log")),
        "cli"
      ),
      (e) => e === error
    );
    const opened = readCapture(path.join(directory, defined(file)));
    assert.ok(Array.isArray(opened["invocations"]));
    assert.equal(opened["invocations"].length, 1);
    assert.ok(isRecord(opened["capture"]));
    assert.equal(opened["capture"]["state"], "opened");
    observer.finish({
      ok: false,
      exit: 2,
      reason: "invalid-input",
      summary: "private",
      value: null,
    });
    const completed = readCapture(path.join(directory, defined(file)));
    assert.ok(isRecord(completed["capture"]));
    assert.equal(completed["capture"]["state"], "completed");
    assert.deepEqual(completed["rejectedTools"], [
      { tool: "ask", action: "run", cls: "invalid-input" },
    ]);
    assert.doesNotMatch(JSON.stringify(completed), /private/u);
  } finally {
    f.cleanup();
  }
});

test("host phase milestones order reviews and attribute host usage and slot yield", () => {
  // design-led milestones enter plan after the last design review and implementation at the earlier launch
  {
    const basic: Fold = {
      records: [
        {
          seq: 1,
          key: "confirm",
          by: "user",
          kind: "confirm",
          at: isoTime(1),
          data: {},
        },
      ],
      lastSeq: 1,
      torn: null,
    };

    assert.deepEqual(stageMilestones(basic, [], 0), [
      { stage: "spec", atMs: 0 },
      { stage: "plan", atMs: 1 },
    ]);

    const fold: Fold = {
      records: [
        {
          seq: 1,
          key: "confirm",
          by: "user",
          kind: "confirm",
          at: isoTime(2),
          data: {},
        },
        {
          seq: 2,
          key: "writer",
          by: "tool",
          kind: "writer",
          at: isoTime(9),
          data: { phase: "launched" },
        },
        {
          seq: 3,
          key: "approval",
          by: "user",
          kind: "approval",
          at: isoTime(10),
          data: {},
        },
      ],
      lastSeq: 3,
      torn: null,
    };

    const stages = stageMilestones(
      fold,
      [
        stageCapture("design review", 3, 4),
        stageCapture("design review", 5, 6),
        stageCapture("plan review", 7, 8),
      ],
      1
    );

    assert.deepEqual(stages, [
      { stage: "spec", atMs: 1 },
      { stage: "design", atMs: 2 },
      { stage: "design review", atMs: 3 },
      { stage: "plan", atMs: 6 },
      { stage: "plan review", atMs: 7 },
      { stage: "implementation", atMs: 9 },
    ]);
    assert.deepEqual(
      stageMilestones(
        { records: [], lastSeq: 0, torn: null },
        [stageCapture("design review", 3, 4)],
        1
      ),
      [{ stage: "design review", atMs: 1 }]
    );
  }

  // host phase: sessionFacts builds phase milestones including interleaved A, B, A review subjects
  {
    const f = sessionFixture({ memory: true });

    try {
      const reviewA = path.join(
        f.session,
        ".state",
        "reviews",
        "code-a",
        "round-1"
      );

      const reviewB = path.join(
        f.session,
        ".state",
        "reviews",
        "code-b",
        "round-1"
      );

      fs.mkdirSync(path.join(reviewA, "gen-1", "slots"), { recursive: true });
      fs.mkdirSync(path.join(reviewB, "gen-1", "slots"), { recursive: true });
      fs.writeFileSync(
        path.join(reviewA, "round.json"),
        JSON.stringify({
          round: 1,
          generation: 1,
          cap: 2,
          roster: [
            {
              slot: "claude[0]",
              provider: "claude",
              model: "m",
              native: false,
            },
          ],
        })
      );
      fs.writeFileSync(
        path.join(reviewB, "round.json"),
        JSON.stringify({
          round: 1,
          generation: 1,
          cap: 2,
          roster: [
            {
              slot: "claude[0]",
              provider: "claude",
              model: "m",
              native: false,
            },
          ],
        })
      );

      const subjA = crypto
        .createHash("sha256")
        .update(path.join(reviewA, "gen-1"))
        .digest("hex")
        .slice(0, 16);

      const subjB = crypto
        .createHash("sha256")
        .update(path.join(reviewB, "gen-1"))
        .digest("hex")
        .slice(0, 16);

      const diagDir = path.join(f.session, ".state", "diagnostics");
      fs.mkdirSync(diagDir, { recursive: true });

      const writeCap = (
        name: string,
        subject: string,
        attempt: number,
        start: number
      ) => {
        writeJson(path.join(diagDir, `${name}.json`), {
          os: "linux",
          capture: { state: "completed", start, end: start + 500 },
          phases: [{ key: "review-run-code", name: "code review" }],
          invocations: [
            {
              phase: "review-run-code",
              subject,
              attempt,
              provider: "claude",
              model: "m",
              surface: "cli",
              launched: true,
              outcome: "ok",
            },
          ],
          reviews: [],
        });
      };

      writeCap("c1", subjA, 1, 1000);
      writeCap("c2", subjB, 1, 2000);
      writeCap("c3", subjA, 2, 3000);

      const expectedPhaseA = `review-${crypto
        .createHash("sha256")
        .update(path.join(f.session, ".state", "reviews", "code-a"))
        .digest("hex")
        .slice(0, 16)}`;

      const expectedPhaseB = `review-${crypto
        .createHash("sha256")
        .update(path.join(f.session, ".state", "reviews", "code-b"))
        .digest("hex")
        .slice(0, 16)}`;

      const content = Buffer.from(
        [500, 1200, 2200, 3200]
          .map((at, index) => usageLine(`m${index}`, at, 10, 1))
          .join("\n")
      );

      const customDeps = {
        ...f.deps,
        clock: () => 4000,
        orchestrator: { platform: "claude" as const, model: "m" },
        env: { CLAUDE_CODE_SESSION_ID: "host-1" },
        hostUsageFs: {
          list: (dir: string) => (dir.endsWith("projects") ? ["p"] : []),
          stat: (file: string) =>
            file.endsWith("host-1.jsonl")
              ? { size: content.length, mtimeMs: 4000 }
              : null,
          read: () => content,
          decompress: null,
        },
      };

      const manifest = {
        ...readManifest(f.session),
        createdAt: new Date(100).toISOString(),
      };

      const facts = sessionFacts(
        f.session,
        { records: [], lastSeq: 0, torn: null },
        "complete",
        {
          manifest,
          deps: customDeps,
        }
      );

      const rows = facts.hostUsage?.rows ?? [];
      assert.equal(rows.length, 3);
      assert.equal(rows[0]?.phase, undefined);
      assert.equal(rows[0]?.input, 10);
      const rowA = rows.find((r) => r.phase === expectedPhaseA);
      const rowB = rows.find((r) => r.phase === expectedPhaseB);
      assert.equal(rowA?.input, 20);
      assert.equal(rowB?.input, 10);
      assert.ok(facts.invocations.some((i) => i.phase === expectedPhaseA));
    } finally {
      f.cleanup();
    }
  }

  // sessionFacts records startedAt, hosts and slot yield billed tokens and attempts across rounds
  {
    const f = sessionFixture({ memory: true });

    try {
      const review = "plan-yield-attempts";

      for (const round of [1, 2]) {
        const roundDir = path.join(
          f.session,
          ".state",
          "reviews",
          review,
          `round-${round}`
        );

        writeJson(path.join(roundDir, "round.json"), {
          round,
          generation: 1,
          cap: 4,
          level: "high",
          roster: [
            {
              slot: "opencode[0]",
              provider: "opencode",
              index: 0,
              native: false,
              reserve: false,
              model: "model-a",
            },
          ],
          scope: "Full",
          startSeq: 0,
          spec: { path: "spec.md", hash: `sha256:${"a".repeat(64)}` },
          target: { base: "a".repeat(40), head: "b".repeat(40) },
        });
        writeJson(path.join(roundDir, "gen-1", "slots", "opencode[0].json"), {
          slot: "opencode[0]",
          state: "done",
          text: "ok",
          responder: {
            slot: "opencode[0]",
            provider: "opencode",
            model: "model-a",
            native: false,
          },
        });
      }

      const sub1 = crypto
        .createHash("sha256")
        .update(
          path.join(f.session, ".state", "reviews", review, "round-1", "gen-1")
        )
        .digest("hex")
        .slice(0, 16);

      const sub2 = crypto
        .createHash("sha256")
        .update(
          path.join(f.session, ".state", "reviews", review, "round-2", "gen-1")
        )
        .digest("hex")
        .slice(0, 16);

      writeJson(path.join(f.session, ".state", "diagnostics", "run-1.json"), {
        capture: { state: "completed", start: 0, end: 1 },
        host: "claude",
        phases: [],
        reviews: [],
        invocations: [
          {
            phase: "plan-review",
            subject: sub1,
            attempt: 1,
            provider: "opencode",
            model: "model-a",
            effort: "low",
            mode: "cli",
            surface: "cli",
            launched: true,
            outcome: "ok",
            slot: "opencode[0]",
            usage: { input: 100, output: 20, reasoning: 30 },
          },
        ],
      });
      writeJson(path.join(f.session, ".state", "diagnostics", "run-2.json"), {
        capture: {
          state: "completed",
          start: Date.parse("2026-12-05T10:00:00Z"),
          end: Date.parse("2026-12-05T10:01:00Z"),
        },
        host: "agy",
        phases: [],
        reviews: [],
        invocations: [
          {
            phase: "plan-review",
            subject: sub2,
            attempt: 1,
            provider: "opencode",
            model: "model-a",
            mode: "cli",
            surface: "cli",
            launched: true,
            outcome: "ok",
            slot: "opencode[0]",
            usage: {
              input: 200,
              output: 10,
              reasoning: 40,
              reasoningInOutput: true,
            },
          },
        ],
      });

      const facts = sessionFacts(
        f.session,
        { records: [], lastSeq: 0, torn: null },
        "complete"
      );

      assert.equal(facts.startedAt, "2026-12-05");
      assert.deepEqual(facts.hosts, ["claude", "agy"]);
      assert.equal(facts.slotYield?.length, 1);
      const row = defined(facts.slotYield[0]);
      assert.equal(row.tokens, 360);
      assert.equal(row.attempts?.length, 2);
      assert.deepEqual(
        row.attempts?.map((a) => [a.provider, a.model, a.effort]),
        [
          ["opencode", "model-a", "low"],
          ["opencode", "model-a", null],
        ]
      );

      // Capture without positive start falls back to manifest createdAt
      const f2 = sessionFixture({ memory: true });

      try {
        const manifestPath = path.join(f2.session, "manifest.json");
        const manifest = readManifest(f2.session);
        assert.ok(manifest !== undefined && manifest !== null);
        writeJson(manifestPath, {
          ...manifest,
          createdAt: "2026-11-20T08:00:00Z",
        });
        writeJson(
          path.join(f2.session, ".state", "diagnostics", "run-0.json"),
          {
            capture: { state: "completed", start: 0, end: 1 },
            phases: [],
            reviews: [],
            invocations: [],
          }
        );
        assert.equal(
          sessionFacts(
            f2.session,
            { records: [], lastSeq: 0, torn: null },
            "complete"
          ).startedAt,
          "2026-11-20"
        );

        // Out-of-range capture start does not throw RangeError and falls back to manifest createdAt
        writeJson(
          path.join(f2.session, ".state", "diagnostics", "run-0.json"),
          {
            capture: { state: "completed", start: 1e100, end: 1 },
            phases: [],
            reviews: [],
            invocations: [],
          }
        );
        assert.equal(
          sessionFacts(
            f2.session,
            { records: [], lastSeq: 0, torn: null },
            "complete"
          ).startedAt,
          "2026-11-20"
        );
      } finally {
        f2.cleanup();
      }
    } finally {
      f.cleanup();
    }
  }
});

// SECTION: round workload fixtures
const reviewKey = (session: string, review: string) =>
  `review-${crypto
    .createHash("sha256")
    .update(path.join(session, ".state", "reviews", review))
    .digest("hex")
    .slice(0, 16)}`;

const workloadRound = (
  session: string,
  review: string,
  round: number,
  generations = 1
) => {
  const roundDir = path.join(
    session,
    ".state",
    "reviews",
    review,
    `round-${round}`
  );

  writeJson(path.join(roundDir, "round.json"), {
    round,
    generation: generations,
    cap: 4,
    roster: [],
  });

  for (let g = 1; g <= generations; g += 1) {
    fs.mkdirSync(path.join(roundDir, `gen-${g}`), { recursive: true });
  }
};

const workloadCapture = (
  session: string,
  name: string,
  capture: { start: number; end?: number },
  phase: string | undefined,
  invocations: unknown[] = [],
  meta: { host?: string; hostThread?: string } = {}
) => {
  writeJson(path.join(session, ".state", "diagnostics", `${name}.json`), {
    ...(!(meta.host === undefined) && { host: meta.host }),
    ...(!(meta.hostThread === undefined) && { hostThread: meta.hostThread }),
    capture: {
      state: capture.end === undefined ? "opened" : "completed",
      ...capture,
    },
    phases:
      (phase ?? "").length > 0 ? [{ key: phase, name: "plan review" }] : [],
    invocations,
    reviews: [],
  });
};

const reviewRun = (subject: string) => ({
  phase: "review-run-plan",
  subject,
  attempt: 1,
  provider: "claude",
  model: "m",
  surface: "cli",
  launched: true,
  outcome: "ok",
  slot: "claude[0]",
});

const usageLine = (id: string, at: number, input: number, output: number) =>
  JSON.stringify({
    type: "assistant",
    timestamp: new Date(at).toISOString(),
    message: {
      id,
      model: "m",
      usage: { input_tokens: input, output_tokens: output },
    },
  });

// Claude host thread plus one subagent transcript, read through the injected filesystem port.
const claudeHostDeps = (
  f: ReturnType<typeof sessionFixture>,
  input: { clock: number; main: string[]; subagent?: string[] }
) => {
  // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
  const main = Buffer.from(input.main.join("\n"));
  const subagent = Buffer.from((input.subagent ?? []).join("\n"));

  return {
    ...f.deps,
    clock: () => input.clock,
    orchestrator: { platform: "claude" as const, model: "m" },
    env: { CLAUDE_CODE_SESSION_ID: "host-1" },
    hostUsageFs: {
      list: (dir: string) => {
        if (dir.endsWith("projects")) {
          return ["p"];
        }

        return dir.endsWith("subagents") ? ["agent-1.jsonl"] : [];
      },
      stat: (file: string) => {
        if (file.endsWith("host-1.jsonl")) {
          return { size: main.length, mtimeMs: input.clock };
        }

        return file.endsWith("agent-1.jsonl")
          ? { size: subagent.length, mtimeMs: input.clock }
          : null;
      },
      read: (file: string) =>
        file.endsWith("agent-1.jsonl") ? subagent : main,
      decompress: null,
    },
  };
};

const sessionRows = (
  session: string,
  hostContext?: Parameters<typeof sessionFacts>[3]
) =>
  sessionFacts(
    session,
    { records: [], lastSeq: 0, torn: null },
    "complete",
    hostContext
  ).roundWorkload;

test("round workload counts observed calls per round window by phase key", () => {
  const f = sessionFixture({ memory: true });

  try {
    workloadRound(f.session, "plan-a", 1);
    workloadRound(f.session, "plan-a", 2);
    workloadCapture(
      f.session,
      "r1",
      { start: 1000, end: 1400 },
      "review-run-plan",
      [reviewRun(roundSubject(f.session, "plan-a", 1))]
    );
    workloadCapture(
      f.session,
      "l1",
      { start: 1100, end: 1110 },
      "ledger-append"
    );
    workloadCapture(f.session, "l2", { start: 1200, end: 1210 }, "lint-run");
    workloadCapture(
      f.session,
      "r2",
      { start: 5000, end: 5300 },
      "review-run-plan",
      [reviewRun(roundSubject(f.session, "plan-a", 2))]
    );
    workloadCapture(
      f.session,
      "after",
      { start: 6000, end: 6100 },
      "report-render"
    );
    const key = reviewKey(f.session, "plan-a");
    assert.deepEqual(sessionRows(f.session), [
      {
        review: key,
        kind: "plan",
        round: 1,
        calls: {
          total: 3,
          phases: [
            { key: "ledger-append", count: 1 },
            { key: "lint-run", count: 1 },
            { key: "review-run-plan", count: 1 },
          ],
        },
      },
      {
        review: key,
        kind: "plan",
        round: 2,
        calls: { total: 1, phases: [{ key: "review-run-plan", count: 1 }] },
      },
    ]);
  } finally {
    f.cleanup();
  }
});

test("round workload attributes interleaved rounds of two reviews without double counting", () => {
  const f = sessionFixture({ memory: true });

  try {
    for (const review of ["plan-a", "plan-b"]) {
      for (const round of [1, 2]) {
        workloadRound(f.session, review, round);
      }
    }

    workloadCapture(
      f.session,
      "a1",
      { start: 1000, end: 1100 },
      "review-run-plan",
      [reviewRun(roundSubject(f.session, "plan-a", 1))]
    );
    workloadCapture(
      f.session,
      "b1",
      { start: 1500, end: 1600 },
      "review-run-plan",
      [reviewRun(roundSubject(f.session, "plan-b", 1))]
    );
    workloadCapture(f.session, "lint", { start: 1700, end: 1710 }, "lint-run");
    workloadCapture(
      f.session,
      "a2",
      { start: 2000, end: 2100 },
      "review-run-plan",
      [reviewRun(roundSubject(f.session, "plan-a", 2))]
    );
    workloadCapture(
      f.session,
      "b2",
      { start: 2500, end: 2600 },
      "review-run-plan",
      [reviewRun(roundSubject(f.session, "plan-b", 2))]
    );
    const rows = defined(sessionRows(f.session));
    const keyA = reviewKey(f.session, "plan-a");
    assert.deepEqual(
      rows.map((row) => [
        row.review === keyA ? "a" : "b",
        row.round,
        row.calls?.total,
      ]),
      [
        ["a", 1, 1],
        ["a", 2, 1],
        ["b", 1, 1],
        ["b", 2, 1],
      ]
    );
    assert.equal(
      rows.reduce((total, row) => total + (row.calls?.total ?? 0), 0),
      4
    );
  } finally {
    f.cleanup();
  }
});

// oxlint-disable-next-line eslint/complexity -- workload matrix covers turns, threads and sanitization; splitting would scatter the assertions
test("round workload attributes turns, threads and reviewer turns while sanitizing facts", async () => {
  // round turns: counts host responses through the fix-review-lite note
  {
    const f = sessionFixture({ memory: true });

    try {
      const review = "plan-a";
      workloadRound(f.session, review, 1);
      workloadCapture(
        f.session,
        "run",
        { start: 1000, end: 1100 },
        "review-run-plan",
        [reviewRun(roundSubject(f.session, review, 1))]
      );
      workloadCapture(
        f.session,
        "fix-review-lite",
        { start: 1400, end: 1500 },
        "brief-fix-review-lite"
      );
      workloadCapture(
        f.session,
        "after",
        { start: 1800, end: 1900 },
        "report-render"
      );

      const deps = claudeHostDeps(f, {
        clock: 2000,
        main: [
          usageLine("first", 1050, 1, 1),
          usageLine("check", 1450, 2, 2),
          usageLine("outside", 1750, 3, 3),
        ],
        subagent: [usageLine("sub", 1050, 20, 20)],
      });

      const manifest = {
        ...readManifest(f.session),
        createdAt: new Date(100).toISOString(),
      };

      const records: Fold["records"] = [
        {
          seq: 1,
          by: "tool",
          kind: "note",
          key: "fix-review-lite:plan-a:1:1",
          at: new Date(1600).toISOString(),
          data: {},
        },
      ];

      const facts = sessionFacts(
        f.session,
        { records, lastSeq: 1, torn: null },
        "complete",
        { manifest, deps }
      );

      const row = facts.roundWorkload?.[0];
      assert.deepEqual(
        [row?.calls?.total, row?.hostTokens, row?.hostTurns],
        [2, 6, 2]
      );
    } finally {
      f.cleanup();
    }
  }

  // round turns: in-window rulings and notes set the close without counting gaps
  {
    const f = sessionFixture({ memory: true });

    try {
      const review = "plan-a";
      workloadRound(f.session, review, 1);
      workloadRound(f.session, review, 2);
      workloadRound(f.session, "plan-b", 1);
      workloadCapture(
        f.session,
        "r1",
        { start: 500, end: 800 },
        "review-run-plan",
        [reviewRun(roundSubject(f.session, review, 1))]
      );
      workloadCapture(
        f.session,
        "r2",
        { start: 1000, end: 1100 },
        "review-run-plan",
        [reviewRun(roundSubject(f.session, review, 2))]
      );
      workloadCapture(
        f.session,
        "ruling",
        { start: 1200, end: 1250 },
        "ledger-append"
      );
      workloadCapture(
        f.session,
        "check",
        { start: 1400, end: 1450 },
        "brief-fix-review-lite"
      );
      workloadCapture(f.session, "gap", { start: 1700, end: 1750 }, "lint-run");

      // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
      const main = [
        usageLine("prior", 700, 1, 1),
        ...[1100, 1250, 1500, 1700, 2100, 2300].map((at) =>
          usageLine(String(at), at, 1, 1)
        ),
      ];

      const manifest = {
        ...readManifest(f.session),
        createdAt: new Date(100).toISOString(),
      };

      const ruling = {
        seq: 1,
        key: "ruling",
        by: "orchestrator",
        kind: "ruling",
        data: { subject: "review:plan-a:earlier-finding" },
        at: isoTime(1250),
      };

      const note = {
        seq: 2,
        by: "tool",
        kind: "note",
        key: "fix-review-lite:plan-a:2:1",
        at: isoTime(1500),
        data: {},
      };

      const unrelated = {
        seq: 3,
        by: "tool",
        kind: "note",
        key: "unrelated",
        at: isoTime(1800),
        data: {},
      };

      const late = { ...ruling, at: isoTime(2300) };

      const read = (
        records: Fold["records"],
        host = main,
        subagent = ["malformed"]
      ) => {
        const deps = claudeHostDeps(f, { clock: 2500, main: host, subagent });

        return sessionFacts(
          f.session,
          { records, lastSeq: records.length, torn: null },
          "complete",
          { manifest, deps }
        ).roundWorkload;
      };

      const workload = (
        row: NonNullable<ReturnType<typeof read>>[number] | undefined
      ) => [row?.calls?.total, row?.hostTurns];

      assert.deepEqual(workload(read([unrelated])?.[1]), [1, 1]);
      assert.deepEqual(workload(read([ruling, unrelated])?.[1]), [2, 2]);
      const before = read([ruling, note, unrelated])?.[1];
      assert.deepEqual(workload(before), [3, 3]);
      workloadCapture(
        f.session,
        "other",
        { start: 2000, end: 2100 },
        "review-run-plan",
        [reviewRun(roundSubject(f.session, "plan-b", 1))]
      );
      assert.deepEqual(read([ruling, note, unrelated, late])?.[1], before);
      assert.deepEqual(
        workload(
          read([ruling, note, unrelated, late], [...main, "malformed"])?.[1]
        ),
        [3, undefined]
      );
    } finally {
      f.cleanup();
    }
  }

  // observeTool and sanitizeFacts preserve wrapUp, hostThread, and turn/tool counters while rejecting malformed values
  {
    const f = sessionFixture({ memory: true });

    try {
      const expectedThread = crypto
        .createHmac("sha256", path.resolve(f.session))
        .update(JSON.stringify(["claude", "host-thread-1"]))
        .digest("hex")
        .slice(0, 16);

      assert.equal(
        hostThreadId(
          "claude",
          { CLAUDE_CODE_SESSION_ID: "host-thread-1" },
          f.session
        ),
        expectedThread
      );
      assert.equal(hostThreadId("claude", {}, f.session), undefined);
      assert.equal(
        hostThreadId(
          null,
          { CLAUDE_CODE_SESSION_ID: "host-thread-1" },
          f.session
        ),
        undefined
      );
      assert.equal(
        hostThreadId(
          "claude",
          { CLAUDE_CODE_SESSION_ID: "../bad-id" },
          f.session
        ),
        undefined
      );

      const skill = path.join(f.root, "skill");
      fs.mkdirSync(skill, { recursive: true });
      writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
      f.deps.skillRoot = skill;
      f.deps.orchestrator = { platform: "claude", model: "m" };
      f.deps.env = { CLAUDE_CODE_SESSION_ID: "host-thread-1" };
      // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
      f.deps.delegate = async () => ({
        outcome: {
          status: "ok",
          text: "done",
          sessionId: "secret-session-1",
          resume: null,
        },
        invocations: [
          {
            provider: "claude",
            model: "m",
            effort: "high",
            mode: "cli",
            launched: true,
            outcome: "ok",
            wrapUp: true,
            usage: {
              input: 100,
              output: 20,
              turns: 3,
              toolCalls: 5,
              toolTurns: 2,
              scope: "invocation",
              provenance: "session",
              inputSemantics: "uncached",
              models: {
                "m#high": {
                  input: 100,
                  output: 20,
                  turns: 3,
                  toolCalls: 5,
                  toolTurns: 2,
                },
              },
            },
            responses: [
              {
                role: "delegate",
                basis: "claude-assistant-message",
                coverage: "partial",
                observed: 3,
                uncachedInput: 100,
                toolCalls: 5,
                toolTurns: 2,
              },
            ],
          },
        ],
      });

      const observer = defined(
        observeTool(f.session, "ask", "run", undefined, f.deps)
      );

      await observer.deps.delegate(
        "claude",
        requestForLog(path.join(f.session, "logs", "claude[0].log")),
        "cli"
      );
      observer.finish({ ok: true, exit: 0, summary: "done", value: null });

      const diagDir = path.join(f.session, ".state", "diagnostics");
      const [file] = fs.readdirSync(diagDir);
      assert.ok((file ?? "").length > 0);
      const persisted = readCapture(path.join(diagDir, defined(file)));
      assert.equal(persisted["hostThread"], expectedThread);
      assert.doesNotMatch(
        JSON.stringify(persisted),
        /host-thread-1|secret-session-1/u
      );

      const sanitized = sanitizeFacts(persisted);
      assert.equal(sanitized.hostThread, expectedThread);
      const [inv] = sanitized.invocations;
      assert.ok(inv?.usage);
      const { usage } = inv;
      assert.equal(inv.wrapUp, true);
      assert.deepEqual(
        [usage.turns, usage.toolCalls, usage.toolTurns],
        [3, 5, 2]
      );
      const modelPart = usage.models?.["m#high"];
      assert.ok(modelPart);
      assert.deepEqual(
        [modelPart.turns, modelPart.toolCalls, modelPart.toolTurns],
        [3, 5, 2]
      );
      const resp = inv.responses?.[0];
      assert.ok(resp);
      assert.deepEqual([resp.toolCalls, resp.toolTurns], [5, 2]);

      const normalized = normalizeUsage(
        {
          input: 30,
          output: 6,
          turns: 2,
          toolCalls: 4,
          toolTurns: 2,
          models: {
            "m#bad effort": {
              input: 10,
              output: 2,
              turns: 1,
              toolCalls: 2,
              toolTurns: 1,
            },
            "m#": {
              input: 20,
              output: 4,
              turns: 1,
              toolCalls: 2,
              toolTurns: 1,
            },
          },
        },
        "uncached"
      );

      assert.ok(normalized);
      assert.deepEqual(
        [normalized.turns, normalized.toolCalls, normalized.toolTurns],
        [2, 4, 2]
      );
      const mergedPart = normalized.models?.["m#"];
      assert.ok(mergedPart);
      assert.deepEqual(
        [mergedPart.turns, mergedPart.toolCalls, mergedPart.toolTurns],
        [2, 4, 2]
      );

      const partialMerged = normalizeUsage(
        {
          input: 30,
          output: 6,
          models: {
            "m#bad effort": { input: 10, output: 2, turns: 1 },
            "m#": { input: 20, output: 4 },
          },
        },
        "uncached"
      );

      const partialModel = partialMerged?.models?.["m#"];
      assert.ok(partialModel);
      assert.equal(partialModel.turns, undefined);

      const malformed = sanitizeFacts({
        hostThread: "/Users/dev/secret",
        phases: [],
        reviews: [],
        invocations: [
          {
            phase: "ask-run",
            provider: "claude",
            model: "m",
            surface: "cli",
            launched: true,
            outcome: "ok",
            wrapUp: "yes",
            usage: {
              input: 10,
              output: 2,
              turns: -1,
              toolCalls: 1.5,
              toolTurns: Number.NaN,
            },
          },
        ],
      });

      assert.equal(malformed.hostThread, undefined);
      const [badInv] = malformed.invocations;
      assert.ok(badInv?.usage);
      assert.equal(badInv.wrapUp, undefined);
      assert.equal(badInv.usage.turns, undefined);
      assert.equal(badInv.usage.toolCalls, undefined);
      assert.equal(badInv.usage.toolTurns, undefined);

      const longHex = sanitizeFacts({
        hostThread: "a".repeat(32),
        phases: [],
        reviews: [],
        invocations: [],
      });

      assert.equal(longHex.hostThread, undefined);
    } finally {
      f.cleanup();
    }
  }

  // hostUsageOf retains userTurnsByStage, subagentCount, maxSubagentDepth, and row turn counters while rejecting invalid values
  {
    const clean = sanitizeFacts({
      phases: [],
      invocations: [],
      reviews: [],
      hostUsage: {
        platform: "claude",
        userTurns: 4,
        userTurnsByStage: {
          spec: 1,
          implementation: 3,
          bogus: 9,
          "plan review": -1,
        },
        subagentCount: 5,
        maxSubagentDepth: 2,
        rows: [
          {
            stage: "spec",
            role: "host",
            model: "m",
            effort: null,
            input: 10,
            output: 2,
            turns: 2,
            toolCalls: 4,
            toolTurns: 2,
          },
          {
            stage: "implementation",
            role: "subagent",
            model: "m",
            effort: "low",
            input: 20,
            output: 4,
            turns: 3,
            toolCalls: 1,
            toolTurns: 1,
            maxDepth: 2,
          },
        ],
        responses: [
          {
            stage: "spec",
            role: "host",
            agent: "host-1",
            basis: "claude-assistant-message",
            coverage: "complete",
            observed: 2,
            uncachedInput: 10,
            toolCalls: 4,
            toolTurns: 2,
          },
          {
            stage: "implementation",
            role: "subagent",
            basis: "claude-assistant-message",
            coverage: "unknown",
            toolCalls: 99,
            toolTurns: 99,
          },
        ],
      },
    });

    const hu = clean.hostUsage;
    assert.ok(hu);
    assert.equal(hu.userTurns, 4);
    assert.deepEqual(hu.userTurnsByStage, { spec: 1, implementation: 3 });
    assert.equal(hu.subagentCount, 5);
    assert.equal(hu.maxSubagentDepth, 2);
    const [host, subagent] = hu.rows ?? [];
    assert.ok(host && subagent);
    assert.deepEqual(
      [host.turns, host.toolCalls, host.toolTurns, host.maxDepth],
      [2, 4, 2, undefined]
    );
    assert.deepEqual(
      [
        subagent.turns,
        subagent.toolCalls,
        subagent.toolTurns,
        subagent.maxDepth,
      ],
      [3, 1, 1, 2]
    );
    const [hostResponse, subagentResponse] = hu.responses ?? [];
    assert.ok(hostResponse && subagentResponse);
    assert.deepEqual([hostResponse.toolCalls, hostResponse.toolTurns], [4, 2]);
    assert.deepEqual(
      [subagentResponse.toolCalls, subagentResponse.toolTurns],
      [undefined, undefined]
    );

    const invalid = sanitizeFacts({
      phases: [],
      invocations: [],
      reviews: [],
      hostUsage: {
        platform: "claude",
        userTurns: -1,
        userTurnsByStage: { bogus: 1, spec: "https://evil.example.com" },
        subagentCount: 1.5,
        maxSubagentDepth: -2,
        rows: [
          {
            stage: "spec",
            role: "subagent",
            model: "m",
            effort: null,
            input: 10,
            output: 2,
            turns: -1,
            toolCalls: "bad",
            toolTurns: Number.NaN,
            maxDepth: 0.5,
          },
        ],
      },
    });

    const badHu = invalid.hostUsage;
    assert.ok(badHu);
    assert.equal(badHu.userTurns, undefined);
    assert.equal(badHu.userTurnsByStage, undefined);
    assert.equal(badHu.subagentCount, undefined);
    assert.equal(badHu.maxSubagentDepth, undefined);
    const badRow = badHu.rows?.[0];
    assert.ok(badRow);
    assert.deepEqual(
      [badRow.turns, badRow.toolCalls, badRow.toolTurns, badRow.maxDepth],
      [undefined, undefined, undefined, undefined]
    );
  }

  // multi-host roundWorkload omits hostTokens and hostTurns on cross-host switches and ambiguous multi-host captures
  {
    const f = sessionFixture({ memory: true });

    try {
      workloadRound(f.session, "plan-mh", 1);
      workloadRound(f.session, "plan-mh", 2);
      workloadRound(f.session, "plan-mh", 3);

      const thread = crypto
        .createHmac("sha256", path.resolve(f.session))
        .update(JSON.stringify(["claude", "host-1"]))
        .digest("hex")
        .slice(0, 16);

      workloadCapture(
        f.session,
        "r1",
        { start: 1000, end: 1100 },
        "review-run-plan",
        [reviewRun(roundSubject(f.session, "plan-mh", 1))],
        { host: "codex", hostThread: thread }
      );
      workloadCapture(
        f.session,
        "r2",
        { start: 2000, end: 2100 },
        "review-run-plan",
        [reviewRun(roundSubject(f.session, "plan-mh", 2))],
        { host: "claude", hostThread: thread }
      );
      workloadCapture(
        f.session,
        "r3",
        { start: 3000, end: 3100 },
        "review-run-plan",
        [reviewRun(roundSubject(f.session, "plan-mh", 3))]
      );

      const deps = claudeHostDeps(f, {
        clock: 4000,
        main: [
          usageLine("m1", 1050, 10, 1),
          usageLine("m2", 2050, 20, 2),
          usageLine("m3", 3050, 30, 3),
        ],
      });

      const rows = defined(
        sessionRows(f.session, {
          manifest: {
            ...readManifest(f.session),
            createdAt: new Date(100).toISOString(),
          },
          deps,
        })
      );

      assert.deepEqual(
        [defined(rows[0]).hostTokens, defined(rows[0]).hostTurns],
        [undefined, undefined]
      );
      assert.deepEqual(
        [defined(rows[1]).hostTokens, defined(rows[1]).hostTurns],
        [22, 1]
      );
      assert.deepEqual(
        [defined(rows[2]).hostTokens, defined(rows[2]).hostTurns],
        [undefined, undefined]
      );

      const fAmb = sessionFixture({ memory: true });

      try {
        workloadRound(fAmb.session, "plan-amb", 1);
        workloadRound(fAmb.session, "plan-amb", 2);
        workloadRound(fAmb.session, "plan-amb", 3);
        workloadCapture(
          fAmb.session,
          "a1",
          { start: 1000, end: 1100 },
          "review-run-plan",
          [reviewRun(roundSubject(fAmb.session, "plan-amb", 1))],
          { host: "codex" }
        );
        workloadCapture(
          fAmb.session,
          "a2",
          { start: 2000, end: 2100 },
          "review-run-plan",
          [reviewRun(roundSubject(fAmb.session, "plan-amb", 2))],
          { host: "claude" }
        );
        workloadCapture(
          fAmb.session,
          "a3",
          { start: 3000, end: 3100 },
          "review-run-plan",
          [reviewRun(roundSubject(fAmb.session, "plan-amb", 3))]
        );

        const ambDeps = claudeHostDeps(fAmb, {
          clock: 4000,
          main: [
            usageLine("m1", 1050, 10, 1),
            usageLine("m2", 2050, 20, 2),
            usageLine("m3", 3050, 30, 3),
          ],
        });

        const ambRows = defined(
          sessionRows(fAmb.session, {
            manifest: {
              ...readManifest(f.session),
              createdAt: new Date(100).toISOString(),
            },
            deps: ambDeps,
          })
        );

        assert.deepEqual(
          [defined(ambRows[0]).hostTokens, defined(ambRows[0]).hostTurns],
          [undefined, undefined]
        );
        assert.deepEqual(
          [defined(ambRows[1]).hostTokens, defined(ambRows[1]).hostTurns],
          [22, 1]
        );
        assert.deepEqual(
          [defined(ambRows[2]).hostTokens, defined(ambRows[2]).hostTurns],
          [undefined, undefined]
        );
      } finally {
        fAmb.cleanup();
      }
    } finally {
      f.cleanup();
    }
  }

  // mid-round thread switch leaves hostTokens and hostTurns undefined even when measured thread has rows in window
  {
    const f = sessionFixture({ memory: true });

    try {
      workloadRound(f.session, "plan-sw", 1);
      workloadRound(f.session, "plan-sw", 2);

      const measuredThread = crypto
        .createHmac("sha256", path.resolve(f.session))
        .update(JSON.stringify(["claude", "host-1"]))
        .digest("hex")
        .slice(0, 16);

      const otherThread = "0123456789abcdef";
      workloadCapture(
        f.session,
        "r1-a",
        { start: 1000, end: 1100 },
        "review-run-plan",
        [reviewRun(roundSubject(f.session, "plan-sw", 1))],
        { host: "claude", hostThread: measuredThread }
      );
      workloadCapture(
        f.session,
        "r1-b",
        { start: 1050, end: 1080 },
        "lint-run",
        [],
        {
          host: "claude",
          hostThread: otherThread,
        }
      );
      workloadCapture(
        f.session,
        "r2",
        { start: 2000, end: 2100 },
        "review-run-plan",
        [reviewRun(roundSubject(f.session, "plan-sw", 2))],
        { host: "claude", hostThread: measuredThread }
      );

      const deps = claudeHostDeps(f, {
        clock: 3000,
        main: [usageLine("m1", 1020, 10, 1), usageLine("m2", 2050, 20, 2)],
      });

      const rows = defined(
        sessionRows(f.session, {
          manifest: {
            ...readManifest(f.session),
            createdAt: new Date(100).toISOString(),
          },
          deps,
        })
      );

      assert.deepEqual(
        [defined(rows[0]).hostTokens, defined(rows[0]).hostTurns],
        [undefined, undefined]
      );
      assert.deepEqual(
        [defined(rows[1]).hostTokens, defined(rows[1]).hostTurns],
        [22, 1]
      );

      // Mixed thread-tracked session: a round missing hostThread when another capture has hostThread omits hostTokens/hostTurns.
      const fMixed = sessionFixture({ memory: true });

      try {
        workloadRound(fMixed.session, "plan-mx", 1);
        workloadRound(fMixed.session, "plan-mx", 2);

        const t = crypto
          .createHmac("sha256", path.resolve(fMixed.session))
          .update(JSON.stringify(["claude", "host-1"]))
          .digest("hex")
          .slice(0, 16);

        workloadCapture(
          fMixed.session,
          "r1",
          { start: 1000, end: 1100 },
          "review-run-plan",
          [reviewRun(roundSubject(fMixed.session, "plan-mx", 1))],
          { host: "claude" }
        );
        workloadCapture(
          fMixed.session,
          "r2",
          { start: 2000, end: 2100 },
          "review-run-plan",
          [reviewRun(roundSubject(fMixed.session, "plan-mx", 2))],
          { host: "claude", hostThread: t }
        );

        const mixedDeps = claudeHostDeps(fMixed, {
          clock: 3000,
          main: [usageLine("m1", 1050, 10, 1), usageLine("m2", 2050, 20, 2)],
        });

        const mixedRows = defined(
          sessionRows(fMixed.session, {
            manifest: {
              ...readManifest(f.session),
              createdAt: new Date(100).toISOString(),
            },
            deps: mixedDeps,
          })
        );

        assert.deepEqual(
          [defined(mixedRows[0]).hostTokens, defined(mixedRows[0]).hostTurns],
          [undefined, undefined]
        );
        assert.deepEqual(
          [defined(mixedRows[1]).hostTokens, defined(mixedRows[1]).hostTurns],
          [22, 1]
        );
      } finally {
        fMixed.cleanup();
      }
    } finally {
      f.cleanup();
    }
  }

  // multi-generation reviewerTurns excludes superseded generations and omits native-only or zero-launch rounds
  {
    const f = sessionFixture({ memory: true });

    try {
      saveRound({
        session: f.session,
        review: "plan-rev",
        round: 1,
        generation: 1,
        roster: [
          rosterSlot("claude[0]", "claude"),
          rosterSlot("copilot[0]", "copilot", { reserve: true }),
        ],
        outcomes: [
          {
            slot: "claude[0]",
            state: "done",
            responder: {
              slot: "claude[0]",
              provider: "claude",
              model: "m",
              native: false,
            },
          },
        ],
      });
      saveRound({
        session: f.session,
        review: "plan-rev",
        round: 1,
        generation: 2,
        roster: [
          rosterSlot("claude[0]", "claude"),
          rosterSlot("copilot[0]", "copilot", { reserve: true }),
        ],
        outcomes: [
          {
            slot: "claude[0]",
            state: "done",
            responder: {
              slot: "claude[0]",
              provider: "claude",
              model: "m",
              native: false,
            },
          },
        ],
      });
      saveRound({
        session: f.session,
        review: "plan-rev",
        round: 2,
        generation: 1,
        roster: [rosterSlot("codex[0]", "codex", { native: true })],
        outcomes: [{ slot: "codex[0]", state: "native" }],
      });
      saveRound({
        session: f.session,
        review: "plan-rev",
        round: 3,
        generation: 1,
        roster: [rosterSlot("claude[0]", "claude")],
        outcomes: [],
      });
      const g1 = roundSubject(f.session, "plan-rev", 1, 1);
      const g2 = roundSubject(f.session, "plan-rev", 1, 2);
      workloadCapture(
        f.session,
        "r1-g1",
        { start: 1000, end: 1200 },
        "review-run-plan",
        [{ ...reviewRun(g1), usage: { input: 10, output: 1, turns: 5 } }]
      );
      workloadCapture(
        f.session,
        "r1-g2",
        { start: 1300, end: 1500 },
        "review-run-plan",
        [
          { ...reviewRun(g2), usage: { input: 10, output: 1, turns: 3 } },
          {
            ...reviewRun(g2),
            slot: "copilot[0]",
            targetSlot: "claude[0]",
            usage: { input: 10, output: 1, turns: 2 },
          },
        ]
      );

      const facts = sessionFacts(
        f.session,
        { records: [], lastSeq: 0, torn: null },
        "complete"
      );

      const [first, second, third] = facts.roundWorkload ?? [];
      assert.ok(first && second && third);
      assert.equal(first.reviewerTurns, 5);
      assert.equal(first.reviewerTurnsPartial, undefined);
      assert.equal(second.reviewerTurns, undefined);
      assert.equal(second.reviewerTurnsPartial, undefined);
      assert.equal(third.reviewerTurns, undefined);
      assert.equal(third.reviewerTurnsPartial, undefined);
      assert.equal(sanitizeFacts(facts).roundWorkload?.[0]?.reviewerTurns, 5);
    } finally {
      f.cleanup();
    }
  }

  // mixed native and CLI round marks reviewerTurnsPartial true and uses complete non-stdout DelegateResponse fallback
  {
    const f = sessionFixture({ memory: true });

    try {
      saveRound({
        session: f.session,
        review: "code-mix",
        round: 1,
        generation: 1,
        roster: [
          rosterSlot("claude[0]", "claude"),
          rosterSlot("codex[0]", "codex", { native: true }),
        ],
        outcomes: [
          {
            slot: "claude[0]",
            state: "done",
            responder: {
              slot: "claude[0]",
              provider: "claude",
              model: "m",
              native: false,
            },
          },
          { slot: "codex[0]", state: "native" },
        ],
      });
      saveRound({
        session: f.session,
        review: "code-mix",
        round: 2,
        generation: 1,
        roster: [rosterSlot("claude[0]", "claude")],
        outcomes: [
          {
            slot: "claude[0]",
            state: "done",
            responder: {
              slot: "claude[0]",
              provider: "claude",
              model: "m",
              native: false,
            },
          },
        ],
      });
      const s1 = roundSubject(f.session, "code-mix", 1, 1);
      const s2 = roundSubject(f.session, "code-mix", 2, 1);
      workloadCapture(
        f.session,
        "r1",
        { start: 1000, end: 1200 },
        "review-run-code",
        [{ ...reviewRun(s1), usage: { input: 10, output: 1, turns: 4 } }]
      );
      workloadCapture(
        f.session,
        "r2",
        { start: 2000, end: 2200 },
        "review-run-code",
        [
          {
            ...reviewRun(s2),
            usage: { input: 10, output: 1 },
            responses: [
              {
                stage: "code review",
                role: "delegate",
                agent: "delegate-0123456789abcdef",
                basis: "claude-assistant-message",
                coverage: "complete",
                observed: 6,
              },
              {
                stage: "code review",
                role: "subagent",
                agent: "delegate-child-0123456789abcdef",
                basis: "claude-assistant-message",
                coverage: "complete",
                observed: 9,
              },
            ],
          },
        ]
      );

      const facts = sessionFacts(
        f.session,
        { records: [], lastSeq: 0, torn: null },
        "complete"
      );

      const [first, second] = facts.roundWorkload ?? [];
      assert.ok(first && second);
      assert.equal(first.reviewerTurns, 4);
      assert.equal(first.reviewerTurnsPartial, true);
      assert.equal(second.reviewerTurns, 6);
      assert.equal(second.reviewerTurnsPartial, undefined);
    } finally {
      f.cleanup();
    }
  }
});

test("H4 and H10 agree on shared cache-read share of non-write input with cacheWrite > 0 and respect floors", () => {
  const findings = heuristics({
    phases: [{ key: "ask", name: "ask" }],
    reviews: [],
    invocations: [
      {
        phase: "ask",
        provider: "claude",
        model: "m",
        surface: "cli",
        launched: true,
        outcome: "ok",
        usage: {
          input: 60_000,
          cacheRead: 40_000,
          cacheWrite: 500_000,
          output: 100,
        },
      },
    ],
    hostUsage: {
      platform: "claude",
      rows: [
        {
          stage: "ask",
          role: "host",
          model: "m",
          effort: null,
          input: 60_000,
          cacheRead: 40_000,
          cacheWrite: 500_000,
          output: 100,
        },
      ],
    },
  });

  const h4 = findings.find((f) => f.source === "H4");
  const h10 = findings.find((f) => f.source === "H10");
  assert.ok(h4, "expected H4");
  assert.ok(h10, "expected H10");
  assert.equal(h4.category, "token-economy");
  assert.equal(h10.category, "token-economy");
  assert.match(
    h4.evidence,
    /cache read 40% of input \(40,000 of 100,000 tokens\)/u
  );
  assert.match(
    h10.evidence,
    /cache-read share of non-write input 40% \(40,000 of 100,000 tokens\)/u
  );

  const belowFloor = heuristics({
    phases: [],
    reviews: [],
    invocations: [],
    hostUsage: {
      platform: "claude",
      rows: [
        {
          stage: "ask",
          role: "host",
          model: "m",
          effort: null,
          input: 59_999,
          cacheRead: 40_000,
          cacheWrite: 500_000,
          output: 100,
        },
      ],
    },
  });

  assert.equal(
    belowFloor.some((f) => f.source === "H10"),
    false
  );
});

test("H11 emits non-review turn churn finding above threshold and stays silent on review stages, below floor, or incomplete groups", () => {
  const fired = heuristics({
    phases: [{ key: "impl", name: "implementation" }],
    reviews: [],
    invocations: [
      {
        phase: "impl",
        provider: "codex",
        model: "m",
        surface: "cli",
        launched: true,
        outcome: "ok",
        usageSource: "session",
        usage: { input: 100, output: 10, turns: 15 },
      },
    ],
    hostUsage: {
      platform: "claude",
      rows: [
        {
          stage: "implementation",
          role: "host",
          model: "m",
          effort: null,
          input: 100,
          output: 10,
          turns: 25,
        },
      ],
      responses: [
        {
          stage: "spec",
          role: "subagent",
          agent: "subagent-1",
          basis: "claude-assistant-message",
          coverage: "complete",
          observed: 20,
        },
        {
          stage: "plan",
          role: "subagent",
          agent: "subagent-1",
          basis: "claude-assistant-message",
          coverage: "complete",
          observed: 20,
        },
      ],
    },
  });

  const h11 = fired.filter((f) => f.source === "H11");
  assert.equal(h11.length, 2);
  assert.ok(h11.every((f) => f.category === "token-economy"));
  assert.ok(
    h11.some(
      (f) => f.evidence.includes("implementation") && f.evidence.includes("40")
    )
  );
  assert.ok(
    h11.some(
      (f) => f.evidence.includes("subagent-1") && f.evidence.includes("40")
    )
  );

  const silent = heuristics({
    phases: [
      { key: "rev", name: "code review" },
      { key: "impl", name: "implementation" },
    ],
    reviews: [],
    invocations: [
      {
        phase: "impl",
        provider: "codex",
        model: "m",
        surface: "cli",
        launched: true,
        outcome: "ok",
        usageSource: "stdout",
        usage: { input: 100, output: 10 },
      },
    ],
    hostUsage: {
      platform: "claude",
      rows: [
        {
          stage: "code review",
          role: "host",
          model: "m",
          effort: null,
          input: 100,
          output: 10,
          turns: 60,
        },
        {
          stage: "plan",
          role: "host",
          model: "m",
          effort: null,
          input: 100,
          output: 10,
          turns: 39,
        },
        {
          stage: "implementation",
          role: "host",
          model: "m",
          effort: null,
          input: 100,
          output: 10,
          turns: 50,
        },
        {
          stage: "spec",
          role: "host",
          model: "m",
          effort: null,
          input: 100,
          output: 10,
          turns: 50,
        },
        {
          stage: "spec",
          role: "subagent",
          model: "m",
          effort: null,
          input: 100,
          output: 10,
        },
      ],
      responses: [
        {
          stage: "code review",
          role: "host",
          agent: "host-1",
          basis: "claude-assistant-message",
          coverage: "complete",
          observed: 60,
        },
        {
          stage: "plan",
          role: "host",
          agent: "host-1",
          basis: "claude-assistant-message",
          coverage: "partial",
          observed: 50,
        },
      ],
    },
  });

  assert.deepEqual(
    silent.filter((f) => f.source === "H11"),
    []
  );
});

test("keeps bounded recovery facts and strips raw text and locators", () => {
  const ref = "01234567-89ab-4def-8123-0123456789ab";
  const base = { phases: [], invocations: [], reviews: [] };

  const execution = {
    ref,
    reused: 0,
    launched: -1,
    unresolved: Number.MAX_SAFE_INTEGER,
    prompt: "/private/prompt",
  };

  assert.deepEqual(
    sanitizeFacts({ ...base, recoveryExecution: execution }).recoveryExecution,
    { ref, reused: 0 }
  );
  assert.equal(
    sanitizeFacts({
      ...base,
      recoveryExecution: { ...execution, ref: "../capture" },
    }).recoveryExecution,
    undefined
  );
});
