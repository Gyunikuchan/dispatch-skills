import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { Event } from '../../../skills/dispatch/scripts/core/types.ts';
import { createWriteBrief } from '../../../skills/dispatch/scripts/effects/write-brief.ts';
import { AMEND_PLAN } from './fixtures/implement-amend.ts';
import { host, launch, start, type Sim } from './fixtures/implement-tasks.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../skills/dispatch');

// SECTION: AMEND then brief — the shared context carries a Task Map derived from the amended tasks, not from file text.

test('amend-brief-task-map: a brief regenerated after AMEND carries the amended Task Map', async () => {
  const sim: Sim = { plan: AMEND_PLAN };
  const started = start(3, sim);
  const trace = started.trace;
  let result = launch(started.result, sim, trace);
  const retitle = { kind: 'modify', target: 'T1', current: '### T1 — Part one', proposed: '### T1 — Part one, faster' };
  result = host(result, { type: 'AMEND', delta: [retitle], notify: [{ task: 'T1', notice: 'T1 retitled.' }], rationale: 'Plan changed mid-run.' } as unknown as Event, sim, trace);
  assert.equal(result.state.tag, 'tasks');
  const effect = trace.effects.findLast((item) => item.kind === 'write-brief');
  assert.ok(effect?.kind === 'write-brief');
  const shared = String(effect.input['sharedContext']);
  assert.match(shared, /## Task Map\n[\s\S]*\| T1 \| Part one, faster — Deliver part one\. \|[^\n]*\n\| T2 \| /);
  assert.doesNotMatch(shared, /## Proposed Changes/);
  const runDir = tempDir();
  const brief = (await createWriteBrief({ skillRoot: SKILL_ROOT })(effect, fakePorts(), { runDir, attempt: 1 }))[0];
  assert.equal(brief?.type, 'BRIEF_READY');
  if (brief?.type !== 'BRIEF_READY') return;
  assert.match(fs.readFileSync(brief.path, 'utf8'), /## Shared plan context\n[\s\S]*## Task Map\n[\s\S]*\| T1 \| Part one, faster — Deliver part one\. \|/);
});
