import { addCounters, tokenTotal, usageKey } from "./rows.ts";
import type { BandedCounters, Counters, ModelMap, UsageRow } from "./rows.ts";

const compareKeys = (a: string, b: string) => {
  if (a < b) {
    return -1;
  }

  if (a > b) {
    return 1;
  }

  return 0;
};

export const BAND_EDGES = [100_000, 200_000, 272_000] as const;
export const MAX_MODEL_KEYS = 32;
export const OTHER_KEY = "other";

/** Prompt-size band for one request; boundary values take the lower band. */
export const bandOf = (row: Counters) => {
  const prompt = row.input + (row.cacheRead ?? 0) + (row.cacheWrite ?? 0);

  if (prompt <= BAND_EDGES[0]) {
    return "le100k";
  }

  if (prompt <= BAND_EDGES[1]) {
    return "le200k";
  }

  if (prompt <= BAND_EDGES[2]) {
    return "le272k";
  }

  return "gt272k";
};

/** Folds per-request rows into per-`model#effort` banded counters; `reasoningInOutput` is set only when every row agrees. */
export const foldRows = (rows: readonly UsageRow[]) => {
  const total: Counters = { input: 0, output: 0 };
  const models: Record<string, BandedCounters> = {};

  for (const row of rows) {
    addCounters(total, row);
    const key = usageKey(row.model, row.effort);
    const entry = models[key] ?? { input: 0, output: 0 };
    models[key] = entry;
    addCounters(entry, row);
    const band = bandOf(row);
    const bands = entry.bands ?? {};
    entry.bands = bands;
    const bandEntry = bands[band] ?? { input: 0, output: 0 };
    bands[band] = bandEntry;
    addCounters(bandEntry, row);
  }

  let reasoningInOutput: boolean | undefined;

  if (rows.length > 0) {
    if (rows.every((r) => r.reasoningInOutput)) {
      reasoningInOutput = true;
    } else if (rows.every((r) => !r.reasoningInOutput)) {
      reasoningInOutput = false;
    }
  }

  return {
    total,
    models,
    ...(!(reasoningInOutput === undefined) && { reasoningInOutput }),
  };
};

/** Keeps at most `MAX_MODEL_KEYS` largest keys by `tokenTotal` (ties by ascending key) and merges the rest into `other`. */
export const boundModels = <T extends Counters>(models: Record<string, T>) => {
  const existingOther = models[OTHER_KEY];
  const entries = Object.entries(models).filter(([key]) => key !== OTHER_KEY);

  if (entries.length <= MAX_MODEL_KEYS && !existingOther) {
    return { ...models };
  }

  const overflowCount = Math.max(0, entries.length - MAX_MODEL_KEYS);
  const dropped = new Set<string>();

  if (overflowCount > 0) {
    const ranked = [...entries].toSorted(
      (a, b) => tokenTotal(a[1]) - tokenTotal(b[1]) || compareKeys(a[0], b[0])
    );

    for (const [key] of ranked.slice(0, overflowCount)) {
      dropped.add(key);
    }
  }

  const out: ModelMap<T | Counters> = {};

  for (const [key, value] of entries) {
    if (!dropped.has(key)) {
      out[key] = value;
    }
  }

  if (overflowCount > 0 || existingOther) {
    const other: Counters = { input: 0, output: 0 };

    if (existingOther) {
      addCounters(other, existingOther);
    }

    for (const [key, value] of entries) {
      if (dropped.has(key)) {
        addCounters(other, value);
      }
    }

    out[OTHER_KEY] = other;
  }

  return out;
};
