import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { appendRecord, foldLedger } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { artifactHash } from '../../../skills/dispatch/scripts/toolkit/artifacts.ts';
import { governedPlanText } from '../../../skills/dispatch/scripts/toolkit/domain/plan.ts';
import { governedDesignText } from '../../../skills/dispatch/scripts/toolkit/domain/design.ts';
import { nodeLinkFs } from '../../../skills/dispatch/scripts/lib/node-fs-ext.ts';
import { CLEAN, CONTEXT_MAP, fixture, report } from '../../helpers/review-fixture.ts';

// SECTION: Ceiling helpers shared with review.test.ts (duplicated for split)
type ReviewFixture = Awaited<ReturnType<typeof fixture>>;
const PLAN_REVIEW = 'plan-work.plan';
const ceilingId = (review: string, ceiling: number) => 'ceiling:' + review + ':' + ceiling;
const addRecord = (f: ReviewFixture, record: object) => appendRecord(f.session, record, f.deps);
const openCeiling = (f: ReviewFixture, review: string, ceiling: number) => addRecord(f, { kind: 'escalation', by: 'tool', key: ceilingId(review, ceiling), data: { id: ceilingId(review, ceiling), state: 'open', summary: 'ceiling ' + ceiling + ' reached' } });
const resolveCeiling = (f: ReviewFixture, review: string, ceiling: number, summary: string, options: { by?: string; quote?: string; key?: string } = {}) => addRecord(f, { kind: 'escalation', by: options.by ?? 'user', quote: options.quote ?? 'User decision', key: options.key ?? ceilingId(review, ceiling) + ':resolved', data: { id: ceilingId(review, ceiling), state: 'resolved', summary } });

test('plan and design review launch without a sibling context map', async () => {
  const f=await fixture();try {
    const orphan=f.artifact('orphan.plan.md','# Orphan\n## Work\nNo grounding.\n');
    const plan=await f.call('plan',orphan);
    assert.equal(plan.exit,0,JSON.stringify(plan));
    assert.equal(f.launches.length,2);
    for (const launch of f.launches) assert.doesNotMatch(fs.readFileSync(launch.request.promptPath,'utf8'),/Context Map/);

    const design=f.artifact('orphan.design.md','# Design\n## Boundaries\nSingle writer.\n');
    const designReview=await f.call('design',design);
    assert.equal(designReview.exit,0,JSON.stringify(designReview));
    assert.equal(f.launches.length,4);
    for (const launch of f.launches.slice(2)) assert.doesNotMatch(fs.readFileSync(launch.request.promptPath,'utf8'),/Context Map/);
  }finally{f.cleanup();}
});

test('plan and design review refuse without a user confirm of the current spec at every level', async () => {
  // Unbound plan review without a spec refuses with lint-errors before zero-round skip
  {
    const f = await fixture(false, false);
    try {
      const refused = await f.call('plan', f.plan, 'low');
      assert.equal(refused.exit, 4);
      assert.equal(refused.output.reason, 'lint-errors');
      assert.equal(f.launches.length, 0);
    } finally { f.cleanup(); }
  }
  const f=await fixture(true,false);try {
    for(const level of ['low','medium']) {
      const refused=await f.call('plan',f.plan,level);
      assert.equal(refused.exit,4,level);assert.equal(refused.output.reason,'missing-confirmation',level);
    }
    const design=f.artifact('work.design.md','# Design\n## Boundaries\nSingle writer.\n');
    const refusedDesign=await f.call('design',design,'medium');
    assert.equal(refusedDesign.exit,4);assert.equal(refusedDesign.output.reason,'missing-confirmation');
    assert.equal(f.launches.length,0);
    await f.confirm();
    assert.equal((await f.call()).exit,0);
    fs.appendFileSync(f.spec,'\n## Scope\nChanged intent without a recorded edit.\n');
    const stale=await f.call();
    assert.equal(stale.exit,4);assert.equal(stale.output.reason,'missing-confirmation');
  }finally{f.cleanup();}
});

test('plan reviewer reads governed text without findings history', async () => {
  const f = await fixture();
  try {
    const original = fs.readFileSync(f.plan, 'utf8');
    const result = await f.call();
    assert.equal(result.exit, 0, JSON.stringify(result.output));
    const inputPath = path.join(f.directory, 'round-1.input.md');
    assert.ok(fs.existsSync(inputPath));
    const input = fs.readFileSync(inputPath, 'utf8');
    assert.doesNotMatch(input, /Review Findings & Resolutions/);
    assert.doesNotMatch(input, /Driver log\./);
    assert.equal(input, governedPlanText(original));
    const prompt = fs.readFileSync(f.launches[0]!.request.promptPath, 'utf8');
    assert.ok(prompt.includes(inputPath));
    assert.ok(prompt.includes('- Plan: ' + inputPath));
    assert.equal(f.read(1, 'round.json').target, artifactHash('plan', original));
    assert.equal(path.basename(f.directory), 'plan-work.plan');
    assert.equal(fs.readFileSync(path.join(f.directory, 'round-1', 'target.snapshot.md'), 'utf8'), original);
  } finally { f.cleanup(); }
});

test('design reviewer reads governed text without findings history', async () => {
  const f = await fixture();
  try {
    const design = f.artifact('strategy.design.md', '# Strategy\n## Approach\nOne boundary.\n## Execution Status\nNext Action: act.\n## Review Findings & Resolutions\nDriver notes.\n');
    f.artifact('strategy.design.context.md', CONTEXT_MAP);
    const original = fs.readFileSync(design, 'utf8');
    const result = await f.call('design', design);
    assert.equal(result.exit, 0, JSON.stringify(result.output));
    const reviewDir = path.join(f.session, '.state/reviews/design-strategy.design');
    const inputPath = path.join(reviewDir, 'round-1.input.md');
    assert.ok(fs.existsSync(inputPath));
    const input = fs.readFileSync(inputPath, 'utf8');
    assert.doesNotMatch(input, /Review Findings & Resolutions/);
    assert.doesNotMatch(input, /Driver notes\./);
    assert.doesNotMatch(input, /## Execution Status/);
    assert.equal(input, governedDesignText(original));
    const prompt = fs.readFileSync(f.launches[0]!.request.promptPath, 'utf8');
    assert.ok(prompt.includes(inputPath));
    assert.equal(JSON.parse(fs.readFileSync(path.join(reviewDir, 'round-1/round.json'), 'utf8')).target, artifactHash('design', original));
  } finally { f.cleanup(); }
});

test('reviewer input write failure refuses the round before launch', async () => {
  const f = await fixture();
  try {
    fs.mkdirSync(f.directory, {recursive: true});
    fs.mkdirSync(path.join(f.directory, 'round-1.input.md'), {recursive: true});
    const result = await f.call();
    assert.notEqual(result.exit, 0);
    assert.equal(f.launches.length, 0);
    assert.equal(fs.existsSync(path.join(f.directory, 'round-1', 'findings.json')), false);
  } finally { f.cleanup(); }
});

test('resumed round reuses the same input path and bytes', async () => {
  const f = await fixture();
  try {
    f.deps.hook = () => { throw new Error('Interrupted'); };
    const hookPoint = 'review:after-pending';
    const wrapped = f.deps.hook;
    f.deps.hook = (point: string) => { if (point === hookPoint) return wrapped(point); };
    assert.equal((await f.call()).exit, 2);
    const inputPath = path.join(f.directory, 'round-1.input.md');
    assert.ok(fs.existsSync(inputPath));
    const before = fs.readFileSync(inputPath, 'utf8');
    assert.doesNotMatch(before, /Review Findings & Resolutions/);
    delete (f.deps as {hook?: unknown}).hook;
    const callsBefore = f.launches.length;
    const result = await f.call();
    assert.equal(result.exit, 0, JSON.stringify(result.output));
    assert.equal(fs.readFileSync(inputPath, 'utf8'), before);
    assert.equal(f.read(1, 'round.json').generation, 1);
    assert.ok(f.launches.length >= callsBefore);
    const prompt = fs.readFileSync(f.launches.at(-1)!.request.promptPath, 'utf8');
    assert.ok(prompt.includes(inputPath));
  } finally { f.cleanup(); }
});
