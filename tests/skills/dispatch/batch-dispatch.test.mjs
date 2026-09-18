import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import {
  buildDoctorReport,
  dispatchBatch,
  loadBatchFile,
  providerProbes,
  providerRunners,
} from '../../../skills/dispatch/scripts/dispatch.mjs';

const CONFIG = {
  platforms: {
    claude: { model: 'claude-opus-5', effort: 'low' },
    agy: { model: 'gemini-3.8-flash', effort: 'medium' },
  },
};

let root;
let savedTelemetry;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dispatch-batch-'));
  // Keep batch runs out of the user's real telemetry file.
  savedTelemetry = process.env.DISPATCH_TELEMETRY;
  process.env.DISPATCH_TELEMETRY = '0';
});

afterEach(() => {
  mock.restoreAll();
  if (savedTelemetry === undefined) delete process.env.DISPATCH_TELEMETRY;
  else process.env.DISPATCH_TELEMETRY = savedTelemetry;
  fs.rmSync(root, { recursive: true, force: true });
});

function writeBatch(value) {
  const batchPath = path.join(root, 'batch.json');
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

describe('dispatch batch manifest', () => {
  it('validates and derives stable source keys', () => {
    const batch = loadBatchFile(writeBatch({ targets: [entry()], reserves: [] }), CONFIG);
    assert.equal(batch.targets[0].sourceKey, 'code-review:R1:claude:0');
  });

  it('rejects unknown fields and mixed candidate selectors', () => {
    assert.throws(
      () => loadBatchFile(writeBatch({
        targets: [entry({ unknown: true })],
      }), CONFIG),
      /unsupported field "unknown"/,
    );
    assert.throws(
      () => loadBatchFile(writeBatch({
        targets: [entry({ candidateIndex: 0 })],
      }), CONFIG),
      /either candidateIndex or model\/effort, never both/,
    );
    assert.throws(
      () => loadBatchFile(writeBatch({
        targets: [entry({
          candidateId: 'code-review:claude:9',
          model: undefined,
          candidateIndex: 9,
        })],
      }), CONFIG),
      /candidateIndex 9 is out of range/,
    );
  });

  it('rejects duplicate tuples', () => {
    assert.throws(
      () => loadBatchFile(writeBatch({
        targets: [entry(), entry({ candidateId: 'code-review:claude:1' })],
      }), CONFIG),
      /duplicates a target tuple/,
    );
  });

  it('rejects duplicate source keys and legacy metricsFile fields', () => {
    assert.throws(
      () => loadBatchFile(writeBatch({
        targets: [
          entry(),
          entry({ candidateId: 'code-review:claude:0', model: 'other-model' }),
        ],
      }), CONFIG),
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
      }), CONFIG),
      /unsupported field "metricsFile"/,
    );
  });

  it('rejects unsafe batch-file paths', () => {
    assert.throws(() => loadBatchFile('relative.json', CONFIG), /absolute path/);
    assert.throws(
      () => loadBatchFile(path.resolve('package.json'), CONFIG),
      /OS temp directory/,
    );
    const oversized = path.join(root, 'oversized.json');
    fs.writeFileSync(oversized, ' '.repeat(64 * 1024 + 1));
    assert.throws(() => loadBatchFile(oversized, CONFIG), /exceeds 64 KiB/);
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
    }), CONFIG);

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
    }), CONFIG);

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
    }), CONFIG);

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
    }), CONFIG);

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

describe('dispatch doctor', () => {
  it('reports effective candidates, sandbox support, and corrective commands', async () => {
    mock.method(providerProbes, 'isClaudeAvailable', async () => true);
    mock.method(providerProbes, 'isAgyAvailable', async () => false);
    const report = await buildDoctorReport(CONFIG, '/tmp/config.jsonc');

    assert.equal(report.configPath, '/tmp/config.jsonc');
    assert.deepEqual(report.targets.map(target => target.platform), ['claude', 'agy']);
    assert.equal(report.health[0].sandboxSupported, true);
    assert.match(report.health[1].correctiveCommand, /agy/);
  });

  it('respects orchestrator candidate demotion in doctor report', async () => {
    mock.method(providerProbes, 'isClaudeAvailable', async () => true);
    mock.method(providerProbes, 'isAgyAvailable', async () => true);
    const report = await buildDoctorReport(CONFIG, '/tmp/config.jsonc', 'claude');
    assert.deepEqual(report.targets.map(target => target.platform), ['agy', 'claude']);
  });
});
