import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CLEAN, fixture } from '../helpers/e2e.ts';
test('review code --fix disputes an unsupported claim, carries rejection, then verifies accepted fix', async () => {
  const finding = { severity: 'MUST', locus: 'src/a.ts:L1', tag: 'correctness', defect: 'Value is incorrect', requiredChange: 'Set value to 3' };
  const f = fixture({ responses: [{ status: 'FINDINGS', findings: [finding] }, { status: 'FINDINGS', findings: [finding] }, CLEAN] });
  try {
    const session = await f.initialize(); fs.writeFileSync(path.join(f.repo, 'src/a.ts'), 'export const value = 2;\n');
    let frame = await f.begin('review', session, '', ['--kind', 'code', '--fix']); const run = f.absoluteRun(frame.run);
    assert.equal(frame.await, 'rule', JSON.stringify(frame));
    frame = await f.reply(run, { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'reject', reason: 'Insufficient evidence; show the required value.' } } });
    assert.equal(frame.await, 'rule', JSON.stringify(frame)); assert.ok(f.launches()[1]?.prompt.includes('Insufficient evidence'), JSON.stringify(f.launches()));
    const findings = frame.data['findings'] as { id: string }[];
    frame = await f.reply(run, { type: 'RULINGS', rulings: Object.fromEntries(findings.map((row) => [row.id, { ruling: 'accept', fix: { paths: ['src/a.ts'], dependencies: [], verification: ['node -e "process.exit(0)"'] } }])) });
    assert.equal(frame.await, 'fix', JSON.stringify(frame)); fs.writeFileSync(path.join(f.repo, 'src/a.ts'), 'export const value = 3;\n');
    const clusters = frame.data['clusters'] as { clusterId: string }[];
    frame = await f.reply(run, { type: 'FIXES_APPLIED', clusters: clusters.map((row) => ({ clusterId: row.clusterId })) });
    assert.equal(frame.await, 'done', JSON.stringify(frame)); assert.equal(frame.data['outcome'], 'complete');
    assert.ok(f.launches().length >= 2); assert.match(fs.readFileSync(path.join(frame.run, 'events.jsonl'), 'utf8'), /VERIFY_DONE/);
    fs.rmSync(String(frame.data['handoff']), { recursive: true, force: true });
  } finally { f.cleanup(); }
});
