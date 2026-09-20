import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

describe('v0.4 Phase 4 keyed opt-ins and clustered fixes contracts', () => {
  it('alignment reference documents interaction aliases and application continuation format', () => {
    const alignment = read('skills/dispatch/references/alignment.md');
    assert.match(alignment, /Interaction aliases/i);
    assert.match(alignment, /\[R#\]/);
    assert.match(alignment, /\[O#\]/);
    assert.match(alignment, /application:\s*\{"v":1,"findingId":/);
    assert.match(alignment, /"state":"<unapplied\|materialized\|applied\|superseded>"/);
    assert.match(alignment, /"scope":"<in-scope\|adjacent>"/);
    assert.match(alignment, /"affectedPaths":/);
    assert.match(alignment, /"dependsOn":/);
    assert.match(alignment, /"verification":/);
    assert.match(alignment, /"reason":/);
  });

  it('implement-dispatch documents opt-ins, materialization, and cluster lifecycle', () => {
    const skill = read('skills/implement-dispatch/SKILL.md');
    assert.match(skill, /Recommended Follow-ups \(Default: Included\)/);
    assert.match(skill, /Out-of-Scope \/ Adjacent Items \(Default: Excluded\)/);
    assert.match(skill, /\[R#\]\s*\[x\]/);
    assert.match(skill, /\[O#\]\s*\[ \]/);
    assert.match(skill, /materialize/i);
    assert.match(skill, /independence clusters/i);
    assert.match(skill, /C-<sha256/);
    assert.match(skill, /parentTaskId/);
    assert.match(skill, /cannot\s+exceed\s+three|capped\s+at\s+three/is);
  });

  it('dispatch-code-review documents standalone fix clustering', () => {
    const skill = read('skills/dispatch-code-review/SKILL.md');
    assert.match(skill, /independence clusters/i);
    assert.match(skill, /pairwise disjoint/i);
    assert.match(skill, /same-file.*separate/is);
  });

  it('shared resolution-log and fix-clustering scripts exist and export required contracts', async () => {
    const resLog = await import('../../skills/dispatch/scripts/resolution-log.mjs');
    assert.equal(typeof resLog.scanResolutionLog, 'function');
    assert.equal(typeof resLog.validateApplicationRecord, 'function');
    assert.equal(typeof resLog.formatApplicationRecord, 'function');

    const fixClustering = await import('../../skills/dispatch/scripts/fix-clustering.mjs');
    assert.equal(typeof fixClustering.computeClusterId, 'function');
    assert.equal(typeof fixClustering.createIndependenceClusters, 'function');
    assert.equal(typeof fixClustering.splitFailedCluster, 'function');
    assert.equal(typeof fixClustering.formatOptInSections, 'function');
    assert.equal(typeof fixClustering.parseOptInResponse, 'function');
  });
});
