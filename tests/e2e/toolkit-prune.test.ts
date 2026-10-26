import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {transientRepo as prepared,captureIntegrationReview as review,transientTarget as target,toolkitRepo,transientPlanSource} from './helpers/toolkit-repo.ts';
import {foldLedger,appendRecord} from '../../skills/dispatch/scripts/toolkit/ledger.ts';
test('transient pruning preserves caller safety',async()=>{const r=await prepared();try{
 const caller=r.git(['rev-parse','HEAD']);assert.equal((await r.run(['worktree','deliver'])).output.reason,'pruning-required');
 assert.equal((await r.run(['worktree','prune'])).output.reason,'prune-review-required');assert.ok(fs.existsSync(path.join(r.integration,target)));
 const must={id:'R1-F001',severity:'MUST',locus:'src/file.ts:L1',defect:'Missing protection',requiredChange:'Protect state',sources:['reviewer'],scope:'in'};
 let dir=review(r,1,[must]);assert.equal((await r.run(['worktree','prune'])).output.reason,'prune-review-required');
 await appendRecord(r.session,{kind:'ruling',by:'orchestrator',key:'deferred',data:{subject:'review:code-integration:R1-F001',ruling:'deferred',rationale:'Pending evidence'}},r.deps);assert.equal((await r.run(['worktree','prune'])).output.reason,'prune-review-required');
 await appendRecord(r.session,{kind:'ruling',by:'orchestrator',key:'rejected',data:{subject:'review:code-integration:R1-F001',ruling:'rejected',rationale:'The retained contract directly protects state; reviewed source src/file.ts:L1'}},r.deps);
 dir=review(r,1,[must,{...must,id:'R1-F002'}]);await appendRecord(r.session,{kind:'ruling',by:'orchestrator',key:'duplicate',data:{subject:'review:code-integration:R1-F002',ruling:'duplicate',rationale:'R1-F001 is the same protected contract'}},r.deps);
 const metadataFile=path.join(dir,'round.json'),metadata=fs.readFileSync(metadataFile,'utf8');fs.writeFileSync(metadataFile,metadata.replace('Full review','Partial review'));assert.equal((await r.run(['worktree','prune'])).output.reason,'prune-review-required');fs.writeFileSync(metadataFile,metadata);
 const slotFile=path.join(dir,'gen-1/slots/reviewer.json'),slot=fs.readFileSync(slotFile,'utf8');fs.writeFileSync(slotFile,JSON.stringify({slot:'reviewer',state:'failed'}));assert.equal((await r.run(['worktree','prune'])).output.reason,'prune-review-required');fs.writeFileSync(slotFile,slot);
 await appendRecord(r.session,{kind:'escalation',by:'tool',key:'open',data:{id:'scope',state:'open',summary:'Scope unresolved'}},r.deps);assert.equal((await r.run(['worktree','prune'])).output.reason,'prune-review-required');await appendRecord(r.session,{kind:'escalation',by:'tool',key:'resolved',data:{id:'scope',state:'resolved',summary:'Scope settled'}},r.deps);
 const unrelated=path.join(r.integration,'src/file.ts'),bytes=fs.readFileSync(unrelated);const p=await r.run(['worktree','prune']);assert.equal(p.output.ok,true,JSON.stringify(p));assert.equal(fs.existsSync(path.join(r.integration,target)),false);assert.equal(r.git(['rev-parse','HEAD']),caller);assert.deepEqual(fs.readFileSync(unrelated),bytes);
 assert.equal((await r.run(['worktree','deliver'])).output.reason,'final-checks-required');assert.equal((await r.run(['verify','run','--final'])).output.ok,true);
 assert.equal((await r.run(['worktree','deliver'],point=>{if(point==='deliver:before-ff')fs.writeFileSync(unrelated,'late edit');})).output.reason,'prune-transition-stale');assert.equal(r.git(['rev-parse','HEAD']),caller);fs.writeFileSync(unrelated,bytes);
 assert.equal((await r.run(['worktree','deliver'])).output.ok,true);assert.equal(fs.existsSync(path.join(r.root,target)),false);
 const status=await r.run(['report','complete']);assert.equal(status.output.ok,true,JSON.stringify(status));assert.match(status.value.statuses[0].reason,/historical pre-prune/);
}finally{r.cleanup();}});
test('transient pruning recovers after durable boundaries',async()=>{
 for(const boundary of ['prune:before-journal','prune:after-journal','prune:after-delete','prune:after-commit']) {
  const r=await prepared();try{review(r);
   assert.equal((await r.run(['worktree','prune'],p=>{if(p===boundary)throw Error('crash');})).exit,2);
   const unrelated=path.join(r.integration,'new.txt');fs.writeFileSync(unrelated,'unrelated');const refused=await r.run(['worktree','prune']);assert.equal(refused.output.ok,false);assert.equal(fs.readFileSync(unrelated,'utf8'),'unrelated');fs.unlinkSync(unrelated);
   assert.equal((await r.run(['worktree','prune'])).output.ok,true);
   const head=r.git(['rev-parse','HEAD'],r.integration);assert.equal((await r.run(['worktree','prune'])).output.ok,true);assert.equal(r.git(['rev-parse','HEAD'],r.integration),head);
   assert.equal(foldLedger(r.session).records.filter(x=>x.data['phase']==='pruned').length,1);
   if(boundary==='prune:before-journal'){assert.equal((await r.run(['verify','run','--final'],p=>{if(p==='verify:after-evidence')throw Error('crash');})).exit,2);assert.equal((await r.run(['worktree','deliver'])).output.reason,'final-checks-required');}
   assert.equal((await r.run(['verify','run','--final'])).output.ok,true);
  }finally{r.cleanup();}
 }
});

test('pruning preconditions preserve the integrated tree',async()=>{const r=await prepared();try{
 const file=path.join(r.integration,target),head=r.git(['rev-parse','HEAD'],r.integration),caller=r.git(['rev-parse','HEAD']);
 review(r);
 fs.writeFileSync(path.join(r.integration,'dirty'),'work');
 const result=await r.run(['worktree','prune']);
 assert.equal(result.output.reason,'integration-dirty');
 assert.equal(r.git(['rev-parse','HEAD'],r.integration),head);
 assert.equal(r.git(['rev-parse','HEAD']),caller);
 assert.equal(fs.readFileSync(file,'utf8'),'step\n');
 assert.equal(foldLedger(r.session).records.some(x=>x.data['phase']==='prune-started'),false);
}finally{r.cleanup();}});

test('pruning validates every target and rechecks swapped ancestors',async()=>{
 const second='tests/late.transient.test.ts';
 const source=transientPlanSource.replace('- Purpose: implements behavior.','- Purpose: implements behavior.\n#### [NEW] '+second+'\n- Purpose: second isolated step.').replace('  - Changes: '+target,'  - Changes: '+target+', '+second).replace('  - Tests: '+target,'  - Tests: '+target+', '+second);
 const r=await prepared(source,{[second]:'second\n'});try{review(r);
 const tests=path.join(r.integration,'tests'),backup=path.join(r.session,'retained-tests');
 const swap=()=>{fs.renameSync(tests,backup);fs.symlinkSync(backup,tests,process.platform==='win32'?'junction':'dir');};
 const restore=()=>{if(process.platform==='win32')fs.rmdirSync(tests);else fs.unlinkSync(tests);fs.renameSync(backup,tests);};
 swap();try{assert.equal((await r.run(['worktree','prune'])).output.ok,false);assert.equal(foldLedger(r.session).records.some(x=>x.data['phase']==='prune-started'),false);assert.equal(fs.readFileSync(path.join(backup,path.basename(target)),'utf8'),'step\n');}finally{restore();}
 let swapped=0;const refused=await r.run(['worktree','prune'],point=>{if(point==='prune:before-unlink'&&++swapped===2){swap();}});assert.equal(refused.output.reason,'unsafe-transient-target');assert.equal(fs.readFileSync(path.join(backup,path.basename(target)),'utf8'),'step\n');restore();assert.equal((await r.run(['worktree','prune'])).output.ok,true);
}finally{r.cleanup();}});

test('stale pruning preserves artifact corrections and requires fresh final checks',async()=>{const r=await prepared();try{review(r);const pruned=await r.run(['worktree','prune']);assert.equal(pruned.output.ok,true);assert.equal((await r.run(['verify','run','--final'])).output.ok,true);
 const artifact=path.join(r.root,'work.plan.md');const corrected=transientPlanSource.replace('`node -e "process.exit(0)"` [FINAL]',`\`node -e "process.exit(require('fs').readdirSync('tests').length?0:7)"\` [FINAL]`);fs.writeFileSync(artifact,corrected);
 assert.equal((await r.run(['worktree','deliver'])).output.reason,'prune-transition-stale');assert.equal(fs.readFileSync(artifact,'utf8'),corrected);
 const restored=r.git(['show',pruned.value.from+':'+target],r.integration);fs.mkdirSync(path.dirname(path.join(r.integration,target)),{recursive:true});fs.writeFileSync(path.join(r.integration,target),restored+'\n');assert.equal((await r.run(['worktree','commit','--reason','restore declared source target for artifact correction'])).output.ok,true);
 assert.equal((await r.run(['verify','run'])).output.ok,true);review(r,2);assert.equal((await r.run(['worktree','prune'])).output.ok,true);const final=await r.run(['verify','run','--final']);assert.equal(final.output.reason,'checks-failed');assert.equal((await r.run(['worktree','deliver'])).output.reason,'final-checks-required');assert.equal(foldLedger(r.session).records.filter(x=>x.data['phase']==='pruned').length,2);assert.equal(fs.readFileSync(artifact,'utf8'),corrected);
}finally{r.cleanup();}});

test('accepted fixes require a fresh review of the exact integration HEAD',async()=>{const r=await prepared();try{
 const finding={id:'R1-F001',severity:'MUST',locus:target+':L1',defect:'Incorrect intermediate assertion',requiredChange:'Fix the assertion',sources:['reviewer'],scope:'in'};review(r,1,[finding]);await appendRecord(r.session,{kind:'ruling',by:'orchestrator',key:'accept',data:{subject:'review:code-integration:R1-F001',ruling:'accepted',rationale:'The intermediate assertion is wrong'}},r.deps);assert.equal((await r.run(['worktree','prune'])).output.reason,'prune-review-required');
 fs.writeFileSync(path.join(r.integration,target),'fixed assertion\n');assert.equal((await r.run(['worktree','commit','--reason','fix accepted assertion'])).output.ok,true);assert.equal((await r.run(['verify','run'])).output.ok,true);assert.equal((await r.run(['worktree','prune'])).output.reason,'prune-review-required');review(r,2);assert.equal((await r.run(['worktree','prune'])).output.ok,true);
}finally{r.cleanup();}});


test('squash completion requires verified pruned delivery',async()=>{
 const support='tests/helpers/shared.ts';
 const source=transientPlanSource.replace('| none | SC1 |','| none | SC1, SC2 |').replace('## Success Criteria','#### [NEW] '+support+'\n- Purpose: retained shared helper.\n\n## Success Criteria').replace('  - Changes: '+target,'  - Changes: '+target+', '+support).replace('  - Tests: '+target,'  - Tests: '+target+', '+support).replace('## Verification Plan','- [SC2] Coverage review\n  - Changes: '+support+'\n  - Evidence: review\n  - Review: inspect retained coverage\n\n## Verification Plan');
 const r=await prepared(source,{[support]:'retained helper\n'});try{
  const skill=path.join(r.session,'stub-skill');fs.mkdirSync(skill);fs.cpSync(path.join(r.deps.skillRoot,'references'),path.join(skill,'references'),{recursive:true});
  fs.writeFileSync(path.join(skill,'config.jsonc'),JSON.stringify({'read-delegates':{claude:{targets:[{low:{model:'stub'}}]}},phases:{'code-review':{targets:{low:1},rounds:{low:3}}}}));r.deps.skillRoot=skill;r.deps.liveness={claude:true};r.deps.orchestrator=null;
  r.deps.delegate=async()=>({outcome:{status:'ok',text:JSON.stringify({status:'CLEAN',findings:[]}),resume:null,sessionId:null},invocations:[]});
  const produced=await r.run(['review','run','integration','--kind','code']);assert.equal(produced.output.ok,true,JSON.stringify(produced));
  assert.equal((await r.run(['worktree','prune'])).output.ok,true);assert.equal(fs.existsSync(path.join(r.integration,target)),false);assert.equal(fs.readFileSync(path.join(r.integration,support),'utf8'),'retained helper\n');
  assert.equal((await r.run(['report','complete'])).output.reason,'criteria-unmet');
  await appendRecord(r.session,{kind:'manual-complete',by:'user',quote:'reviewed manually',key:'manual-step',data:{criterion:'SC1',evidence:'manual review'}},r.deps);
  const waiting=await r.run(['status','show']);assert.ok(waiting.value.criteria.includes('SC1'));assert.equal(waiting.value.criterionStatuses.find((row:{criterion:string})=>row.criterion==='SC1').state,'manual');
  assert.equal((await r.run(['verify','run','--final'])).output.ok,true);const rows=foldLedger(r.session).records.filter(row=>row.kind==='evidence');assert.equal(rows.some(row=>row.data['criterion']==='final:SC2'),false);
  const delivered=await r.run(['worktree','deliver']);assert.equal(delivered.output.ok,true);assert.equal(delivered.value.source,r.git(['rev-parse','HEAD'],r.integration));assert.notEqual(delivered.value.source,delivered.value.to);assert.equal(r.git(['rev-parse','HEAD^{tree}']),r.git(['rev-parse','HEAD^{tree}'],r.integration));const completed=await r.run(['report','complete']);assert.equal(completed.output.ok,true,JSON.stringify(completed));assert.equal(completed.value.statuses.find((row:{criterion:string})=>row.criterion==='SC2').state,'verified');
 }finally{r.cleanup();}
});

test('pruning accepts a session ancestor alias while preserving owned-path link guards',async()=>{
 const r=await prepared();const alias=r.root+'-alias';try{
  review(r);fs.symlinkSync(r.root,alias,process.platform==='win32'?'junction':'dir');
  const lines:string[]=[];const {main}=await import('../../skills/dispatch/scripts/toolkit/cli.ts');const exit=await main(['worktree','prune','--session',path.join(alias,path.basename(r.session))],{...r.deps,stdout:line=>lines.push(line)});assert.equal(exit,0,lines.join('\n'));assert.equal(fs.existsSync(path.join(r.integration,target)),false);
  const held=path.join(r.session,'held-integration');fs.renameSync(r.integration,held);try{fs.symlinkSync(held,r.integration,process.platform==='win32'?'junction':'dir');assert.equal((await r.run(['worktree','prune'])).output.reason,'unsafe-integration');}finally{if(process.platform==='win32')fs.rmdirSync(r.integration);else fs.unlinkSync(r.integration);fs.renameSync(held,r.integration);}
 }finally{if(fs.existsSync(alias)){if(process.platform==='win32')fs.rmdirSync(alias);else fs.unlinkSync(alias);}r.cleanup();}
});
