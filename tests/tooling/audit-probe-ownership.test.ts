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

const READ_ONLY_AGENTS = [{ id: 'explore', permissions: [{ action: '*', resource: '*', effect: 'deny' }, { action: 'read', resource: '*', effect: 'allow' }] }];
const RUN = '2026-10-07-0000';
const probeConfig = { 'read-delegates': { claude: { targets: [{ low: { model: 'small-model', effort: 'low' } }] } } };
const priorRecord = (extra: Partial<ProbeRecord> = {}): ProbeRecord => ({
  lifecycle: 'complete', host: 'h', handle: '41', liveness: 'exited', startedAt: '2026-10-07T00:00:00.000Z', deadlineAt: '2026-10-07T00:01:00.000Z',
  attempts: 1, exitConfirmed: true, capturePath: null, fixturePath: null, outcome: 'pass', cause: null, cleanup: 'complete', ...extra,
});

type MainOptions = { config?: unknown; previous?: Record<string, ProbeRecord>; modes?: boolean; hang?: boolean; limits?: Partial<Record<LimitName, number>>; args?: string[] };

/** Reserves a run in a fresh repo; `limits` overrides the reserved settings, standing in for a later config edit. */
function reserveMainRun(options: MainOptions = {}) {
  const root = tempDir(), repo = path.join(root, 'repo');
  const config = 'config' in options ? options.config : probeConfig;
  if (config !== undefined) {
    fs.mkdirSync(path.join(repo, 'skills/dispatch'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'skills/dispatch/config.local.jsonc'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  const workDir = path.join(repo, `.scratch/audits/${RUN}-work`);
  const settings = loadAuditConfig(DEFAULT_CONFIG_PATH);
  reserveRun(workDir, { runId: RUN, revision: 'abc', config: { ...settings, limits: { ...settings.limits, ...options.limits } } });
  if (options.previous) updateRun(workDir, (m) => { Object.assign(m.probes, options.previous); });
  return { root, repo, workDir };
}

function startMain(run: { root: string; repo: string }, options: MainOptions & { onStart?: () => void } = {}) {
  const controller = new AbortController();
  const launches: string[] = [];
  const clock = fakeClock();
  const processPort = {
    start(launch: { argv: readonly string[] }, io: { logPath: string }) {
      launches.push(launch.argv.join(' '));
      fs.writeFileSync(io.logPath, 'partial');
      options.onStart?.();
      // A hung child never settles; the abort stands in for the operator's interrupt.
      if (options.hang) { if (!options.onStart) queueMicrotask(() => controller.abort()); return { pid: 5001, done: new Promise(() => {}) }; }
      return { pid: 5001, done: Promise.resolve({ exit: 0, signal: null, stdout: 'ok', stdoutPath: io.logPath, stderrTail: '', durationMs: 5, timedOut: false, truncated: false }) };
    },
    signal() {},
  };
  const doctor = () => [
    { provider: 'claude', mode: 'cli', path: '/bin/claude', status: 'path' },
    { provider: 'claude', mode: 'desktop', path: '/apps/claude', status: 'path' },
  ];
  const done = probe.main({
    root: run.repo, home: path.join(run.root, 'home'), signal: controller.signal,
    argv: ['node', 'probe', '--run', RUN, '--only', 'claude', ...(options.modes ? ['--modes'] : []), ...(options.args ?? [])],
    ports: { doctor, process: processPort, clock, specs: { claude: fakeSpec() }, env: {}, platform: currentPlatform() },
  });
  return { done, launches, clock, controller };
}

async function quietly<T>(body: () => Promise<T>): Promise<T> {
  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try { return await body(); } finally { process.stdout.write = write; }
}

async function runMain(options: MainOptions = {}) {
  const run = reserveMainRun(options);
  return quietly(async () => {
    const { done, launches, clock } = startMain(run, options);
    const result = await done;
    const outDir = path.join(run.workDir, 'dispatch');
    return { result, launches, clock, manifest: readRun(run.workDir), summary: fs.readFileSync(path.join(outDir, 'summary.md'), 'utf8'), outDir };
  });
}

function unreadableRun(kind: 'malformed' | 'unsupported' | 'legacy') {
  const run = kind === 'legacy'
    ? (() => { const root = tempDir(), repo = path.join(root, 'repo'); return { root, repo, workDir: path.join(repo, `.scratch/audits/${RUN}-work`) }; })()
    : reserveMainRun();
  const manifestPath = path.join(run.workDir, 'manifest.json');
  if (kind === 'malformed') fs.writeFileSync(manifestPath, '{ "version": 1,');
  if (kind === 'unsupported') fs.writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')), version: 2 }));
  const capture = path.join(run.workDir, 'dispatch', 'claude.read.log');
  fs.mkdirSync(path.dirname(capture), { recursive: true });
  fs.writeFileSync(capture, 'prior evidence');
  return { run, capture };
}

for (const kind of ['malformed', 'unsupported', 'legacy'] as const) {
  test(`audit probe refuses a live probe over a ${kind} manifest without launching or touching captures`, async () => {
    const { run, capture } = unreadableRun(kind);
    await quietly(async () => {
      const { done, launches } = startMain(run);
      await assert.rejects(done, /Live probe refused/);
      assert.equal(launches.length, 0);
    });
    assert.equal(fs.readFileSync(capture, 'utf8'), 'prior evidence');
    assert.ok(!fs.existsSync(path.join(run.workDir, 'dispatch', 'started.txt')));
  });
}

test('audit probe competing invocations launch once: the second refuses while the first owns the run', async () => {
  const run = reserveMainRun();
  await quietly(async () => {
    let started!: () => void;
    const launched = new Promise<void>((resolve) => { started = resolve; });
    const first = startMain(run, { hang: true, onStart: () => started() });
    await launched;
    assert.equal(readRun(run.workDir).probes['claude']?.lifecycle, 'running');
    const second = startMain(run);
    await assert.rejects(second.done, /probe already running for this run/);
    assert.equal(second.launches.length, 0);
    first.controller.abort();
    await first.done;
    assert.equal(first.launches.length, 1);
    const manifest = readRun(run.workDir) as ReturnType<typeof readRun> & { probeOwner?: { finishedAt: string | null } };
    assert.ok(manifest.probeOwner?.finishedAt, 'owner released after the first invocation ends');
  });
});

test('audit probe claim reserves launch budget before start, so a dead owner\'s reservation is never relaunched', () => {
  const { workDir } = reserveMainRun();
  const selection = { modes: true, config: probeConfig, limits: limits() };
  const clock = fakeClock();
  const claim = probe.claimProbe(workDir, rows, selection, { clock, alive: () => true, pid: 1 });
  assert.deepEqual(claim.targets.map((t: { id: string; launchLimit: number }) => [t.id, t.launchLimit]), [['claude/cli', 1], ['claude/desktop', 0]]);
  assert.throws(() => probe.claimProbe(workDir, rows, selection, { clock, alive: () => true, pid: 2 }), /probe already running/);
  // The owner died before launching: takeover is allowed, but the reservation still spends the budget.
  const retry = probe.claimProbe(workDir, rows, selection, { clock, alive: () => false, pid: 3 });
  assert.ok(retry.targets.every((t: { launchLimit: number }) => t.launchLimit === 0));
  assert.equal(probe.priorDisposition(retry.previous['claude/cli']), 'blocked');
});

/** Runs main for one OpenCode target whose introspection never settles until the returned `settle` is called. */
async function opencodeMain(onIntrospect: (ctl: { controller: AbortController; clock: ReturnType<typeof fakeClock> }) => void) {
  const run = reserveMainRun({ config: { 'read-delegates': { opencode: { targets: [{ low: { model: 'local/m', effort: 'low' } }] } } } });
  const controller = new AbortController();
  const clock = fakeClock();
  let settle!: (value: unknown) => void;
  const pending = new Promise((resolve) => { settle = resolve; });
  const launches: string[] = [];
  let introspections = 0;
  const introspect = () => () => { introspections++; queueMicrotask(() => onIntrospect({ controller, clock })); return pending; };
  const ports = {
    doctor: () => [{ provider: 'opencode', mode: 'cli', path: '/bin/opencode', status: 'path' }],
    process: { start(launch: { argv: readonly string[] }) { launches.push(launch.argv.join(' ')); throw new Error('unexpected launch'); }, signal() {} },
    clock, specs: { opencode: SPECS.opencode }, env: {}, platform: currentPlatform(),
    introspect: { opencode: introspect }, prepare: { fetchModels: async () => [], acquireGpuLock: async () => () => {} },
  };
  const result: { interrupted: boolean } = await quietly(() => probe.main({ root: run.repo, home: path.join(run.root, 'home'), signal: controller.signal, argv: ['node', 'probe', '--run', RUN, '--only', 'opencode'], ports }));
  const manifest = readRun(run.workDir) as ReturnType<typeof readRun> & { probeOwner?: { finishedAt: string | null } };
  const lateSettle = async () => { settle(READ_ONLY_AGENTS); await new Promise((resolve) => setImmediate(resolve)); return readRun(run.workDir); };
  return { result, manifest, record: manifest.probes['opencode'], launches, introspections: () => introspections, lateSettle };
}

test('audit probe interrupted during OpenCode introspection keeps the fixture and ignores the late settlement', async () => {
  const { result, record, launches, lateSettle } = await opencodeMain(({ controller }) => controller.abort());
  assert.equal(result.interrupted, true);
  assert.equal(record?.lifecycle, 'interrupted');
  assert.equal(record?.exitConfirmed, false);
  assert.equal(record?.liveness, 'unknown');
  assert.equal(record?.cleanup, 'blocked');
  assert.ok(record?.fixturePath && fs.existsSync(record.fixturePath), 'fixture kept while introspection may be live');
  assert.deepEqual((await lateSettle()).probes['opencode'], record, 'late settlement does not overwrite the interrupted record');
  assert.equal(launches.length, 0);
});

test('audit probe times out OpenCode introspection that never settles past deadline plus grace and releases ownership', async () => {
  const { result, manifest, record, launches, introspections, lateSettle } = await opencodeMain(({ clock }) => clock.advance(70_000));
  assert.equal(result.interrupted, false);
  assert.equal(record?.lifecycle, 'timeout');
  assert.equal(record?.liveness, 'unknown');
  assert.equal(record?.exitConfirmed, false);
  assert.equal(record?.cleanup, 'blocked');
  assert.match(record?.cause ?? '', /^preparation-timeout: introspection did not settle/);
  assert.ok(record?.fixturePath && fs.existsSync(record.fixturePath), 'fixture kept while introspection may be live');
  assert.ok(manifest.probeOwner?.finishedAt, 'owner released after main resolves');
  assert.deepEqual((await lateSettle()).probes['opencode'], record, 'late settlement does not overwrite the timeout record');
  assert.equal(launches.length, 0);
  assert.equal(introspections(), 1);
});
