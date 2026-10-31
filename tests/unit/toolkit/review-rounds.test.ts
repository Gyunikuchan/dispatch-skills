import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import type { CliDeps } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { CLEAN, CONTEXT_MAP, fixture, report } from '../../helpers/review-fixture.ts';

// SECTION: Later-round roster policy

const targetSlots = (metadata: {roster: {slot: string; reserve: boolean}[]}) => metadata.roster.filter(slot => !slot.reserve).map(slot => slot.slot);
const promptsOf = (f: Awaited<ReturnType<typeof fixture>>) => f.launches.map(launch => fs.readFileSync(launch.request.promptPath, 'utf8'));
const cleanDelegate = (f: Awaited<ReturnType<typeof fixture>>): CliDeps['delegate'] => async (provider, request, mode) => {
  f.launches.push({provider, request, mode});
  return {outcome: {status: 'ok', text: CLEAN, resume: null, sessionId: null}, invocations: []};
};

test('roster: later rounds keep every target after an accepted MUST', async () => {
  const f = await fixture();
  try {
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: report('§ Work', 'Concurrent writes overwrite captured results', 'MUST'), resume: null, sessionId: null}, invocations: []});
    assert.equal((await f.call()).exit, 0);
    const everyTarget = targetSlots(f.read(1, 'round.json'));
    await f.add('ruling', {subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Fixed'});
    fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
    assert.equal((await f.call()).exit, 0);
    assert.deepEqual(targetSlots(f.read(2, 'round.json')), everyTarget);
  } finally {f.cleanup();}
});

test('roster: later rounds keep every target after an accepted SHOULD below the cap', async () => {
  const f = await fixture();
  try {
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: report('§ Work', 'Retries are unbounded', 'SHOULD'), resume: null, sessionId: null}, invocations: []});
    assert.equal((await f.call()).exit, 0);
    const everyTarget = targetSlots(f.read(1, 'round.json'));
    await f.add('ruling', {subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Bound the retries'});
    fs.appendFileSync(f.plan, '\n## Fix\nBounded.\n');
    assert.equal((await f.call()).exit, 0);
    assert.deepEqual(targetSlots(f.read(2, 'round.json')), everyTarget);
  } finally {f.cleanup();}
});

test('roster: a CONSIDER-only round narrows the next round to its first target', async () => {
  const f = await fixture();
  try {
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: report('§ Work', 'Naming could be clearer', 'CONSIDER'), resume: null, sessionId: null}, invocations: []});
    assert.equal((await f.call()).exit, 0);
    const [first] = targetSlots(f.read(1, 'round.json'));
    assert.equal((await f.call()).exit, 0);
    assert.deepEqual(targetSlots(f.read(2, 'round.json')), [first]);
  } finally {f.cleanup();}
});

test('roster: an accepted MUST past the round cap keeps every target', async () => {
  const f = await fixture();
  try {
    let step = 0;
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: report('§ Work', 'Defect ' + step, 'MUST'), resume: null, sessionId: null}, invocations: []});
    const round = async () => {
      step++;
      assert.equal((await f.call()).exit, 0);
      await f.add('ruling', {subject: 'review:plan-work.plan:R' + step + '-F001', ruling: 'accepted', rationale: 'Resolution'});
      fs.appendFileSync(f.plan, '\n## Fix ' + step + '\nChanged.\n');
    };
    await round();
    const everyTarget = targetSlots(f.read(1, 'round.json'));
    await round();
    assert.equal((await f.call()).exit, 0);
    assert.deepEqual(targetSlots(f.read(3, 'round.json')), everyTarget);
  } finally {f.cleanup();}
});

test('roster: a narrowed round keeps the source slot of a pending rejection', async () => {
  const f = await fixture();
  try {
    let phase = 'finding';
    f.deps.delegate = async (provider, request) => {
      const ids = [...fs.readFileSync(request.promptPath, 'utf8').matchAll(/Request ID: `([^`]+)`/g)].map(match => match[1]!);
      if (phase === 'finding' && provider === 'agy') return {outcome: {status: 'ok', text: report('§ Work', 'Concurrent writes overwrite captured results', 'MUST'), resume: null, sessionId: null}, invocations: []};
      return {outcome: {status: 'ok', text: JSON.stringify({status: 'CLEAN', findings: [], confirmations: ids.map(requestId => ({requestId, decision: 'agree', rationale: 'Checked the captured isolation'}))}), resume: null, sessionId: null}, invocations: []};
    };
    assert.equal((await f.call()).exit, 0);
    const source = f.read(1, 'findings.json').findings[0].sources[0] as string;
    assert.equal(f.read(1, 'round.json').roster.find((slot: {slot: string}) => slot.slot === source).provider, 'agy');
    await f.add('ruling', {subject: 'review:plan-work.plan:R1-F001', ruling: 'rejected', rationale: 'The captured implementation prevents this'});
    phase = 'rejection';
    assert.equal((await f.call()).exit, 0);
    assert.ok(targetSlots(f.read(2, 'round.json')).includes(source));
  } finally {f.cleanup();}
});

// SECTION: Computed turn targets

function rangeGit(f: Awaited<ReturnType<typeof fixture>>, state: {feature: string}, diffs: Record<string, string[]>) {
  f.deps.run = async argv => {
    if (argv[1] === 'rev-parse') return {exit: 0, stdout: argv.at(-1) === 'feature^{commit}' ? state.feature : 'main-id', stderr: ''};
    if (argv[1] === 'diff') return {exit: 0, stdout: (diffs[argv[4] + '..' + argv[5]] ?? []).map(file => file + '\0').join(''), stderr: ''};
    return {exit: 0, stdout: '', stderr: ''};
  };
}
const roundMetadata = (f: Awaited<ReturnType<typeof fixture>>, dirName: string, round: number) => JSON.parse(fs.readFileSync(path.join(f.session, '.state/reviews', dirName, 'round-' + round, 'round.json'), 'utf8'));

test('turn target: code rounds count changed paths and re-reviews count only the delta', async () => {
  const f = await fixture();
  try {
    const state = {feature: 'feature-1'};
    rangeGit(f, state, {'main-id..feature-1': ['a.ts', 'b.ts'], 'feature-1..feature-2': ['c.ts'], 'main-id..feature-2': ['a.ts', 'b.ts', 'c.ts']});
    f.deps.delegate = cleanDelegate(f);
    assert.equal((await f.call('code', 'main..feature', 'low')).exit, 0);
    state.feature = 'feature-2';
    assert.equal((await f.call('code', 'main..feature', 'low')).exit, 0);
    const dirName = fs.readdirSync(path.join(f.session, '.state/reviews')).find(name => name.startsWith('code-main..feature-'))!;
    assert.equal(roundMetadata(f, dirName, 1).turnTarget, 10);
    assert.equal(roundMetadata(f, dirName, 2).turnTarget, 8);
  } finally {f.cleanup();}
});

test('turn target: plan review counts every distinct file entry without a cap', async () => {
  const f = await fixture();
  try {
    const entries = Array.from({length: 13}, (_, index) => `#### [NEW] src/file-${index + 1}.ts\n- Purpose: implements part ${index + 1}.`);
    const wide = ['# Wide', '## Task Map', '| ID | Title | Outcome | Prerequisites | Criteria |', '| --- | --- | --- | --- | --- |', '| T1 | Files | Works | none | SC1 |', '', '## Proposed Changes', '### T1 — Files', ...entries, '', '## Success Criteria', '- [SC1] Files work', '  - Changes: src/file-1.ts', '  - Verify: `node -e "process.exit(0)"`', '  - Evidence: verify', '', '## Verification Plan', '### Automated Tests', '- `node -e "process.exit(0)"`', ''].join('\n');
    const plan = f.artifact('wide.plan.md', wide);
    assert.equal((await f.call('plan', plan)).exit, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.session, '.state/reviews/plan-wide.plan/round-1/round.json'), 'utf8')).turnTarget, 32);
  } finally {f.cleanup();}
});

test('turn target: design review counts distinct increment graph paths', async () => {
  const f = await fixture();
  try {
    f.deps.delegate = cleanDelegate(f);
    const design = f.artifact('strategy.design.md', ['# Strategy', '## Increment Dependency Graph', '| ID | Priority | Summary | Prerequisites | Paths |', '| --- | --- | --- | --- | --- |', '| I01 | 1 | Core | none | src/a.ts, src/b.ts |', '| I02 | 2 | Edge | I01 | src/b.ts, src/c.ts |', ''].join('\n'));
    assert.equal((await f.call('design', design)).exit, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.session, '.state/reviews/design-strategy.design/round-1/round.json'), 'utf8')).turnTarget, 12);
  } finally {f.cleanup();}
});

// SECTION: Context map routing

const contextLine = (f: Awaited<ReturnType<typeof fixture>>, file: string) => '- Context Map: ' + path.join(f.session, file) + ' — pre-change index; verify claims at source.';

test('context map: plan review names the session map beside the spec hash', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.session, 'work.context.md'), CONTEXT_MAP);
    assert.equal((await f.call()).exit, 0);
    const prompts = promptsOf(f);
    assert.ok(prompts.length > 0);
    for (const prompt of prompts) {
      const lines = prompt.split('\n');
      assert.equal(lines[lines.findIndex(line => line.startsWith('- Spec Hash: ')) + 1], contextLine(f, 'work.context.md'));
    }
  } finally {f.cleanup();}
});

test('context map: plan review without a session map renders no map line', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call()).exit, 0);
    const prompts = promptsOf(f);
    assert.ok(prompts.length > 0);
    for (const prompt of prompts) assert.doesNotMatch(prompt, /Context Map/);
  } finally {f.cleanup();}
});

test('context map: design review names the session map of the same slug', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.session, 'strategy.context.md'), CONTEXT_MAP);
    f.deps.delegate = cleanDelegate(f);
    const design = f.artifact('strategy.design.md', '# Strategy\n## Boundaries\nA boundary.\n');
    assert.equal((await f.call('design', design)).exit, 0);
    const prompts = promptsOf(f);
    assert.ok(prompts.length > 0);
    for (const prompt of prompts) assert.equal(prompt.split('\n').filter(line => line === contextLine(f, 'strategy.context.md')).length, 1);
  } finally {f.cleanup();}
});

test('context map: code review never receives a session map', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.session, 'work.context.md'), CONTEXT_MAP);
    rangeGit(f, {feature: 'feature-1'}, {'main-id..feature-1': ['a.ts']});
    f.deps.delegate = cleanDelegate(f);
    assert.equal((await f.call('code', 'main..feature', 'low')).exit, 0);
    const prompts = promptsOf(f);
    assert.ok(prompts.length > 0);
    for (const prompt of prompts) assert.doesNotMatch(prompt, /Context Map/);
  } finally {f.cleanup();}
});
