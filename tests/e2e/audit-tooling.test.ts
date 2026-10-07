import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from '../helpers/e2e.ts';

const argv = ['node', 'audit', '--run', '2026-10-01-0636'];
const WORK = '.scratch/audits/2026-10-01-0636-work';
const REPORT = '.scratch/audits/2026-10-01-0636-audit.md';
const baselineModule = () => import(new URL('../../.agents/skills/audit-dispatch-skills/scripts/baseline.mjs', import.meta.url).href);
const finalizeModule = () => import(new URL('../../.agents/skills/audit-dispatch-skills/scripts/finalize.mjs', import.meta.url).href);
const fakeMetrics = async () => ({ markdown: '# fixture metrics', brokenCount: 0, hashLines: [] });
function counted() {
  const calls = { runs: 0 };
  return { calls, runTests: () => { calls.runs++; return { output: `generation ${calls.runs}`, status: 0, signal: null, error: null, totals: 'pass' }; } };
}
const relocatedFrom = (body: string) => /Run artifacts[^:]*: `([^`]+)`/.exec(body)?.[1];

test('rewrite SC7 baseline imports and writes current TypeScript test and metrics artifacts', async () => {
  const audit = await baselineModule();
  const f = fixture();
  try {
    let command = ''; let selected: readonly string[] = [];
    const runTests = (root: string) => audit.runTests(root, (cmd: string, args: readonly string[]) => { command = cmd; selected = args; return { stdout: '✔ All 1 test(s) passed', stderr: '', status: 0 }; });
    await audit.main({ root: f.repo, argv, runTests, buildMetrics: fakeMetrics });
    const work = path.join(f.repo, WORK);
    for (const name of ['git-status.txt', 'content-snapshot.json', 'tests.txt', 'metrics.md', 'manifest.json']) assert.ok(fs.existsSync(path.join(work, name)), name);
    assert.equal(command, 'npm'); assert.deepEqual(selected, ['test']);
  } finally { f.cleanup(); }
});

test('rewrite SC7 probe imports current provider and config APIs and publishes discovery artifacts', async () => {
  const audit = await import(new URL('../../.agents/skills/audit-dispatch-skills/scripts/probe-dispatch.mjs', import.meta.url).href);
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.repo, 'skills'), { recursive: true }); fs.cpSync(f.skill, path.join(f.repo, 'skills/dispatch'), { recursive: true });
    assert.ok(audit.loadConfig(f.repo).config?.['read-delegates']);
    await audit.main({ root: f.repo, argv: [...argv, '--discover-only', '--only', 'opencode'] });
    const work = path.join(f.repo, '.scratch/audits/2026-10-01-0636-work/dispatch');
    assert.ok(fs.existsSync(path.join(work, 'summary.md'))); assert.ok(fs.existsSync(path.join(work, 'results.json')));
    const summary = fs.readFileSync(path.join(work, 'summary.md'), 'utf8'); assert.match(summary, /Discovery/); assert.match(summary, /unverified/);
  } finally { f.cleanup(); }
});

test('rewrite SC7 finalization imports and preserves baseline tree comparison and relocation', async () => {
  const baseline = await baselineModule(); const audit = await finalizeModule();
  const f = fixture(); let relocated: string | undefined;
  try {
    await baseline.main({ root: f.repo, argv, ...counted(), buildMetrics: fakeMetrics });
    const work = path.join(f.repo, WORK), report = path.join(f.repo, REPORT); fs.writeFileSync(report, '# audit');
    audit.main({ root: f.repo, argv });
    const body = fs.readFileSync(report, 'utf8'); assert.match(body, /Repo integrity: unchanged/);
    relocated = relocatedFrom(body); assert.ok(relocated); assert.ok(fs.existsSync(path.join(relocated!, 'git-status.txt'))); assert.equal(fs.existsSync(work), false);
  } finally { if (relocated) fs.rmSync(relocated, { recursive: true, force: true }); f.cleanup(); }
});

test('audit lifecycle baseline runs the aggregate suite once and resume reuses its evidence', async () => {
  const audit = await baselineModule();
  const f = fixture();
  try {
    const { calls, runTests } = counted(); const options = { root: f.repo, argv, runTests, buildMetrics: fakeMetrics };
    await audit.main(options);
    await audit.main({ ...options, argv: [...argv, '--resume'] });
    assert.equal(calls.runs, 1);
    assert.equal(fs.readFileSync(path.join(f.repo, WORK, 'tests.txt'), 'utf8'), 'generation 1');
    const manifest = JSON.parse(fs.readFileSync(path.join(f.repo, WORK, 'manifest.json'), 'utf8'));
    assert.equal(manifest.baseline.status, 'complete'); assert.equal(manifest.budgets.lead.baselineTestRuns, 1);
    assert.equal(manifest.revision, f.git('rev-parse', 'HEAD').trim());
    await assert.rejects(audit.main({ ...options, argv: [...argv, '--force'] }), /--force.*fresh run/i);
  } finally { f.cleanup(); }
});

test('audit lifecycle rejects a colliding run id without replacing the existing baseline', async () => {
  const audit = await baselineModule();
  const f = fixture();
  try {
    const { calls, runTests } = counted(); const options = { root: f.repo, argv, runTests, buildMetrics: fakeMetrics };
    await audit.main(options);
    await assert.rejects(audit.main(options), /already reserved.*new --run id/i);
    assert.equal(calls.runs, 1); assert.equal(fs.readFileSync(path.join(f.repo, WORK, 'tests.txt'), 'utf8'), 'generation 1');
  } finally { f.cleanup(); }
});

test('audit lifecycle resume rejects a legacy work directory and preserves its evidence', async () => {
  const audit = await baselineModule();
  const f = fixture();
  try {
    const work = path.join(f.repo, WORK); fs.mkdirSync(work, { recursive: true }); fs.writeFileSync(path.join(work, 'git-status.txt'), 'legacy');
    const { calls, runTests } = counted();
    await assert.rejects(audit.main({ root: f.repo, argv: [...argv, '--resume'], runTests, buildMetrics: fakeMetrics }), /legacy.*fresh run/i);
    assert.equal(calls.runs, 0); assert.equal(fs.readFileSync(path.join(work, 'git-status.txt'), 'utf8'), 'legacy');
  } finally { f.cleanup(); }
});

test('audit lifecycle finalize detects a content edit to an already-dirty tracked file', async () => {
  const baseline = await baselineModule(); const audit = await finalizeModule();
  const f = fixture(); let relocated: string | undefined;
  try {
    fs.writeFileSync(path.join(f.repo, 'src/a.ts'), 'export const value = 2;\n');
    await baseline.main({ root: f.repo, argv, ...counted(), buildMetrics: fakeMetrics });
    fs.writeFileSync(path.join(f.repo, 'src/a.ts'), 'export const value = 3;\n');
    const report = path.join(f.repo, REPORT); fs.writeFileSync(report, '# audit');
    audit.main({ root: f.repo, argv });
    const body = fs.readFileSync(report, 'utf8'); relocated = relocatedFrom(body);
    assert.match(body, /Repo integrity: CHANGED/); assert.match(body, /~ src\/a\.ts/);
  } finally { if (relocated) fs.rmSync(relocated, { recursive: true, force: true }); f.cleanup(); }
});

test('audit lifecycle finalize fingerprints an ignored local config without reporting its content', async () => {
  const baseline = await baselineModule(); const audit = await finalizeModule();
  const f = fixture(); let relocated: string | undefined;
  try {
    fs.appendFileSync(path.join(f.repo, '.gitignore'), 'config.local.jsonc\n'); f.git('add', '.gitignore'); f.git('commit', '-qm', 'ignore local config');
    const local = path.join(f.repo, 'skills/dispatch/config.local.jsonc'); fs.mkdirSync(path.dirname(local), { recursive: true }); fs.writeFileSync(local, '{"secret":"first-value"}');
    await baseline.main({ root: f.repo, argv, ...counted(), buildMetrics: fakeMetrics });
    const snapshot = fs.readFileSync(path.join(f.repo, WORK, 'content-snapshot.json'), 'utf8');
    assert.match(snapshot, /skills\/dispatch\/config\.local\.jsonc/); assert.doesNotMatch(snapshot, /first-value/);
    fs.writeFileSync(local, '{"secret":"second-value"}');
    const report = path.join(f.repo, REPORT); fs.writeFileSync(report, '# audit');
    audit.main({ root: f.repo, argv });
    const body = fs.readFileSync(report, 'utf8'); relocated = relocatedFrom(body);
    assert.match(body, /~ skills\/dispatch\/config\.local\.jsonc/); assert.doesNotMatch(body, /first-value|second-value/);
  } finally { if (relocated) fs.rmSync(relocated, { recursive: true, force: true }); f.cleanup(); }
});

test('audit lifecycle finalize refuses while a scope is still running', async () => {
  const baseline = await baselineModule(); const audit = await finalizeModule();
  const f = fixture();
  try {
    await baseline.main({ root: f.repo, argv, ...counted(), buildMetrics: fakeMetrics });
    const manifestPath = path.join(f.repo, WORK, 'manifest.json'); const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.scopes.ask = { lifecycle: 'running', handle: 'agent-1', budgets: {}, resultPath: null, gaps: [] }; fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(path.join(f.repo, REPORT), '# audit');
    assert.throws(() => audit.main({ root: f.repo, argv }), /still running.*ask/i);
    assert.ok(fs.existsSync(path.join(f.repo, WORK, 'tests.txt'))); assert.equal(fs.readFileSync(path.join(f.repo, REPORT), 'utf8'), '# audit');
  } finally { f.cleanup(); }
});

test('audit lifecycle failed relocation preserves evidence and a retry completes unchanged', async () => {
  const baseline = await baselineModule(); const audit = await finalizeModule();
  const f = fixture(); const created: string[] = [];
  try {
    await baseline.main({ root: f.repo, argv, ...counted(), buildMetrics: fakeMetrics });
    const work = path.join(f.repo, WORK), report = path.join(f.repo, REPORT); fs.writeFileSync(report, '# audit');
    // A copy that silently drops a file must fail verification rather than delete the source.
    const copyDir = (from: string, to: string) => { created.push(to); fs.cpSync(from, to, { recursive: true }); fs.rmSync(path.join(to, 'tests.txt')); };
    assert.throws(() => audit.main({ root: f.repo, argv, copyDir }), /relocation failed/i);
    let body = fs.readFileSync(report, 'utf8');
    assert.match(body, /relocation failed/i); assert.ok(body.includes(work.split(path.sep).join('/')));
    assert.ok(fs.existsSync(path.join(work, 'tests.txt'))); assert.ok(created[0] && fs.existsSync(created[0]), 'uncertain copy preserved');
    audit.main({ root: f.repo, argv });
    body = fs.readFileSync(report, 'utf8'); const relocated = relocatedFrom(body); assert.ok(relocated); created.push(relocated!);
    assert.match(body, /Repo integrity: unchanged/); assert.equal(fs.existsSync(work), false);
    assert.equal(fs.readFileSync(path.join(relocated!, 'tests.txt'), 'utf8'), 'generation 1');
  } finally { for (const dir of created) fs.rmSync(dir, { recursive: true, force: true }); f.cleanup(); }
});

test('audit lifecycle finalize refuses a terminal probe whose exit is unconfirmed and keeps its evidence', async () => {
  const baseline = await baselineModule(); const audit = await finalizeModule();
  const f = fixture();
  try {
    await baseline.main({ root: f.repo, argv, ...counted(), buildMetrics: fakeMetrics });
    const manifestPath = path.join(f.repo, WORK, 'manifest.json'); const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.probes.claude = { lifecycle: 'timeout', host: 'h', handle: '77', liveness: 'unknown', startedAt: null, deadlineAt: null, attempts: 1, exitConfirmed: false, capturePath: null, fixturePath: '/home/.dispatch-audit-probe-x', outcome: null, cause: 'deadline', cleanup: 'blocked' };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(path.join(f.repo, REPORT), '# audit');
    assert.throws(() => audit.main({ root: f.repo, argv }), /no confirmed exit.*probe claude.*liveness unknown/i);
    assert.ok(fs.existsSync(path.join(f.repo, WORK, 'tests.txt'))); assert.equal(fs.readFileSync(path.join(f.repo, REPORT), 'utf8'), '# audit');
  } finally { f.cleanup(); }
});

const sharedModule = () => import(new URL('../../.agents/skills/audit-dispatch-skills/scripts/shared.mjs', import.meta.url).href);

test('audit lifecycle content snapshot fingerprints an external symlink by its target without following it', async (t) => {
  const shared = await sharedModule();
  const f = fixture();
  try {
    const outside = path.join(path.dirname(f.repo), 'outside.txt'); fs.writeFileSync(outside, 'first');
    try { fs.symlinkSync(outside, path.join(f.repo, 'link.txt'), 'file'); } catch (err) {
      // NOTE: Windows without Developer Mode or elevation cannot create symlinks.
      if (['EPERM', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')) { t.skip('symlink creation unavailable'); return; }
      throw err;
    }
    const before = shared.contentSnapshot(f.repo);
    assert.match(before.entries['link.txt'], /^symlink:/);
    fs.writeFileSync(outside, 'second');
    const after = shared.contentSnapshot(f.repo);
    assert.equal(after.entries['link.txt'], before.entries['link.txt']);
    assert.deepEqual(shared.diffContent(before, after), []);
    assert.deepEqual(after.gaps, []);
  } finally { f.cleanup(); }
});

test('audit lifecycle content snapshot reports repeated read failures as integrity gaps, distinct from deletion', async () => {
  const shared = await sharedModule();
  const f = fixture();
  try {
    const denied = { ...fs, readFileSync: ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(file).endsWith('a.ts')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return (fs.readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync };
    const first = shared.contentSnapshot(f.repo, { fs: denied });
    const second = shared.contentSnapshot(f.repo, { fs: denied });
    for (const snapshot of [first, second]) {
      assert.equal(snapshot.entries['src/a.ts'], 'unreadable');
      assert.ok(snapshot.gaps.some((g: string) => /src\/a\.ts unreadable \(EACCES\)/.test(g)), snapshot.gaps.join('\n'));
    }
    fs.rmSync(path.join(f.repo, 'src/a.ts'));
    const deleted = shared.contentSnapshot(f.repo);
    assert.equal(deleted.entries['src/a.ts'], 'missing');
    assert.deepEqual(deleted.gaps, []);
  } finally { f.cleanup(); }
});

const footers = (body: string) => body.match(/Run artifacts \(/g)?.length ?? 0;

test('audit lifecycle finalize interrupted after publication completes the report footer once on retry', async () => {
  const baseline = await baselineModule(); const audit = await finalizeModule();
  const f = fixture(); let relocated: string | undefined;
  try {
    await baseline.main({ root: f.repo, argv, ...counted(), buildMetrics: fakeMetrics });
    const work = path.join(f.repo, WORK), report = path.join(f.repo, REPORT); fs.writeFileSync(report, '# audit');
    const crash = () => { throw new Error('interrupted before the footer'); };
    assert.throws(() => audit.main({ root: f.repo, argv, appendReport: crash }), /interrupted before the footer/);
    const manifest = JSON.parse(fs.readFileSync(path.join(work, 'manifest.json'), 'utf8'));
    assert.equal(manifest.relocation.phase, 'published'); assert.equal(manifest.relocation.integrity, 'unchanged');
    relocated = manifest.relocation.destination;
    audit.main({ root: f.repo, argv }); audit.main({ root: f.repo, argv });
    const body = fs.readFileSync(report, 'utf8');
    assert.equal(footers(body), 1); assert.equal(relocatedFrom(body), relocated!.split(path.sep).join('/'));
    assert.match(body, /Repo integrity: unchanged/); assert.equal(fs.existsSync(work), false);
  } finally { if (relocated) fs.rmSync(relocated, { recursive: true, force: true }); f.cleanup(); }
});

test('audit lifecycle finalize interrupted after source removal keeps the single authoritative footer on retry', async () => {
  const baseline = await baselineModule(); const audit = await finalizeModule();
  const f = fixture(); let relocated: string | undefined;
  try {
    await baseline.main({ root: f.repo, argv, ...counted(), buildMetrics: fakeMetrics });
    const work = path.join(f.repo, WORK), report = path.join(f.repo, REPORT); fs.writeFileSync(report, '# audit');
    const removeDir = (dir: string) => { fs.rmSync(dir, { recursive: true, force: true }); throw new Error('interrupted after removal'); };
    assert.throws(() => audit.main({ root: f.repo, argv, removeDir }), /interrupted after removal/);
    assert.equal(fs.existsSync(work), false);
    audit.main({ root: f.repo, argv });
    const body = fs.readFileSync(report, 'utf8'); relocated = relocatedFrom(body);
    assert.equal(footers(body), 1); assert.ok(relocated && fs.existsSync(path.join(relocated, 'manifest.json')));
    assert.match(body, /Repo integrity: unchanged/); assert.doesNotMatch(body, /Run artifacts[^:]*: none/);
  } finally { if (relocated) fs.rmSync(relocated, { recursive: true, force: true }); f.cleanup(); }
});
