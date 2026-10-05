import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { assessImplementation, deliverTasks, phaseFixture } from './fixtures/diagnostics.ts';
let completedTranscript: Promise<ReturnType<typeof phaseFixture>> | undefined;
function implementationTranscript() {
  return completedTranscript ??= (async () => {
  const f = phaseFixture('implement');
  let result = await start({ ...f.options, runStarted: f.runStarted });
  assert.equal(result.frame?.await, 'author');
  fs.writeFileSync(String(result.frame?.data['path']), '# Fixture');
  result = await send({ ...f.options, rawEvent: { type: 'AUTHORED', path: result.frame?.data['path'] } });
  assert.equal(result.frame?.data['kind'], 'approval', JSON.stringify(result.frame));
  for (let n = 0; n < 2; n++) {
    result = await send({ ...f.options, rawEvent: { type: 'REVISE', artifact: 'plan', reason: 'repair instructions', evidence: 'dispatch fixture' } });
    assert.equal(result.frame?.await, 'author', JSON.stringify(result.frame));
    result = await send({ ...f.options, rawEvent: { type: 'AUTHORED', path: result.frame?.data['path'] } });
    assert.equal(result.frame?.data['kind'], 'approval', JSON.stringify(result.frame));
  }
  result = await send({ ...f.options, rawEvent: { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed' } } });
  result = await assessImplementation(f.options, result);
  assert.equal(result.frame?.await, 'write', JSON.stringify(result.frame));
  result = await deliverTasks(f.options, result);
  assert.equal(result.frame?.await, 'done', JSON.stringify(result.frame));
  return f;
  })();
}

test('SC2: embedded plan and code reviews retain inclusive implementation timing', async () => {
  const f = await implementationTranscript();
  const phases = f.capture().phases;
  for (const name of ['plan', 'plan review', 'implementation', 'code review']) assert.ok(phases.some((p) => p.name === name), name);
  const outer = phases.find((p) => p.name === 'implementation')!;
  assert.equal(phases.filter((p) => p.name === 'implementation').length, 1);
  for (const child of phases.filter((p) => p.name !== 'implementation')) { assert.ok(child.start >= outer.start); assert.ok(child.end <= outer.end); }
  assert.match(fs.readFileSync(path.join(f.session, 'diagnostics.md'), 'utf8'), /Inclusive elapsed ms.*Exclusive elapsed ms/);
});

test('SC2: repeated plan revisions publish separate instances and embedded reviews', async () => {
  const f = await implementationTranscript();
  const ids = f.capture().phases.map((p) => p.id);
  assert.ok(ids.some((id) => id.includes('/revision-1')));
  assert.ok(ids.some((id) => id.includes('/revision-2')));
  assert.equal(new Set(ids).size, ids.length);
  const phases = f.capture().phases, outer = phases.find((p) => p.name === 'implementation')!;
  assert.equal(phases.filter((p) => p.name === 'implementation').length, 1);
  for (const child of phases.filter((p) => p.id.includes('/revision-'))) assert.ok(child.start >= outer.start && child.end <= (outer.end ?? f.options.ports.clock.now()));
});
