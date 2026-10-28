import assert from 'node:assert/strict';
import {test} from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {sessionFixture} from './helpers/session.ts';
import {main} from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import {appendRecord,currentHashes,foldLedger,latest} from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import {validateTargets,prunePreconditions,recoveryAllowed,pruneProjection,pruneTransition,prune,reviewIdentity} from '../../../skills/dispatch/scripts/toolkit/prune.ts';
import {parsePlan} from '../../../skills/dispatch/scripts/toolkit/domain/plan.ts';
import {readManifest} from '../../../skills/dispatch/scripts/lib/session.ts';
import {checks} from '../../../skills/dispatch/scripts/toolkit/plan-view.ts';
import {stableValue} from '../../../skills/dispatch/scripts/toolkit/domain/stable-value.ts';
const source=['# Work','## Task Map','| ID | Title | Outcome | Prerequisites | Criteria |','| --- | --- | --- | --- | --- |','| T1 | File | Works | none | SC1 |','## Proposed Changes','### T1 \u2014 File','#### [NEW] src/file.ts','- Purpose: behavior.','## Success Criteria','- [SC1] Works','  - Changes: src/file.ts','  - Verify: `node check`','  - Evidence: verify','## Verification Plan','### Automated Tests','- `node contract`'].join('\n');
function parsed(){const result=parsePlan(source);if(!result.ok)throw new Error(JSON.stringify(result.defects));return result.plan;}
import type {ParsedPlan} from '../../../skills/dispatch/scripts/toolkit/domain/types.ts';
import type {Fold} from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
const plan=():ParsedPlan=>{const p=parsed();return {...p,criteria:p.criteria.map(c=>({...c,retain:'transient' as const,tests:['test/step.transient.test.js'],changes:['test/step.transient.test.js']})),changes:[{action:'NEW' as const,path:'test/step.transient.test.js',note:'',command:null,line:1}]};};
const fold=(data:Record<string,unknown>[]):Fold=>({records:data.map((d,i)=>({kind:'integrate',seq:i+1,key:String(i),at:'',by:'tool',data:d})),lastSeq:data.length,torn:null});
const done={phase:'done',task:'T1',commit:'head'};
test('prune review identity keeps unexpected read errors',async()=>{
 const f=sessionFixture({memory:true});try {
  const target='tests/step.transient.test.ts';
  const transient=source.replaceAll('src/file.ts',target).replace('  - Verify: `node check`','  - Tests: '+target+'\n  - Retain: transient\n  - Covered by: FINAL\n  - Verify: `node check` [FINAL]');
  f.artifact('work.spec.md','# Work\n\n## Requirements\n\n### REQ-1 — Work\n- Acceptance: Works.\n');
  f.artifact('work.plan.md',transient);
  await appendRecord(f.session,{kind:'bind',by:'orchestrator',key:'bind',data:{spec:'work.spec.md',plan:'work.plan.md'}},f.deps);
  const hashes=currentHashes(f.root,latest(foldLedger(f.session),'bind'));
  const head='a'.repeat(40),base='b'.repeat(40),tree='c'.repeat(40),deletedTree='d'.repeat(40),branch='dispatch/test/integration';
  await appendRecord(f.session,{kind:'approval',by:'user',quote:'Approved',key:'approval',data:hashes},f.deps);
  const parsedTransient=parsePlan(transient);if(!parsedTransient.ok)throw new Error(JSON.stringify(parsedTransient.defects));
  for(const check of checks(parsedTransient.plan))await appendRecord(f.session,{kind:'evidence',by:'tool',key:'evidence:'+check.criterion,data:{criterion:check.criterion,commandDigest:check.commandDigest,tree,clean:true,before:tree,after:tree,exit:0,path:'verify.txt',artifacts:hashes}},f.deps);

  const integration=path.join(f.session,'.state/worktrees/integration');fs.mkdirSync(integration,{recursive:true});
  await appendRecord(f.session,{kind:'integrate',by:'tool',key:'opened',data:{phase:'opened',path:'.state/worktrees/integration',branch,base,dest:{path:f.root,branch:'main'}}},f.deps);
  await appendRecord(f.session,{kind:'integrate',by:'tool',key:'done',data:{phase:'done',task:'T1',commit:head}},f.deps);

  const reviewRoot=path.join(f.session,'.state/reviews/code-integration'),roundDir=path.join(reviewRoot,'round-1');
  fs.mkdirSync(path.join(roundDir,'gen-1/slots'),{recursive:true});
  fs.writeFileSync(path.join(roundDir,'round.json'),JSON.stringify({round:1,startSeq:foldLedger(f.session).lastSeq,generation:1,cap:3,roster:[{slot:'reviewer'}],scope:'Full review',artifacts:hashes,spec:{path:path.join(f.root,'work.spec.md'),hash:hashes.spec},target:{base,head}}));
  fs.writeFileSync(path.join(roundDir,'findings.json'),JSON.stringify({review:'code-integration',round:1,failed:[],findings:[]}));
  fs.writeFileSync(path.join(roundDir,'gen-1/slots/reviewer.json'),JSON.stringify({slot:'reviewer',state:'done',text:'{"status":"CLEAN","findings":[]}'}));

  let writeTrees=0;
  f.deps.run=async(argv)=>{
   const args=argv.slice(1),out=(stdout='')=>({exit:0,stdout,stderr:''});
   if(args.join(' ')==='worktree list --porcelain')return out('worktree '+integration+'\nbranch refs/heads/'+branch+'\n');
   if(args.join(' ')==='symbolic-ref --short HEAD')return out(branch+'\n');
   if(args.join(' ')==='rev-parse HEAD')return out(head+'\n');
   if(args[0]==='rev-parse'&&(args[1]==='HEAD^{tree}'||args[1]===head+'^{tree}'))return out(tree+'\n');
   if(args[0]==='read-tree'||args.includes('update-index')||(args[0]==='add'&&args[1]==='-A'))return out();
   if(args[0]==='write-tree')return out((++writeTrees%2===1?deletedTree:tree)+'\n');
   throw new Error('Unexpected Git command: '+argv.join(' '));
  };
  const ctx={session:f.session,manifest:readManifest(f.session),args:[],values:{},deps:f.deps};
  const roundFile=path.join(roundDir,'round.json'),readFile=fs.readFileSync;
  fs.readFileSync=((file:fs.PathLike,...args:unknown[])=>{
   if(String(file)===roundFile)throw Object.assign(new Error('Review artifact storage unavailable'),{code:'EACCES'});
   return Reflect.apply(readFile,fs,[file,...args]);
  }) as typeof fs.readFileSync;
  try {
   await assert.rejects(()=>prune(ctx),error=>{
    const actual=error as NodeJS.ErrnoException & {reason?:string;exit?:number};
    assert.equal(actual.code,'EACCES',`${actual.name}: ${actual.message}; reason=${actual.reason}; exit=${actual.exit}`);
    assert.match((error as Error).message,/Review artifact storage unavailable/);
    return true;
   });
  }finally{fs.readFileSync=readFile;}

  fs.writeFileSync(roundFile,'{invalid');
  await assert.rejects(()=>prune(ctx),error=>{
   assert.equal((error as {reason?:string}).reason,'prune-review-required');
   return true;
  });
  fs.rmSync(reviewRoot,{recursive:true,force:true});
  await assert.rejects(()=>prune(ctx),error=>{
   assert.equal((error as {reason?:string}).reason,'prune-review-required');
   return true;
  });
 }finally{f.cleanup();}
});
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

test('cap-ending SHOULD fixes require a verified bounded commit chain',async()=>{
 const f=sessionFixture({memory:true});try{
  f.artifact('work.spec.md','# Work\n');f.artifact('work.plan.md',source);
  const baseline='a'.repeat(40),head='b'.repeat(40),base='c'.repeat(40),commitReason='repair accepted SHOULD';
  const bind={kind:'bind',seq:1,key:'bind',at:'',by:'tool',data:{spec:'work.spec.md',plan:'work.plan.md'}};
  const reviewFix={review:'code-integration',round:3,generation:1,findings:['R3-F001'],from:baseline};
  const ruling={kind:'ruling',seq:2,key:'ruling',at:'',by:'orchestrator',data:{subject:'review:code-integration:R3-F001',ruling:'accepted',rationale:'Accept the bounded correction'}};
  const fix={kind:'integrate',seq:3,key:'fix',at:'',by:'tool',data:{phase:'fix',commit:head,reason:commitReason,reviewFix}};
  const artifacts=currentHashes(f.root,bind);
  const reviewDir=path.join(f.session,'.state/reviews/code-integration/round-3');fs.mkdirSync(path.join(reviewDir,'gen-1/slots'),{recursive:true});
  const finding={id:'R3-F001',severity:'SHOULD',fix:{paths:['src/file.ts','src/helper.ts'],dependencies:[],verification:[]},locus:'src/file.ts:L1',defect:'The source is incorrect',requiredChange:'Correct the source'};
  fs.writeFileSync(path.join(reviewDir,'round.json'),JSON.stringify({round:3,cap:3,generation:1,startSeq:1,target:{base,head:baseline},scope:'Full review',artifacts,spec:{hash:artifacts.spec},roster:[{slot:'reviewer',reserve:false}]}));
  fs.writeFileSync(path.join(reviewDir,'findings.json'),JSON.stringify({review:'code-integration',round:3,findings:[finding],failed:[]}));
  fs.writeFileSync(path.join(reviewDir,'gen-1/slots/reviewer.json'),JSON.stringify({slot:'reviewer',state:'done',text:'{"status":"CLEAN","findings":[]}'}));
  const canonical=stableValue(reviewFix),fixDigest='sha256:'+crypto.createHash('sha256').update(canonical).digest('hex'),fixData=Buffer.from(canonical).toString('base64url');
  const manifest=readManifest(f.session),message=[`dispatch fix: ${commitReason}`,'',`Dispatch-Fix: ${manifest.safeSessionId}`,`Dispatch-Review-Fix: ${fixDigest}`,`Dispatch-Review-Fix-Data: ${fixData}`,''].join('\n');
  let commits=[[head,baseline]],changed=['src/file.ts','src/helper.ts'];
  f.deps.run=async(argv)=>{
   const args=argv.slice(1),output=(stdout='')=>({exit:0,stdout,stderr:''});
   if(args[0]==='rev-list'&&args[1]==='--reverse'&&args[2]==='--parents')return output(commits.map(row=>row.join(' ')).join('\n')+'\n');
   if(args[0]==='diff-tree'&&args.includes(head))return output(changed.join('\0')+'\0');
   if(args[0]==='log'&&args[1]==='-1'&&args[2]==='--format=%B'&&args[3]===head)return output(message);
   throw new Error('Unexpected Git argv: '+JSON.stringify(argv));
  };
  const ctx={session:f.session,manifest,deps:f.deps} as import('../../../skills/dispatch/scripts/toolkit/cli.ts').HandlerContext;
  const valid=await reviewIdentity(ctx,{records:[bind,ruling,fix] as any,lastSeq:3,torn:null},f.root,head,base);
  assert.equal(valid.baseline,baseline);assert.deepEqual(valid.corrections.map(row=>row.commit),[head]);
  changed=['src/file.ts','src/other.ts'];await assert.rejects(reviewIdentity(ctx,{records:[bind,ruling,fix] as any,lastSeq:3,torn:null},f.root,head,base),{reason:'prune-review-required'});
  changed=['src/file.ts'];commits=[['d'.repeat(40),baseline],[head,'d'.repeat(40)]];
  await assert.rejects(reviewIdentity(ctx,{records:[bind,ruling,fix] as any,lastSeq:3,torn:null},f.root,head,base),{reason:'prune-review-required'});
  commits=[[head,baseline]];
  fs.writeFileSync(path.join(reviewDir,'findings.json'),JSON.stringify({review:'code-integration',round:3,findings:[{...finding,severity:'MUST'}],failed:[]}));
  await assert.rejects(reviewIdentity(ctx,{records:[bind,ruling,fix] as any,lastSeq:3,torn:null},f.root,head,base),{reason:'prune-review-required'});
  fs.writeFileSync(path.join(reviewDir,'findings.json'),JSON.stringify({review:'code-integration',round:3,findings:[{...finding,fix:{paths:[]}}],failed:[]}));
  await assert.rejects(reviewIdentity(ctx,{records:[bind,ruling,fix] as any,lastSeq:3,torn:null},f.root,head,base),{reason:'prune-review-required'});
 }finally{f.cleanup();}
});
