import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { sessionFixture } from './helpers/session.ts';

test('session lock skips dead breaker slots without displacing a live breaker', async () => {
 const f=sessionFixture({ memory: true });try{
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
 const f=sessionFixture({ memory: true });try{
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
