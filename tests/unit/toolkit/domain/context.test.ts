import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lintContextMap, mergeContextMaps, parseContextMap } from '../../../../skills/dispatch/scripts/toolkit/domain/context.ts';

const MAP = [
  '# Context map: parser',
  '',
  '> **Commit:** abc123',
  '>',
  '> **Strategy:** single',
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


test('context lint passes a valid map', () => {
  const result = lint(MAP);
  assert.equal(result.ok, true);
  assert.deepEqual(result.defects, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.map.strategy, 'single');
  assert.equal(result.map.sections.Map[0], '- Parser — `src/parser.ts:1-2`');
});
test('context merge unions entries and tags disputes', () => {
  const mapSource = (strategy: string, sections: Record<string, string[]>) => [
    '# Context map: parser', '', '> **Commit:** abc123', '>', `> **Strategy:** ${strategy}`, '>', '> **Tool:** code-index', '',
    ...['Map', 'Flows', 'Invariants', 'Coverage', 'Precedent', 'Surprises', 'Not covered'].flatMap(section => [`## ${section}`, ...(sections[section] ?? []), '']),
  ].join('\n');
  const leftSource = mapSource('outside-in', {
    Map: [
      '- Component — `src/shared.ts:1`',
      '- Parser left — `src/left.ts:1`',
      '- Test fixture — `tests/left.test.ts:1`',
      '- Doc fixture — `docs/right.md:1`',
    ],
    Flows: ['- parse: `src/shared.ts:1` → `src/left.ts:1`'],
    Invariants: ['- Shared is ready — `src/shared.ts:1` — "export const ready = true;"'],
    Coverage: [
      '- tests: `tests/left.test.ts:1`',
      '- docs: not covered — docs are not traced',
    ],
    Precedent: ['- Parser analogue: `src/shared.ts`'],
    Surprises: ['- No assumptions failed — `src/shared.ts:1`'],
    'Not covered': ['- Dynamic dispatch'],
  });
  const rightSource = mapSource('inside-out', {
    Map: [
      '-  Component   — `src/shared.ts:1`',
      '- Parser right — `src/right.ts:1`',
      '- Test fixture — `tests/left.test.ts:1`',
      '- Doc fixture — `docs/right.md:1`',
    ],
    Flows: ['- parse: `src/shared.ts:1` → `src/right.ts:1`'],
    Invariants: ['- Shared is exported — `src/shared.ts:1` — "export const ready = true;"'],
    Coverage: [
      '- tests: not covered — tests are not traced',
      '- docs: `docs/right.md:1`',
    ],
    Precedent: ['- Parser analogue: `src/shared.ts`'],
    Surprises: ['- No assumptions failed — `src/shared.ts:1`'],
    'Not covered': ['- Plugin keys'],
  });
  const left = parseContextMap(leftSource);
  const right = parseContextMap(rightSource);
  const merged = mergeContextMaps(left, right);
  const parsed = parseContextMap(merged.source);
  assert.equal(parsed.strategy, 'merged');
  assert.equal(merged.disputed, 6);
  assert.equal(parsed.sections.Map.filter(line => line.includes('Component')).length, 1);
  assert.ok(parsed.sections.Map.includes('- [disputed] Parser left — `src/left.ts:1`'));
  assert.ok(parsed.sections.Map.includes('- [disputed] Parser right — `src/right.ts:1`'));
  assert.equal(parsed.sections.Flows.filter(line => line.includes('src/shared.ts:1')).length, 2);
  assert.ok(parsed.sections.Flows.every(line => line.startsWith('- [disputed]')));
  assert.equal(parsed.sections.Invariants.filter(line => line.includes('src/shared.ts:1')).length, 2);
  assert.ok(parsed.sections.Coverage.includes('- [disputed] tests: `tests/left.test.ts:1`'));
  assert.ok(parsed.sections.Coverage.includes('- [disputed] docs: `docs/right.md:1`'));
  assert.equal(mergeContextMaps(right, left).source, merged.source);

  const repo = new Map([
    ['src/shared.ts', 'export const ready = true;'],
    ['src/left.ts', 'export const left = true;'],
    ['src/right.ts', 'export const right = true;'],
    ['tests/left.test.ts', "test('left');"],
    ['docs/right.md', 'Right documentation.'],
  ]);
  const checked = lintContextMap(merged.source, { readRepoFile: ref => repo.get(ref) ?? null });
  assert.equal(checked.ok, true, JSON.stringify(checked.defects));
  assert.deepEqual(checked.warnings, []);
});
