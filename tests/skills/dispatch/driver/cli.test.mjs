// SC1: driver entry routing (`--run` / `--next`) through dispatch.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createStubDispatchFixture } from '../../../helpers/stub-dispatch-fixture.mjs';
import { makeGitRepo, parseAction, runDispatch, writePlan } from '../../../helpers/driver-harness.mjs';

const CONFIG = {
  'read-delegates': {
    agy: { targets: [{ low: { model: 'gemini-3.7-flash', effort: 'medium' } }] },
    opencode: { targets: [{ low: { model: 'opencode-go/glm-5.3-flash', effort: 'max' } }] },
  },
  phases: {
    'plan-review': { rounds: { medium: 1 }, targets: { medium: 1 }, consensus: { medium: false } },
    'code-review': { rounds: { medium: 1 }, targets: { medium: 1 }, consensus: { medium: false } },
  },
};

let fixture;
let repo;
before(() => {
  fixture = createStubDispatchFixture(CONFIG);
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
    const plan = writePlan(repo.dir, 'cli.md');
    const res = run(['--run', 'review', '--kind', 'plan', '--orchestrator', 'claude', '--', plan]);
    assert.equal(res.status, 0, res.stderr);
    const action = parseAction(res.stdout);
    assert.equal(action.action, 'launch');
    assert.ok(path.isAbsolute(action.stateFile));
    assert.equal(path.basename(path.dirname(path.dirname(action.stateFile))), 'runs', 'state file lives under its session run directory');
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
    const plan = writePlan(repo.dir, 'cli-next.md');
    const first = parseAction(run(['--run', 'review', '--orchestrator', 'claude', '--', plan]).stdout);
    // The wave was never run: the driver re-emits launch once with an error (envelope missing).
    const res = run(['--next', '--state', first.stateFile]);
    assert.equal(res.status, 0, res.stderr);
    const next = parseAction(res.stdout);
    assert.equal(next.stateFile, first.stateFile);
    assert.equal(next.action, 'launch');
    assert.equal(typeof next.error?.message, 'string');
  });

  it('accepts --input as inline JSON text and as @file', () => {
    const plan = writePlan(repo.dir, 'cli-input.md');
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

  it('--run design is available', () => {
    const res = run(['--run', 'design', '--orchestrator', 'claude', '--', 'build a thing']);
    assert.equal(res.status, 0, res.stderr);
    parseAction(res.stdout);
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
    const plan = writePlan(repo.dir, 'cli-corrupt.md');
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

describe('driver stop diagnostics', () => {
  const FATAL = /^\[dispatch driver\] (reply|state|fault): .+/m;
  const start = (name) => parseAction(run(['--run', 'review', '--kind', 'plan', '--orchestrator', 'claude', '--', writePlan(repo.dir, name)]).stdout);

  it('error kind reply: malformed --input exits 2 and leaves state bytes unchanged', () => {
    const first = start('kind-reply.md');
    const before = fs.readFileSync(first.stateFile);
    const res = run(['--next', '--state', first.stateFile, '--input', '{ not json']);
    assert.equal(res.status, 2);
    assert.equal(res.stdout.trim(), '');
    assert.match(res.stderr, /^\[dispatch driver\] reply: /m);
    assert.deepEqual(fs.readFileSync(first.stateFile), before);
  });

  it('error kind state: a stale advance lock names its recovery step', () => {
    const first = start('kind-state.md');
    const lock = `${path.resolve(first.stateFile)}.advance.lock`;
    fs.writeFileSync(lock, '');
    try {
      const res = run(['--next', '--state', first.stateFile]);
      assert.equal(res.status, 2);
      assert.equal(res.stdout.trim(), '');
      assert.match(res.stderr, /^\[dispatch driver\] state: .+ \| next: .+/m);
    } finally { fs.rmSync(lock, { force: true }); }
  });

  it('error kind fault: toError classifies untyped throws as fault', async () => {
    // Dynamic import keeps the file loadable while toError is absent, so each case fails on its own.
    const { toError } = await import('../../../../skills/dispatch/scripts/driver/actions.mjs');
    assert.equal(typeof toError, 'function', 'actions.mjs exports toError');
    assert.deepEqual(toError(new TypeError('boom')), { kind: 'fault', message: 'boom' });
  });

  it('error kind fault: corrupted phase data surfaces as a fault', () => {
    const first = start('kind-fault.md');
    const state = JSON.parse(fs.readFileSync(first.stateFile, 'utf8'));
    state.wave = 42;
    state.phase = { corrupted: true };
    fs.writeFileSync(first.stateFile, JSON.stringify(state));
    const res = run(['--next', '--state', first.stateFile]);
    assert.equal(res.status, 2, res.stdout);
    assert.equal(res.stdout.trim(), '');
    assert.match(res.stderr, /^\[dispatch driver\] fault: /m);
  });

  it('fatal line: a usage error without --state names reply and no state path', () => {
    const res = run(['--run', 'deploy', '--orchestrator', 'claude']);
    assert.equal(res.status, 2);
    assert.equal(res.stdout.trim(), '');
    assert.match(res.stderr, FATAL);
    assert.match(res.stderr, /^\[dispatch driver\] reply: /m);
    assert.doesNotMatch(res.stderr, /state: /);
  });

  it('error kind state: a missing state file without a sidecar names a next step', () => {
    const missing = path.join(fixture.dir, 'missing', 'state.json');
    const res = run(['--next', '--state', missing]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /^\[dispatch driver\] state: .+ \| next: .+ \| state: /m);
  });

  it('fatal line: a parse failure after --state still names the state path', () => {
    const res = run(['--next', '--state', 'some/state.json', '--bogus']);
    assert.equal(res.status, 2);
    assert.equal(res.stdout.trim(), '');
    assert.match(res.stderr, /^\[dispatch driver\] reply: .+ \| state: some\/state\.json$/m);
  });

  it('fatal line: --state=<path> survives a parse failure with its spaces intact', () => {
    const res = run(['--next', '--state=dir  two/state.json', '--bogus']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /^\[dispatch driver\] reply: .+ \| state: dir {2}two\/state\.json$/m);
  });

  it('fatal line: a flag-shaped --input value is not mistaken for --state', () => {
    const res = run(['--next', '--state', 'real.json', '--input', '--state=other.json', '--bogus']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /\| state: real\.json$/m);
  });

  it('error kind state: --drive returns a state-errored verify without rerunning it', async () => {
    const { drive } = await import('../../../../skills/dispatch/scripts/driver/drive.mjs');
    const stale = { v: 1, action: 'verify', argv: ['node', '-e', 'process.exit(9)'], stateFile: 'x', guidance: [], error: { kind: 'state', message: 'Plan changed.', next: 'return to plan-review' } };
    const result = await drive({ state: 'x', input: {} }, { advance: async () => stale, stderr: { write() { throw new Error('verify ran'); } } });
    assert.equal(result, stale);
  });

  it('error kind reply: --drive returns a re-emitted launch without relaunching it', async () => {
    const { drive } = await import('../../../../skills/dispatch/scripts/driver/drive.mjs');
    const rejected = { v: 1, action: 'launch', argv: ['node', '-e', 'process.exit(9)'], stateFile: 'x', guidance: [], error: { kind: 'reply', message: 'bad' } };
    const result = await drive({ state: 'x', input: {} }, { advance: async () => rejected, stderr: { write() { throw new Error('launch ran'); } } });
    assert.equal(result, rejected);
  });

  it('fatal line: a multiline argument stays on one stderr line', () => {
    const res = run(['--next', '--state', 'a.json', '--bogus\ninjected']);
    assert.equal(res.status, 2);
    assert.equal(res.stderr.trim().split('\n').length, 1, res.stderr);
    assert.match(res.stderr, FATAL);
  });

  it('error kind fault: --drive returns a faulted mechanical action without rerunning it', async () => {
    const { drive } = await import('../../../../skills/dispatch/scripts/driver/drive.mjs');
    const faulted = { v: 1, action: 'verify', argv: ['node', '-e', 'process.exit(9)'], stateFile: 'x', guidance: [], error: { kind: 'fault', message: 'boom' } };
    let advances = 0;
    const result = await drive({ state: 'x', input: {} }, { advance: async () => { advances++; return faulted; }, stderr: { write() { throw new Error('verify ran'); } } });
    assert.equal(result, faulted);
    assert.equal(advances, 1);
  });

  it('fatal line: a stale lock with --state names the state path', () => {
    const first = start('fatal-state.md');
    const lock = `${path.resolve(first.stateFile)}.advance.lock`;
    fs.writeFileSync(lock, '');
    try {
      const res = run(['--next', '--state', first.stateFile]);
      assert.equal(res.status, 2);
      assert.equal(res.stdout.trim(), '');
      assert.match(res.stderr, FATAL);
      assert.match(res.stderr, /^\[dispatch driver\] state: /m);
      assert.ok(res.stderr.includes(`state: ${first.stateFile}`), `names the state path:
${res.stderr}`);
    } finally { fs.rmSync(lock, { force: true }); }
  });
});
