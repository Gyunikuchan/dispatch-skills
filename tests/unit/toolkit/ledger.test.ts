import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { appendRecord, appendRecords, currentHashes, foldLedger, type Fold } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { validateRecord } from '../../../skills/dispatch/scripts/toolkit/records.ts';
import { sessionFixture } from './helpers/session.ts';

const ledgerFile = (session: string) => path.join(session, 'ledger.jsonl');
const note = (key: string, text = key) => ({ kind: 'note', key, by: 'orchestrator', data: { text } });
const reasonOf = (error: unknown) => (error as { reason?: string }).reason;

test('ledger records preserve retries and recover torn tails', async () => {
 const f=sessionFixture({ memory: true }); try {
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
 const waiver={kind:'waiver',by:'user',quote:'approve',data:{criterion:'SC1',reason:'ok'}}; const first=await call(waiver); assert.equal((await call(waiver)).value.seq,first.value.seq);
 fs.appendFileSync(ledger,'bad\n{}\n'); assert.equal((await call({...note,key:'c'})).o.reason,'ledger-corrupt');
 } finally {f.cleanup();}
});


test('ledger append processes record arrays atomically', async () => {
  const stored = {kind:'note',key:'stored-note',by:'orchestrator',data:{text:'stored'},seq:2,at:'1970-01-01T00:00:00.000Z',batchEndSeq:3};
  assert.equal((validateRecord(stored,true) as {batchEndSeq?:number}).batchEndSeq,3);
  assert.throws(() => validateRecord({...stored,batchEndSeq:1},true), error => reasonOf(error)==='invalid-record');
  assert.throws(() => validateRecord({kind:'note',key:'unstored',by:'orchestrator',data:{text:'unstored'},batchEndSeq:3}), error => reasonOf(error)==='invalid-record');

  // SECTION: sequential in-memory fold
  const f = sessionFixture({memory:true});
  try {
    f.artifact('mission.spec.md','# Mission\n');f.artifact('work.plan.md','# Work\n');
    const bind = {kind:'bind',key:'bind',by:'orchestrator',data:{spec:'mission.spec.md',plan:'work.plan.md'}};
    const hashes = currentHashes(f.root,bind);
    const records = [
      {kind:'level',key:'level-high',by:'orchestrator',data:{level:'high'}},
      bind,
      {kind:'confirm',key:'confirm-spec',by:'user',quote:'confirmed',data:{spec:hashes.spec}},
      {kind:'approval',key:'approval-artifacts',by:'user',quote:'approved',data:{spec:hashes.spec,plan:hashes.plan}},
    ];
    const commits: Fold[] = [];
    const result = await appendRecords(f.session,records,f.deps,{onCommit:fold=>{
      commits.push(fold);
      assert.deepEqual(fold.records.map(row=>row.seq),[1,2,3,4]);
      assert.equal(fs.existsSync(path.join(f.session,'.state','lock')),true);
    }});
    assert.deepEqual(result,{seq:4,deduped:false,count:4,results:[
      {seq:1,deduped:false},{seq:2,deduped:false},{seq:3,deduped:false},{seq:4,deduped:false},
    ]});
    assert.equal(commits.length,1);
    assert.equal(fs.existsSync(path.join(f.session,'.state','lock')),false);
    const fold = foldLedger(f.session);
    assert.deepEqual(fold.records.map(row=>row.seq),[1,2,3,4]);
    assert.equal(fold.records.some(row=>'batchEndSeq' in row),false);
    const raw = fs.readFileSync(ledgerFile(f.session),'utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(raw.map(row=>row.batchEndSeq),[4,4,4,4]);
  } finally {f.cleanup();}

  // SECTION: bind validation rejects every batch item before any write
  const g = sessionFixture({memory:true});
  try {
    g.artifact('mission.spec.md','# Mission\n');g.artifact('work.plan.md','# Work\n');g.artifact('strategy.design.md','# Strategy\n');
    const bind = {kind:'bind',key:'bind',by:'orchestrator',data:{spec:'mission.spec.md',plan:'work.plan.md'}};
    const cases: [object, RegExp][] = [
      [{...bind,data:{...bind.data,plan:'../escape.plan.md'}},/data\.plan/],
      [{...bind,data:{...bind.data,plan:'strategy.design.md'}},/data\.plan/],
      [{...bind,data:{...bind.data,plan:'missing.plan.md'}},/data\.plan/],
      [{...bind,data:{...bind.data,plan:path.join(g.root,'work.plan.md')}},/data\.plan/],
    ];
    for (const [record, pattern] of cases) {
      await assert.rejects(appendRecords(g.session,[record,note('after-bind')],g.deps),error =>
        reasonOf(error)==='invalid-record' && pattern.test((error as Error).message));
      assert.equal(fs.existsSync(ledgerFile(g.session)),false);
    }
  } finally {g.cleanup();}

  // SECTION: an outside-repository symlink fails the batch bind check
  const h = sessionFixture(),outside = sessionFixture();
  try {
    const linked = path.join(h.root,'linked');
    h.artifact('mission.spec.md','# Mission\n');outside.artifact('escape.plan.md','# Outside\n');
    fs.symlinkSync(outside.root,linked,process.platform==='win32'?'junction':'dir');
    const bind = {kind:'bind',key:'bind',by:'orchestrator',data:{spec:'mission.spec.md',plan:'linked/escape.plan.md'}};
    await assert.rejects(appendRecords(h.session,[bind,note('after-bind')],h.deps),error =>
      reasonOf(error)==='invalid-record' && /data\.plan/.test((error as Error).message));
    assert.equal(fs.existsSync(ledgerFile(h.session)),false);
    fs.unlinkSync(linked);
  } finally {h.cleanup();outside.cleanup();}

  // SECTION: onCommit and AppendResult shapes
  const r = sessionFixture({memory:true});
  try {
    const rulings = [
      {kind:'ruling',key:'ruling-F001',by:'orchestrator',data:{subject:'review:plan-work.plan:R1-F001',ruling:'accepted',rationale:'Fixed'}},
      {kind:'ruling',key:'ruling-F002',by:'orchestrator',data:{subject:'review:plan-work.plan:R1-F002',ruling:'deferred',rationale:'Later'}},
    ];
    const committed: number[] = [];
    const result = await appendRecords(r.session,rulings,r.deps,{onCommit:fold=>{
      committed.push(fold.lastSeq);
      assert.equal(fs.existsSync(path.join(r.session,'.state','lock')),true);
    }});
    assert.deepEqual(result,{seq:2,deduped:false,count:2,results:[{seq:1,deduped:false},{seq:2,deduped:false}]});
    const retried = await appendRecords(r.session,rulings,r.deps,{onCommit:fold=>committed.push(fold.lastSeq)});
    assert.deepEqual(retried,{seq:2,deduped:true,count:2,results:[{seq:1,deduped:true},{seq:2,deduped:true}]});
    assert.deepEqual(committed,[2,2]);
    const mixed = await appendRecords(r.session,[rulings[0],note('mixed-note')],r.deps);
    assert.deepEqual(mixed,{seq:3,deduped:false,count:2,results:[{seq:1,deduped:true},{seq:3,deduped:false}]});
    const single = await appendRecords(r.session,note('single-note'),r.deps);
    assert.deepEqual(single,{seq:4,deduped:false});
    assert.deepEqual(await appendRecords(r.session,note('single-note'),r.deps),{seq:4,deduped:true});

    // SECTION: failed batches leave the ledger byte-identical
    const before = fs.readFileSync(ledgerFile(r.session),'utf8');
    await assert.rejects(appendRecords(r.session,[note('conflict','first'),note('conflict','second')],r.deps),error => reasonOf(error)==='key-conflict');
    assert.equal(fs.readFileSync(ledgerFile(r.session),'utf8'),before);
    await assert.rejects(appendRecords(r.session,[note('valid-then-invalid'),{kind:'note',key:'bad',by:'orchestrator',data:{}}],r.deps),error => reasonOf(error)==='invalid-record');
    assert.equal(fs.readFileSync(ledgerFile(r.session),'utf8'),before);
    assert.equal(foldLedger(r.session).records.some(row=>row.key==='valid-then-invalid'),false);

    // SECTION: a short write closes the handle and truncates to baseSize
    const closeDescriptor = Object.getOwnPropertyDescriptor(fs,'closeSync')!;
    const closeSync = fs.closeSync;
    const closed: number[] = [];
    let failedHandle: number | undefined;
    Object.defineProperty(fs,'closeSync',{...closeDescriptor,value:(fd:number)=>{closed.push(fd);return closeSync(fd);}});
    try {
      let calls = 0;
      await assert.rejects(appendRecords(r.session,[note('short-a'),note('short-b')],r.deps,{writeBatch(handle,buffer,offset){
        failedHandle = handle;
        calls++;
        if (calls > 1) return 0;
        fs.writeSync(handle,buffer.subarray(offset,offset+4));
        return 4;
      }}),/short write/);
    } finally {Object.defineProperty(fs,'closeSync',{...closeDescriptor,value:closeSync});}
    assert.ok(failedHandle!==undefined && closed.includes(failedHandle));
    assert.equal(fs.readFileSync(ledgerFile(r.session),'utf8'),before);

    // SECTION: an fsync failure truncates to baseSize by path
    const fsyncDescriptor = Object.getOwnPropertyDescriptor(fs,'fsyncSync')!;
    const fsyncSync = fs.fsyncSync;
    let fsyncFailures = 0;
    Object.defineProperty(fs,'fsyncSync',{...fsyncDescriptor,value:()=>{fsyncFailures++;throw new Error('fsync failed');}});
    try {
      await assert.rejects(appendRecords(r.session,[note('fsync-a'),note('fsync-b')],r.deps),/fsync failed/);
    } finally {Object.defineProperty(fs,'fsyncSync',{...fsyncDescriptor,value:fsyncSync});}
    assert.ok(fsyncFailures>=1);
    assert.equal(fs.readFileSync(ledgerFile(r.session),'utf8'),before);
  } finally {r.cleanup();}

  // SECTION: unlocked readers hide a batch until its final newline
  const w = sessionFixture({memory:true});
  try {
    await appendRecord(w.session,note('base'),w.deps);
    const base = fs.readFileSync(ledgerFile(w.session),'utf8');
    let mid: {records:number;torn:string|null} | undefined;
    let first = true;
    const result = await appendRecords(w.session,[note('one'),note('two')],w.deps,{writeBatch(handle,buffer,offset,length){
      const written = fs.writeSync(handle,buffer,offset,length);
      if (first) {
        first = false;
        const fold = foldLedger(w.session);
        mid = {records:fold.records.length,torn:fold.torn?.toString()??null};
      }
      return written;
    }});
    assert.deepEqual(result.results,[{seq:2,deduped:false},{seq:3,deduped:false}]);
    assert.deepEqual(mid,{records:1,torn:fs.readFileSync(ledgerFile(w.session),'utf8').slice(base.length,-1)});
    assert.deepEqual(foldLedger(w.session).records.map(row=>row.key),['base','one','two']);
  } finally {w.cleanup();}

  // SECTION: a crash before the final newline quarantines the whole batch prefix
  const at = '1970-01-01T00:00:00.000Z';
  const baseLine = JSON.stringify({kind:'note',key:'base',by:'orchestrator',data:{text:'base'},seq:1,at})+'\n';
  const c = sessionFixture({memory:true});
  try {
    const first = JSON.stringify({kind:'note',key:'orphan',by:'orchestrator',data:{text:'orphan'},seq:2,at,batchEndSeq:3})+'\n';
    fs.writeFileSync(ledgerFile(c.session),baseLine+first);
    const hidden = foldLedger(c.session);
    assert.deepEqual(hidden.records.map(row=>row.key),['base']);
    assert.equal(hidden.torn?.toString(),first);
    assert.deepEqual(await appendRecord(c.session,note('recovered'),c.deps),{seq:2,deduped:false});
    assert.equal(fs.readFileSync(path.join(c.session,'ledger.torn-1.jsonl'),'utf8'),first);
    assert.deepEqual(foldLedger(c.session).records.map(row=>row.key),['base','recovered']);
  } finally {c.cleanup();}

  const b = sessionFixture({memory:true});
  try {
    const first = JSON.stringify({kind:'note',key:'orphan-one',by:'orchestrator',data:{text:'one'},seq:2,at,batchEndSeq:3})+'\n';
    const second = JSON.stringify({kind:'note',key:'orphan-two',by:'orchestrator',data:{text:'two'},seq:3,at,batchEndSeq:3});
    fs.writeFileSync(ledgerFile(b.session),baseLine+first+second);
    assert.equal(foldLedger(b.session).torn?.toString(),first+second);
    const result = await appendRecords(b.session,[note('batch-a'),note('batch-b')],b.deps);
    assert.deepEqual(result,{seq:3,deduped:false,count:2,results:[{seq:2,deduped:false},{seq:3,deduped:false}]});
    assert.equal(fs.readFileSync(path.join(b.session,'ledger.torn-1.jsonl'),'utf8'),first+second);
    assert.deepEqual(foldLedger(b.session).records.map(row=>row.key),['base','batch-a','batch-b']);
  } finally {b.cleanup();}

  // SECTION: an empty or non-object batch is refused before any write
  const e = sessionFixture({memory:true});
  try {
    await assert.rejects(appendRecords(e.session,[],e.deps),error =>
      reasonOf(error)==='invalid-record' && /non-empty array/.test((error as Error).message));
    for (const input of [[null],[1],['note']]) {
      await assert.rejects(appendRecords(e.session,input,e.deps),error => reasonOf(error)==='invalid-record');
    }
    assert.equal(fs.existsSync(ledgerFile(e.session)),false);
  } finally {e.cleanup();}
});
