import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { sessionFixture } from './helpers/session.ts';
import { parseSpec } from '../../../skills/dispatch/scripts/toolkit/domain/spec.ts';
import { parseDesign } from '../../../skills/dispatch/scripts/toolkit/domain/design.ts';

const scoped = sessionFixture({ memory: true });
after(() => scoped.cleanup());

const PLAN = [
  '# Change a file', '', '## Task Map',
  '| ID | Title | Outcome | Prerequisites | Criteria |', '| --- | --- | --- | --- | --- |',
  '| T1 | Change a file | The file has the requested behavior. | none | SC1 |', '',
  '## Proposed Changes', '### T1 — Change a file', '#### [NEW] src/file.ts', '- Purpose: implements behavior.', '',
  '## Success Criteria', '- [SC1] File works', '  - Changes: src/file.ts',
  '  - Check: `node --test tests/file.test.ts`', '  - Evidence: check', '',
  '## Verification Plan', '### Automated Tests', '- `npm run lint`', '',
].join('\n');
const SPEC = '# Spec\n## Requirements\n### REQ-1 — Works\n- Acceptance: works\n## Decisions\n### DEC-1 — Use it\n';
const CONTEXT_MAP = [
  '# Context map: file', '', '> **Commit:** abcdef0', '>', '> **Tool:** text', '',
  '## Map', '- File — `src/file.ts:1`', '', '## Flows', '- file: `src/file.ts:1`', '',
  '## Invariants', '- File exists — `src/file.ts:1` — "File"', '',
  '## Coverage', '- entry-points: `src/file.ts:1`', '', '## Precedent', '- File: `src/file.ts`', '',
  '## Surprises', '- none — `src/file.ts:1`', '', '## Not covered', '- Dynamic dispatch', '',
].join('\n');
async function lint(name: string, source: string) {
  const f = {...scoped, cleanup: () => {}};
  f.lines.length = 0;
  try {
    const exit = await main(['lint', 'run', f.artifact(name, source), '--session', f.session], f.deps);
    const output = f.output();
    const result = JSON.parse(fs.readFileSync(output.path!, 'utf8'));
    return { exit, output, result };
  } finally { f.cleanup(); }
}
describe('lint severity', () => {
  test('lint results carry only kind hash errors and warnings', async () => {
    const a = await lint('a.plan.md', PLAN + '\n## Review Findings & Resolutions\nold\n');
    const b = await lint('b.plan.md', PLAN + '\n## Review Findings & Resolutions\nnew\n');
    const spec = await lint('shape.spec.md', SPEC);
    const design = await lint('shape.design.md', '# Design\n## Increment Dependency Graph\n');
    fs.mkdirSync(path.join(scoped.root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(scoped.root, 'src', 'file.ts'), 'File\n');
    const context = await lint('shape.context.md', CONTEXT_MAP);

    assert.equal(a.exit, 0);
    assert.deepEqual(a.result.errors, []);
    assert.ok(a.result.warnings.some((x: { code: string }) => x.code === 'missing-summary-box'));
    assert.ok(a.result.warnings.some((x: { code: string }) => x.code === 'missing-satisfies'));
    assert.match(a.output.summary, new RegExp(a.result.hash));
    assert.equal(a.result.hash, b.result.hash);
    for (const [kind, checked] of [['spec', spec], ['plan', a], ['design', design], ['context', context]] as const) {
      assert.equal(checked.result.kind, kind);
    }
    assert.equal(context.exit, 0);
    assert.deepEqual(context.result.errors, []);
    assert.deepEqual(context.result.warnings, []);
  });
  test('parse critical plan defects refuse lint', async () => {
    const refused = await lint('bad.plan.md', PLAN.replace('- [SC1]', '- [SCx]'));
    assert.equal(refused.exit, 4);
    assert.equal(refused.output.reason, 'lint-errors');
    assert.ok(refused.result.errors.length);
  });
  test('requirements block while decision heading defects warn', async () => {
    assert.equal((await lint('a.spec.md', SPEC.replace('REQ-1', 'REQ-x'))).exit, 4);
    const missing = parseSpec(SPEC.replace('## Requirements', '## Other'));
    assert.equal(missing.ok, false);
    const r = await lint('a.spec.md', SPEC.replace('DEC-1', 'DEC-x'));
    assert.equal(r.exit, 0);
    assert.ok(r.result.warnings.some((x: { code: string }) => x.code === 'malformed-id'));
  });
  test('design graph defects preserve partial structure as warnings', async () => {
    const graph = '# Design\n## Increment Dependency Graph\n';
    scoped.artifact('a.design.context.md', CONTEXT_MAP);
    const envelope = await lint('a.design.md', graph);
    assert.equal(envelope.exit, 0);
    assert.ok(envelope.result.warnings.some((x: {code: string}) => x.code === 'missing-increments'));
    for (const [rows, count, code] of [
      ['| I01 | 1 | First | I02 | src/a.ts |\n| I02 | 2 | Second | I01 | src/b.ts |', 2, 'cycle'],
      ['| I01 | 1 | First | none | src/a.ts |\n| I01 | 2 | Again | none | src/b.ts |', 2, 'duplicate-id'],
      ['', 0, 'missing-increments'], ['unreadable table', 0, 'missing-increments'],
    ] as const) {
      const r = parseDesign(graph + rows);
      assert.equal(r.ok, true);
      assert.equal(r.design.increments.length, count);
      assert.ok(r.warnings.some(x => x.code === code));
    }
  });
});
