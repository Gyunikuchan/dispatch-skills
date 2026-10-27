import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { main, type CliDeps } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { appendRecord, foldLedger } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { artifactHash } from '../../../skills/dispatch/scripts/toolkit/artifacts.ts';
import { memoryNodeFs } from '../../helpers/memory-node-fs.ts';

const CLEAN = JSON.stringify({status:'CLEAN',findings:[]});
const report = (locus = '§ Work', defect = 'Concurrent writes overwrite captured results', severity = 'SHOULD') => JSON.stringify({status:'FINDINGS',findings:[{severity,tag:'reliability',locus,defect,requiredChange:'Keep writes isolated until finalization'}]});
const templates=['review-prompt.md','review-prompt-plan.md','review-prompt-design.md','review-prompt-code.md','quality-bar.md'].map(file=>[file,fs.readFileSync(path.resolve('skills/dispatch/references/templates',file),'utf8')] as const);
async function fixture(bound=true) {
  // A shallow virtual root avoids physical ancestor probes in quota-path validation.
  const root=path.join(path.parse(os.tmpdir()).root,'review-'+crypto.randomUUID());
  const cleanup=memoryNodeFs(root);
  const session=path.join(root,'.scratch/dispatch-skills/20261023T0000Z-test');
  fs.mkdirSync(session,{recursive:true});
  fs.writeFileSync(path.join(session,'manifest.json'),JSON.stringify({schemaVersion:1,folderName:path.basename(session),sessionId:'test',safeSessionId:'test',repositoryRoot:fs.realpathSync(root)}));
  const lines:string[]=[], launches:{provider:Parameters<CliDeps['delegate']>[0];request:Parameters<CliDeps['delegate']>[1];mode:Parameters<CliDeps['delegate']>[2]}[]=[];
  const deps:CliDeps={
    run:async()=>{throw new Error('Unit tests must not spawn processes');},
    delegate:async()=>{throw new Error('Unscripted delegate');},
    modes:()=>['cli'],orchestrator:null,liveness:{claude:true,agy:true,codex:true,copilot:true,opencode:true},
    stdout:line=>lines.push(line),env:{},clock:()=>0,sleep:async()=>{},pid:42,host:'test-host',isAlive:()=>false,skillRoot:path.resolve('skills/dispatch'),
  };
  const f={root,session,lines,launches,deps,cleanup,
    artifact:(name:string,source:string)=>{const file=path.join(root,name);fs.writeFileSync(file,source);return file;},
    output:()=>{assert.equal(lines.length,1);return JSON.parse(lines[0]!) as {ok:boolean;summary:string;path:string|null;reason?:string};},
  };
  const skill=path.join(f.root,'skill');
  fs.mkdirSync(path.join(skill,'references/templates'),{recursive:true});
  for(const [file,source] of templates)fs.writeFileSync(path.join(skill,'references/templates',file),source);
  f.deps.skillRoot=skill;
  const config=(native=false)=>fs.writeFileSync(path.join(skill,'config.jsonc'),JSON.stringify({
    'read-delegates':native?{codex:{nativeSubagentsOnly:true,targets:[{low:{model:'native'}}]}}:{claude:{targets:[{low:{model:'fake'}}]},agy:{targets:[{low:{model:'fake'}}]}},
    phases:{'plan-review':{targets:{low:0,medium:2},rounds:{low:0,medium:2}},'code-review':{targets:{low:2},rounds:{low:2}}},
  }));config();
  const spec=f.artifact('mission.spec.md','# Mission\n## Intent & Problem\nKeep captured work recoverable.\n## Requirements\n### REQ-1 — Works\n');
  const plan=f.artifact('work.plan.md','# Work\n## Work\nOriginal body.\n## Review Findings & Resolutions\nDriver log.\n');
  let key=0;
  const add=(kind:string,data:object)=>appendRecord(f.session,{kind,by:'orchestrator',key:'input-'+key++,data},f.deps);
  if(bound) await add('bind',{spec:'mission.spec.md',plan:'work.plan.md'});
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

test('standalone review targets accept spec overrides and stable Git snapshots',async()=>{
  const f=await fixture(false);
  try {
    f.config(true);f.deps.liveness={};
    f.deps.orchestrator={platform:'codex',model:'native'} as typeof f.deps.orchestrator;
    const calls:{argv:string[];env:NodeJS.ProcessEnv|undefined}[]=[];
    let tree='tree-one', feature='feature-id', missing=false, unrelated=false, heads:string[]=[], head='head-id';
    f.deps.run=async(argv,options)=>{
      calls.push({argv,env:options.env});
      const op=argv[1];
      if(op==='rev-parse') return {exit:missing||argv.at(-1)==='T1^{commit}'?1:0,stdout:argv.at(-1)==='HEAD^{commit}'?heads.shift()??head:argv.at(-1)==='feature^{commit}'?feature:'main-id',stderr:'unknown revision'};
      if(op==='merge-base')return {exit:unrelated?1:0,stdout:'ancestor-id',stderr:'no common ancestor'};
      return {exit:0,stdout:op==='write-tree'?tree:op==='commit-tree'?'snapshot-'+tree:op==='diff'?'src.ts\0':'',stderr:''};
    };
    const call=async(kind:string,target:string,spec:string|null='mission.spec.md')=>{
      f.lines.length=0;
      const exit=await main(['review','run',target,'--kind',kind,'--level','medium','--session',f.session,...(spec===null?[]:['--spec',spec])],f.deps);
      const output=f.output();return {exit,output,value:output.path?JSON.parse(fs.readFileSync(output.path,'utf8')):null};
    };
    const finish=async(result:Awaited<ReturnType<typeof call>>,kind:string,target:string,spec?:string)=>{
      assert.equal(result.exit,4);assert.equal(result.output.reason,'native-pending');
      for(const slot of result.value.pending)fs.writeFileSync(slot.replyPath,CLEAN);
      const done=await call(kind,target,spec);assert.equal(done.exit,0,JSON.stringify(done));
      assert.deepEqual(JSON.parse(fs.readFileSync(done.value.path,'utf8')).findings,[]);
      return done;
    };
    const design=f.artifact('strategy.design.md','# Strategy\n## Boundaries\nA boundary.\n');
    const pending=await call('design',design);
    await finish(pending,'design',design,f.spec);
    const designRound=JSON.parse(fs.readFileSync(path.join(f.session,'.state/reviews/design-strategy.design/round-1/round.json'),'utf8'));
    assert.equal(designRound.spec.path,fs.realpathSync.native(f.spec));
    await finish(await call('plan',f.plan),'plan',f.plan);
    assert.equal((await call('code','integration')).output.reason,'lint-errors');
    const work=await call('code','worktree');
    await finish(work,'code','worktree');
    const commit=calls.find(row=>row.argv[1]==='commit-tree')!;
    assert.deepEqual(commit.argv.slice(2),['tree-one','-p','head-id','-m','dispatch review snapshot']);
    for(const role of ['AUTHOR','COMMITTER']) {
      assert.equal(commit.env!['GIT_'+role+'_NAME'],'Dispatch Review');
      assert.equal(commit.env!['GIT_'+role+'_EMAIL'],'dispatch-review@localhost');
      assert.equal(commit.env!['GIT_'+role+'_DATE'],'1970-01-01T00:00:00Z');
    }
    assert.ok(calls.some(row=>row.argv[1]==='read-tree'&&row.argv[2]==='head-id'));
    assert.ok(calls.some(row=>row.argv[1]==='reset'&&row.argv.at(-1)===':(top,literal)'+path.relative(fs.realpathSync(f.root),fs.realpathSync(f.session)).split(path.sep).join('/')));
    tree='tree-two';assert.equal((await call('code','worktree')).output.reason,'native-pending');
    tree='tree-three';assert.equal((await call('code','worktree')).output.reason,'native-pending');
    const workDir=fs.readdirSync(path.join(f.session,'.state/reviews')).find(name=>name.startsWith('code-worktree-'))!;
    const moved=JSON.parse(fs.readFileSync(path.join(f.session,'.state/reviews',workDir,'round-2/round.json'),'utf8'));
    assert.deepEqual(moved.target,{base:'head-id',head:'snapshot-tree-three'});assert.equal(moved.generation,2);
    heads=['fresh-head'];head='moved-head';assert.equal((await call('code','worktree')).output.reason,'target-moved');head='head-id';
    for(const target of ['feat/x','feat-x','main..feature','main'])assert.equal((await call('code',target)).output.reason,'native-pending');
    feature='moved-feature';assert.equal((await call('code','main..feature')).output.reason,'native-pending');
    const rangeDir=fs.readdirSync(path.join(f.session,'.state/reviews')).find(name=>name.startsWith('code-main..feature-'))!;
    const range=JSON.parse(fs.readFileSync(path.join(f.session,'.state/reviews',rangeDir,'round-1/round.json'),'utf8'));
    assert.deepEqual(range.target,{base:'main-id',head:'moved-feature'});assert.equal(range.generation,2);
    const dirs=fs.readdirSync(path.join(f.session,'.state/reviews')).filter(name=>name.startsWith('code-feat-x-'));
    assert.equal(dirs.length,2);assert.notEqual(dirs[0],dirs[1]);
    assert.ok(calls.some(row=>JSON.stringify(row.argv)===JSON.stringify(['git','rev-parse','--verify','--end-of-options','feature^{commit}'])));
    assert.ok(calls.some(row=>JSON.stringify(row.argv)===JSON.stringify(['git','merge-base','main-id','head-id'])));
    assert.equal((await call('code','T1')).output.reason,'invalid-input');
    unrelated=true;const orphan=await call('code','orphan');assert.equal(orphan.output.reason,'invalid-input');assert.match(orphan.output.summary,/common ancestor/);unrelated=false;
    missing=true;assert.equal((await call('code','worktree')).output.reason,'invalid-input');missing=false;
    assert.equal((await call('plan',f.plan,'absent.spec.md')).output.reason,'invalid-input');
    const noSpec=await call('plan',f.plan,null);assert.equal(noSpec.exit,4);assert.equal(noSpec.output.reason,'lint-errors');
    await f.add('bind',{spec:'mission.spec.md',plan:'work.plan.md'});
    const override=f.artifact('override.spec.md','# Override\n## Requirements\n### REQ-1 — Override\n');
    assert.equal((await call('design',design,override)).output.reason,'native-pending');
    const overridden=JSON.parse(fs.readFileSync(path.join(f.session,'.state/reviews/design-strategy.design/round-2/round.json'),'utf8'));
    assert.equal(overridden.spec.path,fs.realpathSync.native(override));
  }finally{f.cleanup();}
});

test('standalone Git reviews survive invalid or missing bound plans',async()=>{
  const f=await fixture();
  try {
    f.deps.delegate=async()=>({outcome:{status:'ok',text:CLEAN,resume:null,sessionId:null},invocations:[]});
    f.deps.run=async(argv)=>({exit:0,stdout:argv[1]==='diff'?'src.ts\0':argv[1]==='write-tree'?'tree-id':argv[1]==='commit-tree'?'snapshot-id':'commit-id',stderr:''});
    for(const state of ['invalid','missing']) {
      if(state==='invalid')fs.writeFileSync(f.plan,'# Broken plan\n');else fs.unlinkSync(f.plan);
      for(const target of ['worktree','main..feature','main']) {
        const result=await f.call('code',target);
        assert.equal(result.exit,0,state+' '+target+' '+result.output.summary);
        assert.deepEqual(JSON.parse(fs.readFileSync(result.value.path,'utf8')).findings,[]);
      }
    }
  }finally{f.cleanup();}
});

test('standalone Git reviews explain unsupported three dot ranges',async()=>{
  const f=await fixture(false);
  try {
    f.deps.run=async()=>({exit:1,stdout:'',stderr:'unknown revision'});
    f.lines.length=0;
    const exit=await main(['review','run','main...feature','--kind','code','--spec',f.spec,'--session',f.session],f.deps);
    const output=f.output();assert.equal(exit,1);assert.equal(output.reason,'invalid-input');
    assert.match(output.summary,/three-dot.*not supported.*a\.\.b/i);
  }finally{f.cleanup();}
});

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

test('bound code review supersedes unrecorded plan and design edits during native continuation',async()=>{
 for(const artifact of ['plan','design']) {
  const f=await fixture();try{
   const source=['# Work','## Task Map','| ID | Title | Outcome | Prerequisites | Criteria |','| --- | --- | --- | --- | --- |','| T1 | File | Works | none | SC1 |','## Proposed Changes','### T1 � File','#### [NEW] src/file.ts','- Purpose: behavior.','## Success Criteria','- [SC1] Works','  - Changes: src/file.ts','  - Verify: `node check`','  - Evidence: verify','## Verification Plan','### Automated Tests','- `node contract`'].join('\n');fs.writeFileSync(f.plan,source);
   const design=f.artifact('work.design.md','# Design\n## Boundaries\nBefore.\n');await f.add('bind',{spec:'mission.spec.md',plan:'work.plan.md',design:'work.design.md'});
   const head='a'.repeat(40);await f.add('integrate',{phase:'opened',path:'.state/worktrees/integration',branch:'integration',base:head,dest:{path:f.root,branch:'main'}});await f.add('integrate',{phase:'done',task:'T1',commit:head});
   f.deps.run=async argv=>({exit:0,stdout:argv[1]==='diff'?'src/file.ts\0':head,stderr:''});f.config(true);f.deps.liveness={};f.deps.orchestrator={platform:'codex',model:'native'} as typeof f.deps.orchestrator;
   const first=await f.call('code','integration');assert.equal(first.output.reason,'native-pending');const dir=path.join(f.session,'.state/reviews/code-integration/round-1');const before=JSON.parse(fs.readFileSync(path.join(dir,'round.json'),'utf8'));
   fs.appendFileSync(artifact==='plan'?f.plan:design,'\n## Revision\nAfter.\n');for(const slot of first.value.pending)fs.writeFileSync(slot.replyPath,CLEAN);
   const second=await f.call('code','integration');assert.equal(second.output.reason,'native-pending');const after=JSON.parse(fs.readFileSync(path.join(dir,'round.json'),'utf8'));assert.equal(after.generation,2);assert.notEqual(after.artifacts[artifact],before.artifacts[artifact]);assert.deepEqual(after.target,before.target);assert.ok(second.value.pending.every((slot:{replyPath:string})=>slot.replyPath.includes('gen-2')));
  }finally{f.cleanup();}
 }
});
