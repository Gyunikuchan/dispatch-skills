import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import type { CliDeps } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { rejectionState } from '../../../skills/dispatch/scripts/toolkit/confirmations.ts';
import { appendRecord } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { CLEAN, fixture, report } from '../../helpers/review-fixture.ts';
import {
  flag,
  jsonObject,
  listOf,
  narrow,
  numeric,
  optional,
  parseJson,
  readJson,
  shape,
  text,
} from './helpers/json.ts';

// SECTION: Later-round roster policy

type RoundFixture = Awaited<ReturnType<typeof fixture>>;
const roundShape = shape({
  round: numeric,
  scope: text,
  startSeq: numeric,
  roster: listOf(shape({ slot: text, reserve: flag })),
  rulingSnapshot: optional(text),
  interRound: optional(shape({ diff: text, accepted: listOf(jsonObject) })),
});
const findingsShape = shape({
  asOfSeq: numeric,
  findings: listOf(shape({ id: text, origin: optional(text) })),
  clusters: listOf(jsonObject),
  units: listOf(shape({ unit: text, hot: optional(flag), hotStreak: optional(numeric), delta: optional(numeric) })),
});
const readRound = (f: RoundFixture, round: number) => narrow(f.read(round, 'round.json'), roundShape);
const readFindings = (f: RoundFixture, round: number) => narrow(f.read(round, 'findings.json'), findingsShape);

const targetSlots = (metadata: { roster: Array<{ slot: string; reserve: boolean }> }) =>
  metadata.roster.filter((slot) => !slot.reserve).map((slot) => slot.slot);
const promptsOf = (f: RoundFixture) => f.launches.map((launch) => fs.readFileSync(launch.request.promptPath, 'utf8'));

test('roster: later rounds roster scoping and labeling reflect finding severity', async () => {
  // CONSIDER narrows next round to first target and labels narrowed scope
  {
    const f = await fixture();
    try {
      f.deps.delegate = async () => ({
        outcome: {
          status: 'ok',
          text: report('§ Work', 'Naming could be clearer', 'CONSIDER'),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      });
      assert.equal((await f.call()).exit, 0);
      const [first] = targetSlots(readRound(f, 1));
      assert.equal((await f.call()).exit, 0);
      assert.deepEqual(targetSlots(readRound(f, 2)), [first]);
      assert.match(readRound(f, 2).scope, /^Re-review round 2 \(narrowed\)/);
    } finally {
      f.cleanup();
    }
  }
  // Accepted MUST or SHOULD preserves every target and labels full scope
  for (const severity of ['MUST', 'SHOULD'] as const) {
    const f = await fixture();
    try {
      f.deps.delegate = async () => ({
        outcome: {
          status: 'ok',
          text: report('§ Work', 'Concurrent writes overwrite captured results', severity),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      });
      assert.equal((await f.call()).exit, 0);
      const everyTarget = targetSlots(readRound(f, 1));
      await f.add('ruling', { subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Fixed' });
      fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
      assert.equal((await f.call()).exit, 0);
      assert.deepEqual(targetSlots(readRound(f, 2)), everyTarget);
      assert.match(readRound(f, 2).scope, /^Re-review round 2 \(full\)/);
    } finally {
      f.cleanup();
    }
  }
});

test('roster: an accepted MUST past the round cap keeps every target', async () => {
  const f = await fixture();
  try {
    let step = 0;
    f.deps.delegate = async () => ({
      outcome: { status: 'ok', text: report('§ Work', 'Defect ' + step, 'MUST'), resume: null, sessionId: null },
      invocations: [],
    });
    const round = async () => {
      step++;
      assert.equal((await f.call()).exit, 0);
      await f.add('ruling', {
        subject: 'review:plan-work.plan:R' + step + '-F001',
        ruling: 'accepted',
        rationale: 'Resolution',
      });
      fs.appendFileSync(f.plan, '\n## Fix ' + step + '\nChanged.\n');
    };
    await round();
    const everyTarget = targetSlots(readRound(f, 1));
    await round();
    assert.equal((await f.call()).exit, 0);
    assert.deepEqual(targetSlots(readRound(f, 3)), everyTarget);
  } finally {
    f.cleanup();
  }
});

test('roster: a narrowed round keeps the source slot of a pending rejection', async () => {
  const f = await fixture();
  try {
    let phase = 'finding';
    f.deps.delegate = async (provider, request) => {
      const ids = [...fs.readFileSync(request.promptPath, 'utf8').matchAll(/Request ID: `([^`]+)`/g)].map(
        (match) => match[1]!,
      );
      if (phase === 'finding' && provider === 'agy') {
        return {
          outcome: {
            status: 'ok',
            text: report('§ Work', 'Concurrent writes overwrite captured results', 'MUST'),
            resume: null,
            sessionId: null,
          },
          invocations: [],
        };
      }
      return {
        outcome: {
          status: 'ok',
          text: JSON.stringify({
            status: 'CLEAN',
            findings: [],
            confirmations: ids.map((requestId) => ({
              requestId,
              decision: 'agree',
              rationale: 'Checked the captured isolation',
            })),
          }),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      };
    };
    assert.equal((await f.call()).exit, 0);
    const source = narrow(f.read(1, 'findings.json'), shape({ findings: listOf(shape({ sources: listOf(text) })) }))
      .findings[0]!.sources[0]!;
    assert.equal(
      narrow(f.read(1, 'round.json'), shape({ roster: listOf(shape({ slot: text, provider: text })) })).roster.find(
        (slot) => slot.slot === source,
      )?.provider,
      'agy',
    );
    await f.add('ruling', {
      subject: 'review:plan-work.plan:R1-F001',
      ruling: 'rejected',
      rationale: 'The captured implementation prevents this',
    });
    phase = 'rejection';
    assert.equal((await f.call()).exit, 0);
    assert.ok(targetSlots(readRound(f, 2)).includes(source));
  } finally {
    f.cleanup();
  }
});

// Git stub for code-range tests

function rangeGit(
  f: Awaited<ReturnType<typeof fixture>>,
  state: { feature: string },
  diffs: Record<string, Array<string>>,
) {
  f.deps.run = async (argv) => {
    if (argv[1] === 'rev-parse') {
      return { exit: 0, stdout: argv.at(-1) === 'feature^{commit}' ? state.feature : 'main-id', stderr: '' };
    }
    if (argv[1] === 'diff') {
      return {
        exit: 0,
        stdout: (diffs[argv[4] + '..' + argv[5]] ?? []).map((file) => file + '\0').join(''),
        stderr: '',
      };
    }
    return { exit: 0, stdout: '', stderr: '' };
  };
}
// SECTION: Corrected severity governs rounds

const CORRECTIONS = {
  consider: {
    impact: 'minor',
    trigger: 'contrived',
    rationale: 'impact and trigger: a cosmetic point on a contrived path',
  },
  should: { impact: 'degrades', trigger: 'realistic', rationale: 'impact: the Verify gate surfaces this gap' },
  must: { impact: 'blocks', trigger: 'realistic', rationale: 'impact: the promised outcome fails' },
} as const;
const correct = (f: Awaited<ReturnType<typeof fixture>>, id: string, to: keyof typeof CORRECTIONS) =>
  f.add('ruling', { subject: 'review:plan-work.plan:' + id, ruling: 'accepted', ...CORRECTIONS[to] });
const findingsDelegate =
  (severity: 'MUST' | 'SHOULD', counter: { step: number }): CliDeps['delegate'] =>
  async () => ({
    outcome: {
      status: 'ok',
      text: report('§ Work', 'Defect ' + counter.step, severity),
      resume: null,
      sessionId: null,
    },
    invocations: [],
  });

test('corrected finding severity governs roster, continuation, snapshot and confirmation', async () => {
  for (const plainRulingAfter of [false, true]) {
    const f = await fixture();
    try {
      f.deps.delegate = findingsDelegate('MUST', { step: 1 });
      assert.equal((await f.call()).exit, 0);
      const [first] = targetSlots(readRound(f, 1));
      await correct(f, 'R1-F001', 'consider');
      if (plainRulingAfter) {
        await f.add('ruling', {
          subject: 'review:plan-work.plan:R1-F001',
          ruling: 'accepted',
          rationale: 'Applied the fix',
        });
      }
      fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
      assert.equal((await f.call()).exit, 0);
      assert.deepEqual(targetSlots(readRound(f, 2)), [first]);
    } finally {
      f.cleanup();
    }
  }
  // corrected severity governs continuation and roster past the round cap
  {
    // MUST downgraded to SHOULD earns no continuation past cap
    {
      const f = await fixture();
      try {
        const counter = { step: 0 };
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
      } finally {
        f.cleanup();
      }
    }
    // SHOULD raised to MUST earns continuation and a full roster past the cap
    {
      const f = await fixture();
      try {
        const counter = { step: 0 };
        f.deps.delegate = findingsDelegate('SHOULD', counter);
        let everyTarget: Array<string> = [];
        for (const id of ['R1-F001', 'R2-F001']) {
          counter.step++;
          assert.equal((await f.call()).exit, 0);
          if (id === 'R1-F001') {
            everyTarget = targetSlots(readRound(f, 1));
          }
          await correct(f, id, 'must');
          fs.appendFileSync(f.plan, '\n## Fix ' + counter.step + '\nChanged.\n');
        }
        assert.equal((await f.call()).exit, 0);
        assert.deepEqual(targetSlots(readRound(f, 3)), everyTarget);
      } finally {
        f.cleanup();
      }
    }
  }
  // the ruling snapshot lists a raised severity and omits a lowered one
  {
    for (const [stored, to] of [
      ['SHOULD', 'must'],
      ['MUST', 'should'],
    ] as const) {
      const f = await fixture();
      try {
        f.deps.delegate = findingsDelegate(stored, { step: 1 });
        assert.equal((await f.call()).exit, 0);
        const ruling = await correct(f, 'R1-F001', to);
        fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
        assert.equal((await f.call()).exit, 0);
        assert.equal(
          readRound(f, 2).rulingSnapshot,
          stored === 'SHOULD' ? JSON.stringify([['R1-F001', ruling.seq]]) : '[]',
        );
      } finally {
        f.cleanup();
      }
    }
  }
  // settled rows hide a rejected SHOULD raised to MUST until confirmed
  {
    const run = async (raise: boolean) => {
      const f = await fixture();
      try {
        let phase = 'finding';
        f.deps.delegate = async (provider, request, mode) => {
          f.launches.push({ provider, request, mode });
          const ids = [...fs.readFileSync(request.promptPath, 'utf8').matchAll(/Request ID: `([^`]+)`/g)].map(
            (match) => match[1]!,
          );
          if (phase === 'finding' && provider === 'agy') {
            return {
              outcome: {
                status: 'ok',
                text: report('§ Work', 'Retries are unbounded', 'SHOULD'),
                resume: null,
                sessionId: null,
              },
              invocations: [],
            };
          }
          return {
            outcome: {
              status: 'ok',
              text: JSON.stringify({
                status: 'CLEAN',
                findings: [],
                confirmations: ids.map((requestId) => ({
                  requestId,
                  decision: 'agree',
                  rationale: 'Checked the captured isolation',
                })),
              }),
              resume: null,
              sessionId: null,
            },
            invocations: [],
          };
        };
        assert.equal((await f.call()).exit, 0);
        if (raise) {
          await correct(f, 'R1-F001', 'must');
        }
        await f.add('ruling', {
          subject: 'review:plan-work.plan:R1-F001',
          ruling: 'rejected',
          rationale: 'The captured implementation bounds the retries',
        });
        phase = 'rejection';
        f.launches.length = 0;
        assert.equal((await f.call()).exit, 0);
        return promptsOf(f).some((prompt) => prompt.includes('### Settled in earlier rounds'));
      } finally {
        f.cleanup();
      }
    };
    assert.equal(await run(false), true);
    assert.equal(await run(true), false);
  }
  // rejection confirmation follows the higher of the stored and corrected severities
  {
    // SECTION: Rejection confirmation after corrections (helpers stay with this case)

    const rejectionStatesFor = (stored: 'MUST' | 'SHOULD', chain: ReadonlyArray<'must' | 'should' | 'rejected'>) => {
      const finding = {
        id: 'R1-F001',
        severity: stored,
        impact: stored === 'MUST' ? ('blocks' as const) : ('degrades' as const),
        trigger: 'realistic' as const,
        category: 'correctness' as const,
        sources: ['reviewer'],
        scope: 'in' as const,
        defect: 'Defect',
        locus: '§ Work',
        requiredChange: 'Fix',
      };
      const round: Parameters<typeof rejectionState>[0][number] = {
        review: 'plan-work.plan',
        metadata: {
          round: 1,
          generation: 1,
          startSeq: 0,
          target: { base: 'a'.repeat(40), head: 'b'.repeat(40) },
          spec: { path: 'spec', hash: 'sha256:' + 'a'.repeat(64) },
          roster: [{ slot: 'reviewer', provider: 'codex', index: 0, native: false, reserve: false }],
        },
        findings: {
          review: 'plan-work.plan',
          round: 1,
          cap: 2,
          level: 'medium',
          findings: [finding],
          units: [],
          clusters: [],
          failed: [],
        },
      };
      const rulings = chain.map((step, index) => ({
        kind: 'ruling',
        seq: index + 1,
        key: 'k' + index,
        at: '',
        by: 'orchestrator',
        data: {
          subject: 'review:plan-work.plan:R1-F001',
          ...(step === 'rejected'
            ? { ruling: 'rejected', rationale: 'Ruling ' + index }
            : { ruling: 'accepted', ...CORRECTIONS[step] }),
        },
      }));
      return rejectionState([round], rulings, []);
    };

    assert.equal(rejectionStatesFor('MUST', ['should', 'rejected']).length, 1);
    assert.equal(rejectionStatesFor('SHOULD', ['must', 'rejected']).length, 1);
    assert.equal(rejectionStatesFor('SHOULD', ['must', 'should', 'rejected']).length, 0);
    assert.equal(rejectionStatesFor('SHOULD', ['rejected']).length, 0);
    assert.equal(rejectionStatesFor('MUST', ['rejected']).length, 1);
  }
});

// SECTION: Review budget boundaries

test('review budget keeps the saved cap when the level cap changes', async () => {
  const f = await fixture();
  try {
    f.deps.delegate = async () => ({
      outcome: { status: 'ok', text: report('§ Work', 'Defect', 'MUST'), resume: null, sessionId: null },
      invocations: [],
    });
    assert.deepEqual(narrow((await f.call()).value, shape({ budget: jsonObject })).budget, {
      cap: 2,
      ceiling: 4,
      nextRound: 2,
      asOfSeq: 2,
      state: 'allowed',
    });
    const file = path.join(f.deps.skillRoot, 'config.jsonc'),
      config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.phases['plan-review'].rounds.medium = 5;
    fs.writeFileSync(file, JSON.stringify(config));
    fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
    const second = await f.call();
    // Round 3 would pass the saved cap, and the unruled MUST is not an accepted continuation.
    assert.deepEqual(narrow(second.value, shape({ budget: jsonObject })).budget, {
      cap: 2,
      ceiling: 4,
      nextRound: 3,
      asOfSeq: 2,
      state: 'requires-continuation',
    });
  } finally {
    f.cleanup();
  }
});

// SECTION: Loose-locus findings

const LOOSE = 'A – T5 – Fix skill';
const replyOf = (...items: ReadonlyArray<readonly [string, string, string]>) =>
  JSON.stringify({
    status: 'FINDINGS',
    findings: items.flatMap(
      ([locus, defect, severity]) =>
        parseJson(report(locus, defect, severity), shape({ findings: listOf(jsonObject) })).findings,
    ),
  });
const oneReviewerDelegate =
  (text: string): CliDeps['delegate'] =>
  async (provider) => ({
    outcome: { status: 'ok', text: provider === 'agy' ? text : CLEAN, resume: null, sessionId: null },
    invocations: [],
  });

test('round keeps loose-locus findings listed, counted and unlinked', async () => {
  for (const kind of ['plan', 'code'] as const) {
    const f = await fixture();
    try {
      const valid = kind === 'plan' ? '§ Work' : 'src/a.ts:L3';
      f.deps.delegate = oneReviewerDelegate(
        replyOf(
          [LOOSE, 'Naming drifts here', 'CONSIDER'],
          [valid, 'Retries never stop', 'MUST'],
          [LOOSE, 'Writes get lost', 'MUST'],
        ),
      );
      if (kind === 'code') {
        rangeGit(f, { feature: 'feature-1' }, { 'main-id..feature-1': ['src/a.ts'] });
      }
      const result = kind === 'plan' ? await f.call() : await f.call('code', 'main..feature', 'low');
      assert.equal(result.exit, 0);
      const marked = 'unresolved-locus: ' + LOOSE;
      const resultValue = narrow(
        result.value,
        shape({ path: text, unresolvedLoci: listOf(shape({ id: text, locus: text })) }),
      );
      assert.deepEqual(resultValue.unresolvedLoci, [
        { id: 'R1-F003', locus: marked },
        { id: 'R1-F001', locus: marked },
      ]);
      assert.match(result.output.summary, /, 2 unresolved loci/);
      assert.ok(
        result.output.summary.includes(
          'first 3: R1-F003 MUST: ' +
            marked +
            ' — Writes get lost; R1-F001 CONSIDER: ' +
            marked +
            ' — Naming drifts here; R1-F002 MUST: Retries never stop',
        ),
        result.output.summary,
      );
      const roundDir = path.dirname(resultValue.path),
        saved = readJson(
          resultValue.path,
          shape({
            findings: listOf(shape({ id: text, locus: text, scope: text })),
            clusters: listOf(shape({ findings: listOf(text) })),
            failed: listOf(jsonObject),
          }),
        );
      assert.deepEqual(
        saved.findings.map((finding) => [finding.id, finding.locus, finding.scope]),
        [
          ['R1-F001', marked, 'in'],
          ['R1-F002', valid, 'in'],
          ['R1-F003', marked, 'in'],
        ],
      );
      assert.deepEqual(saved.clusters.flatMap((cluster) => cluster.findings).sort(), ['R1-F001', 'R1-F002', 'R1-F003']);
      assert.deepEqual(saved.failed, []);
      const roster = readJson(
        path.join(roundDir, 'round.json'),
        shape({ roster: listOf(shape({ slot: text, reserve: flag })) }),
      ).roster;
      for (const { slot } of roster.filter((entry) => !entry.reserve)) {
        assert.equal(
          JSON.parse(fs.readFileSync(path.join(roundDir, 'gen-1/slots', slot + '.json'), 'utf8')).state,
          'done',
          slot,
        );
      }
    } finally {
      f.cleanup();
    }
  }
  // all six past the summary bound
  {
    const f = await fixture();
    try {
      f.deps.delegate = oneReviewerDelegate(
        replyOf(
          ...Array.from({ length: 6 }, (_, index) => ['loose ' + index, 'Defect number ' + index, 'SHOULD'] as const),
        ),
      );
      const result = await f.call();
      assert.equal(result.exit, 0);
      assert.deepEqual(
        narrow(result.value, shape({ unresolvedLoci: listOf(shape({ locus: text })) })).unresolvedLoci.map(
          (entry) => entry.locus,
        ),
        Array.from({ length: 6 }, (_, index) => 'unresolved-locus: loose ' + index),
      );
      assert.match(result.output.summary, /, 6 unresolved loci/);
      assert.match(result.output.summary, /\+1 more in result/);
    } finally {
      f.cleanup();
    }
  }
  // a repeat in a later round links to no earlier finding
  {
    const f = await fixture();
    try {
      f.deps.delegate = oneReviewerDelegate(replyOf([LOOSE, 'Writes get lost', 'SHOULD']));
      assert.equal((await f.call()).exit, 0);
      await f.add('ruling', { subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Fixed' });
      fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
      const second = await f.call();
      assert.equal(second.exit, 0);
      const [finding] = JSON.parse(fs.readFileSync(narrow(second.value, shape({ path: text })).path, 'utf8')).findings;
      assert.equal(finding.recurrence, undefined);
      assert.equal(finding.unresolved, undefined);
    } finally {
      f.cleanup();
    }
  }
});

// SECTION: Inter-round information

const SINCE = '### Since the previous round';
const DIFF = 'diff --git a/x b/x\n-Original body.\n+Changed body.\n';
const UNCHANGED_TARGET = 'none; the target is unchanged since the previous round.';
const UNCHANGED_TEXT = 'none; the governed text is unchanged since the previous round.';
const NO_ACCEPTED = 'No accepted findings since the previous round.';
const diffGit = (f: RoundFixture, result: { exit: number; stdout: string }) => {
  f.deps.run = async (argv) =>
    argv.includes('--no-index') ? { ...result, stderr: '' } : { exit: 0, stdout: '', stderr: '' };
};
const script = (f: RoundFixture, reply: (provider: string, prompt: string) => string) => {
  f.deps.delegate = async (provider, request, mode) => {
    f.launches.push({ provider, request, mode });
    return {
      outcome: {
        status: 'ok',
        text: reply(provider, fs.readFileSync(request.promptPath, 'utf8')),
        resume: null,
        sessionId: null,
      },
      invocations: [],
    };
  };
};
const roomy = (f: RoundFixture) =>
  fs.writeFileSync(
    path.join(f.deps.skillRoot, 'config.jsonc'),
    JSON.stringify({
      'read-delegates': {
        claude: { targets: [{ low: { model: 'fake' } }] },
        agy: { targets: [{ low: { model: 'fake' } }] },
      },
      phases: {
        'plan-review': { targets: { low: 0, medium: 2 }, rounds: { low: 0, medium: 6 } },
        'code-review': { targets: { low: 2 }, rounds: { low: 6 } },
      },
    }),
  );
const blockBody = (lines: Array<string>) => lines.join('\n');
const since = (diff: string, accepted: ReadonlyArray<string>) =>
  blockBody([
    SINCE,
    'Inter-round diff: ' + diff,
    ...(accepted.length
      ? ['Check these accepted-finding loci and their interactions first:', ...accepted.map((entry) => '- ' + entry)]
      : [NO_ACCEPTED]),
  ]);
const sinceStandard = (diff: string) => blockBody([SINCE, 'Inter-round diff: ' + diff]);

test('inter-round diff, rerun labels and unavailable inputs carry the accepted list', async () => {
  const f = await fixture();
  try {
    diffGit(f, { exit: 1, stdout: DIFF });
    assert.equal((await f.call()).exit, 0);
    assert.ok(promptsOf(f).every((prompt) => !prompt.includes(SINCE)));
    await f.add('ruling', { subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Fixed' });
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
      assert.ok(
        prompt.includes(
          'Rows marked `(new)` were accepted since the previous round; inspect their loci and interactions first.',
        ),
        prompt,
      );
      assert.match(prompt, /^- R1-F001 § Work: [^\n]+ — accepted \(new\): [^\n]+$/m);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), DIFF);
    assert.deepEqual(readRound(f, 2).interRound, { diff, accepted: [{ id: 'R1-F001', locus: '§ Work' }] });
    assert.equal(readRound(f, 1).interRound, undefined);
  } finally {
    f.cleanup();
  }
  // a code round names the head range and equal heads state no change
  {
    const f = await fixture();
    try {
      roomy(f);
      const state = { feature: 'feature-1' };
      rangeGit(f, state, {
        'main-id..feature-1': ['src/a.ts'],
        'main-id..feature-2': ['src/b.ts'],
        'feature-1..feature-2': ['src/b.ts'],
      });
      script(f, () => report('src/a.ts:L3', 'Retries never stop', 'SHOULD'));
      const first = await f.call('code', 'main..feature', 'low');
      assert.equal(first.exit, 0, JSON.stringify(first.output));
      await f.add('ruling', {
        subject: 'review:' + narrow(first.value, shape({ review: text })).review + ':R1-F001',
        ruling: 'accepted',
        rationale: 'Fixed',
      });
      state.feature = 'feature-2';
      const launched = f.launches.length;
      const second = await f.call('code', 'main..feature', 'low');
      assert.equal(second.exit, 0, JSON.stringify(second.output));
      const roundOf = (round: number) =>
        readJson(
          path.join(
            path.dirname(path.dirname(narrow(second.value, shape({ path: text })).path)),
            'round-' + round,
            'round.json',
          ),
          shape({ interRound: optional(jsonObject) }),
        );
      assert.deepEqual(roundOf(2).interRound, {
        diff: '`git diff feature-1 feature-2`',
        accepted: [{ id: 'R1-F001', locus: 'src/a.ts:L3' }],
      });
      for (const prompt of promptsOf(f).slice(launched)) {
        assert.ok(
          prompt.includes(sinceStandard('`git diff feature-1 feature-2`') + '\n') &&
            prompt.includes('— accepted (new)'),
          prompt,
        );
      }
      const third = await f.call('code', 'main..feature', 'low');
      assert.equal(third.exit, 0, JSON.stringify(third.output));
      assert.equal(roundOf(3).interRound?.['diff'], UNCHANGED_TARGET);
    } finally {
      f.cleanup();
    }
  }
  // the confirmation-only prompt keeps the accepted list and the window moves on review
  {
    const f = await fixture();
    try {
      roomy(f);
      diffGit(f, { exit: 1, stdout: DIFF });
      let phase = 'finding';
      script(f, (provider, prompt) => {
        const ids = [...prompt.matchAll(/Request ID: `([^`]+)`/g)].map((match) => match[1]!);
        if (phase === 'finding' && provider === 'agy') {
          return replyOf(
            ['§ Work', 'Concurrent writes overwrite captured results', 'MUST'],
            ['§ Notes', 'Naming could be clearer today', 'CONSIDER'],
          );
        }
        return JSON.stringify({
          status: 'CLEAN',
          findings: [],
          confirmations: ids.map((requestId) => ({
            requestId,
            decision: 'agree',
            rationale: 'Checked the captured isolation',
          })),
        });
      });
      assert.equal((await f.call()).exit, 0);
      await f.add('ruling', {
        subject: 'review:plan-work.plan:R1-F001',
        ruling: 'rejected',
        rationale: 'The captured implementation prevents this',
      });
      await f.add('ruling', { subject: 'review:plan-work.plan:R1-F002', ruling: 'accepted', rationale: 'Renamed' });
      phase = 'later';
      // Round 2: unchanged target with a pending rejection.
      let before = f.launches.length;
      assert.equal((await f.call()).exit, 0);
      assert.match(readRound(f, 2).scope, /\(confirmation-only\)/);
      assert.deepEqual(readRound(f, 2).interRound, {
        diff: UNCHANGED_TARGET,
        accepted: [{ id: 'R1-F002', locus: '§ Notes' }],
      });
      for (const prompt of promptsOf(f).slice(before)) {
        assert.ok(prompt.includes('\n' + since(UNCHANGED_TARGET, ['R1-F002 § Notes']) + '\n\n### Inspection'), prompt);
      }
      // Round 3: the confirmation-only round did not move the window.
      fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
      before = f.launches.length;
      assert.equal((await f.call()).exit, 0);
      assert.deepEqual(readRound(f, 3).interRound?.accepted, [{ id: 'R1-F002', locus: '§ Notes' }]);
      assert.ok(
        promptsOf(f)
          .slice(before)
          .every((prompt) => /^- R1-F002 § Notes: [^\n]+ — accepted \(new\): [^\n]+$/m.test(prompt)),
      );
      // Round 4: round 3 reviewed the target; only a findings-section refresh changed the plan.
      before = f.launches.length;
      assert.equal((await f.call()).exit, 0, JSON.stringify(f.output()));
      assert.doesNotMatch(readRound(f, 4).scope, /confirmation-only/);
      assert.deepEqual(readRound(f, 4).interRound, { diff: UNCHANGED_TEXT, accepted: [] });
      assert.ok(
        promptsOf(f)
          .slice(before)
          .every((prompt) => prompt.includes(sinceStandard(UNCHANGED_TEXT))),
      );
    } finally {
      f.cleanup();
    }
  }
  // a rerun round keeps its label and receives the block
  {
    const f = await fixture();
    try {
      script(f, () => CLEAN);
      assert.equal((await f.call()).exit, 0);
      fs.mkdirSync(path.join(f.directory, 'round-1/gen-1'), { recursive: true });
      fs.writeFileSync(
        path.join(f.directory, 'round-1/gen-1/checkout-report.json'),
        JSON.stringify({ repositoryCheck: { state: 'unavailable', reason: 'test' }, asOfSeq: 0 }),
      );
      await appendRecord(
        f.session,
        {
          kind: 'note',
          by: 'user',
          quote: 'Rerun after inspection',
          key: 'repository-rerun:plan-work.plan:1:0',
          data: { text: 'rerun' },
        },
        f.deps,
      );
      const before = f.launches.length;
      assert.equal((await f.call()).exit, 0, JSON.stringify(f.output()));
      const round = readRound(f, 2);
      assert.match(round.scope, /^Full review/);
      assert.doesNotMatch(round.scope, /Re-review/);
      assert.deepEqual(round.interRound, { diff: UNCHANGED_TEXT, accepted: [] });
      for (const prompt of promptsOf(f).slice(before)) {
        assert.ok(prompt.includes(round.scope) && prompt.includes(sinceStandard(UNCHANGED_TEXT)), prompt);
      }
    } finally {
      f.cleanup();
    }
  }
  // a rerun after an all-failed round diffs against that round
  {
    const f = await fixture();
    try {
      diffGit(f, { exit: 1, stdout: DIFF });
      f.deps.delegate = async () => ({
        outcome: {
          status: 'ok',
          text: JSON.stringify({ status: 'BLOCKED', reason: 'cannot read the artifact' }),
          resume: null,
          sessionId: null,
        },
        invocations: [],
      });
      assert.equal((await f.call()).output.reason, 'review-failed');
      assert.equal(fs.existsSync(path.join(f.directory, 'round-1', 'findings.json')), false);
      fs.mkdirSync(path.join(f.directory, 'round-1/gen-1'), { recursive: true });
      fs.writeFileSync(
        path.join(f.directory, 'round-1/gen-1/checkout-report.json'),
        JSON.stringify({ repositoryCheck: { state: 'unavailable', reason: 'test' }, asOfSeq: 0 }),
      );
      await appendRecord(
        f.session,
        {
          kind: 'note',
          by: 'user',
          quote: 'Rerun after inspection',
          key: 'repository-rerun:plan-work.plan:1:0',
          data: { text: 'rerun' },
        },
        f.deps,
      );
      fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
      script(f, () => CLEAN);
      assert.equal((await f.call()).exit, 0, JSON.stringify(f.output()));
      const file = path.join(f.directory, 'round-2', 'inter-round.diff');
      assert.deepEqual(readRound(f, 2).interRound, {
        diff: '`' + file + '` (unified diff of the governed text)',
        accepted: [],
      });
      assert.equal(fs.readFileSync(file, 'utf8'), DIFF);
    } finally {
      f.cleanup();
    }
  }
  // a failed diff or missing input leaves the round unavailable
  {
    const cases: Array<[string, (f: RoundFixture) => void]> = [
      ['spawn failure', () => {}],
      ['git error', (f) => diffGit(f, { exit: 128, stdout: '' })],
      ['exit 1 with no output', (f) => diffGit(f, { exit: 1, stdout: '' })],
      [
        'missing governed input',
        (f) => {
          diffGit(f, { exit: 1, stdout: DIFF });
          fs.rmSync(path.join(f.directory, 'round-1.input.md'));
        },
      ],
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
        assert.equal(readRound(f, 2).interRound?.diff, 'unavailable.', name);
        assert.equal(fs.existsSync(path.join(f.directory, 'round-2', 'inter-round.diff')), false, name);
        for (const prompt of promptsOf(f).slice(before)) {
          assert.ok(prompt.includes('Inter-round diff: unavailable.'), name);
        }
      } finally {
        f.cleanup();
      }
    }
  }
});

// SECTION: User decisions

let decisionKey = 0;
const escalate = (
  f: RoundFixture,
  id: string,
  state: 'open' | 'resolved',
  summary: string,
  by: 'user' | 'orchestrator' | 'tool',
  quote?: string,
) =>
  appendRecord(
    f.session,
    {
      kind: 'escalation',
      by,
      ...(!(quote === undefined) && { quote }),
      key: 'decision-' + decisionKey++,
      data: { id, state, summary },
    },
    f.deps,
  );
const decisionLine = (id: string, summary: string, quote: string) =>
  `- ${id} — user decision: ${summary} — quote: "${quote}"`;
const decisionLines = (prompt: string) => prompt.split('\n').filter((line) => line.includes(' — user decision: '));
const DECISION_CLOSED =
  'Listed user decisions are closed; re-raise one only with evidence that was not available when the user decided.';

test('accepted findings and user decisions persist across rounds', async () => {
  const f = await fixture();
  try {
    script(f, () => report());
    assert.equal((await f.call()).exit, 0);
    await escalate(
      f,
      'ceiling:plan-work.plan:4',
      'resolved',
      're-author: Keep the compact stdout line',
      'user',
      'approve',
    );
    await escalate(f, 'ceiling:plan-other.plan:4', 'resolved', 're-author: Other review', 'user', 'approve');
    await escalate(f, 'recurrence:plan-work.plan:R1-F001:g1', 'resolved', 'Keep the recurrence closed', 'user', 'keep');
    await escalate(f, 'recurrence:plan-work.plan:R1-F002:g1', 'open', 'Still open', 'tool');
    await escalate(f, 'recurrence:plan-work.plan:R1-F003:g1', 'resolved', 'Orchestrator closed', 'orchestrator');
    await escalate(f, 'recurrence:plan-work.plan:R1-F004:g1', 'resolved', 'Kept closed', 'user', 'keep');
    await escalate(f, 'recurrence:plan-work.plan:R1-F004:g1', 'open', 'Reopened', 'tool');
    await escalate(f, 'coverage:plan-work.plan:claude', 'resolved', 'accept: claude[0]', 'user', 'accept');
    await escalate(
      f,
      'missing-red:plan-work.plan:step-one:first-check:R1:g1',
      'resolved',
      'Accept the gap',
      'user',
      'ok',
    );
    await escalate(
      f,
      'recurrence:plan-work.plan:R1-F006:g1',
      'resolved',
      'Keep the superseded decision',
      'user',
      'yes',
    );
    await escalate(f, 'recurrence:plan-work.plan:R1-F006:g1', 'resolved', 'superseded: target moved', 'tool');
    await f.add('ruling', { subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Fixed' });
    fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
    const before = f.launches.length;
    assert.equal((await f.call()).exit, 0);
    const expected = [
      decisionLine('ceiling:plan-work.plan:4', 're-author: Keep the compact stdout line', 'approve'),
      decisionLine('recurrence:plan-work.plan:R1-F001:g1', 'Keep the recurrence closed', 'keep'),
      decisionLine('coverage:plan-work.plan:claude', 'accept: claude[0]', 'accept'),
      decisionLine('missing-red:plan-work.plan:step-one:first-check:R1:g1', 'Accept the gap', 'ok'),
      decisionLine('recurrence:plan-work.plan:R1-F006:g1', 'Keep the superseded decision', 'yes'),
    ];
    const prompts = promptsOf(f).slice(before);
    assert.ok(prompts.length > 0);
    for (const prompt of prompts) {
      assert.deepEqual(decisionLines(prompt), expected);
    }
  } finally {
    f.cleanup();
  }
  // a confirmation-only round lists the decisions with the closed sentence
  {
    const f = await fixture();
    try {
      let phase = 'finding';
      script(f, (provider, prompt) => {
        const ids = [...prompt.matchAll(/Request ID: `([^`]+)`/g)].map((match) => match[1]!);
        if (phase === 'finding' && provider === 'agy') {
          return report('§ Work', 'Concurrent writes overwrite captured results', 'MUST');
        }
        return JSON.stringify({
          status: 'CLEAN',
          findings: [],
          confirmations: ids.map((requestId) => ({
            requestId,
            decision: 'agree',
            rationale: 'Checked the captured isolation',
          })),
        });
      });
      assert.equal((await f.call()).exit, 0);
      await f.add('ruling', {
        subject: 'review:plan-work.plan:R1-F001',
        ruling: 'rejected',
        rationale: 'The captured implementation prevents this',
      });
      await escalate(
        f,
        'recurrence:plan-work.plan:R1-F002:g1',
        'resolved',
        'Keep the recurrence closed',
        'user',
        'keep',
      );
      phase = 'confirmation';
      const before = f.launches.length;
      assert.equal((await f.call()).exit, 0);
      assert.match(readRound(f, 2).scope, /\(confirmation-only\)/);
      const prompts = promptsOf(f).slice(before);
      assert.ok(prompts.length > 0);
      for (const prompt of prompts) {
        assert.deepEqual(decisionLines(prompt), [
          decisionLine('recurrence:plan-work.plan:R1-F002:g1', 'Keep the recurrence closed', 'keep'),
        ]);
        assert.ok(prompt.includes(DECISION_CLOSED), prompt);
      }
    } finally {
      f.cleanup();
    }
  }
  // a re-entered round keeps the decisions recorded before its start
  {
    const f = await fixture();
    try {
      script(f, () => report());
      assert.equal((await f.call()).exit, 0);
      await f.add('ruling', { subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Fixed' });
      await escalate(
        f,
        'recurrence:plan-work.plan:R1-F002:g1',
        'resolved',
        'Keep the recurrence closed',
        'user',
        'keep',
      );
      fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
      script(f, () => JSON.stringify({ status: 'BLOCKED', reason: 'cannot read the artifact' }));
      assert.equal((await f.call()).output.reason, 'review-failed');
      const startSeq = readRound(f, 2).startSeq;
      await escalate(
        f,
        'recurrence:plan-work.plan:R1-F003:g1',
        'resolved',
        'Recorded after the round started',
        'user',
        'late',
      );
      script(f, () => report());
      const before = f.launches.length;
      assert.equal((await f.call()).exit, 0);
      assert.equal(readRound(f, 2).startSeq, startSeq);
      const prompts = promptsOf(f).slice(before);
      assert.ok(prompts.length > 0);
      for (const prompt of prompts) {
        assert.deepEqual(decisionLines(prompt), [
          decisionLine('recurrence:plan-work.plan:R1-F002:g1', 'Keep the recurrence closed', 'keep'),
        ]);
      }
    } finally {
      f.cleanup();
    }
  }
});

const withOrigin = () => {
  const body = JSON.parse(report('§ Work', 'Concurrent writes overwrite captured results', 'SHOULD'));
  body.findings[0].origin = 'fix-induced';
  return JSON.stringify(body);
};

// SECTION: Finding origin

test('origin: the round-2 prompt asks for it and findings.json and the summary carry the reply value', async () => {
  const f = await fixture();
  try {
    script(f, withOrigin);
    const first = await f.call();
    assert.equal(first.exit, 0, JSON.stringify(first.output));
    assert.equal(readFindings(f, 1).findings[0]?.origin, 'original');
    assert.doesNotMatch(first.output.summary, /fix-induced/);
    assert.ok(promptsOf(f).every((prompt) => !prompt.includes('add `origin`')));
    await f.add('ruling', { subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Fixed' });
    fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
    const before = f.launches.length;
    const second = await f.call();
    assert.equal(second.exit, 0, JSON.stringify(second.output));
    assert.equal(readFindings(f, 2).findings[0]?.origin, 'fix-induced');
    assert.match(second.output.summary, /, 1 fix-induced/);
    assert.ok(
      promptsOf(f)
        .slice(before)
        .every((prompt) => prompt.includes('add `origin`')),
    );
  } finally {
    f.cleanup();
  }
});

test('review run stores finding units for every round', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(f.plan, '# Work\n## Work\n### T1 — Task\nOriginal.\n## Review Findings & Resolutions\n');
    const clean = false;
    f.deps.delegate = async () => ({
      outcome: {
        status: 'ok',
        text: clean ? CLEAN : report('§ T1 — Task', 'A defect', 'SHOULD'),
        resume: null,
        sessionId: null,
      },
      invocations: [],
    });
    assert.equal((await f.call()).exit, 0);
    const first = readFindings(f, 1);
    assert.equal(first.units[0]?.unit, 'T1');
    assert.deepEqual(first.clusters, [{ file: f.plan, findings: [first.findings[0]?.id] }]);
    await f.add('ruling', { subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Fixed' });
    fs.writeFileSync(
      f.plan,
      '# Work\n## Work\n### T1 — Task\nOriginal and expanded.\n## Review Findings & Resolutions\n',
    );
    assert.equal((await f.call()).exit, 0);
    const second = readFindings(f, 2);
    assert.deepEqual([second.units[0]?.unit, second.units[0]?.hot, second.units[0]?.hotStreak], ['T1', true, 1]);
    assert.ok((second.units[0]?.delta ?? 0) > 0);
  } finally {
    f.cleanup();
  }
  const designFixture = await fixture();
  try {
    const design = designFixture.artifact(
      'strategy.design.md',
      '# Strategy\n## Architecture\n### AD-4 — Boundary\nDesign.\n',
    );
    designFixture.deps.delegate = async () => ({
      outcome: { status: 'ok', text: report('§ AD-4 — Boundary'), resume: null, sessionId: null },
      invocations: [],
    });
    const result = await designFixture.call('design', design);
    assert.equal(result.exit, 0, JSON.stringify(result));
    const designResult = JSON.parse(
      fs.readFileSync(
        path.join(designFixture.session, '.state/reviews/design-strategy.design/round-1/findings.json'),
        'utf8',
      ),
    );
    assert.equal(designResult.units[0].unit, 'AD-4');
  } finally {
    designFixture.cleanup();
  }
  const g = await fixture();
  try {
    let saved = 0;
    g.deps.hook = (point) => {
      if (point === 'review:after-pending') {
        const file = path.join(g.directory, 'round-1', 'pending.json');
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        saved = value.asOfSeq;
        delete value.units;
        fs.writeFileSync(file, JSON.stringify(value));
        throw new Error('interrupt');
      }
    };
    await g.call();
    delete g.deps.hook;
    assert.equal((await g.call()).exit, 0);
    const result = readFindings(g, 1);
    assert.ok(Array.isArray(result.units));
    assert.equal(result.asOfSeq, saved);
    g.deps.delegate = async () => ({
      outcome: { status: 'ok', text: CLEAN, resume: null, sessionId: null },
      invocations: [],
    });
    assert.equal((await g.call()).exit, 0);
    assert.deepEqual(readFindings(g, 2).units, []);
  } finally {
    g.cleanup();
  }
});

// SECTION: Hot units in the summary

const acceptAll = async (f: RoundFixture, ids: ReadonlyArray<string>) => {
  for (const id of ids) {
    await f.add('ruling', { subject: 'review:plan-work.plan:' + id, ruling: 'accepted', rationale: 'Fixed' });
  }
};
const itemsOf = (f: RoundFixture, round: number) =>
  narrow(
    f.read(round, 'findings.json'),
    shape({ findings: listOf(shape({ id: text, severity: text, defect: text })) }),
  ).findings.map((finding) => `${finding.id} ${finding.severity}: ${finding.defect}`);

test('hot units are named with streak and byte delta within the bound', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(
      f.plan,
      '# Work\n## Work\n### T1 — Task\nOriginal.\n### T2 — Other\nOriginal.\n## Review Findings & Resolutions\n',
    );
    f.deps.delegate = oneReviewerDelegate(
      replyOf(['§ T1 — Task', 'Defect on T1', 'SHOULD'], ['§ T2 — Other', 'Defect on T2', 'SHOULD']),
    );
    assert.equal((await f.call()).exit, 0);
    await acceptAll(f, ['R1-F001', 'R1-F002']);
    fs.writeFileSync(
      f.plan,
      '# Work\n## Work\n### T1 — Task\nOriginal and expanded.\n### T2 — Other\nOriginal and expanded too.\n## Review Findings & Resolutions\n',
    );
    const second = await f.call();
    assert.equal(second.exit, 0);
    const units = narrow(
      f.read(2, 'findings.json'),
      shape({ units: listOf(shape({ unit: text, delta: optional(numeric) })) }),
    ).units;
    const t1 = units.find((entry) => entry.unit === 'T1')!,
      t2 = units.find((entry) => entry.unit === 'T2')!;
    assert.ok(t1.delta! > 0 && t2.delta! > 0, JSON.stringify(units));
    assert.ok(
      second.output.summary.includes(
        `; 2 hot units: T1 ×1 +${t1.delta} B, T2 ×1 +${t2.delta} B; first 2: ${itemsOf(f, 2).join('; ')}`,
      ),
      second.output.summary,
    );
  } finally {
    f.cleanup();
  }
  // a spec unit names its streak alone
  {
    const f = await fixture();
    try {
      f.deps.delegate = oneReviewerDelegate(replyOf(['§ REQ-1', 'Spec gap', 'SHOULD']));
      assert.equal((await f.call()).exit, 0);
      await acceptAll(f, ['R1-F001']);
      fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
      const second = await f.call();
      assert.equal(second.exit, 0);
      assert.ok(
        second.output.summary.includes(`; 1 hot unit: spec:REQ-1 ×1; first 1: ${itemsOf(f, 2).join('; ')}`),
        second.output.summary,
      );
      assert.equal(
        narrow(
          f.read(2, 'findings.json'),
          shape({ units: listOf(shape({ unit: text, delta: optional(numeric) })) }),
        ).units.find((entry) => entry.unit === 'spec:REQ-1')!.delta,
        undefined,
      );
    } finally {
      f.cleanup();
    }
  }
  // six long-named units are all named and items drop first
  {
    const f = await fixture();
    try {
      const titles = Array.from(
        { length: 6 },
        (_, i) => `Unit ${i + 1} of six with a long descriptive heading that the summary clips`,
      );
      fs.writeFileSync(
        f.plan,
        `# Work\n## Work\n${titles.map((title) => `### ${title}\nOriginal.\n`).join('')}## Review Findings & Resolutions\n`,
      );
      f.deps.delegate = oneReviewerDelegate(
        replyOf(...titles.map((title) => ['§ ' + title, 'Long defect ' + 'word '.repeat(30), 'SHOULD'] as const)),
      );
      assert.equal((await f.call()).exit, 0);
      await acceptAll(
        f,
        Array.from({ length: 6 }, (_, i) => 'R1-F00' + (i + 1)),
      );
      fs.writeFileSync(
        f.plan,
        `# Work\n## Work\n${titles.map((title) => `### ${title}\nOriginal and expanded.\n`).join('')}## Review Findings & Resolutions\n`,
      );
      const second = await f.call();
      assert.equal(second.exit, 0);
      const { summary } = second.output;
      assert.ok(summary.includes('; 6 hot units: '), summary);
      for (let i = 1; i <= 6; i++) {
        assert.ok(summary.includes(`§ Unit ${i} of six with a long`), summary);
      }
      assert.ok(Buffer.byteLength(summary) <= 1024, summary);
      assert.ok(summary.includes(' more in result'), summary);
    } finally {
      f.cleanup();
    }
  }
});

test('hot-unit summary truncation, pointers and absence stay within the bound', async () => {
  const f = await fixture();
  try {
    const titles = Array.from({ length: 25 }, (_, i) => `Unit ${i + 1} of many with a long descriptive heading`);
    fs.writeFileSync(
      f.plan,
      `# Work\n## Work\n${titles.map((title) => `### ${title}\nOriginal.\n`).join('')}## Review Findings & Resolutions\n`,
    );
    f.deps.delegate = oneReviewerDelegate(
      replyOf(...titles.map((title) => ['§ ' + title, 'A defect', 'SHOULD'] as const)),
    );
    assert.equal((await f.call()).exit, 0);
    await acceptAll(
      f,
      Array.from({ length: 25 }, (_, i) => 'R1-F' + String(i + 1).padStart(3, '0')),
    );
    fs.writeFileSync(
      f.plan,
      `# Work\n## Work\n${titles.map((title) => `### ${title}\nOriginal and expanded.\n`).join('')}## Review Findings & Resolutions\n`,
    );
    const second = await f.call();
    assert.equal(second.exit, 0);
    const { summary } = second.output;
    const match = /; 25 hot units: (.+), \+(\d+) more in findings\.json units/.exec(summary);
    assert.ok(match, summary);
    const named = match[1]!.split(', ');
    assert.ok(named.length >= 1 && named.length + Number(match[2]) === 25, summary);
    assert.ok(Buffer.byteLength(summary) <= 1024, summary);
  } finally {
    f.cleanup();
  }
  // a near-bound base head keeps the count and pointer before the repository suffix
  {
    const f = await fixture();
    try {
      fs.writeFileSync(f.plan, '# Work\n## Work\n### T1 — Task\nOriginal.\n## Review Findings & Resolutions\n');
      f.deps.delegate = oneReviewerDelegate(replyOf(['§ T1 — Task', 'A defect', 'SHOULD']));
      assert.equal((await f.call()).exit, 0);
      await acceptAll(f, ['R1-F001']);
      fs.writeFileSync(
        f.plan,
        '# Work\n## Work\n### T1 — Task\nOriginal and expanded.\n## Review Findings & Resolutions\n',
      );
      const paths = Array.from({ length: 10 }, (_, i) => `src/generated/${i}/${'x'.repeat(80)}.ts`);
      f.deps.hook = (point) => {
        if (point === 'review:after-pending') {
          const file = path.join(f.directory, 'round-2', 'pending.json');
          const value = JSON.parse(fs.readFileSync(file, 'utf8'));
          value.repositoryChanges = [{ cwd: '.', paths }];
          fs.writeFileSync(file, JSON.stringify(value));
          throw new Error('interrupt');
        }
      };
      await f.call();
      delete f.deps.hook;
      const second = await f.call();
      assert.equal(second.exit, 0);
      const { summary } = second.output;
      const pointer = summary.indexOf('; 1 hot unit: +1 more in findings.json units');
      assert.ok(pointer >= 0 && pointer < summary.indexOf(', repository changes: '), summary);
    } finally {
      f.cleanup();
    }
  }
  // a round with no hot unit adds no hot-unit text
  {
    const f = await fixture();
    try {
      fs.writeFileSync(
        f.plan,
        '# Work\n## Work\n### T1 — Task\nOriginal.\n### T2 — Other\nOriginal.\n## Review Findings & Resolutions\n',
      );
      f.deps.delegate = oneReviewerDelegate(replyOf(['§ T1 — Task', 'A defect', 'SHOULD']));
      assert.equal((await f.call()).exit, 0);
      await acceptAll(f, ['R1-F001']);
      f.deps.delegate = oneReviewerDelegate(replyOf(['§ T2 — Other', 'Other defect', 'SHOULD']));
      const second = await f.call();
      assert.equal(second.exit, 0);
      assert.doesNotMatch(second.output.summary, /hot unit/);
      assert.ok(second.output.summary.endsWith('; first 1: R2-F001 SHOULD: Other defect'), second.output.summary);
    } finally {
      f.cleanup();
    }
  }
});

// SECTION: Reviewed spec snapshot

test('spec snapshot: round directory holds the captured spec text for a plan round and no temporary file', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call()).exit, 0);
    const roundDir = path.join(f.directory, 'round-1');
    assert.equal(fs.readFileSync(path.join(roundDir, 'spec.snapshot.md'), 'utf8'), fs.readFileSync(f.spec, 'utf8'));
    assert.deepEqual(
      fs.readdirSync(roundDir).filter((name) => name.endsWith('.tmp')),
      [],
    );
  } finally {
    f.cleanup();
  }
});

test('spec snapshot: a failed snapshot write does not refuse the round', async (t) => {
  const f = await fixture();
  const write = fs.writeFileSync;
  const snapshotWrite = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof write>) => {
    if (String(args[0]).includes('spec.snapshot.md')) {
      throw new Error('EPERM: simulated snapshot failure');
    }
    write(...args);
  });
  try {
    const result = await f.call();
    assert.equal(result.exit, 0);
    assert.equal(readRound(f, 1).round, 1);
  } finally {
    snapshotWrite.mock.restore();
    f.cleanup();
  }
});
