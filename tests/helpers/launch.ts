// Launch-record readers: compact write frames link each writer to `launch.json`, so tests read launch fields from there.

import path from 'node:path';
import * as implement from '../../skills/dispatch/scripts/machines/implement.ts';
import type { ImplementState } from '../../skills/dispatch/scripts/machines/implement.ts';

export type Launch = {
  task: string; attempt: number; signature: string; action: string; handle: string | null; model: string; effort?: string;
  briefPath: string; briefHash: string; envelopePath: string; checkpointPath: string; worktree: string; paths: string[];
  receipts: Record<string, unknown>[]; retirement?: string; retainedSubmission?: string; notice?: string;
};
type Node = { tag?: unknown; run?: unknown; child?: unknown; parked?: unknown; c?: unknown };

/** Active implementation of a root, design, or implement state; history and inactive children are never selected. */
function activeImplementation(state: unknown): ImplementState {
  const node = (state ?? {}) as Node;
  if ('run' in node) {
    if (node.tag === 'implement') return node.child as ImplementState;
    if (node.tag === 'design') return activeImplementation(node.child);
    if (node.tag === 'spec' && node.parked) return activeImplementation((node.parked as { state: unknown }).state);
    throw new Error('no active implementation');
  }
  if (node.tag === 'increment' && node.child) return node.child as ImplementState;
  if (node.c && typeof node.c === 'object' && 'tasks' in node.c) return state as ImplementState;
  throw new Error('no active implementation');
}

/** Launch record of `task` in the active implementation of a root, design, or implement state. */
export function launchOf(state: unknown, task: string): Launch {
  const found = implement.implementLaunches(activeImplementation(state), '').find((entry) => entry.record['task'] === task);
  if (!found) throw new Error(`no launch record for ${task}`);
  return found.record as unknown as Launch;
}

/** Merges each compact frame row with the `launch.json` its run-relative `launchPath` names. */
export function withLaunch<Row extends { launchPath: string }>(rows: readonly Row[], runDir: string, readText: (file: string) => string): (Row & Launch)[] {
  return rows.map((row) => ({ ...row, ...(JSON.parse(readText(path.join(runDir, row.launchPath))) as Launch) }));
}
