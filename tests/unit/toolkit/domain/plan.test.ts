import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  governedPlanText, isTestPath, lint, normalizePlanPath, parsePlan, placeholderVocabulary, selectTaskBrief, structuralLines, taskExecutionSummary, taskMapRows,
} from '../../../../skills/dispatch/scripts/toolkit/domain/plan.ts';

const splitMessage = (action: string, text: string) => `List one path per [${action}] heading; only [DELETE] may group comma-separated paths. Split "${text}".`;

const PLAN = `# Add retry budget

> **TL;DR:** fetch retries forever; cap them.
> **Parent:** \`governing.spec.md\` · sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> **Decide:** none
> **Risk:** low — isolated helper
> **Scope:** src/fetch.ts

## Key Decisions & Context
- Cap at three attempts (user)

## Task Map

| ID | Title | Outcome | Prerequisites | Criteria |
| --- | --- | --- | --- | --- |
| T1 | Cap fetch retries | Fetch stops retrying after three attempts so callers fail fast. | none | SC1, SC2 |

## Technical-Design Traceability
- Approved revision: none

## Proposed Changes
### T1 — Cap fetch retries

#### [MODIFY] src/fetch.ts
- Changes: add a retry counter to fetchWithRetry.
#### [NEW] tests/fetch.test.ts
- Purpose: pins the retry cap.
#### [GENERATED] docs/api.md
- Command: \`npm run docs\`
- Inputs: src/fetch.ts

## Success Criteria
- [SC1] Fetch stops after three attempts
  - Satisfies: REQ-1
  - Changes: src/fetch.ts, tests/fetch.test.ts
  - Tests: tests/fetch.test.ts
  - Verify: \`node --test tests/fetch.test.ts\`
  - RED: \`node --test {files}\`
  - Evidence: red
  - Test rationale: fails today because the loop never stops retrying.
  - Retain: durable
- [SC2] Whole suite stays green
  - Satisfies: REQ-1
  - Changes: src/fetch.ts
  - Verify: \`npm test\` [FINAL]
  - Evidence: verify
  - Test rationale: aggregate regression gate over every package.

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
  return [...(result.ok ? [] : result.defects), ...result.warnings.filter(item => !['missing-seams', 'criterion-red-test-path', 'undeclared-test-path', 'red-downgraded', 'overlap'].includes(item.code))].map((item) => item.code);
};

test('presentation and traceability findings are warnings while structural findings block', () => {
  for (const code of ['missing-summary-box', 'summary-label', 'leftover-placeholder', 'filler-note', 'section-order', 'retired-section', 'missing-satisfies', 'missing-requirement-ref', 'unknown-requirement', 'plan-id-in-test-name', 'task-summary', 'task-overlap', 'automated-test-duplicates-verify', 'criterion-test-rationale', 'criterion-critical-review'] as const) {
    assert.equal(lint(code, null, 'finding').severity, 'warning', code);
  }
  const result = parsePlan(PLAN.replace('> **Risk:** low — isolated helper\n', '').replaceAll('  - Satisfies: REQ-1\n', ''));
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(result.warnings.some(item => item.code === 'summary-label'));
  assert.ok(result.warnings.some(item => item.code === 'missing-satisfies'));
  for (const [source, code] of [
    [PLAN.replace('[SC1]', '[SC0]'), 'criterion-id'],
    [PLAN.replace('  - Verify: `node --test tests/fetch.test.ts`', '  - Verify: invalid'), 'criterion-verify'],
    [PLAN.replace('#### [MODIFY] src/fetch.ts', '#### [MODIFY] src/fetch.ts, src/other.ts'), 'change-heading'],
    [PLAN.replace('## Task Map', '## Tasks'), 'task-map'],
  ]) {
    const invalid = parsePlan(source!);
    assert.ok(!invalid.ok && invalid.defects.some(item => item.code === code), code);
  }
});

const TESTS_LINE = '  - Tests: tests/fetch.test.ts\n';
const readable = (source = PLAN) => source.replace(/^#### /gm, '- #### ').replace(/^(- (?:Changes|Purpose|Command|Inputs):.*)$/gm, '  $1');
const parsed = (source: string) => { const result = parsePlan(source); assert.ok(result.ok, JSON.stringify(result)); return result.plan; };

test('numeric criterion grammar stays shared across headings task mappings and transient coverage', () => {
  const numeric = PLAN.replaceAll('SC1', 'SC14').replaceAll('SC2', 'SC205');
  assert.deepEqual(parsed(numeric).criteria.map((row) => row.id), ['SC14', 'SC205']);
  const transient = numeric.replace('  - Retain: durable', '  - Retain: transient\n  - Covered by: SC205').replaceAll('tests/fetch.test.ts', 'tests/fetch.transient.test.ts');
  assert.equal(parsed(transient).criteria[0]?.coveredBy, 'SC205');
  for (const id of ['SC0', 'SC01', 'SC14a']) {
    assert.ok(defects(numeric.replaceAll('SC14', id)).includes('criterion-id'));
    assert.ok(defects(numeric.replace('SC14, SC205', `${id}, SC205`)).includes('task-criteria'));
    assert.ok(defects(transient.replace('Covered by: SC205', `Covered by: ${id}`)).includes('transient-coverage'));
  }
});

// SECTION: Readable plan syntax

test('readable plan syntax: nested and mixed entries preserve executable contracts and source lines', () => {
  const plain = parsed(PLAN), nested = parsed(readable());
  assert.deepEqual(nested.changes, plain.changes);
  assert.deepEqual(nested.tasks, plain.tasks);
  assert.deepEqual(nested.criteria, plain.criteria);
  assert.deepEqual(nested.finalCommands, plain.finalCommands);
  assert.equal(nested.governedText, governedPlanText(readable()));
  assert.deepEqual(parsed(readable().replace('- #### [NEW]', '#### [NEW]').replace('  - Purpose:', '- Purpose:')).changes, plain.changes);
  assert.deepEqual(parsed(readable().replace('- #### [NEW]', '- #### [DELETE]')).changes.map(c => c.action), ['MODIFY', 'DELETE', 'GENERATED']);
  const consecutive = readable().replace('- #### [NEW] tests/fetch.test.ts\n  - Purpose: pins the retry cap.\n', '');
  const generated = parsed(consecutive.replace('src/fetch.ts, tests/fetch.test.ts', 'src/fetch.ts').replace(TESTS_LINE, ''));
  assert.equal(generated.changes[0]?.command, null);
  assert.equal(generated.changes[0]?.note, 'add a retry counter to fetchWithRetry.');
  assert.equal(generated.changes[1]?.command, 'npm run docs');
  assert.deepEqual(generated.tasks[0]?.generated, [{ path: 'docs/api.md', inputs: ['src/fetch.ts'] }]);
});

test('readable plan syntax: owned briefs carry Outcome, Constraints and every labelled invariant once', () => {
  const source = readable().replace('| T1 | Cap fetch retries | Fetch stops retrying after three attempts so callers fail fast. | none | SC1, SC2 |', [
      '| T1 | Cap fetch retries | Fetch stops retrying. | none | SC1 |',
      '| T2 | Check the companion | Check the companion. | T1 | SC2 |',
    ].join('\n'))
    .replace('### T1 — Cap fetch retries', '### T1 — Cap fetch retries\n- Constraints: Keep the public API.')
    .replace('  - Changes: add a retry counter to fetchWithRetry.', '  - Changes: add a retry counter to fetchWithRetry.\n  - Invariants: Preserve retry ordering.\n    - Exception: zero retries still calls once.\n      Keep the callback.\n  - Invariants: Preserve errors.\n  - Notes: optional context only.')
    .replace('#### [GENERATED] docs/api.md', '#### [GENERATED] docs/api.md')
    .replace('## Success Criteria', '### T2 — Check the companion\n- Constraints: Preserve companion shape.\n- #### [MODIFY] src/companion.ts\n  - Changes: Check companion output.\n\n## Success Criteria')
    .replace('  - Changes: src/fetch.ts\n  - Verify: `npm test`', '  - Changes: src/companion.ts\n  - Verify: `npm test`');
  const plan = parsed(source);
  const first = selectTaskBrief(plan, 'T1'), second = selectTaskBrief(plan, 'T2');
  assert.ok(first); assert.ok(second);
  assert.equal(first.task.summary, 'Fetch stops retrying.');
  assert.deepEqual(first.task.constraints, ['Keep the public API.']);
  assert.deepEqual(second.task.constraints, ['Preserve companion shape.']);
  const note = first.changes.find(c => c.path === 'src/fetch.ts')!.note;
  for (const text of ['Invariants: Preserve retry ordering.', 'Exception: zero retries still calls once.', 'Keep the callback.', 'Invariants: Preserve errors.']) assert.equal(note.split(text).length - 1, 1);
  assert.ok(!JSON.stringify(first).includes('optional context only'));
  assert.ok(!JSON.stringify(first.dependents).includes('Preserve companion shape'));
  assert.ok(!JSON.stringify(second).includes('Preserve retry ordering'));
  assert.ok(plan.sharedContext.includes('| T2 | Check the companion | Check the companion. | T1 | SC2 |'));
  assert.match(plan.governedText, /Notes: optional context only/);
});

test('readable plan syntax: unsafe paths, malformed nesting, aliases and fake authority stay rejected', () => {
  for (const [source, code] of [
    [readable().replace('src/fetch.ts\n  - Changes:', '../outside.ts\n  - Changes:'), 'invalid-change-path'],
    [readable().replace('- #### [NEW] tests/fetch.test.ts', '- #### [NEW] SRC/fetch.ts'), 'duplicate-change-path'],
    [readable().replace('- #### [MODIFY]', '  - #### [MODIFY]'), 'change-heading'],
    [readable().replace('  - Inputs: src/fetch.ts', ''), 'generated-inputs'],
  ]) assert.ok(defects(source!).includes(code as never), String(code));
  for (const wrap of [(s: string) => `> ${s}`, (s: string) => `<!--\n${s}\n-->`, (s: string) => `\`\`\`md\n${s}\n\`\`\``]) {
    const source = readable().replace('- #### [NEW]', `${wrap('- #### [MODIFY] src/fake.ts')}\n- #### [NEW]`);
    assert.ok(!parsed(source).changes.some(c => c.path === 'src/fake.ts'));
  }
  const source = readable().replace('- #### [NEW]', '    #### [MODIFY] src/fake.ts\n- #### [NEW]');
  assert.ok(!parsed(source).changes.some(c => c.path === 'src/fake.ts'));
  assert.ok(!parsed(readable().replace('- #### [NEW]', '  #### [MODIFY] src/fake.ts\n- #### [NEW]')).changes.some(c => c.path === 'src/fake.ts'));
  assert.ok(defects(readable(TASKS).replace('src/writer.ts, README.md', 'src/writer.ts, src/reader.ts')).includes('generated-inputs'));
});

test('readable plan syntax: invariant-only notes stay single and unlabeled details retain all continuations', () => {
  const source = readable().replace('  - Changes: add a retry counter to fetchWithRetry.', '  - Notes: Optional background.\n  - Invariants: Keep API.\n    - Exception: Keep flag.');
  assert.equal(parsed(source).changes[0]?.note, 'Invariants: Keep API.\n  - Exception: Keep flag.');
  const continued = readable().replace('  - Changes: add a retry counter to fetchWithRetry.', '  - Changes:\n    - Add the counter.\n      Preserve callback order.\n    - Bound the attempts.');
  assert.equal(parsed(continued).changes[0]?.note, '  - Add the counter.\n    Preserve callback order.\n  - Bound the attempts.');
});

// SECTION: Plan parsing and validation

test('implement-plan-lint: parsePlan extracts box, criteria, changes, verification, FINAL, traceability', () => {
  const result = parsePlan(PLAN);
  assert.ok(result.ok, JSON.stringify(result));
  const { plan } = result;
  assert.equal(plan.title, 'Add retry budget');
  assert.equal(plan.box['Parent'], '`governing.spec.md` · sha256:' + 'a'.repeat(64));
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
  assert.ok(defects(PLAN.replace('  - Test rationale: fails today because the loop never stops retrying.\n', '')).includes('criterion-test-rationale'));
  assert.ok(defects(PLAN.replace('#### [NEW] tests/fetch.test.ts', '#### [ADD] tests/fetch.test.ts')).includes('unknown-change-marker'));
  assert.ok(defects(PLAN.replace('- Command: `npm run docs`\n', '')).includes('generated-command'));
  assert.ok(defects(PLAN.replace('> **Risk:** low — isolated helper\n', '')).includes('summary-label'));
});

test('implement-plan-lint: leftover template placeholders fail when a vocabulary is supplied', () => {
  const vocabulary = placeholderVocabulary(['````markdown\n# <Goal Description>\n- Verify: `<command>`\n````\n']);
  const result = parsePlan(PLAN.replace('Observe logs.', 'Observe <Goal Description>.'), { placeholders: vocabulary });
  assert.ok(result.ok && result.warnings.some((item) => item.code === 'leftover-placeholder'));
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

test('implement-plan-lint: rejects fenced automated commands, invalid Pre-existing, and blank review fields', () => {
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

// SECTION: Task graph and ownership

const TASKS = `# Shared contract with consumers

> **TL;DR:** consumers need one shared contract.
> **Parent:** \`governing.spec.md\` · sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> **Decide:** none
> **Risk:** low — isolated modules
> **Scope:** src/

## Task Map

| ID | Title | Outcome | Prerequisites | Criteria |
| --- | --- | --- | --- | --- |
| T1 | Define the shared contract | Consumers share one exported shape so they cannot drift. | none | SC1 |
| T2 | Read through the contract | The reader decodes records with the shared shape. | T1 | SC2 |
| T3 | Write through the contract | The writer encodes records with the shared shape and regenerates the docs. | T1 | SC3 |

## Proposed Changes

### T1 — Define the shared contract

#### [NEW] src/contract.ts
- Purpose: exports the shared shape.

### T2 — Read through the contract
- Constraints: Preserve unknown fields.

#### [MODIFY] src/reader.ts
- Changes: decode with the contract.

### T3 — Write through the contract

#### [MODIFY] src/writer.ts
- Changes: encode with the contract.
#### [GENERATED] docs/contract.md
- Command: \`npm run docs\`
- Inputs: src/contract.ts, src/writer.ts, README.md

## Success Criteria
- [SC1] Contract exports the shape
  - Satisfies: REQ-1
  - Changes: src/contract.ts
  - Verify: \`node --test tests/contract.test.ts\`
  - Evidence: verify
  - Test rationale: pins the exported shape consumers rely on.
- [SC2] Reader consumes the contract
  - Satisfies: REQ-1
  - Changes: src/reader.ts
  - Verify: \`node --test tests/reader.test.ts\`
  - Evidence: verify
  - Test rationale: covers the reader path through the contract.
- [SC3] Writer consumes the contract
  - Satisfies: REQ-1
  - Changes: src/writer.ts
  - Verify: \`node --test tests/writer.test.ts\`
  - Evidence: verify
  - Test rationale: covers the writer path through the contract.
- [SC4] Reader and writer round-trip
  - Satisfies: REQ-1
  - Verify: \`node --test tests/roundtrip.test.ts\` [FINAL]
  - Evidence: verify
  - Integration: spans reader and writer tasks.
  - Test rationale: proves both consumers agree on the encoding.

## Verification Plan
### Automated Tests
- \`npm run lint\`
`;

test('task-plan: parses tasks with summary, prerequisites, criteria, owned paths, and generated inputs', () => {
  const result = parsePlan(TASKS);
  assert.ok(result.ok, JSON.stringify(result));
  const { tasks } = result.plan;
  assert.deepEqual(tasks.map((task) => [task.id, task.title, task.prerequisites, task.criteria, task.paths]), [
    ['T1', 'Define the shared contract', [], ['SC1'], ['src/contract.ts']],
    ['T2', 'Read through the contract', ['T1'], ['SC2'], ['src/reader.ts']],
    ['T3', 'Write through the contract', ['T1'], ['SC3'], ['src/writer.ts', 'docs/contract.md']],
  ]);
  assert.equal(tasks[0]?.summary, 'Consumers share one exported shape so they cannot drift.');
  assert.deepEqual(tasks[1]?.constraints, ['Preserve unknown fields.']);
  assert.deepEqual(tasks[2]?.generated, [{ path: 'docs/contract.md', inputs: ['src/contract.ts', 'src/writer.ts', 'README.md'] }]);
  assert.deepEqual(result.plan.changes.map((change) => change.path), ['src/contract.ts', 'src/reader.ts', 'src/writer.ts', 'docs/contract.md']);
});

test('task-plan: rejects graph defects', () => {
  const cases: [string, string, string][] = [
    ['untasked entry', '## Proposed Changes\n\n### T1 — Define the shared contract', 'task-ownership'],
    ['malformed heading', '### T2 — Read through the contract', 'task-heading'],
    ['empty outcome', '| T2 | Read through the contract | The reader decodes records with the shared shape. | T1 | SC2 |', 'task-summary'],
    ['duplicate id', '### T3 — Write through the contract', 'duplicate-id'],
    ['unknown prerequisite', '| T2 | Read through the contract | The reader decodes records with the shared shape. | T1 | SC2 |', 'missing-prerequisite'],
    ['missing prerequisites cell', '| T2 | Read through the contract | The reader decodes records with the shared shape. | T1 | SC2 |', 'task-map'],
    ['cycle', '| T1 | Define the shared contract | Consumers share one exported shape so they cannot drift. | none | SC1 |', 'cycle'],
  ];
  const replacements: Record<string, string> = {
    'untasked entry': '## Proposed Changes\n\n#### [MODIFY] src/orphan.ts\n\n### T1 — Define the shared contract', 'malformed heading': '### Reader — Read', 'empty outcome': '| T2 | Read through the contract |  | T1 | SC2 |', 'duplicate id': '### T2 — Write through the contract',
    'unknown prerequisite': '| T2 | Read through the contract | The reader decodes records with the shared shape. | T9 | SC2 |', 'missing prerequisites cell': '| T2 | Read through the contract | The reader decodes records with the shared shape. |  | SC2 |',
    cycle: '| T1 | Define the shared contract | Consumers share one exported shape so they cannot drift. | T2 | SC1 |',
  };
  for (const [name, from, code] of cases) assert.ok(defects(TASKS.replace(from, replacements[name] ?? '')).some((item) => item === code), name);
  for (const summary of ['TBD', 'Same.']) assert.ok(defects(TASKS.replace('| T2 | Read through the contract | The reader decodes records with the shared shape. | T1 | SC2 |', `| T2 | Read through the contract | ${summary} | T1 | SC2 |`)).includes('task-summary'), summary);
});

test('task-plan: rejects mapping defects', () => {
  assert.ok(defects(TASKS.replace('| T2 | Read through the contract | The reader decodes records with the shared shape. | T1 | SC2 |', '| T2 | Read through the contract | The reader decodes records with the shared shape. | T1 | SC1 |')).includes('task-criteria'), 'double-mapped');
  assert.ok(defects(TASKS.replace('| T2 | Read through the contract | The reader decodes records with the shared shape. | T1 | SC2 |', '| T2 | Read through the contract | The reader decodes records with the shared shape. | T1 | SC2, SC9 |')).includes('task-criteria'), 'unknown criterion');
  assert.ok(defects(TASKS.replace('  - Integration: spans reader and writer tasks.\n', '')).includes('task-criteria'), 'unmapped criterion');
  assert.ok(defects(TASKS.replace('| T2 | Read through the contract | The reader decodes records with the shared shape. | T1 | SC2 |', '| T2 | Read through the contract | The reader decodes records with the shared shape. | T1 | none |')).includes('task-criteria'), 'task without criteria');
  assert.ok(defects(TASKS.replace('  - Changes: src/reader.ts\n', '  - Changes: src/reader.ts, src/writer.ts\n')).includes('task-criteria'), 'foreign path');
  assert.ok(defects(TASKS.replace('| T3 | Write through the contract | The writer encodes records with the shared shape and regenerates the docs. | T1 | SC3 |', '| T3 | Write through the contract | The writer encodes records with the shared shape and regenerates the docs. | T1 | SC3, SC4 |')).includes('task-criteria'), 'task-mapped integration criterion');
});

test('a task-owned criterion without changes fails lint with a fix hint unless it is Integration', () => {
  const taskChanges = (source: string) => { const result = parsePlan(source); return result.ok ? [] : result.defects.filter((item) => item.code === 'criterion-task-changes'); };
  const verifyOnly = TASKS.replace('  - Changes: src/reader.ts\n', '');
  const found = taskChanges(verifyOnly);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.severity, 'defect');
  assert.equal(found[0]?.line, verifyOnly.split('\n').indexOf('- [SC2] Reader consumes the contract') + 1);
  assert.match(found[0]?.message ?? '', /SC2.*Changes.*Integration/);
  const integration = verifyOnly.replace('  - Evidence: verify\n  - Test rationale: covers the reader path', '  - Evidence: verify\n  - Integration: spans the reader.\n  - Test rationale: covers the reader path');
  assert.notDeepEqual(defects(integration), [], 'the mapped Integration variant still fails on its task mapping');
  assert.deepEqual(taskChanges(integration), []);
  const clean = parsePlan(TASKS);
  assert.ok(clean.ok && clean.plan.criteria.some((criterion) => criterion.id === 'SC4' && !criterion.changes.length), 'unmapped Integration criterion without Changes stays clean');
});

test('task-plan: generated inputs require Inputs and cover producers through prerequisites', () => {
  assert.ok(defects(TASKS.replace('- Inputs: src/contract.ts, src/writer.ts, README.md\n', '')).includes('generated-inputs'), 'missing inputs');
  assert.ok(defects(TASKS.replace('src/writer.ts, README.md', 'src/writer.ts, ../outside.md')).includes('generated-inputs'), 'invalid input');
  assert.ok(defects(TASKS.replace('src/writer.ts, README.md', 'src/writer.ts, src/reader.ts')).includes('generated-inputs'), 'producer not a prerequisite');
});

test('task-plan: derives summary and brief from the graph', () => {
  const result = parsePlan(TASKS);
  assert.ok(result.ok);
  assert.deepEqual(taskExecutionSummary(result.plan.tasks), [
    'T1 — Define the shared contract (start)',
    'T2 — Read through the contract (after T1)',
    'T3 — Write through the contract (after T1)',
  ]);
  const brief = selectTaskBrief(result.plan, 'T1');
  assert.ok(brief);
  assert.deepEqual(brief.changes.map((change) => change.path), ['src/contract.ts']);
  assert.deepEqual(brief.criteria.map((criterion) => criterion.id), ['SC1']);
  assert.deepEqual(brief.dependents.map((task) => task.id), ['T2', 'T3']);
  assert.deepEqual(selectTaskBrief(result.plan, 'T3')?.prerequisites.map((task) => task.id), ['T1']);
  assert.equal(selectTaskBrief(result.plan, 'T9'), null);
});

test('task-plan: case-variant generated inputs and repeated task criteria normalize', () => {
  assert.ok(defects(TASKS.replace('src/writer.ts, README.md', 'src/writer.ts, src/Reader.ts')).includes('generated-inputs'), 'case-variant producer');
  const result = parsePlan(TASKS.replace('| T2 | Read through the contract | The reader decodes records with the shared shape. | T1 | SC2 |', '| T2 | Read through the contract | The reader decodes records with the shared shape. | T1 | sc2, `SC2` |'));
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.plan.tasks[1]?.criteria, ['SC2']);
});

test('task-plan: empty prerequisite values and deleted generated inputs are rejected', () => {
  for (const value of ['', ', ,']) assert.ok(defects(TASKS.replace('| T2 | Read through the contract | The reader decodes records with the shared shape. | T1 | SC2 |', `| T2 | Read through the contract | The reader decodes records with the shared shape. | ${value} | SC2 |`)).includes('task-map'), JSON.stringify(value));
  const deleted = TASKS.replace('#### [MODIFY] src/reader.ts', '#### [DELETE] src/reader.ts').replace('src/writer.ts, README.md', 'src/writer.ts, src/reader.ts').replace('| T3 | Write through the contract | The writer encodes records with the shared shape and regenerates the docs. | T1 | SC3 |', '| T3 | Write through the contract | The writer encodes records with the shared shape and regenerates the docs. | T1, T2 | SC3 |');
  assert.ok(defects(deleted).includes('generated-inputs'));
});

// SECTION: Grouped DELETE headings and comma rejection

const DELETE_NOTE = '- Changes: remove the obsolete retry shims.';
const withDelete = (heading: string) => PLAN.replace('- Inputs: src/fetch.ts\n', `- Inputs: src/fetch.ts\n#### [DELETE] ${heading}\n${DELETE_NOTE}\n`);
const defectsOf = (source: string, code: string) => { const result = parsePlan(source); return [...(result.ok ? [] : result.defects), ...result.warnings].filter((item) => item.code === code); };

test('missing satisfies emits one diagnostic per criterion', () => {
  for (const replacement of ['', '  - Satisfies:\n', '  - Satisfies: REQ-x\n', '  - Satisfies: REQ-x\n  - Satisfies: wrong\n']) {
    const source = PLAN.replace('  - Satisfies: REQ-1\n', replacement);
    assert.equal(defectsOf(source, 'missing-satisfies').length, 1, replacement);
  }
});

test('grouped delete registers every path, accepting bare and backticked paths', () => {
  const source = withDelete('src/old-a.ts, src/old-b.ts');
  const plan = parsed(source);
  const deletes = plan.changes.filter((change) => change.action === 'DELETE');
  const line = source.split('\n').findIndex((text) => text.startsWith('#### [DELETE]')) + 1;
  assert.deepEqual(deletes.map((change) => change.path), ['src/old-a.ts', 'src/old-b.ts']);
  assert.deepEqual(deletes.map((change) => change.note), ['remove the obsolete retry shims.', 'remove the obsolete retry shims.']);
  assert.deepEqual(deletes.map((change) => change.line), [line, line]);
  assert.ok(['src/old-a.ts', 'src/old-b.ts'].every((path) => plan.tasks[0]?.paths.includes(path)));

  const backticked = parsed(withDelete('`src/old-a.ts`, `src/old-b.ts`'));
  assert.deepEqual(backticked.changes.filter((change) => change.action === 'DELETE').map((change) => change.path), ['src/old-a.ts', 'src/old-b.ts']);
});

test('grouped delete flags a duplicate path', () => {
  assert.deepEqual(defectsOf(withDelete('src/old-a.ts, src/old-a.ts'), 'duplicate-change-path').map((item) => item.message), ['Change path "src/old-a.ts" appears more than once.']);
  assert.deepEqual(defectsOf(withDelete('src/old-a.ts, src/fetch.ts'), 'duplicate-change-path').map((item) => item.message), ['Change path "src/fetch.ts" appears more than once.']);
});

test('modify change heading rejects comma-separated paths', () => {
  const source = PLAN.replace('#### [MODIFY] src/fetch.ts', '#### [MODIFY] src/fetch.ts, src/other.ts');
  assert.deepEqual(defectsOf(source, 'change-heading').map((item) => item.message), [splitMessage('MODIFY', 'src/fetch.ts, src/other.ts')]);
});

test('new change heading rejects backticked comma-separated paths', () => {
  const source = PLAN.replace('#### [NEW] tests/fetch.test.ts', '#### [NEW] `tests/fetch.test.ts`, `tests/other.test.ts`');
  assert.deepEqual(defectsOf(source, 'change-heading').map((item) => item.message), [splitMessage('NEW', '`tests/fetch.test.ts`, `tests/other.test.ts`')]);
});

test('rejected multi-path change heading registers no path', () => {
  // Real headings for both paths follow; registering either from the rejected heading would add duplicate-change-path.
  const source = PLAN.replace('#### [MODIFY] src/fetch.ts', '#### [MODIFY] src/fetch.ts, tests/fetch.test.ts\n- Changes: bundle the cap and its test.\n#### [MODIFY] src/fetch.ts');
  assert.deepEqual(defects(source), ['change-heading', 'missing-section']);
});

test('rejected sole multi-path heading emits only change-heading', () => {
  const source = PLAN.replace(/#### \[MODIFY\][\s\S]*?- Inputs: src\/fetch\.ts\n/, '#### [GENERATED] src/fetch.ts, docs/api.md\n- Command: `npm run docs`\n- Inputs: src/fetch.ts\n');
  assert.deepEqual(defectsOf(source, 'change-heading').map((item) => item.message), [splitMessage('GENERATED', 'src/fetch.ts, docs/api.md')]);
});

test('duplicate delete notes hint grouping', () => {
  const source = PLAN.replace('- Inputs: src/fetch.ts\n', `- Inputs: src/fetch.ts\n#### [DELETE] src/old-a.ts\n${DELETE_NOTE}\n#### [DELETE] src/old-b.ts\n${DELETE_NOTE}\n`);
  assert.deepEqual(defectsOf(source, 'filler-note').map((item) => item.message), Array(2).fill('Change note "remove the obsolete retry shims." repeats a sibling note; say what changes in this file; group these [DELETE] paths under one heading.'));
});

test('duplicate sibling notes report repeat message', () => {
  const source = PLAN.replace('- Inputs: src/fetch.ts\n', '- Inputs: src/fetch.ts\n#### [MODIFY] src/other.ts\n- Changes: add a retry counter to fetchWithRetry.\n');
  assert.deepEqual(defectsOf(source, 'filler-note').map((item) => item.message), Array(2).fill('Change note "add a retry counter to fetchWithRetry." repeats a sibling note; say what changes in this file.'));
});

test('intrinsic filler note keeps filler message', () => {
  const source = PLAN.replace('- Inputs: src/fetch.ts\n', '- Inputs: src/fetch.ts\n#### [MODIFY] src/other.ts\n- Changes: same\n');
  assert.deepEqual(defectsOf(source, 'filler-note').map((item) => item.message), ['Change note "same" is filler; say what changes in this file.']);
});

// SECTION: Cross-task overlap

const READER_ENTRY = '#### [MODIFY] src/reader.ts\n- Changes: decode with the contract.\n';
const WRITER_ENTRY = '#### [MODIFY] src/writer.ts\n- Changes: encode with the contract.\n';
/** T2 and T3 both require only T1, so a path they share has no Requires path between them. */
const overlapPlan = (writerPath = 'src/shared.ts', writerHeader = '') => TASKS
  .replace(READER_ENTRY, `${READER_ENTRY}#### [MODIFY] src/shared.ts\n- Changes: add the reader lookup table.\n`)
  .replace(WRITER_ENTRY, `${WRITER_ENTRY}#### [MODIFY] ${writerPath}\n- Changes: add the writer lookup table.\n`)
  .replace('### T3 — Write through the contract', `### T3 — Write through the contract${writerHeader}`);
const okPlan = (source: string) => { const result = parsePlan(source); assert.ok(result.ok, JSON.stringify(result)); return result; };
const overlapCodes = (source: string) => okPlan(source).warnings.filter((item) => item.code === 'overlap');

test('warns on unjustified cross-task overlap', () => {
  const result = okPlan(overlapPlan());
  assert.deepEqual(result.plan.warnings, [{ kind: 'overlap', tasks: ['T2', 'T3'], path: 'src/shared.ts' }]);
  assert.equal(overlapCodes(overlapPlan()).length, 1);
  assert.deepEqual(result.plan.changes.filter((change) => change.path === 'src/shared.ts').map((change) => change.note), ['add the reader lookup table.', 'add the writer lookup table.']);
  assert.deepEqual(selectTaskBrief(result.plan, 'T2')?.changes.map((change) => change.note), ['decode with the contract.', 'add the reader lookup table.']);
  assert.deepEqual(selectTaskBrief(result.plan, 'T3')?.changes.map((change) => change.note), ['encode with the contract.', 'add the writer lookup table.', '']);
  const alias = okPlan(overlapPlan('src/Shared.ts'));
  assert.deepEqual(alias.plan.warnings, [{ kind: 'overlap', tasks: ['T2', 'T3'], path: 'src/shared.ts' }]);
  assert.match(alias.warnings.find((item) => item.code === 'overlap')?.message ?? '', /\(as "src\/Shared\.ts" in T3\)/);
});

test('accepts justified overlap', () => {
  const result = okPlan(overlapPlan('src/shared.ts', '\n- Overlap: `src/shared.ts` — both lookup tables live in one module.'));
  assert.deepEqual(result.plan.warnings, []);
  assert.deepEqual(overlapCodes(overlapPlan('src/shared.ts', '\n- Overlap: src/Shared.ts — case variants name one file.')), []);
  assert.deepEqual(result.plan.tasks[2]?.overlaps, [{ path: 'src/shared.ts', reason: 'both lookup tables live in one module.' }]);
  assert.equal(result.plan.tasks[2]?.summary, 'The writer encodes records with the shared shape and regenerates the docs.');
  assert.ok(defects(overlapPlan('src/shared.ts', '\n- Overlap: src/shared.ts')).includes('task-overlap'), 'missing reason');
  assert.ok(defects(overlapPlan('src/shared.ts', '\n- Overlap: src/reader.ts — not written here.')).includes('task-overlap'), 'unowned path');
});

test('keeps duplicate path defect within one task', () => {
  const repeated = TASKS.replace(WRITER_ENTRY, `${WRITER_ENTRY}#### [MODIFY] src/writer.ts\n- Changes: also log each encode.\n`);
  assert.deepEqual(defectsOf(repeated, 'duplicate-change-path').map((item) => item.message), ['Change path "src/writer.ts" appears more than once.']);
  const aliased = TASKS.replace(WRITER_ENTRY, `${WRITER_ENTRY}#### [MODIFY] src/Writer.ts\n- Changes: also log each encode.\n`);
  assert.deepEqual(defectsOf(aliased, 'duplicate-change-path').map((item) => item.message), ['Change path "src/Writer.ts" aliases "src/writer.ts" on case-insensitive filesystems.']);
  const justified = repeated.replace('### T3 — Write through the contract', '### T3 — Write through the contract\n- Overlap: src/writer.ts — same task.');
  assert.ok(defects(justified).includes('duplicate-change-path'), 'Overlap does not excuse a same-task repeat');
});

test('ignores reference-only paths for overlap', () => {
  const source = TASKS
    .replace('| T2 | Read through the contract | The reader decodes records with the shared shape. | T1 | SC2 |', '| T2 | Read through the contract | The reader decodes records that `src/writer.ts` encodes. | T1 | SC2 |')
    .replace(READER_ENTRY, '#### [MODIFY] src/reader.ts\n- Changes: decode with the contract; mirror `src/writer.ts`.\n<!-- #### [MODIFY] src/writer.ts -->\n')
    .replace('  - Integration: spans reader and writer tasks.', '  - Changes: src/reader.ts, src/writer.ts\n  - Integration: spans reader and writer tasks.');
  const result = okPlan(source);
  assert.deepEqual(result.plan.warnings, []);
  assert.deepEqual(result.warnings.filter((item) => item.code === 'overlap'), []);
});

test('no overlap warning for directly ordered tasks', () => {
  const source = TASKS.replace(READER_ENTRY, `${READER_ENTRY}#### [MODIFY] src/contract.ts\n- Changes: add the reader decode hook.\n`);
  assert.deepEqual(okPlan(source).plan.warnings, []);
  assert.deepEqual(overlapCodes(source), []);
});

test('no overlap warning for transitively ordered tasks', () => {
  const source = TASKS
    .replace('| T3 | Write through the contract | The writer encodes records with the shared shape and regenerates the docs. | T1 | SC3 |', '| T3 | Write through the contract | The writer encodes records with the shared shape and regenerates the docs. | T2 | SC3 |')
    .replace(WRITER_ENTRY, `${WRITER_ENTRY}#### [MODIFY] src/contract.ts\n- Changes: add the writer encode hook.\n`);
  assert.deepEqual(okPlan(source).plan.warnings, []);
  assert.deepEqual(overlapCodes(source), []);
});

// SECTION: Seams and transient criteria

const SC1_RATIONALE = '  - Test rationale: fails today because the loop never stops retrying.\n';
// Replaces SC1's Retain line and isolates its test file, so the transient criterion owns a [NEW] transient-named path.
const transient = (fields: string, source = PLAN) =>
  source.replace(`${SC1_RATIONALE}  - Retain: durable\n`, `${SC1_RATIONALE}${fields}`).replaceAll('tests/fetch.test.ts', 'tests/fetch.transient.test.ts');

test('parses seams', () => {
  assert.deepEqual(parsed(PLAN).seams, []);
  const source = PLAN.replace('## Verification Plan\n', '## Verification Plan\n- Seams: `tests/fetch.test.ts`, `node --test --test-name-pattern="a,b" tests/e2e.test.ts`\n');
  assert.deepEqual(parsed(source).seams, ['tests/fetch.test.ts', 'node --test --test-name-pattern="a,b" tests/e2e.test.ts']);
  assert.deepEqual(parsed(PLAN.replace('## Verification Plan\n', '## Verification Plan\n- Seams: none\n')).seams, []);
});

const seamWarnings = (source: string) => okPlan(source).warnings.filter((item) => item.code === 'missing-seams');
const withSeams = (declaration: string) => PLAN.replace('## Verification Plan\n', `## Verification Plan\n${declaration}`);

test('seam advisory warns for absent and empty declarations', () => {
  for (const source of [PLAN, withSeams('- Seams:\n'), withSeams('- Seams: ``, ,\n')]) {
    const warnings = seamWarnings(source);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.severity, 'warning');
    assert.equal(warnings[0]?.line, source.split('\n').indexOf('## Verification Plan') + 1);
    assert.match(warnings[0]?.message ?? '', /Seams:.*none/);
    assert.deepEqual(parsed(source).seams, []);
  }
});

test('seam advisory permits explicit none and populated declarations', () => {
  for (const declaration of ['- Seams: none\n', '* seams: NoNe\n', '- Seams: `tests/fetch.test.ts`\n']) {
    assert.deepEqual(seamWarnings(withSeams(declaration)), []);
  }
  assert.deepEqual(parsed(withSeams('- Seams: `tests/fetch.test.ts`\n')).seams, ['tests/fetch.test.ts']);
});

test('seam advisory ignores review-only criteria', () => {
  const source = PLAN.replace(/  - Verify:.*\n/g, '').replace(/  - Evidence: (red|verify)/g,
    '  - Evidence: review\n  - Review: artifact: src/fetch.ts; scenario: bounded inspection; pass: retry cap is explicit');
  assert.deepEqual(seamWarnings(source), []);
});

test('seam advisory rejects structural decoys', () => {
  for (const declaration of ['```text\n- Seams: none\n```\n', '<!--\n- Seams: none\n-->\n', '> - Seams: none\n']) {
    assert.equal(seamWarnings(withSeams(declaration)).length, 1);
  }
  assert.equal(seamWarnings(PLAN.replace('### Automated Tests\n', '### Automated Tests\n- Seams: none\n')).length, 1);
  assert.equal(seamWarnings(PLAN.replace('## Key Decisions & Context\n', '## Key Decisions & Context\n- Seams: none\n')).length, 1);
});

test('seam advisory includes FINAL-only Verify', () => {
  const source = PLAN.replace('  - Verify: `node --test tests/fetch.test.ts`\n', '')
    .replace('  - Evidence: red', '  - Evidence: review\n  - Review: artifact: src/fetch.ts; scenario: bounded inspection; pass: retry cap is explicit');
  assert.equal(seamWarnings(source).length, 1);
});

test('parses transient retain and coverage', () => {
  const plan = parsed(transient('  - Retain: transient\n  - Covered by: `sc2`\n'));
  assert.deepEqual(plan.criteria.map((criterion) => [criterion.id, criterion.retain, criterion.coveredBy]), [['SC1', 'transient', 'SC2'], ['SC2', 'durable', null]]);
  assert.equal(parsed(transient('  - Retain: transient\n  - Covered by: FINAL\n')).criteria[0]?.coveredBy, 'FINAL');
  assert.equal(parsed(transient('  - Retain: durable\n')).criteria[0]?.retain, 'durable');
  assert.ok(defects(transient('  - Retain: sometimes\n')).includes('criterion-format'), 'unknown Retain value');
});

test('rejects transient criterion without coverage', () => {
  const cases: [string, string][] = [
    ['  - Retain: transient\n', 'requires Covered by'],
    ['  - Retain: transient\n  - Covered by: SC9\n', 'unknown criterion SC9'],
    ['  - Retain: transient\n  - Covered by: SC1\n', 'also transient'],
    ['  - Retain: transient\n  - Covered by: the suite\n', 'use a criterion ID'],
    ['  - Covered by: SC2\n', 'without Retain: transient'],
  ];
  for (const [fields, message] of cases) {
    const found = defectsOf(transient(fields), 'transient-coverage');
    assert.equal(found.length, 1, fields);
    assert.match(found[0]?.message ?? '', new RegExp(message), fields);
  }
});

test('rejects final coverage without final command', () => {
  const source = transient('  - Retain: transient\n  - Covered by: FINAL\n');
  assert.ok(parsePlan(source).ok);
  const found = defectsOf(source.replace('`npm test` [FINAL]', '`npm test`'), 'transient-coverage');
  assert.deepEqual(found.map((item) => item.message), ['Criterion SC1 is Covered by FINAL, but the plan has no [FINAL] Verify command.']);
});

test('rejects a second Retain line on one criterion', () => {
  const found = defectsOf(PLAN.replace('  - Retain: durable\n', '  - Retain: durable\n  - Retain: durable\n'), 'criterion-format');
  assert.deepEqual(found.map((item) => item.message), ['Criterion requires exactly one Retain.']);
});

test('requires explicit Retain on a criterion that changes tests', () => {
  const found = defectsOf(PLAN.replace('  - Retain: durable\n', ''), 'criterion-retain-required');
  assert.deepEqual(found.map((item) => item.message), ['Criterion SC1 changes tests; state Retain: transient or Retain: durable (durable tests meet the durable bar in the plan template).']);
});

test('declared test paths: Retain is required only when Tests names a path', () => {
  const undeclared = PLAN.replace('  - Retain: durable\n', '').replace(TESTS_LINE, '');
  assert.deepEqual(defectsOf(undeclared, 'criterion-retain-required'), []);
  const productionOnly = PLAN.replace('  - Retain: durable\n', '').replace('src/fetch.ts, tests/fetch.test.ts', 'src/fetch.ts').replace(TESTS_LINE, '')
    .replace('  - Evidence: red', '  - Evidence: review\n  - Review: artifact: src/fetch.ts; scenario: bounded inspection; pass: retry cap is explicit');
  assert.equal(parsed(productionOnly).criteria[0]?.retain, 'durable');
});

test('test rationale follows durable test retention', () => {
  const missingDurableRationale = defectsOf(PLAN.replace(SC1_RATIONALE, ''), 'criterion-test-rationale');
  assert.equal(missingDurableRationale.length, 1);
  assert.match(missingDurableRationale[0]?.message ?? '', /Test rationale/);

  const withoutTests = (evidence: 'verify' | 'review') => PLAN.replace(SC1_RATIONALE, '')
    .replace('src/fetch.ts, tests/fetch.test.ts', 'src/fetch.ts')
    .replace(TESTS_LINE, '')
    .replace('  - Evidence: red\n', evidence === 'review'
      ? '  - Evidence: review\n  - Review: artifact: src/fetch.ts; scenario: plan inspection; pass: rationale scope follows durable tests\n'
      : '  - Evidence: verify\n')
    .replace('  - RED: `node --test {files}`\n', '');
  assert.deepEqual(defectsOf(withoutTests('verify'), 'criterion-test-rationale'), []);
  assert.deepEqual(defectsOf(withoutTests('review'), 'criterion-test-rationale'), []);

  const transientWithoutRationale = transient('  - Retain: transient\n  - Covered by: SC2\n').replace(SC1_RATIONALE, '');
  assert.deepEqual(defectsOf(transientWithoutRationale, 'criterion-test-rationale'), []);
  assert.equal(defectsOf(transient('  - Retain: transient\n'), 'transient-coverage').length, 1);

  const malformed = defectsOf(PLAN.replace(SC1_RATIONALE, '  - Test rationale: short\n'), 'criterion-test-rationale');
  assert.equal(malformed.length, 1);
  assert.match(malformed[0]?.message ?? '', /concretely explain/);
  const duplicate = defectsOf(PLAN.replace(SC1_RATIONALE, `${SC1_RATIONALE}  - Test rationale: a second concrete rationale for retaining the tests\n`), 'criterion-test-rationale');
  assert.equal(duplicate.length, 1);
  assert.match(duplicate[0]?.message ?? '', /exactly one Test rationale/);
});

const isolated = transient('  - Retain: transient\n  - Covered by: SC2\n');
const transientPathDefects = (source: string) => defectsOf(source, 'transient-test-path');
const NEW_TRANSIENT = '#### [NEW] tests/fetch.transient.test.ts\n- Purpose: pins the retry cap.';

test('isolates transient test files: an owned NEW transient-named file passes', () => {
  assert.deepEqual(transientPathDefects(isolated), []);
  assert.equal(parsed(isolated).criteria[0]?.retain, 'transient');
});

test('isolates transient test files: rejects non-NEW markers', () => {
  const headings = ['#### [MODIFY] tests/fetch.transient.test.ts', '#### [GENERATED] tests/fetch.transient.test.ts\n- Command: `npm run gen`\n- Inputs: src/fetch.ts'];
  for (const heading of headings) assert.equal(transientPathDefects(isolated.replace(NEW_TRANSIENT, heading)).length, 1, heading);
});

test('isolates transient test files: rejects a basename without transient', () => {
  assert.equal(transientPathDefects(isolated.replaceAll('tests/fetch.transient.test.ts', 'tests/fetch.test.ts')).length, 1);
});

test('isolates transient test files: rejects a path a durable criterion also lists', () => {
  const source = isolated.replace('- [SC2] Whole suite stays green\n  - Satisfies: REQ-1\n  - Changes: src/fetch.ts\n', '- [SC2] Whole suite stays green\n  - Satisfies: REQ-1\n  - Changes: tests/fetch.transient.test.ts\n  - Retain: durable\n');
  assert.equal(transientPathDefects(source).length, 1);
});

test('isolates transient test files: exempts a declared MODIFY support file from naming rules', () => {
  const fixture = 'tests/fixtures/fetch.json';
  const source = isolated.replace(NEW_TRANSIENT, `${NEW_TRANSIENT}\n#### [MODIFY] ${fixture}\n- Changes: adds a retry case.`)
    .replace('  - Changes: src/fetch.ts, tests/fetch.transient.test.ts\n  - Tests: tests/fetch.transient.test.ts\n', `  - Changes: src/fetch.ts, tests/fetch.transient.test.ts, ${fixture}\n  - Tests: tests/fetch.transient.test.ts, ${fixture}\n`);
  assert.deepEqual(parsed(source).criteria[0]?.tests, ['tests/fetch.transient.test.ts', fixture]);
  assert.deepEqual(transientPathDefects(source), []);
});

test('detects test paths across runners', () => {
  for (const path of ['test_x.py', 'pkg/x_transient_test.go', 'tests/x.rs', 'tests/test_x_transient.py', 'src/x.transient.test.ts']) assert.ok(isTestPath(path), path);
  for (const path of ['src/testing.ts', 'src/contest.ts']) assert.ok(!isTestPath(path), path);
});

// SECTION: Declared tests and RED command

const RED_LINE = '  - RED: `node --test {files}`\n';
const NEW_FETCH_TEST = '#### [NEW] tests/fetch.test.ts\n- Purpose: pins the retry cap.';
const warningsOf = (source: string, code: string) => okPlan(source).warnings.filter((item) => item.code === code);
const criterionLine = (source: string, heading: string) => source.split('\n').indexOf(heading) + 1;

test('declared test paths: Tests parses normalized paths into the criterion', () => {
  assert.deepEqual(parsed(PLAN).criteria.map((criterion) => criterion.tests), [['tests/fetch.test.ts'], []]);
  const backticked = PLAN.replace(TESTS_LINE, '  - Tests: `./tests/fetch.test.ts`\n');
  assert.deepEqual(parsed(backticked).criteria[0]?.tests, ['tests/fetch.test.ts']);
});

test('declared test paths: a Tests path outside the criterion Changes is a defect', () => {
  const source = PLAN.replace(TESTS_LINE, '  - Tests: tests/fetch.test.ts, tests/other.test.ts\n');
  const found = defectsOf(source, 'criterion-tests-path');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.line, source.split('\n').indexOf('  - Tests: tests/fetch.test.ts, tests/other.test.ts') + 1);
  assert.match(found[0]?.message ?? '', /tests\/other\.test\.ts/);
  assert.equal(defectsOf(PLAN.replace(TESTS_LINE, '  - Tests:\n'), 'criterion-tests-path').length, 1, 'empty Tests');
  assert.equal(defectsOf(PLAN.replace(TESTS_LINE, '  - Tests: ../tests/fetch.test.ts\n'), 'criterion-tests-path').length, 1, 'unsafe path');
});

test('declared test paths: a red criterion without Tests warns criterion-red-test-path that its evidence downgrades', () => {
  assert.deepEqual(warningsOf(PLAN, 'criterion-red-test-path'), []);
  const found = warningsOf(PLAN.replace(TESTS_LINE, ''), 'criterion-red-test-path');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.severity, 'warning');
  assert.match(JSON.stringify(found[0]), /red evidence downgrades to verify/);
});

test('declared test paths: transient and plan-ID file checks read Tests, not path shape', () => {
  const modified = isolated.replace(NEW_TRANSIENT, '#### [MODIFY] tests/fetch.transient.test.ts');
  assert.equal(transientPathDefects(modified).length, 1);
  assert.deepEqual(transientPathDefects(modified.replace('  - Tests: tests/fetch.transient.test.ts\n', '')), []);
  const named = PLAN.replaceAll('tests/fetch.test.ts', 'tests/sc1.test.ts');
  const heading = criterionLine(named, '#### [NEW] tests/sc1.test.ts');
  assert.ok(namedDefects(named).some((item) => item.line === heading));
  assert.ok(!namedDefects(named.replace('  - Tests: tests/sc1.test.ts\n', '')).some((item) => item.line === heading));
});

test('RED command field: parses one inline-code command per criterion', () => {
  assert.deepEqual(parsed(PLAN).criteria.map((criterion) => criterion.red), ['node --test {files}', null]);
});

test('RED command field: RED exception stays a separate field', () => {
  const exception = parsed(PLAN.replace(RED_LINE, '  - RED exception: behavior-preserving\n')).criteria[0];
  assert.equal(exception?.red, null);
  assert.equal(exception?.redException, 'behavior-preserving');
  const both = parsed(PLAN.replace(RED_LINE, `${RED_LINE}  - RED exception: already-satisfied\n`)).criteria[0];
  assert.equal(both?.red, 'node --test {files}');
  assert.equal(both?.redException, 'already-satisfied');
});

test('RED command field: rejects a missing code span, extra spans, and a repeated line', () => {
  for (const line of ['  - RED: node --test {files}\n', '  - RED: `node --test` `{files}`\n', '  - RED:\n', `${RED_LINE}${RED_LINE}`]) {
    const source = PLAN.replace(RED_LINE, line);
    assert.equal(defectsOf(source, 'criterion-red-command').length, 1, line);
  }
});

test('RED command field: a plan ID in the RED command is a plan-id-in-test-name defect', () => {
  assert.equal(namedDefects(PLAN.replace(RED_LINE, '  - RED: `node --test --test-name-pattern="sc1" {files}`\n')).length, 1);
});

test('downgrade warning: a red criterion without RED or RED exception warns red-downgraded', () => {
  const source = PLAN.replace(RED_LINE, '');
  const found = warningsOf(source, 'red-downgraded');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.severity, 'warning');
  assert.equal(found[0]?.line, criterionLine(source, '- [SC1] Fetch stops after three attempts'));
  assert.match(found[0]?.message ?? '', /SC1/);
  assert.deepEqual(warningsOf(PLAN, 'red-downgraded'), []);
  assert.deepEqual(warningsOf(PLAN.replace(RED_LINE, '  - RED exception: behavior-preserving\n'), 'red-downgraded'), []);
});

test('undeclared test path warning: a test-like Changes path outside every Tests warns', () => {
  assert.deepEqual(warningsOf(PLAN, 'undeclared-test-path'), []);
  const source = PLAN.replace(TESTS_LINE, '');
  const found = warningsOf(source, 'undeclared-test-path');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.severity, 'warning');
  assert.match(found[0]?.message ?? '', /tests\/fetch\.test\.ts/);
});

test('undeclared test path warning: fixture, helper, and mock paths are exempt', () => {
  const support = ['tests/fixtures/fetch.ts', 'tests/helpers/fetch.ts', 'tests/mocks/fetch.ts'];
  const source = PLAN.replace(NEW_FETCH_TEST, `${NEW_FETCH_TEST}\n${support.map((path) => `#### [NEW] ${path}\n- Purpose: adds the shared retry ${path.split('/')[1]} module.`).join('\n')}`)
    .replace('  - Changes: src/fetch.ts, tests/fetch.test.ts\n', `  - Changes: src/fetch.ts, tests/fetch.test.ts, ${support.join(', ')}\n`);
  assert.deepEqual(warningsOf(source, 'undeclared-test-path'), []);
});

const namedDefects = (source: string) => defectsOf(source, 'plan-id-in-test-name');
const withPattern = (pattern: string) => PLAN.replace('`node --test tests/fetch.test.ts`', `\`node --test --test-name-pattern="${pattern}" tests/fetch.test.ts\``);
const withFinding = (id: string) => PLAN.replace('*No reviews conducted yet.*', `### Review r\n#### Round 1 — full\n##### ${id}\n- Resolved.`);

test('plan validation: keeps plan IDs out of test selectors and files', () => {
  const verifyFound = namedDefects(withPattern('sc1 caps'));
  assert.equal(verifyFound.length, 1);
  assert.match(verifyFound[0]?.message ?? '', /names plan ID SC1; name the behavior instead\.$/);

  const fileFound = namedDefects(PLAN.replaceAll('tests/fetch.test.ts', 'tests/sc1.test.ts'));
  assert.ok(fileFound.some((item) => item.line === PLAN.split('\n').indexOf('#### [NEW] tests/fetch.test.ts') + 1), JSON.stringify(fileFound));

  assert.equal(namedDefects(withFinding('R1-F001').replace('`node --test tests/fetch.test.ts`', '`node --test --test-name-pattern="R1-F001" tests/fetch.test.ts`')).length, 1);

  for (const name of ['SC10', 'ESC1', 'R1-F001']) assert.deepEqual(namedDefects(withPattern(name)), [], name);
  assert.deepEqual(namedDefects(isolated), []);
});

test('records criterion and finding IDs as plan IDs', () => {
  assert.deepEqual(parsed(withFinding('R2-F003')).planIds, ['R2-F003', 'SC1', 'SC2']);
});

// SECTION: Section order and Task Map

test('plan-section-order: old order fails and new order with absent optional sections passes', () => {
  const criteria = PLAN.slice(PLAN.indexOf('## Success Criteria'), PLAN.indexOf('## Verification Plan'));
  const criteriaFirst = PLAN.replace(criteria, '').replace('## Proposed Changes', `${criteria}## Proposed Changes`);
  const oldOrder = PLAN.replace('## Key Decisions & Context\n', '## Background\n- Retries loop today.\n\n## Key Decisions & Context\n')
    .replace('## Technical-Design Traceability\n', '## Background\n- Current behavior.\n\n## Technical-Design Traceability\n')
    .replace('## Review Findings', '## Out of Scope\n- Backoff.\n\n## Review Findings');
  const orderDefects = (source: string) => parsePlan(source).warnings.filter((item) => item.code === 'section-order');
  assert.deepEqual(orderDefects(criteriaFirst).map((item) => item.line), [criteriaFirst.split('\n').indexOf('## Proposed Changes') + 1]);
  assert.deepEqual(orderDefects(oldOrder).map((item) => item.line), ['## Background', '## Out of Scope'].map((heading) => oldOrder.split('\n').lastIndexOf(heading) + 1));
  assert.match(orderDefects(oldOrder)[0]!.message, /Move "## Background" before "## Task Map"/);
  const full = PLAN.replace('## Key Decisions & Context\n', '## Background\n- Retries loop today.\n\n## Key Decisions & Context\n')
    .replace('## Task Map\n', '## Open Questions & Assumptions\n- None.\n\n## Out of Scope\n- Backoff.\n\n## Task Map\n')
    .replace('## Review Findings', '## Rollback & Blast Radius\n- Revert the helper.\n\n## Review Findings');
  parsed(full);
  parsed(PLAN);
});

test('authored Task Map owns task metadata, hash input, and shared writer context', () => {
  const source = PLAN
    .replace('| T1 | Cap fetch retries | Fetch stops retrying after three attempts so callers fail fast. | none | SC1, SC2 |', '| T1 | Cap \\| fetch retries | Stop `fetch\\|retry` after three attempts | none | SC1, SC2 |')
    .replace('### T1 — Cap fetch retries', '### T1 — Cap | fetch retries')
    .replace('### T1 — Cap | fetch retries', '### T1 — Cap | fetch retries\n- Constraints: Keep the public API.');
  const result = parsePlan(source);
  assert.ok(result.ok, JSON.stringify(result));
  const task = result.plan.tasks[0]!;
  assert.equal(task.title, 'Cap | fetch retries');
  assert.equal(task.summary, 'Stop `fetch|retry` after three attempts');
  assert.deepEqual(task.constraints, ['Keep the public API.']);
  assert.deepEqual(task.prerequisites, []);
  assert.deepEqual(task.criteria, ['SC1', 'SC2']);
  assert.ok(result.plan.sharedContext.includes('| T1 | Cap \\| fetch retries | Stop `fetch\\|retry` after three attempts | none | SC1, SC2 |'));
  assert.ok(result.plan.governedText.includes('## Task Map'));
  assert.notEqual(governedPlanText(source), governedPlanText(source.replace('SC1, SC2', 'SC2, SC1')));
  assert.equal(governedPlanText(source), governedPlanText(source.replace('*No reviews conducted yet.*', '### Review r\n- Resolved.')));
});

test('Task Map pipes inside inline code follow GFM escaping', () => {
  const escaped = TASKS.replace('The reader decodes records with the shared shape.', 'The reader decodes `records\\|shape` with the shared shape.');
  const result = parsePlan(escaped);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.plan.tasks.find(({ id }) => id === 'T2')?.summary, 'The reader decodes `records|shape` with the shared shape.');

  const unescaped = TASKS.replace('The reader decodes records with the shared shape.', 'The reader decodes `records|shape` with the shared shape.');
  const malformed = parsePlan(unescaped);
  assert.ok(!malformed.ok && malformed.defects.some((item) => item.code === 'task-map' && item.message.includes('exactly five cells')), JSON.stringify(malformed));
});

test('Task Map rows join by ID and keep file selection tied to H3 source lines', () => {
  const source = TASKS
    .replace('| T1 | Define the shared contract | Consumers share one exported shape so they cannot drift. | none | SC1 |\n| T2 | Read through the contract | The reader decodes records with the shared shape. | T1 | SC2 |\n| T3 | Write through the contract | The writer encodes records with the shared shape and regenerates the docs. | T1 | SC3 |', [
      '| T3 | Write through the contract | The writer encodes records with the shared shape and regenerates the docs. | T1 | SC3 |',
      '| T1 | Define the shared contract | Consumers share one exported shape so they cannot drift. | none | SC1 |',
      '| T2 | Read through the contract | The reader decodes records with the shared shape. | T1 | SC2 |',
    ].join('\n'))
    .replace('### T1 — Define the shared contract', '### T1 — Define the shared contract\n- Constraints: Keep the exported name stable.');
  const plan = parsed(source);
  assert.deepEqual(plan.tasks.map(({ id }) => id), ['T3', 'T1', 'T2']);
  assert.equal(plan.tasks.find(({ id }) => id === 'T2')?.line, source.split('\n').indexOf('### T2 — Read through the contract') + 1);
  assert.deepEqual(selectTaskBrief(plan, 'T2')?.changes.map(({ path }) => path), ['src/reader.ts']);
  assert.equal(taskMapRows(plan).find(({ id }) => id === 'T2')?.outcome, 'Read through the contract — The reader decodes records with the shared shape.');
  assert.deepEqual(plan.tasks.find(({ id }) => id === 'T2')?.constraints, ['Preserve unknown fields.']);
});

test('task-map rejects missing, duplicate, orphan, mismatched, and repeated metadata', () => {
  const row = '| T1 | Cap fetch retries | Fetch stops retrying after three attempts so callers fail fast. | none | SC1, SC2 |';
  const missing = PLAN.replace(`${row}\n`, '');
  assert.ok(defects(missing).includes('task-map'), 'missing task row');
  assert.ok(defects(PLAN.replace('## Task Map\n', '## Task Map\n\n## Task Map\n')).includes('task-map'), 'duplicate Task Map section');
  assert.ok(defects(PLAN.replace(row, `${row}\n| T9 | Extra | Extra work. | none | SC1 |`)).includes('task-map'), 'orphan row');
  const mismatch = PLAN.replace(row, row.replace('Cap fetch retries', 'Other title'));
  assert.ok(defects(mismatch).includes('task-map'), 'title mismatch');
  const wrongWidth = PLAN.replace(row, '| T1 | Cap fetch retries | outcome | none |');
  const wrongWidthResult = parsePlan(wrongWidth);
  assert.ok(!wrongWidthResult.ok && wrongWidthResult.defects.some((item) => item.code === 'task-map' && item.line === wrongWidth.split('\n').indexOf('| T1 | Cap fetch retries | outcome | none |') + 1), 'malformed row has source line');
  assert.ok(defects(PLAN.replace('### T1 — Cap fetch retries', '### T1 — Cap fetch retries\n- Criteria: SC1')).includes('task-map'), 'task metadata stays in the map');
  assert.ok(defects(PLAN.replace(row, `${row}\n| T1 | Duplicate | Duplicate row. | none | SC1 |`)).includes('duplicate-id'), 'duplicate map ID');
});

test('unmapped task sections keep graph diagnostics on the Task Map', () => {
  const row = '| T2 | Read through the contract | The reader decodes records with the shared shape. | T1 | SC2 |';
  const source = TASKS.replace(row + '\n', '');
  const result = parsePlan(source);
  assert.ok(!result.ok, JSON.stringify(result));
  assert.deepEqual(result.defects.filter(({ message }) => message.startsWith('Task T2')).map(({ code }) => code), ['task-map']);
  assert.ok(result.defects.some(({ code, message }) => code === 'task-criteria' && message.includes('SC2') && message.includes('Task Map row')));

  const withoutChanges = parsePlan(source.replace('#### [MODIFY] src/reader.ts\n- Changes: decode with the contract.\n', ''));
  assert.ok(!withoutChanges.ok && withoutChanges.defects.some(({ code, message }) => code === 'task-ownership' && message === 'Task T2 owns no file change.'));
  const duplicateSection = parsePlan(TASKS.replace('### T3 — Write through the contract', '### T2 — Write through the contract'));
  assert.ok(!duplicateSection.ok && duplicateSection.defects.some(({ code }) => code === 'duplicate-id'));
});

test('task-map: derived writer rows preserve map metadata and task-owned overlap', () => {
  const source = overlapPlan();
  const plan = parsed(source);
  assert.deepEqual(taskMapRows(plan).map(({ id, prerequisites, criteria, paths }) => ({ id, prerequisites, criteria, paths })),
    plan.tasks.map(({ id, prerequisites, criteria, paths }) => ({ id, prerequisites, criteria, paths })));
  assert.deepEqual(taskMapRows(plan).map((row) => row.overlap), [[], [{ path: 'src/shared.ts', tasks: ['T3'] }], [{ path: 'src/shared.ts', tasks: ['T2'] }]]);
  assert.equal(taskMapRows(plan)[1]?.outcome, 'Read through the contract — The reader decodes records with the shared shape.');
  assert.equal(taskMapRows(plan)[0]?.outcome, 'Define the shared contract — Consumers share one exported shape so they cannot drift.');
});

test('task-map-shared-context: authored map bytes reach the writer and bind the governed hash', () => {
  const source = overlapPlan();
  const plan = parsed(source);
  assert.ok(source.includes('## Task Map'));
  assert.ok(plan.sharedContext.includes('| ID | Title | Outcome | Prerequisites | Criteria |'), plan.sharedContext);
  assert.ok(plan.sharedContext.includes('| T2 | Read through the contract | The reader decodes records with the shared shape. | T1 | SC2 |'));
  assert.ok(!plan.sharedContext.includes('## Proposed Changes'));
  assert.ok(!plan.sharedContext.includes('Preserve unknown fields.'), 'task constraints stay outside the shared map');
  const edited = source.replace('| T1 | Define the shared contract | Consumers share one exported shape so they cannot drift. | none | SC1 |', '| T1 | Define the shared contract | Consumers share one exported shape without drift. | none | SC1 |');
  assert.notEqual(governedPlanText(edited), governedPlanText(source));
  assert.notEqual(parsed(edited).sharedContext, plan.sharedContext);
  assert.equal(governedPlanText(source), governedPlanText(source.replace('*No reviews conducted yet.*', '### Review r\n- Resolved.')));
});

test('plan summary: Parent rejects invalid pins (user request, unsuffixed)', () => {
  for (const parent of [
    'user request',
    '`notes.txt` · sha256:' + 'a'.repeat(64),
    'governing.spec.md · sha256:' + 'a'.repeat(64),
  ]) {
    assert.ok(defects(PLAN.replace(/`governing.spec.md` · sha256:a{64}/, parent)).includes('summary-label'), parent);
  }
});

test('plan summary: Parent accepts spec pin and design increment pin', () => {
  assert.ok(parsePlan(PLAN).ok);
  assert.ok(parsePlan(PLAN.replace(/`governing.spec.md` · sha256:a{64}/, '`governing.design.md` · I01')).ok);
});

test('plan retired section user review required', () => assert.ok(defects(PLAN + '\n## User Review Required\nNone.').includes('retired-section')));

test('plan criterion satisfies ids parsed', () => {
  const plan = parsed(PLAN.replace('Satisfies: REQ-1', 'Satisfies: REQ-1, REQ-2'));
  assert.deepEqual(plan.criteria[0]?.satisfies, ['REQ-1', 'REQ-2']);
});

test('plan criterion missing satisfies rejected', () => { for (const value of ['', '  - Satisfies: \n', '  - Satisfies: REQ-1, DEC-1\n']) assert.ok(defects(PLAN.replace('  - Satisfies: REQ-1\n', value)).includes('missing-satisfies')); });

test('warns when transient coverage names a durable criterion without FINAL verification',()=>{
 const source=transient('  - Retain: transient\n  - Covered by: SC2\n').replace('`npm test` [FINAL]','`npm test`');
 const result=okPlan(source);assert.ok(result.warnings.some(w=>w.code==='transient-coverage'&&w.message.includes('plan-level')));
 assert.equal(okPlan(transient('  - Retain: transient\n  - Covered by: SC2\n')).warnings.some(w=>w.code==='transient-coverage'),false);
});


test('transient tests require a non-support test target',()=>{
 const source=isolated.replaceAll('tests/fetch.transient.test.ts','tests/fixtures/fetch.json');
 assert.equal(transientPathDefects(source).length,1);
});

test('plan human layout: At a Glance is required and shared sections precede the Task Map', () => {
  assert.ok(parsePlan(PLAN).warnings.some(row => row.code === 'missing-section'));
  const source = PLAN.replace('## Key Decisions & Context', '## At a Glance\n- Retry cap.\n\n## Background\n- Context.\n\n## Key Interfaces & Data\n- Contract.\n\n## Key Decisions & Context').replace('## Task Map', '## Constraints\n- Keep API.\n\n## Task Map');
  const result = parsePlan(source);
  assert.ok(result.ok);
  assert.ok(!result.warnings.some(row => ['missing-section', 'section-order'].includes(row.code)));
  for (const heading of ['At a Glance', 'Key Interfaces & Data', 'Constraints']) assert.ok(result.plan.sharedContext.includes(`## ${heading}`));
  assert.ok(!result.plan.sharedContext.includes('#### [MODIFY]'));
  assert.ok(parsePlan(source.replace('## At a Glance', '## Constraints').replace('## Constraints\n- Keep API.', '## At a Glance\n- Keep API.')).warnings.some(row => row.code === 'section-order'));
});

const collapsed = (source: string) => source
  .replace('### T1 — Cap fetch retries', '### T1 — Cap fetch retries\n<details>\n<summary>Retry implementation</summary>\n')
  .replace('## Success Criteria', '</details>\n\n## Success Criteria')
  .replace(/(- \[SC\d+\][^\n]*\n)/g, '$1  <details>\n  <summary>Checks</summary>\n\n')
  .replace('- [SC2]', '  </details>\n\n- [SC2]')
  .replace('## Verification Plan', '  </details>\n\n## Verification Plan');

test('plan human layout: details wrappers and callouts leave parse results unchanged', () => {
  const source = collapsed(readable()).replace('## Task Map', '> [!NOTE]\n> User context.\n\n## Task Map');
  const stripLines = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === 'line' ? undefined : item));
  const plain = parsed(readable()), wrapped = parsed(source);
  for (const key of ['tasks', 'changes', 'criteria', 'verification'] as const) assert.deepEqual(stripLines(wrapped[key]), stripLines(plain[key]));
  const vocabulary = placeholderVocabulary(['````markdown\n<details>\n<summary>Checks</summary>\n<unfilled>\n</details>\n````']);
  assert.deepEqual(parsePlan(source, { placeholders: vocabulary }).warnings.filter(row => row.code === 'leftover-placeholder'), []);
  assert.ok(parsePlan(source + '\n<unfilled>', { placeholders: vocabulary }).warnings.some(row => row.code === 'leftover-placeholder'));
  assert.ok(defects(PLAN.replace('### T1 — Cap fetch retries', '### T1 — Cap fetch retries\n<div>Other HTML</div>')).includes('task-map'));
});

test('plan human layout: long prose paragraphs warn and structured blocks are exempt', () => {
  const words = (n: number) => Array(n).fill('word').join(' ');
  const body = [words(60), `${words(30)}\n${words(31)}`, `- ${words(70)}\n  ${words(70)}`, `| ${words(70)} |`, `\`\`\`\n${words(70)}\n\`\`\``, `> ${words(70)}`, `<details>\n<summary>${words(70)}</summary>\n</details>`, `    ${words(70)}`, `<span>${words(61)}</span>`].join('\n\n');
  const source = PLAN.replace('## Key Decisions & Context', `## At a Glance\n${body}\n\n## Key Decisions & Context`);
  const warnings = parsePlan(source).warnings.filter(row => row.code === 'long-paragraph');
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0]?.line, source.split('\n').indexOf(words(30)) + 1);
  assert.ok(warnings.every(row => row.severity === 'warning'));
});
