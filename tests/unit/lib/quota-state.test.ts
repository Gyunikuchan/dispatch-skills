import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { renameRetrying } from "../../../skills/dispatch/scripts/lib/node-fs-ext.ts";
import {
  publishQuotaFailure,
  readQuotaState,
  reprobeQuota,
} from "../../../skills/dispatch/scripts/lib/quota-store.ts";
import { initSession } from "../../../skills/dispatch/scripts/lib/session.ts";
import {
  H,
  quotaSnapshot,
} from "../../../skills/dispatch/scripts/policy/quota.ts";
import type { QuotaKey } from "../../../skills/dispatch/scripts/toolkit/types.ts";
import { defined } from "../../helpers/guards.ts";

const key: QuotaKey = { provider: "codex", model: null, mode: "cli" };
const now = 100 * H + 100;

const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quota-state-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

  const sessionDir = initSession({
    repositoryRoot: repo,
    sessionId: crypto.randomUUID(),
    sessionTitle: "Quota fixture",
    now: new Date("2026-10-19T00:00:00Z"),
  }).path;

  const options = { sessionDir, repositoryRoot: repo, bucketWidth: H };

  const capture = (keys: QuotaKey[] = [key], clock = now) => {
    const state = readQuotaState(options, keys, clock);

    return {
      ...state,
      snapshot: quotaSnapshot(
        keys,
        state.generations,
        state.observations,
        clock
      ),
    };
  };

  const quotaDir = () =>
    path.join(
      sessionDir,
      ".state",
      "quota",
      crypto
        .createHash("sha256")
        .update(JSON.stringify([key.provider, key.model, key.mode]))
        .digest("hex")
    );

  return {
    root,
    repo,
    sessionDir,
    options,
    capture,
    quotaDir,
    cleanup: () => {
      try {
        fs.rmSync(root, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      } catch {
        /* Windows locked handle */
      }
    },
  };
};

test("reprobe race: Windows can replace the generation after a prolonged sharing lock", ({
  mock,
}) => {
  let waited = 0;
  mock.method(
    Atomics,
    "wait",
    (_array: Int32Array, _index: number, _value: number, timeout: number) => {
      waited += timeout;

      return "timed-out";
    }
  );
  let generation = "old";

  const sharingViolation = Object.assign(
    new Error("Generation marker is open"),
    { code: "EPERM" }
  );

  renameRetrying("pending.json", "generation.json", {
    platform: "win32",
    rename() {
      if (waited < 3200) {
        throw sharingViolation;
      }

      generation = "new";
    },
  });
  assert.equal(generation, "new");
});

test("old bucket volume cannot hide valid current and previous bucket evidence", () => {
  const f = setup();

  try {
    const { generation } = defined(f.capture().generations[0]);

    for (let bucket = 1; bucket <= 10; bucket += 1) {
      assert.equal(
        publishQuotaFailure(f.options, key, generation, bucket * H).published,
        true
      );
    }

    const at = 100 * H - 1;
    publishQuotaFailure(f.options, key, generation, at);
    publishQuotaFailure(f.options, key, generation, 100 * H);
    const state = f.capture([key], 100 * H + 1);
    assert.equal(defined(state.snapshot.decisions[0]).skipped, true);
    assert.equal(state.observations.length, 2);
    assert.equal(fs.readdirSync(f.quotaDir()).length, 13);
    fs.writeFileSync(path.join(f.quotaDir(), `${generation}.100.json`), "{");
    assert.equal(
      defined(f.capture([key], 100 * H + 1).snapshot.decisions[0]).skipped,
      true
    );
  } finally {
    f.cleanup();
  }
});

test("malformed oversized unsupported and future records use normal routing", () => {
  for (const corrupt of [
    "{",
    "x".repeat(8193),
    JSON.stringify({ schemaVersion: 2 }),
  ]) {
    const f = setup();

    try {
      f.capture();
      fs.writeFileSync(path.join(f.quotaDir(), "generation.json"), corrupt);
      const state = f.capture();
      assert.equal(defined(state.snapshot.decisions[0]).skipped, false);
      assert.equal(state.warnings.length, 1);
    } finally {
      f.cleanup();
    }
  }

  for (const corrupt of [
    "{",
    "x".repeat(4097),
    JSON.stringify({ schemaVersion: 2 }),
    "future",
  ]) {
    const f = setup();

    try {
      const marker = defined(f.capture().generations[0]);

      const observation = path.join(
        f.quotaDir(),
        `${marker.generation}.${Math.floor(now / H)}.json`
      );

      fs.writeFileSync(
        observation,
        corrupt === "future"
          ? JSON.stringify({
              ...marker,
              bucket: Math.floor(now / H),
              observedAt: now + 1,
            })
          : corrupt
      );
      const state = f.capture();
      assert.equal(defined(state.snapshot.decisions[0]).skipped, false);
      assert.equal(state.warnings.length, 1);
    } finally {
      f.cleanup();
    }
  }
});

test("linked state and records cannot redirect reads or writes", () => {
  for (const locus of [".state", "quota", "key", "generation", "observation"]) {
    const f = setup();

    try {
      const marker = defined(f.capture().generations[0]);
      const outside = path.join(f.root, "outside");
      fs.mkdirSync(outside);
      const sentinel = path.join(outside, "sentinel");
      fs.writeFileSync(sentinel, "intact");

      const target =
        // eslint-disable-next-line eslint/no-nested-ternary -- compact fixture expectation table.
        locus === ".state"
          ? path.join(f.sessionDir, ".state")
          : // eslint-disable-next-line eslint/no-nested-ternary -- compact fixture expectation table.
            locus === "quota"
            ? path.join(f.sessionDir, ".state", "quota")
            : // eslint-disable-next-line eslint/no-nested-ternary -- compact fixture expectation table.
              locus === "key"
              ? f.quotaDir()
              : locus === "generation"
                ? path.join(f.quotaDir(), "generation.json")
                : path.join(
                    f.quotaDir(),
                    `${marker.generation}.${Math.floor(now / H)}.json`
                  );

      const isFile = locus === "generation" || locus === "observation";

      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: !isFile });
      }

      fs.symlinkSync(
        isFile ? sentinel : outside,
        target,
        // eslint-disable-next-line eslint/no-nested-ternary -- compact fixture expectation table.
        isFile ? "file" : process.platform === "win32" ? "junction" : "dir"
      );
      const state = f.capture();
      assert.equal(defined(state.snapshot.decisions[0]).skipped, false, locus);
      assert.equal(state.warnings.length, 1, locus);
      assert.equal(
        publishQuotaFailure(f.options, key, marker.generation, now).published,
        false,
        locus
      );

      if (locus !== "observation") {
        assert.throws(() => reprobeQuota(f.options, key), locus);
      }

      assert.equal(fs.readFileSync(sentinel, "utf-8"), "intact");
      assert.deepEqual(fs.readdirSync(outside), ["sentinel"]);
    } finally {
      f.cleanup();
    }
  }
});
