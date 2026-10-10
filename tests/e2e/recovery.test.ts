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
    for (const frame of frames) { assert.equal(frame.await, 'retro', JSON.stringify(frame)); assert.deepEqual(Object.keys(frame.data['diagnostics'] as object), ['instruction']); }
    assert.equal(fs.existsSync(report), false, 'the report waits for a run end');
    // Each run end renders every session journal under its own run lock, so the later render holds both runs.
    for (const frame of frames) {
      const done = await f.reply(frame.run, { type: 'RETRO', observations: [] });
      assert.equal(done.await, 'done', JSON.stringify(done)); assert.equal(done.data['diagnostics'], undefined, 'a clean run with RETRO [] has no findings');
    }
    const text = fs.readFileSync(report, 'utf8');
    assert.match(text, /- Runs: 2 · /); assert.match(text, /\| 1 · ask · low \|/); assert.match(text, /\| 2 · ask · low \|/);
    assert.equal(f.launches().length, 2);
    await f.cli(['session', 'reactivate', '--session-dir', session]);
    assert.equal(fs.existsSync(report), true);
  } finally { f.cleanup(); }
});

test('SC6: status and dry-run preserve report bytes and resumed invocation totals', async () => {
  const f = fixture({ responses: ['dispatch evidence'] });
  try {
    fs.writeFileSync(path.join(f.skill, 'config.local.jsonc'), JSON.stringify({ ...f.config, diagnostics: true }));
    const session = await f.initialize(), frame = await f.begin('ask', session, 'fixture');
    const report = path.join(session, 'diagnostics.md');
    assert.equal(frame.await, 'retro', JSON.stringify(frame));
    for (const read of [await f.cli(['status', '--run', frame.run]), await f.cli(['send', '--run', frame.run, '--dry-run'])]) {
      assert.equal(read.await, 'retro'); assert.deepEqual(Object.keys(read.data['diagnostics'] as object), ['instruction']);
    }
    assert.equal(fs.existsSync(report), false, 'status and dry-run keep the retro await and write no report');
    assert.equal((await f.reply(frame.run, { type: 'RETRO', observations: [] })).await, 'done');
    assert.match(fs.readFileSync(report, 'utf8'), /\| opencode \| all models \| — \| — \| — \| — \| 0\/1 \|/);
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
    const rejected = await f.reply(run, { type: 'ARTIFACT_READY', path: 'bad' }); assert.match(rejected.error ?? '', /AUTHORED/); assert.equal(rejected.reply, frame.reply);
    // A rejection keeps the operational prefix and appends one diagnostics note, which never moves the reply boundary.
    const after = fs.readFileSync(journal, 'utf8'); assert.ok(after.startsWith(before));
    const notes = after.slice(before.length).trim().split('\n').map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
    assert.deepEqual(notes.map((note) => [note.type, note.data['kind'], note.data['eventType']]), [['DIAGNOSTIC_NOTE', 'event-rejected', 'ARTIFACT_READY']]);
    fs.writeFileSync(path.join(run, 'lock'), JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() }));
    await f.cli(['send', '--run', run, '--dry-run']); assert.equal(fs.readFileSync(journal, 'utf8'), after);
    const locked = await f.launch(['send', '--run', run]).done; assert.equal(locked.exit, 3); assert.equal(locked.stdout, ''); assert.match(locked.stderr, /live pid/);
    fs.unlinkSync(path.join(run, 'lock'));
    const usage = await f.launch(['start', 'plan', '--session-dir', active.sessionDir, '--orchestrator', 'codex']).done; assert.equal(usage.exit, 1); assert.equal(usage.stdout, '');
    fs.appendFileSync(journal, '{"seq":3,"v":9,"at":"now","type":"AUTHORED","data":{"path":"x"}}\n');
    const fault = await f.launch(['status', '--run', run]).done; assert.equal(fault.exit, 2); assert.equal(fault.stdout.trim().split('\n').length, 1); assert.equal(JSON.parse(fault.stdout).data.outcome, 'fault');
  } finally { f.cleanup(); }
});

test('dry-run verdict: CLI prints one verdict line, exits 0 or 1, and leaves the journal unchanged', async () => {
  const f = fixture();
  try {
    const session = await f.initialize(), frame = await f.begin('plan', session, 'Fixture'), run = f.absoluteRun(frame.run);
    assert.equal(frame.await, 'author', JSON.stringify(frame));
    const journal = path.join(run, 'events.jsonl'), before = fs.readFileSync(journal);
    const check = async (event: unknown) => {
      const file = path.join(f.dir, 'dry-run.event.json'); fs.writeFileSync(file, JSON.stringify(event));
      return f.launch(['send', '--run', run, '--event', `@${file}`, '--dry-run']).done;
    };
    const valid = await check({ type: 'AUTHORED', path: frame.data['path'] });
    assert.deepEqual([valid.exit, valid.stdout], [0, '{"v":1,"valid":true}\n'], valid.stderr);
    const invalid = await check({ type: 'AUTHORED' });
    assert.equal(invalid.exit, 1, invalid.stderr);
    assert.deepEqual(JSON.parse(invalid.stdout), { v: 1, valid: false, error: 'event.path: expected non-empty string, got nothing' });
    assert.equal(invalid.stdout.trim().split('\n').length, 1);
    assert.deepEqual(fs.readFileSync(journal), before);
  } finally { f.cleanup(); }
});

test('missing event file exits 1 with a usage error naming the path', async () => {
  const f = fixture();
  try {
    const session = await f.initialize(), frame = await f.begin('plan', session, 'Fixture'), run = f.absoluteRun(frame.run);
    const journal = path.join(run, 'events.jsonl'), before = fs.readFileSync(journal), missing = path.join(f.dir, 'missing.json');
    const result = await f.launch(['send', '--run', run, '--event', `@${missing}`]).done;
    assert.deepEqual([result.exit, result.stdout], [1, ''], result.stderr);
    assert.ok(result.stderr.includes(missing), result.stderr); assert.match(result.stderr, /copy one object from frame events/);
    assert.deepEqual(fs.readFileSync(journal), before);
  } finally { f.cleanup(); }
});

const authorFrame = async (f: ReturnType<typeof fixture>) => {
  const session = await f.initialize(), frame = await f.begin('plan', session, 'Fixture'), run = f.absoluteRun(frame.run);
  assert.equal(frame.await, 'author', JSON.stringify(frame));
  return { frame, run, file: path.join(f.dir, 'array.event.json'), event: { type: 'AUTHORED', path: frame.data['path'] } };
};

test('event array of one is accepted', async () => {
  const f = fixture();
  try {
    const { run, file, event } = await authorFrame(f);
    fs.writeFileSync(file, JSON.stringify([event]));
    const one = await f.cli(['send', '--run', run, '--event', `@${file}`]);
    assert.equal(one.error, undefined, JSON.stringify(one)); assert.notEqual(one.await, 'author');
  } finally { f.cleanup(); }
});

test('event array of two exits 1 and records nothing', async () => {
  const f = fixture();
  try {
    const { run, file, event } = await authorFrame(f);
    const journal = path.join(run, 'events.jsonl'), before = fs.readFileSync(journal);
    fs.writeFileSync(file, JSON.stringify([event, event]));
    const two = await f.launch(['send', '--run', run, '--event', `@${file}`]).done;
    assert.deepEqual([two.exit, two.stdout], [1, ''], two.stderr); assert.match(two.stderr, /event: expected one object, got array of 2/);
    assert.deepEqual(fs.readFileSync(journal), before);
  } finally { f.cleanup(); }
});

test('author reply file is written and sends unchanged', async () => {
  const f = fixture();
  try {
    const session = await f.initialize(), frame = await f.begin('plan', session, 'Fixture'), run = f.absoluteRun(frame.run);
    assert.equal(frame.await, 'author', JSON.stringify(frame));
    const named = path.resolve(f.repo, /--event @(\S+)$/.exec(frame.reply)![1]!);
    assert.deepEqual(JSON.parse(fs.readFileSync(named, 'utf8')), frame.events![0]);
    // A resend replays the same frame and keeps a host-edited reply.
    fs.writeFileSync(named, JSON.stringify({ type: 'AUTHORED', path: frame.data['path'] }) + ' ');
    assert.equal((await f.cli(['send', '--run', run])).reply, frame.reply);
    assert.match(fs.readFileSync(named, 'utf8'), / $/);
    const sent = await f.cli(['send', '--run', run, '--event', `@${named}`]);
    assert.equal(sent.error, undefined, JSON.stringify(sent)); assert.notEqual(sent.await, 'author');
  } finally { f.cleanup(); }
});

test('placeholder frame writes no reply file', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.skill, 'config.local.jsonc'), JSON.stringify({ ...f.config, 'read-delegates': { codex: { nativeSubagentsOnly: true, targets: [{ low: { model: 'native-stub', effort: 'low' } }] } } }));
    const session = await f.initialize(); fs.writeFileSync(path.join(f.repo, 'src/a.ts'), 'prepared');
    const frame = await f.begin('review', session, '', ['--kind', 'code']);
    assert.equal(frame.await, 'native', JSON.stringify(frame));
    assert.match(JSON.stringify(frame.events), /<host provider>/);
    const named = path.resolve(f.repo, /--event @(\S+)$/.exec(frame.reply)![1]!);
    assert.equal(fs.existsSync(path.dirname(named)), true); assert.equal(fs.existsSync(named), false);
  } finally { f.cleanup(); }
});
