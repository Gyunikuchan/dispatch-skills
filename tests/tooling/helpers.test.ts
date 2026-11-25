import assert from 'node:assert/strict';
import * as prefixed from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BLOCKED_LAUNCHERS, SPAWN_RULE } from '../helpers/block-spawn.ts';
import { TEMP_ROOT_MARKER } from '../helpers/isolated-temp.ts';

const require = createRequire(import.meta.url);

test('every child_process launcher throws a rule-naming error outside tests/e2e/', () => {
  const shared = require('child_process') as Record<string, (...args: unknown[]) => unknown>;
  for (const name of BLOCKED_LAUNCHERS) {
    assert.throws(
      () => shared[name]?.('node', ['-v']),
      (error: unknown) => error instanceof Error && error.message.startsWith(SPAWN_RULE),
    );
  }
  assert.throws(() => prefixed.spawnSync('node', ['-v']), /tiers 1-5 spawn no processes/);
});

test('each test process gets its own temp dir inside the run temp root', () => {
  const root = process.env[TEMP_ROOT_MARKER] ?? '';
  assert.notEqual(root, '');
  const own = os.tmpdir();
  assert.equal(fs.statSync(own).isDirectory(), true);
  assert.notEqual(path.resolve(own), path.resolve(root));
  const inward = path.relative(root, own);
  assert.ok(inward !== '' && !inward.startsWith('..') && !path.isAbsolute(inward));
});
