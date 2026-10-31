import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lintContextMap } from '../../../../skills/dispatch/scripts/toolkit/domain/context.ts';

const MAP = [
  '# Context map: parser',
  '',
  '> **Commit:** abcdef0',
  '>',
  '> **Tool:** code-index',
  '',
  '## Map',
  '- Parser — `src/parser.ts:1-2`',
  '',
  '## Flows',
  '- parse: `src/parser.ts:1` → `src/entry.ts:1`',
  '',
  '## Invariants',
  '- Parser keeps the flag — `src/parser.ts:1` — "export const enabled = true;"',
  '',
  '## Coverage',
  '- entry-points: `src/entry.ts:1`',
  '',
  '## Precedent',
  '- Parser helper: `src/parser.ts`',
  '',
  '## Surprises',
  '- The entry is direct — `src/entry.ts:1`',
  '',
  '## Not covered',
  '- Dynamic dispatch',
  '',
].join('\n');

const repoFiles = new Map([
  ['src/parser.ts', 'export const enabled = true;\nexport function parse() {}\n'],
  ['src/entry.ts', 'export function main() {}\n'],
]);
const lint = (source: string) => lintContextMap(source, { readRepoFile: ref => repoFiles.get(ref) ?? null });

test('context lint reports bad refs quotes and size', () => {
  const invalid = MAP
    .replace('`src/parser.ts:1-2`', '`missing.ts:1`')
    .replace('`src/entry.ts:1`', '`src/entry.ts:2`')
    .replace('- Parser helper: `src/parser.ts`', '- Parser helper: `../outside.ts:1`')
    .replace('- The entry is direct — `src/entry.ts:1`', '- The entry is direct — `C:/outside.ts:1`')
    .replace('"export const enabled = true;"', '"export const enabled = false;"');
  const result = lint(invalid);
  assert.equal(result.ok, false);
  assert.ok(result.defects.some(issue => issue.code === 'context-ref-missing'));
  assert.ok(result.defects.some(issue => issue.code === 'context-ref-range'));
  assert.ok(result.defects.some(issue => issue.code === 'context-ref-unsafe'));
  assert.ok(result.defects.some(issue => issue.code === 'context-quote-mismatch'));

  const incomplete = lint('# Context map: partial\n\n## Map\n- Parser\n\n## Invariants\n- It is stable — `src/parser.ts:1`\n\n## Coverage\n- callers: no ref\n\n## Precedent\n- parser helper\n');
  assert.ok(incomplete.warnings.some(issue => issue.code === 'context-missing-ref'));
  assert.ok(incomplete.warnings.some(issue => issue.code === 'context-quote-missing'));
  assert.ok(incomplete.warnings.some(issue => issue.code === 'context-missing-section'));

  const softLimit = lint(MAP + 'x'.repeat(16_385));
  assert.ok(softLimit.warnings.some(issue => issue.code === 'context-size-warning'));
  assert.equal(softLimit.defects.length, 0);

  const hardLimit = lint(MAP + 'x'.repeat(32_769));
  assert.ok(hardLimit.defects.some(issue => issue.code === 'context-size'));
});

test('context lint checks conventions refs and treats the section as optional', () => {
  const withoutConventions = lint(MAP);
  assert.equal(withoutConventions.ok, true);
  assert.deepEqual(withoutConventions.defects, []);
  assert.deepEqual(withoutConventions.warnings, []);

  const withConventions = MAP.replace('## Surprises', [
    '## Conventions',
    '- reuse: parser helper — `src/parser.ts:1-2`',
    '- style: function exports — `src/entry.ts:1`',
    '- parallel: parser predicate — `src/parser.ts:1-2`',
    '',
    '## Surprises',
  ].join('\n'));
  const valid = lint(withConventions);
  assert.equal(valid.ok, true, JSON.stringify(valid.defects));
  assert.deepEqual(valid.defects, []);
  assert.deepEqual(valid.warnings, []);

  const invalid = lint(withConventions
    .replace('- reuse: parser helper — `src/parser.ts:1-2`', '- reuse: parser helper — `src/parser.ts:2-3`')
    .replace('- style: function exports — `src/entry.ts:1`', '- style: function exports'));
  assert.ok(invalid.defects.some(issue => issue.code === 'context-ref-range' && issue.message.includes('src/parser.ts')));
  assert.ok(invalid.warnings.some(issue => issue.code === 'context-missing-ref' && issue.message.includes('Conventions')));
});

test('context lint rejects the strategy header as an unsupported field', () => {
  const withStrategy = MAP.replace('> **Tool:** code-index', '> **Strategy:** single\n>\n> **Tool:** code-index');
  const result = lint(withStrategy);
  assert.equal(result.ok, false);
  assert.ok(result.defects.some(issue => issue.code === 'context-strategy'));
});
