import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { appendRecord, currentHashes, foldLedger, latest } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { reviewFixIdentity } from '../../../skills/dispatch/scripts/toolkit/integrate.ts';
import { checks, loadPlan } from '../../../skills/dispatch/scripts/toolkit/plan-view.ts';
import { readManifest } from '../../../skills/dispatch/scripts/lib/session.ts';
import { fakeGit } from './helpers/fake-git.ts';
import { sessionFixture } from './helpers/session.ts';

const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value) + '\n');
}

function planSource(count = 4): string {
  const ids = Array.from({ length: count }, (_, index) => `SC${index + 1}`);
  const lines = [
    '# Report fixture', '',
    '## Task Map',
    '| ID | Title | Outcome | Prerequisites | Criteria |',
    '| --- | --- | --- | --- | --- |',
    ...ids.map((id, index) => `| T${index + 1} | Task ${index + 1} | Works | none | ${id} |`),
    '', '## Proposed Changes',
  ];
  ids.forEach((_id, index) => lines.push(
    `### T${index + 1} — Task ${index + 1}`,
    `#### [NEW] src/task-${index + 1}.ts`,
    '- Purpose: implements the fixture behavior.', '',
  ));
  lines.push('## Success Criteria');
  ids.forEach((id, index) => lines.push(
    `- [${id}] Criterion ${index + 1} works`,
    `  - Changes: src/task-${index + 1}.ts`,
    `  - Verify: \`node verify-${index + 1}.js\``,
    '  - Evidence: verify',
  ));
  lines.push('', '## Verification Plan', '### Automated Tests',
    ...ids.map((_id, index) => `- \`node verify-${index + 1}.js\``),
    '- `node contract-check.js`', '');
  return lines.join('\n');
}

async function fixture(count = 4) {
  const f = sessionFixture({ memory: true });
  const skillRoot = path.join(f.root, 'isolated-skill');
  fs.mkdirSync(skillRoot);
  f.deps.skillRoot = skillRoot;
  f.artifact('brief.spec.md', '# Brief\n');
  f.artifact('report.plan.md', planSource(count));
  await appendRecord(f.session, {
    kind: 'bind', by: 'tool', key: 'bind:report',
    data: { spec: 'brief.spec.md', plan: 'report.plan.md' },
  }, f.deps);
  return { ...f, skillRoot };
}

async function invoke(f: ReturnType<typeof sessionFixture>, tool: string, action: string, ...args: string[]) {
  f.lines.splice(0);
  const exit = await main([tool, action, ...args, '--session', f.session], f.deps);
  assert.equal(f.lines.length, 1);
  return { exit, output: JSON.parse(f.lines[0]!) as { ok: boolean; reason?: string; summary: string; path: string | null } };
}

async function completeFixture(f: Awaited<ReturnType<typeof fixture>>, head = HEAD, tree = TREE) {
  const worktree = path.join(f.session, '.state', 'worktrees', 'integration');
  fs.mkdirSync(worktree, { recursive: true });
  const dest = { path: f.root, branch: 'main' };
  const state = { session: f.session, head, tree, testedTree: tree, changes: [] as { status: string; path: string }[], calls: [] as { argv: string[]; locked: boolean }[] };
  f.deps.run = fakeGit(state);
  await appendRecord(f.session, {
    kind: 'integrate', by: 'tool', key: 'integrate:opened',
    data: { phase: 'opened', path: '.state/worktrees/integration', branch: 'dispatch/test/integration', base: 'c'.repeat(40), dest },
  }, f.deps);
  const plan = loadPlan(f.session, readManifest(f.session));
  for (const check of checks(plan)) {
    await appendRecord(f.session, {
      kind: 'waiver', by: 'user', quote: `approved ${check.criterion}`,
      data: { criterion: check.criterion, reason: 'fixture completion' },
    }, f.deps);
  }
  await appendRecord(f.session, {
    kind: 'integrate', by: 'tool', key: 'integrate:delivered',
    data: { phase: 'delivered', mode: 'uncommitted', dest, from: head, source: head },
  }, f.deps);
  return state;
}

test('report render writes every missing criterion without Git and rewrites the same walkthrough', async () => {
  const f = await fixture();
  try {
    const first = await invoke(f, 'report', 'render');
    assert.equal(first.exit, 0);
    const walkthrough = path.join(f.session, 'report.walkthrough.md');
    const initial = fs.readFileSync(walkthrough, 'utf8');
    const verification = initial.slice(initial.indexOf('## Verification'), initial.indexOf('## Appendix'));
    for (const id of ['SC1', 'SC2', 'SC3', 'SC4', 'contract']) {
      assert.match(verification, new RegExp(`- ${id} · no eligible evidence`));
    }
    assert.match(initial, /### Missing/);
    assert.match(initial, /## Behaviour Changes\n\n### T1 — Task 1/);
    assert.match(initial, /<details>\n\nNone\.\n\n<\/details>/);
    assert.equal(f.lines.length, 1);
    fs.writeFileSync(walkthrough, 'stale');
    const second = await invoke(f, 'report', 'render');
    assert.equal(second.exit, 0);
    assert.equal(fs.readFileSync(walkthrough, 'utf8'), initial);
  } finally { f.cleanup(); }
});

test('report render shows each completed review round link', async () => {
  const f = await fixture();
  try {
    for (const [round, id] of [[1, 'F001'], [2, 'F002']] as const) {
      const roundDir = path.join(f.session, '.state', 'reviews', 'review-alpha', `round-${round}`);
      writeJson(path.join(roundDir, 'round.json'), {round, generation: 1, cap: 4, roster: []});
      writeJson(path.join(roundDir, 'findings.json'), {findings: [{id, severity: 'SHOULD'}]});
    }

    const result = await invoke(f, 'report', 'render');
    assert.equal(result.exit, 0, result.output.summary);
    const walkthrough = fs.readFileSync(path.join(f.session, 'report.walkthrough.md'), 'utf8');
    assert.match(walkthrough, /\| review-alpha \| F001 \| 1 \| SHOULD \| Open \|/);
    assert.match(walkthrough, /\| review-alpha \| F002 \| 2 \| SHOULD \| Open \|/);
    assert.deepEqual(walkthrough.match(/^- Round \d+.*$/gm), [
      '- Round 1 (review-alpha): 1 findings — [findings](.state/reviews/review-alpha/round-1/findings.json)',
      '- Round 2 (review-alpha): 1 findings — [findings](.state/reviews/review-alpha/round-2/findings.json)',
    ]);
    assert.doesNotMatch(walkthrough, /^Findings:/m);
  } finally { f.cleanup(); }
});

test('report render rejects early complete, unbound and positional input cases', async () => {
  const f = await fixture();
  try {
    const complete = await invoke(f, 'report', 'complete');
    assert.equal(complete.exit, 4);
    assert.equal(complete.output.reason, 'no-integration');
    assert.equal(fs.existsSync(path.join(f.session, 'report.walkthrough.md')), false);

    const unbound = sessionFixture({ memory: true });
    try {
      unbound.deps.skillRoot = f.skillRoot;
      const result = await invoke(unbound, 'report', 'render');
      assert.equal(result.exit, 4);
      assert.equal(result.output.reason, 'lint-errors');
    } finally { unbound.cleanup(); }

    const positional = await invoke(f, 'report', 'render', 'unexpected');
    assert.equal(positional.exit, 1);
    assert.equal(positional.output.reason, 'invalid-input');
  } finally { f.cleanup(); }
});

test('report render diagnostics toggle writes only when enabled for render and complete', async () => {
  const f = await fixture(1);
  try {
    fs.writeFileSync(path.join(f.skillRoot, 'config.local.jsonc'), '{"diagnostics": true}\n');
    const rendered = await invoke(f, 'report', 'render');
    assert.equal(rendered.exit, 0);
    assert.equal(fs.existsSync(path.join(f.session, 'diagnostics.md')), true);

    fs.rmSync(path.join(f.session, 'diagnostics.md'));
    await completeFixture(f);
    const completed = await invoke(f, 'report', 'complete');
    assert.equal(completed.exit, 0);
    assert.equal(fs.existsSync(path.join(f.session, 'diagnostics.md')), true);
  } finally { f.cleanup(); }
});

test('report render diagnostics false and absent config do not write diagnostics', async () => {
  for (const config of ['{"diagnostics": false}\n', null]) {
    const f = await fixture();
    try {
      if (config !== null) fs.writeFileSync(path.join(f.skillRoot, 'config.local.jsonc'), config);
      const result = await invoke(f, 'report', 'render');
      assert.equal(result.exit, 0);
      assert.equal(fs.existsSync(path.join(f.session, 'diagnostics.md')), false);
      assert.equal('diagnostics' in JSON.parse(fs.readFileSync(result.output.path!, 'utf8')),false);
      await completeFixture(f);
      const complete = await invoke(f, 'report', 'complete');
      assert.equal(complete.exit, 0, complete.output.summary);
      assert.equal(fs.existsSync(path.join(f.session, 'diagnostics.md')), false);
    } finally { f.cleanup(); }
  }
});

test('report render maps invalid diagnostics config to config-invalid', async () => {
  for (const config of ['{"diagnostics":"yes"}\n', '{broken', '[]\n']) {
    const f = await fixture();
    try {
      fs.writeFileSync(path.join(f.skillRoot, 'config.local.jsonc'), config);
      const result = await invoke(f, 'report', 'render');
      assert.equal(result.exit, 2);
      assert.equal(result.output.reason, 'config-invalid');
      assert.equal(fs.existsSync(path.join(f.session, 'report.walkthrough.md')), false);
    } finally { f.cleanup(); }
  }
});

test('report render does not fall through after a higher-precedence config read error', async () => {
  const f = await fixture();
  try {
    fs.mkdirSync(path.join(f.skillRoot, 'config.local.jsonc'));
    fs.writeFileSync(path.join(f.skillRoot, 'config.jsonc'), '{"diagnostics": true}\n');
    const result = await invoke(f, 'report', 'render');
    assert.equal(result.exit, 2);
    assert.equal(result.output.reason, 'config-invalid');
    assert.equal(fs.existsSync(path.join(f.session, 'diagnostics.md')), false);
  } finally { f.cleanup(); }
});

test('diagnostics damage cannot suppress successful report completion', async () => {
  const f=await fixture(1);
  try {
    fs.writeFileSync(path.join(f.skillRoot,'config.local.jsonc'),'{"diagnostics":true}');
    await completeFixture(f);
    fs.writeFileSync(path.join(f.session,'.state','retro.json'),'{bad');
    fs.mkdirSync(path.join(f.session,'.state','diagnostics'),{recursive:true});
    fs.writeFileSync(path.join(f.session,'.state','diagnostics','broken.json'),'{bad');
    const rendered=await invoke(f,'report','render');assert.equal(rendered.exit,0);
    assert.match(fs.readFileSync(path.join(f.session,'diagnostics.md'),'utf8'),/Collection health: partial/);
    fs.rmSync(path.join(f.session,'diagnostics.md'));
    fs.mkdirSync(path.join(f.session,'diagnostics.md'));
    const result=await invoke(f,'report','complete');
    assert.equal(result.exit,0,result.output.summary);
    assert.equal(result.output.ok,true);
    const value=JSON.parse(fs.readFileSync(result.output.path!,'utf8'));
    assert.equal('diagnostics' in value,false);
    assert.ok(fs.existsSync(path.join(f.session,'report.walkthrough.md')));
  } finally {f.cleanup();}
});

test('uncommitted consumers render the working-tree delivery from source with its retained ref',async()=>{
 const f=await fixture(1);try{await completeFixture(f);const {appendRecord}=await import('../../../skills/dispatch/scripts/toolkit/ledger.ts');
 await appendRecord(f.session,{kind:'integrate',by:'tool',data:{phase:'delivered',mode:'uncommitted',dest:{path:f.root,branch:'main'},from:'c'.repeat(40),source:HEAD}},f.deps);
 const result=await invoke(f,'report','render');assert.equal(result.exit,0);const text=fs.readFileSync(path.join(f.session,'report.walkthrough.md'),'utf8');
 assert.match(text,/uncommitted changes from source aaaaaaaaaaaa in main working tree; ref refs\/dispatch\/[^\s/]+\/delivered-source/);assert.doesNotMatch(text,/delivered [0-9a-f]{12} to main/);
 }finally{f.cleanup();}
});

test('cap-ending SHOULD fixes report baseline and correction separately',async()=>{
 const f=await fixture(1);try{
  await completeFixture(f);
  const reviewFix={review:'code-integration',round:3,generation:1,findings:['R3-F001'],from:'c'.repeat(40)};
  await appendRecord(f.session,{kind:'integrate',by:'tool',data:{phase:'fix',commit:'d'.repeat(40),reason:'repair accepted SHOULD',reviewFix}},f.deps);
  const result=await invoke(f,'report','render');assert.equal(result.exit,0);
  const value=JSON.parse(fs.readFileSync(result.output.path!,'utf8')) as {reviewFixes:{commit:string;metadata:typeof reviewFix;status:string}[];reviewedCodeBaseline?:string};
  assert.equal(value.reviewFixes.length,1);assert.equal(value.reviewFixes[0]!.commit,'d'.repeat(40));assert.deepEqual(value.reviewFixes[0]!.metadata,reviewFix);assert.equal(value.reviewFixes[0]!.status,'not verified');
  assert.equal(value.reviewedCodeBaseline,undefined);
  const text=fs.readFileSync(path.join(f.session,'report.walkthrough.md'),'utf8');assert.match(text,/R3-F001/);assert.match(text,/not verified/i);assert.doesNotMatch(text,/verified but not re-reviewed/i);
 }finally{f.cleanup();}
});

test('report render fills review focus and visuals from ledger and design',async()=>{
 const f=await fixture(1);try{
  const source=planSource(1).replace('# Report fixture',[
   '# Report fixture','',
   '> **Parent:** `brief.spec.md` · sha256:'+'a'.repeat(64),
   '> **Decide:** none','> **Risk:** med — inspect the delivered behavior','> **Scope:** src','',
   '## At a Glance','- **What:** Plan output is delivered without a legacy summary.','- **How it works:** The renderer joins the bound plan with ledger facts.','',
  ].join('\n'));
  fs.writeFileSync(path.join(f.root,'report.plan.md'),source);
  f.artifact('parent.design.md',[
   '# Parent design','','## At a Glance',
   '- **What:** Requests pass through the gateway to storage.',
   '- **How it works:** The gateway validates requests before storage.',
   '', '- Text summary: The map shows the request boundary.', '',
   '| Component | Boundary |','| --- | --- |','| Gateway | Validates requests |','| Store | Persists responses |','',
   '```mermaid','flowchart LR','  Gateway --> Store','```','',
  ].join('\n'));
  await appendRecord(f.session,{kind:'bind',by:'tool',key:'bind:report:design',data:{spec:'brief.spec.md',plan:'report.plan.md',design:'parent.design.md'}},f.deps);
  await appendRecord(f.session,{kind:'focus',by:'orchestrator',key:'focus:report',data:{bullets:[{text:'Inspect the delivered retry boundary.',evidence:'evidence/retry-boundary.md'}]}},f.deps);
  const priorReview=path.join(f.session,'.state/reviews/review-alpha/round-1');
  writeJson(path.join(priorReview,'round.json'),{round:1,generation:1,cap:3,roster:[]});
  writeJson(path.join(priorReview,'findings.json'),{review:'review-alpha',round:1,findings:[{id:'R1-F001',severity:'SHOULD'},{id:'R1-F002',severity:'SHOULD'}],failed:[]});
  await appendRecord(f.session,{kind:'ruling',by:'orchestrator',key:'reject-prior-should',data:{subject:'review:review-alpha:R1-F001',ruling:'rejected',rationale:'The change is not needed'}},f.deps);
  await appendRecord(f.session,{kind:'ruling',by:'orchestrator',key:'defer-prior-should',data:{subject:'review:review-alpha:R1-F002',ruling:'deferred',rationale:'More evidence is needed'}},f.deps);
  const state=await completeFixture(f),baseline=state.head,commit='d'.repeat(40),tree='e'.repeat(40),reason='repair accepted SHOULD';
  state.head=commit;state.tree=tree;state.testedTree=tree;state.changes=[{status:'M',path:'src/task-1.ts'},{status:'A',path:'src/shared.ts'}];
  const fold=foldLedger(f.session),artifacts=currentHashes(f.root,latest(fold,'bind'));
  const reviewFix={review:'code-integration',round:3,generation:1,findings:['R3-F001'],from:baseline};
  const reviewDir=path.join(f.session,'.state/reviews/code-integration/round-3');
  const finding={id:'R3-F001',severity:'SHOULD',category:'correctness',locus:'src/task-1.ts:L1',defect:'The assertion is wrong',requiredChange:'Correct the assertion',sources:['reviewer'],scope:'in',fix:{paths:['src/task-1.ts','src/shared.ts'],dependencies:[],verification:[]}};
  writeJson(path.join(reviewDir,'round.json'),{round:3,generation:1,cap:3,startSeq:fold.lastSeq,target:{base:'c'.repeat(40),head:baseline},scope:'Full review',artifacts,spec:{hash:artifacts.spec},roster:[{slot:'reviewer',reserve:false}]});
  writeJson(path.join(reviewDir,'findings.json'),{review:'code-integration',round:3,findings:[finding],failed:[]});
  writeJson(path.join(reviewDir,'gen-1/slots/reviewer.json'),{slot:'reviewer',state:'done',text:JSON.stringify({status:'FINDINGS',findings:[{severity:'SHOULD',locus:'src/task-1.ts:L1',tag:'correctness',defect:finding.defect,requiredChange:finding.requiredChange}]})});
  await appendRecord(f.session,{kind:'ruling',by:'orchestrator',key:'accept-nontransient-should',data:{subject:'review:code-integration:R3-F001',ruling:'accepted',rationale:'The bounded correction is needed'}},f.deps);
  await appendRecord(f.session,{kind:'integrate',by:'tool',data:{phase:'fix',commit,reason,reviewFix}},f.deps);
  for(const check of checks(loadPlan(f.session,readManifest(f.session))))await appendRecord(f.session,{kind:'evidence',by:'tool',data:{criterion:check.criterion,commandDigest:check.commandDigest,tree,clean:true,before:tree,after:tree,exit:0,path:'.state/evidence/'+check.criterion+'.json'}},f.deps);
  const metadata=reviewFixIdentity(reviewFix),message=[`dispatch fix: ${reason}`,'',`Dispatch-Fix: ${readManifest(f.session).safeSessionId}`,`Dispatch-Review-Fix: ${metadata.digest}`,`Dispatch-Review-Fix-Data: ${metadata.data}`,''].join('\n');
  const git=fakeGit(state);f.deps.run=async(argv)=>{
   const args=argv.slice(1),output=(stdout='')=>({exit:0,stdout,stderr:''});
   if(args[0]==='rev-list'&&args[1]==='--reverse'&&args[2]==='--parents')return output(`${commit} ${baseline}\n`);
   if(args[0]==='diff-tree'&&args.includes(commit))return output('src/task-1.ts\0src/shared.ts\0');
   if(args[0]==='log'&&args[1]==='-1'&&args[2]==='--format=%B'&&args[3]===commit)return output(message);
   return git(argv);
  };
  const result=await invoke(f,'report','render');assert.equal(result.exit,0);
  const value=JSON.parse(fs.readFileSync(result.output.path!,'utf8')) as {reviewedCodeBaseline?:string;reviewFixes:{status:string;verification?:{criteria:string[];contract:string[];tree:string}}[]};
  assert.equal(value.reviewedCodeBaseline,baseline);assert.equal(value.reviewFixes[0]!.status,'verified but not re-reviewed');
  assert.deepEqual(value.reviewFixes[0]!.verification?.criteria,['SC1']);assert.deepEqual(value.reviewFixes[0]!.verification?.contract,['contract']);assert.equal(value.reviewFixes[0]!.verification?.tree,tree);
  const text=fs.readFileSync(path.join(f.session,'report.walkthrough.md'),'utf8');
  assert.match(text,/- \*\*What:\*\* Plan output is delivered without a legacy summary\./);assert.doesNotMatch(text,/TL;DR/);
  const focus=text.slice(text.indexOf('## Review Focus'),text.indexOf('## Behaviour Changes'));
  assert.match(focus,/Risk: med/);assert.match(focus,/Rejected finding review-alpha:R1-F001/);assert.match(focus,/Deferred finding review-alpha:R1-F002/);
  assert.match(focus,/Inspect the delivered retry boundary\. — Evidence: \[evidence\/retry-boundary\.md\]\(evidence\/retry-boundary\.md\)/);
  assert.match(focus,/R3-F001.*verified but not re-reviewed/);
  const visuals=text.slice(text.indexOf('## Visuals'),text.indexOf('## Review Focus'));
  assert.ok(visuals.includes('| Component | Boundary |'));assert.ok(visuals.includes('```mermaid\nflowchart LR\n  Gateway --> Store\n```'));
  const bind=latest(foldLedger(f.session),'bind')!;const hashes=currentHashes(f.root,bind),appendix=text.slice(text.indexOf('## Appendix'));
  assert.ok(appendix.includes(`Spec: brief.spec.md · sha256:${hashes.spec!.slice(7,19)}`));
  assert.ok(appendix.includes(`Plan: report.plan.md · sha256:${hashes.plan!.slice(7,19)}`));
  assert.ok(appendix.includes('R3-F001')&&appendix.includes('verified but not re-reviewed')&&appendix.includes('src/task-1.ts'));
  const nextDir=path.join(f.session,'.state/reviews/code-integration/round-4');
  writeJson(path.join(nextDir,'round.json'),{round:4,generation:1,cap:3,startSeq:foldLedger(f.session).lastSeq,target:{base:'c'.repeat(40),head:commit},scope:'Re-review round 4 (full)',artifacts,spec:{hash:artifacts.spec},roster:[{slot:'reviewer',reserve:false}]});
  writeJson(path.join(nextDir,'findings.json'),{review:'code-integration',round:4,findings:[],failed:[]});
  writeJson(path.join(nextDir,'gen-1/slots/reviewer.json'),{slot:'reviewer',state:'done',text:JSON.stringify({status:'CLEAN',findings:[]})});
  const reviewed=await invoke(f,'report','render');assert.equal(reviewed.exit,0);
  const reviewedValue=JSON.parse(fs.readFileSync(reviewed.output.path!,'utf8'));
  assert.deepEqual(reviewedValue.reviewFixes,[]);
  assert.doesNotMatch(fs.readFileSync(path.join(f.session,'report.walkthrough.md'),'utf8'),/Code Review Corrections/);
 }finally{f.cleanup();}
});
