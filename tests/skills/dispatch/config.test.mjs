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
    claude: { sandbox: true, targets: [{ low: { model: 'claude-opus-5', effort: 'low' } }] },
    agy: { targets: [{ low: { model: 'gemini-3.8-flash', effort: 'medium' } }] },
    copilot: { sandbox: true, targets: [{ low: { model: 'gpt-6-astra', effort: 'low' } }] },
    opencode: { targets: [{ low: { model: 'opencode-go/glm-5.3-flash', effort: 'max' } }, { low: { model: 'lmstudio/qwen3.8-27b-ridge', effort: 'medium' } }] },
  },
  'write-subagents': {
    claude: { low: { model: 'claude-sonnet-5', effort: 'medium' }, high: { model: 'claude-opus-5' } },
    copilot: { low: { model: ['gpt-5.6-luna', 'bedrock.gpt-5.6-luna'], effort: 'max' } },
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
/** One-target read-provider wrapper around a single `low` level. */
const wrap = (level = { model: 'm' }, extra = {}) => ({ ...extra, targets: [{ low: level }] });

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
    assert.deepEqual(validateConfig({ 'read-delegates': { claude: wrap() } }), []);
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
      const text = problemsOf({ 'read-delegates': { bogus: wrap() } });
      assert.match(text, /bogus/);
      assert.match(text, new RegExp(KNOWN_PROVIDERS.join(', ')));
    });

    it('accepts alias keys and rejects duplicates after alias normalization', () => {
      assert.deepEqual(validateConfig({ 'read-delegates': { antigravity: wrap(), claudecode: wrap() } }), []);
      const text = problemsOf({ 'read-delegates': { agy: wrap(), antigravity: wrap() } });
      assert.match(text, /duplicate/i);
      assert.match(text, /agy/);
    });

    it('rejects the reserved pin keyword "all"', () => {
      assert.match(problemsOf({ 'read-delegates': { all: wrap() } }), /reserved pin keyword "all"/);
    });

    it('type-checks model, effort, and sandbox', () => {
      assert.match(problemsOf({ 'read-delegates': { agy: wrap({ model: 5 }) } }), /read-delegates\.agy\.targets\[0\]\.low\.model must be a nonblank string/);
      assert.match(problemsOf({ 'read-delegates': { claude: wrap({ model: [] }) } }), /read-delegates\.claude\.targets\[0\]\.low\.model must be/);
      assert.match(problemsOf({ 'read-delegates': { claude: wrap({ model: 'claude:' }) } }), /read-delegates\.claude\.targets\[0\]\.low\.model must be/);
      assert.match(problemsOf({ 'read-delegates': { claude: wrap({ model: 'm', effort: '   ' }) } }), /read-delegates\.claude\.targets\[0\]\.low\.effort must be a string/);
      assert.match(problemsOf({ 'read-delegates': { copilot: wrap(undefined, { sandbox: 'yes' }) } }), /read-delegates\.copilot\.sandbox must be a boolean/);
    });

    it('accepts wrapper sandbox on Claude, Copilot, and OpenCode but not agy', () => {
      assert.deepEqual(validateConfig({ 'read-delegates': {
        claude: wrap(undefined, { sandbox: false }), copilot: wrap(undefined, { sandbox: true }), opencode: wrap(undefined, { sandbox: false }),
      } }), []);
      assert.match(problemsOf({ 'read-delegates': { agy: wrap(undefined, { sandbox: true }) } }), /read-delegates\.agy\.sandbox is not supported/);
    });

    it('rejects an unrecognized key in a wrapper, target, or level config', () => {
      assert.match(problemsOf({ 'read-delegates': { claude: wrap(undefined, { timeout: 10 }) } }), /read-delegates\.claude has unrecognized key "timeout"/);
      assert.match(problemsOf({ 'read-delegates': { opencode: { targets: [{ low: { model: 'x' }, timeout: 10 }] } } }), /read-delegates\.opencode\.targets\[0\].*unrecognized key "timeout"/);
      assert.match(problemsOf({ 'read-delegates': { opencode: wrap({ model: 'x', timeout: 10 }) } }), /read-delegates\.opencode\.targets\[0\]\.low.*unrecognized key "timeout"/);
    });

    it('validates the targets array', () => {
      assert.match(problemsOf({ 'read-delegates': { opencode: { targets: [] } } }), /read-delegates\.opencode\.targets must be a non-empty array/);
      assert.match(problemsOf({ 'read-delegates': { opencode: { targets: ['x'] } } }), /read-delegates\.opencode\.targets\[0\] must be an object keyed by level/);
    });

    it('validates sparse level maps', () => {
      assert.deepEqual(
        validateConfig({ 'read-delegates': { opencode: { targets: [{ low: { model: 'a', effort: 'medium' }, high: { model: 'b' } }] } } }),
        [],
      );
      const misspelled = problemsOf({ 'read-delegates': { agy: wrap({ modle: 'x' }) } });
      assert.match(misspelled, /read-delegates\.agy\.targets\[0\]\.low/);
      assert.match(misspelled, /modle/);
      assert.match(problemsOf({ 'read-delegates': { agy: { targets: [{}] } } }), /read-delegates\.agy\.targets\[0\] must define at least one level/);
      const badLevel = problemsOf({ 'read-delegates': { agy: { targets: [{ hgih: { model: 'm' } }] } } });
      assert.match(badLevel, /hgih/);
      assert.match(badLevel, /low, medium, high, xhigh, max/);
      assert.match(problemsOf({ 'read-delegates': { agy: { targets: [{ high: 'x' }] } } }), /read-delegates\.agy\.targets\[0\]\.high must be an object/);
    });
  });

  describe('write-subagents', () => {
    it('accepts object entries with model cascades and level overrides', () => {
      assert.deepEqual(validateConfig(withTables()), []);
    });

    it('rejects candidate arrays, including in level maps', () => {
      assert.match(problemsOf(withTables({ 'write-subagents': { claude: [{ model: 'm' }] } })), /write-subagents\.claude must be an object keyed by level/);
      assert.match(
        problemsOf(withTables({ 'write-subagents': { claude: { high: [{ model: 'm' }] } } })),
        /write-subagents\.claude\.high must be an object with model and optional effort/,
      );
    });

    it('type-checks model arrays', () => {
      for (const model of [[], [5], [''], ['claude:']]) {
        assert.match(
          problemsOf(withTables({ 'write-subagents': { copilot: { low: { model } } } })),
          /write-subagents\.copilot\.low\.model must be a nonblank string or non-empty array/,
        );
      }
    });

    it('rejects unknown platform keys', () => {
      assert.match(problemsOf(withTables({ 'write-subagents': { bogus: { low: { model: 'm' } } } })), /bogus/);
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
        'read-delegates': { claude: wrap(), agy: wrap() },
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
      'read-delegates': { claude: wrap({ model: 5 }), bogus: wrap() },
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

    it('returns the selected level config as-is, with no effort or sibling-level inheritance', () => {
      const sparse = { low: { model: 'claude-sonnet-5', effort: 'medium' }, high: { model: 'claude-opus-5' } };
      assert.deepEqual(resolveLevelEntry(sparse, 'max'), { model: 'claude-opus-5' });
      assert.equal(Object.hasOwn(resolveLevelEntry(sparse, 'high'), 'effort'), false);
      assert.deepEqual(resolveLevelEntry(sparse, 'medium'), { model: 'claude-sonnet-5', effort: 'medium' });
      assert.deepEqual(resolveLevelEntry(undefined, 'medium'), {});
    });
  });

  describe('resolveReadDelegates', () => {
    const config = {
      'read-delegates': {
        claudecode: { targets: [{ low: { model: 'a' }, high: { model: 'b' } }] },
        antigravity: { targets: [{ low: { model: 'g1' } }, { low: { model: 'g2' } }] },
        copilot: { sandbox: false, targets: [{ low: { model: 'c' } }] },
      },
    };

    it('returns canonical keys in config order with one candidate per target', () => {
      const resolved = resolveReadDelegates(config, 'high');
      assert.deepEqual(Object.keys(resolved.platforms), ['claude', 'agy', 'copilot']);
      assert.deepEqual(resolved.platforms.claude, [{ model: 'b', sandbox: true }]);
      assert.deepEqual(resolved.platforms.agy, [{ model: 'g1' }, { model: 'g2' }]);
      assert.deepEqual(resolved.platforms.copilot, [{ model: 'c', sandbox: false }]);
    });

    it('changes candidates with the level', () => {
      assert.deepEqual(resolveReadDelegates(config, 'low').platforms.claude, [{ model: 'a', sandbox: true }]);
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

// Effort is optional per level; omission means the provider default, never inheritance.
describe('optional effort per level', () => {
  it('accepts a read-delegate level without effort', () => {
    assert.deepEqual(validateConfig({ 'read-delegates': { claude: wrap({ model: 'm' }) } }), []);
  });

  it('accepts a write-subagent level without effort', () => {
    assert.deepEqual(validateConfig(withTables({ 'write-subagents': { claude: { low: { model: 'm' } } } })), []);
  });

  it('rejects a null effort rather than treating it as omission', () => {
    assert.match(problemsOf({ 'read-delegates': { claude: wrap({ model: 'm', effort: null }) } }), /effort must be a string/);
  });

  it('SC2 resolves a write-subagent level without effort to exactly its own model', () => {
    const entry = { low: { model: 'claude-sonnet-5', effort: 'medium' }, high: { model: 'claude-opus-5' } };
    assert.deepEqual(resolveLevelEntry(entry, 'xhigh'), { model: 'claude-opus-5' });
  });

  it('CLI --model without --effort is rejected, naming --effort', () => {
    const fixture = buildStubDispatchFixture({ 'read-delegates': { claude: wrap({ model: 'claude-opus-5', effort: 'low' }) } });
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
    writeFileSync(path.join(skillRoot, 'config.local.jsonc'), JSON.stringify({ 'read-delegates': { claude: wrap() } }));
    const loaded = loadDispatchConfig({ skillRoot });
    assert.equal(loaded.path, path.join(skillRoot, 'config.local.jsonc'));
    assert.deepEqual(loaded.config['read-delegates'], { claude: wrap() });
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

  it('configures all three review phases, an only example, a multi-target provider, a model cascade, and an effort-less level', () => {
    for (const phase of REVIEW_PHASES) assert.ok(SAMPLE_CONFIG.phases[phase], phase);
    assert.ok(Object.values(SAMPLE_CONFIG.phases).some((phase) => Array.isArray(phase.only)));
    const wrappers = Object.values(SAMPLE_CONFIG['read-delegates']);
    assert.ok(wrappers.every((wrapper) => Array.isArray(wrapper.targets)));
    assert.ok(wrappers.some((wrapper) => wrapper.targets.length > 1));
    const levels = [...wrappers.flatMap((wrapper) => wrapper.targets), ...Object.values(SAMPLE_CONFIG['write-subagents'])]
      .flatMap((map) => Object.values(map));
    assert.ok(levels.some((level) => Array.isArray(level.model)));
    assert.ok(levels.some((level) => !Object.hasOwn(level, 'effort')));
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

// SECTION: strict config format (SC1/SC2)
describe('strict config format', () => {
  const T = (model, effort) => (effort === undefined ? { model } : { model, effort });
  const STRICT = {
    'read-delegates': {
      claude: { sandbox: true, targets: [{ low: T('claude-sonnet-5', 'low'), high: T('claude-opus-5', 'high') }] },
      agy: { targets: [{ low: T('gemini-3.8-flash') }] },
      copilot: { targets: [{ low: T('gpt-6-astra', 'low') }, { medium: T(['gpt-6-astra', 'gpt-6-mini'], 'medium') }] },
      opencode: { sandbox: false, targets: [{ low: T('opencode-go/glm-5.3-flash', 'max') }] },
    },
    'write-subagents': { claude: { low: T('claude-opus-5', 'low') }, opencode: { medium: T('opencode-go/glm-5.3-flash') } },
  };
  // Read rows use one provider and no sibling table. Write rows need a strict read-delegates sibling
  // that today's validator rejects, so `exact` counts only problems in the row's own table.
  const one = (provider, value) => ({ 'read-delegates': { [provider]: value } });
  const withWrite = entry => ({ 'read-delegates': { claude: { targets: [{ low: T('a') }] } }, 'write-subagents': { claude: entry } });
  const REJECTIONS = [
    ['a bare candidate under a read provider', one('claude', { model: 'a', effort: 'low' }), 'read-delegates.claude', /^read-delegates\.claude has unrecognized key "model"\. Valid keys: sandbox, targets/, false],
    ['a bare candidate array under a read provider', one('claude', [{ model: 'a', effort: 'low' }]), 'read-delegates.claude', /^read-delegates\.claude must be an object\b/, true],
    ['an unknown wrapper key', one('claude', { targets: [{ low: T('a') }], extra: 1 }), 'read-delegates.claude', /unrecognized key "extra"\. Valid keys: sandbox, targets/, true],
    ['an empty targets array', one('claude', { targets: [] }), 'read-delegates.claude.targets', /(non-empty|at least one)/, true],
    ['a non-level key in a target', one('claude', { targets: [{ low: T('a'), model: 'a' }] }), 'read-delegates.claude.targets[0]', /unrecognized key "model"/, true],
    ['a misplaced sandbox in a target', one('claude', { targets: [{ low: T('a'), sandbox: true }] }), 'read-delegates.claude.targets[0]', /unrecognized key "sandbox"/, true],
    ['a level config missing model', one('claude', { targets: [{ low: { effort: 'low' } }] }), 'read-delegates.claude.targets[0].low', /\bmodel\b/, true],
    ['a null effort', one('claude', { targets: [{ low: { model: 'a', effort: null } }] }), 'read-delegates.claude.targets[0].low.effort', /must be/, true],
    ['a blank effort', one('claude', { targets: [{ low: { model: 'a', effort: ' ' } }] }), 'read-delegates.claude.targets[0].low.effort', /must be/, true],
    ['an unknown level-config key', one('claude', { targets: [{ low: { model: 'a', extra: 1 } }] }), 'read-delegates.claude.targets[0].low', /unrecognized key "extra"/, true],
    ['a misplaced sandbox in a level config', one('claude', { targets: [{ low: { model: 'a', sandbox: true } }] }), 'read-delegates.claude.targets[0].low', /unrecognized key "sandbox"/, true],
    ['a candidate array in a level map', one('claude', { targets: [{ low: [T('a'), T('b')] }] }), 'read-delegates.claude.targets[0].low', /must be an object/, true],
    ['a non-boolean sandbox', one('claude', { sandbox: 'yes', targets: [{ low: T('a') }] }), 'read-delegates.claude.sandbox', /must be a boolean/, true],
    ['sandbox on agy', one('agy', { sandbox: true, targets: [{ low: T('a') }] }), 'read-delegates.agy', /sandbox/, true],
    ['an invalid model alias', one('claude', { targets: [{ low: T(5) }] }), 'read-delegates.claude.targets[0].low.model', /must be/, true],
    ['an empty model alias array', one('claude', { targets: [{ low: T([]) }] }), 'read-delegates.claude.targets[0].low.model', /(empty|at least one)/, true],
    ['a duplicate model alias', one('claude', { targets: [{ low: T(['a', 'a']) }] }), 'read-delegates.claude.targets[0].low.model', /duplicate/i, true],
    ['a key-reordered duplicate target', one('claude', { targets: [{ low: T('a', 'low') }, { low: { effort: 'low', model: 'a' } }] }), 'read-delegates.claude.targets[1]', /duplicates targets\[0\]/, true],
    ['a non-level key in a write-subagent entry', withWrite({ model: 'a', low: T('a') }), 'write-subagents.claude', /unrecognized key "model"/, true],
    ['an empty write-subagent level map', withWrite({}), 'write-subagents.claude', /(non-empty|at least one level)/, true],
    ['a write-subagent level missing model', withWrite({ low: { effort: 'low' } }), 'write-subagents.claude.low', /\bmodel\b/, true],
  ];

  it('SC1 accepts the canonical wrapper/level-map schema, including a level without effort', () => {
    assert.deepEqual(validateConfig(STRICT), []);
  });

  for (const [name, config, where, rule, exact] of REJECTIONS) {
    it(`SC1 rejects ${name} at ${where} with the sample hint`, () => {
      const problems = validateConfig(config);
      const text = problems.join('\n');
      assert.ok(problems.some(p => p.startsWith(where) && rule.test(p)), `expected ${where} ${rule}:\n${text}`);
      for (const p of problems) assert.match(p, /config\.sample\.jsonc/);
      const table = where.split('.')[0];
      if (exact) assert.equal(problems.filter(p => p.startsWith(`${table}.`) || p.startsWith(`${table} `)).length, 1, text);
    });
  }

  it('SC1 keeps [A,B] and [B,A] alias orders as distinct targets', () => {
    assert.deepEqual(validateConfig(one('claude', { targets: [{ low: T(['a', 'b']) }, { low: T(['b', 'a']) }] })), []);
  });

  it('SC1 reports every strict problem with its path in one pass', () => {
    const problems = validateConfig({ 'read-delegates': {
      claude: { targets: [{ low: { effort: null } }], extra: 1 },
      agy: { sandbox: true, targets: [] },
    } });
    const text = problems.join('\n');
    const expected = [
      [/^read-delegates\.claude has unrecognized key "extra"\. Valid keys: sandbox, targets/, 'claude extra'],
      [/^read-delegates\.claude\.targets\[0\]\.low\b[^\n]*\bmodel\b/, 'claude missing model'],
      [/^read-delegates\.claude\.targets\[0\]\.low\.effort must be/, 'claude null effort'],
      [/^read-delegates\.agy\b[^\n]*sandbox/, 'agy sandbox'],
      [/^read-delegates\.agy\.targets\b[^\n]*(non-empty|at least one)/, 'agy empty targets'],
    ];
    for (const [rule, label] of expected) assert.ok(problems.some(p => rule.test(p)), `${label}:\n${text}`);
    for (const p of problems) assert.match(p, /config\.sample\.jsonc/);
  });

  it('SC2 resolveReadDelegates returns one candidate per target with sparse selection, optional effort, and wrapper sandbox', () => {
    const { platforms } = resolveReadDelegates(STRICT, 'medium');
    assert.deepEqual(platforms.claude, [{ model: 'claude-sonnet-5', effort: 'low', sandbox: true }]);
    assert.deepEqual(platforms.agy, [{ model: 'gemini-3.8-flash' }]);
    assert.deepEqual(platforms.copilot, [
      { model: 'gpt-6-astra', effort: 'low', sandbox: true },
      { model: ['gpt-6-astra', 'gpt-6-mini'], effort: 'medium', sandbox: true },
    ]);
    assert.deepEqual(platforms.opencode, [{ model: 'opencode-go/glm-5.3-flash', effort: 'max', sandbox: false }]);
    assert.deepEqual(resolveReadDelegates(STRICT, 'max').platforms.claude, [{ model: 'claude-opus-5', effort: 'high', sandbox: true }]);
    assert.deepEqual(resolveReadDelegates(STRICT, 'low').platforms.copilot[1], { model: ['gpt-6-astra', 'gpt-6-mini'], effort: 'medium', sandbox: true });
  });
});
