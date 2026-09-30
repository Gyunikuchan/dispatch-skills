import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import type { Effect, Handler, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
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
  const git = createGit({ run: async (args) => (args[1] === '--show-toplevel' ? `${tmp}\n` : args[0] === 'diff' && args[1] === '--name-only' ? 'src/a.ts\n' : '') });
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
