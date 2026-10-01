import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { createPrepareReview } from '../../../skills/dispatch/scripts/effects/prepare-review.ts';
import type { Git } from '../../../skills/dispatch/scripts/effects/git.ts';
import type { Effect } from '../../../skills/dispatch/scripts/core/types.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

const effect = (ownership: unknown = { I01: ['src/a.ts'] }): Extract<Effect, { kind: 'prepare-review' }> => ({ kind: 'prepare-review', id: 'integration.prepare-review.1', round: 1, review: { kind: 'code', target: '', roster: [{ slot: 'reader' }] }, scope: { scope: 'full', integration: { baseline: 'a'.repeat(40), revision: `sha256:${'a'.repeat(64)}`, ownership } } });
test('integration rejects a non-ancestor, missing ownership and empty intersection before prompts', async () => {
  for (const [ancestor, changed, ownership] of [[false, ['src/a.ts'], { I01: ['src/a.ts'] }], [true, ['src/a.ts'], {}], [true, ['caller.ts'], { I01: ['src/a.ts'] }]] as const) {
    const ports = fakePorts(), runDir = tempDir();
    const git = { ancestor: async () => ancestor, baselineDiff: async () => [...changed] } as unknown as Git;
    const result = await createPrepareReview({ cwd: runDir, skillRoot: '', git })(effect(ownership), ports, { runDir, attempt: 1 });
    assert.equal(result[0]?.type, 'EFFECT_FAILED');
    assert.deepEqual(ports.fs.listFiles(runDir), []);
  }
});
test('first integration prompt explicitly bounds baseline and owned diff while excluding caller paths', async () => {
  const ports = fakePorts(), runDir = tempDir();
  const git = { ancestor: async () => true, baselineDiff: async () => ['caller.ts', 'src/a.ts'] } as unknown as Git;
  const result = await createPrepareReview({ cwd: runDir, skillRoot: path.resolve('skills/dispatch'), git })(effect(), ports, { runDir, attempt: 1 });
  assert.equal(result[0]?.type, 'REVIEW_PREPARED');
  if (result[0]?.type !== 'REVIEW_PREPARED') throw new Error('prepared');
  assert.deepEqual(result[0].scope['paths'], ['src/a.ts']);
  const prompt = ports.fs.readText(result[0].promptPaths['reader']!);
  assert.match(prompt, /Review only the diff from ancestor a{40} on these paths: src\/a.ts/);
  assert.doesNotMatch(prompt, /caller.ts/);
});
