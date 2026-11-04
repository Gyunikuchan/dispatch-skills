import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sessionFixture } from './helpers/session.ts';
import type { RosterSlot } from '../../../skills/dispatch/scripts/toolkit/domain/types.ts';
import type { Validation } from '../../../skills/dispatch/scripts/toolkit/fanout.ts';

const slot = (provider: string, model: string | string[] = 'good', reserve = false, native = false): RosterSlot =>
  ({slot: provider + '[0]', provider, index: 0, model, reserve, native});
const validate = (text: string) => text.trim() ? {ok: true as const, text: text.trim()} : {ok: false as const, cls: 'empty-output' as const, reason: 'empty'};
const quota = {schemaVersion:1 as const,policyVersion:1 as const,decidedAt:0,decisions:[]};

test('rejected MUST validation retains logical source across direct reserve native and replay',async()=>{
 const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
 const f=sessionFixture({memory:true});try {
   const seen:string[]=[];const check=(text:string,source:string)=>{seen.push(source);return validate(text);};
   f.script('claude','good','direct');f.script('opencode','good',{status:'fail',cls:'auth',detail:'unavailable'});f.script('copilot','good','reserve');
   const dir=path.join(f.session,'confirmation'),slots=[slot('claude'),slot('opencode'),slot('copilot','good',true),slot('codex','good',false,true)];
   const first=await fanOut({dir,slots,prompt:'confirm',validate:check,quota},f.deps);
   assert.deepEqual(seen,['claude[0]','opencode[0]']);
   const reserved=first.find(reply=>reply.slot==='opencode[0]');assert.ok(reserved?.state==='done');assert.equal(reserved.responder?.slot,'copilot[0]');
   const native=first.find(reply=>reply.state==='native');assert.ok(native?.state==='native');fs.writeFileSync(native.replyPath,'native');
   seen.length=0;await fanOut({dir,slots,prompt:'confirm',validate:check,quota},f.deps);
   assert.ok(seen.includes('codex[0]'));assert.ok(seen.includes('opencode[0]'));assert.ok(!seen.includes('copilot[0]'));
 }finally{f.cleanup();}
});

test('diagnostics retain terminal routing and unlaunched failure classes', async () => {
  const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f=sessionFixture({memory:true});try {
    const events:unknown[]=[];f.deps.diagnostics=e=>{events.push(e);};f.deps.modes=()=>[];
    const result=await fanOut({dir:path.join(f.session,'unlaunched'),slots:[slot('claude')],prompt:'question',validate,quota},f.deps);
    assert.equal(result[0]?.state,'failed');assert.equal(f.launches.length,0);
    assert.ok(events.some((e:any)=>e.kind==='routing'&&e.state==='stop'&&e.cls==='not-found'));
    assert.ok(events.some((e:any)=>e.kind==='slot'&&e.state==='failed'&&e.cls==='not-found'));
    events.length=0;f.deps.modes=()=>['cli'];f.script('claude','good',{status:'fail',cls:'auth',detail:'private'});
    await fanOut({dir:path.join(f.session,'terminal'),slots:[slot('claude')],prompt:'question',validate,quota},f.deps);
    assert.equal(events.filter((e:any)=>e.kind==='routing'&&e.state==='stop'&&e.cls==='auth').length,2,'voice and wave exhaustion use the same terminal contract');
  }finally{f.cleanup();}
});

test('fan-out launches concurrent slots in roster order and persists before hooks', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    const dir = path.join(f.session, '.state', 'fanout');
    const waiting: (() => void)[] = [];
    f.deps.delegate = async (_provider, request) => {
      assert.equal(fs.readFileSync(request.promptPath, 'utf8'), 'question');
      await new Promise<void>(resolve => { waiting.push(resolve); if(waiting.length === 3) waiting.forEach(done => done()); });
      return {outcome: {status:'ok',text:'answer',resume:null,sessionId:null}, invocations:[]};
    };
    let hooks = 0;
    f.deps.hook = () => { hooks++; if(hooks === 1) throw new Error('crash'); };
    await assert.rejects(fanOut({dir, slots:[slot('claude'),slot('agy'),slot('codex')],prompt:'question',validate,quota}, f.deps), /crash/);
    assert.equal(hooks,3);
    assert.equal(fs.readdirSync(path.join(dir,'slots')).length,3);
    f.deps.delegate = async () => {throw new Error('must reuse');};
    delete f.deps.hook;
    assert.deepEqual((await fanOut({dir,slots:[slot('claude'),slot('agy'),slot('codex')],prompt:'question',validate,quota},f.deps)).map(x=>x.state),['done','done','done']);
  } finally {f.cleanup();}
});

test('fan-out cascades validation models modes quota and one reserve', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f=sessionFixture();try {
    f.script('claude','bad',{status:'fail',cls:'model-not-found',detail:'missing'});
    f.script('claude','good','accepted');
    f.script('agy','bad',{status:'fail',cls:'quota',detail:'quota'});
    f.script('agy','good','');
    f.script('copilot','good','reserve answer');
    f.script('opencode','good',{status:'fail',cls:'auth',detail:'auth'});
    const slots=[slot('claude',['bad','good']),slot('agy',['bad','good']),slot('opencode'),slot('copilot','good',true)];
    const outcomes=await fanOut({dir:path.join(f.session,'fanout'),slots,prompt:'question',validate},f.deps);
    assert.deepEqual(outcomes.map(x=>x.state),['done','failed','done']);
    assert.deepEqual(f.launches.map(x=>x.provider+':'+x.request.model),['claude:bad','agy:bad','opencode:good','claude:good','agy:good','copilot:good']);
    assert.equal(outcomes[2]!.state === 'done' && outcomes[2]!.text,'reserve answer');
    const quotaDir=path.join(f.session,'.state','quota');
    const observations=fs.readdirSync(quotaDir).flatMap(name=>fs.readdirSync(path.join(quotaDir,name)).filter(file=>file!=='generation.json'));
    assert.equal(observations.length,1);
    f.deps.modes = () => ['cli','desktop'];
    f.deps.delegate = async (_provider,_request,mode) => ({outcome:mode==='cli'?{status:'fail',cls:'quota',detail:'quota'}:{status:'ok',text:'desktop',resume:null,sessionId:null},invocations:[]});
    const modes=await fanOut({dir:path.join(f.session,'modes'),slots:[slot('agy')],prompt:'question',validate,quota},f.deps);
    assert.equal(modes[0]!.state === 'done' && modes[0]!.text,'desktop');
  }finally{f.cleanup();}
});

test('fan-out reruns failed slots and only missing crash outcomes', async () => {
  const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f=sessionFixture({memory:true});try{
    const dir=path.join(f.session,'fanout'),slots=[slot('claude'),slot('agy'),slot('codex')];
    f.script('claude','good','one');f.script('agy','good','two');f.script('codex','good',{status:'fail',cls:'auth',detail:'failed'});
    await fanOut({dir,slots,prompt:'question',validate,quota},f.deps);
    f.launches.length=0;f.script('codex','good','three');
    assert.deepEqual((await fanOut({dir,slots,prompt:'question',validate,quota},f.deps)).map(x=>x.state),['done','done','done']);
    assert.deepEqual(f.launches.map(x=>x.provider),['codex']);
    fs.unlinkSync(path.join(dir,'slots','codex[0].json'));f.launches.length=0;
    await fanOut({dir,slots,prompt:'question',validate,quota},f.deps);
    assert.deepEqual(f.launches.map(x=>x.provider),['codex']);
  }finally{f.cleanup();}
});

test('fan-out native fallback rejects invalid replies and promotes valid replies', async () => {
  const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f=sessionFixture({memory:true});try{
    f.deps.orchestrator={platform:'claude',model:null};
    f.script('claude','good',{status:'fail',cls:'auth',detail:'failed'});
    const dir=path.join(f.session,'fanout'),slots=[slot('claude'),slot('codex','good',false,true)];
    let outcomes=await fanOut({dir,slots,prompt:'question',validate,quota},f.deps);
    assert.deepEqual(outcomes.map(x=>x.state),['native','native']);assert.equal(f.launches.length,1);
    const native=outcomes[0]!;assert.equal(native.state,'native');if(native.state!=='native')return;
    fs.writeFileSync(native.replyPath,' ');
    outcomes=await fanOut({dir,slots,prompt:'question',validate,quota},f.deps);
    assert.equal(fs.existsSync(native.replyPath+'.invalid-1'),true);assert.equal(outcomes[0]!.state,'native');
    fs.writeFileSync(native.replyPath,'valid');
    outcomes=await fanOut({dir,slots,prompt:'question',validate,quota},f.deps);
    assert.deepEqual(outcomes[0],{slot:'claude[0]',state:'done',text:'valid',responder:{slot:'claude[0]',provider:'claude',model:null,native:true}});assert.equal(f.launches.length,1);
  }finally{f.cleanup();}
});

test('fan-out native-only roster remains available on its host', async () => {
  const {resolveSlots}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f=sessionFixture({memory:true});try{
    const skillRoot=path.join(f.root,'skill');fs.mkdirSync(skillRoot);
    fs.writeFileSync(path.join(skillRoot,'config.jsonc'),JSON.stringify({'read-delegates':{codex:{nativeSubagentsOnly:true,targets:[{medium:{}}]}},phases:{'plan-review':{targets:{medium:1},rounds:{medium:2}}}}));
    f.deps.skillRoot=skillRoot;f.deps.orchestrator={platform:'codex',model:null};f.deps.liveness={codex:false};
    const roster=resolveSlots('plan','medium',f.deps);
    assert.equal(roster.rounds,2);assert.equal(roster.targets.length,1);assert.equal(roster.targets[0]!.native,true);
  }finally{f.cleanup();}
});

test('fan-out validates provider text before done and shares one deadline',async()=>{
 const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
 const f=sessionFixture({memory:true});try{
  const budgets:number[]=[];let now=0;f.deps.clock=()=>now;
  f.deps.delegate=async(_provider,request)=>{
   budgets.push(request.timeoutMs);now+=100;
   return {outcome:{status:'ok',text:request.model==='bad'?'':'accepted',resume:null,sessionId:null},invocations:[]};
  };
  const outcomes=await fanOut({dir:path.join(f.session,'validate'),slots:[slot('claude',['bad','good'])],prompt:'question',validate,quota},f.deps);
  assert.deepEqual(outcomes,[{slot:'claude[0]',state:'done',text:'accepted',responder:{slot:'claude[0]',provider:'claude',model:'good',native:false}}]);
  assert.deepEqual(budgets,[1800000,1799900]);
 }finally{f.cleanup();}
});

test('diagnostics observe validation routing and native replay without changing slots', async () => {
 const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
 const f=sessionFixture({memory:true});try {
 const delegate=f.deps.delegate;const events:unknown[]=[];f.deps.diagnostics=e=>{events.push(e);};
 const dir=path.join(f.session,'observed'),slots=[slot('claude','good',false,true)];
 const pending=await fanOut({dir,slots,prompt:'question',validate,quota},f.deps);
 assert.equal(pending[0]?.state,'native');assert.ok(events.some((e:any)=>e.kind==='native'&&e.state==='pending'));
 fs.writeFileSync(path.join(dir,'replies','claude[0].md'),' ');
 await fanOut({dir,slots,prompt:'question',validate,quota},f.deps);
 assert.ok(events.some((e:any)=>e.kind==='native'&&e.state==='invalid'));
 fs.writeFileSync(path.join(dir,'replies','claude[0].md'),'answer');
 const done=await fanOut({dir,slots,prompt:'question',validate,quota},f.deps);assert.equal(done[0]?.state,'done');
 assert.ok(events.some((e:any)=>e.kind==='native'&&e.state==='completed'));
 f.deps.delegate=async()=>({outcome:{status:'ok',text:'',resume:null,sessionId:null},invocations:[]});
 await fanOut({dir:path.join(f.session,'invalid-output'),slots:[slot('claude')],prompt:'question',validate,quota},f.deps);
 assert.ok(events.some((e:any)=>e.kind==='validation'&&e.outcome==='empty-output'));
 f.deps.delegate=delegate;f.script('opencode','good',{status:'fail',cls:'auth',detail:'private'});f.script('copilot','good','reserve answer');
 const reserved=await fanOut({dir:path.join(f.session,'reserve'),slots:[slot('opencode'),slot('copilot','good',true)],prompt:'question',validate,quota},f.deps);
 assert.equal(reserved[0]?.state,'done');assert.ok(events.some((e:any)=>e.kind==='slot'&&e.targetSlot==='opencode[0]'));
 f.deps.orchestrator={platform:'claude',model:null};f.script('claude','good',{status:'fail',cls:'auth',detail:'private'});
 const fallback=await fanOut({dir:path.join(f.session,'fallback'),slots:[slot('claude')],prompt:'question',validate,quota},f.deps);
 assert.equal(fallback[0]?.state,'native');assert.ok(events.some((e:any)=>e.kind==='routing'&&e.state==='native-fallback'));
 f.deps.diagnostics=()=>{throw new Error('observer');};
 assert.deepEqual(await fanOut({dir,slots,prompt:'question',validate,quota},f.deps),done);
 }finally{f.cleanup();}
});

test('fan-out forwards session root and read commands to delegate request', async () => {
  const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f=sessionFixture({memory:true});try {
    f.artifact('config.local.jsonc',JSON.stringify({'read-delegates':{claude:{targets:[{low:{model:'good'}}]}},'read-commands':['codegraph explore']}));
    f.deps.skillRoot=f.root;f.script('claude','good','answer');
    await fanOut({dir:path.join(f.session,'commands'),slots:[slot('claude')],prompt:'question',validate,quota,sessionRoot:f.session},f.deps);
    assert.deepEqual(f.launches[0]?.request.readCommands,['codegraph explore']);
    assert.equal(f.launches[0]?.request.sessionRoot,f.session);
  }finally{f.cleanup();}
});
test('native prompt names its reply file', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform:'claude',model:null};
    f.script('claude','good',{status:'fail',cls:'auth',detail:'failed'});
    f.script('opencode','good','answer');
    const dir = path.join(f.session,'native-prompts');
    const slots = [slot('claude'),slot('codex','good',false,true),slot('opencode')];
    const outcomes = await fanOut({dir,slots,prompt:'question',validate,quota},f.deps);
    for (const outcome of outcomes.slice(0,2)) {
      assert.equal(outcome.state,'native');
      if (outcome.state !== 'native') throw new Error('expected native slot');
      const expected = `question\n\n## Native reply\n\nWrite the reply that the instructions above require, in their exact format, to \`${outcome.replyPath}\`; do not return it inline. Then reply only \`wrote ${outcome.replyPath}\`, or \`BLOCKED: <reason>\` when you cannot write it.\n`;
      assert.equal(fs.readFileSync(outcome.promptPath,'utf8'),expected);
    }
    assert.equal(fs.readFileSync(path.join(dir,'prompts','opencode[0].md'),'utf8'),'question');
    await fanOut({dir,slots,prompt:'question',validate,quota},f.deps);
    for (const outcome of outcomes.slice(0,2)) {
      if (outcome.state !== 'native') throw new Error('expected native slot');
      assert.equal(fs.readFileSync(outcome.promptPath,'utf8').split('## Native reply').length,2);
    }
  } finally {f.cleanup();}
});
test('blocked attempt metadata is preserved across alias, reserve, native, and retry fallbacks', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    const check = (text: string): Validation => text === 'BLOCKED'
      ? {ok:false, cls:'blocked', reason:'blocked: Artifact denied', blocked:{reason:'Artifact denied', reasonHash:'hash-1'}}
      : validate(text);

    // Alias fallback
    f.script('claude','bad','BLOCKED'); f.script('claude','good','answer');
    const aliasOutcomes = await fanOut({dir:path.join(f.session,'alias'), slots:[slot('claude',['bad','good'])], prompt:'question', validate:check, quota}, f.deps);
    assert.equal(aliasOutcomes[0]?.state,'done');
    assert.deepEqual(aliasOutcomes[0]?.blocked,[{provider:'claude',model:'bad',reason:'Artifact denied',reasonHash:'hash-1'}]);

    // Reserve fallback
    f.script('claude','good','BLOCKED'); f.script('copilot','good','reserve answer');
    const reserveOutcomes = await fanOut({dir:path.join(f.session,'reserve'), slots:[slot('claude'),slot('copilot','good',true)], prompt:'question', validate:check, quota}, f.deps);
    const served = reserveOutcomes.find(outcome=>outcome.slot==='claude[0]');
    assert.equal(served?.state,'done'); assert.equal(served.state === 'done' && served.text,'reserve answer');
    assert.deepEqual(served?.blocked,[{provider:'claude',model:'good',reason:'Artifact denied',reasonHash:'hash-1'}]);

    // Native fallback
    f.deps.orchestrator = {platform:'claude',model:null};
    f.script('claude','good','BLOCKED');
    const nativeDir = path.join(f.session,'native'), nativeSlots=[slot('claude')];
    const pending = await fanOut({dir:nativeDir, slots:nativeSlots, prompt:'question', validate:check, quota}, f.deps);
    assert.equal(pending[0]?.state,'native');
    assert.deepEqual(pending[0]?.blocked,[{provider:'claude',model:'good',reason:'Artifact denied',reasonHash:'hash-1'}]);
    if (pending[0]?.state === 'native') {
      fs.writeFileSync(pending[0].replyPath,'answer');
      const nativeDone = await fanOut({dir:nativeDir, slots:nativeSlots, prompt:'question', validate:check, quota}, f.deps);
      assert.equal(nativeDone[0]?.state,'done');
      assert.deepEqual(nativeDone[0]?.blocked,[{provider:'claude',model:'good',reason:'Artifact denied',reasonHash:'hash-1'}]);
    }

    // Failed slot retry
    f.deps.orchestrator = null;
    f.script('claude','good','BLOCKED');
    const retryDir = path.join(f.session,'retry'), retrySlots=[slot('claude')];
    const failed = await fanOut({dir:retryDir, slots:retrySlots, prompt:'question', validate:check, quota}, f.deps);
    assert.equal(failed[0]?.state,'failed');
    assert.equal(failed[0]?.state === 'failed' && failed[0].cls,'blocked');
    f.script('claude','good','answer');
    const retryDone = await fanOut({dir:retryDir, slots:retrySlots, prompt:'question', validate:check, quota}, f.deps);
    assert.equal(retryDone[0]?.state,'done');
    assert.deepEqual(retryDone[0]?.blocked,[{provider:'claude',model:'good',reason:'Artifact denied',reasonHash:'hash-1'}]);
  } finally {f.cleanup();}
});
test('native blocked reply kept after later completion', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform:'claude',model:'native-model'};
    const check = (text: string): Validation => text === 'BLOCKED'
      ? {ok:false, cls:'blocked', reason:'blocked: Artifact denied', blocked:{reason:'Artifact denied', reasonHash:'hash-1'}}
      : validate(text);
    f.script('claude','good','BLOCKED');
    const dir = path.join(f.session,'native-blocked'), slots=[slot('claude')];
    const pending = await fanOut({dir, slots, prompt:'question', validate:check, quota}, f.deps);
    assert.equal(pending[0]?.state,'native');
    if (pending[0]?.state !== 'native') return;
    fs.writeFileSync(pending[0].replyPath,'BLOCKED');
    const blocked = await fanOut({dir, slots, prompt:'question', validate:check, quota}, f.deps);
    assert.equal(blocked[0]?.state,'native');
    assert.deepEqual(blocked[0]?.blocked,[
      {provider:'claude',model:'good',reason:'Artifact denied',reasonHash:'hash-1'},
      {provider:'claude',model:'native-model',reason:'Artifact denied',reasonHash:'hash-1'},
    ]);
    fs.writeFileSync(pending[0].replyPath,'answer');
    const done = await fanOut({dir, slots, prompt:'question', validate:check, quota}, f.deps);
    assert.equal(done[0]?.state,'done');
    assert.deepEqual(done[0]?.blocked,[
      {provider:'claude',model:'good',reason:'Artifact denied',reasonHash:'hash-1'},
      {provider:'claude',model:'native-model',reason:'Artifact denied',reasonHash:'hash-1'},
    ]);
  } finally {f.cleanup();}
});
test('failed slot retry same reason stays single', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    const check = (text: string): Validation => text === 'BLOCKED'
      ? {ok:false, cls:'blocked', reason:'blocked: Artifact denied', blocked:{reason:'Artifact denied', reasonHash:'hash-1'}}
      : validate(text);
    f.script('claude','bad','BLOCKED'); f.script('claude','good',{status:'fail',cls:'auth',detail:'denied'});
    const dir = path.join(f.session,'single'), slots=[slot('claude',['bad','good'])];
    assert.equal((await fanOut({dir, slots, prompt:'question', validate:check, quota}, f.deps))[0]?.state,'failed');
    f.script('claude','good','answer');
    const done = await fanOut({dir, slots, prompt:'question', validate:check, quota}, f.deps);
    assert.equal(done[0]?.state,'done');
    assert.deepEqual(done[0]?.blocked,[{provider:'claude',model:'bad',reason:'Artifact denied',reasonHash:'hash-1'}]);
  } finally {f.cleanup();}
});
test('blocked attempts beyond eight aliases kept', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    const models = Array.from({length:10},(_,index)=>'m'+index);
    const check = (text: string): Validation => text === 'BLOCKED'
      ? {ok:false, cls:'blocked', reason:'blocked: denied', blocked:{reason:'denied', reasonHash:'hash-1'}}
      : validate(text);
    f.deps.delegate = async () => ({outcome:{status:'ok',text:'BLOCKED',resume:null,sessionId:null},invocations:[]});
    const failed = await fanOut({dir:path.join(f.session,'many'), slots:[slot('claude',models)], prompt:'question', validate:check, quota}, f.deps);
    assert.equal(failed[0]?.state,'failed');
    assert.equal(failed[0]?.blocked?.length,10);
  } finally {f.cleanup();}
});
test('reserve attempts carry target slot', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.script('claude','good',{status:'fail',cls:'auth',detail:'unavailable'}); f.script('copilot','good','reserve answer');
    await fanOut({dir:path.join(f.session,'target'), slots:[slot('claude'),slot('copilot','good',true)], prompt:'question', validate, quota}, f.deps);
    assert.equal(f.launches.find(launch=>launch.provider==='claude')?.request.targetSlot,undefined);
    assert.equal(f.launches.find(launch=>launch.provider==='copilot')?.request.targetSlot,'claude[0]');
  } finally {f.cleanup();}
});

test('coverage round failure evidence is written before the failed slot file, including retries', async () => {
  const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f=sessionFixture({memory:true});try {
    f.script('claude','good',{status:'fail',cls:'auth',detail:'unavailable'});f.script('agy','good','answer');
    const dir=path.join(f.session,'coverage'),file=path.join(dir,'slots','claude[0].json'),seen:string[]=[];
    const input={dir,slots:[slot('claude'),slot('agy')],prompt:'question',validate,quota,
      onFailed:(name:string,outcome:{cls:string})=>{seen.push(name+':'+outcome.cls+':'+fs.existsSync(file));}};
    const first=await fanOut(input,f.deps);
    assert.deepEqual(first.map(reply=>reply.state),['failed','done']);
    assert.deepEqual(seen,['claude[0]:auth:false']);
    await fanOut(input,f.deps);
    assert.deepEqual(seen,['claude[0]:auth:false','claude[0]:auth:true'],'a retry reports again before it overwrites the saved failure');
  }finally{f.cleanup();}
});
