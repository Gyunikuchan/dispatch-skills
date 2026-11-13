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
const twoCriteriaSource = [
  '# Work',
  '',
  '## Task Map',
  '| ID | Title | Outcome | Prerequisites | Criteria |',
  '| --- | --- | --- | --- | --- |',
  '| T1 | File | Works | none | SC1 |',
  '| T2 | Other | Works | none | SC2 |',
  '',
  '## Proposed Changes',
  '### T1 — File',
  '#### [MODIFY] src/file.ts',
  '- Purpose: implements behavior.',
  '#### [NEW] ' + target,
  '- Purpose: implements behavior.',
  '',
  '### T2 — Other',
  '#### [NEW] src/other.ts',
  '- Purpose: implements behavior.',
  '#### [NEW] tests/other.test.ts',
  '- Purpose: tests other behavior.',
  '',
  '## Success Criteria',
  '- [SC1] File works',
  '  - Changes: src/file.ts, ' + target,
  '  - Tests: ' + target,
  '  - Check: `node -e "process.exit(0)"`',
  '  - Evidence: check',
  '- [SC2] Other works',
  '  - Changes: src/other.ts, tests/other.test.ts',
  '  - Tests: tests/other.test.ts',
  '  - Check: `node -e "process.exit(0)"`',
  '  - Evidence: check',
  '',
  '## Verification Plan',
  '### Automated Tests',
  '- `node -e "process.stdout.write(\'contract\')"`',
  '',
].join('\n');

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
  if (verify) assert.equal((await r.run(['check', 'run'])).output.ok, true);
  return r;
}
async function integrateTaskTwo(r: Repo) {
  const made = await r.run(['worktree', 'create', 'T2']);
  assert.equal(made.output.ok, true, JSON.stringify(made));
  const writer = path.join(r.session, made.value.path);
  fs.mkdirSync(path.join(writer, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(writer, 'src/other.ts'), 'other\n');
  fs.writeFileSync(path.join(writer, 'tests/other.test.ts'), 'other test\n');
  assert.equal((await r.run(['worktree', 'submit', 'T2'])).exit, 0);
  assert.equal((await r.run(['worktree', 'integrate', 'T2'])).exit, 0);
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
    assert.deepEqual({ from: record!.data['from'], fromTree: record!.data['fromTree'], to: record!.data['to'], removed: record!.data['removed'], deleted: record!.data['deleted'], merged: record!.data['merged'], trees: record!.data['trees'] },
      { from: before, fromTree: r.git(['rev-parse', before + '^{tree}'], r.integration), to: head, ...removal, trees: { SC1: r.git(['rev-parse', before + '^{tree}'], r.integration) } });
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

    const check = checks(loadPlan(r.session, readManifest(r.session))).find(row => row.criterion === 'SC1')!;
    const tree = r.git(['rev-parse', 'HEAD^{tree}'], r.integration);
    const evidenceFile = path.join(r.session, 'legacy-review-evidence.json');
    fs.writeFileSync(evidenceFile, JSON.stringify({
      kind: 'evidence', key: 'legacy-review-evidence', by: 'tool',
      data: { criterion: 'SC1', commandDigest: check.commandDigest, tree, clean: false, before: tree, after: tree, exit: 1, path: '.state/evidence/legacy-review.json' },
    }));
    assert.equal((await r.run(['ledger', 'append', evidenceFile])).exit, 0);
    assert.equal((await commit(r, removal)).output.reason, 'test-cleanup-evidence-required');
    assert.equal(cleanups(r).length, 0);

    fs.writeFileSync(path.join(r.integration, target), 'step\n');
    assert.equal((await r.run(['check', 'run'])).output.ok, true);
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
    const all = await r.run(['check', 'run']);
    assert.equal(all.output.ok, true, JSON.stringify(all));
    assert.deepEqual(all.value.checks.map((row: { criterion: string }) => row.criterion), ['contract']);
    const named = await r.run(['check', 'run', '--criteria', 'SC1']);
    assert.equal(named.exit, 4);
    assert.equal(named.output.reason, 'test-cleanup-removed');
    assert.match(named.output.summary, /stays bound to their recorded evidence tree/);
  } finally { r.cleanup(); }
});

test('test cleanup commit accepts evidence from an unchanged earlier tree; status names the evidence tree of removed criteria', async () => {
  const r = await integrated(false, twoCriteriaSource);
  try {
    assert.equal((await r.run(['check', 'run', '--criteria', 'SC1'])).output.ok, true);
    const earlyTree = r.git(['rev-parse', 'HEAD^{tree}'], r.integration);
    await integrateTaskTwo(r);
    const before = r.git(['rev-parse', 'HEAD'], r.integration);
    const beforeTree = r.git(['rev-parse', 'HEAD^{tree}'], r.integration);
    assert.notEqual(beforeTree, earlyTree);
    fs.rmSync(path.join(r.integration, target));
    const done = await commit(r, removal);
    assert.equal(done.output.ok, true, JSON.stringify(done));
    const [record] = cleanups(r);
    assert.equal(record!.data['fromTree'], beforeTree);
    assert.deepEqual(record!.data['trees'], { SC1: earlyTree });
    const stale = await r.run(['status', 'show']);
    assert.deepEqual(stale.value.criteria, ['SC2', 'contract']);
    assert.equal((await r.run(['check', 'run'])).output.ok, true);
    const status = await r.run(['status', 'show']);
    assert.deepEqual(status.value.criteria, []);
    assert.deepEqual(status.value.testCleanup, { from: before, trees: { SC1: earlyTree }, removed: ['SC1'], deleted: 2, merged: 1 });
    const row = status.value.criterionStatuses.find((entry: { criterion: string }) => entry.criterion === 'SC1');
    assert.equal(row.state, 'verified');
    assert.equal(row.reason, 'verified at ' + earlyTree + '; tests removed in cleanup');
    captureIntegrationReview(r);
    const delivered = await r.run(['worktree', 'deliver']);
    assert.equal(delivered.output.ok, true, JSON.stringify(delivered));
    const report = await r.run(['report', 'complete']);
    assert.equal(report.output.ok, true, JSON.stringify(report));
    const walkthrough = fs.readFileSync(path.join(r.session, report.value.path), 'utf8');
    assert.ok(walkthrough.includes('**Test cleanup:** deleted 2 · merged 1 tests; criteria with tests removed: SC1 at ' + earlyTree.slice(0, 12)));
    const reported = report.value.statuses.find((entry: { criterion: string }) => entry.criterion === 'SC1');
    assert.equal(reported.state, 'verified');
    assert.equal(reported.reason, 'verified at ' + earlyTree + '; tests removed in cleanup');
  } finally { r.cleanup(); }
});

test('test cleanup commit refuses after a changes path changed', async () => {
  const r = await integrated(false, twoCriteriaSource);
  try {
    assert.equal((await r.run(['check', 'run', '--criteria', 'SC1'])).output.ok, true);
    fs.writeFileSync(path.join(r.integration, 'src/file.ts'), 'changed after check\n');
    r.git(['add', 'src/file.ts'], r.integration);
    r.git(['commit', '-m', 'change src'], r.integration);
    const head = r.git(['rev-parse', 'HEAD'], r.integration);
    fs.rmSync(path.join(r.integration, target));
    const refused = await commit(r, removal);
    assert.equal(refused.output.reason, 'test-cleanup-evidence-required');
    assert.match(refused.output.summary, /\bSC1\b/);
    assert.equal(r.git(['rev-parse', 'HEAD'], r.integration), head);
    assert.equal(cleanups(r).length, 0);
  } finally { r.cleanup(); }
});

test('test cleanup commit refuses after a tests path changed', async () => {
  const r = await integrated(false, twoCriteriaSource);
  try {
    assert.equal((await r.run(['check', 'run', '--criteria', 'SC1'])).output.ok, true);
    fs.writeFileSync(path.join(r.integration, target), 'edited test\n');
    r.git(['add', target], r.integration);
    r.git(['commit', '-m', 'change test'], r.integration);
    const head = r.git(['rev-parse', 'HEAD'], r.integration);
    fs.rmSync(path.join(r.integration, target));
    const refused = await commit(r, removal);
    assert.equal(refused.output.reason, 'test-cleanup-evidence-required');
    assert.match(refused.output.summary, /\bSC1\b/);
    assert.equal(r.git(['rev-parse', 'HEAD'], r.integration), head);
    assert.equal(cleanups(r).length, 0);
  } finally { r.cleanup(); }
});

test('test cleanup commit refuses after an undeclared path changed', async () => {
  const r = await integrated(false, twoCriteriaSource);
  try {
    assert.equal((await r.run(['check', 'run', '--criteria', 'SC1'])).output.ok, true);
    fs.writeFileSync(path.join(r.integration, 'src/undeclared-helper.ts'), 'helper\n');
    r.git(['add', 'src/undeclared-helper.ts'], r.integration);
    r.git(['commit', '-m', 'undeclared helper'], r.integration);
    const head = r.git(['rev-parse', 'HEAD'], r.integration);
    fs.rmSync(path.join(r.integration, target));
    const refused = await commit(r, removal);
    assert.equal(refused.output.reason, 'test-cleanup-evidence-required');
    assert.match(refused.output.summary, /\bSC1\b/);
    assert.equal(r.git(['rev-parse', 'HEAD'], r.integration), head);
    assert.equal(cleanups(r).length, 0);
  } finally { r.cleanup(); }
});

test('test cleanup commit treats a renamed tests path as changed', async () => {
  const r = await integrated(false, twoCriteriaSource);
  try {
    assert.equal((await r.run(['check', 'run', '--criteria', 'SC1'])).output.ok, true);
    r.git(['mv', target, 'tests/other.test.ts'], r.integration);
    r.git(['commit', '-m', 'rename step test to other test'], r.integration);
    const head = r.git(['rev-parse', 'HEAD'], r.integration);
    fs.rmSync(path.join(r.integration, 'tests/other.test.ts'));
    const refused = await commit(r, removal);
    assert.equal(refused.output.reason, 'test-cleanup-evidence-required');
    assert.match(refused.output.summary, /\bSC1\b/);
    assert.equal(r.git(['rev-parse', 'HEAD'], r.integration), head);
    assert.equal(cleanups(r).length, 0);
  } finally { r.cleanup(); }
});

test('test cleanup commit treats a leading-whitespace path as distinct from a trimmed declared path', async () => {
  const plan = twoCriteriaSource
    .replace('### T2 — Other', '### T2 — Other\n#### [NEW] foo.ts\n- Purpose: implements foo.')
    .replace('  - Changes: src/other.ts, tests/other.test.ts', '  - Changes: foo.ts, src/other.ts, tests/other.test.ts');
  const r = await integrated(false, plan);
  try {
    assert.equal((await r.run(['check', 'run', '--criteria', 'SC1'])).output.ok, true);
    fs.writeFileSync(path.join(r.integration, ' foo.ts'), 'undeclared leading space\n');
    r.git(['add', ' foo.ts'], r.integration);
    r.git(['commit', '-m', 'add leading space file'], r.integration);
    const head = r.git(['rev-parse', 'HEAD'], r.integration);
    fs.rmSync(path.join(r.integration, target));
    const refused = await commit(r, removal);
    assert.equal(refused.output.reason, 'test-cleanup-evidence-required');
    assert.match(refused.output.summary, /\bSC1\b/);
    assert.equal(r.git(['rev-parse', 'HEAD'], r.integration), head);
    assert.equal(cleanups(r).length, 0);
  } finally { r.cleanup(); }
});

test('test cleanup commit accepts a directory-valued Tests path when a file under it changes', async () => {
  const plan = source.replace('  - Tests: ' + target, '  - Tests: tests/');
  const r = await integrated(true, plan);
  try {
    const beforeTree = r.git(['rev-parse', 'HEAD^{tree}'], r.integration);
    fs.rmSync(path.join(r.integration, target));
    const done = await commit(r, removal);
    assert.equal(done.output.ok, true, JSON.stringify(done));
    const [record] = cleanups(r);
    assert.deepEqual(record!.data['trees'], { SC1: beforeTree });
  } finally { r.cleanup(); }
});
