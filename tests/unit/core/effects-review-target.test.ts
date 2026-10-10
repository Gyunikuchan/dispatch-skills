import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createCheckReviewTarget, reviewArtifactText } from '../../../skills/dispatch/scripts/effects/check-review-target.ts';
import type { Effect } from '../../../skills/dispatch/scripts/core/types.ts';
import type { Git, ReviewSnapshot } from '../../../skills/dispatch/scripts/effects/git.ts';
import { createGit } from '../../../skills/dispatch/scripts/effects/git.ts';
import { createPrepareReview } from '../../../skills/dispatch/scripts/effects/prepare-review.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

function artifact() {
  const cwd = tempDir(), ports = fakePorts(), target = path.join(cwd, 'target.plan.md'), manifestPath = path.join(cwd, 'prior.json');
  const source = '# Target\n\n## Goal\nRequired behavior\n';
  fs.writeFileSync(target, source); fs.writeFileSync(manifestPath, JSON.stringify({ target, text: source, hash: 'old raw hash' }));
  const handler = createCheckReviewTarget({ cwd, git: {} as Git });
  const effect: Extract<Effect, { kind: 'check-review-target' }> = { kind: 'check-review-target', id: 'review.check-review-target.1', review: { kind: 'plan', target }, manifestPath, allowedPaths: [] };
  return { cwd, ports, target, manifestPath, source, effect, run: () => handler(effect, ports, { runDir: path.join(cwd, 'run'), attempt: 1 }) };
}

test('change receipt: artifact ignores only managed sections and returns readable deltas', async () => {
  const f = artifact();
  fs.appendFileSync(f.target, '\n## Review Findings & Resolutions\nDriver result\n\n## Execution Status\nDriver state\n');
  assert.equal((await f.run())[0]?.type, 'REVIEW_TARGET_CHECKED');
  fs.appendFileSync(f.target, '\n## Acceptance\nNew requirement\n');
  const result = (await f.run())[0]; assert.equal(result?.type, 'REVIEW_TARGET_CHECKED'); assert.equal(result?.type === 'REVIEW_TARGET_CHECKED' && result.result, 'changed');
});

test('review-target preserves repeated headings and fenced managed-section text', () => {
  const source = '# Target\n\n## Goal\nFirst\n\n## Goal\nSecond\n\n```md\n## Review Findings & Resolutions\nRequired text\n```\n';
  assert.notEqual(reviewArtifactText(source), reviewArtifactText(source.replace('First', 'Changed')));
  assert.match(reviewArtifactText(source), /Required text/);
});

test('change receipt: artifact captures an allowed fix and parks verification edits', async () => {
  const f = artifact(); f.effect.allowedPaths = [f.target];
  fs.writeFileSync(f.target, f.source.replace('Required', 'Repaired'));
  const captured = (await f.run())[0]; assert.equal(captured?.type, 'REVIEW_TARGET_CHECKED');
  if (captured?.type !== 'REVIEW_TARGET_CHECKED') return;
  f.effect.manifestPath = captured.manifestPath; f.effect.allowedPaths = [];
  assert.equal((await f.run())[0]?.type, 'REVIEW_TARGET_CHECKED');
  fs.appendFileSync(f.target, '\nExternal edit\n'); const result = (await f.run())[0]; assert.equal(result?.type === 'REVIEW_TARGET_CHECKED' && result.result, 'changed');
});

for (const malformed of [null, '{}', '{bad']) test(`review-target fails closed on missing or malformed binding ${malformed}`, async () => {
  const f = artifact(); if (malformed === null) fs.rmSync(f.manifestPath); else fs.writeFileSync(f.manifestPath, malformed);
  const result = (await f.run())[0]; assert.equal(result?.type, 'EFFECT_FAILED');
  assert.match(result?.type === 'EFFECT_FAILED' ? result.detail : '', /target-changed/);
});

test('review-target code permits fix paths but refuses outside index worktree and ref drift', async () => {
  const cwd = tempDir(), ports = fakePorts(), manifestPath = path.join(cwd, 'prior.json');
  const prior: ReviewSnapshot = { head: 'head', target: '', comparison: 'head', index: { 'src/a.ts': 'index' }, working: { 'src/a.ts': 'before' }, untracked: {} };
  fs.writeFileSync(manifestPath, JSON.stringify(prior));
  let current = structuredClone(prior);
  const git = { toplevel: async () => cwd, reviewSnapshot: async () => current, reviewDelta: async (_cwd: string, baseline: ReviewSnapshot) => {
    const paths = [...new Set([...Object.keys(baseline.working), ...Object.keys(current.working), ...Object.keys(baseline.index), ...Object.keys(current.index), ...Object.keys(current.untracked)])].filter((file) => baseline.working[file] !== current.working[file] || baseline.index[file] !== current.index[file] || baseline.untracked[file] !== current.untracked[file]);
    return { staged: [], unstaged: [], untracked: [], deleted: [], paths };
  } } as unknown as Git;
  const handler = createCheckReviewTarget({ cwd, git });
  const effect: Extract<Effect, { kind: 'check-review-target' }> = { kind: 'check-review-target', id: 'review.check-review-target.1', review: { kind: 'code', target: '' }, manifestPath, allowedPaths: ['src/a.ts'] };
  const run = () => handler(effect, ports, { runDir: path.join(cwd, 'run'), attempt: 1 });
  current.working['src/a.ts'] = 'fix'; assert.equal((await run())[0]?.type, 'REVIEW_TARGET_CHECKED');
  current.untracked['src/new.ts'] = 'external'; const external = (await run())[0]; assert.equal(external?.type === 'REVIEW_TARGET_CHECKED' && external.result, 'changed', JSON.stringify(external));
  current = structuredClone(prior); current.index['src/b.ts'] = 'staged external'; const staged = (await run())[0]; assert.equal(staged?.type === 'REVIEW_TARGET_CHECKED' && staged.result, 'changed');
  current = structuredClone(prior); current.head = 'new head'; const moved = (await run())[0]; assert.equal(moved?.type === 'REVIEW_TARGET_CHECKED' && moved.result, 'changed');
  current = structuredClone(prior); fs.writeFileSync(manifestPath, JSON.stringify({ ...prior, index: [] }));
  assert.equal((await run())[0]?.type, 'EFFECT_FAILED');
});

test('review-target bounds content capture and detects new paths and clean-file index drift', async () => {
  const cwd = tempDir(), ports = fakePorts(), runDir = path.join(cwd, 'run');
  const reads: string[] = []; let names = ['src/a.ts'], indexBlob = 'b'.repeat(40);
  const git = createGit({ run: async (args) => {
    if (args[0] === 'rev-parse') return args[1] === '--show-toplevel' ? cwd : 'a'.repeat(40);
    if (args[0] === 'diff') return args.includes('--diff-filter=D') ? '' : names.join('\n');
    if (args[0] === 'ls-files') {
      if (args.includes('--stage')) return `100644 ${'a'.repeat(40)} 0\tsrc/a.ts\0` + `100644 ${indexBlob} 0\tunrelated.bin\0`;
      if (args.includes('--others')) return names.includes('src/new.ts') ? 'src/new.ts\0' : '';
      return 'src/a.ts\0unrelated.bin\0';
    }
    return '';
  }, fileContent: (file) => { reads.push(file); return file === 'unrelated.bin' ? 'x'.repeat(9 * 1024 * 1024) : 'source'; } });
  const prepared = (await createPrepareReview({ cwd, git, skillRoot: path.resolve('skills/dispatch') })({ kind: 'prepare-review', id: 'review.prepare-review.1', review: { kind: 'code', target: '', roster: [{ slot: 'codex[0]' }] }, round: 1, scope: { scope: 'full' } }, ports, { runDir, attempt: 1 }))[0];
  assert.equal(prepared?.type, 'REVIEW_PREPARED', JSON.stringify(prepared)); if (prepared?.type !== 'REVIEW_PREPARED') return;
  assert.ok(!reads.includes('unrelated.bin'));
  const effect: Extract<Effect, { kind: 'check-review-target' }> = { kind: 'check-review-target', id: 'review.check-review-target.1', review: { kind: 'code', target: '' }, manifestPath: String(prepared.scope['bindingPath']), allowedPaths: [] };
  const handler = createCheckReviewTarget({ cwd, git });
  const check = () => handler(effect, ports, { runDir, attempt: 1 });
  assert.equal((await check())[0]?.type, 'REVIEW_TARGET_CHECKED');
  names = ['src/a.ts', 'src/new.ts']; const added = (await check())[0]; assert.equal(added?.type === 'REVIEW_TARGET_CHECKED' && added.result, 'changed', JSON.stringify(added));
  names = ['src/a.ts']; indexBlob = 'c'.repeat(40);
  const drift = (await check())[0]; assert.ok(drift?.type === 'REVIEW_TARGET_CHECKED' && drift.notice?.paths.includes('unrelated.bin'));
});

test('session files stay out of code review scope', async () => {
  const root = tempDir(), sessionDir = path.join(root, '.scratch', 'ws', 'session-a');
  const git = createGit({ run: async (args) => (args[0] === 'rev-parse' ? `${root}\n` : args[0] === 'diff' && !args.includes('--diff-filter=D') ? 'src/a.ts\0.scratch/ws/session-a/x.plan.md\0.scratch/ws/session-b/y.spec.md\0' : '') });
  const review = { kind: 'code', target: 'main..HEAD', roster: [{ slot: 'codex[0]' }], sessionDir };
  const result = (await createPrepareReview({ cwd: root, git, skillRoot: path.resolve('skills/dispatch') })({ kind: 'prepare-review', id: 'review.prepare-review.1', review, round: 1, scope: { scope: 'full' } }, fakePorts(), { runDir: path.join(sessionDir, '.state', 'runs', '001-review'), attempt: 1 }))[0];
  assert.ok(result?.type === 'REVIEW_PREPARED', JSON.stringify(result));
  assert.deepEqual(result.scope['paths'], ['src/a.ts']);
  assert.doesNotMatch(fs.readFileSync(result.promptPaths['codex[0]'] ?? '', 'utf8'), /\.scratch\/ws\//);
  const binding = JSON.parse(fs.readFileSync(String(result.scope['bindingPath']), 'utf8')) as { changeSet: string[] };
  assert.deepEqual(binding.changeSet, ['src/a.ts']);
});

test('session files stay out of target checks', async () => {
  const root = tempDir(), sessionDir = path.join(root, '.scratch', 'ws', 'session-a'), manifestPath = path.join(root, 'prior.json');
  const prior: ReviewSnapshot = { head: 'head', target: '', comparison: 'head', index: {}, working: { 'src/a.ts': 'same' }, untracked: {}, governedPaths: ['src/a.ts'] };
  fs.writeFileSync(manifestPath, JSON.stringify({ ...prior, changeSet: ['src/a.ts'] }));
  const notes = '.scratch/ws/session-a/notes.md';
  const git = { toplevel: async () => root, diffNames: async () => ['src/a.ts', notes],
    reviewSnapshot: async () => ({ ...prior, untracked: { [notes]: 'new' } }),
    reviewDelta: async () => ({ paths: [notes], staged: [], unstaged: [], untracked: [notes], deleted: [] }) } as unknown as Git;
  const effect: Extract<Effect, { kind: 'check-review-target' }> = { kind: 'check-review-target', id: 'review.check-review-target.1', review: { kind: 'code', target: '', sessionDir }, manifestPath, allowedPaths: [] };
  const result = (await createCheckReviewTarget({ cwd: root, git })(effect, fakePorts(), { runDir: path.join(sessionDir, '.state', 'runs', '001-review'), attempt: 1 }))[0];
  assert.equal(result?.type === 'REVIEW_TARGET_CHECKED' && result.result, 'unchanged', JSON.stringify(result));
});

test('review-target accepts absolute fix paths when invoked in a repository subdirectory', async () => {
  const root = tempDir(), cwd = path.join(root, 'sub'), ports = fakePorts(), manifestPath = path.join(root, 'prior.json');
  const prior: ReviewSnapshot = { head: 'head', target: '', comparison: 'head', index: {}, working: { 'src/a.ts': 'before' }, untracked: {} };
  fs.writeFileSync(manifestPath, JSON.stringify(prior));
  const git = { toplevel: async () => root, reviewSnapshot: async () => ({ ...prior, working: { 'src/a.ts': 'fixed' } }), reviewDelta: async () => ({ paths: ['src/a.ts'], staged: [], unstaged: [], untracked: [], deleted: [] }) } as unknown as Git;
  const result = (await createCheckReviewTarget({ cwd, git })({ kind: 'check-review-target', id: 'review.check-review-target.1', review: { kind: 'code', target: '' }, manifestPath, allowedPaths: [path.join(root, 'src/a.ts')] }, ports, { runDir: path.join(root, 'run'), attempt: 1 }))[0];
  assert.equal(result?.type, 'REVIEW_TARGET_CHECKED', JSON.stringify(result));
});

function regeneratedManifest(valid: boolean, index: { staged?: string[]; deleted?: string[] } = {}, metadata: Record<string, string> = {}) {
  const root = tempDir(), manifestPath = path.join(root, 'prior.json'), script = 'skill/scripts/a.ts', manifest = 'skill/skill-hashes.json';
  fs.mkdirSync(path.join(root, 'skill', 'scripts'), { recursive: true }); fs.writeFileSync(path.join(root, 'skill', 'SKILL.md'), 'skill'); fs.writeFileSync(path.join(root, script), 'fixed');
  const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
  fs.writeFileSync(path.join(root, manifest), JSON.stringify({ ...metadata, 'SKILL.md': sha('skill'), 'scripts/a.ts': sha(valid ? 'fixed' : 'before') }));
  const prior: ReviewSnapshot = { head: 'head', target: '', comparison: 'head', index: {}, working: { [script]: 'before', [manifest]: 'old' }, untracked: {} };
  fs.writeFileSync(manifestPath, JSON.stringify(prior));
  const git = { toplevel: async () => root, reviewSnapshot: async () => ({ ...prior, working: { [script]: 'fixed', [manifest]: 'new' } }), reviewDelta: async () => ({ paths: [script, manifest], staged: index.staged ?? [], unstaged: [script, manifest], untracked: [], deleted: index.deleted ?? [] }) } as unknown as Git;
  return createCheckReviewTarget({ cwd: root, git })({ kind: 'check-review-target', id: 'review.check-review-target.1', review: { kind: 'code', target: '' }, manifestPath, allowedPaths: [script] }, fakePorts(), { runDir: path.join(root, 'run'), attempt: 1 });
}

test('review-target admits a verified regenerated hash manifest for a ruled skill path', async () => {
  const result = (await regeneratedManifest(true))[0];
  assert.equal(result?.type === 'REVIEW_TARGET_CHECKED' && result.result, 'expected', JSON.stringify(result));
});

test('review-target admits a verified hash manifest carrying $version metadata', async () => {
  const result = (await regeneratedManifest(true, {}, { $version: '0.7.0' }))[0];
  assert.equal(result?.type === 'REVIEW_TARGET_CHECKED' && result.result, 'expected', JSON.stringify(result));
});

test('review-target keeps an invalid regenerated hash manifest as drift', async () => {
  const result = (await regeneratedManifest(false))[0];
  assert.ok(result?.type === 'REVIEW_TARGET_CHECKED' && result.result === 'changed' && result.notice?.paths.includes('skill/skill-hashes.json'), JSON.stringify(result));
});

test('review-target keeps a staged hash manifest as drift despite a valid working-tree copy', async () => {
  const result = (await regeneratedManifest(true, { staged: ['skill/skill-hashes.json'] }))[0];
  assert.ok(result?.type === 'REVIEW_TARGET_CHECKED' && result.result === 'changed' && result.notice?.paths.includes('skill/skill-hashes.json'), JSON.stringify(result));
});

test('review-target keeps a staged hash manifest deletion as drift despite a valid working-tree copy', async () => {
  const result = (await regeneratedManifest(true, { staged: ['skill/skill-hashes.json'], deleted: ['skill/skill-hashes.json'] }))[0];
  assert.ok(result?.type === 'REVIEW_TARGET_CHECKED' && result.result === 'changed' && result.notice?.paths.includes('skill/skill-hashes.json'), JSON.stringify(result));
});
