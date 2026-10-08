import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { nodePorts } from '../../skills/dispatch/scripts/core/ports.ts';
import { createGit } from '../../skills/dispatch/scripts/effects/git.ts';
import { createSnapshot } from '../../skills/dispatch/scripts/effects/snapshot.ts';
import { loadRecovery } from '../../skills/dispatch/scripts/effects/recovery-manifest.ts';
import { createAssessRecovery } from '../../skills/dispatch/scripts/effects/assess-recovery.ts';
import { tempDir } from '../helpers/fake-ports.ts';
import { fixture, CLEAN } from '../helpers/e2e.ts';

test('observation boundary: real Git excludes ignored descendants but tracks forced matches and membership changes', async () => {
  const cwd = tempDir(), runDir = tempDir(), ports = nodePorts();
  const command = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  command('init', '-q'); command('config', 'user.name', 'Fixture'); command('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'node_modules/\n*.bin\n');
  fs.mkdirSync(path.join(cwd, 'node_modules'));
  fs.writeFileSync(path.join(cwd, 'node_modules', 'ignored'), 'ignored');
  fs.writeFileSync(path.join(cwd, 'tracked.bin'), 'tracked'); fs.writeFileSync(path.join(cwd, 'input.txt'), 'observed');
  command('add', '.gitignore', 'input.txt'); command('add', '-f', 'tracked.bin'); command('commit', '-qm', 'fixture');
  const git = createGit(ports.git), hash = ports.fs.hashFile, base64 = ports.fs.readBase64;
  const ignored = (file: string) => file.startsWith(path.join(cwd, 'node_modules') + path.sep);
  ports.fs.hashFile = (file) => { assert.equal(ignored(file), false); return hash(file); };
  ports.fs.readBase64 = (file) => { assert.equal(ignored(file), false); return base64(file); };
  const handler = createSnapshot({ cwd, git }), ctx = { runDir, attempt: 1 };
  const first = (await handler({ kind: 'snapshot', id: 'snapshot.1', since: null }, ports, ctx))[0]!;
  assert.equal(first.type, 'SNAPSHOT'); if (first.type !== 'SNAPSHOT') return;
  assert.ok(loadRecovery(ports, runDir, first.fingerprint['recovery']).contents['tracked.bin']);
  fs.writeFileSync(path.join(cwd, 'node_modules', 'ignored'), 'changed ignored bytes');
  const quiet = (await handler({ kind: 'snapshot', id: 'snapshot.2', since: first.fingerprint }, ports, ctx))[0]!;
  assert.equal(quiet.type, 'SNAPSHOT'); if (quiet.type !== 'SNAPSHOT') return;
  assert.equal(quiet.fingerprint['observation'], first.fingerprint['observation']);
  fs.writeFileSync(path.join(cwd, 'new.txt'), 'new input');
  const observed = (await handler({ kind: 'snapshot', id: 'snapshot.3', since: quiet.fingerprint }, ports, ctx))[0]!;
  assert.equal(observed.type, 'SNAPSHOT'); if (observed.type !== 'SNAPSHOT') return;
  fs.appendFileSync(path.join(cwd, '.gitignore'), 'new.txt\n');
  const omitted = (await handler({ kind: 'snapshot', id: 'snapshot.4', since: observed.fingerprint }, ports, ctx))[0]!;
  assert.equal(omitted.type, 'SNAPSHOT'); if (omitted.type !== 'SNAPSHOT') return;
  const manifest = loadRecovery(ports, runDir, omitted.fingerprint['recovery']);
  assert.deepEqual(manifest.membership, ['new.txt']); assert.equal('new.txt' in manifest.contents, false);
  assert.equal(manifest.changed.some((row) => row.path === 'new.txt' && row.deleted), false);
  assert.notEqual(omitted.fingerprint['observation'], observed.fingerprint['observation']);
  const assessed = (await createAssessRecovery()({ kind: 'assess-recovery', id: 'assess.1', purpose: 'drift', before: observed.fingerprint, after: omitted.fingerprint, phase: 'host', pendingId: 'approval', input: {} }, ports, ctx))[0]!;
  assert.equal(assessed.type, 'RECOVERY_ASSESSED');
  if (assessed.type === 'RECOVERY_ASSESSED') assert.equal(assessed.notice.relevance, 'relevant');
});
test('observation boundary: non-ignored session outputs remain quiet while unrelated scratch edits produce notices', async () => {
  const finding = { severity: 'SHOULD', locus: 'src/a.ts:L1', tag: 'correctness', defect: 'Missing condition', requiredChange: 'Add condition' };
  for (const material of [false, true]) {
    const f = fixture({ responses: [{ status: 'FINDINGS', findings: [finding] }, CLEAN] });
    try {
      fs.writeFileSync(path.join(f.repo, '.gitignore'), '');
      fs.writeFileSync(path.join(f.repo, 'src/a.ts'), 'changed');
      fs.mkdirSync(path.join(f.repo, '.scratch'), { recursive: true });
      const unrelated = path.join(f.repo, '.scratch', 'input.txt'); fs.writeFileSync(unrelated, 'existing input');
      const session = await f.initialize(), frame = await f.begin('review', session, '', ['--kind', 'code']);
      assert.equal(frame.await, 'rule', JSON.stringify(frame));
      if (material) fs.writeFileSync(unrelated, 'second input edit');
      const next = await f.reply(f.absoluteRun(frame.run), { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'reject', reason: 'Intentional condition with existing evidence.' } } });
      assert.equal(next.await, material ? 'decide' : 'done', JSON.stringify(next));
      if (material) assert.equal(next.data['kind'], 'drift');
    } finally { f.cleanup(); }
  }
});
