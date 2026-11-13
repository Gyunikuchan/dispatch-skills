import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as entry from '../../../skills/dispatch/scripts/dispatch.ts';
import { readManifest } from '../../../skills/dispatch/scripts/lib/session.ts';
import { main as toolkitMain, TOOL_ACTIONS } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { KINDS } from '../../../skills/dispatch/scripts/toolkit/records.ts';
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
    const created = await invoke(['session', 'init', '--objective', '界'.repeat(2000), '--host', 'claude']);
    assert.equal(created.exit, 0);
    assert.equal(created.ok, true);
    assert.ok(created.path);
    assert.match(readManifest(created.path).sessionId, /^[0-9a-f-]{36}$/);
    assert.ok(Buffer.byteLength(created.summary) <= 1024);

    const active = await invoke(['session', 'reactivate', '--session-dir', created.path, '--host', 'claude']);
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
      ['session', 'init', '--unknown', '界'.repeat(2000), '--host', 'claude'],
    ]) {
      const invalid = await invoke(args);
      assert.equal(invalid.exit, 1);
      assert.equal(invalid.reason, 'usage');
      assert.ok(Buffer.byteLength(invalid.summary) <= 1024);
    }

    const broken = await invoke(['session', 'reactivate', '--session-dir', path.join(f.root, '界'.repeat(2000)), '--host', 'claude']);
    assert.equal(broken.exit, 2);
    assert.equal(broken.reason, 'fault');
    assert.ok(Buffer.byteLength(broken.summary) <= 1024);

    const explicit = await invoke(['session', 'init', '--objective', 'Explicit', '--session-id', 'chosen', '--host', 'claude']);
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

test('session actions record the declared host, replace it and refuse a missing or unknown host', async () => {
  const f = sessionFixture();
  fs.mkdirSync(path.join(f.root, '.git'));
  const deps = { ...f.deps, cwd: () => f.root };
  const invoke = async (args: string[]) => { f.lines.length = 0; const exit = await entry.main(args, deps); return { exit, ...f.output() }; };
  try {
    const created = await invoke(['session', 'init', '--objective', 'Host', '--session-id', 'declared', '--host', 'github-copilot']);
    assert.equal(created.exit, 0);
    assert.equal(readManifest(created.path!).host, 'copilot');

    const reused = await invoke(['session', 'init', '--objective', 'Host', '--session-id', 'declared', '--host', 'codex']);
    assert.equal(reused.path, created.path);
    assert.equal(readManifest(created.path!).host, 'codex');

    const switched = await invoke(['session', 'reactivate', '--session-dir', created.path!, '--host', 'claude']);
    assert.equal(switched.exit, 0);
    assert.equal(readManifest(created.path!).host, 'claude');

    const before = fs.readFileSync(path.join(created.path!, 'manifest.json'), 'utf8');
    for (const args of [
      ['session', 'init', '--objective', 'Host', '--session-id', 'declared'],
      ['session', 'init', '--objective', 'Host', '--session-id', 'declared', '--host', 'unknown-x'],
      ['session', 'reactivate', '--session-dir', created.path!],
      ['session', 'reactivate', '--session-dir', created.path!, '--host', 'unknown-x'],
    ]) {
      const refused = await invoke(args);
      assert.equal(refused.exit, 1, args.join(' '));
      assert.equal(refused.reason, 'usage', args.join(' '));
      if (args.includes('unknown-x')) assert.match(refused.summary, /claude, agy, copilot, opencode, codex/);
    }
    assert.equal(fs.readFileSync(path.join(created.path!, 'manifest.json'), 'utf8'), before);
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
      assert.match(instructions, /When a verb needs a new spec, run `doctor run --host <platform>` and ground under references\/grounding\.md before authoring the spec; after confirming it, ground again before design or plan authoring\. Launch explorers on doctor's `utility` entry for this platform; self-ground only when the host has no launch tool or no map survives recovery\./);
      assert.doesNotMatch(instructions, /Launch explorers only when doctor reports one/);
      if (enabled) assert.match(instructions, /references\/diagnostics\.md.*diagnostics render/);
      else assert.doesNotMatch(instructions, /references\/diagnostics\.md/);
      assert.ok(!instructions.includes(f.root));
      assert.ok(Buffer.byteLength(instructions) <= 2048);
    };
    fs.writeFileSync(path.join(skill, 'config.jsonc'), JSON.stringify({ diagnostics: false }));
    assert.equal(await entry.main(['session', 'init', '--objective', 'test-disabled', '--host', 'claude'], deps), 0);
    assertInstructions(JSON.parse(f.lines[0]!), false);
    f.lines.length = 0;
    fs.writeFileSync(path.join(skill, 'config.jsonc'), JSON.stringify({ diagnostics: true }));
    assert.equal(await entry.main(['session', 'init', '--objective', 'test-enabled', '--host', 'claude'], deps), 0);
    const enabledVal = JSON.parse(f.lines[0]!);
    assertInstructions(enabledVal, true);
    f.lines.length = 0;
    assert.equal(await entry.main(['session', 'reactivate', '--session-dir', enabledVal.path, '--host', 'claude'], deps), 0);
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
    assert.equal(await toolkitMain(['ask', 'run', '--session', f.session, '--host', 'opencode'], f.deps), 0);
    assert.deepEqual(requests.map((r) => [r.collectUsage, r.collectLifecycle]), [[undefined, undefined]]);
    assert.equal(fs.existsSync(path.join(f.session, '.state', 'diagnostics')), false);
  } finally { f.cleanup(); }
});

// SECTION: help command and session refusal pointer
const toolkitText = fs.readFileSync(path.resolve('skills/dispatch/references/toolkit.md'), 'utf8').replace(/\r\n/g, '\n');
const sectionOf = (heading: string) => {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^(#{2,3}) ${escaped}$`, 'm').exec(toolkitText);
  if (!match) throw new Error(`Missing toolkit heading: ${heading}`);
  return toolkitText.slice(match.index).split(new RegExp(`\\n#{1,${match[1]!.length}} `))[0]!.trimEnd() + '\n';
};
const slugOf = (heading: string) => heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const markdownFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? markdownFiles(path.join(dir, entry.name)) : entry.name.endsWith('.md') ? [path.join(dir, entry.name)] : []);

test('help prints exactly one section for each action, record kind, session command and the call table', async () => {
  const f = sessionFixture();
  try {
    const headings = [...toolkitText.matchAll(/^### (.+)$/gm)].map((m) => m[1]!);
    assert.ok(headings.length >= 43);
    for (const heading of [...TOOL_ACTIONS, ...KINDS, 'session init', 'session reactivate', 'session quota-reprobe', 'call table']) {
      f.lines.length = 0;
      assert.equal(await entry.main(['help', ...heading.split(' ')], f.deps), 0, heading);
      assert.equal(f.lines.length, 1);
      assert.equal(f.lines[0], sectionOf(heading), heading);
    }
  } finally { f.cleanup(); }
});

test('help prints each toolkit section linked from skill prose and nested subsections of a level-2 section', async () => {
  const headingsByAnchor = new Map([...toolkitText.matchAll(/^(#{2,3}) (.+)$/gm)].map((m) => [slugOf(m[2]!), m[2]!]));
  const anchors = new Set<string>();
  for (const file of [path.resolve('skills/dispatch/SKILL.md'), ...markdownFiles(path.resolve('skills/dispatch/references'))]) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/toolkit\.md#([a-z0-9-]+)/gi)) anchors.add(match[1]!);
  }
  assert.ok(anchors.size > 0);
  assert.ok(anchors.has('session-commands'));
  const f = sessionFixture();
  try {
    for (const anchor of anchors) {
      const heading = headingsByAnchor.get(anchor);
      assert.ok(heading, anchor);
      f.lines.length = 0;
      assert.equal(await entry.main(['help', ...heading.split(' ')], f.deps), 0, anchor);
      assert.equal(f.lines.length, 1);
      assert.equal(f.lines[0], sectionOf(heading), anchor);
      if (anchor === 'session-commands') {
        for (const sub of ['### session init', '### session reactivate', '### session quota-reprobe']) {
          assert.ok(f.lines[0]!.includes(sub), sub);
        }
      }
    }
  } finally { f.cleanup(); }
});

test('help refuses an unknown or empty heading with the valid headings inside the summary cap', async () => {
  const f = sessionFixture();
  try {
    for (const args of [['help'], ['help', 'no', 'such', 'heading'], ['help', 'Toolkit', 'CLI', 'contract']]) {
      f.lines.length = 0;
      assert.equal(await entry.main(args, f.deps), 1);
      const out = f.output();
      assert.equal(out.ok, false);
      assert.equal(out.reason, 'usage');
      assert.equal(out.path, null);
      assert.ok(Buffer.byteLength(out.summary) <= 1024);
      assert.match(out.summary, /Index, call table, Tool actions.*Native-slot replies, Session commands.*session quota-reprobe/);
    }
  } finally { f.cleanup(); }
});

test('help refuses an unreadable toolkit contract as a fault', async () => {
  const f = sessionFixture();
  try {
    assert.equal(await entry.main(['help', 'call', 'table'], { ...f.deps, skillRoot: path.join(f.root, 'missing') }), 2);
    const out = f.output();
    assert.equal(out.reason, 'fault');
    assert.equal(out.path, null);
  } finally { f.cleanup(); }
});

test('session refusals name the section to read', async () => {
  const f = sessionFixture();
  fs.mkdirSync(path.join(f.root, '.git'));
  const deps = { ...f.deps, cwd: () => f.root };
  try {
    const cases: [string[], number, string][] = [
      [['session', 'init', '--unknown', 'x', '--host', 'claude'], 1, 'session init'],
      [['session', 'reactivate', '--session-dir', path.join(f.root, 'missing'), '--host', 'claude'], 2, 'session reactivate'],
      [['session', 'quota-reprobe', '--session-dir', f.session, '--provider', 'unknown', '--mode', 'cli'], 1, 'session quota-reprobe'],
      [['session', 'bogus'], 1, 'call table'],
    ];
    for (const [args, exit, help] of cases) {
      f.lines.length = 0;
      assert.equal(await entry.main(args, deps), exit, args.join(' '));
      assert.equal((f.output() as { help?: string }).help, help, args.join(' '));
    }
    f.lines.length = 0;
    assert.equal(await entry.main(['session', 'init', '--objective', 'ok', '--host', 'claude'], deps), 0);
    assert.equal('help' in f.output(), false);
  } finally { f.cleanup(); }
});
