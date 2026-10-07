import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { currentPlatform } from '../../skills/dispatch/scripts/lib/platform.ts';
import { nodeProcess } from '../../skills/dispatch/scripts/providers/node-process.ts';
import { nodePorts } from '../../skills/dispatch/scripts/core/ports.ts';
import { DEFAULT_CONFIG_PATH, loadAuditConfig, reserveRun } from '../../.agents/skills/audit-dispatch-skills/scripts/run-state.ts';
// The .mjs helper has no declarations, so it is loaded the same untyped way as the other audit scripts.
const probe = await import(new URL('../../.agents/skills/audit-dispatch-skills/scripts/probe-dispatch.mjs', import.meta.url).href);

// Local controlled child scripts stand in for provider CLIs; installed CLIs are never launched.
const HUNG = "process.stdout.write('partial\\n'); setInterval(() => {}, 1000);";
const FLOOD = "process.stdout.write('y'.repeat(200000)); setInterval(() => {}, 1000);";

function workspace(childSource: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-probe-e2e-'));
  const child = path.join(root, 'child.mjs'); fs.writeFileSync(child, childSource);
  const spec = {
    id: 'claude', modes: [], modeCascadeOn: [], resumeCommand: () => '',
    argv: (req: { cwd: string }) => ({ argv: [process.execPath, child], stdin: null, env: {}, cwd: req.cwd }),
    parse: (out: { stdout: string }) => ({ status: 'ok', text: out.stdout, sessionId: null, resume: null }),
  };
  const fixture = probe.createFixture(path.join(root, 'repo'), { home: path.join(root, 'home') });
  const stageDir = path.join(root, 'stage'); fs.mkdirSync(stageDir);
  const limits = { ...loadAuditConfig(DEFAULT_CONFIG_PATH).limits, probeDeadlineSeconds: 1, probeTerminationGraceSeconds: 2 };
  return { root, spec, fixture, stageDir, limits };
}
const ctxFor = (w: ReturnType<typeof workspace>, processPort: unknown = nodeProcess) => ({
  fixture: w.fixture, stageDir: w.stageDir, limits: w.limits,
  ports: { process: processPort, clock: nodePorts().clock, specs: { claude: w.spec }, env: process.env, platform: currentPlatform() },
});
const target = { id: 'claude', provider: 'claude', mode: 'cli', binary: process.execPath, model: null, effort: null, sandbox: false, aliases: ['cli'], skip: null };
const killQuietly = (handle: string | null) => { try { if (handle) process.kill(Number(handle), 'SIGKILL'); } catch { /* already gone */ } };

test('audit probe terminates a hung provider at the deadline and keeps its capture', async () => {
  const w = workspace(HUNG);
  const record = await probe.runTarget(target, ctxFor(w));
  killQuietly(record.handle);
  assert.equal(record.lifecycle, 'timeout');
  assert.equal(record.liveness, 'exited');
  assert.equal(record.exitConfirmed, true);
  assert.match(fs.readFileSync(path.join(w.stageDir, record.capture), 'utf8'), /partial/);
});

test('audit probe stops an overflowing provider at the output cap', async () => {
  const w = workspace(FLOOD);
  // A generous deadline keeps a loaded machine's slow child startup from tripping the deadline before the cap.
  w.limits.probeDeadlineSeconds = 30;
  const record = await probe.runTarget(target, ctxFor(w));
  killQuietly(record.handle);
  assert.equal(record.cause, 'output-cap');
  assert.ok(fs.statSync(path.join(w.stageDir, record.capture)).size <= 16_384);
});

test('audit probe reports an unconfirmed exit and preserves the fixture when the child survives termination', async () => {
  const w = workspace(HUNG);
  // Ignores every termination request so the child outlives the grace period.
  const deaf = {
    start: (launch: { argv: readonly string[] }, io: { logPath: string; capBytes: number }) => (io.logPath.endsWith('.kill')
      ? { pid: -1, done: new Promise(() => {}) }
      : nodeProcess.start(launch as never, io)),
    signal: () => {},
  };
  const record = await probe.runTarget(target, { ...ctxFor(w, deaf), limits: { ...w.limits, probeTerminationGraceSeconds: 1 } });
  try {
    assert.equal(record.liveness, 'unknown');
    assert.equal(record.exitConfirmed, false);
    assert.ok(record.handle);
    assert.equal(probe.cleanupFixture(w.fixture, [record]), 'blocked');
    assert.ok(fs.existsSync(w.fixture.dir));
  } finally { killQuietly(record.handle); }
});

test('audit probe interruption preserves partial captures and the fixture', async () => {
  const w = workspace(HUNG);
  const repo = path.join(w.root, 'repo');
  // A configured low-level model is required since unconfigured providers are skipped without launching.
  fs.mkdirSync(path.join(repo, 'skills/dispatch'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'skills/dispatch/config.local.jsonc'), JSON.stringify({ 'read-delegates': { claude: { targets: [{ low: { model: 'm' } }] } } }));
  // Live probes require a reserved run manifest.
  const settings = loadAuditConfig();
  reserveRun(path.join(repo, '.scratch/audits/2026-10-07-0000-work'), { runId: '2026-10-07-0000', revision: 'abc', config: { ...settings, limits: { ...settings.limits, ...w.limits, probeDeadlineSeconds: 30 } } });
  const controller = new AbortController();
  const doctor = () => [{ provider: 'claude', mode: 'cli', path: process.execPath, status: 'path' }];
  const run = probe.main({
    root: repo, argv: ['node', 'probe', '--run', '2026-10-07-0000', '--only', 'claude'], signal: controller.signal, home: path.join(w.root, 'home'),
    limits: { ...w.limits, probeDeadlineSeconds: 30 },
    ports: { doctor, process: nodeProcess, clock: nodePorts().clock, specs: { claude: w.spec }, env: process.env, platform: currentPlatform() },
  });
  setTimeout(() => controller.abort(), 1500);
  const result = await run;
  const out = path.join(repo, '.scratch/audits/2026-10-07-0000-work/dispatch');
  const live = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')).live;
  for (const record of live) killQuietly(record.handle);
  assert.equal(result.interrupted, true);
  assert.equal(live[0].lifecycle, 'interrupted');
  assert.match(fs.readFileSync(path.join(out, live[0].capture), 'utf8'), /partial/);
  assert.equal(live[0].cleanup, 'blocked');
  assert.ok(fs.readdirSync(path.join(w.root, 'home')).some((name) => name.startsWith('.dispatch-audit-probe-')));
});
