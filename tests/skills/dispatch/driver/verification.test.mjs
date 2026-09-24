import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { makeGitRepo, writePlan } from '../../../helpers/driver-harness.mjs';
import { appendEvent, ensureLedgerNamespace, governingHash } from '../../../../skills/dispatch/scripts/ledger/ledger.mjs';
import { resolveLedgerPath } from '../../../../skills/dispatch/scripts/artifacts/resolve-paths.mjs';
import { persistEvidence, restoreEvidence } from '../../../../skills/dispatch/scripts/driver/implement-state.mjs';
import { captureRepositoryState } from '../../../../skills/dispatch/scripts/verification/evidence.mjs';
import {
  acceptVerification,
  cachedBaseline,
  fingerprint,
  redSubstitutions,
  storeBaseline,
  suiteCoverage,
  purposeCommands,
} from '../../../../skills/dispatch/scripts/driver/verification.mjs';

const cleanup = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
function repoWithTestScript(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-coverage-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: script } }));
  return dir;
}

describe('aggregate suite coverage', () => {
  const script = 'node scripts/check.mjs && node --test --test-reporter=./r.mjs "tests/**/*.test.mjs"';
  it('maps node --test file commands under the suite glob to npm test', () => {
    const dir = repoWithTestScript(script);
    const commands = ['npm test', 'node --test tests/a.test.mjs', 'node --test --test-name-pattern="a b" ./tests/deep/b.test.mjs', 'node --test scripts/x.test.mjs', 'node --test --watch tests/a.test.mjs', 'node scripts/lint.mjs'];
    assert.deepEqual(suiteCoverage(dir, commands), {
      'node --test tests/a.test.mjs': 'npm test',
      'node --test --test-name-pattern="a b" ./tests/deep/b.test.mjs': 'npm test',
    });
  });
  it('covers nothing without the suite command or a parseable test script', () => {
    assert.deepEqual(suiteCoverage(repoWithTestScript(script), ['node --test tests/a.test.mjs']), {});
    assert.deepEqual(suiteCoverage(repoWithTestScript('jest'), ['npm test', 'node --test tests/a.test.mjs']), {});
  });
  it('covers nothing when the suite filters or shards its tests', () => {
    for (const flag of ['--test-name-pattern=x', '--test-skip-pattern=x', '--test-only', '--test-shard=1/2']) {
      assert.deepEqual(suiteCoverage(repoWithTestScript(`node --test ${flag} "tests/**/*.test.mjs"`), ['npm test', 'node --test tests/a.test.mjs']), {}, flag);
    }
  });
  it('expands brace globs', () => {
    const dir = repoWithTestScript('node --test "tests/*.{test,spec}.mjs"');
    assert.deepEqual(suiteCoverage(dir, ['npm run test', 'node --test tests/a.spec.mjs', 'node --test tests/sub/a.test.mjs']), { 'node --test tests/a.spec.mjs': 'npm run test' });
  });
  it('runs only red commands at RED, drops covered commands at completion, and records both at baseline', () => {
    const data = { commands: ['node --test tests/a.test.mjs', 'node --test tests/b.test.mjs', 'npm test', 'node scripts/lint.mjs'], redCriteria: [{ commands: ['node --test tests/a.test.mjs'] }],
      coverage: { 'node --test tests/a.test.mjs': 'npm test', 'node --test tests/b.test.mjs': 'npm test' } };
    assert.deepEqual(purposeCommands(data, 'red'), ['node --test tests/a.test.mjs']);
    assert.deepEqual(purposeCommands(data, 'final'), ['npm test', 'node scripts/lint.mjs']);
    assert.deepEqual(purposeCommands(data, 'baseline'), ['node --test tests/a.test.mjs', 'npm test', 'node scripts/lint.mjs']);
  });
});

describe('gate tiers', () => {
  const A = 'node --test tests/a.test.mjs', B = 'node --test tests/b.test.mjs', SUITE = 'npm test', LINT = 'node scripts/lint.mjs';
  const tierData = () => ({ commands: [A, B, SUITE, LINT], finalOnly: [SUITE], redCriteria: [{ commands: [A, SUITE] }],
    coverage: { [A]: SUITE, [B]: SUITE } });
  it('scoped candidates exclude [FINAL] commands and run covered narrow commands themselves', () => {
    assert.deepEqual(purposeCommands(tierData(), 'scoped'), [A, B, LINT]);
  });
  it('required gates still run [FINAL] commands', () => {
    const data = tierData();
    assert.deepEqual(purposeCommands(data, 'final'), [SUITE, LINT]);
    assert.deepEqual(purposeCommands(data, 'red'), [A, SUITE]);
    assert.deepEqual(purposeCommands(data, 'baseline'), [A, SUITE, LINT]);
  });
  it('a command marked [FINAL] on any criterion is final-only', () => {
    assert.deepEqual(purposeCommands({ ...tierData(), finalOnly: [SUITE, LINT] }, 'scoped'), [A, B]);
  });

  function gateState() {
    const repo = makeGitRepo();
    cleanup.push(repo.cleanup);
    fs.mkdirSync(path.join(repo.dir, 'tests'));
    for (const file of ['tests/a.test.mjs', 'tests/b.test.mjs']) fs.writeFileSync(path.join(repo.dir, file), '// test\n');
    const scopes = { [A]: ['src/app.js', 'tests/a.test.mjs'], [B]: ['tests/b.test.mjs'], [SUITE]: ['src/app.js', 'tests/a.test.mjs', 'tests/b.test.mjs'], [LINT]: ['src/app.js'] };
    const state = { repoRoot: repo.dir, ordinary: { commands: [A, B, SUITE, LINT], finalOnly: [SUITE], redCriteria: [], coverage: {}, scopes, mutationEpoch: 0,
      approvedPaths: ['src/app.js', 'tests/a.test.mjs', 'tests/b.test.mjs'], criteria: [] } };
    const record = (command, scopeHash, mutationEpoch = 0) => ({ command, exitStatus: 0, identifiers: [], diagnostic: '', criterionEvidence: [], scopeHash, mutationEpoch, changed: [] });
    state.ordinary.completionResults = [record(A, fingerprint(state, scopes[A])), record(B, 'sha256:stale')];
    // A baseline record is not a prior gate result: scoped gates still run LINT.
    state.ordinary.baselineResults = [record(LINT, fingerprint(state, scopes[LINT]))];
    return state;
  }
  it('scoped gates skip commands whose scope is unchanged since their last non-baseline result', async () => {
    const { gateCommands } = await import('../../../../skills/dispatch/scripts/driver/verification.mjs');
    const state = gateState();
    assert.deepEqual(gateCommands(state, 'scoped'), [B, LINT]);
    state.ordinary.mutationEpoch = 1;
    assert.deepEqual(gateCommands(state, 'scoped'), [B, LINT], 'scoped freshness ignores the mutation epoch');
    fs.writeFileSync(path.join(state.repoRoot, 'tests/a.test.mjs'), '// changed\n');
    assert.deepEqual(gateCommands(state, 'scoped'), [A, B, LINT], 'a changed scope reruns the command');
  });
  // Replaces the end-to-end defer cases: an all-[FINAL] verify criterion is deferred at scoped gates unless a gate command carries it.
  const SLOW = 'node scripts/slow.mjs', OTHER = 'node --test tests/other.test.mjs';
  const deferData = (overrides = {}) => ({ finalOnly: [SLOW], coverage: {}, criteria: [
    { id: 'SC1', evidence: 'red', commands: [A] },
    { id: 'SC2', evidence: 'verify', commands: [SLOW] },
    { id: 'SC3', evidence: 'verify', commands: [LINT] },
  ], ...overrides });
  for (const [name, data, commands, expected] of [
    ['an all-[FINAL] verify criterion is deferred at a scoped gate', deferData(), [A, LINT], ['SC2']],
    ['a red criterion mapped only to [FINAL] commands is never deferred', deferData({ finalOnly: [SLOW, A] }), [LINT], ['SC2']],
    ['a criterion with any non-[FINAL] command is not deferred', deferData({ criteria: [{ id: 'SC2', evidence: 'verify', commands: [SLOW, LINT] }] }), [LINT], []],
    ['a criterion carried by a scoped suite is not deferred', deferData({ finalOnly: [OTHER], coverage: { [OTHER]: SUITE }, criteria: [{ id: 'SC2', evidence: 'verify', commands: [OTHER] }] }), [SUITE], []],
    ['a criterion carried directly by a gate command is not deferred', deferData(), [SLOW], []],
  ]) {
    it(`deferredCriteria: ${name}`, async () => {
      const { deferredCriteria } = await import('../../../../skills/dispatch/scripts/driver/verification.mjs');
      assert.deepEqual(deferredCriteria(data, commands).map(item => item.id), expected);
    });
  }
  it('gateCommands: scoped gates exclude [FINAL] commands that the final gate runs', async () => {
    const { gateCommands } = await import('../../../../skills/dispatch/scripts/driver/verification.mjs');
    const state = gateState();
    for (const [purpose, expected] of [['scoped', [B, LINT]], ['final', [B, SUITE, LINT]]]) {
      assert.equal(gateCommands(state, purpose).includes(SUITE), expected.includes(SUITE), purpose);
      assert.deepEqual(gateCommands(state, purpose), expected, purpose);
    }
  });
  it('the final gate runs every uncovered command lacking an epoch- and scope-fresh record', async () => {
    const { gateCommands } = await import('../../../../skills/dispatch/scripts/driver/verification.mjs');
    const state = gateState();
    assert.deepEqual(gateCommands(state, 'final'), [B, SUITE, LINT]);
    state.ordinary.mutationEpoch = 1;
    assert.deepEqual(gateCommands(state, 'final'), [A, B, SUITE, LINT], 'a later epoch makes earlier records stale');
  });
});

describe('RED narrowing', () => {
  const red = (command) => ({ id: 'SC1', commands: [command], paths: ['src/a.js', 'tests/a.test.mjs'] });
  const state = (script, command = 'npm test') => ({ repoRoot: repoWithTestScript(script), ordinary: { commands: [command], redCriteria: [red(command)], testsOnlyPaths: ['tests/a.test.mjs'] } });
  it('narrows a covering suite to the red test files, keeping --flag=value options', () => {
    assert.deepEqual(redSubstitutions(state('node scripts/check.mjs && node --test --test-reporter=./r.mjs "tests/**/*.test.mjs"')),
      { 'npm test': 'node --test --test-reporter=./r.mjs tests/a.test.mjs' });
  });
  it('keeps the suite whole when an option could take a separate value or no red file is under its glob', () => {
    assert.deepEqual(redSubstitutions(state('node --test --import ./setup.mjs "tests/**/*.test.mjs"')), {});
    assert.deepEqual(redSubstitutions(state('node --test "other/**/*.test.mjs"')), {});
    assert.deepEqual(redSubstitutions(state('node --test "tests/**/*.test.mjs"', 'node --test tests/a.test.mjs')), {});
  });
});

describe('baseline reuse', () => {
  function baselineState() {
    const repo = makeGitRepo();
    cleanup.push(repo.cleanup);
    const commands = ['node --test tests/a.test.mjs'];
    return { repoRoot: repo.dir, ledgerPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-cache-')), 'sample-ledger.md'), ordinary: { commands, redCriteria: [], coverage: {}, scopes: { [commands[0]]: ['src/app.js'] } } };
  }
  const A = 'node --test tests/a.test.mjs', RED = 'node --test tests/new.test.mjs';
  const hitCommands = cache => cache.hits.map(item => item.command);
  /** A second plan's run on the same repository: another ledger path, a new red command. */
  const nextRun = (state, extra = {}) => ({ ...state, ledgerPath: path.join(path.dirname(state.ledgerPath), 'other-ledger.md'),
    ordinary: { commands: [A, RED], redCriteria: [{ commands: [RED] }], coverage: {}, scopes: { [A]: ['src/app.js'], [RED]: ['src/app.js'] }, ...extra } });
  it('reuses stored per-command results for identical content within a day and runs only the rest', () => {
    const state = baselineState(), results = [{ command: A, exitStatus: 0 }];
    assert.deepEqual(cachedBaseline(state).hits, []);
    storeBaseline(state, results);
    const next = nextRun(state);
    assert.deepEqual(hitCommands(cachedBaseline(next)), [A]);
    assert.deepEqual(cachedBaseline(next).misses, [RED]);
    assert.deepEqual(cachedBaseline(next, { now: Date.now() + 25 * 60 * 60 * 1000 }).misses, [A, RED], 'expired');
  });
  it('keys the cache on content, so a commit or .scratch edit still hits and a changed tree misses', () => {
    const state = baselineState();
    fs.writeFileSync(path.join(state.repoRoot, 'src/app.js'), 'export const value = 2;\n');
    storeBaseline(state, [{ command: A, exitStatus: 0 }]);
    const repoGit = (...args) => execFileSync('git', args, { cwd: state.repoRoot, stdio: 'pipe' });
    repoGit('add', '-A'); repoGit('commit', '--no-gpg-sign', '-qm', 'implemented');
    fs.writeFileSync(path.join(state.repoRoot, '.scratch/plan/2026-09-24-next.md'), '# Next\n');
    assert.deepEqual(hitCommands(cachedBaseline(nextRun(state))), [A], 'same content after commit and scratch edit');
    fs.writeFileSync(path.join(state.repoRoot, 'src/app.js'), 'export const value = 3;\n');
    assert.deepEqual(cachedBaseline(nextRun(state)).misses, [A, RED], 'a changed tree reruns the baseline');
  });
  it('does not claim a covered red command as seeded by its suite', () => {
    const state = baselineState();
    storeBaseline(state, [{ command: 'npm test', exitStatus: 0 }]);
    const next = nextRun(state, { commands: [A, 'npm test'], redCriteria: [{ commands: [A] }], coverage: { [A]: 'npm test' }, scopes: { [A]: ['src/app.js'], 'npm test': ['src/app.js'] } });
    assert.deepEqual(hitCommands(cachedBaseline(next)), ['npm test']);
    assert.deepEqual(cachedBaseline(next).misses, [A]);
  });
  it('seeds the cache from a passing final gate', () => {
    const state = baselineState();
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-seed-'));
    cleanup.push(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
    Object.assign(state, { runId: 'run-final-seed', stateFile: path.join(sessionDir, 'state.json') });
    Object.assign(state.ordinary, { criteria: [{ id: 'SC1', evidence: 'red', commands: [A], paths: ['src/app.js'] }], mutationEpoch: 0, approvedPaths: ['src/app.js'] });
    const final = captureRepositoryState(state.repoRoot);
    final.entries = Object.fromEntries(Object.entries(final.entries).filter(([file]) => !file.startsWith('.scratch/')));
    const resultsPath = path.join(sessionDir, 'final.json'), token = 'token-final';
    state.ordinary.verification = { purpose: 'final', token, commands: [A], substitutions: {}, generators: [], resultsPath };
    fs.writeFileSync(resultsPath, JSON.stringify({ v: 1, token, purpose: 'final', mutationEpoch: 0, generated: [], final,
      results: [{ command: A, ran: A, exit: 0, counts: null, identifiers: [], diagnostic: '', logPath: '', scopeHash: fingerprint(state, ['src/app.js']), mutationEpoch: 0, changed: [] }] }));
    acceptVerification(state, null);
    assert.deepEqual(hitCommands(cachedBaseline(nextRun(state))), [A]);
  });
});

describe('walkthrough evidence rendering', () => {
  it('renders the RED matrix into a CRLF walkthrough', () => {
    const repo = makeGitRepo();
    cleanup.push(repo.cleanup);
    const planPath = writePlan(repo.dir), walkthroughPath = planPath.replace(/\.md$/, '-walkthrough.md');
    fs.writeFileSync(walkthroughPath, ['# Walkthrough', '', '## Verification & Validation', 'Pending.', '', '## Outcome Traceability', 'Pending.', '', '## Key Deviations', 'None.', ''].join('\r\n'));
    const ordinary = { redValidated: { evidence: ['RED-MATRIX SC1 | tests/a.test.mjs | exit 1 test:a'] }, redResults: [{ command: 'npm test', exitStatus: 1 }] };
    persistEvidence({ repoRoot: repo.dir, planPath, walkthroughPath, governingHash: 'sha256:x', ordinary });
    const text = fs.readFileSync(walkthroughPath, 'utf8');
    assert.match(text, /### RED matrix/);
    assert.match(text, /\| SC1 \| `tests\/a\.test\.mjs` \| exit 1 test:a \|/);
  });
  it('prints a failure set shared by several RED rows once and references it', () => {
    const repo = makeGitRepo();
    cleanup.push(repo.cleanup);
    const planPath = writePlan(repo.dir), walkthroughPath = planPath.replace(/\.md$/, '-walkthrough.md');
    fs.writeFileSync(walkthroughPath, ['# Walkthrough', '', '## Verification & Validation', 'Pending.', '', '## Outcome Traceability', 'Pending.', ''].join('\n'));
    const ordinary = { redValidated: { evidence: ['RED-MATRIX SC1 | tests/a.test.mjs:a | exit 1 test:a; test:b', 'RED-MATRIX SC2 | tests/a.test.mjs:b | exit 1 test:a; test:b', 'RED-MATRIX SC3 | tests/c.test.mjs:c | exit 1 test:c'] }, redResults: [{ command: 'npm test', exitStatus: 1 }] };
    persistEvidence({ repoRoot: repo.dir, planPath, walkthroughPath, governingHash: 'sha256:x', ordinary });
    const text = fs.readFileSync(walkthroughPath, 'utf8');
    assert.match(text, /\| SC1 \| `tests\/a\.test\.mjs:a` \| see S1 \|/);
    assert.match(text, /\| SC2 \| `tests\/a\.test\.mjs:b` \| see S1 \|/);
    assert.match(text, /\| SC3 \| `tests\/c\.test\.mjs:c` \| exit 1 test:c \|/);
    const matrix = /### RED matrix\n[\s\S]*?(?=\n## )/.exec(text)[0];
    assert.equal(matrix.match(/exit 1 test:a; test:b/g).length, 1);
    assert.match(matrix, /Shared failure sets:\n- S1: exit 1 test:a; test:b/);
  });
});

describe('walkthrough evidence restore', () => {
  function withEvidence(record) {
    const repo = makeGitRepo();
    cleanup.push(repo.cleanup);
    const planPath = writePlan(repo.dir);
    const walkthroughPath = planPath.replace(/\.md$/, '-walkthrough.md');
    fs.writeFileSync(walkthroughPath, ['# Walkthrough', '', '## Ordinary execution evidence', '```json', JSON.stringify({ schemaVersion: 1, planPath: '.scratch/plan/2026-09-22-sample.md', ordinary: { step: 'failure-disposition' }, ...record }), '```', ''].join('\n'));
    const state = { repoRoot: repo.dir, planPath, walkthroughPath, governingHash: governingHash(fs.readFileSync(planPath, 'utf8')).hash, ledgerPath: path.join(repo.dir, 'missing-ledger.md') };
    return state;
  }
  it('ignores ordinary evidence of an earlier plan revision whose run is not live', () => {
    const state = withEvidence({ governingHash: `sha256:${'a'.repeat(64)}`, ledgerRunId: 'finished-run' });
    assert.equal(restoreEvidence(state), false);
    assert.equal(state.ordinary, undefined);
  });
  it('still refuses earlier-revision evidence whose run segment is live', () => {
    const runId = '55555555-1111-4111-8111-111111111111', at = '2026-09-23T00:00:00.000Z';
    const oldHash = `sha256:${'a'.repeat(64)}`;
    const state = withEvidence({ governingHash: oldHash, ledgerRunId: runId });
    state.ledgerPath = resolveLedgerPath({ slug: 'sample', slugSource: 'explicit', repositoryRoot: state.repoRoot });
    ensureLedgerNamespace({ repoHash: state.ledgerPath.split(path.sep).at(-2), env: process.env });
    appendEvent(state.ledgerPath, { v: 1, type: 'run-start', runId, at, seq: 1, data: { governingPath: '.scratch/plan/2026-09-22-sample.md', governingHash: oldHash, rootSlug: 'sample', action: 'ordinary', baseline: { commit: 'c'.repeat(40), repositoryState: `sha256:${'b'.repeat(64)}`, dirtyPaths: [] } } });
    cleanup.push(() => fs.rmSync(state.ledgerPath, { force: true }));
    assert.throws(() => restoreEvidence(state), /does not bind this governing plan/);
  });
  it('still refuses mismatched evidence that carries a parent design identity', () => {
    const state = withEvidence({ governingHash: `sha256:${'a'.repeat(64)}`, ledgerRunId: null, incrementId: 'I01' });
    assert.throws(() => restoreEvidence(state), /does not bind this governing plan/);
  });
});
