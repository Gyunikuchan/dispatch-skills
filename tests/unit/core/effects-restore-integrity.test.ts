import { loadRecovery, publishRecovery } from '../../../skills/dispatch/scripts/effects/recovery-manifest.ts';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Effect, RecoveryManifest } from '../../../skills/dispatch/scripts/core/types.ts';
import { nodeFs, nodePorts } from '../../../skills/dispatch/scripts/core/ports.ts';
import { createRestore } from '../../../skills/dispatch/scripts/effects/restore.ts';
import { createSnapshot, lineChanges, verifiedManifests } from '../../../skills/dispatch/scripts/effects/snapshot.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

import { fixture, stored } from './fixtures/restore.ts';

// Split durable restore checks to retain the per-file test budget.
test('mode/type preservation and symlink ancestors never escape repository; case-insensitive .git refused', async () => {
  const f = fixture();
  fs.chmodSync(path.join(f.cwd, 'dirty'), 0o600);
  const result = await f.invoke(); assert.equal(result[0]?.type, 'RESTORED');
  const expected = loadRecovery(f.ports, f.runDir, f.effect.to['recovery']).entries['dirty']!;
  assert.equal(fs.statSync(path.join(f.cwd, 'dirty')).mode & 0o7777, expected.mode);
  const outside = tempDir();
  try { fs.symlinkSync(outside, path.join(f.cwd, 'linked'), 'junction'); } catch (error) { if ((error as { code?: string }).code === 'EPERM') return; throw error; }
  const snapshot = loadRecovery(f.ports, f.runDir, f.effect.to['recovery']);
  const escaped = { ...f.effect, id: 'implement.restore.2', paths: ['linked/victim'], to: { ...f.effect.to, recovery: stored({ ...snapshot, contents: { 'linked/victim': Buffer.from('victim').toString('base64') }, entries: { 'linked/victim': expected } }, f.ports, f.runDir) } };
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
  const git = { toplevel: async () => cwd, indexEntries: async () => '', diffNames: async () => [], fingerprint: async () => ({ head: 'h', index: 'i', worktree: 'w' }), changedSince: async () => [], recoveryFiles: async () => ({ files: ['a'], dirty: [], stash: '', gitDir }) };
  const handler = createSnapshot({ cwd, git }), context = { runDir: cwd, attempt: 1 };
  const first = (await handler({ kind: 'snapshot', id: 'snapshot.1', since: null }, ports, context))[0]!;
  assert.equal(first.type, 'SNAPSHOT'); if (first.type !== 'SNAPSHOT') return;
  fs.writeFileSync(path.join(gitDir, 'hooks', 'custom-hook'), 'hook'); fs.writeFileSync(path.join(gitDir, 'info', 'custom-info'), 'info');
  const second = (await handler({ kind: 'snapshot', id: 'snapshot.2', since: first.fingerprint }, ports, context))[0]!;
  assert.equal(second.type, 'SNAPSHOT'); if (second.type !== 'SNAPSHOT') return;
  assert.notEqual(loadRecovery(ports, cwd, first.fingerprint['recovery']).git.gitDir, loadRecovery(ports, cwd, second.fingerprint['recovery']).git.gitDir);
});
test('restore preserves leaf symlink type and target bytes without touching its target', async (t) => {
  const f = fixture(), target = path.join(f.cwd, 'target'), link = path.join(f.cwd, 'leaf'); fs.writeFileSync(target, 'target bytes');
  try { fs.symlinkSync(target, link, 'file'); } catch (error) { if ((error as { code?: string }).code === 'EPERM') { t.skip('OS lacks file symlink creation permission'); return; } throw error; }
  const info = f.ports.fs.inspectPath(link)!;
  const r = loadRecovery(f.ports, f.runDir, f.effect.to['recovery']);
  const effect = { ...f.effect, id: 'implement.restore.3', paths: ['leaf'], to: { ...f.effect.to, recovery: stored({ ...r, contents: { leaf: null }, entries: { leaf: { kind: 'symlink' as const, mode: info.mode, linkTarget: info.linkTarget } } }, f.ports, f.runDir) } };
  fs.unlinkSync(link); fs.writeFileSync(link, 'writer changed type');
  const restored = await createRestore({ cwd: f.cwd })(effect, f.ports, { runDir: f.runDir, attempt: 1 }); assert.equal(restored[0]?.type, 'RESTORED', JSON.stringify(restored));
  assert.equal(f.ports.fs.inspectPath(link)?.kind, 'symlink'); assert.equal(f.ports.fs.inspectPath(link)?.linkTarget, info.linkTarget); assert.equal(fs.readFileSync(target, 'utf8'), 'target bytes');
});