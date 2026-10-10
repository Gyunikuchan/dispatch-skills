// Deterministic test-suite inventory for the optimise-tests skill.
// Usage: node <skill>/scripts/inventory.ts --out <dir> [--coverage] [--units <id,...>]
// Runs the selected test files once via `node --test` with timing-reporter.ts, then writes
// <dir>/inventory.json and one <dir>/packets/<id>.json per unit packet. Test failures are recorded, not fatal.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { EventLine, TestLine } from './timing-reporter.ts';

// SECTION: Types

export interface Config {
  units: string[];
  packetLineBudget: number;
  slowTestMs: number;
  maxParallelWriters: number;
  coverageInclude: string[];
  excludeFromWriters: string[];
}
export interface TestEntry { name: string; durationMs: number; line: number }
export interface FileEntry { path: string; unit: string; tests: TestEntry[]; durationMs: number; lines: number; imports: string[] }
export interface Failure { file: string; name: string; line: number }
export interface DuplicateTitle { name: string; files: { path: string; line: number }[] }
export interface SharedImports { imports: string[]; files: string[] }
export interface Candidates { duplicateTitles: DuplicateTitle[]; sharedImports: SharedImports[] }
export interface Inventory {
  totals: { files: number; tests: number; durationMs: number };
  files: FileEntry[];
  coverage: Record<string, { covered: number; total: number }>;
  candidates: Candidates;
  failures: Failure[];
}
export interface SlowTest { file: string; name: string; line: number; durationMs: number }
export interface Packet {
  id: string;
  unit: string;
  lines: number;
  files: { path: string; lines: number; tests: number; durationMs: number }[];
  slowestTests: SlowTest[];
  // Baseline failures in this packet's files; writers leave them unchanged unless the ledger justifies it.
  failures: Failure[];
  candidates: Candidates;
}

// SECTION: Config

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(SCRIPT_DIR);
export const REPO_ROOT = path.resolve(SKILL_DIR, '../../..');
export const CONFIG: Config = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'config.json'), 'utf8')) as Config;
const SLOW_TEST_LIMIT = 20;
const toPosix = (file: string) => file.replace(/\\/g, '/');

// SECTION: Pure analysis

// Longest configured folder that contains the path wins, so nested units never shadow each other.
export function unitOf(file: string, units: readonly string[] = CONFIG.units): string | undefined {
  const posix = toPosix(file);
  return units.filter((unit) => posix.startsWith(`${unit.replace(/\/+$/, '')}/`)).sort((a, b) => b.length - a.length)[0];
}

const importSet = (file: FileEntry) => [...new Set(file.imports)].sort();

export function findCandidates(files: readonly FileEntry[]): Candidates {
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
  return { duplicateTitles, sharedImports };
}

const prefixOf = (file: string) => path.posix.basename(file).replace(/\.test\.ts$/, '').split('-')[0] ?? '';
const slug = (unit: string) => unit.replace(/[\\/]+/g, '-');

function scopeCandidates(candidates: Candidates, paths: ReadonlySet<string>): Candidates {
  return {
    duplicateTitles: candidates.duplicateTitles.filter((entry) => entry.files.some((file) => paths.has(file.path))),
    sharedImports: candidates.sharedImports.filter((entry) => entry.files.some((file) => paths.has(file))),
  };
}

// Splits a unit over the line budget into packets of whole file-name prefix clusters (e.g. effects-*),
// so related files stay together; a cluster over the budget alone is split by file.
export function packetize(inventory: Inventory, budget: number, slowTestMs: number = CONFIG.slowTestMs): Packet[] {
  const byUnit = new Map<string, FileEntry[]>();
  for (const file of inventory.files) byUnit.set(file.unit, [...(byUnit.get(file.unit) ?? []), file]);
  const packets: Packet[] = [];
  for (const [unit, files] of byUnit) {
    const groups: FileEntry[][] = [];
    const total = files.reduce((sum, file) => sum + file.lines, 0);
    if (total <= budget) groups.push(files);
    else {
      const clusters = new Map<string, FileEntry[]>();
      for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
        clusters.set(prefixOf(file.path), [...(clusters.get(prefixOf(file.path)) ?? []), file]);
      }
      let current: FileEntry[] = [];
      let size = 0;
      const flush = () => { if (current.length) groups.push(current); current = []; size = 0; };
      for (const cluster of clusters.values()) {
        const lines = cluster.reduce((sum, file) => sum + file.lines, 0);
        if (lines > budget) {
          flush();
          for (const file of cluster) {
            if (size + file.lines > budget) flush();
            current.push(file);
            size += file.lines;
          }
          flush();
          continue;
        }
        if (size + lines > budget) flush();
        current.push(...cluster);
        size += lines;
      }
      flush();
    }
    groups.forEach((group, index) => {
      const paths = new Set(group.map((file) => file.path));
      const slowestTests = group.flatMap((file) => file.tests.map((test) => ({ file: file.path, ...test })))
        .filter((test) => test.durationMs >= slowTestMs).sort((a, b) => b.durationMs - a.durationMs).slice(0, SLOW_TEST_LIMIT);
      packets.push({
        id: groups.length > 1 ? `${slug(unit)}-${index + 1}` : slug(unit),
        unit,
        lines: group.reduce((sum, file) => sum + file.lines, 0),
        files: group.map((file) => ({ path: file.path, lines: file.lines, tests: file.tests.length, durationMs: file.durationMs })),
        slowestTests,
        failures: inventory.failures.filter((failure) => paths.has(failure.file)),
        candidates: scopeCandidates(inventory.candidates, paths),
      });
    });
  }
  return packets;
}

// SECTION: Collection

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

// Production modules a test imports: relative specifiers that resolve outside tests/.
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

function listTestFiles(root: string, units: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.test.ts')) out.push(toPosix(path.relative(root, full)));
    }
  };
  for (const unit of units) walk(path.join(root, unit));
  return [...new Set(out)].filter((file) => unitOf(file, units) !== undefined).sort();
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

// A nonzero test-run exit with no recorded failure still fails the snapshot, so compare.ts cannot pass it.
export function withExitStatus(failures: readonly Failure[], status: number | null, signal: string | null = null): Failure[] {
  if (status === 0 || failures.length) return [...failures];
  return [{ file: '', name: `node --test exited ${status ?? signal ?? 'abnormally'}`, line: 0 }];
}

export function buildInventory(root: string, testFiles: readonly string[], events: readonly EventLine[], units: readonly string[]): Inventory {
  const rel = (file: string) => toPosix(path.isAbsolute(file) ? path.relative(root, file) : file);
  const tests = events.filter((event): event is TestLine => event.kind === 'test');
  const files: FileEntry[] = testFiles.map((file) => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const own = tests.filter((event) => rel(event.file) === file);
    return {
      path: file,
      unit: unitOf(file, units) ?? '',
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

// SECTION: CLI

const USAGE = 'usage: node <skill>/scripts/inventory.ts --out <dir> [--coverage] [--units <id,...>]';

function main(argv: string[]): number {
  let values: { out?: string | undefined; coverage?: boolean | undefined; units?: string | undefined };
  try {
    ({ values } = parseArgs({ args: argv, options: { out: { type: 'string' }, coverage: { type: 'boolean' }, units: { type: 'string' } }, strict: true }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 1;
  }
  if (!values.out) { process.stderr.write(`missing --out\n${USAGE}\n`); return 1; }
  const selected = values.units ? values.units.split(',').map((unit) => toPosix(unit.trim()).replace(/\/+$/, '')).filter(Boolean) : CONFIG.units;
  const unknown = selected.filter((unit) => !CONFIG.units.includes(unit));
  if (unknown.length) { process.stderr.write(`unknown unit(s): ${unknown.join(', ')}; configured: ${CONFIG.units.join(', ')}\n`); return 1; }

  const out = path.resolve(values.out);
  const eventsPath = path.join(out, 'events.jsonl');
  fs.mkdirSync(out, { recursive: true });
  fs.rmSync(eventsPath, { force: true });
  const testFiles = listTestFiles(REPO_ROOT, selected);
  if (!testFiles.length) { process.stderr.write(`no test files in: ${selected.join(', ')}\n`); return 1; }

  const args = [
    '--test', '--test-concurrency=8',
    '--import=./tests/helpers/isolated-temp.ts', '--import=./tests/helpers/block-spawn.ts',
    `--test-reporter=./${toPosix(path.relative(REPO_ROOT, path.join(SCRIPT_DIR, 'timing-reporter.ts')))}`,
    ...(values.coverage ? ['--experimental-test-coverage', ...CONFIG.coverageInclude.map((glob) => `--test-coverage-include=${glob}`)] : []),
    ...testFiles,
  ];
  // NOTE: a nonzero exit is recorded as a failure, not fatal; the events file records which tests failed.
  const run = spawnSync(process.execPath, args, { cwd: REPO_ROOT, env: { ...process.env, OPTIMISE_TESTS_OUT: eventsPath }, stdio: 'inherit' });
  if (run.error || !fs.existsSync(eventsPath)) {
    process.stderr.write(`test run produced no events (${run.error?.message ?? `exit ${String(run.status)}`})\n`);
    return 1;
  }
  const events = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as EventLine);
  const inventory = buildInventory(REPO_ROOT, testFiles, events, selected);
  inventory.failures = withExitStatus(inventory.failures, run.status, run.signal);
  fs.writeFileSync(path.join(out, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
  const packetDir = path.join(out, 'packets');
  fs.rmSync(packetDir, { recursive: true, force: true });
  fs.mkdirSync(packetDir, { recursive: true });
  const packets = packetize(inventory, CONFIG.packetLineBudget);
  for (const packet of packets) fs.writeFileSync(path.join(packetDir, `${packet.id}.json`), `${JSON.stringify(packet, null, 2)}\n`);
  process.stdout.write(`inventory: ${inventory.totals.files} files, ${inventory.totals.tests} tests, ${inventory.failures.length} failures, `
    + `${Object.keys(inventory.coverage).length} covered files, ${packets.length} packets -> ${toPosix(path.relative(process.cwd(), out)) || '.'}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
