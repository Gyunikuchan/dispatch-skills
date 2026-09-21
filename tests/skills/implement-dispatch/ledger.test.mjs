import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  appendEvent,
  breakStaleLock,
  ensureLedgerNamespace,
  governingHash,
  readLedger,
  repairTornTail,
  resumeOrdinary,
  resumeDesign,
  designRootSlug,
  slugFromPlanPath,
} from '../../../skills/implement-dispatch/scripts/ledger.mjs';
import { materializedFingerprint } from '../../../skills/implement-dispatch/scripts/git-state.mjs';

const runId = '11111111-1111-4111-8111-111111111111';
const state = `sha256:${'b'.repeat(64)}`;
const oid = 'c'.repeat(40);
const at = '2026-09-20T00:00:00.000Z';

function runStart(hash, plan = '.scratch/plan/2026-09-20-example.md') {
  return {
    v: 1, type: 'run-start', runId, at,
    data: {
      governingPath: plan, governingHash: hash, rootSlug: 'example', action: 'ordinary',
      baseline: { commit: oid, repositoryState: state, dirtyPaths: [] },
    },
  };
}

describe('ledger I/O and resume', () => {
  let tempRoot;
  let repo;
  let ledgerPath;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-io-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-repo-'));
    const git = spawnSync('git', ['init', '--quiet', '--initial-branch=work'], { cwd: repo, encoding: 'utf8' });
    assert.equal(git.status, 0);
    const directory = ensureLedgerNamespace({
      tempRoot,
      repoHash: 'abcdef123456',
      env: { USER: 'test/user' },
    });
    ledgerPath = path.join(directory, 'example-ledger.md');
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('creates private directories and appends sequential durable rows', () => {
    const plan = '# Plan\n\nBody\n';
    const hash = governingHash(plan).hash;
    const first = appendEvent(ledgerPath, runStart(hash));
    const second = appendEvent(ledgerPath, {
      v: 1, type: 'approval', runId, at,
      data: { governingHash: hash, decision: 'approved', actor: 'user' },
    });
    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    const final = readLedger(ledgerPath);
    assert.equal(final.status, 'ok', final.diagnostic);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.dirname(ledgerPath)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(ledgerPath).mode & 0o777, 0o600);
    }
  });

  it('reports a torn tail without mutation and repairs it explicitly', () => {
    const hash = governingHash('# Plan\n\nBody\n').hash;
    appendEvent(ledgerPath, runStart(hash));
    appendEvent(ledgerPath, {
      v: 1, type: 'approval', runId, at,
      data: { governingHash: hash, decision: 'approved', actor: 'user' },
    });
    fs.appendFileSync(ledgerPath, '- event: {"torn"');
    const before = fs.readFileSync(ledgerPath);
    const inspected = readLedger(ledgerPath);
    assert.equal(inspected.status, 'needs-reconciliation');
    assert.deepEqual(fs.readFileSync(ledgerPath), before);
    assert.throws(() => appendEvent(ledgerPath, {
      v: 1, type: 'ruling', runId, at,
      data: {
        key: 'reconciliation', decision: 'accept-repair', reason: 'Not repaired yet.',
        costIfWrong: 'n/a', state: 'resolved',
      },
    }), /append refused/);
    assert.deepEqual(fs.readFileSync(ledgerPath), before);
    const repaired = repairTornTail(ledgerPath);
    assert.equal(repaired.repaired, true);
    assert.equal(readLedger(ledgerPath).status, 'needs-reconciliation');
    appendEvent(ledgerPath, {
      v: 1, type: 'ruling', runId, at,
      data: {
        key: 'reconciliation', decision: 'accept-repair', reason: 'Torn bytes recorded.',
        costIfWrong: 'n/a', state: 'resolved',
      },
    });
    const final = readLedger(ledgerPath);
    assert.equal(final.status, 'ok', final.diagnostic);
  });

  it('treats a malformed newline-terminated final line as a torn tail', () => {
    const hash = governingHash('# Plan\n\nBody\n').hash;
    appendEvent(ledgerPath, runStart(hash));
    fs.appendFileSync(ledgerPath, '- event: {"torn"\n');
    const inspected = readLedger(ledgerPath);
    assert.equal(inspected.issue, 'torn-tail');
    assert.equal(repairTornTail(ledgerPath).repaired, true);
    assert.equal(readLedger(ledgerPath).issue, 'reconciliation');
  });

  it('repairs a tear immediately after run-start without making the segment unfoldable', () => {
    const hash = governingHash('# Plan\n\nBody\n').hash;
    appendEvent(ledgerPath, runStart(hash));
    fs.appendFileSync(ledgerPath, '{"partial"');
    assert.equal(repairTornTail(ledgerPath).repaired, true);
    const repaired = readLedger(ledgerPath);
    assert.equal(repaired.status, 'needs-reconciliation');
    assert.equal(repaired.issue, 'reconciliation');
  });

  it('starts a fresh reconciliation segment when the torn tail follows run-complete', () => {
    const hash = governingHash('# Plan\n\nBody\n').hash;
    appendEvent(ledgerPath, runStart(hash));
    appendEvent(ledgerPath, {
      v: 1, type: 'approval', runId, at,
      data: { governingHash: hash, decision: 'approved', actor: 'user' },
    });
    appendEvent(ledgerPath, {
      v: 1, type: 'run-complete', runId, at,
      data: { result: 'complete', evidenceRefs: ['test'] },
    });
    fs.appendFileSync(ledgerPath, '- event: {"partial"');
    assert.equal(repairTornTail(ledgerPath).repaired, true);
    const repaired = readLedger(ledgerPath);
    assert.equal(repaired.issue, 'reconciliation');
    const newRunId = repaired.events.at(-1).runId;
    appendEvent(ledgerPath, {
      v: 1, type: 'ruling', runId: newRunId, at,
      data: {
        key: 'reconciliation', decision: 'accept-repair', reason: 'Reviewed.',
        costIfWrong: 'n/a', state: 'resolved',
      },
    });
    assert.equal(readLedger(ledgerPath).status, 'ok');
  });

  it('leaves a torn-only ledger byte-identical when repair cannot establish a run', () => {
    fs.writeFileSync(ledgerPath, '- event: {"partial"');
    if (process.platform !== 'win32') fs.chmodSync(ledgerPath, 0o600);
    const before = fs.readFileSync(ledgerPath);
    assert.throws(() => repairTornTail(ledgerPath), /no valid run-start/);
    assert.deepEqual(fs.readFileSync(ledgerPath), before);
  });

  it('rejects hostile namespace components and escalates as a hard error', () => {
    const hostileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-hostile-'));
    try {
      const namespace = path.join(hostileRoot, 'dispatch-skills-test');
      fs.mkdirSync(namespace, { mode: 0o777 });
      if (process.platform !== 'win32') {
        fs.chmodSync(namespace, 0o777);
        assert.throws(() => ensureLedgerNamespace({
          tempRoot: hostileRoot, repoHash: 'abcdef123456', env: { USER: 'test' },
        }), /writable/);
      }
      fs.rmSync(namespace, { recursive: true, force: true });
      fs.symlinkSync(repo, namespace);
      assert.throws(() => ensureLedgerNamespace({
        tempRoot: hostileRoot, repoHash: 'abcdef123456', env: { USER: 'test' },
      }), /Unsafe ledger directory/);
    } finally {
      fs.rmSync(hostileRoot, { recursive: true, force: true });
    }
  });

  it('rejects concurrent writers and explicitly breaks only a dead-holder lock', () => {
    fs.writeFileSync(`${ledgerPath}.lock`, JSON.stringify({ pid: 99999999, createdAt: at, nonce: 'x' }));
    assert.throws(() => appendEvent(ledgerPath, runStart(state)), /lock is held/);
    assert.equal(breakStaleLock(ledgerPath, { kill: () => { const error = new Error('dead'); error.code = 'ESRCH'; throw error; } }), true);
    assert.equal(appendEvent(ledgerPath, runStart(state)).seq, 1);
    fs.writeFileSync(`${ledgerPath}.lock`, JSON.stringify({ pid: process.pid, createdAt: at, nonce: 'x' }));
    assert.throws(() => breakStaleLock(ledgerPath, { kill: () => {} }), /still alive/);
  });

  it('revalidates namespace components before every append', () => {
    const hostileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-parent-'));
    try {
      const userRoot = path.join(hostileRoot, 'dispatch-skills-test');
      fs.mkdirSync(userRoot, { mode: 0o700 });
      const repoLink = path.join(userRoot, 'abcdef123456');
      fs.symlinkSync(repo, repoLink);
      assert.throws(() => appendEvent(path.join(repoLink, 'example-ledger.md'), runStart(state)), /Unsafe ledger directory/);
    } finally {
      fs.rmSync(hostileRoot, { recursive: true, force: true });
    }
  });

  it('refuses to repair a symlinked ledger file', () => {
    const target = path.join(tempRoot, 'target.txt');
    fs.writeFileSync(target, 'do not truncate');
    fs.symlinkSync(target, ledgerPath);
    assert.throws(() => repairTornTail(ledgerPath), /Unsafe ledger file/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'do not truncate');
  });

  it('derives only canonical scratch plan slugs', () => {
    assert.equal(slugFromPlanPath('.scratch/plan/2026-09-20-v0-4-phase2.md'), 'v0-4-phase2');
    assert.throws(() => slugFromPlanPath('.scratch/plan/2026-09-20-v0-4-phase2-walkthrough.md'), /must match/);
    assert.throws(() => slugFromPlanPath('/native/implementation_plan.md'), /must match/);
  });

  it('normalizes Windows design paths and rejects reserved roots', () => {
    assert.equal(designRootSlug('.scratch\\plan\\2026-09-20-platform-design.md'), 'platform');
    assert.equal(designRootSlug('.scratch/plan/2026-09-20-root-i01-one-design.md'), null);
    assert.equal(designRootSlug('.scratch/plan/2026-09-20-root-integration-design.md'), null);
  });

  it('requires artifact and ledger approval revisions for design resume', () => {
    const designPath = '.scratch/plan/2026-09-20-example-design.md';
    const source = '# Design\n\n## Architecture\nA\n\n## Execution Status\nReady\n';
    const hash = governingHash(source, { kind: 'design' }).hash;
    const designRunId = '22222222-2222-4222-8222-222222222222';
    const events = [
      { ...runStart(hash, designPath), v: 2, runId: designRunId, data: { ...runStart(hash, designPath).data, action: 'design' } },
      { v: 2, type: 'approval', runId: designRunId, at, data: { governingHash: hash, decision: 'approved', actor: 'user' } },
      { v: 2, type: 'run-complete', runId: designRunId, at, data: { result: 'design-approved-stop', evidenceRefs: ['design'] } },
    ];
    for (const event of events) appendEvent(ledgerPath, event);
    const metadata = { approvedContentHash: hash };
    assert.equal(resumeDesign({ ledgerPath, planPath: designPath, planSource: { source, metadata }, repoRoot: repo }).status, 'resumable');
    assert.equal(resumeDesign({ ledgerPath, planPath: designPath, planSource: { source, metadata: { approvedContentHash: state } }, repoRoot: repo }).status, 'needs-reconciliation');
  });

  it('rejects increment-shaped plans as ordinary resume artifacts', () => {
    assert.throws(() => slugFromPlanPath('.scratch/plan/2026-09-20-root-i01-model-plan.md'), /reserved for phased artifacts/);
  });

  it('blocks approval-less and aborted design segments', () => {
    const designPath = '.scratch/plan/2026-09-20-example-design.md';
    const source = '# Design\n\nBody\n';
    const hash = governingHash(source, { kind: 'design' }).hash;
    const metadata = { approvedContentHash: hash };
    const designRunId = '22222222-2222-4222-8222-222222222222';
    appendEvent(ledgerPath, { ...runStart(hash, designPath), v: 2, runId: designRunId, data: { ...runStart(hash, designPath).data, action: 'design' } });
    const resumed = resumeDesign({ ledgerPath, planPath: designPath, planSource: { source, metadata }, repoRoot: repo });
    assert.equal(resumed.status, 'needs-reconciliation');
    assert.match(resumed.diagnostic, /No matching design segment|not an approved durable stop/);
  });

  it('maps strict governing-plan scan failures to reconciliation', () => {
    assert.equal(governingHash('# Plan\n\n```js\nunterminated').status, 'needs-reconciliation');
  });

  it('resumes after RED without repeating tests-only and preserves completion after commit', () => {
    fs.writeFileSync(path.join(repo, 'done.txt'), 'done\n');
    const planPath = '.scratch/plan/2026-09-20-example.md';
    const plan = '# Plan\n\nBody\n';
    const hash = governingHash(plan).hash;
    const resultState = materializedFingerprint(repo, ['done.txt']).digest;
    const events = [
      runStart(hash, planPath),
      { v: 1, type: 'approval', runId, at, data: { governingHash: hash, decision: 'approved', actor: 'user' } },
      { v: 1, type: 'task-start', runId, at, data: { taskId: 'done', attemptBudget: 1, paths: ['done.txt'], preState: state } },
      { v: 1, type: 'implementation-attempt', runId, at, data: { taskId: 'done', attempt: 1, launch: 'full', target: { platform: 'copilot' }, terminalEnvelope: {}, evidence: ['done'], transition: 'verify' } },
      { v: 1, type: 'verification', runId, at, data: { taskId: 'done', attempt: 1, result: 'pass', commandRefs: ['test'], transition: 'complete' } },
      { v: 1, type: 'task-complete', runId, at, data: { taskId: 'done', paths: ['done.txt'], head: oid, preState: state, resultState, diffHash: state } },
      { v: 1, type: 'task-start', runId, at, data: { taskId: 'active', attemptBudget: 2, paths: ['active.txt'], preState: state } },
      { v: 1, type: 'implementation-attempt', runId, at, data: { taskId: 'active', attempt: 1, launch: 'tests-only', target: { platform: 'copilot' }, terminalEnvelope: {}, evidence: ['red'], transition: 'run-red' } },
      { v: 1, type: 'verification', runId, at, data: { taskId: 'active', attempt: 1, result: 'red', failureIdentity: { id: 'expected' }, commandRefs: ['test'], transition: 'continue' } },
    ];
    for (const event of events) appendEvent(ledgerPath, event);
    const resumed = resumeOrdinary({ ledgerPath, planPath, planSource: plan, repoRoot: repo });
    assert.equal(resumed.status, 'resumable');
    assert.equal(resumed.nextAction, 'continuation');
    assert.deepEqual(resumed.completedTaskIds, ['done']);
    assert.equal(resumed.requiresFlowConfirmation, true);
  });

  it('returns explicit missing and mismatched ledger states', () => {
    const planPath = '.scratch/plan/2026-09-20-example.md';
    const plan = '# Plan\n\nBody\n';
    assert.equal(resumeOrdinary({ ledgerPath, planPath, planSource: plan, repoRoot: repo }).status, 'missing');
    appendEvent(ledgerPath, runStart(`sha256:${'d'.repeat(64)}`, planPath));
    assert.equal(resumeOrdinary({ ledgerPath, planPath, planSource: plan, repoRoot: repo }).status, 'needs-reconciliation');
  });

  describe('design-run resume across segments', () => {
    const designPath = '.scratch/plan/2026-09-20-demo-design.md';
    const designBody = [
      '# Design',
      '',
      '## Architecture',
      'A',
      '## Increment Dependency Graph',
      '| ID | Priority | Summary | Prerequisites | Paths |',
      '| --- | ---: | --- | --- | --- |',
      '| I01 | 1 | one | none | a |',
      '| I02 | 2 | two | I01 | b |',
      '',
      '## Execution Status',
      'Ready',
      '',
    ].join('\n');
    const designHash = governingHash(designBody, { kind: 'design' }).hash;
    const designRunId = '22222222-2222-4222-8222-222222222222';
    const designEvents = [
      { ...runStart(designHash, designPath), v: 2, runId: designRunId, data: { ...runStart(designHash, designPath).data, action: 'design' } },
      { v: 2, type: 'approval', runId: designRunId, at, data: { governingHash: designHash, decision: 'approved', actor: 'user' } },
      { v: 2, type: 'run-complete', runId: designRunId, at, data: { result: 'design-approved-stop', evidenceRefs: ['design'] } },
    ];
    const designMetadata = { approvedContentHash: designHash };

    function incrementRunStart(id, slug, segmentRunId) {
      return {
        v: 2, type: 'run-start', runId: segmentRunId, at,
        data: {
          governingPath: designPath,
          governingHash: designHash,
          rootSlug: 'example',
          action: 'increment',
          baseline: { commit: oid, repositoryState: state, dirtyPaths: [] },
          design: { path: designPath, revision: designHash },
          increment: {
            id, planPath: `.scratch/plan/2026-09-20-example-${slug}-plan.md`,
            walkthroughPath: `.scratch/plan/2026-09-20-example-${slug}-walkthrough.md`,
            planHash: designHash,
          },
        },
      };
    }

    it('selects the next ready increment by priority after a completed increment segment', () => {
      const incrementRunId = '33333333-3333-4333-8333-333333333333';
      const events = [
        ...designEvents,
        incrementRunStart('I01', 'one', incrementRunId),
        ...completedIncrement('I01', incrementRunId),
        { v: 2, type: 'run-complete', runId: incrementRunId, at, data: { result: 'complete', evidenceRefs: [] } },
      ];
      for (const event of events) appendEvent(ledgerPath, event);
      const resumed = resumeDesign({ ledgerPath, planPath: designPath, planSource: { source: designBody, metadata: designMetadata }, repoRoot: repo });
      assert.equal(resumed.status, 'resumable');
      assert.equal(resumed.nextAction, 'implement:I02');
    });

    it('resumes an interrupted increment segment', () => {
      const incrementRunId = '33333333-3333-4333-8333-333333333333';
      const events = [
        ...designEvents,
        incrementRunStart('I01', 'one', incrementRunId),
        { v: 2, type: 'task-start', runId: incrementRunId, at, data: { taskId: 'I01-task', attemptBudget: 2, paths: ['a.txt'], preState: state } },
        { v: 2, type: 'implementation-attempt', runId: incrementRunId, at, data: { taskId: 'I01-task', attempt: 1, launch: 'tests-only', target: { platform: 'opencode' }, terminalEnvelope: {}, evidence: ['red'], transition: 'run-red' } },
        { v: 2, type: 'verification', runId: incrementRunId, at, data: { taskId: 'I01-task', attempt: 1, result: 'red', failureIdentity: { id: 'expected' }, commandRefs: ['test'], transition: 'continue' } },
      ];
      for (const event of events) appendEvent(ledgerPath, event);
      const resumed = resumeDesign({ ledgerPath, planPath: designPath, planSource: { source: designBody, metadata: designMetadata }, repoRoot: repo });
      assert.equal(resumed.status, 'resumable');
      assert.equal(resumed.nextAction, 'resume-increment');
    });

    it('requires final integration once every increment completes', () => {
      const firstRunId = '33333333-3333-4333-8333-333333333333';
      const secondRunId = '44444444-4444-4444-8444-444444444444';
      const events = [
        ...designEvents,
        incrementRunStart('I01', 'one', firstRunId),
        ...completedIncrement('I01', firstRunId),
        { v: 2, type: 'run-complete', runId: firstRunId, at, data: { result: 'complete', evidenceRefs: [] } },
        incrementRunStart('I02', 'two', secondRunId),
        ...completedIncrement('I02', secondRunId),
        { v: 2, type: 'run-complete', runId: secondRunId, at, data: { result: 'complete', evidenceRefs: [] } },
      ];
      for (const event of events) appendEvent(ledgerPath, event);
      const resumed = resumeDesign({ ledgerPath, planPath: designPath, planSource: { source: designBody, metadata: designMetadata }, repoRoot: repo });
      assert.equal(resumed.status, 'resumable');
      assert.equal(resumed.nextAction, 'final-integration');
    });

    it('excludes an amendment-only design segment from approval-bearing selection', () => {
      const incrementRunId = '33333333-3333-4333-8333-333333333333';
      const amendmentRunId = '44444444-4444-4444-8444-444444444444';
      const events = [
        ...designEvents,
        incrementRunStart('I01', 'one', incrementRunId),
        ...completedIncrement('I01', incrementRunId),
        { v: 2, type: 'run-complete', runId: incrementRunId, at, data: { result: 'complete', evidenceRefs: [] } },
        { v: 2, type: 'run-start', runId: amendmentRunId, at, data: { governingPath: designPath, governingHash: `sha256:${'f'.repeat(64)}`, rootSlug: 'example', action: 'design', baseline: { commit: oid, repositoryState: state, dirtyPaths: [] } } },
        { v: 2, type: 'amendment', runId: amendmentRunId, at, data: { amendmentId: 'A01', state: 'proposed', affectedIncrements: [] } },
        { v: 2, type: 'amendment', runId: amendmentRunId, at, data: { amendmentId: 'A01', state: 'reviewed', affectedIncrements: [] } },
        { v: 2, type: 'amendment', runId: amendmentRunId, at, data: { amendmentId: 'A01', state: 'rejected', affectedIncrements: [] } },
        { v: 2, type: 'run-complete', runId: amendmentRunId, at, data: { result: 'complete', evidenceRefs: [] } },
      ];
      for (const event of events) appendEvent(ledgerPath, event);
      const resumed = resumeDesign({ ledgerPath, planPath: designPath, planSource: { source: designBody, metadata: designMetadata }, repoRoot: repo });
      assert.equal(resumed.status, 'resumable');
      assert.equal(resumed.nextAction, 'implement:I02');
    });

    function completedIncrement(id, runId) {
      const file = `${id}.txt`;
      fs.writeFileSync(path.join(repo, file), `${id} done\n`);
      const resultState = materializedFingerprint(repo, [file]).digest;
      return [
        { v: 2, type: 'task-start', runId, at, data: { taskId: `${id}-task`, attemptBudget: 1, paths: [file], preState: state } },
        { v: 2, type: 'implementation-attempt', runId, at, data: { taskId: `${id}-task`, attempt: 1, launch: 'full', target: { platform: 'opencode' }, terminalEnvelope: {}, evidence: ['done'], transition: 'verify' } },
        { v: 2, type: 'verification', runId, at, data: { taskId: `${id}-task`, attempt: 1, result: 'pass', commandRefs: ['test'], transition: 'complete' } },
        { v: 2, type: 'task-complete', runId, at, data: { taskId: `${id}-task`, paths: [file], head: oid, preState: state, resultState, diffHash: state } },
      ];
    }
  });
});
