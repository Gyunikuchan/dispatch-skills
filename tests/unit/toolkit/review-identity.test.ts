import assert from 'node:assert/strict';
import {test} from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {sessionFixture} from './helpers/session.ts';
import {appendRecord,currentHashes,foldLedger,latest} from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import {reviewIdentity} from '../../../skills/dispatch/scripts/toolkit/review-identity.ts';
import {readManifest} from '../../../skills/dispatch/scripts/lib/session.ts';
import {stableValue} from '../../../skills/dispatch/scripts/toolkit/domain/stable-value.ts';
const source=['# Work','## Task Map','| ID | Title | Outcome | Prerequisites | Criteria |','| --- | --- | --- | --- | --- |','| T1 | File | Works | none | SC1 |','## Proposed Changes','### T1 \u2014 File','#### [NEW] src/file.ts','- Purpose: behavior.','## Success Criteria','- [SC1] Works','  - Changes: src/file.ts','  - Verify: `node check`','  - Evidence: verify','## Verification Plan','### Automated Tests','- `node contract`'].join('\n');
test('review identity keeps unexpected read errors',async()=>{
 const f=sessionFixture({memory:true});try {
  f.artifact('work.spec.md','# Work');f.artifact('work.plan.md',source);
  await appendRecord(f.session,{kind:'bind',by:'orchestrator',key:'bind',data:{spec:'work.spec.md',plan:'work.plan.md'}},f.deps);
  const head='a'.repeat(40),base='b'.repeat(40);
  const reviewRoot=path.join(f.session,'.state/reviews/code-integration'),roundDir=path.join(reviewRoot,'round-1');
  fs.mkdirSync(roundDir,{recursive:true});
  const ctx={session:f.session,manifest:readManifest(f.session),args:[],values:{},deps:f.deps} as import('../../../skills/dispatch/scripts/toolkit/cli.ts').HandlerContext;
  const identity=()=>reviewIdentity(ctx,foldLedger(f.session),f.root,head,base);
  const roundFile=path.join(roundDir,'round.json');
  fs.writeFileSync(roundFile,'{}');
  const readFile=fs.readFileSync;
  fs.readFileSync=((file:fs.PathLike,...args:unknown[])=>{
   if(String(file)===roundFile)throw Object.assign(new Error('Review artifact storage unavailable'),{code:'EACCES'});
   return Reflect.apply(readFile,fs,[file,...args]);
  }) as typeof fs.readFileSync;
  try {
   await assert.rejects(identity,error=>{
    assert.equal((error as NodeJS.ErrnoException).code,'EACCES');
    assert.match((error as Error).message,/Review artifact storage unavailable/);
    return true;
   });
  }finally{fs.readFileSync=readFile;}
  fs.writeFileSync(roundFile,'{invalid');
  await assert.rejects(identity,{reason:'review-required'});
  fs.rmSync(reviewRoot,{recursive:true,force:true});
  await assert.rejects(identity,{reason:'review-required'});
 }finally{f.cleanup();}
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
  const manifest=readManifest(f.session),message=[`fix(dispatch): ${commitReason}`,'',`Dispatch-Fix: ${manifest.safeSessionId}`,`Dispatch-Review-Fix: ${fixDigest}`,`Dispatch-Review-Fix-Data: ${fixData}`,''].join('\n');
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
  changed=['src/file.ts','src/other.ts'];await assert.rejects(reviewIdentity(ctx,{records:[bind,ruling,fix] as any,lastSeq:3,torn:null},f.root,head,base),{reason:'review-required'});
  changed=['src/file.ts'];commits=[['d'.repeat(40),baseline],[head,'d'.repeat(40)]];
  await assert.rejects(reviewIdentity(ctx,{records:[bind,ruling,fix] as any,lastSeq:3,torn:null},f.root,head,base),{reason:'review-required'});
  commits=[[head,baseline]];
  fs.writeFileSync(path.join(reviewDir,'findings.json'),JSON.stringify({review:'code-integration',round:3,findings:[{...finding,severity:'MUST'}],failed:[]}));
  await assert.rejects(reviewIdentity(ctx,{records:[bind,ruling,fix] as any,lastSeq:3,torn:null},f.root,head,base),{reason:'review-required'});
  fs.writeFileSync(path.join(reviewDir,'findings.json'),JSON.stringify({review:'code-integration',round:3,findings:[{...finding,fix:{paths:[]}}],failed:[]}));
  await assert.rejects(reviewIdentity(ctx,{records:[bind,ruling,fix] as any,lastSeq:3,torn:null},f.root,head,base),{reason:'review-required'});
 }finally{f.cleanup();}
});
