import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { artifactHash, artifactKind, readArtifact } from './artifacts.ts';
import { parsePlan, sectionRanges, structuralLines } from './domain/plan.ts';
import { parseDesign } from './domain/design.ts';
import { parseSpec } from './domain/spec.ts';
import { contextCoverageWarnings, lintContextMap, parseContextMap, type ContextLintIssue } from './domain/context.ts';
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

/** Returns the sibling `<slug>.context.md` of a plan or design, or null when it is absent. */
export function canonicalContextMap(artifactFile: string): string | null {
  const name = path.basename(artifactFile);
  const suffix = ['.plan.md', '.design.md'].find(item => name.endsWith(item));
  if (!suffix) return null;
  const canonicalName = name.slice(0, -suffix.length) + '.context.md';
  try {
    const matches = fs.readdirSync(path.dirname(artifactFile)).filter(entry => entry === canonicalName);
    if (matches.length !== 1) return null;
    const file = path.join(path.dirname(artifactFile), matches[0]!);
    return fs.statSync(file).isFile() ? file : null;
  } catch { return null; }
}

const missingContextMap = (file: string): ContextLintIssue => ({
  code: 'missing-context-map', severity: 'defect', line: null,
  message: 'Plan and design need a sibling context map named ' + path.basename(file).replace(/\.(plan|design)\.md$/, '.context.md') + '.',
});

function outOfScopeText(source: string): string {
  const lines = structuralLines(source);
  const range = sectionRanges(lines, '## Out of Scope')[0];
  return range ? lines.slice(range.start + 1, range.end).map(line => line.text).join('\n') : '';
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
    return { kind: 'context' as const, hash, errors: result.defects, warnings: result.warnings, parsed: result.map };
  }
  const result = kind === 'plan' ? parsePlan(source) : kind === 'design' ? parseDesign(source) : parseSpec(source);
  const hash = artifactHash(kind!, source);
  const parsed = result.ok ? ('plan' in result ? result.plan : 'design' in result ? result.design : result.spec) : null;
  const errors = result.ok ? [] : result.defects;
  if (kind === 'spec') return { kind, hash, errors, warnings: result.warnings, parsed };
  // SECTION: Grounding — plan and design require their sibling context map.
  const mapFile = canonicalContextMap(file);
  if (!mapFile) return { kind, hash, errors: [...errors, missingContextMap(file)], warnings: result.warnings, parsed };
  if (kind === 'plan' && result.ok && 'plan' in result) {
    try {
      const mapSource = fs.readFileSync(mapFile, 'utf8');
      const warnings = contextCoverageWarnings(parseContextMap(mapSource), result.plan, outOfScopeText(source));
      return { kind, hash, errors, warnings: [...result.warnings, ...warnings], parsed };
    } catch { /* An unreadable optional map leaves plan lint unchanged. */ }
  }
  return { kind, hash, errors, warnings: result.warnings, parsed };
}
