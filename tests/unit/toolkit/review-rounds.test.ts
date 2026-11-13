import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import type { CliDeps } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { rejectionState } from '../../../skills/dispatch/scripts/toolkit/confirmations.ts';
import { artifactHash } from '../../../skills/dispatch/scripts/toolkit/artifacts.ts';
import { appendRecord } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { CLEAN, CONTEXT_MAP, fixture, report } from '../../helpers/review-fixture.ts';

// SECTION: Later-round roster policy

const targetSlots = (metadata: {roster: {slot: string; reserve: boolean}[]}) => metadata.roster.filter(slot => !slot.reserve).map(slot => slot.slot);
const promptsOf = (f: Awaited<ReturnType<typeof fixture>>) => f.launches.map(launch => fs.readFileSync(launch.request.promptPath, 'utf8'));

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

// Git stub for code-range tests

function rangeGit(f: Awaited<ReturnType<typeof fixture>>, state: {feature: string}, diffs: Record<string, string[]>) {
  f.deps.run = async argv => {
    if (argv[1] === 'rev-parse') return {exit: 0, stdout: argv.at(-1) === 'feature^{commit}' ? state.feature : 'main-id', stderr: ''};
    if (argv[1] === 'diff') return {exit: 0, stdout: (diffs[argv[4] + '..' + argv[5]] ?? []).map(file => file + '\0').join(''), stderr: ''};
    return {exit: 0, stdout: '', stderr: ''};
  };
}
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

// SECTION: Inter-round information

type RoundFixture = Awaited<ReturnType<typeof fixture>>;
const SINCE = '### Since the previous round';
const DIFF = 'diff --git a/x b/x\n-Original body.\n+Changed body.\n';
const UNCHANGED_TARGET = 'none; the target is unchanged since the previous round.';
const UNCHANGED_TEXT = 'none; the governed text is unchanged since the previous round.';
const NO_ACCEPTED = 'No accepted findings since the previous round.';
const diffGit = (f: RoundFixture, result: {exit: number; stdout: string}) => {
  f.deps.run = async argv => argv.includes('--no-index') ? {...result, stderr: ''} : {exit: 0, stdout: '', stderr: ''};
};
const script = (f: RoundFixture, reply: (provider: string, prompt: string) => string) => {
  f.deps.delegate = async (provider, request, mode) => {
    f.launches.push({provider, request, mode});
    return {outcome: {status: 'ok', text: reply(provider, fs.readFileSync(request.promptPath, 'utf8')), resume: null, sessionId: null}, invocations: []};
  };
};
const roomy = (f: RoundFixture) => fs.writeFileSync(path.join(f.deps.skillRoot, 'config.jsonc'), JSON.stringify({
  'read-delegates': {claude: {targets: [{low: {model: 'fake'}}]}, agy: {targets: [{low: {model: 'fake'}}]}},
  phases: {'plan-review': {targets: {low: 0, medium: 2}, rounds: {low: 0, medium: 6}}, 'code-review': {targets: {low: 2}, rounds: {low: 6}}},
}));
const blockBody = (lines: string[]) => lines.join('\n');
const since = (diff: string, accepted: readonly string[]) => blockBody([SINCE, 'Inter-round diff: ' + diff, ...(accepted.length ? ['Check these accepted-finding loci and their interactions first:', ...accepted.map(entry => '- ' + entry)] : [NO_ACCEPTED])]);
const sinceStandard = (diff: string) => blockBody([SINCE, 'Inter-round diff: ' + diff]);

test('standard re-review prompt omits the accepted id list, and round 1 renders none', async () => {
  const f = await fixture();
  try {
    diffGit(f, {exit: 1, stdout: DIFF});
    assert.equal((await f.call()).exit, 0);
    assert.ok(promptsOf(f).every(prompt => !prompt.includes(SINCE)));
    await f.add('ruling', {subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Fixed'});
    fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
    const before = f.launches.length;
    assert.equal((await f.call()).exit, 0);
    const file = path.join(f.directory, 'round-2', 'inter-round.diff');
    const diff = '`' + file + '` (unified diff of the governed text)';
    const later = promptsOf(f).slice(before);
    assert.ok(later.length > 0);
    for (const prompt of later) {
      assert.ok(prompt.includes(sinceStandard(diff) + '\n'), prompt);
      assert.doesNotMatch(prompt, /Check these accepted-finding loci/);
      assert.doesNotMatch(prompt, /No accepted findings since the previous round/);
      assert.ok(prompt.includes('Rows marked `(new)` were accepted since the previous round; inspect their loci and interactions first.'), prompt);
      assert.match(prompt, /^- R1-F001 § Work: [^\n]+ — accepted \(new\)$/m);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), DIFF);
    assert.deepEqual(f.read(2, 'round.json').interRound, {diff, accepted: [{id: 'R1-F001', locus: '§ Work'}]});
    assert.equal(f.read(1, 'round.json').interRound, undefined);
  } finally {f.cleanup();}
});

test('inter-round: a design round 2 with no accepted finding omits the empty list', async () => {
  const f = await fixture(false);
  try {
    const design = f.artifact('strategy.design.md', '# Strategy\n## Approach\nOne boundary.\n');
    f.artifact('strategy.design.context.md', CONTEXT_MAP);
    await f.add('bind', {spec: 'mission.spec.md', design: 'strategy.design.md'});
    diffGit(f, {exit: 1, stdout: DIFF});
    script(f, () => CLEAN);
    const first = await f.call('design', design);
    assert.equal(first.exit, 0, JSON.stringify(first.output));
    const before = artifactHash('design', fs.readFileSync(design, 'utf8'));
    fs.appendFileSync(design, '\n## Risks\nRetain the original boundary.\n');
    await f.add('edit', {artifact: 'design', before, after: artifactHash('design', fs.readFileSync(design, 'utf8')), class: 'non-intent', affects: [], rationale: 'Clarify risk', diffRef: 'design diff'});
    const launched = f.launches.length;
    const second = await f.call('design', design);
    assert.equal(second.exit, 0, JSON.stringify(second.output));
    const file = path.join(path.dirname(path.dirname(second.value.path)), 'round-2', 'inter-round.diff');
    const expected = sinceStandard('`' + file + '` (unified diff of the governed text)') + '\n';
    for (const prompt of promptsOf(f).slice(launched)) assert.ok(prompt.includes(expected), prompt);
    assert.equal(fs.readFileSync(file, 'utf8'), DIFF);
  } finally {f.cleanup();}
});

test('inter-round: a code round 2 names the head range and a round with equal heads states no change', async () => {
  const f = await fixture();
  try {
    roomy(f);
    const state = {feature: 'feature-1'};
    rangeGit(f, state, {'main-id..feature-1': ['src/a.ts'], 'main-id..feature-2': ['src/b.ts'], 'feature-1..feature-2': ['src/b.ts']});
    script(f, () => report('src/a.ts:L3', 'Retries never stop', 'SHOULD'));
    const first = await f.call('code', 'main..feature', 'low');
    assert.equal(first.exit, 0, JSON.stringify(first.output));
    await f.add('ruling', {subject: 'review:' + first.value.review + ':R1-F001', ruling: 'accepted', rationale: 'Fixed'});
    state.feature = 'feature-2';
    const launched = f.launches.length;
    const second = await f.call('code', 'main..feature', 'low');
    assert.equal(second.exit, 0, JSON.stringify(second.output));
    const roundOf = (round: number) => JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(second.value.path)), 'round-' + round, 'round.json'), 'utf8'));
    assert.deepEqual(roundOf(2).interRound, {diff: '`git diff feature-1 feature-2`', accepted: [{id: 'R1-F001', locus: 'src/a.ts:L3'}]});
    for (const prompt of promptsOf(f).slice(launched)) assert.ok(prompt.includes(sinceStandard('`git diff feature-1 feature-2`') + '\n') && prompt.includes('— accepted (new)'), prompt);
    const third = await f.call('code', 'main..feature', 'low');
    assert.equal(third.exit, 0, JSON.stringify(third.output));
    assert.equal(roundOf(3).interRound.diff, UNCHANGED_TARGET);
  } finally {f.cleanup();}
});

test('confirmation-only prompt keeps the accepted id list, and the window moves only when a round reviews the target', async () => {
  const f = await fixture();
  try {
    roomy(f);
    diffGit(f, {exit: 1, stdout: DIFF});
    let phase = 'finding';
    script(f, (provider, prompt) => {
      const ids = [...prompt.matchAll(/Request ID: `([^`]+)`/g)].map(match => match[1]!);
      if (phase === 'finding' && provider === 'agy') return replyOf(['§ Work', 'Concurrent writes overwrite captured results', 'MUST'], ['§ Notes', 'Naming could be clearer today', 'CONSIDER']);
      return JSON.stringify({status: 'CLEAN', findings: [], confirmations: ids.map(requestId => ({requestId, decision: 'agree', rationale: 'Checked the captured isolation'}))});
    });
    assert.equal((await f.call()).exit, 0);
    await f.add('ruling', {subject: 'review:plan-work.plan:R1-F001', ruling: 'rejected', rationale: 'The captured implementation prevents this'});
    await f.add('ruling', {subject: 'review:plan-work.plan:R1-F002', ruling: 'accepted', rationale: 'Renamed'});
    phase = 'later';
    // Round 2: unchanged target with a pending rejection.
    let before = f.launches.length;
    assert.equal((await f.call()).exit, 0);
    assert.match(f.read(2, 'round.json').scope, /\(confirmation-only\)/);
    assert.deepEqual(f.read(2, 'round.json').interRound, {diff: UNCHANGED_TARGET, accepted: [{id: 'R1-F002', locus: '§ Notes'}]});
    for (const prompt of promptsOf(f).slice(before)) assert.ok(prompt.includes('\n' + since(UNCHANGED_TARGET, ['R1-F002 § Notes']) + '\n\n### Inspection'), prompt);
    // Round 3: the confirmation-only round did not move the window.
    fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
    before = f.launches.length;
    assert.equal((await f.call()).exit, 0);
    assert.deepEqual(f.read(3, 'round.json').interRound?.accepted, [{id: 'R1-F002', locus: '§ Notes'}]);
    assert.ok(promptsOf(f).slice(before).every(prompt => /^- R1-F002 § Notes: [^\n]+ — accepted \(new\)$/m.test(prompt)));
    // Round 4: round 3 reviewed the target; only a findings-section refresh changed the plan.
    before = f.launches.length;
    assert.equal((await f.call()).exit, 0, JSON.stringify(f.output()));
    assert.doesNotMatch(f.read(4, 'round.json').scope, /confirmation-only/);
    assert.deepEqual(f.read(4, 'round.json').interRound, {diff: UNCHANGED_TEXT, accepted: []});
    assert.ok(promptsOf(f).slice(before).every(prompt => prompt.includes(sinceStandard(UNCHANGED_TEXT))));
  } finally {f.cleanup();}
});

test('inter-round: a rerun round keeps its label and receives the block', async () => {
  const f = await fixture();
  try {
    script(f, () => CLEAN);
    assert.equal((await f.call()).exit, 0);
    fs.mkdirSync(path.join(f.directory, 'round-1/gen-1'), {recursive: true});
    fs.writeFileSync(path.join(f.directory, 'round-1/gen-1/checkout-report.json'), JSON.stringify({repositoryCheck: {state: 'unavailable', reason: 'test'}, asOfSeq: 0}));
    await appendRecord(f.session, {kind: 'note', by: 'user', quote: 'Rerun after inspection', key: 'repository-rerun:plan-work.plan:1:0', data: {text: 'rerun'}}, f.deps);
    const before = f.launches.length;
    assert.equal((await f.call()).exit, 0, JSON.stringify(f.output()));
    const round = f.read(2, 'round.json');
    assert.match(round.scope, /^Full review/);
    assert.doesNotMatch(round.scope, /Re-review/);
    assert.deepEqual(round.interRound, {diff: UNCHANGED_TEXT, accepted: []});
    for (const prompt of promptsOf(f).slice(before)) assert.ok(prompt.includes(round.scope) && prompt.includes(sinceStandard(UNCHANGED_TEXT)), prompt);
  } finally {f.cleanup();}
});

test('inter-round: a rerun after an all-failed round diffs against that round', async () => {
  const f = await fixture();
  try {
    diffGit(f, {exit: 1, stdout: DIFF});
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify({status: 'BLOCKED', reason: 'cannot read the artifact'}), resume: null, sessionId: null}, invocations: []});
    assert.equal((await f.call()).output.reason, 'review-failed');
    assert.equal(fs.existsSync(path.join(f.directory, 'round-1', 'findings.json')), false);
    fs.mkdirSync(path.join(f.directory, 'round-1/gen-1'), {recursive: true});
    fs.writeFileSync(path.join(f.directory, 'round-1/gen-1/checkout-report.json'), JSON.stringify({repositoryCheck: {state: 'unavailable', reason: 'test'}, asOfSeq: 0}));
    await appendRecord(f.session, {kind: 'note', by: 'user', quote: 'Rerun after inspection', key: 'repository-rerun:plan-work.plan:1:0', data: {text: 'rerun'}}, f.deps);
    fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
    script(f, () => CLEAN);
    assert.equal((await f.call()).exit, 0, JSON.stringify(f.output()));
    const file = path.join(f.directory, 'round-2', 'inter-round.diff');
    assert.deepEqual(f.read(2, 'round.json').interRound, {diff: '`' + file + '` (unified diff of the governed text)', accepted: []});
    assert.equal(fs.readFileSync(file, 'utf8'), DIFF);
  } finally {f.cleanup();}
});

test('inter-round: a failed diff or a missing governed input leaves the round running as unavailable', async () => {
  const cases: [string, (f: RoundFixture) => void][] = [
    ['spawn failure', () => {}],
    ['git error', f => diffGit(f, {exit: 128, stdout: ''})],
    ['exit 1 with no output', f => diffGit(f, {exit: 1, stdout: ''})],
    ['missing governed input', f => { diffGit(f, {exit: 1, stdout: DIFF}); fs.rmSync(path.join(f.directory, 'round-1.input.md')); }],
  ];
  for (const [name, arrange] of cases) {
    const f = await fixture();
    try {
      script(f, () => CLEAN);
      assert.equal((await f.call()).exit, 0);
      fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
      arrange(f);
      const before = f.launches.length;
      assert.equal((await f.call()).exit, 0, name);
      assert.equal(f.read(2, 'round.json').interRound.diff, 'unavailable.', name);
      assert.equal(fs.existsSync(path.join(f.directory, 'round-2', 'inter-round.diff')), false, name);
      for (const prompt of promptsOf(f).slice(before)) assert.ok(prompt.includes('Inter-round diff: unavailable.'), name);
    } finally {f.cleanup();}
  }
});

// SECTION: Finding origin

test('origin: the round-2 prompt asks for it and findings.json and the summary carry the reply value', async () => {
  const f = await fixture();
  try {
    const withOrigin = () => { const body = JSON.parse(report('§ Work', 'Concurrent writes overwrite captured results', 'SHOULD')); body.findings[0].origin = 'fix-induced'; return JSON.stringify(body); };
    script(f, withOrigin);
    const first = await f.call();
    assert.equal(first.exit, 0, JSON.stringify(first.output));
    assert.equal(f.read(1, 'findings.json').findings[0].origin, 'original');
    assert.doesNotMatch(first.output.summary, /fix-induced/);
    assert.ok(promptsOf(f).every(prompt => !prompt.includes('add `origin`')));
    await f.add('ruling', {subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Fixed'});
    fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
    const before = f.launches.length;
    const second = await f.call();
    assert.equal(second.exit, 0, JSON.stringify(second.output));
    assert.equal(f.read(2, 'findings.json').findings[0].origin, 'fix-induced');
    assert.match(second.output.summary, /, 1 fix-induced/);
    assert.ok(promptsOf(f).slice(before).every(prompt => prompt.includes('add `origin`')));
  } finally {f.cleanup();}
});
