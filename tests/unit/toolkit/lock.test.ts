import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { sessionFixture } from './helpers/session.ts';

test('session lock waits refuses reclaims and releases on failure', async () => {
 const f=sessionFixture();try {
 const state=path.join(f.session,'.state');fs.mkdirSync(state);const lock=path.join(state,'lock');
 const input=f.artifact('r.json',JSON.stringify({kind:'note',key:'a',by:'tool',data:{text:'ok'}}));
 const run=async()=>{f.lines.length=0;return main(['ledger','append','--session',f.session,input],f.deps);};
 f.deps.isAlive=()=>true;fs.writeFileSync(lock,JSON.stringify({pid:99,host:f.deps.host,at:'now',tool:'test'}));assert.equal(await run(),3);assert.equal(f.sleeps.reduce((a,b)=>a+b,0),10000);assert.match(f.output().summary,/99/);
 f.deps.isAlive=()=>false;assert.equal(await run(),0);assert.equal(fs.existsSync(lock),false);const records=fs.readFileSync(path.join(f.session,'ledger.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x));assert.equal(records[0].kind,'note');assert.equal(records[0].by,'tool');assert.equal(records.length,2);
 fs.writeFileSync(input,'{"kind":"bad"}');assert.equal(await run(),1);assert.equal(fs.existsSync(lock),false);
 fs.writeFileSync(lock,JSON.stringify({pid:99,host:'foreign',at:'now',tool:'test'}));assert.equal(await run(),3);assert.equal(fs.existsSync(lock),true);fs.unlinkSync(lock);
 const breaker=path.join(state,'lock.break');fs.writeFileSync(input,JSON.stringify({kind:'note',key:'b',by:'tool',data:{text:'ok'}}));
 f.deps.isAlive=pid=>pid===999;fs.writeFileSync(breaker,JSON.stringify({pid:999,host:f.deps.host,at:'now'}));assert.equal(await run(),3);assert.match(f.output().summary,/999/);assert.equal(fs.existsSync(breaker),true);
 f.deps.isAlive=()=>false;fs.writeFileSync(breaker,JSON.stringify({pid:999,host:'foreign',at:'now'}));assert.equal(await run(),3);assert.equal(fs.existsSync(breaker),true);
 fs.writeFileSync(breaker,JSON.stringify({pid:999,host:f.deps.host,at:'now'}));
 f.deps.isAlive=()=>false;fs.writeFileSync(lock,JSON.stringify({pid:999,host:f.deps.host,at:'now',tool:'test'}));
 assert.equal(await run(),0);assert.deepEqual(fs.readdirSync(state).filter(x=>x.startsWith('lock')).sort(),['lock.break']);assert.equal(JSON.parse(fs.readFileSync(breaker,'utf8')).pid,999);
 }finally{f.cleanup();}
});

test('session lock skips dead breaker slots without displacing a live breaker', async () => {
 const f=sessionFixture();try{
 const state=path.join(f.session,'.state');fs.mkdirSync(state);const lock=path.join(state,'lock');
 const dead=JSON.stringify({pid:999,host:f.deps.host,at:'dead'}),live=JSON.stringify({pid:7,host:f.deps.host,at:'live'});
 fs.writeFileSync(path.join(state,'lock.break'),dead);fs.writeFileSync(path.join(state,'lock.break.1'),live);
 fs.writeFileSync(lock,JSON.stringify({pid:998,host:f.deps.host,at:'old',tool:'old'}));
 const input=f.artifact('r.json',JSON.stringify({kind:'note',key:'a',by:'tool',data:{text:'ok'}}));
 f.deps.isAlive=pid=>pid===7;
 assert.equal(await main(['ledger','append','--session',f.session,input],f.deps),3);assert.match(f.output().summary,/pid 7 /);
 assert.equal(fs.readFileSync(path.join(state,'lock.break'),'utf8'),dead);assert.equal(fs.readFileSync(path.join(state,'lock.break.1'),'utf8'),live);
 assert.equal(JSON.parse(fs.readFileSync(lock,'utf8')).pid,998);assert.equal(fs.existsSync(path.join(state,'lock.break.2')),false);
 fs.unlinkSync(path.join(state,'lock.break.1'));f.lines.length=0;
 assert.equal(await main(['ledger','append','--session',f.session,input],f.deps),0);
 assert.deepEqual(fs.readdirSync(state).filter(x=>x.startsWith('lock')).sort(),['lock.break']);
 }finally{f.cleanup();}
});

test('session lock stale contenders preserve the replacement owner', async () => {
 const f=sessionFixture();try{
 const state=path.join(f.session,'.state');fs.mkdirSync(state);const file=path.join(state,'lock');
 fs.writeFileSync(file,JSON.stringify({pid:99,host:f.deps.host,at:'old',tool:'old'}));
 const a=f.artifact('a.json',JSON.stringify({kind:'note',key:'a',by:'tool',data:{text:'A'}}));
 const b=f.artifact('b.json',JSON.stringify({kind:'note',key:'b',by:'tool',data:{text:'B'}}));
 let first:Promise<number>|undefined;
 const contender={...f.deps,pid:43,isAlive:(pid:number)=>pid===42,sleep:async()=>{assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).pid,42);assert.equal(await first,0);}};
 contender.isAlive=(pid:number)=>{if(pid===99&&!first)first=main(['ledger','append','--session',f.session,a],f.deps);return pid===42;};
 assert.equal(await main(['ledger','append','--session',f.session,b],contender),0);
 const records=fs.readFileSync(path.join(f.session,'ledger.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x));
 assert.deepEqual(records.map(r=>r.seq),[1,2,3]);assert.deepEqual(records.slice(1).map(r=>r.data.text),['A','B']);assert.equal(fs.existsSync(file),false);
 }finally{f.cleanup();}
});
