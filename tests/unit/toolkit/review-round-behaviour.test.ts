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
    f.artifact('strategy.design.context.md',CONTEXT_MAP);
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
      const specBefore=artifactHash('spec',fs.readFileSync(f.spec,'utf8'));
      const delegate=f.deps.delegate;
      f.deps.delegate=async(...args)=>{const value=await delegate(...args);if(edit){edit=false;fs.appendFileSync(moved==='plan'?f.plan:f.spec,'\n## Added\nMoved.\n');}return value;};
      const result=await f.call(); assert.equal(result.output.reason,'target-moved');
      assert.equal(fs.existsSync(path.join(f.directory,'round-1/findings.json')),false);
      const gen1=fs.readdirSync(path.join(f.directory,'round-1/gen-1/slots'));
      if(moved==='spec')await f.add('edit',{artifact:'spec',before:specBefore,after:artifactHash('spec',fs.readFileSync(f.spec,'utf8')),class:'non-intent',affects:[],rationale:'Record the spec revision',diffRef:'test diff'});
      assert.equal((await f.call()).exit,0); assert.equal(f.read(1,'round.json').generation,2);
      if(moved==='spec')assert.equal(f.read(1,'round.json').spec.hash,artifactHash('spec',fs.readFileSync(f.spec,'utf8')));
      assert.deepEqual(fs.readdirSync(path.join(f.directory,'round-1/gen-1/slots')),gen1);
      assert.equal(fs.readFileSync(path.join(f.directory,'round-1/target.snapshot.md'),'utf8'),fs.readFileSync(f.plan,'utf8'));
      assert.ok(!fs.readdirSync(path.join(f.directory,'round-1')).some(name=>name.startsWith('superseded-')));
    } finally {f.cleanup();}
  }
});

test('review rounds code review prompt uses intent and raw task markdown and refuses a design-stage rebind',async()=>{
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
    assert.doesNotMatch(prompt,/absent or unfilled table/);
    assert.match(prompt,/selected diff and tests/);
    assert.match(prompt,/does not establish that verification commands ran or final gates passed/);
    assert.equal(summary,'Keep captured work recoverable.\n\n### T1 — First\n#### [NEW] src/first.ts\n- Purpose: Keep captured work recoverable.\n\n- [SC1] Works\n  - Changes: src/first.ts\n  - Verify: `node check`\n  - Evidence: verify');
    assert.doesNotMatch(summary,/sha256:/);
    const findings=JSON.parse(fs.readFileSync(result.value.path,'utf8'));assert.deepEqual(findings.clusters.map((cluster:{file:string})=>cluster.file),['src/first.ts','src/second.ts']);
    f.deps.delegate=async(provider,request,mode)=>{f.launches.push({provider,request,mode});return provider==='agy'?{outcome:{status:'fail',cls:'auth',detail:'No access'},invocations:[]}:{outcome:{status:'ok',text:CLEAN,resume:null,sessionId:null},invocations:[]};};
    assert.equal((await f.call()).exit,0);assert.equal(f.read(1,'findings.json').failed.length,1);
    f.artifact('strategy.design.md', '# Strategy\n');
    let rebind = true;
    f.deps.delegate = async () => {
      if (rebind) {rebind = false; await f.add('bind', {spec: 'mission.spec.md', design: 'strategy.design.md'});}
      return {outcome: {status: 'ok', text: CLEAN, resume: null, sessionId: null}, invocations: []};
    };
    const moved = await f.call('code', 'T1');
    assert.equal(moved.exit, 4);
    assert.equal(moved.output.reason, 'lint-errors');
  }finally{f.cleanup();}
});

test('review voices receive prompts rotated by roster position',async()=>{
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
      return {outcome:{status:'ok',text:CLEAN,resume:null,sessionId:null},invocations:[]};
    };
    assert.equal((await f.call('code','T1')).exit,0);
    assert.equal(f.launches.length,2);
    const roundFile=path.resolve(path.dirname(f.launches[0]!.request.promptPath),'..','..','round.json');
    const round=JSON.parse(fs.readFileSync(roundFile,'utf8')) as {roster:{slot:string;provider:string;index:number;reserve:boolean}[]};
    const targets=round.roster.filter(slot=>!slot.reserve);
    assert.equal(targets.length,2);
    assert.deepEqual(targets.map(slot=>slot.index),[0,0]);
    for(const [position,slot] of targets.entries()) {
      const launch=f.launches.find(item=>item.provider===slot.provider);
      assert.ok(launch,`missing launch for ${slot.provider}`);
      const prompt=fs.readFileSync(launch.request.promptPath,'utf8');
      const firstTag=prompt.slice(prompt.indexOf('### Tags')).match(/^- `([^`]+)`/m)?.[1];
      assert.equal(firstTag,['intent','spec'][position],`roster position ${position} (${slot.slot})`);
    }
  }finally{f.cleanup();}
});

test('review rounds exclusive claim and late native replies stay isolated',async()=>{
  const f=await fixture();
  try {
    let release!:()=>void, started!:()=>void;
    const ready=new Promise<void>(resolve=>started=resolve), held=new Promise<void>(resolve=>release=resolve);
    f.deps.delegate=async()=>{started();await held;return {outcome:{status:'ok',text:CLEAN,resume:null,sessionId:null},invocations:[]};};
    f.deps.isAlive=()=>true;
    const first=main(['review','run',f.plan,'--kind','plan','--session',f.session,'--host','opencode'],{...f.deps,stdout:()=>{}});
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

test('review native-pending and resumed final results report and retain underfill for excluded native-only providers', async () => {
  const f = await underfillFixture();
  try {
    const pending = await f.call();
    assert.equal(pending.exit, 4); assert.equal(pending.output.reason, 'native-pending');
    assert.deepEqual(pending.value.underfill, underfilled);
    assert.match(pending.output.summary, /; underfill 2\/2 targets, host codex, excluded native-only: copilot$/);

    // Modify configuration before resuming to ensure resumed run retains roster underfill
    fs.writeFileSync(path.join(f.deps.skillRoot, 'config.jsonc'), JSON.stringify({
      'read-delegates': {codex: {nativeSubagentsOnly: true, targets: [{low: {model: 'native'}}]}, agy: {targets: [{low: {model: 'fake'}}]}},
      phases: {'plan-review': {targets: {low: 0, medium: 2}, rounds: {low: 0, medium: 2}}, 'code-review': {targets: {low: 2}, rounds: {low: 2}}},
    }));
    for (const slot of pending.value.pending) fs.writeFileSync(slot.replyPath, CLEAN);
    const done = await f.call();
    assert.equal(done.exit, 0);
    assert.deepEqual(done.value.underfill, underfilled);
    assert.match(done.output.summary, /failed slots; underfill 2\/2 targets, host codex, excluded native-only: copilot, repository check unavailable: Unit tests must not spawn processes; first 1: R1-F\d{3} SHOULD/);
  } finally {f.cleanup();}
});

test('review run summary lists first findings by severity', async () => {
  const f = await fixture();
  try {
    const rating = {MUST: {impact: 'blocks', trigger: 'realistic'}, SHOULD: {impact: 'degrades', trigger: 'realistic'}, CONSIDER: {impact: 'minor', trigger: 'contrived'}} as const;
    const finding = (severity: keyof typeof rating, i: number) => ({...rating[severity], tag: 'reliability', locus: '§ Work ' + i,
      defect: severity + ' defect ' + i, requiredChange: 'Fix defect ' + i});
    const findings = [finding('CONSIDER', 1), finding('SHOULD', 2), finding('MUST', 3), finding('SHOULD', 4),
      finding('CONSIDER', 5), finding('SHOULD', 6), finding('MUST', 7)];
    const text = JSON.stringify({status: 'FINDINGS', findings});
    f.deps.delegate = async () => ({outcome: {status: 'ok', text, resume: null, sessionId: null}, invocations: []});
    const first = await f.call();
    assert.equal(first.exit, 0, JSON.stringify(first));
    assert.match(first.output.summary, /round 1\/2: 2 MUST, 3 SHOULD, 2 CONSIDER, /);
    const listed = [...first.output.summary.matchAll(/R1-F\d{3} (MUST|SHOULD|CONSIDER): /g)].map(match => match[1]);
    assert.deepEqual(listed, ['MUST', 'MUST', 'SHOULD', 'SHOULD', 'SHOULD']);
    assert.match(first.output.summary, /; \+2 more in result$/);
    assert.ok(Buffer.byteLength(first.output.summary, 'utf8') <= 1024);
  } finally { f.cleanup(); }
});

test('review run reports native-pending for the recorded host when env carries no platform marker', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.deps.skillRoot, 'config.jsonc'), JSON.stringify({
      'read-delegates': {copilot: {nativeSubagentsOnly: true, targets: [{low: {model: 'native-a'}}, {low: {model: 'native-b'}}]}},
      phases: {'plan-review': {targets: {low: 0, medium: 2}, rounds: {low: 0, medium: 2}}},
    }));
    const manifestFile = path.join(f.session, 'manifest.json');
    fs.writeFileSync(manifestFile, JSON.stringify({...JSON.parse(fs.readFileSync(manifestFile, 'utf8')), host: 'copilot'}));
    f.deps.orchestrator = null; f.deps.env = {};
    const pending = await f.call();
    assert.equal(pending.exit, 4, JSON.stringify(pending.output)); assert.equal(pending.output.reason, 'native-pending');
    assert.equal(f.launches.length, 0);
    assert.deepEqual(pending.value.pending.map((slot: {slot: string}) => slot.slot), ['copilot[0]', 'copilot[1]']);
  } finally {f.cleanup();}
});

test('review run forwards round 2 on repository-rerun with empty settled', async () => {
  const f = await fixture();
  try {
    f.deps.delegate = async (provider, request, mode) => {
      f.launches.push({provider, request, mode});
      return {outcome: {status: 'ok', text: CLEAN, resume: null, sessionId: null}, invocations: []};
    };
    const first = await f.call();
    assert.equal(first.exit, 0, JSON.stringify(first.output));
    const firstPrompt = fs.readFileSync(f.launches[0]!.request.promptPath, 'utf8');
    assert.doesNotMatch(firstPrompt, /On re-review,/);
    assert.doesNotMatch(firstPrompt, /Settled in earlier rounds/);
    const round1Dir = path.join(f.directory, 'round-1/gen-1');
    fs.mkdirSync(round1Dir, {recursive: true});
    fs.writeFileSync(path.join(round1Dir, 'checkout-report.json'), JSON.stringify({repositoryCheck: {state: 'unavailable', reason: 'test'}, asOfSeq: 0}));
    await appendRecord(f.session, {kind: 'note', by: 'user', quote: 'Rerun after inspection', key: 'repository-rerun:plan-work.plan:1:0', data: {text: 'rerun'}}, f.deps);
    const second = await f.call();
    assert.equal(second.exit, 0, JSON.stringify(second.output));
    assert.equal(second.value.round, 2);
    const round2 = JSON.parse(fs.readFileSync(path.join(f.directory, 'round-2/round.json'), 'utf8'));
    assert.equal(round2.round, 2);
    assert.match(round2.scope, /^Full review/);
    const secondPrompt = fs.readFileSync(f.launches.at(-1)!.request.promptPath, 'utf8');
    assert.equal(secondPrompt.split('On re-review,').length - 1, 1);
  } finally { f.cleanup(); }
});

