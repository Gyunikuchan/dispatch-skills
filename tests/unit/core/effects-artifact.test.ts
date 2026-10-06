import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ResultEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { writeRendered } from '../../../skills/dispatch/scripts/effects/artifacts.ts';
import { createGit } from '../../../skills/dispatch/scripts/effects/git.ts';
import { parseArtifact } from '../../../skills/dispatch/scripts/effects/parse-artifact.ts';
import { createPrepareReview } from '../../../skills/dispatch/scripts/effects/prepare-review.ts';
import { createWriteBrief } from '../../../skills/dispatch/scripts/effects/write-brief.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../skills/dispatch');
const only = (events: readonly ResultEvent[]) => { assert.equal(events.length, 1); return events[0] as ResultEvent; };
const gitWith = (names: string) => createGit({ run: async (args) => (args[0] === 'rev-parse' ? '/repo\n' : args[0] === 'diff' ? names : '') });

test('parse-artifact: hash excludes the resolution section, defects are listed, a missing file is EFFECT_FAILED io', async () => {
  const dir = tempDir();
  const a = path.join(dir, 'a.plan.md');
  const b = path.join(dir, 'b.plan.md');
  fs.writeFileSync(a, '# Plan\n\nBody text.\n');
  fs.writeFileSync(b, '# Plan\n\nBody text.\n\n## Review Findings & Resolutions\n\n- R1-F001 fixed\n');
  const ctx = { runDir: dir, attempt: 1 };
  const first = only(await parseArtifact({ kind: 'parse-artifact', id: 'e.1', path: a, artifact: 'plan' }, fakePorts(), ctx));
  const second = only(await parseArtifact({ kind: 'parse-artifact', id: 'e.2', path: b, artifact: 'plan' }, fakePorts(), ctx));
  assert.ok(first.type === 'ARTIFACT_PARSED' && second.type === 'ARTIFACT_PARSED');
  assert.equal(first.hash, second.hash);
  assert.match(first.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.kind, 'plan');
  assert.ok(first.defects.length > 0);
  const missing = only(await parseArtifact({ kind: 'parse-artifact', id: 'e.3', path: path.join(dir, 'nope.plan.md'), artifact: 'plan' }, fakePorts(), ctx));
  assert.deepEqual(missing.type === 'EFFECT_FAILED' && missing.cls, 'io');
});

test('effect folder: prepare-review writes one prompt per slot, carried rejections ride their affinity slot; an empty code diff is an empty scope', async () => {
  const runDir = tempDir();
  const roster = [{ slot: 'codex[0]', provider: 'codex', index: 0, native: false, reserve: false }, { slot: 'agy[0]', provider: 'agy', index: 0, native: false, reserve: false }];
  const review = { kind: 'code', mode: 'report', target: 'main..HEAD', cap: 2, breadth: 2, context: 'check the lock', roster, timeoutMs: 1000 };
  const carried = [{ id: 'R1-F001', slot: 'agy[0]', locus: 'src/a.ts:L3', defect: 'null deref', reason: 'guarded upstream' }];
  const handler = createPrepareReview({ skillRoot: SKILL_ROOT, cwd: '/repo', git: gitWith('src/a.ts\n') });
  const result = only(await handler({ kind: 'prepare-review', id: 'review.prepare-review.2', review, round: 2, scope: { scope: 'disputes-only', carried } }, fakePorts(), { runDir, attempt: 1 }));
  assert.ok(result.type === 'REVIEW_PREPARED');
  assert.deepEqual(Object.keys(result.promptPaths), ['codex[0]', 'agy[0]']);
  assert.equal(path.basename(result.promptPaths['agy[0]'] ?? ''), 'agy-0.prompt.md');
  // Effect folder: each slot's prompt and the scope manifest sit together under the effect id.
  for (const file of [...Object.values(result.promptPaths), String(result.scope['manifestPath'])]) assert.equal(path.dirname(file), path.join(runDir, 'review.prepare-review.2'));
  const agy = fs.readFileSync(result.promptPaths['agy[0]'] ?? '', 'utf8');
  const codex = fs.readFileSync(result.promptPaths['codex[0]'] ?? '', 'utf8');
  assert.match(agy, /R1-F001 src\/a\.ts:L3: null deref — orchestrator rejection: guarded upstream/);
  assert.doesNotMatch(codex, /R1-F001/);
  assert.match(codex, /check the lock/);
  assert.deepEqual(result.scope['paths'], ['src/a.ts']);
  const empty = only(await createPrepareReview({ skillRoot: SKILL_ROOT, cwd: '/repo', git: gitWith('') })(
    { kind: 'prepare-review', id: 'review.prepare-review.1', review, round: 1, scope: { scope: 'full', carried: [] } }, fakePorts(), { runDir, attempt: 1 }));
  assert.deepEqual(empty.type === 'REVIEW_PREPARED' && [empty.scope['empty'], empty.promptPaths], [true, {}]);
});

test('prepare-review: ask builds a bounded inline prompt', async () => {
  const runDir = tempDir();
  const review = { kind: 'ask', target: 'Where is the lock released?', breadth: 1, context: '', roster: [{ slot: 'codex[0]' }], timeoutMs: 1 };
  const result = only(await createPrepareReview({ skillRoot: SKILL_ROOT, cwd: '/repo', git: gitWith('') })(
    { kind: 'prepare-review', id: 'ask.prepare-review.1', review, round: 1, scope: { scope: 'full', carried: [] } }, fakePorts(), { runDir, attempt: 1 }));
  const text = result.type === 'REVIEW_PREPARED' ? fs.readFileSync(result.promptPaths['codex[0]'] ?? '', 'utf8') : '';
  for (const heading of ['### Objective', '### Evidence', '### Stop condition', '### Output']) assert.ok(text.includes(heading), heading);
});

test('write-brief: brief written with its sha256 and the envelope path', async () => {
  const runDir = tempDir();
  const result = only(await createWriteBrief({ skillRoot: SKILL_ROOT })({ kind: 'write-brief', id: 'implement.write-brief.1', stage: 'task', input: {} }, fakePorts(), { runDir, attempt: 1 }));
  assert.ok(result.type === 'BRIEF_READY');
  const text = fs.readFileSync(result.path, 'utf8');
  assert.equal(result.sha256, `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`);
  assert.equal(result.stage, 'task');
  assert.ok(text.includes(result.envelopePath));
  assert.equal(fs.existsSync(result.envelopePath), false);
});

test('writeRendered skips identical content and overwrites changes', () => {
  const file = path.join(tempDir(), 'x.md');
  const ports = fakePorts();
  assert.equal(writeRendered(ports, file, 'a'), true);
  assert.equal(writeRendered(ports, file, 'a'), false);
  assert.equal(writeRendered(ports, file, 'b'), true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'b');
});

test('prepare-review and write-brief: a write failure is one EFFECT_FAILED io', async () => {
  const ports = fakePorts();
  ports.fs = { ...ports.fs, writeAtomic: () => { throw new Error('disk full'); } };
  const ctx = { runDir: tempDir(), attempt: 1 };
  const review = { kind: 'ask', target: 'q', breadth: 1, context: '', roster: [{ slot: 'codex[0]' }], timeoutMs: 1 };
  const prep = only(await createPrepareReview({ skillRoot: SKILL_ROOT, cwd: '/repo', git: gitWith('') })(
    { kind: 'prepare-review', id: 'ask.prepare-review.1', review, round: 1, scope: { scope: 'full', carried: [] } }, ports, ctx));
  const brief = only(await createWriteBrief({ skillRoot: SKILL_ROOT })({ kind: 'write-brief', id: 'implement.write-brief.1', stage: 'task', input: {} }, ports, ctx));
  for (const result of [prep, brief]) assert.ok(result.type === 'EFFECT_FAILED' && result.cls === 'io' && /disk full/.test(result.detail));
});
