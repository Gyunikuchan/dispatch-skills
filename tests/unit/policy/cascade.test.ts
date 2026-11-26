import assert from "node:assert/strict";
import { test } from "node:test";

import {
  failureDisposition,
  hasReserve,
  next as nextVoice,
  reservePool,
  takeReserve,
} from "../../../skills/dispatch/scripts/policy/cascade.ts";
import type { Voice } from "../../../skills/dispatch/scripts/policy/cascade.ts";
import type { FailureClass } from "../../../skills/dispatch/scripts/toolkit/types.ts";

const agy: Voice = {
  slot: "agy[0]",
  platform: "agy",
  models: ["gemini-pro", "gemini-flash"],
  modes: ["direct", "sandboxed"],
  modeCascadeOn: ["quota", "context-overflow"],
};

const lastModel = { model: 1, mode: 0 };

test("delegates-failure-classes: every class has a disposition; integrity and config end the run", () => {
  const classes: FailureClass[] = [
    "quota",
    "context-overflow",
    "auth",
    "model-not-found",
    "cli-outdated",
    "model-not-loaded",
    "sandbox-unsupported",
    "not-found",
    "timeout",
    "buffer",
    "empty-output",
    "capacity",
    "refusal",
    "no-report",
    "blocked",
    "truncated",
    "integrity",
    "config",
  ];

  const dispositions = Object.fromEntries(
    classes.map((cls) => [cls, failureDisposition(cls)])
  );

  assert.equal(dispositions["sandbox-unsupported"], "skip-voice");
  assert.equal(dispositions["integrity"], "terminal-run");
  assert.equal(dispositions["config"], "terminal-run");
  assert.equal(
    classes.filter((cls) => dispositions[cls] === "cascade").length,
    15
  );
  assert.deepEqual(nextVoice("config", { model: 0, mode: 0 }, agy), {
    kind: "terminal",
    scope: "run",
    reason: "config is terminal for the run",
  });
});

test("delegates-model-array-cascade: cascade classes advance to the next model", () => {
  // One ordinary representative plus auth/quota, which ADR 0001 explicitly keeps cascading;
  // cascade membership for the remaining classes is pinned by the dispositions test above.
  for (const cls of ["auth", "timeout", "quota"] as const) {
    assert.deepEqual(
      nextVoice(cls, { model: 0, mode: 0 }, agy),
      { kind: "next-model", position: { model: 1, mode: 0 } },
      cls
    );
  }

  assert.deepEqual(
    nextVoice("sandbox-unsupported", { model: 0, mode: 0 }, agy),
    {
      kind: "terminal",
      scope: "slot",
      reason: "agy[0] failed: sandbox-unsupported",
    }
  );
});

test("delegates-mode-cascade: only provider-declared classes advance the mode, resetting the model", () => {
  assert.deepEqual(nextVoice("quota", lastModel, agy), {
    kind: "next-mode",
    position: { model: 0, mode: 1 },
  });
  assert.deepEqual(nextVoice("timeout", lastModel, agy), {
    kind: "terminal",
    scope: "slot",
    reason: "agy[0] failed: timeout",
  });
  assert.equal(nextVoice("quota", { model: 1, mode: 1 }, agy).kind, "terminal");
});

test("delegates-reserves: exhausted voices prefer reserves then stop", () => {
  assert.deepEqual(
    nextVoice("timeout", lastModel, agy, { reserveAvailable: true }),
    { kind: "reserve" }
  );
  assert.equal(
    nextVoice("timeout", lastModel, agy, { reserveAvailable: false }).kind,
    "terminal"
  );
});

test("delegates-reserves-once: each reserve is consumed once per fan-out directory with recorded substitutions", () => {
  const pool = reservePool(["copilot[0]", "opencode[0]"]);
  const first = takeReserve(pool, "agy[0]", "timeout");
  const second = takeReserve(first.pool, "codex[0]", "quota");
  const third = takeReserve(second.pool, "claude[0]", "auth");
  assert.deepEqual(
    [first.reserve, second.reserve, third.reserve],
    ["copilot[0]", "opencode[0]", null]
  );
  assert.equal(hasReserve(third.pool), false);
  assert.deepEqual(third.pool.records, [
    "agy[0] → copilot[0]: timeout",
    "codex[0] → opencode[0]: quota",
  ]);
});
