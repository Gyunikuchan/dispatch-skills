import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveFlow, resolveLevelEntry } from '../../implement-dispatch/scripts/resolve-flow.mjs';

// Silence the default stderr warner in tests that don't assert on it
const noWarn = () => {};

// Stub liveness: all available except 'copilot'
const LIVE_ALL = { claude: true, agy: true, copilot: false, local: true };
const LIVE_NONE_EXTERNAL = { claude: true, agy: false, copilot: false, local: false };

const BASE_CONFIG = {
  'plan-review': {
    claude: { model: 'claude-opus-5', effort: 'medium' },
    agy: { model: 'gemini-3.8-flash', effort: 'medium' },
    copilot: { model: 'gpt-5.6-luna', effort: 'max' },
    local: { model: 'lmstudio/qwen3.8-27b-ridge' },
  },
  implementation: {
    claude: { model: 'claude-opus-5', effort: 'medium' },
    agy: { model: 'gemini-3.8-flash', effort: 'medium' },
    copilot: { model: 'gpt-5.6-luna', effort: 'max' },
  },
  'code-review': {
    claude: { model: 'claude-opus-5', effort: 'medium' },
    agy: { model: 'gemini-3.8-flash', effort: 'medium' },
    copilot: { model: 'gpt-5.6-luna', effort: 'max' },
    local: { model: 'lmstudio/qwen3.8-27b-ridge' },
  },
};

describe('resolveFlow', () => {
  describe('level: low', () => {
    it('skips plan-review (rounds=0, empty targets)', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['plan-review'].rounds, 0);
      assert.deepEqual(out['plan-review'].targets, []);
      assert.equal(out['plan-review'].consensus, false);
    });

    it('code-review has 1 target (first non-orchestrator), rounds=1, consensus=false', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].rounds, 1);
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
  });

  describe('level: medium', () => {
    it('plan-review: 1 target, rounds=1, consensus=false', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['plan-review'].rounds, 1);
      assert.equal(out['plan-review'].consensus, false);
      assert.equal(out['plan-review'].targets.length, 1);
      assert.equal(out['plan-review'].targets[0].platform, 'agy');
    });

    it('code-review: 1 target, rounds=3, consensus=false', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].rounds, 3);
      assert.equal(out['code-review'].consensus, false);
      assert.equal(out['code-review'].targets.length, 1);
    });
  });

  describe('level: high', () => {
    it('plan-review: 1 target, rounds=1, consensus=true', () => {
      const out = resolveFlow({ platform: 'claude', level: 'high' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['plan-review'].rounds, 1);
      assert.equal(out['plan-review'].consensus, true);
      assert.equal(out['plan-review'].targets.length, 1);
    });

    it('code-review: all targets, rounds=3, consensus=true', () => {
      const out = resolveFlow({ platform: 'claude', level: 'high' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].rounds, 3);
      assert.equal(out['code-review'].consensus, true);
      // agy and local available; copilot excluded (not live); claude excluded (orchestrator)
      assert.equal(out['code-review'].targets.length, 2);
    });
  });

  describe('level: max', () => {
    it('plan-review: all targets including self, rounds=3, consensus=true', () => {
      const out = resolveFlow({ platform: 'claude', level: 'max' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['plan-review'].rounds, 3);
      assert.equal(out['plan-review'].consensus, true);
      // agy, local live; copilot not live; claude is orchestrator but included at max
      assert.equal(out['plan-review'].targets.length, 3);
      const self = out['plan-review'].targets.find(t => t.platform === 'claude');
      assert.equal(self?.allowSameAgent, true);
    });

    it('code-review: all targets including self, rounds=5, consensus=true', () => {
      const out = resolveFlow({ platform: 'claude', level: 'max' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].rounds, 5);
      assert.equal(out['code-review'].consensus, true);
      assert.equal(out['code-review'].targets.length, 3);
      const self = out['code-review'].targets.find(t => t.platform === 'claude');
      assert.equal(self?.allowSameAgent, true);
    });
  });

  describe('pins', () => {
    it('pins filter candidates to matching keys only', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium', pins: ['agy'] }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].targets[0].platform, 'agy');
      assert.equal(out['code-review'].targets.length, 1);
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
  });

  describe('implementation section', () => {
    it('always includes platform field', () => {
      const out = resolveFlow({ platform: 'agy', level: 'low' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out.implementation.platform, 'agy');
    });

    it('omits model/effort when orchestrator not in implementation config', () => {
      const configNoLocal = { ...BASE_CONFIG, implementation: { ...BASE_CONFIG.implementation } };
      const out = resolveFlow({ platform: 'local', level: 'low' }, LIVE_ALL, configNoLocal);
      assert.equal(out.implementation.platform, 'local');
      assert.equal(out.implementation.model, undefined);
      assert.equal(out.implementation.effort, undefined);
    });

    it('resolves level-keyed implementation config through resolveFlow', () => {
      const config = {
        ...BASE_CONFIG,
        implementation: {
          claude: {
            medium: { model: 'claude-sonnet-5', effort: 'medium' },
            high: { model: 'claude-opus-5', effort: 'medium' },
          },
        },
      };
      const out = resolveFlow({ platform: 'claude', level: 'max' }, LIVE_ALL, config, noWarn);
      assert.equal(out.implementation.model, 'claude-opus-5');
    });
  });

  describe('resolveLevelEntry', () => {
    const LEVELED = {
      medium: { model: 'claude-sonnet-5', effort: 'medium' },
      high: { model: 'claude-opus-5', effort: 'high' },
    };

    it('matches the requested level exactly', () => {
      assert.deepEqual(resolveLevelEntry(LEVELED, 'high', noWarn), {
        model: 'claude-opus-5',
        effort: 'high',
      });
    });

    it('rounds down to the nearest defined level below', () => {
      assert.deepEqual(resolveLevelEntry(LEVELED, 'max', noWarn), {
        model: 'claude-opus-5',
        effort: 'high',
      });
      assert.deepEqual(
        resolveLevelEntry({ low: { model: 'a' }, max: { model: 'd' } }, 'medium', noWarn),
        { model: 'a' }
      );
    });

    it('rounds up to the lowest defined level when nothing is below', () => {
      assert.deepEqual(resolveLevelEntry(LEVELED, 'low', noWarn), {
        model: 'claude-sonnet-5',
        effort: 'medium',
      });
      assert.deepEqual(resolveLevelEntry({ max: { model: 'd' } }, 'low', noWarn), { model: 'd' });
    });

    it('treats a flat entry as level-agnostic', () => {
      const flat = { model: 'gemini-3.8-flash', effort: 'medium' };
      for (const level of ['low', 'medium', 'high', 'max']) {
        assert.deepEqual(resolveLevelEntry(flat, level, noWarn), flat);
      }
    });

    it('lets level keys override flat keys, falling back to flat for unset fields', () => {
      const mixed = { model: 'claude-opus-5', effort: 'medium', low: { model: 'claude-sonnet-5' } };
      // effort is unset at the level, so the flat value carries through
      assert.deepEqual(resolveLevelEntry(mixed, 'low', noWarn), {
        model: 'claude-sonnet-5',
        effort: 'medium',
      });
      // 'low' is the only defined level, so higher levels round down to it
      assert.deepEqual(resolveLevelEntry(mixed, 'high', noWarn), {
        model: 'claude-sonnet-5',
        effort: 'medium',
      });
    });

    it('accepts a level entry that overrides effort only', () => {
      const entry = { model: 'claude-opus-5', high: { effort: 'max' } };
      assert.deepEqual(resolveLevelEntry(entry, 'high', noWarn), {
        model: 'claude-opus-5',
        effort: 'max',
      });
    });

    it('returns empty for a missing or empty entry', () => {
      assert.deepEqual(resolveLevelEntry(undefined, 'medium', noWarn), {});
      assert.deepEqual(resolveLevelEntry({}, 'medium', noWarn), {});
    });

    it('warns and skips an unrecognized level key', () => {
      const warnings = [];
      const out = resolveLevelEntry(
        { medium: { model: 'ok' }, hgih: { model: 'typo' } },
        'high',
        m => warnings.push(m)
      );
      assert.deepEqual(out, { model: 'ok' });
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /hgih/);
      assert.match(warnings[0], /low, medium, high, max/);
    });

    it('warns and skips a non-object level value', () => {
      const warnings = [];
      const out = resolveLevelEntry(
        { medium: { model: 'ok' }, high: 'claude-opus-5' },
        'high',
        m => warnings.push(m)
      );
      assert.deepEqual(out, { model: 'ok' });
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /high/);
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
      // local is next after agy (which is now unavailable)
      const target = out['code-review'].targets[0];
      assert.equal(target.platform, 'local');
      assert.equal(target.effort, undefined);
    });
  });

  describe('review sections resolve level-keyed model/effort', () => {
    const LEVELED_CONFIG = {
      ...BASE_CONFIG,
      'code-review': {
        agy: {
          model: 'gemini-3.8-flash',
          low: { effort: 'high' },
          max: { effort: 'max' },
        },
      },
      'plan-review': {
        agy: {
          model: 'gemini-3.8-flash',
          low: { effort: 'high' },
          max: { effort: 'max' },
        },
      },
    };

    it('rounds down to the base level key below max', () => {
      for (const level of ['low', 'medium', 'high']) {
        const out = resolveFlow({ platform: 'claude', level }, LIVE_ALL, LEVELED_CONFIG, noWarn);
        const target = out['code-review'].targets.find(t => t.platform === 'agy');
        assert.equal(target.effort, 'high', `level ${level}`);
        assert.equal(target.model, 'gemini-3.8-flash', `level ${level}`);
      }
    });

    it('matches the max level key exactly', () => {
      const out = resolveFlow({ platform: 'claude', level: 'max' }, LIVE_ALL, LEVELED_CONFIG, noWarn);
      assert.equal(out['code-review'].targets.find(t => t.platform === 'agy').effort, 'max');
      assert.equal(out['plan-review'].targets.find(t => t.platform === 'agy').effort, 'max');
    });

    it('names the section in a config-shape warning', () => {
      const warnings = [];
      const config = { ...BASE_CONFIG, 'code-review': { agy: { model: 'm', hgih: { effort: 'high' } } } };
      resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config, m => warnings.push(m));
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /code-review/);
      assert.match(warnings[0], /hgih/);
    });
  });

  describe('rounds count waves, not dispatches', () => {
    it('always reports rounds, including for multi-target levels', () => {
      for (const level of ['low', 'medium', 'high', 'max']) {
        const out = resolveFlow({ platform: 'claude', level }, LIVE_ALL, BASE_CONFIG);
        assert.equal(typeof out['code-review'].rounds, 'number', `code-review rounds at ${level}`);
        assert.equal(typeof out['plan-review'].rounds, 'number', `plan-review rounds at ${level}`);
      }
    });

    it('leaves rounds independent of how many targets a wave dispatches', () => {
      const out = resolveFlow({ platform: 'claude', level: 'high' }, LIVE_ALL, BASE_CONFIG);
      // 2 live non-orchestrator targets, but the budget stays at 3 waves
      assert.equal(out['code-review'].targets.length, 2);
      assert.equal(out['code-review'].rounds, 3);
    });

    it('counts plan-review and code-review rounds separately', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['plan-review'].rounds, 1);
      assert.equal(out['code-review'].rounds, 3);
    });
  });

  describe('no non-orchestrator candidates', () => {
    it('returns empty targets (not an error) when no external platforms live', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_NONE_EXTERNAL, BASE_CONFIG);
      assert.deepEqual(out['code-review'].targets, []);
    });
  });
});
