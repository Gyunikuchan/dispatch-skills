import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../helpers/fake-ports.ts';
import { currentPlatform } from '../../skills/dispatch/scripts/lib/platform.ts';
import { DEFAULT_CONFIG_PATH, loadAuditConfig, readRun, reserveRun, updateRun, type LimitName, type ProbeRecord } from '../../.agents/skills/audit-dispatch-skills/scripts/run-state.ts';
// The .mjs helper has no declarations, so it is loaded the same untyped way as the other audit scripts.
const probe = await import(new URL('../../.agents/skills/audit-dispatch-skills/scripts/probe-dispatch.mjs', import.meta.url).href);

// SECTION: Fakes

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

// SECTION: Selection

const RUN = '2026-10-07-0000';
const probeConfig = { 'read-delegates': { claude: { targets: [{ low: { model: 'small-model', effort: 'low' } }] } } };

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

test('audit probe skips launch and records cause when dispatch config is missing or invalid', async () => {
  const cases = [
    { config: '[1, 2]', pattern: /no usable dispatch config: .*must be a JSON object/, summaryPattern: /Dispatch config unusable: .*must be a JSON object/ },
    { config: undefined, pattern: /no usable dispatch config: Config file not found/, summaryPattern: null },
  ];
  for (const c of cases) {
    const { launches, result, summary } = await runMain({ config: c.config });
    assert.equal(launches.length, 0);
    assert.equal(result.live[0].lifecycle, 'skipped');
    assert.match(result.live[0].cause, c.pattern);
    if (c.summaryPattern) assert.match(summary, c.summaryPattern);
  }
});

test('audit probe records capture and fixture paths that exist after preservation', async () => {
  const done = await runMain();
  const record = done.manifest.probes['claude'];
  assert.equal(record?.capturePath, path.join(done.outDir, 'claude.read.log').split(path.sep).join('/'));
  assert.ok(fs.existsSync(record!.capturePath!));
  assert.ok(record?.fixturePath && record.cleanup === 'complete');
  const hung = await runMain({ hang: true });
  const interrupted = hung.manifest.probes['claude'];
  assert.equal(hung.result.interrupted, true);
  assert.equal(interrupted?.cleanup, 'blocked');
  assert.ok(interrupted?.capturePath && fs.existsSync(interrupted.capturePath), 'staged capture kept while the child may be live');
  assert.ok(interrupted?.fixturePath && fs.existsSync(interrupted.fixturePath));
});

test('audit probe enforces the reserved run limits after the audit config changes', async () => {
  await assert.rejects(runMain({ limits: { probeDeadlineSeconds: 30 }, args: ['--timeout', '45'] }), /--timeout 45 exceeds probeDeadlineSeconds=30/);
  const { launches, clock } = await runMain({ limits: { probeDeadlineSeconds: 30, probeTerminationGraceSeconds: 5 } });
  assert.equal(launches.length, 1);
  assert.ok(clock.timers.some((t) => t.at - 1_000_000 === 35_000), 'recorded 30 s deadline plus 5 s grace bounds the launch');
});
