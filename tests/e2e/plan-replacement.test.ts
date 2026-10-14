import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from '../helpers/e2e.ts';

// SECTION: Helpers — a live two-task run through the public CLI with real Git worktrees.

type Fixture = ReturnType<typeof fixture>;
type CliFrame = Awaited<ReturnType<Fixture['cli']>>;
type TaskSlot = { task: string; action: string; attempt: number; signature: string; handle: string | null; worktree: string; envelopePath: string; model?: string; briefHash?: string };
type EffortFrame = { data: Record<string, unknown> };
const taskSlots = (frame: CliFrame) => (frame.data['tasks'] ?? []) as TaskSlot[];
const effortOf = (frame: EffortFrame) => typeof frame.data['effort'] === 'string' ? { effort: frame.data['effort'] as string } : {};
const includes = (file: string, text: string) => `node -e "process.exit(require('node:fs').readFileSync('${file}','utf8').includes('${text}') ? 0 : 1)"`;

type TaskSpec = { id: string; criterion: string; file: string; text: string; prerequisites?: string };
function plan(tasks: readonly TaskSpec[]): string {
  return `# Deliver values

> **TL;DR:** Deliver values.
> **Parent:** user request
> **Decide:** none
> **Risk:** low — isolated fixture files
> **Scope:** ${[...new Set(tasks.map((task) => task.file))].join(', ')}

## Key Decisions & Context
- Keep each task within its own fixture paths.

## Proposed Changes
${tasks.map((task) => `### ${task.id} — Value ${task.id}
Deliver value ${task.id.toLowerCase()} within the task paths.
- Prerequisites: ${task.prerequisites ?? 'none'}
- Criteria: ${task.criterion}

#### [MODIFY] ${task.file}
- Write ${task.text}.
`).join('\n')}
## Success Criteria
${tasks.map((task) => `- [${task.criterion}] ${task.file} holds ${task.text}
  - Changes: ${task.file}
  - Verify: \`${includes(task.file, task.text)}\`
  - Evidence: verify
  - Pre-existing: no
  - Test rationale: Executable checks establish the delivered fixture behavior.`).join('\n')}

## Verification Plan
### Automated Tests
- None: Criterion commands cover every change.
### Manual Verification
- Inspect the delivered fixture files.

## Review Findings & Resolutions
*No reviews conducted yet.*
`;
}
const T1: TaskSpec = { id: 'T1', criterion: 'SC1', file: 'src/a.ts', text: 'value = 2' };
const T2: TaskSpec = { id: 'T2', criterion: 'SC2', file: 'src/b.ts', text: 'value = 2' };

/** Commits inputs and plan, settles every gate, and launches the first write wave. */
async function liveRun(f: Fixture, source: string, inputs: Record<string, string> = {}) {
  f.git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(f.skill, 'config.local.jsonc'), JSON.stringify({ ...f.config, 'write-concurrency': 2 }));
  fs.mkdirSync(path.join(f.repo, 'src'), { recursive: true });
  for (const file of ['src/a.ts', 'src/b.ts']) fs.writeFileSync(path.join(f.repo, file), inputs[file] ?? 'export const value = 1;\n');
  const planPath = path.join(f.repo, 'values.plan.md');
  fs.writeFileSync(planPath, source);
  f.git('add', '.'); f.git('commit', '-qm', 'values plan');
  const session = await f.initialize();
  let frame = await f.begin('implement', session, planPath);
  const run = f.absoluteRun(frame.run);
  if (frame.await === 'decide' && frame.data['kind'] === 'baseline') {
    const ids = [...new Set((frame.data['items'] as { failureId: string }[]).map((row) => row.failureId))];
    frame = await f.reply(run, { type: 'DECISION', kind: 'baseline', answer: { action: 'accept-known-red', ids } });
  }
  assert.equal(frame.data['kind'], 'approval', JSON.stringify(frame));
  frame = await f.reply(run, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed with the fixture plan.' } });
  frame = await f.reply(run, { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'low', rationale: 'Bounded, reversible fixture tasks.', gateScope: frame.data['gateScope'] } });
  const launchFrame = frame;
  for (const slot of taskSlots(launchFrame).filter((item) => item.action === 'launch')) {
    frame = await f.reply(run, { type: 'WRITE_RECEIPT', status: 'launched', task: slot.task, attempt: slot.attempt, signature: slot.signature, handle: `writer-${slot.task}`, model: slot.model!, ...effortOf(launchFrame) });
  }
  return { run, frame, session };
}

async function submitTask(f: Fixture, run: string, frame: CliFrame, spec: TaskSpec, text = `export const ${spec.text};\n`) {
  const slot = taskSlots(frame).find((item) => item.task === spec.id);
  assert.ok(slot?.handle, JSON.stringify(frame));
  fs.writeFileSync(path.join(slot.worktree, spec.file), text);
  fs.writeFileSync(slot.envelopePath, JSON.stringify({ schemaVersion: 1, stage: 'COMPLETE', status: 'DONE', summary: `Delivered ${spec.id}.`, evidence: [`CRITERION ${spec.criterion} | ${spec.file} | delivers the checked behavior`], files: [{ path: spec.file, note: `Delivered by ${spec.id}.` }] }));
  return f.reply(run, { type: 'WRITE_RECEIPT', status: 'submitted', task: slot.task, attempt: slot.attempt, signature: slot.signature, handle: slot.handle, envelopePath: slot.envelopePath, briefHash: slot.briefHash!, model: slot.model!, ...effortOf(frame) });
}

/** Writes a replacement plan beside the session and sends REPLACE_PLAN bound to the frame's plan hash. */
async function replacePlan(f: Fixture, run: string, frame: CliFrame, session: string, source: string, extra: Record<string, unknown>) {
  const file = path.join(session, 'values.replace-1.plan.md');
  fs.writeFileSync(file, source);
  const next = await f.reply(run, { type: 'REPLACE_PLAN', path: file, expectedHash: frame.data['planHash'], rationale: 'The plan changed mid-run.', notify: [], ...extra });
  assert.match(String(next.data['planPath']), /values\.replace-1\.plan\.md$/, JSON.stringify(next));
  assert.ok(frame.data['planHash'] && next.data['planHash'] !== frame.data['planHash'], 'the run binds the replacement plan');
  return next;
}

/** Integration commits the driver journaled, by task; each commit names its task in its subject. */
function integrated(f: Fixture, run: string): Record<string, string> {
  const rows = fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
  const out: Record<string, string> = {};
  for (const row of rows) {
    const result = row.data['result'] as Record<string, unknown> | undefined;
    if (row.type !== 'CHECKOUT_DONE' || row.data['op'] !== 'integrate' || result?.['conflict'] !== false || typeof result['revision'] !== 'string') continue;
    const task = /^dispatch integrate (\S+)/.exec(f.git('log', '-1', '--format=%s', result['revision']).trim())?.[1];
    if (task) out[task] = result['revision'];
  }
  return out;
}

// SECTION: Retained and retired work

test('replacement-work: retirement preserves integrated bytes', async () => {
  const f = fixture();
  try {
    let { run, frame, session } = await liveRun(f, plan([T1, T2]));
    frame = await submitTask(f, run, frame, T2);
    assert.equal(frame.await, 'write', JSON.stringify(frame));
    frame = await replacePlan(f, run, frame, session, plan([T1]), { reconciliation: { retained: ['T1'], changed: [], added: [], retired: ['T2'], intentChanged: false, dependencyChanged: false } });
    assert.equal(frame.await, 'write', JSON.stringify(frame));
    assert.deepEqual(taskSlots(frame).map((slot) => [slot.task, slot.handle]), [['T1', 'writer-T1']], 'T1 keeps its writer');
    frame = await submitTask(f, run, frame, T1);
    assert.equal(frame.await, 'evidence', JSON.stringify(frame));
    for (const file of ['src/a.ts', 'src/b.ts']) assert.equal(fs.readFileSync(path.join(f.repo, file), 'utf8'), 'export const value = 2;\n', file);
    const commits = integrated(f, run);
    assert.ok(commits['T2'], JSON.stringify(commits));
    f.git('cat-file', '-e', `${commits['T2']}^{commit}`);
  } finally { f.cleanup(); }
});

test('replacement-work: new prerequisite validates the retained consumer', async () => {
  const f = fixture();
  try {
    let { run, frame, session } = await liveRun(f, plan([T1, T2]));
    frame = await submitTask(f, run, frame, T2);
    const launches = taskSlots(frame).length;
    frame = await replacePlan(f, run, frame, session, plan([T1, { ...T2, prerequisites: 'T1' }]), { reconciliation: { retained: ['T1'], changed: ['T2'], added: [], retired: [], intentChanged: false, dependencyChanged: false } });
    assert.equal(frame.await, 'write', JSON.stringify(frame));
    assert.equal(taskSlots(frame).length, launches, 'accepted T2 is not relaunched');
    frame = await submitTask(f, run, frame, T1);
    assert.equal(frame.await, 'evidence', JSON.stringify(frame));
    const criteria = frame.data['criteria'] as { id: string; obligation?: { observationId: string } }[];
    assert.equal(criteria.find((row) => row.id === 'SC2')?.obligation?.observationId, 'replace-1', JSON.stringify(criteria));
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/b.ts'), 'utf8'), 'export const value = 2;\n');
  } finally { f.cleanup(); }
});

test('replacement-work: approved compensating removal keeps prior refs', async () => {
  const f = fixture();
  try {
    let { run, frame, session } = await liveRun(f, plan([T1, T2]));
    frame = await submitTask(f, run, frame, T2);
    const T3: TaskSpec = { id: 'T3', criterion: 'SC3', file: 'src/b.ts', text: 'value = 1' };
    const reconciliation = { retained: ['T1'], changed: [], added: ['T3'], retired: ['T2'], intentChanged: false, dependencyChanged: false, compensating: ['T3'] };
    const replacement = plan([T1, T3]);
    const file = path.join(session, 'values.replace-1.plan.md');
    fs.writeFileSync(file, replacement);
    const unapproved = path.join(f.dir, 'unapproved.event.json');
    fs.writeFileSync(unapproved, JSON.stringify({ type: 'REPLACE_PLAN', path: file, expectedHash: frame.data['planHash'], rationale: 'Revert value B.', notify: [], reconciliation }));
    await f.launch(['send', '--run', run, '--event', `@${unapproved}`]).done;
    frame = await f.cli(['send', '--run', run, '--dry-run']);
    assert.match(JSON.stringify(frame.data['planRejection']), /user's quote: compensating removal by T3/);
    frame = await replacePlan(f, run, frame, session, replacement, { reconciliation, by: { by: 'user', quote: 'Revert value B.' }, rationale: 'Revert value B.' });
    assert.equal(frame.await, 'write', JSON.stringify(frame));
    const launchFrame = frame;
    for (const slot of taskSlots(launchFrame).filter((item) => item.action === 'launch')) frame = await f.reply(run, { type: 'WRITE_RECEIPT', status: 'launched', task: slot.task, attempt: slot.attempt, signature: slot.signature, handle: `writer-${slot.task}`, model: slot.model!, ...effortOf(launchFrame) });
    frame = await submitTask(f, run, frame, T3);
    frame = await submitTask(f, run, frame, T1);
    assert.equal(frame.await, 'evidence', JSON.stringify(frame));
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/b.ts'), 'utf8'), 'export const value = 1;\n');
    const commits = integrated(f, run);
    for (const task of ['T2', 'T3']) f.git('cat-file', '-e', `${commits[task]}^{commit}`);
  } finally { f.cleanup(); }
});

// SECTION: Delivery collision refresh

test('replacement-work: delivery refresh replays accepted integration without re-pending tasks', async () => {
  const f = fixture();
  try {
    // NOTE: separated hunks let Git replay the task edit onto the caller's newer content without a conflict.
    const base = 'export const value = 1;\n\n\n\nexport const tail = 1;\n';
    let { run, frame } = await liveRun(f, plan([T1, T2]), { 'src/a.ts': base });
    frame = await submitTask(f, run, frame, T1, base.replace('value = 1', 'value = 2'));
    fs.writeFileSync(path.join(f.repo, 'src/a.ts'), base.replace('tail = 1', 'tail = 3'));
    frame = await submitTask(f, run, frame, T2);
    assert.equal(frame.data['kind'], 'drift', JSON.stringify(frame));
    const notice = frame.data['notice'] as { id: string; afterHash: string; affectedEvidence: string[] };
    const before = integrated(f, run);
    frame = await f.reply(run, { type: 'DECISION', kind: 'drift', answer: { by: 'orchestrator', noticeId: notice.id, afterHash: notice.afterHash, action: 'refresh', rationale: 'The caller edit is independent of value A.', evidenceIds: notice.affectedEvidence } });
    assert.equal(frame.await, 'evidence', JSON.stringify(frame));
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/a.ts'), 'utf8'), 'export const value = 2;\n\n\n\nexport const tail = 3;\n');
    assert.deepEqual(Object.keys(integrated(f, run)).sort(), ['T1', 'T2'], 'no task was integrated again');
    for (const task of ['T1', 'T2']) f.git('cat-file', '-e', `${before[task]}^{commit}`);
  } finally { f.cleanup(); }
});

test('replacement-work: conflicting delivery replay resolves and preserves all accepted history', async () => {
  const f = fixture();
  try {
    let { run, frame } = await liveRun(f, plan([T1, T2]));
    frame = await submitTask(f, run, frame, T1);
    fs.writeFileSync(path.join(f.repo, 'src/a.ts'), 'export const value = 3; // caller\n');
    frame = await submitTask(f, run, frame, T2);
    const notice = frame.data['notice'] as { id: string; afterHash: string; affectedEvidence: string[] };
    const before = integrated(f, run);
    frame = await f.reply(run, { type: 'DECISION', kind: 'drift', answer: { by: 'orchestrator', noticeId: notice.id, afterHash: notice.afterHash, action: 'refresh', rationale: 'Preserve caller annotation and accepted values.', evidenceIds: notice.affectedEvidence } });
    assert.equal(frame.data['kind'], 'integration-conflict', JSON.stringify(frame));
    assert.deepEqual(frame.data['options'], ['resolve']);
    const active = String(frame.data['worktree']);
    assert.equal(f.git('-C', active, 'rev-parse', 'HEAD').trim(), frame.data['head']);
    assert.ok(f.git('-C', active, 'rev-parse', 'CHERRY_PICK_HEAD').trim(), 'conflicted pick remains active');
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/a.ts'), 'utf8'), 'export const value = 3; // caller\n');
    fs.writeFileSync(path.join(active, 'src/a.ts'), 'export const value = 2; // caller\n');
    frame = await f.reply(run, { type: 'DECISION', kind: 'integration-conflict', answer: { by: 'orchestrator', action: 'resolve', rationale: 'Retain caller annotation and accepted value.' } });
    assert.equal(frame.await, 'evidence', JSON.stringify(frame));
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/a.ts'), 'utf8'), 'export const value = 2; // caller\n');
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/b.ts'), 'utf8'), 'export const value = 2;\n', 'remaining pick ran');
    assert.deepEqual(integrated(f, run), before, 'no task acceptance was repeated');
    for (const revision of Object.values(before)) f.git('cat-file', '-e', `${revision}^{commit}`);
  } finally { f.cleanup(); }
});

test('replacement-work: retired accepted owner replay failure retries after checkpoint and rebind', async () => {
  const f = fixture();
  try {
    let { run, frame, session } = await liveRun(f, plan([T1, T2]));
    frame = await submitTask(f, run, frame, T2);
    const before = integrated(f, run);
    frame = await replacePlan(f, run, frame, session, plan([T1]), { reconciliation: { retained: ['T1'], changed: [], added: [], retired: ['T2'], intentChanged: false, dependencyChanged: false } });
    fs.writeFileSync(path.join(f.repo, 'src/b.ts'), 'export const value = 3; // caller\n');
    frame = await submitTask(f, run, frame, T1);
    const notice = frame.data['notice'] as { id: string; afterHash: string; affectedEvidence: string[] };
    frame = await f.reply(run, { type: 'DECISION', kind: 'drift', answer: { by: 'orchestrator', noticeId: notice.id, afterHash: notice.afterHash, action: 'refresh', rationale: 'Preserve caller annotation and retired accepted bytes.', evidenceIds: notice.affectedEvidence } });
    assert.equal(frame.data['kind'], 'integration-conflict', JSON.stringify(frame));
    assert.equal(frame.data['task'], 'T2');
    assert.deepEqual(frame.data['options'], ['resolve']);
    const owners = frame.data['tasks'] as { task: string; paths: string[]; retainedVerification: string[] }[];
    assert.deepEqual(owners.map((owner) => [owner.task, owner.paths]), [['T2', ['src/b.ts']]]);
    assert.equal(owners[0]!.retainedVerification.length, 1);
    const active = String(frame.data['worktree']);
    fs.writeFileSync(path.join(active, 'src/b.ts'), 'export const value = 2; // caller\n');
    f.failGitOnce(['rev-list', '--reverse']);
    frame = await f.reply(run, { type: 'DECISION', kind: 'integration-conflict', answer: { by: 'orchestrator', action: 'resolve', rationale: 'Preserve the retired value and caller annotation.' } });
    assert.equal(frame.data['kind'], 'failure', JSON.stringify(frame));
    assert.match(JSON.stringify(frame), /Injected Git failure/);
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/b.ts'), 'utf8'), 'export const value = 3; // caller\n', 'partial replay was not delivered');
    const failedHead = f.git('-C', active, 'rev-parse', 'HEAD').trim();
    assert.equal(fs.readFileSync(path.join(active, 'src/a.ts'), 'utf8'), 'export const value = 1;\n', 'remaining accepted pick has not run');
    frame = await f.cli(['send', '--run', run, '--dry-run']);
    assert.equal(frame.data['kind'], 'failure', JSON.stringify(frame));
    const rebound = await f.rebind(run, 'Continue the preserved delivery replay after its handled failure.');
    assert.equal(rebound.exit, 0, rebound.stderr);
    frame = await f.reply(run, { type: 'DECISION', kind: 'failure', answer: { by: 'orchestrator', action: 'retry', rationale: 'Retry original archived commits after the Git fault.' } });
    assert.equal(frame.await, 'evidence', JSON.stringify(frame));
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/b.ts'), 'utf8'), 'export const value = 2; // caller\n');
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/a.ts'), 'utf8'), 'export const value = 2;\n');
    assert.deepEqual((frame.data['criteria'] as { id: string }[]).map((row) => row.id), ['SC1'], 'retired requirement remains retired');
    assert.equal(integrated(f, run)['T2'], before['T2'], 'retired task is never accepted again');
    f.git('cat-file', '-e', `${before['T2']}^{commit}`);
    const journal = fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
    const resumed = journal.filter((row) => row.type === 'CHECKOUT_DONE' && row.data['op'] === 'init').map((row) => row.data['result'] as Record<string, unknown>).find((result) => result['conflict'] === false && Array.isArray(result['replayed']));
    assert.ok(resumed, 'retry completed the original replay');
    const mappings = resumed['replayed'] as { from: string; to: string }[];
    assert.equal(mappings.length, 2);
    assert.equal(new Set(mappings.map((row) => row.from)).size, 2, 'accepted picks occur once');
    assert.equal(mappings.find((row) => row.from === before['T2'])?.to, failedHead, 'retry retains the resolved retired commit');
  } finally { f.cleanup(); }
});
