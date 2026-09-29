import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { adjudicate, rank, reviewScope, shouldReReview, threshold } from '../../../../skills/dispatch/scripts/review/rounds.mjs';

const f = (severity, state) => ({ severity, state });

describe('rounds policy', () => {
  it('ranks severities MUST > SHOULD > CONSIDER', () => {
    assert.ok(rank('MUST') > rank('SHOULD'));
    assert.ok(rank('SHOULD') > rank('CONSIDER'));
  });

  it('uses SHOULD before the cap and MUST at or after it', () => {
    assert.equal(threshold({ round: 1, cap: 3 }), 'SHOULD');
    assert.equal(threshold({ round: 2, cap: 3 }), 'SHOULD');
    assert.equal(threshold({ round: 3, cap: 3 }), 'MUST');
    assert.equal(threshold({ round: 7, cap: 3 }), 'MUST');
  });

  it('keeps the cap round full-diff and later rounds delta', () => {
    assert.equal(reviewScope({ round: 2, cap: 3 }), 'full');
    assert.equal(reviewScope({ round: 3, cap: 3 }), 'delta');
    assert.equal(reviewScope({ round: 4, cap: 3 }), 'delta');
  });

  const table = [
    ['SHOULD fix before the cap', { round: 1, cap: 3, findings: [f('SHOULD', 'fixed')] }, true],
    ['CONSIDER fix before the cap', { round: 1, cap: 3, findings: [f('CONSIDER', 'fixed')] }, false],
    ['SHOULD fix at the cap', { round: 3, cap: 3, findings: [f('SHOULD', 'fixed')] }, false],
    ['MUST fix after the cap (uncapped)', { round: 9, cap: 3, findings: [f('MUST', 'fixed')] }, true],
    ['SHOULD pending rejection before the cap', { round: 2, cap: 3, findings: [f('SHOULD', 'pending-rejection')] }, true],
    ['MUST pending rejection after the cap', { round: 5, cap: 3, findings: [f('MUST', 'pending-rejection')] }, true],
    ['final rejection', { round: 1, cap: 3, findings: [f('MUST', 'rejected')] }, false],
    ['open or closed finding', { round: 1, cap: 3, findings: [f('MUST', 'open'), f('MUST', 'closed')] }, false],
    ['no findings', { round: 1, cap: 3, findings: [] }, false],
  ];
  for (const [name, summary, expected] of table) {
    it(`shouldReReview: ${name} → ${expected}`, () => assert.equal(shouldReReview(summary), expected));
  }

  it('adjudicate closes only below-threshold pending rejections as orchestrator', () => {
    const findings = [f('SHOULD', 'pending-rejection'), f('MUST', 'pending-rejection'), f('CONSIDER', 'pending-rejection'), f('SHOULD', 'fixed')];
    assert.deepEqual(adjudicate({ round: 3, cap: 3, findings }), [
      { severity: 'SHOULD', state: 'rejected', closer: 'orchestrator' },
      f('MUST', 'pending-rejection'),
      { severity: 'CONSIDER', state: 'rejected', closer: 'orchestrator' },
      f('SHOULD', 'fixed'),
    ]);
    assert.deepEqual(adjudicate({ round: 1, cap: 3, findings: [f('SHOULD', 'pending-rejection')] }), [f('SHOULD', 'pending-rejection')]);
  });
});
