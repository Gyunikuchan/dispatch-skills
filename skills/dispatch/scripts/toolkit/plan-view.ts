import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Manifest } from '../lib/session.ts';
import { textValue } from './narrow.ts';
import { parsePlan, selectTaskBrief } from './domain/plan.ts';
import type { ParsedPlan } from './domain/types.ts';
import { stableValue } from './domain/stable-value.ts';
import { foldLedger, latest } from './ledger.ts';
import { ToolError } from './output.ts';
type CheckEvidenceClass = ParsedPlan['criteria'][number]['evidence'] | 'contract';
export type Check = {
  criterion: string;
  commands: Array<string>;
  commandDigest: string;
  evidenceClass: CheckEvidenceClass;
};
export const commandDigest = (check: { criterion: string; commands: ReadonlyArray<string> }) =>
  'sha256:' +
  crypto
    .createHash('sha256')
    .update(stableValue({ criterion: check.criterion, commands: check.commands }))
    .digest('hex');
export function loadPlan(session: string, manifest: Manifest): ParsedPlan {
  const bind = latest(foldLedger(session), 'bind');
  if (!bind?.data['plan']) {
    throw new ToolError(4, 'lint-errors', 'No bound plan');
  }
  const planPath = path.resolve(manifest.repositoryRoot, textValue(bind.data['plan']));
  const parsed = parsePlan(fs.readFileSync(planPath, 'utf8'));
  if (!parsed.ok) {
    throw new ToolError(4, 'lint-errors', JSON.stringify(parsed.defects));
  }
  return parsed.plan;
}
function selection(plan: ParsedPlan, id: string) {
  const brief = selectTaskBrief(plan, id);
  if (!brief) {
    const valid = plan.tasks.map((t) => t.id).join(', ');
    throw new ToolError(1, 'invalid-input', `Unknown task ${id}${valid ? `; valid: ${valid}` : ''}`);
  }
  return brief;
}
export function taskCriteria(plan: ParsedPlan, id: string): Array<string> {
  return [...selection(plan, id).task.criteria];
}
export function ownedPaths(plan: ParsedPlan, id: string): Array<string> {
  return selection(plan, id).changes.map((c) => c.path);
}
type PlanValue = string | number | boolean | null | undefined | Array<PlanValue> | { [key: string]: PlanValue };
// Plan data is JSON-shaped, so a leaf outside the JSON types is an absent field.
function stripPositions(value: unknown): PlanValue {
  if (Array.isArray(value)) {
    return value.map(stripPositions);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'line' && !/Lines?$/.test(key))
        .map(([key, item]) => [key, stripPositions(item)]),
    );
  }
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : undefined;
}
export function taskSection(plan: ParsedPlan, id: string): string {
  const { task, changes, criteria } = selection(plan, id);
  return (
    'sha256:' +
    crypto
      .createHash('sha256')
      .update(stableValue(stripPositions({ task, changes, criteria })))
      .digest('hex')
  );
}
export function checks(plan: ParsedPlan): Array<Check> {
  const listed = new Set(plan.criteria.flatMap((c) => c.verify.map((v) => v.command)));
  const rows: Array<Omit<Check, 'commandDigest'>> = plan.criteria.map((c) => ({
    criterion: c.id,
    commands: c.verify.map((v) => v.command),
    evidenceClass: c.evidence,
  }));
  rows.push({
    criterion: 'contract',
    commands: plan.verification.automated.filter((c) => !listed.has(c)),
    evidenceClass: 'contract',
  });
  return rows.map((row) => ({ ...row, commandDigest: commandDigest(row) }));
}
