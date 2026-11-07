import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SPECS } from '../../../skills/dispatch/scripts/providers/index.ts';
import { runDelegate, type RunnerPorts } from '../../../skills/dispatch/scripts/providers/runner.ts';
import { MODE_IDS, type LaunchRequest, type PlatformEnv, type ProcessResult, type ProviderId } from '../../../skills/dispatch/scripts/providers/types.ts';

const env = (os: PlatformEnv['os'], bubblewrap = false): PlatformEnv => ({ os, arch: 'x64', wsl: false, bubblewrap, argvLimit: 100000, home: '/h', path: [], pathExt: [] });

const request = (sandbox: boolean, platform = env('linux', true)): LaunchRequest => ({
  promptPath: '/r/p.md', model: 'm', effort: 'high', sandbox, schemaPath: null, resume: null, cwd: '/repo', timeoutMs: 60000, outputCapBytes: 1000,
  attachments: [], logPath: '/r/log', briefPath: '/r/brief.md', binary: 'bin', prompt: 'PROMPT', briefFile: null, schemaText: null, platform,
});

// Flags that grant writes or skip approval without a read-only counterweight.
const WRITE_FLAGS = [/^--yolo$/, /^--allow-all-tools$/, /^--dangerously-bypass-approvals-and-sandbox$/, /^acceptEdits$/, /^bypassPermissions$/, /^--full-auto$/, /danger-full-access/];

test('delegates-read-only: every provider × mode × sandbox argv carries the read-only flags and no write flag', () => {
  for (const id of Object.keys(SPECS) as ProviderId[]) {
    const spec = SPECS[id];
    for (const mode of MODE_IDS) {
      for (const sandbox of [true, false]) {
        const argv = spec.argv(request(sandbox), mode).argv;
        for (const flag of spec.readOnlyFlags) assert.ok(argv.includes(flag), `${id}/${mode}/${String(sandbox)} lacks ${flag}`);
        for (const pattern of WRITE_FLAGS) {
          const hit = argv.some((arg) => pattern.test(arg));
          // codex's only unsandboxed escape: `sandbox: false` explicitly selects danger-full-access.
          const allowed = (id === 'codex' && !sandbox && pattern.source === 'danger-full-access') || (id === 'copilot' && sandbox && pattern.source === '^--allow-all-tools$');
          assert.equal(hit && !allowed, false, `${id}/${mode}/${String(sandbox)} has ${pattern.source}`);
        }
        if (spec.sandbox && sandbox && id !== 'opencode') for (const flag of spec.sandbox.flags) assert.ok(argv.includes(flag), `${id} sandbox flag ${flag}`);
        if (id === 'opencode') {
          const format = argv.indexOf('--format');
          assert.ok(format > 0 && argv[format + 1] === 'json', `${mode}/${String(sandbox)} lacks --format json`);
        }
      }
    }
  }
  assert.ok(SPECS.codex.argv(request(true), 'cli').argv.join(' ').includes('--sandbox read-only'));
  assert.ok(SPECS.codex.argv(request(false), 'cli').argv.includes('sandbox_mode="danger-full-access"'));
  assert.ok(SPECS.codex.argv(request(true), 'cli').argv.includes('--skip-git-repo-check'), 'codex runs outside a trusted git folder');
  assert.deepEqual(SPECS.opencode.argv(request(true), 'cli').argv.slice(0, 7), ['bwrap', '--unshare-user', '--unshare-ipc', '--unshare-pid', '--unshare-uts', '--ro-bind', '/']);
});

test('claude delegates cannot launch subagents', () => {
  for (const mode of MODE_IDS) {
    for (const sandbox of [true, false]) {
      const argv = SPECS.claude.argv(request(sandbox), mode).argv;
      const denied: string[] = [];
      let inList = false;
      for (const arg of argv) {
        if (arg.startsWith('--')) inList = arg === '--disallowedTools';
        else if (inList) denied.push(arg);
      }
      for (const tool of ['Agent', 'Task']) assert.ok(denied.includes(tool), `${mode}/${String(sandbox)} does not disallow ${tool}`);
      assert.ok(!argv.some((arg) => /^Task[A-Z]/.test(arg)), `${mode}/${String(sandbox)} disallows a task-list tool`);
    }
  }
  for (const tool of ['Agent', 'Task']) assert.ok(SPECS.claude.readOnlyFlags.includes(tool), `read-only flags lack ${tool}`);
});

test('claude allowlists configured read commands as prefix Bash rules', () => {
  const argv = SPECS.claude.argv({ ...request(true), readCommands: ['codegraph explore'] }, 'cli').argv;
  const index = argv.indexOf('Bash(codegraph explore*)');
  assert.ok(index > 0 && argv[index - 1] === '--allowedTools');
  assert.ok(!SPECS.claude.argv(request(true), 'cli').argv.some((arg) => arg.includes('codegraph')));
});

test('copilot allowlists configured read commands as shell prefix rules', () => {
  const argv = SPECS.copilot.argv({ ...request(true), readCommands: ['codegraph explore'] }, 'cli').argv;
  const index = argv.indexOf('shell(codegraph explore:*)');
  assert.ok(index > 0 && argv[index - 1] === '--allow-tool');
  assert.ok(!SPECS.copilot.argv(request(true), 'cli').argv.some((arg) => arg.includes('codegraph')));
});

test('copilot sandbox argv uses GA hands-free flags in plan mode', () => {
  const sandboxed = SPECS.copilot.argv(request(true), 'cli').argv;
  for (const flag of ['--sandbox', '--allow-all-tools', '--no-ask-user', '--mode', 'plan', '--reasoning-effort', 'high']) {
    assert.ok(sandboxed.includes(flag), 'sandboxed copilot argv lacks ' + flag);
  }
  for (const flag of ['--experimental', '--yolo', '--allow-all-paths', '--allow-all-urls', '--autopilot']) {
    assert.ok(!sandboxed.includes(flag), 'sandboxed copilot argv includes ' + flag);
  }
  const unsandboxed = SPECS.copilot.argv(request(false), 'cli').argv;
  for (const flag of ['--sandbox', '--allow-all-tools', '--experimental']) assert.ok(!unsandboxed.includes(flag), 'unsandboxed copilot argv includes ' + flag);
});

const okResult: ProcessResult = { exit: 0, signal: null, stdout: '{"result":"ok","session_id":"s1"}', stdoutPath: '/r/log', stderrTail: '', durationMs: 1, timedOut: false, truncated: false };

function ports(platform: PlatformEnv, result: ProcessResult = okResult): RunnerPorts & { launches: number } {
  const state = { launches: 0 };
  const files = new Map([['/r/p.md', 'body']]);
  return Object.assign(state, {
    process: { start: () => { state.launches++; return { pid: 7, done: Promise.resolve(result) }; }, signal: () => {} },
    clock: { now: () => 0, every: () => () => {} },
    fs: { readText: (f: string) => files.get(f) ?? '', writeText: (f: string, t: string) => { files.set(f, t); }, realpath: (f: string) => f, readdir: () => [], size: () => null, readPrefix: () => '' },
    env: {}, platform, binary: 'bin', nonce: () => 'n',
  });
}

const delegate = { promptPath: '/r/p.md', model: null, effort: null, sandbox: true, schemaPath: null, resume: null, cwd: '/repo', timeoutMs: 1000, outputCapBytes: 1000, attachments: [], logPath: '/r/log', briefPath: '/r/brief.md' };

test('delegates-sandbox-strict: sandbox on an unsupported host fails the slot without launching; never a downgrade', async () => {
  for (const [id, platform] of [['claude', env('win32')], ['opencode', env('darwin')], ['opencode', env('linux', false)]] as const) {
    const p = ports(platform);
    const run = await runDelegate(SPECS[id], delegate, 'cli', p);
    assert.equal(run.outcome.status === 'fail' && run.outcome.cls, 'sandbox-unsupported', id);
    assert.equal(p.launches, 0);
  }
  const inactive = ports(env('linux'), { ...okResult, stderrTail: 'Sandbox disabled: sandbox is not active on this host' });
  const run = await runDelegate(SPECS.claude, delegate, 'cli', inactive);
  assert.equal(run.outcome.status === 'fail' && run.outcome.cls, 'sandbox-unsupported');
  const codex = ports(env('linux'), { ...okResult, exit: 2, stdout: '', stderrTail: "error: unexpected argument '--sandbox' found" });
  const rejected = await runDelegate(SPECS.codex, delegate, 'cli', codex);
  assert.equal(rejected.outcome.status === 'fail' && rejected.outcome.cls, 'sandbox-unsupported');
});

test('resume argv: codex keeps read-only approval and sandbox keys without forbidden flags', () => {
  for (const sandbox of [true, false]) {
    const argv = SPECS.codex.argv({ ...request(sandbox), resume: 't-9', prompt: 'C' }, 'cli').argv;
    assert.ok(argv.includes('resume') && argv.includes('t-9'));
    assert.ok(argv.includes('approval_policy="never"'), String(sandbox));
    assert.ok(argv.includes(sandbox ? 'sandbox_mode="read-only"' : 'sandbox_mode="danger-full-access"'), String(sandbox));
    assert.ok(argv.includes('-c'), String(sandbox));
    for (const flag of ['--cd', '--sandbox', '--config']) assert.ok(!argv.includes(flag), `${String(sandbox)} has ${flag}`);
  }
});

test('resume argv: opencode keeps read-only run flag and session id', () => {
  for (const sandbox of [true, false]) {
    const argv = SPECS.opencode.argv({ ...request(sandbox, env('linux', true)), resume: 'ses_last', agent: 'explore', prompt: 'C' }, 'cli').argv;
    assert.ok(argv.includes('run'));
    const session = argv.indexOf('--session');
    assert.ok(session > 0 && argv[session + 1] === 'ses_last', String(sandbox));
    assert.ok(session < argv.lastIndexOf('--'), String(sandbox));
    if (sandbox) assert.equal(argv[0], 'bwrap');
  }
});

test('resume argv: copilot keeps plan mode and sandbox flags with resume and no session id', () => {
  for (const sandbox of [true, false]) {
    const argv = SPECS.copilot.argv({ ...request(sandbox), sessionPreset: 'preset-id-4', resume: 'preset-id-4' }, 'cli').argv;
    assert.ok(argv.includes('--resume') && argv.includes('preset-id-4'), String(sandbox));
    assert.ok(!argv.includes('--session-id'), String(sandbox));
    for (const flag of ['--mode', 'plan']) assert.ok(argv.includes(flag), String(sandbox));
    if (sandbox) for (const flag of ['--sandbox', '--allow-all-tools', '--no-ask-user']) assert.ok(argv.includes(flag), String(sandbox));
  }
});

test('resume argv: claude keeps plan mode and tool denylist with resume', () => {
  for (const sandbox of [true, false]) {
    const argv = SPECS.claude.argv({ ...request(sandbox), resume: 'abc123' }, 'cli').argv;
    assert.ok(argv.includes('--resume') && argv.includes('abc123'), String(sandbox));
    for (const flag of ['--permission-mode', 'plan', 'Write', 'Edit', 'Agent', 'Task']) assert.ok(argv.includes(flag), String(sandbox));
    if (sandbox) assert.ok(argv.includes('--settings'), String(sandbox));
  }
});

test('resume argv: agy keeps plan mode with conversation id', () => {
  for (const sandbox of [true, false]) {
    const argv = SPECS.agy.argv({ ...request(sandbox), resume: 'c-1' }, 'cli').argv;
    assert.ok(argv.includes('--conversation') && argv.includes('c-1'), String(sandbox));
    assert.ok(argv.includes('--mode') && argv.includes('plan'), String(sandbox));
  }
});
