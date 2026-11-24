import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { observeTool, optionalDiagnostics, readReviews, sessionFacts, writeDiagnostics } from '../../../skills/dispatch/scripts/toolkit/diagnostics.ts';
import { heuristics, normalizeUsage, sanitizeFacts } from '../../../skills/dispatch/scripts/toolkit/domain/diagnostics.ts';
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
import { renderDiagnostics, unitsOf } from '../../../skills/dispatch/scripts/toolkit/domain/diagnostics-render.ts';
import { readHostUsage } from '../../../skills/dispatch/scripts/lib/usage/index.ts';
import { readDelegateSession } from '../../../skills/dispatch/scripts/lib/usage/delegate.ts';
import { resolvePricing } from '../../../skills/dispatch/scripts/lib/pricing.ts';
import { lines, memoryFs, query } from '../lib/usage/helpers/memory-fs.ts';

function copilotCalls(model: string) {
  const fs = memoryFs({ '/home/.copilot/session-state/host/events.jsonl': lines(
    { type: 'subagent.started', agentId: 'child', data: { toolCallId: 'child-call' } },
    ...[undefined, 'child'].map((agentId, sequence) => ({ type: 'session.usage_record', timestamp: new Date(1000 + sequence).toISOString(), agentId,
      data: { usage: { accounting: { sourceSessionId: 'source', sequence, usageId: `receipt-${sequence}` }, model, reasoningEffort: 'high',
        inputTokens: 100, outputTokens: 20, copilotUsage: { totalNanoAiu: 200 }, cost: 1, aiCreditsStatus: 'complete' } } })),
  ) });
  const hostUsage = readHostUsage('copilot', { ...query, env: () => 'host' }, fs);
  const read = readDelegateSession({ ...query, platform: 'copilot', fs, resumed: false, collectResponses: true });
  assert.ok(read.usage);
  assert.ok(read.usage.actualModels);
  assert.ok(read.responses);
  const invocation = { phase: 'implementation', provider: 'copilot', model, surface: 'cli' as const, launched: true, outcome: 'ok',
    usageSource: 'session' as const, usage: normalizeUsage(read.usage, 'uncached')!, reportedModels: read.usage.actualModels,
    responses: read.responses.map((r, i) => ({ ...r, stage: 'implementation' as const, agent: `delegate-${r.role === 'subagent' ? 'child-' : ''}${String(i + 1).padStart(16, '0')}` })) };
  return { hostUsage, invocation };
}

test('Copilot qualified models survive public collection gates rendering and exact rates', () => {
  const model = '11111111-1111-1111-1111-111111111111/bedrock.claude-haiku-5-5';
  const { hostUsage, invocation } = copilotCalls(model);
  const rates = { [model]: { rates: { input: 1_000_000, output: 2_000_000 } } };
  const facts = sanitizeFacts({ phases: [], reviews: [], invocations: [invocation], hostUsage, config: { pricing: rates } });
  assert.equal(facts.hostUsage?.rows[0]?.model, model);
  assert.deepEqual(facts.invocations[0]?.reportedModels, [model]);
  assert.ok(facts.invocations[0]?.usage?.actors?.every(a => a.model === model));
  assert.ok(Object.keys(facts.invocations[0]?.usage?.models ?? {}).every(key => key === `${model}#high`));
  assert.deepEqual(facts.config?.['pricing'], rates);
  const pricer = resolvePricing({ asOf: '2026-11-24', source: [], models: {} }, facts.config?.['pricing']);
  assert.ok(pricer);
  assert.ok(unitsOf(facts, pricer).every(u => u.cost?.high === 140 && u.cost.rateBasis?.match === 'qualified'));
  assert.match(renderDiagnostics([facts], pricer).text, new RegExp(model));
  for (const bad of ['11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111/', `${model}/11111111-1111-1111-1111-111111111111`, '/home/private', 'https://host.test/model', 'private@example.com']) {
    const rejected = sanitizeFacts({ phases: [], reviews: [], invocations: [{ phase: 'implementation', provider: 'copilot', model: bad,
      surface: 'cli', launched: true, outcome: 'ok', reportedModels: [bad] }] });
    assert.equal(rejected.invocations[0]?.model, '—');
    assert.equal(rejected.invocations[0]?.reportedModels, undefined);
  }
});

test('Copilot child receipt turns are not supplemented twice in summary role or stage', () => {
  const { invocation } = copilotCalls('custom/model');
  const text = renderDiagnostics([{ phases: [{ key: 'implementation', name: 'implementation' }], reviews: [], invocations: [invocation] }]).text;
  assert.match(text, /- Turns: User — · LLM 2 \(partial\)/);
  const cells = (label: string) => text.split('\n').find(line => line.startsWith(`| ${label} |`))!.split('|').map(v => v.trim());
  assert.equal(cells('Subagents')[7], '1');
  assert.equal(cells('CLI delegates')[7], '1');
  assert.equal(cells('implementation')[7], '2');
});

test('Copilot accounting detail folds before the report cap with closed markup and exact rollups', () => {
  const { hostUsage } = copilotCalls('model-' + 'x'.repeat(88));
  hostUsage.rows = Array.from({ length: 900 }, (_, i) => ({ ...hostUsage.rows[1]!, phase: `phase-${i}`, input: 1, output: 1, turns: 1 }));
  for (const crowded of [false, true]) {
    const phases = crowded ? Array.from({ length: 1000 }, (_, i) => ({ key: `phase-${i}-` + 'x'.repeat(110), name: 'implementation' })) : [];
    const text = renderDiagnostics([{ phases, reviews: [], invocations: [], hostUsage }]).text;
    assert.ok(Buffer.byteLength(text) <= 131072);
    assert.equal((text.match(/<details>/g) ?? []).length, (text.match(/<\/details>/g) ?? []).length);
    assert.doesNotMatch(text, /Truncated at the report size limit/);
    assert.equal(text.trim().endsWith('</details>'), true);
    assert.match(text, /\| Subagents \|[^\n]*\| 1,800 \|/);
    const note = text.split('\n').find(line => line.startsWith('Detail coverage partial:'))!;
    assert.match(note, new RegExp(`Detail coverage partial: ${crowded ? 900 : 868} accounting rows omitted`));
    assert.match(note, /868 beyond the 32-row detail cap/);
    if (crowded) assert.match(note, /32 additional rows omitted at the report size limit/);
    else assert.doesNotMatch(note, /report size limit/);
  }
});

test('Copilot reports separate billing coverage from USD estimates', () => {
  const text = renderDiagnostics([{ phases: [], reviews: [], invocations: [
    { phase: 'implementation', provider: 'copilot', model: 'custom/model', surface: 'cli', launched: true, outcome: 'ok', configuredEffort: 'high', usage: { input: 70, output: 40, copilot: { tokenCoverage: 'complete', lineageCoverage: 'unknown', actorCoverage: 'complete', billing: { coverage: 'partial', totalNanoAiu: 200, statuses: ['pending'], multipliers: [2] } } } },
    { phase: 'implementation', provider: 'copilot', model: 'custom/model', surface: 'native', launched: false, outcome: 'ok', effort: 'max' },
  ] }]).text;
  assert.match(text, /nano-AI units/);
  assert.match(text, /200/);
  assert.match(text, /partial/);
  assert.match(text, /Configured effort/);
  assert.match(text, /USD estimate/);
});

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

test('diagnostics render writes the session report when enabled and reports off when disabled', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill'); fs.mkdirSync(skill);
    f.deps.skillRoot = skill;
    writeJson(path.join(skill, 'config.jsonc'), {diagnostics: false});
    assert.equal(await main(['diagnostics', 'render', '--session', f.session], f.deps), 0);
    assert.deepEqual([f.output().ok, f.output().summary], [true, 'diagnostics off']);
    assert.equal(fs.existsSync(path.join(f.session, 'diagnostics.md')), false);

    writeJson(path.join(skill, 'config.jsonc'), {diagnostics: true});
    f.lines.length = 0;
    assert.equal(await main(['diagnostics', 'render', '--session', f.session], f.deps), 0);
    const output = f.output();
    assert.equal(output.ok, true);
    assert.deepEqual(f.launches, [], 'rendering diagnostics does not invoke an inference delegate');
    const result = JSON.parse(fs.readFileSync(output.path!, 'utf8'));
    assert.equal(result.path, path.join(f.session, 'diagnostics.md'));
    const text = fs.readFileSync(result.path, 'utf8');
    assert.match(text, /### Spend & Turns by Role/);
    assert.match(text, /^\| Host \| — \| — \| — \| — \| — \| — \| — \| host usage unavailable/m);
    assert.match(text, /^\| CLI delegates \| — \| — \| — \| — \| — \| — \| — \| no recorded launches/m);
    assert.equal(fs.existsSync(path.join(f.session, '.state', 'diagnostics')), false, 'render is not captured as a tool observation');

    writeJson(path.join(skill, 'references', 'pricing.json'), {
      asOf: '2026-11-19', source: ['https://example.test/pricing'],
      models: { alpha: { rates: { input: 1, output: 1 } }, 'actual/alpha': { rates: { input: 3, output: 3 } } },
    });
    captureRuns(f.session, [{
      phase: 'plan-review', provider: 'opencode', model: 'configured/alpha', surface: 'cli', launched: true,
      outcome: 'ok', reportedModels: ['actual/alpha'], usageSource: 'stdout', coverage: ['transcript unavailable'],
      usage: { input: 1_000_000, output: 0 },
    }]);
    f.lines.length = 0;
    assert.equal(await main(['diagnostics', 'render', '--session', f.session], f.deps), 0);
    const priced = fs.readFileSync(result.path, 'utf8');
    assert.match(priced, /^\| CLI delegates \| ██████████ 100% \| ~\$3\.00 \| 1,000,000 \| — \| — \| — \| — \| 1 stdout fallback, transcript unavailable \|$/m);
    assert.match(priced, /1 qualified, 0 wildcard, 0 generic/);
  } finally { f.cleanup(); }
});

test('cost cells render from the skill rate table and fall back to not estimated without a host or table', () => {
  const f = sessionFixture({ memory: true });
  try {
    captureRuns(f.session, [
      { phase: 'plan-review', attempt: 1, provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', mode: 'cli', surface: 'cli', launched: true, outcome: 'ok', usage: { input: 1_000_000, output: 0 } },
    ]);
    const fold = { records: [], lastSeq: 0, torn: null };
    const skill = path.join(f.root, 'skill'); fs.mkdirSync(skill);
    f.deps.skillRoot = skill;
    const host = { manifest: readManifest(f.session), deps: f.deps };
    const render = (withHost: boolean) => fs.readFileSync(optionalDiagnostics(f.session, fold, 'complete', withHost ? host : undefined)!, 'utf8');
    const table = path.join(skill, 'references', 'pricing.json');
    const shipped = fs.readFileSync(new URL('../../../skills/dispatch/references/pricing.json', import.meta.url), 'utf8');
    const stageRow = (text: string) => text.split('### Tokens by stage')[1]!.split('\n').find((line) => line.startsWith('| — | claude | delegate | claude-sonnet-5-5'))!;

    assert.match(render(true), /^- Estimated cost not estimated \(rate table unavailable\)/m, 'missing table');
    assert.ok(stageRow(render(true)).endsWith('| 1/1 | — | — |'));
    fs.mkdirSync(path.dirname(table), { recursive: true });
    fs.writeFileSync(table, '{ not json');
    assert.match(render(true), /not estimated/, 'unreadable table');
    fs.writeFileSync(table, shipped);
    assert.match(render(false), /not estimated/, 'no host');
    const text = render(true);
    assert.match(text, /^- Estimated cost ~\$2\.00 \(partial\) · priced 1 · unpriced 0/m);
    assert.ok(stageRow(text).endsWith('| 1/1 | — | ~$2.00 |'), stageRow(text));
    assert.match(text, /^\| CLI delegates \| ██████████ 100% \| ~\$2\.00 \| 1,000,000 \| — \| — \| — \| — \| 1 legacy source unknown \|$/m);
    assert.match(text, /table 2026-11-19 · UTC day .*1 shipped, 0 override/);

    writeJson(path.join(skill, 'config.local.jsonc'), { pricing: { 'claude-sonnet-5-5': { rates: { input: 1, output: 1 } }, bad: 'x' } });
    assert.match(render(true), /^- Estimated cost ~\$1\.00/m, 'override replaces the shipped rate and a malformed entry is ignored');
  } finally { f.cleanup(); }
});

test('diagnostics render keeps an older report when the write fails', async t => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill'); fs.mkdirSync(skill);
    writeJson(path.join(skill, 'config.jsonc'), {diagnostics: true});
    f.deps.skillRoot = skill;
    const file = path.join(f.session, 'diagnostics.md');
    fs.writeFileSync(file, 'older report\n');
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === file) throw new Error('rename failure');
      return rename(from, to);
    }) as typeof fs.renameSync);
    assert.equal(await main(['diagnostics', 'render', '--session', f.session], f.deps), 4);
    const output = f.output();
    assert.equal(output.reason, 'diagnostics-failed');
    assert.equal(output.summary, 'diagnostics render failed; existing diagnostics.md unchanged');
    assert.equal(JSON.parse(fs.readFileSync(output.path!, 'utf8')).path ?? null, null);
    assert.equal(fs.readFileSync(file, 'utf8'), 'older report\n');
  } finally { t.mock.restoreAll(); f.cleanup(); }
});

test('diagnostics render reads host usage only while enabled', async () => {
  const f=sessionFixture({memory:true});
  try {
    const skill=path.join(f.root,'skill'); fs.mkdirSync(skill); const config=path.join(skill,'config.local.jsonc'); f.deps.skillRoot=skill;
    const manifestPath=path.join(f.session,'manifest.json'); const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8')); manifest.createdAt=new Date(1000).toISOString(); fs.writeFileSync(manifestPath,JSON.stringify(manifest));
    f.deps.orchestrator={platform:'claude',model:null}; f.deps.env={CLAUDE_CODE_SESSION_ID:'thread'}; f.deps.clock=()=>2000;
    const line=Buffer.from([
      JSON.stringify({type:'assistant',timestamp:new Date(500).toISOString(),message:{id:'old',model:'m',usage:{input_tokens:99,output_tokens:3}}}),
      JSON.stringify({type:'assistant',timestamp:new Date(1500).toISOString(),message:{id:'one',model:'m',usage:{input_tokens:12,output_tokens:3},text:'secret transcript'}}),
      JSON.stringify({type:'assistant',timestamp:new Date(2500).toISOString(),message:{id:'late',model:'m',usage:{input_tokens:99,output_tokens:3}}}),
    ].join('\n')); let reads=0;
    f.deps.hostUsageFs={list:dir=>dir.endsWith('projects')?['project']:[],stat:()=>({size:line.length,mtimeMs:2000}),read:()=>{reads++;return line;},decompress:null};
    fs.writeFileSync(config,'{"diagnostics":false}'); assert.equal(await main(['diagnostics','render','--session',f.session],f.deps),0); assert.equal(reads,0);
    f.lines.splice(0); fs.writeFileSync(config,'{"diagnostics":true}'); assert.equal(await main(['diagnostics','render','--session',f.session],f.deps),0);
    const rendered=fs.readFileSync(path.join(f.session,'diagnostics.md'),'utf8');
    assert.equal(reads,1); assert.match(rendered,/\| claude \| 12 \|/);
    assert.match(rendered,/^\| spec \| claude \| host \| m \| — \| 12 \| — \| — \| 3 \| — \| — \| — \| — \|$/m);
    assert.doesNotMatch(rendered,/secret transcript/);
    f.lines.splice(0); f.deps.hostUsageFs.list=()=>{throw Object.assign(new Error('private'),{code:'EACCES'});};
    assert.equal(await main(['diagnostics','render','--session',f.session],f.deps),0); assert.match(fs.readFileSync(path.join(f.session,'diagnostics.md'),'utf8'),/host unavailable: read-error:EACCES/);
    f.lines.splice(0); manifest.createdAt='invalid'; fs.writeFileSync(manifestPath,JSON.stringify(manifest));
    assert.equal(await main(['diagnostics','render','--session',f.session],f.deps),0);
    assert.equal(reads,1); assert.match(fs.readFileSync(path.join(f.session,'diagnostics.md'),'utf8'),/host unavailable: invalid session start/);
  } finally { f.cleanup(); }
});

test('report render and complete collect host usage without gating outcomes', async () => {
  const f = await hostTest_fixture();
  try {
    const manifestPath=path.join(f.session,'manifest.json'); const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8')); manifest.createdAt=new Date(1000).toISOString(); fs.writeFileSync(manifestPath,JSON.stringify(manifest));
    f.deps.clock=()=>2000; f.deps.orchestrator={platform:'claude',model:null}; f.deps.env={CLAUDE_CODE_SESSION_ID:'thread'};
    const line=Buffer.from(JSON.stringify({type:'assistant',timestamp:new Date(1500).toISOString(),message:{id:'one',model:'m',usage:{input_tokens:12,output_tokens:3}}})); let reads=0;
    f.deps.hostUsageFs={list:dir=>dir.endsWith('projects')?['project']:[],stat:()=>({size:line.length,mtimeMs:2000}),read:()=>{reads++;return line;},decompress:null};
    await hostTest_integrate(f,hostTest_gitState(f.session)); await hostTest_evidenceForPlan(f,hostTest_TREE); await hostTest_deliver(f,hostTest_HEAD);
    fs.writeFileSync(path.join(f.skillRoot,'config.local.jsonc'),'{"diagnostics":false}');
    assert.equal((await hostTest_invoke(f,'report','render')).exit,0); assert.equal((await hostTest_invoke(f,'report','complete')).exit,0); assert.equal(reads,0);
    fs.writeFileSync(path.join(f.skillRoot,'config.local.jsonc'),'{"diagnostics":true}');
    assert.equal((await hostTest_invoke(f,'report','render')).exit,0); assert.match(fs.readFileSync(path.join(f.session,'diagnostics.md'),'utf8'),/\| claude \| 12 \|/);
    assert.equal((await hostTest_invoke(f,'report','complete')).exit,0); assert.match(fs.readFileSync(path.join(f.session,'diagnostics.md'),'utf8'),/\| claude \| 12 \|/);
    f.deps.hostUsageFs.list=()=>{throw Object.assign(new Error('private'),{code:'EACCES'});};
    assert.equal((await hostTest_invoke(f,'report','render')).exit,0); assert.match(fs.readFileSync(path.join(f.session,'diagnostics.md'),'utf8'),/host unavailable: read-error:EACCES/);
    assert.equal((await hostTest_invoke(f,'report','complete')).exit,0); assert.match(fs.readFileSync(path.join(f.session,'diagnostics.md'),'utf8'),/host unavailable: read-error:EACCES/);
  } finally { f.cleanup(); }
});

test('diagnostics render warns on missing host retro only when enabled', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill');
    fs.mkdirSync(skill);
    const config = path.join(skill, 'config.local.jsonc');
    f.deps.skillRoot = skill;
    const retroPath = path.join(f.session, '.state', 'retro.json');

    fs.writeFileSync(config, '{"diagnostics": true}\n');
    assert.equal(await main(['diagnostics', 'render', '--session', f.session], f.deps), 0);
    let output = f.output();
    assert.equal(output.ok, true);
    let value = JSON.parse(fs.readFileSync(output.path!, 'utf8')) as { path: string | null; warning?: string };
    assert.ok(value.warning?.includes(retroPath));
    assert.ok(value.warning?.includes('merge retro notes'));
    assert.ok(output.summary.includes(retroPath));
    assert.ok(output.summary.includes('merge retro notes'));

    f.lines.splice(0);
    writeJson(retroPath, []);
    assert.equal(await main(['diagnostics', 'render', '--session', f.session], f.deps), 0);
    output = f.output();
    assert.equal(output.ok, true);
    value = JSON.parse(fs.readFileSync(output.path!, 'utf8')) as { path: string | null; warning?: string };
    assert.equal(value.warning, undefined);
    assert.ok(!output.summary.includes('merge retro notes'));
  } finally {
    f.cleanup();
  }
});

const groundingItem = {
  id: 'grounding-spec',
  component: 'references/grounding.md',
  category: 'information-access',
  evidence: 'map 1, nested 0, research 0, not-covered 0, yield 0/0, tokens unavailable',
  impact: 'Keep the map scope.',
  proposedFix: 'Keep the current discovery bounds.',
};

const retroWarningCases = [
  {name: 'non-array retro', setup: (file: string) => writeJson(file, {}), warning: 'array'},
  {name: 'malformed retro', setup: (file: string) => fs.writeFileSync(file, '{'), warning: 'array'},
  {name: 'unreadable retro', setup: (file: string) => fs.mkdirSync(file), warning: 'array'},
  {name: 'map without grounding', setup: (file: string) => writeJson(file, []), kind: 'map', warning: 'grounding'},
  {name: 'map with rejected grounding', setup: (file: string) => writeJson(file, [{id: groundingItem.id}]), kind: 'map', warning: 'grounding'},
  {name: 'map with accepted grounding', setup: (file: string) => writeJson(file, [groundingItem]), kind: 'map'},
  {name: 'research only', setup: (file: string) => writeJson(file, []), kind: 'research'},
];

for (const {name, setup, kind, warning} of retroWarningCases) {
  test('retro warning handles ' + name, async () => {
    const f = sessionFixture({ memory: true });
    try {
      f.deps.skillRoot = path.join(f.root, 'skill');
      writeJson(path.join(f.deps.skillRoot, 'config.local.jsonc'), {diagnostics: true});
      const state = path.join(f.session, '.state');
      fs.mkdirSync(state, {recursive: true});
      setup(path.join(state, 'retro.json'));
      if (kind) writeJson(path.join(state, 'results', 'brief-explorer-0001.json'), {kind});

      assert.equal(await main(['diagnostics', 'render', '--session', f.session], f.deps), 0);
      const output = f.output();
      assert.equal(output.ok, true);
      const value = JSON.parse(fs.readFileSync(output.path!, 'utf8')) as {warning?: string};
      if (!warning) {
        assert.equal(value.warning, undefined);
      } else {
        assert.ok(value.warning, 'expected a non-blocking retro warning');
        assert.ok(value.warning.includes('.state/retro.json'));
        assert.ok(value.warning.includes(warning === 'array' ? '[{id,component,category,evidence,impact,proposedFix}]' : 'grounding-<phase>'));
        assert.ok(Buffer.byteLength(value.warning) <= 240);
        assert.ok(output.summary.includes(value.warning));
      }
    } finally { f.cleanup(); }
  });
}

test('Overview lists each zero-invocation phase without folding', () => {
  const f = sessionFixture({ memory: true });
  try {
    writeJson(path.join(f.session, '.state', 'diagnostics', 'run-1.json'), {
      capture: { state: 'completed', start: 1000, end: 5000 },
      phases: [
        { key: 'ledger-append', name: 'implementation', outcome: 'ok', wallMs: 1000 },
        { key: 'lint-run', name: 'implementation', outcome: 'ok', wallMs: 2000 },
        { key: 'check-run', name: 'implementation', outcome: 'ok', wallMs: 1000 },
      ],
      invocations: [
        { phase: 'check-run', attempt: 1, provider: 'claude', model: 'm', mode: 'cli', surface: 'cli', launched: true, outcome: 'ok', usage: { input: 10, output: 5 } },
      ],
      reviews: [],
    });
    const fold = { records: [], lastSeq: 0, torn: null };
    const facts = sessionFacts(f.session, fold, 'complete', { manifest: readManifest(f.session), deps: f.deps });
    const text = fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8');
    const overviewSection = text.split('### Phases')[1]!.split('</details>')[0]!;
    assert.match(overviewSection, /\| implementation · check-run \|/);
    assert.match(overviewSection, /\| implementation · ledger-append \| ok \| 1s \|/);
    assert.match(overviewSection, /\| implementation · lint-run \| ok \| 2s \|/);
    assert.match(overviewSection, /\| all phases \|/);
    // Driver, Host, User wait columns omitted when no row has a value; Wall is kept
    const header = overviewSection.split('\n').find((l) => l.startsWith('| Phase |'))!;
    assert.ok(header.includes('| Wall |') && !header.includes('| Driver |') && !header.includes('| Host |') && !header.includes('| User wait |'), header);
  } finally {
    f.cleanup();
  }
});

test('legend defines symbols and units, and empty Grounding and Top findings are omitted', () => {
  const f = sessionFixture({ memory: true });
  try {
    const fold = { records: [], lastSeq: 0, torn: null };
    const facts = sessionFacts(f.session, fold, 'complete', { manifest: readManifest(f.session), deps: f.deps });
    const text = fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8');
    assert.match(text, /`—` unavailable/);
    assert.match(text, /`~` USD estimate/);
    assert.match(text, /bars show cost-midpoint share/i);
    assert.doesNotMatch(text, /### Grounding/);
    assert.doesNotMatch(text, /Top findings:/);
    assert.match(text, /## Findings\n\nNo findings\./);
    const overviewSection = text.split('### Phases')[1]!.split('</details>')[0]!;
    const table = overviewSection.split('\n').filter((l) => l.startsWith('|'));
    assert.equal(table[0], '| Phase | Outcome | Invocations | Input | Cache read | Cache write | Output | Coverage | Cost |');
    assert.equal(table[1], '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  } finally {
    f.cleanup();
  }
});

test('round workload render reads host usage again only for rounds with a start', async () => {
  const f = sessionFixture({memory: true});
  try {
    const skill = path.join(f.root, 'skill'); fs.mkdirSync(skill); f.deps.skillRoot = skill;
    fs.writeFileSync(path.join(skill, 'config.local.jsonc'), '{"diagnostics":true}');
    const manifestPath = path.join(f.session, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); manifest.createdAt = new Date(1000).toISOString(); fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const roundDir = path.join(f.session, '.state', 'reviews', 'plan-w', 'round-1');
    writeJson(path.join(roundDir, 'round.json'), {round: 1, generation: 1, cap: 4, roster: []});
    fs.mkdirSync(path.join(roundDir, 'gen-1'), {recursive: true});
    const subject = crypto.createHash('sha256').update(path.join(roundDir, 'gen-1')).digest('hex').slice(0, 16);
    const label = crypto.createHash('sha256').update(path.join(f.session, '.state', 'reviews', 'plan-w')).digest('hex').slice(0, 16);
    f.deps.orchestrator = {platform: 'claude', model: null}; f.deps.env = {CLAUDE_CODE_SESSION_ID: 'thread'}; f.deps.clock = () => 4000;
    const line = Buffer.from(JSON.stringify({type: 'assistant', timestamp: new Date(1550).toISOString(), message: {id: 'one', model: 'm', usage: {input_tokens: 12, output_tokens: 3}}}));
    let reads = 0;
    f.deps.hostUsageFs = {list: (dir: string) => dir.endsWith('projects') ? ['project'] : [], stat: () => ({size: line.length, mtimeMs: 2000}), read: () => { reads++; return line; }, decompress: null};

    const writeRun = () => writeJson(path.join(f.session, '.state', 'diagnostics', 'run.json'), {
      capture: {state: 'completed', start: 1500, end: 1600}, phases: [{key: 'review-run-plan', name: 'plan review'}],
      invocations: [{phase: 'review-run-plan', subject, attempt: 1, provider: 'claude', model: 'm', surface: 'cli', launched: true, outcome: 'ok'}], reviews: [],
    });
    assert.equal(await main(['diagnostics', 'render', '--session', f.session], f.deps), 0);
    assert.equal(reads, 1);
    assert.match(fs.readFileSync(path.join(f.session, 'diagnostics.md'), 'utf8'), new RegExp(`\\| subject ${label} \\| 1 \\| — \\| — \\| — \\|`));

    writeRun();
    f.lines.splice(0);
    assert.equal(await main(['diagnostics', 'render', '--session', f.session], f.deps), 0);
    assert.equal(reads, 3);
    assert.match(fs.readFileSync(path.join(f.session, 'diagnostics.md'), 'utf8'), new RegExp(`\\| subject ${label} \\| 1 \\| 1: review-run-plan 1 \\| 15 \\| 1 \\|`));
  } finally { f.cleanup(); }
});

test('round turns: renders observed turns and flags only plan and design rounds over budget', () => {
  const f = sessionFixture({memory: true});
  try {
    const text = fs.readFileSync(writeDiagnostics(f.session, {
      outcome: 'complete', phases: [], invocations: [], reviews: [],
      roundWorkload: [
        {review: 'review-aaaaaaaaaaaaaaaa', kind: 'plan', round: 1, calls: {total: 6, phases: []}, hostTurns: 26},
        {review: 'review-bbbbbbbbbbbbbbbb', kind: 'design', round: 2, calls: {total: 6, phases: []}},
        {review: 'review-cccccccccccccccc', kind: 'code', round: 3, calls: {total: 7, phases: []}, hostTurns: 30},
      ],
    }), 'utf8');
    for (const row of [
      '| subject aaaaaaaaaaaaaaaa | 1 | 6 | — | 26 |',
      '| subject bbbbbbbbbbbbbbbb | 2 | 6 | — | — |',
      '| subject cccccccccccccccc | 3 | 7 | — | 30 |',
    ]) assert.ok(text.includes(row), row);
    const budget = text.split('\n').find(line => line.startsWith('Advisory budget'));
    assert.equal(budget, 'Advisory budget (lightweight fix review): <=6 toolkit calls, <=25 host turns; over: subject aaaaaaaaaaaaaaaa round 1');
  } finally { f.cleanup(); }
});

test('round turns: renders code review workloads without the advisory budget', () => {
  const f = sessionFixture({memory: true});
  try {
    const text = fs.readFileSync(writeDiagnostics(f.session, {
      outcome: 'complete', phases: [], invocations: [], reviews: [],
      roundWorkload: [{review: 'review-cccccccccccccccc', kind: 'code', round: 1, calls: {total: 7, phases: []}, hostTurns: 30}],
    }), 'utf8');
    assert.match(text, /\| subject cccccccccccccccc \| 1 \| 7 \| — \| 30 \|/);
    assert.doesNotMatch(text, /Advisory budget per round/);
  } finally { f.cleanup(); }
});
