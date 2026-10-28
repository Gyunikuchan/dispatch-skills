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
});
