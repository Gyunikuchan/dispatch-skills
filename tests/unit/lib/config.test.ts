import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type {
  JsonObject,
  JsonValue,
} from "../../../skills/dispatch/scripts/lib/config.ts";
import {
  loadConfig,
  loadReadCommands,
  parseJsonc,
  stripJsonc,
  validateConfig,
} from "../../../skills/dispatch/scripts/lib/config.ts";
import { defined } from "../../helpers/guards.ts";

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const contextLimit = (entry: JsonValue | undefined) =>
  isObject(entry) ? entry["context-limit"] : undefined;

test("config resolution is first-existing-wins with no merge", () => {
  const files = new Map([
    [
      path.join("/s", "config.local.jsonc"),
      '{ "read-delegates": { "claude": [] } }',
    ],
    [
      path.join("/s", "config.jsonc"),
      '{ "read-delegates": { "codex": [] }, "phases": { "x": 1 } }',
    ],
  ]);

  const local = loadConfig("/s", (file) => files.get(file) ?? null);
  assert.equal(local.path, path.join("/s", "config.local.jsonc"));
  assert.deepEqual(local.config, {
    "read-delegates": { claude: [] },
    "write-subagents": {},
    "utility-subagents": {},
    phases: {},
  });

  const only = loadConfig("/s", (file) =>
    file.endsWith(`${path.sep}config.jsonc`) ? (files.get(file) ?? null) : null
  );

  assert.deepEqual(only.config["phases"], { x: 1 });
  assert.throws(
    () => loadConfig("/s", () => null),
    /Config file not found.*config\.sample\.jsonc/u
  );
  // A read error other than absence propagates instead of falling through to config.jsonc.
  assert.throws(
    () =>
      loadConfig("/s", (file) => {
        if (file.endsWith("config.local.jsonc")) {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        }

        return files.get(file) ?? null;
      }),
    /EACCES/u
  );
});

test("JSONC comments and trailing commas strip without touching strings", () => {
  assert.deepEqual(
    parseJsonc('{ // c\n "a": "x // not a comment", /* b */ "b": [1, 2,], }'),
    {
      a: "x // not a comment",
      b: [1, 2],
    }
  );
  assert.equal(stripJsonc('"a,}"'), '"a,}"');
});

test("strict validation rejects unknown keys naming config.sample.jsonc; the shipped sample validates", () => {
  const problems = validateConfig({
    "read-delegates": { claude: [] },
    bogus: 1,
  });

  assert.ok(
    problems.some((problem) =>
      /Unrecognized top-level key "bogus".*config\.sample\.jsonc/u.test(problem)
    )
  );
  assert.ok(
    validateConfig({}).some((problem) =>
      problem.includes('Missing required table "read-delegates"')
    )
  );
  assert.deepEqual(
    validateConfig(
      parseJsonc(
        fs.readFileSync(
          new URL(
            "../../../skills/dispatch/config.sample.jsonc",
            import.meta.url
          ),
          "utf-8"
        )
      )
    ),
    []
  );
});

test("utility-subagents validates entries, requires context-limit, and reports old key", () => {
  const valid = {
    ...minimal,
    "utility-subagents": {
      codex: {
        model: "fast-explorer",
        effort: "low",
        "context-limit": 300_000,
      },
      claude: { model: "fast-explorer", "context-limit": 150_000 },
    },
  };

  assert.deepEqual(validateConfig(valid), []);

  // Shipped sample limit values: 150,000 for claude and 300,000 for every other listed platform
  const sample = parseJsonc(
    fs.readFileSync(
      new URL("../../../skills/dispatch/config.sample.jsonc", import.meta.url),
      "utf-8"
    )
  );

  assert.ok(isObject(sample));
  const utilitySample = sample["utility-subagents"];
  assert.ok(isObject(utilitySample), "sample has utility-subagents");
  assert.equal(contextLimit(utilitySample["claude"]), 150_000);

  for (const [platform, entry] of Object.entries(utilitySample)) {
    if (platform !== "claude") {
      assert.equal(contextLimit(entry), 300_000, platform);
    }
  }

  // Missing, non-positive, or fractional limit, and unknown keys
  const invalidCases: [unknown, RegExp][] = [
    [
      { bogus: { model: "fast-explorer", "context-limit": 300_000 } },
      /utility-subagents: unknown platform "bogus"/u,
    ],
    [
      { codex: { bogus: { model: "fast-explorer" } } },
      /utility-subagents\.codex has unrecognized key "bogus"/u,
    ],
    [
      { codex: { low: { model: "fast-explorer" } } },
      /utility-subagents\.codex has unrecognized key "low"/u,
    ],
    [
      { codex: { model: " " } },
      /utility-subagents\.codex\.model must be a nonblank string/u,
    ],
    [
      {
        codex: { model: "fast-explorer", deep: true, "context-limit": 300_000 },
      },
      /utility-subagents\.codex has unrecognized key "deep"\. Valid keys: model, effort, context-limit/u,
    ],
    [
      { codex: { model: "fast-explorer" } },
      /utility-subagents\.codex\.context-limit/u,
    ],
    [
      { codex: { model: "fast-explorer", "context-limit": 0 } },
      /utility-subagents\.codex\.context-limit/u,
    ],
    [
      { codex: { model: "fast-explorer", "context-limit": -100 } },
      /utility-subagents\.codex\.context-limit/u,
    ],
    [
      { codex: { model: "fast-explorer", "context-limit": 1.5 } },
      /utility-subagents\.codex\.context-limit/u,
    ],
    [
      { codex: { model: "fast-explorer", "context-limit": "300000" } },
      /utility-subagents\.codex\.context-limit/u,
    ],
  ];

  for (const [table, expected] of invalidCases) {
    assert.match(
      validateConfig({ ...minimal, "utility-subagents": table }).join(" "),
      expected
    );
  }

  // context-limit in write-subagents entry is an unrecognized key
  assert.match(
    validateConfig({
      ...minimal,
      "write-subagents": {
        codex: { low: { model: "m", "context-limit": 300_000 } },
      },
    }).join(" "),
    /write-subagents\.codex\.low has unrecognized key "context-limit"/u
  );

  // loadConfig defaults utility-subagents to {}
  const loaded = loadConfig("/s", (file) =>
    file.endsWith("config.jsonc") ? JSON.stringify(minimal) : null
  );

  assert.deepEqual(loaded.config["utility-subagents"], {});

  // old key explore-subagents gets one problem naming utility-subagents
  const oldProblems = validateConfig({
    ...minimal,
    "explore-subagents": { codex: { model: "fast-explorer", effort: "low" } },
  });

  assert.equal(oldProblems.length, 1);
  assert.match(
    defined(oldProblems[0]),
    /explore-subagents.*utility-subagents/u
  );
});

const minimal = {
  "read-delegates": { codex: { targets: [{ low: { model: "m" } }] } },
};

test("write-concurrency validates positive integers and accepts omission", () => {
  assert.deepEqual(validateConfig(minimal), []);
  assert.deepEqual(validateConfig({ ...minimal, "write-concurrency": 3 }), []);

  for (const value of [0, -1, 1.5, "2", true]) {
    assert.match(
      validateConfig({ ...minimal, "write-concurrency": value }).join(" "),
      /write-concurrency must be a positive integer/u
    );
  }
});

test("config rejects removed nativeSubagents with delete instruction", () => {
  const targets = [{ low: { model: "m" } }];

  const problems = validateConfig({
    ...minimal,
    "read-delegates": { codex: { nativeSubagents: false, targets } },
  });

  assert.deepEqual(problems, [
    "read-delegates.codex.nativeSubagents was removed; delete the key (diff against config.sample.jsonc).",
  ]);
});

test("read-commands accepts plain command prefixes and rejects shell syntax", () => {
  assert.deepEqual(
    validateConfig({
      ...minimal,
      "read-commands": ["codegraph explore", "tool-x query"],
    }),
    []
  );

  for (const value of [
    "codegraph",
    [""],
    ["a  b"],
    ["a; rm -rf /"],
    ["a && b"],
    ["a*"],
    ['"a"'],
    ["a $(b)"],
    [1],
  ]) {
    assert.match(
      validateConfig({ ...minimal, "read-commands": value }).join(" "),
      /read-commands must be an array/u
    );
  }
});

const config = (commands: unknown) => (file: string) =>
  file.endsWith("config.jsonc")
    ? JSON.stringify({ ...minimal, "read-commands": commands })
    : null;

test("loadReadCommands returns none without a config and rejects an invalid list", () => {
  assert.deepEqual(
    loadReadCommands("/skill", () => null),
    []
  );
  assert.deepEqual(loadReadCommands("/skill", config(["codegraph explore"])), [
    "codegraph explore",
  ]);
  assert.deepEqual(
    loadReadCommands("/skill", (file) =>
      file.endsWith("config.jsonc") ? JSON.stringify(minimal) : null
    ),
    []
  );
  assert.throws(
    () => loadReadCommands("/skill", config(["a | b"])),
    /read-commands must be an array/u
  );
});

test("pricing override is a known table that validation never inspects", () => {
  for (const pricing of [
    { "lmstudio/*": { rates: { input: 0, output: 0 } } },
    { bad: 5 },
    "x",
    7,
  ]) {
    assert.deepEqual(validateConfig({ ...minimal, pricing }), []);
  }

  const files = new Map([
    [
      path.join("/s", "config.jsonc"),
      JSON.stringify({ ...minimal, pricing: { a: 1 } }),
    ],
  ]);

  assert.deepEqual(
    loadConfig("/s", (file) => files.get(file) ?? null).config["pricing"],
    { a: 1 }
  );

  const unset = new Map([
    [path.join("/s", "config.jsonc"), JSON.stringify(minimal)],
  ]);

  assert.equal(
    "pricing" in loadConfig("/s", (file) => unset.get(file) ?? null).config,
    false
  );
});
