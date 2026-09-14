import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.join(REPO_ROOT, 'skills/implement-dispatch/scripts/resolve-flow.mjs');

/**
 * Every provider reported reachable, so a run's outcome depends on the arguments under test
 * rather than on what happens to be installed. One real-probe smoke test below opts out.
 */
const ALL_LIVE = JSON.stringify({ claude: true, agy: true, copilot: true, opencode: true });

/**
 * Runs the resolver CLI and returns `{ status, stdout, stderr }`.
 *
 * Liveness is stubbed through the script's env seam: a real run shells out to each provider CLI,
 * costing seconds per case and making assertions depend on the host's installed agents. Pass
 * `{ liveness }` to vary what is reachable, or `{ realProbes: true }` to exercise the real path.
 * The spawn stays bounded so a wedged probe fails loudly instead of hanging the suite.
 */
function run(...args) {
  const opts = typeof args.at(-1) === 'object' ? args.pop() : {};
  const env = { ...process.env };
  if (opts.realProbes) {
    // The seam is gated on the test-mode variable, so both halves must go for a real probe.
    delete env.IMPLEMENT_DISPATCH_LIVENESS_JSON;
    delete env.IMPLEMENT_DISPATCH_TEST_MODE;
  } else {
    env.IMPLEMENT_DISPATCH_LIVENESS_JSON = opts.liveness ?? ALL_LIVE;
    env.IMPLEMENT_DISPATCH_TEST_MODE = '1';
  }

  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
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

describe('resolve-flow CLI', () => {
  it('validates the shipped config without any other flag', () => {
    const { status, stdout } = run('--validate-only');
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
    const spaced = run('--platform', 'claude', '--pins', 'claude,agy');
    const equals = run('--platform=claude', '--pins=claude,agy');
    assert.equal(spaced.status, 0);
    assert.equal(equals.status, 0);
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

  it('exits 1 when every pinned platform is dead', () => {
    const { status, stderr } = run('--platform', 'claude', '--pins', 'agy', {
      liveness: JSON.stringify({ claude: true, agy: false, copilot: false, opencode: false }),
    });
    assert.equal(status, 1);
    assert.match(stderr, /agy/);
  });

  it('exits 1 when the liveness seam yields unparsable JSON', () => {
    const { status, stderr } = run('--platform', 'claude', { liveness: '{not json' });
    assert.equal(status, 1);
    assert.match(stderr, /liveness/i);
  });

  it('reports a pinned platform that is unreachable in diagnostics', () => {
    const { status, stdout } = run('--platform', 'claude', '--pins', 'agy,copilot', {
      liveness: JSON.stringify({ claude: true, agy: true, copilot: false, opencode: false }),
    });
    assert.equal(status, 0);
    const flow = JSON.parse(stdout);
    assert.ok(
      JSON.stringify(flow.diagnostics).includes('copilot'),
      'a dead pin is named in diagnostics rather than silently dropped',
    );
  });

  it('accepts --exclude and --exclude= forms equivalently', () => {
    const spaced = run('--platform', 'claude', '--level', 'high', '--exclude', 'copilot');
    const equals = run('--platform=claude', '--level=high', '--exclude=copilot');
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
    fs.cpSync(
      path.join(REPO_ROOT, 'skills/implement-dispatch/config.default.jsonc'),
      path.join(skillDir, 'config.default.jsonc'),
    );
    fs.cpSync(path.join(REPO_ROOT, 'skills/dispatch'), path.join(dir, 'dispatch'), { recursive: true });

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
