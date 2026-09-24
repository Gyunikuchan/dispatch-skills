import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { failureAttribution } from '../../../../skills/dispatch/scripts/verification/failure-attribution.mjs';

// SECTION: Safe failure reversion

describe('failure attribution', () => {
  const taskStart = { 'task.js': { objectId: 'before' } };
  const failureSnapshot = { 'task.js': { objectId: 'after' }, 'new.js': { objectId: 'new' } };

  it('attributes only task changes after explicit authorization', () => {
    assert.deepEqual(failureAttribution({ taskStart, failureSnapshot, authorized: true }), {
      allowed: true,
      paths: ['new.js', 'task.js'],
      nonSeparable: [],
      reason: null,
    });
    assert.equal(failureAttribution({ taskStart, failureSnapshot }).reason, 'reversion-not-authorized');
  });

  it('fails closed on post-failure drift and caller-owned dirty paths', () => {
    assert.equal(failureAttribution({
      taskStart,
      failureSnapshot,
      currentState: { ...failureSnapshot, 'new.js': { objectId: 'drift' } },
      authorized: true,
    }).reason, 'post-failure-drift');
    assert.deepEqual(failureAttribution({
      baseline: { 'task.js': { objectId: 'caller' } },
      taskStart,
      failureSnapshot,
      authorized: true,
    }), {
      allowed: false,
      paths: [],
      nonSeparable: ['task.js'],
      reason: 'caller-dirty-path',
    });
  });
});
