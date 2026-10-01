import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { acquireGpuLock, fetchModels } from '../../skills/dispatch/scripts/providers/opencode-runtime.ts';
import { nodeProcess } from '../../skills/dispatch/scripts/providers/node-process.ts';
import { createGit } from '../../skills/dispatch/scripts/effects/git.ts';
import { test } from 'node:test';
import { CLEAN, fixture, until } from '../helpers/e2e.ts';
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


test('rewrite SC2 round delta preserves caller dirt and detects staged untracked deleted and ref drift', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.repo, 'src/b.ts'), 'before'); f.git('add', '.'); f.git('commit', '-qm', 'second');
    fs.writeFileSync(path.join(f.repo, 'src/a.ts'), 'caller dirt');
    const git = createGit({ run: async (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }) });
    const prior = await git.reviewSnapshot!(f.repo, '');
    const indexBefore = f.git('ls-files', '--stage');
    assert.deepEqual((await git.reviewDelta!(f.repo, prior)).paths, []);
    fs.writeFileSync(path.join(f.repo, 'src/a.ts'), 'writer'); f.git('add', 'src/a.ts');
    fs.rmSync(path.join(f.repo, 'src/b.ts')); fs.writeFileSync(path.join(f.repo, 'src/new.ts'), 'new');
    const delta = await git.reviewDelta!(f.repo, prior);
    assert.deepEqual(delta.paths, ['src/a.ts', 'src/b.ts', 'src/new.ts']);
    assert.deepEqual(delta.staged, ['src/a.ts']); assert.deepEqual(delta.deleted, ['src/b.ts']); assert.deepEqual(delta.untracked, ['src/new.ts']);
    const indexAfter = f.git('ls-files', '--stage'); await git.reviewDelta!(f.repo, prior); assert.equal(f.git('ls-files', '--stage'), indexAfter); assert.notEqual(indexAfter, indexBefore);
    f.git('commit', '-qm', 'drift'); await assert.rejects(git.reviewDelta!(f.repo, prior), /binding-drift/);
  } finally { f.cleanup(); }
});


test('rewrite SC3 production wave journals preparation and completion once', async () => {
  const f = fixture();
  try {
    const session = await f.initialize(); fs.writeFileSync(path.join(f.repo, 'src/a.ts'), 'changed');
    const frame = await f.begin('review', session, '', ['--kind', 'code']);
    assert.equal(frame.data['outcome'], 'complete', JSON.stringify(frame));
    const journal = fs.readFileSync(path.join(frame.run, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
    assert.equal(journal[0]?.data['protocolRevision'], 2);
    assert.equal(journal.filter((row) => row.type === 'WAVE_STARTED').length, 1); assert.equal(journal.filter((row) => row.type === 'WAVE_DONE').length, 1); assert.equal(f.launches().length, 1);
  } finally { f.cleanup(); }
});


test('rewrite SC4 GPU lock excludes concurrent leases recovers dead owner and releases', async () => {
  const f = fixture(); const file = path.join(f.dir, 'gpu.lock');
  try {
    const release = await acquireGpuLock(1000, file); await assert.rejects(acquireGpuLock(30, file), /gpu-lock-timeout/); release(); release();
    fs.writeFileSync(file, JSON.stringify({ host: os.hostname(), pid: 2147483647, token: 'dead' }));
    const recovered = await acquireGpuLock(1000, file); recovered(); assert.equal(fs.existsSync(file), false);
    assert.equal(await fetchModels('http://127.0.0.1:1/v1', 50), null);
  } finally { f.cleanup(); }
});
test('rewrite SC4 real child output cap cancels promptly and retains partial capture', async () => {
  const f = fixture();
  try {
    const logPath = path.join(f.dir, 'cap.log'); const before = Date.now();
    const child = nodeProcess.start({ argv: [process.execPath, '-e', "process.stdout.write('x'.repeat(8192));setInterval(()=>{},1000)"], stdin: null, env: process.env as Record<string, string>, cwd: f.dir }, { logPath, capBytes: 100 });
    const result = await child.done; assert.equal(result.truncated, true); assert.equal(fs.statSync(logPath).size, 100); assert.ok(Date.now() - before < 5000);
  } finally { f.cleanup(); }
});

 test('rewrite SC4 cross-process dead-owner recovery never overlaps GPU leases', async () => {
  const f = fixture(); const file = path.join(f.dir, 'race.lock');
  try {
    fs.writeFileSync(file, JSON.stringify({ host: os.hostname(), pid: 2147483647, token: 'dead' }));
    const module = pathToFileURL(path.resolve('skills/dispatch/scripts/providers/opencode-runtime.ts')).href;
    const code = `import { acquireGpuLock } from ${JSON.stringify(module)}; const release = await acquireGpuLock(3000, ${JSON.stringify(file)}); const start = Date.now(); await new Promise(r=>setTimeout(r,200)); const end = Date.now(); release(); console.log(JSON.stringify({start,end}));`;
    const launch = () => new Promise<{ start: number; end: number }>((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', code], { cwd: f.repo, windowsHide: true, timeout: 5000, maxBuffer: 4096 }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout))));
    const intervals = (await Promise.all([launch(), launch()])).sort((a,b)=>a.start-b.start);
    assert.ok(intervals[1]!.start >= intervals[0]!.end, JSON.stringify(intervals));
    assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(`${file}.guard`), false);
  } finally { f.cleanup(); }
});

test('rewrite SC3 production native await precedes CLI completion and survives replay', async () => {
  const f = fixture({ delayMs: 2000, responses: [CLEAN] });
  try {
    const config = { ...f.config, 'read-delegates': { ...f.config['read-delegates'], codex: { nativeSubagentsOnly: true, targets: [{ low: { model: 'native-stub', effort: 'low' } }] } }, phases: { ...f.config.phases, 'code-review': { rounds: { low: 1 }, targets: { low: 2 } } } };
    fs.writeFileSync(path.join(f.skill, 'config.local.jsonc'), JSON.stringify(config));
    const session = await f.initialize(); fs.writeFileSync(path.join(f.repo, 'src/a.ts'), 'changed');
    const frame = await f.begin('review', session, '', ['--kind', 'code']);
    assert.equal(frame.await, 'native', JSON.stringify(frame)); const run = f.absoluteRun(frame.run);
    await until(() => f.launches().length === 1);
    let journalRun = run; const journal = () => fs.readFileSync(path.join(journalRun, 'events.jsonl'), 'utf8');
    assert.match(journal(), /WAVE_STARTED/); assert.doesNotMatch(journal(), /WAVE_DONE/);
    const replay = await f.cli(['send', '--run', run, '--dry-run']); assert.equal(replay.await, 'native');
    const event = structuredClone(frame.events!.find((row)=>row.type === 'NATIVE_RESULTS')!);
    if (event.type !== 'NATIVE_RESULTS') throw new Error('missing native envelope');
    for (const slot of event.slots) fs.writeFileSync(String(slot['outputPath']), JSON.stringify(CLEAN));
    const completed = await f.reply(run, event); assert.equal(completed.data['outcome'], 'complete', JSON.stringify(completed)); journalRun = completed.run;
    assert.equal((journal().match(/"type":"WAVE_STARTED"/g) ?? []).length, 1);
    assert.equal((journal().match(/"type":"WAVE_DONE"/g) ?? []).length, 1); assert.equal(f.launches().length, 1);
  } finally { f.cleanup(); }
});

test('review fix bounded manifests skip unrelated content and audit scratch and retain deletion tombstones', async () => {
  const { nodePorts } = await import('../../skills/dispatch/scripts/core/ports.ts');
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.repo, '.gitignore'), '');
    fs.writeFileSync(path.join(f.repo, 'unrelated.txt'), 'caller content'); f.git('add', '.'); f.git('commit', '-qm', 'bounded');
    fs.mkdirSync(path.join(f.repo, '.scratch/audits'), { recursive: true }); fs.writeFileSync(path.join(f.repo, '.scratch/audits/report.md'), 'audit output');
    const native = nodePorts().git; const reads: string[] = [];
    const git = createGit({ run: native.run, fileContent: (file,cwd) => { reads.push(file); return native.fileContent!(file,cwd); } });
    const index = f.git('ls-files', '--stage');
    const prior = await git.reviewSnapshot!(f.repo, '', ['src/a.ts', 'new.ts', '.scratch/audits/report.md']);
    assert.deepEqual(reads, ['src/a.ts']); assert.deepEqual(prior.governedPaths, ['new.ts', 'src/a.ts']);
    assert.ok(!(await git.diffNames(f.repo, '')).includes('.scratch/audits/report.md'));
    fs.rmSync(path.join(f.repo, 'src/a.ts')); fs.writeFileSync(path.join(f.repo, 'new.ts'), 'new');
    const delta = await git.reviewDelta!(f.repo, prior);
    assert.deepEqual(delta.paths, ['new.ts', 'src/a.ts']); assert.deepEqual(delta.deleted, ['src/a.ts']);
    assert.ok(!reads.includes('unrelated.txt')); assert.equal(f.git('ls-files', '--stage'), index);
  } finally { f.cleanup(); }
});

test('review fix GPU release awaits a busy guard without blocking timers or losing its lease', async () => {
  const f = fixture(), file = path.join(f.dir, 'release.lock'); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const release = await acquireGpuLock(1000, file); fs.writeFileSync(`${file}.guard`, 'other critical section');
    let timerRan = false;
    timer = setTimeout(() => { timerRan = true; fs.unlinkSync(`${file}.guard`); }, 1200);
    const pending = release(); assert.equal(release(), pending);
    await pending; assert.equal(timerRan, true); assert.equal(fs.existsSync(file), false);
    await release(); assert.equal(fs.existsSync(`${file}.guard`), false);
  } finally { if (timer) clearTimeout(timer); f.cleanup(); }
});
