// `handoff` (ADR 0003): the handler only computes the destination, because `send` still holds the lock and appends
// and renders under the run dir. `finalizeHandoff` performs the move after `send` unlocks (wired by dispatch.ts, I08).

import path from 'node:path';
import type { Effect, Handler } from '../core/types.ts';

type HandoffEffect = Extract<Effect, { kind: 'handoff' }>;

/** `tempRoot` is the real (realpath) temp dir; `workspaceRoot` is `<repo>/.scratch/dispatch-skills`. */
export type HandoffDeps = { tempRoot: string; workspaceRoot: string };

/** The session folder when the run dir sits at `<session>/.state/runs/<id>`; the run dir otherwise. */
export function sessionDirOf(runDir: string): string {
  const stripped = runDir.replace(/[\\/]\.state[\\/]runs[\\/][^\\/]+[\\/]?$/, '');
  return stripped === runDir ? runDir.replace(/[\\/]+$/, '') : stripped;
}

export function handoffDestination(runDir: string, terminal: boolean, deps: HandoffDeps): string {
  const root = terminal ? path.join(deps.tempRoot, 'dispatch-skills') : deps.workspaceRoot;
  return path.join(root, path.basename(sessionDirOf(runDir)));
}

export function createHandoff(deps: HandoffDeps): Handler<HandoffEffect> {
  return async (effect, _ports, ctx) => [{ type: 'HANDOFF_DONE', effectId: effect.id, destination: handoffDestination(ctx.runDir, effect.terminal, deps), warning: null }];
}

export type FinalizeDeps = { rename(from: string, to: string): void; exists(file: string): boolean };

/** Moves the session after unlock; a failed move leaves it in place and returns a warning instead of throwing. */
export function finalizeHandoff(sessionDir: string, destination: string, deps: FinalizeDeps): { location: string; warning: string | null } {
  if (path.resolve(sessionDir) === path.resolve(destination)) return { location: destination, warning: null };
  if (deps.exists(destination)) return { location: sessionDir, warning: `handoff: destination exists, session stays at ${sessionDir}` };
  try {
    deps.rename(sessionDir, destination);
    return { location: destination, warning: null };
  } catch (error) {
    return { location: sessionDir, warning: `handoff: move to ${destination} failed (${error instanceof Error ? error.message : String(error)}); session stays at ${sessionDir}` };
  }
}
