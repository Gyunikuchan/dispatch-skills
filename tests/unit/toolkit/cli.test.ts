import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { nodeLinkFs } from '../../../skills/dispatch/scripts/lib/node-fs-ext.ts';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { ToolError } from '../../../skills/dispatch/scripts/toolkit/output.ts';
import { sessionFixture } from './helpers/session.ts';
import { appendRecord, foldLedger } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { readManifest } from '../../../skills/dispatch/scripts/lib/session.ts';
import { reviewFixIdentity } from '../../../skills/dispatch/scripts/toolkit/integrate.ts';

function useMemoryAtomicWrite(): () => void {
  const writeAtomic = nodeLinkFs.writeAtomic;
  nodeLinkFs.writeAtomic = (file, text) => fs.writeFileSync(file, text);
  return () => { nodeLinkFs.writeAtomic = writeAtomic; };
}

describe('toolkit CLI contract', () => {
  test('commit retries distinguish corrupt correction metadata from completed retries', async () => {
    const f = sessionFixture({memory:true});
    try {
      const head = 'a'.repeat(40), reason = 'repair bounded SHOULD';
      const directory = path.join(f.session, '.state/worktrees/integration');
      fs.mkdirSync(directory, {recursive:true});
      f.artifact('mission.spec.md', '# Mission\n');
      f.artifact('work.plan.md', '# Work\n');
      await appendRecord(f.session, {kind: 'bind', key: 'commit-inputs', by: 'orchestrator', data: {spec: 'mission.spec.md', plan: 'work.plan.md'}}, f.deps);
      await appendRecord(f.session, {kind:'integrate',by:'tool',data:{phase:'opened',path:'.state/worktrees/integration',branch:'dispatch/test/integration',base:'b'.repeat(40),dest:{path:f.root,branch:'main'}}}, f.deps);
      const prefix = `dispatch fix: ${reason}\n\nDispatch-Fix: ${readManifest(f.session).safeSessionId}\n`;
      const metadata = reviewFixIdentity({review:'code-integration',round:3,generation:1,findings:['R3-F001'],from:'b'.repeat(40)});
      let message = '';
      f.deps.run = async (argv) => {
        const args = argv.slice(1);
        if (args.join(' ') === 'rev-parse HEAD') return {exit:0,stdout:head,stderr:''};
        if (args[0] === 'diff' || args[0] === 'ls-files') return {exit:0,stdout:'',stderr:''};
        if (args[0] === 'log') return {exit:0,stdout:message,stderr:''};
        throw Error('Unexpected Git call: ' + JSON.stringify(argv));
      };
      for (const trailers of [
        `Dispatch-Review-Fix: ${metadata.digest}\nDispatch-Review-Fix-Data: broken`,
        `Dispatch-Review-Fix: sha256:${'0'.repeat(64)}\nDispatch-Review-Fix-Data: ${metadata.data}`,
        `Dispatch-Review-Fix: ${metadata.digest}\nDispatch-Review-Fix: ${metadata.digest}\nDispatch-Review-Fix-Data: ${metadata.data}`,
      ]) {
        message = prefix + trailers;
        f.lines.length = 0;
        assert.equal(await main(['worktree','commit','--reason',reason,'--session',f.session],f.deps),1);
        assert.equal(f.output().reason,'invalid-review-fix');
        assert.equal(foldLedger(f.session).records.filter(row=>row.data['phase']==='fix').length,0);
      }
      message = prefix + `Dispatch-Review-Fix: ${metadata.digest}\nDispatch-Review-Fix-Data: ${metadata.data}`;
      f.lines.length = 0;
      assert.equal(await main(['worktree','commit','--reason',reason,'--session',f.session],f.deps),0);
      f.lines.length = 0;
      assert.equal(await main(['worktree','commit','--reason',reason,'--session',f.session],f.deps),4);
      assert.equal(f.output().reason,'no-changes');
    } finally { f.cleanup(); }
  });
  test('usage errors print one line without a result path', async () => {
    const f = sessionFixture({memory:true});
    try {
      for (const args of [['unknown', 'run'], ['lint', 'unknown'], ['lint', 'run'], ['lint', 'run', '--session', f.root]]) {
        f.lines.length = 0;
        assert.equal(await main(args, f.deps), 1);
        assert.equal(f.output().path, null);
        assert.ok(f.lines[0]!.endsWith('\n'));
      }
      fs.writeFileSync(path.join(f.session, 'manifest.json'), '{');
      f.lines.length = 0;
      assert.equal(await main(['lint', 'run', '--session', f.session], f.deps), 1);
      assert.equal(f.output().path, null);
    } finally { f.cleanup(); }
  });
  test('handlers persist success refusals and unexpected faults', async () => {
    const f = sessionFixture({memory:true});
    try {
      for (const [reason, exit] of [['invalid-input', 1], ['invalid-record', 1], ['user-only', 1], ['missing-key', 1], ['approval-stale', 1], ['key-conflict', 2], ['ledger-corrupt', 2], ['fault', 2], ['lock-held', 3], ['lint-errors', 4]] as const) {
        f.lines.length = 0;
        assert.equal(await main(['lint', 'run', '--session', f.session], { ...f.deps, handler: async () => { throw new ToolError(exit, reason, 'input field rejected'); } }), exit);
        const out = f.output();
        assert.equal(out.reason, reason);
        assert.ok(out.path?.startsWith(path.join(f.session, '.state', 'results')));
        assert.match(fs.readFileSync(out.path!, 'utf8'), /input field/);
      }
      for (const fail of [false, true]) {
        f.lines.length = 0;
        assert.equal(await main(['lint', 'run', '--session', f.session], { ...f.deps, handler: async () => {
          if (fail) throw new Error('broken handler');
          return { ok: true, summary: 'done', value: { answer: 42 }, exit: 0 };
        } }), fail ? 2 : 0);
        assert.ok(fs.existsSync(f.output().path!));
        assert.equal(f.output().ok, !fail);
      }
    } finally { f.cleanup(); }
  });
  test('output write failure reports fault without a path', async () => {
    const f = sessionFixture({memory:true});
    try {
      assert.equal(await main(['lint', 'run', '--session', f.session], { ...f.deps,
        handler: async () => ({ ok: true, summary: 'done', value: {}, exit: 0 }),
        writeResult: () => { throw new Error('disk full'); },
      }), 2);
      assert.equal(f.output().reason, 'fault');
      assert.equal(f.output().path, null);
    } finally { f.cleanup(); }
  });

  test('plan and design ruling appends update only the matching findings section', async () => {
    const f = sessionFixture({memory:true});
    const restoreAtomicWrite = useMemoryAtomicWrite();
    try {
      const spec = f.artifact('mission.spec.md', '# Mission\n## Intent & Problem\nKeep work recoverable.\n');
      const plan = f.artifact('work.plan.md', '# Work\n\n## Review Findings & Resolutions\nPlan driver note.\n\n## Next\nPlan stays intact.\n');
      const design = f.artifact('strategy.design.md', '# Strategy\n\n## Review Findings & Resolutions\nDesign driver note.\n\n## Next\nDesign stays intact.\n');
      const append = async (name: string, record: object) => {
        const file = path.join(f.root, `${name}.json`);
        fs.writeFileSync(file, JSON.stringify(record));
        f.lines.length = 0;
        const exit = await main(['ledger', 'append', file, '--session', f.session], f.deps);
        const output = f.output();
        return { exit, output, value: JSON.parse(fs.readFileSync(output.path!, 'utf8')) as Record<string, unknown> };
      };
      const relative = (file: string) => path.relative(f.root, file).split(path.sep).join('/');
      await append('bind', { kind: 'bind', by: 'orchestrator', key: 'bind', data: { spec: relative(spec), plan: relative(plan), design: relative(design) } });
      const seedRound = (review: string) => {
        const directory = path.join(f.session, '.state', 'reviews', review, 'round-1');
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'round.json'), JSON.stringify({ round: 1, generation: 1, cap: 2, roster: [] }));
        fs.writeFileSync(path.join(directory, 'findings.json'), JSON.stringify({ review, round: 1, findings: [{ id: 'R1-F001', severity: 'SHOULD' }] }));
      };

      const planReview = 'plan-work.plan';
      seedRound(planReview);
      const designBefore = fs.readFileSync(design, 'utf8');
      const planResult = await append('plan-ruling', { kind: 'ruling', by: 'orchestrator', key: 'plan-ruling', data: { subject: `review:${planReview}:R1-F001`, ruling: 'accepted', rationale: 'Plan fix applied' } });
      assert.equal(planResult.exit, 0);
      assert.equal(planResult.value['findingsSection'], 'updated', JSON.stringify(planResult.value));
      assert.match(fs.readFileSync(plan, 'utf8'), /Round 1 \(plan-work\.plan\): 1 findings/);
      assert.equal(fs.readFileSync(design, 'utf8'), designBefore);

      const planAfter = fs.readFileSync(plan, 'utf8');
      const designReview = 'design-strategy.design';
      seedRound(designReview);
      const designResult = await append('design-ruling', { kind: 'ruling', by: 'orchestrator', key: 'design-ruling', data: { subject: `review:${designReview}:R1-F001`, ruling: 'deferred', rationale: 'Design needs follow-up' } });
      assert.equal(designResult.exit, 0);
      assert.equal(designResult.value['findingsSection'], 'updated');
      assert.match(fs.readFileSync(design, 'utf8'), /Round 1 \(design-strategy\.design\): 1 findings/);
      assert.equal(fs.readFileSync(plan, 'utf8'), planAfter);
    } finally { restoreAtomicWrite(); f.cleanup(); }
  });

  test('deduped ruling retry refreshes a skipped findings section', async () => {
    const f = sessionFixture({memory:true});
    const restoreAtomicWrite = useMemoryAtomicWrite();
    try {
      const spec = f.artifact('mission.spec.md', '# Mission\n## Intent & Problem\nKeep work recoverable.\n');
      const plan = f.artifact('work.plan.md', '# Work\n\n## Review Findings & Resolutions\nDriver note.\n');
      const append = async (record: object) => {
        const file = path.join(f.root, 'ruling.json');
        fs.writeFileSync(file, JSON.stringify(record));
        f.lines.length = 0;
        const exit = await main(['ledger', 'append', file, '--session', f.session], f.deps);
        const output = f.output();
        return { exit, output, value: JSON.parse(fs.readFileSync(output.path!, 'utf8')) as Record<string, unknown> };
      };
      const relative = (file: string) => path.relative(f.root, file).split(path.sep).join('/');
      await append({ kind: 'bind', by: 'orchestrator', key: 'bind', data: { spec: relative(spec), plan: relative(plan) } });
      const review = 'plan-work.plan';
      const directory = path.join(f.session, '.state', 'reviews', review, 'round-1');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'round.json'), JSON.stringify({ round: 1, generation: 1, cap: 2, roster: [] }));
      fs.writeFileSync(path.join(directory, 'findings.json'), JSON.stringify({ review, round: 1, findings: [{ id: 'R1-F001', severity: 'SHOULD' }] }));
      const ruling = { kind: 'ruling', by: 'orchestrator', key: 'retry-ruling', data: { subject: `review:${review}:R1-F001`, ruling: 'accepted', rationale: 'Repair completed' } };
      fs.rmSync(plan);
      const skipped = await append(ruling);
      assert.equal(skipped.exit, 0);
      assert.equal(skipped.value['findingsSection'], 'skipped');
      assert.match(String(skipped.value['findingsSectionReason']), /read|missing|bound|ENOENT/i);

      fs.writeFileSync(plan, '# Work\n\n## Review Findings & Resolutions\nDriver note.\n');
      const retried = await append(ruling);
      assert.equal(retried.exit, 0);
      assert.equal(retried.value['deduped'], true);
      assert.equal(retried.value['findingsSection'], 'updated');
      assert.match(fs.readFileSync(plan, 'utf8'), /Round 1 \(plan-work\.plan\): 1 findings/);
    } finally { restoreAtomicWrite(); f.cleanup(); }
  });
  test('context merge writes the merged map and refuses commit mismatch', async () => {
    const f = sessionFixture();
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
});

test('lint run summary lists first defects with remaining count', async () => {
  const f = sessionFixture({memory:true});
  try {
    const file = f.artifact('work.plan.md', '# Work\n## Task Map\n| ID | Title | Outcome | Prerequisites | Criteria |\n| --- | --- | --- | --- | --- |\n## Success Criteria\n');
    assert.equal(await main(['lint', 'run', file, '--session', f.session], f.deps), 4);
    assert.equal(f.output().reason, 'lint-errors');
    assert.match(f.output().summary, /^plan: 4 errors, 2 warnings; sha256:[0-9a-f]{64}; first 5: L- proposed-changes: .*; L4 task-map: .*; L- verification-plan: .*; L5 success-criteria: .*; L- missing-section: .*; \+1 more in result$/);
  } finally { f.cleanup(); }
});
