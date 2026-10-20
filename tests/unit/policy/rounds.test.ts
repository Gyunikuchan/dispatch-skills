import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  acceptByOmission, assignAffinity, convergence, exitSummary, nextRound, orchestratorClosures, roundsPolicy, threshold, type RoundFinding,
} from '../../../skills/dispatch/scripts/policy/rounds.ts';

const f = (id: string, severity: RoundFinding['severity'], state: RoundFinding['state']): RoundFinding => ({ id, severity, state });

// SECTION: Policy and threshold

test('review-rounds-policy: threshold is SHOULD below the cap and MUST at or after it', () => {
  assert.deepEqual([1, 2, 3, 4].map((round) => threshold(round, 3)), ['SHOULD', 'SHOULD', 'MUST', 'MUST']);
});

test('review-rounds-policy: missing policy → one target, one round; zero disables', () => {
  assert.deepEqual(roundsPolicy(undefined, 'medium'), { enabled: true, cap: 1, targets: 1, configured: false });
  assert.deepEqual(roundsPolicy({ rounds: { low: 0 }, targets: { low: 2 } }, 'high'), { enabled: false });
  assert.deepEqual(roundsPolicy({ rounds: { low: 2 }, targets: { low: 0 } }, 'high'), { enabled: false });
  assert.deepEqual(roundsPolicy({ rounds: { low: 1, high: 3 }, targets: { low: 2 } }, 'max'), { enabled: true, cap: 3, targets: 2, configured: true });
});

// SECTION: Next round

test('review-rounds-policy: fixes and pending rejections select the next review scope', () => {
  const rows: [string, Parameters<typeof nextRound>[0], ReturnType<typeof nextRound>][] = [
    ['fixed SHOULD below cap → full', { round: 1, cap: 3, findings: [f('R1-F001', 'SHOULD', 'fixed')] }, { run: true, round: 2, scope: 'full', threshold: 'SHOULD', carry: [] }],
    ['CONSIDER only → stop', { round: 1, cap: 3, findings: [f('R1-F001', 'CONSIDER', 'fixed')] }, { run: false }],
    ['fixed SHOULD at cap → stop', { round: 3, cap: 3, findings: [f('R3-F001', 'SHOULD', 'fixed')] }, { run: false }],
    ['fixed MUST at cap → delta', { round: 3, cap: 3, findings: [f('R3-F001', 'MUST', 'fixed'), f('R3-F002', 'MUST', 'pending-rejection'), f('R3-F003', 'SHOULD', 'pending-rejection')] },
      { run: true, round: 4, scope: 'delta', threshold: 'MUST', carry: ['R3-F002'] }],
    ['only pending → disputes-only', { round: 1, cap: 3, findings: [f('R1-F001', 'SHOULD', 'pending-rejection')] }, { run: true, round: 2, scope: 'disputes-only', threshold: 'SHOULD', carry: ['R1-F001'] }],
    ['cap 0 disables', { round: 1, cap: 0, findings: [f('R1-F001', 'MUST', 'fixed')] }, { run: false }],
  ];
  for (const [name, input, expected] of rows) assert.deepEqual(nextRound(input), expected, name);
});

// SECTION: Disputes

test('review-rounds-policy: orchestrator closes only CONSIDER rejections below the cap', () => {
  const findings = [f('R1-F001', 'CONSIDER', 'pending-rejection'), f('R1-F002', 'MUST', 'pending-rejection')];
  assert.deepEqual(orchestratorClosures({ round: 1, cap: 3, findings }), [{ id: 'R1-F001', closedBy: 'orchestrator' }]);
});

test('review-rounds-policy: responsible reviewer omission closes only findings not re-raised', () => {
  assert.deepEqual(acceptByOmission(['R1-F001', 'R1-F002'], [], ['R1-F002']), [{ id: 'R1-F002', closedBy: 'reviewer' }]);
  assert.deepEqual(acceptByOmission(['R1-F002', 'R1-F003'], ['R1-F003'], ['R1-F002', 'R1-F003']), [{ id: 'R1-F002', closedBy: 'reviewer' }]);
  assert.deepEqual(acceptByOmission(['R1-F001'], ['R1-F001'], ['R1-F001']), []);
});

test('review-rounds-policy: affinity assigns sources to available reviewers and substitutes', () => {
  assert.deepEqual(assignAffinity(
    [{ id: 'R1-F001', source: 'codex[0]' }, { id: 'R1-F002', source: 'agy[0]' }, { id: 'R1-F003', source: 'copilot[0]' }],
    [{ slot: 'codex[0]' }, { slot: 'claude[0]', substitutesFor: 'agy[0]' }],
  ), { 'R1-F001': 'codex[0]', 'R1-F002': 'claude[0]', 'R1-F003': null });
  assert.deepEqual(
    assignAffinity([{ id: 'R1-F001', source: 'codex[0]' }], [{ slot: 'codex[0]', substitutesFor: 'agy[0]' }]),
    { 'R1-F001': 'codex[0]' },
  );
});

// SECTION: Convergence

test('review-rounds-policy: convergence escalates regression and deadlock', () => {
  const raised = [{ locus: 'src/a.ts:L10', category: 'correctness', text: 'retry loop never terminates' }];
  const entry = { locus: 'src/a.ts:L12', category: 'correctness', text: 'the retry loop never terminates', id: 'R1-F001' };
  assert.deepEqual(convergence(raised, [{ ...entry, status: 'applied', reraises: 0, reopens: 1 }]), { halt: true, escalation: { kind: 'regression', ids: ['R1-F001'] } });
  assert.deepEqual(convergence(raised, [{ ...entry, status: 'pending-rejection', reraises: 0, reopens: 0 }]), { halt: false, reraised: ['R1-F001'], reopened: [] });
  assert.deepEqual(convergence(raised, [{ ...entry, status: 'pending-rejection', reraises: 1, reopens: 0 }]), { halt: true, escalation: { kind: 'deadlock', ids: ['R1-F001'] } });
  assert.deepEqual(convergence([{ ...raised[0]!, category: 'perf' }], [{ ...entry, status: 'applied', reraises: 0, reopens: 1 }]), { halt: false, reraised: [], reopened: [] });
});

test('review-rounds-policy - regression halts on second match of an applied fix, not the first', () => {
  const raised = [{ locus: 'src/a.ts:L10', category: 'correctness', text: 'retry loop never terminates' }];
  const fix = { locus: 'src/a.ts:L12', category: 'correctness', text: 'the retry loop never terminates', id: 'R1-F001', status: 'applied' as const, reraises: 0 };
  const other = { ...fix, locus: 'src/b.ts:L1', id: 'R1-F002' };
  assert.deepEqual(convergence(raised, [{ ...fix, reopens: 0 }, { ...other, reopens: 1 }]), { halt: false, reraised: [], reopened: ['R1-F001'] }, 'first match reopens');
  assert.deepEqual(convergence(raised, [{ ...fix, reopens: 1 }, { ...other, reopens: 1 }]), { halt: true, escalation: { kind: 'regression', ids: ['R1-F001'] } }, 'second match halts');
});

// SECTION: Exit

test('review-rounds-policy: exit summary lists unreviewed fixes, rejections, rounds, cap status', () => {
  assert.deepEqual(exitSummary({ rounds: 4, cap: 3, fixes: [{ id: 'R1-F001', round: 1 }, { id: 'R4-F001', round: 4 }], rejections: ['R2-F001'] }), {
    rounds: 4, cap: 3, capStatus: 'beyond-cap', fixedUnreviewed: [{ id: 'R4-F001', round: 4 }], rejections: ['R2-F001'],
  });
});
