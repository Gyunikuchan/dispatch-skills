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
  for(const [point, move] of [['review:after-pending', false], ['review:after-append', true]] as const) {
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
        f.deps.delegate=async()=>({outcome:{status:'ok',text:CLEAN,resume:null,sessionId:null},invocations:[]});
        assert.equal((await f.call()).exit,0);
      }
      const escalations=foldLedger(f.session).records.filter(row=>row.kind==='escalation');
      const latest=new Map(escalations.map(row=>[row.data['id'],row.data['state']]));
      if(move) {
        assert.deepEqual([...latest.values()],['resolved']);
      } else {
        assert.equal([...latest.values()].filter(state=>state==='open').length,1);
      }
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
    await f.add('edit',{artifact:'spec',before:f.read(1,'round.json').spec.hash,after:artifactHash('spec',fs.readFileSync(f.spec,'utf8')),class:'non-intent',affects:[],rationale:'Record the spec revision',diffRef:'test diff'});
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

async function underfillFixture() {
  const f = await fixture();
  fs.writeFileSync(path.join(f.deps.skillRoot, 'config.jsonc'), JSON.stringify({
    'read-delegates': {
      codex: {nativeSubagentsOnly: true, targets: [{low: {model: 'native'}}]},
      agy: {targets: [{low: {model: 'fake'}}]},
      copilot: {nativeSubagentsOnly: true, targets: [{low: {model: 'other'}}]},
    },
    phases: {'plan-review': {targets: {low: 0, medium: 2}, rounds: {low: 0, medium: 2}}, 'code-review': {targets: {low: 2}, rounds: {low: 2}}},
  }));
  f.deps.orchestrator = {platform: 'codex', model: 'native'} as typeof f.deps.orchestrator;
  return f;
}
const underfilled = {host: 'codex', configured: 2, resolved: 2, excluded: ['copilot']};

