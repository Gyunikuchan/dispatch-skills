import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import type { CliDeps } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { rejectionState } from '../../../skills/dispatch/scripts/toolkit/confirmations.ts';
import { CLEAN, CONTEXT_MAP, fixture, report } from '../../helpers/review-fixture.ts';

// SECTION: Later-round roster policy

const targetSlots = (metadata: {roster: {slot: string; reserve: boolean}[]}) => metadata.roster.filter(slot => !slot.reserve).map(slot => slot.slot);
const promptsOf = (f: Awaited<ReturnType<typeof fixture>>) => f.launches.map(launch => fs.readFileSync(launch.request.promptPath, 'utf8'));
const cleanDelegate = (f: Awaited<ReturnType<typeof fixture>>): CliDeps['delegate'] => async (provider, request, mode) => {
  f.launches.push({provider, request, mode});
  return {outcome: {status: 'ok', text: CLEAN, resume: null, sessionId: null}, invocations: []};
};

test('roster: later rounds roster scoping and labeling reflect finding severity', async () => {
  // CONSIDER narrows next round to first target and labels narrowed scope
  {
    const f = await fixture();
    try {
      f.deps.delegate = async () => ({outcome: {status: 'ok', text: report('§ Work', 'Naming could be clearer', 'CONSIDER'), resume: null, sessionId: null}, invocations: []});
      assert.equal((await f.call()).exit, 0);
      const [first] = targetSlots(f.read(1, 'round.json'));
      assert.equal((await f.call()).exit, 0);
      assert.deepEqual(targetSlots(f.read(2, 'round.json')), [first]);
      assert.match(f.read(2, 'round.json').scope, /^Re-review round 2 \(narrowed\)/);
    } finally {f.cleanup();}
  }
  // Accepted MUST or SHOULD preserves every target and labels full scope
  for (const severity of ['MUST', 'SHOULD'] as const) {
    const f = await fixture();
    try {
      f.deps.delegate = async () => ({outcome: {status: 'ok', text: report('§ Work', 'Concurrent writes overwrite captured results', severity), resume: null, sessionId: null}, invocations: []});
      assert.equal((await f.call()).exit, 0);
      const everyTarget = targetSlots(f.read(1, 'round.json'));
      await f.add('ruling', {subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Fixed'});
      fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
      assert.equal((await f.call()).exit, 0);
      assert.deepEqual(targetSlots(f.read(2, 'round.json')), everyTarget);
      assert.match(f.read(2, 'round.json').scope, /^Re-review round 2 \(full\)/);
    } finally {f.cleanup();}
  }
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

test('context map: plan review renders phase map when present and omits line when absent', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call()).exit, 0);
    let prompts = promptsOf(f);
    assert.ok(prompts.length > 0);
    for (const prompt of prompts) assert.doesNotMatch(prompt, /Context Map/);

    f.launches.length = 0;
    fs.writeFileSync(path.join(f.session, 'work.plan.context.md'), CONTEXT_MAP);
    fs.writeFileSync(path.join(f.session, 'work.context.md'), CONTEXT_MAP);
    await f.add('ruling', {subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Fixed'});
    fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
    assert.equal((await f.call()).exit, 0);
    prompts = promptsOf(f);
    assert.ok(prompts.length > 0);
    for (const prompt of prompts) {
      const lines = prompt.split('\n');
      assert.equal(lines[lines.findIndex(line => line.startsWith('- Spec Hash: ')) + 1], contextLine(f, 'work.plan.context.md'));
      assert.doesNotMatch(prompt, /work\.context\.md/);
    }
  } finally {f.cleanup();}
});

test('context map: design review names the session map of the same slug', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.session, 'strategy.design.context.md'), CONTEXT_MAP);
    f.deps.delegate = cleanDelegate(f);
    const design = f.artifact('strategy.design.md', '# Strategy\n## Boundaries\nA boundary.\n');
    assert.equal((await f.call('design', design)).exit, 0);
    const prompts = promptsOf(f);
    assert.ok(prompts.length > 0);
    for (const prompt of prompts) assert.equal(prompt.split('\n').filter(line => line === contextLine(f, 'strategy.design.context.md')).length, 1);
  } finally {f.cleanup();}
});

test('context map: code review never receives a session map', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.session, 'work.plan.context.md'), CONTEXT_MAP);
    rangeGit(f, {feature: 'feature-1'}, {'main-id..feature-1': ['a.ts']});
    f.deps.delegate = cleanDelegate(f);
    assert.equal((await f.call('code', 'main..feature', 'low')).exit, 0);
    const prompts = promptsOf(f);
    assert.ok(prompts.length > 0);
    for (const prompt of prompts) assert.doesNotMatch(prompt, /Context Map/);
  } finally {f.cleanup();}
});

// SECTION: Corrected severity governs rounds

const CORRECTIONS = {
  consider: {impact: 'minor', trigger: 'contrived', rationale: 'impact and trigger: a cosmetic point on a contrived path'},
  should: {impact: 'degrades', trigger: 'realistic', rationale: 'impact: the Verify gate surfaces this gap'},
  must: {impact: 'blocks', trigger: 'realistic', rationale: 'impact: the promised outcome fails'},
} as const;
const correct = (f: Awaited<ReturnType<typeof fixture>>, id: string, to: keyof typeof CORRECTIONS) =>
  f.add('ruling', {subject: 'review:plan-work.plan:' + id, ruling: 'accepted', ...CORRECTIONS[to]});
const findingsDelegate = (severity: 'MUST' | 'SHOULD', counter: {step: number}): CliDeps['delegate'] => async () =>
  ({outcome: {status: 'ok', text: report('§ Work', 'Defect ' + counter.step, severity), resume: null, sessionId: null}, invocations: []});

test('corrected finding: a MUST downgraded to CONSIDER narrows the next roster, with or without a later plain ruling', async () => {
  for (const plainRulingAfter of [false, true]) {
    const f = await fixture();
    try {
      f.deps.delegate = findingsDelegate('MUST', {step: 1});
      assert.equal((await f.call()).exit, 0);
      const [first] = targetSlots(f.read(1, 'round.json'));
      await correct(f, 'R1-F001', 'consider');
      if (plainRulingAfter) await f.add('ruling', {subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Applied the fix'});
      fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
      assert.equal((await f.call()).exit, 0);
      assert.deepEqual(targetSlots(f.read(2, 'round.json')), [first]);
    } finally {f.cleanup();}
  }
});

test('corrected finding: corrected severity governs continuation and roster past the round cap', async () => {
  // MUST downgraded to SHOULD earns no continuation past cap
  {
    const f = await fixture();
    try {
      const counter = {step: 0};
      f.deps.delegate = findingsDelegate('MUST', counter);
      for (const id of ['R1-F001', 'R2-F001']) {
        counter.step++;
        assert.equal((await f.call()).exit, 0);
        await correct(f, id, 'should');
        fs.appendFileSync(f.plan, '\n## Fix ' + counter.step + '\nChanged.\n');
      }
      const refused = await f.call();
      assert.equal(refused.exit, 4);
      assert.equal(refused.output.reason, 'round-cap');
    } finally {f.cleanup();}
  }
  // SHOULD raised to MUST earns continuation and a full roster past the cap
  {
    const f = await fixture();
    try {
      const counter = {step: 0};
      f.deps.delegate = findingsDelegate('SHOULD', counter);
      let everyTarget: string[] = [];
      for (const id of ['R1-F001', 'R2-F001']) {
        counter.step++;
        assert.equal((await f.call()).exit, 0);
        if (id === 'R1-F001') everyTarget = targetSlots(f.read(1, 'round.json'));
        await correct(f, id, 'must');
        fs.appendFileSync(f.plan, '\n## Fix ' + counter.step + '\nChanged.\n');
      }
      assert.equal((await f.call()).exit, 0);
      assert.deepEqual(targetSlots(f.read(3, 'round.json')), everyTarget);
    } finally {f.cleanup();}
  }
});

test('corrected finding: the ruling snapshot lists a SHOULD raised to MUST and omits a MUST lowered to SHOULD', async () => {
  for (const [stored, to] of [['SHOULD', 'must'], ['MUST', 'should']] as const) {
    const f = await fixture();
    try {
      f.deps.delegate = findingsDelegate(stored, {step: 1});
      assert.equal((await f.call()).exit, 0);
      const ruling = await correct(f, 'R1-F001', to);
      fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
      assert.equal((await f.call()).exit, 0);
      assert.equal(f.read(2, 'round.json').rulingSnapshot, stored === 'SHOULD' ? JSON.stringify([['R1-F001', ruling.seq]]) : '[]');
    } finally {f.cleanup();}
  }
});

test('corrected finding: settled rows hide a rejected SHOULD that was raised to MUST until it is confirmed', async () => {
  const run = async (raise: boolean) => {
    const f = await fixture();
    try {
      let phase = 'finding';
      f.deps.delegate = async (provider, request, mode) => {
        f.launches.push({provider, request, mode});
        const ids = [...fs.readFileSync(request.promptPath, 'utf8').matchAll(/Request ID: `([^`]+)`/g)].map(match => match[1]!);
        if (phase === 'finding' && provider === 'agy') return {outcome: {status: 'ok', text: report('§ Work', 'Retries are unbounded', 'SHOULD'), resume: null, sessionId: null}, invocations: []};
        return {outcome: {status: 'ok', text: JSON.stringify({status: 'CLEAN', findings: [], confirmations: ids.map(requestId => ({requestId, decision: 'agree', rationale: 'Checked the captured isolation'}))}), resume: null, sessionId: null}, invocations: []};
      };
      assert.equal((await f.call()).exit, 0);
      if (raise) await correct(f, 'R1-F001', 'must');
      await f.add('ruling', {subject: 'review:plan-work.plan:R1-F001', ruling: 'rejected', rationale: 'The captured implementation bounds the retries'});
      phase = 'rejection';
      f.launches.length = 0;
      assert.equal((await f.call()).exit, 0);
      return promptsOf(f).some(prompt => prompt.includes('### Settled in earlier rounds'));
    } finally {f.cleanup();}
  };
  assert.equal(await run(false), true);
  assert.equal(await run(true), false);
});

// SECTION: Rejection confirmation after corrections

const rejectionStatesFor = (stored: 'MUST' | 'SHOULD', chain: readonly ('must' | 'should' | 'rejected')[]) => {
  const finding = {id: 'R1-F001', severity: stored, sources: ['reviewer'], defect: 'Defect', locus: '§ Work', requiredChange: 'Fix'};
  const round = {
    review: 'plan-work.plan',
    metadata: {round: 1, generation: 1, startSeq: 0, target: {base: 'a'.repeat(40), head: 'b'.repeat(40)}, spec: {path: 'spec', hash: 'sha256:' + 'a'.repeat(64)}, roster: [{slot: 'reviewer', reserve: false}]},
    findings: {review: 'plan-work.plan', round: 1, findings: [finding]},
  } as unknown as Parameters<typeof rejectionState>[0][number];
  const rulings = chain.map((step, index) => ({
    kind: 'ruling', seq: index + 1, key: 'k' + index, at: '', by: 'orchestrator',
    data: {subject: 'review:plan-work.plan:R1-F001', ...(step === 'rejected' ? {ruling: 'rejected', rationale: 'Ruling ' + index} : {ruling: 'accepted', ...CORRECTIONS[step]})},
  }));
  return rejectionState([round], rulings as never, []);
};

test('corrected finding: rejection confirmation follows the higher of the stored and latest corrected severities', () => {
  assert.equal(rejectionStatesFor('MUST', ['should', 'rejected']).length, 1);
  assert.equal(rejectionStatesFor('SHOULD', ['must', 'rejected']).length, 1);
  assert.equal(rejectionStatesFor('SHOULD', ['must', 'should', 'rejected']).length, 0);
  assert.equal(rejectionStatesFor('SHOULD', ['rejected']).length, 0);
  assert.equal(rejectionStatesFor('MUST', ['rejected']).length, 1);
});

// SECTION: Review budget boundaries

test('review budget keeps the saved cap when the level cap changes', async () => {
  const f = await fixture();
  try {
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: report('§ Work', 'Defect', 'MUST'), resume: null, sessionId: null}, invocations: []});
    assert.deepEqual((await f.call()).value.budget, {cap: 2, ceiling: 4, nextRound: 2, asOfSeq: 2, state: 'allowed'});
    const file = path.join(f.deps.skillRoot, 'config.jsonc'), config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.phases['plan-review'].rounds.medium = 5;
    fs.writeFileSync(file, JSON.stringify(config));
    fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
    const second = await f.call();
    // Round 3 would pass the saved cap, and the unruled MUST is not an accepted continuation.
    assert.deepEqual(second.value.budget, {cap: 2, ceiling: 4, nextRound: 3, asOfSeq: 2, state: 'requires-continuation'});
  } finally {f.cleanup();}
});

// SECTION: Loose-locus findings

const LOOSE = 'A – T5 – Fix skill';
const replyOf = (...items: readonly (readonly [string, string, string])[]) => JSON.stringify({status: 'FINDINGS', findings: items.flatMap(([locus, defect, severity]) => JSON.parse(report(locus, defect, severity)).findings)});
const oneReviewerDelegate = (text: string): CliDeps['delegate'] => async provider =>
  ({outcome: {status: 'ok', text: provider === 'agy' ? text : CLEAN, resume: null, sessionId: null}, invocations: []});

test('round keeps a loose-locus finding: plan and code rounds finish done, list it first and count it', async () => {
  for (const kind of ['plan', 'code'] as const) {
    const f = await fixture();
    try {
      const valid = kind === 'plan' ? '§ Work' : 'src/a.ts:L3';
      f.deps.delegate = oneReviewerDelegate(replyOf([LOOSE, 'Naming drifts here', 'CONSIDER'], [valid, 'Retries never stop', 'MUST'], [LOOSE, 'Writes get lost', 'MUST']));
      if (kind === 'code') rangeGit(f, {feature: 'feature-1'}, {'main-id..feature-1': ['src/a.ts']});
      const result = kind === 'plan' ? await f.call() : await f.call('code', 'main..feature', 'low');
      assert.equal(result.exit, 0);
      const marked = 'unresolved-locus: ' + LOOSE;
      assert.deepEqual(result.value.unresolvedLoci, [{id: 'R1-F003', locus: marked}, {id: 'R1-F001', locus: marked}]);
      assert.match(result.output.summary, /, 2 unresolved loci/);
      assert.ok(result.output.summary.includes('first 3: R1-F003 MUST: ' + marked + ' — Writes get lost; R1-F001 CONSIDER: ' + marked + ' — Naming drifts here; R1-F002 MUST: Retries never stop'), result.output.summary);
      const roundDir = path.dirname(result.value.path), saved = JSON.parse(fs.readFileSync(result.value.path, 'utf8'));
      assert.deepEqual(saved.findings.map((finding: {id: string; locus: string; scope: string}) => [finding.id, finding.locus, finding.scope]), [['R1-F001', marked, 'in'], ['R1-F002', valid, 'in'], ['R1-F003', marked, 'in']]);
      assert.deepEqual(saved.clusters.flatMap((cluster: {findings: string[]}) => cluster.findings).sort(), ['R1-F001', 'R1-F002', 'R1-F003']);
      assert.deepEqual(saved.failed, []);
      const roster = JSON.parse(fs.readFileSync(path.join(roundDir, 'round.json'), 'utf8')).roster as {slot: string; reserve: boolean}[];
      for (const {slot} of roster.filter(entry => !entry.reserve)) assert.equal(JSON.parse(fs.readFileSync(path.join(roundDir, 'gen-1/slots', slot + '.json'), 'utf8')).state, 'done', slot);
    } finally {f.cleanup();}
  }
});

test('round keeps a loose-locus finding: the result lists all six past the summary bound', async () => {
  const f = await fixture();
  try {
    f.deps.delegate = oneReviewerDelegate(replyOf(...Array.from({length: 6}, (_, index) => ['loose ' + index, 'Defect number ' + index, 'SHOULD'] as const)));
    const result = await f.call();
    assert.equal(result.exit, 0);
    assert.deepEqual(result.value.unresolvedLoci.map((entry: {locus: string}) => entry.locus), Array.from({length: 6}, (_, index) => 'unresolved-locus: loose ' + index));
    assert.match(result.output.summary, /, 6 unresolved loci/);
    assert.match(result.output.summary, /\+1 more in result/);
  } finally {f.cleanup();}
});

test('round keeps a loose-locus finding: a repeat in a later round links to no earlier finding', async () => {
  const f = await fixture();
  try {
    f.deps.delegate = oneReviewerDelegate(replyOf([LOOSE, 'Writes get lost', 'SHOULD']));
    assert.equal((await f.call()).exit, 0);
    await f.add('ruling', {subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Fixed'});
    fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
    const second = await f.call();
    assert.equal(second.exit, 0);
    const [finding] = JSON.parse(fs.readFileSync(second.value.path, 'utf8')).findings;
    assert.equal(finding.recurrence, undefined);
    assert.equal(finding.unresolved, undefined);
  } finally {f.cleanup();}
});
