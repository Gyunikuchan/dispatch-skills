import type { QuotaGeneration, QuotaKey, QuotaObservation, QuotaSnapshot } from '../toolkit/types.ts';

export const H = 3_600_000;
/** A stored row before validation. Policy imports no runtime module, so it owns this guard. */
interface StoredRow {
  [field: string]: StoredValue | undefined;
}
type StoredValue = string | number | boolean | null | Array<StoredValue> | StoredRow;
const isRecord = (value: unknown): value is StoredRow =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const matchesKey = (value: unknown, key: QuotaKey): boolean =>
  isRecord(value) && value['provider'] === key.provider && value['model'] === key.model && value['mode'] === key.mode;
const bounded = (value: unknown, limit: number): boolean => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length <= limit;
  } catch {
    return false;
  }
};
const generationRecord = (value: unknown, key: QuotaKey): value is QuotaGeneration =>
  isRecord(value) &&
  bounded(value, 8192) &&
  value['schemaVersion'] === 1 &&
  matchesKey(value['key'], key) &&
  typeof value['generation'] === 'string' &&
  /^[a-f0-9-]{36}$/.test(value['generation']);

/** Missing or unverifiable evidence leaves the configured cascade eligible. */
export function quotaSnapshot(
  keys: ReadonlyArray<QuotaKey>,
  generations: ReadonlyArray<unknown>,
  observations: ReadonlyArray<unknown>,
  now: number,
): QuotaSnapshot {
  return {
    schemaVersion: 1,
    policyVersion: 1,
    decidedAt: now,
    decisions: keys.map((key) => {
      const marker = generations.find((value): value is QuotaGeneration => generationRecord(value, key));
      const base = { key: { ...key }, generation: marker?.generation ?? null, skipped: false, reason: null };
      if (!marker || !Number.isSafeInteger(now) || now < 0) {
        return base;
      }
      const matches = observations.filter((value): value is QuotaObservation => {
        if (!isRecord(value) || !generationRecord(value, key)) {
          return false;
        }
        const row: StoredRow = value;
        const observedAt = row['observedAt'];
        return (
          bounded(row, 4096) &&
          row['generation'] === marker.generation &&
          typeof observedAt === 'number' &&
          Number.isSafeInteger(observedAt) &&
          observedAt >= 0 &&
          Number.isSafeInteger(observedAt + H) &&
          observedAt <= now &&
          Number.isSafeInteger(row['bucket']) &&
          row['bucket'] === Math.floor(observedAt / H) &&
          now - observedAt < H
        );
      });
      const observation = matches.reduce<QuotaObservation | undefined>(
        (first, row) => (!first || row.observedAt < first.observedAt ? row : first),
        undefined,
      );
      return observation
        ? {
            ...base,
            skipped: true,
            reason: 'quota-cooldown' as const,
            observedAt: observation.observedAt,
            expiresAt: observation.observedAt + H,
          }
        : base;
    }),
  };
}
