import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { sessionFixture } from './helpers/session.ts';
import { appendRecord, queryLedger } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';

test('ledger bindings approvals and input filters preserve validation and retries', async () => {
 const {currentHashes,foldLedger,latest}=await import('../../../skills/dispatch/scripts/toolkit/ledger.ts');
 const f=sessionFixture();try{
 const input=f.artifact('record.json','');let n=0;
 const call=async(record:unknown)=>{f.lines.length=0;fs.writeFileSync(input,JSON.stringify(record));const exit=await main(['ledger','append','--session',f.session,input],f.deps);const output=f.output();return {exit,output,value:output.path?JSON.parse(fs.readFileSync(output.path,'utf8')):null};};
 const add=(kind:string,data:object,extra:object={})=>appendRecord(f.session,{kind,data,by:'orchestrator',key:'k'+n++,...extra},f.deps);
 const hash='sha256:'+'a'.repeat(64),git='a'.repeat(40);
 f.artifact('s.spec.md','spec');f.artifact('p.plan.md','plan');
 for(const spec of ['../escape','C:/absolute','missing'])await assert.rejects(add('bind',{spec,plan:'p.plan.md'}),{reason:'invalid-record'});
 const badBind=await call({kind:'bind',key:'bad-bind',by:'orchestrator',data:{spec:'missing',plan:'p.plan.md'}});assert.equal(badBind.exit,1);assert.equal(badBind.output.reason,'invalid-record');
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
 await assert.rejects(add('edit',{artifact:'design',before:hash,after:hash,class:'non-intent',affects:[],rationale:'r',diffRef:'d'}),{reason:'invalid-record'});
 fs.unlinkSync(path.join(f.root,'s.spec.md'));assert.equal((await call(binding)).value.deduped,true);
 for(const phase of ['deliver-started','delivered'])assert.ok((await add('integrate',{phase,dest:{branch:'b',path:'p'},to:git,...(phase==='deliver-started'?{from:git}:{})})).seq>0);
 f.lines.length=0;assert.equal(await main(['ledger','query','--session',f.session,'--kind','integrate'],f.deps),0);assert.equal(JSON.parse(fs.readFileSync(f.output().path!,'utf8')).length,2);
 for(const filter of [{kind:'bad'},{since:'-1'},{since:'wat'}])assert.throws(()=>queryLedger(foldLedger(f.session),filter),{reason:'invalid-input'});
 f.lines.length=0;assert.equal(await main(['ledger','query','--session',f.session,'--kind','bad'],f.deps),1);assert.equal(f.output().reason,'invalid-input');
 for(const file of ['missing',f.root]){f.lines.length=0;assert.equal(await main(['ledger','append','--session',f.session,file],f.deps),1);assert.equal(f.output().reason,'invalid-input');}
 fs.writeFileSync(input,'bad');f.lines.length=0;assert.equal(await main(['ledger','append','--session',f.session,input],f.deps),1);
 const ledger=path.join(f.session,'ledger.jsonl');const bytes=fs.readFileSync(ledger,'utf8');const first=JSON.parse(bytes.split('\n')[0]!);fs.appendFileSync(ledger,JSON.stringify(first)+'\n');const corrupt=fs.readFileSync(ledger,'utf8');await assert.rejects(add('note',{text:'n'}),{reason:'ledger-corrupt'});assert.equal(fs.readFileSync(ledger,'utf8'),corrupt);
 }finally{f.cleanup();}
});
