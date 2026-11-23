import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { observeTool, optionalDiagnostics, readReviews, sessionFacts, writeDiagnostics } from '../../../skills/dispatch/scripts/toolkit/diagnostics.ts';
import { heuristics, normalizeUsage, renderDiagnostics } from '../../../skills/dispatch/scripts/toolkit/domain/diagnostics.ts';
import { resolvePricing } from '../../../skills/dispatch/scripts/lib/pricing.ts';
import { fanOut } from '../../../skills/dispatch/scripts/toolkit/fanout.ts';
import { claude } from '../../../skills/dispatch/scripts/providers/claude.ts';
import { agy } from '../../../skills/dispatch/scripts/providers/agy.ts';
import type { Fold } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { ToolError } from '../../../skills/dispatch/scripts/toolkit/output.ts';
import { sessionFixture } from './helpers/session.ts';
import { fakeGit, type FakeGitState } from './helpers/fake-git.ts';
import { readManifest } from '../../../skills/dispatch/scripts/lib/session.ts';
import { checks, loadPlan } from '../../../skills/dispatch/scripts/toolkit/plan-view.ts';
import { stableValue } from '../../../skills/dispatch/scripts/toolkit/domain/stable-value.ts';

const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value) + '\n');
};






const rosterSlot = (slot: string, provider: string, options: {native?: boolean; reserve?: boolean; model?: string} = {}) => ({
  slot, provider, index: 0, native: options.native ?? false, reserve: options.reserve ?? false, model: options.model ?? 'model-a',
});

const finding = (id: string, marker: {recurrence?: {of: string}; unresolved?: {of: string}; severity?: string; sources?: string[]} = {}) => ({
  id, severity: marker.severity ?? 'SHOULD', category: 'correctness', locus: 'scripts/dispatch.ts:L1',
  defect: `Finding ${id} describes a repeat`, requiredChange: `Resolve ${id}`,
  sources: marker.sources ?? ['claude[0]'], scope: 'in',
  ...(marker.recurrence ? {recurrence: marker.recurrence} : {}), ...(marker.unresolved ? {unresolved: marker.unresolved} : {}),
});

const slotFile = (reviewDir: string, round: number, slot: string, generation = 1) =>
  path.join(reviewDir, `round-${round}`, `gen-${generation}`, 'slots', `${slot}.json`);

const roundSubject = (session: string, review: string, round: number, generation = 1) =>
  crypto.createHash('sha256').update(path.join(session, '.state', 'reviews', review, `round-${round}`, `gen-${generation}`))
    .digest('hex').slice(0, 16);

const captureRuns = (session: string, invocations: unknown[]) =>
  writeJson(path.join(session, '.state', 'diagnostics', 'run-1.json'), {
    capture: {state: 'completed', start: 0, end: 1}, phases: [], invocations, reviews: [],
  });

const attempt = (subject: string, input: {
  slot: string; provider: string; model: string; attempt?: number; targetSlot?: string;
  outcome?: string; launched?: boolean; tokens?: number;
}) => ({
  phase: 'plan-review', subject, attempt: input.attempt ?? 1, provider: input.provider, model: input.model,
  mode: 'cli', surface: 'cli', launched: input.launched ?? true, outcome: input.outcome ?? 'ok', slot: input.slot,
  ...(input.targetSlot ? {targetSlot: input.targetSlot} : {}),
  ...(input.tokens === undefined ? {} : {usage: {input: input.tokens, output: 0}}),
});

const ruling = (seq: number, review: string, id: string, value: string) =>
  ({seq, key: `ruling-${seq}`, at: `2026-01-01T00:00:0${seq}Z`, kind: 'ruling', by: 'tool', data: {subject: `review:${review}:${id}`, ruling: value, rationale: 'Recorded.'}});

function saveRound(input: {
  session: string; review: string; round: number;
  roster: ReturnType<typeof rosterSlot>[];
  outcomes: unknown[];
  findings?: unknown[];
  generation?: number;
}) {
  const generation = input.generation ?? 1;
  const reviewDir = path.join(input.session, '.state', 'reviews', input.review);
  const roundDir = path.join(reviewDir, `round-${input.round}`);
  writeJson(path.join(roundDir, 'round.json'), {
    round: input.round, generation, cap: 4, level: 'high', roster: input.roster,
    scope: 'Full review', startSeq: 0,
    spec: {path: 'spec.md', hash: 'sha256:' + 'a'.repeat(64)},
    target: {base: 'a'.repeat(40), head: 'b'.repeat(40)},
  });
  input.outcomes.forEach((outcome) => {
    const slot = (outcome as {slot: string}).slot;
    writeJson(slotFile(reviewDir, input.round, slot, generation), outcome);
  });
  if (input.findings) {
    writeJson(path.join(roundDir, 'findings.json'), {
      review: input.review, round: input.round, cap: 4, level: 'high',
      findings: input.findings, clusters: [],
      failed: input.outcomes.filter((outcome) => (outcome as {state: string}).state === 'failed'),
    });
  }
}





















const hostTest_HEAD = 'a'.repeat(40);
const hostTest_TREE = 'b'.repeat(40);

function hostTest_planSource(): string {
  return [
    '# Report fixture', '',
    '## Task Map',
    '| ID | Title | Outcome | Prerequisites | Criteria |',
    '| --- | --- | --- | --- | --- |',
    '| T1 | Task 1 | Works | none | SC1 |',
    '', '## Proposed Changes', '',
    '### T1 — Task 1',
    '#### [NEW] src/task-1.ts',
    '- Purpose: implements the fixture behavior.', '',
    '## Success Criteria',
    '- [SC1] Criterion works',
    '  - Changes: src/task-1.ts',
    '  - Check: `node verify-1.js`',
    '  - Evidence: check',
    '', '## Verification Plan', '### Automated Tests',
    '- `node verify-1.js`', '- `node contract-check.js`', '',
  ].join('\n');
}

let hostTest_eventNumber = 0;

async function hostTest_fixture() {
  const f = sessionFixture({memory:true});
  const skillRoot = path.join(f.root, 'isolated-skill');
  fs.mkdirSync(skillRoot);
  fs.writeFileSync(path.join(skillRoot, 'config.local.jsonc'), '{"diagnostics": false}\n');
  f.deps.skillRoot = skillRoot;
  f.artifact('brief.spec.md', '# Brief\n');
  f.artifact('report.plan.md', hostTest_planSource());
  await hostTest_append(f, {
    kind: 'bind', by: 'tool', key: `bind:${++hostTest_eventNumber}`,
    data: { spec: 'brief.spec.md', plan: 'report.plan.md' },
  });
  return { ...f, skillRoot };
}

async function hostTest_invoke(f: ReturnType<typeof sessionFixture>, tool: string, action: string, ...args: string[]) {
  f.lines.splice(0);
  const exit = await main([tool, action, ...args, '--session', f.session], f.deps);
  assert.equal(f.lines.length, 1);
  return { exit, output: JSON.parse(f.lines[0]!) as { ok: boolean; reason?: string; summary: string; path: string | null } };
}

async function hostTest_append(f: ReturnType<typeof sessionFixture>, record: Record<string, unknown>) {
  const file = f.artifact(`event-${++hostTest_eventNumber}.json`, JSON.stringify(record));
  const result = await hostTest_invoke(f, 'ledger', 'append', file);
  assert.equal(result.exit, 0, result.output.summary);
  return result.output;
}

async function hostTest_integrate(f: ReturnType<typeof sessionFixture>, state: FakeGitState, dest = { path: f.root, branch: 'main' }) {
  const worktree = path.join(f.session, '.state', 'worktrees', 'integration');
  fs.mkdirSync(worktree, { recursive: true });
  state.session = f.session;
  f.deps.run = fakeGit(state);
  await hostTest_append(f, {
    kind: 'integrate', by: 'tool', key: `integrate:opened:${++hostTest_eventNumber}`,
    data: { phase: 'opened', path: '.state/worktrees/integration', branch: 'dispatch/test/integration', base: 'f'.repeat(40), dest },
  });
  return worktree;
}

async function hostTest_evidence(f: ReturnType<typeof sessionFixture>, criterion: string, commandDigest: string, tree: string) {
  const data = { criterion, commandDigest, tree, clean: true, before: tree, after: tree, exit: 0 };
  const digest = crypto.createHash('sha256').update(stableValue(data)).digest('hex');
  const evidencePath = `.state/evidence/${digest}.json`;
  const evidenceFile = path.join(f.session, evidencePath);
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, JSON.stringify(data));
  await hostTest_append(f, {
    kind: 'evidence', by: 'tool', key: `evidence:${digest}`,
    data: { ...data, path: evidencePath },
  });
  return evidencePath;
}

async function hostTest_evidenceForPlan(f: ReturnType<typeof sessionFixture>, tree: string, criteria?: string[]) {
  const plan = loadPlan(f.session, readManifest(f.session));
  const rows = checks(plan).filter((check) => !criteria || criteria.includes(check.criterion));
  const paths = new Map<string, string>();
  for (const row of rows) paths.set(row.criterion, await hostTest_evidence(f, row.criterion, row.commandDigest, tree));
  return paths;
}

function hostTest_gitState(session: string, head = hostTest_HEAD, tree = hostTest_TREE, testedTree = tree): FakeGitState {
  return { session, head, tree, testedTree, changes: [], calls: [] };
}

async function hostTest_deliver(f: ReturnType<typeof sessionFixture>, head: string, dest = { path: f.root, branch: 'main' }) {
  await hostTest_append(f, {
    kind: 'integrate', by: 'tool', key: `integrate:delivered:${++hostTest_eventNumber}`,
    data: { phase: 'delivered', mode: 'uncommitted', dest, from: head, source: head },
  });
}









function encodeVarint(val: number | bigint): number[] {
  const bytes: number[] = [];
  let n = BigInt(val);
  while (n > 0x7fn) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n & 0x7fn));
  return bytes;
}
function encodeTag(fieldNum: number, wireType: number): number[] {
  return encodeVarint((fieldNum << 3) | wireType);
}
function encodeLengthDelimited(fieldNum: number, content: Uint8Array | number[] | string): number[] {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  return [...encodeTag(fieldNum, 2), ...encodeVarint(buf.length), ...buf];
}
function buildGenMetadataBlob(options: {
  input?: number;
  output?: number;
  cacheRead?: number;
  reasoning?: number;
  modelSlug?: string;
  displayName?: string;
  lastStepIndex?: number;
}): Uint8Array {
  const tag1Fields: number[] = [];
  const counters: number[] = [];
  if (options.input !== undefined) counters.push(...encodeTag(2, 0), ...encodeVarint(options.input));
  if (options.output !== undefined) counters.push(...encodeTag(3, 0), ...encodeVarint(options.output));
  if (options.cacheRead !== undefined) counters.push(...encodeTag(5, 0), ...encodeVarint(options.cacheRead));
  if (options.reasoning !== undefined) counters.push(...encodeTag(9, 0), ...encodeVarint(options.reasoning));
  if (counters.length > 0) tag1Fields.push(...encodeLengthDelimited(4, counters));
  if (options.modelSlug !== undefined) tag1Fields.push(...encodeLengthDelimited(19, options.modelSlug));
  if (options.lastStepIndex !== undefined) {
    const kv = [
      ...encodeLengthDelimited(1, 'last_step_index'),
      ...encodeLengthDelimited(2, String(options.lastStepIndex)),
    ];
    tag1Fields.push(...encodeLengthDelimited(20, kv));
  }
  if (options.displayName !== undefined) tag1Fields.push(...encodeLengthDelimited(21, options.displayName));
  return new Uint8Array(encodeLengthDelimited(1, tag1Fields));
}

test('review yield renders per slot outcomes', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const review = 'plan-yield';
    const must = finding('F1', {severity: 'MUST', sources: ['claude[0]']});
    const should = finding('F2', {severity: 'SHOULD', sources: ['claude[0]']});
    const consider = finding('F3', {severity: 'CONSIDER', sources: ['codex[0]']});
    const duplicate = finding('F4', {severity: 'MUST', sources: ['codex[0]']});
    const shared = finding('F5', {severity: 'SHOULD', sources: ['claude[0]', 'codex[0]']});
    const nativeFinding = finding('F6', {severity: 'MUST', sources: ['native[0]']});
    const toolFinding = finding('F7', {severity: 'MUST', sources: ['tool']});
    const unruledFinding = finding('F8', {severity: 'MUST', sources: ['claude[0]']});
    saveRound({
      session: f.session, review, round: 1,
      roster: [
        rosterSlot('claude[0]', 'claude', {model: 'model-a'}),
        rosterSlot('codex[0]', 'codex', {model: 'model-b'}),
        rosterSlot('agy[0]', 'agy', {model: 'model-c'}),
        rosterSlot('native[0]', 'codex', {native: true}),
      ],
      outcomes: [
        {slot: 'claude[0]', state: 'done', text: 'ok', responder: {slot: 'claude[0]', provider: 'claude', model: 'model-a', native: false}},
        {slot: 'codex[0]', state: 'done', text: 'ok', responder: {slot: 'codex[0]', provider: 'codex', model: 'model-b', native: false}},
        {slot: 'agy[0]', state: 'done', text: 'ok'},
        {slot: 'native[0]', state: 'done', text: 'ok', responder: {slot: 'native[0]', provider: 'codex', model: 'model-a', native: true}},
      ],
      findings: [must, should, consider, duplicate, shared, nativeFinding, toolFinding, unruledFinding],
    });
    const subject = roundSubject(f.session, review, 1);
    captureRuns(f.session, [
      attempt(subject, {slot: 'claude[0]', provider: 'claude', model: 'model-a', tokens: 1000}),
      attempt(subject, {slot: 'codex[0]', provider: 'codex', model: 'model-b', tokens: 500}),
      attempt(subject, {slot: 'agy[0]', provider: 'agy', model: 'model-c'}),
    ]);
    const fold = {records: [
      ruling(1, review, 'F1', 'accepted'), ruling(2, review, 'F2', 'rejected'), ruling(3, review, 'F3', 'deferred'),
      ruling(4, review, 'F4', 'duplicate'), ruling(5, review, 'F5', 'accepted'), ruling(6, review, 'F6', 'accepted'),
      ruling(7, review, 'F7', 'accepted'),
    ], lastSeq: 7, torn: null} as Fold;
    const facts = sessionFacts(f.session, fold, 'complete');
    const row = (provider: string, kind = 'provider') => facts.slotYield!.find((value) => value.provider === provider && value.kind === kind)!;
    assert.deepEqual(row('claude'), {
      kind: 'provider', provider: 'claude', model: 'model-a', raised: {MUST: 2, SHOULD: 2, CONSIDER: 0},
      accepted: 2, rejected: 1, deferred: 0, duplicate: 0, unruled: 1, tokens: 1000, measured: 1, launched: 1,
      attempts: [{provider: 'claude', model: 'model-a', effort: null, usage: {input: 1000, output: 0}}],
    });
    assert.deepEqual(row('codex'), {
      kind: 'provider', provider: 'codex', model: 'model-b', raised: {MUST: 1, SHOULD: 1, CONSIDER: 1},
      accepted: 1, rejected: 0, deferred: 1, duplicate: 1, unruled: 0, tokens: 500, measured: 1, launched: 1,
      attempts: [{provider: 'codex', model: 'model-b', effort: null, usage: {input: 500, output: 0}}],
    });
    assert.deepEqual(row('agy'), {
      kind: 'provider', provider: 'agy', model: 'model-c', raised: {MUST: 0, SHOULD: 0, CONSIDER: 0},
      accepted: 0, rejected: 0, deferred: 0, duplicate: 0, unruled: 0, measured: 0, launched: 1,
      attempts: [{provider: 'agy', model: 'model-c', effort: null}],
    });
    assert.deepEqual(row('codex', 'native'), {
      kind: 'native', provider: 'codex', model: null, raised: {MUST: 1, SHOULD: 0, CONSIDER: 0},
      accepted: 1, rejected: 0, deferred: 0, duplicate: 0, unruled: 0, measured: 0, launched: 0,
    });
    assert.deepEqual(row('tool', 'tool'), {
      kind: 'tool', provider: 'tool', model: null, raised: {MUST: 1, SHOULD: 0, CONSIDER: 0},
      accepted: 1, rejected: 0, deferred: 0, duplicate: 0, unruled: 0, measured: 0, launched: 0,
    });
    const report = fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8');
    assert.match(report, /### Review yield by slot/);
    assert.match(report, /^\| claude \| model-a \| 2 \| 2 \| 0 \| 2 \| 1 \| 0 \| 0 \| 1 \| 1,000 \| 500 \| — \| — \| — \|$/m);
    assert.match(report, /^\| codex \| model-b \| 1 \| 1 \| 1 \| 1 \| 0 \| 1 \| 1 \| 0 \| 500 \| 500 \| — \| — \| — \|$/m);
    assert.match(report, /^\| agy \| model-c \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| — partial \| 0 accepted \| — \| 0 accepted \| — \|$/m);
    assert.match(report, /^\| codex \| native \| 1 \| 0 \| 0 \| 1 \| 0 \| 0 \| 0 \| 0 \| — \| — \| — \| — \| — \|$/m);
    assert.match(report, /^\| tool \| — \| 1 \| 0 \| 0 \| 1 \| 0 \| 0 \| 0 \| 0 \| — \| — \| — \| — \| — \|$/m);
  } finally { f.cleanup(); }
});

test('unconfigured native responder renders unavailable instead of the roster model', async () => {
  const f = sessionFixture({ memory: true });
  try {
    saveRound({
      session: f.session, review: 'plan-null-model', round: 1,
      roster: [rosterSlot('codex[0]', 'codex', {native: true, model: 'model-roster'})],
      outcomes: [
        {slot: 'codex[0]', state: 'done', text: 'ok', responder: {slot: 'codex[0]', provider: 'codex', model: null, native: true}},
      ],
    });
    const fold = {records: [], lastSeq: 0, torn: null} as Fold;
    const facts = sessionFacts(f.session, fold, 'complete');
    const row = facts.invocations.find(i => i.slot === 'codex[0]');
    assert.ok(row, 'the native invocation is reported');
    assert.equal(row?.surface, 'native');
    assert.equal(row?.provider, 'codex');
    assert.equal(row?.model, 'unavailable', 'a null responder model never borrows the roster model: ' + JSON.stringify(row));
  } finally { f.cleanup(); }
});

test('review yield counts every reserve alias attempt', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const review = 'plan-reserve-alias';
    saveRound({
      session: f.session, review, round: 1,
      roster: [rosterSlot('claude[0]', 'claude'), rosterSlot('codex[0]', 'codex'), rosterSlot('copilot[0]', 'copilot', {reserve: true, model: 'model-r'})],
      outcomes: [
        {slot: 'claude[0]', state: 'done', text: 'ok', responder: {slot: 'copilot[0]', provider: 'copilot', model: 'model-r', native: false}},
        {slot: 'codex[0]', state: 'done', text: 'ok', responder: {slot: 'copilot[0]', provider: 'copilot', model: 'model-r', native: false}},
      ],
      findings: [finding('F1', {severity: 'MUST', sources: ['claude[0]']}), finding('F2', {severity: 'MUST', sources: ['codex[0]']})],
    });
    const subject = roundSubject(f.session, review, 1);
    captureRuns(f.session, [
      attempt(subject, {slot: 'claude[0]', provider: 'claude', model: 'model-a', outcome: 'auth', tokens: 100}),
      attempt(subject, {slot: 'copilot[0]', provider: 'copilot', model: 'model-r', targetSlot: 'claude[0]', attempt: 2, tokens: 300}),
      attempt(subject, {slot: 'copilot[0]', provider: 'copilot', model: 'model-r', targetSlot: 'claude[0]', attempt: 3, tokens: 300}),
      attempt(subject, {slot: 'copilot[0]', provider: 'copilot', model: 'model-r', targetSlot: 'codex[0]', attempt: 1, tokens: 200}),
    ]);
    const fold = {records: [ruling(1, review, 'F1', 'accepted'), ruling(2, review, 'F2', 'accepted')], lastSeq: 2, torn: null} as Fold;
    const facts = sessionFacts(f.session, fold, 'complete');
    assert.deepEqual(facts.slotYield, [{
      kind: 'provider', provider: 'copilot', model: 'model-r', raised: {MUST: 2, SHOULD: 0, CONSIDER: 0},
      accepted: 2, rejected: 0, deferred: 0, duplicate: 0, unruled: 0, tokens: 900, measured: 4, launched: 4,
      attempts: [
        {provider: 'claude', model: 'model-a', effort: null, usage: {input: 100, output: 0}},
        {provider: 'copilot', model: 'model-r', effort: null, usage: {input: 300, output: 0}},
        {provider: 'copilot', model: 'model-r', effort: null, usage: {input: 300, output: 0}},
        {provider: 'copilot', model: 'model-r', effort: null, usage: {input: 200, output: 0}},
      ],
    }]);
    assert.match(fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8'), /^\| copilot \| model-r \| 2 \| 0 \| 0 \| 2 \| 0 \| 0 \| 0 \| 0 \| 900 \| 450 \| — \| — \| — \|$/m);
  } finally { f.cleanup(); }
});

test('review yield credits the last attempted responder across captures', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const review = 'plan-retry-capture';
    saveRound({
      session: f.session, review, round: 1,
      roster: [rosterSlot('claude[0]', 'claude')],
      outcomes: [{slot: 'claude[0]', state: 'failed', cls: 'timeout'}],
    });
    const subject = roundSubject(f.session, review, 1);
    const directory = path.join(f.session, '.state', 'diagnostics');
    writeJson(path.join(directory, 'run-1.json'), {
      capture: {state: 'completed', start: 1, end: 2}, phases: [], reviews: [], invocations: [
        attempt(subject, {slot: 'claude[0]', provider: 'claude', model: 'model-a', attempt: 1, outcome: 'auth', tokens: 100}),
        attempt(subject, {slot: 'claude[0]', provider: 'claude', model: 'model-b', attempt: 2, outcome: 'timeout', tokens: 200}),
      ],
    });
    writeJson(path.join(directory, 'run-2.json'), {
      capture: {state: 'completed', start: 3, end: 4}, phases: [], reviews: [], invocations: [
        attempt(subject, {slot: 'claude[0]', provider: 'claude', model: 'model-a', attempt: 1, outcome: 'timeout', tokens: 300}),
      ],
    });
    const facts = sessionFacts(f.session, {records: [], lastSeq: 0, torn: null} as Fold, 'complete');
    assert.deepEqual(facts.slotYield, [{
      kind: 'provider', provider: 'claude', model: 'model-a', raised: {MUST: 0, SHOULD: 0, CONSIDER: 0},
      accepted: 0, rejected: 0, deferred: 0, duplicate: 0, unruled: 0, tokens: 600, measured: 3, launched: 3,
      attempts: [
        {provider: 'claude', model: 'model-a', effort: null, usage: {input: 100, output: 0}},
        {provider: 'claude', model: 'model-b', effort: null, usage: {input: 200, output: 0}},
        {provider: 'claude', model: 'model-a', effort: null, usage: {input: 300, output: 0}},
      ],
    }]);
    assert.match(fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8'), /^\| claude \| model-a \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 600 \| 0 accepted \| — \| 0 accepted \| — \|$/m);
  } finally { f.cleanup(); }
});

test('review yield responder change across rounds', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const review = 'plan-change';
    saveRound({
      session: f.session, review, round: 1, generation: 2,
      roster: [rosterSlot('claude[0]', 'claude', {model: 'model-a'})],
      outcomes: [{slot: 'claude[0]', state: 'done', text: 'ok', responder: {slot: 'claude[0]', provider: 'claude', model: 'model-a', native: false}}],
      findings: [finding('F1', {severity: 'MUST', sources: ['claude[0]']})],
    });
    saveRound({
      session: f.session, review, round: 2,
      roster: [rosterSlot('claude[0]', 'codex', {model: 'model-b'})],
      outcomes: [{slot: 'claude[0]', state: 'done', text: 'ok', responder: {slot: 'claude[0]', provider: 'codex', model: 'model-b', native: false}}],
      findings: [finding('F2', {severity: 'MUST', sources: ['claude[0]']})],
    });
    fs.mkdirSync(path.join(f.session, '.state', 'reviews', review, 'round-1', 'gen-1'), {recursive: true});
    captureRuns(f.session, [
      attempt(roundSubject(f.session, review, 1, 1), {slot: 'claude[0]', provider: 'claude', model: 'model-a', tokens: 900}),
      attempt(roundSubject(f.session, review, 1, 2), {slot: 'claude[0]', provider: 'claude', model: 'model-a', attempt: 2, tokens: 100}),
      attempt(roundSubject(f.session, review, 2), {slot: 'claude[0]', provider: 'codex', model: 'model-b', tokens: 200}),
    ]);
    const fold = {records: [ruling(1, review, 'F1', 'accepted'), ruling(2, review, 'F2', 'accepted')], lastSeq: 2, torn: null} as Fold;
    const facts = sessionFacts(f.session, fold, 'complete');
    assert.deepEqual(facts.slotYield?.map((row) => [row.provider, row.model, row.tokens, row.accepted, row.measured, row.launched]).sort(), [
      ['claude', 'model-a', 100, 1, 1, 1], ['codex', 'model-b', 200, 1, 1, 1],
    ]);
    const report = fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8');
    assert.match(report, /^\| claude \| model-a \| 1 \| 0 \| 0 \| 1 \| 0 \| 0 \| 0 \| 0 \| 100 \| 100 \| — \| — \| 1 prior-generation launches excluded \|$/m);
    assert.match(report, /^\| codex \| model-b \| 1 \| 0 \| 0 \| 1 \| 0 \| 0 \| 0 \| 0 \| 200 \| 200 \| — \| — \| — \|$/m);
  } finally { f.cleanup(); }
});

test('token table groups by effort and persists reasoning tokens', () => {
  const f = sessionFixture({ memory: true });
  try {
    assert.equal(normalizeUsage({ input: 100, output: 10, reasoning: 7 }, 'uncached')?.reasoning, 7);
    captureRuns(f.session, [
      { phase: 'plan-review', attempt: 1, provider: 'codex', model: 'gpt', effort: 'low', mode: 'cli', surface: 'cli', launched: true, outcome: 'ok', usage: { input: 100, output: 10 } },
      { phase: 'plan-review', attempt: 2, provider: 'codex', model: 'gpt', effort: 'high', mode: 'cli', surface: 'cli', launched: true, outcome: 'ok', usage: { input: 200, output: 20 } },
      { phase: 'plan-review', attempt: 3, provider: 'copilot', model: 'auto', effort: 'high', mode: 'cli', surface: 'cli', launched: true, outcome: 'ok', coverage: ['no usage'] },
      { phase: 'plan-review', attempt: 4, provider: 'claude', model: 'm', effort: 'high', mode: 'cli', surface: 'cli', launched: true, outcome: 'ok',
        usage: { input: 100, output: 10, cacheRead: 20, cacheWrite: 3, reasoning: 7, scope: 'invocation', provenance: 'test', inputSemantics: 'uncached' } },
    ]);
    const facts = sessionFacts(f.session, { records: [], lastSeq: 0, torn: null }, 'complete');
    assert.deepEqual(facts.invocations.find(i => i.provider === 'copilot')?.coverage, ['no usage']);
    assert.deepEqual(facts.invocations.find(i => i.provider === 'claude')?.usage, { input: 100, output: 10, cacheRead: 20, cacheWrite: 3, reasoning: 7 });
    const table = fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8');
    assert.match(table, /### Tokens by stage/);
    assert.match(table, /^\| Stage \| Platform \| Role \| Model \| Effort \| Uncached input \| Cache read \| Cache write \| Output \| Reasoning \| Coverage \| Cost notes \| Cost \|$/m);
    assert.match(table, /^\| — \| codex \| delegate \| gpt \(configured\) \| low \| 100 \| — \| — \| 10 \| — \| 1\/1 \| — \| — \|$/m);
    assert.match(table, /^\| — \| codex \| delegate \| gpt \(configured\) \| high \| 200 \| — \| — \| 20 \| — \| 1\/1 \| — \| — \|$/m);
    assert.match(table, /^\| — \| copilot \| delegate \| auto \(configured\) \| high \| — \| — \| — \| — \| — \| 0\/1 no usage \| — \| — \|$/m);
    assert.match(table, /^\| — \| claude \| delegate \| m \(configured\) \| high \| 100 \| 20 \| 3 \| 10 \| 7 \| 1\/1 \| — \| — \|$/m);
    assert.doesNotMatch(table, /^\| — \| codex \| delegate \| all models \|/m);
  } finally { f.cleanup(); }
});

test('Claude per model reasoning survives the observer capture', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill'); fs.mkdirSync(skill);
    writeJson(path.join(skill, 'config.jsonc'), {diagnostics: true});
    f.deps.skillRoot = skill;
    const stdout = JSON.stringify({type: 'result', modelUsage: {
      alpha: {inputTokens: 10, outputTokens: 2, thinkingTokens: 3},
      beta: {inputTokens: 5, outputTokens: 1, thinkingTokens: 4},
    }});
    const usage = claude.usage!(stdout)!;
    f.deps.delegate = async () => ({
      outcome: {status: 'ok', text: 'answer', resume: null, sessionId: null},
      invocations: [{provider: 'claude', model: 'aggregate', effort: 'high', mode: 'cli', launched: true, outcome: 'ok', usage}],
    });
    const observer = observeTool(f.session, 'ask', 'run', undefined, f.deps)!;
    const dir = path.join(f.session, 'work');
    await observer.deps.delegate('claude', {logPath: path.join(dir, 'logs', 'claude[0].log')} as never, 'cli');
    const facts = sessionFacts(f.session, {records: [], lastSeq: 0, torn: null}, 'complete');
    assert.deepEqual(facts.invocations[0]?.usage?.models, {
      alpha: {input: 10, output: 2, reasoning: 3},
      beta: {input: 5, output: 1, reasoning: 4},
    });
    const table = fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8');
    assert.match(table, /^\| — \| claude \| delegate \| alpha \| high \| 10 \| — \| — \| 2 \| 3 \| 1\/1 \| — \| — \|$/m);
    assert.match(table, /^\| — \| claude \| delegate \| beta \| high \| 5 \| — \| — \| 1 \| 4 \| 1\/1 \| — \| — \|$/m);
    assert.doesNotMatch(table, /^\| — \| claude \| delegate \| aggregate \|/m);
  } finally { f.cleanup(); }
});

test('origin: a nonzero fix-induced count renders the column', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const review = 'plan-origin';
    saveRound({
      session: f.session, review, round: 2,
      roster: [rosterSlot('claude[0]', 'claude', {model: 'model-a'})],
      outcomes: [{slot: 'claude[0]', state: 'done', text: 'ok', responder: {slot: 'claude[0]', provider: 'claude', model: 'model-a', native: false}}],
      findings: [
        {...finding('F1', {severity: 'MUST'}), origin: 'fix-induced'},
        {...finding('F2', {severity: 'SHOULD'}), origin: 'original'},
        {...finding('F3', {severity: 'SHOULD'}), origin: 'fix-induced'},
      ],
    });
    captureRuns(f.session, [attempt(roundSubject(f.session, review, 2), {slot: 'claude[0]', provider: 'claude', model: 'model-a', tokens: 100})]);
    const fold = {records: [], lastSeq: 0, torn: null} as Fold;
    const facts = sessionFacts(f.session, fold, 'complete');
    assert.equal(facts.slotYield?.find((row) => row.provider === 'claude')?.fixInduced, 2);
    const report = fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8');
    assert.match(report, /^\| Provider \| Model \| MUST \| SHOULD \| CONSIDER \| Fix-induced \| Accepted /m);
    assert.match(report, /^\| claude \| model-a \| 1 \| 2 \| 0 \| 2 \| 0 \| 0 \| 0 \| 0 \| 3 \| 100 \| 0 accepted \| — \| 0 accepted \| — \|$/m);
  } finally { f.cleanup(); }
});

test('review yield prices an observed route and keeps redacted mixed usage in the partial subtotal', () => {
  const f = sessionFixture({ memory: true });
  try {
    const review = 'plan-observed-model';
    const configured = 'configured/alpha';
    const observed = 'actual/alpha';
    const subject = roundSubject(f.session, review, 1);
    saveRound({
      session: f.session, review, round: 1,
      roster: [rosterSlot('opencode[0]', 'opencode', {model: configured})],
      outcomes: [{slot: 'opencode[0]', state: 'done', text: 'ok', responder: {provider: 'opencode', model: configured, native: false}}],
      findings: [finding('F1', {sources: ['opencode[0]']})],
    });
    const raw = attempt(subject, {slot: 'opencode[0]', provider: 'opencode', model: configured, tokens: 1_000_000});
    captureRuns(f.session, [
      {...raw, reportedModels: [observed], usageSource: 'session'},
      {...raw, attempt: 2, usage: {input: 25, output: 0}, reportedModels: [observed, 'bad model'], usageSource: 'session'},
      {...raw, attempt: 3, usage: {input: 1_000_000, output: 0}, usageSource: 'stdout', coverage: ['transcript unavailable']},
    ]);
    const fold = {records: [ruling(1, review, 'F1', 'accepted')], lastSeq: 1, torn: null} as Fold;
    const facts = sessionFacts(f.session, fold, 'complete');
    assert.equal(facts.invocations[1]?.reportedModelAmbiguous, true);
    assert.deepEqual(facts.invocations[1]?.reportedModels, [observed]);
    assert.equal(facts.slotYield?.[0]?.attempts?.[1]?.reportedModelAmbiguous, true);
    const pricer = resolvePricing({
      asOf: '2026-11-16', source: ['https://example.test/pricing'],
      models: {alpha: {rates: {input: 0, output: 0}}, [configured]: {rates: {input: 9, output: 9}}},
    }, {[observed]: {rates: {input: 3, output: 3}}})!;
    const text = renderDiagnostics([facts], pricer).text;
    assert.match(text, /^\| CLI delegates \| 2,000,025 \| ~\$3\.00 \| 2 session, 1 stdout fallback, transcript unavailable, 1 observed unit unpriced \|$/m);
    const yieldRows = text.split('### Review yield by slot')[1]!;
    assert.match(yieldRows, /\| 2,000,025 partial \| 2,000,025 partial \| ~\$3\.00 partial \| ~\$3\.00 partial \| unpriced model, override qualified rate .*session, stdout fallback, reported: actual\/alpha \|/);
  } finally { f.cleanup(); }
});

test('review yield renders Cost, Cost / accepted, Cost notes and 0 accepted cells', () => {
  const pricer = resolvePricing({
    asOf: '2026-11-16', source: ['https://example.test/pricing'],
    models: {
      alpha: { rates: { input: 2, output: 10 } },
    },
  }, undefined)!;
  const text = renderDiagnostics([{
    phases: [], invocations: [], reviews: [],
    slotYield: [
      {
        kind: 'provider', provider: 'claude', model: 'alpha',
        raised: { MUST: 2, SHOULD: 0, CONSIDER: 0 },
        accepted: 2, rejected: 0, deferred: 0, duplicate: 0, unruled: 0,
        tokens: 1_000_000, measured: 1, launched: 2,
        attempts: [
          { provider: 'claude', model: 'alpha', effort: 'high', usage: { input: 1_000_000, output: 0 } },
          { provider: 'claude', model: 'alpha', effort: 'high' },
        ],
      },
      {
        kind: 'provider', provider: 'codex', model: 'alpha',
        raised: { MUST: 0, SHOULD: 1, CONSIDER: 0 },
        accepted: 0, rejected: 1, deferred: 0, duplicate: 0, unruled: 0,
        tokens: 1_000_000, measured: 1, launched: 1,
        attempts: [
          { provider: 'codex', model: 'alpha', effort: 'low', usage: { input: 1_000_000, output: 0 } },
        ],
      },
    ],
  }], pricer).text;
  assert.match(text, /^\| claude \| alpha \| 2 \| 0 \| 0 \| 2 \| 0 \| 0 \| 0 \| 0 \| 1,000,000 partial \| 500,000 partial \| ~\$2\.00 partial \| ~\$1\.00 partial \| no usage \|$/m);
  assert.match(text, /^\| codex \| alpha \| 0 \| 1 \| 0 \| 0 \| 1 \| 0 \| 0 \| 0 \| 1,000,000 \| 0 accepted \| ~\$2\.00 \| 0 accepted \| — \|$/m);
});
