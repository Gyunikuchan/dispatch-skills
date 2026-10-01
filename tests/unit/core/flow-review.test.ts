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
