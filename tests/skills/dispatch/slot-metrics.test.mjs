import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  prepareMetricsDestination,
  publishSlotRecord,
  recordDispatchMetrics,
  RUN_MARKER,
} from '../../../skills/dispatch/scripts/slot-metrics.mjs';

let root;
let runDir;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slot-metrics-')));
  runDir = path.join(root, 'run');
  fs.mkdirSync(runDir, { mode: 0o700 });
  fs.writeFileSync(path.join(runDir, RUN_MARKER), JSON.stringify({
    schemaVersion: 1,
    runId: '20260916T110000Z-a1b2',
    runDir: fs.realpathSync(runDir),
    startedAt: '2026-09-16T11:00:00Z',
  }));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const attempt = {
  provider: 'claude',
  model: 'opus',
  effort: 'high',
  mode: 'cli',
  inputChars: 10,
  inputEstimate: 3,
  outputChars: 4,
  outputEstimate: 1,
  toolTurns: null,
  providerUsage: null,
  result: 'ok',
  failureKind: null,
  truncated: null,
};

describe('slot metrics', () => {
  it('publishes a closed-schema slot atomically', () => {
    const file = path.join(runDir, 'plan-r1-s1.json');
    const destination = prepareMetricsDestination(file);
    publishSlotRecord(destination, {
      schemaVersion: 1,
      runId: destination.marker.runId,
      slotId: destination.slotId,
      recordedAt: new Date().toISOString(),
      attempts: [attempt],
      effectiveAttempt: 0,
    });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).attempts[0].inputChars, 10);
  });

  it('rejects relative paths and destinations outside a marked run', () => {
    assert.throws(() => prepareMetricsDestination('slot.json'), /absolute/);
    assert.throws(() => prepareMetricsDestination(path.join(root, 'slot.json')), /marker/i);
  });

  it('rejects overwrite collisions', () => {
    const file = path.join(runDir, 'slot.json');
    fs.writeFileSync(file, '{}');
    assert.throws(() => prepareMetricsDestination(file), /already exists/);
  });

  it('rejects symbolic-link ancestors', (t) => {
    const linked = path.join(root, 'linked');
    try {
      fs.symlinkSync(runDir, linked, 'junction');
    } catch {
      return t.skip('symlink creation requires privileges');
    }
    assert.throws(() => prepareMetricsDestination(path.join(linked, 'slot.json')), /symbolic link/);
  });

  it('rejects a run-directory path swap after destination validation', () => {
    const destination = prepareMetricsDestination(path.join(runDir, 'slot.json'));
    const moved = `${runDir}-moved`;
    fs.renameSync(runDir, moved);
    fs.mkdirSync(runDir);
    fs.copyFileSync(path.join(moved, RUN_MARKER), path.join(runDir, RUN_MARKER));
    assert.throws(() => publishSlotRecord(destination, {
      schemaVersion: 1,
      runId: destination.marker.runId,
      slotId: destination.slotId,
      recordedAt: new Date().toISOString(),
      attempts: [attempt],
      effectiveAttempt: 0,
    }), /changed after validation/);
  });

  it('records a terminal provider result without prompt or output text', () => {
    const file = path.join(runDir, 'slot.json');
    recordDispatchMetrics(file, { metricsAttempts: [attempt], effectiveAttempt: 0 }, null);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(record).sort(), [
      'attempts', 'effectiveAttempt', 'recordedAt', 'runId', 'schemaVersion', 'slotId',
    ]);
    assert.equal(JSON.stringify(record).includes('secret prompt'), false);
  });

  it('rejects unsupported durable fields', () => {
    const destination = prepareMetricsDestination(path.join(runDir, 'slot.json'));
    assert.throws(() => publishSlotRecord(destination, {
      schemaVersion: 1,
      runId: destination.marker.runId,
      slotId: destination.slotId,
      recordedAt: new Date().toISOString(),
      attempts: [{ ...attempt, rawOutput: 'forbidden' }],
      effectiveAttempt: 0,
    }), /unsupported field/);
  });

  it('rejects unsupported nested provider-usage fields', () => {
    const destination = prepareMetricsDestination(path.join(runDir, 'slot.json'));
    assert.throws(() => publishSlotRecord(destination, {
      schemaVersion: 1,
      runId: destination.marker.runId,
      slotId: destination.slotId,
      recordedAt: new Date().toISOString(),
      attempts: [{
        ...attempt,
        providerUsage: { inputTokens: 4, outputTokens: 2, rawPrompt: 'forbidden' },
      }],
      effectiveAttempt: 0,
    }), /unsupported field/);
  });

  it('rejects unbounded strings and inconsistent estimates', () => {
    const destination = prepareMetricsDestination(path.join(runDir, 'slot.json'));
    const record = {
      schemaVersion: 1,
      runId: destination.marker.runId,
      slotId: destination.slotId,
      recordedAt: new Date().toISOString(),
      attempts: [{ ...attempt, model: 'x'.repeat(257) }],
      effectiveAttempt: 0,
    };
    assert.throws(() => publishSlotRecord(destination, record), /bounded string/);
    record.attempts = [{ ...attempt, inputEstimate: 2 }];
    assert.throws(() => publishSlotRecord(destination, record), /inconsistent/);
  });

  it('allows unavailable formatted-input counts only as a null pair', () => {
    const destination = prepareMetricsDestination(path.join(runDir, 'slot.json'));
    publishSlotRecord(destination, {
      schemaVersion: 1,
      runId: destination.marker.runId,
      slotId: destination.slotId,
      recordedAt: new Date().toISOString(),
      attempts: [{ ...attempt, inputChars: null, inputEstimate: null, result: 'error' }],
      effectiveAttempt: null,
    });
    const record = JSON.parse(fs.readFileSync(destination.target, 'utf8'));
    assert.equal(record.attempts[0].inputChars, null);
  });
});
