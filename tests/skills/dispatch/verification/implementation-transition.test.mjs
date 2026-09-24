import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveImplementationTransition } from '../../../../skills/dispatch/scripts/verification/implementation-outcome.mjs';

const done = {
  schemaVersion: 1,
  status: 'DONE',
  stage: 'COMPLETE',
  summary: 'Implemented the requested scope.',
  evidence: ['tests/example.test.mjs'],
};
const redReady = { ...done, stage: 'RED_READY' };

function transition(overrides = {}) {
  return resolveImplementationTransition({
    terminalEnvelope: done,
    launch: 'full',
    attempt: 1,
    targetKind: 'delegate',
    resumable: false,
    contextContinuationUsed: false,
    escalation: { status: 'available', level: 'high', model: 'model-high', effort: 'high' },
    ...overrides,
  });
}

// SECTION: Completion and stage routing

describe('resolveImplementationTransition', () => {
  it('maps completed launches to RED or independent verification', () => {
    assert.deepEqual(
      transition({ terminalEnvelope: redReady, launch: 'tests-only' }),
      { action: 'run-red', consumesAttempt: false },
    );
    assert.deepEqual(
      transition(),
      { action: 'verify', consumesAttempt: false },
    );
    assert.deepEqual(
      transition({
        terminalEnvelope: { ...done, status: 'DONE_WITH_CONCERNS', concerns: ['Risk remains.'] },
      }),
      { action: 'concern-ruling', consumesAttempt: false },
    );
  });

  it('rejects stages that do not match the launch kind', () => {
    assert.equal(
      transition({ terminalEnvelope: done, launch: 'tests-only' }).action,
      'replace',
    );
    assert.equal(
      transition({ terminalEnvelope: redReady, launch: 'full' }).action,
      'replace',
    );
    assert.equal(
      transition({
        terminalEnvelope: redReady,
        launch: 'continuation',
        continuationOf: 'full',
      }).action,
      'replace',
    );
  });

  it('rejects unknown launches and invalid continuation origins without consuming an attempt', () => {
    assert.throws(() => transition({ launch: 'retry' }), /unknown launch/);
    assert.throws(() => transition({ launch: 'continuation' }), /continuationOf/);
    assert.throws(
      () => transition({ launch: 'full', continuationOf: 'tests-only' }),
      /continuationOf/,
    );
  });

  it('maps every COMPLETE blocking status', () => {
    assert.deepEqual(
      transition({
        terminalEnvelope: {
          ...done,
          status: 'BLOCKED',
          evidence: [],
          blockers: ['Missing capability.'],
        },
      }),
      { action: 'change-blocking-condition', consumesAttempt: true },
    );
    assert.deepEqual(
      transition({
        terminalEnvelope: {
          ...done,
          status: 'NEEDS_CONTEXT',
          evidence: [],
          missingContext: ['Expected API shape.'],
        },
        resumable: true,
      }),
      { action: 'resume', consumesAttempt: false },
    );
  });

  it('routes tests-only COMPLETE context and blocker outcomes', () => {
    assert.deepEqual(
      transition({
        terminalEnvelope: {
          ...done,
          status: 'NEEDS_CONTEXT',
          evidence: [],
          missingContext: ['Fixture contract.'],
        },
        launch: 'tests-only',
        resumable: true,
      }),
      { action: 'resume', consumesAttempt: false },
    );
    assert.deepEqual(
      transition({
        terminalEnvelope: {
          ...done,
          status: 'BLOCKED',
          evidence: [],
          blockers: ['Missing test capability.'],
        },
        launch: 'tests-only',
      }),
      { action: 'change-blocking-condition', consumesAttempt: true },
    );
  });

  it('allows only one context continuation in a resumable delegate attempt', () => {
    const needsContext = {
      ...done,
      status: 'NEEDS_CONTEXT',
      evidence: [],
      missingContext: ['Expected API shape.'],
    };
    assert.equal(transition({ terminalEnvelope: needsContext, resumable: true }).action, 'resume');
    assert.equal(
      transition({
        terminalEnvelope: needsContext,
        resumable: true,
        contextContinuationUsed: true,
      }).action,
      'replace',
    );
  });

  it('consumes NEEDS_CONTEXT immediately for a non-resumable delegate', () => {
    assert.deepEqual(
      transition({
        terminalEnvelope: {
          ...done,
          status: 'NEEDS_CONTEXT',
          evidence: [],
          missingContext: ['Expected API shape.'],
        },
      }),
      { action: 'replace', consumesAttempt: true },
    );
  });

  it('lets self pause once for context and stops on a second request', () => {
    const needsContext = {
      ...done,
      status: 'NEEDS_CONTEXT',
      evidence: [],
      missingContext: ['User decision.'],
    };
    assert.deepEqual(
      transition({ terminalEnvelope: needsContext, targetKind: 'self' }),
      { action: 'resume', consumesAttempt: false },
    );
    assert.deepEqual(
      transition({
        terminalEnvelope: needsContext,
        targetKind: 'self',
        contextContinuationUsed: true,
      }),
      { action: 'stop-user-ruling', consumesAttempt: false },
    );
  });

  it('uses replacement, escalation, and terminal ceilings for delegated failures', () => {
    assert.equal(transition({ terminalEnvelope: null, attempt: 1 }).action, 'replace');
    assert.equal(transition({ terminalEnvelope: null, attempt: 2 }).action, 'escalate');
    assert.deepEqual(
      transition({ terminalEnvelope: null, attempt: 3 }),
      { action: 'stop-user-ruling', consumesAttempt: true },
    );
    assert.deepEqual(
      transition({ terminalEnvelope: null, attempt: 4 }),
      { action: 'stop-user-ruling', consumesAttempt: true },
    );
  });

  it('stops after delegated Attempt 2 when escalation is exhausted', () => {
    assert.deepEqual(
      transition({
        terminalEnvelope: null,
        attempt: 2,
        escalation: { status: 'exhausted', reason: 'no-distinct-higher-level' },
      }),
      { action: 'stop-user-ruling', consumesAttempt: true },
    );
  });

  it('rejects malformed escalation state when delegated Attempt 2 needs it', () => {
    assert.throws(
      () => transition({ terminalEnvelope: null, attempt: 2, escalation: undefined }),
      /escalation must be available or exhausted/,
    );
    assert.throws(
      () => transition({
        terminalEnvelope: null,
        attempt: 2,
        escalation: { status: 'available', level: 'high' },
      }),
      /escalation\.model/,
    );
    assert.throws(
      () => transition({
        terminalEnvelope: null,
        attempt: 2,
        escalation: { status: 'exhausted', reason: '' },
      }),
      /escalation\.reason/,
    );
  });

  it('preserves escalated model and effort for Attempt 3 without re-resolution', () => {
    assert.deepEqual(
      transition({ terminalEnvelope: null, attempt: 2 }),
      {
        action: 'escalate',
        consumesAttempt: true,
        target: { level: 'high', model: 'model-high', effort: 'high' },
      },
    );
  });

  it('limits self execution to two attempts', () => {
    assert.equal(
      transition({ terminalEnvelope: null, attempt: 1, targetKind: 'self' }).action,
      'replace',
    );
    assert.deepEqual(
      transition({ terminalEnvelope: null, attempt: 2, targetKind: 'self' }),
      { action: 'stop-user-ruling', consumesAttempt: true },
    );
    assert.deepEqual(
      transition({ terminalEnvelope: null, attempt: 3, targetKind: 'self' }),
      { action: 'stop-user-ruling', consumesAttempt: true },
    );
  });

  it('maps valid and invalid RED verification results', () => {
    assert.deepEqual(
      transition({ verificationResult: 'red', verificationKind: 'red-gate', resumable: true }),
      { action: 'resume', consumesAttempt: false },
    );
    assert.deepEqual(
      transition({ verificationResult: 'red', verificationKind: 'red-gate', resumable: false }),
      { action: 'continue', consumesAttempt: false },
    );
    assert.equal(
      transition({ verificationResult: 'pass', verificationKind: 'red-gate' }).action,
      'replace',
    );
    assert.equal(
      transition({ verificationResult: 'regression', verificationKind: 'red-gate' }).action,
      'replace',
    );
  });

  it('accepts RED_READY from a tests-only context continuation', () => {
    assert.deepEqual(
      transition({
        terminalEnvelope: redReady,
        launch: 'continuation',
        continuationOf: 'tests-only',
        resumable: true,
      }),
      { action: 'run-red', consumesAttempt: false },
    );
  });

  it('returns to the RED gate after resolving RED_READY concerns', () => {
    const concerned = {
      ...redReady,
      status: 'DONE_WITH_CONCERNS',
      concerns: ['The fixture is platform-specific.'],
    };
    assert.deepEqual(
      transition({ terminalEnvelope: concerned, launch: 'tests-only' }),
      { action: 'concern-ruling', consumesAttempt: false },
    );
    assert.deepEqual(
      transition({
        terminalEnvelope: concerned,
        launch: 'tests-only',
        concernsResolved: true,
      }),
      { action: 'run-red', consumesAttempt: false },
    );
  });

  it('enforces attempt ceilings for BLOCKED outcomes', () => {
    const blocked = {
      ...done,
      status: 'BLOCKED',
      evidence: [],
      blockers: ['Capability unavailable.'],
    };
    assert.deepEqual(
      transition({ terminalEnvelope: blocked, attempt: 4 }),
      { action: 'stop-user-ruling', consumesAttempt: true },
    );
    assert.deepEqual(
      transition({ terminalEnvelope: blocked, attempt: 3, targetKind: 'self' }),
      { action: 'stop-user-ruling', consumesAttempt: true },
    );
  });

  it('completes non-regression verification and retries regression after DONE', () => {
    for (const result of ['pass', 'accepted-baseline-equivalent']) {
      assert.deepEqual(
        transition({ verificationResult: result, verificationKind: 'final' }),
        { action: 'complete', consumesAttempt: false },
      );
    }
    assert.deepEqual(
      transition({ verificationResult: 'regression', verificationKind: 'final' }),
      { action: 'replace', consumesAttempt: true },
    );
  });
});
