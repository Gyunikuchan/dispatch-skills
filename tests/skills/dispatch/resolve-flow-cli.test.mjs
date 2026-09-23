import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { generateSkillHashes } from '../../../skills/dispatch/scripts/common.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DISPATCH_SKILL = path.join(REPO_ROOT, 'skills/dispatch');
const DISPATCH_SAMPLE = path.join(DISPATCH_SKILL, 'config.sample.jsonc');

/**
 * Every provider reported reachable, so a run's outcome depends on the arguments under test
 * rather than on what happens to be installed. One real-probe smoke test below opts out.
 */
const ALL_LIVE = JSON.stringify({ claude: true, agy: true, copilot: true, opencode: true });

/** Four read delegates, four write subagents, and every review phase: a deterministic fixture. */
const FULL_CONFIG = JSON.stringify({
  'read-delegates': {
    claude: { model: 'claude-opus-5', effort: 'low' },
    agy: { model: 'gemini-3.8-flash', effort: 'medium' },
    copilot: { model: 'gpt-6-astra', effort: 'low' },
    opencode: [{ model: 'opencode-go/glm-5.3-flash', effort: 'max' }, { model: 'lmstudio/qwen3.8-27b-ridge', effort: 'medium' }],
  },
  'write-subagents': {
    claude: { model: 'claude-sonnet-5', effort: 'medium', high: { model: 'claude-opus-5', effort: 'medium' } },
    agy: { model: 'gemini-3.8-flash', effort: 'medium' },
    copilot: { model: ['gpt-5.6-luna', 'bedrock.gpt-5.6-luna'], effort: 'max' },
    opencode: { model: 'opencode-go/glm-5.3-flash', effort: 'medium' },
  },
  phases: {
    'plan-review': { rounds: { low: 0, medium: 2, high: 3 }, targets: { low: 0, medium: 1, high: 2 }, consensus: { low: false, medium: true } },
    'design-review': { rounds: { low: 1, high: 3 }, targets: { low: 1, high: 2 }, consensus: { low: false, medium: true } },
    'code-review': { rounds: { low: 1, medium: 3 }, targets: { low: 1, medium: 2, high: 3 }, consensus: { low: false, medium: true } },
  },
});

/**
 * Copies the dispatch skill into a throwaway dir and writes `config` as its `config.jsonc`, so the
 * spawned resolver never reads the developer's git-ignored config. Pass `config: 'sample'` to use
 * the shipped sample.
 */
function buildFixture({ prefix = 'resolve-flow-', config = FULL_CONFIG, manifest = 'keep' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const skillDir = path.join(dir, 'dispatch');
  fs.cpSync(DISPATCH_SKILL, skillDir, { recursive: true });
  for (const override of ['config.jsonc', 'config.local.jsonc']) {
    fs.rmSync(path.join(skillDir, override), { force: true });
  }
  const contents = config === 'sample' ? fs.readFileSync(DISPATCH_SAMPLE, 'utf8') : config;
  if (contents !== null) fs.writeFileSync(path.join(skillDir, 'config.jsonc'), contents);
  if (manifest === 'remove') fs.rmSync(path.join(skillDir, 'skill-hashes.json'), { force: true });
  return { dir, skillDir };
}

/** Runs a fixture's resolver under the renamed liveness seam. */
function runFixtureScript(skillDir, args = [], { liveness = ALL_LIVE, realProbes = false, env: extraEnv = {} } = {}) {
  const env = { ...process.env, ...extraEnv };
  // The v0.4 variable names must no longer arm the seam.
  delete env.IMPLEMENT_DISPATCH_LIVENESS_JSON;
  delete env.IMPLEMENT_DISPATCH_TEST_MODE;
  if (realProbes) {
    delete env.DISPATCH_LIVENESS_JSON;
    delete env.DISPATCH_TEST_MODE;
  } else {
    env.DISPATCH_LIVENESS_JSON = liveness;
    env.DISPATCH_TEST_MODE = '1';
  }
  const result = spawnSync(process.execPath, [path.join(skillDir, 'scripts', 'resolve-flow.mjs'), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
    env,
  });
  assert.equal(result.status !== null, true, `CLI did not exit on its own (signal ${result.signal}): ${result.stderr}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

let defaultsFixture;
function run(...args) {
  const opts = typeof args.at(-1) === 'object' ? args.pop() : {};
  defaultsFixture ??= buildFixture({ prefix: 'resolve-flow-defaults-' });
  return runFixtureScript(defaultsFixture.skillDir, args, opts);
}

/** Runs against a one-off fixture and cleans it up. */
function withFixture(options, args, runOptions) {
  const fixture = buildFixture(options);
  try {
    return runFixtureScript(fixture.skillDir, args, runOptions);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
}

after(() => {
  if (defaultsFixture) fs.rmSync(defaultsFixture.dir, { recursive: true, force: true });
});

describe('resolve-flow CLI (dispatch/scripts)', () => {
  it('lives under the dispatch skill', () => {
    assert.ok(fs.existsSync(path.join(DISPATCH_SKILL, 'scripts', 'resolve-flow.mjs')));
    assert.ok(!fs.existsSync(path.join(REPO_ROOT, 'skills/implement-dispatch/scripts/resolve-flow.mjs')));
  });

  it('validates the fixture config and the shipped sample without any other flag', () => {
    const { status, stdout, stderr } = run('--validate-only');
    assert.equal(status, 0, stderr);
    assert.match(stdout, /Config is valid\./);
    const sample = withFixture({ config: 'sample' }, ['--validate-only']);
    assert.equal(sample.status, 0, sample.stderr);
    assert.match(sample.stdout, /Config is valid\./);
  });

  it('refuses --validate-only combined with run flags', () => {
    const { status, stderr } = run('--validate-only', '--platform', 'claude', '--level', 'high');
    assert.equal(status, 1);
    assert.match(stderr, /cannot be combined with: --platform, --level/);
    const model = run('--validate-only', '--orchestrator-model', 'claude-opus-5');
    assert.equal(model.status, 1);
    assert.match(model.stderr, /cannot be combined with: --orchestrator-model/);
  });

  it('requires --platform', () => {
    const { status, stderr } = run('--level', 'low');
    assert.equal(status, 1);
    assert.match(stderr, /--platform is required/);
  });

  it('rejects unrecognized arguments in both forms', () => {
    for (const args of [['--platform', 'claude', '--slug', 'x'], ['--platform=claude', '--slug=x'], ['--platform', 'claude', '--rounds', '3'], ['--platform', 'claude', '--rounds=3']]) {
      const { status, stderr } = run(...args);
      assert.equal(status, 1, args.join(' '));
      assert.match(stderr, /Unrecognized argument "--(slug|rounds)"/);
    }
  });

  it('rejects a flag with a missing value', () => {
    assert.match(run('--platform').stderr, /Missing value for --platform/);
    assert.match(run('--platform', 'claude', '--orchestrator-model').stderr, /Missing value for --orchestrator-model/);
  });

  it('accepts --orchestrator-model and --orchestrator-model= forms equivalently', () => {
    const spaced = run('--platform', 'claude', '--level', 'low', '--orchestrator-model', 'claude-opus-5');
    const equals = run('--platform=claude', '--level=low', '--orchestrator-model=claude-opus-5');
    assert.equal(spaced.status, 0, spaced.stderr);
    assert.equal(equals.status, 0, equals.stderr);
    assert.deepEqual(JSON.parse(spaced.stdout), JSON.parse(equals.stdout));
  });

  it('accepts implementation fields and rejects them with --validate-only', () => {
    const runResult = run('--platform', 'claude', '--implementation-fields', 'model,effort');
    assert.equal(runResult.status, 0, runResult.stderr);
    assert.deepEqual(JSON.parse(runResult.stdout).implementation.applicableFields, ['model', 'effort']);
    const validation = run('--validate-only', '--implementation-fields', 'model');
    assert.equal(validation.status, 1);
    assert.match(validation.stderr, /cannot be combined with: --implementation-fields/);
  });

  it('rejects invalid implementation field sets before probing', () => {
    const { status, stderr } = run('--platform', 'claude', '--implementation-fields', 'effort', { liveness: '{not json' });
    assert.equal(status, 1);
    assert.match(stderr, /must be "model" or "model,effort"/);
  });

  it('rejects an unknown level', () => {
    const { status, stderr } = run('--platform', 'claude', '--level', 'ultra');
    assert.equal(status, 1);
    assert.match(stderr, /Unknown level "ultra"/);
  });

  it('emits a flow plan with plan-review, design-review, code-review, and implementation', () => {
    const { status, stdout, stderr } = run('--platform', 'claude', '--level', 'high');
    assert.equal(status, 0, stderr);
    const flow = JSON.parse(stdout);
    assert.equal(flow.paths, undefined);
    assert.equal(flow.diagnostics.effectiveLevel, 'high');
    assert.equal(flow['plan-review'].rounds, 3);
    assert.equal(flow['design-review'].rounds, 3);
    assert.equal(flow['design-review'].targets.length, 2);
    assert.equal(flow['code-review'].rounds, 3);
    for (const phase of ['plan-review', 'design-review', 'code-review']) {
      assert.equal(flow[phase].maxRounds, undefined, `${phase} uses rounds`);
    }
    assert.equal(flow.implementation.platform, 'claude');
    assert.equal(flow.implementation.model, 'claude-opus-5');
  });

  it('accepts --level xhigh and --flag=value forms', () => {
    assert.equal(JSON.parse(run('--platform', 'claude', '--level', 'xhigh').stdout).diagnostics.effectiveLevel, 'xhigh');
    assert.equal(JSON.parse(run('--platform=claude', '--level=low').stdout).diagnostics.effectiveLevel, 'low');
  });

  it('--show-effective reports inheritance, order, reserves, and exclusions without cross-config membership', () => {
    const { status, stdout, stderr } = run('--show-effective', '--platform', 'claude', '--level', 'high');
    assert.equal(status, 0, stderr);
    const report = JSON.parse(stdout);
    assert.match(report.configPath, /config\.jsonc$/);
    assert.equal(report.requestedLevel, 'high');
    assert.equal(report.effectiveLevel, 'high');
    assert.ok(report.inheritance['plan-review'].rounds.inheritedLevelKey);
    assert.ok(Array.isArray(report.candidateOrder['design-review']));
    assert.ok(Array.isArray(report.reserves['code-review']));
    assert.deepEqual(report.exclusions, []);
    assert.equal(report.crossConfigMembership, undefined);
  });

  it('--show-effective tolerates a missing write-subagent entry that the run path rejects', () => {
    const config = JSON.stringify({ 'read-delegates': { claude: { model: 'review-model', effort: 'medium' } } });
    const shown = withFixture({ config }, ['--show-effective', '--platform', 'claude']);
    assert.equal(shown.status, 0, shown.stderr);
    const report = JSON.parse(shown.stdout);
    assert.equal(report.implementation.diagnostic.key, 'write-subagents.claude');
    const ordinary = withFixture({ config }, ['--platform', 'claude']);
    assert.equal(ordinary.status, 1);
    assert.match(ordinary.stderr, /write-subagents\.claude is not configured/);
  });

  it('--show-effective reports a selected missing write-subagent model without aborting', () => {
    const config = JSON.stringify({
      'read-delegates': { claude: { model: 'review-model', effort: 'medium' } },
      'write-subagents': { claude: { effort: 'high' } },
    });
    const shown = withFixture({ config }, ['--show-effective', '--platform', 'claude']);
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).implementation.diagnostic.key, 'write-subagents.claude.model');
    const ordinary = withFixture({ config }, ['--platform', 'claude']);
    assert.equal(ordinary.status, 1);
    assert.match(ordinary.stderr, /write-subagents\.claude\.model/);
  });

  it('refuses --show-effective with --validate-only', () => {
    const { status, stderr } = run('--show-effective', '--validate-only');
    assert.equal(status, 1);
    assert.match(stderr, /cannot be combined with: --show-effective/);
  });

  it('parses --pins in both forms', () => {
    const bogus = run('--platform=claude', '--pins=bogus,alsobogus');
    assert.equal(bogus.status, 1);
    assert.match(bogus.stderr, /Unrecognized pin key\(s\): bogus, alsobogus/);
    const all = run('--platform=claude', '--pins=all');
    assert.equal(all.status, 0, all.stderr);
    assert.ok(JSON.parse(all.stdout)['code-review'].targets.length > 0);
    const spaced = run('--platform', 'claude', '--pins', 'claude,agy');
    const equals = run('--platform=claude', '--pins=claude,agy');
    assert.equal(spaced.status, 0, spaced.stderr);
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

  it('keeps a configured named pin when its liveness probe fails', () => {
    const { status, stdout } = run('--platform', 'claude', '--pins', 'agy', {
      liveness: JSON.stringify({ claude: true, agy: false, copilot: false, opencode: false }),
    });
    assert.equal(status, 0);
    const flow = JSON.parse(stdout);
    assert.deepEqual(flow['code-review'].targets.map(t => t.platform), ['agy']);
    assert.ok(flow.diagnostics.unavailable.includes('agy'));
  });

  it('exits 1 when the liveness seam yields unparsable JSON', () => {
    const { status, stderr } = run('--platform', 'claude', { liveness: '{not json' });
    assert.equal(status, 1);
    assert.match(stderr, /liveness/i);
  });

  it('accepts --exclude and --exclude= forms equivalently', () => {
    const spaced = run('--platform', 'claude', '--level', 'high', '--exclude', 'copilot');
    const equals = run('--platform=claude', '--level=high', '--exclude=copilot');
    assert.equal(spaced.status, 0, spaced.stderr);
    const flow = JSON.parse(spaced.stdout);
    assert.deepEqual(flow.diagnostics.excluded, ['copilot']);
    assert.ok(flow['code-review'].targets.every((t) => t.platform !== 'copilot'));
    assert.deepEqual(flow, JSON.parse(equals.stdout));
  });

  it('rejects exclude and pin errors before probing, even when the liveness seam is broken', () => {
    const broken = { liveness: '{not json' };
    assert.match(run('--platform', 'claude', '--exclude', 'bogus', broken).stderr, /Unrecognized exclude key\(s\): bogus\. Valid keys: /);
    assert.match(run('--platform', 'claude', '--exclude', 'claudecode', broken).stderr, /Cannot exclude the orchestrator platform "claude"/);
    assert.match(run('--platform', 'claude', '--pins', '0', broken).stderr, /count pin must be an integer from 1 to/);
    assert.match(run('--platform', 'claude', '--pins', '2,claude', broken).stderr, /count or "all" pin must stand alone/);
  });

  it('refuses --exclude combined with --validate-only', () => {
    const { status, stderr } = run('--validate-only', '--exclude', 'copilot');
    assert.equal(status, 1);
    assert.match(stderr, /cannot be combined with: --exclude/);
  });

  it('resolves --pins=2 under the liveness env seam', () => {
    const { status, stdout, stderr } = run('--platform=claude', '--level=medium', '--pins=2');
    assert.equal(status, 0, stderr);
    const flow = JSON.parse(stdout);
    assert.equal(flow.diagnostics.targetCountPin, 2);
    assert.equal(flow['code-review'].targets.length, 2);
  });

  it('rejects an unknown --platform and accepts the claudecode alias', () => {
    assert.match(run('--platform', 'bogus', '--level', 'low').stderr, /Unknown platform "bogus"\. Valid platforms: .*claude/);
    const alias = run('--platform', 'claudecode', '--level', 'low');
    assert.equal(alias.status, 0, alias.stderr);
    assert.equal(JSON.parse(alias.stdout).implementation.platform, 'claude');
  });

  it('reports livenessSource "env-override" when the renamed seam supplies liveness', () => {
    const { status, stdout, stderr } = run('--platform', 'claude', '--level', 'low');
    assert.equal(status, 0, stderr);
    assert.equal(JSON.parse(stdout).diagnostics.livenessSource, 'env-override');
  });

  it('rejects the liveness payload when DISPATCH_TEST_MODE is absent', () => {
    defaultsFixture ??= buildFixture({ prefix: 'resolve-flow-defaults-' });
    const env = { ...process.env, DISPATCH_LIVENESS_JSON: ALL_LIVE };
    delete env.DISPATCH_TEST_MODE;
    const result = spawnSync(process.execPath, [path.join(defaultsFixture.skillDir, 'scripts', 'resolve-flow.mjs'), '--platform', 'claude', '--level', 'low'], {
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
      env,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DISPATCH_LIVENESS_JSON/);
    assert.match(result.stderr, /DISPATCH_TEST_MODE/);
    assert.doesNotMatch(result.stderr, /IMPLEMENT_DISPATCH_/);
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

  it('banners use [dispatch], never the retired skill name', () => {
    const { stderr } = run('--platform', 'bogus');
    assert.doesNotMatch(stderr, /implement-dispatch/);
  });
});

describe('resolve-flow CLI: invalid and v0.4 config', () => {
  const INVALID = JSON.stringify({ 'read-delegates': {}, phases: { 'code-review': { bogusKey: 1 } } });

  it('--validate-only and the run path exit 1 for an invalid config', () => {
    for (const args of [['--validate-only'], ['--platform', 'claude']]) {
      const { status, stderr } = withFixture({ config: INVALID }, args);
      assert.equal(status, 1, args.join(' '));
      assert.match(stderr, /Invalid config|unrecognized key|at least one platform/i);
    }
  });

  const V04_REVIEW = JSON.stringify({
    'plan-review': { maxRounds: { low: 1 }, targetCount: { low: 1 }, consensus: { low: false }, platforms: { claude: {} } },
    implementation: { platforms: { claude: { model: 'm' } } },
    'code-review': { maxRounds: { low: 1 }, targetCount: { low: 1 }, consensus: { low: false }, platforms: { claude: {} } },
  });

  const V04_DISPATCH = JSON.stringify({ platforms: { claude: { model: 'm' } } });

  function assertKeyMap(stderr) {
    assert.match(stderr, /targetCount\s*(→|->)\s*targets/);
    assert.match(stderr, /maxRounds\s*(→|->)\s*rounds/);
    assert.match(stderr, /implementation\s*(→|->)\s*write-subagents/);
    assert.match(stderr, /read-delegates/);
    assert.match(stderr, /the retired implement config/);
    assert.doesNotMatch(stderr, /implement-dispatch/);
  }

  it('rejects a v0.4 review-section config with the key-map diagnostic', () => {
    for (const args of [['--validate-only'], ['--platform', 'claude']]) {
      const { status, stdout, stderr } = withFixture({ config: V04_REVIEW }, args);
      assert.equal(status, 1, args.join(' '));
      assert.equal(stdout, '');
      assertKeyMap(stderr);
    }
  });

  it('rejects a v0.4 dispatch config with top-level platforms', () => {
    const { status, stderr } = withFixture({ config: V04_DISPATCH }, ['--validate-only']);
    assert.equal(status, 1);
    assertKeyMap(stderr);
  });

  it('rejects a valid v0.5 config when a sibling retired implement config exists', () => {
    const fixture = buildFixture();
    try {
      const sibling = path.join(fixture.dir, 'implement-dispatch');
      fs.mkdirSync(sibling, { recursive: true });
      fs.writeFileSync(path.join(sibling, 'config.local.jsonc'), V04_REVIEW);
      const { status, stderr } = runFixtureScript(fixture.skillDir, ['--validate-only']);
      assert.equal(status, 1);
      assert.match(stderr, /targetCount\s*(→|->)\s*targets/);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe('resolve-flow CLI: integrity manifest (dispatch skill root)', () => {
  it('exits 1 with the modified file listed when a hashed file drifts, and --help bypasses the gate', () => {
    const { dir, skillDir } = buildFixture({ prefix: 'resolve-flow-integrity-' });
    try {
      fs.writeFileSync(path.join(skillDir, 'skill-hashes.json'), JSON.stringify(generateSkillHashes(skillDir), null, 2) + '\n');
      fs.appendFileSync(path.join(skillDir, 'SKILL.md'), '\n<!-- tampered -->\n');

      const validation = runFixtureScript(skillDir, ['--validate-only']);
      assert.equal(validation.status, 1);
      assert.match(validation.stderr, /Skill file integrity check failed/);
      assert.match(validation.stderr, /SKILL\.md/);

      const platformRun = runFixtureScript(skillDir, ['--platform', 'claude']);
      assert.equal(platformRun.status, 1);
      assert.equal(platformRun.stdout, '');

      const help = runFixtureScript(skillDir, ['--help']);
      assert.equal(help.status, 0);
      assert.match(help.stdout, /Usage:/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns and proceeds (exit 0) when the manifest is absent', () => {
    const { dir, skillDir } = buildFixture({ prefix: 'resolve-flow-integrity-', manifest: 'remove' });
    try {
      const { status, stdout, stderr } = runFixtureScript(skillDir, ['--validate-only']);
      assert.equal(status, 0, stderr);
      assert.match(stdout, /Config is valid\./);
      assert.match(stderr, /integrity manifest.*not found/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
