import assert from 'node:assert/strict';
import { test } from 'node:test';

test('walkthrough preserves verification, deviations and user decisions', async () => {
  const { renderWalkthrough } = await import('../../../skills/dispatch/scripts/toolkit/walkthrough.ts');
  const hash = 'a'.repeat(64);
  const view = {
    title: 'Report plan',
    specPath: 'spec/report.spec.md',
    specHash: `sha256:${hash}`,
    planPath: 'plans/report.plan.md',
    delivered: { integrated: 2, total: 3, source:'123456abcdef7890', branch: 'main', ref: 'refs/dispatch/x/delivered-source' },
    glance: { what: 'The plan behaviour is visible to readers.', how: 'The walkthrough copies task bullets from the plan.' },
    tasks: [
      { id: 'unit-task', title: 'Criterion behavior', outcome: 'The task summary is visible.', behaviour: ['The parser records criterion behavior.'] },
      { id: 'renderer-task', title: 'Walkthrough output', outcome: 'The renderer keeps the report readable.', behaviour: ['File details stay collapsed under each task.'] },
    ],
    statuses: [
      { criterion: 'verified-first', state: 'verified' as const, evidence: 'evidence/first.json', reason: 'historical pre-prune evidence via validated pruning; source tree source; final evidence final.json' },
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
    reviewRounds: [{ review: 'review-alpha', round: 1, findings: 2, path: '.state/reviews/review-alpha/round-1/findings.json' }],
  };
  const rendered = renderWalkthrough(view);
  assert.match(rendered,/source 123456abcdef/);
  assert.match(rendered,/\[source evidence\]\(evidence\/first.json\)/);
  assert.match(rendered,/historical pre-prune evidence via validated pruning; source tree source; final evidence final.json/);
  const section = (heading: string, nextHeading: string) => rendered.slice(rendered.indexOf(heading), rendered.indexOf(nextHeading));

  assert.ok(rendered.includes('> **Delivered:** The plan behaviour is visible to readers.'));
  assert.ok(rendered.includes('> **Integration:** 2 of 3 tasks integrated; uncommitted changes from source 123456abcdef in main working tree; ref refs/dispatch/x/delivered-source'));
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
  assert.ok(reviews.includes('- Round 1 (review-alpha): 2 findings — [findings](.state/reviews/review-alpha/round-1/findings.json)'));

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
    reviewRounds: [],
  });
  assert.ok(withoutIntegration.includes('> **Delivered:** The plan behaviour is visible to readers.'));
  assert.ok(withoutIntegration.includes('> **Integration:** not delivered'));
  assert.ok(withoutIntegration.includes('> **Deviations:** none'));
  assert.ok(withoutIntegration.includes('### unit-task — Criterion behavior\n\n- The parser records criterion behavior.\n\n<details>\n\nNone.\n\n</details>'));
  assert.ok(withoutIntegration.includes('*No reviews conducted yet.*'));
});

test('walkthrough human layout: At a Glance, callouts and collapsed per-file changes', async () => {
  const { renderWalkthrough } = await import('../../../skills/dispatch/scripts/toolkit/walkthrough.ts');
  const view = {
    title: 'Human report', specPath: 'spec.md', specHash: 'sha256:abc', planPath: 'plan.md', delivered: null,
    glance: null,
    tasks: [
      { id: 'T1', title: 'Add a file', outcome: 'The new file supports the feature.', behaviour: [] },
      { id: 'T2', title: 'Update a file', outcome: 'The existing file handles the new case.', behaviour: [] },
      { id: 'T3', title: 'Remove an obsolete file', outcome: 'The unused file is removed.', behaviour: [] },
    ],
    statuses: [{ criterion: 'one', state: 'verified' as const, evidence: 'proof.json' }],
    changes: [
      { action: 'NEW' as const, path: 'new.ts', owners: [{ id: 'T1', title: 'Add a file' }] },
      { action: 'MODIFY' as const, path: 'change.ts', owners: [{ id: 'T2', title: 'Update a file' }] },
      { action: 'DELETE' as const, path: 'old.ts', owners: [{ id: 'T3', title: 'Remove an obsolete file' }] },
    ],
    edits: [], unplannedPaths: [], openEscalations: [], deferredRulings: [], userRecords: [], reviewRows: [], reviewRounds: [],
  };
  const clean = renderWalkthrough(view);
  assert.equal(clean.match(/^## .+$/m)?.[0], '## At a Glance');
  assert.ok(clean.includes('- **Delivered:** not delivered\n- **Criteria:** 1/1 satisfied (verified 1 · manual 0 · waived 0 · missing 0)\n- **Changes:** 3 files (1 new · 1 modified · 1 deleted)\n- **Deviations:** 0 recorded edits · 0 unplanned paths\n- **Follow-ups:** 0 open escalations · 0 deferred rulings\n- **Review:** 0 findings (0 open)'));
  assert.ok(clean.includes('### T1 — Add a file\n\n- The new file supports the feature.\n\n<details>\n\n#### [NEW] `new.ts`'));
  assert.ok(clean.includes('#### [DELETE] `old.ts`'));
  assert.ok(clean.includes('\n</details>\n\n## Verification'));
  assert.ok(!clean.includes('<summary>'));
  assert.ok(!clean.includes('[!NOTE]') && !clean.includes('[!IMPORTANT]'));
  const cases = [
    { patch: { statuses: [{ criterion: 'missing', state: 'missing' as const }] }, text: '1 missing criteria' },
    { patch: { statuses: [{ criterion: 'manual', state: 'manual' as const, seq: 1, quote: 'yes' }] }, text: '1 manual criteria' },
    { patch: { statuses: [{ criterion: 'waived', state: 'waived' as const, seq: 1, quote: 'yes' }] }, text: '1 waived criteria' },
    { patch: { unplannedPaths: ['extra.ts'] }, text: '1 unplanned paths' },
    { patch: { edits: [{ seq: 1, artifact: 'plan', class: 'clarification', rationale: 'clarified', diffRef: 'edit.patch', affects: [] }] }, text: '1 recorded deviations' },
    { patch: { deferredRulings: [{ review: 'review', finding: 'finding' }] }, text: '1 deferred rulings' },
  ];
  for (const { patch, text } of cases) {
    const rendered = renderWalkthrough({ ...view, ...patch });
    assert.equal((rendered.match(/> \[!NOTE\]/g) ?? []).length, 1);
    assert.ok(rendered.includes(text));
    assert.ok(!rendered.includes('[!IMPORTANT]'));
  }
  const attention = renderWalkthrough({ ...view,
    openEscalations: [{ id: 'E1', summary: 'Choose' }],
    reviewRows: [{ review: 'review', id: 'finding', round: 1, severity: 'must', ruling: null, rationale: 'Open' }],
    statuses: [{ criterion: 'missing', state: 'missing' as const }], unplannedPaths: ['extra.ts'],
  });
  assert.equal((attention.match(/> \[!IMPORTANT\]/g) ?? []).length, 1);
  assert.equal((attention.match(/> \[!NOTE\]/g) ?? []).length, 1);
  assert.ok(attention.includes('1 open escalations need a user decision.'));
  assert.ok(attention.includes('- **Review:** 1 findings (1 open)'));
  assert.ok(attention.includes('1 missing criteria; 1 unplanned paths'));
});

test('walkthrough behaviour summaries show plan behaviour before collapsed file details', async () => {
  const { renderWalkthrough } = await import('../../../skills/dispatch/scripts/toolkit/walkthrough.ts');
  const view = {
    title: 'Behaviour report', specPath: 'spec.md', specHash: 'sha256:abc', planPath: 'plan.md',
    delivered: { integrated: 2, total: 3, source: '123456abcdef7890', branch: 'main', ref: 'refs/dispatch/x/delivered-source' },
    glance: { what: 'Readers see each task outcome without opening its details.', how: 'Plan bullets flow into the walkthrough.' },
    statuses: [],
    tasks: [
      { id: 'T1', title: 'Parse summaries', outcome: 'The parser keeps task summaries.', behaviour: ['Reads visible summary bullets.', 'Warns when a summary is missing.'] },
      { id: 'T2', title: 'Render reports', outcome: 'The task outcome is used as a fallback.', behaviour: [] },
    ],
    changes: [
      { action: 'MODIFY' as const, path: 'skills/dispatch/scripts/toolkit/domain/plan.ts', owners: [{ id: 'T1', title: 'Parse summaries' }] },
      { action: 'NEW' as const, path: 'skills/dispatch/scripts/toolkit/report.ts', owners: [{ id: 'T2', title: 'Render reports' }] },
      { action: 'NEW' as const, path: 'src/orphan.ts', owners: [] },
    ],
    edits: [], unplannedPaths: ['src/orphan.ts'], openEscalations: [], deferredRulings: [], userRecords: [], reviewRows: [], reviewRounds: [],
  };
  const rendered = renderWalkthrough(view);
  assert.ok(rendered.includes('> **Delivered:** Readers see each task outcome without opening its details.'));
  assert.ok(rendered.includes('> **Integration:** 2 of 3 tasks integrated; uncommitted changes from source 123456abcdef in main working tree; ref refs/dispatch/x/delivered-source'));
  assert.ok(rendered.includes('- **How it works:** Plan bullets flow into the walkthrough.'));

  const changes = rendered.slice(rendered.indexOf('## Changes Made'), rendered.indexOf('## Verification'));
  assert.ok(changes.includes('### T1 — Parse summaries\n\n- Reads visible summary bullets.\n- Warns when a summary is missing.\n\n<details>\n\n#### [MODIFY] `skills/dispatch/scripts/toolkit/domain/plan.ts`'));
  assert.ok(changes.includes('### T2 — Render reports\n\n- The task outcome is used as a fallback.\n\n<details>\n\n#### [NEW] `skills/dispatch/scripts/toolkit/report.ts`'));
  assert.ok(changes.includes('### Unplanned changes\n\n<details>\n\n#### [NEW] `src/orphan.ts`'));
  assert.ok(!changes.includes('<summary>'));
});

test('walkthrough behaviour omits empty How it works and falls back to integration details', async () => {
  const { renderWalkthrough } = await import('../../../skills/dispatch/scripts/toolkit/walkthrough.ts');
  const rendered = renderWalkthrough({
    title: 'Fallback report', specPath: 'spec.md', specHash: 'sha256:abc', planPath: 'plan.md',
    delivered: { integrated: 1, total: 1, source: 'abcdef123456', branch: 'main', ref: 'refs/dispatch/x/delivered-source' },
    glance: { what: '', how: '' }, statuses: [], tasks: [], changes: [], edits: [], unplannedPaths: [],
    openEscalations: [], deferredRulings: [], userRecords: [], reviewRows: [], reviewRounds: [],
  });
  assert.ok(rendered.includes('> **Delivered:** 1 of 1 tasks integrated; uncommitted changes from source abcdef123456 in main working tree; ref refs/dispatch/x/delivered-source'));
  assert.ok(rendered.includes('> **Integration:** 1 of 1 tasks integrated; uncommitted changes from source abcdef123456 in main working tree; ref refs/dispatch/x/delivered-source'));
  assert.ok(!rendered.includes('- **How it works:**'));
});
