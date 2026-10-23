import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { sessionFixture } from './helpers/session.ts';

test('ledger records preserve retries and recover torn tails', async () => {
 const f=sessionFixture(); try {
 const input=f.artifact('record.json','');
 const call=async (record:unknown) => {f.lines.length=0; fs.writeFileSync(input,JSON.stringify(record)); const exit=await main(['ledger','append','--session',f.session,input],f.deps); const o=f.output(); return {exit,o,value:o.path?JSON.parse(fs.readFileSync(o.path,'utf8')):null};};
 const note={kind:'note',by:'orchestrator',key:'a',data:{text:'hello'}};
 assert.equal((await call(note)).value.seq,1);
 const ledger=path.join(f.session,'ledger.jsonl'); const bytes=fs.readFileSync(ledger,'utf8');
 assert.equal(fs.existsSync(path.join(f.session,'.state/ledger.jsonl')),false);
 assert.equal((await call(note)).value.deduped,true); assert.equal(fs.readFileSync(ledger,'utf8'),bytes);
 assert.equal((await call({...note,data:{text:'other'}})).o.reason,'key-conflict');
 fs.appendFileSync(ledger,'{"torn":'); assert.equal((await call(note)).value.seq,1); assert.equal(fs.readFileSync(ledger,'utf8'),bytes+'{"torn":');
 assert.equal((await call({...note,key:'b'})).value.seq,2); assert.equal(fs.readFileSync(path.join(f.session,'ledger.torn-1.jsonl'),'utf8'),'{"torn":');
 assert.equal(fs.existsSync(path.join(f.session,'.state/ledger.torn-1.jsonl')),false);
 for(const record of [{...note,kind:'unknown'},{...note,data:{text:'hello',extra:1}},{...note,by:'bad'},{...note,key:''}]) assert.equal((await call(record)).o.reason,'invalid-record');
 assert.equal((await call({...note,key:undefined})).o.reason,'missing-key');
 for(const field of ['toString','__proto__']) {
  const record=JSON.parse('{"kind":"note","by":"orchestrator","key":"inherited-'+field+'","data":{"text":"hello","'+field+'":"extra"}}');
  assert.equal((await call(record)).o.reason,'invalid-record');
 }
 assert.equal((await call({kind:'waiver',by:'orchestrator',data:{criterion:'SC1',reason:'ok'}})).o.reason,'user-only');
 const waiver={kind:'waiver',by:'user',quote:'approve',data:{criterion:'SC1',reason:'ok'}}; const first=await call(waiver); assert.equal((await call(waiver)).value.seq,first.value.seq);
 fs.appendFileSync(ledger,'bad\n{}\n'); assert.equal((await call({...note,key:'c'})).o.reason,'ledger-corrupt');
 } finally {f.cleanup();}
});

test('ledger bind suffixes match their keys while prior retries stay write-free', async () => {
 const f=sessionFixture();try{
 const input=f.artifact('record.json','');f.artifact('s.spec.md','spec');f.artifact('p.plan.md','plan');f.artifact('d.design.md','design');
 const append=async(record:object)=>{f.lines.length=0;fs.writeFileSync(input,JSON.stringify(record));return main(['ledger','append','--session',f.session,input],f.deps);};
 const bind={kind:'bind',key:'bind',by:'orchestrator',data:{spec:'s.spec.md',plan:'p.plan.md',design:'d.design.md'}};
 const ledger=path.join(f.session,'ledger.jsonl');
 for(const [kind,file]of [['spec','p.plan.md'],['plan','s.spec.md'],['design','p.plan.md']]){
  assert.equal(await append({...bind,data:{...bind.data,[kind!]:file}}),1);
  assert.equal(f.output().reason,'invalid-record');assert.match(f.output().summary,new RegExp('data\\.'+kind));
  assert.equal(fs.existsSync(ledger),false);
 }
 assert.equal(await append(bind),0);const bytes=fs.readFileSync(ledger,'utf8');fs.unlinkSync(path.join(f.root,'s.spec.md'));
 assert.equal(await append(bind),0);assert.equal(fs.readFileSync(ledger,'utf8'),bytes);
 const legacy={...bind,key:'legacy',data:{spec:'p.plan.md',plan:'p.plan.md'}};
 const prior=bytes+JSON.stringify({...legacy,seq:2,at:'now'})+'\n';fs.writeFileSync(ledger,prior);
 assert.equal(await append(legacy),0);assert.equal(JSON.parse(fs.readFileSync(f.output().path!,'utf8')).deduped,true);assert.equal(fs.readFileSync(ledger,'utf8'),prior);
 }finally{f.cleanup();}
});

test('ledger records reject escaping links and allow contained links', async () => {
 const f=sessionFixture(),outside=sessionFixture();try{
 const input=f.artifact('record.json','');const linked=path.join(f.root,'linked');
 // Junctions permit a linked-directory case on Windows without elevation.
 fs.symlinkSync(f.session,linked,process.platform==='win32'?'junction':'dir');
 fs.writeFileSync(path.join(f.session,'s.spec.md'),'spec');f.artifact('p.plan.md','plan');
 const append=async(key:string)=>{f.lines.length=0;fs.writeFileSync(input,JSON.stringify({kind:'bind',key,by:'orchestrator',data:{spec:'linked/s.spec.md',plan:'p.plan.md'}}));return main(['ledger','append','--session',f.session,input],f.deps);};
 assert.equal(await append('contained'),0);
 outside.artifact('s.spec.md','outside spec');fs.unlinkSync(linked);fs.symlinkSync(outside.root,linked,process.platform==='win32'?'junction':'dir');
 assert.equal(await append('escaped'),1);assert.equal(f.output().reason,'invalid-record');assert.match(f.output().summary,/data.spec/);
 fs.unlinkSync(linked);
 }finally{f.cleanup();outside.cleanup();}
});
