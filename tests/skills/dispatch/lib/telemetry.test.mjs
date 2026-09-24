import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { appendTelemetry, telemetryPath, userSlug } from '../../../../skills/dispatch/scripts/lib/telemetry.mjs';

const DISPATCH = fileURLToPath(new URL('../../../../skills/dispatch/scripts/dispatch.mjs', import.meta.url));

const ATTEMPT = {
  provider: 'claude', model: 'opus', effort: 'medium', mode: 'cli',
  inputChars: 8, inputEstimate: 2, outputChars: 4, outputEstimate: 1,
  toolTurns: null, providerUsage: null, result: 'ok', failureKind: null, truncated: null,
};

let root;
let dir;
const savedEnv = {};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-test-'));
  dir = path.join(root, 'tel');
  for (const key of ['DISPATCH_TELEMETRY', 'USER', 'USERNAME']) savedEnv[key] = process.env[key];
  delete process.env.DISPATCH_TELEMETRY;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function readLines(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

describe('telemetry', () => {
  it('exports the shared sanitized per-user namespace', () => {
    assert.equal(userSlug({ env: { USER: 'a/b c' } }), 'a_b_c');
    assert.equal(userSlug({ env: {}, userInfo: () => ({ username: '..' }) }), 'unknown');
  });

  it('appends one content-free line per call', () => {
    const startedAt = Date.now() - 50;
    const result = { metricsAttempts: [ATTEMPT], output: 'SECRET RESPONSE', prompt: 'SECRET PROMPT' };
    appendTelemetry({ result, startedAt, dir });
    appendTelemetry({ error: Object.assign(new Error('boom SECRET'), { metricsAttempts: [ATTEMPT] }), startedAt, dir });
    const file = telemetryPath({ dir });
    const lines = readLines(file);
    assert.equal(lines.length, 2);
    assert.deepEqual(Object.keys(lines[0]).sort(), ['attempts', 'durationMs', 'effectiveAttempt', 'recordedAt', 'v']);
    assert.equal(lines[0].v, 1);
    assert.ok(lines[0].durationMs >= 0);
    assert.equal(lines[0].effectiveAttempt, 0);
    assert.equal(lines[1].effectiveAttempt, null);
    assert.deepEqual(lines[0].attempts, [ATTEMPT]);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /SECRET/);
  });

  it('honors DISPATCH_TELEMETRY=0', () => {
    process.env.DISPATCH_TELEMETRY = '0';
    appendTelemetry({ result: { metricsAttempts: [ATTEMPT] }, startedAt: Date.now(), dir });
    assert.equal(fs.existsSync(telemetryPath({ dir })), false);
  });

  it('rotates at 1 MiB, replacing the previous rotation', () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = telemetryPath({ dir });
    const rotated = path.join(dir, 'telemetry.1.jsonl');
    fs.writeFileSync(rotated, 'old\n');
    fs.writeFileSync(file, 'x'.repeat(1024 * 1024));
    appendTelemetry({ result: { metricsAttempts: [ATTEMPT] }, startedAt: Date.now(), dir });
    assert.equal(fs.statSync(rotated).size, 1024 * 1024);
    assert.equal(readLines(file).length, 1);
  });

  it('swallows write failures silently', (t) => {
    const writes = [];
    t.mock.method(process.stderr, 'write', (chunk) => { writes.push(chunk); return true; });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(dir, 'not a directory');
    assert.doesNotThrow(() => appendTelemetry({ result: { metricsAttempts: [ATTEMPT] }, startedAt: Date.now(), dir }));
    assert.doesNotThrow(() => appendTelemetry({ result: { metricsAttempts: [ATTEMPT] }, startedAt: Date.now(), dir: path.join(dir, 'nested') }));
    assert.deepEqual(writes, []);
  });

  it('skips when the directory or file is a symlink', (t) => {
    const real = path.join(root, 'real');
    fs.mkdirSync(real, { mode: 0o700 });
    try {
      fs.symlinkSync(real, dir, 'dir');
    } catch (err) {
      if (err.code === 'EPERM') return t.skip('symlink creation needs elevated rights here');
      throw err;
    }
    appendTelemetry({ result: { metricsAttempts: [ATTEMPT] }, startedAt: Date.now(), dir });
    assert.deepEqual(fs.readdirSync(real), []);

    const dir2 = path.join(root, 'tel2');
    fs.mkdirSync(dir2, { mode: 0o700 });
    const target = path.join(root, 'target.txt');
    fs.writeFileSync(target, '');
    fs.symlinkSync(target, telemetryPath({ dir: dir2 }), 'file');
    appendTelemetry({ result: { metricsAttempts: [ATTEMPT] }, startedAt: Date.now(), dir: dir2 });
    assert.equal(fs.readFileSync(target, 'utf8'), '');
  });

  it('writes nothing when no provider attempt was made', () => {
    appendTelemetry({ error: Object.assign(new Error('config'), { code: 'INTEGRITY_VIOLATION' }), startedAt: Date.now(), dir });
    appendTelemetry({ result: { metricsAttempts: [] }, startedAt: Date.now(), dir });
    assert.equal(fs.existsSync(telemetryPath({ dir })), false);
  });

  it('skips a non-regular file at the telemetry path', () => {
    fs.mkdirSync(telemetryPath({ dir }), { recursive: true });
    appendTelemetry({ result: { metricsAttempts: [ATTEMPT] }, startedAt: Date.now(), dir });
    assert.ok(fs.statSync(telemetryPath({ dir })).isDirectory());
    assert.deepEqual(fs.readdirSync(telemetryPath({ dir })), []);
  });

  it('records nothing for CLI usage errors that never dispatch', () => {
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(tmp);
    // Route os.tmpdir() into the sandbox on every platform so the real telemetry file is untouched.
    const env = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, USER: 'tel-test', USERNAME: 'tel-test' };
    delete env.DISPATCH_TELEMETRY;
    const run = spawnSync(process.execPath, [DISPATCH, '--batch-file', path.join(tmp, 'missing.json'), '-p', 'x'], {
      encoding: 'utf8', env, timeout: 30000,
    });
    assert.notEqual(run.status, 0);
    assert.equal(fs.existsSync(path.join(tmp, 'dispatch-skills-tel-test', 'telemetry')), false);
  });

  it('sanitizes the username in the default path', () => {
    process.env.USER = '../ev il/..';
    const file = telemetryPath();
    assert.equal(path.dirname(file), path.join(os.tmpdir(), 'dispatch-skills-.._ev_il_..', 'telemetry'));
    assert.equal(path.basename(file), 'telemetry.jsonl');
    for (const value of ['..', '.']) {
      process.env.USER = value;
      assert.equal(path.dirname(telemetryPath()), path.join(os.tmpdir(), 'dispatch-skills-unknown', 'telemetry'));
    }
  });
});
