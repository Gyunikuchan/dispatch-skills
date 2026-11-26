import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { readDelegateSession } from "../../../skills/dispatch/scripts/lib/usage/delegate.ts";
import { agy } from "../../../skills/dispatch/scripts/providers/agy.ts";
import { nodeProcess } from "../../../skills/dispatch/scripts/providers/node-process.ts";
import type {
  DelegateRequest,
  ProviderUsageContext,
} from "../../../skills/dispatch/scripts/providers/types.ts";
import type { CliDeps } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import { main } from "../../../skills/dispatch/scripts/toolkit/cli.ts";
import { observeTool } from "../../../skills/dispatch/scripts/toolkit/diagnostics-capture.ts";
import {
  sessionFacts,
  writeDiagnostics,
} from "../../../skills/dispatch/scripts/toolkit/diagnostics.ts";
import { heuristics } from "../../../skills/dispatch/scripts/toolkit/domain/diagnostics.ts";
import type { Fold } from "../../../skills/dispatch/scripts/toolkit/ledger.ts";
import { recoveryTargetHash } from "../../../skills/dispatch/scripts/toolkit/review-state.ts";
import { defined } from "../../helpers/guards.ts";
import { memoryFs } from "../lib/usage/helpers/memory-fs.ts";
import { flag, narrow, withFields, text } from "./helpers/json.ts";
import type { JsonValue } from "./helpers/json.ts";
import { sessionFixture } from "./helpers/session.ts";

const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
};

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

const attempt = (
  subject: string,
  input: {
    slot: string;
    provider: string;
    model: string;
    attempt?: number;
    targetSlot?: string;
    outcome?: string;
    launched?: boolean;
    tokens?: number;
  }
) => ({
  phase: "plan-review",
  subject,
  attempt: input.attempt ?? 1,
  provider: input.provider,
  model: input.model,
  mode: "cli",
  surface: "cli",
  launched: input.launched ?? true,
  outcome: input.outcome ?? "ok",
  slot: input.slot,
  ...((input.targetSlot ?? "").length > 0 && { targetSlot: input.targetSlot }),
  ...(!(input.tokens === undefined) && {
    usage: { input: input.tokens, output: 0 },
  }),
});

const delegateReq = (logPath: string, targetSlot?: string) => {
  const req: DelegateRequest = {
    promptPath: "/p.md",
    model: null,
    effort: null,
    sandbox: false,
    schemaPath: null,
    resume: null,
    cwd: "/repo",
    timeoutMs: 5000,
    outputCapBytes: 100,
    attachments: [],
    logPath,
    briefPath: "/b.md",
  };

  if (targetSlot !== undefined) {
    req.targetSlot = targetSlot;
  }

  return req;
};

interface RoundOutcome {
  slot: string;
  state?: string;
  cls?: string;
  responder?: JsonValue;
}

const saveRound = (input: {
  session: string;
  review: string;
  round: number;
  roster: ReturnType<typeof rosterSlot>[];
  outcomes: RoundOutcome[];
  findings?: unknown[];
  generation?: number;
}) => {
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
};

const encodeVarint = (val: number | bigint) => {
  const bytes: number[] = [];
  let n = BigInt(val);

  while (n > 0x7fn) {
    // oxlint-disable-next-line eslint/no-bitwise -- wire-format varint encoding requires bitwise operations
    bytes.push(Number((n & 0x7fn) | 0x80n));
    // oxlint-disable-next-line eslint/no-bitwise -- wire-format varint encoding requires bitwise operations
    n >>= 7n;
  }

  // oxlint-disable-next-line eslint/no-bitwise -- wire-format varint encoding requires bitwise operations
  bytes.push(Number(n & 0x7fn));

  return bytes;
};

const encodeTag = (fieldNum: number, wireType: number) =>
  // oxlint-disable-next-line eslint/no-bitwise -- wire-format varint encoding requires bitwise operations
  encodeVarint((fieldNum << 3) | wireType);

const encodeLengthDelimited = (
  fieldNum: number,
  content: Uint8Array | number[] | string
) => {
  const buf =
    typeof content === "string"
      ? Buffer.from(content, "utf-8")
      : Buffer.from(content);

  return [...encodeTag(fieldNum, 2), ...encodeVarint(buf.length), ...buf];
};

const buildGenMetadataBlob = (options: {
  input?: number;
  output?: number;
  cacheRead?: number;
  reasoning?: number;
  modelSlug?: string;
  displayName?: string;
  lastStepIndex?: number;
}) => {
  const tag1Fields: number[] = [];
  const counters: number[] = [];

  if (options.input !== undefined) {
    counters.push(...encodeTag(2, 0), ...encodeVarint(options.input));
  }

  if (options.output !== undefined) {
    counters.push(...encodeTag(3, 0), ...encodeVarint(options.output));
  }

  if (options.cacheRead !== undefined) {
    counters.push(...encodeTag(5, 0), ...encodeVarint(options.cacheRead));
  }

  if (options.reasoning !== undefined) {
    counters.push(...encodeTag(9, 0), ...encodeVarint(options.reasoning));
  }

  if (counters.length > 0) {
    tag1Fields.push(...encodeLengthDelimited(4, counters));
  }

  if (options.modelSlug !== undefined) {
    tag1Fields.push(...encodeLengthDelimited(19, options.modelSlug));
  }

  if (options.lastStepIndex !== undefined) {
    const kv = [
      ...encodeLengthDelimited(1, "last_step_index"),
      ...encodeLengthDelimited(2, String(options.lastStepIndex)),
    ];

    tag1Fields.push(...encodeLengthDelimited(20, kv));
  }

  if (options.displayName !== undefined) {
    tag1Fields.push(...encodeLengthDelimited(21, options.displayName));
  }

  return new Uint8Array(encodeLengthDelimited(1, tag1Fields));
};

const step = (
  name: string,
  elapsedMs: number,
  budgetMs: number,
  outcome: string
) => ({
  step: name,
  elapsedMs,
  budgetMs,
  outcome,
});

test("OpenCode lifecycle steps survive failure without private data", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, "config.jsonc"), '{"diagnostics":true}');
    f.deps.skillRoot = skill;

    const kept = [
      step("debug-config", 12, 5000, "ok"),
      step("prepare", 3, 400, "failed"),
      step("response", 400, 400, "timeout"),
      step("teardown", 900, 2000, "unconfirmed"),
    ];

    const rejected = [
      step("prepare", 1, 1, "ok"),
      step("debug-agents", -1, 5, "ok"),
      step("debug-agents", 1.5, 5, "ok"),
      step("debug-agents", 1, 2_147_483_648, "ok"),
      step("custom", 1, 1, "ok"),
      step("debug-agents", 1, 2, String.raw`C:\private\path`),
      {
        ...step("debug-agents", 1, 2, "failed"),
        detail: "/home/private/secret",
      },
    ];

    const seen = new Map<string, boolean | undefined>();
    f.deps.delegate = (provider, request) => {
      seen.set(provider, request.collectLifecycle);
      throw Object.assign(new Error("private error"), {
        invocations: [
          {
            provider,
            model: "m",
            mode: "cli",
            launched: true,
            outcome: "timeout",
            lifecycleSteps: [...kept, ...rejected],
          },
        ],
      });
    };

    const observer = defined(
      observeTool(f.session, "ask", "run", undefined, f.deps)
    );

    for (const provider of ["opencode", "claude"] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await assert.rejects(
        observer.deps.delegate(
          provider,
          delegateReq(path.join(f.session, "logs", `${provider}[0].log`)),
          "cli"
        )
      );
    }

    assert.deepEqual(
      Object.fromEntries(seen),
      { opencode: true, claude: undefined },
      "only OpenCode collects lifecycle steps"
    );

    const facts = sessionFacts(
      f.session,
      { records: [], lastSeq: 0, torn: null },
      "complete"
    );

    assert.deepEqual(
      facts.invocations.map((i) => i.lifecycleSteps),
      [kept, kept],
      "failed launches keep only bounded, unique, allowlisted steps"
    );
    const directory = path.join(f.session, ".state", "diagnostics");
    assert.doesNotMatch(
      fs
        .readdirSync(directory)
        .map((file) => fs.readFileSync(path.join(directory, file), "utf-8"))
        .join(""),
      /private|secret|detail/u
    );
  } finally {
    f.cleanup();
  }
});

test("nudge marker persists only for boolean resume launches", async () => {
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
            provider: "codex",
            model: "m",
            mode: "cli",
            effort: null,
            launched: true,
            outcome: "timeout",
            durationMs: 10,
          },
          {
            provider: "codex",
            model: "m",
            mode: "cli",
            effort: null,
            launched: true,
            outcome: "ok",
            durationMs: 10,
            nudge: true,
          },
        ],
      });

    const observer = defined(
      observeTool(f.session, "ask", "run", undefined, f.deps)
    );

    const dir = path.join(f.session, "work");
    await observer.deps.delegate(
      "codex",
      delegateReq(path.join(dir, "logs", "codex[0].log")),
      "cli"
    );
    observer.finish({ ok: true, exit: 0, summary: "done", value: null });

    const facts = sessionFacts(
      f.session,
      { records: [], lastSeq: 0, torn: null },
      "complete"
    );

    assert.equal(facts.invocations.length, 2);
    assert.equal(
      narrow(facts.invocations[1], withFields({ nudge: flag })).nudge,
      true
    );
    const report = fs.readFileSync(writeDiagnostics(f.session, facts), "utf-8");
    assert.match(report, /ok · nudge/u);
  } finally {
    f.cleanup();
  }

  const g = sessionFixture({ memory: true });

  try {
    captureRuns(g.session, [
      {
        phase: "plan-review",
        attempt: 1,
        provider: "codex",
        model: "m",
        mode: "cli",
        surface: "cli",
        launched: true,
        outcome: "ok",
        slot: "codex[0]",
        subject: "aaaaaaaaaaaaaaaa",
        nudge: "yes",
      },
      {
        phase: "plan-review",
        attempt: 2,
        provider: "codex",
        model: "m",
        mode: "cli",
        surface: "cli",
        launched: true,
        outcome: "ok",
        slot: "codex[0]",
        subject: "aaaaaaaaaaaaaaaa",
        nudge: 1,
      },
    ]);

    const facts = sessionFacts(
      g.session,
      { records: [], lastSeq: 0, torn: null },
      "complete"
    );

    assert.ok(facts.invocations.every((i) => !("nudge" in i)));
    const report = fs.readFileSync(writeDiagnostics(g.session, facts), "utf-8");
    assert.doesNotMatch(report, /ok · nudge/u);
  } finally {
    g.cleanup();
  }
});

test("nudge and resume chains account recovered-stall waste exactly", () => {
  {
    const f = sessionFixture({ memory: true });

    try {
      const subject = "aaaaaaaaaaaaaaaa";
      captureRuns(f.session, [
        {
          ...attempt(subject, {
            slot: "codex[0]",
            provider: "codex",
            model: "m",
            attempt: 1,
            outcome: "timeout",
          }),
        },
        {
          ...attempt(subject, {
            slot: "codex[0]",
            provider: "codex",
            model: "m",
            attempt: 2,
            outcome: "ok",
          }),
          nudge: true,
        },
        {
          ...attempt(subject, {
            slot: "codex[1]",
            provider: "codex",
            model: "m",
            attempt: 1,
            outcome: "timeout",
          }),
        },
        {
          ...attempt(subject, {
            slot: "codex[1]",
            provider: "codex",
            model: "m",
            attempt: 2,
            outcome: "ok",
          }),
          nudge: true,
        },
      ]);

      const facts = sessionFacts(
        f.session,
        { records: [], lastSeq: 0, torn: null },
        "complete"
      );

      assert.deepEqual(
        heuristics(facts).filter((finding) => finding.source === "H1"),
        [],
        "two recovered stalls"
      );
    } finally {
      f.cleanup();
    }

    const g = sessionFixture({ memory: true });

    try {
      const subject = "bbbbbbbbbbbbbbbb";
      captureRuns(g.session, [
        {
          ...attempt(subject, {
            slot: "codex[0]",
            provider: "codex",
            model: "m",
            attempt: 1,
            outcome: "timeout",
          }),
        },
        {
          ...attempt(subject, {
            slot: "codex[0]",
            provider: "codex",
            model: "m",
            attempt: 2,
            outcome: "ok",
          }),
          nudge: true,
        },
        {
          ...attempt(subject, {
            slot: "codex[1]",
            provider: "codex",
            model: "m",
            attempt: 1,
            outcome: "timeout",
          }),
        },
      ]);

      const facts = sessionFacts(
        g.session,
        { records: [], lastSeq: 0, torn: null },
        "complete"
      );

      assert.deepEqual(
        heuristics(facts).filter((finding) => finding.source === "H1"),
        [],
        "one recovered stall plus one unrelated failure"
      );
    } finally {
      g.cleanup();
    }
  }

  {
    const f = sessionFixture({ memory: true });

    try {
      const subject = "cccccccccccccccc";
      captureRuns(f.session, [
        {
          ...attempt(subject, {
            slot: "codex[0]",
            provider: "codex",
            model: "m",
            attempt: 1,
            outcome: "timeout",
          }),
        },
        {
          ...attempt(subject, {
            slot: "codex[0]",
            provider: "codex",
            model: "m",
            attempt: 2,
            outcome: "ok",
          }),
          nudge: true,
          validationOutcome: "timeout",
        },
      ]);

      const facts = sessionFacts(
        f.session,
        { records: [], lastSeq: 0, torn: null },
        "complete"
      );

      const findings = heuristics(facts).filter(
        (finding) => finding.source === "H1"
      );

      assert.equal(
        findings.length,
        1,
        "failed validation on ok resume still yields waste"
      );
      assert.match(
        defined(findings[0]).evidence,
        /`timeout`: 2 of 2 CLI attempts failed/u
      );
    } finally {
      f.cleanup();
    }

    const g = sessionFixture({ memory: true });

    try {
      const subject = "dddddddddddddddd";
      captureRuns(g.session, [
        {
          ...attempt(subject, {
            slot: "codex[0]",
            provider: "codex",
            model: "model-a",
            attempt: 1,
            outcome: "timeout",
          }),
        },
        {
          ...attempt(subject, {
            slot: "codex[0]",
            provider: "codex",
            model: "model-a",
            attempt: 2,
            outcome: "timeout",
          }),
        },
        {
          ...attempt(subject, {
            slot: "codex[0]",
            provider: "codex",
            model: "model-b",
            attempt: 3,
            outcome: "timeout",
          }),
        },
        {
          ...attempt(subject, {
            slot: "codex[0]",
            provider: "codex",
            model: "model-b",
            attempt: 4,
            outcome: "ok",
          }),
          nudge: true,
        },
      ]);

      const facts = sessionFacts(
        g.session,
        { records: [], lastSeq: 0, torn: null },
        "complete"
      );

      const findings = heuristics(facts).filter(
        (finding) => finding.source === "H1"
      );

      assert.equal(findings.length, 1, "unrelated failures of another model");
      assert.match(
        defined(findings[0]).evidence,
        /`timeout`: 2 of 4 CLI attempts failed/u
      );
    } finally {
      g.cleanup();
    }
  }

  {
    const f = sessionFixture({ memory: true });

    try {
      const subject = "eeeeeeeeeeeeeeee";
      captureRuns(f.session, [
        {
          ...attempt(subject, {
            slot: "codex[0]",
            provider: "codex",
            model: "m",
            attempt: 1,
            outcome: "timeout",
          }),
        },
        {
          ...attempt(subject, {
            slot: "codex[0]",
            provider: "codex",
            model: "m",
            attempt: 2,
            outcome: "timeout",
          }),
          nudge: true,
        },
        {
          ...attempt(subject, {
            slot: "codex[0]",
            provider: "codex",
            model: "m",
            attempt: 3,
            outcome: "timeout",
          }),
          nudge: true,
        },
        {
          ...attempt(subject, {
            slot: "codex[0]",
            provider: "codex",
            model: "m",
            attempt: 4,
            outcome: "ok",
          }),
          nudge: true,
        },
      ]);

      const facts = sessionFacts(
        f.session,
        { records: [], lastSeq: 0, torn: null },
        "complete"
      );

      assert.deepEqual(
        heuristics(facts).filter((finding) => finding.source === "H1"),
        [],
        "two failed resumes absorbed by a third"
      );

      const report = fs.readFileSync(
        writeDiagnostics(f.session, facts),
        "utf-8"
      );

      assert.equal(
        (report.match(/(?:timeout|ok) · nudge/gu) ?? []).length,
        3,
        "every resume launch is marked"
      );
    } finally {
      f.cleanup();
    }

    const g = sessionFixture({ memory: true });

    try {
      const subject = "ffffffffffffffff";
      captureRuns(g.session, [
        {
          ...attempt(subject, {
            slot: "codex[0]",
            provider: "codex",
            model: "m",
            attempt: 1,
            outcome: "timeout",
          }),
        },
        {
          ...attempt(subject, {
            slot: "codex[0]",
            provider: "codex",
            model: "m",
            attempt: 2,
            outcome: "timeout",
          }),
          nudge: true,
        },
        {
          ...attempt(subject, {
            slot: "codex[0]",
            provider: "codex",
            model: "m",
            attempt: 3,
            outcome: "timeout",
          }),
          nudge: true,
        },
      ]);

      const facts = sessionFacts(
        g.session,
        { records: [], lastSeq: 0, torn: null },
        "complete"
      );

      const findings = heuristics(facts).filter(
        (finding) => finding.source === "H1"
      );

      assert.equal(findings.length, 1);
      assert.match(
        defined(findings[0]).evidence,
        /`timeout`: 3 of 3 CLI attempts failed/u
      );
    } finally {
      g.cleanup();
    }
  }
});

test("attempt rows persist once across callback and launch failure", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill);
    writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
    f.deps.skillRoot = skill;
    f.deps.delegate = async (_provider, request) => {
      await Promise.resolve();

      const row = {
        provider: "claude" as const,
        model: "m",
        effort: null,
        mode: "cli" as const,
        launched: true,
        outcome: "ok",
      };

      request.onInvocation?.(row);

      const facts = sessionFacts(
        f.session,
        { records: [], lastSeq: 0, torn: null },
        "complete"
      );

      assert.equal(facts.invocations.length, 1);

      return {
        outcome: {
          status: "ok",
          text: "answer",
          resume: null,
          sessionId: null,
        },
        invocations: [row],
      };
    };

    const observer = defined(
      observeTool(f.session, "ask", "run", undefined, f.deps)
    );

    await observer.deps.delegate(
      "claude",
      delegateReq(path.join(f.session, "logs", "claude[0].log")),
      "cli"
    );
    assert.equal(
      sessionFacts(
        f.session,
        { records: [], lastSeq: 0, torn: null },
        "complete"
      ).invocations.length,
      1
    );
  } finally {
    f.cleanup();
  }

  const g = sessionFixture({ memory: true });

  try {
    const skill = path.join(g.root, "skill");
    fs.mkdirSync(skill);
    writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
    g.deps.skillRoot = skill;

    const row = {
      provider: "claude" as const,
      model: "m",
      effort: null,
      mode: "cli" as const,
      launched: false,
      outcome: "launch-failed",
    };

    g.deps.delegate = (_provider, request) => {
      request.onInvocation?.(row);
      throw Object.assign(new Error("launch"), { invocations: [row] });
    };

    const observer = defined(
      observeTool(g.session, "ask", "run", undefined, g.deps)
    );

    await assert.rejects(
      observer.deps.delegate(
        "claude",
        delegateReq(path.join(g.session, "logs", "claude[0].log")),
        "cli"
      ),
      /launch/u
    );
    assert.equal(
      sessionFacts(
        g.session,
        { records: [], lastSeq: 0, torn: null },
        "complete"
      ).invocations.length,
      1
    );
  } finally {
    g.cleanup();
  }
});

test("the first persisted row keeps its preflight lifecycle steps", async (t) => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill);
    writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
    f.deps.skillRoot = skill;

    const { nodeDeps } =
      await import("../../../skills/dispatch/scripts/toolkit/cli.ts");

    t.mock.method(fs, "existsSync", () => true);
    const stat = fs.statSync;
    t.mock.method(fs, "statSync", (filePath: fs.PathLike) => {
      try {
        return stat(filePath);
      } catch {
        const fallback = stat(process.execPath);
        fallback.mode = 0o755;

        return fallback;
      }
    });
    t.mock.method(nodeProcess, "start", () => ({
      pid: 50,
      done: Promise.resolve({
        exit: 2,
        signal: null,
        stdout: "",
        stdoutPath: "/unused",
        stderrTail: "permission denied",
        durationMs: 1,
        timedOut: false,
        truncated: false,
      }),
    }));
    const native = nodeDeps();
    f.deps.delegate = native.delegate;

    const observer = defined(
      observeTool(f.session, "ask", "run", undefined, f.deps)
    );

    const result = await observer.deps.delegate(
      "opencode",
      {
        promptPath: "/unused",
        model: null,
        effort: null,
        sandbox: false,
        schemaPath: null,
        resume: null,
        cwd: f.root,
        timeoutMs: 60_000,
        outputCapBytes: 1000,
        attachments: [],
        logPath: path.join(f.session, "logs", "opencode[0].log"),
        briefPath: "/unused",
      },
      "cli"
    );

    const facts = sessionFacts(
      f.session,
      { records: [], lastSeq: 0, torn: null },
      "complete"
    );

    assert.ok((result.invocations[0]?.lifecycleSteps?.length ?? 0) > 0);
    assert.deepEqual(
      facts.invocations[0]?.lifecycleSteps,
      result.invocations[0]?.lifecycleSteps
    );
  } finally {
    t.mock.restoreAll();
    f.cleanup();
  }
});

test("attempt persistence retries a failed write without repeating successful writes", async (t) => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill);
    writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
    f.deps.skillRoot = skill;

    const observer = defined(
      observeTool(f.session, "ask", "run", undefined, f.deps)
    );

    const rename = fs.renameSync;

    let fail = true;
    let writes = 0;

    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
    t.mock.method(fs, "renameSync", ((from: fs.PathLike, to: fs.PathLike) => {
      if (
        String(to).endsWith(".json") &&
        !String(to).endsWith(".failure.json")
      ) {
        writes += 1;

        if (fail) {
          fail = false;
          throw new Error("storage");
        }
      }

      rename(from, to);
    }) as typeof fs.renameSync);

    const row = {
      provider: "claude" as const,
      model: "m",
      effort: null,
      mode: "cli" as const,
      launched: true,
      outcome: "ok",
      startMs: 0,
      endMs: 30,
    };

    f.deps.delegate = async (_provider, request) => {
      await Promise.resolve();
      request.onInvocation?.(row);

      return {
        outcome: {
          status: "ok",
          text: "answer",
          resume: null,
          sessionId: null,
        },
        invocations: [row],
      };
    };

    await observer.deps.delegate(
      "claude",
      delegateReq(path.join(f.session, "logs", "claude[0].log")),
      "cli"
    );
    assert.equal(writes, 2, "return retries failed callback persistence");
    assert.deepEqual(
      sessionFacts(
        f.session,
        { records: [], lastSeq: 0, torn: null },
        "complete"
      ).invocations.map((i) => [i.startMs, i.endMs]),
      [[0, 30]]
    );
    writes = 0;
    const second = { ...row };
    f.deps.delegate = async (_provider, request) => {
      await Promise.resolve();
      request.onInvocation?.(second);

      return {
        outcome: {
          status: "ok",
          text: "answer",
          resume: null,
          sessionId: null,
        },
        invocations: [second],
      };
    };

    await observer.deps.delegate(
      "claude",
      delegateReq(path.join(f.session, "logs", "claude[0].log")),
      "cli"
    );
    assert.equal(
      writes,
      1,
      "return does not repeat successful callback persistence"
    );
  } finally {
    t.mock.restoreAll();
    f.cleanup();
  }
});

test("capture reread retains selected usage sources and rejects legacy failed zero", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
    f.deps.skillRoot = skill;

    const invocation = {
      provider: "claude",
      effort: null,
      mode: "cli",
      launched: true,
    } as const;

    const usage = {
      input: 0,
      output: 0,
      scope: "invocation",
      inputSemantics: "uncached",
    } as const;

    const rows = [
      {
        ...invocation,
        model: "event-zero",
        outcome: "quota" as const,
        usage: { ...usage, provenance: "session" },
      },
      {
        ...invocation,
        model: "fallback",
        outcome: "ok" as const,
        usage: { ...usage, input: 3, provenance: "stdout" },
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
        coverage: ["transcript unavailable", "invalid counters"] as (
          | "transcript unavailable"
          | "invalid counters"
        )[],
      },
    ];

    f.deps.delegate = async (_provider, request) => {
      await Promise.resolve();

      for (const row of rows) {
        request.onInvocation?.(row);
      }

      return {
        outcome: {
          status: "ok",
          text: "answer",
          resume: null,
          sessionId: null,
        },
        invocations: rows,
      };
    };

    const observer = defined(
      observeTool(f.session, "ask", "run", undefined, f.deps)
    );

    await observer.deps.delegate(
      "claude",
      delegateReq(path.join(f.session, "logs", "claude[0].log")),
      "cli"
    );
    observer.finish({ ok: true, exit: 0, summary: "done", value: null });
    const legacy = { ...invocation, surface: "cli", outcome: "quota" };
    captureRuns(f.session, [
      {
        ...legacy,
        model: "legacy-zero",
        usage: { input: 0, output: 0 },
        coverage: ["transcript unavailable"],
      },
      {
        ...legacy,
        model: "legacy-nonzero",
        usage: { input: 2, output: 0 },
        usageSource: "private-source",
      },
    ]);

    const observed = sessionFacts(
      f.session,
      { records: [], lastSeq: 0, torn: null },
      "complete"
    ).invocations;

    assert.deepEqual(
      observed
        .map((row) => [
          row.model,
          row.usage?.input,
          row.usageSource,
          row.coverage,
        ])
        .toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [
        ["event-zero", 0, "session", undefined],
        [
          "fallback",
          3,
          "stdout",
          ["transcript unavailable", "invalid counters"],
        ],
        ["legacy-nonzero", 2, undefined, undefined],
        [
          "legacy-zero",
          undefined,
          undefined,
          ["transcript unavailable", "unverified zero"],
        ],
      ]
    );
  } finally {
    f.cleanup();
  }
});

const event = (id: string, at: number) =>
  JSON.stringify({
    type: "assistant",
    timestamp: new Date(at).toISOString(),
    message: { id, model: "m", usage: { input_tokens: 42, output_tokens: 1 } },
  });

test("response evidence retains verified aliases across captures and distinguishes zero from unknown", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
    f.deps.skillRoot = skill;

    const first = "private-session-one";
    const second = "private-session-two";

    const files = memoryFs({
      [`/home/.claude/projects/-repo/${first}.jsonl`]: [
        event("private-event", 12),
        event("private-event", 22),
      ].join("\n"),
      [`/home/.claude/projects/-repo/${second}.jsonl`]: event(
        "private-event-two",
        12
      ),
    });

    for (const [sessionId, startMs, endMs, resumed, model] of [
      [first, 0, 20, false, "first"],
      [first, 21, 30, true, "resume"],
      [second, 0, 20, false, "other"],
    ] as const) {
      const usageFs =
        model === "first"
          ? memoryFs({
              [`/home/.claude/projects/-repo/${first}.jsonl`]: event(
                "private-event",
                12
              ),
            })
          : files;

      const { responses } = readDelegateSession({
        platform: "claude",
        collectResponses: true,
        sessionId,
        startMs,
        endMs,
        resumed,
        home: "/home",
        env: () => {},
        cwd: "/repo",
        fs: usageFs,
        budget: { remaining: 1024 },
      });

      assert.ok((responses?.length ?? 0) > 0);
      // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
      f.deps.delegate = async () => ({
        outcome: {
          status: "ok",
          text: "answer",
          resume: null,
          sessionId: null,
        },
        invocations: [
          {
            provider: "claude",
            effort: null,
            mode: "cli",
            launched: true,
            model,
            outcome: "ok",
            responses: defined(responses),
          },
        ],
      });

      const observer = defined(
        observeTool(f.session, "ask", "run", undefined, f.deps)
      );

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential awaits build and observe fixture state
      await observer.deps.delegate(
        "claude",
        delegateReq(path.join(f.session, "logs", "claude[0].log")),
        "cli"
      );
      observer.finish({ ok: true, exit: 0, summary: "done", value: null });
    }

    const legacy = {
      provider: "claude",
      model: "legacy",
      launched: true,
      outcome: "ok",
    };

    captureRuns(f.session, [
      legacy,
      {
        ...legacy,
        model: "unsafe",
        responses: [
          {
            stage: "ask",
            role: "delegate",
            agent: first,
            basis: "claude-assistant-message",
            coverage: "complete",
            observed: 9,
          },
          {
            stage: "ask",
            role: "delegate",
            basis: "unavailable",
            coverage: "unknown",
            observed: 0,
          },
        ],
      },
    ]);

    const observed = new Map(
      sessionFacts(
        f.session,
        { records: [], lastSeq: 0, torn: null },
        "complete"
      ).invocations.map((row) => [row.model, row.responses?.[0]])
    );

    const agent = observed.get("first")?.agent;
    assert.match(agent ?? "", /^delegate-[a-f0-9]{16}$/u);
    assert.notEqual(observed.get("other")?.agent, agent);
    assert.deepEqual(observed.get("first"), {
      stage: "ask",
      role: "delegate",
      agent,
      basis: "claude-assistant-message",
      coverage: "complete",
      observed: 1,
      uncachedInput: 42,
      toolCalls: 0,
      toolTurns: 0,
    });
    assert.deepEqual(observed.get("resume"), {
      stage: "ask",
      role: "delegate",
      agent,
      basis: "claude-assistant-message",
      coverage: "complete",
      observed: 0,
      uncachedInput: 0,
    });
    assert.equal(observed.get("legacy"), undefined);
    assert.equal(observed.get("unsafe"), undefined);
    const directory = path.join(f.session, ".state", "diagnostics");

    for (const file of fs
      .readdirSync(directory)
      .filter((name) => name !== "run-1.json")) {
      assert.doesNotMatch(
        fs.readFileSync(path.join(directory, file), "utf-8"),
        /private-session|private-event/u
      );
    }
  } finally {
    f.cleanup();
  }
});

test("agy delegate invocations render resolved model and effort in diagnostics report", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill);
    writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
    f.deps.skillRoot = skill;

    const turnInit = buildGenMetadataBlob({
      input: 100,
      output: 20,
      cacheRead: 50,
      reasoning: 10,
      modelSlug: "gemini-4-argon-trial",
      displayName: "Gemini 4 Argon (Medium)",
      lastStepIndex: 1,
    });

    const turnResume = buildGenMetadataBlob({
      input: 150,
      output: 30,
      cacheRead: 60,
      reasoning: 15,
      modelSlug: "gemini-3.8-flash-tiered",
      displayName: "Gemini 3.8 Flash (High)",
      lastStepIndex: 5,
    });

    const context: ProviderUsageContext = {
      mode: "cli",
      platform: {
        os: "linux",
        arch: "x64",
        wsl: false,
        bubblewrap: false,
        argvLimit: 120_000,
        home: "/home",
        path: [],
        pathExt: [],
      },
      env: {},
      appDataDir: "/home/.gemini/antigravity-cli",
      readSqliteGenMetadata: (file: string) =>
        file.includes("conv-init") ? [turnInit] : [turnInit, turnResume],
    };

    const stdoutInit = JSON.stringify({
      conversation_id: "conv-init",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 50,
        thinking_tokens: 10,
      },
    });

    const stdoutResume = JSON.stringify({
      conversation_id: "conv-resume",
      usage: {
        input_tokens: 250,
        output_tokens: 50,
        cache_read_tokens: 110,
        thinking_tokens: 25,
      },
    });

    const usageInit = agy.usage?.(stdoutInit, context);
    const usageResume = agy.usage?.(stdoutResume, context);

    f.deps.delegate = async (_provider, request) => {
      await Promise.resolve();
      const isResume = Boolean(request.resume);
      const usage = isResume ? usageResume : usageInit;

      const row = {
        provider: "agy" as const,
        model: usage?.actualModels?.[0] ?? request.model,
        effort:
          usage?.actualEffort === undefined
            ? request.effort
            : usage.actualEffort,
        mode: "cli" as const,
        launched: true,
        outcome: "ok",
        ...(isResume && { nudge: true as const }),
        ...(usage && { usage }),
      };

      request.onInvocation?.(row);

      return {
        outcome: {
          status: "ok",
          text: "answer",
          resume: null,
          sessionId: null,
        },
        invocations: [row],
      };
    };

    const observer = defined(
      observeTool(f.session, "ask", "run", undefined, f.deps)
    );

    const dir = path.join(f.session, "work");
    await observer.deps.delegate(
      "agy",
      {
        promptPath: "/p.md",
        model: "launch-m1",
        effort: "low",
        sandbox: false,
        schemaPath: null,
        resume: null,
        cwd: f.root,
        timeoutMs: 5000,
        outputCapBytes: 100,
        attachments: [],
        logPath: path.join(dir, "logs", "agy[0].log"),
        briefPath: "/b.md",
      },
      "cli"
    );
    await observer.deps.delegate(
      "agy",
      {
        promptPath: "/p.md",
        model: "launch-m2",
        effort: "low",
        sandbox: false,
        schemaPath: null,
        resume: "conv-1",
        cwd: f.root,
        timeoutMs: 5000,
        outputCapBytes: 100,
        attachments: [],
        logPath: path.join(dir, "logs", "agy[0].log"),
        briefPath: "/b.md",
      },
      "cli"
    );
    observer.finish({ ok: true, exit: 0, summary: "done", value: null });

    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
    const fold = { records: [], lastSeq: 0, torn: null } as Fold;
    const facts = sessionFacts(f.session, fold, "complete");
    assert.equal(facts.invocations.length, 2);

    const reportPath = writeDiagnostics(f.session, facts);
    const report = fs.readFileSync(reportPath, "utf-8");

    assert.match(report, /### Tokens by stage/u);
    assert.match(
      report,
      /^\| ask \| agy \| delegate \| gemini-4-argon \| medium \|/mu
    );
    assert.match(
      report,
      /^\| ask \| agy \| delegate \| gemini-3.8-flash \| high \|/mu
    );
    assert.doesNotMatch(report, /gemini-4-argon \(configured\)/u);
    assert.doesNotMatch(report, /gemini-3.8-flash \(configured\)/u);

    assert.doesNotMatch(report, /gemini-4-argon \(reported: gemini-4-argon\)/u);
  } finally {
    f.cleanup();
  }
});

test("coverage list: observeTool preserves coverage list for copilot", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill);
    writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
    f.deps.skillRoot = skill;
    f.deps.delegate = async (_provider, request) => {
      await Promise.resolve();

      const row = {
        provider: "copilot" as const,
        model: "auto",
        mode: "cli" as const,
        effort: null,
        launched: true,
        outcome: "ok",
        coverage: ["no usage" as const],
      };

      request.onInvocation?.(row);

      return {
        outcome: { status: "ok", text: "ok", resume: null, sessionId: null },
        invocations: [row],
      };
    };

    const observer = defined(
      observeTool(f.session, "ask", "run", undefined, f.deps)
    );

    await observer.deps.delegate(
      "copilot",
      {
        promptPath: "/p.md",
        model: "auto",
        effort: null,
        sandbox: false,
        schemaPath: null,
        resume: null,
        cwd: f.root,
        timeoutMs: 5000,
        outputCapBytes: 100,
        attachments: [],
        logPath: path.join(f.session, "work", "logs", "copilot[0].log"),
        briefPath: "/b.md",
      },
      "cli"
    );
    observer.finish({ ok: true, exit: 0, summary: "done", value: null });

    const facts = sessionFacts(
      f.session,
      { records: [], lastSeq: 0, torn: null },
      "complete"
    );

    assert.deepEqual(facts.invocations[0]?.coverage, ["no usage"]);
  } finally {
    f.cleanup();
  }
});

test("review timing joins current generation and reserve attempts", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill);
    writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
    f.deps.skillRoot = skill;
    saveRound({
      session: f.session,
      review: "plan-a",
      round: 1,
      generation: 2,
      roster: [
        rosterSlot("codex[0]", "codex"),
        rosterSlot("claude[0]", "claude", { reserve: true }),
      ],
      outcomes: [],
    });
    saveRound({
      session: f.session,
      review: "plan-a",
      round: 2,
      roster: [
        rosterSlot("codex[0]", "codex"),
        rosterSlot("native[0]", "native", { native: true }),
      ],
      outcomes: [],
    });
    // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
    f.deps.delegate = async () => ({
      outcome: { status: "ok", text: "ok", resume: null, sessionId: null },
      invocations: [
        {
          provider: "claude",
          model: "m",
          mode: "cli",
          effort: null,
          launched: true,
          outcome: "ok",
          startMs: 0,
          endMs: 30,
        },
        {
          provider: "claude",
          model: "m",
          mode: "cli",
          effort: null,
          launched: false,
          outcome: "launch-failed",
          startMs: 1,
          endMs: 99,
        },
      ],
    });

    const observer = defined(
      observeTool(f.session, "review", "run", "plan", f.deps)
    );

    const generation = path.join(
      f.session,
      ".state",
      "reviews",
      "plan-a",
      "round-1",
      "gen-2"
    );

    await observer.deps.delegate(
      "claude",
      delegateReq(path.join(generation, "logs", "claude[0].log"), "codex[0]"),
      "cli"
    );
    defined(defined(observer).deps.diagnostics)({
      kind: "routing",
      subject: generation,
      slot: "claude[0]",
      targetSlot: "codex[0]",
      attempt: 1,
      state: "reserve",
    });
    await observer.deps.delegate(
      "claude",
      delegateReq(
        path.join(
          f.session,
          ".state",
          "reviews",
          "plan-a",
          "round-1",
          "gen-1",
          "logs",
          "codex[0].log"
        )
      ),
      "cli"
    );
    defined(defined(observer).deps.diagnostics)({
      kind: "native",
      subject: path.join(
        f.session,
        ".state",
        "reviews",
        "plan-a",
        "round-1",
        "gen-1"
      ),
      slot: "codex[0]",
      provider: "native",
      attempt: 1,
      state: "failed",
    });
    await observer.deps.delegate(
      "claude",
      delegateReq(
        path.join(
          f.session,
          ".state",
          "reviews",
          "plan-a",
          "round-2",
          "gen-1",
          "logs",
          "codex[0].log"
        )
      ),
      "cli"
    );
    await observer.deps.delegate(
      "claude",
      delegateReq(
        path.join(
          f.session,
          ".state",
          "reviews",
          "plan-a",
          "round-2",
          "gen-1",
          "logs",
          "claude[0].log"
        ),
        "native[0]"
      ),
      "cli"
    );
    defined(defined(observer).deps.diagnostics)({
      kind: "native",
      subject: path.join(
        f.session,
        ".state",
        "reviews",
        "plan-a",
        "round-2",
        "gen-1"
      ),
      slot: "native[0]",
      provider: "native",
      attempt: 1,
      state: "failed",
    });
    observer.finish({ ok: true, exit: 0, summary: "done", value: null });

    const facts = sessionFacts(
      f.session,
      { records: [], lastSeq: 0, torn: null },
      "complete"
    );

    assert.deepEqual(facts.roundTiming?.[1]?.slots, [
      {
        slot: "codex[0]",
        attempts: [{ surface: "cli", startMs: 0, endMs: 30 }],
      },
      {
        slot: "native[0]",
        attempts: [
          { surface: "cli", startMs: 0, endMs: 30 },
          { surface: "native" },
        ],
      },
    ]);
    assert.deepEqual(facts.roundTiming?.[0]?.slots, [
      {
        slot: "codex[0]",
        attempts: [{ surface: "cli", startMs: 0, endMs: 30 }],
      },
    ]);
  } finally {
    f.cleanup();
  }
});

test("native substitution preserves the legacy gap and the measured CLI span", () => {
  const f = sessionFixture({ memory: true });

  try {
    const roster = [
      rosterSlot("codex[0]", "codex"),
      rosterSlot("claude[0]", "claude"),
    ];

    for (const [round, outcome] of [
      [
        1,
        {
          slot: "codex[0]",
          state: "done",
          responder: {
            slot: "native[0]",
            provider: "native",
            model: null,
            native: true,
          },
        },
      ],
      [2, { slot: "codex[0]", state: "native" }],
    ] as const) {
      saveRound({
        session: f.session,
        review: "plan-a",
        round,
        roster,
        outcomes: [outcome],
      });
    }

    captureRuns(
      f.session,
      [1, 2].flatMap((round) =>
        ["codex[0]", "claude[0]"].map((slot) => ({
          ...attempt(roundSubject(f.session, "plan-a", round), {
            slot,
            provider: "codex",
            model: "m",
            outcome: "timeout",
          }),
          startMs: 0,
          endMs: 1000,
        }))
      )
    );

    const facts = sessionFacts(
      f.session,
      { records: [], lastSeq: 0, torn: null },
      "complete"
    );

    for (const round of defined(facts.roundTiming)) {
      assert.deepEqual(defined(round.slots[0]).attempts, [
        { surface: "cli", startMs: 0, endMs: 1000 },
        { surface: "native" },
      ]);
    }

    const report = fs.readFileSync(writeDiagnostics(f.session, facts), "utf-8");
    assert.match(report, /codex\[0\] \| — \| —/u);
    assert.doesNotMatch(report, /✓/u);
    assert.match(
      report,
      /\| subject [a-f0-9]{16} \| 1\/2 \| 1s \(CLI only\) \|/u
    );
    assert.match(
      report,
      /\| subject [a-f0-9]{16} \| 2\/2 \| 1s \(CLI only\) \|/u
    );
  } finally {
    f.cleanup();
  }
});

test("failed native reserve remains unmeasured after terminal failure", () => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill);
    writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
    f.deps.skillRoot = skill;

    const roster = [
      rosterSlot("codex[0]", "codex"),
      rosterSlot("claude[0]", "claude"),
    ];

    saveRound({
      session: f.session,
      review: "plan-a",
      round: 1,
      roster,
      outcomes: [{ slot: "codex[0]", state: "failed", cls: "refusal" }],
    });
    const subject = roundSubject(f.session, "plan-a", 1);
    captureRuns(f.session, [
      {
        ...attempt(subject, {
          slot: "codex[0]",
          provider: "codex",
          model: "m",
          outcome: "timeout",
        }),
        startMs: 0,
        endMs: 1000,
      },
      {
        ...attempt(subject, {
          slot: "claude[0]",
          provider: "claude",
          model: "m",
        }),
        startMs: 0,
        endMs: 5000,
      },
    ]);

    const observer = defined(
      observeTool(f.session, "review", "run", "plan", f.deps)
    );

    defined(defined(observer).deps.diagnostics)({
      kind: "native",
      subject: path.join(
        f.session,
        ".state",
        "reviews",
        "plan-a",
        "round-1",
        "gen-1"
      ),
      slot: "codex[0]",
      provider: "native",
      attempt: 1,
      state: "failed",
    });
    observer.finish({ ok: true, exit: 0, summary: "done", value: null });

    const facts = sessionFacts(
      f.session,
      { records: [], lastSeq: 0, torn: null },
      "complete"
    );

    assert.deepEqual(facts.roundTiming?.[0]?.slots[0]?.attempts, [
      { surface: "cli", startMs: 0, endMs: 1000 },
      { surface: "native" },
    ]);
    const report = fs.readFileSync(writeDiagnostics(f.session, facts), "utf-8");
    assert.match(report, /codex\[0\] \| — \| —/u);
    assert.doesNotMatch(report, /✓/u);
    assert.match(
      report,
      /\| subject [a-f0-9]{16} \| 1\/1 \| 5s \(CLI only\) \|/u
    );
  } finally {
    f.cleanup();
  }
});

test("links a completed explicit selection to observed logical slot work", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    fs.mkdirSync(skill);
    writeJson(path.join(skill, "config.jsonc"), { diagnostics: true });
    f.deps.skillRoot = skill;
    const target = { base: "a".repeat(40), head: "b".repeat(40) };

    const actual = {
      review: "code-integration" as const,
      target,
      round: 2,
      generation: 1,
    };

    const recoverySelection = {
      review: actual.review,
      targetHash: recoveryTargetHash(target),
      round: 2,
      generation: 1,
    };

    const outcome = {
      ok: true,
      exit: 0,
      summary: "ok",
      value: { next: "review", reason: "round-pending" },
      recoverySelection,
    };

    const observer = defined(
      observeTool(f.session, "status", "show", undefined, f.deps)
    );

    const ref = observer.finish(outcome);
    assert.match(defined(ref), /^[0-9a-f-]{36}$/u);

    const review = defined(
      observeTool(f.session, "review", "run", "code", {
        ...f.deps,
        // oxlint-disable-next-line eslint/require-await -- type requires a Promise return; this mock has no awaitable work
        delegate: async () => ({
          outcome: {
            status: "ok",
            text: "complete",
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
        }),
      })
    );

    const subject = path.join(
      f.session,
      ".state",
      "reviews",
      "code-integration",
      "round-2",
      "gen-1"
    );

    assert.equal(
      defined(defined(review).deps.recovery)(
        ref,
        { ...actual, generation: 2 },
        subject
      ),
      undefined
    );
    assert.equal(
      defined(defined(review).deps.recovery)(
        ref,
        { ...actual, target: { ...target, head: target.base } },
        subject
      ),
      undefined
    );
    const directory = path.join(f.session, ".state", "diagnostics");

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const capture = JSON.parse(
      fs.readFileSync(path.join(directory, `${ref}.json`), "utf-8")
    );

    const incomplete = crypto.randomUUID();
    writeJson(path.join(directory, `${incomplete}.json`), {
      ...capture,
      capture: { state: "opened", start: 0 },
    });
    assert.equal(
      defined(defined(review).deps.recovery)(incomplete, actual, subject),
      undefined
    );

    const settled = defined(
      defined(defined(review).deps.recovery)(ref, actual, subject)
    );

    defined(defined(review).deps.diagnostics)({
      kind: "slot",
      subject,
      slot: "codex[0]",
      attempt: 1,
      state: "done",
      replay: true,
    });
    defined(defined(review).deps.diagnostics)({
      kind: "slot",
      subject,
      slot: "codex[0]",
      attempt: 2,
      state: "done",
      replay: true,
    });

    const ordinary = defined(
      observeTool(f.session, "review", "run", "code", f.deps)
    );

    defined(defined(ordinary).deps.diagnostics)({
      kind: "slot",
      subject,
      slot: "codex[0]",
      attempt: 2,
      state: "done",
      replay: true,
    });
    ordinary.finish({ ok: true, exit: 0, summary: "ok", value: {} });
    await review.deps.delegate(
      "claude",
      delegateReq(path.join(subject, "logs", "claude[1].log"), "opencode[0]"),
      "cli"
    );
    await review.deps.delegate(
      "claude",
      delegateReq(path.join(subject, "logs", "claude[2].log"), "opencode[0]"),
      "cli"
    );
    defined(defined(review).deps.diagnostics)({
      kind: "slot",
      subject,
      slot: "opencode[0]",
      attempt: 1,
      state: "done",
      replay: true,
    });
    settled([
      { slot: "codex[0]", state: "done" },
      { slot: "claude[0]", state: "native" },
      { slot: "opencode[0]", state: "done" },
    ]);
    review.finish({ ...outcome, ok: false, reason: "native-pending" });

    const facts = sessionFacts(
      f.session,
      { records: [], lastSeq: 0, torn: null },
      "complete"
    );

    assert.deepEqual(facts.recoveryExecutions, [
      { ref, reused: 1, launched: 1, unresolved: 1 },
    ]);
    assert.equal(facts.collection?.incomplete, 1);
  } finally {
    f.cleanup();
  }
});

test("status returns a recovery ref only after an enabled capture completes", async () => {
  const f = sessionFixture({ memory: true });

  try {
    const skill = path.join(f.root, "skill");
    const config = path.join(skill, "config.jsonc");

    const diagnosticDir = path.join(f.session, ".state", "diagnostics");
    const value = { next: "review", reason: "round-pending" };

    const recoverySelection = {
      review: "code-integration" as const,
      targetHash: "a".repeat(64),
      round: 1,
      generation: 1,
    };

    let result: unknown;

    const deps = {
      ...f.deps,
      skillRoot: skill,
      handler: () => ({
        ok: true,
        summary: JSON.stringify(value),
        exit: 0,
        value,
        recoverySelection,
      }),
      writeResult: (
        _session: string,
        _tool: string,
        _action: string,
        payload: unknown
      ) => {
        result = payload;

        return path.join(f.session, "result.json");
      },
    };

    const run = async () =>
      await main(
        ["status", "show", "--resume", "--session", f.session],
        // SAFETY: deps spreads the live CliDeps fixture, so the unknown step preserves the CliDeps shape.
        //oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- CliDeps is reachable only through unknown; the direct assertion lacks overlap; test restores the static fixture type the double was built with; the runtime shape is asserted below
        deps as unknown as CliDeps
      );

    writeJson(config, { diagnostics: false });
    assert.equal(await run(), 0);
    assert.deepEqual(result, value);
    assert.equal(fs.existsSync(diagnosticDir), false);

    writeJson(config, { diagnostics: true });
    fs.mkdirSync(path.dirname(diagnosticDir), { recursive: true });
    fs.writeFileSync(diagnosticDir, "occupied");
    assert.equal(await run(), 0);
    assert.deepEqual(result, value);

    fs.unlinkSync(diagnosticDir);
    assert.equal(await run(), 0);
    const { resumeRef } = narrow(result, withFields({ resumeRef: text }));

    // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
    const capture = JSON.parse(
      fs.readFileSync(path.join(diagnosticDir, `${resumeRef}.json`), "utf-8")
    );

    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.deepEqual(capture.recoverySelection, recoverySelection);
    // eslint-disable-next-line typescript/no-unsafe-member-access -- test reads the untyped JSON/fixture surface under assertion; narrowing would not change assertions
    assert.equal(capture.capture.state, "completed");
    assert.deepEqual(result, { ...value, resumeRef });
  } finally {
    f.cleanup();
  }
});
