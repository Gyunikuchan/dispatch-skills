import assert from 'node:assert/strict';
import { test } from 'node:test';

test('walkthrough rendering', async () => {
  const { renderWalkthrough } = await import('../../../skills/dispatch/scripts/toolkit/walkthrough.ts');
  const hash = 'a'.repeat(64);
  const view = {
    title: 'Report plan',
    specPath: 'spec/report.spec.md',
    specHash: `sha256:${hash}`,
    planPath: 'plans/report.plan.md',
    delivered: { integrated: 2, total: 3, to: 'abcdef1234567890', branch: 'main' },
    statuses: [
      { criterion: 'verified-first', state: 'verified' as const, evidence: 'evidence/first.json' },
      { criterion: 'verified-second', state: 'verified' as const, evidence: 'evidence/second.json' },
      { criterion: 'manual-result', state: 'manual' as const, seq: 3, quote: 'manual | quote\n<!-- x -->', evidence: 'manual/proof.md' },
      { criterion: 'waived-result', state: 'waived' as const, seq: 4, quote: 'waiver quote', reason: 'accepted exception' },
      { criterion: 'missing-result', state: 'missing' as const },
    ],
    changes: [
      { action: 'MODIFY' as const, path: 'skills/dispatch/scripts/toolkit/evidence.ts', owners: [{ id: 'unit-task', title: 'Criterion behavior' }] },
      { action: 'NEW' as const, path: 'skills/dispatch/scripts/toolkit/walkthrough.ts', owners: [{ id: 'renderer-task', title: 'Walkthrough output' }] },
    ],
    edits: [
      { seq: 1, artifact: 'plan', class: 'non-intent', rationale: 'Added an evidence edge case.', diffRef: 'diff/1.patch', affects: ['unit-task'] },
      { seq: 2, artifact: 'design', class: 'non-intent', rationale: 'Recorded the renderer boundary.', diffRef: 'diff/2.patch', affects: ['renderer-task'] },
      { seq: 3, artifact: 'plan', class: 'clarification', rationale: 'Named the output section.', diffRef: 'diff/3.patch', affects: [] },
    ],
    unplannedPaths: ['src/orphan.ts'],
    openEscalations: [{ id: 'E-1', summary: 'Confirm the remaining owner.' }],
    deferredRulings: [{ review: 'review-alpha', finding: 'R1-F010' }],
    userRecords: [{ seq: 7, kind: 'manual-complete', summary: 'manual-result evidence', quote: 'the user approved this row' }],
    reviewRows: [
      { review: 'review-alpha', id: 'R1-F001', round: 1, severity: 'should', ruling: 'accepted' as const, recurrence: 'R1-F001', rationale: '🙂'.repeat(500) },
      { review: 'review-alpha', id: 'R1-F002', round: 1, severity: 'must', ruling: null, unresolved: 'R1-F002', rationale: 'Awaiting evidence.' },
    ],
    findingsPaths: [{ review: 'review-alpha', path: '.state/reviews/review-alpha/findings.json' }],
  };
  const rendered = renderWalkthrough(view);
  const section = (heading: string, nextHeading: string) => rendered.slice(rendered.indexOf(heading), rendered.indexOf(nextHeading));

  assert.ok(rendered.includes('> **Delivered:** 2 of 3 tasks integrated; delivered abcdef123456 to main'));
  assert.ok(rendered.includes(`> **Spec:** spec/report.spec.md · sha256:${hash}`));
  assert.ok(rendered.includes('> **Plan:** plans/report.plan.md'));
  assert.ok(rendered.includes('> **Status:** 4/5 SC satisfied (verified 2 · manual 1 · waived 1)'));
  assert.ok(rendered.includes('> **Deviations:** 3 recorded'));

  const verification = section('## Verification', '## Deviations & Follow-ups');
  const verified = section('### Verified', '### Manual');
  const manual = section('### Manual', '### Waived');
  const waived = section('### Waived', '### Missing');
  const missing = verification.slice(verification.indexOf('### Missing'));
  assert.ok(verified.includes('verified-first') && verified.includes('verified-second'));
  assert.ok(!verified.includes('manual-result') && !verified.includes('waived-result') && !verified.includes('missing-result'));
  assert.ok(manual.includes('manual-result') && manual.includes('manual/proof.md'));
  assert.ok(!manual.includes('verified-first') && !manual.includes('waived-result'));
  assert.ok(manual.includes('manual \\| quote &lt;!-- x --&gt;'));
  assert.ok(waived.includes('waived-result') && waived.includes('accepted exception') && waived.includes('waiver quote'));
  assert.ok(!waived.includes('manual-result') && !waived.includes('missing-result'));
  assert.ok(missing.includes('missing-result') && missing.includes('no eligible evidence'));
  assert.ok(!missing.includes('verified-first') && !missing.includes('waived-result'));

  const changes = section('## Changes Made', '## Verification');
  assert.ok(changes.includes('[MODIFY] `skills/dispatch/scripts/toolkit/evidence.ts`'));
  assert.ok(changes.includes('unit-task — Criterion behavior'));
  assert.ok(changes.includes('[NEW] `skills/dispatch/scripts/toolkit/walkthrough.ts`'));
  const deviations = section('## Deviations & Follow-ups', '## User-Attributed Records');
  assert.equal((deviations.match(/- Deviation: plan edit/g) ?? []).length, 2);
  assert.equal((deviations.match(/- Deviation: design edit/g) ?? []).length, 1);
  assert.ok(deviations.includes('diff diff/1.patch; affects unit-task'));
  assert.ok(deviations.includes('- Deviation: unplanned change src/orphan.ts'));
  assert.ok(deviations.includes('- Follow-up: escalation E-1: Confirm the remaining owner.'));
  assert.ok(deviations.includes('- Follow-up: deferred review-alpha:R1-F010'));

  const userRecords = section('## User-Attributed Records', '## Review Findings & Resolutions');
  assert.ok(userRecords.includes('| 7 | manual-complete | manual-result evidence | the user approved this row |'));
  const reviews = rendered.slice(rendered.indexOf('## Review Findings & Resolutions'));
  assert.ok(reviews.includes('| review-alpha | R1-F001 | 1 | should | Accepted (recurs R1-F001) |'));
  assert.ok(reviews.includes('| review-alpha | R1-F002 | 1 | must | Open (unresolved R1-F002) |'));
  assert.ok(reviews.includes(`| ${'🙂'.repeat(79)}… |`));
  assert.ok(!reviews.includes('🙂'.repeat(80)));
  assert.ok(reviews.includes('Findings: .state/reviews/review-alpha/findings.json'));

  const withoutIntegration = renderWalkthrough({
    ...view,
    delivered: null,
    changes: [],
    edits: [],
    unplannedPaths: [],
    openEscalations: [],
    deferredRulings: [],
    userRecords: [],
    reviewRows: [],
    findingsPaths: [],
  });
  assert.ok(withoutIntegration.includes('> **Delivered:** not delivered'));
  assert.ok(withoutIntegration.includes('> **Deviations:** none'));
  assert.ok(withoutIntegration.includes('## Changes Made\n\nNone.'));
  assert.ok(withoutIntegration.includes('*No reviews conducted yet.*'));
});
