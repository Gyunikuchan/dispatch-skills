import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {sessionFixture} from './helpers/session.ts';
import {main} from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import {appendRecord} from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import {validateTargets,prunePreconditions,recoveryAllowed,pruneProjection,pruneTransition} from '../../../skills/dispatch/scripts/toolkit/prune.ts';
import {parsePlan} from '../../../skills/dispatch/scripts/toolkit/domain/plan.ts';
const source=['# Work','## Task Map','| ID | Title | Outcome | Prerequisites | Criteria |','| --- | --- | --- | --- | --- |','| T1 | File | Works | none | SC1 |','## Proposed Changes','### T1 \u2014 File','#### [NEW] src/file.ts','- Purpose: behavior.','## Success Criteria','- [SC1] Works','  - Changes: src/file.ts','  - Verify: `node check`','  - Evidence: verify','## Verification Plan','### Automated Tests','- `node contract`'].join('\n');
function parsed(){const result=parsePlan(source);if(!result.ok)throw new Error(JSON.stringify(result.defects));return result.plan;}
import type {ParsedPlan} from '../../../skills/dispatch/scripts/toolkit/domain/types.ts';
import type {Fold} from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
const plan=():ParsedPlan=>{const p=parsed();return {...p,criteria:p.criteria.map(c=>({...c,retain:'transient' as const,tests:['test/step.transient.test.js'],changes:['test/step.transient.test.js']})),changes:[{action:'NEW' as const,path:'test/step.transient.test.js',note:'',command:null,line:1}]};};
const fold=(data:Record<string,unknown>[]):Fold=>({records:data.map((d,i)=>({kind:'integrate',seq:i+1,key:String(i),at:'',by:'tool',data:d})),lastSeq:data.length,torn:null});
const done={phase:'done',task:'T1',commit:'head'};
test('pending MUST rejection and duplicate laundering refuse pruning before effects',async()=>{
 const f=sessionFixture({memory:true});try {
  f.artifact('work.spec.md','# Work');
  f.artifact('work.plan.md',source.replaceAll('src/file.ts','test/step.transient.test.js').replace('  - Verify: `node check`','  - Tests: test/step.transient.test.js\n  - Retain: transient\n  - Verify: `node check` [FINAL]'));
  await appendRecord(f.session,{kind:'bind',by:'tool',key:'bind',data:{spec:'work.spec.md',plan:'work.plan.md'}},f.deps);
  const dir=path.join(f.session,'.state/reviews/plan-work.plan/round-1');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'round.json'),JSON.stringify({round:1,generation:1,startSeq:0,target:'target',spec:{path:path.join(f.root,'work.spec.md'),hash:'spec'},roster:[{slot:'claude[0]',provider:'claude',reserve:false,native:false}]}));
  const finding={id:'R1-F001',severity:'MUST',sources:['claude[0]'],locus:'§ Work',category:'correctness',defect:'Unbounded writes',requiredChange:'Bound writes'};
  fs.writeFileSync(path.join(dir,'findings.json'),JSON.stringify({findings:[finding,{...finding,id:'R1-F002'}],failed:[]}));
  await appendRecord(f.session,{kind:'ruling',by:'orchestrator',key:'reject',data:{subject:'review:plan-work.plan:R1-F001',ruling:'rejected',rationale:'Writes are bounded'}},f.deps);
  await appendRecord(f.session,{kind:'ruling',by:'orchestrator',key:'duplicate',data:{subject:'review:plan-work.plan:R1-F002',ruling:'duplicate',rationale:'Duplicate of R1-F001'}},f.deps);
  const run=async()=>{f.lines.length=0;assert.equal(await main(['worktree','prune','--session',f.session],f.deps),4);assert.equal(JSON.parse(f.lines[0]!).reason,'prune-review-required');};
  await run();
  const metadata=fs.readFileSync(path.join(dir,'round.json'),'utf8');fs.writeFileSync(path.join(dir,'round.json'),'{invalid');await run();fs.writeFileSync(path.join(dir,'round.json'),metadata);
  const readdir=fs.readdirSync;
  fs.readdirSync=((file:fs.PathLike,...args:unknown[])=>{
   if(String(file)===path.dirname(dir))throw Object.assign(new Error('Review directory storage unavailable'),{code:'EACCES'});
   return Reflect.apply(readdir,fs,[file,...args]);
  }) as typeof fs.readdirSync;
  try {
   f.lines.length=0;assert.equal(await main(['worktree','prune','--session',f.session],f.deps),2);
   const result=JSON.parse(f.lines[0]!);assert.equal(result.reason,'fault');assert.match(result.summary,/Review directory storage unavailable/);
  }finally{fs.readdirSync=readdir;}
  await appendRecord(f.session,{kind:'escalation',by:'tool',key:'dispute',data:{id:'rejection:plan-work.plan:R1-F001',state:'open',summary:'Reviewer disputes rejection'}},f.deps);
  await run();assert.equal(f.launches.length,0);
 }finally{f.cleanup();}
});
test('pruning rejects unsafe declarations',()=>{
 assert.deepEqual(validateTargets(plan()),['test/step.transient.test.js']);
 for(const file of ['../outside','/outside','C:/outside','test/../outside','test/helpers/step.js','test/step\\escape.js']){const p=plan();Object.assign(p.criteria[0]!,{tests:[file]});p.changes[0]!.path=file;assert.throws(()=>validateTargets(p),{reason:'unsafe-transient-target'});}
 const p=plan();(p.criteria as import('../../../skills/dispatch/scripts/toolkit/domain/types.ts').PlanCriterion[]).push({...p.criteria[0]!,id:'SC2',tests:['test/STEP.transient.test.js']});(p.changes as import('../../../skills/dispatch/scripts/toolkit/domain/types.ts').PlanChange[]).push({...p.changes[0]!,path:'test/STEP.transient.test.js'});assert.throws(()=>validateTargets(p),{reason:'unsafe-transient-target'});
 const collision=plan();(collision.changes as import('../../../skills/dispatch/scripts/toolkit/domain/types.ts').PlanChange[]).push({...collision.changes[0]!,path:'test/STEP.transient.test.js'});assert.throws(()=>validateTargets(collision),{reason:'unsafe-transient-target'});
 const shared=plan();(shared.criteria as import('../../../skills/dispatch/scripts/toolkit/domain/types.ts').PlanCriterion[]).push({...shared.criteria[0]!,id:'SC2',retain:'durable'});assert.throws(()=>validateTargets(shared),{reason:'unsafe-transient-target'});
});
test('pruning recovery requires the recorded deletion transition',()=>{
 const valid={head:'source',from:'source',tree:'source-tree',expected:'deleted-tree',parent:'',delta:['D','step'],targets:['step'],untracked:[]};assert.equal(recoveryAllowed(valid),true);
 assert.equal(recoveryAllowed({...valid,head:'committed',tree:'deleted-tree',parent:'source'}),true);
 for(const patch of [{head:'unrelated',parent:'other'}, {delta:['M','step']},{delta:['D','other']},{untracked:['other']}])assert.equal(recoveryAllowed({...valid,...patch}),false);
});
for(const [name,input,clean,green,reason] of [
 ['unintegrated tasks',[],true,true,'prune-unintegrated-tasks'],
 ['pending integration',[done,{phase:'started',task:'T1',candidate:'head'}],true,true,'integration-pending'],
 ['a dirty tree',[done],false,true,'integration-dirty'],
 ['missing or failing prechecks',[done],true,false,'prune-prechecks-required'],
] as const)test('pruning refuses '+name,()=>{assert.throws(()=>prunePreconditions(fold([...input]),plan(),clean,green),{reason});});
test('pruning refuses open writers',()=>{const f=fold([done]);f.records.push({seq:2,key:'writer',at:'',kind:'writer',by:'tool',data:{phase:'launched',task:'T1',path:'writer',base:{commit:'head',seq:0,taskSection:'hash'}}});assert.throws(()=>prunePreconditions(f,plan(),true,true),{reason:'prune-open-writers'});});

test('pruning preflights FINAL commands before any effects',()=>{
 const p=plan();assert.throws(()=>pruneProjection(p),{reason:'missing-final-command'});
 const target=p.criteria[0]!.tests[0]!;
 const bad={...p,finalCommands:['node '+target],criteria:[{...p.criteria[0]!,verify:[{command:'node '+target,final:true}]}]};assert.throws(()=>pruneProjection(bad),{reason:'transient-command-dependency'});
 const caseVariant={...bad,criteria:[{...bad.criteria[0]!,verify:[{command:'node '+target.toUpperCase(),final:true}]}]};assert.throws(()=>pruneProjection(caseVariant),{reason:'transient-command-dependency'});
 const good={...bad,finalCommands:['node retained'],criteria:[{...bad.criteria[0]!,verify:[{command:'node retained',final:true}]}]};assert.deepEqual(pruneProjection(good).final[0]!.commands,['node retained']);
});

test('pruning refuses a newer finished candidate that has not integrated',()=>{const f=fold([done]);f.records.push({seq:2,key:'launch',at:'',kind:'writer',by:'tool',data:{phase:'launched',task:'T1',path:'writer',base:{commit:'head',seq:0,taskSection:'hash'}}},{seq:3,key:'finish',at:'',kind:'writer',by:'tool',data:{phase:'finished',task:'T1',launch:1,candidate:'new'}});assert.throws(()=>prunePreconditions(f,plan(),true,true),{reason:'prune-unintegrated-tasks'});});


test('pruning preserves declared support files and permits descriptive test filenames',()=>{
 const p=plan(),file='tests/transient-prune-helper.test.ts',support='tests/helpers/shared.ts';p.criteria[0]!.tests=[file,support];p.criteria[0]!.changes=[file,support];p.changes[0]!.path=file;
 (p.changes as import('../../../skills/dispatch/scripts/toolkit/domain/types.ts').PlanChange[]).push({...p.changes[0]!,path:support,action:'MODIFY'});
 assert.deepEqual(validateTargets(p),[file]);
});

test('pruning transition requires a prior pruned phase',async()=>{
 await assert.rejects(async()=>pruneTransition({} as any,fold([]),plan()),{reason:'pruning-required'});
});
