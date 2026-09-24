// Shared fixtures for scripted*.test.mjs: stub-dispatch configs, cached fixtures, and trace assertions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { evaluateConsensus } from '../../skills/dispatch/scripts/review/consensus.mjs';
import { splitDispatchFrontmatter } from '../../skills/dispatch/scripts/review/resolution-log.mjs';
import { createStubDispatchFixture } from './stub-dispatch-fixture.mjs';
import { allProviders, makeGitRepo, report } from './driver-harness.mjs';

export const ALL = (value) => ({ low: value, medium: value, high: value, xhigh: value, max: value });
export const phase = ({ rounds = 1, targets = 1, consensus = false } = {}) => ({ rounds: ALL(rounds), targets: ALL(targets), consensus: ALL(consensus) });
export const DELEGATES = {
  agy: { targets: [{ low: { model: 'gemini-3.7-flash', effort: 'medium' } }] },
  opencode: { targets: [{ low: { model: 'opencode-go/glm-5.3-flash', effort: 'max' } }] },
};
export const config = (phaseOpts = {}, delegates = DELEGATES) => ({
  'read-delegates': delegates,
  phases: { 'plan-review': phase(phaseOpts), 'code-review': phase(phaseOpts) },
});

export const cleanups = [];
const fixtures = new Map();
/** Per-test cleanup; register with afterEach. */
export function cleanupScriptedRepos() { for (const fn of cleanups.splice(0)) fn(); }
/** Stub fixtures are cached per config across one file's tests; register with after. */
export function disposeScriptedFixtures() { for (const fixture of fixtures.values()) fixture.cleanup(); fixtures.clear(); }

export function setup(cfg, repoOpts) {
  const key = JSON.stringify(cfg);
  let fixture = fixtures.get(key);
  if (!fixture) {
    fixture = createStubDispatchFixture(cfg);
    fixtures.set(key, fixture);
  }
  const repo = makeGitRepo(repoOpts);
  cleanups.push(repo.cleanup);
  return { fixture, repo };
}

export const actions = (trace) => trace.map((a) => a.action);
export const launches = (trace, type) => trace.filter((a) => a.action === 'launch' && (!type || a.wave.type === type));
export const firstReview = (waveReport) => (action) =>
  action.wave.type === 'review' && action.wave.round === 1 ? allProviders(waveReport) : allProviders(report());

export function walkthroughIn(repoDir) {
  const dir = path.join(repoDir, '.scratch', 'plan');
  const found = fs.readdirSync(dir).filter((name) => name.endsWith('-walkthrough.md'));
  assert.equal(found.length, 1, `one walkthrough expected, found ${found.join(', ')}`);
  return path.join(dir, found[0]);
}

/** Asserts the resolution log carries a round with a Sources line, consensus exits 0, and metadata is checkpointed. */
export function assertSettledAndCheckpointed(artifact, done, kind) {
  assert.equal(done.outcome, 'complete', JSON.stringify(done));
  assert.equal(done.checkpointed, true);
  const markdown = fs.readFileSync(artifact, 'utf8');
  assert.match(markdown, /### Round 1\b/);
  assert.match(markdown, /\*\*Sources:\*\* \{/);
  assert.equal(evaluateConsensus(markdown).exit, 0);
  if (kind !== 'code') {
    const { metadata } = splitDispatchFrontmatter(markdown);
    assert.equal(metadata?.kind, kind);
    assert.match(metadata.contentHash, /^sha256:/);
  }
}
