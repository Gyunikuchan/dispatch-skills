import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { rootMachine, type RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import { beginReview, stepReview } from '../../../skills/dispatch/scripts/machines/review.ts';
import { classificationState } from '../machines/fixtures/implement-recovery.ts';
import { started } from '../machines/fixtures/design-delivery.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { memoryRunFs } from '../../helpers/memory-run-fs.ts';
import { renderReport, renderWalkthrough } from '../../../skills/dispatch/scripts/domain/render.ts';
import { governedPlanText } from '../../../skills/dispatch/scripts/domain/plan.ts';
import { send } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { start } from '../../helpers/governed-start.ts';
import type { Handlers } from '../../../skills/dispatch/scripts/core/types.ts';
import { parseArtifact } from '../../../skills/dispatch/scripts/effects/parse-artifact.ts';
import { design, hash, run } from '../machines/fixtures/design.ts';
import { PLAN } from './fixtures/flow-implement.ts';

test('readable review rendering: non-plan consumers retain full findings', () => {
  const rounds = [{ round: 1, reviewers: ['reader'].map(slot => ({ slot })), failed: [], entries: [{ id: 'R1-F001', severity: 'SHOULD' as const, status: 'accepted' as const, sources: ['reader'], locus: 'src/a.ts:L1', category: 'correctness', defect: 'Missing check. Full detail remains here.', requiredChange: 'Add check.' }] }];
  const report = renderReport({ title: 'Design', kind: 'design', target: 'design.md', summary: 'Reviewed', rounds });
  const walkthrough = renderWalkthrough({ title: 'Done', delivered: 'Check', parent: 'plan.md', status: '1/1 SC passing', changes: [], verification: [], finalGate: 'passed', deviations: [], followUps: [], revisions: [], rounds });
  for (const text of [report, walkthrough]) { assert.match(text, /Finding: Missing check. Full detail remains here./); assert.match(text, /Required change: Add check./); assert.ok(!text.includes('Finding excerpt:')); }
});

test('readable artifact ownership: standalone, active and completed design children share idempotent plan resolution rendering', () => {
  const ports = fakePorts(), session = tempDir(), planPath = path.join(session, 'increment.plan.md');
  memoryRunFs(ports, session);
  const begun = beginReview({ kind: 'plan', target: planPath, cap: 1, breadth: 1, context: '', roster: [], timeoutMs: 1000 }, 'plan.review', {}).state;
  if (!('c' in begun)) throw new Error('review');
  const planReview = stepReview({ tag: 'rule', c: { ...begun.c, round: 1, rounds: [{ round: 1, scope: 'full', reviewers: ['reader'], failed: [] }], findings: [{ id: 'R1-F001', round: 1, status: 'open', severity: 'SHOULD', category: 'correctness', locus: 'src/a.ts:L1', defect: 'Missing check. Complete explanation.', requiredChange: 'Add check', sources: ['reader'], scope: 'in' }] } }, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept', reason: 'Added check\nKeep API' } } }).state;
  const implementation = { ...classificationState(), c: { ...classificationState().c, planPath, planReview } };
  const active = started();
  if (active.tag !== 'increment') throw new Error('design');
  const run = { verb: 'implement' as const, argument: 'x.design.md', slug: 'feature' };
  const states: RootState[] = [
    { tag: 'implement', run, child: implementation },
    { tag: 'design', run, child: { ...active, child: implementation } },
    { tag: 'design', run, child: { tag: 'complete', c: { ...active.c, histories: { I01: [{ tag: 'complete', c: implementation.c, summary: 'Done' }] } }, summary: 'Done' } },
  ];
  for (const state of states) {
    ports.fs.writeAtomic(planPath, '# Increment\n');
    rootMachine.render!(state, ports, session);
    const rendered = ports.fs.readText(planPath), log = ports.fs.readText(path.join(session, 'increment.review-log.md'));
    assert.match(log, /Finding: Missing check. Complete explanation./);
    assert.match(log, /Required change: Add check/);
    assert.match(log, /Added check  \n  Keep API/);
    assert.ok(!rendered.includes('Required change:'));
    assert.ok(!rendered.includes('Full report:'));
    assert.equal(ports.fs.exists(path.join(session, 'plan-review-' + path.basename(session) + '-plan.review.report.md')), false);
    assert.match(rendered, /## Review Findings & Resolutions[\s\S]*\| R1-F001 \| 1 \| SHOULD \| Accepted \| Added check \|/);
    let writes = 0;
    const original = ports.fs.writeAtomic;
    ports.fs.writeAtomic = (file, text) => { writes++; original(file, text); };
    rootMachine.render!(state, ports, session);
    ports.fs.writeAtomic = original;
    assert.equal(writes, 0);
  }
});


test('standalone artifact reviews record history in the review log and preserve successive runs', () => {
  const ports = fakePorts(), session = tempDir(), target = path.join(session, 'feature.plan.md');
  memoryRunFs(ports, session);
  ports.fs.writeAtomic(target, '# Feature\n\n## Review Findings & Resolutions\nNo reviews conducted yet.\n\n## Out of Scope\nkeep\n');
  for (const kind of ['plan', 'design'] as const) {
    const begun = beginReview({ kind, target, cap: 1, breadth: 1, context: '', roster: [], timeoutMs: 1000 }, 'review', {}).state;
    if (!('c' in begun)) throw new Error('review');
    const review = { tag: 'rule' as const, c: { ...begun.c, round: 1, rounds: [{ round: 1, scope: 'full' as const, reviewers: ['reader'], failed: [] }], findings: [] } };
    const state: RootState = { tag: 'review', run: { verb: 'review', argument: target, slug: 'feature' }, child: review };
    const runDir = path.join(session, kind);
    rootMachine.render!(state, ports, runDir);
    const first = ports.fs.readText(target);
    rootMachine.render!(state, ports, runDir);
    assert.equal(ports.fs.readText(target), first);
    assert.equal(ports.fs.exists(path.join(runDir, 'feature.report.md')), false);
  }
  const rendered = ports.fs.readText(target);
  assert.equal((ports.fs.readText(path.join(session, 'feature.review-log.md')).match(/^### Review /gm) ?? []).length, 2);
  assert.match(rendered, /Reviews: 2 · Rounds: 2 · Findings: 0 · Full log: \[feature\.review-log\.md\]/);
  assert.ok(!rendered.includes('No reviews conducted yet.'));
  assert.match(rendered, /## Out of Scope\nkeep/);
});


test('readable artifact ownership: code review records findings in its governing walkthrough', () => {
  const ports = fakePorts(), session = tempDir(), target = path.join(session, 'feature.walkthrough.md');
  memoryRunFs(ports, session);
  ports.fs.writeAtomic(target, '# Delivered\n');
  const begun = beginReview({ kind: 'code', target: 'HEAD', cap: 1, breadth: 1, context: '', roster: [], timeoutMs: 1000, governing: { planPath: 'feature.plan.md', walkthroughPath: target, criteria: [] } }, 'review', {}).state;
  if (!('c' in begun)) throw new Error('review');
  const state: RootState = { tag: 'review', run: { verb: 'review', argument: 'HEAD', slug: 'feature' }, child: { tag: 'rule', c: { ...begun.c, round: 1, rounds: [{ round: 1, scope: 'full', reviewers: ['reader'], failed: [] }] } } };
  rootMachine.render!(state, ports, session);
  assert.match(ports.fs.readText(target), /## Review Findings & Resolutions\n\nReviews: 1 · Rounds: 1 · Findings: 0 · Full log:/);
  assert.match(ports.fs.readText(path.join(session, 'feature.walkthrough.review-log.md')), /## Review Findings & Resolutions[\s\S]*No findings/);
  assert.equal(ports.fs.exists(path.join(session, 'feature.report.md')), false);
});


test('readable artifact ownership: walkthrough regeneration retains later standalone review history without duplicating implementation rounds', () => {
  const ports = fakePorts(), session = tempDir(), target = path.join(session, 'feature.walkthrough.md');
  memoryRunFs(ports, session);
  const implementation = { tag: 'complete' as const, c: classificationState().c, summary: 'Done' };
  const state: RootState = { tag: 'implement', run: { verb: 'implement', argument: 'feature.plan.md', slug: 'feature' }, child: implementation };
  rootMachine.render!(state, ports, session);
  const logPath = path.join(session, 'feature.walkthrough.review-log.md');
  ports.fs.writeAtomic(logPath, '# Review log\n\n## Review Findings & Resolutions\n\n### Review later-review\n\n#### Round 1\n- No findings.\n');
  rootMachine.render!(state, ports, session);
  const log = ports.fs.readText(logPath), updated = ports.fs.readText(target);
  assert.match(log, /### Review later-review/);
  assert.equal((log.match(/\/implementation/g) ?? []).length, 1);
  assert.match(updated, /Reviews: 2 · Rounds: 1 · Findings: 0 · Full log:/);
  rootMachine.render!(state, ports, session);
  assert.equal(ports.fs.readText(target), updated);
  assert.equal(ports.fs.readText(logPath), log);
});


test('readable artifact ownership: design integration records review history in the owning design', () => {
  const ports = fakePorts(), session = tempDir(), target = path.join(session, 'feature.design.md');
  memoryRunFs(ports, session);
  ports.fs.writeAtomic(target, '# Design\n');
  const begun = beginReview({ kind: 'code', target: 'HEAD', cap: 1, breadth: 1, context: '', roster: [], timeoutMs: 1000 }, 'design.integration', {}).state;
  if (!('c' in begun)) throw new Error('review');
  const integrationReview = { tag: 'rule' as const, c: { ...begun.c, round: 1, rounds: [{ round: 1, scope: 'full' as const, reviewers: ['reader'], failed: [] }] } };
  const active = started();
  const state: RootState = { tag: 'design', run: { verb: 'implement', argument: target, slug: 'feature' }, child: { tag: 'complete', c: { ...active.c, path: target, integrationReview }, summary: 'Done' } };
  rootMachine.render!(state, ports, session);
  assert.match(ports.fs.readText(path.join(session, 'feature.review-log.md')), /## Review Findings & Resolutions[\s\S]*design.integration[\s\S]*No findings/);
  assert.match(ports.fs.readText(target), /Reviews: 1 · Rounds: 1 · Findings: 0 · Full log:/);
  assert.equal(ports.fs.exists(path.join(session, 'feature-integration.report.md')), false);
});


test('task-map-authored: design increment plan keeps its authored Task Map after authoring', async () => {
  const ports = fakePorts(), session = tempDir(), runs = path.join(session, '.state', 'runs');
  memoryRunFs(ports, session);
  const handlers: Handlers = {
    'parse-artifact': async (effect) => effect.artifact === 'plan' ? parseArtifact(effect, ports, { runDir: session, attempt: 1 }) : [{ type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'design', hash, parsed: design, defects: [] }],
    snapshot: async (effect) => [{ type: 'SNAPSHOT', effectId: effect.id, fingerprint: { head: 'a'.repeat(40), index: 'i', worktree: 'w' }, diff: { paths: [] } }],
    handoff: async (effect) => [{ type: 'HANDOFF_DONE', effectId: effect.id, destination: '/handoff', warning: null }],
  };
  const authorDir = path.join(runs, '001-design');
  await start({ ports, machine: rootMachine, handlers, runDir: authorDir, runStarted: { ...run(), argument: 'A free-text topic', overrides: { path: 'x.design.md' } } });
  await send({ ports, machine: rootMachine, handlers, runDir: authorDir, rawEvent: { type: 'AUTHORED', path: 'x.design.md' } });
  await send({ ports, machine: rootMachine, handlers, runDir: authorDir, rawEvent: { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Approved design', hash } } });
  const implementDir = path.join(runs, '002-implement');
  const author = await start({ ports, machine: rootMachine, handlers, runDir: implementDir, runStarted: { ...run('implement'), argument: './x.design.md', overrides: { designRevision: hash } } });
  assert.equal(author.frame?.await, 'author');
  const planPath = String(author.frame?.data['path']), designPath = String((author.frame?.data['governedDesign'] as { path: string }).path);
  ports.fs.writeAtomic(planPath, PLAN.replace('# Normalize values', '# First increment')
    .replace(/^> \*\*Parent:\*\* `[^`]+\.spec\.md` · sha256:[a-f0-9]{64}$/m, `> **Parent:** \`${designPath}\` · I01`)
    .replace('- Approved revision: none', `- Approved revision: ${hash}\n- Increment ID and inherited contract: I01 — First behavior\n- Prerequisite evidence: none\n- Acceptance mapping: SC1`)
    .replaceAll('src/value.ts', 'src/a.ts'));
  const governed = governedPlanText(ports.fs.readText(planPath));
  const authored = await send({ ports, machine: rootMachine, handlers, runDir: implementDir, rawEvent: { type: 'AUTHORED', path: planPath } });
  assert.notEqual(authored.frame?.await, 'author', JSON.stringify(authored.frame));
  const text = ports.fs.readText(planPath);
  assert.match(text, /## Task Map\n[\s\S]*\| T1 \| Normalize values \| Values are normalized before use so downstream comparisons agree\. \| none \| SC1 \|/);
  assert.equal(governedPlanText(text), governed, 'root rendering preserves the authored map and hash');
});


test('revision-review-log: a reviewed design revision keeps the source review history in its own linked log', () => {
  const ports = fakePorts(), session = tempDir(), source = path.join(session, 'x.design.md'), workingPath = path.join(session, 'revision-1.design.md');
  memoryRunFs(ports, session);
  ports.fs.writeAtomic(source, '# Design\n');
  const reviewed = (target: string, machinePath: string, defect: string) => {
    const begun = beginReview({ kind: 'design', target, cap: 1, breadth: 1, context: '', roster: [], timeoutMs: 1000 }, machinePath, {}).state;
    if (!('c' in begun)) throw new Error('review');
    return stepReview({ tag: 'rule', c: { ...begun.c, round: 1, rounds: [{ round: 1, scope: 'full', reviewers: ['reader'], failed: [] }], findings: [{ id: 'R1-F001', round: 1, status: 'open', severity: 'SHOULD', category: 'correctness', locus: 'x.design.md', defect, requiredChange: 'Fix it', sources: ['reader'], scope: 'in' }] } }, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'accept', reason: 'Fixed' } } }).state;
  };
  const active = started();
  const c = { ...active.c, path: source };
  const run = { verb: 'design' as const, argument: source, slug: 'x' };
  rootMachine.render!({ tag: 'design', run, child: { tag: 'review', c, review: reviewed(source, 'design.review', 'Original design gap.') } }, ports, path.join(session, 'run-1'));
  assert.match(ports.fs.readText(source), /Full log: \[x\.review-log\.md\]/);
  const revision = { tag: 'review' as const, c, workingPath, reason: 'repair', evidence: 'finding', review: reviewed(workingPath, 'design.revision.review', 'Revision design gap.') };
  rootMachine.render!({ tag: 'design', run, child: { tag: 'revision', c, child: revision } }, ports, path.join(session, 'run-2'));
  const revised = ports.fs.readText(workingPath), log = ports.fs.readText(path.join(session, 'revision-1.review-log.md'));
  assert.match(revised, /Reviews: 2 · Rounds: 2 · Findings: 2 [^\n]*Full log: \[revision-1\.review-log\.md\]/);
  assert.match(log, /Original design gap\.[\s\S]*Revision design gap\./);
  assert.match(ports.fs.readText(path.join(session, 'x.review-log.md')), /Original design gap\./);
  assert.doesNotMatch(ports.fs.readText(path.join(session, 'x.review-log.md')), /Revision design gap\./);
});
