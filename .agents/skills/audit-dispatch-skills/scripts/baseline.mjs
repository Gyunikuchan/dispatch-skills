#!/usr/bin/env node

/**
 * @file baseline.mjs
 * @description Deterministic audit evidence gathered before any subagent runs, written to the run's work dir:
 *   - git-status.txt: repo snapshot (audit output excluded) that finalize.mjs compares against;
 *   - tests.txt:      full test run with line/branch coverage (bypasses `npm test`'s pretest hash write);
 *   - metrics.md:     doc token footprint, broken relative links/anchors, script structure,
 *                     exports no test mentions, per-file test counts, skill hash drift.
 * Prints a short digest; the files carry the detail.
 *
 * Usage: node <skill>/scripts/baseline.mjs --run <yyyy-mm-dd-hhmm>
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { isMainModule, measureText } from '../../../../skills/dispatch/scripts/common.mjs';
import { auditGitStatus, frontmatterDescription, relTo, resolveRepoRoot, resolveRunDirs } from './shared.mjs';

// ============================================================================
// SECTION: Configurable Constants
// ============================================================================

const SKIP_DIRS = new Set(['node_modules', '.git', '.scratch', 'worktrees']);
const TEST_TIMEOUT_MS = 10 * 60 * 1000;

// ============================================================================
// SECTION: Main
// ============================================================================

async function main() {
  const root = resolveRepoRoot();
  const { workDir, rel } = resolveRunDirs(root, process.argv);

  // Re-running step 1 to resume an audit used to overwrite the baseline it was resuming from,
  // silently replacing the pre-audit git status and test output the finalize step compares against.
  const existing = fs.existsSync(path.join(workDir, 'git-status.txt'));
  if (existing && !process.argv.includes('--force')) {
    throw new Error(
      `A baseline already exists at ${rel(workDir)}.\n` +
        'Resuming an audit should reuse it — re-running this step would replace the pre-audit ' +
        'snapshot that finalize compares against.\n' +
        'Pass --force to overwrite deliberately, or --run <id> to start a separate run.',
    );
  }

  fs.mkdirSync(workDir, { recursive: true });

  fs.writeFileSync(path.join(workDir, 'git-status.txt'), auditGitStatus(root) ?? '', 'utf8');

  const tests = runTests(root);
  fs.writeFileSync(path.join(workDir, 'tests.txt'), tests.output, 'utf8');

  const metrics = await buildMetrics(root);
  fs.writeFileSync(path.join(workDir, 'metrics.md'), metrics.markdown, 'utf8');

  process.stdout.write(
    [
      `Tests: ${tests.totals} (exit ${tests.status})`,
      `Broken links: ${metrics.brokenCount}`,
      ...metrics.hashLines,
      `Wrote ${rel(workDir)}/{git-status.txt,tests.txt,metrics.md}`,
    ].join('\n') + '\n',
  );
}

// ============================================================================
// SECTION: Tests & Coverage
// ============================================================================

function runTests(root) {
  // Node < 22 treats the quoted glob as a literal path and runs nothing; report that, not a false 0/0.
  if (Number(process.versions.node.split('.')[0]) < 22) {
    return { output: '', status: null, totals: 'skipped: Node <22 cannot expand the test glob' };
  }
  // Node expands the quoted glob itself, so the same argv works under bash, zsh, and PowerShell.
  const res = spawnSync(
    process.execPath,
    [
      '--test',
      '--experimental-test-coverage',
      // Scoped: some tests execute installed CLIs whose JS would otherwise flood the report.
      '--test-coverage-include=skills/**/*.mjs',
      '--test-coverage-include=scripts/**/*.mjs',
      '--test-coverage-include=.agents/skills/audit-dispatch-skills/**/*.mjs',
      '--test-reporter=spec',
      'tests/**/*.test.mjs',
    ],
    { cwd: root, encoding: 'utf8', timeout: TEST_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
  );
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const count = (label) => new RegExp(`^ℹ ${label} (\\d+)`, 'm').exec(output)?.[1] ?? '?';
  return { output, status: res.status, totals: `${count('pass')}/${count('tests')} pass, ${count('fail')} fail` };
}

// ============================================================================
// SECTION: Metrics
// ============================================================================

async function buildMetrics(root) {
  const rel = relTo(root);
  const docs = authoredDocs(root);
  const scripts = [
    ...walk(path.join(root, 'skills')),
    ...walk(path.join(root, 'scripts')),
    ...authoredSkillDirs(root).flatMap(walk),
  ].filter((f) => f.endsWith('.mjs'));
  const tests = walk(path.join(root, 'tests')).filter((f) => f.endsWith('.test.mjs'));
  const testText = tests.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

  const out = ['# Audit Metrics', ''];

  out.push('## Doc footprint', '', '| File | Words | Characters | ~Tokens | Description chars |', '|---|---|---|---|---|');
  for (const file of docs) {
    const text = fs.readFileSync(file, 'utf8');
    const description = frontmatterDescription(text);
    const words = text.split(/\s+/).filter(Boolean).length;
    const measured = measureText(text);
    out.push(`| ${rel(file)} | ${words} | ${measured.characters} | ${measured.estimate} | ${description ? description.length : '—'} |`);
  }

  const broken = docs.flatMap((file) => brokenLinks(file).map((b) => `- ${rel(file)}:${b.line} → \`${b.target}\` (${b.reason})`));
  out.push('', '## Broken relative links', '', ...(broken.length ? broken : ['- none']));

  // Name mentions are a lead, not proof: an export exercised only through another export shows up here.
  out.push('', '## Scripts', '', '| Script | LOC | SECTION dividers | Exports | Exports no test file names |', '|---|---|---|---|---|');
  for (const file of scripts) {
    const text = fs.readFileSync(file, 'utf8');
    const exportsList = [...text.matchAll(/^export (?:async )?(?:function\*?|const|let|class) (\w+)/gm)].map((m) => m[1]);
    const unnamed = exportsList.filter((name) => !new RegExp(`\\b${name}\\b`).test(testText));
    out.push(`| ${rel(file)} | ${loc(text)} | ${(text.match(/\/\/ SECTION:/g) ?? []).length} | ${exportsList.length} | ${unnamed.join(', ') || '—'} |`);
  }

  out.push('', '## Tests', '', '| Test file | LOC | Cases |', '|---|---|---|');
  for (const file of tests) {
    const text = fs.readFileSync(file, 'utf8');
    out.push(`| ${rel(file)} | ${loc(text)} | ${(text.match(/^\s*(?:it|test)\(/gm) ?? []).length} |`);
  }

  const { verifySkillIntegrity } = await import(pathToFileURL(path.join(root, 'skills/dispatch/scripts/common.mjs')).href);
  const hashLines = fs.readdirSync(path.join(root, 'skills')).map((dir) => {
    const skillDir = path.join(root, 'skills', dir);
    if (!fs.existsSync(path.join(skillDir, 'skill-hashes.json'))) return `Hashes skills/${dir}: no manifest`;
    const result = verifySkillIntegrity(skillDir);
    return `Hashes skills/${dir}: ${result.valid ? 'in sync' : `DRIFT in ${result.violations.join(', ')}`}`;
  });
  out.push('', '## Skill hash drift', '', ...hashLines.map((l) => `- ${l}`));

  return { markdown: `${out.join('\n')}\n`, brokenCount: broken.length, hashLines };
}

// ============================================================================
// SECTION: Discovery
// ============================================================================

/** Repo-authored skills under `.agents/skills`: real directories not installed via skills-lock.json. */
export function authoredSkillDirs(root) {
  const base = path.join(root, '.agents', 'skills');
  let vendored = new Set();
  try {
    vendored = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'skills-lock.json'), 'utf8')).skills ?? {}));
  } catch {}
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !vendored.has(e.name))
    .map((e) => path.join(base, e.name));
}

function authoredDocs(root) {
  return [
    path.join(root, 'README.md'),
    path.join(root, 'AGENTS.md'),
    ...walk(path.join(root, 'skills')),
    ...authoredSkillDirs(root).flatMap(walk),
  ].filter((f) => f.endsWith('.md') && fs.existsSync(f));
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP_DIRS.has(e.name)) return [];
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

// ============================================================================
// SECTION: Link Checking
// ============================================================================

export function brokenLinks(file) {
  const problems = [];
  let inFence = false;
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    // A fence delimiter toggles and is itself skipped; code fences routinely show placeholder
    // link syntax that is not meant to resolve.
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    for (const [, target] of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue; // http(s):, mailto:, etc.
      const [targetPath, anchor] = target.split('#');

      if (!targetPath) {
        // Same-file #anchor link.
        if (anchor && file.endsWith('.md') && !headingSlugs(file).has(anchor)) {
          problems.push({ line: i + 1, target, reason: 'missing anchor' });
        }
        continue;
      }

      const resolved = path.resolve(path.dirname(file), decodeURIComponent(targetPath));
      if (!fs.existsSync(resolved)) {
        problems.push({ line: i + 1, target, reason: 'missing file' });
        continue;
      }
      // A link may legitimately target a directory; only a file can carry heading anchors.
      if (anchor && resolved.endsWith('.md') && fs.statSync(resolved).isFile() && !headingSlugs(resolved).has(anchor)) {
        problems.push({ line: i + 1, target, reason: 'missing anchor' });
      }
    }
  });
  return problems;
}

/** GitHub-style heading slugs. */
export function headingSlugs(file) {
  const slugs = new Set();
  for (const [, heading] of fs.readFileSync(file, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)) {
    slugs.add(heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-'));
  }
  return slugs;
}

// ============================================================================
// SECTION: Utilities
// ============================================================================

export function loc(text) {
  return text.split('\n').filter((l) => l.trim()).length;
}

// Guarded so the helpers above can be imported and unit-tested without running a full baseline.
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[baseline] ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
