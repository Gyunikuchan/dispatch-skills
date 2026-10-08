import crypto from 'node:crypto';
import { publishEvidence } from './recovery-manifest.ts';
import { stableValue } from '../domain/stable-value.ts';
import path from 'node:path';
import type { Effect, Handler } from '../core/types.ts';
import { withoutSections } from '../domain/plan.ts';
import { runPaths } from '../lib/session.ts';
import { isCommitHash, type Git, type ReviewSnapshot } from './git.ts';
import { runOwnedPaths } from './snapshot.ts';
const bindingHash = (value: unknown): string => crypto.createHash('sha256').update(stableValue(value)).digest('hex');

/** Matches the existing review-delta exclusions without collapsing repeated headings. */
export const reviewArtifactText = (source: string): string => withoutSections(source, ['## Review Findings & Resolutions', '## Execution Status']);

type Check = Extract<Effect, { kind: 'check-review-target' }>;
const manifestEntries = (value: unknown, nullable: boolean): boolean => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.values(value).every((entry) => typeof entry === 'string' || (nullable && entry === null));

export function createCheckReviewTarget(deps: { cwd: string; git: Git }): Handler<Check> {
  return async (effect, ports, ctx) => {
    try {
      const raw = ports.fs.readText(effect.manifestPath);
      if (!raw) throw new Error('binding evidence unavailable');
      const prior = JSON.parse(raw) as Record<string, unknown>;
      const target = String(effect.review['target'] ?? '');
      let current: Record<string, unknown>;
      let pathsChanged: string[] = [], unexpected: string[] = [], identityChanged = false;
      if (effect.review['kind'] === 'code') {
        if (!deps.git.reviewSnapshot || !deps.git.reviewDelta || typeof prior['head'] !== 'string' || typeof prior['comparison'] !== 'string'
          || prior['target'] !== target || !manifestEntries(prior['working'], true) || !manifestEntries(prior['index'], false) || !manifestEntries(prior['untracked'], true)
          || (prior['governedPaths'] !== undefined && (!Array.isArray(prior['governedPaths']) || !prior['governedPaths'].every((file) => typeof file === 'string')))) throw new Error('code binding evidence unavailable');
        const root = await deps.git.toplevel(deps.cwd);
        const driverOwned = new Set(runOwnedPaths(ports, root, ctx.runDir, ctx.ownedArtifacts));
        const allowed = new Set(effect.allowedPaths.map((file) => path.relative(root, path.resolve(root, file)).replaceAll('\\', '/')));
        let changes: string[] | undefined;
        if (prior['changeSet'] !== undefined) {
          if (!Array.isArray(prior['changeSet']) || !prior['changeSet'].every((file) => typeof file === 'string')) throw new Error('changed-path binding evidence unavailable');
          if (prior['changeBaseline'] !== undefined) {
            if (!isCommitHash(prior['changeBaseline']) || !deps.git.baselineDiff) throw new Error('integration baseline binding evidence unavailable');
            changes = await deps.git.baselineDiff(deps.cwd, prior['changeBaseline']);
          } else changes = await deps.git.diffNames(deps.cwd, target);
          changes = changes.filter((file) => !driverOwned.has(file));
          const priorChanges = new Set(prior['changeSet'] as string[]), currentChanges = new Set(changes);
          const outside = [...new Set([...priorChanges, ...currentChanges])].filter((file) => priorChanges.has(file) !== currentChanges.has(file) && !allowed.has(file));
          pathsChanged.push(...outside); unexpected.push(...outside);
        }
        const paths = Array.isArray(prior['governedPaths']) ? [...new Set([...(prior['governedPaths'] as string[]), ...Object.keys(prior['working'] as object), ...Object.keys(prior['untracked'] as object), ...(changes ?? [])])] : undefined;
        const snapshot = await deps.git.reviewSnapshot(deps.cwd, target, paths, { fullIndex: true });
        const delta = await deps.git.reviewDelta(deps.cwd, prior as ReviewSnapshot, snapshot);
        identityChanged = snapshot.head !== prior['head'] || snapshot.comparison !== prior['comparison'];
        pathsChanged.push(...delta.paths);
        const outside = delta.paths.filter((file) => !allowed.has(file));
        pathsChanged.push(...outside); unexpected.push(...outside);
        current = { ...snapshot, ...(prior['governedPaths'] ? { governedPaths: prior['governedPaths'] } : {}), ...(changes ? { changeSet: changes } : {}), ...(prior['changeBaseline'] !== undefined ? { changeBaseline: prior['changeBaseline'] } : {}) };
      } else {
        if (typeof prior['text'] !== 'string' || prior['target'] !== target) throw new Error('artifact binding evidence unavailable');
        const file = path.resolve(deps.cwd, target);
        const source = ports.fs.exists(file) ? ports.fs.readText(file) : null;
        const allowed = effect.allowedPaths.some((entry) => path.resolve(deps.cwd, entry) === file);
        if (source === null || reviewArtifactText(prior['text']) !== reviewArtifactText(source)) { pathsChanged.push(target); if (!allowed || source === null) unexpected.push(target); }
        current = { kind: effect.review['kind'], target, text: source ?? '', ...(source === null ? { missing: true } : {}) };
      }
      const manifestPath = runPaths(ctx.runDir).scope(effect.id);
      ports.fs.writeAtomic(manifestPath, JSON.stringify(current));
      const identity = (value: Record<string, unknown>) => effect.review['kind'] === 'code' ? value : { target: value['target'], text: reviewArtifactText(String(value['text'])), ...(value['missing'] ? { missing: true } : {}) };
      const beforeHash = bindingHash(identity(prior)), afterHash = bindingHash(identity(current));
      const paths = [...new Set(pathsChanged)].sort();
      const rawDeltaRef = publishEvidence(ports, ctx.runDir, { version: 1, beforeHash, afterHash, paths, identityChanged });
      const changed = unexpected.length > 0 || identityChanged;
      const notice = { id: bindingHash({ beforeHash, afterHash, phase: 'review' }), phase: 'review', pendingId: effect.id, beforeHash, afterHash, rawDeltaRef, paths: paths.slice(0,20), pathCount: paths.length, relevance: changed ? 'relevant' as const : 'expected' as const, reason: identityChanged ? 'Comparison identity changed.' : changed ? 'Reviewed content changed.' : 'Unchanged or valid scoped fix.', affectedEvidence: [] };
      return [{ type: 'REVIEW_TARGET_CHECKED', effectId: effect.id, manifestPath, result: changed ? 'changed' : paths.length ? 'expected' : 'unchanged', notice }];
    } catch (error) {
      return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'integrity', detail: `target-changed: ${error instanceof Error ? error.message : String(error)}; binding evidence retained` }];
    }
  };
}
