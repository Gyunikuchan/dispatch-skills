import assert from 'node:assert/strict';
import * as prefixed from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BLOCKED_LAUNCHERS, SPAWN_RULE } from '../../helpers/block-spawn.ts';
import { TEMP_ROOT_MARKER } from '../../helpers/isolated-temp.ts';
import { play, PLAY_RUN } from '../../helpers/play.ts';
import { awaitingMachine, RUN_STARTED } from './fixtures/machines.ts';

const require = createRequire(import.meta.url);

test('node:child_process and child_process resolve to one patched module object', () => {
  assert.equal(require('node:child_process'), require('child_process'));
});

test('every child_process launcher throws a rule-naming error outside tests/e2e/', () => {
  const shared = require('child_process') as Record<string, (...args: unknown[]) => unknown>;
  for (const name of BLOCKED_LAUNCHERS) {
    assert.throws(() => shared[name]?.('node', ['-v']), (error: unknown) => error instanceof Error && error.message.startsWith(SPAWN_RULE));
  }
  assert.throws(() => prefixed.spawnSync('node', ['-v']), /tiers 1-5 spawn no processes/);
});

test('each test process gets its own temp dir inside the run temp root', () => {
  const root = process.env[TEMP_ROOT_MARKER] ?? '';
  assert.notEqual(root, '');
  assert.equal(path.dirname(os.tmpdir()), root);
  assert.match(path.basename(os.tmpdir()), new RegExp(`^worker-${process.pid}-`));
});

test('play returns the projected frame after each event', () => {
  const frames = play(awaitingMachine, [RUN_STARTED, { type: 'SNAPSHOT', effectId: 'fixture.snapshot.1', fingerprint: {}, diff: {} }]);
  assert.deepEqual(frames.map((frame) => [frame.run, frame.at, frame.await]), [
    [PLAY_RUN, 'fixture › snapshotting', 'done'],
    [PLAY_RUN, 'fixture › authoring', 'author'],
  ]);
});
