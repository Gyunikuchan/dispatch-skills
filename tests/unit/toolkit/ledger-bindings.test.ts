import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { sessionFixture } from './helpers/session.ts';
import { appendRecord, currentHashes, foldLedger, gate, latest, queryLedger } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { KINDS } from '../../../skills/dispatch/scripts/toolkit/records.ts';

test('ledger bindings approvals and input filters preserve validation and retries', async () => {
 const f=sessionFixture({ memory: true });try{
 const input=f.artifact('record.json','');let n=0;
 const call=async(record:unknown)=>{f.lines.length=0;fs.writeFileSync(input,JSON.stringify(record));const exit=await main(['ledger','append','--session',f.session,input],f.deps);const output=f.output();return {exit,output,value:output.path?JSON.parse(fs.readFileSync(output.path,'utf8')):null};};
 const add=(kind:string,data:object,extra:object={})=>appendRecord(f.session,{kind,data,by:'orchestrator',key:'k'+n++,...extra},f.deps);
 const hash='sha256:'+'a'.repeat(64),git='a'.repeat(40);
 f.artifact('s.spec.md','spec');f.artifact('p.plan.md','plan');
 for(const spec of ['../escape','C:/absolute','missing'])await assert.rejects(add('bind',{spec,plan:'p.plan.md'}),{reason:'invalid-record'});
 const badBind=await call({kind:'bind',key:'bad-bind',by:'orchestrator',data:{spec:'missing',plan:'p.plan.md'}});assert.equal(badBind.exit,1);assert.equal(badBind.output.reason,'invalid-record');
 await assert.rejects(add('approval',{spec:hash,plan:hash},{by:'user',quote:'yes'}),{reason:'invalid-record',message:/append a bind record/});
 const binding={kind:'bind',key:'bind',by:'orchestrator',data:{spec:'s.spec.md',plan:'p.plan.md'}};
 assert.equal((await call(binding)).exit,0);const hashes=currentHashes(f.root,latest(foldLedger(f.session),'bind'));
 await assert.rejects(add('approval',{...hashes,design:hash},{by:'user',quote:'yes'}),{reason:'approval-stale'});
 f.artifact('d.design.md','design');assert.ok((await add('bind',{...binding.data,design:'d.design.md'})).seq>0);
 await assert.rejects(add('approval',hashes,{by:'user',quote:'yes'}),{reason:'approval-stale'});
 assert.ok((await add('bind',binding.data)).seq>0);
 await assert.rejects(add('approval',{spec:hashes.spec},{by:'user',quote:'yes'}),{reason:'invalid-record'});
 const approval={kind:'approval',key:'approval',by:'user',quote:'yes',data:hashes};const approved=await call(approval);assert.equal(approved.exit,0);
 f.artifact('p.plan.md','changed');assert.equal((await call(approval)).value.seq,approved.value.seq);
 await assert.rejects(add('approval',hashes,{by:'user',quote:'yes'}),{reason:'approval-stale'});
 f.artifact('p.plan.md','plan');assert.ok((await call({...approval,key:'approval-again'})).value.seq>approved.value.seq);
 for(const ruling of ['X','Y','X'])assert.ok((await add('ruling',{subject:'s',ruling,rationale:'r'})).seq>0);
 for(const state of ['open','resolved','open'])assert.ok((await add('escalation',{id:'e',state,summary:'s'})).seq>0);
 assert.equal(latest(foldLedger(f.session),'escalation')?.data['state'],'open');
 assert.equal(foldLedger(f.session).records.filter(r=>r.kind==='ruling').length,3);
 await assert.rejects(
  add('edit',{artifact:'design',before:hash,after:hash,class:'non-intent',affects:[],rationale:'r',diffRef:'d'}),
  (error:unknown)=>{
   const failure=error as {reason?:string;message?:string};
   assert.equal(failure.reason,'invalid-record');
   assert.match(failure.message??'',/append a bind record that includes it first/i);
   assert.match(failure.message??'',/currently bound artifact kinds:.*\bplan\b.*\bspec\b/i);
   return true;
  },
 );
 fs.unlinkSync(path.join(f.root,'s.spec.md'));assert.equal((await call(binding)).value.deduped,true);
 for(const phase of ['deliver-started','delivered'])assert.equal((await call({kind:'integrate',key:phase,by:'tool',data:{phase,mode:'uncommitted',dest:{branch:'b',path:'p'},from:git,source:git}})).exit,0);
 assert.equal(foldLedger(f.session).records.filter(r=>r.kind==='integrate'&&r.data['mode']==='uncommitted').length,2);
 f.lines.length=0;assert.equal(await main(['ledger','query','--session',f.session,'--kind','integrate'],f.deps),0);assert.equal(JSON.parse(fs.readFileSync(f.output().path!,'utf8')).length,2);
 const folded=foldLedger(f.session);
 assert.equal(queryLedger(folded,{kind:'integrate',since:'0'}).length,2);
 assert.equal(queryLedger(folded,{since:folded.records[0]!.seq}).length,folded.records.length-1);
 assert.equal(queryLedger(folded,{key:folded.records[0]!.key}).length,1);
 for(const filter of [{kind:'bad'},{since:'-1'},{since:'wat'}]){
  assert.throws(()=>queryLedger(folded,filter),(error:unknown)=>{
   const failure=error as {reason?:string;message?:string};
   assert.equal(failure.reason,'invalid-input');
   if(filter.kind==='bad')assert.equal(failure.message,`filter.kind must be one of: ${KINDS.join(', ')}.`);
   else assert.equal(failure.message,'filter.since must be a nonnegative safe integer.');
   return true;
  });
 }
 f.lines.length=0;assert.equal(await main(['ledger','query','--session',f.session,'--kind','bad'],f.deps),1);assert.equal(f.output().reason,'invalid-input');
 for(const file of ['missing',f.root]){f.lines.length=0;assert.equal(await main(['ledger','append','--session',f.session,file],f.deps),1);assert.equal(f.output().reason,'invalid-input');assert.equal(f.output().summary,'Cannot read record file '+path.resolve(file));}
 for(const extra of [[],[input,input]]){f.lines.length=0;assert.equal(await main(['ledger','append','--session',f.session,...extra],f.deps),1);assert.equal(f.output().reason,'invalid-input');assert.match(f.output().summary,/ledger append <record\.json>/);}
 fs.writeFileSync(input,'bad');f.lines.length=0;assert.equal(await main(['ledger','append','--session',f.session,input],f.deps),1);assert.equal(f.output().reason,'invalid-input');assert.ok(f.output().summary.startsWith('Record file '+path.resolve(input)+' is not valid JSON: '));
 const ledger=path.join(f.session,'ledger.jsonl');const bytes=fs.readFileSync(ledger,'utf8');const first=JSON.parse(bytes.split('\n')[0]!);fs.appendFileSync(ledger,JSON.stringify(first)+'\n');const corrupt=fs.readFileSync(ledger,'utf8');await assert.rejects(add('note',{text:'n'}),{reason:'ledger-corrupt'});assert.equal(fs.readFileSync(ledger,'utf8'),corrupt);
 }finally{f.cleanup();}
});
