import path from "node:path";

import { isRecord, loadConfig, readReal } from "./config.ts";
import type { JsonValue, ReadFile } from "./config.ts";
import { BAND_EDGES, OTHER_KEY } from "./usage/bands.ts";
import { BANDS, splitUsageKey } from "./usage/rows.ts";
import type { Bands, Counters } from "./usage/rows.ts";

const priceUsage = (
  matched: MatchedRate | undefined,
  usage: Counters & { bands?: Bands },
  reasoningInOutput: boolean | undefined,
  onDate: string | undefined
) => {
  if (!matched) {
    return unpriced();
  }

  const { entry, origin, match } = matched;
  const effectiveDay = isIsoDate(onDate) ? onDate : null;
  const active = activeRateSet(entry, effectiveDay);
  const apart = reasoningInOutput === false;

  const spans: { c: Counters; first: number; last: number }[] = [];

  for (const [i, band] of BANDS.entries()) {
    const c = usage?.bands?.[band];

    if (c) {
      const lower = BAND_EDGES[i - 1];
      spans.push({
        c,
        first: tierAt(active, lower === undefined ? 0 : lower + 1),
        last: tierAt(active, BAND_EDGES[i] ?? Infinity),
      });
    }
  }

  if (!spans.length) {
    spans.push({
      c: usage ?? NONE,
      first: 0,
      last: tierAt(active, promptOf(usage ?? NONE)),
    });
  }

  let high = 0;
  let low = 0;

  const reasons = new Set<CostReason>();

  for (const { c, first, last } of spans) {
    const options = Array.from({ length: last - first + 1 }, (_, i) =>
      rated(c, tierRates(active, first + i), apart)
    );

    const quotes = options.flatMap((option) => (option ? [option] : []));

    if (quotes.length !== options.length) {
      return unpriced();
    }

    low += Math.min(...quotes.map((o) => o.low)) / MTOK;
    high += Math.max(...quotes.map((o) => o.high)) / MTOK;

    if (first < last) {
      reasons.add("tier unknown");
    }

    if (quotes.some((o) => o.ttl)) {
      reasons.add("cache TTL unknown");
    }
  }

  const rateBasis = {
    origin,
    match,
    effectiveDay,
    periodFrom: active.from ?? null,
  };

  return Number.isFinite(high)
    ? { low, high, priced: true, reasons, rateBasis }
    : unpriced();
};

interface Rates {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

interface Tier {
  abovePromptTokens: number;
  rates: Rates;
}

interface Period {
  from: string;
  rates: Rates;
  tiers?: Tier[];
}

interface PriceEntry {
  rates: Rates;
  tiers?: Tier[];
  periods?: Period[];
}

export type CostReason =
  | "unpriced model"
  | "no usage"
  | "tier unknown"
  | "cache TTL unknown";

export interface AppliedRateBasis {
  origin: "shipped" | "override";
  match: "qualified" | "wildcard" | "generic";
  effectiveDay: string | null;
  periodFrom: string | null;
}

/** USD; `low` equals `high` unless a tier or cache TTL is unknown. */
export interface Cost {
  low: number;
  high: number;
  priced: boolean;
  reasons: Set<CostReason>;
  rateBasis?: AppliedRateBasis;
}

interface MatchedRate {
  entry: PriceEntry;
  origin: AppliedRateBasis["origin"];
  match: AppliedRateBasis["match"];
}

export interface Pricer {
  meta: { asOf: string; source: readonly string[] };
  price: (
    model: string,
    usage: Counters & { bands?: Bands },
    reasoningInOutput?: boolean,
    onDate?: string
  ) => Cost;
}

const RATE_KEYS = new Set([
  "input",
  "output",
  "cacheRead",
  "cacheWrite5m",
  "cacheWrite1h",
]);

const isRate = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

const ratesProblem = (v: unknown, where: string) => {
  if (!isRecord(v)) {
    return `${where} not an object`;
  }

  for (const [key, rate] of Object.entries(v)) {
    if (!RATE_KEYS.has(key)) {
      return `${where}.${key} unknown key`;
    }

    if (!isRate(rate)) {
      return `${where}.${key} must be a finite number >= 0`;
    }
  }

  return ["input", "output"]
    .map((key) =>
      v[key] === undefined ? `${where}.${key} missing` : undefined
    )
    .find(Boolean);
};

const rateKeys = (r: unknown) =>
  Object.keys(isRecord(r) ? r : {})
    .toSorted()
    .join(",");

const isIsoDate = (v: JsonValue | undefined): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(v)) {
    return false;
  }

  const d = new Date(`${v}T00:00:00Z`);

  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
};

const tiersProblem = (
  tiers: unknown,
  baseRates: unknown,
  where: string
): string | undefined => {
  if (tiers === undefined) {
    return undefined;
  }

  if (!Array.isArray(tiers)) {
    return `${where} not an array`;
  }

  let previous = 0;

  for (const [i, tier] of tiers.entries()) {
    const slot = `${where}[${i}]`;

    if (
      !isRecord(tier) ||
      Object.keys(tier).some(
        (key) => key !== "abovePromptTokens" && key !== "rates"
      )
    ) {
      return `${slot} must hold only abovePromptTokens and rates`;
    }

    const at = tier["abovePromptTokens"];

    if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= previous) {
      return `${slot}.abovePromptTokens must be a positive integer above the previous tier`;
    }

    previous = at;
    const tierBad = ratesProblem(tier["rates"], `${slot}.rates`);

    if (tierBad !== undefined) {
      return tierBad;
    }

    if (rateKeys(tier["rates"]) !== rateKeys(baseRates)) {
      return `${slot}.rates keys differ from rates`;
    }
  }

  return undefined;
};

const periodsProblem = (periods: unknown): string | undefined => {
  if (periods === undefined) {
    return undefined;
  }

  if (!Array.isArray(periods)) {
    return "periods not an array";
  }

  let previous: string | undefined;

  for (const [i, period] of periods.entries()) {
    const slot = `periods[${i}]`;

    if (
      !isRecord(period) ||
      Object.keys(period).some(
        (key) => key !== "from" && key !== "rates" && key !== "tiers"
      )
    ) {
      return `${slot} must hold only from, rates and tiers`;
    }

    const { from } = period;

    if (!isIsoDate(from)) {
      return `${slot}.from must be a valid YYYY-MM-DD date`;
    }

    if (previous !== undefined && from <= previous) {
      return `${slot}.from must be after the previous period`;
    }

    previous = from;
    const rateBad = ratesProblem(period["rates"], `${slot}.rates`);

    if (rateBad !== undefined) {
      return rateBad;
    }

    const tierBad = tiersProblem(
      period["tiers"],
      period["rates"],
      `${slot}.tiers`
    );

    if (tierBad !== undefined) {
      return tierBad;
    }
  }

  return undefined;
};

const entryProblem = (entry: unknown) => {
  if (!isRecord(entry)) {
    return "not an object";
  }

  const extra = Object.keys(entry).find(
    (key) => !["rates", "tiers", "periods"].includes(key)
  );

  if (extra !== undefined) {
    return `unknown key ${extra}`;
  }

  return (
    ratesProblem(entry["rates"], "rates") ??
    tiersProblem(entry["tiers"], entry["rates"], "tiers") ??
    periodsProblem(entry["periods"])
  );
};

const isPriceEntry = (entry: unknown): entry is PriceEntry =>
  entryProblem(entry) === undefined;

/** One message per malformed override entry, naming the key and the reason. */
export const pricingProblems = (override: unknown) => {
  if (override === undefined) {
    return [];
  }

  if (!isRecord(override)) {
    return ["pricing: not an object"];
  }

  return Object.entries(override).flatMap(([key, entry]) => {
    const problem = entryProblem(entry);

    return problem === undefined ? [] : [`pricing.${key}: ${problem}`];
  });
};

const WILDCARD = "/*";
const SUFFIXES = [/\[1m\]$/u, /@\d[\d-]*$/u, /-v\d+:\d+$/u, /-\d{8}$/u];

/** Shipped table first, then the override on top; undefined when the shipped table is invalid. */
export const resolvePricing = (
  table: unknown,
  override: unknown
): Pricer | undefined => {
  if (
    !isRecord(table) ||
    typeof table["asOf"] !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(table["asOf"]) ||
    !Array.isArray(table["source"]) ||
    !table["source"].every((url) => typeof url === "string") ||
    !isRecord(table["models"]) ||
    Object.values(table["models"]).some(
      (entry) => entryProblem(entry) !== undefined
    )
  ) {
    return undefined;
  }

  const models = new Map<string, MatchedRate>();
  const qualified = new Map<string, MatchedRate>();
  const wildcards = new Map<string, MatchedRate>();

  const sources = [
    ["shipped", table["models"]],
    ["override", isRecord(override) ? override : {}],
  ] as const;

  for (const [origin, entries] of sources) {
    for (const [key, entry] of Object.entries(entries)) {
      if (!isPriceEntry(entry)) {
        continue;
      }

      let match: "wildcard" | "qualified" | "generic";
      let index: Map<string, MatchedRate>;

      if (key.endsWith(WILDCARD)) {
        match = "wildcard";
        index = wildcards;
      } else if (key.indexOf("/") > 0) {
        match = "qualified";
        index = qualified;
      } else {
        match = "generic";
        index = models;
      }

      index.set(key.toLowerCase(), { entry, origin, match });
    }
  }

  const find = (id: string) => {
    let rest = id.toLowerCase();
    const slash = rest.indexOf("/");

    if (slash > 0) {
      const exact = qualified.get(rest);

      if (exact) {
        return exact;
      }

      const wildcard = wildcards.get(rest.slice(0, slash) + WILDCARD);

      if (wildcard) {
        return wildcard;
      }

      rest = rest.slice(slash + 1);
    }

    for (const suffix of SUFFIXES) {
      rest = rest.replace(suffix, "");
    }

    let best: string | undefined;

    for (const key of models.keys()) {
      const boundary =
        rest.length === key.length ||
        ".:/".includes(rest[rest.length - key.length - 1] ?? "");

      if (rest.endsWith(key) && boundary && key.length > (best?.length ?? 0)) {
        best = key;
      }
    }

    return best === undefined ? undefined : models.get(best);
  };

  return {
    meta: { asOf: table["asOf"], source: table["source"] },
    price: (
      model: string,
      usage: Counters & { bands?: Bands },
      reasoningInOutput?: boolean,
      onDate?: string
    ) => {
      const id = splitUsageKey(model).model;

      return priceUsage(
        id === OTHER_KEY ? undefined : find(id),
        usage,
        reasoningInOutput,
        onDate
      );
    },
  };
};

/** Reads `references/pricing.json` and the config `pricing` override; undefined only when the shipped table is unusable. */
export const loadPricing = (
  skillRoot: string,
  read: ReadFile = readReal
): Pricer | undefined => {
  try {
    const text = read(path.join(skillRoot, "references", "pricing.json"));

    if (text === null) {
      return undefined;
    }

    let override: unknown;

    try {
      override = loadConfig(skillRoot, read).config["pricing"];
    } catch {
      /* shipped table only */
    }

    return resolvePricing(JSON.parse(text), override);
  } catch {
    return undefined;
  }
};

const MTOK = 1_000_000;
const NONE: Counters = { input: 0, output: 0 };

const unpriced = () => ({
  low: 0,
  high: 0,
  priced: false,
  reasons: new Set<CostReason>(["unpriced model"]),
});

const tokens = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

const promptOf = (c: Counters) =>
  tokens(c.input) + tokens(c.cacheRead) + tokens(c.cacheWrite);

interface RateSet {
  rates: Rates;
  tiers?: Tier[];
  from?: string;
}

const tierRates = (set: RateSet, tier: number) =>
  (tier ? set.tiers?.[tier - 1]?.rates : undefined) ?? set.rates;

const tierAt = (set: RateSet, prompt: number) =>
  set.tiers?.filter((t) => t.abovePromptTokens < prompt).length ?? 0;

const activeRateSet = (entry: PriceEntry, onDate: string | null) => {
  const { rates, tiers } = entry;
  const base: RateSet = { rates, ...(tiers && { tiers }) };

  if (onDate === null || !entry.periods || entry.periods.length === 0) {
    return base;
  }

  let active: RateSet = base;

  for (const period of entry.periods) {
    if (period.from <= onDate) {
      active = period;
    } else {
      break;
    }
  }

  return active;
};

const rated = (
  c: Counters,
  r: Rates,
  reasoningApart: boolean
): { low: number; high: number; ttl: boolean } | undefined => {
  const read = tokens(c.cacheRead);
  const w5m = tokens(c.cacheWrite5m);
  const w1h = tokens(c.cacheWrite1h);

  const rest = Math.max(0, tokens(c.cacheWrite) - w5m - w1h);

  if (
    (read && r.cacheRead === undefined) ||
    (w5m && r.cacheWrite5m === undefined) ||
    (w1h && r.cacheWrite1h === undefined)
  ) {
    return undefined;
  }

  const base =
    tokens(c.input) * r.input +
    (tokens(c.output) + (reasoningApart ? tokens(c.reasoning) : 0)) * r.output +
    read * (r.cacheRead ?? 0) +
    w5m * (r.cacheWrite5m ?? 0) +
    w1h * (r.cacheWrite1h ?? 0);

  if (!rest) {
    return { low: base, high: base, ttl: false };
  }

  if (r.cacheWrite5m === undefined || r.cacheWrite1h === undefined) {
    return undefined;
  }

  const [low, high] = [
    Math.min(r.cacheWrite5m, r.cacheWrite1h),
    Math.max(r.cacheWrite5m, r.cacheWrite1h),
  ];

  return {
    low: base + rest * low,
    high: base + rest * high,
    ttl: low !== high,
  };
};

export const sumCost = (costs: readonly Cost[]) => ({
  low: costs.reduce((total, c) => total + c.low, 0),
  high: costs.reduce((total, c) => total + c.high, 0),
  priced: costs.some((c) => c.priced),
  reasons: new Set(costs.flatMap((c) => [...c.reasons])),
});

const usd = (v: number) => {
  if (v === 0) {
    return "$0";
  }

  if (v < 0.01) {
    return "$<0.01";
  }

  return `$${v.toFixed(2)}`;
};

/** `—` without a priced unit, else `~$value` or `~$low–$high`. */
export const formatCost = (cost: Cost | undefined) => {
  if (cost?.priced !== true) {
    return "—";
  }

  const [low, high] = [usd(cost.low), usd(cost.high)];

  return low === high ? `~${low}` : `~${low}–${high}`;
};
