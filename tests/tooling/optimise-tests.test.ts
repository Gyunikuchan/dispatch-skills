import assert from 'node:assert/strict';
import path from 'node:path';
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

test('unitOf maps only configured test tiers across path separators', async () => {
  const { unitOf } = await loadInventory();
  for (const [input, expected] of [
    ['tests/unit/core/frame.test.ts', 'tests/unit/core'],
    ['tests\\tooling\\tooling.test.ts', 'tests/tooling'],
    ['tests/helpers/play.ts', undefined],
  ] as const) assert.equal(unitOf(input), expected, input);
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

test('packetize scopes mergeClusters to the packet that owns the file', async () => {
  const { packetize } = await loadInventory();
  const unit = 'tests/tooling';
  const cluster = { file: `${unit}/a.test.ts`, prefix: 'rejects invalid', tests: [{ name: 'rejects invalid id', line: 2 }] };
  const [packet] = packetize(inventory([file(`${unit}/a.test.ts`, unit)], {
    candidates: { duplicateTitles: [], sharedImports: [], mergeClusters: [cluster, { file: 'tests/e2e/other.test.ts', prefix: 'runs', tests: [] }] },
  }), 500);
  assert.deepEqual(packet?.candidates.mergeClusters, [cluster]);
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

test('findCandidates groups 3 or more tests with repetitive prefixes into mergeClusters', async () => {
  const { findCandidates } = await loadInventory();
  const tests = [
    { name: 'rejects invalid id', durationMs: 1, line: 2 },
    { name: 'rejects invalid name', durationMs: 1, line: 4 },
    { name: 'rejects invalid format', durationMs: 1, line: 6 },
    { name: 'rejects valid id', durationMs: 1, line: 8 },
  ];
  const { mergeClusters } = findCandidates([file('tests/unit/core/a.test.ts', 'tests/unit/core', { tests })]);
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
  assert.deepEqual(result.coverageDrops, [{ path: 'scripts/x.ts', before: 40, after: 39, justified: false, reason: undefined }]);
  assert.match(result.markdown, /- scripts\/x\.ts: 40 → 39/);
});

test('compare evaluates ledger justification rules across representative branches', async () => {
  const { compare } = await loadCompare();
  const beforeInv = inventory([file('tests/tooling/a.test.ts', 'tests/tooling')], {
    coverage: { 'scripts/x.ts': { covered: 40, total: 50 } },
  });
  const afterInv = inventory([file('tests/tooling/a.test.ts', 'tests/tooling')], {
    coverage: { 'scripts/x.ts': { covered: 38, total: 50 } },
  });
  const zeroInv = inventory([], {
    coverage: { 'scripts/x.ts': { covered: 0, total: 50 } },
  });

  const cases = [
    {
      name: 'approved drop with low-signal reason and matching target',
      after: afterInv,
      ledger: [{ action: 'delete', file: 'tests/tooling/a.test.ts', test: 't', target: 'scripts/x.ts', reason: 'low-signal: defensive-boilerplate' }],
      expectedOk: true,
      expectedApproved: 1,
      expectedDrops: 0,
    },
    {
      name: 'approved drop with coveredBy and matching target',
      after: afterInv,
      ledger: [{ action: 'delete', file: 'tests/tooling/a.test.ts', test: 't', target: 'scripts/x.ts', coveredBy: 'tests/unit/core.test.ts:works' }],
      expectedOk: true,
      expectedApproved: 1,
      expectedDrops: 0,
    },
    {
      name: 'rejected when file drops to zero coverage even with valid ledger',
      after: zeroInv,
      ledger: [{ action: 'delete', file: 'tests/tooling/a.test.ts', test: 't', target: 'scripts/x.ts', reason: 'low-signal: defensive-boilerplate' }],
      expectedOk: false,
      expectedApproved: 0,
      expectedDrops: 1,
    },
    {
      name: 'rejected when reason is not a low-signal category without coveredBy',
      after: afterInv,
      ledger: [{ action: 'delete', file: 'tests/tooling/a.test.ts', test: 't', target: 'scripts/x.ts', reason: 'asserts a config literal' }],
      expectedOk: false,
      expectedApproved: 0,
      expectedDrops: 1,
    },
    {
      name: 'rejected when action is move',
      after: afterInv,
      ledger: [{ action: 'move', file: 'tests/tooling/a.test.ts', test: 't', target: 'scripts/x.ts', moveTo: 'b.test.ts', reason: 'low-signal: defensive-boilerplate' }],
      expectedOk: false,
      expectedApproved: 0,
      expectedDrops: 1,
    },
    {
      name: 'rejected when target is missing even if reason mentions path',
      after: afterInv,
      ledger: [{ action: 'delete', file: 'tests/tooling/a.test.ts', test: 't', reason: 'low-signal: micro-permutation in scripts/x.ts' }],
      expectedOk: false,
      expectedApproved: 0,
      expectedDrops: 1,
    },
  ];

  for (const c of cases) {
    const result = compare(beforeInv, c.after, c.ledger);
    assert.equal(result.ok, c.expectedOk, `${c.name}: ok`);
    assert.equal(result.approvedDrops?.length ?? 0, c.expectedApproved, `${c.name}: approvedDrops`);
    assert.equal(result.coverageDrops.length, c.expectedDrops, `${c.name}: coverageDrops`);
  }
});

test('compare approves drop only when ledger entry explicitly targets the production file', async () => {
  const { compare } = await loadCompare();
  const beforeInv = inventory([file('tests/tooling/a.test.ts', 'tests/tooling')], {
    coverage: { 'scripts/x.ts': { covered: 40, total: 50 }, 'scripts/y.ts': { covered: 30, total: 50 } },
  });
  const afterInv = inventory([file('tests/tooling/a.test.ts', 'tests/tooling')], {
    coverage: { 'scripts/x.ts': { covered: 38, total: 50 }, 'scripts/y.ts': { covered: 28, total: 50 } },
  });
  // Ledger only targets scripts/x.ts; scripts/y.ts drop must not be approved
  const ledger = [
    { action: 'delete', file: 'tests/tooling/a.test.ts', test: 'test x', target: 'scripts/x.ts', reason: 'low-signal: defensive-boilerplate' },
  ];
  const result = compare(beforeInv, afterInv, ledger);
  assert.equal(result.ok, false);
  assert.equal(result.approvedDrops?.length, 1);
  assert.equal(result.approvedDrops?.[0]?.path, 'scripts/x.ts');
  assert.equal(result.coverageDrops.length, 1);
  assert.equal(result.coverageDrops[0]?.path, 'scripts/y.ts');
});

test('compare fails when the after run has failures', async () => {
  const { compare } = await loadCompare();
  const failure = { file: 'tests/tooling/a.test.ts', name: 'breaks', line: 3 };
  const result = compare(before(), inventory([], { coverage: before().coverage, failures: [failure] }));
  assert.equal(result.ok, false);
  assert.match(result.markdown, /- tests\/tooling\/a\.test\.ts:3 breaks/);
});

test('readLedger loads entries from directory, sorts files deterministically, and warns on malformed lines or invalid entries', async () => {
  const { readLedger } = await loadCompare();
  const warnings: string[] = [];
  const fakeFs = {
    existsSync: (_p: string) => true,
    statSync: (_p: string) => ({ isDirectory: () => true }),
    readdirSync: (_p: string) => ['b.jsonl', 'a.jsonl', 'notes.txt'],
    readFileSync: (p: string) => {
      if (p.endsWith('a.jsonl')) return '{"action":"delete","file":"a.ts","test":"t1","reason":"low-signal: micro-permutation"}\nnot-json\nnull\n{"action":"delete","target":123}\n';
      if (p.endsWith('b.jsonl')) return '{"action":"delete","file":"b.ts","test":"t2","reason":"low-signal: micro-permutation"}\n';
      return '';
    },
  };
  const entries = readLedger('/virtual/ledger', { write: (msg: string) => warnings.push(msg) }, fakeFs);
  assert.deepEqual(entries.map((e: { file: string }) => e.file), ['a.ts', 'b.ts']);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0] ?? '', /ledger warning: a\.jsonl:2 malformed JSON line/);
  assert.match(warnings[1] ?? '', /ledger warning: a\.jsonl:3 invalid ledger entry/);
  assert.match(warnings[2] ?? '', /ledger warning: a\.jsonl:4 invalid ledger entry/);
});

test('readLedger parses a single file path without directory scan', async () => {
  const { readLedger } = await loadCompare();
  const fakeFs = {
    existsSync: (_p: string) => true,
    statSync: (_p: string) => ({ isDirectory: () => false }),
    readdirSync: (_p: string) => { throw new Error('should not call readdir on single file'); },
    readFileSync: (_p: string) => '{"action":"delete","file":"single.ts","test":"t1","target":"x.ts","reason":"low-signal: synthetic-unit"}\n',
  };
  const entries = readLedger('/virtual/single.jsonl', { write: () => {} }, fakeFs);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.file, 'single.ts');
});

test('main exits 0 for approved drops and 1 for unapproved drops or invalid arguments', async () => {
  const { main } = await loadCompare();
  const beforeJson = JSON.stringify(inventory([], { coverage: { 'scripts/x.ts': { covered: 40, total: 50 } } }));
  const afterJson = JSON.stringify(inventory([], { coverage: { 'scripts/x.ts': { covered: 35, total: 50 } } }));
  const ledgerContent = '{"action":"delete","file":"a.test.ts","test":"t1","target":"scripts/x.ts","reason":"low-signal: micro-permutation"}\n';

  const fakeFs = {
    existsSync: (_p: string) => true,
    statSync: (_p: string) => ({ isDirectory: () => false }),
    readdirSync: (_p: string) => [],
    readFileSync: (p: string) => {
      if (p.includes('before.json')) return beforeJson;
      if (p.includes('after.json')) return afterJson;
      if (p.includes('ledger.jsonl')) return ledgerContent;
      return '';
    },
  };

  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = { write: (s: string) => stdout.push(s) };
  const err = { write: (s: string) => stderr.push(s) };

  // Approved with ledger
  const exitCodeApproved = main(['before.json', 'after.json', '--ledger', 'ledger.jsonl'], out, err, fakeFs);
  assert.equal(exitCodeApproved, 0);
  assert.match(stdout.join(''), /Approved coverage drops/);

  // Unapproved without ledger
  stdout.length = 0;
  const exitCodeUnapproved = main(['before.json', 'after.json'], out, err, fakeFs);
  assert.equal(exitCodeUnapproved, 1);
  assert.match(stdout.join(''), /Coverage drops \(covered lines\):/);

  // Invalid arguments
  const exitCodeInvalid = main(['only-one-arg'], out, err, fakeFs);
  assert.equal(exitCodeInvalid, 1);
  assert.match(stderr.join(''), /usage:/);
});
