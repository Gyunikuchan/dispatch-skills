import { qualityBar } from '../../skills/dispatch/scripts/domain/prompt.ts';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parsePlan, selectTaskBrief } from '../../skills/dispatch/scripts/domain/plan.ts';
import { parseDesign } from '../../skills/dispatch/scripts/domain/design.ts';
import { parseSpec } from '../../skills/dispatch/scripts/domain/spec.ts';

const root = new URL('../../skills/dispatch/references/templates/', import.meta.url);
const KEPT = [
  'review-prompt.md', 'review-prompt-code.md', 'review-prompt-design.md', 'review-prompt-plan.md', 'plan.md', 'design.md', 'walkthrough.md', 'spec.md',
  'write-brief.md', 'write-brief-task.md', 'write-brief-hotfix.md', 'writer-brief.md', 'quality-bar.md',
  'schemas/report-code.json', 'schemas/report-design.json', 'schemas/report-plan.json',
];

test('design template parses under layered lint and preserves executable fields and exclusions', () => {
  const template = readFileSync(new URL('design.md', root), 'utf8').replace(/\r\n/g, '\n');
  assert.equal((template.match(/^> \*\*.*$/gm) ?? []).length, 5);
  assert.equal((template.match(/^>$/gm) ?? []).length, 4);
  const order = ['> **TL;DR:**', '## Execution Status', '## Approach', '## Alternatives & Decisions', '## Risks, Security & Operations', '## Architecture & Boundaries', '## Increment Dependency Graph', '## Increment Details', '## Final Integration', '## Review Findings & Resolutions'];
  for (let i = 1; i < order.length; i++) assert.ok(template.indexOf(order[i]!) > template.indexOf(order[i - 1]!), order[i]);
  let source = template.split('````markdown\n')[1]!.split('````')[0]!;
  source = source.replace('<`<spec path>` · sha256:<hex>>', '`governing.spec.md` · sha256:' + 'a'.repeat(64))
    .replace('<low|med|high>', 'low').replace('<count>', '1')
    .replace(/\| I02 .*\n/, '').replace(/Next Action: .*\n/, 'Next Action: complete\n');
  source = source.replace('REQ-<n>', 'REQ-1').replace(/<[^>]+>/g, 'Concrete behavior');
  const parsed = parseDesign(source);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.equal(parsed.design.increments[0]!.id, 'I01');
  assert.equal(parsed.design.details['I01']!['Outcome'], 'Concrete behavior');
  assert.ok(!parsed.design.governedText.includes('## Execution Status'));
  assert.ok(!parsed.design.governedText.includes('## Review Findings & Resolutions'));
});

test('readable artifact templates: walkthrough hierarchy and ownership match renderer contracts', () => {
  const template = readFileSync(new URL('walkthrough.md', root), 'utf8').replace(/\r\n/g, '\n');
  assert.equal((template.match(/^> \*\*.*$/gm) ?? []).length, 4);
  assert.equal((template.match(/^>$/gm) ?? []).length, 3);
  assert.match(template, /- #### \[MODIFY\].*\n  - Changes:/);
  assert.match(template, /\| SC \| Outcome \| Evidence \|/);
  assert.match(template, /Final gate:/);
  assert.match(template, /\[review rules\]\(\.\.\/review-rules.md\)/);
});

test('plan template parses under layered lint and preserves executable contracts', () => {
  const template = readFileSync(new URL('plan.md', root), 'utf8');
  const order = ['> **TL;DR:**', '## Background', '## Key Decisions & Context', '## Open Questions & Assumptions', '## Out of Scope', '## Task Map', '## Technical-Design Traceability', '## Proposed Changes', '## Success Criteria', '## Verification Plan', '## Rollback & Blast Radius', '## Review Findings & Resolutions'];
  for (let i = 1; i < order.length; i++) assert.ok(template.indexOf(order[i]!) > template.indexOf(order[i - 1]!));
  assert.equal((template.match(/^> \*\*.*$/gm) ?? []).length, 5);
  assert.equal((template.match(/^>$/gm) ?? []).length, 4);
  assert.match(template, /- #### \[MODIFY\].*\n  - Changes:.*\n  - Invariants:/);
  for (const label of ['Omit optional empty prose sections', 'conditional fields', 'Pre-existing:', 'RED exception:', 'Enforcement infeasibility:', 'Integration:', 'Overlap:', 'Retain:', 'Covered by:', 'Seams:']) assert.ok(template.includes(label));
  let source = template.split('````markdown\n')[1]!.split('````')[0]!;
  source = source.replace(/## Background[\s\S]*?(?=## Task Map)/, '## Key Decisions & Context\n- Keep API (user)\n\n');
  source = source.replace(/## Success Criteria[\s\S]*?(?=## Verification Plan)/, '## Success Criteria\n- [SC1] Output stays usable\n  - Satisfies: REQ-1\n  - Changes: src/new.ts, src/edit.ts, src/delete.ts, src/generated.ts\n  - Verify: `npm test` [FINAL]\n  - Evidence: verify\n  - Test rationale: Checks the output.\n\n');
  source = source.replace(/## Verification Plan[\s\S]*?(?=## Review Findings)/, '## Verification Plan\n### Automated Tests\n- `npm run lint`\n\n');
  const replacements: Record<string, string> = { '<Goal Description>': 'Check output', '<problem and outcome>': 'Keep output usable', '<`<design path>` · I<nn> | `<spec path>` · sha256:<hex>>': '`governing.spec.md` · sha256:' + 'a'.repeat(64), '<reader decision, or none>': 'none', '<low|med|high>': 'low', '<reason>': 'isolated change', '<paths or components>': 'src', 'T<n>': 'T1', '<Task title>': 'Keep output usable', '<Plain-language outcome>': 'Keep output usable.', '<optional task-specific constraints, including why each non-obvious prerequisite is needed>': 'Keep API.', 'SC<n>[, SC<n>...]': 'SC1', '<file-specific exception>': 'keep deprecated flag', '<generator command>': 'npm run generate', '<path> — <why this unordered task also writes the path>': 'src/edit.ts — shares the edit with an unordered task' };
  for (const [key, value] of Object.entries(replacements)) source = source.replaceAll(key, value);
  const paths = ['src/new.ts', 'src/edit.ts', 'src/delete.ts', 'src/generated.ts'];
  for (const file of paths) source = source.replace('<relative-path>', file);
  source = source.replace('<relative-path>[, <relative-path>...]', 'src/edit.ts');
  const result = parsePlan(source); assert.ok(result.ok, JSON.stringify(result));
  const brief = selectTaskBrief(result.plan, 'T1')!;
  assert.equal(brief.task.summary, 'Keep output usable.');
  assert.deepEqual(brief.task.constraints, ['Keep API.']);
  assert.match(brief.changes[1]!.note, /Invariants:.*exception: keep deprecated flag/);
  assert.deepEqual(brief.task.generated, [{ path: 'src/generated.ts', inputs: ['src/edit.ts'] }]);
});

test('templates: spec template skeleton lints at low and medium', () => {
  const template = readFileSync(new URL('spec.md', root), 'utf8').replace(/\r\n/g, '\n');
  const source = template.split('````markdown\n')[1]!.split('````')[0]!
    .replace('### REQ-<n> — <title>', '### REQ-1 — Concrete title').replace('### DEC-<n> — <title>', '### DEC-1 — Concrete title');
  for (const level of ['low', 'medium'] as const) {
    const result = parseSpec(source, { level });
    assert.ok(result.ok, `${level}: ${JSON.stringify(result)}`);
  }
});

test('templates: every kept template exists and none are extra', () => {
  const files = [...readdirSync(root).filter((name) => name !== 'schemas'), ...readdirSync(new URL('schemas/', root)).map((name) => `schemas/${name}`)];
  assert.deepEqual(files.sort(), [...KEPT].sort());
});

test('templates: no kept template contains <!--, rebuttal, or consensus', () => {
  for (const name of KEPT) {
    const text = readFileSync(new URL(name, root), 'utf8');
    for (const token of [/<!--/, /rebuttal/i, /consensus/i]) assert.ok(!token.test(text), `${name} contains ${String(token)}`);
  }
});

test('templates: task brief requires an isolated worktree and a pre-production RED checkpoint', () => {
  const brief = readFileSync(new URL('write-brief-task.md', root), 'utf8');
  for (const text of ['## purpose', '## kind-rules', '<Checkpoint Command>', 'admissionDefects']) assert.ok(brief.includes(text), text);
  assert.match(brief, /only inside the worktree/);
  assert.match(brief, /before any production edit/);
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
  const { REVIEW_TAGS } = await import('../../skills/dispatch/scripts/domain/report.ts');
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
  const enumOf = (node: unknown): string[] | null => {
    if (!node || typeof node !== 'object') return null;
    const record = node as Record<string, unknown>;
    const tag = record['tag'] as Record<string, unknown> | undefined;
    if (tag && Array.isArray(tag['enum'])) return tag['enum'] as string[];
    for (const value of Object.values(record)) { const found = enumOf(value); if (found) return found; }
    return null;
  };
  for (const kind of ['code', 'plan', 'design'] as const) {
    const block = readFileSync(new URL(`review-prompt-${kind}.md`, root), 'utf8').split(/^## tags$/m)[1]!.split(/^## /m)[0]!;
    const offered = [...block.matchAll(/^- `([^`]+)`$/gm)].map((tag) => tag[1]!);
    assert.deepEqual(sorted(offered), sorted(expectedByKind[kind]), `${kind} prompt families`);
    const selectedQuality = qualityBar(quality, kind);
    for (const family of offered.filter((tag) => tag !== 'standards' && tag !== 'adjacent')) {
      assert.ok(selectedQuality.split('\n').some((line) => line.startsWith(`- **${family}** —`)), `${kind}: missing ${family} quality bullet`);
    }
  }
  for (const kind of ['code', 'plan'] as const) {
    const schema = enumOf(JSON.parse(readFileSync(new URL(`schemas/report-${kind}.json`, root), 'utf8')));
    assert.ok(schema, `${kind} schema tag enum`);
    assert.deepEqual(sorted(schema), sorted(families), `${kind} schema families`);
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

test('templates: task brief cleanup applies the quality bar without a new step', () => {
  const brief = readFileSync(new URL('write-brief-task.md', root), 'utf8');
  assert.match(brief, /^- After GREEN, inspect the task's changes against the injected quality bar\./m);
  assert.equal((brief.match(/^- After GREEN/gm) ?? []).length, 1);
  const quality = readFileSync(new URL('quality-bar.md', root), 'utf8').replace(/\s+/g, ' ');
  assert.ok(quality.includes('avoid pass-through modules, speculative seams (one adapter is hypothetical), excess coupling'));
});

test('templates: plan template defines the durable bar and isolates transient test files', () => {
  const plan = readFileSync(new URL('plan.md', root), 'utf8').replace(/\s+/g, ' ');
  assert.ok(plan.includes('- Retain: <transient|durable>'));
  for (const text of ['required on every criterion whose Changes names a test path', 'prefer `transient`', 'required only when Tests names files retained as durable', "[quality bar's code test policy](quality-bar.md#code)", 'each test and its distinct boundary', 'are trimmed after final review', 'test files listed solely by transient criteria are trimmed', '`[NEW]`', 'x.transient.test.ts', 'plan-id-in-test-name']) assert.ok(plan.includes(text), text);
  assert.equal(plan.match(/\[quality bar's code test policy\]\(quality-bar\.md#code\)/g)?.length, 1);
});

test('templates: task brief applies the durable bar and isolates transient tests', () => {
  const brief = readFileSync(new URL('write-brief-task.md', root), 'utf8').replace(/\s+/g, ' ');
  for (const text of ['only in their transient files', "the bar's test criteria", 'under concerns', 'never change `Retain:`']) assert.ok(brief.includes(text), text);
  assert.ok(readFileSync(new URL('quality-bar.md', root), 'utf8').includes("code section's test policy"));
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
