// SC3: review kind inference, level raise rule, and skip-when-disabled.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { inferReviewKind, resolveReviewLevel } from '../../../../skills/dispatch/scripts/driver/review-phase.mjs';
import { buildStubDispatchFixture } from '../../../helpers/stub-dispatch.mjs';
import { makeGitRepo, parseAction, runDispatch, writePlan } from '../../../helpers/driver-harness.mjs';

const ALL = (value) => ({ low: value, medium: value, high: value, xhigh: value, max: value });

let repo;
before(() => {
  repo = makeGitRepo();
  repo.git('tag', 'v1');
});
after(() => repo?.cleanup());

describe('review kind inference (design order 1–6)', () => {
  const infer = (argument) => inferReviewKind(argument, { cwd: repo.dir });

  it('1: *-design.md → design', () => {
    assert.equal(infer('.scratch/plan/2026-09-22-x-design.md').kind, 'design');
  });

  it('2: *-walkthrough.md → code scoped to the walkthrough (checked before the generic .md rule)', () => {
    const result = infer('.scratch/plan/2026-09-22-x-walkthrough.md');
    assert.equal(result.kind, 'code');
    assert.equal(result.walkthroughPath, '.scratch/plan/2026-09-22-x-walkthrough.md');
  });

  it('3: any other *.md → plan', () => {
    assert.equal(infer('.scratch/plan/2026-09-22-x.md').kind, 'plan');
    assert.equal(infer('docs/notes.md').kind, 'plan');
  });

  it('4: a Git revision or range → code over that range', () => {
    for (const range of ['HEAD', 'v1', 'v1..HEAD', 'HEAD~0']) {
      const result = infer(range);
      assert.equal(result.kind, 'code', range);
      assert.equal(result.range, range);
    }
  });

  it('5: no argument → code over uncommitted changes against HEAD', () => {
    for (const argument of [undefined, null, '']) {
      const result = infer(argument);
      assert.equal(result.kind, 'code');
      assert.equal(result.range ?? null, null);
    }
  });

  it('6: anything else fails naming the accepted forms', () => {
    assert.throws(() => infer('not-a-ref-or-markdown'), (err) => {
      assert.match(err.message, /\.md/);
      assert.match(err.message, /range|revision/i);
      return true;
    });
  });
});

describe('review level resolution (raise rule)', () => {
  const config = (phase) => ({ 'read-delegates': { agy: { targets: [{ low: { model: 'm', effort: 'medium' } }] } }, phases: { 'plan-review': phase } });
  const highOnly = { rounds: { low: 0, medium: 0, high: 2, xhigh: 2, max: 2 }, targets: ALL(1), consensus: ALL(false) };

  it('raises a classified level to the lowest level that enables the phase', () => {
    const result = resolveReviewLevel({ config: config(highOnly), kind: 'plan', level: 'low', levelSource: 'classified' });
    assert.equal(result.level, 'high');
    assert.equal(result.raised, true);
    assert.equal(result.skipped, null);
    assert.equal(result.phase, 'plan-review');
    assert.equal(result.configured, true);
  });

  it('raises the default source like classified', () => {
    const result = resolveReviewLevel({ config: config(highOnly), kind: 'plan', level: 'medium', levelSource: 'default' });
    assert.equal(result.level, 'high');
    assert.equal(result.raised, true);
  });

  it('never lowers an enabled classified level', () => {
    const result = resolveReviewLevel({ config: config(highOnly), kind: 'plan', level: 'max', levelSource: 'classified' });
    assert.equal(result.level, 'max');
    assert.equal(result.raised, false);
  });

  it('skips rather than demotes a classified level with no enabled level above it', () => {
    const lowOnly = { rounds: { low: 2, medium: 0, high: 0, xhigh: 0, max: 0 }, targets: ALL(1), consensus: ALL(false) };
    const result = resolveReviewLevel({ config: config(lowOnly), kind: 'plan', level: 'medium', levelSource: 'classified' });
    assert.equal(result.level, 'medium');
    assert.ok(result.skipped);
    assert.match(result.skipped.reason, /higher level/);
  });

  it('honors an explicit level that disables the phase by skipping with the level and config key', () => {
    const result = resolveReviewLevel({ config: config(highOnly), kind: 'plan', level: 'medium', levelSource: 'explicit' });
    assert.equal(result.level, 'medium');
    assert.equal(result.raised, false);
    assert.ok(result.skipped);
    assert.match(result.skipped.reason, /medium/);
    assert.match(result.skipped.reason, /phases\['plan-review'\]|plan-review/);
  });

  it('treats targets: 0 as disabled too', () => {
    const phase = { rounds: ALL(1), targets: { low: 0, medium: 0, high: 1, xhigh: 1, max: 1 }, consensus: ALL(false) };
    assert.equal(resolveReviewLevel({ config: config(phase), kind: 'plan', level: 'low', levelSource: 'classified' }).level, 'high');
  });

  it('skips a phase disabled at every level regardless of source', () => {
    const off = { rounds: ALL(0), targets: ALL(1), consensus: ALL(false) };
    for (const levelSource of ['classified', 'default', 'explicit']) {
      const result = resolveReviewLevel({ config: config(off), kind: 'plan', level: 'medium', levelSource });
      assert.ok(result.skipped, levelSource);
      assert.match(result.skipped.reason, /plan-review/);
    }
  });

  it('maps each kind to its <kind>-review phase and reports configured:false when absent', () => {
    const cfg = { 'read-delegates': { agy: { targets: [{ low: { model: 'm', effort: 'medium' } }] } }, phases: { 'code-review': { rounds: ALL(1), targets: ALL(1), consensus: ALL(false) } } };
    assert.equal(resolveReviewLevel({ config: cfg, kind: 'code', level: 'medium', levelSource: 'default' }).phase, 'code-review');
    const design = resolveReviewLevel({ config: cfg, kind: 'design', level: 'medium', levelSource: 'default' });
    assert.equal(design.phase, 'design-review');
    assert.equal(design.configured, false);
    assert.equal(design.skipped, null, 'an unconfigured phase falls back instead of skipping');
    assert.equal(design.level, 'medium');
  });
});

describe('driver skip and inference through dispatch.mjs', () => {
  let fixture;
  before(() => {
    fixture = buildStubDispatchFixture({
      'read-delegates': { agy: { targets: [{ low: { model: 'gemini-3.7-flash', effort: 'medium' } }] } },
      phases: {
        'plan-review': { rounds: { low: 0, medium: 0, high: 1, xhigh: 1, max: 1 }, targets: ALL(1), consensus: ALL(false) },
        'design-review': { rounds: ALL(0), targets: ALL(1), consensus: ALL(false) },
      },
    });
  });
  after(() => fixture?.cleanup());
  const run = (args) => runDispatch(fixture, args, { cwd: repo.dir });

  it('ends in done/skipped when an explicit level disables the phase', () => {
    const plan = writePlan(repo.dir, '2026-09-22-skip.md');
    const res = run(['--run', 'review', '--level', 'medium', '--level-source', 'explicit', '--orchestrator', 'claude', '--', plan]);
    assert.equal(res.status, 0, res.stderr);
    const action = parseAction(res.stdout);
    assert.equal(action.action, 'done');
    assert.equal(action.outcome, 'skipped');
    assert.match(action.reason, /medium/);
    assert.match(action.reason, /plan-review/);
    assert.equal(fs.readFileSync(plan, 'utf8').includes('### Round'), false, 'nothing was reviewed');
  });

  it('raises a classified level and launches instead of skipping', () => {
    const plan = writePlan(repo.dir, '2026-09-22-raise.md');
    const res = run(['--run', 'review', '--level', 'low', '--level-source', 'classified', '--orchestrator', 'claude', '--', plan]);
    assert.equal(res.status, 0, res.stderr);
    const action = parseAction(res.stdout);
    assert.equal(action.action, 'launch');
    const sidecar = JSON.parse(fs.readFileSync(action.stateFile.replace(/\.json$/, '.run.json'), 'utf8'));
    assert.equal(sidecar.kind, 'plan', 'kind inferred from *.md');
  });

  it('skips a design review disabled at every level (inferred from *-design.md)', () => {
    const design = path.join(repo.dir, '.scratch', 'plan', '2026-09-22-off-design.md');
    fs.writeFileSync(design, '# Design\n');
    const action = parseAction(run(['--run', 'review', '--orchestrator', 'claude', '--', design]).stdout);
    assert.equal(action.action, 'done');
    assert.equal(action.outcome, 'skipped');
    assert.match(action.reason, /design-review/);
  });

  it('fails an argument that is neither markdown nor a Git revision with exit 2', () => {
    const res = run(['--run', 'review', '--orchestrator', 'claude', '--', 'not-a-ref-or-markdown']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /\.md/);
  });
});
