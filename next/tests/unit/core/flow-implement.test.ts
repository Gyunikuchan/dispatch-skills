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
