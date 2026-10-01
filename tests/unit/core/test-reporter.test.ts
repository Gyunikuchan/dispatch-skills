import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import quietReporter, { FILE_BUDGET_MS, type ReporterEvent } from '../../../scripts/test-reporter.ts';

const root = path.resolve('/repo');
const file = (rel: string) => path.join(root, rel);

async function report(events: ReporterEvent[]) {
  let code = 0;
  const errors: string[] = [];
  async function* source() { yield* events; }
  let out = '';
  for await (const chunk of quietReporter(source(), { projectRoot: root, exit: (value) => { code = value; }, stderr: { write: (text: string) => errors.push(text) } })) out += chunk;
  return { out, code, errors };
}

const pass = (rel: string, ms: number): ReporterEvent => ({ type: 'test:pass', data: { name: 't', file: file(rel), nesting: 0, details: { duration_ms: ms } } });

test('passing runs print one quiet summary with the slowest files', async () => {
  const { out, code } = await report([pass('tests/unit/core/a.test.ts', 5), pass('tests/unit/core/b.test.ts', 9)]);
  assert.equal(code, 0);
  assert.match(out, /^✔ All 2 test\(s\) passed \(0ms across 2 file\(s\)\)\n/);
  assert.match(out, /Slowest files: tests\/unit\/core\/b\.test\.ts 9ms, tests\/unit\/core\/a\.test\.ts 5ms/);
});

test('failures expand the first and list the rest by location', async () => {
  const fail = (name: string): ReporterEvent => ({
    type: 'test:fail',
    data: { name, file: file('tests/unit/core/a.test.ts'), line: 3, column: 1, nesting: 0, details: { duration_ms: 1, error: { cause: { message: `${name} broke`, stack: `${name} broke\n  at x` } } } },
  });
  const { out, code } = await report([fail('first'), fail('second')]);
  assert.equal(code, 1);
  assert.match(out, /✖ first\n {2}Location: tests\/unit\/core\/a\.test\.ts:3:1\n {2}first broke/);
  assert.match(out, /✖ second\n {2}Location: tests\/unit\/core\/a\.test\.ts:3:1\n\n/);
  assert.doesNotMatch(out, /second broke/);
});

test('a non-e2e file over the per-file budget fails the run with the fix', async () => {
  const { out, code } = await report([pass('tests/unit/core/slow.test.ts', FILE_BUDGET_MS + 1), pass('tests/e2e/flow.test.ts', FILE_BUDGET_MS * 5)]);
  assert.equal(code, 1);
  assert.match(out, /Over the 1\.00s per-file budget: tests\/unit\/core\/slow\.test\.ts; split the file/);
  assert.doesNotMatch(out, /budget: .*flow.test/);
});

test('a file that selects no tests is reported and fails', async () => {
  const { code, errors } = await report([{ type: 'test:summary', data: { file: file('tests/unit/core/empty.test.ts'), counts: { tests: 0 } } }]);
  assert.equal(code, 1);
  assert.deepEqual(errors, ['✖ Selected no tests: tests/unit/core/empty.test.ts\n']);
});
