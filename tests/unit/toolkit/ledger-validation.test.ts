import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateRecord } from '../../../skills/dispatch/scripts/toolkit/records.ts';
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
 const f=sessionFixture();try{
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

test('invalid-record rejections name the field and its expected shape', () => {
  const hash='sha256:'+'a'.repeat(64);
  const cases: [unknown,RegExp][]=[
    [{kind:'approval',by:'user',quote:'q',data:{plan:hash}},/^data\.spec is invalid; expected required sha256:<64 lowercase hex>$/],
    [{kind:'level',by:'user',quote:'q',key:'k',data:{level:'huge'}},/^data\.level is invalid; expected one of low, medium, high, xhigh, max$/],
    [{kind:'writer',by:'tool',data:{phase:'bad'}},/^data\.phase is invalid; expected one of launched, finished, abandoned$/],
    [{kind:'writer',by:'tool',data:{phase:'launched',task:'t',path:'p'}},/^data\.base is invalid; expected required an object with commit, taskSection, seq$/],
    [{kind:'evidence',by:'tool',data:{clean:'yes'}},/^data\.criterion is invalid; expected required a non-blank string$/],
    [{kind:'note',by:'tool',quote:7,data:{text:'t'}},/^record\.quote is invalid; expected a string$/],
    [{kind:'integrate',by:'tool',data:{phase:'prune-started',operation:hash,artifacts:{spec:hash,plan:hash},from:'a'.repeat(40),sourceTree:'a'.repeat(40),targets:[],pre:{},final:[],review:hash}},/^data\.pre is invalid; expected an array of an object with criterion, commands, commandDigest$/],
  ];
  for(const [record,message] of cases)assert.throws(()=>validateRecord(record),(error: Error)=>message.test(error.message),String(message));
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
