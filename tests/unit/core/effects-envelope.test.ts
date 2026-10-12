import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createHandlers } from '../../../skills/dispatch/scripts/effects/index.ts';
import path from 'node:path';
import { test } from 'node:test';
import type { Effect, ResultEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import type { Git } from '../../../skills/dispatch/scripts/effects/git.ts';
import { createCheckEnvelope } from '../../../skills/dispatch/scripts/effects/check-envelope.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

function resultOf(events: readonly ResultEvent[]) { assert.equal(events.length, 1); return events[0] as ResultEvent; }
function setup(changed: string[]) {
  const cwd = tempDir();
  const runDir = path.join(cwd, 'run');
  fs.mkdirSync(runDir);
  const git: Git = { toplevel: async () => cwd, indexEntries: async () => '', diffNames: async () => changed, fingerprint: async () => ({ head: 'h', index: 'i', worktree: 'w' }), changedSince: async () => changed, log: async () => '' };
  return { cwd, runDir, handler: createCheckEnvelope({ cwd, git }), ports: fakePorts() };
}
const complete = { schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'Implemented.', evidence: ['CRITERION SC1 | src/a.ts | handles the valid input'] };
const check = (envelopePath: string, permitted: string[]): Extract<Effect, { kind: 'check-envelope' }> => ({ kind: 'check-envelope', id: 'implement.check-envelope.1', envelopePath, permitted });

test('implement-envelope-self-check parses a strict receipt and accepts only approved changed paths', async () => {
  const { runDir, handler, ports } = setup(['src/a.ts']);
  const file = path.join(runDir, 'outcome.json');
  fs.writeFileSync(file, JSON.stringify(complete));
  const result = resultOf(await handler(check(file, ['src/a.ts']), ports, { runDir, attempt: 1 }));
  assert.equal(result.type, 'ENVELOPE_CHECKED');
  if (result.type === 'ENVELOPE_CHECKED') assert.deepEqual([result.defects, result.diff], [[], { paths: ['src/a.ts'] }]);
});

test('implement-envelope-self-check rejects out-of-scope COMPLETE changes during preview', async () => {
  const { runDir, handler, ports } = setup(['src/a.ts', 'src/outside.ts']);
  const file = path.join(runDir, 'outcome.json');
  fs.writeFileSync(file, JSON.stringify(complete));
  const result = resultOf(await handler(check(file, ['src/a.ts']), ports, { runDir, attempt: 1 }));
  assert.ok(result.type === 'ENVELOPE_CHECKED' && result.defects.some((defect) => /outside the approved scope/.test(defect)));
});

const SKILL_ROOT = path.resolve(import.meta.dirname, '../../../skills/dispatch');
async function previewReceipt(task: Record<string, unknown> | undefined) {
  const cwd = tempDir();
  const git: Git = { toplevel: async () => cwd, indexEntries: async () => '', diffNames: async () => [], fingerprint: async () => ({ head: 'h', index: 'i', worktree: 'w' }), changedSince: async () => [], log: async () => '' };
  let eventPath = '';
  const handlers = createHandlers({ cwd, git, os: 'linux', skillRoot: SKILL_ROOT, tempRoot: cwd, workspaceRoot: cwd, orchestratorPlatform: null, wave: async () => [], selfCheckCommand: (_runDir, file) => { eventPath = file; return `dispatch send --dry-run ${file}`; } });
  const brief = resultOf(await handlers['write-brief']!({ kind: 'write-brief', id: 'implement.write-brief.1', stage: 'task', input: task ? { task } : {} }, fakePorts(), { runDir: cwd, attempt: 1 }));
  assert.equal(brief.type, 'BRIEF_READY');
  return { brief: brief as Extract<ResultEvent, { type: 'BRIEF_READY' }>, receipt: JSON.parse(fs.readFileSync(eventPath, 'utf8')) as Record<string, unknown> };
}

test('self-check preview writes a submitted receipt echoing the brief hash', async () => {
  const { brief, receipt } = await previewReceipt({ id: 'T1', attempt: 2, signature: 'sig' });
  assert.deepEqual(receipt, { type: 'WRITE_RECEIPT', status: 'submitted', task: 'T1', attempt: 2, signature: 'sig', handle: '<host-assigned handle>', envelopePath: brief.envelopePath, briefHash: brief.sha256, model: '<host-attested model>' });
});

test('self-check preview writes a taskless submitted receipt without identity', async () => {
  const { brief, receipt } = await previewReceipt(undefined);
  assert.deepEqual(receipt, { type: 'WRITE_RECEIPT', status: 'submitted', envelopePath: brief.envelopePath });
});

test('check-envelope rejects duplicate/unknown fields and out-of-scope or production paths in RED_READY', async () => {
  const { runDir, handler, ports } = setup(['tests/new.test.ts', 'src/production.ts']);
  const file = path.join(runDir, 'outcome.json');
  fs.writeFileSync(file, '{"schemaVersion":1,"schemaVersion":1,"status":"DONE","stage":"RED_READY","summary":"Tests","evidence":["RED-MATRIX SC1 | tests/new.test.ts:rejects value | exit 1 test:rejects value"],"unexpected":true}');
  const result = resultOf(await handler(check(file, ['tests/new.test.ts']), ports, { runDir, attempt: 1 }));
  assert.equal(result.type, 'ENVELOPE_CHECKED');
  if (result.type === 'ENVELOPE_CHECKED') {
    assert.match(result.defects.join('\n'), /duplicate key/);
    assert.match(result.defects.join('\n'), /unknown field/);
    assert.match(result.defects.join('\n'), /outside the approved scope/);
  }
  fs.writeFileSync(file, JSON.stringify({ ...complete, stage: 'RED_READY', status: 'DONE' }));
  const nonTest = resultOf(await handler(check(file, ['src/production.ts']), ports, { runDir, attempt: 1 }));
  assert.ok(nonTest.type === 'ENVELOPE_CHECKED' && nonTest.defects.some((defect) => /RED_READY envelopes may change tests only/.test(defect)));
});

test('writer scope ignores caller dirt and still detects changes to that same dirty file', async () => {
  const { cwd, runDir, handler, ports } = setup(['caller.txt', 'src/a.ts']);
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'caller.txt'), 'caller edit');
  ports.git = { run: async (argv) => argv.slice(2).map((file) => crypto.createHash('sha1').update(fs.readFileSync(path.join(cwd, file))).digest('hex')).join('\n') };
  fs.writeFileSync(path.join(cwd, 'src/a.ts'), 'before');
  const { pathHashes } = await import('../../../skills/dispatch/scripts/effects/check-envelope.ts');
  const git: Git = { toplevel: async () => cwd, indexEntries: async () => '', diffNames: async () => ['caller.txt', 'src/a.ts'], fingerprint: async () => ({ head: 'h', index: 'i', worktree: 'w' }), changedSince: async () => [] };
  const since = { pathHashes: await pathHashes({ cwd, git }, ports) };
  fs.writeFileSync(path.join(cwd, 'src/a.ts'), 'writer edit');
  const file = path.join(runDir, 'outcome.json');
  fs.writeFileSync(file, JSON.stringify(complete));
  const effect = { ...check(file, ['src/a.ts']), since };
  const good = resultOf(await handler(effect, ports, { runDir, attempt: 1 }));
  assert.ok(good.type === 'ENVELOPE_CHECKED');
  if (good.type === 'ENVELOPE_CHECKED') { assert.deepEqual(good.defects, []); assert.deepEqual(good.diff['paths'], ['src/a.ts']); }
  fs.writeFileSync(path.join(cwd, 'caller.txt'), 'writer touched caller edit');
  const bad = resultOf(await handler(effect, ports, { runDir, attempt: 1 }));
  assert.ok(bad.type === 'ENVELOPE_CHECKED');
  if (bad.type === 'ENVELOPE_CHECKED') {
    assert.ok(bad.defects.some((defect) => /outside the approved scope/.test(defect)));
    assert.deepEqual(bad.diff['outside'], ['caller.txt']);
  }
});


test('path snapshot augmentation returns EFFECT_FAILED on a path hash read failure', async () => {
  const cwd = tempDir();
  const git: Git = { toplevel: async () => cwd, indexEntries: async () => { throw new Error('index unavailable'); }, diffNames: async () => [], fingerprint: async () => ({ head: 'h', index: 'i', worktree: 'w' }), changedSince: async () => [] };
  const snapshot = createHandlers({ cwd, git, os: 'linux', skillRoot: cwd, tempRoot: cwd, workspaceRoot: cwd, orchestratorPlatform: null, wave: async () => [] }).snapshot;
  assert.ok(snapshot);
  const result = resultOf(await snapshot({ kind: 'snapshot', id: 'snapshot.1', since: null }, fakePorts(), { runDir: cwd, attempt: 1 }));
  assert.ok(result.type === 'EFFECT_FAILED' && result.cls === 'io' && /index unavailable/.test(result.detail));
});

test('dirty path byte hashing batches argv below the Windows command-line limit', async () => {
  const { pathHashes } = await import('../../../skills/dispatch/scripts/effects/check-envelope.ts');
  const files = Array.from({ length: 400 }, (_, index) => `generated/${'long-directory-'.repeat(8)}${index}.bin`);
  const fileSet = new Set(files);
  const ports = fakePorts();
  ports.fs = { ...ports.fs, exists: () => true, inspectPath: (file) => ({ kind: fileSet.has(path.relative('/repo', file).split(path.sep).join('/')) ? 'file' : 'directory', mode: 0o644, linkTarget: null, realPath: file }) };
  const batches: string[][] = [];
  ports.git = { run: async (argv) => { batches.push([...argv]); return argv.slice(2).map(() => 'a'.repeat(40)).join('\n'); } };
  const git: Git = { toplevel: async () => '/repo', indexEntries: async () => '', diffNames: async () => files, fingerprint: async () => ({ head: 'h', index: 'i', worktree: 'w' }), changedSince: async () => [] };
  const result = await pathHashes({ cwd: '/repo', git }, ports);
  assert.equal(Object.keys(result).length, files.length);
  assert.ok(batches.length > 1);
  assert.ok(batches.every((argv) => argv.join(' ').length < 16000));
});

test('leaf symlinks cannot bypass ancestor containment in path fingerprints', async () => {
  const { pathHashes } = await import('../../../skills/dispatch/scripts/effects/check-envelope.ts');
  const cwd = tempDir(), ports = fakePorts();
  let leafInspected = false;
  ports.fs.inspectPath = (file) => {
    if (file === path.join(cwd, 'linked', 'leaf')) leafInspected = true;
    return { kind: 'symlink', mode: 0o777, linkTarget: Buffer.from('/outside').toString('base64'), realPath: '/outside' };
  };
  const git: Git = { toplevel: async () => cwd, indexEntries: async () => '', diffNames: async () => ['linked/leaf'], fingerprint: async () => ({ head: 'h', index: 'i', worktree: 'w' }), changedSince: async () => [] };
  await assert.rejects(pathHashes({ cwd, git }, ports), /ancestor escape/);
  assert.equal(leafInspected, false);
});

const amendment = { finding: 'SC2 Verify selects no tests.', evidence: ['npm test -- --test-name-pattern=x selected 0 tests'], proposal: [{ kind: 'modify', target: 'SC2', current: 'pattern x', proposed: 'pattern y', rationale: 'Only y names the behavior.' }] };

test('amendment is accepted on BLOCKED and NEEDS_CONTEXT envelopes', async () => {
  for (const extra of [{ status: 'BLOCKED', blockers: ['SC2 cannot be verified.'] }, { status: 'NEEDS_CONTEXT', missingContext: ['Which pattern names SC2?'] }]) {
    const { runDir, handler, ports } = setup([]);
    const file = path.join(runDir, 'outcome.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, stage: 'COMPLETE', summary: 'Plan conflict.', evidence: [], ...extra, amendment }));
    const result = resultOf(await handler(check(file, ['src/a.ts']), ports, { runDir, attempt: 1 }));
    assert.ok(result.type === 'ENVELOPE_CHECKED');
    if (result.type === 'ENVELOPE_CHECKED') { assert.deepEqual(result.defects, []); assert.deepEqual((result.envelope as Record<string, unknown>)['amendment'], amendment); }
  }
});

test('amendment is rejected on statuses other than BLOCKED or NEEDS_CONTEXT', async () => {
  const { runDir, handler, ports } = setup(['src/a.ts']);
  const file = path.join(runDir, 'outcome.json');
  fs.writeFileSync(file, JSON.stringify({ ...complete, amendment }));
  const result = resultOf(await handler(check(file, ['src/a.ts']), ports, { runDir, attempt: 1 }));
  assert.ok(result.type === 'ENVELOPE_CHECKED' && result.defects.some((defect) => /amendment is valid only for BLOCKED or NEEDS_CONTEXT/.test(defect)));
});

test('amendment with missing or invalid fields is rejected', async () => {
  const bad = [
    { ...amendment, finding: '' }, { ...amendment, evidence: [] }, { ...amendment, proposal: [] },
    { ...amendment, proposal: [{ ...amendment.proposal[0], kind: 'rewrite' }] },
    { ...amendment, proposal: [{ ...amendment.proposal[0], target: '' }] },
    { ...amendment, proposal: [{ ...amendment.proposal[0], rationale: ' ' }] },
    { ...amendment, extra: true },
  ];
  for (const value of bad) {
    const { runDir, handler, ports } = setup([]);
    const file = path.join(runDir, 'outcome.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, status: 'BLOCKED', stage: 'COMPLETE', summary: 'Plan conflict.', evidence: [], blockers: ['x'], amendment: value }));
    const result = resultOf(await handler(check(file, ['src/a.ts']), ports, { runDir, attempt: 1 }));
    assert.ok(result.type === 'ENVELOPE_CHECKED' && result.defects.some((defect) => /^amendment/.test(defect)), JSON.stringify(value));
  }
});
