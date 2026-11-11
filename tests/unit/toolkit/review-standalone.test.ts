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

test('plan and design review rounds update the bound findings section', async () => {
  const f = await fixture();
  const writeAtomic = nodeLinkFs.writeAtomic;
  nodeLinkFs.writeAtomic = (file, text) => fs.writeFileSync(file, text);
  try {
    const design = f.artifact('strategy.design.md', '# Strategy\n## Boundaries\nA boundary.\n## Review Findings & Resolutions\nDriver notes.\n');
    f.artifact('strategy.design.context.md', CONTEXT_MAP);
    await f.add('bind', { spec: 'mission.spec.md', plan: 'work.plan.md', design: 'strategy.design.md' });
    for (const [kind, target, review] of [
      ['plan', f.plan, 'plan-work.plan'],
      ['design', design, 'design-strategy.design'],
    ] as const) {
      const first = await f.call(kind, target);
      assert.equal(first.exit, 0, JSON.stringify(first));
      assert.equal(first.value.findingsSection, 'updated', JSON.stringify(first.value));
      assert.match(fs.readFileSync(target, 'utf8'), new RegExp(`Round 1 \\(${review}\\): 1 findings`));

      fs.appendFileSync(target, '\n## Follow-up\nChanged for round two.\n');
      const second = await f.call(kind, target);
      assert.equal(second.exit, 0, JSON.stringify(second));
      assert.equal(second.value.findingsSection, 'updated');
      const source = fs.readFileSync(target, 'utf8');
      assert.match(source, new RegExp(`Round 1 \\(${review}\\): 1 findings`));
      assert.match(source, new RegExp(`Round 2 \\(${review}\\): 1 findings`));
    }
  } finally { nodeLinkFs.writeAtomic = writeAtomic; f.cleanup(); }
});

test('standalone review targets accept spec overrides and stable Git snapshots',async()=>{
  const ACCEPTED='code targets are integration, a bound-plan task ID, worktree, <a>..<b> or <rev>';
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
      const exit=await main(['review','run',target,'--kind',kind,'--level','medium','--session',f.session,'--host','codex',...(spec===null?[]:['--spec',spec])],f.deps);
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
    f.artifact('strategy.design.context.md',CONTEXT_MAP);
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
    const unresolved=await call('code','T1');assert.equal(unresolved.output.reason,'invalid-input');assert.equal(unresolved.output.summary,'Cannot resolve revision T1; '+ACCEPTED);
    f.lines.length=0;assert.equal(await main(['review','run','--session',f.session,'--host','codex'],f.deps),1);assert.equal(f.output().reason,'invalid-input');assert.equal(f.output().summary,'One review target is required: '+ACCEPTED+'; plan and design targets are artifact paths');
    unrelated=true;const orphan=await call('code','orphan');assert.equal(orphan.output.reason,'invalid-input');assert.match(orphan.output.summary,/common ancestor/);unrelated=false;
    missing=true;const headUnresolved=await call('code','worktree');assert.equal(headUnresolved.output.reason,'invalid-input');assert.equal(headUnresolved.output.summary,'Cannot resolve revision HEAD; '+ACCEPTED);missing=false;
    assert.equal((await call('plan',f.plan,'absent.spec.md')).output.reason,'invalid-input');
    const noSpec=await call('plan',f.plan,null);assert.equal(noSpec.exit,4);assert.equal(noSpec.output.reason,'lint-errors');
    await f.add('bind',{spec:'mission.spec.md',plan:'work.plan.md'});
    const override=f.artifact('override.spec.md','# Override\n## Requirements\n### REQ-1 — Override\n');
    await f.confirm(override);
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
    const exit=await main(['review','run','main...feature','--kind','code','--spec',f.spec,'--session',f.session,'--host','opencode'],f.deps);
    const output=f.output();assert.equal(exit,1);assert.equal(output.reason,'invalid-input');
    assert.match(output.summary,/three-dot.*not supported.*a\.\.b/i);
  }finally{f.cleanup();}
});

test('design-stage review binds its spec and preserves an in-place revision without a plan', async () => {
  const f = await fixture(false);
  try {
    const design = f.artifact('strategy.design.md', '# Strategy\n## Approach\nOne boundary.\n');
    f.artifact('strategy.design.context.md', CONTEXT_MAP);
    await f.add('bind', {spec: 'mission.spec.md', design: 'strategy.design.md'});
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: CLEAN, resume: null, sessionId: null}, invocations: []});
    assert.equal((await f.call('design', design)).exit, 0);
    const before = artifactHash('design', fs.readFileSync(design, 'utf8'));
    fs.appendFileSync(design, '\n## Risks\nRetain the original boundary.\n');
    await f.add('edit', {artifact: 'design', before, after: artifactHash('design', fs.readFileSync(design, 'utf8')),
      class: 'non-intent', affects: [], rationale: 'Clarify risk', diffRef: 'design diff'});
    assert.equal((await f.call('design', design)).exit, 0);
    assert.equal(foldLedger(f.session).records.filter(row => row.kind === 'edit').length, 1);
  } finally {f.cleanup();}
});

