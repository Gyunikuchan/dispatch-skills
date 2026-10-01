import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { Effect, ResultEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { createWriteBrief } from '../../../skills/dispatch/scripts/effects/write-brief.ts';
import { createPrepareReview } from '../../../skills/dispatch/scripts/effects/prepare-review.ts';
import { createGit } from '../../../skills/dispatch/scripts/effects/git.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../skills/dispatch');
const only = (events: readonly ResultEvent[]) => { assert.equal(events.length, 1); return events[0] as ResultEvent; };

test('implement-production-brief and implement-envelope-self-check: renders bound context and exact self-check', async () => {
  const runDir = tempDir();
  const envelopePath = path.join(runDir, 'implement.write-brief.1.outcome.json');
  const input = {
    planPath: 'docs/example.plan.md', planHash: `sha256:${'a'.repeat(64)}`, governingOutcome: { title: 'Example', outcome: 'Deliver behavior' },
    settledScope: { paths: ['src/a.ts'], changes: [{ action: 'MODIFY', path: 'src/a.ts' }] }, criteria: [{ id: 'SC1', title: 'works' }],
    rules: { writerStage: 'production' }, priorFindings: [{ id: 'R1-F001' }], evidence: ['Evidence, not specification. Previous command passed.'],
    envelopeSchema: { schemaVersion: 1, stage: 'COMPLETE', evidence: 'CRITERION format' }, selfCheck: 'dispatch send --dry-run <Expected Envelope Path>',
  };
  const result = only(await createWriteBrief({ skillRoot: SKILL_ROOT })({ kind: 'write-brief', id: 'implement.write-brief.1', stage: 'production', input }, fakePorts(), { runDir, attempt: 1 }));
  assert.equal(result.type, 'BRIEF_READY');
  if (result.type !== 'BRIEF_READY') return;
  const text = fs.readFileSync(result.path, 'utf8');
  assert.ok(text.includes('docs/example.plan.md'));
  assert.ok(text.includes(input.planHash));
  assert.ok(text.includes('src/a.ts'));
  assert.ok(text.includes('Prior review findings'));
  assert.ok(text.includes('Evidence, not specification.'));
  assert.ok(text.includes('Envelope schema'));
  assert.ok(text.includes(`dispatch send --dry-run ${envelopePath}`));
  assert.equal(result.sha256, `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`);
  assert.equal(result.envelopePath, envelopePath);
  assert.equal(fs.existsSync(envelopePath), false);
});

test('hotfix template renders concrete limits, single-shot identity, external reasons and pre-RED restriction; retry carries root cause', async () => {
  const runDir = tempDir(), ports = fakePorts();
  const input = { rootCause: 'wrong mapping', stalledCheck: { command: 'check', logPath: 'failed.log', failureId: 'f1' }, hotfix: { maxFiles: 10, maxLines: 150, singleShot: true, model: 'writer-a', external: [{ path: 'env.txt', reason: 'repair environment' }], preRed: true, paths: ['tests/a.test.ts'] } };
  const event = only(await createWriteBrief({ skillRoot: SKILL_ROOT })({ kind: 'write-brief', id: 'implement.write-brief.2', stage: 'hotfix', input }, ports, { runDir, attempt: 1 }));
  assert.equal(event.type, 'BRIEF_READY'); if (event.type !== 'BRIEF_READY') return;
  const text = fs.readFileSync(event.path, 'utf8');
  for (const value of ['single-shot hot fix', 'wrong mapping', 'failed.log', '10', '150', 'writer-a', 'repair environment', 'Before RED validates', 'tests/a.test.ts']) assert.ok(text.includes(value), value);
  const retry = only(await createWriteBrief({ skillRoot: SKILL_ROOT })({ kind: 'write-brief', id: 'implement.write-brief.3', stage: 'production', input: { retryContext: { rootCause: 'wrong branch', failure: 'failed check identity f1' } } }, ports, { runDir, attempt: 1 }));
  assert.equal(retry.type, 'BRIEF_READY'); if (retry.type === 'BRIEF_READY') assert.match(fs.readFileSync(retry.path, 'utf8'), /wrong branch[\s\S]*failed check identity f1/);
});

test('prepare-review-git-log: extracts commit messages and falls back on error or empty', async () => {
  const tmp = tempDir();
  const runDir = tempDir();
  const ports = fakePorts();
  let logResult = 'feat: commit title\n\ncommit description';
  let logCalledWith: string | null = null;
  const git = {
    ...createGit({ run: async () => '' }),
    diffNames: async () => ['src/a.ts'],
    log: async (_cwd: string, range: string) => {
      logCalledWith = range;
      if (range === 'error..range') throw new Error('git log failed');
      return logResult;
    },
  };
  const handler = createPrepareReview({ cwd: tmp, skillRoot: SKILL_ROOT, git });

  // 1. Extracts commit messages for commit range without context
  const [res1] = await handler({
    kind: 'prepare-review', id: 'p1', round: 1,
    review: { kind: 'code', target: 'main..HEAD', roster: [{ slot: 'codex[0]' }], context: null },
    scope: { scope: 'full' },
  }, ports, { runDir, attempt: 1 });
  assert.equal(res1?.type, 'REVIEW_PREPARED');
  const prompt1 = ports.fs.readText(res1?.promptPaths['codex[0]']!);
  assert.match(prompt1, /- Task: feat: commit title\n\ncommit description/);
  assert.equal(logCalledWith, 'main..HEAD');

  // 2. Explicit context bypasses git log
  logCalledWith = null;
  const [res2] = await handler({
    kind: 'prepare-review', id: 'p2', round: 1,
    review: { kind: 'code', target: 'main..HEAD', roster: [{ slot: 'codex[0]' }], context: 'Explicit intent' },
    scope: { scope: 'full' },
  }, ports, { runDir, attempt: 1 });
  assert.equal(res2?.type, 'REVIEW_PREPARED');
  const prompt2 = ports.fs.readText(res2?.promptPaths['codex[0]']!);
  assert.match(prompt2, /- Task: Explicit intent/);
  assert.equal(logCalledWith, null);

  // 3. Empty log falls back to default
  logResult = '';
  const [res3] = await handler({
    kind: 'prepare-review', id: 'p3', round: 1,
    review: { kind: 'code', target: 'main..HEAD', roster: [{ slot: 'codex[0]' }], context: null },
    scope: { scope: 'full' },
  }, ports, { runDir, attempt: 1 });
  assert.equal(res3?.type, 'REVIEW_PREPARED');
  const prompt3 = ports.fs.readText(res3?.promptPaths['codex[0]']!);
  assert.match(prompt3, /- Task: Review the selected changes\./);

  // 4. Git error falls back to default
  const [res4] = await handler({
    kind: 'prepare-review', id: 'p4', round: 1,
    review: { kind: 'code', target: 'error..range', roster: [{ slot: 'codex[0]' }], context: null },
    scope: { scope: 'full' },
  }, ports, { runDir, attempt: 1 });
  assert.equal(res4?.type, 'REVIEW_PREPARED');
  const prompt4 = ports.fs.readText(res4?.promptPaths['codex[0]']!);
  assert.match(prompt4, /- Task: Review the selected changes\./);
});

