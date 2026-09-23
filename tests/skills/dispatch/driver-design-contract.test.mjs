import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import { buildStubDispatchFixture } from './stub-dispatch-fixture.mjs';
import { makeGitRepo, runDispatch, runLaunch, parseAction, allProviders, report, PLAN_BODY } from './driver-harness.mjs';
import { appendEvent, ensureLedgerNamespace, governingHash, readLedger } from '../../../skills/dispatch/scripts/ledger.mjs';
import { resolveLedgerPath } from '../../../skills/dispatch/scripts/resolve-artifact-paths.mjs';
import { restoreEvidence } from '../../../skills/dispatch/scripts/driver/ordinary-state.mjs';
import { readRunState } from '../../../skills/dispatch/scripts/driver/state.mjs';

const config = { 'read-delegates': { agy: { model: 'gemini-3.7-flash', effort: 'medium' } }, phases: { 'design-review': { rounds: { medium: 1 }, targets: { medium: 1 }, consensus: { medium: false } } } };
const RUN = '11111111-1111-4111-8111-111111111111';
const at = '2026-09-22T00:00:00.000Z';
const oid = 'c'.repeat(40);
const state = `sha256:${'b'.repeat(64)}`;

function designBody() {
  return ['# Design', '', '## Context & Intent', 'x', '## Goals & Requirements', 'x', '## Increment Details', '### I01', '- Outcome: one', '- Scope: src/one.js', '- Non-scope: none', '- Observable behavior: one', '- Affected contracts: one', '- Validation: test one', '- Rollback boundary: one', '- Parallel safety: safe', '### I02', '- Outcome: two', '- Scope: src/two.js', '- Non-scope: none', '- Observable behavior: two', '- Affected contracts: two', '- Validation: test two', '- Rollback boundary: two', '- Parallel safety: safe', '## Final Integration', 'verify all', '## Architecture & Boundaries', 'A', '## Alternatives & Decisions', 'B', '## Risks, Security & Operations', 'C', '## Increment Dependency Graph', '| ID | Priority | Summary | Prerequisites | Paths |', '| --- | ---: | --- | --- | --- |', '| I01 | 1 | One | none | src/one.js |', '| I02 | 2 | Two | I01 | src/two.js |', '## Execution Status', 'Ready.', '## Review Findings & Resolutions', '*No reviews conducted yet.*', ''].join('\n');
}

function setupLedger(repo, { amendment = null, complete = false } = {}) {
  const designPath = path.join(repo.dir, '.scratch', 'plan', '2026-09-22-root-design.md');
  const source = designBody(); fs.writeFileSync(designPath, source);
  const hash = governingHash(source, { kind: 'design' }).hash;
  const ledgerPath = resolveLedgerPath({ slug: 'root', slugSource: 'explicit', repositoryRoot: repo.dir });
  ensureLedgerNamespace({ repoHash: ledgerPath.split(path.sep).at(-2), env: process.env });
  const start = { v: 2, type: 'run-start', runId: RUN, at, data: { governingPath: '.scratch/plan/2026-09-22-root-design.md', governingHash: hash, rootSlug: 'root', action: 'design', baseline: { commit: oid, repositoryState: state, dirtyPaths: [] } } };
  appendEvent(ledgerPath, start); appendEvent(ledgerPath, { v: 2, type: 'approval', runId: RUN, at, data: { governingHash: hash, decision: 'approved', actor: 'user' } }); appendEvent(ledgerPath, { v: 2, type: 'run-complete', runId: RUN, at, data: { result: 'design-approved-stop', evidenceRefs: ['design'] } });
  if (amendment) {
    const amendmentRun = '44444444-1111-4111-8111-111111111111';
    appendEvent(ledgerPath, { ...start, runId: amendmentRun });
    appendEvent(ledgerPath, { v: 2, type: 'amendment', runId: amendmentRun, at, data: { amendmentId: amendment, state: 'proposed', affectedIncrements: [] } });
  }
  if (complete) for (const id of ['I01', 'I02']) {
    const rid = `${id === 'I01' ? '22222222' : '33333333'}-1111-4111-8111-111111111111`;
    const data = { governingPath: start.data.governingPath, governingHash: hash, rootSlug: 'root', action: 'increment', baseline: start.data.baseline, design: { path: start.data.governingPath, revision: hash }, increment: { id, planPath: `.scratch/plan/root-${id.toLowerCase()}-plan.md`, walkthroughPath: `.scratch/plan/root-${id.toLowerCase()}-walkthrough.md`, planHash: hash } };
    appendEvent(ledgerPath, { v: 2, type: 'run-start', runId: rid, at, data });
    const task = { taskId: `${id}-task`, attemptBudget: 1, paths: [`src/${id.toLowerCase()}.js`], preState: state };
    appendEvent(ledgerPath, { v: 2, type: 'task-start', runId: rid, at, data: task }); appendEvent(ledgerPath, { v: 2, type: 'implementation-attempt', runId: rid, at, data: { taskId: task.taskId, attempt: 1, launch: 'full', target: { platform: 'opencode' }, terminalEnvelope: {}, evidence: ['done'], transition: 'verify' } }); appendEvent(ledgerPath, { v: 2, type: 'verification', runId: rid, at, data: { taskId: task.taskId, attempt: 1, result: 'pass', commandRefs: ['test'], transition: 'complete' } }); appendEvent(ledgerPath, { v: 2, type: 'task-complete', runId: rid, at, data: { taskId: task.taskId, paths: task.paths, head: oid, preState: state, resultState: state, diffHash: state } }); appendEvent(ledgerPath, { v: 2, type: 'run-complete', runId: rid, at, data: { result: 'complete', evidenceRefs: [] } });
  }
  return { designPath, ledgerPath, hash };
}
function withFixture(test) { const fixture = buildStubDispatchFixture(config); const repo = makeGitRepo(); try { return test(fixture, repo); } finally { fixture.cleanup(); repo.cleanup(); } }

describe('driver design contracts (SC1–SC5, SC7)', () => {
  it('RED-MATRIX SC1 | exposes design authoring as a schema-valid durable action', () => withFixture((fixture, repo) => {
    const res = runDispatch(fixture, ['--run', 'design', '--orchestrator', 'claude', '--', 'build a thing'], { cwd: repo.dir });
    assert.equal(res.status, 0, `SC1 design must be available: ${res.stderr}`);
    const action = parseAction(res.stdout);
    assert.equal(action.action, 'author');
    assert.match(action.template ?? '', /design/i);
    assert.ok(action.guidance.some(item => /design-approved-stop|durable.*next action/i.test(item)));
  }));

  it('RED-MATRIX SC2 | selects exactly I01 and creates canonical increment bindings', () => withFixture((fixture, repo) => {
    const { designPath } = setupLedger(repo);
    const res = runDispatch(fixture, ['--run', 'implement', '--orchestrator', 'claude', '--', designPath], { cwd: repo.dir });
    assert.equal(res.status, 0, `SC2 design implement must be available: ${res.stderr}`);
    const action = parseAction(res.stdout);
    assert.equal(action.incrementId, 'I01');
    assert.equal(action.planPath, path.join(repo.dir, '.scratch', 'plan', '2026-09-22-root-i01-driver-plan.md'));
    assert.equal(action.walkthroughPath, path.join(repo.dir, '.scratch', 'plan', '2026-09-22-root-i01-driver-walkthrough.md'));
    assert.ok(['author', 'launch'].includes(action.action), `expected selected-I01 entry action, got ${action.action}`);
  }));

  it('SC2 fresh increment author reply enters plan review under the design ledger', () => withFixture((fixture, repo) => {
    const { designPath, ledgerPath } = setupLedger(repo);
    const first = runDispatch(fixture, ['--run', 'implement', '--orchestrator', 'claude', '--', designPath], { cwd: repo.dir });
    assert.equal(first.status, 0, `SC2 author step must succeed: ${first.stderr}`);
    const authorAction = parseAction(first.stdout);
    assert.equal(authorAction.action, 'author');
    assert.equal(authorAction.incrementId, 'I01');
    fs.writeFileSync(authorAction.planPath, PLAN_BODY);
    const inputFile = path.join(fixture.dir, 'sc2-input.json');
    fs.writeFileSync(inputFile, JSON.stringify({ path: authorAction.planPath }));
    const second = runDispatch(fixture, ['--next', '--state', authorAction.stateFile, '--input', `@${inputFile}`], { cwd: repo.dir });
    assert.equal(second.status, 0, `SC2 author reply must not error: ${second.stderr}`);
    const nextAction = parseAction(second.stdout);
    assert.equal(nextAction.error, undefined, `expected no reply error, got: ${nextAction.error}`);
    assert.equal(nextAction.action, 'launch', 'expected the plan-review launch');
    const planHash = governingHash(fs.readFileSync(authorAction.planPath, 'utf8')).hash;
    let runState = readRunState(nextAction.stateFile);
    assert.equal(runState.governingHash, planHash);
    assert.equal(runState.ledgerPath, ledgerPath);
    // Drive plan review with CLEAN stub waves until the driver leaves the review phase.
    let action = nextAction;
    for (let step = 0; step < 20 && readRunState(action.stateFile).ordinary.phase === 'plan-review'; step++) {
      assert.equal(action.action, 'launch', `unexpected plan-review action: ${JSON.stringify(action)}`);
      if (!action.replyOnly) runLaunch(fixture, action.argv, { cwd: repo.dir, results: allProviders(report()) });
      const args = ['--next', '--state', action.stateFile];
      if (action.earlyFallbacks) { const file = path.join(fixture.dir, `sc2-launch-${step}.json`); fs.writeFileSync(file, JSON.stringify({ earlyFallbacks: [] })); args.push('--input', `@${file}`); }
      const res = runDispatch(fixture, args, { cwd: repo.dir });
      assert.equal(res.status, 0, `SC2 plan review step must succeed: ${res.stderr}`);
      action = parseAction(res.stdout);
      assert.equal(action.error, undefined, `plan review error: ${action.error}`);
    }
    runState = readRunState(action.stateFile);
    assert.ok(runState.ordinary.planReview, `plan review must settle: ${JSON.stringify(action)}`);
    assert.equal(runState.governingHash, planHash);
    assert.equal(runState.ledgerPath, ledgerPath);
  }));

  it('RED-MATRIX SC3 | refuses schemaVersion-1 evidence with wrong parent revision and increment ID', () => withFixture((fixture, repo) => { const { designPath, ledgerPath, hash } = setupLedger(repo); const walkthroughPath = designPath.replace(/\.md$/, '-walkthrough.md'); const write = (revision, incrementId) => fs.writeFileSync(walkthroughPath, ['','## Ordinary execution evidence','```json', JSON.stringify({ schemaVersion: 1, governingHash: revision, planPath: '.scratch/plan/2026-09-22-root-design.md', incrementId, ordinary: {} }), '```',''].join('\n')); write(`sha256:${'f'.repeat(64)}`, 'I01'); const base = { repoRoot: repo.dir, planPath: designPath, walkthroughPath, governingHash: hash, ledgerPath }; assert.throws(() => restoreEvidence(base), /does not bind this governing plan/i); write(hash, 'I99'); assert.throws(() => restoreEvidence({ ...base }), /increment.*ID|increment.*identity/i); }));

  it('RED-MATRIX SC4 | names amendment resolution and refuses before any production mutation', () => withFixture((fixture, repo) => {
    const { designPath, ledgerPath } = setupLedger(repo, { amendment: 'A01' });
    const before = { design: fs.readFileSync(designPath, 'utf8'), ledger: fs.readFileSync(ledgerPath, 'utf8'), source: fs.readFileSync(path.join(repo.dir, 'src', 'app.js'), 'utf8') };
    const res = runDispatch(fixture, ['--run', 'implement', '--orchestrator', 'claude', '--', designPath], { cwd: repo.dir });
    assert.equal(res.status, 0, `SC4 design implement must return a structured refusal: ${res.stderr}`);
    const action = parseAction(res.stdout);
    assert.equal(action.action, 'done');
    assert.equal(action.outcome, 'refused');
    assert.equal(action.nextAction, 'resolve-amendment:A01', JSON.stringify(action));
    assert.match(action.reason ?? action.summary ?? '', /amendment.*A01.*before.*production/i);
    assert.deepEqual({ design: fs.readFileSync(designPath, 'utf8'), ledger: fs.readFileSync(ledgerPath, 'utf8'), source: fs.readFileSync(path.join(repo.dir, 'src', 'app.js'), 'utf8') }, before);
  }));

  it('RED-MATRIX SC5 | enters final integration with exact terminal lifecycle contract', () => withFixture((fixture, repo) => {
    const { designPath, ledgerPath } = setupLedger(repo, { complete: true });
    const incrementArtifacts = ['2026-09-22-root-i01-driver-plan.md', '2026-09-22-root-i01-driver-walkthrough.md', '2026-09-22-root-i02-driver-plan.md', '2026-09-22-root-i02-driver-walkthrough.md'];
    for (const file of incrementArtifacts) fs.writeFileSync(path.join(repo.dir, '.scratch', 'plan', file), file);
    const res = runDispatch(fixture, ['--run', 'implement', '--orchestrator', 'claude', '--', designPath], { cwd: repo.dir });
    assert.equal(res.status, 0, `SC5 design implement must enter final integration: ${res.stderr}`);
    const action = parseAction(res.stdout);
    assert.equal(action.phase, 'final-integration');
    assert.ok(['verify', 'launch'].includes(action.action), `expected final-integration gate, got ${action.action}`);
    assert.deepEqual(action.lifecycle, {
      terminalEvent: { type: 'integration', result: 'pass', beforeRelocation: true },
      relocateAfterPass: [designPath, ...incrementArtifacts.map(file => path.join(repo.dir, '.scratch', 'plan', file)), path.join(repo.dir, '.scratch', 'plan', '2026-09-22-root-integration-walkthrough.md')],
      retain: [ledgerPath],
    });
    assert.equal(readLedger(ledgerPath).events.some(event => event.type === 'integration'), false, 'entry must not pre-record a passing integration');
    assert.ok(fs.existsSync(ledgerPath), 'ledger is retained at its exact OS-temp path');
  }));
});
