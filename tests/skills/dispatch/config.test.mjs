import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, beforeEach, afterEach } from 'node:test';

import {
  getConfigCandidates,
  loadSkillConfig,
  parseJsonc,
  KNOWN_PROVIDERS,
} from '../../../skills/dispatch/scripts/common.mjs';
import * as common from '../../../skills/dispatch/scripts/common.mjs';
import {
  detectLegacyConfig,
  LEVELS,
  loadDispatchConfig,
  phaseMembers,
  resolveLevelEntry,
  resolveLevelScalar,
  resolvePlatformCandidates,
  resolveReadDelegates,
  REVIEW_PHASES,
  selectLevel,
  validateConfig,
} from '../../../skills/dispatch/scripts/config.mjs';
import { resolveFlow } from '../../../skills/dispatch/scripts/resolve-flow.mjs';
import { buildStubDispatchFixture, runStubDispatch } from '../../helpers/stub-dispatch.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SAMPLE_CONFIG = parseJsonc(readFileSync(path.join(REPO_ROOT, 'skills', 'dispatch', 'config.sample.jsonc'), 'utf8'));

const VALID = {
  'read-delegates': {
    claude: { model: 'claude-opus-5', effort: 'low', sandbox: true },
    agy: { model: 'gemini-3.8-flash', effort: 'medium' },
    copilot: { model: 'gpt-6-astra', effort: 'low', sandbox: true },
    opencode: [{ model: 'opencode-go/glm-5.3-flash', effort: 'max' }, { model: 'lmstudio/qwen3.8-27b-ridge', effort: 'medium' }],
  },
  'write-subagents': {
    claude: { model: 'claude-sonnet-5', effort: 'medium', high: { model: 'claude-opus-5' } },
    copilot: { model: ['gpt-5.6-luna', 'bedrock.gpt-5.6-luna'], effort: 'max' },
  },
  phases: {
    'plan-review': { rounds: { low: 0, medium: 2 }, targets: { low: 0, medium: 1 }, consensus: { low: false, medium: true } },
    'design-review': { rounds: { medium: 2 }, targets: { medium: 1 }, consensus: { medium: true }, only: ['claude', 'antigravity'] },
    'code-review': { rounds: { low: 1 }, targets: { low: 1, max: 'all' }, consensus: { low: false } },
  },
};

/** Clone of VALID with table-level patches; `phases.<phase>` patches merge into that phase. */
function withTables({ phases: phasePatches = {}, ...tables } = {}) {
  const phases = Object.fromEntries(Object.entries(VALID.phases).map(([k, v]) => [k, { ...v }]));
  for (const [phase, patch] of Object.entries(phasePatches)) phases[phase] = { ...phases[phase], ...patch };
  return { 'read-delegates': VALID['read-delegates'], 'write-subagents': VALID['write-subagents'], phases, ...tables };
}

const problemsOf = (config) => validateConfig(config).join('\n');

/** The v0.4 → v0.5 key-map diagnostic, never naming the retired skill. */
function assertKeyMap(text) {
  assert.match(text, /targetCount\s*(→|->)\s*targets/);
  assert.match(text, /maxRounds\s*(→|->)\s*rounds/);
  assert.match(text, /platforms\s*(→|->)\s*only/);
  assert.match(text, /implementation\s*(→|->)\s*write-subagents/);
  assert.match(text, /platforms\s*(→|->)\s*read-delegates/);
  assert.match(text, /the retired implement config/);
  assert.doesNotMatch(text, /implement-dispatch/);
}

describe('getConfigCandidates', () => {
  it('returns the 2-path precedence list in order', () => {
    const candidates = getConfigCandidates({ skillRoot: '/skill' });
    assert.deepEqual(
      candidates.map((p) => p.split(path.sep).join('/')),
      ['/skill/config.local.jsonc', '/skill/config.jsonc'],
    );
  });
});

describe('loadSkillConfig (generic)', () => {
  let skillRoot;
  beforeEach(() => { skillRoot = mkdtempSync(path.join(os.tmpdir(), 'load-skill-config-skill-')); });
  afterEach(() => { rmSync(skillRoot, { recursive: true, force: true }); });

  it('throws listing every tried path and naming config.sample.jsonc when none exist', () => {
    assert.throws(() => loadSkillConfig({ skillRoot }), /Config file not found: tried .*config\.local\.jsonc.*config\.jsonc/s);
    assert.throws(() => loadSkillConfig({ skillRoot }), /config\.sample\.jsonc/);
  });

  it('loads wholly (no merge) and prefers config.local.jsonc', () => {
    writeFileSync(path.join(skillRoot, 'config.jsonc'), '{ "read-delegates": { "claude": {}, "agy": {} } }');
    writeFileSync(path.join(skillRoot, 'config.local.jsonc'), '{ "read-delegates": { "copilot": {} } }');
    const { config, path: usedPath } = loadSkillConfig({ skillRoot });
    assert.deepEqual(config, { 'read-delegates': { copilot: {} } });
    assert.equal(usedPath, path.join(skillRoot, 'config.local.jsonc'));
  });

  it('loads config.jsonc when config.local.jsonc is absent', () => {
    writeFileSync(path.join(skillRoot, 'config.jsonc'), '{ "read-delegates": { "copilot": {} } }');
    const { path: usedPath } = loadSkillConfig({ skillRoot });
    assert.equal(usedPath, path.join(skillRoot, 'config.jsonc'));
  });

  it('parses JSONC comments, strings, and trailing commas', () => {
    writeFileSync(path.join(skillRoot, 'config.jsonc'), '// c\n{ "a": "http://x/y", /* b */ "b": [1, 2,], }');
    assert.deepEqual(loadSkillConfig({ skillRoot }).config, { a: 'http://x/y', b: [1, 2] });
  });
});

describe('common.mjs no longer owns dispatch schema validation', () => {
  it('drops validateDispatchConfig', () => {
    assert.equal(common.validateDispatchConfig, undefined);
  });
});

describe('constants', () => {
  it('exports the five levels and three review phases in order', () => {
    assert.deepEqual([...LEVELS], ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual([...REVIEW_PHASES], ['plan-review', 'design-review', 'code-review']);
  });
});

describe('validateConfig (v0.5 schema)', () => {
  it('accepts a full three-table config', () => {
    assert.deepEqual(validateConfig(VALID), []);
  });

  it('accepts an ask-only config (read-delegates alone)', () => {
    assert.deepEqual(validateConfig({ 'read-delegates': { claude: {} } }), []);
  });

  it('rejects a non-object root', () => {
    for (const root of [null, [], 'x']) {
      const problems = validateConfig(root);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /Config must be a JSON object/);
    }
  });

  it('requires read-delegates and names config.sample.jsonc', () => {
    const text = problemsOf({});
    assert.match(text, /read-delegates/);
    assert.match(text, /config\.sample\.jsonc/);
  });

  it('rejects unknown top-level keys', () => {
    assert.match(problemsOf({ ...VALID, extra: 1 }), /Unrecognized top-level key "extra"/);
  });

  it('rejects every v0.4 top-level key', () => {
    for (const key of ['platforms', 'plan-review', 'code-review', 'design-review', 'implementation']) {
      assert.ok(validateConfig({ ...VALID, [key]: {} }).length > 0, key);
    }
  });

  describe('read-delegates', () => {
    it('rejects an empty map', () => {
      assert.match(problemsOf({ 'read-delegates': {} }), /at least one platform/);
    });

    it('rejects an unknown platform key, listing the valid keys', () => {
      const text = problemsOf({ 'read-delegates': { bogus: {} } });
      assert.match(text, /bogus/);
      assert.match(text, new RegExp(KNOWN_PROVIDERS.join(', ')));
    });

    it('accepts alias keys and rejects duplicates after alias normalization', () => {
      assert.deepEqual(validateConfig({ 'read-delegates': { antigravity: {}, claudecode: {} } }), []);
      const text = problemsOf({ 'read-delegates': { agy: {}, antigravity: {} } });
      assert.match(text, /duplicate/i);
      assert.match(text, /agy/);
    });

    it('rejects the reserved pin keyword "all"', () => {
      assert.match(problemsOf({ 'read-delegates': { all: { model: 'm' } } }), /reserved pin keyword "all"/);
    });

    it('type-checks model, effort, and sandbox', () => {
      assert.match(problemsOf({ 'read-delegates': { agy: { model: 5 } } }), /read-delegates\.agy\.model must be a string/);
      assert.match(problemsOf({ 'read-delegates': { claude: { model: [] } } }), /read-delegates\.claude\.model must be a string/);
      assert.match(problemsOf({ 'read-delegates': { claude: { model: 'claude:' } } }), /read-delegates\.claude\.model must be a string/);
      assert.match(problemsOf({ 'read-delegates': { claude: { effort: '   ' } } }), /read-delegates\.claude\.effort must be a string/);
      assert.match(problemsOf({ 'read-delegates': { copilot: { sandbox: 'yes' } } }), /read-delegates\.copilot\.sandbox must be a boolean/);
    });

    it('accepts sandbox only on Claude and Copilot', () => {
      assert.deepEqual(validateConfig({ 'read-delegates': { claude: { sandbox: false }, copilot: { sandbox: true } } }), []);
      for (const platform of ['agy', 'opencode']) {
        assert.match(
          problemsOf({ 'read-delegates': { [platform]: { sandbox: true } } }),
          new RegExp(`read-delegates\\.${platform}.*unrecognized key "sandbox"`),
        );
      }
    });

    it('rejects an unrecognized key in an entry or candidate', () => {
      assert.match(problemsOf({ 'read-delegates': { claude: { timeout: 10 } } }), /unrecognized key "timeout"/);
      assert.match(problemsOf({ 'read-delegates': { opencode: [{ model: 'x', timeout: 10 }] } }), /read-delegates\.opencode\[0\].*unrecognized key "timeout"/);
    });

    it('validates candidate arrays', () => {
      assert.match(problemsOf({ 'read-delegates': { opencode: [] } }), /read-delegates\.opencode must define at least one candidate/);
      assert.match(problemsOf({ 'read-delegates': { opencode: ['x'] } }), /read-delegates\.opencode\[0\] must be an object/);
    });

    it('validates inline level overrides (object or candidate array)', () => {
      assert.deepEqual(
        validateConfig({ 'read-delegates': { opencode: { model: 'a', effort: 'medium', high: [{ model: 'b', effort: 'medium' }, { model: 'c', effort: 'medium' }] }, claude: { max: { sandbox: false } } } }),
        [],
      );
      const misspelled = problemsOf({ 'read-delegates': { agy: { low: { modle: 'x' } } } });
      assert.match(misspelled, /read-delegates\.agy\.low/);
      assert.match(misspelled, /modle/);
      assert.match(problemsOf({ 'read-delegates': { agy: { low: {} } } }), /read-delegates\.agy\.low must set at least one of model, effort/);
      const badLevel = problemsOf({ 'read-delegates': { agy: { model: 'm', hgih: { effort: 'high' } } } });
      assert.match(badLevel, /hgih/);
      assert.match(badLevel, /low, medium, high, xhigh, max/);
      assert.match(problemsOf({ 'read-delegates': { agy: { model: 'm', high: 'x' } } }), /read-delegates\.agy.*high/);
    });
  });

  describe('write-subagents', () => {
    it('accepts object entries with model cascades and level overrides', () => {
      assert.deepEqual(validateConfig(withTables()), []);
    });

    it('rejects candidate arrays, including in level overrides', () => {
      assert.match(problemsOf(withTables({ 'write-subagents': { claude: [{ model: 'm' }] } })), /write-subagents\.claude must be an object/);
      assert.match(
        problemsOf(withTables({ 'write-subagents': { claude: { high: [{ model: 'm' }] } } })),
        /write-subagents\.claude\.high must be an object with model\/effort/,
      );
    });

    it('type-checks model arrays', () => {
      for (const model of [[], [5], [''], ['claude:']]) {
        assert.match(
          problemsOf(withTables({ 'write-subagents': { copilot: { model } } })),
          /write-subagents\.copilot\.model must be a string or array of strings/,
        );
      }
    });

    it('rejects unknown platform keys', () => {
      assert.match(problemsOf(withTables({ 'write-subagents': { bogus: { model: 'm' } } })), /bogus/);
    });
  });

  describe('phases', () => {
    it('rejects an unknown phase key', () => {
      assert.match(problemsOf(withTables({ phases: { 'bogus-review': { rounds: { low: 1 } } } })), /bogus-review/);
    });

    it('requires targets, rounds, and consensus within a present phase', () => {
      const phase = { ...VALID.phases['code-review'] };
      delete phase.rounds;
      const config = { ...VALID, phases: { ...VALID.phases, 'code-review': phase } };
      assert.match(problemsOf(config), /phases\.code-review.*missing required knob "rounds"/);
    });

    it('rejects v0.4 knob names inside a phase', () => {
      assert.match(problemsOf(withTables({ phases: { 'code-review': { maxRounds: { low: 1 } } } })), /unrecognized key "maxRounds"/);
      assert.match(problemsOf(withTables({ phases: { 'code-review': { platforms: {} } } })), /unrecognized key "platforms"/);
    });

    it('type-checks knob values and level keys', () => {
      const text = problemsOf(withTables({
        phases: { 'code-review': { rounds: { low: -1 }, targets: { low: 'two' }, consensus: { low: 'yes' } } },
      }));
      assert.match(text, /phases\.code-review\.rounds\.low must be a non-negative integer/);
      assert.match(text, /phases\.code-review\.targets\.low must be a non-negative integer or "all"/);
      assert.match(text, /phases\.code-review\.consensus\.low must be a boolean/);
      assert.match(problemsOf(withTables({ phases: { 'code-review': { rounds: { lwo: 1 } } } })), /unrecognized level "lwo"/);
      assert.match(problemsOf(withTables({ phases: { 'code-review': { rounds: 3 } } })), /phases\.code-review\.rounds must be an object keyed by level/);
      assert.match(problemsOf(withTables({ phases: { 'code-review': { rounds: {} } } })), /at least one level/);
    });

    it('validates only: non-empty array of read-delegate keys or aliases', () => {
      assert.match(problemsOf(withTables({ phases: { 'code-review': { only: [] } } })), /phases\.code-review\.only/);
      const absent = problemsOf(withTables({
        'read-delegates': { claude: {}, agy: {} },
        phases: { 'code-review': { only: ['opencode'] } },
        'write-subagents': {},
      }));
      assert.match(absent, /phases\.code-review\.only/);
      assert.match(absent, /opencode/);
    });
  });

  it('reports every problem in one pass', () => {
    const problems = validateConfig({
      extra: 1,
      'read-delegates': { claude: { model: 5 }, bogus: {} },
      phases: { 'code-review': { rounds: { low: -1 } } },
    });
    assert.ok(problems.length >= 4, `expected multiple problems, got ${problems.length}`);
  });
});

describe('uniform level resolution', () => {
  describe('selectLevel', () => {
    it('picks exact, then nearest lower, then lowest higher, regardless of key order', () => {
      assert.equal(selectLevel(['low', 'high'], 'max'), 'high');
      assert.equal(selectLevel(['low', 'high'], 'medium'), 'low');
      assert.equal(selectLevel(['high', 'max'], 'low'), 'high');
      assert.equal(selectLevel(['max', 'low', 'high'], 'high'), 'high');
      assert.equal(selectLevel(['xhigh', 'low'], 'max'), 'xhigh');
      assert.equal(selectLevel([], 'medium'), undefined);
    });
  });

  describe('resolveLevelScalar', () => {
    it('matches exactly, then rounds down, then rounds up; keeps false and 0', () => {
      const knob = { medium: 3, max: 5 };
      assert.deepEqual(LEVELS.map(level => resolveLevelScalar(knob, level)), [3, 3, 3, 3, 5]);
      assert.equal(resolveLevelScalar({ low: false, high: true }, 'medium'), false);
      assert.equal(resolveLevelScalar({ low: 0, medium: 1 }, 'low'), 0);
      assert.equal(resolveLevelScalar(undefined, 'low'), undefined);
    });
  });

  describe('resolveLevelEntry', () => {
    const LEVELED = { medium: { model: 'claude-sonnet-5', effort: 'medium' }, high: { model: 'claude-opus-5', effort: 'high' } };

    it('resolves exact, nearest lower, and lowest higher', () => {
      assert.deepEqual(resolveLevelEntry(LEVELED, 'high'), { model: 'claude-opus-5', effort: 'high' });
      assert.deepEqual(resolveLevelEntry(LEVELED, 'max'), { model: 'claude-opus-5', effort: 'high' });
      assert.deepEqual(resolveLevelEntry(LEVELED, 'low'), { model: 'claude-sonnet-5', effort: 'medium' });
    });

    it('lets level keys override flat keys and treats flat entries as level-agnostic', () => {
      const mixed = { model: 'claude-opus-5', effort: 'medium', low: { model: 'claude-sonnet-5' } };
      assert.deepEqual(resolveLevelEntry(mixed, 'high'), { model: 'claude-sonnet-5', effort: 'medium' });
      assert.deepEqual(resolveLevelEntry({ model: 'x' }, 'max'), { model: 'x' });
      assert.deepEqual(resolveLevelEntry(undefined, 'medium'), {});
    });
  });

  describe('resolvePlatformCandidates', () => {
    it('resolves flat, array, and level-keyed array entries, carrying sandbox', () => {
      assert.deepEqual(resolvePlatformCandidates({ model: 'a', effort: 'medium' }, 'high'), [{ model: 'a', effort: 'medium' }]);
      assert.deepEqual(
        resolvePlatformCandidates({ model: 'd', effort: 'medium', high: [{ model: 'a' }, { model: 'b', effort: 'max' }] }, 'high'),
        [{ model: 'a', effort: 'medium' }, { model: 'b', effort: 'max' }],
      );
      assert.deepEqual(
        resolvePlatformCandidates({ model: 'c', sandbox: false, max: { model: 'm' } }, 'max'),
        [{ model: 'm', sandbox: false }],
      );
      assert.deepEqual(resolvePlatformCandidates(null, 'high'), []);
    });
  });

  describe('resolveReadDelegates', () => {
    const config = {
      'read-delegates': {
        claudecode: { model: 'a', high: { model: 'b' } },
        antigravity: [{ model: 'g1' }, { model: 'g2' }],
        copilot: { model: 'c', sandbox: false },
      },
    };

    it('returns canonical keys in config order with level-resolved candidate lists', () => {
      const resolved = resolveReadDelegates(config, 'high');
      assert.deepEqual(Object.keys(resolved.platforms), ['claude', 'agy', 'copilot']);
      assert.deepEqual(resolved.platforms.claude, [{ model: 'b' }]);
      assert.deepEqual(resolved.platforms.agy, [{ model: 'g1' }, { model: 'g2' }]);
      assert.deepEqual(resolved.platforms.copilot, [{ model: 'c', sandbox: false }]);
    });

    it('changes candidates with the level', () => {
      assert.deepEqual(resolveReadDelegates(config, 'low').platforms.claude, [{ model: 'a' }]);
    });
  });

  describe('phaseMembers', () => {
    it('filters read-delegate keys by only, keeping read-delegate order', () => {
      assert.deepEqual(phaseMembers(VALID, 'design-review'), ['claude', 'agy']);
    });

    it('returns every read-delegate key when only is absent', () => {
      assert.deepEqual(phaseMembers(VALID, 'code-review'), ['claude', 'agy', 'copilot', 'opencode']);
    });
  });
});

// SC5: v0.5.0 native-fallback model cascade — effort becomes required per resolved level.
describe('effort required per resolved level (v0.5.0 cascade)', () => {
  it('rejects a read-delegates candidate with no resolvable effort at any level', () => {
    assert.match(problemsOf({ 'read-delegates': { claude: { model: 'm' } } }), /effort/i);
  });

  it('rejects a read-delegates level override that leaves that level with no resolvable effort', () => {
    assert.match(problemsOf({ 'read-delegates': { claude: { high: { model: 'x' } } } }), /effort/i);
  });

  it('rejects a write-subagents entry with no resolvable effort', () => {
    assert.match(problemsOf(withTables({ 'write-subagents': { claude: { model: 'm' } } })), /effort/i);
  });

  it('keeps a model-only level override valid when a flat effort exists', () => {
    assert.deepEqual(validateConfig({ 'read-delegates': { claude: { model: 'm', effort: 'low', high: { model: 'x' } } } }), []);
  });

  it('CLI --model without --effort is rejected, naming --effort', () => {
    const fixture = buildStubDispatchFixture({ 'read-delegates': { claude: { model: 'claude-opus-5', effort: 'low' } } });
    try {
      const res = runStubDispatch(fixture, ['--no-config', '--provider', 'claude', '-m', 'claude-opus-5', 'positional prompt']);
      assert.notEqual(res.status, 0, `expected rejection, got stdout: ${res.stdout}`);
      assert.match(res.stderr || '', /--effort/);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('detectLegacyConfig and loadDispatchConfig', () => {
  let root;
  let skillRoot;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'dispatch-config-'));
    skillRoot = path.join(root, 'dispatch');
    mkdirSync(skillRoot);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns null for a v0.5 config with no sibling retired config', () => {
    assert.equal(detectLegacyConfig(VALID, { skillRoot }), null);
  });

  for (const key of ['platforms', 'plan-review', 'code-review', 'design-review', 'implementation']) {
    it(`detects top-level "${key}" with the key-map diagnostic`, () => {
      const detected = detectLegacyConfig({ [key]: {} }, { skillRoot });
      assert.ok(detected, key);
      assert.ok(Array.isArray(detected.reasons) && detected.reasons.length > 0);
      assertKeyMap(detected.message);
    });
  }

  for (const name of ['config.jsonc', 'config.local.jsonc']) {
    it(`detects a sibling retired implement ${name}`, () => {
      mkdirSync(path.join(root, 'implement-dispatch'));
      writeFileSync(path.join(root, 'implement-dispatch', name), '{}');
      const detected = detectLegacyConfig(VALID, { skillRoot });
      assert.ok(detected);
      assert.match(detected.message, /targetCount\s*(→|->)\s*targets/);
    });
  }

  it('loadDispatchConfig prefers config.local.jsonc and normalizes absent optional tables', () => {
    writeFileSync(path.join(skillRoot, 'config.jsonc'), JSON.stringify(VALID));
    writeFileSync(path.join(skillRoot, 'config.local.jsonc'), JSON.stringify({ 'read-delegates': { claude: {} } }));
    const loaded = loadDispatchConfig({ skillRoot });
    assert.equal(loaded.path, path.join(skillRoot, 'config.local.jsonc'));
    assert.deepEqual(loaded.config['read-delegates'], { claude: {} });
    assert.deepEqual(loaded.config['write-subagents'], {});
    assert.deepEqual(loaded.config.phases, {});
  });

  it('loadDispatchConfig throws the key-map diagnostic for a v0.4 dispatch config', () => {
    writeFileSync(path.join(skillRoot, 'config.jsonc'), JSON.stringify({ platforms: { claude: {} } }));
    assert.throws(() => loadDispatchConfig({ skillRoot }), (err) => {
      assert.equal(err.code, 'LEGACY_DISPATCH_CONFIG');
      assertKeyMap(err.message);
      return true;
    });
  });

  it('loadDispatchConfig throws for a sibling retired implement config', () => {
    writeFileSync(path.join(skillRoot, 'config.jsonc'), JSON.stringify(VALID));
    mkdirSync(path.join(root, 'implement-dispatch'));
    writeFileSync(path.join(root, 'implement-dispatch', 'config.jsonc'), '{}');
    assert.throws(() => loadDispatchConfig({ skillRoot }), (err) => err.code === 'LEGACY_DISPATCH_CONFIG');
  });

  it('loadDispatchConfig names config.sample.jsonc when no config exists', () => {
    assert.throws(() => loadDispatchConfig({ skillRoot }), /Config file not found[\s\S]*config\.sample\.jsonc/);
  });
});

describe('shipped config.sample.jsonc', () => {
  // Liveness stub: claude is the orchestrator, copilot dead.
  const LIVE_ALL = { claude: true, agy: true, copilot: false, opencode: true };

  /** Shipped v0.4 review policy carried into v0.5 `phases` (rounds/consensus per level). */
  const LEVEL_PARITY = {
    low: { 'plan-review': { rounds: 0, consensus: false }, 'code-review': { rounds: 1, consensus: false } },
    medium: { 'plan-review': { rounds: 2, consensus: true }, 'code-review': { rounds: 3, consensus: true } },
    high: { 'plan-review': { rounds: 3, consensus: true }, 'code-review': { rounds: 3, consensus: true } },
    xhigh: { 'plan-review': { rounds: 3, consensus: true }, 'code-review': { rounds: 3, consensus: true } },
    max: { 'plan-review': { rounds: 5, consensus: true }, 'code-review': { rounds: 5, consensus: true } },
  };

  it('is a v0.5 three-table config that validates with no problems', () => {
    assert.deepEqual(Object.keys(SAMPLE_CONFIG).sort(), ['phases', 'read-delegates', 'write-subagents']);
    assert.deepEqual(validateConfig(SAMPLE_CONFIG), []);
    assert.equal(detectLegacyConfig(SAMPLE_CONFIG, { skillRoot: path.join(REPO_ROOT, 'skills', 'dispatch') }), null);
  });

  it('configures all three review phases, an only example, an array candidate, and a model cascade', () => {
    for (const phase of REVIEW_PHASES) assert.ok(SAMPLE_CONFIG.phases[phase], phase);
    assert.ok(Object.values(SAMPLE_CONFIG.phases).some((phase) => Array.isArray(phase.only)));
    assert.ok(Object.values(SAMPLE_CONFIG['read-delegates']).some(Array.isArray));
    assert.ok(Object.values(SAMPLE_CONFIG['write-subagents']).some((entry) => Array.isArray(entry.model)));
  });

  for (const [level, phases] of Object.entries(LEVEL_PARITY)) {
    it(`resolves read delegates and the shipped policy at ${level}`, () => {
      const resolved = resolveReadDelegates(SAMPLE_CONFIG, level);
      assert.ok(Object.keys(resolved.platforms).length > 0);
      for (const candidates of Object.values(resolved.platforms)) assert.ok(candidates.length > 0);
      const flow = resolveFlow({ platform: 'claude', level, implementationFields: 'model,effort' }, LIVE_ALL, SAMPLE_CONFIG);
      for (const [phase, expected] of Object.entries(phases)) {
        assert.equal(flow[phase].rounds, expected.rounds, `${phase} rounds`);
        assert.equal(flow[phase].consensus, expected.consensus, `${phase} consensus`);
      }
      assert.equal(typeof flow['design-review'].rounds, 'number');
      assert.ok(flow.implementation.model, 'claude write-subagent resolves a model');
    });
  }
});
