import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const CONTEXT_MAP = [
  '# Context map: file', '', '> **Commit:** abc123', '>', '> **Strategy:** single', '>', '> **Tool:** text', '',
  '## Map', '- File — `src/file.ts:1`', '', '## Flows', '- file: `src/file.ts:1`', '',
  '## Invariants', '- File exists — `src/file.ts:1` — "File"', '',
  '## Coverage', '- entry-points: `src/file.ts:1`', '', '## Precedent', '- File: `src/file.ts`', '',
  '## Surprises', '- none — `src/file.ts:1`', '', '## Not covered', '- Dynamic dispatch', '',
].join('\n');
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
    scoped.artifact('a.context.md', CONTEXT_MAP);
    scoped.artifact('b.context.md', CONTEXT_MAP);
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
    const missing = parseSpec(SPEC.replace('## Requirements', '## Other'));
    assert.equal(missing.ok, false);
    const r = await lint('a.spec.md', SPEC.replace('DEC-1', 'DEC-x'));
    assert.equal(r.exit, 0);
    assert.ok(r.result.warnings.some((x: { code: string }) => x.code === 'malformed-id'));
  });
  test('design graph defects preserve partial structure as warnings', async () => {
    const graph = '# Design\n## Increment Dependency Graph\n';
    scoped.artifact('a.context.md', CONTEXT_MAP);
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
  test('plan and design lint accept a missing sibling context map', async () => {
    const design = '# Design\n## Increment Dependency Graph\n';
    const absentPlan = await lint('solo.plan.md', PLAN);
    assert.equal(absentPlan.exit, 0);
    assert.deepEqual(absentPlan.result.errors, []);
    const absentDesign = await lint('solo.design.md', design);
    assert.equal(absentDesign.exit, 0);
    assert.deepEqual(absentDesign.result.errors, []);

    scoped.artifact('solo.context.md', CONTEXT_MAP.replaceAll('src/file.ts', 'docs/uncovered.md'));
    const presentPlan = await lint('solo.plan.md', PLAN);
    assert.deepEqual(presentPlan.result.errors, []);
    assert.ok(presentPlan.result.warnings.some((x: { code: string }) => x.code === 'context-uncovered'));
  });
  test('lint run checks a context map against the repository root', async () => {
    const f = sessionFixture();
    try {
      fs.mkdirSync(path.join(f.root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(f.root, 'src', 'entry.ts'), 'export function main() {}\n');
      const map = [
        '# Context map: root', '', '> **Commit:** abc123', '>', '> **Strategy:** single', '>', '> **Tool:** text', '',
        '## Map', '- Entry — `src/entry.ts:1`', '', '## Flows', '- entry: `src/entry.ts:1`', '',
        '## Invariants', '- Entry exists — `src/entry.ts:1` — "export function main() {}"', '',
        '## Coverage', '- entry-points: `src/entry.ts:1`', '', '## Precedent', '- Entry: `src/entry.ts`', '',
        '## Surprises', '- none — `src/entry.ts:1`', '', '## Not covered', '- Dynamic dispatch', '',
      ].join('\n');
      const file = path.join(f.session, 'maps', 'root.context.md');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, map);
      const { main } = await import('../../../skills/dispatch/scripts/toolkit/cli.ts');
      const exit = await main(['lint', 'run', file, '--session', f.session], f.deps);
      const output = f.output();
      const result = JSON.parse(fs.readFileSync(output.path!, 'utf8'));
      assert.equal(exit, 0);
      assert.equal(result.kind, 'context');
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.warnings, []);
    } finally { f.cleanup(); }
  });

  test('lint run rejects context references through links outside the repository root', async () => {
    const f = sessionFixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'context-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.ts'), 'export const secret = true;\n');
      fs.symlinkSync(outside, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      const map = [
        '# Context map: linked path', '', '> **Commit:** abc123', '>', '> **Strategy:** single', '>', '> **Tool:** text', '',
        '## Map', '- Secret — `linked/secret.ts:1`', '', '## Flows', '- secret: `linked/secret.ts:1`', '',
        '## Invariants', '- Secret exists — `linked/secret.ts:1` — "export const secret = true;"', '',
        '## Coverage', '- entry-points: `linked/secret.ts:1`', '', '## Precedent', '- Secret: `linked/secret.ts`', '',
        '## Surprises', '- none — `linked/secret.ts:1`', '', '## Not covered', '- Dynamic dispatch', '',
      ].join('\n');
      const file = f.artifact('linked.context.md', map);
      const { main } = await import('../../../skills/dispatch/scripts/toolkit/cli.ts');
      const exit = await main(['lint', 'run', file, '--session', f.session], f.deps);
      const output = f.output();
      const result = JSON.parse(fs.readFileSync(output.path!, 'utf8'));
      assert.equal(exit, 4);
      assert.ok(result.errors.some((issue: { code: string }) => issue.code === 'context-ref-missing'));
    } finally {
      f.cleanup();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
  test('plan lint warns for context map files the plan omits', async () => {
    const context = (strategy: string, coverage: string[], precedent: string[], gap: string) => [
      '# Context map: coverage', '', '> **Commit:** abc123', '>', `> **Strategy:** ${strategy}`, '>', '> **Tool:** text', '',
      '## Map', '- Entry — `src/file.ts:1`', '', '## Flows', '- entry: `src/file.ts:1`', '',
      '## Invariants', '- Entry is available — `src/file.ts:1` — "Entry"', '',
      '## Coverage', ...coverage, '', '## Precedent', ...precedent, '',
      '## Surprises', '- none — `src/file.ts:1`', '', '## Not covered', `- ${gap}`, '',
    ].join('\n');
    const plan = PLAN.replace('## Task Map', [
      '## Out of Scope', '- `docs/exact.md` is handled elsewhere.', '- `docs/target.mdx` is excluded.', '', '## Task Map',
    ].join('\n'));
    scoped.artifact('coverage.context.md', context('outside-in', [
      '- changed: `src/file.ts:1`',
      '- exact exclusion: `docs/exact.md`',
      '- longer exclusion: `docs/target.md`',
      '- unlisted test: `tests/unlisted.test.ts`',
    ], [
      '- changed analogue: `src/file.ts`',
      '- prior docs: `docs/analogue.md`',
      '- repeated test: `tests/unlisted.test.ts`',
    ], 'inside-out strategy map was not produced'));
    scoped.artifact('coverage.outside-in.context.md', context('outside-in', ['- strategy-only: `docs/outside-only.md`'], [], 'none'));
    scoped.artifact('coverage.inside-out.context.md', context('inside-out', ['- strategy-only: `docs/inside-only.md`'], [], 'none'));

    const checked = await lint('coverage.plan.md', plan);
    const uncovered = checked.result.warnings.filter((issue: { code: string }) => issue.code === 'context-uncovered');
    assert.deepEqual(uncovered.map((issue: { message: string }) => issue.message).sort(), [
      'Context map file docs/analogue.md appears in Coverage or Precedent but not in Proposed Changes or Out of Scope.',
      'Context map file docs/target.md appears in Coverage or Precedent but not in Proposed Changes or Out of Scope.',
      'Context map file tests/unlisted.test.ts appears in Coverage or Precedent but not in Proposed Changes or Out of Scope.',
    ]);

    scoped.artifact('plain.context.md', context('single', [], [], 'none'));
    const before = await lint('plain.plan.md', PLAN);
    scoped.artifact('plain.outside-in.context.md', context('outside-in', ['- strategy-only: `docs/outside-only.md`'], [], 'none'));
    scoped.artifact('plain.inside-out.context.md', context('inside-out', ['- strategy-only: `docs/inside-only.md`'], [], 'none'));
    const after = await lint('plain.plan.md', PLAN);
    assert.deepEqual(after.result, before.result);
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
