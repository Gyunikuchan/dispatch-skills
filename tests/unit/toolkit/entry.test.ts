import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as entry from '../../../skills/dispatch/scripts/dispatch.ts';
import { readManifest } from '../../../skills/dispatch/scripts/lib/session.ts';
import { main as toolkitMain } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import type { DelegateRequest } from '../../../skills/dispatch/scripts/providers/types.ts';
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

    const active = await invoke(['session', 'reactivate', '--session-dir', created.path]);
    assert.equal(active.exit, 0);
    assert.equal(active.path, created.path);
    assert.ok(Buffer.byteLength(active.summary) <= 1024);

    const status = await invoke(['status', 'show', '--session', created.path]);
    assert.equal(status.exit, 0);
    assert.ok(status.path && fs.existsSync(status.path));

    const quota = await invoke(['session', 'quota-reprobe', '--session-dir', created.path, '--provider', 'codex', '--mode', 'cli']);
    assert.equal(quota.exit, 0);
    assert.deepEqual(JSON.parse(f.lines[0]!), { v: 1, action: 'quota-reprobe', key: { provider: 'codex', model: null, mode: 'cli' }, appliesTo: 'future-waves' });

    for (const args of [
      ['start', 'plan'], ['send', '--run', 'x'], ['checkpoint'],
      ['session', 'quota-reprobe', '--session-dir', created.path, '--provider', 'unknown', '--mode', 'cli'],
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

    // Quota preconditions and filesystem faults
    const quotaArgs = ['session', 'quota-reprobe', '--session-dir', explicit.path!, '--provider', 'codex', '--mode', 'cli'];
    fs.writeFileSync(path.join(explicit.path!, '.state'), 'blocks quota directory creation');
    f.lines.length = 0;
    assert.equal(await entry.main(quotaArgs, deps), 2);
    const fault = f.output();
    assert.equal(fault.reason, 'fault');
    assert.equal(fault.path, null);
    assert.match(fault.summary, /ENOTDIR/);
    fs.unlinkSync(path.join(explicit.path!, '.state'));

    const manifestPath = path.join(explicit.path!, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, repositoryRoot: 'another-repository' }));
    f.lines.length = 0;
    assert.equal(await entry.main(quotaArgs, deps), 1);
    assert.equal(f.output().reason, 'usage');
  } finally { f.cleanup(); }
});

test('dispatch entry recognizes symlinked launch paths', () => {
  assert.equal(entry.isEntry('/linked/dispatch.ts', () => path.resolve('actual/dispatch.ts'), pathToFileURL(path.resolve('actual/dispatch.ts')).href), true);
  assert.equal(entry.isEntry('/other.ts', () => '/other.ts', 'file:///actual/dispatch.ts'), false);
  assert.equal(entry.isEntry(undefined, () => { throw new Error('unused'); }), false);
});

test('session instructions always point at grounding and add diagnostics only when enabled', async () => {
  const f = sessionFixture();
  try {
    fs.mkdirSync(path.join(f.root, '.git'));
    const skill = path.join(f.root, 'skill'); fs.mkdirSync(skill);
    const deps = { ...f.deps, skillRoot: skill, cwd: () => f.root };
    const assertInstructions = (value: { instructions?: unknown }, enabled: boolean) => {
      const instructions = value.instructions;
      if (typeof instructions !== 'string') assert.fail('Session instructions must be present');
      assert.match(instructions, /When a verb needs a new spec, run `doctor run` and ground under references\/grounding\.md before authoring the spec; after confirming it, ground again before design or plan authoring\. Launch explorers only when doctor reports one for this platform; otherwise self-ground\./);
      if (enabled) assert.match(instructions, /references\/diagnostics\.md.*diagnostics render/);
      else assert.doesNotMatch(instructions, /references\/diagnostics\.md/);
      assert.ok(!instructions.includes(f.root));
      assert.ok(Buffer.byteLength(instructions) <= 2048);
    };
    fs.writeFileSync(path.join(skill, 'config.jsonc'), JSON.stringify({ diagnostics: false }));
    assert.equal(await entry.main(['session', 'init', '--objective', 'test-disabled'], deps), 0);
    assertInstructions(JSON.parse(f.lines[0]!), false);
    f.lines.length = 0;
    fs.writeFileSync(path.join(skill, 'config.jsonc'), JSON.stringify({ diagnostics: true }));
    assert.equal(await entry.main(['session', 'init', '--objective', 'test-enabled'], deps), 0);
    const enabledVal = JSON.parse(f.lines[0]!);
    assertInstructions(enabledVal, true);
    f.lines.length = 0;
    assert.equal(await entry.main(['session', 'reactivate', '--session-dir', enabledVal.path], deps), 0);
    assertInstructions(JSON.parse(f.lines[0]!), true);
  } finally { f.cleanup(); }
});

test('disabled diagnostics add neither lifecycle collection requests nor capture artifacts for OpenCode', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill'); fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, 'config.jsonc'), JSON.stringify({ diagnostics: false }));
    f.deps.skillRoot = skill;
    const requests: DelegateRequest[] = [];
    f.deps.delegate = async (provider, request, mode) => {
      requests.push(request);
      return { outcome: { status: 'ok', text: 'answer', sessionId: null, resume: null }, invocations: [{ provider, model: null, mode, effort: null, launched: true, outcome: 'ok' }] };
    };
    f.deps.handler = async ({ deps }) => {
      await deps.delegate('opencode', { logPath: path.join(f.session, 'logs', 'opencode[0].log') } as DelegateRequest, 'cli');
      return { ok: true, exit: 0, summary: 'done', value: null };
    };
    assert.equal(await toolkitMain(['ask', 'run', '--session', f.session], f.deps), 0);
    assert.deepEqual(requests.map((r) => [r.collectUsage, r.collectLifecycle]), [[undefined, undefined]]);
    assert.equal(fs.existsSync(path.join(f.session, '.state', 'diagnostics')), false);
  } finally { f.cleanup(); }
});
