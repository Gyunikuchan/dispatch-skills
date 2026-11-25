import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../helpers/fake-ports.ts';
import { loadProbe } from '../helpers/audit-probe.ts';
import { currentPlatform } from '../../skills/dispatch/scripts/lib/platform.ts';
import {
  DEFAULT_CONFIG_PATH,
  loadAuditConfig,
  readRun,
  reserveRun,
  updateRun,
} from '../../.agents/skills/audit-dispatch-skills/scripts/run-state.ts';
import type { LimitName, ProbeRecord } from '../../.agents/skills/audit-dispatch-skills/scripts/run-state.ts';
const probe = await loadProbe();

// SECTION: Fakes

function fakeClock() {
  let t = 1_000_000;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  return {
    timers,
    now: () => t,
    every(ms: number, fn: () => void) {
      const timer = { at: t + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    advance(ms: number) {
      t += ms;
      for (const timer of timers) {
        if (timer.live && timer.at <= t) {
          timer.live = false;
          timer.fn();
        }
      }
    },
  };
}

type SpecOverrides = { argv?: unknown; parse?: unknown; prepare?: unknown; modes?: unknown; modeCascadeOn?: unknown };

function fakeSpec(extra: SpecOverrides = {}) {
  return {
    id: 'claude',
    modes: [],
    modeCascadeOn: [],
    resumeCommand: () => '',
    argv: (req: { prompt: string; cwd: string }) => ({
      argv: ['fake-cli', req.prompt],
      stdin: null,
      env: {},
      cwd: req.cwd,
    }),
    parse: (out: { exit: number | null; stdout: string }) =>
      out.exit === 0
        ? { status: 'ok', text: out.stdout, sessionId: null, resume: null }
        : { status: 'fail', cls: 'model-not-found', detail: 'effort rejected', retryWithoutEffort: true },
    ...extra,
  };
}

// SECTION: Selection

const RUN = '2026-10-07-0000';
const probeConfig = { 'read-delegates': { claude: { targets: [{ low: { model: 'small-model', effort: 'low' } }] } } };

const priorRecord = (extra: Partial<ProbeRecord> = {}): ProbeRecord => ({
  lifecycle: 'complete',
  host: 'h',
  handle: '41',
  liveness: 'exited',
  startedAt: '2026-10-07T00:00:00.000Z',
  deadlineAt: '2026-10-07T00:01:00.000Z',
  attempts: 1,
  exitConfirmed: true,
  capturePath: null,
  fixturePath: null,
  outcome: 'pass',
  cause: null,
  cleanup: 'complete',
  ...extra,
});

type MainOptions = {
  config?: unknown;
  previous?: Record<string, ProbeRecord>;
  modes?: boolean;
  hang?: boolean;
  limits?: Partial<Record<LimitName, number>>;
  args?: Array<string>;
};

/** Reserves a run in a fresh repo; `limits` overrides the reserved settings, standing in for a later config edit. */
function reserveMainRun(options: MainOptions = {}) {
  const root = tempDir(),
    repo = path.join(root, 'repo');
  const config = 'config' in options ? options.config : probeConfig;
  if (config !== undefined) {
    fs.mkdirSync(path.join(repo, 'skills/dispatch'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'skills/dispatch/config.local.jsonc'),
      typeof config === 'string' ? config : JSON.stringify(config),
    );
  }
  const workDir = path.join(repo, `.scratch/audits/${RUN}-work`);
  const settings = loadAuditConfig(DEFAULT_CONFIG_PATH);
  reserveRun(workDir, {
    runId: RUN,
    revision: 'abc',
    config: { ...settings, limits: { ...settings.limits, ...options.limits } },
  });
  if (options.previous) {
    updateRun(workDir, (m) => {
      Object.assign(m.probes, options.previous);
    });
  }
  return { root, repo, workDir };
}

const doctor = () => [
  { provider: 'claude', mode: 'cli', path: '/bin/claude', status: 'path' },
  { provider: 'claude', mode: 'desktop', path: '/apps/claude', status: 'path' },
];

function startMain(run: { root: string; repo: string }, options: MainOptions & { onStart?: () => void } = {}) {
  const controller = new AbortController();
  const launches: Array<string> = [];
  const clock = fakeClock();
  const processPort = {
    start(launch: { argv: ReadonlyArray<string> }, io: { logPath: string }) {
      launches.push(launch.argv.join(' '));
      fs.writeFileSync(io.logPath, 'partial');
      options.onStart?.();
      // A hung child never settles; the abort stands in for the operator's interrupt.
      if (options.hang) {
        if (!options.onStart) {
          queueMicrotask(() => controller.abort());
        }
        return { pid: 5001, done: new Promise(() => {}) };
      }
      return {
        pid: 5001,
        done: Promise.resolve({
          exit: 0,
          signal: null,
          stdout: 'ok',
          stdoutPath: io.logPath,
          stderrTail: '',
          durationMs: 5,
          timedOut: false,
          truncated: false,
        }),
      };
    },
    signal() {},
  };
  const done = probe.main({
    root: run.repo,
    home: path.join(run.root, 'home'),
    signal: controller.signal,
    argv: [
      'node',
      'probe',
      '--run',
      RUN,
      '--only',
      'claude',
      ...(options.modes ? ['--modes'] : []),
      ...(options.args ?? []),
    ],
    ports: {
      writeSummary() {},
      doctor,
      process: processPort,
      clock,
      specs: { claude: fakeSpec() },
      env: {},
      platform: currentPlatform(),
    },
  });
  return { done, launches, clock, controller };
}

async function runMain(options: MainOptions = {}) {
  const run = reserveMainRun(options);
  const { done, launches, clock } = startMain(run, options);
  const result = await done;
  const outDir = path.join(run.workDir, 'dispatch');
  return {
    result,
    launches,
    clock,
    manifest: readRun(run.workDir),
    summary: fs.readFileSync(path.join(outDir, 'summary.md'), 'utf8'),
    outDir,
  };
}

test('audit probe resume reuses completed target evidence without relaunching', async () => {
  const { launches, result, manifest } = await runMain({ previous: { claude: priorRecord() } });
  assert.equal(launches.length, 0);
  assert.equal(result.live[0]!.lifecycle, 'complete');
  assert.ok(result.live[0]!.gaps.includes('reused recorded evidence; not relaunched'));
  assert.equal(manifest.probes['claude']?.attempts, 1);
  assert.equal(manifest.probes['claude']?.outcome, 'pass');
});

test('audit probe resume blocks a terminal prior launch whose exit is unconfirmed', async () => {
  const { launches, result, manifest } = await runMain({
    previous: {
      claude: priorRecord({
        lifecycle: 'timeout',
        liveness: 'unknown',
        exitConfirmed: false,
        outcome: null,
        cause: 'deadline',
        cleanup: 'blocked',
      }),
    },
  });
  assert.equal(launches.length, 0);
  assert.equal(result.live[0]!.liveness, 'unknown');
  assert.match(result.live[0]!.cause, /no confirmed exit; not relaunched/);
  assert.equal(manifest.probes['claude']?.exitConfirmed, false);
  assert.equal(manifest.probes['claude']?.lifecycle, 'timeout');
  assert.equal(manifest.probes['claude']?.cleanup, 'blocked');
});

test('audit probe resume with --modes spends the remaining per-provider launch budget only', async () => {
  const { launches, result } = await runMain({
    modes: true,
    previous: { claude: priorRecord({ lifecycle: 'failed', outcome: 'auth', cause: 'auth' }) },
  });
  assert.equal(launches.length, 0);
  assert.deepEqual(
    result.live.map((r: { id: string; lifecycle: string }) => [r.id, r.lifecycle]),
    [
      ['claude/cli', 'skipped'],
      ['claude/desktop', 'skipped'],
    ],
  );
  for (const record of result.live) {
    assert.match(record.cause, /probeLaunchesPerProvider=1 already spent by 1 recorded launch/);
  }
});

test('audit probe launches the closest configured model and effort and records configured versus applied', async () => {
  const config = {
    'read-delegates': {
      claude: { targets: [{ low: { effort: 'low' }, high: { model: 'big-model', effort: 'high' } }] },
    },
  };
  assert.deepEqual(probe.selectModel(config, 'claude'), {
    configured: { level: 'low', model: null, effort: 'low' },
    applied: { model: 'big-model', effort: 'low', modelLevel: 'high', effortLevel: 'low' },
    fallback: true,
  });
  const { launches, manifest, summary } = await runMain({ config });
  assert.equal(launches.length, 1);
  assert.equal(manifest.probes['claude']?.model?.applied.model, 'big-model');
  assert.equal(manifest.probes['claude']?.model?.configured.model, null);
  assert.match(summary, /model big-model\/low applied \(closest to configured low: none\/low\)/);
});
