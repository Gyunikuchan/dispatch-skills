import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {toolkitRepo,planSource} from './helpers/toolkit-repo.ts';
import {appendRecord,foldLedger} from '../../skills/dispatch/scripts/toolkit/ledger.ts';
import { CLEAN } from '../helpers/e2e.ts';
import crypto from 'node:crypto';

test('pending MUST rejection keeps captured Git confirmation identity across native retry and target movement',async()=>{
 const f=await toolkitRepo();try {
  const skill=path.join(f.session,'confirmation-skill');fs.mkdirSync(skill);fs.cpSync(path.join(f.deps.skillRoot,'references'),path.join(skill,'references'),{recursive:true});
  fs.writeFileSync(path.join(skill,'config.jsonc'),JSON.stringify({'read-delegates':{codex:{nativeSubagentsOnly:true,targets:[{low:{model:'native'}}]}},phases:{'code-review':{targets:{low:1},rounds:{low:1}}}}));
  f.deps.skillRoot=skill;f.deps.orchestrator={platform:'codex',model:'native'};f.deps.liveness={};
  fs.writeFileSync(path.join(f.root,'src/file.ts'),'first captured change\n');
  const run=()=>f.run(['review','run','worktree','--kind','code','--spec','work.spec.md','--level','low']);
  const first=await run();assert.equal(first.output.reason,'native-pending');
  fs.writeFileSync(first.value.pending[0].replyPath,JSON.stringify({status:'FINDINGS',findings:[{severity:'MUST',tag:'correctness',locus:'src/file.ts:L1',defect:'Writes are unbounded',requiredChange:'Bound the writes'}]}));
  const finding=await run();assert.equal(finding.exit,0);const saved=JSON.parse(fs.readFileSync(finding.value.path,'utf8'));
  await appendRecord(f.session,{kind:'ruling',by:'orchestrator',key:'reject-captured',data:{subject:'review:'+saved.review+':R1-F001',ruling:'rejected',rationale:'Captured writes have a bound'}},f.deps);
  const second=await run();assert.equal(second.output.reason,'native-pending');
  const oldPrompt=fs.readFileSync(second.value.pending[0].promptPath,'utf8'),oldId=/Request ID: `([^`]+)`/.exec(oldPrompt)![1]!;
  fs.writeFileSync(second.value.pending[0].replyPath,JSON.stringify({status:'CLEAN',findings:[],confirmations:[{requestId:oldId,decision:'agree',rationale:'The captured writes have a bound'}]}));
  fs.writeFileSync(path.join(f.root,'src/file.ts'),'new captured change\n');
  const moved=await run();assert.equal(moved.output.reason,'native-pending');
  const freshPrompt=fs.readFileSync(moved.value.pending[0].promptPath,'utf8'),freshId=/Request ID: `([^`]+)`/.exec(freshPrompt)![1]!;assert.notEqual(freshId,oldId);
  assert.equal(fs.existsSync(path.join(path.dirname(finding.value.path),'../round-2/findings.json')),false);
  fs.writeFileSync(moved.value.pending[0].replyPath,JSON.stringify({status:'CLEAN',findings:[],confirmations:[{requestId:freshId,decision:'agree',rationale:'The new captured writes also have a bound'}]}));
  const confirmed=await run();assert.equal(confirmed.exit,0,JSON.stringify(confirmed));assert.equal(JSON.parse(fs.readFileSync(confirmed.value.path,'utf8')).confirmations[0].responder.native,true);
  assert.equal((await run()).output.reason,'round-cap');
 }finally{f.cleanup();}
});

test('toolkit worktree review excludes unignored session state and preserves committed session blobs', async () => {
  const f = await toolkitRepo();
  try {
    fs.writeFileSync(path.join(f.root, '.gitignore'), '');
    fs.writeFileSync(path.join(f.session, 'tracked.txt'), 'committed session bytes\n');
    f.git(['add', '.']); f.git(['commit', '-qm', 'tracked session']);
    fs.writeFileSync(path.join(f.session, 'tracked.txt'), 'changed session bytes\n');
    fs.writeFileSync(path.join(f.session, 'untracked.txt'), 'untracked session bytes\n');
    fs.writeFileSync(path.join(f.root, 'src/file.ts'), 'changed code\n');
    const skill = path.join(f.session, 'native-skill');
    fs.mkdirSync(skill); fs.cpSync(path.join(f.deps.skillRoot, 'references'), path.join(skill, 'references'), { recursive: true });
    fs.writeFileSync(path.join(skill, 'config.jsonc'), JSON.stringify({ 'read-delegates': { codex: { nativeSubagentsOnly: true, targets: [{ low: { model: 'native' } }] } }, phases: { 'code-review': { targets: { low: 1 }, rounds: { low: 2 } } } }));
    f.deps.skillRoot = skill;
    f.deps.orchestrator = { platform: 'codex', model: 'native' } as typeof f.deps.orchestrator;
    f.deps.liveness = {};
    const run = async (expected: number) => {
      const result = await f.run(['review', 'run', 'worktree', '--kind', 'code', '--spec', 'work.spec.md', '--level', 'low']);
      assert.equal(result.exit, expected, JSON.stringify(result.output));
      for (const key of ['v', 'run', 'reply', 'await', 'at']) assert.equal(Object.hasOwn(result.output, key), false, key);
      return result;
    };
    const pending = await run(4);
    assert.equal(pending.output.reason, 'native-pending');
    assert.equal(pending.value.pending.length, 1);
    const slug = 'code-worktree-' + crypto.createHash('sha256').update('worktree@' + f.git(['rev-parse', 'HEAD']).trim()).digest('hex');
    const metadata = path.join(f.session, '.state/reviews', slug, 'round-1/round.json');
    const before = JSON.parse(fs.readFileSync(metadata, 'utf8'));
    for (const slot of pending.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const clean = await run(0);
    assert.deepEqual(JSON.parse(fs.readFileSync(clean.value.path, 'utf8')).findings, []);
    const after = JSON.parse(fs.readFileSync(metadata, 'utf8'));
    assert.equal(after.target.head, before.target.head);
    const changed = f.git(['diff', '--name-only', before.target.base + '..' + before.target.head]).split(/\r?\n/);
    assert.ok(changed.includes('src/file.ts'));
    assert.equal(changed.some(file => file.startsWith(path.basename(f.session) + '/')), false);
    assert.equal(f.git(['diff', '--name-only', before.target.base + '..' + before.target.head, '--', path.basename(f.session)]), '');
    assert.equal(f.git(['show', before.target.head + ':' + path.basename(f.session) + '/tracked.txt']), 'committed session bytes');
    assert.equal(fs.readFileSync(path.join(f.session, 'tracked.txt'), 'utf8'), 'changed session bytes\n');
    assert.equal(fs.readFileSync(path.join(f.session, 'untracked.txt'), 'utf8'), 'untracked session bytes\n');
    f.git(['add', 'src/file.ts']); f.git(['commit', '-qm', 'reviewed change']);
    fs.writeFileSync(path.join(f.root, 'src/file.ts'), 'next change\n');
    assert.equal((await run(4)).output.reason, 'native-pending');
    const next = 'code-worktree-' + crypto.createHash('sha256').update('worktree@' + f.git(['rev-parse', 'HEAD']).trim()).digest('hex');
    assert.equal(fs.existsSync(path.join(f.session, '.state/reviews', next, 'round-1/round.json')), true);
    assert.equal(fs.existsSync(path.join(f.session, '.state/reviews', slug, 'round-2')), false);
  } finally { f.cleanup(); }
});

test('toolkit worktree review snapshots a gitignored session without failing on its exclusion', async () => {
  const f = await toolkitRepo();
  try {
    const top = path.relative(f.root, f.session).split(path.sep)[0]!;
    fs.writeFileSync(path.join(f.root, '.gitignore'), top + '/\n');
    fs.writeFileSync(path.join(f.session, 'tracked.txt'), 'committed session bytes\n');
    fs.writeFileSync(path.join(f.session, 'deleted.txt'), 'deleted session bytes\n');
    f.git(['add', '.gitignore']); f.git(['add', '-f', '--', path.relative(f.root, f.session)]); f.git(['commit', '-qm', 'ignore session']);
    fs.writeFileSync(path.join(f.session, 'tracked.txt'), 'changed session bytes\n');
    fs.rmSync(path.join(f.session, 'deleted.txt'));
    fs.writeFileSync(path.join(f.root, 'src/file.ts'), 'changed code\n');
    const skill = path.join(f.session, 'native-skill');
    fs.mkdirSync(skill); fs.cpSync(path.join(f.deps.skillRoot, 'references'), path.join(skill, 'references'), { recursive: true });
    fs.writeFileSync(path.join(skill, 'config.jsonc'), JSON.stringify({ 'read-delegates': { codex: { nativeSubagentsOnly: true, targets: [{ low: { model: 'native' } }] } }, phases: { 'code-review': { targets: { low: 1 }, rounds: { low: 2 } } } }));
    f.deps.skillRoot = skill;
    f.deps.orchestrator = { platform: 'codex', model: 'native' } as typeof f.deps.orchestrator;
    f.deps.liveness = {};
    const result = await f.run(['review', 'run', 'worktree', '--kind', 'code', '--spec', 'work.spec.md', '--level', 'low']);
    assert.equal(result.output.reason, 'native-pending', JSON.stringify(result.output));
    const slug = 'code-worktree-' + crypto.createHash('sha256').update('worktree@' + f.git(['rev-parse', 'HEAD']).trim()).digest('hex');
    const target = JSON.parse(fs.readFileSync(path.join(f.session, '.state/reviews', slug, 'round-1/round.json'), 'utf8')).target;
    assert.deepEqual(f.git(['diff', '--name-only', target.base + '..' + target.head]).split(/\r?\n/), ['src/file.ts']);
    assert.equal(f.git(['show', target.head + ':' + path.relative(f.root, f.session).split(path.sep).join('/') + '/tracked.txt']), 'committed session bytes');
  } finally { f.cleanup(); }
});

const source=planSource.replace('  - Changes: src/file.ts','  - Changes: src/file.ts, tests/file.test.ts').replace('  - Evidence: verify','  - Tests: tests/file.test.ts\n  - RED: `node --test tests/file.test.ts`\n  - Evidence: red');
test('toolkit code review reports missing evidence without admission gates and tracks changed targets',async()=>{
    const f=await toolkitRepo(source.replace('## Success Criteria','#### [MODIFY] tests/file.test.ts\n- Purpose: tests behavior.\n\n## Success Criteria')); try {
    const skill=path.join(f.session,'skill'); fs.mkdirSync(path.join(skill,'references/templates'),{recursive:true});
    fs.cpSync(path.join(f.deps.skillRoot,'references'),path.join(skill,'references'),{recursive:true});
    for(const file of ['review-prompt.md','review-prompt-code.md','quality-bar.md'])fs.copyFileSync(path.join(f.deps.skillRoot,'references/templates',file),path.join(skill,'references/templates',file));
    fs.writeFileSync(path.join(skill,'config.jsonc'),JSON.stringify({'read-delegates':{claude:{targets:[{low:{model:'fake'}}]}},phases:{'code-review':{targets:{low:1},rounds:{low:3}}}}));
    f.deps.skillRoot=skill; f.deps.liveness={claude:true};f.deps.orchestrator=null;
    const prompts:string[]=[];
    f.deps.delegate=async(_provider,request)=>{prompts.push(fs.readFileSync(request.promptPath,'utf8'));return {outcome:{status:'ok',text:JSON.stringify({status:'CLEAN',findings:[]}),resume:null,sessionId:null},invocations:[]};};
    await f.level('medium');await f.approve();
    assert.equal((await f.run(['review','run','unknown','--kind','code'])).output.reason,'invalid-input');
    assert.equal((await f.run(['review','run','integration','--kind','code'])).output.reason,'nothing-to-review');
    const launch=async(text:string)=>{
      const made=await f.run(['worktree','create','T1']); assert.equal(made.exit,0,JSON.stringify(made.output));
      assert.equal((await f.run(['brief','render','T1'])).exit,0);
      fs.writeFileSync(path.resolve(f.session,made.value.path,'src/file.ts'),text);
      assert.equal((await f.run(['worktree','submit','T1'])).exit,0);
      return foldLedger(f.session).records.findLast(row=>row.kind==='writer'&&row.data['phase']==='finished')!.data['candidate'];
    };
    const head=await launch('first\n');assert.equal((await f.run(['worktree','integrate','T1'])).exit,0);
    const review=async(target='T1')=>{const r=await f.run(['review','run',target,'--kind','code']);assert.equal(r.exit,0,JSON.stringify(r.output));return JSON.parse(fs.readFileSync(r.value.path,'utf8'));};
    const first=await review(); assert.equal(first.findings.length,1);const gap=first.findings[0];
    assert.match(gap.defect,/missing-red: T1 SC1; Tests touched: no/);assert.equal(gap.category,'testing');assert.match(gap.locus,/work.plan.md:L\d+$/);
    const metadata=JSON.parse(fs.readFileSync(path.join(f.session,'.state/reviews/code-T1/round-1/round.json'),'utf8'));
    assert.equal(metadata.target.head,head);assert.ok(prompts[0]!.includes('comparison: '+metadata.target.base+'..'+head));
    const unchanged=await review();assert.deepEqual(unchanged.findings[0].unresolved,{of:gap.id});assert.equal(unchanged.escalations.length,0);
    await f.level('high');
    const next=await launch('second\n'); const third=await review();assert.equal(third.escalations[0].key,'missing-red:code-T1:T1:SC1:R3:g1');
    assert.ok(prompts.at(-1)!.includes('comparison: '+head+'..'+next));assert.ok(prompts.at(-1)!.includes('src/file.ts'));
    const integrated=await review('integration');assert.equal(integrated.findings.length,1);assert.ok(prompts.at(-1)!.includes('Integrated tasks: T1'));
    const integrationTarget=JSON.parse(fs.readFileSync(path.join(f.session,'.state/reviews/code-integration/round-1/round.json'),'utf8')).target;
    assert.ok(prompts.at(-1)!.includes('comparison: '+integrationTarget.base+'..'+integrationTarget.head));
    let moved=false;const result=await f.run(['review','run','integration','--kind','code'],async point=>{if(point==='fanout:after-slot'&&!moved){moved=true;fs.writeFileSync(path.join(f.integration,'src/file.ts'),'fix\n');assert.equal((await f.run(['worktree','commit','--reason','fix'])).exit,0);}});
    assert.equal(result.output.reason,'target-moved');assert.equal(fs.existsSync(path.join(f.session,'.state/reviews/code-integration/round-2/findings.json')),false);
  }finally{f.cleanup();}
});

test('toolkit code review follows new task launches and escalates each repeated changed gap',async()=>{
  for(const moveDuringReview of [false,true]){
  const f=await toolkitRepo(source.replace('## Success Criteria','#### [MODIFY] tests/file.test.ts\n- Purpose: tests behavior.\n\n## Success Criteria'));try{
    const skill=path.join(f.session,'skill');fs.mkdirSync(skill);fs.cpSync(path.join(f.deps.skillRoot,'references'),path.join(skill,'references'),{recursive:true});f.deps.skillRoot=skill;
    fs.writeFileSync(path.join(skill,'config.jsonc'),JSON.stringify({'read-delegates':{claude:{targets:[{low:{model:'fake'}}]}},phases:{'code-review':{targets:{low:1},rounds:{low:3}}}}));
    f.deps.liveness={claude:true};f.deps.orchestrator=null;
    f.deps.delegate=async()=>({outcome:{status:'ok',text:JSON.stringify({status:'CLEAN',findings:[]}),resume:null,sessionId:null},invocations:[]});
    await f.level('high');await f.approve();
    const launch=async(text:string)=>{
      const made=await f.run(['worktree','create','T1']);assert.equal(made.exit,0,JSON.stringify(made.output));fs.writeFileSync(path.resolve(f.session,made.value.path,'src/file.ts'),text);
      assert.equal((await f.run(['worktree','submit','T1'])).exit,0);assert.equal((await f.run(['worktree','integrate','T1'])).exit,0);
      return foldLedger(f.session).records.findLast(row=>row.kind==='writer'&&row.data['phase']==='finished')!.data['candidate'];
    };
    const review=()=>f.run(['review','run','T1','--kind','code']);
    await launch('first\n');const first=await review();assert.equal(first.exit,0);
    await launch('second\n');
    let moved=false,newHead='';
    let second;
    const directory=path.join(f.session,'.state/reviews/code-T1/round-2');
    if(moveDuringReview){
      const moving=await f.run(['review','run','T1','--kind','code'],async point=>{if(point==='fanout:after-slot'&&!moved){moved=true;newHead=await launch('third\n');}});
      assert.equal(moving.output.reason,'target-moved');
      assert.equal(fs.existsSync(path.join(directory,'findings.json')),false);
    }
    second=await review();assert.equal(second.exit,0);
    const value=JSON.parse(fs.readFileSync(second.value.path,'utf8'));
    assert.equal(value.escalations[0].key,'missing-red:code-T1:T1:SC1:R2:g'+(moveDuringReview?2:1));
    if(moveDuringReview)assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'round.json'),'utf8')).target.head,newHead);
    await launch('fourth\n');const third=await review();assert.equal(third.exit,0);
    assert.equal(JSON.parse(fs.readFileSync(third.value.path,'utf8')).escalations[0].key,'missing-red:code-T1:T1:SC1:R3:g1');
  }finally{f.cleanup();}
  }
});

test('toolkit code review scopes integration recurrence and gaps to committed owner changes',async()=>{
  const two=source.replace('| T1 | File | Works | none | SC1 |','| T1 | File | Works | none | SC1 |\n| T2 | Other | Works | none | SC2 |')
    .replace('## Success Criteria','#### [MODIFY] tests/file.test.ts\n### T2 — Other\n#### [MODIFY] src/other.ts\n- Purpose: independent behavior.\n## Success Criteria')
    .replace('## Verification Plan','- [SC2] Other works\n  - Changes: src/other.ts\n  - Verify: `node -e "process.exit(0)"`\n  - Evidence: verify\n## Verification Plan');
  for(const fixOwner of [false,true]) {
    const f=await toolkitRepo(two,{'src/other.ts':'initial\n'});try{
      const skill=path.join(f.session,'skill');fs.mkdirSync(skill);fs.cpSync(path.join(f.deps.skillRoot,'references'),path.join(skill,'references'),{recursive:true});f.deps.skillRoot=skill;
      fs.writeFileSync(path.join(skill,'config.jsonc'),JSON.stringify({'read-delegates':{claude:{targets:[{low:{model:'fake'}}]}},phases:{'code-review':{targets:{low:1},rounds:{low:3}}}}));
      f.deps.liveness={claude:true};f.deps.orchestrator=null;
      f.deps.delegate=async()=>({outcome:{status:'ok',text:JSON.stringify({status:'FINDINGS',findings:[{severity:'SHOULD',tag:'correctness',locus:'src/file.ts:L1',defect:'The file returns an invalid result',requiredChange:'Return the expected result'}]}),resume:null,sessionId:null},invocations:[]});
      await f.level('high');await f.approve();
      const submit=async(task:string,file:string)=>{
        const made=await f.run(['worktree','create',task]);assert.equal(made.exit,0,JSON.stringify(made.output));
        fs.writeFileSync(path.resolve(f.session,made.value.path,file),'changed\n');
        assert.equal((await f.run(['worktree','submit',task])).exit,0);
        assert.equal((await f.run(['worktree','integrate',task])).exit,0);
      };
      await submit('T1','src/file.ts');
      const review=async()=>{const r=await f.run(['review','run','integration','--kind','code']);assert.equal(r.exit,0,JSON.stringify(r.output));return JSON.parse(fs.readFileSync(r.value.path,'utf8'));};
      const first=await review();
      await appendRecord(f.session,{kind:'ruling',key:'accepted',by:'orchestrator',data:{subject:'review:code-integration:'+first.findings[0].id,ruling:'accepted',rationale:'Fix accepted'}},f.deps);
      if(fixOwner){
        fs.writeFileSync(path.join(f.integration,'src/file.ts'),'attempted fix\n');assert.equal((await f.run(['worktree','commit','--reason','fix'])).exit,0);
      }else{
        await submit('T2','src/other.ts');
        fs.writeFileSync(path.join(f.integration,'src/file.ts'),'uncommitted attempted fix\n');
        fs.mkdirSync(path.join(f.integration,'tests'),{recursive:true});
        fs.writeFileSync(path.join(f.integration,'tests/file.test.ts'),'untracked test\n');
      }
      const second=await review(),finding=second.findings.find((finding:any)=>finding.id==='R2-F001');
      if(fixOwner){
        assert.deepEqual(finding.recurrence,{of:first.findings[0].id});assert.equal(second.escalations.filter((row:any)=>row.key.startsWith('recurrence:')).length,1);
        fs.mkdirSync(path.join(f.session,'.state/briefs'),{recursive:true});
        fs.writeFileSync(path.join(f.session,'.state/briefs/T1-1.report.md'),'## Observed RED failures\nSC1 failed before the fix\n');
        assert.equal((await review()).findings.filter((finding:any)=>finding.defect.startsWith('missing-red:')).length,0);
      }
      else{assert.deepEqual(finding.unresolved,{of:first.findings[0].id});assert.equal(second.escalations.length,0);const gap=second.findings.find((finding:any)=>finding.id==='R2-RED01');assert.ok(gap.unresolved);assert.match(gap.defect,/Tests touched: no$/);}
    }finally{f.cleanup();}
  }
});

test('rejected missing-red ruling settles later rounds after the target moves',async()=>{
  const f=await toolkitRepo(source.replace('## Success Criteria','#### [MODIFY] tests/file.test.ts\n- Purpose: tests behavior.\n\n## Success Criteria'));try{
    const skill=path.join(f.session,'skill');fs.mkdirSync(skill);fs.cpSync(path.join(f.deps.skillRoot,'references'),path.join(skill,'references'),{recursive:true});
    fs.writeFileSync(path.join(skill,'config.jsonc'),JSON.stringify({'read-delegates':{claude:{targets:[{low:{model:'fake'}}]}},phases:{'code-review':{targets:{low:1},rounds:{low:3}}}}));
    f.deps.skillRoot=skill;f.deps.liveness={claude:true};f.deps.orchestrator=null;
    f.deps.delegate=async()=>({outcome:{status:'ok',text:JSON.stringify({status:'CLEAN',findings:[]}),resume:null,sessionId:null},invocations:[]});
    await f.level('high');await f.approve();
    const launch=async(text:string)=>{
      const made=await f.run(['worktree','create','T1']);assert.equal(made.exit,0,JSON.stringify(made.output));
      fs.writeFileSync(path.resolve(f.session,made.value.path,'src/file.ts'),text);
      assert.equal((await f.run(['worktree','submit','T1'])).exit,0);assert.equal((await f.run(['worktree','integrate','T1'])).exit,0);
    };
    const review=async()=>{const result=await f.run(['review','run','T1','--kind','code']);assert.equal(result.exit,0,JSON.stringify(result.output));return JSON.parse(fs.readFileSync(result.value.path,'utf8'));};
    await launch('first\n');const first=await review();assert.ok(first?.findings,JSON.stringify(first));
    const gap=first.findings.find((finding:any)=>finding.defect.startsWith('missing-red: T1 SC1;'));
    assert.ok(gap,JSON.stringify(first));
    await appendRecord(f.session,{kind:'ruling',key:'reject-missing-red',by:'orchestrator',data:{subject:'review:'+first.review+':'+gap.id,ruling:'rejected',rationale:'The wrapper exit proves the test failed before the fix'}},f.deps);
    await launch('second\n');const second=await review();
    assert.equal(second.findings.some((finding:any)=>finding.defect.startsWith('missing-red: T1 SC1;')),false);
    assert.equal(second.escalations.some((row:any)=>row.key.startsWith('missing-red:')),false);
    await launch('third\n');const third=await review();
    assert.equal(third.findings.some((finding:any)=>finding.defect.startsWith('missing-red: T1 SC1;')),false);
    assert.equal(third.escalations.some((row:any)=>row.key.startsWith('missing-red:')),false);
  }finally{f.cleanup();}
});

test('wrapper RED exit suppresses missing-red without a report section',async()=>{
  const f=await toolkitRepo(source.replace('## Success Criteria','#### [MODIFY] tests/file.test.ts\n- Purpose: tests behavior.\n\n## Success Criteria'));try{
    const skill=path.join(f.session,'skill');fs.mkdirSync(skill);fs.cpSync(path.join(f.deps.skillRoot,'references'),path.join(skill,'references'),{recursive:true});
    fs.writeFileSync(path.join(skill,'config.jsonc'),JSON.stringify({'read-delegates':{claude:{targets:[{low:{model:'fake'}}]}},phases:{'code-review':{targets:{low:1},rounds:{low:3}}}}));
    f.deps.skillRoot=skill;f.deps.liveness={claude:true};f.deps.orchestrator=null;
    f.deps.delegate=async()=>({outcome:{status:'ok',text:JSON.stringify({status:'CLEAN',findings:[]}),resume:null,sessionId:null},invocations:[]});
    await f.level('high');await f.approve();
    const made=await f.run(['worktree','create','T1']);assert.equal(made.exit,0,JSON.stringify(made.output));
    fs.writeFileSync(path.resolve(f.session,made.value.path,'src/file.ts'),'changed\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit,0);
    const launch=foldLedger(f.session).records.findLast(row=>row.kind==='writer'&&row.data['phase']==='finished')!.data['launch'];
    const redDir=path.join(f.session,'.state','briefs','T1-'+launch+'.red');fs.mkdirSync(redDir,{recursive:true});
    fs.writeFileSync(path.join(redDir,'SC1.exit'),JSON.stringify({status:1,signal:null,error:null})+'\n');
    const result=await f.run(['review','run','T1','--kind','code']);assert.equal(result.exit,0,JSON.stringify(result.output));
    const findings=JSON.parse(fs.readFileSync(result.value.path,'utf8'));
    assert.equal(findings.findings.some((finding:any)=>finding.defect.startsWith('missing-red: T1 SC1;')),false);
    assert.equal(findings.escalations.some((row:any)=>row.key.startsWith('missing-red:')),false);
  }finally{f.cleanup();}
});

test('toolkit code review refuses an empty worktree diff before launching voices', async () => {
  const f = await toolkitRepo();
  try {
    const skill = path.join(f.session, 'empty-review-skill');
    fs.mkdirSync(skill);
    fs.cpSync(path.join(f.deps.skillRoot, 'references'), path.join(skill, 'references'), { recursive: true });
    fs.writeFileSync(path.join(skill, 'config.jsonc'), JSON.stringify({
      'read-delegates': { claude: { targets: [{ low: { model: 'fake' } }] } },
      phases: { 'code-review': { targets: { low: 1 }, rounds: { low: 1 } } },
    }));
    f.deps.skillRoot = skill;
    f.deps.liveness = { claude: true };
    f.deps.orchestrator = null;
    let launches = 0;
    f.deps.delegate = async () => {
      launches++;
      return { outcome: { status: 'ok', text: JSON.stringify({ status: 'CLEAN', findings: [] }), resume: null, sessionId: null }, invocations: [] };
    };
    await f.level('low');
    await f.approve();

    const recordsBefore = foldLedger(f.session).records.length;
    const result = await f.run(['review', 'run', 'worktree', '--kind', 'code', '--spec', 'work.spec.md', '--level', 'low']);

    assert.equal(result.exit, 4, JSON.stringify(result.output));
    assert.equal(result.output.reason, 'nothing-to-review');
    assert.equal(launches, 0);
    assert.equal(foldLedger(f.session).records.length, recordsBefore);
    const reviewsRoot = path.join(f.session, '.state/reviews');
    const rounds = fs.existsSync(reviewsRoot)
      ? fs.readdirSync(reviewsRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .flatMap(entry => fs.readdirSync(path.join(reviewsRoot, entry.name)).filter(name => /^round-\d+$/.test(name)))
      : [];
    assert.deepEqual(rounds, []);
  } finally {
    f.cleanup();
  }
});
