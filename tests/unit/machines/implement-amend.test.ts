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

// SECTION: AMEND then brief — writers receive the authored Task Map from the amended plan text.

test('amend-brief-task-map: a brief regenerated after AMEND carries the authored Task Map', async () => {
  const sim: Sim = { plan: AMEND_PLAN };
  const started = start(3, sim);
  const trace = started.trace;
  let result = launch(started.result, sim, trace);
  const retitle = [
    { kind: 'modify', target: 'T1', current: '| T1 | Part one | Deliver part one. | none | SC1 |', proposed: '| T1 | Part one, faster | Deliver part one. | none | SC1 |' },
    { kind: 'modify', target: 'T1', current: '### T1 — Part one', proposed: '### T1 — Part one, faster' },
  ];
  result = host(result, { type: 'AMEND', delta: retitle, notify: [{ task: 'T1', notice: 'T1 retitled.' }], rationale: 'Plan changed mid-run.' } as unknown as Event, sim, trace);
  assert.equal(result.state.tag, 'tasks');
  const effect = trace.effects.findLast((item) => item.kind === 'write-brief');
  assert.ok(effect?.kind === 'write-brief');
  const shared = String(effect.input['sharedContext']);
  assert.match(shared, /## Task Map\n\| ID \| Title \| Outcome \| Prerequisites \| Criteria \|\n\| --- \| --- \| --- \| --- \| --- \|\n\| T1 \| Part one, faster \| Deliver part one\. \| none \| SC1 \|\n\| T2 \|/);
  assert.doesNotMatch(shared, /## Proposed Changes/);
  const runDir = tempDir();
  const brief = (await createWriteBrief({ skillRoot: SKILL_ROOT })(effect, fakePorts(), { runDir, attempt: 1 }))[0];
  assert.equal(brief?.type, 'BRIEF_READY');
  if (brief?.type !== 'BRIEF_READY') return;
  assert.match(fs.readFileSync(brief.path, 'utf8'), /## Shared plan context\n[\s\S]*\| T1 \| Part one, faster \| Deliver part one\. \| none \| SC1 \|/);
});

// SECTION: AMEND downgrade — an approved revision that installs a red criterion without RED records one concern.

test('amend-red-downgrade: an AMEND that installs a red criterion without RED records one downgrade concern', () => {
  const sim: Sim = { plan: AMEND_PLAN };
  const started = start(3, sim);
  const trace = started.trace;
  let result = launch(started.result, sim, trace);
  const toRed = [{
    kind: 'modify', target: 'SC1',
    current: '  - Changes: src/a.ts, tests/part-1.test.ts\n  - Verify: `node --test tests/part-1.test.ts`\n  - Evidence: verify',
    proposed: '  - Changes: src/a.ts, tests/part-1.test.ts\n  - Tests: tests/part-1.test.ts\n  - Verify: `node --test tests/part-1.test.ts`\n  - Evidence: red',
  }];
  result = host(result, { type: 'AMEND', delta: toRed, notify: [{ task: 'T1', notice: 'SC1 is now red.' }], rationale: 'SC1 needs a failing test first.' } as unknown as Event, sim, trace);
  assert.equal(result.state.tag, 'tasks');
  const concern = 'SC1 RED evidence downgraded to verify: no RED command declared';
  const concerns = () => ('c' in result.state && result.state.c ? result.state.c.concerns : []);
  assert.deepEqual(concerns().filter((row) => row === concern), [concern]);
  const retitle = [
    { kind: 'modify', target: 'T2', current: '| T2 | Part two | Deliver part two. | none | SC2 |', proposed: '| T2 | Part two, faster | Deliver part two. | none | SC2 |' },
    { kind: 'modify', target: 'T2', current: '### T2 — Part two', proposed: '### T2 — Part two, faster' },
  ];
  result = host(result, { type: 'AMEND', delta: retitle, notify: [], rationale: 'Retitle T2.' } as unknown as Event, sim, trace);
  assert.deepEqual(concerns().filter((row) => row === concern), [concern]);
});
