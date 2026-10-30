import assert from 'node:assert/strict';
import fs from 'node:fs';
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

type TestReference = { file: string; name: string; line?: number };
type ActionEvidence = {
  kind: 'action'; id: string; action: string; before: TestReference[]; after: TestReference[];
  reason: string; category?: string;
};

const ref = (file: string, name: string, line?: number): TestReference => ({ file, name, ...(line === undefined ? {} : { line }) });
const action = (id: string, kind: string, before: TestReference[], after: TestReference[], reason: string, category?: string): ActionEvidence => ({
  kind: 'action', id, action: kind, before, after, reason, ...(category === undefined ? {} : { category }),
});
const retain = (before: TestReference[], after: TestReference[], extra: Record<string, unknown> = {}) => ({
  kind: 'retain',
  contract: 'The public cleanup evidence parser accepts valid evidence and rejects unsupported evidence.',
  plausibleDefect: 'A test classification can be omitted or point to an absent test.',
  observableOutcome: 'The comparison result reports whether all tests have valid evidence.',
  distinctContribution: 'This scenario covers the test inventory classification boundary.',
  before,
  after,
  ...extra,
});

const isRecordForTest = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// SECTION: unitOf

test('unitOf maps only configured test tiers across path separators', async () => {
  const { unitOf } = await loadInventory();
  const config = JSON.parse(fs.readFileSync(new URL('../../.agents/skills/optimise-tests/config.json', import.meta.url), 'utf8')) as { units: string[] };
  for (const unit of config.units) {
    assert.equal(unitOf(`${unit}/example.test.ts`), unit);
    assert.equal(unitOf(`${unit}/example.test.ts`.replaceAll('/', '\\')), unit);
  }
  assert.equal(unitOf('tests/helpers/play.ts'), undefined);
  assert.equal(unitOf('unknown/example.test.ts'), undefined);
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
  const beforeInv = before();
  const keep = ref('tests/tooling/a.test.ts', 'tests/tooling/a.test.ts works', 1);
  const removed = ref('tests/tooling/b.test.ts', 'tests/tooling/b.test.ts works', 1);
  const ledger = [
    retain([keep], [keep]),
    action('remove-placeholder', 'delete', [removed], [], 'No required contract exists for this placeholder scenario.', 'synthetic/no-required-contract'),
  ];
  const result = compare(beforeInv, after, ledger);
  assert.equal(result.ok, true);
  assert.match(result.markdown, /\| total \(wall-clock\) \| 2 → 1 \(-1\) \| 2 → 1 \(-1\) \|/);
  assert.match(result.markdown, /\| tests\/tooling \| 2 → 1 \(-1\) \| 2 → 1 \(-1\) \| 10 → 5 \(-5\) \|/);
});

test('comparison accepts justified pruning despite coverage loss', async () => {
  const { compare } = await loadCompare();
  const beforeInv = before();
  const after = inventory([]);
  const ledger = beforeInv.files.map((entry, index) => action(`remove-${index}`, 'delete', [ref(entry.path, entry.tests[0]!.name, entry.tests[0]!.line)], [],
    'No required contract exists for this synthetic placeholder scenario.', 'synthetic/no-required-contract'));
  const result = compare(beforeInv, after, ledger);
  assert.equal(result.ok, true, result.markdown);
  assert.equal(result.coverageDrops.length, 1);
  assert.equal(result.coverageDrops[0]?.path, 'scripts/x.ts');
  assert.equal(result.coverageDrops[0]?.before, 40);
  assert.equal(result.coverageDrops[0]?.after, 0);
  assert.match(result.markdown, /- scripts\/x\.ts: 40 → 0/);
});

test('comparison enforces retained scenario mappings', async () => {
  const { compare } = await loadCompare();
  const filePath = 'tests/tooling/scenario.test.ts';
  const stable = ref(filePath, 'stable contract scenario', 10);
  const hollow = ref(filePath, 'unrequired synthetic scenario', 20);
  const beforeInv = inventory([file(filePath, 'tests/tooling', { tests: [
    { name: stable.name, line: stable.line!, durationMs: 2 },
    { name: hollow.name, line: hollow.line!, durationMs: 1 },
  ] })]);
  const afterInv = inventory([file(filePath, 'tests/tooling', { tests: [
    { name: stable.name, line: 11, durationMs: 2 },
  ] })]);
  const retained = retain([stable], [ref(filePath, stable.name, 11)]);
  const hollowDelete = action('delete-hollow', 'delete', [hollow], [], 'No required contract exists for this synthetic placeholder scenario.', 'synthetic/no-required-contract');
  const validLedger = [retained, hollowDelete];
  const validHollowDeletion = compare(beforeInv, afterInv, validLedger);
  assert.equal(validHollowDeletion.ok, true, validHollowDeletion.markdown);

  const sharedBefore = ref(filePath, 'shared behavior one', 30);
  const sharedBeforeTwo = ref(filePath, 'shared behavior two', 31);
  const sharedAfter = ref(filePath, 'shared behavior one', 32);
  const sharedAfterTwo = ref(filePath, 'shared behavior two', 33);
  const sharedInventoryBefore = inventory([file(filePath, 'tests/tooling', { tests: [
    { name: sharedBefore.name, line: sharedBefore.line!, durationMs: 1 },
    { name: sharedBeforeTwo.name, line: sharedBeforeTwo.line!, durationMs: 1 },
  ] })]);
  const sharedInventoryAfter = inventory([file(filePath, 'tests/tooling', { tests: [
    { name: sharedAfter.name, line: sharedAfter.line!, durationMs: 1 },
    { name: sharedAfterTwo.name, line: sharedAfterTwo.line!, durationMs: 1 },
  ] })]);
  const sharedResult = compare(sharedInventoryBefore, sharedInventoryAfter, [retain([sharedBefore, sharedBeforeTwo], [sharedAfter, sharedAfterTwo])]);
  assert.equal(sharedResult.ok, true, sharedResult.markdown);

  const ambiguousBefore = inventory([file(filePath, 'tests/tooling', { tests: [
    { name: 'same reported name', line: 40, durationMs: 1 },
    { name: 'same reported name', line: 41, durationMs: 1 },
  ] })]);
  const ambiguousAfter = inventory([file(filePath, 'tests/tooling', { tests: [
    { name: 'same reported name', line: 42, durationMs: 1 },
    { name: 'same reported name', line: 43, durationMs: 1 },
  ] })]);
  const duplicateAfter = inventory([file(filePath, 'tests/tooling', { tests: [
    { name: 'same reported name', line: 42, durationMs: 1 },
  ] })]);
  const disambiguatedDeletion = compare(ambiguousBefore, duplicateAfter, [
    retain([ref(filePath, 'same reported name', 40)], [ref(filePath, 'same reported name', 42)]),
    action('delete-repeated-title', 'delete', [ref(filePath, 'same reported name', 41)], [ref(filePath, 'same reported name', 42)],
      'The explicitly mapped surviving case detects the same wrong-result defect.', 'redundant-behavior'),
  ]);
  assert.equal(disambiguatedDeletion.ok, true, disambiguatedDeletion.markdown);
  const oldName = ref(filePath, 'old reported name', 50);
  const newName = ref(filePath, 'new reported name', 51);
  const renameBefore = inventory([file(filePath, 'tests/tooling', { tests: [{ name: oldName.name, line: oldName.line!, durationMs: 1 }] })]);
  const renameAfter = inventory([file(filePath, 'tests/tooling', { tests: [{ name: newName.name, line: newName.line!, durationMs: 1 }] })]);
  const newAfter = inventory([file(filePath, 'tests/tooling', { tests: [{ name: 'newly added test', line: 52, durationMs: 1 }] })]);
  const mappedRename = compare(renameBefore, renameAfter, [
    retain([oldName], [newName]), action('rename-scenario', 'rewrite', [oldName], [newName], 'The reported test title changed while the contract stayed the same.'),
  ]);
  assert.equal(mappedRename.ok, true, mappedRename.markdown);
  const addedRef = ref(filePath, 'newly added test', 52);
  const explicitAdd = compare(inventory([]), newAfter, [
    retain([], [addedRef]), action('add-scenario', 'add', [], [addedRef], 'The new scenario covers a newly required contract.'),
  ]);
  assert.equal(explicitAdd.ok, true, explicitAdd.markdown);

  const mergeBeforeOne = ref(filePath, 'first merged scenario', 60);
  const mergeBeforeTwo = ref(filePath, 'second merged scenario', 61);
  const mergeAfter = ref(filePath, 'combined scenario', 62);
  const mergeBeforeInv = inventory([file(filePath, 'tests/tooling', { tests: [
    { name: mergeBeforeOne.name, line: mergeBeforeOne.line!, durationMs: 1 },
    { name: mergeBeforeTwo.name, line: mergeBeforeTwo.line!, durationMs: 1 },
  ] })]);
  const mergeAfterInv = inventory([file(filePath, 'tests/tooling', { tests: [
    { name: mergeAfter.name, line: mergeAfter.line!, durationMs: 1 },
  ] })]);
  const mergeResult = compare(mergeBeforeInv, mergeAfterInv, [
    retain([], [mergeAfter]),
    action('merge-scenarios', 'merge', [mergeBeforeOne, mergeBeforeTwo], [mergeAfter],
      'Both tests detected the same defect and the combined scenario preserves that contract.', 'redundant-behavior'),
  ]);

  const rewriteBefore = ref(filePath, 'rewritten away', 70);
  const rewriteAfter = ref(filePath, 'rewritten survivor', 71);
  const rewriteBeforeInv = inventory([file(filePath, 'tests/tooling', { tests: [{ name: rewriteBefore.name, line: rewriteBefore.line!, durationMs: 1 }] })]);
  const rewriteAfterInv = inventory([file(filePath, 'tests/tooling', { tests: [{ name: rewriteAfter.name, line: rewriteAfter.line!, durationMs: 1 }] })]);
  const unchangedBefore = ref(filePath, 'deleted but still present', 80);
  const unchangedAfter = ref(filePath, 'deleted but still present', 81);
  const unchangedBeforeInv = inventory([file(filePath, 'tests/tooling', { tests: [{ name: unchangedBefore.name, line: unchangedBefore.line!, durationMs: 1 }] })]);
  const unchangedAfterInv = inventory([file(filePath, 'tests/tooling', { tests: [{ name: unchangedAfter.name, line: unchangedAfter.line!, durationMs: 1 }] })]);
  const absorbedBefore = ref(filePath, 'absorbed into unchanged survivor', 82);
  const mergeWithUnchangedBefore = inventory([file(filePath, 'tests/tooling', { tests: [
    { name: unchangedBefore.name, line: unchangedBefore.line!, durationMs: 1 },
    { name: absorbedBefore.name, line: absorbedBefore.line!, durationMs: 1 },
  ] })]);
  const mergeWithUnchangedAfter = unchangedAfterInv;
  const mergeWithUnchangedLedger = [
    retain([], [unchangedAfter]),
    action('merge-still-present', 'merge', [unchangedBefore, absorbedBefore], [unchangedAfter],
      'The unchanged survivor is incorrectly listed among the absorbed tests.', 'redundant-behavior'),
  ];
  const contradictions = [
    { name: 'delete conflicts with another action that maps the same before test to a survivor', before: rewriteBeforeInv, after: rewriteAfterInv, ledger: [
      retain([], [rewriteAfter]),
      action('delete-rewritten-test', 'delete', [rewriteBefore], [], 'This synthetic test has no required contract.', 'synthetic/no-required-contract'),
      action('rewrite-deleted-test', 'rewrite', [rewriteBefore], [rewriteAfter], 'The test was renamed while its contract remained.',),
    ] },
    { name: 'delete conflicts with the same reported identity retained after', before: unchangedBeforeInv, after: unchangedAfterInv, ledger: [
      retain([], [unchangedAfter]),
      action('delete-still-present', 'delete', [unchangedBefore], [], 'This synthetic test has no required contract.', 'synthetic/no-required-contract'),
    ] },
  ];
  const unexpectedOutcomes = [
    ...(mergeResult.ok ? [] : ['merge mapping to a newly named survivor was rejected']),
  ];
  assert.deepEqual(unexpectedOutcomes, [], `action mapping conflicts: ${unexpectedOutcomes.join('; ')}`);

  const cases = [
    { name: 'incomplete classification', before: beforeInv, after: afterInv, ledger: [retained] },
    { name: 'ambiguous reported identity', before: ambiguousBefore, after: ambiguousAfter, ledger: [retain([ref(filePath, 'same reported name')], [ref(filePath, 'same reported name')])] },
    { name: 'renamed test has no explicit mapping action', before: renameBefore, after: renameAfter, ledger: [retain([oldName], [newName])] },
    { name: 'new test has no explicit add action', before: inventory([]), after: newAfter, ledger: [retain([], [ref(filePath, 'newly added test', 52)])] },
    { name: 'merge lists an unchanged survivor among absorbed before members', before: mergeWithUnchangedBefore, after: mergeWithUnchangedAfter, ledger: mergeWithUnchangedLedger },
    { name: 'unsupported deletion category', before: beforeInv, after: afterInv, ledger: [retained, action('bad-category', 'delete', [hollow], [], 'This reason only saves setup time.', 'setup-weight')] },
    { name: 'contradictory deletion and retention', before: beforeInv, after: afterInv, ledger: [...validLedger, action('delete-stable', 'delete', [stable], [], 'No required contract exists for this test.', 'synthetic/no-required-contract')] },
    ...contradictions,
    { name: 'unresolved escalation', before: beforeInv, after: afterInv, ledger: [...validLedger, { kind: 'escalation', reason: 'Required contract remains unclear.' }] },
  ];
  for (const scenario of cases) {
    const result = compare(scenario.before, scenario.after, scenario.ledger);
    assert.equal(result.ok, false, `${scenario.name}: ${result.markdown}`);
    assert.ok(result.evidenceErrors.length > 0, `${scenario.name}: missing evidence diagnostic`);
    assert.match(result.markdown, /Evidence errors:/, scenario.name);
  }
});

test('comparison reports coverage without gating', async () => {
  const { compare } = await loadCompare();
  for (const coverage of [{ 'scripts/x.ts': { covered: 20, total: 50 } }, { 'scripts/x.ts': { covered: 0, total: 50 } }, {}]) {
    const snapshot = before();
    const ledger = snapshot.files.map(entry => retain([ref(entry.path, entry.tests[0]!.name)], [ref(entry.path, entry.tests[0]!.name)]));
    const result = compare(snapshot, inventory(snapshot.files, { coverage }), ledger);
    assert.equal(result.ok, true, result.markdown);
    assert.match(result.markdown, /Coverage changes \(informational\)/);
    assert.equal(result.coverageDrops[0]?.after, coverage['scripts/x.ts']?.covered ?? 0);
  }
});

test('comparison validates deletion categories', async () => {
  const { compare } = await loadCompare();
  const snapshot = before();
  for (const category of ['trivial-spec', 'coverage-padding', 'transient-leak', 'unknown-category']) {
    const ledger = snapshot.files.map((entry, index) => action(`delete-${index}`, 'delete', [ref(entry.path, entry.tests[0]!.name)], [], 'No severe contract is protected by this scaffolding.', category));
    const result = compare(snapshot, inventory([]), ledger);
    assert.equal(result.ok, ['trivial-spec', 'coverage-padding'].includes(category), result.markdown);
  }
});

test('comparison rejects incomplete evidence after pruning', async () => {
  const { compare } = await loadCompare();
  const snapshot = before();
  const kept = ref(snapshot.files[0]!.path, snapshot.files[0]!.tests[0]!.name);
  for (const ledger of [[], [retain([kept], [kept])], ...['contract', 'plausibleDefect', 'observableOutcome', 'distinctContribution'].map(key => [retain([kept], [kept], { [key]: '' })]), [{ kind: 'coverage', target: 'scripts/x.ts' }]]) {
    const result = compare(snapshot, inventory([snapshot.files[0]!]), ledger);
    assert.equal(result.ok, false);
    assert.ok(result.evidenceErrors.length > 0);
  }
});

test('comparison CLI preserves failure exits', async () => {
  const { main } = await loadCompare();
  const filePath = 'tests/tooling/cli.test.ts';
  const stable = ref(filePath, 'stable behavior', 10);
  const beforeInv = inventory([file(filePath, 'tests/tooling', { tests: [{ name: stable.name, line: stable.line!, durationMs: 5 }] })], { coverage: { 'scripts/x.ts': { covered: 40, total: 50 } } });
  const afterInv = inventory([file(filePath, 'tests/tooling', { tests: [{ name: stable.name, line: 11, durationMs: 4 }] })]);
  const retained = retain([stable], [ref(filePath, stable.name, 11)]);
  const savings = {
    kind: 'savings', scenariosRemoved: 1, casesRemoved: 0, cosmeticTableMerges: 1,
    repeatedSetupCallsReduced: 2, evidence: 'Reviewed packet diff shows one removed scenario and two fewer repeated setup calls.',
  };
  const validLedger = [retained, savings];

  const run = (ledgerText?: string, after = afterInv) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const fakeFs = {
      existsSync: (_path: string) => ledgerText !== undefined,
      statSync: (_path: string) => ({ isDirectory: () => false }),
      readdirSync: (_path: string) => [],
      readFileSync: (path: string) => {
        if (path.includes('before.json')) return JSON.stringify(beforeInv);
        if (path.includes('after.json')) return JSON.stringify(after);
        return ledgerText ?? '';
      },
    };
    const out = { write: (value: string) => stdout.push(value) };
    const err = { write: (value: string) => stderr.push(value) };
    const args = ledgerText === undefined ? ['before.json', 'after.json'] : ['before.json', 'after.json', '--ledger', 'ledger.jsonl'];
    return { code: main(args, out, err, fakeFs), stdout: stdout.join(''), stderr: stderr.join('') };
  };

  assert.equal(main(['only-one-arg'], { write: () => {} }, { write: () => {} }), 1);
  assert.equal(main(['before.json', 'after.json', '--unknown'], { write: () => {} }, { write: () => {} }), 1);

  const valid = run(`${validLedger.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  assert.equal(valid.code, 0, valid.stdout + valid.stderr);
  assert.match(valid.stdout, /\| total \(wall-clock\) \|/);
  assert.match(valid.stdout, /Ledger-reported savings \(not measured by inventory\)/);
  assert.match(valid.stdout, /Scenarios removed: 1/);
  assert.match(valid.stdout, /Cases removed: 0/);
  assert.match(valid.stdout, /Cosmetic table merges: 1/);
  assert.match(valid.stdout, /Repeated setup calls reduced: 2/);

  const invalidCases = [
    { name: 'malformed JSON', ledger: `${JSON.stringify(retained)}\nnot-json\n`, after: afterInv },
    { name: 'unknown record kind', ledger: `${JSON.stringify(retained)}\n${JSON.stringify({ kind: 'escalation', reason: 'unresolved' })}\n`, after: afterInv },
    { name: 'missing ledger', ledger: undefined, after: afterInv },
    { name: 'after-run failure', ledger: `${validLedger.map((entry) => JSON.stringify(entry)).join('\n')}\n`, after: inventory(afterInv.files, { failures: [{ file: filePath, name: 'hook failure', line: 1 }] }) },
  ];
  for (const scenario of invalidCases) {
    const result = run(scenario.ledger, scenario.after);
    assert.equal(result.code, 1, `${scenario.name}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, scenario.name === 'after-run failure' ? /After-run failures:/ : /Evidence errors:/, scenario.name);
  }
});

test('compare fails when the after run has failures', async () => {
  const { compare } = await loadCompare();
  const failure = { file: 'tests/tooling/a.test.ts', name: 'breaks', line: 3 };
  const beforeInv = before();
  const after = inventory([], { coverage: beforeInv.coverage, failures: [failure] });
  const ledger = beforeInv.files.map((entry, index) => action(`remove-failed-suite-${index}`, 'delete', [ref(entry.path, entry.tests[0]!.name, entry.tests[0]!.line)], [],
    'No required contract exists for this placeholder test.', 'synthetic/no-required-contract'));
  const result = compare(beforeInv, after, ledger);
  assert.equal(result.ok, false);
  assert.match(result.markdown, /- tests\/tooling\/a\.test\.ts:3 breaks/);
});

test('readLedger preserves malformed rows for comparison diagnostics and sorts files deterministically', async () => {
  const { readLedger } = await loadCompare();
  const fakeFs = {
    existsSync: (_p: string) => true,
    statSync: (_p: string) => ({ isDirectory: () => true }),
    readdirSync: (_p: string) => ['b.jsonl', 'a.jsonl', 'notes.txt'],
    readFileSync: (p: string) => {
      if (p.endsWith('a.jsonl')) return '{"kind":"savings","evidence":"first file"}\nnot-json\nnull\n{"kind":"unknown-record"}\n';
      if (p.endsWith('b.jsonl')) return '{"kind":"savings","evidence":"second file"}\n';
      return '';
    },
  };
  const entries = readLedger('/virtual/ledger', fakeFs);
  assert.deepEqual(entries.map((entry) => isRecordForTest(entry) ? entry['kind'] : entry), ['savings', 'invalid-ledger-line', null, 'unknown-record', 'savings']);
  const result = (await loadCompare()).compare(inventory([]), inventory([]), entries);
  assert.equal(result.ok, false);
  assert.match(result.evidenceErrors.join('\n'), /ledger a\.jsonl:2: malformed JSON line/);
});

test('readLedger parses a single file path without directory scan', async () => {
  const { readLedger } = await loadCompare();
  const fakeFs = {
    existsSync: (_p: string) => true,
    statSync: (_p: string) => ({ isDirectory: () => false }),
    readdirSync: (_p: string) => { throw new Error('should not call readdir on single file'); },
    readFileSync: (_p: string) => '{"kind":"savings","evidence":"single file"}\n',
  };
  const entries = readLedger('/virtual/single.jsonl', fakeFs);
  assert.equal(entries.length, 1);
  assert.equal((entries[0] as { kind: string }).kind, 'savings');
});
