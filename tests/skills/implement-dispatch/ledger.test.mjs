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
      fs.chmodSync(namespace, 0o777);
      assert.throws(() => ensureLedgerNamespace({
        tempRoot: hostileRoot, repoHash: 'abcdef123456', env: { USER: 'test' },
      }), /writable/);
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
});
