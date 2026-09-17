import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { recordDispatchMetrics } from '../../../skills/dispatch/scripts/slot-metrics.mjs';
import {
  finalizeRun,
  initRun,
  pinBaseline,
} from '../../../skills/implement-dispatch/scripts/run-record.mjs';

let repo;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'run-record-'));
  const git = spawnSync('git', ['init', '--quiet'], { cwd: repo, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
});

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const result = {
  effectiveAttempt: 0,
  metricsAttempts: [{
    provider: 'copilot',
    model: 'gpt',
    effort: null,
    mode: 'cli',
    inputChars: 8,
    inputEstimate: 2,
    outputChars: 4,
    outputEstimate: 1,
    toolTurns: null,
    providerUsage: null,
    result: 'ok',
    failureKind: null,
    truncated: null,
  }],
};

describe('run records', () => {
  it('initializes beneath the absolute Git common directory with a portable id', () => {
    const initialized = initRun({ repoRoot: repo, now: new Date('2026-09-16T11:00:00Z') });
    assert.match(initialized.runId, /^20260916T110000Z-[a-f0-9]{6}$/);
    assert.ok(initialized.runDir.startsWith(path.join(fs.realpathSync(repo), '.git', 'dispatch-skills', 'runs')));
    assert.ok(fs.existsSync(initialized.markerPath));
  });

  it('finalizes the exact launched-slot count and aggregates attempts', () => {
    const initialized = initRun({ repoRoot: repo });
    recordDispatchMetrics(path.join(initialized.runDir, 'plan-r1-s1.json'), result);
    const run = finalizeRun({
      runDir: initialized.runDir,
      expectedSlots: 1,
      summary: {
        requestedLevel: 'high',
        initialLevel: 'high',
        finalLevel: 'high',
        waves: [{
          phase: 'plan-review',
          round: 1,
          effectiveLevel: 'high',
          slotIds: ['plan-r1-s1'],
          sourceKeys: ['plan-review:R1:copilot:0'],
          substitutions: [{
            kind: 'reserve',
            failedSlot: 'plan-r1-s1',
            replacementSlot: 'plan-r1-s2',
            attemptedCandidateId: 'plan-review:copilot:0',
            effectiveSourceKey: 'plan-review:R1:claude:0',
            substitutesFor: 'plan-review:R1:copilot:0',
            reason: 'quota',
          }],
        }],
        totals: { liveFindings: 0, settledFindings: 2, substitutions: 0 },
      },
    });
    assert.equal(run.aggregate.inputChars, 8);
    assert.equal(run.aggregate.successfulSlots, 1);
    assert.ok(fs.existsSync(path.join(initialized.runDir, 'run.json')));
  });

  it('fails closed on expected-count mismatch', () => {
    const initialized = initRun({ repoRoot: repo });
    assert.throws(() => finalizeRun({
      runDir: initialized.runDir,
      expectedSlots: 1,
      summary: {},
    }), /Expected 1 slot record/);
  });

  it('pins, replaces, and clears a baseline label', () => {
    const first = initRun({ repoRoot: repo });
    finalizeRun({ runDir: first.runDir, expectedSlots: 0 });
    let index = pinBaseline({ repoRoot: repo, runDir: first.runDir, label: 'phase0:corpus-v1' });
    assert.equal(index.labels['phase0:corpus-v1'].runId, first.runId);

    const second = initRun({ repoRoot: repo });
    finalizeRun({ runDir: second.runDir, expectedSlots: 0 });
    index = pinBaseline({ repoRoot: repo, runDir: second.runDir, label: 'phase0:corpus-v1' });
    assert.equal(index.labels['phase0:corpus-v1'].runId, second.runId);

    index = pinBaseline({ repoRoot: repo, label: 'phase0:corpus-v1', clear: true });
    assert.equal(index.labels['phase0:corpus-v1'], undefined);
  });

  it('rejects a finalized run from another repository when pinning', () => {
    const otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'run-record-other-'));
    try {
      assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: otherRepo }).status, 0);
      const foreign = initRun({ repoRoot: otherRepo });
      finalizeRun({ runDir: foreign.runDir, expectedSlots: 0 });
      assert.throws(() => pinBaseline({
        repoRoot: repo,
        runDir: foreign.runDir,
        label: 'phase0:corpus-v1',
      }), /must belong to this repository/);
    } finally {
      fs.rmSync(otherRepo, { recursive: true, force: true });
    }
  });

  it('applies finalized-run retention only after the new manifest is durable', () => {
    const runsDir = path.join(repo, '.git', 'dispatch-skills', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    for (let index = 0; index < 101; index++) {
      const runDir = path.join(runsDir, `old-${String(index).padStart(3, '0')}`);
      fs.mkdirSync(runDir);
      fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
        schemaVersion: 1,
        runId: path.basename(runDir),
        finalizedAt: new Date(Date.UTC(2020, 0, index + 1)).toISOString(),
      }));
    }

    const initialized = initRun({ repoRoot: repo });
    assert.equal(fs.readdirSync(runsDir).length, 102);
    finalizeRun({ runDir: initialized.runDir, expectedSlots: 0 });
    assert.equal(fs.readdirSync(runsDir).length, 100);
    assert.equal(fs.existsSync(path.join(initialized.runDir, 'run.json')), true);
  });

  it('does not parse historical finalized manifests during initialization', () => {
    const runsDir = path.join(repo, '.git', 'dispatch-skills', 'runs');
    const corrupt = path.join(runsDir, 'corrupt-finalized');
    fs.mkdirSync(corrupt, { recursive: true });
    fs.writeFileSync(path.join(corrupt, 'run.json'), '{');
    assert.doesNotThrow(() => initRun({ repoRoot: repo }));
  });

  it('rejects unknown summary fields', () => {
    const initialized = initRun({ repoRoot: repo });
    assert.throws(() => finalizeRun({
      runDir: initialized.runDir,
      expectedSlots: 0,
      summary: { rawReport: 'forbidden' },
    }), /unsupported field/);
  });

  it('rejects unknown nested summary fields and unbounded diagnostic text', () => {
    const initialized = initRun({ repoRoot: repo });
    assert.throws(() => finalizeRun({
      runDir: initialized.runDir,
      expectedSlots: 0,
      summary: {
        waves: [{
          phase: 'code-review',
          round: 1,
          effectiveLevel: 'high',
          slotIds: [],
          rawReport: 'forbidden',
        }],
      },
    }), /unsupported field/);

    assert.throws(() => finalizeRun({
      runDir: initialized.runDir,
      expectedSlots: 0,
      summary: {
        waves: [{
          phase: 'code-review',
          round: 1,
          effectiveLevel: 'high',
          slotIds: [],
          substitutions: [{
            kind: 'native-fallback',
            failedSlot: 'code-r1-copilot',
            replacementSlot: null,
            reason: 'raw error text with spaces',
          }],
        }],
      },
    }), /substitutions\[0\] is invalid/);
  });

  it('rejects an open or malformed baseline index schema', () => {
    const initialized = initRun({ repoRoot: repo });
    finalizeRun({ runDir: initialized.runDir, expectedSlots: 0 });
    const indexPath = path.join(repo, '.git', 'dispatch-skills', 'baselines.json');
    fs.writeFileSync(indexPath, JSON.stringify({
      schemaVersion: 1,
      labels: {
        'phase0:corpus-v1': {
          runId: initialized.runId,
          runDir: initialized.runDir,
          pinnedAt: new Date().toISOString(),
          rawReport: 'forbidden',
        },
      },
    }));
    assert.throws(() => pinBaseline({
      repoRoot: repo,
      runDir: initialized.runDir,
      label: 'phase0:corpus-v1',
    }), /Baseline index entry/);
  });
});
