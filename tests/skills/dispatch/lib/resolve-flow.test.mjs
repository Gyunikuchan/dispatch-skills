import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  defaultLiveness,
  normalizePin,
  parseImplementationFields,
  parsePins,
  probeCandidates,
  resolveFlow,
  resolveImplementationEscalation,
  RUNNER_FILES,
} from '../../../../skills/dispatch/scripts/lib/resolve-flow.mjs';

const DISPATCH_SCRIPTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../skills/dispatch/scripts'
);

// Stub liveness: all available except 'copilot'
const LIVE_ALL = { claude: true, agy: true, copilot: false, opencode: true };
const LIVE_NONE_EXTERNAL = { claude: true, agy: false, copilot: false, opencode: false };
const ALL_DEAD = { claude: false, agy: false, copilot: false, opencode: false };

/** Strict read-provider wrapper: one target per candidate, each a single `low` level. */
const targetsOf = (...candidates) => ({ targets: candidates.map(candidate => ({ low: candidate })) });

const READ_DELEGATES = {
  claude: targetsOf({ model: 'claude-opus-5', effort: 'medium' }),
  agy: targetsOf({ model: 'gemini-3.8-flash', effort: 'medium' }),
  copilot: targetsOf({ model: 'gpt-5.6-luna', effort: 'max' }),
  opencode: targetsOf({ model: 'lmstudio/qwen3.8-27b-ridge', effort: 'medium' }),
};

const WRITE_SUBAGENTS = {
  claude: { low: { model: 'claude-opus-5', effort: 'medium' } },
  agy: { low: { model: 'gemini-3.8-flash', effort: 'medium' } },
  copilot: { low: { model: 'gpt-5.6-luna', effort: 'max' } },
};

/** Config: design-review is deliberately absent, so it resolves as disabled. */
const BASE_CONFIG = {
  'read-delegates': READ_DELEGATES,
  'write-subagents': WRITE_SUBAGENTS,
  phases: {
    'plan-review': {
      rounds: { low: 0, medium: 1, max: 3 },
      targets: { low: 0, medium: 1, max: 'all' },
      consensus: { low: false, high: true },
    },
    'code-review': {
      rounds: { low: 1, medium: 3, max: 5 },
      targets: { low: 1, high: 'all' },
      consensus: { low: false, high: true },
    },
  },
};

/**
 * Clone of BASE_CONFIG with table replacements and per-phase patches.
 * `read-delegates` and `write-subagents` replace the whole table; phase keys merge into that phase.
 */
function withConfig({ 'read-delegates': readDelegates, 'write-subagents': writeSubagents, ...phasePatches } = {}) {
  const phases = Object.fromEntries(
    Object.entries(BASE_CONFIG.phases).map(([phase, value]) => [phase, { ...value }]),
  );
  for (const [phase, patch] of Object.entries(phasePatches)) {
    phases[phase] = { ...phases[phase], ...patch };
  }
  return {
    'read-delegates': readDelegates ?? { ...READ_DELEGATES },
    'write-subagents': writeSubagents ?? { ...WRITE_SUBAGENTS },
    phases,
  };
}

describe('resolveFlow', () => {
  describe('level: low', () => {
    it('skips plan-review (rounds=0, empty targets)', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'low', implementationFields: 'model,effort' },
        LIVE_ALL,
        BASE_CONFIG,
      );
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

    it('implementation matches the orchestrator write-subagent entry', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'low', implementationFields: 'model,effort' },
        LIVE_ALL,
        BASE_CONFIG,
      );
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
      // agy, opencode, and claude (orchestrator) available
      assert.equal(out['code-review'].targets.length, 3);
    });
  });

  describe('level: xhigh', () => {
    it('plan-review: 1 target, rounds=1, consensus=true', () => {
      const out = resolveFlow({ platform: 'claude', level: 'xhigh' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['plan-review'].rounds, 1);
      assert.equal(out['plan-review'].consensus, true);
      assert.equal(out['plan-review'].targets.length, 1);
    });

    it('code-review: all targets, rounds=3, consensus=true', () => {
      const out = resolveFlow({ platform: 'claude', level: 'xhigh' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].rounds, 3);
      assert.equal(out['code-review'].consensus, true);
      assert.equal(out['code-review'].targets.length, 3);
    });
  });

  describe('level: max', () => {
    it('plan-review: all targets including self, rounds=3, consensus=true', () => {
      const out = resolveFlow({ platform: 'claude', level: 'max' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['plan-review'].rounds, 3);
      assert.equal(out['plan-review'].consensus, true);
      assert.equal(out['plan-review'].targets.length, 3);
      assert.ok(out['plan-review'].targets.find(t => t.platform === 'claude'));
    });

    it('code-review: all targets including self, rounds=5, consensus=true', () => {
      const out = resolveFlow({ platform: 'claude', level: 'max' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].rounds, 5);
      assert.equal(out['code-review'].consensus, true);
      assert.equal(out['code-review'].targets.length, 3);
      assert.ok(out['code-review'].targets.find(t => t.platform === 'claude'));
    });

    it('sorts the orchestrator last when targets includes it', () => {
      const out = resolveFlow({ platform: 'claude', level: 'max' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].targets.at(-1).platform, 'claude');
    });
  });

  describe('output shape', () => {
    it('emits rounds for every review phase', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium' }, LIVE_ALL, BASE_CONFIG);
      for (const phase of ['plan-review', 'design-review', 'code-review']) {
        assert.ok(out[phase], `${phase} section present`);
        assert.equal(typeof out[phase].rounds, 'number', `${phase}.rounds`);
      }
    });
  });

  describe('design-review phase', () => {
    const DESIGN = {
      rounds: { low: 1, high: 4 },
      targets: { low: 1, high: 2 },
      consensus: { low: false, medium: true },
    };

    it('resolves design-review from phases.design-review like the other review phases', () => {
      const config = withConfig({ 'design-review': DESIGN });
      const out = resolveFlow({ platform: 'claude', level: 'high' }, LIVE_ALL, config);
      assert.equal(out['design-review'].rounds, 4);
      assert.equal(out['design-review'].consensus, true);
      assert.deepEqual(out['design-review'].targets.map(t => t.platform), ['agy', 'opencode']);
      assert.deepEqual(out['design-review'].reserves.map(t => t.platform), ['claude']);
      assert.equal(out['design-review'].targets[0].candidateId, 'design-review:agy:0');
    });

    it('applies level fallbacks to design-review knobs', () => {
      const config = withConfig({ 'design-review': DESIGN });
      const out = resolveFlow({ platform: 'claude', level: 'medium' }, LIVE_ALL, config);
      assert.equal(out['design-review'].rounds, 1);
      assert.equal(out['design-review'].targets.length, 1);
      assert.equal(out['design-review'].consensus, true);
    });

    it('applies named pins to design-review', () => {
      const config = withConfig({ 'design-review': DESIGN });
      const out = resolveFlow({ platform: 'claude', level: 'low', pins: ['opencode'] }, LIVE_ALL, config);
      assert.deepEqual(out['design-review'].targets.map(t => t.platform), ['opencode']);
    });
  });

  describe('missing phase is disabled', () => {
    it('resolves an absent phases.<phase> as off (rounds 0, no targets, no reserves) and marks it not configured', () => {
      const out = resolveFlow({ platform: 'claude', level: 'max' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['design-review'].rounds, 0);
      assert.deepEqual(out['design-review'].targets, []);
      assert.deepEqual(out['design-review'].reserves, []);
      assert.equal(out['design-review'].configured, false);
      assert.notEqual(out['code-review'].configured, false);
    });

    it('keeps an absent phase off even under an all pin', () => {
      const out = resolveFlow({ platform: 'claude', level: 'max', pins: ['all'] }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['design-review'].rounds, 0);
      assert.deepEqual(out['design-review'].targets, []);
    });

    it('resolves every review phase off for an ask-only config without throwing (tolerated implementation)', () => {
      const config = { 'read-delegates': READ_DELEGATES };
      const out = resolveFlow(
        { platform: 'claude', level: 'high', tolerateMissingImplementationModel: true },
        LIVE_ALL,
        config,
      );
      for (const phase of ['plan-review', 'design-review', 'code-review']) {
        assert.equal(out[phase].rounds, 0, phase);
        assert.deepEqual(out[phase].targets, [], phase);
        assert.equal(out[phase].configured, false, phase);
      }
      assert.equal(out.implementation.diagnostic.code, 'WRITE_SUBAGENT_NOT_CONFIGURED');
      assert.equal(out.implementation.diagnostic.key, 'write-subagents.claude');
    });

    it('treats an empty phases table like an absent one', () => {
      const config = { 'read-delegates': READ_DELEGATES, 'write-subagents': WRITE_SUBAGENTS, phases: {} };
      const out = resolveFlow({ platform: 'claude', level: 'high' }, LIVE_ALL, config);
      assert.equal(out['code-review'].rounds, 0);
      assert.equal(out['plan-review'].rounds, 0);
    });
  });

  describe('only filtering', () => {
    it('restricts a phase to its only list while other phases see every read delegate', () => {
      const config = withConfig({ 'code-review': { only: ['opencode', 'claude'], targets: { low: 'all' } } });
      const out = resolveFlow({ platform: 'claude', level: 'max' }, LIVE_ALL, config);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['opencode', 'claude']);
      assert.deepEqual(out['plan-review'].targets.map(t => t.platform), ['agy', 'opencode', 'claude']);
    });

    it('keeps read-delegates key order rather than only order', () => {
      const config = withConfig({ 'code-review': { only: ['opencode', 'agy'], targets: { low: 'all' } } });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy', 'opencode']);
    });

    it('normalizes aliases in only', () => {
      const config = withConfig({ 'code-review': { only: ['antigravity'] } });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy']);
      assert.deepEqual(out['code-review'].reserves, []);
    });

    it('validates pins against the union of phase members, independent of level', () => {
      const config = withConfig({
        'plan-review': { only: ['agy'] },
        'code-review': { only: ['agy', 'opencode'] },
      });
      // plan-review is off at low, yet opencode is still a valid pin through code-review.
      const out = resolveFlow({ platform: 'claude', level: 'low', pins: ['opencode'] }, LIVE_ALL, config);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['opencode']);
      assert.throws(
        () => resolveFlow({ platform: 'claude', level: 'low', pins: ['copilot'] }, LIVE_ALL, config),
        /copilot/,
      );
    });

    it('validates pins against every read-delegate key when phases is absent', () => {
      const config = { 'read-delegates': READ_DELEGATES, 'write-subagents': WRITE_SUBAGENTS };
      assert.doesNotThrow(
        () => resolveFlow({ platform: 'claude', level: 'low', pins: ['copilot'] }, LIVE_ALL, config),
      );
    });

    it('reports droppedPins for a phase whose only list excludes the pin', () => {
      const config = withConfig({
        'plan-review': { rounds: { low: 1 }, targets: { low: 1 }, only: ['claude', 'agy'] },
      });
      const out = resolveFlow({ platform: 'claude', level: 'low', pins: ['opencode'] }, LIVE_ALL, config);
      assert.deepEqual(out.diagnostics.droppedPins['plan-review'], ['opencode']);
      assert.equal(out.diagnostics.droppedPins['code-review'], undefined);
      assert.deepEqual(out['plan-review'].targets, []);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['opencode']);
    });

    it('omits droppedPins when the phase is off', () => {
      const config = withConfig({ 'plan-review': { rounds: { low: 0 }, only: ['claude', 'agy'] } });
      const out = resolveFlow({ platform: 'claude', level: 'low', pins: ['opencode'] }, LIVE_ALL, config);
      assert.equal(out.diagnostics.droppedPins['plan-review'], undefined);
    });
  });

  describe('pins', () => {
    it('overrides targets: three pins at a level whose targets is 1', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'medium', pins: ['opencode', 'agy', 'claude'] },
        LIVE_ALL,
        BASE_CONFIG
      );
      assert.equal(out['code-review'].rounds, 3);
      assert.equal(out['code-review'].targets.length, 3);
    });

    it('preserves pin order', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'medium', pins: ['opencode', 'agy', 'claude'] },
        LIVE_ALL,
        BASE_CONFIG
      );
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['opencode', 'agy', 'claude']);
    });

    it('keeps every configured named pin regardless of probe status', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium', pins: ['agy', 'copilot'] }, LIVE_ALL, BASE_CONFIG);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy', 'copilot']);
      assert.equal(out.diagnostics.droppedPins['code-review'], undefined);
      assert.ok(out.diagnostics.unavailable.includes('copilot'));
    });

    it('pin on orchestrator platform: targets orchestrator platform directly', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium', pins: ['claude'] }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].targets.length, 1);
      assert.equal(out['code-review'].targets[0].platform, 'claude');
    });

    it('pinned runs carry no reserves', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium', pins: ['agy'] }, LIVE_ALL, BASE_CONFIG);
      assert.deepEqual(out['code-review'].reserves, []);
    });

    it('throws on unrecognized pin key', () => {
      assert.throws(
        () => resolveFlow({ platform: 'claude', level: 'medium', pins: ['bogus'] }, LIVE_ALL, BASE_CONFIG),
        /bogus/
      );
    });

    it('dedupes repeated pins and alias/canonical pairs', () => {
      for (const pins of [['agy', 'agy'], ['antigravity'], ['antigravity', 'agy']]) {
        const out = resolveFlow({ platform: 'claude', level: 'medium', pins }, LIVE_ALL, BASE_CONFIG);
        assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy'], pins.join(','));
      }
    });

    it('pins "all" dispatches to every configured target in count order', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low', pins: ['all'] }, LIVE_ALL, BASE_CONFIG);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy', 'copilot', 'opencode', 'claude']);
      // plan-review at level low has rounds=0, so targets is empty
      assert.deepEqual(out['plan-review'].targets, []);
      const mediumOut = resolveFlow({ platform: 'claude', level: 'medium', pins: ['all'] }, LIVE_ALL, BASE_CONFIG);
      assert.deepEqual(mediumOut['plan-review'].targets.map(t => t.platform), ['agy', 'copilot', 'opencode', 'claude']);
    });

    it('pins "all" reports offline platforms as unavailable rather than dropped named pins', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium', pins: ['all'] }, LIVE_ALL, BASE_CONFIG);
      assert.deepEqual(out.diagnostics.unavailable, ['copilot']);
      assert.deepEqual(out.diagnostics.droppedPins, {});
    });

    it('pins "all" keeps configured targets when every liveness probe fails', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium', pins: ['all'] }, ALL_DEAD, BASE_CONFIG);
      for (const phase of ['plan-review', 'code-review']) {
        assert.deepEqual(out[phase].targets.map(t => t.platform), ['agy', 'copilot', 'opencode', 'claude']);
      }
    });

    it('pins "all" normalizes case (ALL)', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low', pins: ['ALL'] }, LIVE_ALL, BASE_CONFIG);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy', 'copilot', 'opencode', 'claude']);
    });

    it('rejects "all" combined with a named platform', () => {
      assert.throws(
        () => resolveFlow({ platform: 'claude', level: 'low', pins: ['agy', 'all'] }, LIVE_ALL, BASE_CONFIG),
        /count or "all" pin must stand alone/
      );
    });
  });

  describe('count pins', () => {
    it('a count of 2 at a level whose targets is 1 gives 2 targets plus reserves, orchestrator last', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium', pins: ['2'] }, LIVE_ALL, BASE_CONFIG);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy', 'copilot']);
      assert.deepEqual(out['code-review'].reserves.map(t => t.platform), ['opencode', 'claude']);
    });

    it('clamps a count above live candidates and records clamped', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium', pins: ['9'] }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].targets.length, 4);
      assert.deepEqual(out.diagnostics.clamped['code-review'], { requested: 9, resolved: 4 });
    });

    it('forces a phase whose targets is 0 to run when rounds > 0', () => {
      const config = withConfig({ 'code-review': { targets: { medium: 0 }, rounds: { medium: 2 } } });
      const out = resolveFlow({ platform: 'claude', level: 'medium', pins: ['2'] }, LIVE_ALL, config);
      assert.equal(out['code-review'].rounds, 2);
      assert.equal(out['code-review'].targets.length, 2);
    });

    it('keeps a phase off when rounds is 0 — counts never resurrect it', () => {
      const config = withConfig({ 'code-review': { rounds: { medium: 0 } } });
      const out = resolveFlow({ platform: 'claude', level: 'medium', pins: ['2'] }, LIVE_ALL, config);
      assert.equal(out['code-review'].rounds, 0);
      assert.deepEqual(out['code-review'].targets, []);
    });

    it('respects exclude with a count pin', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'medium', pins: ['2'], exclude: ['agy'] },
        LIVE_ALL,
        BASE_CONFIG
      );
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['copilot', 'opencode']);
    });

    it('reports diagnostics.targetCountPin for count, all, and otherwise', () => {
      assert.equal(resolveFlow({ platform: 'claude', level: 'medium', pins: ['3'] }, LIVE_ALL, BASE_CONFIG).diagnostics.targetCountPin, 3);
      assert.equal(resolveFlow({ platform: 'claude', level: 'medium', pins: ['all'] }, LIVE_ALL, BASE_CONFIG).diagnostics.targetCountPin, 'all');
      assert.equal(resolveFlow({ platform: 'claude', level: 'medium' }, LIVE_ALL, BASE_CONFIG).diagnostics.targetCountPin, null);
      assert.equal(resolveFlow({ platform: 'claude', level: 'medium', pins: ['agy'] }, LIVE_ALL, BASE_CONFIG).diagnostics.targetCountPin, null);
    });

    it('throws on a count pin of 0 and on mixed count pins', () => {
      assert.throws(
        () => resolveFlow({ platform: 'claude', level: 'medium', pins: ['0'] }, LIVE_ALL, BASE_CONFIG),
        /count pin must be an integer from 1 to/
      );
      for (const pins of [['2', 'claude'], ['all', '2'], ['2', '3']]) {
        assert.throws(
          () => resolveFlow({ platform: 'claude', level: 'medium', pins }, LIVE_ALL, BASE_CONFIG),
          /count or "all" pin must stand alone/
        );
      }
    });
  });

  describe('parsePins', () => {
    it('returns undefined keys and count for absent or empty input', () => {
      assert.deepEqual(parsePins(undefined), { keys: undefined, count: undefined });
      assert.deepEqual(parsePins([]), { keys: undefined, count: undefined });
    });

    it('coerces and trims a numeric element', () => {
      assert.deepEqual(parsePins([' 3 ']), { keys: undefined, count: 3 });
      assert.deepEqual(parsePins([3]), { keys: undefined, count: 3 });
    });

    it('passes a provider-key list and the "all" keyword through unchanged', () => {
      assert.deepEqual(parsePins(['agy', 'claude']), { keys: ['agy', 'claude'], count: undefined });
      assert.deepEqual(parsePins(['all']), { keys: ['all'], count: undefined });
    });

    it('throws when a count is below 1 or not a safe integer', () => {
      for (const raw of ['0', '-1', '99999999999999999999']) {
        assert.throws(() => parsePins([raw]), /count pin must be an integer from 1 to/);
      }
    });

    it('throws when a count pin is combined with anything else', () => {
      assert.throws(() => parsePins(['2', 'claude']), /count or "all" pin must stand alone/);
      assert.throws(() => parsePins(['all', '2']), /count or "all" pin must stand alone/);
      assert.throws(() => parsePins(['2', '3']), /count or "all" pin must stand alone/);
    });
  });

  describe('targets knob', () => {
    it('0 skips the phase', () => {
      const config = withConfig({ 'code-review': { targets: { low: 0 } } });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config);
      assert.deepEqual(out['code-review'].targets, []);
    });

    it('1 selects the first live non-orchestrator candidate; 2 selects two in config order', () => {
      const one = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, withConfig({ 'code-review': { targets: { low: 1 } } }));
      assert.deepEqual(one['code-review'].targets.map(t => t.platform), ['agy']);
      const two = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, withConfig({ 'code-review': { targets: { low: 2 } } }));
      assert.deepEqual(two['code-review'].targets.map(t => t.platform), ['agy', 'opencode']);
    });

    it('"all" selects every live candidate with no reserves', () => {
      const config = withConfig({ 'code-review': { targets: { low: 'all' } } });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy', 'opencode', 'claude']);
      assert.deepEqual(out['code-review'].reserves, []);
    });

    it('clamps to the available candidates and records the clamp', () => {
      const config = withConfig({ 'code-review': { targets: { low: 4 } } });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config);
      assert.equal(out['code-review'].targets.length, 3);
      assert.deepEqual(out.diagnostics.clamped['code-review'], { requested: 4, resolved: 3 });
    });

    it('returns the live candidates beyond targets as ordered reserves', () => {
      const config = withConfig({ 'code-review': { targets: { low: 1 } } });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy']);
      assert.deepEqual(out['code-review'].reserves, [
        { candidateId: 'code-review:opencode:0', platform: 'opencode', model: 'lmstudio/qwen3.8-27b-ridge', effort: 'medium' },
        { candidateId: 'code-review:claude:0', platform: 'claude', model: 'claude-opus-5', effort: 'medium' },
      ]);
    });

    it('returns no reserves for a phase that is off', () => {
      const config = withConfig({ 'code-review': { rounds: { low: 0 } } });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config);
      assert.deepEqual(out['code-review'].reserves, []);
    });

    it('records no clamp when the count is satisfied', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out.diagnostics.clamped['code-review'], undefined);
    });

    it('fulfills targets with orchestrator when external candidates are insufficient', () => {
      const liveAgyOnly = { claude: true, agy: true, copilot: false, opencode: false };
      const config = withConfig({ 'code-review': { targets: { low: 2 } } });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, liveAgyOnly, config);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy', 'claude']);
    });
  });

  describe('phase skip', () => {
    it('rounds=0 skips even with a named pin', () => {
      const config = withConfig({ 'code-review': { rounds: { low: 0 } } });
      const out = resolveFlow({ platform: 'claude', level: 'low', pins: ['copilot'] }, LIVE_ALL, config);
      assert.deepEqual(out['code-review'].targets, []);
      assert.equal(out['code-review'].rounds, 0);
    });

    it('targets=0 does not skip when named pins are given — pins override breadth', () => {
      const config = withConfig({ 'code-review': { targets: { low: 0 } } });
      const out = resolveFlow({ platform: 'claude', level: 'low', pins: ['agy'] }, LIVE_ALL, config);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy']);
      const offline = resolveFlow({ platform: 'claude', level: 'low', pins: ['copilot'] }, LIVE_ALL, config);
      assert.deepEqual(offline['code-review'].targets.map(t => t.platform), ['copilot']);
    });

    it('targets=0 does not skip when pins="all" is given — fans out fully', () => {
      const config = withConfig({ 'code-review': { targets: { low: 0 }, rounds: { low: 2 } } });
      const out = resolveFlow({ platform: 'claude', level: 'low', pins: ['all'] }, LIVE_ALL, config);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy', 'copilot', 'opencode', 'claude']);
      assert.equal(out['code-review'].rounds, 2);
    });

    it('normalizes rounds to 0 when targets is zero and unpinned', () => {
      const config = withConfig({ 'code-review': { targets: { low: 0 }, rounds: { low: 3 } } });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config);
      assert.equal(out['code-review'].rounds, 0);
      assert.deepEqual(out['code-review'].targets, []);
    });

    it('returns rounds > 0 with empty targets when platforms are unavailable', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low' }, ALL_DEAD, BASE_CONFIG);
      assert.deepEqual(out['code-review'].targets, []);
      assert.ok(out['code-review'].rounds > 0);
    });
  });

  describe('diagnostics', () => {
    it('reports the effective level', () => {
      const out = resolveFlow({ platform: 'claude', level: 'high' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out.diagnostics.effectiveLevel, 'high');
    });

    it('reports configured read delegates that are not live', () => {
      const out = resolveFlow({ platform: 'claude', level: 'high' }, LIVE_ALL, BASE_CONFIG);
      assert.deepEqual(out.diagnostics.unavailable, ['copilot']);
      const out2 = resolveFlow({ platform: 'claude', level: 'high' }, LIVE_NONE_EXTERNAL, BASE_CONFIG);
      assert.deepEqual(out2.diagnostics.unavailable, ['agy', 'copilot', 'opencode']);
    });

    it('defaults livenessSource to "probe" and reports a supplied source', () => {
      assert.equal(resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, BASE_CONFIG).diagnostics.livenessSource, 'probe');
      const out = resolveFlow({ platform: 'claude', level: 'low', livenessSource: 'env-override' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out.diagnostics.livenessSource, 'env-override');
    });

    it('throws for an unrecognized level', () => {
      assert.throws(
        () => resolveFlow({ platform: 'claude', level: 'ultra' }, LIVE_ALL, BASE_CONFIG),
        /Unknown level "ultra"/
      );
    });

    it('throws for an unrecognized platform, naming the valid keys', () => {
      assert.throws(
        () => resolveFlow({ platform: 'bogus', level: 'low' }, LIVE_ALL, BASE_CONFIG),
        /Unknown platform "bogus"\. Valid platforms: .*claude/
      );
    });
  });

  describe('implementation (write-subagents)', () => {
    it('always includes platform field', () => {
      const out = resolveFlow({ platform: 'agy', level: 'low' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out.implementation.platform, 'agy');
    });

    it('rejects a missing write-subagents entry, naming the key', () => {
      assert.throws(
        () => resolveFlow({ platform: 'opencode', level: 'low' }, LIVE_ALL, BASE_CONFIG),
        /write-subagents\.opencode is not configured/,
      );
    });

    it('rejects a missing write-subagents table, naming the key', () => {
      const config = { 'read-delegates': READ_DELEGATES, phases: BASE_CONFIG.phases };
      assert.throws(
        () => resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config),
        /write-subagents\.claude is not configured/,
      );
    });

    it('tolerates a missing entry under tolerateMissingImplementationModel with a diagnostic', () => {
      const out = resolveFlow(
        { platform: 'opencode', level: 'low', tolerateMissingImplementationModel: true },
        LIVE_ALL,
        BASE_CONFIG,
      );
      assert.equal(out.implementation.platform, 'opencode');
      assert.equal(out.implementation.diagnostic.code, 'WRITE_SUBAGENT_NOT_CONFIGURED');
      assert.equal(out.implementation.diagnostic.key, 'write-subagents.opencode');
    });

    it('resolves level-keyed write-subagent entries', () => {
      const config = withConfig({
        'write-subagents': {
          claude: {
            medium: { model: 'claude-sonnet-5', effort: 'medium' },
            high: { model: 'claude-opus-5', effort: 'medium' },
          },
        },
      });
      const out = resolveFlow({ platform: 'claude', level: 'max' }, LIVE_ALL, config);
      assert.equal(out.implementation.model, 'claude-opus-5');
    });

    it('rejects a write-subagent level without a model for every platform', () => {
      // The strict schema requires `model` at every level, so the error no longer depends on --platform.
      const config = withConfig({
        'write-subagents': { claude: { high: { effort: 'high' } }, opencode: { low: { model: 'write-model', effort: 'medium' } } },
      });
      for (const platform of ['opencode', 'claude']) {
        assert.throws(() => resolveFlow({ platform }, LIVE_ALL, config), /write-subagents\.claude\.high\.model is required/);
      }
    });

    it('reports applicable and ignored configured fields', () => {
      const out = resolveFlow({ platform: 'claude', implementationFields: 'model' }, LIVE_ALL, BASE_CONFIG);
      assert.deepEqual(out.implementation.applicableFields, ['model']);
      assert.deepEqual(out.implementation.ignoredConfiguredFields, ['effort']);
      assert.equal(out.implementation.model, 'claude-opus-5');
      assert.equal(out.implementation.effort, undefined);
    });

    it('resolves a model cascade array with effort and single-level exhaustion', () => {
      const config = withConfig({
        'write-subagents': { copilot: { low: { model: ['gpt-5.6-luna', 'bedrock.gpt-5.6-luna'], effort: 'max' } } },
      });
      const out = resolveFlow({ platform: 'copilot', implementationFields: 'model,effort' }, LIVE_ALL, config);
      assert.deepEqual(out.implementation.applicableFields, ['model', 'effort']);
      assert.deepEqual(out.implementation.ignoredConfiguredFields, []);
      assert.deepEqual(out.implementation.model, ['gpt-5.6-luna', 'bedrock.gpt-5.6-luna']);
      assert.equal(out.implementation.effort, 'max');
      assert.deepEqual(out.implementation.escalation, { status: 'exhausted', reason: 'no-distinct-higher-level' });
    });

    it('normalizes --platform aliases before self-exclusion', () => {
      const out = resolveFlow({ platform: 'claudecode', level: 'low' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out.implementation.platform, 'claude');
      assert.equal(out.implementation.model, 'claude-opus-5');
      assert.ok(out['code-review'].targets.every(t => t.platform !== 'claude'));
    });

    it('does not throw when platform is omitted', () => {
      assert.doesNotThrow(() => resolveFlow({ level: 'low' }, LIVE_ALL, BASE_CONFIG));
    });
  });

  describe('implementation escalation', () => {
    it('steps above the requested level, not the nearest-lower resolved key', () => {
      const entry = {
        low: { model: 'low-model' },
        medium: { model: 'medium-model' },
        max: { model: 'max-model', effort: 'high' },
      };
      assert.deepEqual(resolveImplementationEscalation(entry, 'high', ['model', 'effort']), {
        status: 'available',
        level: 'max',
        model: 'max-model',
        effort: 'high',
      });
    });

    it('skips higher levels equivalent over applicable fields', () => {
      const entry = {
        low: { model: 'same', effort: 'low' },
        high: { model: 'same', effort: 'high' },
        max: { model: 'different', effort: 'high' },
      };
      assert.deepEqual(resolveImplementationEscalation(entry, 'low', ['model']), {
        status: 'available',
        level: 'max',
        model: 'different',
      });
    });

    it('skips a model-less higher tier and effort-only differences the launcher cannot apply', () => {
      const entry = {
        low: { model: 'same', effort: 'low' },
        high: { effort: 'high' },
        max: { model: 'same', effort: 'max' },
      };
      assert.deepEqual(resolveImplementationEscalation(entry, 'low', ['model']), {
        status: 'exhausted',
        reason: 'no-distinct-higher-level',
      });
      assert.deepEqual(resolveImplementationEscalation(entry, 'low', ['model', 'effort']), {
        status: 'available',
        level: 'max',
        model: 'same',
        effort: 'max',
      });
    });

    it('handles escalation with array models and normalized single-element arrays', () => {
      const entry = {
        low: { model: ['model-a', 'model-b'] },
        medium: { model: ['model-a', 'model-b'] },
        high: { model: ['model-c', 'model-d'] },
      };
      assert.deepEqual(resolveImplementationEscalation(entry, 'low', ['model']), {
        status: 'available',
        level: 'high',
        model: ['model-c', 'model-d'],
      });
      assert.deepEqual(
        resolveImplementationEscalation({ low: { model: 'same-model' }, high: { model: ['same-model'] } }, 'low', ['model']),
        { status: 'exhausted', reason: 'no-distinct-higher-level' },
      );
    });

    it('returns explicit exhaustion for level-less and top-level entries', () => {
      assert.deepEqual(resolveImplementationEscalation({}, 'low', ['model']), {
        status: 'exhausted',
        reason: 'no-distinct-higher-level',
      });
      assert.deepEqual(resolveImplementationEscalation({ max: { model: 'top' } }, 'max', ['model']), {
        status: 'exhausted',
        reason: 'no-distinct-higher-level',
      });
    });
  });

  describe('parseImplementationFields', () => {
    it('defaults to model and accepts model plus effort', () => {
      assert.deepEqual(parseImplementationFields(), ['model']);
      assert.deepEqual(parseImplementationFields('effort,model'), ['model', 'effort']);
      assert.deepEqual(parseImplementationFields('none'), []);
      assert.deepEqual(parseImplementationFields(''), []);
    });

    it('rejects unknown and effort-only field sets', () => {
      assert.throws(() => parseImplementationFields('model,temperature'), /implementation-fields/);
      assert.throws(() => parseImplementationFields('effort'), /implementation-fields/);
    });
  });

  describe('targets carry model/effort from read-delegates', () => {
    it('target entry carries model and effort', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, BASE_CONFIG);
      const target = out['code-review'].targets[0];
      assert.equal(target.model, 'gemini-3.8-flash');
      assert.equal(target.effort, 'medium');
    });

    it('target without effort omits effort field', () => {
      // Effort is optional per level; an omitted effort is never inherited.
      const config = withConfig({ 'read-delegates': { ...READ_DELEGATES, opencode: targetsOf({ model: 'opencode-model' }) } });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, { ...LIVE_ALL, agy: false }, config);
      const target = out['code-review'].targets[0];
      assert.equal(target.platform, 'opencode');
      assert.equal(target.effort, undefined);
    });

    it('resolves level-keyed read-delegate overrides for every review phase alike', () => {
      const config = withConfig({
        'read-delegates': { agy: { targets: [{ low: { model: 'gemini-3.8-flash', effort: 'high' }, max: { model: 'gemini-3.8-flash', effort: 'max' } }] } },
        'plan-review': { rounds: { low: 1 }, targets: { low: 1 } },
      });
      for (const level of ['low', 'medium', 'high', 'xhigh']) {
        const out = resolveFlow({ platform: 'claude', level }, LIVE_ALL, config);
        assert.equal(out['code-review'].targets.find(t => t.platform === 'agy').effort, 'high', level);
      }
      const max = resolveFlow({ platform: 'claude', level: 'max' }, LIVE_ALL, config);
      assert.equal(max['code-review'].targets.find(t => t.platform === 'agy').effort, 'max');
      assert.equal(max['plan-review'].targets.find(t => t.platform === 'agy').effort, 'max');
    });
  });

  describe('rounds counts waves, not dispatches', () => {
    it('leaves rounds independent of how many targets a wave dispatches', () => {
      const out = resolveFlow({ platform: 'claude', level: 'high' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].targets.length, 3);
      assert.equal(out['code-review'].rounds, 3);
    });

    it('counts plan-review and code-review caps separately', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['plan-review'].rounds, 1);
      assert.equal(out['code-review'].rounds, 3);
    });
  });

  describe('orchestrator fulfillment & liveness', () => {
    it('fulfills targets with orchestrator when no external platforms are live', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_NONE_EXTERNAL, BASE_CONFIG);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['claude']);
    });

    it('returns empty targets (not an error) when all platforms are dead', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low' }, ALL_DEAD, BASE_CONFIG);
      assert.deepEqual(out['code-review'].targets, []);
    });
  });

  describe('multi-candidate read delegates', () => {
    it('supports an array of candidate objects on a platform', () => {
      const config = withConfig({
        'read-delegates': {
          opencode: targetsOf({ model: 'glm-5.3-flash', effort: 'high' }, { model: 'lmstudio/qwen3.8-27b-ridge', effort: 'medium' }),
          claude: targetsOf({ model: 'claude-opus-5', effort: 'medium' }),
        },
        'code-review': { targets: { low: 2 } },
      });
      const live = { claude: true, agy: false, copilot: false, opencode: true };
      const out = resolveFlow({ platform: 'claude', level: 'low' }, live, config);
      assert.deepEqual(out['code-review'].targets, [
        { candidateId: 'code-review:opencode:0', platform: 'opencode', model: 'glm-5.3-flash', effort: 'high' },
        { candidateId: 'code-review:opencode:1', platform: 'opencode', model: 'lmstudio/qwen3.8-27b-ridge', effort: 'medium' },
      ]);
    });

    it('resolves each target at the requested level independently', () => {
      const config = withConfig({
        'read-delegates': {
          opencode: { targets: [
            { low: { model: 'lmstudio/qwen3.8-27b-ridge', effort: 'medium' }, high: { model: 'glm-5.3-flash', effort: 'medium' } },
            { high: { model: 'mistral-small', effort: 'medium' } },
          ] },
        },
        'code-review': { targets: { low: 2, high: 2 } },
      });
      const live = { claude: false, agy: false, copilot: false, opencode: true };
      const lowOut = resolveFlow({ platform: 'claude', level: 'low' }, live, config);
      assert.deepEqual(lowOut['code-review'].targets.map(t => t.model), ['lmstudio/qwen3.8-27b-ridge', 'mistral-small']);
      const highOut = resolveFlow({ platform: 'claude', level: 'high' }, live, config);
      assert.deepEqual(highOut['code-review'].targets.map(t => t.model), ['glm-5.3-flash', 'mistral-small']);
    });

    it('pins dispatch all candidates configured for the pinned platform', () => {
      const config = withConfig({
        'read-delegates': {
          opencode: targetsOf({ model: 'glm-5.3-flash', effort: 'medium' }, { model: 'lmstudio/qwen3.8-27b-ridge', effort: 'medium' }),
          claude: targetsOf({ model: 'claude-opus-5', effort: 'medium' }),
        },
      });
      const live = { claude: true, agy: false, copilot: false, opencode: true };
      const out = resolveFlow({ platform: 'claude', level: 'low', pins: ['opencode'] }, live, config);
      assert.deepEqual(out['code-review'].targets.map(t => t.model), ['glm-5.3-flash', 'lmstudio/qwen3.8-27b-ridge']);
    });
  });
});

describe('resolveFlow — configured-order candidates', () => {
  const ALL_UP = { claude: true, agy: true, copilot: true, opencode: true };
  const OPENCODE_MULTI = [{ model: 'glm-5.3-flash', effort: 'medium' }, { model: 'mistral-small', effort: 'medium' }, { model: 'qwen3.8-27b', effort: 'medium' }];
  const asTargets = (entry) => (Array.isArray(entry) ? targetsOf(...entry) : targetsOf(entry));
  const label = (t) => (t.platform === 'opencode' ? t.model : t.platform);
  const multi = (agy = { model: 'gemini-3.8-flash', effort: 'medium' }) =>
    withConfig({
      'read-delegates': {
        claude: targetsOf({ model: 'claude-opus-5', effort: 'medium' }),
        agy: asTargets(agy),
        copilot: targetsOf({ model: 'gpt-5.6-luna', effort: 'medium' }),
        opencode: targetsOf(...OPENCODE_MULTI),
      },
      'code-review': { targets: { low: 3 } },
    });

  it('yields agy, copilot, glm as targets and mistral, qwen, claude as reserves', () => {
    const out = resolveFlow({ platform: 'claude', level: 'high' }, ALL_UP, multi());
    assert.deepEqual(out['code-review'].targets.map(label), ['agy', 'copilot', 'glm-5.3-flash']);
    assert.deepEqual(out['code-review'].reserves.map(label), ['mistral-small', 'qwen3.8-27b', 'claude']);
  });

  it('diversity-sorts repeated external candidates for an unpinned target count', () => {
    const out = resolveFlow({ platform: 'claude', level: 'high' }, ALL_UP, multi([{ model: 'a1', effort: 'medium' }, { model: 'a2', effort: 'medium' }]));
    const all = [...out['code-review'].targets, ...out['code-review'].reserves];
    assert.deepEqual(all.map((t) => t.model), ['a1', 'gpt-5.6-luna', 'glm-5.3-flash', 'a2', 'mistral-small', 'qwen3.8-27b', 'claude-opus-5']);
  });

  it('preserves repeated external candidates in configured order for an all pin', () => {
    const out = resolveFlow({ platform: 'claude', level: 'high', pins: ['all'] }, ALL_UP, multi([{ model: 'a1', effort: 'medium' }, { model: 'a2', effort: 'medium' }]));
    assert.deepEqual(
      out['code-review'].targets.map((t) => t.model),
      ['a1', 'a2', 'gpt-5.6-luna', 'glm-5.3-flash', 'mistral-small', 'qwen3.8-27b', 'claude-opus-5']
    );
  });

  it('preserves unpinned diversity when a programmatic caller omits the orchestrator', () => {
    const out = resolveFlow({ level: 'high' }, ALL_UP, multi([{ model: 'a1', effort: 'medium' }, { model: 'a2', effort: 'medium' }]));
    const all = [...out['code-review'].targets, ...out['code-review'].reserves];
    assert.deepEqual(all.map((t) => t.model), ['claude-opus-5', 'a1', 'gpt-5.6-luna', 'glm-5.3-flash', 'a2', 'mistral-small', 'qwen3.8-27b']);
  });

  it('preserves orchestrator candidate order after every external', () => {
    const config = withConfig({
      'read-delegates': { opencode: targetsOf(...OPENCODE_MULTI.slice(0, 2)), agy: targetsOf({ model: 'g', effort: 'medium' }) },
      'write-subagents': { ...WRITE_SUBAGENTS, opencode: { low: { model: 'opencode-write-model', effort: 'medium' } } },
      'code-review': { targets: { low: 'all' } },
    });
    const out = resolveFlow({ platform: 'opencode', level: 'low' }, ALL_UP, config);
    assert.deepEqual(out['code-review'].targets.map(label), ['agy', 'glm-5.3-flash', 'mistral-small']);
  });

  const CLAUDE_PAIR = (efforts = [undefined, undefined]) => withConfig({
    'read-delegates': {
      claude: targetsOf(
        { model: 'claude-opus-5', effort: efforts[0] ?? 'medium' },
        { model: 'claude-sonnet-5', effort: efforts[1] ?? 'medium' },
      ),
      agy: targetsOf({ model: 'gemini-3.8-flash', effort: 'medium' }),
    },
    'code-review': { targets: { low: 'all' } },
  });
  const pairs = (out) => out['code-review'].targets.map((t) => `${t.platform}:${t.model}`);

  it('demotes same platform + model match behind alternative models on the orchestrator platform', () => {
    const out = resolveFlow({ platform: 'claude', orchestratorModel: 'claude-opus-5', pins: ['all'], level: 'low' }, ALL_UP, CLAUDE_PAIR());
    assert.deepEqual(pairs(out), ['agy:gemini-3.8-flash', 'claude:claude-sonnet-5', 'claude:claude-opus-5']);
  });

  it('demotes regardless of reasoning effort', () => {
    const out = resolveFlow({ platform: 'claude', orchestratorModel: 'claude-opus-5', level: 'low' }, ALL_UP, CLAUDE_PAIR(['low', 'max']));
    assert.deepEqual(pairs(out), ['agy:gemini-3.8-flash', 'claude:claude-sonnet-5', 'claude:claude-opus-5']);
  });

  it('preserves baseline order when orchestratorModel is null', () => {
    const out = resolveFlow({ platform: 'claude', orchestratorModel: null, level: 'low' }, ALL_UP, CLAUDE_PAIR());
    assert.deepEqual(pairs(out), ['agy:gemini-3.8-flash', 'claude:claude-opus-5', 'claude:claude-sonnet-5']);
  });

  it('pinned runs bypass orchestrator model demotion', () => {
    const out = resolveFlow({ platform: 'claude', orchestratorModel: 'claude-opus-5', pins: ['claude'], level: 'low' }, ALL_UP, CLAUDE_PAIR());
    assert.deepEqual(pairs(out), ['claude:claude-opus-5', 'claude:claude-sonnet-5']);
  });

  describe('exclude', () => {
    it('keeps configured candidate IDs stable across exclusion re-resolution', () => {
      const before = resolveFlow({ platform: 'claude', level: 'high' }, ALL_UP, multi());
      const after = resolveFlow({ platform: 'claude', level: 'high', exclude: ['copilot'] }, ALL_UP, multi());
      const beforeIds = new Map(
        [...before['code-review'].targets, ...before['code-review'].reserves]
          .map((t) => [`${t.platform}:${t.model ?? ''}`, t.candidateId]),
      );
      for (const t of [...after['code-review'].targets, ...after['code-review'].reserves]) {
        assert.equal(t.candidateId, beforeIds.get(`${t.platform}:${t.model ?? ''}`));
      }
      assert.equal(beforeIds.get('opencode:glm-5.3-flash'), 'code-review:opencode:0');
      assert.equal(beforeIds.get('opencode:mistral-small'), 'code-review:opencode:1');
    });

    it('removes excluded platforms and reports them only in diagnostics.excluded', () => {
      const out = resolveFlow({ platform: 'claude', level: 'high', exclude: ['copilot'] }, ALL_UP, multi());
      assert.deepEqual(out['code-review'].targets.map(label), ['agy', 'glm-5.3-flash', 'mistral-small']);
      assert.ok(out['code-review'].reserves.every((t) => t.platform !== 'copilot'));
      assert.deepEqual(out.diagnostics.excluded, ['copilot']);
      assert.ok(!out.diagnostics.unavailable.includes('copilot'));
    });

    it('still reports a genuinely dead platform as unavailable alongside an exclusion', () => {
      const out = resolveFlow({ platform: 'claude', level: 'high', exclude: ['copilot'] }, { ...ALL_UP, opencode: false }, multi());
      assert.deepEqual(out.diagnostics.unavailable, ['opencode']);
      assert.deepEqual(out.diagnostics.excluded, ['copilot']);
    });

    it('normalizes aliases, dedupes, and sorts diagnostics.excluded; defaults to []', () => {
      const out = resolveFlow({ platform: 'claude', level: 'high', exclude: ['copilot', 'antigravity', 'agy'] }, ALL_UP, multi());
      assert.deepEqual(out.diagnostics.excluded, ['agy', 'copilot']);
      assert.deepEqual(resolveFlow({ platform: 'claude', level: 'high' }, ALL_UP, multi()).diagnostics.excluded, []);
    });

    it('throws when excluding the orchestrator platform, before unknown-key validation', () => {
      assert.throws(
        () => resolveFlow({ platform: 'claude', level: 'high', exclude: ['bogus', 'claudecode'] }, ALL_UP, multi()),
        /orchestrator/i
      );
    });

    it('throws on an unknown exclude key, listing valid keys', () => {
      assert.throws(
        () => resolveFlow({ platform: 'claude', level: 'high', exclude: ['bogus'] }, ALL_UP, multi()),
        /bogus.*Valid keys: agy, claude, copilot, opencode/
      );
    });

    it('drops an excluded pin silently and skips excluded keys under pins "all"', () => {
      const named = resolveFlow({ platform: 'claude', level: 'high', pins: ['agy', 'copilot'], exclude: ['copilot'] }, ALL_UP, multi());
      assert.deepEqual(named['code-review'].targets.map(label), ['agy']);
      assert.equal(named.diagnostics.droppedPins['code-review'], undefined);
      const all = resolveFlow({ platform: 'claude', level: 'high', pins: ['all'], exclude: ['copilot'] }, ALL_UP, multi());
      assert.ok(all['code-review'].targets.every((t) => t.platform !== 'copilot'));
    });

    it('throws when every pin is excluded', () => {
      assert.throws(
        () => resolveFlow({ platform: 'claude', level: 'high', pins: ['copilot'], exclude: ['copilot'] }, ALL_UP, multi()),
        /All pinned platforms excluded/
      );
    });
  });
});

describe('defaultLiveness test seam', () => {
  const withEnv = async (env, fn) => {
    const saved = { DISPATCH_LIVENESS_JSON: process.env.DISPATCH_LIVENESS_JSON, DISPATCH_TEST_MODE: process.env.DISPATCH_TEST_MODE };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return await fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  it('reports the override as env-override liveness under test mode', async () => {
    const result = await withEnv({ DISPATCH_LIVENESS_JSON: '{"claude":true,"agy":false}', DISPATCH_TEST_MODE: '1' }, () => defaultLiveness());
    assert.equal(result.source, 'env-override');
    assert.equal(result.liveness.claude, true);
    assert.equal(result.liveness.agy, false);
  });

  it('rejects the override when DISPATCH_TEST_MODE is absent', async () => {
    await assert.rejects(
      withEnv({ DISPATCH_LIVENESS_JSON: '{"claude":true}', DISPATCH_TEST_MODE: undefined }, () => defaultLiveness()),
      /DISPATCH_LIVENESS_JSON[\s\S]*DISPATCH_TEST_MODE/,
    );
  });

  it('rejects an unparsable override', async () => {
    await assert.rejects(
      withEnv({ DISPATCH_LIVENESS_JSON: '{not json', DISPATCH_TEST_MODE: '1' }, () => defaultLiveness()),
      /DISPATCH_LIVENESS_JSON is not valid JSON/,
    );
  });
});

describe('normalizePin', () => {
  it('canonicalizes provider aliases case-insensitively and keeps canonical keys', () => {
    assert.equal(normalizePin('claudecode'), 'claude');
    assert.equal(normalizePin('ANTIGRAVITY'), 'agy');
    assert.equal(normalizePin('agy'), 'agy');
  });

  it('preserves the reserved "all" keyword', () => {
    assert.equal(normalizePin('all'), 'all');
    assert.equal(normalizePin('ALL'), 'all');
  });

  it('passes an unknown key through unchanged, for the caller to reject by name', () => {
    assert.equal(normalizePin('Bogus'), 'Bogus');
  });
});

describe('probeCandidates', () => {
  const config = {
    'read-delegates': { agy: targetsOf({ model: 'm' }), copilot: targetsOf({ model: 'm' }) },
    'write-subagents': { claude: { low: { model: 'm' } } },
  };

  it('returns every read delegate plus the orchestrator when unpinned', () => {
    assert.deepEqual(probeCandidates({ platform: 'claude' }, config).sort(), ['agy', 'claude', 'copilot']);
  });

  it('narrows to the pinned platforms, keeping the orchestrator', () => {
    assert.deepEqual(probeCandidates({ platform: 'claude', pins: ['agy'] }, config).sort(), ['agy', 'claude']);
  });

  it('treats "all" and count pins as unpinned breadth', () => {
    assert.deepEqual(probeCandidates({ platform: 'claude', pins: ['all'] }, config).sort(), ['agy', 'claude', 'copilot']);
    assert.deepEqual(probeCandidates({ platform: 'claude', pins: ['3'] }, config).sort(), ['agy', 'claude', 'copilot']);
  });

  it('does not throw with pins and no platform', () => {
    assert.deepEqual(probeCandidates({ pins: ['agy'] }, config), ['agy']);
  });

  it('skips excluded platforms', () => {
    assert.deepEqual(probeCandidates({ platform: 'claude', exclude: ['copilot'] }, config).sort(), ['agy', 'claude']);
  });
});

describe('RUNNER_FILES availability exports', () => {
  // Pins `defaultLiveness`'s `is<Key>Available` name derivation without spawning a provider CLI.
  for (const [key, file] of Object.entries(RUNNER_FILES ?? {})) {
    it(`${file} exports is${key.charAt(0).toUpperCase()}${key.slice(1)}Available`, async () => {
      const mod = await import(pathToFileURL(path.join(DISPATCH_SCRIPTS, file)).href);
      const fnName = `is${key.charAt(0).toUpperCase()}${key.slice(1)}Available`;
      assert.equal(typeof mod[fnName], 'function', `${file} must export ${fnName}`);
    });
  }
});

// SECTION: strict config format flattened targets (SC3)
describe('flattened provider targets (strict config)', () => {
  const lvl = model => ({ low: { model, effort: 'low' } });
  // The orchestrator (copilot) is absent from the config, so no demotion reorders the targets and
  // the oracle pins pure provider-then-target declaration order.
  const MULTI = {
    'read-delegates': {
      claude: { targets: [lvl('claude-opus-5')] },
      agy: { targets: [lvl('gemini-3.8-flash')] },
      opencode: { sandbox: false, targets: [lvl('opencode-go/glm-5.3-flash'), lvl('lmstudio/qwen3.8-27b-ridge')] },
    },
    'write-subagents': { claude: { low: { model: 'claude-opus-5', effort: 'low' } }, copilot: { low: { model: 'gpt-5.6-luna', effort: 'low' } } },
    phases: { 'code-review': { rounds: { low: 1 }, targets: { low: 'all' }, consensus: { low: false } } },
  };
  const withPhase = extra => ({ ...MULTI, phases: { 'code-review': { rounds: { low: 1 }, consensus: { low: false }, ...extra } } });
  const ids = list => list.map(t => t.candidateId);
  const ORDER = ['code-review:claude:0', 'code-review:agy:0', 'code-review:opencode:0', 'code-review:opencode:1'];

  it('SC3 "all" enumerates every provider[index] target in provider-then-target order', () => {
    const out = resolveFlow({ platform: 'copilot', level: 'low' }, LIVE_ALL, MULTI);
    assert.deepEqual(ids(out['code-review'].targets), ORDER);
    assert.deepEqual(out['code-review'].targets.map(t => t.model).slice(2), ['opencode-go/glm-5.3-flash', 'lmstudio/qwen3.8-27b-ridge']);
  });

  it('SC3 numeric phase targets count each provider target independently with the remainder as reserves', () => {
    const out = resolveFlow({ platform: 'copilot', level: 'low' }, LIVE_ALL, withPhase({ targets: { low: 3 } }));
    assert.deepEqual(ids(out['code-review'].targets), ORDER.slice(0, 3));
    assert.deepEqual(ids(out['code-review'].reserves), ORDER.slice(3));
  });

  it('SC3 count pins select target identities in flatten order with the rest as reserves', () => {
    const out = resolveFlow({ platform: 'copilot', level: 'low', pins: ['2'] }, LIVE_ALL, MULTI);
    assert.deepEqual(ids(out['code-review'].targets), ORDER.slice(0, 2));
    assert.deepEqual(ids(out['code-review'].reserves), ORDER.slice(2));
  });

  it('SC3 only: [provider] includes all of that provider targets', () => {
    const out = resolveFlow({ platform: 'copilot', level: 'low' }, LIVE_ALL, withPhase({ targets: { low: 'all' }, only: ['opencode'] }));
    assert.deepEqual(ids(out['code-review'].targets), ORDER.slice(2));
  });
});
