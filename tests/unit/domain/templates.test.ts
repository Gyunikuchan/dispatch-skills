import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../../skills/dispatch/references/templates/', import.meta.url);
const KEPT = [
  'review-prompt.md', 'review-prompt-code.md', 'review-prompt-design.md', 'review-prompt-plan.md', 'plan.md', 'design.md', 'walkthrough.md',
  'write-brief.md', 'write-brief-tests-only.md', 'write-brief-production.md', 'write-brief-hotfix.md',
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

test('templates: plan.md shows [FINAL] after the Verify code span', () => {
  const plan = readFileSync(new URL('plan.md', root), 'utf8');
  assert.ok(plan.includes('- Verify: `<command>` [FINAL]'));
  assert.ok(!/Verify: `[^`\n]*\[FINAL\]`/.test(plan));
});
