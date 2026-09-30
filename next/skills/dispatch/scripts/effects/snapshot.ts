// `snapshot`: tree fingerprint `{ head, index, worktree }` and the paths changed since `since`.

import type { Effect, Handler } from '../core/types.ts';
import type { Git, TreeFingerprint } from './git.ts';

type SnapshotEffect = Extract<Effect, { kind: 'snapshot' }>;

export type SnapshotDeps = { cwd: string; git: Git };

function asFingerprint(value: unknown): TreeFingerprint | null {
  if (typeof value !== 'object' || value === null) return null;
  const { head, index, worktree } = value as Record<string, unknown>;
  if ((head !== null && typeof head !== 'string') || typeof index !== 'string' || typeof worktree !== 'string') return null;
  return { head, index, worktree };
}

export function createSnapshot(deps: SnapshotDeps): Handler<SnapshotEffect> {
  return async (effect) => {
    try {
      const fingerprint = await deps.git.fingerprint(deps.cwd);
      const since = asFingerprint(effect.since);
      const paths = since === null ? [] : await deps.git.changedSince(deps.cwd, since);
      return [{ type: 'SNAPSHOT', effectId: effect.id, fingerprint, diff: { paths } }];
    } catch (error) {
      return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: error instanceof Error ? error.message : String(error) }];
    }
  };
}
