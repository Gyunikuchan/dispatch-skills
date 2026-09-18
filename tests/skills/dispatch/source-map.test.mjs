import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

import { buildSourceMap, formatSourceMapLine } from '../../../skills/dispatch/scripts/source-map.mjs';
import { scanResolutionLog } from '../../../skills/dispatch/scripts/resolution-log.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = path.join(root, 'skills', 'dispatch', 'scripts', 'source-map.mjs');

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function record(overrides = {}) {
  return {
    sourceKey: 'plan-review:R2:agy:0',
    platform: 'agy',
    candidateIndex: 0,
    role: 'target',
    model: 'gemini-3.8-flash',
    effort: 'medium',
    session: null,
    substitutesFor: null,
    ...overrides,
  };
}

const BATCH = {
  targets: [
    record(),
    record({
      sourceKey: 'plan-review:R2:opencode:0',
      platform: 'opencode',
      role: 'reserve',
      model: null,
      effort: 'max',
      session: 'ses_1',
      substitutesFor: 'plan-review:R2:claude:0',
    }),
  ],
  failures: [record({ sourceKey: 'plan-review:R2:claude:0', platform: 'claude' })],
};

describe('buildSourceMap', () => {
  it('maps terminal successes to target and reserve records', () => {
    assert.deepEqual(buildSourceMap(BATCH, { round: 2 }), {
      'plan-review:R2:agy:0': {
        provider: 'agy', candidateIndex: 0, model: 'gemini-3.8-flash', effort: 'medium',
        status: 'target', session: null, substitutesFor: null,
      },
      'plan-review:R2:opencode:0': {
        provider: 'opencode', candidateIndex: 0, model: null, effort: 'max',
        status: 'reserve', session: 'ses_1', substitutesFor: 'plan-review:R2:claude:0',
      },
    });
  });

  it('merges extra fallback records, including when targets is empty', () => {
    const fallback = {
      'plan-review:R2:claude:0': {
        provider: 'claude', candidateIndex: 0, model: 'claude-opus-5', effort: 'low',
        status: 'fallback', session: null, substitutesFor: null,
      },
    };
    assert.deepEqual(buildSourceMap({ targets: [] }, { round: 2, extra: fallback }), fallback);
  });

  it('rejects duplicate extra keys and names the invalid field', () => {
    assert.throws(
      () => buildSourceMap(BATCH, { round: 2, extra: { 'plan-review:R2:agy:0': {} } }),
      /duplicates a batch source/,
    );
    assert.throws(
      () => buildSourceMap({ targets: [record({ platform: 'claude' })] }, { round: 2 }),
      /"plan-review:R2:agy:0" is invalid: provider must be "agy"/,
    );
    assert.throws(() => buildSourceMap(BATCH, { round: 3 }), /key round must be R3/);
    assert.throws(
      () => buildSourceMap({ targets: [record(), record()] }, { round: 2 }),
      /batch source "plan-review:R2:agy:0" is duplicated/,
    );
  });

  it('formats a line the strict resolution-log parser accepts', () => {
    const line = formatSourceMapLine(buildSourceMap(BATCH, { round: 2 }));
    const doc = [
      '# Plan',
      '## Review Findings & Resolutions',
      '### Round 1 — 2026-09-18',
      '### Round 2 — 2026-09-18',
      line,
      '- **[Accepted]** [R2-F001] [MUST] [sources=plan-review:R2:agy:0] § Plan — correctness: gap → fixed.',
    ].join('\n');
    const scan = scanResolutionLog(doc, { strict: true });
    assert.equal(Object.keys(scan.rounds[1].sourceMap).length, 2);
  });
});

describe('source-map CLI', () => {
  it('prints the line, exits 1 on invalid records and 2 on usage errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-map-test-'));
    tempDirs.push(dir);
    const batchPath = path.join(dir, 'batch.json');
    fs.writeFileSync(batchPath, JSON.stringify(BATCH));

    const ok = spawnSync(process.execPath, [cli, '--round', '2', '--batch', batchPath], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^- \*\*Sources:\*\* \{"plan-review:R2:agy:0":/);

    const invalid = spawnSync(process.execPath, [cli, '--round', '3', '--batch', batchPath], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);

    const usage = spawnSync(process.execPath, [cli, '--batch', batchPath], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
  });
});
