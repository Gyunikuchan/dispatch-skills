import { formatCost, sumCost } from "../../lib/pricing.ts";
import type { Cost, CostReason, Pricer } from "../../lib/pricing.ts";
import {
  addCounters,
  HOST_ROLES,
  MAX_RESPONSE_AGENTS,
  STAGE_ORDER,
  tokenTotal,
} from "../../lib/usage/rows.ts";
import type {
  CopilotEvidence,
  Counters,
  CoverageReason,
  ResponseCoverage,
} from "../../lib/usage/rows.ts";
import { defined } from "./defined.ts";
import {
  measured,
  opt,
  retroObservations,
  sanitizeFacts,
} from "./diagnostics-gates.ts";
import {
  bySeverity,
  num,
  pct,
  phaseName,
  plural,
  selectFindings,
  sum,
} from "./diagnostics-heuristics.ts";
import {
  addYield,
  CATEGORIES,
  completeDelegateResponses,
  DASH,
  DIAGNOSTIC_LIMITS,
  isSessionDelegate,
} from "./diagnostics-types.ts";
import type {
  DelegateResponseFacts,
  Finding,
  InvocationFacts,
  ModelUsage,
  PhaseFacts,
  RetroObservation,
  RunFacts,
  SlotYieldAttempt,
  SlotYieldFacts,
  Usage,
} from "./diagnostics-types.ts";

const APART = new Set(["opencode", "agy"]);

const reasoningApart = (
  platform: string,
  reasoningInOutput: boolean | undefined
) =>
  reasoningInOutput === undefined ? APART.has(platform) : !reasoningInOutput;

export const billedTokens = (
  u: Counters,
  platform: string,
  reasoningInOutput?: boolean
) =>
  tokenTotal(u) +
  (reasoningApart(platform, reasoningInOutput) ? (u.reasoning ?? 0) : 0);

interface UsageSample {
  usage: ModelUsage;
  platform: string;
  reasoningInOutput?: boolean | undefined;
}

interface Totals {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  all: number;
}

const totalsOf = (samples: readonly UsageSample[]) => {
  const acc: ModelUsage = { input: 0, output: 0 };
  let all = 0;

  for (const s of samples) {
    addCounters(acc, s.usage);
    all += billedTokens(s.usage, s.platform, s.reasoningInOutput);
  }

  return { ...acc, all };
};

const totals = (samples: readonly UsageSample[]) =>
  samples.length > 0 ? totalsOf(samples) : undefined;

/** `1h 4m 12s` | `45s` | `<1s`; unavailable renders `—`. */

export const formatDuration = (ms: number | undefined) => {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return DASH;
  }

  if (ms < 1000) {
    return "<1s";
  }

  const s = Math.floor(ms / 1000);

  const h = Math.floor(s / 3600);

  const m = Math.floor((s % 3600) / 60);

  if (h > 0) {
    return `${h}h ${m}m ${s % 60}s`;
  }

  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
};

const configuredModelOf = (model: string, configured: boolean | undefined) => {
  if (model === DASH) {
    return DASH;
  }

  return configured === true ? `${model} (configured)` : model;
};

export const heuristics = (run: RunFacts) =>
  selectFindings(run, formatDuration);

const md = (text: string) => text.replaceAll(/<(?=[A-Za-z/!?])/gu, "&lt;");
const cell = (text: string) => md(text).replaceAll("|", String.raw`\|`);
const row = (cells: readonly string[]) => `| ${cells.map(cell).join(" | ")} |`;

const tableHeader = (columns: readonly string[]) => [
  row(columns.map((column) => column.replace(/^:/u, ""))),
  row(columns.map((column) => (column.startsWith(":") ? "---:" : "---"))),
];

const tokenCells = (t: Totals | undefined, prefix = "") =>
  [t?.input, t?.cacheRead, t?.cacheWrite, t?.output].map((n) =>
    n === undefined ? DASH : `${prefix}${num(n)}`
  );

const unique = (values: readonly string[]) =>
  [...new Set(values)].join(", ") || DASH;

const clip = (text: string, max: number) =>
  Array.from(text).length > max
    ? `${Array.from(text)
        .slice(0, max - 1)
        .join("")}…`
    : text;

const sourceOf = (f: Finding) =>
  f.source === "retro" ? `host retro \`${f.id ?? DASH}\`` : f.source;

const summaryLine = (f: Finding) =>
  md(
    `${CATEGORIES[f.category]} · \`${f.component}\` · ${clip(f.evidence, 160)} (${f.source === "retro" ? "host retro" : f.source})`
  );

const midOf = (c: Cost) => (c.low + c.high) / 2;

const allDefinedSum = (values: readonly (number | undefined)[]) =>
  values.length && values.every((v) => v !== undefined)
    ? values.reduce<number>((a, v) => a + v, 0)
    : undefined;

const toolCell = (calls: number | undefined, turns: number | undefined) =>
  calls === undefined || turns === undefined
    ? DASH
    : `${num(calls)} (${num(turns)})`;

const hasAnyToken = (u: ModelUsage) =>
  u.input > 0 ||
  u.output > 0 ||
  (u.cacheWrite ?? 0) > 0 ||
  (u.reasoning ?? 0) > 0;

const cacheHitOf = (
  units: readonly { usage?: ModelUsage | undefined }[],
  scopePartial = false
) => {
  const reporting = units.flatMap((u) =>
    u.usage?.cacheRead === undefined ? [] : [u.usage]
  );

  if (!reporting.length) {
    return DASH;
  }

  const inp = reporting.reduce((n, usage) => n + usage.input, 0);
  const cr = reporting.reduce((n, usage) => n + (usage.cacheRead ?? 0), 0);
  const cw = reporting.reduce((n, usage) => n + (usage.cacheWrite ?? 0), 0);
  const d = inp + cr + cw;

  if (d === 0) {
    return DASH;
  }

  const missing =
    scopePartial ||
    units.some(
      (u) =>
        !u.usage || (u.usage.cacheRead === undefined && hasAnyToken(u.usage))
    );

  return `${pct(cr / d)}${missing ? " (partial)" : ""}`;
};

const shareBar = (percent: number | null) => {
  if (percent === null) {
    return DASH;
  }

  const filled =
    percent >= 1 ? Math.min(10, Math.max(1, Math.round(percent / 10))) : 0;

  return `${"█".repeat(filled)}${"░".repeat(10 - filled)} ${percent}%`;
};

const coverage = (items: readonly InvocationFacts[]) => {
  const launched = items.filter((i) => i.surface === "cli" && i.launched);

  return launched.length
    ? `${launched.filter((i) => measured(i)).length}/${launched.length}`
    : DASH;
};

const usageSamples = (items: readonly InvocationFacts[]) =>
  items.flatMap((i) => {
    const usage = measured(i);

    return usage
      ? [
          {
            usage,
            platform: i.provider,
            reasoningInOutput: usage.reasoningInOutput,
          },
        ]
      : [];
  });

interface Unit {
  platform: string;
  phase?: string;
  stage: string;
  role: string;
  model: string;
  effort: string;
  configured: boolean;
  usage?: ModelUsage;
  reasoningInOutput?: boolean;
  coverage?: readonly CoverageReason[];
  usageSource?: InvocationFacts["usageSource"];
  cost: Cost | undefined;
  row: boolean;
}

interface TurnRow {
  platform: string;
  stage: string;
  role: string;
  usage?: ModelUsage;
  reasoningInOutput?: boolean;
  cost: Cost | undefined;
  limited?: boolean;
}

const priceUnitFor = (
  pricer: Pricer,
  platform: string,
  model: string,
  usage: ModelUsage | undefined,
  inOutput: boolean | undefined,
  onDate: string | undefined
) => {
  if (usage && model !== DASH) {
    return pricer.price(
      model,
      usage,
      !reasoningApart(platform, inOutput),
      onDate
    );
  }

  return {
    low: 0,
    high: 0,
    priced: false,
    reasons: new Set<CostReason>([
      usage === undefined ? "no usage" : "unpriced model",
    ]),
  };
};

const priceUnit = (
  pricer: Pricer | undefined,
  platform: string,
  model: string,
  usage: ModelUsage | undefined,
  inOutput: boolean | undefined,
  onDate: string | undefined
) =>
  pricer
    ? priceUnitFor(pricer, platform, model, usage, inOutput, onDate)
    : undefined;

const stageForPhase = (run: RunFacts, phaseKey: string | undefined) => {
  const phase = run.phases.find((p) => p.key === phaseKey)?.name;

  return phase === "integration review"
    ? "code review"
    : (STAGE_ORDER.find((x) => x === phase) ?? DASH);
};

const delegateFallbackUsageFor = (i: {
  usage: Usage;
  usageSource?: InvocationFacts["usageSource"] | undefined;
  coverage?: readonly CoverageReason[] | undefined;
  responses?: readonly DelegateResponseFacts[] | undefined;
}) => {
  if (i.usageSource === "stdout") {
    const { turns: _t, toolCalls: _c, toolTurns: _tt, ...rest } = i.usage;

    return rest;
  }

  const delegates =
    i.usage.turns === undefined ? completeDelegateResponses(i) : undefined;

  if (!delegates) {
    return i.usage;
  }

  return {
    ...i.usage,
    turns: delegates.reduce((n, r) => n + r.observed, 0),
    ...opt("toolCalls", allDefinedSum(delegates.map((r) => r.toolCalls))),
    ...opt("toolTurns", allDefinedSum(delegates.map((r) => r.toolTurns))),
  };
};

const delegateFallbackUsage = (i: {
  usage?: Usage | undefined;
  usageSource?: InvocationFacts["usageSource"] | undefined;
  coverage?: readonly CoverageReason[] | undefined;
  responses?: readonly DelegateResponseFacts[] | undefined;
}) =>
  i.usage === undefined
    ? undefined
    : delegateFallbackUsageFor({ ...i, usage: i.usage });

const invocationUnits = (
  i: Omit<SlotYieldAttempt, "effort" | "usage"> & {
    effort?: string | null | undefined;
    usage?: Usage | undefined;
    responses?: readonly DelegateResponseFacts[];
  },
  stage: string,
  phase: string | undefined,
  pricer: Pricer | undefined,
  onDate: string | undefined
) => {
  const out: Unit[] = [];
  const { usage } = i;
  const effort = i.effort ?? DASH;

  const unit = (
    model: string,
    effortName: string,
    part: ModelUsage | undefined,
    configured = false
  ) => {
    const cleanPart =
      part && i.usageSource === "stdout"
        ? (() => {
            const { turns: _t, toolCalls: _c, toolTurns: _tt, ...rest } = part;

            return rest;
          })()
        : part;

    return {
      platform: i.provider,
      ...opt("phase", phase),
      stage,
      role: "delegate",
      model,
      effort: effortName,
      configured,
      ...(cleanPart && { usage: cleanPart }),
      ...(!(usage?.reasoningInOutput === undefined) && {
        reasoningInOutput: usage.reasoningInOutput,
      }),
      ...opt("coverage", i.coverage),
      ...opt("usageSource", i.usageSource),
      row: true,
      cost: priceUnit(
        pricer,
        i.provider,
        configured ? model.slice(model.lastIndexOf("/") + 1) : model,
        cleanPart,
        usage?.reasoningInOutput,
        onDate
      ),
    };
  };

  if (usage?.actors) {
    for (const actor of usage.actors) {
      const entry = unit(actor.model || DASH, actor.effort ?? DASH, actor);
      entry.role = actor.role;
      out.push(entry);
    }

    return out;
  }

  if (usage?.models) {
    for (const [key, part] of Object.entries(usage.models)) {
      const at = key.indexOf("#");
      out.push(
        unit(
          at === -1 ? key : key.slice(0, at) || DASH,
          at === -1 ? effort : key.slice(at + 1) || DASH,
          part
        )
      );
    }
  } else {
    const reported = i.reportedModels ?? [];
    const ambiguous = i.reportedModelAmbiguous ?? reported.length > 1;
    const [observed] = reported;
    out.push(
      unit(
        ambiguous ? DASH : (observed ?? i.model),
        effort,
        delegateFallbackUsage(i),
        !ambiguous && observed === undefined
      )
    );
  }

  return out;
};

export const unitsOf = (run: RunFacts, pricer: Pricer | undefined) => {
  const out: Unit[] = [];
  const hostPlatform = run.hostUsage?.platform ?? DASH;

  for (const h of run.hostUsage?.rows ?? []) {
    out.push({
      platform: hostPlatform,
      ...opt("phase", h.phase),
      stage: h.stage,
      role: h.role,
      model: h.model,
      effort: h.effort ?? DASH,
      configured: false,
      usage: h,
      ...(!(h.reasoningInOutput === undefined) && {
        reasoningInOutput: h.reasoningInOutput,
      }),
      row: true,
      cost: priceUnit(
        pricer,
        hostPlatform,
        h.model,
        h,
        h.reasoningInOutput,
        run.startedAt
      ),
    });
  }

  for (const i of run.invocations) {
    if (i.surface !== "cli" || !i.launched) {
      continue;
    }

    out.push(
      ...invocationUnits(
        { ...i, usage: measured(i) },
        stageForPhase(run, i.phase),
        i.phase,
        pricer,
        run.startedAt
      )
    );
  }

  return out;
};

const turnRowsOf = (run: RunFacts, units: readonly Unit[]) => {
  const out: TurnRow[] = units.map((u) => ({
    platform: u.platform,
    stage: u.stage,
    role: u.role,
    ...(u.usage && { usage: u.usage }),
    ...(!(u.reasoningInOutput === undefined) && {
      reasoningInOutput: u.reasoningInOutput,
    }),
    cost: u.cost,
  }));

  for (const i of run.invocations) {
    if (
      i.surface !== "cli" ||
      !i.launched ||
      (i.responses?.length ?? 0) === 0
    ) {
      continue;
    }

    if (measured(i)?.actors?.some((a) => a.role === "subagent") === true) {
      continue;
    }

    const stage = stageForPhase(run, i.phase);

    for (const r of i.responses ?? []) {
      if (r.role !== "subagent") {
        continue;
      }

      const codexLimited =
        r.basis === "codex-token-count" &&
        r.observed !== undefined &&
        isSessionDelegate(i);

      const turns =
        r.coverage === "complete" || codexLimited ? r.observed : undefined;

      out.push({
        platform: i.provider,
        stage,
        role: "subagent",
        cost: undefined,
        usage: {
          input: 0,
          output: 0,
          ...opt("turns", turns),
          ...opt("toolCalls", turns === undefined ? undefined : r.toolCalls),
          ...opt("toolTurns", turns === undefined ? undefined : r.toolTurns),
        },
        ...(codexLimited && { limited: true }),
      });
    }
  }

  return out;
};

const costsOf = (units: readonly { cost?: Cost | undefined }[]) =>
  units.flatMap((u) => u.cost ?? []);

const costText = (units: readonly { cost?: Cost | undefined }[]) =>
  formatCost(sumCost(costsOf(units)));

const ROLE_LABELS = {
  host: "Host",
  subagent: "Subagents",
  delegate: "CLI delegates",
} as const;

const isRole = (key: string): key is keyof typeof ROLE_LABELS =>
  Object.hasOwn(ROLE_LABELS, key);

const ROLE_KEYS = Object.keys(ROLE_LABELS).filter(isRole);
const STAGE_NAMES: readonly string[] = STAGE_ORDER;

const stageRank = (stage: string) => {
  const rank = STAGE_NAMES.indexOf(stage);

  return rank === -1 ? 99 : rank;
};

const byText = (a: string | null, b: string | null) => {
  const left = String(a);
  const right = String(b);

  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
};

const USAGE_SOURCES = [
  "session",
  "stdout",
  "stdout fallback",
  "legacy source unknown",
  "unmeasured",
] as const;

interface UsageEvidence {
  usage?: ModelUsage | undefined;
  usageSource?: InvocationFacts["usageSource"];
  coverage?: readonly CoverageReason[];
}

const sourceOfUsage = (item: UsageEvidence) => {
  if (!item.usage) {
    return "unmeasured";
  }

  if (
    item.usageSource === "stdout" &&
    item.coverage?.includes("transcript unavailable") === true
  ) {
    return "stdout fallback";
  }

  return item.usageSource ?? "legacy source unknown";
};

const sourcesOf = (items: readonly UsageEvidence[]) => {
  const counts = {
    session: 0,
    stdout: 0,
    "stdout fallback": 0,
    "legacy source unknown": 0,
    unmeasured: 0,
  };

  for (const item of items) {
    counts[sourceOfUsage(item)] += 1;
  }

  return counts;
};

const sourceCountsText = (counts: ReturnType<typeof sourcesOf>) =>
  USAGE_SOURCES.flatMap((source) =>
    counts[source] ? [`${num(counts[source])} ${source}`] : []
  );

const basesOf = (units: readonly Unit[]) =>
  units.flatMap((u) => u.cost?.rateBasis ?? []);

export const costCoverage = (
  runs: readonly RunFacts[],
  pricer: Pricer | undefined,
  units = runs.flatMap((run) => unitsOf(run, pricer))
) => {
  const costs = costsOf(units);

  const total = sumCost(costs);

  const delegates = runs.flatMap((run) =>
    run.invocations.filter((i) => i.surface === "cli" && i.launched)
  );

  const sources = sourcesOf(delegates);

  const delegateReasons = [
    ...new Set(delegates.flatMap((i) => i.coverage ?? [])),
  ].toSorted();

  const otherHostThreads = runs.some((run) => {
    const hosts =
      (run.hosts?.length ?? 0) > 0
        ? run.hosts
        : [run.host].filter((h): h is string => h !== undefined && h !== "");

    return (hosts ?? []).some((host) => host !== run.hostUsage?.platform);
  });

  const priced = costs.filter((c) => c.priced).length;
  const reasons = new Set<string>(total.reasons);
  let partial = !pricer || priced < costs.length;

  if (!pricer) {
    reasons.add("rate table unavailable");
  }

  if (total.low < total.high) {
    reasons.add("bounded cost range");
  }

  if (runs.some((run) => (run.collection?.partial ?? 0) > 0)) {
    partial = true;
    reasons.add("captures partial");
  }

  const roleGapsOf = (role: string, observedLength: number) => {
    const gaps = new Set<string>();

    if (role === "delegate") {
      if (sources.unmeasured) {
        gaps.add("delegate usage unavailable");
      }

      if (sources["legacy source unknown"]) {
        gaps.add("delegate legacy source unknown");
      }

      if (sources["stdout fallback"]) {
        gaps.add("delegate stdout fallback");
      }

      for (const reason of delegateReasons) {
        gaps.add(`delegate coverage: ${reason}`);
      }
    } else {
      if (
        runs.some(
          (run) =>
            (role === "host" && run.hostUsage?.unavailable !== undefined) ||
            run.hostUsage?.rows.some((entry) => entry.role === role) !== true
        )
      ) {
        gaps.add(
          role === "host"
            ? "host usage unavailable"
            : "subagent usage unavailable"
        );
      }

      if (role === "host" && otherHostThreads) {
        gaps.add("other host threads unmeasured");
      }

      if (role === "subagent" && observedLength > 0) {
        gaps.add("total subagent coverage unknown");
      }

      for (const run of runs) {
        for (const [noteRole, values] of Object.entries(
          run.hostUsage?.notes ?? {}
        )) {
          if (noteRole !== role) {
            continue;
          }

          for (const note of Object.keys(values ?? {})) {
            gaps.add(note);
          }
        }
      }
    }

    return gaps;
  };

  const roleCoverageNotesOf = (
    role: string,
    gaps: Set<string>,
    unpriced: number,
    observedLength: number
  ) => {
    const notes =
      role === "delegate"
        ? [...sourceCountsText(sources), ...delegateReasons]
        : [...gaps];

    if (unpriced > 0) {
      notes.push(`${plural(unpriced, "observed unit")} unpriced`);
    }

    if (role !== "delegate" && observedLength > 0) {
      notes.unshift(`${num(observedLength)} observed rows`);
    }

    if (role === "host") {
      const unavailable = [
        ...new Set(runs.flatMap((run) => run.hostUsage?.unavailable ?? [])),
      ].toSorted();

      notes.push(...unavailable);
    }

    return notes;
  };

  const roles = ROLE_KEYS.map((role) => {
    const own = units.filter((u) => u.role === role);
    const observed = own.filter((u) => u.usage);
    const cost = sumCost(costsOf(own));

    const tokens = observed.length
      ? observed.reduce(
          (n, u) =>
            n + billedTokens(defined(u.usage), u.platform, u.reasoningInOutput),
          0
        )
      : null;

    const gaps = roleGapsOf(role, observed.length);

    if (gaps.size > 0) {
      partial = true;
    }

    for (const gap of gaps) {
      reasons.add(gap);
    }

    const unpriced = own.filter(
      (u) => u.usage !== undefined && u.cost !== undefined && !u.cost.priced
    ).length;

    const coverageNotes = roleCoverageNotesOf(
      role,
      gaps,
      unpriced,
      observed.length
    );

    return { role, tokens, cost, coverage: coverageNotes };
  });

  const bases = basesOf(units);
  const days = [...new Set(bases.map((b) => b.effectiveDay))].toSorted(byText);
  const origins = [...new Set(bases.map((b) => b.origin))].toSorted();
  const matches = [...new Set(bases.map((b) => b.match))].toSorted();
  const periods = [...new Set(bases.map((b) => b.periodFrom))].toSorted(byText);
  const originCounts = { shipped: 0, override: 0 };
  const matchCounts = { qualified: 0, wildcard: 0, generic: 0 };

  for (const basis of bases) {
    originCounts[basis.origin] += 1;
    matchCounts[basis.match] += 1;
  }

  const rateBasis = {
    tableAsOf: pricer?.meta.asOf ?? null,
    effectiveDay: days.length === 1 ? (days[0] ?? null) : null,
    effectiveDays: days,
    origins,
    matches,
    periods,
    originCounts,
    matchCounts,
  };

  return {
    total,
    priced,
    unpriced: costs.length - priced,
    coverage: { partial, reasons: [...reasons].toSorted(), sources },
    rateBasis,
    roles,
  };
};

const rateNotes = (units: readonly Unit[]) => {
  const notes = new Set<string>();

  for (const { cost } of units) {
    const basis = cost?.rateBasis;

    if (basis && (basis.origin === "override" || basis.match !== "generic")) {
      notes.add(
        `${basis.origin} ${basis.match} rate (${basis.effectiveDay ?? "base fallback"})`
      );
    }
  }

  const labels = [...notes].toSorted();

  return labels.length > 8
    ? [...labels.slice(0, 8), `${labels.length - 8} more rate bases`]
    : labels;
};

const liftedRateNote = (units: readonly Unit[]) => {
  const days = [
    ...new Set(
      units.flatMap((u) => {
        const b = u.cost?.rateBasis;

        return b && b.origin === "shipped" && b.match === "generic"
          ? [b.effectiveDay ?? "base fallback"]
          : [];
      })
    ),
  ].toSorted();

  const label = days.length > 4 ? `${days.length} days` : days.join(", ");

  return days.length > 0
    ? `Rate note: shipped generic rate (${label}).`
    : undefined;
};

const knownSourceNotes = (units: readonly Unit[]) =>
  [
    ...new Set(units.flatMap((u) => (u.usageSource ? [sourceOfUsage(u)] : []))),
  ].toSorted();

const largestRemainder = (exact: readonly number[]) => {
  const parts = exact.map(Math.floor);
  const fraction = (k: number) => defined(exact[k]) - defined(parts[k]);

  const order = exact
    .map((_, k) => k)
    .toSorted((x, y) => fraction(y) - fraction(x) || x - y);

  for (
    let k = 0, left = 100 - parts.reduce((n, s) => n + s, 0);
    left > 0;
    left -= 1, k += 1
  ) {
    const index = defined(order[k % order.length]);
    parts[index] = defined(parts[index]) + 1;
  }

  return parts;
};

const computeShares = (
  groups: readonly { cost: Cost; tokens: number; hasUsage: boolean }[]
) => {
  const hasPriced = groups.some((g) => g.cost.priced);

  const total = hasPriced
    ? groups.filter((g) => g.cost.priced).reduce((n, g) => n + midOf(g.cost), 0)
    : groups.reduce((n, g) => n + g.tokens, 0);

  if (total === 0) {
    return groups.map(() => null);
  }

  const shareable = groups.flatMap((g, i) =>
    (hasPriced ? g.cost.priced : g.hasUsage) ? [i] : []
  );

  const parts = largestRemainder(
    shareable.map((i) => {
      const group = defined(groups[i]);

      return ((hasPriced ? midOf(group.cost) : group.tokens) / total) * 100;
    })
  );

  const out: (number | null)[] = groups.map(() => null);

  for (const [idx, gi] of shareable.entries()) {
    out[gi] = defined(parts[idx]);
  }

  return out;
};

const costDrivers = (units: readonly Unit[]) => {
  interface DriverGroup {
    key: string;
    stage: string;
    platform: string;
    role: string;
    model: string;
    effort: string;
    configured: boolean;
    units: Unit[];
    tokens: number;
  }

  const map = new Map<string, DriverGroup>();

  for (const u of units) {
    if (!u.row) {
      continue;
    }

    const key = [
      u.stage,
      u.platform,
      u.role,
      u.model,
      u.effort,
      String(u.configured),
    ].join("\0");

    const g = map.get(key) ?? {
      key,
      stage: u.stage,
      platform: u.platform,
      role: u.role,
      model: u.model,
      effort: u.effort,
      configured: u.configured,
      units: [],
      tokens: 0,
    };

    g.configured ||= u.configured;
    g.units.push(u);

    if (u.usage) {
      g.tokens += billedTokens(u.usage, u.platform, u.reasoningInOutput);
    }

    map.set(key, g);
  }

  const all = [...map.values()].map((g) => {
    const cost = sumCost(g.units.flatMap((u) => u.cost ?? []));

    return {
      ...g,
      cost,
      mid: cost.priced ? midOf(cost) : 0,
      hasUsage: g.units.some((u) => u.usage),
    };
  });

  const hasPriced = all.some((g) => g.cost.priced);
  const totalTokens = all.reduce((n, g) => n + g.tokens, 0);

  if (!hasPriced && totalTokens === 0) {
    return ["## Cost drivers", "", "No priced cost or billed tokens.", ""];
  }

  const byTokens = (a: (typeof all)[number], b: (typeof all)[number]) =>
    b.tokens - a.tokens || a.key.localeCompare(b.key);

  const ordered = hasPriced
    ? [
        ...all
          .filter((g) => g.cost.priced)
          .toSorted((a, b) => b.mid - a.mid || byTokens(a, b)),
        ...all.filter((g) => !g.cost.priced).toSorted(byTokens),
      ]
    : [...all].toSorted(byTokens);

  const listed = ordered.slice(0, 5);
  const rest = ordered.slice(5);
  const display = [...listed];

  if (rest.length > 0) {
    const restUnpriced = hasPriced
      ? rest.filter((g) => !g.cost.priced).length
      : 0;

    const label = restUnpriced
      ? `${rest.length} more (${restUnpriced} unpriced)`
      : `${rest.length} more`;

    display.push({
      key: "\u00FF",
      stage: label,
      platform: DASH,
      role: DASH,
      model: DASH,
      effort: DASH,
      configured: false,
      units: rest.flatMap((g) => g.units),
      tokens: rest.reduce((n, g) => n + g.tokens, 0),
      cost: sumCost(rest.flatMap((g) => g.units.flatMap((u) => u.cost ?? []))),
      mid: 0,
      hasUsage: rest.some((g) => g.hasUsage),
    });
  }

  const shares = computeShares(display);

  const evidence = (own: readonly Unit[]) =>
    [...knownSourceNotes(own), ...rateNotes(own)].join(", ") || DASH;

  const rows = display.map((g, idx) =>
    row([
      g.stage,
      g.platform,
      g.role,
      configuredModelOf(g.model, g.configured),
      g.effort,
      formatCost(g.cost),
      shareBar(shares[idx] ?? null),
      g.hasUsage ? num(g.tokens) : DASH,
      cacheHitOf(g.units),
      num(allDefinedSum(g.units.map((u) => u.usage?.turns))),
      evidence(g.units),
    ])
  );

  const note = liftedRateNote(units);

  return [
    "## Cost drivers",
    "",
    ...tableHeader([
      "Stage",
      "Platform",
      "Role",
      "Model",
      "Effort",
      ":Cost",
      "Share",
      ":Billed tokens",
      ":Cache hit",
      ":LLM turns",
      "Evidence",
    ]),
    ...rows,
    ...(note === undefined || note === "" ? [] : ["", note]),
    "",
  ];
};

type ResponseEvidence = Omit<DelegateResponseFacts, "role"> & {
  role: "host" | "subagent" | "delegate";
};

const registerResponse = (
  entry: ResponseEvidence,
  aliases: Map<string, string>,
  runCount: number,
  index: number
) => {
  const { agent, ...rest } = entry;

  if (agent === undefined || agent === "") {
    return rest;
  }

  let label = aliases.get(agent);

  if (
    (label === undefined || label === "") &&
    aliases.size < MAX_RESPONSE_AGENTS
  ) {
    label = `${agent.startsWith("delegate-child-") ? "delegate-child" : entry.role}-${aliases.size + 1}`;
    aliases.set(agent, label);
  }

  return label === undefined || label === ""
    ? {
        ...rest,
        coverage: entry.coverage === "complete" ? "partial" : entry.coverage,
      }
    : {
        ...rest,
        agent: runCount > 1 ? `run ${index + 1} ${label}` : label,
      };
};

const responseEvidence = (runs: readonly RunFacts[]) => {
  const rows: ResponseEvidence[] = [];
  const unknownScopes = new Set<string>();

  const unknown = (
    role: ResponseEvidence["role"],
    stage: ResponseEvidence["stage"] = "unattributed"
  ) => {
    const scope = `${role}|${stage}`;

    if (unknownScopes.has(scope)) {
      return;
    }

    unknownScopes.add(scope);
    rows.push({ role, stage, basis: "unavailable", coverage: "unknown" });
  };

  const addHostGaps = (
    run: RunFacts,
    host: readonly { role: string }[],
    markUnknown: (
      role: ResponseEvidence["role"],
      stage?: ResponseEvidence["stage"]
    ) => void
  ) => {
    if (
      !host.some((entry) => entry.role === "host") ||
      Object.keys(run.hostUsage?.notes?.host ?? {}).length
    ) {
      markUnknown("host");
    }

    if (
      !host.some((entry) => entry.role === "subagent") ||
      Object.keys(run.hostUsage?.notes?.subagent ?? {}).length
    ) {
      markUnknown("subagent");
    }
  };

  const addInvocationResponses = (
    invocation: InvocationFacts,
    phaseNames: Map<string, string | undefined>,
    register: (entry: ResponseEvidence) => ResponseEvidence,
    markUnknown: (
      role: ResponseEvidence["role"],
      stage?: ResponseEvidence["stage"]
    ) => void,
    targetRows: ResponseEvidence[]
  ) => {
    if (invocation.surface !== "cli" || !invocation.launched) {
      return;
    }

    const phase = phaseNames.get(invocation.phase);

    const stage =
      phase === "integration review"
        ? "code review"
        : (STAGE_ORDER.find((candidate) => candidate === phase) ??
          "unattributed");

    const responses = invocation.responses ?? [];

    if (responses.length > 0) {
      targetRows.push(...responses.map(register));
    } else {
      markUnknown("delegate", stage);
    }
  };

  for (const [index, run] of runs.entries()) {
    const aliases = new Map<string, string>();

    const register = (entry: ResponseEvidence) =>
      registerResponse(entry, aliases, runs.length, index);

    const host = run.hostUsage?.responses ?? [];
    rows.push(...host.map(register));

    addHostGaps(run, host, unknown);

    const phaseNames = new Map(
      run.phases.map((phase) => [phase.key, phase.name])
    );

    for (const invocation of run.invocations) {
      addInvocationResponses(invocation, phaseNames, register, unknown, rows);
    }

    if ((run.collection?.partial ?? 0) > 0) {
      unknown("delegate");
    }
  }

  return rows;
};

const responseTotals = (rows: readonly ResponseEvidence[]) => {
  const observed = sum(rows.map((entry) => entry.observed)) ?? null;

  const matched = rows.filter(
    (entry) =>
      entry.observed !== undefined &&
      entry.uncachedInput !== undefined &&
      (entry.observed > 0 || entry.uncachedInput === 0)
  );

  const matchedObserved = sum(matched.map((entry) => entry.observed)) ?? null;

  const matchedUncachedInput =
    sum(matched.map((entry) => entry.uncachedInput)) ?? null;

  const toolCalls = allDefinedSum(rows.map((entry) => entry.toolCalls)) ?? null;
  const toolTurns = allDefinedSum(rows.map((entry) => entry.toolTurns)) ?? null;

  let responseCoverage: ResponseCoverage = "partial";

  if (observed === null) {
    responseCoverage = "unknown";
  } else if (
    rows.every(
      (entry) => entry.coverage === "complete" && entry.observed !== undefined
    )
  ) {
    responseCoverage = "complete";
  }

  return {
    observed,
    matchedObserved,
    matchedUncachedInput,
    coverage: responseCoverage,
    toolCalls,
    toolTurns,
    uncachedInputPerResponse:
      matchedObserved !== null &&
      matchedObserved !== 0 &&
      matchedUncachedInput !== null
        ? matchedUncachedInput / matchedObserved
        : null,
  };
};

const groupResponses = (
  rows: readonly ResponseEvidence[],
  agentDetail: boolean
) => {
  const groups = new Map<string, ResponseEvidence[]>();

  for (const entry of rows) {
    const key = [
      entry.stage,
      entry.role,
      entry.basis,
      agentDetail ? (entry.agent ?? "Unnamed or folded") : "",
    ].join("|");

    const group = groups.get(key);

    if (group) {
      group.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }

  return [...groups.entries()].map(([key, entries]) => {
    const [stage = "", role = "", basis = "", agent] = key.split("|");

    return {
      stage,
      role,
      basis,
      ...opt("agent", agent === undefined || agent === "" ? undefined : agent),
      ...responseTotals(entries),
    };
  });
};

const failureCauses = new Set([
  "quota",
  "context-overflow",
  "auth",
  "model-not-found",
  "cli-outdated",
  "model-not-loaded",
  "sandbox-unsupported",
  "not-found",
  "timeout",
  "buffer",
  "empty-output",
  "capacity",
  "refusal",
  "no-report",
  "blocked",
  "truncated",
  "integrity",
  "config",
]);

const attemptCauseOf = (
  attempt: InvocationFacts,
  prior: InvocationFacts | undefined
) => {
  if (attempt.superseded === true) {
    return { cause: "superseded generation", rework: 1, extra: 0 };
  }

  if (
    prior !== undefined ||
    (attempt.targetSlot !== undefined && attempt.targetSlot !== "")
  ) {
    const outcome =
      prior?.outcome === "ok" ? prior.validationOutcome : prior?.outcome;

    const validation =
      prior?.validationOutcome !== undefined &&
      prior.validationOutcome !== "" &&
      prior.validationOutcome !== "ok";

    let cause = "unknown cause";

    if (outcome !== undefined && outcome !== "" && failureCauses.has(outcome)) {
      cause = outcome;
    } else if (validation) {
      cause = "validation";
    } else if (attempt.targetSlot !== undefined && attempt.targetSlot !== "") {
      cause = "reserve or fallback";
    }

    return { cause, rework: 0, extra: 1 };
  }

  if (attempt.nudge === true) {
    return { cause: "nudge", rework: 0, extra: 0 };
  }

  if (attempt.wrapUp === true) {
    return { cause: "wrap-up", rework: 0, extra: 0 };
  }

  return { cause: undefined, rework: 0, extra: 0 };
};

const recoveryOf = (runs: readonly RunFacts[], pricer?: Pricer) => {
  const groups = new Map<string, { units: Unit[]; count: number }>();
  const wasteUnits: Unit[] = [];
  let extraLaunches = 0;
  let reworkLaunches = 0;
  let nudges = 0;
  let wrapUps = 0;
  const writerRelaunches = sum(runs.map((run) => run.relaunches)) ?? null;

  for (const run of runs) {
    const previous = new Map<string, InvocationFacts>();

    for (const attempt of run.invocations) {
      if (attempt.surface !== "cli") {
        continue;
      }

      const slot = attempt.targetSlot ?? attempt.slot;

      const key =
        slot === undefined || slot === ""
          ? undefined
          : `${attempt.subject ?? attempt.phase}|${slot}`;

      const prior = key === undefined ? undefined : previous.get(key);

      if (key !== undefined) {
        previous.set(key, attempt);
      }

      if (!attempt.launched) {
        continue;
      }

      if (attempt.nudge === true) {
        nudges += 1;
      }

      if (attempt.wrapUp === true) {
        wrapUps += 1;
      }

      const { cause, rework, extra } = attemptCauseOf(attempt, prior);

      reworkLaunches += rework;
      extraLaunches += extra;

      if (cause === undefined || cause === "") {
        continue;
      }

      const units = invocationUnits(
        { ...attempt, usage: measured(attempt) },
        "unattributed",
        attempt.phase,
        pricer,
        run.startedAt
      );

      wasteUnits.push(...units);
      const group = groups.get(cause) ?? { units: [], count: 0 };
      group.count += 1;
      group.units.push(...units);
      groups.set(cause, group);
    }
  }

  const byCauseOf = () =>
    Object.fromEntries(
      [...groups.entries()]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([cause, group]) => {
          const costs = costsOf(group.units);

          const cost = sumCost(costs);

          const partial = group.units.some(
            (unit) =>
              (unit.coverage?.length ?? 0) > 0 || unit.cost?.priced === false
          );

          return [
            cause,
            {
              count: group.count,
              cost: cost.priced
                ? { low: cost.low, high: cost.high, partial }
                : null,
            },
          ];
        })
    );

  const byCause = byCauseOf();

  const collectionCoverageOf = (): "partial" | "observed" | "unknown" => {
    let state: "partial" | "observed" | "unknown" = "unknown";

    if (runs.some((run) => (run.collection?.partial ?? 0) > 0)) {
      state = "partial";
    } else if (
      runs.some((run) =>
        run.invocations.some(
          (attempt) => attempt.surface === "cli" && attempt.launched
        )
      )
    ) {
      state = "observed";
    }

    return state;
  };

  const collectionCoverage = collectionCoverageOf();

  const allUnits = runs.flatMap((run) => unitsOf(run, pricer));
  const totalCost = sumCost(costsOf(allUnits));
  const wasteSum = sumCost(costsOf(wasteUnits));
  const denomPartial = costCoverage(runs, pricer, allUnits).coverage.partial;

  const finishRecovery = () => {
    const wastePartial =
      wasteUnits.some(
        (u) => (u.coverage?.length ?? 0) > 0 || u.cost?.priced === false
      ) || denomPartial;

    const wasteCostOf = (collection: typeof collectionCoverage) => {
      if (collection === "unknown") {
        return null;
      }

      if (wasteUnits.length === 0) {
        return { low: 0, high: 0, partial: false };
      }

      return wasteSum.priced
        ? {
            low: wasteSum.low,
            high: wasteSum.high,
            partial: wasteUnits.some(
              (u) => (u.coverage?.length ?? 0) > 0 || u.cost?.priced === false
            ),
          }
        : null;
    };

    const wasteCost = wasteCostOf(collectionCoverage);

    const wasteShare =
      wasteCost && totalCost.priced && midOf(totalCost) > 0
        ? midOf({ ...wasteCost, priced: true, reasons: new Set() }) /
          midOf(totalCost)
        : null;

    return {
      extraLaunches: collectionCoverage === "unknown" ? null : extraLaunches,
      reworkLaunches: collectionCoverage === "unknown" ? null : reworkLaunches,
      nudges: collectionCoverage === "unknown" ? null : nudges,
      wrapUps: collectionCoverage === "unknown" ? null : wrapUps,
      writerRelaunches,
      coverage: collectionCoverage,
      byCause,
      wasteCost,
      wasteShare,
      wastePartial,
    };
  };

  return finishRecovery();
};

const criticalPathOf = (runs: readonly RunFacts[]) =>
  runs.flatMap((run) =>
    (run.roundTiming ?? []).map(({ review, round, slots }) => {
      let first = Infinity;
      let last = -Infinity;
      let finishingSlot: string | null = null;

      for (const { slot, attempts } of slots) {
        if (slot === DASH) {
          return { review, round, elapsedMs: null, finishingSlot: null };
        }

        for (const { surface, startMs, endMs } of attempts) {
          if (surface === "native") {
            continue;
          }

          if (
            surface !== "cli" ||
            startMs === undefined ||
            endMs === undefined ||
            endMs < startMs
          ) {
            return { review, round, elapsedMs: null, finishingSlot: null };
          }

          first = Math.min(first, startMs);

          if (endMs > last) {
            last = endMs;
            finishingSlot = slot;
          }
        }
      }

      return {
        review,
        round,
        elapsedMs: finishingSlot === null ? null : last - first,
        finishingSlot,
      };
    })
  );

/** Efficiency from sanitized observations. Ratios use only events with paired input. */
export const efficiencyOf = (runs: readonly RunFacts[], pricer?: Pricer) => {
  const responses = responseEvidence(runs);

  const {
    observed,
    matchedObserved,
    coverage: responseCoverage,
    matchedUncachedInput,
    uncachedInputPerResponse,
  } = responseTotals(responses);

  const rounds = runs.flatMap((run) => run.reviews);

  const recurring =
    rounds.length && rounds.every((round) => round.recurring !== undefined)
      ? (sum(rounds.map((round) => round.recurring)) ?? null)
      : null;

  return {
    responseEvents: {
      observed,
      matchedObserved,
      coverage: responseCoverage,
      byStageRole: groupResponses(responses, false),
    },
    matchedUncachedInput,
    uncachedInputPerResponse,
    responses,
    recovery: recoveryOf(runs, pricer),
    criticalPath: criticalPathOf(runs),
    reviewOutcomes: rounds.length
      ? {
          rounds: rounds.length,
          accepted: sum(rounds.map((round) => round.accepted)),
          rejected: sum(rounds.map((round) => round.rejected)),
          recurring,
        }
      : null,
  };
};

interface Foldable {
  units: readonly Unit[];
  tokens: number;
  key: string;
}

const FOLD_ORDER = [
  "responses",
  "timing",
  "workload",
  "copilot",
  "phase",
  "stage",
  "platform",
  "health",
  "yield",
] as const;

type FoldTable = (typeof FOLD_ORDER)[number];

type Fold = Partial<Record<FoldTable, number>>;

const foldTable = <R extends Foldable>(
  rows: readonly R[],
  keep: number | undefined,
  merge: (rest: R[]) => R,
  pinned: (row: R) => boolean = () => false
) => {
  const free = rows.filter((r) => !pinned(r));

  if (keep === undefined || keep >= free.length) {
    return [...rows];
  }

  const best = free
    .map((r) => ({ r, c: sumCost(r.units.flatMap((u) => u.cost ?? [])) }))
    .toSorted(
      (a, b) =>
        b.c.high - a.c.high ||
        b.c.low - a.c.low ||
        b.r.tokens - a.r.tokens ||
        (a.r.key < b.r.key ? -1 : 1)
    );

  const kept = new Set(best.slice(0, keep).map(({ r }) => r));

  return [
    ...rows.filter((r) => pinned(r) || kept.has(r)),
    merge(free.filter((r) => !kept.has(r))),
  ];
};

const smaller = (rest: readonly unknown[]) => `${rest.length} smaller rows`;

type PhaseRow = Foldable & {
  label: string;
  phase: string;
  outcome?: string;
  timing: readonly (number | undefined)[];
  items: readonly InvocationFacts[];
  pinned: boolean;
};

const observedNumber = (n: number | null) => (n === null ? DASH : num(n));

const responseCells = (entry: ReturnType<typeof responseTotals>) => [
  observedNumber(entry.observed),
  entry.coverage === "unknown" ? "unavailable" : entry.coverage,
  observedNumber(entry.matchedObserved),
  observedNumber(entry.matchedUncachedInput),
  entry.uncachedInputPerResponse === null
    ? DASH
    : entry.uncachedInputPerResponse.toFixed(2),
  toolCell(entry.toolCalls ?? undefined, entry.toolTurns ?? undefined),
];

const overviewPhase = (p: PhaseFacts) => {
  if (/^review-[a-f0-9]{16}$/u.test(p.key)) {
    return `${p.name} · subject ${p.key.slice(7)}`;
  }

  return p.key === p.name || p.key === p.name.replaceAll(" ", "-")
    ? p.name
    : `${p.name} · ${p.key}`;
};

const sampleCells = (samples: UsageSample[]) => {
  const t = totals(samples);

  return [
    ...tokenCells(t),
    t?.reasoning === undefined ? DASH : num(t.reasoning),
  ];
};

const aggTurns = (
  vals: readonly (number | undefined)[],
  forcePartial = false
) => {
  const total = sum(vals);

  if (total === undefined) {
    return DASH;
  }

  return `${num(total)}${forcePartial || vals.some((v) => v === undefined) ? " partial" : ""}`;
};

// oxlint-disable-next-line eslint/complexity -- section assembly branches per run phase shape, fault presence, and unit-row coverage.
const buildSections = (
  runs: readonly RunFacts[],
  efficiency: ReturnType<typeof efficiencyOf>,
  grounding: readonly (RetroObservation & { run: number })[],
  runUnits: readonly (readonly Unit[])[],
  metadataLines: readonly string[],
  pricer?: Pricer
) => {
  const singleRun = runs.length === 1;
  const allUnits = runUnits.flat();
  const notes: string[] = [];
  const phaseRows: PhaseRow[] = [];

  for (const [index, run] of runs.entries()) {
    const label = `${index + 1} · ${run.verb ?? DASH} · ${run.level ?? DASH}`;
    const units = defined(runUnits[index]);

    const mkRow = (
      phase: string,
      outcome: string | undefined,
      timing: readonly (number | undefined)[],
      items: readonly InvocationFacts[],
      own: readonly Unit[],
      key?: string
    ) => ({
      label,
      phase,
      ...opt("outcome", outcome),
      timing,
      items,
      units: own,
      tokens: totals(usageSamples(items))?.all ?? 0,
      key: `${index}\0${key ?? ""}`,
      pinned: key === undefined,
    });

    phaseRows.push(
      ...run.phases.map((p) =>
        mkRow(
          overviewPhase(p),
          p.outcome,
          [p.wallMs, p.driverMs, p.hostMs, p.userMs],
          run.invocations.filter((i) => i.phase === p.key),
          units.filter((u) => u.phase === p.key),
          p.key
        )
      )
    );

    const known = (phase: string | undefined) =>
      run.phases.some((p) => p.key === phase);

    const unmatched = run.invocations.filter((i) => !known(i.phase));
    const before = units.filter((u) => !known(u.phase));

    if (before.length) {
      phaseRows.push(
        mkRow(
          "unattributed phase",
          undefined,
          [undefined, undefined, undefined, undefined],
          unmatched,
          before
        )
      );
    }

    if (run.phases.length !== 1 || unmatched.length || before.length) {
      phaseRows.push(
        mkRow(
          "all phases",
          run.outcome,
          (["wallMs", "driverMs", "hostMs", "userMs"] as const).map((k) =>
            sum(run.phases.map((p) => p[k]))
          ),
          run.invocations,
          units
        )
      );
    }

    if (run.fault) {
      notes.push(
        `- Run ${index + 1} fault: \`${run.fault.cls}\`${run.fault.effectId === undefined || run.fault.effectId === "" ? "" : ` in \`${run.fault.effectId}\``}; ${run.fault.waitBy === "user" ? "user" : "host"} wait ${formatDuration(run.fault.hostWaitMs)}; driver ${formatDuration(run.fault.driverMs)}.`
      );
    }
  }

  const TIMING_COLS = ["Wall", "Driver", "Host", "User wait"] as const;

  const showTiming = TIMING_COLS.map((_, idx) =>
    phaseRows.some((r) => r.timing[idx] !== undefined)
  );

  const mergePhases = (rest: PhaseRow[]) => ({
    label: DASH,
    phase: smaller(rest),
    timing: [0, 1, 2, 3].map((k) => sum(rest.map((r) => r.timing[k]))),
    items: rest.flatMap((r) => r.items),
    units: rest.flatMap((r) => r.units),
    tokens: 0,
    key: "",
    pinned: false,
  });

  interface TokenRow {
    stage: string;
    platform: string;
    role: string;
    model: string;
    effort: string;
    configured: boolean;
    samples: UsageSample[];
    measured: number;
    launched: number;
    coverageReasons: Set<CoverageReason>;
    costNotes: Set<string>;
    units: Unit[];
    tokens: number;
    key: string;
    coverage?: string;
  }

  const rows = new Map<string, TokenRow>();

  for (const u of allUnits) {
    if (!u.row) {
      continue;
    }

    const key = [
      u.stage,
      u.platform,
      u.role,
      u.model,
      u.effort,
      String(u.configured),
    ].join("\0");

    const entry = rows.get(key) ?? {
      stage: u.stage,
      platform: u.platform,
      role: u.role,
      model: u.model,
      effort: u.effort,
      configured: u.configured,
      samples: [],
      measured: 0,
      launched: 0,
      coverageReasons: new Set<CoverageReason>(),
      costNotes: new Set<string>(),
      units: [],
      tokens: 0,
      key,
    };

    entry.launched += 1;
    entry.units.push(u);

    if (u.usage) {
      entry.measured += 1;
      entry.samples.push({
        usage: u.usage,
        platform: u.platform,
        reasoningInOutput: u.reasoningInOutput,
      });
      entry.tokens += billedTokens(u.usage, u.platform, u.reasoningInOutput);
    }

    for (const reason of u.coverage ?? []) {
      entry.coverageReasons.add(reason);
    }

    for (const reason of u.cost?.reasons ?? []) {
      entry.costNotes.add(reason);
    }

    rows.set(key, entry);
  }

  const sorted = [...rows.values()].toSorted(
    (a, b) =>
      stageRank(a.stage) - stageRank(b.stage) ||
      a.platform.localeCompare(b.platform) ||
      ["host", "subagent", "delegate"].indexOf(a.role) -
        ["host", "subagent", "delegate"].indexOf(b.role) ||
      a.model.localeCompare(b.model) ||
      a.effort.localeCompare(b.effort)
  );

  const platforms = new Set([
    ...sorted.map((r) => r.platform),
    ...runs.flatMap((r) => (r.hostUsage ? [r.hostUsage.platform ?? DASH] : [])),
    ...allUnits.map((u) => u.platform),
  ]);

  const coverageRow = (r: TokenRow) =>
    [
      r.coverage ??
        (r.role === "delegate"
          ? `${r.measured}/${r.launched}${r.coverageReasons.size ? ` ${[...r.coverageReasons].join(", ")}` : ""}`
          : DASH),
      ...knownSourceNotes(r.units),
    ].join(" · ");

  const costNotesRow = (r: TokenRow) =>
    [...r.costNotes, ...rateNotes(r.units)].join(", ") || DASH;

  type PlatformRow = Foldable & {
    platform: string;
    samples: UsageSample[];
    segments: string[];
    costNotes: string[];
  };

  const platformRows: PlatformRow[] = [];

  for (const platform of [...platforms].toSorted()) {
    const selected = sorted.filter((r) => r.platform === platform);

    const hosts = runs.flatMap((r) =>
      r.hostUsage && (r.hostUsage.platform ?? DASH) === platform
        ? [r.hostUsage]
        : []
    );

    const segments: string[] = [];

    for (const role of HOST_ROLES) {
      const roleRows = selected.filter((r) => r.role === role);

      const roleNotes = hosts.flatMap((h) =>
        Object.entries(h.notes?.[role] ?? {})
      );

      const aggregated = new Map<string, number>();

      for (const [key, n] of roleNotes) {
        aggregated.set(key, (aggregated.get(key) ?? 0) + n);
      }

      const noteText = aggregated.size
        ? ` (${[...aggregated].map(([key, n]) => `${key} ${n}`).join(", ")})`
        : "";

      if (role === "host" && hosts.length) {
        const reasons = [
          ...new Set(
            hosts.flatMap((h) => (h.unavailable ? [h.unavailable] : []))
          ),
        ];

        if (roleRows.length) {
          segments.push(`host measured${noteText}`);
        }

        if (reasons.length) {
          segments.push(
            `host unavailable: ${reasons.join(", ")}${roleRows.length ? "" : noteText}`
          );
        } else if (!roleRows.length) {
          segments.push(`host unavailable: no usage records${noteText}`);
        }
      }

      if (role === "subagent" && (roleRows.length || aggregated.size)) {
        segments.push(
          `${roleRows.length ? "subagents measured" : "subagents not measured"}${noteText}`
        );
      }
    }

    const delegates = runs
      .flatMap((r) => r.invocations)
      .filter(
        (i) => i.provider === platform && i.surface === "cli" && i.launched
      );

    if (delegates.length) {
      const reasons = [...new Set(delegates.flatMap((i) => i.coverage ?? []))];
      segments.push(
        `delegates ${delegates.filter((i) => measured(i)).length}/${delegates.length}${reasons.length ? ` ${reasons.join(", ")}` : ""}`
      );
    }

    const mine = allUnits.filter((u) => u.platform === platform);

    const costNotes = [
      ...new Set(mine.flatMap((u) => [...(u.cost?.reasons ?? [])])),
    ];

    const samples = selected.flatMap((r) => r.samples);
    platformRows.push({
      platform,
      samples,
      segments,
      costNotes,
      units: mine,
      tokens: samples.reduce(
        (n, s) => n + billedTokens(s.usage, s.platform, s.reasoningInOutput),
        0
      ),
      key: platform,
    });
  }

  const mergePlatforms = (rest: PlatformRow[]) => ({
    platform: smaller(rest),
    samples: rest.flatMap((r) => r.samples),
    segments: [...new Set(rest.flatMap((r) => r.segments))],
    costNotes: [...new Set(rest.flatMap((r) => r.costNotes))],
    units: rest.flatMap((r) => r.units),
    tokens: 0,
    key: "",
  });

  const mergeStages = (rest: TokenRow[]): TokenRow => {
    const delegates = rest.filter((r) => r.role === "delegate");

    const covReasons = [
      ...new Set(rest.flatMap((r) => [...r.coverageReasons])),
    ].join(", ");

    return {
      stage: smaller(rest),
      platform: DASH,
      role: DASH,
      model: DASH,
      effort: DASH,
      configured: false,
      samples: rest.flatMap((r) => r.samples),
      measured: 0,
      launched: 0,
      coverageReasons: new Set<CoverageReason>(),
      costNotes: new Set(rest.flatMap((r) => [...r.costNotes])),
      units: rest.flatMap((r) => r.units),
      tokens: 0,
      key: "",
      coverage: delegates.length
        ? `${delegates.reduce((n, r) => n + r.measured, 0)}/${delegates.reduce((n, r) => n + r.launched, 0)}${covReasons ? ` ${covReasons}` : ""}`
        : covReasons || DASH,
    };
  };

  const yields = new Map<string, SlotYieldFacts>();
  const yieldUnits = new Map<string, Unit[]>();

  for (const run of runs) {
    for (const yRow of run.slotYield ?? []) {
      const key = [yRow.kind, yRow.provider, yRow.model ?? ""].join("\0");

      const units = (yRow.attempts ?? []).flatMap((a) =>
        invocationUnits(a, "code review", undefined, pricer, run.startedAt)
      );

      if (units.length) {
        yieldUnits.set(key, [...(yieldUnits.get(key) ?? []), ...units]);
      }

      const current = yields.get(key);

      if (!current) {
        yields.set(key, {
          ...yRow,
          raised: { ...yRow.raised },
          ...(yRow.attempts && { attempts: [...yRow.attempts] }),
        });
        continue;
      }

      addYield(current, yRow);
    }
  }

  const yieldRows = [...yields.values()].toSorted(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.provider.localeCompare(b.provider) ||
      (a.model ?? "").localeCompare(b.model ?? "")
  );

  const showFixInduced = yieldRows.some((entry) => (entry.fixInduced ?? 0) > 0);

  const yieldLines = yieldRows.map((entry) => {
    const key = [entry.kind, entry.provider, entry.model ?? ""].join("\0");
    const units = yieldUnits.get(key) ?? [];
    const totalCost = sumCost(units.flatMap((u) => u.cost ?? []));

    const partial =
      entry.measured < entry.launched ||
      units.some((u) => (u.coverage?.length ?? 0) > 0)
        ? " partial"
        : "";

    const costPartial =
      partial ||
      (units.some((u) => u.cost !== undefined && !u.cost.priced)
        ? " partial"
        : "");

    const costCell = `${formatCost(totalCost)}${totalCost.priced ? costPartial : ""}`;

    let costPerAccepted = "0 accepted";

    if (entry.accepted !== 0) {
      costPerAccepted = totalCost.priced
        ? `${formatCost({ ...totalCost, low: totalCost.low / entry.accepted, high: totalCost.high / entry.accepted })}${costPartial}`
        : DASH;
    }

    const models = [
      ...new Set(
        units
          .filter(
            (u) => u.usage !== undefined && u.model !== DASH && !u.configured
          )
          .map((u) => u.model)
      ),
    ];

    const costNotes =
      [
        ...totalCost.reasons,
        ...rateNotes(units),
        ...knownSourceNotes(units),
        ...(models.length && models.some((m) => m !== entry.model)
          ? [`reported: ${models.join(", ")}`]
          : []),
        ...(entry.priorLaunches !== undefined && entry.priorLaunches !== 0
          ? [`${entry.priorLaunches} prior-generation launches excluded`]
          : []),
      ].join(", ") || DASH;

    let model = entry.model ?? DASH;

    if (entry.kind === "native") {
      model = "native";
    } else if (entry.kind === "tool") {
      model = DASH;
    }

    const msc = `${entry.raised.MUST}/${entry.raised.SHOULD}/${entry.raised.CONSIDER}`;

    return row([
      entry.provider,
      model,
      msc,
      ...(showFixInduced ? [String(entry.fixInduced ?? 0)] : []),
      String(entry.accepted),
      String(entry.rejected),
      String(entry.duplicate),
      costCell,
      costPerAccepted,
      costNotes,
    ]);
  });

  const timing = runs.flatMap((run) => run.roundTiming ?? []);
  const workload = runs.flatMap((run) => run.roundWorkload ?? []);
  const reviews = runs.flatMap((run) => run.reviews);

  const hasReviewHealth =
    reviews.length > 0 ||
    timing.length > 0 ||
    workload.length > 0 ||
    yieldRows.length > 0;

  const healthRows: string[] = [];
  const reviewKeys = new Set<string>();

  const roundEntries: {
    run: number;
    review: string;
    round: number;
    totalRounds: number;
    spanText: string;
    hostTurns?: number;
    revTurns?: number;
    revPartial: boolean;
    accepted?: number;
    rejected?: number;
    recurring?: number;
  }[] = [];

  for (const [runIndex, run] of runs.entries()) {
    const rReviews = run.reviews;
    const rTiming = run.roundTiming ?? [];
    const rWorkload = run.roundWorkload ?? [];
    const rCrit = criticalPathOf([run]);

    for (const rk of new Set([
      ...rReviews.map((r) => r.phase ?? DASH),
      ...rTiming.map((t) => t.review),
      ...rWorkload.map((w) => w.review),
    ])) {
      reviewKeys.add(`${runIndex}\0${rk}`);
      const rList = rReviews.filter((r) => (r.phase ?? DASH) === rk);
      const wList = rWorkload.filter((w) => w.review === rk);
      const tList = rTiming.filter((t) => t.review === rk);
      const cList = rCrit.filter((c) => c.review === rk);

      const roundNums = [
        ...new Set([
          ...rList.map((r) => r.round),
          ...wList.map((w) => w.round),
          ...tList.map((t) => t.round),
          ...cList.map((c) => c.round),
        ]),
      ].toSorted((a, b) => a - b);

      const totalRounds = Math.max(...roundNums);

      for (const rn of roundNums) {
        const rev = rList.find((r) => r.round === rn);
        const wl = wList.find((w) => w.round === rn);
        const tm = tList.find((t) => t.round === rn);
        const cp = cList.find((c) => c.round === rn);

        const hasNativeUntimed =
          tm?.slots.some((s) =>
            s.attempts.some((a) => a.surface === "native")
          ) ?? false;

        const spanText =
          cp?.elapsedMs === null || cp?.elapsedMs === undefined
            ? DASH
            : `${formatDuration(cp.elapsedMs)}${hasNativeUntimed ? " (CLI only)" : ""}`;

        roundEntries.push({
          run: runIndex + 1,
          review: /^review-[a-f0-9]{16}$/u.test(rk)
            ? `subject ${rk.slice(7)}`
            : phaseName(run, rk),
          round: rn,
          totalRounds,
          spanText,
          ...opt("hostTurns", wl?.hostTurns),
          ...opt("revTurns", wl?.reviewerTurns),
          revPartial: Boolean(wl?.reviewerTurnsPartial),
          ...opt("accepted", rev?.accepted),
          ...opt("rejected", rev?.rejected),
          ...opt("recurring", rev?.recurring),
        });
      }
    }
  }

  for (const e of roundEntries) {
    healthRows.push(
      row([
        ...(singleRun ? [] : [String(e.run)]),
        e.review,
        `${e.round}/${e.totalRounds}`,
        e.spanText,
        e.hostTurns === undefined ? DASH : num(e.hostTurns),
        e.revTurns === undefined
          ? DASH
          : `${num(e.revTurns)}${e.revPartial ? " partial" : ""}`,
        e.accepted === undefined ? DASH : num(e.accepted),
        e.rejected === undefined ? DASH : num(e.rejected),
        e.recurring === undefined ? DASH : num(e.recurring),
      ])
    );
  }

  const reviewHealth = (fold: Fold) => {
    if (!hasReviewHealth) {
      return [];
    }

    const out: string[] = ["## Review health", ""];

    if (roundEntries.length) {
      const kept = healthRows.slice(0, fold.health);
      out.push(
        `- ${plural(reviewKeys.size, "review")} · ${plural(roundEntries.length, "round")} · Host turns ${aggTurns(roundEntries.map((e) => e.hostTurns))} · Reviewer turns ${aggTurns(
          roundEntries.map((e) => e.revTurns),
          roundEntries.some((e) => e.revPartial)
        )}`,
        "",
        ...tableHeader([
          ...(singleRun ? [] : ["Run"]),
          "Review",
          ":Round",
          ":Wall span",
          ":Host turns",
          ":Reviewer turns",
          ":Accepted",
          ":Rejected",
          ":Recurring",
        ]),
        ...kept,
        ...(fold.health !== undefined && fold.health < healthRows.length
          ? [
              "",
              `${healthRows.length - fold.health} review round rows omitted.`,
            ]
          : []),
        ""
      );
    }

    if (yieldRows.length) {
      const kept = yieldLines.slice(0, fold.yield);
      out.push(
        "### Responder yield",
        "",
        ...tableHeader([
          "Provider",
          "Model",
          "M/S/C",
          ...(showFixInduced ? [":Fix-induced"] : []),
          ":Accepted",
          ":Rejected",
          ":Dup",
          ":Cost",
          ":Cost / accepted",
          "Notes",
        ]),
        ...kept,
        ...(fold.yield !== undefined && fold.yield < yieldLines.length
          ? ["", `${yieldLines.length - fold.yield} yield rows omitted.`]
          : []),
        ""
      );
    }

    return out;
  };

  const groundingLines = () => {
    if (!grounding.length) {
      return [];
    }

    const out = [
      "### Grounding",
      "",
      ...tableHeader([
        ...(singleRun ? [] : ["Run"]),
        "Phase",
        "Evidence",
        "Assessment",
        "Proposed change",
      ]),
    ];

    for (const g of grounding) {
      out.push(
        row([
          ...(singleRun ? [] : [String(g.run)]),
          g.id.slice("grounding-".length),
          g.evidence,
          g.impact,
          g.proposedFix,
        ])
      );
    }

    return [...out, ""];
  };

  const responseAgentRows = groupResponses(efficiency.responses, true);

  const tokenColumns = [
    ":Uncached input",
    ":Cache read",
    ":Cache write",
    ":Output",
    ":Reasoning",
    "Coverage",
    "Cost notes",
    ":Cost",
  ];

  const tier2Cost = (fold: Fold) => [
    "<details>",
    "",
    "<summary>Cost & token breakdown (platform, stage, model, and metadata)</summary>",
    "",
    ...metadataLines,
    "",
    "### Tokens by platform",
    "",
    ...tableHeader(["Platform", ...tokenColumns]),
    ...(platforms.size
      ? foldTable(platformRows, fold.platform, mergePlatforms).map((r) =>
          row([
            r.platform,
            ...sampleCells(r.samples),
            [...r.segments, ...knownSourceNotes(r.units)].join(" · ") || DASH,
            [...r.costNotes, ...rateNotes(r.units)].join(", ") || DASH,
            costText(r.units),
          ])
        )
      : [row(new Array<string>(9).fill(DASH))]),
    "",
    "### Tokens by stage",
    "",
    "Host/subagent stages are time-derived; delegates recorded.",
    "",
    ...tableHeader([
      "Stage",
      "Platform",
      "Role",
      "Model",
      "Effort",
      ...tokenColumns,
    ]),
    ...(sorted.length
      ? foldTable(sorted, fold.stage, mergeStages).map((entry) =>
          row([
            entry.stage,
            entry.platform,
            entry.role,
            configuredModelOf(entry.model, entry.configured),
            entry.effort,
            ...sampleCells(entry.samples),
            coverageRow(entry),
            costNotesRow(entry),
            costText(entry.units),
          ])
        )
      : [row(new Array<string>(13).fill(DASH))]),
    "",
    "</details>",
    "",
  ];

  const responseColumns = [
    "Event basis",
    ":Observed turns",
    "Coverage",
    ":Matched turns",
    ":Matched uncached input",
    ":Uncached input / turn",
    ":Tool calls (tool turns)",
  ];

  const tier2Efficiency = (fold: Fold) => {
    const { responseEvents, recovery } = efficiency;
    const kept = responseAgentRows.slice(0, fold.responses);
    const showRecovery = fold.responses === undefined || fold.responses > 0;

    return [
      "<details>",
      "",
      "<summary>Turn & context efficiency (by stage, role, and agent)</summary>",
      "",
      ...(showRecovery
        ? [
            `- CLI recovery: ${recovery.coverage}`,
            ...Object.entries(recovery.byCause).map(
              ([cause, { count, cost }]) =>
                `  - ${cause} · ${count} launches · ${cost ? formatCost({ ...cost, priced: true, reasons: new Set() }) + (cost.partial ? " (partial)" : "") : DASH}`
            ),
            "",
          ]
        : []),
      "### Context efficiency by stage and role",
      "",
      ...tableHeader(["Stage", "Role", ...responseColumns]),
      ...responseEvents.byStageRole.map((entry) =>
        row([entry.stage, entry.role, entry.basis, ...responseCells(entry)])
      ),
      "",
      "### Turns & context efficiency by agent",
      "",
      ...tableHeader(["Stage", "Role", "Agent", ...responseColumns]),
      ...kept.map((entry) =>
        row([
          entry.stage,
          entry.role,
          entry.agent ?? DASH,
          entry.basis,
          ...responseCells(entry),
        ])
      ),
      ...(kept.length < responseAgentRows.length
        ? [
            "",
            `${responseAgentRows.length - kept.length} response detail rows omitted. Stage totals include them.`,
          ]
        : []),
      "",
      "</details>",
      "",
    ];
  };

  const tier2Execution = (fold: Fold) => {
    const out: string[] = [
      "<details>",
      "",
      "<summary>Execution & review detail (phases, per-slot timing, and workload)</summary>",
      "",
      "### Phases",
      "",
      ...tableHeader([
        ...(singleRun ? [] : ["Run"]),
        "Phase",
        "Outcome",
        ...TIMING_COLS.flatMap((column, index) =>
          showTiming[index] === true ? [`:${column}`] : []
        ),
        ":Invocations",
        ":Input",
        ":Cache read",
        ":Cache write",
        ":Output",
        ":Coverage",
        ":Cost",
      ]),
      ...foldTable(phaseRows, fold.phase, mergePhases, (r) => r.pinned).map(
        (r) =>
          row([
            ...(singleRun ? [] : [r.label]),
            r.phase,
            r.outcome ?? DASH,
            ...r.timing
              .filter((_, idx) => showTiming[idx] === true)
              .map(formatDuration),
            String(r.items.length),
            ...tokenCells(totals(usageSamples(r.items))),
            coverage(r.items),
            costText(r.units),
          ])
      ),
      ...(notes.length ? ["", ...notes] : []),
      "",
    ];

    if (timing.length) {
      const kept = timing.slice(0, fold.timing ?? timing.length);
      out.push(
        "### Review round timing",
        "",
        ...tableHeader(["Review", ":Round", "Slot", ":Wall", "Critical path"])
      );

      for (const round of kept) {
        const spans = round.slots.map((slot) => {
          const invalid =
            slot.attempts.length === 0 ||
            slot.attempts.some(
              (a) =>
                a.startMs === undefined ||
                a.endMs === undefined ||
                a.endMs < a.startMs
            );

          return invalid
            ? undefined
            : {
                start: Math.min(
                  ...slot.attempts.map((a) => defined(a.startMs))
                ),
                end: Math.max(...slot.attempts.map((a) => defined(a.endMs))),
              };
        });

        const latest = spans.every(Boolean)
          ? spans.findIndex(
              (s) =>
                defined(s).end === Math.max(...spans.map((x) => defined(x).end))
            )
          : -1;

        for (const [i, slot] of round.slots.entries()) {
          out.push(
            row([
              `subject ${round.review.slice(7)}`,
              String(round.round),
              slot.slot,
              formatDuration(spans[i] && spans[i].end - spans[i].start),
              i === latest ? "✓" : DASH,
            ])
          );
        }
      }

      if (kept.length < timing.length) {
        out.push(
          "",
          `${timing.length - kept.length} review timing rounds omitted`
        );
      }

      out.push("");
    }

    if (workload.length) {
      const storageFailed =
        sum(runs.map((run) => run.collection?.storageFailed)) ?? 0;

      const eligible = workload.filter(
        (round) => round.kind === "plan" || round.kind === "design"
      );

      const over = eligible.filter(
        (round) => (round.calls?.total ?? 0) > 6 || (round.hostTurns ?? 0) > 25
      );

      let overText = "";

      if (fold.workload === undefined) {
        overText = over
          .map(
            (round) => `subject ${round.review.slice(7)} round ${round.round}`
          )
          .join(", ");
      } else if (over.length > 0) {
        overText = plural(over.length, "round");
      }

      out.push(
        "### Review round workload",
        "",
        ...tableHeader([
          "Review",
          ":Round",
          "Toolkit calls",
          ":Host tokens",
          ":Host turns",
          ":Reviewer turns",
        ]),
        ...workload
          .slice(0, fold.workload)
          .map((round) =>
            row([
              `subject ${round.review.slice(7)}`,
              String(round.round),
              round.calls
                ? `${num(round.calls.total)}${round.calls.phases.length ? `: ${round.calls.phases.map((p) => `${p.key} ${num(p.count)}`).join(" · ")}` : ""}`
                : DASH,
              round.calls && round.hostTokens !== undefined
                ? num(round.hostTokens)
                : DASH,
              round.hostTurns === undefined ? DASH : num(round.hostTurns),
              round.reviewerTurns === undefined
                ? DASH
                : `${num(round.reviewerTurns)}${round.reviewerTurnsPartial ? " partial" : ""}`,
            ])
          ),
        "",
        "Observed toolkit calls only (`report`, `diagnostics`, and outside-window work excluded).",
        ...(fold.workload !== undefined && fold.workload < workload.length
          ? [`${workload.length - fold.workload} workload rows omitted.`]
          : []),
        ...(eligible.length
          ? [
              `Advisory budget (lightweight fix review): <=6 toolkit calls, <=25 host turns; over: ${
                overText === "" ? "none" : overText
              }`,
            ]
          : []),
        ...(storageFailed
          ? [
              `${plural(storageFailed, "capture storage failure")}: calls from failed updates may be missing from the counts above.`,
            ]
          : []),
        ""
      );
    }

    return [...out, "</details>", ""];
  };

  return {
    reviewHealth,
    groundingLines,
    tier2Cost,
    tier2Efficiency,
    tier2Execution,
    counts: {
      responses: responseAgentRows.length,
      timing: timing.length,
      workload: workload.length,
      health: healthRows.length,
      yield: yieldLines.length,
      stage: sorted.length,
      phase: phaseRows.filter((r) => !r.pinned).length,
      platform: platformRows.length,
    },
  };
};

const appendixProviderOf = (i: InvocationFacts) => {
  if (i.surface === "native") {
    return `${i.provider} (native)`;
  }

  if (i.mode !== undefined && i.mode !== "" && i.mode !== "cli") {
    return `${i.provider} (${i.mode})`;
  }

  return i.provider;
};

const appendixIdentityOf = (
  i: InvocationFacts,
  review: boolean,
  ordinal: number | undefined
) => {
  if (i.subject !== undefined && i.subject !== "") {
    return review
      ? ` · attempt ${i.subject}/${ordinal ?? DASH}`
      : ` · subject ${i.subject} · attempt ${ordinal ?? DASH}`;
  }

  return ordinal === undefined ? "" : ` · attempt ${ordinal}`;
};

const nativeStateOf = (outcome: string) => {
  if (outcome === "ok") {
    return "completed";
  }

  return outcome === "native-pending" ? "pending" : "unavailable";
};

const appendixOutcomeCellOf = (i: InvocationFacts) => {
  const suffix = [
    i.nudge === true ? " · nudge" : "",
    i.wrapUp === true ? " · wrapUp" : "",
    i.validationOutcome === undefined || i.validationOutcome === ""
      ? ""
      : ` · validation ${i.validationOutcome}`,
    i.routingOutcome === undefined || i.routingOutcome === ""
      ? ""
      : ` · routing ${i.routingOutcome}`,
    i.slotState === undefined ? "" : ` · slot ${i.slotState}`,
    (i.lifecycleSteps?.length ?? 0) > 0
      ? ` · lifecycle ${(i.lifecycleSteps ?? []).map((s) => `${s.step} ${s.outcome} ${s.elapsedMs}/${s.budgetMs} ms`).join(", ")}`
      : "",
    i.launched ? "" : " (not launched)",
  ].join("");

  return i.surface === "native"
    ? `native ${i.nativeState ?? nativeStateOf(i.outcome)}`
    : `${i.outcome}${suffix}`;
};

// oxlint-disable-next-line eslint/complexity -- appendix branches per invocation usage, reasoning presence, and provenance snapshot.
const appendix = (runs: readonly RunFacts[]) => {
  const singleRun = runs.length === 1;

  const configured = runs.some((run) =>
    run.invocations.some(
      (i) => i.configuredEffort !== undefined && i.configuredEffort !== ""
    )
  );

  const lines = [
    "<details>",
    "",
    "<summary>Invocations, provenance, and configuration</summary>",
    "",
    ...tableHeader([
      ...(singleRun ? [] : ["Run"]),
      "Phase",
      "Provider",
      "Model",
      "Effort",
      ...(configured ? ["Configured effort"] : []),
      ":Duration",
      ":Input",
      ":Cache read",
      ":Cache write",
      ":Output",
      ":Reasoning",
      ":Total",
      "Outcome",
    ]),
  ];

  for (const [index, run] of runs.entries()) {
    for (const i of run.invocations) {
      const launched = measured(i);

      const usage = launched
        ? totals([
            {
              usage: launched,
              platform: i.provider,
              reasoningInOutput: i.usage?.reasoningInOutput,
            },
          ])
        : undefined;

      const all = usage?.all;

      const apart = usage
        ? usage.all -
          usage.input -
          (usage.cacheRead ?? 0) -
          (usage.cacheWrite ?? 0) -
          usage.output
        : 0;

      let reasoningCell = DASH;

      if (usage?.reasoning !== undefined) {
        reasoningCell =
          apart > 0 ? num(apart) : `${num(usage.reasoning)} (in output)`;
      }

      const provider = appendixProviderOf(i);

      const reported = i.reportedModels ?? [];

      const reportedDiffers =
        reported.length > 0 &&
        !(reported.length === 1 && reported[0] === i.model);

      const model = reportedDiffers
        ? `${i.model} (reported: ${reported.join(", ")})`
        : i.model;

      const review = /^review-[a-f0-9]{16}$/u.test(i.phase);

      const ordinal =
        i.attempt !== undefined && i.attempt > 0 ? i.attempt : undefined;

      const identity = appendixIdentityOf(i, review, ordinal);

      lines.push(
        row([
          ...(singleRun ? [] : [String(index + 1)]),
          phaseName(run, i.phase) +
            identity +
            (i.slot === undefined || i.slot === "" ? "" : ` · slot ${i.slot}`),
          provider,
          model,
          i.surface === "native" && i.effort !== undefined && i.effort !== ""
            ? `${i.effort} (configured)`
            : (i.effort ?? DASH),
          ...(configured ? [i.configuredEffort ?? DASH] : []),
          formatDuration(i.durationMs),
          ...tokenCells(usage),
          reasoningCell,
          all === undefined ? DASH : num(all),
          appendixOutcomeCellOf(i),
        ])
      );
    }
  }

  lines.push("");

  for (const [index, run] of runs.entries()) {
    lines.push(
      `Run ${index + 1}: ${run.verb ?? DASH} · ${run.level ?? DASH} · pins ${run.pins ?? DASH} · ${run.outcome ?? DASH}.`,
      ""
    );

    for (const snapshot of run.provenance ?? [
      { version: run.version, build: run.build, config: run.config },
    ]) {
      if (
        (snapshot.version === undefined || snapshot.version === "") &&
        (snapshot.build === undefined || snapshot.build === "") &&
        snapshot.config === undefined
      ) {
        lines.push(
          "Provenance: unknown historical implementation and configuration.",
          ""
        );
      }

      lines.push(
        `Provenance: dispatch ${snapshot.version ?? DASH} · build ${snapshot.build ?? DASH}.`,
        ""
      );

      if (snapshot.config && Object.keys(snapshot.config).length) {
        lines.push(
          "```json",
          JSON.stringify(snapshot.config, null, 2),
          "```",
          ""
        );
      }
    }
  }

  return [...lines, "</details>", ""];
};

const recoveryCount = (n: number | undefined) =>
  n === undefined ? "uncollected" : num(n);

const recoveryLines = (runs: readonly RunFacts[]) => {
  const selections = runs
    .flatMap((run) => run.recoverySelections ?? [])
    .toSorted(
      (a, b) =>
        a.round - b.round ||
        a.generation - b.generation ||
        a.ref.localeCompare(b.ref)
    );

  if (!selections.length) {
    return [];
  }

  const executions = new Map<
    string,
    NonNullable<RunFacts["recoveryExecutions"]>
  >();

  for (const execution of runs.flatMap((run) => run.recoveryExecutions ?? [])) {
    const group = executions.get(execution.ref) ?? [];
    group.push(execution);
    executions.set(execution.ref, group);
  }

  const lines = selections.slice(0, 5).map(({ ref, round, generation }) => {
    const observed = executions.get(ref) ?? [];

    const details = observed
      .slice(0, 3)
      .map(
        ({ reused, launched, unresolved }) =>
          `reused ${recoveryCount(reused)}, launched ${recoveryCount(launched)}, unresolved ${recoveryCount(unresolved)}`
      )
      .join(" · ");

    return `  - Code integration R${round} g${generation} (${ref}) · ${details || "Execution uncollected"}${observed.length > 3 ? ` · ${observed.length - 3} more calls` : ""}`;
  });

  if (selections.length > 5) {
    lines.push(`  - ${selections.length - 5} more selections`);
  }

  return ["- Explicit review recovery (logical slots per call)", ...lines];
};

const isGrounding = (o: RetroObservation) => o.id.startsWith("grounding-");

const hasCompleteHost = (r: RunFacts) =>
  Boolean(
    r.hostUsage &&
    !r.hostUsage.unavailable &&
    !Object.keys(r.hostUsage.notes?.host ?? {}).length &&
    r.hostUsage.rows.some((entry) => entry.role === "host")
  );

const hasCompleteSubagents = (r: RunFacts) =>
  !Object.keys(r.hostUsage?.notes?.subagent ?? {}).length;

const hasCompleteUser = (r: RunFacts) =>
  Boolean(
    r.hostUsage &&
    !r.hostUsage.unavailable &&
    !Object.keys(r.hostUsage.notes?.host ?? {}).length &&
    r.hostUsage.userTurns !== undefined
  );

const qualify = (text: string, isPartial: boolean, isLimited: boolean) =>
  text === DASH
    ? DASH
    : `${text}${isPartial || isLimited ? ` (${[isPartial ? "partial" : "", isLimited ? "limited" : ""].filter(Boolean).join(", ")})` : ""}`;

const fitsReport = (text: string) =>
  Buffer.byteLength(text) <= DIAGNOSTIC_LIMITS.reportBytes;

/** Renders the session report from every run's facts; compaction drops the Appendix, then lower-severity findings, then folds Tier-2 details before Tier-1 yield. */

// oxlint-disable-next-line eslint/complexity -- report assembly branches per host/provenance presence and compaction tier.
export const renderDiagnostics = (
  input: readonly RunFacts[],
  pricer?: Pricer
) => {
  const runs = input.map(sanitizeFacts);

  const retro = runs.map((run) =>
    run.observations === undefined
      ? undefined
      : retroObservations(run.observations)
  );

  const grounding = runs.flatMap((_, index) =>
    (retro[index]?.values ?? [])
      .filter(isGrounding)
      .map((o) => ({ ...o, run: index + 1 }))
  );

  const findings = bySeverity(
    runs.flatMap((run, index) => [
      ...heuristics(run).map((f) => ({ ...f, run: index + 1 })),
      ...(retro[index]?.values ?? [])
        .filter((o) => !isGrounding(o))
        .map((o) => ({
          source: "retro",
          run: index + 1,
          id: o.id,
          category: o.category,
          component: o.component,
          evidence: o.evidence,
          impact: o.impact,
          proposedFix: o.proposedFix,
        })),
    ])
  );

  const runUnits = runs.map((run) => unitsOf(run, pricer));
  const allUnits = runUnits.flat();

  const allTurnRows = runs.flatMap((run, idx) =>
    turnRowsOf(run, defined(runUnits[idx]))
  );

  const {
    total,
    priced,
    unpriced,
    coverage: scope,
    rateBasis,
    roles,
  } = costCoverage(runs, pricer, allUnits);

  const collected = retro.filter((r) => r !== undefined);

  const hosts = [
    ...new Set(
      runs.flatMap((run) => {
        if ((run.hosts?.length ?? 0) > 0) {
          return run.hosts;
        }

        return run.host === undefined || run.host === "" ? [] : [run.host];
      })
    ),
  ];

  const measuredPlatforms = [
    ...new Set(
      runs.flatMap((run) => {
        const host = run.hostUsage;

        return host !== undefined &&
          host.platform !== undefined &&
          host.platform !== "" &&
          host.rows.some((r) => r.role === "host")
          ? [host.platform]
          : [];
      })
    ),
  ];

  const hostScope =
    hosts.length > 1
      ? ` · ${measuredPlatforms.length ? `host rows measure the ${measuredPlatforms.join(", ")} thread; other hosts' threads are unmeasured` : "no host thread is measured"}`
      : "";

  const days = rateBasis.effectiveDays;

  const dayText =
    days.length > 8
      ? `${days.length} rate days or base-rate fallbacks`
      : days.map((day) => day ?? "base-rate fallback").join(", ") || DASH;

  const collectionPartial = runs.some((r) =>
    Object.entries(r.collection ?? {}).some(
      ([key, n]) => key !== "completed" && n > 0
    )
  );

  let collectionState = "unknown";

  if (collectionPartial) {
    collectionState = "partial";
  } else if (runs.some((r) => (r.collection?.completed ?? 0) > 0)) {
    collectionState = "complete for observed captures";
  }

  const retroStates = unique(
    runs.map((run, index) => run.retroState ?? retro[index]?.state ?? "missing")
  );

  const hasHostRows = runs.some((run) => (run.hostUsage?.rows.length ?? 0) > 0);

  const metadataLines = [
    `- Build: ${unique(runs.flatMap((run) => (run.provenance ?? [{ version: run.version, build: run.build }]).map((p) => `dispatch ${p.version ?? DASH} · build ${p.build ?? DASH}`)))}`,
    `- Host: ${hosts.join(", ") || DASH}${hostScope} · OS: ${unique(runs.map((run) => run.os ?? DASH))}`,
    ...(pricer
      ? [
          `- Rate basis: table ${rateBasis.tableAsOf} · UTC day ${dayText} · ${rateBasis.originCounts.shipped} shipped, ${rateBasis.originCounts.override} override · ${rateBasis.matchCounts.qualified} qualified, ${rateBasis.matchCounts.wildcard} wildcard, ${rateBasis.matchCounts.generic} generic`,
        ]
      : []),
    ...(runs.some((run) => run.timingScope === "tool-calls")
      ? [
          `- Timing scope: summed tool-call durations (overlap possible); host reasoning, user wait, ${hasHostRows ? "native/writer timing" : "native/writer usage"}, pre-enablement work unavailable.`,
        ]
      : []),
    hasHostRows
      ? "- Full conversation totals: host/subagent cover current host thread in window; other threads, full collection, and storage loss are unobservable."
      : "- Full conversation totals unavailable: CLI launches only; full collection and storage loss are unobservable.",
    `- Host retro: ${retroStates} · ${sum(collected.map((r) => r.values.length)) ?? 0} accepted · ${sum(collected.map((r) => r.rejected)) ?? 0} rejected`,
    `- Collection health: ${collectionState} · corrupt ${num(sum(runs.map((r) => r.collection?.corrupt)))} · unreadable ${num(sum(runs.map((r) => r.collection?.unreadable)))} · incomplete ${num(sum(runs.map((r) => r.collection?.incomplete)))} · storage-failed ${num(sum(runs.map((r) => r.collection?.storageFailed)))}`,
  ];

  const efficiency = efficiencyOf(runs, pricer);
  const { recovery } = efficiency;

  const hostTurnsComplete =
    runs.every(hasCompleteHost) && runs.every(hasCompleteSubagents);

  const userTurnsTotal = allDefinedSum(
    runs.map((r) => (hasCompleteUser(r) ? r.hostUsage?.userTurns : undefined))
  );

  const llmTurnsTotal = allDefinedSum(allTurnRows.map((r) => r.usage?.turns));

  const toolCallsTotal = allDefinedSum(
    allTurnRows.map((r) => r.usage?.toolCalls)
  );

  const toolTurnsTotal = allDefinedSum(
    allTurnRows.map((r) => r.usage?.toolTurns)
  );

  const summaryLimited = allTurnRows.some((r) => r.limited === true);

  const allHaveCollection = runs.every(
    (r) =>
      r.collection?.completed !== undefined &&
      r.collection?.incomplete !== undefined
  );

  const sessionActions = allHaveCollection
    ? sum(
        runs.map(
          (r) =>
            (r.collection?.completed ?? 0) + (r.collection?.incomplete ?? 0)
        )
      )
    : undefined;

  const workloadCalls = runs
    .flatMap((r) => r.roundWorkload ?? [])
    .flatMap((w) => (w.calls ? [w.calls.total] : []));

  let toolkitCallsText = `Captured toolkit calls ${DASH}`;

  if (allHaveCollection) {
    toolkitCallsText = `Captured toolkit calls ${num(sessionActions)}${collectionPartial ? " (partial)" : ""} (excl. report/diagnostics)`;
  } else if (workloadCalls.length > 0) {
    toolkitCallsText = `Review-window toolkit calls ${num(sum(workloadCalls))} (excl. report/diagnostics)`;
  }

  const subagentCountTotal = allDefinedSum(
    runs.map((r) => r.hostUsage?.subagentCount)
  );

  const maxSubagentDepthVals = runs.map((r) => r.hostUsage?.maxSubagentDepth);

  const maxSubagentDepthTotal =
    maxSubagentDepthVals.length &&
    maxSubagentDepthVals.every((v) => v !== undefined)
      ? Math.max(...maxSubagentDepthVals)
      : undefined;

  const wasteCostText = recovery.wasteCost
    ? `${formatCost({ ...recovery.wasteCost, priced: true, reasons: new Set() })}${recovery.wasteCost.partial ? " (partial)" : ""}`
    : DASH;

  const wasteShareText =
    recovery.wasteShare === null
      ? DASH
      : `${pct(recovery.wasteShare)}${recovery.wastePartial ? " (partial)" : ""}`;

  const warnings: string[] = [];

  if (!pricer) {
    warnings.push("- Rate warning: rate table unavailable");
  }

  if (rateBasis.originCounts.override > 0) {
    warnings.push(
      `- Rate warning: ${plural(rateBasis.originCounts.override, "override rate")} applied`
    );
  }

  if (scope.partial) {
    warnings.push(`- Coverage warning: partial (${scope.reasons.join(", ")})`);
  }

  if (hosts.length > 1 || runs.some((r) => r.hostUsage?.unavailable)) {
    warnings.push(`- Host warning: ${hosts.join(", ") || DASH}${hostScope}`);
  }

  if (collectionPartial) {
    warnings.push(
      `- Collection warning: partial · corrupt ${num(sum(runs.map((r) => r.collection?.corrupt)))} · unreadable ${num(sum(runs.map((r) => r.collection?.unreadable)))} · incomplete ${num(sum(runs.map((r) => r.collection?.incomplete)))} · storage-failed ${num(sum(runs.map((r) => r.collection?.storageFailed)))}`
    );
  }

  if (
    runs.some((r, i) =>
      ["invalid", "malformed", "unreadable"].includes(
        r.retroState ?? retro[i]?.state ?? ""
      )
    )
  ) {
    warnings.push(`- Retro warning: ${retroStates}`);
  }

  const allHostComplete = runs.every(hasCompleteHost);
  const allSubagentsComplete = runs.every(hasCompleteSubagents);

  const roleGroups = ROLE_KEYS.map((role) => {
    const tRows = allTurnRows.filter((r) => r.role === role);
    const rUnits = allUnits.filter((u) => u.role === role);
    const meta = defined(roles.find((r) => r.role === role));

    const cov = [
      ...meta.coverage,
      ...(tRows.some((r) => r.limited === true) ? ["limited"] : []),
    ];

    const rPartial =
      (role === "host" && !allHostComplete) ||
      (role === "subagent" && !allSubagentsComplete);

    return {
      role,
      label: ROLE_LABELS[role],
      cost: meta.cost,
      tokens: meta.tokens ?? 0,
      hasUsage: meta.tokens !== null,
      cacheHit: cacheHitOf(rUnits, rPartial),
      userTurns: role === "host" ? userTurnsTotal : undefined,
      llmTurns: allDefinedSum(tRows.map((r) => r.usage?.turns)),
      toolCalls: allDefinedSum(tRows.map((r) => r.usage?.toolCalls)),
      toolTurns: allDefinedSum(tRows.map((r) => r.usage?.toolTurns)),
      coverage: cov.join(", ") || "no recorded launches",
    };
  });

  const roleShares = computeShares(roleGroups);

  const stageKeys = [
    ...new Set([
      ...STAGE_ORDER.filter(
        (s) =>
          allTurnRows.some((r) => r.stage === s) ||
          runs.some((run) => run.hostUsage?.userTurnsByStage?.[s] !== undefined)
      ),
      ...allTurnRows.flatMap((r) =>
        STAGE_NAMES.includes(r.stage) ? [] : [r.stage]
      ),
    ]),
  ];

  const stageGroups = stageKeys.map((stage) => {
    const hostStage = STAGE_ORDER.find((candidate) => candidate === stage);
    const tRows = allTurnRows.filter((r) => r.stage === stage);
    const sUnits = allUnits.filter((u) => u.stage === stage);
    const obs = tRows.filter((r) => r.usage);

    const tokens = obs.reduce(
      (n, r) =>
        n + billedTokens(defined(r.usage), r.platform, r.reasoningInOutput),
      0
    );

    const uByStage =
      stage === DASH
        ? undefined
        : allDefinedSum(
            runs.map((r) =>
              hasCompleteUser(r)
                ? ((hostStage && r.hostUsage?.userTurnsByStage?.[hostStage]) ??
                  0)
                : undefined
            )
          );

    const llm = allDefinedSum(tRows.map((r) => r.usage?.turns));
    const tc = allDefinedSum(tRows.map((r) => r.usage?.toolCalls));
    const tt = allDefinedSum(tRows.map((r) => r.usage?.toolTurns));
    const stLimited = tRows.some((r) => r.limited === true);

    const stPartial =
      (sUnits.some((u) => u.role === "host") && !allHostComplete) ||
      (sUnits.some((u) => u.role === "subagent") && !allSubagentsComplete);

    return {
      stage,
      cost: sumCost(costsOf(tRows)),
      tokens,
      hasUsage: obs.length > 0,
      cacheHit: cacheHitOf(sUnits, stPartial),
      userTurns: num(uByStage),
      llmTurns: qualify(num(llm), stPartial, stLimited),
      toolText: qualify(toolCell(tc, tt), stPartial, stLimited),
    };
  });

  const stageShares = computeShares(stageGroups);

  const summaryColumns = [
    "Share",
    ":Cost",
    ":Billed tokens",
    ":Cache hit",
    ":User turns",
    ":LLM turns",
    ":Tool calls (tool turns)",
  ];

  const lead = [
    "# Dispatch diagnostics",
    "",
    "Review before sharing: dispatch-owned data only (no source, objective, paths, identities); fixes unverified.",
    "",
    "`—` unavailable · `~` USD estimate · bars show cost-midpoint share (or tokens if unpriced).",
    "",
    "## Summary",
    "",
    `- Runs: ${runs.length} · Host: ${hosts.join(", ") || DASH} · OS: ${unique(runs.map((run) => run.os ?? DASH))} · Measured duration: ${formatDuration(sum(runs.flatMap((run) => run.phases.map((p) => p.wallMs))))}`,
    `- Estimated cost ${pricer ? formatCost(total) : "not estimated (rate table unavailable)"}${total.priced && scope.partial ? " (partial)" : ""} · priced ${priced} · unpriced ${unpriced} · Cache hit: ${cacheHitOf(allUnits, !hostTurnsComplete)}`,
    `- Turns: User ${num(userTurnsTotal)} · LLM ${qualify(num(llmTurnsTotal), !hostTurnsComplete, summaryLimited)} · Tool calls ${qualify(toolCell(toolCallsTotal, toolTurnsTotal), !hostTurnsComplete, summaryLimited)} · ${toolkitCallsText}`,
    `- Subagents: ${num(subagentCountTotal)} · max depth ${num(maxSubagentDepthTotal)}`,
    ...recoveryLines(runs),
    `- Waste / recovery: ${wasteCostText} (${wasteShareText}) · extra ${recovery.extraLaunches ?? DASH} · superseded ${recovery.reworkLaunches ?? DASH} · nudge ${recovery.nudges ?? DASH} · wrap-up ${recovery.wrapUps ?? DASH} · writer relaunches ${recovery.writerRelaunches ?? DASH}`,
    ...warnings,
    "",
    ...(findings.length > 3
      ? [
          "Top findings:",
          "",
          ...findings.slice(0, 3).map((f, i) => `${i + 1}. ${summaryLine(f)}`),
          "",
        ]
      : []),
    "### Spend & Turns by Role",
    "",
    ...tableHeader(["Role", ...summaryColumns, "Coverage"]),
    ...roleGroups.map((g, i) =>
      row([
        g.label,
        shareBar(roleShares[i] ?? null),
        formatCost(g.cost),
        g.hasUsage ? num(g.tokens) : DASH,
        g.cacheHit,
        num(g.userTurns),
        num(g.llmTurns),
        toolCell(g.toolCalls, g.toolTurns),
        g.coverage,
      ])
    ),
    "",
    "### Spend & Turns by Stage",
    "",
    ...(hostTurnsComplete
      ? []
      : [
          "Stage uses observed rows. Summary flags missing host/subagent data.",
          "",
        ]),
    ...tableHeader(["Stage", ...summaryColumns]),
    ...(stageGroups.length
      ? stageGroups.map((g, i) =>
          row([
            g.stage,
            shareBar(stageShares[i] ?? null),
            formatCost(g.cost),
            g.hasUsage ? num(g.tokens) : DASH,
            g.cacheHit,
            g.userTurns,
            g.llmTurns,
            g.toolText,
          ])
        )
      : [row(new Array<string>(8).fill(DASH))]),
    "",
    ...costDrivers(allUnits),
  ];

  const sections = buildSections(
    runs,
    efficiency,
    grounding,
    runUnits,
    metadataLines,
    pricer
  );

  const findingLines = (keep: number) => {
    if (!findings.length) {
      return ["## Findings", "", "No findings.", ""];
    }

    const lines = ["## Findings", ""];

    for (const [i, f] of findings.slice(0, keep).entries()) {
      lines.push(
        `### ${i + 1}. ${CATEGORIES[f.category]} · \`${f.component}\``,
        "",
        `- Source: ${sourceOf(f)} · run ${f.run ?? DASH}`,
        `- Evidence: ${md(f.evidence)}`,
        `- Impact: ${md(f.impact)}`,
        `- Proposed fix (unverified): ${md(f.proposedFix)}`,
        ""
      );
    }

    if (keep < findings.length) {
      lines.push(
        `${plural(findings.length - keep, "lower-severity finding")} omitted at the report size limit.`,
        ""
      );
    }

    return lines;
  };

  const tail = appendix(runs);
  const copilot = copilotDetails(runs);

  const counts: Record<FoldTable, number> = {
    ...sections.counts,
    copilot: copilot.count,
  };

  const assemble = (withAppendix: boolean, keep: number, fold: Fold = {}) =>
    [
      ...lead,
      ...sections.reviewHealth(fold),
      ...sections.groundingLines(),
      ...findingLines(keep),
      ...sections.tier2Cost(fold),
      ...sections.tier2Efficiency(fold),
      ...sections.tier2Execution(fold),
      ...copilot.render(fold.copilot),
      ...(withAppendix
        ? tail
        : [
            "<details>",
            "",
            "<summary>Invocations, provenance, and configuration</summary>",
            "",
            "Omitted at the report size limit.",
            "",
            "</details>",
            "",
          ]),
    ].join("\n");

  let text = assemble(true, findings.length);

  if (!fitsReport(text)) {
    text = assemble(false, findings.length);
  }

  for (
    let keep = findings.length - 1;
    !fitsReport(text) && keep >= 0;
    keep -= 1
  ) {
    text = assemble(false, keep);
  }

  const fold: Fold = {};

  for (const table of FOLD_ORDER) {
    if (fitsReport(text)) {
      break;
    }

    if (!counts[table]) {
      continue;
    }

    const render = (n: number) => assemble(false, 0, { ...fold, [table]: n });
    let lo = 0;

    for (let hi = fitsReport(render(0)) ? counts[table] - 1 : 0; lo < hi;) {
      const mid = Math.floor((lo + hi + 1) / 2);

      if (fitsReport(render(mid))) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    fold[table] = lo;
    text = render(lo);
  }

  if (!fitsReport(text)) {
    const cut = Buffer.from(text)
      .subarray(0, DIAGNOSTIC_LIMITS.reportBytes - 256)
      .toString();

    text = `${cut.slice(0, cut.lastIndexOf("\n"))}\n\nTruncated at the report size limit.\n`;
  }

  return {
    text,
    findings: findings.length,
    ...opt("top", findings[0] && summaryLine(findings[0])),
  };
};

const copilotDetails = (runs: readonly RunFacts[]) => {
  const values: {
    stage: string;
    role: string;
    agent?: string | undefined;
    model: string;
    effort?: string | null | undefined;
    depth?: number | undefined;
    copilot?: CopilotEvidence | undefined;
  }[] = [];

  for (const run of runs) {
    if (run.hostUsage?.platform === "copilot") {
      for (const r of run.hostUsage.rows) {
        values.push({
          stage: r.stage,
          role: r.role,
          agent: r.agent,
          model: r.model,
          effort: r.effort,
          depth: r.maxDepth,
          copilot: r.copilot,
        });
      }
    }

    for (const i of run.invocations) {
      if (i.provider === "copilot" && measured(i)) {
        const actors = i.usage?.actors ?? [];

        if (actors.length > 0) {
          for (const a of actors) {
            values.push({
              stage: phaseName(run, i.phase),
              role: a.role,
              agent: a.agent,
              model: a.model,
              effort: a.effort,
              depth: a.depth,
              copilot: a.copilot,
            });
          }
        } else {
          values.push({
            stage: phaseName(run, i.phase),
            role: "delegate",
            model: i.model,
            effort: i.effort,
            copilot: i.usage?.copilot,
          });
        }
      }
    }
  }

  const count = Math.min(values.length, MAX_RESPONSE_AGENTS);

  return {
    count,
    render: (keep = count) => {
      if (!values.length) {
        return [];
      }

      const reasons = [
        ...(values.length > count
          ? [
              `${values.length - count} beyond the ${MAX_RESPONSE_AGENTS}-row detail cap`,
            ]
          : []),
        ...(keep < count
          ? [`${count - keep} additional rows omitted at the report size limit`]
          : []),
      ];

      return [
        "<details>",
        "",
        "<summary>Copilot accounting evidence</summary>",
        "",
        "Supported local records only; unknown formats and unresolved nesting limit coverage. Reported nano-AI units and premium-request multipliers are not USD or final charges. Token-priced costs are USD estimates.",
        "",
        ...tableHeader([
          "Stage",
          "Role",
          "Actor",
          "Model (observed)",
          "Effort (observed)",
          ":Depth",
          "Tokens / lineage / actors",
          ":Reported nano-AI units",
          "Multiplier",
          "Billing state / coverage",
        ]),
        ...values
          .slice(0, keep)
          .map((v) =>
            row([
              v.stage,
              v.role,
              v.agent ?? "Other or unknown actors",
              v.model || DASH,
              v.effort ?? DASH,
              v.depth === undefined ? DASH : String(v.depth),
              v.copilot
                ? `${v.copilot.tokenCoverage} / ${v.copilot.lineageCoverage} / ${v.copilot.actorCoverage}`
                : "unknown",
              v.copilot?.billing.totalNanoAiu === undefined
                ? DASH
                : String(v.copilot.billing.totalNanoAiu),
              v.copilot?.billing.multipliers?.join(", ") ?? DASH,
              `${v.copilot?.billing.statuses?.join(", ") ?? DASH} / ${v.copilot?.billing.coverage ?? "unknown"}`,
            ])
          ),
        ...(keep < values.length
          ? [
              "",
              `Detail coverage partial: ${values.length - keep} accounting rows omitted (${reasons.join("; ")}); measured token and cost rollups retain all rows.`,
            ]
          : []),
        "",
        "</details>",
        "",
      ];
    },
  };
};
