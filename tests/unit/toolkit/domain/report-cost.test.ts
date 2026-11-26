import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  formatCost,
  resolvePricing,
  sumCost,
} from "../../../../skills/dispatch/scripts/lib/pricing.ts";
import type {
  Cost,
  CostReason,
  Pricer,
} from "../../../../skills/dispatch/scripts/lib/pricing.ts";
import type { CliDeps } from "../../../../skills/dispatch/scripts/toolkit/cli.ts";
import {
  DIAGNOSTIC_LIMITS,
  formatDuration,
  renderDiagnostics,
} from "../../../../skills/dispatch/scripts/toolkit/domain/diagnostics.ts";
import type {
  InvocationFacts,
  RunFacts,
  Usage,
} from "../../../../skills/dispatch/scripts/toolkit/domain/diagnostics.ts";
import { defined } from "../../../helpers/guards.ts";

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

const PRICES = {
  asOf: "2026-11-14",
  source: ["https://example.test/pricing"],
  models: {
    alpha: { rates: { input: 10, output: 20, cacheRead: 1 } },
    beta: { rates: { input: 2, output: 4 } },
    zero: { rates: { input: 0, output: 0 } },
    tiered: {
      rates: { input: 1, output: 2 },
      tiers: [{ abovePromptTokens: 100_000, rates: { input: 5, output: 10 } }],
    },
    ttl: {
      rates: { input: 1, output: 1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
    },
  },
};

const pricer = defined(resolvePricing(PRICES, undefined));

const costRender = (runs: RunFacts[], priced: Pricer | null = pricer) =>
  renderDiagnostics(runs, priced ?? undefined).text;

const tableLines = (text: string, heading: string) =>
  defined(defined(text.split(heading)[1]).split(/\n###|\n<\/details>/u)[0])
    .split("\n")
    .filter((line) => line.startsWith("|"));

const overviewRows = (text: string) => tableLines(text, "### Phases").slice(2);

const lastCells = (line: string, n: number) =>
  line.replace(/ \|$/u, "").split(" | ").slice(-n);

const phaseCost = (text: string, phase: string) =>
  lastCells(
    defined(
      overviewRows(text).find(
        (line) =>
          line.includes(`| ${phase} |`) || line.includes(`| ${phase} · `)
      )
    ),
    1
  );

const M = 1_000_000;

const mega = (
  model: string,
  effort: string,
  input: number,
  overrides: Partial<InvocationFacts> = {}
) =>
  invocation({
    provider: "codex",
    model,
    effort,
    usage: { input, output: 0 },
    ...overrides,
  });

const CAP = DIAGNOSTIC_LIMITS.reportBytes;

const FOLD_PRICES = {
  asOf: "2026-11-14",
  source: ["https://example.test/pricing"],
  models: {
    flat: { rates: { input: 4, output: 4 } },
    wide: {
      rates: { input: 1, output: 1 },
      tiers: [{ abovePromptTokens: 100_000, rates: { input: 4, output: 4 } }],
    },
    free: { rates: { input: 0, output: 0 } },
  },
};

const foldPricer = defined(resolvePricing(FOLD_PRICES, undefined));

const tableCells = (text: string, heading: string) =>
  tableLines(text, heading)
    .slice(2)
    .map((line) => line.slice(2, -2).split(" | "));

const overviewCells = (text: string) =>
  tableLines(text, "### Phases")
    .slice(2)
    .map((line) => line.slice(2, -2).split(" | "));

const byKey = (a: string, b: string) => {
  if (a < b) {
    return -1;
  }

  if (a > b) {
    return 1;
  }

  return 0;
};

const summaryCost = (text: string) =>
  /^- Estimated cost (?<g1>[^\s·]+)/mu.exec(text)?.[1];

interface Source {
  key: string;
  tokens: number;
  cost: Cost;
}

const exactCost = (usd: number) => ({
  low: usd,
  high: usd,
  priced: true,
  reasons: new Set<CostReason>(),
});

const sourceRow = (index: number) => {
  const m = (index % 7) + 1;
  const quarter = 250_000 * m;

  switch (index % 4) {
    case 0: {
      return { model: "flat", tokens: quarter, cost: exactCost(m) };
    }

    case 1: {
      return {
        model: "wide",
        tokens: quarter,
        cost: {
          low: m / 4,
          high: m,
          priced: true,
          reasons: new Set<CostReason>(["tier unknown"]),
        },
      };
    }

    case 2: {
      return {
        model: "mystery",
        tokens: 1000 * ((index % 11) + 1),
        cost: {
          low: 0,
          high: 0,
          priced: false,
          reasons: new Set<CostReason>(["unpriced model"]),
        },
      };
    }

    default: {
      return {
        model: "free",
        tokens: 1000 * ((index % 13) + 1),
        cost: exactCost(0),
      };
    }
  }
};

const rankOrder = (rows: readonly Source[]) =>
  [...rows].toSorted(
    (a, b) =>
      b.cost.high - a.cost.high ||
      b.cost.low - a.cost.low ||
      b.tokens - a.tokens ||
      byKey(a.key, b.key)
  );

const totalOf = (rows: readonly Source[]) =>
  formatCost(sumCost(rows.map((r) => r.cost)));

const reasonsOf = (rows: readonly Source[]) =>
  [...new Set(rows.flatMap((r) => [...r.cost.reasons]))].toSorted();

const assertFolded = (
  kept: readonly string[][],
  folded: readonly string[],
  keyOf: (cells: string[]) => string,
  all: readonly Source[],
  tokensColumn: number,
  costColumn: number
) => {
  const keptKeys = kept.map(keyOf);
  assert.equal(new Set(keptKeys).size, kept.length, "kept rows are distinct");
  assert.deepEqual(
    [...keptKeys].toSorted(),
    rankOrder(all)
      .slice(0, kept.length)
      .map((r) => r.key)
      .toSorted(),
    "kept rows follow the rank"
  );
  const rest = all.filter((r) => !keptKeys.includes(r.key));
  assert.equal(folded[0], `${rest.length} smaller rows`);
  assert.equal(
    folded[tokensColumn],
    rest.reduce((n, r) => n + r.tokens, 0).toLocaleString("en-US")
  );
  assert.equal(folded[costColumn], totalOf(rest));

  return rest;
};

const roleLine = (t: string) => /^\| CLI delegates \|.*$/mu.exec(t)?.[0];

const host = (
  phase: string | undefined,
  role: "host" | "subagent",
  model: string,
  input: number
) => {
  const row = {
    stage: "plan" as const,
    role,
    model,
    effort: null,
    input,
    output: 0,
  };

  if (phase !== undefined && phase !== "") {
    return { ...row, phase };
  }

  return row;
};

test("cost cells price units, sum phases and attribute coverage across tables", () => {
  {
    const run = facts({ invocations: [mega("alpha", "high", M)] });
    const text = costRender([run]);
    assert.match(
      text,
      /^- Estimated cost ~\$10\.00 \(partial\) · priced 1 · unpriced 0/mu
    );
    assert.deepEqual(phaseCost(text, "code review"), ["~$10.00"]);
    assert.ok(
      tableLines(text, "### Tokens by platform").some((line) =>
        line.endsWith("| delegates 1/1 | — | ~$10.00 |")
      ),
      text
    );
    assert.ok(
      tableLines(text, "### Tokens by stage").some((line) =>
        line.endsWith(
          "| alpha (configured) | high | 1,000,000 | — | — | 0 | — | 1/1 | — | ~$10.00 |"
        )
      ),
      text
    );
    assert.match(text, /\| Phase \| .* \| Coverage \| Cost \|$/mu);
    assert.match(
      text,
      /\| Stage \| Platform \| Role \| Model \| Effort \| .* \| Coverage \| Cost notes \| Cost \|$/mu
    );
    assert.match(
      text,
      /^\| Platform \| .* \| Coverage \| Cost notes \| Cost \|$/mu
    );

    const plain = costRender([run], null);
    assert.match(
      plain,
      /^- Estimated cost not estimated \(rate table unavailable\)/mu
    );
    assert.deepEqual(phaseCost(plain, "code review"), ["—"]);
    assert.ok(
      tableLines(plain, "### Tokens by platform").some((line) =>
        line.endsWith("| delegates 1/1 | — | — |")
      ),
      plain
    );
    assert.ok(
      tableLines(plain, "### Tokens by stage").some((line) =>
        line.endsWith("| 1/1 | — | — |")
      ),
      plain
    );

    assert.ok(
      (roleLine(text) ?? "").length > 0 && (roleLine(plain) ?? "").length > 0
    );
  }

  {
    const cost = (invocations: InvocationFacts[]) =>
      phaseCost(costRender([facts({ invocations })]), "code review")[0];

    assert.equal(
      cost([mega("beta", "low", M), mega("mystery", "low", M)]),
      "~$2.00"
    );
    assert.equal(cost([mega("mystery", "low", M)]), "—");

    const text = costRender([
      facts({
        invocations: [
          mega("beta", "low", M),
          mega("mystery", "low", M),
          bare({ provider: "codex" }),
        ],
      }),
    ]);

    assert.match(text, /priced 1 · unpriced 2/mu);
  }

  {
    const run = facts({
      phases: [
        { key: "p1", name: "plan", outcome: "complete" },
        { key: "p2", name: "implementation", outcome: "complete" },
      ],
      hostUsage: {
        platform: "claude",
        rows: [
          defined(host)("p1", "host", "alpha", M),
          defined(host)("p2", "subagent", "beta", M),
          defined(host)(undefined, "host", "alpha", M / 2),
          defined(host)("ghost", "host", "beta", M / 2),
        ],
      },
      invocations: [
        mega("alpha", "low", M / 10, { phase: "p2" }),
        mega("beta", "low", M, { phase: "orphan" }),
      ],
    });

    const text = costRender([run]);
    const rows = overviewRows(text);

    const costOf = (phase: string) =>
      lastCells(
        defined(rows.find((line) => line.includes(`| ${phase} |`))),
        1
      )[0];

    assert.equal(costOf("plan · p1"), "~$10.00");
    assert.equal(costOf("implementation · p2"), "~$3.00");
    assert.equal(costOf("unattributed phase"), "~$8.00");
    assert.equal(costOf("all phases"), "~$21.00");
    assert.match(
      text,
      /^- Estimated cost ~\$21\.00 \(partial\) · priced 6 · unpriced 0/mu
    );
    assert.ok(
      defined(
        rows.find((line) => line.includes("| unattributed phase |"))
      ).includes("| — | 1 | 1,000,000 |"),
      "only the orphan CLI invocation fills the token columns"
    );

    const none = costRender([
      facts({
        hostUsage: {
          platform: "claude",
          rows: [defined(host)("review", "host", "alpha", M)],
        },
        invocations: [],
      }),
    ]);

    assert.ok(
      !none.includes("unattributed phase"),
      "a phased host row leaves no unattributed phase row"
    );
  }

  {
    const usage = { input: 0, output: M, reasoning: M };

    const run = (provider: string, extra: Partial<Usage> = {}) =>
      facts({
        invocations: [
          mega("alpha", "low", 0, { provider, usage: { ...usage, ...extra } }),
        ],
      });

    const cost = (provider: string, extra?: Partial<Usage>) =>
      phaseCost(costRender([run(provider, extra)]), "code review")[0];

    assert.equal(cost("opencode"), "~$40.00");
    assert.equal(cost("agy"), "~$40.00");
    assert.equal(cost("claude"), "~$20.00");
    assert.equal(cost("codex"), "~$20.00");
    assert.equal(cost("opencode", { reasoningInOutput: true }), "~$20.00");
    assert.equal(cost("claude", { reasoningInOutput: false }), "~$40.00");

    // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
    const host = (reasoningInOutput?: boolean) =>
      facts({
        invocations: [],
        hostUsage: {
          platform: "opencode",
          rows: [
            {
              stage: "code review",
              role: "host",
              model: "alpha",
              effort: null,
              input: 0,
              output: M,
              reasoning: M,
              ...(!(reasoningInOutput === undefined) && { reasoningInOutput }),
            },
          ],
        },
      });

    assert.match(costRender([host()]), /^- Estimated cost ~\$40\.00 /mu);
    assert.match(costRender([host(true)]), /^- Estimated cost ~\$20\.00 /mu);
  }

  {
    const sharesOf = (invocations: InvocationFacts[]) => {
      const text = costRender([facts({ invocations })]);

      return tableLines(text, "## Cost drivers")
        .slice(2)
        .map((l) => {
          const c = l.slice(2, -2).split(" | ");

          return `${c[3]?.replace(" (configured)", "")}${c[4] === "—" ? "" : `/${c[4]}`} ${defined(c[6]).split(" ").at(-1)}`;
        });
    };

    assert.deepEqual(
      sharesOf([mega("alpha", "low", M), mega("tiered", "high", M)]),
      ["alpha/low 77%", "tiered/high 23%"]
    );
    assert.deepEqual(
      sharesOf([
        mega("alpha", "low", M),
        mega("tiered", "high", M),
        mega("mystery", "low", 5),
      ]),
      ["alpha/low 77%", "tiered/high 23%", "mystery/low —"]
    );
    assert.deepEqual(
      sharesOf([
        mega("alpha", "low", 0.605 * M),
        mega("alpha", "high", 0.395 * M),
      ]),
      ["alpha/low 61%", "alpha/high 39%"]
    );
    assert.deepEqual(
      sharesOf([mega("mystery", "medium", 30), mega("lost", "medium", 10)]),
      ["mystery/medium 75%", "lost/medium 25%"]
    );
    assert.deepEqual(
      sharesOf([mega("zero", "high", 300), mega("zero", "low", 100)]),
      ["zero/high —", "zero/low —"]
    );
  }

  {
    const platform = (text: string, name: string) =>
      defined(
        tableLines(text, "### Tokens by platform").find((line) =>
          line.startsWith(`| ${name} |`)
        )
      );

    const covAndNotes = (line: string) => lastCells(line, 3).slice(0, 2);

    const run = facts({
      invocations: [
        mega("mystery", "low", 10, { provider: "unpriced" }),
        mega("tiered", "low", 150_000, { provider: "tier" }),
        invocation({
          provider: "ttl",
          model: "ttl",
          usage: { input: 0, output: 0, cacheWrite: 1000 },
        }),
        bare({ provider: "copilot", coverage: ["no usage"] }),
        mega("beta", "low", 10, {
          provider: "transcript",
          coverage: ["transcript unavailable"],
        }),
      ],
    });

    const text = costRender([run]);
    assert.deepEqual(covAndNotes(platform(text, "unpriced")), [
      "delegates 1/1",
      "unpriced model",
    ]);
    assert.deepEqual(covAndNotes(platform(text, "tier")), [
      "delegates 1/1",
      "tier unknown",
    ]);
    assert.deepEqual(covAndNotes(platform(text, "ttl")), [
      "delegates 1/1",
      "cache TTL unknown",
    ]);
    assert.deepEqual(covAndNotes(platform(text, "copilot")), [
      "delegates 0/1 no usage",
      "no usage",
    ]);
    assert.deepEqual(covAndNotes(platform(text, "transcript")), [
      "delegates 1/1 transcript unavailable",
      "—",
    ]);
    assert.match(text, /priced 3 · unpriced 2/mu);

    const hosted = costRender([
      facts({
        invocations: [],
        hostUsage: {
          platform: "claude",
          rows: [
            {
              stage: "plan",
              role: "host",
              model: "tiered",
              effort: null,
              input: 150_000,
              output: 0,
            },
            {
              stage: "plan",
              role: "subagent",
              model: "mystery",
              effort: null,
              input: 5,
              output: 0,
            },
            {
              stage: "plan",
              role: "subagent",
              model: "beta",
              effort: null,
              input: 5,
              output: 0,
            },
          ],
        },
      }),
    ]);

    const stages = tableLines(hosted, "### Tokens by stage");
    assert.ok(
      stages.some(
        (line) =>
          line.startsWith("| plan | claude | host | tiered |") &&
          line.endsWith("| — | tier unknown | ~$0.15–$0.75 |")
      ),
      hosted
    );
    assert.ok(
      stages.some(
        (line) =>
          line.startsWith("| plan | claude | subagent | mystery |") &&
          line.endsWith("| — | unpriced model | — |")
      ),
      hosted
    );
    assert.ok(
      stages.some(
        (line) =>
          line.startsWith("| plan | claude | subagent | beta |") &&
          line.endsWith("| — | — | ~$<0.01 |")
      ),
      hosted
    );
  }
});

test("cost folding folds the lowest-ranked Tokens by stage rows into one trailing row", () => {
  const rows = Array.from({ length: 3000 }, (_, index) => ({
    ...sourceRow(index),
    effort: `e${String(index).padStart(4, "0")}`,
  }));

  const all: Source[] = rows.map((r) => ({
    key: `${r.model}/${r.effort}`,
    tokens: r.tokens,
    cost: r.cost,
  }));

  const hostRows = rows.map((r) => ({
    stage: "plan" as const,
    phase: "p",
    role: "host" as const,
    model: r.model,
    effort: r.effort,
    input: r.tokens,
    output: 0,
  }));

  const run = facts({
    phases: [{ key: "p", name: "plan", outcome: "complete" }],
    hostUsage: { platform: "claude", rows: hostRows },
    invocations: [],
  });

  const { text } = renderDiagnostics([run], foldPricer);

  assert.ok(Buffer.byteLength(text) <= CAP);
  assert.ok(
    Buffer.byteLength(text) > CAP - 400,
    "the largest row count that fits stays"
  );
  const stage = tableCells(text, "### Tokens by stage");

  const folded = defined(stage.at(-1));
  const kept = stage.slice(0, -1);

  assert.deepEqual(
    folded.slice(1, 5),
    ["—", "—", "—", "—"],
    "dimension cells other than the count"
  );

  const rest = assertFolded(
    kept,
    folded,
    (cells) => `${cells[3]}/${cells[4]}`,
    all,
    5,
    12
  );

  assert.deepEqual(
    defined(folded[11]).split(", ").toSorted(),
    reasonsOf(rest),
    "Cost notes unions the folded reasons"
  );
  assert.deepEqual(
    kept,
    [...kept].toSorted(
      (a, b) =>
        defined(a[3]).localeCompare(defined(b[3])) ||
        defined(a[4]).localeCompare(defined(b[4]))
    ),
    "kept rows keep their normal order"
  );
  assert.ok(
    rest.some((r) => r.cost.priced && r.cost.low < r.cost.high),
    "the fold reaches range-priced rows"
  );
  assert.ok(
    rest.some((r) => !r.cost.priced) &&
      rest.some((r) => r.cost.priced && r.cost.high === 0),
    "the fold holds unpriced and zero-rate rows"
  );

  const expected = totalOf(all);
  assert.equal(
    summaryCost(text),
    expected,
    "the Summary total predates folding"
  );
  assert.equal(defined(overviewCells(text)[0]).at(-1), expected);
  assert.equal(
    defined(tableCells(text, "### Tokens by platform")[0])[8],
    expected
  );
  assert.ok(
    !tableCells(text, "### Tokens by platform")
      .flat()
      .some((cell) => cell.includes("smaller rows")),
    "later tables stay whole"
  );
});

test("cost folding folds Phases rows for many review subjects and keeps the run total", () => {
  const rows = Array.from({ length: 1200 }, (_, index) => ({
    ...sourceRow(index),
    key: `review-${index.toString(16).padStart(16, "0")}`,
    wallMs: 1000 * (index + 1),
  }));

  const all: Source[] = rows.map(({ key, tokens, cost }) => ({
    key,
    tokens,
    cost,
  }));

  const run = facts({
    phases: rows.map((r) => ({
      key: r.key,
      name: "code review",
      outcome: "complete",
      wallMs: r.wallMs,
    })),
    invocations: rows.map((r) =>
      mega(r.model, "low", r.tokens, { phase: r.key })
    ),
  });

  const { text } = renderDiagnostics([run], foldPricer);

  assert.ok(Buffer.byteLength(text) <= CAP);
  assert.match(text, /Omitted at the report size limit\./u);

  const overview = overviewCells(text);
  const subject = "code review · subject ";

  const everything = defined(
    overview.find((cells) => cells[0] === "all phases")
  );

  const folded = defined(overview.at(-1));

  const kept = overview.filter((cells) =>
    defined(cells[0]).startsWith(subject)
  );

  assert.equal(folded[1], "—", "dimension cells other than the count");

  const rest = assertFolded(
    kept,
    folded,
    (cells) => `review-${defined(cells[0]).slice(subject.length)}`,
    all,
    4,
    9
  );

  assert.equal(
    folded[2],
    formatDuration(
      rows
        .filter((r) => rest.some((x) => x.key === r.key))
        .reduce((n, r) => n + r.wallMs, 0)
    )
  );
  assert.equal(folded[3], String(rest.length), "Invocations sum");
  assert.equal(
    overview.filter((cells) => defined(cells[0]).endsWith("smaller rows"))
      .length,
    1
  );

  const expected = totalOf(all);
  assert.equal(
    everything[9],
    expected,
    "the all phases row never folds and holds the run total"
  );
  assert.equal(summaryCost(text), expected);
  assert.equal(
    defined(tableCells(text, "### Tokens by platform")[0])[8],
    expected
  );
});

test("cost folding folds Tokens by platform rows last, after earlier tables fold to one row each", () => {
  const rows = Array.from({ length: 3000 }, (_, index) => ({
    ...sourceRow(index),
    platform: `p${String(index).padStart(4, "0")}`,
  }));

  const all: Source[] = rows.map((r) => ({
    key: r.platform,
    tokens: r.tokens,
    cost: r.cost,
  }));

  const { text } = renderDiagnostics(
    [
      facts({
        invocations: rows.map((r) =>
          mega(r.model, "low", r.tokens, { provider: r.platform })
        ),
      }),
    ],
    foldPricer
  );

  assert.ok(Buffer.byteLength(text) <= CAP);
  const platform = tableCells(text, "### Tokens by platform");

  const folded = defined(platform.at(-1));
  const kept = platform.slice(0, -1);

  const rest = assertFolded(
    kept,
    folded,
    (cells) => defined(cells[0]),
    all,
    1,
    8
  );

  assert.equal(
    folded[6],
    "delegates 1/1",
    "Coverage unions the folded segments"
  );
  assert.deepEqual(
    defined(folded[7]).split(", ").toSorted(),
    reasonsOf(rest),
    "Cost notes unions the folded reasons"
  );
  assert.deepEqual(
    kept.map((cells) => cells[0]),
    kept.map((cells) => defined(cells[0])).toSorted(),
    "kept rows keep their normal order"
  );

  const expected = totalOf(all);
  assert.equal(summaryCost(text), expected);

  const stage = tableCells(text, "### Tokens by stage");
  const overview = overviewCells(text);

  assert.deepEqual(
    [stage.length, defined(stage[0])[0], defined(stage[0])[12]],
    [1, "3000 smaller rows", expected]
  );
  assert.deepEqual(
    [overview.length, defined(overview[0])[0], defined(overview[0]).at(-1)],
    [1, "1 smaller rows", expected]
  );

  const small = renderDiagnostics(
    [facts({ invocations: [mega("flat", "low", 1000)] })],
    foldPricer
  ).text;

  assert.ok(
    !tableCells(small, "### Tokens by platform")
      .flat()
      .some((cell) => cell.includes("smaller rows")),
    "small tables stay whole"
  );
});

const phase = (key: string, name: string) => ({
  key,
  name,
  outcome: "complete",
});

test("cost end to end: mixed-platform facts price in all four locations and survive an oversized report", () => {
  // eslint-disable-next-line typescript/no-unsafe-assignment -- test binds the untyped JSON/fixture surface for assertions; narrowing would not change assertions
  const shipped = JSON.parse(
    fs.readFileSync(path.join(SKILL_ROOT, "references/pricing.json"), "utf-8")
  );

  const endPricer = defined(
    resolvePricing(shipped, {
      "lmstudio/*": { rates: { input: 0, output: 0 } },
    })
  );

  const lmstudio = "lmstudio/qwen3.8-27b-ridge";

  const run = (extra: InvocationFacts[] = []) =>
    facts({
      phases: [phase("plan", "plan"), phase("review", "code review")],
      hostUsage: {
        platform: "claude",
        rows: [
          {
            stage: "plan",
            phase: "plan",
            role: "host",
            model: "claude-haiku-5-5",
            effort: "low",
            input: 200_000,
            output: 0,
            bands: {
              le100k: { input: 90_000, output: 0 },
              le200k: { input: 110_000, output: 0 },
            },
          },
          {
            stage: "plan",
            phase: "plan",
            role: "subagent",
            model: "claude-sonnet-5-5",
            effort: null,
            input: 1_000_000,
            output: 100_000,
          },
        ],
      },
      invocations: [
        mega("gpt-6.1-terra", "high", 0, {
          phase: "review",
          usage: {
            input: 3_000_000,
            output: 100_000,
            models: {
              "gpt-6.1-terra#high": {
                input: 1_000_000,
                output: 100_000,
                bands: { le100k: { input: 1_000_000, output: 100_000 } },
              },
              "gpt-6-luna#low": {
                input: 2_000_000,
                output: 0,
                bands: { le100k: { input: 2_000_000, output: 0 } },
              },
            },
          },
        }),
        mega("gemini-4-hydrogen", "low", 0, {
          provider: "opencode",
          phase: "review",
          usage: { input: 0, output: 100_000, reasoning: 100_000 },
        }),
        mega(lmstudio, "low", 1_000_000, {
          provider: "opencode",
          phase: "review",
          usageSource: "session",
          reportedModels: [lmstudio],
        }),
        ...extra,
      ],
    });

  const assertCosts = (text: string) => {
    assert.equal(summaryCost(text), "~$6.26");
    assert.deepEqual(
      overviewCells(text).map((cells) => [cells[0], cells[8]]),
      [
        ["plan", "~$3.06"],
        ["code review · review", "~$3.20"],
        ["all phases", "~$6.26"],
      ]
    );
    assert.deepEqual(
      tableCells(text, "### Tokens by platform").map((cells) => [
        cells[0],
        cells[8],
      ]),
      [
        ["claude", "~$3.06"],
        ["codex", "~$1.70"],
        ["opencode", "~$1.50"],
      ]
    );
    const stages = tableLines(text, "### Tokens by stage");

    const cost = (prefix: string, expected: string) => {
      assert.ok(
        stages.some(
          (line) => line.startsWith(prefix) && line.endsWith(` | ${expected} |`)
        ),
        `${prefix} ${expected}\n${stages.join("\n")}`
      );
    };

    cost("| plan | claude | host | claude-haiku-5-5 | low |", "~$0.06");
    cost("| plan | claude | subagent | claude-sonnet-5-5 |", "~$3.00");
    cost("| code review | codex | delegate | gpt-6.1-terra | high |", "~$1.50");
    cost("| code review | codex | delegate | gpt-6-luna | low |", "~$0.20");
    cost(
      "| code review | opencode | delegate | gemini-4-hydrogen (configured) |",
      "~$1.50"
    );
    cost(`| code review | opencode | delegate | ${lmstudio} |`, "~$0");
  };

  const { text } = renderDiagnostics([run()], endPricer);
  assert.ok(!text.includes("Omitted at the report size limit"));
  assertCosts(text);

  const filler = Array.from({ length: 1500 }, () =>
    mega(lmstudio, "low", 1000, {
      provider: "opencode",
      phase: "review",
      usageSource: "session",
      reportedModels: [lmstudio],
    })
  );

  const large = renderDiagnostics([run(filler)], endPricer).text;
  assert.ok(Buffer.byteLength(large) <= CAP);
  assert.match(large, /Omitted at the report size limit\./u);
  assert.ok(!large.includes("smaller rows"));
  assert.match(large, /^\| Host \|[^|]+\| ~\$0\.06 \| 200,000 \|/mu);
  assert.match(large, /^\| Subagents \|[^|]+\| ~\$3\.00 \| 1,100,000 \|/mu);
  assert.match(large, /^\| CLI delegates \|[^|]+\| ~\$3\.20 \| 5,800,000 \|/mu);
  assertCosts(large);
});

test("usage-less launched unit shows no usage instead of unpriced model", () => {
  const text = costRender([
    facts({ invocations: [bare({ provider: "codex", model: "alpha" })] }),
  ]);

  const stage = defined(
    tableLines(text, "### Tokens by stage").find((line) =>
      line.includes("| codex | delegate | alpha")
    )
  );

  assert.ok(stage.endsWith("| 0/1 | no usage | — |"), stage);
  assert.ok(!stage.includes("unpriced model"), stage);

  const plat = defined(
    tableLines(text, "### Tokens by platform").find((line) =>
      line.startsWith("| codex |")
    )
  );

  assert.ok(
    plat.includes("| delegates 0/1 | no usage | — |") &&
      !plat.includes("unpriced model"),
    plat
  );
});

test("apart reasoning counts once in every token total and token share", () => {
  const run = facts({
    invocations: [
      mega("mystery", "low", 100, {
        provider: "opencode",
        usage: { input: 100, output: 20, reasoning: 30 },
      }),
      mega("lost", "low", 100, {
        provider: "claude",
        usage: { input: 100, output: 20, reasoning: 30 },
      }),
    ],
  });

  const text = costRender([run]);
  assert.match(text, /^\| CLI delegates \|[^|]+\| — \| 270 \|/mu);
  assert.match(text, /mystery \(configured\).*56% \| 150/u);
  assert.match(text, /lost \(configured\).*44% \| 120/u);
  assert.ok(text.includes("| 30 | 150 | ok |"), text);
  assert.ok(text.includes("| 30 (in output) | 120 | ok |"), text);
});

const run = (startedAt?: string) =>
  // SAFETY: facts() returns the full run record; main() reads only that surface in this test.
  //oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- run record reaches CliDeps only through unknown; the direct assertion lacks overlap; test restores the static fixture type the double was built with; the runtime shape is asserted below
  facts({
    ...((startedAt ?? "").length > 0 && { startedAt }),
    invocations: [mega("alpha", "low", M)],
  } as unknown as CliDeps);

test("run start date selects rate period and falls back to base rates when absent", () => {
  const datedPricer = defined(
    resolvePricing(
      {
        asOf: "2026-11-16",
        source: ["https://example.test/pricing"],
        models: {
          alpha: {
            rates: { input: 1, output: 2 },
            periods: [{ from: "2026-12-01", rates: { input: 4, output: 8 } }],
          },
        },
      },
      undefined
    )
  );

  assert.equal(
    summaryCost(costRender([run("2026-11-30")], datedPricer)),
    "~$1.00"
  );
  assert.equal(
    summaryCost(costRender([run("2026-12-01")], datedPricer)),
    "~$4.00"
  );
  assert.equal(summaryCost(costRender([run()], datedPricer)), "~$1.00");
});

test("multi-host Summary lists every host and names the covered host thread", () => {
  const known = costRender([
    facts({
      hosts: ["claude", "agy"],
      hostUsage: {
        platform: "agy",
        rows: [
          {
            stage: "code review",
            role: "host",
            model: "zero",
            effort: null,
            input: 0,
            output: 0,
          },
        ],
      },
      invocations: [],
    }),
  ]);

  assert.match(
    known,
    /^- Host: claude, agy · host rows measure the agy thread; other hosts' threads are unmeasured · OS: windows$/mu
  );

  const nullHost = costRender([
    facts({
      hosts: ["claude", "agy"],
      hostUsage: { platform: null, rows: [] },
      invocations: [],
    }),
  ]);

  assert.match(
    nullHost,
    /^- Host: claude, agy · no host thread is measured · OS: windows$/mu
  );

  const noHostUsage = costRender([
    facts({ hosts: ["claude", "agy"], invocations: [] }),
  ]);

  assert.match(
    noHostUsage,
    /^- Host: claude, agy · no host thread is measured · OS: windows$/mu
  );
});

const drivers = (text: string) =>
  defined(defined(text.split("## Cost drivers")[1]).split("\n## ")[0]);

const shareNum = (cell: string) =>
  Number(defined(cell.split(" ").at(-1)).replace("%", ""));

test("Cost drivers ranks up to five groups with remainder summing to 100% and cache-hit ratio", () => {
  const rows = (text: string) =>
    drivers(text)
      .split("\n")
      .filter((l) => l.startsWith("|"))
      .slice(2)
      .map((l) => l.slice(2, -2).split(" | "));

  const pricedRun = facts({
    invocations: [
      mega("alpha", "high", 500_000, {
        provider: "claude",
        usage: { input: 500_000, cacheRead: 500_000, output: 0 },
      }),
      mega("alpha", "low", 400_000, { provider: "claude" }),
      mega("alpha", "medium", 300_000, { provider: "claude" }),
      mega("beta", "high", 500_000, { provider: "codex" }),
      mega("beta", "low", 400_000, { provider: "codex" }),
      mega("beta", "medium", 300_000, { provider: "codex" }),
      mega("beta", "xhigh", 200_000, { provider: "codex" }),
    ],
  });

  const pricedRows = rows(costRender([pricedRun]));
  assert.equal(pricedRows.length, 6);
  assert.equal(defined(pricedRows[0])[8], "50%");
  assert.equal(defined(pricedRows[1])[8], "—");
  assert.equal(defined(pricedRows[5])[0], "2 more");
  assert.equal(
    pricedRows.reduce((n, r) => n + shareNum(defined(r[6])), 0),
    100
  );

  const mixedRun = facts({
    invocations: [
      mega("alpha", "high", M, { provider: "claude" }),
      mega("beta", "low", M, { provider: "codex" }),
      mega("mystery", "low", 500, { provider: "p1" }),
      mega("mystery", "low", 400, { provider: "p2" }),
      mega("mystery", "low", 300, { provider: "p3" }),
      mega("mystery", "low", 200, { provider: "p4" }),
      mega("mystery", "low", 100, { provider: "p5" }),
    ],
  });

  const mixedRows = rows(costRender([mixedRun]));
  assert.equal(mixedRows.length, 6);
  assert.deepEqual(
    mixedRows.slice(2, 5).map((r) => r[6]),
    ["—", "—", "—"]
  );
  assert.equal(defined(mixedRows[5])[0], "2 more (2 unpriced)");
  assert.equal(defined(mixedRows[5])[6], "—");
  assert.equal(
    mixedRows.slice(0, 2).reduce((n, r) => n + shareNum(defined(r[6])), 0),
    100
  );

  const unpricedText = costRender([
    facts({
      invocations: [
        mega("mystery", "low", 300, { provider: "claude" }),
        mega("mystery", "high", 100, { provider: "codex" }),
      ],
    }),
  ]);

  const unpricedRows = rows(unpricedText);
  assert.deepEqual(
    unpricedRows.map((r) => defined(r[6]).split(" ").at(-1)),
    ["75%", "25%"]
  );

  const zeroPricedText = costRender([
    facts({
      invocations: [
        mega("zero", "low", 100, { provider: "claude" }),
        mega("mystery", "low", 500, { provider: "codex" }),
      ],
    }),
  ]);

  assert.deepEqual(
    rows(zeroPricedText).map((r) => [r[3], r[5], r[6]]),
    [
      ["zero (configured)", "~$0", "—"],
      ["mystery (configured)", "—", "—"],
    ]
  );

  const bareText = costRender([
    facts({ invocations: [bare({ provider: "codex" })] }),
  ]);

  assert.match(drivers(bareText), /No priced cost or billed tokens\./u);
  assert.equal(rows(bareText).length, 0);

  const outputOnlyText = costRender([
    facts({
      invocations: [
        mega("alpha", "low", 0, { usage: { input: 0, output: 100 } }),
      ],
    }),
  ]);

  assert.equal(defined(rows(outputOnlyText)[0])[8], "—");
});

test("Role cost and usage coverage reconcile", () => {
  // oxlint-disable-next-line eslint/no-shadow -- local fixture binding intentionally mirrors shared name
  const run = facts({
    hosts: ["claude", "codex"],
    hostUsage: {
      platform: "claude",
      rows: [
        {
          stage: "code review",
          role: "host",
          model: "zero",
          effort: null,
          input: 0,
          output: 0,
        },
      ],
    },
    invocations: [
      mega("alpha", "low", M, {
        usageSource: "session",
        reportedModels: ["beta"],
      }),
      mega("alpha", "low", 5, {
        usageSource: "stdout",
        coverage: ["transcript unavailable"],
        reportedModels: ["beta", "invalid model"],
      }),
      bare({ coverage: ["no usage"] }),
    ],
  });

  const text = costRender([run]);
  assert.match(
    text,
    /^\| Host \| ░░░░░░░░░░ 0% \| ~\$0 \| 0 \| .*host threads unmeasured/mu
  );
  assert.match(text, /^\| Subagents \| — \| — \| — \| .*unavailable/mu);
  assert.match(
    text,
    /^\| CLI delegates \| ██████████ 100% \| ~\$2\.00 \| 1,000,005 \| .*1 session.*1 stdout fallback.*1 unmeasured/mu
  );
  assert.match(text, /cost-midpoint share/u);
  assert.match(text, /1 observed unit unpriced/u);
});
