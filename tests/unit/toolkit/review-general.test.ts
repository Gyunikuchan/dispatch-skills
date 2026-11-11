import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { appendRecord, foldLedger } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { artifactHash } from '../../../skills/dispatch/scripts/toolkit/artifacts.ts';
import { governedPlanText } from '../../../skills/dispatch/scripts/toolkit/domain/plan.ts';
import { governedDesignText } from '../../../skills/dispatch/scripts/toolkit/domain/design.ts';
import { nodeLinkFs } from '../../../skills/dispatch/scripts/lib/node-fs-ext.ts';
import { CLEAN, CONTEXT_MAP, fixture, report } from '../../helpers/review-fixture.ts';

// SECTION: Ceiling helpers shared with review.test.ts (duplicated for split)
type ReviewFixture = Awaited<ReturnType<typeof fixture>>;
const PLAN_REVIEW = 'plan-work.plan';
const ceilingId = (review: string, ceiling: number) => 'ceiling:' + review + ':' + ceiling;
const addRecord = (f: ReviewFixture, record: object) => appendRecord(f.session, record, f.deps);
const openCeiling = (f: ReviewFixture, review: string, ceiling: number) => addRecord(f, { kind: 'escalation', by: 'tool', key: ceilingId(review, ceiling), data: { id: ceilingId(review, ceiling), state: 'open', summary: 'ceiling ' + ceiling + ' reached' } });
const resolveCeiling = (f: ReviewFixture, review: string, ceiling: number, summary: string, options: { by?: string; quote?: string; key?: string } = {}) => addRecord(f, { kind: 'escalation', by: options.by ?? 'user', quote: options.quote ?? 'User decision', key: options.key ?? ceilingId(review, ceiling) + ':resolved', data: { id: ceilingId(review, ceiling), state: 'resolved', summary } });

test('rejected MUST remains pending beyond cap and requires source-specific explicit agreement',async()=>{
  const f=await fixture();try {
    let phase=0;
    f.deps.delegate=async(_provider,request)=>{
      const prompt=fs.readFileSync(request.promptPath,'utf8');
      if(!phase)return {outcome:{status:'ok',text:report('§ Work','Concurrent writes overwrite captured results','MUST'),resume:null,sessionId:null},invocations:[]};
      const ids=[...prompt.matchAll(/Request ID: `([^`]+)`/g)].map(m=>m[1]!);
      assert.doesNotMatch(prompt,/### Settled in earlier rounds/);
      assert.equal(ids.length,1);
      return {outcome:{status:'ok',text:JSON.stringify({status:'CLEAN',findings:[],confirmations:ids.map(requestId=>({requestId,decision:'agree',rationale:'Captured implementation proves the claim does not apply'}))}),resume:null,sessionId:null},invocations:[]};
    };
    assert.equal((await f.call()).exit,0);
    await f.add('ruling',{subject:'review:plan-work.plan:R1-F001',ruling:'rejected',rationale:'The captured implementation prevents this'});
    await f.add('ruling',{subject:'review:plan-work.plan:R1-F001',ruling:'duplicate',rationale:'Same original claim; confirmation remains pending'});
    phase=1;
    assert.equal((await f.call()).exit,0);
    assert.equal(f.read(2,'findings.json').confirmations.length,2);
    assert.equal((await f.call()).output.reason,'round-cap');
  }finally{f.cleanup();}
});

test('confirmed rejection survives ordinary target edits and a changed ruling needs fresh agreement',async()=>{
 const f=await fixture();try {
  const configFile=path.join(f.deps.skillRoot,'config.jsonc'),config=JSON.parse(fs.readFileSync(configFile,'utf8'));config.phases['plan-review'].rounds.medium=4;fs.writeFileSync(configFile,JSON.stringify(config));
  let phase=0,expected=0;const ids:string[]=[];
  f.deps.delegate=async(_provider,request)=>{
   const assigned=[...fs.readFileSync(request.promptPath,'utf8').matchAll(/Request ID: `([^`]+)`/g)].map(m=>m[1]!);if(phase)assert.equal(assigned.length,expected);ids.push(...assigned);
   return {outcome:{status:'ok',text:phase?JSON.stringify({status:'CLEAN',findings:[],confirmations:assigned.map(requestId=>({requestId,decision:'agree',rationale:'Verified the captured isolated writes'}))}):report(undefined,undefined,'MUST'),resume:null,sessionId:null},invocations:[]};
  };
  {const result=await f.call();assert.equal(result.exit,0,JSON.stringify(result));}await f.add('ruling',{subject:'review:plan-work.plan:R1-F001',ruling:'rejected',rationale:'Writes are isolated'});phase=1;expected=1;{const result=await f.call();assert.equal(result.exit,0,JSON.stringify(result));}
  const original=ids[0];expected=0;fs.appendFileSync(f.plan,'\n## New context\nMore detail.\n');{const result=await f.call();assert.equal(result.exit,0,JSON.stringify(result));}{const result=await f.call();assert.equal(result.exit,0,JSON.stringify(result));}
  await f.add('ruling',{subject:'review:plan-work.plan:R1-F001',ruling:'rejected',rationale:'Updated rejection evidence'});expected=1;{const result=await f.call();assert.equal(result.exit,0,JSON.stringify(result));}assert.notEqual(ids.at(-1),original);
 }finally{f.cleanup();}
});

test('tool-only MUST rejection assigns the saved configured reviewer and fails closed without one',async()=>{
 const f=await fixture();try {
  await f.call();const file=path.join(f.directory,'round-1/findings.json'),saved=f.read(1,'findings.json');saved.findings[0].severity='MUST';saved.findings[0].sources=['tool'];fs.writeFileSync(file,JSON.stringify(saved));
  await f.add('ruling',{subject:'review:plan-work.plan:R1-F001',ruling:'rejected',rationale:'Tool gap is covered by retained evidence'});
  let assigned=0;f.deps.delegate=async(_provider,request)=>{const ids=[...fs.readFileSync(request.promptPath,'utf8').matchAll(/Request ID: `([^`]+)`/g)].map(m=>m[1]!);assigned+=ids.length;return {outcome:{status:'ok',text:JSON.stringify({status:'CLEAN',findings:[],confirmations:ids.map(requestId=>({requestId,decision:'agree',rationale:'Checked the retained RED evidence'}))}),resume:null,sessionId:null},invocations:[]};};
  assert.equal((await f.call()).exit,0);assert.equal(assigned,1);assert.deepEqual(f.read(2,'round.json').requests[0].sourceSlots,[f.read(1,'round.json').roster.find((slot:any)=>!slot.reserve).slot]);
  const metadataFile=path.join(f.directory,'round-1/round.json'),metadata=f.read(1,'round.json');metadata.roster=[];fs.writeFileSync(metadataFile,JSON.stringify(metadata));assert.equal((await f.call()).output.reason,'review-confirmation-required');
 }finally{f.cleanup();}
});

test('rejected MUST disagreement escalates and explicit resolution re-arms retained count',async()=>{
 const f=await fixture();try {
  // One recorded grant keeps the rejection retry below its ceiling.
  await openCeiling(f,PLAN_REVIEW,4);await resolveCeiling(f,PLAN_REVIEW,4,'re-author: allow the rejection retry');
  let decision='disagree',phase=0,launched=0;
  f.deps.delegate=async(_provider,request)=>{
   launched++;const prompt=fs.readFileSync(request.promptPath,'utf8');
   const ids=[...prompt.matchAll(/Request ID: `([^`]+)`/g)].map(match=>match[1]!);
   const text=phase?JSON.stringify({status:'CLEAN',findings:[],confirmations:ids.map(requestId=>({requestId,decision,rationale:'The captured evidence still leaves the original defect'}))}):report('§ Work','Concurrent writes overwrite captured results','MUST');
   return {outcome:{status:'ok',text,resume:null,sessionId:null},invocations:[]};
  };
  assert.equal((await f.call()).exit,0);await f.add('ruling',{subject:'review:plan-work.plan:R1-F001',ruling:'rejected',rationale:'Writes are isolated'});phase=1;
  assert.equal((await f.call()).exit,0);assert.equal((await f.call()).exit,0);
  const id='rejection:plan-work.plan:R1-F001';assert.equal(foldLedger(f.session).records.findLast(row=>row.kind==='escalation')?.data['id'],id);
  fs.appendFileSync(f.plan,'\n## New evidence\nWrites use separate records.\n');
  const before=launched,seq=foldLedger(f.session).lastSeq;assert.equal((await f.call()).output.reason,'escalation-open');assert.equal(launched,before);assert.equal(foldLedger(f.session).lastSeq,seq);
  await f.add('escalation',{id,state:'resolved',summary:'User decision: recheck the separate record evidence'});
  assert.equal((await f.call()).exit,0);assert.equal(foldLedger(f.session).records.findLast(row=>row.kind==='escalation')?.data['state'],'open');
  assert.equal((await f.call()).output.reason,'escalation-open');
  await f.add('escalation',{id,state:'resolved',summary:'User decision: confirm isolated records'});decision='agree';
  assert.equal((await f.call()).exit,0);assert.equal((await f.call()).output.reason,'round-cap');
 }finally{f.cleanup();}
});

test('unanswered source in past-cap rejection rounds escalate across edits and resolution grants a bounded retry',async()=>{
 const f=await fixture();try {
  // Three recorded grants keep the no-response retry below its ceiling.
  for(const ceiling of [4,6,8]){await openCeiling(f,PLAN_REVIEW,ceiling);await resolveCeiling(f,PLAN_REVIEW,ceiling,'model-effort: retry the missing source');}
  let phase='finding',launches=0;
  f.deps.delegate=async(provider,request)=>{
   launches++;const ids=[...fs.readFileSync(request.promptPath,'utf8').matchAll(/Request ID: `([^`]+)`/g)].map(m=>m[1]!);
   if(phase==='finding')return {outcome:{status:'ok',text:report(undefined,undefined,'MUST'),resume:null,sessionId:null},invocations:[]};
   if(ids.length && phase==='missing' && provider==='claude')return {outcome:{status:'fail',cls:'auth',detail:'Source credentials unavailable'},invocations:[]};
   return {outcome:{status:'ok',text:JSON.stringify({status:'CLEAN',findings:[],confirmations:ids.map(requestId=>({requestId,decision:provider==='agy'?'agree':phase,rationale:'Checked the captured evidence'}))}),resume:null,sessionId:null},invocations:[]};
  };
  assert.equal((await f.call()).exit,0);await f.add('ruling',{subject:'review:plan-work.plan:R1-F001',ruling:'rejected',rationale:'Writes are isolated'});phase='missing';
  assert.equal((await f.call()).exit,0);assert.equal((await f.call()).exit,0);
  const id='rejection:plan-work.plan:R1-F001';assert.equal(foldLedger(f.session).records.some(row=>row.kind==='escalation' && row.data['id']===id),false);
  fs.appendFileSync(f.plan,'\n## New evidence\nCaptured isolation.\n');await f.add('ruling',{subject:'review:plan-work.plan:R1-F001',ruling:'rejected',rationale:'New evidence for isolation'});
  assert.equal((await f.call()).exit,0);assert.equal(foldLedger(f.session).records.findLast(row=>row.kind==='escalation')?.data['id'],id);
  const before=launches,seq=foldLedger(f.session).lastSeq;assert.equal((await f.call()).output.reason,'escalation-open');assert.equal(launches,before);assert.equal(foldLedger(f.session).lastSeq,seq);
  await f.add('escalation',{id,state:'resolved',summary:'User decision: retry source credentials'});assert.equal((await f.call()).exit,0);
  phase='disagree';assert.equal((await f.call()).exit,0);phase='missing';assert.equal((await f.call()).exit,0);assert.equal(foldLedger(f.session).records.findLast(row=>row.kind==='escalation')?.data['state'],'resolved');
  assert.equal((await f.call()).exit,0);assert.equal(foldLedger(f.session).records.findLast(row=>row.kind==='escalation')?.data['state'],'open');
  await f.add('ruling',{subject:'review:plan-work.plan:R1-F001',ruling:'accepted',rationale:'Repair the original finding'});phase='agree';assert.equal((await f.call()).exit,0);
 }finally{f.cleanup();}
});

test('rejected MUST saved confirmation generation survives crashes and supersedes relevant rulings only',async()=>{
 for(const changed of [false,true]) {
  const f=await fixture();try {
   f.deps.delegate=async()=>({outcome:{status:'ok',text:report('§ Work','Concurrent writes overwrite captured results','MUST'),resume:null,sessionId:null},invocations:[]});
   await f.call();await f.add('ruling',{subject:'review:plan-work.plan:R1-F001',ruling:'rejected',rationale:'Isolated writes'});
   let launches=0;f.deps.delegate=async(_provider,request)=>{launches++;const prompt=fs.readFileSync(request.promptPath,'utf8');const ids=[...prompt.matchAll(/Request ID: `([^`]+)`/g)].map(m=>m[1]!);return {outcome:{status:'ok',text:JSON.stringify({status:'CLEAN',findings:[],confirmations:ids.map(requestId=>({requestId,decision:'agree',rationale:'Checked the isolated writes'}))}),resume:null,sessionId:null},invocations:[]};};
   f.deps.hook=point=>{if(point==='review:after-pending')throw Error('crash');};assert.equal((await f.call()).exit,2);delete f.deps.hook;
   if(changed)await f.add('ruling',{subject:'review:plan-work.plan:R1-F001',ruling:'rejected',rationale:'New evidence for isolated writes'});else await f.add('note',{text:'Unrelated observation'});
   const before=launches;
   const result=await f.call();assert.equal(result.exit,changed?4:0);assert.equal(launches,before);
   if(changed){assert.equal(result.output.reason,'target-moved');assert.equal((await f.call()).exit,0);assert.ok(launches>before);assert.equal(f.read(2,'round.json').generation,2);}else assert.equal(f.read(2,'round.json').generation,1);
  }finally{f.cleanup();}
 }
});

test('accepted MUST fixes extend the round cap until a round has none',async()=>{
  const f=await fixture();
  try {
    let severity='MUST', step=0;
    f.deps.delegate=async(provider,request,mode)=>{f.launches.push({provider,request,mode});return {outcome:{status:'ok',text:report('§ Work','Defect '+step,severity),resume:null,sessionId:null},invocations:[]};};
    const round=async(ruling:string)=>{
      step++; assert.equal((await f.call()).exit,0);
      await f.add('ruling',{subject:'review:plan-work.plan:R'+step+'-F001',ruling,rationale:'Resolution'});
      fs.appendFileSync(f.plan,'\n## Fix '+step+'\nChanged.\n');
    };
    await round('accepted'); await round('deferred');
    assert.equal((await f.call()).output.reason,'round-cap');
    await f.add('ruling',{subject:'review:plan-work.plan:R2-F001',ruling:'accepted',rationale:'Fixed after all'});
    severity='SHOULD'; await round('accepted');
    assert.match(f.output().summary,/round 3\/2/);
    assert.equal((await f.call()).output.reason,'round-cap');
  }finally{f.cleanup();}
});

