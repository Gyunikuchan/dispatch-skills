import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { sessionFixture } from './helpers/session.ts';
import { appendRecord, currentHashes, foldLedger, gate, latest, queryLedger } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';

test('design-stage bindings retain revisions and block plan-dependent effects until a complete rebind', async () => {
  const f = sessionFixture({memory: true});
  try {
    const skill = path.join(f.root, 'skill'); fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, 'config.jsonc'), JSON.stringify({diagnostics: false,
      'read-delegates': {codex: {targets: [{low: {model: 'fake'}}]}},
      phases: {'code-review': {targets: {low: 1}, rounds: {low: 1}}}}));
    f.deps.skillRoot = skill;
    let key = 0, effects = 0;
    f.deps.run = async () => {effects++; throw new Error('Design-only work must not run Git');};
    f.deps.delegate = async () => {effects++; throw new Error('No delegate without a usable review target');};
    const add = (kind: string, data: object, extra: object = {}) => appendRecord(f.session,
      {kind, data, by: 'orchestrator', key: 'design-' + key++, ...extra}, f.deps);
    f.artifact('mission.spec.md', '# Mission\n');
    const design = f.artifact('strategy.design.md', '# Strategy\n');
    await add('bind', {spec: 'mission.spec.md', design: 'strategy.design.md'});
    await add('level', {level: 'low'});
    const hashes = () => currentHashes(f.root, latest(foldLedger(f.session), 'bind'));
    await add('confirm', {spec: hashes().spec}, {by: 'user', quote: 'Approved the mission'});
    const before = hashes().design;
    fs.appendFileSync(design, '\n## Approach\nPreserve independent increments.\n');
    const edit = {kind: 'edit', key: 'design-revision', by: 'orchestrator', data: {
      artifact: 'design', before, after: hashes().design, class: 'non-intent', affects: [], rationale: 'Clarify strategy', diffRef: 'design diff'}};
    const saved = await appendRecord(f.session, edit, f.deps);
    assert.deepEqual(await appendRecord(f.session, edit, f.deps), {...saved, deduped: true});
    assert.equal(hashes().plan, undefined);
    await assert.rejects(add('bind', {spec: 'mission.spec.md', design: 'missing.design.md'}), {reason: 'invalid-record'});
    const call = async (args: string[]) => {
      f.lines.length = 0;
      const exit = await main([...args, '--session', f.session], f.deps);
      return {exit, output: f.output()};
    };
    for (const args of [['worktree', 'create', 'T1'], ['brief', 'render', 'T1'], ['worktree', 'integrate', 'T1'],
      ['worktree', 'commit', '--reason', 'repair'], ['verify', 'run'], ['worktree', 'prune'], ['report', 'render'],
      ['review', 'run', 'integration', '--kind', 'code', '--level', 'low']]) {
      const result = await call(args);
      assert.equal(result.exit, 4, args.join(' '));
      assert.equal(result.output.reason, 'lint-errors', args.join(' '));
    }
    assert.equal((await call(['worktree', 'deliver'])).output.reason, 'no-integration');
    assert.equal((await call(['status', 'show'])).exit, 0);
    const git = 'a'.repeat(40);
    await add('integrate', {phase: 'opened', path: '.state/worktrees/integration', branch: 'dispatch/test/integration', base: git, dest: {branch: 'main', path: f.root}});
    await add('integrate', {phase: 'done', task: 'T1', commit: git});
    await add('bind', {spec: 'mission.spec.md', design: 'strategy.design.md'});
    for (const args of [['worktree', 'commit', '--reason', 'repair'], ['review', 'run', 'integration', '--kind', 'code', '--level', 'low']]) {
      const result = await call(args);
      assert.equal(result.output.reason, 'lint-errors');
    }
    assert.equal(effects, 0);
    f.artifact('work.plan.md', '# Work\n');
    await add('bind', {spec: 'mission.spec.md', plan: 'work.plan.md', design: 'strategy.design.md'});
    await add('approval', hashes(), {by: 'user', quote: 'Approve the complete tuple'});
    assert.equal(gate(foldLedger(f.session), hashes(), 'medium').allowed, true);
    assert.equal(foldLedger(f.session).records.filter(row => row.key === edit.key).length, 1);
  } finally {f.cleanup();}
});

test('ledger bindings approvals and input filters preserve validation and retries', async () => {
 const f=sessionFixture({ memory: true });try{
 const input=f.artifact('record.json','');let n=0;
 const call=async(record:unknown)=>{f.lines.length=0;fs.writeFileSync(input,JSON.stringify(record));const exit=await main(['ledger','append','--session',f.session,input],f.deps);const output=f.output();return {exit,output,value:output.path?JSON.parse(fs.readFileSync(output.path,'utf8')):null};};
 const add=(kind:string,data:object,extra:object={})=>appendRecord(f.session,{kind,data,by:'orchestrator',key:'k'+n++,...extra},f.deps);
 const hash='sha256:'+'a'.repeat(64),git='a'.repeat(40);
 f.artifact('s.spec.md','spec');f.artifact('p.plan.md','plan');
 for(const spec of ['../escape','C:/absolute','missing'])await assert.rejects(add('bind',{spec,plan:'p.plan.md'}),{reason:'invalid-record'});
 const badBind=await call({kind:'bind',key:'bad-bind',by:'orchestrator',data:{spec:'missing',plan:'p.plan.md'}});assert.equal(badBind.exit,1);assert.equal(badBind.output.reason,'invalid-record');
 const binding={kind:'bind',key:'bind',by:'orchestrator',data:{spec:'s.spec.md',plan:'p.plan.md'}};
 assert.equal((await call(binding)).exit,0);const hashes=currentHashes(f.root,latest(foldLedger(f.session),'bind'));
 await assert.rejects(add('approval',{...hashes,design:hash},{by:'user',quote:'yes'}),{reason:'approval-stale'});
 f.artifact('d.design.md','design');assert.ok((await add('bind',{...binding.data,design:'d.design.md'})).seq>0);
 await assert.rejects(add('approval',hashes,{by:'user',quote:'yes'}),{reason:'approval-stale'});
 assert.ok((await add('bind',binding.data)).seq>0);
 await assert.rejects(add('approval',{spec:hashes.spec},{by:'user',quote:'yes'}),{reason:'invalid-record'});
 const approval={kind:'approval',key:'approval',by:'user',quote:'yes',data:hashes};const approved=await call(approval);assert.equal(approved.exit,0);
 f.artifact('p.plan.md','changed');assert.equal((await call(approval)).value.seq,approved.value.seq);
 await assert.rejects(add('approval',hashes,{by:'user',quote:'yes'}),{reason:'approval-stale'});
 f.artifact('p.plan.md','plan');assert.ok((await call({...approval,key:'approval-again'})).value.seq>approved.value.seq);
 for(const ruling of ['X','Y','X'])assert.ok((await add('ruling',{subject:'s',ruling,rationale:'r'})).seq>0);
 for(const state of ['open','resolved','open'])assert.ok((await add('escalation',{id:'e',state,summary:'s'})).seq>0);
 assert.equal(latest(foldLedger(f.session),'escalation')?.data['state'],'open');
 assert.equal(foldLedger(f.session).records.filter(r=>r.kind==='ruling').length,3);
 await assert.rejects(add('edit',{artifact:'design',before:hash,after:hash,class:'non-intent',affects:[],rationale:'r',diffRef:'d'}),{reason:'invalid-record'});
 fs.unlinkSync(path.join(f.root,'s.spec.md'));assert.equal((await call(binding)).value.deduped,true);
 for(const phase of ['deliver-started','delivered'])assert.ok((await add('integrate',{phase,mode:'uncommitted',dest:{branch:'b',path:'p'},from:git,source:git})).seq>0);
 f.lines.length=0;assert.equal(await main(['ledger','query','--session',f.session,'--kind','integrate'],f.deps),0);assert.equal(JSON.parse(fs.readFileSync(f.output().path!,'utf8')).length,2);
 for(const filter of [{kind:'bad'},{since:'-1'},{since:'wat'}])assert.throws(()=>queryLedger(foldLedger(f.session),filter),{reason:'invalid-input'});
 f.lines.length=0;assert.equal(await main(['ledger','query','--session',f.session,'--kind','bad'],f.deps),1);assert.equal(f.output().reason,'invalid-input');
 for(const file of ['missing',f.root]){f.lines.length=0;assert.equal(await main(['ledger','append','--session',f.session,file],f.deps),1);assert.equal(f.output().reason,'invalid-input');assert.equal(f.output().summary,'Cannot read record file '+path.resolve(file));}
 for(const extra of [[],[input,input]]){f.lines.length=0;assert.equal(await main(['ledger','append','--session',f.session,...extra],f.deps),1);assert.equal(f.output().reason,'invalid-input');assert.match(f.output().summary,/ledger append <record\.json>/);}
 fs.writeFileSync(input,'bad');f.lines.length=0;assert.equal(await main(['ledger','append','--session',f.session,input],f.deps),1);assert.equal(f.output().reason,'invalid-input');assert.ok(f.output().summary.startsWith('Record file '+path.resolve(input)+' is not valid JSON: '));
 const ledger=path.join(f.session,'ledger.jsonl');const bytes=fs.readFileSync(ledger,'utf8');const first=JSON.parse(bytes.split('\n')[0]!);fs.appendFileSync(ledger,JSON.stringify(first)+'\n');const corrupt=fs.readFileSync(ledger,'utf8');await assert.rejects(add('note',{text:'n'}),{reason:'ledger-corrupt'});assert.equal(fs.readFileSync(ledger,'utf8'),corrupt);
 }finally{f.cleanup();}
});

test('uncommitted records append through the ledger command', async () => {
 const f=sessionFixture({ memory: true });try{
 const input=f.artifact('record.json',''),git='a'.repeat(40),dest={branch:'b',path:'p'};
 for(const [phase,extra] of [['deliver-started',{}],['delivered',{noop:true}]] as const){
  fs.writeFileSync(input,JSON.stringify({kind:'integrate',by:'tool',key:phase,data:{phase,mode:'uncommitted',dest,from:git,source:git,...extra}}));
  f.lines.length=0;assert.equal(await main(['ledger','append','--session',f.session,input],f.deps),0,phase);
 }
 assert.equal(foldLedger(f.session).records.filter(r=>r.kind==='integrate'&&r.data['mode']==='uncommitted').length,2);
 }finally{f.cleanup();}
});

test('approval survives formatting-only artifact rewrites and refuses meaning changes', async () => {
  const f = sessionFixture({ memory: true });
  try {
    const names = { spec: 's.spec.md', plan: 'p.plan.md', design: 'd.design.md' } as const;
    const kinds = ['spec', 'plan', 'design'] as const;
    const plain = {
      spec: ['# Formatter Spec', '', '## Intent & Problem', '', 'Keep _approved_ artifacts stable while **formatters** run.', '', '## Requirements', '', '### REQ-1 — Stable hash', '', '- Acceptance: formatting-only rewrites keep the gate allowed.', ''].join('\n'),
      plan: ['# Formatter Plan', '', '## Task Map', '', '| ID | Title |', '| --- | --- |', '| T1 | Canonical form |', '', '## Tasks', '', '### T1 — Canonical form', '', 'Run the checks before handoff.', '', '```text', 'node --version', '```', ''].join('\n'),
      design: ['# Formatter Design', '', '## Approach', '', 'Hash canonical Markdown with one shared form.', '', '---', '', '## Architecture & Boundaries', '', '- lib owns the canonical form.', ''].join('\n'),
    };
    const formatted = {
      spec: ['# Formatter Spec', '', '', '## Intent & Problem ##', '', 'Keep *approved* artifacts stable while **formatters** run.  ', '', '', '## Requirements', '', '### REQ-1 — Stable hash', '', '- Acceptance: formatting-only rewrites keep the gate allowed.', ''].join('\n'),
      plan: ['# Formatter Plan', '', '## Task Map', '', '|ID|Title|', '|---|---|', '|T1|Canonical form|', '', '## Tasks', '', '### T1 — Canonical form', '', 'Run the checks before handoff.', '', '~~~~text', 'node --version', '~~~~', ''].join('\n'),
      design: ['# Formatter Design', '', '## Approach', '', 'Hash canonical Markdown with one shared form.', '', '***', '', '## Architecture & Boundaries', '', '- lib owns the canonical form.', ''].join('\n'),
    };
    const wordChanges = { spec: ['formatters', 'editors'], plan: ['before handoff', 'after handoff'], design: ['lib owns', 'tool owns'] } as const;
    const verdict = () => {
      const fold = foldLedger(f.session);
      return gate(fold, currentHashes(f.root, latest(fold, 'bind')));
    };
    for (const kind of kinds) f.artifact(names[kind], plain[kind]);
    assert.equal((await appendRecord(f.session, { kind: 'bind', key: 'bind', by: 'orchestrator', data: names }, f.deps)).seq > 0, true);
    const approved = currentHashes(f.root, latest(foldLedger(f.session), 'bind'));
    await appendRecord(f.session, { kind: 'confirm', key: 'confirm', by: 'user', quote: 'yes', data: { spec: approved.spec } }, f.deps);
    await appendRecord(f.session, { kind: 'approval', key: 'approval', by: 'user', quote: 'yes', data: approved }, f.deps);
    assert.deepEqual(verdict(), { allowed: true });
    for (const kind of kinds) f.artifact(names[kind], formatted[kind]);
    assert.deepEqual(currentHashes(f.root, latest(foldLedger(f.session), 'bind')), approved);
    assert.deepEqual(verdict(), { allowed: true });
    for (const kind of kinds) {
      const [from, to] = wordChanges[kind];
      f.artifact(names[kind], formatted[kind].replace(from, to));
      // A spec change fails the confirm check before approval, which reports no artifact.
      assert.deepEqual(verdict(), kind === 'spec' ? { allowed: false, reason: 'missing-confirmation' } : { allowed: false, reason: 'unrecorded-change', artifact: kind });
      f.artifact(names[kind], formatted[kind]);
      assert.deepEqual(verdict(), { allowed: true });
    }
  } finally {
    f.cleanup();
  }
});

test('approval accepts a recorded non-intent chain and stale approvals list current hashes', async () => {
  const boundPlan = async () => {
    const f = sessionFixture({ memory: true });
    let n = 0;
    const add = (kind: string, data: object, extra: object = {}) => appendRecord(
      f.session, { kind, data, by: 'orchestrator', key: 'approval-chain-' + n++, ...extra }, f.deps,
    );
    const hashes = () => currentHashes(f.root, latest(foldLedger(f.session), 'bind'));
    const edit = (before: string, after: string, editClass = 'non-intent') => add('edit', {
      artifact: 'plan', before, after, class: editClass, affects: [], rationale: 'Record the plan edit', diffRef: 'test diff',
    });
    const approve = (data: object) => add('approval', data, { by: 'user', quote: 'I approve the plan I reviewed' });
    f.artifact('s.spec.md', 'Spec');
    f.artifact('p.plan.md', 'A');
    await add('bind', { spec: 's.spec.md', plan: 'p.plan.md' });
    await add('confirm', { spec: hashes().spec }, { by: 'user', quote: 'I confirm the spec' });
    return { f, hashes, edit, approve };
  };
  const scenario = async (exercise: (context: Awaited<ReturnType<typeof boundPlan>>) => Promise<void>) => {
    const context = await boundPlan();
    try { await exercise(context); } finally { context.f.cleanup(); }
  };
  const assertStale = async (append: () => Promise<unknown>, current: ReturnType<typeof currentHashes>) => {
    await assert.rejects(append(), (error: unknown) => {
      const failure = error as { reason?: string; message?: string };
      assert.equal(failure.reason, 'approval-stale');
      for (const [artifact, hash] of Object.entries(current)) {
        assert.ok(failure.message?.includes(`current: ${artifact} ${hash}`), failure.message);
      }
      return true;
    });
  };

  await scenario(async ({ f, hashes, edit, approve }) => {
    const approved = hashes();
    f.artifact('p.plan.md', 'B');
    const afterEdit = hashes();
    await edit(approved.plan!, afterEdit.plan!);
    await approve(approved);
    assert.deepEqual(gate(foldLedger(f.session), hashes()), { allowed: true });

    f.artifact('p.plan.md', 'D');
    const afterPostApprovalEdit = hashes();
    await edit(afterEdit.plan!, afterPostApprovalEdit.plan!);
    assert.deepEqual(gate(foldLedger(f.session), hashes()), { allowed: true });
    f.artifact('p.plan.md', 'unrecorded');
    assert.deepEqual(gate(foldLedger(f.session), hashes()), { allowed: false, reason: 'unrecorded-change', artifact: 'plan' });
  });

  await scenario(async ({ f, hashes, edit, approve }) => {
    const approved = hashes();
    f.artifact('p.plan.md', 'B');
    const changed = hashes();
    await edit(approved.plan!, changed.plan!, 'intent');
    f.artifact('p.plan.md', 'A');
    const reverted = hashes();
    await edit(changed.plan!, reverted.plan!);
    await approve(approved);
    assert.deepEqual(gate(foldLedger(f.session), hashes()), { allowed: true });
  });

  await scenario(async ({ f, hashes, edit, approve }) => {
    const originallySeen = hashes();
    f.artifact('p.plan.md', 'B');
    const recorded = hashes();
    await edit(originallySeen.plan!, recorded.plan!);
    f.artifact('p.plan.md', 'C');
    const current = hashes();
    await approve(current);
    assert.deepEqual(gate(foldLedger(f.session), hashes()), { allowed: true });
  });

  await scenario(async ({ f, hashes, edit, approve }) => {
    const approvedA = hashes();
    f.artifact('p.plan.md', 'C');
    const hashC = hashes().plan!;
    f.artifact('p.plan.md', 'A');
    const hashA = hashes().plan!;
    await edit(hashC, hashA);
    f.artifact('p.plan.md', 'B');
    const hashB = hashes().plan!;
    await edit(hashA, hashB);
    f.artifact('p.plan.md', 'C');
    const current = hashes();
    await edit(hashB, current.plan!);
    await approve(approvedA);
    assert.deepEqual(gate(foldLedger(f.session), hashes()), { allowed: true });
  });

  await scenario(async ({ f, hashes, edit, approve }) => {
    const approved = hashes();
    f.artifact('p.plan.md', 'B');
    const current = hashes();
    await edit(approved.plan!, current.plan!, 'intent');
    await assertStale(() => approve(approved), hashes());
  });

  await scenario(async ({ f, hashes, edit, approve }) => {
    const approved = hashes();
    f.artifact('p.plan.md', 'B');
    const hashB = hashes().plan!;
    await edit(approved.plan!, hashB);
    f.artifact('p.plan.md', 'unrelated');
    const unrelated = hashes().plan!;
    f.artifact('p.plan.md', 'C');
    const current = hashes();
    await edit(unrelated, current.plan!);
    await assertStale(() => approve(approved), current);
  });
});
