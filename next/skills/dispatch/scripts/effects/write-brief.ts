// `write-brief`: fill `write-brief.md` with the stage block, write the brief to `<run>/<effectId>.brief.md`, and name
// the envelope path the writer must produce (`<run>/<effectId>.outcome.json`, not created here).

import crypto from 'node:crypto';
import path from 'node:path';
import type { Effect, Handler } from '../core/types.ts';
import { assembleTemplate, fillTemplate } from '../domain/prompt.ts';
import { writeRendered } from './artifacts.ts';

type BriefEffect = Extract<Effect, { kind: 'write-brief' }>;

export type BriefDeps = { skillRoot: string };

export function createWriteBrief(deps: BriefDeps): Handler<BriefEffect> {
  return async (effect, ports, ctx) => {
    const envelopePath = path.join(ctx.runDir, `${effect.id}.outcome.json`);
    const briefPath = path.join(ctx.runDir, `${effect.id}.brief.md`);
    let text: string;
    try {
      const dir = path.join(deps.skillRoot, 'references', 'templates');
      const template = assembleTemplate(ports.fs.readText(path.join(dir, 'write-brief.md')), ports.fs.readText(path.join(dir, `write-brief-${effect.stage}.md`)));
      const selfCheck = typeof effect.input['selfCheck'] === 'string' ? effect.input['selfCheck'] : `dispatch --check-envelope ${envelopePath}`;
      const values: Record<string, string> = { 'Expected Envelope Path': envelopePath, 'Self Check Command': selfCheck };
      text = fillTemplate(template.template, template.variables, Object.fromEntries(template.variables.map((name) => [name, values[name] ?? ''])));
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
