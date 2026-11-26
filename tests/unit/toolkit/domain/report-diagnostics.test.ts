import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resolvePricing } from "../../../../skills/dispatch/scripts/lib/pricing.ts";
import { readHostUsage } from "../../../../skills/dispatch/scripts/lib/usage/index.ts";
import { TOOL_ACTIONS } from "../../../../skills/dispatch/scripts/toolkit/cli.ts";
import {
  CATEGORIES,
  COMPONENTS,
  DIAGNOSTIC_LIMITS,
  formatDuration,
  heuristics,
  normalizeUsage,
  renderDiagnostics,
  retroObservations,
  sanitizeFacts,
} from "../../../../skills/dispatch/scripts/toolkit/domain/diagnostics.ts";
import type {
  Finding,
  InvocationFacts,
  RunFacts,
  Usage,
} from "../../../../skills/dispatch/scripts/toolkit/domain/diagnostics.ts";
import { defined } from "../../../helpers/guards.ts";
import { jsonObject, narrow } from "../helpers/json.ts";
import type { JsonObject } from "../helpers/json.ts";

const SKILL_ROOT = fileURLToPath(
  new URL("../../../../skills/dispatch/", import.meta.url)
);

// SAFETY: fixture defaults and overrides describe a complete shape; undefined overrides are omitted at runtime.
const invocation = (overrides: Partial<InvocationFacts> = {}) =>
  ({
    phase: "review",
    provider: "codex",
    model: "gpt-6-sol",
    effort: "medium",
    mode: "cli",
    surface: "cli",
    launched: true,
    durationMs: 60_000,
    outcome: "ok",
    usage: { input: 1000, cacheRead: 2000, cacheWrite: 300, output: 40 },
    ...overrides,
    // SAFETY: fixture defaults and overrides describe a complete shape; undefined overrides are omitted at runtime.
  }) as InvocationFacts;

const bare = (overrides: Partial<InvocationFacts> = {}) => {
  const { usage: _usage, ...rest } = invocation(overrides);

  return rest;
};

// SAFETY: fixture defaults and overrides describe a complete shape; undefined overrides are omitted at runtime.
const facts = (overrides: Partial<RunFacts> = {}) =>
  ({
    version: "0.7.1",
    build: "ab".repeat(32),
    os: "windows",
    host: "claude",
    verb: "review",
    level: "medium",
    outcome: "complete",
    phases: [
      {
        key: "review",
        name: "code review",
        outcome: "complete",
        wallMs: 3_723_000,
        driverMs: 45_000,
        hostMs: 60_000,
        userMs: 400,
      },
    ],
    invocations: [invocation()],
    reviews: [],
    ...overrides,
    // SAFETY: fixture defaults and overrides describe a complete shape; undefined overrides are omitted at runtime.
  }) as RunFacts;

const observation = (overrides: JsonObject = {}) => ({
  id: "o1",
  component: "scripts/toolkit/records.ts",
  category: "instruction-clarity",
  evidence: "The `rule` frame reply template omits the allowed verdict values.",
  impact: "Hosts send invalid rulings and need a second turn.",
  proposedFix:
    "List the verdict values in the reply template and check them in validate.",
  ...overrides,
});

const render = (runs: RunFacts[]) => renderDiagnostics(runs).text;

const only = (findings: readonly Finding[], source: string) =>
  findings.filter((f) => f.source === source);

const assertStructure = (
  finding: Finding | undefined,
  category: keyof typeof CATEGORIES
) => {
  assert.ok(finding, "finding expected");
  assert.equal(finding.category, category);
  assert.ok(
    COMPONENTS.has(finding.component),
    `dispatch component: ${finding.component}`
  );

  for (const field of [finding.evidence, finding.impact, finding.proposedFix]) {
    assert.ok(field.trim().length > 0);
  }

  return finding;
};

const rejections = (tool: string, action: string, cls: string, count = 2) =>
  Array.from({ length: count }, () => ({ tool, action, cls }));

const h8 = (rejectedTools: NonNullable<RunFacts["rejectedTools"]>) =>
  only(heuristics(facts({ rejectedTools })), "H8");

const LEAKS = [
  "see /home/alice/repo/src/app.ts",
  "at ~/work/app",
  String.raw`path C:\Users\alice\repo`,
  "path d:/work/repo",
  String.raw`share \\server\team\x`,
  "docs at https://intranet.example/x",
  "host www.example.org",
  "host build.example.com",
  "mail alice@example.com",
  "session 123e4567-e89b-12d3-a456-426614174000",
  `hash ${"a1".repeat(20)}`,
];

const CLEAN =
  "The `/dispatch review` frame in scripts/toolkit/records.ts mixes input/output fields in config.local.jsonc.";

test("diagnostics config renders utility-subagents and redacts read-command locators", () => {
  const config = {
    "utility-subagents": {
      codex: { model: "gpt-6-luna", effort: "low", "context-limit": 300_000 },
    },
  };

  const sanitized = sanitizeFacts(facts({ config }));
  assert.deepEqual(
    sanitized.config?.["utility-subagents"],
    config["utility-subagents"]
  );
  const text = render([facts({ config })]);
  assert.match(text, /"utility-subagents": \{/u);
  assert.match(text, /"effort": "low"/u);

  const redacted = sanitizeFacts(
    facts({
      config: {
        "read-commands": [
          "codegraph explore",
          "tool /home/me/x",
          "tool https://x.io",
        ],
      },
    })
  );

  assert.deepEqual(redacted.config?.["read-commands"], [
    "codegraph explore",
    "—",
    "—",
  ]);
});

test("pricing override snapshot keeps dotted ids and provider wildcards and drops unsafe keys and invalid entries", () => {
  const entry = {
    rates: { input: 1, output: 5, cacheRead: 0.05 },
    tiers: [
      {
        abovePromptTokens: 272_000,
        rates: { input: 2, output: 7.5, cacheRead: 0.1 },
      },
    ],
  };

  const zero = { rates: { input: 0, output: 0 } };

  const pricing = {
    "gpt-6.1-terra": entry,
    "lmstudio/*": zero,
    "bedrock.claude-opus-5-5": zero,
    "build.example.com": zero,
    "C:\\canary": zero,
    "bad-rate": { rates: { input: -1, output: 1 } },
    "bad-withFields": "x",
    "Upper/*": zero,
  };

  const clean = sanitizeFacts(facts({ config: { pricing } })).config?.[
    "pricing"
  ];

  assert.deepEqual(clean, {
    "gpt-6.1-terra": entry,
    "lmstudio/*": zero,
    "bedrock.claude-opus-5-5": zero,
  });
  assert.deepEqual(
    sanitizeFacts(facts({ config: { pricing: "cheap" } })).config?.["pricing"],
    {}
  );

  const many = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`model-${i}`, zero])
  );

  assert.equal(
    Object.keys(
      narrow(
        sanitizeFacts(facts({ config: { pricing: many } })).config?.["pricing"],
        jsonObject
      )
    ).length,
    32
  );
  const text = render([facts({ config: { pricing } })]);
  assert.ok(
    text.includes('"gpt-6.1-terra"') &&
      text.includes('"lmstudio/*"') &&
      text.includes('"abovePromptTokens": 272000'),
    text
  );
  assert.ok(!text.includes("build.example.com") && !text.includes("canary"));
});

test("diagnostics render one subject per phase cell and bound observed collection coverage", () => {
  const subject = "1234567890abcdef";
  const generations = ["1111222233334444", "aaaabbbbccccdddd"];

  const text = render([
    facts({
      phases: [{ key: `review-${subject}`, name: "code review" }],
      invocations: [
        invocation({
          phase: `review-${subject}`,
          subject: defined(generations[0]),
          attempt: 1,
          slot: "codex[0]",
        }),
        invocation({
          phase: `review-${subject}`,
          subject: defined(generations[0]),
          attempt: 2,
          slot: "codex[0]",
        }),
        invocation({
          phase: `review-${subject}`,
          subject: defined(generations[1]),
          attempt: 1,
          slot: "codex[0]",
        }),
      ],
    }),
  ]);

  for (const line of text
    .split("\n")
    // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
    .filter((line) => line.startsWith("|") && line.includes("subject"))) {
    assert.equal(line.match(/subject /gu)?.length, 1, line);
  }

  for (const identity of [
    `${generations[0]}/1`,
    `${generations[0]}/2`,
    `${generations[1]}/1`,
  ]) {
    assert.ok(
      text.includes(`subject ${subject} · attempt ${identity} · slot codex[0]`),
      identity
    );
  }

  const ask = render([
    facts({
      phases: [{ key: "ask", name: "ask" }],
      invocations: [
        invocation({
          phase: "ask",
          subject: defined(generations[0]),
          attempt: 3,
          slot: "codex[0]",
        }),
      ],
    }),
  ]);

  assert.ok(
    ask.includes(`ask · subject ${generations[0]} · attempt 3 · slot codex[0]`)
  );
  assert.match(text, /storage loss are unobservable/u);
  assert.equal(
    sanitizeFacts(facts({ collection: { completed: 9_000_000 } })).collection
      ?.completed,
    1_000_000
  );
});

test("diagnostics distinguish invalid retro native completion and unavailable coverage", () => {
  for (const observations of [{}, null, "bad"]) {
    assert.equal(
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
      (retroObservations(observations) as { state?: string }).state,
      "invalid"
    );
    assert.match(render([facts({ observations })]), /Host retro: invalid/u);
  }

  assert.match(render([facts({ observations: [] })]), /Host retro: empty/u);

  for (const retroState of ["missing", "malformed", "unreadable"] as const) {
    assert.match(
      render([facts({ retroState })]),
      new RegExp(`Host retro: ${retroState}`, "u")
    );
  }

  const text = render([
    facts({
      invocations: [
        bare({
          surface: "native",
          launched: false,
          nativeState: "completed",
          outcome: "ok",
          subject: "a".repeat(16),
          attempt: 0,
        }),
        bare({
          surface: "native",
          launched: false,
          nativeState: "pending",
          outcome: "native-pending",
          attempt: 0,
        }),
      ],
    }),
  ]);

  assert.match(text, /native completed/u);
  assert.match(text, /native pending/u);
  assert.doesNotMatch(text, /attempt 0\b|\/0\b/u);
  assert.doesNotMatch(text, /ok \(not launched\)/u);
  assert.doesNotMatch(text, /native (?:completed|pending) \(not launched\)/u);
  assert.match(text, /\| CLI delegates \|[^|]+\| — \| — \|/u);
  assert.match(
    render([
      facts({ invocations: [invocation({ usage: { input: 0, output: 0 } })] }),
    ]),
    /\| CLI delegates \|[^|]+\| — \| 0 \|/u
  );

  const semantic = render([
    facts({
      invocations: [
        invocation({ slot: "codex[0]", validationOutcome: "schema" }),
        invocation({ slot: "codex[0]", validationOutcome: "schema" }),
      ],
    }),
  ]);

  assert.match(semantic, /`schema`: 2 of 2 CLI attempts failed/u);
  assert.match(semantic, /ok · validation schema/u);
});

test("diagnostics render collection health and provenance within privacy limits", () => {
  const text = render([
    facts({
      collection: { corrupt: 2, incomplete: 1, storageFailed: 1 },
      provenance: [
        {
          version: "1.2.3",
          build: "ab".repeat(32),
          config: {
            diagnostics: true,
            "api-key": "secret-canary",
            "read-delegates": { codex: { model: "/home/canary/model" } },
          },
        },
      ],
    }),
  ]);

  assert.match(text, /Collection health: partial/u);
  assert.match(text, /corrupt 2/u);
  assert.match(text, /incomplete 1/u);
  assert.match(text, /storage-failed 1/u);
  assert.match(text, /dispatch 1\.2\.3 · build abababababab/u);
  assert.match(text, /storage loss are unobservable/u);
  assert.doesNotMatch(text, /canary|api-key|secret/u);
  assert.ok(Buffer.byteLength(text) <= DIAGNOSTIC_LIMITS.reportBytes);
});

test("diagnostics report: renders summary shell with sections, version, and durations", () => {
  const text = render([facts()]);

  const at = [
    "## Summary",
    "### Spend & Turns by Role",
    "### Spend & Turns by Stage",
    "## Cost drivers",
    "## Findings",
    "<details>",
  ].map((marker) => text.indexOf(marker));

  assert.ok(
    at.every((index) => index >= 0),
    `all sections present: ${at.join(",")}`
  );
  assert.deepEqual(
    [...at].toSorted((a, b) => a - b),
    at
  );
  assert.match(text, /^- Build: dispatch 0\.7\.1 · build abababababab$/mu);
  const { version: _version, ...rest } = facts();
  assert.match(
    render([{ ...rest, build: "not-a-hash" }]),
    /^- Build: dispatch — · build —$/mu
  );
  assert.equal(formatDuration(3_723_000), "1h 2m 3s");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(400), "<1s");
  assert.equal(formatDuration(undefined), "—");
});

test("diagnostics report: renders duration, token, and estimate columns with unavailable handling", () => {
  const text = render([facts()]);
  assert.match(
    text,
    /\| Phase \| Outcome \| Wall \| Driver \| Host \| User wait \|/u
  );
  assert.ok(
    text.includes(
      "| code review · review | complete | 1h 2m 3s | 45s | 1m 0s | <1s | 1 |"
    ),
    text
  );
  assert.match(
    text,
    /^- Runs: 1 · Host: claude · OS: windows · Measured duration: 1h 2m 3s$/mu
  );
  assert.match(text, /\| Input \| Cache read \| Cache write \| Output \|/u);
  assert.ok(text.includes("| 1 | 1,000 | 2,000 | 300 | 40 | 1/1 |"), text);
  assert.ok(
    text.includes("| CLI delegates | ██████████ 100% | — | 3,340 | 61% |"),
    text
  );

  const partial = render([
    facts({
      phases: [
        {
          key: "review",
          name: "code review",
          outcome: "complete",
          wallMs: 3_723_000,
        },
      ],
      invocations: [
        invocation({ usage: { input: 500, output: 20 } }),
        bare({
          provider: "claude",
          model: "claude-opus-5-5",
          outcome: "timeout",
        }),
      ],
    }),
  ]);

  assert.ok(
    partial.includes(
      "| code review · review | complete | 1h 2m 3s | 2 | 500 | — | — | 20 | 1/2 |"
    ),
    partial
  );
  assert.ok(
    partial.includes(
      "| code review | claude | delegate | claude-opus-5-5 (configured) | medium | — | — | — | — | — | 0/1 | — | — |"
    ),
    partial
  );

  const legacy = render([
    sanitizeFacts({
      ...facts(),
      invocations: [
        { ...invocation(), estimated: true, tokens: 5000 },
        {
          ...bare({
            surface: "native",
            provider: "claude",
            model: "claude-opus-5-5",
            mode: "native",
          }),
          estimated: true,
          tokens: 5000,
        },
      ],
    }),
  ]);

  assert.ok(
    legacy.includes("| CLI delegates | ██████████ 100% | — | 3,340 | 61% |"),
    legacy
  );
  assert.doesNotMatch(legacy, /Estimated, excluded from measured totals/u);
  assert.doesNotMatch(legacy, /~5,000/u);
  assert.ok(legacy.includes("| 2 | 1,000 | 2,000 | 300 | 40 | 1/1 |"), legacy);
});

test("elapsed waits and partial usage remain explicit", () => {
  const usage = normalizeUsage(
    { input: 3000, cacheRead: 2000, output: 40, reasoning: 20 },
    "includes-cache"
  );

  assert.ok(usage);

  const run = facts({
    invocations: [
      invocation({ usage }),
      bare({ provider: "claude", outcome: "timeout" }),
      bare({ surface: "native", mode: "native" }),
    ],
  });

  const text = render([run]);
  assert.match(
    text,
    /\| codex \| 1,000 \| 2,000 \| — \| 40 \| 20 \| delegates 1\/1 \|/u
  );
  assert.match(text, /Full conversation totals unavailable/u);

  assert.ok(
    text.includes("| — | native completed |"),
    "unattested native usage stays unavailable"
  );

  const quota = defined(
    only(
      heuristics(
        facts({
          invocations: [
            invocation({ outcome: "quota" }),
            invocation({ outcome: "quota" }),
          ],
        })
      ),
      "H1"
    )[0]
  );

  assert.match(
    quota.proposedFix,
    /Reorder or remove the exhausted model alias, or check its quota/u
  );
  assert.doesNotMatch(quota.proposedFix, /add another model alias/u);
  assert.doesNotMatch(quota.proposedFix, /each model has its own quota/u);
});

test("H8 names the handling module of repeated rejections and ignores one-offs", () => {
  const verify = assertStructure(
    h8(rejections("check", "run", "invalid-input"))[0],
    "correctness"
  );

  assert.equal(verify.component, "scripts/toolkit/check.ts");
  assert.match(
    verify.evidence,
    /2 toolkit operations rejected \(check run: invalid-input ×2\)/u
  );

  const unknown = assertStructure(
    h8(rejections("record", "append", "invalid-record"))[0],
    "correctness"
  );

  assert.equal(unknown.component, "scripts/toolkit/cli.ts");
  assert.match(unknown.evidence, /record append: invalid-record ×2/u);

  const grouped = h8([
    ...rejections("ledger", "append", "approval-stale"),
    ...rejections("ledger", "query", "invalid-input"),
    ...rejections("worktree", "create", "invalid-input"),
  ]);

  assert.deepEqual(grouped.map((item) => item.component).toSorted(), [
    "scripts/toolkit/ledger.ts",
    "scripts/toolkit/writers.ts",
  ]);
  assert.match(
    defined(
      grouped.find((item) => item.component === "scripts/toolkit/ledger.ts")
    ).evidence,
    /4 toolkit operations rejected \(ledger append: approval-stale ×2, ledger query: invalid-input ×2\)/u
  );

  for (const name of TOOL_ACTIONS) {
    const [tool = "", action = ""] = name.split(" ");

    const finding = assertStructure(
      h8(rejections(tool, action, "invalid-input"))[0],
      "correctness"
    );

    assert.notEqual(
      finding.component,
      "scripts/toolkit/cli.ts",
      `${name} has a module`
    );
  }

  assert.deepEqual(h8(rejections("check", "run", "invalid-input", 1)), []);
  assert.deepEqual(
    h8([
      ...rejections("check", "run", "invalid-input", 1),
      ...rejections("check", "run", "user-only", 1),
    ]),
    []
  );
  assert.deepEqual(
    h8([
      ...rejections("ledger", "append", "key-conflict", 1),
      ...rejections("ledger", "query", "key-conflict", 1),
    ]),
    []
  );

  const [mixed] = h8([
    ...rejections("check", "run", "invalid-input"),
    ...rejections("check", "run", "user-only", 1),
  ]);

  assert.match(
    defined(mixed).evidence,
    /2 toolkit operations rejected \(check run: invalid-input ×2\)/u
  );
});

test("diagnostics report: orders findings by severity", () => {
  const run = facts({
    invocations: [
      invocation({ outcome: "quota" }),
      invocation({ outcome: "quota" }),
      invocation({ usage: { input: 9000, cacheRead: 100, output: 0 } }),
    ],
    reviews: [1, 2, 3].map((round) => ({
      phase: "review",
      round,
      accepted: 1,
      rejected: 0,
      cap: 3,
      ...(round === 3 && { reraised: ["R1-F001"] }),
    })),
    observations: [observation()],
  });

  const order = Object.keys(CATEGORIES);
  const categories = heuristics(run).map((f) => order.indexOf(f.category));
  assert.deepEqual(
    [...categories].toSorted((a, b) => a - b),
    categories
  );

  const headings = [
    ...render([run]).matchAll(/^### \d+\. (?<g1>[^·]+) ·/gmu),
  ].map((m) => defined(m[1]).trim());

  assert.deepEqual(
    [...new Set(headings)],
    [
      "Correctness / protocol",
      "Token economy",
      "Review convergence",
      "Instruction clarity",
    ]
  );
});

const run = (provider: string, usage: Usage | undefined) =>
  facts({ invocations: [invocation({ provider, ...(usage && { usage }) })] });

const measuredLine = (text: string) =>
  /^- Provider CLI measured tokens: .*$/mu.exec(text)?.[0];

test("diagnostics report: equivalent codex and claude usage yield equal totals and heuristics", () => {
  const codex = normalizeUsage(
    { input: 1000, cacheRead: 300, cacheWrite: 0, output: 50 },
    "includes-cache"
  );

  const claude = normalizeUsage(
    { input: 700, cacheRead: 300, cacheWrite: 0, output: 50 },
    "uncached"
  );

  assert.deepEqual(codex, {
    input: 700,
    cacheRead: 300,
    cacheWrite: 0,
    output: 50,
  });
  assert.deepEqual(codex, claude);

  const [a, b] = [
    heuristics(run("codex", codex)),
    heuristics(run("claude", claude)),
  ];

  assert.deepEqual(
    a.map((f) => [f.source, f.category, f.evidence.replace("codex", "P")]),
    b.map((f) => [f.source, f.category, f.evidence.replace("claude", "P")])
  );
  assert.deepEqual(
    a.map((f) => f.source),
    ["H4"]
  );

  assert.equal(
    measuredLine(render([run("codex", codex)])),
    measuredLine(render([run("claude", claude)]))
  );
  assert.equal(
    normalizeUsage({ input: 100, cacheRead: 300, output: 1 }, "includes-cache")
      ?.input,
    0
  );
});

test("diagnostics report: renders per-model token rows across launch states", () => {
  const split = render([
    facts({
      invocations: [
        invocation({
          provider: "claude",
          model: "claude-opus-5-5",
          reportedModels: ["claude-opus-5-5", "claude-haiku-5"],
          usage: {
            input: 150,
            output: 15,
            models: {
              "claude-opus-5-5": { input: 100, output: 10 },
              "claude-haiku-5": { input: 50, output: 5 },
            },
          },
        }),
      ],
    }),
  ]);

  assert.ok(
    split.includes(
      "| code review | claude | delegate | claude-haiku-5 | medium | 50 | — | — | 5 | — | 1/1 |"
    ),
    split
  );
  assert.ok(
    split.includes(
      "| code review | claude | delegate | claude-opus-5-5 | medium | 100 | — | — | 10 | — | 1/1 |"
    ),
    split
  );
  assert.doesNotMatch(split, /\(configured\)/u);

  const mixed = render([
    facts({
      invocations: [
        invocation({
          provider: "claude",
          model: "claude-opus-5-5",
          usage: {
            input: 100,
            output: 10,
            models: { "claude-opus-5-5": { input: 100, output: 10 } },
          },
        }),
        bare({
          provider: "claude",
          model: "claude-opus-5-5",
          outcome: "timeout",
        }),
      ],
    }),
  ]);

  assert.ok(
    mixed.includes(
      "| code review | claude | delegate | claude-opus-5-5 | medium | 100 | — | — | 10 | — | 1/1 |"
    ),
    mixed
  );

  const table = defined(
    defined(mixed.split("### Tokens by stage")[1]).split("</details>")[0]
  );

  assert.equal((table.match(/claude-opus-5-5/gu) ?? []).length, 2);

  const configured = render([
    facts({
      invocations: [
        invocation({
          reportedModels: ["gpt-6-sol-2026"],
          usage: { input: 100, output: 10 },
        }),
      ],
    }),
  ]);

  assert.ok(
    configured.includes(
      "| code review | codex | delegate | gpt-6-sol-2026 | medium | 100 | — | — | 10 | — | 1/1 |"
    ),
    configured
  );
  assert.ok(
    configured.includes("gpt-6-sol (reported: gpt-6-sol-2026)"),
    configured
  );

  const multi = render([
    facts({
      invocations: [
        invocation({
          provider: "claude",
          model: "claude-opus-5-5",
          reportedModels: ["claude-opus-5-5", "claude-haiku-5"],
          usage: { input: 100, output: 10 },
        }),
      ],
    }),
  ]);

  assert.ok(
    multi.includes(
      "| code review | claude | delegate | — | medium | 100 | — | — | 10 | — | 1/1 |"
    ),
    multi
  );
  assert.doesNotMatch(multi, /\(configured\)/u);
});

test("retro observations: validates ids, components, categories, content, and size", () => {
  const ids = Array.from({ length: 21 }, (_, i) => `o${i + 1}`);
  const result = retroObservations(ids.map((id) => observation({ id })));
  assert.deepEqual(
    result.values.map((v) => v.id),
    ids.slice(0, 20)
  );
  assert.equal(result.rejected, 1);
  assert.deepEqual(retroObservations([]), {
    state: "empty",
    values: [],
    rejected: 0,
  });

  for (const component of [
    "src/app.ts",
    "core/frame.ts",
    "../dispatch/scripts/toolkit/records.ts",
    "skills/dispatch-plan/SKILL.md",
    "README.md",
  ]) {
    assert.deepEqual(
      retroObservations([observation({ component })]),
      { state: "collected", values: [], rejected: 1 },
      component
    );
  }

  assert.equal(
    retroObservations([
      observation({ component: "skills/dispatch/scripts/toolkit/records.ts" }),
    ]).values[0]?.component,
    "scripts/toolkit/records.ts"
  );

  const shipped = [
    "SKILL.md",
    ...["scripts", "references"].flatMap((dir) =>
      fs
        .readdirSync(path.join(SKILL_ROOT, dir), { recursive: true })
        .map((entry) => path.join(dir, String(entry)))
        .filter((file) => fs.statSync(path.join(SKILL_ROOT, file)).isFile())
        .map((file) => file.split(path.sep).join("/"))
    ),
  ];

  assert.deepEqual([...COMPONENTS].toSorted(), shipped.toSorted());

  for (const component of shipped) {
    assert.equal(
      retroObservations([observation({ component })]).values.length,
      1,
      component
    );
  }

  assert.equal(
    retroObservations([observation({ component: "scripts/toolkit/cli.ts" })])
      .values.length,
    1
  );
  assert.equal(
    retroObservations([
      observation({ component: "scripts/toolkit/review-identity.ts" }),
    ]).values[0]?.component,
    "scripts/toolkit/review-identity.ts"
  );
  assert.equal(
    retroObservations([
      observation({ component: "references/templates/writer-brief.md" }),
    ]).values.length,
    1
  );

  for (const category of ["vibes", "driver protocol", "", undefined]) {
    assert.equal(
      retroObservations([observation({ category })]).rejected,
      1,
      String(category)
    );
  }

  for (const category of [...Object.keys(CATEGORIES), "Token economy"]) {
    assert.equal(
      retroObservations([observation({ category })]).values.length,
      1,
      category
    );
  }

  for (const id of ["", "bad id", "x".repeat(49), "a/b", 7]) {
    assert.equal(
      retroObservations([observation({ id })]).rejected,
      1,
      String(id)
    );
  }

  assert.deepEqual(
    retroObservations([observation({ id: "dup" }), observation({ id: "dup" })])
      .rejected,
    1
  );

  for (const field of ["evidence", "impact", "proposedFix"] as const) {
    for (const leak of LEAKS) {
      assert.equal(
        retroObservations([observation({ [field]: leak })]).rejected,
        1,
        `${field}: ${leak}`
      );
    }

    assert.equal(
      retroObservations([observation({ [field]: CLEAN })]).values[0]?.[field],
      CLEAN
    );
  }

  assert.equal(
    retroObservations([observation({ evidence: "z".repeat(512) })]).values
      .length,
    1
  );

  for (const evidence of ["z".repeat(513), "é".repeat(257), "   ", 42]) {
    assert.equal(
      retroObservations([observation({ evidence })]).rejected,
      1,
      String(evidence).slice(0, 8)
    );
  }
});

test("retro observations: sanitizes model and config facts", () => {
  const raw = facts({
    config: {
      diagnostics: true,
      "write-concurrency": 2,
      "api-key": "secret-canary",
      "read-delegates": {
        codex: {
          sandbox: true,
          targets: [{ low: { model: "gpt-6-sol", effort: "medium" } }],
        },
      },
      "write-subagents": { claude: { low: { model: "/opt/models/private" } } },
    },
    invocations: [
      invocation({
        model: String.raw`C:\models\private`,
        provider: "Codex Cloud",
        effort: "h i g h",
        reportedModels: [
          "gpt-6-sol-2026",
          "https://host/model",
          "user@example.com",
        ],
      }),
      invocation({
        model: "opencode-go/glm-5.3-flash",
        provider: "opencode",
        effort: "max",
      }),
    ],
  });

  const clean = sanitizeFacts({
    ...raw,
    invocations: [
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
      {
        ...defined(raw.invocations[0]),
        resume: "resume-canary",
      } as InvocationFacts,
      defined(raw.invocations[1]),
    ],
  });

  assert.deepEqual(clean.config, {
    diagnostics: true,
    "write-concurrency": 2,
    "read-delegates": {
      codex: {
        sandbox: true,
        targets: [{ low: { model: "gpt-6-sol", effort: "medium" } }],
      },
    },
    "write-subagents": { claude: { low: { model: "—" } } },
  });
  const [bad, good] = clean.invocations;
  assert.deepEqual(
    [bad?.model, bad?.provider, bad?.effort, bad?.reportedModels],
    ["—", "—", "—", ["gpt-6-sol-2026"]]
  );
  assert.deepEqual(
    [good?.model, good?.provider, good?.effort],
    ["opencode-go/glm-5.3-flash", "opencode", "max"]
  );
  assert.ok(!("resume" in defined(bad)));
});

test("retro observations: rejects locators in ids models and config", () => {
  for (const locator of [
    "123e4567-e89b-12d3-a456-426614174000",
    "build.example.com",
  ]) {
    const text = render([
      facts({
        config: {
          "read-delegates": {
            codex: { targets: [{ low: { model: locator } }] },
            [locator]: { model: "gpt-6-sol" },
          },
        },
        invocations: [
          invocation({
            model: locator,
            reportedModels: [locator, "gpt-6-sol"],
            usage: {
              input: 10,
              output: 1,
              models: { [locator]: { input: 10, output: 1 } },
            },
          }),
        ],
        reviews: [
          {
            phase: "review",
            round: 1,
            accepted: 1,
            rejected: 0,
            reraised: [locator, "R1-F001"],
            escalation: { kind: "deadlock", ids: [locator] },
          },
        ],
        observations: [observation({ id: locator })],
      }),
    ]);

    assert.ok(!text.includes(locator), `${locator} withheld:\n${text}`);
    assert.match(
      text,
      /- Host retro: collected · 0 accepted · 1 rejected/u,
      "observation id"
    );
    assert.match(
      text,
      /code review: 1 round; 1 finding re-raised across rounds \(R1-F001\); deadlock escalation\./u,
      "review ids"
    );
    assert.ok(
      text.includes("— (reported: gpt-6-sol)"),
      "model and reported-model keys"
    );
    assert.ok(
      text.includes(
        "| code review | codex | delegate | — | medium | 10 | — | — | 1 | — | 1/1 |"
      ),
      "usage.models keys drop the per-model split"
    );
    assert.ok(text.includes('"model": "—"'), "config strings");
  }

  const names = [
    "gemini-3.8-flash",
    "gpt-6.1-sol",
    "opencode-go/muse-spark-1.3-contributor",
    "claude-opus-5-5",
  ];

  const text = render([
    facts({
      config: {
        "read-delegates": {
          codex: { targets: names.map((model) => ({ low: { model } })) },
        },
      },
      invocations: names.map((model) =>
        invocation({
          model,
          reportedModels: [model],
          usage: {
            input: 10,
            output: 1,
            models: { [model]: { input: 10, output: 1 } },
          },
        })
      ),
    }),
  ]);

  for (const name of names) {
    assert.doesNotMatch(
      text,
      new RegExp(`\\| ${name} \\(reported: ${name}\\) \\|`, "u")
    );
    assert.ok(
      text.includes(
        `| code review | codex | delegate | ${name} | medium | 10 |`
      ),
      `usage key ${name}`
    );
    assert.ok(text.includes(`"model": "${name}"`), `config ${name}`);
  }
});

test("diagnostics report: never renders resume objective or absolute paths", () => {
  // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
  const run = sanitizeFacts({
    ...facts(),
    objective: "objective-canary",
    argument: "argument-canary",
    sessionPath: "C:/sessions/canary",
    version: "/opt/canary",
    config: {
      diagnostics: true,
      "canary-key": "value",
      phases: { "plan-review": { only: [String.raw`C:\canary`] } },
    },
    pins: "/home/canary",
    fault: {
      cls: "timeout",
      effectId: "C:/canary/effect",
      detail: "canary detail",
    },
    phases: [
      {
        key: "review",
        name: "canary phase",
        outcome: "complete",
        wallMs: 1000,
      },
    ],
    hostGaps: [{ await: "/canary", ms: 1000 }],
    invocations: [
      {
        ...invocation({
          model: "/Users/canary/model",
          reportedModels: ["C:/canary"],
        }),
        resume: "resume-canary",
        sessionId: "canary-session",
        stdoutPath: "C:/canary/out",
      },
    ],
    reviews: [
      {
        phase: "review",
        round: 1,
        reraised: ["C:/canary", "F1"],
        escalation: { kind: "deadlock", ids: ["/home/canary"] },
        accepted: 0,
        rejected: 1,
      },
    ],
    rejectedEvents: [
      { eventType: "RULINGS", reason: "bad path /Users/canary/repo/file.ts" },
      { eventType: "canary", reason: "ok" },
    ],
    observations: [
      observation({ evidence: "canary at /home/canary/x" }),
      observation({ id: "o2", component: "canary.ts" }),
      { ...observation({ id: "o3" }), extra: "canary-extra" },
    ],
  });

  const { text } = renderDiagnostics([run]);
  assert.doesNotMatch(text, /canary/iu);
  assert.doesNotMatch(text, /host event/u);
  assert.match(text, /- Host retro: collected · 1 accepted · 2 rejected/u);
});

test("host rows preserve totals and notes, scrub labels, and surface unavailability", () => {
  // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
  const run = facts({
    hostUsage: {
      platform: "claude",
      rows: [
        {
          stage: "plan",
          role: "host",
          model: "m",
          effort: null,
          input: 10,
          output: 2,
          cacheRead: 5,
          cacheWrite: 2,
          reasoning: 4,
        },
        {
          stage: "plan",
          role: "subagent",
          model: "m",
          effort: null,
          input: 20,
          output: 3,
        },
      ],
      notes: {
        host: { "unparsed lines": 2 },
        subagent: { "read budget reached": 1 },
      },
    },
    invocations: [
      invocation({ provider: "claude", usage: { input: 7, output: 1 } }),
    ],
  });

  Reflect.set(
    defined(defined(run.hostUsage).rows[0]),
    "text",
    "secret transcript"
  );
  const text = render([run]);
  assert.ok(
    text.includes(
      "| claude | 37 | 5 | 2 | 6 | 4 | host measured (unparsed lines 2) · subagents measured (read budget reached 1) · delegates 1/1 |"
    )
  );
  assert.ok(
    text.includes("| plan | claude | host | m | — | 10 | 5 | 2 | 2 | 4 | — |")
  );
  assert.ok(
    text.includes(
      "| plan | claude | subagent | m | — | 20 | — | — | 3 | — | — |"
    )
  );
  assert.ok(
    text.includes(
      "| code review | claude | delegate | gpt-6-sol (configured) | medium | 7 | — | — | 1 | — | 1/1 |"
    )
  );
  assert.ok(
    text.includes(
      "other threads, full collection, and storage loss are unobservable."
    )
  );
  assert.ok(!text.includes("secret transcript"));

  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- test fixture establishes this shape before the assertion
  const invalidUsage = {
    platform: "claude",
    rows: [
      {
        stage: "plan",
        role: "host",
        model: "C:/private/path",
        effort: "C:/private",
        input: 4,
        output: 1,
      },
    ],
    unavailable: "read-error:EACCES",
    notes: { subagent: { "unreadable files": 2 } },
  } as NonNullable<RunFacts["hostUsage"]>;

  const sanitized = render([
    facts({ hostUsage: invalidUsage, invocations: [] }),
  ]);

  assert.ok(
    sanitized.includes(
      "| plan | claude | host | — | — | 4 | — | — | 1 | — | — |"
    )
  );
  assert.ok(sanitized.includes("host unavailable: read-error:EACCES"));
  assert.ok(sanitized.includes("subagents not measured (unreadable files 2)"));
  assert.ok(!sanitized.includes("C:/private"));
});

test("Codex delegates keep their own platform under a Claude host and timing scope reports native timing", () => {
  // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
  const run = facts({
    timingScope: "tool-calls",
    hostUsage: {
      platform: "claude",
      rows: [
        {
          stage: "plan",
          role: "host",
          model: "claude-model",
          effort: null,
          input: 10,
          output: 2,
        },
      ],
    },
    invocations: [
      invocation({ provider: "claude", usage: { input: 3, output: 1 } }),
      invocation({ provider: "codex", usage: { input: 7, output: 4 } }),
    ],
  });

  const text = render([run]);
  assert.ok(
    text.includes(
      "| claude | 13 | — | — | 3 | — | host measured · delegates 1/1 |"
    )
  );
  assert.ok(text.includes("| codex | 7 | — | — | 4 | — | delegates 1/1 |"));
  assert.ok(
    text.includes(
      "| code review | codex | delegate | gpt-6-sol (configured) | medium | 7 | — | — | 4 | — | 1/1 |"
    )
  );
  assert.match(text, /Timing scope:.*native\/writer timing/u);
});

test("host platform edges render adapter coverage or explicit unavailability", () => {
  const missing = render([
    facts({
      hostUsage: { platform: null, rows: [], unavailable: "no adapter" },
      invocations: [],
    }),
  ]);

  assert.ok(
    missing.includes("| — | — | — | — | — | — | host unavailable: no adapter |")
  );

  const onlyFs = {
    list: () => [],
    stat: () => null,
    read: () => Buffer.alloc(0),
    decompress: null,
  };

  const hostUsage = readHostUsage(
    "agy",
    { startMs: 0, endMs: 10, home: "unused", env: () => "thread", stages: [] },
    onlyFs,
    {
      agy: {
        sessionEnv: ["CUSTOM_THREAD"],
        read: () => ({
          rows: [
            {
              stage: "plan",
              role: "host",
              model: "stub-model",
              effort: null,
              depth: 0,
              atMs: 0,
              reasoningInOutput: false,
              input: 17,
              output: 4,
              cacheRead: 2,
            },
          ],
        }),
      },
    }
  );

  const covered = render([facts({ hostUsage, invocations: [] })]);
  assert.ok(covered.includes("| agy | 17 | 2 | — | 4 | — | host measured |"));
  assert.ok(
    covered.includes(
      "| plan | agy | host | stub-model | — | 17 | 2 | — | 4 | — | — |"
    )
  );
});

const step = (name: string, outcome: string, extra: JsonObject = {}) => ({
  step: name,
  elapsedMs: 120,
  budgetMs: 5000,
  outcome,
  ...extra,
});

test("diagnostics report names each lifecycle step outcome and keeps raw details out", () => {
  const hostile = {
    ...bare(),
    lifecycleSteps: [
      step("debug-config", "timeout"),
      step("prepare", "failed", { detail: "/home/me/.config/opencode" }),
      step("teardown", "unconfirmed"),
    ],
  };

  const text = render([sanitizeFacts({ ...facts(), invocations: [hostile] })]);
  assert.match(
    text,
    /lifecycle debug-config timeout 120\/5000 ms, teardown unconfirmed 120\/5000 ms/u
  );
  assert.doesNotMatch(text, /prepare failed|home\/me|opencode/u);
});

const cli = (startMs: number, endMs?: number) => ({
  surface: "cli" as const,
  startMs,
  ...(!(endMs === undefined) && { endMs }),
});

// oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
const slot = (slot: string, ...attempts: unknown[]) => ({ slot, attempts });

test("review timing renders attempts, gaps and compaction without leaking names", () => {
  {
    const timing = [
      {
        review: "review-1234567890abcdef",
        round: 1,
        slots: [
          { slot: "codex[0]", attempts: [{ startMs: 0, endMs: 100 }] },
          { slot: "claude[0]", attempts: [{ startMs: 90, endMs: 110 }] },
        ],
      },
    ];

    const text = render([facts({ roundTiming: timing })]);
    assert.match(text, /subject 1234567890abcdef/u);
    assert.match(text, /claude\[0\].*✓/u);

    const unknown = render([
      sanitizeFacts({
        ...facts(),
        roundTiming: [
          {
            ...timing[0],
            slots: [
              ...defined(timing[0]).slots,
              { slot: "native[0]", attempts: [] },
            ],
          },
        ],
      }),
    ]);

    assert.doesNotMatch(unknown, /✓/u);
    const review = "review-1234567890abcdef";

    const native = { surface: "native" as const };
    const empty = { slot: "empty[0]", attempts: [] };
    const nativeOnly = { slot: "native[0]", attempts: [native] };
    const prior = { slot: "codex[0]", attempts: [cli(1000, 2500), native] };
    const last = { slot: "native[1]", attempts: [cli(6000, 8000)] };

    const cliText = render([
      facts({
        roundTiming: [
          { review, round: 1, slots: [prior, empty, nativeOnly, last] },
          {
            review,
            round: 2,
            slots: [prior, { ...last, attempts: [cli(6000)] }],
          },
          { review, round: 3, slots: [empty, nativeOnly] },
          {
            review,
            round: 4,
            slots: [
              prior,
              { ...last, attempts: [{ startMs: 6000, endMs: 8000 }] },
            ],
          },
        ],
      }),
    ]);

    const health = defined(cliText.split("## Review health")[1]);
    assert.match(
      health,
      /\| subject 1234567890abcdef \| 1\/4 \| 7s \(CLI only\) \|/u
    );
    assert.match(cliText, /\| 1 \| codex\[0\] \| — \| — \|/u);
  }

  {
    const rounds = [
      {
        review: "review-1234567890abcdef",
        round: 1,
        slots: [
          slot(
            "a[0]",
            { startMs: 0, endMs: 1000 },
            { startMs: 3000, endMs: 5000 }
          ),
          slot("b[0]", { startMs: 4000, endMs: 5000 }),
        ],
      },
      {
        review: "review-1234567890abcdef",
        round: 2,
        slots: [
          slot(
            "a[0]",
            { startMs: 0, endMs: 1000 },
            { startMs: 3000, endMs: 2000 }
          ),
          slot("b[0]", { startMs: 0, endMs: 5000 }),
        ],
      },
      {
        review: "review-1234567890abcdef",
        round: 3,
        slots: [slot("native[0]"), slot("a[0]", { startMs: 1 })],
      },
    ];

    const text = render([sanitizeFacts({ ...facts(), roundTiming: rounds })]);
    assert.match(
      text,
      /\| subject 1234567890abcdef \| 1 \| a\[0\] \| 5s \| ✓ \|/u
    );
    assert.match(
      text,
      /\| subject 1234567890abcdef \| 1 \| b\[0\] \| 1s \| — \|/u
    );
    assert.match(
      text,
      /\| subject 1234567890abcdef \| 2 \| a\[0\] \| — \| — \|/u
    );
    assert.match(
      text,
      /\| subject 1234567890abcdef \| 3 \| native\[0\] \| — \| — \|/u
    );
    assert.equal((text.match(/✓/gu) ?? []).length, 1);
    assert.doesNotMatch(text, /slot removal|remove.*slot/iu);
  }

  {
    const rounds = Array.from({ length: 3000 }, (_, i) => ({
      review: "review-1234567890abcdef",
      round: i + 1,
      slots: [{ slot: "codex[0]", attempts: [{ startMs: 0, endMs: 1000 }] }],
    }));

    const text = render([facts({ roundTiming: rounds })]);
    assert.ok(Buffer.byteLength(text) <= DIAGNOSTIC_LIMITS.reportBytes);

    const count = Number(
      /(?<g2>\d+) review round rows omitted\./u.exec(text)?.[1]
    );

    assert.ok(count > 1);
    assert.match(text, /\d+ review timing rounds omitted/u);
    const kept = 3000 - count;
    assert.match(
      text,
      new RegExp(`\\| subject 1234567890abcdef \\| ${kept}/3000 \\|`, "u")
    );
    assert.doesNotMatch(
      text,
      new RegExp(`\\| subject 1234567890abcdef \\| ${kept + 1}/3000 \\|`, "u")
    );

    const next = text.replace(
      `\n\n${count} review round rows omitted.`,
      `\n| subject 1234567890abcdef | ${kept + 1}/3000 | — | — | — | — | — | — |\n\n${count - 1} review round rows omitted.`
    );

    assert.ok(
      Buffer.byteLength(next) > DIAGNOSTIC_LIMITS.reportBytes,
      "another complete round exceeds the cap"
    );
  }

  {
    const text = render([
      facts({
        roundTiming: [
          {
            review: "private/path",
            round: 1,
            slots: [{ slot: "a[0]", attempts: [{ startMs: 0, endMs: 1 }] }],
          },
          {
            review: "review-1234567890abcdef",
            round: 2,
            slots: [{ slot: "a[0]", attempts: [{ startMs: -1, endMs: 5 }] }],
          },
        ],
      }),
    ]);

    assert.doesNotMatch(text, /private\/path/u);
    assert.match(
      text,
      /\| subject 1234567890abcdef \| 2 \| a\[0\] \| — \| — \|/u
    );
  }

  {
    const text = render([
      sanitizeFacts({
        ...facts(),
        roundTiming: [
          {
            review: "review-1234567890abcdef",
            round: 1,
            slots: [
              { slot: "private/path", attempts: [{ startMs: 0, endMs: 3 }] },
              { slot: "a[0]", attempts: [{ startMs: 0, endMs: 4 }, null] },
              null,
              { slot: "b[0]", attempts: [{ startMs: 0, endMs: 5 }] },
            ],
          },
        ],
      }),
    ]);

    assert.doesNotMatch(text, /private\/path|✓/u);

    const timing = defined(
      defined(text.split("### Review round timing")[1]).split(
        "### Review yield"
      )[0]
    );

    assert.equal((timing.match(/\| — \| — \| — \|/gu) ?? []).length, 2);
    assert.match(text, /\| a\[0\] \| — \| — \|/u);
  }
});

test("round workload renders observed calls, dashes for unavailable cells, and the not-counted note", () => {
  const review = "review-1234567890abcdef";

  const text = render([
    facts({
      roundWorkload: [
        {
          review,
          round: 1,
          calls: {
            total: 9,
            phases: [
              { key: "ledger-append", count: 4 },
              { key: "lint-run", count: 3 },
              { key: "brief-explorer", count: 1 },
              { key: "review-run-plan", count: 1 },
            ],
          },
          hostTokens: 8_214_330,
        },
        {
          review,
          kind: "plan",
          round: 2,
          calls: { total: 1, phases: [{ key: "review-run-plan", count: 1 }] },
          hostTokens: 2_901_550,
        },
        { review, round: 3 },
        {
          review,
          round: 4,
          calls: { total: 1, phases: [{ key: "review-run-plan", count: 1 }] },
        },
      ],
    }),
  ]);

  assert.match(
    text,
    /### Review round workload\n\n\| Review \| Round \| Toolkit calls \| Host tokens \| Host turns \| Reviewer turns \|\n\| --- \| ---: \| --- \| ---: \| ---: \| ---: \|/u
  );
  assert.match(
    text,
    /\| subject 1234567890abcdef \| 1 \| 9: ledger-append 4 · lint-run 3 · brief-explorer 1 · review-run-plan 1 \| 8,214,330 \|/u
  );
  assert.match(
    text,
    /\| subject 1234567890abcdef \| 2 \| 1: review-run-plan 1 \| 2,901,550 \|/u
  );
  assert.match(text, /\| subject 1234567890abcdef \| 3 \| — \| — \|/u);
  assert.match(
    text,
    /\| subject 1234567890abcdef \| 4 \| 1: review-run-plan 1 \| — \|/u
  );
  assert.match(
    text,
    /Observed toolkit calls only \(`report`, `diagnostics`, and outside-window work excluded\)\./u
  );
  assert.match(
    text,
    /Advisory budget \(lightweight fix review\): <=6 toolkit calls, <=25 host turns; over: none/u
  );
  assert.doesNotMatch(text, /capture storage failure/u);
});

test("round workload notes storage failures once and is omitted without review rounds", () => {
  const review = "review-1234567890abcdef";

  const failed = render([
    facts({
      roundWorkload: [
        {
          review,
          round: 1,
          calls: { total: 1, phases: [{ key: "lint-run", count: 1 }] },
        },
      ],
      collection: { storageFailed: 2 },
    }),
  ]);

  assert.equal(
    (
      failed.match(
        /2 capture storage failures: calls from failed updates may be missing from the counts above\./gu
      ) ?? []
    ).length,
    1
  );
  assert.doesNotMatch(render([facts({})]), /### Review round workload/u);
  assert.doesNotMatch(
    render([facts({ roundWorkload: [] })]),
    /### Review round workload/u
  );
});

test("round workload follows review round timing inside Execution & review detail", () => {
  const review = "review-1234567890abcdef";

  const text = render([
    facts({
      roundTiming: [
        {
          review,
          round: 1,
          slots: [
            { slot: "claude[0]", attempts: [{ startMs: 0, endMs: 100 }] },
          ],
        },
      ],
      roundWorkload: [
        {
          review,
          round: 1,
          calls: { total: 1, phases: [{ key: "review-run-plan", count: 1 }] },
        },
      ],
    }),
  ]);

  const at = (heading: string) => text.indexOf(heading);
  assert.ok(at("## Review health") >= 0);
  assert.ok(at("### Review round timing") >= 0);
  assert.ok(at("## Review health") < at("### Review round timing"));
  assert.ok(at("### Review round timing") < at("### Review round workload"));
});

test("round workload survives sanitizing and drops malformed rows, keys, and fields", () => {
  const review = "review-1234567890abcdef";

  const clean = sanitizeFacts({
    ...facts(),
    roundWorkload: [
      {
        review,
        round: 1,
        calls: {
          total: 2,
          phases: [
            { key: "lint-run", count: 2 },
            { key: "Bad Key", count: 1 },
          ],
        },
        hostTokens: 40,
        secret: "/private/path",
      },
      { review: "plan-x", round: 1, calls: { total: 1, phases: [] } },
      { review, round: 2 },
    ],
  });

  assert.deepEqual(clean.roundWorkload, [
    {
      review,
      round: 1,
      calls: { total: 2, phases: [{ key: "lint-run", count: 2 }] },
      hostTokens: 40,
    },
    { review, round: 2 },
  ]);
});

test("the render path keeps allowlisted host response facts and removes raw identities", () => {
  const response = {
    stage: "plan",
    role: "host",
    agent: "host-1",
    basis: "claude-assistant-message",
    coverage: "complete",
    observed: 2,
    uncachedInput: 18,
  } as const;

  const hostUsage = {
    platform: "claude",
    rows: [
      {
        stage: "plan",
        role: "host",
        model: "fixture-model",
        effort: null,
        input: 18,
        output: 2,
      },
    ],
    responses: [
      { ...response, actor: "private-thread", raw: "secret transcript" },
      { ...response, agent: "private-thread" },
      { ...response, coverage: "partial", observed: -1 },
      { ...response, basis: "unverified-withFields" },
      {
        ...response,
        stage: "unattributed",
        role: "subagent",
        agent: undefined,
        coverage: "unknown",
        observed: undefined,
        uncachedInput: undefined,
      },
    ],
  };

  // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
  const run = sanitizeFacts({ ...facts(), hostUsage, invocations: [] });
  const clean = sanitizeFacts(run);
  assert.deepEqual(clean.hostUsage?.responses, [
    response,
    {
      stage: "unattributed",
      role: "subagent",
      basis: "claude-assistant-message",
      coverage: "unknown",
    },
  ]);
  assert.deepEqual(
    sanitizeFacts(clean).hostUsage?.responses,
    clean.hostUsage?.responses
  );
  const report = render([run]);
  assert.match(report, /fixture-model/u);
  assert.doesNotMatch(
    report,
    /private-thread|secret transcript|unverified-withFields/u
  );
  assert.equal(
    sanitizeFacts(facts({ hostUsage: { platform: "claude", rows: [] } }))
      .hostUsage?.responses,
    undefined
  );
});

test("response tables reconcile matched input while retaining partial and zero evidence", () => {
  const basis = "claude-assistant-message" as const;

  const text = render([
    facts({
      hostUsage: {
        platform: "claude",
        rows: [],
        responses: [
          {
            stage: "plan",
            role: "host",
            agent: "host-1",
            basis,
            coverage: "partial",
            observed: 2,
            uncachedInput: 21,
          },
          {
            stage: "plan",
            role: "host",
            basis,
            coverage: "partial",
            observed: 1,
          },
          {
            stage: "plan review",
            role: "host",
            agent: "host-1",
            basis,
            coverage: "complete",
            observed: 1,
            uncachedInput: 80,
          },
        ],
      },
      invocations: [
        invocation({
          responses: [
            {
              stage: "code review",
              role: "delegate",
              agent: "delegate-0123456789abcdef",
              basis,
              coverage: "complete",
              observed: 0,
              uncachedInput: 0,
            },
          ],
        }),
        invocation({
          responses: [
            {
              stage: "code review",
              role: "delegate",
              agent: "delegate-fedcba9876543210",
              basis,
              coverage: "complete",
              observed: 2,
              uncachedInput: 10,
            },
          ],
        }),
        invocation(),
      ],
    }),
  ]);

  assert.match(
    text,
    /\| plan \| host \| claude-assistant-message \| 3 \| partial \| 2 \| 21 \| 10\.50 \|/u
  );
  assert.match(
    text,
    /\| plan review \| host \| host-1 \| claude-assistant-message \| 1 \| complete \| 1 \| 80 \| 80\.00 \|/u
  );
  assert.match(
    text,
    /\| code review \| delegate \| delegate-2 \| claude-assistant-message \| 0 \| complete \| 0 \| 0 \| — \|/u
  );
  assert.match(
    text,
    /\| code review \| delegate \| unavailable \| — \| unavailable \|/u
  );
  assert.doesNotMatch(
    text,
    /delegate-0123456789abcdef|delegate-fedcba9876543210/u
  );
});

test("each run retains its own bounded response aliases", () => {
  const invocations = Array.from({ length: 33 }, (_, index) =>
    invocation({
      responses: [
        {
          stage: "code review",
          role: "delegate",
          agent: `delegate-${index.toString(16).padStart(16, "0")}`,
          basis: "claude-assistant-message",
          coverage: "complete",
          observed: 1,
          uncachedInput: 2,
        },
      ],
    })
  );

  const returning = invocation({
    responses: [
      {
        ...defined(defined(defined(invocations[0]).responses)[0]),
        stage: "plan review",
      },
    ],
  });

  // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
  const run = facts({ invocations: [...invocations, returning] });
  const text = render([run, run]);

  const detail = defined(
    defined(text.split("### Turns & context efficiency by agent")[1]).split(
      "</details>"
    )[0]
  );

  // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
  for (const run of [1, 2]) {
    assert.equal(
      detail.match(
        new RegExp(
          `\\| code review \\| delegate \\| run ${run} delegate-\\d+ \\|`,
          "gu"
        )
      )?.length,
      32
    );
    assert.ok(
      detail.includes(`| plan review | delegate | run ${run} delegate-1 |`)
    );
  }

  assert.match(
    detail,
    /\| code review \| delegate \| Unnamed or folded \| claude-assistant-message \| 2 \| partial \| 2 \| 4 \|/u
  );
  assert.match(
    text,
    /\| code review \| delegate \| claude-assistant-message \| 66 \| partial \| 66 \| 132 \|/u
  );
});

test("report compaction retains response coverage and totals ahead of bounded agent and workload detail", () => {
  const responses = Array.from({ length: 64 }, (_, i) => ({
    stage: "code review" as const,
    role: "delegate" as const,
    agent: `delegate-${i.toString(16).padStart(16, "0")}`,
    basis: "claude-assistant-message" as const,
    coverage: "complete" as const,
    observed: 1,
    uncachedInput: 2,
  }));

  const phases = Array.from({ length: 100 }, (_, i) => ({
    key: `ledger-append-${i}`,
    count: i,
  }));

  const text = render([
    facts({
      invocations: responses.map((response) =>
        invocation({ responses: [response] })
      ),
      roundWorkload: Array.from({ length: 1000 }, (_, i) => ({
        review: "review-1234567890abcdef",
        round: i + 1,
        calls: { total: 4950, phases },
      })),
    }),
  ]);

  assert.ok(Buffer.byteLength(text) <= DIAGNOSTIC_LIMITS.reportBytes);
  assert.match(
    text,
    /\| code review \| delegate \| claude-assistant-message \| 64 \| partial \| 64 \| 128 \| 2\.00 \|/u
  );
  assert.match(text, /workload rows omitted/u);
  assert.doesNotMatch(text, /Truncated at the report size limit/u);
});

const testPricer = () =>
  resolvePricing(
    {
      asOf: "2026-11-23",
      source: ["test"],
      models: {
        "gpt-6-sol": {
          rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5 },
        },
        "claude-opus-5-5": {
          rates: { input: 15, output: 75, cacheRead: 1.5, cacheWrite5m: 18.75 },
        },
        "claude-haiku-5": {
          rates: {
            input: 0.25,
            output: 1.25,
            cacheRead: 0.025,
            cacheWrite5m: 0.3,
          },
        },
        "bounded-model": {
          rates: { input: 1, output: 5, cacheRead: 0.1 },
          tiers: [
            {
              abovePromptTokens: 1000,
              rates: { input: 3, output: 15, cacheRead: 0.3 },
            },
          ],
        },
      },
    },
    undefined
  );

const multiRoundFixture = () => {
  const review = "review-1234567890abcdef";

  return facts({
    startedAt: "2026-11-23T12:00:00Z",
    host: "claude",
    hosts: ["claude"],
    hostThread: "0123456789abcdef",
    relaunches: 1,
    phases: [
      {
        key: "plan",
        name: "plan",
        outcome: "complete",
        wallMs: 120_000,
        driverMs: 10_000,
        hostMs: 90_000,
        userMs: 5000,
      },
      {
        key: "plan-review",
        name: "plan review",
        outcome: "complete",
        wallMs: 180_000,
        driverMs: 15_000,
        hostMs: 120_000,
        userMs: 5000,
      },
      {
        key: "implementation",
        name: "implementation",
        outcome: "complete",
        wallMs: 300_000,
        driverMs: 20_000,
        hostMs: 240_000,
        userMs: 10_000,
      },
      {
        key: review,
        name: "code review",
        outcome: "complete",
        wallMs: 240_000,
        driverMs: 25_000,
        hostMs: 180_000,
        userMs: 5000,
      },
      { key: "ask", name: "ask", outcome: "complete", wallMs: 400 },
    ],
    hostUsage: {
      platform: "claude",
      userTurns: 6,
      userTurnsByStage: {
        plan: 2,
        "plan review": 1,
        implementation: 2,
        "code review": 1,
      },
      subagentCount: 2,
      maxSubagentDepth: 2,
      rows: [
        {
          stage: "plan",
          phase: "plan",
          role: "host",
          model: "claude-opus-5-5",
          effort: "high",
          input: 50_000,
          cacheRead: 200_000,
          output: 4000,
          turns: 5,
          toolCalls: 8,
          toolTurns: 4,
        },
        {
          stage: "implementation",
          phase: "implementation",
          role: "host",
          model: "claude-opus-5-5",
          effort: "high",
          input: 80_000,
          cacheRead: 400_000,
          output: 10_000,
          turns: 10,
          toolCalls: 20,
          toolTurns: 8,
        },
        {
          stage: "implementation",
          phase: "implementation",
          role: "subagent",
          model: "claude-haiku-5",
          effort: null,
          input: 40_000,
          cacheRead: 100_000,
          output: 3000,
          turns: 8,
          toolCalls: 12,
          toolTurns: 6,
          maxDepth: 2,
        },
      ],
      responses: [
        {
          stage: "plan",
          role: "host",
          agent: "host-1",
          basis: "claude-assistant-message",
          coverage: "complete",
          observed: 5,
          uncachedInput: 50_000,
          toolCalls: 8,
          toolTurns: 4,
        },
        {
          stage: "implementation",
          role: "host",
          agent: "host-1",
          basis: "claude-assistant-message",
          coverage: "complete",
          observed: 10,
          uncachedInput: 80_000,
          toolCalls: 20,
          toolTurns: 8,
        },
        {
          stage: "implementation",
          role: "subagent",
          agent: "subagent-1",
          basis: "claude-assistant-message",
          coverage: "complete",
          observed: 8,
          uncachedInput: 40_000,
          toolCalls: 12,
          toolTurns: 6,
        },
      ],
    },
    invocations: [
      invocation({
        phase: "plan-review",
        provider: "codex",
        model: "gpt-6-sol",
        reportedModels: ["gpt-6-sol"],
        effort: "medium",
        usageSource: "session",
        usage: {
          input: 20_000,
          cacheRead: 60_000,
          output: 2000,
          turns: 4,
          toolCalls: 6,
          toolTurns: 3,
          models: {
            "gpt-6-sol": {
              input: 20_000,
              cacheRead: 60_000,
              output: 2000,
              turns: 4,
              toolCalls: 6,
              toolTurns: 3,
            },
          },
        },
        responses: [
          {
            stage: "plan review",
            role: "delegate",
            agent: "delegate-1111222233334444",
            basis: "codex-token-count",
            coverage: "complete",
            observed: 4,
            uncachedInput: 20_000,
            toolCalls: 6,
            toolTurns: 3,
          },
        ],
        subject: "1111222233334444",
        attempt: 1,
        slot: "codex[0]",
      }),
      invocation({
        phase: review,
        provider: "codex",
        model: "gpt-6-sol",
        reportedModels: ["gpt-6-sol"],
        effort: "medium",
        usageSource: "session",
        wrapUp: true,
        usage: {
          input: 30_000,
          cacheRead: 90_000,
          output: 3000,
          turns: 5,
          toolCalls: 7,
          toolTurns: 4,
          models: {
            "gpt-6-sol": {
              input: 30_000,
              cacheRead: 90_000,
              output: 3000,
              turns: 5,
              toolCalls: 7,
              toolTurns: 4,
            },
          },
        },
        responses: [
          {
            stage: "code review",
            role: "delegate",
            agent: "delegate-2222333344445555",
            basis: "codex-token-count",
            coverage: "complete",
            observed: 5,
            uncachedInput: 30_000,
            toolCalls: 7,
            toolTurns: 4,
          },
        ],
        subject: "2222333344445555",
        attempt: 1,
        slot: "codex[0]",
      }),
    ],
    reviews: [
      {
        phase: "plan-review",
        round: 1,
        accepted: 2,
        rejected: 1,
        recurring: 0,
      },
      { phase: review, round: 1, accepted: 3, rejected: 0, recurring: 0 },
    ],
    roundTiming: [
      {
        review: "review-aaaa111122223333",
        round: 1,
        slots: [
          {
            slot: "codex[0]",
            attempts: [{ surface: "cli", startMs: 1000, endMs: 41_000 }],
          },
        ],
      },
      {
        review,
        round: 1,
        slots: [
          {
            slot: "codex[0]",
            attempts: [{ surface: "cli", startMs: 50_000, endMs: 110_000 }],
          },
        ],
      },
    ],
    roundWorkload: [
      {
        review: "review-aaaa111122223333",
        kind: "plan",
        round: 1,
        calls: { total: 3, phases: [{ key: "review-run-plan", count: 1 }] },
        hostTokens: 120_000,
        hostTurns: 4,
        reviewerTurns: 4,
      },
      {
        review,
        kind: "code",
        round: 1,
        calls: { total: 4, phases: [{ key: "review-run-code", count: 1 }] },
        hostTokens: 180_000,
        hostTurns: 5,
        reviewerTurns: 5,
      },
    ],
    slotYield: [
      {
        kind: "provider",
        provider: "codex",
        model: "gpt-6-sol",
        raised: { MUST: 2, SHOULD: 3, CONSIDER: 1 },
        accepted: 5,
        rejected: 1,
        deferred: 0,
        duplicate: 0,
        unruled: 0,
        tokens: 207_000,
        measured: 2,
        launched: 2,
        attempts: [
          {
            provider: "codex",
            model: "gpt-6-sol",
            effort: "medium",
            usageSource: "session",
            usage: { input: 20_000, cacheRead: 60_000, output: 2000, turns: 4 },
          },
          {
            provider: "codex",
            model: "gpt-6-sol",
            effort: "medium",
            usageSource: "session",
            usage: { input: 30_000, cacheRead: 90_000, output: 3000, turns: 5 },
          },
        ],
      },
    ],
  });
};

test("3-tier executive layout renders visible dashboard, 4 labeled details blocks, and omits Top findings when <= 3", () => {
  const pricer = testPricer();
  const { text } = renderDiagnostics([multiRoundFixture()], pricer);
  const firstDetails = text.indexOf("<details>");
  assert.ok(firstDetails > 0);
  const visible = text.slice(0, firstDetails);

  for (const heading of [
    "## Summary",
    "### Spend & Turns by Role",
    "### Spend & Turns by Stage",
    "## Cost drivers",
    "## Review health",
    "## Findings",
  ]) {
    assert.ok(visible.includes(heading), `visible missing ${heading}`);
  }

  assert.doesNotMatch(
    visible,
    /### Tokens by platform|### Tokens by stage|### Phases|### Review round timing|### Review round workload|### Responses by agent|### Turns & context efficiency/u
  );
  assert.doesNotMatch(
    text,
    /### Response events by stage and role|### Review CLI attempt spans/u
  );
  assert.doesNotMatch(visible, /Top findings:/u);

  for (const label of [
    "<summary>Cost & token breakdown (platform, stage, model, and metadata)</summary>",
    "<summary>Turn & context efficiency (by stage, role, and agent)</summary>",
    "<summary>Execution & review detail (phases, per-slot timing, and workload)</summary>",
    "<summary>Invocations, provenance, and configuration</summary>",
  ]) {
    assert.ok(text.includes(label), `missing ${label}`);
  }

  const manyFindings = renderDiagnostics(
    [
      facts({
        invocations: [
          invocation({ outcome: "quota" }),
          invocation({ outcome: "quota" }),
          invocation({ usage: { input: 9000, cacheRead: 100, output: 0 } }),
        ],
        reviews: [1, 2, 3].map((round) => ({
          phase: "review",
          round,
          accepted: 1,
          rejected: 0,
          cap: 3,
          ...(round === 3 && { reraised: ["R1-F001"] }),
        })),
        observations: [observation({ id: "o1" }), observation({ id: "o2" })],
      }),
    ],
    pricer
  ).text;

  assert.match(
    manyFindings.slice(0, manyFindings.indexOf("<details>")),
    /Top findings:/u
  );
});

test("divergent cost vs token ranking uses priced midpoint bars, 1-block floor, 0% empty bar, and unpriced dash", () => {
  const pricer = testPricer();

  const { text } = renderDiagnostics(
    [
      facts({
        invocations: [
          invocation({
            provider: "claude",
            model: "claude-opus-5-5",
            usage: { input: 10_000, output: 2000, turns: 3 },
          }),
          invocation({
            provider: "claude",
            model: "claude-haiku-5",
            usage: { input: 200_000, output: 20_000, turns: 5 },
          }),
          invocation({
            provider: "codex",
            model: "gpt-6-sol",
            usage: { input: 1500, output: 100, turns: 1 },
          }),
          invocation({
            provider: "codex",
            model: "gpt-6-sol",
            effort: "low",
            usage: { input: 10, output: 1, turns: 1 },
          }),
          invocation({
            provider: "codex",
            model: "unpriced-model",
            usage: { input: 50_000, output: 1000, turns: 2 },
          }),
        ],
      }),
    ],
    pricer
  );

  const drivers = defined(
    defined(text.split("## Cost drivers")[1]).split("## ")[0]
  );

  const opusAt = drivers.indexOf("claude-opus-5-5");
  const haikuAt = drivers.indexOf("claude-haiku-5");
  assert.ok(
    opusAt > 0 && haikuAt > 0 && opusAt < haikuAt,
    "priced cost midpoint ranks opus ahead of higher-token haiku"
  );
  assert.match(drivers, /█.*1%/u, "1% share renders at least one filled block");
  assert.match(
    drivers,
    /░░░░░░░░░░ 0%/u,
    "valid 0% share renders empty 10-char bar"
  );
  assert.match(drivers, /unpriced-model.*\| — \|/u);
});

test("Review health consolidates round timing and responder yield and omits empty review sections", () => {
  const pricer = testPricer();

  const empty = renderDiagnostics(
    [facts({ reviews: [], roundTiming: [], roundWorkload: [], slotYield: [] })],
    pricer
  ).text;

  assert.doesNotMatch(empty, /## Review health/u);
  const review = "review-1234567890abcdef";

  const withReview = renderDiagnostics(
    [
      facts({
        reviews: [{ phase: review, round: 1, accepted: 2, rejected: 1 }],
        roundTiming: [
          {
            review,
            round: 1,
            slots: [
              {
                slot: "codex[0]",
                attempts: [{ surface: "cli", startMs: 0, endMs: 12_000 }],
              },
            ],
          },
        ],
        roundWorkload: [
          {
            review,
            round: 1,
            calls: { total: 3, phases: [] },
            hostTokens: 1000,
            hostTurns: 4,
            reviewerTurns: 3,
            reviewerTurnsPartial: true,
          },
        ],
        slotYield: [
          {
            kind: "provider",
            provider: "codex",
            model: "gpt-6-sol",
            raised: { MUST: 1, SHOULD: 1, CONSIDER: 1 },
            accepted: 2,
            rejected: 1,
            deferred: 0,
            duplicate: 0,
            unruled: 0,
            tokens: 1000,
            measured: 1,
            launched: 1,
            attempts: [
              {
                provider: "codex",
                model: "gpt-6-sol",
                effort: "medium",
                usageSource: "session",
                usage: { input: 900, output: 100, turns: 3 },
              },
            ],
          },
        ],
      }),
    ],
    pricer
  ).text;

  const health = defined(
    defined(withReview.split("## Review health")[1]).split("\n## ")[0]
  );

  assert.match(health, /3 partial/u);
  assert.match(health, /1\/1\/1/u);
  assert.doesNotMatch(withReview, /### Review CLI attempt spans/u);
});

test("mixed undefined-turn units render dash via all-defined guard across Summary, Role, Stage, and Cost drivers", () => {
  const pricer = testPricer();

  const { text } = renderDiagnostics(
    [
      facts({
        invocations: [
          invocation({
            usageSource: "session",
            usage: {
              input: 1000,
              output: 100,
              turns: 4,
              toolCalls: 2,
              toolTurns: 1,
              models: {
                "gpt-6-sol": {
                  input: 1000,
                  output: 100,
                  turns: 4,
                  toolCalls: 2,
                  toolTurns: 1,
                },
              },
            },
          }),
          invocation({
            usageSource: "stdout",
            usage: { input: 500, output: 50 },
          }),
        ],
      }),
    ],
    pricer
  );

  const roleSection = defined(
    defined(text.split("### Spend & Turns by Role")[1]).split(
      "### Spend & Turns by Stage"
    )[0]
  );

  assert.match(
    roleSection,
    /\| CLI delegates \|[^|]+\|[^|]+\|[^|]+\|[^|]+\| — \| — \| — \|/u
  );
});

test("delegate-and-child turns reconcile Summary, Role, and Stage without cost duplication across shared, split, and Codex limited fixtures", () => {
  const pricer = testPricer();

  const shared = renderDiagnostics(
    [
      facts({
        invocations: [
          invocation({
            usageSource: "session",
            usage: {
              input: 1000,
              output: 100,
              turns: 3,
              toolCalls: 2,
              toolTurns: 2,
              models: {
                "gpt-6-sol": {
                  input: 1000,
                  output: 100,
                  turns: 3,
                  toolCalls: 2,
                  toolTurns: 2,
                },
              },
            },
            responses: [
              {
                stage: "code review",
                role: "delegate",
                agent: "delegate-1111222233334444",
                basis: "claude-assistant-message",
                coverage: "complete",
                observed: 3,
                uncachedInput: 1000,
                toolCalls: 2,
                toolTurns: 2,
              },
              {
                stage: "code review",
                role: "subagent",
                agent: "delegate-child-1111222233334444",
                basis: "claude-assistant-message",
                coverage: "complete",
                observed: 5,
                uncachedInput: 400,
                toolCalls: 4,
                toolTurns: 3,
              },
            ],
          }),
        ],
      }),
    ],
    pricer
  ).text;

  assert.match(shared, /LLM 8/u);
  assert.match(
    defined(shared.split("### Spend & Turns by Role")[1]),
    /\| Subagents \|[^|]+\| — \| — \| — \| — \| 5 \| 4 \(3\) \|/u
  );
  assert.match(
    defined(shared.split("### Spend & Turns by Role")[1]),
    /\| CLI delegates \|[^|]+\|[^|]+\|[^|]+\|[^|]+\| — \| 3 \| 2 \(2\) \|/u
  );
  assert.match(
    defined(shared.split("## Cost drivers")[1]),
    /\| code review \| codex \| delegate \| gpt-6-sol \|[^|]+\|[^|]+\|[^|]+\|[^|]+\|[^|]+\| 3 \|/u
  );

  const split = renderDiagnostics(
    [
      facts({
        invocations: [
          invocation({
            usageSource: "session",
            usage: {
              input: 1500,
              output: 150,
              turns: 3,
              toolCalls: 2,
              toolTurns: 2,
              models: {
                "gpt-6-sol": {
                  input: 1000,
                  output: 100,
                  turns: 3,
                  toolCalls: 2,
                  toolTurns: 2,
                },
                "claude-haiku-5": {
                  input: 500,
                  output: 50,
                  turns: 0,
                  toolCalls: 0,
                  toolTurns: 0,
                },
              },
            },
            responses: [
              {
                stage: "code review",
                role: "delegate",
                agent: "delegate-1111222233334444",
                basis: "claude-assistant-message",
                coverage: "complete",
                observed: 3,
                uncachedInput: 1000,
                toolCalls: 2,
                toolTurns: 2,
              },
              {
                stage: "code review",
                role: "subagent",
                agent: "delegate-child-2222333344445555",
                basis: "claude-assistant-message",
                coverage: "complete",
                observed: 4,
                uncachedInput: 500,
                toolCalls: 1,
                toolTurns: 1,
              },
            ],
          }),
        ],
      }),
    ],
    pricer
  ).text;

  assert.match(split, /LLM 7/u);
  assert.match(
    defined(split.split("### Spend & Turns by Role")[1]),
    /\| CLI delegates \|[^|]+\|[^|]+\|[^|]+\|[^|]+\| — \| 3 \| 2 \(2\) \|/u
  );

  const codexLimited = renderDiagnostics(
    [
      facts({
        invocations: [
          invocation({
            usageSource: "session",
            usage: {
              input: 1000,
              output: 100,
              turns: 2,
              toolCalls: 1,
              toolTurns: 1,
              models: {
                "gpt-6-sol": {
                  input: 1000,
                  output: 100,
                  turns: 2,
                  toolCalls: 1,
                  toolTurns: 1,
                },
              },
            },
            responses: [
              {
                stage: "code review",
                role: "delegate",
                agent: "delegate-1111222233334444",
                basis: "codex-token-count",
                coverage: "complete",
                observed: 2,
                uncachedInput: 1000,
                toolCalls: 1,
                toolTurns: 1,
              },
              {
                stage: "code review",
                role: "subagent",
                agent: "delegate-child-3333444455556666",
                basis: "codex-token-count",
                coverage: "partial",
                observed: 6,
                uncachedInput: 300,
              },
            ],
          }),
        ],
      }),
    ],
    pricer
  ).text;

  assert.match(codexLimited, /LLM 8/u);
  assert.match(
    defined(codexLimited.split("### Spend & Turns by Role")[1]),
    /\| Subagents \|[^\n]*limited/u
  );
});

const BASELINE_MULTI_ROUND_BYTES = 9468;

test("multi-round byte ceiling stays strictly below unmodified baseline", () => {
  const { text } = renderDiagnostics([multiRoundFixture()], testPricer());
  const bytes = Buffer.byteLength(text);
  assert.ok(
    bytes < BASELINE_MULTI_ROUND_BYTES,
    `expected ${bytes} < baseline ${BASELINE_MULTI_ROUND_BYTES}`
  );
});

test("bounded-range waste cost, midpoint share, wrapUp, and writerRelaunches render in Summary and Tier 2", () => {
  const pricer = testPricer();

  const { text } = renderDiagnostics(
    [
      facts({
        relaunches: 2,
        invocations: [
          invocation({
            model: "bounded-model",
            usageSource: "session",
            usage: { input: 10_000, output: 1000, turns: 2 },
            slot: "codex[0]",
            subject: "1111222233334444",
            attempt: 1,
          }),
          invocation({
            model: "bounded-model",
            usageSource: "session",
            usage: { input: 10_000, output: 1000, turns: 2 },
            slot: "codex[0]",
            subject: "1111222233334444",
            attempt: 2,
            nudge: true,
          }),
          invocation({
            model: "bounded-model",
            usageSource: "session",
            usage: { input: 10_000, output: 1000, turns: 2 },
            slot: "codex[0]",
            subject: "2222333344445555",
            attempt: 1,
            wrapUp: true,
            superseded: true,
          }),
        ],
      }),
    ],
    pricer
  );

  assert.match(text, /Waste \/ recovery:.*~/u);
  assert.match(text, /wrap-up/iu);
  assert.match(text, /writer relaunch/iu);
  assert.match(text, /wrapUp/u);
});

test("session and stdout delegate turns, subagent depth, and thread-verified workload render cleanly", () => {
  const pricer = testPricer();
  const { text } = renderDiagnostics([multiRoundFixture()], pricer);
  assert.doesNotMatch(text, /0123456789abcdef/u);
  assert.match(text, /Subagents: 2 · max depth 2/u);
  assert.doesNotMatch(text, /\| Run \|/u);
  assert.doesNotMatch(text, /gpt-6-sol \(reported: gpt-6-sol\)/u);
  assert.doesNotMatch(text.slice(0, text.indexOf("<details>")), /^- Build:/mu);
});

test("folds Tier-2 details before Tier-1 yield and keeps Summary and Cost drivers intact", () => {
  const responses = Array.from({ length: 64 }, (_, i) => ({
    stage: "code review" as const,
    role: "delegate" as const,
    agent: `delegate-${i.toString(16).padStart(16, "0")}`,
    basis: "claude-assistant-message" as const,
    coverage: "complete" as const,
    observed: 1,
    uncachedInput: 2,
  }));

  const phases = Array.from({ length: 100 }, (_, i) => ({
    key: `ledger-append-${i}`,
    count: i,
  }));

  const { text } = renderDiagnostics(
    [
      facts({
        invocations: responses.map((response) =>
          invocation({ responses: [response] })
        ),
        roundWorkload: Array.from({ length: 1000 }, (_, i) => ({
          review: "review-1234567890abcdef",
          round: i + 1,
          calls: { total: 4950, phases },
        })),
        slotYield: [
          {
            kind: "provider",
            provider: "codex",
            model: "gpt-6-sol",
            raised: { MUST: 1, SHOULD: 0, CONSIDER: 0 },
            accepted: 1,
            rejected: 0,
            deferred: 0,
            duplicate: 0,
            unruled: 0,
            measured: 1,
            launched: 1,
          },
        ],
      }),
    ],
    testPricer()
  );

  assert.ok(Buffer.byteLength(text) <= DIAGNOSTIC_LIMITS.reportBytes);
  assert.match(text, /## Summary/u);
  assert.match(text, /### Spend & Turns by Role/u);
  assert.match(text, /## Cost drivers/u);
  assert.match(text, /<summary>Execution & review detail/u);
  assert.match(text, /workload rows omitted/u);
  assert.doesNotMatch(text, /yield rows omitted/u);
});

test("yield-heavy overflow folds Tier-2 first and then folds Responder yield last-resort", () => {
  const slotYield = Array.from({ length: 3500 }, (_, i) => ({
    kind: "provider" as const,
    provider: `p${i}`,
    model: `model-${i}`,
    raised: { MUST: 1, SHOULD: 2, CONSIDER: 3 },
    accepted: 1,
    rejected: 0,
    deferred: 0,
    duplicate: 0,
    unruled: 0,
    tokens: 1000,
    measured: 1,
    launched: 1,
  }));

  const { text } = renderDiagnostics([facts({ slotYield })], testPricer());
  assert.ok(Buffer.byteLength(text) <= DIAGNOSTIC_LIMITS.reportBytes);
  assert.match(text, /## Summary/u);
  assert.match(text, /### Spend & Turns by Role/u);
  assert.match(text, /## Cost drivers/u);
  assert.match(text, /yield rows omitted/u);
});

test("Context efficiency tables keep exact header-to-cell alignment with distinct Observed turns and Matched turns", () => {
  const fixture = multiRoundFixture();
  defined(defined(fixture.hostUsage).responses).push({
    stage: "plan",
    role: "host",
    basis: "claude-assistant-message",
    coverage: "partial",
    observed: 2,
  });
  const { text } = renderDiagnostics([fixture], testPricer());

  for (const heading of [
    "### Context efficiency by stage and role",
    "### Turns & context efficiency by agent",
  ]) {
    const table = defined(
      defined(text.split(heading)[1]).split(/\n###|\n<\/details>/u)[0]
    )
      .split("\n")
      .filter((l) => l.startsWith("|"));

    const headers = defined(table[0]).slice(2, -2).split(" | ");

    for (const dataRow of table.slice(2)) {
      assert.equal(
        dataRow.slice(2, -2).split(" | ").length,
        headers.length,
        `${heading}: ${dataRow}`
      );
    }
  }

  const stageTable = defined(
    defined(text.split("### Context efficiency by stage and role")[1]).split(
      /\n###|\n<\/details>/u
    )[0]
  )
    .split("\n")
    .filter((l) => l.startsWith("|"));

  const sHeaders = defined(stageTable[0]).slice(2, -2).split(" | ");

  const planRow = defined(
    stageTable.slice(2).find((l) => l.includes("| plan | host |"))
  )
    .slice(2, -2)
    .split(" | ");

  assert.equal(planRow[sHeaders.indexOf("Observed turns")], "7");
  assert.equal(planRow[sHeaders.indexOf("Coverage")], "partial");
  assert.equal(planRow[sHeaders.indexOf("Matched turns")], "5");
});

test("Summary qualifies missing host turns without degrading CLI delegates and preserves sparse zero User turns", () => {
  const pricer = testPricer();

  const delegateOnly = renderDiagnostics(
    [
      facts({
        collection: {
          completed: 5,
          incomplete: 1,
          corrupt: 0,
          unreadable: 0,
          storageFailed: 0,
        },
        invocations: [
          invocation({
            usageSource: "session",
            usage: {
              input: 1000,
              output: 100,
              turns: 4,
              toolCalls: 2,
              toolTurns: 1,
              models: {
                "gpt-6-sol": {
                  input: 1000,
                  output: 100,
                  turns: 4,
                  toolCalls: 2,
                  toolTurns: 1,
                },
              },
            },
          }),
        ],
      }),
    ],
    pricer
  ).text;

  assert.match(
    delegateOnly,
    /LLM 4 \(partial\) · Tool calls 2 \(1\) \(partial\) · Captured toolkit calls 6 \(partial\) \(excl\. report\/diagnostics\)/u
  );
  assert.match(
    defined(delegateOnly.split("### Spend & Turns by Role")[1]),
    /\| CLI delegates \|[^|]+\|[^|]+\|[^|]+\|[^|]+\| — \| 4 \| 2 \(1\) \|/u
  );
  assert.match(
    defined(delegateOnly.split("### Spend & Turns by Stage")[1]),
    /Stage uses observed rows\. Summary flags missing host\/subagent data\./u
  );
  assert.match(
    defined(delegateOnly.split("### Spend & Turns by Stage")[1]),
    /\| code review \|[^|]+\|[^|]+\|[^|]+\|[^|]+\| — \| 4 \| 2 \(1\) \|/u
  );

  const incompleteHost = renderDiagnostics(
    [
      facts({
        hostUsage: {
          platform: "claude",
          userTurns: 2,
          userTurnsByStage: { plan: 2 },
          notes: { host: { "unparsed lines": 1 } },
          rows: [
            {
              stage: "plan",
              role: "host",
              model: "claude-opus-5-5",
              effort: null,
              input: 100,
              cacheRead: 50,
              output: 10,
              turns: 2,
            },
          ],
        },
        invocations: [],
      }),
    ],
    pricer
  ).text;

  assert.match(incompleteHost, /Turns: User — · LLM 2 \(partial\)/u);
  assert.match(
    defined(incompleteHost.split("### Spend & Turns by Role")[1]),
    /\| Host \|[^|]+\|[^|]+\|[^|]+\|[^|]+\| — \|/u
  );
  assert.match(
    defined(incompleteHost.split("### Spend & Turns by Role")[1]),
    /\| Host \|[^|]+\|[^|]+\|[^|]+\| 33% \(partial\) \| — \| 2 \|/u
  );
  assert.match(
    defined(incompleteHost.split("### Spend & Turns by Stage")[1]),
    /\| plan \|[^|]+\|[^|]+\|[^|]+\| 33% \(partial\) \| — \| 2 \(partial\) \|/u
  );

  const runA = facts({
    hostUsage: {
      platform: "claude",
      userTurns: 2,
      userTurnsByStage: { plan: 2 },
      rows: [
        {
          stage: "plan",
          role: "host",
          model: "claude-opus-5-5",
          effort: null,
          input: 100,
          output: 10,
          turns: 2,
        },
      ],
    },
    invocations: [],
  });

  const runB = facts({
    hostUsage: {
      platform: "claude",
      userTurns: 1,
      userTurnsByStage: { implementation: 1 },
      rows: [
        {
          stage: "implementation",
          role: "host",
          model: "claude-opus-5-5",
          effort: null,
          input: 100,
          output: 10,
          turns: 1,
        },
      ],
    },
    invocations: [],
  });

  const multiStage = defined(
    defined(
      renderDiagnostics([runA, runB], pricer).text.split(
        "### Spend & Turns by Stage"
      )[1]
    ).split("## ")[0]
  );

  assert.match(multiStage, /\| plan \|[^|]+\|[^|]+\|[^|]+\|[^|]+\| 2 \|/u);
  assert.match(
    multiStage,
    /\| implementation \|[^|]+\|[^|]+\|[^|]+\|[^|]+\| 1 \|/u
  );
});

test("Cache hit marks missing host scope (partial) in Summary only and distinguishes zero-token from unmeasured units", () => {
  const pricer = testPricer();

  const delegateCacheOnly = renderDiagnostics(
    [
      facts({
        invocations: [
          invocation({
            usageSource: "session",
            usage: {
              input: 1000,
              cacheRead: 500,
              output: 100,
              turns: 2,
              models: {
                "gpt-6-sol": {
                  input: 1000,
                  cacheRead: 500,
                  output: 100,
                  turns: 2,
                },
              },
            },
          }),
        ],
      }),
    ],
    pricer
  ).text;

  assert.match(delegateCacheOnly, /Cache hit: 33% \(partial\)/u);
  assert.match(
    defined(delegateCacheOnly.split("### Spend & Turns by Stage")[1]),
    /\| code review \|[^|]+\|[^|]+\|[^|]+\| 33% \|/u
  );

  const completeHost: NonNullable<RunFacts["hostUsage"]> = {
    platform: "claude",
    userTurns: 1,
    userTurnsByStage: { "code review": 1 },
    rows: [
      {
        stage: "code review",
        role: "host" as const,
        model: "claude-opus-5-5",
        effort: null,
        input: 0,
        output: 0,
        turns: 1,
      },
    ],
  };

  const withZeroToken = renderDiagnostics(
    [
      facts({
        hostUsage: completeHost,
        invocations: [
          invocation({
            usageSource: "session",
            usage: {
              input: 1000,
              cacheRead: 1000,
              output: 100,
              turns: 2,
              models: {
                "gpt-6-sol": {
                  input: 1000,
                  cacheRead: 1000,
                  output: 100,
                  turns: 2,
                },
              },
            },
          }),
          invocation({
            usageSource: "session",
            usage: { input: 0, output: 0 },
          }),
        ],
      }),
    ],
    pricer
  ).text;

  assert.match(withZeroToken, /Cache hit: 50%\n/u);

  const withUnmeasured = renderDiagnostics(
    [
      facts({
        hostUsage: completeHost,
        invocations: [
          invocation({
            usageSource: "session",
            usage: {
              input: 1000,
              cacheRead: 1000,
              output: 100,
              turns: 2,
              models: {
                "gpt-6-sol": {
                  input: 1000,
                  cacheRead: 1000,
                  output: 100,
                  turns: 2,
                },
              },
            },
          }),
          bare(),
        ],
      }),
    ],
    pricer
  ).text;

  assert.match(withUnmeasured, /Cache hit: 50% \(partial\)/u);
});

test("Cache hit distinguishes missing vs zero, waste qualifies incomplete denominator, and override rates warn in Summary", () => {
  const overridePricer = resolvePricing(
    {
      asOf: "2026-11-23",
      source: ["test"],
      models: {
        "gpt-6-sol": { rates: { input: 2, output: 10 } },
        "claude-opus-5-5": { rates: { input: 15, output: 75 } },
      },
    },
    { "tiny-override": { rates: { input: 0.01, output: 0.01 } } }
  );

  const { text } = renderDiagnostics(
    [
      facts({
        invocations: [
          invocation({
            model: "gpt-6-sol",
            usage: { input: 1000, output: 100 },
          }),
          invocation({
            model: "gpt-6-sol",
            effort: "low",
            usage: { input: 1000, cacheRead: 0, output: 100 },
          }),
          invocation({
            model: "claude-opus-5-5",
            usage: { input: 10_000, output: 1000 },
          }),
          invocation({
            model: "claude-opus-5-5",
            effort: "low",
            usage: { input: 9000, output: 1000 },
          }),
          invocation({
            model: "claude-opus-5-5",
            effort: "high",
            usage: { input: 8000, output: 1000 },
          }),
          invocation({
            model: "claude-opus-5-5",
            effort: "xhigh",
            usage: { input: 7000, output: 1000 },
          }),
          invocation({
            model: "tiny-override",
            effort: "low",
            usage: { input: 100, output: 10 },
            nudge: true,
          }),
          invocation({
            model: "unpriced-model",
            usage: { input: 100, output: 10 },
          }),
        ],
      }),
    ],
    overridePricer
  );

  assert.match(text, /- Rate warning: 1 override rate applied/u);
  assert.match(text, /Cache hit: 0% \(partial\)/u);
  assert.match(text, /Waste \/ recovery:.*\(partial\)/u);
});

test("Review health shows per-round rows, CLI-only native span qualifier, partial hostTurns, and uncompacted empty phases", () => {
  const review = "review-1234567890abcdef";

  const { text } = renderDiagnostics(
    [
      facts({
        phases: [
          { key: "plan", name: "plan", outcome: "ok", wallMs: 400 },
          { key: "ask", name: "ask", outcome: "ok", wallMs: 300 },
        ],
        reviews: [
          { phase: review, round: 1, accepted: 1, rejected: 0 },
          { phase: review, round: 2, accepted: 0, rejected: 1 },
        ],
        roundTiming: [
          {
            review,
            round: 1,
            slots: [
              {
                slot: "codex[0]",
                attempts: [{ surface: "cli", startMs: 0, endMs: 5000 }],
              },
            ],
          },
          {
            review,
            round: 2,
            slots: [
              {
                slot: "codex[0]",
                attempts: [
                  { surface: "cli", startMs: 0, endMs: 3000 },
                  { surface: "native" },
                ],
              },
            ],
          },
        ],
        roundWorkload: [
          {
            review,
            round: 1,
            calls: { total: 1, phases: [] },
            hostTokens: 100,
            hostTurns: 4,
            reviewerTurns: 2,
          },
          {
            review,
            round: 2,
            calls: { total: 1, phases: [] },
            reviewerTurns: 1,
          },
        ],
        invocations: [],
      }),
    ],
    testPricer()
  );

  assert.match(text, /Host turns 4 partial/u);
  assert.match(
    text,
    /\| subject 1234567890abcdef \| 1\/2 \| 5s \| 4 \| 2 \| 1 \| 0 \| — \|/u
  );
  assert.match(
    text,
    /\| subject 1234567890abcdef \| 2\/2 \| 3s \(CLI only\) \| — \| 1 \| 0 \| 1 \| — \|/u
  );
  assert.match(text, /\| plan \| ok \| <1s \|/u);
  assert.match(text, /\| ask \| ok \| <1s \|/u);

  const reviewRun = (n: number) =>
    facts({
      collection: { storageFailed: 1 },
      reviews: [
        { phase: review, round: 1, accepted: n, rejected: 0 },
        { phase: review, round: 3, accepted: 0, rejected: 1 },
      ],
      roundWorkload: [
        {
          review,
          round: 1,
          calls: { total: 1, phases: [] },
          hostTurns: n,
          reviewerTurns: 1,
        },
        {
          review,
          round: 3,
          calls: { total: 1, phases: [] },
          hostTurns: 1,
          reviewerTurns: 1,
        },
      ],
    });

  const multiRun = renderDiagnostics(
    [reviewRun(2), reviewRun(3)],
    testPricer()
  ).text;

  assert.match(
    multiRun,
    /Review-window toolkit calls 4 \(excl\. report\/diagnostics\)/u
  );
  assert.match(
    multiRun,
    /- 2 reviews · 4 rounds · Host turns 7 · Reviewer turns 4/u
  );
  assert.match(
    multiRun,
    /\| 1 \| subject 1234567890abcdef \| 1\/3 \| — \| 2 \|/u
  );
  assert.match(
    multiRun,
    /\| 2 \| subject 1234567890abcdef \| 3\/3 \| — \| 1 \|/u
  );
});
