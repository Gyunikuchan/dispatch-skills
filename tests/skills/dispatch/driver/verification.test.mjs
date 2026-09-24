import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { makeGitRepo, writePlan } from '../../../helpers/driver-harness.mjs';
import { appendEvent, ensureLedgerNamespace, governingHash } from '../../../../skills/dispatch/scripts/ledger.mjs';
import { resolveLedgerPath } from '../../../../skills/dispatch/scripts/resolve-artifact-paths.mjs';
import { persistEvidence, restoreEvidence } from '../../../../skills/dispatch/scripts/driver/ordinary-state.mjs';
import { cachedBaseline, purposeCommands, redSubstitutions, storeBaseline, suiteCoverage } from '../../../../skills/dispatch/scripts/driver/verification.mjs';

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
    assert.deepEqual(purposeCommands(data, 'completion'), ['npm test', 'node scripts/lint.mjs']);
    assert.deepEqual(purposeCommands(data, 'baseline'), ['node --test tests/a.test.mjs', 'npm test', 'node scripts/lint.mjs']);
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
  it('reuses a stored baseline only for the identical tree within a day', () => {
    const state = baselineState(), results = [{ command: 'node --test tests/a.test.mjs', exitStatus: 0 }];
    assert.equal(cachedBaseline(state), null);
    storeBaseline(state, results);
    assert.deepEqual(cachedBaseline(state).results, results);
    assert.equal(cachedBaseline(state, { now: Date.now() + 25 * 60 * 60 * 1000 }), null, 'expired');
    fs.writeFileSync(path.join(state.repoRoot, 'src/app.js'), 'export const value = 3;\n');
    assert.equal(cachedBaseline(state), null, 'a changed tree reruns the baseline');
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
