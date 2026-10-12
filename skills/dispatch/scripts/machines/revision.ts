// Live plan amendments: an `AMEND` delta is a list of exact text edits on the governed plan text, applied in order,
// then parsed and linted like any authored plan. Pure: the caller journals the delta, so replay recomputes the result.

import crypto from 'node:crypto';
import type { PlanEdit } from '../core/types.ts';
import { parsePlan } from '../domain/plan.ts';
import type { ParsedPlan } from '../domain/types.ts';

export type AmendedPlan = { ok: true; plan: ParsedPlan; hash: string; text: string; gates: string[] } | { ok: false; error: string };

/** Manifests whose new or changed entry adds an external dependency or runtime prerequisite; such a delta needs a user quote. */
const MANIFESTS = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'requirements.txt', 'pyproject.toml', 'poetry.lock', 'Pipfile', 'Pipfile.lock', 'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum', 'Gemfile', 'Gemfile.lock', 'composer.json', 'composer.lock', 'pom.xml', 'build.gradle', 'build.gradle.kts']);

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
 * `gates` lists the reasons the delta needs a user quote (intent change or a new or changed dependency manifest).
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
  const gates: string[] = [];
  if (after.title !== before.title || after.box['TL;DR'] !== before.box['TL;DR'] || JSON.stringify(after.keyDecisions) !== JSON.stringify(before.keyDecisions)) gates.push('intent change (title, TL;DR, or Key Decisions)');
  // NOTE: a changed note on an already planned manifest can add a dependency too, so any changed manifest entry gates.
  const work = (change: ParsedPlan['changes'][number]): string => JSON.stringify([change.action, change.note, change.command]);
  const manifests = [...new Set(after.changes.filter((change) => MANIFESTS.has(change.path.split('/').at(-1) ?? '') && !before.changes.some((prior) => prior.path === change.path && work(prior) === work(change))).map((change) => change.path))];
  if (manifests.length) gates.push(`new external dependency (${manifests.join(', ')})`);
  return { ok: true, plan: after, hash: `sha256:${crypto.createHash('sha256').update(after.governedText).digest('hex')}`, text: after.governedText, gates };
}
