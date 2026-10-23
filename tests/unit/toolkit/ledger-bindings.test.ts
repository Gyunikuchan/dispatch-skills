import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { sessionFixture } from './helpers/session.ts';

test('ledger bindings approvals and input filters preserve validation and retries', async () => {
 const {currentHashes,foldLedger,latest}=await import('../../../skills/dispatch/scripts/toolkit/ledger.ts');
 const f=sessionFixture();try{
 const input=f.artifact('record.json','');let n=0;
 const call=async(record:unknown)=>{f.lines.length=0;fs.writeFileSync(input,JSON.stringify(record));const exit=await main(['ledger','append','--session',f.session,input],f.deps);const output=f.output();return {exit,output,value:output.path?JSON.parse(fs.readFileSync(output.path,'utf8')):null};};
 const add=(kind:string,data:object,extra:object={})=>call({kind,data,by:'orchestrator',key:'k'+n++,...extra});
 const hash='sha256:'+'a'.repeat(64),git='a'.repeat(40);
 f.artifact('s.spec.md','spec');f.artifact('p.plan.md','plan');
 for(const spec of ['../escape','C:/absolute','missing'])assert.equal((await add('bind',{spec,plan:'p.plan.md'})).output.reason,'invalid-record');
 const binding={kind:'bind',key:'bind',by:'orchestrator',data:{spec:'s.spec.md',plan:'p.plan.md'}};
 assert.equal((await call(binding)).exit,0);const hashes=currentHashes(f.root,latest(foldLedger(f.session),'bind'));
 assert.equal((await add('approval',{...hashes,design:hash},{by:'user',quote:'yes'})).output.reason,'approval-stale');
 f.artifact('d.design.md','design');assert.equal((await add('bind',{...binding.data,design:'d.design.md'})).exit,0);
 assert.equal((await add('approval',hashes,{by:'user',quote:'yes'})).output.reason,'approval-stale');
 assert.equal((await add('bind',binding.data)).exit,0);
 assert.equal((await add('approval',{spec:hashes.spec},{by:'user',quote:'yes'})).output.reason,'invalid-record');
 const approval={kind:'approval',key:'approval',by:'user',quote:'yes',data:hashes};const approved=await call(approval);assert.equal(approved.exit,0);
 f.artifact('p.plan.md','changed');assert.equal((await call(approval)).value.seq,approved.value.seq);
 assert.equal((await add('approval',hashes,{by:'user',quote:'yes'})).output.reason,'approval-stale');
 f.artifact('p.plan.md','plan');assert.ok((await call({...approval,key:'approval-again'})).value.seq>approved.value.seq);
 for(const ruling of ['X','Y','X'])assert.equal((await add('ruling',{subject:'s',ruling,rationale:'r'})).exit,0);
 for(const state of ['open','resolved','open'])assert.equal((await add('escalation',{id:'e',state,summary:'s'})).exit,0);
 assert.equal(latest(foldLedger(f.session),'escalation')?.data['state'],'open');
 assert.equal(foldLedger(f.session).records.filter(r=>r.kind==='ruling').length,3);
 assert.equal((await add('edit',{artifact:'design',before:hash,after:hash,class:'non-intent',affects:[],rationale:'r',diffRef:'d'})).output.reason,'invalid-record');
 fs.unlinkSync(path.join(f.root,'s.spec.md'));assert.equal((await call(binding)).value.deduped,true);
 for(const phase of ['deliver-started','delivered'])assert.equal((await add('integrate',{phase,dest:{branch:'b',path:'p'},to:git,...(phase==='deliver-started'?{from:git}:{})})).exit,0);
 f.lines.length=0;assert.equal(await main(['ledger','query','--session',f.session,'--kind','integrate'],f.deps),0);assert.equal(JSON.parse(fs.readFileSync(f.output().path!,'utf8')).length,2);
 for(const filter of [['--kind','bad'],['--since','-1'],['--since','wat']]){f.lines.length=0;assert.equal(await main(['ledger','query','--session',f.session,...filter],f.deps),1);assert.equal(f.output().reason,'invalid-input');}
 for(const file of ['missing',f.root]){f.lines.length=0;assert.equal(await main(['ledger','append','--session',f.session,file],f.deps),1);assert.equal(f.output().reason,'invalid-input');}
 fs.writeFileSync(input,'bad');f.lines.length=0;assert.equal(await main(['ledger','append','--session',f.session,input],f.deps),1);
 const ledger=path.join(f.session,'ledger.jsonl');const bytes=fs.readFileSync(ledger,'utf8');const first=JSON.parse(bytes.split('\n')[0]!);fs.appendFileSync(ledger,JSON.stringify(first)+'\n');const corrupt=fs.readFileSync(ledger,'utf8');assert.equal((await add('note',{text:'n'})).output.reason,'ledger-corrupt');assert.equal(fs.readFileSync(ledger,'utf8'),corrupt);
 }finally{f.cleanup();}
});
