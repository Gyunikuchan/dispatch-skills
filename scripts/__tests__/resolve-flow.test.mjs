import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveFlow } from '../../implement-dispatch/scripts/resolve-flow.mjs';

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

  describe('no non-orchestrator candidates', () => {
    it('returns empty targets (not an error) when no external platforms live', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_NONE_EXTERNAL, BASE_CONFIG);
      assert.deepEqual(out['code-review'].targets, []);
    });
  });
});
