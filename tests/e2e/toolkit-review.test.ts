import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {toolkitRepo,planSource,setupTestSkill} from './helpers/toolkit-repo.ts';
import {appendRecord,foldLedger} from '../../skills/dispatch/scripts/toolkit/ledger.ts';
import {checkoutReportsFor} from '../../skills/dispatch/scripts/toolkit/findings.ts';
import { CLEAN } from '../helpers/e2e.ts';
import crypto from 'node:crypto';

test('native-first round runs native beside the cli wave', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'mixed-skill', {'read-delegates': {
      claude: {targets: [{low: {model: 'native-model'}}]},
      agy: {targets: [{low: {model: 'cli-model'}}]},
    }, phases: {'code-review': {targets: {low: 2}, rounds: {low: 1}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true, agy: true};
    f.deps.delegate = async (provider, request) => {
      if (provider !== 'agy') throw new Error('native-first launch must not call ' + provider);
      return {outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []};
    };
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'mixed change\n');
    const run = () => f.run(['review','run','worktree','--kind','code','--spec','work.spec.md','--level','low']);
    const launched = await run();
    assert.equal(launched.output.reason, 'native-pending');
    assert.equal(launched.value.cliWave, 'pending');
    assert.equal(launched.value.pending.length, 1);
    assert.equal(launched.value.pending[0].slot, 'claude[0]');
    const waved = await run();
    assert.equal(waved.output.reason, 'native-pending');
    assert.equal(waved.value.cliWave, 'done');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run();
    assert.equal(done.exit, 0);
  } finally {f.cleanup();}
});

test('pending MUST rejection keeps captured Git confirmation identity across native retry and target movement',async()=>{
 const f=await toolkitRepo();try {
  f.deps.skillRoot=setupTestSkill(f.deps,f.session,'confirmation-skill',{'read-delegates':{codex:{nativeSubagentsOnly:true,targets:[{low:{model:'native'}}]}},phases:{'code-review':{targets:{low:1},rounds:{low:1}}}});
  f.deps.orchestrator={platform:'codex',model:'native'};f.deps.liveness={};
  fs.writeFileSync(path.join(f.root,'src/file.ts'),'first captured change\n');
  const run=()=>f.run(['review','run','worktree','--kind','code','--spec','work.spec.md','--level','low']);
  const first=await run();assert.equal(first.output.reason,'native-pending');
  fs.writeFileSync(first.value.pending[0].replyPath,JSON.stringify({status:'FINDINGS',findings:[{impact:'blocks',trigger:'realistic',tag:'correctness',locus:'src/file.ts:L1',defect:'Writes are unbounded',requiredChange:'Bound the writes'}]}));
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

test('unchanged target with a pending MUST rejection runs a confirmation-only round through the CLI', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'confirmation-only-skill', {
      'read-delegates': {claude: {targets: [{low: {model: 'fake'}}]}, agy: {targets: [{low: {model: 'fake'}}]}},
      phases: {'code-review': {targets: {low: 2}, rounds: {low: 2}}},
    });
    f.deps.liveness = {claude: true, agy: true};
    fs.writeFileSync(path.join(f.root, 'src/file.ts'), 'first captured change\n');
    let phase: 'finding' | 'confirmation' = 'finding';
    const launched: string[] = [];
    f.deps.delegate = async (provider, request) => {
      launched.push(provider);
      if (phase === 'finding') {
        const text = provider === 'claude'
          ? JSON.stringify({status: 'FINDINGS', findings: [{impact: 'blocks', trigger: 'realistic', tag: 'correctness', locus: 'src/file.ts:L1', defect: 'Writes are unbounded', requiredChange: 'Bound the writes'}]})
          : JSON.stringify(CLEAN);
        return {outcome: {status: 'ok', text, resume: null, sessionId: null}, invocations: []};
      }
      const prompt = fs.readFileSync(request.promptPath, 'utf8');
      const ids = [...prompt.matchAll(/Request ID: `([^`]+)`/g)].map(match => match[1]!);
      assert.match(prompt, /\(confirmation-only\)/);
      return {outcome: {status: 'ok', text: JSON.stringify({status: 'CLEAN', findings: [], confirmations: ids.map(requestId => ({requestId, decision: 'agree', rationale: 'The captured bound holds'}))}), resume: null, sessionId: null}, invocations: []};
    };
    const run = () => f.run(['review', 'run', 'worktree', '--kind', 'code', '--spec', 'work.spec.md', '--level', 'low']);
    const first = await run();
    assert.equal(first.exit, 0, JSON.stringify(first));
    const review = first.value.review as string;
    const dir = path.join(f.session, '.state/reviews', review);
    const firstRound = JSON.parse(fs.readFileSync(path.join(dir, 'round-1', 'round.json'), 'utf8'));
    assert.deepEqual(firstRound.roster.filter((slot: {reserve: boolean}) => !slot.reserve).map((slot: {slot: string}) => slot.slot), ['claude[0]', 'agy[0]']);
    await appendRecord(f.session, {kind: 'ruling', by: 'orchestrator', key: 'reject-must', data: {subject: 'review:' + review + ':R1-F001', ruling: 'rejected', rationale: 'The captured implementation bounds each write'}}, f.deps);
    phase = 'confirmation'; launched.length = 0;
    const second = await run();
    assert.equal(second.exit, 0, JSON.stringify(second));
    const round = JSON.parse(fs.readFileSync(path.join(dir, 'round-2', 'round.json'), 'utf8'));
    assert.match(round.scope, /^Re-review round 2 \(confirmation-only\) — comparison: [a-f0-9]{40}\.\.[a-f0-9]{40}$/);
    assert.deepEqual(round.roster.filter((slot: {reserve: boolean}) => !slot.reserve).map((slot: {slot: string}) => slot.slot), ['claude[0]']);
    assert.deepEqual(launched, ['claude']);
    const prompt = fs.readFileSync(path.join(dir, 'round-2', 'gen-1', 'prompts', 'claude[0].md'), 'utf8');
    assert.ok(prompt.includes('- Target Revision: ' + round.target.base + '..' + round.target.head), prompt);
    const findings = JSON.parse(fs.readFileSync(path.join(dir, 'round-2', 'findings.json'), 'utf8'));
    assert.equal(findings.confirmations.length, 1);
    assert.equal(findings.confirmations[0].sourceSlot, 'claude[0]');
    assert.match(second.output.summary, /round 2\/2/);
    assert.equal((await run()).output.reason, 'round-cap');
  } finally {f.cleanup();}
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
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'native-skill', { 'read-delegates': { codex: { nativeSubagentsOnly: true, targets: [{ low: { model: 'native' } }] } }, phases: { 'code-review': { targets: { low: 1 }, rounds: { low: 2 } } } });
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
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'native-skill', { 'read-delegates': { codex: { nativeSubagentsOnly: true, targets: [{ low: { model: 'native' } }] } }, phases: { 'code-review': { targets: { low: 1 }, rounds: { low: 2 } } } });
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
    f.deps.skillRoot=setupTestSkill(f.deps,f.session,'skill',{'read-delegates':{claude:{targets:[{low:{model:'fake'}}]}},phases:{'code-review':{targets:{low:1},rounds:{low:3}}}});
    f.deps.liveness={claude:true};f.deps.orchestrator=null;
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


test('toolkit code review scopes integration recurrence and gaps to committed owner changes',async()=>{
  const two=source.replace('| T1 | File | Works | none | SC1 |','| T1 | File | Works | none | SC1 |\n| T2 | Other | Works | none | SC2 |')
    .replace('## Success Criteria','#### [MODIFY] tests/file.test.ts\n### T2 — Other\n#### [MODIFY] src/other.ts\n- Purpose: independent behavior.\n## Success Criteria')
    .replace('## Verification Plan','- [SC2] Other works\n  - Changes: src/other.ts\n  - Verify: `node -e "process.exit(0)"`\n  - Evidence: verify\n## Verification Plan');
  for(const fixOwner of [false,true]) {
    const f=await toolkitRepo(two,{'src/other.ts':'initial\n'});try{
      f.deps.skillRoot=setupTestSkill(f.deps,f.session,'skill',{'read-delegates':{claude:{targets:[{low:{model:'fake'}}]}},phases:{'code-review':{targets:{low:1},rounds:{low:3}}}});
      f.deps.liveness={claude:true};f.deps.orchestrator=null;
      f.deps.delegate=async()=>({outcome:{status:'ok',text:JSON.stringify({status:'FINDINGS',findings:[{impact:'degrades',trigger:'realistic',tag:'correctness',locus:'src/file.ts:L1',defect:'The file returns an invalid result',requiredChange:'Return the expected result'}]}),resume:null,sessionId:null},invocations:[]});
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
      else{assert.deepEqual(finding.unresolved,{of:first.findings[0].id});assert.equal(second.escalations.length,0);const gap=second.findings.find((finding:any)=>finding.id==='R2-RED01');assert.ok(gap.unresolved);assert.deepEqual([gap.severity,gap.impact,gap.trigger],['SHOULD','degrades','realistic']);assert.match(gap.defect,/Tests touched: no$/);}
    }finally{f.cleanup();}
  }
});

test('rejected missing-red ruling settles later rounds after the target moves',async()=>{
  const f=await toolkitRepo(source.replace('## Success Criteria','#### [MODIFY] tests/file.test.ts\n- Purpose: tests behavior.\n\n## Success Criteria'));try{
    f.deps.skillRoot=setupTestSkill(f.deps,f.session,'skill',{'read-delegates':{claude:{targets:[{low:{model:'fake'}}]}},phases:{'code-review':{targets:{low:1},rounds:{low:3}}}});
    f.deps.liveness={claude:true};f.deps.orchestrator=null;
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
    f.deps.skillRoot=setupTestSkill(f.deps,f.session,'skill',{'read-delegates':{claude:{targets:[{low:{model:'fake'}}]}},phases:{'code-review':{targets:{low:1},rounds:{low:3}}}});
    f.deps.liveness={claude:true};f.deps.orchestrator=null;
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
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'empty-review-skill', {
      'read-delegates': { claude: { targets: [{ low: { model: 'fake' } }] } },
      phases: { 'code-review': { targets: { low: 1 }, rounds: { low: 1 } } },
    });
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

// SECTION: Coverage rounds over real integration Git state

const PROVIDERS = ['claude', 'codex', 'opencode'];
const MUST_FINDING = {status: 'FINDINGS', findings: [{impact: 'blocks', trigger: 'realistic', tag: 'correctness', locus: 'src/file.ts:L1', defect: 'The file returns an invalid result', requiredChange: 'Return the expected result'}]};
async function coverageRepo(rounds: number) {
  const f = await toolkitRepo();
  f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'skill', {'read-delegates': Object.fromEntries(PROVIDERS.map(provider => [provider, {targets: [{low: {model: 'fake'}}]}])),
    phases: {'code-review': {targets: {low: 3}, rounds: {low: rounds}}}});
  f.deps.liveness = Object.fromEntries(PROVIDERS.map(provider => [provider, true])); f.deps.orchestrator = null; f.deps.modes = () => ['cli'] as never;
  const failing = new Set<string>(), replies = new Map<string, object>(), calls: {provider: string; prompt: string}[] = [];
  f.deps.delegate = async (provider, request) => {
    calls.push({provider, prompt: fs.readFileSync(request.promptPath, 'utf8')});
    if (failing.has(provider)) return {outcome: {status: 'fail', cls: 'auth', detail: 'denied'}, invocations: []};
    return {outcome: {status: 'ok', text: JSON.stringify(replies.get(provider) ?? CLEAN), resume: null, sessionId: null}, invocations: []};
  };
  await f.level('low'); await f.approve();
  const made = await f.run(['worktree', 'create', 'T1']); assert.equal(made.exit, 0, JSON.stringify(made.output));
  fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'first\n');
  assert.equal((await f.run(['worktree', 'submit', 'T1'])).exit, 0); assert.equal((await f.run(['worktree', 'integrate', 'T1'])).exit, 0);
  const review = () => f.run(['review', 'run', 'integration', '--kind', 'code']);
  const dir = (n: number) => path.join(f.session, '.state/reviews/code-integration/round-' + n);
  const round = (n: number) => JSON.parse(fs.readFileSync(path.join(dir(n), 'round.json'), 'utf8'));
  const findings = (n: number) => JSON.parse(fs.readFileSync(path.join(dir(n), 'findings.json'), 'utf8'));
  const attempts = (n: number) => JSON.parse(fs.readFileSync(path.join(dir(n), 'gen-1/attempts.json'), 'utf8')) as {slot: string; seq: number; wholeTarget: boolean}[];
  const targets = (n: number) => round(n).roster.filter((slot: {reserve: boolean}) => !slot.reserve).map((slot: {slot: string}) => slot.slot).sort();
  const accept = (id: string) => appendRecord(f.session, {kind: 'ruling', by: 'orchestrator', key: 'accept-' + id, data: {subject: 'review:code-integration:' + id, ruling: 'accepted', rationale: 'Fix accepted'}}, f.deps);
  return {f, failing, replies, calls, review, dir, round, findings, attempts, targets, accept};
}

test('open slot rerun selects whole-target scope and leaves narrowing unchanged once nothing is open', async () => {
  const t = await coverageRepo(4); try {
    t.failing.add('claude');
    const first = await t.review(); assert.equal(first.exit, 0, JSON.stringify(first.output));
    assert.deepEqual(t.findings(1).failed.map((reply: {slot: string}) => reply.slot), ['claude[0]']);
    t.failing.clear(); t.calls.length = 0;
    const second = await t.review(); assert.equal(second.exit, 0, JSON.stringify(second.output));
    const metadata = t.round(2);
    assert.equal(metadata.coverage, 'open'); assert.equal(metadata.coverageUse, undefined);
    assert.deepEqual(t.targets(2), ['claude[0]']);
    assert.equal(metadata.scope, `Re-review round 2 (coverage) — changed paths: src/file.ts; comparison: ${metadata.target.base}..${metadata.target.head}`);
    assert.deepEqual(t.calls.map(call => call.provider), ['claude']); assert.ok(t.calls[0]!.prompt.includes(metadata.scope));
    const third = await t.review(); assert.equal(third.exit, 0, JSON.stringify(third.output));
    assert.match(t.round(3).scope, /^Re-review round 3 \(narrowed\)/); assert.equal(t.round(3).coverage, undefined);
  } finally { t.f.cleanup(); }
});

test('open slot rerun selects whole-target scope with the full roster after a decisive finding', async () => {
  const t = await coverageRepo(4); try {
    t.failing.add('claude'); t.replies.set('codex', MUST_FINDING);
    assert.equal((await t.review()).exit, 0); await t.accept('R1-F001');
    t.failing.clear(); t.replies.delete('codex'); t.calls.length = 0;
    const second = await t.review(); assert.equal(second.exit, 0, JSON.stringify(second.output));
    assert.equal(t.round(2).coverage, 'full'); assert.deepEqual(t.targets(2), ['claude[0]', 'codex[0]', 'opencode[0]']);
    assert.match(t.round(2).scope, /^Re-review round 2 \(coverage\) — changed paths: src\/file\.ts; comparison: /);
    assert.deepEqual(t.calls.map(call => call.provider).sort(), PROVIDERS);
  } finally { t.f.cleanup(); }
});

test('coverage round follows an all-failed narrowed round at whole-target scope', async () => {
  const t = await coverageRepo(4); try {
    assert.equal((await t.review()).exit, 0);
    const narrowed = t.targets(1)[0]!, provider = narrowed.replace(/\[\d+\]$/, '');
    t.failing.add(provider);
    const second = await t.review(); assert.equal(second.exit, 0, JSON.stringify(second.output));
    assert.match(t.round(2).scope, /^Re-review round 2 \(narrowed\)/); assert.deepEqual(t.findings(2).failed.map((reply: {slot: string}) => reply.slot), [narrowed]);
    t.failing.clear();
    const third = await t.review(); assert.equal(third.exit, 0, JSON.stringify(third.output));
    assert.equal(t.round(3).coverage, 'open'); assert.deepEqual(t.targets(3), [narrowed]);
  } finally { t.f.cleanup(); }
});

test('coverage round past the cap counts an all-failed open-only round as used and stops for a user decision', async () => {
  const t = await coverageRepo(1); try {
    t.failing.add('claude'); t.failing.add('codex');
    assert.equal((await t.review()).exit, 0);
    const used = await t.review(); assert.equal(used.exit, 0, JSON.stringify(used.output));
    assert.equal(t.round(2).coverageUse, 'free'); assert.deepEqual(t.targets(2), ['claude[0]', 'codex[0]']);
    assert.equal(used.value.round, 2); assert.equal(t.findings(2).failed.length, 2);
    const stopped = await t.review();
    assert.equal(stopped.output.reason, 'coverage-decision'); assert.match(stopped.output.summary, /accept[\s\S]*grant/);
    assert.equal(fs.existsSync(path.join(t.dir(3), 'round.json')), false);
    t.failing.clear();
    await appendRecord(t.f.session, {kind: 'escalation', by: 'user', quote: 'one more try', key: 'coverage:code-integration:1', data: {id: 'coverage:code-integration:1', state: 'resolved', summary: 'grant: provider restored'}}, t.f.deps);
    const granted = await t.review(); assert.equal(granted.exit, 0, JSON.stringify(granted.output));
    assert.equal(t.round(3).coverageUse, 'grant'); assert.equal(t.round(3).coverage, 'open');
    assert.equal((await t.review()).output.reason, 'round-cap', 'the grant is consumed and nothing is left open');
  } finally { t.f.cleanup(); }
});

test('coverage round accepted MUST past a used coverage round runs the full roster with no grant', async () => {
  const t = await coverageRepo(1); try {
    t.failing.add('claude'); t.failing.add('codex');
    assert.equal((await t.review()).exit, 0);
    t.failing.delete('claude'); t.replies.set('claude', MUST_FINDING);
    assert.equal((await t.review()).exit, 0); assert.equal(t.round(2).coverageUse, 'free'); await t.accept('R2-F001');
    t.failing.clear(); t.replies.clear();
    const third = await t.review(); assert.equal(third.exit, 0, JSON.stringify(third.output));
    assert.equal(t.round(3).coverage, 'full'); assert.equal(t.round(3).coverageUse, undefined);
  } finally { t.f.cleanup(); }
});

test('coverage round full-roster all-failed reuses its number and keeps every failure through retry and native resume', async () => {
  const t = await coverageRepo(1); try {
    for (const provider of PROVIDERS) t.failing.add(provider);
    assert.equal((await t.review()).output.reason, 'review-failed');
    assert.equal(t.attempts(1).length, 3); assert.deepEqual(t.attempts(1).map(entry => entry.slot).sort(), ['claude[0]', 'codex[0]', 'opencode[0]']);
    assert.equal((await t.review()).output.reason, 'review-failed'); assert.equal(t.attempts(1).length, 6);
    assert.equal(fs.existsSync(path.join(t.dir(1), 'findings.json')), false); assert.equal(fs.existsSync(path.join(t.dir(2), 'round.json')), false);
    t.f.deps.orchestrator = {platform: 'claude', model: 'native'} as typeof t.f.deps.orchestrator;
    const launched = await t.review(); assert.equal(launched.output.reason, 'native-pending'); assert.equal(launched.value.cliWave, 'pending'); assert.equal(t.attempts(1).length, 6);
    const pending = await t.review(); assert.equal(pending.output.reason, 'native-pending'); assert.equal(pending.value.cliWave, 'done'); assert.equal(t.attempts(1).length, 8);
    fs.writeFileSync(pending.value.pending[0].replyPath, JSON.stringify(CLEAN));
    const resumed = await t.review(); assert.equal(resumed.exit, 0, JSON.stringify(resumed.output));
    assert.equal(resumed.value.round, 1); assert.equal(t.findings(1).failed.length, 2); assert.equal(t.attempts(1).length, 10);
    assert.ok(t.attempts(1).every(entry => entry.wholeTarget && Number.isSafeInteger(entry.seq)));
  } finally { t.f.cleanup(); }
});

test('repository changes list a tracked edit made during a native round and keep every reply', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0, JSON.stringify(made.output));
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    const launched = await run();
    assert.equal(launched.output.reason, 'native-pending');
    const waved = await run();
    assert.equal(waved.output.reason, 'native-pending');
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'native edit during round\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run();
    assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(Array.isArray(done.value.repositoryChanges), 'result lists repositoryChanges');
    const listed = done.value.repositoryChanges.flatMap((entry: {paths: string[]}) => entry.paths);
    assert.ok(listed.includes('src/file.ts'), 'tracked edit is listed: ' + JSON.stringify(done.value.repositoryChanges));
    const persisted = JSON.parse(fs.readFileSync(done.value.path,'utf8'));
    assert.deepEqual(persisted.repositoryChanges, done.value.repositoryChanges);
    const status = await f.run(['status','show']);
    assert.ok(Array.isArray(status.value.openRepositoryChanges));
    assert.ok(status.value.openRepositoryChanges.some((entry: {review: string}) => entry.review === done.value.review));
  } finally {f.cleanup();}
});

test('repository changes skip ignored and session files while listing untracked and deleted paths', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    fs.writeFileSync(path.join(f.root,'ignored'), 'ignored edit\n');
    fs.writeFileSync(path.join(f.session,'untracked-session.txt'), 'session edit\n');
    fs.writeFileSync(path.join(f.root,'src/new-untracked.ts'), 'untracked\n');
    fs.rmSync(path.join(f.root,'src/file.ts'));
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    const listed = done.value.repositoryChanges.flatMap((entry: {paths: string[]}) => entry.paths);
    assert.ok(listed.includes('src/new-untracked.ts'), JSON.stringify(done.value.repositoryChanges));
    assert.ok(listed.includes('src/file.ts'), JSON.stringify(done.value.repositoryChanges));
    assert.ok(!listed.includes('ignored'), JSON.stringify(done.value.repositoryChanges));
    assert.ok(!listed.some((p: string) => p.includes('untracked-session')), JSON.stringify(done.value.repositoryChanges));
  } finally {f.cleanup();}
});

test('repository changes report an unavailable check and keep replies when the task worktree is absent', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    const worktreePath = path.resolve(f.session, made.value.path);
    fs.writeFileSync(path.join(worktreePath, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    fs.rmSync(worktreePath, {recursive: true, force: true});
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(done.value.repositoryCheck && done.value.repositoryCheck.state === 'unavailable', JSON.stringify(done.value));
    assert.ok(!done.value.repositoryChanges, JSON.stringify(done.value));
    const persisted = JSON.parse(fs.readFileSync(done.value.path,'utf8'));
    assert.equal(persisted.repositoryCheck.state, 'unavailable');
  } finally {f.cleanup();}
});

test('repository changes run no check without a native voice', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'cli-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 1}}}});
    f.deps.orchestrator = null;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'edit without native\n');
    const done = await f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(!('repositoryChanges' in done.value), JSON.stringify(done.value));
    assert.ok(!('repositoryCheck' in done.value), JSON.stringify(done.value));
    assert.ok(!('openRepositoryChanges' in (await f.run(['status','show'])).value), 'no open report');
  } finally {f.cleanup();}
});

test('repository changes list a mode change and an assume-unchanged edit', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    fs.writeFileSync(path.join(f.root,'src/mode.sh'), 'echo hi\n');
    f.git(['add','src/mode.sh']); f.git(['commit','-qm','mode file']);
    f.git(['update-index','--assume-unchanged','src/file.ts']);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    f.git(['update-index','--chmod=+x','src/mode.sh']);
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'assume-unchanged edit\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    const listed = (done.value.repositoryChanges ?? []).flatMap((entry: {paths: string[]}) => entry.paths);
    assert.ok(listed.includes('src/mode.sh'), JSON.stringify(done.value.repositoryChanges));
    assert.ok(listed.includes('src/file.ts'), JSON.stringify(done.value.repositoryChanges));
  } finally {f.cleanup();}
});

test('repository changes close with a keep note and admit one rerun round at the cap', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 1}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'rerun edit\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(done.value.repositoryChanges, JSON.stringify(done.value));
    const review = done.value.review;
    let status = await f.run(['status','show']);
    assert.ok(status.value.openRepositoryChanges.some((entry: {review: string; round: number}) => entry.review === review && entry.round === 1));
    await appendRecord(f.session, {kind: 'note', by: 'user', quote: 'Rerun after inspection', key: `repository-rerun:${review}:1`, data: {text: 'rerun'}}, f.deps);
    status = await f.run(['status','show']);
    const open = status.value.openRepositoryChanges.find((entry: {review: string; round: number}) => entry.review === review && entry.round === 1);
    assert.ok(open && open.rerunPending === true, JSON.stringify(status.value.openRepositoryChanges));
    const rerunLaunched = await run(); assert.equal(rerunLaunched.output.reason, 'native-pending', JSON.stringify(rerunLaunched.output));
    const rerunWaved = await run(); assert.equal(rerunWaved.output.reason, 'native-pending');
    for (const slot of rerunWaved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const rerunDone = await run(); assert.equal(rerunDone.exit, 0, JSON.stringify(rerunDone.output));
    assert.equal(rerunDone.value.round, 2);
    await appendRecord(f.session, {kind: 'note', by: 'orchestrator', key: `repository-changes:${review}:1`, data: {text: 'explained'}}, f.deps);
    status = await f.run(['status','show']);
    assert.ok(!status.value.openRepositoryChanges?.some((entry: {review: string; round: number}) => entry.review === review && entry.round === 1), JSON.stringify(status.value));
  } finally {f.cleanup();}
});

test('repository changes detect a second edit of an already dirty path', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'first dirty edit\n');
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'second dirty edit\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    const listed = (done.value.repositoryChanges ?? []).flatMap((entry: {paths: string[]}) => entry.paths);
    assert.ok(listed.includes('src/file.ts'), JSON.stringify(done.value.repositoryChanges));
    assert.ok(done.value.repositoryChanges, 'second edit is listed');
  } finally {f.cleanup();}
});

test('repository changes list a path inside an untracked directory', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    fs.mkdirSync(path.join(f.root,'src','newdir'), {recursive: true});
    fs.writeFileSync(path.join(f.root,'src','newdir','inner.ts'),'untracked inner\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    const listed = (done.value.repositoryChanges ?? []).flatMap((entry: {paths: string[]}) => entry.paths);
    assert.ok(listed.includes('src/newdir/inner.ts'), JSON.stringify(done.value.repositoryChanges));
  } finally {f.cleanup();}
});

test('repository changes list a renamed path', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    f.git(['mv','src/file.ts','src/renamed.ts']);
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    const listed = (done.value.repositoryChanges ?? []).flatMap((entry: {paths: string[]}) => entry.paths);
    assert.ok(listed.includes('src/renamed.ts'), JSON.stringify(done.value.repositoryChanges));
  } finally {f.cleanup();}
});

test('repository changes list a mode-only change on an untracked path', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    fs.writeFileSync(path.join(f.root,'src','untracked-mode.sh'),'echo hi\n');
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    f.git(['update-index','--add','--chmod=+x','src/untracked-mode.sh']);
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    const listed = (done.value.repositoryChanges ?? []).flatMap((entry: {paths: string[]}) => entry.paths);
    assert.ok(listed.includes('src/untracked-mode.sh'), JSON.stringify(done.value.repositoryChanges));
  } finally {f.cleanup();}
});

test('repository changes detect an index-only change', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const original = fs.readFileSync(path.join(f.root,'src/file.ts'),'utf8');
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'staged new content\n');
    f.git(['add','src/file.ts']);
    fs.writeFileSync(path.join(f.root,'src/file.ts'),original);
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    const listed = (done.value.repositoryChanges ?? []).flatMap((entry: {paths: string[]}) => entry.paths);
    assert.ok(listed.includes('src/file.ts'), JSON.stringify(done.value.repositoryChanges));
  } finally {f.cleanup();}
});

test('repository changes list a change inside a nested integration checkout', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    assert.equal((await f.run(['worktree','integrate','T1'])).exit, 0);
    const run = () => f.run(['review','run','integration','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    fs.writeFileSync(path.join(f.integration,'src/file.ts'),'integration edit during round\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(done.value.repositoryChanges, JSON.stringify(done.value));
    const entry = done.value.repositoryChanges.find((row: {cwd: string}) => path.resolve(row.cwd) === path.resolve(f.integration));
    assert.ok(entry && entry.paths.includes('src/file.ts'), JSON.stringify(done.value.repositoryChanges));
  } finally {f.cleanup();}
});

test('repository changes list a task worktree change in full from its own root', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    const worktree = path.resolve(f.session, made.value.path);
    fs.writeFileSync(path.join(worktree, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    fs.writeFileSync(path.join(worktree,'src/file.ts'),'worktree edit during round\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    const entry = (done.value.repositoryChanges ?? []).find((row: {cwd: string}) => path.resolve(row.cwd) === worktree);
    assert.ok(entry && entry.paths.includes('src/file.ts'), JSON.stringify(done.value.repositoryChanges));
  } finally {f.cleanup();}
});

test('repository changes keep review-failed and name paths for an all-failed round', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'fail', cls: 'auth', detail: 'denied'}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'change before all-failed\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, 'INVALID REPORT');
    const failed = await run();
    assert.equal(failed.output.reason, 'review-failed', JSON.stringify(failed.output));
    assert.match(failed.output.summary, /src\/file\.ts/);
    const reviewDirs = fs.readdirSync(path.join(f.session, '.state/reviews'));
    assert.ok(reviewDirs.length > 0);
    const reviewName = reviewDirs[0]!;
    const report = JSON.parse(fs.readFileSync(path.join(f.session, '.state/reviews', reviewName, 'round-1/gen-1/checkout-report.json'), 'utf8'));
    assert.ok((report.repositoryChanges ?? []).flatMap((entry: {paths: string[]}) => entry.paths).includes('src/file.ts'), JSON.stringify(report));
    const reviewDir = path.join(f.session, '.state/reviews', failed.output.message ? 'unknown' : 'unknown');
    void reviewDir;
    const status = await f.run(['status','show']);
    const open = (status.value.openRepositoryChanges ?? []).flatMap((row: {repositoryChanges?: {paths: string[]}[]}) => (row.repositoryChanges ?? []).flatMap(entry => entry.paths));
    assert.ok(open.includes('src/file.ts'), JSON.stringify(status.value.openRepositoryChanges));
  } finally {f.cleanup();}
});

test('repository changes report unavailable when baseline capture fails and keep replies', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    const worktree = path.resolve(f.session, made.value.path);
    fs.writeFileSync(path.join(worktree, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    fs.rmSync(worktree, {recursive: true, force: true});
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(done.value.repositoryCheck && done.value.repositoryCheck.state === 'unavailable', JSON.stringify(done.value));
    assert.ok(!done.value.repositoryChanges, JSON.stringify(done.value));
  } finally {f.cleanup();}
});

test('repository changes return target-moved when the review target itself changes', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}, agy: {targets: [{low: {model: 'cli-model'}}]}}, phases: {'code-review': {targets: {low: 2}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true, agy: true};
    f.deps.delegate = async (provider) => {
      if (provider !== 'agy') throw new Error('CLI wave must only run agy');
      return {outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []};
    };
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'worktree base\n');
    const run = (hook?: (point: string) => void | Promise<void>) => f.run(['review','run','worktree','--kind','code','--spec','work.spec.md','--level','low'], hook as never);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const moved = await run(async (point) => {
      if (point === 'review:after-pending') fs.writeFileSync(path.join(f.root,'src/file.ts'),'target edit during finalization\n');
    });
    assert.equal(moved.output.reason, 'target-moved', JSON.stringify(moved.output));
  } finally {f.cleanup();}
});

test('repository changes list a moved HEAD diff in a plan review including both rename sides', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'plan-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const run = () => f.run(['review','run','work.plan.md','--kind','plan','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    f.git(['mv','src/file.ts','src/renamed.ts']); f.git(['commit','-qm','rename']);
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    const listed = (done.value.repositoryChanges ?? []).flatMap((entry: {paths: string[]}) => entry.paths);
    assert.ok(listed.includes('src/file.ts'), JSON.stringify(done.value.repositoryChanges));
    assert.ok(listed.includes('src/renamed.ts'), JSON.stringify(done.value.repositoryChanges));
  } finally {f.cleanup();}
});

test('repository changes stay open after an interruption between findings and the result file', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'interrupted change\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(done.value.repositoryChanges, JSON.stringify(done.value));
    fs.rmSync(done.output.path, {force: true});
    const status = await f.run(['status','show']);
    assert.ok(status.value.openRepositoryChanges.some((entry: {review: string}) => entry.review === done.value.review), 'interrupted change stays open');
    await appendRecord(f.session, {kind: 'note', by: 'orchestrator', key: `repository-changes:${done.value.review}:1`, data: {text: 'explained'}}, f.deps);
    const closed = await f.run(['status','show']);
    assert.ok(!closed.value.openRepositoryChanges?.some((entry: {review: string}) => entry.review === done.value.review), JSON.stringify(closed.value));
  } finally {f.cleanup();}
});

test('repository changes stay open after an interrupted failed check until a closing note exists', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    const worktree = path.resolve(f.session, made.value.path);
    fs.writeFileSync(path.join(worktree, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    fs.rmSync(worktree, {recursive: true, force: true});
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(done.value.repositoryCheck, JSON.stringify(done.value));
    fs.rmSync(done.output.path, {force: true});
    const status = await f.run(['status','show']);
    assert.ok(status.value.openRepositoryChanges.some((entry: {repositoryCheck?: unknown}) => !!entry.repositoryCheck), JSON.stringify(status.value));
  } finally {f.cleanup();}
});

test('repository changes keep rerunPending through an interrupted rerun round', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 1}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'rerun interrupt edit\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    const review = done.value.review;
    await appendRecord(f.session, {kind: 'note', by: 'user', quote: 'rerun', key: `repository-rerun:${review}:1`, data: {text: 'rerun'}}, f.deps);
    const launched = await run(); assert.equal(launched.output.reason, 'native-pending');
    let status = await f.run(['status','show']);
    assert.ok(status.value.openRepositoryChanges.some((entry: {review: string; round: number; rerunPending?: boolean}) => entry.review === review && entry.round === 1 && entry.rerunPending === true), JSON.stringify(status.value));
    const waved2 = await run(); assert.equal(waved2.output.reason, 'native-pending');
    for (const slot of waved2.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const redone = await run(); assert.equal(redone.exit, 0, JSON.stringify(redone.output));
    assert.equal(redone.value.round, 2);
    status = await f.run(['status','show']);
    assert.ok(!status.value.openRepositoryChanges?.some((entry: {review: string; round: number}) => entry.review === review && entry.round === 1), JSON.stringify(status.value));
  } finally {f.cleanup();}
});

test('repository changes refuse a rerun at the ceiling but keep the report open', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 1}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    const MUST = {status: 'FINDINGS', findings: [{impact: 'blocks', trigger: 'realistic', tag: 'correctness', locus: 'src/file.ts:L1', defect: 'The file returns an invalid result', requiredChange: 'Return the expected result'}]};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    const completeRound = async (edit: string, reply: unknown = CLEAN) => {
      assert.equal((await run()).output.reason, 'native-pending');
      const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
      fs.writeFileSync(path.join(f.root,'src/file.ts'),edit);
      for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(reply));
      const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
      return done.value;
    };
    const first = await completeRound('ceiling edit one\n');
    await appendRecord(f.session, {kind: 'note', by: 'user', quote: 'rerun', key: `repository-rerun:${first.review}:1`, data: {text: 'rerun'}}, f.deps);
    const second = await completeRound('ceiling edit two\n');
    assert.equal(second.round, 2);
    await appendRecord(f.session, {kind: 'note', by: 'user', quote: 'rerun', key: `repository-rerun:${second.review}:2`, data: {text: 'rerun'}}, f.deps);
    const third = await completeRound('ceiling edit three\n', MUST);
    assert.equal(third.round, 3);
    await appendRecord(f.session, {kind: 'ruling', by: 'orchestrator', key: 'accept-ceiling', data: {subject: 'review:' + third.review + ':R3-F001', ruling: 'accepted', rationale: 'Fix accepted'}}, f.deps);
    await appendRecord(f.session, {kind: 'note', by: 'user', quote: 'rerun', key: `repository-rerun:${third.review}:3`, data: {text: 'rerun'}}, f.deps);
    const refused = await run();
    assert.equal(refused.output.reason, 'review-ceiling', JSON.stringify(refused.output));
    const status = await f.run(['status','show']);
    assert.ok(status.value.openRepositoryChanges.some((entry: {review: string; round: number; rerunPending?: boolean}) => entry.review === third.review && entry.round === 3 && entry.rerunPending === true), JSON.stringify(status.value));
  } finally {f.cleanup();}
});

test('repository changes rerun a mixed round at whole-target scope and settle later rounds', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}, agy: {targets: [{low: {model: 'cli-model'}}]}}, phases: {'code-review': {targets: {low: 2}, rounds: {low: 1}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true, agy: true};
    f.deps.delegate = async (provider) => {
      if (provider !== 'agy') throw new Error('CLI wave must only run agy');
      return {outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []};
    };
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'mixed rerun edit\n');
    for (const slot of waved.value.pending) {
      if (slot.slot.startsWith('claude')) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    }
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(done.value.repositoryChanges, JSON.stringify(done.value));
    const review = done.value.review;
    await appendRecord(f.session, {kind: 'note', by: 'user', quote: 'rerun mixed', key: `repository-rerun:${review}:1`, data: {text: 'rerun'}}, f.deps);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved2 = await run(); assert.equal(waved2.output.reason, 'native-pending');
    const round2 = JSON.parse(fs.readFileSync(path.join(f.session, '.state/reviews', review, 'round-2/round.json'), 'utf8'));
    assert.ok(round2.scope.startsWith('Full review'), round2.scope);
    assert.deepEqual(round2.roster.filter((slot: {reserve: boolean}) => !slot.reserve).map((slot: {slot: string}) => slot.slot).sort(), ['agy[0]', 'claude[0]']);
    for (const slot of waved2.value.pending) {
      if (slot.slot.startsWith('claude')) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    }
    const redone = await run(); assert.equal(redone.exit, 0, JSON.stringify(redone.output));
    assert.equal(redone.value.round, 2);
    const status = await f.run(['status','show']);
    assert.ok(!status.value.openRepositoryChanges?.some((entry: {review: string; round: number}) => entry.review === review && entry.round === 1), JSON.stringify(status.value));
  } finally {f.cleanup();}
});

test('repository changes list edits from a native-only round', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {codex: {nativeSubagentsOnly: true, targets: [{low: {model: 'native'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'codex', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {};
    f.deps.delegate = async () => { throw new Error('native-only must not call cli'); };
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    const launched = await run();
    assert.equal(launched.output.reason, 'native-pending');
    assert.equal(launched.value.pending.length, 1);
    assert.ok(!('cliWave' in launched.value));
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'native-only edit\n');
    for (const slot of launched.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run();
    assert.equal(done.exit, 0, JSON.stringify(done.output));
    const listed = (done.value.repositoryChanges ?? []).flatMap((entry: {paths: string[]}) => entry.paths);
    assert.ok(listed.includes('src/file.ts'), JSON.stringify(done.value.repositoryChanges));
  } finally {f.cleanup();}
});

test('repository changes report unavailable for a dirty submodule re-edit with ignore dirty', async () => {
  const f = await toolkitRepo(); try {
    const subSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'submod-src-'));
    try {
      const gitSrc = (args: string[]) => {
        const r = spawnSync('git', args, {cwd: subSrc, encoding: 'utf8'});
        assert.equal(r.status, 0, r.stderr);
      };
      gitSrc(['init','-b','main']);
      gitSrc(['config','user.email','test@example.test']);
      gitSrc(['config','user.name','Toolkit Test']);
      fs.writeFileSync(path.join(subSrc,'file.txt'),'base\n');
      gitSrc(['add','.']);
      gitSrc(['commit','-m','base']);
      const subUrl = subSrc.split(path.sep).join('/');
      const add = spawnSync('git', ['-c','protocol.file.allow=always','submodule','add', subUrl, 'submod'], {cwd: f.root, encoding: 'utf8'});
      assert.equal(add.status, 0, add.stderr);
      f.git(['add','.gitmodules','submod']);
      f.git(['commit','-qm','add submodule']);
      f.git(['config','-f','.gitmodules','submodule.submod.ignore','dirty']);
      f.git(['add','.gitmodules']);
      f.git(['commit','-qm','ignore dirty']);
      fs.writeFileSync(path.join(f.root,'submod','file.txt'),'dirty before\n');
      f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
      f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
      f.deps.liveness = {claude: true};
      f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
      await f.level('low'); await f.approve();
      const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
      fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
      assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
      const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
      assert.equal((await run()).output.reason, 'native-pending');
      const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
      fs.writeFileSync(path.join(f.root,'submod','file.txt'),'dirty after\n');
      for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
      const done = await run();
      assert.equal(done.exit, 0, JSON.stringify(done.output));
      assert.ok(done.value.repositoryCheck && done.value.repositoryCheck.state === 'unavailable', JSON.stringify(done.value));
      assert.match(done.value.repositoryCheck.reason, /Dirty submodule/);
      assert.ok(!done.value.repositoryChanges, JSON.stringify(done.value));
    } finally {
      fs.rmSync(subSrc, {recursive: true, force: true});
    }
  } finally {f.cleanup();}
});

test('repository changes report unavailable when checkout reads fail', async () => {
  const patches = [
    {name: 'stat', patch: (target: string) => {
      const orig = fs.lstatSync;
      (fs as unknown as {lstatSync: unknown}).lstatSync = (p: unknown, ...rest: unknown[]) => {
        if (typeof p === 'string' && path.resolve(p) === target) {
          const error = new Error('denied') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return (orig as (...args: unknown[]) => unknown)(p, ...rest);
      };
      return () => { (fs as unknown as {lstatSync: unknown}).lstatSync = orig; };
    }},
    {name: 'read', patch: (target: string) => {
      const denied = (): never => { const error = new Error('denied') as NodeJS.ErrnoException; error.code = 'EACCES'; throw error; };
      const orig = fs.readFileSync;
      const origOpen = fs.openSync;
      (fs as unknown as {readFileSync: unknown}).readFileSync = (p: unknown, ...rest: unknown[]) => {
        if (typeof p === 'string' && path.resolve(p) === target) denied();
        return (orig as (...args: unknown[]) => unknown)(p, ...rest);
      };
      // Content fingerprints stream through openSync: fail the open too, so a
      // read failure still surfaces as an unavailable check.
      (fs as unknown as {openSync: unknown}).openSync = (p: unknown, ...rest: unknown[]) => {
        if (typeof p === 'string' && path.resolve(p) === target) denied();
        return (origOpen as unknown as (...args: unknown[]) => unknown)(p, ...rest);
      };
      return () => { (fs as unknown as {readFileSync: unknown}).readFileSync = orig; (fs as unknown as {openSync: unknown}).openSync = origOpen; };
    }},
    {name: 'readlink', patch: (target: string) => {
      const origLstat = fs.lstatSync;
      const origLink = fs.readlinkSync;
      (fs as unknown as {lstatSync: unknown}).lstatSync = (p: unknown, ...rest: unknown[]) => {
        if (typeof p === 'string' && path.resolve(p) === target) return {isSymbolicLink: () => true, isDirectory: () => false, mode: 0} as unknown as fs.Stats;
        return (origLstat as (...args: unknown[]) => unknown)(p, ...rest);
      };
      (fs as unknown as {readlinkSync: unknown}).readlinkSync = (p: unknown, ...rest: unknown[]) => {
        if (typeof p === 'string' && path.resolve(p) === target) {
          const error = new Error('denied') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return (origLink as (...args: unknown[]) => unknown)(p, ...rest);
      };
      return () => { (fs as unknown as {lstatSync: unknown}).lstatSync = origLstat; (fs as unknown as {readlinkSync: unknown}).readlinkSync = origLink; };
    }},
  ];
  for (const mode of patches) {
    const f = await toolkitRepo(); try {
      f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
      f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
      f.deps.liveness = {claude: true};
      f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
      await f.level('low'); await f.approve();
      const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
      fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
      assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
      const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
      assert.equal((await run()).output.reason, 'native-pending');
      const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
      const target = path.join(f.root, 'src/file.ts');
      fs.writeFileSync(target, 'edit for ' + mode.name + '\n');
      for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
      const restore = mode.patch(target);
      let done;
      try { done = await run(); } finally { restore(); }
      assert.equal(done.exit, 0, JSON.stringify(done.output) + ' ' + mode.name);
      assert.ok(done.value.repositoryCheck && done.value.repositoryCheck.state === 'unavailable', JSON.stringify(done.value) + ' ' + mode.name);
    } finally {f.cleanup();}
  }
});

test('repository changes carry the baseline across a superseded round', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    const launched = await run();
    assert.equal(launched.output.reason, 'native-pending');
    const review = launched.value.review as string;
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'edit before supersede\n');
    fs.appendFileSync(path.join(f.root,'work.spec.md'),'\nSupersede trigger\n');
    const superseded = await run();
    assert.equal(superseded.output.reason, 'native-pending', JSON.stringify(superseded.output));
    const gen1 = JSON.parse(fs.readFileSync(path.join(f.session,'.state/reviews',review,'round-1/gen-1/checkout-baseline.json'),'utf8'));
    const gen2Path = path.join(f.session,'.state/reviews',review,'round-1/gen-2/checkout-baseline.json');
    assert.ok(fs.existsSync(gen2Path), 'carried baseline exists');
    assert.deepEqual(JSON.parse(fs.readFileSync(gen2Path,'utf8')), gen1);
    for (const slot of superseded.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const waved = await run();
    assert.equal(waved.output.reason, 'native-pending', JSON.stringify(waved.output));
    for (const slot of waved.value.pending) {
      if (!fs.existsSync(slot.replyPath)) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    }
    const done = await run();
    assert.equal(done.exit, 0, JSON.stringify(done.output));
    const listed = (done.value.repositoryChanges ?? []).flatMap((entry: {paths: string[]}) => entry.paths);
    assert.ok(listed.includes('src/file.ts'), JSON.stringify(done.value.repositoryChanges));
  } finally {f.cleanup();}
  const g = await toolkitRepo(); try {
    g.deps.skillRoot = setupTestSkill(g.deps, g.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    g.deps.orchestrator = {platform: 'claude', model: null} as typeof g.deps.orchestrator;
    g.deps.liveness = {claude: true};
    g.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await g.level('low'); await g.approve();
    const made = await g.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(g.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await g.run(['worktree','submit','T1'])).exit, 0);
    const run = () => g.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    const launched = await run();
    assert.equal(launched.output.reason, 'native-pending');
    const review = launched.value.review as string;
    fs.rmSync(path.join(g.session,'.state/reviews',review,'round-1/gen-1/checkout-baseline.json'));
    fs.appendFileSync(path.join(g.root,'work.spec.md'),'\nSupersede trigger\n');
    const superseded = await run();
    assert.equal(superseded.output.reason, 'native-pending', JSON.stringify(superseded.output));
    const gen2 = JSON.parse(fs.readFileSync(path.join(g.session,'.state/reviews',review,'round-1/gen-2/checkout-baseline.json'),'utf8'));
    assert.equal(gen2.state, 'unavailable', 'a predecessor that launched a native voice but lost its baseline carries unavailable: ' + JSON.stringify(gen2));
    assert.match(gen2.reason, /missing after native launch/);
    for (const slot of superseded.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const waved = await run();
    assert.equal(waved.output.reason, 'native-pending', JSON.stringify(waved.output));
    for (const slot of waved.value.pending) {
      if (!fs.existsSync(slot.replyPath)) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    }
    const done = await run();
    assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(done.value.repositoryCheck && done.value.repositoryCheck.state === 'unavailable', 'a lost baseline reports unavailable instead of clean: ' + JSON.stringify(done.value));
    assert.ok(!done.value.repositoryChanges, JSON.stringify(done.value));
  } finally {g.cleanup();}
});

test('reused round number keeps a later report open and admits a whole-target rerun', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 1}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'rerun edit\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(done.value.repositoryChanges, JSON.stringify(done.value));
    const review = done.value.review as string;
    const roundDir = path.join(f.session,'.state/reviews',review,'round-1');
    await appendRecord(f.session, {kind: 'note', by: 'orchestrator', key: `repository-changes:${review}:1`, data: {text: 'explained'}}, f.deps);
    const closeSeq = foldLedger(f.session).records.findLast(row => row.kind === 'note' && row.key === `repository-changes:${review}:1`)!.seq;
    let status = await f.run(['status','show']);
    assert.ok(!status.value.openRepositoryChanges?.some((entry: {review: string; round: number}) => entry.review === review && entry.round === 1), 'the acknowledged report stays closed: ' + JSON.stringify(status.value.openRepositoryChanges));
    // A later report under the reused round number stays open. The rerun note
    // lands first, so its sequence strictly exceeds the closing note.
    await appendRecord(f.session, {kind: 'note', by: 'user', quote: 'Rerun after inspection', key: `repository-rerun:${review}:1`, data: {text: 'rerun'}}, f.deps);
    const laterSeq = foldLedger(f.session).lastSeq;
    assert.ok(laterSeq > closeSeq);
    fs.mkdirSync(path.join(roundDir,'gen-9'),{recursive:true});
    fs.writeFileSync(path.join(roundDir,'gen-9','checkout-report.json'), JSON.stringify({repositoryChanges: [{cwd: f.root, paths: ['src/file.ts']}], asOfSeq: laterSeq}));
    status = await f.run(['status','show']);
    const open = status.value.openRepositoryChanges.find((entry: {review: string; round: number}) => entry.review === review && entry.round === 1);
    assert.ok(open && open.rerunPending === true, 'a later report under a reused number stays open with rerunPending: ' + JSON.stringify(status.value.openRepositoryChanges));
    const rerun = await run();
    assert.equal(rerun.output.reason, 'native-pending', JSON.stringify(rerun.output));
    assert.equal(rerun.value.round, 2, 'the rerun grant admits round 2 above the cap');
    const round2 = JSON.parse(fs.readFileSync(path.join(f.session,'.state/reviews',review,'round-2/round.json'),'utf8'));
    assert.ok((round2.scope as string).startsWith('Full review'), 'a rerun runs at whole-target scope: ' + round2.scope);
    assert.deepEqual(round2.roster.filter((slot: {reserve: boolean}) => !slot.reserve).map((slot: {slot: string}) => slot.slot), ['claude[0]']);
  } finally {f.cleanup();}
  const g = await toolkitRepo(); try {
    g.deps.skillRoot = setupTestSkill(g.deps, g.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 1}}}});
    g.deps.orchestrator = {platform: 'claude', model: null} as typeof g.deps.orchestrator;
    g.deps.liveness = {claude: true};
    g.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await g.level('low'); await g.approve();
    const made = await g.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(g.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await g.run(['worktree','submit','T1'])).exit, 0);
    const run = () => g.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    fs.writeFileSync(path.join(g.root,'src/file.ts'),'rerun edit\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(done.value.repositoryChanges, JSON.stringify(done.value));
    const review = done.value.review as string;
    const roundDir = path.join(g.session,'.state/reviews',review,'round-1');
    await appendRecord(g.session, {kind: 'note', by: 'orchestrator', key: `repository-changes:${review}:1`, data: {text: 'explained'}}, g.deps);
    const closeSeq = foldLedger(g.session).records.findLast(row => row.kind === 'note' && row.key === `repository-changes:${review}:1`)!.seq;
    // No ledger record lands between the closing note and the later report:
    // the report carries the note's own sequence and still stays open.
    fs.mkdirSync(path.join(roundDir,'gen-9'),{recursive:true});
    fs.writeFileSync(path.join(roundDir,'gen-9','checkout-report.json'), JSON.stringify({repositoryChanges: [{cwd: g.root, paths: ['src/file.ts']}], asOfSeq: closeSeq}));
    let status = await g.run(['status','show']);
    const open = status.value.openRepositoryChanges.find((entry: {review: string; round: number}) => entry.review === review && entry.round === 1);
    assert.ok(open && open.rerunPending !== true, 'an equal-seq later report stays open: ' + JSON.stringify(status.value.openRepositoryChanges));
    await appendRecord(g.session, {kind: 'note', by: 'user', quote: 'Rerun after inspection', key: `repository-rerun:${review}:1`, data: {text: 'rerun'}}, g.deps);
    status = await g.run(['status','show']);
    assert.equal(status.value.openRepositoryChanges.find((entry: {review: string; round: number}) => entry.review === review && entry.round === 1)?.rerunPending, true);
    const rerun = await run();
    assert.equal(rerun.output.reason, 'native-pending', JSON.stringify(rerun.output));
    assert.equal(rerun.value.round, 2, 'the equal-seq report admits the rerun grant');
  } finally {g.cleanup();}
});

test('repository changes report unavailable for a corrupt baseline and keep replies', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    const review = waved.value.review as string;
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'edit before corrupt baseline\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    fs.writeFileSync(path.join(f.session,'.state/reviews',review,'round-1/gen-1/checkout-baseline.json'), 'null');
    const done = await run();
    assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(done.value.repositoryCheck && done.value.repositoryCheck.state === 'unavailable', 'a corrupt baseline reports unavailable: ' + JSON.stringify(done.value));
    assert.ok(!done.value.repositoryChanges, JSON.stringify(done.value));
  } finally {f.cleanup();}
});

test('cli-only superseded round runs no repository check and opens no report', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'cli-only-skill', {'read-delegates': {claude: {targets: [{low: {model: 'cli-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = null;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    // A spec edit during fan-out supersedes the in-flight round to gen-2;
    // with no native voice no baseline exists to carry, so gen-2 runs no check.
    let moved = false;
    const run = (hook?: (point: string) => Promise<void> | void) => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low'], hook);
    const first = await run(async point => { if (point === 'fanout:after-slot' && !moved) { moved = true; fs.appendFileSync(path.join(f.root,'work.spec.md'),'\nSupersede trigger\n'); } });
    assert.equal(first.output.reason, 'target-moved', JSON.stringify(first.output));
    const reviewDirs = fs.readdirSync(path.join(f.session,'.state/reviews'));
    assert.equal(reviewDirs.length, 1);
    const review = reviewDirs[0] as string;
    assert.ok(!fs.existsSync(path.join(f.session,'.state/reviews',review,'round-1/gen-2/checkout-baseline.json')), 'a cli-only supersede carries no baseline');
    const second = await run();
    assert.equal(second.exit, 0, JSON.stringify(second.output));
    assert.ok(!second.value.repositoryChanges, JSON.stringify(second.value));
    assert.ok(!second.value.repositoryCheck, JSON.stringify(second.value));
    const status = await f.run(['status','show']);
    assert.deepEqual(status.value.openRepositoryChanges ?? [], [], JSON.stringify(status.value.openRepositoryChanges));
  } finally {f.cleanup();}
});

test('all-failed retry preserves the first report when the second compare is clean', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'fail', cls: 'auth', detail: 'denied'}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    const review = waved.value.review as string;
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'change before all-failed\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, 'INVALID REPORT');
    const failed = await run();
    assert.equal(failed.output.reason, 'review-failed', JSON.stringify(failed.output));
    assert.match(failed.output.summary, /src\/file\.ts/);
    // Restore the changed path, then retry: the CLI still fails and the new
    // compare is clean, but the first unacknowledged report must stay open.
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'initial\n');
    const retry = await run();
    assert.equal(retry.output.reason, 'review-failed', JSON.stringify(retry.output));
    const first = JSON.parse(fs.readFileSync(path.join(f.session,'.state/reviews',review,'round-1/gen-1/checkout-report.json'),'utf8'));
    assert.ok((first.repositoryChanges ?? []).flatMap((entry: {paths: string[]}) => entry.paths).includes('src/file.ts'));
    const status = await f.run(['status','show']);
    const open = (status.value.openRepositoryChanges ?? []).flatMap((row: {repositoryChanges?: {paths: string[]}[]}) => (row.repositoryChanges ?? []).flatMap(entry => entry.paths));
    assert.ok(open.includes('src/file.ts'), 'the first report survives a clean retry: ' + JSON.stringify(status.value.openRepositoryChanges));
  } finally {f.cleanup();}
});

test('successful retry after all-failed keeps the first report until a closing note', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'fail', cls: 'auth', detail: 'denied'}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    const review = waved.value.review as string;
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'change before all-failed\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, 'INVALID REPORT');
    assert.equal((await run()).output.reason, 'review-failed');
    // Restore the path and recover the CLI: the retry finalizes cleanly, but
    // the failed report stays open until the orchestrator closes it.
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'initial\n');
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    const done = await run();
    assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(!done.value.repositoryChanges, 'the retry compare is clean: ' + JSON.stringify(done.value));
    let status = await f.run(['status','show']);
    assert.ok((status.value.openRepositoryChanges ?? []).some((entry: {review: string; round: number}) => entry.review === review && entry.round === 1),
      'the failed report stays open after a clean success: ' + JSON.stringify(status.value.openRepositoryChanges));
    await appendRecord(f.session, {kind: 'note', by: 'orchestrator', key: `repository-changes:${review}:1`, data: {text: 'explained'}}, f.deps);
    status = await f.run(['status','show']);
    assert.ok(!(status.value.openRepositoryChanges ?? []).some((entry: {review: string; round: number}) => entry.review === review && entry.round === 1),
      'a closing note clears the retained report: ' + JSON.stringify(status.value.openRepositoryChanges));
  } finally {f.cleanup();}
});

test('quoted rerun for an all-failed report starts a fresh whole-target round', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'fail', cls: 'auth', detail: 'denied'}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    const review = waved.value.review as string;
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'change before all-failed\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, 'INVALID REPORT');
    assert.equal((await run()).output.reason, 'review-failed');
    await appendRecord(f.session, {kind: 'note', by: 'user', quote: 'Rerun after inspection', key: `repository-rerun:${review}:1`, data: {text: 'rerun'}}, f.deps);
    const rerun = await run();
    assert.equal(rerun.output.reason, 'native-pending', 'the rerun note starts a fresh round: ' + JSON.stringify(rerun.output));
    assert.equal(rerun.value.round, 2);
    const round2 = JSON.parse(fs.readFileSync(path.join(f.session,'.state/reviews',review,'round-2/round.json'),'utf8'));
    assert.ok((round2.scope as string).startsWith('Full review'), 'a rerun runs at whole-target scope: ' + round2.scope);
    assert.deepEqual(round2.roster.filter((slot: {reserve: boolean}) => !slot.reserve).map((slot: {slot: string}) => slot.slot), ['claude[0]']);
    // The failed report stays open with rerunPending until the rerun completes.
    let status = await f.run(['status','show']);
    const open = status.value.openRepositoryChanges.find((entry: {review: string; round: number}) => entry.review === review && entry.round === 1);
    assert.ok(open && open.rerunPending === true, 'the failed report waits for its rerun: ' + JSON.stringify(status.value.openRepositoryChanges));
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    const waved2 = await run(); assert.equal(waved2.output.reason, 'native-pending');
    for (const slot of waved2.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const finished = await run();
    assert.equal(finished.exit, 0, JSON.stringify(finished.output));
    status = await f.run(['status','show']);
    assert.ok(!(status.value.openRepositoryChanges ?? []).some((entry: {review: string; round: number}) => entry.review === review && entry.round === 1),
      'the failed report clears once its rerun finalizes: ' + JSON.stringify(status.value.openRepositoryChanges));
  } finally {f.cleanup();}
});

test('one per-report note closes a report from normal finalization', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'finalized edit\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(done.value.repositoryChanges, JSON.stringify(done.value));
    const review = done.value.review as string;
    const roundDir = path.join(f.session,'.state/reviews',review,'round-1');
    const checkout = JSON.parse(fs.readFileSync(path.join(roundDir,'gen-1/checkout-report.json'),'utf8'));
    const finalized = JSON.parse(fs.readFileSync(done.value.path,'utf8'));
    assert.equal(finalized.asOfSeq, checkout.asOfSeq, 'the finalized findings copy carries the report identity');
    let status = await f.run(['status','show']);
    assert.ok(status.value.openRepositoryChanges?.some((entry: {review: string; round: number}) => entry.review === review && entry.round === 1),
      'the finalized report starts open: ' + JSON.stringify(status.value.openRepositoryChanges));
    await appendRecord(f.session, {kind: 'note', by: 'orchestrator', key: `repository-changes:${review}:1:${checkout.asOfSeq}`, data: {text: 'explained'}}, f.deps);
    status = await f.run(['status','show']);
    assert.ok(!status.value.openRepositoryChanges?.some((entry: {review: string; round: number}) => entry.review === review && entry.round === 1),
      'one per-report note closes the finalized report: ' + JSON.stringify(status.value.openRepositoryChanges));
  } finally {f.cleanup();}
});

test('a suffixed rerun decision admits the next round above the cap', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 1}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'rerun edit\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.ok(done.value.repositoryChanges, JSON.stringify(done.value));
    const review = done.value.review as string;
    const checkout = JSON.parse(fs.readFileSync(path.join(f.session,'.state/reviews',review,'round-1/gen-1/checkout-report.json'),'utf8'));
    await appendRecord(f.session, {kind: 'note', by: 'user', quote: 'Rerun after inspection', key: `repository-rerun:${review}:1:${checkout.asOfSeq}`, data: {text: 'rerun'}}, f.deps);
    const status = await f.run(['status','show']);
    const open = status.value.openRepositoryChanges.find((entry: {review: string; round: number}) => entry.review === review && entry.round === 1);
    assert.ok(open && open.rerunPending === true, 'the suffixed rerun decision binds the current report: ' + JSON.stringify(status.value.openRepositoryChanges));
    const rerun = await run();
    assert.equal(rerun.output.reason, 'native-pending', 'the suffixed rerun decision admits round 2 above the cap: ' + JSON.stringify(rerun.output));
    assert.equal(rerun.value.round, 2);
  } finally {f.cleanup();}
});

test('a suffixed rerun decision restarts an all-failed round at whole-target scope', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'fail', cls: 'auth', detail: 'denied'}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    const review = waved.value.review as string;
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'change before all-failed\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, 'INVALID REPORT');
    assert.equal((await run()).output.reason, 'review-failed');
    const checkout = JSON.parse(fs.readFileSync(path.join(f.session,'.state/reviews',review,'round-1/gen-1/checkout-report.json'),'utf8'));
    await appendRecord(f.session, {kind: 'note', by: 'user', quote: 'Rerun after inspection', key: `repository-rerun:${review}:1:${checkout.asOfSeq}`, data: {text: 'rerun'}}, f.deps);
    const rerun = await run();
    assert.equal(rerun.output.reason, 'native-pending', 'the suffixed rerun note starts a fresh round: ' + JSON.stringify(rerun.output));
    assert.equal(rerun.value.round, 2);
    const round2 = JSON.parse(fs.readFileSync(path.join(f.session,'.state/reviews',review,'round-2/round.json'),'utf8'));
    assert.ok((round2.scope as string).startsWith('Full review'), 'a suffixed rerun runs at whole-target scope: ' + round2.scope);
    assert.deepEqual(round2.roster.filter((slot: {reserve: boolean}) => !slot.reserve).map((slot: {slot: string}) => slot.slot), ['claude[0]']);
  } finally {f.cleanup();}
});

test('repository changes list a changed root path named __proto__', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    fs.writeFileSync(path.join(f.root,'__proto__'),'proto edit during round\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run();
    assert.equal(done.exit, 0, JSON.stringify(done.output));
    const listed = (done.value.repositoryChanges ?? []).flatMap((entry: {paths: string[]}) => entry.paths);
    assert.ok(listed.includes('__proto__'), 'the adversarial path is listed: ' + JSON.stringify(done.value.repositoryChanges));
  } finally {f.cleanup();}
});

test('repository changes hash a multi-chunk file without a full-file read', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    // A file larger than one hash chunk exists before launch; only one byte
    // beyond the first chunk changes during the round.
    const big = path.join(f.root,'src','big.bin');
    fs.writeFileSync(big, 'x'.repeat(200 * 1024));
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    const bytes = fs.readFileSync(big);
    bytes[100 * 1024] = 'y'.charCodeAt(0);
    fs.writeFileSync(big, bytes);
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run();
    assert.equal(done.exit, 0, JSON.stringify(done.output));
    const listed = (done.value.repositoryChanges ?? []).flatMap((entry: {paths: string[]}) => entry.paths);
    assert.ok(listed.includes('src/big.bin'), 'the change beyond the first chunk is listed: ' + JSON.stringify(done.value.repositoryChanges));
  } finally {f.cleanup();}
});

test('checkout reports gate sequences on content and order generations numerically', async () => {
  const f = await toolkitRepo(); try {
    await f.level('low'); await f.approve();
    const review = 'demo-review';
    const roundDir = path.join(f.session,'.state/reviews',review,'round-1');
    fs.mkdirSync(path.join(roundDir,'gen-1'),{recursive:true});
    fs.mkdirSync(path.join(roundDir,'gen-2'),{recursive:true});
    fs.mkdirSync(path.join(roundDir,'gen-10'),{recursive:true});
    fs.writeFileSync(path.join(roundDir,'gen-1/checkout-report.json'), JSON.stringify({repositoryChanges:[{cwd:'c',paths:['old-path']}],asOfSeq:1}));
    fs.writeFileSync(path.join(roundDir,'gen-2/checkout-report.json'), JSON.stringify({repositoryChanges:[{cwd:'c',paths:['mid-path']}],asOfSeq:2}));
    await appendRecord(f.session, {kind: 'note', by: 'orchestrator', key: `repository-changes:${review}:1`, data: {text: 'explained'}}, f.deps);
    const reported = async () => (await f.run(['status','show'])).value.openRepositoryChanges ?? [];
    assert.deepEqual(await reported(), [], 'the acknowledged report stays closed');
    // A clean later generation must not inflate the sequence past the note.
    fs.writeFileSync(path.join(roundDir,'gen-10/checkout-report.json'), JSON.stringify({asOfSeq:999}));
    assert.deepEqual(await reported(), [], 'a clean generation keeps the report closed');
    // A newer content report under a reused number reopens; attempts merge and
    // the numerically latest generation wins the display.
    fs.writeFileSync(path.join(roundDir,'gen-10/checkout-report-2.json'), JSON.stringify({repositoryChanges:[{cwd:'c',paths:['new-path']}],asOfSeq:1000}));
    fs.writeFileSync(path.join(roundDir,'gen-10/checkout-report-10.json'), JSON.stringify({repositoryChanges:[{cwd:'c',paths:['late-path']}],asOfSeq:1001}));
    const open = await reported();
    assert.equal(open.length, 1, JSON.stringify(open));
    assert.deepEqual((open[0].repositoryChanges ?? []).flatMap((entry: {paths: string[]}) => entry.paths).sort(), ['late-path','new-path']);
  } finally {f.cleanup();}
});

test('two separately closed reports in one reused round stay closed', async () => {
  const f = await toolkitRepo(); try {
    await f.level('low'); await f.approve();
    const review = 'demo-report-close2';
    const roundDir = path.join(f.session,'.state/reviews',review,'round-1');
    fs.mkdirSync(path.join(roundDir,'gen-1'),{recursive:true});
    fs.mkdirSync(path.join(roundDir,'gen-2'),{recursive:true});
    const reported = async () => (await f.run(['status','show'])).value.openRepositoryChanges ?? [];
    const seqA = foldLedger(f.session).lastSeq;
    fs.writeFileSync(path.join(roundDir,'gen-1/checkout-report.json'), JSON.stringify({repositoryChanges:[{cwd:'c',paths:['a-path']}],asOfSeq:seqA}));
    let open = await reported();
    assert.equal(open.length, 1, JSON.stringify(open));
    assert.equal(open[0].reportSeq, seqA);
    await appendRecord(f.session, {kind: 'note', by: 'orchestrator', key: `repository-changes:${review}:1:${seqA}`, data: {text: 'explained A'}}, f.deps);
    assert.deepEqual(await reported(), [], 'the first per-report close holds');
    const seqB = foldLedger(f.session).lastSeq;
    fs.writeFileSync(path.join(roundDir,'gen-2/checkout-report.json'), JSON.stringify({repositoryChanges:[{cwd:'c',paths:['b-path']}],asOfSeq:seqB}));
    open = await reported();
    assert.equal(open.length, 1, JSON.stringify(open));
    assert.deepEqual((open[0].repositoryChanges ?? []).flatMap((entry: {paths: string[]}) => entry.paths), ['b-path']);
    await appendRecord(f.session, {kind: 'note', by: 'orchestrator', key: `repository-changes:${review}:1:${seqB}`, data: {text: 'explained B'}}, f.deps);
    assert.deepEqual(await reported(), [], 'the second per-report close holds while the first stays closed');
  } finally {f.cleanup();}
});

test('later changed paths merge with the finalized findings report', async () => {
  const f = await toolkitRepo(); try {
    await f.level('low'); await f.approve();
    const review = 'demo-merge-paths';
    const roundDir = path.join(f.session,'.state/reviews',review,'round-1');
    fs.mkdirSync(path.join(roundDir,'gen-1'),{recursive:true});
    const seqA = foldLedger(f.session).lastSeq;
    fs.writeFileSync(path.join(roundDir,'gen-1/checkout-report.json'), JSON.stringify({repositoryChanges:[{cwd:'c',paths:['a-path']}],asOfSeq:seqA}));
    const seqB = seqA + 1;
    fs.writeFileSync(path.join(roundDir,'findings.json'), JSON.stringify({review, round:1, cap:1, level:'low', findings:[], clusters:[], failed:[],
      repositoryChanges:[{cwd:'c',paths:['b-path']}], budget:{asOfSeq:seqB}}));
    const open = (await f.run(['status','show'])).value.openRepositoryChanges ?? [];
    assert.equal(open.length, 1, JSON.stringify(open));
    assert.deepEqual((open[0].repositoryChanges ?? []).flatMap((entry: {paths: string[]}) => entry.paths).sort(), ['a-path','b-path']);
  } finally {f.cleanup();}
});

test('later unavailable checks merge with earlier changed paths', async () => {
  const f = await toolkitRepo(); try {
    await f.level('low'); await f.approve();
    const reported = async (review: string) => ((await f.run(['status','show'])).value.openRepositoryChanges ?? []).find((entry: {review: string}) => entry.review === review);
    // A finalized unavailable check keeps the earlier attempt paths.
    const first = 'demo-merge-check';
    const firstDir = path.join(f.session,'.state/reviews',first,'round-1');
    fs.mkdirSync(path.join(firstDir,'gen-1'),{recursive:true});
    const seqA = foldLedger(f.session).lastSeq;
    fs.writeFileSync(path.join(firstDir,'gen-1/checkout-report.json'), JSON.stringify({repositoryChanges:[{cwd:'c',paths:['a-path']}],asOfSeq:seqA}));
    fs.writeFileSync(path.join(firstDir,'findings.json'), JSON.stringify({review: first, round:1, cap:1, level:'low', findings:[], clusters:[], failed:[],
      repositoryCheck:{state:'unavailable',reason:'compare failed'}, budget:{asOfSeq:seqA + 1}}));
    let open = await reported(first);
    assert.ok(open, 'the merged report stays open');
    assert.deepEqual((open.repositoryChanges ?? []).flatMap((entry: {paths: string[]}) => entry.paths), ['a-path']);
    assert.equal(open.repositoryCheck?.state, 'unavailable');
    // An earlier unavailable attempt survives a later finalized path report.
    const second = 'demo-merge-check2';
    const secondDir = path.join(f.session,'.state/reviews',second,'round-1');
    fs.mkdirSync(path.join(secondDir,'gen-1'),{recursive:true});
    const seqC = foldLedger(f.session).lastSeq;
    fs.writeFileSync(path.join(secondDir,'gen-1/checkout-report.json'), JSON.stringify({repositoryCheck:{state:'unavailable',reason:'capture failed'},asOfSeq:seqC}));
    fs.writeFileSync(path.join(secondDir,'findings.json'), JSON.stringify({review: second, round:1, cap:1, level:'low', findings:[], clusters:[], failed:[],
      repositoryChanges:[{cwd:'c',paths:['b-path']}], budget:{asOfSeq:seqC + 1}}));
    open = await reported(second);
    assert.ok(open, 'the merged report stays open');
    assert.deepEqual((open.repositoryChanges ?? []).flatMap((entry: {paths: string[]}) => entry.paths), ['b-path']);
    assert.equal(open.repositoryCheck?.state, 'unavailable');
  } finally {f.cleanup();}
});

test('two failed generations with different paths both stay open', async () => {
  const f = await toolkitRepo(); try {
    await f.level('low'); await f.approve();
    const review = 'demo-merge-gens';
    const roundDir = path.join(f.session,'.state/reviews',review,'round-1');
    fs.mkdirSync(path.join(roundDir,'gen-1'),{recursive:true});
    fs.mkdirSync(path.join(roundDir,'gen-2'),{recursive:true});
    const seq = foldLedger(f.session).lastSeq;
    fs.writeFileSync(path.join(roundDir,'gen-1/checkout-report.json'), JSON.stringify({repositoryChanges:[{cwd:'c',paths:['a-path']}],asOfSeq:seq}));
    fs.writeFileSync(path.join(roundDir,'gen-2/checkout-report.json'), JSON.stringify({repositoryChanges:[{cwd:'c',paths:['b-path']}],asOfSeq:seq + 1}));
    const open = (await f.run(['status','show'])).value.openRepositoryChanges ?? [];
    assert.equal(open.length, 1, JSON.stringify(open));
    assert.deepEqual((open[0].repositoryChanges ?? []).flatMap((entry: {paths: string[]}) => entry.paths).sort(), ['a-path','b-path']);
  } finally {f.cleanup();}
});

test('a stale rerun decision grants nothing for a later report', async () => {
  const {admission} = await import('../../skills/dispatch/scripts/toolkit/findings.ts');
  const f = await toolkitRepo(); try {
    await f.level('low'); await f.approve();
    const review = 'demo-stale-rerun';
    const roundDir = path.join(f.session,'.state/reviews',review,'round-1');
    fs.mkdirSync(path.join(roundDir,'gen-1'),{recursive:true});
    fs.writeFileSync(path.join(roundDir,'round.json'), JSON.stringify({cap:1}));
    const seqA = foldLedger(f.session).lastSeq;
    fs.writeFileSync(path.join(roundDir,'gen-1/checkout-report.json'), JSON.stringify({repositoryChanges:[{cwd:'c',paths:['a-path']}],asOfSeq:seqA}));
    await appendRecord(f.session, {kind: 'note', by: 'user', quote: 'Rerun after inspection', key: `repository-rerun:${review}:1`, data: {text: 'rerun'}}, f.deps);
    await appendRecord(f.session, {kind: 'note', by: 'orchestrator', key: `repository-changes:${review}:1:${seqA}`, data: {text: 'explained A'}}, f.deps);
    const seqB = foldLedger(f.session).lastSeq;
    fs.mkdirSync(path.join(roundDir,'gen-2'),{recursive:true});
    fs.writeFileSync(path.join(roundDir,'gen-2/checkout-report.json'), JSON.stringify({repositoryChanges:[{cwd:'c',paths:['b-path']}],asOfSeq:seqB}));
    const open = ((await f.run(['status','show'])).value.openRepositoryChanges ?? []).find((entry: {review: string}) => entry.review === review);
    assert.ok(open, 'the later report stays open');
    assert.deepEqual((open.repositoryChanges ?? []).flatMap((entry: {paths: string[]}) => entry.paths), ['b-path']);
    assert.equal(open.rerunPending, undefined, 'the stale rerun decision leaves no rerunPending: ' + JSON.stringify(open));
    const {budget} = admission(f.session, foldLedger(f.session), review, 1);
    assert.equal(budget.nextRound, 1, 'the stale rerun decision admits no round above the cap: ' + JSON.stringify(budget));
  } finally {f.cleanup();}
});

test('a quoted rerun for the remaining open report is honored after a later report closes', async () => {
  const {admission} = await import('../../skills/dispatch/scripts/toolkit/findings.ts');
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 1}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'covered edit\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    const review = done.value.review as string;
    const roundDir = path.join(f.session,'.state/reviews',review,'round-1');
    const checkout = JSON.parse(fs.readFileSync(path.join(roundDir,'gen-1/checkout-report.json'),'utf8'));
    const seqA = checkout.asOfSeq as number;
    // A later generation reports again under the reused round number.
    await f.level('low');
    const seqB = foldLedger(f.session).lastSeq;
    assert.ok(seqB > seqA, 'the later report carries a distinct later identity');
    fs.mkdirSync(path.join(roundDir,'gen-9'),{recursive:true});
    fs.writeFileSync(path.join(roundDir,'gen-9/checkout-report.json'), JSON.stringify({repositoryChanges: [{cwd: f.root, paths: ['src/other.ts']}], asOfSeq: seqB}));
    await appendRecord(f.session, {kind: 'note', by: 'orchestrator', key: `repository-changes:${review}:1:${seqB}`, data: {text: 'explained later'}}, f.deps);
    await appendRecord(f.session, {kind: 'note', by: 'user', quote: 'Rerun after inspection', key: `repository-rerun:${review}:1:${seqA}`, data: {text: 'rerun open'}}, f.deps);
    const open = ((await f.run(['status','show'])).value.openRepositoryChanges ?? []).find((entry: {review: string; round: number}) => entry.review === review && entry.round === 1);
    assert.ok(open, 'the remaining report stays open');
    assert.equal(open.reportSeq, seqA, 'the open entry binds the remaining report: ' + JSON.stringify(open));
    assert.equal(open.rerunPending, true, 'the quoted rerun for the remaining report marks rerunPending: ' + JSON.stringify(open));
    const {budget} = admission(f.session, foldLedger(f.session), review, 1);
    assert.equal(budget.nextRound, 2, 'the quoted rerun admits the next round above the cap: ' + JSON.stringify(budget));
    assert.equal(budget.state, 'allowed');
    const rerun = await run();
    assert.equal(rerun.output.reason, 'native-pending', 'the quoted rerun starts round 2: ' + JSON.stringify(rerun.output));
    assert.equal(rerun.value.round, 2);
  } finally {f.cleanup();}
});

test('a stale rerun note for a closed later report authorizes nothing', async () => {
  const {admission} = await import('../../skills/dispatch/scripts/toolkit/findings.ts');
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 1}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'covered edit\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, JSON.stringify(CLEAN));
    const done = await run(); assert.equal(done.exit, 0, JSON.stringify(done.output));
    const review = done.value.review as string;
    const roundDir = path.join(f.session,'.state/reviews',review,'round-1');
    const checkout = JSON.parse(fs.readFileSync(path.join(roundDir,'gen-1/checkout-report.json'),'utf8'));
    const seqA = checkout.asOfSeq as number;
    await f.level('low');
    const seqB = foldLedger(f.session).lastSeq;
    assert.ok(seqB > seqA, 'the later report carries a distinct later identity');
    fs.mkdirSync(path.join(roundDir,'gen-9'),{recursive:true});
    fs.writeFileSync(path.join(roundDir,'gen-9/checkout-report.json'), JSON.stringify({repositoryChanges: [{cwd: f.root, paths: ['src/other.ts']}], asOfSeq: seqB}));
    await appendRecord(f.session, {kind: 'note', by: 'orchestrator', key: `repository-changes:${review}:1:${seqB}`, data: {text: 'explained later'}}, f.deps);
    await appendRecord(f.session, {kind: 'note', by: 'user', quote: 'Rerun after inspection', key: `repository-rerun:${review}:1:${seqB}`, data: {text: 'rerun closed'}}, f.deps);
    const open = ((await f.run(['status','show'])).value.openRepositoryChanges ?? []).find((entry: {review: string; round: number}) => entry.review === review && entry.round === 1);
    assert.ok(open, 'the remaining report stays open');
    assert.equal(open.reportSeq, seqA, 'the open entry binds the remaining report: ' + JSON.stringify(open));
    assert.equal(open.rerunPending, undefined, 'a stale note for the closed report leaves no rerunPending: ' + JSON.stringify(open));
    const {budget} = admission(f.session, foldLedger(f.session), review, 1);
    assert.equal(budget.state, 'requires-continuation', 'a stale note for the closed report admits no round: ' + JSON.stringify(budget));
    const refused = await run();
    assert.equal(refused.output.reason, 'round-cap', 'a stale note for the closed report starts no round: ' + JSON.stringify(refused.output));
  } finally {f.cleanup();}
});

test('a host change past a pending reserve finalizes with a reply a fallback and a failure', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'mixed-skill', {'read-delegates': {
      claude: {targets: [{low: {model: 'native-model'}}]},
      agy: {targets: [{low: {model: 'cli-model'}}]},
      codex: {targets: [{low: {model: 'cli-model'}}]},
      copilot: {targets: [{low: {model: 'cli-model'}}]},
    }, phases: {'code-review': {targets: {low: 3}, rounds: {low: 1}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true, agy: true, codex: true, copilot: true};
    const launches: {provider: string; targetSlot: string | undefined}[] = [];
    f.deps.delegate = async (provider, request) => {
      launches.push({provider, targetSlot: (request as {targetSlot?: string}).targetSlot});
      if (provider === 'copilot') return {outcome: {status: 'fail', cls: 'config', detail: 'unsupported'}, invocations: []};
      if (provider === 'codex') return {outcome: {status: 'fail', cls: 'auth', detail: 'denied'}, invocations: []};
      return {outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []};
    };
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    const launched = await run();
    assert.equal(launched.output.reason, 'native-pending');
    const reservePending = (launched.value.pending as {slot: string; attempt: string}[]).find(slot => slot.slot === 'codex[0]');
    assert.equal(reservePending !== undefined, true, 'codex fails into the host reserve: ' + JSON.stringify(launched.value.pending));
    assert.ok(reservePending!.attempt.startsWith('claude[0]#'), 'the pending voice runs on the host reserve: ' + reservePending!.attempt);
    // The session moves to the agy host before the reserve completes. agy
    // turns native-first while codex keeps its pending claude reserve attempt.
    f.deps.orchestrator = {platform: 'agy', model: null} as typeof f.deps.orchestrator;
    const resumed = await f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low',
      '--native-failed', reservePending!.attempt + '=BLOCKED: old host denied']);
    assert.equal(resumed.exit, 0, 'every saved outcome returns, so the round finalizes: ' + JSON.stringify(resumed.output));
    const finalized = JSON.parse(fs.readFileSync(resumed.value.path,'utf8'));
    assert.deepEqual((finalized.failed as {slot: string}[]).map(entry => entry.slot), ['copilot[0]'],
      'the reply, the reserve fallback and the failure all reach finalization: ' + JSON.stringify(finalized.failed));
    assert.ok(launches.some(launch => launch.provider === 'claude' && launch.targetSlot === 'codex[0]'),
      'the pending reserve falls back through its physical cli: ' + JSON.stringify(launches));
  } finally {f.cleanup();}
});

test('an interrupted cli voice resumes with its saved reserve after a host change', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'mixed-skill', {'read-delegates': {
      claude: {targets: [{low: {model: 'native-model'}}]},
      agy: {targets: [{low: {model: 'cli-model'}}]},
      codex: {targets: [{low: {model: 'cli-model'}}]},
      copilot: {targets: [{low: {model: 'cli-model'}}]},
    }, phases: {'code-review': {targets: {low: 3}, rounds: {low: 1}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true, agy: true, codex: true, copilot: true};
    const launches: string[] = [];
    f.deps.delegate = async (provider) => {
      launches.push(provider);
      if (provider === 'copilot') return {outcome: {status: 'fail', cls: 'config', detail: 'unsupported'}, invocations: []};
      if (provider === 'codex') return {outcome: {status: 'fail', cls: 'auth', detail: 'denied'}, invocations: []};
      return {outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []};
    };
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    const launched = await run();
    assert.equal(launched.output.reason, 'native-pending');
    assert.ok((launched.value.pending as {slot: string}[]).some(slot => slot.slot === 'codex[0]'), 'codex holds the host reserve: ' + JSON.stringify(launched.value.pending));
    // The wave is interrupted before the copilot voice settles: its save is
    // lost while agy stays done and codex keeps its pending host reserve.
    const reviewsRoot = path.join(f.session, '.state/reviews');
    const reviewDir = path.join(reviewsRoot, fs.readdirSync(reviewsRoot)[0]!);
    fs.unlinkSync(path.join(reviewDir, 'round-1/gen-1/slots', 'copilot[0].json'));
    // The session resumes on the agy host with no failure report.
    f.deps.orchestrator = {platform: 'agy', model: null} as typeof f.deps.orchestrator;
    const resumed = await run();
    assert.equal(resumed.exit, 0, 'the round finalizes instead of dropping the interrupted voice: ' + JSON.stringify(resumed.output));
    const finalized = JSON.parse(fs.readFileSync(resumed.value.path,'utf8'));
    assert.deepEqual((finalized.failed as {slot: string}[]).map(entry => entry.slot), ['copilot[0]'],
      'the interrupted voice reaches finalization: ' + JSON.stringify(finalized.failed));
    assert.ok(launches.includes('claude'), 'the saved reserve falls back through its physical cli: ' + JSON.stringify(launches));
  } finally {f.cleanup();}
});

test('a partial cli-only round resumed on a new host keeps every voice', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'plain-skill', {'read-delegates': {
      agy: {targets: [{low: {model: 'cli-model'}}]},
      codex: {targets: [{low: {model: 'cli-model'}}]},
      copilot: {targets: [{low: {model: 'cli-model'}}]},
    }, phases: {'code-review': {targets: {low: 3}, rounds: {low: 1}}}});
    // The first host is not among the roster targets, so the round runs its
    // plain cli wave with no native voice.
    f.deps.orchestrator = {platform: 'opencode', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {agy: true, codex: true, copilot: true};
    f.deps.delegate = async (provider) => {
      if (provider === 'copilot') return {outcome: {status: 'fail', cls: 'config', detail: 'unsupported'}, invocations: []};
      return {outcome: {status: 'ok', text: JSON.stringify(CLEAN), resume: null, sessionId: null}, invocations: []};
    };
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    const first = await run();
    assert.equal(first.exit, 0, 'the plain cli wave finalizes: ' + JSON.stringify(first.output));
    // The round is interrupted after only agy settles; codex and copilot never
    // saved an outcome. The session resumes on the agy host, which is one of
    // the completed targets.
    const reviewsRoot = path.join(f.session, '.state/reviews');
    const reviewDir = path.join(reviewsRoot, fs.readdirSync(reviewsRoot)[0]!);
    const slotsDir = path.join(reviewDir, 'round-1/gen-1/slots');
    fs.unlinkSync(path.join(slotsDir, 'codex[0].json'));
    fs.unlinkSync(path.join(slotsDir, 'copilot[0].json'));
    fs.rmSync(path.join(reviewDir, 'round-1/findings.json'), {force: true});
    f.deps.orchestrator = {platform: 'agy', model: null} as typeof f.deps.orchestrator;
    const resumed = await run();
    assert.equal(resumed.exit, 0, 'the resumed round finalizes instead of dropping voices: ' + JSON.stringify(resumed.output));
    const finalized = JSON.parse(fs.readFileSync(resumed.value.path,'utf8'));
    assert.deepEqual((finalized.failed as {slot: string}[]).map(entry => entry.slot), ['copilot[0]'],
      'the unsaved voices run instead of being dropped: ' + JSON.stringify(finalized.failed));
  } finally {f.cleanup();}
});

test('an ordinary differential round leaves the sibling open without a rerun binding', async () => {
  const f = await toolkitRepo(); try {
    await f.level('low'); await f.approve();
    const review = 'demo-sibling-close';
    const roundDir = path.join(f.session,'.state/reviews',review,'round-1');
    fs.mkdirSync(path.join(roundDir,'gen-1'),{recursive:true});
    fs.mkdirSync(path.join(roundDir,'gen-2'),{recursive:true});
    fs.writeFileSync(path.join(roundDir,'round.json'), JSON.stringify({round:1,cap:1,startSeq:foldLedger(f.session).lastSeq,generation:1,roster:[{slot:'claude[0]',provider:'claude',index:0}],scope:'Full review'}));
    const seqA = foldLedger(f.session).lastSeq;
    fs.writeFileSync(path.join(roundDir,'gen-1/checkout-report.json'), JSON.stringify({repositoryChanges:[{cwd:'c',paths:['a-path']}],asOfSeq:seqA}));
    await f.level('low');
    const seqB = foldLedger(f.session).lastSeq;
    fs.writeFileSync(path.join(roundDir,'gen-2/checkout-report.json'), JSON.stringify({repositoryChanges:[{cwd:'c',paths:['b-path']}],asOfSeq:seqB}));
    assert.ok(seqB > seqA, 'the two reports carry distinct identities');
    // The user records a rerun decision for the earlier report while the
    // later one is still open.
    await appendRecord(f.session, {kind: 'note', by: 'user', quote: 'Rerun after inspection', key: `repository-rerun:${review}:1:${seqA}`, data: {text: 'rerun open'}}, f.deps);
    const noteSeq = foldLedger(f.session).lastSeq;
    // Round 2 finalizes at ordinary differential scope, not the rerun.
    const round2Dir = path.join(f.session,'.state/reviews',review,'round-2');
    fs.mkdirSync(path.join(round2Dir,'gen-1'),{recursive:true});
    fs.writeFileSync(path.join(round2Dir,'round.json'), JSON.stringify({round:2,cap:1,startSeq:noteSeq,generation:1,roster:[{slot:'claude[0]',provider:'claude',index:0}],scope:'Re-review round 2 (full) — changed: x; comparison: a..b'}));
    fs.writeFileSync(path.join(round2Dir,'findings.json'), JSON.stringify({review,round:2,findings:[],clusters:[],failed:[]}));
    // Closing the sibling report leaves the remaining report open, but round
    // 2 already finalized past the executable rerun window: the entry carries
    // no rerun binding and closes with a repository-changes note.
    await appendRecord(f.session, {kind: 'note', by: 'orchestrator', key: `repository-changes:${review}:1:${seqB}`, data: {text: 'explained later'}}, f.deps);
    const open = ((await f.run(['status','show'])).value.openRepositoryChanges ?? []).find((entry: {review: string; round: number}) => entry.review === review && entry.round === 1);
    assert.ok(open, 'the remaining report stays open');
    assert.equal(open.reportSeq, seqA, 'the open entry binds the remaining report: ' + JSON.stringify(open));
    assert.equal(open.rerunPending, undefined, 'a finalized round 2 leaves no rerun binding: ' + JSON.stringify(open));
    await appendRecord(f.session, {kind: 'note', by: 'orchestrator', key: `repository-changes:${review}:1:${seqA}`, data: {text: 'explained earlier'}}, f.deps);
    const closed = ((await f.run(['status','show'])).value.openRepositoryChanges ?? []).filter((entry: {review: string; round: number}) => entry.review === review && entry.round === 1);
    assert.deepEqual(closed, [], 'a changes note closes the remaining report: ' + JSON.stringify(closed));
  } finally {f.cleanup();}
});

test('a rerun note past the executable window leaves the sibling open for a changes note', async () => {
  const f = await toolkitRepo(); try {
    await f.level('low'); await f.approve();
    const review = 'demo-sibling-final-window';
    const roundDir = path.join(f.session,'.state/reviews',review,'round-1');
    fs.mkdirSync(path.join(roundDir,'gen-1'),{recursive:true});
    fs.mkdirSync(path.join(roundDir,'gen-2'),{recursive:true});
    fs.writeFileSync(path.join(roundDir,'round.json'), JSON.stringify({round:1,cap:1,startSeq:foldLedger(f.session).lastSeq,generation:1,roster:[{slot:'claude[0]',provider:'claude',index:0}],scope:'Full review'}));
    const seqA = foldLedger(f.session).lastSeq;
    fs.writeFileSync(path.join(roundDir,'gen-1/checkout-report.json'), JSON.stringify({repositoryChanges:[{cwd:'c',paths:['a-path']}],asOfSeq:seqA}));
    await f.level('low');
    const seqB = foldLedger(f.session).lastSeq;
    fs.writeFileSync(path.join(roundDir,'gen-2/checkout-report.json'), JSON.stringify({repositoryChanges:[{cwd:'c',paths:['b-path']}],asOfSeq:seqB}));
    assert.ok(seqB > seqA, 'the two reports carry distinct identities');
    // The rerun for the later report finalizes round 2 at whole-target scope.
    await appendRecord(f.session, {kind: 'note', by: 'user', quote: 'Rerun after inspection', key: `repository-rerun:${review}:1:${seqB}`, data: {text: 'rerun later'}}, f.deps);
    const noteSeq = foldLedger(f.session).lastSeq;
    const round2Dir = path.join(f.session,'.state/reviews',review,'round-2');
    fs.mkdirSync(path.join(round2Dir,'gen-1'),{recursive:true});
    fs.writeFileSync(path.join(round2Dir,'round.json'), JSON.stringify({round:2,cap:1,startSeq:noteSeq,generation:1,roster:[{slot:'claude[0]',provider:'claude',index:0}],scope:'Full review — changed paths: b-path; comparison: a..b'}));
    fs.writeFileSync(path.join(round2Dir,'findings.json'), JSON.stringify({review,round:2,findings:[],clusters:[],failed:[]}));
    const open = ((await f.run(['status','show'])).value.openRepositoryChanges ?? []).find((entry: {review: string; round: number}) => entry.review === review && entry.round === 1);
    assert.ok(open, 'the earlier report stays open after the later rerun satisfies');
    assert.equal(open.reportSeq, seqA, 'the open entry binds the remaining report: ' + JSON.stringify(open));
    assert.equal(open.rerunPending, undefined, 'the remaining sibling carries no rerun binding: ' + JSON.stringify(open));
    // A rerun decision recorded after round 2 finalized cannot execute, so it
    // adds no binding; only a repository-changes note closes the report.
    await appendRecord(f.session, {kind: 'note', by: 'user', quote: 'Rerun after inspection', key: `repository-rerun:${review}:1:${seqA}`, data: {text: 'rerun past window'}}, f.deps);
    const reopened = ((await f.run(['status','show'])).value.openRepositoryChanges ?? []).find((entry: {review: string; round: number}) => entry.review === review && entry.round === 1);
    assert.ok(reopened, 'the remaining report stays open past the executable window');
    assert.equal(reopened.rerunPending, undefined, 'a late rerun note offers only the changes-note close: ' + JSON.stringify(reopened));
    await appendRecord(f.session, {kind: 'note', by: 'orchestrator', key: `repository-changes:${review}:1:${seqA}`, data: {text: 'explained earlier'}}, f.deps);
    const closed = ((await f.run(['status','show'])).value.openRepositoryChanges ?? []).filter((entry: {review: string; round: number}) => entry.review === review && entry.round === 1);
    assert.deepEqual(closed, [], 'a changes note closes the remaining report: ' + JSON.stringify(closed));
  } finally {f.cleanup();}
});

test('a satisfied rerun for the later report keeps the earlier sibling open', async () => {
  const f = await toolkitRepo(); try {
    await f.level('low'); await f.approve();
    const review = 'demo-rerun-sibling-scope';
    const roundDir = path.join(f.session,'.state/reviews',review,'round-1');
    fs.mkdirSync(path.join(roundDir,'gen-1'),{recursive:true});
    fs.mkdirSync(path.join(roundDir,'gen-2'),{recursive:true});
    fs.writeFileSync(path.join(roundDir,'round.json'), JSON.stringify({round:1,cap:1,startSeq:foldLedger(f.session).lastSeq,generation:1,roster:[{slot:'claude[0]',provider:'claude',index:0}],scope:'Full review'}));
    const seqA = foldLedger(f.session).lastSeq;
    fs.writeFileSync(path.join(roundDir,'gen-1/checkout-report.json'), JSON.stringify({repositoryChanges:[{cwd:'c',paths:['a-path']}],asOfSeq:seqA}));
    await f.level('low');
    const seqB = foldLedger(f.session).lastSeq;
    fs.writeFileSync(path.join(roundDir,'gen-2/checkout-report.json'), JSON.stringify({repositoryChanges:[{cwd:'c',paths:['b-path']}],asOfSeq:seqB}));
    assert.ok(seqB > seqA, 'the two reports carry distinct identities');
    await appendRecord(f.session, {kind: 'note', by: 'user', quote: 'Rerun after inspection', key: `repository-rerun:${review}:1:${seqB}`, data: {text: 'rerun later'}}, f.deps);
    const noteSeq = foldLedger(f.session).lastSeq;
    const round2Dir = path.join(f.session,'.state/reviews',review,'round-2');
    fs.mkdirSync(path.join(round2Dir,'gen-1'),{recursive:true});
    fs.writeFileSync(path.join(round2Dir,'round.json'), JSON.stringify({round:2,cap:1,startSeq:noteSeq,generation:1,roster:[{slot:'claude[0]',provider:'claude',index:0}],scope:'Full review — changed paths: b-path; comparison: a..b'}));
    fs.writeFileSync(path.join(round2Dir,'findings.json'), JSON.stringify({review,round:2,findings:[],clusters:[],failed:[]}));
    const open = ((await f.run(['status','show'])).value.openRepositoryChanges ?? []).find((entry: {review: string; round: number}) => entry.review === review && entry.round === 1);
    assert.ok(open, 'the earlier report stays open after the later rerun satisfies: ' + JSON.stringify((await f.run(['status','show'])).value.openRepositoryChanges));
    assert.equal(open.reportSeq, seqA, 'the open entry binds the earlier report: ' + JSON.stringify(open));
    assert.equal(open.rerunPending, undefined, 'the earlier report carries no rerun binding: ' + JSON.stringify(open));
  } finally {f.cleanup();}
});

test('an all-failed round surfaces a checkout write failure instead of a quiet review-failed', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'fail', cls: 'auth', detail: 'denied'}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = () => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low']);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    fs.writeFileSync(path.join(f.root,'src/file.ts'),'change before all-failed\n');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, 'INVALID REPORT');
    // A persistence failure must stay explicit: the thrown review-failed names
    // the unwritten report instead of implying durable repository evidence.
    const realWrite = fs.writeFileSync;
    const descriptor = (value: unknown) => ({...Object.getOwnPropertyDescriptor(fs, 'writeFileSync'), value});
    Object.defineProperty(fs, 'writeFileSync', descriptor(((...args: any[]) => {
      if (String(args[0]).includes('checkout-report')) throw new Error('injected checkout-report write failure');
      return (realWrite as (...inner: any[]) => unknown)(...args);
    })));
    let failed;
    try {
      failed = await run();
    } finally {
      Object.defineProperty(fs, 'writeFileSync', descriptor(realWrite));
    }
    assert.equal(failed.output.reason, 'review-failed', JSON.stringify(failed.output));
    assert.match(failed.output.summary, /checkout report unavailable/, JSON.stringify(failed.output));
    assert.match(failed.output.summary, /injected checkout-report write failure/, JSON.stringify(failed.output));
    assert.match(failed.output.summary, /Every review slot failed/, 'the write failure keeps the normal all-failed message: ' + JSON.stringify(failed.output));
    assert.match(failed.output.summary, /src\/file\.ts/, 'the write failure still names the detected change: ' + JSON.stringify(failed.output));
    const reviewDirs = fs.readdirSync(path.join(f.session, '.state/reviews'));
    assert.ok(reviewDirs.length > 0);
    assert.equal(fs.existsSync(path.join(f.session, '.state/reviews', reviewDirs[0]!, 'round-1/gen-1/checkout-report.json')), false, 'no report is durable');
  } finally {f.cleanup();}
});

test('an all-failed round keeps an ignored failure report visible', async () => {
  const f = await toolkitRepo(); try {
    f.deps.skillRoot = setupTestSkill(f.deps, f.session, 'checkout-skill', {'read-delegates': {claude: {targets: [{low: {model: 'native-model'}}]}}, phases: {'code-review': {targets: {low: 1}, rounds: {low: 2}}}});
    f.deps.orchestrator = {platform: 'claude', model: null} as typeof f.deps.orchestrator;
    f.deps.liveness = {claude: true};
    f.deps.delegate = async () => ({outcome: {status: 'fail', cls: 'auth', detail: 'denied'}, invocations: []});
    await f.level('low'); await f.approve();
    const made = await f.run(['worktree','create','T1']); assert.equal(made.exit, 0);
    fs.writeFileSync(path.resolve(f.session, made.value.path, 'src/file.ts'), 'candidate\n');
    assert.equal((await f.run(['worktree','submit','T1'])).exit, 0);
    const run = (extra: string[] = []) => f.run(['review','run','T1','--kind','code','--spec','work.spec.md','--level','low', ...extra]);
    assert.equal((await run()).output.reason, 'native-pending');
    const waved = await run(); assert.equal(waved.output.reason, 'native-pending');
    for (const slot of waved.value.pending) fs.writeFileSync(slot.replyPath, 'INVALID REPORT');
    // A report that matches no saved attempt is ignored, but the all-failed
    // result still names it so the caller sees where its report went.
    const failed = await run(['--native-failed', 'stale[0]#m9=voice gone']);
    assert.equal(failed.output.reason, 'review-failed', JSON.stringify(failed.output));
    assert.match(failed.output.summary, /ignored reports: stale\[0\]#m9/, JSON.stringify(failed.output));
  } finally {f.cleanup();}
});

test('checkout report reads treat a missing generation as closed but surface other read faults', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-reports-')); try {
    assert.deepEqual(checkoutReportsFor(path.join(root, 'round-1'), 'gen-1'), []);
    fs.writeFileSync(path.join(root, 'blocker'), 'not a directory');
    assert.throws(() => checkoutReportsFor(root, 'blocker'), /ENOTDIR/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
