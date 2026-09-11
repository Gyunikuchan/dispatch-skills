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
    const { status, stderr } = run('--slug', 'auth-v2');
    assert.equal(status, 1);
    assert.match(stderr, /--platform is required/);
  });

  it('requires --slug', () => {
    const { status, stderr } = run('--platform', 'claude');
    assert.equal(status, 1);
    assert.match(stderr, /--slug is required/);
  });

  it('rejects a non-kebab-case slug', () => {
    const { status, stderr } = run('--platform', 'claude', '--slug', 'Auth_V2');
    assert.equal(status, 1);
    assert.match(stderr, /must be kebab-case/);
  });

  it('rejects a slug containing path separators', () => {
    const { status, stderr } = run('--platform', 'claude', '--slug', '../evil');
    assert.equal(status, 1);
    assert.match(stderr, /must be kebab-case/);
  });

  it('rejects a malformed date', () => {
    const { status, stderr } = run('--platform', 'claude', '--slug', 'auth-v2', '--date', '2026-9-1');
    assert.equal(status, 1);
    assert.match(stderr, /valid calendar date/);
  });

  it('rejects a date that is not on the calendar', () => {
    const { status, stderr } = run('--platform', 'claude', '--slug', 'auth-v2', '--date', '2026-02-30');
    assert.equal(status, 1);
    assert.match(stderr, /valid calendar date/);
  });

  it('rejects an unrecognized argument', () => {
    const { status, stderr } = run('--platform', 'claude', '--slug', 'auth-v2', '--rounds', '3');
    assert.equal(status, 1);
    assert.match(stderr, /Unrecognized argument "--rounds"/);
  });

  it('rejects a flag with a missing value', () => {
    const { status, stderr } = run('--platform', '--slug', 'auth-v2');
    assert.equal(status, 1);
    assert.match(stderr, /Missing value for --platform/);
  });

  it('rejects an unknown level', () => {
    const { status, stderr } = run('--platform', 'claude', '--slug', 'auth-v2', '--level', 'ultra');
    assert.equal(status, 1);
    assert.match(stderr, /Unknown level "ultra"/);
  });

  it('emits the dated artifact paths for a valid run', () => {
    const { status, stdout } = run(
      '--platform', 'claude',
      '--slug', 'auth-v2',
      '--date', '2026-09-10',
      '--level', 'low'
    );
    assert.equal(status, 0);
    const flow = JSON.parse(stdout);
    assert.equal(flow.paths.plan, '.scratch/plan/2026-09-10-auth-v2.md');
    assert.equal(flow.paths.walkthrough, '.scratch/plan/2026-09-10-auth-v2-walkthrough.md');
    assert.equal(flow.diagnostics.effectiveLevel, 'low');
  });

  it('accepts --flag=value form equivalently to space-separated flags', () => {
    const { status, stdout } = run(
      '--platform=claude',
      '--slug=auth-v2',
      '--date=2026-09-10',
      '--level=low'
    );
    assert.equal(status, 0);
    const flow = JSON.parse(stdout);
    assert.equal(flow.paths.plan, '.scratch/plan/2026-09-10-auth-v2.md');
    assert.equal(flow.diagnostics.effectiveLevel, 'low');
  });

  it('parses --pins=key,key in --flag=value form (proven via the unrecognized-pin error path, to stay independent of real provider liveness)', () => {
    const { status, stderr } = run(
      '--platform=claude',
      '--slug=auth-v2',
      '--pins=bogus,alsobogus'
    );
    assert.equal(status, 1);
    assert.match(stderr, /Unrecognized pin key\(s\): bogus, alsobogus/);
  });

  it('rejects an unrecognized --flag=value argument', () => {
    const { status, stderr } = run('--platform', 'claude', '--slug', 'auth-v2', '--rounds=3');
    assert.equal(status, 1);
    assert.match(stderr, /Unrecognized argument "--rounds"/);
  });
});
