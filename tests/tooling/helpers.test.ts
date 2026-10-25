import assert from 'node:assert/strict';
import * as prefixed from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BLOCKED_LAUNCHERS, SPAWN_RULE } from '../helpers/block-spawn.ts';
import { TEMP_ROOT_MARKER } from '../helpers/isolated-temp.ts';
import { fakePorts } from '../helpers/fake-ports.ts';

const require = createRequire(import.meta.url);

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

test('run paths: port atomic, exclusive, and append writes create an absent parent folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-'));
  const ports = fakePorts().fs;
  ports.writeAtomic(path.join(root, 'a', 'input.json'), '{}');
  assert.equal(ports.publishExclusive(path.join(root, 'b', 'launch.json'), '{}'), true);
  ports.writeExclusive(path.join(root, 'c', 'claim.json'), '{}');
  ports.appendDurable(path.join(root, 'd', 'events.jsonl'), 'x\n');
  ports.appendDurable(path.join(root, 'd', 'events.jsonl'), 'y\n');
  for (const [file, contents] of [['a/input.json', '{}'], ['b/launch.json', '{}'], ['c/claim.json', '{}'], ['d/events.jsonl', 'x\ny\n']]) {
    assert.ok(fs.statSync(path.dirname(path.join(root, file!))).isDirectory(), file);
    assert.equal(fs.readFileSync(path.join(root, file!), 'utf8'), contents, file);
  }
  assert.equal(ports.publishExclusive(path.join(root, 'b', 'launch.json'), 'overwrite'), false);
  assert.throws(() => ports.writeExclusive(path.join(root, 'c', 'claim.json'), 'overwrite'), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(path.join(root, 'b', 'launch.json'), 'utf8'), '{}');
  assert.equal(fs.readFileSync(path.join(root, 'c', 'claim.json'), 'utf8'), '{}');
});
