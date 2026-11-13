import fs from 'node:fs';
import path from 'node:path';
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
      await f.run(['check','run']); assert.equal(rows().length,5);
      fs.writeFileSync(path.join(f.integration,'ignored'),'ignored');
      await f.run(['check','run','--criteria','SC1']); assert.equal(rows().length,5);
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
  test('recovers an evidence file written before a crash without duplicate records', async () => {
    const f=await toolkitRepo(); try {
      const crash=await f.run(['check','run','--criteria','SC1'],point=>{if(point==='check:after-evidence') throw new Error('crash');});
      assert.equal(crash.exit,2,JSON.stringify(crash)); assert.equal(crash.value.message,'crash',JSON.stringify(crash));
      assert.equal(foldLedger(f.session).records.filter(r=>r.kind==='evidence').length,0,JSON.stringify(crash));
      assert.ok(fs.readdirSync(path.join(f.session,'.state/evidence')).some(p=>p.endsWith('.json')),JSON.stringify(crash));
      const recovered=await f.run(['check','run','--criteria','SC1']); const repeated=await f.run(['check','run','--criteria','SC1']);
      assert.equal(recovered.exit,0,JSON.stringify(recovered)); assert.equal(repeated.exit,0,JSON.stringify(repeated));
      assert.equal(foldLedger(f.session).records.filter(r=>r.kind==='evidence').length,1,JSON.stringify({recovered,repeated}));
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
});
