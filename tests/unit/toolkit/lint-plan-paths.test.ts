import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { sessionFixture } from './helpers/session.ts';
import { outsideIncrementWarnings, parsePlan } from '../../../skills/dispatch/scripts/toolkit/domain/plan.ts';
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
  '  - Verify: `node --test tests/file.test.ts`', '  - Evidence: verify', '',
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
  describe('plan paths outside the pinned increment', () => {
    const design = (paths: string) => [
      '# Design', '', '## Increment Dependency Graph',
      '| ID | Priority | Summary | Prerequisites | Paths |', '| --- | --- | --- | --- | --- |',
      `| I01 | 1 | First | none | ${paths} |`, '',
    ].join('\n');
    const pinned = (changePaths: string[]) => [
      '# Change files', '', '> **Parent:** `docs/x.design.md` · I01', '', '## Task Map',
      '| ID | Title | Outcome | Prerequisites | Criteria |', '| --- | --- | --- | --- | --- |',
      '| T1 | Change files | The files have the requested behavior. | none | SC1 |', '',
      '## Proposed Changes', '### T1 — Change files',
      ...changePaths.flatMap(p => [`#### [NEW] ${p}`, '- Purpose: implements behavior.']), '',
      '## Success Criteria', '- [SC1] Files work', `  - Changes: ${changePaths.join(', ')}`,
      '  - Verify: `node --test tests/file.test.ts`', '  - Evidence: verify', '',
      '## Verification Plan', '### Automated Tests', '- `npm run lint`', '',
    ].join('\n');
    const outside = (r: { result: { warnings: { code: string; message: string }[] } }) => r.result.warnings.filter(x => x.code === 'outside-increment');
    const writeDesign = (paths: string) => {
      fs.mkdirSync(path.join(scoped.root, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(scoped.root, 'docs', 'x.design.md'), design(paths));
    };

    test('warns per path outside a backticked Paths column and still passes lint', async () => {
      writeDesign('`src/a/`, `lib/*.ts`');
      const r = await lint('p1.plan.md', pinned(['src/a/in.ts', 'lib/x.ts', 'src/ab/out.ts']));
      assert.equal(r.exit, 0, r.output.summary);
      assert.deepEqual(r.result.errors, []);
      const warned = outside(r).map(x => x.message);
      assert.equal(warned.length, 1, JSON.stringify(warned));
      assert.ok(warned.some(m => m.includes('src/ab/out.ts')));
    });
    test('a parent-segment path is outside every increment path', () => {
      assert.equal(outsideIncrementWarnings([{ action: 'NEW', path: 'src/a/../b.ts', note: '', command: null, line: 7 }], ['src/a/'], 'I01').length, 1);
    });
    test('a plan without a design Parent gets no outside-increment warning', async () => {
      writeDesign('`src/a/`');
      const r = await lint('p2.plan.md', PLAN);
      assert.equal(outside(r).length, 0);
    });
    test('an unreadable pinned design gives one outside-increment warning naming it', async () => {
      fs.rmSync(path.join(scoped.root, 'docs', 'x.design.md'), { force: true });
      const r = await lint('p3.plan.md', pinned(['src/a.ts', 'src/b.ts']));
      assert.equal(r.exit, 0, r.output.summary);
      const warned = outside(r);
      assert.equal(warned.length, 1);
      assert.match(warned[0]!.message, /docs\/x\.design\.md/);
    });
  });
