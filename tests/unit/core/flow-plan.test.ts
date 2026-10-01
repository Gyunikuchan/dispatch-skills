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
### Fetch
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
