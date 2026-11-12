import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateRecord } from '../../../skills/dispatch/scripts/toolkit/records.ts';
import { parseRepositoryNoteKey } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { sessionFixture } from './helpers/session.ts';

test('design-stage bindings require a spec and a plan or design while approval requires a plan', () => {
  const record = (kind: string, data: object) => ({kind, data, key: 'binding', by: 'user', quote: 'Approved'});
  const hash = 'sha256:' + 'a'.repeat(64);
  for (const data of [{spec: 's.spec.md', design: 'd.design.md'}, {spec: 's.spec.md', plan: 'p.plan.md'}])
    assert.doesNotThrow(() => validateRecord(record('bind', data)));
  for (const data of [{spec: 's.spec.md'}, {design: 'd.design.md'}])
    assert.throws(() => validateRecord(record('bind', data)), {reason: 'invalid-record'});
  assert.throws(() => validateRecord(record('approval', {spec: hash, design: hash})), {reason: 'invalid-record'});
});

test('ledger records validate closed fields and user-only input', async () => {
 const f=sessionFixture({ memory: true });try{
 const input=f.artifact('record.json','');let n=0;
 const call=async(record:unknown)=>{f.lines.length=0;fs.writeFileSync(input,JSON.stringify(record));const exit=await main(['ledger','append','--session',f.session,input],f.deps);const output=f.output();return {exit,output,value:output.path?JSON.parse(fs.readFileSync(output.path,'utf8')):null};};
 const add=(kind:string,data:object,extra:object={})=>call({kind,data,by:'orchestrator',key:'k'+n++,...extra});
 const hash='sha256:'+'a'.repeat(64),git='a'.repeat(40);
 const invalid: [string,object,string][]=[
 ['bind',{plan:'p'},'spec'],['level',{level:'unknown'},'level'],['escalation',{id:'x',state:'bad',summary:'s'},'state'],
 ['edit',{artifact:'oops',before:hash,after:hash,class:'non-intent',affects:[],rationale:'r',diffRef:'d'},'artifact'],
 ['edit',{artifact:'plan',before:hash,after:hash,class:'bad',affects:[],rationale:'r',diffRef:'d'},'class'],
 ['writer',{phase:'bad'},'phase'],['writer',{phase:'toString'},'phase'],['integrate',{phase:'__proto__'},'phase'],['writer',{phase:'finished',task:'t',launch:1,candidate:'bad'},'candidate'],
 ['writer',{phase:'launched',task:'t',path:'p',base:{commit:'bad',taskSection:hash,seq:0}},'commit'],
 ['writer',{phase:'launched',task:'t',path:'p',base:{commit:git,taskSection:'bad',seq:0}},'taskSection'],
 ['integrate',{phase:'deliver-started',mode:'uncommitted',dest:{branch:'b',path:'p'},source:git},'from'],['integrate',{phase:'delivered',mode:'uncommitted',source:git},'dest'],
 ['integrate',{phase:'opened',path:'p',branch:'b',base:git,dest:{branch:'b'}},'path'],
 ['approval',{spec:'bad',plan:hash},'spec'],['note',{text:2},'text'],
 ];
 const evidence={criterion:'SC1',commandDigest:hash,tree:git,clean:true,before:git,after:git,exit:0,path:'p'};
 for(const field of ['tree','before','after','commandDigest'])invalid.push(['evidence',{...evidence,[field]:'bad'},field]);
 for(const field of ['tree','before','after','commandDigest'])invalid.push(['evidence',{...evidence,[field]:field==='commandDigest'?'sha256:'+'A'.repeat(64):'A'.repeat(40)},field]);
 invalid.push(['approval',{spec:'sha256:'+'A'.repeat(64),plan:hash},'spec']);
 for(const field of ['before','after'])invalid.push(['edit',{artifact:'plan',before:hash,after:hash,class:'non-intent',affects:[],rationale:'r',diffRef:'d',[field]:'sha256:'+'A'.repeat(64)},field]);
 invalid.push(['writer',{phase:'finished',task:'t',launch:1,candidate:'A'.repeat(64)},'candidate']);
 for(const [kind,data,field]of invalid)assert.throws(()=>validateRecord({kind,data,key:'case',by:'user',quote:'yes'}), error=>{assert.equal((error as {reason:string}).reason,'invalid-record');assert.match((error as Error).message,new RegExp(field));return true;});
 const invalidCli=await add('note',{text:2});assert.equal(invalidCli.exit,1);assert.equal(invalidCli.output.reason,'invalid-record');assert.match(invalidCli.output.summary,/text/);
 for(const kind of ['approval','level','bind','escalation','edit','ruling','note']){
 const data:Record<string,object>={approval:{spec:hash,plan:hash},level:{level:'low'},bind:{spec:'s',plan:'p'},escalation:{id:'i',state:'open',summary:'s'},edit:{artifact:'plan',before:hash,after:hash,class:'non-intent',affects:[],rationale:'r',diffRef:'d'},ruling:{subject:'s',ruling:'r',rationale:'r'},note:{text:'n'}};
 assert.throws(()=>validateRecord({kind,data:data[kind]!,by:'user',quote:'yes'}),{reason:'missing-key'});
 }
 for(const level of ['xhigh','max'])assert.throws(()=>validateRecord({kind:'level',data:{level},key:'level',by:'user',quote:' '}),{reason:'user-only'});
 const missingKey=await call({kind:'note',data:{text:'n'},by:'orchestrator'});assert.equal(missingKey.exit,1);assert.equal(missingKey.output.reason,'missing-key');
 const userOnly=await add('level',{level:'max'},{by:'user',quote:' '});assert.equal(userOnly.exit,1);assert.equal(userOnly.output.reason,'user-only');
 const accepted=await add('note',{text:'persisted'});assert.equal(accepted.exit,0);assert.equal(JSON.parse(fs.readFileSync(path.join(f.session,'ledger.jsonl'),'utf8')).data.text,'persisted');
 }finally{f.cleanup();}
});

test('review focus records require link evidence on every bullet', async () => {
 const f=sessionFixture({memory:true});try{
  let n=0;
  const append=async(record:unknown)=>{
   const file=f.artifact(`focus-${++n}.json`,JSON.stringify(record));
   f.lines.splice(0);
   const exit=await main(['ledger','append','--session',f.session,file],f.deps);
   return {exit,output:f.output()};
  };
  const bullets=[
   {text:'Check report completion behavior',evidence:'skills/dispatch/scripts/toolkit/report.ts'},
   {text:'Check the acceptance contract',evidence:'https://example.test/review'},
  ];
  const accepted=await append({kind:'focus',by:'orchestrator',key:'focus:valid',data:{bullets,visual:'graph TD'}});
  assert.equal(accepted.exit,0,accepted.output.summary);
  const stored=JSON.parse(fs.readFileSync(path.join(f.session,'ledger.jsonl'),'utf8').trim().split(/\r?\n/).at(-1)!);
  assert.equal(stored.kind,'focus');
  assert.deepEqual(stored.data.bullets,bullets);

  const emptyUser=await append({kind:'focus',by:'user',key:'focus:empty',data:{bullets:[]}});
  assert.equal(emptyUser.exit,0,emptyUser.output.summary);
  assert.doesNotThrow(()=>validateRecord({kind:'focus',by:'orchestrator',key:'focus:five',data:{bullets:Array.from({length:5},(_,index)=>({text:`Point ${index}`,evidence:`notes/point-${index}.md`}))}}));

  const invalid=await append({kind:'focus',by:'orchestrator',key:'focus:invalid-evidence',data:{bullets:[bullets[0],{text:'A claim without a link',evidence:'checked'}]}});
  assert.equal(invalid.exit,1);
  assert.equal(invalid.output.reason,'invalid-record');
  assert.match(invalid.output.summary,/data\.bullets\.1\.evidence/);
  for(const evidence of ['checked','http://example.test/review','/absolute/report.md','C:/repo/report.md','\\\\server\\share\\report.md']) {
   assert.throws(()=>validateRecord({kind:'focus',by:'orchestrator',key:'focus:bad-link',data:{bullets:[{text:'Review this',evidence}]}}),error=>{
    assert.equal((error as {reason:string}).reason,'invalid-record');
    assert.match((error as Error).message,/data\.bullets\.0\.evidence/);
    return true;
   },evidence);
  }
  for(const [record,field] of [
   [{kind:'focus',by:'orchestrator',key:'focus:blank-text',data:{bullets:[{text:' ',evidence:'notes/review.md'}]}},'data.bullets.0.text'],
   [{kind:'focus',by:'orchestrator',key:'focus:unknown-bullet-field',data:{bullets:[{text:'Review this',evidence:'notes/review.md',url:'notes/other.md'}]}},'data.bullets.0.url'],
   [{kind:'focus',by:'orchestrator',key:'focus:too-many',data:{bullets:Array.from({length:6},(_,index)=>({text:`Point ${index}`,evidence:`notes/point-${index}.md`}))}},'data.bullets'],
   [{kind:'focus',by:'orchestrator',key:'focus:blank-visual',data:{bullets:[],visual:' '}},'data.visual'],
   [{kind:'focus',by:'tool',key:'focus:wrong-author',data:{bullets:[]}},'record.by'],
  ] as const) assert.throws(()=>validateRecord(record),error=>{
   assert.equal((error as {reason:string}).reason,'invalid-record');
   assert.match((error as Error).message,new RegExp(field));
   return true;
  });
  assert.throws(()=>validateRecord({kind:'focus',by:'orchestrator',data:{bullets:[]}}),{reason:'missing-key'});
 }finally{f.cleanup();}
});

test('uncommitted records accept exact identities and refuse missing or unknown fields',()=>{
 const commit='a'.repeat(40),dest={path:'repo',branch:'main'},record=(data:Record<string,unknown>)=>validateRecord({kind:'integrate',by:'tool',data});
 for(const phase of ['deliver-started','delivered']){
 const data={phase,mode:'uncommitted',dest,from:commit,source:commit};
 assert.doesNotThrow(()=>record(data));
 for(const field of ['mode','from','source','dest']){const partial:Record<string,unknown>={...data};delete partial[field];assert.throws(()=>record(partial),{reason:'invalid-record'});}
 for(const field of ['from','source'])assert.throws(()=>record({...data,[field]:'bad'}),{reason:'invalid-record'});
 assert.throws(()=>record({...data,to:commit}),{reason:'invalid-record'});
 assert.throws(()=>record({...data,extra:true}),{reason:'invalid-record'});
 if(phase==='delivered'){assert.doesNotThrow(()=>record({...data,noop:true}));assert.throws(()=>record({...data,noop:'yes'}),{reason:'invalid-record'});}
 else assert.throws(()=>record({...data,noop:true}),{reason:'invalid-record'});
 }
 for(const phase of ['deliver-started','delivered'])for(const mode of ['squash','other'])assert.throws(()=>record({phase,mode,dest,from:commit,source:commit}),{reason:'invalid-record'});
});

test('cap-ending SHOULD fixes validate integration metadata',()=>{
 const commit='a'.repeat(40),reviewFix={review:'code-integration',round:3,generation:2,findings:['R3-F001'],from:commit};
 const record=(metadata:unknown)=>validateRecord({kind:'integrate',by:'tool',data:{phase:'fix',commit,reason:'repair accepted SHOULD',...(metadata===undefined?{}:{reviewFix:metadata})}});
 assert.doesNotThrow(()=>record(reviewFix));
 assert.doesNotThrow(()=>record(undefined));
 for(const invalid of [
  {...reviewFix,round:0},
  {...reviewFix,generation:-1},
  {...reviewFix,findings:[]},
  {...reviewFix,findings:['R3-F001',' ']},
  {...reviewFix,findings:['R3-F001','R3-F001']},
  {...reviewFix,from:'bad'},
  {...reviewFix,extra:true},
 ])assert.throws(()=>record(invalid),{reason:'invalid-record'});
 assert.throws(()=>validateRecord({kind:'integrate',by:'tool',data:{phase:'done',task:'T1',commit,reviewFix}}),{reason:'invalid-record'});
 assert.throws(()=>validateRecord({kind:'integrate',by:'tool',data:{phase:'opened',path:'p',branch:'b',base:commit,dest:{path:'repo',branch:'main'},reviewFix}}),{reason:'invalid-record'});
});

test('confirm records are user-only with a quote, a key and a spec hash', () => {
  const hash = 'sha256:' + 'a'.repeat(64);
  const confirm = (overrides: object) => ({kind: 'confirm', by: 'user', quote: 'Approved', key: 'confirm', data: {spec: hash}, ...overrides});
  assert.doesNotThrow(() => validateRecord(confirm({})));
  assert.throws(() => validateRecord(confirm({by: 'orchestrator'})), {reason: 'user-only'});
  assert.throws(() => validateRecord(confirm({quote: ' '})), {reason: 'user-only'});
  assert.throws(() => validateRecord(confirm({quote: undefined})), {reason: 'invalid-record'});
  assert.throws(() => validateRecord({kind: 'confirm', by: 'user', quote: 'Approved', data: {spec: hash}}), {reason: 'missing-key'});
  assert.throws(() => validateRecord(confirm({data: {spec: 'sha256:' + 'A'.repeat(64)}})), {reason: 'invalid-record'});
  assert.throws(() => validateRecord(confirm({data: {}})), {reason: 'invalid-record'});
});

test('ceiling resolution requires user quote', () => {
  const id = 'ceiling:plan-work.plan:4', key = id + ':resolved';
  const record = (overrides: object = {}) => ({kind: 'escalation', by: 'user', quote: 'User decision', key, data: {id, state: 'resolved', summary: 're-author: rewrite'}, ...overrides});
  assert.doesNotThrow(() => validateRecord(record()));
  assert.throws(() => validateRecord(record({by: 'orchestrator'})), {reason: 'user-only'});
  assert.throws(() => validateRecord(record({by: 'tool'})), {reason: 'user-only'});
  assert.throws(() => validateRecord(record({quote: ' '})), {reason: 'user-only'});
  const {quote, ...missing} = record();
  assert.throws(() => validateRecord(missing), {reason: 'user-only'});

  const recordWithSummary = (summary: string) => ({kind: 'escalation', by: 'user', quote: 'User decision', key: id + ':resolved', data: {id, state: 'resolved', summary}});
  for (const summary of ['raise the ceiling', ' re-author: rewrite', 'Re-author: rewrite', 'defer'])
    assert.throws(() => validateRecord(recordWithSummary(summary)), (error) => {
      const failure = error as Error & {reason: string};
      assert.equal(failure.reason, 'invalid-record');
      assert.match(failure.message, /data\.summary/);
      return true;
    }, summary);
  for (const summary of ['re-author: rewrite', 'model-effort: raise effort', 'relax-split: narrow scope', 'defer: rule remaining MUST deferred'])
    assert.doesNotThrow(() => validateRecord(recordWithSummary(summary)));

  const recordWithTarget = (targetId: string, summary: string) => ({kind: 'escalation', by: 'user', quote: 'User decision', key: targetId + ':resolved', data: {id: targetId, state: 'resolved', summary}});
  const code = 'ceiling:code-integration:4';
  assert.throws(() => validateRecord(recordWithTarget(code, 'defer: accept as follow-up')), (error) => {
    const failure = error as Error & {reason: string};
    assert.equal(failure.reason, 'invalid-record');
    assert.match(failure.message, /data\.id/);
    return true;
  });
  assert.doesNotThrow(() => validateRecord(recordWithTarget(code, 're-author: rewrite the fix')));
  assert.doesNotThrow(() => validateRecord(recordWithTarget('ceiling:design-strategy.design:6', 'defer: accept as follow-up')));
});

test('coverage override records require a quoted user decision in the exact summary grammar', () => {
  const id = 'coverage:code-integration:1';
  const record = (overrides: object = {}, data: object = {}) => ({kind: 'escalation', by: 'user', quote: 'User decision', key: id,
    data: {id, state: 'resolved', summary: 'accept: codex[0], opencode[1]', ...data}, ...overrides});
  assert.doesNotThrow(() => validateRecord(record()));
  assert.doesNotThrow(() => validateRecord(record({}, {summary: 'accept: codex[0]'})));
  assert.doesNotThrow(() => validateRecord(record({}, {summary: 'grant: provider restored'})));
  for (const by of ['orchestrator', 'tool']) assert.throws(() => validateRecord(record({by})), {reason: 'user-only'}, by);
  for (const quote of [' ', '']) assert.throws(() => validateRecord(record({quote})), {reason: 'user-only'});
  const {quote, ...unquoted} = record();
  assert.throws(() => validateRecord(unquoted), {reason: 'user-only'});
  const refused = (value: object, field: RegExp) => assert.throws(() => validateRecord(value), (error) => {
    const failure = error as Error & {reason: string};
    assert.equal(failure.reason, 'invalid-record');
    assert.match(failure.message, field);
    return true;
  });
  refused(record({}, {state: 'open'}), /data\.state/);
  for (const summary of ['accept:', 'accept: codex', 'accept: codex[0],opencode[1]', 'accept: codex[0], codex[0]', 'accept: codex[0], ', 'Accept: codex[0]',
    'accept codex[0]', ' accept: codex[0]', 'grant:', 'grant: ', 'grant:reason', 'defer: later', 're-author: split'])
    refused(record({}, {summary}), /data\.summary/);
  for (const bad of ['coverage:code-integration', 'coverage::1', 'coverage:code-integration:'])
    refused(record({}, {id: bad}), /data\.id/);
});

const correction = (data: object, extra: object = {}) => ({
  kind: 'ruling', by: 'orchestrator', key: 'correction',
  data: {subject: 'review:plan-work.plan:R1-F001', ruling: 'accepted', rationale: 'impact: the gate surfaces it', ...data}, ...extra,
});

test('severity correction refused: a lone dimension, an invalid value or a severity key', () => {
  assert.doesNotThrow(() => validateRecord(correction({impact: 'degrades', trigger: 'realistic'})));
  for (const data of [{impact: 'degrades'}, {trigger: 'realistic'}])
    assert.throws(() => validateRecord(correction(data)), {reason: 'invalid-record'});
  assert.throws(() => validateRecord(correction({impact: 'severe', trigger: 'realistic'})), error => {
    assert.equal((error as {reason: string}).reason, 'invalid-record');
    assert.match((error as Error).message, /data\.impact/);
    return true;
  });
  assert.throws(() => validateRecord(correction({impact: 'blocks', trigger: 'sometimes'})), /data\.trigger/);
  assert.throws(() => validateRecord(correction({impact: 'blocks', trigger: 'realistic', severity: 'MUST'})), error => {
    assert.equal((error as {reason: string}).reason, 'invalid-record');
    assert.match((error as Error).message, /data\.severity/);
    return true;
  });
  for (const ruling of ['rejected', 'duplicate', 'deferred'])
    assert.throws(() => validateRecord(correction({impact: 'blocks', trigger: 'realistic', ruling})), {reason: 'invalid-record'});
  assert.throws(() => validateRecord(correction({impact: 'blocks', trigger: 'realistic', subject: 'plan:T1'})), {reason: 'invalid-record'});
});

test('checkout rerun notes require a quoted user decision while keep notes accept any author', () => {
  const rerun = (overrides: object = {}) => ({kind: 'note', by: 'user', quote: 'Rerun the affected voices', key: 'repository-rerun:code-worktree-abc:1:12', data: {text: 'rerun'}, ...overrides});
  assert.doesNotThrow(() => validateRecord(rerun()));
  assert.throws(() => validateRecord(rerun({by: 'orchestrator'})), {reason: 'user-only'});
  assert.throws(() => validateRecord(rerun({by: 'tool'})), {reason: 'user-only'});
  assert.throws(() => validateRecord(rerun({quote: ' '})), {reason: 'user-only'});
  assert.throws(() => validateRecord(rerun({quote: ''})), {reason: 'user-only'});
  const keep = {kind: 'note', by: 'orchestrator', key: 'repository-changes:code-worktree-abc:1:99', data: {text: 'explained'}};
  assert.doesNotThrow(() => validateRecord(keep));
});

// SECTION: Repository rerun and change note keys.

test('repository note keys require a report suffix', () => {
  const rerun = (key: string) => ({kind: 'note', by: 'user', quote: 'Rerun the affected voices', key, data: {text: 'rerun'}});
  assert.doesNotThrow(() => validateRecord(rerun('repository-rerun:code-worktree-abc:1:12')));
  for (const key of ['repository-rerun:code-worktree-abc:1', 'repository-rerun:code-worktree-abc', 'repository-rerun:code-worktree-abc:1:x'])
    assert.throws(() => validateRecord(rerun(key)), {reason: 'invalid-record'});
  const change = (key: string) => ({kind: 'note', by: 'orchestrator', key, data: {text: 'explained'}});
  assert.doesNotThrow(() => validateRecord({kind: 'note', by: 'user', quote: 'q', key: 'repository-changes:code-worktree-abc:1:99', data: {text: 'explained'}}));
  assert.doesNotThrow(() => validateRecord(change('repository-changes:code-worktree-abc:1:99')));
  for (const key of ['repository-changes:code-worktree-abc:1', 'repository-changes:code-worktree-abc', 'repository-changes:code-worktree-abc:1:x'])
    assert.throws(() => validateRecord(change(key)), {reason: 'invalid-record'});
  assert.equal(parseRepositoryNoteKey('repository-changes:code-worktree-abc:1'), null);
  assert.equal(parseRepositoryNoteKey('repository-rerun:code-worktree-abc:1'), null);
  assert.deepEqual(parseRepositoryNoteKey('repository-changes:code-worktree-abc:1:99'), {kind: 'changes', review: 'code-worktree-abc', round: 1, reportSeq: 99});
  assert.deepEqual(parseRepositoryNoteKey('repository-rerun:code-worktree-abc:1:12'), {kind: 'rerun', review: 'code-worktree-abc', round: 1, reportSeq: 12});
});

test('malformed data errors include the kind allowed field shape within 1024 UTF-8 bytes', () => {
  const hash = 'sha256:' + 'a'.repeat(64);
  const git = 'a'.repeat(40);
  const cases: [Record<string, unknown>, RegExp][] = [
    [
      {kind: 'note', by: 'orchestrator', key: 'k', data: {text: 2}},
      /^data\.text is invalid; expected a non-blank string; allowed for note: an object with text$/,
    ],
    [
      {kind: 'bind', by: 'user', quote: 'yes', key: 'k', data: {spec: 's.spec.md'}},
      /^data is invalid; expected a spec and at least one plan or design; allowed for bind: an object with spec, plan\?, design\?$/,
    ],
    [
      {kind: 'evidence', by: 'tool', data: {criterion: 'SC1', commandDigest: hash, tree: 'bad', clean: true, before: git, after: git, exit: 0, path: 'p'}},
      /; allowed for evidence: an object with criterion, commandDigest, tree, clean, before, after, exit, path, artifacts\?$/,
    ],
    [
      {kind: 'writer', by: 'tool', data: {phase: 'finished', task: 'T1', launch: 1, candidate: 'bad'}},
      /; allowed for writer: an object with phase, task, launch, candidate$/,
    ],
    [
      {kind: 'integrate', by: 'tool', data: {phase: 'verification', cycle: 1, outcome: 'partial', head: git, reason: 'open', open: []}},
      /; allowed for integrate: an object with phase, cycle, outcome, head, reason, open, report\?, artifacts\?, dirty\?$/,
    ],
  ];
  for (const [record, pattern] of cases) {
    assert.throws(() => validateRecord(record), (error) => {
      const failure = error as Error & {reason: string};
      assert.equal(failure.reason, 'invalid-record');
      assert.match(failure.message, pattern);
      assert.ok(Buffer.byteLength(failure.message, 'utf8') <= 1024, failure.message);
      return true;
    });
  }
  assert.throws(() => validateRecord({kind: 'note', by: 'orchestrator', key: 'k', data: []}), (error) => {
    const failure = error as Error & {reason: string};
    assert.equal(failure.reason, 'invalid-record');
    assert.equal(failure.message, 'data is invalid; expected an object with text');
    return true;
  });

  for (const [kind, phaseSummary] of [
    ['writer', 'launched(task,path,base), finished(task,launch,candidate), abandoned(task,launch,reason)'],
    ['integrate', 'opened(path,branch,base,dest), verification(cycle,outcome,head,reason,open,report?,artifacts?,dirty?), test-cleanup(from,fromTree,to,removed,deleted,merged), started(task,candidate), conflict(task,paths), done(task,commit), abandoned(task,candidate,reason), fix(commit,reason,reviewFix?), deliver-started(mode,dest,from,source), delivered(mode,dest,from,source,noop?), committed(commit,source,differing?), closed(reason)'],
  ] as const) {
    const expectedSuffix = `; allowed for ${kind}: an object with phase: ${phaseSummary}`;
    for (const [data, prefix] of [
      [null, /^data is invalid; expected an object/],
      [[], /^data is invalid; expected an object/],
      [{}, /^data\.phase is invalid; expected one of /],
      [{phase: 'unknown'}, /^data\.phase is invalid; expected one of /],
    ] as const) {
      assert.throws(() => validateRecord({kind, by: 'tool', data}), (error) => {
        const failure = error as Error & {reason: string};
        assert.equal(failure.reason, 'invalid-record');
        assert.match(failure.message, prefix);
        assert.ok(failure.message.endsWith(expectedSuffix), failure.message);
        assert.ok(Buffer.byteLength(failure.message, 'utf8') <= 1024, failure.message);
        return true;
      });
    }
  }

  for (const [kind, key, expectedSuffix] of [
    ['note', 'k'.repeat(1100), '; allowed for note: an object with text'],
    ['evidence', 'é'.repeat(600), '; allowed for evidence: an object with criterion, commandDigest, tree, clean, before, after, exit, path, artifacts?'],
  ] as const) {
    assert.throws(() => validateRecord({kind, by: 'orchestrator', key: 'k', data: {[key]: 1}}), (error) => {
      const failure = error as Error & {reason: string};
      assert.equal(failure.reason, 'invalid-record');
      assert.ok(failure.message.endsWith(expectedSuffix), failure.message);
      assert.ok(Buffer.byteLength(failure.message, 'utf8') <= 1024, String(Buffer.byteLength(failure.message, 'utf8')));
      return true;
    });
  }
});
