import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderWalkthrough } from '../../../skills/dispatch/scripts/toolkit/walkthrough.ts';

function view(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Report plan',
    specPath: 'spec/report.spec.md',
    specHash: `sha256:${'a'.repeat(64)}`,
    planPath: 'plans/report.plan.md',
    planHash: `sha256:${'b'.repeat(64)}`,
    delivered: { integrated: 2, total: 2, source: '123456abcdef7890', branch: 'main', ref: 'refs/dispatch/x/delivered-source' },
    glance: { what: 'The plan behaviour is visible to readers.', how: 'The renderer copies the plan details.', visuals: '' },
    risk: 'med',
    focus: { bullets: [] },
    tasks: [{ id: 'T1', title: 'Render reports', outcome: 'The report stays readable.', behaviour: ['Readers see the outcome first.'] }],
    statuses: [],
    changes: [],
    edits: [],
    unplannedPaths: [],
    openEscalations: [],
    deferredRulings: [],
    userRecords: [],
    reviewRows: [],
    reviewRounds: [],
    reviewFixes: [],
    ...overrides,
  } as Parameters<typeof renderWalkthrough>[0];
}

function section(rendered: string, heading: string, nextHeading?: string): string {
  const start = rendered.indexOf(heading);
  const end = nextHeading ? rendered.indexOf(nextHeading, start + heading.length) : rendered.length;
  assert.notEqual(start, -1, `missing ${heading}`);
  assert.notEqual(end, -1, `missing ${nextHeading}`);
  return rendered.slice(start, end);
}

test('walkthrough follows reviewer order and states counts once', () => {
  const rendered = renderWalkthrough(view({
    risk: 'low',
    statuses: [{ criterion: 'SC1', state: 'verified' as const, evidence: 'evidence/sc1.json' }],
    changes: [{ action: 'MODIFY' as const, path: 'src/report.ts', owners: [{ id: 'T1', title: 'Render reports' }] }],
  }));

  assert.deepEqual([...rendered.matchAll(/^## .+$/gm)].map((match) => match[0]), [
    '## At a Glance', '## Visuals', '## Review Focus', '## Behaviour Changes', '## Verification', '## Appendix',
  ]);
  const glance = section(rendered, '## At a Glance', '## Visuals');
  assert.match(glance, /- \*\*What:\*\* The plan behaviour is visible to readers\./);
  assert.match(glance, /- \*\*How it works:\*\* The renderer copies the plan details\./);
  assert.equal((glance.match(/^- \*\*Counts:\*\*/gm) ?? []).length, 1);
  for (const count of ['1/1 criteria', '1 files', '0 recorded edits', '0 unplanned paths', '0 findings']) {
    assert.equal((rendered.match(new RegExp(count, 'g')) ?? []).length, 1, count);
  }
  const verification = section(rendered, '## Verification', '## Appendix');
  assert.match(verification, /- \*\*Status:\*\* complete/);
  assert.doesNotMatch(verification, /\d+\/\d+|\d+ files|\d+ findings/);
  assert.doesNotMatch(rendered, /^> \*\*(Delivered|Integration|Spec|Plan|Status|Deviations):/m);
  assert.doesNotMatch(rendered, /^## (Changes Made|Deviations & Follow-ups|User-Attributed Records|Review Findings & Resolutions)$/m);
});

test('walkthrough review focus lists departures and authored evidence', () => {
  const rendered = renderWalkthrough(view({
    risk: 'high',
    focus: { bullets: [{ text: 'Inspect this<!-- hidden --> path.', evidence: 'notes/review-focus.md' }] },
    statuses: [
      { criterion: 'SC1', state: 'verified' as const, evidence: 'evidence/sc1.json' },
      { criterion: 'SC2', state: 'manual' as const, seq: 2, evidence: 'manual/proof.md', quote: 'manual approval' },
      { criterion: 'SC3', state: 'waived' as const, seq: 3, reason: 'approved exception', quote: 'waived by user' },
      { criterion: 'SC4', state: 'missing' as const },
    ],
    edits: [{ seq: 1, artifact: 'plan', class: 'clarification', rationale: 'Added a missing case.', diffRef: 'diff/plan.patch', affects: ['T1'] }],
    unplannedPaths: ['src/orphan.ts'],
    openEscalations: [{ id: 'E-1', summary: 'Confirm the remaining owner.' }],
    deferredRulings: [{ review: 'review-alpha', finding: 'R1-F011' }],
    reviewRows: [
      { review: 'review-alpha', id: 'R1-F010', round: 1, severity: 'SHOULD', ruling: 'rejected' as const, rationale: 'The proposed change is not needed.' },
      { review: 'review-alpha', id: 'R1-F011', round: 1, severity: 'SHOULD', ruling: 'deferred' as const, rationale: 'The evidence is incomplete.' },
    ],
    reviewFixes: [{ commit: 'd'.repeat(40), reason: 'repair accepted SHOULD', metadata: { review: 'review-alpha', round: 2, generation: 1, findings: ['R2-F001'], from: 'c'.repeat(40) }, status: 'verified but not re-reviewed', paths: ['src/report.ts'] }],
  }));

  const focus = section(rendered, '## Review Focus', '## Behaviour Changes');
  for (const detail of [
    'Risk: high', 'Plan edit (clarification)', 'Manual criterion SC2', 'Waived criterion SC3', 'Missing criterion SC4',
    'Rejected finding review-alpha:R1-F010', 'Deferred finding review-alpha:R1-F011',
    'verified but not re-reviewed', 'Unplanned path: src/orphan.ts',
    'Open escalation E-1: Confirm the remaining owner.',
    'Inspect this&lt;!-- hidden --&gt; path.', '[notes/review-focus.md](notes/review-focus.md)',
  ]) assert.ok(focus.includes(detail), detail);
});

test('walkthrough review focus collapses when delivery matched the plan', () => {
  const rendered = renderWalkthrough(view({
    risk: 'low',
    statuses: [{ criterion: 'SC1', state: 'verified' as const, evidence: 'evidence/sc1.json' }],
  }));
  assert.equal(section(rendered, '## Review Focus', '## Behaviour Changes'),
    '## Review Focus\n\n- Risk: low · Delivery matched the plan and all criteria are verified.\n\n');
});

test('walkthrough shows copied visuals or the recorded replacement', () => {
  const planVisuals = [
    '- Text summary: The map shows the request boundary.',
    '- Note: Ignore this <!-- hidden --> marker.',
    '',
    '| Component | Role |',
    '| --- | --- |',
    '| Gateway | Accepts requests |',
    '| Store | Persists responses |',
    '',
    '```mermaid',
    'flowchart LR',
    '  Gateway --> Store',
    '```',
  ].join('\n');
  const copied = renderWalkthrough(view({ glance: { what: 'The feature works.', how: 'The map shows the request path.', visuals: planVisuals } }));
  const copiedVisuals = section(copied, '## Visuals', '## Review Focus');
  assert.ok(copiedVisuals.includes(planVisuals.replace('<!-- hidden -->', '&lt;!-- hidden -->')));
  assert.ok(copiedVisuals.includes('Gateway --> Store'));

  const replacement = [
    '- Text summary: The replacement shows the delivered retry path.',
    '',
    '```mermaid',
    'sequenceDiagram',
    '  Client->>Gateway: retry',
    '```',
  ].join('\n');
  const replaced = renderWalkthrough(view({
    glance: { what: 'The feature works.', how: 'The map shows the request path.', visuals: planVisuals },
    focus: { bullets: [], visual: replacement },
  }));
  const visuals = section(replaced, '## Visuals', '## Review Focus');
  assert.ok(visuals.includes(replacement));
  assert.ok(!visuals.includes('Gateway --> Store'));
});

test('walkthrough appendix keeps evidence, user records, deviations, findings, provenance and review fixes', () => {
  const rendered = renderWalkthrough(view({
    statuses: [
      { criterion: 'SC1', state: 'verified' as const, evidence: 'evidence/first.json', reason: 'historical pre-prune evidence via validated pruning; source tree source; final evidence final.json' },
      { criterion: 'SC2', state: 'manual' as const, seq: 3, quote: 'manual | quote<!-- hidden -->', evidence: 'manual/proof.md' },
      { criterion: 'SC3', state: 'waived' as const, seq: 4, quote: 'waiver quote', reason: 'accepted exception' },
      { criterion: 'SC4', state: 'missing' as const },
    ],
    changes: [{ action: 'MODIFY' as const, path: 'src/report.ts', owners: [{ id: 'T1', title: 'Render reports' }] }],
    edits: [{ seq: 1, artifact: 'plan', class: 'clarification', rationale: 'Added an evidence edge case.', diffRef: 'diff/1.patch', affects: ['T1'] }],
    unplannedPaths: ['src/orphan.ts'],
    openEscalations: [{ id: 'E-1', summary: 'Confirm the remaining owner.' }],
    deferredRulings: [{ review: 'review-alpha', finding: 'R1-F010' }],
    userRecords: [{ seq: 7, kind: 'manual-complete', summary: 'manual-result evidence', quote: 'the user approved this row | <!-- literal -->' }],
    reviewRows: [
      { review: 'review-alpha', id: 'R1-F001', round: 1, severity: 'SHOULD', ruling: 'accepted' as const, recurrence: 'R1-F001', rationale: 'bounded fix accepted' },
      { review: 'review-alpha', id: 'R1-F002', round: 1, severity: 'MUST', ruling: null, unresolved: 'R1-F002', rationale: 'Awaiting evidence.' },
    ],
    reviewRounds: [{ review: 'review-alpha', round: 1, findings: 2, path: '.state/reviews/review-alpha/round-1/findings.json' }],
    reviewFixes: [{ commit: 'd'.repeat(40), reason: 'repair accepted SHOULD', metadata: { review: 'review-alpha', round: 1, generation: 1, findings: ['R1-F001'], from: 'c'.repeat(40) }, status: 'verified but not re-reviewed', paths: ['src/report.ts'], verification: { tree: 'e'.repeat(40), criteria: ['SC1'], contract: ['contract'] } }],
    reviewedCodeBaseline: 'c'.repeat(40),
  }));

  const appendix = section(rendered, '## Appendix');
  for (const detail of [
    '<details>\n\n<summary>Audit records</summary>',
    '### Provenance', `Spec: spec/report.spec.md · sha256:${'a'.repeat(12)}`,
    `Plan: plans/report.plan.md · sha256:${'b'.repeat(12)}`,
    'Integration: source 123456abcdef7890 · branch main · ref refs/dispatch/x/delivered-source',
    '### Verified Evidence', '[source evidence](evidence/first.json)', 'historical pre-prune evidence via validated pruning',
    '### User-Attributed Records', 'the user approved this row \\| &lt;!-- literal --&gt;',
    '### Deviations & Follow-ups', 'diff/1.patch', 'src/orphan.ts', 'Confirm the remaining owner.', 'review-alpha:R1-F010',
    '### Review Findings & Resolutions', '| review-alpha | R1-F001 | 1 | SHOULD | — | Accepted (recurs R1-F001) |',
    '[findings](.state/reviews/review-alpha/round-1/findings.json)',
    '### Review Fixes', 'Reviewed code baseline:', 'verified but not re-reviewed', 'src/report.ts', 'e'.repeat(40),
    '</details>',
  ]) assert.ok(appendix.includes(detail), detail);
});
