import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { send, start } from '../../../../skills/dispatch/scripts/core/interpreter.ts';
import type { Effect, Handler, Ports, RunStartedEvent } from '../../../../skills/dispatch/scripts/core/types.ts';
import type { Git } from '../../../../skills/dispatch/scripts/effects/git.ts';
import { createHandlers } from '../../../../skills/dispatch/scripts/effects/index.ts';
import { governedPlanText } from '../../../../skills/dispatch/scripts/domain/plan.ts';
import { rootMachine } from '../../../../skills/dispatch/scripts/machines/root.ts';
import { fakePorts, tempDir } from '../../../helpers/fake-ports.ts';
import { memoryRunFs } from '../../../helpers/memory-run-fs.ts';
import { stepImplement } from '../../../../skills/dispatch/scripts/machines/implement.ts';
import { approvalState, FP, HASH } from '../../machines/fixtures/implement-recovery.ts';

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../skills/dispatch');
export const PLAN = `# Normalize values

> **TL;DR:** values need normalization before use.
> **Parent:** user request
> **Decide:** none
> **Risk:** low — isolated helper
> **Scope:** src/value.ts

## Key Decisions & Context
- Normalize whitespace and preserve case.

## Task Map
| ID | Title | Outcome | Prerequisites | Criteria |
| --- | --- | --- | --- | --- |
| T1 | Normalize values | Values are normalized before use so downstream comparisons agree. | none | SC1 |

## Technical-Design Traceability
- Approved revision: none

## Proposed Changes
### T1 — Normalize values
#### [MODIFY] src/value.ts
- Changes: normalize the input before processing.

## Success Criteria
- [SC1] Values are normalized
  - Changes: src/value.ts
  - Verify: \`node --test tests/value.test.ts\`
  - Evidence: verify
  - Test rationale: The focused regression names the whitespace behavior that the existing suite misses.

## Verification Plan
### Automated Tests
- \`npm run lint\`
### Manual Verification
- Observe normalized output.

## Review Findings & Resolutions
*No reviews conducted yet.*
`;

/** One completion flow through real handlers: binds a walkthrough and replays completion. */
export async function completionFlow(planMode: 'external' | 'session' | 'objective', configurePorts?: (ports: Ports, runDir: string) => void): Promise<void> {
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
      const prompt = ports.fs.readText(String(effect.roster[0]['promptPath']));
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
  // NOTE: a trim `observe` input only reports the caller blobs at the review boundary, matching the real handler.
  const observe = (files: unknown) => Array.isArray(files)
    ? { observed: Object.fromEntries(files.map((file: string) => [file, fs.existsSync(path.join(cwd, file)) ? crypto.createHash('sha1').update(fs.readFileSync(path.join(cwd, file))).digest('hex') : null])) }
    : null;
  const checkout = async (effect: Extract<Effect, { kind: 'checkout' }>) => [{ type: 'CHECKOUT_DONE' as const, effectId: effect.id, op: effect.op,
    result: observe((effect.input as Record<string, unknown> | undefined)?.['observe']) ?? { path: cwd, base: 'base', revision: effect.op === 'task' ? 'base' : `rev-${effect.op}`, manifest: { linked: [] }, paths: [...changedPaths], conflict: false, conflicts: [], transferred: [...changedPaths], already: [], defects: [] } }];
  const handlers = { ...baseHandlers, checkout, handoff: async (effect: Extract<Effect, { kind: 'handoff' }>) => [{ type: 'HANDOFF_DONE' as const, effectId: effect.id, destination: sessionRoot, warning: null }] };
  const ports = fakePorts();
  memoryRunFs(ports, runDir);
  configurePorts?.(ports, runDir);
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
  const launched = await send({ ...options, rawEvent: { type: 'WRITE_RECEIPT', status: 'launched', task: 'T1', attempt: slot!.attempt, signature: slot!.signature, handle: 'agent-1', model: (slot as unknown as { model: string }).model, ...(typeof write.frame!.data['effort'] === 'string' ? { effort: write.frame!.data['effort'] as string } : {}) } });
  assert.equal((launched.frame?.data['tasks'] as { action: string }[])[0]?.action, 'running');
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'value.ts'), 'export const normalize = (value: string) => value;\n');
  changedPaths = ['src/value.ts'];
  revision = 1;
  ports.fs.writeAtomic(envelopePath, JSON.stringify({
    schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'Values are normalized.',
    evidence: ['CRITERION SC1 | src/value.ts | trims values before processing'],
    files: [{ path: 'src/value.ts', note: 'Normalizes the input value.' }],
  }));
  const evidence = await send({ ...options, rawEvent: { type: 'WRITE_RECEIPT', status: 'submitted', task: 'T1', attempt: slot!.attempt, signature: slot!.signature, handle: 'agent-1', envelopePath, briefHash: String((launched.frame?.data['tasks'] as { briefHash: string }[])[0]?.briefHash), model: (slot as unknown as { model: string }).model } });
  assert.deepEqual([evidence.frame?.await, evidence.frame?.at], ['evidence', 'implement › evidence'], JSON.stringify(evidence.frame));
  const done = await send({ ...options, rawEvent: { type: 'EVIDENCE', criteria: { SC1: { outcome: 'pass', evidence: 'node test passed after the source edit' } } } });
  assert.equal(done.frame?.await, 'done', JSON.stringify(done.frame));
  assert.equal(done.frame?.data['outcome'], 'complete', JSON.stringify(done.frame));
  assert.equal(commands.filter((command) => command === 'node --test tests/value.test.ts').length, 4, 'baseline, task, integration, and caller-checkout final runs execute');
  const walkthroughs = fs.readdirSync(sessionRoot).filter((name) => name.endsWith('.walkthrough.md'));
  assert.equal(walkthroughs.length, 1); assert.equal(reviewed.path?.replaceAll('\\', '/'), path.join(sessionRoot, walkthroughs[0]!).replaceAll('\\', '/'));
  assert.match(fs.readFileSync(path.join(sessionRoot, walkthroughs[0] as string), 'utf8'), /## Verification/);
  assert.deepEqual((await send({ ...options, dryRun: true })).frame, done.frame);
  assert.equal(governedPlanText(fs.readFileSync(planPath, 'utf8')), governedPlanText(PLAN), 'root rendering keeps the authored Task Map in the supplied plan');
}

/** Direct implement authoring through real handlers: the host authors a plan for an objective, plan review accepts one fix, then the run awaits approval. */
export async function authoringFlow(): Promise<{ planPath: string; authored: string; settled: string; frame: Awaited<ReturnType<typeof send>>['frame'] }> {
  const cwd = tempDir();
  const sessionRoot = path.join(cwd, 'chat');
  const runDir = path.join(sessionRoot, '.state', 'runs', 'run-1');
  const runStarted: RunStartedEvent = {
    type: 'RUN_STARTED', verb: 'implement', argument: 'Normalize values', level: 'low', levelSource: 'explicit', pins: null, fix: true,
    orchestrator: 'claude', orchestratorModel: null, overrides: { sessionDir: sessionRoot }, repo: {},
    config: {
      'write-subagents': { claude: { low: { model: 'writer-a' } } },
      'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } },
      phases: { 'plan-review': { rounds: { low: 1 }, targets: { low: 1 } }, 'code-review': { rounds: { low: 1 }, targets: { low: 1 } } },
    },
  };
  const git: Git = {
    toplevel: async () => cwd, indexEntries: async () => 'index', diffNames: async () => [],
    fingerprint: async () => ({ head: 'head', index: 'index', worktree: 'tree' }), changedSince: async () => [],
  };
  let waves = 0;
  const wave: Handler<Extract<Effect, { kind: 'wave' }>> = async (effect) => [{
    type: 'WAVE_DONE', effectId: effect.id, round: effect.round,
    slots: effect.roster.map((slot) => ({ slot: String(slot['slot']), state: 'success', claim: 'Reviewed the plan.' })),
    findings: waves++ ? [] : [{ id: 'R1-F001', severity: 'SHOULD', category: 'clarity', locus: '§ Proposed Changes', defect: 'The task title omits trimming.', requiredChange: 'Name trimming in the T1 title.', sources: [String(effect.roster[0]?.['slot'])], scope: 'in' }],
  }];
  const handlers = createHandlers({ skillRoot: SKILL_ROOT, cwd, os: 'linux', git, tempRoot: path.join(cwd, 'tmp'), workspaceRoot: cwd, orchestratorPlatform: 'claude', wave });
  const ports = fakePorts();
  // NOTE: logical flow state stays in memory so the per-file timing budget holds under aggregate load.
  memoryRunFs(ports, cwd);
  ports.spawn = { run: async () => ({ exit: 0, stdout: 'ok', stderr: '' }) };
  const options = { runDir, machine: rootMachine, handlers, ports, runRel: 'chat/.state/runs/run-1' };
  const author = await start({ ...options, runStarted });
  assert.equal(author.frame?.await, 'author', JSON.stringify(author.frame));
  const planPath = String(author.frame?.data['path']);
  ports.fs.writeAtomic(planPath, PLAN);
  let frame = (await send({ ...options, rawEvent: { type: 'AUTHORED', path: planPath } })).frame;
  const authored = ports.fs.readText(planPath);
  for (let guard = 0; frame && frame.await !== 'decide' && guard < 6; guard++) {
    if (frame.await === 'rule') {
      const rulings = Object.fromEntries((frame.data['findings'] as { id: string }[]).map(({ id }) => [id, { ruling: 'accept' }]));
      frame = (await send({ ...options, rawEvent: { type: 'RULINGS', rulings } })).frame;
    } else if (frame.await === 'fix') {
      ports.fs.writeAtomic(planPath, ports.fs.readText(planPath)
        .replace('| T1 | Normalize values | Values are normalized before use so downstream comparisons agree. | none | SC1 |', '| T1 | Normalize trimmed values | Values are normalized before use so downstream comparisons agree. | none | SC1 |')
        .replace('### T1 — Normalize values', '### T1 — Normalize trimmed values'));
      frame = (await send({ ...options, rawEvent: { type: 'FIXES_APPLIED', clusters: (frame.data['clusters'] as { clusterId: string }[]).map((cluster) => ({ clusterId: cluster.clusterId, status: 'applied' })) } })).frame;
    } else assert.fail(JSON.stringify(frame));
  }
  return { planPath, authored, settled: ports.fs.readText(planPath), frame };
}
