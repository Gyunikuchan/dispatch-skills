// `parse-artifact`: read a plan, design, or spec, hash its governed text (driver-owned sections excluded; a spec hashes its raw
// text), lint it. Spec lint depends on the effect level.

import crypto from 'node:crypto';
import type { Effect, Handler, ResultEvent } from '../core/types.ts';
import { governedDesignText, parseDesign } from '../domain/design.ts';
import { governedPlanText, parsePlan } from '../domain/plan.ts';
import { governedSpecText, parseSpec } from '../domain/spec.ts';

type ParseEffect = Extract<Effect, { kind: 'parse-artifact' }>;

export const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

export const parseArtifact: Handler<ParseEffect> = async (effect, ports) => {
  const fail = (detail: string): ResultEvent[] => [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail }];
  if (!ports.fs.exists(effect.path)) return fail(`${effect.artifact} not found: ${effect.path}`);
  let source: string;
  try { source = ports.fs.readText(effect.path); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  const base = { type: 'ARTIFACT_PARSED' as const, effectId: effect.id, kind: effect.artifact };
  if (effect.artifact === 'plan') {
    const result = parsePlan(source);
    for (const warning of result.warnings.filter((item) => item.code === 'missing-seams')) {
      ports.proc.stderr(`[dispatch] ${effect.path}${warning.line === null ? '' : `:${warning.line}`}: warning ${warning.code}: ${warning.message}\n`);
    }
    const hash = `sha256:${sha256(governedPlanText(source))}`;
    return [result.ok ? { ...base, hash, parsed: result.plan, defects: [] } : { ...base, hash, parsed: {}, defects: result.defects }];
  }
  if (effect.artifact === 'spec') {
    const result = parseSpec(source, { level: effect.level });
    const hash = `sha256:${sha256(governedSpecText(source))}`;
    return [result.ok ? { ...base, hash, parsed: result.spec, defects: [] } : { ...base, hash, parsed: {}, defects: result.defects }];
  }
  const result = parseDesign(source);
  const hash = `sha256:${sha256(governedDesignText(source))}`;
  return [result.ok ? { ...base, hash, parsed: result.design, defects: [] } : { ...base, hash, parsed: {}, defects: result.defects }];
};
