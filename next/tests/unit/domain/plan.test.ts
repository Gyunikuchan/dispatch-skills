import assert from 'node:assert/strict';
import { test } from 'node:test';

import { governedPlanText, normalizePlanPath, parsePlan, structuralLines, placeholderVocabulary } from '../../../skills/dispatch/scripts/domain/plan.ts';

const PLAN = `# Add retry budget

> **TL;DR:** fetch retries forever; cap them.
> **Parent:** user request
> **Decide:** none
> **Risk:** low — isolated helper
> **Scope:** src/fetch.ts

## Key Decisions & Context
- Cap at three attempts (user)

## Technical-Design Traceability
- Approved revision: none

## Success Criteria
- [SC1] Fetch stops after three attempts
  - Changes: src/fetch.ts, tests/fetch.test.ts
  - Verify: \`node --test tests/fetch.test.ts\`
  - Evidence: red
  - Test rationale: fails today because the loop never stops retrying.
- [SC2] Whole suite stays green
  - Verify: \`npm test\` [FINAL]
  - Evidence: verify
  - Test rationale: aggregate regression gate over every package.

## Proposed Changes
### Fetch
#### [MODIFY] src/fetch.ts
- Changes: add a retry counter to fetchWithRetry.
#### [NEW] tests/fetch.test.ts
- Purpose: pins the retry cap.
#### [GENERATED] docs/api.md
- Command: \`npm run docs\`

## Verification Plan
### Automated Tests
- \`npm run lint\`
### Manual Verification
- Observe logs.

## Review Findings & Resolutions
*No reviews conducted yet.*
`;

const defects = (source: string) => {
  const result = parsePlan(source);
  return result.ok ? [] : result.defects.map((item) => item.code);
};

test('implement-plan-lint: parsePlan extracts box, criteria, changes, verification, FINAL, traceability', () => {
  const result = parsePlan(PLAN);
  assert.ok(result.ok, JSON.stringify(result));
  const { plan } = result;
  assert.equal(plan.title, 'Add retry budget');
  assert.equal(plan.box['Parent'], 'user request');
  assert.deepEqual(plan.keyDecisions, ['Cap at three attempts (user)']);
  assert.deepEqual(plan.criteria.map((item) => [item.id, item.evidence]), [['SC1', 'red'], ['SC2', 'verify']]);
  assert.deepEqual(plan.criteria[0]?.changes, ['src/fetch.ts', 'tests/fetch.test.ts']);
  assert.deepEqual(plan.criteria[1]?.verify, [{ command: 'npm test', final: true }]);
  assert.deepEqual(plan.finalCommands, ['npm test']);
  assert.deepEqual(plan.changes.map((item) => [item.action, item.path]), [['MODIFY', 'src/fetch.ts'], ['NEW', 'tests/fetch.test.ts'], ['GENERATED', 'docs/api.md']]);
  assert.equal(plan.changes[2]?.command, 'npm run docs');
  assert.deepEqual(plan.verification.automated, ['npm run lint']);
  assert.deepEqual(plan.traceability, { 'Approved revision': 'none' });
});

test('implement-plan-lint: [FINAL] inside the code span is a defect naming the fix', () => {
  const result = parsePlan(PLAN.replace('`npm test` [FINAL]', '`npm test [FINAL]`'));
  assert.equal(result.ok, false);
  const defect = !result.ok ? result.defects.find((item) => item.code === 'final-in-code-span') : undefined;
  assert.ok(defect);
  assert.match(defect.message, /`npm test` \[FINAL\]/);
});

test('implement-plan-lint: missing criterion fields, unknown markers, and GENERATED without Command fail', () => {
  assert.ok(defects(PLAN.replace('  - Evidence: verify\n', '')).includes('criterion-evidence'));
  assert.ok(defects(PLAN.replace('  - Test rationale: aggregate regression gate over every package.\n', '')).includes('criterion-test-rationale'));
  assert.ok(defects(PLAN.replace('#### [NEW] tests/fetch.test.ts', '#### [ADD] tests/fetch.test.ts')).includes('unknown-change-marker'));
  assert.ok(defects(PLAN.replace('- Command: `npm run docs`\n', '')).includes('generated-command'));
  assert.ok(defects(PLAN.replace('> **Risk:** low — isolated helper\n', '')).includes('summary-label'));
});

test('implement-plan-lint: leftover template placeholders fail when a vocabulary is supplied', () => {
  const vocabulary = placeholderVocabulary(['````markdown\n# <Goal Description>\n- Verify: `<command>`\n````\n']);
  const result = parsePlan(PLAN.replace('Observe logs.', 'Observe <Goal Description>.'), { placeholders: vocabulary });
  assert.ok(!result.ok && result.defects.some((item) => item.code === 'leftover-placeholder'));
});

test('implement-plan-lint: governed text excludes the trailing resolution section only', () => {
  const governed = governedPlanText(`${PLAN}\n## Out of Scope\n- Nothing.\n`);
  assert.ok(!governed.includes('## Review Findings & Resolutions'));
  assert.ok(!governed.includes('No reviews conducted yet'));
  assert.ok(governed.includes('## Out of Scope'));
  const result = parsePlan(PLAN);
  assert.ok(result.ok && result.plan.governedText === governedPlanText(PLAN));
});

test('implement-plan-lint: drive-qualified, home, and rooted paths are rejected as absolute', () => {
  for (const raw of ['C:/outside/file.ts', 'c:file.ts', '/etc/passwd', '~/x.ts']) assert.equal(normalizePlanPath(raw).reason, 'absolute', raw);
  assert.equal(normalizePlanPath('next/a.ts').path, 'next/a.ts');
});

test('implement-plan-lint: a fence line with an info string inside a fence keeps the block fenced', () => {
  const lines = structuralLines(['```', '```markdown', '## Success Criteria', '```', '## Real'].join('\n'));
  assert.deepEqual(lines.map((entry) => entry.fenced), [true, true, true, true, false]);
});

test('implement-plan-lint: fenced automated commands, bad Pre-existing, blank review fields, blank infeasibility fail', () => {
  const fenced = PLAN.replace('- `npm run lint`', '```sh\nnpm run lint\n```');
  assert.ok(defects(fenced).includes('automated-command'));
  assert.ok(defects(PLAN.replace('  - Evidence: red\n', '  - Evidence: red\n  - Pre-existing: maybe\n')).includes('criterion-format'));
  const review = PLAN.replace('  - Evidence: verify\n', '  - Evidence: review\n  - Review: artifact: ; scenario: ; pass:\n');
  assert.ok(defects(review).includes('criterion-review'));
});

test('implement-plan-lint: a fence inside an HTML comment does not swallow later sections', () => {
  const lines = structuralLines(['<!--', '```', '-->', '## Real'].join('\n'));
  assert.equal(lines[3]?.fenced, false);
  assert.equal(lines[3]?.text, '## Real');
});
