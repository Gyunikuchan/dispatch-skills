import crypto from 'node:crypto';
import type { ChangeNotice, DriftResolution } from '../core/types.ts';
import { isRecord } from './types.ts';
import { stableValue } from '../domain/stable-value.ts';
import type { Context } from './implement.ts';
import { commandMappings } from './implement-types.ts';
import { invalidateTaskEvidence, invalidatesIntegration } from './implement-tasks.ts';

export const bindingHash = (value: unknown): string => crypto.createHash('sha256').update(stableValue(value)).digest('hex');
export function evidenceAssessment(c: Context): Record<string, unknown> {
  const ids = c.plan?.criteria.map((row) => row.id) ?? Object.keys(c.evidence);
  return { evidenceIds: ids, evidenceDependencies: Object.fromEntries(ids.map((id) => [id, c.evidence[id]?.['dependencies'] ?? null])) };
}
export function refreshEvidence(c: Context, notice: ChangeNotice): Context {
  const affected = new Set(notice.relevance === 'unknown' && !notice.affectedEvidence.length ? c.plan?.criteria.map((row) => row.id) ?? [] : notice.affectedEvidence);
  const epoch = c.mutationEpoch + 1, criterionMutation = { ...c.criterionMutation };
  for (const id of affected) criterionMutation[id] = epoch;
  const evidence = Object.fromEntries(Object.entries(c.evidence).filter(([id]) => !affected.has(id)));
  const invalidCommands = new Set(c.plan ? commandMappings(c.plan).filter((row) => row.final || row.criteria.some((id) => affected.has(id))).map((row) => row.command) : Object.keys(c.records));
  const records = Object.fromEntries(Object.entries(c.records).filter(([command]) => !invalidCommands.has(command)));
  const tasks = c.plan ? invalidateTaskEvidence(c.tasks, c.plan, affected) : c.tasks;
  const integration = c.integration && invalidatesIntegration(c.tasks, tasks) ? { ...c.integration, rewind: true } : c.integration;
  return { ...c, evidence, records, tasks, integration, mutationEpoch: epoch, criterionMutation, finalGate: 'pending' };
}
export function resolution(value: unknown, notice: ChangeNotice): DriftResolution | null {
  if (!isRecord(value) || value['by'] !== 'orchestrator' || value['noticeId'] !== notice.id || value['afterHash'] !== notice.afterHash
    || typeof value['rationale'] !== 'string' || !value['rationale'].trim() || !Array.isArray(value['evidenceIds'])
    || !value['evidenceIds'].every((id) => typeof id === 'string') || new Set(value['evidenceIds']).size !== value['evidenceIds'].length
    || notice.affectedEvidence.some((id) => !(value['evidenceIds'] as string[]).includes(id))
    || !['preserve', 'refresh', 'reconcile', 'escalate'].includes(String(value['action']))) return null;
  if (value['action'] === 'preserve' && notice.relevance !== 'irrelevant') return null;
  return value as DriftResolution;
}
