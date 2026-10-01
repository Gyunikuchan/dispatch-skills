// Deterministic, filesystem-safe effect ids: `<machine-path>.<kind>.<n>` (NTFS rejects `:`).

import type { EffectKind } from './types.ts';

export const EFFECT_ID_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

/** Run-global monotonic ordinals keyed by `<path>.<kind>`, held in machine state. */
export type EffectCounters = Readonly<Record<string, number>>;

export function nextEffectId(counters: EffectCounters, machinePath: string, kind: EffectKind): { id: string; counters: EffectCounters } {
  const key = `${machinePath}.${kind}`;
  const n = (counters[key] ?? 0) + 1;
  const id = `${key}.${n}`;
  if (!EFFECT_ID_PATTERN.test(id)) throw new Error(`effect id ${JSON.stringify(id)} does not match ${EFFECT_ID_PATTERN.source}`);
  return { id, counters: { ...counters, [key]: n } };
}
