import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { sessionFixture } from './helpers/session.ts';
import { parseSpec } from '../../../skills/dispatch/scripts/toolkit/domain/spec.ts';
import { parseDesign } from '../../../skills/dispatch/scripts/toolkit/domain/design.ts';
import { lintArtifact } from '../../../skills/dispatch/scripts/toolkit/lint.ts';
import { appendRecord } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { loadPlan } from '../../../skills/dispatch/scripts/toolkit/plan-view.ts';
import { readManifest } from '../../../skills/dispatch/scripts/lib/session.ts';

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
test('lint run arity refusal names usage', async () => {
  scoped.lines.length = 0;
  assert.equal(await main(['lint', 'run', '--session', scoped.session], scoped.deps), 1);
  const output = scoped.output();
  assert.equal(output.reason, 'invalid-input');
  assert.match(output.summary, /lint run <artifact> --session <session> \[--edit <fields\.json\|-> \| --json <json>\]/);
});

test('lint run unknown edit field names allowed fields', async () => {
  scoped.lines.length = 0;
  const file = scoped.artifact('unknown-edit.json', '{"after":"not allowed"}');
  assert.equal(await main(['lint', 'run', 'a.plan.md', '--session', scoped.session, '--edit', file], scoped.deps), 1);
  const output = scoped.output();
  assert.equal(output.reason, 'invalid-input');
  assert.match(output.summary, /Unknown --edit field: after.*class, affects, rationale, diffRef.*before/);
});

describe('lint severity', () => {
    test('lint results carry severity, refuse critical defects and preserve structure as warnings', async () => {
  // lint results carry only kind hash errors and warnings
  {
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
  }

  // parse critical plan defects refuse lint
  {
    const refused = await lint('bad.plan.md', PLAN.replace('- [SC1]', '- [SCx]'));
    assert.equal(refused.exit, 4);
    assert.equal(refused.output.reason, 'lint-errors');
    assert.ok(refused.result.errors.length);
  }

  // requirements block while decision heading defects warn
  {
    assert.equal((await lint('a.spec.md', SPEC.replace('REQ-1', 'REQ-x'))).exit, 4);
    const missing = parseSpec(SPEC.replace('## Requirements', '## Other'));
    assert.equal(missing.ok, false);
    const r = await lint('a.spec.md', SPEC.replace('DEC-1', 'DEC-x'));
    assert.equal(r.exit, 0);
    assert.ok(r.result.warnings.some((x: { code: string }) => x.code === 'malformed-id'));
  }

  // design graph defects preserve partial structure as warnings
  {
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
  }
  });

});

test('lintArtifact reports broken-citation while loadPlan stays immune', async t => {
  const f = sessionFixture({ memory: true });
  t.after(f.cleanup);
  fs.mkdirSync(path.join(f.root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'src', 'file.ts'), 'export const value = 1;\n');
  const planSource = PLAN.replace(
    '- Purpose: implements behavior.',
    '- Purpose: implements behavior (`src/file.ts:99` and `src/missing.ts:1`).',
  );
  const planFile = f.artifact('drifted.plan.md', planSource);
  const designFile = f.artifact('drifted.design.md', '# Design\n## Approach\nRef `src/missing.ts:1`.\n## Increment Dependency Graph\n| I01 | 1 | First | none | src/file.ts |\n');
  const planLint = lintArtifact(planFile, { repositoryRoot: f.root });
  assert.ok(planLint.errors.some(d => d.code === 'broken-citation'));
  const designLint = lintArtifact(designFile, { repositoryRoot: f.root });
  assert.ok(designLint.errors.some(d => d.code === 'broken-citation'));
  f.artifact('s.spec.md', SPEC);
  await appendRecord(f.session, { kind: 'bind', by: 'orchestrator', key: 'bind', data: { spec: 's.spec.md', plan: 'drifted.plan.md' } }, f.deps);
  const loaded = loadPlan(f.session, readManifest(f.session));
  assert.equal(loaded.tasks[0]?.id, 'T1');
});
