import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { EFFECT_ID_PATTERN, nextEffectId } from '../../../skills/dispatch/scripts/core/effect-id.ts';
import { send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { readJournal } from '../../../skills/dispatch/scripts/core/journal.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { fakeHandlers, nestedMachine, RUN_STARTED } from './fixtures/machines.ts';

test('ids are dot-joined lowercase segments with a per-path-and-kind ordinal', () => {
  const first = nextEffectId({}, 'implement.code-review', 'wave');
  const second = nextEffectId(first.counters, 'implement.code-review', 'wave');
  assert.deepEqual([first.id, second.id], ['implement.code-review.wave.1', 'implement.code-review.wave.2']);
  assert.equal(nextEffectId(second.counters, 'implement', 'verify').id, 'implement.verify.1');
  assert.throws(() => nextEffectId({}, 'Bad:Path', 'wave'), /does not match/);
  assert.equal(EFFECT_ID_PATTERN.test('a:b'), false);
});

test('ids stay unique across a replayed journal when a sub-machine is re-entered', async () => {
  const ports = fakePorts();
  const runDir = path.join(tempDir(), 'run');
  await start({ runDir, machine: nestedMachine, handlers: fakeHandlers, ports, runStarted: RUN_STARTED });
  const result = await send({ runDir, machine: nestedMachine, handlers: fakeHandlers, ports, rawEvent: { type: 'AUTHORED', path: 'p.md' } });
  assert.equal(result.frame?.await, 'done');
  const ids = readJournal(ports, runDir).lines.filter((line) => line.type === 'EFFECT_STARTED').map((line) => String(line.data['effectId']));
  assert.deepEqual(ids, ['root.child.snapshot.1', 'root.child.snapshot.2']);
  for (const id of ids) assert.match(id, EFFECT_ID_PATTERN);
});
