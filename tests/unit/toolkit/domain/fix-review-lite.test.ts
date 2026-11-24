import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addedCitations, consumerSearchArgs, consumerSearchText } from '../../../../skills/dispatch/scripts/toolkit/domain/fix-review-lite.ts';

const added = (...lines: string[]) => ['--- a/work.plan.md', '+++ b/work.plan.md', '@@ -1 +1,9 @@', ...lines.map(line => '+' + line)].join('\n');

test('fix-review-lite citation grammar resolves spans, continuations and added lines', () => {
  const cases: [string, string, ReturnType<typeof addedCitations>][] = [
    ['single line', '`skills/a.ts:12`', [{path: 'skills/a.ts', start: 12, end: 12}]],
    ['line range', '`skills/a.ts:12-30`', [{path: 'skills/a.ts', start: 12, end: 30}]],
    ['L-prefixed line', '`skills/a.ts:L12`', [{path: 'skills/a.ts', start: 12, end: 12}]],
    ['L-prefixed range', '`skills/a.ts:L12-L30`', [{path: 'skills/a.ts', start: 12, end: 30}]],
    ['whole file', '`skills/a.md`', [{path: 'skills/a.md', start: null, end: null}]],
    ['root-level AGENTS.md', '`AGENTS.md`', [{path: 'AGENTS.md', start: null, end: null}]],
    ['root-level package.json', '`package.json`', [{path: 'package.json', start: null, end: null}]],
    ['dot-leading file', '`.env:3`', [{path: '.env', start: 3, end: 3}]],
    ['span with a space is not a path', '`npm test`', []],
    ['span without an extension is not a whole-file path', '`node`', []],
  ];
  for (const [name, span, expected] of cases) {
    assert.deepEqual(addedCitations(added('Read ' + span + ' first.')), expected, name);
  }

  // A continuation reuses the last path cited on the same added line.
  assert.deepEqual(addedCitations(added('See `skills/a.ts:12` and `:541-544`.')), [
    {path: 'skills/a.ts', start: 12, end: 12},
    {path: 'skills/a.ts', start: 541, end: 544},
  ]);
  assert.deepEqual(addedCitations(added('Whole `docs/b.md` then `:L541`.')), [
    {path: 'docs/b.md', start: null, end: null},
    {path: 'docs/b.md', start: 541, end: 541},
  ]);

  // A continuation with no earlier path on its line is dropped.
  assert.deepEqual(addedCitations(added('Only `:541-544` here.')), []);

  // Removed, context and +++ lines are ignored.
  const text = [
    '--- a/work.plan.md', '+++ b/work.plan.md', '@@ -1,3 +1,3 @@',
    ' context `src/context.ts:1`',
    '-removed `src/removed.ts:2`',
    '+added `src/added.ts:3`',
    '+++ header-like `src/header.ts:4`',
  ].join('\n');
  assert.deepEqual(addedCitations(text), [{path: 'src/added.ts', start: 3, end: 3}]);
});

test('fix-review-lite consumer search builds excludes, globs and display text', () => {
  // A leading-dash name takes -e with no -w and no exclude.
  const dashArgs = consumerSearchArgs([], '-x');
  assert.deepEqual(dashArgs, ['grep', '-n', '-I', '-F', '--untracked', '-e', '-x', '--', '.']);
  assert.ok(!dashArgs.some(arg => arg.includes('exclude')));

  // -w applies only when the name starts and ends with a word character.
  assert.deepEqual(consumerSearchArgs([], 'a.b[1].txt'), ['grep', '-n', '-I', '-F', '--untracked', '-w', '-e', 'a.b[1].txt', '--', '.']);
  assert.deepEqual(consumerSearchArgs([], 'foo('), ['grep', '-n', '-I', '-F', '--untracked', '-e', 'foo(', '--', '.']);

  // A safe path renders as a literal exclude and an unsafe path as a glob.
  assert.deepEqual(consumerSearchArgs(['.scratch/dispatch-skills', '.env', 'ops/my secrets.env'], 'foo'), [
    'grep', '-n', '-I', '-F', '--untracked', '-w', '-e', 'foo', '--', '.',
    ':(exclude,literal).scratch/dispatch-skills', ':(exclude,literal).env', ':(exclude,glob)ops/my?secrets.env',
  ]);

  // Display text renders one ? per UTF-8 byte of an unsafe path, so no quote or metacharacter survives.
  assert.equal(
    consumerSearchText(['.scratch/dispatch-skills', '.env', 'ops/my secrets.env', 'café/a"$(x).env']),
    'git grep -n -I -F --untracked -e <name> -- . ":(exclude,literal).scratch/dispatch-skills" ":(exclude,literal).env" '
      + '":(exclude,glob)ops/my?secrets.env" ":(exclude,glob)caf??/a???x?.env"',
  );
  assert.equal(consumerSearchText([]), 'git grep -n -I -F --untracked -e <name> -- .');
});
