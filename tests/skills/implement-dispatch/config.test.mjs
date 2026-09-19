import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { parseJsonc } from '../../../skills/dispatch/scripts/common.mjs';
import {
  getImplementDispatchConfigCandidates,
  loadConfig,
  resolveFlow,
  validateConfig,
} from '../../../skills/implement-dispatch/scripts/resolve-flow.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// Liveness stub: claude is the orchestrator, copilot dead.
const LIVE_ALL = { claude: true, agy: true, copilot: false, opencode: true };

/**
 * Snapshot of the shipped per-level flow policy, so a change to config.sample.jsonc
 * is a deliberate, checked-in assertion update. `targets` is the resulting target
 * count under LIVE_ALL (agy + opencode live, copilot dead, claude the orchestrator);
 * `reserves` is the count of leftover live candidates kept as substitutes.
 */
const LEVEL_PARITY = {
  low: {
    'plan-review': { maxRounds: 0, targetCount: 0, consensus: false, targets: 0, reserves: 0 },
    'code-review': { maxRounds: 1, targetCount: 1, consensus: false, targets: 1, reserves: 3 },
  },
  medium: {
    'plan-review': { maxRounds: 2, targetCount: 1, consensus: true, targets: 1, reserves: 3 },
    'code-review': { maxRounds: 3, targetCount: 2, consensus: true, targets: 2, reserves: 2 },
  },
  high: {
    'plan-review': { maxRounds: 3, targetCount: 2, consensus: true, targets: 2, reserves: 2 },
    'code-review': { maxRounds: 3, targetCount: 3, consensus: true, targets: 3, reserves: 1 },
  },
  xhigh: {
    'plan-review': { maxRounds: 3, targetCount: 3, consensus: true, targets: 3, reserves: 1 },
    'code-review': { maxRounds: 3, targetCount: 4, consensus: true, targets: 4, reserves: 0 },
  },
  max: {
    'plan-review': { maxRounds: 5, targetCount: 'all', consensus: true, targets: 4, reserves: 0 },
    'code-review': { maxRounds: 5, targetCount: 'all', consensus: true, targets: 4, reserves: 0 },
  },
};

const SAMPLE_CONFIG = parseJsonc(
  readFileSync(path.join(REPO_ROOT, 'skills', 'implement-dispatch', 'config.sample.jsonc'), 'utf8'),
);

describe('shipped config', () => {
  it('validates with no problems', () => {
    assert.deepEqual(validateConfig(SAMPLE_CONFIG), []);
  });

  describe('shipped level policy snapshot', () => {
    for (const [level, sections] of Object.entries(LEVEL_PARITY)) {
      it(`reproduces ${level}`, () => {
        const config = SAMPLE_CONFIG;
        const flow = resolveFlow({ platform: 'claude', level }, LIVE_ALL, config);
        for (const [section, expected] of Object.entries(sections)) {
          assert.equal(flow[section].maxRounds, expected.maxRounds, `${section} maxRounds`);
          assert.equal(flow[section].consensus, expected.consensus, `${section} consensus`);
          // `targetCount` is asserted only through its observable
          // effect: re-reading it with `resolveLevelScalar` here would re-implement
          // the resolver and pass even if `buildReviewSection` stopped consuming it.
          assert.equal(flow[section].targets.length, expected.targets, `${section} targets`);
          assert.equal(flow[section].reserves.length, expected.reserves, `${section} reserves`);
          // targetCount:0 normalizes to maxRounds:0; assert the single sentinel.
          assert.equal(flow[section].maxRounds === 0, expected.targetCount === 0 || expected.maxRounds === 0, `${section} phase-off`);
        }
      });
    }
  });

});

describe('loadConfig', () => {
  /** Writes files at a temp skill root and loads config via loadConfig. */
  function loadFromFiles(files, options) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'resolve-flow-'));
    try {
      mkdirSync(path.join(root, 'scripts'));
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(path.join(root, name), content, 'utf8');
      }
      return loadConfig(path.join(root, 'scripts'), options);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  function loadFromSource(source) {
    return loadFromFiles({ 'config.jsonc': source });
  }

  it('prefers config.local.jsonc over config.jsonc', () => {
    const loaded = loadFromFiles({
      'config.local.jsonc': '{ "marker": "local-jsonc" }',
      'config.jsonc': '{ "marker": "jsonc", "extra": "not-merged" }',
    });
    assert.deepEqual(loaded, { marker: 'local-jsonc' });
  });

  it('loads config.jsonc when config.local.jsonc is absent', () => {
    const loaded = loadFromFiles({
      'config.jsonc': '{ "marker": "jsonc" }',
    });
    assert.deepEqual(loaded, { marker: 'jsonc' });
  });

  it('loads config fully without merging missing keys from lower-precedence files', () => {
    const loaded = loadFromFiles({
      'config.local.jsonc': '{ "onlyLocal": 123 }',
      'config.jsonc': '{ "onlyJsonc": 456 }',
    });
    assert.deepEqual(loaded, { onlyLocal: 123 });
    assert.equal(loaded.onlyJsonc, undefined);
  });

  it('strips line comments', () => {
    assert.deepEqual(loadFromSource('// leading\n{ "a": 1 } // trailing\n'), { a: 1 });
  });

  it('strips block comments, including multi-line ones', () => {
    assert.deepEqual(loadFromSource('/* one\n * two\n */\n{ "a": /* inline */ 1 }'), { a: 1 });
  });

  it('keeps comment-like sequences inside strings', () => {
    assert.deepEqual(
      loadFromSource('{ "a": "http://x/y", "b": "/* not a comment */", "c": "esc\\"// still" }'),
      { a: 'http://x/y', b: '/* not a comment */', c: 'esc"// still' }
    );
  });

  it('tolerates trailing commas in objects and arrays', () => {
    assert.deepEqual(loadFromSource('{ "a": [1, 2,], "b": { "c": 3, }, }'), {
      a: [1, 2],
      b: { c: 3 },
    });
  });

  it('throws on an unterminated block comment', () => {
    assert.throws(() => loadFromSource('{ "a": 1 } /* never closed'), /Unterminated block comment/);
  });

  it('throws when no config file exists', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'resolve-flow-'));
    try {
      mkdirSync(path.join(root, 'scripts'));
      assert.throws(
        () => loadConfig(path.join(root, 'scripts')),
        (err) => /Config file not found/.test(err.message) && /config\.sample\.jsonc/.test(err.message),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('getImplementDispatchConfigCandidates', () => {
  it('returns candidate paths for a given scriptDir', () => {
    const candidates = getImplementDispatchConfigCandidates('/skill/scripts');
    const expectedRoot = path.resolve('/skill/scripts', '..');
    assert.deepEqual(
      candidates,
      [
        path.join(expectedRoot, 'config.local.jsonc'),
        path.join(expectedRoot, 'config.jsonc'),
      ],
    );
  });
});
