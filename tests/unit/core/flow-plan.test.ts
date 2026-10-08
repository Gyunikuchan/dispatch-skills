import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import type { Effect, Handler, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { createGit } from '../../../skills/dispatch/scripts/effects/git.ts';
import { createHandlers } from '../../../skills/dispatch/scripts/effects/index.ts';
import { rootMachine, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import { beginReview } from '../../../skills/dispatch/scripts/machines/review.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../skills/dispatch');
const PLAN = `# Add retry budget

> **TL;DR:** fetch retries forever; cap them.
> **Parent:** user request
> **Decide:** none
> **Risk:** low — isolated helper
> **Scope:** src/fetch.ts

## Key Decisions & Context
- Cap at three attempts (user)

## Technical-Design Traceability
- Approved revision: none

## Success Criteria
- [SC1] Whole suite stays green
  - Changes: src/fetch.ts
  - Verify: \`npm test\` [FINAL]
  - Evidence: verify
  - Test rationale: aggregate regression gate over every package.

## Proposed Changes
### T1 — Cap fetch retries
Fetch stops retrying after three attempts so callers fail fast.
- Prerequisites: none
- Criteria: SC1

#### [MODIFY] src/fetch.ts
- Changes: add a retry counter to fetchWithRetry.

## Verification Plan
### Automated Tests
- \`npm run lint\`
### Manual Verification
- Observe logs.

## Review Findings & Resolutions
*No reviews conducted yet.*
`;

test('readable plan review flow: report precedes portable links and replay reuses run and machine identity', () => {
  const ports = fakePorts(), base = tempDir(), session = path.join(base, 'reports (full)'), owner = path.join(base, 'owners', 'plan with (spaces).plan.md');
  ports.fs.writeAtomic(owner, PLAN);
  const writes: string[] = [];
  const write = ports.fs.writeAtomic;
  ports.fs.writeAtomic = (file, text) => { writes.push(file); write(file, text); };
  const stateOf = (machine: string): RootState => {
    const begun = beginReview({ kind: 'plan', mode: 'report', target: owner, cap: 1, breadth: 1, context: '', roster: [], timeoutMs: 1000 }, machine, {}).state;
    if (!('c' in begun)) throw new Error('review');
    return { tag: 'review', run: { verb: 'review', argument: owner, slug: 'plan' }, child: { tag: 'rule', c: { ...begun.c, round: 1, rounds: [{ round: 1, scope: 'full', reviewers: ['reader'], failed: [] }], findings: [{ id: 'R1-F001', round: 1, status: 'accepted', severity: 'SHOULD', category: 'correctness', locus: 'src/a.ts:L1', defect: 'Missing check. More detail belongs in the report.', requiredChange: 'Add the check.', resolution: 'Keep API.\nAdd check.', sources: ['reader'], scope: 'in' }] } } };
  };
  const runDir = path.join(session, '.state', 'runs', '001-review');
  const state = stateOf('plan.review');
  rootMachine.render!(state, ports, runDir);
  assert.equal(writes.length, 2);
  assert.equal(writes[1], owner);
  const report = ports.fs.readText(writes[0]!);
  assert.match(report, /More detail belongs in the report./);
  assert.match(report, /Required change: Add the check./);
  assert.match(report, /- Ruling:\n  Keep API.  \n  Add check.\n/);
  const plan = ports.fs.readText(owner);
  assert.ok(!plan.includes('More detail belongs'));
  const ref = /Full report: \[R1-F001\]\(([^)]+)#r1-f001\)/.exec(plan)![1]!;
  assert.ok(!ref.includes('\\'));
  assert.match(ref, /reports%20%28full%29/);
  assert.equal(path.resolve(path.dirname(owner), decodeURIComponent(ref)), path.resolve(writes[0]!));
  writes.length = 0;
  rootMachine.render!(state, ports, runDir);
  assert.deepEqual(writes, []);
  rootMachine.render!(stateOf('design.i01.plan.review'), ports, runDir);
  rootMachine.render!(state, ports, path.join(session, '.state', 'runs', '002-review'));
  assert.equal(new Set(writes.filter(f => f !== owner)).size, 2);
  assert.equal((ports.fs.readText(owner).match(/^### Review /gm) ?? []).length, 3);
});

test('readable plan review flow: failed report write leaves owner intact without dangling links or invented rationale', () => {
  const ports = fakePorts(), session = tempDir(), owner = path.join(session, 'plan.md');
  ports.fs.writeAtomic(owner, PLAN);
  const begun = beginReview({ kind: 'plan', mode: 'report', target: owner, cap: 1, breadth: 1, context: '', roster: [], timeoutMs: 1000 }, 'review', {}).state;
  if (!('c' in begun)) throw new Error('review');
  const state: RootState = { tag: 'review', run: { verb: 'review', argument: owner, slug: 'plan' }, child: { tag: 'rule', c: { ...begun.c, round: 1, rounds: [{ round: 1, scope: 'full', reviewers: ['reader'], failed: [] }], findings: [{ id: 'R1-F001', round: 1, status: 'accepted', severity: 'SHOULD', category: 'correctness', locus: 'src/a.ts:L1', defect: 'Missing check', requiredChange: 'Add check', sources: ['reader'], scope: 'in' }] } } };
  const write = ports.fs.writeAtomic;
  ports.fs.writeAtomic = (file, text) => { if (file.endsWith('.report.md')) throw new Error('disk full'); write(file, text); };
  assert.throws(() => rootMachine.render!(state, ports, session), /disk full/);
  assert.equal(ports.fs.readText(owner), PLAN);
  ports.fs.writeAtomic = write;
  rootMachine.render!(state, ports, session);
  assert.ok(!ports.fs.readText(owner).includes('- Ruling:'));
});

test('plan end to end: author → AUTHORED → parse → review → rule → done complete with the resolution section rendered', async () => {
  const wave: Handler<Extract<Effect, { kind: 'wave' }>> = async (effect) => [{
    type: 'WAVE_DONE', effectId: effect.id, round: effect.round, slots: [{ slot: 'codex[0]', state: 'success' }],
    findings: [{ id: 'R1-F001', severity: 'CONSIDER', category: 'clarity', locus: '§ Proposed Changes', defect: 'vague note', requiredChange: 'name the helper', sources: ['codex[0]'], scope: 'in' }],
  }];
  const tmp = tempDir();
  const handlers = createHandlers({ skillRoot: SKILL_ROOT, cwd: tmp, os: 'linux', git: createGit({ run: async () => '' }), tempRoot: path.join(tmp, 'tmp'), workspaceRoot: tmp, orchestratorPlatform: 'claude', wave });
  const runDir = path.join(tmp, 'run');
  const planPath = path.join(tmp, 'add-retry.plan.md');
  const ports = fakePorts();
  const runStarted: RunStartedEvent = {
    type: 'RUN_STARTED', verb: 'plan', argument: 'Add retry budget', level: 'low', levelSource: 'explicit', pins: null, fix: false,
    orchestrator: 'claude', orchestratorModel: null, overrides: {}, repo: {},
    config: { 'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } }, phases: { 'plan-review': { rounds: { low: 1 }, targets: { low: 1 } } } },
  };
  const options = { runDir, machine: rootMachine, handlers, ports, runRel: 'run' };
  const authored = await start({ ...options, runStarted });
  assert.deepEqual([authored.frame?.at, authored.frame?.await], ['plan › author', 'author']);
  fs.writeFileSync(planPath, PLAN);
  const rule = await send({ ...options, rawEvent: { type: 'AUTHORED', path: planPath } });
  assert.deepEqual([rule.frame?.at, rule.frame?.await], ['plan › review › rule', 'rule']);
  const done = await send({ ...options, rawEvent: JSON.stringify({ type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'reject', reason: 'already named' } } }) });
  assert.deepEqual([done.frame?.at, done.frame?.data['outcome']], ['plan › done', 'complete']);
  const rendered = fs.readFileSync(planPath, 'utf8');
  assert.match(rendered, /## Review Findings & Resolutions[\s\S]*R1-F001/);
  assert.ok(rendered.startsWith('# Add retry budget'));
  const replay = await send({ ...options, dryRun: true });
  assert.deepEqual(replay.frame, done.frame);
});
