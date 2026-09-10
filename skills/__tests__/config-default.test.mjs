import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { PROJECT_ROOT } from '../dispatch/scripts/common.mjs';
import {
  loadConfig,
  resolveFlow,
  validateConfig,
} from '../implement-dispatch/scripts/resolve-flow.mjs';

// Liveness stub: claude is the orchestrator, copilot dead.
const LIVE_ALL = { claude: true, agy: true, copilot: false, opencode: true };

/**
 * Expected flow policy per level, hardcoded from the pre-change LEVEL_CONFIG table so
 * that parity with the deleted constant is a checked-in assertion rather than a
 * one-shot manual diff. Its `none` / `one` / `all` breadth vocabulary maps to
 * `targetCount` as 0 / 1 / "all"; `targets` is the resulting target count under
 * LIVE_ALL (agy + opencode live, copilot dead, claude the orchestrator).
 */
const LEVEL_PARITY = {
  low: {
    'plan-review': { maxRounds: 0, targetCount: 0, consensus: false, includeSelf: false, targets: 0 },
    'code-review': { maxRounds: 1, targetCount: 1, consensus: false, includeSelf: false, targets: 1 },
  },
  medium: {
    'plan-review': { maxRounds: 1, targetCount: 1, consensus: false, includeSelf: false, targets: 1 },
    'code-review': { maxRounds: 3, targetCount: 1, consensus: false, includeSelf: false, targets: 1 },
  },
  high: {
    'plan-review': { maxRounds: 1, targetCount: 1, consensus: true, includeSelf: false, targets: 1 },
    'code-review': { maxRounds: 3, targetCount: 'all', consensus: true, includeSelf: false, targets: 2 },
  },
  max: {
    'plan-review': { maxRounds: 3, targetCount: 'all', consensus: true, includeSelf: true, targets: 3 },
    'code-review': { maxRounds: 5, targetCount: 'all', consensus: true, includeSelf: true, targets: 3 },
  },
};

describe('shipped config', () => {
  it('validates with no problems', () => {
    assert.deepEqual(validateConfig(loadConfig(undefined, { defaultOnly: true })), []);
  });

  describe('level parity with the pre-change LEVEL_CONFIG', () => {
    for (const [level, sections] of Object.entries(LEVEL_PARITY)) {
      it(`reproduces ${level}`, () => {
        const config = loadConfig(undefined, { defaultOnly: true });
        const flow = resolveFlow({ platform: 'claude', level }, LIVE_ALL, config);
        for (const [section, expected] of Object.entries(sections)) {
          assert.equal(flow[section].maxRounds, expected.maxRounds, `${section} maxRounds`);
          assert.equal(flow[section].consensus, expected.consensus, `${section} consensus`);
          // `targetCount` and `includeSelf` are asserted only through their observable
          // effect: re-reading them with `resolveLevelScalar` here would re-implement
          // the resolver and pass even if `buildReviewSection` stopped consuming them.
          assert.equal(flow[section].targets.length, expected.targets, `${section} targets`);
          // targetCount:0 normalizes to maxRounds:0; assert the single sentinel.
          assert.equal(flow[section].maxRounds === 0, expected.targetCount === 0 || expected.maxRounds === 0, `${section} phase-off`);
        }
      });
    }
  });

  it('ladders the tool-turn budget across levels', () => {
    const config = loadConfig(undefined, { defaultOnly: true });
    const expected = { low: 3, medium: 4, high: 6, max: 8 };
    for (const [level, turns] of Object.entries(expected)) {
      const flow = resolveFlow({ platform: 'claude', level }, LIVE_ALL, config);
      assert.equal(flow['plan-review'].toolTurns, turns, `plan-review at ${level}`);
      assert.equal(flow['code-review'].toolTurns, turns, `code-review at ${level}`);
    }
  });
});

describe('loadConfig', () => {
  /** Writes `config.jsonc` at a temp skill root and loads it via loadConfig. */
  function loadFromSource(source) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'resolve-flow-'));
    try {
      mkdirSync(path.join(root, 'scripts'));
      writeFileSync(path.join(root, 'config.jsonc'), source, 'utf8');
      return loadConfig(path.join(root, 'scripts'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('prefers a local config.jsonc over the default', () => {
    assert.deepEqual(loadFromSource('{ "marker": "local" }'), { marker: 'local' });
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
      assert.throws(() => loadConfig(path.join(root, 'scripts')), /Config file not found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe('project-root override', () => {
    // `<PROJECT_ROOT>/.implement-dispatch/config.jsonc` lets a per-repo override reach a
    // globally-installed skill (`~/.agents/skills`), which otherwise has one config.jsonc
    // shared across every project. Exercised against the real PROJECT_ROOT since it's a
    // module-level constant resolved once at import time.
    const overrideDir = path.join(PROJECT_ROOT, '.implement-dispatch');
    const overridePath = path.join(overrideDir, 'config.jsonc');

    function withOverride(source, fn) {
      mkdirSync(overrideDir, { recursive: true });
      writeFileSync(overridePath, source, 'utf8');
      try {
        fn();
      } finally {
        rmSync(overrideDir, { recursive: true, force: true });
      }
    }

    it('prefers the project-root override over a skill-local config.jsonc', () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'resolve-flow-'));
      try {
        mkdirSync(path.join(root, 'scripts'));
        writeFileSync(path.join(root, 'config.jsonc'), '{ "marker": "skill-local" }', 'utf8');
        withOverride('{ "marker": "project-override" }', () => {
          assert.deepEqual(loadConfig(path.join(root, 'scripts')), { marker: 'project-override' });
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('falls back to the skill-local config.jsonc when no project override exists', () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'resolve-flow-'));
      try {
        mkdirSync(path.join(root, 'scripts'));
        writeFileSync(path.join(root, 'config.jsonc'), '{ "marker": "skill-local" }', 'utf8');
        assert.deepEqual(loadConfig(path.join(root, 'scripts')), { marker: 'skill-local' });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('is ignored under defaultOnly', () => {
      withOverride('{ "marker": "project-override" }', () => {
        assert.deepEqual(validateConfig(loadConfig(undefined, { defaultOnly: true })), []);
      });
    });
  });
});
