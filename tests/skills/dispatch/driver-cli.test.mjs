// SC1: driver entry routing (`--run` / `--next`) through dispatch.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildStubDispatchFixture } from './stub-dispatch-fixture.mjs';
import { makeGitRepo, parseAction, runDispatch, writePlan } from './driver-harness.mjs';

const CONFIG = {
  'read-delegates': {
    agy: { model: 'gemini-3.7-flash', effort: 'medium' },
    opencode: [{ model: 'opencode-go/glm-5.3-flash', effort: 'max' }],
  },
  phases: {
    'plan-review': { rounds: { medium: 1 }, targets: { medium: 1 }, consensus: { medium: false } },
    'code-review': { rounds: { medium: 1 }, targets: { medium: 1 }, consensus: { medium: false } },
    'design-review': { rounds: { medium: 1 }, targets: { medium: 1 }, consensus: { medium: false } },
  },
};

let fixture;
let repo;
before(() => {
  fixture = buildStubDispatchFixture(CONFIG);
  repo = makeGitRepo();
});
after(() => {
  fixture?.cleanup();
  repo?.cleanup();
});

const run = (args, opts = {}) => runDispatch(fixture, args, { cwd: repo.dir, ...opts });
const tmpRoot = () => fs.realpathSync(os.tmpdir());

describe('driver CLI (SC1)', () => {
  it('--run review prints exactly one compact JSON action carrying v, action, and stateFile', () => {
    const plan = writePlan(repo.dir, '2026-09-22-cli.md');
    const res = run(['--run', 'review', '--kind', 'plan', '--orchestrator', 'claude', '--', plan]);
    assert.equal(res.status, 0, res.stderr);
    const action = parseAction(res.stdout);
    assert.equal(action.action, 'launch');
    assert.ok(path.isAbsolute(action.stateFile));
    assert.equal(path.basename(path.dirname(action.stateFile)), 'dispatch-driver');
    assert.ok(fs.realpathSync(action.stateFile).startsWith(tmpRoot()), 'state file lives under os.tmpdir()');
    assert.match(path.basename(action.stateFile), /\.json$/);
    const sidecar = action.stateFile.replace(/\.json$/, '.run.json');
    assert.ok(fs.existsSync(sidecar), 'run sidecar is written next to the state file');
    const invocation = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    for (const key of ['verb', 'kind', 'argument', 'fix', 'orchestrator', 'orchestratorModel', 'level', 'levelSource', 'pins']) {
      assert.ok(key in invocation, `sidecar records ${key}`);
    }
    assert.equal(invocation.verb, 'review');
    assert.equal(invocation.kind, 'plan');
    assert.equal(invocation.orchestrator, 'claude');
    assert.equal(invocation.fix, false);
    assert.equal(invocation.level, 'medium');
    assert.equal(invocation.levelSource, 'default');
  });

  it('--next with an empty launch reply prints exactly one action for the same state file', () => {
    const plan = writePlan(repo.dir, '2026-09-22-cli-next.md');
    const first = parseAction(run(['--run', 'review', '--orchestrator', 'claude', '--', plan]).stdout);
    // The wave was never run: the driver re-emits launch once with an error (envelope missing).
    const res = run(['--next', '--state', first.stateFile]);
    assert.equal(res.status, 0, res.stderr);
    const next = parseAction(res.stdout);
    assert.equal(next.stateFile, first.stateFile);
    assert.equal(next.action, 'launch');
    assert.equal(typeof next.error, 'string');
  });

  it('accepts --input as inline JSON text and as @file', () => {
    const plan = writePlan(repo.dir, '2026-09-22-cli-input.md');
    const first = parseAction(run(['--run', 'review', '--orchestrator', 'claude', '--', plan]).stdout);
    const inline = run(['--next', '--state', first.stateFile, '--input', '{}']);
    assert.equal(inline.status, 0, inline.stderr);
    parseAction(inline.stdout);
    const file = path.join(fixture.dir, 'launch-reply.json');
    fs.writeFileSync(file, 'null');
    const second = parseAction(run(['--run', 'review', '--orchestrator', 'claude', '--', plan]).stdout);
    const viaFile = run(['--next', '--state', second.stateFile, '--input', `@${file}`]);
    assert.equal(viaFile.status, 0, viaFile.stderr);
    parseAction(viaFile.stdout);
  });

  for (const verb of ['plan', 'implement']) {
    it(`--run ${verb} is available`, () => {
      const res = run(['--run', verb, '--orchestrator', 'claude', '--', 'build a thing']);
      assert.equal(res.status, 0, res.stderr);
      parseAction(res.stdout);
    });
  }

  it('--run design remains unavailable until I05', () => {
    const res = run(['--run', 'design', '--orchestrator', 'claude', '--', 'build a thing']);
    assert.equal(res.status, 2);
    assert.equal(res.stdout.trim(), '');
    assert.match(res.stderr, /not available until v0\.5 I05/);
  });

  it('rejects an unknown verb, a missing --orchestrator, and --phases on review with exit 2', () => {
    for (const args of [
      ['--run', 'deploy', '--orchestrator', 'claude'],
      ['--run', 'review'],
      ['--run', 'review', '--phases', 'from:code-review', '--orchestrator', 'claude'],
    ]) {
      const res = run(args);
      assert.equal(res.status, 2, `${args.join(' ')} → ${res.stdout}`);
      assert.equal(res.stdout.trim(), '');
      assert.ok(res.stderr.trim().length > 0);
    }
  });

  it('--next without --state, or with a missing state file, exits 2', () => {
    assert.equal(run(['--next']).status, 2);
    const missing = path.join(tmpRoot(), 'dispatch-driver', 'no-such-run.json');
    const res = run(['--next', '--state', missing]);
    assert.equal(res.status, 2);
    assert.equal(res.stdout.trim(), '');
  });

  it('names the resuming --run command when the state file is corrupt', () => {
    const plan = writePlan(repo.dir, '2026-09-22-cli-corrupt.md');
    const first = parseAction(run(['--run', 'review', '--kind', 'plan', '--orchestrator', 'claude', '--', plan]).stdout);
    fs.writeFileSync(first.stateFile, '{ not json');
    const res = run(['--next', '--state', first.stateFile]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--run review/);
    assert.match(res.stderr, /--kind plan/);
    assert.match(res.stderr, /--orchestrator claude/);
    assert.ok(res.stderr.includes(path.basename(plan)), 'names the argument');
  });

  it('a positional prompt that begins with "run" still dispatches as ask', () => {
    const res = runDispatch(fixture, ['--orchestrator', 'claude', 'run the review please'], {
      cwd: repo.dir,
      results: { agy: { stdout: 'ASK-OK' }, opencode: { stdout: 'ASK-OK' } },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /ASK-OK/);
    assert.doesNotMatch(res.stdout, /"stateFile"/);
  });

  it('--help lists the driver flags', () => {
    const res = run(['--help']);
    for (const flag of ['--run', '--next', '--state', '--input', '--kind', '--fix', '--phases', '--verbose']) {
      assert.ok(res.stdout.includes(flag) || res.stderr.includes(flag), `--help lists ${flag}`);
    }
  });
});
