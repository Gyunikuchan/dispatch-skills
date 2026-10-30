import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { artifactHash, artifactKind, readArtifact } from './artifacts.ts';
import { parsePlan } from './domain/plan.ts';
import { parseDesign } from './domain/design.ts';
import { parseSpec } from './domain/spec.ts';
import { lintContextMap } from './domain/context.ts';
import { ToolError } from './output.ts';

export type LintArtifactOptions = { repositoryRoot?: string };

function safeRepoPath(value: string): boolean {
  if (!value || value.includes('\\') || value.includes('\0') || path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith('../') && !path.posix.isAbsolute(normalized);
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

/** Reads only repository files whose resolved path remains inside the session's repository root. */
export function repositoryReader(repositoryRoot: string): (relativePath: string) => string | null {
  const root = path.resolve(repositoryRoot);
  let realRoot: string;
  try { realRoot = fs.realpathSync(root); } catch { return () => null; }
  return relativePath => {
    if (!safeRepoPath(relativePath)) return null;
    const candidate = path.resolve(root, relativePath);
    if (!within(root, candidate)) return null;
    try {
      const real = fs.realpathSync(candidate);
      if (!within(realRoot, real) || !fs.statSync(real).isFile()) return null;
      return fs.readFileSync(real, 'utf8');
    } catch { return null; }
  };
}

export function lintArtifact(file: string, options: LintArtifactOptions = {}) {
  const isContext = file.endsWith('.context.md');
  const kind = artifactKind(file);
  if (!isContext && !kind) throw new ToolError(1, 'invalid-input', 'artifact must end in .spec.md, .plan.md, .design.md or .context.md');
  const source = readArtifact(path.dirname(file), path.basename(file));
  if (source === null) throw new ToolError(1, 'invalid-input', 'artifact is missing or unreadable: ' + file);
  if (isContext) {
    if (!options.repositoryRoot) throw new ToolError(1, 'invalid-input', 'context lint requires the session repository root');
    const result = lintContextMap(source, { readRepoFile: repositoryReader(options.repositoryRoot) });
    const hash = 'sha256:' + crypto.createHash('sha256').update(source).digest('hex');
    return { kind: 'context' as const, hash, errors: result.defects, warnings: result.warnings };
  }
  const result = kind === 'plan' ? parsePlan(source) : kind === 'design' ? parseDesign(source) : parseSpec(source);
  const hash = artifactHash(kind!, source);
  const errors = result.ok ? [] : result.defects;
  return { kind, hash, errors, warnings: result.warnings };
}
