// Delegate failure cascade (spec §6.4, ADR 0001): model array inside one voice, provider-declared mode cascade,
// sandbox-unsupported skip, reserves once per wave, native fallback on the orchestrator platform only.

import type { FailureClass, SlotId } from '../core/types.ts';

export type Voice = {
  slot: SlotId;
  platform: string;
  models: readonly (string | null)[];
  modes: readonly string[];
  /** Classes the provider declares mode-cascadable (agy: quota/context-overflow/…; copilot: quota). */
  modeCascadeOn: readonly FailureClass[];
};
export type Position = { model: number; mode: number };
export type WaveContext = { orchestratorPlatform: string | null; reserveAvailable: boolean };

export type CascadeDecision =
  | { kind: 'next-model'; position: Position }
  | { kind: 'next-mode'; position: Position }
  | { kind: 'reserve' }
  | { kind: 'native-fallback' }
  | { kind: 'terminal'; scope: 'slot' | 'run'; reason: string };

const unreachable = (value: never): never => { throw new Error(`unhandled failure class: ${String(value)}`); };

/** How a class moves inside the voice before exhaustion. */
export function failureDisposition(cls: FailureClass): 'cascade' | 'skip-voice' | 'terminal-run' {
  switch (cls) {
    case 'quota': case 'context-overflow': case 'auth': case 'model-not-found': case 'cli-outdated': case 'model-not-loaded':
    case 'not-found': case 'timeout': case 'buffer': case 'empty-output': case 'refusal': case 'truncated':
      return 'cascade';
    case 'sandbox-unsupported':
      return 'skip-voice';
    case 'integrity': case 'config':
      return 'terminal-run';
    default:
      return unreachable(cls);
  }
}

/** The next step after `cls` failed at `position`. */
export function next(cls: FailureClass, position: Position, voice: Voice, wave: WaveContext = { orchestratorPlatform: null, reserveAvailable: false }): CascadeDecision {
  const disposition = failureDisposition(cls);
  if (disposition === 'terminal-run') return { kind: 'terminal', scope: 'run', reason: `${cls} is terminal for the run` };
  if (disposition === 'cascade') {
    // Every failure, auth included, tries the next alias of the voice (ADR 0001).
    if (position.model + 1 < voice.models.length) return { kind: 'next-model', position: { model: position.model + 1, mode: position.mode } };
    if (voice.modeCascadeOn.includes(cls) && position.mode + 1 < voice.modes.length) {
      return { kind: 'next-mode', position: { model: 0, mode: position.mode + 1 } };
    }
  }
  // The voice is exhausted, or the sandbox gap makes its other models and modes pointless (D28).
  if (wave.reserveAvailable) return { kind: 'reserve' };
  if (wave.orchestratorPlatform !== null && voice.platform === wave.orchestratorPlatform) return { kind: 'native-fallback' };
  return { kind: 'terminal', scope: 'slot', reason: `${voice.slot} failed: ${cls}` };
}

// SECTION: Reserves

export type ReservePool = { order: readonly SlotId[]; used: readonly SlotId[]; records: readonly string[] };

export const reservePool = (order: readonly SlotId[]): ReservePool => ({ order, used: [], records: [] });
export const hasReserve = (pool: ReservePool): boolean => pool.order.some((slot) => !pool.used.includes(slot));

/** Consumes the next unused ordered reserve (each at most once per wave) and records `<failed> → <reserve>: <reason>`. */
export function takeReserve(pool: ReservePool, failed: SlotId, reason: string): { pool: ReservePool; reserve: SlotId | null } {
  const reserve = pool.order.find((slot) => !pool.used.includes(slot));
  if (reserve === undefined) return { pool, reserve: null };
  return { reserve, pool: { order: pool.order, used: [...pool.used, reserve], records: [...pool.records, `${failed} → ${reserve}: ${reason}`] } };
}
