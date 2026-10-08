import crypto from 'node:crypto';
import type { Effect, Handler } from '../core/types.ts';
import { loadRecovery, publishEvidence } from './recovery-manifest.ts';
import { classifyChange } from '../policy/drift.ts';
import { judgeHotfix } from '../policy/hotfix.ts';
import { stableValue } from '../domain/stable-value.ts';
import { governedPlanText } from '../domain/plan.ts';
import { snapshotContent } from './snapshot.ts';
const bindingHash = (value: unknown): string => crypto.createHash('sha256').update(stableValue(value)).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

type Assessment = Extract<Effect, { kind: 'assess-recovery' }>;
const strings = (value: unknown): string[] => Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
export function createAssessRecovery(): Handler<Assessment> {
  return async (effect, ports, ctx) => {
    try {
      const before = loadRecovery(ports, ctx.runDir, effect.before['recovery']);
      const after = loadRecovery(ports, ctx.runDir, effect.after['recovery']);
      const beforeHash = bindingHash(effect.before), afterHash = bindingHash(effect.after);
      if (before.repoRoot !== after.repoRoot) throw new Error('Recovery repository binding changed.');
      const paths = [...new Set([...Object.keys(before.contents), ...Object.keys(after.contents), ...strings(effect.input['additionalPaths'])])].filter((file) => strings(effect.input['additionalPaths']).includes(file) || before.contents[file] !== after.contents[file] || stableValue(before.entries[file]) !== stableValue(after.entries[file]));
      const membership = new Set(after.membership ?? []);
      const delta = paths.map((file) => ({ path: file, kind: membership.has(file) ? 'membership' : !Object.hasOwn(before.contents, file) ? 'add' : !after.entries[file] ? 'delete' : 'edit', before: before.contents[file] ?? null, after: after.contents[file] ?? null }));
      const identityChanged = effect.input['collision'] === true || before.git.head !== after.git.head || before.git.index !== after.git.index || before.ignoreRules !== after.ignoreRules;
      const managed = paths.filter((file) => strings(effect.input['managedPlans']).includes(file) && before.entries[file]?.kind === 'file' && after.entries[file]?.kind === 'file' && stableValue(before.entries[file]) === stableValue(after.entries[file])
        && governedPlanText(Buffer.from(snapshotContent(before, file, ports, ctx.runDir)!, 'base64').toString('utf8')) === governedPlanText(Buffer.from(snapshotContent(after, file, ports, ctx.runDir)!, 'base64').toString('utf8')));
      const ids = strings(effect.input['evidenceIds']);
      const dependencies = isRecord(effect.input['evidenceDependencies']) ? effect.input['evidenceDependencies'] : {};
      const coverage = ids.map((id) => ({ id, value: dependencies[id] }));
      const complete = (value: unknown): value is { inputs: string[]; complete: true; rationale: string } => isRecord(value) && value['complete'] === true && Array.isArray(value['inputs']) && value['inputs'].every((file) => typeof file === 'string') && typeof value['rationale'] === 'string' && !!value['rationale'].trim();
      const coveredInputs = coverage.flatMap(({ value }) => complete(value) ? value.inputs : []);
      const classified = classifyChange({ paths, expectedPaths: strings(effect.input['expectedPaths']), ownedPaths: [...strings(effect.input['ownedPaths']), ...managed], inputs: [...strings(effect.input['inputs']), ...coveredInputs], dependenciesComplete: ids.length > 0 && coverage.every(({ value }) => complete(value)), identityChanged });
      const material = classified.paths.filter((file) => ![...strings(effect.input['expectedPaths']), ...strings(effect.input['ownedPaths']), ...managed].includes(file));
      const affectedEvidence = classified.relevance === 'expected' || classified.relevance === 'irrelevant' ? [] : coverage.filter(({ value }) => identityChanged || !complete(value) || value.inputs.some((file) => material.includes(file))).map(({ id }) => id);
      const judgement = effect.purpose === 'hotfix' ? judgeHotfix({ repoRoot: before.repoRoot, changed: after.changed, external: (effect.input['external'] ?? []) as { path: string; reason: string }[], before: before.git, after: after.git,
        taskStartFiles: before.taskStartFiles, preRed: effect.input['preRed'] === true, productionPaths: strings(effect.input['productionPaths']), failureIdentityBefore: null, failureIdentityAfter: null }) : undefined;
      const rawDeltaRef = publishEvidence(ports, ctx.runDir, { version: 1, beforeHash, afterHash, delta, beforeGit: before.git, afterGit: after.git, ...(judgement ? { judgement } : {}) });
      const notice = { id: bindingHash({ phase: effect.phase, pendingId: effect.pendingId, beforeHash, afterHash }), phase: effect.phase, pendingId: effect.pendingId, beforeHash, afterHash, rawDeltaRef,
        paths: classified.paths.slice(0, 20), pathCount: classified.paths.length, relevance: classified.relevance, reason: classified.reason, affectedEvidence };
      return [{ type: 'RECOVERY_ASSESSED', effectId: effect.id, purpose: effect.purpose, beforeHash, afterHash, notice, ...(judgement ? { judgement: { ...judgement, violations: judgement.violations.slice(0, 20), violationCount: judgement.violations.length } } : {}) }];
    } catch (error) { return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'integrity', detail: error instanceof Error ? error.message : String(error) }]; }
  };
}
