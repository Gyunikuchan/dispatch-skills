import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, CLEAN } from '../helpers/e2e.ts';
import { contextMapSource, planSource } from './helpers/toolkit-repo.ts';
import { artifactHash } from '../../skills/dispatch/scripts/toolkit/artifacts.ts';
import { foldLedger } from '../../skills/dispatch/scripts/toolkit/ledger.ts';

test('uncommitted delivery through public entry preserves standalone review', async () => {
  const f = fixture({ responses: [CLEAN, CLEAN, CLEAN] });
  try {
    for (const key of ['cli', 'begin', 'reply', 'rebind', 'initialize']) assert.equal(Object.keys(f).includes(key), false, key);
    const plan = planSource
      .replaceAll('src/file.ts', 'src/a.ts')
      .replace('node -e "process.exit(0)"', `node -e "require('assert').match(require('fs').readFileSync('src/a.ts','utf8'),/value = 2/)"`)
      .replace('| T1 | File | Works | none | SC1 |', '| T1 | File | Works | none | SC1 |\n| T2 | Review | Source review is recorded | none | SC2 |')
      .replace('## Success Criteria', '### T2 — Review\n#### [NEW] docs/review.md\n- Purpose: records the review outcome.\n\n## Success Criteria')
      .replace('  - Evidence: verify\n\n## Verification Plan', '  - Evidence: verify\n- [SC2] Source review is complete\n  - Changes: docs/review.md\n  - Evidence: review\n  - Review: artifact: docs/review.md; scenario: inspect the delivered behavior; pass: the user records review evidence\n\n## Verification Plan');
    fs.writeFileSync(path.join(f.repo, 'work.plan.md'), plan);
    fs.writeFileSync(path.join(f.repo, 'work.context.md'), contextMapSource);
    f.git('add', 'work.plan.md', 'work.context.md'); f.git('commit', '-qm', 'plan');
    const run = async (args: string[], expected = 0) => {
      const result = await f.launch(args).done;
      assert.equal(result.exit, expected, result.stderr + result.stdout);
      const lines = result.stdout.trim().split(/\r?\n/);
      assert.equal(lines.length, 1);
      const output = JSON.parse(lines[0]!);
      assert.ok(output && typeof output === 'object' && !Array.isArray(output));
      assert.equal(typeof output.summary, 'string');
      assert.ok(Buffer.byteLength(output.summary, 'utf8') <= 1024);
      for (const key of ['v', 'run', 'reply', 'await', 'at']) assert.equal(Object.hasOwn(output, key), false, key);
      return output;
    };
    const session = (await run(['session', 'init', '--objective', 'Toolkit delivery', '--session-id', 'toolkit-full-run'])).path;
    const tool = async (args: string[]) => {
      const output = await run([...args, '--session', session]);
      return JSON.parse(fs.readFileSync(output.path, 'utf8'));
    };
    for (const [kind, data] of [['bind', { spec: 'governing.spec.md', plan: 'work.plan.md' }], ['level', { level: 'low' }]] as const) {
      const file = path.join(f.dir, kind + '.json');
      fs.writeFileSync(file, JSON.stringify({ kind, key: kind, by: 'orchestrator', data }));
      await tool(['ledger', 'append', file]);
    }
    const confirmFile = path.join(f.dir, 'confirm.json');
    fs.writeFileSync(confirmFile, JSON.stringify({ kind: 'confirm', key: 'confirm', by: 'user', quote: 'confirmed', data: { spec: artifactHash('spec', fs.readFileSync(path.join(f.repo, 'governing.spec.md'), 'utf8')) } }));
    await tool(['ledger', 'append', confirmFile]);
    await tool(['lint', 'run', 'work.plan.md']);
    const review = async (args: string[]) => {
      const result = await tool(['review', 'run', ...args]);
      assert.equal(result.skipped, undefined);
      return JSON.parse(fs.readFileSync(result.path, 'utf8'));
    };
    const reviewed = await review(['work.plan.md', '--kind', 'plan']);
    assert.equal(reviewed.skipped, undefined);
    assert.deepEqual(reviewed.findings, []);
    assert.equal(f.launches().length, 1, 'plan review launches the stub');
    const writer = await tool(['worktree', 'create', 'T1']);
    const brief = await tool(['brief', 'render', 'T1']);
    assert.ok(fs.readFileSync(brief.path, 'utf8').includes('src/a.ts'));
    fs.writeFileSync(path.resolve(session, writer.path, 'src/a.ts'), 'export const value = 2;\n');
    await tool(['worktree', 'submit', 'T1']);
    await tool(['worktree', 'integrate', 'T1']);
    const beforeReviewVerify = foldLedger(session).records.length;
    const reviewRefusal = await run(['verify', 'run', '--criteria', 'SC2', '--session', session], 1);
    assert.equal(reviewRefusal.reason, 'invalid-input');
    assert.match(reviewRefusal.summary, /review/i);
    assert.equal(foldLedger(session).records.length, beforeReviewVerify);
    assert.equal(fs.existsSync(path.join(session, '.state', 'evidence')), false);
    await tool(['verify', 'run']);
    const toolEvidence = foldLedger(session).records.filter(record => record.kind === 'evidence');
    assert.deepEqual(toolEvidence.map(record => record.data['criterion']), ['SC1', 'contract']);
    assert.deepEqual((await review(['integration', '--kind', 'code'])).findings, []);

    const callerHead=f.git('rev-parse','HEAD').trim();const delivered=await tool(['worktree', 'deliver']);assert.equal(typeof delivered.source,'string');assert.equal('to' in delivered,false);assert.equal(f.git('rev-parse','HEAD').trim(),callerHead);assert.equal(delivered.from,callerHead);assert.equal(fs.readFileSync(path.join(f.repo,'src/a.ts'),'utf8'),'export const value = 2;\n');
    const incomplete = await run(['report', 'complete', '--session', session], 4);
    assert.equal(incomplete.reason, 'criteria-unmet');
    const manualFile = path.join(f.dir, 'review-manual.json');
    fs.writeFileSync(manualFile, JSON.stringify({
      kind: 'manual-complete', key: 'review-manual', by: 'user', quote: 'I reviewed the delivered behavior against the scenario.',
      data: { criterion: 'SC2', evidence: 'manual/docs-review.md' },
    }));
    await tool(['ledger', 'append', manualFile]);
    const report = await tool(['report', 'complete']);
    const walkthrough = fs.readFileSync(path.resolve(session, report.path), 'utf8');
    assert.match(walkthrough, /Verified[\s\S]*SC1/);
    assert.match(walkthrough, /Manual[\s\S]*SC2/);
    await tool(['worktree', 'cleanup']);
    assert.equal(fs.existsSync(path.resolve(session, writer.path)), false);
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/a.ts'), 'utf8'), 'export const value = 2;\n');
    const retried=await tool(['worktree', 'deliver']);assert.equal(retried.delivered,false);assert.equal(retried.source,delivered.source);assert.equal(f.git('rev-parse',delivered.ref).trim(),delivered.source);
    assert.deepEqual((await review([delivered.from+'..'+delivered.ref, '--kind', 'code', '--spec', 'governing.spec.md'])).findings, []);
    assert.equal(f.launches().length, 3);
  } finally { f.cleanup(); }
});
