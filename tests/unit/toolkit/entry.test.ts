import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as entry from '../../../skills/dispatch/scripts/dispatch.ts';
import { readManifest } from '../../../skills/dispatch/scripts/lib/session.ts';
import { sessionFixture } from './helpers/session.ts';

test('dispatch entry routes sessions and toolkit operations with bounded output', async () => {
  const f = sessionFixture();
  fs.mkdirSync(path.join(f.root, '.git'));
  const deps = { ...f.deps, cwd: () => f.root };
  const invoke = async (args: string[]) => {
    f.lines.length = 0;
    const exit = await entry.main(args, deps);
    return { exit, ...f.output() };
  };
  try {
    const created = await invoke(['session', 'init', '--objective', '界'.repeat(2000)]);
    assert.equal(created.exit, 0);
    assert.equal(created.ok, true);
    assert.ok(created.path);
    assert.match(readManifest(created.path).sessionId, /^[0-9a-f-]{36}$/);
    assert.ok(Buffer.byteLength(created.summary) <= 1024);
    for (let i = 0; i < 2; i++) {
      const active = await invoke(['session', 'reactivate', '--session-dir', created.path]);
      assert.equal(active.exit, 0);
      assert.equal(active.path, created.path);
      assert.ok(Buffer.byteLength(active.summary) <= 1024);
    }
    const status = await invoke(['status', 'show', '--session', created.path]);
    assert.equal(status.exit, 0);
    assert.ok(status.path && fs.existsSync(status.path));
    const quota = await invoke(['session', 'quota-reprobe', '--session-dir', created.path, '--provider', 'codex', '--mode', 'cli']);
    assert.equal(quota.exit, 0);
    assert.deepEqual(JSON.parse(f.lines[0]!), { v: 1, action: 'quota-reprobe', key: { provider: 'codex', model: null, mode: 'cli' }, appliesTo: 'future-waves' });
    for (const args of [
      ['start', 'plan'], ['send', '--run', 'x'], ['rebind', '--run', 'x'], ['checkpoint'],
      ['session', 'quota-reprobe', '--session-dir', created.path, '--provider', 'unknown', '--mode', 'cli'],
      ['session', 'quota-reprobe', '--session-dir', created.path, '--provider', 'codex', '--mode', 'unknown'],
      ['session', 'init', '--unknown', '界'.repeat(2000)],
    ]) {
      const invalid = await invoke(args);
      assert.equal(invalid.exit, 1);
      assert.equal(invalid.reason, 'usage');
      assert.ok(Buffer.byteLength(invalid.summary) <= 1024);
    }
    const broken = await invoke(['session', 'reactivate', '--session-dir', path.join(f.root, '界'.repeat(2000))]);
    assert.equal(broken.exit, 2);
    assert.equal(broken.reason, 'fault');
    assert.ok(Buffer.byteLength(broken.summary) <= 1024);
    const explicit = await invoke(['session', 'init', '--objective', 'Explicit', '--session-id', 'chosen']);
    assert.equal(readManifest(explicit.path!).sessionId, 'chosen');
  } finally { f.cleanup(); }
});

test('dispatch entry recognizes symlinked launch paths', () => {
  assert.equal(entry.isEntry('/linked/dispatch.ts', () => path.resolve('actual/dispatch.ts'), pathToFileURL(path.resolve('actual/dispatch.ts')).href), true);
  assert.equal(entry.isEntry('/other.ts', () => '/other.ts', 'file:///actual/dispatch.ts'), false);
  assert.equal(entry.isEntry(undefined, () => { throw new Error('unused'); }), false);
});

test('dispatch entry distinguishes quota preconditions from filesystem faults', async () => {
  const f = sessionFixture();
  fs.mkdirSync(path.join(f.root, '.git'));
  const args = ['session', 'quota-reprobe', '--session-dir', f.session, '--provider', 'codex', '--mode', 'cli'];
  const deps = { ...f.deps, cwd: () => f.root };
  try {
    fs.writeFileSync(path.join(f.session, '.state'), 'blocks quota directory creation');
    assert.equal(await entry.main(args, deps), 2);
    const fault = f.output();
    assert.equal(fault.reason, 'fault');
    assert.equal(fault.path, null);
    assert.match(fault.summary, /ENOTDIR/);
    fs.unlinkSync(path.join(f.session, '.state'));
    const manifestPath = path.join(f.session, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, repositoryRoot: 'another-repository' }));
    f.lines.length = 0;
    assert.equal(await entry.main(args, deps), 1);
    assert.equal(f.output().reason, 'usage');
  } finally { f.cleanup(); }
});
