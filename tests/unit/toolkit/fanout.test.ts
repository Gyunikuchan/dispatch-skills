import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sessionFixture } from './helpers/session.ts';
import type { RosterSlot } from '../../../skills/dispatch/scripts/toolkit/domain/types.ts';

const slot = (provider: string, model: string | string[] = 'good', reserve = false, native = false): RosterSlot =>
  ({slot: provider + '[0]', provider, index: 0, model, reserve, native});
const validate = (text: string) => text.trim() ? {ok: true as const, text: text.trim()} : {ok: false as const, cls: 'empty-output' as const, reason: 'empty'};
const quota = {schemaVersion:1 as const,policyVersion:1 as const,decidedAt:0,decisions:[]};

test('fan-out launches concurrent slots in roster order and persists before hooks', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture(); try {
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
    f.deps.delegate = async (_provider,request,mode) => ({outcome:mode==='cli'?{status:'fail',cls:'quota',detail:'quota'}:{status:'ok',text:'desktop',resume:null,sessionId:null},invocations:[]});
    const modes=await fanOut({dir:path.join(f.session,'modes'),slots:[slot('agy')],prompt:'question',validate,quota},f.deps);
    assert.equal(modes[0]!.state === 'done' && modes[0]!.text,'desktop');
  }finally{f.cleanup();}
});

test('fan-out reruns failed slots and only missing crash outcomes', async () => {
  const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f=sessionFixture();try{
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
  const f=sessionFixture();try{
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
    assert.deepEqual(outcomes[0],{slot:'claude[0]',state:'done',text:'valid'});assert.equal(f.launches.length,1);
  }finally{f.cleanup();}
});

test('fan-out native-only roster remains available on its host', async () => {
  const {resolveSlots}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f=sessionFixture();try{
    const skillRoot=path.join(f.root,'skill');fs.mkdirSync(skillRoot);
    fs.writeFileSync(path.join(skillRoot,'config.jsonc'),JSON.stringify({'read-delegates':{codex:{nativeSubagentsOnly:true,targets:[{medium:{}}]}},phases:{'plan-review':{targets:{medium:1},rounds:{medium:2}}}}));
    f.deps.skillRoot=skillRoot;f.deps.orchestrator={platform:'codex',model:null};f.deps.liveness={codex:false};
    const roster=resolveSlots('plan','medium',f.deps);
    assert.equal(roster.rounds,2);assert.equal(roster.targets.length,1);assert.equal(roster.targets[0]!.native,true);
  }finally{f.cleanup();}
});

test('fan-out validates provider text before done and shares one deadline',async()=>{
 const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
 const f=sessionFixture();try{
  const budgets:number[]=[];let now=0;f.deps.clock=()=>now;
  f.deps.delegate=async(_provider,request)=>{
   budgets.push(request.timeoutMs);now+=100;
   return {outcome:{status:'ok',text:request.model==='bad'?'':'accepted',resume:null,sessionId:null},invocations:[]};
  };
  const outcomes=await fanOut({dir:path.join(f.session,'validate'),slots:[slot('claude',['bad','good'])],prompt:'question',validate,quota},f.deps);
  assert.deepEqual(outcomes,[{slot:'claude[0]',state:'done',text:'accepted'}]);
  assert.deepEqual(budgets,[1800000,1799900]);
 }finally{f.cleanup();}
});
