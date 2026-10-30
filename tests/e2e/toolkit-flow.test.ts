import { spawnSync } from 'node:child_process';
import { parsePlan } from '../../skills/dispatch/scripts/toolkit/domain/plan.ts';
import { redGaps } from '../../skills/dispatch/scripts/toolkit/red.ts';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {toolkitRepo,planSource,captureIntegrationReview} from './helpers/toolkit-repo.ts';
import {appendRecord,currentHashes,foldLedger,latest} from '../../skills/dispatch/scripts/toolkit/ledger.ts';

describe('toolkit status sections', () => {
  test('reports the pending conflict and missing writer worktree',async()=>{
    const f=await toolkitRepo(); try {
      await f.level(); const made=await f.run(['worktree','create','T1']); const writer=path.resolve(f.session,made.value.path);
      fs.rmSync(writer,{recursive:true,force:true}); assert.equal((await f.run(['status','show'])).value.writers[0].state,'missing-worktree');
      assert.equal((await f.run(['worktree','create','T1'])).exit,0);
      fs.writeFileSync(path.join(writer,'src/file.ts'),'writer\n'); await f.run(['worktree','submit','T1']);
      fs.writeFileSync(path.join(f.integration,'src/file.ts'),'integration\n'); await f.run(['worktree','commit','--reason','conflict']);
      const picked=await f.run(['worktree','integrate','T1']); assert.equal(picked.output.reason,'conflict');
      const status=await f.run(['status','show']); assert.equal(status.exit,0); assert.equal(status.value.integration.pendingConflict.task,'T1'); assert.deepEqual(status.value.integration.pendingConflict.paths,['src/file.ts']);
    } finally {f.cleanup();}
  });
  test('tracks writer integration evidence dirtiness missing directory and closure without locking', async () => {
    const f=await toolkitRepo(); try {
      const status=async()=>{ const r=await f.run(['status','show']); assert.equal(r.exit,0); assert.equal(fs.existsSync(path.join(f.session,'.state/lock')),false); return r.value; };
      await f.level();
      await f.run(['worktree','create','T1']);
      let s=await status(); assert.equal(s.writers[0].state,'no-progress'); assert.deepEqual(s.criteria,['SC1','contract']);
      const writer=path.resolve(f.session,s.writers[0].path);
      fs.writeFileSync(path.join(writer,'src/file.ts'),'changed\n');
      assert.equal((await status()).writers[0].state,'ready-to-submit');
      assert.equal((await f.run(['worktree','submit','T1'])).exit,0);
      assert.equal((await status()).writers[0].state,'candidate-unintegrated');
      await f.run(['worktree','integrate','T1']); s=await status();
      assert.equal(s.writers[0].state,'integrated'); assert.equal(s.integration.undelivered,true); assert.equal(s.integration.pendingConflict,null);
      assert.equal(s.integration.head,f.git(['rev-parse','HEAD'],f.integration)); assert.equal(s.integration.branch,'dispatch/test/integration');
      await f.run(['verify','run']); assert.deepEqual((await status()).criteria,[]);
      const tracked=path.join(f.integration,'src/file.ts'); const original=fs.readFileSync(tracked);
      const extra=path.join(f.integration,'extra'); fs.writeFileSync(extra,'extra');
      fs.writeFileSync(tracked,'dirty'); assert.deepEqual((await status()).criteria,['SC1','contract']);
      fs.writeFileSync(tracked,original); fs.rmSync(extra); assert.deepEqual((await status()).criteria,[]);
      fs.writeFileSync(tracked,'fix\n'); await f.run(['worktree','commit','--reason','repair']); assert.deepEqual((await status()).criteria,['SC1','contract']);
      await f.run(['verify','run']); await f.run(['worktree','deliver']); assert.equal((await status()).integration.undelivered,false);
      fs.rmSync(f.integration,{recursive:true,force:true}); s=await status(); assert.equal(s.integration.state,'missing'); assert.deepEqual(s.criteria,['SC1','contract']);
      assert.equal((await f.run(['verify','run'])).exit,0); assert.deepEqual((await status()).criteria,[]);
      await f.run(['worktree','close','--reason','done']); assert.equal((await status()).integration.closed,true);
    } finally {f.cleanup();}
  });
});

describe('toolkit session flow', () => {
  test('writer briefs address ignored canonical files outside task worktrees', async () => {
    const f = await toolkitRepo(); try {
      const directory = path.join(f.session, 'canonical inputs');
      fs.mkdirSync(directory, {recursive: true});
      fs.appendFileSync(path.join(f.root, '.git/info/exclude'), '\n/' + path.basename(f.session) + '/\n');
      const originals = {spec: fs.readFileSync(path.join(f.root, 'work.spec.md'), 'utf8'), plan: planSource, design: '# Strategy\n'};
      const bound = Object.fromEntries(Object.entries(originals).map(([kind, source]) => {
        const file = path.join(directory, 'work.' + kind + '.md');
        fs.writeFileSync(file, source);
        return [kind, path.relative(f.root, file).split(path.sep).join('/')];
      }));
      assert.equal(f.git(['check-ignore', '--', ...Object.values(bound)]).split(/\r?\n/).length, 3);
      await appendRecord(f.session, {kind: 'bind', key: 'session-artifacts', by: 'orchestrator', data: bound}, f.deps);
      await f.level('low');
      const made = await f.run(['worktree', 'create', 'T1']);
      assert.equal(made.exit, 0);
      const worktree = path.resolve(f.session, made.value.path);
      const rendered = await f.run(['brief', 'render', 'T1']);
      assert.equal(rendered.exit, 0);
      const brief = fs.readFileSync(rendered.value.path, 'utf8');
      const hashes = currentHashes(f.root, latest(foldLedger(f.session), 'bind'));
      for (const [kind, label] of [['spec', 'Read the governing spec whole'], ['plan', 'Governing plan'], ['design', 'Governing design']] as const) {
        const address = new RegExp(label + ': `([^`]+)`').exec(brief)?.[1];
        assert.ok(address, kind + ' read address');
        assert.equal(fs.existsSync(path.resolve(worktree, bound[kind]!)), false);
        assert.equal(fs.readFileSync(path.resolve(worktree, address), 'utf8'), originals[kind]);
        assert.ok(brief.includes(hashes[kind]!));
      }
    } finally {f.cleanup();}
  });
  test('refuses intent changes and orders brief snapshots with concurrent ledger edits',async()=>{
    const f=await toolkitRepo(); try {
      await f.approve(); await f.run(['worktree','create','T1']);
      const before=currentHashes(f.root,latest(foldLedger(f.session),'bind'));
      fs.writeFileSync(path.join(f.root,'work.plan.md'),planSource.replace('# Work','# Work\nClarified.'));
      const after=currentHashes(f.root,latest(foldLedger(f.session),'bind'));
      await f.edit({artifact:'plan',before:before.plan,after:after.plan,class:'non-intent',affects:['T1'],diffRef:'diff',rationale:'clarify'});
      const file=path.join(f.session,'edit.json'); fs.writeFileSync(file,JSON.stringify({kind:'edit',key:'clarify',by:'orchestrator',data:{artifact:'plan',before:after.plan,after:after.plan,class:'non-intent',affects:['T1'],diffRef:'diff',rationale:'record unchanged task scope'}}));
      const [brief,edit]=await Promise.all([f.concurrent(['brief','render','T1']),f.concurrent(['ledger','append',file])]);
      assert.equal(edit.exit,0,JSON.stringify(edit)); assert.equal(brief.exit,0,JSON.stringify(brief));
      assert.equal(brief.value.path,path.join(f.session,'.state/briefs/T1-1.md'));
      const rendered=fs.readFileSync(brief.value.path,'utf8'); assert.match(rendered,/Clarified/); assert.ok(rendered.includes(after.plan!));
      const recorded=foldLedger(f.session).records.find(record=>record.seq===edit.value.seq)!; assert.equal(recorded.key,'clarify'); assert.equal(recorded.data['before'],after.plan); assert.equal(recorded.data['after'],after.plan);
      const bound=currentHashes(f.root,latest(foldLedger(f.session),'bind')); fs.appendFileSync(path.join(f.root,'work.plan.md'),'\nIntent changed.\n');
      const changed=currentHashes(f.root,latest(foldLedger(f.session),'bind'));
      await f.edit({artifact:'plan',before:bound.plan,after:changed.plan,class:'intent',affects:['T1'],diffRef:'diff',rationale:'intent'});
      for(const args of [['brief','render','T1'],['worktree','integrate','T1']]) {const result=await f.concurrent(args); assert.equal(result.exit,4); assert.equal(result.output.reason,'intent-change');}
    } finally {f.cleanup();}
  });
  test('lets submit complete while a spawned verification command runs unlocked',async()=>{
    const command=`node -e "require('fs').writeFileSync('ignored','started');setTimeout(()=>{},1500)"`;
    const f=await toolkitRepo(planSource.replace('node -e "process.exit(0)"',command)); try {
      await f.level(); const created=await f.run(['worktree','create','T1']); fs.writeFileSync(path.resolve(f.session,created.value.path,'src/file.ts'),'writer\n');
      const verify=f.concurrent(['verify','run']);
      const deadline=Date.now()+15000; while(!fs.existsSync(path.join(f.integration,'ignored'))) {assert.ok(Date.now()<deadline); await new Promise(resolve=>setTimeout(resolve,20));}
      const submit=await f.concurrent(['worktree','submit','T1']); assert.equal(submit.exit,0); const checked=await verify; assert.equal(checked.exit,0);
      const rows=foldLedger(f.session).records; const seqs=rows.map(row=>row.seq); assert.equal(new Set(seqs).size,seqs.length); assert.deepEqual(seqs,[...seqs].sort((a,b)=>a-b));
      assert.ok(rows.find(row=>row.data['phase']==='finished')!.seq<rows.find(row=>row.kind==='evidence')!.seq);
    } finally {f.cleanup();}
  });
  test('uncommitted delivery composes medium writer and exact tree verification', async()=>{
    const f=await toolkitRepo(); try {
      await f.level('medium'); await f.approve();
      for(const args of [['worktree','create','T1'],['brief','render','T1']]) assert.equal((await f.run(args)).exit,0);
      const brief=(await f.run(['brief','render','T1'])).value; assert.ok(fs.existsSync(brief.path));
      const writer=JSON.parse(fs.readFileSync((await f.run(['status','show'])).output.path,'utf8')).writers[0].path;
      fs.writeFileSync(path.resolve(f.session,writer,'src/file.ts'),'delivered\n');
      for(const args of [['worktree','submit','T1'],['worktree','integrate','T1'],['verify','run']]) assert.equal((await f.run(args)).output.ok,true);
      fs.writeFileSync(path.join(f.integration,'src/file.ts'),'fixed\n'); assert.equal((await f.run(['worktree','commit','--reason','fix'])).exit,0); await f.run(['verify','run']);
      assert.deepEqual((await f.run(['status','show'])).value.criteria,[]);
      const callerHead=f.git(['rev-parse','HEAD']); assert.equal((await f.run(['worktree','deliver'])).exit,0); assert.equal(f.git(['rev-parse','HEAD']),callerHead); assert.notEqual(callerHead,f.git(['rev-parse','HEAD'],f.integration)); assert.equal(fs.readFileSync(path.join(f.root,'src/file.ts'),'utf8'),'fixed\n'); assert.equal(f.git(['diff','--cached','--name-only']),'');
    } finally {f.cleanup();}
  });
});

const capturePlanSource = [
  '# Capture RED output',
  '',
  '## Task Map',
  '| ID | Title | Outcome | Prerequisites | Criteria |',
  '| --- | --- | --- | --- | --- |',
  '| T1 | Capture | Preserve subprocess evidence | none | SC1 |',
  '',
  '## Proposed Changes',
  '### T1 — Capture',
  '#### [MODIFY] src/file.ts',
  '- Purpose: Holds the implementation under test.',
  '#### [NEW] `tests/with space.test.ts`',
  '- Purpose: Gives the capture command a path that needs shell quoting.',
  '',
  '## Success Criteria',
  '- [SC1] Captured output is retained',
  '  - Satisfies: REQ-1',
  '  - Changes: src/file.ts, `tests/with space.test.ts`',
  '  - Tests: `tests/with space.test.ts`',
  '  - Verify: `node -e "process.exit(0)"`',
  '  - RED: `node -e "process.stdout.write(\'raw stdout\'); process.stderr.write(\'raw stderr\'); process.exit(7)" {files}`',
  '  - Evidence: red',
  '',
  '## Verification Plan',
  'Seams: tests/e2e/toolkit-flow.test.ts',
  '### Automated Tests',
  '- `node -e "process.stdout.write(\'contract\')"`',
  '',
].join('\n');

function commandFrom(brief: string): string {
  const marker = '## RED capture commands\n';
  const start = brief.indexOf(marker);
  assert.notEqual(start, -1, 'brief includes a RED capture section');
  const section = brief.slice(start + marker.length).split(/\n## /, 1)[0]!;
  const match = /`(node -e [^`]+)`/.exec(section);
  assert.ok(match, 'brief includes a runnable outer node -e command');
  return match[1]!;
}

function commandData(command: string): { bootstrap: string; data: { command: string; cwd: string; logDir: string; criterion: string } } {
  const match = /([A-Za-z0-9_-]+) ([A-Za-z0-9_-]+)$/.exec(command);
  assert.ok(match, 'outer command ends with two base64url arguments');
  return {
    bootstrap: Buffer.from(match[1]!, 'base64url').toString('utf8'),
    data: JSON.parse(Buffer.from(match[2]!, 'base64url').toString('utf8')) as { command: string; cwd: string; logDir: string; criterion: string },
  };
}

test('captured RED command preserves raw output and status and its report clears redGaps', async () => {
  const f = await toolkitRepo(capturePlanSource, {'tests/with space.test.ts': 'export const caseName = "capture";\n'});
  try {
    await f.level('low');
    await appendRecord(f.session, {
      kind: 'writer', by: 'orchestrator', key: 'writer:T1:1',
      data: {phase: 'launched', task: 'T1', path: '.state/worktrees/T1-1', base: {commit: 'a'.repeat(40), taskSection: 'sha256:' + 'b'.repeat(64), seq: 1}},
    }, f.deps);
    const worktree = path.join(f.session, '.state', 'worktrees', 'T1-1');
    fs.mkdirSync(path.join(worktree, 'tests'), {recursive: true});
    fs.writeFileSync(path.join(worktree, 'tests', 'with space.test.ts'), 'export const caseName = "capture";\n');

    const rendered = await f.run(['brief', 'render', 'T1']);
    assert.equal(rendered.exit, 0);
    const brief = fs.readFileSync(rendered.value.path, 'utf8');
    const command = commandFrom(brief);
    const {data} = commandData(command);
    const quotedPath = process.platform === 'win32' ? '"tests/with space.test.ts"' : "'tests/with space.test.ts'";
    assert.ok(data.command.endsWith(quotedPath), 'test path is quoted for the shell used by spawnSync');
    assert.equal(data.cwd, worktree);
    assert.equal(data.logDir, path.join(f.session, '.state', 'briefs', 'T1-1.red'));
    assert.equal(data.criterion, 'SC1');
    assert.match(command, /^node -e ".*" [A-Za-z0-9_-]+ [A-Za-z0-9_-]+$/);
    assert.doesNotMatch(command, /[$%]/);

    const captured = spawnSync(command, {cwd: f.root, shell: true, encoding: 'buffer', windowsHide: true});
    assert.ifError(captured.error);
    assert.equal(captured.status, 7, captured.stderr?.toString('utf8'));
    assert.deepEqual(captured.stdout, Buffer.from('raw stdout'));
    assert.deepEqual(captured.stderr, Buffer.from('raw stderr'));

    const logDir = data.logDir;
    assert.deepEqual(fs.readFileSync(path.join(logDir, 'SC1.stdout')), Buffer.from('raw stdout'));
    assert.deepEqual(fs.readFileSync(path.join(logDir, 'SC1.stderr')), Buffer.from('raw stderr'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(logDir, 'SC1.exit'), 'utf8')).status, 7);

    const outer = /^(node -e ".*") ([A-Za-z0-9_-]+) ([A-Za-z0-9_-]+)$/.exec(command);
    assert.ok(outer, 'generated wrapper has a reusable bootstrap and encoded input');
    const at = 1024 * 1024;
    const above = 1024 * 1024 + 1;
    const boundaries = [
      {name: 'stdout at', stdout: at, stderr: 0},
      {name: 'both above', stdout: above, stderr: above},
    ];
    const boundaryFailures: string[] = [];
    for (const boundary of boundaries) {
      const childCommand = `node -e "const fs=require('node:fs');fs.writeSync(1,Buffer.alloc(${boundary.stdout},165));fs.writeSync(2,Buffer.alloc(${boundary.stderr},90));process.exit(7)"`;
      const input = Buffer.from(JSON.stringify({...data, command: childCommand}), 'utf8').toString('base64url');
      const invoked = spawnSync(`${outer[1]} ${outer[2]} ${input}`, {
        cwd: f.root, shell: true, encoding: 'buffer', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
      });
      const expectedStdout = Buffer.alloc(boundary.stdout, 165);
      const expectedStderr = Buffer.alloc(boundary.stderr, 90);
      if (invoked.error) boundaryFailures.push(`${boundary.name}: wrapper error ${invoked.error.message}`);
      if (invoked.status !== 7) boundaryFailures.push(`${boundary.name}: wrapper status ${invoked.status}, expected 7`);
      if (!invoked.stdout?.equals(expectedStdout)) boundaryFailures.push(`${boundary.name}: replayed stdout bytes differ`);
      if (!invoked.stderr?.equals(expectedStderr)) boundaryFailures.push(`${boundary.name}: replayed stderr bytes differ`);
      if (!fs.readFileSync(path.join(logDir, 'SC1.stdout')).equals(expectedStdout)) boundaryFailures.push(`${boundary.name}: captured stdout bytes differ`);
      if (!fs.readFileSync(path.join(logDir, 'SC1.stderr')).equals(expectedStderr)) boundaryFailures.push(`${boundary.name}: captured stderr bytes differ`);
      const exit = JSON.parse(fs.readFileSync(path.join(logDir, 'SC1.exit'), 'utf8')) as {status: number | null; signal: string | null; error: string | null};
      if (exit.status !== 7 || exit.signal !== null || exit.error !== null) boundaryFailures.push(`${boundary.name}: exit metadata ${JSON.stringify(exit)}`);
    }
    assert.deepEqual(boundaryFailures, [], boundaryFailures.join('\n'));

    const reportPath = path.join(f.session, '.state', 'briefs', 'T1-1.report.md');
    assert.ok(brief.includes(reportPath));
    fs.writeFileSync(reportPath, [
      '## Observed RED failures',
      `SC1 | tests/with space.test.ts | ${path.join(logDir, 'SC1.stdout')} | ${path.join(logDir, 'SC1.stderr')} | ${path.join(logDir, 'SC1.exit')}`,
      '',
    ].join('\n'));
    const parsed = parsePlan(capturePlanSource);
    assert.ok(parsed.ok, JSON.stringify(parsed));
    assert.deepEqual(redGaps({
      plan: parsed.plan,
      task: 'T1',
      changed: [],
      report: fs.readFileSync(reportPath, 'utf8'),
    }), []);
  } finally { f.cleanup(); }
});

