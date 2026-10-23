import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { capSummary } from '../../../skills/dispatch/scripts/toolkit/output.ts';
import { sessionFixture } from './helpers/session.ts';

test('summary byte cap includes marker and preserves multibyte code points', () => {
  for (const text of ['a'.repeat(2000), 'a'.repeat(1020) + '😀'.repeat(300), '界'.repeat(500)]) {
    const summary = capSummary(text);
    assert.ok(Buffer.byteLength(summary) <= 1024);
    assert.ok(summary.endsWith('…'));
    assert.equal(Buffer.from(summary).toString('utf8'), summary);
    assert.ok(text.startsWith(summary.slice(0, -1)));
  }
});

test('summary byte cap applies to every tool with full result files including refusals', async () => {
  const f = sessionFixture();
  try {
    const records: unknown[] = Array.from({ length: 500 }, (_, i) => ({ seq: i + 1, key: 'n' + i, at: 'now', kind: 'note', by: 'tool', data: { text: '界'.repeat(600) } }));
    records.push(...Array.from({ length: 100 }, (_, i) => ({ seq: 501 + i, key: 'e' + i, at: 'now', kind: 'escalation', by: 'tool', data: { id: 'e' + i, state: 'open', summary: 'pending' } })));
    fs.writeFileSync(path.join(f.session, 'ledger.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
    const input = f.artifact('record.json', JSON.stringify({ kind: 'note', key: 'append', by: 'tool', data: { text: '界'.repeat(600) } }));
    const invalid = f.artifact('invalid.json', '{}');
    const plan = f.artifact('large.plan.md', '## Success Criteria\n' + Array.from({ length: 200 }, (_, i) =>
      '- [SC' + (i + 1) + '] File works\n  - Changes: src/file.ts\n  - Verify: `node check.ts`\n  - Evidence: verify\n').join('\n'));
    const skill = path.join(f.root, 'skill');
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, 'config.jsonc'), JSON.stringify(Object.fromEntries(Array.from({ length: 200 }, (_, i) => ['bad' + i, true]))));
    for (const [args, exit] of [
      [['ledger', 'append', input], 0], [['ledger', 'query'], 0], [['lint', 'run', plan], 4],
      [['doctor', 'run'], 0], [['status', 'show'], 0], [['ledger', 'append', invalid], 1],
      [['ledger', 'query', '--kind', 'unknown'], 1], [['lint', 'run', 'missing.plan.md'], 1],
    ] as const) {
      f.lines.length = 0;
      assert.equal(await main([...args, '--session', f.session], { ...f.deps, skillRoot: skill }), exit);
      const output = f.output();
      assert.ok(Buffer.byteLength(output.summary) <= 1024);
      assert.ok(fs.existsSync(output.path!));
      const result = JSON.parse(fs.readFileSync(output.path!, 'utf8'));
      if (args[0] === 'lint' && exit === 4) assert.ok(result.warnings.length >= 200);
      if (args[0] === 'doctor') assert.ok(result.config.problems.length >= 200);
      if (args[0] === 'status') assert.equal(result.escalations.length, 100);
      if (args[0] === 'ledger' && args[1] === 'query' && exit === 0) assert.equal(result.length, 601);
    }
  } finally { f.cleanup(); }
});
