import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Effect, RecoverySnapshot } from '../../../skills/dispatch/scripts/core/types.ts';
import { nodeFs, nodePorts } from '../../../skills/dispatch/scripts/core/ports.ts';
import { createRestore } from '../../../skills/dispatch/scripts/effects/restore.ts';
import { createSnapshot, lineChanges, verifiedManifests } from '../../../skills/dispatch/scripts/effects/snapshot.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

function fixture() {
  const cwd = tempDir(), runDir = tempDir(), ports = fakePorts();
  const binary = Buffer.from([0, 255, 254, 10, 128]);
  fs.writeFileSync(path.join(cwd, 'dirty'), 'caller dirt');
  fs.writeFileSync(path.join(cwd, 'untracked'), binary);
  const entries = Object.fromEntries(['dirty', 'untracked'].map((f) => [f, { kind: 'file' as const, mode: fs.statSync(path.join(cwd, f)).mode & 0o7777, linkTarget: null }]));
  const recovery: RecoverySnapshot = { repoRoot: cwd, contents: { dirty: Buffer.from('caller dirt').toString('base64'), untracked: binary.toString('base64'), created: null }, entries: { ...entries, created: null }, taskStartFiles: ['dirty', 'untracked'], callerDirty: ['dirty', 'untracked'], ignored: [], git: { head: 'h', index: 'i', stash: '', gitDir: 'g' }, changed: [], verifiedManifestDirs: [], hashManifestDirs: [] };
  const effect: Extract<Effect, { kind: 'restore' }> = { kind: 'restore', id: 'implement.restore.1', paths: ['dirty', 'untracked', 'created'], to: { head: 'h', index: 'i', worktree: 'w', recovery } };
  fs.writeFileSync(path.join(cwd, 'dirty'), 'failed attempt');
  fs.writeFileSync(path.join(cwd, 'untracked'), 'binary overwritten');
  fs.writeFileSync(path.join(cwd, 'created'), 'new');
  fs.writeFileSync(path.join(cwd, 'outside'), 'caller outside edit');
  const invoke = () => createRestore({ cwd })(effect, ports, { runDir, attempt: 1 });
  const verify = () => { assert.equal(fs.readFileSync(path.join(cwd, 'dirty'), 'utf8'), 'caller dirt'); assert.deepEqual(fs.readFileSync(path.join(cwd, 'untracked')), binary); assert.equal(fs.existsSync(path.join(cwd, 'created')), false); assert.equal(fs.readFileSync(path.join(cwd, 'outside'), 'utf8'), 'caller outside edit'); };
  return { cwd, runDir, ports, effect, invoke, verify };
}
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
for (const failure of ['patch write', 'after patch before sidecar', 'after sidecar', 'mid-restore'] as const) test(`restore ${failure} crash preserves/reuses original binary patch`, async () => {
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
});
test('corrupt sidecar and mismatched pre-attempt binding refuse all mutation', async () => {
  const f = fixture(); assert.equal((await f.invoke())[0]?.type, 'RESTORED');
  fs.writeFileSync(path.join(f.cwd, 'dirty'), 'new edit');
  fs.writeFileSync(path.join(f.runDir, 'implement.restore.1', 'restore.json.sha256'), 'corrupt');
  assert.equal((await f.invoke())[0]?.type, 'EFFECT_FAILED');
  assert.equal(fs.readFileSync(path.join(f.cwd, 'dirty'), 'utf8'), 'new edit');
});
test('mode/type preservation and symlink ancestors never escape repository; case-insensitive .git refused', async () => {
  const f = fixture();
  fs.chmodSync(path.join(f.cwd, 'dirty'), 0o600);
  const result = await f.invoke(); assert.equal(result[0]?.type, 'RESTORED');
  const expected = (f.effect.to['recovery'] as RecoverySnapshot).entries['dirty']!;
  assert.equal(fs.statSync(path.join(f.cwd, 'dirty')).mode & 0o7777, expected.mode);
  const outside = tempDir();
  try { fs.symlinkSync(outside, path.join(f.cwd, 'linked'), 'junction'); } catch (error) { if ((error as { code?: string }).code === 'EPERM') return; throw error; }
  const snapshot = f.effect.to['recovery'] as RecoverySnapshot;
  const escaped = { ...f.effect, id: 'implement.restore.2', paths: ['linked/victim'], to: { ...f.effect.to, recovery: { ...snapshot, contents: { 'linked/victim': Buffer.from('victim').toString('base64') }, entries: { 'linked/victim': expected } } } };
  assert.equal((await createRestore({ cwd: f.cwd })(escaped, f.ports, { runDir: f.runDir, attempt: 1 }))[0]?.type, 'EFFECT_FAILED');
  assert.equal(fs.existsSync(path.join(outside, 'victim')), false);
  assert.equal((await createRestore({ cwd: f.cwd })({ ...escaped, paths: ['.GIT/config'] }, f.ports, { runDir: f.runDir, attempt: 1 }))[0]?.type, 'EFFECT_FAILED');
});
test('snapshot uses actual one-line edit counts and verified exact governed manifests', () => {
  const before = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n');
  assert.deepEqual(lineChanges(Buffer.from(before).toString('base64'), Buffer.from(before.replace('line 130', 'changed')).toString('base64')), { added: 1, removed: 1 });
  const cwd = tempDir(), ports = fakePorts(); fs.mkdirSync(path.join(cwd, 'skill')); fs.writeFileSync(path.join(cwd, 'skill', 'SKILL.md'), 'skill');
  const manifest = { 'SKILL.md': crypto.createHash('sha256').update('skill').digest('hex') };
  const filename = path.join(cwd, 'skill', 'skill-hashes.json'); fs.writeFileSync(filename, JSON.stringify(manifest));
  const files = ['skill/SKILL.md', 'skill/skill-hashes.json'];
  assert.deepEqual(verifiedManifests(cwd, files, ports), ['skill']);
  fs.writeFileSync(filename, JSON.stringify({ ...manifest, 'C:/escape': 'a'.repeat(64) }));
  assert.deepEqual(verifiedManifests(cwd, files, ports), []);
  fs.writeFileSync(filename, JSON.stringify({ ...manifest, 'extra.txt': manifest['SKILL.md'] })); fs.writeFileSync(path.join(cwd, 'skill', 'extra.txt'), 'skill');
  assert.deepEqual(verifiedManifests(cwd, [...files, 'skill/extra.txt'], ports), []);
});
test('custom hooks/info changes are fingerprinted without following symlink targets', async () => {
  const cwd = tempDir(), ports = fakePorts(), gitDir = path.join(cwd, '.git');
  fs.mkdirSync(path.join(gitDir, 'hooks'), { recursive: true }); fs.mkdirSync(path.join(gitDir, 'info'));
  fs.writeFileSync(path.join(cwd, 'a'), 'a');
  const git = { toplevel: async () => cwd, indexEntries: async () => '', diffNames: async () => [], fingerprint: async () => ({ head: 'h', index: 'i', worktree: 'w' }), changedSince: async () => [], recoveryFiles: async () => ({ files: ['a'], dirty: [], ignored: [], stash: '', gitDir }) };
  const handler = createSnapshot({ cwd, git }), context = { runDir: cwd, attempt: 1 };
  const first = (await handler({ kind: 'snapshot', id: 'snapshot.1', since: null }, ports, context))[0]!;
  assert.equal(first.type, 'SNAPSHOT'); if (first.type !== 'SNAPSHOT') return;
  fs.writeFileSync(path.join(gitDir, 'hooks', 'custom-hook'), 'hook'); fs.writeFileSync(path.join(gitDir, 'info', 'custom-info'), 'info');
  const second = (await handler({ kind: 'snapshot', id: 'snapshot.2', since: first.fingerprint }, ports, context))[0]!;
  assert.equal(second.type, 'SNAPSHOT'); if (second.type !== 'SNAPSHOT') return;
  assert.notEqual((first.fingerprint['recovery'] as RecoverySnapshot).git.gitDir, (second.fingerprint['recovery'] as RecoverySnapshot).git.gitDir);
});
test('restore preserves leaf symlink type and target bytes without touching its target', async (t) => {
  const f = fixture(), target = path.join(f.cwd, 'target'), link = path.join(f.cwd, 'leaf'); fs.writeFileSync(target, 'target bytes');
  try { fs.symlinkSync(target, link, 'file'); } catch (error) { if ((error as { code?: string }).code === 'EPERM') { t.skip('OS lacks file symlink creation permission'); return; } throw error; }
  const info = f.ports.fs.inspectPath(link)!;
  const r = f.effect.to['recovery'] as RecoverySnapshot;
  const effect = { ...f.effect, id: 'implement.restore.3', paths: ['leaf'], to: { ...f.effect.to, recovery: { ...r, contents: { leaf: null }, entries: { leaf: { kind: 'symlink' as const, mode: info.mode, linkTarget: info.linkTarget } } } } };
  fs.unlinkSync(link); fs.writeFileSync(link, 'writer changed type');
  assert.equal((await createRestore({ cwd: f.cwd })(effect, f.ports, { runDir: f.runDir, attempt: 1 }))[0]?.type, 'RESTORED');
  assert.equal(f.ports.fs.inspectPath(link)?.kind, 'symlink'); assert.equal(f.ports.fs.inspectPath(link)?.linkTarget, info.linkTarget); assert.equal(fs.readFileSync(target, 'utf8'), 'target bytes');
});
