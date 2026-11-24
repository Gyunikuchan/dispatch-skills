import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { FileEntry, Inventory } from '../../.agents/skills/optimise-tests/scripts/inventory.ts';
import type { EventLine } from '../../.agents/skills/optimise-tests/scripts/timing-reporter.ts';

// NOTE: literal dynamic imports keep each leaf test independently failing before implementation updates.
const loadInventory = () => import('../../.agents/skills/optimise-tests/scripts/inventory.ts');

const file = (filePath: string, extra: Partial<FileEntry> = {}): FileEntry => ({
  path: filePath, tests: [{ name: `${filePath} works`, durationMs: 5, line: 1 }], durationMs: 5, lines: 100, imports: [], ...extra,
});

function inventory(files: FileEntry[], extra: Partial<Inventory> = {}): Inventory {
  return {
    totals: { files: files.length, tests: files.reduce((sum, entry) => sum + entry.tests.length, 0), durationMs: 50 },
    files,
    coverage: {},
    candidates: { duplicateTitles: [], sharedImports: [], mergeClusters: [], budgetOverruns: [], denseFiles: [], slowestTests: [] },
    failures: [],
    ...extra,
  };
}

// SECTION: Dynamic discovery and before/after deltas

test('discovers tests dynamically and formats before/after deltas without config or ledger', async (t) => {
  const mod = await loadInventory();
  const {
    COVERAGE_INCLUDE, EXCLUDE_FROM_WRITERS, SLOW_TEST_MS, BUDGET_OVERRUN_THRESHOLD_MS, DENSE_FILE_TEST_THRESHOLD,
    discoverTestFiles, buildInventory, withExitStatus, formatDelta,
  } = mod;

  assert.deepEqual(COVERAGE_INCLUDE, ['skills/**/*.ts', 'scripts/**/*.ts', '.agents/skills/**/scripts/**']);
  assert.deepEqual(EXCLUDE_FROM_WRITERS, ['tests/helpers/**', 'tests/fixtures/**', 'tests/unit/*/fixtures/**']);
  assert.equal(SLOW_TEST_MS, 100);
  assert.equal(BUDGET_OVERRUN_THRESHOLD_MS, 800);
  assert.equal(DENSE_FILE_TEST_THRESHOLD, 15);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opt-tests-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writeTest = (rel: string, body = 'test("ok", () => {});\n') => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  };
  writeTest('tests/unit/a.test.ts', "import { x } from '../../skills/dispatch/x.ts';\ntest('fast', () => {});\ntest('slow', () => {});\n");
  writeTest('tests/integration/b.test.ts', 'test("integ", () => {});\n');
  writeTest('tests/helpers/helper.test.ts');
  writeTest('tests/fixtures/fix.test.ts');
  writeTest('tests/unit/lib/fixtures/nested.test.ts');
  writeTest('tests/unit/not-a-test.ts', 'export const x = 1;\n');

  assert.deepEqual(discoverTestFiles(root), ['tests/integration/b.test.ts', 'tests/unit/a.test.ts']);
  assert.deepEqual(discoverTestFiles(root, ['tests/unit']), ['tests/unit/a.test.ts']);
  assert.deepEqual(discoverTestFiles(root, ['tests/helpers']), []);

  const events: EventLine[] = [
    { kind: 'test', status: 'pass', file: 'tests/unit/a.test.ts', name: 'fast', nesting: 0, line: 2, durationMs: 10, suite: false },
    { kind: 'test', status: 'pass', file: 'tests/unit/a.test.ts', name: 'slow', nesting: 0, line: 3, durationMs: 250, suite: false },
    { kind: 'test', status: 'fail', file: 'tests/integration/b.test.ts', name: 'integ', nesting: 0, line: 1, durationMs: 150, suite: false },
    { kind: 'coverage', files: [{ path: 'skills/dispatch/x.ts', covered: 8, total: 10 }] },
    { kind: 'summary', durationMs: 300 },
  ];
  const beforeInv = buildInventory(root, ['tests/integration/b.test.ts', 'tests/unit/a.test.ts'], events);
  assert.equal(beforeInv.totals.files, 2);
  assert.equal(beforeInv.totals.tests, 3);
  assert.equal(beforeInv.totals.durationMs, 300);
  assert.deepEqual(beforeInv.files.map((entry) => entry.path), ['tests/integration/b.test.ts', 'tests/unit/a.test.ts']);
  assert.deepEqual(beforeInv.candidates.slowestTests.map((entry) => entry.name), ['slow', 'integ']);
  assert.deepEqual(beforeInv.failures, [{ file: 'tests/integration/b.test.ts', name: 'integ', line: 1 }]);
  assert.deepEqual(withExitStatus([], 1), [{ file: '', name: 'node --test exited 1', line: 0 }]);
  assert.deepEqual(withExitStatus([], 0), []);

  const afterInv = inventory(
    [file('tests/unit/a.test.ts', { tests: [{ name: 'fast', durationMs: 10, line: 2 }], durationMs: 10, lines: 20 })],
    {
      totals: { files: 1, tests: 1, durationMs: 80 },
      coverage: { 'skills/dispatch/x.ts': { covered: 6, total: 10 } },
      failures: [{ file: 'tests/unit/a.test.ts', name: 'fast', line: 2 }],
    },
  );
  const delta = formatDelta(beforeInv, afterInv);
  assert.match(delta, /2 → 1 \(-1\)/);
  assert.match(delta, /3 → 1 \(-2\)/);
  assert.match(delta, /300 → 80 \(-220\)/);
  assert.match(delta, /tests\/integration\/b\.test\.ts/);
  assert.match(delta, /tests\/unit\/a\.test\.ts/);
  assert.match(delta, /Baseline failures \(1\)/);
  assert.match(delta, /After failures \(1\)/);
  assert.match(delta, /New regressions \(1\)/);
});

// SECTION: findCandidates

test('findCandidates reports a test title shared by two files with each location', async () => {
  const { findCandidates } = await loadInventory();
  const shared = { name: 'rejects an empty plan', durationMs: 1, line: 4 };
  const { duplicateTitles } = findCandidates([
    file('tests/unit/core/a.test.ts', { tests: [shared] }),
    file('tests/unit/domain/b.test.ts', { tests: [{ ...shared, line: 7 }] }),
  ]);
  assert.deepEqual(duplicateTitles, [{ name: 'rejects an empty plan', files: [
    { path: 'tests/unit/core/a.test.ts', line: 4 }, { path: 'tests/unit/domain/b.test.ts', line: 7 },
  ] }]);
});

test('findCandidates groups test files that import the same production module set', async () => {
  const { findCandidates } = await loadInventory();
  const { sharedImports } = findCandidates([
    file('tests/unit/core/a.test.ts', { imports: ['skills/dispatch/x.ts', 'skills/dispatch/y.ts'] }),
    file('tests/unit/core/b.test.ts', { imports: ['skills/dispatch/y.ts', 'skills/dispatch/x.ts'] }),
    file('tests/unit/core/c.test.ts', { imports: ['skills/dispatch/x.ts'] }),
  ]);
  assert.deepEqual(sharedImports, [{ imports: ['skills/dispatch/x.ts', 'skills/dispatch/y.ts'], files: ['tests/unit/core/a.test.ts', 'tests/unit/core/b.test.ts'] }]);
});

test('findCandidates groups 3 or more tests with repetitive prefixes into mergeClusters', async () => {
  const { findCandidates } = await loadInventory();
  const tests = [
    { name: 'rejects invalid id', durationMs: 1, line: 2 },
    { name: 'rejects invalid name', durationMs: 1, line: 4 },
    { name: 'rejects invalid format', durationMs: 1, line: 6 },
    { name: 'rejects valid id', durationMs: 1, line: 8 },
  ];
  const { mergeClusters } = findCandidates([file('tests/unit/core/a.test.ts', { tests })]);
  assert.deepEqual(mergeClusters, [{
    file: 'tests/unit/core/a.test.ts',
    prefix: 'rejects invalid',
    tests: [
      { name: 'rejects invalid id', line: 2 },
      { name: 'rejects invalid name', line: 4 },
      { name: 'rejects invalid format', line: 6 },
    ],
  }]);
});

test('findCandidates identifies files with duration >= 800ms as budgetOverruns', async () => {
  const { findCandidates } = await loadInventory();
  const makeTests = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `test ${i}`, durationMs: 1, line: i + 1 }));
  const slow = file('tests/unit/core/slow.test.ts', { durationMs: 950 });
  const boundary = file('tests/unit/core/boundary.test.ts', { durationMs: 800, tests: makeTests(15) });
  const under = file('tests/unit/core/fast.test.ts', { durationMs: 799, tests: makeTests(3) });
  const dense = file('tests/unit/core/dense.test.ts', { tests: makeTests(16) });
  const veryDense = file('tests/unit/core/very-dense.test.ts', { tests: makeTests(20) });
  const { budgetOverruns, denseFiles } = findCandidates([under, boundary, slow, dense, veryDense]);
  assert.deepEqual(budgetOverruns, [
    { path: 'tests/unit/core/slow.test.ts', durationMs: 950 },
    { path: 'tests/unit/core/boundary.test.ts', durationMs: 800 },
  ]);
  assert.deepEqual(denseFiles, [
    { path: 'tests/unit/core/very-dense.test.ts', testCount: 20 },
    { path: 'tests/unit/core/dense.test.ts', testCount: 16 },
  ]);
});

// SECTION: collectFailures

test('collectFailures records a suite hook failure after its leaf tests pass', async () => {
  const { collectFailures } = await loadInventory();
  const at = (name: string, nesting: number, line: number, status: 'pass' | 'fail', suite: boolean) =>
    ({ kind: 'test' as const, status, file: 'tests/tooling/a.test.ts', name, nesting, line, durationMs: 1, suite });
  const failures = collectFailures([at('leaf one', 1, 2, 'pass', false), at('leaf two', 1, 3, 'pass', false), at('suite', 0, 1, 'fail', true)]);
  assert.deepEqual(failures, [{ file: 'tests/tooling/a.test.ts', name: 'suite', line: 1 }]);
});

// SECTION: Skill contract

test('optimise-tests skill delegates host discovery to Dispatch without static config or ledger', () => {
  const skillRoot = new URL('../../.agents/skills/optimise-tests/', import.meta.url);
  const skill = fs.readFileSync(new URL('SKILL.md', skillRoot), 'utf8');
  for (const required of [
    '../../../skills/dispatch/SKILL.md#routing',
    '../../../skills/dispatch/SKILL.md#launch-and-continue',
    '../../../skills/dispatch/references/templates/quality-bar.md#testing',
    'session init',
    'doctor run --session',
    'launchAs',
    'writeConcurrency',
    'tests/helpers/**',
    'tests/fixtures/**',
    'tests/unit/*/fixtures/**',
    'npm test',
  ]) {
    assert.ok(skill.includes(required), `SKILL.md missing required reference: ${required}`);
  }
  const step2 = skill.slice(skill.indexOf('## 2.'), skill.indexOf('## 3.'));
  assert.match(step2, /If `ok` is `false`.*stop and report the blocker/i);
  assert.match(step2, /Fall back to sequential inline execution[\s\S]*when `ok` is `true` and your host lacks a subagent launch tool/i);
  for (const forbidden of ['| Host |', 'config.json', 'criteria.md', 'compare.ts', 'cccc', 'prune-tests', 'caldoai']) {
    assert.equal(skill.includes(forbidden), false, `SKILL.md must not reference ${forbidden}`);
  }
});
