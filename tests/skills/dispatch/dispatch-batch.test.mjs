import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import {
  dispatchBatch,
  loadBatchFile,
  providerRunners,
} from '../../../skills/dispatch/scripts/dispatch.mjs';
import { resolveReadDelegates } from '../../../skills/dispatch/scripts/lib/config.mjs';
import { bindWorkflowSession, runDir, runId } from '../../../skills/dispatch/scripts/lib/session-temp.mjs';
import { createStubDispatchEnvironment, createStubDispatchFixture, parseSlotLines } from '../../helpers/stub-dispatch-fixture.mjs';

/** Config: dispatchBatch takes it whole (it calls dispatchTask per slot). */
const CONFIG = {
  'read-delegates': {
    claude: { targets: [{ low: { model: 'claude-opus-5', effort: 'low' }, high: { model: 'claude-opus-5', effort: 'high' } }] },
    agy: { targets: [{ low: { model: 'gemini-3.8-flash', effort: 'medium' } }] },
  },
};
/** loadBatchFile validates against the level-resolved { platforms } map (resolved-map contract). */
const RESOLVED = resolveReadDelegates(CONFIG, 'medium');

let root;
let session;
let savedTelemetry;
let savedSessionEnv;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dispatch-batch-'));
  savedSessionEnv = Object.fromEntries(['DISPATCH_SESSION_DIR', 'DISPATCH_RUN_ID', 'DISPATCH_CHAT_ID'].map(key => [key, process.env[key]]));
  for (const key of Object.keys(savedSessionEnv)) delete process.env[key];
  process.env.DISPATCH_CHAT_ID = `batch-${process.pid}-${Date.now()}`;
  session = bindWorkflowSession({ repositoryRoot: root, artifactKind: 'plan', slug: 'batch' });
  // Keep batch runs out of the user's real telemetry file.
  savedTelemetry = process.env.DISPATCH_TELEMETRY;
  process.env.DISPATCH_TELEMETRY = '0';
});

afterEach(() => {
  mock.restoreAll();
  if (savedTelemetry === undefined) delete process.env.DISPATCH_TELEMETRY;
  else process.env.DISPATCH_TELEMETRY = savedTelemetry;
  fs.rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedSessionEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function writeBatch(value) {
  const directory = runDir(runId('ask'));
  fs.mkdirSync(directory, { recursive: true });
  const batchPath = path.join(directory, 'r1.batch.json');
  fs.writeFileSync(batchPath, JSON.stringify(value));
  return batchPath;
}

function entry({
  roundId = 'code-review:R1',
  candidateId = 'code-review:claude:0',
  platform = 'claude',
  ...rest
} = {}) {
  return {
    roundId,
    candidateId,
    platform,
    model: 'test-model',
    ...rest,
  };
}

// SECTION: Manifest validation and batch execution

describe('dispatch batch manifest', () => {
  it('validates and derives stable source keys', () => {
    const batch = loadBatchFile(writeBatch({ targets: [entry()], reserves: [] }), RESOLVED);
    assert.equal(batch.targets[0].sourceKey, 'code-review:R1:claude:0');
  });

  it('rejects unknown fields and mixed candidate selectors', () => {
    assert.throws(
      () => loadBatchFile(writeBatch({
        targets: [entry({ unknown: true })],
      }), RESOLVED),
      /unsupported field "unknown"/,
    );
    assert.throws(
      () => loadBatchFile(writeBatch({
        targets: [entry({ candidateIndex: 0 })],
      }), RESOLVED),
      /either candidateIndex or model\/effort, never both/,
    );
    assert.throws(
      () => loadBatchFile(writeBatch({
        targets: [entry({
          candidateId: 'code-review:claude:9',
          model: undefined,
          candidateIndex: 9,
        })],
      }), RESOLVED),
      /candidateIndex 9 is out of range/,
    );
  });

  it('rejects duplicate tuples', () => {
    assert.throws(
      () => loadBatchFile(writeBatch({
        targets: [entry(), entry({ candidateId: 'code-review:claude:1' })],
      }), RESOLVED),
      /duplicates a target tuple/,
    );
  });

  it('rejects duplicate source keys and unsupported fields', () => {
    assert.throws(
      () => loadBatchFile(writeBatch({
        targets: [
          entry(),
          entry({ candidateId: 'code-review:claude:0', model: 'other-model' }),
        ],
      }), RESOLVED),
      /duplicates source key/,
    );
    assert.throws(
      () => loadBatchFile(writeBatch({
        targets: [
          entry(),
          entry({
            platform: 'agy',
            candidateId: 'code-review:agy:0',
            metricsFile: path.join(root, 'target.json'),
          }),
        ],
      }), RESOLVED),
      /unsupported field "metricsFile"/,
    );
  });

  it('rejects foreign paths and loads a workspace batch without OS-temp access', () => {
    assert.throws(() => loadBatchFile('relative.json', RESOLVED), /absolute path/);
    assert.throws(
      () => loadBatchFile(path.resolve('package.json'), RESOLVED),
      /active chat session root/,
    );
    const originalRealpath = fs.realpathSync;
    fs.realpathSync = (target, ...args) => {
      if (path.resolve(String(target)) === path.resolve(os.tmpdir())) throw Object.assign(new Error('temp denied'), { code: 'EACCES' });
      return originalRealpath(target, ...args);
    };
    try { assert.equal(loadBatchFile(writeBatch({ targets: [entry()], reserves: [] }), RESOLVED).targets.length, 1); }
    finally { fs.realpathSync = originalRealpath; }
    const oversized = path.join(path.dirname(writeBatch({ targets: [entry()], reserves: [] })), 'oversized.json');
    fs.writeFileSync(oversized, ' '.repeat(64 * 1024 + 1));
    assert.throws(() => loadBatchFile(oversized, RESOLVED), /exceeds 64 KiB/);
  });

  it('emits a terminal slot before slower peers complete', async () => {
    let releaseSlow;
    const slow = new Promise((resolve) => { releaseSlow = resolve; });
    mock.method(providerRunners, 'claude', async () => ({
      provider: 'claude', stdout: '', stderr: 'quota', exitCode: 1, failureKind: 'quota',
      logFile: path.join(root, 'claude.log'), truncated: null, metricsAttempts: [],
    }));
    mock.method(providerRunners, 'agy', async () => {
      await slow;
      return {
        provider: 'agy', stdout: 'review', stderr: '', exitCode: 0, failureKind: null,
        logFile: path.join(root, 'agy.log'), truncated: null, metricsAttempts: [],
      };
    });
    const batch = loadBatchFile(writeBatch({
      targets: [entry(), entry({ candidateId: 'code-review:agy:0', platform: 'agy' })],
      reserves: [],
    }), RESOLVED);
    const seen = [];
    const running = dispatchBatch(batch, {
      prompt: 'Review', files: [], configPath: 'test-config', orchestrator: 'claude',
      onSlot: (record) => seen.push(record.sourceKey),
    }, CONFIG);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, ['code-review:R1:claude:0']);
    releaseSlow();
    await running;
    assert.deepEqual(seen, ['code-review:R1:claude:0', 'code-review:R1:agy:0']);
  });

  it('runs targets in order and substitutes the first reserve', async () => {
    mock.method(providerRunners, 'claude', async () => ({
      provider: 'claude',
      stdout: '',
      stderr: 'quota exceeded',
      exitCode: 1,
      failureKind: 'quota',
      logFile: path.join(root, 'claude.log'),
      truncated: null,
      metricsAttempts: [],
    }));
    mock.method(providerRunners, 'agy', async () => ({
      provider: 'agy',
      stdout: '{"findings":[]}',
      stderr: '',
      exitCode: 0,
      failureKind: null,
      logFile: path.join(root, 'agy.log'),
      truncated: null,
      metricsAttempts: [],
    }));
    const batch = loadBatchFile(writeBatch({
      targets: [entry()],
      reserves: [entry({
        candidateId: 'code-review:agy:0',
        platform: 'agy',
      })],
    }), RESOLVED);

    const envelope = await dispatchBatch(batch, {
      prompt: 'Review',
      files: [],
      configPath: 'test-config',
      orchestrator: 'opencode',
    }, CONFIG);

    assert.equal(envelope.targets.length, 1);
    assert.equal(envelope.targets[0].platform, 'agy');
    assert.equal(envelope.targets[0].substitutesFor, 'code-review:R1:claude:0');
    assert.equal(envelope.failures.length, 1);
    assert.equal(envelope.failures[0].sourceKey, 'code-review:R1:claude:0');
    assert.equal(envelope.logDir, root);
    assert.equal(envelope.complete, true);
    assert.equal(envelope.targets[0].truncated, null);
    assert.equal(envelope.targets[0].logFile, path.join(root, 'agy.log'));
    assert.deepEqual(
      [envelope.targets[0].role, envelope.targets[0].model, envelope.targets[0].effort],
      ['reserve', 'test-model', 'medium'],
    );
    assert.deepEqual(
      [envelope.failures[0].role, envelope.failures[0].model, envelope.failures[0].effort],
      ['target', 'test-model', 'low'],
    );
  });

  it('leaves an orchestrator-platform failure unresolved for native fallback', async () => {
    let reserveCalls = 0;
    mock.method(providerRunners, 'claude', async () => ({
      provider: 'claude',
      stdout: '',
      stderr: 'failed',
      exitCode: 1,
      failureKind: 'other',
      logFile: path.join(root, 'claude.log'),
      truncated: null,
      metricsAttempts: [],
    }));
    mock.method(providerRunners, 'agy', async () => {
      reserveCalls++;
      return {
        provider: 'agy',
        stdout: 'review',
        stderr: '',
        exitCode: 0,
        failureKind: null,
        logFile: path.join(root, 'agy.log'),
        truncated: null,
        metricsAttempts: [],
      };
    });
    const batch = loadBatchFile(writeBatch({
      targets: [entry()],
      reserves: [entry({
        candidateId: 'code-review:agy:0',
        platform: 'agy',
      })],
    }), RESOLVED);

    const envelope = await dispatchBatch(batch, {
      prompt: 'Review',
      files: [],
      configPath: 'test-config',
      orchestrator: 'claude',
    }, CONFIG);

    assert.equal(envelope.complete, false);
    assert.equal(envelope.failures.length, 1);
    assert.equal(reserveCalls, 0);
  });

  it('allows mixed-platform batches without failing non-Claude targets when responseSchema is provided', async () => {
    mock.method(providerRunners, 'claude', async (options) => {
      assert.ok(options.responseSchema);
      return {
        session: 'claude-session',
        stdout: JSON.stringify({ status: 'CLEAN', findings: [] }),
        stderr: '',
        exitCode: 0,
        failureKind: null,
        logFile: path.join(root, 'claude.log'),
        truncated: null,
        metricsAttempts: [],
      };
    });
    mock.method(providerRunners, 'agy', async (options) => {
      assert.equal(options.responseSchema, null);
      return {
        session: 'agy-session',
        stdout: JSON.stringify({ status: 'CLEAN', findings: [] }),
        stderr: '',
        exitCode: 0,
        failureKind: null,
        logFile: path.join(root, 'agy.log'),
        truncated: null,
        metricsAttempts: [],
      };
    });

    const batch = loadBatchFile(writeBatch({
      targets: [
        entry({ candidateId: 'code-review:claude:0', platform: 'claude' }),
        entry({ candidateId: 'code-review:agy:0', platform: 'agy' }),
      ],
      reserves: [],
    }), RESOLVED);

    const envelope = await dispatchBatch(batch, {
      prompt: 'Review',
      files: [],
      configPath: 'test-config',
      orchestrator: 'copilot',
      responseSchema: { type: 'object' },
    }, CONFIG);

    assert.equal(envelope.complete, true);
    assert.equal(envelope.targets.length, 2);
    assert.equal(envelope.failures.length, 0);
  });

  it('normalizes numeric error.code in batchRecord failureKind', async () => {
    mock.method(providerRunners, 'claude', async () => {
      const err = new Error('spawn failed');
      err.code = 1;
      throw err;
    });

    const batch = loadBatchFile(writeBatch({
      targets: [entry({ candidateId: 'code-review:claude:0', platform: 'claude' })],
      reserves: [],
    }), RESOLVED);

    const envelope = await dispatchBatch(batch, {
      prompt: 'Review',
      files: [],
      configPath: 'test-config',
      orchestrator: 'claude',
    }, CONFIG);

    assert.equal(envelope.complete, false);
    assert.equal(envelope.failures.length, 1);
    assert.notEqual(typeof envelope.failures[0].failureKind, 'number');
  });
});

// SECTION: Level resolution

describe('dispatch batch level resolution', () => {
  it('resolves read-delegates at options.level for batch records', async () => {
    const seen = [];
    mock.method(providerRunners, 'claude', async (options) => {
      seen.push(options.effort);
      return {
        provider: 'claude',
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
        failureKind: null,
        logFile: path.join(root, 'claude.log'),
        truncated: null,
        metricsAttempts: [],
      };
    });
    const resolvedHigh = resolveReadDelegates(CONFIG, 'high');
    const batch = loadBatchFile(writeBatch({
      targets: [entry({ model: undefined, candidateIndex: 0 })],
    }), resolvedHigh);
    const envelope = await dispatchBatch(batch, {
      prompt: 'Review',
      files: [],
      configPath: 'test-config',
      orchestrator: 'opencode',
      level: 'high',
    }, CONFIG);
    assert.equal(envelope.complete, true);
    assert.deepEqual(seen, ['high']);
    assert.equal(envelope.targets[0].effort, 'high');
  });
});

// SECTION: Batch CLI slot transport

describe('dispatch --batch-file CLI (R8 per-slot stdout)', () => {
  let fixture;
  beforeEach(() => {
    fixture = createStubDispatchFixture(CONFIG);
  });
  afterEach(() => fixture.cleanup());

  function writeFixtureBatch(value) {
    const directory = runDir(runId('ask'));
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `batch-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  }

  function runFixtureDispatch(args, { results = {}, live = {}, env: extraEnv = {} } = {}) {
    const logFile = path.join(fixture.dir, `calls-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
    const env = createStubDispatchEnvironment({
      results, live, logFile, extra: { DISPATCH_SESSION_DIR: session, ...extraEnv },
    });
    const res = spawnSync(process.execPath, [fixture.script, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: root, env, timeout: 60_000, killSignal: 'SIGKILL',
    });
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  }

  const BATCH = {
    targets: [entry()],
    reserves: [entry({ candidateId: 'code-review:agy:0', platform: 'agy' })],
  };

  it('prints one compact JSON line per slot and no envelope on stdout', () => {
    const res = runFixtureDispatch(['--batch-file', writeFixtureBatch(BATCH), '--orchestrator', 'opencode', 'Review']);
    assert.equal(res.status, 0, res.stderr);
    const lines = parseSlotLines(res.stdout);
    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(lines[0]).sort(), ['exit', 'output', 'platform', 'session', 'slot', 'status']);
    assert.deepEqual(
      [lines[0].slot, lines[0].platform, lines[0].status, lines[0].exit, lines[0].session],
      ['code-review:R1:claude:0', 'claude', 'ok', 0, 'claude-session'],
    );
    assert.ok(lines[0].output && fs.existsSync(lines[0].output));
    assert.doesNotMatch(res.stdout, /"complete"/);
  });

  it('prints a line for the failed target and for its reserve substitute', () => {
    const res = runFixtureDispatch(
      ['--batch-file', writeFixtureBatch(BATCH), '--orchestrator', 'opencode', 'Review'],
      { results: { claude: { exit: 1 } } },
    );
    assert.equal(res.status, 0, res.stderr);
    const lines = parseSlotLines(res.stdout);
    assert.deepEqual(
      lines.map((l) => [l.slot, l.status, l.exit]),
      [['code-review:R1:claude:0', 'failed', 1], ['code-review:R1:agy:0', 'ok', 0]],
    );
    assert.equal(lines[0].output, null);
  });

  it('keeps the full envelope unchanged in --output-file', () => {
    const outputFile = path.join(runDir(runId('ask')), 'r1.output.log');
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    const res = runFixtureDispatch(
      ['--batch-file', writeFixtureBatch(BATCH), '--orchestrator', 'opencode', '--output-file', outputFile, 'Review'],
      { results: { claude: { exit: 1 } } },
    );
    assert.equal(res.status, 0, res.stderr);
    const envelope = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    assert.deepEqual(Object.keys(envelope).sort(), ['complete', 'failures', 'logDir', 'targets']);
    assert.equal(envelope.complete, true);
    assert.equal(envelope.targets[0].sourceKey, 'code-review:R1:agy:0');
    assert.equal(envelope.targets[0].substitutesFor, 'code-review:R1:claude:0');
    assert.equal(envelope.targets[0].report, 'report from agy test-model');
    assert.equal(envelope.failures[0].sourceKey, 'code-review:R1:claude:0');
    assert.equal(parseSlotLines(res.stdout).length, 2, 'per-slot lines still go to stdout');
  });
});
