import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Effect, RecoveryManifest } from '../../../skills/dispatch/scripts/core/types.ts';
import { nodeFs, nodePorts } from '../../../skills/dispatch/scripts/core/ports.ts';
import { loadRecovery } from '../../../skills/dispatch/scripts/effects/recovery-manifest.ts';
import { createRestore } from '../../../skills/dispatch/scripts/effects/restore.ts';
import { createSnapshot, lineChanges, verifiedManifests } from '../../../skills/dispatch/scripts/effects/snapshot.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

for (const removed of [false, true]) test(`observation boundary: newly ignored ${removed ? 'deleted bytes stay a deletion' : 'existing bytes leave as membership'}`, async () => {
  const cwd = tempDir(), runDir = tempDir(), gitDir = path.join(cwd, '.git'); fs.mkdirSync(gitDir); fs.writeFileSync(path.join(cwd, 'a'), 'before');
  let files = ['a'];
  const git = { toplevel: async () => cwd, indexEntries: async () => '', diffNames: async () => [], fingerprint: async () => ({ head: 'h', index: 'i', worktree: 'w' }), changedSince: async () => [], isIgnored: async () => true, recoveryFiles: async () => ({ files, dirty: [], tracked: [], stash: '', gitDir, ignoreRules: '' }) };
  const ports = fakePorts(), handler = createSnapshot({ cwd, git });
  const first = (await handler({ kind: 'snapshot', id: 'first', since: null }, ports, { runDir, attempt: 1 }))[0]!; assert.equal(first.type, 'SNAPSHOT'); if (first.type !== 'SNAPSHOT') return;
  files = []; if (removed) fs.unlinkSync(path.join(cwd, 'a'));
  const second = (await handler({ kind: 'snapshot', id: 'second', since: first.fingerprint }, ports, { runDir, attempt: 1 }))[0]!; assert.equal(second.type, 'SNAPSHOT'); if (second.type !== 'SNAPSHOT') return;
  const recovery = loadRecovery(ports, runDir, second.fingerprint['recovery']);
  assert.deepEqual(recovery.membership, removed ? [] : ['a']);
  assert.equal(recovery.changed.some((row) => row.path === 'a' && row.deleted), removed);
});

// Split from effects-restore.test.ts to stay under the 1 s per-file budget: snapshot, fingerprint and fs-port cases.

test('untracked fingerprint streams bytes into a bounded digest and detects same-size binary edits', () => {
  const cwd = tempDir(), file = path.join(cwd, 'large.bin');
  fs.writeFileSync(file, Buffer.alloc(128 * 1024, 255));
  const content = nodePorts().git.fileContent!;
  const first = content('large.bin', cwd);
  assert.match(first, /^[a-f0-9]{64}$/);
  const fd = fs.openSync(file, 'r+');
  try { fs.writeSync(fd, Buffer.from([128]), 0, 1, 64 * 1024); } finally { fs.closeSync(fd); }
  assert.notEqual(content('large.bin', cwd), first);
  assert.equal(content('large.bin', cwd), content('large.bin', cwd));
});

for (const encoding of ['text', 'binary'] as const) test(`atomic ${encoding} publication cleans temporary files when rename fails`, () => {
  const cwd = tempDir(), target = path.join(cwd, 'directory'); fs.mkdirSync(target);
  assert.throws(() => encoding === 'text' ? nodeFs.writeAtomic(target, 'patch') : nodeFs.writeBase64Atomic(target, Buffer.from([0, 255]).toString('base64')));
  assert.deepEqual(fs.readdirSync(cwd), ['directory']);
  const file = path.join(cwd, 'published');
  if (encoding === 'text') { nodeFs.writeAtomic(file, 'patch'); assert.equal(fs.readFileSync(file, 'utf8'), 'patch'); }
  else { nodeFs.writeBase64Atomic(file, Buffer.from([0, 255]).toString('base64')); assert.deepEqual(fs.readFileSync(file), Buffer.from([0, 255])); }
  assert.deepEqual(fs.readdirSync(cwd).sort(), ['directory', 'published']);
});

test('unsupported directory fsync is tolerated while genuine I/O errors propagate', (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!, original = fs.fsyncSync;
  let code = 'ENOTSUP';
  const mock = t.mock.method(fs, 'fsyncSync', (fd: number) => {
    if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error(code), { code });
    original(fd);
  });
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' });
    // Directory handles cannot be opened on Windows, so inject the unsupported open outcome there.
    const open = fs.openSync;
    if (descriptor.value === 'win32') t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
      if (fs.existsSync(args[0]) && fs.statSync(args[0]).isDirectory()) throw Object.assign(new Error(code), { code });
      return open(...args);
    });
    const cwd = tempDir(), file = path.join(cwd, 'published');
    nodeFs.writeAtomic(file, 'durable data'); assert.equal(fs.readFileSync(file, 'utf8'), 'durable data');
    code = 'EIO'; assert.throws(() => nodeFs.writeAtomic(file, 'next'), /EIO/);
    assert.deepEqual(fs.readdirSync(cwd), ['published']);
  } finally { Object.defineProperty(process, 'platform', descriptor); mock.mock.restore(); }
});

test('link publication does not collide with or unlink a stale PID temporary link', (t) => {
  const cwd = tempDir(), target = path.join(cwd, 'target'), leaf = path.join(cwd, 'leaf'); fs.writeFileSync(target, 'target');
  const stale = path.join(cwd, `.leaf.${process.pid}.link.tmp`);
  try { fs.symlinkSync(target, stale, 'file'); } catch (error) { if ((error as { code?: string }).code === 'EPERM') { t.skip('OS lacks symlink permission'); return; } throw error; }
  nodeFs.writeLinkAtomic(leaf, Buffer.from(target).toString('base64'));
  assert.equal(fs.lstatSync(leaf).isSymbolicLink(), true); assert.equal(fs.lstatSync(stale).isSymbolicLink(), true);
});

test('recovery manifest: snapshot journals digest references, deduplicates immutable bytes, excludes ignored files and restores verified bytes', async () => {
  const cwd = tempDir(), runDir = tempDir(), ports = fakePorts(), file = path.join(cwd, 'a.bin');
  const original = Buffer.alloc(128 * 1024, 0); fs.writeFileSync(file, original);
  fs.writeFileSync(path.join(cwd, 'ignored.bin'), Buffer.alloc(128 * 1024, 255));
  const gitDir = path.join(cwd, '.git'); fs.mkdirSync(gitDir);
  const git = { toplevel: async () => cwd, indexEntries: async () => '', diffNames: async () => [], fingerprint: async () => ({ head: 'h', index: 'i', worktree: 'w' }), changedSince: async () => ['a.bin'], recoveryFiles: async () => ({ files: ['a.bin'], dirty: [], ignored: ['ignored.bin'], stash: '', gitDir }) };
  const bytes = ports.fs.readBase64;
  ports.fs.readBase64 = (name) => { assert.ok(name.startsWith(path.join(runDir, 'recovery-contents')), 'whole workspace bytes must not be read into snapshots'); return bytes(name); };
  const handler = createSnapshot({ cwd, git }), ctx = { runDir, attempt: 1 };
  const first = (await handler({ kind: 'snapshot', id: 'snapshot.1', since: null }, ports, ctx))[0]!;
  assert.equal(first.type, 'SNAPSHOT'); if (first.type !== 'SNAPSHOT') return;
  const recovery = loadRecovery(ports, runDir, first.fingerprint['recovery']);
  assert.equal(recovery.contentStore, 'recovery-contents'); assert.match(recovery.contents['a.bin']!, /^[a-f0-9]{64}$/);
  assert.ok(JSON.stringify(first).length < 4096); assert.equal('ignored' in recovery, false);
  assert.equal((await handler({ kind: 'snapshot', id: 'snapshot.2', since: first.fingerprint }, ports, ctx))[0]?.type, 'SNAPSHOT');
  assert.equal(fs.readdirSync(path.join(runDir, 'recovery-contents')).length, 1);
  fs.writeFileSync(file, Buffer.from([0, 128]));
  const changed = (await handler({ kind: 'snapshot', id: 'snapshot.3', since: first.fingerprint }, ports, ctx))[0]!;
  assert.equal(changed.type, 'SNAPSHOT'); if (changed.type !== 'SNAPSHOT') return;
  assert.deepEqual(loadRecovery(ports, runDir, changed.fingerprint['recovery']).changed.map((row) => [row.path, row.added, row.removed]), [['a.bin', 1, 1]]);
  ports.fs.readBase64 = bytes;
  const effect = { kind: 'restore' as const, id: 'restore.store.1', paths: ['a.bin'], to: first.fingerprint };
  assert.equal((await createRestore({ cwd })(effect, ports, ctx))[0]?.type, 'RESTORED'); assert.deepEqual(fs.readFileSync(file), original);
  fs.writeFileSync(file, 'caller edit');
  fs.writeFileSync(path.join(runDir, 'recovery-contents', recovery.contents['a.bin']!), 'corrupt');
  assert.equal((await createRestore({ cwd })({ ...effect, id: 'restore.store.2' }, ports, ctx))[0]?.type, 'EFFECT_FAILED');
  assert.equal(fs.readFileSync(file, 'utf8'), 'caller edit');
});

test('observation boundary: ignored files are never hashed', async () => {
  const cwd = tempDir(), runDir = tempDir(), gitDir = path.join(cwd, '.git'); fs.mkdirSync(gitDir);
  fs.writeFileSync(path.join(cwd, 'kept.bin'), 'kept');
  const git = { toplevel: async () => cwd, indexEntries: async () => '', diffNames: async () => [], fingerprint: async () => ({ head: 'h', index: 'i', worktree: 'w' }), changedSince: async () => [], recoveryFiles: async () => ({ files: [], dirty: [], ignored: ['gone.lock', 'kept.bin'], stash: '', gitDir }) };
  const ports = fakePorts(); ports.fs.hashFile = () => { throw new Error('ignored bytes read'); };
  const result = (await createSnapshot({ cwd, git })({ kind: 'snapshot', id: 'snapshot.1', since: null }, ports, { runDir, attempt: 1 }))[0]!;
  assert.equal(result.type, 'SNAPSHOT'); if (result.type !== 'SNAPSHOT') return;
  assert.equal('ignored' in loadRecovery(ports, runDir, result.fingerprint['recovery']), false);
});

test('observation boundary: linked ignored directories are never traversed', async (t) => {
  const cwd = tempDir(), runDir = tempDir(), outside = tempDir(), gitDir = path.join(cwd, '.git'); fs.mkdirSync(gitDir);
  fs.mkdirSync(path.join(outside, '.bin')); fs.writeFileSync(path.join(outside, '.bin', 'tool'), 'x');
  try { fs.symlinkSync(outside, path.join(cwd, 'node_modules'), 'junction'); } catch { t.skip('directory links unavailable'); return; }
  const git = { toplevel: async () => cwd, indexEntries: async () => '', diffNames: async () => [], fingerprint: async () => ({ head: 'h', index: 'i', worktree: 'w' }), changedSince: async () => [], recoveryFiles: async () => ({ files: [], dirty: [], ignored: ['node_modules/.bin/tool', 'node_modules/other'], stash: '', gitDir }) };
  const ports = fakePorts();
  const result = (await createSnapshot({ cwd, git })({ kind: 'snapshot', id: 'snapshot.1', since: null }, ports, { runDir, attempt: 1 }))[0]!;
  assert.equal(result.type, 'SNAPSHOT'); if (result.type !== 'SNAPSHOT') return;
  assert.equal('ignored' in loadRecovery(ports, runDir, result.fingerprint['recovery']), false);
});

test('binary deletion and creation report only their respective removed and added budget', () => {
  const binary = Buffer.from([0, 255]).toString('base64');
  assert.deepEqual(lineChanges(binary, null), { added: 0, removed: 1 });
  assert.deepEqual(lineChanges(null, binary), { added: 1, removed: 0 });
});

test('immutable copies flush read-only sources and atomic publication replaces read-only files', () => {
  const cwd = tempDir(), source = path.join(cwd, 'source'), copy = path.join(cwd, 'copy');
  fs.writeFileSync(source, Buffer.from([0, 255])); fs.chmodSync(source, 0o444);
  try {
    nodeFs.copyFileAtomic(source, copy); assert.deepEqual(fs.readFileSync(copy), Buffer.from([0, 255]));
    assert.equal(fs.statSync(source).mode & 0o200, 0);
    fs.chmodSync(copy, 0o444); nodeFs.writeAtomic(copy, 'replacement'); assert.equal(fs.readFileSync(copy, 'utf8'), 'replacement');
    fs.chmodSync(copy, 0o444); nodeFs.writeBase64Atomic(copy, Buffer.from([128]).toString('base64')); assert.deepEqual(fs.readFileSync(copy), Buffer.from([128]));
    assert.equal(nodeFs.inspectPath(path.join(source, 'child')), null);
  } finally { fs.chmodSync(source, 0o600); if (fs.existsSync(copy)) fs.chmodSync(copy, 0o600); }
});

test('failed Windows read-only replacement retains the original mode and bytes', (t) => {
  if (process.platform !== 'win32') { t.skip('Windows-specific rename retry'); return; }
  const cwd = tempDir(), file = path.join(cwd, 'readonly'); fs.writeFileSync(file, 'original'); fs.chmodSync(file, 0o444);
  const mode = fs.statSync(file).mode;
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); });
  try {
    assert.throws(() => nodeFs.writeAtomic(file, 'replacement'), /locked/);
    assert.equal(fs.statSync(file).mode, mode); assert.equal(fs.readFileSync(file, 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(cwd), ['readonly']);
  } finally { fs.chmodSync(file, 0o600); }
});
