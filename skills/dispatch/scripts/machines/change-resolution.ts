import crypto from 'node:crypto';
import type { ChangeDisposition, ChangeNotice, ChangeObservation, DriftResolution } from '../core/types.ts';
import { isRecord } from './types.ts';
import { stableValue } from '../domain/stable-value.ts';
import type { Context } from './implement.ts';
import { commandMappings, type EvidenceObligation } from './implement-types.ts';
import { criterionTasks } from './implement-tasks.ts';

export const bindingHash = (value: unknown): string => crypto.createHash('sha256').update(stableValue(value)).digest('hex');
export function evidenceAssessment(c: Context): Record<string, unknown> {
  const ids = c.plan?.criteria.map((row) => row.id) ?? Object.keys(c.evidence);
  return { evidenceIds: ids, evidenceDependencies: Object.fromEntries(ids.map((id) => [id, c.evidence[id]?.['dependencies'] ?? null])) };
}

// SECTION: Advisory observations

/** Records an ordinary change once per resulting revision; the suggestion never changes evidence or task state. */
export function observe(c: Context, notice: ChangeNotice): Context {
  const observations = c.observations ?? [];
  if (observations.some((row) => row.afterHash === notice.afterHash)) return c;
  const observation: ChangeObservation = { id: notice.id, afterHash: notice.afterHash, beforeHash: notice.beforeHash, phase: notice.phase, pendingId: notice.pendingId, rawDeltaRef: notice.rawDeltaRef,
    paths: notice.paths, pathCount: notice.pathCount, suggestedRelevance: notice.relevance, reason: notice.reason, suggestedEvidence: notice.affectedEvidence };
  return { ...c, observations: [...observations, observation] };
}

export function openObservations(c: Context): ChangeObservation[] {
  return (c.observations ?? []).filter((row) => !row.disposition);
}

/** Failed required checks stay unresolved: no rationale can retain evidence for a criterion whose check failed. */
function failedChecks(c: Context, id: string): string[] {
  const commands = c.plan ? commandMappings(c.plan).filter((row) => row.criteria.includes(id)).map((row) => row.command) : [];
  const failed = [...Object.values(c.records), ...(c.stalled?.rows ?? [])].filter((row) => commands.includes(row.command) && row.exit !== 0 && row.status !== 'known-red — unchanged');
  return [...new Set(failed.map((row) => row.command))];
}

/** Binds each disposition to an open observation at its exact revision and to current plan criteria. */
export function validateDispositions(c: Context, dispositions: readonly ChangeDisposition[]): string | null {
  const criteria = new Set(c.plan?.criteria.map((row) => row.id) ?? []);
  const seen = new Set<string>();
  for (const [index, row] of dispositions.entries()) {
    const at = `event.changeDispositions[${index}]`;
    const observation = (c.observations ?? []).find((item) => item.id === row.observationId);
    if (!observation || observation.afterHash !== row.afterHash) return `${at}: stale binding; name an open observation with its current afterHash.`;
    if (observation.disposition || seen.has(row.observationId)) return `${at}: observation ${row.observationId} is already disposed.`;
    seen.add(row.observationId);
    const retain = row.retain ?? [], refresh = row.refresh ?? [];
    const unknown = [...retain, ...refresh].filter((id) => !criteria.has(id));
    if (unknown.length) return `${at}: unknown criteria ${unknown.join(', ')}; dispositions cannot change scope.`;
    if (retain.some((id) => refresh.includes(id)) || new Set(retain).size !== retain.length || new Set(refresh).size !== refresh.length) return `${at}: name each criterion once, in retain or refresh.`;
    for (const id of retain) {
      const failed = failedChecks(c, id);
      if (failed.length) return `${at}.retain: ${id} has failed required checks (${failed.join(', ')}); reuse cannot pass a failed gate.`;
    }
  }
  return null;
}

/** Applies validated dispositions: retained evidence keeps provenance; refreshed criteria become pending obligations. */
export function applyDispositions(c0: Context, dispositions: readonly ChangeDisposition[]): Context {
  let c = c0;
  for (const row of dispositions) {
    c = { ...c, observations: (c.observations ?? []).map((item) => item.id === row.observationId ? { ...item, disposition: row } : item) };
    if (row.refresh?.length) c = refreshEvidence(c, row.refresh, row.observationId, row.rationale);
  }
  return c;
}

/**
 * Marks the named criteria pending and drops only their check records so verification re-runs them on the retained
 * candidate or integration; tasks, attempts, candidates and integrated commits are untouched, and prior results move to history.
 */
export function refreshEvidence(c: Context, ids: readonly string[], observationId: string, rationale: string): Context {
  const affected = new Set(ids);
  const epoch = c.mutationEpoch + 1, criterionMutation = { ...c.criterionMutation };
  for (const id of affected) criterionMutation[id] = epoch;
  const history = [...(c.evidenceHistory ?? []), ...Object.values(c.evidence).filter((row) => affected.has(row.id))];
  const evidence = Object.fromEntries(Object.entries(c.evidence).filter(([id]) => !affected.has(id)));
  const invalidCommands = new Set(c.plan ? commandMappings(c.plan).filter((row) => row.final || row.criteria.some((id) => affected.has(id))).map((row) => row.command) : Object.keys(c.records));
  const records = Object.fromEntries(Object.entries(c.records).filter(([command]) => !invalidCommands.has(command)));
  const obligations: Record<string, EvidenceObligation> = { ...(c.obligations ?? {}) };
  for (const id of affected) obligations[id] = { id, observationId, rationale, tasks: c.plan ? criterionTasks(c.plan, new Set([id])) : [], mutationEpoch: epoch };
  return { ...c, evidence, evidenceHistory: history, records, obligations, mutationEpoch: epoch, criterionMutation, finalGate: 'pending' };
}

/** Criteria a collision notice suggests; unknown relevance without named evidence suggests every criterion. */
export function suggestedCriteria(c: Context, notice: ChangeNotice): string[] {
  return notice.relevance === 'unknown' && !notice.affectedEvidence.length ? c.plan?.criteria.map((row) => row.id) ?? [] : [...notice.affectedEvidence];
}

/** Structural binding for a collision or review-change decision; the orchestrator, not path analysis, judges relevance. */
export function resolution(value: unknown, notice: ChangeNotice): DriftResolution | null {
  if (!isRecord(value) || value['by'] !== 'orchestrator' || value['noticeId'] !== notice.id || value['afterHash'] !== notice.afterHash
    || typeof value['rationale'] !== 'string' || !value['rationale'].trim() || !Array.isArray(value['evidenceIds'])
    || !value['evidenceIds'].every((id) => typeof id === 'string') || new Set(value['evidenceIds']).size !== value['evidenceIds'].length
    || notice.affectedEvidence.some((id) => !(value['evidenceIds'] as string[]).includes(id))
    || !['preserve', 'refresh', 'reconcile', 'escalate'].includes(String(value['action']))) return null;
  return value as DriftResolution;
}
