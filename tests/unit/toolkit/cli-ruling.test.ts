import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { nodeLinkFs } from '../../../skills/dispatch/scripts/lib/node-fs-ext.ts';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { sessionFixture } from './helpers/session.ts';

function useMemoryAtomicWrite(): () => void {
  const writeAtomic = nodeLinkFs.writeAtomic;
  nodeLinkFs.writeAtomic = (file, text) => fs.writeFileSync(file, text);
  return () => { nodeLinkFs.writeAtomic = writeAtomic; };
}

describe('toolkit CLI rulings contract', () => {
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
