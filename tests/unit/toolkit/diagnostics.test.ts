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
import { claude } from '../../../skills/dispatch/scripts/providers/claude.ts';
import { agy } from '../../../skills/dispatch/scripts/providers/agy.ts';
import type { Fold } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import type { CliDeps } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
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

test('diagnostic storage failure preserves durable attempts and reports one bounded failure', async t => {
 const f=sessionFixture({ memory: true });try{
  const skill=path.join(f.root,'skill');fs.mkdirSync(skill);writeJson(path.join(skill,'config.jsonc'),{diagnostics:true});f.deps.skillRoot=skill;
  f.deps.delegate=async()=>({outcome:{status:'ok',text:'answer',resume:null,sessionId:null},invocations:[{provider:'claude',model:'m',effort:null,mode:'cli',launched:true,outcome:'ok'}]});
  const observer=observeTool(f.session,'ask','run',undefined,f.deps)!;
  const dir=path.join(f.session,'work');await observer.deps.delegate('claude',{logPath:path.join(dir,'logs','claude[0].log')} as never,'cli');
  const directory=path.join(f.session,'.state','diagnostics'),file=path.join(directory,fs.readdirSync(directory)[0]!);
  const previous=fs.readFileSync(file);const rename=fs.renameSync,write=fs.writeFileSync;
  t.mock.method(fs,'renameSync',((from:fs.PathLike,to:fs.PathLike)=>{if(String(to)===file)throw new Error('rename failure');return rename(from,to);}) as typeof fs.renameSync);
  t.mock.method(fs,'writeFileSync',((target:fs.PathOrFileDescriptor,...args:unknown[])=>{if(String(target)===file){write(file,'{partial');throw new Error('partial write');}return (write as (...args:any[])=>void)(target,...args);}) as typeof fs.writeFileSync);
  observer.deps.diagnostics!({kind:'routing',state:'stop',subject:dir,slot:'claude[0]',provider:'claude',model:'m',attempt:1});
  assert.deepEqual(fs.readFileSync(file),previous,'failed optional update cannot truncate the durable capture');
  const fold={records:[],lastSeq:0,torn:null};let facts=sessionFacts(f.session,fold,'complete');
  assert.equal(facts.invocations.length,1);assert.equal(facts.collection?.storageFailed,1);
  t.mock.restoreAll();observer.finish({ok:true,exit:0,summary:'done',value:null});facts=sessionFacts(f.session,fold,'complete');
  assert.equal(facts.invocations.length,1);assert.equal(facts.collection?.storageFailed,1,'capture and marker describe one storage failure');
 }finally{t.mock.restoreAll();f.cleanup();}
});

test('diagnostics persist unlaunched failures and CLI fallback consequences independently', async () => {
 const f=sessionFixture({ memory: true });try{
  const skill=path.join(f.root,'skill');fs.mkdirSync(skill);writeJson(path.join(skill,'config.jsonc'),{diagnostics:true});f.deps.skillRoot=skill;
  f.deps.modes=()=>[];
  const first=observeTool(f.session,'ask','run',undefined,f.deps)!;
  await fanOut({dir:path.join(f.session,'unlaunched'),slots:[rosterSlot('claude[0]','claude'),rosterSlot('codex[0]','codex',{native:true})],prompt:'question',validate:()=>({ok:true})},first.deps);
  first.finish({ok:false,exit:4,reason:'native-pending',summary:'pending',value:null});
  const fold={records:[],lastSeq:0,torn:null};let facts=sessionFacts(f.session,fold,'pending');
  const unlaunched=facts.invocations.find(i=>i.surface==='cli');
  assert.equal(unlaunched?.outcome,'not-found');assert.equal(unlaunched.launched,false);assert.equal(unlaunched.routingOutcome,'stop');assert.equal(unlaunched.slotState,'failed');assert.equal(unlaunched.usage,undefined);assert.equal(unlaunched.durationMs,undefined);
  assert.equal(facts.invocations.filter(i=>i.slot==='codex[0]').length,1,'configured native work does not fabricate a CLI row');
  f.deps.modes=()=>['cli'];
  const cooldown=observeTool(f.session,'ask','run',undefined,f.deps)!;
  await fanOut({dir:path.join(f.session,'cooldown'),slots:[rosterSlot('copilot[0]','copilot')],prompt:'question',validate:()=>({ok:true}),quota:{schemaVersion:1,policyVersion:1,decidedAt:0,decisions:[{key:{provider:'copilot',model:'model-a',mode:'cli'},generation:null,skipped:true,reason:'quota-cooldown'}]}},cooldown.deps);
  cooldown.finish({ok:false,exit:2,reason:'ask-failed',summary:'failed',value:null});
  const skipped=sessionFacts(f.session,fold,'pending').invocations.find(i=>i.provider==='copilot');
  assert.equal(skipped?.outcome,'quota');assert.equal(skipped?.launched,false);assert.equal(skipped?.routingOutcome,'stop');assert.equal(skipped?.slotState,'failed');
  f.deps.modes=()=>['cli'];f.deps.orchestrator={platform:'agy',model:null};
  f.deps.delegate=async()=>({outcome:{status:'fail',cls:'auth',detail:'private'},invocations:[{provider:'claude',model:'model-a',effort:null,mode:'cli',launched:true,outcome:'auth',durationMs:10}]});
  const second=observeTool(f.session,'ask','run',undefined,f.deps)!;
  await fanOut({dir:path.join(f.session,'fallback'),slots:[rosterSlot('claude[0]','claude')],prompt:'question',validate:()=>({ok:true})},second.deps);
  second.finish({ok:false,exit:2,reason:'ask-failed',summary:'failed',value:null});
  facts=sessionFacts(f.session,fold,'pending');
  const cli=facts.invocations.find(i=>i.launched);assert.equal(cli?.routingOutcome,'stop');assert.equal(cli?.slotState,'failed');
  const report=fs.readFileSync(writeDiagnostics(f.session,facts),'utf8');assert.match(report,/not-found.*routing stop.*slot failed.*not launched/);assert.match(report,/auth.*routing stop.*slot failed/);
 }finally{f.cleanup();}
});

test('diagnostics distinguish healthy observed captures from absent and damaged collection', async () => {
 const f=sessionFixture({ memory: true });try{
  const fold={records:[],lastSeq:0,torn:null};const render=()=>fs.readFileSync(writeDiagnostics(f.session,sessionFacts(f.session,fold,'complete')),'utf8');
  assert.match(render(),/Collection health: unknown/);
  const skill=path.join(f.root,'skill');fs.mkdirSync(skill);writeJson(path.join(skill,'config.jsonc'),{diagnostics:true});f.deps.skillRoot=skill;
  const observer=observeTool(f.session,'ask','run',undefined,f.deps)!;assert.match(render(),/Collection health: partial/);
  observer.finish({ok:true,exit:0,summary:'done',value:null});assert.match(render(),/Collection health: complete for observed captures/);
  assert.equal(sessionFacts(f.session,fold,'complete').collection?.completed,1);
  fs.writeFileSync(path.join(f.session,'.state','diagnostics','bad.json'),'{bad');assert.match(render(),/Collection health: partial/);
 }finally{f.cleanup();}
});

test('diagnostics aggregate subjects provenance and partial collection deterministically', async () => {
 const f=sessionFixture({ memory: true });try {
  const skill=path.join(f.root,'skill');fs.mkdirSync(skill);f.deps.skillRoot=skill;
  const fold={records:[],lastSeq:0,torn:null};let now=0;f.deps.clock=()=>now;
  for(const [version,concurrency] of [['1.2.3',2],['1.2.4',3]] as const){
   fs.writeFileSync(path.join(skill,'SKILL.md'),'skill '+version);writeJson(path.join(skill,'skill-hashes.json'),{$version:version});writeJson(path.join(skill,'config.jsonc'),{diagnostics:true,'write-concurrency':concurrency});
   const o=observeTool(f.session,'ask','run',undefined,f.deps)!;now+=1000;o.finish({ok:concurrency===2,exit:concurrency===2?0:4,reason:'native-pending',summary:'done',value:null});
  }
  const directory=path.join(f.session,'.state','diagnostics');const files=fs.readdirSync(directory);
  const captures=files.map(file=>JSON.parse(fs.readFileSync(path.join(directory,file),'utf8')));
  assert.deepEqual(captures.map(c=>c.version).sort(),['1.2.3','1.2.4']);assert.notEqual(captures[0].build,captures[1].build);
  for(const capture of captures) {
    const contentHash=crypto.createHash('sha256').update('skill '+capture.version).digest('hex');
    const build=crypto.createHash('sha256').update(JSON.stringify([['SKILL.md',contentHash]])).digest('hex').slice(0,12);
    assert.equal(capture.build,build,'stored build measures the collecting tree');
  }
  const nativeDir=path.join(f.session,'.state','asks','subject','attempt-1');
  for(const state of ['pending','completed','completed'] as const){
    const o=observeTool(f.session,'ask','run',undefined,f.deps)!;
    o.deps.diagnostics!({kind:'native',subject:nativeDir,slot:'codex[0]',provider:'codex',model:'m',attempt:state==='pending'?1:0,state,replay:state==='completed'});
    o.finish({ok:true,exit:0,summary:'done',value:null});
  }
  fs.writeFileSync(path.join(directory,'corrupt.json'),'{bad');writeJson(path.join(directory,'invalid.json'),null);writeJson(path.join(directory,'open.json'),{phases:[],invocations:[],reviews:[],capture:{state:'opened',start:0}});
  saveRound({session:f.session,review:'code-alpha',round:1,roster:[rosterSlot('codex[0]','codex',{native:true})],outcomes:[{slot:'codex[0]',state:'done'}],findings:[finding('F1',{recurrence:{of:'F0'}})]});
  saveRound({session:f.session,review:'plan-beta',round:1,roster:[],outcomes:[],findings:[]});
  const broken=path.join(f.session,'.state','reviews','bad','round-1','round.json');fs.mkdirSync(path.dirname(broken),{recursive:true});fs.writeFileSync(broken,'{bad');
  const facts=sessionFacts(f.session,fold,'complete');
  assert.equal(facts.provenance?.length,3);assert.deepEqual(facts.provenance?.filter(p=>p.version).map(p=>[p.version,p.config?.['write-concurrency']]).sort(),[['1.2.3',2],['1.2.4',3]]);
  assert.ok((facts.collection?.corrupt??0)>=3);assert.equal(facts.collection?.incomplete,1);
  assert.equal(facts.phases.find(p=>p.name==='ask')?.outcome,'mixed');
  assert.equal(facts.phases.find(p=>p.name==='ask')?.wallMs,2000);
  assert.equal(facts.invocations.filter(i=>i.surface==='native').length,2,'native replay and later completion share one logical slot');
  assert.ok(facts.invocations.filter(i=>i.surface==='native').every(i=>i.nativeState==='completed'&&!i.launched&&!i.usage));
  assert.equal(facts.retroState,'missing');writeJson(path.join(f.session,'.state','retro.json'),{});assert.equal(sessionFacts(f.session,fold,'complete').retroState,'invalid');
  fs.rmSync(path.join(f.session,'.state','retro.json'));fs.mkdirSync(path.join(f.session,'.state','retro.json'));assert.equal(sessionFacts(f.session,fold,'complete').retroState,'unreadable');
  assert.equal(facts.invocations.find(i=>i.surface==='native')?.nativeState,'completed');
  const report=fs.readFileSync(writeDiagnostics(f.session,facts),'utf8');assert.match(report,/code review/);assert.match(report,/plan review/);assert.match(report,/subject [a-f0-9]{16}/);assert.match(report,/unknown historical/);
  for(let i=0;i<files.length;i++)fs.renameSync(path.join(directory,files[i]!),path.join(directory,'shuffled-'+(files.length-i)+'.json'));
  assert.deepEqual(sessionFacts(f.session,fold,'complete').phases,facts.phases);
 }finally{f.cleanup();}
});

test('diagnostics detect toolkit rejection and writer relaunch evidence', async () => {
 const f=sessionFixture({ memory: true });try{
  const skill=path.join(f.root,'skill');fs.mkdirSync(skill);writeJson(path.join(skill,'config.jsonc'),{diagnostics:true});f.deps.skillRoot=skill;
  for(const reason of ['native-pending','approval-required','invalid-record','invalid-record'])observeTool(f.session,'record','append',undefined,f.deps)!.finish({ok:false,exit:4,reason,summary:'private',value:null});
  const records=[['A','launched','one'],['B','launched','two'],['A','launched','three']].map(([task,phase,key],n)=>({seq:n+1,key:key!,at:'2026-01-01T00:00:00Z',kind:'writer',by:'tool',data:{task,phase,path:key,base:{commit:'a'.repeat(40),seq:0,taskSection:'sha256:'+'b'.repeat(64)}}}));
  const fold={records:records.slice(0,2),lastSeq:2,torn:null} as Fold;
  assert.equal(sessionFacts(f.session,fold,'complete').relaunches,0);
  fold.records=records;fold.lastSeq=3;const facts=sessionFacts(f.session,fold,'complete');assert.equal(facts.relaunches,1);assert.deepEqual(facts.rejectedTools,[{tool:'record',action:'append',cls:'invalid-record'},{tool:'record',action:'append',cls:'invalid-record'}]);
  const report=fs.readFileSync(writeDiagnostics(f.session,facts),'utf8');assert.match(report,/toolkit operation.*rejected/);assert.doesNotMatch(report,/- Source: H9/);assert.match(report,/Writer relaunches observed: 1/);assert.equal(facts.verb,'implement');assert.equal(sessionFacts(f.session,{...fold,records:[]},'complete').verb,undefined);assert.doesNotMatch(report,/defective writer|private/);
 }finally{f.cleanup();}
});

test('session diagnostics include producer rounds, invocations, and gated retro findings', async () => {
  const fixture = sessionFixture({ memory: true });
  const empty = sessionFixture({ memory: true });
  try {
    const a = 'review-alpha';
    const first = [finding('F001'), finding('F002')];
    const reraised = [finding('F003', {recurrence: {of: 'F001'}}), finding('F004', {unresolved: {of: 'F002'}})];
    saveRound({
      session: fixture.session, review: a, round: 1,
      roster: [rosterSlot('claude[0]', 'claude'), rosterSlot('agy[0]', 'agy')],
      outcomes: [
        {slot: 'claude[0]', state: 'done', text: 'review complete'},
        {slot: 'agy[0]', state: 'failed', cls: 'timeout', reason: 'review timed out'},
      ],
      findings: first,
    });
    saveRound({
      session: fixture.session, review: a, round: 2,
      roster: [rosterSlot('claude[0]', 'claude'), rosterSlot('copilot[0]', 'copilot', {reserve: true})],
      outcomes: [
        {slot: 'claude[0]', state: 'failed', cls: 'config', reason: 'provider unavailable'},
        {slot: 'copilot[0]', state: 'done', text: 'reserve review complete'},
      ],
      findings: reraised,
    });
    saveRound({
      session: fixture.session, review: a, round: 3,
      roster: [rosterSlot('codex[0]', 'codex', {native: true})],
      outcomes: [{slot: 'codex[0]', state: 'native', promptPath: 'prompts/codex[0].md', replyPath: 'replies/codex[0].md'}],
    });
    saveRound({
      session: fixture.session, review: 'review-beta', round: 1,
      roster: [rosterSlot('agy[0]', 'agy'), rosterSlot('claude[0]', 'claude')],
      outcomes: [
        {slot: 'agy[0]', state: 'failed', cls: 'not-found', reason: 'provider missing'},
        {slot: 'claude[0]', state: 'failed', cls: 'timeout', reason: 'review timed out'},
      ],
    });
    const observations = [
      {id: 'retro-1', component: 'references/toolkit.md', category: 'correctness', evidence: 'One bounded observation.', impact: 'One review repeated work.', proposedFix: 'Use the prior ruling.'},
      {id: 'retro-2', component: 'outside-component.ts', category: 'correctness', evidence: 'Invalid component.', impact: 'Not dispatch owned.', proposedFix: 'No change.'},
    ];
    writeJson(path.join(fixture.session, '.state', 'retro.json'), observations);
    const fold = {
      records: [
        {seq: 1, key: 'ruling-1', at: '2026-01-01T00:00:00Z', kind: 'ruling', by: 'tool', data: {subject: 'review:review-alpha:F001', ruling: 'accepted', rationale: 'Matches the bound rules.'}},
        {seq: 2, key: 'ruling-2', at: '2026-01-01T00:00:01Z', kind: 'ruling', by: 'tool', data: {subject: 'review:review-alpha:F002', ruling: 'rejected', rationale: 'Outside the requirement.'}},
      ],
      lastSeq: 2, torn: null,
    } as Fold;

    const rounds = readReviews(fixture.session);
    assert.deepEqual(rounds.map((round) => [round.review, round.round]), [
      ['review-alpha', 1], ['review-alpha', 2], ['review-alpha', 3], ['review-beta', 1],
    ]);
    assert.equal(rounds[0]?.findings?.findings?.length, 2);
    assert.equal(rounds[2]?.findings, null);
    assert.equal(rounds[3]?.findings, null);

    const facts = sessionFacts(fixture.session, fold, 'pass');
    assert.deepEqual(facts.reviews, [
      {phase: facts.reviews[0]!.phase, round: 1, cap: 4, accepted: 1, rejected: 1, recurring: 0},
      {phase: facts.reviews[0]!.phase, round: 2, cap: 4, accepted: 0, rejected: 0, recurring: 2, reraised: ['F001', 'F002']},
    ]);
    assert.deepEqual(facts.observations, observations);
    assert.equal(facts.phases.length,2);
    assert.ok(facts.phases.every(p=>p.name==='code review'));
    assert.deepEqual(facts.rejectedTools, []);
    const invocations = [...facts.invocations].sort((left, right) => `${left.phase}:${left.slot}:${left.outcome}`.localeCompare(`${right.phase}:${right.slot}:${right.outcome}`));
    assert.deepEqual(invocations.map(({phase, slot, outcome, launched, surface}) => ({phase, slot, outcome, launched, surface})), [
      {phase:facts.reviews[0]!.phase!,slot:'codex[0]',outcome:'native-pending',launched:false,surface:'native'},
    ]);
    assert.equal(invocations[0]?.provider,'codex');

    const outputPath = writeDiagnostics(fixture.session, facts);
    assert.equal(path.basename(outputPath), 'diagnostics.md');
    const report = fs.readFileSync(outputPath, 'utf8');
    assert.ok(report.startsWith('# Dispatch diagnostics'));
    assert.match(report, /Host retro: collected · 1 accepted · 1 rejected/);
    assert.match(report, /Review convergence/);
    assert.match(report, /F001/);

    fs.writeFileSync(path.join(fixture.session, '.state', 'retro.json'), '{invalid');
    const malformedRetroFacts = sessionFacts(fixture.session, fold, 'pass');
    assert.equal('observations' in malformedRetroFacts, false);
    const malformedRetroPath = writeDiagnostics(fixture.session, malformedRetroFacts);
    assert.match(fs.readFileSync(malformedRetroPath, 'utf8'), /Host retro: malformed/);

    const emptyRounds = readReviews(empty.session);
    const emptyFacts = sessionFacts(empty.session, {records: [], lastSeq: 0, torn: null}, 'pass');
    assert.deepEqual(emptyRounds, []);
    assert.deepEqual(emptyFacts.reviews, []);
    assert.deepEqual(emptyFacts.invocations, []);
    const emptyPath = writeDiagnostics(empty.session, emptyFacts);
    assert.match(fs.readFileSync(emptyPath, 'utf8'), /Host retro: missing/);
  } finally {
    empty.cleanup();
    fixture.cleanup();
  }
});

test('review JSON errors identify malformed round, findings, and slot files', async () => {
  const malformedFile = [
    (session: string) => {
      const file = path.join(session, '.state', 'reviews', 'round-review', 'round-1', 'round.json');
      fs.mkdirSync(path.dirname(file), {recursive: true});
      return file;
    },
    (session: string) => {
      saveRound({session, review: 'findings-review', round: 1, roster: [], outcomes: []});
      return path.join(session, '.state', 'reviews', 'findings-review', 'round-1', 'findings.json');
    },
    (session: string) => {
      saveRound({
        session, review: 'slot-review', round: 1,
        roster: [rosterSlot('claude[0]', 'claude')],
        outcomes: [{slot: 'claude[0]', state: 'done', text: 'review complete'}],
      });
      return slotFile(path.join(session, '.state', 'reviews', 'slot-review'), 1, 'claude[0]');
    },
  ];

  for (const createPath of malformedFile) {
    const fixture = sessionFixture({ memory: true });
    try {
      const file = createPath(fixture.session);
      fs.writeFileSync(file, '{invalid');
      assert.throws(() => readReviews(fixture.session), (error: unknown) =>
        error instanceof ToolError && error.exit === 2 && error.reason === 'review-corrupt' && error.message.includes(file));
    } finally {
      fixture.cleanup();
    }
  }
});

test('enabled toolkit diagnostics retain attempts, normalized usage, time and reserve identity without replay duplication', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root, 'skill');
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, 'config.jsonc'), '{"diagnostics":true}');
    f.deps.skillRoot = skill;
    let now = 0;
    f.deps.clock = () => now;
    f.deps.delegate = async (provider, request, mode) => {
      now += 1200;
      const outcome = provider === 'claude' ? {status:'fail' as const, cls:'auth' as const, detail:'private failure'}
        : {status:'ok' as const, text:'private answer', sessionId:null, resume:null};
      return {outcome, invocations:[{provider, model:request.model, effort:request.effort, mode,
        launched:true, durationMs:1200, outcome:outcome.status === 'ok' ? 'ok' : 'auth',
        usage:{input:100, cacheRead:40, output:10, scope:'invocation', provenance:'private provenance', inputSemantics:'includes-cache', actualModels:['actual-model']}}]};
    };
    f.deps.handler = async ({deps}) => {
      const value = await fanOut({dir:path.join(f.session, '.state', 'ask'), slots:[
        {...rosterSlot('claude[0]', 'claude'), index:0},
        {...rosterSlot('copilot[0]', 'copilot', {reserve:true}), index:0},
      ], prompt:'private question', validate:() => ({ok:true})}, deps);
      return {ok:true, exit:0, summary:'done', value};
    };
    for (let i=0; i<2; i++) {
      f.lines.length = 0;
      assert.equal(await main(['ask','run','--session',f.session, '--host', 'claude'], f.deps), 0);
    }
    const facts = sessionFacts(f.session, {records:[], lastSeq:0, torn:null}, 'complete');
    assert.deepEqual(facts.invocations.map(i => [i.provider,i.model,i.outcome,i.durationMs,i.usage?.input,i.usage?.cacheRead,i.usage?.output]), [
      ['claude','model-a','auth',1200,60,40,10], ['copilot','model-a','ok',1200,60,40,10],
    ]);
    assert.deepEqual(facts.invocations.map(i => i.reportedModels), [['actual-model'],['actual-model']]);
    assert.equal(facts.phases.reduce((n,p) => n+(p.wallMs ?? 0),0), 2400);
    const dir = path.join(f.session,'.state','diagnostics');
    const bytes = fs.readdirSync(dir).map(file => fs.readFileSync(path.join(dir,file),'utf8')).join('');
    assert.doesNotMatch(bytes, /private|promptPath|logPath|sessionId/);
  } finally {f.cleanup();}
});

test('disabled toolkit diagnostics add no fields or artifacts and diagnostic I/O cannot change a result', async () => {
  for (const enabled of [false,true]) {
    const f = sessionFixture({ memory: true });
    try {
      const skill = path.join(f.root,'skill'); fs.mkdirSync(skill);
      fs.writeFileSync(path.join(skill,'config.jsonc'), JSON.stringify({diagnostics:enabled}));
      f.deps.skillRoot = skill;
      if (enabled) {
        fs.mkdirSync(path.join(f.session,'.state'), {recursive:true});
        fs.writeFileSync(path.join(f.session,'.state','diagnostics'), 'blocked');
      }
      f.deps.handler = async ({deps}) => {
        assert.equal(deps.delegate === f.deps.delegate, !enabled);
        return {ok:false,exit:4,reason:'native-pending',summary:'pending',value:{pending:[]}};
      };
      assert.equal(await main(['review','run','--session',f.session, '--host', 'codex'],f.deps),4);
      assert.equal(f.output().reason,'native-pending');
      assert.doesNotMatch(f.lines[0]!, /diagnostic|retro/);
      if (!enabled) assert.equal(fs.existsSync(path.join(f.session,'.state','diagnostics')),false);
    } finally {f.cleanup();}
  }
});

test('diagnostics keep durable attempts across a later crash and exclude cumulative or unlaunched usage', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const skill = path.join(f.root,'skill'); fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill,'config.jsonc'), '{"diagnostics":true}');
    f.deps.skillRoot=skill;
    let now=0; f.deps.clock=()=>now;
    f.deps.delegate=async () => {
      now+=1500;
      return {outcome:{status:'ok',text:'answer',resume:null,sessionId:null},invocations:[
        {provider:'codex',model:'first',effort:'high',mode:'cli',launched:false,outcome:'config',usage:{input:90,output:10,scope:'invocation',provenance:'test',inputSemantics:'uncached'}},
        {provider:'codex',model:'second',effort:'high',mode:'cli',launched:true,outcome:'ok',durationMs:1500,usage:{input:90,output:10,scope:'session-cumulative',provenance:'test',inputSemantics:'uncached'}},
      ]};
    };
    f.deps.handler=async({deps})=>{
      await deps.delegate('codex',{promptPath:'unused',model:'second',effort:'high',sandbox:true,schemaPath:null,resume:null,cwd:f.root,timeoutMs:10000,outputCapBytes:1024,attachments:[],logPath:'codex[0].log',briefPath:'unused'},'cli');
      const facts=sessionFacts(f.session,{records:[],lastSeq:0,torn:null},'running');
      assert.equal(facts.invocations.length,2,'attempts persisted before handler completion');
      throw new Error('after durable slot boundary');
    };
    assert.equal(await main(['review','run','example.plan.md','--session',f.session, '--host', 'codex'],f.deps),2);
    const dir=path.join(f.session,'.state','diagnostics');
    fs.writeFileSync(path.join(dir,'corrupt.json'),'{invalid');
    const facts=sessionFacts(f.session,{records:[],lastSeq:0,torn:null},'fault');
    assert.equal(facts.invocations.length,2);
    assert.ok(facts.invocations.every(i=>i.usage===undefined));
    assert.deepEqual(facts.invocations.map(i=>[i.model,i.mode,i.effort,i.launched]),[
      ['first','cli','high',false],['second','cli','high',true],
    ]);
    assert.equal(facts.phases[0]?.name,'plan review');
    assert.equal(facts.phases[0]?.outcome,'fault');
    const report=fs.readFileSync(writeDiagnostics(f.session,facts),'utf8');
    assert.match(report,/launch coverage 0\/1/);
    assert.match(report,/Timing scope: summed measured tool-call durations/);
  } finally {f.cleanup();}
});

test('diagnostics preserve exception attempts and durable capture boundaries', async () => {
 const f=sessionFixture({ memory: true });try {
 const skill=path.join(f.root,'skill');fs.mkdirSync(skill);fs.writeFileSync(path.join(skill,'config.jsonc'),'{"diagnostics":true}');f.deps.skillRoot=skill;
 const error=Object.assign(new Error('private error'),{invocations:[{provider:'claude',model:'m',mode:'cli',launched:true,outcome:'ok'}]});
 f.deps.delegate=async()=>{throw error;};const observer=observeTool(f.session,'ask','run',undefined,f.deps)!;
 const directory=path.join(f.session,'.state','diagnostics');assert.equal(fs.readdirSync(directory).length,1);
 await assert.rejects(observer.deps.delegate('claude',{logPath:path.join(f.session,'logs','claude[0].log')} as never,'cli'),e=>e===error);
 const read=()=>JSON.parse(fs.readFileSync(path.join(directory,fs.readdirSync(directory)[0]!),'utf8'));
 assert.equal(read().invocations.length,1);assert.equal(read().capture.state,'opened');
 observer.finish({ok:false,exit:2,reason:'invalid-input',summary:'private',value:null});
 assert.equal(read().capture.state,'completed');assert.deepEqual(read().rejectedTools,[{tool:'ask',action:'run',cls:'invalid-input'}]);
 assert.doesNotMatch(JSON.stringify(read()),/private/);
 }finally{f.cleanup();}
});

test('design-led milestones enter plan after the last design review and implementation at the earlier launch', async () => {
  const {stageMilestones}=await import('../../../skills/dispatch/scripts/toolkit/diagnostics.ts');
  const stamp=(n:number)=>new Date(n).toISOString();
  const basic={records:[{kind:'confirm',at:stamp(1),data:{}}],lastSeq:1,torn:null} as unknown as Fold;
  assert.deepEqual(stageMilestones(basic,[],0),[{stage:'spec',atMs:0},{stage:'plan',atMs:1}]);
  const fold={records:[{kind:'confirm',at:stamp(2),data:{}},{kind:'writer',at:stamp(9),data:{phase:'launched'}},{kind:'approval',at:stamp(10),data:{}}],lastSeq:3,torn:null} as unknown as Fold;
  const capture=(name:string,start:number,end:number)=>({capture:{state:'completed' as const,start,end},phases:[{key:name,name}],invocations:[],reviews:[]});
  const stages=stageMilestones(fold,[capture('design review',3,4),capture('design review',5,6),capture('plan review',7,8)],1);
  assert.deepEqual(stages,[{stage:'spec',atMs:1},{stage:'design',atMs:2},{stage:'design review',atMs:3},{stage:'plan',atMs:6},{stage:'plan review',atMs:7},{stage:'implementation',atMs:9}]);
  assert.deepEqual(stageMilestones({records:[],lastSeq:0,torn:null},[capture('design review',3,4)],1),[{stage:'design review',atMs:1}]);
});

test('host phase: sessionFacts builds phase milestones including interleaved A, B, A review subjects', () => {
  const f = sessionFixture({ memory: true });
  try {
    const reviewA = path.join(f.session, '.state', 'reviews', 'code-a', 'round-1');
    const reviewB = path.join(f.session, '.state', 'reviews', 'code-b', 'round-1');
    fs.mkdirSync(path.join(reviewA, 'gen-1', 'slots'), { recursive: true });
    fs.mkdirSync(path.join(reviewB, 'gen-1', 'slots'), { recursive: true });
    fs.writeFileSync(path.join(reviewA, 'round.json'), JSON.stringify({ round: 1, generation: 1, cap: 2, roster: [{ slot: 'claude[0]', provider: 'claude', model: 'm', native: false }] }));
    fs.writeFileSync(path.join(reviewB, 'round.json'), JSON.stringify({ round: 1, generation: 1, cap: 2, roster: [{ slot: 'claude[0]', provider: 'claude', model: 'm', native: false }] }));
    const subjA = crypto.createHash('sha256').update(path.join(reviewA, 'gen-1')).digest('hex').slice(0, 16);
    const subjB = crypto.createHash('sha256').update(path.join(reviewB, 'gen-1')).digest('hex').slice(0, 16);

    const diagDir = path.join(f.session, '.state', 'diagnostics');
    fs.mkdirSync(diagDir, { recursive: true });
    const writeCap = (name: string, subject: string, attempt: number, start: number) => writeJson(path.join(diagDir, `${name}.json`), {
      os: 'linux',
      capture: { state: 'completed', start, end: start + 500 },
      phases: [{ key: 'review-run-code', name: 'code review' }],
      invocations: [{ phase: 'review-run-code', subject, attempt, provider: 'claude', model: 'm', surface: 'cli', launched: true, outcome: 'ok' }],
      reviews: [],
    });
    writeCap('c1', subjA, 1, 1000);
    writeCap('c2', subjB, 1, 2000);
    writeCap('c3', subjA, 2, 3000);

    const expectedPhaseA = 'review-' + crypto.createHash('sha256').update(path.join(f.session, '.state', 'reviews', 'code-a')).digest('hex').slice(0, 16);
    const expectedPhaseB = 'review-' + crypto.createHash('sha256').update(path.join(f.session, '.state', 'reviews', 'code-b')).digest('hex').slice(0, 16);

    const msg = (id: string, at: number) => JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { id, model: 'm', usage: { input_tokens: 10, output_tokens: 1 } } });
    const content = Buffer.from([msg('m0', 500), msg('m1', 1200), msg('m2', 2200), msg('m3', 3200)].join('\n'));
    const customDeps = {
      ...f.deps,
      clock: () => 4000,
      orchestrator: { platform: 'claude' as const, model: 'm' },
      env: { CLAUDE_CODE_SESSION_ID: 'host-1' },
      hostUsageFs: {
        list: (dir: string) => dir.endsWith('projects') ? ['p'] : [],
        stat: (file: string) => file.endsWith('host-1.jsonl') ? { size: content.length, mtimeMs: 4000 } : null,
        read: () => content,
        decompress: null,
      },
    };
    const manifest = { createdAt: new Date(100).toISOString() } as never;
    const facts = sessionFacts(f.session, { records: [], lastSeq: 0, torn: null }, 'complete', { manifest, deps: customDeps });
    const rows = facts.hostUsage?.rows ?? [];
    assert.equal(rows.length, 3);
    assert.equal(rows[0]?.phase, undefined);
    assert.equal(rows[0]?.input, 10);
    const rowA = rows.find(r => r.phase === expectedPhaseA);
    const rowB = rows.find(r => r.phase === expectedPhaseB);
    assert.equal(rowA?.input, 20);
    assert.equal(rowB?.input, 10);
    assert.ok(facts.invocations.some(i => i.phase === expectedPhaseA));
  } finally {
    f.cleanup();
  }
});

test('sessionFacts records startedAt, hosts and slot yield billed tokens and attempts across rounds', () => {
  const f = sessionFixture({ memory: true });
  try {
    const review = 'plan-yield-attempts';
    for (const round of [1, 2]) {
      const roundDir = path.join(f.session, '.state', 'reviews', review, `round-${round}`);
      writeJson(path.join(roundDir, 'round.json'), {
        round, generation: 1, cap: 4, level: 'high',
        roster: [{ slot: 'opencode[0]', provider: 'opencode', index: 0, native: false, reserve: false, model: 'model-a' }],
        scope: 'Full', startSeq: 0, spec: { path: 'spec.md', hash: 'sha256:' + 'a'.repeat(64) }, target: { base: 'a'.repeat(40), head: 'b'.repeat(40) },
      });
      writeJson(path.join(roundDir, 'gen-1', 'slots', 'opencode[0].json'), {
        slot: 'opencode[0]', state: 'done', text: 'ok', responder: { slot: 'opencode[0]', provider: 'opencode', model: 'model-a', native: false },
      });
    }
    const sub1 = crypto.createHash('sha256').update(path.join(f.session, '.state', 'reviews', review, 'round-1', 'gen-1')).digest('hex').slice(0, 16);
    const sub2 = crypto.createHash('sha256').update(path.join(f.session, '.state', 'reviews', review, 'round-2', 'gen-1')).digest('hex').slice(0, 16);
    writeJson(path.join(f.session, '.state', 'diagnostics', 'run-1.json'), {
      capture: { state: 'completed', start: 0, end: 1 }, host: 'claude', phases: [], reviews: [],
      invocations: [{ phase: 'plan-review', subject: sub1, attempt: 1, provider: 'opencode', model: 'model-a', effort: 'low', mode: 'cli', surface: 'cli', launched: true, outcome: 'ok', slot: 'opencode[0]', usage: { input: 100, output: 20, reasoning: 30 } }],
    });
    writeJson(path.join(f.session, '.state', 'diagnostics', 'run-2.json'), {
      capture: { state: 'completed', start: Date.parse('2026-12-05T10:00:00Z'), end: Date.parse('2026-12-05T10:01:00Z') }, host: 'agy', phases: [], reviews: [],
      invocations: [{ phase: 'plan-review', subject: sub2, attempt: 1, provider: 'opencode', model: 'model-a', mode: 'cli', surface: 'cli', launched: true, outcome: 'ok', slot: 'opencode[0]', usage: { input: 200, output: 10, reasoning: 40, reasoningInOutput: true } }],
    });

    const facts = sessionFacts(f.session, { records: [], lastSeq: 0, torn: null }, 'complete');
    assert.equal(facts.startedAt, '2026-12-05');
    assert.deepEqual(facts.hosts, ['claude', 'agy']);
    assert.equal(facts.slotYield?.length, 1);
    const row = facts.slotYield![0]!;
    assert.equal(row.tokens, 360);
    assert.equal(row.attempts?.length, 2);
    assert.deepEqual(row.attempts?.map((a) => [a.provider, a.model, a.effort]), [['opencode', 'model-a', 'low'], ['opencode', 'model-a', null]]);

    // Capture without positive start falls back to manifest createdAt
    const f2 = sessionFixture({ memory: true });
    try {
      const manifestPath = path.join(f2.session, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.createdAt = '2026-11-20T08:00:00Z';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      writeJson(path.join(f2.session, '.state', 'diagnostics', 'run-0.json'), {
        capture: { state: 'completed', start: 0, end: 1 }, phases: [], reviews: [], invocations: [],
      });
      assert.equal(sessionFacts(f2.session, { records: [], lastSeq: 0, torn: null }, 'complete').startedAt, '2026-11-20');

      // Out-of-range capture start does not throw RangeError and falls back to manifest createdAt
      writeJson(path.join(f2.session, '.state', 'diagnostics', 'run-0.json'), {
        capture: { state: 'completed', start: 1e100, end: 1 }, phases: [], reviews: [], invocations: [],
      });
      assert.equal(sessionFacts(f2.session, { records: [], lastSeq: 0, torn: null }, 'complete').startedAt, '2026-11-20');
    } finally { f2.cleanup(); }
  } finally {
    f.cleanup();
  }
});

// SECTION: round workload fixtures
const reviewKey = (session: string, review: string) =>
  'review-' + crypto.createHash('sha256').update(path.join(session, '.state', 'reviews', review)).digest('hex').slice(0, 16);

const workloadRound = (session: string, review: string, round: number, generations = 1) => {
  const roundDir = path.join(session, '.state', 'reviews', review, `round-${round}`);
  writeJson(path.join(roundDir, 'round.json'), {round, generation: generations, cap: 4, roster: []});
  for (let g = 1; g <= generations; g++) fs.mkdirSync(path.join(roundDir, `gen-${g}`), {recursive: true});
};

const workloadCapture = (session: string, name: string, capture: {start: number; end?: number}, phase: string | undefined, invocations: unknown[] = []) =>
  writeJson(path.join(session, '.state', 'diagnostics', `${name}.json`), {
    capture: {state: capture.end === undefined ? 'opened' : 'completed', ...capture},
    phases: phase ? [{key: phase, name: 'plan review'}] : [], invocations, reviews: [],
  });

const reviewRun = (subject: string, extra: Record<string, unknown> = {}) => ({
  phase: 'review-run-plan', subject, attempt: 1, provider: 'claude', model: 'm', surface: 'cli', launched: true, outcome: 'ok', slot: 'claude[0]', ...extra,
});

const usageLine = (id: string, at: number, input: number, output: number) =>
  JSON.stringify({type: 'assistant', timestamp: new Date(at).toISOString(), message: {id, model: 'm', usage: {input_tokens: input, output_tokens: output}}});

// Claude host thread plus one subagent transcript, read through the injected filesystem port.
const claudeHostDeps = (f: ReturnType<typeof sessionFixture>, input: {clock: number; main: string[]; subagent?: string[]}) => {
  const main = Buffer.from(input.main.join('\n'));
  const subagent = Buffer.from((input.subagent ?? []).join('\n'));
  return {
    ...f.deps,
    clock: () => input.clock,
    orchestrator: {platform: 'claude' as const, model: 'm'},
    env: {CLAUDE_CODE_SESSION_ID: 'host-1'},
    hostUsageFs: {
      list: (dir: string) => dir.endsWith('projects') ? ['p'] : dir.endsWith('subagents') ? ['agent-1.jsonl'] : [],
      stat: (file: string) => file.endsWith('host-1.jsonl') ? {size: main.length, mtimeMs: input.clock}
        : file.endsWith('agent-1.jsonl') ? {size: subagent.length, mtimeMs: input.clock} : null,
      read: (file: string) => file.endsWith('agent-1.jsonl') ? subagent : main,
      decompress: null,
    },
  };
};

const sessionRows = (session: string, hostContext?: {manifest: never; deps: CliDeps}) =>
  sessionFacts(session, {records: [], lastSeq: 0, torn: null}, 'complete', hostContext).roundWorkload;

test('round workload counts observed calls per round window by phase key', () => {
  const f = sessionFixture({memory: true});
  try {
    workloadRound(f.session, 'plan-a', 1);
    workloadRound(f.session, 'plan-a', 2);
    workloadCapture(f.session, 'r1', {start: 1000, end: 1400}, 'review-run-plan', [reviewRun(roundSubject(f.session, 'plan-a', 1))]);
    workloadCapture(f.session, 'l1', {start: 1100, end: 1110}, 'ledger-append');
    workloadCapture(f.session, 'l2', {start: 1200, end: 1210}, 'lint-run');
    workloadCapture(f.session, 'r2', {start: 5000, end: 5300}, 'review-run-plan', [reviewRun(roundSubject(f.session, 'plan-a', 2))]);
    workloadCapture(f.session, 'after', {start: 6000, end: 6100}, 'report-render');
    const key = reviewKey(f.session, 'plan-a');
    assert.deepEqual(sessionRows(f.session), [
      {review: key, kind: 'plan', round: 1, calls: {total: 3, phases: [{key: 'ledger-append', count: 1}, {key: 'lint-run', count: 1}, {key: 'review-run-plan', count: 1}]}},
      {review: key, kind: 'plan', round: 2, calls: {total: 1, phases: [{key: 'review-run-plan', count: 1}]}},
    ]);
  } finally { f.cleanup(); }
});

test('round workload counts a later-generation rerun in its own round window', () => {
  const f = sessionFixture({memory: true});
  try {
    workloadRound(f.session, 'plan-b', 1, 2);
    workloadRound(f.session, 'plan-b', 2);
    workloadCapture(f.session, 'first', {start: 1000, end: 1400}, 'review-run-plan', [reviewRun(roundSubject(f.session, 'plan-b', 1, 1))]);
    workloadCapture(f.session, 'rerun', {start: 1500, end: 1900}, 'review-run-plan', [reviewRun(roundSubject(f.session, 'plan-b', 1, 2))]);
    workloadCapture(f.session, 'second', {start: 5000, end: 5300}, 'review-run-plan', [reviewRun(roundSubject(f.session, 'plan-b', 2))]);
    const rows = sessionRows(f.session)!;
    assert.deepEqual(rows.map((row) => row.calls?.total), [2, 1]);
    assert.deepEqual(rows[0]?.calls?.phases, [{key: 'review-run-plan', count: 2}]);
    assert.equal(rows[0]?.review, reviewKey(f.session, 'plan-b'));
  } finally { f.cleanup(); }
});

test('round workload attributes interleaved rounds of two reviews without double counting', () => {
  const f = sessionFixture({memory: true});
  try {
    for (const review of ['plan-a', 'plan-b']) for (const round of [1, 2]) workloadRound(f.session, review, round);
    workloadCapture(f.session, 'a1', {start: 1000, end: 1100}, 'review-run-plan', [reviewRun(roundSubject(f.session, 'plan-a', 1))]);
    workloadCapture(f.session, 'b1', {start: 1500, end: 1600}, 'review-run-plan', [reviewRun(roundSubject(f.session, 'plan-b', 1))]);
    workloadCapture(f.session, 'lint', {start: 1700, end: 1710}, 'lint-run');
    workloadCapture(f.session, 'a2', {start: 2000, end: 2100}, 'review-run-plan', [reviewRun(roundSubject(f.session, 'plan-a', 2))]);
    workloadCapture(f.session, 'b2', {start: 2500, end: 2600}, 'review-run-plan', [reviewRun(roundSubject(f.session, 'plan-b', 2))]);
    const rows = sessionRows(f.session)!;
    const keyA = reviewKey(f.session, 'plan-a');
    assert.deepEqual(rows.map((row) => [row.review === keyA ? 'a' : 'b', row.round, row.calls?.total]), [
      ['a', 1, 1], ['a', 2, 1], ['b', 1, 1], ['b', 2, 1],
    ]);
    assert.equal(rows.reduce((total, row) => total + (row.calls?.total ?? 0), 0), 4);
  } finally { f.cleanup(); }
});

test('round workload leaves a round without a launched review run unstarted', () => {
  const f = sessionFixture({memory: true});
  try {
    workloadRound(f.session, 'plan-c', 1);
    workloadCapture(f.session, 'stopped', {start: 900}, undefined);
    workloadCapture(f.session, 'later', {start: 1200, end: 1210}, 'lint-run');
    assert.deepEqual(sessionRows(f.session), [{review: reviewKey(f.session, 'plan-c'), kind: 'plan', round: 1}]);
  } finally { f.cleanup(); }
});

test('round workload counts a killed review run without phases or end and bounds the latest window', () => {
  const f = sessionFixture({memory: true});
  try {
    workloadRound(f.session, 'plan-d', 1);
    workloadCapture(f.session, 'killed', {start: 1000}, undefined, [reviewRun(roundSubject(f.session, 'plan-d', 1), {startMs: 1000, endMs: 1300})]);
    workloadCapture(f.session, 'inside', {start: 1200, end: 1210}, 'lint-run');
    workloadCapture(f.session, 'outside', {start: 1400, end: 1410}, 'lint-run');
    assert.deepEqual(sessionRows(f.session)?.[0]?.calls, {total: 2, phases: [{key: 'lint-run', count: 1}, {key: 'review-run-plan', count: 1}]});
  } finally { f.cleanup(); }
});

test('round workload attributes host rows by row time and excludes subagent rows past the latest window end', () => {
  const f = sessionFixture({memory: true});
  try {
    workloadRound(f.session, 'plan-a', 1, 2);
    workloadRound(f.session, 'plan-b', 1);
    workloadCapture(f.session, 'a1', {start: 1000, end: 1100}, 'review-run-plan', [reviewRun(roundSubject(f.session, 'plan-a', 1, 1))]);
    workloadCapture(f.session, 'b1', {start: 2000, end: 2100}, 'review-run-plan', [reviewRun(roundSubject(f.session, 'plan-b', 1))]);
    workloadCapture(f.session, 'a-rerun', {start: 2500, end: 2800}, 'review-run-plan', [reviewRun(roundSubject(f.session, 'plan-a', 1, 2))]);
    const deps = claudeHostDeps(f, {
      clock: 3000,
      main: [usageLine('m1', 1050, 10, 1), usageLine('m2', 2050, 20, 2), usageLine('m3', 2600, 30, 3), usageLine('m4', 2900, 99, 0)],
      subagent: [usageLine('s1', 1600, 1000, 0)],
    });
    const rows = sessionRows(f.session, {manifest: {createdAt: new Date(100).toISOString()} as never, deps})!;
    assert.deepEqual(rows.map((row) => row.calls?.total), [1, 1]);
    assert.deepEqual(rows.map((row) => row.hostTokens), [11, 22]);
    assert.deepEqual(rows.map((row) => row.hostTurns), [1, 1]);
  } finally { f.cleanup(); }
});

test('round workload omits host tokens when host usage is unavailable', () => {
  const f = sessionFixture({memory: true});
  try {
    workloadRound(f.session, 'plan-f', 1);
    workloadCapture(f.session, 'r1', {start: 1000, end: 1100}, 'review-run-plan', [reviewRun(roundSubject(f.session, 'plan-f', 1))]);
    const deps = {...f.deps, orchestrator: null, clock: () => 2000};
    const rows = sessionRows(f.session, {manifest: {createdAt: new Date(100).toISOString()} as never, deps})!;
    assert.equal(rows[0]?.calls?.total, 1);
    assert.equal('hostTokens' in rows[0]!, false);
  } finally { f.cleanup(); }
});

test('round workload keeps a closed window unchanged after later rounds and captures', () => {
  const f = sessionFixture({memory: true});
  try {
    workloadRound(f.session, 'plan-g', 1);
    workloadRound(f.session, 'plan-g', 2);
    workloadRound(f.session, 'plan-g', 3);
    workloadCapture(f.session, 'r1', {start: 1000, end: 1400}, 'review-run-plan', [reviewRun(roundSubject(f.session, 'plan-g', 1))]);
    workloadCapture(f.session, 'l1', {start: 1100, end: 1110}, 'lint-run');
    workloadCapture(f.session, 'r2', {start: 5000, end: 5300}, 'review-run-plan', [reviewRun(roundSubject(f.session, 'plan-g', 2))]);
    const deps = claudeHostDeps(f, {clock: 9500, main: [usageLine('h1', 1200, 10, 1), usageLine('h2', 5100, 20, 2), usageLine('h3', 9100, 30, 3)]});
    const hostContext = {manifest: {createdAt: new Date(100).toISOString()} as never, deps};
    const before = sessionRows(f.session, hostContext)!;
    assert.deepEqual(before.slice(0, 2).map((row) => row.hostTokens), [11, 22]);
    workloadCapture(f.session, 'r3', {start: 9000, end: 9300}, 'review-run-plan', [reviewRun(roundSubject(f.session, 'plan-g', 3))]);
    workloadCapture(f.session, 'l2', {start: 9100, end: 9110}, 'lint-run');
    assert.deepEqual(sessionRows(f.session, hostContext)!.slice(0, 2), before.slice(0, 2));
  } finally { f.cleanup(); }
});

test('round workload reports storage-failure markers in one note', () => {
  const f = sessionFixture({memory: true});
  try {
    workloadRound(f.session, 'plan-i', 1);
    workloadCapture(f.session, 'r1', {start: 1000, end: 1100}, 'review-run-plan', [reviewRun(roundSubject(f.session, 'plan-i', 1))]);
    writeJson(path.join(f.session, '.state', 'diagnostics', 'r1.json.failure.json'), {kind: 'storage-failure', count: 2});
    const facts = sessionFacts(f.session, {records: [], lastSeq: 0, torn: null}, 'complete');
    assert.equal(facts.collection?.storageFailed, 2);
    assert.equal(facts.roundWorkload?.[0]?.calls?.total, 1);
    assert.match(fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8'), /2 capture storage failures: calls from failed updates may be missing/);
  } finally { f.cleanup(); }
});

test('round workload is absent without review rounds', () => {
  const f = sessionFixture({memory: true});
  try {
    workloadCapture(f.session, 'lint', {start: 1000, end: 1010}, 'lint-run');
    assert.equal(sessionRows(f.session), undefined);
  } finally { f.cleanup(); }
});

test('round turns: counts host responses through the fix-review-lite note', () => {
  const f = sessionFixture({memory: true});
  try {
    const review = 'plan-a';
    workloadRound(f.session, review, 1);
    workloadCapture(f.session, 'run', {start: 1000, end: 1100}, 'review-run-plan', [reviewRun(roundSubject(f.session, review, 1))]);
    workloadCapture(f.session, 'fix-review-lite', {start: 1400, end: 1500}, 'brief-fix-review-lite');
    workloadCapture(f.session, 'after', {start: 1800, end: 1900}, 'report-render');
    const deps = claudeHostDeps(f, {
      clock: 2000,
      main: [usageLine('first', 1050, 1, 1), usageLine('check', 1450, 2, 2), usageLine('outside', 1750, 3, 3)],
      subagent: [usageLine('sub', 1050, 20, 20)],
    });
    const manifest = {createdAt: new Date(100).toISOString()} as never;
    const records = [{kind: 'note', key: 'fix-review-lite:plan-a:1:1', at: new Date(1600).toISOString()}] as Fold['records'];
    const facts = sessionFacts(f.session, {records, lastSeq: 1, torn: null}, 'complete', {manifest, deps});
    const row = facts.roundWorkload?.[0];
    assert.deepEqual([row?.calls?.total, row?.hostTokens, row?.hostTurns], [2, 6, 2]);
  } finally { f.cleanup(); }
});

test('round turns: in-window rulings and notes set the close without counting gaps', () => {
  const f = sessionFixture({memory: true});
  try {
    const review = 'plan-a';
    workloadRound(f.session, review, 1);
    workloadRound(f.session, review, 2);
    workloadRound(f.session, 'plan-b', 1);
    workloadCapture(f.session, 'r1', {start: 500, end: 800}, 'review-run-plan', [reviewRun(roundSubject(f.session, review, 1))]);
    workloadCapture(f.session, 'r2', {start: 1000, end: 1100}, 'review-run-plan', [reviewRun(roundSubject(f.session, review, 2))]);
    workloadCapture(f.session, 'ruling', {start: 1200, end: 1250}, 'ledger-append');
    workloadCapture(f.session, 'check', {start: 1400, end: 1450}, 'brief-fix-review-lite');
    workloadCapture(f.session, 'gap', {start: 1700, end: 1750}, 'lint-run');
    const main = [usageLine('prior', 700, 1, 1), ...[1100, 1250, 1500, 1700, 2100, 2300].map(at => usageLine(String(at), at, 1, 1))];
    const manifest = {createdAt: new Date(100).toISOString()} as never;
    const at = (ms: number) => new Date(ms).toISOString();
    const ruling = {kind: 'ruling', data: {subject: 'review:plan-a:earlier-finding'}, at: at(1250)};
    const note = {kind: 'note', key: 'fix-review-lite:plan-a:2:1', at: at(1500)};
    const unrelated = {kind: 'note', key: 'unrelated', at: at(1800)};
    const late = {...ruling, at: at(2300)};
    const read = (records: unknown[], host = main, subagent = ['malformed']) => {
      const deps = claudeHostDeps(f, {clock: 2500, main: host, subagent});
      return sessionFacts(f.session, {records: records as Fold['records'], lastSeq: records.length, torn: null}, 'complete', {manifest, deps}).roundWorkload;
    };
    const workload = (row: NonNullable<ReturnType<typeof read>>[number] | undefined) => [row?.calls?.total, row?.hostTurns];
    assert.deepEqual(workload(read([unrelated])?.[1]), [1, 1]);
    assert.deepEqual(workload(read([ruling, unrelated])?.[1]), [2, 2]);
    const before = read([ruling, note, unrelated])?.[1];
    assert.deepEqual(workload(before), [3, 3]);
    workloadCapture(f.session, 'other', {start: 2000, end: 2100}, 'review-run-plan', [reviewRun(roundSubject(f.session, 'plan-b', 1))]);
    assert.deepEqual(read([ruling, note, unrelated, late])?.[1], before);
    assert.deepEqual(workload(read([ruling, note, unrelated, late], [...main, 'malformed'])?.[1]), [3, undefined]);
  } finally { f.cleanup(); }
});
