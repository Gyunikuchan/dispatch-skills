import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, describe, test } from 'node:test';
import { sessionFixture } from './helpers/session.ts';
import { parsePlan } from '../../../skills/dispatch/scripts/toolkit/domain/plan.ts';
import { parseSpec } from '../../../skills/dispatch/scripts/toolkit/domain/spec.ts';
import { parseDesign } from '../../../skills/dispatch/scripts/toolkit/domain/design.ts';

const scoped = sessionFixture();
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
async function lint(name: string, source: string) {
  const { main } = await import('../../../skills/dispatch/scripts/toolkit/cli.ts');
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
  test('presentation warnings retain parsed plans and governed hashes', async () => {
    const a = await lint('a.plan.md', PLAN + '\n## Review Findings & Resolutions\nold\n');
    const b = await lint('b.plan.md', PLAN + '\n## Review Findings & Resolutions\nnew\n');
    assert.equal(a.exit, 0);
    assert.deepEqual(a.result.errors, []);
    assert.ok(a.result.warnings.some((x: { code: string }) => x.code === 'missing-summary-box'));
    assert.ok(a.result.warnings.some((x: { code: string }) => x.code === 'missing-satisfies'));
    assert.equal(a.result.parsed.tasks[0].paths[0], 'src/file.ts');
    assert.match(a.output.summary, new RegExp(a.result.hash));
    assert.equal(a.result.hash, b.result.hash);
  });
  test('parse critical plan defects refuse lint', async () => {
    const refused = await lint('bad.plan.md', PLAN.replace('- [SC1]', '- [SCx]'));
    assert.equal(refused.exit, 4);
    assert.equal(refused.output.reason, 'lint-errors');
    assert.ok(refused.result.errors.length);
    for (const source of [
      PLAN.replace('- [SC1]', '- [SCx]'),
      PLAN.replace('#### [NEW] src/file.ts\n- Purpose: implements behavior.\n', ''),
      PLAN.replace(/## Success Criteria[\s\S]*?## Verification Plan/, '## Verification Plan'),
      PLAN.replace('  - Changes: src/file.ts\n', ''),
      PLAN.replace('  - Changes: src/file.ts', '  - Changes: src/unknown.ts'),
      PLAN.replace(/## Verification Plan[\s\S]*/, ''),
    ]) {
      const r = parsePlan(source);
      assert.equal(r.ok, false, JSON.stringify(r));
      if (!r.ok) assert.ok(r.defects.length);
    }
  });
  test('requirements block while decision heading defects warn', async () => {
    assert.equal((await lint('a.spec.md', SPEC.replace('REQ-1', 'REQ-x'))).exit, 4);
    const missing = parseSpec(SPEC.replace('## Requirements', '## Other'), {level: 'medium'});
    assert.equal(missing.ok, false);
    const r = await lint('a.spec.md', SPEC.replace('DEC-1', 'DEC-x'));
    assert.equal(r.exit, 0);
    assert.ok(r.result.warnings.some((x: { code: string }) => x.code === 'malformed-id'));
  });
  test('design graph defects preserve partial structure as warnings', async () => {
    const graph = '# Design\n## Increment Dependency Graph\n';
    const envelope = await lint('a.design.md', graph);
    assert.equal(envelope.exit, 0);
    assert.equal(envelope.result.parsed.increments.length, 0);
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
  test('invalid artifact fields persist actionable input failures', async () => {
    const { main } = await import('../../../skills/dispatch/scripts/toolkit/cli.ts');
    const f = {...scoped, cleanup: () => {}};
    try {
      for (const artifact of [f.root + '/missing.plan.md', f.root, f.artifact('unknown.txt', 'text')]) {
        f.lines.length = 0;
        assert.equal(await main(['lint', 'run', artifact, '--session', f.session], f.deps), 1);
        assert.match(fs.readFileSync(f.output().path!, 'utf8'), /artifact/);
        assert.equal(f.output().reason, 'invalid-input');
      }
    } finally { f.cleanup(); }
  });
});
