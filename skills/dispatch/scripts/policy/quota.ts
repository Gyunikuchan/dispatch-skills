import type {
  EmptyOutputRecord,
  QuotaGeneration,
  QuotaKey,
  QuotaObservation,
} from "../toolkit/types.ts";

export const H = 3_600_000;

/** A stored row before validation. Policy imports no runtime module, so it owns this guard. */
interface StoredRow {
  [field: string]: StoredValue | undefined;
}

type StoredValue = string | number | boolean | null | StoredValue[] | StoredRow;

const isRecord = (value: unknown): value is StoredRow =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const matchesKey = (value: unknown, key: QuotaKey) =>
  isRecord(value) &&
  value["provider"] === key.provider &&
  value["model"] === key.model &&
  value["mode"] === key.mode;

const bounded = (value: unknown, limit: number) => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length <= limit;
  } catch {
    return false;
  }
};

const generationRecord = (
  value: unknown,
  key: QuotaKey
): value is QuotaGeneration =>
  isRecord(value) &&
  bounded(value, 8192) &&
  value["schemaVersion"] === 1 &&
  matchesKey(value["key"], key) &&
  typeof value["generation"] === "string" &&
  /^[a-f0-9-]{36}$/u.test(value["generation"]);

/** Missing or unverifiable evidence leaves the configured cascade eligible. */
export const quotaSnapshot = (
  keys: readonly QuotaKey[],
  generations: readonly unknown[],
  observations: readonly unknown[],
  now: number
) => ({
  schemaVersion: 1,
  policyVersion: 1,
  decidedAt: now,
  decisions: keys.map((key) => {
    const marker = generations.find((value): value is QuotaGeneration =>
      generationRecord(value, key)
    );

    const base = {
      key: { ...key },
      generation: marker?.generation ?? null,
      skipped: false,
      reason: null,
    };

    if (!marker || !Number.isSafeInteger(now) || now < 0) {
      return base;
    }

    const matches = observations.filter((value): value is QuotaObservation => {
      if (!isRecord(value) || !generationRecord(value, key)) {
        return false;
      }

      const row: StoredRow = value;
      const { observedAt } = row;

      return (
        bounded(row, 4096) &&
        row["generation"] === marker.generation &&
        typeof observedAt === "number" &&
        Number.isSafeInteger(observedAt) &&
        observedAt >= 0 &&
        Number.isSafeInteger(observedAt + H) &&
        observedAt <= now &&
        Number.isSafeInteger(row["bucket"]) &&
        row["bucket"] === Math.floor(observedAt / H) &&
        now - observedAt < H
      );
    });

    let observation: QuotaObservation | undefined;

    for (const row of matches) {
      if (
        observation === undefined ||
        row.observedAt < observation.observedAt
      ) {
        observation = row;
      }
    }

    return observation
      ? {
          ...base,
          skipped: true,
          reason: "quota-cooldown" as const,
          observedAt: observation.observedAt,
          expiresAt: observation.observedAt + H,
        }
      : base;
  }),
});

// SECTION: Empty-output breaker

const EMPTY_OUTPUT_TRIP_STREAK = 2;

/** Only failures strictly after the latest reset count; ordering uses seq, never observedAt. */
export const emptyOutputBreakerOpen = (snapshot: {
  readonly records: readonly EmptyOutputRecord[];
}) => {
  let streak = 0;

  for (const record of snapshot.records.toSorted((a, b) => a.seq - b.seq)) {
    streak = record.kind === "empty-output-reset" ? 0 : streak + 1;
  }

  return streak >= EMPTY_OUTPUT_TRIP_STREAK;
};
