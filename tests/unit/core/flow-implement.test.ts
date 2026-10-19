import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { send } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { start } from '../../helpers/governed-start.ts';
import type { Effect, Handler, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import type { Git } from '../../../skills/dispatch/scripts/effects/git.ts';
import { createHandlers } from '../../../skills/dispatch/scripts/effects/index.ts';
import { governedPlanText } from '../../../skills/dispatch/scripts/domain/plan.ts';
import { rootMachine } from '../../../skills/dispatch/scripts/machines/root.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { stepImplement } from '../../../skills/dispatch/scripts/machines/implement.ts';
import { approvalState, FP, HASH } from '../machines/fixtures/implement-recovery.ts';
import { authoringFlow, completionFlow, PLAN, SKILL_ROOT, type CommandRun } from './fixtures/flow-implement.ts';

for (const planMode of ['external'] as const) test(`implement-completion-rules: ${planMode} flow binds a real walkthrough and replays completion`, async () => {
  const runs: CommandRun[] = [];
  await completionFlow(planMode, undefined, runs);
  const location = (dir: string) => ({ '.': 'caller', 'wt/T1': 'task', 'wt/integration': 'integration' } as Record<string, string>)[dir] ?? dir;
  const gates = ['node --test tests/value.test.ts', 'npm run lint'];
  // Each gate runs the criterion command and the contract command; final verification reruns both on the caller checkout.
  assert.deepEqual(runs.filter((row) => gates.includes(row.command)).map((row) => [row.command, location(row.cwd)]),
    ['caller', 'task', 'integration', 'caller'].flatMap((where) => gates.map((command) => [command, where])));
});

test('governing spec default preserves implementation review artifacts criteria and structural focus', async () => {
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
  assert.doesNotMatch(prompt, /- Task: null/); assert.match(prompt, /- Task: Review the selected changes\./);
  assert.equal(effect.review['context'], null);
  assert.ok(effect.review['governing'] && typeof effect.review['governing'] === 'object');
});

test('task-map-authored: direct implement authoring preserves the authored Task Map through review fixes', async () => {
  const { authored, settled, frame } = await authoringFlow();
  assert.deepEqual([frame?.await, frame?.data['kind']], ['decide', 'approval'], JSON.stringify(frame));
  assert.match(authored, /## Task Map\n\| ID \| Title \| Outcome \| Prerequisites \| Criteria \|\n\| --- \| --- \| --- \| --- \| --- \|\n\| T1 \| Normalize values \| Values are normalized before use so downstream comparisons agree\. \| none \| SC1 \|/);
  assert.match(settled, /## Task Map\n\| ID \| Title \| Outcome \| Prerequisites \| Criteria \|\n\| --- \| --- \| --- \| --- \| --- \|\n\| T1 \| Normalize trimmed values \| Values are normalized before use so downstream comparisons agree\. \| none \| SC1 \|/);
  assert.equal((settled.match(/^## Task Map$/gm) ?? []).length, 1);
  assert.equal(governedPlanText(settled), governedPlanText(PLAN
    .replace('| T1 | Normalize values | Values are normalized before use so downstream comparisons agree. | none | SC1 |', '| T1 | Normalize trimmed values | Values are normalized before use so downstream comparisons agree. | none | SC1 |')
    .replace('### T1 — Normalize values', '### T1 — Normalize trimmed values')));
});
