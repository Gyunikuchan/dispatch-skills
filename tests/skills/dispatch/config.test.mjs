import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';

import {
  getConfigCandidates,
  loadSkillConfig,
  validateDispatchConfig,
  KNOWN_PROVIDERS,
} from '../../../skills/dispatch/scripts/common.mjs';

describe('getConfigCandidates', () => {
  it('returns the 3-path precedence list in order', () => {
    const candidates = getConfigCandidates({
      skillRoot: '/skill',
    });
    assert.deepEqual(
      candidates.map((p) => p.split(path.sep).join('/')),
      [
        '/skill/config.local.jsonc',
        '/skill/config.jsonc',
        '/skill/config.default.jsonc',
      ],
    );
  });
});

describe('loadSkillConfig', () => {
  let skillRoot;

  beforeEach(() => {
    skillRoot = mkdtempSync(path.join(os.tmpdir(), 'load-skill-config-skill-'));
  });

  afterEach(() => {
    rmSync(skillRoot, { recursive: true, force: true });
  });

  it('throws listing every tried path when none exist', () => {
    assert.throws(
      () => loadSkillConfig({ skillRoot }),
      /Config file not found: tried .*config\.local\.jsonc.*config\.default\.jsonc/s,
    );
  });

  it('loads config.default.jsonc when nothing else exists', () => {
    writeFileSync(path.join(skillRoot, 'config.default.jsonc'), '{ "platforms": { "claude": {} } }');
    const { config, path: usedPath } = loadSkillConfig({ skillRoot });
    assert.deepEqual(config, { platforms: { claude: {} } });
    assert.equal(usedPath, path.join(skillRoot, 'config.default.jsonc'));
  });

  it('loads wholly (no merge): a higher-precedence file replaces, not merges with, the default', () => {
    writeFileSync(path.join(skillRoot, 'config.default.jsonc'), '{ "platforms": { "claude": {}, "agy": {} } }');
    writeFileSync(path.join(skillRoot, 'config.jsonc'), '{ "platforms": { "copilot": {} } }');
    const { config } = loadSkillConfig({ skillRoot });
    assert.deepEqual(config, { platforms: { copilot: {} } });
  });

  it('prefers config.local.jsonc over config.jsonc and default', () => {
    writeFileSync(path.join(skillRoot, 'config.default.jsonc'), '{ "platforms": { "claude": {} } }');
    writeFileSync(path.join(skillRoot, 'config.jsonc'), '{ "platforms": { "copilot": {} } }');
    writeFileSync(path.join(skillRoot, 'config.local.jsonc'), '{ "platforms": { "agy": {} } }');

    const { config, path: usedPath } = loadSkillConfig({ skillRoot });
    assert.deepEqual(config, { platforms: { agy: {} } });
    assert.equal(usedPath, path.join(skillRoot, 'config.local.jsonc'));
  });

  it('defaultOnly loads config.default.jsonc even when overrides exist', () => {
    writeFileSync(path.join(skillRoot, 'config.default.jsonc'), '{ "platforms": { "claude": {} } }');
    writeFileSync(path.join(skillRoot, 'config.local.jsonc'), '{ "platforms": { "agy": {} } }');
    const { config } = loadSkillConfig({ skillRoot, defaultOnly: true });
    assert.deepEqual(config, { platforms: { claude: {} } });
  });

  it('defaultOnly throws when config.default.jsonc is missing', () => {
    assert.throws(
      () => loadSkillConfig({ skillRoot, defaultOnly: true }),
      /Config file not found: tried/,
    );
  });
});

describe('validateDispatchConfig', () => {
  it('accepts a well-formed config', () => {
    assert.deepEqual(
      validateDispatchConfig({
        platforms: { claude: { model: ['a', 'b'], effort: 'medium' }, agy: { model: 'x' }, opencode: {} },
      }),
      [],
    );
  });

  it('rejects a non-object config', () => {
    assert.equal(validateDispatchConfig(null).length, 1);
    assert.equal(validateDispatchConfig('x').length, 1);
  });

  it('rejects an unrecognized top-level key', () => {
    const problems = validateDispatchConfig({ platforms: { claude: {} }, extra: 1 });
    assert.match(problems.join('\n'), /Unrecognized top-level key "extra"/);
  });

  it('rejects an empty platforms map', () => {
    const problems = validateDispatchConfig({ platforms: {} });
    assert.match(problems.join('\n'), /at least one platform/);
  });

  it('rejects an unknown platform key', () => {
    const problems = validateDispatchConfig({ platforms: { bogus: {} } });
    assert.match(problems.join('\n'), new RegExp(`Valid keys: ${KNOWN_PROVIDERS.join(', ')}`));
  });

  it('rejects a non-string, non-array model', () => {
    const problems = validateDispatchConfig({ platforms: { agy: { model: 5 } } });
    assert.match(problems.join('\n'), /platforms\.agy\.model must be a string/);
  });

  it('rejects a model array on any platform other than claude', () => {
    const problems = validateDispatchConfig({ platforms: { agy: { model: ['a', 'b'] } } });
    assert.match(problems.join('\n'), /may only be an array for "claude"/);
  });

  it('accepts a model array for claude', () => {
    assert.deepEqual(validateDispatchConfig({ platforms: { claude: { model: ['a', 'b'] } } }), []);
  });

  it('rejects an empty model array for claude', () => {
    const problems = validateDispatchConfig({ platforms: { claude: { model: [] } } });
    assert.match(problems.join('\n'), /non-empty array of strings/);
  });

  it('rejects a non-string effort', () => {
    const problems = validateDispatchConfig({ platforms: { claude: { effort: 1 } } });
    assert.match(problems.join('\n'), /platforms\.claude\.effort must be a string/);
  });

  it('rejects an unrecognized key inside a platform entry', () => {
    const problems = validateDispatchConfig({ platforms: { claude: { timeout: 10 } } });
    assert.match(problems.join('\n'), /unrecognized key "timeout"/);
  });

  it('reports every problem in one pass', () => {
    const problems = validateDispatchConfig({
      extra: 1,
      platforms: { claude: { model: 5 }, bogus: {} },
    });
    assert.ok(problems.length >= 3, `expected multiple problems, got ${problems.length}`);
  });
});
