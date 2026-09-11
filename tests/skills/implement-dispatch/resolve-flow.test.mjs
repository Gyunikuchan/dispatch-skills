import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  resolveFlow,
  resolveLevelEntry,
  resolveLevelScalar,
  validateConfig,
} from '../../../skills/implement-dispatch/scripts/resolve-flow.mjs';

// Stub liveness: all available except 'copilot'
const LIVE_ALL = { claude: true, agy: true, copilot: false, opencode: true };
const LIVE_NONE_EXTERNAL = { claude: true, agy: false, copilot: false, opencode: false };

const PLAN_PLATFORMS = {
  claude: { model: 'claude-opus-5', effort: 'medium' },
  agy: { model: 'gemini-3.8-flash', effort: 'medium' },
  copilot: { model: 'gpt-5.6-luna', effort: 'max' },
  opencode: { model: 'lmstudio/qwen3.8-27b-ridge' },
};

const BASE_CONFIG = {
  'plan-review': {
    maxRounds: { low: 0, medium: 1, max: 3 },
    targetCount: { low: 0, medium: 1, max: 'all' },
    consensus: { low: false, high: true },
    includeSelf: { low: false, max: true },
    toolTurns: { low: 3, medium: 4, high: 6, max: 8 },
    platforms: { ...PLAN_PLATFORMS },
  },
  implementation: {
    platforms: {
      claude: { model: 'claude-opus-5', effort: 'medium' },
      agy: { model: 'gemini-3.8-flash', effort: 'medium' },
      copilot: { model: 'gpt-5.6-luna', effort: 'max' },
    },
  },
  'code-review': {
    maxRounds: { low: 1, medium: 3, max: 5 },
    targetCount: { low: 1, high: 'all' },
    consensus: { low: false, high: true },
    includeSelf: { low: false, max: true },
    toolTurns: { low: 3, medium: 4, high: 6, max: 8 },
    platforms: { ...PLAN_PLATFORMS },
  },
};

/** Deep-ish clone with per-section overrides applied on top of BASE_CONFIG. */
function withSections(overrides) {
  const config = {
    'plan-review': { ...BASE_CONFIG['plan-review'] },
    implementation: { ...BASE_CONFIG.implementation },
    'code-review': { ...BASE_CONFIG['code-review'] },
  };
  for (const [section, patch] of Object.entries(overrides)) {
    config[section] = { ...config[section], ...patch };
  }
  return config;
}

describe('resolveFlow', () => {
  describe('level: low', () => {
    it('skips plan-review (maxRounds=0, empty targets)', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['plan-review'].maxRounds, 0);
      assert.deepEqual(out['plan-review'].targets, []);
      assert.equal(out['plan-review'].consensus, false);
    });

    it('code-review has 1 target (first non-orchestrator), maxRounds=1, consensus=false', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].maxRounds, 1);
      assert.equal(out['code-review'].consensus, false);
      assert.equal(out['code-review'].targets.length, 1);
      assert.equal(out['code-review'].targets[0].platform, 'agy');
    });

    it('implementation matches orchestrator config', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out.implementation.platform, 'claude');
      assert.equal(out.implementation.model, 'claude-opus-5');
      assert.equal(out.implementation.effort, 'medium');
    });

    it('reports the toolTurns budget per review section', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['plan-review'].toolTurns, 3);
      assert.equal(out['code-review'].toolTurns, 3);
    });
  });

  describe('level: medium', () => {
    it('plan-review: 1 target, maxRounds=1, consensus=false', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['plan-review'].maxRounds, 1);
      assert.equal(out['plan-review'].consensus, false);
      assert.equal(out['plan-review'].targets.length, 1);
      assert.equal(out['plan-review'].targets[0].platform, 'agy');
    });

    it('code-review: 1 target, maxRounds=3, consensus=false', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].maxRounds, 3);
      assert.equal(out['code-review'].consensus, false);
      assert.equal(out['code-review'].targets.length, 1);
    });

    it('resolves toolTurns by rounding down to the nearest defined level', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].toolTurns, 4);
    });
  });

  describe('level: high', () => {
    it('plan-review: 1 target, maxRounds=1, consensus=true', () => {
      const out = resolveFlow({ platform: 'claude', level: 'high' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['plan-review'].maxRounds, 1);
      assert.equal(out['plan-review'].consensus, true);
      assert.equal(out['plan-review'].targets.length, 1);
    });

    it('code-review: all targets, maxRounds=3, consensus=true', () => {
      const out = resolveFlow({ platform: 'claude', level: 'high' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].maxRounds, 3);
      assert.equal(out['code-review'].consensus, true);
      // agy and opencode available; copilot excluded (not live); claude excluded (orchestrator)
      assert.equal(out['code-review'].targets.length, 2);
    });
  });

  describe('level: max', () => {
    it('plan-review: all targets including self, maxRounds=3, consensus=true', () => {
      const out = resolveFlow({ platform: 'claude', level: 'max' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['plan-review'].maxRounds, 3);
      assert.equal(out['plan-review'].consensus, true);
      // agy, opencode live; copilot not live; claude is orchestrator but included at max
      assert.equal(out['plan-review'].targets.length, 3);
      const self = out['plan-review'].targets.find(t => t.platform === 'claude');
      assert.equal(self?.allowSameAgent, true);
    });

    it('code-review: all targets including self, maxRounds=5, consensus=true', () => {
      const out = resolveFlow({ platform: 'claude', level: 'max' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].maxRounds, 5);
      assert.equal(out['code-review'].consensus, true);
      assert.equal(out['code-review'].targets.length, 3);
      const self = out['code-review'].targets.find(t => t.platform === 'claude');
      assert.equal(self?.allowSameAgent, true);
    });

    it('sorts the orchestrator last when includeSelf is set', () => {
      const out = resolveFlow({ platform: 'claude', level: 'max' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].targets.at(-1).platform, 'claude');
    });
  });

  describe('pins', () => {
    it('overrides targetCount: three pins at a level whose targetCount is 1', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'medium', pins: ['opencode', 'agy', 'claude'] },
        LIVE_ALL,
        BASE_CONFIG
      );
      assert.equal(out['code-review'].maxRounds, 3);
      assert.equal(out['code-review'].targets.length, 3);
    });

    it('preserves pin order', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'medium', pins: ['opencode', 'agy', 'claude'] },
        LIVE_ALL,
        BASE_CONFIG
      );
      assert.deepEqual(
        out['code-review'].targets.map(t => t.platform),
        ['opencode', 'agy', 'claude']
      );
    });

    it('drops dead pins while keeping the live ones', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'medium', pins: ['agy', 'copilot'] },
        LIVE_ALL,
        BASE_CONFIG
      );
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy']);
    });

    it('pin on orchestrator platform: target includes allowSameAgent=true in output', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium', pins: ['claude'] }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].targets.length, 1);
      assert.equal(out['code-review'].targets[0].platform, 'claude');
      assert.equal(out['code-review'].targets[0].allowSameAgent, true);
    });

    it('throws when all pinned platforms are unavailable', () => {
      assert.throws(
        () => resolveFlow({ platform: 'claude', level: 'medium', pins: ['copilot'] }, LIVE_ALL, BASE_CONFIG),
        /unavailable/i
      );
    });

    it('throws on unrecognized pin key with valid keys listed', () => {
      assert.throws(
        () => resolveFlow({ platform: 'claude', level: 'medium', pins: ['bogus'] }, LIVE_ALL, BASE_CONFIG),
        /bogus/
      );
    });

    it('dedupes repeated pins instead of dispatching duplicate targets', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'medium', pins: ['agy', 'agy'] },
        LIVE_ALL,
        BASE_CONFIG
      );
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy']);
    });

    it('normalizes a --provider-style alias (antigravity) to its canonical key', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'medium', pins: ['antigravity'] },
        LIVE_ALL,
        BASE_CONFIG
      );
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy']);
    });

    it('dedupes an alias and its canonical key given together', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'medium', pins: ['antigravity', 'agy'] },
        LIVE_ALL,
        BASE_CONFIG
      );
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy']);
    });
  });

  describe('targetCount', () => {
    it('0 skips the phase', () => {
      const config = withSections({ 'code-review': { targetCount: { low: 0 } } });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config);
      assert.deepEqual(out['code-review'].targets, []);
    });

    it('1 selects the first live non-orchestrator candidate', () => {
      const config = withSections({ 'code-review': { targetCount: { low: 1 } } });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy']);
    });

    it('2 selects two candidates in config order', () => {
      const config = withSections({ 'code-review': { targetCount: { low: 2 } } });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy', 'opencode']);
    });

    it('"all" selects every live candidate', () => {
      const config = withSections({ 'code-review': { targetCount: { low: 'all' } } });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy', 'opencode']);
    });

    it('clamps to the available candidates and records the clamp', () => {
      const config = withSections({ 'code-review': { targetCount: { low: 3 } } });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config);
      assert.equal(out['code-review'].targets.length, 2);
      assert.deepEqual(out.diagnostics.clamped['code-review'], { requested: 3, resolved: 2 });
    });

    it('records no clamp when the count is satisfied', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out.diagnostics.clamped['code-review'], undefined);
    });

    it('never yields a self-only review when a narrow count meets includeSelf', () => {
      const config = withSections({
        'code-review': { targetCount: { low: 1 }, includeSelf: { low: true } },
      });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy']);
    });
  });

  describe('phase skip', () => {
    it('maxRounds=0 skips without raising the all-pinned-unavailable error', () => {
      const config = withSections({ 'code-review': { maxRounds: { low: 0 } } });
      const out = resolveFlow(
        { platform: 'claude', level: 'low', pins: ['copilot'] },
        LIVE_ALL,
        config
      );
      assert.deepEqual(out['code-review'].targets, []);
      assert.equal(out['code-review'].maxRounds, 0);
    });

    it('targetCount=0 does not skip when pins are given — pins override breadth', () => {
      const config = withSections({ 'code-review': { targetCount: { low: 0 } } });
      const out = resolveFlow(
        { platform: 'claude', level: 'low', pins: ['agy'] },
        LIVE_ALL,
        config
      );
      assert.equal(out['code-review'].targets.length, 1);
      assert.equal(out['code-review'].targets[0].platform, 'agy');
    });

    it('targetCount=0 with an all-dead pin still raises the all-pinned-unavailable error', () => {
      const config = withSections({ 'code-review': { targetCount: { low: 0 } } });
      assert.throws(
        () =>
          resolveFlow({ platform: 'claude', level: 'low', pins: ['copilot'] }, LIVE_ALL, config),
        /All pinned platforms unavailable: copilot/
      );
    });

    it('skips a phase with zero live platforms without erroring', () => {
      const config = withSections({ 'code-review': { targetCount: { low: 0 } } });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_NONE_EXTERNAL, config);
      assert.deepEqual(out['code-review'].targets, []);
    });

    it('sets maxRounds to 0 when configured maxRounds is zero', () => {
      const config = withSections({ 'code-review': { maxRounds: { low: 0 } } });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config);
      assert.equal(out['code-review'].maxRounds, 0);
      assert.deepEqual(out['code-review'].targets, []);
    });

    it('normalizes maxRounds to 0 when targetCount is zero', () => {
      const config = withSections({
        'code-review': { targetCount: { low: 0 }, maxRounds: { low: 3 } },
      });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config);
      // targetCount:0 means the phase is configured off; expressed via maxRounds:0 so
      // callers have one sentinel instead of two.
      assert.equal(out['code-review'].maxRounds, 0);
      assert.deepEqual(out['code-review'].targets, []);
    });

    it('returns maxRounds > 0 with empty targets when platforms are unavailable', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_NONE_EXTERNAL, BASE_CONFIG);
      assert.deepEqual(out['code-review'].targets, []);
      assert.ok(out['code-review'].maxRounds > 0);
    });

    // `opencode` is pinned and configured for code-review only, so the pin is valid
    // overall but absent from plan-review — the exact case droppedPins reports.
    const PLAN_WITHOUT_OPENCODE = { claude: PLAN_PLATFORMS.claude, agy: PLAN_PLATFORMS.agy };

    it('reports droppedPins for a phase that runs without the pinned platform', () => {
      const config = withSections({
        'plan-review': { maxRounds: { low: 1 }, targetCount: { low: 1 }, platforms: PLAN_WITHOUT_OPENCODE },
      });
      const out = resolveFlow(
        { platform: 'claude', level: 'low', pins: ['opencode'] },
        LIVE_ALL,
        config
      );
      assert.deepEqual(out.diagnostics.droppedPins['plan-review'], ['opencode']);
    });

    it('reports droppedPins for a pin that is configured but currently offline', () => {
      // 'copilot' is configured in BASE_CONFIG but LIVE_ALL marks it offline — a pin can
      // be dropped for being dead, not just for being absent from the section's config.
      const out = resolveFlow(
        { platform: 'claude', level: 'medium', pins: ['agy', 'copilot'] },
        LIVE_ALL,
        BASE_CONFIG
      );
      assert.deepEqual(out.diagnostics.droppedPins['code-review'], ['copilot']);
    });

    it('omits droppedPins when maxRounds is 0', () => {
      const config = withSections({
        'plan-review': { maxRounds: { low: 0 }, platforms: PLAN_WITHOUT_OPENCODE },
      });
      const out = resolveFlow(
        { platform: 'claude', level: 'low', pins: ['opencode'] },
        LIVE_ALL,
        config
      );
      assert.equal(out.diagnostics.droppedPins['plan-review'], undefined);
    });
  });

  describe('diagnostics', () => {
    it('reports the effective level', () => {
      const out = resolveFlow({ platform: 'claude', level: 'high' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out.diagnostics.effectiveLevel, 'high');
    });

    it('reports configured platforms that are not live', () => {
      const out = resolveFlow({ platform: 'claude', level: 'high' }, LIVE_ALL, BASE_CONFIG);
      assert.deepEqual(out.diagnostics.unavailable, ['copilot']);
      const out2 = resolveFlow({ platform: 'claude', level: 'high' }, LIVE_NONE_EXTERNAL, BASE_CONFIG);
      assert.deepEqual(out2.diagnostics.unavailable, ['agy', 'copilot', 'opencode']);
    });

    it('reports pins absent from a section platforms map', () => {
      const platforms = { ...PLAN_PLATFORMS };
      delete platforms.opencode;
      const config = withSections({ 'plan-review': { platforms } });
      const out = resolveFlow(
        { platform: 'claude', level: 'medium', pins: ['opencode'] },
        LIVE_ALL,
        config
      );
      assert.deepEqual(out.diagnostics.droppedPins['plan-review'], ['opencode']);
      assert.equal(out.diagnostics.droppedPins['code-review'], undefined);
      assert.deepEqual(out['plan-review'].targets, []);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['opencode']);
    });
  });

  describe('implementation section', () => {
    it('always includes platform field', () => {
      const out = resolveFlow({ platform: 'agy', level: 'low' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out.implementation.platform, 'agy');
    });

    it('omits model/effort when orchestrator not in implementation config', () => {
      const out = resolveFlow({ platform: 'opencode', level: 'low' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out.implementation.platform, 'opencode');
      assert.equal(out.implementation.model, undefined);
      assert.equal(out.implementation.effort, undefined);
    });

    it('resolves level-keyed implementation config through resolveFlow', () => {
      const config = withSections({
        implementation: {
          platforms: {
            claude: {
              medium: { model: 'claude-sonnet-5', effort: 'medium' },
              high: { model: 'claude-opus-5', effort: 'medium' },
            },
          },
        },
      });
      const out = resolveFlow({ platform: 'claude', level: 'max' }, LIVE_ALL, config);
      assert.equal(out.implementation.model, 'claude-opus-5');
    });
  });

  describe('resolveLevelEntry', () => {
    const LEVELED = {
      medium: { model: 'claude-sonnet-5', effort: 'medium' },
      high: { model: 'claude-opus-5', effort: 'high' },
    };

    it('matches the requested level exactly', () => {
      assert.deepEqual(resolveLevelEntry(LEVELED, 'high'), {
        model: 'claude-opus-5',
        effort: 'high',
      });
    });

    it('rounds down to the nearest defined level below', () => {
      assert.deepEqual(resolveLevelEntry(LEVELED, 'max'), {
        model: 'claude-opus-5',
        effort: 'high',
      });
      assert.deepEqual(resolveLevelEntry({ low: { model: 'a' }, max: { model: 'd' } }, 'medium'), {
        model: 'a',
      });
    });

    it('rounds up to the lowest defined level when nothing is below', () => {
      assert.deepEqual(resolveLevelEntry(LEVELED, 'low'), {
        model: 'claude-sonnet-5',
        effort: 'medium',
      });
      assert.deepEqual(resolveLevelEntry({ max: { model: 'd' } }, 'low'), { model: 'd' });
    });

    it('treats a flat entry as level-agnostic', () => {
      const flat = { model: 'gemini-3.8-flash', effort: 'medium' };
      for (const level of ['low', 'medium', 'high', 'max']) {
        assert.deepEqual(resolveLevelEntry(flat, level), flat);
      }
    });

    it('lets level keys override flat keys, falling back to flat for unset fields', () => {
      const mixed = { model: 'claude-opus-5', effort: 'medium', low: { model: 'claude-sonnet-5' } };
      // effort is unset at the level, so the flat value carries through
      assert.deepEqual(resolveLevelEntry(mixed, 'low'), {
        model: 'claude-sonnet-5',
        effort: 'medium',
      });
      // 'low' is the only defined level, so higher levels round down to it
      assert.deepEqual(resolveLevelEntry(mixed, 'high'), {
        model: 'claude-sonnet-5',
        effort: 'medium',
      });
    });

    it('accepts a level entry that overrides effort only', () => {
      const entry = { model: 'claude-opus-5', high: { effort: 'max' } };
      assert.deepEqual(resolveLevelEntry(entry, 'high'), {
        model: 'claude-opus-5',
        effort: 'max',
      });
    });

    it('returns empty for a missing or empty entry', () => {
      assert.deepEqual(resolveLevelEntry(undefined, 'medium'), {});
      assert.deepEqual(resolveLevelEntry({}, 'medium'), {});
    });
  });

  describe('resolveLevelScalar', () => {
    it('matches exactly, then rounds down, then rounds up', () => {
      const knob = { medium: 3, max: 5 };
      assert.equal(resolveLevelScalar(knob, 'medium'), 3);
      assert.equal(resolveLevelScalar(knob, 'high'), 3);
      assert.equal(resolveLevelScalar(knob, 'max'), 5);
      assert.equal(resolveLevelScalar(knob, 'low'), 3);
    });

    it('resolves false and 0 rather than skipping them', () => {
      assert.equal(resolveLevelScalar({ low: false, high: true }, 'medium'), false);
      assert.equal(resolveLevelScalar({ low: 0, medium: 1 }, 'low'), 0);
    });

    it('returns undefined for an absent knob', () => {
      assert.equal(resolveLevelScalar(undefined, 'low'), undefined);
      assert.equal(resolveLevelScalar({}, 'low'), undefined);
    });
  });

  describe('validateConfig', () => {
    it('accepts the stub config', () => {
      assert.deepEqual(validateConfig(BASE_CONFIG), []);
    });

    it('rejects a misspelled key inside a level override', () => {
      const config = withSections({
        'code-review': { platforms: { agy: { low: { modle: 'gemini-3.8-flash' } } } },
      });
      const problems = validateConfig(config);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /code-review\.platforms\.agy\.low/);
      assert.match(problems[0], /modle/);
      assert.match(problems[0], /Valid keys: model, effort/);
    });

    it('rejects an empty level override', () => {
      const config = withSections({
        'code-review': { platforms: { agy: { low: {} } } },
      });
      const problems = validateConfig(config);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /code-review\.platforms\.agy\.low must set at least one of model, effort/);
    });

    it('rejects a non-string model inside a level override', () => {
      const config = withSections({
        'code-review': { platforms: { agy: { low: { model: 5 } } } },
      });
      const problems = validateConfig(config);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /code-review\.platforms\.agy\.low\.model must be a string/);
    });

    it('rejects an unrecognized level key in a platforms entry', () => {
      const config = withSections({
        'code-review': { platforms: { agy: { model: 'm', hgih: { effort: 'high' } } } },
      });
      const problems = validateConfig(config);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /hgih/);
      assert.match(problems[0], /low, medium, high, max/);
      assert.throws(
        () => resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config),
        /hgih/
      );
    });

    it('rejects a non-object level value in a platforms entry', () => {
      const config = withSections({
        'code-review': { platforms: { agy: { model: 'm', high: 'claude-opus-5' } } },
      });
      const problems = validateConfig(config);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /high/);
    });

    it('names the section in a config-shape problem', () => {
      const config = withSections({
        'code-review': { platforms: { agy: { model: 'm', hgih: { effort: 'high' } } } },
      });
      assert.match(validateConfig(config)[0], /code-review/);
    });

    it('names config.default.jsonc as the file to diff against', () => {
      assert.match(validateConfig({})[0], /config\.default\.jsonc/);
    });

    it('requires all three sections to be present', () => {
      const problems = validateConfig({ 'plan-review': BASE_CONFIG['plan-review'] });
      assert.match(problems.join('\n'), /Missing required section "implementation"/);
      assert.match(problems.join('\n'), /Missing required section "code-review"/);
    });

    it('rejects unknown top-level keys', () => {
      const config = { ...BASE_CONFIG, subagents: {} };
      assert.match(validateConfig(config).join('\n'), /Unrecognized top-level key "subagents"/);
    });

    it('rejects unknown section keys', () => {
      const config = withSections({ 'code-review': { rounds: { low: 1 } } });
      assert.match(validateConfig(config).join('\n'), /unrecognized key "rounds"/);
      const impl = withSections({ implementation: { consensus: { low: true } } });
      assert.match(validateConfig(impl).join('\n'), /unrecognized key "consensus"/);
    });

    it('rejects an empty platforms map', () => {
      const config = withSections({ 'plan-review': { platforms: {} } });
      assert.match(validateConfig(config).join('\n'), /at least one platform/);
    });

    it('requires every knob except includeSelf', () => {
      const section = { ...BASE_CONFIG['code-review'] };
      delete section.maxRounds;
      delete section.includeSelf;
      const config = { ...BASE_CONFIG, 'code-review': section };
      const problems = validateConfig(config);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /missing required knob "maxRounds"/);
    });

    it('requires each defined knob to define at least one level', () => {
      const config = withSections({ 'code-review': { maxRounds: {} } });
      assert.match(validateConfig(config).join('\n'), /at least one level/);
    });

    it('type-checks knob values', () => {
      const config = withSections({
        'code-review': {
          maxRounds: { low: -1 },
          targetCount: { low: 'two' },
          consensus: { low: 'yes' },
          toolTurns: { low: 0 },
        },
      });
      const problems = validateConfig(config);
      assert.equal(problems.length, 4);
      assert.match(problems.join('\n'), /maxRounds\.low must be a non-negative integer/);
      assert.match(problems.join('\n'), /targetCount\.low must be a non-negative integer or "all"/);
      assert.match(problems.join('\n'), /consensus\.low must be a boolean/);
      assert.match(problems.join('\n'), /toolTurns\.low must be a positive integer/);
    });

    it('rejects an unknown level key on a knob', () => {
      const config = withSections({ 'code-review': { maxRounds: { lwo: 1 } } });
      assert.match(validateConfig(config).join('\n'), /unrecognized level "lwo"/);
    });

    it('reports every problem in one pass', () => {
      const config = {
        bogus: {},
        'plan-review': { platforms: {}, maxRounds: { low: -1 } },
      };
      const problems = validateConfig(config);
      assert.ok(problems.length >= 5, `expected many problems, got ${problems.length}`);
    });
  });

  describe('targets include model/effort from config', () => {
    it('target entry carries model and effort', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, BASE_CONFIG);
      const target = out['code-review'].targets[0];
      assert.equal(target.model, 'gemini-3.8-flash');
      assert.equal(target.effort, 'medium');
    });

    it('target without effort omits effort field', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low' }, { ...LIVE_ALL, agy: false }, BASE_CONFIG);
      // opencode is next after agy (which is now unavailable)
      const target = out['code-review'].targets[0];
      assert.equal(target.platform, 'opencode');
      assert.equal(target.effort, undefined);
    });
  });

  describe('review sections resolve level-keyed model/effort', () => {
    const LEVELED_PLATFORMS = {
      agy: {
        model: 'gemini-3.8-flash',
        low: { effort: 'high' },
        max: { effort: 'max' },
      },
    };
    const LEVELED_CONFIG = withSections({
      'code-review': { platforms: LEVELED_PLATFORMS },
      'plan-review': { platforms: LEVELED_PLATFORMS },
    });

    it('rounds down to the base level key below max', () => {
      for (const level of ['low', 'medium', 'high']) {
        const out = resolveFlow({ platform: 'claude', level }, LIVE_ALL, LEVELED_CONFIG);
        const target = out['code-review'].targets.find(t => t.platform === 'agy');
        assert.equal(target.effort, 'high', `level ${level}`);
        assert.equal(target.model, 'gemini-3.8-flash', `level ${level}`);
      }
    });

    it('matches the max level key exactly', () => {
      const out = resolveFlow({ platform: 'claude', level: 'max' }, LIVE_ALL, LEVELED_CONFIG);
      assert.equal(out['code-review'].targets.find(t => t.platform === 'agy').effort, 'max');
      assert.equal(out['plan-review'].targets.find(t => t.platform === 'agy').effort, 'max');
    });
  });

  describe('maxRounds counts waves, not dispatches', () => {
    it('always reports maxRounds, including for multi-target levels', () => {
      for (const level of ['low', 'medium', 'high', 'max']) {
        const out = resolveFlow({ platform: 'claude', level }, LIVE_ALL, BASE_CONFIG);
        assert.equal(typeof out['code-review'].maxRounds, 'number', `code-review maxRounds at ${level}`);
        assert.equal(typeof out['plan-review'].maxRounds, 'number', `plan-review maxRounds at ${level}`);
      }
    });

    it('leaves maxRounds independent of how many targets a wave dispatches', () => {
      const out = resolveFlow({ platform: 'claude', level: 'high' }, LIVE_ALL, BASE_CONFIG);
      // 2 live non-orchestrator targets, but the budget stays at 3 waves
      assert.equal(out['code-review'].targets.length, 2);
      assert.equal(out['code-review'].maxRounds, 3);
    });

    it('counts plan-review and code-review caps separately', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['plan-review'].maxRounds, 1);
      assert.equal(out['code-review'].maxRounds, 3);
    });
  });

  describe('no non-orchestrator candidates', () => {
    it('returns empty targets (not an error) when no external platforms live', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_NONE_EXTERNAL, BASE_CONFIG);
      assert.deepEqual(out['code-review'].targets, []);
    });
  });
});
