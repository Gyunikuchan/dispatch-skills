// `parse-artifact`: read a plan, design, or spec, hash its governed text (driver-owned sections excluded; a spec hashes its raw
// text), lint it. Spec lint depends on the effect level.

import crypto from 'node:crypto';
import path from 'node:path';
import { pathIdentity } from '../domain/path-identity.ts';
import type { Effect, Handler, ResultEvent } from '../core/types.ts';
import { governedDesignText, parseDesign, validateApproachRequirements } from '../domain/design.ts';
import { governedPlanText, parsePlan, parentPin, validateSpecTraceability } from '../domain/plan.ts';
import { governedSpecText, parseSpec } from '../domain/spec.ts';

type ParseEffect = Extract<Effect, { kind: 'parse-artifact' }>;

export const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

export const createParseArtifact = (deps: { cwd: string }): Handler<ParseEffect> => async (effect, ports) => {
  const fail = (detail: string): ResultEvent[] => [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail }];
  if (!ports.fs.exists(effect.path)) return fail(`${effect.artifact} not found: ${effect.path}`);
  let source: string;
  try { source = ports.fs.readText(effect.path); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  const base = { type: 'ARTIFACT_PARSED' as const, effectId: effect.id, kind: effect.artifact };
  if (effect.artifact === 'spec') {
    const result = parseSpec(source, { level: effect.level });
    const hash = `sha256:${sha256(governedSpecText(source))}`;
    return [result.ok ? { ...base, hash, parsed: result.spec, defects: [] } : { ...base, hash, parsed: {}, defects: result.defects }];
  }
  const result = effect.artifact === 'plan' ? parsePlan(source) : parseDesign(source);
  const hash = `sha256:${sha256(effect.artifact === 'plan' ? governedPlanText(source) : governedDesignText(source))}`;
  const parsed = result.ok ? ('plan' in result ? result.plan : result.design) : {};
  const defects = result.ok ? [] : [...result.defects];
  const warnings = 'warnings' in result ? [...result.warnings] : [];
  let governing: Extract<ResultEvent, { type: 'ARTIFACT_PARSED' }>['governing'];
  if (effect.governing) {
    let pin = parentPin(source);
    const design = pin?.kind === 'design' ? pin.path : null;
    if (pin?.kind === 'design') {
      const target = path.resolve(deps.cwd, pin.path);
      try {
        if (!ports.fs.exists(target)) return fail(`design pin target unreadable: ${pin.path}`);
        pin = parentPin(ports.fs.readText(target));
      } catch { return fail(`design pin target unreadable: ${design}`); }
      if (pin?.kind !== 'spec') return fail(`design ${design} has no spec pin`);
    }
    if (pin?.kind === 'spec' && pathIdentity(pin.path, deps.cwd) !== pathIdentity(effect.governing, deps.cwd)) return fail(`spec pin path conflicts with governing spec: ${pin.path}`);
    let specSource: string;
    try { specSource = ports.fs.readText(effect.governing); }
    catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
    const current = `sha256:${sha256(governedSpecText(specSource))}`;
    const spec = parseSpec(specSource, { level: 'low' });
    const pinned = pin?.kind === 'spec' ? pin.hash : null;
    if (!spec.ok && current === pinned) return fail('governing spec fails lint');
    governing = { pinned, current, design, reqIds: spec.ok ? spec.spec.reqIds : [] };
    if (result.ok && pinned === current && spec.ok) {
      const trace = 'plan' in result ? validateSpecTraceability(result.plan, spec.spec.reqIds) : validateApproachRequirements(result.design, spec.spec.reqIds);
      defects.push(...trace.filter(item => item.severity === 'defect'));
      warnings.push(...trace.filter(item => item.severity === 'warning'));
    }
  }
  for (const warning of warnings.filter(item => item.code === 'missing-seams' || item.code === 'unsatisfied-requirement')) {
    ports.proc.stderr(`[dispatch] ${effect.path}${warning.line === null ? '' : `:${warning.line}`}: warning ${warning.code}: ${warning.message}\n`);
  }
  return [{ ...base, hash, parsed, defects, ...(governing ? { governing } : {}) }];
};

export const parseArtifact = createParseArtifact({ cwd: process.cwd() });
