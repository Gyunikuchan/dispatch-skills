import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../helpers/fake-ports.ts';
import { currentPlatform } from '../../skills/dispatch/scripts/lib/platform.ts';
import { SPECS } from '../../skills/dispatch/scripts/providers/index.ts';
import { DEFAULT_CONFIG_PATH, loadAuditConfig, readRun, reserveRun, updateRun, type LimitName, type ProbeRecord } from '../../.agents/skills/audit-dispatch-skills/scripts/run-state.ts';
// The .mjs helper has no declarations, so it is loaded the same untyped way as the other audit scripts.
const probe = await import(new URL('../../.agents/skills/audit-dispatch-skills/scripts/probe-dispatch.mjs', import.meta.url).href);

// SECTION: Fakes

type Result = { exit: number | null; stdout: string; truncated?: boolean; timedOut?: boolean };
const limits = () => loadAuditConfig(DEFAULT_CONFIG_PATH).limits;

function fakeClock() {
  let t = 1_000_000;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  return {
    timers,
    now: () => t,
    every(ms: number, fn: () => void) { const timer = { at: t + ms, fn, live: true }; timers.push(timer); return () => { timer.live = false; }; },
    advance(ms: number) { t += ms; for (const timer of timers) if (timer.live && timer.at <= t) { timer.live = false; timer.fn(); } },
  };
}

function fakeProcess(script: (n: number) => Result) {
  const launches: { argv: readonly string[]; stdin: string | null; capBytes: number }[] = [];
  return {
    launches,
    start(launch: { argv: readonly string[]; stdin: string | null }, io: { logPath: string; capBytes: number }) {
      launches.push({ argv: launch.argv, stdin: launch.stdin, capBytes: io.capBytes });
      const r = script(launches.length);
      fs.writeFileSync(io.logPath, r.stdout);
      return { pid: 4000 + launches.length, done: Promise.resolve({ exit: r.exit, signal: null, stdout: r.stdout, stdoutPath: io.logPath, stderrTail: '', durationMs: 5, timedOut: r.timedOut ?? false, truncated: r.truncated ?? false }) };
    },
    signal() {},
  };
}

function fakeSpec(extra: Record<string, unknown> = {}) {
  return {
    id: 'claude', modes: [], modeCascadeOn: [], resumeCommand: () => '',
    argv: (req: { prompt: string; cwd: string }) => ({ argv: ['fake-cli', req.prompt], stdin: null, env: {}, cwd: req.cwd }),
    parse: (out: { exit: number | null; stdout: string }) => (out.exit === 0
      ? { status: 'ok', text: out.stdout, sessionId: null, resume: null }
      : { status: 'fail', cls: 'model-not-found', detail: 'effort rejected', retryWithoutEffort: true }),
    ...extra,
  };
}

function setup(script: (n: number) => Result, spec = fakeSpec(), clock = fakeClock()) {
  const root = tempDir();
  const fixture = probe.createFixture(path.join(root, 'repo'), { home: path.join(root, 'home') });
  const stageDir = path.join(root, 'stage'); fs.mkdirSync(stageDir, { recursive: true });
  const process = fakeProcess(script);
  const states: { id: string; lifecycle: string }[] = [];
  const ctx = {
    fixture, stageDir, limits: limits(),
    state: { update: (id: string, record: { lifecycle: string }) => states.push({ id, lifecycle: record.lifecycle }) },
    ports: { process, clock, specs: { claude: spec }, env: {}, platform: currentPlatform() },
  };
  return { ctx, process, clock, fixture, states, stageDir };
}
const target = (extra: Record<string, unknown> = {}) => ({ id: 'claude', provider: 'claude', mode: 'cli', binary: 'fake-cli', model: null, effort: null, sandbox: true, aliases: ['cli'], skip: null, ...extra });
const okReply = (fixture: { nonces: { attached: string; sibling: string } }) => `ATTACHED: ${fixture.nonces.attached}\nSIBLING: ${fixture.nonces.sibling}`;

// SECTION: Selection

const rows = [
  { provider: 'claude', mode: 'cli', bin: '/bin/claude', reachable: true, detail: '' },
  { provider: 'claude', mode: 'desktop', bin: '/apps/claude', reachable: true, detail: '' },
  { provider: 'copilot', mode: 'cli', bin: null, reachable: false, detail: '' },
];
const config = { 'read-delegates': { claude: { targets: [{ low: { model: 'small-model', effort: 'low' }, medium: { model: 'mid-model', effort: 'medium' } }] } } };

test('audit probe selection uses low configuration and one reachable mode per provider', () => {
  const targets = probe.buildTargets(rows, { modes: false, config, limits: limits() });
  assert.deepEqual(targets.map((t: { id: string }) => t.id), ['claude']);
  assert.equal(targets[0].mode, 'cli');
  assert.equal(targets[0].model, 'small-model');
  assert.equal(targets[0].effort, 'low');
  assert.equal(probe.PROBE_LEVEL, 'low');
});

test('audit probe --modes widening beyond the launch limit is skipped without launching', () => {
  const targets = probe.buildTargets(rows, { modes: true, config, limits: limits() });
  assert.deepEqual(targets.map((t: { id: string; skip: string | null }) => [t.id, t.skip === null]), [['claude/cli', true], ['claude/desktop', false]]);
  assert.match(targets[1].skip, /probeLaunchesPerProvider/);
});

test('audit probe --only filtering narrows discovery to the named providers', async () => {
  const doctor = () => [
    { provider: 'claude', mode: 'cli', path: '/bin/claude', status: 'path' },
    { provider: 'agy', mode: 'cli', path: '/bin/agy', status: 'path' },
  ];
  const found = await probe.discover({}, ['agy'], { doctor });
  assert.deepEqual(found.map((r: { provider: string }) => r.provider), ['agy']);
});

// SECTION: Launch bounds

test('audit probe refuses a runner-internal retry beyond one launch', async () => {
  const { ctx, process } = setup(() => ({ exit: 1, stdout: 'rejected effort' }));
  const record = await probe.runTarget(target({ effort: 'low' }), ctx);
  assert.equal(process.launches.length, 1);
  assert.equal(record.launches, 1);
  assert.equal(record.cause, 'retry-refused');
  assert.equal(record.lifecycle, 'failed');
});

test('audit probe validates the denylisted attachment without any launch', async () => {
  const { ctx, process, fixture } = setup(() => ({ exit: 0, stdout: okReply(fixture) }));
  const record = await probe.runTarget(target(), ctx);
  assert.equal(process.launches.length, 1, 'only the read probe launches');
  assert.equal(record.denylist.launches, 0);
  assert.equal(record.denylist.behaviour, 'excluded');
  assert.equal(record.denylist.payloadExcluded, true);
  assert.ok(!process.launches.some((l) => l.argv.join(' ').includes(fixture.nonces.denylisted)));
  assert.equal(record.lifecycle, 'complete');
  assert.deepEqual(record.checks, { attached: true, sibling: true });
});

test('audit probe records an unavailable generation limit and omits absent usage', async () => {
  const { ctx, fixture } = setup(() => ({ exit: 0, stdout: okReply(fixture) }));
  const record = await probe.runTarget(target(), ctx);
  assert.deepEqual(record.generationLimit, { requested: 128, applied: false, reason: 'provider adapter exposes no generation-token limit' });
  assert.equal(record.usage, null);
  assert.ok(record.gaps.includes('usage unavailable'));
});

test('audit probe preparation shares the deadline and is classified separately', async () => {
  const clock = fakeClock();
  const spec = fakeSpec({ prepare: async () => { clock.advance(61_000); return { kind: 'launch', env: {}, release: () => {} }; } });
  const { ctx, process } = setup(() => ({ exit: 0, stdout: '' }), spec, clock);
  const record = await probe.runTarget(target(), { ...ctx, ports: { ...ctx.ports, prepare: { fetchModels: async () => [], acquireGpuLock: async () => () => {} } } });
  assert.equal(process.launches.length, 0);
  assert.equal(record.cause, 'preparation-timeout');
  assert.equal(record.lifecycle, 'timeout');
  assert.equal(record.deadlineAt - record.startedAt, 60_000);
});

test('audit probe passes the shared deadline to the launch timer', async () => {
  const { ctx, clock, fixture } = setup(() => ({ exit: 0, stdout: okReply(fixture) }));
  await probe.runTarget(target(), ctx);
  assert.ok(clock.timers.some((t) => t.at - 1_000_000 === 60_000), 'runner timeout at the 60 s deadline');
  assert.ok(clock.timers.some((t) => t.at - 1_000_000 === 70_000), 'termination grace ends 10 s later');
});

test('audit probe caps captured output at the configured byte limit', async () => {
  const { ctx, process } = setup(() => ({ exit: 0, stdout: 'x'.repeat(16_384), truncated: true }));
  const record = await probe.runTarget(target(), ctx);
  assert.equal(process.launches[0]?.capBytes, 16_384);
  assert.equal(record.cause, 'output-cap');
  assert.equal(record.lifecycle, 'failed');
  assert.ok(fs.statSync(path.join(ctx.stageDir, record.capture)).size <= 16_384);
});

test('audit probe does not relaunch a target whose recorded liveness is unknown', async () => {
  const { ctx, process } = setup(() => ({ exit: 0, stdout: '' }));
  const record = await probe.runTarget(target(), { ...ctx, previous: { lifecycle: 'running', liveness: 'unknown', handle: '77' } });
  assert.equal(process.launches.length, 0);
  assert.equal(record.lifecycle, 'interrupted');
  assert.equal(record.liveness, 'unknown');
  assert.equal(record.cleanup, 'blocked');
});

test('audit probe persists running then terminal lifecycle through the state port', async () => {
  const { ctx, states, fixture } = setup(() => ({ exit: 0, stdout: okReply(fixture) }));
  await probe.runTarget(target(), ctx);
  assert.deepEqual(states.map((s) => s.lifecycle), ['running', 'complete']);
});

test('audit probe fixture byte accounting combines every fixture file with both prompts', () => {
  const fixture = probe.createFixture(path.join(tempDir(), 'repo'), { home: tempDir() });
  const files = [fixture.attached, fixture.sibling, fixture.denylisted].reduce((sum, file) => sum + fs.statSync(file).size, 0);
  assert.equal(probe.fixtureBytes(fixture), files + Buffer.byteLength(fixture.prompt) + Buffer.byteLength(fixture.denyPrompt));
  assert.ok(probe.fixtureBytes(fixture) <= limits().probeFixtureBytes);
});

test('audit probe skips without launching when the fixture exceeds the configured byte limit', async () => {
  const { ctx, process } = setup(() => ({ exit: 0, stdout: '' }));
  const record = await probe.runTarget(target(), { ...ctx, limits: { ...ctx.limits, probeFixtureBytes: 64 } });
  assert.equal(process.launches.length, 0);
  assert.equal(record.lifecycle, 'skipped');
  assert.match(record.cause, /fixture-over-limit: .* bytes, above probeFixtureBytes=64/);
});

// SECTION: OpenCode preparation

const READ_ONLY_AGENTS = [{ id: 'explore', permissions: [{ action: '*', resource: '*', effect: 'deny' }, { action: 'read', resource: '*', effect: 'allow' }] }];
const opencodeTarget = () => target({ id: 'opencode', provider: 'opencode', binary: 'fake-opencode', sandbox: false });

function opencodeSetup(introspect: (command: 'config' | 'agents') => Promise<unknown>) {
  const { ctx, process } = setup(() => ({ exit: 0, stdout: 'ok' }));
  const ports = {
    ...ctx.ports, specs: { opencode: SPECS.opencode }, introspect: { opencode: () => introspect },
    prepare: { fetchModels: async () => [], acquireGpuLock: async () => () => {} },
  };
  return { ctx: { ...ctx, ports }, process };
}

test('audit probe launches the real OpenCode adapter once with the introspected read-only agent', async () => {
  const { ctx, process } = opencodeSetup(async (command) => (command === 'config' ? [{ type: 'document', info: {} }] : READ_ONLY_AGENTS));
  const record = await probe.runTarget(opencodeTarget(), ctx);
  assert.equal(process.launches.length, 1);
  const argv = process.launches[0]?.argv ?? [];
  assert.equal(argv[argv.indexOf('--agent') + 1], 'explore');
  assert.equal(record.launches, 1);
});

test('audit probe skips OpenCode with a coverage gap when introspection cannot verify a read-only agent', async () => {
  const { ctx, process } = opencodeSetup(async () => { throw new Error('effective-config-unverified: native introspection failed'); });
  const record = await probe.runTarget(opencodeTarget(), ctx);
  assert.equal(process.launches.length, 0);
  assert.equal(record.lifecycle, 'skipped');
  assert.match(record.cause, /^preparation-unenforceable: effective-config-unverified/);
  assert.ok(record.gaps.some((g: string) => /coverage gap: opencode read-only agent unverified/.test(g)), record.gaps.join('\n'));
});

test('audit probe gives OpenCode launches only the deadline remaining after introspection', async () => {
  const clock = fakeClock();
  const { ctx, process } = opencodeSetup(async (command) => { clock.advance(20_000); return command === 'config' ? [{ type: 'document', info: {} }] : READ_ONLY_AGENTS; });
  const record = await probe.runTarget(opencodeTarget(), { ...ctx, ports: { ...ctx.ports, clock } });
  assert.equal(process.launches.length, 1);
  assert.equal(record.deadlineAt - record.startedAt, 60_000);
  assert.ok(clock.timers.some((t) => t.at - 1_000_000 === 60_000), 'runner timeout ends at the original shared deadline');
  assert.ok(!clock.timers.some((t) => t.at - 1_000_000 > 70_000), 'no fresh full-length deadline after introspection');
});

test('audit probe refuses an OpenCode launch when introspection exhausts the shared deadline', async () => {
  const clock = fakeClock();
  const { ctx, process } = opencodeSetup(async (command) => { clock.advance(30_000); return command === 'config' ? [{ type: 'document', info: {} }] : READ_ONLY_AGENTS; });
  const record = await probe.runTarget(opencodeTarget(), { ...ctx, ports: { ...ctx.ports, clock } });
  assert.equal(process.launches.length, 0);
  assert.equal(record.lifecycle, 'timeout');
  assert.equal(record.cause, 'preparation-timeout');
});

// SECTION: Manifest-backed entrypoint
