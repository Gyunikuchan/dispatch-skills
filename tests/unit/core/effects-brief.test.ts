import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { ResultEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { qualityBar, qualitySections, type QualityConsumer } from '../../../skills/dispatch/scripts/domain/prompt.ts';
import { createWriteBrief } from '../../../skills/dispatch/scripts/effects/write-brief.ts';
import { createPrepareReview } from '../../../skills/dispatch/scripts/effects/prepare-review.ts';
import { createGit } from '../../../skills/dispatch/scripts/effects/git.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../skills/dispatch');
const only = (events: readonly ResultEvent[]) => { assert.equal(events.length, 1); return events[0] as ResultEvent; };

test('prewrite-level: task brief renders bound context, worktree, checkpoint, and exact self-check', async () => {
  const runDir = tempDir();
  const envelopePath = path.join(runDir, 'implement.write-brief.1', 'outcome.json');
  const input = {
    planPath: 'docs/example.plan.md', planHash: `sha256:${'a'.repeat(64)}`, governingOutcome: { title: 'Example', outcome: 'Deliver behavior' },
    settledScope: { paths: ['src/a.ts'], changes: [{ action: 'MODIFY', path: 'src/a.ts' }] }, criteria: [{ id: 'SC1', title: 'works' }],
    rules: { writerStage: 'task' }, task: { id: 'T1', title: 'Feature', worktree: 'run/wt/task-t1', inputRevision: 'b0', checkpoint: { root: 'run/wt/task-t1', paths: ['tests/a.test.ts'] } }, priorFindings: [{ id: 'R1-F001' }], evidence: ['Evidence, not specification. Previous command passed.'],
    envelopeSchema: { schemaVersion: 1, stage: 'COMPLETE', evidence: 'CRITERION format' }, selfCheck: 'dispatch send --dry-run <Expected Envelope Path>',
  };
  const result = only(await createWriteBrief({ skillRoot: SKILL_ROOT })({ kind: 'write-brief', id: 'implement.write-brief.1', stage: 'task', input }, fakePorts(), { runDir, attempt: 1 }));
  assert.equal(result.type, 'BRIEF_READY');
  if (result.type !== 'BRIEF_READY') return;
  const text = fs.readFileSync(result.path, 'utf8');
  assert.ok(text.includes('docs/example.plan.md'));
  assert.ok(text.includes(input.planHash));
  assert.ok(text.includes('src/a.ts'));
  assert.ok(text.includes('Prior review findings'));
  assert.ok(text.includes('Evidence, not specification.'));
  assert.ok(text.includes('Envelope schema'));
  assert.ok(text.includes(`dispatch send --dry-run ${envelopePath}`));
  assert.ok(text.includes('run/wt/task-t1'));
  assert.ok(text.includes(`dispatch checkpoint --root "run/wt/task-t1" --out "${path.join(runDir, 'implement.write-brief.1', 'red.json')}" -- "tests/a.test.ts"`));
  assert.equal(result.sha256, `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`);
  assert.equal(result.envelopePath, envelopePath);
  assert.equal(fs.existsSync(envelopePath), false);
});

test('brief-shared-context: brief carries shared plan range and sibling tasks', async () => {
  const source = [
    '# Example plan', '', '> **TL;DR:** Deliver behavior.', '', '## Background', '- Shared background fact.', '',
    '## Task Map', '| ID | Title | Outcome | Prerequisites | Criteria |', '| --- | --- | --- | --- | --- |', '| T1 | Feature | Deliver feature. | none | SC1 |', '| T2 | Sibling | Deliver sibling. | T1 | SC2 |', '', '## Proposed Changes', '',
    '### T1 — Feature', '', '#### [MODIFY] src/a.ts', '  - Changes: Own change detail.', '',
    '### T2 — Sibling', '', '#### [MODIFY] src/b.ts', '  - Changes: Sibling change detail.', '',
  ].join('\n');
  const sharedContext = source.slice(0, source.indexOf('## Proposed Changes'));
  const siblingTasks = [{ id: 'T2', outcome: 'Sibling — Deliver sibling.', prerequisites: ['T1'], criteria: ['SC2'], paths: ['src/b.ts'], overlap: [] }];
  const runDir = tempDir();
  const input = {
    planPath: 'docs/example.plan.md', planHash: `sha256:${'a'.repeat(64)}`, governingOutcome: { title: 'Example', outcome: 'Deliver behavior' }, sharedContext, siblingTasks,
    settledScope: { paths: ['src/a.ts'] }, criteria: [{ id: 'SC1', title: 'works' }], task: { id: 'T1', title: 'Feature', worktree: 'run/wt/task-t1' },
  };
  const result = only(await createWriteBrief({ skillRoot: SKILL_ROOT })({ kind: 'write-brief', id: 'implement.write-brief.6', stage: 'task', input }, fakePorts(), { runDir, attempt: 1 }));
  assert.equal(result.type, 'BRIEF_READY'); if (result.type !== 'BRIEF_READY') return;
  const text = fs.readFileSync(result.path, 'utf8');
  assert.match(text, /## Shared plan context\n[\s\S]*# Example plan[\s\S]*Shared background fact\.[\s\S]*## Task Map\n\| ID \| Title \| Outcome \| Prerequisites \| Criteria \|/);
  assert.doesNotMatch(text, /Sibling change detail|Own change detail|## Proposed Changes/);
  assert.match(text, /## Sibling tasks\n\n- T2 \| Sibling — Deliver sibling\. \| prerequisites: T1 \| criteria: SC2 \| paths: `src\/b\.ts` \| overlap: none\n/);
  assert.match(text, /Read other plan sections only for a gap you name/);
});

test('hotfix template renders concrete limits, single-shot identity, external reasons and pre-RED restriction; retry carries root cause', async () => {
  const runDir = tempDir(), ports = fakePorts();
  const input = { rootCause: 'wrong mapping', stalledCheck: { command: 'check', logPath: 'failed.log', failureId: 'f1' }, hotfix: { maxFiles: 10, maxLines: 150, singleShot: true, model: 'writer-a', external: [{ path: 'env.txt', reason: 'repair environment' }], preRed: true, paths: ['tests/a.test.ts'] } };
  Object.assign(input, { envelopeSchema: { schemaVersion: 1, stage: 'COMPLETE', status: ['DONE', 'BLOCKED'] } });
  const event = only(await createWriteBrief({ skillRoot: SKILL_ROOT })({ kind: 'write-brief', id: 'implement.write-brief.2', stage: 'hotfix', input }, ports, { runDir, attempt: 1 }));
  assert.equal(event.type, 'BRIEF_READY'); if (event.type !== 'BRIEF_READY') return;
  const text = fs.readFileSync(event.path, 'utf8');
  for (const value of ['single-shot hot fix', 'wrong mapping', 'failed.log', '10', '150', 'writer-a', 'repair environment', 'return BLOCKED with the paths and reason', 'RED validation does not authorize other paths', 'taskless `WRITE_RECEIPT`', 'tests/a.test.ts']) assert.ok(text.includes(value), value);
  const retry = only(await createWriteBrief({ skillRoot: SKILL_ROOT })({ kind: 'write-brief', id: 'implement.write-brief.3', stage: 'task', input: { retryContext: { rootCause: 'wrong branch', failure: 'failed check identity f1' } } }, ports, { runDir, attempt: 1 }));
  assert.equal(retry.type, 'BRIEF_READY'); if (retry.type === 'BRIEF_READY') assert.match(fs.readFileSync(retry.path, 'utf8'), /wrong branch[\s\S]*failed check identity f1/);
});

test('prewrite-level: task briefs request scope live and echo briefHash; hotfix briefs block', async () => {
  const runDir = tempDir(), ports = fakePorts();
  const handler = createWriteBrief({ skillRoot: SKILL_ROOT });
  const taskInput = {
    planPath: 'docs/example.plan.md', planHash: `sha256:${'a'.repeat(64)}`, governingOutcome: { title: 'Example', outcome: 'Deliver behavior' },
    settledScope: { paths: ['src/a.ts'], changes: [{ action: 'MODIFY', path: 'src/a.ts' }] }, criteria: [{ id: 'SC1', title: 'works' }],
    rules: { writerStage: 'task' }, task: { id: 'T1', title: 'Feature', worktree: 'run/wt/task-t1', inputRevision: 'b0', checkpoint: { root: 'run/wt/task-t1', paths: [] } },
    envelopeSchema: { schemaVersion: 1, stage: 'COMPLETE', status: ['DONE', 'BLOCKED'] }, selfCheck: 'dispatch send --dry-run <Expected Envelope Path>',
  };
  const task = only(await handler({ kind: 'write-brief', id: 'implement.write-brief.4', stage: 'task', input: taskInput }, ports, { runDir, attempt: 1 }));
  assert.equal(task.type, 'BRIEF_READY'); if (task.type !== 'BRIEF_READY') return;
  const taskText = fs.readFileSync(task.path, 'utf8');
  assert.match(taskText, /send the orchestrator a writer request before that edit/);
  assert.match(taskText, /Stay live and keep working within the task paths/);
  assert.match(taskText, /echoes it as `briefHash` in the submitted receipt/);

  const hotfix = only(await handler({ kind: 'write-brief', id: 'implement.write-brief.5', stage: 'hotfix', input: {
    rootCause: 'wrong mapping', stalledCheck: { command: 'check', logPath: 'failed.log', failureId: 'f1' },
    hotfix: { maxFiles: 10, maxLines: 150, singleShot: true, model: 'writer-a', external: [], preRed: true, paths: ['src/a.ts'] },
    envelopeSchema: { schemaVersion: 1, stage: 'COMPLETE', status: ['DONE', 'BLOCKED'] },
  } }, ports, { runDir, attempt: 1 }));
  assert.equal(hotfix.type, 'BRIEF_READY'); if (hotfix.type !== 'BRIEF_READY') return;
  const hotfixText = fs.readFileSync(hotfix.path, 'utf8');
  assert.match(hotfixText, /stop before that work and return BLOCKED/);
  assert.doesNotMatch(hotfixText, /writer request before that edit/);
});

test('quality selection assembles every review and writer kind and reports selector failures', async () => {
  const dir = path.join(SKILL_ROOT, 'references', 'templates');
  const bar = fs.readFileSync(path.join(dir, 'quality-bar.md'), 'utf8');
  const runDir = tempDir(), ports = fakePorts();
  const read = ports.fs.readText;
  let selectedBar = bar;
  ports.fs.readText = (file) => file === path.join(dir, 'quality-bar.md') ? selectedBar : file === path.join(dir, 'review-prompt-unexpected.md') ? read(path.join(dir, 'review-prompt-design.md')) : read(file);
  const git = { ...createGit({ run: async () => '' }), diffNames: async () => ['src/a.ts'], log: async () => '' };
  const prepare = createPrepareReview({ cwd: tempDir(), skillRoot: SKILL_ROOT, git });
  const brief = createWriteBrief({ skillRoot: SKILL_ROOT });
  const target = path.join(runDir, 'artifact.md');
  fs.writeFileSync(target, '# Artifact\n');
  let id = 0;
  const review = (kind: string) => prepare({ kind: 'prepare-review', id: `review.${++id}`, round: 1, review: { kind, target: kind === 'code' ? 'HEAD' : target, roster: [{ slot: 'codex[0]' }] }, scope: { scope: 'full' } }, ports, { runDir, attempt: 1 });
  const writer = (stage: 'task' | 'hotfix') => brief({ kind: 'write-brief', id: `write-brief.${++id}`, stage, input: {} }, ports, { runDir, attempt: 1 });
  const assertQuality = (text: string, consumer: QualityConsumer) => {
    const quality = qualityBar(bar, consumer).split('## quality\n\n')[1]!;
    assert.equal(text.split(quality).length, 2, consumer);
    for (const [section, marker] of [['shared', '- Spec alignment:'], ['code', '- Security and resources:'], ['plan', '- Task graph:'], ['design', '- Decisions:']] as const) {
      assert.equal(text.split(marker).length - 1, (qualitySections[consumer] as readonly string[]).includes(section) ? 1 : 0, `${consumer}: ${section}`);
    }
    assert.ok(text.includes('Plan scope, write boundaries, the outcome envelope and verification protocol, and safety rules stay fixed.'));
    if (consumer === 'code' || consumer === 'writer') assert.doesNotMatch(text, /- Adjacent findings:|Adjacent findings in plan and design reviews|nearest plan or design heading/);
    else assert.match(text, new RegExp(`nearest ${consumer} heading as locus`));
  };
  for (const kind of ['code', 'plan', 'design'] as const) {
    const event = only(await review(kind));
    assert.equal(event.type, 'REVIEW_PREPARED');
    if (event.type === 'REVIEW_PREPARED') assertQuality(ports.fs.readText(event.promptPaths['codex[0]']!), kind);
  }
  for (const stage of ['task', 'hotfix'] as const) {
    const event = only(await writer(stage));
    assert.equal(event.type, 'BRIEF_READY');
    if (event.type === 'BRIEF_READY') assertQuality(ports.fs.readText(event.path), 'writer');
  }
  const valid = ['shared', 'code', 'plan', 'design'].map((section) => `## ${section}\n${section} rule`).join('\n');
  const consumers = [
    ...(['code', 'plan', 'design'] as const).map((kind) => ({ consumer: kind, invoke: () => review(kind) })),
    ...(['task', 'hotfix'] as const).map((stage) => ({ consumer: 'writer' as const, invoke: () => writer(stage) })),
  ];
  for (const { consumer, invoke } of consumers) {
    for (const section of qualitySections[consumer]) {
      for (const empty of [false, true]) {
        selectedBar = valid.replace(`## ${section}\n${section} rule`, empty ? `## ${section}\n   ` : '');
        const event = only(await invoke());
        assert.equal(event.type, 'EFFECT_FAILED');
        if (event.type === 'EFFECT_FAILED') assert.equal(event.detail, `${empty ? 'Empty' : 'Missing'} quality section: ${section}`);
      }
    }
    selectedBar = valid + '\n## shared\nagain';
    const event = only(await invoke());
    assert.equal(event.type, 'EFFECT_FAILED');
    if (event.type === 'EFFECT_FAILED') assert.match(event.detail, /declares section "shared" twice/);
  }
  selectedBar = valid;
  const unknown = only(await review('unexpected'));
  assert.equal(unknown.type, 'EFFECT_FAILED');
  if (unknown.type === 'EFFECT_FAILED') assert.equal(unknown.detail, 'Unknown quality consumer: unexpected');
  // Ask's inline prompt does not consume the bar, even when selection would fail.
  selectedBar = '';
  const ask = only(await review('ask'));
  assert.equal(ask.type, 'REVIEW_PREPARED');
  if (ask.type === 'REVIEW_PREPARED') assert.doesNotMatch(ports.fs.readText(ask.promptPaths['codex[0]']!), /Spec alignment:|Security and resources:/);
});

test('prepare-review-git-log: extracts commit messages and falls back on error or empty', async () => {
  const tmp = tempDir();
  const runDir = tempDir();
  const ports = fakePorts();
  let logResult = 'feat: commit title\n\ncommit description';
  let logCalledWith: string | null = null;
  const git = {
    ...createGit({ run: async () => '' }),
    diffNames: async () => ['src/a.ts'],
    log: async (_cwd: string, range: string) => {
      logCalledWith = range;
      if (range === 'error..range') throw new Error('git log failed');
      return logResult;
    },
  };
  const handler = createPrepareReview({ cwd: tmp, skillRoot: SKILL_ROOT, git });

  // 1. Extracts commit messages for commit range without context
  const [res1] = await handler({
    kind: 'prepare-review', id: 'p1', round: 1,
    review: { kind: 'code', target: 'main..HEAD', roster: [{ slot: 'codex[0]' }], context: null },
    scope: { scope: 'full' },
  }, ports, { runDir, attempt: 1 });
  assert.equal(res1?.type, 'REVIEW_PREPARED');
  const prompt1 = ports.fs.readText(res1?.promptPaths['codex[0]']!);
  assert.match(prompt1, /- Task: feat: commit title\n\ncommit description/);
  assert.equal(logCalledWith, 'main..HEAD');

  // 2. Explicit context bypasses git log
  logCalledWith = null;
  const [res2] = await handler({
    kind: 'prepare-review', id: 'p2', round: 1,
    review: { kind: 'code', target: 'main..HEAD', roster: [{ slot: 'codex[0]' }], context: 'Explicit intent' },
    scope: { scope: 'full' },
  }, ports, { runDir, attempt: 1 });
  assert.equal(res2?.type, 'REVIEW_PREPARED');
  const prompt2 = ports.fs.readText(res2?.promptPaths['codex[0]']!);
  assert.match(prompt2, /- Task: Explicit intent/);
  assert.equal(logCalledWith, null);

  // 3. Empty log falls back to default
  logResult = '';
  const [res3] = await handler({
    kind: 'prepare-review', id: 'p3', round: 1,
    review: { kind: 'code', target: 'main..HEAD', roster: [{ slot: 'codex[0]' }], context: null },
    scope: { scope: 'full' },
  }, ports, { runDir, attempt: 1 });
  assert.equal(res3?.type, 'REVIEW_PREPARED');
  const prompt3 = ports.fs.readText(res3?.promptPaths['codex[0]']!);
  assert.match(prompt3, /- Task: Review the selected changes\./);

  // 4. Git error falls back to default
  const [res4] = await handler({
    kind: 'prepare-review', id: 'p4', round: 1,
    review: { kind: 'code', target: 'error..range', roster: [{ slot: 'codex[0]' }], context: null },
    scope: { scope: 'full' },
  }, ports, { runDir, attempt: 1 });
  assert.equal(res4?.type, 'REVIEW_PREPARED');
  const prompt4 = ports.fs.readText(res4?.promptPaths['codex[0]']!);
  assert.match(prompt4, /- Task: Review the selected changes\./);
});

