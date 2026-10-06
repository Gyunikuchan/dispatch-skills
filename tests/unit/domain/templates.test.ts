import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../../skills/dispatch/references/templates/', import.meta.url);
const KEPT = [
  'review-prompt.md', 'review-prompt-code.md', 'review-prompt-design.md', 'review-prompt-plan.md', 'plan.md', 'design.md', 'walkthrough.md',
  'write-brief.md', 'write-brief-task.md', 'write-brief-hotfix.md',
  'schemas/report-code.json', 'schemas/report-design.json', 'schemas/report-plan.json',
];

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
  const { REVIEW_TAGS } = await import('../../../skills/dispatch/scripts/domain/report.ts');
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
