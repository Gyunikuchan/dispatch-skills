// Worktree drift classification (spec §8.7): which changed paths the current await permits, which were already
// dirty at the caller's baseline, which auto-adopt as skill-hash refreshes, and which are drift.

import type { Await } from '../core/types.ts';

export type DriftContext = {
  stagePaths: readonly string[];
  testPaths: readonly string[];
  testsOnly: boolean;
  artifactPath: string | null;
};

const unreachable = (value: never): never => { throw new Error(`unhandled await: ${String(value)}`); };
const slash = (file: string) => file.replace(/\\/g, '/').replace(/^\.\//, '');

export function permittedPaths(awaiting: Await, ctx: DriftContext): string[] {
  switch (awaiting) {
    case 'fix': case 'write':
      return [...(ctx.testsOnly ? ctx.testPaths : ctx.stagePaths)].map(slash);
    case 'author':
      return ctx.artifactPath ? [slash(ctx.artifactPath)] : [];
    case 'native': case 'rule': case 'evidence': case 'decide': case 'done':
      return [];
    default:
      return unreachable(awaiting);
  }
}

export type DriftInput = {
  awaiting: Await;
  ctx: DriftContext;
  changed: readonly string[];
  /** Paths dirty when the caller's baseline was taken. */
  callerDirty: readonly string[];
  /** Directories holding a skill-hashes.json manifest. */
  hashManifestDirs: readonly string[];
};

export type DriftClassification = { permitted: string[]; callerDirty: string[]; autoAdopt: string[]; drift: string[] };

const HASHES = 'skill-hashes.json';
const within = (file: string, dir: string) => dir === '' || file.startsWith(`${dir}/`);

/** The `skill-hashes.json` of the nearest manifest directory above each permitted path. */
function adoptableHashes(permitted: readonly string[], dirs: readonly string[]): Set<string> {
  const manifests = dirs.map((dir) => slash(dir).replace(/\/+$/, ''));
  const out = new Set<string>();
  for (const file of permitted) {
    const nearest = manifests.filter((dir) => within(file, dir)).sort((a, b) => b.length - a.length)[0];
    if (nearest !== undefined) out.add(nearest ? `${nearest}/${HASHES}` : HASHES);
  }
  return out;
}

export function classifyDrift(input: DriftInput): DriftClassification {
  const permitted = permittedPaths(input.awaiting, input.ctx);
  const allowed = new Set(permitted);
  const hashes = adoptableHashes(permitted, input.hashManifestDirs);
  const dirty = new Set(input.callerDirty.map(slash));
  const out: DriftClassification = { permitted: [], callerDirty: [], autoAdopt: [], drift: [] };
  for (const raw of input.changed) {
    const file = slash(raw);
    if (allowed.has(file)) out.permitted.push(file);
    else if (dirty.has(file)) out.callerDirty.push(file);
    else if (hashes.has(file)) out.autoAdopt.push(file);
    else out.drift.push(file);
  }
  return out;
}
