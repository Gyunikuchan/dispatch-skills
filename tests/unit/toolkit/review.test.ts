import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { appendRecord, foldLedger } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { sessionFixture } from './helpers/session.ts';
import { artifactHash } from '../../../skills/dispatch/scripts/toolkit/artifacts.ts';

const CLEAN = JSON.stringify({status:'CLEAN',findings:[]});
const report = (locus = '§ Work', defect = 'Concurrent writes overwrite captured results') => JSON.stringify({status:'FINDINGS',findings:[{severity:'SHOULD',tag:'reliability',locus,defect,requiredChange:'Keep writes isolated until finalization'}]});
async function fixture() {
  const f=sessionFixture();
  const skill=path.join(f.root,'skill');
  fs.mkdirSync(path.join(skill,'references/templates'),{recursive:true});
  for(const file of ['review-prompt.md','review-prompt-plan.md','review-prompt-design.md','review-prompt-code.md','quality-bar.md'])
    fs.copyFileSync(path.join(f.deps.skillRoot,'references/templates',file),path.join(skill,'references/templates',file));
  f.deps.skillRoot=skill;
  const config=(native=false)=>fs.writeFileSync(path.join(skill,'config.jsonc'),JSON.stringify({
    'read-delegates':native?{codex:{nativeSubagentsOnly:true,targets:[{low:{model:'native'}}]}}:{claude:{targets:[{low:{model:'fake'}}]},agy:{targets:[{low:{model:'fake'}}]}},
    phases:{'plan-review':{targets:{low:0,medium:2},rounds:{low:0,medium:2}},'code-review':{targets:{low:2},rounds:{low:2}}},
  }));config();
  const spec=f.artifact('mission.spec.md','# Mission\n## Intent & Problem\nKeep captured work recoverable.\n## Requirements\n### REQ-1 — Works\n');
  const plan=f.artifact('work.plan.md','# Work\n## Work\nOriginal body.\n## Review Findings & Resolutions\nDriver log.\n');
  let key=0;
  const add=(kind:string,data:object)=>appendRecord(f.session,{kind,by:'orchestrator',key:'input-'+key++,data},f.deps);
  await add('bind',{spec:'mission.spec.md',plan:'work.plan.md'});
  f.deps.delegate=async(provider,request,mode)=>{
    f.launches.push({provider,request,mode});
    return {outcome:{status:'ok',text:report(),resume:null,sessionId:null},invocations:[]};
  };
  const call=async(kind='plan',target=plan,level='medium')=>{
    f.lines.length=0;
    const exit=await main(['review','run',target,'--kind',kind,'--level',level,'--session',f.session],f.deps);
    const output=f.output();
    return {exit,output,value:output.path?JSON.parse(fs.readFileSync(output.path,'utf8')):null};
  };
  const directory=path.join(f.session,'.state/reviews/plan-work.plan');
  const read=(round:number,file:string)=>JSON.parse(fs.readFileSync(path.join(directory,'round-'+round,file),'utf8'));
  return {...f,spec,plan,add,call,directory,read,config};
}

test('review rounds capture dedupe clusters scope caps and design prompts',async()=>{
  const f=await fixture();
  try {
    const first=await f.call(); assert.equal(first.exit,0);
    const round=f.read(1,'round.json'), findings=f.read(1,'findings.json');
    assert.equal(round.generation,1); assert.equal(round.cap,2); assert.match(round.target,/^sha256:/);
    assert.equal(fs.readFileSync(path.join(f.directory,'round-1/target.snapshot.md'),'utf8'),fs.readFileSync(f.plan,'utf8'));
    assert.equal(findings.findings[0].id,'R1-F001'); assert.equal(findings.clusters.length,1);
    assert.equal(findings.clusters[0].file,f.plan); assert.ok(findings.findings[0].sources.length>=2);
    assert.match(first.output.summary,/round 1\/2/); assert.match(first.output.summary,/1 SHOULD/);
    assert.match(fs.readFileSync(f.launches[0]!.request.promptPath,'utf8'),/Full review/);
    await f.add('ruling',{subject:'review:plan-work.plan:R1-F001',ruling:'accepted',rationale:'Fixed the race'});
    fs.appendFileSync(f.plan,'\n## New work\nChanged.\n');
    assert.equal((await f.call()).exit,0);
    const prompt=fs.readFileSync(f.launches.at(-1)!.request.promptPath,'utf8');
    assert.match(prompt,/changed: New work/); assert.match(prompt,/Settled in earlier rounds/); assert.match(prompt,/accepted/);
    assert.doesNotMatch(prompt.split('- Scope: ')[1]!.split('\n')[0]!,/Review Findings & Resolutions/);
    assert.equal((await f.call()).output.reason,'round-cap');
    const design=f.artifact('strategy.design.md','# Strategy\n## Boundaries\nA boundary.\n');
    assert.equal((await f.call('design',design)).exit,0);
    assert.match(fs.readFileSync(f.launches.at(-1)!.request.promptPath,'utf8'),/Design Path:|Design:/);
  } finally {f.cleanup();}
});

test('review rounds gate skip native pending and all failed slots',async()=>{
  const f=await fixture();
  try {
    assert.equal((await f.call('plan',f.plan,'max')).output.reason,'level-unapproved'); assert.equal(f.launches.length,0);
    const low=await f.call('plan',f.plan,'low'); assert.equal(low.exit,0); assert.equal(low.output.summary,'review skipped at low');
    assert.equal(fs.existsSync(path.join(f.directory,'round-1')),false);
    f.config(true);f.deps.liveness={};
    f.deps.orchestrator={platform:'codex',model:'native'} as typeof f.deps.orchestrator;
    const pending=await f.call(); assert.equal(pending.exit,4); assert.equal(pending.output.reason,'native-pending'); assert.equal(f.launches.length,0);
    assert.ok(pending.value.pending.length>0); assert.equal(fs.existsSync(path.join(f.directory,'round-1/pending.json')),false);
    for(const slot of pending.value.pending) fs.writeFileSync(slot.replyPath,CLEAN);
    assert.equal((await f.call()).exit,0); assert.equal(f.launches.length,0);
  } finally {f.cleanup();}
  const failed=await fixture();
  try {
    failed.deps.orchestrator=null;
    failed.deps.delegate=async()=>({outcome:{status:'fail',cls:'config',detail:'Invalid launch'},invocations:[]});
    const result=await failed.call(); assert.equal(result.exit,2); assert.equal(result.output.reason,'review-failed');
    assert.equal(fs.existsSync(path.join(failed.directory,'round-1/findings.json')),false);
  } finally {failed.cleanup();}
});

test('review rounds reuse slots supersede generations and reject moving targets',async()=>{
  const f=await fixture();
  try {
    let crash=true;
    f.deps.hook=point=>{if(point==='fanout:after-slot'&&crash){crash=false;throw new Error('Interrupted');}};
    assert.equal((await f.call()).exit,2);
    const count=f.launches.length; delete f.deps.hook;
    const slots=path.join(f.directory,'round-1/gen-1/slots');
    fs.unlinkSync(path.join(slots,fs.readdirSync(slots)[0]!));
    assert.equal((await f.call()).exit,0); assert.equal(f.launches.length,count+1);
  } finally {f.cleanup();}
  for(const moved of ['plan','spec']) {
    const f=await fixture();
    try {
      let edit=true;
      const delegate=f.deps.delegate;
      f.deps.delegate=async(...args)=>{const value=await delegate(...args);if(edit){edit=false;fs.appendFileSync(moved==='plan'?f.plan:f.spec,'\n## Added\nMoved.\n');}return value;};
      const result=await f.call(); assert.equal(result.output.reason,'target-moved');
      assert.equal(fs.existsSync(path.join(f.directory,'round-1/findings.json')),false);
      const gen1=fs.readdirSync(path.join(f.directory,'round-1/gen-1/slots'));
      assert.equal((await f.call()).exit,0); assert.equal(f.read(1,'round.json').generation,2);
      if(moved==='spec')assert.equal(f.read(1,'round.json').spec.hash,artifactHash('spec',fs.readFileSync(f.spec,'utf8')));
      assert.deepEqual(fs.readdirSync(path.join(f.directory,'round-1/gen-1/slots')),gen1);
      assert.equal(fs.readFileSync(path.join(f.directory,'round-1/target.snapshot.md'),'utf8'),fs.readFileSync(f.plan,'utf8'));
      assert.ok(!fs.readdirSync(path.join(f.directory,'round-1')).some(name=>name.startsWith('superseded-')));
    } finally {f.cleanup();}
  }
});

test('review rounds code prompt uses intent and raw task markdown with file clusters and failed slots',async()=>{
  const f=await fixture();
  try {
    fs.writeFileSync(f.plan,`# Work
## Task Map
| ID | Title | Outcome | Prerequisites | Criteria |
| --- | --- | --- | --- | --- |
| T1 | First | Works | none | SC1 |
## Proposed Changes
### T1 — First
#### [NEW] src/first.ts
- Purpose: Keep captured work recoverable.
## Success Criteria
- [SC1] Works
  - Changes: src/first.ts
  - Verify: \`node check\`
  - Evidence: verify
## Verification Plan
### Automated Tests
- \`node check\`
`);
    await f.add('writer',{phase:'launched',task:'T1',path:'.state/worktrees/T1-1',base:{commit:'a'.repeat(40),taskSection:'sha256:'+'b'.repeat(64),seq:1}});
    await f.add('writer',{phase:'finished',task:'T1',launch:1,candidate:'c'.repeat(40)});
    f.deps.run=async()=>({exit:0,stdout:'src/first.ts\0src/second.ts\0',stderr:''});
    f.deps.delegate=async(provider,request,mode)=>{
      f.launches.push({provider,request,mode});
      const text=report(provider==='claude'?'src/first.ts:L1':'src/second.ts:L1');
      return {outcome:{status:'ok',text,resume:null,sessionId:null},invocations:[]};
    };
    const result=await f.call('code','T1');assert.equal(result.exit,0);
    const prompt=fs.readFileSync(f.launches[0]!.request.promptPath,'utf8');
    const summary=prompt.split('- Task: ')[1]!.split('\n- Spec Path:')[0]!;
    assert.equal(summary,'Keep captured work recoverable.\n\n### T1 — First\n#### [NEW] src/first.ts\n- Purpose: Keep captured work recoverable.\n\n- [SC1] Works\n  - Changes: src/first.ts\n  - Verify: `node check`\n  - Evidence: verify');
    assert.doesNotMatch(summary,/sha256:/);
    const findings=JSON.parse(fs.readFileSync(result.value.path,'utf8'));assert.deepEqual(findings.clusters.map((cluster:{file:string})=>cluster.file),['src/first.ts','src/second.ts']);
    f.deps.delegate=async(provider,request,mode)=>{f.launches.push({provider,request,mode});return provider==='agy'?{outcome:{status:'fail',cls:'auth',detail:'No access'},invocations:[]}:{outcome:{status:'ok',text:CLEAN,resume:null,sessionId:null},invocations:[]};};
    assert.equal((await f.call()).exit,0);assert.equal(f.read(1,'findings.json').failed.length,1);
  }finally{f.cleanup();}
});

test('review rounds exclusive claim and late native replies stay isolated',async()=>{
  const f=await fixture();
  try {
    let release!:()=>void, started!:()=>void;
    const ready=new Promise<void>(resolve=>started=resolve), held=new Promise<void>(resolve=>release=resolve);
    f.deps.delegate=async()=>{started();await held;return {outcome:{status:'ok',text:CLEAN,resume:null,sessionId:null},invocations:[]};};
    f.deps.isAlive=()=>true;
    const first=main(['review','run',f.plan,'--kind','plan','--session',f.session],{...f.deps,stdout:()=>{}});
    assert.equal(await Promise.race([ready.then(()=>true),first.then(()=>false)]),true);
    const other=await f.call(); assert.equal(other.exit,3);assert.equal(other.output.reason,'lock-held');
    release(); assert.equal(await first,0);
  } finally {f.cleanup();}
  const n=await fixture();
  try {
    n.config(true);n.deps.liveness={};n.deps.orchestrator={platform:'codex',model:'native'} as typeof n.deps.orchestrator;
    const first=await n.call();const old=first.value.pending[0].replyPath;
    fs.appendFileSync(n.plan,'\n## Added\nNew generation.\n');
    const second=await n.call();assert.equal(second.output.reason,'native-pending');
    fs.writeFileSync(old,CLEAN);
    const third=await n.call();assert.equal(third.output.reason,'native-pending');assert.equal(n.read(1,'round.json').generation,2);
    assert.ok(third.value.pending.every((slot:{replyPath:string})=>slot.replyPath.includes('gen-2')));
  } finally {n.cleanup();}
});

test('review recurrence requires accepted earlier ruling and changed target',async()=>{
  for(const variant of ['accepted','unchanged','rejected','late']) {
    const f=await fixture();
    try {
      assert.equal((await f.call()).exit,0);
      if(variant!=='late')await f.add('ruling',{subject:'review:plan-work.plan:R1-F001',ruling:variant==='rejected'?'rejected':'accepted',rationale:'Resolution'});
      if(variant!=='unchanged')fs.appendFileSync(f.plan,'\n## Fixed\nChanged.\n');
      if(variant==='late')f.deps.hook=async point=>{if(point==='fanout:after-slot'){delete f.deps.hook;await f.add('ruling',{subject:'review:plan-work.plan:R1-F001',ruling:'accepted',rationale:'Late'});}};
      const result=await f.call();assert.equal(result.exit,0);
      const finding=f.read(2,'findings.json').findings[0];
      assert.deepEqual(finding[variant==='accepted'?'recurrence':'unresolved'],{of:'R1-F001'});
      assert.equal(foldLedger(f.session).records.filter(row=>row.kind==='escalation').length,variant==='accepted'?1:0);
      if(variant==='accepted'){
        const escalation=foldLedger(f.session).records.at(-1)!;
        assert.equal(escalation.by,'tool');assert.equal(escalation.data['id'],'recurrence:plan-work.plan:R2-F001:g1');
        assert.equal(escalation.data['state'],'open');assert.match(result.output.summary,/1 recurrences/);
      }
    }finally{f.cleanup();}
  }
});

test('review recurrence recovers durable boundaries and resolves superseded escalation',async()=>{
  for(const point of ['review:after-pending','review:after-append']) for(const move of [false,true]) {
    const f=await fixture();
    try {
      assert.equal((await f.call()).exit,0);
      await f.add('ruling',{subject:'review:plan-work.plan:R1-F001',ruling:'accepted',rationale:'Fixed'});
      fs.appendFileSync(f.plan,'\n## Fix\nFirst fix.\n');
      f.deps.hook=p=>{if(p===point)throw new Error('Interrupted boundary');};
      assert.equal((await f.call()).exit,2);const launched=f.launches.length; delete f.deps.hook;
      if(move)fs.appendFileSync(f.plan,'\n## Second fix\nMoved again.\n');
      const resumed=await f.call();assert.equal(resumed.exit,move?4:0);assert.equal(f.launches.length,launched);
      if(move){
        assert.equal(resumed.output.reason,'target-moved');assert.equal(fs.existsSync(path.join(f.directory,'round-2/findings.json')),false);
        f.deps.delegate=async()=>({outcome:{status:'ok',text:report('§ Work','Concurrent writes overwrite captured results again'),resume:null,sessionId:null},invocations:[]});
        assert.equal((await f.call()).exit,0);
      }
      const escalations=foldLedger(f.session).records.filter(row=>row.kind==='escalation');
      const latest=new Map(escalations.map(row=>[row.data['id'],row.data['state']]));
      assert.equal([...latest.values()].filter(state=>state==='open').length,1);
      if(move&&point==='review:after-append')assert.ok(escalations.some(row=>row.data['state']==='resolved'));
    }finally{f.cleanup();}
  }
});

test('review recurrence refuses changed bound spec before recovering pending findings',async()=>{
  const f=await fixture();
  try {
    await f.call();
    await f.add('ruling',{subject:'review:plan-work.plan:R1-F001',ruling:'accepted',rationale:'Fixed'});
    fs.appendFileSync(f.plan,'\n## Fixed\nChanged.\n');
    f.deps.hook=point=>{if(point==='review:after-pending')throw new Error('Interrupted');};
    assert.equal((await f.call()).exit,2);delete f.deps.hook;
    fs.appendFileSync(f.spec,'\n## New constraint\nChanged.\n');
    const count=f.launches.length;assert.equal((await f.call()).output.reason,'target-moved');assert.equal(f.launches.length,count);
    assert.equal(fs.existsSync(path.join(f.directory,'round-2/findings.json')),false);
    assert.equal(foldLedger(f.session).records.filter(row=>row.kind==='escalation').length,0);
  }finally{f.cleanup();}
});

test('review recurrence rejects invalid review ruling and keeps other subjects free text',async()=>{
  const f=await fixture();
  try {
    await assert.rejects(f.add('ruling',{subject:'review:plan-work.plan:R1-F001',ruling:'fixed',rationale:'Fixed'}),{reason:'invalid-record'});
    await f.add('ruling',{subject:'other',ruling:'fixed',rationale:'Fixed'});
    assert.equal(foldLedger(f.session).records.at(-1)!.data['ruling'],'fixed');
  }finally{f.cleanup();}
});

test('review recurrence normal post-append movement closes stale escalation before a clean generation',async()=>{
  const f=await fixture();
  try {
    assert.equal((await f.call()).exit,0);
    await f.add('ruling',{subject:'review:plan-work.plan:R1-F001',ruling:'accepted',rationale:'Fixed'});
    fs.appendFileSync(f.plan,'\n## Fix\nFirst fix.\n');
    f.deps.hook=point=>{if(point==='review:after-append')fs.appendFileSync(f.plan,'\n## Another fix\nMoved again.\n');};
    assert.equal((await f.call()).output.reason,'target-moved');delete f.deps.hook;
    assert.equal(fs.existsSync(path.join(f.directory,'round-2/findings.json')),false);
    f.deps.delegate=async()=>({outcome:{status:'ok',text:CLEAN,resume:null,sessionId:null},invocations:[]});
    assert.equal((await f.call()).exit,0);
    const latest=new Map(foldLedger(f.session).records.filter(row=>row.kind==='escalation').map(row=>[row.data['id'],row.data['state']]));
    assert.deepEqual([...latest.values()],['resolved']);
  }finally{f.cleanup();}
});
