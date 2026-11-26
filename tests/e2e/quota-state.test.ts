import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseJson } from "../../skills/dispatch/scripts/lib/integrity.ts";
import type { JsonValue } from "../../skills/dispatch/scripts/lib/integrity.ts";
import {
  publishQuotaFailure,
  readQuotaState,
  reprobeQuota,
} from "../../skills/dispatch/scripts/lib/quota-store.ts";
import { initSession } from "../../skills/dispatch/scripts/lib/session.ts";
import {
  H,
  quotaSnapshot,
} from "../../skills/dispatch/scripts/policy/quota.ts";
import type { QuotaKey } from "../../skills/dispatch/scripts/toolkit/types.ts";
import {
  defined,
  isBoolean,
  isNumber,
  isString,
  narrow,
  objectWith,
} from "./helpers/json.ts";

const execute = async (
  file: string,
  args: string[],
  options: { cwd: string; windowsHide: boolean; env: NodeJS.ProcessEnv }
) => {
  const child = spawn(file, args, {
    cwd: options.cwd,
    windowsHide: options.windowsHide,
    env: options.env,
  });

  let stdout = "";

  let stderr = "";

  let spawnError: Error | undefined;

  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });

  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  child.on("error", (cause) => {
    spawnError = cause;
  });

  await once(child, "close");

  if (spawnError !== undefined) {
    throw spawnError;
  }

  const code = child.exitCode ?? 1;

  if (code !== 0) {
    throw Object.assign(new Error(`command failed with exit ${code}`), {
      code,
      stdout,
      stderr,
    });
  }

  return { stdout, stderr };
};

const execFailureOf = (cause: unknown) => {
  const fields = new Map<string, unknown>(Object.entries(cause ?? {}));

  const code: unknown = fields.get("code");

  const stdout: unknown = fields.get("stdout");

  const stderr: unknown = fields.get("stderr");

  if (isNumber(code) && isString(stdout) && isString(stderr)) {
    return { code, stdout, stderr };
  }

  return assert.fail("expected exec failure with code/stdout/stderr");
};

const key: QuotaKey = { provider: "codex", model: null, mode: "cli" };

/** Interfaces lack implicit index signatures; pass a JSON-shaped copy across the subprocess boundary. */
const jsonKey = (value: QuotaKey): JsonValue => ({
  provider: value.provider,
  model: value.model,
  mode: value.mode,
});

const now = 100 * H + 100;

const storeUrl = new URL(
  "../../skills/dispatch/scripts/lib/quota-store.ts",
  import.meta.url
).href;

const policyUrl = new URL(
  "../../skills/dispatch/scripts/policy/quota.ts",
  import.meta.url
).href;

const entry = fileURLToPath(
  new URL("../../skills/dispatch/scripts/dispatch.ts", import.meta.url)
);

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

  const subprocess = async (body: string, value: JsonValue) => {
    const script = `import * as store from ${JSON.stringify(storeUrl)}; import * as policy from ${JSON.stringify(policyUrl)}; const x=JSON.parse(process.argv[1]); ${body}`;

    const result = await execute(
      process.execPath,
      ["--input-type=module", "-e", script, JSON.stringify(value)],
      {
        cwd: repo,
        windowsHide: true,
        env: { ...process.env, NODE_OPTIONS: "", NODE_TEST_CONTEXT: "" },
      }
    );

    return parseJson(result.stdout);
  };

  const cli = async (provider: string, mode: string, session = sessionDir) => {
    try {
      const result = await execute(
        process.execPath,
        [
          entry,
          "session",
          "quota-reprobe",
          "--session-dir",
          session,
          "--provider",
          provider,
          "--mode",
          mode,
        ],
        {
          cwd: repo,
          windowsHide: true,
          env: { ...process.env, NODE_OPTIONS: "", NODE_TEST_CONTEXT: "" },
        }
      );

      return { exit: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failure = execFailureOf(error);

      return {
        exit: failure.code,
        stdout: failure.stdout,
        stderr: failure.stderr,
      };
    }
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

  const cleanup = () => {
    try {
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch {
      /* Windows locked handle */
      // WARNING: Windows holds quota fixtures briefly; a leftover temp dir must not fail the suite.
    }
  };

  return {
    root,
    repo,
    sessionDir,
    options,
    capture,
    subprocess,
    cli,
    quotaDir,
    cleanup,
  };
};

describe("quota state survives sessions and reprobe races", () => {
  test("complete observations survive another process and remain isolated to their session", async () => {
    const f = setup();

    try {
      const { generation } = defined(f.capture().generations[0], "generation");

      assert.equal(
        publishQuotaFailure(f.options, key, generation, now).published,
        true
      );

      const state = await f.subprocess(
        "const s=store.readQuotaState(x.options,[x.key],x.now); console.log(JSON.stringify(policy.quotaSnapshot([x.key],s.generations,s.observations,x.now).decisions[0]));",
        { options: f.options, key: jsonKey(key), now: now + 1 }
      );

      assert.equal(
        narrow(state, objectWith({ skipped: isBoolean })).skipped,
        true
      );

      const other = initSession({
        repositoryRoot: f.repo,
        sessionId: crypto.randomUUID(),
        sessionTitle: "Other quota fixture",
        now: new Date("2026-10-19T00:01:00Z"),
      }).path;

      assert.equal(
        readQuotaState({ ...f.options, sessionDir: other }, [key], now + 1)
          .observations.length,
        0
      );
      assert.equal(
        defined(f.capture([key], now + H).snapshot.decisions[0], "decision")
          .skipped,
        false
      );

      const records = fs
        .readdirSync(f.quotaDir())
        .map((name) => fs.readFileSync(path.join(f.quotaDir(), name), "utf-8"))
        .join("");

      assert.equal(records.includes(f.repo), false);
      assert.equal(records.includes("prompt"), false);
    } finally {
      f.cleanup();
    }
  });

  test("same bucket publication coalesces and unrelated keys and buckets survive", async () => {
    const f = setup();

    try {
      const { generation } = defined(f.capture().generations[0], "generation");

      assert.equal(
        publishQuotaFailure(f.options, key, generation, now).published,
        true
      );

      const publish =
        "console.log(JSON.stringify(store.publishQuotaFailure(x.options,x.key,x.generation,x.at)));";

      const coalesced = await Promise.all(
        [now + 10, now + 20].map(
          async (at) =>
            await f.subprocess(publish, {
              options: f.options,
              key: jsonKey(key),
              generation,
              at,
            })
        )
      );

      assert.equal(
        coalesced.every(
          (result) =>
            !narrow(result, objectWith({ published: isBoolean })).published
        ),
        true
      );

      const decision = defined(
        f.capture([key], now + 30).snapshot.decisions[0],
        "decision"
      );

      assert.ok("expiresAt" in decision);
      assert.equal(decision.expiresAt, now + H);

      const other = { ...key, model: "../literal/default" };

      const marker = defined(f.capture([other]).generations[0], "marker");

      await Promise.all([
        f.subprocess(publish, {
          options: f.options,
          key: jsonKey(other),
          generation: marker.generation,
          at: now,
        }),
        f.subprocess(publish, {
          options: f.options,
          key: jsonKey(key),
          generation,
          at: now + H,
        }),
      ]);
      assert.deepEqual(
        f.capture([key, other]).snapshot.decisions.map((row) => row.skipped),
        [true, true]
      );
      assert.equal(
        fs
          .readdirSync(f.quotaDir())
          .filter((name) => name !== "generation.json").length,
        2
      );
      assert.equal(
        defined(f.capture([key], now + H).snapshot.decisions[0], "decision")
          .skipped,
        true
      );
      assert.equal(
        fs
          .readdirSync(path.join(f.sessionDir, ".state", "quota"))
          .every((name) => /^[a-f0-9]{64}$/u.test(name)),
        true
      );
    } finally {
      f.cleanup();
    }
  });

  test("concurrent reprobes and late completions cannot revive an old generation", async () => {
    const f = setup();

    try {
      const { generation: old } = defined(
        f.capture().generations[0],
        "generation"
      );

      publishQuotaFailure(f.options, key, old, now);

      const results = await Promise.all(
        [1, 2].map(
          async () =>
            await f.subprocess(
              "console.log(JSON.stringify(store.reprobeQuota(x.options,x.key)));",
              {
                options: f.options,
                key: jsonKey(key),
              }
            )
        )
      );

      const { generation: active } = defined(
        f.capture().generations[0],
        "generation"
      );

      assert.ok(
        results.some(
          (result) =>
            narrow(result, objectWith({ generation: isString })).generation ===
            active
        )
      );
      assert.notEqual(active, old);
      assert.equal(
        publishQuotaFailure(f.options, key, old, now + 1).warning,
        undefined
      );
      assert.equal(
        defined(f.capture([key], now + 1).snapshot.decisions[0], "decision")
          .skipped,
        false
      );
      assert.equal(
        publishQuotaFailure(f.options, key, active, now + 2).published,
        true
      );
      assert.equal(
        defined(f.capture([key], now + 2).snapshot.decisions[0], "decision")
          .skipped,
        true
      );

      const result = await f.cli("codex", "cli");

      assert.equal(result.exit, 0, result.stderr);
      assert.equal(
        narrow(parseJson(result.stdout), objectWith({ appliesTo: isString }))
          .appliesTo,
        "future-waves"
      );
      assert.equal(
        defined(f.capture([key], now + 2).snapshot.decisions[0], "decision")
          .skipped,
        false
      );
    } finally {
      f.cleanup();
    }
  });

  test("invalid arguments unowned sessions and I/O failures cannot create quota writes", async () => {
    const f = setup();

    try {
      const unknownProvider = await f.cli("unknown", "cli");

      assert.equal(unknownProvider.exit, 1);
      assert.equal(
        fs.existsSync(path.join(f.sessionDir, ".state", "quota")),
        false
      );

      const unknownMode = await f.cli("codex", "unknown");

      assert.equal(unknownMode.exit, 1);
      assert.equal(
        fs.existsSync(path.join(f.sessionDir, ".state", "quota")),
        false
      );

      const unowned = path.join(f.root, "unowned");

      fs.mkdirSync(unowned);

      const unownedResult = await f.cli("codex", "cli", unowned);

      assert.equal(unownedResult.exit, 1);
      assert.deepEqual(fs.readdirSync(unowned), []);

      const otherRepo = path.join(f.root, "other-repo");

      fs.mkdirSync(otherRepo);
      assert.throws(() =>
        reprobeQuota({ ...f.options, repositoryRoot: otherRepo }, key)
      );
      assert.equal(
        fs.existsSync(path.join(f.sessionDir, ".state", "quota")),
        false
      );

      fs.mkdirSync(path.join(f.sessionDir, ".state"));
      fs.writeFileSync(
        path.join(f.sessionDir, ".state", "quota"),
        "unwritable path"
      );

      const state = f.capture();

      assert.equal(
        defined(state.snapshot.decisions[0], "decision").skipped,
        false
      );
      assert.equal(state.warnings.length, 1);

      const failure = publishQuotaFailure(
        f.options,
        key,
        "00000000-0000-4000-8000-000000000001",
        now
      );

      assert.equal(failure.published, false);
      assert.ok(failure.warning !== undefined && failure.warning !== null);

      assert.equal(
        fs.readFileSync(path.join(f.sessionDir, ".state", "quota"), "utf-8"),
        "unwritable path"
      );
    } finally {
      f.cleanup();
    }
  });
});
