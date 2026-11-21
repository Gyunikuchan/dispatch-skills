import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { setupTestSkill, toolkitRepo } from './helpers/toolkit-repo.ts';
import { appendRecord } from '../../skills/dispatch/scripts/toolkit/ledger.ts';
import { consumerSearchArgs } from '../../skills/dispatch/scripts/toolkit/domain/fix-check.ts';

type Repo = Awaited<ReturnType<typeof toolkitRepo>>;
type Second = Awaited<ReturnType<Repo['second']>>;

const REPORT = JSON.stringify({status: 'FINDINGS', findings: [{impact: 'degrades', trigger: 'realistic', tag: 'reliability', locus: '§ Work', defect: 'Writes overlap', requiredChange: 'Serialize writes'}]});

// Names a naive pathspec or grep would mishandle: a leading dash, a glob class, and a bare paren.
const LISTED = ['-x', 'foo(', 'a.b[1].txt'];

// The hit file names from `git grep -n` output, one per matching line.
const hitFiles = (stdout: string): Set<string> =>
  new Set(stdout.split('\n').filter(Boolean).map(line => line.slice(0, line.indexOf(':'))));

// A repository whose second session briefs the plan; the test writes its files before reviewAndAccept.
async function startRepo(): Promise<{f: Repo; g: Second}> {
  const f = await toolkitRepo();
  f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'skill', {
    'read-delegates': {claude: {targets: [{low: {model: 'fake'}}]}, agy: {targets: [{low: {model: 'fake'}}]}},
    phases: {'plan-review': {targets: {low: 0, medium: 2}, rounds: {low: 0, medium: 2}}},
  });
  f.deps.liveness = {claude: true, agy: true, codex: true, copilot: true, opencode: true};
  f.deps.orchestrator = null;
  f.deps.modes = () => ['cli'] as never;
  f.deps.delegate = async () => ({outcome: {status: 'ok', text: REPORT, resume: null, sessionId: null}, invocations: []});
  // The second session lives under the sessions root, which the brief excludes from search.
  const g = await f.second('20261023T0001Z-brief');
  return {f, g};
}

// Reviews the plan from the second session and accepts its only finding; the caller then appends the fix.
async function reviewAndAccept(f: Repo, g: Second): Promise<void> {
  const reviewed = await g.run(['review', 'run', 'work.plan.md', '--kind', 'plan', '--level', 'medium']);
  assert.equal(reviewed.exit, 0, JSON.stringify(reviewed.output));
  await appendRecord(g.session, {kind: 'ruling', by: 'orchestrator', key: 'accept-R1-F001', data: {subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Serialize writes'}}, f.deps);
}

test('brief fix-check on a real repository lists, diffs and searches literal names', async () => {
  const {f, g} = await startRepo();
  try {
    fs.writeFileSync(path.join(f.root, '-x'), 'untracked\n');
    fs.writeFileSync(path.join(f.root, 'foo('), 'untracked\n');
    fs.writeFileSync(path.join(f.root, 'a.b[1].txt'), 'tracked\n');
    f.git(['add', '--', ':(literal)a.b[1].txt']);
    f.git(['commit', '-m', 'tracked names']);
    fs.writeFileSync(path.join(f.root, 'src/consumer.ts'), "export const names = ['-x', 'a.b[1].txt', 'foo('];\n");
    fs.writeFileSync(path.join(f.root, 'src/secrets.ts'), "export const secret = '-x';\n");
    fs.writeFileSync(path.join(f.root, '.env'), 'TOKEN=-x\n');
    // A sensitive listed path with a space: excluded from search as a glob, and withheld as unsafe.
    fs.mkdirSync(path.join(f.root, 'ops'), {recursive: true});
    fs.writeFileSync(path.join(f.root, 'ops/my secrets.env'), 'TOKEN=-x\n');
    fs.appendFileSync(path.join(f.root, '.gitignore'), 'skipped.txt\n');
    fs.writeFileSync(path.join(f.root, 'skipped.txt'), '-x\n');
    fs.writeFileSync(path.join(g.session, 'notes.md'), '-x\n');

    await reviewAndAccept(f, g);
    // Citations cover a listed untracked name, a listed tracked name with a glob class, and an ignored file.
    fs.appendFileSync(path.join(f.root, 'work.plan.md'), '\n## Fix\nSee `-x:1`, `foo(:1`, `a.b[1].txt:1`, `skipped.txt:1` and `missing.ts:1`.\n');

    const brief = await g.run(['brief', 'fix-check', 'work.plan.md']);
    assert.equal(brief.exit, 0, JSON.stringify(brief.output));
    const text = fs.readFileSync(brief.value.briefPath, 'utf8');

    // The brief's own listing keeps every listed name and withholds the ignored file.
    assert.equal(brief.value.citations, LISTED.length);
    for (const name of LISTED) assert.ok(text.includes(`\`${name}:1\``), name);
    assert.ok(text.includes('`skipped.txt`: not listed'));
    assert.ok(text.includes('`missing.ts`: no match'));
    assert.equal(brief.value.unresolved, 1);
    // Sensitive paths are search excludes; only the ignored file and the unsafe sensitive path are withheld.
    assert.equal(brief.value.withheld, 2);
    assert.match(brief.output.summary, /3 citations, 1 unresolved, 2 withheld/);

    // The diff is the real git diff of the round input against the governed plan.
    const diff = fs.readFileSync(brief.value.diffPath, 'utf8');
    assert.match(diff, /^\+See `-x:1`, `foo\(:1`, `a\.b\[1\]\.txt:1`/m);

    // Excludes come from the rendered command, so the check covers what the explorer runs.
    const excludes = [...text.matchAll(/":\(exclude,(?:literal|glob)\)([^"]+)"/g)].map(match => match[1]!).sort();
    assert.deepEqual(excludes, ['.env', '.scratch/dispatch-skills', 'ops/my?secrets.env', 'src/secrets.ts']);
    const search = (name: string) => spawnSync('git', consumerSearchArgs(excludes, name), {cwd: f.root, encoding: 'utf8', windowsHide: true});

    const dash = search('-x');
    assert.equal(dash.status, 0, dash.stderr);
    const dashHits = hitFiles(dash.stdout);
    assert.ok(dashHits.has('src/consumer.ts'));
    for (const hit of ['.env', 'ops/my secrets.env', 'src/secrets.ts', 'skipped.txt']) assert.ok(!dashHits.has(hit), hit);
    assert.ok(![...dashHits].some(hit => hit.startsWith('.scratch/')), 'sessions root excluded');

    const bracket = search('a.b[1].txt');
    assert.equal(bracket.status, 0, bracket.stderr);
    assert.ok(hitFiles(bracket.stdout).has('src/consumer.ts'));

    const paren = search('foo(');
    assert.equal(paren.status, 0, paren.stderr);
    assert.ok(hitFiles(paren.stdout).has('src/consumer.ts'));
  } finally {
    f.cleanup();
  }
});

test('brief fix-check keeps a listed unrenderable citation out of the consumer search hits', async () => {
  const {f, g} = await startRepo();
  try {
    fs.mkdirSync(path.join(f.root, '{{x}}'), {recursive: true});
    fs.writeFileSync(path.join(f.root, '{{x}}/a.md'), 'marker -x\n');
    fs.writeFileSync(path.join(f.root, 'src/consumer.ts'), "export const names = ['-x'];\n");
    await reviewAndAccept(f, g);
    fs.appendFileSync(path.join(f.root, 'work.plan.md'), '\n## Fix\nSee `{{x}}/a.md:1`.\n');

    const brief = await g.run(['brief', 'fix-check', 'work.plan.md']);
    assert.equal(brief.exit, 0, JSON.stringify(brief.output));
    const text = fs.readFileSync(brief.value.briefPath, 'utf8');
    const excludes = [...text.matchAll(/":\(exclude,(?:literal|glob)\)([^"]+)"/g)].map(match => match[1]!).sort();
    assert.deepEqual(excludes, ['.scratch/dispatch-skills', '??x??/a.md']);

    const search = spawnSync('git', consumerSearchArgs(excludes, '-x'), {cwd: f.root, encoding: 'utf8', windowsHide: true});
    assert.equal(search.status, 0, search.stderr);
    const hits = hitFiles(search.stdout);
    assert.ok(hits.has('src/consumer.ts'));
    assert.ok(!hits.has('{{x}}/a.md'), 'listed unrenderable citation is not a search hit');
  } finally {
    f.cleanup();
  }
});

test('brief fix-check withholds a symlink that resolves outside the repository', async t => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-check-outside-'));
  const {f, g} = await startRepo();
  try {
    const target = path.join(outside, 'secret.ts');
    fs.writeFileSync(target, 'export const x = 1;\n');
    try {
      fs.symlinkSync(target, path.join(f.root, 'linked.ts'), 'file');
    } catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('symlink creation needs a privilege this host lacks');
        return;
      }
      throw error;
    }
    await reviewAndAccept(f, g);
    fs.appendFileSync(path.join(f.root, 'work.plan.md'), '\n## Fix\nSee `linked.ts:1`.\n');

    const brief = await g.run(['brief', 'fix-check', 'work.plan.md']);
    assert.equal(brief.exit, 0, JSON.stringify(brief.output));
    const text = fs.readFileSync(brief.value.briefPath, 'utf8');
    assert.ok(text.includes('`linked.ts`: outside repository'));
    assert.ok(!text.includes('`linked.ts:1`'));
  } finally {
    f.cleanup();
    fs.rmSync(outside, {recursive: true, force: true});
  }
});
