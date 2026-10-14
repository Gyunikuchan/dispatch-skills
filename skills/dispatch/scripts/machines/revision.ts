// Live plan revisions: an `AMEND` delta (exact text edits on the governed plan text) and a `REPLACE_PLAN` file both
// normalize to one revised plan, which the reconciliation operation binds to current work. Pure: the caller journals
// the input, so replay recomputes the result.

import crypto from 'node:crypto';
import type { PlanEdit } from '../core/types.ts';
import { parsePlan } from '../domain/plan.ts';
import type { ParsedPlan } from '../domain/types.ts';

/** A revised plan ready for reconciliation; semantic approval comes from the orchestrator's attestation, never from this text. */
export type RevisedPlan = { ok: true; plan: ParsedPlan; hash: string; text: string } | { ok: false; error: string };
export type AmendedPlan = RevisedPlan;

function occurrences(text: string, needle: string): number {
  let count = 0;
  for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + needle.length)) count++;
  return count;
}

function knownTargets(plan: ParsedPlan): Set<string> {
  return new Set([
    ...plan.tasks.map((task) => task.id), ...plan.criteria.flatMap((row) => [row.id, ...row.verify.map((item) => item.command)]),
    ...plan.verification.automated, ...plan.finalCommands, ...plan.changes.map((change) => change.path),
  ]);
}

/**
 * Applies `delta` to `before.governedText`: `modify` replaces the single occurrence of `current` with `proposed`;
 * `remove` deletes the single occurrence of `current`; `add` inserts `proposed` right after the single anchor `current`.
 * Every `target` must name a task, criterion, command, or change path of the plan before or after the edit.
 */
export function amendPlan(before: ParsedPlan, delta: readonly PlanEdit[]): AmendedPlan {
  let text = before.governedText;
  for (const [index, edit] of delta.entries()) {
    const at = `delta[${index}]`;
    if (typeof edit.current !== 'string' || !edit.current) return { ok: false, error: `${at}.current: every edit names the exact current text${edit.kind === 'add' ? ' it inserts after' : ''}.` };
    if (edit.kind !== 'remove' && (typeof edit.proposed !== 'string' || !edit.proposed)) return { ok: false, error: `${at}.proposed: ${edit.kind} needs the proposed text.` };
    const count = occurrences(text, edit.current);
    if (count !== 1) return { ok: false, error: `${at}.current must occur exactly once in the plan; found ${count}.` };
    const start = text.indexOf(edit.current), end = start + edit.current.length;
    text = edit.kind === 'modify' ? `${text.slice(0, start)}${edit.proposed}${text.slice(end)}`
      : edit.kind === 'remove' ? `${text.slice(0, start)}${text.slice(end)}`
        : `${text.slice(0, end)}${edit.proposed}${text.slice(end)}`;
  }
  const parsed = parsePlan(text);
  if (!parsed.ok) return { ok: false, error: `Amended plan fails lint: ${parsed.defects.map((defect) => `${defect.code}: ${defect.message}`).join('; ')}` };
  const after = parsed.plan;
  const known = new Set([...knownTargets(before), ...knownTargets(after)]);
  const unknown = delta.filter((edit) => !known.has(edit.target)).map((edit) => edit.target);
  if (unknown.length) return { ok: false, error: `delta target names no task, criterion, command, or path: ${[...new Set(unknown)].join(', ')}.` };
  return { ok: true, plan: after, hash: `sha256:${crypto.createHash('sha256').update(after.governedText).digest('hex')}`, text: after.governedText };
}

/** Normalizes a parsed replacement file; parser defects (malformed sections, cycles, unknown prerequisites) reject it. */
export function replacementPlan(parsed: { hash: string; plan: ParsedPlan | null; defects: readonly { code?: unknown; message?: unknown }[] }): RevisedPlan {
  if (parsed.defects.length) return { ok: false, error: `Replacement plan fails lint: ${parsed.defects.map((defect) => `${String(defect.code ?? 'defect')}: ${String(defect.message ?? '')}`).join('; ')}` };
  if (!parsed.plan || !/^sha256:[a-f0-9]{64}$/.test(parsed.hash)) return { ok: false, error: 'Replacement plan parser returned an invalid payload or governed hash.' };
  return { ok: true, plan: parsed.plan, hash: parsed.hash, text: parsed.plan.governedText };
}
