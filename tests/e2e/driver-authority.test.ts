import { specHash } from '../helpers/spec-fixture.ts';
import { hashes } from '../../scripts/generate-hashes.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from '../helpers/e2e.ts';
import { withLaunch } from '../helpers/launch.ts';

// SECTION: Helpers — a live two-task run through the public CLI with real Git worktrees.

type Fixture = ReturnType<typeof fixture>;
type CliFrame = Awaited<ReturnType<Fixture['cli']>>;
type TaskSlot = { task: string; action: string; attempt: number; signature: string; handle: string | null; worktree: string; envelopePath: string; model?: string; briefHash?: string };
type EffortFrame = { data: Record<string, unknown> };
// Compact frame rows link launch records under the absolute run dir.
const taskSlots = (frame: CliFrame, run: string) => withLaunch((frame.data['tasks'] ?? []) as { launchPath: string }[], run, (file) => fs.readFileSync(file, 'utf8')) as unknown as TaskSlot[];
const effortOf = (frame: EffortFrame) => typeof frame.data['effort'] === 'string' ? { effort: frame.data['effort'] as string } : {};
const includes = (file: string, text: string) => `node -e "process.exit(require('node:fs').readFileSync('${file}','utf8').includes('${text}') ? 0 : 1)"`;

type TaskSpec = { id: string; criterion: string; file: string; text: string; prerequisites?: string };
function plan(tasks: readonly TaskSpec[]): string {
  const rows = tasks.map((task) => `| ${task.id} | Value ${task.id} | Deliver value ${task.id.toLowerCase()} within the task paths. | ${task.prerequisites ?? 'none'} | ${task.criterion} |`).join('\n');
  return `# Deliver values

> **TL;DR:** Deliver values.
> **Parent:** \`governing.spec.md\` · ${specHash()}
> **Decide:** none
> **Risk:** low — isolated fixture files
> **Scope:** ${[...new Set(tasks.map((task) => task.file))].join(', ')}

## Key Decisions & Context
- Keep each task within its own fixture paths.

## Task Map
| ID | Title | Outcome | Prerequisites | Criteria |
| --- | --- | --- | --- | --- |
${rows}

## Proposed Changes
${tasks.map((task) => `### ${task.id} — Value ${task.id}

#### [MODIFY] ${task.file}
- Write ${task.text}.
`).join('\n')}
## Success Criteria
${tasks.map((task) => `- [${task.criterion}] ${task.file} holds ${task.text}
  - Satisfies: REQ-1
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
  fs.writeFileSync(path.join(f.skill, 'config.local.jsonc'), JSON.stringify({ ...f.config, 'write-concurrency': 2, 'read-delegates': { codex: { nativeSubagentsOnly: true, targets: [{ low: { model: 'native-stub', effort: 'low' } }] } } }));
  fs.mkdirSync(path.join(f.repo, 'src'), { recursive: true });
  for (const file of ['src/a.ts', 'src/b.ts']) fs.writeFileSync(path.join(f.repo, file), inputs[file] ?? 'export const value = 1;\n');
  const planPath = path.join(f.repo, 'values.plan.md');
  fs.writeFileSync(planPath, source);
  fs.writeFileSync(path.join(f.repo, 'report.txt'), 'original report\n');
  f.git('add', '.'); f.git('commit', '-qm', 'values plan');
  const session = await f.initialize();
  let frame = await f.begin('implement', session, planPath);
  const run = f.absoluteRun(frame.run);
  if (frame.await === 'native') {
    const receipt = structuredClone(frame.events!.find((row) => row.type === 'NATIVE_RESULTS')!);
    if (receipt.type !== 'NATIVE_RESULTS') throw new Error('native receipt');
    for (const slot of receipt.slots) fs.writeFileSync(String(slot['outputPath']), JSON.stringify({ status: 'CLEAN', findings: [] }));
    frame = await f.reply(run, receipt);
  }
  if (frame.await === 'decide' && frame.data['kind'] === 'baseline') {
    const ids = [...new Set((frame.data['items'] as { failureId: string }[]).map((row) => row.failureId))];
    frame = await f.reply(run, { type: 'DECISION', kind: 'baseline', answer: { action: 'accept-known-red', ids } });
  }
  assert.equal(frame.data['kind'], 'approval', JSON.stringify(frame));
  fs.writeFileSync(path.join(f.repo, 'report.txt'), 'unrelated caller content\n');
  frame = await f.reply(run, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed with the fixture plan.' } });
  frame = await f.reply(run, { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'low', rationale: 'Bounded, reversible fixture tasks.', gateScopeHash: frame.data['gateScopeHash'] } });
  const launchFrame = frame;
  for (const slot of taskSlots(launchFrame, run).filter((item) => item.action === 'launch')) {
    frame = await f.reply(run, { type: 'WRITE_RECEIPT', status: 'launched', task: slot.task, attempt: slot.attempt, signature: slot.signature, handle: `writer-${slot.task}`, model: slot.model!, ...effortOf(launchFrame) });
  }
  return { run, frame, session };
}

async function submitTask(f: Fixture, run: string, frame: CliFrame, spec: TaskSpec, text = `export const ${spec.text};\n`) {
  const slot = taskSlots(frame, run).find((item) => item.task === spec.id);
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

// NOTE: the isolated overlay aborts after the actual Git commit, before handler output can be sealed.
function interruptIntegration(f: Fixture) {
  const file = path.join(f.skill, 'scripts/effects/checkout.ts');
  const original = fs.readFileSync(file, 'utf8');
  const branch = "case 'integrate': return done('integrate', await integrate(ports, worktreePath(ctx.runDir, 'integration'), input));";
  assert.ok(original.includes(branch));
  fs.writeFileSync(file, original.replace(branch, `case 'integrate': {
    const result = await integrate(ports, worktreePath(ctx.runDir, 'integration'), input);
    const marker = path.join(ctx.runDir, 'interrupt-integration');
    if (ports.fs.exists(marker)) { ports.fs.remove(marker); process.exit(88); }
    return done('integrate', result);
  }`));
}
const journal = (run: string) => fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });

test('authority-integration: observations replacement and original review survive interruption rebind and one delivery', async () => {
  const f = fixture();
  try {
    interruptIntegration(f);
    hashes(f.overlay);
    let { run, frame, session } = await liveRun(f, plan([T1, T2]));
    assert.ok((frame.data['observations'] as unknown[]).length, 'ordinary caller edit retains the normal write await');
    const t1 = taskSlots(frame, run).find((row) => row.task === 'T1')!;
    const t2 = taskSlots(frame, run).find((row) => row.task === 'T2')!;
    fs.writeFileSync(path.join(run, 'interrupt-integration'), 'once');
    fs.writeFileSync(path.join(t2.worktree, T2.file), 'export const value = 2;\n');
    fs.writeFileSync(t2.envelopePath, JSON.stringify({ schemaVersion: 1, stage: 'COMPLETE', status: 'DONE', summary: 'Delivered T2.', evidence: ['CRITERION SC2 | src/b.ts | delivers value two'], files: [{ path: 'src/b.ts', note: 'Value two.' }] }));
    const receipt = { type: 'WRITE_RECEIPT', status: 'submitted', task: t2.task, attempt: t2.attempt, signature: t2.signature, handle: t2.handle, envelopePath: t2.envelopePath, briefHash: t2.briefHash, model: t2.model, ...effortOf(frame) };
    const eventFile = path.join(f.dir, 'interrupted.event.json'); fs.writeFileSync(eventFile, JSON.stringify(receipt));
    const failed = await f.launch(['send', '--run', run, '--event', `@${eventFile}`]).done;
    assert.equal(failed.exit, 88, failed.stderr);
    const integrationRoot = path.join(run, 'wt/integration');
    const git = (...args: string[]) => f.git('--work-tree', integrationRoot, '--git-dir', fs.readFileSync(path.join(integrationRoot, '.git'), 'utf8').trim().slice(8), ...args);
    const actualCommit = git('rev-parse', 'HEAD').trim();
    assert.match(git('log', '-1', '--format=%s'), /dispatch integrate T2/);
    const acceptedPrefix = fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8');
    assert.equal(journal(run).filter((row) => row.type === 'CHECKOUT_DONE' && row.data['op'] === 'integrate').length, 0);
    fs.appendFileSync(path.join(f.skill, 'scripts/core/validate.ts'), '\n// Fixture local parser repair with the same private-state schema.\n');
    hashes(f.overlay);
    const rebound = await f.rebind(run, 'Local parser repair; keep committed work.');
    assert.equal(rebound.exit, 0, rebound.stderr);
    assert.ok(fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8').startsWith(acceptedPrefix));
    assert.equal(journal(run).filter((row) => row.type === 'CHECKOUT_DONE' && row.data['op'] === 'integrate').length, 0, 'rebind launches no handler');
    frame = await f.cli(['send', '--run', run]);
    assert.equal(frame.await, 'write', JSON.stringify(frame));
    assert.equal(integrated(f, run)['T2'], actualCommit, 'the completion probe admits the actual commit');
    assert.deepEqual(taskSlots(frame, run).map((row) => [row.task, row.attempt, row.handle]), [['T1', t1.attempt, t1.handle]]);
    fs.writeFileSync(path.join(f.repo, 'report.txt'), 'unrelated caller content\n');
    frame = await replacePlan(f, run, frame, session, plan([T1]), { reconciliation: { retained: ['T1'], changed: [], added: [], retired: ['T2'], intentChanged: false, dependencyChanged: false } });
    assert.equal(frame.await, 'write', JSON.stringify(frame));

    frame = await submitTask(f, run, frame, T1);
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/b.ts'), 'utf8'), 'export const value = 2;\n', 'retired integrated bytes are delivered');
    assert.equal(frame.await, 'native', JSON.stringify(frame));
    const native = structuredClone(frame.events!.find((row) => row.type === 'NATIVE_RESULTS')!);
    if (native.type !== 'NATIVE_RESULTS') throw new Error('native receipt');
    fs.appendFileSync(path.join(f.repo, 'src/a.ts'), '// Caller comment after capture.\n');
    for (const slot of native.slots) fs.writeFileSync(String(slot['outputPath']), JSON.stringify({ status: 'FINDINGS', findings: [{ severity: 'SHOULD', locus: 'src/a.ts:L1', tag: 'correctness', defect: 'Check the value requirement.', requiredChange: 'Establish the governing value.' }] }));
    frame = await f.reply(run, native);
    assert.equal(frame.await, 'rule', JSON.stringify(frame));
    const observations = frame.data['reviewObservations'] as { id: string; afterHash: string }[];
    assert.ok(observations.length);
    const finding = (JSON.parse(fs.readFileSync(path.resolve(f.repo, String(frame.data['findingsPath'])), 'utf8')) as { id: string; revision: string }[])[0]!;
    assert.ok(finding.revision);
    frame = await f.reply(run, { type: 'REVIEW_USE', observationId: observations[0]!.id, afterHash: observations[0]!.afterHash, action: 'reuse', rationale: 'The caller comment does not change the checked value.' });
    frame = await f.reply(run, { type: 'RULINGS', rulings: { [finding.id]: { ruling: 'reject', reason: 'SC1 and the executable value check establish the governing value.' } } });
    if (frame.await === 'native') {
      assert.equal(frame.data['round'], 2, 'the rejected finding follows the configured review policy');
      const continuation = structuredClone(frame.events!.find((row) => row.type === 'NATIVE_RESULTS')!);
      if (continuation.type !== 'NATIVE_RESULTS') throw new Error('native receipt');
      for (const slot of continuation.slots) fs.writeFileSync(String(slot['outputPath']), JSON.stringify({ status: 'CLEAN', findings: [] }));
      frame = await f.reply(run, continuation);
    }
    if (frame.await === 'evidence') frame = await f.reply(run, { type: 'EVIDENCE', criteria: { SC1: { outcome: 'pass', evidence: 'The final checked value and caller comment remain intact.' } } });
    assert.equal(frame.await, 'done', JSON.stringify(frame));
    assert.equal(frame.data['outcome'], 'complete', JSON.stringify(frame));
    const rows = journal(run);
    const starts = rows.filter((row) => row.type === 'EFFECT_STARTED').map((row) => `${String(row.data['effectId'])}:${String(row.data['attempt'])}`);
    assert.equal(new Set(starts).size, starts.length, 'nested review returns retain monotonic parent/child effect identities');
    assert.equal(rows.filter((row) => row.type === 'WRITE_RECEIPT' && row.data['status'] === 'submitted' && row.data['task'] === 'T2').length, 1);
    assert.equal(rows.filter((row) => row.type === 'CHECKOUT_DONE' && row.data['op'] === 'integrate').length, 2);
    assert.equal(rows.filter((row) => row.type === 'CHECKOUT_DONE' && row.data['op'] === 'deliver').length, 1);
    const reviewLog = fs.readFileSync(path.join(session, 'values.walkthrough.review-log.md'), 'utf8');
    assert.ok(reviewLog.includes(`Reviewed target: ${finding.revision}`));
    assert.match(reviewLog, /Host applicability: reuse/);
    assert.match(fs.readFileSync(path.join(session, 'values.walkthrough.md'), 'utf8'), /Full log: \[values\.walkthrough\.review-log\.md\]/);
    assert.equal(fs.readFileSync(path.join(f.repo, 'report.txt'), 'utf8'), 'unrelated caller content\n');
    const before = fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8');
    assert.equal((await f.cli(['send', '--run', run])).await, 'done');
    assert.equal(fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8'), before, 'completed continuation creates no repeated effects');
  } finally { f.cleanup(); }
});
