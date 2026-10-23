import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toolkitRepo, planSource } from './helpers/toolkit-repo.ts';
import { foldLedger } from '../../skills/dispatch/scripts/toolkit/ledger.ts';

const twoTasks=planSource.replace('| T1 | File | Works | none | SC1 |','| T1 | File | Works | none | SC1 |\n| T2 | Other | Works | none | SC2 |').replace('## Success Criteria','### T2 — Other\n#### [MODIFY] src/file.ts\n- Purpose: other.\n\n## Success Criteria').replace('## Verification Plan','- [SC2] Other works\n  - Changes: src/file.ts\n  - Verify: `node -e "process.exit(0)"`\n  - Evidence: verify\n\n## Verification Plan');
type Repo=Awaited<ReturnType<typeof toolkitRepo>>;
const rows=(r: Repo,phase: string)=>foldLedger(r.session).records.filter(x=>x.kind==='integrate' && x.data['phase']===phase);
async function candidate(r: Repo,task='T1',text='writer\n') {
  const made=await r.run(['worktree','create',task]); assert.equal(made.exit,0);
  fs.writeFileSync(path.join(r.session,made.value.path,'src/file.ts'),text);
  const submitted=await r.run(['worktree','submit',task]); assert.equal(submitted.exit,0); return submitted.value.candidate as string;
}
const crash=(point: string)=>(at: string)=>{if(at===point) throw new Error('simulated crash');};
describe('toolkit integration',()=>{
  it('gates picks and reconciles a completed pick once',async()=>{
    const r=await toolkitRepo(); try {
      const hash=await candidate(r); assert.equal((await r.run(['worktree','integrate','T1'])).output.reason,'missing-approval');
      await r.approve(); assert.equal((await r.run(['worktree','integrate','T1'],crash('integrate:after-pick'))).exit,2);
      assert.equal((await r.run(['worktree','integrate','T1'])).exit,0); assert.equal(rows(r,'done').length,1);
      assert.ok(r.git(['log','-1','--format=%B'],r.integration).includes('(cherry picked from commit '+hash+')'));
      assert.equal((await r.run(['worktree','integrate','T1'])).output.reason,'no-candidate');
    } finally {r.cleanup();}
  });
  it('retries a recorded start before the pick and blocks another task',async()=>{
    const r=await toolkitRepo(twoTasks); try {
      await r.level(); await candidate(r); await candidate(r,'T2','second\n');
      const base=r.deps.run; let stopped=false;
      r.deps.run=async(argv,opts)=>{if(argv[1]==='cherry-pick' && argv[2]==='-x' && !stopped){stopped=true; throw new Error('before pick');} return base(argv,opts);};
      assert.equal((await r.run(['worktree','integrate','T1'])).exit,2);
      assert.equal((await r.run(['worktree','integrate','T2'])).output.reason,'integration-pending');
      assert.equal((await r.run(['worktree','integrate','T1'])).exit,0); assert.equal(rows(r,'done').length,1);
    } finally {r.cleanup();}
  });
  for(const finish of ['continue','abort'] as const) it('recovers '+finish+' after a resolved conflict commit',async()=>{
    const r=await toolkitRepo(twoTasks); try {
      await r.level(); await candidate(r); await candidate(r,'T2','second\n');
      fs.writeFileSync(path.join(r.integration,'src/file.ts'),'integration\n');
      assert.equal((await r.run(['worktree','commit','--reason','prepare conflict'])).exit,0);
      const conflict=await r.run(['worktree','integrate','T1']); assert.equal(conflict.exit,0); assert.equal(conflict.output.reason,'conflict'); assert.deepEqual(conflict.value.paths,['src/file.ts']);
      assert.equal((await r.run(['worktree','integrate','T1'])).output.reason,'conflict');
      assert.equal((await r.run(['worktree','continue','T1'])).output.reason,'unresolved-conflict');
      fs.writeFileSync(path.join(r.integration,'src/file.ts'),'resolved\n'); r.git(['add','src/file.ts'],r.integration);
      const before=r.git(['write-tree'],r.integration), beforeHead=r.git(['rev-parse','HEAD'],r.integration), ledger=fs.readFileSync(path.join(r.session,'ledger.jsonl'),'utf8');
      for(const action of ['continue','abort']) assert.equal((await r.run(['worktree',action,'T2',...(action==='abort'?['--reason','wrong']:[])])).output.reason,'wrong-task');
      assert.equal(r.git(['write-tree'],r.integration),before); assert.equal(fs.readFileSync(path.join(r.session,'ledger.jsonl'),'utf8'),ledger);
      assert.equal(r.git(['rev-parse','HEAD'],r.integration),beforeHead);
      assert.equal((await r.run(['worktree','continue','T1'],crash('continue:after-commit'))).exit,2);
      const head=r.git(['rev-parse','HEAD'],r.integration);
      const recovered=await r.run(['worktree',finish,'T1',...(finish==='abort'?['--reason','recover']:[])]);
      assert.equal(recovered.exit,finish==='abort'?4:0); if(finish==='abort')assert.equal(recovered.output.reason,'already-integrated');
      assert.equal(r.git(['rev-parse','HEAD'],r.integration),head); assert.equal(rows(r,'done').length,1); assert.equal(rows(r,'abandoned').length,0);
    } finally {r.cleanup();}
  });
  it('acknowledges staleness and rejects a dirty integration tree',async()=>{
    const r=await toolkitRepo(); try {
      await r.level(); await candidate(r); const bind=foldLedger(r.session).records.find(x=>x.kind==='bind')!;
      const {currentHashes}=await import('../../skills/dispatch/scripts/toolkit/ledger.ts'); const hashes=currentHashes(r.root,bind);
      await r.edit({artifact:'plan',before:hashes.plan,after:hashes.plan,class:'non-intent',affects:['T1'],rationale:'changed context',diffRef:'none'});
      assert.equal((await r.run(['worktree','integrate','T1'])).output.reason,'stale-candidate');
      fs.writeFileSync(path.join(r.integration,'extra'),'dirty'); assert.equal((await r.run(['worktree','integrate','T1','--ack-stale','reviewed'])).output.reason,'integration-dirty'); fs.rmSync(path.join(r.integration,'extra'));
      assert.equal((await r.run(['worktree','integrate','T1','--ack-stale','reviewed'])).exit,0);
      assert.equal(foldLedger(r.session).records.find(x=>x.kind==='ruling')!.data['rationale'],'reviewed');
    } finally {r.cleanup();}
  });
  it('aborts conflicts and pending candidates while preserving their commits',async()=>{
    const r=await toolkitRepo(twoTasks); try {
      await r.level(); const hash=await candidate(r); const other=await candidate(r,'T2','second\n');
      fs.writeFileSync(path.join(r.integration,'src/file.ts'),'integration\n'); await r.run(['worktree','commit','--reason','conflict']);
      await r.run(['worktree','integrate','T1']);
      assert.equal((await r.run(['worktree','abort','T1','--reason','reject'])).exit,0);
      const {currentHashes}=await import('../../skills/dispatch/scripts/toolkit/ledger.ts');
      const hashes=currentHashes(r.root,foldLedger(r.session).records.find(x=>x.kind==='bind'));
      await r.edit({artifact:'plan',before:hashes.plan,after:hashes.plan,class:'non-intent',affects:['T2'],rationale:'changed context',diffRef:'none'});
      assert.equal((await r.run(['worktree','integrate','T2'])).output.reason,'stale-candidate');
      assert.equal((await r.run(['worktree','abort','T2','--reason','reject'])).exit,0);
      assert.equal(r.git(['rev-parse','refs/dispatch/test/abandoned/T1-1']),hash); assert.equal(r.git(['rev-parse','refs/dispatch/test/abandoned/T2-1']),other);
      assert.equal((await r.run(['worktree','abort','T1','--reason','again'])).output.reason,'no-candidate');
      const made=await r.run(['worktree','create','T1']); assert.equal(made.exit,0); assert.equal(r.git(['rev-parse','HEAD'],path.join(r.session,made.value.path)),r.git(['rev-parse','HEAD'],r.integration));
    } finally {r.cleanup();}
  });
  it('records already applied candidates when abort follows a pick crash',async()=>{
    const r=await toolkitRepo(); try {await r.level(); await candidate(r); await r.run(['worktree','integrate','T1'],crash('integrate:after-pick')); assert.equal((await r.run(['worktree','abort','T1','--reason','recover'])).output.reason,'already-integrated'); assert.equal(rows(r,'done').length,1); assert.equal(rows(r,'abandoned').length,0);}finally{r.cleanup();}
  });
  it('recovers fix records only from matching fix trailers',async()=>{
    const r=await toolkitRepo(); try {
      await r.run(['worktree','create','T1']); assert.equal((await r.run(['worktree','commit','--reason','fix'])).output.reason,'no-changes');
      fs.writeFileSync(path.join(r.integration,'src/file.ts'),'fixed\n'); assert.equal((await r.run(['worktree','commit','--reason','fix'],crash('commit:after-commit'))).exit,2);
      const head=r.git(['rev-parse','HEAD'],r.integration); assert.equal((await r.run(['worktree','commit','--reason','fix'])).exit,0); assert.equal(rows(r,'fix').length,1); assert.equal(r.git(['rev-parse','HEAD'],r.integration),head);
      r.git(['commit','--allow-empty','-m','dispatch fix: other'],r.integration); assert.equal((await r.run(['worktree','commit','--reason','other'])).output.reason,'no-changes'); assert.equal(rows(r,'fix').length,1);
      for(const action of ['commit','abort']) assert.equal((await r.run(['worktree',action,...(action==='abort'?['T1']:[])])).output.reason,'invalid-input');
    }finally{r.cleanup();}
  });
});
