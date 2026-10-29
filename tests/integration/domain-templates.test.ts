import { qualityBar } from '../../skills/dispatch/scripts/toolkit/domain/prompt.ts';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePlan, selectTaskBrief } from '../../skills/dispatch/scripts/toolkit/domain/plan.ts';
import { parseDesign } from '../../skills/dispatch/scripts/toolkit/domain/design.ts';
import { parseSpec } from '../../skills/dispatch/scripts/toolkit/domain/spec.ts';
import { reviewPrompt } from '../../skills/dispatch/scripts/toolkit/prompts.ts';
import { renderWalkthrough } from '../../skills/dispatch/scripts/toolkit/walkthrough.ts';

const root = new URL('../../skills/dispatch/references/templates/', import.meta.url);
const KEPT = [
  'review-prompt.md', 'review-prompt-code.md', 'review-prompt-design.md', 'review-prompt-plan.md', 'plan.md', 'design.md', 'walkthrough.md', 'spec.md',
  'writer-brief.md', 'quality-bar.md', 'context-map.md', 'explorer-brief.md',
];

test('code review evidence is actionable with and without a bound plan', () => {
  for (const planPath of [undefined, 'work.plan.md']) {
    const prompt = reviewPrompt('code', {skillRoot: path.resolve('skills/dispatch'), spec: {path: 'mission.spec.md', hash: 'sha256:' + 'a'.repeat(64)}, artifact: 'worktree', scope: 'Full review', ...(planPath ? {planPath} : {})});
    assert.ok(prompt.includes(`- Plan: ${planPath ?? 'None'}`));
    assert.doesNotMatch(prompt, /Walkthrough|absent or unfilled table|<Walkthrough Path>/);
    assert.match(prompt, /selected diff and tests/);
    assert.match(prompt, /does not establish that verification commands ran or final gates passed/);
  }
});

test('plan template shows behaviour before task details', () => {
  const template = readFileSync(new URL('plan.md', root), 'utf8');
  const skeleton = template.split('````markdown\n')[1]!.split('````')[0]!;
  const task = skeleton.split('### T<n> — <Task title>')[1]!.split('\n## Success Criteria')[0]!;
  assert.match(task, /- <Observable behaviour this task implements and how it works\.>\n\n<details>/);
  assert.doesNotMatch(task, /<summary>/);
  const criteria = skeleton.split('## Success Criteria\n')[1]!.split('\n## Verification Plan')[0]!;
  assert.match(criteria, /- \[SC1\] <checkable outcome>\n  <details>\n\n  - Satisfies:/);
  assert.doesNotMatch(criteria, /<summary>/);
});

test('design template shows behaviour before increment details', () => {
  const template = readFileSync(new URL('design.md', root), 'utf8');
  const skeleton = template.split('````markdown\n')[1]!.split('````')[0]!;
  const increment = skeleton.split('### I01\n')[1]!.split('\n## Final Integration')[0]!;
  assert.match(increment, /- <Observable behaviour this increment implements and how it works\.>\n\n<details>/);
  assert.doesNotMatch(increment, /<summary>/);
});

test('readable artifact templates: human layout sections, callouts, details and diagrams', async (t) => {
  for (const name of ['spec.md', 'design.md', 'plan.md', 'walkthrough.md']) {
    const template = readFileSync(new URL(name, root), 'utf8');
    const skeleton = template.split('````markdown\n')[1]!.split('````')[0]!;
    assert.equal(skeleton.match(/^## .+$/m)?.[0], '## At a Glance', name);
    if (name !== 'walkthrough.md') for (const type of ['NOTE', 'IMPORTANT']) assert.ok(template.includes(`[!${type}]`), `${name}: ${type}`);
    if (name !== 'spec.md') {
      assert.match(skeleton, /<details>\n/, name);
      assert.match(skeleton, /\n\n<\/details>/, name);
    }
    if (name === 'design.md') assert.doesNotMatch(skeleton, /<summary>[^<]*<\/summary>/, name);
    if (name === 'walkthrough.md') assert.match(skeleton, /<summary>Audit records<\/summary>/, name);
    if (name === 'plan.md' || name === 'design.md') {
      assert.match(skeleton, /```mermaid\n/, name);
      assert.match(skeleton, /Text summary: .+/, name);
    }
  }

  await t.test('design template parses under layered lint and preserves executable fields and exclusions', () => {
    const template = readFileSync(new URL('design.md', root), 'utf8').replace(/\r\n/g, '\n');
    assert.equal((template.match(/^> \*\*.*$/gm) ?? []).length, 4);
    assert.equal((template.match(/^>$/gm) ?? []).length, 3);
    const order = ['## At a Glance', '## Execution Status', '## Approach', '## Alternatives & Decisions', '## Risks, Security & Operations', '## Architecture & Boundaries', '## Increment Dependency Graph', '## Increment Details', '## Final Integration', '## Review Findings & Resolutions'];
    for (let i = 1; i < order.length; i++) assert.ok(template.indexOf(order[i]!) > template.indexOf(order[i - 1]!), order[i]);
    let source = template.split('````markdown\n')[1]!.split('````')[0]!;
    source = source.replace('<`<spec path>` · sha256:<hex>>', '`governing.spec.md` · sha256:' + 'a'.repeat(64))
      .replace('<low|med|high>', 'low').replace('<count>', '1')
      .replace(/\| I02 .*\n/, '').replace(/Next Action: .*\n/, 'Next Action: complete\n');
    source = source.replace('REQ-<n>', 'REQ-1').split('\n').map((line) => /^<\/?(?:details|summary)>/.test(line) ? line : line.replace(/<[^>]+>/g, 'Concrete behavior')).join('\n');
    const parsed = parseDesign(source);
    assert.ok(parsed.ok, JSON.stringify(parsed));
    assert.deepEqual(parsed.warnings.filter(({ code }) => ['missing-section', 'section-order', 'long-paragraph'].includes(code)), []);
    assert.equal(parsed.design.increments[0]!.id, 'I01');
    assert.deepEqual(parsed.warnings.filter(({ code }) => code === 'increment-behaviour'), []);
    assert.deepEqual(parsed.design.increments[0]!.behaviour, ['Concrete behavior']);
    assert.equal(parsed.design.details['I01']!['Outcome'], 'Concrete behavior');
    assert.ok(!parsed.design.governedText.includes('## Execution Status'));
    assert.ok(!parsed.design.governedText.includes('## Review Findings & Resolutions'));
  });

  await t.test('walkthrough template uses the reviewer-first layout', () => {
    const template = readFileSync(new URL('walkthrough.md', root), 'utf8').replace(/\r\n/g, '\n');
    assert.equal((template.match(/^> \*\*.*$/gm) ?? []).length, 0);
    assert.equal((template.match(/^>$/gm) ?? []).length, 0);
    assert.match(template, /^- \*\*How it works:\*\*/m);
    assert.match(template, /^- \*\*Counts:\*\*/m);
    const skeleton = template.split('````markdown\n')[1]!.split('````')[0]!;
    assert.match(skeleton, /### T<n> — <task title>\n\n- <observable behavior from this task>\n\n<details>/);
    assert.match(skeleton, /- `<relative-path>` · <created \| modified \| deleted>/);
    assert.doesNotMatch(skeleton, /#### \[|Changes:/);
    assert.match(skeleton, /<summary>Audit records<\/summary>/);
    assert.match(skeleton, /\| SC \| Evidence \|/);
    const labels = [...skeleton.matchAll(/^- \*\*(What|How it works|Counts):\*\*/gm)].map((match) => match[1]);
    assert.deepEqual(labels, ['What', 'How it works', 'Counts']);
    const headings = (text: string) => [...text.matchAll(/^##? .+$/gm)].map((match) => match[0]).filter((heading) => heading.startsWith('## '));
    assert.deepEqual(headings(skeleton), ['## At a Glance', '## Visuals', '## Review Focus', '## Behaviour Changes', '## Verification', '## Deviations & Follow-ups', '## Review Findings & Resolutions', '## Appendix']);
    const boxLabels = (text: string) => [...text.matchAll(/^> \*\*([^:]+):\*\*/gm)].map((match) => match[1]);
    assert.deepEqual(boxLabels(template), []);
    assert.match(template, /\[review rules\]\(\.\.\/review-rules.md\)/);

    const rendered = renderWalkthrough({
      title: 'Example', specPath: 'example.spec.md', specHash: `sha256:${'a'.repeat(64)}`,
      planPath: 'example.plan.md', planHash: `sha256:${'b'.repeat(64)}`, risk: 'med', delivered: null,
      glance: { what: 'The example shows the result.', how: 'The report reads the bound plan.', visuals: '' },
      focus: { bullets: [] },
      tasks: [{ id: 'T1', title: 'Add a file', outcome: 'The new file supports the feature.', behaviour: ['The report describes the feature.'] }],
      statuses: [{ criterion: 'SC1', state: 'manual', seq: 1, quote: 'approved', evidence: 'manual/proof.md' }],
      changes: [{ action: 'NEW', path: 'src/new.ts', owners: [{ id: 'T1', title: 'Add a file' }] }],
      edits: [], unplannedPaths: [], openEscalations: [], deferredRulings: [], userRecords: [],
      reviewRows: [], reviewRounds: [], reviewFixes: [],
    } as Parameters<typeof renderWalkthrough>[0]);
    assert.deepEqual(headings(skeleton), headings(rendered));
    const summaryLabels = (text: string) => [...text.matchAll(/^- \*\*(What|How it works|Counts):\*\*/gm)].map((match) => match[1]);
    assert.deepEqual(summaryLabels(skeleton), summaryLabels(rendered));
    assert.match(rendered, /### T1 — Add a file\n\n- The report describes the feature\.\n\n<details>\n\n- `src\/new\.ts` · created\n\n<\/details>/);
    assert.match(rendered, /### Manual\n\n- SC1 · User evidence: manual\/proof\.md; quote: approved/);
    assert.doesNotMatch(rendered, /#### \[|Changes:/);
  });

  await t.test('plan template parses under layered lint and preserves executable contracts', () => {
    const template = readFileSync(new URL('plan.md', root), 'utf8');
    const order = ['## At a Glance', '## Background', '## Key Interfaces & Data', '## Key Decisions & Context', '## Constraints', '## Open Questions & Assumptions', '## Out of Scope', '## Task Map', '## Technical-Design Traceability', '## Proposed Changes', '## Success Criteria', '## Verification Plan', '## Rollback & Blast Radius', '## Review Findings & Resolutions'];
    for (let i = 1; i < order.length; i++) assert.ok(template.indexOf(order[i]!) > template.indexOf(order[i - 1]!));
    assert.equal((template.match(/^> \*\*.*$/gm) ?? []).length, 4);
    assert.equal((template.match(/^>$/gm) ?? []).length, 3);
    assert.match(template, /- #### \[MODIFY\].*\n  - Changes:.*\n  - Invariants:/);
    for (const label of ['Omit optional empty prose sections', 'conditional fields', 'Pre-existing:', 'RED exception:', 'Enforcement infeasibility:', 'Integration:', 'Overlap:', 'Retain:', 'Covered by:', 'Seams:']) assert.ok(template.includes(label));
    let source = template.split('````markdown\n')[1]!.split('````')[0]!;
    source = source.replace(/## Success Criteria[\s\S]*?(?=## Verification Plan)/, '## Success Criteria\n- [SC1] Output stays usable\n  - Satisfies: REQ-1\n  - Changes: src/new.ts, src/edit.ts, src/delete.ts, src/generated.ts\n  - Verify: `npm test` [FINAL]\n  - Evidence: verify\n  - Test rationale: Checks the output.\n\n');
    source = source.replace(/## Verification Plan[\s\S]*?(?=## Review Findings)/, '## Verification Plan\n### Automated Tests\n- `npm run lint`\n\n');
    const replacements: Record<string, string> = { '<Goal Description>': 'Check output', '<problem and outcome>': 'Keep output usable', '<`<design path>` · I<nn> | `<spec path>` · sha256:<hex>>': '`governing.spec.md` · sha256:' + 'a'.repeat(64), '<reader decision, or none>': 'none', '<low|med|high>': 'low', '<reason>': 'isolated change', '<paths or components>': 'src', 'T<n>': 'T1', '<Task title>': 'Keep output usable', '<Plain-language outcome>': 'Keep output usable.', '<Observable behaviour this task implements and how it works.>': 'Keep output usable.', '<optional task-specific constraints, including why each non-obvious prerequisite is needed>': 'Keep API.', 'SC<n>[, SC<n>...]': 'SC1', '<file-specific exception>': 'keep deprecated flag', '<generator command>': 'npm run generate', '<path> — <why this unordered task also writes the path>': 'src/edit.ts — shares the edit with an unordered task' };
    for (const [key, value] of Object.entries(replacements)) source = source.replaceAll(key, value);
    const paths = ['src/new.ts', 'src/edit.ts', 'src/delete.ts', 'src/generated.ts'];
    for (const file of paths) source = source.replace('<relative-path>', file);
    source = source.replace('<relative-path>[, <relative-path>...]', 'src/edit.ts');
    const result = parsePlan(source); assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.warnings.filter(({ code }) => ['missing-section', 'section-order', 'long-paragraph'].includes(code)), []);
    const brief = selectTaskBrief(result.plan, 'T1')!;
    assert.equal(brief.task.summary, 'Keep output usable.');
    assert.deepEqual(result.warnings.filter(({ code }) => code === 'task-behaviour'), []);
    assert.deepEqual(brief.task.behaviour, ['Keep output usable.']);
    assert.deepEqual(brief.task.constraints, ['Keep API.']);
    assert.match(brief.changes[1]!.note, /Invariants:.*exception: keep deprecated flag/);
    assert.deepEqual(brief.task.generated, [{ path: 'src/generated.ts', inputs: ['src/edit.ts'] }]);
  });

  await t.test('templates: spec template skeleton lints cleanly', () => {
    const template = readFileSync(new URL('spec.md', root), 'utf8').replace(/\r\n/g, '\n');
    const source = template.split('````markdown\n')[1]!.split('````')[0]!
      .replace('### REQ-<n> — <title>', '### REQ-1 — Concrete title').replace('### DEC-<n> — <title>', '### DEC-1 — Concrete title');
    const result = parseSpec(source);
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.warnings.filter(({ code }) => ['missing-section', 'section-order', 'long-paragraph'].includes(code)), []);
  });

});

test('templates: every kept template exists and none are extra', () => {
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(fileURLToPath(root), path.join(entry.parentPath, entry.name)).replaceAll(path.sep, '/'));
  assert.deepEqual(files.sort(), [...KEPT].sort());
});

test('templates: no kept template contains <!--, rebuttal, or consensus', () => {
  for (const name of KEPT) {
    const text = readFileSync(new URL(name, root), 'utf8');
    for (const token of [/<!--/, /rebuttal/i, /consensus/i]) assert.ok(!token.test(text), `${name} contains ${String(token)}`);
  }
});

test('templates: plan.md shows [FINAL] after the Verify code span', () => {
  const plan = readFileSync(new URL('plan.md', root), 'utf8');
  assert.ok(plan.includes('- Verify: `<command>` [FINAL]'));
  assert.ok(!/Verify: `[^`\n]*\[FINAL\]`/.test(plan));
});

test('templates: plan.md owns task metadata in its map and keeps generated inputs under task details', () => {
  const plan = readFileSync(new URL('plan.md', root), 'utf8');
  for (const line of ['| ID | Title | Outcome | Prerequisites | Criteria |', '| T<n> | <Task title> | <Plain-language outcome> | none | SC<n>[, SC<n>...] |', '### T<n> — <Task title>', '- Constraints: <optional task-specific constraints, including why each non-obvious prerequisite is needed>', '- Inputs: <relative-path>[, <relative-path>...]', '  - Integration: <why this criterion spans tasks>']) {
    assert.ok(plan.includes(line), line);
  }
  assert.doesNotMatch(plan, /- Prerequisites:|^- Criteria:/m);
  assert.ok(!plan.includes('<Component Name>'));
});

test('quality selection: plan review checks task dependencies, ownership, and independence', () => {
  const prompt = readFileSync(new URL('review-prompt-plan.md', root), 'utf8');
  const bar = readFileSync(new URL('quality-bar.md', root), 'utf8');
  assert.match(bar, /^- \*\*decomposition\*\* — .*A task that consumes another's output without a prerequisite is a defect\. Treat contention on a shared write path as a defect only when neither a `Requires` ordering nor a justified `Overlap:` line covers it\. Shared port, cache, or output contention needs a prerequisite\./m);
  assert.match(prompt, /Use the selected sections of the \[quality bar\]\(quality-bar\.md\) to judge those targets/);
  assert.match(prompt, /The plan summary, success criteria and task graph/);
});

test('review prompts offer shared family tags each defined by a quality-bar bullet', async () => {
  const { REVIEW_TAGS } = await import('../../skills/dispatch/scripts/toolkit/domain/report.ts');
  const families = [
    'intent', 'spec', 'correctness', 'reliability', 'security', 'performance', 'compatibility',
    'maintainability', 'architecture', 'decomposition', 'operability', 'testing', 'usability', 'standards', 'adjacent',
  ] as const;
  const expectedByKind: Record<'code' | 'plan' | 'design', readonly string[]> = {
    code: families.filter((family) => family !== 'architecture' && family !== 'decomposition'),
    plan: families,
    design: families,
  };
  const sorted = (tags: readonly string[]) => [...tags].sort();
  assert.deepEqual(sorted([...REVIEW_TAGS]), sorted(families), 'validator vocabulary');
  const quality = readFileSync(new URL('quality-bar.md', root), 'utf8');
  for (const kind of ['code', 'plan', 'design'] as const) {
    const block = readFileSync(new URL(`review-prompt-${kind}.md`, root), 'utf8').split(/^## tags$/m)[1]!.split(/^## /m)[0]!;
    const offered = [...block.matchAll(/^- `([^`]+)`$/gm)].map((tag) => tag[1]!);
    assert.deepEqual(sorted(offered), sorted(expectedByKind[kind]), `${kind} prompt families`);
    const selectedQuality = qualityBar(quality, kind);
    for (const family of offered.filter((tag) => tag !== 'standards' && tag !== 'adjacent')) {
      assert.ok(selectedQuality.split('\n').some((line) => line.startsWith(`- **${family}** —`)), `${kind}: missing ${family} quality bullet`);
    }
  }
});

test('quality selection: plans name searched equivalents and plan review checks them', () => {
  const plan = readFileSync(new URL('plan.md', root), 'utf8').replace(/\r\n/g, '\n');
  assert.match(plan, /- #### \[NEW\] .*\n  - Purpose: .*\n  - Reuse: <existing equivalents searched and why not reused, or none found>\n/);
  const reuseRule = plan.match(/^- Reuse:.*$/m)?.[0];
  assert.ok(reuseRule);
  assert.match(reuseRule, /\bnone found\b/);
  assert.match(reuseRule, /\[quality bar's shared reuse criterion\]\(quality-bar\.md#shared\)/);
  const shared = readFileSync(new URL('quality-bar.md', root), 'utf8').split(/^## shared$/m)[1]!.split(/^## /m)[0]!;
  const maintainability = shared.split('\n').find((line) => line.startsWith('- **maintainability** —'));
  assert.ok(maintainability);
  assert.ok(maintainability.includes('search the repository by name and behaviour for an existing equivalent'));
});

test('quality bar names standard code smells as judgement calls', () => {
  const bar = readFileSync(new URL('quality-bar.md', root), 'utf8').replace(/\r\n/g, '\n');
  const maintainability = qualityBar(bar, 'code').split('\n').find((line) => line.startsWith('- **maintainability** —'));
  assert.ok(maintainability);
  for (const smell of [
    'Duplicated Code', 'Feature Envy', 'Data Clumps', 'Primitive Obsession', 'Shotgun Surgery', 'Divergent Change',
    'Repeated Switches', 'Message Chains', 'Middle Man', 'Speculative Generality', 'Refused Bequest', 'Mysterious Name',
  ]) assert.ok(maintainability.includes(smell), `missing ${smell}`);
  assert.ok(maintainability.includes('Smells (judgement calls, never `MUST` alone)'));
});

test('code review flags unrequested consumer-boundary behaviour as intent', () => {
  const codePrompt = readFileSync(new URL('review-prompt-code.md', root), 'utf8');
  const against = codePrompt.split(/^## against$/m)[1]?.split(/^## /m)[0]?.replace(/\s+/g, ' ');
  assert.ok(against);
  assert.ok(against.includes('Behaviour the diff adds that no REQ asks for at a consumer boundary (public API or CLI surface, outputs, persisted data, side effects, dependencies) is an `intent` finding; internal helpers and refactors are not.'));

  const rules = readFileSync(new URL('../review-rules.md', root), 'utf8');
  assert.ok(rules.includes('For an accepted unrequested-behaviour `intent` finding, the orchestrator removes the behaviour; keeping it changes intent and requires a recorded user quote through the [user gate](decision-frame.md#user-gate-boundaries).'));
});

test('templates: plan template defines the durable bar and isolates transient test files', () => {
  const plan = readFileSync(new URL('plan.md', root), 'utf8').replace(/\s+/g, ' ');
  assert.ok(plan.includes('- Retain: <transient|durable>'));
  for (const text of ['required on every criterion whose Changes names a test path', 'prefer `transient`', 'explicit nonempty `[FINAL]` Verify command', 'even when Covered by names a durable criterion', 'remove declared transient test files', 'required only when Tests names files retained as durable', "[quality bar's code test policy](quality-bar.md#code)", 'each test and its distinct boundary', 'Transient criteria require `Covered by:`', '`[NEW]`', 'x.transient.test.ts', 'plan-id-in-test-name']) assert.ok(plan.includes(text), text);
  assert.equal(plan.match(/\[quality bar's code test policy\]\(quality-bar\.md#code\)/g)?.length, 1);
});

test('plan and design templates contain no retired section headers', () => { for (const name of ['plan.md', 'design.md']) { const text = readFileSync(new URL(name, root), 'utf8'); for (const retired of ['user request', '## User Review Required', '## Context & Intent', '## Goals & Requirements']) assert.ok(!text.includes(retired), name + ': ' + retired); } });

test('quality selection keeps judging rules single-sourced', () => {
  const bar = readFileSync(new URL('quality-bar.md', root), 'utf8').replace(/\r\n/g, '\n');
  const frame = readFileSync(new URL('review-prompt.md', root), 'utf8');
  const codePrompt = readFileSync(new URL('review-prompt-code.md', root), 'utf8');
  assert.deepEqual([...bar.matchAll(/^## (.+)$/gm)].map((match) => match[1]), ['shared', 'spec', 'code', 'plan', 'design']);
  const adjacentRule = 'Report a concrete existing-code defect encountered while inspecting the selected target and interfaces or call sites needed to verify it';
  assert.equal(frame.split(adjacentRule).length - 1, 1);
  assert.doesNotMatch(bar, /Adjacent findings|nearest plan|nearest design/);
  assert.match(codePrompt, /cite code at its real `path:L<line>` locus/);
  assert.doesNotMatch(codePrompt, /concrete defect you meet outside Scope while inspecting|spend no extra turns hunting|domain-valid formulas and algorithms|type-valid, domain-invalid states|pass-through modules; speculative seams/);
  for (const criterion of ['type-valid but domain-invalid states', 'N+1 queries, and unpaginated reads', 'avoid pass-through modules, speculative seams']) assert.ok(!codePrompt.includes(criterion), criterion);
  for (const consumer of ['plan', 'design'] as const) {
    const kindPrompt = readFileSync(new URL(`review-prompt-${consumer}.md`, root), 'utf8');
    assert.match(kindPrompt, /Cite existing code as `path\/to\/file:L<line>` inside `defect`/);
  }
  assert.doesNotMatch(bar, /^- Standards:/m);
  for (const kind of ['plan', 'design']) {
    const prompt = readFileSync(new URL(`review-prompt-${kind}.md`, root), 'utf8');
    assert.doesNotMatch(prompt, /^## quality$/m);
    assert.match(prompt, /Use the selected sections of the \[quality bar\]\(quality-bar\.md\) to judge those targets/);
    const tags = prompt.split('## tags')[1]!.split('## severity')[0]!;
    assert.ok(tags.includes('- `decomposition`'));
    assert.doesNotMatch(tags, /\u2014|findings/);
    for (const line of tags.split('\n').filter((line) => line.startsWith('- '))) assert.match(line.trimEnd(), /^- `[^`]+`$/);
    for (const rule of ['check claimed independence against', 'for each new exported or shared symbol, helper, module, or type, search the repository', 'weigh real alternatives', 'collision-free parallel increments']) assert.ok(!prompt.includes(rule), `${kind}: ${rule}`);
  }
  for (const rule of ['Trace the ask to applicable REQs and DECs', 'search the repository by name and behaviour for an existing equivalent', "A task that consumes another's output without a prerequisite", 'Weigh alternatives and trade-offs']) assert.equal(bar.split(rule).length, 2, rule);
});
