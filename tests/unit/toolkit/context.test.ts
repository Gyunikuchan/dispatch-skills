import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { sessionFixture } from './helpers/session.ts';

test('context merge writes the merged map and refuses commit mismatch', async () => {
  const f = sessionFixture({memory: true});
  try {
    fs.mkdirSync(path.join(f.root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'src', 'merge.ts'), 'export const ready = true;\n');
    const map = (commit: string, claim: string) => [
      '# Context map: merge', '', `> **Commit:** ${commit}`, '>', '> **Strategy:** single', '>', '> **Tool:** text', '',
      '## Map', `- ${claim} — ` + '`src/merge.ts:1`', '',
      '## Flows', '- parse: `src/merge.ts:1`', '',
      '## Invariants', '- Merge keeps the flag — `src/merge.ts:1` — "export const ready = true;"', '',
      '## Coverage', '- entry-points: `src/merge.ts:1`', '- callers: not covered — caller scan is incomplete', '',
      '## Precedent', '- Parser: `src/merge.ts`', '',
      '## Surprises', '- None — `src/merge.ts:1`', '',
      '## Not covered', '- Dynamic dispatch', '',
    ].join('\n');
    const a = f.artifact('a.context.md', map('abc123', 'First claim'));
    const b = f.artifact('b.context.md', map('abc123', 'Second claim'));
    const invalid = f.artifact('invalid.context.md', map('abc123', 'Invalid claim').replaceAll('src/merge.ts', 'src/missing.ts'));
    const mismatch = f.artifact('mismatch.context.md', map('def456', 'Other commit'));
    const missing = path.join(f.root, 'missing.context.md');
    const out = path.join(f.root, 'merged.context.md');
    const run = async (args: string[]) => {
      f.lines.length = 0;
      const exit = await main([...args, '--session', f.session], f.deps);
      const output = f.output();
      const value = output.path ? JSON.parse(fs.readFileSync(output.path, 'utf8')) as Record<string, any> : null;
      return { exit, output, value };
    };

    const success = await run(['context', 'merge', a, b, '--out', out]);
    assert.equal(success.exit, 0, success.output.summary);
    assert.ok(success.value);
    assert.equal(success.value['out'], out);
    assert.equal(success.value['disputed'], 0);
    assert.deepEqual(success.value['errors'], []);
    assert.match(fs.readFileSync(out, 'utf8'), /> \*\*Strategy:\*\* merged/);

    const noOutput = await run(['context', 'merge', a, b]);
    assert.equal(noOutput.exit, 1);
    assert.equal(noOutput.output.reason, 'invalid-input');
    assert.match(noOutput.output.summary, /--out/);

    const wrongAction = await run(['status', 'show', '--out', out]);
    assert.equal(wrongAction.exit, 1);
    assert.equal(wrongAction.output.reason, 'usage');
    assert.match(wrongAction.output.summary, /only for context merge/);

    const unreadable = await run(['context', 'merge', missing, b, '--out', path.join(f.root, 'unreadable.context.md')]);
    assert.equal(unreadable.exit, 1);
    assert.equal(unreadable.output.reason, 'invalid-input');
    assert.match(unreadable.output.summary, /missing|unreadable/i);

    const lintInvalid = await run(['context', 'merge', invalid, b, '--out', path.join(f.root, 'lint-invalid-out.context.md')]);
    assert.equal(lintInvalid.exit, 4);
    assert.equal(lintInvalid.output.reason, 'lint-errors');
    assert.match(lintInvalid.output.summary, /lint errors/i);

    const mismatchOut = path.join(f.root, 'mismatch-out.context.md');
    const commitMismatch = await run(['context', 'merge', a, mismatch, '--out', mismatchOut]);
    assert.equal(commitMismatch.exit, 1);
    assert.equal(commitMismatch.output.reason, 'invalid-input');
    assert.match(commitMismatch.output.summary, /commit/i);
    assert.equal(fs.existsSync(mismatchOut), false, 'a refused merge must not publish its output');

    const preservedOut = path.join(f.root, 'preserved.context.md');
    fs.writeFileSync(preservedOut, 'existing output\n');
    const refusedExisting = await run(['context', 'merge', a, mismatch, '--out', preservedOut]);
    assert.equal(refusedExisting.exit, 1);
    assert.equal(fs.readFileSync(preservedOut, 'utf8'), 'existing output\n', 'a refused merge must preserve an existing output');
  } finally { f.cleanup(); }
});
