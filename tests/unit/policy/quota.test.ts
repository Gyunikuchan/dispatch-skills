import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  H,
  emptyOutputBreakerOpen,
  quotaSnapshot,
} from "../../../skills/dispatch/scripts/policy/quota.ts";
import type {
  EmptyOutputRecord,
  QuotaGeneration,
  QuotaKey,
  QuotaObservation,
} from "../../../skills/dispatch/scripts/toolkit/types.ts";
import { defined } from "../../helpers/guards.ts";

// SECTION: Quota cooldown eligibility

describe("quota eligibility preserves exact keys and bounded expiry", () => {
  const key: QuotaKey = { provider: "codex", model: null, mode: "cli" };

  const marker: QuotaGeneration = {
    schemaVersion: 1,
    key,
    generation: "00000000-0000-4000-8000-000000000001",
  };

  const observation: QuotaObservation = {
    ...marker,
    bucket: 3,
    observedAt: 4 * H - 1,
  };

  const decide = (
    now: number,
    rows: readonly unknown[] = [observation],
    markers: readonly unknown[] = [marker]
  ) => defined(quotaSnapshot([key], markers, rows, now).decisions[0]);

  test("only the exact provider model and mode are suppressed in configured order", () => {
    const keys = [
      key,
      { ...key, provider: "claude" },
      { ...key, model: "default" },
      { ...key, model: "../alias" },
      { ...key, mode: "desktop" },
    ];

    const result = quotaSnapshot(keys, [marker], [observation], 4 * H);
    assert.deepEqual(
      result.decisions.map((row) => row.key),
      keys
    );
    assert.deepEqual(
      result.decisions.map((row) => row.skipped),
      [true, false, false, false, false]
    );
    assert.equal(result.policyVersion, 1);
    assert.equal(result.decidedAt, 4 * H);
    assert.equal(defined(result.decisions[0]).reason, "quota-cooldown");
    const current = decide(4 * H);
    assert.equal(
      "expiresAt" in current ? current.expiresAt : undefined,
      observation.observedAt + H
    );
  });

  test("next bucket retains evidence until exact expiry and a backwards clock never suppresses", () => {
    assert.equal(decide(4 * H).skipped, true);
    assert.equal(decide(observation.observedAt + H - 1).skipped, true);
    assert.equal(decide(observation.observedAt + H).skipped, false);
    assert.equal(decide(observation.observedAt - 1).skipped, false);
    assert.equal(decide(Number.NaN).skipped, false);
    const earlier = { ...observation, observedAt: 3 * H + 1 };
    const retained = decide(4 * H, [observation, earlier]);
    assert.equal(
      "expiresAt" in retained ? retained.expiresAt : undefined,
      earlier.observedAt + H
    );
  });

  test("changed generation and invalid evidence cannot suppress", () => {
    const invalid = [
      null,
      {},
      { ...observation, schemaVersion: 2 },
      { ...observation, key: { ...key, model: "default" } },
      { ...observation, generation: "00000000-0000-4000-8000-000000000002" },
      { ...observation, bucket: 2 },
      { ...observation, observedAt: Number.POSITIVE_INFINITY },
      { ...observation, extra: "x".repeat(4096) },
    ];

    for (const row of invalid) {
      assert.equal(decide(4 * H, [row]).skipped, false);
    }

    assert.equal(
      decide(
        4 * H,
        [observation],
        [{ ...marker, generation: "00000000-0000-4000-8000-000000000002" }]
      ).skipped,
      false
    );
    assert.equal(
      decide(4 * H, [observation], [{ ...marker, extra: "x".repeat(8192) }])
        .skipped,
      false
    );
    assert.equal(decide(4 * H, [observation], []).skipped, false);
  });
});

// SECTION: Empty-output breaker

const record = (
  kind: EmptyOutputRecord["kind"],
  seq: number,
  observedAt = seq
): EmptyOutputRecord => ({
  schemaVersion: 1,
  kind,
  provider: "codex",
  model: null,
  seq,
  observedAt,
});

const failure = (seq: number, observedAt?: number) =>
  record("empty-output-failure", seq, observedAt);

const reset = (seq: number, observedAt?: number) =>
  record("empty-output-reset", seq, observedAt);

const open = (records: readonly EmptyOutputRecord[]) =>
  emptyOutputBreakerOpen({ records });

describe("empty-output breaker trips only on strictly consecutive failures", () => {
  test("one failure leaves the breaker closed and two consecutive failures trip it", () => {
    assert.equal(open([]), false);
    assert.equal(open([failure(1)]), false);
    assert.equal(open([failure(1), failure(2)]), true);
  });

  test("a later reset clears earlier failures and only newer failures count", () => {
    assert.equal(open([failure(1), failure(2), reset(3)]), false);
    assert.equal(open([failure(1), failure(2), reset(3), failure(4)]), false);
    assert.equal(
      open([failure(1), failure(2), reset(3), failure(4), failure(5)]),
      true
    );
  });

  test("same-timestamp records order strictly by seq, never by observedAt", () => {
    assert.equal(
      open([failure(2, 100), reset(1, 100), failure(3, 100)]),
      true,
      "reset with a lower seq must not clear a later failure"
    );
    assert.equal(
      open([failure(1, 100), reset(2, 100), failure(3, 100)]),
      false,
      "reset with a higher seq must clear an earlier failure"
    );
  });
});
