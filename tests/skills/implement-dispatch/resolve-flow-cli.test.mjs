import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.join(REPO_ROOT, 'skills/implement-dispatch/scripts/resolve-flow.mjs');

/**
 * Runs the resolver CLI and returns `{ status, stdout, stderr }`.
 *
 * A real run reaches `defaultLiveness`, which shells out to the provider CLIs; one of
 * those probes blocking would otherwise wedge the suite with no diagnostic, so the
 * spawn is bounded and a timed-out run fails loudly instead of hanging.
 */
function run(...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
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
});
