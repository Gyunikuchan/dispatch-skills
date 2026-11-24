// Zero-config test-suite inventory and before/after delta measurement for optimise-tests.
// Usage: node <skill>/scripts/inventory.ts --out <dir> [--coverage] [--paths <dir,...>] [--compare <before-inventory.json>]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { EventLine, TestLine } from './timing-reporter.ts';

// SECTION: Defaults & types

export const COVERAGE_INCLUDE = ['skills/**/*.ts', 'scripts/**/*.ts', '.agents/skills/**/scripts/**'] as const;
export const EXCLUDE_FROM_WRITERS = ['tests/helpers/**', 'tests/fixtures/**', 'tests/unit/*/fixtures/**'] as const;
export const SLOW_TEST_MS = 100;
export const BUDGET_OVERRUN_THRESHOLD_MS = 800;
export const DENSE_FILE_TEST_THRESHOLD = 15;
const SLOW_TEST_LIMIT = 20;

export interface TestEntry { name: string; durationMs: number; line: number }
export interface FileEntry { path: string; tests: TestEntry[]; durationMs: number; lines: number; imports: string[] }
export interface Failure { file: string; name: string; line: number }
export interface DuplicateTitle { name: string; files: { path: string; line: number }[] }
export interface SharedImports { imports: string[]; files: string[] }
export interface MergeCluster { file: string; prefix: string; tests: { name: string; line: number }[] }
export interface BudgetOverrun { path: string; durationMs: number }
export interface DenseFile { path: string; testCount: number }
export interface SlowTest { file: string; name: string; line: number; durationMs: number }
export interface Candidates {
  duplicateTitles: DuplicateTitle[];
  sharedImports: SharedImports[];
  mergeClusters: MergeCluster[];
  budgetOverruns: BudgetOverrun[];
  denseFiles: DenseFile[];
  slowestTests: SlowTest[];
}
export interface Inventory {
  totals: { files: number; tests: number; durationMs: number };
  files: FileEntry[];
  coverage: Record<string, { covered: number; total: number }>;
  candidates: Candidates;
  failures: Failure[];
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../../..');
const toPosix = (file: string) => file.replace(/\\/g, '/');
const lexicalCompare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

// SECTION: Discovery

const EXCLUDE_PATTERNS = EXCLUDE_FROM_WRITERS.map((glob) => {
  const escaped = glob
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
});

const isExcluded = (relPosix: string): boolean => EXCLUDE_PATTERNS.some((re) => re.test(relPosix));

/** Recursively discovers `*.test.ts` files under `tests/` or `paths`, excluding shared helpers and fixtures. */
export function discoverTestFiles(root: string, paths?: readonly string[]): string[] {
  const targets = paths?.length ? paths : ['tests'];
  const out = new Set<string>();
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith('.test.ts')) {
        const rel = toPosix(path.relative(root, path.join(dir, entry.name)));
        if (!isExcluded(rel)) out.add(rel);
      }
    }
  };
  for (const raw of targets) {
    const clean = toPosix(raw.trim()).replace(/\/+$/, '');
    if (!clean) continue;
    const resolved = path.isAbsolute(clean) ? clean : path.resolve(root, clean);
    if (!fs.existsSync(resolved)) continue;
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) walk(resolved);
    else if (stat.isFile() && resolved.endsWith('.test.ts')) {
      const rel = toPosix(path.relative(root, resolved));
      if (!rel.startsWith('..') && !isExcluded(rel)) out.add(rel);
    }
  }
  return [...out].sort(lexicalCompare);
}

// SECTION: Analysis

const importSet = (file: FileEntry) => [...new Set(file.imports)].sort();

function clusterPrefixOf(name: string): string | undefined {
  const trimmed = name.trim();
  const colon = trimmed.indexOf(':');
  if (colon > 0 && colon < 30) {
    const head = trimmed.slice(0, colon).trim().toLowerCase();
    const words = trimmed.slice(colon + 1).trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2) return `${head}: ${words[0]!.toLowerCase()} ${words[1]!.toLowerCase()}`;
    if (words[0]) return `${head}: ${words[0]!.toLowerCase()}`;
    return head;
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.length >= 2 ? `${words[0]!.toLowerCase()} ${words[1]!.toLowerCase()}` : undefined;
}

export function findCandidates(files: readonly FileEntry[], slowTestMs: number = SLOW_TEST_MS): Candidates {
  const titles = new Map<string, { path: string; line: number }[]>();
  for (const file of files) {
    for (const test of file.tests) titles.set(test.name, [...(titles.get(test.name) ?? []), { path: file.path, line: test.line }]);
  }
  const duplicateTitles = [...titles].filter(([, at]) => at.length > 1).map(([name, at]) => ({ name, files: at }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const groups = new Map<string, SharedImports>();
  for (const file of files) {
    const imports = importSet(file);
    if (!imports.length) continue;
    const key = imports.join('\n');
    const group = groups.get(key) ?? { imports, files: [] };
    group.files.push(file.path);
    groups.set(key, group);
  }
  const sharedImports = [...groups.values()].filter((group) => group.files.length > 1)
    .sort((a, b) => (a.files[0] ?? '').localeCompare(b.files[0] ?? ''));

  const mergeClusters: MergeCluster[] = [];
  for (const file of files) {
    const byPrefix = new Map<string, { name: string; line: number }[]>();
    for (const test of file.tests) {
      const prefix = clusterPrefixOf(test.name);
      if (!prefix) continue;
      const list = byPrefix.get(prefix) ?? [];
      list.push({ name: test.name, line: test.line });
      byPrefix.set(prefix, list);
    }
    for (const [prefix, clusterTests] of byPrefix) {
      if (clusterTests.length >= 3) mergeClusters.push({ file: file.path, prefix, tests: clusterTests });
    }
  }
  mergeClusters.sort((a, b) => a.file.localeCompare(b.file) || a.prefix.localeCompare(b.prefix));

  const budgetOverruns: BudgetOverrun[] = files
    .filter((file) => file.durationMs >= BUDGET_OVERRUN_THRESHOLD_MS)
    .map((file) => ({ path: file.path, durationMs: file.durationMs }))
    .sort((a, b) => b.durationMs - a.durationMs || a.path.localeCompare(b.path));

  const denseFiles: DenseFile[] = files
    .filter((file) => file.tests.length > DENSE_FILE_TEST_THRESHOLD)
    .map((file) => ({ path: file.path, testCount: file.tests.length }))
    .sort((a, b) => b.testCount - a.testCount || a.path.localeCompare(b.path));

  const slowestTests: SlowTest[] = files
    .flatMap((file) => file.tests.map((test) => ({ file: file.path, ...test })))
    .filter((test) => test.durationMs >= slowTestMs)
    .sort((a, b) => b.durationMs - a.durationMs || a.file.localeCompare(b.file) || a.line - b.line)
    .slice(0, SLOW_TEST_LIMIT);

  return { duplicateTitles, sharedImports, mergeClusters, budgetOverruns, denseFiles, slowestTests };
}

// SECTION: Collection

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

/** Extracts production modules a test imports: relative specifiers resolving outside `tests/`. */
export function productionImports(file: string, text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? '';
    if (!specifier.startsWith('.')) continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(toPosix(file)), specifier));
    if (!resolved.startsWith('tests/') && !resolved.startsWith('../')) found.add(resolved);
  }
  return [...found].sort();
}

// Failed leaf tests, plus failed suites with no failed descendant leaf (e.g. a suite hook that fails after its tests pass).
// NOTE: node reports a suite after its descendants, so they are the contiguous deeper events just before it in the same file.
export function collectFailures(tests: readonly TestLine[], rel: (file: string) => string = toPosix): Failure[] {
  const failed = tests.filter((event, index) => {
    if (event.status !== 'fail') return false;
    if (!event.suite) return true;
    for (let at = index - 1; at >= 0; at--) {
      const prior = tests[at];
      if (!prior || prior.file !== event.file) continue;
      if (prior.nesting <= event.nesting) break;
      if (prior.status === 'fail' && !prior.suite) return false;
    }
    return true;
  });
  return failed.map((event) => ({ file: rel(event.file), name: event.name, line: event.line }));
}

// A nonzero test-run exit with no recorded failure still marks the snapshot failed.
export function withExitStatus(failures: readonly Failure[], status: number | null, signal: string | null = null): Failure[] {
  if (status === 0 || failures.length) return [...failures];
  return [{ file: '', name: `node --test exited ${status ?? signal ?? 'abnormally'}`, line: 0 }];
}

export function buildInventory(root: string, testFiles: readonly string[], events: readonly EventLine[]): Inventory {
  const rel = (file: string) => toPosix(path.isAbsolute(file) ? path.relative(root, file) : file);
  const tests = events.filter((event): event is TestLine => event.kind === 'test');
  const files: FileEntry[] = testFiles.map((file) => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const own = tests.filter((event) => rel(event.file) === file);
    return {
      path: file,
      tests: own.filter((event) => !event.suite).map(({ name, durationMs, line }) => ({ name, durationMs, line })),
      // NOTE: a file's top-level tests run serially, so their summed durations approximate its wall time.
      durationMs: own.filter((event) => event.nesting === 0).reduce((sum, event) => sum + event.durationMs, 0),
      lines: text.split('\n').length,
      imports: productionImports(file, text),
    };
  });
  const coverage: Inventory['coverage'] = {};
  for (const event of events) {
    if (event.kind !== 'coverage') continue;
    for (const file of event.files) coverage[rel(file.path)] = { covered: file.covered, total: file.total };
  }
  const summary = events.find((event) => event.kind === 'summary');
  return {
    totals: { files: files.length, tests: files.reduce((sum, file) => sum + file.tests.length, 0), durationMs: summary?.kind === 'summary' ? summary.durationMs : 0 },
    files,
    coverage,
    candidates: findCandidates(files),
    failures: collectFailures(tests, rel),
  };
}

// SECTION: Delta formatting

const signed = (value: number) => (value > 0 ? `+${value}` : String(value));
const cell = (before: number, after: number) => `${before} → ${after} (${signed(after - before)})`;
const failureKey = (failure: Failure) => `${failure.file}\u0000${failure.name}`;
const formatFailure = (failure: Failure) => `- ${failure.file ? `${failure.file}:${failure.line}` : '(run)'} ${failure.name}`;

/** Formats measured before/after inventory totals, file changes, failures, and informational coverage changes. */
export function formatDelta(before: Inventory, after: Inventory): string {
  const lines = [
    '| Scope | Files | Tests | Duration (ms) |',
    '| --- | --- | --- | --- |',
    `| total (wall-clock) | ${cell(before.totals.files, after.totals.files)} | ${cell(before.totals.tests, after.totals.tests)} | ${cell(Math.round(before.totals.durationMs), Math.round(after.totals.durationMs))} |`,
  ];

  const beforeFiles = new Map(before.files.map((file) => [file.path, file]));
  const afterFiles = new Map(after.files.map((file) => [file.path, file]));
  const allPaths = [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].sort(lexicalCompare);
  const fileChanges: string[] = [];
  for (const filePath of allPaths) {
    const prev = beforeFiles.get(filePath);
    const next = afterFiles.get(filePath);
    if (prev && !next) {
      fileChanges.push(`- ${filePath}: ${prev.tests.length} → 0 tests (-${prev.tests.length}), ${Math.round(prev.durationMs)} → 0 ms (-${Math.round(prev.durationMs)})`);
    } else if (!prev && next) {
      fileChanges.push(`+ ${filePath}: 0 → ${next.tests.length} tests (+${next.tests.length}), 0 → ${Math.round(next.durationMs)} ms (+${Math.round(next.durationMs)})`);
    } else if (prev && next) {
      const prevMs = Math.round(prev.durationMs);
      const nextMs = Math.round(next.durationMs);
      if (prev.tests.length !== next.tests.length || prev.lines !== next.lines || prevMs !== nextMs) {
        fileChanges.push(`~ ${filePath}: tests ${cell(prev.tests.length, next.tests.length)}, lines ${cell(prev.lines, next.lines)}, duration ${cell(prevMs, nextMs)} ms`);
      }
    }
  }
  lines.push('', '## File changes', ...(fileChanges.length ? fileChanges : ['None.']));

  const beforeFailKeys = new Set(before.failures.map(failureKey));
  const afterFailKeys = new Set(after.failures.map(failureKey));
  const newRegressions = after.failures.filter((failure) => !beforeFailKeys.has(failureKey(failure)));
  const resolved = before.failures.filter((failure) => !afterFailKeys.has(failureKey(failure)));
  const persisting = after.failures.filter((failure) => beforeFailKeys.has(failureKey(failure)));

  lines.push(
    '',
    '## Failures',
    `Baseline failures (${before.failures.length}):`,
    ...(before.failures.length ? before.failures.map(formatFailure) : ['None.']),
    `After failures (${after.failures.length}):`,
    ...(after.failures.length ? after.failures.map(formatFailure) : ['None.']),
    `New regressions (${newRegressions.length}):`,
    ...(newRegressions.length ? newRegressions.map(formatFailure) : ['None.']),
    `Resolved baseline failures (${resolved.length}):`,
    ...(resolved.length ? resolved.map(formatFailure) : ['None.']),
    `Persisting baseline failures (${persisting.length}):`,
    ...(persisting.length ? persisting.map(formatFailure) : ['None.']),
  );

  const covPaths = [...new Set([...Object.keys(before.coverage), ...Object.keys(after.coverage)])].sort(lexicalCompare);
  if (covPaths.length) {
    const covChanges = covPaths.flatMap((filePath) => {
      const prev = before.coverage[filePath]?.covered ?? 0;
      const next = after.coverage[filePath]?.covered ?? 0;
      return prev === next ? [] : [`- ${filePath}: ${prev} → ${next} (${signed(next - prev)})`];
    });
    lines.push('', '## Coverage (informational)', ...(covChanges.length ? covChanges : ['Unchanged.']));
  }

  return `${lines.join('\n')}\n`;
}

// SECTION: CLI

const USAGE = 'usage: node <skill>/scripts/inventory.ts --out <dir> [--coverage] [--paths <dir,...>] [--compare <before-inventory.json>]';

export function main(argv: string[]): number {
  let values: { out?: string | undefined; coverage?: boolean | undefined; paths?: string | undefined; compare?: string | undefined };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { out: { type: 'string' }, coverage: { type: 'boolean' }, paths: { type: 'string' }, compare: { type: 'string' } },
      strict: true,
    }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 1;
  }
  if (!values.out) { process.stderr.write(`missing --out\n${USAGE}\n`); return 1; }

  let beforeInventory: Inventory | undefined;
  if (values.compare) {
    try {
      beforeInventory = JSON.parse(fs.readFileSync(path.resolve(values.compare), 'utf8')) as Inventory;
    } catch (error) {
      process.stderr.write(`unreadable --compare ${values.compare}: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  const selectedPaths = values.paths ? values.paths.split(',').map((item) => item.trim()).filter(Boolean) : undefined;
  const testFiles = discoverTestFiles(REPO_ROOT, selectedPaths);
  if (!testFiles.length) { process.stderr.write(`no test files found\n`); return 1; }

  const out = path.resolve(values.out);
  const eventsPath = path.join(out, 'events.jsonl');
  fs.mkdirSync(out, { recursive: true });
  fs.rmSync(eventsPath, { force: true });

  const args = [
    '--test', '--test-concurrency=8',
    '--import=./tests/helpers/isolated-temp.ts', '--import=./tests/helpers/block-spawn.ts',
    `--test-reporter=./${toPosix(path.relative(REPO_ROOT, path.join(SCRIPT_DIR, 'timing-reporter.ts')))}`,
    ...(values.coverage ? ['--experimental-test-coverage', ...COVERAGE_INCLUDE.map((glob) => `--test-coverage-include=${glob}`)] : []),
    ...testFiles,
  ];
  // NOTE: a nonzero exit is recorded as a failure, not fatal; the events file records which tests failed.
  const run = spawnSync(process.execPath, args, { cwd: REPO_ROOT, env: { ...process.env, OPTIMISE_TESTS_OUT: eventsPath }, stdio: 'inherit' });
  if (run.error || !fs.existsSync(eventsPath)) {
    process.stderr.write(`test run produced no events (${run.error?.message ?? `exit ${String(run.status)}`})\n`);
    return 1;
  }
  const events = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as EventLine);
  const inventory = buildInventory(REPO_ROOT, testFiles, events);
  inventory.failures = withExitStatus(inventory.failures, run.status, run.signal);
  fs.writeFileSync(path.join(out, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);

  process.stdout.write(
    `inventory: ${inventory.totals.files} files, ${inventory.totals.tests} tests, ${inventory.failures.length} failures, `
    + `${Object.keys(inventory.coverage).length} covered files -> ${toPosix(path.relative(process.cwd(), out)) || '.'}\n`,
  );

  if (beforeInventory) {
    const delta = formatDelta(beforeInventory, inventory);
    const deltaPath = path.join(out, 'delta.md');
    fs.writeFileSync(deltaPath, delta);
    process.stdout.write(
      `delta: files ${cell(beforeInventory.totals.files, inventory.totals.files)}, `
      + `tests ${cell(beforeInventory.totals.tests, inventory.totals.tests)}, `
      + `duration ${cell(Math.round(beforeInventory.totals.durationMs), Math.round(inventory.totals.durationMs))} ms, `
      + `failures ${cell(beforeInventory.failures.length, inventory.failures.length)} -> ${toPosix(path.relative(process.cwd(), deltaPath))}\n`,
    );
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
