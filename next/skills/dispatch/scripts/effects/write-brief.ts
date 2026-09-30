// `write-brief`: fill `write-brief.md` with the stage block, write the brief to `<run>/<effectId>.brief.md`, and name
// the envelope path the writer must produce (`<run>/<effectId>.outcome.json`, not created here).

import crypto from 'node:crypto';
import path from 'node:path';
import type { Effect, Handler } from '../core/types.ts';
import { assembleTemplate, fillTemplate } from '../domain/prompt.ts';
import { writeRendered } from './artifacts.ts';

type BriefEffect = Extract<Effect, { kind: 'write-brief' }>;

export type BriefDeps = { skillRoot: string };

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
  rows.push(['Settled scope', render(input['settledScope'])]);
  rows.push(['Criteria', render(input['criteria'])]);
  rows.push(['Envelope schema', render(input['envelopeSchema'])]);
  if (input['existingRedMatrix'] !== undefined) rows.push(['Existing RED matrix', render(input['existingRedMatrix'])]);
  if (input['admissionDefects'] !== undefined) rows.push(['Admission defects', render(input['admissionDefects'])]);
  rows.push(['Repository rules', render(input['rules'])]);
  rows.push(['Prior review findings', render(input['priorFindings'])]);
  rows.push(['Verification evidence', `Evidence, not specification.\n${render(input['evidence'])}`]);
  return `\n${rows.map(([heading, body]) => `## ${heading}\n\n${body}`).join('\n\n')}\n`;
}

export function createWriteBrief(deps: BriefDeps): Handler<BriefEffect> {
  return async (effect, ports, ctx) => {
    const envelopePath = path.join(ctx.runDir, `${effect.id}.outcome.json`);
    const briefPath = path.join(ctx.runDir, `${effect.id}.brief.md`);
    let text: string;
    try {
      const dir = path.join(deps.skillRoot, 'references', 'templates');
      const template = assembleTemplate(ports.fs.readText(path.join(dir, 'write-brief.md')), ports.fs.readText(path.join(dir, `write-brief-${effect.stage}.md`)));
      const rawSelfCheck = typeof effect.input['selfCheck'] === 'string' ? effect.input['selfCheck'] : 'dispatch --check-envelope <Expected Envelope Path>';
      const selfCheck = rawSelfCheck.split('<Expected Envelope Path>').join(envelopePath);
      const values: Record<string, string> = { 'Expected Envelope Path': envelopePath, 'Self Check Command': selfCheck };
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
