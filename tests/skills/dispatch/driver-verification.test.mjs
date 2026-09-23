import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { makeGitRepo, writePlan } from './driver-harness.mjs';
import { appendEvent, ensureLedgerNamespace, governingHash } from '../../../skills/dispatch/scripts/ledger.mjs';
import { resolveLedgerPath } from '../../../skills/dispatch/scripts/resolve-artifact-paths.mjs';
import { restoreEvidence } from '../../../skills/dispatch/scripts/driver/ordinary-state.mjs';
import { purposeCommands, suiteCoverage } from '../../../skills/dispatch/scripts/driver/verification.mjs';

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
