import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../helpers/fake-ports.ts';
import { currentPlatform } from '../../skills/dispatch/scripts/lib/platform.ts';
import { loadAuditConfig, readRun, reserveRun, updateRun, type ProbeRecord } from '../../.agents/skills/audit-dispatch-skills/scripts/run-state.ts';
const probe = await import(new URL('../../.agents/skills/audit-dispatch-skills/scripts/probe-dispatch.mjs', import.meta.url).href);
const RUN = '2026-10-07-0000';
const priorRecord = (extra: Partial<ProbeRecord> = {}): ProbeRecord => ({
  lifecycle: 'complete', host: 'h', handle: '41', liveness: 'exited', startedAt: '2026-10-07T00:00:00.000Z', deadlineAt: '2026-10-07T00:01:00.000Z',
  attempts: 1, exitConfirmed: true, capturePath: null, fixturePath: null, outcome: 'pass', cause: null, cleanup: 'complete', ...extra,
});

async function runMain(options: { previous?: Record<string, ProbeRecord>; hang?: boolean; cleanupFs?: Pick<typeof fs, 'rmSync'> } = {}) {
  const root = tempDir(), repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'skills/dispatch'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'skills/dispatch/config.local.jsonc'), JSON.stringify({ 'read-delegates': { claude: { targets: [{ low: { model: 'small-model', effort: 'low' } }] } } }));
  const workDir = path.join(repo, `.scratch/audits/${RUN}-work`);
  reserveRun(workDir, { runId: RUN, revision: 'abc', config: loadAuditConfig() });
  if (options.previous) updateRun(workDir, (m) => { Object.assign(m.probes, options.previous); });
  const launches: string[] = [], controller = new AbortController();
  const processPort = {
    start(launch: { argv: readonly string[] }, io: { logPath: string }) {
      launches.push(launch.argv.join(' '));
      fs.writeFileSync(io.logPath, 'partial');
      if (options.hang) { queueMicrotask(() => controller.abort()); return { pid: 5001, done: new Promise(() => {}) }; }
      return { pid: 5001, done: Promise.resolve({ exit: 0, signal: null, stdout: 'ok', stdoutPath: io.logPath, stderrTail: '', durationMs: 5, timedOut: false, truncated: false }) };
    },
    signal() {},
  };
  const spec = {
    id: 'claude', modes: [], modeCascadeOn: [], resumeCommand: () => '',
    argv: (req: { prompt: string; cwd: string }) => ({ argv: ['fake-cli', req.prompt], stdin: null, env: {}, cwd: req.cwd }),
    parse: (out: { exit: number | null; stdout: string }) => ({ status: 'ok', text: out.stdout, sessionId: null, resume: null }),
  };
  const originalWrite = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const result = await probe.main({
      root: repo, home: path.join(root, 'home'), signal: controller.signal,
      argv: ['node', 'probe', '--run', RUN, '--only', 'claude'],
      ports: {
        doctor: () => [{ provider: 'claude', mode: 'cli', path: '/bin/claude', status: 'path' }],
        process: processPort, clock: { now: () => 1_000_000, every: () => () => {} },
        specs: { claude: spec }, env: {}, platform: currentPlatform(), cleanupFs: options.cleanupFs,
      },
    });
    const outDir = path.join(workDir, 'dispatch');
    return { manifest: readRun(workDir), result, launches, summary: fs.readFileSync(path.join(outDir, 'summary.md'), 'utf8'), outDir };
  } finally { process.stdout.write = originalWrite; }
}
test('probe cleanup reason: main persists filesystem failure across evidence surfaces', async () => {
  const cleanupFs = { rmSync: () => { throw Object.assign(new Error('private path details'), { code: 'EBUSY' }); } };
  const { manifest, summary, outDir } = await runMain({ cleanupFs });
  const expected = { code: 'filesystem-error', errorCode: 'EBUSY' };
  assert.equal(manifest.probes['claude']?.cleanup, 'blocked');
  assert.deepEqual(manifest.probes['claude']?.cleanupReason, expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'results.json'), 'utf8')).live[0].cleanupReason, expected);
  assert.match(summary, /filesystem-error: EBUSY/);
  assert.doesNotMatch(summary, /private path details/);
  assert.ok(fs.existsSync(manifest.probes['claude']!.fixturePath!));
});

test('probe cleanup reason: main records unconfirmed exit without removal', async () => {
  let calls = 0;
  const { manifest, summary, outDir } = await runMain({ hang: true, cleanupFs: { rmSync: () => { calls++; } } });
  const expected = { code: 'exit-unconfirmed' };
  assert.equal(calls, 0);
  assert.deepEqual(manifest.probes['claude']?.cleanupReason, expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'results.json'), 'utf8')).live[0].cleanupReason, expected);
  assert.match(summary, /exit-unconfirmed/);
  assert.ok(fs.existsSync(manifest.probes['claude']!.fixturePath!));
});

test('probe cleanup reason: main success clears the reason and removes the fixture', async () => {
  const { manifest, outDir } = await runMain();
  assert.equal(manifest.probes['claude']?.cleanup, 'complete');
  assert.equal(manifest.probes['claude']?.cleanupReason, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, 'results.json'), 'utf8')).live[0].cleanupReason, null);
  assert.equal(fs.existsSync(manifest.probes['claude']!.fixturePath!), false);
});

test('probe cleanup reason: resume retains prior reason and fixture identity', async () => {
  const expected = { code: 'filesystem-error' as const, errorCode: 'EPERM' };
  const previous = priorRecord({ cleanup: 'blocked', cleanupReason: expected, fixturePath: '/prior-fixture', capturePath: '/prior-capture' });
  const { manifest, result, launches, summary, outDir } = await runMain({ previous: { claude: previous } });
  assert.equal(launches.length, 0);
  assert.deepEqual(manifest.probes['claude']?.cleanupReason, expected);
  assert.equal(manifest.probes['claude']?.cleanup, 'blocked');
  assert.equal(manifest.probes['claude']?.fixturePath, previous.fixturePath);
  assert.equal(manifest.probes['claude']?.capturePath, previous.capturePath);
  assert.deepEqual(result.live[0].cleanupReason, expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'results.json'), 'utf8')).live[0].cleanupReason, expected);
  assert.match(summary, /filesystem-error: EPERM/);
});
