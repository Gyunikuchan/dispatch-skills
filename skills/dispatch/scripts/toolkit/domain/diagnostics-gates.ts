import { isRecord as record } from "../../lib/config.ts";
import type { JsonObject, JsonValue } from "../../lib/integrity.ts";
import { pricingProblems } from "../../lib/pricing.ts";
import { boundModels } from "../../lib/usage/bands.ts";
import {
  baseCounters,
  count as safeCount,
  hasUsageTokens,
} from "../../lib/usage/read.ts";
import {
  addCounters,
  BANDS,
  COVERAGE_REASONS,
  HOST_ROLES,
  HOST_RESPONSE_BASES,
  MAX_RESPONSE_AGENTS,
  RESPONSE_COVERAGES,
  RESPONSE_STAGES,
  HOST_NOTES,
  HOST_UNAVAILABLE,
  splitUsageKey,
  STAGE_ORDER,
} from "../../lib/usage/rows.ts";
import type {
  Bands,
  CopilotActor,
  Counters,
  HostResponseAggregate,
  HostUsageFacts,
  HostUsageRow,
  UsageSource,
} from "../../lib/usage/rows.ts";
import type { LifecycleStep } from "../../providers/types.ts";
import { defined } from "./defined.ts";
import {
  CATEGORIES,
  COMPONENTS,
  DASH,
  DIAGNOSTIC_LIMITS,
  PHASE_NAMES,
} from "./diagnostics-types.ts";
import type {
  Category,
  DelegateResponseFacts,
  InvocationFacts,
  ModelUsage,
  RecoveryExecution,
  RetroObservation,
  RunFacts,
  Usage,
} from "./diagnostics-types.ts";

const MAX_REVIEW_ROUND_CAP = 1000;

const VERBS = ["ask", "design", "plan", "review", "implement"];
const LEVELS = ["low", "medium", "high", "xhigh", "max"];

const CONFIG_KEYS = [
  "diagnostics",
  "write-concurrency",
  "read-delegates",
  "write-subagents",
  "utility-subagents",
  "phases",
  "read-commands",
  "pricing",
];

const ID = /^[A-Za-z0-9_-]{1,48}$/u;

const PROHIBITED: readonly RegExp[] = [
  /(?:^|[\s"'`(<[=,;])(?:~|\/[^\s/"'`]+)\/[^\s/"'`]/u,
  /\b[A-Za-z]:[\\/]|\\\\[^\s\\]+\\/u,
  /\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|dev|ai|app|cloud|internal|corp)\b/iu,
  /[\w.%+-]+@[\w-]+(?:\.[\w-]+)+/u,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{32,}\b/iu,
];

const list = (v: unknown) => {
  if (!Array.isArray(v)) {
    return [];
  }

  const out: unknown[] = [];

  for (const item of v) {
    out.push(item);
  }

  return out;
};

const locatorFree = (v: string) => !PROHIBITED.some((re) => re.test(v));

const commandText = (v: unknown) =>
  typeof v === "string" &&
  v.length <= 80 &&
  /^[A-Za-z0-9._:=@+-]+(?: [A-Za-z0-9._:=@+-]+)*$/u.test(v) &&
  locatorFree(v)
    ? v
    : DASH;

const match = (re: RegExp) => (v: unknown) =>
  typeof v === "string" && re.test(v) && locatorFree(v) ? v : undefined;

const responseAgent = match(/^(?:host|subagent)-(?:[1-9]|[12][0-9]|3[0-2])$/u);
const token = match(/^[a-z][a-z0-9-]{0,39}$/u);
const phaseKey = match(/^[a-z0-9][a-z0-9/._-]{0,127}$/u);

const modelNameOf = (v: string) => {
  const name = v.replace(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//iu,
    ""
  );

  return name !== "" && locatorFree(name) ? v : undefined;
};

const modelName = (v: unknown) =>
  typeof v === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9_.:/@[\]-]{0,95}$/u.test(v) &&
  !/^[A-Za-z]:|\/\//u.test(v)
    ? modelNameOf(v)
    : undefined;

const isoDateOf = (v: string) => {
  const d = new Date(`${v}T00:00:00Z`);

  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v)
    ? v
    : undefined;
};

const isoDate = (v: unknown) =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(v)
    ? isoDateOf(v)
    : undefined;

const responseCoverage = (v: unknown) =>
  RESPONSE_COVERAGES.find((c) => c === v) ?? "unknown";

const billingCoverageOf = (
  billingCoverage: ReturnType<typeof responseCoverage>,
  totalNanoAiu: number | undefined,
  statuses: readonly string[],
  multipliers: readonly number[]
): ReturnType<typeof responseCoverage> => {
  const incomplete =
    totalNanoAiu === undefined ||
    statuses.length === 0 ||
    statuses.some((s) => s !== "complete") ||
    multipliers.length === 0;

  if (billingCoverage !== "complete" || !incomplete) {
    return billingCoverage;
  }

  return totalNanoAiu === undefined ? "unknown" : "partial";
};

const copilotDetails = (value: JsonObject, raw: JsonObject) => {
  const statuses = list(raw["statuses"])
    .flatMap((v) => {
      const status = token(v);

      return status === undefined ? [] : [status];
    })
    .slice(0, 8);

  const multipliers = list(raw["multipliers"])
    .filter(
      (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0
    )
    .slice(0, 8);

  const totalNanoAiu = count(raw["totalNanoAiu"]);
  const billingCoverage = responseCoverage(raw["coverage"]);

  return {
    tokenCoverage: responseCoverage(value["tokenCoverage"]),
    lineageCoverage: responseCoverage(value["lineageCoverage"]),
    actorCoverage: responseCoverage(value["actorCoverage"]),
    billing: {
      coverage: billingCoverageOf(
        billingCoverage,
        totalNanoAiu,
        statuses,
        multipliers
      ),
      ...opt("totalNanoAiu", totalNanoAiu),
      ...(statuses.length && { statuses }),
      ...(multipliers.length && { multipliers }),
    },
  };
};

const copilotOf = (value: unknown) =>
  record(value) && record(value["billing"])
    ? copilotDetails(value, value["billing"])
    : undefined;

const count = (v: unknown) => (safeCount(v) ? v : undefined);

const millis = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.round(v)
    : undefined;

export const opt = <K extends string, V>(key: K, value: V | undefined) => {
  const entry: { [P in K]?: V } = {};

  if (value !== undefined) {
    entry[key] = value;
  }

  return entry;
};

const safeText = (v: unknown) =>
  typeof v === "string" &&
  v.trim() !== "" &&
  Buffer.byteLength(v) <= DIAGNOSTIC_LIMITS.fieldBytes &&
  locatorFree(v)
    ? v.replaceAll(/\s+/gu, " ").trim()
    : undefined;

const componentOf = (v: unknown) =>
  (typeof v === "string" ? [v.replace(/^skills\/dispatch\//u, "")] : []).find(
    (relative) => COMPONENTS.has(relative)
  );

const isCategory = (key: string): key is Category =>
  Object.hasOwn(CATEGORIES, key);

const categoryOf = (v: unknown) =>
  Object.keys(CATEGORIES)
    .filter(isCategory)
    .find((key) => v === key || v === CATEGORIES[key]);

const isBand = (key: string): key is keyof Bands =>
  BANDS.some((band) => band === key);

const bandsOfValue = (v: JsonObject, expected: Counters): Bands | null => {
  const entries = Object.entries(v);

  if (!entries.length) {
    return null;
  }

  const out: Bands = {};
  const summed: Counters = { input: 0, output: 0 };

  for (const [key, raw] of entries) {
    if (!isBand(key)) {
      return null;
    }

    const c = baseCounters(raw);

    if (!c) {
      return null;
    }

    out[key] = c;
    addCounters(summed, c);
  }

  if (summed.input !== expected.input || summed.output !== expected.output) {
    return null;
  }

  if (
    (
      [
        "cacheRead",
        "cacheWrite",
        "cacheWrite5m",
        "cacheWrite1h",
        "reasoning",
      ] as const
    ).some((k) => summed[k] !== expected[k])
  ) {
    return null;
  }

  return out;
};

const bandsOf = (v: unknown, expected: Counters) => {
  const bands = record(v) ? bandsOfValue(v, expected) : null;

  return bands ?? undefined;
};

const countersValue = (v: JsonObject, out: Counters) => {
  const bands = bandsOf(v["bands"], out);

  return {
    ...out,
    ...(bands !== undefined && { bands }),
    ...opt("turns", count(v["turns"])),
    ...opt("toolCalls", count(v["toolCalls"])),
    ...opt("toolTurns", count(v["toolTurns"])),
  };
};

const counters = (v: unknown) => {
  const out = baseCounters(v);

  return out === undefined || !record(v) ? undefined : countersValue(v, out);
};

const mergeModelUsage = (a: ModelUsage, b: ModelUsage) => {
  const {
    turns: aTurns,
    toolCalls: aToolCalls,
    toolTurns: aToolTurns,
    ...base
  } = a;

  const merged: ModelUsage = addCounters(base, b);
  const aSums = { turns: aTurns, toolCalls: aToolCalls, toolTurns: aToolTurns };

  for (const key of ["turns", "toolCalls", "toolTurns"] as const) {
    const aValue = aSums[key];
    const bValue = b[key];

    if (
      aValue !== undefined &&
      bValue !== undefined &&
      Number.isSafeInteger(aValue + bValue)
    ) {
      merged[key] = aValue + bValue;
    }
  }

  if (a.bands && b.bands) {
    const bands: Bands = { ...a.bands };

    const added = Object.entries(b.bands).filter(
      (entry): entry is [keyof Bands, Counters] => isBand(entry[0])
    );

    for (const [band, bv] of added) {
      bands[band] = bands[band]
        ? addCounters({ ...bands[band] }, bv)
        : { ...bv };
    }

    merged.bands = bands;
  } else {
    delete merged.bands;
  }

  return merged;
};

const collectCopilotActors = (
  raw: unknown,
  copilot: ReturnType<typeof copilotOf>,
  base: Counters
): CopilotActor[] | undefined => {
  if (copilot === undefined || !Array.isArray(raw)) {
    return undefined;
  }

  const actors: CopilotActor[] = [];

  for (const actor of raw) {
    if (!record(actor)) {
      continue;
    }

    const actorCounters = counters(actor);
    const evidence = copilotOf(actor["copilot"]);

    const role = (["delegate", "subagent"] as const).find(
      (candidate) =>
        candidate ===
        (typeof actor["role"] === "string" ? actor["role"] : undefined)
    );

    if (!actorCounters || !evidence || !role) {
      continue;
    }

    const agent = match(/^actor-(?:[1-9]|[12][0-9]|3[0-2])$/u)(actor["agent"]);

    actors.push({
      ...actorCounters,
      role,
      model: modelName(actor["model"]) ?? DASH,
      effort: token(actor["effort"]) ?? null,
      copilot: evidence,
      ...opt("agent", agent),
      ...opt(
        "parent",
        agent === undefined
          ? undefined
          : match(/^actor-(?:[1-9]|[12][0-9]|3[0-2])$/u)(actor["parent"])
      ),
      ...opt(
        "depth",
        agent !== undefined && evidence.lineageCoverage === "complete"
          ? count(actor["depth"])
          : undefined
      ),
    });
  }

  let total: Counters = { input: 0, output: 0 };

  for (const a of actors) {
    total = addCounters(total, a);
  }

  return actors.length > 0 &&
    (
      ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const
    ).every((k) => (total[k] ?? 0) === (base[k] ?? 0))
    ? actors
    : undefined;
};

const usageDetails = (
  v: JsonObject,
  base: Counters,
  subtractCache: boolean
) => {
  const canonicalCounters = (u: Counters) =>
    subtractCache
      ? { ...u, input: Math.max(0, u.input - (u.cacheRead ?? 0)) }
      : u;

  const canonical = (u: ModelUsage) => {
    const c = canonicalCounters(u);

    return u.bands
      ? {
          ...c,
          bands: Object.fromEntries(
            Object.entries(u.bands).map(([b, bv]) => [b, canonicalCounters(bv)])
          ),
        }
      : c;
  };

  const out: Usage = {
    ...canonical(base),
    ...(typeof v["reasoningInOutput"] === "boolean" && {
      reasoningInOutput: v["reasoningInOutput"],
    }),
  };

  const copilot = copilotOf(v["copilot"]);

  if (copilot) {
    out.copilot = copilot;
  }

  const actors = collectCopilotActors(v["actors"], copilot, base);

  if (actors !== undefined) {
    out.actors = actors;
  }

  const models = record(v["models"]) ? Object.entries(v["models"]) : [];

  const parts = models.map(([key, part]) => {
    const split = splitUsageKey(key);
    const name = modelName(split.model);

    const effort =
      split.effort === undefined ? undefined : (token(split.effort) ?? "");

    return {
      key: effort === undefined ? name : `${name ?? ""}#${effort}`,
      part: counters(part),
      keyed: effort !== undefined,
    };
  });

  if (
    parts.length > 0 &&
    parts.every(
      ({ key, part, keyed }) =>
        part !== undefined && (keyed || (key !== undefined && key !== ""))
    )
  ) {
    const grouped = new Map<string, ModelUsage>();

    for (const { key, part } of parts) {
      const name = defined(key);
      const usage = canonical(defined(part));
      const current = grouped.get(name);
      grouped.set(name, current ? mergeModelUsage(current, usage) : usage);
    }

    out.models = boundModels(Object.fromEntries(grouped));
  }

  return out;
};

const usageOf = (v: unknown, subtractCache: boolean) => {
  const base = counters(v);

  return base === undefined || !record(v)
    ? undefined
    : usageDetails(v, base, subtractCache);
};

/** Canonical counters: `input` excludes cache reads, so providers that count them inside input (Codex) compare equally. */

export const normalizeUsage = (
  raw: unknown,
  inputSemantics: "includes-cache" | "uncached"
) => usageOf(raw, inputSemantics === "includes-cache");

export const uncached = (u: ModelUsage) =>
  u.input + (u.cacheWrite ?? 0) + u.output;

export const measured = (i: InvocationFacts) =>
  i.surface !== "cli" || !i.launched ? undefined : i.usage;

/** Gates host retro items: at most `DIAGNOSTIC_LIMITS.observations`, valid id, dispatch-owned component, known category, bounded locator-free text. */

export const retroObservations = (value: unknown) => {
  if (!Array.isArray(value)) {
    return { state: "invalid", values: [], rejected: 0 };
  }

  const items = list(value);
  const values: RetroObservation[] = [];
  let rejected = Math.max(0, items.length - DIAGNOSTIC_LIMITS.observations);

  for (const item of items.slice(0, DIAGNOSTIC_LIMITS.observations)) {
    const row = record(item) ? item : {};
    const id = match(ID)(row["id"]);
    const component = componentOf(row["component"]);
    const category = categoryOf(row["category"]);
    const evidence = safeText(row["evidence"]);
    const impact = safeText(row["impact"]);
    const proposedFix = safeText(row["proposedFix"]);

    if (
      id === undefined ||
      values.some((v) => v.id === id) ||
      component === undefined ||
      category === undefined ||
      evidence === undefined ||
      impact === undefined ||
      proposedFix === undefined
    ) {
      rejected += 1;
      continue;
    }

    values.push({ id, component, category, evidence, impact, proposedFix });
  }

  return { state: items.length ? "collected" : "empty", values, rejected };
};

const pricingKeyOk = (key: string) =>
  modelName(key) !== undefined ||
  (key.endsWith("/*") && token(key.slice(0, -2)) !== undefined);

const pricingValue = (v: unknown) => {
  if (!record(v)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(v)
      .filter(
        ([key, entry]) =>
          pricingKeyOk(key) && !pricingProblems({ [key]: entry }).length
      )
      .slice(0, 32)
      .map(([key, entry]) => [key, structuredClone(entry)])
  );
};

const configValue = (v: unknown, depth: number): JsonValue => {
  if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) {
    return v;
  }

  if (typeof v === "string") {
    return modelName(v) ?? DASH;
  }

  if (depth >= 6) {
    return DASH;
  }

  if (Array.isArray(v)) {
    return v.slice(0, 16).map((item) => configValue(item, depth + 1));
  }

  if (record(v)) {
    return Object.fromEntries(
      Object.entries(v)
        .filter(
          ([key]) => /^[A-Za-z0-9_-]{1,40}$/u.test(key) && locatorFree(key)
        )
        .slice(0, 32)
        .map(([key, item]) => [key, configValue(item, depth + 1)])
    );
  }

  return DASH;
};

const isLifecycleMs = (x: unknown): x is number =>
  Number.isSafeInteger(x) && Number(x) >= 0 && Number(x) <= 2_147_483_647;

const lifecycleOf = (v: unknown) => {
  const rows: LifecycleStep[] = [];

  for (const r of list(v)) {
    if (!record(r) || Object.keys(r).length !== 4) {
      continue;
    }

    const step = (
      [
        "debug-config",
        "debug-agents",
        "prepare",
        "response",
        "teardown",
      ] as const
    ).find((x) => x === r["step"]);

    const outcome = (["ok", "failed", "timeout", "unconfirmed"] as const).find(
      (x) => x === r["outcome"]
    );

    if (
      step &&
      outcome &&
      isLifecycleMs(r["elapsedMs"]) &&
      isLifecycleMs(r["budgetMs"]) &&
      !rows.some((x) => x.step === step)
    ) {
      rows.push({
        step,
        elapsedMs: r["elapsedMs"],
        budgetMs: r["budgetMs"],
        outcome,
      });
    }
  }

  return rows.length ? rows : undefined;
};

const coverageOf = (v: unknown) => {
  const raw = typeof v === "string" ? [v] : list(v);

  const reasons = [
    ...new Set(
      raw.flatMap((x) => {
        const mapped = x === "no usage output" ? "no usage" : x;

        const reason = COVERAGE_REASONS.find(
          (candidate) => candidate === mapped
        );

        return reason ? [reason] : [];
      })
    ),
  ];

  return reasons.length ? reasons : undefined;
};

const reportedModelsOf = (
  v: JsonObject,
  usage: Usage | undefined
): Pick<InvocationFacts, "reportedModels" | "reportedModelAmbiguous"> => {
  const raw = list(v["reportedModels"]);
  const names = raw.slice(0, 8).map(modelName);

  const reported = [
    ...new Set(names.filter((name): name is string => name !== undefined)),
  ];

  const ambiguous =
    v["reportedModelAmbiguous"] === true ||
    raw.length > 8 ||
    names.some((name) => name === undefined) ||
    (v["reportedModels"] !== undefined &&
      !Array.isArray(v["reportedModels"])) ||
    (record(v["usage"]) &&
      record(v["usage"]["models"]) &&
      Object.keys(v["usage"]["models"]).length > 0 &&
      !usage?.models);

  return {
    ...opt("reportedModels", reported.length ? reported : undefined),
    ...(ambiguous && { reportedModelAmbiguous: true }),
  };
};

const usageSourceOf = (value: unknown): UsageSource | undefined =>
  value === "session" || value === "stdout" ? value : undefined;

const delegateAgent = match(/^delegate-(?:child-)?[a-f0-9]{16}$/u);

const responseIdentityOf = (item: JsonObject, delegate: boolean) => {
  const stage = RESPONSE_STAGES.find((x) => x === item["stage"]);

  const role = (
    delegate ? (["delegate", "subagent"] as const) : HOST_ROLES
  ).find((x) => x === item["role"]);

  const basis =
    delegate && item["basis"] === "unavailable"
      ? ("unavailable" as const)
      : HOST_RESPONSE_BASES.find((x) => x === item["basis"]);

  const coverage = RESPONSE_COVERAGES.find((x) => x === item["coverage"]);

  return stage !== undefined &&
    role !== undefined &&
    basis !== undefined &&
    coverage !== undefined
    ? { stage, role, basis, coverage }
    : undefined;
};

const responseAgentValidityOf = (
  item: JsonObject,
  delegate: boolean,
  role: string
) => {
  const agent = delegate
    ? delegateAgent(item["agent"])
    : responseAgent(item["agent"]);

  const valid =
    agent !== undefined &&
    (delegate
      ? agent.startsWith("delegate-child-") === (role === "subagent")
      : agent.startsWith(`${role}-`));

  return item["agent"] !== undefined && !valid ? undefined : agent;
};

const unknownCoverageOk = (
  item: JsonObject,
  delegate: boolean,
  observed: number | undefined
) =>
  delegate
    ? item["observed"] === undefined && item["uncachedInput"] === undefined
    : observed === undefined;

const responseCountsValid = (
  item: JsonObject,
  delegate: boolean,
  coverage: (typeof RESPONSE_COVERAGES)[number],
  basis: string,
  agent: string | undefined,
  observed: number | undefined
) =>
  coverage === "unknown"
    ? unknownCoverageOk(item, delegate, observed)
    : observed !== undefined &&
      basis !== "unavailable" &&
      !(coverage === "complete" && agent === undefined);

const responsesFromItems = (value: unknown[], source: "host" | "delegate") => {
  const delegate = source === "delegate";
  const aliases = new Set<string>();
  const keys = new Set<string>();
  const items = delegate ? value.slice(0, MAX_RESPONSE_AGENTS + 2) : value;

  const responses = items.flatMap((item: unknown) => {
    if (!record(item)) {
      return [];
    }

    const identity = responseIdentityOf(item, delegate);

    if (identity === undefined) {
      return [];
    }

    const { stage, role, basis, coverage } = identity;
    const agent = responseAgentValidityOf(item, delegate, role);

    if (agent === undefined && item["agent"] !== undefined) {
      return [];
    }

    const observed = count(item["observed"]);

    if (
      !responseCountsValid(item, delegate, coverage, basis, agent, observed)
    ) {
      return [];
    }

    const key = JSON.stringify([stage, role, basis, agent]);

    if (
      keys.has(key) ||
      (agent !== undefined &&
        !aliases.has(agent) &&
        aliases.size >= MAX_RESPONSE_AGENTS)
    ) {
      return [];
    }

    keys.add(key);

    if (agent !== undefined) {
      aliases.add(agent);
    }

    return [
      {
        stage,
        role,
        basis,
        coverage,
        ...opt("agent", agent),
        ...opt("observed", observed),
        ...opt(
          "uncachedInput",
          observed === undefined ? undefined : count(item["uncachedInput"])
        ),
        ...opt(
          "toolCalls",
          observed === undefined ? undefined : count(item["toolCalls"])
        ),
        ...opt(
          "toolTurns",
          observed === undefined ? undefined : count(item["toolTurns"])
        ),
      },
    ];
  });

  return delegate && responses.length === 0 ? undefined : responses;
};

function responsesOf(
  value: unknown,
  source: "delegate"
): DelegateResponseFacts[] | undefined;
function responsesOf(
  value: unknown,
  source: "host"
): HostResponseAggregate[] | undefined;

function responsesOf(value: unknown, source: "host" | "delegate") {
  return Array.isArray(value) ? responsesFromItems(value, source) : undefined;
}

const invocationIdentityOf = (v: JsonObject, surface: string) => ({
  phase: phaseKey(v["phase"]) ?? "",
  provider: token(v["provider"]) ?? DASH,
  model: modelName(v["model"]) ?? DASH,
  ...opt(
    "effort",
    v["effort"] === undefined ? undefined : (token(v["effort"]) ?? DASH)
  ),
  ...opt(
    "configuredEffort",
    surface === "cli" && v["provider"] === "copilot"
      ? token(v["configuredEffort"])
      : undefined
  ),
  ...opt("mode", token(v["mode"])),
});

const invocationEnumsOf = (v: JsonObject) => ({
  ...opt(
    "routingOutcome",
    (["next-model", "next-mode", "reserve", "stop"] as const).find(
      (x) => x === v["routingOutcome"]
    )
  ),
  ...opt(
    "slotState",
    (["done", "native", "failed"] as const).find((x) => x === v["slotState"])
  ),
  ...opt("validationOutcome", token(v["validationOutcome"])),
  ...opt(
    "nativeState",
    (["pending", "completed", "invalid", "failed"] as const).find(
      (x) => x === v["nativeState"]
    )
  ),
  ...opt("subject", match(/^[a-f0-9]{16}$/u)(v["subject"])),
  ...opt("attempt", count(v["attempt"])),
  ...opt(
    "targetSlot",
    match(/^[A-Za-z0-9_-]{1,40}\[\d{1,3}\]$/u)(v["targetSlot"])
  ),
});

const invocationMarkersOf = (v: JsonObject) => ({
  ...(v["superseded"] === true && { superseded: true as const }),
  ...(v["nudge"] === true && { nudge: true as const }),
  ...(v["wrapUp"] === true && { wrapUp: true as const }),
});

const invocationUsageOf = (
  v: JsonObject,
  surface: string,
  launched: boolean,
  outcome: string
) => {
  const usageSource =
    surface === "cli" ? usageSourceOf(v["usageSource"]) : undefined;

  const coverage = new Set(coverageOf(v["coverage"]));
  let usage = usageOf(v["usage"], false);

  if (surface === "cli" && launched) {
    if (usage === undefined && v["usage"] !== undefined) {
      coverage.add("invalid counters");
    }

    if (
      usage !== undefined &&
      usageSource === undefined &&
      outcome !== "ok" &&
      !hasUsageTokens(usage)
    ) {
      usage = undefined;
      coverage.add("unverified zero");
    }
  }

  return { usage, coverage, usageSource };
};

const invocationOf = (v: unknown): InvocationFacts[] => {
  if (!record(v)) {
    return [];
  }

  const surface = v["surface"] === "native" ? "native" : "cli";
  const launched = v["launched"] === true;
  const outcome = token(v["outcome"]) ?? DASH;

  const { usage, coverage, usageSource } = invocationUsageOf(
    v,
    surface,
    launched,
    outcome
  );

  return [
    {
      ...invocationIdentityOf(v, surface),
      surface,
      launched,
      ...opt("durationMs", millis(v["durationMs"])),
      ...opt("startMs", millis(v["startMs"])),
      ...opt("endMs", millis(v["endMs"])),
      ...invocationEnumsOf(v),
      outcome,
      ...opt("usage", usage),
      ...(usage && usageSource && { usageSource }),
      ...reportedModelsOf(v, usage),
      ...opt("coverage", coverage.size ? [...coverage] : undefined),
      ...opt(
        "responses",
        surface === "cli" && launched
          ? responsesOf(v["responses"], "delegate")
          : undefined
      ),
      ...opt("lifecycleSteps", lifecycleOf(v["lifecycleSteps"])),
      ...opt(
        "slot",
        match(/^[A-Za-z0-9_.-]{1,40}(?:\[\d{1,3}\])?$/u)(v["slot"])
      ),
      ...invocationMarkersOf(v),
    },
  ];
};

const hostUsageDetails = (value: JsonObject) => {
  const rows: HostUsageRow[] = list(value["rows"]).flatMap((v) => {
    if (!record(v)) {
      return [];
    }

    const stage = STAGE_ORDER.find((x) => x === v["stage"]);
    const role = HOST_ROLES.find((x) => x === v["role"]);
    const usage = counters(v);

    if (!stage || !role || !usage) {
      return [];
    }

    return [
      {
        stage,
        ...opt("phase", phaseKey(v["phase"])),
        role,
        model: modelName(v["model"]) ?? DASH,
        effort: token(v["effort"]) ?? null,
        ...opt("copilot", copilotOf(v["copilot"])),
        ...opt("agent", responseAgent(v["agent"])),
        ...opt("parent", responseAgent(v["parent"])),
        ...usage,
        ...opt(
          "maxDepth",
          role === "subagent" ? count(v["maxDepth"]) : undefined
        ),
        ...(typeof v["reasoningInOutput"] === "boolean" && {
          reasoningInOutput: v["reasoningInOutput"],
        }),
      },
    ];
  });

  const notes: NonNullable<HostUsageFacts["notes"]> = {};

  if (record(value["notes"])) {
    for (const role of HOST_ROLES) {
      const raw = value["notes"][role];

      if (!record(raw)) {
        continue;
      }

      const clean = Object.fromEntries(
        HOST_NOTES.flatMap((key) => {
          const n = count(raw[key]);

          return n === undefined ? [] : [[key, n]];
        })
      );

      if (Object.keys(clean).length) {
        notes[role] = clean;
      }
    }
  }

  const rawByStage = record(value["userTurnsByStage"])
    ? value["userTurnsByStage"]
    : undefined;

  const byStageEntries = rawByStage
    ? STAGE_ORDER.flatMap((stage) => {
        const n = count(rawByStage[stage]);

        return n === undefined ? [] : [[stage, n] as const];
      })
    : [];

  // SAFETY: byStageEntries keys come from STAGE_ORDER with count-validated numbers, matching userTurnsByStage.
  const userTurnsByStage = byStageEntries.length
    ? (Object.fromEntries(byStageEntries) as HostUsageFacts["userTurnsByStage"])
    : undefined;

  const unavailable = HOST_UNAVAILABLE.find((x) => x === value["unavailable"]);

  return {
    platform: token(value["platform"]) ?? null,
    rows,
    ...opt("responses", responsesOf(value["responses"], "host")),
    ...opt("userTurns", count(value["userTurns"])),
    ...opt("userTurnsByStage", userTurnsByStage),
    ...opt("subagentCount", count(value["subagentCount"])),
    ...opt("maxSubagentDepth", count(value["maxSubagentDepth"])),
    ...opt("unavailable", unavailable),
    ...(Object.keys(notes).length > 0 && { notes }),
  };
};

const hostUsageOf = (value: unknown) =>
  record(value) ? hostUsageDetails(value) : undefined;

export const recoveryRef = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value
  );

const recoverySelectionDetails = (value: JsonObject) => {
  const { review, targetHash, round, generation } = value;

  const valid =
    review === "code-integration" &&
    typeof targetHash === "string" &&
    /^[0-9a-f]{64}$/u.test(targetHash) &&
    safeCount(round) &&
    round >= 1 &&
    safeCount(generation) &&
    generation >= 1;

  return valid
    ? {
        review: "code-integration" as const,
        targetHash,
        round,
        generation,
      }
    : undefined;
};

const recoverySelectionOf = (value: unknown) =>
  record(value) ? recoverySelectionDetails(value) : undefined;

const recoveryExecutionDetails = (
  value: JsonObject,
  ref: string
): RecoveryExecution => {
  const result: RecoveryExecution = { ref };

  for (const key of ["reused", "launched", "unresolved"] as const) {
    const n = value[key];

    if (safeCount(n) && n <= 1_000_000) {
      result[key] = n;
    }
  }

  return result;
};

const recoveryExecutionOf = (value: unknown) => {
  const ref = record(value) ? value["ref"] : undefined;

  return recoveryRef(ref) && record(value)
    ? recoveryExecutionDetails(value, ref)
    : undefined;
};

const reviewIds = (value: unknown) =>
  list(value)
    .map(match(ID))
    .filter((id): id is string => id !== undefined);

const sanitizeConfigEntry = (key: string, value: JsonValue) => {
  if (key === "read-commands" && Array.isArray(value)) {
    return value.slice(0, 16).map(commandText);
  }

  return key === "pricing" ? pricingValue(value) : configValue(value, 0);
};

const nonzeroCount = (value: number | undefined) =>
  value !== undefined && value !== 0 ? value : undefined;

const slotYieldEffortOf = (value: JsonObject) =>
  value["effort"] === null || value["effort"] === undefined
    ? null
    : (token(value["effort"]) ?? DASH);

const slotYieldAttemptsOf = (value: unknown) =>
  Array.isArray(value)
    ? value.filter(record).map((a) => {
        const usage = usageOf(a["usage"], false);

        return {
          provider: token(a["provider"]) ?? DASH,
          model: modelName(a["model"]) ?? DASH,
          effort: slotYieldEffortOf(a),
          ...opt("usage", usage),
          ...opt(
            "usageSource",
            usage === undefined ? undefined : usageSourceOf(a["usageSource"])
          ),
          ...reportedModelsOf(a, usage),
          ...opt("coverage", coverageOf(a["coverage"])),
        };
      })
    : undefined;

const sanitizeRecoverySelectionsOf = (value: unknown) =>
  Array.isArray(value)
    ? value.slice(0, 1000).flatMap((item) => {
        const selection = recoverySelectionOf(item);

        return selection && record(item) && recoveryRef(item["ref"])
          ? [{ ...selection, ref: item["ref"] }]
          : [];
      })
    : undefined;

const sanitizeRecoveryExecutionsOf = (value: unknown) =>
  Array.isArray(value)
    ? value.slice(0, 1000).flatMap((item) => recoveryExecutionOf(item) ?? [])
    : undefined;

const sanitizeHostsOf = (value: unknown) => {
  const hosts = Array.isArray(value)
    ? [
        ...new Set(
          value.map(token).filter((h): h is string => h !== undefined)
        ),
      ].slice(0, 32)
    : undefined;

  return hosts !== undefined && hosts.length > 0 ? hosts : undefined;
};

const sanitizeCollectionOf = (value: unknown) =>
  record(value)
    ? Object.fromEntries(
        [
          "completed",
          "partial",
          "corrupt",
          "unreadable",
          "incomplete",
          "storageFailed",
        ].flatMap((k) => {
          const n = count(value[k]);

          return n === undefined ? [] : [[k, Math.min(1_000_000, n)]];
        })
      )
    : undefined;

const sanitizeProvenanceOf = (value: unknown) =>
  Array.isArray(value)
    ? value
        .slice(0, 100)
        .filter(record)
        .map((p) => {
          const clean = sanitizeFacts({
            ...p,
            phases: [],
            invocations: [],
            reviews: [],
          });

          return {
            ...opt("version", clean.version),
            ...opt("build", clean.build),
            ...opt("config", clean.config),
          };
        })
    : undefined;

const sanitizeRejectedToolsOf = (value: unknown) =>
  Array.isArray(value)
    ? value
        .slice(0, 1000)
        .filter(record)
        .flatMap((v) => {
          const cls = [
            "invalid-input",
            "invalid-record",
            "approval-stale",
            "key-conflict",
            "user-only",
          ].find((x) => x === v["cls"]);

          const tool = token(v["tool"]);
          const action = token(v["action"]);

          return cls !== undefined && tool !== undefined && action !== undefined
            ? [{ tool, action, cls }]
            : [];
        })
    : undefined;

const sanitizeRelaunchesOf = (value: unknown) => {
  const n = count(value);

  return n === undefined ? undefined : Math.min(1_000_000, n);
};

/** Rebuilds facts from allowlisted fields only, excluding session paths and arbitrary text. */

export const sanitizeFacts = (run: unknown): RunFacts => {
  const r = record(run) ? run : {};

  const build =
    typeof r["build"] === "string" && /^[a-f0-9]{12,64}$/u.test(r["build"])
      ? r["build"]
      : undefined;

  const savedConfig = r["config"];
  let config: RunFacts["config"];

  if (record(savedConfig)) {
    config = {};

    for (const key of CONFIG_KEYS) {
      const value = savedConfig[key];

      if (value !== undefined) {
        config[key] = sanitizeConfigEntry(key, value);
      }
    }
  }

  const fault = record(r["fault"]) ? r["fault"] : undefined;

  return {
    ...opt("recoverySelection", recoverySelectionOf(r["recoverySelection"])),
    ...opt("recoveryExecution", recoveryExecutionOf(r["recoveryExecution"])),
    ...opt(
      "recoverySelections",
      sanitizeRecoverySelectionsOf(r["recoverySelections"])
    ),
    ...opt(
      "recoveryExecutions",
      sanitizeRecoveryExecutionsOf(r["recoveryExecutions"])
    ),
    ...opt("hostUsage", hostUsageOf(r["hostUsage"])),
    ...opt("startedAt", isoDate(r["startedAt"])),
    ...opt("hosts", sanitizeHostsOf(r["hosts"])),
    ...opt(
      "capture",
      record(r["capture"]) &&
        (r["capture"]["state"] === "opened" ||
          r["capture"]["state"] === "completed")
        ? ({
            state: r["capture"]["state"],
            start: millis(r["capture"]["start"]) ?? 0,
            ...opt("end", millis(r["capture"]["end"])),
            ...opt("storageFailed", count(r["capture"]["storageFailed"])),
          } satisfies NonNullable<RunFacts["capture"]>)
        : undefined
    ),
    ...opt(
      "retroState",
      (
        [
          "missing",
          "unreadable",
          "malformed",
          "invalid",
          "empty",
          "collected",
        ] as const
      ).find((x) => x === r["retroState"])
    ),
    ...opt("collection", sanitizeCollectionOf(r["collection"])),
    ...opt("provenance", sanitizeProvenanceOf(r["provenance"])),
    ...opt("rejectedTools", sanitizeRejectedToolsOf(r["rejectedTools"])),
    ...opt("relaunches", sanitizeRelaunchesOf(r["relaunches"])),
    ...opt(
      "version",
      match(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,32})?$/u)(r["version"])
    ),
    ...opt("build", build?.slice(0, 12)),
    ...opt("os", token(r["os"])),
    ...opt("host", token(r["host"])),
    ...opt("hostThread", match(/^[a-f0-9]{16}$/u)(r["hostThread"])),
    ...opt(
      "verb",
      VERBS.find((v) => v === r["verb"])
    ),
    ...opt(
      "level",
      LEVELS.find((v) => v === r["level"])
    ),
    ...opt("pins", match(/^[A-Za-z0-9_.,:-]{1,96}$/u)(r["pins"])),
    ...opt("config", config),
    ...opt("outcome", token(r["outcome"])),
    ...opt(
      "fault",
      fault && {
        ...opt(
          "effectId",
          match(/^[a-z0-9-]+(?:\.[a-z0-9-]+){0,15}$/u)(fault["effectId"])
        ),
        cls: token(fault["cls"]) ?? DASH,
        ...opt("hostWaitMs", millis(fault["hostWaitMs"])),
        ...opt(
          "waitBy",
          (["user", "host"] as const).find((by) => by === fault["waitBy"])
        ),
        ...opt("driverMs", millis(fault["driverMs"])),
      }
    ),
    ...opt(
      "timingScope",
      r["timingScope"] === "tool-calls" ? ("tool-calls" as const) : undefined
    ),
    phases: list(r["phases"])
      .filter(record)
      .map((p) => ({
        key: phaseKey(p["key"]) ?? "",
        name: PHASE_NAMES.find((name) => name === p["name"]) ?? DASH,
        ...opt("outcome", token(p["outcome"])),
        ...opt("wallMs", millis(p["wallMs"])),
        ...opt("driverMs", millis(p["driverMs"])),
        ...opt("hostMs", millis(p["hostMs"])),
        ...opt("userMs", millis(p["userMs"])),
      })),
    invocations: list(r["invocations"]).flatMap(invocationOf),
    reviews: list(r["reviews"])
      .filter(record)
      .flatMap((v) => {
        const round = count(v["round"]);
        const cap = count(v["cap"]);

        if (round === undefined || round === 0) {
          return [];
        }

        const reraised = reviewIds(v["reraised"]);

        const escalation = record(v["escalation"])
          ? v["escalation"]
          : undefined;

        const kind =
          escalation?.["kind"] === "regression" ||
          escalation?.["kind"] === "deadlock"
            ? escalation["kind"]
            : undefined;

        return [
          {
            ...opt("phase", phaseKey(v["phase"])),
            round,
            accepted: count(v["accepted"]) ?? 0,
            rejected: count(v["rejected"]) ?? 0,
            ...opt("recurring", count(v["recurring"])),
            ...opt("reraised", reraised.length ? reraised : undefined),
            ...opt(
              "escalation",
              kind && { kind, ids: reviewIds(escalation?.["ids"]) }
            ),
            ...opt(
              "cap",
              cap !== undefined && cap <= MAX_REVIEW_ROUND_CAP ? cap : undefined
            ),
          },
        ];
      }),
    ...opt(
      "roundTiming",
      Array.isArray(r["roundTiming"])
        ? r["roundTiming"].filter(record).flatMap((v) => {
            const review = match(/^review-[a-f0-9]{16}$/u)(v["review"]);
            const round = count(v["round"]);

            if (review === undefined || round === undefined || round === 0) {
              return [];
            }

            const slots = list(v["slots"]).map((s) => {
              const slot = record(s)
                ? match(/^[A-Za-z0-9_.-]{1,40}(?:\[\d{1,3}\])?$/u)(s["slot"])
                : undefined;

              const attempts =
                slot !== undefined && record(s)
                  ? list(s["attempts"]).map((a) =>
                      record(a)
                        ? {
                            ...opt("startMs", millis(a["startMs"])),
                            ...opt("endMs", millis(a["endMs"])),
                            ...opt(
                              "surface",
                              (["cli", "native"] as const).find(
                                (surface) => surface === a["surface"]
                              )
                            ),
                          }
                        : {}
                    )
                  : [];

              return { slot: slot ?? DASH, attempts };
            });

            return [{ review, round, slots }];
          })
        : undefined
    ),
    ...opt(
      "roundWorkload",
      Array.isArray(r["roundWorkload"])
        ? r["roundWorkload"]
            .slice(0, 1000)
            .filter(record)
            .flatMap((v) => {
              const review = match(/^review-[a-f0-9]{16}$/u)(v["review"]);
              const round = count(v["round"]);

              if (review === undefined || round === undefined || round === 0) {
                return [];
              }

              const calls = record(v["calls"]) ? v["calls"] : undefined;

              const total =
                calls === undefined ? undefined : count(calls["total"]);

              const phases =
                calls !== undefined && Array.isArray(calls["phases"])
                  ? calls["phases"]
                      .slice(0, 100)
                      .filter(record)
                      .flatMap((p) => {
                        const key = phaseKey(p["key"]);
                        const n = count(p["count"]);

                        return key !== undefined &&
                          key !== "" &&
                          n !== undefined
                          ? [{ key, count: n }]
                          : [];
                      })
                  : [];

              const kind = (["plan", "design", "code"] as const).find(
                (candidate) => candidate === v["kind"]
              );

              return [
                {
                  review,
                  round,
                  ...opt("kind", kind),
                  ...opt("hostTurns", count(v["hostTurns"])),
                  ...opt(
                    "calls",
                    total === undefined ? undefined : { total, phases }
                  ),
                  ...opt("hostTokens", count(v["hostTokens"])),
                  ...opt("reviewerTurns", count(v["reviewerTurns"])),
                  ...opt(
                    "reviewerTurnsPartial",
                    v["reviewerTurnsPartial"] === true
                      ? (true as const)
                      : undefined
                  ),
                },
              ];
            })
        : undefined
    ),
    ...opt(
      "slotYield",
      Array.isArray(r["slotYield"])
        ? r["slotYield"].filter(record).flatMap((v) => {
            const kind = (["provider", "native", "tool"] as const).find(
              (name) => name === v["kind"]
            );

            const provider = token(v["provider"]);

            if (kind === undefined || provider === undefined) {
              return [];
            }

            const raised = record(v["raised"]) ? v["raised"] : {};

            const fixInduced = count(v["fixInduced"]);
            const priorLaunches = count(v["priorLaunches"]);

            const attempts = slotYieldAttemptsOf(v["attempts"]);

            return [
              {
                kind,
                provider,
                model:
                  kind === "provider" ? (modelName(v["model"]) ?? null) : null,
                raised: {
                  MUST: count(raised["MUST"]) ?? 0,
                  SHOULD: count(raised["SHOULD"]) ?? 0,
                  CONSIDER: count(raised["CONSIDER"]) ?? 0,
                },
                accepted: count(v["accepted"]) ?? 0,
                rejected: count(v["rejected"]) ?? 0,
                deferred: count(v["deferred"]) ?? 0,
                duplicate: count(v["duplicate"]) ?? 0,
                unruled: count(v["unruled"]) ?? 0,
                ...opt("tokens", count(v["tokens"])),
                ...opt("fixInduced", nonzeroCount(fixInduced)),
                measured: count(v["measured"]) ?? 0,
                launched: count(v["launched"]) ?? 0,
                ...opt("priorLaunches", nonzeroCount(priorLaunches)),
                ...opt(
                  "attempts",
                  attempts !== undefined && attempts.length > 0
                    ? attempts
                    : undefined
                ),
              },
            ];
          })
        : undefined
    ),
    ...opt("observations", r["observations"]),
  };
};
