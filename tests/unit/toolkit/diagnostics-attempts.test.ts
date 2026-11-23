import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { observeTool, optionalDiagnostics, readReviews, sessionFacts, writeDiagnostics } from '../../../skills/dispatch/scripts/toolkit/diagnostics.ts';
import { heuristics, normalizeUsage } from '../../../skills/dispatch/scripts/toolkit/domain/diagnostics.ts';
import { fanOut } from '../../../skills/dispatch/scripts/toolkit/fanout.ts';
import { readDelegateSession } from '../../../skills/dispatch/scripts/lib/usage/delegate.ts';
import { memoryFs } from '../lib/usage/helpers/memory-fs.ts';
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

test('OpenCode lifecycle steps survive failure without private data', async () => {
 const f=sessionFixture({ memory: true });try {
 const skill=path.join(f.root,'skill');fs.mkdirSync(skill);fs.writeFileSync(path.join(skill,'config.jsonc'),'{"diagnostics":true}');f.deps.skillRoot=skill;
 const step=(name:string,elapsedMs:number,budgetMs:number,outcome:string)=>({step:name,elapsedMs,budgetMs,outcome});
 const kept=[step('debug-config',12,5000,'ok'),step('prepare',3,400,'failed'),step('response',400,400,'timeout'),step('teardown',900,2000,'unconfirmed')];
 const rejected=[step('prepare',1,1,'ok'),step('debug-agents',-1,5,'ok'),step('debug-agents',1.5,5,'ok'),step('debug-agents',1,2147483648,'ok'),step('custom',1,1,'ok'),step('debug-agents',1,2,'C:\private\path'),{...step('debug-agents',1,2,'failed'),detail:'/home/private/secret'}];
 const seen:Record<string,unknown>={};
 f.deps.delegate=async(provider,request)=>{
  seen[provider]=request.collectLifecycle;
  throw Object.assign(new Error('private error'),{invocations:[{provider,model:'m',mode:'cli',launched:true,outcome:'timeout',lifecycleSteps:[...kept,...rejected]}]});
 };
 const observer=observeTool(f.session,'ask','run',undefined,f.deps)!;
 for(const provider of ['opencode','claude'] as const)await assert.rejects(observer.deps.delegate(provider,{logPath:path.join(f.session,'logs',provider+'[0].log')} as never,'cli'));
 assert.deepEqual(seen,{opencode:true,claude:undefined},'only OpenCode collects lifecycle steps');
 const facts=sessionFacts(f.session,{records:[],lastSeq:0,torn:null},'complete');
 assert.deepEqual(facts.invocations.map(i=>i.lifecycleSteps),[kept,kept],'failed launches keep only bounded, unique, allowlisted steps');
 const directory=path.join(f.session,'.state','diagnostics');
 assert.doesNotMatch(fs.readdirSync(directory).map(file=>fs.readFileSync(path.join(directory,file),'utf8')).join(''),/private|secret|detail/);
 } finally {f.cleanup();}
});

test('nudge marker persists only for boolean resume launches', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill');
    fs.mkdirSync(skill);
    writeJson(path.join(skill, 'config.jsonc'), {diagnostics: true});
    f.deps.skillRoot = skill;
    f.deps.delegate = async () => ({
      outcome: {status: 'ok', text: 'answer', resume: null, sessionId: null},
      invocations: [
        {provider: 'codex', model: 'm', mode: 'cli', effort: null, launched: true, outcome: 'timeout', durationMs: 10},
        {provider: 'codex', model: 'm', mode: 'cli', effort: null, launched: true, outcome: 'ok', durationMs: 10, nudge: true},
      ],
    });
    const observer = observeTool(f.session, 'ask', 'run', undefined, f.deps)!;
    const dir = path.join(f.session, 'work');
    await observer.deps.delegate('codex', {logPath: path.join(dir, 'logs', 'codex[0].log')} as never, 'cli');
    observer.finish({ok: true, exit: 0, summary: 'done', value: null});
    const facts = sessionFacts(f.session, {records: [], lastSeq: 0, torn: null}, 'complete');
    assert.equal(facts.invocations.length, 2);
    assert.equal((facts.invocations[1] as Record<string, unknown>)['nudge'], true);
    const report = fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8');
    assert.match(report, / · nudge/);
  } finally { f.cleanup(); }
  const g = sessionFixture({ memory: true });
  try {
    captureRuns(g.session, [
      {phase: 'plan-review', attempt: 1, provider: 'codex', model: 'm', mode: 'cli', surface: 'cli', launched: true, outcome: 'ok', slot: 'codex[0]', subject: 'aaaaaaaaaaaaaaaa', nudge: 'yes'},
      {phase: 'plan-review', attempt: 2, provider: 'codex', model: 'm', mode: 'cli', surface: 'cli', launched: true, outcome: 'ok', slot: 'codex[0]', subject: 'aaaaaaaaaaaaaaaa', nudge: 1},
    ]);
    const facts = sessionFacts(g.session, {records: [], lastSeq: 0, torn: null} as Fold, 'complete');
    assert.ok(facts.invocations.every((i) => !('nudge' in i)));
    const report = fs.readFileSync(writeDiagnostics(g.session, facts), 'utf8');
    assert.doesNotMatch(report, / · nudge/);
  } finally { g.cleanup(); }
});

test('nudge: recovered stalls yield no waste finding', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const subject = 'aaaaaaaaaaaaaaaa';
    captureRuns(f.session, [
      {...attempt(subject, {slot: 'codex[0]', provider: 'codex', model: 'm', attempt: 1, outcome: 'timeout'})},
      {...attempt(subject, {slot: 'codex[0]', provider: 'codex', model: 'm', attempt: 2, outcome: 'ok'}), nudge: true},
      {...attempt(subject, {slot: 'codex[1]', provider: 'codex', model: 'm', attempt: 1, outcome: 'timeout'})},
      {...attempt(subject, {slot: 'codex[1]', provider: 'codex', model: 'm', attempt: 2, outcome: 'ok'}), nudge: true},
    ]);
    const facts = sessionFacts(f.session, {records: [], lastSeq: 0, torn: null} as Fold, 'complete');
    assert.deepEqual(heuristics(facts).filter((finding) => finding.source === 'H1'), [], 'two recovered stalls');
  } finally { f.cleanup(); }
  const g = sessionFixture({ memory: true });
  try {
    const subject = 'bbbbbbbbbbbbbbbb';
    captureRuns(g.session, [
      {...attempt(subject, {slot: 'codex[0]', provider: 'codex', model: 'm', attempt: 1, outcome: 'timeout'})},
      {...attempt(subject, {slot: 'codex[0]', provider: 'codex', model: 'm', attempt: 2, outcome: 'ok'}), nudge: true},
      {...attempt(subject, {slot: 'codex[1]', provider: 'codex', model: 'm', attempt: 1, outcome: 'timeout'})},
    ]);
    const facts = sessionFacts(g.session, {records: [], lastSeq: 0, torn: null} as Fold, 'complete');
    assert.deepEqual(heuristics(facts).filter((finding) => finding.source === 'H1'), [], 'one recovered stall plus one unrelated failure');
  } finally { g.cleanup(); }
});

test('nudge: waste counts a recovered stall exactly', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const subject = 'cccccccccccccccc';
    captureRuns(f.session, [
      {...attempt(subject, {slot: 'codex[0]', provider: 'codex', model: 'm', attempt: 1, outcome: 'timeout'})},
      {...attempt(subject, {slot: 'codex[0]', provider: 'codex', model: 'm', attempt: 2, outcome: 'ok'}), nudge: true, validationOutcome: 'timeout'},
    ]);
    const facts = sessionFacts(f.session, {records: [], lastSeq: 0, torn: null} as Fold, 'complete');
    const findings = heuristics(facts).filter((finding) => finding.source === 'H1');
    assert.equal(findings.length, 1, 'failed validation on ok resume still yields waste');
    assert.match(findings[0]!.evidence, /`timeout`: 2 of 2 CLI attempts failed/);
  } finally { f.cleanup(); }
  const g = sessionFixture({ memory: true });
  try {
    const subject = 'dddddddddddddddd';
    captureRuns(g.session, [
      {...attempt(subject, {slot: 'codex[0]', provider: 'codex', model: 'model-a', attempt: 1, outcome: 'timeout'})},
      {...attempt(subject, {slot: 'codex[0]', provider: 'codex', model: 'model-a', attempt: 2, outcome: 'timeout'})},
      {...attempt(subject, {slot: 'codex[0]', provider: 'codex', model: 'model-b', attempt: 3, outcome: 'timeout'})},
      {...attempt(subject, {slot: 'codex[0]', provider: 'codex', model: 'model-b', attempt: 4, outcome: 'ok'}), nudge: true},
    ]);
    const facts = sessionFacts(g.session, {records: [], lastSeq: 0, torn: null} as Fold, 'complete');
    const findings = heuristics(facts).filter((finding) => finding.source === 'H1');
    assert.equal(findings.length, 1, 'unrelated failures of another model');
    assert.match(findings[0]!.evidence, /`timeout`: 2 of 4 CLI attempts failed/);
  } finally { g.cleanup(); }
});

test('diagnostics resume chain leaves waste only without a successful end', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const subject = 'eeeeeeeeeeeeeeee';
    captureRuns(f.session, [
      {...attempt(subject, {slot: 'codex[0]', provider: 'codex', model: 'm', attempt: 1, outcome: 'timeout'})},
      {...attempt(subject, {slot: 'codex[0]', provider: 'codex', model: 'm', attempt: 2, outcome: 'timeout'}), nudge: true},
      {...attempt(subject, {slot: 'codex[0]', provider: 'codex', model: 'm', attempt: 3, outcome: 'timeout'}), nudge: true},
      {...attempt(subject, {slot: 'codex[0]', provider: 'codex', model: 'm', attempt: 4, outcome: 'ok'}), nudge: true},
    ]);
    const facts = sessionFacts(f.session, {records: [], lastSeq: 0, torn: null} as Fold, 'complete');
    assert.deepEqual(heuristics(facts).filter((finding) => finding.source === 'H1'), [], 'two failed resumes absorbed by a third');
    const report = fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8');
    assert.equal((report.match(/ · nudge/g) ?? []).length, 3, 'every resume launch is marked');
  } finally { f.cleanup(); }
  const g = sessionFixture({ memory: true });
  try {
    const subject = 'ffffffffffffffff';
    captureRuns(g.session, [
      {...attempt(subject, {slot: 'codex[0]', provider: 'codex', model: 'm', attempt: 1, outcome: 'timeout'})},
      {...attempt(subject, {slot: 'codex[0]', provider: 'codex', model: 'm', attempt: 2, outcome: 'timeout'}), nudge: true},
      {...attempt(subject, {slot: 'codex[0]', provider: 'codex', model: 'm', attempt: 3, outcome: 'timeout'}), nudge: true},
    ]);
    const facts = sessionFacts(g.session, {records: [], lastSeq: 0, torn: null} as Fold, 'complete');
    const findings = heuristics(facts).filter((finding) => finding.source === 'H1');
    assert.equal(findings.length, 1);
    assert.match(findings[0]!.evidence, /`timeout`: 3 of 3 CLI attempts failed/);
  } finally { g.cleanup(); }
});

test('attempt rows persist once across callback and launch failure', async () => {
  const f=sessionFixture({memory:true});try {
   const skill=path.join(f.root,'skill');fs.mkdirSync(skill);writeJson(path.join(skill,'config.jsonc'),{diagnostics:true});f.deps.skillRoot=skill;
   f.deps.delegate=async (_provider,request)=>{
    const row={provider:'claude' as const,model:'m',effort:null,mode:'cli' as const,launched:true,outcome:'ok'};
    request.onInvocation?.(row);
    const facts=sessionFacts(f.session,{records:[],lastSeq:0,torn:null},'complete');
    assert.equal(facts.invocations.length,1);
    return {outcome:{status:'ok',text:'answer',resume:null,sessionId:null},invocations:[row]};
   };
   const observer=observeTool(f.session,'ask','run',undefined,f.deps)!;
   await observer.deps.delegate('claude',{logPath:path.join(f.session,'logs','claude[0].log')} as never,'cli');
   assert.equal(sessionFacts(f.session,{records:[],lastSeq:0,torn:null},'complete').invocations.length,1);
  }finally{f.cleanup();}
  const g=sessionFixture({memory:true});try {
   const skill=path.join(g.root,'skill');fs.mkdirSync(skill);writeJson(path.join(skill,'config.jsonc'),{diagnostics:true});g.deps.skillRoot=skill;
   const row={provider:'claude' as const,model:'m',effort:null,mode:'cli' as const,launched:false,outcome:'launch-failed'};
   g.deps.delegate=async (_provider,request)=>{request.onInvocation?.(row);throw Object.assign(new Error('launch'),{invocations:[row]});};
   const observer=observeTool(g.session,'ask','run',undefined,g.deps)!;
   await assert.rejects(observer.deps.delegate('claude',{logPath:path.join(g.session,'logs','claude[0].log')} as never,'cli'),/launch/);
   assert.equal(sessionFacts(g.session,{records:[],lastSeq:0,torn:null},'complete').invocations.length,1);
  }finally{g.cleanup();}
});

test('the first persisted row keeps its preflight lifecycle steps', async t => {
 const f=sessionFixture({memory:true});try {
  const skill=path.join(f.root,'skill');fs.mkdirSync(skill);writeJson(path.join(skill,'config.jsonc'),{diagnostics:true});f.deps.skillRoot=skill;
  const {nodeDeps}=await import('../../../skills/dispatch/scripts/toolkit/cli.ts');
  const {nodeProcess}=await import('../../../skills/dispatch/scripts/providers/node-process.ts');
  t.mock.method(fs,'existsSync',()=>true);
  const stat=fs.statSync;t.mock.method(fs,'statSync',((...args:Parameters<typeof fs.statSync>)=>{try{return stat(...args);}catch{return {isFile:()=>true,mode:0o755} as ReturnType<typeof fs.statSync>;}}) as typeof fs.statSync);
  t.mock.method(nodeProcess,'start',()=>({pid:50,done:Promise.resolve({exit:2,signal:null,stdout:'',stdoutPath:'/unused',stderrTail:'permission denied',durationMs:1,timedOut:false,truncated:false})}));
  t.mock.method(nodeProcess as Required<typeof nodeProcess>,'settleGroup',async()=>true);
  const native=nodeDeps();f.deps.delegate=native.delegate;
  const observer=observeTool(f.session,'ask','run',undefined,f.deps)!;
  const result=await observer.deps.delegate('opencode',{promptPath:'/unused',model:null,effort:null,sandbox:false,schemaPath:null,resume:null,cwd:f.root,timeoutMs:60000,outputCapBytes:1000,attachments:[],logPath:path.join(f.session,'logs','opencode[0].log'),briefPath:'/unused'},'cli');
  const facts=sessionFacts(f.session,{records:[],lastSeq:0,torn:null},'complete');
  assert.ok(result.invocations[0]?.lifecycleSteps?.length);
  assert.deepEqual(facts.invocations[0]?.lifecycleSteps,result.invocations[0]?.lifecycleSteps);
 }finally{t.mock.restoreAll();f.cleanup();}
});

test('attempt persistence retries a failed write without repeating successful writes', async t => {
 const f=sessionFixture({memory:true});try {
  const skill=path.join(f.root,'skill');fs.mkdirSync(skill);writeJson(path.join(skill,'config.jsonc'),{diagnostics:true});f.deps.skillRoot=skill;
  const observer=observeTool(f.session,'ask','run',undefined,f.deps)!;
  const rename=fs.renameSync;let writes=0,fail=true;
  t.mock.method(fs,'renameSync',((from:fs.PathLike,to:fs.PathLike)=>{if(String(to).endsWith('.json')&&!String(to).endsWith('.failure.json')){writes++;if(fail){fail=false;throw new Error('storage');}}return rename(from,to);}) as typeof fs.renameSync);
  const row={provider:'claude' as const,model:'m',effort:null,mode:'cli' as const,launched:true,outcome:'ok',startMs:0,endMs:30};
  f.deps.delegate=async (_provider,request)=>{request.onInvocation?.(row);return {outcome:{status:'ok',text:'answer',resume:null,sessionId:null},invocations:[row]};};
  await observer.deps.delegate('claude',{logPath:path.join(f.session,'logs','claude[0].log')} as never,'cli');
  assert.equal(writes,2,'return retries failed callback persistence');
  assert.deepEqual(sessionFacts(f.session,{records:[],lastSeq:0,torn:null},'complete').invocations.map(i=>[i.startMs,i.endMs]),[[0,30]]);
  writes=0;
  const second={...row};f.deps.delegate=async (_provider,request)=>{request.onInvocation?.(second);return {outcome:{status:'ok',text:'answer',resume:null,sessionId:null},invocations:[second]};};
  await observer.deps.delegate('claude',{logPath:path.join(f.session,'logs','claude[0].log')} as never,'cli');
  assert.equal(writes,1,'return does not repeat successful callback persistence');
 }finally{t.mock.restoreAll();f.cleanup();}
});

test('capture reread retains selected usage sources and rejects legacy failed zero', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill');
    writeJson(path.join(skill, 'config.jsonc'), { diagnostics: true });
    f.deps.skillRoot = skill;
    const invocation = { provider: 'claude', effort: null, mode: 'cli', launched: true } as const;
    const usage = { input: 0, output: 0, scope: 'invocation', inputSemantics: 'uncached' } as const;
    const rows = [
      { ...invocation, model: 'event-zero', outcome: 'quota' as const, usage: { ...usage, provenance: 'session' } },
      { ...invocation, model: 'fallback', outcome: 'ok' as const, usage: { ...usage, input: 3, provenance: 'stdout' }, coverage: ['transcript unavailable', 'invalid counters'] as ('transcript unavailable' | 'invalid counters')[] },
    ];
    f.deps.delegate = async (_provider, request) => {
      rows.forEach((row) => request.onInvocation?.(row));
      return { outcome: { status: 'ok', text: 'answer', resume: null, sessionId: null }, invocations: rows };
    };
    const observer = observeTool(f.session, 'ask', 'run', undefined, f.deps)!;
    await observer.deps.delegate('claude', { logPath: path.join(f.session, 'logs', 'claude[0].log') } as never, 'cli');
    observer.finish({ ok: true, exit: 0, summary: 'done', value: null });
    const legacy = { ...invocation, surface: 'cli', outcome: 'quota' };
    captureRuns(f.session, [
      { ...legacy, model: 'legacy-zero', usage: { input: 0, output: 0 }, coverage: ['transcript unavailable'] },
      { ...legacy, model: 'legacy-nonzero', usage: { input: 2, output: 0 }, usageSource: 'private-source' },
    ]);
    const observed = sessionFacts(f.session, { records: [], lastSeq: 0, torn: null }, 'complete').invocations;
    assert.deepEqual(observed.map((row) => [row.model, row.usage?.input, row.usageSource, row.coverage]).sort(), [
      ['event-zero', 0, 'session', undefined],
      ['fallback', 3, 'stdout', ['transcript unavailable', 'invalid counters']],
      ['legacy-nonzero', 2, undefined, undefined],
      ['legacy-zero', undefined, undefined, ['transcript unavailable', 'unverified zero']],
    ]);
  } finally { f.cleanup(); }
});

test('response evidence retains verified aliases across captures and distinguishes zero from unknown', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill');
    writeJson(path.join(skill, 'config.jsonc'), { diagnostics: true });
    f.deps.skillRoot = skill;
    const event = (id: string, at: number) => JSON.stringify({
      type: 'assistant', timestamp: new Date(at).toISOString(),
      message: { id, model: 'm', usage: { input_tokens: 42, output_tokens: 1 } },
    });
    const first = 'private-session-one';
    const second = 'private-session-two';
    const files = memoryFs({
      ['/home/.claude/projects/-repo/' + first + '.jsonl']: [event('private-event', 12), event('private-event', 22)].join('\n'),
      ['/home/.claude/projects/-repo/' + second + '.jsonl']: event('private-event-two', 12),
    });
    for (const [sessionId, startMs, endMs, resumed, model] of [
      [first, 0, 20, false, 'first'], [first, 21, 30, true, 'resume'], [second, 0, 20, false, 'other'],
    ] as const) {
      // Read the first capture before its streaming update is available.
      const usageFs = model === 'first' ? memoryFs({ ['/home/.claude/projects/-repo/' + first + '.jsonl']: event('private-event', 12) }) : files;
      const { responses } = readDelegateSession({
        platform: 'claude', collectResponses: true, sessionId, startMs, endMs, resumed, home: '/home',
        env: () => undefined, cwd: '/repo', fs: usageFs, budget: { remaining: 1024 },
      });
      assert.ok(responses?.length);
      f.deps.delegate = async () => ({
        outcome: { status: 'ok', text: 'answer', resume: null, sessionId: null },
        invocations: [{ provider: 'claude', effort: null, mode: 'cli', launched: true, model, outcome: 'ok', responses }],
      });
      const observer = observeTool(f.session, 'ask', 'run', undefined, f.deps)!;
      await observer.deps.delegate('claude', { logPath: path.join(f.session, 'logs', 'claude[0].log') } as never, 'cli');
      observer.finish({ ok: true, exit: 0, summary: 'done', value: null });
    }
    const legacy = { provider: 'claude', model: 'legacy', launched: true, outcome: 'ok' };
    captureRuns(f.session, [legacy, { ...legacy, model: 'unsafe', responses: [
      { stage: 'ask', role: 'delegate', agent: first, basis: 'claude-assistant-message', coverage: 'complete', observed: 9 },
      { stage: 'ask', role: 'delegate', basis: 'unavailable', coverage: 'unknown', observed: 0 },
    ] }]);
    const observed = new Map(sessionFacts(f.session, { records: [], lastSeq: 0, torn: null }, 'complete').invocations.map(row => [row.model, row.responses?.[0]]));
    const agent = observed.get('first')?.agent;
    assert.match(agent ?? '', /^delegate-[a-f0-9]{16}$/);
    assert.notEqual(observed.get('other')?.agent, agent);
    assert.deepEqual(observed.get('first'), {
      stage: 'ask', role: 'delegate', agent, basis: 'claude-assistant-message', coverage: 'complete', observed: 1, uncachedInput: 42,
    });
    assert.deepEqual(observed.get('resume'), { ...observed.get('first'), observed: 0, uncachedInput: 0 });
    assert.equal(observed.get('legacy'), undefined);
    assert.equal(observed.get('unsafe'), undefined);
    const directory = path.join(f.session, '.state', 'diagnostics');
    for (const file of fs.readdirSync(directory).filter(name => name !== 'run-1.json')) {
      assert.doesNotMatch(fs.readFileSync(path.join(directory, file), 'utf8'), /private-session|private-event/);
    }
  } finally { f.cleanup(); }
});

test('agy delegate invocations render resolved model and effort in diagnostics report', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill');
    fs.mkdirSync(skill);
    writeJson(path.join(skill, 'config.jsonc'), { diagnostics: true });
    f.deps.skillRoot = skill;

    const turnInit = buildGenMetadataBlob({
      input: 100, output: 20, cacheRead: 50, reasoning: 10,
      modelSlug: 'gemini-4-argon-trial', displayName: 'Gemini 4 Argon (Medium)', lastStepIndex: 1,
    });
    const turnResume = buildGenMetadataBlob({
      input: 150, output: 30, cacheRead: 60, reasoning: 15,
      modelSlug: 'gemini-3.8-flash-tiered', displayName: 'Gemini 3.8 Flash (High)', lastStepIndex: 5,
    });

    const context = {
      appDataDir: '/home/.gemini/antigravity-cli',
      readSqliteGenMetadata: (file: string) => file.includes('conv-init') ? [turnInit] : [turnInit, turnResume],
    };

    const stdoutInit = JSON.stringify({ conversation_id: 'conv-init', usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 50, thinking_tokens: 10 } });
    const stdoutResume = JSON.stringify({ conversation_id: 'conv-resume', usage: { input_tokens: 250, output_tokens: 50, cache_read_tokens: 110, thinking_tokens: 25 } });

    const usageInit = agy.usage?.(stdoutInit, context as never);
    const usageResume = agy.usage?.(stdoutResume, context as never);

    f.deps.delegate = async (_provider, request) => {
      const isResume = Boolean(request.resume);
      const usage = isResume ? usageResume : usageInit;
      const row = {
        provider: 'agy' as const,
        model: usage?.actualModels?.[0] ?? request.model,
        effort: usage?.actualEffort !== undefined ? usage.actualEffort : request.effort,
        mode: 'cli' as const,
        launched: true,
        outcome: 'ok',
        ...(isResume ? { nudge: true as const } : {}),
        ...(usage ? { usage } : {}),
      };
      request.onInvocation?.(row);
      return { outcome: { status: 'ok', text: 'answer', resume: null, sessionId: null }, invocations: [row] };
    };

    const observer = observeTool(f.session, 'ask', 'run', undefined, f.deps)!;
    const dir = path.join(f.session, 'work');
    await observer.deps.delegate('agy', { promptPath: '/p.md', model: 'launch-m1', effort: 'low', sandbox: false, schemaPath: null, resume: null, cwd: f.root, timeoutMs: 5000, outputCapBytes: 100, attachments: [], logPath: path.join(dir, 'logs', 'agy[0].log'), briefPath: '/b.md' } as never, 'cli');
    await observer.deps.delegate('agy', { promptPath: '/p.md', model: 'launch-m2', effort: 'low', sandbox: false, schemaPath: null, resume: 'conv-1', cwd: f.root, timeoutMs: 5000, outputCapBytes: 100, attachments: [], logPath: path.join(dir, 'logs', 'agy[0].log'), briefPath: '/b.md' } as never, 'cli');
    observer.finish({ ok: true, exit: 0, summary: 'done', value: null });

    const fold = { records: [], lastSeq: 0, torn: null } as Fold;
    const facts = sessionFacts(f.session, fold, 'complete');
    assert.equal(facts.invocations.length, 2);

    const reportPath = writeDiagnostics(f.session, facts);
    const report = fs.readFileSync(reportPath, 'utf8');

    // Tokens by stage should render resolved models without (configured)
    assert.match(report, /### Tokens by stage/);
    assert.match(report, /^\| ask \| agy \| delegate \| gemini-4-argon \| medium \|/m);
    assert.match(report, /^\| ask \| agy \| delegate \| gemini-3.8-flash \| high \|/m);
    assert.doesNotMatch(report, /gemini-4-argon \(configured\)/);
    assert.doesNotMatch(report, /gemini-3.8-flash \(configured\)/);

    // Appendix should render reportedModels
    assert.match(report, /gemini-4-argon \(reported: gemini-4-argon\)/);
  } finally {
    f.cleanup();
  }
});

test('coverage list: observeTool preserves coverage list for copilot', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill');
    fs.mkdirSync(skill);
    writeJson(path.join(skill, 'config.jsonc'), { diagnostics: true });
    f.deps.skillRoot = skill;
    f.deps.delegate = async (_provider, request) => {
      const row = { provider: 'copilot' as const, model: 'auto', mode: 'cli' as const, effort: null, launched: true, outcome: 'ok', coverage: ['no usage' as const] };
      request.onInvocation?.(row);
      return { outcome: { status: 'ok', text: 'ok', resume: null, sessionId: null }, invocations: [row] };
    };
    const observer = observeTool(f.session, 'ask', 'run', undefined, f.deps)!;
    await observer.deps.delegate('copilot', { promptPath: '/p.md', model: 'auto', effort: null, sandbox: false, schemaPath: null, resume: null, cwd: f.root, timeoutMs: 5000, outputCapBytes: 100, attachments: [], logPath: path.join(f.session, 'work', 'logs', 'copilot[0].log'), briefPath: '/b.md' } as never, 'cli');
    observer.finish({ ok: true, exit: 0, summary: 'done', value: null });
    const facts = sessionFacts(f.session, { records: [], lastSeq: 0, torn: null }, 'complete');
    assert.deepEqual(facts.invocations[0]?.coverage, ['no usage']);
  } finally {
    f.cleanup();
  }
});

test('review timing joins current generation and reserve attempts', async () => {
 const f=sessionFixture({memory:true}); try {
  const skill=path.join(f.root,'skill'); fs.mkdirSync(skill); writeJson(path.join(skill,'config.jsonc'),{diagnostics:true}); f.deps.skillRoot=skill;
  saveRound({session:f.session,review:'plan-a',round:1,generation:2,roster:[rosterSlot('codex[0]','codex'),rosterSlot('claude[0]','claude',{reserve:true})],outcomes:[]});
  saveRound({session:f.session,review:'plan-a',round:2,roster:[rosterSlot('codex[0]','codex'),rosterSlot('native[0]','native',{native:true})],outcomes:[]});
  f.deps.delegate=async()=>({outcome:{status:'ok',text:'ok',resume:null,sessionId:null},invocations:[{provider:'claude',model:'m',mode:'cli',effort:null,launched:true,outcome:'ok',startMs:0,endMs:30},{provider:'claude',model:'m',mode:'cli',effort:null,launched:false,outcome:'launch-failed',startMs:1,endMs:99}]});
  const observer=observeTool(f.session,'review','run','plan',f.deps)!;
  const generation=path.join(f.session,'.state','reviews','plan-a','round-1','gen-2');
  await observer.deps.delegate('claude',{logPath:path.join(generation,'logs','claude[0].log'),targetSlot:'codex[0]'} as never,'cli');
  observer.deps.diagnostics!({kind:'routing',subject:generation,slot:'claude[0]',targetSlot:'codex[0]',attempt:1,state:'reserve'});
  await observer.deps.delegate('claude',{logPath:path.join(f.session,'.state','reviews','plan-a','round-1','gen-1','logs','codex[0].log')} as never,'cli');
  observer.deps.diagnostics!({kind:'native',subject:path.join(f.session,'.state','reviews','plan-a','round-1','gen-1'),slot:'codex[0]',provider:'native',attempt:1,state:'failed'});
  await observer.deps.delegate('claude',{logPath:path.join(f.session,'.state','reviews','plan-a','round-2','gen-1','logs','codex[0].log')} as never,'cli');
  await observer.deps.delegate('claude',{logPath:path.join(f.session,'.state','reviews','plan-a','round-2','gen-1','logs','claude[0].log'),targetSlot:'native[0]'} as never,'cli');
  observer.deps.diagnostics!({kind:'native',subject:path.join(f.session,'.state','reviews','plan-a','round-2','gen-1'),slot:'native[0]',provider:'native',attempt:1,state:'failed'});
  observer.finish({ok:true,exit:0,summary:'done',value:null});
  const facts=sessionFacts(f.session,{records:[],lastSeq:0,torn:null} as Fold,'complete');
  assert.deepEqual(facts.roundTiming?.[1]?.slots,[{slot:'codex[0]',attempts:[{surface:'cli',startMs:0,endMs:30}]},{slot:'native[0]',attempts:[{surface:'cli',startMs:0,endMs:30},{surface:'native'}]}]);
  assert.deepEqual(facts.roundTiming?.[0]?.slots,[{slot:'codex[0]',attempts:[{surface:'cli',startMs:0,endMs:30}]}]);
 } finally {f.cleanup();}
});

test('native substitution preserves the legacy gap and the measured CLI span', () => {
 const f=sessionFixture({memory:true}); try {
  const roster=[rosterSlot('codex[0]','codex'),rosterSlot('claude[0]','claude')];
  for(const [round,outcome] of [[1,{slot:'codex[0]',state:'done',responder:{slot:'native[0]',provider:'native',model:null,native:true}}],[2,{slot:'codex[0]',state:'native'}]] as const) {
   saveRound({session:f.session,review:'plan-a',round,roster,outcomes:[outcome]});
  }
  captureRuns(f.session,[1,2].flatMap(round=>['codex[0]','claude[0]'].map(slot=>({...attempt(roundSubject(f.session,'plan-a',round),{slot,provider:'codex',model:'m',outcome:'timeout'}),startMs:0,endMs:1000}))));
  const facts=sessionFacts(f.session,{records:[],lastSeq:0,torn:null} as Fold,'complete');
  for(const round of facts.roundTiming!) assert.deepEqual(round.slots[0]!.attempts,[{surface:'cli',startMs:0,endMs:1000},{surface:'native'}]);
  const report=fs.readFileSync(writeDiagnostics(f.session,facts),'utf8');
  assert.match(report,/codex\[0\] \| — \| —/); assert.doesNotMatch(report,/✓/);
  assert.match(report,/\| 1 \| 1s \| codex\[0\] \|/);
 } finally {f.cleanup();}
});

test('failed native reserve remains unmeasured after terminal failure', () => {
 const f=sessionFixture({memory:true}); try {
  const skill=path.join(f.root,'skill'); fs.mkdirSync(skill); writeJson(path.join(skill,'config.jsonc'),{diagnostics:true}); f.deps.skillRoot=skill;
  const roster=[rosterSlot('codex[0]','codex'),rosterSlot('claude[0]','claude')];
  saveRound({session:f.session,review:'plan-a',round:1,roster,outcomes:[{slot:'codex[0]',state:'failed',cls:'refusal'}]});
  const subject=roundSubject(f.session,'plan-a',1);
  captureRuns(f.session,[{...attempt(subject,{slot:'codex[0]',provider:'codex',model:'m',outcome:'timeout'}),startMs:0,endMs:1000},{...attempt(subject,{slot:'claude[0]',provider:'claude',model:'m'}),startMs:0,endMs:5000}]);
  const observer=observeTool(f.session,'review','run','plan',f.deps)!;
  observer.deps.diagnostics!({kind:'native',subject:path.join(f.session,'.state','reviews','plan-a','round-1','gen-1'),slot:'codex[0]',provider:'native',attempt:1,state:'failed'});
  observer.finish({ok:true,exit:0,summary:'done',value:null});
  const facts=sessionFacts(f.session,{records:[],lastSeq:0,torn:null} as Fold,'complete');
  assert.deepEqual(facts.roundTiming?.[0]?.slots[0]?.attempts,[{surface:'cli',startMs:0,endMs:1000},{surface:'native'}]);
  const report=fs.readFileSync(writeDiagnostics(f.session,facts),'utf8');
  assert.match(report,/codex\[0\] \| — \| —/); assert.doesNotMatch(report,/✓/);
  assert.match(report,/\| 1 \| 5s \| claude\[0\] \|/);
 } finally {f.cleanup();}
});
