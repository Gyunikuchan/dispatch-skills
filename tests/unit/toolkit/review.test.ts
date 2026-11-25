import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { appendRecord, foldLedger } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { artifactHash } from '../../../skills/dispatch/scripts/toolkit/artifacts.ts';
import { atomic } from '../../../skills/dispatch/scripts/toolkit/fanout/state.ts';
import { CLEAN, fixture, report } from '../../helpers/review-fixture.ts';

const blockedReport = (reason: string) => JSON.stringify({ status: 'BLOCKED', reason });
const reply = (text: string) => ({
  outcome: { status: 'ok' as const, text, resume: null, sessionId: null },
  invocations: [],
});
const configure = (f: Awaited<ReturnType<typeof fixture>>, config: Record<string, unknown>, rounds = 2) =>
  fs.writeFileSync(
    path.join(f.deps.skillRoot, 'config.jsonc'),
    JSON.stringify({
      ...config,
      phases: {
        'plan-review': { targets: { low: 0, medium: 2 }, rounds: { low: 0, medium: rounds } },
        'code-review': { targets: { low: 2 }, rounds: { low: 2 } },
      },
    }),
  );

function failFirstRoundRenames(dir: string) {
  const rename = fs.renameSync;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const attempts = new Map<string, number>();
  Object.defineProperty(process, 'platform', { value: 'win32' });
  fs.renameSync = (from, to) => {
    const destination = String(to);
    if (destination.startsWith(dir + path.sep)) {
      const count = (attempts.get(destination) ?? 0) + 1;
      attempts.set(destination, count);
      if (count === 1) throw Object.assign(new Error('Transient rename lock'), { code: 'EPERM' });
    }
    rename(from, to);
  };
  return {
    attempts,
    restore() {
      fs.renameSync = rename;
      Object.defineProperty(process, 'platform', platform);
    },
  };
}

test('review rename retry: round completes and retains the reviewed spec', async () => {
  const f = await fixture();
  const dir = path.join(f.directory, 'round-1');
  const findings = path.join(dir, 'findings.json');
  const snapshot = path.join(dir, 'spec.snapshot.md');
  const locks = failFirstRoundRenames(dir);
  try {
    const spec = fs.readFileSync(f.spec, 'utf8');
    const result = await f.call();
    assert.equal(result.exit, 0, JSON.stringify(result.output));
    assert.equal(f.read(1, 'findings.json').round, 1);
    assert.equal(locks.attempts.get(findings), 2);
    assert.equal(locks.attempts.get(snapshot), 2);
    assert.equal(fs.readFileSync(snapshot, 'utf8'), spec);
  } finally {
    locks.restore();
    f.cleanup();
  }
});

test('review rename retry: fan-out atomic write persists its value', async () => {
  const f = await fixture();
  const dir = path.join(f.directory, 'round-1');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'fanout.json');
  const locks = failFirstRoundRenames(dir);
  try {
    atomic(file, { cliWaveDone: true });
    assert.deepEqual(f.read(1, 'fanout.json'), { cliWaveDone: true });
    assert.equal(locks.attempts.get(file), 2);
  } finally {
    locks.restore();
    f.cleanup();
  }
});

test('blocked reasons list distinctly, carry failures and survive sanitizing', async () => {
  const cases: { name: string; run: () => Promise<void> }[] = [
    {
      name: 'lists and orders before findings',
      run: async () => {
        const f = await fixture();
        try {
          f.deps.delegate = async (provider) =>
            reply(
              provider === 'claude'
                ? blockedReport('Cannot read the session artifact')
                : report('§ Work', 'A defect', 'SHOULD'),
            );
          const result = await f.call();
          assert.equal(result.exit, 0, JSON.stringify(result));
          assert.deepEqual(result.value.blocked, [
            { slot: 'claude[0]', provider: 'claude', model: 'fake', reason: 'Cannot read the session artifact' },
          ]);
          assert.match(result.output.summary, /blocked claude\[0\]: Cannot read the session artifact/);
          const summary = result.output.summary;
          assert.ok(summary.indexOf('blocked claude[0]:') < summary.indexOf('R1-F001'), summary);
        } finally {
          f.cleanup();
        }
      },
    },
    {
      name: 'all blocked carries reasons',
      run: async () => {
        const f = await fixture();
        try {
          f.deps.delegate = async (provider) => reply(blockedReport(provider + ' cannot read the artifact'));
          const result = await f.call();
          assert.equal(result.exit, 2);
          assert.equal(result.output.reason, 'review-failed');
          assert.match(
            result.output.summary,
            /^blocked claude\[0\]: claude cannot read the artifact; blocked agy\[0\]: agy cannot read the artifact; Every review slot failed/,
          );
        } finally {
          f.cleanup();
        }
      },
    },
    {
      name: 'shared prefix stays distinct',
      run: async () => {
        const f = await fixture();
        try {
          configure(f, {
            'read-delegates': {
              claude: { targets: [{ low: { model: ['a', 'b', 'ok'] } }] },
              agy: { targets: [{ low: { model: 'fake' } }] },
            },
          });
          const prefix = 'p'.repeat(240);
          f.deps.delegate = async (provider, request) =>
            reply(
              provider === 'claude' && request.model === 'a'
                ? blockedReport(prefix + 'A')
                : provider === 'claude' && request.model === 'b'
                  ? blockedReport(prefix + 'B')
                  : CLEAN,
            );
          const result = await f.call();
          assert.equal(result.exit, 0, JSON.stringify(result));
          assert.deepEqual(
            result.value.blocked.map((entry: { model: string; reason: string }) => [entry.model, entry.reason]),
            [
              ['a', 'p'.repeat(200)],
              ['b', 'p'.repeat(200)],
            ],
          );
        } finally {
          f.cleanup();
        }
      },
    },
    {
      name: 'sanitized-empty stays distinct',
      run: async () => {
        const f = await fixture();
        try {
          f.deps.delegate = async (provider) =>
            reply(provider === 'claude' ? blockedReport('<invoke name="alpha">') : report());
          assert.equal((await f.call()).exit, 0, JSON.stringify(f.output()));
          await f.add('ruling', { subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Fixed' });
          fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
          f.deps.delegate = async (provider) =>
            reply(provider === 'claude' ? blockedReport('<invoke name="beta">') : CLEAN);
          const second = await f.call();
          assert.equal(second.exit, 0, JSON.stringify(second));
          assert.equal(second.value.blocked[0].reason, '(reason removed by sanitizer)');
          assert.equal(second.value.blockers, undefined);
        } finally {
          f.cleanup();
        }
      },
    },
  ];
  for (const item of cases) await item.run();
});

test('blocked slots, blockers and pending keep their notice', async () => {
  const cases: { name: string; run: () => Promise<void> }[] = [
    {
      name: 'native pending lists blocked',
      run: async () => {
        const f = await fixture();
        try {
          configure(f, {
            'read-delegates': {
              claude: { targets: [{ low: { model: 'fake' } }] },
              codex: { nativeSubagentsOnly: true, targets: [{ low: { model: 'native' } }] },
            },
          });
          f.deps.liveness = { claude: true };
          f.deps.orchestrator = { platform: 'codex', model: 'native' } as typeof f.deps.orchestrator;
          f.deps.delegate = async () => reply(blockedReport('Cannot read the session artifact'));
          const pending = await f.call();
          assert.equal(pending.exit, 4);
          assert.equal(pending.output.reason, 'native-pending');
          assert.deepEqual(pending.value.blocked, [
            { slot: 'claude[0]', provider: 'claude', model: 'fake', reason: 'Cannot read the session artifact' },
          ]);
          assert.match(pending.output.summary, /blocked claude\[0\]: Cannot read the session artifact/);
          for (const slot of pending.value.pending) fs.writeFileSync(slot.replyPath, CLEAN);
          const done = await f.call();
          assert.equal(done.exit, 0, JSON.stringify(done));
          assert.deepEqual(done.value.blocked, pending.value.blocked);
        } finally {
          f.cleanup();
        }
      },
    },
    {
      name: 'native pending summary order',
      run: async () => {
        const f = await fixture();
        try {
          f.deps.orchestrator = { platform: 'claude', model: null } as typeof f.deps.orchestrator;
          const pending = await f.call();
          assert.equal(pending.exit, 4);
          assert.equal(pending.output.reason, 'native-pending');
          assert.equal(pending.value.cliWave, 'pending');
          assert.match(pending.output.summary, /1 native slot/);
          const lower = pending.output.summary.toLowerCase();
          assert.ok(
            lower.indexOf('launch') >= 0 && lower.indexOf('launch') < lower.indexOf('rerun'),
            pending.output.summary,
          );
          const waved = await f.call();
          assert.equal(waved.exit, 4);
          assert.equal(waved.output.reason, 'native-pending');
          assert.equal(waved.value.cliWave, 'done');
          assert.doesNotMatch(waved.output.summary, /at once/i);
          assert.doesNotMatch(waved.output.summary, /launch them now/i);
        } finally {
          f.cleanup();
        }
      },
    },
    {
      name: 'many blocked keep notice',
      run: async () => {
        const f = await fixture();
        try {
          const models = Array.from({ length: 10 }, (_, index) => 'm' + index);
          configure(f, {
            'read-delegates': {
              claude: { targets: [{ low: { model: [...models, 'ok'] } }] },
              agy: { targets: [{ low: { model: 'fake' } }] },
            },
          });
          const delegate = (provider: string, request: { model: string | null }, finding: string) =>
            reply(
              provider === 'claude' && models.includes(request.model ?? '')
                ? blockedReport(request.model + ' denied')
                : provider === 'agy'
                  ? finding
                  : CLEAN,
            );
          f.deps.delegate = async (provider, request) => delegate(provider, request, report());
          assert.equal((await f.call()).exit, 0, JSON.stringify(f.output()));
          await f.add('ruling', { subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Fixed' });
          fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
          f.deps.delegate = async (provider, request) => delegate(provider, request, CLEAN);
          const second = await f.call();
          assert.equal(second.exit, 0, JSON.stringify(second));
          assert.equal(second.value.blocked.length, 10);
          assert.equal(second.value.blockers.length, 10);
          assert.match(second.output.summary, /orchestrator blocker claude\[0\]: m0 denied/);
          assert.match(second.output.summary, /\+\d+ more blocked/);
          assert.ok(Buffer.byteLength(second.output.summary, 'utf8') <= 1024);
        } finally {
          f.cleanup();
        }
      },
    },
    {
      name: 'repeated becomes blocker and survives interruption',
      run: async () => {
        const f = await fixture();
        try {
          f.deps.delegate = async (provider) =>
            reply(provider === 'claude' ? blockedReport('Artifact denied by the guard') : report());
          assert.equal((await f.call()).exit, 0, JSON.stringify(f.output()));
          await f.add('ruling', { subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Fixed' });
          fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
          f.deps.delegate = async (provider) =>
            reply(provider === 'claude' ? blockedReport('Artifact denied by the guard') : CLEAN);
          f.deps.hook = (point) => {
            if (point === 'review:after-pending') throw new Error('Interrupted');
          };
          assert.equal((await f.call()).exit, 2);
          delete f.deps.hook;
          const resumed = await f.call();
          assert.equal(resumed.exit, 0, JSON.stringify(resumed));
          assert.deepEqual(resumed.value.blocked, [
            { slot: 'claude[0]', provider: 'claude', model: 'fake', reason: 'Artifact denied by the guard' },
          ]);
          assert.deepEqual(resumed.value.blockers, [
            { slot: 'claude[0]', reason: 'Artifact denied by the guard', rounds: [1, 2] },
          ]);
          assert.match(
            resumed.output.summary,
            /orchestrator blocker claude\[0\]: Artifact denied by the guard \(rounds 1-2\)/,
          );
        } finally {
          f.cleanup();
        }
      },
    },
    {
      name: 'all blocked names blocker',
      run: async () => {
        const f = await fixture();
        try {
          f.deps.delegate = async (provider) =>
            reply(provider === 'claude' ? blockedReport('Artifact denied by the guard') : report());
          assert.equal((await f.call()).exit, 0, JSON.stringify(f.output()));
          await f.add('ruling', { subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'Fixed' });
          fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
          f.deps.delegate = async (provider) =>
            reply(
              provider === 'claude' ? blockedReport('Artifact denied by the guard') : blockedReport('Second blocker'),
            );
          const failed = await f.call();
          assert.equal(failed.exit, 2);
          assert.equal(failed.output.reason, 'review-failed');
          assert.match(
            failed.output.summary,
            /^orchestrator blocker claude\[0\]: Artifact denied by the guard \(rounds 1-2\)/,
          );
          assert.match(failed.output.summary, /blocked agy\[0\]: Second blocker/);
        } finally {
          f.cleanup();
        }
      },
    },
    {
      name: 'blocker compares last round',
      run: async () => {
        const f = await fixture();
        try {
          configure(
            f,
            {
              'read-delegates': {
                claude: { targets: [{ low: { model: 'fake' } }] },
                agy: { targets: [{ low: { model: 'fake' } }] },
              },
            },
            3,
          );
          f.deps.delegate = async (provider) => reply(provider === 'claude' ? blockedReport('First blocker') : CLEAN);
          assert.equal((await f.call()).exit, 0, JSON.stringify(f.output()));
          fs.mkdirSync(path.join(f.directory, 'round-2'), { recursive: true });
          const metadata = f.read(1, 'round.json');
          fs.mkdirSync(path.join(f.directory, 'round-3'), { recursive: true });
          fs.writeFileSync(path.join(f.directory, 'round-3/round.json'), JSON.stringify({ ...metadata, round: 3 }));
          const result = await f.call();
          assert.equal(result.exit, 0, JSON.stringify(result));
          assert.deepEqual(result.value.blockers, [{ slot: 'claude[0]', reason: 'First blocker', rounds: [1, 3] }]);
        } finally {
          f.cleanup();
        }
      },
    },
    {
      name: 'raw absent from files',
      run: async () => {
        const f = await fixture();
        try {
          const { createHash } = await import('node:crypto');
          const raw = 'Denied because ' + 'x'.repeat(300) + ' TAILMARKER';
          f.deps.delegate = async (provider) => reply(provider === 'claude' ? blockedReport(raw) : CLEAN);
          const result = await f.call();
          assert.equal(result.exit, 0, JSON.stringify(result));
          const slotFile = path.join(f.directory, 'round-1/gen-1/slots/claude[0].json');
          const findingsFile = path.join(f.directory, 'round-1/findings.json');
          const slotText = fs.readFileSync(slotFile, 'utf8'),
            findingsText = fs.readFileSync(findingsFile, 'utf8');
          assert.ok(!slotText.includes('TAILMARKER'), 'slot keeps only the clipped display reason');
          assert.ok(!findingsText.includes('TAILMARKER'), 'findings keep only the clipped display reason');
          const slot = JSON.parse(slotText);
          assert.equal(slot.blocked[0].reason, ('Denied because ' + 'x'.repeat(300)).slice(0, 200));
          assert.equal(slot.blocked[0].reasonHash, createHash('sha256').update(raw.trim()).digest('hex'));
        } finally {
          f.cleanup();
        }
      },
    },
  ];
  for (const item of cases) await item.run();
});

test('report failure class names a missing report and keeps refusal wording', async () => {
  const cases = [
    {
      name: 'missing',
      text: 'Analysis finished; the plan shows no blocking defects.',
      cls: 'no-report',
      reason: /^uncovered-scope: /,
    },
    { name: 'refusal', text: "I can't review this plan.", cls: 'refusal', reason: /^refusal: / },
    { name: 'blocked', text: blockedReport('Cannot read the plan'), cls: 'blocked', reason: /^blocked: / },
    { name: 'empty', text: '', cls: 'empty-output', reason: /^empty-output: / },
  ] as const;
  for (const item of cases) {
    const f = await fixture();
    try {
      f.deps.delegate = async (provider) => reply(provider === 'claude' ? item.text : CLEAN);
      const result = await f.call();
      assert.equal(result.exit, 0, item.name + ': ' + JSON.stringify(result));
      const failed = f.read(1, 'findings.json').failed as { slot: string; cls: string; reason: string }[];
      assert.deepEqual(
        failed.map((row) => [row.slot, row.cls]),
        [['claude[0]', item.cls]],
        item.name,
      );
      assert.match(failed[0]!.reason, item.reason, item.name);
    } finally {
      f.cleanup();
    }
  }
});

// SECTION: Review ceiling
type ReviewFixture = Awaited<ReturnType<typeof fixture>>;
const PLAN_REVIEW = 'plan-work.plan';
const ceilingId = (review: string, ceiling: number) => 'ceiling:' + review + ':' + ceiling;
const ceilingRows = (f: ReviewFixture, review = PLAN_REVIEW) =>
  foldLedger(f.session).records.filter(
    (row) => row.kind === 'escalation' && String(row.data['id']).startsWith('ceiling:' + review + ':'),
  );
const openCeilingRows = (f: ReviewFixture, review = PLAN_REVIEW) => {
  const latest = new Map<string, string>();
  for (const row of ceilingRows(f, review)) latest.set(String(row.data['id']), String(row.data['state']));
  return [...latest].filter(([, state]) => state === 'open');
};
const addRecord = (f: ReviewFixture, record: object) => appendRecord(f.session, record, f.deps);
const openCeiling = (f: ReviewFixture, review: string, ceiling: number) =>
  addRecord(f, {
    kind: 'escalation',
    by: 'tool',
    key: ceilingId(review, ceiling),
    data: { id: ceilingId(review, ceiling), state: 'open', summary: 'ceiling ' + ceiling + ' reached' },
  });
const resolveCeiling = (
  f: ReviewFixture,
  review: string,
  ceiling: number,
  summary: string,
  options: { by?: string; quote?: string; key?: string } = {},
) =>
  addRecord(f, {
    kind: 'escalation',
    by: options.by ?? 'user',
    quote: options.quote ?? 'User decision',
    key: options.key ?? ceilingId(review, ceiling) + ':resolved',
    data: { id: ceilingId(review, ceiling), state: 'resolved', summary },
  });
const planDelegate = (f: ReviewFixture, text: string) => {
  f.deps.delegate = async (provider, request, mode) => {
    f.launches.push({ provider, request, mode });
    return { outcome: { status: 'ok', text, resume: null, sessionId: null }, invocations: [] };
  };
};
const planAccepted = async (f: ReviewFixture, step: number, change = true) => {
  planDelegate(f, report('§ Work', 'Defect ' + step, 'MUST'));
  const result = await f.call();
  assert.equal(result.exit, 0, JSON.stringify(result));
  await f.add('ruling', {
    subject: 'review:' + PLAN_REVIEW + ':R' + step + '-F001',
    ruling: 'accepted',
    rationale: 'Resolution',
  });
  if (change) fs.appendFileSync(f.plan, '\n## Fix ' + step + '\nChanged.\n');
  return result;
};
const callDefaultLevel = async (f: ReviewFixture) => {
  f.lines.length = 0;
  const exit = await main(
    ['review', 'run', f.plan, '--kind', 'plan', '--session', f.session, '--host', 'opencode'],
    f.deps,
  );
  const output = f.output();
  return { exit, output, value: output.path ? JSON.parse(fs.readFileSync(output.path, 'utf8')) : null };
};
const setPlanRounds = (f: ReviewFixture, level: string, rounds: number) => {
  const file = path.join(f.deps.skillRoot, 'config.jsonc');
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    phases: Record<string, { rounds: Record<string, number> }>;
  };
  config.phases['plan-review']!.rounds[level] = rounds;
  fs.writeFileSync(file, JSON.stringify(config));
};
const singlePlanTarget = (f: ReviewFixture) => {
  const file = path.join(f.deps.skillRoot, 'config.jsonc');
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    phases: Record<string, { targets: Record<string, number> }>;
  };
  config.phases['plan-review']!.targets['medium'] = 1;
  fs.writeFileSync(file, JSON.stringify(config));
};
const seedRound = (f: ReviewFixture, round: number) => {
  const directory = path.join(f.directory, 'round-' + round);
  fs.mkdirSync(directory, { recursive: true });
  const metadata = f.read(round - 1, 'round.json');
  fs.writeFileSync(path.join(directory, 'round.json'), JSON.stringify({ ...metadata, round, generation: 1 }));
};
const seededFinding = (id: string, severity: 'MUST' | 'SHOULD') => ({
  id,
  severity,
  category: 'reliability',
  locus: '§ Work',
  defect: 'Defect ' + id,
  requiredChange: 'Fix ' + id,
  sources: ['claude[0]'],
  scope: 'in',
});
const seedCompletedRound = (
  f: ReviewFixture,
  round: number,
  findings: object[],
  rulingSnapshot = '[]',
  startSeq = 0,
) => {
  const directory = path.join(f.directory, 'round-' + round),
    plan = fs.readFileSync(f.plan, 'utf8');
  const metadata = {
    round,
    generation: 1,
    cap: 2,
    level: 'medium',
    roster: [{ slot: 'claude[0]', provider: 'claude', model: 'fake', index: 0, reserve: false }],
    scope: 'Full review',
    startSeq,
    rulingSnapshot,
    spec: { path: fs.realpathSync.native(f.spec), hash: artifactHash('spec', fs.readFileSync(f.spec, 'utf8')) },
    target: artifactHash('plan', plan),
    turnTarget: 8,
    artifactPath: fs.realpathSync.native(f.plan),
  };
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'target.snapshot.md'), plan);
  fs.writeFileSync(path.join(directory, 'round.json'), JSON.stringify(metadata));
  fs.writeFileSync(
    path.join(directory, 'findings.json'),
    JSON.stringify({ review: PLAN_REVIEW, round, cap: 2, level: 'medium', findings, clusters: [], failed: [] }),
  );
  // cap₁ comes from round 1, so a seeded later round needs its baseline metadata.
  if (round !== 1) {
    fs.mkdirSync(path.join(f.directory, 'round-1'), { recursive: true });
    fs.writeFileSync(path.join(f.directory, 'round-1', 'round.json'), JSON.stringify({ ...metadata, round: 1 }));
  }
};
const seedAcceptedCeiling = async (f: ReviewFixture) => {
  singlePlanTarget(f);
  const ruling = await f.add('ruling', {
    subject: 'review:' + PLAN_REVIEW + ':R4-F001',
    ruling: 'accepted',
    rationale: 'Resolution',
  });
  seedCompletedRound(f, 4, [seededFinding('R4-F001', 'MUST')], JSON.stringify([['R4-F001', ruling.seq]]));
};
const seedAcceptedRound = async (f: ReviewFixture, round: number) => {
  const id = 'R' + round + '-F001';
  const ruling = await f.add('ruling', {
    subject: 'review:' + PLAN_REVIEW + ':' + id,
    ruling: 'accepted',
    rationale: 'Resolution',
  });
  seedCompletedRound(f, round, [seededFinding(id, 'MUST')], JSON.stringify([[id, ruling.seq]]), ruling.seq);
};
const grantCeiling = async (f: ReviewFixture, ceiling = 4) => {
  await openCeiling(f, PLAN_REVIEW, ceiling);
  await resolveCeiling(f, PLAN_REVIEW, ceiling, 're-author: rewrite the plan under current evidence');
};
const deferCeiling = async (f: ReviewFixture, ceiling = 4) => {
  await openCeiling(f, PLAN_REVIEW, ceiling);
  await resolveCeiling(f, PLAN_REVIEW, ceiling, 'defer: rule the remaining MUST findings deferred');
};
const confirmDelegate = (f: ReviewFixture, decision: 'agree' | 'disagree' = 'agree') => {
  f.deps.delegate = async (provider, request, mode) => {
    f.launches.push({ provider, request, mode });
    const ids = [...fs.readFileSync(request.promptPath, 'utf8').matchAll(/Request ID: `([^`]+)`/g)].map(
      (match) => match[1]!,
    );
    return {
      outcome: {
        status: 'ok',
        text: JSON.stringify({
          status: 'CLEAN',
          findings: [],
          confirmations: ids.map((requestId) => ({ requestId, decision, rationale: 'Verified the captured evidence' })),
        }),
        resume: null,
        sessionId: null,
      },
      invocations: [],
    };
  };
};
const worktreeRun = (f: ReviewFixture) => {
  f.deps.run = async (argv) => ({
    exit: 0,
    stdout:
      argv[1] === 'diff'
        ? 'src.ts\0'
        : argv[1] === 'write-tree'
          ? 'tree-id'
          : argv[1] === 'commit-tree'
            ? 'snapshot-id'
            : argv[1] === 'rev-parse'
              ? 'head-id'
              : '',
    stderr: '',
  });
};
const codeAccepted = async (f: ReviewFixture, step: number, review?: string) => {
  f.deps.delegate = async (provider, request, mode) => {
    f.launches.push({ provider, request, mode });
    return {
      outcome: { status: 'ok', text: report('src.ts:L1', 'Defect ' + step, 'MUST'), resume: null, sessionId: null },
      invocations: [],
    };
  };
  const result = await f.call('code', 'worktree');
  assert.equal(result.exit, 0, JSON.stringify(result));
  const id = review ?? result.value.review;
  await f.add('ruling', {
    subject: 'review:' + id + ':R' + step + '-F001',
    ruling: 'accepted',
    rationale: 'Resolution',
  });
  return result;
};

test('review ceiling admission grants rounds by resolution and refuses otherwise', async () => {
  const viaPlan = async (f: ReviewFixture) => {
    const result = await f.call();
    return { exit: result.exit, reason: result.output.reason as string | undefined };
  };
  const viaLow = async (f: ReviewFixture) => {
    f.lines.length = 0;
    const exit = await main(
      ['review', 'run', f.plan, '--kind', 'plan', '--level', 'low', '--session', f.session, '--host', 'opencode'],
      f.deps,
    );
    return { exit, reason: f.output().reason as string | undefined };
  };
  const rows: {
    name: string;
    seed: (f: ReviewFixture) => Promise<unknown>;
    invoke?: 'low';
    run?: (f: ReviewFixture, ctx: unknown) => Promise<{ exit: number; reason?: string }>;
    exit: number;
    reason?: string;
    check?: (f: ReviewFixture, ctx: unknown) => unknown;
  }[] = [
    {
      name: 'accepted MUST past the ceiling opens an escalation',
      seed: async (f) => {
        await seedAcceptedCeiling(f);
      },
      exit: 4,
      reason: 'review-ceiling',
      check: (f) => {
        assert.equal(f.launches.length, 0);
        assert.equal(fs.existsSync(path.join(f.directory, 'round-5')), false);
        const escalation = foldLedger(f.session).records.at(-1)!;
        assert.equal(escalation.kind, 'escalation');
        assert.equal(escalation.key, ceilingId(PLAN_REVIEW, 4));
        assert.equal(escalation.data['id'], ceilingId(PLAN_REVIEW, 4));
        assert.equal(escalation.data['state'], 'open');
      },
    },
    {
      name: 'rejected MUST past the ceiling opens an escalation',
      seed: async (f) => {
        await seedAcceptedCeiling(f);
        await f.add('ruling', {
          subject: 'review:' + PLAN_REVIEW + ':R4-F001',
          ruling: 'rejected',
          rationale: 'Still broken',
        });
      },
      exit: 4,
      reason: 'review-ceiling',
      check: (f) => {
        assert.equal(f.launches.length, 0);
        assert.equal(fs.existsSync(path.join(f.directory, 'round-5')), false);
        assert.equal(foldLedger(f.session).records.at(-1)!.data['state'], 'open');
      },
    },
    {
      name: 'duplicate ruling past the ceiling stays round-cap',
      seed: async (f) => {
        await seedAcceptedCeiling(f);
        await f.add('ruling', {
          subject: 'review:' + PLAN_REVIEW + ':R4-F001',
          ruling: 'duplicate',
          rationale: 'Same original claim',
        });
      },
      exit: 4,
      reason: 'round-cap',
      check: (f) => {
        assert.equal(openCeilingRows(f).length, 0);
        assert.equal(fs.existsSync(path.join(f.directory, 'round-5')), false);
      },
    },
    {
      name: 'open ceiling blocks review at any level',
      seed: async (f) => {
        await seedAcceptedCeiling(f);
        await openCeiling(f, PLAN_REVIEW, 4);
        return { launches: f.launches.length, seq: foldLedger(f.session).lastSeq };
      },
      exit: 4,
      reason: 'escalation-open',
      check: async (f, ctx) => {
        const base = ctx as { launches: number; seq: number };
        assert.equal(f.launches.length, base.launches);
        assert.equal(foldLedger(f.session).lastSeq, base.seq);
        f.lines.length = 0;
        const exit = await main(
          ['review', 'run', f.plan, '--kind', 'plan', '--level', 'low', '--session', f.session, '--host', 'opencode'],
          f.deps,
        );
        assert.equal(exit, 4);
        assert.equal(f.output().reason, 'escalation-open');
      },
    },
    {
      name: 'zero round level opens the saved ceiling',
      seed: seedAcceptedCeiling,
      invoke: 'low',
      exit: 4,
      reason: 'review-ceiling',
      check: (f) => {
        assert.deepEqual(openCeilingRows(f), [[ceilingId(PLAN_REVIEW, 4), 'open']]);
      },
    },
    {
      name: 'zero round level refuses a saved round cap',
      seed: async (f) => {
        seedCompletedRound(f, 2, [seededFinding('R2-F001', 'SHOULD')]);
      },
      invoke: 'low',
      exit: 4,
      reason: 'round-cap',
      check: (f) => {
        assert.match(f.output().summary, /round cap 2/);
        assert.ok(!fs.existsSync(path.join(f.directory, 'round-3')));
      },
    },
    {
      name: 'zero round level runs a pending rejection confirmation',
      seed: async (f) => {
        seedCompletedRound(f, 2, [seededFinding('R2-F001', 'MUST')]);
        await f.add('ruling', {
          subject: 'review:' + PLAN_REVIEW + ':R2-F001',
          ruling: 'rejected',
          rationale: 'Still broken',
        });
        confirmDelegate(f);
      },
      invoke: 'low',
      exit: 0,
      check: (f) => {
        assert.ok(fs.existsSync(path.join(f.directory, 'round-3', 'findings.json')));
      },
    },
    {
      name: 'zero round level reuses an incomplete saved round',
      seed: async (f) => {
        await seedAcceptedCeiling(f);
        seedRound(f, 5);
        planDelegate(f, report('§ Work', 'Defect 5', 'MUST'));
      },
      invoke: 'low',
      exit: 0,
      check: (f) => {
        assert.ok(fs.existsSync(path.join(f.directory, 'round-5/findings.json')));
        assert.equal(openCeilingRows(f).length, 0);
      },
    },
    {
      name: 'zero round level reuses a staffed reviewer on a moved round',
      seed: async (f) => {
        seedCompletedRound(f, 1, []);
        seedRound(f, 2);
        fs.appendFileSync(f.plan, '\n## Moved\nChanged.\n');
        planDelegate(f, CLEAN);
      },
      invoke: 'low',
      exit: 0,
      check: (f) => {
        assert.ok(fs.existsSync(path.join(f.directory, 'round-2/findings.json')));
      },
    },
    {
      name: 'resolved ceiling grants two rounds',
      seed: async (f) => {
        await seedAcceptedCeiling(f);
        await grantCeiling(f);
      },
      run: async (f) => {
        await planAccepted(f, 5);
        const sixth = await planAccepted(f, 6);
        assert.match(sixth.output.summary, /round 6\/2/);
        return { exit: sixth.exit };
      },
      exit: 0,
      check: (f) => {
        assert.equal(f.read(5, 'round.json').cap, 2);
        assert.equal(f.read(6, 'round.json').cap, 2);
        assert.ok(fs.existsSync(path.join(f.directory, 'round-6/findings.json')));
      },
    },
    {
      name: 'deferred ceiling grants no rounds',
      seed: async (f) => {
        await seedAcceptedCeiling(f);
        await deferCeiling(f);
      },
      exit: 4,
      reason: 'round-cap',
      check: async (f) => {
        assert.equal(fs.existsSync(path.join(f.directory, 'round-5')), false);
        assert.equal(openCeilingRows(f).length, 0);
        await f.add('ruling', {
          subject: 'review:' + PLAN_REVIEW + ':R4-F001',
          ruling: 'deferred',
          rationale: 'Follow-up',
        });
        const second = await f.call();
        assert.equal(second.exit, 4);
        assert.equal(second.output.reason, 'round-cap');
        assert.equal(openCeilingRows(f).length, 0);
      },
    },
    {
      name: 'closed ceiling grants no rounds',
      seed: async (f) => {
        await seedAcceptedCeiling(f);
        await openCeiling(f, PLAN_REVIEW, 4);
        await resolveCeiling(f, PLAN_REVIEW, 4, 'close: proceed with fixes');
      },
      exit: 4,
      reason: 'round-cap',
      check: (f) => {
        assert.equal(fs.existsSync(path.join(f.directory, 'round-5')), false);
        assert.equal(openCeilingRows(f).length, 0);
      },
    },
    {
      name: 'closed ceiling runs full review for mixed MUSTs',
      seed: async (f) => {
        singlePlanTarget(f);
        const rejected = await f.add('ruling', {
          subject: 'review:' + PLAN_REVIEW + ':R4-F001',
          ruling: 'rejected',
          rationale: 'Still broken',
        });
        const accepted = await f.add('ruling', {
          subject: 'review:' + PLAN_REVIEW + ':R4-F002',
          ruling: 'accepted',
          rationale: 'Fixed',
        });
        const findings = [seededFinding('R4-F001', 'MUST'), seededFinding('R4-F002', 'MUST')];
        seedCompletedRound(
          f,
          4,
          findings,
          JSON.stringify([
            ['R4-F001', rejected.seq],
            ['R4-F002', accepted.seq],
          ]),
        );
        await openCeiling(f, PLAN_REVIEW, 4);
        await resolveCeiling(f, PLAN_REVIEW, 4, 'close: proceed with fixes');
        confirmDelegate(f);
      },
      exit: 0,
      check: (f) => {
        const round = f.read(5, 'round.json');
        assert.match(round.scope, /^Re-review round 5 \(full\)/);
        assert.equal(round.requests.length, 1);
        assert.equal(f.read(5, 'findings.json').confirmations.length, 1);
      },
    },
    {
      name: 'accepted MUST after a granted ceiling opens an escalation',
      seed: async (f) => {
        await seedAcceptedCeiling(f);
        await grantCeiling(f);
        await seedAcceptedRound(f, 5);
        await seedAcceptedRound(f, 6);
      },
      exit: 4,
      reason: 'review-ceiling',
      check: (f) => {
        assert.deepEqual(foldLedger(f.session).records.at(-1)!.data, {
          id: ceilingId(PLAN_REVIEW, 6),
          state: 'open',
          summary: 'ceiling 6 reached',
        });
      },
    },
    {
      name: 'code review defer grants nothing',
      seed: async (f) => {
        worktreeRun(f);
        const file = path.join(f.deps.skillRoot, 'config.jsonc');
        const config = JSON.parse(fs.readFileSync(file, 'utf8')) as {
          phases: Record<string, { targets: Record<string, number>; rounds: Record<string, number> }>;
        };
        config.phases['code-review']!.targets['low'] = 1;
        config.phases['code-review']!.rounds['low'] = 1;
        fs.writeFileSync(file, JSON.stringify(config));
        const first = await codeAccepted(f, 1);
        await openCeiling(f, first.value.review, 3);
        return { review: first.value.review };
      },
      run: async (f, ctx) => {
        const review = (ctx as { review: string }).review;
        const launches = f.launches.length;
        await assert.rejects(resolveCeiling(f, review, 3, 'defer: accept as follow-up'), { reason: 'invalid-record' });
        const blocked = await f.call('code', 'worktree');
        assert.equal(f.launches.length, launches);
        return { exit: blocked.exit, reason: blocked.output.reason as string };
      },
      exit: 4,
      reason: 'escalation-open',
    },
    {
      name: 'cap past without a ceiling starts a round',
      seed: async (f) => {
        singlePlanTarget(f);
        const ruling = await f.add('ruling', {
          subject: 'review:' + PLAN_REVIEW + ':R2-F001',
          ruling: 'accepted',
          rationale: 'Resolution',
        });
        seedCompletedRound(f, 2, [seededFinding('R2-F001', 'MUST')], JSON.stringify([['R2-F001', ruling.seq]]));
      },
      run: async (f) => {
        const result = await planAccepted(f, 3);
        assert.match(result.output.summary, /round 3\/2/);
        return { exit: result.exit };
      },
      exit: 0,
      check: (f) => {
        assert.equal(f.read(3, 'round.json').cap, 2);
      },
    },
    {
      name: 'granted clean round then launch stays round-cap',
      seed: async (f) => {
        await seedAcceptedCeiling(f);
        await grantCeiling(f);
        seedCompletedRound(f, 5, [], '[]', foldLedger(f.session).lastSeq);
      },
      exit: 4,
      reason: 'round-cap',
      check: (f) => {
        assert.equal(f.launches.length, 0);
      },
    },
    {
      name: 'incomplete round above the ceiling is reused',
      seed: async (f) => {
        await seedAcceptedCeiling(f);
        seedRound(f, 5);
        await openCeiling(f, PLAN_REVIEW, 4);
        planDelegate(f, report('§ Work', 'Defect 5', 'MUST'));
      },
      exit: 0,
      check: (f) => {
        assert.ok(fs.existsSync(path.join(f.directory, 'round-5/findings.json')));
      },
    },
    {
      name: 'incomplete round past the cap without a MUST stays round-cap',
      seed: async (f) => {
        seedCompletedRound(f, 2, [seededFinding('R2-F001', 'SHOULD')]);
        seedRound(f, 3);
      },
      exit: 4,
      reason: 'round-cap',
      check: (f) => {
        assert.equal(f.launches.length, 0);
        assert.equal(fs.existsSync(path.join(f.directory, 'round-3/findings.json')), false);
      },
    },
  ];
  for (const row of rows) {
    const f = await fixture();
    try {
      const ctx = await row.seed(f);
      const outcome = row.run ? await row.run(f, ctx) : row.invoke === 'low' ? await viaLow(f) : await viaPlan(f);
      assert.equal(outcome.exit, row.exit, row.name);
      if (row.reason !== undefined) assert.equal(outcome.reason, row.reason, row.name);
      await row.check?.(f, ctx);
    } finally {
      f.cleanup();
    }
  }
});

test('moved incomplete round is refused without replacing pending state', async () => {
  // Zero round level with a moved target keeps the saved round, snapshot, and pending payload.
  {
    const f = await fixture();
    try {
      await seedAcceptedCeiling(f);
      seedRound(f, 5);
      const snapshotPath = path.join(f.directory, 'round-5', 'target.snapshot.md');
      const snapshot = fs.existsSync(snapshotPath) ? fs.readFileSync(snapshotPath, 'utf8') : null;
      const generations = fs.readdirSync(path.join(f.directory, 'round-5')).filter((name) => name.startsWith('gen-'));
      const pendingPath = path.join(f.directory, 'round-5', 'pending.json');
      const pendingEscalation = {
        kind: 'escalation',
        by: 'tool',
        key: 'pending-esc',
        data: { id: 'pending-esc', state: 'open', summary: 'pending' },
      };
      await addRecord(f, pendingEscalation);
      fs.writeFileSync(pendingPath, JSON.stringify({ findings: [], failed: [], escalations: [pendingEscalation] }));
      const pendingBytes = fs.readFileSync(pendingPath, 'utf8');
      fs.appendFileSync(f.plan, '\n## Moved\nChanged.\n');
      f.lines.length = 0;
      const exit = await main(
        ['review', 'run', f.plan, '--kind', 'plan', '--level', 'low', '--session', f.session, '--host', 'opencode'],
        f.deps,
      );
      assert.equal(exit, 4);
      assert.equal(f.output().reason, 'level-unapproved');
      assert.ok(f.read(5, 'round.json').roster.length > 0);
      assert.equal(fs.existsSync(snapshotPath) ? fs.readFileSync(snapshotPath, 'utf8') : null, snapshot);
      assert.deepEqual(
        fs.readdirSync(path.join(f.directory, 'round-5')).filter((name) => name.startsWith('gen-')),
        generations,
      );
      assert.ok(fs.existsSync(pendingPath));
      assert.equal(fs.readFileSync(pendingPath, 'utf8'), pendingBytes);
      assert.ok(!foldLedger(f.session).records.some((row) => row.key === 'pending-esc:superseded'));
    } finally {
      f.cleanup();
    }
  }

  // Staffed level with no live reviewer keeps the pending payload and names the underfill.
  {
    const f = await fixture();
    try {
      const ruling = await f.add('ruling', {
        subject: 'review:' + PLAN_REVIEW + ':R4-F001',
        ruling: 'accepted',
        rationale: 'Fixed',
      });
      seedCompletedRound(
        f,
        4,
        [seededFinding('R4-F001', 'MUST')],
        JSON.stringify([['R4-F001', ruling.seq]]),
        ruling.seq,
      );
      seedRound(f, 5);
      const pendingPath = path.join(f.directory, 'round-5', 'pending.json');
      const pendingEscalation = {
        kind: 'escalation',
        by: 'tool',
        key: 'pending-esc',
        data: { id: 'pending-esc', state: 'open', summary: 'pending' },
      };
      await addRecord(f, pendingEscalation);
      fs.writeFileSync(pendingPath, JSON.stringify({ findings: [], failed: [], escalations: [pendingEscalation] }));
      const pendingBytes = fs.readFileSync(pendingPath, 'utf8');
      fs.appendFileSync(f.plan, '\n## Moved\nChanged.\n');
      f.deps.liveness = { claude: false, agy: false, codex: false, copilot: false, opencode: false };
      f.lines.length = 0;
      const exit = await main(
        ['review', 'run', f.plan, '--kind', 'plan', '--level', 'medium', '--session', f.session, '--host', 'opencode'],
        f.deps,
      );
      assert.equal(exit, 4);
      assert.equal(f.output().reason, 'level-unapproved');
      assert.match(f.output().summary, /no live or usable reviewer/i);
      assert.match(f.output().summary, /underfill 0\/2 targets/);
      assert.equal(fs.readFileSync(pendingPath, 'utf8'), pendingBytes);
      assert.ok(!foldLedger(f.session).records.some((row) => row.key === 'pending-esc:superseded'));
    } finally {
      f.cleanup();
    }
  }
});

test('zero-round ceiling resolutions run required review for pending rejections', async () => {
  // Case 1: Rejection ruled before defer
  {
    const f = await fixture();
    try {
      await seedAcceptedCeiling(f);
      await f.add('ruling', {
        subject: 'review:' + PLAN_REVIEW + ':R4-F001',
        ruling: 'rejected',
        rationale: 'Still broken',
      });
      await deferCeiling(f);
      confirmDelegate(f);
      const result = await f.call();
      assert.equal(result.exit, 0, JSON.stringify(result));
      assert.match(f.read(5, 'round.json').scope, /^Re-review round 5 \(confirmation-only\)/);
      assert.equal(f.read(5, 'round.json').requests.length, 1);
      assert.equal(f.read(5, 'findings.json').confirmations.length, 1);
    } finally {
      f.cleanup();
    }
  }
  // Case 2: Rejection ruled after defer
  {
    const f = await fixture();
    try {
      await seedAcceptedCeiling(f);
      await deferCeiling(f);
      await f.add('ruling', {
        subject: 'review:' + PLAN_REVIEW + ':R4-F001',
        ruling: 'rejected',
        rationale: 'Late evidence',
      });
      confirmDelegate(f);
      const result = await f.call();
      assert.equal(result.exit, 0, JSON.stringify(result));
      assert.match(f.read(5, 'round.json').scope, /^Re-review round 5 \(confirmation-only\)/);
      assert.equal(f.read(5, 'round.json').requests.length, 1);
      assert.equal(f.read(5, 'findings.json').confirmations.length, 1);
    } finally {
      f.cleanup();
    }
  }
  // Case 3: Mixed accepted and rejected findings with deferred ceiling
  {
    const f = await fixture();
    try {
      singlePlanTarget(f);
      const accepted = await f.add('ruling', {
        subject: 'review:' + PLAN_REVIEW + ':R4-F001',
        ruling: 'accepted',
        rationale: 'Resolution',
      });
      const rejected = await f.add('ruling', {
        subject: 'review:' + PLAN_REVIEW + ':R4-F002',
        ruling: 'rejected',
        rationale: 'Still broken',
      });
      seedCompletedRound(
        f,
        4,
        [seededFinding('R4-F001', 'MUST'), seededFinding('R4-F002', 'MUST')],
        JSON.stringify([
          ['R4-F001', accepted.seq],
          ['R4-F002', rejected.seq],
        ]),
      );
      await deferCeiling(f);
      confirmDelegate(f);
      const result = await f.call();
      assert.equal(result.exit, 0, JSON.stringify(result));
      assert.match(f.read(5, 'round.json').scope, /^Re-review round 5 \(full\)/);
      assert.equal(f.read(5, 'round.json').requests.length, 1);
      assert.equal(f.read(5, 'findings.json').confirmations.length, 1);
    } finally {
      f.cleanup();
    }
  }
  // Case 4: Close with a pending rejection uses the confirmation-only prompt
  {
    const f = await fixture();
    try {
      singlePlanTarget(f);
      const rejected = await f.add('ruling', {
        subject: 'review:' + PLAN_REVIEW + ':R4-F001',
        ruling: 'rejected',
        rationale: 'Still broken',
      });
      const findings = [seededFinding('R4-F001', 'MUST')];
      const rulings = [['R4-F001', rejected.seq]];
      seedCompletedRound(f, 4, findings, JSON.stringify(rulings));
      await openCeiling(f, PLAN_REVIEW, 4);
      await resolveCeiling(f, PLAN_REVIEW, 4, 'close: proceed with fixes');
      confirmDelegate(f);
      const result = await f.call();
      assert.equal(result.exit, 0, JSON.stringify(result));
      const round = f.read(5, 'round.json');
      assert.match(round.scope, /^Re-review round 5 \(confirmation-only\)/);
      assert.equal(round.requests.length, 1);
      assert.equal(f.read(5, 'findings.json').confirmations.length, 1);
    } finally {
      f.cleanup();
    }
  }
});

test('first round saves current cap', async () => {
  const f = await fixture();
  try {
    singlePlanTarget(f);
    setPlanRounds(f, 'medium', 3);
    planDelegate(f, CLEAN);
    const result = await f.call();
    assert.equal(result.exit, 0, JSON.stringify(result));
    assert.equal(f.read(1, 'round.json').cap, 3);
    assert.match(result.output.summary, /round 1\/3/);
  } finally {
    f.cleanup();
  }
});

test('ceiling resolution grants once through the matching open key', async () => {
  // Orphan resolution with a non-open key grants nothing.
  {
    const f = await fixture();
    try {
      await seedAcceptedCeiling(f);
      await resolveCeiling(f, PLAN_REVIEW, 4, 're-author: rewrite the plan', {
        key: ceilingId(PLAN_REVIEW, 4) + ':orphan',
      });
      const result = await f.call();
      assert.equal(result.exit, 4);
      assert.equal(result.output.reason, 'review-ceiling');
      assert.deepEqual(foldLedger(f.session).records.at(-1)!.data, {
        id: ceilingId(PLAN_REVIEW, 4),
        state: 'open',
        summary: 'ceiling 4 reached',
      });
    } finally {
      f.cleanup();
    }
  }

  // A repeated resolution for the same open ceiling grants only once.
  {
    const f = await fixture();
    try {
      await seedAcceptedCeiling(f);
      await openCeiling(f, PLAN_REVIEW, 4);
      await resolveCeiling(f, PLAN_REVIEW, 4, 're-author: first decision', {
        key: ceilingId(PLAN_REVIEW, 4) + ':resolved-1',
      });
      await resolveCeiling(f, PLAN_REVIEW, 4, 're-author: repeated decision', {
        key: ceilingId(PLAN_REVIEW, 4) + ':resolved-2',
      });
      await seedAcceptedRound(f, 5);
      await seedAcceptedRound(f, 6);
      const result = await f.call();
      assert.equal(result.exit, 4);
      assert.equal(result.output.reason, 'review-ceiling');
      assert.equal(foldLedger(f.session).records.at(-1)!.data['id'], ceilingId(PLAN_REVIEW, 6));
    } finally {
      f.cleanup();
    }
  }
});

test('saved ceiling and round cap ignore subsequent level cap raises', async () => {
  // Saved ceiling ignores later level cap
  {
    const f = await fixture();
    try {
      await seedAcceptedCeiling(f);
      await grantCeiling(f);
      setPlanRounds(f, 'high', 8);
      await f.add('level', { level: 'high' });
      await seedAcceptedRound(f, 5);
      await seedAcceptedRound(f, 6);
      const result = await callDefaultLevel(f);
      assert.equal(result.exit, 4);
      assert.equal(result.output.reason, 'review-ceiling');
      assert.equal(foldLedger(f.session).records.at(-1)!.data['id'], ceilingId(PLAN_REVIEW, 6));
    } finally {
      f.cleanup();
    }
  }
  // Saved round cap ignores later level cap
  {
    const f = await fixture();
    try {
      singlePlanTarget(f);
      setPlanRounds(f, 'high', 8);
      seedCompletedRound(f, 1, []);
      await f.add('level', { level: 'high' });
      const second = await callDefaultLevel(f);
      assert.equal(second.exit, 0, JSON.stringify(second));
      assert.equal(f.read(2, 'round.json').cap, 2);
      const third = await callDefaultLevel(f);
      assert.equal(third.exit, 4);
      assert.equal(third.output.reason, 'round-cap');
    } finally {
      f.cleanup();
    }
  }
});

// SECTION: Advisory review budget
const statusBudget = async (f: ReviewFixture) => {
  f.lines.length = 0;
  assert.equal(await main(['status', 'show', '--session', f.session], f.deps), 0);
  return JSON.parse(fs.readFileSync(f.output().path!, 'utf8')).reviews[PLAN_REVIEW];
};

test('review budget matches admission after rulings and ceiling resolutions', async () => {
  const f = await fixture();
  try {
    await seedAcceptedCeiling(f);
    const records = foldLedger(f.session).records.length;
    const boundary = await statusBudget(f);
    assert.deepEqual(
      { ...boundary, asOfSeq: undefined },
      { cap: 2, ceiling: 4, nextRound: 5, asOfSeq: undefined, state: 'requires-ceiling-resolution' },
    );
    // Reporting the boundary opens no escalation and grants no round.
    assert.equal(foldLedger(f.session).records.length, records);
    assert.equal((await f.call()).output.reason, 'review-ceiling');

    assert.equal((await statusBudget(f)).state, 'escalation-open');
    assert.equal((await f.call()).output.reason, 'escalation-open');

    await resolveCeiling(f, PLAN_REVIEW, 4, 're-author: rewrite the plan under current evidence');
    const granted = await statusBudget(f);
    assert.deepEqual(
      { ceiling: granted.ceiling, nextRound: granted.nextRound, state: granted.state },
      { ceiling: 6, nextRound: 5, state: 'allowed' },
    );
    planDelegate(f, report('§ Work', 'Defect 5', 'MUST'));
    const fifth = await f.call();
    assert.equal(fifth.exit, 0, JSON.stringify(fifth));
    // The completed result is historical at its asOfSeq; the unruled round-5 MUST needs a continuation for round 6.
    assert.deepEqual(fifth.value.budget, {
      cap: 2,
      ceiling: 6,
      nextRound: 6,
      asOfSeq: foldLedger(f.session).lastSeq,
      state: 'requires-continuation',
    });
    assert.deepEqual(await statusBudget(f), fifth.value.budget);
    assert.equal((await f.call()).output.reason, 'round-cap');

    await f.add('ruling', {
      subject: 'review:' + PLAN_REVIEW + ':R5-F001',
      ruling: 'accepted',
      rationale: 'Resolution',
    });
    const accepted = await statusBudget(f);
    assert.equal(accepted.state, 'allowed');
    assert.ok(accepted.asOfSeq > fifth.value.budget.asOfSeq);
  } finally {
    f.cleanup();
  }
});

// SECTION: Confirmation-only fast path

const VALID_TASK_PLAN = [
  '# Work',
  '## Task Map',
  '| ID | Title | Outcome | Prerequisites | Criteria |',
  '| --- | --- | --- | --- | --- |',
  '| T1 | File | Works | none | SC1 |',
  '## Proposed Changes',
  '### T1 — File',
  '#### [NEW] src/file.ts',
  '- Purpose: behavior.',
  '## Success Criteria',
  '- [SC1] Works',
  '  - Changes: src/file.ts',
  '  - Check: `node check`',
  '  - Evidence: check',
  '## Verification Plan',
  '### Automated Tests',
  '- `node contract`',
].join('\n');
const delegateSlots = (f: ReviewFixture) => f.launches.map((launch) => launch.provider);
const targetSlotIds = (metadata: { roster: { slot: string; reserve: boolean }[] }) =>
  metadata.roster.filter((slot) => !slot.reserve).map((slot) => slot.slot);
const reserveSlotIds = (metadata: { roster: { slot: string; reserve: boolean }[] }) =>
  metadata.roster.filter((slot) => slot.reserve).map((slot) => slot.slot);
const configureAssignable = (f: ReviewFixture) =>
  configure(f, {
    'read-delegates': {
      claude: { targets: [{ low: { model: 'fake' } }] },
      agy: { targets: [{ low: { model: 'fake' } }] },
      copilot: { targets: [{ low: { model: 'fake' } }] },
    },
  });
const rejectedMustRound = async (f: ReviewFixture, target: string, kind: 'plan' | 'code', level = 'medium') => {
  f.deps.delegate = async (provider, request, mode) => {
    f.launches.push({ provider, request, mode });
    const text =
      provider === 'agy'
        ? report(kind === 'code' ? 'src/file.ts:L1' : '§ Work', 'Writes are unbounded', 'MUST')
        : CLEAN;
    return { outcome: { status: 'ok', text, resume: null, sessionId: null }, invocations: [] };
  };
  const first = await f.call(kind, target, level);
  assert.equal(first.exit, 0, JSON.stringify(first));
  await f.add('ruling', {
    subject: 'review:' + first.value.review + ':R1-F001',
    ruling: 'rejected',
    rationale: 'The captured implementation bounds each write',
  });
  return first;
};
const answerConfirmation = (f: ReviewFixture) => {
  const reads: { provider: string; prompt: string }[] = [];
  f.deps.delegate = async (provider, request, mode) => {
    f.launches.push({ provider, request, mode });
    const prompt = fs.readFileSync(request.promptPath, 'utf8');
    reads.push({ provider, prompt });
    const ids = [...prompt.matchAll(/Request ID: `([^`]+)`/g)].map((match) => match[1]!);
    const text = ids.length
      ? JSON.stringify({
          status: 'CLEAN',
          findings: [],
          confirmations: ids.map((requestId) => ({
            requestId,
            decision: 'agree',
            rationale: 'The captured evidence bounds each write',
          })),
        })
      : CLEAN;
    return { outcome: { status: 'ok', text, resume: null, sessionId: null }, invocations: [] };
  };
  return reads;
};
const seedConfirmationRound = (
  f: ReviewFixture,
  round: number,
  metadata: Record<string, unknown>,
  findings: object[] = [],
) => {
  const dir = path.join(f.directory, 'round-' + round);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'round.json'), JSON.stringify({ ...metadata, round }));
  fs.writeFileSync(
    path.join(dir, 'findings.json'),
    JSON.stringify({ review: PLAN_REVIEW, round, cap: 2, level: 'medium', findings, clusters: [], failed: [] }),
  );
  fs.writeFileSync(path.join(dir, 'target.snapshot.md'), fs.readFileSync(f.plan, 'utf8'));
};
const rewriteRound = (f: ReviewFixture, round: number, change: (metadata: Record<string, unknown>) => void) => {
  const file = path.join(f.directory, 'round-' + round, 'round.json');
  const metadata = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  change(metadata);
  fs.writeFileSync(file, JSON.stringify(metadata));
};

test('unchanged target with pending MUST rejection runs confirmation-only prompt', async () => {
  // Plan target: one source slot, reserves carried, focused prompt contents.
  {
    const f = await fixture();
    try {
      configureAssignable(f);
      await rejectedMustRound(f, f.plan, 'plan');
      const reads = answerConfirmation(f);
      f.launches.length = 0;
      const second = await f.call();
      assert.equal(second.exit, 0, JSON.stringify(second));
      const round = f.read(2, 'round.json');
      assert.match(
        round.scope,
        /^Re-review round 2 \(confirmation-only\) — comparison: sha256:[a-f0-9]+\.\.sha256:[a-f0-9]+$/,
      );
      assert.deepEqual(targetSlotIds(round), ['agy[0]']);
      assert.deepEqual(reserveSlotIds(round), ['copilot[0]']);
      assert.deepEqual(delegateSlots(f), ['agy']);
      assert.equal(round.requests.length, 1);
      assert.equal(f.read(2, 'findings.json').confirmations.length, 1);
      const prompt = reads[0]!.prompt;
      for (const expected of [
        "Confirm or dispute the host's evidence-backed rejection of your earlier MUST finding(s) on this unchanged target.",
        '- Spec Path: ' + round.spec.path,
        '- Spec Hash: ' + round.spec.hash,
        '- Target: ' + path.join(f.directory, 'round-2.input.md'),
        '- Target Revision: ' + round.target,
        '- Checkout Path: ' + fs.realpathSync(f.root),
        '- Plan: ' + path.join(f.directory, 'round-2.input.md'),
        '- Scope: ' + round.scope,
        '- Finding: R1-F001',
        '- Target: § Work',
        '- Spec: ' + round.spec.path,
        '- Original finding: Writes are unbounded',
        '- Required change: Keep writes isolated until finalization',
        '- Host rejection: The captured implementation bounds each write',
        '{"status":"CLEAN","findings":[],"confirmations":[{"requestId":"<assigned ID>","decision":"agree|disagree","rationale":"<nonblank evidence-based reason>"}]}',
      ])
        assert.ok(prompt.includes(expected), expected);
      assert.match(prompt, /read-only/i);
      assert.match(prompt, /Do not edit/i);
      assert.match(prompt, /Request ID: `[a-f0-9]{64}`/);
      assert.doesNotMatch(prompt, /### Review against/);
      assert.doesNotMatch(prompt, /Advisory Tool Turn Target/);
    } finally {
      f.cleanup();
    }
  }

  // Code revision-range target renders a base..head revision and the task context.
  {
    const f = await fixture();
    try {
      configure(f, {
        'read-delegates': {
          claude: { targets: [{ low: { model: 'fake' } }] },
          agy: { targets: [{ low: { model: 'fake' } }] },
        },
      });
      const base = 'a'.repeat(40),
        head = 'b'.repeat(40);
      f.deps.run = async (argv) => {
        if (argv[1] === 'rev-parse')
          return { exit: 0, stdout: argv.at(-1) === 'main^{commit}' ? base : head, stderr: '' };
        if (argv[1] === 'diff') return { exit: 0, stdout: 'src/file.ts\0', stderr: '' };
        return { exit: 0, stdout: '', stderr: '' };
      };
      await rejectedMustRound(f, 'main..feature', 'code', 'low');
      const reads = answerConfirmation(f);
      f.launches.length = 0;
      const second = await f.call('code', 'main..feature', 'low');
      assert.equal(second.exit, 0, JSON.stringify(second));
      const round = JSON.parse(
        fs.readFileSync(path.join(f.session, '.state/reviews', second.value.review, 'round-2', 'round.json'), 'utf8'),
      );
      assert.match(round.scope, /^Re-review round 2 \(confirmation-only\) — comparison: b{40}\.\.b{40}$/);
      assert.deepEqual(targetSlotIds(round), ['agy[0]']);
      const prompt = reads[0]!.prompt;
      assert.ok(prompt.includes('- Target Revision: ' + base + '..' + head), prompt);
      assert.match(prompt, /- Plan: .*work\.plan\.md/);
      assert.match(prompt, /- Task: /);
    } finally {
      f.cleanup();
    }
  }

  // Integration and bound-plan task targets render a base..head revision.
  for (const item of [
    {
      target: 'integration',
      base: 'c'.repeat(40),
      head: 'd'.repeat(40),
      seed: async (f: ReviewFixture) => {
        await f.add('integrate', {
          phase: 'opened',
          path: '.state/worktrees/integration',
          branch: 'integration',
          base: 'c'.repeat(40),
          dest: { path: f.root, branch: 'main' },
        });
        await f.add('integrate', { phase: 'done', task: 'T1', commit: 'd'.repeat(40) });
      },
    },
    {
      target: 'T1',
      base: 'e'.repeat(40),
      head: 'f'.repeat(40),
      seed: async (f: ReviewFixture) => {
        await f.add('writer', {
          phase: 'launched',
          task: 'T1',
          path: '.state/worktrees/T1-1',
          base: { commit: 'e'.repeat(40), taskSection: 'sha256:' + '1'.repeat(64), seq: 1 },
        });
        await f.add('writer', { phase: 'finished', task: 'T1', launch: 1, candidate: 'f'.repeat(40) });
      },
    },
  ]) {
    const f = await fixture();
    try {
      configure(f, {
        'read-delegates': {
          claude: { targets: [{ low: { model: 'fake' } }] },
          agy: { targets: [{ low: { model: 'fake' } }] },
        },
      });
      fs.writeFileSync(f.plan, VALID_TASK_PLAN);
      await item.seed(f);
      f.deps.run = async (argv) => ({
        exit: 0,
        stdout: argv[1] === 'diff' ? 'src/file.ts\0' : argv[1] === 'rev-parse' ? item.head : '',
        stderr: '',
      });
      await rejectedMustRound(f, item.target, 'code', 'low');
      const reads = answerConfirmation(f);
      f.launches.length = 0;
      const second = await f.call('code', item.target, 'low');
      assert.equal(second.exit, 0, JSON.stringify(second));
      const round = JSON.parse(
        fs.readFileSync(path.join(f.session, '.state/reviews', second.value.review, 'round-2', 'round.json'), 'utf8'),
      );
      assert.match(round.scope, /^Re-review round 2 \(confirmation-only\)/);
      assert.deepEqual(targetSlotIds(round), ['agy[0]']);
      assert.ok(reads[0]!.prompt.includes('- Target Revision: ' + item.base + '..' + item.head));
    } finally {
      f.cleanup();
    }
  }

  // Accepted MUST or accepted SHOULD keeps the standard prompt and every target.
  {
    const f = await fixture();
    try {
      const accepted = await f.add('ruling', {
        subject: 'review:' + PLAN_REVIEW + ':R1-F001',
        ruling: 'accepted',
        rationale: 'Resolution',
      });
      const rejected = await f.add('ruling', {
        subject: 'review:' + PLAN_REVIEW + ':R1-F002',
        ruling: 'rejected',
        rationale: 'Still broken',
      });
      seedCompletedRound(
        f,
        1,
        [seededFinding('R1-F001', 'MUST'), seededFinding('R1-F002', 'MUST')],
        JSON.stringify([
          ['R1-F001', accepted.seq],
          ['R1-F002', rejected.seq],
        ]),
        rejected.seq,
      );
      const reads = answerConfirmation(f);
      const second = await f.call();
      assert.equal(second.exit, 0, JSON.stringify(second));
      const round = f.read(2, 'round.json');
      assert.match(round.scope, /^Re-review round 2 \(full\)/);
      assert.deepEqual(targetSlotIds(round), ['claude[0]', 'agy[0]']);
      assert.doesNotMatch(round.scope, /confirmation-only/);
      assert.match(reads[0]!.prompt, /### Review against/);
      assert.match(reads[0]!.prompt, /### Pending MUST rejection confirmation/);
    } finally {
      f.cleanup();
    }
  }

  // A later round after a confirmation-only round anchors decisive and targets to the substantive round.
  {
    const f = await fixture();
    try {
      seedCompletedRound(f, 1, [seededFinding('R1-F001', 'SHOULD')]);
      rewriteRound(f, 1, (metadata) => {
        metadata['cap'] = 3;
      });
      const first = f.read(1, 'round.json');
      seedConfirmationRound(f, 2, {
        ...first,
        generation: 1,
        scope: 'Re-review round 2 (confirmation-only) — comparison: ' + first.target + '..' + first.target,
      });
      await f.add('ruling', {
        subject: 'review:' + PLAN_REVIEW + ':R1-F001',
        ruling: 'accepted',
        rationale: 'Resolution',
      });
      planDelegate(f, CLEAN);
      const third = await f.call();
      assert.equal(third.exit, 0, JSON.stringify(third));
      const round = f.read(3, 'round.json');
      assert.match(round.scope, /^Re-review round 3 \(full\)/);
      assert.deepEqual(targetSlotIds(round), ['claude[0]', 'agy[0]']);
    } finally {
      f.cleanup();
    }
  }

  // A granted repository rerun after a confirmation-only round reruns every substantive slot.
  {
    const f = await fixture();
    try {
      seedCompletedRound(f, 1, []);
      rewriteRound(f, 1, (metadata) => {
        metadata['roster'] = [
          { slot: 'claude[0]', provider: 'claude', model: 'fake', index: 0, reserve: false },
          { slot: 'agy[0]', provider: 'agy', model: 'fake', index: 1, reserve: false },
        ];
      });
      const first = f.read(1, 'round.json');
      seedConfirmationRound(f, 2, {
        ...first,
        generation: 1,
        roster: [{ slot: 'agy[0]', provider: 'agy', model: 'fake', index: 0, reserve: false }],
        scope: 'Re-review round 2 (confirmation-only) — comparison: ' + first.target + '..' + first.target,
      });
      const second = f.read(2, 'findings.json');
      fs.writeFileSync(
        path.join(f.directory, 'round-2', 'findings.json'),
        JSON.stringify({ ...second, asOfSeq: 1, repositoryCheck: { state: 'unavailable', reason: 'fixture' } }),
      );
      await appendRecord(
        f.session,
        {
          kind: 'note',
          by: 'user',
          quote: 'Grant one rerun',
          key: 'repository-rerun:' + PLAN_REVIEW + ':2:1',
          data: { text: 'Grant one rerun' },
        },
        f.deps,
      );
      planDelegate(f, CLEAN);
      const third = await f.call();
      assert.equal(third.exit, 0, JSON.stringify(third));
      const round = f.read(3, 'round.json');
      assert.match(round.scope, /^Full review — comparison: sha256:[a-f0-9]{64}$/);
      assert.doesNotMatch(round.scope, /changed paths:/);
      assert.deepEqual(targetSlotIds(round), ['claude[0]', 'agy[0]']);
    } finally {
      f.cleanup();
    }
  }

  // Missing original source slot refuses the round.
  {
    const f = await fixture();
    try {
      seedCompletedRound(f, 1, [{ ...seededFinding('R1-F001', 'MUST'), sources: ['ghost[0]'] }]);
      await f.add('ruling', {
        subject: 'review:' + PLAN_REVIEW + ':R1-F001',
        ruling: 'rejected',
        rationale: 'Still broken',
      });
      planDelegate(f, CLEAN);
      const result = await f.call();
      assert.equal(result.exit, 4);
      assert.equal(result.output.reason, 'review-confirmation-required');
      assert.match(result.output.summary, /Missing original reviewer slot ghost\[0\]/);
    } finally {
      f.cleanup();
    }
  }

  // Every confirmation slot failing keeps review-failed.
  {
    const f = await fixture();
    try {
      await rejectedMustRound(f, f.plan, 'plan');
      f.deps.delegate = async () => ({
        outcome: { status: 'fail', cls: 'auth', detail: 'No credentials' },
        invocations: [],
      });
      const failed = await f.call();
      assert.equal(failed.exit, 2);
      assert.equal(failed.output.reason, 'review-failed');
      assert.match(f.read(2, 'round.json').scope, /\(confirmation-only\)/);
    } finally {
      f.cleanup();
    }
  }

  // A failed source slot falls back to a reserve and confirms the rejection.
  {
    const f = await fixture();
    try {
      configureAssignable(f);
      await rejectedMustRound(f, f.plan, 'plan');
      const reads: { provider: string; prompt: string }[] = [];
      f.deps.delegate = async (provider, request, mode) => {
        f.launches.push({ provider, request, mode });
        if (provider === 'agy')
          return { outcome: { status: 'fail', cls: 'auth', detail: 'No credentials' }, invocations: [] };
        const prompt = fs.readFileSync(request.promptPath, 'utf8');
        reads.push({ provider, prompt });
        const ids = [...prompt.matchAll(/Request ID: `([^`]+)`/g)].map((match) => match[1]!);
        return {
          outcome: {
            status: 'ok',
            text: JSON.stringify({
              status: 'CLEAN',
              findings: [],
              confirmations: ids.map((requestId) => ({
                requestId,
                decision: 'agree',
                rationale: 'The reserve checked the captured bound',
              })),
            }),
            resume: null,
            sessionId: null,
          },
          invocations: [],
        };
      };
      f.launches.length = 0;
      const second = await f.call();
      assert.equal(second.exit, 0, JSON.stringify(second));
      const round = f.read(2, 'round.json');
      assert.deepEqual(targetSlotIds(round), ['agy[0]']);
      assert.deepEqual(reserveSlotIds(round), ['copilot[0]']);
      assert.deepEqual(delegateSlots(f), ['agy', 'copilot']);
      assert.match(reads[0]!.prompt, /\(confirmation-only\)/);
      const [confirmation] = f.read(2, 'findings.json').confirmations;
      assert.equal(confirmation.sourceSlot, 'agy[0]');
      assert.equal(confirmation.responder.slot, 'copilot[0]');
      assert.equal((await f.call()).output.reason, 'round-cap');
    } finally {
      f.cleanup();
    }
  }
});

test('non-code rerun scope names changed headings only with a prior snapshot', async () => {
  // Prior snapshot present: the rerun scope names the changed headings.
  {
    const f = await fixture();
    try {
      seedCompletedRound(f, 1, []);
      rewriteRound(f, 1, (metadata) => {
        metadata['roster'] = [
          { slot: 'claude[0]', provider: 'claude', model: 'fake', index: 0, reserve: false },
          { slot: 'agy[0]', provider: 'agy', model: 'fake', index: 1, reserve: false },
        ];
      });
      const first = f.read(1, 'round.json');
      seedConfirmationRound(f, 2, {
        ...first,
        generation: 1,
        scope: 'Re-review round 2 (confirmation-only) — comparison: ' + first.target + '..' + first.target,
      });
      const second = f.read(2, 'findings.json');
      fs.writeFileSync(
        path.join(f.directory, 'round-2', 'findings.json'),
        JSON.stringify({ ...second, asOfSeq: 1, repositoryCheck: { state: 'unavailable', reason: 'fixture' } }),
      );
      await appendRecord(
        f.session,
        {
          kind: 'note',
          by: 'user',
          quote: 'Grant one rerun',
          key: 'repository-rerun:' + PLAN_REVIEW + ':2:1',
          data: { text: 'Grant one rerun' },
        },
        f.deps,
      );
      fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
      planDelegate(f, CLEAN);
      const third = await f.call();
      assert.equal(third.exit, 0, JSON.stringify(third));
      assert.match(f.read(3, 'round.json').scope, /^Full review — changed: Fix; comparison: sha256:[a-f0-9]{64}$/);
    } finally {
      f.cleanup();
    }
  }

  // Prior snapshot removed: the rerun scope omits the changed segment.
  {
    const f = await fixture();
    try {
      seedCompletedRound(f, 1, []);
      rewriteRound(f, 1, (metadata) => {
        metadata['roster'] = [
          { slot: 'claude[0]', provider: 'claude', model: 'fake', index: 0, reserve: false },
          { slot: 'agy[0]', provider: 'agy', model: 'fake', index: 1, reserve: false },
        ];
      });
      const first = f.read(1, 'round.json');
      seedConfirmationRound(f, 2, {
        ...first,
        generation: 1,
        scope: 'Re-review round 2 (confirmation-only) — comparison: ' + first.target + '..' + first.target,
      });
      const second = f.read(2, 'findings.json');
      fs.writeFileSync(
        path.join(f.directory, 'round-2', 'findings.json'),
        JSON.stringify({ ...second, asOfSeq: 1, repositoryCheck: { state: 'unavailable', reason: 'fixture' } }),
      );
      fs.rmSync(path.join(f.directory, 'round-2', 'target.snapshot.md'));
      await appendRecord(
        f.session,
        {
          kind: 'note',
          by: 'user',
          quote: 'Grant one rerun',
          key: 'repository-rerun:' + PLAN_REVIEW + ':2:1',
          data: { text: 'Grant one rerun' },
        },
        f.deps,
      );
      planDelegate(f, CLEAN);
      const third = await f.call();
      assert.equal(third.exit, 0, JSON.stringify(third));
      assert.match(f.read(3, 'round.json').scope, /^Full review — comparison: sha256:[a-f0-9]{64}$/);
    } finally {
      f.cleanup();
    }
  }
});

test('non-code re-review omits the changed segment without changed headings', async () => {
  for (const [name, edit, expected] of [
    [
      'names changed headings',
      true,
      /^Re-review round 2 \((full|narrowed)\) — changed: Fix; comparison: sha256:[a-f0-9]{64}\.\.sha256:[a-f0-9]{64}$/,
    ],
    [
      'omits the changed segment',
      false,
      /^Re-review round 2 \((full|narrowed)\) — comparison: sha256:[a-f0-9]{64}\.\.sha256:[a-f0-9]{64}$/,
    ],
  ] as const) {
    const f = await fixture();
    try {
      seedCompletedRound(f, 1, []);
      planDelegate(f, CLEAN);
      if (edit) fs.appendFileSync(f.plan, '\n## Fix\nChanged.\n');
      const second = await f.call();
      assert.equal(second.exit, 0, name + ': ' + JSON.stringify(second));
      const scope = f.read(2, 'round.json').scope as string;
      assert.match(scope, expected, name);
      if (!edit) assert.doesNotMatch(scope, /changed:/, name);
    } finally {
      f.cleanup();
    }
  }
});

test('review run honors pins for all and provider selection and rejects invalid pins', async () => {
  const runPinned = async (f: Awaited<ReturnType<typeof fixture>>, pins: string) => {
    f.lines.length = 0;
    const exit = await main(
      [
        'review',
        'run',
        f.plan,
        '--kind',
        'plan',
        '--level',
        'medium',
        '--session',
        f.session,
        '--host',
        'opencode',
        '--pins',
        pins,
      ],
      f.deps,
    );
    return { exit, output: f.output() };
  };
  {
    const f = await fixture();
    try {
      fs.writeFileSync(
        path.join(f.deps.skillRoot, 'config.jsonc'),
        JSON.stringify({
          'read-delegates': {
            claude: { targets: [{ medium: { model: 'fake' } }] },
            agy: { targets: [{ medium: { model: 'fake' } }] },
          },
          phases: {
            'plan-review': { targets: { medium: 1 }, rounds: { medium: 2 } },
            'code-review': { targets: { low: 2 }, rounds: { low: 2 } },
          },
        }),
      );
      f.deps.delegate = async () => reply(CLEAN);
      const all = await runPinned(f, '(all)');
      assert.equal(all.exit, 0, JSON.stringify(all));
      assert.deepEqual(
        f.read(1, 'round.json').roster.map((r: { provider: string }) => r.provider),
        ['claude', 'agy'],
      );
    } finally {
      f.cleanup();
    }
  }
  {
    const f = await fixture();
    try {
      f.deps.delegate = async () => reply(CLEAN);
      const single = await runPinned(f, '(agy)');
      assert.equal(single.exit, 0, JSON.stringify(single));
      assert.deepEqual(
        f.read(1, 'round.json').roster.map((r: { provider: string }) => r.provider),
        ['agy'],
      );
      for (const bad of ['(0)', '(unknown)']) {
        const err = await runPinned(f, bad);
        assert.equal(err.exit, 1, bad);
        assert.equal(err.output.reason, 'invalid-input', bad);
      }
    } finally {
      f.cleanup();
    }
  }
});

test('explicit pins override prior-round narrowing on a non-decisive follow-up round', async () => {
  const f = await fixture();
  try {
    f.deps.delegate = async () => reply(report('§ Work', 'Minor note', 'SHOULD'));
    const first = await f.call();
    assert.equal(first.exit, 0, JSON.stringify(first));
    assert.deepEqual(
      f.read(1, 'round.json').roster.map((r: { provider: string }) => r.provider),
      ['claude', 'agy'],
    );
    f.launches.length = 0;
    fs.appendFileSync(f.plan, '\n## Update\nRevised.\n');
    f.deps.delegate = async (provider, request, mode) => {
      f.launches.push({ provider, request, mode });
      return reply(CLEAN);
    };
    f.lines.length = 0;
    const secondExit = await main(
      [
        'review',
        'run',
        f.plan,
        '--kind',
        'plan',
        '--level',
        'medium',
        '--session',
        f.session,
        '--host',
        'opencode',
        '--pins',
        '(agy)',
      ],
      f.deps,
    );
    assert.equal(secondExit, 0, JSON.stringify(f.output()));
    assert.deepEqual(
      f.read(2, 'round.json').roster.map((r: { provider: string }) => r.provider),
      ['agy'],
    );
    assert.deepEqual(
      f.launches.map((l) => l.provider),
      ['agy'],
    );
    assert.match(f.read(2, 'round.json').scope as string, /^Re-review round 2 \(full\)/);
  } finally {
    f.cleanup();
  }
});

test('explicit pins override saved roster on an admitted repository rerun', async () => {
  const f = await fixture();
  try {
    seedCompletedRound(f, 1, []);
    rewriteRound(f, 1, (metadata) => {
      metadata['roster'] = [
        { slot: 'claude[0]', provider: 'claude', model: 'fake', index: 0, reserve: false },
        { slot: 'agy[0]', provider: 'agy', model: 'fake', index: 1, reserve: false },
      ];
    });
    const first = f.read(1, 'round.json');
    seedConfirmationRound(f, 2, {
      ...first,
      generation: 1,
      scope: 'Re-review round 2 (confirmation-only) — comparison: ' + first.target + '..' + first.target,
    });
    const second = f.read(2, 'findings.json');
    fs.writeFileSync(
      path.join(f.directory, 'round-2', 'findings.json'),
      JSON.stringify({ ...second, asOfSeq: 1, repositoryCheck: { state: 'unavailable', reason: 'fixture' } }),
    );
    await appendRecord(
      f.session,
      {
        kind: 'note',
        by: 'user',
        quote: 'Grant one rerun',
        key: 'repository-rerun:' + PLAN_REVIEW + ':2:1',
        data: { text: 'Grant one rerun' },
      },
      f.deps,
    );
    f.launches.length = 0;
    f.deps.delegate = async (provider, request, mode) => {
      f.launches.push({ provider, request, mode });
      return reply(CLEAN);
    };
    f.lines.length = 0;
    const thirdExit = await main(
      [
        'review',
        'run',
        f.plan,
        '--kind',
        'plan',
        '--level',
        'medium',
        '--session',
        f.session,
        '--host',
        'opencode',
        '--pins',
        '(agy)',
      ],
      f.deps,
    );
    assert.equal(thirdExit, 0, JSON.stringify(f.output()));
    assert.deepEqual(
      f.read(3, 'round.json').roster.map((r: { provider: string }) => r.provider),
      ['agy'],
    );
    assert.deepEqual(
      f.launches.map((l) => l.provider),
      ['agy'],
    );
  } finally {
    f.cleanup();
  }
});

test('review run refuses with host-sandboxed under sandboxed claude host', async () => {
  // Sandboxed host refuses before creating review state and proceeds when unsandboxed.
  {
    const f = await fixture();
    try {
      f.deps.orchestrator = { platform: 'claude', model: null } as typeof f.deps.orchestrator;
      f.deps.env = { ...f.deps.env, SANDBOX_RUNTIME: 'seatbelt' };
      const refused = await f.call();
      assert.equal(refused.exit, 4);
      assert.equal(refused.output.reason, 'host-sandboxed');
      assert.match(refused.output.summary, /dangerouslyDisableSandbox/);
      assert.match(refused.output.summary, /sandbox\.excludedCommands/);
      assert.doesNotMatch(refused.output.summary, /sandbox:\s*false/i);
      assert.equal(fs.existsSync(path.join(f.session, '.state', 'reviews')), false);
      assert.equal(f.launches.length, 0);

      const env = { ...f.deps.env };
      delete env['SANDBOX_RUNTIME'];
      delete env['SANDBOX'];
      f.deps.env = env;
      const rerun = await f.call();
      assert.equal(rerun.exit, 4);
      assert.equal(rerun.output.reason, 'native-pending');
      assert.equal(fs.existsSync(path.join(f.session, '.state', 'reviews')), true);
    } finally {
      f.cleanup();
    }
  }

  // A native-first-only roster still refuses once --native-failed marks the slot failed.
  {
    const f = await fixture();
    try {
      configure(f, { 'read-delegates': { claude: { targets: [{ low: { model: 'fake' } }] } } });
      f.deps.orchestrator = { platform: 'claude', model: null } as typeof f.deps.orchestrator;
      f.deps.env = { ...f.deps.env, SANDBOX_RUNTIME: 'seatbelt' };
      const nativeOnly = await f.call();
      assert.equal(nativeOnly.exit, 4);
      assert.equal(nativeOnly.output.reason, 'native-pending');
      assert.equal(fs.existsSync(path.join(f.session, '.state', 'reviews')), true);

      fs.rmSync(path.join(f.session, '.state', 'reviews'), { recursive: true, force: true });
      f.lines.length = 0;
      const refusedExit = await main(
        [
          'review',
          'run',
          f.plan,
          '--kind',
          'plan',
          '--level',
          'low',
          '--session',
          f.session,
          '--host',
          'claude',
          '--native-failed',
          'claude[0]=failed',
        ],
        f.deps,
      );
      assert.equal(refusedExit, 4);
      assert.equal(f.output().reason, 'host-sandboxed');
      assert.equal(fs.existsSync(path.join(f.session, '.state', 'reviews')), false);
    } finally {
      f.cleanup();
    }
  }
});

const WRONG_REVIEW_TARGET = 'implement code review targets integration, not worktree';
const NO_VERIFICATION = 'no current runtime verification recorded before integration review';
const NO_TEST_CLEANUP = 'no test cleanup recorded before integration review';
const INTEGRATION_BASE = 'c'.repeat(40);
const INTEGRATION_HEAD = 'd'.repeat(40);
const CLEANUP_HEAD = 'e'.repeat(40);
const integrationPath = '.state/worktrees/integration';

async function openReviewIntegration(f: ReviewFixture) {
  fs.mkdirSync(path.join(f.session, integrationPath), { recursive: true });
  await f.add('integrate', {
    phase: 'opened',
    path: integrationPath,
    branch: 'integration',
    base: INTEGRATION_BASE,
    dest: { path: f.root, branch: 'main' },
  });
  await f.add('integrate', { phase: 'done', task: 'T1', commit: INTEGRATION_HEAD });
}

function recordReviewVerification(f: ReviewFixture, open: string[] = []) {
  return f.add('integrate', {
    phase: 'verification',
    cycle: 1,
    outcome: open.length ? 'partial' : 'proved',
    head: INTEGRATION_HEAD,
    reason: 'Runtime checks',
    open,
    report: 'verification.md',
  });
}

function recordCleanupSkip(f: ReviewFixture) {
  return addRecord(f, {
    kind: 'note',
    by: 'orchestrator',
    key: 'test-cleanup:skip',
    data: { text: 'Reviewed src/file.ts' },
  });
}

function writeCleanupReport(f: ReviewFixture, deleted: number, prefix = '') {
  fs.writeFileSync(
    path.join(f.session, '.state/test-cleanup.json'),
    prefix + JSON.stringify({ removed: [], deleted, merged: 0 }),
  );
}

function assertReviewWarning(
  f: ReviewFixture,
  result: Awaited<ReturnType<ReviewFixture['call']>>,
  warning: string | undefined,
) {
  assert.equal(result.exit, 0, JSON.stringify(result));
  assert.ok(fs.existsSync(path.join(f.session, result.value.findingsFile)), 'round persisted findings.json');
  assert.equal(result.value.warning, warning);
  const prefix = warning === undefined ? 'review ' : 'warning: ' + warning + '; review ';
  assert.ok(result.output.summary.startsWith(prefix), result.output.summary);
  assert.ok(Buffer.byteLength(result.output.summary, 'utf8') <= 1024);
}

const integrationWarningCases: {
  name: string;
  prepare?: (f: ReviewFixture) => unknown;
  arrange?: (f: ReviewFixture) => unknown;
  warning?: string;
  dirty?: boolean;
  cleanupCommit?: boolean;
}[] = [
  { name: 'missing verification and cleanup', warning: NO_VERIFICATION + '; ' + NO_TEST_CLEANUP },
  {
    name: 'verification from before integration opened',
    prepare: recordReviewVerification,
    arrange: recordCleanupSkip,
    warning: NO_VERIFICATION,
  },
  {
    name: 'verification still has open items',
    arrange: async (f) => {
      await recordReviewVerification(f);
      await recordReviewVerification(f, ['1:V1']);
      await recordCleanupSkip(f);
    },
    warning: NO_VERIFICATION,
  },
  {
    name: 'verification overturned by an accepted ruling',
    arrange: async (f) => {
      await recordReviewVerification(f);
      await f.add('ruling', { subject: 'verification:1:V1', ruling: 'accepted', rationale: 'Needs repair' });
      await recordCleanupSkip(f);
    },
    warning: NO_VERIFICATION,
  },
  {
    name: 'cleanup brief with no report',
    arrange: async (f) => {
      await recordReviewVerification(f);
      fs.mkdirSync(path.join(f.session, '.state/briefs'), { recursive: true });
      fs.writeFileSync(path.join(f.session, '.state/briefs/test-cleanup-1.md'), 'Cleanup requested');
    },
    warning: NO_TEST_CLEANUP,
  },
  {
    name: 'nonzero cleanup report without a record',
    arrange: async (f) => {
      await recordReviewVerification(f);
      writeCleanupReport(f, 1);
    },
    warning: NO_TEST_CLEANUP,
  },
  {
    name: 'zero-count cleanup report with an uncommitted rewrite',
    arrange: async (f) => {
      await recordReviewVerification(f);
      writeCleanupReport(f, 0);
    },
    warning: NO_TEST_CLEANUP,
    dirty: true,
  },
  {
    name: 'zero-count cleanup report on a clean worktree',
    arrange: async (f) => {
      await recordReviewVerification(f);
      writeCleanupReport(f, 0, '\uFEFF');
    },
  },
  {
    name: 'verification followed by recorded cleanup commit',
    arrange: async (f) => {
      await recordReviewVerification(f);
      writeCleanupReport(f, 1);
      await f.add('integrate', {
        phase: 'test-cleanup',
        from: INTEGRATION_HEAD,
        fromTree: INTEGRATION_HEAD,
        to: CLEANUP_HEAD,
        removed: [],
        deleted: 1,
        merged: 0,
        trees: {},
      });
    },
    cleanupCommit: true,
  },
  {
    name: 'verification and cleanup skip',
    arrange: async (f) => {
      await f.add('ruling', { subject: 'verification:1:V1', ruling: 'accepted', rationale: 'Needs repair' });
      await recordReviewVerification(f);
      await recordCleanupSkip(f);
    },
  },
];

const reviewWarningCases: {
  name: string;
  target: 'worktree' | 'integration';
  integrate?: boolean;
  prepare?: (f: ReviewFixture) => unknown;
  arrange?: (f: ReviewFixture) => unknown;
  warning?: string;
  dirty?: boolean;
  cleanupCommit?: boolean;
  rerun?: boolean;
}[] = [
  { name: 'worktree after task integration', target: 'worktree', integrate: true, warning: WRONG_REVIEW_TARGET },
  { name: 'standalone worktree has none', target: 'worktree' },
  ...integrationWarningCases.map((item) => ({ ...item, target: 'integration' as const })),
  {
    name: 're-review reports missing verification ahead of long repository-change paths',
    target: 'integration',
    warning: NO_VERIFICATION,
    rerun: true,
  },
];

for (const item of reviewWarningCases) {
  test('review warning: ' + item.name, async () => {
    const f = await fixture();
    try {
      if (item.target === 'worktree') {
        worktreeRun(f);
        if (item.integrate) await openReviewIntegration(f);
        const result = await f.call('code', 'worktree', 'low');
        assertReviewWarning(f, result, item.warning);
      } else if (item.rerun) {
        fs.writeFileSync(f.plan, VALID_TASK_PLAN);
        await openReviewIntegration(f);
        await recordReviewVerification(f);
        await recordCleanupSkip(f);
        let head = INTEGRATION_HEAD;
        f.deps.run = async (argv) => ({
          exit: 0,
          stderr: '',
          stdout: argv[1] === 'rev-parse' ? head : argv[1] === 'diff' ? 'src/file.ts\0' : '',
        });
        const first = await f.call('code', 'integration', 'low');
        assert.equal(first.exit, 0, JSON.stringify(first));
        const findings = JSON.parse(fs.readFileSync(first.value.path, 'utf8')).findings;
        for (const finding of findings) {
          await f.add('ruling', {
            subject: 'review:code-integration:' + finding.id,
            ruling: 'accepted',
            rationale: 'Fixed',
          });
        }
        await recordReviewVerification(f, ['1:V1']);
        head = CLEANUP_HEAD;
        const fanout = path.join(f.session, '.state/reviews/code-integration/round-2/gen-1');
        fs.mkdirSync(fanout, { recursive: true });
        const removedPaths = Object.fromEntries(
          Array.from({ length: 12 }, (_, i) => ['src/' + 'a'.repeat(115) + i + '.ts', '? removed - old-hash']),
        );
        fs.writeFileSync(
          path.join(fanout, 'checkout-baseline.json'),
          JSON.stringify({ checkouts: [{ cwd: path.join(f.session, integrationPath), head, entries: removedPaths }] }),
        );
        planDelegate(f, CLEAN);
        const second = await f.call('code', 'integration', 'low');
        assertReviewWarning(f, second, item.warning);
        assert.equal(second.value.round, 2);
        assert.match(second.output.summary, /repository changes: .*…$/);
      } else {
        fs.writeFileSync(f.plan, VALID_TASK_PLAN);
        await item.prepare?.(f);
        await openReviewIntegration(f);
        await item.arrange?.(f);
        f.deps.run = async (argv) => ({
          exit: 0,
          stderr: '',
          stdout:
            argv[1] === 'rev-parse'
              ? item.cleanupCommit
                ? CLEANUP_HEAD
                : INTEGRATION_HEAD
              : argv[1] === 'diff'
                ? 'src/file.ts\0'
                : argv.includes('status') && item.dirty
                  ? ' M src/file.ts\0'
                  : '',
        });
        const result = await f.call('code', 'integration', 'low');
        assertReviewWarning(f, result, item.warning);
      }
    } finally {
      f.cleanup();
    }
  });
}

test('reviewRun refuses broken-citation on new and superseded rounds but not native-pending resume', async () => {
  // 1. New round start refuses broken citation in plan and design without creating round.json or launching reviewers.
  const f1 = await fixture();
  try {
    fs.writeFileSync(f1.plan, '# Work\n## Work\nSee `src/missing.ts:1`.\n');
    const refusedPlan = await f1.call('plan', f1.plan);
    assert.equal(refusedPlan.exit, 4);
    assert.equal(refusedPlan.output.reason, 'lint-errors');
    assert.match(refusedPlan.output.summary, /broken-citation/);
    assert.equal(f1.launches.length, 0);
    assert.equal(fs.existsSync(path.join(f1.directory, 'round-1', 'round.json')), false);

    const design = f1.artifact('strategy.design.md', '# Strategy\n## Approach\nSee `src/missing.ts:1`.\n');
    const refusedDesign = await f1.call('design', design);
    assert.equal(refusedDesign.exit, 4);
    assert.equal(refusedDesign.output.reason, 'lint-errors');
    assert.match(refusedDesign.output.summary, /broken-citation/);
    assert.equal(f1.launches.length, 0);
  } finally {
    f1.cleanup();
  }

  // 2. Target acquiring broken citation after pending.json (supersede) refuses before deleting pending.json or mutating round state.
  const f2 = await fixture();
  try {
    fs.mkdirSync(path.join(f2.root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(f2.root, 'src', 'real.ts'), 'export const x = 1;\n');
    fs.writeFileSync(f2.plan, '# Work\n## Work\nSee `src/real.ts:1`.\n');
    f2.deps.hook = async (point) => {
      if (point === 'review:after-pending') {
        fs.writeFileSync(f2.plan, '# Work\n## Work\nSee `src/missing.ts:1`.\n');
      }
    };
    const duringFinalize = await f2.call('plan', f2.plan);
    assert.equal(duringFinalize.exit, 4);
    assert.equal(duringFinalize.output.reason, 'lint-errors');
    assert.match(duringFinalize.output.summary, /broken-citation/);
    const pendingPath = path.join(f2.directory, 'round-1', 'pending.json');
    assert.equal(fs.existsSync(pendingPath), true);
    assert.equal(f2.read(1, 'round.json').generation, 1);

    // Retry while pending.json exists and target still has broken citation also refuses before deleting pending.json.
    delete f2.deps.hook;
    const retry = await f2.call('plan', f2.plan);
    assert.equal(retry.exit, 4);
    assert.equal(retry.output.reason, 'lint-errors');
    assert.equal(fs.existsSync(pendingPath), true);
    assert.equal(f2.read(1, 'round.json').generation, 1);
  } finally {
    f2.cleanup();
  }

  // 3. Target acquiring broken citation during fan-out (before pending.json) refuses in supersede() before incrementing generation.
  const f3 = await fixture();
  try {
    fs.mkdirSync(path.join(f3.root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(f3.root, 'src', 'real.ts'), 'export const x = 1;\n');
    fs.writeFileSync(f3.plan, '# Work\n## Work\nSee `src/real.ts:1`.\n');
    f3.deps.delegate = async (provider, request, mode) => {
      f3.launches.push({ provider, request, mode });
      fs.writeFileSync(f3.plan, '# Work\n## Work\nSee `src/missing.ts:1`.\n');
      return { outcome: { status: 'ok', text: CLEAN, resume: null, sessionId: null }, invocations: [] };
    };
    const duringFanout = await f3.call('plan', f3.plan);
    assert.equal(duringFanout.exit, 4);
    assert.equal(duringFanout.output.reason, 'lint-errors');
    assert.match(duringFanout.output.summary, /broken-citation/);
    assert.equal(f3.read(1, 'round.json').generation, 1);
  } finally {
    f3.cleanup();
  }

  // 4. Native-pending resume on an unchanged round is unaffected even if cited file disappears externally.
  const f4 = await fixture();
  try {
    fs.mkdirSync(path.join(f4.root, 'src'), { recursive: true });
    const realFile = path.join(f4.root, 'src', 'real.ts');
    fs.writeFileSync(realFile, 'export const x = 1;\n');
    fs.writeFileSync(f4.plan, '# Work\n## Work\nSee `src/real.ts:1`.\n');
    f4.deps.orchestrator = { platform: 'claude', model: null } as typeof f4.deps.orchestrator;
    const pending = await f4.call('plan', f4.plan);
    assert.equal(pending.exit, 4);
    assert.equal(pending.output.reason, 'native-pending');

    fs.rmSync(realFile);
    for (const slot of pending.value.pending) fs.writeFileSync(slot.replyPath, CLEAN);
    const cliWave = await f4.call('plan', f4.plan);
    assert.equal(cliWave.exit, 4);
    assert.equal(cliWave.output.reason, 'native-pending');
    const resumed = await f4.call('plan', f4.plan);
    assert.equal(resumed.exit, 0, JSON.stringify(resumed.output));
  } finally {
    f4.cleanup();
  }
});
