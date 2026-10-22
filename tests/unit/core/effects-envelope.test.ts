import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createHandlers } from '../../../skills/dispatch/scripts/effects/index.ts';
import path from 'node:path';
import { test } from 'node:test';
import type { Effect, Handlers, HostEvent, ResultEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import type { Git } from '../../../skills/dispatch/scripts/effects/git.ts';
import { createCheckEnvelope } from '../../../skills/dispatch/scripts/effects/check-envelope.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { previewReceipt as previewTaskReceipt } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import type { RootState } from '../../../skills/dispatch/scripts/machines/root.ts';
import type { ParsedPlan, PlanCriterion, PlanTask } from '../../../skills/dispatch/scripts/domain/types.ts';

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

test('checkpoint concerns use the typed envelope result field', async () => {
  const { runDir, handler, ports } = setup([]);
  const envelopePath = path.join(runDir, 'outcome.json');
  fs.writeFileSync(envelopePath, JSON.stringify(complete));
  const checkpointPath = path.join(runDir, 'missing.json');
  const result = resultOf(await handler({ ...check(envelopePath, ['tests/a.ts']), checkpointPath, checkpointTests: ['tests/a.ts'] }, ports, { runDir, attempt: 1 }));
  assert.equal(result.type, 'ENVELOPE_CHECKED');
  if (result.type !== 'ENVELOPE_CHECKED') return;
  assert.deepEqual(result.checkpointConcerns, [`RED checkpoint is missing: ${checkpointPath}`]);
  assert.deepEqual(result.diff, { paths: [] });
});

test('implement-envelope-self-check parses a strict receipt and accepts only approved changed paths', async () => {
  const { runDir, handler, ports } = setup(['src/a.ts']);
  const file = path.join(runDir, 'outcome.json');
  fs.writeFileSync(file, JSON.stringify(complete));
  const result = resultOf(await handler(check(file, ['src/a.ts']), ports, { runDir, attempt: 1 }));
  assert.equal(result.type, 'ENVELOPE_CHECKED');
  if (result.type === 'ENVELOPE_CHECKED') assert.deepEqual([result.defects, result.diff], [[], { paths: ['src/a.ts'] }]);
});

test('check-envelope reports out-of-scope COMPLETE changes for the orchestrator without a defect', async () => {
  const { runDir, handler, ports } = setup(['src/a.ts', 'src/outside.ts']);
  const file = path.join(runDir, 'outcome.json');
  fs.writeFileSync(file, JSON.stringify(complete));
  const result = resultOf(await handler(check(file, ['src/a.ts']), ports, { runDir, attempt: 1 }));
  assert.ok(result.type === 'ENVELOPE_CHECKED');
  if (result.type === 'ENVELOPE_CHECKED') assert.deepEqual([result.defects, result.diff['outside']], [[], ['src/outside.ts']]);
});

test('check-envelope rejects envelope file paths that escape the repository', async () => {
  const { runDir, handler, ports } = setup(['src/a.ts']);
  const file = path.join(runDir, 'outcome.json');
  fs.writeFileSync(file, JSON.stringify({ ...complete, files: [{ path: '../escape.ts', note: 'escape' }] }));
  const result = resultOf(await handler(check(file, ['src/a.ts']), ports, { runDir, attempt: 1 }));
  assert.ok(result.type === 'ENVELOPE_CHECKED' && result.defects.some((defect) => /files\[0\]\.path must be repository-relative/.test(defect)));
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

test('self-check preview writes a submitted receipt with or without task identity', async () => {
  const withTask = await previewReceipt({ id: 'T1', attempt: 2, signature: 'sig' });
  assert.deepEqual(withTask.receipt, { type: 'WRITE_RECEIPT', status: 'submitted', task: 'T1', attempt: 2, signature: 'sig', handle: '<host-assigned handle>', envelopePath: withTask.brief.envelopePath, briefHash: withTask.brief.sha256, model: '<host-attested model>' });

  const taskless = await previewReceipt(undefined);
  assert.deepEqual(taskless.receipt, { type: 'WRITE_RECEIPT', status: 'submitted', envelopePath: taskless.brief.envelopePath });
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
    assert.deepEqual(bad.diff['outside'], ['caller.txt']);
  }
});

function submissionPreviewFixture(issuedChecks: string[] = ['npm run lint'], baselinePaths: Record<string, string> = {}) {
  const cwd = tempDir(), worktree = path.join(cwd, 'worktree'), runDir = path.join(cwd, 'run');
  fs.mkdirSync(path.join(worktree, 'tests'), { recursive: true }); fs.mkdirSync(runDir);
  const testPath = 'tests/check.test.ts', envelopePath = path.join(runDir, 'outcome.json'), checkpointPath = path.join(runDir, 'red.json');
  fs.writeFileSync(path.join(worktree, testPath), 'submitted test bytes');
  const criterion = {
    id: 'SC1', changes: ['src/a.ts', testPath], tests: [testPath], evidence: 'red', red: 'node --test {files}', redException: null,
    verify: [{ command: `node --test ${testPath}`, final: false }],
  } as unknown as PlanCriterion;
  const task = { id: 'T1', paths: ['src/a.ts', testPath], criteria: ['SC1'] } as unknown as PlanTask;
  const plan = {
    planIds: ['SC1', 'SC2'], criteria: [criterion], tasks: [task],
    verification: { automated: ['npm run lint'], none: null, manual: [] }, finalCommands: [],
  } as unknown as ParsedPlan;
  const brief = { path: 'brief.md', sha256: 'sha256:brief', envelopePath, checkpointPath };
  const record = {
    attempt: 1, signature: 'sig', handle: 'handle', worktree, baseline: { head: 'h', index: 'i', worktree: 'w', pathHashes: baselinePaths },
    brief, briefs: [{ ...brief, scope: JSON.stringify({ paths: task.paths }), contractChecks: issuedChecks }],
  };
  const state = { tag: 'implement', child: { tag: 'tasks', c: { plan, tasks: { T1: record } } } } as unknown as RootState;
  const event = { type: 'WRITE_RECEIPT', status: 'submitted', task: 'T1', attempt: 1, signature: 'sig', handle: 'handle', envelopePath, briefHash: 'sha256:brief', model: 'writer' } as HostEvent;
  const git: Git = { toplevel: async () => cwd, indexEntries: async () => '', diffNames: async () => [], fingerprint: async () => ({ head: 'h', index: 'i', worktree: 'w' }), changedSince: async () => [], log: async () => '' };
  const ports = fakePorts(); let writes = 0, gitRuns = 0;
  ports.fs.writeAtomic = () => { writes++; throw new Error('preview must not write'); };
  ports.fs.writeBase64Atomic = () => { writes++; throw new Error('preview must not write'); };
  ports.fs.appendDurable = () => { writes++; throw new Error('preview must not write'); };
  ports.git.run = async () => { gitRuns++; throw new Error('preview must not invoke Git mutations'); };
  const handler = createCheckEnvelope({ cwd, git });
  const handlers: Handlers = { 'check-envelope': handler };
  const writeEnvelope = (evidence: string[]) => fs.writeFileSync(envelopePath, JSON.stringify({ schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'Delivered.', evidence }));
  const writeCheckpoint = (files: Record<string, string | null>) => fs.writeFileSync(checkpointPath, JSON.stringify({ schemaVersion: 1, files }));
  const preview = () => previewTaskReceipt(state, event, handlers, ports, runDir);
  return { cwd, worktree, runDir, testPath, envelopePath, checkpointPath, state, record, ports, preview, writeEnvelope, writeCheckpoint, counters: () => ({ writes, gitRuns }) };
}

test('submission preflight preserves live RED admission for evidence, checkpoint bytes, and amended checks without writes', async () => {
  const fixture = submissionPreviewFixture();
  const { testPath } = fixture;
  const validRed = `RED-MATRIX SC1 | ${testPath}:rejects invalid input | exit 1 test:rejects invalid input`;
  const invalidRed = `RED-MATRIX SC1 | ${testPath}:rejects invalid input | exit 1 error:cannot observe this row`;
  const checkRow = 'CHECK npm run lint | exit 0';
  const submitted = Buffer.from('submitted test bytes').toString('base64');
  const other = Buffer.from('older test bytes').toString('base64');
  fixture.writeEnvelope([`CRITERION SC1 | src/a.ts | rejects invalid input`, validRed, checkRow, `RED-MATRIX SC2 | ${testPath}:extra case | exit 1 test:extra case`]);
  fixture.writeCheckpoint({ [testPath]: submitted });
  const before = fs.readdirSync(fixture.runDir).sort();
  assert.equal(await fixture.preview(), null);

  fixture.writeEnvelope([`CRITERION SC1 | src/a.ts | rejects invalid input`, 'RED-MATRIX SC1 | malformed', checkRow]);
  assert.equal(await fixture.preview(), null);

  fixture.writeEnvelope([`CRITERION SC1 | src/a.ts | rejects invalid input`, validRed, checkRow]);
  fs.rmSync(fixture.checkpointPath);
  assert.equal(await fixture.preview(), null);
  assert.match(fixture.ports.stderrLines.join(''), /T1: RED checkpoint is missing/);
  fs.writeFileSync(fixture.checkpointPath, '{');
  assert.equal(await fixture.preview(), null);
  assert.match(fixture.ports.stderrLines.join(''), /T1: RED checkpoint is invalid JSON/);

  fixture.writeCheckpoint({ [testPath]: other });
  assert.match((await fixture.preview()) ?? '', /RED checkpoint.*bytes|checkpoint.*differs/i);

  fixture.writeCheckpoint({ 'src/a.ts': submitted });
  assert.match((await fixture.preview()) ?? '', /RED checkpoint path is not an approved task test path/);

  fixture.writeCheckpoint({ [testPath]: submitted });
  assert.equal(await fixture.preview(), null);

  const outOfScope = submissionPreviewFixture(['npm run lint'], { 'README.md': 'before' });
  outOfScope.writeEnvelope([`CRITERION SC1 | src/a.ts | rejects invalid input`, invalidRed, checkRow]);
  outOfScope.writeCheckpoint({ [testPath]: submitted });
  assert.equal(await outOfScope.preview(), null, 'out-of-scope paths defer invalid evidence to live scope admission');

  fixture.record.briefs[0]!.contractChecks = [];
  fixture.writeEnvelope([`CRITERION SC1 | src/a.ts | rejects invalid input`, validRed]);
  assert.equal(await fixture.preview(), null, 'a brief that issued no current contract checks does not gain amended checks');
  assert.deepEqual(fs.readdirSync(fixture.runDir).sort(), before);
  assert.deepEqual(fixture.counters(), { writes: 0, gitRuns: 0 });
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

test('self-check preview rejects a RED_READY receipt submitted as final delivery', async () => {
  const { previewReceipt: preview } = await import('../../../skills/dispatch/scripts/core/interpreter.ts');
  const { cwd, runDir, handler, ports } = setup(['tests/a.test.ts']);
  fs.mkdirSync(path.join(cwd, 'tests'));
  fs.writeFileSync(path.join(cwd, 'tests/a.test.ts'), 'red');
  ports.git = { run: async (argv) => argv.slice(2).map((file) => crypto.createHash('sha1').update(fs.readFileSync(path.join(cwd, file))).digest('hex')).join('\n') };
  const envelopePath = path.join(runDir, 'outcome.json');
  fs.writeFileSync(envelopePath, JSON.stringify({ ...complete, stage: 'RED_READY', evidence: ['RED-MATRIX SC1 | tests/a.test.ts:rejects value | exit 1 test:rejects value'] }));
  const plan = { tasks: [{ id: 'T1', paths: ['src/a.ts', 'tests/a.test.ts'], criteria: ['SC1'] }], criteria: [{ id: 'SC1', tests: ['tests/a.test.ts'] }] };
  const state = { tag: 'implement', child: { tag: 'tasks', c: { plan, tasks: { T1: { worktree: cwd, baseline: { head: 'h', index: 'i', worktree: 'w' }, attempt: 1, signature: 'sig', handle: 'h1' } } } } };
  const event = { type: 'WRITE_RECEIPT', status: 'submitted', task: 'T1', attempt: 1, signature: 'sig', handle: 'h1', envelopePath };
  const verdict = await preview(state as never, event as never, { 'check-envelope': handler } as never, ports, runDir);
  assert.equal(verdict, 'Envelope stage must be COMPLETE; got RED_READY.');
});

test('amendment delta self check binds the latest delta envelope and hash and passes for a writer holding only the base brief and that delta', async () => {
  const { previewReceipt: preview } = await import('../../../skills/dispatch/scripts/core/interpreter.ts');
  const cwd = tempDir();
  const runDir = path.join(cwd, 'run');
  fs.mkdirSync(runDir);
  const git: Git = { toplevel: async () => cwd, indexEntries: async () => '', diffNames: async () => ['src/a.ts'], fingerprint: async () => ({ head: 'h', index: 'i', worktree: 'w' }), changedSince: async () => ['src/a.ts'], log: async () => '' };
  const handlers = createHandlers({ cwd, git, os: 'linux', skillRoot: SKILL_ROOT, tempRoot: cwd, workspaceRoot: cwd, orchestratorPlatform: null, wave: async () => [], selfCheckCommand: (_runDir, file) => `dispatch send --dry-run ${file}` });
  const ports = fakePorts();
  const task = { id: 'T1', attempt: 1, signature: 'sig', worktree: cwd, constraints: [], prerequisites: [] };
  const issue = async (id: string, extra: Record<string, unknown>) => {
    const event = resultOf(await handlers['write-brief']!({ kind: 'write-brief', id, stage: 'task', input: { task, settledScope: { paths: ['src/a.ts'] }, criteria: [{ id: 'SC1' }], ...extra } }, ports, { runDir, attempt: 1 }));
    assert.equal(event.type, 'BRIEF_READY');
    return event as Extract<ResultEvent, { type: 'BRIEF_READY' }>;
  };
  const base = await issue('implement.write-brief.1', {});
  const binding = { path: base.path, sha256: base.sha256 };
  await issue('implement.write-brief.2', { revisionNotice: { notice: 'first' }, deltaBase: { ...binding, seq: 1 } });
  const latest = await issue('implement.write-brief.3', { revisionNotice: { notice: 'second' }, deltaBase: { ...binding, seq: 2 } });
  const eventPath = (id: string) => path.join(runDir, id, 'self-check.event.json');
  assert.ok(fs.readFileSync(base.path, 'utf8').includes(`dispatch send --dry-run ${eventPath('implement.write-brief.1')}`));
  const delta = fs.readFileSync(latest.delta!.path, 'utf8');
  assert.ok(delta.includes(`dispatch send --dry-run ${eventPath('implement.write-brief.3')}`));
  assert.ok(delta.includes(`Base: ${base.path} · ${base.sha256}`));
  const receipt = JSON.parse(fs.readFileSync(eventPath('implement.write-brief.3'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual([receipt['envelopePath'], receipt['briefHash']], [latest.envelopePath, latest.delta!.sha256]);
  fs.writeFileSync(latest.envelopePath, JSON.stringify(complete));
  const plan = { tasks: [{ id: 'T1', paths: ['src/a.ts'], criteria: ['SC1'] }], criteria: [{ id: 'SC1', tests: [], changes: ['src/a.ts'], verify: [], evidence: 'verify' }], verification: { automated: [] }, finalCommands: [], planIds: ['SC1'] };
  const state = { tag: 'implement', child: { tag: 'tasks', c: { plan, tasks: { T1: { worktree: cwd, baseline: { head: 'h', index: 'i', worktree: 'w' }, attempt: 1, signature: 'sig', handle: 'h1' } } } } };
  ports.git = { run: async (argv) => argv.slice(2).map(() => 'a'.repeat(40)).join('\n') };
  assert.equal(await preview(state as never, { ...receipt, handle: 'h1' } as never, handlers, ports, runDir), null);
});

test('writer self-check accepts evidence without RED or CHECK rows', async () => {
  const fixture = submissionPreviewFixture();
  fixture.writeCheckpoint({ [fixture.testPath]: Buffer.from('submitted test bytes').toString('base64') });
  fixture.writeEnvelope(['CRITERION SC1 | src/a.ts | rejects invalid input']);
  assert.equal(await fixture.preview(), null);
  assert.match(fixture.ports.stderrLines.join(''), /note: T1: missing CHECK row for npm run lint/);
  assert.match(fixture.ports.stderrLines.join(''), /note: T1: Exactly one RED-MATRIX/);
  fixture.ports.stderrLines.length = 0;
  fs.rmSync(fixture.checkpointPath);
  fixture.writeEnvelope(['CHECK npm run lint | exit 0']);
  assert.match((await fixture.preview()) ?? '', /missing criterion rows for SC1/);
  assert.deepEqual(fixture.ports.stderrLines, []);
  assert.deepEqual(fixture.counters(), { writes: 0, gitRuns: 0 });
});
