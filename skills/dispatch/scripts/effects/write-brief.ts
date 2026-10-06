// `write-brief`: fill `write-brief.md` with the stage block, write the brief to `<run>/<effectId>/brief.md`, and name
// the envelope path the writer must produce (`<run>/<effectId>/outcome.json`, not created here).

import crypto from 'node:crypto';
import path from 'node:path';
import type { Effect, Handler } from '../core/types.ts';
import { assembleTemplate, fillTemplate } from '../domain/prompt.ts';
import { writeRendered } from './artifacts.ts';
import { runPaths } from '../lib/session.ts';

type BriefEffect = Extract<Effect, { kind: 'write-brief' }>;

export type BriefDeps = { skillRoot: string; checkpointCommand?: (root: string, out: string, paths: readonly string[]) => string };

const quote = (value: string): string => `"${value}"`;
const defaultCheckpoint = (root: string, out: string, paths: readonly string[]): string => `dispatch checkpoint --root ${quote(root)} --out ${quote(out)} -- ${paths.map(quote).join(' ')}`;

function structuredContext(input: Readonly<Record<string, unknown>>): string {
  const rows: [string, string][] = [];
  const render = (value: unknown): string => {
    if (typeof value === 'string') return value.trim() || '(none)';
    if (Array.isArray(value)) return value.length ? value.map((item) => `- ${typeof item === 'string' ? item.trim() : JSON.stringify(item)}`).join('\n') : '(none)';
    if (value === undefined || value === null) return '(none)';
    return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  };
  if (typeof input['planPath'] === 'string' || typeof input['planHash'] === 'string') {
    rows.push(['Governing plan', `Path: ${String(input['planPath'] ?? '(unknown)')}\nHash: ${String(input['planHash'] ?? '(unknown)')}`]);
  }
  rows.push(['Governing outcome', render(input['governingOutcome'])]);
  if (input['task']) rows.push(['Task, graph, and worktree', render(input['task'])]);
  rows.push(['Settled scope', render(input['settledScope'])]);
  rows.push(['Criteria', render(input['criteria'])]);
  if (input['designBinding']) rows.push(['Governing design and inherited contract', render(input['designBinding'])]);
  if (input['reopenedDefects']) rows.push(['Integration repair context', render(input['reopenedDefects'])]);
  rows.push(['Envelope schema', render(input['envelopeSchema'])]);
  if (input['existingRedMatrix'] !== undefined) rows.push(['Existing RED matrix', render(input['existingRedMatrix'])]);
  if (input['admissionDefects'] !== undefined) rows.push(['Admission defects', render(input['admissionDefects'])]);
  if (input['retryContext']) rows.push(['Retry root cause and failure evidence', render(input['retryContext'])]);
  if (input['rootCause']) rows.push(['Root cause', render(input['rootCause'])]);
  if (input['stalledCheck']) rows.push(['Stalled check evidence', render(input['stalledCheck'])]);
  if (input['hotfix']) rows.push(['Hotfix limits and single-shot writer', render(input['hotfix'])]);
  rows.push(['Repository rules', render(input['rules'])]);
  rows.push(['Prior review findings', render(input['priorFindings'])]);
  rows.push(['Verification evidence', `Evidence, not specification.\n${render(input['evidence'])}`]);
  return `\n${rows.map(([heading, body]) => `## ${heading}\n\n${body}`).join('\n\n')}\n`;
}

export function createWriteBrief(deps: BriefDeps): Handler<BriefEffect> {
  return async (effect, ports, ctx) => {
    const envelopePath = runPaths(ctx.runDir).envelope(effect.id);
    const briefPath = runPaths(ctx.runDir).brief(effect.id);
    let text: string;
    try {
      const dir = path.join(deps.skillRoot, 'references', 'templates');
      const template = assembleTemplate(ports.fs.readText(path.join(dir, 'write-brief.md')), ports.fs.readText(path.join(dir, `write-brief-${effect.stage}.md`)));
      const rawSelfCheck = typeof effect.input['selfCheck'] === 'string' ? effect.input['selfCheck'] : 'dispatch --check-envelope <Expected Envelope Path>';
      const selfCheck = rawSelfCheck.split('<Expected Envelope Path>').join(envelopePath);
      const task = typeof effect.input['task'] === 'object' && effect.input['task'] !== null ? effect.input['task'] as Readonly<Record<string, unknown>> : null;
      const checkpoint = task && typeof task['checkpoint'] === 'object' && task['checkpoint'] !== null ? task['checkpoint'] as { root?: unknown; paths?: unknown } : null;
      const checkpointCommand = checkpoint && typeof checkpoint.root === 'string' && Array.isArray(checkpoint.paths)
        ? (deps.checkpointCommand ?? defaultCheckpoint)(checkpoint.root, envelopePath.replace(/outcome\.json$/, 'red.json'), checkpoint.paths.filter((item): item is string => typeof item === 'string'))
        : 'No RED checkpoint: this task has no RED criteria.';
      const values: Record<string, string> = { 'Expected Envelope Path': envelopePath, 'Self Check Command': selfCheck, 'Checkpoint Command': checkpointCommand };
      const rendered = fillTemplate(template.template, template.variables, Object.fromEntries(template.variables.map((name) => [name, values[name] ?? ''])));
      text = `${rendered}${structuredContext(effect.input)}`;
    } catch (error) {
      return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: error instanceof Error ? error.message : String(error) }];
    }
    try { writeRendered(ports, briefPath, text); } catch (error) {
      return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: `brief: ${error instanceof Error ? error.message : String(error)}` }];
    }
    const sha256 = crypto.createHash('sha256').update(text).digest('hex');
    return [{ type: 'BRIEF_READY', effectId: effect.id, stage: effect.stage, path: briefPath, sha256: `sha256:${sha256}`, envelopePath }];
  };
}
