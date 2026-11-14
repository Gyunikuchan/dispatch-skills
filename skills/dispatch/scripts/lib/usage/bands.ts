import { addCounters, tokenTotal, usageKey, type Counters, type UsageRow } from './rows.ts';

export const BAND_EDGES = [100_000, 200_000, 272_000] as const;
export const BANDS = ['le100k', 'le200k', 'le272k', 'gt272k'] as const;
export type Band = (typeof BANDS)[number];
export type Bands = Partial<Record<Band, Counters>>;
export type BandedCounters = Counters & { bands?: Bands };

export const MAX_MODEL_KEYS = 32;
export const OTHER_KEY = 'other';

/** Prompt-size band for one request; boundary values take the lower band. */
export function bandOf(row: Counters): Band {
  const prompt = row.input + (row.cacheRead ?? 0) + (row.cacheWrite ?? 0);
  if (prompt <= BAND_EDGES[0]) return 'le100k';
  if (prompt <= BAND_EDGES[1]) return 'le200k';
  if (prompt <= BAND_EDGES[2]) return 'le272k';
  return 'gt272k';
}

/** Folds per-request rows into per-`model#effort` banded counters; `reasoningInOutput` is set only when every row agrees. */
export function foldRows(rows: readonly UsageRow[]): { total: Counters; models: Record<string, BandedCounters>; reasoningInOutput?: boolean } {
  const total: Counters = { input: 0, output: 0 };
  const models: Record<string, BandedCounters> = {};
  for (const row of rows) {
    addCounters(total, row);
    const key = usageKey(row.model, row.effort);
    const entry = models[key] ??= { input: 0, output: 0 };
    addCounters(entry, row);
    const band = bandOf(row);
    const bands = entry.bands ??= {};
    const bandEntry = bands[band] ??= { input: 0, output: 0 };
    addCounters(bandEntry, row);
  }
  const reasoningInOutput = rows.length > 0 && rows.every((r) => r.reasoningInOutput)
    ? true
    : rows.length > 0 && rows.every((r) => !r.reasoningInOutput)
      ? false
      : undefined;
  return { total, models, ...(reasoningInOutput === undefined ? {} : { reasoningInOutput }) };
}

/** Keeps at most `MAX_MODEL_KEYS` largest keys by `tokenTotal` (ties by ascending key) and merges the rest into `other`. */
export function boundModels<T extends Counters>(models: Record<string, T>): Record<string, T | Counters> {
  const existingOther = models[OTHER_KEY];
  const entries = Object.entries(models).filter(([key]) => key !== OTHER_KEY);
  if (entries.length <= MAX_MODEL_KEYS && !existingOther) return { ...models };

  const overflowCount = Math.max(0, entries.length - MAX_MODEL_KEYS);
  const dropped = new Set<string>();
  if (overflowCount > 0) {
    const ranked = [...entries].sort((a, b) =>
      tokenTotal(a[1]) - tokenTotal(b[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (let i = 0; i < overflowCount; i++) dropped.add(ranked[i]![0]);
  }

  const out: Record<string, T | Counters> = {};
  for (const [key, value] of entries) {
    if (!dropped.has(key)) out[key] = value;
  }
  if (overflowCount > 0 || existingOther) {
    const other: Counters = { input: 0, output: 0 };
    if (existingOther) addCounters(other, existingOther);
    for (const [key, value] of entries) {
      if (dropped.has(key)) addCounters(other, value);
    }
    out[OTHER_KEY] = other;
  }
  return out;
}
