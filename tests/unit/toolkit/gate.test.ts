import { test } from 'node:test';
import assert from 'node:assert/strict';

test('level gate requires the latest matching user selection for extreme levels', async () => {
  const {levelGate,gate}=await import('../../../skills/dispatch/scripts/toolkit/ledger.ts');
  const fold=(level?:string,by='user')=>({records:level?[{seq:1,kind:'level',data:{level},by,key:'level',at:'now'}]:[],lastSeq:level?1:0,torn:null});
  for(const level of ['xhigh','max']) {
    for(const f of [fold(),fold(level,'orchestrator'),fold(level==='max'?'xhigh':'max')]) {
      assert.deepEqual(levelGate(f,level),{allowed:false,reason:'level-unapproved'});
      assert.equal(gate(f,{},level).reason,'level-unapproved');
    }
    assert.deepEqual(levelGate(fold(level),level),{allowed:true});
    assert.deepEqual(levelGate(fold(level)),{allowed:true});
  }
  for(const level of ['low','medium','high']) assert.deepEqual(levelGate(fold(),level),{allowed:true});
});

test('approval gate follows edit chains and refuses broken authority', async () => {
  const {gate}=await import('../../../skills/dispatch/scripts/toolkit/ledger.ts');
  const record = (seq: number, kind: string, data: object, by = 'orchestrator') => ({seq, kind, data, by, key: String(seq), at: 'now'});
  const bind = record(1, 'bind', {spec: 's', plan: 'p'});
  const confirm = record(2, 'confirm', {spec: 's0'}, 'user');
  const approval = record(3, 'approval', {spec: 's0', plan: 'p0'}, 'user');
  const fold = (records: any[]) => ({records, torn: null, lastSeq: records.length});
  assert.deepEqual(gate(fold([bind, confirm]), {spec:'s0',plan:'p0'}), {allowed:false,reason:'missing-approval'});
  assert.deepEqual(gate(fold([bind, confirm]), {spec:'s0',plan:'p0'}, 'low'), {allowed:true});
  const edit = (seq:number, before:string, after:string, klass='non-intent') => record(seq,'edit',{artifact:'plan',before,after,class:klass});
  for (const klass of ['intent','dependency','discard']) assert.equal(gate(fold([bind,confirm,approval,edit(4,'p0','p1',klass)]),{spec:'s0',plan:'p1'}).reason,'intent-change');
  for (const current of ['p1',null]) assert.equal(gate(fold([bind,confirm,approval]),{spec:'s0',plan:current}).reason,'unrecorded-change');
  assert.equal(gate(fold([bind,confirm,approval,edit(4,'wrong','p1')]),{spec:'s0',plan:'p1'}).reason,'unrecorded-change');
  assert.deepEqual(gate(fold([bind,confirm,approval,edit(4,'p0','p1'),edit(5,'p1','p0')]),{spec:'s0',plan:'p0'}),{allowed:true});
  assert.deepEqual(gate(fold([bind,confirm,approval,edit(4,'p0','p1','intent'),{...approval,seq:5}]),{spec:'s0',plan:'p0'}),{allowed:true});
  assert.equal(gate(fold([{...bind,data:{...bind.data,design:'d'}},confirm,approval]),{spec:'s0',plan:'p0',design:'d0'}).reason,'missing-approval');
  for (const level of ['xhigh','max'] as const) {
    assert.equal(gate(fold([bind,confirm,approval]),{spec:'s0',plan:'p0'},level).reason,'level-unapproved');
    assert.deepEqual(gate(fold([bind,confirm,approval,record(4,'level',{level},'user')]),{spec:'s0',plan:'p0'},level),{allowed:true});
  }
});

test('confirm gate refuses without a matching user confirm at every level', async () => {
  const {gate}=await import('../../../skills/dispatch/scripts/toolkit/ledger.ts');
  const record = (seq: number, kind: string, data: object, by = 'orchestrator') => ({seq, kind, data, by, key: String(seq), at: 'now'});
  const bind = record(1, 'bind', {spec: 's', plan: 'p'});
  const fold = (records: any[]) => ({records, torn: null, lastSeq: records.length});
  for (const level of ['low', 'medium', 'high'] as const) {
    assert.deepEqual(gate(fold([bind]), {spec:'s0',plan:'p0'}, level), {allowed:false,reason:'missing-confirmation'});
    assert.deepEqual(gate(fold([bind, record(2, 'confirm', {spec: 's1'}, 'user')]), {spec:'s0',plan:'p0'}, level), {allowed:false,reason:'missing-confirmation'});
    assert.deepEqual(gate(fold([bind, record(2, 'confirm', {spec: 's0'}, 'user')]), {plan:'p0'}, level), {allowed:false,reason:'missing-confirmation'});
  }
  assert.deepEqual(gate(fold([]), {}, 'low'), {allowed:false,reason:'missing-confirmation'});
});

test('confirm gate carries non-intent spec edits forward and refuses intent edits', async () => {
  const {gate}=await import('../../../skills/dispatch/scripts/toolkit/ledger.ts');
  const record = (seq: number, kind: string, data: object, by = 'orchestrator') => ({seq, kind, data, by, key: String(seq), at: 'now'});
  const bind = record(1, 'bind', {spec: 's', plan: 'p'});
  const confirm = record(2, 'confirm', {spec: 's0'}, 'user');
  const approval = record(3, 'approval', {spec: 's0', plan: 'p0'}, 'user');
  const specEdit = (seq: number, before: string, after: string, klass: string) => record(seq, 'edit', {artifact: 'spec', before, after, class: klass});
  const fold = (records: any[]) => ({records, torn: null, lastSeq: records.length});
  assert.deepEqual(gate(fold([bind, confirm, specEdit(3, 's0', 's1', 'non-intent')]), {spec:'s1',plan:'p0'}, 'low'), {allowed:true});
  assert.deepEqual(gate(fold([bind, confirm, approval, specEdit(4, 's0', 's1', 'non-intent')]), {spec:'s1',plan:'p0'}), {allowed:true});
  assert.deepEqual(gate(fold([bind, confirm, specEdit(3, 's0', 's1', 'intent')]), {spec:'s1',plan:'p0'}, 'low'), {allowed:false,reason:'missing-confirmation'});
  assert.deepEqual(gate(fold([bind, confirm, approval, specEdit(4, 's0', 's1', 'intent')]), {spec:'s1',plan:'p0'}), {allowed:false,reason:'missing-confirmation'});
  const reconfirm = record(4, 'confirm', {spec: 's1'}, 'user');
  assert.deepEqual(gate(fold([bind, confirm, specEdit(3, 's0', 's1', 'intent'), reconfirm]), {spec:'s1',plan:'p0'}, 'low'), {allowed:true});
});
