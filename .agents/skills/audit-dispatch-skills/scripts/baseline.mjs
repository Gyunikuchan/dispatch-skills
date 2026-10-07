#!/usr/bin/env node

/**
 * @file baseline.mjs
 * @description Deterministic audit evidence gathered once, before any subagent runs, into the run's work dir:
 *   - manifest.json:          exclusive run reservation, effective settings, budgets and baseline fingerprints;
 *   - git-status.txt:         repo status snapshot (audit output excluded) that finalize.mjs compares against;
 *   - content-snapshot.json:  content hashes that expose edits to already-dirty files and protected local configs;
 *   - tests.txt:              one aggregate `npm test` run;
 *   - metrics.md:             labeled leads: doc token footprint, broken relative links/anchors, skill hash drift.
 * Prints a short digest; the files carry the detail.
 *
 * Usage: node <skill>/scripts/baseline.mjs --run <yyyy-mm-dd-hhmm> [--resume]
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const isMainModule = (url) => !!process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === url;
const measureText = (text) => ({ characters: text.length, estimate: Math.ceil(text.length / 4) });
import { auditGitStatus, contentSnapshot, frontmatterDescription, relTo, resolveRepoRoot, resolveRunDirs } from './shared.mjs';
import { consumeBudget, loadAuditConfig, readRun, reserveRun, updateRun } from './run-state.ts';

// ============================================================================
// SECTION: Configuration
// ============================================================================

const SKIP_DIRS = new Set(['node_modules', '.git', '.scratch', 'worktrees']);
const TEST_TIMEOUT_MS = 10 * 60 * 1000;
const TEST_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const EVIDENCE = ['git-status.txt', 'content-snapshot.json', 'tests.txt', 'metrics.md'];

// ============================================================================
// SECTION: Main
// ============================================================================

export async function main(options = {}) {
  const root = options.root ?? resolveRepoRoot();
  const argv = options.argv ?? process.argv;
  const { runId, workDir, reportPath, rel } = resolveRunDirs(root, argv);
  if (argv.includes('--force')) {
    throw new Error('--force is no longer supported: a baseline is never overwritten. Pass --resume to continue this run, or a new --run id for a fresh run.');
  }
  const revision = gitHead(root);

  // Reservation is exclusive, so a repeated step 1 cannot replace the evidence finalize compares against.
  const manifest = argv.includes('--resume')
    ? readRun(workDir, { revision })
    : reserveRun(workDir, { runId, revision, config: loadAuditConfig() });
  if (manifest.baseline.status === 'complete') {
    process.stdout.write(`Baseline already complete at ${rel(workDir)}; reusing it (tests: ${manifest.baseline.tests?.totals ?? 'unknown'}).\n`);
    return;
  }

  const gaps = [];
  const file = (name) => path.join(workDir, name);
  // Resume keeps any capture already written; only missing evidence is produced.
  if (!fs.existsSync(file('git-status.txt'))) fs.writeFileSync(file('git-status.txt'), auditGitStatus(root) ?? '', 'utf8');
  if (!fs.existsSync(file('content-snapshot.json'))) {
    const snapshot = contentSnapshot(root, { exclude: [rel(workDir), rel(reportPath)] });
    fs.writeFileSync(file('content-snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  }

  let tests = null;
  const budget = consumeBudget(workDir, 'lead', 'baselineTestRuns');
  if (budget.allowed) {
    const result = (options.runTests ?? runTests)(root);
    fs.writeFileSync(file('tests.txt'), result.output, 'utf8');
    tests = { status: result.status ?? null, signal: result.signal ?? null, error: result.error ?? null, totals: result.totals, capture: 'tests.txt' };
  } else {
    gaps.push(`baselineTestRuns budget exhausted (${budget.used}/${budget.limit}); ${fs.existsSync(file('tests.txt')) ? 'kept earlier tests.txt' : 'no test capture'}`);
  }

  if (!fs.existsSync(file('metrics.md'))) {
    const metrics = await (options.buildMetrics ?? buildMetrics)(root);
    fs.writeFileSync(file('metrics.md'), metrics.markdown, 'utf8');
  }

  const fingerprints = Object.fromEntries(
    EVIDENCE.filter((n) => fs.existsSync(file(n))).map((n) => [n, `sha256:${createHash('sha256').update(fs.readFileSync(file(n))).digest('hex')}`]),
  );
  updateRun(workDir, (m) => { m.baseline = { status: 'complete', fingerprints, tests, gaps }; });

  process.stdout.write(
    [
      `Tests: ${tests ? `${tests.totals} (exit ${tests.status})` : 'not run'}`,
      ...gaps.map((g) => `Gap: ${g}`),
      `Wrote ${rel(workDir)}/{manifest.json,${EVIDENCE.join(',')}}`,
    ].join('\n') + '\n',
  );
}

function gitHead(root) {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (res.status !== 0) throw new Error('Cannot read the current revision (git rev-parse HEAD failed).');
  return res.stdout.trim();
}

// ============================================================================
// SECTION: Tests
// ============================================================================

/**
 * Runs the repository's current aggregate `npm test` once through an injectable process port.
 * @param {string} root
 * @param {(cmd: string, args: readonly string[], opts: object) => {stdout?: string, stderr?: string, status: number|null, signal?: string|null, error?: Error}} [spawn]
 */
export function runTests(root, spawn = spawnSync) {
  // NOTE: npm is a .cmd shim on Windows, which spawn can only reach through a shell; argv is fixed.
  const res = spawn('npm', ['test'], {
    cwd: root, encoding: 'utf8', timeout: TEST_TIMEOUT_MS, maxBuffer: TEST_MAX_BUFFER_BYTES, shell: process.platform === 'win32', windowsHide: true,
  });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const summary = output.split(/\r?\n/).filter((l) => /test\(s\)/.test(l)).pop()?.trim();
  return {
    output,
    status: res.status ?? null,
    signal: res.signal ?? null,
    error: res.error ? String(res.error.message ?? res.error) : null,
    totals: summary ?? `exit ${res.status ?? 'none'}`,
  };
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
  ].filter((f) => /\.(?:ts|mjs)$/.test(f));
  const tests = walk(path.join(root, 'tests')).filter((f) => f.endsWith('.test.ts'));

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

  out.push('', '## Scripts', '', '| Script | LOC | SECTION dividers |', '|---|---|---|');
  for (const file of scripts) {
    const text = fs.readFileSync(file, 'utf8');
    out.push(`| ${rel(file)} | ${loc(text)} | ${(text.match(/\/\/ SECTION:/g) ?? []).length} |`);
  }

  out.push('', '## Tests', '', '| Test file | LOC | Cases |', '|---|---|---|');
  for (const file of tests) {
    const text = fs.readFileSync(file, 'utf8');
    out.push(`| ${rel(file)} | ${loc(text)} | ${(text.match(/^\s*(?:it|test)\(/gm) ?? []).length} |`);
  }

  const { checkIntegrity } = await import(pathToFileURL(path.join(root, 'skills/dispatch/scripts/lib/integrity.ts')).href);
  const hashLines = fs.readdirSync(path.join(root, 'skills')).map((dir) => {
    const skillDir = path.join(root, 'skills', dir);
    if (!fs.existsSync(path.join(skillDir, 'skill-hashes.json'))) return `Hashes skills/${dir}: no manifest`;
    const result = checkIntegrity(skillDir);
    return `Hashes skills/${dir}: ${result.status === 'ok' ? 'in sync' : result.status === 'drift' ? `DRIFT in ${result.violations.join(', ')}` : result.warning}`;
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

// ============================================================================
// SECTION: CLI Entry
// ============================================================================

// Guarded so helpers can be imported without running a full baseline.
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[baseline] ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
