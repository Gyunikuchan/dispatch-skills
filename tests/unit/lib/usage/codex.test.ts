import assert from "node:assert/strict";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";

import {
  codex,
  codexUsage,
} from "../../../../skills/dispatch/scripts/lib/usage/codex.ts";
import {
  nodeHostUsageFs,
  readHostUsage,
} from "../../../../skills/dispatch/scripts/lib/usage/index.ts";
import { MAX_FILE_BYTES } from "../../../../skills/dispatch/scripts/lib/usage/read.ts";
// eslint-disable-next-line typescript/newline-after-import -- intentional test pattern.
import { lines, memoryFs, query } from "./helpers/memory-fs.ts";

const EMPTY_COUNTERS = {
  input_tokens: 10,
  cached_input_tokens: 4,
  output_tokens: 5,
  reasoning_output_tokens: 2,
};

const rollout = (time: string, id: string, compressed = false) =>
  `/home/.codex/sessions/1970/01/01/rollout-1970-01-01T00-${time}-${id}.jsonl${compressed ? ".zst" : ""}`;

const meta = (parent: string, source = "subagent") => ({
  type: "session_meta",
  payload: { parent_thread_id: parent, thread_source: source },
});

const context = {
  type: "turn_context",
  payload: { model: "m", effort: "high" },
};

const event = (
  total: number,
  at = 3000,
  counters: {
    input_tokens: number;
    cached_input_tokens?: number;
    output_tokens: number;
    reasoning_output_tokens?: number;
  } = EMPTY_COUNTERS
) => ({
  type: "event_msg",
  timestamp: new Date(at).toISOString(),
  payload: {
    type: "token_count",
    info: {
      total_token_usage: { total_tokens: total },
      last_token_usage: counters,
    },
  },
});

test("turns: codex counts resumed host and direct child usage row fields once by model", () => {
  const host = rollout("00-01", "host");
  const resumedHost = rollout("00-02", "host");
  const child = rollout("00-03", "child");
  const resumedChild = rollout("00-04", "child");

  const otherModel = {
    type: "turn_context",
    payload: { model: "other", effort: "low" },
  };

  const small = { input_tokens: 4, cached_input_tokens: 1, output_tokens: 2 };

  const files = {
    [host]: lines(meta("", ""), context, event(15)),
    [resumedHost]: lines(
      meta("", ""),
      context,
      event(15),
      event(16, 4000, small),
      otherModel,
      event(20, 5000, {
        input_tokens: 6,
        cached_input_tokens: 0,
        output_tokens: 3,
      })
    ),
    [child]: lines(meta("host"), context, event(15)),
    [resumedChild]: lines(
      meta("host"),
      context,
      event(15),
      event(16, 4000, small)
    ),
    [rollout("00-05", "grandchild")]: lines(meta("child"), context, event(21)),
    [rollout("00-06", "delegate")]: lines(meta("", "cli"), context, event(22)),
    [rollout("00-07", "guardian")]: lines(
      meta("host", "guardian_review"),
      context,
      event(23)
    ),
  };

  const result = codex.read(
    { ...query, budget: { remaining: 100_000 } },
    memoryFs(files)
  );

  assert.deepEqual(
    result.rows.map((row) => row.turns),
    [1, 1, 1, 1, 1, 1]
  );
  assert.deepEqual(
    result.rows.map((row) => [
      row.role,
      row.model,
      row.effort,
      row.depth,
      row.atMs,
      row.reasoningInOutput,
      row.input,
      row.output,
      row.cacheRead,
      row.reasoning,
    ]),
    [
      ["host", "m", "high", 0, 3000, true, 6, 5, 4, 2],
      ["host", "m", "high", 0, 4000, true, 3, 2, 1, undefined],
      ["host", "other", "low", 0, 5000, true, 6, 3, 0, undefined],
      ["subagent", "m", "high", 1, 3000, true, 6, 5, 4, 2],
      ["subagent", "m", "high", 1, 4000, true, 3, 2, 1, undefined],
      ["subagent", "m", "high", 2, 3000, true, 6, 5, 4, 2],
    ]
  );
});

test("codex counts accepted snapshots per thread and leaves repeated totals ambiguous", () => {
  const facts = readHostUsage(
    "codex",
    {
      ...query,
      env: (name) => (name === "CODEX_THREAD_ID" ? "host" : undefined),
    },
    memoryFs({
      [rollout("00-01", "host")]: lines(context, event(15, 1500)),
      [rollout("00-02", "host")]: lines(
        context,
        event(15, 3000),
        event(22, 3500)
      ),
      [rollout("00-03", "first-child")]: lines(
        meta("host"),
        context,
        event(15, 3000)
      ),
      [rollout("00-04", "first-child")]: lines(
        meta("host"),
        context,
        event(15, 3500),
        event(22, 3600)
      ),
      [rollout("00-05", "second-child")]: lines(
        meta("host"),
        context,
        event(15, 3000)
      ),
    })
  );

  assert.deepEqual(
    facts.responses?.map((r) => [
      r.stage,
      r.agent,
      r.basis,
      r.coverage,
      r.observed,
      r.uncachedInput,
    ]),
    [
      ["spec", "host-1", "codex-token-count", "partial", 1, 6],
      ["plan", "host-1", "codex-token-count", "partial", 1, 6],
      ["plan", "subagent-1", "codex-token-count", "partial", 2, 12],
      ["plan", "subagent-2", "codex-token-count", "partial", 1, 6],
    ]
  );
  assert.doesNotMatch(JSON.stringify(facts), /first-child|second-child/u);
});

test("codex ignores a pre-window token total copied into a resumed rollout", () => {
  const host = rollout("00-01", "host");
  const resumed = rollout("00-02", "host");

  const result = codex.read(
    { ...query, startMs: 2000, budget: { remaining: 10_000 } },
    memoryFs({
      [host]: lines(context, event(3, 1000)),
      [resumed]: lines(context, event(3, 3000)),
    })
  );

  assert.deepEqual(result.rows, []);
  assert.equal(result.unavailable, "no usage records");
});

test("codex requires an exact host id before reading rollout candidates", () => {
  const file =
    "/home/.codex/sessions/1970/01/01/rollout-1970-01-01T00-00-01-host-long.jsonl";

  const other = rollout("00-02", "other");

  const fs = memoryFs({
    [file]: "private",
    [other]: lines(meta("host"), context, event(2)),
  });

  const stats: string[] = [];
  let reads = 0;

  const result = codex.read(
    { ...query, budget: { remaining: 10_000 } },
    {
      ...fs,
      stat: (candidate) => {
        stats.push(candidate);

        return fs.stat(candidate);
      },
      read: (...args) => {
        reads += 1;

        return fs.read(...args);
      },
    }
  );

  assert.equal(result.unavailable, "host id file missing");
  assert.deepEqual(stats, []);
  assert.equal(reads, 0);
  assert.deepEqual(fs.reads, []);
});

test("codex stops at the shared read budget and keeps host counters", () => {
  const host = rollout("00-01", "host");
  const child = rollout("00-02", "child");
  const hostText = lines(context, event(4));

  const fs = memoryFs({
    [host]: hostText,
    [child]: lines(meta("host"), context, event(5)),
  });

  const result = codex.read(
    { ...query, budget: { remaining: Buffer.byteLength(hostText) } },
    fs
  );

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.role, "host");
  assert.equal(result.notes?.subagent?.["read budget reached"], 1);
  assert.equal(fs.reads.length, 1);

  const first = rollout("00-01", "host");
  const resumed = rollout("00-02", "host");

  const hostFs = memoryFs({
    [first]: hostText,
    [resumed]: lines(context, event(6)),
  });

  const hostStop = codex.read(
    { ...query, budget: { remaining: Buffer.byteLength(hostText) } },
    hostFs
  );

  assert.equal(hostStop.rows.length, 1);
  assert.equal(hostStop.notes?.host?.["read budget reached"], 1);
  assert.equal(hostFs.reads.length, 1);
});

test("codex keeps child rows when the host transcript is compressed or oversized", () => {
  const host = rollout("00-01", "host", true);
  const child = rollout("00-02", "child");

  const fs = memoryFs({
    [host]: "compressed",
    [child]: lines(meta("host"), context, event(4)),
  });

  const unsupported = codex.read(
    { ...query, budget: { remaining: 10_000 } },
    fs
  );

  assert.equal(unsupported.unavailable, "zstd unavailable");
  assert.equal(unsupported.rows[0]?.role, "subagent");

  const oversizedFs = memoryFs({
    [host]: "compressed",
    [child]: lines(meta("host"), context, event(4)),
  });

  const oversized = codex.read(
    { ...query, budget: { remaining: 256 * 1024 * 1024 } },
    {
      ...oversizedFs,
      stat: (file) =>
        file.endsWith("host.jsonl.zst")
          ? { size: 128 * 1024 * 1024 + 1, mtimeMs: 10_000 }
          : oversizedFs.stat(file),
    }
  );

  assert.equal(oversized.unavailable, "transcript over size cap");
  assert.equal(oversized.rows[0]?.role, "subagent");
  assert.equal(oversizedFs.reads.length, 1);

  const plainHost = rollout("00-03", "host");

  const plainFs = memoryFs({
    [plainHost]: "x",
    [child]: lines(meta("host"), context, event(2)),
  });

  const plainResult = codex.read(
    { ...query, budget: { remaining: 256 * 1024 * 1024 } },
    {
      ...plainFs,
      stat: (file) =>
        file.endsWith("host.jsonl")
          ? { size: MAX_FILE_BYTES + 1, mtimeMs: 10_000 }
          : plainFs.stat(file),
    }
  );

  assert.equal(plainResult.unavailable, "transcript over size cap");
  assert.equal(plainResult.rows[0]?.role, "subagent");
});

test("codex reports unsupported, oversized, and over-budget child transcripts", () => {
  const host = rollout("00-01", "host");
  const unsupported = rollout("00-02", "zip", true);
  const oversized = rollout("00-03", "big");
  const oversizedCompressed = rollout("00-04", "big-zip", true);
  const hostText = lines(context, event(4));

  const fs = memoryFs({
    [host]: hostText,
    [unsupported]: "compressed",
    [oversized]: "x",
    [oversizedCompressed]: "x",
  });

  const result = codex.read(
    { ...query, budget: { remaining: 256 * 1024 * 1024 } },
    {
      ...fs,
      stat: (file) =>
        // eslint-disable-next-line eslint/no-nested-ternary -- compact fixture expectation table.
        file.endsWith("big.jsonl")
          ? { size: MAX_FILE_BYTES + 1, mtimeMs: 10_000 }
          : file.endsWith("big-zip.jsonl.zst")
            ? { size: MAX_FILE_BYTES * 2 + 1, mtimeMs: 10_000 }
            : fs.stat(file),
    }
  );

  assert.equal(result.rows.length, 1);
  assert.equal(result.notes?.subagent?.["zstd unavailable"], 1);
  assert.equal(result.notes?.subagent?.["unverified candidates"], 2);

  const child = rollout("00-02", "child", true);
  const childText = lines(meta("host"), context, event(5));

  const compressedFs = memoryFs({
    [host]: hostText,
    [child]: zstdCompressSync(Buffer.from(childText)),
  });

  const budgeted = codex.read(
    { ...query, budget: { remaining: Buffer.byteLength(hostText) + 10 } },
    {
      ...compressedFs,
      decompress: nodeHostUsageFs.decompress,
    }
  );

  assert.equal(budgeted.rows.length, 1);
  assert.equal(budgeted.rows[0]?.role, "host");
  assert.equal(budgeted.notes?.subagent?.["read budget reached"], 1);
});

test("codex ignores stale and removed children while deduplicating resumed child totals", () => {
  const host = rollout("00-01", "host");
  const first = rollout("00-02", "child");
  const resumed = rollout("00-03", "child");
  const stale = rollout("00-04", "stale");
  const removed = rollout("00-05", "removed");

  const fs = memoryFs(
    {
      [host]: lines(context, event(1)),
      [first]: lines(meta("host"), context, event(7, 1000)),
      [resumed]: lines(meta("host"), context, event(7, 3000), event(8, 4000)),
      [stale]: lines(meta("host"), context, event(9)),
      [removed]: lines(meta("host"), context, event(10)),
    },
    { [stale]: 1000 }
  );

  let removedStats = 0;

  const result = codex.read(
    { ...query, startMs: 2000, budget: { remaining: 100_000 } },
    {
      ...fs,
      stat: (file) =>
        file.endsWith("removed.jsonl") && (removedStats += 1) > 1
          ? null
          : fs.stat(file),
    }
  );

  assert.equal(result.rows.filter((row) => row.role === "subagent").length, 1);
  assert.equal(result.rows.find((row) => row.role === "subagent")?.input, 6);
  assert.ok(
    !fs.reads.some(
      (file) => file.endsWith("stale.jsonl") || file.endsWith("removed.jsonl")
    )
  );
});

test("codex ignores unrelated lines and malformed events do not poison token totals", () => {
  const host = rollout("00-01", "host");
  const badTime = { ...event(7), timestamp: "invalid" };

  const badCounter = {
    ...event(8),
    payload: {
      ...event(8).payload,
      info: {
        ...event(8).payload.info,
        last_token_usage: {
          input_tokens: 2,
          cached_input_tokens: 3,
          output_tokens: 1,
        },
      },
    },
  };

  const badOptional = {
    ...event(9),
    payload: {
      ...event(9).payload,
      info: {
        ...event(9).payload.info,
        last_token_usage: {
          input_tokens: 2,
          output_tokens: 1,
          reasoning_output_tokens: -1,
        },
      },
    },
  };

  const fs = memoryFs({
    [host]: lines(
      null,
      1,
      { type: "user" },
      { type: "event_msg", payload: { type: "other" } },
      event(6),
      context,
      event(6),
      badTime,
      event(7),
      badCounter,
      event(8),
      badOptional,
      event(9),
      event(10)
    ),
  });

  const result = codex.read({ ...query, budget: { remaining: 10_000 } }, fs);
  assert.equal(result.unavailable, undefined);
  assert.deepEqual(
    result.rows.map((row) => row.input),
    [6, 6, 6, 6, 6]
  );
  assert.equal(result.notes?.host?.["unparsed lines"], 4);

  const child = rollout("00-02", "child");

  const partial = codex.read(
    { ...query, budget: { remaining: 10_000 } },
    memoryFs({
      [host]: "{bad\n",
      [child]: lines(meta("host"), context, event(3)),
    })
  );

  assert.equal(partial.unavailable, "no usage records");
  assert.equal(partial.notes?.host?.["unparsed lines"], 1);
  assert.equal(partial.rows[0]?.role, "subagent");
});

test("codex lists rollout dates but stats only candidates in the bounded window", () => {
  const host = rollout("00-01", "host");
  const child = rollout("00-02", "child");

  const old =
    "/home/.codex/sessions/1969/12/31/rollout-1969-12-31T00-00-01-old.jsonl";

  const future =
    "/home/.codex/sessions/1970/01/04/rollout-1970-01-04T00-00-01-future.jsonl";

  const fs = memoryFs({
    [host]: lines(context, event(1)),
    [child]: lines(meta("host"), context, event(2)),
    [old]: "old",
    [future]: "future",
  });

  const stats: string[] = [];
  const lists: string[] = [];

  const result = codex.read(
    { ...query, budget: { remaining: 10_000 } },
    {
      ...fs,
      stat: (file) => {
        stats.push(file);

        return fs.stat(file);
      },
      list: (dir) => {
        lists.push(dir);

        return fs.list(dir);
      },
    }
  );

  assert.equal(result.rows.length, 2);
  assert.ok(
    stats.every(
      (file) => !file.includes("old.jsonl") && !file.includes("future.jsonl")
    )
  );
  assert.equal(
    lists.filter(
      (dir) =>
        dir.endsWith(String.raw`1969\12\31`) || dir.endsWith("1969/12/31")
    ).length,
    1
  );
  assert.equal(
    lists.filter(
      (dir) =>
        dir.endsWith(String.raw`1970\01\04`) || dir.endsWith("1970/01/04")
    ).length,
    1
  );
});

test("codex caps candidates and keeps the newest ones", () => {
  const host = rollout("00-00", "host");
  const files = { [host]: lines(context, event(4)) };

  for (let i = 0; i < 257; i += 1) {
    const time = `${String(Math.floor(i / 60) + 1).padStart(2, "0")}-${String(i % 60).padStart(2, "0")}`;
    files[rollout(time, `child-${i}`)] = lines(
      meta("host"),
      context,
      event(i + 1)
    );
  }

  const fs = memoryFs(files);

  const result = codex.read(
    { ...query, budget: { remaining: 1024 * 1024 } },
    fs
  );

  assert.equal(result.notes?.subagent?.["too many candidates"], 1);
  assert.equal(
    result.rows.filter((row) => row.role === "subagent").length,
    256
  );
  assert.ok(!fs.reads.some((file) => file.includes("child-0.jsonl")));

  const resumedFiles = { [host]: lines(context, event(1)) };
  const times: Record<string, number> = {};

  for (let i = 0; i < 257; i += 1) {
    const time = `${String(Math.floor(i / 60) + 1).padStart(2, "0")}-${String(i % 60).padStart(2, "0")}`;
    const file = rollout(time, "child");
    resumedFiles[file] = lines(meta("host"), context, event(i + 1));
    times[file] = i === 256 ? 10_000 : 1000;
  }

  const resumedFs = memoryFs(resumedFiles, times);

  const resumedResult = codex.read(
    { ...query, startMs: 2000, budget: { remaining: 1_000_000 } },
    resumedFs
  );

  assert.equal(resumedResult.notes?.subagent?.["too many candidates"], 1);
  assert.equal(
    resumedResult.rows.filter((row) => row.role === "subagent").length,
    0
  );
  assert.equal(resumedFs.reads.length, 1);
});

test("codex finds direct children from the earliest host rollout date", () => {
  const earlyHost = rollout("00-01", "host");
  const earlyChild = rollout("00-02", "child");

  const lateHost =
    "/home/.codex/sessions/1970/01/02/rollout-1970-01-02T00-00-01-host.jsonl";

  const fs = memoryFs({
    [earlyHost]: lines(context, event(1)),
    [lateHost]: lines(context, event(2)),
    [earlyChild]: lines(meta("host"), context, event(3)),
  });

  const result = codex.read({ ...query, budget: { remaining: 10_000 } }, fs);
  assert.equal(result.rows.filter((row) => row.role === "host").length, 2);
  assert.equal(result.rows.filter((row) => row.role === "subagent").length, 1);
});

test("codex reads compressed host and child rollouts within the decoded-byte budget", () => {
  const host = rollout("00-01", "host", true);
  const child = rollout("00-02", "child", true);
  const hostText = lines(meta("", ""), context, event(4));
  const childText = lines(meta("host"), context, event(5));

  const fs = memoryFs({
    [host]: zstdCompressSync(Buffer.from(hostText)),
    [child]: zstdCompressSync(Buffer.from(childText)),
  });

  const budget = { remaining: 10_000 };

  const result = codex.read(
    { ...query, budget },
    { ...fs, decompress: nodeHostUsageFs.decompress }
  );

  assert.deepEqual(
    result.rows.map((row) => row.role),
    ["host", "subagent"]
  );
  assert.equal(
    budget.remaining,
    10_000 - Buffer.byteLength(hostText) - Buffer.byteLength(childText)
  );
});

test("codex hides host and child read errors while retaining other child usage", () => {
  const host = rollout("00-01", "host");
  const bad = rollout("00-02", "bad");
  const good = rollout("00-03", "good");

  const fs = memoryFs({
    [host]: "x",
    [bad]: "x",
    [good]: lines(meta("host"), context, event(2)),
  });

  const result = codex.read(
    { ...query, budget: { remaining: 10_000 } },
    {
      ...fs,
      read: (file, max) => {
        if (file.endsWith("host.jsonl")) {
          throw Object.assign(new Error("private"), { code: "EPERM" });
        }

        if (file.endsWith("bad.jsonl")) {
          throw new Error("private");
        }

        return fs.read(file, max);
      },
    }
  );

  assert.equal(result.unavailable, "read-error:EPERM");
  assert.equal(result.notes?.subagent?.["unreadable files"], 1);
  assert.equal(result.rows[0]?.role, "subagent");
  assert.ok(!JSON.stringify(result).includes("private"));

  const degraded = memoryFs({
    [host]: lines(context, event(1)),
    [bad]: lines(meta("host"), context, event(2)),
  });

  let listCount = 0;

  const listFailure = codex.read(
    { ...query, budget: { remaining: 10_000 } },
    {
      ...degraded,
      list: (dir) => {
        if (/1970[\\/]01[\\/]01$/u.test(dir) && (listCount += 1) === 2) {
          throw Object.assign(new Error("private"), { code: "EACCES" });
        }

        return degraded.list(dir);
      },
    }
  );

  assert.equal(listFailure.rows[0]?.role, "host");
  assert.equal(listFailure.notes?.subagent?.["unreadable files"], 1);

  const statFailure = codex.read(
    { ...query, budget: { remaining: 10_000 } },
    {
      ...degraded,
      stat: (file) => {
        if (file.endsWith("bad.jsonl")) {
          throw new Error("private");
        }

        return degraded.stat(file);
      },
    }
  );

  assert.equal(statFailure.rows[0]?.role, "host");
  assert.equal(statFailure.notes?.subagent?.["unreadable files"], 1);
});

test("codex validates the first nonblank child header before counting rows", () => {
  const host = rollout("00-01", "host");
  const child = rollout("00-02", "child");
  const resumed = rollout("00-03", "child");
  const other = rollout("00-04", "other");

  const fs = memoryFs({
    [host]: lines(context, event(1)),
    [child]: `\n${lines(meta("host"), context, event(7))}`,
    [resumed]: `\n${lines(meta("host"), context, event(7))}`,
    [other]: `\n${lines(meta("other"), context, event(8))}`,
  });

  const result = codex.read({ ...query, budget: { remaining: 10_000 } }, fs);
  assert.equal(result.rows.filter((row) => row.role === "subagent").length, 1);
});

test("codex repeated compressed overflows exhaust the shared decode budget", () => {
  const host = rollout("00-01", "host");
  const text = lines(context, event(1));
  const files = { [host]: text };

  for (let i = 2; i <= 4; i += 1) {
    files[rollout(`00-0${i}`, `child-${i}`, true)] = "x";
  }

  const fs = memoryFs(files);

  const result = codex.read(
    {
      ...query,
      budget: { remaining: Buffer.byteLength(text) + 2 * MAX_FILE_BYTES },
    },
    {
      ...fs,
      decompress: () => {
        throw Object.assign(new Error("large"), {
          code: "ERR_BUFFER_TOO_LARGE",
        });
      },
    }
  );

  assert.equal(result.rows.length, 1);
  assert.equal(result.notes?.subagent?.["unverified candidates"], 2);
  assert.equal(result.notes?.subagent?.["read budget reached"], 1);
  assert.equal(fs.reads.length, 3);
});

test("codex does not count resumed child usage after unreadable or oversized history", () => {
  const host = rollout("00-01", "host");
  const prior = rollout("00-02", "child");
  const live = rollout("00-03", "child");

  const fs = memoryFs(
    {
      [host]: lines(context, event(1)),
      [prior]: lines(meta("host"), context, event(7, 1000)),
      [live]: lines(meta("host"), context, event(7, 3000)),
    },
    { [prior]: 1000 }
  );

  for (const failure of ["read", "size"]) {
    const result = codex.read(
      { ...query, startMs: 2000, budget: { remaining: 256 * 1024 * 1024 } },
      {
        ...fs,
        stat: (file) =>
          failure === "size" && file.includes("00-00-02-child.jsonl")
            ? { size: MAX_FILE_BYTES + 1, mtimeMs: 1000 }
            : fs.stat(file),
        read: (file, max) => {
          if (failure === "read" && file.includes("00-00-02-child.jsonl")) {
            throw new Error("private");
          }

          return fs.read(file, max);
        },
      }
    );

    assert.equal(
      result.rows.filter((row) => row.role === "subagent").length,
      0
    );
    assert.equal(
      result.notes?.subagent?.[
        failure === "read" ? "unreadable files" : "unverified candidates"
      ],
      1
    );
  }

  // A vanished prior history skips the resumed thread the same way.
  const vanished = memoryFs({
    [host]: lines(context, event(1)),
    [prior]: lines(meta("host"), context, event(7, 1000)),
    [live]: lines(meta("host"), context, event(7, 3000)),
  });

  let priorStats = 0;

  const vanishedResult = codex.read(
    { ...query, startMs: 2000, budget: { remaining: 10_000 } },
    {
      ...vanished,
      stat: (file) =>
        file.includes("00-00-02-child.jsonl") && (priorStats += 1) > 1
          ? null
          : vanished.stat(file),
    }
  );

  assert.equal(
    vanishedResult.rows.filter((row) => row.role === "subagent").length,
    0
  );
  assert.equal(vanishedResult.notes?.subagent?.["unreadable files"], 1);
});

test("codex keeps earlier child rows but stops that thread after later read failure", () => {
  const host = rollout("00-01", "host");
  const first = rollout("00-02", "child");
  const failed = rollout("00-03", "child");
  const last = rollout("00-04", "child");

  const fs = memoryFs({
    [host]: lines(context, event(1)),
    [first]: lines(meta("host"), context, event(7)),
    [failed]: "x",
    [last]: lines(meta("host"), context, event(8)),
  });

  const result = codex.read(
    { ...query, budget: { remaining: 10_000 } },
    {
      ...fs,
      read: (file, max) => {
        if (file.includes("00-00-03-child.jsonl")) {
          throw new Error("private");
        }

        return fs.read(file, max);
      },
    }
  );

  assert.equal(result.rows.filter((row) => row.role === "subagent").length, 1);
  assert.equal(result.notes?.subagent?.["unreadable files"], 1);
  assert.ok(!fs.reads.some((file) => file.includes("00-00-04-child.jsonl")));
});

test("codex omits a readable child when another date directory cannot be searched", () => {
  const host = rollout("00-01", "host");
  const child = rollout("00-02", "child");

  const hidden =
    "/home/.codex/sessions/1970/01/02/rollout-1970-01-02T00-00-01-other.jsonl";

  const fs = memoryFs({
    [host]: lines(context, event(1)),
    [child]: lines(meta("host"), context, event(2)),
    [hidden]: "x",
  });

  let dateLists = 0;

  const result = codex.read(
    { ...query, budget: { remaining: 10_000 } },
    {
      ...fs,
      list: (dir) => {
        if (/1970[\\/]01[\\/]02$/u.test(dir) && (dateLists += 1) === 2) {
          throw new Error("private");
        }

        return fs.list(dir);
      },
    }
  );

  assert.equal(result.rows.filter((row) => row.role === "host").length, 1);
  assert.equal(result.rows.filter((row) => row.role === "subagent").length, 0);
  assert.equal(result.notes?.subagent?.["unreadable files"], 1);

  // An inaccessible host-search directory avoids uncertain attribution the same way.
  const hostOnly = rollout("00-01", "host");

  const olderHidden =
    "/home/.codex/sessions/1969/12/31/rollout-1969-12-31T00-00-01-other.jsonl";

  const blockedFs = memoryFs({
    [hostOnly]: lines(context, event(1)),
    [olderHidden]: "x",
  });

  const blocked = codex.read(
    { ...query, budget: { remaining: 10_000 } },
    {
      ...blockedFs,
      list: (dir) => {
        if (/1969[\\/]12[\\/]31$/u.test(dir)) {
          throw Object.assign(new Error("private"), { code: "EACCES" });
        }

        return blockedFs.list(dir);
      },
    }
  );

  assert.equal(blocked.unavailable, "read-error:EACCES");
  assert.deepEqual(blocked.rows, []);
  assert.deepEqual(blockedFs.reads, []);
});

test("codex reports and blocks listed files that vanish before discovery stat", () => {
  const host = rollout("00-01", "host");
  const child = rollout("00-02", "child");

  const files = {
    [host]: lines(context, event(1)),
    [child]: lines(meta("host"), context, event(2)),
  };

  for (const failure of ["vanish", "throw"] as const) {
    const fs = memoryFs(files);

    const vanished = codex.read(
      { ...query, budget: { remaining: 100_000 } },
      {
        ...fs,
        stat: (file) => {
          if (!file.includes("00-00-02-child.jsonl")) {
            return fs.stat(file);
          }

          if (failure === "vanish") {
            return null;
          }

          throw Object.assign(new Error("private"), { code: "EACCES" });
        },
      }
    );

    assert.equal(
      vanished.rows.filter((row) => row.role === "host").length,
      1,
      failure
    );
    assert.equal(
      vanished.rows.filter((row) => row.role === "subagent").length,
      0,
      failure
    );
    assert.equal(vanished.notes?.subagent?.["unreadable files"], 1, failure);
  }

  const single = memoryFs({
    [rollout("00-01", "host")]: lines(context, event(1)),
  });

  let calls = 0;

  const vanishRead = codex.read(
    { ...query, budget: { remaining: 10_000 } },
    {
      ...single,
      stat: (file) =>
        file.endsWith("host.jsonl") && (calls += 1) === 2
          ? null
          : single.stat(file),
    }
  );

  assert.equal(vanishRead.unavailable, "read-error:ENOENT");
  assert.deepEqual(vanishRead.rows, []);
});

test("codex nested subagents count depth-3 and out-of-order headers without noting unrelated sessions", () => {
  const host = rollout("00-00", "host");
  const depth3 = rollout("00-01", "d3");
  const depth2 = rollout("00-02", "d2");
  const depth1 = rollout("00-03", "d1");
  const unrelated = rollout("00-04", "unrelated");

  const result = codex.read(
    { ...query, budget: { remaining: 100_000 } },
    memoryFs({
      [host]: lines(meta("", ""), context, event(1)),
      [depth3]: lines(meta("d2"), context, event(4)),
      [depth2]: lines(meta("d1"), context, event(3)),
      [depth1]: lines(meta("host"), context, event(2)),
      [unrelated]: lines(meta("unknown-parent"), context, event(5)),
    })
  );

  assert.deepEqual(
    result.rows.map((r) => [r.role, r.depth]),
    [
      ["host", 0],
      ["subagent", 1],
      ["subagent", 2],
      ["subagent", 3],
    ]
  );
  assert.equal(result.notes?.subagent, undefined);
});

test("codex stdout usage subtracts cached tokens into uncached input", () => {
  const raw = [
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 40,
        output_tokens: 10,
        reasoning_output_tokens: 3,
      },
    }),
  ].join("\n");

  assert.deepEqual(codexUsage(raw), {
    input: 60,
    output: 10,
    cacheRead: 40,
    reasoning: 3,
    scope: "invocation",
    provenance: "codex.turn.completed",
    inputSemantics: "uncached",
  });
});

test("codex real-shape rollout extracts tool calls and tool turns while omitting user turns without user_message", () => {
  const host = rollout("00-01", "host");
  const child = rollout("00-02", "child");

  const fs = memoryFs({
    [host]: lines(
      {
        type: "session_meta",
        timestamp: new Date(500).toISOString(),
        payload: { id: "host", thread_source: "cli" },
      },
      {
        type: "event_msg",
        timestamp: new Date(600).toISOString(),
        payload: { type: "task_started" },
      },
      context,
      {
        type: "response_item",
        timestamp: new Date(700).toISOString(),
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "AGENTS.md bootstrap prompt secret" },
          ],
        },
      },
      {
        type: "response_item",
        timestamp: new Date(800).toISOString(),
        payload: {
          type: "function_call",
          name: "shell",
          arguments: '{"cmd":"secret"}',
        },
      },
      {
        type: "response_item",
        timestamp: new Date(900).toISOString(),
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          input: "secret",
        },
      },
      event(10, 1000),
      // duplicate total snapshot
      event(10, 1100),
      {
        type: "response_item",
        timestamp: new Date(2500).toISOString(),
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done" }],
        },
      },
      event(20, 3000)
    ),
    [child]: lines(
      meta("host"),
      context,
      {
        type: "response_item",
        timestamp: new Date(2600).toISOString(),
        payload: { type: "custom_tool_call", name: "read_file", input: "x" },
      },
      event(5, 2700)
    ),
  });

  const result = codex.read({ ...query, budget: { remaining: 100_000 } }, fs);
  assert.equal(result.userTurns, undefined);
  assert.equal(result.userTurnsByStage, undefined);
  assert.deepEqual(
    result.rows.map((r) => [r.role, r.turns, r.toolCalls, r.toolTurns]),
    [
      ["host", 1, 2, 1],
      ["host", 1, 0, 0],
      ["subagent", 1, 1, 1],
    ]
  );
  assert.ok(!JSON.stringify(result).includes("secret"));
});

test("codex counts explicit event_msg user_message turns by stage", () => {
  const host = rollout("00-01", "host");
  const child = rollout("00-02", "child");

  const fs = memoryFs({
    [host]: lines(
      context,
      {
        type: "event_msg",
        timestamp: new Date(500).toISOString(),
        payload: { type: "user_message", message: "first secret" },
      },
      event(10, 1000),
      {
        type: "event_msg",
        timestamp: new Date(2500).toISOString(),
        payload: { type: "user_message", message: "second secret" },
      },
      {
        type: "event_msg",
        timestamp: new Date(3000).toISOString(),
        payload: { type: "user_message", message: "third secret" },
      },
      event(20, 3500)
    ),
    [child]: lines(
      meta("host"),
      context,
      {
        type: "event_msg",
        timestamp: new Date(2600).toISOString(),
        payload: { type: "user_message", message: "child prompt" },
      },
      event(5, 2700)
    ),
  });

  const result = codex.read({ ...query, budget: { remaining: 100_000 } }, fs);
  assert.equal(result.userTurns, 3);
  assert.deepEqual(result.userTurnsByStage, { spec: 1, plan: 2 });
  assert.equal(result.rows[0]?.toolCalls, undefined);
  assert.equal(result.rows[0]?.toolTurns, undefined);
  assert.ok(!JSON.stringify(result).includes("secret"));
});
