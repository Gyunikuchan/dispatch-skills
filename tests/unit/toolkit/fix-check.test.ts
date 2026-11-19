import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { appendRecord } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { fixture, report } from '../../helpers/review-fixture.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
type GitResult = {exit: number; stdout: string; stderr: string};

const DIFF = [
  '--- a/work.plan.md', '+++ b/work.plan.md', '@@ -1 +1,3 @@',
  ' # Work', '+', '+Writes are serialized; see `skills/writer.ts:12-30`.',
].join('\n') + '\n';

const put = (f: Fixture, rel: string, text = 'export const value = 1;\n') => {
  const file = path.join(f.root, rel);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, text);
};

// Scripts only the Git reads fix-check makes: the repository listing and the round diff.
const gitStub = (f: Fixture, listing: string[], diff: (argv: string[]) => GitResult = () => ({exit: 1, stdout: DIFF, stderr: ''})) => {
  const calls: string[][] = [];
  f.deps.run = async argv => {
    calls.push(argv);
    if (argv[1] === 'ls-files') return {exit: 0, stdout: listing.map(file => file + '\0').join(''), stderr: ''};
    if (argv[1] === 'diff') return diff(argv);
    throw new Error('Unexpected Git argv ' + JSON.stringify(argv));
  };
  return calls;
};

const brief = async (f: Fixture, artifact = f.plan) => {
  f.lines.length = 0;
  // The fixture copies only the review templates; the fix-check template is read from the skill root.
  fs.copyFileSync(path.resolve('skills/dispatch/references/templates/fix-check-brief.md'), path.join(f.deps.skillRoot, 'references', 'templates', 'fix-check-brief.md'));
  const exit = await main(['brief', 'fix-check', artifact, '--session', f.session, '--host', 'claude'], f.deps);
  const output = f.output();
  const value = output.path ? JSON.parse(fs.readFileSync(output.path, 'utf8')) as Record<string, any> : null;
  return {exit, output, value, text: typeof value?.['briefPath'] === 'string' ? fs.readFileSync(value['briefPath'], 'utf8') : ''};
};

// One plan round whose only finding is accepted, then a fix appended to the plan.
const reviewed = async (f: Fixture) => {
  assert.equal((await f.call()).exit, 0);
  await f.add('ruling', {subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Serialized writes fix it'});
  fs.appendFileSync(f.plan, '\n## Fix\nWrites are serialized; see `skills/writer.ts:12-30`.\n');
};

const briefFiles = (f: Fixture) => {
  const dir = path.join(f.session, '.state', 'briefs');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.startsWith('fix-check-')) : [];
};

test('fix-check brief: states the repository root, relative paths, readable paths, diff and reading bound', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    put(f, 'skills/writer.ts');
    gitStub(f, ['skills/writer.ts']);
    const {exit, value, text} = await brief(f);
    assert.equal(exit, 0);
    assert.ok(text.includes(fs.realpathSync(f.root)), 'repository root is named');
    assert.match(text, /relative paths? resolve against/i);
    assert.ok(text.includes(value!['diffPath']), 'diff path is readable');
    assert.ok(!text.includes('round-1.input.md'), 'round input is not listed');
    assert.equal(fs.readFileSync(value!['diffPath'], 'utf8'), DIFF);
    assert.ok(text.includes(f.plan) || text.includes(path.basename(f.plan)), 'artifact is readable');
    assert.match(text, /## Reading bound/);
    assert.match(text, /never read a withheld path, even as a search hit/);
    assert.doesNotMatch(text, /\{\{\w+\}\}/);
  } finally { f.cleanup(); }
});

test('fix-check brief: cites added-line references only and withholds nothing in the repository', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    put(f, 'skills/writer.ts');
    put(f, 'skills/context.ts');
    gitStub(f, ['skills/writer.ts', 'skills/context.ts'], () => ({exit: 1, stderr: '', stdout: [
      '--- a/work.plan.md', '+++ b/work.plan.md', '@@ -1,3 +1,3 @@',
      ' context `skills/context.ts:1`', '-removed `skills/removed.ts:2`', '+added `skills/writer.ts:12-30`',
    ].join('\n') + '\n'}));
    const {exit, value, text} = await brief(f);
    assert.equal(exit, 0);
    assert.equal(value!['citations'], 1);
    assert.equal(value!['withheld'], 0);
    assert.ok(text.includes('`skills/writer.ts:12-30`'));
    assert.ok(!text.includes('skills/context.ts'));
    assert.ok(!text.includes('skills/removed.ts'));
  } finally { f.cleanup(); }
});

test('fix-check brief: carries the quality-bar evidence line once and no host rule text', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    put(f, 'skills/writer.ts');
    gitStub(f, ['skills/writer.ts']);
    const {exit, text} = await brief(f);
    assert.equal(exit, 0);
    assert.equal(text.match(/^- Evidence:/gm)?.length, 1);
    assert.ok(!text.includes('Host rule files'));
  } finally { f.cleanup(); }
});

test('fix-check brief: launch values come from the utility entry of the host', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    put(f, 'skills/writer.ts');
    gitStub(f, ['skills/writer.ts']);
    fs.writeFileSync(path.join(f.deps.skillRoot, 'config.jsonc'), JSON.stringify({
      'read-delegates': {codex: {targets: [{low: {model: 'reader'}}]}},
      'utility-subagents': {claude: {model: 'haiku', effort: 'medium', 'context-limit': 150000}},
    }));
    const {exit, value} = await brief(f);
    assert.equal(exit, 0);
    assert.deepEqual(value!['model'], ['haiku']);
    assert.equal(value!['effort'], 'medium');
    assert.equal(value!['contextLimit'], 150000);
    assert.match(value!['launchAs'], /haiku/);
  } finally { f.cleanup(); }
});

test('fix-check selection: picks the latest round of this artifact when a same-basename artifact has a later round', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    const other = path.join(f.root, 'other', 'work.plan.md');
    put(f, 'other/work.plan.md', '# Other\n## Work\nAnother body.\n');
    assert.equal(await main(['review', 'run', other, '--kind', 'plan', '--level', 'medium', '--session', f.session, '--host', 'opencode'], f.deps), 0);
    put(f, 'skills/writer.ts');
    gitStub(f, ['skills/writer.ts']);
    const {exit, value} = await brief(f);
    assert.equal(exit, 0);
    assert.equal(value!['round'], 1);
  } finally { f.cleanup(); }
});

test('fix-check selection: an artifact outside the repository renders and collides with no repository review', async () => {
  const f = await fixture();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-check-outside-'));
  try {
    const outside = path.join(outsideDir, 'work.plan.md');
    fs.writeFileSync(outside, '# Outside\n## Work\nOutside body.\n');
    assert.equal(await main(['review', 'run', outside, '--kind', 'plan', '--level', 'medium', '--session', f.session, '--host', 'opencode'], f.deps), 0);
    await f.add('ruling', {subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Serialized writes fix it'});
    fs.appendFileSync(outside, '\n## Fix\nChanged.\n');
    put(f, 'skills/writer.ts');
    gitStub(f, ['skills/writer.ts']);
    const {exit, value} = await brief(f, outside);
    assert.equal(exit, 0);
    assert.equal(value!['round'], 1);
  } finally {
    fs.rmSync(outsideDir, {recursive: true, force: true});
    f.cleanup();
  }
});

test('fix-check selection: works with no bind record', async () => {
  const f = await fixture(false);
  try {
    assert.equal(await main(['review', 'run', f.plan, '--kind', 'plan', '--level', 'medium', '--session', f.session, '--host', 'opencode', '--spec', f.spec], f.deps), 0);
    await f.add('ruling', {subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Serialized writes fix it'});
    fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
    put(f, 'skills/writer.ts');
    gitStub(f, ['skills/writer.ts']);
    const {exit, value} = await brief(f);
    assert.equal(exit, 0);
    assert.equal(value!['round'], 1);
  } finally { f.cleanup(); }
});

test('fix-check refusals: a round without artifactPath, an unreviewed artifact and a code-review artifact refuse without files', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    put(f, 'skills/writer.ts');
    gitStub(f, ['skills/writer.ts']);
    const roundFile = path.join(f.directory, 'round-1', 'round.json');
    const metadata = JSON.parse(fs.readFileSync(roundFile, 'utf8'));
    delete metadata.artifactPath;
    fs.writeFileSync(roundFile, JSON.stringify(metadata));
    const missing = await brief(f);
    assert.equal(missing.exit, 4);
    assert.equal(missing.output.reason, 'nothing-to-review');
    assert.deepEqual(briefFiles(f), []);

    put(f, 'unreviewed.plan.md', '# Unreviewed\n');
    const unreviewed = await brief(f, path.join(f.root, 'unreviewed.plan.md'));
    assert.equal(unreviewed.output.reason, 'nothing-to-review');

    put(f, 'change.code.md', '# Code\n');
    const code = await brief(f, path.join(f.root, 'change.code.md'));
    assert.equal(code.exit, 1);
    assert.equal(code.output.reason, 'invalid-input');
  } finally { f.cleanup(); }
});

test('fix-check refusals: no accepted finding refuses', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call()).exit, 0);
    fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
    put(f, 'skills/writer.ts');
    gitStub(f, ['skills/writer.ts']);
    const {exit, output} = await brief(f);
    assert.equal(exit, 4);
    assert.equal(output.reason, 'nothing-to-review');
    assert.deepEqual(briefFiles(f), []);
  } finally { f.cleanup(); }
});

test('fix-check refusals: no change since the round input refuses and leaves no file', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    put(f, 'skills/writer.ts');
    gitStub(f, ['skills/writer.ts'], () => ({exit: 0, stdout: '', stderr: ''}));
    const {exit, output} = await brief(f);
    assert.equal(exit, 4);
    assert.equal(output.reason, 'nothing-to-review');
    assert.deepEqual(briefFiles(f), []);
  } finally { f.cleanup(); }
});

test('fix-check refusals: an unexpected diff exit is a fault and leaves no file', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    put(f, 'skills/writer.ts');
    gitStub(f, ['skills/writer.ts'], () => ({exit: 1, stdout: '', stderr: 'access denied'}));
    const {exit, output} = await brief(f);
    assert.equal(exit, 2);
    assert.equal(output.reason, 'fault');
    assert.deepEqual(briefFiles(f), []);
  } finally { f.cleanup(); }
});

test('fix-check refusals: an unreadable spec refuses', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    put(f, 'skills/writer.ts');
    gitStub(f, ['skills/writer.ts']);
    fs.unlinkSync(f.spec);
    const {exit, output} = await brief(f);
    assert.equal(exit, 1);
    assert.equal(output.reason, 'invalid-input');
  } finally { f.cleanup(); }
});

test('fix-check spec: an unchanged spec names one governing path and no snapshot', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    put(f, 'skills/writer.ts');
    gitStub(f, ['skills/writer.ts']);
    const {text} = await brief(f);
    assert.ok(text.includes(fs.realpathSync(f.spec)));
    assert.doesNotMatch(text, /unavailable/);
  } finally { f.cleanup(); }
});

test('fix-check spec: drift names the reviewed snapshot as the reviewed text', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    fs.appendFileSync(f.spec, '\n### REQ-2 — Added later\n');
    put(f, 'skills/writer.ts');
    gitStub(f, ['skills/writer.ts']);
    const {exit, text} = await brief(f);
    assert.equal(exit, 0);
    assert.ok(text.includes(path.join(f.directory, 'round-1', 'spec.snapshot.md')));
    assert.doesNotMatch(text, /unavailable/);
  } finally { f.cleanup(); }
});

test('fix-check spec: drift without a snapshot states the reviewed spec text is unavailable', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    fs.appendFileSync(f.spec, '\n### REQ-2 — Added later\n');
    fs.rmSync(path.join(f.directory, 'round-1', 'spec.snapshot.md'), {force: true});
    put(f, 'skills/writer.ts');
    gitStub(f, ['skills/writer.ts']);
    const {exit, text} = await brief(f);
    assert.equal(exit, 0);
    assert.match(text, /reviewed spec text is unavailable/);
  } finally { f.cleanup(); }
});

test('fix-check withholding: sensitive, outside, session, unlisted and missing citations are withheld with reasons', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    const sensitive = ['.env', 'deploy/service-account.json', '.ssh/config', 'src/secrets.ts', 'Config/API_TOKEN.txt'];
    for (const file of sensitive) put(f, file);
    put(f, 'skills/writer.ts');
    put(f, 'ignored/y.ts');
    const sessionRel = path.relative(f.root, f.session).split(path.sep).join('/');
    put(f, sessionRel + '/notes.md');
    put(f, '.scratch/dispatch-skills/20261022T0000Z-other/a.md');
    put(f, sessionRel + '/.state/briefs/x.md');
    const listing = [...sensitive, 'skills/writer.ts', sessionRel + '/notes.md', '.scratch/dispatch-skills/20261022T0000Z-other/a.md', sessionRel + '/.state/briefs/x.md'];
    const cited = [...sensitive, 'skills/writer.ts', 'ignored/y.ts', 'missing.ts', '../x.md', '.scratch/dispatch-skills/20261022T0000Z-other/a.md', sessionRel + '/notes.md', sessionRel + '/.state/briefs/x.md'];
    const diff = [
      '--- a/work.plan.md', '+++ b/work.plan.md', '@@ -1 +1,20 @@',
      ...cited.map(file => '+Cites `' + file + ':1`.'),
    ].join('\n') + '\n';
    gitStub(f, listing, () => ({exit: 1, stdout: diff, stderr: ''}));
    const {exit, value, text} = await brief(f);
    assert.equal(exit, 0);
    for (const file of sensitive) assert.ok(text.includes('`' + file + '`: sensitive'), file);
    assert.ok(text.includes('`../x.md`: outside repository'));
    assert.ok(text.includes('`.scratch/dispatch-skills/20261022T0000Z-other/a.md`: session'));
    assert.ok(text.includes('`' + sessionRel + '/.state/briefs/x.md`: session'));
    assert.ok(text.includes('`ignored/y.ts`: not listed'));
    assert.ok(text.includes('`missing.ts`: missing'));
    assert.ok(text.includes('`' + sessionRel + '/notes.md:1`') || text.includes('`' + sessionRel + '/notes.md`'), 'current session artifact is kept');
    assert.ok(text.includes('`skills/writer.ts:1`'));
    assert.equal(value!['withheld'], sensitive.length + 5);
  } finally { f.cleanup(); }
});

test('fix-check consumer search: excludes the sessions root and each flagged listed path, unsafe paths as globs', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    put(f, 'skills/writer.ts');
    put(f, '.env');
    put(f, 'src/secrets.ts');
    put(f, 'weird secret.txt');
    gitStub(f, ['skills/writer.ts', '.env', 'src/secrets.ts', 'weird secret.txt']);
    const {exit, text} = await brief(f);
    assert.equal(exit, 0);
    assert.match(text, /git grep -n -I -F --untracked -e <name> -- \. /);
    assert.ok(!text.includes('-l -I'), 'no names-only fallback');
    assert.ok(text.includes('":(exclude,literal).scratch/dispatch-skills"'));
    assert.ok(text.includes('":(exclude,literal).env"'));
    assert.ok(text.includes('":(exclude,literal)src/secrets.ts"'));
    assert.ok(text.includes('":(exclude,glob)weird?secret.txt"'));
    assert.ok(text.includes('`weird secret.txt`: sensitive'));
    assert.match(text, /add `-w` before `-e`/);
  } finally { f.cleanup(); }
});

test('fix-check citations: a leading ./ normalizes to the repository path, so one citation is kept once', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    put(f, 'skills/writer.ts');
    const diff = ['--- a/work.plan.md', '+++ b/work.plan.md', '@@ -1 +1,3 @@', ' # Work', '+Cites `./skills/writer.ts:12` and `skills/writer.ts:12`.'].join('\n') + '\n';
    gitStub(f, ['skills/writer.ts'], () => ({exit: 1, stdout: diff, stderr: ''}));
    const {exit, value, text} = await brief(f);
    assert.equal(exit, 0);
    assert.ok(!text.includes('./skills'), 'no unnormalized path');
    assert.equal(text.split('`skills/writer.ts:12`').length - 1, 1);
    assert.equal(value!['citations'], 1);
  } finally { f.cleanup(); }
});

test('fix-check spec: a rewritten snapshot that no longer matches the round hash is unavailable', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    fs.appendFileSync(f.spec, '\n### REQ-2 — Added later\n');
    fs.writeFileSync(path.join(f.directory, 'round-1', 'spec.snapshot.md'), '# Rewritten\n');
    put(f, 'skills/writer.ts');
    gitStub(f, ['skills/writer.ts']);
    const {exit, text} = await brief(f);
    assert.equal(exit, 0);
    assert.match(text, /reviewed spec text is unavailable/);
    assert.ok(!text.includes(path.join(f.directory, 'round-1', 'spec.snapshot.md')));
  } finally { f.cleanup(); }
});

test('fix-check consumer search: a session outside the repository adds no sessions-root exclude', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    // The repository is a subfolder of the virtual root, so the session and its sessions root sit outside it.
    const repo = path.join(f.root, 'repo');
    fs.mkdirSync(repo, {recursive: true});
    const manifest = path.join(f.session, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({...JSON.parse(fs.readFileSync(manifest, 'utf8')), repositoryRoot: fs.realpathSync(repo)}));
    put(f, 'repo/skills/writer.ts');
    gitStub(f, ['skills/writer.ts']);
    const {exit, text} = await brief(f);
    assert.equal(exit, 0);
    assert.ok(text.includes('`skills/writer.ts:12-30`') || text.includes('`skills/writer.ts:12`'), 'repository citation kept');
    assert.ok(!text.includes(':(exclude'), 'no exclude for the outside sessions root');
  } finally { f.cleanup(); }
});

test('fix-check withholding: a sensitive listed path with braces renders withheld and as a glob exclude', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    const rel = '{{cookiecutter.slug}}/.env';
    put(f, rel);
    put(f, 'skills/writer.ts');
    gitStub(f, [rel, 'skills/writer.ts']);
    const {exit, text} = await brief(f);
    assert.equal(exit, 0);
    assert.ok(text.includes('`{ {cookiecutter.slug} }/.env`: sensitive'));
    assert.ok(text.includes(':(exclude,glob)??cookiecutter.slug??/.env'));
    assert.doesNotMatch(text, /\{\{cookiecutter/);
  } finally { f.cleanup(); }
});

test('fix-check citations: a name with braces or a link opener is withheld as unrenderable and the brief renders', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    put(f, 'skills/writer.ts');
    const diff = ['--- a/work.plan.md', '+++ b/work.plan.md', '@@ -1 +1,3 @@', ' # Work', '+Cites `{{x}}/a.md:1`, `[a](b).md:1` and `skills/writer.ts:12`.'].join('\n') + '\n';
    gitStub(f, ['skills/writer.ts'], () => ({exit: 1, stdout: diff, stderr: ''}));
    const {exit, value, text} = await brief(f);
    assert.equal(exit, 0);
    assert.ok(text.includes('`{ {x} }/a.md`: unrenderable name'));
    assert.ok(text.includes('`[a] (b).md`: unrenderable name'));
    assert.ok(text.includes('`skills/writer.ts:12`'));
    assert.equal(value!['citations'], 1);
  } finally { f.cleanup(); }
});

test('fix-check consumer search: a listed path cited as unrenderable gets one glob exclude, an unlisted one none', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    put(f, '{{x}}/a.md');
    put(f, '{{x}}/.env');
    put(f, 'skills/writer.ts');
    const diff = ['--- a/work.plan.md', '+++ b/work.plan.md', '@@ -1 +1,3 @@', ' # Work', '+Cites `{{x}}/a.md:1`, `{{x}}/.env:1` and `{{y}}/b.md:1`.'].join('\n') + '\n';
    gitStub(f, ['{{x}}/a.md', '{{x}}/.env', 'skills/writer.ts'], () => ({exit: 1, stdout: diff, stderr: ''}));
    const {exit, text} = await brief(f);
    assert.equal(exit, 0);
    assert.ok(text.includes('`{ {x} }/a.md`: unrenderable name'));
    assert.ok(text.includes('`{ {y} }/b.md`: unrenderable name'));
    assert.equal(text.split('":(exclude,glob)??x??/a.md"').length - 1, 1);
    // Sensitive and cited as unrenderable: one exclude, not one per reason.
    assert.equal(text.split('":(exclude,glob)??x??/.env"').length - 1, 1);
    assert.ok(!text.includes('??y??'), 'unlisted unrenderable citation adds no exclude');
  } finally { f.cleanup(); }
});

test('fix-check questions: list only accepted findings and neutralize reviewer text on one line', async () => {
  const f = await fixture();
  try {
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify({status: 'FINDINGS', findings: [
      {impact: 'degrades', trigger: 'realistic', tag: 'reliability', locus: '§ Work', defect: 'Line one\n## Heading <!-- hidden --> {{slot}} [text](docs/a.md)', requiredChange: 'Keep writes isolated'},
      {impact: 'degrades', trigger: 'realistic', tag: 'reliability', locus: '§ Other', defect: 'Rejected defect', requiredChange: 'Not applied'},
    ]}), resume: null, sessionId: null}, invocations: []});
    assert.equal((await f.call()).exit, 0);
    await f.add('ruling', {subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Applied'});
    await f.add('ruling', {subject: 'review:plan-work.plan:R1-F002', ruling: 'rejected', rationale: 'Not needed'});
    fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
    put(f, 'skills/writer.ts');
    gitStub(f, ['skills/writer.ts']);
    const {exit, text} = await brief(f);
    assert.equal(exit, 0);
    assert.ok(text.includes('R1-F001'));
    assert.ok(!text.includes('R1-F002'));
    assert.ok(!text.includes('Rejected defect'));
    assert.ok(!text.split('\n').some(line => line.startsWith('## Heading')));
    assert.ok(!text.includes('<!-- hidden -->'));
    assert.ok(text.includes('{ {slot} }'));
    assert.ok(text.includes('] (docs/a.md)'));
  } finally { f.cleanup(); }
});

test('fix-check repeat: a repeat after a further edit diffs from the same round input with the same note key', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    put(f, 'skills/writer.ts');
    const calls = gitStub(f, ['skills/writer.ts']);
    const first = await brief(f);
    assert.equal(first.exit, 0);
    fs.appendFileSync(f.plan, '\nAnother edit.\n');
    const second = await brief(f);
    assert.equal(second.exit, 0);
    const diffs = calls.filter(argv => argv[1] === 'diff');
    assert.equal(diffs.length, 2);
    const input = path.join(f.directory, 'round-1.input.md');
    assert.equal(diffs[0]!.at(-2), input);
    assert.equal(diffs[1]!.at(-2), input);
    assert.equal(first.value!['noteKey'], second.value!['noteKey']);
  } finally { f.cleanup(); }
});

test('fix-check advisory notes: the ordinal skips past existing keys, ignores other keys and a note under it appends', async () => {
  const f = await fixture();
  try {
    await reviewed(f);
    put(f, 'skills/writer.ts');
    gitStub(f, ['skills/writer.ts']);
    const prefix = 'fix-check:plan-work.plan:1:';
    for (const suffix of ['1', '3', 'x', '0']) {
      await appendRecord(f.session, {kind: 'note', by: 'orchestrator', key: prefix + suffix, data: {text: 'Checked <!-- odd --> text'}}, f.deps);
    }
    const {exit, value} = await brief(f);
    assert.equal(exit, 0);
    assert.equal(value!['noteKey'], prefix + '4');
    assert.equal((await appendRecord(f.session, {kind: 'note', by: 'orchestrator', key: value!['noteKey'], data: {text: 'Advisory result'}}, f.deps)).deduped, false);
  } finally { f.cleanup(); }
});
