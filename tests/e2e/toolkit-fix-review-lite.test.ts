import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { nodeErrorCode } from "../../skills/dispatch/scripts/lib/fs-ext.ts";
import { parseJson } from "../../skills/dispatch/scripts/lib/integrity.ts";
import { main } from "../../skills/dispatch/scripts/toolkit/cli.ts";
import { consumerSearchArgs } from "../../skills/dispatch/scripts/toolkit/domain/fix-review-lite.ts";
import {
  appendRecord,
  currentHashes,
  foldLedger,
  latest,
} from "../../skills/dispatch/scripts/toolkit/ledger.ts";
import {
  defined,
  isBoolean,
  isNumber,
  isString,
  maybe,
  narrow,
  nullable,
  objectWith,
} from "./helpers/json.ts";
import { setupTestSkill, toolkitRepo } from "./helpers/toolkit-repo.ts";

type Repo = Awaited<ReturnType<typeof toolkitRepo>>;

type Second = Awaited<ReturnType<Repo["second"]>>;

const REPORT = JSON.stringify({
  status: "FINDINGS",
  findings: [
    {
      impact: "degrades",
      trigger: "realistic",
      tag: "reliability",
      locus: "§ Work",
      defect: "Writes overlap",
      requiredChange: "Serialize writes",
    },
  ],
});

// Names a naive pathspec or grep would mishandle: a leading dash, a glob class, and a bare paren.
const LISTED = ["-x", "foo(", "a.b[1].txt"];

// The hit file names from `git grep -n` output, one per matching line.
const hitFiles = (stdout: string) =>
  new Set(
    stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(0, line.indexOf(":")))
  );

// A repository whose second session briefs the plan; the test writes its files before reviewAndAccept.
const startRepo = async () => {
  const f = await toolkitRepo();

  f.deps.skillRoot = setupTestSkill(f.deps, f.session, "skill", {
    "read-delegates": {
      claude: { targets: [{ low: { model: "fake" } }] },
      agy: { targets: [{ low: { model: "fake" } }] },
    },
    "utility-subagents": {
      opencode: {
        model: "fake-utility",
        effort: "medium",
        "context-limit": 150_000,
      },
    },
    phases: {
      "plan-review": {
        targets: { low: 0, medium: 2 },
        rounds: { low: 0, medium: 2 },
      },
    },
  });
  f.deps.liveness = {
    claude: true,
    agy: true,
    codex: true,
    copilot: true,
    opencode: true,
  };
  f.deps.orchestrator = null;
  f.deps.modes = () => ["cli"];
  f.deps.delegate = async () =>
    await Promise.resolve({
      outcome: { status: "ok", text: REPORT, resume: null, sessionId: null },
      invocations: [],
    });
  // The second session lives under the sessions root, which the brief excludes from search.
  const g: Second = await f.second("20261023T0001Z-brief");

  return { f, g };
};

// Reviews the plan from the second session and accepts its only finding; the caller then appends the fix.
const reviewAndAccept = async (f: Repo, g: Second) => {
  const reviewed = await g.run([
    "review",
    "run",
    "work.plan.md",
    "--kind",
    "plan",
    "--level",
    "medium",
  ]);

  assert.equal(reviewed.exit, 0, JSON.stringify(reviewed.output));

  await appendRecord(
    g.session,
    {
      kind: "ruling",
      by: "orchestrator",
      key: "accept-R1-F001",
      data: {
        subject: "review:plan-work.plan:R1-F001",
        ruling: "accepted",
        rationale: "Serialize writes",
      },
    },
    f.deps
  );
};

test("brief fix-review-lite on a real repository lists, diffs and searches literal names", async () => {
  const { f, g } = await startRepo();

  try {
    fs.writeFileSync(path.join(f.root, "-x"), "untracked\n");
    fs.writeFileSync(path.join(f.root, "foo("), "untracked\n");
    fs.writeFileSync(path.join(f.root, "a.b[1].txt"), "tracked\n");
    f.git(["add", "--", ":(literal)a.b[1].txt"]);
    f.git(["commit", "-m", "tracked names"]);
    fs.writeFileSync(
      path.join(f.root, "src/consumer.ts"),
      "export const names = ['-x', 'a.b[1].txt', 'foo('];\n"
    );
    fs.writeFileSync(
      path.join(f.root, "src/secrets.ts"),
      "export const secret = '-x';\n"
    );
    fs.writeFileSync(path.join(f.root, ".env"), "TOKEN=-x\n");
    // A sensitive listed path with a space: excluded from search as a glob, and withheld as unsafe.
    fs.mkdirSync(path.join(f.root, "ops"), { recursive: true });
    fs.writeFileSync(path.join(f.root, "ops/my secrets.env"), "TOKEN=-x\n");
    fs.appendFileSync(path.join(f.root, ".gitignore"), "skipped.txt\n");
    fs.writeFileSync(path.join(f.root, "skipped.txt"), "-x\n");
    fs.writeFileSync(path.join(g.session, "notes.md"), "-x\n");

    await reviewAndAccept(f, g);
    // Citations cover a listed untracked name, a listed tracked name with a glob class, and an ignored file.
    fs.appendFileSync(
      path.join(f.root, "work.plan.md"),
      "\n## Fix\nSee `-x:1`, `foo(:1`, `a.b[1].txt:1`, `skipped.txt:1` and `missing.ts:1`.\n"
    );

    const brief = await g.run(["brief", "fix-review-lite", "work.plan.md"]);

    assert.equal(brief.exit, 0, JSON.stringify(brief.output));

    const briefVal = narrow(
      brief.value,
      objectWith({
        briefPath: isString,
        diffPath: isString,
        citations: isNumber,
        unresolved: isNumber,
        withheld: isNumber,
      })
    );

    const briefText = fs.readFileSync(briefVal.briefPath, "utf-8");

    // The brief's own listing keeps every listed name and withholds the ignored file.
    assert.equal(briefVal.citations, LISTED.length);

    for (const name of LISTED) {
      assert.ok(briefText.includes(`\`${name}:1\``), name);
    }

    assert.ok(briefText.includes("`skipped.txt`: not listed"));
    assert.ok(briefText.includes("`missing.ts`: no match"));
    assert.equal(briefVal.unresolved, 1);
    // Sensitive paths are search excludes; only the ignored file and the unsafe sensitive path are withheld.
    assert.equal(briefVal.withheld, 2);
    assert.match(
      brief.output.summary,
      /3 citations, 1 unresolved, 2 withheld/u
    );

    // The diff is the real git diff of the round input against the governed plan.
    const diff = fs.readFileSync(briefVal.diffPath, "utf-8");

    assert.match(diff, /^\+See `-x:1`, `foo\(:1`, `a\.b\[1\]\.txt:1`/mu);

    // Excludes come from the rendered command, so the check covers what the explorer runs.
    const excludes = [
      ...briefText.matchAll(
        /":\(exclude,(?:literal|glob)\)(?<excluded>[^"]+)"/gu
      ),
    ]
      .map((match) => defined(match.groups?.["excluded"]))
      .toSorted();

    assert.deepEqual(excludes, [
      ".env",
      ".scratch/dispatch-skills",
      "ops/my?secrets.env",
      "src/secrets.ts",
    ]);

    const search = (name: string) =>
      spawnSync("git", consumerSearchArgs(excludes, name), {
        cwd: f.root,
        encoding: "utf-8",
        windowsHide: true,
      });

    const dash = search("-x");

    assert.equal(dash.status, 0, dash.stderr);

    const dashHits = hitFiles(dash.stdout);

    assert.ok(dashHits.has("src/consumer.ts"));

    for (const hit of [
      ".env",
      "ops/my secrets.env",
      "src/secrets.ts",
      "skipped.txt",
    ]) {
      assert.ok(!dashHits.has(hit), hit);
    }

    assert.ok(
      ![...dashHits].some((hit) => hit.startsWith(".scratch/")),
      "sessions root excluded"
    );

    const bracket = search("a.b[1].txt");

    assert.equal(bracket.status, 0, bracket.stderr);
    assert.ok(hitFiles(bracket.stdout).has("src/consumer.ts"));

    const paren = search("foo(");

    assert.equal(paren.status, 0, paren.stderr);
    assert.ok(hitFiles(paren.stdout).has("src/consumer.ts"));
  } finally {
    f.cleanup();
  }
});

test("brief fix-review-lite keeps a listed unrenderable citation out of the consumer search hits", async () => {
  const { f, g } = await startRepo();

  try {
    fs.mkdirSync(path.join(f.root, "{{x}}"), { recursive: true });
    fs.writeFileSync(path.join(f.root, "{{x}}/a.md"), "marker -x\n");
    fs.writeFileSync(
      path.join(f.root, "src/consumer.ts"),
      "export const names = ['-x'];\n"
    );

    await reviewAndAccept(f, g);
    fs.appendFileSync(
      path.join(f.root, "work.plan.md"),
      "\n## Fix\nSee `{{x}}/a.md:1`.\n"
    );

    const brief = await g.run(["brief", "fix-review-lite", "work.plan.md"]);

    assert.equal(brief.exit, 0, JSON.stringify(brief.output));

    const briefText = fs.readFileSync(
      narrow(brief.value, objectWith({ briefPath: isString })).briefPath,
      "utf-8"
    );

    const excludes = [
      ...briefText.matchAll(
        /":\(exclude,(?:literal|glob)\)(?<excluded>[^"]+)"/gu
      ),
    ]
      .map((match) => defined(match.groups?.["excluded"]))
      .toSorted();

    assert.deepEqual(excludes, [".scratch/dispatch-skills", "??x??/a.md"]);

    const search = spawnSync("git", consumerSearchArgs(excludes, "-x"), {
      cwd: f.root,
      encoding: "utf-8",
      windowsHide: true,
    });

    assert.equal(search.status, 0, search.stderr);

    const hits = hitFiles(search.stdout);

    assert.ok(hits.has("src/consumer.ts"));
    assert.ok(
      !hits.has("{{x}}/a.md"),
      "listed unrenderable citation is not a search hit"
    );
  } finally {
    f.cleanup();
  }
});

test("brief fix-review-lite withholds a symlink that resolves outside the repository", async (t) => {
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), "fix-review-lite-outside-")
  );

  const { f, g } = await startRepo();

  try {
    const target = path.join(outside, "secret.ts");

    fs.writeFileSync(target, "export const x = 1;\n");

    try {
      fs.symlinkSync(target, path.join(f.root, "linked.ts"), "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(nodeErrorCode(error) ?? "")) {
        t.skip("symlink creation needs a privilege this host lacks");

        return;
      }

      throw error;
    }

    await reviewAndAccept(f, g);
    fs.appendFileSync(
      path.join(f.root, "work.plan.md"),
      "\n## Fix\nSee `linked.ts:1`.\n"
    );

    const brief = await g.run(["brief", "fix-review-lite", "work.plan.md"]);

    assert.equal(brief.exit, 0, JSON.stringify(brief.output));

    const briefText = fs.readFileSync(
      narrow(brief.value, objectWith({ briefPath: isString })).briefPath,
      "utf-8"
    );

    assert.ok(briefText.includes("`linked.ts`: outside repository"));
    assert.ok(!briefText.includes("`linked.ts:1`"));
  } finally {
    f.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// SECTION: bookkeeping flags
const envelopeShape = objectWith({
  ok: isBoolean,
  summary: isString,
  path: maybe(nullable(isString)),
  reason: maybe(isString),
  step: maybe(isString),
  help: maybe(isString),
});

// The shared test helper drops `step` and `help`, so this call reads the raw envelope.
const call = async (f: Repo, g: Second, args: string[]) => {
  const lines: string[] = [];

  const exit = await main([...args, "--session", g.session], {
    ...f.deps,
    stdout: (line) => {
      lines.push(line);
    },
  });

  assert.equal(lines.length, 1);

  const envelope = narrow(parseJson(defined(lines[0])), envelopeShape);

  assert.ok(Buffer.byteLength(envelope.summary) <= 1024);

  const value =
    envelope.path === undefined ||
    envelope.path === null ||
    envelope.path === ""
      ? null
      : parseJson(fs.readFileSync(envelope.path, "utf-8"));

  return { exit, envelope, value };
};

const briefValue = objectWith({
  briefPath: isString,
  noteKey: isString,
  launchAs: isString,
});

// Everything the ledger holds except write times, so two sessions that ran different call forms compare equal.
const stored = (session: string) =>
  foldLedger(session).records.map(({ kind, by, key, data }) => ({
    kind,
    by,
    key,
    data,
  }));

const rowsOf = (session: string, kind: string) =>
  foldLedger(session).records.filter((record) => record.kind === kind);

const planFile = (f: Repo) => path.join(f.root, "work.plan.md");

// Edits the plan once for every session that shares the repository and writes the edit fields from the bound hash.
const fixPlan = (f: Repo, g: Second) => {
  const before = currentHashes(
    f.root,
    latest(foldLedger(g.session), "bind")
  ).plan;

  fs.writeFileSync(
    planFile(f),
    fs
      .readFileSync(planFile(f), "utf-8")
      .replace("implements behavior.", "implements behavior 1.")
  );

  const fields = path.join(f.root, "edit-fields.json");

  fs.writeFileSync(
    fields,
    JSON.stringify({
      class: "non-intent",
      affects: ["T1"],
      rationale: "Serialize writes",
      diffRef: "d1",
      before,
    })
  );

  return fields;
};

const briefFiles = (g: Second) => {
  const directory = path.join(g.session, ".state", "briefs");

  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
};

const combined = (f: Repo, fields: string) => [
  "lint",
  "run",
  planFile(f),
  "--edit",
  fields,
  "--fix-review-lite",
];

const separate = async (f: Repo, g: Second, fields: string) => {
  const edited = await call(f, g, [
    "lint",
    "run",
    planFile(f),
    "--edit",
    fields,
  ]);

  const brief = await call(f, g, [
    "brief",
    "fix-review-lite",
    "work.plan.md",
    "--host",
    "opencode",
  ]);

  return { edited, brief };
};

const KEY = "fix-review-lite:plan-work.plan:1:1";

const noteFile = (f: Repo, key: string) => {
  const file = path.join(f.root, "note.json");

  fs.writeFileSync(
    file,
    JSON.stringify({
      kind: "note",
      by: "orchestrator",
      key,
      data: { text: "kind plan; raised 1; confirmed 1; mode inline" },
    })
  );

  return file;
};

test("lint run --fix-review-lite appends the edit and renders the brief in one call", async () => {
  const { f, g } = await startRepo();

  try {
    await reviewAndAccept(f, g);

    const twin = await f.second("20261023T0002Z-twin");

    await reviewAndAccept(f, twin);

    const fields = fixPlan(f, g);
    const one = await call(f, g, combined(f, fields));

    assert.equal(one.exit, 0, JSON.stringify(one.envelope));
    assert.equal(one.envelope.ok, true);
    assert.equal(one.envelope.step, undefined);
    assert.equal(one.envelope.help, undefined);

    const [edit] = rowsOf(g.session, "edit");
    const value = narrow(defined(one.value), objectWith({ brief: briefValue }));

    assert.match(
      one.envelope.summary,
      new RegExp(
        `0 errors, \\d+ warnings; .*edit seq ${defined(edit).seq} appended`,
        "u"
      )
    );
    assert.ok(one.envelope.summary.includes(value.brief.launchAs));
    assert.ok(one.envelope.summary.includes(`"key":"${KEY}"`));
    assert.equal(value.brief.noteKey, KEY);
    assert.ok(fs.existsSync(value.brief.briefPath));

    // The retry dedupes the edit and renders a fresh brief.
    const retry = await call(f, g, combined(f, fields));

    assert.equal(retry.exit, 0);
    assert.match(retry.envelope.summary, /edit seq \d+ deduped/u);
    assert.equal(rowsOf(g.session, "edit").length, 1);

    // The twin session ran the separate calls in the new order and holds the same records.
    const two = await separate(f, twin, fields);

    assert.equal(two.edited.exit, 0);
    assert.equal(two.brief.exit, 0);
    assert.deepEqual(stored(twin.session), stored(g.session));
  } finally {
    f.cleanup();
  }
});

test("lint run --fix-review-lite from a repository subdirectory renders the canonical artifact brief", async () => {
  const { f, g } = await startRepo();

  try {
    await reviewAndAccept(f, g);

    const fields = fixPlan(f, g);
    const subdirectory = path.join(f.root, "src");

    // A relative target resolves against the process directory, so the real CLI runs from a subdirectory.
    const run = spawnSync(
      process.execPath,
      [
        path.resolve("skills/dispatch/scripts/dispatch.ts"),
        "lint",
        "run",
        path.relative(subdirectory, planFile(f)),
        "--edit",
        fields,
        "--fix-review-lite",
        "--session",
        g.session,
      ],
      { cwd: subdirectory, encoding: "utf-8", windowsHide: true }
    );

    const envelope = narrow(
      parseJson(defined(run.stdout, "stdout")),
      objectWith({ ok: isBoolean, summary: isString })
    );

    assert.equal(run.status, 0, run.stdout);
    assert.equal(envelope.ok, true);
    assert.doesNotMatch(envelope.summary, /nothing-to-review/u);
    assert.ok(briefFiles(g).some((name) => name.startsWith("fix-review-lite")));
  } finally {
    f.cleanup();
  }
});

test("lint run --fix-review-lite stops at lint errors with step edit and renders no brief", async () => {
  const { f, g } = await startRepo();

  try {
    await reviewAndAccept(f, g);

    const twin = await f.second("20261023T0002Z-twin");

    await reviewAndAccept(f, twin);

    const fields = fixPlan(f, g);

    fs.writeFileSync(
      planFile(f),
      fs.readFileSync(planFile(f), "utf-8").replace("  - Evidence: check\n", "")
    );

    const before = stored(g.session);
    const briefsBefore = briefFiles(g);
    const one = await call(f, g, combined(f, fields));

    assert.equal(one.exit, 4, JSON.stringify(one.envelope));
    assert.equal(one.envelope.ok, false);
    assert.equal(one.envelope.reason, "lint-errors");
    assert.equal(one.envelope.step, "edit");
    assert.equal(one.envelope.help, "lint run");
    assert.ok(one.envelope.summary.startsWith("edit: lint-errors; "));
    assert.deepEqual(stored(g.session), before);
    assert.deepEqual(briefFiles(g), briefsBefore);

    const plain = await call(f, twin, [
      "lint",
      "run",
      planFile(f),
      "--edit",
      fields,
    ]);

    assert.equal(plain.exit, 4);
    assert.equal(plain.envelope.step, undefined);
    assert.deepEqual(stored(twin.session), stored(g.session));
  } finally {
    f.cleanup();
  }
});

test("a brief refusal after the edit keeps the edit durable and a retry dedupes it", async () => {
  const { f } = await startRepo();

  try {
    const first = await f.second("20261023T0003Z-first");
    const twin = await f.second("20261023T0004Z-twin");
    const fields = fixPlan(f, first);
    const one = await call(f, first, combined(f, fields));

    assert.equal(one.exit, 4, JSON.stringify(one.envelope));
    assert.equal(one.envelope.reason, "nothing-to-review");
    assert.equal(one.envelope.step, "fix-review-lite");
    assert.equal(one.envelope.help, "brief fix-review-lite");
    assert.ok(
      one.envelope.summary.startsWith("fix-review-lite: nothing-to-review: ")
    );

    const [edit] = rowsOf(first.session, "edit");

    assert.ok(
      one.envelope.summary.includes(`edit seq ${defined(edit).seq} appended`)
    );

    const retry = await call(f, first, combined(f, fields));

    assert.equal(retry.exit, 4);
    assert.equal(retry.envelope.step, "fix-review-lite");
    assert.ok(retry.envelope.summary.includes("deduped"));
    assert.equal(rowsOf(first.session, "edit").length, 1);

    const two = await separate(f, twin, fields);

    assert.equal(two.edited.exit, 0);
    assert.equal(two.brief.exit, 4);
    assert.equal(two.brief.envelope.step, undefined);
    assert.deepEqual(stored(twin.session), stored(first.session));
  } finally {
    f.cleanup();
  }
});

test("review run --note appends the note before the next round and a final batch uses ledger append", async () => {
  const { f, g } = await startRepo();

  try {
    await reviewAndAccept(f, g);

    const twin = await f.second("20261023T0002Z-twin");

    await reviewAndAccept(f, twin);

    const fields = fixPlan(f, g);

    await call(f, g, combined(f, fields));
    await separate(f, twin, fields);

    const file = noteFile(f, KEY);
    const target = ["review", "run", "work.plan.md", "--kind", "plan"];
    const next = [...target, "--level", "medium", "--host", "opencode"];
    const one = await call(f, g, [...next, "--note", file]);

    assert.equal(one.exit, 0, JSON.stringify(one.envelope));
    assert.equal(one.envelope.step, undefined);
    assert.equal(
      rowsOf(g.session, "note").filter((row) => row.key === KEY).length,
      1
    );
    assert.ok(
      fs.existsSync(
        path.join(g.session, ".state/reviews/plan-work.plan/round-2")
      )
    );

    const appended = await call(f, twin, ["ledger", "append", file]);
    const plain = await call(f, twin, next);

    assert.equal(appended.exit, 0);
    assert.equal(plain.exit, 0);
    assert.deepEqual(stored(twin.session), stored(g.session));

    // A final batch has no further round, so its note stays a plain append.
    const final = await call(f, g, [
      "ledger",
      "append",
      noteFile(f, "fix-review-lite:plan-work.plan:2:1"),
    ]);

    assert.equal(final.exit, 0);
    assert.equal(final.envelope.step, undefined);
  } finally {
    f.cleanup();
  }
});

test("review run --note refuses a foreign review, stale round, bad ordinal or same-basename artifact with step note", async () => {
  const { f, g } = await startRepo();

  try {
    await reviewAndAccept(f, g);
    fs.mkdirSync(path.join(f.root, "sub"));
    fs.copyFileSync(planFile(f), path.join(f.root, "sub/work.plan.md"));

    const before = stored(g.session);

    const cases: [string, string, string][] = [
      ["foreign review", "work.plan.md", "fix-review-lite:plan-other.plan:1:1"],
      ["stale round", "work.plan.md", "fix-review-lite:plan-work.plan:2:1"],
      ["zero ordinal", "work.plan.md", "fix-review-lite:plan-work.plan:1:0"],
      ["same basename at another path", "sub/work.plan.md", KEY],
    ];

    for (const [label, target, key] of cases) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits keep one envelope per call
      const refused = await call(f, g, [
        "review",
        "run",
        target,
        "--kind",
        "plan",
        "--host",
        "opencode",
        "--note",
        noteFile(f, key),
      ]);

      assert.equal(refused.exit, 1, label);
      assert.equal(refused.envelope.reason, "invalid-input", label);
      assert.equal(refused.envelope.step, "note", label);
      assert.equal(refused.envelope.help, "ledger append", label);
      assert.deepEqual(stored(g.session), before, label);
    }
  } finally {
    f.cleanup();
  }
});

test("a gate refusal after the note append carries step review and the note seq, and a retry dedupes", async () => {
  const { f, g } = await startRepo();

  try {
    await reviewAndAccept(f, g);

    const twin = await f.second("20261023T0002Z-twin");

    await reviewAndAccept(f, twin);

    const file = noteFile(f, KEY);

    const gated = [
      "review",
      "run",
      "work.plan.md",
      "--kind",
      "plan",
      "--level",
      "xhigh",
      "--host",
      "opencode",
    ];

    const one = await call(f, g, [...gated, "--note", file]);

    assert.equal(one.exit, 4, JSON.stringify(one.envelope));
    assert.equal(one.envelope.reason, "level-unapproved");
    assert.equal(one.envelope.step, "review");
    assert.equal(one.envelope.help, "review run");

    const row = rowsOf(g.session, "note").find((item) => item.key === KEY);

    assert.ok(
      one.envelope.summary.startsWith(
        `review: level-unapproved: note seq ${defined(row).seq} appended`
      )
    );

    const retry = await call(f, g, [...gated, "--note", file]);

    assert.equal(retry.envelope.step, "review");
    assert.ok(retry.envelope.summary.includes("deduped"));
    assert.equal(
      rowsOf(g.session, "note").filter((item) => item.key === KEY).length,
      1
    );

    await call(f, twin, ["ledger", "append", file]);

    const plain = await call(f, twin, gated);

    assert.equal(plain.exit, 4);
    assert.equal(plain.envelope.step, undefined);
    assert.deepEqual(stored(twin.session), stored(g.session));
  } finally {
    f.cleanup();
  }
});

test("review run --note retried after its round completed dedupes the note instead of refusing it as stale", async () => {
  const { f, g } = await startRepo();

  try {
    await reviewAndAccept(f, g);

    const file = noteFile(f, KEY);

    const next = [
      "review",
      "run",
      "work.plan.md",
      "--kind",
      "plan",
      "--level",
      "medium",
      "--host",
      "opencode",
      "--note",
    ];

    const one = await call(f, g, [...next, file]);

    assert.equal(one.exit, 0, JSON.stringify(one.envelope));
    assert.ok(
      fs.existsSync(
        path.join(g.session, ".state/reviews/plan-work.plan/round-2")
      )
    );

    // Round 2 is now the latest, so the recorded round-1 note would be stale if it were new.
    const retry = await call(f, g, [...next, file]);

    assert.notEqual(
      retry.envelope.step,
      "note",
      JSON.stringify(retry.envelope)
    );
    assert.equal(
      rowsOf(g.session, "note").filter((row) => row.key === KEY).length,
      1
    );

    const other = path.join(f.root, "other-note.json");

    fs.writeFileSync(
      other,
      JSON.stringify({
        kind: "note",
        by: "orchestrator",
        key: KEY,
        data: { text: "different content" },
      })
    );

    const conflict = await call(f, g, [...next, other]);

    assert.equal(conflict.envelope.reason, "key-conflict");
    assert.equal(conflict.envelope.step, "note");
  } finally {
    f.cleanup();
  }
});

// SECTION: step naming for faults and payload failures
const realWriteSync = fs.writeSync;
const realWriteFileSync = fs.writeFileSync;
const realMkdirSync = fs.mkdirSync;

const passWrite = (
  fd: number,
  data: string | Buffer,
  offset?: number,
  length?: number
) =>
  typeof data === "string"
    ? realWriteSync(fd, data)
    : realWriteSync(fd, data, offset, length);

const ledgerLine = (kind: string) => `"kind":"${kind}"`;

// The ledger writes a record as a string (edit transaction) or a buffer (batch append).
const writesRecord = (data: unknown, kind: string) =>
  (typeof data === "string" || Buffer.isBuffer(data)) &&
  data.toString().includes(ledgerLine(kind));

test("lint run --fix-review-lite names step edit when the edit append faults", async (t) => {
  const { f, g } = await startRepo();

  try {
    await reviewAndAccept(f, g);

    const fields = fixPlan(f, g);
    const before = stored(g.session);

    t.mock.method(
      fs,
      "writeSync",
      (fd: number, data: string | Buffer, offset?: number, length?: number) => {
        if (writesRecord(data, "edit")) {
          throw new Error("simulated edit write failure");
        }

        return passWrite(fd, data, offset, length);
      }
    );

    const one = await call(f, g, combined(f, fields));

    assert.equal(one.exit, 2, JSON.stringify(one.envelope));
    assert.equal(one.envelope.reason, "fault");
    assert.equal(one.envelope.step, "edit");
    assert.ok(one.envelope.summary.includes("simulated edit write failure"));
    assert.deepEqual(stored(g.session), before);
  } finally {
    f.cleanup();
  }
});

test("lint run --fix-review-lite names step fix-review-lite and keeps the edit seq when the brief faults", async (t) => {
  const { f, g } = await startRepo();

  try {
    await reviewAndAccept(f, g);

    const fields = fixPlan(f, g);

    t.mock.method(
      fs,
      "writeFileSync",
      (
        file: fs.PathOrFileDescriptor,
        data: string | NodeJS.ArrayBufferView,
        options?: fs.WriteFileOptions
      ) => {
        if (typeof file === "string" && file.endsWith(".governed.md")) {
          throw new Error("simulated brief write failure");
        }

        realWriteFileSync(file, data, options);
      }
    );

    const one = await call(f, g, combined(f, fields));
    const [edit] = rowsOf(g.session, "edit");

    assert.equal(one.exit, 2, JSON.stringify(one.envelope));
    assert.equal(one.envelope.reason, "fault");
    assert.equal(one.envelope.step, "fix-review-lite");
    assert.ok(one.envelope.summary.includes("simulated brief write failure"));
    assert.ok(
      one.envelope.summary.includes(`edit seq ${defined(edit).seq} appended`)
    );
    assert.equal(rowsOf(g.session, "edit").length, 1);
  } finally {
    f.cleanup();
  }
});

test("review run --note names step note when the note append faults", async (t) => {
  const { f, g } = await startRepo();

  try {
    await reviewAndAccept(f, g);

    const file = noteFile(f, KEY);
    const before = stored(g.session);

    t.mock.method(
      fs,
      "writeSync",
      (fd: number, data: string | Buffer, offset?: number, length?: number) => {
        if (writesRecord(data, "note")) {
          throw new Error("simulated note write failure");
        }

        return passWrite(fd, data, offset, length);
      }
    );

    const one = await call(f, g, [
      "review",
      "run",
      "work.plan.md",
      "--kind",
      "plan",
      "--host",
      "opencode",
      "--note",
      file,
    ]);

    assert.equal(one.exit, 2, JSON.stringify(one.envelope));
    assert.equal(one.envelope.reason, "fault");
    assert.equal(one.envelope.step, "note");
    assert.ok(one.envelope.summary.includes("simulated note write failure"));
    assert.deepEqual(stored(g.session), before);
  } finally {
    f.cleanup();
  }
});

test("review run --note names step review and keeps the note seq when the review faults", async (t) => {
  const { f, g } = await startRepo();

  try {
    await reviewAndAccept(f, g);

    const file = noteFile(f, KEY);

    const reviewDirectory = path.join(
      g.session,
      ".state/reviews/plan-work.plan"
    );

    t.mock.method(
      fs,
      "mkdirSync",
      (
        target: fs.PathLike,
        options?: fs.MakeDirectoryOptions & { recursive: true }
      ) => {
        if (target === reviewDirectory) {
          throw new Error("simulated review directory failure");
        }

        return realMkdirSync(target, options);
      }
    );

    const one = await call(f, g, [
      "review",
      "run",
      "work.plan.md",
      "--kind",
      "plan",
      "--host",
      "opencode",
      "--note",
      file,
    ]);

    const row = rowsOf(g.session, "note").find((item) => item.key === KEY);

    assert.equal(one.exit, 2, JSON.stringify(one.envelope));
    assert.equal(one.envelope.reason, "fault");
    assert.equal(one.envelope.step, "review");
    assert.ok(
      one.envelope.summary.includes(`note seq ${defined(row).seq} appended`)
    );
    assert.ok(
      one.envelope.summary.includes("simulated review directory failure")
    );
  } finally {
    f.cleanup();
  }
});

test("lint run --fix-review-lite names step edit for a malformed, unreadable or schema-invalid payload", async () => {
  const { f, g } = await startRepo();

  try {
    await reviewAndAccept(f, g);

    const before = stored(g.session);
    const malformed = path.join(f.root, "malformed.json");
    const invalid = path.join(f.root, "invalid.json");

    fs.writeFileSync(malformed, "{not json");
    fs.writeFileSync(invalid, JSON.stringify({ class: "non-intent" }));

    const cases: [string, string][] = [
      ["malformed", malformed],
      ["unreadable", path.join(f.root, "missing.json")],
      ["schema-invalid", invalid],
    ];

    for (const [label, payload] of cases) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits keep one envelope per call
      const refused = await call(f, g, combined(f, payload));

      assert.equal(refused.exit, 1, label);
      assert.equal(refused.envelope.reason, "invalid-input", label);
      assert.equal(refused.envelope.step, "edit", label);
      assert.equal(refused.envelope.help, "lint run", label);
      assert.deepEqual(stored(g.session), before, label);

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits keep one envelope per call
      const plain = await call(f, g, [
        "lint",
        "run",
        planFile(f),
        "--edit",
        payload,
      ]);

      assert.equal(plain.exit, 1, label);
      assert.equal(plain.envelope.step, undefined, label);
    }
  } finally {
    f.cleanup();
  }
});

// SECTION: note binding, argument order and receipt budget
test("review run --note dedupes an existing key only for the artifact its round recorded", async () => {
  const { f, g } = await startRepo();

  try {
    await reviewAndAccept(f, g);
    fs.mkdirSync(path.join(f.root, "sub"));
    fs.copyFileSync(planFile(f), path.join(f.root, "sub/work.plan.md"));

    const file = noteFile(f, KEY);
    const recorded = await call(f, g, ["ledger", "append", file]);

    assert.equal(recorded.exit, 0, JSON.stringify(recorded.envelope));

    const before = stored(g.session);

    const refused = await call(f, g, [
      "review",
      "run",
      "sub/work.plan.md",
      "--kind",
      "plan",
      "--host",
      "opencode",
      "--note",
      file,
    ]);

    assert.equal(refused.exit, 1, JSON.stringify(refused.envelope));
    assert.equal(refused.envelope.reason, "invalid-input");
    assert.equal(refused.envelope.step, "note");
    assert.deepEqual(stored(g.session), before);
  } finally {
    f.cleanup();
  }
});

test("review run --note with malformed --pins refuses before any append", async () => {
  const { f, g } = await startRepo();

  try {
    await reviewAndAccept(f, g);

    const before = stored(g.session);

    const refused = await call(f, g, [
      "review",
      "run",
      "work.plan.md",
      "--kind",
      "plan",
      "--host",
      "opencode",
      "--pins",
      "not-pins",
      "--note",
      noteFile(f, KEY),
    ]);

    assert.equal(refused.exit, 1, JSON.stringify(refused.envelope));
    assert.equal(refused.envelope.reason, "invalid-input");
    assert.equal(refused.envelope.step, undefined);
    assert.deepEqual(stored(g.session), before);
  } finally {
    f.cleanup();
  }
});

test("review run without --note keeps the level gate ahead of malformed --pins", async () => {
  const { f, g } = await startRepo();

  try {
    await reviewAndAccept(f, g);

    const before = stored(g.session);

    const refused = await call(f, g, [
      "review",
      "run",
      "work.plan.md",
      "--kind",
      "plan",
      "--level",
      "xhigh",
      "--host",
      "opencode",
      "--pins",
      "not-pins",
    ]);

    assert.equal(refused.exit, 4, JSON.stringify(refused.envelope));
    assert.equal(refused.envelope.reason, "level-unapproved");
    assert.equal(refused.envelope.step, undefined);
    assert.deepEqual(stored(g.session), before);
  } finally {
    f.cleanup();
  }
});

test("a combined-form failure with an oversized message keeps the step, reason and receipt in the summary", async (t) => {
  const { f, g } = await startRepo();

  try {
    await reviewAndAccept(f, g);

    const huge = `simulated ${"x".repeat(4000)}`;
    const file = noteFile(f, KEY);

    const reviewDirectory = path.join(
      g.session,
      ".state/reviews/plan-work.plan"
    );

    const mkdirMock = t.mock.method(
      fs,
      "mkdirSync",
      (
        target: fs.PathLike,
        options?: fs.MakeDirectoryOptions & { recursive: true }
      ) => {
        if (target === reviewDirectory) {
          throw new Error(huge);
        }

        return realMkdirSync(target, options);
      }
    );

    const noted = await call(f, g, [
      "review",
      "run",
      "work.plan.md",
      "--kind",
      "plan",
      "--host",
      "opencode",
      "--note",
      file,
    ]);

    const [row] = rowsOf(g.session, "note");

    assert.equal(noted.envelope.step, "review");
    assert.ok(
      noted.envelope.summary.startsWith(
        `review: fault: note seq ${defined(row).seq} appended; simulated`
      ),
      noted.envelope.summary
    );

    mkdirMock.mock.restore();

    const fields = fixPlan(f, g);

    t.mock.method(
      fs,
      "writeFileSync",
      (
        target: fs.PathOrFileDescriptor,
        data: string | NodeJS.ArrayBufferView,
        options?: fs.WriteFileOptions
      ) => {
        if (typeof target === "string" && target.endsWith(".governed.md")) {
          throw new Error(huge);
        }

        realWriteFileSync(target, data, options);
      }
    );

    const edited = await call(f, g, combined(f, fields));
    const [edit] = rowsOf(g.session, "edit");

    assert.equal(edited.envelope.step, "fix-review-lite");
    assert.ok(
      edited.envelope.summary.startsWith(
        `fix-review-lite: fault: edit seq ${defined(edit).seq} appended; simulated`
      ),
      edited.envelope.summary
    );
  } finally {
    f.cleanup();
  }
});
