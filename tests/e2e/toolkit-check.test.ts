import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { toolkitRepo, planSource } from './helpers/toolkit-repo.ts';
import { foldLedger } from '../../skills/dispatch/scripts/toolkit/ledger.ts';

describe('toolkit check', () => {
  test('records selected tree bound evidence and adopts the integration worktree on rerun', async () => {
    const f=await toolkitRepo(); try {
      let r=await f.run(['check','run']); assert.equal(r.exit,0); assert.equal(r.output.ok,true);
      const rows=()=>foldLedger(f.session).records;
      assert.equal(rows().filter(r=>r.kind==='evidence').length,2);
      assert.equal(rows().filter(r=>r.data['phase']==='opened').length,1);
      assert.equal(f.git(['branch','--show-current'],f.integration),'dispatch/test/integration');
      const first=rows().find(r=>r.kind==='evidence')!.data;
      assert.equal(first['tree'],f.git(['rev-parse','HEAD^{tree}'],f.integration)); assert.equal(first['clean'],true); assert.equal(first['exit'],0); assert.match(first['commandDigest'],/^sha256:/);
      await f.run(['check','run']);
      assert.equal(rows().length,7);
      assert.equal(rows().filter(r=>r.data['phase']==='opened').length,1);
      assert.equal(rows().at(-1)!.data['tree'],first['tree']);
      fs.writeFileSync(path.join(f.integration,'ignored'),'ignored');
      await f.run(['check','run','--criteria','SC1']);
      assert.equal(rows().length,8);
      assert.equal(rows().at(-1)!.data['clean'],true);
      assert.equal(rows().at(-1)!.data['tree'],first['tree']);
      fs.writeFileSync(path.join(f.integration,'new.txt'),'new');
      r=await f.run(['check','run','--criteria','SC1']); assert.equal(r.output.reason,'dirty');
      assert.equal(rows().at(-1)!.data['clean'],false); assert.notEqual(rows().at(-1)!.data['tree'],first['tree']);
      assert.equal((await f.run(['check','run','--criteria','SC99'])).output.reason,'invalid-input');
      fs.rmSync(path.join(f.integration,'new.txt'));
      const trimmed = await f.run(['check','run','--criteria',' SC1, ']);
      assert.equal(trimmed.exit,0); assert.equal(trimmed.output.ok,true);
      const before = rows().length;
      const refused = await f.run(['check','run','--criteria','SC9, SC1, SC8']);
      assert.equal(refused.exit,1); assert.equal(refused.output.reason,'invalid-input');
      assert.equal(refused.output.summary,'Unknown criterion: SC9, SC8; valid: SC1, contract');
      assert.equal(rows().length,before);
    } finally {f.cleanup();}
  });
  test('records mutation and stops a criterion at its first failing command', async () => {
    for (const [command,reason,exit] of [[`node -e "require('fs').writeFileSync('src/file.ts','changed')"`,'mutated',0],[`node -e "process.exit(7)"`,'checks-failed',7]] as const) {
      const source=planSource.replace('node -e "process.exit(0)"',command);
      const f=await toolkitRepo(reason==='checks-failed' ? source.replace('  - Evidence: check', '  - Check: `node -e "require(\'fs\').writeFileSync(\'src/should-not-run\',\'bad\')"`\n  - Evidence: check') : source); try {
        const r=await f.run(['check','run','--criteria','SC1']); assert.equal(r.exit,0); assert.equal(r.output.ok,false); assert.equal(r.output.reason,reason);
        const evidence=foldLedger(f.session).records.filter(r=>r.kind==='evidence'); assert.equal(evidence.length,1); assert.equal(evidence[0]!.data['exit'],exit);
        if(reason==='mutated') assert.notEqual(evidence[0]!.data['before'],evidence[0]!.data['after']);
        if(reason==='checks-failed') assert.equal(fs.existsSync(path.join(f.integration,'src/should-not-run')),false);
      } finally {f.cleanup();}
    }
  });
  test('runs a command shared by criteria once per tree and records evidence for each', async () => {
    const shared=(target:string)=>planSource.replace('| SC1 |','| SC1, SC2 |').replace('`node -e "process.exit(0)"`',`\`node -e "require('fs').appendFileSync('${target}','x')"\``).replace('\n## Verification Plan',m=>`- [SC2] File still works\n  - Changes: src/file.ts\n  - Check: \`node -e "require('fs').appendFileSync('${target}','x')"\`\n  - Evidence: check\n${m}`);
    for (const [target,expected,reason] of [['ignored','x',undefined],['src/file.ts','initial\nxx','mutated']] as const) {
      const f=await toolkitRepo(shared(target)); try {
        const r=await f.run(['check','run','--criteria','SC1,SC2']); assert.equal(r.exit,0,JSON.stringify(r)); assert.equal(r.output.reason,reason);
        assert.equal(fs.readFileSync(path.join(f.integration,target),'utf8').replaceAll('\r\n','\n'),expected);
        assert.deepEqual(foldLedger(f.session).records.filter(x=>x.kind==='evidence').map(x=>x.data['criterion']),['SC1','SC2']);
      } finally {f.cleanup();}
    }
  });
  test('recovers an evidence file written before a crash, then records each later check run', async () => {
    const f=await toolkitRepo(); try {
      const crash=await f.run(['check','run','--criteria','SC1'],point=>{if(point==='check:after-evidence') throw new Error('crash');});
      assert.equal(crash.exit,2,JSON.stringify(crash)); assert.equal(crash.value.message,'crash',JSON.stringify(crash));
      assert.equal(foldLedger(f.session).records.filter(r=>r.kind==='evidence').length,0,JSON.stringify(crash));
      assert.ok(fs.readdirSync(path.join(f.session,'.state/evidence')).some(p=>p.endsWith('.json')),JSON.stringify(crash));
      const recovered=await f.run(['check','run','--criteria','SC1']); const repeated=await f.run(['check','run','--criteria','SC1']);
      assert.equal(recovered.exit,0,JSON.stringify(recovered)); assert.equal(repeated.exit,0,JSON.stringify(repeated));
      const evidence=foldLedger(f.session).records.filter(r=>r.kind==='evidence');
      assert.equal(evidence.length,2,JSON.stringify({recovered,repeated}));
      assert.notEqual(evidence[0]!.key, evidence[1]!.key);
      assert.notEqual(evidence[0]!.data['path'], evidence[1]!.data['path']);
    } finally {f.cleanup();}
  });
  test('refuses a detached caller without creating an integration worktree', async () => {
    const f=await toolkitRepo(); try { f.git(['checkout','--detach']); const r=await f.run(['check','run']); assert.equal(r.exit,4); assert.equal(r.output.reason,'caller-detached'); assert.equal(fs.existsSync(f.integration),false); } finally {f.cleanup();}
  });
  test('check run --task runs only the selected task criteria without contract and refuses invalid selectors', async () => {
    const multiTaskPlan = [
      '# Work', '', '## Task Map',
      '| ID | Title | Outcome | Prerequisites | Criteria |',
      '| --- | --- | --- | --- | --- |',
      '| T1 | First | First works | none | SC1, SC2 |',
      '| T2 | Second | Second works | none | SC3 |',
      '', '## Proposed Changes',
      '### T1 — First', '#### [MODIFY] src/file.ts', '- Purpose: updates first.',
      '### T2 — Second', '#### [NEW] src/other.ts', '- Purpose: adds second.',
      '', '## Success Criteria',
      '- [SC1] First works', '  - Changes: src/file.ts', '  - Check: `node -e "process.exit(0)"`', '  - Evidence: check',
      '- [SC2] First manual check', '  - Changes: src/file.ts', '  - Check: `node -e "process.exit(0)"`', '  - Evidence: review', '  - Review: artifact: src/file.ts; scenario: inspect; pass: ok',
      '- [SC3] Second works', '  - Changes: src/other.ts', '  - Check: `node -e "process.exit(0)"`', '  - Evidence: check',
      '', '## Verification Plan', '### Automated Tests', '- `node -e "process.exit(0)"`', '- `node -e "process.stdout.write(\'contract\')"`', '',
    ].join('\n');
    const f = await toolkitRepo(multiTaskPlan);
    try {
      const r = await f.run(['check', 'run', '--task', 'T1']);
      assert.equal(r.exit, 0, JSON.stringify(r));
      assert.equal(r.output.ok, true);
      const recorded = foldLedger(f.session).records.filter(row => row.kind === 'evidence').map(row => row.data['criterion']);
      assert.deepEqual(recorded, ['SC1']);

      const both = await f.run(['check', 'run', '--task', 'T1', '--criteria', 'SC1']);
      assert.equal(both.exit, 1);
      assert.equal(both.output.reason, 'invalid-input');
      assert.match(both.output.summary, /check run/);

      const unknown = await f.run(['check', 'run', '--task', 'T99']);
      assert.equal(unknown.exit, 1);
      assert.equal(unknown.output.reason, 'invalid-input');
      assert.match(unknown.output.summary, /T1.*T2/);
    } finally { f.cleanup(); }
  });
  test('refuses a non-contract criterion with zero Check commands while allowing an empty contract row', async () => {
    const noCommandPlan = [
      '# Work', '', '## Task Map',
      '| ID | Title | Outcome | Prerequisites | Criteria |',
      '| --- | --- | --- | --- | --- |',
      '| T1 | File | Works | none | SC1 |',
      '', '## Proposed Changes',
      '### T1 — File', '#### [MODIFY] src/file.ts', '- Purpose: implements behavior.',
      '', '## Success Criteria',
      '- [SC1] File works', '  - Changes: src/file.ts', '  - Evidence: check',
      '', '## Verification Plan', '### Automated Tests', '- None: all checks are in criteria.', '',
    ].join('\n');
    const f1 = await toolkitRepo(noCommandPlan);
    try {
      const r = await f1.run(['check', 'run', '--criteria', 'SC1']);
      assert.equal(r.exit, 1);
      assert.equal(r.output.reason, 'invalid-input');
      assert.match(r.output.summary, /SC1/);
      assert.equal(fs.existsSync(f1.integration), false);
    } finally { f1.cleanup(); }

    const emptyContractPlan = noCommandPlan.replace('  - Evidence: check', '  - Check: `node -e "process.exit(0)"`\n  - Evidence: check');
    const f2 = await toolkitRepo(emptyContractPlan);
    try {
      const r = await f2.run(['check', 'run']);
      assert.equal(r.exit, 0, JSON.stringify(r));
      assert.equal(r.output.ok, true);
      assert.equal(r.value.executed, 1);
      assert.match(r.output.summary, /\(1 commands\)/);
    } finally { f2.cleanup(); }
  });
  test('reports zero executed commands when all criteria are review and Automated Tests is None', async () => {
    const reviewOnlyPlan = [
      '# Work', '', '## Task Map',
      '| ID | Title | Outcome | Prerequisites | Criteria |',
      '| --- | --- | --- | --- | --- |',
      '| T1 | File | Works | none | SC1 |',
      '', '## Proposed Changes',
      '### T1 — File', '#### [MODIFY] src/file.ts', '- Purpose: implements behavior.',
      '', '## Success Criteria',
      '- [SC1] File works', '  - Changes: src/file.ts', '  - Evidence: review', '  - Review: artifact: src/file.ts; scenario: inspect; pass: ok',
      '', '## Verification Plan', '### Automated Tests', '- None: manual review only.', '',
    ].join('\n');
    const f = await toolkitRepo(reviewOnlyPlan);
    try {
      const r = await f.run(['check', 'run']);
      assert.equal(r.exit, 0, JSON.stringify(r));
      assert.equal(r.output.ok, true);
      assert.equal(r.value.executed, 0);
      assert.match(r.output.summary, /\(0 commands\)/);
    } finally { f.cleanup(); }
  });
  test('refuses an empty --criteria list without creating integration', async () => {
    for (const criteria of ['', ' , ']) {
      const f = await toolkitRepo();
      try {
        const r = await f.run(['check', 'run', '--criteria', criteria]);
        assert.equal(r.exit, 1);
        assert.equal(r.output.reason, 'invalid-input');
        assert.match(r.output.summary, /check run --criteria/);
        assert.equal(fs.existsSync(f.integration), false);
      } finally { f.cleanup(); }
    }
  });

  test('deduplicates shared commands within a check run and bypasses dedup with --fresh', async () => {
    const sharedCmd = `node -e "require('fs').appendFileSync('ignored','1')"`;
    const distinctCmd = `node -e "require('fs').appendFileSync('ignored','2')"`;
    const sharedPlan = planSource
      .replace('| SC1 |', '| SC1, SC2 |')
      .replace('`node -e "process.exit(0)"`', `\`${sharedCmd}\``)
      .replace('\n## Verification Plan', (m) => `- [SC2] Second criterion shares command\n  - Changes: src/file.ts\n  - Check: \`${sharedCmd}\`\n  - Check: \`${distinctCmd}\`\n  - Evidence: check\n${m}`);
    const f = await toolkitRepo(sharedPlan);
    try {
      const deduped = await f.run(['check', 'run', '--criteria', 'SC1,SC2']);
      assert.equal(deduped.exit, 0, JSON.stringify(deduped));
      assert.equal(deduped.output.ok, true);
      assert.equal(deduped.value.executed, 2);
      assert.equal(deduped.value.reused, 0);
      assert.equal(fs.readFileSync(path.join(f.integration, 'ignored'), 'utf8'), '12');

      const sc1Ev = JSON.parse(fs.readFileSync(path.join(f.session, deduped.value.checks[0].path), 'utf8'));
      const sc2Ev = JSON.parse(fs.readFileSync(path.join(f.session, deduped.value.checks[1].path), 'utf8'));
      assert.equal(sc1Ev.commands[0].mode, 'fresh');
      assert.equal(sc2Ev.commands[0].mode, 'dedup');
      assert.equal(sc2Ev.commands[0].execId, sc1Ev.commands[0].execId);
      assert.equal(sc2Ev.commands[0].cacheHex, sc1Ev.commands[0].cacheHex);
      assert.equal(sc2Ev.commands[1].mode, 'fresh');

      const fresh = await f.run(['check', 'run', '--criteria', 'SC1,SC2', '--fresh']);
      assert.equal(fresh.exit, 0, JSON.stringify(fresh));
      assert.equal(fresh.output.ok, true);
      assert.equal(fresh.value.executed, 3);
      assert.equal(fresh.value.reused, 0);
      assert.equal(fs.readFileSync(path.join(f.integration, 'ignored'), 'utf8'), '12112');

      const freshSc1 = JSON.parse(fs.readFileSync(path.join(f.session, fresh.value.checks[0].path), 'utf8'));
      const freshSc2 = JSON.parse(fs.readFileSync(path.join(f.session, fresh.value.checks[1].path), 'utf8'));
      assert.equal(freshSc1.commands[0].mode, 'fresh');
      assert.equal(freshSc2.commands[0].mode, 'fresh');
      assert.notEqual(freshSc1.commands[0].execId, freshSc2.commands[0].execId);
    } finally { f.cleanup(); }
  });

  test('reuses cached command evidence only with --reuse and preserves immutable provenance', async () => {
    const sharedCmd = `node -e "require('fs').appendFileSync('ignored','x')"`;
    const plan = planSource
      .replace('| SC1 |', '| SC1, SC2 |')
      .replace('`node -e "process.exit(0)"`', `\`${sharedCmd}\``)
      .replace('\n## Verification Plan', (m) => `- [SC2] Second shares\n  - Changes: src/file.ts\n  - Check: \`${sharedCmd}\`\n  - Evidence: check\n${m}`);
    const f = await toolkitRepo(plan);
    try {
      const first = await f.run(['check', 'run']);
      assert.equal(first.exit, 0, JSON.stringify(first));
      assert.equal(first.value.executed, 2);
      assert.equal(first.value.reused, 0);
      assert.equal(fs.readFileSync(path.join(f.integration, 'ignored'), 'utf8'), 'x');

      const sc1FirstPath = path.join(f.session, first.value.checks[0].path);
      const sc1First = JSON.parse(fs.readFileSync(sc1FirstPath, 'utf8'));
      const execId1 = sc1First.commands[0].execId;
      const cacheHex = sc1First.commands[0].cacheHex;
      assert.ok(typeof execId1 === 'string' && execId1.length > 0);
      assert.ok(typeof cacheHex === 'string' && cacheHex.length === 64);
      const exec1JsonPath = path.join(f.session, '.state/evidence/commands', `${execId1}.json`);
      const exec1LogPath = path.join(f.session, '.state/evidence/commands', `${execId1}.log`);
      const exec1Snapshot = fs.readFileSync(exec1JsonPath, 'utf8');
      assert.ok(fs.existsSync(exec1LogPath));

      const secondNoFlag = await f.run(['check', 'run']);
      assert.equal(secondNoFlag.exit, 0, JSON.stringify(secondNoFlag));
      assert.equal(secondNoFlag.value.executed, 2);
      assert.equal(secondNoFlag.value.reused, 0);
      assert.equal(fs.readFileSync(path.join(f.integration, 'ignored'), 'utf8'), 'xx');
      const sc1Second = JSON.parse(fs.readFileSync(path.join(f.session, secondNoFlag.value.checks[0].path), 'utf8'));
      const execId2 = sc1Second.commands[0].execId;
      assert.notEqual(execId2, execId1);
      assert.notEqual(sc1Second.runId, sc1First.runId);
      assert.equal(fs.readFileSync(exec1JsonPath, 'utf8'), exec1Snapshot);

      const thirdReuse = await f.run(['check', 'run', '--reuse']);
      assert.equal(thirdReuse.exit, 0, JSON.stringify(thirdReuse));
      assert.equal(thirdReuse.output.ok, true);
      assert.equal(thirdReuse.value.executed, 0);
      assert.equal(thirdReuse.value.reused, 2);
      assert.match(thirdReuse.output.summary, /; reused 2\b/);
      assert.equal(fs.readFileSync(path.join(f.integration, 'ignored'), 'utf8'), 'xx');
      for (const item of thirdReuse.value.checks) {
        assert.ok(fs.existsSync(item.logPath), item.logPath);
      }
      const sc1ReusedPath = path.join(f.session, thirdReuse.value.checks[0].path);
      const sc1ReusedSnapshot = fs.readFileSync(sc1ReusedPath, 'utf8');
      const sc1Reused = JSON.parse(sc1ReusedSnapshot);
      const sc2Dedup = JSON.parse(fs.readFileSync(path.join(f.session, thirdReuse.value.checks[1].path), 'utf8'));
      assert.equal(sc1Reused.commands[0].mode, 'reused');
      assert.equal(sc1Reused.commands[0].execId, execId2);
      assert.equal(sc1Reused.commands[0].cacheHex, cacheHex);
      assert.equal(sc2Dedup.commands[0].mode, 'dedup');
      assert.equal(sc2Dedup.commands[0].execId, execId2);
      assert.equal(sc2Dedup.commands[0].cacheHex, cacheHex);

      const evidenceRecords = foldLedger(f.session).records.filter((row) => row.kind === 'evidence');
      assert.equal(evidenceRecords.length, 9);
      for (const row of evidenceRecords) {
        assert.deepEqual(Object.keys(row.data).sort(), ['after', 'before', 'clean', 'commandDigest', 'criterion', 'exit', 'path', 'tree']);
      }
      const status = await f.run(['status', 'show']);
      assert.equal(status.exit, 0);
      assert.deepEqual(status.value.criteria, []);
      assert.ok(status.value.criterionStatuses.every((row: { state: string }) => row.state === 'verified'));

      // A later fresh execution updates index/<cacheHex>.json without mutating earlier reused provenance.
      const fourthFresh = await f.run(['check', 'run']);
      assert.equal(fourthFresh.exit, 0, JSON.stringify(fourthFresh));
      assert.equal(fourthFresh.value.executed, 2);
      assert.equal(fourthFresh.value.reused, 0);
      const sc1Fourth = JSON.parse(fs.readFileSync(path.join(f.session, fourthFresh.value.checks[0].path), 'utf8'));
      assert.notEqual(sc1Fourth.commands[0].execId, execId2);
      assert.equal(fs.readFileSync(sc1ReusedPath, 'utf8'), sc1ReusedSnapshot);
      assert.ok(fs.existsSync(path.join(f.session, '.state/evidence/commands', `${execId2}.json`)));
      assert.ok(fs.existsSync(path.join(f.session, '.state/evidence/commands', `${execId2}.log`)));
      const pointer = JSON.parse(fs.readFileSync(path.join(f.session, '.state/evidence/commands/index', `${cacheHex}.json`), 'utf8'));
      assert.equal(pointer.execId, sc1Fourth.commands[0].execId);
    } finally { f.cleanup(); }
  });

  test('enforces pass-fail-pass and fail-pass-fail latest-record ordering on the same tree', async () => {
    const toggleCmd = `node -e "process.exit(require('fs').readFileSync('ignored','utf8').trim()==='pass'?0:1)"`;
    const plan = planSource.replace('`node -e "process.exit(0)"`', `\`${toggleCmd}\``);
    const f = await toolkitRepo(plan);
    try {
      const sc1State = async () => {
        const status = await f.run(['status', 'show']);
        assert.equal(status.exit, 0);
        return status.value.criterionStatuses.find((row: { criterion: string }) => row.criterion === 'SC1').state;
      };
      const setMode = (dir: string, mode: 'pass' | 'fail') => fs.writeFileSync(path.join(dir, 'ignored'), mode);
      assert.equal((await f.run(['check', 'run', '--criteria', 'contract'])).exit, 0);

      // pass -> fail -> pass on the exact same clean Git tree
      setMode(f.integration, 'pass');
      const pass1 = await f.run(['check', 'run', '--criteria', 'SC1']);
      assert.equal(pass1.output.ok, true);
      assert.equal(await sc1State(), 'verified');
      const pass1Ev = JSON.parse(fs.readFileSync(path.join(f.session, pass1.value.checks[0].path), 'utf8'));
      const pass1ExecId = pass1Ev.commands[0].execId as string;
      const pass1CacheHex = pass1Ev.commands[0].cacheHex as string;
      const pass1ExecJson = path.join(f.session, '.state/evidence/commands', `${pass1ExecId}.json`);
      const pass1ExecLog = path.join(f.session, '.state/evidence/commands', `${pass1ExecId}.log`);
      const pass1Snapshot = fs.readFileSync(pass1ExecJson, 'utf8');

      setMode(f.integration, 'fail');
      const fail1 = await f.run(['check', 'run', '--criteria', 'SC1']);
      assert.equal(fail1.output.ok, false);
      assert.equal(fail1.output.reason, 'checks-failed');
      assert.equal(await sc1State(), 'missing');
      // Failing on the same clean tree invalidates index/<cacheHex>.json while keeping immutable <execId>.{json,log}.
      assert.equal(fs.existsSync(path.join(f.session, '.state/evidence/commands/index', `${pass1CacheHex}.json`)), false);
      assert.equal(fs.readFileSync(pass1ExecJson, 'utf8'), pass1Snapshot);
      assert.ok(fs.existsSync(pass1ExecLog));

      // Subsequent --reuse executes freshly and does NOT resurrect the older pass.
      const reuseAfterFail = await f.run(['check', 'run', '--criteria', 'SC1', '--reuse']);
      assert.equal(reuseAfterFail.output.ok, false);
      assert.equal(reuseAfterFail.output.reason, 'checks-failed');
      assert.equal(reuseAfterFail.value.executed, 1);
      assert.equal(reuseAfterFail.value.reused, 0);
      assert.equal(await sc1State(), 'missing');

      setMode(f.integration, 'pass');
      assert.equal((await f.run(['check', 'run', '--criteria', 'SC1'])).output.ok, true);
      assert.equal(await sc1State(), 'verified');

      // fail -> pass -> fail on a fresh session on the same clean Git tree
      const s2 = await f.second('20261023T0001Z-second');
      assert.equal((await s2.run(['check', 'run', '--criteria', 'contract'])).exit, 0);
      const s2State = async () => {
        const status = await s2.run(['status', 'show']);
        assert.equal(status.exit, 0);
        return status.value.criterionStatuses.find((row: { criterion: string }) => row.criterion === 'SC1').state;
      };
      setMode(s2.integration, 'fail');
      assert.equal((await s2.run(['check', 'run', '--criteria', 'SC1'])).output.ok, false);
      assert.equal(await s2State(), 'missing');

      setMode(s2.integration, 'pass');
      assert.equal((await s2.run(['check', 'run', '--criteria', 'SC1'])).output.ok, true);
      assert.equal(await s2State(), 'verified');

      setMode(s2.integration, 'fail');
      assert.equal((await s2.run(['check', 'run', '--criteria', 'SC1'])).output.ok, false);
      assert.equal(await s2State(), 'missing');
    } finally { f.cleanup(); }
  });

  test('falls back to fresh execution on misdirected index, torn JSON, malformed cache fields, or stale log', async () => {
    const cmd = `node -e "require('fs').appendFileSync('ignored','r')"`;
    const plan = planSource.replace('`node -e "process.exit(0)"`', `\`${cmd}\``);
    const f = await toolkitRepo(plan);
    try {
      const seed = async () => {
        const r = await f.run(['check', 'run', '--criteria', 'SC1']);
        assert.equal(r.exit, 0);
        const ev = JSON.parse(fs.readFileSync(path.join(f.session, r.value.checks[0].path), 'utf8'));
        return {
          execId: ev.commands[0].execId as string,
          cacheHex: ev.commands[0].cacheHex as string,
        };
      };
      const verifyFallback = async (label: string) => {
        const before = fs.readFileSync(path.join(f.integration, 'ignored'), 'utf8');
        const r = await f.run(['check', 'run', '--criteria', 'SC1', '--reuse']);
        assert.equal(r.exit, 0, label);
        assert.equal(r.output.ok, true, label);
        assert.equal(r.value.executed, 1, label);
        assert.equal(r.value.reused, 0, label);
        assert.equal(fs.readFileSync(path.join(f.integration, 'ignored'), 'utf8'), before + 'r', label);
      };

      // 1. Misdirected index -> non-existent UUID
      let seeded = await seed();
      const indexFile = path.join(f.session, '.state/evidence/commands/index', `${seeded.cacheHex}.json`);
      fs.writeFileSync(indexFile, JSON.stringify({ execId: crypto.randomUUID() }));
      await verifyFallback('misdirected missing UUID');

      // 2. Invalid UUID shape (path traversal attempt)
      seeded = await seed();
      fs.writeFileSync(indexFile, JSON.stringify({ execId: '../escape' }));
      await verifyFallback('invalid UUID shape');

      // 3. Torn JSON in index and in exec record
      seeded = await seed();
      fs.writeFileSync(indexFile, '{torn');
      await verifyFallback('torn index JSON');

      seeded = await seed();
      const execFile = path.join(f.session, '.state/evidence/commands', `${seeded.execId}.json`);
      fs.writeFileSync(execFile, '{torn');
      await verifyFallback('torn exec JSON');

      // 4. Malformed cache fields (wrong type / tampered logPath / mismatched command)
      seeded = await seed();
      const execPath4 = path.join(f.session, '.state/evidence/commands', `${seeded.execId}.json`);
      const validExec = JSON.parse(fs.readFileSync(execPath4, 'utf8'));
      fs.writeFileSync(execPath4, JSON.stringify({ ...validExec, exit: '0' }));
      await verifyFallback('wrong exit type');

      seeded = await seed();
      const execPath5 = path.join(f.session, '.state/evidence/commands', `${seeded.execId}.json`);
      const validExec5 = JSON.parse(fs.readFileSync(execPath5, 'utf8'));
      fs.writeFileSync(execPath5, JSON.stringify({ ...validExec5, logPath: '.state/evidence/commands/other.log' }));
      await verifyFallback('tampered logPath');

      seeded = await seed();
      const execPath6 = path.join(f.session, '.state/evidence/commands', `${seeded.execId}.json`);
      const validExec6 = JSON.parse(fs.readFileSync(execPath6, 'utf8'));
      fs.writeFileSync(execPath6, JSON.stringify({ ...validExec6, command: 'node -e "process.exit(0)"' }));
      await verifyFallback('mismatched command');

      // 5. Stale / modified log file (logSha256 mismatch) and missing log
      seeded = await seed();
      fs.writeFileSync(path.join(f.session, '.state/evidence/commands', `${seeded.execId}.log`), 'tampered log');
      await verifyFallback('stale log hash');

      seeded = await seed();
      fs.rmSync(path.join(f.session, '.state/evidence/commands', `${seeded.execId}.log`));
      await verifyFallback('missing log file');
    } finally { f.cleanup(); }
  });

  test('never caches or reuses dirty, mutating, restore-pair, or non-zero commands', async () => {
    const indexFiles = (session: string) => {
      const dir = path.join(session, '.state/evidence/commands/index');
      return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    };

    // Dirty checkout
    const fDirty = await toolkitRepo();
    try {
      await fDirty.run(['check', 'run', '--criteria', 'contract']);
      fs.writeFileSync(path.join(fDirty.integration, 'dirty.txt'), 'dirty');
      const r = await fDirty.run(['check', 'run', '--criteria', 'SC1']);
      assert.equal(r.output.ok, false);
      assert.equal(r.output.reason, 'dirty');
      const ev = JSON.parse(fs.readFileSync(path.join(fDirty.session, r.value.checks[0].path), 'utf8'));
      assert.equal(ev.commands[0].execId, null);
      assert.equal(ev.commands[0].cacheHex, null);
      assert.match(ev.commands[0].logPath, /^\.state\/evidence\/runs\//);
      fs.rmSync(path.join(fDirty.integration, 'dirty.txt'));
      const retry = await fDirty.run(['check', 'run', '--criteria', 'SC1', '--reuse']);
      assert.equal(retry.value.executed, 1);
      assert.equal(retry.value.reused, 0);
    } finally { fDirty.cleanup(); }

    // Mutating command
    const mutatingPlan = planSource.replace('`node -e "process.exit(0)"`', '`node -e "require(\'fs\').writeFileSync(\'src/file.ts\',\'mutated\')"`');
    const fMut = await toolkitRepo(mutatingPlan);
    try {
      const r = await fMut.run(['check', 'run', '--criteria', 'SC1']);
      assert.equal(r.output.reason, 'mutated');
      assert.deepEqual(indexFiles(fMut.session), []);
      const ev = JSON.parse(fs.readFileSync(path.join(fMut.session, r.value.checks[0].path), 'utf8'));
      assert.equal(ev.commands[0].execId, null);
      assert.equal(ev.commands[0].cacheHex, null);
    } finally { fMut.cleanup(); }

    // Restore-pair (cmd1 mutates src/file.ts, cmd2 restores it)
    const restorePlan = planSource.replace(
      '  - Check: `node -e "process.exit(0)"`',
      [
        '  - Check: `node -e "require(\'fs\').writeFileSync(\'src/file.ts\',\'mutated\')"`',
        '  - Check: `node -e "require(\'fs\').writeFileSync(\'src/file.ts\',\'initial\\n\')"`',
      ].join('\n'),
    );
    const fRestore = await toolkitRepo(restorePlan);
    try {
      const first = await fRestore.run(['check', 'run', '--criteria', 'SC1']);
      assert.equal(first.exit, 0, JSON.stringify(first));
      assert.equal(first.value.executed, 2);
      assert.deepEqual(indexFiles(fRestore.session), []);
      const ev = JSON.parse(fs.readFileSync(path.join(fRestore.session, first.value.checks[0].path), 'utf8'));
      assert.equal(ev.commands[0].execId, null);
      assert.equal(ev.commands[1].execId, null);
      const second = await fRestore.run(['check', 'run', '--criteria', 'SC1', '--reuse']);
      assert.equal(second.value.executed, 2);
      assert.equal(second.value.reused, 0);
    } finally { fRestore.cleanup(); }

    // Non-zero command
    const failPlan = planSource.replace('`node -e "process.exit(0)"`', '`node -e "process.exit(7)"`');
    const fFail = await toolkitRepo(failPlan);
    try {
      const first = await fFail.run(['check', 'run', '--criteria', 'SC1']);
      assert.equal(first.output.reason, 'checks-failed');
      assert.deepEqual(indexFiles(fFail.session), []);
      const ev = JSON.parse(fs.readFileSync(path.join(fFail.session, first.value.checks[0].path), 'utf8'));
      assert.equal(ev.commands[0].execId, null);
      assert.equal(ev.commands[0].cacheHex, null);
      assert.match(ev.commands[0].logPath, /^\.state\/evidence\/runs\//);
      const second = await fFail.run(['check', 'run', '--criteria', 'SC1', '--reuse']);
      assert.equal(second.value.executed, 1);
      assert.equal(second.value.reused, 0);
    } finally { fFail.cleanup(); }
  });
});
