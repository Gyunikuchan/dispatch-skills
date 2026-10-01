import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from '../helpers/e2e.ts';

const argv = ['node', 'audit', '--run', '2026-10-01-0636'];

test('rewrite SC7 baseline imports and writes current TypeScript test and metrics artifacts', async () => {
  const audit = await import(new URL('../../.agents/skills/audit-dispatch-skills/scripts/baseline.mjs', import.meta.url).href);
  const f = fixture();
  try {
    let selected: readonly string[] = [];
    const runTests = (root: string) => audit.runTests(root, (_command: string, args: readonly string[]) => { selected = args; return { stdout: 'tests 1\npass 1\nfail 0', stderr: '', status: 0 }; });
    await audit.main({ root: f.repo, argv, runTests, buildMetrics: async () => ({ markdown: '# fixture metrics', brokenCount: 0, hashLines: [] }) });
    const work = path.join(f.repo, '.scratch/audits/2026-10-01-0636-work');
    for (const name of ['git-status.txt', 'tests.txt', 'metrics.md']) assert.ok(fs.existsSync(path.join(work, name)));
    assert.ok(selected.includes('tests/**/*.test.ts')); assert.ok(selected.includes('--test-coverage-include=skills/**/*.ts'));
  } finally { f.cleanup(); }
});

test('rewrite SC7 probe imports current provider and config APIs and publishes discovery artifacts', async () => {
  const audit = await import(new URL('../../.agents/skills/audit-dispatch-skills/scripts/probe-dispatch.mjs', import.meta.url).href);
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.repo, 'skills'), { recursive: true }); fs.cpSync(f.skill, path.join(f.repo, 'skills/dispatch'), { recursive: true });
    assert.ok(audit.loadConfig(f.repo)?.['read-delegates']);
    await audit.main({ root: f.repo, argv: [...argv, '--discover-only', '--only', 'opencode'] });
    const work = path.join(f.repo, '.scratch/audits/2026-10-01-0636-work/dispatch');
    assert.ok(fs.existsSync(path.join(work, 'summary.md'))); assert.ok(fs.existsSync(path.join(work, 'results.json')));
    const summary = fs.readFileSync(path.join(work, 'summary.md'), 'utf8'); assert.match(summary, /Discovery/); assert.match(summary, /unverified/);
  } finally { f.cleanup(); }
});

test('rewrite SC7 finalization imports and preserves baseline tree comparison and relocation', async () => {
  const audit = await import(new URL('../../.agents/skills/audit-dispatch-skills/scripts/finalize.mjs', import.meta.url).href);
  const shared = await import(new URL('../../.agents/skills/audit-dispatch-skills/scripts/shared.mjs', import.meta.url).href);
  const f = fixture(); let relocated: string | undefined;
  try {
    const work = path.join(f.repo, '.scratch/audits/2026-10-01-0636-work'); fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, 'git-status.txt'), shared.auditGitStatus(f.repo) ?? '');
    const report = path.join(f.repo, '.scratch/audits/2026-10-01-0636-audit.md'); fs.writeFileSync(report, '# audit');
    audit.main({ root: f.repo, argv });
    const body = fs.readFileSync(report, 'utf8'); assert.match(body, /Repo integrity:/); assert.match(body, /unchanged/i);
    relocated = /Run artifacts[^:]*: `([^`]+)`/.exec(body)?.[1]; assert.ok(relocated); assert.ok(fs.existsSync(path.join(relocated!, 'git-status.txt'))); assert.equal(fs.existsSync(work), false);
  } finally { if (relocated) fs.rmSync(relocated, { recursive: true, force: true }); f.cleanup(); }
});

test('review fix baseline honors effective force argv and preserves existing baseline without it', async () => {
  const audit = await import(new URL('../../.agents/skills/audit-dispatch-skills/scripts/baseline.mjs', import.meta.url).href);
  const f = fixture();
  try {
    let runs = 0; const options = { root: f.repo, argv, runTests: () => { runs++; return { output: `generation ${runs}`, status: 0, totals: 'pass' }; }, buildMetrics: async () => ({ markdown: '# metrics', brokenCount: 0, hashLines: [] }) };
    await audit.main(options); await assert.rejects(audit.main(options), /baseline already exists/);
    assert.equal(runs, 1); await audit.main({ ...options, argv: [...argv, '--force'] }); assert.equal(runs, 2);
    assert.equal(fs.readFileSync(path.join(f.repo, '.scratch/audits/2026-10-01-0636-work/tests.txt'), 'utf8'), 'generation 2');
  } finally { f.cleanup(); }
});
