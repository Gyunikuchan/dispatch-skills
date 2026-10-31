import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { main, type CliDeps } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { capSummary, summaryWithItems } from '../../../skills/dispatch/scripts/toolkit/output.ts';
import { memoryNodeFs } from '../../helpers/memory-node-fs.ts';
import {appendRecord,currentHashes,foldLedger,latest} from '../../../skills/dispatch/scripts/toolkit/ledger.ts';

function sessionFixture() {
  // Quota ancestor checks stay inside this shallow virtual root.
  const root=path.join(path.parse(os.tmpdir()).root,'output-cap-'+crypto.randomUUID());
  const cleanup=memoryNodeFs(root), session=path.join(root,'.scratch/dispatch-skills/20261023T0000Z-test');
  fs.mkdirSync(session,{recursive:true});
  fs.writeFileSync(path.join(session,'manifest.json'),JSON.stringify({schemaVersion:1,folderName:path.basename(session),sessionId:'test',safeSessionId:'test',repositoryRoot:fs.realpathSync(root)}));
  const lines:string[]=[], replies=new Map<string,string>();
  const deps:CliDeps={
    run:async()=>{throw new Error('Unit tests must not spawn processes');},
    delegate:async(provider,request)=>{
      const text=replies.get(provider+':'+request.model);
      if(text===undefined)throw new Error('Unscripted delegate '+provider+':'+request.model);
      return {outcome:{status:'ok',text,resume:null,sessionId:null},invocations:[]};
    },
    modes:()=>['cli'],orchestrator:null,liveness:{claude:true,agy:true,codex:true,copilot:true,opencode:true},
    stdout:line=>lines.push(line),env:{},clock:()=>0,sleep:async()=>{},pid:42,host:'test-host',isAlive:()=>false,skillRoot:path.resolve('skills/dispatch'),
  };
  return {root,session,lines,deps,cleanup,
    artifact:(name:string,source:string)=>{const file=path.join(root,name);fs.writeFileSync(file,source);return file;},
    script:(provider:string,model:string,text:string)=>replies.set(provider+':'+model,text),
    output:()=>{assert.equal(lines.length,1);return JSON.parse(lines[0]!) as {ok:boolean;summary:string;path:string|null;reason?:string};},
  };
}

test('summary byte cap preserves large ask answers review findings and native slots', async () => {
  const missingReasons: string[] = [];
  for (const scenario of ['ask', 'findings', 'native'] as const) {
    const f = sessionFixture();
    try {
      const skill = path.join(f.root, 'skill');
      fs.mkdirSync(path.join(skill, 'references/templates'), {recursive: true});
      for (const file of ['review-prompt.md', 'review-prompt-plan.md', 'quality-bar.md'])
        fs.copyFileSync(path.join(f.deps.skillRoot, 'references/templates', file), path.join(skill, 'references/templates', file));
      const native = scenario === 'native';
      fs.writeFileSync(path.join(skill, 'config.jsonc'), JSON.stringify({
        'read-delegates': {codex: {nativeSubagentsOnly: native, targets: Array.from({length: native ? 20 : 1}, () => ({medium: {model: 'fixture'}}))}},
        phases: {'plan-review': {targets: {medium: native ? 20 : 1}, rounds: {medium: 1}}},
      }));
      f.deps.skillRoot = skill;
      if (native) f.deps.orchestrator = {platform: 'codex', model: null};
      const answer = '日本語😀'.repeat(2000);
      const findings = Array.from({length: 300}, (_, i) => ({severity: 'SHOULD', tag: 'correctness',
        locus: `§ Work ${i}`, defect: `日本語😀 defect ${i}`, requiredChange: `修正 ${i}`}));
      f.script('codex', 'fixture', scenario === 'ask' ? answer : JSON.stringify({status: 'FINDINGS', findings}));
      const target = f.artifact(scenario === 'ask' ? 'question.md' : 'work.plan.md', '# Work\n## Work\n日本語\n');
      if (scenario === 'ask') f.artifact('work.plan.md', '# Work\n');
      f.artifact('mission.spec.md', '# Mission\n## Intent & Problem\nPreserve results.\n');
      await appendRecord(f.session, {kind: 'bind', by: 'orchestrator', key: 'bind',
        data: {spec: 'mission.spec.md', plan: 'work.plan.md'}}, f.deps);
      f.artifact('work.plan.context.md', '# Context map: work\n');
      await appendRecord(f.session, {kind: 'confirm', by: 'user', quote: 'Approved', key: 'confirm',
        data: {spec: currentHashes(f.root, latest(foldLedger(f.session), 'bind')).spec}}, f.deps);
      const args = scenario === 'ask' ? ['ask', 'run', target] : ['review', 'run', target, '--kind', 'plan'];
      assert.equal(await main([...args, '--session', f.session], f.deps), native ? 4 : 0, f.lines.join('\n'));
      const output = f.output();
      assert.ok(Buffer.byteLength(output.summary, 'utf8') <= 1024);
      assert.equal(output.ok, !native);
      if (!Object.hasOwn(output, 'reason')) missingReasons.push(scenario);
      assert.ok(output.path);
      const result = JSON.parse(fs.readFileSync(output.path, 'utf8'));
      if (scenario === 'ask') assert.deepEqual(result.answers, [{slot: 'codex[0]', provider: 'codex', responder: {slot: 'codex[0]', provider: 'codex', model: 'fixture', native: false}, text: answer}]);
      if (scenario === 'findings') {
        const captured = JSON.parse(fs.readFileSync(result.path, 'utf8'));
        assert.equal(captured.findings.length, 300);
        assert.deepEqual(captured.findings.map((finding: {defect: string}) => finding.defect), findings.map(finding => finding.defect));
      }
      if (native) {
        assert.equal(output.reason, 'native-pending');
        assert.equal(result.pending.length, 20);
        assert.equal(new Set(result.pending.map((slot: {slot: string}) => slot.slot)).size, 20);
        assert.ok(result.pending.every((slot: {promptPath: string; replyPath: string}) => fs.existsSync(slot.promptPath) && slot.replyPath));
      }
    } finally {f.cleanup();}
  }
  assert.deepEqual(missingReasons, []);
});

test('summary byte cap includes marker and preserves multibyte code points', () => {
  for (const text of ['a'.repeat(2000), 'a'.repeat(1020) + '😀'.repeat(300), '界'.repeat(500)]) {
    const summary = capSummary(text);
    assert.ok(Buffer.byteLength(summary) <= 1024);
    assert.ok(summary.endsWith('…'));
    assert.equal(Buffer.from(summary).toString('utf8'), summary);
    assert.ok(text.startsWith(summary.slice(0, -1)));
  }
});

test('summary byte cap keeps the full gated multibyte brief for two hundred criteria',async()=>{
  const f=sessionFixture(); try {
    const ids=Array.from({length:200},(_,i)=>'SC'+(i+1));
    const source='# Work\n日本語の共有文\n## Task Map\n| ID | Title | Outcome | Prerequisites | Criteria |\n| --- | --- | --- | --- | --- |\n| T1 | Work | Works | none | '+ids.join(', ')+' |\n## Proposed Changes\n### T1 — Work\n#### [NEW] src/file.ts\n- Purpose: 日本語.\n## Success Criteria\n'+ids.map(id=>'- ['+id+'] 日本語 works\n  - Changes: src/file.ts\n  - Verify: `node check.ts`\n  - Evidence: verify').join('\n')+'\n## Verification Plan\n### Automated Tests\n- `node check.ts`\n';
    const plan=f.artifact('large-multibyte.plan.md',source); f.artifact('mission.spec.md','# Mission\n');
    const skill=path.join(f.root,'skill'); const templates=path.join(skill,'references/templates'); fs.mkdirSync(templates,{recursive:true});
    for(const file of ['writer-brief.md','quality-bar.md']) fs.copyFileSync(path.join(f.deps.skillRoot,'references/templates',file),path.join(templates,file));
    const add=(kind:string,data:object,extra:object={})=>appendRecord(f.session,{kind,by:'orchestrator',key:kind,data,...extra},f.deps);
    await add('bind',{spec:'mission.spec.md',plan:'large-multibyte.plan.md'});
    await add('confirm',{spec:currentHashes(f.root,latest(foldLedger(f.session),'bind')).spec},{by:'user',quote:'Approved'});
    await add('approval',currentHashes(f.root,latest(foldLedger(f.session),'bind')),{by:'user',quote:'Approved'});
    await add('writer',{phase:'launched',task:'T1',path:'.state/worktrees/T1-1',base:{commit:'a'.repeat(40),taskSection:'sha256:'+'b'.repeat(64),seq:1}});
    assert.equal(await main(['brief','render','T1','--session',f.session],{...f.deps,skillRoot:skill,hook:point=>{if(point==='brief:after-gate') fs.writeFileSync(plan,'UNGATED');}}),0);
    const output=f.output(); assert.ok(Buffer.byteLength(output.summary)<=1024); const result=JSON.parse(fs.readFileSync(output.path!,'utf8'));
    const brief=fs.readFileSync(result.path,'utf8'); assert.equal(result.bytes,Buffer.byteLength(brief)); assert.match(brief,/\[SC200\] 日本語 works/); assert.ok(!brief.includes('UNGATED'));
  } finally {f.cleanup();}
});

test('summary byte cap applies to every tool with full result files including refusals', async () => {
  const f = sessionFixture();
  try {
    const records: unknown[] = Array.from({ length: 500 }, (_, i) => ({ seq: i + 1, key: 'n' + i, at: 'now', kind: 'note', by: 'tool', data: { text: '界'.repeat(600) } }));
    records.push(...Array.from({ length: 100 }, (_, i) => ({ seq: 501 + i, key: 'e' + i, at: 'now', kind: 'escalation', by: 'tool', data: { id: 'e' + i, state: 'open', summary: 'pending' } })));
    fs.writeFileSync(path.join(f.session, 'ledger.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
    const input = f.artifact('record.json', JSON.stringify({ kind: 'note', key: 'append', by: 'tool', data: { text: '界'.repeat(600) } }));
    const invalid = f.artifact('invalid.json', '{}');
    const plan = f.artifact('large.plan.md', '## Success Criteria\n' + Array.from({ length: 200 }, (_, i) =>
      '- [SC' + (i + 1) + '] File works\n  - Changes: src/file.ts\n  - Verify: `node check.ts`\n  - Evidence: verify\n').join('\n'));
    const skill = path.join(f.root, 'skill');
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, 'config.jsonc'), JSON.stringify(Object.fromEntries(Array.from({ length: 200 }, (_, i) => ['bad' + i, true]))));
    for (const [args, exit] of [
      [['ledger', 'append', input], 0], [['ledger', 'query'], 0], [['lint', 'run', plan], 4],
      [['doctor', 'run'], 0], [['status', 'show'], 0], [['ledger', 'append', invalid], 1],
      [['ledger', 'query', '--kind', 'unknown'], 1], [['lint', 'run', 'missing.plan.md'], 1],
    ] as const) {
      f.lines.length = 0;
      assert.equal(await main([...args, '--session', f.session], { ...f.deps, skillRoot: skill }), exit);
      const output = f.output();
      assert.ok(Buffer.byteLength(output.summary) <= 1024);
      assert.ok(fs.existsSync(output.path!));
      const result = JSON.parse(fs.readFileSync(output.path!, 'utf8'));
      if (args[0] === 'lint' && exit === 4) assert.ok(result.warnings.length >= 200);
      if (args[0] === 'doctor') assert.ok(result.config.problems.length >= 200);
      if (args[0] === 'status') assert.equal(result.escalations.length, 100);
      if (args[0] === 'ledger' && args[1] === 'query' && exit === 0) assert.equal(result.length, 601);
    }
  } finally { f.cleanup(); }
});

test('summary byte cap keeps all report rows in its result file', async () => {
  const f = sessionFixture();
  try {
    const ids = Array.from({length: 300}, (_, i) => 'SC' + (i + 1));
    const source = '# Work\n日本語の共有文\n## Task Map\n| ID | Title | Outcome | Prerequisites | Criteria |\n| --- | --- | --- | --- | --- |\n| T1 | Work | Works | none | ' + ids.join(', ') + ' |\n## Proposed Changes\n### T1 — Work\n#### [NEW] src/file.ts\n- Purpose: 日本語.\n## Success Criteria\n' + ids.map(id => '- [' + id + '] 日本語 works\n  - Changes: src/file.ts\n  - Verify: `node check.ts`\n  - Evidence: verify').join('\n') + '\n## Verification Plan\n### Automated Tests\n- `node check.ts`\n';
    f.artifact('report.spec.md', '# Mission\n');
    f.artifact('report.plan.md', source);
    await appendRecord(f.session, {kind: 'bind', by: 'orchestrator', key: 'bind',
      data: {spec: 'report.spec.md', plan: 'report.plan.md'}}, f.deps);

    const quotes = ids.map((_, i) => `由用户批准界😀 ${i}`);
    const records = [
      ...ids.map((criterion, i) => ({
        seq: i + 2, key: 'waiver-' + (i + 1), at: 'now', kind: 'waiver', by: 'user', quote: quotes[i],
        data: {criterion, reason: 'accepted with evidence ' + (i + 1)},
      })),
      ...ids.map((criterion, i) => ({
        seq: i + 302, key: 'edit-' + (i + 1), at: 'now', kind: 'edit', by: 'orchestrator',
        data: {artifact: 'plan', before: 'sha256:' + 'a'.repeat(64), after: 'sha256:' + 'b'.repeat(64),
          class: 'non-intent', affects: [criterion], rationale: 'revised plan entry ' + (i + 1), diffRef: 'diff-' + (i + 1)},
      })),
    ];
    fs.appendFileSync(path.join(f.session, 'ledger.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
    const skill = path.join(f.root, 'skill');
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, 'config.jsonc'), '{"diagnostics":false}');

    assert.equal(await main(['report', 'render', '--session', f.session], {...f.deps, skillRoot: skill}), 0);
    const output = f.output();
    assert.ok(Buffer.byteLength(output.summary, 'utf8') <= 1024);
    assert.equal(output.ok, true);
    assert.ok(output.path);
    const result = JSON.parse(fs.readFileSync(output.path, 'utf8'));
    const criteria = result.statuses.filter((row: {criterion: string}) => row.criterion !== 'contract');
    assert.deepEqual(criteria.map((row: {criterion: string; state: string}) => [row.criterion, row.state]), ids.map(id => [id, 'waived']));
    assert.equal(result.deviations.edits.length, 300);
    assert.deepEqual(result.deviations.edits.map((edit: {affects: string[]}) => edit.affects[0]), ids);
    assert.deepEqual(result.userRecords.map((record: {quote: string}) => record.quote), quotes);
  } finally { f.cleanup(); }
});

test('summary items keep totals and remaining count within the cap', () => {
  const head = 'plan: 4 errors, 2 warnings; sha256:' + 'a'.repeat(64);
  assert.equal(summaryWithItems(head, []), head);
  const long = [
    ...Array.from({length: 4}, (_, i) => `L${i} long-${i} ${'x'.repeat(600)}`),
    ...Array.from({length: 4}, (_, i) => `L${i} multi-${i} ${'界'.repeat(300)}`),
  ];
  const summary = summaryWithItems(head, long);
  assert.ok(Buffer.byteLength(summary, 'utf8') <= 1024);
  assert.equal(capSummary(summary), summary);
  assert.equal(Buffer.from(summary, 'utf8').toString('utf8'), summary);
  assert.ok(summary.startsWith(head + '; first '));
  const shown = Number(/; first (\d): /.exec(summary)![1]);
  const omitted = Number(/; \+(\d+) more in result$/.exec(summary)![1]);
  assert.ok(shown >= 1 && shown <= 5);
  assert.equal(shown + omitted, long.length);
  assert.ok(summary.includes('…'));
  const short = Array.from({length: 8}, (_, i) => `L${i} short`);
  const shortSummary = summaryWithItems(head, short);
  assert.match(shortSummary, /; first 5: L0 short; L1 short; L2 short; L3 short; L4 short; \+3 more in result$/);
});
