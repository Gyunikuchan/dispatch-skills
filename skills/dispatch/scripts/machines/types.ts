// Concrete machine payloads that narrow the core/types.ts placeholders (`ReviewSpec`, `Ruling`, `ScopeRequest`, …)
// at the boundary, plus the small shared helpers every machine needs. Machines may import only policy/, domain/, and
// types from core/types.ts, so the effect-id rule and `never` guard are restated here (core/effect-id.ts pattern).

import type { DecideKind, DoneOutcome, Effect, EffectKind, Event, FindingId, SlotId } from '../core/types.ts';
import type { Finding, ReviewKind, RosterSlot, Severity } from '../domain/types.ts';
import type { ExitSummary, RoundScope } from '../policy/rounds.ts';

// SECTION: Shared helpers

export type Counters = Readonly<Record<string, number>>;

/** Mirrors core/effect-id.ts `nextEffectId`: `<machine-path>.<kind>.<n>`, run-global ordinals held in state. */
export function nextId(counters: Counters, machinePath: string, kind: EffectKind): { id: string; counters: Counters } {
  const key = `${machinePath}.${kind}`;
  const n = (counters[key] ?? 0) + 1;
  const id = `${key}.${n}`;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(id)) throw new Error(`effect id ${JSON.stringify(id)} is not filesystem-safe`);
  return { id, counters: { ...counters, [key]: n } };
}

export function never(value: never, what: string): never {
  throw new Error(`unhandled ${what}: ${JSON.stringify(value)}`);
}

export type Step<S> = { state: S; effects: readonly Effect[] };
export const stay = <S>(state: S): Step<S> => ({ state, effects: [] });

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Result events carry the effect id they answer; a stale id is ignored by every machine. */
export const answers = (event: Event, effectId: string | null): boolean => 'effectId' in event && event.effectId === effectId;

// SECTION: Specs

export type ReviewMode = 'fix' | 'report';
export type CriterionOutcome = 'pass' | 'waived';
export type CriterionProvenance = { outcome: CriterionOutcome; waiver?: { by: 'user'; quote: string }; redProvenance: 'observed' | 'waived' | 'not-required' };

/** Spec §5.5 input; `breadth` is the roster target count and `roster` the resolved targets then reserves. */
export type ReviewSpec = {
  kind: ReviewKind; mode: ReviewMode; target: string; cap: number; breadth: number | 'all'; context: string | null;
  roster: readonly RosterSlot[]; timeoutMs: number; sessionDir?: string;
  governing?: { planPath: string; walkthroughPath: string; designPath?: string; criteria: readonly { id: string; changes: readonly string[]; verify: readonly string[] }[] };
};

/** `ask` is not a `ReviewKind`; `prepare-review` builds its bounded prompt inline. */
export type AskSpec = { kind: 'ask'; target: string; breadth: number | 'all'; context: string; roster: readonly RosterSlot[]; timeoutMs: number };

export type CarriedRejection = { id: FindingId; slot: SlotId | null; locus: string; defect: string; reason: string };
export type ScopeRequest = { scope: RoundScope; carried: readonly CarriedRejection[]; sinceHash?: string; priorManifest?: string };

// SECTION: Rulings and findings

export const RULING_KINDS = ['accept', 'reject', 'downgrade', 'needs-user'] as const;
export type RulingKind = (typeof RULING_KINDS)[number];
export type Ruling = { ruling: RulingKind; severity?: Severity; reason?: string; fix?: NonNullable<Finding['fix']> };

export function asRuling(value: unknown): Ruling | null {
  if (!isRecord(value) || !RULING_KINDS.includes(value['ruling'] as RulingKind)) return null;
  const out: Ruling = { ruling: value['ruling'] as RulingKind };
  const severity = value['severity'];
  if (severity === 'MUST' || severity === 'SHOULD' || severity === 'CONSIDER') out.severity = severity;
  if (typeof value['reason'] === 'string') out.reason = value['reason'];
  // NOTE: the host ruling owns fix scope and verification (reports carry none).
  const fix = value['fix'];
  if (isRecord(fix)) {
    const list = (key: string) => (Array.isArray(fix[key]) ? (fix[key] as unknown[]).filter((entry): entry is string => typeof entry === 'string') : []);
    out.fix = { paths: list('affectedPaths'), dependencies: list('dependsOn'), verification: list('verification') };
  }
  return out;
}

export type FindingStatus =
  | 'open' | 'accepted' | 'downgraded' | 'fixed' | 'rejected' | 'pending-rejection' | 'needs-user'
  | 'closed-by-reviewer' | 'closed-by-orchestrator' | 'superseded' | 'duplicate';

export type ReviewFinding = Finding & { round: number; status: FindingStatus; resolution?: string };

export const isAccepted = (finding: ReviewFinding): boolean => finding.status === 'accepted' || finding.status === 'downgraded';

export function asFinding(value: unknown): Finding | null {
  if (!isRecord(value)) return null;
  const { id, severity, category, locus, defect, requiredChange, sources, scope } = value;
  if (!isString(id) || (severity !== 'MUST' && severity !== 'SHOULD' && severity !== 'CONSIDER') || typeof category !== 'string'
    || typeof locus !== 'string' || typeof defect !== 'string' || typeof requiredChange !== 'string' || !Array.isArray(sources)) return null;
  const out: Finding = {
    id, severity, category, locus, defect, requiredChange, sources: sources.filter((entry): entry is string => typeof entry === 'string'),
    scope: scope === 'adjacent' ? 'adjacent' : 'in',
  };
  const fix = value['fix'];
  if (isRecord(fix)) {
    const list = (key: string) => (Array.isArray(fix[key]) ? (fix[key] as unknown[]).filter((entry): entry is string => typeof entry === 'string') : []);
    out.fix = { paths: list('paths'), dependencies: list('dependencies'), verification: list('verification') };
  }
  if (isString(value['dupOf'])) out.dupOf = value['dupOf'];
  return out;
}

// SECTION: Native slots

/** Structural view of providers/native.ts `NativeDescriptor` (machines may not import providers/). */
export type NativeSlot = Readonly<Record<string, unknown>> & { sourceKey: string; substitutesFor: string | null; outputPath: string };

export function asNativeSlot(value: unknown): NativeSlot | null {
  if (!isRecord(value) || !isString(value['sourceKey']) || !isString(value['outputPath'])) return null;
  const substitutes = value['substitutesFor'];
  return { ...value, sourceKey: value['sourceKey'], outputPath: value['outputPath'], substitutesFor: isString(substitutes) ? substitutes : null };
}

/**
 * Checks a host's echoed launch against the configured model and effort; host runtimes silently fall back to
 * their default model when the launch omits it, so any mismatch must be disclosed as a `substitution` reason.
 */
export function launchMismatch(expected: { model?: unknown; effort?: unknown }, actual: { model?: unknown; effort?: unknown; substitution?: unknown }): string | null {
  const missing = [
    !(isString(actual.model) && actual.model.trim()) ? 'model' : null,
    isString(expected.effort) && expected.effort && !(isString(actual.effort) && actual.effort.trim()) ? 'effort' : null,
  ].filter((item): item is string => item !== null);
  if (missing.length) return `report the actually launched ${missing.join(' and ')}; a substitution reason explains differing values but never replaces them`;
  const drift = launchDrift(expected, actual);
  if (!drift.length) return null;
  return isString(actual.substitution) && actual.substitution.trim() ? null : `launched ${drift.join(', ')}; relaunch with the configured values or state a substitution reason`;
}

/** Lists each launched value that differs from its configured one, e.g. `model a (configured b)`. */
export function launchDrift(expected: { model?: unknown; effort?: unknown }, actual: { model?: unknown; effort?: unknown }): string[] {
  return [
    isString(expected.model) && expected.model && actual.model !== expected.model ? `model ${String(actual.model ?? 'unreported')} (configured ${expected.model})` : null,
    isString(expected.effort) && expected.effort && actual.effort !== expected.effort ? `effort ${String(actual.effort ?? 'unreported')} (configured ${expected.effort})` : null,
  ].filter((item): item is string => item !== null);
}

/** Host capture for one native slot, matched to its descriptor by `sourceKey ?? slot`. */
export type NativeCapture = { sourceKey?: string; slot: string; outputPath: string; mapping?: unknown };

export function asNativeCapture(value: unknown): NativeCapture | null {
  if (!isRecord(value) || !isString(value['slot']) || !isString(value['outputPath'])) return null;
  const out: NativeCapture = { slot: value['slot'], outputPath: value['outputPath'] };
  if (isString(value['sourceKey'])) out.sourceKey = value['sourceKey'];
  if (value['mapping'] !== undefined) out.mapping = value['mapping'];
  return out;
}

// SECTION: Decisions and done

export type Decide = { kind: DecideKind; question: string; options: readonly string[]; items?: readonly unknown[] };

export type Claim = { text: string; source: SlotId };
export type FailedSlot = { slot: SlotId; cls: string };

export type DoneData = {
  outcome: DoneOutcome;
  summary: string;
  claims?: readonly Claim[];
  completion?: Readonly<Record<string, unknown>>;
};

export type ReviewCompletion = { exitSummary: ExitSummary; followUps: readonly string[] };
