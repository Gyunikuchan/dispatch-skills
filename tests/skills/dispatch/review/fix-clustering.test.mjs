import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeClusterId,
  createIndependenceClusters,
  formatOptInSections,
  parseOptInResponse,
  splitFailedCluster,
} from '../../../../skills/dispatch/scripts/review/fix-clustering.mjs';

describe('fix clustering and opt-in handling', () => {
  describe('computeClusterId', () => {
    it('produces deterministic cluster ID starting with C- and 12 hex chars', () => {
      const id1 = computeClusterId({ runId: 'run-1', parentTaskId: '', findingIds: ['R1-F001', 'R1-F002'] });
      const id2 = computeClusterId({ runId: 'run-1', parentTaskId: '', findingIds: ['R1-F002', 'R1-F001'] });
      assert.equal(id1, id2);
      assert.match(id1, /^C-[a-f0-9]{12}$/);
    });

    it('changes ID when runId, parentTaskId, or members differ', () => {
      const base = computeClusterId({ runId: 'run-1', parentTaskId: '', findingIds: ['R1-F001'] });
      const diffRun = computeClusterId({ runId: 'run-2', parentTaskId: '', findingIds: ['R1-F001'] });
      const diffParent = computeClusterId({ runId: 'run-1', parentTaskId: 'C-1234567890ab', findingIds: ['R1-F001'] });
      const diffMembers = computeClusterId({ runId: 'run-1', parentTaskId: '', findingIds: ['R1-F002'] });

      assert.notEqual(base, diffRun);
      assert.notEqual(base, diffParent);
      assert.notEqual(base, diffMembers);
    });
  });

  describe('createIndependenceClusters', () => {
    it('groups findings with pairwise disjoint paths into single cluster', () => {
      const findings = [
        { id: 'R1-F001', affectedPaths: ['src/a.ts'], dependsOn: [], verification: ['npm test -- a'] },
        { id: 'R1-F002', affectedPaths: ['src/b.ts'], dependsOn: [], verification: ['npm test -- b'] },
      ];

      const clusters = createIndependenceClusters(findings, { runId: 'run-1' });
      assert.equal(clusters.length, 1);
      assert.deepEqual(clusters[0].findingIds, ['R1-F001', 'R1-F002']);
      assert.deepEqual(clusters[0].affectedPaths, ['src/a.ts', 'src/b.ts']);
      assert.deepEqual(clusters[0].verification, ['npm test -- a', 'npm test -- b']);
      assert.equal(clusters[0].attemptBudget, 3);
      assert.equal(clusters[0].parentTaskId, null);
    });

    it('separates findings that touch the same file', () => {
      const findings = [
        { id: 'R1-F001', affectedPaths: ['src/common.ts'], dependsOn: [], verification: ['npm test -- common'] },
        { id: 'R1-F002', affectedPaths: ['src/common.ts'], dependsOn: [], verification: ['npm test -- common'] },
      ];

      const clusters = createIndependenceClusters(findings, { runId: 'run-1' });
      assert.equal(clusters.length, 2);
      assert.deepEqual(clusters[0].findingIds, ['R1-F001']);
      assert.deepEqual(clusters[1].findingIds, ['R1-F002']);
    });

    it('separates findings with transitive dependency relationships', () => {
      const findings = [
        { id: 'R1-F001', affectedPaths: ['src/a.ts'], dependsOn: [], verification: ['npm test -- a'] },
        { id: 'R1-F002', affectedPaths: ['src/b.ts'], dependsOn: ['R1-F001'], verification: ['npm test -- b'] },
        { id: 'R1-F003', affectedPaths: ['src/c.ts'], dependsOn: ['R1-F002'], verification: ['npm test -- c'] },
      ];

      const clusters = createIndependenceClusters(findings, { runId: 'run-1' });
      assert.equal(clusters.length, 3);
      assert.deepEqual(clusters.map((c) => c.findingIds), [['R1-F001'], ['R1-F002'], ['R1-F003']]);
    });

    it('groups path-disjoint dependents of a shared prerequisite after its cluster', () => {
      const findings = [
        { id: 'R1-F001', affectedPaths: ['src/base.ts'], dependsOn: [], verification: ['npm test'] },
        { id: 'R1-F002', affectedPaths: ['src/a.ts'], dependsOn: ['R1-F001'], verification: ['npm test -- a'] },
        { id: 'R1-F003', affectedPaths: ['src/b.ts'], dependsOn: ['R1-F001'], verification: ['npm test -- b'] },
      ];

      const clusters = createIndependenceClusters(findings, { runId: 'run-1' });
      // F001 is grouped first; F002 depends on F001 so cannot join F001; F003 depends on F001 so cannot join F001.
      // F003 and F002 are disjoint and neither depends on the other, so F003 can join F002.
      assert.equal(clusters.length, 2);
      assert.deepEqual(clusters[0].findingIds, ['R1-F001']);
      assert.deepEqual(clusters[1].findingIds, ['R1-F002', 'R1-F003']);
      assert.deepEqual(clusters[1].dependsOnClusters, [clusters[0].clusterId]);
    });

    it('orders a prerequisite cluster first even when its ID sorts later', () => {
      const findings = [
        { id: 'R1-F001', affectedPaths: ['src/a.ts'], dependsOn: ['R1-F002'], verification: ['npm test'] },
        { id: 'R1-F002', affectedPaths: ['src/b.ts'], dependsOn: [], verification: ['npm test'] },
      ];
      const clusters = createIndependenceClusters(findings, { runId: 'run-1' });
      assert.deepEqual(clusters.map((c) => c.findingIds), [['R1-F002'], ['R1-F001']]);
    });

    it('requires non-empty runId', () => {
      assert.throws(() => createIndependenceClusters([], { runId: '' }), /runId must be a non-empty string/);
    });
  });

  describe('splitFailedCluster', () => {
    it('splits a failed cluster, preserving completed work and inheriting remaining budget', () => {
      const parentCluster = {
        clusterId: 'C-parent123456',
        findingIds: ['R1-F001', 'R1-F002', 'R1-F003'],
        findings: [
          { findingId: 'R1-F001', affectedPaths: ['src/a.ts'], dependsOn: [], verification: ['npm test -- a'] },
          { findingId: 'R1-F002', affectedPaths: ['src/b.ts'], dependsOn: [], verification: ['npm test -- b'] },
          { findingId: 'R1-F003', affectedPaths: ['src/b.ts'], dependsOn: [], verification: ['npm test -- b'] },
        ],
        attemptBudget: 3,
      };

      const split = splitFailedCluster(parentCluster, {
        completedFindingIds: ['R1-F001'],
        attemptsConsumed: 1,
        runId: 'run-1',
      });

      assert.deepEqual(split.completedFindings, ['R1-F001']);
      assert.equal(split.remainingBudget, 2);
      assert.equal(split.canProceed, true);
      assert.equal(split.remainingClusters.length, 2);
      assert.equal(split.remainingClusters[0].parentTaskId, 'C-parent123456');
      assert.equal(split.remainingClusters[0].attemptBudget, 2);
      assert.equal(split.remainingClusters[1].parentTaskId, 'C-parent123456');
      assert.equal(split.remainingClusters[1].attemptBudget, 2);
    });

    it('isolates failedFindingId and groups remaining', () => {
      const parentCluster = {
        clusterId: 'C-parent123456',
        findingIds: ['R1-F001', 'R1-F002', 'R1-F003'],
        findings: [
          { findingId: 'R1-F001', affectedPaths: ['src/a.ts'], dependsOn: [], verification: ['npm test -- a'] },
          { findingId: 'R1-F002', affectedPaths: ['src/b.ts'], dependsOn: [], verification: ['npm test -- b'] },
          { findingId: 'R1-F003', affectedPaths: ['src/c.ts'], dependsOn: [], verification: ['npm test -- c'] },
        ],
        attemptBudget: 3,
      };

      const split = splitFailedCluster(parentCluster, {
        failedFindingId: 'R1-F002',
        attemptsConsumed: 1,
        runId: 'run-1',
      });

      assert.equal(split.remainingClusters.length, 2);
      assert.deepEqual(split.remainingClusters[0].findingIds, ['R1-F002']);
      assert.deepEqual(split.remainingClusters[1].findingIds, ['R1-F001', 'R1-F003']);
    });

    it('strictly reduces cluster size to singletons when no finding completed and candidate regrouping equals parent', () => {
      const parentCluster = {
        clusterId: 'C-parent123456',
        findingIds: ['R1-F001', 'R1-F002'],
        findings: [
          { findingId: 'R1-F001', affectedPaths: ['src/a.ts'], dependsOn: [], verification: ['npm test -- a'] },
          { findingId: 'R1-F002', affectedPaths: ['src/b.ts'], dependsOn: [], verification: ['npm test -- b'] },
        ],
        attemptBudget: 3,
      };

      const split = splitFailedCluster(parentCluster, {
        completedFindingIds: [],
        attemptsConsumed: 1,
        runId: 'run-1',
      });

      assert.equal(split.remainingClusters.length, 2);
      assert.deepEqual(split.remainingClusters[0].findingIds, ['R1-F001']);
      assert.deepEqual(split.remainingClusters[1].findingIds, ['R1-F002']);
    });

    it('halts when budget is exhausted without exceeding attempt budget', () => {
      const parentCluster = {
        clusterId: 'C-parent123456',
        findingIds: ['R1-F001'],
        findings: [
          { findingId: 'R1-F001', affectedPaths: ['src/a.ts'], dependsOn: [], verification: ['npm test -- a'] },
        ],
        attemptBudget: 1,
      };

      const split = splitFailedCluster(parentCluster, {
        completedFindingIds: [],
        attemptsConsumed: 1,
        runId: 'run-1',
      });

      assert.equal(split.remainingBudget, 0);
      assert.equal(split.canProceed, false);
      assert.equal(split.remainingClusters.length, 0);
    });

    it('validates numeric arguments and clamps remainingBudget to maxAttempts', () => {
      const parentCluster = {
        clusterId: 'C-parent123456',
        findingIds: ['R1-F001'],
        findings: [
          { findingId: 'R1-F001', affectedPaths: ['src/a.ts'], dependsOn: [], verification: ['npm test -- a'] },
        ],
        attemptBudget: 5,
      };

      // Clamps to maxAttempts
      const split = splitFailedCluster(parentCluster, {
        attemptsConsumed: 1,
        maxAttempts: 3,
        runId: 'run-1',
      });
      assert.equal(split.remainingBudget, 3);

      assert.throws(() => splitFailedCluster(parentCluster, { attemptsConsumed: -1, runId: 'run-1' }), /attemptsConsumed must be a non-negative integer/);
      assert.throws(() => splitFailedCluster(parentCluster, { attemptsConsumed: NaN, runId: 'run-1' }), /attemptsConsumed must be a non-negative integer/);
      assert.throws(() => splitFailedCluster(parentCluster, { maxAttempts: 0, runId: 'run-1' }), /maxAttempts must be a positive integer/);
    });
  });

  describe('formatOptInSections and parseOptInResponse', () => {
    it('returns "none" when both recommendations and outOfScope are empty', () => {
      const res = formatOptInSections({ recommendations: [], outOfScope: [] });
      assert.equal(res.text, 'none');
      assert.deepEqual(res.aliases, {});
    });

    it('formats recommendations default included and out-of-scope default excluded', () => {
      const res = formatOptInSections({
        recommendations: [
          { id: 'R1-F001', summary: 'Fix type cast in foo.ts', reason: 'addresses reviewed edge case' },
        ],
        outOfScope: [
          { id: 'R1-F002', summary: 'Add telemetry metrics', reason: 'deferred to separate change' },
        ],
      });

      assert.match(res.text, /### Recommended Follow-ups \(Default: Included\)/);
      assert.match(res.text, /- \[R1\] \[x\] Fix type cast in foo\.ts — addresses reviewed edge case/);
      assert.match(res.text, /### Out-of-Scope \/ Adjacent Items \(Default: Excluded\)/);
      assert.match(res.text, /- \[O1\] \[ \] Add telemetry metrics — deferred to separate change/);
      assert.deepEqual(res.aliases, { R1: 'R1-F001', O1: 'R1-F002' });
    });

    it('parses default responses keeping defaults', () => {
      const { aliases, items } = formatOptInSections({
        recommendations: [{ id: 'R1-F001', summary: 'Rec 1' }],
        outOfScope: [{ id: 'R1-F002', summary: 'OOS 1' }],
      });

      const parsed = parseOptInResponse('default', { aliases, items });
      assert.equal(parsed.responseKind, 'explicit-default');
      assert.deepEqual(parsed.includedFindingIds, ['R1-F001']);
      assert.deepEqual(parsed.excludedFindingIds, ['R1-F002']);
      assert.deepEqual(parsed.scopeChanges, []);
    });

    it('parses toggle response "exclude R1, include O1"', () => {
      const { aliases, items } = formatOptInSections({
        recommendations: [{ id: 'R1-F001', summary: 'Rec 1' }],
        outOfScope: [{ id: 'R1-F002', summary: 'OOS 1' }],
      });

      const parsed = parseOptInResponse('exclude R1, include O1', { aliases, items });
      assert.equal(parsed.responseKind, 'directives');
      assert.deepEqual(parsed.includedFindingIds, ['R1-F002']);
      assert.deepEqual(parsed.excludedFindingIds, ['R1-F001']);
      assert.deepEqual(parsed.scopeChanges, ['R1-F002']);
    });

    it('correctly handles comma-free response "exclude R2 include O1"', () => {
      const { aliases, items } = formatOptInSections({
        recommendations: [
          { id: 'R1-F001', summary: 'Rec 1' },
          { id: 'R1-F002', summary: 'Rec 2' },
        ],
        outOfScope: [
          { id: 'R1-F003', summary: 'OOS 1' },
        ],
      });

      const parsed = parseOptInResponse('exclude R2 include O1', { aliases, items });
      assert.equal(parsed.responseKind, 'directives');
      assert.deepEqual(parsed.includedFindingIds, ['R1-F001', 'R1-F003']);
      assert.deepEqual(parsed.excludedFindingIds, ['R1-F002']);
      assert.deepEqual(parsed.scopeChanges, ['R1-F003']);
    });

    it('identifies empty input and unrecognized tokens, returning ambiguous responseKind', () => {
      const { aliases, items } = formatOptInSections({
        recommendations: [{ id: 'R1-F001', summary: 'Rec 1' }],
      });

      const emptyRes = parseOptInResponse('', { aliases, items });
      assert.equal(emptyRes.responseKind, 'empty');

      const ambiguousRes = parseOptInResponse('drop R1', { aliases, items });
      assert.equal(ambiguousRes.responseKind, 'ambiguous');
      assert.deepEqual(ambiguousRes.unrecognizedTokens, ['drop']);

      const typoRes = parseOptInResponse('exclude R9', { aliases, items });
      assert.equal(typoRes.responseKind, 'ambiguous');
      assert.deepEqual(typoRes.unrecognizedTokens, ['R9']);
    });

    it('deduplicates recommendations and out-of-scope by authoritative finding ID', () => {
      const res = formatOptInSections({
        recommendations: [
          { id: 'R1-F001', summary: 'Rec 1' },
          { id: 'R1-F001', summary: 'Rec 1 Duplicate' },
          { id: 'R1-F002', summary: 'Rec 2' },
        ],
        outOfScope: [
          { id: 'R1-F001', summary: 'Rec 1 In OOS' },
          { id: 'R1-F003', summary: 'OOS 1' },
          { id: 'R1-F003', summary: 'OOS 1 Duplicate' },
        ],
      });

      assert.deepEqual(res.aliases, {
        R1: 'R1-F001',
        R2: 'R1-F002',
        O1: 'R1-F003',
      });
      assert.equal(res.items.length, 3);
      assert.equal(res.items[0].alias, 'R1');
      assert.equal(res.items[1].alias, 'R2');
      assert.equal(res.items[2].alias, 'O1');
    });
  });

  describe('splitFailedCluster budget', () => {
    it('carries completed findings and the remaining attempt budget', () => {
      const parsed = splitFailedCluster({
        clusterId: 'C-parent123456',
        findingIds: ['R1-F001', 'R1-F002'],
        findings: [
          { findingId: 'R1-F001', affectedPaths: ['src/a.ts'], dependsOn: [], verification: ['npm test'] },
          { findingId: 'R1-F002', affectedPaths: ['src/b.ts'], dependsOn: [], verification: ['npm test'] },
        ],
        attemptBudget: 3,
      }, { runId: 'run-1', failedFindingId: null, completedFindingIds: ['R1-F001'], attemptsConsumed: 1, maxAttempts: 3 });
      assert.deepEqual(parsed.completedFindings, ['R1-F001']);
      assert.equal(parsed.remainingBudget, 2);
      assert.equal(parsed.canProceed, true);
    });
  });
});
