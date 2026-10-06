import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { isEexist, publishExclusive } from '../../../skills/dispatch/scripts/lib/fs-ext.ts';
import { nodeLinkFs } from '../../../skills/dispatch/scripts/lib/node-fs-ext.ts';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'linkfs-'));

test('real LinkFs: link to an existing name throws EEXIST; publishExclusive leaves no temp', () => {
  const root = dir();
  const final = path.join(root, 'claim.json');
  assert.equal(publishExclusive(nodeLinkFs, final, '{"a":1}'), true);
  assert.equal(publishExclusive(nodeLinkFs, final, '{"a":2}'), false);
  assert.equal(nodeLinkFs.readText(final), '{"a":1}');
  const temp = nodeLinkFs.writeTemp(final, 'x');
  assert.throws(() => nodeLinkFs.link(temp, final), (error: unknown) => isEexist(error));
  nodeLinkFs.remove(temp);
  assert.deepEqual(nodeLinkFs.list(root), ['claim.json']);
});

test('real LinkFs: writeAtomic replaces the target and leaves no partial file', () => {
  const root = dir();
  const file = path.join(root, 'beat.json');
  nodeLinkFs.writeAtomic(file, 'one');
  nodeLinkFs.writeAtomic(file, 'two');
  assert.equal(nodeLinkFs.readText(file), 'two');
  assert.deepEqual(nodeLinkFs.list(root), ['beat.json']);
  assert.equal(nodeLinkFs.readText(path.join(root, 'missing')), null);
  assert.deepEqual(nodeLinkFs.list(path.join(root, 'missing')), []);
});

test('run paths: real LinkFs atomic and exclusive writes create an absent parent folder', () => {
  const root = dir();
  nodeLinkFs.writeAtomic(path.join(root, 'review.wave.1', 'input.json'), '{}');
  assert.equal(publishExclusive(nodeLinkFs, path.join(root, 'review.wave.2', 'launch.json'), '{}'), true);
  assert.equal(fs.readFileSync(path.join(root, 'review.wave.1', 'input.json'), 'utf8'), '{}');
  assert.ok(fs.existsSync(path.join(root, 'review.wave.2', 'launch.json')));
});
