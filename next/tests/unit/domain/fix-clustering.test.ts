import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clusterFixes, clusterId, splitFailedCluster } from '../../../skills/dispatch/scripts/domain/fix-clustering.ts';

const fixes = [
  { id: 'R1-F001', paths: ['src/a.ts'] },
  { id: 'R1-F002', paths: ['src/a.ts', 'src/b.ts'] },
  { id: 'R1-F003', paths: ['src/c.ts'], dependencies: ['R1-F001'] },
  { id: 'R1-F004', paths: ['src/d.ts'] },
] as const;

test('review-fix-clustering: overlapping paths and dependencies separate clusters, ordered by dependency', () => {
  const clusters = clusterFixes(fixes, { runId: 'run-1' });
  for (const cluster of clusters) {
    const paths = cluster.members.flatMap((member) => member.paths);
    assert.equal(new Set(paths).size, paths.length, 'cluster members never share a path');
  }
  const owner = (id: string) => clusters.findIndex((cluster) => cluster.findingIds.includes(id));
  assert.notEqual(owner('R1-F001'), owner('R1-F002'));
  assert.notEqual(owner('R1-F001'), owner('R1-F003'));
  assert.ok(owner('R1-F001') < owner('R1-F003'), 'dependency cluster runs first');
  assert.ok(clusters.every((cluster) => cluster.attemptBudget === 3));
  assert.deepEqual(clusters.flatMap((cluster) => cluster.findingIds).sort(), ['R1-F001', 'R1-F002', 'R1-F003', 'R1-F004']);
  assert.equal(clusterId('run-1', null, ['R1-F002', 'R1-F001']), clusterId('run-1', null, ['R1-F001', 'R1-F002']));
});

test('review-fix-clustering: a failed cluster splits with a bounded, shrinking budget', () => {
  const [cluster] = clusterFixes([{ id: 'R1-F001', paths: ['a'] }, { id: 'R1-F002', paths: ['b'] }, { id: 'R1-F003', paths: ['c'] }], { runId: 'run-1' });
  assert.ok(cluster && cluster.findingIds.length === 3);
  const split = splitFailedCluster(cluster, { runId: 'run-1', completed: ['R1-F001'], failed: 'R1-F002' });
  assert.equal(split.remainingBudget, 2);
  assert.ok(split.canProceed);
  assert.deepEqual(split.clusters.map((item) => item.findingIds), [['R1-F002'], ['R1-F003']]);
  assert.ok(split.clusters.every((item) => item.parentId === cluster.clusterId && item.attemptBudget === 2));
  const [child] = split.clusters;
  assert.ok(child);
  const exhausted = splitFailedCluster(child, { runId: 'run-1', attemptsConsumed: 2 });
  assert.deepEqual([exhausted.canProceed, exhausted.remainingBudget], [false, 0]);
});

test('review-fix-clustering: dependency cycles are rejected', () => {
  assert.throws(() => clusterFixes([
    { id: 'R1-F001', paths: ['a'], dependencies: ['R1-F002'] },
    { id: 'R1-F002', paths: ['b'], dependencies: ['R1-F001'] },
  ], { runId: 'run-1' }), /cycle/);
});
