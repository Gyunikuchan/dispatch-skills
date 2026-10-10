import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FileEntry, Inventory } from '../../.agents/skills/optimise-tests/scripts/inventory.ts';

// NOTE: literal dynamic imports keep each leaf test independently failing while a module is absent; tsc still types them.
const loadInventory = () => import('../../.agents/skills/optimise-tests/scripts/inventory.ts');
const loadCompare = () => import('../../.agents/skills/optimise-tests/scripts/compare.ts');

const file = (path: string, unit: string, extra: Partial<FileEntry> = {}): FileEntry => ({
  path, unit, tests: [{ name: `${path} works`, durationMs: 5, line: 1 }], durationMs: 5, lines: 100, imports: [], ...extra,
});

function inventory(files: FileEntry[], extra: Partial<Inventory> = {}): Inventory {
  return {
    totals: { files: files.length, tests: files.reduce((sum, entry) => sum + entry.tests.length, 0), durationMs: 50 },
    files, coverage: {}, candidates: { duplicateTitles: [], sharedImports: [] }, failures: [], ...extra,
  };
}

// SECTION: unitOf

test('unitOf maps a test path to its configured unit folder', async () => {
  const { unitOf } = await loadInventory();
  assert.equal(unitOf('tests/unit/core/frame.test.ts'), 'tests/unit/core');
  assert.equal(unitOf('tests\\tooling\\tooling.test.ts'), 'tests/tooling');
});

test('unitOf returns undefined for a path outside every unit', async () => {
  const { unitOf } = await loadInventory();
  assert.equal(unitOf('tests/helpers/play.ts'), undefined);
});

test('unitOf prefers the longest matching unit', async () => {
  const { unitOf } = await loadInventory();
  assert.equal(unitOf('tests/unit/core/a.test.ts', ['tests/unit', 'tests/unit/core']), 'tests/unit/core');
});

// SECTION: packetize

test('packetize keeps a unit within the line budget in one packet', async () => {
  const { packetize } = await loadInventory();
  const packets = packetize(inventory([file('tests/unit/policy/a.test.ts', 'tests/unit/policy'), file('tests/unit/policy/b.test.ts', 'tests/unit/policy')]), 500);
  assert.deepEqual(packets.map((packet) => [packet.id, packet.files.map((entry) => entry.path)]), [
    ['tests-unit-policy', ['tests/unit/policy/a.test.ts', 'tests/unit/policy/b.test.ts']],
  ]);
});

test('packetize splits a unit over the line budget by file-name prefix cluster', async () => {
  const { packetize } = await loadInventory();
  const unit = 'tests/unit/core';
  const packets = packetize(inventory([
    file(`${unit}/effects-a.test.ts`, unit), file(`${unit}/effects-b.test.ts`, unit),
    file(`${unit}/flow-a.test.ts`, unit), file(`${unit}/flow-b.test.ts`, unit),
  ]), 250);
  assert.deepEqual(packets.map((packet) => [packet.id, packet.lines, packet.files.map((entry) => entry.path)]), [
    ['tests-unit-core-1', 200, [`${unit}/effects-a.test.ts`, `${unit}/effects-b.test.ts`]],
    ['tests-unit-core-2', 200, [`${unit}/flow-a.test.ts`, `${unit}/flow-b.test.ts`]],
  ]);
});

test('packetize lists only tests at or over the slow threshold, slowest first', async () => {
  const { packetize } = await loadInventory();
  const unit = 'tests/tooling';
  const [packet] = packetize(inventory([file(`${unit}/a.test.ts`, unit, {
    tests: [{ name: 'fast', durationMs: 2, line: 3 }, { name: 'slow', durationMs: 120, line: 9 }, { name: 'slower', durationMs: 300, line: 12 }],
  })]), 500, 100);
  assert.deepEqual(packet?.slowestTests.map((entry) => entry.name), ['slower', 'slow']);
});

test('packetize carries baseline failures to the packet that owns the file', async () => {
  const { packetize } = await loadInventory();
  const unit = 'tests/tooling';
  const failure = { file: `${unit}/a.test.ts`, name: 'broken', line: 4 };
  const [packet] = packetize(inventory([file(`${unit}/a.test.ts`, unit)], { failures: [failure, { file: 'tests/e2e/x.test.ts', name: 'other', line: 1 }] }), 500);
  assert.deepEqual(packet?.failures, [failure]);
});

// SECTION: findCandidates

test('findCandidates reports a test title shared by two files with each location', async () => {
  const { findCandidates } = await loadInventory();
  const shared = { name: 'rejects an empty plan', durationMs: 1, line: 4 };
  const { duplicateTitles } = findCandidates([
    file('tests/unit/core/a.test.ts', 'tests/unit/core', { tests: [shared] }),
    file('tests/unit/domain/b.test.ts', 'tests/unit/domain', { tests: [{ ...shared, line: 7 }] }),
  ]);
  assert.deepEqual(duplicateTitles, [{ name: 'rejects an empty plan', files: [
    { path: 'tests/unit/core/a.test.ts', line: 4 }, { path: 'tests/unit/domain/b.test.ts', line: 7 },
  ] }]);
});

test('findCandidates groups test files that import the same production module set', async () => {
  const { findCandidates } = await loadInventory();
  const { sharedImports } = findCandidates([
    file('tests/unit/core/a.test.ts', 'tests/unit/core', { imports: ['skills/dispatch/x.ts', 'skills/dispatch/y.ts'] }),
    file('tests/unit/core/b.test.ts', 'tests/unit/core', { imports: ['skills/dispatch/y.ts', 'skills/dispatch/x.ts'] }),
    file('tests/unit/core/c.test.ts', 'tests/unit/core', { imports: ['skills/dispatch/x.ts'] }),
  ]);
  assert.deepEqual(sharedImports, [{ imports: ['skills/dispatch/x.ts', 'skills/dispatch/y.ts'], files: ['tests/unit/core/a.test.ts', 'tests/unit/core/b.test.ts'] }]);
});

// SECTION: collectFailures

test('collectFailures records a suite hook failure after its leaf tests pass', async () => {
  const { collectFailures } = await loadInventory();
  const at = (name: string, nesting: number, line: number, status: 'pass' | 'fail', suite: boolean) =>
    ({ kind: 'test' as const, status, file: 'tests/tooling/a.test.ts', name, nesting, line, durationMs: 1, suite });
  const failures = collectFailures([at('leaf one', 1, 2, 'pass', false), at('leaf two', 1, 3, 'pass', false), at('suite', 0, 1, 'fail', true)]);
  assert.deepEqual(failures, [{ file: 'tests/tooling/a.test.ts', name: 'suite', line: 1 }]);
});

// SECTION: compare

const before = () => inventory([file('tests/tooling/a.test.ts', 'tests/tooling'), file('tests/tooling/b.test.ts', 'tests/tooling')], {
  coverage: { 'scripts/x.ts': { covered: 40, total: 50 } },
});

test('compare passes and reports totals and per-unit deltas when coverage holds', async () => {
  const { compare } = await loadCompare();
  const after = inventory([file('tests/tooling/a.test.ts', 'tests/tooling')], { coverage: { 'scripts/x.ts': { covered: 40, total: 50 } } });
  const result = compare(before(), after);
  assert.equal(result.ok, true);
  assert.match(result.markdown, /\| total \(wall-clock\) \| 2 → 1 \(-1\) \| 2 → 1 \(-1\) \|/);
  assert.match(result.markdown, /\| tests\/tooling \| 2 → 1 \(-1\) \| 2 → 1 \(-1\) \| 10 → 5 \(-5\) \|/);
});

test('compare fails and lists the file when covered lines drop', async () => {
  const { compare } = await loadCompare();
  const result = compare(before(), inventory([], { coverage: { 'scripts/x.ts': { covered: 39, total: 50 } } }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.coverageDrops, [{ path: 'scripts/x.ts', before: 40, after: 39 }]);
  assert.match(result.markdown, /- scripts\/x\.ts: 40 → 39/);
});

test('compare fails when the after run has failures', async () => {
  const { compare } = await loadCompare();
  const failure = { file: 'tests/tooling/a.test.ts', name: 'breaks', line: 3 };
  const result = compare(before(), inventory([], { coverage: before().coverage, failures: [failure] }));
  assert.equal(result.ok, false);
  assert.match(result.markdown, /- tests\/tooling\/a\.test\.ts:3 breaks/);
});
