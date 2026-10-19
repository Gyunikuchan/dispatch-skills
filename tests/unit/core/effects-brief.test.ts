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
import { memoryRunFs } from '../../helpers/memory-run-fs.ts';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../skills/dispatch');
const only = (events: readonly ResultEvent[]) => { assert.equal(events.length, 1); return events[0] as ResultEvent; };

test('governing spec supplies every review kind and writer brief without legacy intent', async () => {
  const runDir = tempDir(), ports = fakePorts();
  memoryRunFs(ports, runDir);
  const specPath = path.join(runDir, 'intent.spec.md');
  ports.fs.writeAtomic(specPath, '# Spec\n\n## Intent & Problem\n\nSettled objective.\n\n## Requirements\nREQ-1: SPEC-BYTES-REFERENCE-ONLY\n');
  const governingSpec = { path: specPath, hash: `sha256:${ports.fs.hashFile(specPath)}` };
  const target = path.join(runDir, 'artifact.md'); ports.fs.writeAtomic(target, '# Artifact\n');
  let calls = 0;
  const git = { ...createGit({ run: async () => '' }), diffNames: async () => ['src/a.ts'], log: async () => { calls++; return 'Commit intent'; } };
  for (const kind of ['code', 'plan', 'design']) {
    const event = only(await createPrepareReview({ cwd: runDir, skillRoot: SKILL_ROOT, git })({ kind: 'prepare-review', id: `spec.${kind}`, round: 1, review: { kind, target: kind === 'code' ? 'base..HEAD' : target, governingSpec, context: 'Legacy intent', roster: [{ slot: 'codex[0]' }] }, scope: { scope: 'full' } }, ports, { runDir, attempt: 1 }));
    assert.equal(event.type, 'REVIEW_PREPARED'); if (event.type !== 'REVIEW_PREPARED') continue;
    const prompt = ports.fs.readText(event.promptPaths['codex[0]']!);
    assert.ok(prompt.includes(specPath)); assert.ok(prompt.includes(governingSpec.hash));
    assert.doesNotMatch(prompt, /Legacy intent|Commit intent|SPEC-BYTES-REFERENCE-ONLY/);
    assert.match(prompt, /- Focus: General review/);
    assert.match(prompt, /Read the whole spec/);
    if (kind === 'code') assert.match(prompt, /- Task: Settled objective\./);
  }
  assert.equal(calls, 0);
  const focused = only(await createPrepareReview({ cwd: runDir, skillRoot: SKILL_ROOT, git })({ kind: 'prepare-review', id: 'spec.focus', round: 1, review: { kind: 'code', target: 'HEAD', governingSpec, context: JSON.stringify({ invocationContext: 'Legacy intent', invocationLevel: 'high' }), governing: { finalFocusPaths: ['src/focus.ts'] }, roster: [{ slot: 'codex[0]' }] }, scope: { scope: 'full' } }, ports, { runDir, attempt: 1 }));
  assert.equal(focused.type, 'REVIEW_PREPARED');
  if (focused.type === 'REVIEW_PREPARED') {
    const prompt = ports.fs.readText(focused.promptPaths['codex[0]']!);
    assert.match(prompt, /- Focus: src\/focus.ts/); assert.doesNotMatch(prompt, /Legacy intent/);
  }
  for (const stage of ['task', 'hotfix'] as const) {
    for (const present of [true, false]) {
      const event = only(await createWriteBrief({ skillRoot: SKILL_ROOT })({ kind: 'write-brief', id: `spec.${stage}.${present}`, stage, input: present ? { governingSpec } : {} }, ports, { runDir, attempt: 1 }));
      assert.equal(event.type, 'BRIEF_READY'); if (event.type !== 'BRIEF_READY') continue;
      const brief = ports.fs.readText(event.path);
      assert.equal(brief.includes('## Governing spec'), present);
      if (present) { assert.ok(brief.includes(specPath)); assert.ok(brief.includes(governingSpec.hash)); }
    }
  }
});

test('prewrite-level: task brief renders bound context, worktree, checkpoint, and exact self-check', async () => {
  const runDir = tempDir(), ports = fakePorts();
  memoryRunFs(ports, runDir);
  const envelopePath = path.join(runDir, 'implement.write-brief.1', 'outcome.json');
  const input = {
    planPath: 'docs/example.plan.md', planHash: `sha256:${'a'.repeat(64)}`, governingOutcome: { title: 'Example', outcome: 'Deliver behavior' },
    settledScope: { paths: ['src/a.ts'], changes: [{ action: 'MODIFY', path: 'src/a.ts' }] }, criteria: [{ id: 'SC1', title: 'works' }],
    rules: { writerStage: 'task' }, task: { id: 'T1', title: 'Feature', worktree: 'run/wt/task-t1', inputRevision: 'b0', checkpoint: { root: 'run/wt/task-t1', paths: ['tests/a.test.ts'] } }, priorFindings: [{ id: 'R1-F001' }], evidence: ['Evidence, not specification. Previous command passed.'],
    envelopeSchema: { schemaVersion: 1, stage: 'COMPLETE', evidence: 'CRITERION format' }, selfCheck: 'dispatch send --dry-run <Expected Envelope Path>',
  };
  const result = only(await createWriteBrief({ skillRoot: SKILL_ROOT })({ kind: 'write-brief', id: 'implement.write-brief.1', stage: 'task', input }, ports, { runDir, attempt: 1 }));
  assert.equal(result.type, 'BRIEF_READY');
  if (result.type !== 'BRIEF_READY') return;
  const text = ports.fs.readText(result.path);
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
  assert.equal(ports.fs.exists(envelopePath), false);
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
  const runDir = tempDir(), ports = fakePorts();
  memoryRunFs(ports, runDir);
  const input = {
    planPath: 'docs/example.plan.md', planHash: `sha256:${'a'.repeat(64)}`, governingOutcome: { title: 'Example', outcome: 'Deliver behavior' }, sharedContext, siblingTasks,
    settledScope: { paths: ['src/a.ts'] }, criteria: [{ id: 'SC1', title: 'works' }], task: { id: 'T1', title: 'Feature', worktree: 'run/wt/task-t1' },
  };
  const result = only(await createWriteBrief({ skillRoot: SKILL_ROOT })({ kind: 'write-brief', id: 'implement.write-brief.6', stage: 'task', input }, ports, { runDir, attempt: 1 }));
  assert.equal(result.type, 'BRIEF_READY'); if (result.type !== 'BRIEF_READY') return;
  const text = ports.fs.readText(result.path);
  assert.match(text, /## Shared plan context\n[\s\S]*# Example plan[\s\S]*Shared background fact\.[\s\S]*## Task Map\n\| ID \| Title \| Outcome \| Prerequisites \| Criteria \|/);
  assert.doesNotMatch(text, /Sibling change detail|Own change detail|## Proposed Changes/);
  assert.match(text, /## Sibling tasks\n\n- T2 \| Sibling — Deliver sibling\. \| prerequisites: T1 \| criteria: SC2 \| paths: `src\/b\.ts` \| overlap: none\n/);
  assert.match(text, /Read other plan sections only for a gap you name/);
});

test('hotfix template renders concrete limits, single-shot identity, external reasons and pre-RED restriction; retry carries root cause', async () => {
  const runDir = tempDir(), ports = fakePorts();
  memoryRunFs(ports, runDir);
  const input = { rootCause: 'wrong mapping', stalledCheck: { command: 'check', logPath: 'failed.log', failureId: 'f1' }, hotfix: { maxFiles: 10, maxLines: 150, singleShot: true, model: 'writer-a', external: [{ path: 'env.txt', reason: 'repair environment' }], preRed: true, paths: ['tests/a.test.ts'] } };
  Object.assign(input, { envelopeSchema: { schemaVersion: 1, stage: 'COMPLETE', status: ['DONE', 'BLOCKED'] } });
  const event = only(await createWriteBrief({ skillRoot: SKILL_ROOT })({ kind: 'write-brief', id: 'implement.write-brief.2', stage: 'hotfix', input }, ports, { runDir, attempt: 1 }));
  assert.equal(event.type, 'BRIEF_READY'); if (event.type !== 'BRIEF_READY') return;
  const text = ports.fs.readText(event.path);
  for (const value of ['single-shot hot fix', 'wrong mapping', 'failed.log', '10', '150', 'writer-a', 'repair environment', 'return BLOCKED with the paths and reason', 'RED validation does not authorize other paths', 'taskless `WRITE_RECEIPT`', 'tests/a.test.ts']) assert.ok(text.includes(value), value);
  const retry = only(await createWriteBrief({ skillRoot: SKILL_ROOT })({ kind: 'write-brief', id: 'implement.write-brief.3', stage: 'task', input: { retryContext: { rootCause: 'wrong branch', failure: 'failed check identity f1' } } }, ports, { runDir, attempt: 1 }));
  assert.equal(retry.type, 'BRIEF_READY'); if (retry.type === 'BRIEF_READY') assert.match(ports.fs.readText(retry.path), /wrong branch[\s\S]*failed check identity f1/);
});

test('prewrite-level: task briefs request scope live and echo briefHash; hotfix briefs block', async () => {
  const runDir = tempDir(), ports = fakePorts();
  memoryRunFs(ports, runDir);
  const handler = createWriteBrief({ skillRoot: SKILL_ROOT });
  const taskInput = {
    planPath: 'docs/example.plan.md', planHash: `sha256:${'a'.repeat(64)}`, governingOutcome: { title: 'Example', outcome: 'Deliver behavior' },
    settledScope: { paths: ['src/a.ts'], changes: [{ action: 'MODIFY', path: 'src/a.ts' }] }, criteria: [{ id: 'SC1', title: 'works' }],
    rules: { writerStage: 'task' }, task: { id: 'T1', title: 'Feature', worktree: 'run/wt/task-t1', inputRevision: 'b0', checkpoint: { root: 'run/wt/task-t1', paths: [] } },
    envelopeSchema: { schemaVersion: 1, stage: 'COMPLETE', status: ['DONE', 'BLOCKED'] }, selfCheck: 'dispatch send --dry-run <Expected Envelope Path>',
  };
  const task = only(await handler({ kind: 'write-brief', id: 'implement.write-brief.4', stage: 'task', input: taskInput }, ports, { runDir, attempt: 1 }));
  assert.equal(task.type, 'BRIEF_READY'); if (task.type !== 'BRIEF_READY') return;
  const taskText = ports.fs.readText(task.path);
  assert.match(taskText, /send the orchestrator a writer request before that edit/);
  assert.match(taskText, /Stay live and keep working within the task paths/);
  assert.match(taskText, /echoes it as `briefHash` in the submitted receipt/);

  const hotfix = only(await handler({ kind: 'write-brief', id: 'implement.write-brief.5', stage: 'hotfix', input: {
    rootCause: 'wrong mapping', stalledCheck: { command: 'check', logPath: 'failed.log', failureId: 'f1' },
    hotfix: { maxFiles: 10, maxLines: 150, singleShot: true, model: 'writer-a', external: [], preRed: true, paths: ['src/a.ts'] },
    envelopeSchema: { schemaVersion: 1, stage: 'COMPLETE', status: ['DONE', 'BLOCKED'] },
  } }, ports, { runDir, attempt: 1 }));
  assert.equal(hotfix.type, 'BRIEF_READY'); if (hotfix.type !== 'BRIEF_READY') return;
  const hotfixText = ports.fs.readText(hotfix.path);
  assert.match(hotfixText, /stop before that work and return BLOCKED/);
  assert.doesNotMatch(hotfixText, /writer request before that edit/);
});

test('quality selection assembles every review and writer kind and reports selector failures', async () => {
  const dir = path.join(SKILL_ROOT, 'references', 'templates');
  const bar = fs.readFileSync(path.join(dir, 'quality-bar.md'), 'utf8');
  const runDir = tempDir(), ports = fakePorts();
  memoryRunFs(ports, runDir);
  const read = ports.fs.readText;
  let selectedBar = bar;
  ports.fs.readText = (file) => file === path.join(dir, 'quality-bar.md') ? selectedBar : file === path.join(dir, 'review-prompt-unexpected.md') ? read(path.join(dir, 'review-prompt-design.md')) : read(file);
  const git = { ...createGit({ run: async () => '' }), diffNames: async () => ['src/a.ts'], log: async () => '' };
  const prepare = createPrepareReview({ cwd: runDir, skillRoot: SKILL_ROOT, git });
  const brief = createWriteBrief({ skillRoot: SKILL_ROOT });
  const target = path.join(runDir, 'artifact.md');
  ports.fs.writeAtomic(target, '# Artifact\n');
  let id = 0;
  const review = (kind: string) => prepare({ kind: 'prepare-review', id: `review.${++id}`, round: 1, review: { kind, target: kind === 'code' ? 'HEAD' : target, roster: [{ slot: 'codex[0]' }] }, scope: { scope: 'full' } }, ports, { runDir, attempt: 1 });
  const writer = (stage: 'task' | 'hotfix') => brief({ kind: 'write-brief', id: `write-brief.${++id}`, stage, input: {} }, ports, { runDir, attempt: 1 });
  const codeRules = [
    '- Correctness and domain invariants:',
    '- Robustness and compatibility:',
    '- Interface quality:',
    '- Naming and structure:',
    'runtime behavior, and type validity',
    'empty, zero, and boundary inputs',
    'unhandled branches, unguarded indexing',
    'floating promises',
    'partial failures, floating promises, partial updates, races, and unbounded designs',
    'affected callers, persisted schemas, and serialized formats',
    'version skew with graceful degradation and rollback',
    'accessible UI and ergonomic CLI/API behavior',
    'clear names',
    'unnecessary branches',
    'pass-through modules, speculative seams (one adapter is hypothetical), excess coupling',
    'shared root causes',
  ];
  const assertQuality = (text: string, consumer: QualityConsumer) => {
    const quality = qualityBar(bar, consumer).split('## quality\n\n')[1]!;
    assert.equal(text.split(quality).length, 2, consumer);
    for (const [section, marker] of [['shared', '- Spec alignment:'], ['code', '- Security and resources:'], ['plan', '- Task graph:'], ['design', '- Decisions:']] as const) {
      assert.equal(text.split(marker).length - 1, (qualitySections[consumer] as readonly string[]).includes(section) ? 1 : 0, `${consumer}: ${section}`);
    }
    if (consumer === 'code' || consumer === 'plan' || consumer === 'writer') {
      for (const rule of codeRules) assert.ok(text.includes(rule), `${consumer}: ${rule}`);
    } else {
      for (const rule of codeRules.slice(0, 4)) assert.ok(!text.includes(rule), `${consumer}: ${rule}`);
    }
    assert.ok(text.includes('Plan scope, write boundaries, the outcome envelope and verification protocol, and safety rules stay fixed.'));
    assert.ok(text.includes('Applicable host rule files govern first.'), consumer);
    if (consumer === 'writer') {
      assert.doesNotMatch(text, /Report an adjacent finding only when|nearest plan or design heading|path:L<line>/);
    } else {
      assert.ok(text.includes('Report a concrete existing-code defect encountered while inspecting the selected target and interfaces or call sites needed to verify it; those interfaces or call sites may be outside Scope only as needed to substantiate the defect.'), consumer);
      if (consumer === 'code') assert.ok(text.includes('path:L<line>'), consumer);
      else assert.match(text, new RegExp(`nearest ${consumer} heading as locus`));
    }
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

test('governing spec defaults ignore context and Git log and unreadable supplied specs fail', async () => {
  const runDir = tempDir(), ports = fakePorts();
  memoryRunFs(ports, runDir);
  let logCalls = 0;
  const git = { ...createGit({ run: async () => '' }), diffNames: async () => ['src/a.ts'], log: async () => { logCalls++; return 'Commit intent'; } };
  const handler = createPrepareReview({ cwd: runDir, skillRoot: SKILL_ROOT, git });
  for (const body of [null, '# Spec\n## Intent & Problem\n\n## Requirements\nREQ-1', '# Spec\n## Requirements\nREQ-1']) {
    const specPath = path.join(runDir, 'empty.spec.md');
    if (body !== null) ports.fs.writeAtomic(specPath, body);
    const review = { kind: 'code', target: 'base..HEAD', context: 'Legacy intent', roster: [{ slot: 'codex[0]' }], ...(body !== null ? { governingSpec: { path: specPath, hash: `sha256:${crypto.createHash('sha256').update(body).digest('hex')}` } } : {}) };
    const event = only(await handler({ kind: 'prepare-review', id: 'defaults', round: 1, review, scope: {} }, ports, { runDir, attempt: 1 }));
    assert.equal(event.type, 'REVIEW_PREPARED'); if (event.type !== 'REVIEW_PREPARED') continue;
    const prompt = ports.fs.readText(event.promptPaths['codex[0]']!);
    assert.match(prompt, /- Task: Review the selected changes\./);
    assert.doesNotMatch(prompt, /Legacy intent|Commit intent/);
    if (body === null) assert.match(prompt, /Spec Path: None\n- Spec Hash: None/);
  }
  assert.equal(logCalls, 0);
  for (const kind of ['code', 'plan', 'design']) {
    const target = path.join(runDir, 'artifact.md'); ports.fs.writeAtomic(target, '# Artifact');
    const event = only(await handler({ kind: 'prepare-review', id: 'missing', round: 1, review: { kind, target: kind === 'code' ? 'HEAD' : target, governingSpec: { path: 'absent.spec.md', hash: 'sha256:abc' }, roster: [{ slot: 'codex[0]' }] }, scope: {} }, ports, { runDir, attempt: 1 }));
    assert.equal(event.type, 'EFFECT_FAILED');
  }
});



// SECTION: Amendment deltas — a live writer holding its base brief reads only the current task sections.

const deltaInput = {
  planPath: 'docs/example.plan.md', planHash: `sha256:${'a'.repeat(64)}`, governingOutcome: { title: 'Example', outcome: 'Deliver behavior' },
  sharedContext: '# Example plan\n\n## Background\n- SHARED-CONTEXT-MARKER', siblingTasks: [{ id: 'T2', outcome: 'SIBLING-ROW-MARKER', prerequisites: [], criteria: ['SC2'], paths: ['src/b.ts'], overlap: [] }],
  task: { id: 'T1', title: 'Feature', summary: 'TASK-SUMMARY-MARKER', dependents: ['T3'], attempt: 1, signature: 'SIGNATURE-MARKER', worktree: 'run/wt/task-t1', inputRevision: 'b0', constraints: ['Keep the public API stable.'], prerequisites: [{ id: 'T0', integrated: 'i-T0' }], checkpoint: { root: 'run/wt/task-t1', paths: ['tests/a.test.ts'] }, amendmentNotice: 'SC1 now requires speed.' },
  settledScope: { paths: ['src/a.ts', 'tests/a.test.ts'], approvedPaths: ['src/a.ts', 'tests/a.test.ts'], changes: [{ action: 'MODIFY', path: 'src/a.ts' }] },
  revisionNotice: { notice: 'SC1 now requires speed.', revision: 'amend-1', rationale: 'Plan changed mid-run.' },
  previousBriefs: [{ path: 'run/base/brief.md', sha256: `sha256:${'b'.repeat(64)}`, scope: '{}' }],
  criteria: [{ id: 'SC1', title: 'works fast', verify: [{ command: 'node --test tests/a.test.ts', final: false }] }],
  envelopeSchema: { schemaVersion: 1, stage: 'COMPLETE' }, rules: { writerStage: 'task', keyDecisions: ['RULES-MARKER'] }, priorFindings: [{ id: 'FINDING-MARKER' }], evidence: ['EVIDENCE-MARKER'],
  selfCheck: 'dispatch send --dry-run <Expected Envelope Path>',
};
const deltaBase = { path: 'run/base/brief.md', sha256: `sha256:${'b'.repeat(64)}`, seq: 2 };

test('amendment delta carries the base binding and current task sections, and leaves the full brief bytes unchanged', async () => {
  const runDir = tempDir(), ports = fakePorts();
  memoryRunFs(ports, runDir);
  const handler = createWriteBrief({ skillRoot: SKILL_ROOT });
  const id = 'implement.write-brief.7';
  const withDelta = only(await handler({ kind: 'write-brief', id, stage: 'task', input: { ...deltaInput, deltaBase } }, ports, { runDir, attempt: 1 }));
  assert.equal(withDelta.type, 'BRIEF_READY'); if (withDelta.type !== 'BRIEF_READY') return;
  const full = ports.fs.readText(withDelta.path);
  assert.ok(withDelta.delta, 'delta returned');
  const text = ports.fs.readText(withDelta.delta!.path);
  assert.equal(withDelta.delta!.path, path.join(runDir, id, 'delta.md'));
  assert.equal(withDelta.delta!.sha256, `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`);
  assert.notEqual(withDelta.delta!.sha256, withDelta.sha256);
  const envelopePath = path.join(runDir, id, 'outcome.json');
  for (const value of [
    `Base: run/base/brief.md · sha256:${'b'.repeat(64)}`, 'Amendment: 2', 'SC1 now requires speed.', 'amend-1', 'Plan changed mid-run.',
    envelopePath, `dispatch send --dry-run ${envelopePath}`, `dispatch checkpoint --root "run/wt/task-t1" --out "${path.join(runDir, id, 'red.json')}" -- "tests/a.test.ts"`,
    'run/wt/task-t1', 'Keep the public API stable.', 'i-T0', 'tests/a.test.ts', 'node --test tests/a.test.ts', 'works fast',
  ]) assert.ok(text.includes(value), value);
  for (const excluded of ['SHARED-CONTEXT-MARKER', 'SIBLING-ROW-MARKER', 'RULES-MARKER', 'FINDING-MARKER', 'EVIDENCE-MARKER', 'Spec alignment:', 'Security and resources:', 'SIGNATURE-MARKER']) assert.ok(!text.includes(excluded), excluded);
  assert.ok(Buffer.byteLength(text) * 3 < Buffer.byteLength(full), 'delta is a small fraction of the full brief');
  assert.ok(text.includes('TASK-SUMMARY-MARKER') && text.includes('T3'), 'delta carries the whole current task section');
  for (const heading of ['## Task, graph, and worktree', '## Settled scope', '## Criteria']) assert.ok(text.includes(heading) && full.includes(heading), heading);

  const plainRun = tempDir(), plainPorts = fakePorts();
  memoryRunFs(plainPorts, plainRun);
  const plain = only(await handler({ kind: 'write-brief', id, stage: 'task', input: deltaInput }, plainPorts, { runDir: plainRun, attempt: 1 }));
  assert.equal(plain.type, 'BRIEF_READY'); if (plain.type !== 'BRIEF_READY') return;
  assert.equal(plainPorts.fs.readText(plain.path).split(plainRun).join('<run>'), full.split(runDir).join('<run>'));
});

test('amendment delta is absent without a delta base and for hotfix briefs', async () => {
  const runDir = tempDir(), ports = fakePorts();
  memoryRunFs(ports, runDir);
  const handler = createWriteBrief({ skillRoot: SKILL_ROOT });
  const plain = only(await handler({ kind: 'write-brief', id: 'implement.write-brief.8', stage: 'task', input: deltaInput }, ports, { runDir, attempt: 1 }));
  assert.equal(plain.type, 'BRIEF_READY'); if (plain.type !== 'BRIEF_READY') return;
  assert.equal(plain.delta, undefined);
  assert.equal(ports.fs.exists(path.join(runDir, 'implement.write-brief.8', 'delta.md')), false);
  const hotfix = only(await handler({ kind: 'write-brief', id: 'implement.write-brief.9', stage: 'hotfix', input: { deltaBase, hotfix: { maxFiles: 1, maxLines: 10, singleShot: true, model: 'writer-a', external: [], preRed: false, paths: ['src/a.ts'] } } }, ports, { runDir, attempt: 1 }));
  assert.equal(hotfix.type, 'BRIEF_READY'); if (hotfix.type !== 'BRIEF_READY') return;
  assert.equal(hotfix.delta, undefined);
  assert.equal(ports.fs.exists(path.join(runDir, 'implement.write-brief.9', 'delta.md')), false);
});

// SECTION: Contract self-check — briefs list contract commands and carry an integration gate failure until it passes.

const contractFailure = { previous: 'i-T0', route: 'resume', rows: [
  { command: 'npm run lint', exit: 1, logPath: 'run/logs/lint.log', passedBefore: true },
  { command: 'npm run typecheck', exit: 2, logPath: 'run/logs/typecheck.log', passedBefore: false },
] };

test('contract self-check section renders commands and gate failures in full and delta briefs, and is absent without either key', async () => {
  const handler = createWriteBrief({ skillRoot: SKILL_ROOT });
  const render = async (input: Record<string, unknown>) => {
    const runDir = tempDir(), ports = fakePorts();
    memoryRunFs(ports, runDir);
    const event = only(await handler({ kind: 'write-brief', id: 'implement.write-brief.11', stage: 'task', input: { ...input, deltaBase } }, ports, { runDir, attempt: 1 }));
    assert.equal(event.type, 'BRIEF_READY'); if (event.type !== 'BRIEF_READY') throw new Error('no brief');
    return { full: ports.fs.readText(event.path).split(runDir).join('<run>'), delta: ports.fs.readText(event.delta!.path) };
  };
  const checks = await render({ ...deltaInput, contractChecks: ['npm run lint', 'npm run typecheck'] });
  for (const text of [checks.full, checks.delta]) {
    assert.match(text, /## Contract self-check/);
    for (const value of ['npm run lint', 'npm run typecheck', 'CHECK <command> | exit <code>']) assert.ok(text.includes(value), value);
    assert.doesNotMatch(text, /Integration contract failure/);
  }
  const failed = await render({ ...deltaInput, contractFailure });
  for (const text of [failed.full, failed.delta]) {
    assert.match(text, /## Integration contract failure/);
    for (const value of ['npm run lint', 'exit 1', 'run/logs/lint.log', 'npm run typecheck', 'exit 2', 'run/logs/typecheck.log', 'resubmit', 'REQUEST', 'BLOCKED']) assert.ok(text.includes(value), value);
    assert.equal(text.split('passed before this task integrated').length - 1, 1, 'passed-before clause only for the passedBefore row');
    assert.match(text, /npm run lint[^\n]*passed before this task integrated/);
    assert.doesNotMatch(text, /## Contract self-check/);
  }
  const plain = await render(deltaInput);
  const plainRun = tempDir(), plainPorts = fakePorts();
  memoryRunFs(plainPorts, plainRun);
  const baseline = only(await handler({ kind: 'write-brief', id: 'implement.write-brief.11', stage: 'task', input: { ...deltaInput, deltaBase, contractChecks: [], contractFailure: null } }, plainPorts, { runDir: plainRun, attempt: 1 }));
  assert.equal(baseline.type, 'BRIEF_READY'); if (baseline.type !== 'BRIEF_READY') return;
  assert.equal(plainPorts.fs.readText(baseline.path).split(plainRun).join('<run>'), plain.full, 'empty keys render the same bytes as absent keys');
  for (const text of [plain.full, plain.delta]) assert.doesNotMatch(text, /Contract self-check|Integration contract failure|CHECK <command>/);
});

test('amendment delta write failure fails the effect', async () => {
  const runDir = tempDir(), ports = fakePorts();
  memoryRunFs(ports, runDir);
  const write = ports.fs.writeAtomic;
  ports.fs.writeAtomic = (file, data) => { if (file.endsWith('delta.md')) throw new Error('disk full'); return write(file, data); };
  const event = only(await createWriteBrief({ skillRoot: SKILL_ROOT })({ kind: 'write-brief', id: 'implement.write-brief.10', stage: 'task', input: { ...deltaInput, deltaBase } }, ports, { runDir, attempt: 1 }));
  assert.ok(event.type === 'EFFECT_FAILED' && /delta: disk full/.test(event.detail));
});
