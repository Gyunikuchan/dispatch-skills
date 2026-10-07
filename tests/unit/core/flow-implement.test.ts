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
import { approvalState, FP, HASH } from '../machines/fixtures/implement-recovery.ts';
import { completionFlow, PLAN, SKILL_ROOT } from './fixtures/flow-implement.ts';

for (const planMode of ['external'] as const) test(`implement-completion-rules: ${planMode} flow binds a real walkthrough and replays completion`, () => completionFlow(planMode));

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
