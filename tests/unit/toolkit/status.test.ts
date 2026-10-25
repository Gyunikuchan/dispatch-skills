import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { appendRecord, currentHashes, foldLedger, latest } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { sessionFixture } from './helpers/session.ts';

test('status report exposes bindings approval gate open escalations and torn tail without locking', async () => {
  const f = sessionFixture();
  try {
    f.artifact('mission.spec.md', 'mission');
    const plan = f.artifact('work.plan.md', 'plan');
    const append = (kind: string, key: string, data: unknown, by = 'orchestrator') => appendRecord(f.session, { kind, key, data, by, ...(by === 'user' ? { quote: 'approved' } : {}) }, f.deps);
    await append('bind', 'bind', { spec: 'mission.spec.md', plan: 'work.plan.md' });
    const hashes = currentHashes(f.root, latest(foldLedger(f.session), 'bind'));
    await append('approval', 'approval', hashes, 'user');
    await append('level', 'level', { level: 'high' });
    await append('escalation', 'open-a', { id: 'a', state: 'open', summary: 'first' });
    await append('escalation', 'close-a', { id: 'a', state: 'resolved', summary: 'done' });
    await append('escalation', 'open-b', { id: 'b', state: 'open', summary: 'pending' });
    const run = async () => {
      f.lines.length = 0;
      assert.equal(await main(['status', 'show', '--session', f.session], f.deps), 0);
      return JSON.parse(fs.readFileSync(f.output().path!, 'utf8'));
    };
    const report = await run();
    assert.equal(report.level, 'high');
    assert.deepEqual(report.bound, { spec: 'mission.spec.md', plan: 'work.plan.md' });
    assert.deepEqual(report.current, hashes);
    assert.deepEqual(report.approved, hashes);
    assert.deepEqual(report.gate, { allowed: true });
    assert.deepEqual(report.escalations, [{ id: 'b', state: 'open', summary: 'pending' }]);
    assert.equal(report.recordCount, 6);
    assert.equal(report.tornTail, false);
    fs.writeFileSync(plan, 'changed');
    fs.appendFileSync(path.join(f.session, 'ledger.jsonl'), '{torn');
    const changed = await run();
    assert.deepEqual(changed.gate, { allowed: false, reason: 'unrecorded-change', artifact: 'plan' });
    assert.equal(changed.tornTail, true);
    assert.equal(changed.recordCount, 6);
    assert.equal(fs.existsSync(path.join(f.session, '.state', 'lock')), false);
    assert.ok(fs.readFileSync(path.join(f.session, 'ledger.jsonl'), 'utf8').endsWith('{torn'));
  } finally { f.cleanup(); }
});

test('recovery status refuses transient success without a validated transition',async()=>{const PLAN=['# Work','## Task Map','| ID | Title | Outcome | Prerequisites | Criteria |','| --- | --- | --- | --- | --- |','| T1 | File | Works | none | SC1 |','## Proposed Changes','### T1 \u2014 File','#### [NEW] src/file.ts','- Purpose: behavior.','## Success Criteria','- [SC1] Works','  - Changes: src/file.ts','  - Verify: `node check`','  - Evidence: verify','## Verification Plan','### Automated Tests','- `node contract`'].join('\n');const {fakeGit}=await import('./helpers/fake-git.ts');const f=sessionFixture();try{
 f.artifact('mission.spec.md','mission');f.artifact('work.plan.md',PLAN.replace('  - Evidence: verify','  - Retain: transient\n  - Covered by: FINAL\n  - Evidence: verify'));await appendRecord(f.session,{kind:'bind',by:'tool',key:'bind',data:{spec:'mission.spec.md',plan:'work.plan.md'}},f.deps);
 const cwd=path.join(f.session,'.state/worktrees/integration');fs.mkdirSync(cwd,{recursive:true});const head='a'.repeat(40),tree='b'.repeat(40);f.deps.run=fakeGit({session:f.session,head,tree,testedTree:tree,changes:[],calls:[]});await appendRecord(f.session,{kind:'integrate',by:'tool',data:{phase:'opened',path:'.state/worktrees/integration',branch:'integration',base:head,dest:{path:f.root,branch:'main'}}},f.deps);
 await main(['status','show','--session',f.session],f.deps);const value=JSON.parse(fs.readFileSync(f.output().path!,'utf8'));assert.ok(value.criteria.includes('SC1'));assert.deepEqual(value.criterionStatuses.map((row:{state:string;reason:string})=>[row.state,row.reason]),[['missing','pruning-required'],['missing','pruning-required']]);
}finally{f.cleanup();}});


test('status retains missing automated criteria for manual completions and waivers',async()=>{const PLAN=['# Work','## Task Map','| ID | Title | Outcome | Prerequisites | Criteria |','| --- | --- | --- | --- | --- |','| T1 | File | Works | none | SC1 |','## Proposed Changes','### T1 \u2014 File','#### [NEW] src/file.ts','- Purpose: behavior.','## Success Criteria','- [SC1] Works','  - Changes: src/file.ts','  - Verify: `node check`','  - Evidence: verify','## Verification Plan','### Automated Tests','- `node contract`'].join('\n');const {fakeGit}=await import('./helpers/fake-git.ts');
 for(const kind of ['manual-complete','waiver']){const f=sessionFixture();try{
  f.artifact('mission.spec.md','mission');f.artifact('work.plan.md',PLAN);await appendRecord(f.session,{kind:'bind',key:'bind',by:'tool',data:{spec:'mission.spec.md',plan:'work.plan.md'}},f.deps);
  const cwd=path.join(f.session,'.state/worktrees/integration');fs.mkdirSync(cwd,{recursive:true});const head='a'.repeat(40),tree='b'.repeat(40);f.deps.run=fakeGit({session:f.session,head,tree,testedTree:tree,changes:[],calls:[]});await appendRecord(f.session,{kind:'integrate',key:'opened',by:'tool',data:{phase:'opened',path:'.state/worktrees/integration',branch:'integration',base:head,dest:{path:f.root,branch:'main'}}},f.deps);
  await appendRecord(f.session,{kind,key:kind,by:'user',quote:'accepted',data:{criterion:'SC1',...(kind==='waiver'?{reason:'accepted risk'}:{evidence:'reviewed'})}},f.deps);
  await main(['status','show','--session',f.session],f.deps);const value=JSON.parse(fs.readFileSync(f.output().path!,'utf8'));assert.ok(value.criteria.includes('SC1'),JSON.stringify(value));assert.equal(value.criterionStatuses.find((row:{criterion:string})=>row.criterion==='SC1').state,kind==='waiver'?'waived':'manual');
 }finally{f.cleanup();}}
});
