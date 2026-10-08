import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadRecovery, publishRecovery } from '../../../skills/dispatch/scripts/effects/recovery-manifest.ts';
import type { RecoveryManifest } from '../../../skills/dispatch/scripts/core/types.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { createAssessRecovery } from '../../../skills/dispatch/scripts/effects/assess-recovery.ts';

const manifest = (): RecoveryManifest => ({ repoRoot: '/repo', contentStore: 'recovery-contents', contents: {}, entries: {}, taskStartFiles: [], callerDirty: [], git: { head: 'h', index: 'i', stash: '', gitDir: 'g' }, changed: [], verifiedManifestDirs: [], hashManifestDirs: [] });
test('recovery manifest: identical publication reuses immutable metadata and references stay compact', () => {
  const ports = fakePorts(), runDir = tempDir(), snapshot = manifest();
  snapshot.contents = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`src/${i}`, null])); snapshot.entries = Object.fromEntries(Object.keys(snapshot.contents).map((file)=>[file,null]));
  const first = publishRecovery(ports, runDir, snapshot);
  for (let i = 0; i < 20; i++) assert.deepEqual(publishRecovery(ports, runDir, snapshot), first);
  assert.ok(JSON.stringify(first).length < 300);
  assert.equal(fs.readdirSync(path.join(runDir, 'recovery-manifests')).length, 1);
  assert.deepEqual(loadRecovery(ports, runDir, first).contents, snapshot.contents);
});
test('recovery integrity: missing corrupt and escaped manifests fail without a live fallback', () => {
  const ports = fakePorts(), runDir = tempDir(), ref = publishRecovery(ports, runDir, manifest());
  assert.throws(() => loadRecovery(ports, runDir, { ...ref, path: '../outside' }), /reference/);
  assert.throws(() => loadRecovery(ports, runDir, { ...ref, bytes: ref.bytes + 1 }), /manifest/);
  fs.writeFileSync(path.join(runDir, ref.path), 'x'.repeat(ref.bytes));
  assert.throws(() => loadRecovery(ports, runDir, ref), /Corrupt/);
  assert.throws(() => publishRecovery(ports, runDir, manifest()), /mismatch/);
  fs.unlinkSync(path.join(runDir, ref.path));
  assert.throws(() => loadRecovery(ports, runDir, ref), /Missing/);
});
test('recovery integrity: publish interruption retries the same immutable artifact and cannot return a dangling blob', () => {
  const ports = fakePorts(), runDir = tempDir(), original = ports.fs.publishExclusive;
  let interrupted = false;
  ports.fs.publishExclusive = (file, text) => { const result = original(file, text); if (!interrupted) { interrupted = true; throw new Error('crash after publish'); } return result; };
  assert.throws(() => publishRecovery(ports, runDir, manifest()), /crash/);
  const resumed = publishRecovery(ports, runDir, manifest());
  assert.deepEqual(loadRecovery(ports, runDir, resumed).contents, {});
  assert.equal(fs.readdirSync(path.join(runDir, 'recovery-manifests')).length, 1);
  assert.throws(() => publishRecovery(ports, runDir, { ...manifest(), contents: { a: 'a'.repeat(64) }, entries: { a: { kind: 'file', mode: 0o644, linkTarget: null } } }), /blob/);
});
test('recovery assessment: immutable refs produce compact receipts without live checkout access', async () => {
  const ports = fakePorts(), runDir = tempDir();
  const before = { head: 'h', index: 'i', worktree: 'w', recovery: publishRecovery(ports, runDir, manifest()) };
  const after = { ...before, worktree: 'new', recovery: publishRecovery(ports, runDir, { ...manifest(), ignoreRules: 'changed' }) };
  const read = ports.fs.readText;
  ports.fs.readText = (file) => { assert.ok(file.startsWith(runDir)); return read(file); };
  const result = (await createAssessRecovery()({ kind: 'assess-recovery', id: 'assess.1', purpose: 'drift', before, after, phase: 'final', pendingId: 'verify', input: { evidenceIds: ['SC1'] } }, ports, { runDir, attempt: 1 }))[0]!;
  assert.equal(result.type, 'RECOVERY_ASSESSED');
  if (result.type === 'RECOVERY_ASSESSED') {
    assert.equal(result.notice.relevance, 'relevant'); assert.deepEqual(result.notice.affectedEvidence, ['SC1']);
    assert.ok(JSON.stringify(result).length < 1500);
    assert.equal('contents' in result, false);
  }
});
