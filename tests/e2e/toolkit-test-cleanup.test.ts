import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolkitRepo, planSource, captureIntegrationReview } from './helpers/toolkit-repo.ts';
import { foldLedger } from '../../skills/dispatch/scripts/toolkit/ledger.ts';
import { readManifest } from '../../skills/dispatch/scripts/lib/session.ts';
import { checks, loadPlan } from '../../skills/dispatch/scripts/toolkit/plan-view.ts';

const target = 'tests/step.test.ts';
const source = planSource
  .replace('#### [MODIFY] src/file.ts', '#### [MODIFY] src/file.ts\n- Purpose: implements behavior.\n#### [NEW] ' + target)
  .replace('  - Changes: src/file.ts', '  - Changes: src/file.ts, ' + target + '\n  - Tests: ' + target);
const reviewSource = source.replace(
  '  - Evidence: verify',
  '  - Evidence: review\n  - Review: artifact: tests/step.test.ts; scenario: inspect the test change; pass: the user records the result',
);

type Repo = Awaited<ReturnType<typeof toolkitRepo>>;
async function integrated(verify = true, plan = source) {
  const r = await toolkitRepo(plan);
  await r.level();
  const made = await r.run(['worktree', 'create', 'T1']);
  assert.equal(made.output.ok, true, JSON.stringify(made));
  const writer = path.join(r.session, made.value.path);
  fs.mkdirSync(path.join(writer, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(writer, target), 'step\n');
  assert.equal((await r.run(['worktree', 'submit', 'T1'])).exit, 0);
  assert.equal((await r.run(['worktree', 'integrate', 'T1'])).exit, 0);
  if (verify) assert.equal((await r.run(['verify', 'run'])).output.ok, true);
  return r;
}
const cleanupFile = (r: Repo, data: object) => {
  const file = path.join(r.session, 'cleanup.json');
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
};
const commit = (r: Repo, data: object, hook?: Parameters<Repo['run']>[1]) =>
  r.run(['worktree', 'commit', '--reason', 'remove step tests', '--test-cleanup', cleanupFile(r, data)], hook);
const cleanups = (r: Repo) => foldLedger(r.session).records.filter(row => row.data['phase'] === 'test-cleanup');
const removal = { removed: ['SC1'], deleted: 2, merged: 1 };

test('test cleanup cannot use historical tool evidence for a review-only criterion', async () => {
  const r = await integrated(true, reviewSource);
  try {
    const check = checks(loadPlan(r.session, readManifest(r.session))).find(row => row.criterion === 'SC1')!;
    const tree = r.git(['rev-parse', 'HEAD^{tree}'], r.integration);
    const evidenceFile = path.join(r.session, 'legacy-review-evidence.json');
    fs.writeFileSync(evidenceFile, JSON.stringify({
      kind: 'evidence', key: 'legacy-review-evidence', by: 'tool',
      data: { criterion: 'SC1', commandDigest: check.commandDigest, tree, clean: true, before: tree, after: tree, exit: 0, path: '.state/evidence/legacy-review.json' },
    }));
    assert.equal((await r.run(['ledger', 'append', evidenceFile])).exit, 0);

    fs.rmSync(path.join(r.integration, target));
    const result = await commit(r, removal);
    assert.equal(result.output.reason, 'test-cleanup-evidence-required');
    assert.equal(cleanups(r).length, 0);
  } finally { r.cleanup(); }
});

test('test cleanup commit records removed criteria and counts once', async () => {
  const r = await integrated();
  try {
    const before = r.git(['rev-parse', 'HEAD'], r.integration);
    fs.rmSync(path.join(r.integration, target));
    const done = await commit(r, removal);
    assert.equal(done.output.ok, true, JSON.stringify(done));
    const head = r.git(['rev-parse', 'HEAD'], r.integration);
    assert.notEqual(head, before);
    assert.match(r.git(['log', '-1', '--format=%B'], r.integration), /Dispatch-Test-Cleanup-Data: /);
    const [record] = cleanups(r);
    assert.equal(cleanups(r).length, 1);
    assert.deepEqual({ from: record!.data['from'], fromTree: record!.data['fromTree'], to: record!.data['to'], removed: record!.data['removed'], deleted: record!.data['deleted'], merged: record!.data['merged'] },
      { from: before, fromTree: r.git(['rev-parse', before + '^{tree}'], r.integration), to: head, ...removal });
    fs.writeFileSync(path.join(r.integration, 'src/file.ts'), 'again\n');
    assert.equal((await commit(r, removal)).output.reason, 'test-cleanup-recorded');
    assert.equal(cleanups(r).length, 1);
  } finally { r.cleanup(); }
});

test('test cleanup commit refuses missing evidence, unchanged test paths and empty cleanup', async () => {
  const r = await integrated(false);
  try {
    fs.rmSync(path.join(r.integration, target));
    const head = r.git(['rev-parse', 'HEAD'], r.integration);
    assert.equal((await commit(r, removal)).output.reason, 'test-cleanup-evidence-required');
    assert.equal((await commit(r, { removed: ['SC9'], deleted: 1, merged: 0 })).output.reason, 'test-cleanup-evidence-required');
    assert.equal(r.git(['rev-parse', 'HEAD'], r.integration), head);
    assert.equal(cleanups(r).length, 0);

    fs.writeFileSync(path.join(r.integration, target), 'step\n');
    assert.equal((await r.run(['verify', 'run'])).output.ok, true);
    fs.writeFileSync(path.join(r.integration, 'src/other.ts'), 'other\n');
    assert.equal((await commit(r, removal)).output.reason, 'test-cleanup-paths-unchanged');
    assert.equal((await commit(r, { removed: [], deleted: 0, merged: 0 })).output.reason, 'test-cleanup-empty');
    assert.equal(r.git(['rev-parse', 'HEAD'], r.integration), head);
    assert.equal(cleanups(r).length, 0);
  } finally { r.cleanup(); }
});

test('an interrupted test cleanup commit records on retry without a second commit', async () => {
  const r = await integrated();
  try {
    const before = r.git(['rev-parse', 'HEAD'], r.integration);
    fs.rmSync(path.join(r.integration, target));
    const crashed = await commit(r, removal, point => { if (point === 'commit:after-commit') throw Error('crash'); });
    assert.equal(crashed.exit, 2);
    assert.equal(cleanups(r).length, 0);
    const head = r.git(['rev-parse', 'HEAD'], r.integration);
    assert.notEqual(head, before);
    assert.equal((await commit(r, { ...removal, deleted: 9 })).output.ok, false);
    const retried = await commit(r, removal);
    assert.equal(retried.output.ok, true, JSON.stringify(retried));
    assert.equal(r.git(['rev-parse', 'HEAD'], r.integration), head);
    assert.equal(cleanups(r).length, 1);
    assert.equal(cleanups(r)[0]!.data['from'], before);
  } finally { r.cleanup(); }
});

test('verify skips criteria whose tests cleanup removed and refuses to select them', async () => {
  const r = await integrated();
  try {
    fs.rmSync(path.join(r.integration, target));
    assert.equal((await commit(r, removal)).output.ok, true);
    const all = await r.run(['verify', 'run']);
    assert.equal(all.output.ok, true, JSON.stringify(all));
    assert.deepEqual(all.value.checks.map((row: { criterion: string }) => row.criterion), ['contract']);
    const named = await r.run(['verify', 'run', '--criteria', 'SC1']);
    assert.equal(named.exit, 4);
    assert.equal(named.output.reason, 'test-cleanup-removed');
  } finally { r.cleanup(); }
});

test('status and report treat removed criteria as verified at the pre-cleanup commit', async () => {
  const r = await integrated();
  try {
    const before = r.git(['rev-parse', 'HEAD'], r.integration);
    const pending = await r.run(['status', 'show']);
    assert.deepEqual(pending.value.criteria, []);
    fs.rmSync(path.join(r.integration, target));
    assert.equal((await commit(r, removal)).output.ok, true);
    const stale = await r.run(['status', 'show']);
    assert.deepEqual(stale.value.criteria, ['contract']);
    assert.equal((await r.run(['verify', 'run'])).output.ok, true);
    const status = await r.run(['status', 'show']);
    assert.deepEqual(status.value.criteria, []);
    assert.deepEqual(status.value.testCleanup, { from: before, removed: ['SC1'], deleted: 2, merged: 1 });
    const row = status.value.criterionStatuses.find((entry: { criterion: string }) => entry.criterion === 'SC1');
    assert.equal(row.state, 'verified');
    assert.equal(row.reason, 'verified at ' + before + '; tests removed in cleanup');
    captureIntegrationReview(r);
    const delivered = await r.run(['worktree', 'deliver']);
    assert.equal(delivered.output.ok, true, JSON.stringify(delivered));
    const report = await r.run(['report', 'complete']);
    assert.equal(report.output.ok, true, JSON.stringify(report));
    const walkthrough = fs.readFileSync(path.join(r.session, report.value.path), 'utf8');
    assert.ok(walkthrough.includes('**Test cleanup:** deleted 2 · merged 1 tests after verification at ' + before.slice(0, 12) + '; criteria with tests removed: SC1'));
    const reported = report.value.statuses.find((entry: { criterion: string }) => entry.criterion === 'SC1');
    assert.equal(reported.state, 'verified');
    assert.match(reported.reason, /tests removed in cleanup/);
  } finally { r.cleanup(); }
});
