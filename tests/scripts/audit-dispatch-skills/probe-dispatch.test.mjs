import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildTargets,
  parseArgs,
  statusOf,
} from '../../../.agents/skills/audit-dispatch-skills/scripts/probe-dispatch.mjs';

const SCRIPTS_DIR = path.join('skills', 'dispatch', 'scripts');

/** One discovery row as `discover()` produces them. */
const row = (provider, mode, bin, reachable = true) => ({ provider, mode, bin, reachable });

describe('probe-dispatch: buildTargets', () => {
  it('emits one dispatch-level target per provider when --modes is off', () => {
    const targets = buildTargets(
      [row('claude', 'desktop', '/bin/claude'), row('claude', 'cli', '/usr/bin/claude')],
      { modes: false, config: { platforms: { claude: {} } }, scriptsDir: SCRIPTS_DIR },
    );
    assert.equal(targets.length, 1);
    assert.equal(targets[0].via, 'dispatch');
    assert.deepEqual(targets[0].aliases, ['desktop', 'cli']);
  });

  it('adds --no-config for a provider absent from the dispatch config', () => {
    // A provider the config omits cannot be pinned with --provider alone.
    const targets = buildTargets([row('agy', 'antigravity-cli', '/bin/agy')], {
      modes: false,
      config: { platforms: { claude: {} } },
      scriptsDir: SCRIPTS_DIR,
    });
    assert.ok(targets[0].baseArgs.includes('--no-config'));
  });

  it('omits --no-config for a configured provider', () => {
    const targets = buildTargets([row('agy', 'antigravity-cli', '/bin/agy')], {
      modes: false,
      config: { platforms: { agy: {} } },
      scriptsDir: SCRIPTS_DIR,
    });
    assert.ok(!targets[0].baseArgs.includes('--no-config'));
  });

  it('dedupes modes sharing a binary under --modes, collecting them as aliases', () => {
    // Three copilot modes routinely resolve to one executable; probing it thrice measures nothing.
    const targets = buildTargets(
      [
        row('copilot', 'desktop', '/opt/copilot'),
        row('copilot', 'vscode', '/opt/copilot'),
        row('copilot', 'cli', '/usr/local/bin/copilot'),
      ],
      { modes: true, config: { platforms: { copilot: {} } }, scriptsDir: SCRIPTS_DIR },
    );
    assert.equal(targets.length, 2);
    assert.deepEqual(targets[0].aliases, ['desktop', 'vscode']);
    assert.deepEqual(targets[1].aliases, ['cli']);
  });

  it('skips a provider with no reachable rows', () => {
    const targets = buildTargets([row('claude', 'cli', '/bin/claude', false)], {
      modes: false,
      config: null,
      scriptsDir: SCRIPTS_DIR,
    });
    assert.deepEqual(targets, []);
  });

  it('passes the first model of an array entry, plus effort, under --modes', () => {
    const targets = buildTargets([row('claude', 'cli', '/bin/claude')], {
      modes: true,
      config: { platforms: { claude: { model: ['m1', 'm2'], effort: 'high' } } },
      scriptsDir: SCRIPTS_DIR,
    });
    assert.deepEqual(targets[0].baseArgs.slice(-4), ['-m', 'm1', '-e', 'high']);
  });
});

describe('probe-dispatch: parseArgs', () => {
  it('defaults to all providers, no modes, discovery off', () => {
    const opts = parseArgs([]);
    assert.equal(opts.only, null);
    assert.equal(opts.modes, false);
    assert.equal(opts.discoverOnly, false);
    assert.ok(opts.timeout > 0);
  });

  it('parses --only into a provider list', () => {
    assert.deepEqual(parseArgs(['--only', 'claude,agy']).only, ['claude', 'agy']);
  });

  it('rejects an unknown provider in --only instead of probing nothing', () => {
    assert.throws(() => parseArgs(['--only', 'claude,bogus']), /unknown provider\(s\) bogus/);
  });

  it('rejects a bare --only rather than crashing on undefined', () => {
    assert.throws(() => parseArgs(['--only']), /--only requires/);
  });

  it('rejects an empty --only list', () => {
    assert.throws(() => parseArgs(['--only', ' , ']), /at least one provider/);
  });

  it('rejects a non-numeric --timeout instead of silently using the default', () => {
    assert.throws(() => parseArgs(['--timeout', 'soon']), /--timeout requires a positive number/);
    assert.throws(() => parseArgs(['--timeout', '0']), /--timeout requires a positive number/);
  });

  it('accepts a valid --timeout', () => {
    assert.equal(parseArgs(['--timeout', '45']).timeout, 45);
  });

  it('rejects an unknown argument', () => {
    assert.throws(() => parseArgs(['--nope']), /Unknown argument: --nope/);
  });

  it('skips the --run value, which resolveRunDirs consumes', () => {
    assert.doesNotThrow(() => parseArgs(['--run', '2026-09-12-0001', '--modes']));
    assert.equal(parseArgs(['--run', '2026-09-12-0001', '--modes']).modes, true);
  });
});

describe('probe-dispatch: statusOf', () => {
  it('classifies a reachable row as reachable', () => {
    assert.match(statusOf(row('claude', 'cli', '/bin/claude')).toLowerCase(), /reachable/);
  });

  it('classifies an unreachable row differently', () => {
    const present = statusOf(row('claude', 'cli', '/bin/claude', false));
    assert.notEqual(present, statusOf(row('claude', 'cli', '/bin/claude')));
  });
});
