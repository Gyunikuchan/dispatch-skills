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
import { stepImplement } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { approvalState, FP, HASH } from '../machines/implement-recovery.test.ts';

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
### T1 — Normalize values
Values are normalized before use so downstream comparisons agree.
- Prerequisites: none
- Criteria: SC1

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

for (const planMode of ['external', 'session', 'objective'] as const) test(`implement-completion-rules: ${planMode} flow binds a real walkthrough and replays completion`, async () => {
  const cwd = tempDir();
  const sessionRoot = path.join(cwd, 'chat');
  const runDir = path.join(sessionRoot, '.state', 'runs', 'run-1');
  fs.mkdirSync(sessionRoot);
  const planPath = path.join(planMode === 'session' ? sessionRoot : cwd, planMode === 'objective' ? 'normalize-values.plan.md' : 'normalize.plan.md');
  fs.writeFileSync(planPath, PLAN);
  const hash = `sha256:${crypto.createHash('sha256').update(governedPlanText(PLAN)).digest('hex')}`;
  const runStarted: RunStartedEvent = {
    type: 'RUN_STARTED', verb: 'implement', argument: planMode === 'objective' ? 'Normalize values' : planPath, level: 'low', levelSource: 'explicit', pins: null, fix: false,
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
  const reviewed = { path: null as string | null };
  const wave: Handler<Extract<Effect, { kind: 'wave' }>> = async (effect) => {
    if (effect.roster[0]?.['review'] === 'code') {
      const prompt = fs.readFileSync(String(effect.roster[0]['promptPath']), 'utf8');
      reviewed.path = /^- Walkthrough: (.+)$/m.exec(prompt)?.[1]?.trim() ?? null;
      assert.ok(reviewed.path); assert.ok(fs.existsSync(reviewed.path), reviewed.path);
      assert.match(fs.readFileSync(reviewed.path, 'utf8'), /## Verification/);
      assert.match(fs.readFileSync(reviewed.path, 'utf8'), /Status:\*\* review pending/);
    }
    return [{
    type: 'WAVE_DONE', effectId: effect.id, round: effect.round,
    slots: effect.roster.map((slot) => ({ slot: String(slot['slot']), state: 'success', claim: 'Reviewed changed paths; no findings.' })), findings: [],
  }]; };
  const baseHandlers = createHandlers({ skillRoot: SKILL_ROOT, cwd, os: 'linux', git, tempRoot: path.join(cwd, 'tmp'), workspaceRoot: cwd, orchestratorPlatform: 'claude', wave });
  // NOTE: fake Git cannot host worktrees, so every checkout op resolves to the caller tree and delivery transfers the changed paths.
  const checkout = async (effect: Extract<Effect, { kind: 'checkout' }>) => [{ type: 'CHECKOUT_DONE' as const, effectId: effect.id, op: effect.op,
    result: { path: cwd, base: 'base', revision: effect.op === 'task' ? 'base' : `rev-${effect.op}`, manifest: { linked: [] }, paths: [...changedPaths], conflict: false, conflicts: [], transferred: [...changedPaths], already: [], defects: [] } }];
  const handlers = { ...baseHandlers, checkout, handoff: async (effect: Extract<Effect, { kind: 'handoff' }>) => [{ type: 'HANDOFF_DONE' as const, effectId: effect.id, destination: sessionRoot, warning: null }] };
  const ports = fakePorts();
  ports.git = { run: async (argv) => argv.slice(2).map((file) => crypto.createHash('sha1').update(fs.readFileSync(path.join(cwd, file))).digest('hex')).join('\n') };
  const commands: string[] = [];
  ports.spawn = { run: async (argv) => { commands.push(argv.at(-1) ?? ''); return { exit: 0, stdout: 'ok', stderr: '' }; } };
  const options = { runDir, machine: rootMachine, handlers, ports, runRel: 'chat/.state/runs/run-1' };

  const approval = await start({ ...options, runStarted });
  assert.deepEqual([approval.frame?.await, approval.frame?.at], ['decide', 'implement › approval'], JSON.stringify(approval.frame));
  const classification = await send({ ...options, rawEvent: { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed with implementation' } } });
  assert.deepEqual([classification.frame?.await, classification.frame?.data['kind']], ['decide', 'level-classification']);
  const write = await send({ ...options, rawEvent: { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'low', rationale: 'This is one bounded and recoverable behavior change.', gateScope: classification.frame?.data['gateScope'] } } });
  assert.deepEqual([write.frame?.await, write.frame?.at], ['write', 'implement › tasks']);
  const [slot] = write.frame?.data['tasks'] as { task: string; action: string; attempt: number; signature: string; envelopePath: string }[];
  assert.deepEqual([slot?.task, slot?.action], ['T1', 'launch']);
  const envelopePath = String(slot?.envelopePath);
  const launched = await send({ ...options, rawEvent: { type: 'WRITE_LAUNCHED', tasks: [{ task: 'T1', attempt: slot!.attempt, signature: slot!.signature, handle: 'agent-1' }] } });
  assert.equal((launched.frame?.data['tasks'] as { action: string }[])[0]?.action, 'running');
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'value.ts'), 'export const normalize = (value: string) => value;\n');
  changedPaths = ['src/value.ts'];
  revision = 1;
  fs.writeFileSync(envelopePath, JSON.stringify({
    schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'Values are normalized.',
    evidence: ['CRITERION SC1 | src/value.ts | trims values before processing'],
    files: [{ path: 'src/value.ts', note: 'Normalizes the input value.' }],
  }));
  const evidence = await send({ ...options, rawEvent: { type: 'WRITE_ENVELOPE', task: 'T1', attempt: slot!.attempt, signature: slot!.signature, handle: 'agent-1', envelopePath } });
  assert.deepEqual([evidence.frame?.await, evidence.frame?.at], ['evidence', 'implement › evidence']);
  const done = await send({ ...options, rawEvent: { type: 'EVIDENCE', criteria: { SC1: { outcome: 'pass', evidence: 'node test passed after the source edit' } } } });
  assert.equal(done.frame?.await, 'done');
  assert.equal(done.frame?.data['outcome'], 'complete', JSON.stringify(done.frame));
  assert.equal(commands.filter((command) => command === 'node --test tests/value.test.ts').length, 4, 'baseline, task, integration, and caller-checkout final runs execute');
  const walkthroughs = fs.readdirSync(sessionRoot).filter((name) => name.endsWith('.walkthrough.md'));
  assert.equal(walkthroughs.length, 1); assert.equal(reviewed.path?.replaceAll('\\', '/'), path.join(sessionRoot, walkthroughs[0]!).replaceAll('\\', '/'));
  assert.match(fs.readFileSync(path.join(sessionRoot, walkthroughs[0] as string), 'utf8'), /## Verification/);
  assert.deepEqual((await send({ ...options, dryRun: true })).frame, done.frame);
});

test('rewrite SC2 implementation review carries governing artifacts and criteria', async () => {
  const state = approvalState();
  const c = { ...state.c, planPath: 'feature.plan.md', run: { ...state.c.run, config: { ...state.c.run.config, phases: { 'code-review': { rounds: { low: 1 }, targets: { low: 1 } } } } } };
  const result = stepImplement({ tag: 'delivered-snapshot', c: { ...c, phase: 'delivered' }, effectId: 'delivered' }, { type: 'SNAPSHOT', effectId: 'delivered', fingerprint: FP, diff: { paths: [] } });
  const checked = result.state.tag === 'checking-host-event' ? stepImplement(result.state, { type: 'SNAPSHOT', effectId: result.state.effectId, fingerprint: FP, diff: { paths: [] } }) : result;
  assert.equal(checked.state.tag, 'code-review');
  const effect = checked.effects.find((e) => e.kind === 'prepare-review');
  assert.equal(effect?.kind, 'prepare-review');
  if (effect?.kind !== 'prepare-review') return;
  const tmp = tempDir();
  const ports = fakePorts();
  const git: Git = { toplevel: async () => tmp, indexEntries: async () => '', diffNames: async () => ['src/a.ts'], fingerprint: async () => ({ head: 'h', index: 'i', worktree: 'w' }), changedSince: async () => [] };
  const handlers = createHandlers({ skillRoot: SKILL_ROOT, cwd: tmp, os: 'linux', git, tempRoot: tmp, workspaceRoot: tmp, orchestratorPlatform: 'claude', wave: async () => [] });
  const results = await handlers['prepare-review']!(effect, ports, { runDir: tmp, attempt: 1 });
  const prepared = results[0]; assert.equal(prepared?.type, 'REVIEW_PREPARED');
  if (prepared?.type !== 'REVIEW_PREPARED') return;
  const prompt = fs.readFileSync(Object.values(prepared.promptPaths)[0]!, 'utf8');
  assert.match(prompt, /feature\.plan\.md/); assert.match(prompt, /x\.walkthrough\.md/); assert.match(prompt, /SC1/); assert.match(prompt, /check/);
  assert.doesNotMatch(prompt, /- Task: null/); assert.match(prompt, /- Task: x/);
});

test('review fix design walkthrough uses the originating slug once for each increment', () => {
  const state = approvalState();
  const run = { ...state.c.run, argument: 'chat/renamed-i01.plan.md', overrides: { ...state.c.run.overrides, sessionDir: 'chat', artifactSlug: 'original-objective' }, config: { ...state.c.run.config, phases: { 'code-review': { rounds: { low: 1 }, targets: { low: 1 } } } } };
  const c = { ...state.c, run, designBinding: { path: 'renamed.design.md', revision: HASH, increment: 'I01', contract: {}, paths: ['src/a.ts'], approval: { by: 'user' as const, quote: 'Approved', hash: HASH }, repair: [] } };
  let result = stepImplement({ tag: 'delivered-snapshot', c: { ...c, phase: 'delivered' }, effectId: 'delivered' }, { type: 'SNAPSHOT', effectId: 'delivered', fingerprint: FP, diff: { paths: [] } });
  if (result.state.tag === 'checking-host-event') result = stepImplement(result.state, { type: 'SNAPSHOT', effectId: result.state.effectId, fingerprint: FP, diff: { paths: [] } });
  const effect = result.effects.find((row) => row.kind === 'prepare-review'); assert.equal(effect?.kind, 'prepare-review');
  if (effect?.kind === 'prepare-review') assert.equal((effect.review['governing'] as Record<string,unknown>)['walkthroughPath'], 'chat/original-objective-i01.walkthrough.md');
});
