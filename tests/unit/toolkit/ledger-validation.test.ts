import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
 for(const [kind,data,field]of invalid){const r=await add(kind,data,{by:'user',quote:'yes'});assert.equal(r.output.reason,'invalid-record');assert.match(r.output.summary,new RegExp(field));}
 for(const kind of ['approval','level','bind','escalation','edit','ruling','note']){
 const data:Record<string,object>={approval:{spec:hash,plan:hash},level:{level:'low'},bind:{spec:'s',plan:'p'},escalation:{id:'i',state:'open',summary:'s'},edit:{artifact:'plan',before:hash,after:hash,class:'non-intent',affects:[],rationale:'r',diffRef:'d'},ruling:{subject:'s',ruling:'r',rationale:'r'},note:{text:'n'}};
 assert.equal((await add(kind,data[kind]!,{key:undefined,by:'user',quote:'yes'})).output.reason,'missing-key');
 }
 for(const level of ['xhigh','max'])assert.equal((await add('level',{level},{by:'user',quote:' '})).output.reason,'user-only');
 }finally{f.cleanup();}
});
