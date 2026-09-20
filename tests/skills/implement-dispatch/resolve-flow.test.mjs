import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { KNOWN_PROVIDERS } from '../../../skills/dispatch/scripts/common.mjs';

import {
  resolveFlow,
  resolveImplementationEscalation,
  resolveLevelEntry,
  resolveLevelScalar,
  resolvePlatformCandidates,
  validateConfig,
  loadDispatchPlatformKeys,
  selectLevel,
  normalizePin,
  parsePins,
  parseImplementationFields,
  probeCandidates,
  RUNNER_FILES,
} from '../../../skills/implement-dispatch/scripts/resolve-flow.mjs';

const DISPATCH_SCRIPTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../skills/dispatch/scripts'
);

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
      const out = resolveFlow(
        { platform: 'claude', level: 'low', implementationFields: 'model,effort' },
        LIVE_ALL,
        BASE_CONFIG,
      );
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
      // agy, opencode, and claude (orchestrator) available
      assert.equal(out['code-review'].targets.length, 3);
    });
  });

  describe('level: xhigh', () => {
    it('plan-review: 1 target, maxRounds=1, consensus=true', () => {
      const out = resolveFlow({ platform: 'claude', level: 'xhigh' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['plan-review'].maxRounds, 1);
      assert.equal(out['plan-review'].consensus, true);
      assert.equal(out['plan-review'].targets.length, 1);
    });

    it('code-review: all targets, maxRounds=3, consensus=true', () => {
      const out = resolveFlow({ platform: 'claude', level: 'xhigh' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].maxRounds, 3);
      assert.equal(out['code-review'].consensus, true);
      assert.equal(out['code-review'].targets.length, 3);
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
      assert.ok(self);
    });

    it('code-review: all targets including self, maxRounds=5, consensus=true', () => {
      const out = resolveFlow({ platform: 'claude', level: 'max' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].maxRounds, 5);
      assert.equal(out['code-review'].consensus, true);
      assert.equal(out['code-review'].targets.length, 3);
      const self = out['code-review'].targets.find(t => t.platform === 'claude');
      assert.ok(self);
    });

    it('sorts the orchestrator last when targetCount includes it', () => {
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

    it('keeps every configured named pin regardless of probe status', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'medium', pins: ['agy', 'copilot'] },
        LIVE_ALL,
        BASE_CONFIG
      );
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy', 'copilot']);
    });

    it('pin on orchestrator platform: targets orchestrator platform directly', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium', pins: ['claude'] }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].targets.length, 1);
      assert.equal(out['code-review'].targets[0].platform, 'claude');
    });

    it('pinned runs carry no reserves: pins name the whole reviewer set', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium', pins: ['agy'] }, LIVE_ALL, BASE_CONFIG);
      assert.deepEqual(out['code-review'].reserves, []);
    });

    it('keeps a configured named pin when its liveness probe fails', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'medium', pins: ['copilot'] },
        LIVE_ALL,
        BASE_CONFIG
      );
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['copilot']);
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

    it('pins "all" dispatches to every configured target in count order', () => {
      // BASE_CONFIG has platforms: claude, agy, copilot, opencode
      // LIVE_ALL: claude: true, agy: true, copilot: false, opencode: true
      // At level 'low', code-review targetCount is 1, but pins: ['all'] dispatches all 3 live platforms
      const out = resolveFlow(
        { platform: 'claude', level: 'low', pins: ['all'] },
        LIVE_ALL,
        BASE_CONFIG
      );
      assert.deepEqual(
        out['code-review'].targets.map(t => t.platform),
        ['agy', 'copilot', 'opencode', 'claude']
      );
      const selfTarget = out['code-review'].targets.find(t => t.platform === 'claude');
      assert.ok(selfTarget);
      // plan-review at level low has maxRounds=0, so targets is empty
      assert.deepEqual(out['plan-review'].targets, []);

      // At level 'medium', plan-review maxRounds > 0, so plan-review also dispatches all live platforms
      const mediumOut = resolveFlow(
        { platform: 'claude', level: 'medium', pins: ['all'] },
        LIVE_ALL,
        BASE_CONFIG
      );
      assert.deepEqual(
        mediumOut['plan-review'].targets.map(t => t.platform),
        ['agy', 'copilot', 'opencode', 'claude']
      );
    });

    it('pins "all" reports offline platforms as unavailable rather than dropped named pins', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'medium', pins: ['all'] },
        LIVE_ALL,
        BASE_CONFIG
      );
      assert.deepEqual(out.diagnostics.unavailable, ['copilot']);
      assert.deepEqual(out.diagnostics.droppedPins, {});
    });

    it('pins "all" keeps configured targets when every liveness probe fails', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'medium', pins: ['all'] },
        { claude: false, agy: false, copilot: false, opencode: false },
        BASE_CONFIG
      );
      assert.deepEqual(
        out['plan-review'].targets.map(target => target.platform),
        ['agy', 'copilot', 'opencode', 'claude']
      );
      assert.deepEqual(
        out['code-review'].targets.map(target => target.platform),
        ['agy', 'copilot', 'opencode', 'claude']
      );
    });

    it('pins "all" normalizes case (ALL, All)', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'low', pins: ['ALL'] },
        LIVE_ALL,
        BASE_CONFIG
      );
      assert.deepEqual(
        out['code-review'].targets.map(t => t.platform),
        ['agy', 'copilot', 'opencode', 'claude']
      );
    });

    it('rejects "all" combined with a named platform', () => {
      assert.throws(
        () => resolveFlow(
          { platform: 'claude', level: 'low', pins: ['agy', 'all'] },
          LIVE_ALL,
          BASE_CONFIG
        ),
        /A reviewer count or "all" pin must stand alone/
      );
    });
  });

  describe('count pins', () => {
    it('a count of 2 at a level whose targetCount is 1 gives 2 targets plus reserves, orchestrator last', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium', pins: ['2'] }, LIVE_ALL, BASE_CONFIG);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy', 'copilot']);
      assert.deepEqual(out['code-review'].reserves.map(t => t.platform), ['opencode', 'claude']);
    });

    it('clamps a count above live candidates and records clamped', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium', pins: ['9'] }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['code-review'].targets.length, 4);
      assert.deepEqual(out.diagnostics.clamped['code-review'], { requested: 9, resolved: 4 });
    });

    it('forces a phase whose targetCount is 0 to run when maxRounds > 0', () => {
      const config = withSections({ 'code-review': { targetCount: { medium: 0 }, maxRounds: { medium: 2 } } });
      const out = resolveFlow({ platform: 'claude', level: 'medium', pins: ['2'] }, LIVE_ALL, config);
      assert.equal(out['code-review'].maxRounds, 2);
      assert.equal(out['code-review'].targets.length, 2);
    });

    it('keeps a phase off when maxRounds is 0 — counts never resurrect it', () => {
      const config = withSections({ 'code-review': { maxRounds: { medium: 0 } } });
      const out = resolveFlow({ platform: 'claude', level: 'medium', pins: ['2'] }, LIVE_ALL, config);
      assert.equal(out['code-review'].maxRounds, 0);
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

    it('reports diagnostics.targetCountPin for a count-pinned run', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium', pins: ['3'] }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out.diagnostics.targetCountPin, 3);
    });

    it('reports diagnostics.targetCountPin as null otherwise', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out.diagnostics.targetCountPin, null);
      const pinnedOut = resolveFlow({ platform: 'claude', level: 'medium', pins: ['agy'] }, LIVE_ALL, BASE_CONFIG);
      assert.equal(pinnedOut.diagnostics.targetCountPin, null);
    });

    it('reports diagnostics.targetCountPin as all for an all-pinned run', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium', pins: ['all'] }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out.diagnostics.targetCountPin, 'all');
    });

    it('throws on a count pin of 0', () => {
      assert.throws(
        () => resolveFlow({ platform: 'claude', level: 'medium', pins: ['0'] }, LIVE_ALL, BASE_CONFIG),
        /Reviewer count pin must be an integer from 1 to/
      );
    });

    it('throws when a count pin is mixed with a provider key', () => {
      assert.throws(
        () => resolveFlow({ platform: 'claude', level: 'medium', pins: ['2', 'claude'] }, LIVE_ALL, BASE_CONFIG),
        /A reviewer count or "all" pin must stand alone/
      );
    });

    it('throws when a count pin is mixed with "all"', () => {
      assert.throws(
        () => resolveFlow({ platform: 'claude', level: 'medium', pins: ['all', '2'] }, LIVE_ALL, BASE_CONFIG),
        /A reviewer count or "all" pin must stand alone/
      );
    });

    it('throws on two count pins', () => {
      assert.throws(
        () => resolveFlow({ platform: 'claude', level: 'medium', pins: ['2', '3'] }, LIVE_ALL, BASE_CONFIG),
        /A reviewer count or "all" pin must stand alone/
      );
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

    it('passes a provider-key list through unchanged', () => {
      assert.deepEqual(parsePins(['agy', 'claude']), { keys: ['agy', 'claude'], count: undefined });
    });

    it('passes the "all" keyword through unchanged', () => {
      assert.deepEqual(parsePins(['all']), { keys: ['all'], count: undefined });
    });

    it('throws when a count is below 1', () => {
      assert.throws(() => parsePins(['0']), /Reviewer count pin must be an integer from 1 to/);
      assert.throws(() => parsePins(['-1']), /Reviewer count pin must be an integer from 1 to/);
    });

    it('throws when a count is not a safe integer', () => {
      assert.throws(() => parsePins(['99999999999999999999']), /Reviewer count pin must be an integer from 1 to/);
    });

    it('throws when a count pin is combined with anything else', () => {
      assert.throws(() => parsePins(['2', 'claude']), /A reviewer count or "all" pin must stand alone/);
      assert.throws(() => parsePins(['all', '2']), /A reviewer count or "all" pin must stand alone/);
      assert.throws(() => parsePins(['2', '3']), /A reviewer count or "all" pin must stand alone/);
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
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy', 'opencode', 'claude']);
    });

    it('clamps to the available candidates and records the clamp', () => {
      const config = withSections({ 'code-review': { targetCount: { low: 4 } } });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config);
      assert.equal(out['code-review'].targets.length, 3);
      assert.deepEqual(out.diagnostics.clamped['code-review'], { requested: 4, resolved: 3 });
    });

    it('returns the live candidates beyond targetCount as ordered reserves', () => {
      const config = withSections({ 'code-review': { targetCount: { low: 1 } } });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy']);
      assert.deepEqual(out['code-review'].reserves, [
        {
          candidateId: 'code-review:opencode:0',
          platform: 'opencode',
          model: 'lmstudio/qwen3.8-27b-ridge',
        },
        {
          candidateId: 'code-review:claude:0',
          platform: 'claude',
          model: 'claude-opus-5',
          effort: 'medium',
        },
      ]);
    });

    it('returns no reserves when every candidate is already a target', () => {
      const config = withSections({ 'code-review': { targetCount: { low: 'all' } } });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config);
      assert.deepEqual(out['code-review'].reserves, []);
    });

    it('returns no reserves for a phase that is off', () => {
      const config = withSections({ 'code-review': { maxRounds: { low: 0 } } });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config);
      assert.deepEqual(out['code-review'].reserves, []);
    });

    it('records no clamp when the count is satisfied', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out.diagnostics.clamped['code-review'], undefined);
    });

    it('prioritizes external candidates over orchestrator when targetCount is narrow', () => {
      const config = withSections({
        'code-review': { targetCount: { low: 1 } },
      });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, config);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy']);
    });

    it('fulfills targetCount with orchestrator when external candidates are insufficient', () => {
      // Only agy is live externally; targetCount: 2 pulls in orchestrator claude
      const liveAgyOnly = { claude: true, agy: true, copilot: false, opencode: false };
      const config = withSections({
        'code-review': { targetCount: { low: 2 } },
      });
      const out = resolveFlow({ platform: 'claude', level: 'low' }, liveAgyOnly, config);
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['agy', 'claude']);
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

    it('targetCount=0 does not skip when pins="all" is given — fans out fully', () => {
      const config = withSections({ 'code-review': { targetCount: { low: 0 }, maxRounds: { low: 2 } } });
      const out = resolveFlow(
        { platform: 'claude', level: 'low', pins: ['all'] },
        LIVE_ALL,
        config
      );
      assert.deepEqual(
        out['code-review'].targets.map(t => t.platform),
        ['agy', 'copilot', 'opencode', 'claude']
      );
      assert.equal(out['code-review'].maxRounds, 2);
    });

    it('targetCount=0 still runs a configured named pin whose probe failed', () => {
      const config = withSections({ 'code-review': { targetCount: { low: 0 } } });
      const out = resolveFlow(
        { platform: 'claude', level: 'low', pins: ['copilot'] },
        LIVE_ALL,
        config
      );
      assert.deepEqual(out['code-review'].targets.map(t => t.platform), ['copilot']);
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
      const allDead = { claude: false, agy: false, copilot: false, opencode: false };
      const out = resolveFlow({ platform: 'claude', level: 'low' }, allDead, BASE_CONFIG);
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

    it('keeps an offline named pin and reports its probe result separately', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'medium', pins: ['agy', 'copilot'] },
        LIVE_ALL,
        BASE_CONFIG
      );
      assert.deepEqual(out['code-review'].targets.map(target => target.platform), ['agy', 'copilot']);
      assert.equal(out.diagnostics.droppedPins['code-review'], undefined);
      assert.ok(out.diagnostics.unavailable.includes('copilot'));
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

    it('rejects a missing delegated implementation entry with its resolved key', () => {
      assert.throws(
        () => resolveFlow({ platform: 'opencode', level: 'low' }, LIVE_ALL, BASE_CONFIG),
        /implementation\.platforms\.opencode\.model must resolve an explicit model/,
      );
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

    it('requires a model only for the selected delegated implementation platform', () => {
      const config = withSections({
        implementation: {
          platforms: {
            claude: { effort: 'high' },
            opencode: { model: 'write-model' },
          },
        },
      });
      assert.doesNotThrow(() => resolveFlow({ platform: 'opencode' }, LIVE_ALL, config));
      assert.throws(
        () => resolveFlow({ platform: 'claude' }, LIVE_ALL, config),
        /implementation\.platforms\.claude\.model/,
      );
    });

    it('reports applicable and ignored configured fields', () => {
      const out = resolveFlow(
        { platform: 'claude', implementationFields: 'model' },
        LIVE_ALL,
        BASE_CONFIG,
      );
      assert.deepEqual(out.implementation.applicableFields, ['model']);
      assert.deepEqual(out.implementation.ignoredConfiguredFields, ['effort']);
      assert.equal(out.implementation.model, 'claude-opus-5');
      assert.equal(out.implementation.effort, undefined);
    });

    it('resolves copilot implementation platform with model array and effort', () => {
      const config = withSections({
        implementation: {
          platforms: {
            copilot: {
              model: ['gpt-5.6-luna', 'bedrock.gpt-5.6-luna'],
              effort: 'max',
            },
          },
        },
      });
      const out = resolveFlow(
        { platform: 'copilot', implementationFields: 'model,effort' },
        LIVE_ALL,
        config,
      );
      assert.deepEqual(out.implementation.applicableFields, ['model', 'effort']);
      assert.deepEqual(out.implementation.ignoredConfiguredFields, []);
      assert.deepEqual(out.implementation.model, ['gpt-5.6-luna', 'bedrock.gpt-5.6-luna']);
      assert.equal(out.implementation.effort, 'max');
      assert.deepEqual(out.implementation.escalation, {
        status: 'exhausted',
        reason: 'flat-entry',
      });
    });

    it('requires a model for implementation platforms when missing', () => {
      const config = withSections({
        implementation: {
          platforms: {
            copilot: { effort: 'high' },
            agy: { effort: 'medium' },
          },
        },
      });
      assert.throws(
        () => resolveFlow({ platform: 'copilot' }, LIVE_ALL, config),
        /implementation\.platforms\.copilot\.model must resolve an explicit model/,
      );
      assert.throws(
        () => resolveFlow({ platform: 'agy' }, LIVE_ALL, config),
        /implementation\.platforms\.agy\.model must resolve an explicit model/,
      );
      const shown = resolveFlow(
        { platform: 'copilot', tolerateMissingImplementationModel: true },
        LIVE_ALL,
        config,
      );
      assert.equal(shown.implementation.diagnostic.code, 'IMPLEMENTATION_MODEL_REQUIRED');
      assert.equal(shown.implementation.diagnostic.key, 'implementation.platforms.copilot.model');
    });

    it('resolves agy implementation platform when configured with model and effort', () => {
      const config = withSections({
        implementation: {
          platforms: {
            agy: { model: 'gemini-3.8-flash', effort: 'high' },
          },
        },
      });
      const out = resolveFlow(
        { platform: 'agy', implementationFields: 'model,effort' },
        LIVE_ALL,
        config,
      );
      assert.deepEqual(out.implementation.applicableFields, ['model', 'effort']);
      assert.equal(out.implementation.model, 'gemini-3.8-flash');
      assert.equal(out.implementation.effort, 'high');
      assert.deepEqual(out.implementation.escalation, {
        status: 'exhausted',
        reason: 'flat-entry',
      });
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

      // Single string vs single element array should normalize to same model
      const singleEntry = {
        low: { model: 'same-model' },
        high: { model: ['same-model'] },
      };
      assert.deepEqual(resolveImplementationEscalation(singleEntry, 'low', ['model']), {
        status: 'exhausted',
        reason: 'no-distinct-higher-level',
      });
    });

    it('returns explicit exhaustion for flat and top-level entries', () => {
      assert.deepEqual(
        resolveImplementationEscalation({ model: 'flat' }, 'low', ['model']),
        { status: 'exhausted', reason: 'flat-entry' },
      );
      assert.deepEqual(
        resolveImplementationEscalation({ max: { model: 'top' } }, 'max', ['model']),
        { status: 'exhausted', reason: 'no-distinct-higher-level' },
      );
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
      for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
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
      assert.equal(resolveLevelScalar(knob, 'xhigh'), 3);
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

    // Membership is injected, never read from disk, so these stay hermetic across machines whose
    // git-ignored dispatch config configures a different platform set.
    describe('dispatch platform cross-check', () => {
      const ALL_FOUR = { keys: ['claude', 'agy', 'copilot', 'opencode'], path: '/fake/dispatch/config.jsonc' };

      it('accepts a config whose platforms dispatch also configures', () => {
        assert.deepEqual(validateConfig(BASE_CONFIG, { dispatchPlatforms: ALL_FOUR }), []);
      });

      it('reports every section configuring a platform dispatch lacks', () => {
        const dispatchPlatforms = { keys: ['claude'], path: '/fake/dispatch/config.jsonc' };
        const problems = validateConfig(BASE_CONFIG, { dispatchPlatforms });
        // Only review sections dispatch through the external provider cascade; implementation
        // platforms select native write subagents and may not be in dispatch's config.
        assert.equal(problems.length, 6);
        for (const section of ['plan-review', 'code-review']) {
          assert.ok(
            problems.some(p => p.startsWith(`${section}.platforms."agy"`)),
            `expected an agy problem for ${section}`
          );
        }
        assert.ok(!problems.some(p => p.startsWith('implementation.platforms.')));
        assert.match(problems[0], /not configured in \/fake\/dispatch\/config\.jsonc \(configured there: claude\)/);
        assert.match(problems[0], /exits PLATFORM_NOT_CONFIGURED/);
      });

      it('allows an implementation-only Copilot platform when dispatch config has only Claude', () => {
        const config = withSections({
          'plan-review': { platforms: { claude: {} } },
          implementation: { platforms: { copilot: {} } },
          'code-review': { platforms: { claude: {} } },
        });
        assert.deepEqual(
          validateConfig(config, { dispatchPlatforms: { keys: ['claude'], path: '/fake/dispatch/config.jsonc' } }),
          [],
        );
      });

      it('resolves aliases before comparing, so `antigravity` here matches `agy` there', () => {
        const config = withSections({
          'plan-review': { platforms: { claude: {}, antigravity: {} } },
          implementation: { platforms: { claude: {} } },
          'code-review': { platforms: { claude: {} } },
        });
        assert.deepEqual(
          validateConfig(config, { dispatchPlatforms: { keys: ['claude', 'agy'], path: null } }),
          []
        );
      });

      it('skips the cross-check when dispatch membership is unreadable', () => {
        assert.deepEqual(validateConfig(BASE_CONFIG, { dispatchPlatforms: { keys: null, path: null } }), []);
        assert.deepEqual(validateConfig(BASE_CONFIG, { dispatchPlatforms: null }), []);
      });

      it('falls back to a generic location when dispatch config path is unknown', () => {
        const problems = validateConfig(BASE_CONFIG, { dispatchPlatforms: { keys: ['claude'], path: null } });
        assert.match(problems[0], /is not configured in dispatch's config/);
      });

      it('reports shape problems without cross-checking an unusable platforms map', () => {
        const config = withSections({ 'plan-review': { platforms: 'nope' } });
        const problems = validateConfig(config, { dispatchPlatforms: { keys: ['claude'], path: null } });
        assert.ok(problems.some(p => /plan-review\.platforms/.test(p) && !/PLATFORM_NOT_CONFIGURED/.test(p)));
        assert.ok(!problems.some(p => p.startsWith('plan-review.platforms."')));
      });
    });

    describe('loadDispatchPlatformKeys', () => {
      it('reads the sibling dispatch config into canonical keys', () => {
        const { keys, path: configPath } = loadDispatchPlatformKeys(DISPATCH_SCRIPTS);
        assert.ok(Array.isArray(keys) && keys.length > 0);
        for (const key of keys) assert.ok(KNOWN_PROVIDERS.includes(key), `unknown key "${key}"`);
        assert.match(configPath, /config(\.local|\.default)?\.jsonc$/);
      });

      it('degrades to keys: null when dispatch is not installed alongside', () => {
        const result = loadDispatchPlatformKeys(path.join(os.tmpdir(), 'no-such-dispatch', 'scripts'));
        assert.equal(result.keys, null);
        assert.equal(result.path, null);
        assert.match(result.error, /Config file not found/);
      });

      it('degrades to keys: null when the dispatch config contains an unsupported alias', () => {
        const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-config-'));
        const scripts = path.join(fixtureRoot, 'scripts');
        const configPath = path.join(fixtureRoot, 'config.jsonc');
        fs.mkdirSync(scripts);
        fs.writeFileSync(configPath, JSON.stringify({ platforms: { antigravity: {} } }));
        try {
          const result = loadDispatchPlatformKeys(scripts);
          assert.equal(result.keys, null);
          assert.equal(result.path, configPath);
          assert.ok(result.problems?.some((problem) => /unrecognized key "antigravity"/.test(problem)));
        } finally {
          fs.rmSync(fixtureRoot, { recursive: true, force: true });
        }
      });
    });

    it('rejects an unknown platform key (e.g. local)', () => {
      const config = withSections({
        'plan-review': { platforms: { ...PLAN_PLATFORMS, local: {}, cladue: {} } },
      });
      const problems = validateConfig(config).join('\n');
      assert.match(problems, /unknown platform "local" \(expected claude, agy, copilot, opencode\)/);
      assert.match(problems, /unknown platform "cladue"/);
    });

    it('accepts an alias platform key that normalizes to a canonical provider', () => {
      const config = withSections({
        'plan-review': { platforms: { claudecode: { model: 'claude-opus-5' }, agy: {} } },
      });
      assert.deepEqual(validateConfig(config), []);
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

    it('accepts array models in implementation and review sections and rejects invalid entries', () => {
      const valid = withSections({
        implementation: {
          platforms: {
            copilot: { model: ['gpt-5.6-luna', 'bedrock.gpt-5.6-luna'], effort: 'max' },
          },
        },
        'code-review': {
          platforms: {
            copilot: { model: ['gpt-5.6-luna', 'bedrock.gpt-5.6-luna'] },
          },
        },
      });
      assert.deepEqual(validateConfig(valid), []);

      const emptyArray = withSections({
        implementation: { platforms: { copilot: { model: [] } } },
      });
      assert.match(validateConfig(emptyArray)[0], /implementation\.platforms\.copilot\.model must be a string or array of strings/);

      const nonStringArray = withSections({
        implementation: { platforms: { copilot: { model: [5] } } },
      });
      assert.match(validateConfig(nonStringArray)[0], /implementation\.platforms\.copilot\.model must be a string or array of strings/);

      const emptyStringArray = withSections({
        implementation: { platforms: { copilot: { model: [''] } } },
      });
      assert.match(validateConfig(emptyStringArray)[0], /implementation\.platforms\.copilot\.model must be a string or array of strings/);

      const colonSuffixedArray = withSections({
        implementation: { platforms: { copilot: { model: ['claude:'] } } },
      });
      assert.match(validateConfig(colonSuffixedArray)[0], /implementation\.platforms\.copilot\.model must be a string or array of strings/);
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
      assert.match(problems[0], /low, medium, high, xhigh, max/);
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

    it('names config.sample.jsonc as the file to diff against', () => {
      assert.match(validateConfig({})[0], /config\.sample\.jsonc/);
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

    it('rejects a platform named "all" as a reserved keyword', () => {
      const config = withSections({
        'code-review': { platforms: { all: { model: 'm' } } },
      });
      const problems = validateConfig(config);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /reserved pin keyword "all"/);
    });

    it('requires all review knobs (maxRounds, targetCount, consensus)', () => {
      const section = { ...BASE_CONFIG['code-review'] };
      delete section.maxRounds;
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
        implementation: {
          platforms: {
            ...BASE_CONFIG.implementation.platforms,
            opencode: { model: 'opencode-write-model' },
          },
        },
        'code-review': {
          maxRounds: { low: -1 },
          targetCount: { low: 'two' },
          consensus: { low: 'yes' },
        },
      });
      const problems = validateConfig(config);
      assert.equal(problems.length, 3);
      assert.match(problems.join('\n'), /maxRounds\.low must be a non-negative integer/);
      assert.match(problems.join('\n'), /targetCount\.low must be a non-negative integer or "all"/);
      assert.match(problems.join('\n'), /consensus\.low must be a boolean/);
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

    it('rejects a null config root', () => {
      const problems = validateConfig(null);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /Config must be a JSON object/);
    });

    it('rejects an array config root', () => {
      const problems = validateConfig([]);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /Config must be a JSON object/);
    });

    it('rejects a string config root', () => {
      const problems = validateConfig('not-a-config');
      assert.equal(problems.length, 1);
      assert.match(problems[0], /Config must be a JSON object/);
    });

    it('rejects a non-object section value', () => {
      const config = { ...BASE_CONFIG, 'code-review': 'nope' };
      const problems = validateConfig(config);
      assert.match(problems.join('\n'), /Section "code-review" must be an object/);
    });

    it('rejects a non-object platforms map', () => {
      const config = withSections({ 'code-review': { platforms: 'claude' } });
      const problems = validateConfig(config);
      assert.match(
        problems.join('\n'),
        /code-review\.platforms must be an object mapping platform key to model\/effort settings/
      );
    });

    it('rejects a knob that is not keyed by level', () => {
      const config = withSections({ 'code-review': { maxRounds: 3 } });
      const problems = validateConfig(config);
      assert.match(problems.join('\n'), /code-review\.maxRounds must be an object keyed by level/);
    });

    it('rejects a non-object platforms entry', () => {
      const config = withSections({ 'code-review': { platforms: { agy: 'not-an-object' } } });
      const problems = validateConfig(config);
      assert.match(problems.join('\n'), /code-review\.platforms\.agy must be an object/);
    });

    it('rejects a non-string flat effort', () => {
      const config = withSections({ 'code-review': { platforms: { agy: { effort: 7 } } } });
      const problems = validateConfig(config);
      assert.match(problems.join('\n'), /code-review\.platforms\.agy\.effort must be a string/);
    });
  });

  describe('platform alias normalization', () => {
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

  describe('resolveFlow — unknown platform', () => {
    it('throws for an unrecognized platform, naming the valid keys', () => {
      assert.throws(
        () => resolveFlow({ platform: 'bogus', level: 'low' }, LIVE_ALL, BASE_CONFIG),
        /Unknown platform "bogus"\. Valid platforms: .*claude/
      );
    });

    it('accepts a documented alias that normalizes to a known provider', () => {
      const out = resolveFlow({ platform: 'claudecode', level: 'low' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out.implementation.platform, 'claude');
    });
  });

  describe('resolveFlow — livenessSource diagnostic', () => {
    it('defaults to "probe" when the caller passes no source', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out.diagnostics.livenessSource, 'probe');
    });

    it('reports the source the caller supplies', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'low', livenessSource: 'env-override' },
        LIVE_ALL,
        BASE_CONFIG
      );
      assert.equal(out.diagnostics.livenessSource, 'env-override');
    });
  });

  describe('resolveFlow — unknown level', () => {
    it('throws for an unrecognized level like "ultra"', () => {
      assert.throws(
        () => resolveFlow({ platform: 'claude', level: 'ultra' }, LIVE_ALL, BASE_CONFIG),
        /Unknown level "ultra"/
      );
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
      for (const level of ['low', 'medium', 'high', 'xhigh']) {
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
      for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
        const out = resolveFlow({ platform: 'claude', level }, LIVE_ALL, BASE_CONFIG);
        assert.equal(typeof out['code-review'].maxRounds, 'number', `code-review maxRounds at ${level}`);
        assert.equal(typeof out['plan-review'].maxRounds, 'number', `plan-review maxRounds at ${level}`);
      }
    });

    it('leaves maxRounds independent of how many targets a wave dispatches', () => {
      const out = resolveFlow({ platform: 'claude', level: 'high' }, LIVE_ALL, BASE_CONFIG);
      // 3 live targets, but the budget stays at 3 waves
      assert.equal(out['code-review'].targets.length, 3);
      assert.equal(out['code-review'].maxRounds, 3);
    });

    it('counts plan-review and code-review caps separately', () => {
      const out = resolveFlow({ platform: 'claude', level: 'medium' }, LIVE_ALL, BASE_CONFIG);
      assert.equal(out['plan-review'].maxRounds, 1);
      assert.equal(out['code-review'].maxRounds, 3);
    });
  });

  describe('orchestrator fulfillment & liveness', () => {
    it('fulfills targetCount with orchestrator when no external platforms are live', () => {
      const out = resolveFlow({ platform: 'claude', level: 'low' }, LIVE_NONE_EXTERNAL, BASE_CONFIG);
      assert.equal(out['code-review'].targets.length, 1);
      assert.equal(out['code-review'].targets[0].platform, 'claude');
    });

    it('returns empty targets (not an error) when all platforms are dead', () => {
      const allDead = { claude: false, agy: false, copilot: false, opencode: false };
      const out = resolveFlow({ platform: 'claude', level: 'low' }, allDead, BASE_CONFIG);
      assert.deepEqual(out['code-review'].targets, []);
    });
  });

  describe('multi-candidate platform arrays', () => {
    it('supports array of candidate objects on a platform', () => {
      const config = withSections({
        'code-review': {
          targetCount: { low: 2 },
          platforms: {
            opencode: [
              { model: 'glm-5.3-flash', effort: 'high' },
              { model: 'lmstudio/qwen3.8-27b-ridge' },
            ],
            claude: { model: 'claude-opus-5' },
          },
        },
      });
      const live = { claude: true, agy: false, copilot: false, opencode: true };
      const out = resolveFlow({ platform: 'claude', level: 'low' }, live, config);
      assert.equal(out['code-review'].targets.length, 2);
      assert.deepEqual(out['code-review'].targets, [
        {
          candidateId: 'code-review:opencode:0',
          platform: 'opencode',
          model: 'glm-5.3-flash',
          effort: 'high',
        },
        {
          candidateId: 'code-review:opencode:1',
          platform: 'opencode',
          model: 'lmstudio/qwen3.8-27b-ridge',
        },
      ]);
    });

    it('supports level-keyed candidate array inside a platform entry', () => {
      const config = withSections({
        'code-review': {
          targetCount: { low: 1, high: 2 },
          platforms: {
            opencode: {
              low: { model: 'lmstudio/qwen3.8-27b-ridge' },
              high: [
                { model: 'glm-5.3-flash' },
                { model: 'lmstudio/qwen3.8-27b-ridge' },
              ],
            },
          },
        },
      });
      const live = { claude: false, agy: false, copilot: false, opencode: true };
      const lowOut = resolveFlow({ platform: 'claude', level: 'low' }, live, config);
      assert.equal(lowOut['code-review'].targets.length, 1);
      assert.equal(lowOut['code-review'].targets[0].model, 'lmstudio/qwen3.8-27b-ridge');

      const highOut = resolveFlow({ platform: 'claude', level: 'high' }, live, config);
      assert.equal(highOut['code-review'].targets.length, 2);
      assert.deepEqual(highOut['code-review'].targets.map(t => t.model), [
        'glm-5.3-flash',
        'lmstudio/qwen3.8-27b-ridge',
      ]);
    });

    it('pins dispatch all candidates configured for the pinned platform', () => {
      const config = withSections({
        'code-review': {
          platforms: {
            opencode: [
              { model: 'glm-5.3-flash' },
              { model: 'lmstudio/qwen3.8-27b-ridge' },
            ],
            claude: { model: 'claude-opus-5' },
          },
        },
      });
      const live = { claude: true, agy: false, copilot: false, opencode: true };
      const out = resolveFlow({ platform: 'claude', level: 'low', pins: ['opencode'] }, live, config);
      assert.equal(out['code-review'].targets.length, 2);
      assert.equal(out['code-review'].targets[0].model, 'glm-5.3-flash');
      assert.equal(out['code-review'].targets[1].model, 'lmstudio/qwen3.8-27b-ridge');
    });

    it('rejects an empty candidates array in validation', () => {
      const config = withSections({
        'code-review': {
          platforms: {
            opencode: [],
          },
        },
      });
      const problems = validateConfig(config);
      assert.match(problems.join('\n'), /code-review\.platforms\.opencode must define at least one candidate/);
    });

    it('rejects candidate arrays in implementation section', () => {
      const config = withSections({
        implementation: {
          platforms: {
            claude: [{ model: 'claude-opus-5' }],
          },
        },
      });
      const problems = validateConfig(config);
      assert.match(problems.join('\n'), /implementation\.platforms\.claude must be an object/);
    });

    it('rejects candidate array level overrides in implementation section', () => {
      const config = withSections({
        implementation: {
          platforms: {
            claude: {
              high: [{ model: 'claude-opus-5' }],
            },
          },
        },
      });
      const problems = validateConfig(config);
      assert.match(problems.join('\n'), /implementation\.platforms\.claude\.high must be an object with model\/effort/);
    });
  });
});

describe('resolveFlow — configured-order candidates', () => {
  const ALL_UP = { claude: true, agy: true, copilot: true, opencode: true };
  const OPENCODE_MULTI = [
    { model: 'glm-5.3-flash' },
    { model: 'mistral-small' },
    { model: 'qwen3.8-27b' },
  ];
  const label = (t) => (t.platform === 'opencode' ? t.model : t.platform);
  const multi = (agy = { model: 'gemini-3.8-flash' }) =>
    withSections({
      implementation: {
        platforms: {
          ...BASE_CONFIG.implementation.platforms,
          opencode: { model: 'opencode-write-model' },
        },
      },
      'code-review': {
        targetCount: { low: 3 },
        platforms: {
          claude: { model: 'claude-opus-5' },
          agy,
          copilot: { model: 'gpt-5.6-luna' },
          opencode: OPENCODE_MULTI,
        },
      },
    });

  it('yields agy, copilot, glm as targets and mistral, qwen, claude as reserves', () => {
    const out = resolveFlow({ platform: 'claude', level: 'high' }, ALL_UP, multi());
    assert.deepEqual(out['code-review'].targets.map(label), ['agy', 'copilot', 'glm-5.3-flash']);
    assert.deepEqual(out['code-review'].reserves.map(label), ['mistral-small', 'qwen3.8-27b', 'claude']);
  });

  it('diversity-sorts repeated external candidates for an unpinned target count', () => {
    const config = multi([{ model: 'a1' }, { model: 'a2' }]);
    const out = resolveFlow({ platform: 'claude', level: 'high' }, ALL_UP, config);
    const all = [...out['code-review'].targets, ...out['code-review'].reserves];
    assert.deepEqual(all.map((t) => t.model), ['a1', 'gpt-5.6-luna', 'glm-5.3-flash', 'a2', 'mistral-small', 'qwen3.8-27b', 'claude-opus-5']);
  });

  it('preserves repeated external candidates in configured order for an all pin', () => {
    const config = multi([{ model: 'a1' }, { model: 'a2' }]);
    const out = resolveFlow(
      { platform: 'claude', level: 'high', pins: ['all'] },
      ALL_UP,
      config
    );
    assert.deepEqual(
      out['code-review'].targets.map((target) => target.model),
      ['a1', 'a2', 'gpt-5.6-luna', 'glm-5.3-flash', 'mistral-small', 'qwen3.8-27b', 'claude-opus-5']
    );
  });

  it('preserves unpinned diversity when a programmatic caller omits the orchestrator', () => {
    const config = multi([{ model: 'a1' }, { model: 'a2' }]);
    const out = resolveFlow({ level: 'high' }, ALL_UP, config);
    const all = [...out['code-review'].targets, ...out['code-review'].reserves];
    assert.deepEqual(
      all.map((target) => target.model),
      ['claude-opus-5', 'a1', 'gpt-5.6-luna', 'glm-5.3-flash', 'a2', 'mistral-small', 'qwen3.8-27b']
    );
  });

  it('preserves orchestrator candidate order after every external', () => {
    const config = withSections({
      implementation: {
        platforms: {
          ...BASE_CONFIG.implementation.platforms,
          opencode: { model: 'opencode-write-model' },
        },
      },
      'code-review': {
        targetCount: { low: 'all' },
        platforms: { opencode: OPENCODE_MULTI.slice(0, 2), agy: { model: 'g' } },
      },
    });
    const out = resolveFlow({ platform: 'opencode', level: 'low' }, ALL_UP, config);
    assert.deepEqual(out['code-review'].targets.map(label), ['agy', 'glm-5.3-flash', 'mistral-small']);
  });

  it('demotes same platform + model match to dead last behind alternative models on orchestrator platform', () => {
    const config = withSections({
      'code-review': {
        targetCount: { low: 'all' },
        platforms: {
          claude: [
            { model: 'claude-opus-5' },
            { model: 'claude-sonnet-5' },
          ],
          agy: { model: 'gemini-3.8-flash' },
        },
      },
    });
    const out = resolveFlow(
      { platform: 'claude', orchestratorModel: 'claude-opus-5', pins: ['all'], level: 'low' },
      ALL_UP,
      config
    );
    assert.deepEqual(
      out['code-review'].targets.map((t) => `${t.platform}:${t.model}`),
      ['agy:gemini-3.8-flash', 'claude:claude-sonnet-5', 'claude:claude-opus-5']
    );
  });

  it('demotes same platform + model match regardless of reasoning effort in resolveFlow', () => {
    const config = withSections({
      'code-review': {
        targetCount: { low: 'all' },
        platforms: {
          claude: [
            { model: 'claude-opus-5', effort: 'low' },
            { model: 'claude-sonnet-5', effort: 'max' },
          ],
          agy: { model: 'gemini-3.8-flash' },
        },
      },
    });
    const out = resolveFlow({ platform: 'claude', orchestratorModel: 'claude-opus-5', level: 'low' }, ALL_UP, config);
    assert.deepEqual(
      out['code-review'].targets.map((t) => `${t.platform}:${t.model}`),
      ['agy:gemini-3.8-flash', 'claude:claude-sonnet-5', 'claude:claude-opus-5']
    );
  });

  it('preserves baseline order when orchestratorModel is null in resolveFlow', () => {
    const config = withSections({
      'code-review': {
        targetCount: { low: 'all' },
        platforms: {
          claude: [
            { model: 'claude-opus-5' },
            { model: 'claude-sonnet-5' },
          ],
          agy: { model: 'gemini-3.8-flash' },
        },
      },
    });
    const out = resolveFlow({ platform: 'claude', orchestratorModel: null, level: 'low' }, ALL_UP, config);
    assert.deepEqual(
      out['code-review'].targets.map((t) => `${t.platform}:${t.model}`),
      ['agy:gemini-3.8-flash', 'claude:claude-opus-5', 'claude:claude-sonnet-5']
    );
  });

  it('pinned runs in resolveFlow bypass orchestrator model demotion', () => {
    const config = withSections({
      'code-review': {
        platforms: {
          claude: [
            { model: 'claude-opus-5' },
            { model: 'claude-sonnet-5' },
          ],
        },
      },
    });
    const out = resolveFlow({ platform: 'claude', orchestratorModel: 'claude-opus-5', pins: ['claude'], level: 'low' }, ALL_UP, config);
    assert.deepEqual(
      out['code-review'].targets.map((t) => `${t.platform}:${t.model}`),
      ['claude:claude-opus-5', 'claude:claude-sonnet-5']
    );
  });

  describe('exclude', () => {
    it('keeps configured candidate IDs stable across exclusion re-resolution', () => {
      const before = resolveFlow({ platform: 'claude', level: 'high' }, ALL_UP, multi());
      const after = resolveFlow(
        { platform: 'claude', level: 'high', exclude: ['copilot'] },
        ALL_UP,
        multi(),
      );
      const beforeIds = new Map(
        [...before['code-review'].targets, ...before['code-review'].reserves]
          .map((target) => [`${target.platform}:${target.model ?? ''}`, target.candidateId]),
      );
      for (const target of [...after['code-review'].targets, ...after['code-review'].reserves]) {
        assert.equal(
          target.candidateId,
          beforeIds.get(`${target.platform}:${target.model ?? ''}`),
        );
      }
      assert.equal(beforeIds.get('opencode:glm-5.3-flash'), 'code-review:opencode:0');
      assert.equal(beforeIds.get('opencode:mistral-small'), 'code-review:opencode:1');
    });

    it('removes excluded platforms from candidates and reports them only in diagnostics.excluded', () => {
      const out = resolveFlow({ platform: 'claude', level: 'high', exclude: ['copilot'] }, ALL_UP, multi());
      assert.deepEqual(out['code-review'].targets.map(label), ['agy', 'glm-5.3-flash', 'mistral-small']);
      assert.ok(out['code-review'].reserves.every((t) => t.platform !== 'copilot'));
      assert.deepEqual(out.diagnostics.excluded, ['copilot']);
      assert.ok(!out.diagnostics.unavailable.includes('copilot'));
    });

    it('still reports a genuinely dead platform as unavailable alongside an exclusion', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'high', exclude: ['copilot'] },
        { ...ALL_UP, opencode: false },
        multi()
      );
      assert.deepEqual(out.diagnostics.unavailable, ['opencode']);
      assert.deepEqual(out.diagnostics.excluded, ['copilot']);
    });

    it('normalizes aliases, dedupes, and sorts diagnostics.excluded', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'high', exclude: ['copilot', 'antigravity', 'agy'] },
        ALL_UP,
        multi()
      );
      assert.deepEqual(out.diagnostics.excluded, ['agy', 'copilot']);
    });

    it('defaults diagnostics.excluded to []', () => {
      const out = resolveFlow({ platform: 'claude', level: 'high' }, ALL_UP, multi());
      assert.deepEqual(out.diagnostics.excluded, []);
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

    it('drops an excluded pin silently, without reporting it in droppedPins', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'high', pins: ['agy', 'copilot'], exclude: ['copilot'] },
        ALL_UP,
        multi()
      );
      assert.deepEqual(out['code-review'].targets.map(label), ['agy']);
      assert.equal(out.diagnostics.droppedPins['code-review'], undefined);
    });

    it('skips excluded keys when expanding pins "all"', () => {
      const out = resolveFlow(
        { platform: 'claude', level: 'high', pins: ['all'], exclude: ['copilot'] },
        ALL_UP,
        multi()
      );
      assert.ok(out['code-review'].targets.every((t) => t.platform !== 'copilot'));
      assert.equal(out.diagnostics.droppedPins['code-review'], undefined);
    });

    it('throws when every pin is excluded', () => {
      assert.throws(
        () => resolveFlow({ platform: 'claude', level: 'high', pins: ['copilot'], exclude: ['copilot'] }, ALL_UP, multi()),
        /All pinned platforms excluded/
      );
    });
  });
});

describe('resolvePlatformCandidates', () => {
  it('returns single candidate from flat object', () => {
    const entry = { model: 'claude-opus-5', effort: 'medium' };
    const candidates = resolvePlatformCandidates(entry, 'high');
    assert.deepEqual(candidates, [{ model: 'claude-opus-5', effort: 'medium' }]);
  });

  it('inherits top-level defaults into flat candidate array', () => {
    const entry = [
      { model: 'glm-5.3-flash' },
      { model: 'qwen3.8-27b', effort: 'low' },
    ];
    const candidates = resolvePlatformCandidates(entry, 'high');
    assert.deepEqual(candidates, [
      { model: 'glm-5.3-flash' },
      { model: 'qwen3.8-27b', effort: 'low' },
    ]);
  });

  it('resolves level-keyed candidate array inside object', () => {
    const entry = {
      model: 'default-model',
      effort: 'medium',
      high: [
        { model: 'model-a' },
        { model: 'model-b', effort: 'max' },
      ],
    };
    const candidates = resolvePlatformCandidates(entry, 'high');
    assert.deepEqual(candidates, [
      { model: 'model-a', effort: 'medium' },
      { model: 'model-b', effort: 'max' },
    ]);
  });

  it('falls back to flat defaults when requested level has no override', () => {
    const entry = {
      model: 'default-model',
      effort: 'low',
      high: [{ model: 'model-high' }],
    };
    const candidates = resolvePlatformCandidates(entry, 'min');
    // 'min' rounds up to 'high' because no levels below min exist
    assert.deepEqual(candidates, [{ model: 'model-high', effort: 'low' }]);
  });

  it('returns empty array for missing or non-object entry', () => {
    assert.deepEqual(resolvePlatformCandidates(null, 'high'), []);
    assert.deepEqual(resolvePlatformCandidates('string', 'high'), []);
    assert.deepEqual(resolvePlatformCandidates({}, 'high'), [{}]);
  });
});

describe('selectLevel', () => {
  it('picks the highest defined level at or below the requested one', () => {
    assert.equal(selectLevel(['low', 'high'], 'max'), 'high');
    assert.equal(selectLevel(['low', 'high'], 'medium'), 'low');
  });

  it('falls forward to the lowest defined level above the requested one', () => {
    // A config defining only `high` still has to answer a `low` request with something.
    assert.equal(selectLevel(['high', 'max'], 'low'), 'high');
  });

  it('sorts unordered level lists rather than trusting key order', () => {
    // Object key order is whatever the JSONC author typed; the ladder is LEVELS, not insertion.
    assert.equal(selectLevel(['max', 'low', 'high'], 'high'), 'high');
    assert.equal(selectLevel(['xhigh', 'low'], 'max'), 'xhigh');
  });

  it('returns undefined for an empty level list', () => {
    assert.equal(selectLevel([], 'medium'), undefined);
  });
});

describe('normalizePin', () => {
  it('canonicalizes provider aliases case-insensitively', () => {
    assert.equal(normalizePin('claudecode'), 'claude');
    assert.equal(normalizePin('ANTIGRAVITY'), 'agy');
  });

  it('passes an already-canonical key through', () => {
    assert.equal(normalizePin('agy'), 'agy');
  });

  it('preserves the reserved "all" keyword', () => {
    assert.equal(normalizePin('all'), 'all');
    assert.equal(normalizePin('ALL'), 'all');
  });

  it('passes an unknown key through unchanged, for the caller to reject by name', () => {
    // Lowercasing it here would make the error message disagree with what the user typed.
    assert.equal(normalizePin('Bogus'), 'Bogus');
  });
});

describe('probeCandidates', () => {
  const config = {
    'plan-review': { platforms: { agy: {}, copilot: {} } },
    implementation: { platforms: { claude: {} } },
    'code-review': { platforms: { agy: {} } },
  };

  it('returns every configured platform plus the orchestrator when unpinned', () => {
    const keys = probeCandidates({ platform: 'claude' }, config).sort();
    assert.deepEqual(keys, ['agy', 'claude', 'copilot']);
  });

  it('narrows to the pinned platforms, keeping the orchestrator', () => {
    const keys = probeCandidates({ platform: 'claude', pins: ['agy'] }, config).sort();
    assert.deepEqual(keys, ['agy', 'claude']);
  });

  it('treats the "all" pin as unpinned breadth', () => {
    const keys = probeCandidates({ platform: 'claude', pins: ['all'] }, config).sort();
    assert.deepEqual(keys, ['agy', 'claude', 'copilot']);
  });

  it('does not throw with pins and no platform', () => {
    assert.deepEqual(probeCandidates({ pins: ['agy'] }, config), ['agy']);
  });

  it('skips excluded platforms', () => {
    const keys = probeCandidates({ platform: 'claude', exclude: ['copilot'] }, config).sort();
    assert.deepEqual(keys, ['agy', 'claude']);
  });

  it('treats a count pin as unpinned breadth', () => {
    const keys = probeCandidates({ platform: 'claude', pins: ['3'] }, config).sort();
    assert.deepEqual(keys, ['agy', 'claude', 'copilot']);
  });
});

describe('RUNNER_FILES availability exports', () => {
  // Pins `defaultLiveness`'s `is<Key>Available` name derivation without spawning a provider CLI:
  // the modules are imported only, never called, so the test stays hermetic.
  for (const [key, file] of Object.entries(RUNNER_FILES)) {
    it(`${file} exports is${key.charAt(0).toUpperCase()}${key.slice(1)}Available`, async () => {
      const mod = await import(pathToFileURL(path.join(DISPATCH_SCRIPTS, file)).href);
      const fnName = `is${key.charAt(0).toUpperCase()}${key.slice(1)}Available`;
      assert.equal(typeof mod[fnName], 'function', `${file} must export ${fnName}`);
    });
  }
});
