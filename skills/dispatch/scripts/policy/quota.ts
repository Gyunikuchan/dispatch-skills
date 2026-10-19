import type { QuotaGeneration, QuotaKey, QuotaObservation, QuotaSnapshot } from '../core/types.ts';

export const H = 3_600_000;
const sameKey = (a: QuotaKey, b: QuotaKey): boolean => a.provider === b.provider && a.model === b.model && a.mode === b.mode;
const bounded = (value: unknown, limit: number): boolean => {
  try { return new TextEncoder().encode(JSON.stringify(value)).length <= limit; } catch { return false; }
};
const generationRecord = (value: unknown, key: QuotaKey): value is QuotaGeneration => {
  const row = value as Partial<QuotaGeneration> | null;
  return !!row && bounded(row, 8192) && row.schemaVersion === 1 && !!row.key && sameKey(row.key, key)
    && typeof row.generation === 'string' && /^[a-f0-9-]{36}$/.test(row.generation);
};

/** Missing or unverifiable evidence leaves the configured cascade eligible. */
export function quotaSnapshot(keys: readonly QuotaKey[], generations: readonly unknown[], observations: readonly unknown[], now: number): QuotaSnapshot {
  return { schemaVersion: 1, policyVersion: 1, decidedAt: now, decisions: keys.map((key) => {
    const marker = generations.find((value): value is QuotaGeneration => generationRecord(value, key));
    const base = { key: { ...key }, generation: marker?.generation ?? null, skipped: false, reason: null };
    if (!marker || !Number.isSafeInteger(now) || now < 0) return base;
    const matches = observations.filter((value): value is QuotaObservation => {
      const row = value as Partial<QuotaObservation> | null;
      return !!row && generationRecord(value, key) && bounded(row, 4096) && row.generation === marker.generation
        && Number.isSafeInteger(row.observedAt) && row.observedAt! >= 0 && Number.isSafeInteger(row.observedAt! + H) && row.observedAt! <= now
        && Number.isSafeInteger(row.bucket) && row.bucket === Math.floor(row.observedAt! / H)
        && now - row.observedAt! < H;
    });
    const observation = matches.reduce<QuotaObservation | undefined>((first, row) => !first || row.observedAt < first.observedAt ? row : first, undefined);
    return observation ? { ...base, skipped: true, reason: 'quota-cooldown' as const, observedAt: observation.observedAt, expiresAt: observation.observedAt + H } : base;
  }) };
}
