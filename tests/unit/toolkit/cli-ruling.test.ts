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

// SECTION: Severity corrections through the CLI

type Seeded = {id: string; severity: string; impact?: string; trigger?: string};
function correctionHarness() {
  const f = sessionFixture({memory: true});
  const restoreAtomicWrite = useMemoryAtomicWrite();
  let keyCount = 0;
  const append = async (record: object) => {
    const file = path.join(f.root, 'record.json');
    fs.writeFileSync(file, JSON.stringify(record));
    f.lines.length = 0;
    const exit = await main(['ledger', 'append', file, '--session', f.session], f.deps);
    return {exit, output: f.output()};
  };
  const seed = (review: string, findings: readonly Seeded[]) => {
    const directory = path.join(f.session, '.state', 'reviews', review, 'round-1');
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(path.join(directory, 'round.json'), JSON.stringify({round: 1, generation: 1, cap: 2, roster: []}));
    fs.writeFileSync(path.join(directory, 'findings.json'), JSON.stringify({review, round: 1, findings}));
  };
  const ruling = (subject: string, data: object = {}) => append({
    kind: 'ruling', by: 'orchestrator', key: 'ruling-' + keyCount++,
    data: {subject, ruling: 'accepted', rationale: 'impact: the Verify gate surfaces this gap', ...data},
  });
  const ready = async () => {
    f.artifact('mission.spec.md', '# Mission\n');
    f.artifact('work.plan.md', '# Work\n\n## Review Findings & Resolutions\nDriver note.\n');
    await append({kind: 'bind', by: 'orchestrator', key: 'bind', data: {spec: 'mission.spec.md', plan: 'work.plan.md'}});
  };
  const stored = () => fs.readFileSync(path.join(f.session, 'ledger.jsonl'), 'utf8').trim().split(/\r?\n/).map(row => JSON.parse(row));
  return {f, append, seed, ruling, ready, stored, cleanup: () => { restoreAtomicWrite(); f.cleanup(); }};
}
const SHOULD_FINDING: Seeded = {id: 'R1-F001', severity: 'SHOULD', impact: 'degrades', trigger: 'realistic'};
const PLAN = 'plan-work.plan';

describe('severity corrections through the CLI', () => {
  test('correction recorded: plan, code-integration and tool RED findings', async () => {
    const h = correctionHarness();
    try {
      await h.ready();
      h.seed(PLAN, [SHOULD_FINDING, {...SHOULD_FINDING, id: 'R1-RED01'}]);
      h.seed('code-integration', [{id: 'R1-F001', severity: 'MUST', impact: 'blocks', trigger: 'realistic'}]);
      const raise = {impact: 'blocks', trigger: 'realistic'};
      const results = [
        await h.ruling(`review:${PLAN}:R1-F001`, raise),
        await h.ruling(`review:${PLAN}:R1-RED01`, raise),
        await h.ruling('review:code-integration:R1-F001', {impact: 'degrades', trigger: 'realistic'}),
      ];
      for (const result of results) assert.equal(result.exit, 0, result.output.summary);
      const rulings = h.stored().filter(record => record.kind === 'ruling');
      assert.deepEqual(rulings.map(record => [record.data.impact, record.data.trigger]), [['blocks', 'realistic'], ['blocks', 'realistic'], ['degrades', 'realistic']]);
    } finally { h.cleanup(); }
  });

  test('critical correction refused: an original critical', async () => {
    const h = correctionHarness();
    try {
      await h.ready();
      h.seed(PLAN, [{id: 'R1-F001', severity: 'MUST', impact: 'critical', trigger: 'contrived'}]);
      const result = await h.ruling(`review:${PLAN}:R1-F001`, {impact: 'blocks', trigger: 'contrived'});
      assert.equal(result.exit, 1);
      assert.equal(result.output.reason, 'invalid-record');
      assert.match(result.output.summary, /reject/i);
      assert.equal(h.stored().filter(record => record.kind === 'ruling').length, 0);
    } finally { h.cleanup(); }
  });

  test('critical correction refused: one reached by correction', async () => {
    const h = correctionHarness();
    try {
      await h.ready();
      h.seed(PLAN, [SHOULD_FINDING]);
      const raised = await h.ruling(`review:${PLAN}:R1-F001`, {impact: 'critical', trigger: 'realistic', rationale: 'impact: the defect leaks credentials across the trust boundary'});
      assert.equal(raised.exit, 0, raised.output.summary);
      const lowered = await h.ruling(`review:${PLAN}:R1-F001`, {impact: 'blocks', trigger: 'realistic', rationale: 'impact: the leak needs a second fault'});
      assert.equal(lowered.exit, 1);
      assert.match(lowered.output.summary, /reject/i);
    } finally { h.cleanup(); }
  });

  test('correction refused: a missing stored finding', async () => {
    const h = correctionHarness();
    try {
      await h.ready();
      const absent = await h.ruling(`review:${PLAN}:R1-F001`, {impact: 'blocks', trigger: 'realistic'});
      assert.equal(absent.exit, 1);
      assert.equal(absent.output.reason, 'invalid-record');
      h.seed(PLAN, [SHOULD_FINDING]);
      const unknownId = await h.ruling(`review:${PLAN}:R1-F009`, {impact: 'blocks', trigger: 'realistic'});
      assert.equal(unknownId.exit, 1);
      fs.writeFileSync(path.join(h.f.session, '.state', 'reviews', PLAN, 'round-1', 'findings.json'), '{broken');
      const unreadable = await h.ruling(`review:${PLAN}:R1-F001`, {impact: 'blocks', trigger: 'realistic'});
      assert.equal(unreadable.exit, 1);
      assert.equal(unreadable.output.reason, 'invalid-record');
    } finally { h.cleanup(); }
  });

  test('correction refused: a finding with no stored impact', async () => {
    const h = correctionHarness();
    try {
      await h.ready();
      h.seed(PLAN, [{id: 'R1-F001', severity: 'MUST'}]);
      const result = await h.ruling(`review:${PLAN}:R1-F001`, {impact: 'degrades', trigger: 'realistic'});
      assert.equal(result.exit, 1);
      assert.equal(result.output.reason, 'invalid-record');
      assert.match(result.output.summary, /impact/);
    } finally { h.cleanup(); }
  });

  test('correction refused: a malformed or escaping subject', async () => {
    const h = correctionHarness();
    try {
      await h.ready();
      h.seed(PLAN, [SHOULD_FINDING]);
      const subjects = ['review:..:R1-F001', 'review:a..b:R1-F001', 'review:a/b:R1-F001', 'review:a\\b:R1-F001', `review:${PLAN}:R1-F001/x`, `review:${PLAN}:../R1-F001`, `review:${PLAN}:F001`, 'review:plan-work.plan'];
      for (const subject of subjects) {
        const result = await h.ruling(subject, {impact: 'blocks', trigger: 'realistic'});
        assert.equal(result.exit, 1, subject);
        assert.equal(result.output.reason, 'invalid-record', subject);
      }
    } finally { h.cleanup(); }
  });

  test('correction refused: an unchanged rating or a wrong-dimension rationale', async () => {
    const h = correctionHarness();
    try {
      await h.ready();
      h.seed(PLAN, [SHOULD_FINDING]);
      const subject = `review:${PLAN}:R1-F001`;
      const unchanged = await h.ruling(subject, {impact: 'degrades', trigger: 'realistic'});
      assert.equal(unchanged.exit, 1);
      assert.equal(unchanged.output.reason, 'invalid-record');
      assert.match(unchanged.output.summary, /unchanged|no change/i);
      for (const rationale of ['trigger: a contrived path', 'The gate surfaces this gap', 'impactful and serious']) {
        const result = await h.ruling(subject, {impact: 'blocks', trigger: 'realistic', rationale});
        assert.equal(result.exit, 1, rationale);
        assert.match(result.output.summary, /impact/, rationale);
      }
      const both = await h.ruling(subject, {impact: 'blocks', trigger: 'contrived', rationale: 'Impact is wider but the trigger is rare'});
      assert.equal(both.exit, 0, both.output.summary);
    } finally { h.cleanup(); }
  });

  test('correction recorded: a rationale-only ruling after a correction reads no stored finding', async () => {
    const h = correctionHarness();
    try {
      await h.ready();
      h.seed(PLAN, [SHOULD_FINDING]);
      assert.equal((await h.ruling(`review:${PLAN}:R1-F001`, {impact: 'blocks', trigger: 'realistic'})).exit, 0);
      fs.rmSync(path.join(h.f.session, '.state', 'reviews', PLAN), {recursive: true});
      const plain = await h.ruling(`review:${PLAN}:R1-F001`, {rationale: 'Applied the fix'});
      assert.equal(plain.exit, 0, plain.output.summary);
    } finally { h.cleanup(); }
  });
});
