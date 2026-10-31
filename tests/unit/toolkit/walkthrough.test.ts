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
    '## At a Glance', '## Visuals', '## Review Focus', '## Behaviour Changes', '## Verification', '## Deviations & Follow-ups', '## Review Findings & Resolutions', '## Appendix',
  ]);
  const glance = section(rendered, '## At a Glance', '## Visuals');
  assert.match(glance, /- \*\*What:\*\* The plan behaviour is visible to readers\./);
  assert.match(glance, /- \*\*How it works:\*\* The renderer copies the plan details\./);
  assert.equal((glance.match(/^- \*\*Counts:\*\*/gm) ?? []).length, 1);
  for (const count of ['1/1 criteria', '1 files', '0 recorded edits', '0 unplanned paths', '0 findings']) {
    assert.equal((rendered.match(new RegExp(count, 'g')) ?? []).length, 1, count);
  }
  const verification = section(rendered, '## Verification', '## Deviations & Follow-ups');
  assert.match(verification, /- \*\*Status:\*\* complete/);
  assert.doesNotMatch(verification, /\d+\/\d+|\d+ files|\d+ findings/);
});

test('walkthrough review focus points to attention details in their owning sections', () => {
  const rendered = renderWalkthrough(view({
    risk: 'high',
    focus: { bullets: [{ text: 'Inspect this<!-- hidden --> path.', evidence: 'notes/review-focus.md' }] },
    statuses: [
      { criterion: 'SC1', state: 'verified' as const, evidence: 'evidence/sc1.json' },
      { criterion: 'SC2', state: 'manual' as const, seq: 2, evidence: 'manual/proof.md', quote: 'manual approval' },
      { criterion: 'SC3', state: 'waived' as const, seq: 3, reason: 'approved exception', quote: 'waived by user' },
      { criterion: 'SC4', state: 'missing' as const },
    ],
    edits: [
      { seq: 1, artifact: 'plan', class: 'non-intent', rationale: 'No user decision is needed.', diffRef: 'diff/plan.patch', affects: ['T1'] },
      { seq: 2, artifact: 'plan', class: 'intent', rationale: 'The user must approve this intent change.', diffRef: 'diff/intent.patch', affects: ['T1'] },
      { seq: 3, artifact: 'design', class: 'dependency', rationale: 'The user must approve this dependency.', diffRef: 'diff/dependency.patch', affects: ['T1'] },
      { seq: 4, artifact: 'plan', class: 'discard', rationale: 'The user must approve this discard.', diffRef: 'diff/discard.patch', affects: ['T1'] },
    ],
    unplannedPaths: ['src/orphan.ts'],
    openEscalations: [{ id: 'E-1', summary: 'Confirm the remaining owner.' }],
    deferredRulings: [{ review: 'review-alpha', finding: 'R1-F011' }],
    reviewRows: [
      { review: 'review-alpha', id: 'R1-F009', round: 1, severity: 'MUST', ruling: null, rationale: '' },
      { review: 'review-alpha', id: 'R1-F010', round: 1, severity: 'SHOULD', ruling: 'rejected' as const, rationale: 'The proposed change is not needed.' },
      { review: 'review-alpha', id: 'R1-F011', round: 1, severity: 'SHOULD', ruling: 'deferred' as const, rationale: 'The evidence is incomplete.' },
      { review: 'review-alpha', id: 'R1-F012', round: 1, severity: 'CONSIDER', ruling: 'rejected' as const, rationale: 'The rejected CONSIDER stays with findings.' },
    ],
    reviewFixes: [{ commit: 'd'.repeat(40), reason: 'repair accepted SHOULD', metadata: { review: 'review-alpha', round: 2, generation: 1, findings: ['R2-F001'], from: 'c'.repeat(40) }, status: 'verified but not re-reviewed', paths: ['src/report.ts'] }, { commit: 'e'.repeat(40), reason: 'unverified correction', metadata: { review: 'review-alpha', round: 2, generation: 1, findings: ['R2-F002'], from: 'c'.repeat(40) }, status: 'not verified', paths: [] }],
  }));

  const focus = section(rendered, '## Review Focus', '## Behaviour Changes');
  assert.deepEqual(focus.split('\n').filter((line) => line.startsWith('- ')), [
    '- Risk: high',
    '- Open escalation E-1 — see Deviations & Follow-ups',
    '- Open finding review-alpha:R1-F009 (MUST) — see Review Findings & Resolutions',
    '- Manual criterion SC2 — see Verification',
    '- Waived criterion SC3 — see Verification',
    '- Missing criterion SC4 — see Verification',
    '- Cap-ending SHOULD fix R2-F001: verified but not re-reviewed — see Deviations & Follow-ups',
    '- Cap-ending SHOULD fix R2-F002: not verified — see Deviations & Follow-ups',
    '- Unplanned path src/orphan.ts — see Deviations & Follow-ups',
    '- Rejected SHOULD finding review-alpha:R1-F010 — see Review Findings & Resolutions',
    '- Plan edit (intent) seq 2 — see Deviations & Follow-ups',
    '- Design edit (dependency) seq 3 — see Deviations & Follow-ups',
    '- Plan edit (discard) seq 4 — see Deviations & Follow-ups',
    '- Inspect this&lt;!-- hidden --&gt; path. — Evidence: [notes/review-focus.md](notes/review-focus.md)',
  ]);

  const verification = section(rendered, '## Verification', '## Deviations & Follow-ups');
  for (const detail of ['manual approval', 'approved exception', 'SC4']) assert.ok(verification.includes(detail), detail);
  const deviations = section(rendered, '## Deviations & Follow-ups', '## Review Findings & Resolutions');
  for (const detail of [
    'No user decision is needed.', 'diff/plan.patch', 'Confirm the remaining owner.', 'review-alpha:R1-F011', 'src/orphan.ts',
    '- Deviation: cap-ending SHOULD fix R2-F001: verified but not re-reviewed; commit dddddddddddd; paths src/report.ts',
    '- Deviation: cap-ending SHOULD fix R2-F002: not verified; commit eeeeeeeeeeee; paths none',
  ]) assert.ok(deviations.includes(detail), detail);
  const findings = section(rendered, '## Review Findings & Resolutions', '## Appendix');
  for (const detail of ['R1-F011', 'The evidence is incomplete.', 'R1-F012', 'The rejected CONSIDER stays with findings.']) {
    assert.ok(findings.includes(detail), detail);
  }
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
      { criterion: 'SC1', state: 'verified' as const, evidence: 'evidence/first.json', reason: 'verified at 123456abcdef7890; tests removed in cleanup' },
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
    testCleanup: { from: '123456abcdef7890', removed: ['SC1'], deleted: 3, merged: 1 },
  }));

  const appendix = section(rendered, '## Appendix');
  for (const detail of [
    '<details>\n\n<summary>Audit records</summary>',
    '### Provenance', `Spec: spec/report.spec.md · sha256:${'a'.repeat(12)}`,
    `Plan: plans/report.plan.md · sha256:${'b'.repeat(12)}`,
    'Integration: source 123456abcdef7890 · branch main · ref refs/dispatch/x/delivered-source',
    '### Verified Evidence', '[source evidence](evidence/first.json)', 'verified at 123456abcdef7890; tests removed in cleanup',
    '### User-Attributed Records', 'the user approved this row \\| &lt;!-- literal --&gt;',
    '</details>',
  ]) assert.ok(appendix.includes(detail), detail);

  assert.ok(section(rendered, '## Verification', '## Deviations & Follow-ups').includes('- **Test cleanup:** deleted 3 · merged 1 tests after verification at 123456abcdef; criteria with tests removed: SC1'));
  const deviations = section(rendered, '## Deviations & Follow-ups');
  for (const detail of ['diff/1.patch', 'src/orphan.ts', 'Confirm the remaining owner.', 'review-alpha:R1-F010']) assert.ok(deviations.includes(detail), detail);
  const findings = section(rendered, '## Review Findings & Resolutions');
  for (const detail of ['| review-alpha | R1-F001 | 1 | SHOULD | — | Accepted (recurs R1-F001) |', '[findings](.state/reviews/review-alpha/round-1/findings.json)']) assert.ok(findings.includes(detail), detail);
  assert.ok(!appendix.includes('Review Findings & Resolutions') && !appendix.includes('Deviations & Follow-ups'));
  assert.ok(rendered.indexOf('## Verification') < rendered.indexOf('## Deviations & Follow-ups') && rendered.indexOf('## Review Findings & Resolutions') < rendered.indexOf('## Appendix'));
});
