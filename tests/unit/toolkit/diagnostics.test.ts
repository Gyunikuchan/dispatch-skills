import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { observeTool, readReviews, sessionFacts, writeDiagnostics } from '../../../skills/dispatch/scripts/toolkit/diagnostics.ts';
import { normalizeUsage } from '../../../skills/dispatch/scripts/toolkit/domain/diagnostics.ts';
import { fanOut } from '../../../skills/dispatch/scripts/toolkit/fanout.ts';
import { claude } from '../../../skills/dispatch/scripts/providers/claude.ts';import type { Fold } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { ToolError } from '../../../skills/dispatch/scripts/toolkit/output.ts';
import { sessionFixture } from './helpers/session.ts';

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
  f.deps.modes=()=>['cli'];f.deps.orchestrator={platform:'claude',model:null};
  f.deps.delegate=async()=>({outcome:{status:'fail',cls:'auth',detail:'private'},invocations:[{provider:'claude',model:'model-a',effort:null,mode:'cli',launched:true,outcome:'auth',durationMs:10}]});
  const second=observeTool(f.session,'ask','run',undefined,f.deps)!;
  await fanOut({dir:path.join(f.session,'fallback'),slots:[rosterSlot('claude[0]','claude')],prompt:'question',validate:()=>({ok:true})},second.deps);
  second.finish({ok:false,exit:4,reason:'native-pending',summary:'pending',value:null});
  facts=sessionFacts(f.session,fold,'pending');
  const cli=facts.invocations.find(i=>i.launched);assert.equal(cli?.routingOutcome,'native-fallback');assert.equal(cli?.slotState,'native');
  assert.ok(facts.invocations.some(i=>i.surface==='native'&&i.subject===cli?.subject&&i.nativeState==='pending'));
  assert.ok(facts.invocations.filter(i=>i.surface==='native').every(i=>i.slotState===undefined));
  const report=fs.readFileSync(writeDiagnostics(f.session,facts),'utf8');assert.match(report,/not-found.*routing stop.*slot failed.*not launched/);assert.match(report,/auth.*routing native-fallback.*slot native/);
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
  for(const reason of ['native-pending','approval-required','invalid-record'])observeTool(f.session,'record','append',undefined,f.deps)!.finish({ok:false,exit:4,reason,summary:'private',value:null});
  const records=[['A','launched','one'],['B','launched','two'],['A','launched','three']].map(([task,phase,key],n)=>({seq:n+1,key:key!,at:'2026-01-01T00:00:00Z',kind:'writer',by:'tool',data:{task,phase,path:key,base:{commit:'a'.repeat(40),seq:0,taskSection:'sha256:'+'b'.repeat(64)}}}));
  const fold={records:records.slice(0,2),lastSeq:2,torn:null} as Fold;
  assert.equal(sessionFacts(f.session,fold,'complete').relaunches,0);
  fold.records=records;fold.lastSeq=3;const facts=sessionFacts(f.session,fold,'complete');assert.equal(facts.relaunches,1);assert.deepEqual(facts.rejectedTools,[{tool:'record',action:'append',cls:'invalid-record'}]);
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
      assert.equal(await main(['ask','run','--session',f.session], f.deps), 0);
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
      assert.equal(await main(['review','run','--session',f.session],f.deps),4);
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
    assert.equal(await main(['review','run','example.plan.md','--session',f.session],f.deps),2);
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
    saveRound({
      session: f.session, review, round: 1,
      roster: [rosterSlot('claude[0]', 'claude', {model: 'model-a'}), rosterSlot('codex[0]', 'codex', {model: 'model-b'}), rosterSlot('agy[0]', 'agy', {model: 'model-c'})],
      outcomes: [
        {slot: 'claude[0]', state: 'done', text: 'ok', responder: {slot: 'claude[0]', provider: 'claude', model: 'model-a', native: false}},
        {slot: 'codex[0]', state: 'done', text: 'ok', responder: {slot: 'codex[0]', provider: 'codex', model: 'model-b', native: false}},
        // Legacy slot file without a responder: the roster entry names the model.
        {slot: 'agy[0]', state: 'done', text: 'ok'},
      ],
      findings: [must, should, consider, duplicate, shared],
    });
    const subject = roundSubject(f.session, review, 1);
    captureRuns(f.session, [
      attempt(subject, {slot: 'claude[0]', provider: 'claude', model: 'model-a', tokens: 1000}),
      attempt(subject, {slot: 'codex[0]', provider: 'codex', model: 'model-b', tokens: 500}),
      attempt(subject, {slot: 'agy[0]', provider: 'agy', model: 'model-c'}),
    ]);
    const fold = {records: [
      ruling(1, review, 'F1', 'accepted'), ruling(2, review, 'F2', 'rejected'), ruling(3, review, 'F3', 'deferred'),
      ruling(4, review, 'F4', 'duplicate'), ruling(5, review, 'F5', 'accepted'),
    ], lastSeq: 5, torn: null} as Fold;
    const facts = sessionFacts(f.session, fold, 'complete');
    const row = (provider: string) => facts.slotYield!.find((value) => value.provider === provider)!;
    assert.deepEqual(row('claude'), {
      kind: 'provider', provider: 'claude', model: 'model-a', raised: {MUST: 1, SHOULD: 2, CONSIDER: 0},
      accepted: 2, rejected: 1, deferred: 0, duplicate: 0, unruled: 0, tokens: 1000, measured: 1, launched: 1,
    });
    assert.deepEqual(row('codex'), {
      kind: 'provider', provider: 'codex', model: 'model-b', raised: {MUST: 1, SHOULD: 1, CONSIDER: 1},
      accepted: 1, rejected: 0, deferred: 1, duplicate: 1, unruled: 0, tokens: 500, measured: 1, launched: 1,
    });
    assert.deepEqual(row('agy'), {
      kind: 'provider', provider: 'agy', model: 'model-c', raised: {MUST: 0, SHOULD: 0, CONSIDER: 0},
      accepted: 0, rejected: 0, deferred: 0, duplicate: 0, unruled: 0, measured: 0, launched: 1,
    });
    const report = fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8');
    assert.match(report, /### Review yield by slot/);
    assert.match(report, /^\| claude \| model-a \| 1 \| 2 \| 0 \| 2 \| 1 \| 0 \| 0 \| 0 \| 1,000 \| 500 \|$/m);
    assert.match(report, /^\| codex \| model-b \| 1 \| 1 \| 1 \| 1 \| 0 \| 1 \| 1 \| 0 \| 500 \| 500 \|$/m);
    assert.match(report, /^\| agy \| model-c \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| — partial \| — \|$/m);
  } finally { f.cleanup(); }
});

test('review yield credits reserve responder', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const review = 'plan-reserve';
    saveRound({
      session: f.session, review, round: 1,
      roster: [rosterSlot('claude[0]', 'claude'), rosterSlot('copilot[0]', 'copilot', {reserve: true, model: 'model-r'})],
      outcomes: [{slot: 'claude[0]', state: 'done', text: 'ok', responder: {slot: 'copilot[0]', provider: 'copilot', model: 'model-r', native: false}}],
      findings: [finding('F1', {severity: 'MUST', sources: ['claude[0]']})],
    });
    const subject = roundSubject(f.session, review, 1);
    captureRuns(f.session, [
      attempt(subject, {slot: 'claude[0]', provider: 'claude', model: 'model-a', outcome: 'timeout'}),
      attempt(subject, {slot: 'copilot[0]', provider: 'copilot', model: 'model-r', targetSlot: 'claude[0]', attempt: 2, tokens: 700}),
    ]);
    const fold = {records: [ruling(1, review, 'F1', 'accepted')], lastSeq: 1, torn: null} as Fold;
    const facts = sessionFacts(f.session, fold, 'complete');
    assert.deepEqual(facts.slotYield, [{
      kind: 'provider', provider: 'copilot', model: 'model-r', raised: {MUST: 1, SHOULD: 0, CONSIDER: 0},
      accepted: 1, rejected: 0, deferred: 0, duplicate: 0, unruled: 0, tokens: 700, measured: 1, launched: 2,
    }]);
    assert.match(fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8'), /^\| copilot \| model-r \| 1 \| 0 \| 0 \| 1 \| 0 \| 0 \| 0 \| 0 \| 700 partial \| 700 partial \|$/m);
  } finally { f.cleanup(); }
});

test('review yield counts every reserve alias attempt', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const review = 'plan-reserve-alias';
    saveRound({
      session: f.session, review, round: 1,
      roster: [rosterSlot('claude[0]', 'claude'), rosterSlot('copilot[0]', 'copilot', {reserve: true, model: 'model-r'})],
      outcomes: [{slot: 'claude[0]', state: 'done', text: 'ok', responder: {slot: 'copilot[0]', provider: 'copilot', model: 'model-r', native: false}}],
      findings: [finding('F1', {severity: 'MUST', sources: ['claude[0]']})],
    });
    const subject = roundSubject(f.session, review, 1);
    captureRuns(f.session, [
      attempt(subject, {slot: 'claude[0]', provider: 'claude', model: 'model-a', outcome: 'auth', tokens: 100}),
      attempt(subject, {slot: 'copilot[0]', provider: 'copilot', model: 'model-r', targetSlot: 'claude[0]', attempt: 2, tokens: 300}),
      attempt(subject, {slot: 'copilot[0]', provider: 'copilot', model: 'model-r', targetSlot: 'claude[0]', attempt: 3, tokens: 300}),
    ]);
    const fold = {records: [ruling(1, review, 'F1', 'accepted')], lastSeq: 1, torn: null} as Fold;
    const facts = sessionFacts(f.session, fold, 'complete');
    assert.deepEqual(facts.slotYield, [{
      kind: 'provider', provider: 'copilot', model: 'model-r', raised: {MUST: 1, SHOULD: 0, CONSIDER: 0},
      accepted: 1, rejected: 0, deferred: 0, duplicate: 0, unruled: 0, tokens: 700, measured: 3, launched: 3,
    }]);
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
  } finally { f.cleanup(); }
});

test('review yield partial coverage renders partial', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const review = 'plan-partial';
    saveRound({
      session: f.session, review, round: 1,
      roster: [rosterSlot('claude[0]', 'claude')],
      outcomes: [{slot: 'claude[0]', state: 'done', text: 'ok', responder: {slot: 'claude[0]', provider: 'claude', model: 'model-a', native: false}}],
      findings: [finding('F1', {severity: 'MUST', sources: ['claude[0]']})],
    });
    const subject = roundSubject(f.session, review, 1);
    captureRuns(f.session, [
      attempt(subject, {slot: 'claude[0]', provider: 'claude', model: 'model-a', tokens: 500}),
      attempt(subject, {slot: 'claude[0]', provider: 'claude', model: 'model-a', attempt: 2}),
    ]);
    const fold = {records: [ruling(1, review, 'F1', 'accepted')], lastSeq: 1, torn: null} as Fold;
    const facts = sessionFacts(f.session, fold, 'complete');
    assert.deepEqual(facts.slotYield, [{
      kind: 'provider', provider: 'claude', model: 'model-a', raised: {MUST: 1, SHOULD: 0, CONSIDER: 0},
      accepted: 1, rejected: 0, deferred: 0, duplicate: 0, unruled: 0, tokens: 500, measured: 1, launched: 2,
    }]);
    assert.match(fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8'), /^\| claude \| model-a \| 1 \| 0 \| 0 \| 1 \| 0 \| 0 \| 0 \| 0 \| 500 partial \| 500 partial \|$/m);
  } finally { f.cleanup(); }
});

test('review yield native responder row', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const review = 'plan-native';
    saveRound({
      session: f.session, review, round: 1,
      roster: [rosterSlot('codex[0]', 'codex', {native: true})],
      outcomes: [{slot: 'codex[0]', state: 'done', text: 'ok', responder: {slot: 'codex[0]', provider: 'codex', model: 'model-a', native: true}}],
      findings: [finding('F1', {severity: 'MUST', sources: ['codex[0]']})],
    });
    const fold = {records: [ruling(1, review, 'F1', 'accepted')], lastSeq: 1, torn: null} as Fold;
    const facts = sessionFacts(f.session, fold, 'complete');
    assert.deepEqual(facts.slotYield, [{
      kind: 'native', provider: 'codex', model: null, raised: {MUST: 1, SHOULD: 0, CONSIDER: 0},
      accepted: 1, rejected: 0, deferred: 0, duplicate: 0, unruled: 0, measured: 0, launched: 0,
    }]);
    assert.match(fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8'), /^\| codex \| native \| 1 \| 0 \| 0 \| 1 \| 0 \| 0 \| 0 \| 0 \| — \| — \|$/m);
  } finally { f.cleanup(); }
});

test('review yield responder change across rounds', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const review = 'plan-change';
    saveRound({
      session: f.session, review, round: 1,
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
    captureRuns(f.session, [
      attempt(roundSubject(f.session, review, 1), {slot: 'claude[0]', provider: 'claude', model: 'model-a', tokens: 100}),
      attempt(roundSubject(f.session, review, 2), {slot: 'claude[0]', provider: 'codex', model: 'model-b', tokens: 200}),
    ]);
    const fold = {records: [ruling(1, review, 'F1', 'accepted'), ruling(2, review, 'F2', 'accepted')], lastSeq: 2, torn: null} as Fold;
    const facts = sessionFacts(f.session, fold, 'complete');
    assert.deepEqual(facts.slotYield?.map((row) => [row.provider, row.model, row.tokens, row.accepted]).sort(), [
      ['claude', 'model-a', 100, 1], ['codex', 'model-b', 200, 1],
    ]);
  } finally { f.cleanup(); }
});

test('review yield zero accepted renders dash', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const review = 'plan-unruled';
    saveRound({
      session: f.session, review, round: 1,
      roster: [rosterSlot('claude[0]', 'claude')],
      outcomes: [{slot: 'claude[0]', state: 'done', text: 'ok', responder: {slot: 'claude[0]', provider: 'claude', model: 'model-a', native: false}}],
      findings: [finding('F1', {severity: 'MUST', sources: ['claude[0]']})],
    });
    captureRuns(f.session, [attempt(roundSubject(f.session, review, 1), {slot: 'claude[0]', provider: 'claude', model: 'model-a', tokens: 400})]);
    const facts = sessionFacts(f.session, {records: [], lastSeq: 0, torn: null}, 'complete');
    assert.deepEqual(facts.slotYield?.[0], {
      kind: 'provider', provider: 'claude', model: 'model-a', raised: {MUST: 1, SHOULD: 0, CONSIDER: 0},
      accepted: 0, rejected: 0, deferred: 0, duplicate: 0, unruled: 1, tokens: 400, measured: 1, launched: 1,
    });
    assert.match(fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8'), /^\| claude \| model-a \| 1 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 1 \| 400 \| — \|$/m);
  } finally { f.cleanup(); }
});

test('review yield tool findings row', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const review = 'plan-tool';
    saveRound({
      session: f.session, review, round: 1,
      roster: [rosterSlot('claude[0]', 'claude')],
      outcomes: [{slot: 'claude[0]', state: 'done', text: 'ok', responder: {slot: 'claude[0]', provider: 'claude', model: 'model-a', native: false}}],
      findings: [finding('F1', {severity: 'MUST', sources: ['tool']})],
    });
    captureRuns(f.session, [attempt(roundSubject(f.session, review, 1), {slot: 'claude[0]', provider: 'claude', model: 'model-a', tokens: 100})]);
    const fold = {records: [ruling(1, review, 'F1', 'accepted')], lastSeq: 1, torn: null} as Fold;
    const facts = sessionFacts(f.session, fold, 'complete');
    assert.deepEqual(facts.slotYield?.map((row) => [row.kind, row.provider, row.model, row.raised, row.accepted, row.tokens]), [
      ['provider', 'claude', 'model-a', {MUST: 0, SHOULD: 0, CONSIDER: 0}, 0, 100],
      ['tool', 'tool', null, {MUST: 1, SHOULD: 0, CONSIDER: 0}, 1, undefined],
    ]);
    assert.match(fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8'), /^\| tool \| — \| 1 \| 0 \| 0 \| 1 \| 0 \| 0 \| 0 \| 0 \| — \| — \|$/m);
  } finally { f.cleanup(); }
});

test('review yield failed slot row renders cost', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const review = 'plan-failed';
    saveRound({
      session: f.session, review, round: 1,
      roster: [rosterSlot('codex[0]', 'codex', {model: 'model-a'})],
      outcomes: [{slot: 'codex[0]', state: 'failed', cls: 'timeout', reason: 'slot timed out'}],
    });
    const subject = roundSubject(f.session, review, 1);
    captureRuns(f.session, [
      attempt(subject, {slot: 'codex[0]', provider: 'codex', model: 'model-a', outcome: 'timeout', tokens: 120}),
      attempt(subject, {slot: 'codex[0]', provider: 'codex', model: 'model-b', attempt: 2, outcome: 'timeout', tokens: 80}),
    ]);
    const facts = sessionFacts(f.session, {records: [], lastSeq: 0, torn: null}, 'complete');
    assert.deepEqual(facts.slotYield, [{
      kind: 'provider', provider: 'codex', model: 'model-b', raised: {MUST: 0, SHOULD: 0, CONSIDER: 0},
      accepted: 0, rejected: 0, deferred: 0, duplicate: 0, unruled: 0, tokens: 200, measured: 2, launched: 2,
    }]);
    assert.match(fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8'), /^\| codex \| model-b \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 200 \| — \|$/m);
  } finally { f.cleanup(); }
});

test('review yield resumed round reserve per target', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const review = 'plan-resumed';
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
      attempt(subject, {slot: 'copilot[0]', provider: 'copilot', model: 'model-r', targetSlot: 'claude[0]', tokens: 100}),
      attempt(subject, {slot: 'copilot[0]', provider: 'copilot', model: 'model-r', targetSlot: 'codex[0]', attempt: 2, tokens: 200}),
    ]);
    const fold = {records: [ruling(1, review, 'F1', 'accepted'), ruling(2, review, 'F2', 'accepted')], lastSeq: 2, torn: null} as Fold;
    const facts = sessionFacts(f.session, fold, 'complete');
    assert.deepEqual(facts.slotYield, [{
      kind: 'provider', provider: 'copilot', model: 'model-r', raised: {MUST: 2, SHOULD: 0, CONSIDER: 0},
      accepted: 2, rejected: 0, deferred: 0, duplicate: 0, unruled: 0, tokens: 300, measured: 2, launched: 2,
    }]);
  } finally { f.cleanup(); }
});

test('review yield superseded generation partial', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const review = 'plan-superseded';
    saveRound({
      session: f.session, review, round: 1, generation: 2,
      roster: [rosterSlot('claude[0]', 'claude')],
      outcomes: [{slot: 'claude[0]', state: 'done', text: 'ok', responder: {slot: 'claude[0]', provider: 'claude', model: 'model-a', native: false}}],
      findings: [finding('F1', {severity: 'MUST', sources: ['claude[0]']})],
    });
    fs.mkdirSync(path.join(f.session, '.state', 'reviews', review, 'round-1', 'gen-1'), {recursive: true});
    captureRuns(f.session, [
      attempt(roundSubject(f.session, review, 1, 1), {slot: 'claude[0]', provider: 'claude', model: 'model-a', tokens: 900}),
      attempt(roundSubject(f.session, review, 1, 2), {slot: 'claude[0]', provider: 'claude', model: 'model-a', attempt: 2, tokens: 100}),
    ]);
    const fold = {records: [ruling(1, review, 'F1', 'accepted')], lastSeq: 1, torn: null} as Fold;
    const facts = sessionFacts(f.session, fold, 'complete');
    assert.deepEqual(facts.slotYield, [{
      kind: 'provider', provider: 'claude', model: 'model-a', raised: {MUST: 1, SHOULD: 0, CONSIDER: 0},
      accepted: 1, rejected: 0, deferred: 0, duplicate: 0, unruled: 0, tokens: 100, measured: 1, launched: 2,
    }]);
    assert.match(fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8'), /^\| claude \| model-a \| 1 \| 0 \| 0 \| 1 \| 0 \| 0 \| 0 \| 0 \| 100 partial \| 100 partial \|$/m);
  } finally { f.cleanup(); }
});

test('token table groups by effort', () => {
  const f = sessionFixture({ memory: true });
  try {
    captureRuns(f.session, [
      { phase: 'plan-review', attempt: 1, provider: 'codex', model: 'gpt', effort: 'low', mode: 'cli', surface: 'cli', launched: true, outcome: 'ok', usage: { input: 100, output: 10 } },
      { phase: 'plan-review', attempt: 2, provider: 'codex', model: 'gpt', effort: 'high', mode: 'cli', surface: 'cli', launched: true, outcome: 'ok', usage: { input: 200, output: 20 } },
    ]);
    const facts = sessionFacts(f.session, { records: [], lastSeq: 0, torn: null }, 'complete');
    const table = fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8');
    assert.match(table, /### Tokens by provider, model and effort/);
    assert.match(table, /^\| Provider \| Model \| Effort \| Uncached input \| Cache read \| Cache write \| Output \| Reasoning \| Coverage \|$/m);
    assert.match(table, /^\| codex \| gpt \(configured\) \| low \| 100 \| — \| — \| 10 \| — \| 1\/1 \|$/m);
    assert.match(table, /^\| codex \| gpt \(configured\) \| high \| 200 \| — \| — \| 20 \| — \| 1\/1 \|$/m);
    assert.doesNotMatch(table, /^\| codex \| all models \|/m);
  } finally { f.cleanup(); }
});

test('copilot usage unavailable reason', () => {
  const f = sessionFixture({ memory: true });
  try {
    captureRuns(f.session, [
      { phase: 'plan-review', attempt: 1, provider: 'copilot', model: 'auto', effort: 'high', mode: 'cli', surface: 'cli', launched: true, outcome: 'ok', coverage: 'no usage output' },
    ]);
    const facts = sessionFacts(f.session, { records: [], lastSeq: 0, torn: null }, 'complete');
    assert.equal(facts.invocations[0]?.coverage, 'no usage output');
    const table = fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8');
    assert.match(table, /^\| copilot \| auto \(configured\) \| high \| — \| — \| — \| — \| — \| 0\/1 no usage output \|$/m);
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
    assert.match(table, /^\| claude \| m \(configured\) \| high \| 100 \| 20 \| 3 \| 10 \| 7 \| 1\/1 \|$/m);
  } finally { f.cleanup(); }
});

test('per model reasoning row renders', () => {
  const f = sessionFixture({ memory: true });
  try {
    captureRuns(f.session, [
      { phase: 'plan-review', attempt: 1, provider: 'claude', model: 'aggregate', effort: 'high', mode: 'cli', surface: 'cli', launched: true, outcome: 'ok', reportedModels: ['alpha', 'beta'],
        usage: { input: 150, output: 15, reasoning: 6, models: { alpha: { input: 100, output: 10, reasoning: 4 }, beta: { input: 50, output: 5, reasoning: 2 } } } },
    ]);
    const facts = sessionFacts(f.session, { records: [], lastSeq: 0, torn: null }, 'complete');
    assert.deepEqual(facts.invocations[0]?.usage?.models, {
      alpha: { input: 100, output: 10, reasoning: 4 },
      beta: { input: 50, output: 5, reasoning: 2 },
    });
    const table = fs.readFileSync(writeDiagnostics(f.session, facts), 'utf8');
    assert.match(table, /^\| claude \| alpha \| high \| 100 \| — \| — \| 10 \| 4 \| 1\/1 \|$/m);
    assert.match(table, /^\| claude \| beta \| high \| 50 \| — \| — \| 5 \| 2 \| 1\/1 \|$/m);
    assert.doesNotMatch(table, /^\| claude \| aggregate \|/m);
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
    assert.match(table, /^\| claude \| alpha \| high \| 10 \| — \| — \| 2 \| 3 \| 1\/1 \|$/m);
    assert.match(table, /^\| claude \| beta \| high \| 5 \| — \| — \| 1 \| 4 \| 1\/1 \|$/m);
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
