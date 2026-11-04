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
  fs.writeFileSync(path.join(reviewDir,'round.json'),JSON.stringify({round:3,cap:3,generation:1,startSeq:1,target:{base,head:baseline},scope:'Full review',artifacts,spec:{path:'/work.spec.md',hash:artifacts.spec},roster:[{slot:'reviewer',reserve:false}]}));
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

test('review identity accepts a narrowed re-review round',async()=>{
 const f=sessionFixture({memory:true});try{
  f.artifact('work.spec.md','# Work\n');f.artifact('work.plan.md',source);
  const head='a'.repeat(40),base='b'.repeat(40);
  const bind={kind:'bind',seq:1,key:'bind',at:'',by:'tool',data:{spec:'work.spec.md',plan:'work.plan.md'}};
  const artifacts=currentHashes(f.root,bind);
  const dir=path.join(f.session,'.state/reviews/code-integration/round-2');fs.mkdirSync(path.join(dir,'gen-1/slots'),{recursive:true});
  fs.writeFileSync(path.join(dir,'round.json'),JSON.stringify({round:2,cap:3,generation:1,startSeq:1,target:{base,head},scope:'Re-review round 2 (narrowed) — changed: file',artifacts,spec:{path:'/work.spec.md',hash:artifacts.spec},roster:[{slot:'reviewer',reserve:false}]}));
  fs.writeFileSync(path.join(dir,'findings.json'),JSON.stringify({review:'code-integration',round:2,findings:[],failed:[]}));
  fs.writeFileSync(path.join(dir,'gen-1/slots/reviewer.json'),JSON.stringify({slot:'reviewer',state:'done',text:'{"status":"CLEAN","findings":[]}'}));
  const ctx={session:f.session,manifest:readManifest(f.session),deps:f.deps} as import('../../../skills/dispatch/scripts/toolkit/cli.ts').HandlerContext;
  const result=await reviewIdentity(ctx,{records:[bind] as any,lastSeq:1,torn:null},f.root,head,base);
  assert.equal(result.round,2);
 }finally{f.cleanup();}
});

// SECTION: Delivery gates read the corrected severity

async function correctedGate(stored: {severity: string; impact: string; trigger: string}, correction: {impact: string; trigger: string} | null) {
 const f=sessionFixture({memory:true});
 try{
  f.artifact('work.spec.md','# Work\n');f.artifact('work.plan.md',source);
  const baseline='a'.repeat(40),head='b'.repeat(40),base='c'.repeat(40),commitReason='repair accepted SHOULD';
  const bind={kind:'bind',seq:1,key:'bind',at:'',by:'tool',data:{spec:'work.spec.md',plan:'work.plan.md'}};
  const reviewFix={review:'code-integration',round:3,generation:1,findings:['R3-F001'],from:baseline};
  const ruling={kind:'ruling',seq:2,key:'ruling',at:'',by:'orchestrator',data:{subject:'review:code-integration:R3-F001',ruling:'accepted',rationale:'impact: corrected after review',...(correction??{})}};
  const fix={kind:'integrate',seq:3,key:'fix',at:'',by:'tool',data:{phase:'fix',commit:head,reason:commitReason,reviewFix}};
  const artifacts=currentHashes(f.root,bind);
  const reviewDir=path.join(f.session,'.state/reviews/code-integration/round-3');fs.mkdirSync(path.join(reviewDir,'gen-1/slots'),{recursive:true});
  const finding={id:'R3-F001',...stored,fix:{paths:['src/file.ts'],dependencies:[],verification:[]},locus:'src/file.ts:L1',defect:'The source is incorrect',requiredChange:'Correct the source'};
  fs.writeFileSync(path.join(reviewDir,'round.json'),JSON.stringify({round:3,cap:3,generation:1,startSeq:1,target:{base,head:baseline},scope:'Full review',artifacts,spec:{path:'/work.spec.md',hash:artifacts.spec},roster:[{slot:'reviewer',reserve:false}]}));
  fs.writeFileSync(path.join(reviewDir,'findings.json'),JSON.stringify({review:'code-integration',round:3,findings:[finding],failed:[]}));
  fs.writeFileSync(path.join(reviewDir,'gen-1/slots/reviewer.json'),JSON.stringify({slot:'reviewer',state:'done',text:'{"status":"CLEAN","findings":[]}'}));
  const canonical=stableValue(reviewFix),fixDigest='sha256:'+crypto.createHash('sha256').update(canonical).digest('hex'),fixData=Buffer.from(canonical).toString('base64url');
  const manifest=readManifest(f.session),message=[`fix(dispatch): ${commitReason}`,'',`Dispatch-Fix: ${manifest.safeSessionId}`,`Dispatch-Review-Fix: ${fixDigest}`,`Dispatch-Review-Fix-Data: ${fixData}`,''].join('\n');
  f.deps.run=async(argv)=>{
   const args=argv.slice(1),output=(stdout='')=>({exit:0,stdout,stderr:''});
   if(args[0]==='rev-list'&&args[1]==='--reverse'&&args[2]==='--parents')return output(head+' '+baseline+'\n');
   if(args[0]==='diff-tree'&&args.includes(head))return output('src/file.ts\0');
   if(args[0]==='log'&&args[1]==='-1'&&args[2]==='--format=%B'&&args[3]===head)return output(message);
   throw new Error('Unexpected Git argv: '+JSON.stringify(argv));
  };
  const ctx={session:f.session,manifest,deps:f.deps} as import('../../../skills/dispatch/scripts/toolkit/cli.ts').HandlerContext;
  return await reviewIdentity(ctx,{records:[bind,ruling,fix] as any,lastSeq:3,torn:null},f.root,head,base).then(
   value=>({ok:true as const,value}),error=>({ok:false as const,reason:(error as {reason?:string}).reason}));
 }finally{f.cleanup();}
}

test('corrected finding: corrected severity transitions govern final-round fix qualification',async()=>{
 const downgraded=await correctedGate({severity:'MUST',impact:'blocks',trigger:'realistic'},{impact:'degrades',trigger:'realistic'});
 assert.equal(downgraded.ok,true,JSON.stringify(downgraded));
 for(const stored of [{severity:'MUST',impact:'blocks',trigger:'realistic'},{severity:'SHOULD',impact:'degrades',trigger:'realistic'}]){
  const result=await correctedGate(stored,{impact:'degrades',trigger:'contrived'});
  assert.equal(result.ok,true,JSON.stringify(result));
 }
 assert.deepEqual(await correctedGate({severity:'CONSIDER',impact:'minor',trigger:'contrived'},null),{ok:false,reason:'review-required'});
 assert.equal((await correctedGate({severity:'SHOULD',impact:'degrades',trigger:'realistic'},null)).ok,true);
 const raised=await correctedGate({severity:'SHOULD',impact:'degrades',trigger:'realistic'},{impact:'blocks',trigger:'realistic'});
 assert.deepEqual(raised,{ok:false,reason:'review-required'});
});

// SECTION: Coverage decision gates the review identity

const [A,B,C]=['codex[0]','opencode[1]','claude[2]'];
type CoverageRound={n:number;scope?:string;base?:string;done:string[];failed:string[];coverage?:'open'|'full'};
async function coverageIdentity(rounds:CoverageRound[],extra:(seq:number)=>object[]=()=>[],prepare?:(dir:string)=>void,opened=false) {
 const f=sessionFixture({memory:true});
 try{
  f.artifact('work.spec.md','# Work\n');f.artifact('work.plan.md',source);
  const head='a'.repeat(40),base='b'.repeat(40);
  const bind={kind:'bind',seq:1,key:'bind',at:'',by:'tool',data:{spec:'work.spec.md',plan:'work.plan.md'}};
  const artifacts=currentHashes(f.root,bind),root=path.join(f.session,'.state/reviews/code-integration');
  const spec={path:path.resolve(f.root,'work.spec.md'),hash:artifacts.spec};
  for(const item of rounds) {
   const dir=path.join(root,'round-'+item.n),slots=path.join(dir,'gen-1/slots'),whole=item.n===1||item.coverage!==undefined;
   fs.mkdirSync(slots,{recursive:true});
   fs.writeFileSync(path.join(dir,'round.json'),JSON.stringify({round:item.n,cap:3,generation:1,startSeq:1,target:{base:item.base??base,head},artifacts,spec,
    scope:item.scope??(item.n===1?'Full review':`Re-review round ${item.n} (coverage) — changed paths: src/file.ts; comparison: ${base}..${head}`),
    roster:[...item.done,...item.failed].map(slot=>({slot,reserve:false})),...(item.coverage?{coverage:item.coverage}:{})}));
   fs.writeFileSync(path.join(dir,'findings.json'),JSON.stringify({review:'code-integration',round:item.n,findings:[],failed:[]}));
   for(const slot of item.done)fs.writeFileSync(path.join(slots,slot+'.json'),JSON.stringify({slot,state:'done',text:'{"status":"CLEAN","findings":[]}'}));
   for(const slot of item.failed)fs.writeFileSync(path.join(slots,slot+'.json'),JSON.stringify({slot,state:'failed',cls:'timeout',reason:'slow'}));
   if(item.failed.length)fs.writeFileSync(path.join(dir,'gen-1/attempts.json'),JSON.stringify(item.failed.map(slot=>({slot,seq:2,wholeTarget:whole,outcome:'timeout'}))));
  }
  prepare?.(root);
  const records=[bind,...(opened?[{kind:'integrate',seq:2,key:'opened',at:'',by:'tool',data:{phase:'opened',base}}]:[]),...extra(10)] as any[];
  const ctx={session:f.session,manifest:readManifest(f.session),deps:f.deps} as import('../../../skills/dispatch/scripts/toolkit/cli.ts').HandlerContext;
  return await reviewIdentity(ctx,{records,lastSeq:20,torn:null},f.root,head,base).then(value=>({ok:true as const,value}),error=>({ok:false as const,reason:(error as {reason?:string}).reason}));
 }finally{f.cleanup();}
}
const accept=(seq:number,slots:string[])=>({seq,key:'coverage:code-integration:'+seq,at:'',kind:'escalation',by:'user',quote:'accept it',data:{id:'coverage:code-integration:'+seq,state:'resolved',summary:'accept: '+slots.join(', ')}});
const rerunRounds:CoverageRound[]=[{n:1,done:[B,C],failed:[A]},{n:2,coverage:'full',done:[B,C],failed:[A]}];

test('review identity reads coverage decision: majority and override accept a failed slot',async()=>{
 const majority=await coverageIdentity(rerunRounds);
 assert.equal(majority.ok,true,JSON.stringify(majority));
 assert.equal((majority as {value:{round:number}}).value.round,2);
 const overridden=await coverageIdentity([{n:1,done:[B,C],failed:[A]}],seq=>[accept(seq,[A])]);
 assert.equal(overridden.ok,true,JSON.stringify(overridden));
});

test('review identity reads coverage decision: rerun, user and unreadable state refuse',async()=>{
 const refused={ok:false,reason:'review-required'};
 assert.deepEqual(await coverageIdentity([{n:1,done:[B,C],failed:[A]}]),refused,'a failed slot with no rerun');
 assert.deepEqual(await coverageIdentity([{n:1,done:[C],failed:[A,B]},{n:2,coverage:'full',done:[C],failed:[A,B]}]),refused,'a rerun that left half or fewer complete');
 assert.deepEqual(await coverageIdentity(rerunRounds,()=>[],root=>fs.rmSync(path.join(root,'round-2/gen-1/attempts.json'))),refused,'a failed slot with no attempt entry');
 assert.deepEqual(await coverageIdentity([{n:1,done:[],failed:[A,B,C]}],seq=>[accept(seq,[A,B,C])]),refused,'a last round with no completed slot');
 assert.deepEqual(await coverageIdentity([{n:1,done:[B,C],failed:[A]}],seq=>[{...accept(seq,[A]),by:'orchestrator'}]),refused,'an override from another author');
});

test('review identity reads coverage decision: failures outside the applicable rounds are ignored',async()=>{
 const rounds:CoverageRound[]=[{n:1,base:'c'.repeat(40),done:[B,C],failed:[A]},{n:2,coverage:'open',done:[B,C],failed:[]}];
 assert.deepEqual(await coverageIdentity(rounds),{ok:false,reason:'review-required'},'without a predicate the earlier failure stays open');
 assert.equal((await coverageIdentity(rounds,()=>[],undefined,true)).ok,true);
});
