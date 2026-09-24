import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { buildStubDispatchFixture } from '../../../helpers/stub-dispatch.mjs';
import { drive, implementationOutcome, makeGitRepo, runDispatch, parseAction, PLAN_BODY } from '../../../helpers/driver-harness.mjs';
import { appendEvent, ensureLedgerNamespace, governingHash, readLedger } from '../../../../skills/dispatch/scripts/ledger/ledger.mjs';
import { foldSegments } from '../../../../skills/dispatch/scripts/ledger/events.mjs';
import { resolveLedgerPath } from '../../../../skills/dispatch/scripts/artifacts/resolve-paths.mjs';
import { readRunState } from '../../../../skills/dispatch/scripts/driver/state.mjs';

const levels = { low: 1, medium: 1, high: 1, xhigh: 1, max: 1 };
const config = {
  'read-delegates': { agy: { targets: [{ low: { model: 'gemini-3.7-flash', effort: 'medium' } }] } },
  'write-subagents': { claude: { low: { model: ['first-model'], effort: 'low' } } },
  phases: Object.fromEntries(['plan-review', 'code-review', 'design-review'].map(key => [key, { rounds: levels, targets: levels, consensus: Object.fromEntries(Object.keys(levels).map(level => [level, false])) }])),
};
const RUN = '11111111-1111-4111-8111-111111111111';
const at = '2026-09-22T00:00:00.000Z';
const DESIGN_REL = '.scratch/plan/2026-09-22-root-design.md';
const INCREMENT_PLAN = PLAN_BODY.replace('Changes: `src/app.js`', 'Changes: `src/app.js`, `tests/sample.test.mjs`').replace('#### [MODIFY] src/app.js', '#### [MODIFY] tests/sample.test.mjs\n\n- Add regression.\n\n#### [MODIFY] src/app.js');

function designBody() {
  const fields = (n) => [`- Outcome: ${n}`, '- Scope: src/app.js', '- Non-scope: none', `- Observable behavior: ${n}`, `- Affected contracts: ${n}`, `- Validation: test ${n}`, `- Rollback boundary: ${n}`, '- Parallel safety: safe'];
  return ['# Design', '', '## Context & Intent', 'x', '## Goals & Requirements', 'x', '## Increment Details', '### I01', ...fields('one'), '### I02', ...fields('two'), '## Final Integration', 'verify all', '## Architecture & Boundaries', 'A', '## Alternatives & Decisions', 'B', '## Risks, Security & Operations', 'C', '## Increment Dependency Graph', '| ID | Priority | Summary | Prerequisites | Paths |', '| --- | ---: | --- | --- | --- |', '| I01 | 1 | One | none | src/app.js |', '| I02 | 2 | Two | I01 | src/app.js |', '## Execution Status', 'Ready.', '## Review Findings & Resolutions', '*No reviews conducted yet.*', ''].join('\n');
}

const cleanup = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

// Approved design stopped at design-approved-stop; I02 depends on I01.
function setup() {
  const fixture = buildStubDispatchFixture(config), repo = makeGitRepo();
  cleanup.push(fixture.cleanup, repo.cleanup);
  fs.mkdirSync(path.join(repo.dir, 'tests'));
  fs.writeFileSync(path.join(repo.dir, 'tests/sample.test.mjs'), "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 1);\n");
  repo.git('add', 'tests'); repo.git('commit', '--no-gpg-sign', '-qm', 'baseline tests');
  const designPath = path.join(repo.dir, DESIGN_REL);
  const source = designBody(); fs.writeFileSync(designPath, source);
  const hash = governingHash(source, { kind: 'design' }).hash;
  const ledgerPath = resolveLedgerPath({ slug: 'root', slugSource: 'explicit', repositoryRoot: repo.dir });
  ensureLedgerNamespace({ repoHash: ledgerPath.split(path.sep).at(-2), env: process.env });
  const head = repo.git('rev-parse', 'HEAD').toString().trim();
  appendEvent(ledgerPath, { v: 2, type: 'run-start', runId: RUN, at, data: { governingPath: DESIGN_REL, governingHash: hash, rootSlug: 'root', action: 'design', baseline: { commit: head, repositoryState: `sha256:${'b'.repeat(64)}`, dirtyPaths: [] } } });
  appendEvent(ledgerPath, { v: 2, type: 'approval', runId: RUN, at, data: { governingHash: hash, decision: 'approved', actor: 'user' } });
  appendEvent(ledgerPath, { v: 2, type: 'run-complete', runId: RUN, at, data: { result: 'design-approved-stop', evidenceRefs: ['design'] } });
  return { fixture, repo, designPath, ledgerPath, hash, authored: null };
}

function policies(ctx) {
  const { repo } = ctx;
  return {
    author(action) {
      assert.equal(action.incrementId, 'I01', `unexpected increment author: ${JSON.stringify(action)}`);
      fs.writeFileSync(action.planPath, INCREMENT_PLAN);
      ctx.authored = { planPath: action.planPath, walkthroughPath: action.walkthroughPath };
      return { path: action.planPath };
    },
    askUser(action) {
      if (action.question === 'approval') return { answer: { decision: 'approved', governingHash: action.items[0].governingHash, testPaths: ['tests/sample.test.mjs'], reason: 'Approved increment plan.' } };
      if (action.question === 'opt-in') return { answer: 'none' };
      throw new Error(`Unexpected question ${action.question}: ${JSON.stringify(action)}`);
    },
    delegateWrite(action) {
      const testsOnly = action.fields.stage === 'tests-only';
      fs.writeFileSync(path.join(repo.dir, testsOnly ? 'tests/sample.test.mjs' : 'src/app.js'), testsOnly
        ? "import assert from 'node:assert/strict';\nimport { value } from '../src/app.js';\nassert.equal(value, 2);\n" : 'export const value = 2;\n');
      return { raw: JSON.stringify(implementationOutcome({ stage: testsOnly ? 'RED_READY' : 'COMPLETE', evidence: testsOnly ? ['RED-MATRIX SC1 | tests/sample.test.mjs | exit 1 test:sample'] : ['CRITERION SC1 | delivered value=2 | src/app.js'] })) };
    },
    verify(action) {
      return { results: action.commands.map(command => {
        const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ['--test', 'tests/sample.test.mjs'], { cwd: repo.dir, encoding: 'utf8', env });
        return { command, exit: result.status, evidence: result.stdout, identifiers: result.status ? ['test:sample'] : [], diagnostic: result.stderr, scopeHash: action.scopeHash, mutationEpoch: action.mutationEpoch };
      }) };
    },
  };
}

function runIncrement(ctx, { extraArgs = [], onAction } = {}) {
  return drive(ctx.fixture, { cwd: ctx.repo.dir, runArgs: ['implement', ...extraArgs, '--orchestrator', 'claude', '--', ctx.designPath], policy: policies(ctx),
    onAction(action, dctx) { assert.equal(action.error, undefined, `driver error at ${action.action}: ${action.error}`); onAction?.(action, dctx); } });
}

function incrementStarts(ctx) {
  const read = readLedger(ctx.ledgerPath);
  assert.equal(read.status, 'ok', `ledger must be readable: ${read.diagnostic}`);
  return { read, starts: read.events.filter(event => event.type === 'run-start' && event.data.action === 'increment') };
}

function completeI01(ctx) {
  const { done } = runIncrement(ctx);
  assert.equal(done.action, 'done');
  assert.equal(done.outcome, 'complete', JSON.stringify(done));
}

function assertOneCompletedI01Segment(ctx) {
  const { read, starts } = incrementStarts(ctx);
  assert.equal(starts.length, 1, 'exactly one increment segment');
  const [start] = starts;
  assert.equal(start.v, 2);
  assert.equal(start.data.governingPath, DESIGN_REL);
  assert.equal(start.data.rootSlug, 'root');
  assert.deepEqual(start.data.design, { path: DESIGN_REL, revision: ctx.hash });
  assert.equal(start.data.increment.id, 'I01');
  assert.equal(start.data.increment.planHash, governingHash(fs.readFileSync(ctx.authored.planPath, 'utf8')).hash);
  const terminal = read.events.filter(event => event.runId === start.runId).at(-1);
  assert.equal(terminal.type, 'run-complete');
  assert.equal(terminal.data.result, 'complete');
  assert.equal(foldSegments(read.events).length, 2, 'design segment plus one increment segment');
  return start;
}

describe('driver design increment segments', () => {
  it('SC1 fresh design increment completes one v2 increment segment', () => {
    const ctx = setup();
    completeI01(ctx);
    assertOneCompletedI01Segment(ctx);
    assert.ok(fs.existsSync(ctx.authored.planPath), 'increment plan retained in .scratch/plan');
    assert.ok(fs.existsSync(ctx.authored.walkthroughPath), 'increment walkthrough retained in .scratch/plan');
  });

  it('SC2 completed I01 selects I02 next', () => {
    const ctx = setup();
    completeI01(ctx);
    assertOneCompletedI01Segment(ctx);
    const res = runDispatch(ctx.fixture, ['--run', 'implement', '--orchestrator', 'claude', '--', ctx.designPath], { cwd: ctx.repo.dir });
    assert.equal(res.status, 0, res.stderr);
    const action = parseAction(res.stdout);
    assert.equal(action.error, undefined, action.error);
    assert.equal(action.action, 'author');
    assert.equal(action.incrementId, 'I02');
  });

  it('SC3 phases from code-review resumes the increment segment', () => {
    const ctx = setup();
    const STOP = new Error('stop-before-code-review');
    try {
      runIncrement(ctx, { onAction(action) {
        if (action.action === 'launch' && readRunState(action.stateFile).ordinary?.phase === 'code-review') { fs.rmSync(action.stateFile, { force: true }); throw STOP; }
      } });
      assert.fail('run must reach code review');
    } catch (error) { if (error !== STOP) throw error; }
    const before = incrementStarts(ctx).starts;
    assert.equal(before.length, 1, 'implementation must have bound one increment segment');
    const res = runDispatch(ctx.fixture, ['--run', 'implement', '--phases', 'from:code-review', '--orchestrator', 'claude', '--', ctx.designPath], { cwd: ctx.repo.dir });
    assert.equal(res.status, 0, res.stderr);
    const entry = parseAction(res.stdout);
    assert.equal(entry.error, undefined, entry.error);
    assert.equal(entry.action, 'launch', JSON.stringify(entry));
    assert.equal(entry.wave?.type, 'review');
    const entryState = readRunState(entry.stateFile);
    assert.equal(entryState.ordinary.phase, 'code-review');
    assert.equal(entryState.runId, before[0].runId, 'resumes the same increment segment');
    const { done } = runIncrement(ctx, { extraArgs: ['--phases', 'from:code-review'] });
    assert.equal(done.outcome, 'complete', JSON.stringify(done));
    assertOneCompletedI01Segment(ctx);
  });
});
