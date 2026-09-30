import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import type { Effect, Handler, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import type { Git } from '../../../skills/dispatch/scripts/effects/git.ts';
import { createHandlers } from '../../../skills/dispatch/scripts/effects/index.ts';
import { governedPlanText } from '../../../skills/dispatch/scripts/domain/plan.ts';
import { rootMachine } from '../../../skills/dispatch/scripts/machines/root.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { appendEvent, journalPath } from '../../../skills/dispatch/scripts/core/journal.ts';
import { implementMachine } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { createRestore } from '../../../skills/dispatch/scripts/effects/restore.ts';
import { approvalState, FP, HASH, RUN } from '../machines/implement-recovery.test.ts';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../skills/dispatch');
const PLAN = `# Normalize values

> **TL;DR:** values need normalization before use.
> **Parent:** user request
> **Decide:** none
> **Risk:** low — isolated helper
> **Scope:** src/value.ts

## Key Decisions & Context
- Normalize whitespace and preserve case.

## Technical-Design Traceability
- Approved revision: none

## Success Criteria
- [SC1] Values are normalized
  - Changes: src/value.ts
  - Verify: \`node --test tests/value.test.ts\`
  - Evidence: verify
  - Test rationale: The focused regression names the whitespace behavior that the existing suite misses.

## Proposed Changes
### Value helper
#### [MODIFY] src/value.ts
- Changes: normalize the input before processing.

## Verification Plan
### Automated Tests
- \`npm run lint\`
### Manual Verification
- Observe normalized output.

## Review Findings & Resolutions
*No reviews conducted yet.*
`;

test('implement-completion-rules: flow reaches complete, replays deterministically, and renders its walkthrough', async () => {
  const cwd = tempDir();
  const sessionRoot = path.join(cwd, 'chat');
  const runDir = path.join(sessionRoot, '.state', 'runs', 'run-1');
  const planPath = path.join(cwd, 'normalize.plan.md');
  fs.writeFileSync(planPath, PLAN);
  const hash = `sha256:${crypto.createHash('sha256').update(governedPlanText(PLAN)).digest('hex')}`;
  const runStarted: RunStartedEvent = {
    type: 'RUN_STARTED', verb: 'implement', argument: planPath, level: 'low', levelSource: 'explicit', pins: null, fix: false,
    orchestrator: 'claude', orchestratorModel: null, overrides: { path: planPath, settledPlan: { path: planPath, hash, outcome: 'settled' } }, repo: {},
    config: {
      'write-subagents': { claude: { low: { model: 'writer-a' } } },
      'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } },
      phases: { 'plan-review': { rounds: { low: 1 }, targets: { low: 1 } }, 'code-review': { rounds: { low: 1 }, targets: { low: 1 } } },
    },
  };
  let changedPaths: string[] = [];
  let revision = 0;
  const git: Git = {
    toplevel: async () => cwd, indexEntries: async () => 'index', diffNames: async () => [...changedPaths],
    fingerprint: async () => ({ head: 'head', index: 'index', worktree: `tree-${revision}` }), changedSince: async () => [...changedPaths],
  };
  const wave: Handler<Extract<Effect, { kind: 'wave' }>> = async (effect) => [{
    type: 'WAVE_DONE', effectId: effect.id, round: effect.round,
    slots: effect.roster.map((slot) => ({ slot: String(slot['slot']), state: 'success', claim: 'Reviewed changed paths; no findings.' })), findings: [],
  }];
  const baseHandlers = createHandlers({ skillRoot: SKILL_ROOT, cwd, os: 'linux', git, tempRoot: path.join(cwd, 'tmp'), workspaceRoot: cwd, orchestratorPlatform: 'claude', wave });
  const handlers = { ...baseHandlers, handoff: async (effect: Extract<Effect, { kind: 'handoff' }>) => [{ type: 'HANDOFF_DONE' as const, effectId: effect.id, destination: sessionRoot, warning: null }] };
  const ports = fakePorts();
  ports.git = { run: async (argv) => argv.slice(2).map((file) => crypto.createHash('sha1').update(fs.readFileSync(path.join(cwd, file))).digest('hex')).join('\n') };
  const commands: string[] = [];
  ports.spawn = { run: async (argv) => { commands.push(argv.at(-1) ?? ''); return { exit: 0, stdout: 'ok', stderr: '' }; } };
  const options = { runDir, machine: rootMachine, handlers, ports, runRel: 'chat/.state/runs/run-1' };

  const approval = await start({ ...options, runStarted });
  assert.deepEqual([approval.frame?.await, approval.frame?.at], ['decide', 'implement › approval'], JSON.stringify(approval.frame));
  const write = await send({ ...options, rawEvent: { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed with implementation' } } });
  assert.deepEqual([write.frame?.await, write.frame?.at], ['write', 'implement › write']);
  const envelopePath = String(write.frame?.data['envelopePath']);
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'value.ts'), 'export const normalize = (value: string) => value;\n');
  changedPaths = ['src/value.ts'];
  revision = 1;
  fs.writeFileSync(envelopePath, JSON.stringify({
    schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'Values are normalized.',
    evidence: ['CRITERION SC1 | src/value.ts | trims values before processing'],
    files: [{ path: 'src/value.ts', note: 'Normalizes the input value.' }],
  }));
  const evidence = await send({ ...options, rawEvent: { type: 'WRITE_ENVELOPE', envelopePath } });
  assert.deepEqual([evidence.frame?.await, evidence.frame?.at], ['evidence', 'implement › evidence']);
  const done = await send({ ...options, rawEvent: { type: 'EVIDENCE', criteria: { SC1: { outcome: 'pass', evidence: 'node test passed after the source edit' } } } });
  assert.equal(done.frame?.await, 'done');
  assert.equal(done.frame?.data['outcome'], 'complete');
  assert.equal(commands.filter((command) => command === 'node --test tests/value.test.ts').length, 2, 'baseline and scoped runs execute; the final gate reuses the fresh pass');
  const walkthroughs = fs.readdirSync(sessionRoot).filter((name) => name.endsWith('.walkthrough.md'));
  assert.equal(walkthroughs.length, 1);
  assert.match(fs.readFileSync(path.join(sessionRoot, walkthroughs[0] as string), 'utf8'), /## Verification/);
  assert.deepEqual((await send({ ...options, dryRun: true })).frame, done.frame);
});

test('implementation parked host replay and in-flight restore replay reuse durable binary patch', async () => {
  const cwd = tempDir(), runDir = tempDir(), ports = fakePorts();
  fs.mkdirSync(path.join(cwd, 'src')); fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), Buffer.from('before'));
  const before = { ...FP, recovery: { ...(FP['recovery'] as import('../../../skills/dispatch/scripts/core/types.ts').RecoverySnapshot), entries: { 'src/a.ts': { kind: 'file' as const, mode: fs.statSync(path.join(cwd, 'src', 'a.ts')).mode & 0o7777, linkTarget: null } } } };
  const c = { ...approvalState().c, lastFingerprint: before, startFingerprint: before };
  const writer = { tag: 'write' as const, c, info: { stage: 'production' as const, attempt: 1, models: ['writer-a', 'writer-b'], modelIndex: 0, briefPath: 'brief', briefSha256: HASH, envelopePath: 'outcome', preFingerprint: before, repair: false } };
  const machine = { ...implementMachine, initial: () => writer };
  let seq = 1;
  const record = (event: import('../../../skills/dispatch/scripts/core/types.ts').Event) => { const { type, ...data } = event; appendEvent(ports, runDir, type, data, seq++); };
  record(RUN);
  const failed = { type: 'WRITE_FAILED' as const, model: 'writer-a', kind: 'quota', reason: 'partial write' };
  record(failed);
  const parked = machine.step(writer, failed);
  assert.equal(parked.state.tag, 'checking-host-event');
  const handlers = {
    snapshot: async (effect: Extract<Effect, { kind: 'snapshot' }>) => [{ type: 'SNAPSHOT' as const, effectId: effect.id, fingerprint: { ...before, worktree: 'changed' }, diff: { paths: ['src/a.ts'] } }],
    restore: createRestore({ cwd }),
  };
  fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), Buffer.from([255, 0, 254]));
  const result = await send({ runDir, machine, handlers, ports });
  assert.equal(result.frame?.await, 'write', JSON.stringify(result.frame)); assert.equal(result.frame?.data['model'], 'writer-b');
  assert.equal(fs.readFileSync(path.join(cwd, 'src', 'a.ts'), 'utf8'), 'before');
  const patch = fs.readdirSync(runDir).find((file) => file.endsWith('.restore.json'))!;
  const published = fs.readFileSync(path.join(runDir, patch), 'utf8');
  assert.ok(published.includes(Buffer.from([255, 0, 254]).toString('base64')));
  // Simulate a process dying after durable EFFECT_STARTED by removing just the terminal restore journal line.
  const journal = journalPath(runDir);
  const lines = fs.readFileSync(journal, 'utf8').trimEnd().split('\n');
  assert.ok(lines.at(-1)?.includes('RESTORED'));
  fs.writeFileSync(journal, `${lines.slice(0, -1).join('\n')}\n`);
  const replayed = await send({ runDir, machine, handlers, ports });
  assert.equal(replayed.frame?.data['model'], 'writer-b');
  assert.equal(fs.readFileSync(path.join(runDir, patch), 'utf8'), published);
  assert.equal((await send({ runDir, machine, handlers, ports, dryRun: true })).frame?.data['model'], 'writer-b');
});
