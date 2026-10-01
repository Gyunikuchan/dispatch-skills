import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fold, send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import type { Effect, Handler, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { createPrepareReview } from '../../../skills/dispatch/scripts/effects/prepare-review.ts';
import { createGit } from '../../../skills/dispatch/scripts/effects/git.ts';
import { createHandlers } from '../../../skills/dispatch/scripts/effects/index.ts';
import { rootMachine } from '../../../skills/dispatch/scripts/machines/root.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../skills/dispatch');
const FINDING = {
  id: 'R1-F001', severity: 'MUST', category: 'correctness', locus: 'src/a.ts:L3', defect: 'null deref', requiredChange: 'guard it', sources: ['codex[0]'], scope: 'in',
  fix: { paths: ['src/a.ts'], dependencies: [], verification: ['npm test'] },
};

function setup(fix: boolean) {
  const wave: Handler<Extract<Effect, { kind: 'wave' }>> = async (effect) => [{
    type: 'WAVE_DONE', effectId: effect.id, round: effect.round, slots: [{ slot: 'codex[0]', state: 'success' }], findings: effect.round === 1 ? [FINDING] : [],
  }];
  const tmp = tempDir();
  const { reviewSnapshot: _snapshot, reviewDelta: _delta, ...git } = createGit({ run: async (args) => (args[1] === '--show-toplevel' ? `${tmp}\n` : args[0] === 'diff' && args[1] === '--name-only' ? 'src/a.ts\n' : '') });
  const handlers = createHandlers({ skillRoot: SKILL_ROOT, cwd: tmp, os: 'linux', git, tempRoot: path.join(tmp, 'tmp'), workspaceRoot: tmp, orchestratorPlatform: 'claude', wave });
  const ports = fakePorts();
  const commands: string[] = [];
  ports.spawn = { run: async (argv) => { commands.push(argv.join(' ')); return { exit: 0, stdout: 'ok', stderr: '' }; } };
  const runDir = path.join(tmp, 'run');
  const runStarted: RunStartedEvent = {
    type: 'RUN_STARTED', verb: 'review', argument: 'main..HEAD', level: 'low', levelSource: 'explicit', pins: null, fix,
    orchestrator: 'claude', orchestratorModel: null, overrides: {}, repo: {},
    config: { 'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } }, phases: { 'code-review': { rounds: { low: 1 }, targets: { low: 1 } } } },
  };
  return { options: { runDir, machine: rootMachine, handlers, ports, runRel: 'run' }, runStarted, runDir, commands };
}

test('review-report-only-default: standalone report mode renders <slug>.report.md and ends done', async () => {
  const { options, runStarted, runDir } = setup(false);
  const rule = await start({ ...options, runStarted });
  assert.deepEqual([rule.frame?.at, rule.frame?.await], ['review › rule', 'rule']);
  const done = await send({ ...options, rawEvent: { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' } } } });
  assert.deepEqual([done.frame?.at, done.frame?.await, done.frame?.data['outcome']], ['review › done', 'done', 'complete']);
  const report = fs.readFileSync(path.join(runDir, 'main-head.report.md'), 'utf8');
  assert.match(report, /R1-F001/);
  assert.deepEqual((await send({ ...options, dryRun: true })).frame, done.frame);
});

test('review --fix: fix → FIXES_APPLIED runs fix-verify, and the run settles', async () => {
  const { options, runStarted, commands } = setup(true);
  await start({ ...options, runStarted });
  const fix = await send({ ...options, rawEvent: { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept' } } } });
  assert.deepEqual([fix.frame?.at, fix.frame?.await], ['review › fix', 'fix']);
  const clusters = fix.frame?.data['clusters'] as { clusterId: string }[];
  const done = await send({ ...options, rawEvent: { type: 'FIXES_APPLIED', clusters: clusters.map((cluster) => ({ clusterId: cluster.clusterId })) } });
  assert.deepEqual(commands, ['sh -c npm test']);
  assert.deepEqual([done.frame?.at, done.frame?.data['outcome']], ['review › done', 'complete']);
  const completion = done.frame?.data['completion'] as { exitSummary: { rounds: number; fixedUnreviewed: unknown[] } };
  assert.deepEqual([completion.exitSummary.rounds, completion.exitSummary.fixedUnreviewed], [2, []]);
  assert.deepEqual((await send({ ...options, dryRun: true })).frame, done.frame);
});


test('rewrite SC2 prompt preserves comparison independently of context', async () => {
  const { options, runStarted, runDir } = setup(false);
  const result = await start({ ...options, runStarted: { ...runStarted, overrides: { context: 'Check the boundary' } } });
  assert.equal(result.frame?.await, 'rule', JSON.stringify(result));
  const file = fs.readdirSync(runDir).find((name) => name.endsWith('.prompt.md'))!;
  const prompt = fs.readFileSync(path.join(runDir, file), 'utf8');
  assert.match(prompt, /main\.\.HEAD/);
  assert.match(prompt, /src\/a\.ts/);
  assert.match(prompt, /Check the boundary/);
});


test('rewrite SC3 incompatible journals fail explicitly', () => {
  const { runStarted } = setup(false); const { type, ...data } = runStarted;
  assert.throws(() => fold(rootMachine, [{ seq: 1, v: 1, at: 'now', type, data }]), /unsupported-journal-protocol/);
});

test('rewrite SC2 later delta remains within manifest and accepted fix paths', async () => {
  const ports = fakePorts(); const runDir = tempDir(); const priorPath = path.join(runDir, 'prior.json'); const snapshot = { head: 'a', target: 'main..HEAD', comparison: 'a', index: {}, working: {}, untracked: {}, governedPaths: ['src/a.ts'] };
  ports.fs.writeAtomic(priorPath, JSON.stringify(snapshot));
  const git = { ...createGit({ run: async () => '' }), diffNames: async () => ['src/a.ts'], reviewSnapshot: async () => snapshot, reviewDelta: async () => ({ paths: ['src/a.ts', 'src/new.ts', 'unrelated.ts'], staged: [], unstaged: [], untracked: [], deleted: [] }) };
  const handler = createPrepareReview({ cwd: '/repo', skillRoot: SKILL_ROOT, git });
  const events = await handler({ kind: 'prepare-review', id: 'round2', round: 2, review: { kind: 'code', target: 'main..HEAD', roster: [{ slot: 'codex[0]' }] }, scope: { scope: 'delta', priorManifest: priorPath, affectedPaths: ['src/new.ts'] } }, ports, { runDir, attempt: 1 });
  const prepared = events[0]; assert.equal(prepared?.type, 'REVIEW_PREPARED');
  if (prepared?.type === 'REVIEW_PREPARED') assert.deepEqual(prepared.scope['paths'], ['src/a.ts', 'src/new.ts']);
});

test('review fix retried prepare refreshes its manifest and later round reuses one capture', async () => {
  const runDir = tempDir(), ports = fakePorts(); let head = 'first'; let names = ['src/a.ts']; const requests: (readonly string[] | undefined)[] = [];
  const git = { ...createGit({ run: async () => '' }), diffNames: async () => names,
    reviewSnapshot: async (_cwd: string, _target: string, paths?: readonly string[]) => { requests.push(paths); return { head, target: '', comparison: head, index: {}, working: {}, untracked: {} }; },
    reviewDelta: async (_cwd: string, _prior: unknown, current?: unknown) => { assert.ok(current); return { paths: names, staged: [], unstaged: [], untracked: [], deleted: [] }; } };
  const handler = createPrepareReview({ cwd: '/repo', skillRoot: SKILL_ROOT, git });
  const effect = { kind: 'prepare-review' as const, id: 'prepare', round: 1, review: { kind: 'code', target: '', roster: [{ slot: 'codex[0]' }] }, scope: { scope: 'full' } };
  const invoke = async (attempt: number) => { const event = (await handler(effect, ports, { runDir, attempt }))[0]; assert.equal(event?.type, 'REVIEW_PREPARED'); return event; };
  const first = await invoke(1); head = 'second'; names = ['src/a.ts', 'src/new.ts']; const second = await invoke(2);
  if (first?.type !== 'REVIEW_PREPARED' || second?.type !== 'REVIEW_PREPARED') throw new Error('prepared');
  const manifestPath = String(second.scope['manifestPath']); const manifest = JSON.parse(ports.fs.readText(manifestPath));
  assert.equal(manifest.head, 'second'); assert.deepEqual(manifest.governedPaths, names);
  const before = requests.length;
  const event = (await handler({ ...effect, id: 'round2', round: 2, scope: { scope: 'delta', priorManifest: manifestPath } }, ports, { runDir, attempt: 1 }))[0];
  assert.equal(event?.type, 'REVIEW_PREPARED'); assert.equal(requests.length - before, 1); assert.deepEqual(requests.at(-1), names);
});

test('binds changed sections for artifact re-review', async () => {
  const tmp = tempDir();
  const runDir = tempDir();
  const ports = fakePorts();
  const git = createGit({ run: async () => '' });
  const handler = createPrepareReview({ cwd: tmp, skillRoot: SKILL_ROOT, git });
  const planPath = path.join(tmp, 'test.plan.md');
  ports.fs.writeAtomic(planPath, '# Plan title\n\n> **TL;DR:** initial\n\n## Success Criteria\n- [SC1] initial\n\n## Proposed Changes\ninitial changes\n');

  // Round 1: Full review snapshot
  const r1 = (await handler({ kind: 'prepare-review', id: 'p1', round: 1, review: { kind: 'plan', target: planPath, roster: [{ slot: 'codex[0]' }] }, scope: { scope: 'full' } }, ports, { runDir, attempt: 1 }))[0];
  assert.equal(r1?.type, 'REVIEW_PREPARED');
  const r1Manifest = String(r1?.scope['manifestPath']);
  assert.ok(r1Manifest);
  const r1Prompt = ports.fs.readText(r1?.promptPaths['codex[0]']!);
  assert.match(r1Prompt, /Full review/);

  // Round 2 without priorManifest fails closed
  const failMissing = (await handler({ kind: 'prepare-review', id: 'p2-missing', round: 2, review: { kind: 'plan', target: planPath, roster: [{ slot: 'codex[0]' }] }, scope: { scope: 'full' } }, ports, { runDir, attempt: 1 }))[0];
  assert.equal(failMissing?.type, 'EFFECT_FAILED');
  assert.equal(failMissing?.detail, 'review-round-binding-unavailable');

  // Modify section in plan
  ports.fs.writeAtomic(planPath, '# Plan title\n\n> **TL;DR:** initial\n\n## Success Criteria\n- [SC1] initial\n\n## Proposed Changes\nupdated changes\n');

  // Round 2 full re-review binds changed sections as context
  const r2Full = (await handler({ kind: 'prepare-review', id: 'p2-full', round: 2, review: { kind: 'plan', target: planPath, roster: [{ slot: 'codex[0]' }] }, scope: { scope: 'full', priorManifest: r1Manifest } }, ports, { runDir, attempt: 1 }))[0];
  assert.equal(r2Full?.type, 'REVIEW_PREPARED');
  assert.deepEqual(r2Full?.scope['paths'], ['Proposed Changes']);
  const r2FullPrompt = ports.fs.readText(r2Full?.promptPaths['codex[0]']!);
  assert.match(r2FullPrompt, /Re-review round 2 \(full artifact\) — review the whole artifact; changed sections for context: Proposed Changes/);

  // Round 2 delta re-review binds changed sections and restricts scope
  const r2Delta = (await handler({ kind: 'prepare-review', id: 'p2-delta', round: 2, review: { kind: 'plan', target: planPath, roster: [{ slot: 'codex[0]' }] }, scope: { scope: 'delta', priorManifest: r1Manifest } }, ports, { runDir, attempt: 1 }))[0];
  assert.equal(r2Delta?.type, 'REVIEW_PREPARED');
  assert.deepEqual(r2Delta?.scope['paths'], ['Proposed Changes']);
  const r2DeltaPrompt = ports.fs.readText(r2Delta?.promptPaths['codex[0]']!);
  assert.match(r2DeltaPrompt, /Re-review round 2 \(delta\) — changed sections: Proposed Changes/);
});

test('delta review attributes changes inside fenced code blocks with heading syntax to enclosing section', async () => {
  const tmp = tempDir();
  const runDir = tempDir();
  const ports = fakePorts();
  const git = createGit({ run: async () => '' });
  const handler = createPrepareReview({ cwd: tmp, skillRoot: SKILL_ROOT, git });
  const planPath = path.join(tmp, 'fenced.plan.md');

  // Baseline plan with a fenced block containing ## Execution Status inside Proposed Changes
  ports.fs.writeAtomic(planPath, '# Plan\n\n> **TL;DR:** initial\n\n## Success Criteria\n- [SC1] initial\n\n## Proposed Changes\n```markdown\n## Execution Status\nsome status\n```\n');
  const r1 = (await handler({ kind: 'prepare-review', id: 'p1', round: 1, review: { kind: 'plan', target: planPath, roster: [{ slot: 'codex[0]' }] }, scope: { scope: 'full' } }, ports, { runDir, attempt: 1 }))[0];
  assert.equal(r1?.type, 'REVIEW_PREPARED');
  const r1Manifest = String(r1?.scope['manifestPath']);

  // Update inside the fenced block under Proposed Changes
  ports.fs.writeAtomic(planPath, '# Plan\n\n> **TL;DR:** initial\n\n## Success Criteria\n- [SC1] initial\n\n## Proposed Changes\n```markdown\n## Execution Status\nupdated status inside fence\n```\n');
  const r2 = (await handler({ kind: 'prepare-review', id: 'p2', round: 2, review: { kind: 'plan', target: planPath, roster: [{ slot: 'codex[0]' }] }, scope: { scope: 'delta', priorManifest: r1Manifest } }, ports, { runDir, attempt: 1 }))[0];
  assert.equal(r2?.type, 'REVIEW_PREPARED');
  // Changes remain attributed to 'Proposed Changes', not swallowed by ignored 'Execution Status'
  assert.deepEqual(r2?.scope['paths'], ['Proposed Changes']);
});

test('flow-review-context: start review forwards --context into run spec context and review prompt', async () => {
  const { options, runStarted, runDir } = setup(false);
  const result = await start({ ...options, runStarted: { ...runStarted, overrides: { context: 'Semantic intent from chat' } } });
  assert.equal(result.frame?.await, 'rule');
  const file = fs.readdirSync(runDir).find((name) => name.endsWith('.prompt.md'))!;
  const prompt = fs.readFileSync(path.join(runDir, file), 'utf8');
  assert.match(prompt, /- Task: Semantic intent from chat/);
  assert.match(prompt, /- Focus: Semantic intent from chat/);
});

test('flow-review-discovery: discovers unique session deliverables and respects explicit paths and ambiguity', async () => {
  const tmp = tempDir();
  const sessionDir = path.join(tmp, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'feat.plan.md'), '# Plan');
  fs.writeFileSync(path.join(sessionDir, 'feat.walkthrough.md'), '# Walkthrough');

  // 1. Unique candidates discovered through RUN_STARTED event and reviewSpecFromRun
  const { options, runStarted } = setup(false);
  const runDir1 = path.join(sessionDir, '.state/runs/001-code-review');
  const r1 = await start({ ...options, runDir: runDir1, runStarted });
  assert.equal(r1.frame?.await, 'rule');
  const file1 = fs.readdirSync(runDir1).find((name) => name.endsWith('.prompt.md'))!;
  const prompt1 = fs.readFileSync(path.join(runDir1, file1), 'utf8');
  const expectedPlan = path.join(sessionDir, 'feat.plan.md').replace(/\\/g, '/');
  const expectedWalkthrough = path.join(sessionDir, 'feat.walkthrough.md').replace(/\\/g, '/');
  assert.match(prompt1, new RegExp(`- Plan: ${expectedPlan.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(prompt1, new RegExp(`- Walkthrough: ${expectedWalkthrough.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  // 2. Absent deliverables in empty sessionDir -> leaves as None
  const emptyDir = path.join(tmp, 'empty-session');
  fs.mkdirSync(emptyDir, { recursive: true });
  const runDirEmpty = path.join(emptyDir, '.state/runs/001-code-review');
  const r2 = await start({ ...options, runDir: runDirEmpty, runStarted });
  assert.equal(r2.frame?.await, 'rule');
  const file2 = fs.readdirSync(runDirEmpty).find((name) => name.endsWith('.prompt.md'))!;
  const prompt2 = fs.readFileSync(path.join(runDirEmpty, file2), 'utf8');
  assert.match(prompt2, /- Plan: None/);
  assert.match(prompt2, /- Walkthrough: None/);

  // 3. Ambiguity: multiple plan candidates in sessionDir -> leaves Plan as None
  fs.writeFileSync(path.join(sessionDir, 'other.plan.md'), '# Other Plan');
  const runDirAmbig = path.join(sessionDir, '.state/runs/002-code-review');
  const r3 = await start({ ...options, runDir: runDirAmbig, runStarted });
  assert.equal(r3.frame?.await, 'rule');
  const file3 = fs.readdirSync(runDirAmbig).find((name) => name.endsWith('.prompt.md'))!;
  const prompt3 = fs.readFileSync(path.join(runDirAmbig, file3), 'utf8');
  assert.match(prompt3, /- Plan: None/);
  assert.match(prompt3, new RegExp(`- Walkthrough: ${expectedWalkthrough.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  // 4. Explicit path preserved over discovered or ambiguous
  const runDirExplicit = path.join(sessionDir, '.state/runs/003-code-review');
  const r4 = await start({
    ...options, runDir: runDirExplicit,
    runStarted: { ...runStarted, overrides: { governing: { planPath: 'docs/explicit.plan.md', walkthroughPath: 'docs/explicit.walkthrough.md' } } },
  });
  assert.equal(r4.frame?.await, 'rule');
  const file4 = fs.readdirSync(runDirExplicit).find((name) => name.endsWith('.prompt.md'))!;
  const prompt4 = fs.readFileSync(path.join(runDirExplicit, file4), 'utf8');
  assert.match(prompt4, /- Plan: docs\/explicit\.plan\.md/);
  assert.match(prompt4, /- Walkthrough: docs\/explicit\.walkthrough\.md/);
});



