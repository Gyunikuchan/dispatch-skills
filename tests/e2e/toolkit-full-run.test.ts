import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, CLEAN } from '../helpers/e2e.ts';
import { planSource } from './helpers/toolkit-repo.ts';

test('squash completion through public entry preserves standalone review', async () => {
  const f = fixture({ responses: [CLEAN, CLEAN, CLEAN] });
  try {
    for (const key of ['cli', 'begin', 'reply', 'rebind', 'initialize']) assert.equal(Object.keys(f).includes(key), false, key);
    const plan = planSource.replaceAll('src/file.ts', 'src/a.ts').replace('node -e "process.exit(0)"', `node -e "require('assert').match(require('fs').readFileSync('src/a.ts','utf8'),/value = 2/)"`);
    fs.writeFileSync(path.join(f.repo, 'work.plan.md'), plan);
    f.git('add', 'work.plan.md'); f.git('commit', '-qm', 'plan');
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
    await tool(['verify', 'run']);
    assert.deepEqual((await review(['integration', '--kind', 'code'])).findings, []);

    const delivered=await tool(['worktree', 'deliver']);assert.equal(typeof delivered.source,'string');assert.notEqual(delivered.source,delivered.to);assert.equal(f.git('rev-parse',delivered.to+'^{tree}').trim(),f.git('rev-parse',delivered.source+'^{tree}').trim());assert.equal(f.git('rev-parse','HEAD').trim(),delivered.to);assert.equal(f.git('rev-parse','HEAD^').trim(),delivered.from);
    const report = await tool(['report', 'complete']);
    assert.match(fs.readFileSync(path.resolve(session, report.path), 'utf8'), /Verified[\s\S]*SC1/);
    await tool(['worktree', 'cleanup']);
    assert.equal(fs.existsSync(path.resolve(session, writer.path)), false);
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/a.ts'), 'utf8'), 'export const value = 2;\n');
    assert.deepEqual((await review(['HEAD~1', '--kind', 'code', '--spec', 'governing.spec.md'])).findings, []);
    assert.equal(f.launches().length, 3);
  } finally { f.cleanup(); }
});
