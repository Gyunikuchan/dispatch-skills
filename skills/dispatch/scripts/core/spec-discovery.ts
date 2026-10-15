// Startup discovery of the governing spec candidate (KD-7): Parent chain, then `--spec`, then the single session-root spec.

import path from 'node:path';
import { pathIdentity } from '../domain/path-identity.ts';
import { parseSummaryBox } from '../domain/plan.ts';
import type { FsPort, Verb } from './types.ts';

export type SpecDiscoveryInput = { verb: Verb; argument: string; specFlag: string | null; sessionDir: string; repoRoot: string };
export type SpecDiscovery =
  | { ok: true; candidate: string | null }
  | { ok: false; code: 'ambiguous-spec' | 'spec-conflict' | 'spec-not-found'; message: string };

const SPEC_PIN = /^`([^`]+\.spec\.md)`\s*·\s*sha256:[0-9a-f]+$/i;
const DESIGN_PIN = /^`([^`]+\.design\.md)`\s*·\s*I\d{2}$/i;

function parentOf(fs: FsPort, file: string): string | null {
  if (!fs.exists(file)) return null;
  const box = parseSummaryBox(fs.readText(file));
  return box?.entries.find((entry) => entry.label === 'Parent')?.value.trim() ?? null;
}

/** Follows a plan or design Parent to a `.spec.md` pin; any other Parent (e.g. `user request`) yields none. */
function chainCandidate(fs: FsPort, target: string, repoRoot: string): SpecDiscovery {
  let parent = parentOf(fs, target);
  const design = parent ? DESIGN_PIN.exec(parent) : null;
  // NOTE: increment plans pin their design; the design's own Parent names the spec.
  if (design) {
    const designFile = path.resolve(repoRoot, design[1]!);
    if (!fs.exists(designFile)) return { ok: false, code: 'spec-not-found', message: `spec-not-found: design ${design[1]} (pinned by ${path.basename(target)}) does not exist` };
    parent = parentOf(fs, designFile);
  }
  const spec = parent ? SPEC_PIN.exec(parent) : null;
  if (!spec) return { ok: true, candidate: null };
  const candidate = path.resolve(repoRoot, spec[1]!);
  if (!fs.exists(candidate)) return { ok: false, code: 'spec-not-found', message: `spec-not-found: ${spec[1]} (pinned by ${path.basename(target)}) does not exist` };
  return { ok: true, candidate };
}

export function discoverSpecCandidate(fs: FsPort, input: SpecDiscoveryInput): SpecDiscovery {
  const { verb, argument, specFlag, sessionDir, repoRoot } = input;
  if (verb === 'ask') return { ok: true, candidate: null };
  let chain: string | null = null;
  if ((verb === 'review' || verb === 'implement') && /\.(?:plan|design)\.md$/i.test(argument)) {
    const found = chainCandidate(fs, path.resolve(repoRoot, argument), repoRoot);
    if (!found.ok) return found;
    chain = found.candidate;
  }
  if (specFlag !== null) {
    const flagged = path.resolve(repoRoot, specFlag);
    if (!fs.exists(flagged)) return { ok: false, code: 'spec-not-found', message: `spec-not-found: --spec ${specFlag} does not exist` };
    if (chain && pathIdentity(chain, repoRoot) !== pathIdentity(flagged, repoRoot)) return { ok: false, code: 'spec-conflict', message: `spec-conflict: --spec ${specFlag} differs from the governing spec ${chain}` };
    return { ok: true, candidate: flagged };
  }
  if (chain) return { ok: true, candidate: chain };
  const roots = fs.exists(sessionDir) ? fs.listFiles(sessionDir).filter((file) => !file.includes('/') && /\.spec\.md$/i.test(file)) : [];
  if (roots.length > 1) return { ok: false, code: 'ambiguous-spec', message: `ambiguous-spec: ${roots.length} session-root specs (${roots.sort().join(', ')}); pass --spec <path>` };
  return { ok: true, candidate: roots.length ? path.join(sessionDir, roots[0]!) : null };
}
