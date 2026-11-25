import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { artifactHash } from '../../../skills/dispatch/scripts/toolkit/artifacts.ts';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { appendRecord, foldLedger, gate } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { sessionFixture } from './helpers/session.ts';

const PLAN = [
  '# Change a file',
  '',
  '## Task Map',
  '| ID | Title | Outcome | Prerequisites | Criteria |',
  '| --- | --- | --- | --- | --- |',
  '| T1 | Change a file | The file has the requested behavior. | none | SC1 |',
  '',
  '## Proposed Changes',
  '### T1 — Change a file',
  '#### [NEW] src/file.ts',
  '- Purpose: implements behavior.',
  '',
  '## Success Criteria',
  '- [SC1] File works',
  '  - Changes: src/file.ts',
  '  - Check: `node --test tests/file.test.ts`',
  '  - Evidence: check',
  '',
  '## Verification Plan',
  '### Automated Tests',
  '- `npm run lint`',
  '',
].join('\n');
const SPEC = '# Spec\n## Requirements\n### REQ-1 — Works\n- Acceptance: works\n';
const FIELDS = {
  class: 'non-intent',
  affects: ['T1', 'T2'],
  rationale: 'Clarify the outcome',
  diffRef: 'plan-edit.diff',
};
const PLAN_NAME = 'p.plan.md';

async function fixture(t: { after: (fn: () => void) => void }) {
  const f = sessionFixture({ memory: true });
  t.after(f.cleanup);
  const file = f.artifact(PLAN_NAME, PLAN);
  f.artifact('s.spec.md', SPEC);
  const add = (record: object) => appendRecord(f.session, record, f.deps);
  await add({ kind: 'bind', by: 'orchestrator', key: 'bind', data: { spec: 's.spec.md', plan: PLAN_NAME } });
  const spec = artifactHash('spec', SPEC);
  await add({ kind: 'confirm', by: 'user', key: 'confirm', quote: 'I confirm the spec', data: { spec } });
  const edits = () => foldLedger(f.session).records.filter((record) => record.kind === 'edit');
  const run = async (fields: object, artifact = file, action = ['lint', 'run', artifact]) => {
    f.lines.length = 0;
    const fieldsFile = f.artifact('edit.json', JSON.stringify(fields));
    const exit = await main([...action, '--edit', fieldsFile, '--session', f.session], f.deps);
    const output = f.output();
    const value = output.path ? JSON.parse(fs.readFileSync(output.path, 'utf8')) : undefined;
    return { ...output, exit, value };
  };
  const write = (title: string, name = PLAN_NAME) => {
    const source = PLAN.replace('Change a file', title);
    f.artifact(name, source);
    return artifactHash('plan', source);
  };
  const approve = (plan: string) =>
    add({ kind: 'approval', by: 'user', key: 'approval', quote: 'I approve the plan', data: { spec, plan } });
  const approvalGate = (plan: string) => gate(foldLedger(f.session), { spec, plan });
  return { f, add, edits, run, write, approve, approvalGate };
}

test('lint edits record the explicit baseline and derive the next edit', async (t) => {
  // one lint call records the explicit baseline and the next edit derives it
  {
    const { edits, run, write } = await fixture(t);
    const before = artifactHash('plan', PLAN);
    const after = write('First change');
    const first = await run({ ...FIELDS, before });
    assert.equal(first.exit, 0, first.summary);
    assert.equal(first.value.hash, after);
    const [stored] = edits();
    assert.equal(edits().length, 1);
    assert.equal(stored!.key, 'lint-edit:plan:1');
    assert.equal(stored!.by, 'orchestrator');
    assert.deepEqual(stored!.data, { ...FIELDS, artifact: 'plan', before, after });
    assert.deepEqual(first.value.edit, { seq: stored!.seq, deduped: false, before, after });
    assert.match(first.summary, new RegExp(`; edit seq ${stored!.seq} appended`));

    const next = write('Second change');
    const second = await run(FIELDS);
    assert.equal(second.exit, 0, second.summary);
    assert.equal(edits().length, 2);
    assert.equal(edits()[1]!.key, 'lint-edit:plan:2');
    assert.deepEqual(second.value.edit, { seq: edits()[1]!.seq, deduped: false, before: after, after: next });
  }

  // approval accepts an explicit new baseline and the following derived edit
  {
    const { edits, run, write, approve, approvalGate } = await fixture(t);
    const before = artifactHash('plan', PLAN);
    write('Earlier edit');
    const earlier = await run({ ...FIELDS, before });
    assert.equal(earlier.exit, 0, earlier.summary);
    const approved = write('New baseline');
    await approve(approved);
    const after = write('Edit after approval');
    const explicit = await run({ ...FIELDS, before: approved });
    assert.equal(explicit.exit, 0, explicit.summary);
    const current = write('Another edit after approval');
    const derived = await run(FIELDS);
    assert.equal(derived.exit, 0, derived.summary);
    assert.deepEqual(
      edits()
        .slice(1)
        .map((row) => [row.data['before'], row.data['after']]),
      [
        [approved, after],
        [after, current],
      ],
    );
    assert.deepEqual(approvalGate(current), { allowed: true });
  }
});

test('retry and rebound edits preserve seq, baseline and approval', async (t) => {
  // retry returns the stored seq only for matching fields and baseline
  {
    const { edits, run, write } = await fixture(t);
    const before = artifactHash('plan', PLAN);
    const after = write('Changed plan');
    const first = await run({ ...FIELDS, before });
    assert.equal(first.exit, 0, first.summary);
    for (const fields of [FIELDS, { ...FIELDS, before }]) {
      const retry = await run(fields);
      assert.equal(retry.exit, 0, retry.summary);
      assert.deepEqual(retry.value.edit, { ...first.value.edit, deduped: true });
      assert.match(retry.summary, new RegExp(`; edit seq ${first.value.edit.seq} deduped`));
    }
    assert.equal((await run({ ...FIELDS, rationale: 'Another rationale' })).reason, 'no-change');
    assert.equal((await run({ ...FIELDS, before: after })).reason, 'no-change');
    assert.equal(edits().length, 1);
  }

  // approval of a rebound plan needs an explicit first edit baseline
  {
    const { f, add, edits, run, write, approve, approvalGate } = await fixture(t);
    const oldAfter = write('Shared edited contents');
    const first = await run({ ...FIELDS, before: artifactHash('plan', PLAN) });
    assert.equal(first.exit, 0, first.summary);

    const name = 'rebound.plan.md';
    const source = PLAN.replace('Change a file', 'Approved rebound plan');
    const file = f.artifact(name, source);
    const baseline = artifactHash('plan', source);
    await add({ kind: 'bind', by: 'orchestrator', key: 'rebind', data: { spec: 's.spec.md', plan: name } });
    await approve(baseline);

    assert.equal(write('Shared edited contents', name), oldAfter);
    const missing = await run(FIELDS, file);
    assert.equal(missing.reason, 'invalid-input', missing.summary);
    assert.match(missing.summary, /\bbefore\b/);
    assert.equal(edits().length, 1);
    const after = write('Rebound plan edited', name);
    const missingWithDifferentHash = await run(FIELDS, file);
    assert.equal(missingWithDifferentHash.reason, 'invalid-input', missingWithDifferentHash.summary);
    assert.equal(edits().length, 1);

    const explicit = await run({ ...FIELDS, before: baseline }, file);
    assert.equal(explicit.exit, 0, explicit.summary);
    assert.deepEqual(explicit.value.edit, { seq: edits()[1]!.seq, deduped: false, before: baseline, after });
    assert.equal(edits()[1]!.key, 'lint-edit:plan:2');

    f.artifact('another.spec.md', SPEC);
    await add({
      kind: 'bind',
      by: 'orchestrator',
      key: 'same-plan',
      data: { spec: 'another.spec.md', plan: './' + name },
    });
    const current = write('Rebound plan edited again', name);
    const derived = await run(FIELDS, file);
    assert.equal(derived.exit, 0, derived.summary);
    assert.deepEqual(derived.value.edit, { seq: edits()[2]!.seq, deduped: false, before: after, after: current });
    assert.equal(edits()[2]!.key, 'lint-edit:plan:3');
    assert.deepEqual(approvalGate(current), { allowed: true });
  }

  // retry after restoring an earlier plan binding preserves its approval
  {
    const { f, add, edits, run, write, approve, approvalGate } = await fixture(t);
    const before = artifactHash('plan', PLAN);
    const after = write('First plan edited');
    const first = await run({ ...FIELDS, before });
    assert.equal(first.exit, 0, first.summary);

    const otherName = 'other.plan.md';
    const otherFile = f.artifact(otherName, PLAN);
    await add({ kind: 'bind', by: 'orchestrator', key: 'other', data: { spec: 's.spec.md', plan: otherName } });
    const otherAfter = write('Other plan edited', otherName);
    const other = await run({ ...FIELDS, before }, otherFile);
    assert.equal(other.exit, 0, other.summary);
    assert.equal(other.value.hash, otherAfter);

    await add({
      kind: 'bind',
      by: 'orchestrator',
      key: 'restore',
      data: { spec: 's.spec.md', plan: './' + PLAN_NAME },
    });
    await approve(after);
    const retry = await run({ ...FIELDS, before });
    assert.equal(retry.exit, 0, retry.summary);
    assert.deepEqual(retry.value.edit, { ...first.value.edit, deduped: true });
    assert.equal(edits().length, 2);
    assert.deepEqual(approvalGate(after), { allowed: true });

    const current = write('First plan edited again');
    const derived = await run(FIELDS);
    assert.equal(derived.exit, 0, derived.summary);
    assert.deepEqual(derived.value.edit, { seq: edits()[2]!.seq, deduped: false, before: after, after: current });
    assert.equal(edits()[2]!.key, 'lint-edit:plan:3');
    assert.deepEqual(approvalGate(current), { allowed: true });
  }
});

test('lint edit refusals leave the ledger without edits', async (t) => {
  const { f, edits, run } = await fixture(t);
  const before = artifactHash('plan', PLAN);
  const fields = { ...FIELDS, before };
  const missing = await run(FIELDS);
  assert.equal(missing.exit, 1);
  assert.match(missing.summary, /\bbefore\b/);
  assert.equal((await run(fields)).reason, 'no-change');
  const bad = f.artifact(PLAN_NAME, PLAN.replace('[SC1]', '[SCx]'));
  const errors = await run(fields, bad);
  assert.equal(errors.exit, 4);
  assert.equal(errors.reason, 'lint-errors');
  assert.ok(errors.value.errors.length);
  f.artifact(PLAN_NAME, PLAN);
  const design = f.artifact('d.design.md', '# Design\n## Increment Dependency Graph\n');
  assert.match((await run(fields, design)).summary, /bound/);
  const other = f.artifact('another.plan.md', PLAN);
  assert.match((await run(fields, other)).summary, /bound/);
  const context = f.artifact(
    'p.context.md',
    [
      '# Context map: file',
      '',
      '> **Commit:** abcdef0',
      '>',
      '> **Tool:** text',
      '',
      '## Map',
      '- File — `p.plan.md:1`',
      '',
      '## Flows',
      '- file: `p.plan.md:1`',
      '',
      '## Invariants',
      '- File exists — `p.plan.md:1` — "Change a file"',
      '',
      '## Coverage',
      '- entry-points: `p.plan.md:1`',
      '',
      '## Precedent',
      '- File: `p.plan.md`',
      '',
      '## Surprises',
      '- none — `p.plan.md:1`',
      '',
      '## Not covered',
      '- Dynamic dispatch',
      '',
    ].join('\n'),
  );
  const contextRefusal = await run(fields, context);
  assert.equal(contextRefusal.reason, 'invalid-input');
  assert.match(contextRefusal.summary, /context map/);
  assert.equal((await run({ ...fields, extra: true })).reason, 'invalid-input');
  assert.match((await run(fields, undefined, ['ledger', 'query'])).summary, /--edit is only for lint run/);
  assert.deepEqual(edits(), []);
});

test('lint run --edit refuses broken-citation and succeeds when repaired', async (t) => {
  const { f, edits, run } = await fixture(t);
  const before = artifactHash('plan', PLAN);
  const broken = f.artifact(
    PLAN_NAME,
    PLAN.replace('- Purpose: implements behavior.', '- Purpose: see `src/missing.ts:1`.'),
  );
  const refused = await run({ ...FIELDS, before }, broken);
  assert.equal(refused.exit, 4);
  assert.equal(refused.reason, 'lint-errors');
  assert.ok(refused.value.errors.some((d: { code: string }) => d.code === 'broken-citation'));
  assert.deepEqual(edits(), []);

  fs.mkdirSync(f.root + '/src', { recursive: true });
  fs.writeFileSync(f.root + '/src/file.ts', 'export const ok = true;\n');
  const repaired = f.artifact(
    PLAN_NAME,
    PLAN.replace('- Purpose: implements behavior.', '- Purpose: see `src/file.ts:1`.'),
  );
  const accepted = await run({ ...FIELDS, before }, repaired);
  assert.equal(accepted.exit, 0, accepted.summary);
  assert.equal(edits().length, 1);
  assert.equal(accepted.value.edit.deduped, false);
});
