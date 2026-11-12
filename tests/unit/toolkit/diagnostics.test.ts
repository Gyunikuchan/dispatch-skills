import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { observeTool, readReviews, sessionFacts, writeDiagnostics } from '../../../skills/dispatch/scripts/toolkit/diagnostics.ts';
import { heuristics, normalizeUsage } from '../../../skills/dispatch/scripts/toolkit/domain/diagnostics.ts';
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
  const report=fs.readFileSync(writeDiagnostics(f.session,facts),'utf8');assert.match(report,/toolkit operation.*rejected/);assert.doesNotMatch(report,/writer relaunch/);assert.equal(facts.verb,'implement');assert.equal(sessionFacts(f.session,{...fold,records:[]},'complete').verb,undefined);assert.doesNotMatch(report,/defective writer|private/);
 }finally{f.cleanup();}
});

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
      {phase: facts.reviews[0]!.phase, round: 1, cap: 4, accepted: 1, rejected: 1},
      {phase: facts.reviews[0]!.phase, round: 2, cap: 4, accepted: 0, rejected: 0, reraised: ['F001', 'F002']},
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
    const result = JSON.parse(fs.readFileSync(output.path!, 'utf8'));
    assert.equal(result.path, path.join(f.session, 'diagnostics.md'));
    assert.match(fs.readFileSync(result.path, 'utf8'), /## Overview/);
    assert.equal(fs.existsSync(path.join(f.session, '.state', 'diagnostics')), false, 'render is not captured as a tool observation');
  } finally { f.cleanup(); }
});

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
    });
    assert.deepEqual(row('codex'), {
      kind: 'provider', provider: 'codex', model: 'model-b', raised: {MUST: 1, SHOULD: 1, CONSIDER: 1},
      accepted: 1, rejected: 0, deferred: 1, duplicate: 1, unruled: 0, tokens: 500, measured: 1, launched: 1,
    });
    assert.deepEqual(row('agy'), {
      kind: 'provider', provider: 'agy', model: 'model-c', raised: {MUST: 0, SHOULD: 0, CONSIDER: 0},
      accepted: 0, rejected: 0, deferred: 0, duplicate: 0, unruled: 0, measured: 0, launched: 1,
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
    assert.match(report, /^\| claude \| model-a \| 2 \| 2 \| 0 \| 2 \| 1 \| 0 \| 0 \| 1 \| 1,000 \| 500 \|$/m);
    assert.match(report, /^\| codex \| model-b \| 1 \| 1 \| 1 \| 1 \| 0 \| 1 \| 1 \| 0 \| 500 \| 500 \|$/m);
    assert.match(report, /^\| agy \| model-c \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| — partial \| — \|$/m);
    assert.match(report, /^\| codex \| native \| 1 \| 0 \| 0 \| 1 \| 0 \| 0 \| 0 \| 0 \| — \| — \|$/m);
    assert.match(report, /^\| tool \| — \| 1 \| 0 \| 0 \| 1 \| 0 \| 0 \| 0 \| 0 \| — \| — \|$/m);
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
    }]);
    assert.match(fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8'), /^\| copilot \| model-r \| 2 \| 0 \| 0 \| 2 \| 0 \| 0 \| 0 \| 0 \| 900 \| 450 \|$/m);
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
    }]);
    assert.match(fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8'), /^\| claude \| model-a \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 600 \| — \|$/m);
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
      ['claude', 'model-a', 100, 1, 1, 2], ['codex', 'model-b', 200, 1, 1, 1],
    ]);
    const report = fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8');
    assert.match(report, /^\| claude \| model-a \| 1 \| 0 \| 0 \| 1 \| 0 \| 0 \| 0 \| 0 \| 100 partial \| 100 partial \|$/m);
    assert.match(report, /^\| codex \| model-b \| 1 \| 0 \| 0 \| 1 \| 0 \| 0 \| 0 \| 0 \| 200 \| 200 \|$/m);
  } finally { f.cleanup(); }
});

test('token table groups by effort', () => {
  const f = sessionFixture({ memory: true });
  try {
    captureRuns(f.session, [
      { phase: 'plan-review', attempt: 1, provider: 'codex', model: 'gpt', effort: 'low', mode: 'cli', surface: 'cli', launched: true, outcome: 'ok', usage: { input: 100, output: 10 } },
      { phase: 'plan-review', attempt: 2, provider: 'codex', model: 'gpt', effort: 'high', mode: 'cli', surface: 'cli', launched: true, outcome: 'ok', usage: { input: 200, output: 20 } },
      { phase: 'plan-review', attempt: 3, provider: 'copilot', model: 'auto', effort: 'high', mode: 'cli', surface: 'cli', launched: true, outcome: 'ok', coverage: 'no usage output' },
    ]);
    const facts = sessionFacts(f.session, { records: [], lastSeq: 0, torn: null }, 'complete');
    assert.equal(facts.invocations.find(i => i.provider === 'copilot')?.coverage, 'no usage output');
    const table = fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8');
    assert.match(table, /### Tokens by stage/);
    assert.match(table, /^\| Stage \| Platform \| Role \| Model \| Effort \| Uncached input \| Cache read \| Cache write \| Output \| Reasoning \| Coverage \|$/m);
    assert.match(table, /^\| — \| codex \| delegate \| gpt \(configured\) \| low \| 100 \| — \| — \| 10 \| — \| 1\/1 \|$/m);
    assert.match(table, /^\| — \| codex \| delegate \| gpt \(configured\) \| high \| 200 \| — \| — \| 20 \| — \| 1\/1 \|$/m);
    assert.match(table, /^\| — \| copilot \| delegate \| auto \(configured\) \| high \| — \| — \| — \| — \| — \| 0\/1 no usage output \|$/m);
    assert.doesNotMatch(table, /^\| — \| codex \| delegate \| all models \|/m);
  } finally { f.cleanup(); }
});

test('reasoning tokens persist', () => {
  const f = sessionFixture({ memory: true });
  try {
    assert.equal(normalizeUsage({ input: 100, output: 10, reasoning: 7 }, 'uncached')?.reasoning, 7);
    captureRuns(f.session, [
      { phase: 'plan-review', attempt: 1, provider: 'claude', model: 'm', effort: 'high', mode: 'cli', surface: 'cli', launched: true, outcome: 'ok',
        usage: { input: 100, output: 10, cacheRead: 20, cacheWrite: 3, reasoning: 7, scope: 'invocation', provenance: 'test', inputSemantics: 'uncached' } },
    ]);
    const facts = sessionFacts(f.session, { records: [], lastSeq: 0, torn: null }, 'complete');
    assert.deepEqual(facts.invocations[0]?.usage, { input: 100, output: 10, cacheRead: 20, cacheWrite: 3, reasoning: 7 });
    const table = fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8');
    assert.match(table, /^\| — \| claude \| delegate \| m \(configured\) \| high \| 100 \| 20 \| 3 \| 10 \| 7 \| 1\/1 \|$/m);
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
    assert.match(table, /^\| — \| claude \| delegate \| alpha \| high \| 10 \| — \| — \| 2 \| 3 \| 1\/1 \|$/m);
    assert.match(table, /^\| — \| claude \| delegate \| beta \| high \| 5 \| — \| — \| 1 \| 4 \| 1\/1 \|$/m);
    assert.doesNotMatch(table, /^\| — \| claude \| delegate \| aggregate \|/m);
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
    assert.match(rendered,/^\| spec \| claude \| host \| m \| — \| 12 \| — \| — \| 3 \| — \| — \|$/m);
    assert.doesNotMatch(rendered,/secret transcript/);
    f.lines.splice(0); f.deps.hostUsageFs.list=()=>{throw Object.assign(new Error('private'),{code:'EACCES'});};
    assert.equal(await main(['diagnostics','render','--session',f.session],f.deps),0); assert.match(fs.readFileSync(path.join(f.session,'diagnostics.md'),'utf8'),/host unavailable: read-error:EACCES/);
    f.lines.splice(0); manifest.createdAt='invalid'; fs.writeFileSync(manifestPath,JSON.stringify(manifest));
    assert.equal(await main(['diagnostics','render','--session',f.session],f.deps),0);
    assert.equal(reads,1); assert.match(fs.readFileSync(path.join(f.session,'diagnostics.md'),'utf8'),/host unavailable: invalid session start/);
  } finally { f.cleanup(); }
});

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
    '  - Verify: `node verify-1.js`',
    '  - Evidence: verify',
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
    assert.match(report, /^\| claude \| model-a \| 1 \| 2 \| 0 \| 2 \| 0 \| 0 \| 0 \| 0 \| 3 \| 100 \| — \|$/m);
  } finally { f.cleanup(); }
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
  const row={provider:'claude' as const,model:'m',effort:null,mode:'cli' as const,launched:true,outcome:'ok'};
  f.deps.delegate=async (_provider,request)=>{request.onInvocation?.(row);return {outcome:{status:'ok',text:'answer',resume:null,sessionId:null},invocations:[row]};};
  await observer.deps.delegate('claude',{logPath:path.join(f.session,'logs','claude[0].log')} as never,'cli');
  assert.equal(writes,2,'return retries failed callback persistence');
  assert.equal(sessionFacts(f.session,{records:[],lastSeq:0,torn:null},'complete').invocations.length,1);
  writes=0;
  const second={...row};f.deps.delegate=async (_provider,request)=>{request.onInvocation?.(second);return {outcome:{status:'ok',text:'answer',resume:null,sessionId:null},invocations:[second]};};
  await observer.deps.delegate('claude',{logPath:path.join(f.session,'logs','claude[0].log')} as never,'cli');
  assert.equal(writes,1,'return does not repeat successful callback persistence');
 }finally{t.mock.restoreAll();f.cleanup();}
});

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
