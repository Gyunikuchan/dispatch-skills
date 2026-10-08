import { loadRecovery, publishRecovery } from '../../../../skills/dispatch/scripts/effects/recovery-manifest.ts';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Effect, RecoveryManifest } from '../../../../skills/dispatch/scripts/core/types.ts';
import { nodeFs, nodePorts } from '../../../../skills/dispatch/scripts/core/ports.ts';
import { createRestore } from '../../../../skills/dispatch/scripts/effects/restore.ts';
import { createSnapshot, lineChanges, verifiedManifests } from '../../../../skills/dispatch/scripts/effects/snapshot.ts';
import { fakePorts, tempDir } from '../../../helpers/fake-ports.ts';

export function stored(snapshot: RecoveryManifest, ports: ReturnType<typeof fakePorts>, runDir: string) {
 const contents = Object.fromEntries(Object.entries(snapshot.contents).map(([file, bytes]) => {
  if (bytes === null) return [file, null];
  const hash = crypto.createHash('sha256').update(Buffer.from(bytes,'base64')).digest('hex');
  ports.fs.mkdir(path.join(runDir,'recovery-contents'), { recursive: true });
  ports.fs.writeBase64Atomic(path.join(runDir,'recovery-contents',hash),bytes); return [file,hash];
 }));
 return publishRecovery(ports,runDir,{ ...snapshot, contentStore: 'recovery-contents', contents });
}
export function fixture() {
  const cwd = tempDir(), runDir = tempDir(), ports = fakePorts();
  const binary = Buffer.from([0, 255, 254, 10, 128]);
  fs.writeFileSync(path.join(cwd, 'dirty'), 'caller dirt');
  fs.writeFileSync(path.join(cwd, 'untracked'), binary);
  const entries = Object.fromEntries(['dirty', 'untracked'].map((f) => [f, { kind: 'file' as const, mode: fs.statSync(path.join(cwd, f)).mode & 0o7777, linkTarget: null }]));
  const recovery: RecoveryManifest = { contentStore: 'recovery-contents', repoRoot: cwd, contents: { dirty: Buffer.from('caller dirt').toString('base64'), untracked: binary.toString('base64'), created: null }, entries: { ...entries, created: null }, taskStartFiles: ['dirty', 'untracked'], callerDirty: ['dirty', 'untracked'], git: { head: 'h', index: 'i', stash: '', gitDir: 'g' }, changed: [], verifiedManifestDirs: [], hashManifestDirs: [] };
  const effect: Extract<Effect, { kind: 'restore' }> = { kind: 'restore', id: 'implement.restore.1', paths: ['dirty', 'untracked', 'created'], to: { head: 'h', index: 'i', worktree: 'w', recovery: stored(recovery, ports, runDir) } };
  fs.writeFileSync(path.join(cwd, 'dirty'), 'failed attempt');
  fs.writeFileSync(path.join(cwd, 'untracked'), 'binary overwritten');
  fs.writeFileSync(path.join(cwd, 'created'), 'new');
  fs.writeFileSync(path.join(cwd, 'outside'), 'caller outside edit');
  const invoke = () => createRestore({ cwd })(effect, ports, { runDir, attempt: 1 });
  const verify = () => { assert.equal(fs.readFileSync(path.join(cwd, 'dirty'), 'utf8'), 'caller dirt'); assert.deepEqual(fs.readFileSync(path.join(cwd, 'untracked')), binary); assert.equal(fs.existsSync(path.join(cwd, 'created')), false); assert.equal(fs.readFileSync(path.join(cwd, 'outside'), 'utf8'), 'caller outside edit'); };
  return { cwd, runDir, ports, effect, invoke, verify };
}
