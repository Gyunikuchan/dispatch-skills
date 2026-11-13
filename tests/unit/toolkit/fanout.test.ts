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

test('resolveSlots applies pins and maps invalid pin errors to invalid-input', async () => {
  const {resolveSlots, parsePinsFlag} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const {ToolError} = await import('../../../skills/dispatch/scripts/toolkit/output.ts');
  const f = sessionFixture({memory:true}); try {
    const skillRoot = path.join(f.root, 'skill'); fs.mkdirSync(skillRoot);
    fs.writeFileSync(path.join(skillRoot, 'config.jsonc'), JSON.stringify({
      'read-delegates': {
        claude: {targets: [{medium: {model: 'c'}}]},
        codex: {targets: [{medium: {model: 'x'}}]},
        agy: {targets: [{medium: {model: 'a'}}]},
      },
      phases: {'plan-review': {targets: {medium: 1}, rounds: {medium: 2}}},
    }));
    f.deps.skillRoot = skillRoot;
    f.deps.orchestrator = {platform: 'opencode', model: null};
    f.deps.liveness = {claude: true, codex: true, agy: true};
    assert.equal(parsePinsFlag(undefined), null);
    assert.equal(resolveSlots('plan', 'medium', f.deps, parsePinsFlag('(all)')).targets.length, 3);
    assert.equal(resolveSlots('plan', 'medium', f.deps, parsePinsFlag('(2)')).targets.length, 2);
    assert.deepEqual(resolveSlots('plan', 'medium', f.deps, parsePinsFlag('(codex,agy)')).targets.map(s => s.provider), ['codex', 'agy']);
    assert.throws(() => parsePinsFlag('(all,codex)'), (e: unknown) => e instanceof ToolError && e.exit === 1 && e.reason === 'invalid-input');
    assert.throws(() => resolveSlots('plan', 'medium', f.deps, parsePinsFlag('(unknown)')), (e: unknown) => e instanceof ToolError && e.exit === 1 && e.reason === 'invalid-input');
  } finally {f.cleanup();}
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

test('no-report resume asks the same session for its final report up to three times', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    const dir = path.join(f.session, 'no-report');
    const reason = 'uncovered-scope: no JSON report object found';
    const check = (text: string): Validation => text === 'FINAL' ? {ok:true, text} : {ok:false, cls:'no-report', reason};
    const texts = ['Draft one', 'Draft two', 'FINAL'];
    f.deps.delegate = async (provider, request, mode) => {
      f.launches.push({provider, request, mode});
      const index = f.launches.length - 1;
      fs.appendFileSync(request.logPath, 'launch ' + (index + 1) + '\n');
      return {
        outcome: {status:'ok', text: texts[index]!, resume:null, sessionId: index === 0 ? 'session-one' : null},
        // A report resume launch is itself a nudge; only later stall resumes count against the runner limit.
        invocations: [
          {provider, model: request.model, mode, effort:null, launched:true, outcome:'ok', ...(index === 0 ? {} : {nudge: true as const})},
          ...(index < 2 ? [{provider, model: request.model, mode, effort:null, launched:true, outcome:'timeout', nudge: true as const}] : []),
        ],
      };
    };
    const outcomes = await fanOut({dir, slots:[slot('claude')], prompt:'question', validate:check, quota}, f.deps);
    assert.equal(outcomes[0]?.state, 'done');
    assert.equal(f.launches.length, 3);
    assert.deepEqual(f.launches.map(launch => launch.request.resumesUsed), [0, 1, 2]);
    assert.deepEqual(f.launches.map(launch => launch.request.resume), [null, 'session-one', 'session-one'], 'a resume without a new session id keeps the last valid one');
    assert.notEqual(f.launches[1]!.request.promptPath, f.launches[0]!.request.promptPath);
    assert.equal(f.launches[1]!.request.promptPath, f.launches[2]!.request.promptPath);
    const prompt = fs.readFileSync(f.launches[1]!.request.promptPath, 'utf8');
    assert.match(prompt, /uncovered-scope: no JSON report object found/);
    assert.match(prompt, /final JSON report/i);
    assert.match(prompt, /confirmations/i);
    assert.match(prompt, /requestId/);
    assert.match(prompt, /decision/);
    assert.match(prompt, /rationale/);
    for (const key of ['agent', 'sandbox', 'cwd', 'model', 'effort'] as const) {
      assert.deepEqual(f.launches[1]!.request[key], f.launches[0]!.request[key], key);
    }
    assert.equal(fs.readFileSync(path.join(dir, 'logs', 'claude[0].log.no-report'), 'utf8'), 'launch 1\nlaunch 2\n', 'the slot log is copied before the resumed launch');
    assert.ok(fs.existsSync(path.join(dir, 'logs', 'claude[0].log')), 'the slot log path stays in place');
  } finally { f.cleanup(); }
});

test('no-report resume yields the slot after three report resumes', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    const reason = 'uncovered-scope: no JSON report object found';
    const check = (): Validation => ({ok:false, cls:'no-report', reason});
    f.deps.delegate = async (provider, request, mode) => {
      f.launches.push({provider, request, mode});
      return {outcome:{status:'ok', text:'still prose', resume:null, sessionId:'session-one'}, invocations: []};
    };
    const outcomes = await fanOut({dir:path.join(f.session, 'limit'), slots:[slot('claude')], prompt:'question', validate:check, quota}, f.deps);
    assert.equal(outcomes[0]?.state, 'failed');
    assert.equal(outcomes[0]?.state === 'failed' && outcomes[0].cls, 'no-report');
    assert.equal(f.launches.length, 4);
    assert.deepEqual(f.launches.map(launch => launch.request.resume), [null, 'session-one', 'session-one', 'session-one']);
  } finally { f.cleanup(); }
});

test('no-report resume leaves refusal and blocked answers to the cascade', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  for (const item of [
    {cls:'refusal' as const, reason:'refusal: I cannot review this plan.'},
    {cls:'blocked' as const, reason:'blocked: artifact denied'},
  ]) {
    const f = sessionFixture({memory:true}); try {
      f.deps.delegate = async (provider, request, mode) => {
        f.launches.push({provider, request, mode});
        return {outcome:{status:'ok', text:'answer', resume:null, sessionId:'session-one'}, invocations: []};
      };
      const check = (): Validation => ({ok:false, cls:item.cls, reason:item.reason});
      const outcomes = await fanOut({dir:path.join(f.session, 'cascade'), slots:[slot('claude')], prompt:'question', validate:check, quota}, f.deps);
      assert.equal(outcomes[0]?.state, 'failed');
      assert.equal(outcomes[0]?.state === 'failed' && outcomes[0].cls, item.cls);
      assert.equal(f.launches.length, 1);
    } finally { f.cleanup(); }
  }
});

test('no-report resume resets its limit for the next model', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    let now = 0; f.deps.clock = () => now;
    const reason = 'uncovered-scope: no JSON report object found';
    const check = (text: string): Validation => text === 'FINAL' ? {ok:true, text} : {ok:false, cls:'no-report', reason};
    f.deps.delegate = async (provider, request, mode) => {
      f.launches.push({provider, request, mode});
      now += 100;
      const invocations = [
        {provider, model: request.model, mode, effort:null, launched:true, outcome:'ok', ...(request.resume ? {nudge: true as const} : {})},
        {provider, model: request.model, mode, effort:null, launched:true, outcome:'timeout', nudge: true as const},
      ];
      return request.model === 'second'
        ? {outcome:{status:'ok', text:'FINAL', resume:null, sessionId:null}, invocations}
        : {outcome:{status:'ok', text:'draft', resume:null, sessionId:'first-session'}, invocations};
    };
    const outcomes = await fanOut({dir:path.join(f.session, 'models'), slots:[slot('claude',['first','second'])], prompt:'question', validate:check, quota}, f.deps);
    assert.equal(outcomes[0]?.state, 'done');
    assert.deepEqual(f.launches.map(launch => launch.request.model), ['first', 'first', 'first', 'first', 'second']);
    assert.deepEqual(f.launches.map(launch => launch.request.resume), [null, 'first-session', 'first-session', 'first-session', null]);
    assert.deepEqual(f.launches.map(launch => launch.request.resumesUsed), [0, 1, 2, 3, 0]);
  } finally { f.cleanup(); }
});

test('no-report resume starts no launch after the voice deadline', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    let now = 0; f.deps.clock = () => now;
    const reason = 'uncovered-scope: no JSON report object found';
    const check = (): Validation => ({ok:false, cls:'no-report', reason});
    f.deps.delegate = async (provider, request, mode) => {
      f.launches.push({provider, request, mode});
      now = 30 * 60 * 1000;
      return {outcome:{status:'ok', text:'draft', resume:null, sessionId:'session-one'}, invocations: []};
    };
    const outcomes = await fanOut({dir:path.join(f.session, 'deadline'), slots:[slot('claude',['first','second'])], prompt:'question', validate:check, quota}, f.deps);
    assert.equal(f.launches.length, 1);
    assert.equal(outcomes[0]?.state, 'failed');
    assert.equal(outcomes[0]?.state === 'failed' && outcomes[0].cls, 'timeout');
  } finally { f.cleanup(); }
});

test('reserve deadline gives a CLI reserve its own 30 minutes after the wave deadline', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    let now = 0; f.deps.clock = () => now;
    const budgets: number[] = [];
    f.deps.delegate = async (provider, request, mode) => {
      f.launches.push({provider, request, mode});
      budgets.push(request.timeoutMs);
      if (provider === 'claude') {
        now += 31 * 60 * 1000;
        return {outcome:{status:'fail', cls:'auth', detail:'unavailable'}, invocations: []};
      }
      return {outcome:{status:'ok', text:'reserve answer', resume:null, sessionId:null}, invocations: []};
    };
    const outcomes = await fanOut({dir:path.join(f.session, 'reserve'), slots:[slot('claude'), slot('copilot','good',true)], prompt:'question', validate, quota}, f.deps);
    const served = outcomes.find(outcome => outcome.slot === 'claude[0]');
    assert.equal(served?.state, 'done');
    assert.deepEqual(f.launches.map(launch => launch.provider), ['claude', 'copilot']);
    assert.deepEqual(budgets, [1800000, 1800000], 'the reserve starts after the wave deadline with a fresh 30-minute budget');

    f.launches.length = 0;
    f.deps.delegate = async (provider, request, mode) => {
      f.launches.push({provider, request, mode});
      budgets.push(request.timeoutMs);
      if (request.model === 'slow') {
        now += 60 * 1000;
        return {outcome:{status:'fail', cls:'auth', detail:'unavailable'}, invocations: []};
      }
      return {outcome:{status:'ok', text:'answer', resume:null, sessionId:null}, invocations: []};
    };
    budgets.length = 0;
    const targeted = await fanOut({dir:path.join(f.session, 'targets'), slots:[slot('claude',['slow','good'])], prompt:'question', validate, quota}, f.deps);
    assert.equal(targeted[0]?.state, 'done');
    assert.deepEqual(budgets, [1800000, 1740000], 'targets keep the shared wave deadline');
  } finally { f.cleanup(); }
});

test('capacity failure publishes no quota cooldown', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture(); try {
    f.deps.delegate = async (provider, request, mode) => {
      f.launches.push({provider, request, mode});
      return {outcome:{status:'fail', cls:'capacity', detail:'at capacity', retryAfterMs:30000}, invocations: []};
    };
    const outcomes = await fanOut({dir:path.join(f.session, 'capacity'), slots:[slot('claude')], prompt:'question', validate}, f.deps);
    assert.equal(outcomes[0]?.state, 'failed');
    assert.equal(outcomes[0]?.state === 'failed' && outcomes[0].cls, 'capacity');
    const quotaDir = path.join(f.session, '.state', 'quota');
    assert.ok(fs.existsSync(quotaDir), 'the quota store is consulted before the failure');
    const observations = fs.readdirSync(quotaDir).flatMap(name => fs.readdirSync(path.join(quotaDir, name)).filter(file => file !== 'generation.json'));
    assert.deepEqual(observations, []);
  } finally { f.cleanup(); }
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
 f.deps.orchestrator={platform:'agy',model:null};f.script('claude','good',{status:'fail',cls:'auth',detail:'private'});
 const fallback=await fanOut({dir:path.join(f.session,'fallback'),slots:[slot('claude')],prompt:'question',validate,quota},f.deps);
 assert.equal(fallback[0]?.state,'failed');assert.ok(events.some((e:any)=>e.kind==='routing'&&e.state==='stop'));
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
test('blocked attempt metadata is preserved across alias, reserve, and retry fallbacks', async () => {
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

test('native-first launch order keeps cli silent until the wave', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('claude','good','answer'); f.script('agy','good','cli answer');
    const dir = path.join(f.session,'launch-order');
    const slots = [slot('claude'), slot('agy')];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    assert.equal(f.launches.length, 0);
    const native = first.filter(outcome => outcome.state === 'native');
    assert.equal(native.length, 1);
    assert.equal(native[0]!.slot, 'claude[0]');
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir,'fanout.json'),'utf8')).nativeFirst);
  } finally {f.cleanup();}
});

test('native-first failure on host change runs the cli cascade', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('claude','good','cli answer');
    const dir = path.join(f.session,'host-change');
    const slots = [slot('claude')];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const pending = first.find(outcome => outcome.state === 'native');
    assert.ok(pending?.state === 'native');
    fs.writeFileSync((pending as {replyPath:string}).replyPath, 'valid answer');
    f.deps.orchestrator = {platform: 'agy', model: null};
    const second = await fanOut({dir, slots, prompt:'question', validate, quota, nativeFirstProviders:[]} as never, f.deps);
    assert.ok(f.launches.length > 0);
    assert.equal(second.find(outcome => outcome.slot === 'claude[0]')?.state, 'done');
    assert.ok(fs.existsSync((pending as {replyPath:string}).replyPath + '.invalid-1'), 'a host change invalidates the pending reply');
  } finally {f.cleanup();}
});

test('native descriptor carries cwd model effort and guarded prompt', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('claude','a','answer-a'); f.script('claude','b','answer-b');
    const dir = path.join(f.session,'descriptor');
    const slots = [{slot:'claude[0]', provider:'claude', index:0, model:['a','b'], effort:'high', native:false, reserve:false}];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, cwd:f.root, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const native = first.find(outcome => outcome.state === 'native') as unknown as Record<string, unknown>;
    assert.ok(native);
    assert.equal(native['cwd'], f.root);
    assert.deepEqual(native['model'], ['a','b']);
    assert.equal(native['effort'], 'high');
    assert.ok(typeof native['attempt'] === 'string' && (native['attempt'] as string).startsWith('claude[0]#'));
    const promptText = fs.readFileSync(native['promptPath'] as string,'utf8');
    assert.match(promptText, /\[PRIMARY WORKSPACE\]/);
    assert.match(promptText, /\[SESSION ARTIFACTS\]/);
    const baseText = fs.readFileSync(path.join(dir,'prompts','claude[0].md'),'utf8');
    assert.doesNotMatch(baseText, /\[PRIMARY WORKSPACE\]/);
  } finally {f.cleanup();}
});

test('stale and replayed reports are ignored without ending a later launch', async () => {
  const {fanOut, cliWaveState} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('claude','good','cli answer'); f.script('agy','good','cli answer');
    const dir = path.join(f.session,'stale');
    const slots = [slot('claude'), slot('agy')];
    const ignored: string[] = [];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude'], nativeFailures: [{attempt: 'claude[0]#deadbe', reason: 'gone', reasonHash: 'h'}], onIgnoredReport: (attempt: string) => { ignored.push(attempt); }} as never, f.deps);
    assert.deepEqual(ignored, ['claude[0]#deadbe']);
    assert.equal(first.filter(outcome => outcome.state === 'native').length, 1);
    assert.equal(cliWaveState(dir), 'pending');
    const native = first.find(outcome => outcome.state === 'native') as unknown as {attempt: string; replyPath: string};
    const waveIgnored: string[] = [];
    const second = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude'], nativeFailures: [{attempt: 'claude[0]#deadbe', reason: 'gone', reasonHash: 'h'}], onIgnoredReport: (attempt: string) => { waveIgnored.push(attempt); }} as never, f.deps);
    assert.deepEqual(waveIgnored, ['claude[0]#deadbe']);
    assert.equal(cliWaveState(dir), 'done');
    fs.writeFileSync(native.replyPath, 'valid answer');
    const doneIgnored: string[] = [];
    const third = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude'], nativeFailures: [{attempt: native.attempt, reason: 'late', reasonHash: 'h2'}], onIgnoredReport: (attempt: string) => { doneIgnored.push(attempt); }} as never, f.deps);
    assert.equal(third.find(outcome => outcome.slot === 'claude[0]')?.state, 'failed');
    assert.ok(!f.launches.some((launch) => launch.provider === 'claude'), 'no host CLI launches');
    const replayIgnored: string[] = [];
    await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude'], nativeFailures: [{attempt: native.attempt, reason: 'late', reasonHash: 'h2'}], onIgnoredReport: (attempt: string) => { replayIgnored.push(attempt); }} as never, f.deps);
    assert.deepEqual(replayIgnored, [native.attempt]);
    assert.deepEqual(doneIgnored, []);
  } finally {f.cleanup();}
});

test('cli-only roster reports no wave state', async () => {
  const {fanOut, cliWaveState} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.script('claude','good','answer');
    const dir = path.join(f.session,'cli-only');
    const outcomes = await fanOut({dir, slots:[slot('claude')], prompt:'question', validate, quota} as never, f.deps);
    assert.equal(outcomes[0]?.state, 'done');
    assert.equal(cliWaveState(dir), undefined);
  } finally {f.cleanup();}
});

test('blocked report shares one identity with a native reply and wins over the file', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('claude','good','cli answer');
    const dir = path.join(f.session,'blocked-identity');
    const slots = [slot('claude')];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const pending = first.find(outcome => outcome.state === 'native') as unknown as {attempt: string; replyPath: string};
    assert.ok(pending);
    fs.writeFileSync(pending.replyPath, 'valid answer');
    const crypto = await import('node:crypto');
    const raw = 'denied access';
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const ignored: string[] = [];
    const third = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude'],
      nativeFailures: [{attempt: pending.attempt, reason: 'BLOCKED: ' + raw, reasonHash: hash}], onIgnoredReport: (attempt: string) => { ignored.push(attempt); }} as never, f.deps);
    assert.deepEqual(ignored, []);
    const outcome = third.find(entry => entry.slot === 'claude[0]')!;
    assert.equal(outcome.state, 'failed');
    assert.equal(f.launches.length, 0, 'no host CLI launches');
    assert.ok(fs.existsSync(pending.replyPath + '.invalid-1'));
  } finally {f.cleanup();}
});

test('failed substitute takes no second reserve on a later failure', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    f.script('claude','good',{status:'fail',cls:'auth',detail:'denied'});
    const dir = path.join(f.session,'no-second-reserve');
    const slots = [slot('agy'), {...slot('claude'), reserve:true}];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, nativeFirstProviders:[]} as never, f.deps);
    assert.equal(first.find(outcome => outcome.slot === 'agy[0]')?.state, 'failed');
    assert.equal(f.launches.length, 2);
    f.launches.length = 0;
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    f.script('claude','good',{status:'fail',cls:'auth',detail:'denied'});
    const second = await fanOut({dir, slots, prompt:'question', validate, quota, nativeFirstProviders:[]} as never, f.deps);
    assert.equal(second.find(outcome => outcome.slot === 'agy[0]')?.state, 'failed');
    assert.equal(f.launches.length, 2);
  } finally {f.cleanup();}
});

test('cli-only failed slot retries its cli and retakes a free reserve', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    f.script('claude','good',{status:'fail',cls:'auth',detail:'denied'});
    const dir = path.join(f.session,'cli-retake');
    const slots = [slot('agy'), {...slot('claude'), reserve:true}];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, nativeFirstProviders:[]} as never, f.deps);
    assert.equal(first.find(outcome => outcome.slot === 'agy[0]')?.state, 'failed');
    assert.equal(f.launches.length, 2);
    f.launches.length = 0;
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    f.script('claude','good',{status:'fail',cls:'auth',detail:'denied'});
    const second = await fanOut({dir, slots, prompt:'question', validate, quota, nativeFirstProviders:[]} as never, f.deps);
    assert.equal(second.find(outcome => outcome.slot === 'agy[0]')?.state, 'failed');
    assert.equal(f.launches.length, 2);
    assert.deepEqual(f.launches.map(launch => launch.provider), ['agy','claude']);
  } finally {f.cleanup();}
});

test('non-host target consumes a host reserve reply under its logical slot', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    f.script('claude','good','reserve cli answer');
    const dir = path.join(f.session,'reserve-consume');
    const slots = [slot('agy'), {...slot('claude'), reserve:true}];
    const providers = ['claude'];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders: providers} as never, f.deps);
    const pending = first.find(outcome => outcome.slot === 'agy[0]');
    assert.ok(pending?.state === 'native');
    assert.equal((pending as unknown as {provider: string}).provider, 'claude');
    const attempt = (pending as unknown as {attempt: string}).attempt;
    assert.ok(attempt.startsWith('claude[0]#'));
    const replyPath = (pending as unknown as {replyPath: string}).replyPath;
    const waved = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders: providers} as never, f.deps);
    assert.equal(waved.find(outcome => outcome.slot === 'agy[0]')?.state, 'native');
    fs.writeFileSync(replyPath, 'reserve answer');
    const done = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders: providers} as never, f.deps);
    const finished = done.find(entry => entry.slot === 'agy[0]');
    assert.equal(finished?.state, 'done');
    assert.equal((finished as unknown as {text: string}).text, 'reserve answer');
    assert.equal((finished as unknown as {responder: {provider: string; model: string; native: boolean}}).responder.provider, 'claude');
    assert.equal((finished as unknown as {responder: {slot: string}}).responder.slot, 'agy[0]');
  } finally {f.cleanup();}
});

test('host change while a native reserve is pending runs the reserve cli', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    f.script('claude','good','reserve cli answer');
    const dir = path.join(f.session,'reserve-host-change');
    const slots = [slot('agy'), {...slot('claude'), reserve:true}];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders: ['claude']} as never, f.deps);
    const pending = first.find(outcome => outcome.slot === 'agy[0]');
    assert.ok(pending?.state === 'native');
    f.deps.orchestrator = {platform: 'opencode', model: null};
    f.script('claude','good','reserve fallback answer');
    f.script('agy','good','target fallback answer');
    const second = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders: ['opencode']} as never, f.deps);
    const outcome = second.find(entry => entry.slot === 'agy[0]');
    assert.equal(outcome?.state, 'done');
    assert.equal((outcome as unknown as {text: string}).text, 'reserve fallback answer');
    assert.ok(f.launches.some(launch => launch.provider === 'claude' && launch.request.targetSlot === 'agy[0]'));
  } finally {f.cleanup();}
});

test('interrupted reservation resumes for its recorded owner only', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    f.script('claude','good',{status:'fail',cls:'auth',detail:'denied'});
    const dir = path.join(f.session,'interrupted-reserve');
    const reserve = {...slot('copilot'), reserve:true};
    // No copilot script: the reserve launch throws, simulating a crash
    // between persisting reserveUsedBy and launching the substitute.
    await assert.rejects(fanOut({dir, slots:[slot('agy'), reserve], prompt:'question', validate, quota, nativeFirstProviders:[]} as never, f.deps), /Unscripted delegate/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'fanout.json'),'utf8')).reserveUsedBy, 'agy[0]');
    assert.equal(fs.existsSync(path.join(dir,'slots','agy[0].json')), false);
    // On retry a second failing target joins: only the recorded owner resumes the reserve.
    f.script('copilot','good','reserve answer');
    f.script('codex','good',{status:'fail',cls:'auth',detail:'denied'});
    f.launches.length = 0;
    const second = await fanOut({dir, slots:[slot('agy'), slot('codex'), reserve], prompt:'question', validate, quota, nativeFirstProviders:[]} as never, f.deps);
    assert.equal(second.find(outcome => outcome.slot === 'agy[0]')?.state, 'done');
    assert.equal(second.find(outcome => outcome.slot === 'codex[0]')?.state, 'failed');
    const reserveLaunches = f.launches.filter(launch => launch.provider === 'copilot');
    assert.equal(reserveLaunches.length, 1);
    assert.equal(reserveLaunches[0]!.request.targetSlot, 'agy[0]');
  } finally {f.cleanup();}
});

// Crash state after the native prompt and owner record, before the descriptor save.
async function interruptedNativeReserve(f: ReturnType<typeof sessionFixture>, dir: string) {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const run = (slots: RosterSlot[]) => fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
  f.script('agy','good',{status:'fail',cls:'config',detail:'bad config'});
  await run([slot('agy'), {...slot('claude'), reserve:true}]);
  fs.writeFileSync(path.join(dir,'prompts','agy[0].native.md'), 'interrupted native prompt');
  fs.writeFileSync(path.join(dir,'fanout.json'), JSON.stringify({reserveUsedBy:'agy[0]'}));
  f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
  return run;
}

test('interrupted native reservation resumes for its recorded owner', async () => {
  const f = sessionFixture({memory:true}); try {
    const run = await interruptedNativeReserve(f, path.join(f.session,'interrupted-owner'));
    const resumed = await run([slot('agy'), {...slot('claude'), reserve:true}]);
    const owner = resumed.find(entry => entry.slot === 'agy[0]') as unknown as {state: string; provider: string};
    assert.deepEqual([owner?.state, owner?.provider], ['native','claude'], 'the recorded owner resumes its reserve: ' + JSON.stringify(resumed));
  } finally {f.cleanup();}
});

test('interrupted native reservation is not stolen by another target', async () => {
  const f = sessionFixture({memory:true}); try {
    const run = await interruptedNativeReserve(f, path.join(f.session,'interrupted-no-steal'));
    f.script('codex','good',{status:'fail',cls:'auth',detail:'denied'});
    // The other target checks the reserve before the owner's retry saves its outcome.
    const second = await run([slot('codex'), slot('agy'), {...slot('claude'), reserve:true}]);
    const owner = second.find(entry => entry.slot === 'agy[0]') as unknown as {state: string; provider: string};
    assert.deepEqual([owner?.state, owner?.provider], ['native','claude'], 'the recorded owner keeps its reserve: ' + JSON.stringify(second));
    assert.equal(second.find(entry => entry.slot === 'codex[0]')?.state, 'failed', 'a second target does not take the held reserve');
    assert.ok(!f.launches.some(launch => launch.provider === 'claude'), 'the stolen reserve never launches');
  } finally {f.cleanup();}
});

test('late write from an earlier attempt is not read as the reserve reply', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('claude','good',{status:'fail',cls:'auth',detail:'denied'});
    const dir = path.join(f.session,'late-write');
    const slots = [slot('claude'), {...slot('agy'), reserve:true}];
    const providers = ['claude','agy'];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders: providers} as never, f.deps);
    const pending = first.find(outcome => outcome.state === 'native') as unknown as {attempt: string; replyPath: string};
    assert.ok(pending);
    // Reporting the launch attempt failed falls back to the CLI, which fails,
    // so the host reserve takes a native descriptor with its own reply path.
    const waved = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders: providers,
      nativeFailures: [{attempt: pending.attempt, reason: 'stale voice', reasonHash: 'h1'}]} as never, f.deps);
    const reserve = waved.find(outcome => outcome.slot === 'claude[0]') as unknown as {state: string; attempt: string; replyPath: string};
    assert.equal(reserve.state, 'native');
    assert.notEqual(reserve.attempt, pending.attempt);
    assert.notEqual(reserve.replyPath, pending.replyPath);
    // A late write lands at the earlier attempt's path after the reserve wrote.
    fs.writeFileSync(pending.replyPath, 'late answer');
    const consumed = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders: providers} as never, f.deps);
    const outcome = consumed.find(entry => entry.slot === 'claude[0]')!;
    assert.equal(outcome.state, 'native');
    assert.ok(fs.existsSync(pending.replyPath), 'late file is left alone, never consumed or invalidated');
    // The reserve reply still completes the slot.
    fs.writeFileSync(reserve.replyPath, 'reserve answer');
    const done = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders: providers} as never, f.deps);
    const finished = done.find(entry => entry.slot === 'claude[0]');
    assert.equal(finished?.state, 'done');
    assert.equal((finished as unknown as {text: string}).text, 'reserve answer');
  } finally {f.cleanup();}
});

test('underfill names the sandbox gap through resolveSlots and the note', async () => {
  const {resolveSlots,underfillNote}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f=sessionFixture({memory:true});try{
    const skillRoot=path.join(f.root,'skill');fs.mkdirSync(skillRoot);
    fs.writeFileSync(path.join(skillRoot,'config.jsonc'),JSON.stringify({'read-delegates':{opencode:{targets:[{medium:{}}]},codex:{targets:[{medium:{}}]}},phases:{'plan-review':{targets:{medium:1},rounds:{medium:1}}}}));
    f.deps.skillRoot=skillRoot;f.deps.orchestrator={platform:'claude',model:null};f.deps.sandboxSupported={opencode:false};
    const roster=resolveSlots('plan','medium',f.deps);
    assert.deepEqual(roster.targets.map(item=>item.slot),['codex[0]']);assert.deepEqual(roster.reserves,[]);
    assert.equal(underfillNote(roster),'; underfill 1/1 targets, host claude, excluded native-only: none, sandbox unsupported: opencode');
  }finally{f.cleanup();}
});

test('cli-only native-only report returns failed without minting a fresh descriptor', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    const dir = path.join(f.session,'native-only-report');
    const slots = [slot('codex','good',false,true)];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, nativeFirstProviders:[]} as never, f.deps);
    const pending = first.find(outcome => outcome.slot === 'codex[0]');
    assert.ok(pending?.state === 'native');
    const attempt = (pending as unknown as {attempt: string}).attempt;
    const replyPath = (pending as unknown as {replyPath: string}).replyPath;
    fs.writeFileSync(replyPath, 'partial');
    const ignored: string[] = [];
    const second = await fanOut({dir, slots, prompt:'question', validate, quota, nativeFirstProviders:[], nativeFailures:[{attempt, reason:'gone', reasonHash:'h1'}], onIgnoredReport:(attempt:string)=>{ignored.push(attempt);}} as never, f.deps);
    assert.deepEqual(ignored, []);
    const failed = second.find(outcome => outcome.slot === 'codex[0]');
    assert.equal(failed?.state, 'failed');
    assert.ok(!fs.existsSync(replyPath), 'report quarantines the partial reply');
    assert.ok(fs.existsSync(replyPath + '.invalid-1'), 'report quarantines the partial reply as .invalid-1');
    const third = await fanOut({dir, slots, prompt:'question', validate, quota, nativeFirstProviders:[]} as never, f.deps);
    assert.equal(third.find(outcome => outcome.slot === 'codex[0]')?.state, 'native');
  } finally {f.cleanup();}
});

test('reply quarantine failure preserves evidence or surfaces instead of silently continuing', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('claude','good','cli answer');
    const launch = async (dir: string) => {
      const slots = [slot('claude')];
      const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
      const pending = first.find(outcome => outcome.state === 'native') as unknown as {attempt: string; replyPath: string};
      assert.ok(pending);
      fs.writeFileSync(pending.replyPath, '   ');
      await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
      return pending;
    };
    const realRename = fs.renameSync as unknown as (source: string, target: string) => void;
    const failReplies = (source: string, target: string) => {
      if (source.includes('replies')) throw new Error('locked by another process');
      realRename(source, target);
    };
    const pending = await launch(path.join(f.session,'quarantine-copy'));
    (fs as unknown as {renameSync: (source: string, target: string) => void}).renameSync = failReplies;
    try {
      const done = await fanOut({dir: path.join(f.session,'quarantine-copy'), slots: [slot('claude')], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
      assert.equal(done.find(outcome => outcome.slot === 'claude[0]')?.state, 'failed');
      assert.ok(!f.launches.some((launch) => launch.provider === 'claude'), 'no host CLI launches');
      assert.equal(fs.readFileSync(pending.replyPath + '.invalid-1', 'utf8'), '   ');
      assert.ok(!fs.existsSync(pending.replyPath));
    } finally {
      (fs as unknown as {renameSync: (source: string, target: string) => void}).renameSync = realRename;
    }
    const pending2 = await launch(path.join(f.session,'quarantine-surfaces'));
    const realRm = fs.rmSync.bind(fs);
    (fs as unknown as {renameSync: (source: string, target: string) => void}).renameSync = failReplies;
    (fs as unknown as {rmSync: typeof fs.rmSync}).rmSync = ((target: string, ...rest: unknown[]) => {
      if (target.includes('replies')) throw new Error('permission denied');
      return (realRm as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.rmSync;
    try {
      await assert.rejects(fanOut({dir: path.join(f.session,'quarantine-surfaces'), slots: [slot('claude')], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps), /Cannot quarantine rejected reply/);
    } finally {
      (fs as unknown as {renameSync: (source: string, target: string) => void}).renameSync = realRename;
      (fs as unknown as {rmSync: typeof fs.rmSync}).rmSync = realRm as typeof fs.rmSync;
    }
    assert.ok(pending2);
  } finally {f.cleanup();}
});

test('wave consumes a report for a reserve substitute under a non-first target', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    f.script('claude','good','substitute cli answer');
    const dir = path.join(f.session,'wave-substitute-report');
    const reserve = {slot:'claude[1]', provider:'claude', index:1, model:'good', reserve:true, native:false};
    const slots = [slot('claude'), slot('agy'), slot('codex'), reserve];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    assert.ok(first.find(outcome => outcome.slot === 'claude[0]')?.state === 'native');
    // Interrupt the wave between the substitute save and cliWaveDone: the
    // unscripted codex delegate rejects the batch after agy minted.
    await assert.rejects(fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps), /Unscripted delegate/);
    const substitute = JSON.parse(fs.readFileSync(path.join(dir,'slots','agy[0].json'),'utf8'));
    assert.equal(substitute.state, 'native');
    assert.ok((substitute.attempt as string).startsWith('claude[1]#'), JSON.stringify(substitute.attempt));
    f.script('codex','good','codex answer');
    const ignored: string[] = [];
    const third = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude'],
      nativeFailures: [{attempt: substitute.attempt, reason:'launch gone', reasonHash:'h1'}], onIgnoredReport:(attempt:string)=>{ignored.push(attempt);}} as never, f.deps);
    const done = third.find(outcome => outcome.slot === 'agy[0]');
    assert.equal(done?.state, 'failed');
    assert.deepEqual(ignored, [], 'a reported attempt is never left pending or ignored');
    assert.equal(f.launches.filter((launch) => launch.provider === 'claude' && launch.request.targetSlot === 'agy[0]').length, 0, 'no host CLI launches for the substitute');
    assert.equal(third.find(outcome => outcome.slot === 'claude[0]')?.state, 'native');
  } finally {f.cleanup();}
});

test('report on a native reserve attempt saves failed without host CLI', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    f.script('claude','good','reserve cli answer');
    const dir = path.join(f.session,'reserve-report-done');
    const slots = [slot('agy'), {...slot('claude'), reserve:true}];
    const providers = ['claude'];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders: providers} as never, f.deps);
    const pending = first.find(outcome => outcome.slot === 'agy[0]') as unknown as {state: string; attempt: string};
    assert.equal(pending?.state, 'native');
    const ignored: string[] = [];
    const second = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders: providers,
      nativeFailures: [{attempt: pending.attempt, reason:'launch gone', reasonHash:'h1'}], onIgnoredReport:(attempt:string)=>{ignored.push(attempt);}} as never, f.deps);
    const done = second.find(outcome => outcome.slot === 'agy[0]');
    assert.equal(done?.state, 'failed');
    assert.deepEqual(ignored, []);
    assert.equal(f.launches.filter((launch) => launch.provider === 'claude').length, 0, 'no host CLI launches');
  } finally {f.cleanup();}
});

test('host change while a native-only reserve is pending saves failed without a new descriptor', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'codex', model: null};
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    const dir = path.join(f.session,'native-only-host-change');
    const slots = [slot('agy'), {...slot('codex'), reserve:true, native:true}];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:[]} as never, f.deps);
    const pending = first.find(outcome => outcome.slot === 'agy[0]') as unknown as {state: string; attempt: string};
    assert.equal(pending?.state, 'native');
    assert.ok(pending.attempt.startsWith('codex[0]#'));
    f.deps.orchestrator = {platform: 'opencode', model: null};
    f.launches.length = 0;
    const second = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['opencode']} as never, f.deps);
    const failed = second.find(outcome => outcome.slot === 'agy[0]');
    assert.equal(failed?.state, 'failed');
    assert.equal(f.launches.length, 0, 'neither the logical nor the reserve cli runs');
    assert.ok(!('attempt' in (failed as unknown as Record<string, unknown>)), 'no fresh descriptor minted');
  } finally {f.cleanup();}
});

test('reported native-only reserve stays failed across retries', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'codex', model: null};
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    const dir = path.join(f.session,'native-only-stays-failed');
    const slots = [slot('agy'), {...slot('codex'), reserve:true, native:true}];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:[]} as never, f.deps);
    const pending = first.find(outcome => outcome.slot === 'agy[0]') as unknown as {state: string; attempt: string};
    assert.equal(pending?.state, 'native');
    const second = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:[],
      nativeFailures: [{attempt: pending.attempt, reason:'launch gone', reasonHash:'h1'}]} as never, f.deps);
    const failed = second.find(outcome => outcome.slot === 'agy[0]');
    assert.equal(failed?.state, 'failed');
    assert.equal((failed as unknown as {cliOnly?: boolean}).cliOnly, undefined, 'native history bars the cli-only retake marker');
    const launchesBefore = f.launches.length;
    const third = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:[]} as never, f.deps);
    assert.equal(third.find(outcome => outcome.slot === 'agy[0]')?.state, 'failed');
    assert.equal(f.launches.length - launchesBefore, 1, 'only the target cli reruns, no second descriptor');
    assert.ok(!f.launches.slice(launchesBefore).some(launch => launch.provider === 'codex'));
  } finally {f.cleanup();}
});

test('cli-only failed slot releases its reserve for another target after recovering', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    f.script('copilot','good',{status:'fail',cls:'auth',detail:'denied'});
    const dir = path.join(f.session,'cli-retake-cross-owner');
    const reserve = {...slot('copilot'), reserve:true};
    const first = await fanOut({dir, slots:[slot('agy'), reserve], prompt:'question', validate, quota, nativeFirstProviders:[]} as never, f.deps);
    assert.equal(first.find(outcome => outcome.slot === 'agy[0]')?.state, 'failed');
    f.script('agy','good','recovered');
    f.script('codex','good',{status:'fail',cls:'auth',detail:'denied'});
    f.script('copilot','good','reserve answer');
    const second = await fanOut({dir, slots:[slot('agy'), slot('codex'), reserve], prompt:'question', validate, quota, nativeFirstProviders:[]} as never, f.deps);
    assert.equal(second.find(outcome => outcome.slot === 'agy[0]')?.state, 'done');
    const served = second.find(outcome => outcome.slot === 'codex[0]');
    assert.equal(served?.state, 'done');
    assert.equal((served as unknown as {text: string}).text, 'reserve answer');
    assert.ok(f.launches.some(launch => launch.provider === 'copilot' && launch.request.targetSlot === 'codex[0]'));
  } finally {f.cleanup();}
});

test('consume runs independent fallback cascades concurrently', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'opencode', model: null};
    const dir = path.join(f.session,'consume-concurrent');
    const slots = [slot('claude'), slot('agy')];
    const providers = ['claude','agy'];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders: providers} as never, f.deps);
    assert.equal(first.filter(outcome => outcome.state === 'native').length, 2);
    await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders: providers} as never, f.deps);
    const attempts = (first as unknown as {slot: string; attempt: string}[]).filter(outcome => outcome.slot === 'claude[0]' || outcome.slot === 'agy[0]').map(outcome => outcome.attempt);
    // The gate fails a cascade that runs alone: only concurrent cascades both pass.
    const arrivals: string[] = [];
    f.deps.delegate = async (provider) => {
      arrivals.push(provider);
      await Promise.resolve();
      if (arrivals.length < 2) return {outcome: {status:'fail', cls:'auth', detail:'gated'} as const, invocations:[]};
      return {outcome: {status:'ok', text: provider + ' answer', resume: null, sessionId: null}, invocations:[]};
    };
    const third = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders: providers,
      nativeFailures: attempts.map(attempt => ({attempt, reason:'launch gone', reasonHash:'h1'}))} as never, f.deps);
    assert.deepEqual(third.map(outcome => outcome.state), ['done','done']);
    assert.deepEqual(arrivals.sort(), ['agy','claude']);
  } finally {f.cleanup();}
});

test('last-pending-settles retry carries forward saved blocked evidence', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    const check = (text: string): Validation => text === 'BLOCKED'
      ? {ok:false, cls:'blocked', reason:'blocked: Artifact denied', blocked:{reason:'Artifact denied', reasonHash:'hash-1'}}
      : validate(text);
    f.script('agy','good','BLOCKED');
    const dir = path.join(f.session,'retry-blocked');
    const slots = [slot('claude'), slot('agy')];
    const providers = ['claude'];
    const first = await fanOut({dir, slots, prompt:'question', validate:check, quota, sessionRoot: f.session, nativeFirstProviders: providers} as never, f.deps);
    assert.ok(first.find(outcome => outcome.slot === 'claude[0]')?.state === 'native');
    await fanOut({dir, slots, prompt:'question', validate:check, quota, sessionRoot: f.session, nativeFirstProviders: providers} as never, f.deps);
    const pending = first.find(outcome => outcome.slot === 'claude[0]') as unknown as {replyPath: string};
    fs.writeFileSync(pending.replyPath, 'valid answer');
    f.script('agy','good','answer');
    const third = await fanOut({dir, slots, prompt:'question', validate:check, quota, sessionRoot: f.session, nativeFirstProviders: providers} as never, f.deps);
    const done = third.find(outcome => outcome.slot === 'agy[0]');
    assert.equal(done?.state, 'done');
    assert.deepEqual(done?.blocked, [{provider:'agy', model:'good', reason:'Artifact denied', reasonHash:'hash-1'}]);
  } finally {f.cleanup();}
});

test('a failed-slot retry rewrites a base prompt modified by a native-only reserve', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'codex', model: null};
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    const seen: string[] = [];
    const delegate = f.deps.delegate;
    f.deps.delegate = async (provider, request, mode) => {
      seen.push(fs.readFileSync(request.promptPath, 'utf8'));
      return delegate(provider, request, mode);
    };
    const dir = path.join(f.session,'retry-prompt-rewrite');
    const reserve = {slot:'codex[0]', provider:'codex', index:0, model:'good', reserve:true, native:true};
    const slots = [slot('claude'), slot('agy'), reserve];
    const providers = ['claude'];
    const waveInput = {dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders: providers};
    const launched = await fanOut(waveInput as never, f.deps);
    const nativeClaude = launched.find(outcome => outcome.slot === 'claude[0]') as unknown as {replyPath: string};
    assert.equal(launched.find(outcome => outcome.slot === 'claude[0]')?.state, 'native');
    const waved = await fanOut(waveInput as never, f.deps);
    const substitute = waved.find(outcome => outcome.slot === 'agy[0]') as unknown as {state: string; attempt: string};
    assert.equal(substitute?.state, 'native', 'the cli failure mints the host native-only reserve');
    assert.ok(substitute.attempt.startsWith('codex[0]#'));
    assert.match(fs.readFileSync(path.join(dir,'prompts','agy[0].md'),'utf8'), /## Native reply/,
      'the reserve mint appends the native reply section to the base prompt');
    fs.writeFileSync(nativeClaude.replyPath, 'native answer');
    const consumed = await fanOut(waveInput as never, f.deps);
    assert.equal(consumed.find(outcome => outcome.slot === 'claude[0]')?.state, 'done');
    assert.equal(consumed.find(outcome => outcome.slot === 'agy[0]')?.state, 'native');
    // A plain report ends the pending substitute; the next call retries it.
    const reported = await fanOut({...waveInput, nativeFailures:[{attempt: substitute.attempt, reason:'launch gone', reasonHash:'h-rewrite'}]} as never, f.deps);
    assert.equal(reported.find(outcome => outcome.slot === 'agy[0]')?.state, 'failed');
    f.script('agy','good','recovered');
    seen.length = 0;
    const retried = await fanOut(waveInput as never, f.deps);
    assert.equal(retried.find(outcome => outcome.slot === 'agy[0]')?.state, 'done');
    assert.ok(seen.length > 0, 'the retry relaunches the cli');
    for (const prompt of seen) assert.doesNotMatch(prompt, /## Native reply/,
      'the retry hands the cli the base prompt, not the reserve-modified file');
    assert.ok(seen.some(prompt => prompt === 'question'));
  } finally {f.cleanup();}
});

test('terminal config failure takes no reserve', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.script('claude','good',{status:'fail',cls:'config',detail:'bad config'});
    f.script('copilot','good','reserve answer');
    const dir = path.join(f.session,'terminal');
    const slots = [slot('claude'), slot('copilot','good',true)];
    const outcomes = await fanOut({dir, slots, prompt:'question', validate, quota, nativeFirstProviders:[]} as never, f.deps);
    assert.equal(outcomes.find(outcome => outcome.slot === 'claude[0]')?.state, 'failed');
    assert.equal(f.launches.length, 1);
    assert.equal(f.launches[0]?.provider, 'claude');
  } finally {f.cleanup();}
});

test('interrupted fallback with ownership resumes for its owner', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('claude','good',{status:'fail',cls:'auth',detail:'denied'});
    f.script('agy','good','cli answer');
    const dir = path.join(f.session,'fallback-owner');
    const slots = [slot('claude')];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const pending = first.find(outcome => outcome.state === 'native') as unknown as {attempt: string; replyPath: string};
    assert.ok(pending);
    f.script('claude','good',{status:'fail',cls:'auth',detail:'denied'});
    const withReserve = [slot('claude'), {...slot('copilot'), reserve:true}];
    await assert.rejects(fanOut({dir, slots: withReserve, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude'], nativeFailures:[{attempt: pending.attempt, reason:'gone', reasonHash:'h1'}]} as never, f.deps), /Unscripted delegate/);
    const saved = JSON.parse(fs.readFileSync(path.join(dir,'slots','claude[0].json'),'utf8'));
    assert.equal(saved.state, 'native');
    assert.equal(saved.cliFallback, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'fanout.json'),'utf8')).reserveUsedBy, 'claude[0]');
    f.launches.length = 0;
    f.script('claude','good','resumed answer');
    f.script('copilot','good','reserve answer');
    const resumed = await fanOut({dir, slots: withReserve, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    assert.ok(f.launches.length > 0);
    assert.equal(resumed.find(outcome => outcome.slot === 'claude[0]')?.state, 'done');
  } finally {f.cleanup();}
});

test('wave resumes a cli fallback marker without requiring the report', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('claude','good','cli answer');
    f.script('agy','good','cli answer');
    const dir = path.join(f.session,'wave-resume');
    const slots = [slot('claude'), slot('agy')];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const pending = first.find(outcome => outcome.slot === 'claude[0]') as unknown as {attempt: string; replyPath: string; provider: string};
    assert.ok(pending);
    const saved = JSON.parse(fs.readFileSync(path.join(dir,'slots','claude[0].json'),'utf8'));
    const withFallback = {...saved, cliFallback: true, nativeError: 'gone'};
    fs.writeFileSync(path.join(dir,'slots','claude[0].json'), JSON.stringify(withFallback));
    fs.writeFileSync((pending as unknown as {replyPath: string}).replyPath, 'stale');
    f.launches.length = 0;
    const noReport = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    assert.equal(f.launches.filter((launch) => launch.provider === 'claude').length, 0, 'no host CLI launches');
    assert.equal(noReport.find(outcome => outcome.slot === 'claude[0]')?.state, 'failed');
  } finally {f.cleanup();}
});

test('wave runs fallback cascades alongside cli targets', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('claude','good','cli answer');
    f.script('agy','good','cli answer');
    f.script('codex','good','cli answer');
    const dir = path.join(f.session,'wave-concurrent');
    const slots = [slot('claude'), slot('agy'), slot('codex')];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const pending = first.find(outcome => outcome.slot === 'claude[0]') as unknown as {attempt: string};
    assert.ok(pending);
    const second = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude'], nativeFailures:[{attempt: pending.attempt, reason:'gone', reasonHash:'h1'}]} as never, f.deps);
    assert.equal(second.find(outcome => outcome.slot === 'claude[0]')?.state, 'failed');
    assert.equal(second.find(outcome => outcome.slot === 'agy[0]')?.state, 'done');
    assert.equal(second.find(outcome => outcome.slot === 'codex[0]')?.state, 'done');
    assert.equal(f.launches.filter((launch) => launch.provider === 'claude').length, 0, 'no host CLI launches');
    assert.ok(f.launches.some(launch => launch.provider === 'agy'));
    assert.ok(f.launches.some(launch => launch.provider === 'codex'));
  } finally {f.cleanup();}
});

test('completed substitute does not release the reserve to a second target', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    f.script('copilot','good','reserve answer');
    const dir = path.join(f.session,'substitute-holds');
    const reserve = {...slot('copilot'), reserve:true};
    const first = await fanOut({dir, slots:[slot('agy'), reserve], prompt:'question', validate, quota, nativeFirstProviders:[]} as never, f.deps);
    const owned = first.find(outcome => outcome.slot === 'agy[0]');
    assert.equal(owned?.state, 'done');
    assert.equal((owned as unknown as {responder:{slot:string}}).responder.slot, 'copilot[0]');
    f.script('agy','good','recovered');
    f.script('codex','good',{status:'fail',cls:'auth',detail:'denied'});
    f.script('copilot','good','second answer');
    const second = await fanOut({dir, slots:[slot('agy'), slot('codex'), reserve], prompt:'question', validate, quota, nativeFirstProviders:[]} as never, f.deps);
    assert.equal(second.find(outcome => outcome.slot === 'codex[0]')?.state, 'failed');
    assert.ok(!f.launches.some(launch => launch.provider === 'copilot' && launch.request.targetSlot === 'codex[0]'), 'the consumed reserve serves no second target');
  } finally {f.cleanup();}
  const g = sessionFixture({memory:true}); try {
    g.deps.orchestrator = {platform: 'claude', model: null};
    g.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    const dir = path.join(g.session,'native-substitute-holds');
    const reserve = {...slot('claude'), reserve:true};
    const providers = ['claude'];
    const input = {dir, slots:[slot('agy'), reserve], prompt:'question', validate, quota, sessionRoot: g.session, nativeFirstProviders: providers} as never;
    const first = await fanOut(input, g.deps);
    const pending = first.find(outcome => outcome.slot === 'agy[0]') as unknown as {state: string; attempt: string; replyPath: string};
    assert.equal(pending?.state, 'native');
    assert.ok(pending.attempt.startsWith('claude[0]#'));
    fs.writeFileSync(pending.replyPath, 'reserve answer');
    const done = await fanOut(input, g.deps);
    const finished = done.find(entry => entry.slot === 'agy[0]');
    assert.equal(finished?.state, 'done');
    assert.deepEqual((finished as unknown as {responder: unknown}).responder, {slot: 'agy[0]', provider: 'claude', model: 'good', native: true});
    g.script('codex','good',{status:'fail',cls:'auth',detail:'denied'});
    const third = await fanOut({dir, slots:[slot('agy'), slot('codex'), reserve], prompt:'question', validate, quota, sessionRoot: g.session, nativeFirstProviders: providers} as never, g.deps);
    assert.equal(third.find(outcome => outcome.slot === 'codex[0]')?.state, 'failed');
    assert.ok(!g.launches.some(launch => launch.provider === 'claude' && launch.request.targetSlot === 'codex[0]'), 'the consumed native reserve serves no second target');
  } finally {g.cleanup();}
});

test('interrupted cli fallback resumes without its report in the cli-only path', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.script('claude','good','fallback answer');
    const dir = path.join(f.session,'cli-fallback-resume');
    fs.mkdirSync(path.join(dir,'slots'),{recursive:true});
    fs.mkdirSync(path.join(dir,'prompts'),{recursive:true});
    fs.mkdirSync(path.join(dir,'replies'),{recursive:true});
    fs.writeFileSync(path.join(dir,'prompts','agy[0].md'), 'question');
    const replyPath = path.join(dir,'replies','agy[0].m1.md');
    fs.writeFileSync(path.join(dir,'slots','agy[0].json'), JSON.stringify({slot:'agy[0]',state:'native',promptPath:path.join(dir,'prompts','agy[0].native.md'),replyPath,provider:'claude',attempt:'claude[1]#m1',cwd:f.session,model:'good',cliFallback:true,nativeError:'gone'}));
    fs.writeFileSync(replyPath, 'stale answer');
    const reserve = {slot:'claude[1]', provider:'claude', index:1, model:'good', reserve:true, native:false};
    const outcomes = await fanOut({dir, slots:[slot('agy'), reserve], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const done = outcomes.find(outcome => outcome.slot === 'agy[0]');
    assert.equal(done?.state, 'done');
    assert.equal((done as unknown as {text: string}).text, 'fallback answer');
    assert.ok(!fs.existsSync(replyPath) && fs.existsSync(replyPath + '.invalid-1'), 'a late reply is quarantined, never consumed');
    assert.ok(f.launches.some(launch => launch.provider === 'claude' && launch.request.targetSlot === 'agy[0]'));
  } finally {f.cleanup();}
});

test('host change to a native-first logical slot runs the physical cli', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    const dir = path.join(f.session,'host-to-logical');
    const reserve = {...slot('claude'), reserve:true};
    const first = await fanOut({dir, slots:[slot('agy'), reserve], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const pending = first.find(outcome => outcome.slot === 'agy[0]') as unknown as {state: string; attempt: string};
    assert.equal(pending?.state, 'native');
    assert.ok(pending.attempt.startsWith('claude[0]#'));
    f.deps.orchestrator = {platform: 'agy', model: null};
    f.script('claude','good','reserve cli answer');
    // The launch defers the host-changed fallback instead of running it
    // before the new descriptors return; the wave resumes it next.
    const second = await fanOut({dir, slots:[slot('agy'), reserve], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['agy']} as never, f.deps);
    assert.ok(!second.some(outcome => outcome.slot === 'agy[0]'), 'the deferred fallback never returns as pending: ' + JSON.stringify(second.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.ok(!f.launches.some(launch => launch.provider === 'claude'), 'no cli runs before the deferred return');
    const saved = JSON.parse(fs.readFileSync(path.join(dir,'slots','agy[0].json'),'utf8'));
    assert.equal(saved.cliFallback, true);
    assert.equal(saved.nativeError, 'host changed');
    const third = await fanOut({dir, slots:[slot('agy'), reserve], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['agy']} as never, f.deps);
    const done = third.find(entry => entry.slot === 'agy[0]');
    assert.equal(done?.state, 'done');
    assert.equal((done as unknown as {text: string}).text, 'reserve cli answer');
    assert.ok(f.launches.some(launch => launch.provider === 'claude' && launch.request.targetSlot === 'agy[0]'));
  } finally {f.cleanup();}
});

test('wave keeps a host native-only reserve substitute pending', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'codex', model: null};
    const dir = path.join(f.session,'wave-native-only-route');
    fs.mkdirSync(path.join(dir,'slots'),{recursive:true});
    fs.mkdirSync(path.join(dir,'prompts'),{recursive:true});
    fs.mkdirSync(path.join(dir,'replies'),{recursive:true});
    fs.writeFileSync(path.join(dir,'fanout.json'), JSON.stringify({nativeFirst:true}));
    fs.writeFileSync(path.join(dir,'prompts','agy[0].md'), 'question');
    const replyPath = path.join(dir,'replies','agy[0].m1.md');
    fs.writeFileSync(path.join(dir,'slots','agy[0].json'), JSON.stringify({slot:'agy[0]',state:'native',promptPath:path.join(dir,'prompts','agy[0].native.md'),replyPath,provider:'codex',attempt:'codex[0]#m1',cwd:f.session,model:'good'}));
    const reserve = {slot:'codex[0]', provider:'codex', index:0, model:'good', reserve:true, native:true};
    const outcomes = await fanOut({dir, slots:[slot('agy'), reserve], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    assert.equal(outcomes.find(outcome => outcome.slot === 'agy[0]')?.state, 'native');
    assert.equal(f.launches.filter(launch => launch.provider === 'codex').length, 0);
  } finally {f.cleanup();}
});

test('consume keeps a host native-only reserve substitute pending', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'codex', model: null};
    const dir = path.join(f.session,'consume-native-only-route');
    fs.mkdirSync(path.join(dir,'slots'),{recursive:true});
    fs.mkdirSync(path.join(dir,'prompts'),{recursive:true});
    fs.mkdirSync(path.join(dir,'replies'),{recursive:true});
    fs.writeFileSync(path.join(dir,'fanout.json'), JSON.stringify({nativeFirst:true, cliWaveDone:true}));
    fs.writeFileSync(path.join(dir,'prompts','agy[0].md'), 'question');
    const replyPath = path.join(dir,'replies','agy[0].m1.md');
    fs.writeFileSync(path.join(dir,'slots','agy[0].json'), JSON.stringify({slot:'agy[0]',state:'native',promptPath:path.join(dir,'prompts','agy[0].native.md'),replyPath,provider:'codex',attempt:'codex[0]#m1',cwd:f.session,model:'good'}));
    const reserve = {slot:'codex[0]', provider:'codex', index:0, model:'good', reserve:true, native:true};
    const input = {dir, slots:[slot('agy'), reserve], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:[]} as never;
    const outcomes = await fanOut(input, f.deps);
    assert.equal(outcomes.find(outcome => outcome.slot === 'agy[0]')?.state, 'native');
    fs.writeFileSync(replyPath, 'reserve answer');
    const done = await fanOut(input, f.deps);
    const finished = done.find(entry => entry.slot === 'agy[0]');
    assert.equal(finished?.state, 'done');
    assert.equal((finished as unknown as {text: string}).text, 'reserve answer');
    assert.deepEqual((finished as unknown as {responder: unknown}).responder, {slot: 'agy[0]', provider: 'codex', model: 'good', native: true});
  } finally {f.cleanup();}
});

test('wave launches a newly native-first target that has no saved slot', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('claude','good','cli answer');
    const dir = path.join(f.session,'wave-new-native-first');
    const slots = [slot('claude'), slot('agy')];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    assert.equal(first.length, 1);
    // The host changes before the CLI wave: the previously CLI target is now
    // native-first with no saved slot, while the old native target falls back.
    // The new descriptor returns before the slow fallback settles; the next
    // call resumes the deferred fallback.
    f.deps.orchestrator = {platform: 'agy', model: null};
    const waved = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['agy']} as never, f.deps);
    assert.equal(waved.length, 1, 'the stale attempt never returns as pending: ' + JSON.stringify(waved.map(outcome => outcome.slot)));
    const fresh = waved.find(outcome => outcome.slot === 'agy[0]') as unknown as {state: string; attempt: string};
    assert.equal(fresh?.state, 'native');
    assert.ok(fresh.attempt.startsWith('agy[0]#'));
    assert.ok(!waved.some(outcome => outcome.slot === 'claude[0]'), 'the stale attempt stays out of the early return: ' + JSON.stringify(waved.map(outcome => outcome.slot + ':' + outcome.state)));
    const settled = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['agy']} as never, f.deps);
    assert.equal(settled.find(outcome => outcome.slot === 'claude[0]')?.state, 'done');
  } finally {f.cleanup();}
});

test('launch keeps a matching report for a host-changed saved attempt', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    const dir = path.join(f.session,'launch-report-match');
    const reserve = {...slot('claude'), reserve:true};
    const slots = [slot('agy'), reserve];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const pending = first.find(outcome => outcome.slot === 'agy[0]') as unknown as {state: string; attempt: string};
    assert.equal(pending?.state, 'native');
    assert.ok(pending.attempt.startsWith('claude[0]#'));
    // The host changes to the logical target's platform while its pending
    // reserve attempt carries a matching BLOCKED report.
    f.deps.orchestrator = {platform: 'agy', model: null};
    f.script('claude','good','reserve cli answer');
    const ignored: string[] = [];
    const second = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session,
      nativeFirstProviders:['agy'], nativeFailures:[{attempt: pending.attempt, reason:'BLOCKED: no time', reasonHash:'rh1'}],
      onIgnoredReport: (attempt: string) => { ignored.push(attempt); }} as never, f.deps);
    assert.deepEqual(ignored, [], 'the matching report is consumed, not ignored');
    // The launch persists only the fallback marker; the deferred wave runs
    // the reserve cli with the reported reason and evidence.
    assert.ok(!second.some(outcome => outcome.slot === 'agy[0]'), 'the reported attempt defers, never pending: ' + JSON.stringify(second.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.ok(!f.launches.some(launch => launch.provider === 'claude'), 'no cli runs before the deferred return');
    const marked = JSON.parse(fs.readFileSync(path.join(dir,'slots','agy[0].json'),'utf8'));
    assert.equal(marked.cliFallback, true);
    assert.equal(marked.nativeError, 'BLOCKED: no time');
    const third = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['agy']} as never, f.deps);
    const done = third.find(outcome => outcome.slot === 'agy[0]') as unknown as {state: string; text: string; blocked: {reason: string; reasonHash: string}[]};
    assert.equal(done?.state, 'done');
    assert.equal(done.text, 'reserve cli answer');
    assert.ok((done.blocked ?? []).some(entry => entry.reasonHash === 'rh1'), 'blocked evidence is retained: ' + JSON.stringify(done.blocked));
  } finally {f.cleanup();}
});

test('launch replays every saved outcome when the host changes past a pending reserve', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('agy','good','target answer');
    f.script('codex','good',{status:'fail',cls:'auth',detail:'denied'});
    f.script('claude','good','reserve cli answer');
    const dir = path.join(f.session,'launch-nonfirst-host-change');
    const reserve = {...slot('claude'), reserve:true};
    const slots = [slot('agy'), slot('codex'), reserve];
    await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const savedCodex = JSON.parse(fs.readFileSync(path.join(dir,'slots','codex[0].json'),'utf8'));
    assert.equal(savedCodex.state, 'native');
    assert.ok((savedCodex.attempt as string).startsWith('claude[0]#'));
    // The session moves to the agy host: agy turns native-first while codex
    // keeps its pending claude reserve attempt with a matching BLOCKED report.
    f.deps.orchestrator = {platform: 'agy', model: null};
    const ignored: string[] = [];
    const second = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['agy'],
      nativeFailures:[{attempt: savedCodex.attempt, reason:'BLOCKED: old host denied', reasonHash:'rh-launch'}],
      onIgnoredReport: (attempt: string) => { ignored.push(attempt); }} as never, f.deps);
    assert.deepEqual(ignored, [], 'the matching report is consumed, not ignored');
    const replayed = second.find(outcome => outcome.slot === 'agy[0]');
    assert.equal(replayed?.state, 'done', 'every saved outcome returns, not only native-first slots: ' + JSON.stringify(second.map(outcome => outcome.slot + ':' + outcome.state)));
    // The launch defers the reported reserve instead of running its cli: the
    // marker persists with the reported reason and the wave resumes it next.
    assert.ok(!second.some(outcome => outcome.slot === 'codex[0]'), 'the reported reserve defers, never pending: ' + JSON.stringify(second.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.ok(!f.launches.some(launch => launch.provider === 'claude'), 'no cli runs before the deferred return');
    const marked = JSON.parse(fs.readFileSync(path.join(dir,'slots','codex[0].json'),'utf8'));
    assert.equal(marked.cliFallback, true);
    assert.equal(marked.nativeError, 'BLOCKED: old host denied');
    const third = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['agy']} as never, f.deps);
    const done = third.find(outcome => outcome.slot === 'codex[0]') as unknown as {state: string; text: string; blocked: {reasonHash: string}[]};
    assert.equal(done?.state, 'done', 'the pending reserve routes by its physical provider: ' + JSON.stringify(second.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.equal(done.text, 'reserve cli answer');
    assert.ok((done.blocked ?? []).some(entry => entry.reasonHash === 'rh-launch'), 'the matching report is retained: ' + JSON.stringify(done.blocked));
    assert.ok(f.launches.some(launch => launch.provider === 'claude' && launch.request.targetSlot === 'codex[0]'));
  } finally {f.cleanup();}
});

test('native responder keeps the launched model and effort when the roster changes before consumption', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    const dir = path.join(f.session,'launch-config-keep');
    const launched = [{slot:'claude[0]', provider:'claude', index:0, model:['launch-model'], effort:'high', reserve:false, native:false}];
    const first = await fanOut({dir, slots: launched, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const pending = first.find(outcome => outcome.state === 'native') as unknown as {replyPath: string};
    assert.ok(pending);
    // The configured model and effort change while the native answer is pending.
    const changed = [{slot:'claude[0]', provider:'claude', index:0, model:['changed-model'], effort:'low', reserve:false, native:false}];
    const second = await fanOut({dir, slots: changed, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    assert.equal(second.find(outcome => outcome.slot === 'claude[0]')?.state, 'native');
    fs.writeFileSync(pending.replyPath, 'valid answer');
    const third = await fanOut({dir, slots: changed, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const done = third.find(outcome => outcome.slot === 'claude[0]');
    assert.equal(done?.state, 'done');
    assert.deepEqual((done as unknown as {responder: unknown}).responder, {slot: 'claude[0]', provider: 'claude', model: 'launch-model', native: true, effort: 'high'});
  } finally {f.cleanup();}
});

test('cli wave mints a native descriptor for a host native-only reserve', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'codex', model: null};
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    f.script('codex','good','codex cli answer');
    const dir = path.join(f.session,'wave-native-only-reserve');
    const reserve = {slot:'codex[0]', provider:'codex', index:0, model:'good', reserve:true, native:true};
    const slots = [slot('claude'), slot('agy'), reserve];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    assert.equal(first.find(outcome => outcome.slot === 'claude[0]')?.state, 'native');
    const waved = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const substitute = waved.find(outcome => outcome.slot === 'agy[0]') as unknown as {state: string; provider: string; attempt: string; promptPath: string; cwd: string};
    assert.equal(substitute?.state, 'native', JSON.stringify(waved));
    assert.equal(substitute.provider, 'codex');
    assert.ok(substitute.attempt.startsWith('codex[0]#'));
    assert.equal(f.launches.filter(launch => launch.provider === 'codex').length, 0, 'no cli runs for the native-only reserve');
    const mintedPrompt = fs.readFileSync(substitute.promptPath, 'utf8');
    assert.ok(mintedPrompt.includes('Work in `' + substitute.cwd + '` for reads and Git commands.'), 'a reserve-minted native-only prompt names the working directory');
  } finally {f.cleanup();}
});

test('launch applies a matching failure report to a saved native-only attempt', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'agy', model: null};
    // A native-only voice saved under the old host; the new host resumes with
    // a matching BLOCKED report for that attempt.
    const dir = path.join(f.session,'launch-native-only-report');
    fs.mkdirSync(path.join(dir,'slots'),{recursive:true});
    fs.mkdirSync(path.join(dir,'prompts'),{recursive:true});
    fs.mkdirSync(path.join(dir,'replies'),{recursive:true});
    fs.writeFileSync(path.join(dir,'prompts','claude[0].md'), 'question');
    const replyPath = path.join(dir,'replies','claude[0].md');
    fs.writeFileSync(path.join(dir,'slots','claude[0].json'), JSON.stringify({slot:'claude[0]',state:'native',promptPath:path.join(dir,'prompts','claude[0].md'),replyPath,provider:'claude',attempt:'claude[0]#m1',cwd:f.session,model:'good'}));
    const only = {...slot('claude'), native:true};
    const ignored: string[] = [];
    const outcomes = await fanOut({dir, slots:[slot('agy'), only], prompt:'question', validate, quota, sessionRoot: f.session,
      nativeFirstProviders:['agy'], nativeFailures:[{attempt:'claude[0]#m1', reason:'BLOCKED: host unavailable', reasonHash:'rh-only1'}],
      onIgnoredReport: (attempt: string) => { ignored.push(attempt); }} as never, f.deps);
    assert.deepEqual(ignored, [], 'the matching report is consumed, not ignored');
    const saved = outcomes.find(outcome => outcome.slot === 'claude[0]') as unknown as {state: string; cls: string; blocked: {reasonHash: string}[]};
    assert.equal(saved?.state, 'failed', JSON.stringify(outcomes));
    assert.equal(saved.cls, 'blocked');
    assert.ok((saved.blocked ?? []).some(entry => entry.reasonHash === 'rh-only1'), 'blocked evidence is retained: ' + JSON.stringify(saved.blocked));
  } finally {f.cleanup();}
});

test('wave creates a newly eligible native-only target after a host and roster change', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('claude','good','claude cli answer');
    const dir = path.join(f.session,'wave-new-native-only');
    const first = await fanOut({dir, slots:[slot('claude')], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    assert.equal(first.find(outcome => outcome.slot === 'claude[0]')?.state, 'native');
    // The session moves to a host whose native-only provider joins the roster
    // with no saved slot while the old native target is still pending.
    f.deps.orchestrator = {platform: 'codex', model: null};
    const only = {...slot('codex'), native:true};
    const waved = await fanOut({dir, slots:[slot('claude'), only], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['codex']} as never, f.deps);
    const fresh = waved.find(outcome => outcome.slot === 'codex[0]') as unknown as {state: string; provider: string; attempt: string};
    assert.equal(fresh?.state, 'native', 'the newly eligible native-only target gets a descriptor: ' + JSON.stringify(waved.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.equal(fresh.provider, 'codex');
    // A later wave call settles the old target through its cli cascade.
    const settled = await fanOut({dir, slots:[slot('claude'), only], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['codex']} as never, f.deps);
    assert.equal(settled.find(outcome => outcome.slot === 'claude[0]')?.state, 'done');
    assert.equal(settled.find(outcome => outcome.slot === 'codex[0]')?.state, 'native');
  } finally {f.cleanup();}
});

test('consume keeps a wave-created native-only reserve pending on blocked and invalid replies', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'codex', model: null};
    const dir = path.join(f.session,'consume-native-only-replies');
    fs.mkdirSync(path.join(dir,'slots'),{recursive:true});
    fs.mkdirSync(path.join(dir,'prompts'),{recursive:true});
    fs.mkdirSync(path.join(dir,'replies'),{recursive:true});
    fs.writeFileSync(path.join(dir,'fanout.json'), JSON.stringify({nativeFirst:true, cliWaveDone:true}));
    fs.writeFileSync(path.join(dir,'prompts','agy[0].md'), 'question');
    const replyPath = path.join(dir,'replies','agy[0].m1.md');
    // A native-only reserve substitute saved under a non-native logical slot,
    // as the wave mints it after a host change.
    fs.writeFileSync(path.join(dir,'slots','agy[0].json'), JSON.stringify({slot:'agy[0]',state:'native',promptPath:path.join(dir,'prompts','agy[0].native.md'),replyPath,provider:'codex',attempt:'codex[0]#m1',cwd:f.session,model:'good'}));
    const reserve = {slot:'codex[0]', provider:'codex', index:0, model:'good', reserve:true, native:true};
    const input = {dir, slots:[slot('agy'), reserve], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never;
    fs.writeFileSync(replyPath, 'BLOCKED: host cannot write');
    const blocked = await fanOut(input, f.deps);
    assert.equal(blocked.find(outcome => outcome.slot === 'agy[0]')?.state, 'failed', 'a blocked reply saves failed: ' + JSON.stringify(blocked.map(outcome => outcome.slot + ':' + outcome.state)));
    // Reset to the pending substitute so the invalid reply is consumed from a
    // native attempt, not from the failed save above.
    fs.writeFileSync(path.join(dir,'slots','agy[0].json'), JSON.stringify({slot:'agy[0]',state:'native',promptPath:path.join(dir,'prompts','agy[0].native.md'),replyPath,provider:'codex',attempt:'codex[0]#m1',cwd:f.session,model:'good'}));
    fs.writeFileSync(replyPath, '   ');
    const invalid = await fanOut(input, f.deps);
    assert.equal(invalid.find(outcome => outcome.slot === 'agy[0]')?.state, 'native', 'an invalid reply stays pending-native: ' + JSON.stringify(invalid.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.equal(f.launches.filter(launch => launch.provider === 'codex').length, 0, 'no cli runs for the native-only reserve');
  } finally {f.cleanup();}
});

test('a reported native-first attempt defers to the cli fallback instead of failing', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('claude','good','cli answer');
    const dir = path.join(f.session,'wave-early-report');
    const first = await fanOut({dir, slots:[slot('claude'), slot('agy')], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const pending = first.find(outcome => outcome.slot === 'claude[0]') as unknown as {state: string; attempt: string};
    assert.equal(pending?.state, 'native');
    // The host changes: agy becomes native-first with no saved slot while the
    // old claude attempt carries a matching BLOCKED report.
    f.deps.orchestrator = {platform: 'agy', model: null};
    const ignored: string[] = [];
    const failed: string[] = [];
    const waved = await fanOut({dir, slots:[slot('claude'), slot('agy')], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['agy'],
      nativeFailures:[{attempt: pending.attempt, reason:'BLOCKED: old host denied', reasonHash:'rh-early'}],
      onIgnoredReport: (attempt: string) => { ignored.push(attempt); },
      onFailed: (slot: string) => { failed.push(slot); }} as never, f.deps);
    assert.equal(f.launches.length, 0, 'no cli launches before the new descriptors return');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'fanout.json'),'utf8')).cliWaveDone, undefined, 'the wave stays recoverable');
    const fresh = waved.find(outcome => outcome.slot === 'agy[0]') as unknown as {state: string; attempt: string};
    assert.equal(fresh?.state, 'native', 'the new host voice is returned without waiting');
    assert.ok(fresh.attempt.startsWith('agy[0]#'));
    assert.ok(!waved.some(outcome => outcome.slot === 'claude[0]'), 'a reported attempt is deferred, never pending or failed: ' + JSON.stringify(waved.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.deepEqual(failed, [], 'the deferred fallback marks no failure');
    const saved = JSON.parse(fs.readFileSync(path.join(dir,'slots','claude[0].json'),'utf8'));
    assert.equal(saved.cliFallback, true, 'the deferred fallback marker persists: ' + JSON.stringify(saved));
    assert.equal(saved.nativeError, 'BLOCKED: old host denied');
    assert.ok((saved.blocked ?? []).some((entry: {reasonHash: string}) => entry.reasonHash === 'rh-early'), 'blocked evidence is retained: ' + JSON.stringify(saved.blocked));
    assert.deepEqual(ignored, [], 'the matching report is consumed, not ignored');
    // The next call runs the deferred fallback through the cli.
    const resumed = await fanOut({dir, slots:[slot('claude'), slot('agy')], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['agy']} as never, f.deps);
    const done = resumed.find(outcome => outcome.slot === 'claude[0]');
    assert.equal(done?.state, 'done', 'the wave runs the deferred fallback: ' + JSON.stringify(resumed.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.equal((done as unknown as {text: string}).text, 'cli answer');
    assert.ok(f.launches.some(launch => launch.provider === 'claude'));
  } finally {f.cleanup();}
});

test('a blocked report on a reserve substitute under a non-first target defers to the reserve cli', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('claude','good','substitute cli answer');
    const dir = path.join(f.session,'wave-early-substitute');
    fs.mkdirSync(path.join(dir,'slots'),{recursive:true});
    fs.mkdirSync(path.join(dir,'prompts'),{recursive:true});
    fs.mkdirSync(path.join(dir,'replies'),{recursive:true});
    fs.writeFileSync(path.join(dir,'fanout.json'), JSON.stringify({nativeFirst:true}));
    fs.writeFileSync(path.join(dir,'prompts','agy[0].md'), 'question');
    const replyPath = path.join(dir,'replies','agy[0].m1.md');
    fs.writeFileSync(path.join(dir,'slots','agy[0].json'), JSON.stringify({slot:'agy[0]',state:'native',promptPath:path.join(dir,'prompts','agy[0].native.md'),replyPath,provider:'claude',attempt:'claude[1]#m1',cwd:f.session,model:'good'}));
    const reserve = {slot:'claude[1]', provider:'claude', index:1, model:'good', reserve:true, native:false};
    // codex turns native-first with no saved slot while the agy substitute
    // carries a matching BLOCKED report.
    const failed: string[] = [];
    const waved = await fanOut({dir, slots:[slot('agy'), slot('codex'), reserve], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['codex'],
      nativeFailures:[{attempt:'claude[1]#m1', reason:'BLOCKED: substitute host denied', reasonHash:'rh-sub'}],
      onFailed: (slot: string) => { failed.push(slot); }} as never, f.deps);
    assert.equal(f.launches.length, 0, 'no cli launches before the new descriptors return');
    const fresh = waved.find(outcome => outcome.slot === 'codex[0]');
    assert.equal(fresh?.state, 'native');
    assert.ok(!waved.some(outcome => outcome.slot === 'agy[0]'), 'the substitute defers, never pending or failed: ' + JSON.stringify(waved.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.deepEqual(failed, [], 'the deferred substitute marks no failure');
    const saved = JSON.parse(fs.readFileSync(path.join(dir,'slots','agy[0].json'),'utf8'));
    assert.equal(saved.cliFallback, true);
    assert.ok((saved.blocked ?? []).some((entry: {reasonHash: string}) => entry.reasonHash === 'rh-sub'), 'blocked evidence is retained');
    const resumed = await fanOut({dir, slots:[slot('agy'), slot('codex'), reserve], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['codex']} as never, f.deps);
    const done = resumed.find(outcome => outcome.slot === 'agy[0]');
    assert.equal(done?.state, 'failed', 'the host substitute saves failed without its CLI');
    assert.equal(f.launches.filter((launch) => launch.provider === 'claude').length, 0, 'no host CLI launches for the substitute');
  } finally {f.cleanup();}
});

test('a blocked report on a native-only attempt in the early wave still fails it', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'codex', model: null};
    const dir = path.join(f.session,'wave-early-native-only');
    fs.mkdirSync(path.join(dir,'slots'),{recursive:true});
    fs.mkdirSync(path.join(dir,'prompts'),{recursive:true});
    fs.mkdirSync(path.join(dir,'replies'),{recursive:true});
    fs.writeFileSync(path.join(dir,'fanout.json'), JSON.stringify({nativeFirst:true}));
    fs.writeFileSync(path.join(dir,'prompts','agy[0].md'), 'question');
    const replyPath = path.join(dir,'replies','agy[0].m1.md');
    fs.writeFileSync(path.join(dir,'slots','agy[0].json'), JSON.stringify({slot:'agy[0]',state:'native',promptPath:path.join(dir,'prompts','agy[0].native.md'),replyPath,provider:'codex',attempt:'codex[1]#m1',cwd:f.session,model:'good'}));
    const reserve = {slot:'codex[1]', provider:'codex', index:1, model:'good', reserve:true, native:true};
    const only = {...slot('codex'), native:true};
    // A newly eligible native-only target opens the early return while the
    // saved native-only substitute carries a matching BLOCKED report. There
    // is no cli cascade for it, so it still fails at once.
    const failed: string[] = [];
    const waved = await fanOut({dir, slots:[slot('agy'), only, reserve], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:[],
      nativeFailures:[{attempt:'codex[1]#m1', reason:'BLOCKED: native host denied', reasonHash:'rh-only'}],
      onFailed: (slot: string) => { failed.push(slot); }} as never, f.deps);
    assert.equal(waved.find(outcome => outcome.slot === 'codex[0]')?.state, 'native');
    const reported = waved.find(outcome => outcome.slot === 'agy[0]') as unknown as {state: string; cls: string; blocked: {reasonHash: string}[]};
    assert.equal(reported?.state, 'failed', 'a native-only attempt keeps its failed save: ' + JSON.stringify(waved.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.equal(reported.cls, 'blocked');
    assert.ok((reported.blocked ?? []).some(entry => entry.reasonHash === 'rh-only'));
    assert.deepEqual(failed, ['agy[0]'], 'the native-only failure still marks its slot');
  } finally {f.cleanup();}
});

test('cli-only retry off its host keeps the failed outcome instead of launching the saved reserve', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'codex', model: null};
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    const dir = path.join(f.session,'cli-only-offhost-reserve');
    // The first attempt fails with no reserve in the roster, so the failure
    // is a plain cli-only save with no native history.
    const first = await fanOut({dir, slots:[slot('agy')], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:[]} as never, f.deps);
    assert.equal(first.find(outcome => outcome.slot === 'agy[0]')?.state, 'failed');
    // The round is interrupted and resumes on another host whose roster adds a
    // native-only reserve for the old host. The retry fails again: the saved
    // old-host reserve must not launch off its host.
    f.deps.orchestrator = {platform: 'claude', model: null};
    const reserve = {slot:'codex[0]', provider:'codex', index:0, model:'good', reserve:true, native:true};
    const second = await fanOut({dir, slots:[slot('agy'), reserve], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:[]} as never, f.deps);
    const retried = second.find(outcome => outcome.slot === 'agy[0]');
    assert.equal(retried?.state, 'failed', 'the off-host reserve keeps the failed outcome: ' + JSON.stringify(second.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.equal(f.launches.filter(launch => launch.provider === 'codex').length, 0, 'no cli runs for the off-host native-only reserve');
  } finally {f.cleanup();}
});

test('wave early return omits a saved fallback marker and resumes it next call', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'agy', model: null};
    f.script('claude','good','cli answer');
    const dir = path.join(f.session,'wave-early-marker');
    fs.mkdirSync(path.join(dir,'slots'),{recursive:true});
    fs.mkdirSync(path.join(dir,'prompts'),{recursive:true});
    fs.mkdirSync(path.join(dir,'replies'),{recursive:true});
    fs.writeFileSync(path.join(dir,'fanout.json'), JSON.stringify({nativeFirst:true}));
    fs.writeFileSync(path.join(dir,'prompts','agy[0].md'), 'question');
    const replyPath = path.join(dir,'replies','claude[0].m1.md');
    // An interrupted fallback marker saved before this call; the host change
    // makes agy newly native-first with no saved slot.
    fs.writeFileSync(path.join(dir,'slots','claude[0].json'), JSON.stringify({slot:'claude[0]',state:'native',promptPath:path.join(dir,'prompts','claude[0].native.md'),replyPath,provider:'claude',attempt:'claude[0]#m1',cwd:f.session,model:'good',cliFallback:true,nativeError:'stopped mid fallback'}));
    const waved = await fanOut({dir, slots:[slot('claude'), slot('agy')], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['agy']} as never, f.deps);
    const fresh = waved.find(outcome => outcome.slot === 'agy[0]') as unknown as {state: string; attempt: string};
    assert.equal(fresh?.state, 'native', 'the newly eligible native target returns first: ' + JSON.stringify(waved.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.ok(!waved.some(outcome => outcome.slot === 'claude[0]'), 'an interrupted marker never returns as pending: ' + JSON.stringify(waved.map(outcome => outcome.slot + ':' + outcome.state)));
    const kept = JSON.parse(fs.readFileSync(path.join(dir,'slots','claude[0].json'),'utf8'));
    assert.equal(kept.cliFallback, true, 'the marker stays saved for the wave: ' + JSON.stringify(kept));
    const settled = await fanOut({dir, slots:[slot('claude'), slot('agy')], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['agy']} as never, f.deps);
    assert.equal(settled.find(outcome => outcome.slot === 'claude[0]')?.state, 'done', 'the wave resumes the marker through the cli: ' + JSON.stringify(settled.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.equal(settled.find(outcome => outcome.slot === 'agy[0]')?.state, 'native');
  } finally {f.cleanup();}
});

test('deferred fallback persists its marker before quarantining the reply', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('claude','good','cli answer');
    const dir = path.join(f.session,'defer-marker-order');
    const first = await fanOut({dir, slots:[slot('claude'), slot('agy')], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const pending = first.find(outcome => outcome.slot === 'claude[0]') as unknown as {state: string; attempt: string; replyPath: string};
    assert.equal(pending?.state, 'native');
    fs.writeFileSync(pending.replyPath, 'partial answer');
    // Crash between the two durable operations: the marker write must already
    // persist when quarantining the reply fails.
    f.deps.orchestrator = {platform: 'agy', model: null};
    const realRename = fs.renameSync, realCopy = fs.copyFileSync;
    const descriptor = (value: unknown) => ({...Object.getOwnPropertyDescriptor(fs, 'renameSync'), value});
    let renames = 0;
    Object.defineProperty(fs, 'renameSync', descriptor((...args: any[]) => { renames++; if (renames >= 3) throw new Error('crash before quarantine'); return (realRename as (...args: any[]) => unknown)(...args); }));
    Object.defineProperty(fs, 'copyFileSync', descriptor(() => { throw new Error('crash before quarantine'); }));
    const input = {dir, slots:[slot('claude'), slot('agy')], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['agy'],
      nativeFailures:[{attempt: pending.attempt, reason:'BLOCKED: old host denied', reasonHash:'rh-order'}]} as never;
    await assert.rejects(fanOut(input, f.deps), /crash before quarantine/);
    Object.defineProperty(fs, 'renameSync', descriptor(realRename));
    Object.defineProperty(fs, 'copyFileSync', descriptor(realCopy));
    const saved = JSON.parse(fs.readFileSync(path.join(dir,'slots','claude[0].json'),'utf8'));
    assert.equal(saved.cliFallback, true, 'the marker persists before the quarantine: ' + JSON.stringify(saved));
    assert.equal(saved.nativeError, 'BLOCKED: old host denied');
    assert.ok((saved.blocked ?? []).some((entry: {reasonHash: string}) => entry.reasonHash === 'rh-order'), 'the reported evidence persists: ' + JSON.stringify(saved.blocked));
    assert.ok(fs.existsSync(pending.replyPath), 'the reply stays until the marker write survives');
    const resumed = await fanOut({dir, slots:[slot('claude'), slot('agy')], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['agy']} as never, f.deps);
    const done = resumed.find(outcome => outcome.slot === 'claude[0]') as unknown as {state: string; text: string; blocked: {reasonHash: string}[]};
    assert.equal(done?.state, 'done', 'the retry falls back with the reported reason: ' + JSON.stringify(resumed.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.equal(done.text, 'cli answer');
    assert.ok((done.blocked ?? []).some(entry => entry.reasonHash === 'rh-order'), 'the retried fallback keeps the reported evidence');
    assert.ok(fs.existsSync(pending.replyPath + '.invalid-1'), 'the retry quarantines the reply');
  } finally {f.cleanup();}
});

test('a recomputed roster without the native-only reserve fails closed without the wrong cli', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'codex', model: null};
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    const dir = path.join(f.session,'missing-physical-fail-closed');
    const slots = [slot('agy'), {...slot('codex'), reserve:true, native:true}];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:[]} as never, f.deps);
    const pending = first.find(outcome => outcome.slot === 'agy[0]') as unknown as {state: string; attempt: string};
    assert.equal(pending?.state, 'native');
    assert.ok(pending.attempt.startsWith('codex[0]#'));
    f.deps.orchestrator = {platform: 'opencode', model: null};
    f.launches.length = 0;
    const second = await fanOut({dir, slots:[slot('agy')], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['opencode']} as never, f.deps);
    const failed = second.find(outcome => outcome.slot === 'agy[0]');
    assert.equal(failed?.state, 'failed', 'the missing physical saves failed: ' + JSON.stringify(second.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.equal(f.launches.length, 0, 'no cli runs under the wrong voice');
    assert.ok(!('attempt' in (failed as unknown as Record<string, unknown>)), 'no fresh descriptor minted');
  } finally {f.cleanup();}
});

test('a launch with no launchable native falls through to the cli wave in the same call', async () => {
  const {fanOutComplete} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('agy','good','cli answer');
    const dir = path.join(f.session,'launch-fallthrough');
    fs.mkdirSync(path.join(dir,'slots'),{recursive:true});
    fs.mkdirSync(path.join(dir,'prompts'),{recursive:true});
    fs.mkdirSync(path.join(dir,'replies'),{recursive:true});
    fs.writeFileSync(path.join(dir,'prompts','claude[0].md'), 'question');
    fs.writeFileSync(path.join(dir,'slots','claude[0].json'), JSON.stringify({slot:'claude[0]',state:'done',text:'kept',responder:{slot:'claude[0]',provider:'claude',model:'good',native:false}}));
    const outcomes = await fanOutComplete({dir, slots:[slot('claude'), slot('agy')], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    assert.equal(outcomes.find(outcome => outcome.slot === 'claude[0]')?.state, 'done');
    assert.equal(outcomes.find(outcome => outcome.slot === 'agy[0]')?.state, 'done', 'the cli wave runs in the same call: ' + JSON.stringify(outcomes.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.ok(f.launches.some(launch => launch.provider === 'agy'), 'the unsaved cli voice launches');
  } finally {f.cleanup();}
});

test('a lowercase blocked report for a native-only reserve saves refusal without evidence', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'codex', model: null};
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    const dir = path.join(f.session,'wave-native-only-lowercase');
    const reserve = {slot:'codex[0]', provider:'codex', index:0, model:'good', reserve:true, native:true};
    const slots = [slot('claude'), slot('agy'), reserve];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    assert.equal(first.find(outcome => outcome.slot === 'claude[0]')?.state, 'native');
    const waved = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const substitute = waved.find(outcome => outcome.slot === 'agy[0]') as unknown as {state: string; attempt: string};
    assert.equal(substitute?.state, 'native');
    assert.ok(substitute.attempt.startsWith('codex[0]#'));
    const reported = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude'],
      nativeFailures:[{attempt: substitute.attempt, reason:'blocked: reserve denied', reasonHash:'rh-wave-lower'}]} as never, f.deps);
    const failed = reported.find(outcome => outcome.slot === 'agy[0]') as unknown as {state: string; cls: string; reason: string; blocked?: unknown[]};
    assert.equal(failed?.state, 'failed');
    assert.equal(failed.cls, 'refusal', 'a differently-cased prefix is not the BLOCKED protocol marker: ' + JSON.stringify(failed));
    assert.equal(failed.blocked, undefined, 'no blocked evidence without the exact marker: ' + JSON.stringify(failed));
    assert.equal(failed.reason, 'refusal: blocked: reserve denied', 'the saved reason keeps the delegate wording: ' + JSON.stringify(failed));
    assert.ok(failed.reason.startsWith('refusal: '), JSON.stringify(failed));
    assert.equal(f.launches.filter(launch => launch.provider === 'codex').length, 0, 'no cli runs for the native-only reserve');
  } finally {f.cleanup();}
});

test('a launchable native returns before the cli wave when a saved orphan waits', async () => {
  const {fanOutComplete} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('agy', 'good', 'cli answer');
    const dir = path.join(f.session,'complete-orphan-launchable');
    fs.mkdirSync(path.join(dir,'slots'),{recursive:true});
    fs.mkdirSync(path.join(dir,'prompts'),{recursive:true});
    fs.mkdirSync(path.join(dir,'replies'),{recursive:true});
    fs.writeFileSync(path.join(dir,'prompts','codex[0].md'), 'question');
    // A saved done orphan whose provider left the recomputed roster.
    fs.writeFileSync(path.join(dir,'slots','codex[0].json'), JSON.stringify({slot:'codex[0]',state:'done',text:'kept',responder:{slot:'codex[0]',provider:'codex',model:'good',native:false}}));
    const outcomes = await fanOutComplete({dir, slots:[slot('claude'), slot('agy')], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    assert.equal(outcomes.find(outcome => outcome.slot === 'claude[0]')?.state, 'native');
    assert.ok(!outcomes.some(outcome => outcome.slot === 'agy[0]'), 'the cli target waits for the next call: ' + JSON.stringify(outcomes.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.equal(f.launches.length, 0, 'no cli launches while a native is launchable');
    assert.equal(fs.existsSync(path.join(dir,'fanout.json')), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'fanout.json'),'utf8')).cliWaveDone, undefined, 'the wave stays recoverable');
  } finally {f.cleanup();}
});

test('a cli-only round stops routing when its native-only reserve is off host', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    f.script('codex','good','reserve cli answer');
    const events: unknown[] = [];
    f.deps.diagnostics = (event: unknown) => { events.push(event); };
    const dir = path.join(f.session,'cli-only-offhost-reserve-routing');
    const reserve = {slot:'codex[0]', provider:'codex', index:0, model:'good', reserve:true, native:true};
    const slots = [slot('agy'), reserve];
    const outcomes = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:[]} as never, f.deps);
    const retried = outcomes.find(outcome => outcome.slot === 'agy[0]');
    assert.equal(retried?.state, 'failed', 'the off-host reserve keeps the failed outcome: ' + JSON.stringify(outcomes.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.equal(f.launches.filter(launch => launch.provider === 'codex').length, 0, 'no cli runs for the off-host native-only reserve');
    assert.ok(!(events as any[]).some(event => event.kind === 'routing' && event.state === 'reserve' && event.slot === 'agy[0]'), 'an off-host reserve emits no reserve routing: ' + JSON.stringify((events as any[]).filter(event => event.kind === 'routing')));
  } finally {f.cleanup();}
});

test('a last-pending retry carries saved blocked evidence into the reserve descriptor', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    const dir = path.join(f.session,'retry-prior-blocked');
    const reserve = {slot:'claude[1]', provider:'claude', index:1, model:'good', reserve:true, native:false};
    const slots = [slot('claude'), slot('agy'), reserve];
    fs.mkdirSync(path.join(dir,'slots'),{recursive:true});
    fs.mkdirSync(path.join(dir,'prompts'),{recursive:true});
    fs.mkdirSync(path.join(dir,'replies'),{recursive:true});
    fs.writeFileSync(path.join(dir,'fanout.json'), JSON.stringify({nativeFirst:true, cliWaveDone:true}));
    const replyPath = path.join(dir,'replies','claude[0].r1.md');
    fs.writeFileSync(path.join(dir,'slots','claude[0].json'), JSON.stringify({slot:'claude[0]',state:'native',promptPath:path.join(dir,'prompts','claude[0].native.md'),replyPath,provider:'claude',attempt:'claude[0]#r1',cwd:f.session,model:'good'}));
    fs.writeFileSync(replyPath, 'native answer');
    fs.writeFileSync(path.join(dir,'slots','agy[0].json'), JSON.stringify({slot:'agy[0]',state:'failed',cls:'auth',reason:'denied',blocked:[{provider:'agy',model:'good',reason:'earlier refusal',reasonHash:'rh-prior'}]}));
    // Capture the slot file at every atomic write: the first agy write is
    // the reserve descriptor itself, before any later merge could persist.
    const realRename = fs.renameSync;
    const writes: string[] = [];
    (fs as unknown as {renameSync: typeof fs.renameSync}).renameSync = ((source: string, destination: string) => {
      if (String(destination).endsWith('agy[0].json')) {
        try { writes.push(fs.readFileSync(source, 'utf8')); } catch {}
      }
      return (realRename as (...args: [string, string]) => void)(source, destination);
    }) as typeof fs.renameSync;
    try {
      const outcomes = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
      assert.equal(outcomes.find(outcome => outcome.slot === 'agy[0]')?.state, 'native');
    } finally {
      (fs as unknown as {renameSync: typeof fs.renameSync}).renameSync = realRename as typeof fs.renameSync;
    }
    assert.ok(writes.length >= 1, 'the retry persists the reserve descriptor');
    const descriptor = JSON.parse(writes[0]!);
    assert.ok((descriptor.blocked ?? []).some((entry: {reasonHash: string}) => entry.reasonHash === 'rh-prior'), 'the persisted descriptor keeps earlier blocked evidence: ' + writes[0]);
  } finally {f.cleanup();}
});

test('a cli wave stops routing when its native-only reserve is off host', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('agy','good',{status:'fail',cls:'auth',detail:'denied'});
    f.script('codex','good','reserve cli answer');
    const events: unknown[] = [];
    f.deps.diagnostics = (event: unknown) => { events.push(event); };
    const dir = path.join(f.session,'wave-offhost-reserve-routing');
    const reserve = {slot:'codex[0]', provider:'codex', index:0, model:'good', reserve:true, native:true};
    const slots = [slot('claude'), slot('agy'), reserve];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    assert.equal(first.find(outcome => outcome.slot === 'claude[0]')?.state, 'native');
    const waved = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const retried = waved.find(outcome => outcome.slot === 'agy[0]');
    assert.equal(retried?.state, 'failed', 'the off-host reserve keeps the failed outcome: ' + JSON.stringify(waved.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.equal(f.launches.filter(launch => launch.provider === 'codex').length, 0, 'no cli runs for the off-host native-only reserve');
    assert.ok(!(events as any[]).some(event => event.kind === 'routing' && event.state === 'reserve' && event.slot === 'agy[0]'), 'an off-host reserve emits no reserve routing: ' + JSON.stringify((events as any[]).filter(event => event.kind === 'routing')));
  } finally {f.cleanup();}
});

test('deferred ignores wait for reconciled orphans before reaching the callback', async () => {
  const {fanOutComplete} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('agy','good','cli answer');
    const dir = path.join(f.session,'complete-defer-ignored');
    fs.mkdirSync(path.join(dir,'slots'),{recursive:true});
    fs.mkdirSync(path.join(dir,'prompts'),{recursive:true});
    fs.mkdirSync(path.join(dir,'replies'),{recursive:true});
    fs.writeFileSync(path.join(dir,'prompts','claude[0].md'), 'question');
    const orphanReply = path.join(dir,'replies','agy[0].orphan.md');
    fs.writeFileSync(path.join(dir,'slots','agy[0].json'), JSON.stringify({slot:'agy[0]',state:'native',promptPath:path.join(dir,'prompts','agy[0].native.md'),replyPath:orphanReply,provider:'agy',attempt:'agy[0]#orphan1',cwd:f.session,model:'good'}));
    const ignored: string[] = [];
    const input = {dir, slots:[slot('claude')], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude'], nativeFailures:[{attempt:'agy[0]#orphan1', reason:'BLOCKED: gone', reasonHash:'rh-orphan'}], onIgnoredReport: (attempt: string) => { ignored.push(attempt); }};
    const first = await fanOutComplete(input as never, f.deps);
    assert.ok(first.some(outcome => outcome.slot === 'claude[0]' && outcome.state === 'native'), 'the launchable native returns: ' + JSON.stringify(first.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.ok(!first.some(outcome => outcome.slot === 'agy[0]'), 'the orphan waits for the next call: ' + JSON.stringify(first.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.equal(f.launches.length, 0, 'no cli launches while a native is launchable');
    assert.deepEqual(ignored, [], 'the orphan report defers instead of reaching the callback');
    const marked = JSON.parse(fs.readFileSync(path.join(dir,'slots','agy[0].json'),'utf8'));
    assert.equal(marked.cliFallback, true, 'the orphan failure persists its fallback marker: ' + JSON.stringify(marked));
    assert.equal(marked.nativeError, 'BLOCKED: gone');
    assert.ok((marked.blocked ?? []).some((entry: {reasonHash: string}) => entry.reasonHash === 'rh-orphan'), 'the marker keeps the reported evidence: ' + JSON.stringify(marked.blocked));
    // A partial native reply present during the deferred wave call stays unread.
    const pending = first.find(outcome => outcome.slot === 'claude[0]') as unknown as {replyPath: string};
    fs.writeFileSync(pending.replyPath, 'partial answer');
    f.launches.length = 0;
    const second = await fanOutComplete({...input, nativeFailures: []} as never, f.deps);
    assert.equal(second.find(outcome => outcome.slot === 'claude[0]')?.state, 'native', 'the wave never consumes a partial reply: ' + JSON.stringify(second.map(outcome => outcome.slot + ':' + outcome.state)));
    const run = second.find(outcome => outcome.slot === 'agy[0]') as unknown as {state: string; text: string; blocked: {reasonHash: string}[]};
    assert.equal(run?.state, 'done', 'the marked fallback runs its cli cascade in the wave: ' + JSON.stringify(second.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.equal(run.text, 'cli answer');
    assert.ok((run.blocked ?? []).some(entry => entry.reasonHash === 'rh-orphan'), 'the marker keeps its reported evidence: ' + JSON.stringify(run.blocked));
    assert.ok(f.launches.some(launch => launch.provider === 'agy'), 'the marked fallback launches its cli while a native stays pending');
    assert.ok(!f.launches.some(launch => launch.provider === 'claude'), 'no cli launches for the still-pending native');
    assert.equal(fs.readFileSync(pending.replyPath, 'utf8'), 'partial answer', 'the partial reply stays unread');
    assert.ok(!fs.existsSync(pending.replyPath + '.invalid-1'), 'the partial reply is never quarantined by the wave');
    assert.deepEqual(ignored, [], 'the consumed report never reaches the callback');
    // Once the native answer lands, the next call consumes it and reconciles
    // the marked orphan through the deferred cascade with its evidence.
    fs.writeFileSync(pending.replyPath, 'native answer');
    const third = await fanOutComplete({...input, nativeFailures: []} as never, f.deps);
    assert.equal(third.find(outcome => outcome.slot === 'claude[0]')?.state, 'done');
    const reconciled = third.find(outcome => outcome.slot === 'agy[0]') as unknown as {state: string; text: string; blocked: {reasonHash: string}[]};
    assert.equal(reconciled?.state, 'done', 'the orphan reconciles once the native settles: ' + JSON.stringify(third.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.equal(reconciled.text, 'cli answer');
    assert.ok((reconciled.blocked ?? []).some(entry => entry.reasonHash === 'rh-orphan'), 'the reported evidence survives the deferred cascade: ' + JSON.stringify(reconciled.blocked));
    assert.deepEqual(ignored, [], 'the consumed report never reaches the callback');
  } finally {f.cleanup();}
});

test('a launchable native returns first and defers unrelated orphans while forwarding stale reports', async () => {
  const {fanOutComplete} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('agy','good','cli answer');
    const dir = path.join(f.session,'complete-stale-report');
    for (const sub of ['slots','prompts','replies']) fs.mkdirSync(path.join(dir,sub),{recursive:true});
    fs.writeFileSync(path.join(dir,'slots','agy[0].json'), JSON.stringify({slot:'agy[0]',state:'native',promptPath:path.join(dir,'prompts','agy[0].native.md'),replyPath:path.join(dir,'replies','agy[0].unrelated.md'),provider:'agy',attempt:'agy[0]#unrelated',cwd:f.session,model:'good'}));
    const ignored: string[] = [];
    const input = {dir, slots:[slot('claude')], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude'],
      nativeFailures:[{attempt:'codex[0]#stale', reason:'BLOCKED: gone', reasonHash:'rh-stale'}], onIgnoredReport: (attempt: string) => { ignored.push(attempt); }};
    const first = await fanOutComplete(input as never, f.deps);
    assert.ok(first.some(outcome => outcome.slot === 'claude[0]' && outcome.state === 'native'), 'the launchable native returns: ' + JSON.stringify(first.map(outcome => outcome.slot + ':' + outcome.state)));
    assert.equal(f.launches.length, 0, 'no cli launch on the call that returns a launchable native');
    assert.ok(!first.some(outcome => outcome.slot === 'agy[0]'), 'the unrelated orphan waits for the next call');
    assert.deepEqual(ignored, ['codex[0]#stale'], 'the stale report reaches the callback on the returning call');
  } finally {f.cleanup();}
});

test('host voice launches native for every nativeSubagentsOnly value', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const {resolveRoster} = await import('../../../skills/dispatch/scripts/policy/roster.ts');
  for (const only of [true, false, undefined] as const) {
    const delegate: Record<string, unknown> = { targets: [{ low: { model: 'm' } }] };
    if (only !== undefined) (delegate as Record<string, unknown>)['nativeSubagentsOnly'] = only;
    const roster = resolveRoster({
      level: 'low', readDelegates: { claude: delegate as never, agy: { targets: [{ low: { model: 'a' } }] } },
      policy: { rounds: { low: 1 }, targets: { low: 2 } },
      orchestrator: { platform: 'claude' }, liveness: { claude: false, agy: true },
    });
    const hasHost = roster.targets.some((item) => item.provider === 'claude') || roster.reserves.some((item) => item.provider === 'claude');
    assert.ok(hasHost, `roster keeps host for only=${String(only)}: ` + JSON.stringify(roster));
    const f = sessionFixture({memory:true}); try {
      f.deps.orchestrator = {platform: 'claude', model: null};
      const dir = path.join(f.session, `host-native-${String(only)}`);
      const slotDef = only === true ? slot('claude','good',false,true) : slot('claude');
      const nativeFirst = only === true ? [] : ['claude'];
      const outcomes = await fanOut({dir, slots:[slotDef], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders: nativeFirst} as never, f.deps);
      assert.equal(outcomes[0]?.state, 'native', `native descriptor for only=${String(only)}`);
      assert.equal(f.launches.length, 0, `no CLI for only=${String(only)}`);
    } finally {f.cleanup();}
  }
});

test('host native failure takes reserve without host CLI', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('copilot','good','reserve answer');
    const dir = path.join(f.session,'host-failure-reserve');
    const slots = [slot('claude'), {...slot('copilot'), reserve:true}];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const pending = first.find((outcome) => outcome.slot === 'claude[0]') as unknown as {state: string; attempt: string};
    assert.equal(pending?.state, 'native');
    const second = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude'],
      nativeFailures:[{attempt: pending.attempt, reason:'launch gone', reasonHash:'h1'}]} as never, f.deps);
    const outcome = second.find((entry) => entry.slot === 'claude[0]');
    assert.equal(outcome?.state, 'done', 'reserve CLI: ' + JSON.stringify(second.map((entry) => entry.slot + ':' + entry.state)));
    assert.equal((outcome as unknown as {text: string}).text, 'reserve answer', 'reserve answer: ' + JSON.stringify(outcome));
    assert.equal((outcome as unknown as {responder: {provider: string}}).responder.provider, 'copilot', 'reserve provider: ' + JSON.stringify(outcome));
    assert.equal(f.launches.filter((launch) => launch.provider === 'claude').length, 0, 'no host CLI');
  } finally {f.cleanup();}
});

test('host native failure without reserve saves failed', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    const dir = path.join(f.session,'host-failure-noreserve');
    const slots = [slot('claude')];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const pending = first.find((outcome) => outcome.slot === 'claude[0]') as unknown as {state: string; attempt: string};
    assert.equal(pending?.state, 'native');
    const second = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude'],
      nativeFailures:[{attempt: pending.attempt, reason:'launch gone', reasonHash:'h2'}]} as never, f.deps);
    const failed = second.find((entry) => entry.slot === 'claude[0]');
    assert.equal(failed?.state, 'failed');
    assert.equal(f.launches.length, 0, 'no host CLI');
  } finally {f.cleanup();}
});

test('host native failure on native-only report takes reserve', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'codex', model: null};
    f.script('copilot','good','reserve answer');
    const dir = path.join(f.session,'host-nativeonly-report-reserve');
    const only = {...slot('codex'), native:true};
    const reserve = {...slot('copilot'), reserve:true};
    const first = await fanOut({dir, slots:[only, reserve], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:[]} as never, f.deps);
    const pending = first.find((outcome) => outcome.slot === 'codex[0]') as unknown as {state: string; attempt: string};
    assert.equal(pending?.state, 'native');
    const second = await fanOut({dir, slots:[only, reserve], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:[],
      nativeFailures:[{attempt: pending.attempt, reason:'BLOCKED: denied', reasonHash:'rh1'}]} as never, f.deps);
    const outcome = second.find((entry) => entry.slot === 'codex[0]');
    assert.ok(outcome?.state === 'native' || outcome?.state === 'done', 'reserve or done: ' + JSON.stringify(outcome));
    assert.equal(f.launches.filter((launch) => launch.provider === 'codex').length, 0, 'no host CLI');
  } finally {f.cleanup();}
});

test('host native failure on native-only BLOCKED reply takes reserve', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'codex', model: null};
    f.script('copilot','good','reserve answer');
    const dir = path.join(f.session,'host-nativeonly-blocked-reserve');
    const only = {...slot('codex'), native:true};
    const reserve = {...slot('copilot'), reserve:true};
    const first = await fanOut({dir, slots:[only, reserve], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:[]} as never, f.deps);
    const pending = first.find((outcome) => outcome.slot === 'codex[0]') as unknown as {state: string; replyPath: string};
    assert.equal(pending?.state, 'native');
    fs.writeFileSync(pending.replyPath, 'BLOCKED: host cannot write');
    const outcomes = await fanOut({dir, slots:[only, reserve], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:[]} as never, f.deps);
    const outcome = outcomes.find((entry) => entry.slot === 'codex[0]');
    assert.equal(outcome?.state, 'done', 'reserve takes over BLOCKED: ' + JSON.stringify(outcome));
    assert.equal((outcome as unknown as {text: string}).text, 'reserve answer');
    assert.equal(f.launches.filter((launch) => launch.provider === 'codex').length, 0, 'no host CLI');
  } finally {f.cleanup();}
});

test('host native failure on native-only BLOCKED reply without reserve saves failed', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'codex', model: null};
    const dir = path.join(f.session,'host-nativeonly-blocked-noreserve');
    fs.mkdirSync(path.join(dir,'slots'),{recursive:true});
    fs.mkdirSync(path.join(dir,'prompts'),{recursive:true});
    fs.mkdirSync(path.join(dir,'replies'),{recursive:true});
    fs.writeFileSync(path.join(dir,'fanout.json'), JSON.stringify({nativeFirst:true, cliWaveDone:true}));
    fs.writeFileSync(path.join(dir,'prompts','agy[0].md'), 'question');
    const replyPath = path.join(dir,'replies','agy[0].m1.md');
    fs.writeFileSync(path.join(dir,'slots','agy[0].json'), JSON.stringify({slot:'agy[0]',state:'native',promptPath:path.join(dir,'prompts','agy[0].native.md'),replyPath,provider:'codex',attempt:'codex[0]#m1',cwd:f.session,model:'good'}));
    fs.writeFileSync(replyPath, 'BLOCKED: host cannot write');
    const outcomes = await fanOut({dir, slots:[slot('agy')], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const failed = outcomes.find((entry) => entry.slot === 'agy[0]');
    assert.equal(failed?.state, 'failed');
    assert.equal(f.launches.filter((launch) => launch.provider === 'codex').length, 0, 'no host CLI');
  } finally {f.cleanup();}
});

test('host native failure saved failed retake launches no host CLI', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    const dir = path.join(f.session,'host-saved-failed-retake');
    const slots = [slot('claude')];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const pending = first.find((outcome) => outcome.slot === 'claude[0]') as unknown as {state: string; attempt: string};
    assert.equal(pending?.state, 'native');
    const second = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude'],
      nativeFailures:[{attempt: pending.attempt, reason:'launch gone', reasonHash:'h3'}]} as never, f.deps);
    assert.equal(second.find((entry) => entry.slot === 'claude[0]')?.state, 'failed');
    f.launches.length = 0;
    f.script('claude','good','should not run');
    const third = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    assert.equal(third.find((entry) => entry.slot === 'claude[0]')?.state, 'failed');
    assert.equal(f.launches.filter((launch) => launch.provider === 'claude').length, 0, 'no host CLI on retake');
  } finally {f.cleanup();}
});

test('host native failure saved CLI failure retake after host change launches no host CLI', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.script('claude','good',{status:'fail',cls:'auth',detail:'denied'});
    const dir = path.join(f.session,'host-cli-saved-hostchange');
    const first = await fanOut({dir, slots:[slot('claude')], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:[]} as never, f.deps);
    assert.equal(first.find((outcome) => outcome.slot === 'claude[0]')?.state, 'failed');
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.launches.length = 0;
    f.script('claude','good','should not run');
    f.script('agy','good','reserve answer');
    const reserve = {...slot('agy'), reserve:true};
    const second = await fanOut({dir, slots:[slot('claude'), reserve], prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['claude']} as never, f.deps);
    const outcome = second.find((entry) => entry.slot === 'claude[0]');
    assert.equal(outcome?.state, 'native', 'saved CLI failure mints a fresh host native attempt: ' + JSON.stringify(outcome));
    assert.equal(f.launches.filter((launch) => launch.provider === 'claude').length, 0, 'no host CLI after host change');
  } finally {f.cleanup();}
});

test('off-host saved native attempt keeps CLI cascade', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    f.deps.orchestrator = {platform: 'claude', model: null};
    const dir = path.join(f.session,'offhost-keeps-cli');
    const slots = [slot('agy')];
    const first = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['agy']} as never, f.deps);
    const pending = first.find((outcome) => outcome.slot === 'agy[0]') as unknown as {state: string; attempt: string};
    assert.equal(pending?.state, 'native');
    f.deps.orchestrator = {platform: 'opencode', model: null};
    f.launches.length = 0;
    f.script('agy','good','cli answer after host change');
    const second = await fanOut({dir, slots, prompt:'question', validate, quota, sessionRoot: f.session, nativeFirstProviders:['agy'],
      nativeFailures:[{attempt: pending.attempt, reason:'launch gone', reasonHash:'h1'}]} as never, f.deps);
    const outcome = second.find((entry) => entry.slot === 'agy[0]');
    assert.equal(outcome?.state, 'done', 'CLI cascade kept off host: ' + JSON.stringify(outcome));
    assert.equal((outcome as unknown as {text: string}).text, 'cli answer after host change');
    assert.deepEqual(f.launches.map((launch) => launch.provider), ['agy'], 'off-host CLI runs');
  } finally {f.cleanup();}
});

test('opencode native descriptors carry exact subagent model values', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const nativeOf = (outcome: unknown) => outcome as {state: string; provider: string; model?: unknown; effort?: unknown; subagentModels?: unknown};
  // Native-only descriptor with effort carries P/M#E.
  {
    const f = sessionFixture({memory:true}); try {
      f.deps.orchestrator = {platform: 'opencode', model: null};
      const dir = path.join(f.session, 'native-only-effort');
      const slots = [{slot: 'opencode[0]', provider: 'opencode', index: 0, model: 'prov/model', effort: 'my-eff', native: true, reserve: false}];
      const first = await fanOut({dir, slots, prompt: 'question', validate, quota} as never, f.deps);
      const native = nativeOf(first.find(outcome => outcome.slot === 'opencode[0]'));
      assert.equal(native.state, 'native');
      assert.equal(native.model, 'prov/model');
      assert.equal(native.effort, 'my-eff');
      assert.deepEqual(native.subagentModels, ['prov/model#my-eff']);
    } finally {f.cleanup();}
  }
  // Native-only descriptor without effort carries plain P/M, and other providers carry no value.
  {
    const f = sessionFixture({memory:true}); try {
      f.deps.orchestrator = {platform: 'opencode', model: null};
      const dir = path.join(f.session, 'native-only-plain');
      const slots = [{slot: 'opencode[0]', provider: 'opencode', index: 0, model: ['a', 'b'], native: true, reserve: false}];
      const first = await fanOut({dir, slots, prompt: 'question', validate, quota} as never, f.deps);
      const native = nativeOf(first.find(outcome => outcome.slot === 'opencode[0]'));
      assert.deepEqual(native.subagentModels, ['a', 'b']);
      const g = sessionFixture({memory:true}); try {
        const cdir = path.join(g.session, 'native-only-other');
        const cslots = [{slot: 'claude[0]', provider: 'claude', index: 0, model: 'm', effort: 'high', native: true, reserve: false}];
        const cout = await fanOut({dir: cdir, slots: cslots, prompt: 'question', validate, quota} as never, g.deps);
        assert.equal('subagentModels' in nativeOf(cout.find(outcome => outcome.slot === 'claude[0]')), false);
      } finally {g.cleanup();}
    } finally {f.cleanup();}
  }
  // Native-first descriptor shares the same launch fields.
  {
    const f = sessionFixture({memory:true}); try {
      f.deps.orchestrator = {platform: 'opencode', model: null};
      const dir = path.join(f.session, 'native-first-value');
      const slots = [{slot: 'opencode[0]', provider: 'opencode', index: 0, model: ['x/y'], effort: 'high', native: false, reserve: false}];
      const first = await fanOut({dir, slots, prompt: 'question', validate, quota, sessionRoot: f.session, nativeFirstProviders: ['opencode']} as never, f.deps);
      const native = nativeOf(first.find(outcome => outcome.slot === 'opencode[0]'));
      assert.equal(native.provider, 'opencode');
      assert.deepEqual(native.subagentModels, ['x/y#high']);
    } finally {f.cleanup();}
  }
  // Native-only reserve descriptor shares the same launch fields.
  {
    const f = sessionFixture({memory:true}); try {
      f.deps.orchestrator = {platform: 'opencode', model: null};
      f.script('agy', 'good', {status: 'fail', cls: 'auth', detail: 'denied'});
      const dir = path.join(f.session, 'native-only-reserve-value');
      const reserve = {slot: 'opencode[0]', provider: 'opencode', index: 0, model: 'r/m', effort: 'low', reserve: true, native: true};
      const slots = [slot('agy'), reserve];
      const first = await fanOut({dir, slots, prompt: 'question', validate, quota, sessionRoot: f.session, nativeFirstProviders: []} as never, f.deps);
      const pending = nativeOf(first.find(outcome => outcome.slot === 'agy[0]'));
      assert.equal(pending.state, 'native');
      assert.deepEqual(pending.subagentModels, ['r/m#low']);
    } finally {f.cleanup();}
  }
});


test('rerun resumes an unfinished slot in its saved session', async () => {
  const {fanOut} = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({memory:true}); try {
    const dir=path.join(f.session,'resume'), logs=path.join(dir,'logs'); fs.mkdirSync(logs,{recursive:true});
    fs.writeFileSync(path.join(logs,'opencode[0].state.json'),JSON.stringify({physicalSlot:'opencode[0]',provider:'opencode',model:'good',position:{model:0,mode:0},pending:'stall',resumesUsed:1,reportResumes:0,sessionId:'ses_abc'}));
    fs.writeFileSync(path.join(logs,'opencode[0].log'),'old log');
    f.deps.delegate=async (_provider,req)=>{assert.equal(req.resume,'ses_abc');assert.equal(req.resumesUsed,2);assert.match(fs.readFileSync(req.promptPath,'utf8'),/Continue the task/);return {outcome:{status:'ok',text:'answer',sessionId:'ses_abc',resume:null},invocations:[]};};
    await fanOut({dir,slots:[slot('opencode')],prompt:'question',validate,quota},f.deps);
    assert.equal(fs.readFileSync(path.join(logs,'opencode[0].log.stalled'),'utf8'),'old log');
  } finally {f.cleanup();}
});

test('rerun starts fresh at the saved position after a failed resume', async () => {
  const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts'); const f=sessionFixture({memory:true}); try {
    const dir=path.join(f.session,'resume-fail'), logs=path.join(dir,'logs'); fs.mkdirSync(logs,{recursive:true});
    fs.writeFileSync(path.join(logs,'opencode[0].state.json'),JSON.stringify({physicalSlot:'opencode[0]',provider:'opencode',model:'good',position:{model:1,mode:0},pending:'stall',resumesUsed:1,reportResumes:0,sessionId:'ses_abc'}));
    const calls: {resume:string|null;model:string|null}[]=[];
    f.deps.delegate=async (_p,req)=>{calls.push({resume:req.resume,model:req.model}); if(req.resume)return {outcome:{status:'fail',cls:'auth',detail:'failed'},invocations:[]}; const state=JSON.parse(fs.readFileSync(path.join(logs,'opencode[0].state.json'),'utf8')); assert.match(state.restart,/failed cross-run resume/); return {outcome:{status:'ok',text:'answer',sessionId:'new',resume:null},invocations:[]};};
    await fanOut({dir,slots:[slot('opencode',['bad','good'])],prompt:'question',validate,quota},f.deps);
    assert.deepEqual(calls,[{resume:'ses_abc',model:'good'},{resume:null,model:'good'}]);
  } finally {f.cleanup();}
});

test('rerun starts fresh when a saved outcome needs a retake', async () => {
  const { fanOut } = await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  const f = sessionFixture({ memory: true });
  try {
    for (const outcome of [{ state: 'failed', cls: 'auth', reason: 'denied' }, { state: 'done', text: '' }]) {
      const dir = path.join(f.session, outcome.state);
      const logs = path.join(dir, 'logs'), slots = path.join(dir, 'slots');
      fs.mkdirSync(logs, { recursive: true });
      fs.mkdirSync(slots);
      fs.writeFileSync(path.join(slots, 'opencode[0].json'), JSON.stringify({ slot: 'opencode[0]', ...outcome }));
      const statePath = path.join(logs, 'opencode[0].state.json');
      fs.writeFileSync(statePath, JSON.stringify({ physicalSlot: 'opencode[0]', provider: 'opencode', model: 'second', position: { model: 1, mode: 0 }, pending: 'stall', resumesUsed: 1, reportResumes: 0, sessionId: 'old' }));
      const calls: { model: string | null; resume: string | null }[] = [];
      f.deps.delegate = async (_provider, req) => {
        calls.push({ model: req.model, resume: req.resume });
        return { outcome: { status: 'ok', text: 'answer', sessionId: 'new', resume: null }, invocations: [] };
      };
      await fanOut({ dir, slots: [slot('opencode', ['first', 'second'])], prompt: 'question', validate, quota }, f.deps);
      assert.deepEqual(calls, [{ model: 'first', resume: null }], outcome.state);
      assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).restart, 'saved outcome retake');
    }
  } finally { f.cleanup(); }
});

test('rerun starts fresh on stale slot state', async () => {
  const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts'); const f=sessionFixture({memory:true}); try {
    const dir=path.join(f.session,'stale'), logs=path.join(dir,'logs'); fs.mkdirSync(logs,{recursive:true});
    fs.writeFileSync(path.join(logs,'opencode[0].state.json'),JSON.stringify({physicalSlot:'other[0]',provider:'opencode',model:'good',position:{model:0,mode:0},pending:'stall',resumesUsed:1,reportResumes:0,sessionId:'old'}));
    fs.writeFileSync(path.join(logs,'opencode[0].log'),'previous');
    f.deps.delegate=async (_p,req)=>{assert.equal(req.resume,null);assert.match(JSON.parse(fs.readFileSync(path.join(logs,'opencode[0].state.json'),'utf8')).restart,/stale/);return {outcome:{status:'ok',text:'answer',sessionId:'new',resume:null},invocations:[]};};
    await fanOut({dir,slots:[slot('opencode')],prompt:'question',validate,quota},f.deps);
    assert.equal(fs.readFileSync(path.join(logs,'opencode[0].log.stalled'),'utf8'),'previous');
  } finally {f.cleanup();}
});

test('exit-only providers start fresh when interrupted logs have no session envelope', async () => {
  const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');
  for (const provider of ['claude','agy'] as const) {
    const f=sessionFixture({memory:true}); try {
      const dir=path.join(f.session,provider+'-exit-only'), logs=path.join(dir,'logs'); fs.mkdirSync(logs,{recursive:true});
      const statePath=path.join(logs,provider+'[0].state.json'), logPath=path.join(logs,provider+'[0].log');
      fs.writeFileSync(statePath,JSON.stringify({physicalSlot:provider+'[0]',provider,model:'second',position:{model:1,mode:0},pending:'stall',resumesUsed:1,reportResumes:0,sessionId:null}));
      fs.writeFileSync(logPath,'partial output without the exit envelope');
      const calls: {model:string|null;resume:string|null}[]=[];
      f.deps.delegate=async (_provider,req)=>{
        calls.push({model:req.model,resume:req.resume});
        return {outcome:{status:'ok',text:'answer',sessionId:'new-session',resume:null},invocations:[]};
      };
      await fanOut({dir,slots:[slot(provider,['first','second'])],prompt:'question',validate,quota},f.deps);
      assert.deepEqual(calls,[{model:'first',resume:null}],provider+' does not recover an ID from partial exit-only output');
      assert.equal(JSON.parse(fs.readFileSync(statePath,'utf8')).restart,'stale: no valid session ID');
      assert.equal(fs.readFileSync(logPath+'.stalled','utf8'),'partial output without the exit envelope');
    } finally {f.cleanup();}
  }
});

test('rerun resumes a pending report with the report prompt', async () => {
  const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts'); const f=sessionFixture({memory:true}); try {
    const dir=path.join(f.session,'report'), logs=path.join(dir,'logs'), prompts=path.join(dir,'prompts'); fs.mkdirSync(logs,{recursive:true}); fs.mkdirSync(prompts,{recursive:true});
    fs.writeFileSync(path.join(prompts,'opencode[0].no-report.md'),'report prompt');
    fs.writeFileSync(path.join(logs,'opencode[0].state.json'),JSON.stringify({physicalSlot:'opencode[0]',provider:'opencode',model:'good',position:{model:0,mode:0},pending:'report',resumesUsed:1,reportResumes:1,sessionId:'ses_abc'}));
    f.deps.delegate=async (_p,req)=>{assert.equal(req.resume,'ses_abc');assert.equal(req.resumesUsed,1);assert.equal(fs.readFileSync(req.promptPath,'utf8'),'report prompt');return {outcome:{status:'ok',text:'answer',sessionId:'ses_abc',resume:null},invocations:[]};};
    await fanOut({dir,slots:[slot('opencode')],prompt:'question',validate,quota},f.deps);
  } finally {f.cleanup();}
});

test('rerun starts fresh after an interrupted fresh launch checkpoint', async () => {
  const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts'); const f=sessionFixture({memory:true}); try {
    const dir=path.join(f.session,'boundary'), logs=path.join(dir,'logs'); fs.mkdirSync(logs,{recursive:true});
    fs.writeFileSync(path.join(logs,'opencode[0].log'),'{"type":"step_start","sessionID":"old_session"}\n');
    let first=true;
    f.deps.delegate=async (_p,req)=>{if(first){first=false;assert.equal(req.resume,null);assert.equal(fs.readFileSync(req.logPath,'utf8'),'');throw new Error('interrupted');}assert.equal(req.resume,null);return {outcome:{status:'ok',text:'answer',sessionId:'new',resume:null},invocations:[]};};
    const input={dir,slots:[slot('opencode')],prompt:'question',validate,quota};
    await assert.rejects(fanOut(input,f.deps),/interrupted/); await fanOut(input,f.deps);
    assert.match(fs.readFileSync(path.join(logs,'opencode[0].log.stalled'),'utf8'),/old_session/);
  } finally {f.cleanup();}
});

test('rerun resumes with the continue prompt after a stall inside a report resume', async () => {
  const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts'); const f=sessionFixture({memory:true}); try {
    const dir=path.join(f.session,'report-stall'); let call=0;
    f.deps.delegate=async (_p,req)=>{call++; if(call===1)return {outcome:{status:'ok',text:'invalid',sessionId:'ses_abc',resume:null},invocations:[]}; if(call===2){assert.match(req.promptPath,/no-report/);req.onResume?.('ses_abc',1);fs.writeFileSync(req.logPath,'stall log');throw new Error('interrupted');} assert.equal(req.resume,'ses_abc');assert.equal(req.resumesUsed,2);assert.match(fs.readFileSync(req.promptPath,'utf8'),/Continue the task/);return {outcome:{status:'ok',text:'answer',sessionId:'ses_abc',resume:null},invocations:[]};};
    const check=(text:string):Validation=>text==='invalid'?{ok:false,cls:'no-report',reason:'missing'}:validate(text);
    const input={dir,slots:[slot('opencode')],prompt:'question',validate:check,quota};
    await assert.rejects(fanOut(input,f.deps),/interrupted/); await fanOut(input,f.deps);assert.equal(call,3);
  } finally {f.cleanup();}
});

test('rerun starts fresh after a failed resume checkpoint', async t => {
  const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts'); const f=sessionFixture({memory:true}); try {
    const dir=path.join(f.session,'checkpoint'), log=path.join(dir,'logs','opencode[0].log'), state=log.replace(/\.log$/,'.state.json'); let fail=false;
    const rename=fs.renameSync;t.mock.method(fs,'renameSync',((from:fs.PathLike,to:fs.PathLike)=>{if(fail && String(to)===state){fail=false;throw new Error('write failure');}return rename(from,to);}) as typeof fs.renameSync);
    let first=true;f.deps.delegate=async (_p,req)=>{if(first){first=false;fs.writeFileSync(req.logPath,'leftover');fail=true;req.onResume?.('ses_abc',1);throw new Error('interrupted');}assert.equal(req.resume,null);return {outcome:{status:'ok',text:'answer',sessionId:'new',resume:null},invocations:[]};};
    const input={dir,slots:[slot('opencode')],prompt:'question',validate,quota};
    await assert.rejects(fanOut(input,f.deps),/interrupted/);assert.equal(fs.existsSync(state),false);await fanOut(input,f.deps);assert.equal(fs.readFileSync(log+'.stalled','utf8'),'leftover');
  } finally {f.cleanup();}
});

test('rerun starts fresh after a failed usage checkpoint', async t => {
  const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts'); const f=sessionFixture({memory:true}); try {
    const dir=path.join(f.session,'usage-checkpoint'), log=path.join(dir,'logs','codex[0].log'), state=log.replace(/\.log$/,'.state.json'); let fail=false;
    const rename=fs.renameSync;t.mock.method(fs,'renameSync',((from:fs.PathLike,to:fs.PathLike)=>{if(fail && String(to)===state){fail=false;throw new Error('write failure');}return rename(from,to);}) as typeof fs.renameSync);
    const row={provider:'codex' as const,model:'good',mode:'cli' as const,effort:null,launched:true,outcome:'ok',usage:{input:10,output:2,scope:'invocation' as const,provenance:'test',inputSemantics:'uncached' as const}};
    let first=true;f.deps.delegate=async (_p,req)=>{if(first){first=false;fs.writeFileSync(req.logPath,'leftover');fail=true;req.onInvocation?.(row);throw new Error('interrupted');}assert.equal(req.resume,null);assert.equal(req.priorUsage,undefined);return {outcome:{status:'ok',text:'answer',sessionId:'new',resume:null},invocations:[]};};
    const input={dir,slots:[slot('codex')],prompt:'question',validate,quota};
    await assert.rejects(fanOut(input,f.deps),/interrupted/);assert.equal(fs.existsSync(state),false);await fanOut(input,f.deps);assert.equal(fs.readFileSync(log+'.stalled','utf8'),'leftover');
  } finally {f.cleanup();}
});

test('rerun resumes without counting saved session usage twice', async () => {
  const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts'); const f=sessionFixture({memory:true}); try {
    const dir=path.join(f.session,'usage-resume'), logs=path.join(dir,'logs');fs.mkdirSync(logs,{recursive:true});
    const usage={input:10,output:2,scope:'invocation' as const,provenance:'test',inputSemantics:'uncached' as const};
    fs.writeFileSync(path.join(logs,'codex[0].state.json'),JSON.stringify({physicalSlot:'codex[0]',provider:'codex',model:'good',position:{model:0,mode:0},pending:'stall',resumesUsed:0,reportResumes:0,sessionId:'thread_abc',sessionUsage:usage}));
    const row1={provider:'codex' as const,model:'good',mode:'cli' as const,effort:null,launched:true,outcome:'ok',usage:{...usage,input:3}};
    const row2={...row1,usage:{...usage,input:5}};
    let calls=0;f.deps.delegate=async (_p,req)=>{calls++;if(calls===1){assert.equal(req.priorUsage?.input,10);req.onInvocation?.(row2);return {outcome:{status:'ok',text:'invalid',sessionId:'thread_abc',resume:null},invocations:[row1,row2]};}assert.equal(req.priorUsage?.input,18);return {outcome:{status:'ok',text:'answer',sessionId:'thread_abc',resume:null},invocations:[]};};
    const check=(text:string):Validation=>text==='invalid'?{ok:false,cls:'no-report',reason:'missing'}:validate(text);
    await fanOut({dir,slots:[slot('codex')],prompt:'question',validate:check,quota},f.deps);assert.equal(calls,2);
  } finally {f.cleanup();}
});

test('rerun starts fresh at the saved position after a thrown resume launch', async () => {
  const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts'); const f=sessionFixture({memory:true}); try {
    const dir=path.join(f.session,'throw-resume'), logs=path.join(dir,'logs');fs.mkdirSync(logs,{recursive:true});
    fs.writeFileSync(path.join(logs,'opencode[0].state.json'),JSON.stringify({physicalSlot:'opencode[0]',provider:'opencode',model:'good',position:{model:1,mode:0},pending:'stall',resumesUsed:0,reportResumes:0,sessionId:'ses_abc'}));
    let calls=0;f.deps.delegate=async (_p,req)=>{calls++;assert.equal(req.model,'good');if(req.resume)throw new Error('spawn');assert.match(JSON.parse(fs.readFileSync(path.join(logs,'opencode[0].state.json'),'utf8')).restart,/launch error/);return {outcome:{status:'ok',text:'answer',sessionId:'new',resume:null},invocations:[]};};
    await fanOut({dir,slots:[slot('opencode',['bad','good'])],prompt:'question',validate,quota},f.deps);assert.equal(calls,2);
  } finally {f.cleanup();}
});

test('rerun resumes after a later call replaces a failed checkpoint', async t => {
  const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts'); const f=sessionFixture({memory:true}); try {
    const dir=path.join(f.session,'later-checkpoint'),state=path.join(dir,'logs','opencode[0].state.json');let fail=false;
    const rename=fs.renameSync;t.mock.method(fs,'renameSync',((from:fs.PathLike,to:fs.PathLike)=>{if(fail && String(to)===state){fail=false;throw new Error('write failure');}return rename(from,to);}) as typeof fs.renameSync);
    let calls=0;f.deps.delegate=async (_p,req)=>{calls++;if(calls===1){fail=true;req.onResume?.('ses_abc',1);return {outcome:{status:'ok',text:'invalid',sessionId:'ses_abc',resume:null},invocations:[]};}if(calls===2){assert.equal(JSON.parse(fs.readFileSync(state,'utf8')).pending,'report');throw new Error('interrupted');}assert.equal(req.resume,'ses_abc');return {outcome:{status:'ok',text:'answer',sessionId:'ses_abc',resume:null},invocations:[]};};
    const check=(text:string):Validation=>text==='invalid'?{ok:false,cls:'no-report',reason:'missing'}:validate(text);
    const input={dir,slots:[slot('opencode')],prompt:'question',validate:check,quota};await assert.rejects(fanOut(input,f.deps),/interrupted/);await fanOut(input,f.deps);assert.equal(calls,3);
  } finally {f.cleanup();}
});

test('rerun resumes with the resumes spent before the stop', async () => {
  const {fanOut}=await import('../../../skills/dispatch/scripts/toolkit/fanout.ts');const f=sessionFixture({memory:true});try {
    const dir=path.join(f.session,'log-session'),logs=path.join(dir,'logs');fs.mkdirSync(logs,{recursive:true});
    fs.writeFileSync(path.join(logs,'opencode[0].state.json'),JSON.stringify({physicalSlot:'opencode[0]',provider:'opencode',model:'good',position:{model:0,mode:0},pending:'stall',resumesUsed:2,reportResumes:0,sessionId:null}));
    fs.writeFileSync(path.join(logs,'opencode[0].log'),'{"type":"step_start","sessionID":"ses_abc"}\n');
    f.deps.delegate=async (_p,req)=>{assert.equal(req.resume,'ses_abc');assert.equal(req.resumesUsed,3);return {outcome:{status:'ok',text:'answer',sessionId:'ses_abc',resume:null},invocations:[]};};
    await fanOut({dir,slots:[slot('opencode')],prompt:'question',validate,quota},f.deps);
  }finally{f.cleanup();}
});
