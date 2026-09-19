import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { generateSkillHashes } from '../../../skills/dispatch/scripts/common.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.join(REPO_ROOT, 'skills/implement-dispatch/scripts/resolve-flow.mjs');
const DISPATCH_SAMPLE = path.join(REPO_ROOT, 'skills/dispatch/config.sample.jsonc');
const IMPLEMENT_DISPATCH_SAMPLE = path.join(REPO_ROOT, 'skills/implement-dispatch/config.sample.jsonc');

/**
 * Every provider reported reachable, so a run's outcome depends on the arguments under test
 * rather than on what happens to be installed. One real-probe smoke test below opts out.
 */
const ALL_LIVE = JSON.stringify({ claude: true, agy: true, copilot: true, opencode: true });

/**
 * Runs the resolver CLI and returns `{ status, stdout, stderr }`.
 *
 * The spawn always lands on the shared defaults fixture: the repo script's effective config is the
 * developer's git-ignored config, which does not exist on a fresh checkout, so spawning
 * `skills/implement-dispatch/scripts/resolve-flow.mjs` directly would fail on config load before
 * argument parsing. Liveness is stubbed through the script's env seam — a real run shells out to
 * each provider CLI, costing seconds per case and making assertions depend on the host's installed
 * agents. Pass `{ liveness }` to vary what is reachable, or `{ realProbes: true }` to exercise the
 * real path. The spawn stays bounded so a wedged probe fails loudly instead of hanging the suite.
 */
function run(...args) {
  const opts = typeof args.at(-1) === 'object' ? args.pop() : {};
  defaultsFixture ??= buildFixture({ prefix: 'resolve-flow-defaults-' });
  return runFixtureScript(defaultsFixture.skillDir, args, opts);
}

/**
 * Copies the dispatch skill beside a fixture so resolve-flow.mjs's sibling imports resolve, then
 * drops the git-ignored config overrides and writes the shipped `config.sample.jsonc` as the
 * fixture's `config.jsonc`. Without that, the fixture would inherit whichever
 * platforms the developer's own `config.jsonc` happens to configure, and the platform cross-check
 * against implement-dispatch's 4-platform default would pass or fail per machine.
 */
function copyDispatchSkill(destination) {
  fs.cpSync(path.join(REPO_ROOT, 'skills/dispatch'), destination, { recursive: true });
  for (const override of ['config.jsonc', 'config.local.jsonc']) {
    fs.rmSync(path.join(destination, override), { force: true });
  }
  fs.writeFileSync(path.join(destination, 'config.jsonc'), fs.readFileSync(DISPATCH_SAMPLE, 'utf8'));
}

/**
 * Builds a throwaway implement-dispatch skill dir with dispatch copied beside it, so the script's
 * sibling imports and config lookups both resolve inside the fixture.
 *
 * Both skills get the shipped `config.sample.jsonc` written as their `config.jsonc` (all four
 * platforms) unless a caller overrides one, which is what makes a fixture run independent of the
 * developer's own git-ignored configs.
 *
 * @param {object} [options]
 * @param {string} [options.prefix] mkdtemp prefix, for readable temp paths on failure.
 * @param {string|null} [options.config] Contents for this skill's `config.jsonc`.
 * @param {string|null} [options.dispatchConfig] Contents for dispatch's `config.jsonc`.
 * @param {boolean} [options.hashable] Also copy the files the integrity manifest covers.
 * @returns {{ dir: string, skillDir: string }}
 */
function buildFixture({ prefix = 'resolve-flow-', config = null, dispatchConfig = null, hashable = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const skillDir = path.join(dir, 'implement-dispatch');
  fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(skillDir, 'scripts', 'resolve-flow.mjs'));
  if (config === null) {
    fs.writeFileSync(path.join(skillDir, 'config.jsonc'), fs.readFileSync(IMPLEMENT_DISPATCH_SAMPLE, 'utf8'));
  } else {
    fs.writeFileSync(path.join(skillDir, 'config.jsonc'), config);
  }
  if (hashable) {
    fs.copyFileSync(path.join(REPO_ROOT, 'skills/implement-dispatch/SKILL.md'), path.join(skillDir, 'SKILL.md'));
  }
  const dispatchDir = path.join(dir, 'dispatch');
  copyDispatchSkill(dispatchDir);
  if (dispatchConfig !== null) fs.writeFileSync(path.join(dispatchDir, 'config.jsonc'), dispatchConfig);
  return { dir, skillDir };
}

/** Runs a fixture's copy of the script under the same liveness seam {@link run} uses. */
function runFixtureScript(skillDir, args = [], { liveness = ALL_LIVE, realProbes = false } = {}) {
  const env = { ...process.env };
  if (realProbes) {
    // The seam is gated on the test-mode variable, so both halves must go for a real probe.
    delete env.IMPLEMENT_DISPATCH_LIVENESS_JSON;
    delete env.IMPLEMENT_DISPATCH_TEST_MODE;
  } else {
    env.IMPLEMENT_DISPATCH_LIVENESS_JSON = liveness;
    env.IMPLEMENT_DISPATCH_TEST_MODE = '1';
  }
  const result = spawnSync(process.execPath, [path.join(skillDir, 'scripts', 'resolve-flow.mjs'), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
    env,
  });
  assert.equal(
    result.status !== null,
    true,
    `CLI did not exit on its own (signal ${result.signal}): ${result.stderr}`
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Named entry onto the shared defaults fixture, for tests that document dependence on the shipped
 * sample's four-platform policy rather than generic CLI behaviour ({@link run} uses the same fixture).
 */
let defaultsFixture;
function runOnDefaults(args, opts) {
  defaultsFixture ??= buildFixture({ prefix: 'resolve-flow-defaults-' });
  return runFixtureScript(defaultsFixture.skillDir, args, opts);
}

after(() => {
  if (defaultsFixture) fs.rmSync(defaultsFixture.dir, { recursive: true, force: true });
});

describe('resolve-flow CLI', () => {
  it('validates the shipped config without any other flag', () => {
    const { status, stdout } = runOnDefaults(['--validate-only']);
    assert.equal(status, 0);
    assert.match(stdout, /Config is valid\./);
  });

  it('refuses --validate-only combined with run flags', () => {
    const { status, stderr } = run('--validate-only', '--platform', 'claude', '--level', 'high');
    assert.equal(status, 1);
    assert.match(stderr, /cannot be combined with: --platform, --level/);
  });

  it('refuses --validate-only combined with --orchestrator-model', () => {
    const { status, stderr } = run('--validate-only', '--orchestrator-model', 'claude-opus-5');
    assert.equal(status, 1);
    assert.match(stderr, /cannot be combined with: --orchestrator-model/);
  });

  it('requires --platform', () => {
    const { status, stderr } = run('--level', 'low');
    assert.equal(status, 1);
    assert.match(stderr, /--platform is required/);
  });

  it('rejects --slug as an unrecognized argument (artifact paths are resolved separately, by dispatch)', () => {
    const { status, stderr } = run('--platform', 'claude', '--slug', 'auth-v2');
    assert.equal(status, 1);
    assert.match(stderr, /Unrecognized argument "--slug"/);
  });

  it('rejects --date as an unrecognized argument', () => {
    const { status, stderr } = run('--platform', 'claude', '--date', '2026-09-10');
    assert.equal(status, 1);
    assert.match(stderr, /Unrecognized argument "--date"/);
  });

  it('rejects --slug=value in --flag=value form', () => {
    const { status, stderr } = run('--platform=claude', '--slug=auth-v2');
    assert.equal(status, 1);
    assert.match(stderr, /Unrecognized argument "--slug"/);
  });

  it('rejects an unrecognized argument', () => {
    const { status, stderr } = run('--platform', 'claude', '--rounds', '3');
    assert.equal(status, 1);
    assert.match(stderr, /Unrecognized argument "--rounds"/);
  });

  it('rejects a flag with a missing value', () => {
    const { status, stderr } = run('--platform');
    assert.equal(status, 1);
    assert.match(stderr, /Missing value for --platform/);
  });

  it('rejects --orchestrator-model with a missing value', () => {
    const { status, stderr } = run('--platform', 'claude', '--orchestrator-model');
    assert.equal(status, 1);
    assert.match(stderr, /Missing value for --orchestrator-model/);
  });

  it('accepts --orchestrator-model and --orchestrator-model= forms equivalently', () => {
    const spaced = run('--platform', 'claude', '--level', 'low', '--orchestrator-model', 'claude-opus-5');
    const equals = run('--platform=claude', '--level=low', '--orchestrator-model=claude-opus-5');
    assert.equal(spaced.status, 0);
    assert.equal(equals.status, 0);
    assert.deepEqual(JSON.parse(spaced.stdout), JSON.parse(equals.stdout));
  });

  it('rejects an unknown level', () => {
    const { status, stderr } = run('--platform', 'claude', '--level', 'ultra');
    assert.equal(status, 1);
    assert.match(stderr, /Unknown level "ultra"/);
  });

  it('emits a flow plan for a valid run, with no artifact paths (dispatch\'s concern now)', () => {
    const { status, stdout } = run('--platform', 'claude', '--level', 'low');
    assert.equal(status, 0);
    const flow = JSON.parse(stdout);
    assert.equal(flow.paths, undefined);
    assert.equal(flow.diagnostics.effectiveLevel, 'low');
  });

  it('accepts --level xhigh', () => {
    const { status, stdout } = run('--platform', 'claude', '--level', 'xhigh');
    assert.equal(status, 0);
    const flow = JSON.parse(stdout);
    assert.equal(flow.diagnostics.effectiveLevel, 'xhigh');
  });

  it('--show-effective reports config, inheritance, order, reserves, and membership', () => {
    const { status, stdout, stderr } = runOnDefaults([
      '--show-effective',
      '--platform',
      'claude',
      '--level',
      'high',
    ]);
    assert.equal(status, 0, stderr);
    const report = JSON.parse(stdout);
    assert.match(report.configPath, /config\.jsonc$/);
    assert.equal(report.requestedLevel, 'high');
    assert.equal(report.effectiveLevel, 'high');
    assert.ok(report.inheritance['plan-review'].maxRounds.inheritedLevelKey);
    assert.ok(Array.isArray(report.candidateOrder['code-review']));
    assert.ok(Array.isArray(report.reserves['code-review']));
    assert.equal(report.crossConfigMembership.valid, true);
    assert.deepEqual(report.exclusions, []);
  });

  it('refuses --show-effective with --validate-only', () => {
    const { status, stderr } = run('--show-effective', '--validate-only');
    assert.equal(status, 1);
    assert.match(stderr, /cannot be combined with: --show-effective/);
  });

  it('accepts --flag=value form equivalently to space-separated flags', () => {
    const { status, stdout } = run('--platform=claude', '--level=low');
    assert.equal(status, 0);
    const flow = JSON.parse(stdout);
    assert.equal(flow.diagnostics.effectiveLevel, 'low');
  });

  it('parses --pins=key,key in --flag=value form (proven via the unrecognized-pin error path, to stay independent of real provider liveness)', () => {
    const { status, stderr } = run('--platform=claude', '--pins=bogus,alsobogus');
    assert.equal(status, 1);
    assert.match(stderr, /Unrecognized pin key\(s\): bogus, alsobogus/);
  });

  it('accepts --pins=all in --flag=value form', () => {
    const { status, stdout } = run('--platform=claude', '--pins=all');
    assert.equal(status, 0);
    const flow = JSON.parse(stdout);
    assert.ok(flow['code-review'].targets.length > 0);
  });

  it('resolves space-separated "--pins claude,agy" the same as "--pins=claude,agy"', () => {
    const spaced = runOnDefaults(['--platform', 'claude', '--pins', 'claude,agy']);
    const equals = runOnDefaults(['--platform=claude', '--pins=claude,agy']);
    assert.equal(spaced.status, 0, spaced.stderr);
    assert.equal(equals.status, 0, equals.stderr);
    assert.deepEqual(JSON.parse(spaced.stdout), JSON.parse(equals.stdout));
  });

  it('prints usage and exits 0 on --help / -h', () => {
    for (const flag of ['--help', '-h']) {
      const { status, stdout } = run(flag);
      assert.equal(status, 0);
      assert.match(stdout, /Usage:/);
      assert.match(stdout, /--platform <key>/);
    }
  });

  it('rejects an unrecognized --flag=value argument', () => {
    const { status, stderr } = run('--platform', 'claude', '--rounds=3');
    assert.equal(status, 1);
    assert.match(stderr, /Unrecognized argument "--rounds"/);
  });

  it('keeps a configured named pin when its liveness probe fails', () => {
    const { status, stdout } = runOnDefaults(['--platform', 'claude', '--pins', 'agy'], {
      liveness: JSON.stringify({ claude: true, agy: false, copilot: false, opencode: false }),
    });
    assert.equal(status, 0);
    const flow = JSON.parse(stdout);
    assert.deepEqual(flow['code-review'].targets.map(target => target.platform), ['agy']);
    assert.ok(flow.diagnostics.unavailable.includes('agy'));
  });

  it('exits 1 when the liveness seam yields unparsable JSON', () => {
    const { status, stderr } = run('--platform', 'claude', { liveness: '{not json' });
    assert.equal(status, 1);
    assert.match(stderr, /liveness/i);
  });

  it('reports a pinned platform that is unreachable in diagnostics', () => {
    const { status, stdout, stderr } = runOnDefaults(['--platform', 'claude', '--pins', 'agy,copilot'], {
      liveness: JSON.stringify({ claude: true, agy: true, copilot: false, opencode: false }),
    });
    assert.equal(status, 0, stderr);
    const flow = JSON.parse(stdout);
    assert.ok(
      JSON.stringify(flow.diagnostics).includes('copilot'),
      'a dead pin is named in diagnostics rather than silently dropped',
    );
  });

  it('accepts --exclude and --exclude= forms equivalently', () => {
    // Exclude keys are validated against the configured platforms, so this needs a config known
    // to carry copilot rather than the developer's.
    const spaced = runOnDefaults(['--platform', 'claude', '--level', 'high', '--exclude', 'copilot']);
    const equals = runOnDefaults(['--platform=claude', '--level=high', '--exclude=copilot']);
    assert.equal(spaced.status, 0, spaced.stderr);
    assert.equal(equals.status, 0, equals.stderr);
    const flow = JSON.parse(spaced.stdout);
    assert.deepEqual(flow.diagnostics.excluded, ['copilot']);
    assert.ok(flow['code-review'].targets.every((t) => t.platform !== 'copilot'));
    assert.deepEqual(flow, JSON.parse(equals.stdout));
  });

  it('rejects exclude errors before probing, even when the liveness seam is broken', () => {
    // Unparsable liveness proves the error came from pre-validation, not from resolveFlow after probing.
    const broken = { liveness: '{not json' };
    const unknown = run('--platform', 'claude', '--exclude', 'bogus', broken);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unrecognized exclude key\(s\): bogus\. Valid keys: /);
    const self = run('--platform', 'claude', '--exclude', 'claudecode', broken);
    assert.equal(self.status, 1);
    assert.match(self.stderr, /Cannot exclude the orchestrator platform "claude"/);
  });

  it('refuses --exclude combined with --validate-only', () => {
    const { status, stderr } = run('--validate-only', '--exclude', 'copilot');
    assert.equal(status, 1);
    assert.match(stderr, /cannot be combined with: --exclude/);
  });

  it('rejects --pins 0 before probing', () => {
    const broken = { liveness: '{not json' };
    const { status, stderr } = run('--platform', 'claude', '--pins', '0', broken);
    assert.equal(status, 1);
    assert.match(stderr, /Reviewer count pin must be an integer from 1 to/);
  });

  it('rejects --pins 2,claude before probing', () => {
    const broken = { liveness: '{not json' };
    const { status, stderr } = run('--platform', 'claude', '--pins', '2,claude', broken);
    assert.equal(status, 1);
    assert.match(stderr, /A reviewer count or "all" pin must stand alone/);
  });

  it('resolves --pins=2 under the liveness env seam', () => {
    const { status, stdout } = runOnDefaults(['--platform=claude', '--level=medium', '--pins=2']);
    assert.equal(status, 0);
    const flow = JSON.parse(stdout);
    assert.equal(flow.diagnostics.targetCountPin, 2);
    assert.equal(flow['code-review'].targets.length, 2);
  });

  it('rejects an unknown --platform, naming the valid keys', () => {
    const { status, stderr } = run('--platform', 'bogus', '--level', 'low');
    assert.equal(status, 1);
    assert.match(stderr, /Unknown platform "bogus"\. Valid platforms: .*claude/);
  });

  it('accepts the documented --platform alias claudecode', () => {
    const { status, stdout } = run('--platform', 'claudecode', '--level', 'low');
    assert.equal(status, 0);
    assert.equal(JSON.parse(stdout).implementation.platform, 'claude');
  });

  it('reports livenessSource "env-override" when the gated seam supplies liveness', () => {
    const { status, stdout } = run('--platform', 'claude', '--level', 'low');
    assert.equal(status, 0);
    assert.equal(JSON.parse(stdout).diagnostics.livenessSource, 'env-override');
  });

  it('rejects the liveness payload when the test-mode variable is absent', () => {
    // Spawned directly: `run` always pairs the two variables, which is the behaviour under test.
    const env = { ...process.env, IMPLEMENT_DISPATCH_LIVENESS_JSON: ALL_LIVE };
    delete env.IMPLEMENT_DISPATCH_TEST_MODE;
    const result = spawnSync(process.execPath, [SCRIPT, '--platform', 'claude', '--level', 'low'], {
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
      env,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /IMPLEMENT_DISPATCH_LIVENESS_JSON/);
    assert.match(result.stderr, /IMPLEMENT_DISPATCH_TEST_MODE/);
  });

  it(
    'probes real providers when the seam is absent',
    { skip: process.env.RUN_LIVE_PROVIDER_PROBES ? false : 'set RUN_LIVE_PROVIDER_PROBES=1 to run' },
    () => {
      const { status, stdout } = run('--platform', 'claude', { realProbes: true });
      assert.equal(status, 0);
      assert.equal(JSON.parse(stdout).diagnostics.livenessSource, 'probe');
    },
  );
});

describe('resolve-flow CLI: invalid config', () => {
  /**
   * Points the loader at a config directory of our own, so an invalid schema can be exercised
   * without editing the shipped one.
   */
  const withConfig = (contents, ...args) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-flow-cfg-'));
    const skillDir = path.join(dir, 'implement-dispatch');
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'config.jsonc'), contents);
    // The script resolves its config relative to its own location, so it has to run from a copy.
    fs.copyFileSync(SCRIPT, path.join(skillDir, 'scripts', 'resolve-flow.mjs'));
    copyDispatchSkill(path.join(dir, 'dispatch'));

    try {
      const result = spawnSync(process.execPath, [path.join(skillDir, 'scripts', 'resolve-flow.mjs'), ...args], {
        encoding: 'utf8',
        timeout: 60_000,
        killSignal: 'SIGKILL',
        env: {
          ...process.env,
          IMPLEMENT_DISPATCH_LIVENESS_JSON: ALL_LIVE,
          IMPLEMENT_DISPATCH_TEST_MODE: '1',
        },
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const INVALID = '{ "plan-review": { "platforms": {}, "maxRounds": {}, "targetCount": {}, "consensus": {}, "bogusKey": 1 } }';

  it('--validate-only exits 1 for an invalid config', () => {
    const { status, stderr } = withConfig(INVALID, '--validate-only');
    assert.equal(status, 1);
    assert.match(stderr, /Invalid config|unrecognized key/i);
  });

  it('the run path exits 1 on an invalid config before probing', () => {
    const { status, stderr } = withConfig(INVALID, '--platform', 'claude');
    assert.equal(status, 1);
    assert.match(stderr, /Invalid config|unrecognized key/i);
  });
});

describe('resolve-flow CLI: integrity manifest', () => {
  /**
   * Builds an implement-dispatch skill dir beside a copy of dispatch, the same layout
   * the invalid-config fixture above uses, so resolve-flow.mjs's sibling imports resolve.
   */
  const setupFixture = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-flow-integrity-'));
    const skillDir = path.join(dir, 'implement-dispatch');
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
    fs.copyFileSync(
      path.join(REPO_ROOT, 'skills/implement-dispatch/SKILL.md'),
      path.join(skillDir, 'SKILL.md'),
    );
    fs.copyFileSync(SCRIPT, path.join(skillDir, 'scripts', 'resolve-flow.mjs'));
    fs.writeFileSync(
      path.join(skillDir, 'config.jsonc'),
      fs.readFileSync(IMPLEMENT_DISPATCH_SAMPLE, 'utf8'),
    );
    copyDispatchSkill(path.join(dir, 'dispatch'));
    return { dir, skillDir };
  };

  const runFixture = (skillDir, args = ['--validate-only']) => {
    const result = spawnSync(
      process.execPath,
      [path.join(skillDir, 'scripts', 'resolve-flow.mjs'), ...args],
      {
        encoding: 'utf8',
        timeout: 60_000,
        killSignal: 'SIGKILL',
        env: { ...process.env, IMPLEMENT_DISPATCH_LIVENESS_JSON: ALL_LIVE, IMPLEMENT_DISPATCH_TEST_MODE: '1' },
      },
    );
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  it('exits 1 with the modified file listed when a hashed file drifts', () => {
    const { dir, skillDir } = setupFixture();
    try {
      const manifest = generateSkillHashes(skillDir);
      fs.writeFileSync(path.join(skillDir, 'skill-hashes.json'), JSON.stringify(manifest, null, 2) + '\n');
      // Tamper with SKILL.md after the manifest is written, so its hash no longer matches.
      fs.appendFileSync(path.join(skillDir, 'SKILL.md'), '\n<!-- tampered -->\n');

      const { status, stderr } = runFixture(skillDir);
      assert.equal(status, 1);
      assert.match(stderr, /Skill file integrity check failed/);
      assert.match(stderr, /SKILL\.md/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aborts a normal --platform run on drift, and --help bypasses the gate', () => {
    const { dir, skillDir } = setupFixture();
    try {
      fs.writeFileSync(
        path.join(skillDir, 'skill-hashes.json'),
        JSON.stringify(generateSkillHashes(skillDir), null, 2) + '\n',
      );
      fs.appendFileSync(path.join(skillDir, 'SKILL.md'), '\n<!-- tampered -->\n');

      const platformRun = runFixture(skillDir, ['--platform', 'claude']);
      assert.equal(platformRun.status, 1);
      assert.match(platformRun.stderr, /Skill file integrity check failed/);
      assert.equal(platformRun.stdout, '');

      const help = runFixture(skillDir, ['--help']);
      assert.equal(help.status, 0);
      assert.match(help.stdout, /Usage:/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns and proceeds (exit 0) when the manifest is absent', () => {
    const { dir, skillDir } = setupFixture();
    try {
      const { status, stdout, stderr } = runFixture(skillDir);
      assert.equal(status, 0);
      assert.match(stdout, /Config is valid\./);
      assert.match(stderr, /integrity manifest.*not found/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolve-flow CLI: dispatch platform cross-check', () => {
  /**
   * Builds an implement-dispatch fixture beside a dispatch whose config we control, so the
   * subset check can be exercised end-to-end without touching either shipped config.
   *
   * @param {string|null} dispatchConfig Contents for dispatch's `config.jsonc`; `null` leaves the
   *   shipped sample (all four platforms) in place, and `''` writes an unparsable file.
   */
  const setup = (dispatchConfig) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-flow-crosscheck-'));
    const skillDir = path.join(dir, 'implement-dispatch');
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(skillDir, 'scripts', 'resolve-flow.mjs'));
    fs.writeFileSync(
      path.join(skillDir, 'config.jsonc'),
      fs.readFileSync(IMPLEMENT_DISPATCH_SAMPLE, 'utf8'),
    );
    const dispatchDir = path.join(dir, 'dispatch');
    copyDispatchSkill(dispatchDir);
    if (dispatchConfig !== null) {
      fs.writeFileSync(path.join(dispatchDir, 'config.jsonc'), dispatchConfig);
    }
    return { dir, skillDir };
  };

  const runInFixture = (skillDir, args = ['--validate-only']) => runFixtureScript(skillDir, args);

  const ONLY_CLAUDE = '{ "platforms": { "claude": { "model": "m", "effort": "low" } } }';

  it('passes when dispatch configures every platform this skill does', () => {
    const { dir, skillDir } = setup(null);
    try {
      const { status, stdout } = runInFixture(skillDir);
      assert.equal(status, 0);
      assert.match(stdout, /Config is valid\./);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 naming each section and the offending platform when dispatch lacks it', () => {
    const { dir, skillDir } = setup(ONLY_CLAUDE);
    try {
      const { status, stderr } = runInFixture(skillDir);
      assert.equal(status, 1);
      assert.match(stderr, /Invalid config:/);
      assert.match(stderr, /plan-review\.platforms\."agy" is not configured in .*config\.jsonc/);
      assert.doesNotMatch(stderr, /implementation\.platforms\."copilot"/);
      assert.match(stderr, /code-review\.platforms\."opencode"/);
      assert.match(stderr, /exits PLATFORM_NOT_CONFIGURED; add it there or remove it here/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--show-effective reports cross-config membership mismatches', () => {
    const { dir, skillDir } = setup(ONLY_CLAUDE);
    try {
      const { status, stdout, stderr } = runInFixture(skillDir, [
        '--show-effective',
        '--platform',
        'claude',
        '--level',
        'high',
      ]);
      assert.equal(status, 0, stderr);
      const report = JSON.parse(stdout);
      assert.equal(report.crossConfigMembership.valid, false);
      assert.deepEqual(
        report.crossConfigMembership.missingFromDispatch,
        ['agy', 'copilot', 'opencode'],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows a Copilot native implementation subagent without dispatch membership', () => {
    const implementationOnlyCopilot = JSON.stringify({
      'plan-review': {
        maxRounds: { low: 0 },
        targetCount: { low: 0 },
        consensus: { low: false },
        platforms: { claude: {} },
      },
      implementation: { platforms: { copilot: { model: 'gpt-5.6-luna' } } },
      'code-review': {
        maxRounds: { low: 0 },
        targetCount: { low: 0 },
        consensus: { low: false },
        platforms: { claude: {} },
      },
    });
    const { dir, skillDir } = setup(ONLY_CLAUDE);
    try {
      fs.writeFileSync(path.join(skillDir, 'config.jsonc'), implementationOnlyCopilot);
      const { status, stdout } = runFixtureScript(skillDir, ['--validate-only']);
      assert.equal(status, 0);
      assert.match(stdout, /Config is valid\./);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks the run path too, before any liveness probing', () => {
    const { dir, skillDir } = setup(ONLY_CLAUDE);
    try {
      const { status, stdout, stderr } = runInFixture(skillDir, ['--platform', 'claude']);
      assert.equal(status, 1);
      assert.equal(stdout, '');
      assert.match(stderr, /is not configured in/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when dispatch config is unreadable', () => {
    const { dir, skillDir } = setup(null);
    try {
      // Remove dispatch config entirely: membership cannot be established, so neither validation
      // nor a normal resolve run may proceed.
      fs.rmSync(path.join(dir, 'dispatch', 'config.jsonc'), { force: true });
      const validation = runInFixture(skillDir);
      assert.equal(validation.status, 1);
      assert.equal(validation.stdout, '');
      assert.match(validation.stderr, /effective platform set could not be loaded/);
      assert.match(validation.stderr, /Config file not found/);

      const resolution = runInFixture(skillDir, ['--platform', 'claude']);
      assert.equal(resolution.status, 1);
      assert.equal(resolution.stdout, '');
      assert.match(resolution.stderr, /effective platform set could not be loaded/);
      assert.match(resolution.stderr, /Config file not found/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
