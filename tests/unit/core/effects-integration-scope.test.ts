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
test('change receipt: integration prompt explicitly bounds baseline and owned diff while excluding caller paths', async () => {
  const ports = fakePorts(), runDir = tempDir();
  const git = { toplevel: async () => runDir, ancestor: async () => true, baselineDiff: async () => ['caller.ts', 'src/a.ts'] } as unknown as Git;
  const result = await createPrepareReview({ cwd: runDir, skillRoot: path.resolve('skills/dispatch'), git })(effect(), ports, { runDir, attempt: 1 });
  assert.equal(result[0]?.type, 'REVIEW_PREPARED');
  if (result[0]?.type !== 'REVIEW_PREPARED') throw new Error('prepared');
  assert.deepEqual(result[0].scope['paths'], ['src/a.ts']);
  const prompt = ports.fs.readText(result[0].promptPaths['reader']!);
  assert.match(prompt, /Review only the diff from ancestor a{40} on these paths: src\/a.ts/);
  assert.doesNotMatch(prompt, /caller.ts/);
});

test('review fix integration hash validation accepts only complete Git object ids', async () => {
  const { isCommitHash, createGit } = await import('../../../skills/dispatch/scripts/effects/git.ts');
  const { integrationScope } = await import('../../../skills/dispatch/scripts/effects/prepare-review.ts');
  for (const width of [39, 41, 48, 63, 65]) {
    const baseline = 'a'.repeat(width); assert.equal(isCommitHash(baseline), false);
    assert.throws(() => integrationScope({ baseline, revision: `sha256:${'b'.repeat(64)}`, ownership: { I01: ['src/a.ts'] } }), /recorded baseline/);
    const git = createGit({ run: async () => { throw new Error('must not query Git for malformed ids'); } });
    await assert.rejects(git.ancestor!('/repo', baseline), /concrete commit hash/);
    await assert.rejects(git.baselineDiff!('/repo', baseline), /concrete commit hash/);
  }
  for (const width of [40,64]) assert.equal(isCommitHash('a'.repeat(width)), true);
});


test('review fix brace-prefixed focus remains ordinary review context', async () => {
  const ports = fakePorts(), runDir = tempDir();
  const git = { toplevel: async () => runDir, diffNames: async () => ['src/a.ts'] } as unknown as Git;
  const request = { ...effect(), review: { ...effect().review, context: '{general} review' }, scope: { scope: 'full' } };
  const result = await createPrepareReview({ cwd: runDir, skillRoot: path.resolve('skills/dispatch'), git })(request, ports, { runDir, attempt: 1 });
  assert.equal(result[0]?.type, 'REVIEW_PREPARED');
  if (result[0]?.type !== 'REVIEW_PREPARED') throw new Error('prepared');
  assert.deepEqual(result[0].scope['paths'], ['src/a.ts']);
  assert.match(ports.fs.readText(result[0].promptPaths['reader']!)!, /\{general\} review/);
});
