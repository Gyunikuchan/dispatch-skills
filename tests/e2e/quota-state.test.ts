import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { initializeSession } from '../../skills/dispatch/scripts/lib/session.ts';
import { publishQuotaFailure, readQuotaState, reprobeQuota } from '../../skills/dispatch/scripts/lib/quota-store.ts';
import { H, quotaSnapshot } from '../../skills/dispatch/scripts/policy/quota.ts';
import type { QuotaKey } from '../../skills/dispatch/scripts/core/types.ts';

const execute = promisify(execFile);
const key: QuotaKey = { provider: 'codex', model: null, mode: 'cli' };
const now = 100 * H + 100;
const storeUrl = new URL('../../skills/dispatch/scripts/lib/quota-store.ts', import.meta.url).href;
const policyUrl = new URL('../../skills/dispatch/scripts/policy/quota.ts', import.meta.url).href;
const entry = fileURLToPath(new URL('../../skills/dispatch/scripts/dispatch.ts', import.meta.url));
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-state-')), repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const sessionDir = initializeSession({ repositoryRoot: repo, sessionId: crypto.randomUUID(), sessionTitle: 'Quota fixture', now: new Date('2026-10-19T00:00:00Z') });
  const options = { sessionDir, repositoryRoot: repo, bucketWidth: H };
  const capture = (keys: QuotaKey[] = [key], clock = now) => {
    const state = readQuotaState(options, keys, clock);
    return { ...state, snapshot: quotaSnapshot(keys, state.generations, state.observations, clock) };
  };
  const subprocess = async (body: string, value: unknown) => {
    const script = `import * as store from ${JSON.stringify(storeUrl)}; import * as policy from ${JSON.stringify(policyUrl)}; const x=JSON.parse(process.argv[1]); ${body}`;
    const result = await execute(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(value)], { cwd: repo, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '', NODE_TEST_CONTEXT: '' } });
    return JSON.parse(result.stdout) as ReturnType<typeof readQuotaState> & { generation: string; skipped: boolean };
  };
  const cli = async (provider: string, mode: string, session = sessionDir) => {
    try {
      const result = await execute(process.execPath, [entry, 'session', 'quota-reprobe', '--session-dir', session, '--provider', provider, '--mode', mode], { cwd: repo, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '', NODE_TEST_CONTEXT: '' } });
      return { exit: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const result = error as { code: number; stdout: string; stderr: string };
      return { exit: result.code, stdout: result.stdout, stderr: result.stderr };
    }
  };
  const quotaDir = () => path.join(sessionDir, '.state', 'quota', crypto.createHash('sha256').update(JSON.stringify([key.provider, key.model, key.mode])).digest('hex'));
  return { root, repo, sessionDir, options, capture, subprocess, cli, quotaDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('quota state survives sessions and reprobe races', async (t) => {
  await t.test('complete observations survive another process and remain isolated to their session', async () => {
    const f = setup();
    try {
      const generation = f.capture().generations[0]!.generation;
      assert.equal(publishQuotaFailure(f.options, key, generation, now).published, true);
      const state = await f.subprocess('const s=store.readQuotaState(x.options,[x.key],x.now); console.log(JSON.stringify(policy.quotaSnapshot([x.key],s.generations,s.observations,x.now).decisions[0]));', { options: f.options, key, now: now + 1 });
      assert.equal(state.skipped, true);
      const other = initializeSession({ repositoryRoot: f.repo, sessionId: crypto.randomUUID(), sessionTitle: 'Other quota fixture', now: new Date('2026-10-19T00:01:00Z') });
      assert.equal(readQuotaState({ ...f.options, sessionDir: other }, [key], now + 1).observations.length, 0);
      assert.equal(f.capture([key], now + H).snapshot.decisions[0]!.skipped, false);
      const records = fs.readdirSync(f.quotaDir()).map((name) => fs.readFileSync(path.join(f.quotaDir(), name), 'utf8')).join('');
      assert.equal(records.includes(f.repo), false);
      assert.equal(records.includes('prompt'), false);
    } finally { f.cleanup(); }
  });
  await t.test('same bucket publication coalesces and unrelated keys and buckets survive', async () => {
    const f = setup();
    try {
      const generation = f.capture().generations[0]!.generation;
      assert.equal(publishQuotaFailure(f.options, key, generation, now).published, true);
      const publish = 'console.log(JSON.stringify(store.publishQuotaFailure(x.options,x.key,x.generation,x.at)));';
      const coalesced = await Promise.all([now + 10, now + 20].map((at) => f.subprocess(publish, { options: f.options, key, generation, at })));
      assert.equal(coalesced.every((result) => !(result as unknown as { published: boolean }).published), true);
      assert.equal(f.capture([key], now + 30).snapshot.decisions[0]!.expiresAt, now + H);
      const other = { ...key, model: '../literal/default' };
      const marker = f.capture([other]).generations[0]!;
      await Promise.all([
        f.subprocess(publish, { options: f.options, key: other, generation: marker.generation, at: now }),
        f.subprocess(publish, { options: f.options, key, generation, at: now + H }),
      ]);
      assert.deepEqual(f.capture([key, other]).snapshot.decisions.map((row) => row.skipped), [true, true]);
      assert.equal(fs.readdirSync(f.quotaDir()).filter((name) => name !== 'generation.json').length, 2);
      assert.equal(f.capture([key], now + H).snapshot.decisions[0]!.skipped, true);
      assert.equal(fs.readdirSync(path.join(f.sessionDir, '.state', 'quota')).every((name) => /^[a-f0-9]{64}$/.test(name)), true);
    } finally { f.cleanup(); }
  });
  await t.test('old bucket volume cannot hide valid current and previous bucket evidence', () => {
    const f = setup();
    try {
      const generation = f.capture().generations[0]!.generation;
      for (let bucket = 1; bucket < 80; bucket++) assert.equal(publishQuotaFailure(f.options, key, generation, bucket * H).published, true);
      const at = 100 * H - 1;
      publishQuotaFailure(f.options, key, generation, at);
      publishQuotaFailure(f.options, key, generation, 100 * H);
      const state = f.capture([key], 100 * H + 1);
      assert.equal(state.snapshot.decisions[0]!.skipped, true);
      assert.equal(state.observations.length, 2);
      assert.equal(fs.readdirSync(f.quotaDir()).length, 82);
      fs.writeFileSync(path.join(f.quotaDir(), generation + '.100.json'), '{');
      assert.equal(f.capture([key], 100 * H + 1).snapshot.decisions[0]!.skipped, true);
    } finally { f.cleanup(); }
  });
  await t.test('concurrent reprobes and late completions cannot revive an old generation', async () => {
    const f = setup();
    try {
      const old = f.capture().generations[0]!.generation;
      publishQuotaFailure(f.options, key, old, now);
      const results = await Promise.all([1, 2].map(() => f.subprocess('console.log(JSON.stringify(store.reprobeQuota(x.options,x.key)));', { options: f.options, key })));
      const active = f.capture().generations[0]!.generation;
      assert.ok(results.some((result) => result.generation === active));
      assert.notEqual(active, old);
      assert.equal(publishQuotaFailure(f.options, key, old, now + 1).warning, undefined);
      assert.equal(f.capture([key], now + 1).snapshot.decisions[0]!.skipped, false);
      assert.equal(publishQuotaFailure(f.options, key, active, now + 2).published, true);
      assert.equal(f.capture([key], now + 2).snapshot.decisions[0]!.skipped, true);
      const result = await f.cli('codex', 'cli');
      assert.equal(result.exit, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).appliesTo, 'future-waves');
      assert.equal(f.capture([key], now + 2).snapshot.decisions[0]!.skipped, false);
    } finally { f.cleanup(); }
  });
  await t.test('malformed oversized unsupported and future records use normal routing', () => {
    for (const corrupt of ['{', 'x'.repeat(8193), JSON.stringify({ schemaVersion: 2 })]) {
      const f = setup();
      try {
        f.capture();
        fs.writeFileSync(path.join(f.quotaDir(), 'generation.json'), corrupt);
        const state = f.capture();
        assert.equal(state.snapshot.decisions[0]!.skipped, false);
        assert.equal(state.warnings.length, 1);
      } finally { f.cleanup(); }
    }
    for (const corrupt of ['{', 'x'.repeat(4097), JSON.stringify({ schemaVersion: 2 }), 'future']) {
      const f = setup();
      try {
        const marker = f.capture().generations[0]!;
        const observation = path.join(f.quotaDir(), marker.generation + '.' + Math.floor(now / H) + '.json');
        fs.writeFileSync(observation, corrupt === 'future' ? JSON.stringify({ ...marker, bucket: Math.floor(now / H), observedAt: now + 1 }) : corrupt);
        const state = f.capture();
        assert.equal(state.snapshot.decisions[0]!.skipped, false);
        assert.equal(state.warnings.length, 1);
      } finally { f.cleanup(); }
    }
  });
  await t.test('linked state and records cannot redirect reads or writes', () => {
    for (const locus of ['.state', 'quota', 'key', 'generation', 'observation']) {
      const f = setup();
      try {
        const marker = f.capture().generations[0]!;
        const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
        const sentinel = path.join(outside, 'sentinel'); fs.writeFileSync(sentinel, 'intact');
        const target = locus === '.state' ? path.join(f.sessionDir, '.state') : locus === 'quota' ? path.join(f.sessionDir, '.state', 'quota') : locus === 'key' ? f.quotaDir()
          : locus === 'generation' ? path.join(f.quotaDir(), 'generation.json') : path.join(f.quotaDir(), marker.generation + '.' + Math.floor(now / H) + '.json');
        const isFile = locus === 'generation' || locus === 'observation';
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: !isFile });
        fs.symlinkSync(isFile ? sentinel : outside, target, isFile ? 'file' : process.platform === 'win32' ? 'junction' : 'dir');
        const state = f.capture();
        assert.equal(state.snapshot.decisions[0]!.skipped, false, locus);
        assert.equal(state.warnings.length, 1, locus);
        assert.equal(publishQuotaFailure(f.options, key, marker.generation, now).published, false, locus);
        if (locus !== 'observation') assert.throws(() => reprobeQuota(f.options, key), locus);
        assert.equal(fs.readFileSync(sentinel, 'utf8'), 'intact');
        assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
      } finally { f.cleanup(); }
    }
  });
  await t.test('invalid arguments unowned sessions and I/O failures cannot create quota writes', async () => {
    const f = setup();
    try {
      for (const [provider, mode] of [['unknown', 'cli'], ['codex', 'unknown']]) {
        const result = await f.cli(provider!, mode!);
        assert.equal(result.exit, 1);
        assert.equal(fs.existsSync(path.join(f.sessionDir, '.state', 'quota')), false);
      }
      const unowned = path.join(f.root, 'unowned'); fs.mkdirSync(unowned);
      assert.equal((await f.cli('codex', 'cli', unowned)).exit, 1);
      assert.deepEqual(fs.readdirSync(unowned), []);
      const otherRepo = path.join(f.root, 'other-repo'); fs.mkdirSync(otherRepo);
      assert.throws(() => reprobeQuota({ ...f.options, repositoryRoot: otherRepo }, key));
      assert.equal(fs.existsSync(path.join(f.sessionDir, '.state', 'quota')), false);
      fs.mkdirSync(path.join(f.sessionDir, '.state'));
      fs.writeFileSync(path.join(f.sessionDir, '.state', 'quota'), 'unwritable path');
      const state = f.capture();
      assert.equal(state.snapshot.decisions[0]!.skipped, false);
      assert.equal(state.warnings.length, 1);
      const failure = publishQuotaFailure(f.options, key, '00000000-0000-4000-8000-000000000001', now);
      assert.equal(failure.published, false);
      assert.ok(failure.warning);
      assert.equal(fs.readFileSync(path.join(f.sessionDir, '.state', 'quota'), 'utf8'), 'unwritable path');
    } finally { f.cleanup(); }
  });
});
