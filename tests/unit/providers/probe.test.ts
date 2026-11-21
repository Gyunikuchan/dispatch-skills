import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { probeProviders, type ProbeDeps, type ProbeSpawnPort } from '../../../skills/dispatch/scripts/providers/probe.ts';
import type { PlatformEnv, ProviderId } from '../../../skills/dispatch/scripts/providers/types.ts';
import * as opencodeModule from '../../../skills/dispatch/scripts/providers/opencode.ts';

const platform = (os: PlatformEnv['os'], bubblewrap = false): PlatformEnv => ({
  os, bubblewrap, arch: 'x64', wsl: false, argvLimit: 10000, home: '/home/probe', path: [], pathExt: [],
});
const result = (stdout = 'tool v01.002.3', exit: number | null = 0, stderr = '') => ({ stdout, stderr, exit });
const target = (provider: ProviderId, sandboxRequired = true) => ({ provider, sandboxRequired });
const deps = (spawn: ProbeSpawnPort = async () => result(), env = platform('win32')): ProbeDeps => ({
  spawn, platform: env, cwd: '/work', exists: () => true,
  discovery: { resolve: provider => ({ status: 'path', path: provider }), doctor: () => [], probes: 0 },
});
const rows = async (provider: ProviderId, options: ProbeDeps, required = true) =>
  (await probeProviders([target(provider, required)], options)).probes[0]!;

test('probes all five providers across supported and unsupported OS sandboxes', async () => {
  const { probes, probeSummary } = await probeProviders((['agy', 'claude', 'codex', 'copilot', 'opencode'] as const).map(
    name => target(name, name !== 'agy'),
  ), deps(async (_binary, args) => result(args.includes('debug') ? '[]' : undefined)));
  assert.deepEqual(probes.map(row => [row.provider, row.readiness, row.sandbox, row.failureCategory]), [
    ['agy', 'unprobeable', 'unsupported', null],
    ['claude', 'unprobeable', 'unsupported', 'sandbox-unsupported'],
    ['codex', 'unprobeable', 'unverified', null],
    ['copilot', 'unprobeable', 'unverified', null],
    ['opencode', 'ok', 'unsupported', 'sandbox-unsupported'],
  ]);
  assert.deepEqual(probeSummary, { ok: 3, failed: 2, unprobeable: 4, unverified: 2 });
  assert.ok(probes.filter(row => row.failureCategory).every(row => row.remediation));
  for (const os of ['linux', 'darwin'] as const) {
    const outcome = await probeProviders(probes.map(row => target(row.provider, row.provider !== 'agy')),
      deps(async (_binary, args) => result(args.includes('debug') ? '[]' : undefined), platform(os)));
    assert.deepEqual(outcome.probes.map(row => row.sandbox),
      ['unsupported', 'unverified', 'unverified', 'unverified', os === 'linux' ? 'unavailable' : 'unsupported']);
    assert.deepEqual(outcome.probeSummary, { ok: 4, failed: 1, unprobeable: 4, unverified: 3 });
  }
});

test('establishes binaryFound via --version exit and fails broken CLI exits', async () => {
  const cases = [
    [result('a secret', 2), 'probe-error'],
    [result('a secret', null), 'probe-error'],
    [{ ...result(), errorCode: 'ENOENT' }, 'not-found'],
    [{ ...result(), errorCode: 'EACCES' }, 'not-found'],
  ] as const;
  for (const [output, category] of cases) {
    const row = await rows('codex', deps(async () => output));
    assert.deepEqual([row.binaryFound, row.version, row.readiness, row.failureCategory], [false, null, 'error', category]);
    assert.ok(row.remediation);
  }
});

test('respects sandboxRequired false opt-out and uniform failure predicate', async () => {
  const probe = deps(async () => result('opaque'));
  const { probes, probeSummary } = await probeProviders([target('claude', false), target('claude')], probe);
  assert.deepEqual(probes.map(row => [row.version, row.sandbox, row.failureCategory]), [
    [null, 'unsupported', null], [null, 'unsupported', 'sandbox-unsupported'],
  ]);
  assert.deepEqual(probeSummary, { ok: 1, failed: 1, unprobeable: 2, unverified: 0 });
});

test('probes OpenCode standalone readiness and Linux bwrapArgv', async () => {
  const env = { ...platform('linux', true), xdg: { cache: '/xdg/cache' } };
  const launches: [string, readonly string[]][] = [];
  const options = deps(async (binary, args) => {
    launches.push([binary, args]);
    return result(args.includes('debug') ? '[]' : undefined);
  }, env);
  const row = await rows('opencode', options);
  assert.deepEqual([row.readiness, row.sandbox], ['ok', 'ok']);
  const [bwrap, ...args] = opencodeModule.bwrapArgv({ platform: env, cwd: '/work', briefFile: null }, ['true']);
  assert.deepEqual(launches, [
    ['opencode', ['--version']], ['opencode', ['--standalone', 'debug', 'config']],
    ['opencode', ['--standalone', 'debug', 'agents']], [bwrap, args],
  ]);
  launches.length = 0;
  assert.equal((await rows('opencode', { ...options, exists: dir => dir !== '/xdg/cache/opencode' })).sandbox, 'unavailable');
  assert.equal(launches.length, 3);
  const matrix = [
    [result('[]', 2, "unknown option '--standalone'"), 'unsupported', 'unsupported-version'],
    [result('[]', 2), 'error', 'config-error'],
    [result('{malformed'), 'error', 'config-error'],
    [result('{}'), 'error', 'config-error'],
    [{ ...result(), errorCode: 'EPERM' }, 'error', 'probe-error'],
  ] as const;
  for (const [output, readiness, failureCategory] of matrix) {
    const outcome = await rows('opencode', deps(async (_bin, args) => args.includes('debug') ? output : result(), platform('linux')));
    assert.deepEqual([outcome.readiness, outcome.sandbox, outcome.failureCategory], [readiness, 'unavailable', failureCategory]);
  }
  for (const output of [result('', 1), { ...result(), errorCode: 'ENOENT' }]) {
    const outcome = await rows('opencode', deps(async (bin, args) => bin === 'bwrap' ? output : result(args.includes('debug') ? '[]' : undefined), env));
    assert.deepEqual([outcome.sandbox, outcome.failureCategory], ['unavailable', 'sandbox-unavailable']);
  }
});

test('enforces provider budgets across queued and active timeouts', async () => {
  const providers: ProviderId[] = ['agy', 'claude', 'codex', 'copilot', 'opencode'];
  for (const start of [15100, 6000]) {
    let now = 100;
    const calls: number[] = [];
    const options = deps(async (_bin, _args, launch) => {
      calls.push(launch.timeoutMs);
      if (calls.length <= 4) {
        await Promise.resolve();
        now = start;
      }
      return { ...result(), timedOut: true };
    }, platform('linux', true));
    const { probes } = await probeProviders(providers.map(name => target(name)), { ...options, now: () => now });
    assert.deepEqual(calls, start === 15100 ? [10000, 10000, 10000, 10000] : [10000, 10000, 10000, 10000, 9100]);
    assert.deepEqual(probes.map(row => [row.failureCategory, row.binaryFound, row.version]), providers.map(() => ['timeout', false, null]));
    assert.equal(probes[4]!.sandbox, 'unverified');
  }
  let now = 0;
  const options = deps(async (_bin, args, launch) => {
    if (args.includes('--version')) { now = 8000; return result(); }
    assert.equal(launch.timeoutMs, 2000);
    return { ...result(), timedOut: true };
  }, platform('linux', true));
  const row = await rows('opencode', { ...options, now: () => now });
  assert.deepEqual([row.binaryFound, row.version, row.sandbox, row.failureCategory], [true, '1.2.3', 'unverified', 'timeout']);
});

test('reconstructs numeric version from integers and leaks zero credentials from version or debug output', async () => {
  const secret = 'AbCdEf123456';
  assert.equal((await rows('codex', deps(async () => result('\n\n tool v001.02.003 built')))).version, '1.2.3');
  const row = await rows('opencode', deps(async (_bin, args) => result(args.includes('debug') ? JSON.stringify([secret]) : '1.2.3-' + secret, 0, secret)));
  assert.equal(row.version, null);
  assert.equal(JSON.stringify(row).includes(secret), false);
  const source = fs.readFileSync(new URL('../../../skills/dispatch/scripts/providers/probe.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node-process\.ts|opencode-runtime\.ts|\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream)\b/);
});

test('resolves first launchable provider mode including desktop or vscode installs', async () => {
  const called: string[] = [];
  const options = deps(async binary => { called.push(binary); return result(); });
  options.discovery!.resolve = (_provider, mode) => mode === 'desktop' ? { status: 'path', path: 'desktop-binary' } : { status: 'unlaunchable', path: 'nonexec' };
  await rows('claude', options, false);
  assert.deepEqual(called, ['desktop-binary']);
  options.discovery!.resolve = () => ({ status: 'unlaunchable', path: 'nonexec' });
  const row = await rows('claude', options, false);
  assert.deepEqual([row.binaryFound, row.failureCategory], [false, 'not-found']);
  assert.deepEqual(called, ['desktop-binary']);
});

