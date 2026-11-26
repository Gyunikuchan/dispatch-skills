import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  measureRuns,
  parsePairs,
  renderComparison,
  runMeasureRuns,
} from "../../scripts/measure-runs.ts";
import type { Comparison } from "../../scripts/measure-runs.ts";
import { orchestratorFor } from "../../skills/dispatch/scripts/lib/platform.ts";
import { resolvePricing } from "../../skills/dispatch/scripts/lib/pricing.ts";
import { readManifest } from "../../skills/dispatch/scripts/lib/session.ts";
import { readDelegateSession } from "../../skills/dispatch/scripts/lib/usage/delegate.ts";
import { nodeHostUsageFs } from "../../skills/dispatch/scripts/lib/usage/index.ts";
import type { CliDeps } from "../../skills/dispatch/scripts/toolkit/cli.ts";
import { observeTool } from "../../skills/dispatch/scripts/toolkit/diagnostics-capture.ts";
import {
  sessionFacts,
  writeDiagnostics,
} from "../../skills/dispatch/scripts/toolkit/diagnostics.ts";
import { foldLedger } from "../../skills/dispatch/scripts/toolkit/ledger.ts";
import { delegateRequest } from "../helpers/delegate-request.ts";
import { defined, errorCode } from "../helpers/guards.ts";

const CREATED = "2020-01-01T00:00:00.000Z";
const E0 = Date.parse(CREATED);
const REVIEW = "plan-fixture";
const SESSION = "20200101T0000Z-plan-fixture";

const PRICING = {
  asOf: "2026-11-19",
  source: ["https://example.test/pricing"],
  models: { m: { rates: { input: 2, output: 10 } } },
};

interface Fixture {
  root: string;
  claudeConfig: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

interface SideSpec {
  session: string;
  host: string;
  nativeId?: string;
  reportComplete?: string;
}

interface MeasureOptions {
  baseDir?: string;
  pricing?: string;
}

const unusedPort = (): never => {
  throw new Error("unused CliDeps port");
};

// Unused ports reject loudly, so a measurement that starts to need one fails its test.
const cliDeps = (ports: Partial<CliDeps>) => ({
  delegate: unusedPort,
  modes: unusedPort,
  orchestrator: null,
  liveness: {},
  run: unusedPort,
  stdout: unusedPort,
  env: {},
  clock: unusedPort,
  sleep: unusedPort,
  pid: 0,
  host: "",
  isAlive: unusedPort,
  skillRoot: "",
  ...ports,
});

const fixture = () => {
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "measure-runs-"))
  );

  const claudeConfig = path.join(root, "claude-config");

  return {
    root,
    claudeConfig,
    env: { CLAUDE_CONFIG_DIR: claudeConfig },
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
};

const writeText = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const writeJson = (file: string, value: unknown) => {
  writeText(file, `${JSON.stringify(value)}\n`);
};

const digest = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);

const reviewKey = (session: string) =>
  `review-${digest(path.join(session, ".state", "reviews", REVIEW))}`;

const subjectFor = (base: string, round: number, generation = 1) =>
  digest(
    path.join(
      base,
      ".state",
      "reviews",
      REVIEW,
      `round-${round}`,
      `gen-${generation}`
    )
  );

const makeSession = (
  fx: Fixture,
  options: { name?: string; sessionId?: string } = {}
) => {
  const name = options.name ?? SESSION;
  const sessionId = options.sessionId ?? "host-1";
  const session = path.join(fx.root, ".scratch", "dispatch-skills", name);
  writeJson(path.join(session, "manifest.json"), {
    schemaVersion: 1,
    folderName: name,
    sessionId,
    safeSessionId: sessionId,
    repositoryRoot: fx.root,
    sessionTitle: "fixture",
    createdAt: CREATED,
    lastUsedAt: CREATED,
    location: "workspace",
  });

  return session;
};

const writeRound = (session: string, round: number, completed: boolean) => {
  const roundDir = path.join(
    session,
    ".state",
    "reviews",
    REVIEW,
    `round-${round}`
  );

  writeJson(path.join(roundDir, "round.json"), {
    round,
    generation: 1,
    cap: 4,
    roster: [],
  });
  fs.mkdirSync(path.join(roundDir, "gen-1"), { recursive: true });

  if (completed) {
    writeJson(path.join(roundDir, "findings.json"), {
      review: REVIEW,
      round,
      cap: 4,
      findings: [],
    });
  }
};

const writeCapture = (
  session: string,
  name: string,
  capture: { start: number; end?: number },
  phase: string | undefined,
  invocations: unknown[] = []
) => {
  writeJson(path.join(session, ".state", "diagnostics", `${name}.json`), {
    capture: {
      state: capture.end === undefined ? "opened" : "completed",
      ...capture,
    },
    phases:
      phase !== undefined && phase !== null && phase !== ""
        ? [{ key: phase, name: "plan review" }]
        : [],
    invocations,
    reviews: [],
  });
};

// A reviewer run without usage is an unpriced unit.
const REVIEWER_USAGE = { input: 10, output: 5 };

// Standard fixture cost: two host rows (999/1 and 100/50) plus three reviewer runs, priced at PRICING rates.
const FIXTURE_COST =
  (999 * 2 +
    1 * 10 +
    100 * 2 +
    50 * 10 +
    3 * (REVIEWER_USAGE.input * 2 + REVIEWER_USAGE.output * 10)) /
  1_000_000;

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
  usage: REVIEWER_USAGE,
});

// Two completed plan rounds and one unfinished round; `base` is the path string the recorded subjects hash.
const writeRoundFixture = (session: string, base: string = session) => {
  for (const round of [1, 2, 3]) {
    writeRound(session, round, round !== 3);
  }

  writeCapture(
    session,
    "review-1",
    { start: E0 + 1000, end: E0 + 4000 },
    "review-run-plan",
    [reviewRun(subjectFor(base, 1))]
  );
  writeCapture(
    session,
    "ledger",
    { start: E0 + 2000, end: E0 + 2100 },
    "ledger-append"
  );
  writeCapture(
    session,
    "review-2",
    { start: E0 + 10_000, end: E0 + 12_000 },
    "review-run-plan",
    [reviewRun(subjectFor(base, 2))]
  );
  writeCapture(
    session,
    "review-3",
    { start: E0 + 20_000, end: E0 + 21_000 },
    "review-run-plan",
    [reviewRun(subjectFor(base, 3))]
  );
};

const usageLine = (
  id: string,
  at: number,
  input: number,
  output: number,
  model = "m"
) =>
  JSON.stringify({
    type: "assistant",
    timestamp: new Date(at).toISOString(),
    message: {
      id,
      model,
      usage: { input_tokens: input, output_tokens: output },
    },
  });

const denialLine = (at: number, source: string) =>
  JSON.stringify({
    type: "user",
    timestamp: new Date(at).toISOString(),
    toolDenialKind: "tool",
    permissionDecision: { decision: "reject", source },
  });

const writeClaudeTranscript = (
  fx: Fixture,
  hostId: string,
  lines: string[],
  subagentLines: string[] = []
) => {
  const projectDir = path.join(fx.claudeConfig, "projects", "project-a");
  writeText(path.join(projectDir, `${hostId}.jsonl`), `${lines.join("\n")}\n`);

  if (subagentLines.length) {
    writeText(
      path.join(projectDir, hostId, "subagents", "agent-1.jsonl"),
      `${subagentLines.join("\n")}\n`
    );
  }
};

const optionsFor = (fx: Fixture, options: MeasureOptions) => ({
  baseDir: options.baseDir ?? fx.root,
  home: fx.root,
  env: fx.env,
  pricing: {
    path: "pricing.json",
    text: options.pricing ?? JSON.stringify(PRICING),
  },
});

const measureSides = (
  fx: Fixture,
  sides: SideSpec[],
  options: MeasureOptions = {}
) => {
  const pairs = parsePairs({
    pairs: [
      {
        name: "plan",
        sides: sides.map((side, index) => ({
          label: `side-${index}`,
          ...side,
        })),
      },
    ],
  });

  return measureRuns(pairs, optionsFor(fx, options));
};

const measureOne = (
  fx: Fixture,
  side: SideSpec,
  options: MeasureOptions = {}
) => defined(defined(measureSides(fx, [side], options).pairs[0]).sides[0]);

const snapshot = (dir: string) => {
  const files: Record<string, string> = {};

  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        walk(full);
      } else {
        files[path.relative(dir, full)] = fs.readFileSync(full, "utf-8");
      }
    }
  };

  walk(dir);

  return files;
};

// Another path string for the same folder: a lowercase drive letter on Windows, otherwise a directory symlink.
const aliasOf = (fx: Fixture, session: string) => {
  if (process.platform === "win32") {
    const alias = session.replace(
      /^(?<g1>[A-Z]):/u,
      (_match, drive: string) => `${drive.toLowerCase()}:`
    );

    return alias === session ? null : alias;
  }

  const link = path.join(fx.root, "alias", path.basename(session));
  fs.mkdirSync(path.dirname(link), { recursive: true });

  try {
    fs.symlinkSync(session, link, "dir");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(errorCode(error) ?? "")) {
      return null;
    }

    throw error;
  }

  return link;
};

const io = (fx: Fixture, stdout: string[], stderr: string[]) => ({
  cwd: fx.root,
  home: fx.root,
  env: fx.env,
  stdout: (text: string) => stdout.push(text),
  stderr: (text: string) => stderr.push(text),
});

// SECTION: core — measureRuns/measureSides unit behaviour (no CLI, no --out).

test("round turns: measures rounds and per-round calls, host tokens and host turns for completed rounds only", () => {
  const fx = fixture();

  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(fx, "host-1", [
      usageLine("pre", E0 + 500, 999, 1),
      usageLine("a", E0 + 1500, 100, 50),
    ]);
    const side = measureOne(fx, { session, host: "claude" });
    const key = reviewKey(session);
    assert.equal(side.session, session);
    assert.equal(side.nativeId, "host-1");
    assert.deepEqual(side.window, {
      startMs: E0,
      endMs: E0 + 21_000,
      pathForm: "canonical",
    });
    assert.deepEqual(side.rounds, { total: 2, byReview: { [key]: 2 } });
    assert.deepEqual(side.perRound, [
      { review: key, round: 1, calls: 2, hostTokens: 150, hostTurns: 1 },
      { review: key, round: 2, calls: 1, hostTokens: 0, hostTurns: 0 },
    ]);
    assert.equal(side.hostTokens, 1150);
    // Round 3 is unfinished: it stays out of the totals and is named as excluded.
    assert.deepEqual(side.unavailable, [
      `rounds: ${key} 3 excluded: no readable round result`,
    ]);
  } finally {
    fx.cleanup();
  }
});

test("measuring leaves session folders and host transcripts unchanged", () => {
  const fx = fixture();

  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(fx, "host-1", [usageLine("a", E0 + 1500, 100, 50)]);
    const before = snapshot(fx.root);
    measureOne(fx, { session, host: "claude" });
    assert.deepEqual(snapshot(fx.root), before);
  } finally {
    fx.cleanup();
  }
});

test("a pre-session denial counts only in the headline and free text never counts; config and hook count separately", () => {
  const fx = fixture();

  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(
      fx,
      "host-1",
      [
        denialLine(E0 - 60_000, "config"),
        denialLine(E0 + 5000, "config"),
        denialLine(E0 + 6000, "hook"),
        denialLine(E0 + 7000, "mystery"),
        "the call was denied, toolDenialKind noted in free text",
        JSON.stringify({ type: "user", text: "permission denied" }),
      ],
      [denialLine(E0 + 7500, "config")]
    );
    const side = measureOne(fx, { session, host: "claude" });
    assert.deepEqual(side.denials, {
      config: 3,
      hook: 1,
      other: 1,
      inWindow: { config: 2, hook: 1, other: 1 },
    });
  } finally {
    fx.cleanup();
  }
});

test("resolves a relative session against the pairs.json folder and attributes its rounds", () => {
  const fx = fixture();

  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    const pairsDir = path.join(fx.root, "pairs");
    fs.mkdirSync(pairsDir);

    const side = measureOne(
      fx,
      { session: path.relative(pairsDir, session), host: "claude" },
      { baseDir: pairsDir }
    );

    assert.equal(side.session, session);
    assert.equal(side.perRound[0]?.calls, 2);
  } finally {
    fx.cleanup();
  }
});

test("fails the run naming the side when the session folder is missing or the manifest is invalid", () => {
  const fx = fixture();

  try {
    const missing = path.join(fx.root, "missing-session");
    assert.throws(
      () => measureSides(fx, [{ session: missing, host: "claude" }]),
      /pair "plan" side "side-0": session folder missing/u
    );
    const session = makeSession(fx);
    writeJson(path.join(session, "manifest.json"), {
      schemaVersion: 1,
      folderName: "other-name",
      sessionId: "host-1",
      safeSessionId: "host-1",
      repositoryRoot: fx.root,
    });
    assert.throws(
      () => measureSides(fx, [{ session, host: "claude" }]),
      /pair "plan" side "side-0": Session manifest/u
    );
  } finally {
    fx.cleanup();
  }
});

test("alias path forms: measures through an alias and records canonical or as-given", (t) => {
  for (const form of ["canonical", "as-given"] as const) {
    const fx = fixture();

    try {
      const session = makeSession(fx);
      const alias = aliasOf(fx, session);

      if (alias === undefined || alias === null || alias === "") {
        t.skip("no alias path can be created on this host");

        return;
      }

      writeRoundFixture(session, form === "as-given" ? alias : session);
      const side = measureOne(fx, { session: alias, host: "claude" });
      assert.equal(side.window.pathForm, form, form);
      assert.equal(side.perRound[0]?.calls, 2, form);

      if (form === "canonical") {
        assert.equal(side.session, session);
      } else {
        assert.equal(side.perRound[0]?.review, reviewKey(alias));
      }
    } finally {
      fx.cleanup();
    }
  }
});

test("a moved session keeps its rounds but drops per-round calls with a no round starts reason", () => {
  const fx = fixture();

  try {
    const session = makeSession(fx);
    writeRoundFixture(session, path.join(fx.root, "old-folder"));
    writeClaudeTranscript(fx, "host-1", [usageLine("a", E0 + 1500, 100, 50)]);
    const side = measureOne(fx, { session, host: "claude" });
    const key = reviewKey(session);
    assert.equal(side.rounds.total, 2);
    assert.deepEqual(side.perRound, [
      { review: key, round: 1 },
      { review: key, round: 2 },
    ]);
    assert.deepEqual(side.unavailable, [
      `rounds: ${key} 3 excluded: no readable round result`,
      `perRound: ${key} 1 calls: no round starts`,
      `perRound: ${key} 1 hostTurns: no round starts`,
      `perRound: ${key} 1 hostTokens: no round starts`,
      `perRound: ${key} 2 calls: no round starts`,
      `perRound: ${key} 2 hostTurns: no round starts`,
      `perRound: ${key} 2 hostTokens: no round starts`,
    ]);
  } finally {
    fx.cleanup();
  }
});

test("round turns: a Claude side without a host transcript reports the missing transcript and partial cost", () => {
  const fx = fixture();

  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    const side = measureOne(fx, { session, host: "claude" });
    assert.deepEqual(side.denials, { unavailable: "host transcript missing" });
    assert.equal(side.hostTokens, undefined);
    assert.equal(side.cost.partial, true);
    assert.ok(side.unavailable.includes("denials: host transcript missing"));
    assert.ok(side.unavailable.includes("hostTokens: host id file missing"));
    assert.ok(
      side.unavailable.includes(
        `perRound: ${reviewKey(session)} 1 hostTurns: host id file missing`
      )
    );
    assert.equal(side.perRound[0]?.hostTurns, undefined);
  } finally {
    fx.cleanup();
  }
});

test("an agy side reports no denial marker and no host tokens", () => {
  const fx = fixture();

  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    const side = measureOne(fx, { session, host: "agy", nativeId: "conv-1" });
    assert.deepEqual(side.denials, { unavailable: "no denial marker" });
    assert.equal(side.hostTokens, undefined);
    assert.equal(side.cost.partial, true);
    assert.ok(side.unavailable.includes("denials: no denial marker"));
  } finally {
    fx.cleanup();
  }
});

test("nativeId selects the host transcript instead of the manifest session id", () => {
  const fx = fixture();

  try {
    const session = makeSession(fx, { sessionId: "manifest-id" });
    writeRoundFixture(session);
    writeClaudeTranscript(fx, "native-1", [usageLine("a", E0 + 1500, 100, 50)]);

    const side = measureOne(fx, {
      session,
      host: "claude",
      nativeId: "native-1",
    });

    assert.equal(side.nativeId, "native-1");
    assert.equal(side.hostTokens, 150);
  } finally {
    fx.cleanup();
  }
});

test("prices every host and reviewer unit from the given pricing table and ignores a config pricing override", () => {
  const fx = fixture();

  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(fx, "host-1", [
      usageLine("pre", E0 + 500, 999, 1),
      usageLine("a", E0 + 1500, 100, 50),
    ]);
    writeJson(path.join(fx.root, "skills", "dispatch", "config.local.jsonc"), {
      pricing: { m: { rates: { input: 1000, output: 1000 } } },
    });
    const side = measureOne(fx, { session, host: "claude" });
    assert.equal(side.cost.priced, true);
    assert.equal(side.cost.unpricedUnits, 0);
    assert.ok(
      Math.abs(side.cost.low - FIXTURE_COST) < 1e-12,
      `${side.cost.low} vs ${FIXTURE_COST}`
    );
    assert.equal(side.cost.high, side.cost.low);
  } finally {
    fx.cleanup();
  }
});

// SECTION: efficiency — cost scope, efficiency denominators, verification, and comparison limits.

test("Matched comparisons disclose cost scope and basis", async () => {
  const fx = fixture();

  try {
    const dbFile = path.join(
      fx.root,
      ".local",
      "share",
      "opencode",
      "opencode.db"
    );

    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const db = new DatabaseSync(dbFile);

    try {
      db.exec("CREATE TABLE session_v2 (id TEXT, parent_id TEXT)");
      db.exec(
        "CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, time_created INTEGER, data TEXT)"
      );
      db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)").run(
        "row-1",
        "delegate-1",
        "assistant",
        E0 + 1,
        JSON.stringify({
          model: { providerID: "route", id: "m" },
          tokens: { input: 1000, output: 0 },
        })
      );
    } finally {
      db.close();
    }

    const parsed = readDelegateSession({
      platform: "opencode",
      sessionId: "delegate-1",
      startMs: E0,
      endMs: E0 + 10,
      resumed: false,
      home: fx.root,
      env: () => {},
      fs: nodeHostUsageFs,
      budget: { remaining: 100_000 },
    });

    assert.equal(parsed.complete, true);
    const qualified = makeSession(fx);

    const generic = makeSession(fx, {
      name: `${SESSION}-generic`,
      sessionId: "host-2",
    });

    const delegate = {
      ...reviewRun("valid-subject"),
      provider: "opencode",
      model: "route/m",
    };

    const skillRoot = path.join(fx.root, "skill");
    writeJson(path.join(skillRoot, "config.jsonc"), { diagnostics: true });
    let now = E0;

    const observer = defined(
      observeTool(
        qualified,
        "review",
        "run",
        "plan",
        cliDeps({
          skillRoot,
          clock: () => now,
          delegate: async () => {
            await Promise.resolve();

            return {
              outcome: {
                status: "ok",
                text: "answer",
                resume: null,
                sessionId: null,
              },
              invocations: [
                {
                  provider: "opencode",
                  model: "route/m",
                  effort: null,
                  mode: "cli",
                  launched: true,
                  outcome: "ok",
                  // eslint-disable-next-line typescript/no-unsafe-assignment -- fixture/mock boundary: values are validated by helpers before use.
                  usage: defined(parsed.usage),
                },
              ],
            };
          },
        })
      )
    );

    await observer.deps.delegate(
      "opencode",
      delegateRequest({
        logPath: path.join(qualified, "logs", "opencode[0].log"),
      }),
      "cli"
    );
    now += 10;
    observer.finish({ ok: true, exit: 0, summary: "done", value: null });
    const later = Date.parse("2021-01-01T00:00:00.000Z");
    writeCapture(
      generic,
      "run",
      { start: later, end: later + 10 },
      delegate.phase,
      [
        {
          ...delegate,
          usage: { input: 1000, output: 0 },
          reportedModels: ["m"],
          usageSource: "stdout",
          coverage: ["transcript unavailable"],
        },
        {
          ...delegate,
          attempt: 2,
          usage: { input: 1000, output: 0, cacheWrite: 1000 },
          usageSource: "stdout",
        },
      ]
    );

    const table = {
      ...PRICING,
      models: {
        m: {
          ...PRICING.models.m,
          periods: [
            {
              from: "2021-01-01",
              rates: {
                input: 20,
                output: 10,
                cacheWrite5m: 10,
                cacheWrite1h: 30,
              },
            },
          ],
        },
        "route/m": {
          rates: { input: 2, output: 10 },
          periods: [{ from: "2020-01-01", rates: { input: 100, output: 10 } }],
        },
      },
    };

    const comparison = measureSides(
      fx,
      [
        { session: qualified, host: "claude" },
        { session: generic, host: "claude" },
      ],
      { pricing: JSON.stringify(table) }
    );

    const pair = defined(comparison.pairs[0]);
    const left = defined(pair.sides[0]);
    const right = defined(pair.sides[1]);

    const report = fs.readFileSync(
      writeDiagnostics(
        qualified,
        sessionFacts(qualified, foldLedger(qualified), "measured"),
        resolvePricing(table, undefined)
      ),
      "utf-8"
    );

    assert.equal(left.cost.low, 0.1);
    assert.equal(right.cost.low, 0.05);
    assert.equal(right.cost.high, 0.07);
    assert.ok(right.cost.coverage.reasons.includes("bounded cost range"));
    assert.match(report, /Estimated cost .*~\$0\.10/u);
    assert.match(report, /1 qualified, 0 wildcard, 0 generic/u);
    assert.deepEqual(left.cost.rateBasis.matches, ["qualified"]);
    assert.deepEqual(right.cost.rateBasis.matchCounts, {
      qualified: 0,
      wildcard: 0,
      generic: 2,
    });
    assert.deepEqual(left.cost.rateBasis.periods, ["2020-01-01"]);
    assert.deepEqual(right.cost.rateBasis.periods, ["2021-01-01"]);
    assert.match(
      report,
      /Coverage warning: partial \(host usage unavailable, subagent usage unavailable\)/u
    );
    assert.deepEqual(left.cost.coverage.reasons, [
      "host usage unavailable",
      "subagent usage unavailable",
    ]);
    assert.equal(right.cost.coverage.sources["stdout fallback"], 1);
    assert.ok(
      pair.comparisonLimits.includes("effective tariff periods differ")
    );
    assert.ok(pair.comparisonLimits.includes("usage coverage differs"));
    const markdown = renderComparison(comparison);
    assert.match(
      markdown,
      /\| Cost \(USD\) \| ~\$0\.10 \(partial\) \| ~\$0\.05–\$0\.07 \(partial\) \|/u
    );

    for (const limit of pair.comparisonLimits) {
      assert.ok(markdown.includes(limit));
    }

    assert.match(markdown, /host usage unavailable.*delegate stdout fallback/u);
    assert.match(markdown, /2020-01-01.*1 qualified.*2021-01-01.*2 generic/u);
    assert.doesNotMatch(markdown, /Comparable priced subtotal/u);
  } finally {
    fx.cleanup();
  }
});

test("an unpriced host unit with usage available marks cost partial", () => {
  const fx = fixture();

  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(fx, "host-1", [usageLine("a", E0 + 1500, 100, 50)]);

    const otherOnly = JSON.stringify({
      ...PRICING,
      models: { other: { rates: { input: 1, output: 1 } } },
    });

    const side = measureOne(
      fx,
      { session, host: "claude" },
      { pricing: otherOnly }
    );

    assert.equal(side.cost.priced, false);
    assert.equal(side.cost.partial, true);
    assert.ok(side.cost.reasons.includes("unpriced model"));
  } finally {
    fx.cleanup();
  }
});

test("a priced delegate unit with transcript-unavailable coverage marks cost partial with its reason", () => {
  const fx = fixture();

  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(fx, "host-1", [usageLine("a", E0 + 1500, 100, 50)]);
    writeCapture(
      session,
      "delegate",
      { start: E0 + 3000, end: E0 + 3500 },
      undefined,
      [
        {
          phase: "delegate-run",
          attempt: 1,
          provider: "claude",
          model: "m",
          mode: "cli",
          surface: "cli",
          launched: true,
          outcome: "ok",
          slot: "claude[1]",
          usage: { input: 100, output: 50 },
          coverage: ["transcript unavailable"],
        },
      ]
    );
    const side = measureOne(fx, { session, host: "claude" });
    assert.equal(side.cost.priced, true);
    assert.equal(side.cost.partial, true);
    assert.ok(
      side.cost.reasons.includes("delegate coverage: transcript unavailable")
    );
  } finally {
    fx.cleanup();
  }
});

// SECTION: cli — runMeasureRuns, --out guards, and comparison artifacts.

test("a missing pricing file fails the run naming the file", () => {
  const fx = fixture();

  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeJson(path.join(fx.root, "pairs.json"), {
      pricing: "missing/pricing.json",
      pairs: [
        {
          name: "plan",
          sides: [{ label: "historical", session, host: "claude" }],
        },
      ],
    });

    const stdout: string[] = [];
    const stderr: string[] = [];

    assert.equal(
      runMeasureRuns(
        [path.join(fx.root, "pairs.json"), "--out", path.join(fx.root, "out")],
        io(fx, stdout, stderr)
      ),
      1
    );
    assert.match(stderr.join(""), /missing[\\/]pricing\.json/u);
    assert.equal(
      fs.existsSync(path.join(fx.root, "out", "comparison.json")),
      false
    );
  } finally {
    fx.cleanup();
  }
});

// Runs the CLI for one side; pricing.json and pairs.json sit in the fixture root, which is the working directory.
const runSingleSide = (fx: Fixture, session: string, out: string) => {
  writeJson(path.join(fx.root, "pricing.json"), PRICING);
  writeJson(path.join(fx.root, "pairs.json"), {
    pricing: "pricing.json",
    pairs: [
      {
        name: "plan",
        sides: [{ label: "historical", session, host: "claude" }],
      },
    ],
  });

  const stdout: string[] = [];
  const stderr: string[] = [];

  const code = runMeasureRuns(
    [path.join(fx.root, "pairs.json"), "--out", out],
    io(fx, stdout, stderr)
  );

  return { code, stderr: stderr.join("") };
};

test("refuses an --out folder inside a measured session folder before writing", () => {
  const fx = fixture();

  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(fx, "host-1", [usageLine("a", E0 + 1500, 100, 50)]);
    const out = path.join(session, "comparison");
    const result = runSingleSide(fx, session, out);
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /--out must not be inside or equal a measured session folder/u
    );
    assert.equal(fs.existsSync(out), false);
  } finally {
    fx.cleanup();
  }
});

test("refuses an --out folder inside or equal to a host store before writing", () => {
  const fx = fixture();

  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(fx, "host-1", [usageLine("a", E0 + 1500, 100, 50)]);

    for (const out of [
      path.join(fx.claudeConfig, "comparison"),
      fx.claudeConfig,
    ]) {
      const result = runSingleSide(fx, session, out);
      assert.equal(result.code, 1);
      assert.match(
        result.stderr,
        /--out must not be inside or equal a host store/u
      );
    }

    assert.equal(
      fs.existsSync(path.join(fx.claudeConfig, "comparison")),
      false
    );
  } finally {
    fx.cleanup();
  }
});

test("a corrupt capture marks cost partial and calls and host tokens partial in the entries and comparison.md", () => {
  const fx = fixture();

  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(fx, "host-1", [usageLine("a", E0 + 1500, 100, 50)]);
    writeJson(path.join(session, ".state", "diagnostics", "broken.json"), {
      unexpected: true,
    });
    const side = measureOne(fx, { session, host: "claude" });
    assert.equal(side.cost.priced, true);
    assert.equal(side.cost.partial, true);
    assert.ok(side.cost.reasons.includes("captures partial"));
    assert.ok(
      side.unavailable.includes("perRound calls partial: captures partial (1)")
    );
    assert.ok(
      side.unavailable.includes("hostTokens partial: captures partial (1)")
    );
    const out = path.join(fx.root, "out");
    assert.equal(runSingleSide(fx, session, out).code, 0);
    const md = fs.readFileSync(path.join(out, "comparison.md"), "utf-8");
    assert.match(md, /^\| Calls in rounds \| 3 \(partial\) \|$/mu);
    assert.match(md, /^\| Host tokens in rounds \| 150 \(partial\) \|$/mu);
  } finally {
    fx.cleanup();
  }
});

test("an unparsed host transcript line marks host tokens partial in the entry and comparison.md", () => {
  const fx = fixture();

  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(fx, "host-1", [
      usageLine("a", E0 + 1500, 100, 50),
      "not json",
    ]);
    const side = measureOne(fx, { session, host: "claude" });
    assert.ok(side.unavailable.includes("hostTokens partial: unparsed lines"));
    const out = path.join(fx.root, "out");
    assert.equal(runSingleSide(fx, session, out).code, 0);
    assert.match(
      fs.readFileSync(path.join(out, "comparison.md"), "utf-8"),
      /^\| Host tokens in rounds \| 150 \(partial\) \|$/mu
    );
  } finally {
    fx.cleanup();
  }
});

test("a round with an unreadable round.json or findings.json is excluded and named once", () => {
  for (const file of ["round.json", "findings.json"]) {
    const fx = fixture();

    try {
      const session = makeSession(fx);
      writeRoundFixture(session);
      writeText(
        path.join(session, ".state", "reviews", REVIEW, "round-2", file),
        "{not json"
      );
      writeClaudeTranscript(fx, "host-1", [usageLine("a", E0 + 1500, 100, 50)]);
      const side = measureOne(fx, { session, host: "claude" });
      const key = reviewKey(session);
      assert.deepEqual(side.rounds, { total: 1, byReview: { [key]: 1 } }, file);
      assert.deepEqual(
        side.perRound.map((row) => row.round),
        [1],
        file
      );

      const namedCount = (round: number) =>
        side.unavailable.filter(
          (entry) =>
            entry ===
            `rounds: ${key} ${round} excluded: no readable round result`
        ).length;

      assert.equal(namedCount(2), 1, file);
      assert.equal(namedCount(3), 1, file);
    } finally {
      fx.cleanup();
    }
  }
});

// Symlink creation can be refused on Windows hosts without developer mode; the test is then skipped, as the alias test is.
const linkOrSkip = (
  t: { skip: (message?: string) => void },
  target: string,
  link: string
) => {
  try {
    fs.symlinkSync(target, link, "file");

    return true;
  } catch (error) {
    if (["EPERM", "EACCES"].includes(errorCode(error) ?? "")) {
      t.skip("no symlink permission on this host");

      return false;
    }

    throw error;
  }
};

for (const name of ["comparison.json", "comparison.md"]) {
  test(`refuses an --out whose ${name} is a symbolic link and writes nothing`, (t) => {
    const fx = fixture();

    try {
      const session = makeSession(fx);
      writeRoundFixture(session);
      writeClaudeTranscript(fx, "host-1", [usageLine("a", E0 + 1500, 100, 50)]);
      const target = path.join(fx.root, "elsewhere.txt");
      writeText(target, "original");
      const out = path.join(fx.root, "out");
      fs.mkdirSync(out);

      if (!linkOrSkip(t, target, path.join(out, name))) {
        return;
      }

      const result = runSingleSide(fx, session, out);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /symbolic link/u);
      assert.equal(fs.readFileSync(target, "utf-8"), "original");

      const other =
        name === "comparison.json" ? "comparison.md" : "comparison.json";

      assert.equal(fs.existsSync(path.join(out, other)), false);
    } finally {
      fx.cleanup();
    }
  });
}

test("a subagent-only note leaves host tokens unflagged while cost stays partial", () => {
  const fx = fixture();

  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(
      fx,
      "host-1",
      [usageLine("a", E0 + 1500, 100, 50)],
      ["not json"]
    );
    const side = measureOne(fx, { session, host: "claude" });
    assert.equal(side.cost.partial, true);
    assert.ok(side.cost.reasons.includes("unparsed lines"));
    assert.equal(
      side.unavailable.some((entry) => entry.startsWith("hostTokens partial:")),
      false
    );
    const out = path.join(fx.root, "out");
    assert.equal(runSingleSide(fx, session, out).code, 0);
    assert.match(
      fs.readFileSync(path.join(out, "comparison.md"), "utf-8"),
      /^\| Host tokens in rounds \| 150 \|$/mu
    );
  } finally {
    fx.cleanup();
  }
});

test("comparison and report reject the same malformed host model attribution", () => {
  const fx = fixture();

  try {
    const session = makeSession(fx);
    const end = E0 + 2000;
    writeCapture(session, "work", { start: E0, end }, "review-run-plan");
    writeClaudeTranscript(fx, "host-1", [
      usageLine("host", E0 + 1000, 100, 5, "https://route/m"),
    ]);
    const side = measureOne(fx, { session, host: "claude" });

    const deps = cliDeps({
      orchestrator: orchestratorFor("claude", () => {}),
      clock: () => end,
      env: { ...fx.env, CLAUDE_CODE_SESSION_ID: "host-1" },
      hostUsageFs: nodeHostUsageFs,
    });

    const run = sessionFacts(session, foldLedger(session), "measured", {
      manifest: readManifest(session),
      deps,
    });

    const report = fs.readFileSync(
      writeDiagnostics(session, run, resolvePricing(PRICING, undefined)),
      "utf-8"
    );

    assert.match(report, /Estimated cost .*— .*priced 0 · unpriced 1/u);
    assert.equal(side.hostTokens, 105);
    assert.equal(side.cost.pricedUnits, 0);
    assert.equal(side.cost.unpricedUnits, 1);
    assert.ok(side.cost.reasons.includes("unpriced model"));
  } finally {
    fx.cleanup();
  }
});

test("writes comparison.json and comparison.md with pair tables, per-round rows and confounds", () => {
  const fx = fixture();

  try {
    const plan = makeSession(fx);
    writeRoundFixture(plan);
    writeClaudeTranscript(fx, "host-1", [usageLine("a", E0 + 1500, 100, 50)]);

    const replay = makeSession(fx, {
      name: "20200101T0001Z-plan-replay",
      sessionId: "host-2",
    });

    writeRoundFixture(replay);
    writeClaudeTranscript(fx, "host-2", [usageLine("b", E0 + 1500, 40, 10)]);
    writeJson(path.join(fx.root, "pricing.json"), PRICING);
    writeJson(path.join(fx.root, "pairs.json"), {
      pricing: "pricing.json",
      pairs: [
        {
          name: "plan",
          sides: [
            { label: "historical", session: plan, host: "claude" },
            { label: "p3-desktop", session: replay, host: "claude" },
          ],
        },
      ],
      confounds: ["one run per side"],
    });

    const stdout: string[] = [];
    const stderr: string[] = [];

    const out = path.join(fx.root, "out");
    assert.equal(
      runMeasureRuns(
        [path.join(fx.root, "pairs.json"), "--out", out],
        io(fx, stdout, stderr)
      ),
      0,
      stderr.join("")
    );

    // eslint-disable-next-line typescript/no-unsafe-assignment -- fixture/mock boundary: values are validated by helpers before use.
    const comparison: Comparison = JSON.parse(
      fs.readFileSync(path.join(out, "comparison.json"), "utf-8")
    );

    assert.deepEqual(comparison.pricing, {
      path: "pricing.json",
      asOf: PRICING.asOf,
    });
    assert.deepEqual(comparison.confounds, ["one run per side"]);
    assert.deepEqual(
      comparison.pairs.map((pair) => pair.sides.map((side) => side.label)),
      [["historical", "p3-desktop"]]
    );
    assert.ok(
      defined(comparison.pairs[0]).comparisonLimits.includes(
        "verification evidence unavailable"
      )
    );
    const md = fs.readFileSync(path.join(out, "comparison.md"), "utf-8");
    assert.match(md, /^## plan$/mu);
    assert.match(md, /^\| Metric \| historical \| p3-desktop \|$/mu);
    assert.match(md, /^\| Rounds \| 2 \| 2 \|$/mu);
    assert.doesNotMatch(md, /^\| Comparable priced subtotal \(USD\) \|/mu);
    assert.match(md, /^### Per-round$/mu);
    assert.match(md, /^## Confounds$/mu);
    assert.match(md, /^- one run per side$/mu);
    assert.match(md, /Pricing: `pricing\.json` as of 2026-11-19/u);
  } finally {
    fx.cleanup();
  }
});

test("Efficiency measures keep their denominators and evidence", () => {
  const fx = fixture();

  try {
    const session = makeSession(fx);
    writeRound(session, 1, true);
    writeRound(session, 2, true);
    const roundDir = path.join(session, ".state", "reviews", REVIEW, "round-1");
    writeJson(path.join(roundDir, "round.json"), {
      round: 1,
      generation: 2,
      cap: 4,
      roster: [
        { slot: "claude[0]" },
        { slot: "native[0]" },
        { slot: "empty[0]" },
      ],
    });
    writeJson(path.join(roundDir, "gen-2", "slots", "native.json"), {
      slot: "native[0]",
      state: "native",
    });
    writeJson(path.join(roundDir, "findings.json"), {
      findings: [
        { id: "f1", recurrence: { of: "old" } },
        { id: "f2", recurrence: { of: "old" } },
      ],
    });
    writeClaudeTranscript(fx, "host-1", [usageLine("host", E0 + 1100, 30, 5)]);
    writeCapture(
      session,
      "work",
      { start: E0 + 1000, end: E0 + 4000 },
      "review-run-plan",
      [
        {
          ...reviewRun(subjectFor(session, 1, 2)),
          startMs: 1000,
          endMs: 2000,
          outcome: "timeout",
          responses: [
            {
              stage: "unattributed",
              role: "delegate",
              basis: "claude-assistant-message",
              coverage: "partial",
              observed: 2,
              uncachedInput: 20,
            },
          ],
        },
        {
          ...reviewRun(subjectFor(session, 1, 2)),
          slot: "claude[1]",
          targetSlot: "native[0]",
          startMs: 2000,
          endMs: 6000,
          usage: { input: 700, output: 5 },
        },
        {
          ...reviewRun(subjectFor(session, 1, 2)),
          attempt: 2,
          startMs: 3000,
          endMs: 4000,
        },
        { ...reviewRun(subjectFor(session, 1)), startMs: 0, endMs: 9999 },
      ]
    );

    const comparison = measureSides(fx, [
      { session, host: "claude" },
      { session, host: "claude" },
    ]);

    const { efficiency } = defined(defined(comparison.pairs[0]).sides[0]);
    assert.equal(efficiency.matchedUncachedInput, 50);
    assert.equal(efficiency.responseEvents.matchedObserved, 3);
    assert.equal(efficiency.uncachedInputPerResponse, 50 / 3);
    assert.equal(efficiency.responseEvents.coverage, "partial");
    assert.deepEqual(efficiency.reviewOutcomes, {
      rounds: 2,
      accepted: 0,
      rejected: 0,
      recurring: 2,
    });
    assert.equal(efficiency.recovery.extraLaunches, 2);
    assert.equal(efficiency.recovery.reworkLaunches, 1);
    assert.deepEqual(efficiency.recovery.byCause["superseded generation"], {
      count: 1,
      cost: { low: 0.00007, high: 0.00007, partial: false },
    });
    assert.deepEqual(efficiency.recovery.byCause["timeout"], {
      count: 1,
      cost: { low: 0.00007, high: 0.00007, partial: false },
    });
    assert.deepEqual(efficiency.criticalPath, [
      {
        review: reviewKey(session),
        round: 1,
        elapsedMs: 5000,
        finishingSlot: "native[0]",
      },
      {
        review: reviewKey(session),
        round: 2,
        elapsedMs: null,
        finishingSlot: null,
      },
    ]);
    assert.equal(efficiency.verification, null);
    assert.match(
      renderComparison(comparison),
      /verification evidence unavailable/u
    );
  } finally {
    fx.cleanup();
  }
});

const status = (criterion: string, state: string) => ({
  criterion,
  state,
  evidence: "private evidence",
});

const reportResultName = (n: number) =>
  `.state/results/report-complete-00000000-0000-4000-8000-${String(n).padStart(12, "0")}.json`;

test("completed reports project only criterion states and disclose mismatches", () => {
  const fx = fixture();

  try {
    const session = makeSession(fx);
    const base = { session, host: "claude" };
    const source = "a".repeat(40);
    const body = (statuses: unknown[]) => ({ delivered: { source }, statuses });
    writeJson(
      path.join(session, reportResultName(1)),
      body([
        status("SC2", "manual"),
        status("contract", "verified"),
        status("SC1", "verified"),
      ])
    );
    writeJson(
      path.join(session, reportResultName(2)),
      body([status("SC1", "verified"), status("SC3", "manual")])
    );
    writeJson(
      path.join(session, reportResultName(3)),
      body([status("SC1", "verified"), status("SC2", "waived")])
    );
    writeJson(
      path.join(session, reportResultName(4)),
      body([status("SC1", "verified"), status("SC1", "missing")])
    );
    writeJson(path.join(session, reportResultName(5)), {
      delivered: null,
      statuses: [status("SC1", "verified")],
    });
    writeText(path.join(session, reportResultName(6)), "{[");
    writeText(
      path.join(session, reportResultName(7)),
      JSON.stringify(body([status("SC1", "verified")])) +
        " ".repeat(1024 * 1024)
    );
    fs.mkdirSync(path.join(session, reportResultName(8)));
    writeJson(
      path.join(session, reportResultName(9)),
      body([status("SC1", "pending")])
    );

    const withEvidence = (n: number) => ({
      ...base,
      reportComplete: reportResultName(n),
    });

    const pairWith = (n: number) =>
      measureSides(fx, [withEvidence(1), withEvidence(n)]);

    const matching = pairWith(1);
    assert.deepEqual(
      defined(defined(matching.pairs[0]).sides[0]).efficiency.verification,
      {
        verified: 1,
        manual: 1,
        waived: 0,
        missing: 0,
        criteria: [
          { id: "SC1", state: "verified" },
          { id: "SC2", state: "manual" },
        ],
      }
    );
    assert.ok(
      !defined(matching.pairs[0]).comparisonLimits.some((limit) =>
        limit.startsWith("verification")
      )
    );
    assert.doesNotMatch(renderComparison(matching), /private evidence/u);

    for (const [number, limit] of [
      [2, "verification criteria differ"],
      [3, "verification states differ"],
    ] as const) {
      const comparison = pairWith(number);
      assert.ok(defined(comparison.pairs[0]).comparisonLimits.includes(limit));
      assert.ok(renderComparison(comparison).includes(limit));
    }

    for (const number of [4, 5, 6, 7, 8, 9, 10]) {
      assert.equal(
        measureOne(fx, withEvidence(number)).efficiency.verification,
        null
      );
    }

    assert.equal(
      measureOne(fx, { ...base, reportComplete: `../${reportResultName(1)}` })
        .efficiency.verification,
      null
    );

    const outside = path.join(fx.root, "outside-results");
    writeJson(
      path.join(outside, path.basename(reportResultName(1))),
      body([status("SC1", "verified")])
    );
    const escaped = makeSession(fx, { name: "20200101T0001Z-results-link" });
    fs.mkdirSync(path.join(escaped, ".state"));
    fs.symlinkSync(
      outside,
      path.join(escaped, ".state", "results"),
      "junction"
    );
    assert.equal(
      measureOne(fx, { ...withEvidence(1), session: escaped }).efficiency
        .verification,
      null
    );
  } finally {
    fx.cleanup();
  }
});
