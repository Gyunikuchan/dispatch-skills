import assert from 'node:assert/strict';
import { test } from 'node:test';

import { governedPlanText, materializePlanRevisionSeed, normalizePlanPath, parsePlan, selectTaskBrief, structuralLines, placeholderVocabulary, taskExecutionSummary } from '../../../skills/dispatch/scripts/domain/plan.ts';
import { asParsedPlan } from '../../../skills/dispatch/scripts/machines/implement-types.ts';

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
### T1 — Cap fetch retries
Fetch stops retrying after three attempts so callers fail fast.
- Prerequisites: none
- Criteria: SC1, SC2

#### [MODIFY] src/fetch.ts
- Changes: add a retry counter to fetchWithRetry.
#### [NEW] tests/fetch.test.ts
- Purpose: pins the retry cap.
#### [GENERATED] docs/api.md
- Command: \`npm run docs\`
- Inputs: src/fetch.ts

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

const readable = (source = PLAN) => source.replace(/^#### /gm, '- #### ').replace(/^(- (?:Changes|Purpose|Command|Inputs):.*)$/gm, '  $1');
const parsed = (source: string) => { const result = parsePlan(source); assert.ok(result.ok, JSON.stringify(result)); return result.plan; };

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
  const generated = parsed(consecutive.replace('src/fetch.ts, tests/fetch.test.ts', 'src/fetch.ts'));
  assert.equal(generated.changes[0]?.command, null);
  assert.equal(generated.changes[0]?.note, 'add a retry counter to fetchWithRetry.');
  assert.equal(generated.changes[1]?.command, 'npm run docs');
  assert.deepEqual(generated.tasks[0]?.generated, [{ path: 'docs/api.md', inputs: ['src/fetch.ts'] }]);
});

test('readable plan syntax: owned briefs carry Outcome, Constraints and every labelled invariant once', () => {
  const source = readable().replace('Fetch stops retrying after three attempts so callers fail fast.', '- Outcome: Fetch stops retrying.\n- Constraints: Keep the public API.')
    .replace('  - Changes: add a retry counter to fetchWithRetry.', '  - Changes: add a retry counter to fetchWithRetry.\n  - Invariants: Preserve retry ordering.\n    - Exception: zero retries still calls once.\n      Keep the callback.\n  - Invariants: Preserve errors.\n  - Notes: optional context only.')
    .replace('### T1 —', '### T1 —')
    .replace('- Criteria: SC1, SC2', '- Criteria: SC1')
    .replace('- #### [NEW] tests/fetch.test.ts\n  - Purpose: pins the retry cap.', '- #### [NEW] tests/fetch.test.ts\n  - Purpose: pins the retry cap.')
    .replace('## Verification Plan', '### T2 — Check the companion\n- Outcome: Check the companion.\n- Prerequisites: T1\n- Criteria: SC2\n- #### [MODIFY] src/companion.ts\n  - Changes: Check companion output.\n  - Invariants: Preserve companion shape.\n\n## Verification Plan');
  const plan = parsed(source);
  const first = selectTaskBrief(plan, 'T1'), second = selectTaskBrief(plan, 'T2');
  assert.ok(first); assert.ok(second);
  assert.equal(first.task.summary, 'Fetch stops retrying. Constraints: Keep the public API.');
  const note = first.changes.find(c => c.path === 'src/fetch.ts')!.note;
  for (const text of ['Invariants: Preserve retry ordering.', 'Exception: zero retries still calls once.', 'Keep the callback.', 'Invariants: Preserve errors.']) assert.equal(note.split(text).length - 1, 1);
  assert.ok(!JSON.stringify(first).includes('optional context only'));
  assert.ok(!JSON.stringify(first).includes('Preserve companion shape'));
  assert.ok(!JSON.stringify(second).includes('Preserve retry ordering'));
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

test('readable plan revision: additions preserve nested constraints, generated inputs and summary hard breaks', () => {
  const source = readable().replace('> **Scope:** src/fetch.ts', '> **Scope:** src/fetch.ts  ').replace('  - Changes: add a retry counter to fetchWithRetry.', '  - Changes: add a retry counter to fetchWithRetry.\n  - Invariants: Preserve errors.');
  const base = parsed(source);
  const effective = { ...base, criteria: [...base.criteria, { ...base.criteria[1]!, id: 'SC3', title: 'Check extra output', changes: ['src/extra.ts'], verify: [{ command: 'npm run extra', final: false }] }], changes: [...base.changes, { action: 'MODIFY' as const, path: 'src/extra.ts', note: 'Check extra.\nInvariants: Preserve shape.\n  - Keep order.', command: null, line: 0 }], tasks: base.tasks.map(t => ({ ...t, paths: [...t.paths, 'src/extra.ts'], criteria: [...t.criteria, 'SC3'] })) };
  const seed = materializePlanRevisionSeed(source, base, effective);
  const revised = parsed(seed);
  assert.match(seed, /> \*\*Scope:\*\* src\/fetch.ts, src\/extra.ts  \n/);
  assert.match(seed, /- #### \[MODIFY\] src\/extra.ts\n  - Changes: Check extra.\n  - Invariants: Preserve shape.\n    - Keep order./);
  assert.deepEqual(revised.tasks[0]?.generated, base.tasks[0]?.generated);
  assert.equal(revised.changes[0]?.note, base.changes[0]?.note);
  assert.deepEqual(revised.criteria[2]?.changes, ['src/extra.ts']);
  assert.ok(revised.tasks[0]?.criteria.includes('SC3'));
  assert.equal(revised.changes.filter(c => c.path === 'src/extra.ts').length, 1);
  assert.equal(materializePlanRevisionSeed(seed, base, effective), seed);
  assert.equal(governedPlanText(seed), governedPlanText(seed.replace('*No reviews conducted yet.*', 'Changed driver review.')));
});

for (const note of ['  - Add the counter.\n    Preserve callback order.\n  - Bound the attempts.', 'Invariants: Keep API.\n  - Keep flag.']) {
  test(`readable plan revision: accepted ${note.startsWith('Invariants:') ? 'invariant-only' : 'continuation-only'} notes keep their labels and indentation`, () => {
    const source = readable(), base = parsed(source);
    const effective = { ...base, changes: [...base.changes, { action: 'MODIFY' as const, path: 'src/extra.ts', note, command: null, line: 0 }], tasks: base.tasks.map(t => ({ ...t, paths: [...t.paths, 'src/extra.ts'] })) };
    const seed = materializePlanRevisionSeed(source, base, effective);
    assert.equal(parsed(seed).changes.find(c => c.path === 'src/extra.ts')?.note, note);
    assert.match(seed, note.startsWith('Invariants:') ? /- #### \[MODIFY\] src\/extra.ts\n  - Invariants: Keep API./ : /- #### \[MODIFY\] src\/extra.ts\n  - Changes:\n    - Add the counter./);
    assert.equal(materializePlanRevisionSeed(seed, base, effective), seed);
  });
}

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

test('implement-plan-revision: seed carries accepted scope into the editable plan', () => {
  const parsed = parsePlan(PLAN);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const base = parsed.plan;
  const extra = {
    id: 'SC3', title: 'Accepted companion behavior', line: 0, changes: ['src/extra.ts'], verify: [{ command: 'npm run check-extra', final: false }],
    evidence: 'verify' as const, preExisting: false, redException: null, testRationale: 'Checks the accepted companion behavior directly.', review: null, enforcementInfeasibility: null,
  };
  const effective = {
    ...base,
    keyDecisions: [...base.keyDecisions, 'Preserve the accepted companion behavior.'],
    criteria: [...base.criteria, extra],
    tasks: base.tasks.map((task) => task.id === 'T1' ? { ...task, paths: [...task.paths, 'src/extra.ts'], criteria: [...task.criteria, 'SC3'] } : task),
    changes: [...base.changes, { action: 'MODIFY' as const, path: 'src/extra.ts', note: 'Accepted companion scope.', command: null, line: 0 }],
    verification: { automated: [...base.verification.automated, 'npm run check-extra', 'npm run extra-check'], none: null, manual: [...base.verification.manual, 'Confirm companion behavior in the local service.'] },
    finalCommands: [...base.finalCommands, 'npm run final-companion-check'],
  };
  const seed = materializePlanRevisionSeed(PLAN, base, effective);
  const revised = parsePlan(seed);
  assert.ok(revised.ok, JSON.stringify(revised));
  assert.ok(seed.includes('Fetch stops retrying after three attempts so callers fail fast.'));
  assert.match(seed, /^> \*\*Scope:\*\*.*src\/extra\.ts/m);
  assert.deepEqual(revised.plan.tasks.find((task) => task.id === 'T1')?.paths, [...base.tasks[0]!.paths, 'src/extra.ts']);
  assert.ok(revised.plan.tasks.find((task) => task.id === 'T1')?.criteria.includes('SC3'));
  assert.deepEqual(revised.plan.criteria.find((criterion) => criterion.id === 'SC3')?.changes, ['src/extra.ts']);
  assert.ok(revised.plan.verification.automated.includes('npm run extra-check'));
  assert.ok(revised.plan.criteria.find((criterion) => criterion.id === 'SC3')?.verify.some((item) => item.command === 'npm run final-companion-check' && item.final));
  assert.ok(revised.plan.keyDecisions.includes('Preserve the accepted companion behavior.'));
  assert.ok(revised.plan.verification.manual.includes('Confirm companion behavior in the local service.'));
});

test('implement-plan-revision: seed assigns accepted hotfix paths that have no task owner', () => {
  const parsed = parsePlan(PLAN);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const base = parsed.plan;
  const effective = {
    ...base,
    criteria: base.criteria.map((criterion) => criterion.id === 'SC1' ? { ...criterion, changes: [...criterion.changes, 'src/hotfix-helper.ts'] } : criterion),
    changes: [...base.changes, { action: 'MODIFY' as const, path: 'src/hotfix-helper.ts', note: 'Accepted hotfix scope.', command: null, line: 0 }],
  };
  const seed = materializePlanRevisionSeed(PLAN, base, effective);
  const revised = parsePlan(seed);
  assert.ok(revised.ok, JSON.stringify(revised));
  assert.ok(seed.includes('#### [MODIFY] src/hotfix-helper.ts'));
  assert.ok(revised.plan.tasks.find((task) => task.id === 'T1')?.paths.includes('src/hotfix-helper.ts'));
  assert.ok(revised.plan.criteria.find((criterion) => criterion.id === 'SC1')?.changes.includes('src/hotfix-helper.ts'));
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

const TASKS = `# Shared contract with consumers

> **TL;DR:** consumers need one shared contract.
> **Parent:** user request
> **Decide:** none
> **Risk:** low — isolated modules
> **Scope:** src/

## Success Criteria
- [SC1] Contract exports the shape
  - Changes: src/contract.ts
  - Verify: \`node --test tests/contract.test.ts\`
  - Evidence: verify
  - Test rationale: pins the exported shape consumers rely on.
- [SC2] Reader consumes the contract
  - Changes: src/reader.ts
  - Verify: \`node --test tests/reader.test.ts\`
  - Evidence: verify
  - Test rationale: covers the reader path through the contract.
- [SC3] Writer consumes the contract
  - Changes: src/writer.ts
  - Verify: \`node --test tests/writer.test.ts\`
  - Evidence: verify
  - Test rationale: covers the writer path through the contract.
- [SC4] Reader and writer round-trip
  - Verify: \`node --test tests/roundtrip.test.ts\` [FINAL]
  - Evidence: verify
  - Integration: spans reader and writer tasks.
  - Test rationale: proves both consumers agree on the encoding.

## Proposed Changes

### T1 — Define the shared contract
Consumers share one exported shape so they cannot drift.
- Prerequisites: none
- Criteria: SC1

#### [NEW] src/contract.ts
- Purpose: exports the shared shape.

### T2 — Read through the contract
The reader decodes records with the shared shape.
- Prerequisites: T1
- Criteria: SC2

#### [MODIFY] src/reader.ts
- Changes: decode with the contract.

### T3 — Write through the contract
The writer encodes records with the shared shape and regenerates the docs.
- Prerequisites: T1
- Criteria: SC3

#### [MODIFY] src/writer.ts
- Changes: encode with the contract.
#### [GENERATED] docs/contract.md
- Command: \`npm run docs\`
- Inputs: src/contract.ts, src/writer.ts, README.md

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
  assert.deepEqual(tasks[2]?.generated, [{ path: 'docs/contract.md', inputs: ['src/contract.ts', 'src/writer.ts', 'README.md'] }]);
  assert.deepEqual(result.plan.changes.map((change) => change.path), ['src/contract.ts', 'src/reader.ts', 'src/writer.ts', 'docs/contract.md']);
});

test('task-plan: rejects graph defects', () => {
  const cases: [string, string, string][] = [
    ['untasked entry', '### T1 — Define the shared contract\nConsumers share one exported shape so they cannot drift.\n- Prerequisites: none\n- Criteria: SC1\n', 'task-ownership'],
    ['malformed heading', '### T2 — Read', 'task-heading'],
    ['empty summary', 'The reader decodes records with the shared shape.\n', 'task-summary'],
    ['duplicate id', '### T3 — Write', 'duplicate-id'],
    ['unknown prerequisite', '- Prerequisites: T1\n- Criteria: SC2', 'missing-prerequisite'],
    ['missing prerequisites bullet', '- Prerequisites: T1\n- Criteria: SC3', 'missing-prerequisite'],
    ['cycle', '- Prerequisites: none\n- Criteria: SC1', 'cycle'],
  ];
  const replacements: Record<string, string> = {
    'untasked entry': '', 'malformed heading': '### Reader — Read', 'empty summary': '', 'duplicate id': '### T2 — Write',
    'unknown prerequisite': '- Prerequisites: T9\n- Criteria: SC2', 'missing prerequisites bullet': '- Criteria: SC3',
    cycle: '- Prerequisites: T2\n- Criteria: SC1',
  };
  for (const [name, from, code] of cases) assert.ok(defects(TASKS.replace(from, replacements[name] ?? '')).some((item) => item === code), name);
  for (const summary of ['TBD', 'Same.']) assert.ok(defects(TASKS.replace('The reader decodes records with the shared shape.', summary)).includes('task-summary'), summary);
});

test('task-plan: rejects mapping defects', () => {
  assert.ok(defects(TASKS.replace('- Criteria: SC2', '- Criteria: SC1')).includes('task-criteria'), 'double-mapped');
  assert.ok(defects(TASKS.replace('- Criteria: SC2', '- Criteria: SC2, SC9')).includes('task-criteria'), 'unknown criterion');
  assert.ok(defects(TASKS.replace('  - Integration: spans reader and writer tasks.\n', '')).includes('task-criteria'), 'unmapped criterion');
  assert.ok(defects(TASKS.replace('- Criteria: SC2', '- Criteria: none')).includes('task-criteria'), 'task without criteria');
  assert.ok(defects(TASKS.replace('  - Changes: src/reader.ts\n', '  - Changes: src/reader.ts, src/writer.ts\n')).includes('task-criteria'), 'foreign path');
  assert.ok(defects(TASKS.replace('- Criteria: SC3', '- Criteria: SC3, SC4')).includes('task-criteria'), 'task-mapped integration criterion');
  assert.ok(defects(TASKS.replace('#### [MODIFY] src/writer.ts', '#### [MODIFY] src/Reader.ts')).includes('duplicate-change-path'), 'case alias');
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
  const result = parsePlan(TASKS.replace('- Criteria: SC2', '- criteria: sc2, `SC2`'));
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.plan.tasks[1]?.criteria, ['SC2']);
});

test('task-plan: empty prerequisite values and deleted generated inputs are rejected', () => {
  for (const value of ['', ', ,']) assert.ok(defects(TASKS.replace('- Prerequisites: T1\n- Criteria: SC2', `- Prerequisites: ${value}\n- Criteria: SC2`)).includes('missing-prerequisite'), JSON.stringify(value));
  const deleted = TASKS.replace('#### [MODIFY] src/reader.ts', '#### [DELETE] src/reader.ts').replace('src/writer.ts, README.md', 'src/writer.ts, src/reader.ts').replace('- Prerequisites: T1\n- Criteria: SC3', '- Prerequisites: T1, T2\n- Criteria: SC3');
  assert.ok(defects(deleted).includes('generated-inputs'));
});

test('task-plan: the journal boundary preserves the task graph and rejects pre-task payloads', () => {
  const result = parsePlan(TASKS);
  assert.ok(result.ok);
  const payload = JSON.parse(JSON.stringify(result.plan)) as Record<string, unknown>;
  assert.deepEqual(asParsedPlan(payload)?.tasks, result.plan.tasks);
  const { tasks: _tasks, ...legacy } = payload;
  assert.equal(asParsedPlan(legacy), null);
});
