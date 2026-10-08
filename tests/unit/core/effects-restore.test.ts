import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './fixtures/restore.ts';
test('implement-failure-disposition: patch publication and sha256 precede mutation; binary dirty/untracked restored and caller outside edit preserved', async () => {
  const f = fixture(), order: string[] = [], atomic = f.ports.fs.writeAtomic, bytes = f.ports.fs.writeBase64Atomic;
  f.ports.fs.writeAtomic = (file, text) => { order.push(path.extname(file)); atomic(file, text); };
  f.ports.fs.writeBase64Atomic = (file, value) => { order.push('mutation'); bytes(file, value); };
  assert.equal((await f.invoke())[0]?.type, 'RESTORED');
  assert.deepEqual(order.slice(0, 3), ['.json', '.sha256', 'mutation']);
  f.verify();
  const patch = JSON.parse(fs.readFileSync(path.join(f.runDir, 'implement.restore.1', 'restore.json'), 'utf8'));
  assert.equal(Buffer.from(patch.failed.dirty.content, 'base64').toString(), 'failed attempt');
  assert.equal(Buffer.from(patch.failed.untracked.content, 'base64').toString(), 'binary overwritten');
});
test('recovery integrity: corrupt sidecar and mismatched pre-attempt binding refuse all mutation', async () => {
  const f = fixture(); assert.equal((await f.invoke())[0]?.type, 'RESTORED');
  fs.writeFileSync(path.join(f.cwd, 'dirty'), 'new edit');
  fs.writeFileSync(path.join(f.runDir, 'implement.restore.1', 'restore.json.sha256'), 'corrupt');
  assert.equal((await f.invoke())[0]?.type, 'EFFECT_FAILED');
  assert.equal(fs.readFileSync(path.join(f.cwd, 'dirty'), 'utf8'), 'new edit');
});
test('change receipt: restore retry refuses newer destination bytes before changing any other path', async () => {
  const f = fixture(); assert.equal((await f.invoke())[0]?.type, 'RESTORED');
  fs.writeFileSync(path.join(f.cwd, 'dirty'), 'new caller content');
  const result = (await f.invoke())[0]!;
  assert.equal(result.type, 'EFFECT_FAILED');
  if (result.type === 'EFFECT_FAILED') assert.deepEqual(result.conflict?.paths, ['dirty']);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'dirty'), 'utf8'), 'new caller content');
  assert.equal(fs.readFileSync(path.join(f.cwd, 'outside'), 'utf8'), 'caller outside edit');
});
