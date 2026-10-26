import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateRecord } from '../../../skills/dispatch/scripts/toolkit/records.ts';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { sessionFixture } from './helpers/session.ts';

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
 ['integrate',{phase:'deliver-started',dest:{branch:'b',path:'p'},to:git},'from'],['integrate',{phase:'delivered',to:git},'dest'],
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

test('squash records require complete identities and preserve legacy shapes',()=>{
 const commit='a'.repeat(40),dest={path:'repo',branch:'main'};
 for(const phase of ['deliver-started','delivered']){
 const data={phase,mode:'squash',dest,from:commit,to:commit,source:commit};
 assert.doesNotThrow(()=>validateRecord({kind:'integrate',by:'tool',data}));
 for(const field of ['from','to','source','mode']){const partial:Record<string,unknown>={...data};delete partial[field];assert.throws(()=>validateRecord({kind:'integrate',by:'tool',data:partial}),{reason:'invalid-record'});}
 for(const field of ['from','to','source'])assert.throws(()=>validateRecord({kind:'integrate',by:'tool',data:{...data,[field]:'bad'}}),{reason:'invalid-record'});
 assert.throws(()=>validateRecord({kind:'integrate',by:'tool',data:{...data,mode:'other'}}),{reason:'invalid-record'});
 const legacy=phase==='delivered'?{phase,dest,to:commit}:{phase,dest,from:commit,to:commit};assert.doesNotThrow(()=>validateRecord({kind:'integrate',by:'tool',data:legacy}));
 }
});
