import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parsePlan, selectTaskBrief } from '../../skills/dispatch/scripts/domain/plan.ts';
import { parseDesign } from '../../skills/dispatch/scripts/domain/design.ts';

const root = new URL('../../skills/dispatch/references/templates/', import.meta.url);
const KEPT = [
  'review-prompt.md', 'review-prompt-code.md', 'review-prompt-design.md', 'review-prompt-plan.md', 'plan.md', 'design.md', 'walkthrough.md',
  'write-brief.md', 'write-brief-task.md', 'write-brief-hotfix.md',
  'schemas/report-code.json', 'schemas/report-design.json', 'schemas/report-plan.json',
];

test('readable artifact templates: populated design preserves executable fields and exclusions', () => {
  const template = readFileSync(new URL('design.md', root), 'utf8').replace(/\r\n/g, '\n');
  assert.equal((template.match(/^> \*\*.*$/gm) ?? []).length, 5);
  assert.equal((template.match(/^>$/gm) ?? []).length, 4);
  const order = ['> **TL;DR:**', '## Execution Status', '## Context & Intent', '## Goals & Requirements', '## Alternatives & Decisions', '## Risks, Security & Operations', '## Architecture & Boundaries', '## Increment Dependency Graph', '## Increment Details', '## Final Integration', '## Review Findings & Resolutions'];
  for (let i = 1; i < order.length; i++) assert.ok(template.indexOf(order[i]!) > template.indexOf(order[i - 1]!), order[i]);
  let source = template.split('````markdown\n')[1]!.split('````')[0]!;
  source = source.replace('<`<spec path>` · sha256:<hex> | user request>', 'user request')
    .replace('<low|med|high>', 'low').replace('<count>', '1')
    .replace(/\| I02 .*\n/, '').replace(/Next Action: .*\n/, 'Next Action: complete\n');
  source = source.replace(/<[^>]+>/g, 'Concrete behavior');
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

test('readable plan template: hierarchy, quote paragraphs and conditional contracts stay executable', () => {
  const template = readFileSync(new URL('plan.md', root), 'utf8');
  const order = ['> **TL;DR:**', '## User Review Required', '## Background', '## Key Decisions & Context', '## Open Questions & Assumptions', '## Out of Scope', '## Task Map', '## Technical-Design Traceability', '## Proposed Changes', '## Success Criteria', '## Verification Plan', '## Rollback & Blast Radius', '## Review Findings & Resolutions'];
  for (let i = 1; i < order.length; i++) assert.ok(template.indexOf(order[i]!) > template.indexOf(order[i - 1]!));
  assert.equal((template.match(/^> \*\*.*$/gm) ?? []).length, 5);
  assert.equal((template.match(/^>$/gm) ?? []).length, 4);
  assert.match(template, /- #### \[MODIFY\].*\n  - Changes:.*\n  - Invariants:/);
  for (const label of ['Omit optional empty prose sections', 'conditional fields', 'Pre-existing:', 'RED exception:', 'Enforcement infeasibility:', 'Integration:', 'Overlap:', 'Retain:', 'Covered by:', 'Seams:']) assert.ok(template.includes(label));
  let source = template.split('````markdown\n')[1]!.split('````')[0]!;
  source = source.replace(/## Background[\s\S]*?(?=## Proposed Changes)/, '## Key Decisions & Context\n- Keep API (user)\n\n');
  source = source.replace(/## Success Criteria[\s\S]*?(?=## Verification Plan)/, '## Success Criteria\n- [SC1] Output stays usable\n  - Changes: src/new.ts, src/edit.ts, src/delete.ts, src/generated.ts\n  - Verify: `npm test` [FINAL]\n  - Evidence: verify\n  - Test rationale: Checks the output.\n\n');
  source = source.replace(/## Verification Plan[\s\S]*?(?=## Review Findings)/, '## Verification Plan\n### Automated Tests\n- `npm run lint`\n\n');
  const replacements: Record<string, string> = { '<Goal Description>': 'Check output', '<problem and outcome>': 'Keep output usable', '<`<design path>` · I<nn> | `<spec path>` · sha256:<hex> | user request>': 'user request', '<reader decision, or none>': 'none', '<low|med|high>': 'low', '<reason>': 'isolated change', '<paths or components>': 'src', 'T<n>': 'T1', '<Task outcome>': 'Keep output usable', '<Plain-language outcome and rationale; why each non-obvious prerequisite is needed.>': 'Keep output usable.', '<optional shared task constraints>': 'Keep API.', '<none | T<n>[, T<n>...]>': 'none', '<SC#[, SC#...]>': 'SC1', '<file-specific exception>': 'keep deprecated flag', '<generator command>': 'npm run generate', '<path> — <why this unordered task also writes the path>': 'src/edit.ts — shares the edit with an unordered task' };
  // Replace composite placeholders before their embedded task-ID token.
  source = source.replace('<none | T<n>[, T<n>...]>', 'none');
  for (const [key, value] of Object.entries(replacements)) source = source.replaceAll(key, value);
  const paths = ['src/new.ts', 'src/edit.ts', 'src/delete.ts', 'src/generated.ts'];
  for (const file of paths) source = source.replace('<relative-path>', file);
  source = source.replace('<relative-path>[, <relative-path>...]', 'src/edit.ts');
  const result = parsePlan(source); assert.ok(result.ok, JSON.stringify(result));
  const brief = selectTaskBrief(result.plan, 'T1')!;
  assert.equal(brief.task.summary, 'Keep output usable. Constraints: Keep API.');
  assert.match(brief.changes[1]!.note, /Invariants:.*exception: keep deprecated flag/);
  assert.deepEqual(brief.task.generated, [{ path: 'src/generated.ts', inputs: ['src/edit.ts'] }]);
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

test('templates: plan.md groups changes under tasks with prerequisites, criteria, and generated inputs', () => {
  const plan = readFileSync(new URL('plan.md', root), 'utf8');
  for (const line of ['### T<n> — <Task outcome>', '- Prerequisites: <none | T<n>[, T<n>...]>', '- Criteria: <SC#[, SC#...]>', '- Inputs: <relative-path>[, <relative-path>...]', '  - Integration: <why this criterion spans tasks>']) {
    assert.ok(plan.includes(line), line);
  }
  assert.ok(!plan.includes('<Component Name>'));
});

test('templates: plan review prompt requires inspecting task dependencies, ownership, and independence', () => {
  const prompt = readFileSync(new URL('review-prompt-plan.md', root), 'utf8');
  assert.match(prompt, /claimed independence checked against\s+producer\/consumer interfaces/);
  assert.match(prompt, /`dependency-graph`, `parallel-safety`/);
});

test('templates: every tag a review prompt offers is accepted by the validator and its schema', async () => {
  const { REVIEW_TAGS } = await import('../../skills/dispatch/scripts/domain/report.ts');
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
    const offered = [...block.matchAll(/^- [^:\n]+: (.*?) —/gm)].flatMap((line) => [...line[1]!.matchAll(/`([^`]+)`/g)].map((tag) => tag[1]!));
    assert.ok(offered.length, `${kind} prompt lists tags`);
    const schema = enumOf(JSON.parse(readFileSync(new URL(`schemas/report-${kind}.json`, root), 'utf8')));
    for (const tag of offered) {
      assert.ok(REVIEW_TAGS[kind].has(tag), `${kind} validator rejects prompt tag ${tag}`);
      if (schema) assert.ok(schema.includes(tag), `${kind} schema rejects prompt tag ${tag}`);
    }
  }
});

test('templates: plans name searched equivalents and plan review checks them', () => {
  const plan = readFileSync(new URL('plan.md', root), 'utf8').replace(/\r\n/g, '\n');
  assert.match(plan, /- #### \[NEW\] .*\n  - Purpose: .*\n  - Reuse: <existing equivalents searched and why not reused, or none found>\n/);
  assert.match(plan, /^- Reuse: on `\[NEW\]` entries and on `\[MODIFY\]` entries that add a helper, module, or type;/m);
  const prompt = readFileSync(new URL('review-prompt-plan.md', root), 'utf8').replace(/\s+/g, ' ');
  assert.ok(prompt.includes('each new helper, module, or type names the equivalents searched or `none found`; verify the claim by search'));
});

test('templates: task brief cleanup covers existing-code duplicates without a new step', () => {
  const brief = readFileSync(new URL('write-brief-task.md', root), 'utf8');
  assert.match(brief, /^- After GREEN, inspect the task's changes for duplication, including new helpers that duplicate existing repository code, unclear naming/m);
  assert.equal((brief.match(/^- After GREEN/gm) ?? []).length, 1);
});

test('templates: plan template defines the durable bar and isolates transient test files', () => {
  const plan = readFileSync(new URL('plan.md', root), 'utf8').replace(/\s+/g, ' ');
  assert.ok(plan.includes('- Retain: <transient|durable>'));
  for (const text of ['required on every criterion whose Changes names a test path', 'prefer `transient`', 'lasting contract', 'observable outcome', 'regression', 'no other retained test', '`[NEW]`', 'x.transient.test.ts', 'plan-id-in-test-name']) assert.ok(plan.includes(text), text);
  assert.equal(plan.match(/durable bar:/g)?.length, 1);
});

test('templates: task brief applies the durable bar and isolates transient tests', () => {
  const brief = readFileSync(new URL('write-brief-task.md', root), 'utf8').replace(/\s+/g, ' ');
  for (const text of ['only in their transient files', 'the durable bar in the plan template', 'under concerns', 'never change `Retain:`']) assert.ok(brief.includes(text), text);
});
