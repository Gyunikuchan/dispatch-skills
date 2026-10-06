import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { fixture, until } from '../helpers/e2e.ts';
import { recordedLaunches } from '../helpers/stub-provider.ts';

test('SC6: enabled concurrent runs preserve both histories and current session report links', async () => {
  const f = fixture({ responses: ['dispatch evidence'] });
  try {
    fs.writeFileSync(path.join(f.skill, 'config.local.jsonc'), JSON.stringify({ ...f.config, diagnostics: true }));
    const session = await f.initialize();
    const frames = await Promise.all([f.begin('ask', session, 'first'), f.begin('ask', session, 'second')]);
    const report = path.join(session, 'diagnostics.md');
    // A contended render retries only at the next normal send boundary.
    const resumed = await f.cli(['send', '--run', frames[0]!.run]);
    const text = fs.readFileSync(report, 'utf8');
    assert.match(text, /Run 001/); assert.match(text, /Run 002/);
    assert.equal(f.launches().length, 2);
    assert.equal((resumed.data['diagnostics'] as { path: string }).path, report.replaceAll('\\', '/'));
    for (const frame of frames) {
      const link = frame.data['diagnostics'] as { path?: string; unavailable?: boolean };
      assert.ok(link.unavailable || link.path === report.replaceAll('\\', '/'));
    }
    await f.cli(['session', 'reactivate', '--session-dir', session]);
    assert.equal(fs.existsSync(report), true);
  } finally { f.cleanup(); }
});

test('SC6: status and dry-run preserve report bytes and resumed invocation totals', async () => {
  const f = fixture({ responses: ['dispatch evidence'] });
  try {
    fs.writeFileSync(path.join(f.skill, 'config.local.jsonc'), JSON.stringify({ ...f.config, diagnostics: true }));
    const session = await f.initialize(), frame = await f.begin('ask', session, 'fixture');
    const report = path.join(session, 'diagnostics.md'), before = fs.readFileSync(report);
    await f.cli(['status', '--run', frame.run]);
    await f.cli(['send', '--run', frame.run, '--dry-run']);
    assert.deepEqual(fs.readFileSync(report), before);
    await f.cli(['send', '--run', frame.run]);
    assert.match(fs.readFileSync(report, 'utf8'), /0\/1 CLI invocations covered/);
    assert.equal(f.launches().length, 1);
  } finally { f.cleanup(); }
});

test('SC5: CLI refresh preserves filtered delegates while enforcing original topology', async () => {
  const f = fixture();
  try {
    const config = { ...f.config, 'read-delegates': { ...f.config['read-delegates'], claude: { nativeSubagentsOnly: true, targets: [{ low: { model: 'unused', effort: 'medium' } }] } } };
    const file = path.join(f.skill, 'config.local.jsonc');
    fs.writeFileSync(file, JSON.stringify(config));
    const session = await f.initialize(), frame = await f.begin('plan', session, 'Fixture'), run = f.absoluteRun(frame.run);
    const before = fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8');
    assert.doesNotMatch(before, /nativeSubagentsOnly/);
    const next = { ...config, 'read-delegates': { ...config['read-delegates'], opencode: { ...config['read-delegates'].opencode, targets: [{ low: { model: 'second' } }] } } };
    fs.writeFileSync(file, JSON.stringify(next));
    const dry = await f.cli(['send', '--run', run, '--refresh-config', '--dry-run']);
    assert.equal(dry.error, undefined, JSON.stringify(dry));
    assert.equal(fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8'), before);
    const refreshed = await f.cli(['send', '--run', run, '--refresh-config']);
    assert.equal(refreshed.error, undefined, JSON.stringify(refreshed));
    const journal = fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8');
    assert.match(journal, /EXECUTION_CONFIG_UPDATED.*second/);
    assert.doesNotMatch(journal, /nativeSubagentsOnly/);
    fs.writeFileSync(file, JSON.stringify({ ...next, 'read-delegates': { ...next['read-delegates'], claude: { ...next['read-delegates'].claude, nativeSubagentsOnly: false } } }));
    const rejected = await f.cli(['send', '--run', run, '--refresh-config']);
    assert.match(rejected.error ?? '', /execution-config-topology/);
    assert.equal(fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8'), journal);
  } finally { f.cleanup(); }
});
test('concurrent provider stubs preserve every launch and allocate distinct response indexes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-stub-concurrency-'));
  const file = path.join(dir, 'scenario.json'), count = 12;
  const scenario = JSON.stringify({ responses: Array.from({ length: count }, (_, index) => `response-${index}`) });
  fs.writeFileSync(file, scenario);
  try {
    const script = fileURLToPath(new URL('../helpers/stub-provider.ts', import.meta.url));
    const results = await Promise.all(Array.from({ length: count }, (_, index) => new Promise<string>((resolve, reject) => {
      execFile(process.execPath, [script, file, `prompt-${index}`], { env: { ...process.env, NODE_OPTIONS: '', NODE_TEST_CONTEXT: '' }, timeout: 10_000, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
    })));
    const launches = recordedLaunches(file);
    assert.equal(launches.length, count);
    assert.deepEqual(launches.map((row) => row.index), Array.from({ length: count }, (_, index) => index));
    assert.equal(new Set(launches.map((row) => row.pid)).size, count);
    assert.deepEqual(launches.map((row) => row.prompt).sort(), Array.from({ length: count }, (_, index) => `prompt-${index}`).sort());
    assert.deepEqual(results.sort(), Array.from({ length: count }, (_, index) => `response-${index}`).sort());
    assert.equal(fs.readFileSync(file, 'utf8'), scenario);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('killed send leaves a live detached worker; status, dry-run and resume reattach without duplicate launches', async () => {
  const f = fixture({ delayMs: 1800, responses: ['Evidence from src/a.ts:L1: value is defined.'] });
  try {
    const session = await f.initialize();
    const pending = f.launch(['start', 'ask', '--session-dir', session, '--orchestrator', 'codex', '--level', 'low', '--', 'What value is defined?']);
    await until(() => f.launches().length === 1);
    const runs = path.join(session, '.state/runs'), run = path.join(runs, fs.readdirSync(runs)[0]!);
    pending.child.kill('SIGKILL'); await pending.done;
    const journal = fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8');
    fs.writeFileSync(path.join(run, 'unrelated.claim.json'), 'not a worker claim');
    const status = await f.cli(['status', '--run', run]); assert.ok(JSON.stringify(status.progress).includes('live'));
    assert.ok(!JSON.stringify(status.progress).includes('unrelated'));
    await f.cli(['send', '--run', run, '--dry-run']); assert.equal(fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8'), journal);
    const done = await f.cli(['send', '--run', run]); assert.equal(done.await, 'done'); assert.equal(done.data['outcome'], 'complete'); assert.equal(f.launches().length, 1);
    const lines = fs.readFileSync(path.join(done.run, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { type: string });
    assert.equal(lines.filter((line) => line.type === 'WAVE_DONE').length, 1);
    fs.rmSync(String(done.data['handoff']), { recursive: true, force: true });
  } finally { f.cleanup(); }
});
test('effect folder: the CLI waits for a worker whose claim and heartbeat sit in its effect folder, and status reports it', async () => {
  const f = fixture({ delayMs: 1800, responses: ['Evidence from src/a.ts:L1: value is defined.'] });
  try {
    const session = await f.initialize();
    const pending = f.launch(['start', 'ask', '--session-dir', session, '--orchestrator', 'codex', '--level', 'low', '--', 'What value is defined?']);
    await until(() => f.launches().length === 1);
    const runs = path.join(session, '.state/runs'), run = path.join(runs, fs.readdirSync(runs)[0]!);
    const effect = fs.readdirSync(run).find((name) => fs.existsSync(path.join(run, name, 'claim.json')))!;
    assert.ok(effect, 'a wave effect folder holds the first-attempt claim');
    await until(() => fs.existsSync(path.join(run, effect, 'heartbeat.json')));
    assert.deepEqual(fs.readdirSync(run).filter((name) => /claim|heartbeat/.test(name)), []);
    const status = await f.cli(['status', '--run', run]);
    assert.ok(JSON.stringify(status.progress).includes(effect) && JSON.stringify(status.progress).includes('live'));
    const done = await pending.done; assert.equal(done.exit, 0);
    assert.equal(JSON.parse(done.stdout).await, 'done'); assert.equal(f.launches().length, 1);
  } finally { f.cleanup(); }
});
test('doctor reports real discovery through provider shim, injected config, Node version and sandbox support', async () => {
  const f = fixture();
  try {
    const report = await f.cli(['doctor', '--level', 'low', '--json']) as unknown as { node: string; configPath: string; probes: { provider: string; status: string; path: string | null }[] };
    assert.equal(report.node, process.version); assert.equal(report.configPath, path.join(f.skill, 'config.local.jsonc'));
    assert.ok(report.probes.some((row) => row.provider === 'opencode' && row.status === 'path' && row.path?.startsWith(path.join(f.dir, 'bin'))));
    assert.equal(f.launches().length, 0);
  } finally { f.cleanup(); }
});
test('public CLI preserves usage/rejection/fault/lock exits, fallback session identity and idempotent reactivation', async () => {
  const f = fixture();
  try {
    const first = await f.cli(['session', 'init', '--objective', 'Fallback session']);
    const same = await f.cli(['session', 'init', '--session-id', first.sessionId, '--objective', 'Different title']); assert.equal(same.sessionDir, first.sessionDir);
    const active = await f.cli(['session', 'reactivate', '--session-dir', same.sessionDir]); assert.equal(active.sessionDir, same.sessionDir); assert.ok(fs.existsSync(active.sessionDir));
    const frame = await f.begin('plan', active.sessionDir, 'Normalize values'), run = f.absoluteRun(frame.run), journal = path.join(run, 'events.jsonl');
    assert.equal(frame.await, 'author'); const before = fs.readFileSync(journal, 'utf8');
    const rejected = await f.reply(run, { type: 'ARTIFACT_READY', path: 'bad' }); assert.match(rejected.error ?? '', /AUTHORED/); assert.equal(fs.readFileSync(journal, 'utf8'), before);
    fs.writeFileSync(path.join(run, 'lock'), JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() }));
    await f.cli(['send', '--run', run, '--dry-run']); assert.equal(fs.readFileSync(journal, 'utf8'), before);
    const locked = await f.launch(['send', '--run', run]).done; assert.equal(locked.exit, 3); assert.equal(locked.stdout, ''); assert.match(locked.stderr, /live pid/);
    fs.unlinkSync(path.join(run, 'lock'));
    const usage = await f.launch(['start', 'plan', '--session-dir', active.sessionDir, '--orchestrator', 'codex']).done; assert.equal(usage.exit, 1); assert.equal(usage.stdout, '');
    fs.appendFileSync(journal, '{"seq":2,"v":9,"at":"now","type":"AUTHORED","data":{"path":"x"}}\n');
    const fault = await f.launch(['status', '--run', run]).done; assert.equal(fault.exit, 2); assert.equal(fault.stdout.trim().split('\n').length, 1); assert.equal(JSON.parse(fault.stdout).data.outcome, 'fault');
  } finally { f.cleanup(); }
});
