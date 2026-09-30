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
          const allowed = id === 'codex' && !sandbox && pattern.source === 'danger-full-access';
          assert.equal(hit && !allowed, false, `${id}/${mode}/${String(sandbox)} has ${pattern.source}`);
        }
        if (spec.sandbox && sandbox && id !== 'opencode') for (const flag of spec.sandbox.flags) assert.ok(argv.includes(flag), `${id} sandbox flag ${flag}`);
      }
    }
  }
  assert.ok(SPECS.codex.argv(request(true), 'cli').argv.join(' ').includes('--sandbox read-only'));
  assert.ok(SPECS.codex.argv(request(false), 'cli').argv.includes('sandbox_mode="danger-full-access"'));
  assert.deepEqual(SPECS.opencode.argv(request(true), 'cli').argv.slice(0, 7), ['bwrap', '--unshare-user', '--unshare-ipc', '--unshare-pid', '--unshare-uts', '--ro-bind', '/']);
});

const okResult: ProcessResult = { exit: 0, signal: null, stdout: '{"result":"ok","session_id":"s1"}', stdoutPath: '/r/log', stderrTail: '', durationMs: 1, timedOut: false, truncated: false };

function ports(platform: PlatformEnv, result: ProcessResult = okResult): RunnerPorts & { launches: number } {
  const state = { launches: 0 };
  const files = new Map([['/r/p.md', 'body']]);
  return Object.assign(state, {
    process: { start: () => { state.launches++; return { pid: 7, done: Promise.resolve(result) }; }, signal: () => {} },
    clock: { now: () => 0, every: () => () => {} },
    fs: { readText: (f: string) => files.get(f) ?? '', writeText: (f: string, t: string) => { files.set(f, t); }, realpath: (f: string) => f, size: () => null, readPrefix: () => '' },
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
});

test('delegates-sandbox-strict: a sandbox-inactive signature or a rejected sandbox flag yields sandbox-unsupported', async () => {
  const inactive = ports(env('linux'), { ...okResult, stderrTail: 'Sandbox disabled: sandbox is not active on this host' });
  const run = await runDelegate(SPECS.claude, delegate, 'cli', inactive);
  assert.equal(run.outcome.status === 'fail' && run.outcome.cls, 'sandbox-unsupported');
  const codex = ports(env('linux'), { ...okResult, exit: 2, stdout: '', stderrTail: "error: unexpected argument '--sandbox' found" });
  const rejected = await runDelegate(SPECS.codex, delegate, 'cli', codex);
  assert.equal(rejected.outcome.status === 'fail' && rejected.outcome.cls, 'sandbox-unsupported');
});
