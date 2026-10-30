import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Manifest } from '../lib/session.ts';
import { parsePlan, selectTaskBrief } from './domain/plan.ts';
import type { ParsedPlan } from './domain/types.ts';
import { stableValue } from './domain/stable-value.ts';
import { foldLedger, latest } from './ledger.ts';
import { ToolError } from './output.ts';
export type Check = { criterion: string; commands: string[]; commandDigest: string };
export const commandDigest = (check: {criterion: string; commands: readonly string[]}) => 'sha256:' + crypto.createHash('sha256').update(stableValue(check)).digest('hex');
export function loadPlan(session: string, manifest: Manifest): ParsedPlan {
  const bind = latest(foldLedger(session), 'bind');
  if (!bind?.data['plan']) throw new ToolError(4,'lint-errors','No bound plan');
  const parsed = parsePlan(fs.readFileSync(path.resolve(manifest.repositoryRoot, bind.data['plan']), 'utf8'));
  if (!parsed.ok) throw new ToolError(4,'lint-errors',JSON.stringify(parsed.defects));
  return parsed.plan;
}
function selection(plan: ParsedPlan, id: string) {
  const brief = selectTaskBrief(plan,id);
  if (!brief) throw new ToolError(1,'invalid-input','Unknown task ' + id);
  return brief;
}
export function ownedPaths(plan: ParsedPlan, id: string): string[] { return selection(plan,id).changes.map(c=>c.path); }
function stripPositions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPositions);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='line' && !/Lines?$/.test(key)).map(([key,item])=>[key,stripPositions(item)]));
  return value;
}
export function taskSection(plan: ParsedPlan, id: string): string {
  const {task,changes,criteria} = selection(plan,id);
  return 'sha256:' + crypto.createHash('sha256').update(stableValue(stripPositions({task,changes,criteria}))).digest('hex');
}
export function checks(plan: ParsedPlan): Check[] {
  const listed = new Set(plan.criteria.flatMap(c=>c.verify.map(v=>v.command)));
  const rows = plan.criteria.map(c=>({criterion:c.id,commands:c.verify.map(v=>v.command)}));
  rows.push({criterion:'contract',commands:plan.verification.automated.filter(c=>!listed.has(c))});
  return rows.map(row=>({...row,commandDigest:commandDigest(row)}));
}
