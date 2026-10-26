import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalMarkdown } from '../../../skills/dispatch/scripts/lib/canonical-markdown.ts';

const lines = (...rows: string[]): string => rows.join('\n');

const PLAN = lines(
  '# Plan',
  '',
  '> **Summary:** Hash the canonical form.',
  '',
  'Lead paragraph.',
  '',
  '- bullet',
  '',
  '| Task | Outcome |',
  '| --- | --- |',
  '| T1 | Canonical form |',
  '',
  '1. First item',
  '   - nested *item*',
  '2. Second item',
  '',
  '```ts',
  'const x = 1;',
  '```',
  '',
  '> ```',
  '> quoted',
  '> ```',
  '',
  'Use `code` and *emphasis* here.',
  '',
  'A stray ` tick and more.',
  '',
  '<span>x</span> inline lead',
  '',
  '***',
  '',
  'First line  ',
  'second line',
);

const REWRITE = lines(
  '#   Plan #',
  '',
  '',
  '> __Summary:__   Hash the canonical form.   ',
  '',
  'Lead paragraph.',
  '- bullet',
  '',
  'Task | Outcome',
  '--- | -----',
  'T1 | Canonical form',
  '',
  '1. First item',
  '   - nested _item_',
  '2. Second item  ',
  '',
  '~~~ts',
  'const x = 1;',
  '~~~',
  '',
  '>```',
  '>quoted',
  '>```',
  '',
  'Use `code` and _emphasis_ here.',
  '',
  'A  stray ` tick   and more.',
  '',
  '<span>x</span>   inline lead',
  '',
  '___',
  '',
  'First line\\',
  'second line',
);

const MEANING_CHANGES: Array<[label: string, before: string, after: string]> = [
  ['word', 'Use the plan.', 'Use the plans.'],
  ['intraword underscore', 'snake_case name', 'snake*case name'],
  ['backslash escape', '\\*literal\\*', '*literal*'],
  ['item order', lines('- a', '- b'), lines('- b', '- a')],
  ['paragraph split versus soft break', lines('one', 'two'), lines('one', '', 'two')],
  ['tight versus loose list', lines('- a', '- b'), lines('- a', '', '- b')],
  ['lazy continuation versus paragraph after list', lines('- a', 'b'), lines('- a', '', 'b')],
  ['hard versus soft line break', lines('a  ', 'b'), lines('a', 'b')],
  ['leading indentation', '  para', 'para'],
  ['list marker', '- a', '* a'],
  ['ordered number', lines('1. a', '2. b'), lines('1. a', '3. b')],
  ['ordered delimiter', '1. a', '1) a'],
  ['blank before ordered list starting at 2', lines('Intro', '', '2. a'), lines('Intro', '2. a')],
  ['blank before empty list item', lines('Intro', '', '-'), lines('Intro', '-')],
  ['blank before table', lines('x', '', '| a |', '| - |'), lines('x', '| a |', '| - |')],
  ['blank after table', lines('| a |', '| - |', '| b |', '', 'c'), lines('| a |', '| - |', '| b |', 'c')],
  ['pipeless table row', lines('| a | b |', '| - | - |', 'c'), lines('| a | b |', '| - | - |', '| c |')],
  ['prose versus indented code', lines('para', '', '    code'), lines('para', '', 'code')],
  ['alignment colon', lines('| a |', '| - |'), lines('| a |', '| :- |')],
  ['setext versus ATX heading', lines('Title', '==='), '# Title'],
  ['setext H2 versus paragraph plus thematic break', lines('Title', '---'), lines('Title', '', '---')],
  ['heading level', '# a', '## a'],
  ['fenced byte inside blockquote', lines('> ```', '> a', '> ```'), lines('> ```', '> b', '> ```')],
  ['fenced byte', lines('```', 'a', '```'), lines('```', 'b', '```')],
  ['indented code byte', '    a', '    b'],
  ['inline code byte', '`a`', '`b`'],
  ['link destination', '[x](a)', '[x](b)'],
  ['autolink', '<https://a.example>', '<https://b.example>'],
  ['inline HTML spacing', '<a href="x">y</a>', '<a  href="x">y</a>'],
  ['indented code inside list item', '-     code', '- code'],
  ['multiline code span spacing', lines('`a', 'b  c`'), lines('`a', 'b c`')],
  ['HTML pre block spacing', lines('<pre>', 'a  b', '</pre>'), lines('<pre>', 'a b', '</pre>')],
  ['hard break versus code span content', lines('`a ', 'b`'), lines('`a\\', 'b`')],
  ['HTML block spacing', lines('<div>', 'a  b', '</div>'), lines('<div>', 'a b', '</div>')],
];

test('formatter-only rewrites share one canonical form', () => {
  const canonical = canonicalMarkdown(PLAN);
  assert.equal(canonicalMarkdown(REWRITE), canonical);
  assert.equal(canonicalMarkdown(PLAN.replaceAll('\n', '\r\n')), canonical);
  assert.equal(canonicalMarkdown(REWRITE.replaceAll('\n', '\r\n')), canonical);
});

test('meaning changes alter the canonical form', () => {
  for (const [label, before, after] of MEANING_CHANGES) {
    assert.notEqual(canonicalMarkdown(before), canonicalMarkdown(after), label);
  }
});
