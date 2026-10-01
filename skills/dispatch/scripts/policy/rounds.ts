// Review rounds policy for every review kind (spec §7, ADR 0005).

import type { FindingId, Level, SlotId } from '../core/types.ts';
import { matchFinding, type MatchKey } from '../domain/report.ts';
import type { Severity } from '../domain/types.ts';
import { resolveLevel, type PhasePolicy } from './roster.ts';

const RANK: Readonly<Record<Severity, number>> = { CONSIDER: 1, SHOULD: 2, MUST: 3 };

// SECTION: Policy and threshold

export type RoundsPolicy = { enabled: false } | { enabled: true; cap: number; targets: number | 'all'; configured: boolean };

/** Cap and breadth at the run level; no phase policy → one target, one round; `0` rounds or targets disables. */
export function roundsPolicy(policy: PhasePolicy | undefined, level: Level, pinned = false): RoundsPolicy {
  if (!policy) return { enabled: true, cap: 1, targets: 1, configured: false };
  const cap = resolveLevel(policy.rounds, level) ?? 0;
  const targets = resolveLevel(policy.targets, level) ?? 0;
  if (cap <= 0 || (!pinned && targets === 0)) return { enabled: false };
  return { enabled: true, cap, targets, configured: true };
}

/** Minimum severity that triggers another round after round `round`: `SHOULD` below the cap, `MUST` at or after it. */
export function threshold(round: number, cap: number): Severity {
  return round >= cap ? 'MUST' : 'SHOULD';
}

export const atOrAbove = (severity: Severity, floor: Severity): boolean => RANK[severity] >= RANK[floor];

// SECTION: Next round

export type FindingState = 'fixed' | 'pending-rejection' | 'accepted' | 'rejected' | 'closed';
export type RoundFinding = { id: FindingId; severity: Severity; state: FindingState };
export type RoundScope = 'full' | 'delta' | 'disputes-only';
export type NextRound =
  | { run: false }
  | { run: true; round: number; scope: RoundScope; threshold: Severity; carry: readonly FindingId[] };

const unreachable = (value: never): never => { throw new Error(`unhandled round scope: ${String(value)}`); };

/**
 * Another round runs iff a finding at or above the threshold was fixed this round or is pending rejection.
 * Scope: nothing fixed → disputes only; next round ≤ cap → full target; beyond the cap → delta. `carry` lists the
 * pending rejections the round reviews (all of them, or only `MUST` ones on delta rounds).
 */
export function nextRound({ round, cap, findings }: { round: number; cap: number; findings: readonly RoundFinding[] }): NextRound {
  if (cap <= 0) return { run: false };
  const floor = threshold(round, cap);
  const trigger = findings.some((finding) => atOrAbove(finding.severity, floor) && (finding.state === 'fixed' || finding.state === 'pending-rejection'));
  if (!trigger) return { run: false };
  const scope: RoundScope = !findings.some((finding) => finding.state === 'fixed') ? 'disputes-only' : round + 1 <= cap ? 'full' : 'delta';
  const pending = findings.filter((finding) => finding.state === 'pending-rejection');
  return { run: true, round: round + 1, scope, threshold: floor, carry: carried(scope, pending) };
}

function carried(scope: RoundScope, pending: readonly RoundFinding[]): FindingId[] {
  switch (scope) {
    case 'full': case 'disputes-only': return pending.map((finding) => finding.id);
    case 'delta': return pending.filter((finding) => finding.severity === 'MUST').map((finding) => finding.id);
    default: return unreachable(scope);
  }
}

// SECTION: Disputes

export type Closure = { id: FindingId; closedBy: 'reviewer' | 'orchestrator' };

/** Below the threshold the orchestrator closes pending rejections; at or above it only the reviewer can. */
export function orchestratorClosures({ round, cap, findings }: { round: number; cap: number; findings: readonly RoundFinding[] }): Closure[] {
  const floor = threshold(round, cap);
  return findings
    .filter((finding) => finding.state === 'pending-rejection' && !atOrAbove(finding.severity, floor))
    .map((finding) => ({ id: finding.id, closedBy: 'orchestrator' }));
}

/** A carried pending rejection its reviewer did not re-raise is accepted by omission (closed by reviewer). */
export function acceptByOmission(carried: readonly FindingId[], reraised: readonly FindingId[], covered: readonly FindingId[]): Closure[] {
  return carried.filter((id) => covered.includes(id) && !reraised.includes(id)).map((id) => ({ id, closedBy: 'reviewer' }));
}

/** Each pending rejection rides to its source slot, or that slot's substitute; null when neither is on the roster. */
export function assignAffinity(
  pending: readonly { id: FindingId; source: SlotId }[],
  roster: readonly { slot: SlotId; substitutesFor?: SlotId | null }[],
): Record<FindingId, SlotId | null> {
  const out: Record<FindingId, SlotId | null> = {};
  for (const { id, source } of pending) {
    out[id] = roster.find((entry) => entry.slot === source)?.slot
      ?? roster.find((entry) => entry.substitutesFor === source)?.slot
      ?? null;
  }
  return out;
}

// SECTION: Convergence

export type HistoryEntry = MatchKey & { id: FindingId; status: 'applied' | 'pending-rejection'; reraises: number };
export type Convergence =
  | { halt: false; reraised: readonly FindingId[] }
  | { halt: true; escalation: { kind: 'regression' | 'deadlock'; ids: readonly FindingId[] } };

/**
 * Halts on a re-raised applied fix (regression) or a second re-raise of a pending rejection (deadlock), matched by
 * location + category with loose text similarity; otherwise lists pending rejections re-raised for the first time.
 */
export function convergence(findings: readonly MatchKey[], history: readonly HistoryEntry[], caseInsensitive = false): Convergence {
  const matched = history.filter((entry) => findings.some((finding) => matchFinding(finding, entry, caseInsensitive)));
  const regressed = matched.filter((entry) => entry.status === 'applied');
  if (regressed.length) return { halt: true, escalation: { kind: 'regression', ids: regressed.map((entry) => entry.id) } };
  const pending = matched.filter((entry) => entry.status === 'pending-rejection');
  const deadlocked = pending.filter((entry) => entry.reraises >= 1);
  if (deadlocked.length) return { halt: true, escalation: { kind: 'deadlock', ids: deadlocked.map((entry) => entry.id) } };
  return { halt: false, reraised: pending.map((entry) => entry.id) };
}

// SECTION: Exit

export type ExitSummary = {
  rounds: number;
  cap: number;
  capStatus: 'within-cap' | 'beyond-cap';
  fixedUnreviewed: readonly { id: FindingId; round: number }[];
  rejections: readonly FindingId[];
};

/** A fix applied in round r is reviewed only when a later round ran; the rest pass through the final gate flagged. */
export function exitSummary({ rounds, cap, fixes, rejections }: {
  rounds: number; cap: number; fixes: readonly { id: FindingId; round: number }[]; rejections: readonly FindingId[];
}): ExitSummary {
  return {
    rounds,
    cap,
    capStatus: rounds > cap ? 'beyond-cap' : 'within-cap',
    fixedUnreviewed: fixes.filter((fix) => fix.round >= rounds),
    rejections,
  };
}
