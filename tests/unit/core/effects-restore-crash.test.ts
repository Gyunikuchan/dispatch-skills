import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './fixtures/restore.ts';
import { restoreRecovery } from '../../../skills/dispatch/scripts/effects/restore.ts';

test('restore completion proof reads matching target bytes without duplicate overwrites and refuses new caller bytes', async () => {
  const f = fixture(); await f.invoke(); f.verify();
  let writes = 0; f.ports.fs.writeBase64Atomic = () => { writes++; };
  const probe = restoreRecovery({ cwd: f.cwd }).probe!;
  assert.equal((await probe(f.effect, f.ports, { runDir: f.runDir, attempt: 1 })).status, 'complete');
  assert.equal(writes, 0);
  fs.writeFileSync(path.join(f.cwd, 'dirty'), 'new caller content');
  assert.equal((await probe(f.effect, f.ports, { runDir: f.runDir, attempt: 1 })).status, 'unresolved');
  assert.equal((await f.invoke())[0]?.type, 'EFFECT_FAILED');
  assert.equal(writes, 0);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'dirty'), 'utf8'), 'new caller content');
});

test('restore retries preserve the original binary patch after publication and mutation crashes', async () => {
  for (const failure of ['patch write', 'after patch before sidecar', 'after sidecar', 'mid-restore'] as const) {
    const f = fixture(), atomic = f.ports.fs.writeAtomic, bytes = f.ports.fs.writeBase64Atomic;
    let fail = true, writes = 0;
    f.ports.fs.writeAtomic = (file, text) => {
      if (fail && (failure === 'patch write' && file.endsWith('.json') || failure === 'after patch before sidecar' && file.endsWith('.sha256'))) { fail = false; throw new Error('crash'); }
      atomic(file, text);
    };
    f.ports.fs.writeBase64Atomic = (file, value) => {
      if (fail && (failure === 'after sidecar' || failure === 'mid-restore' && writes++ === 1)) { fail = false; throw new Error('crash'); }
      bytes(file, value);
    };
    assert.equal((await f.invoke())[0]?.type, 'EFFECT_FAILED');
    if (failure !== 'mid-restore') assert.equal(fs.readFileSync(path.join(f.cwd, 'dirty'), 'utf8'), 'failed attempt');
    const patchPath = path.join(f.runDir, 'implement.restore.1', 'restore.json');
    const original = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : null;
    assert.equal((await f.invoke())[0]?.type, 'RESTORED'); f.verify();
    if (original) assert.equal(fs.readFileSync(patchPath, 'utf8'), original);
  }
});
