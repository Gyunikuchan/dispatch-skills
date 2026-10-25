import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { toolkitRepo, planSource } from './helpers/toolkit-repo.ts';
import { foldLedger } from '../../skills/dispatch/scripts/toolkit/ledger.ts';
describe('toolkit verify', () => {
  test('records selected tree bound evidence and adopts the integration worktree on rerun', async () => {
    const f=await toolkitRepo(); try {
      let r=await f.run(['verify','run']); assert.equal(r.exit,0); assert.equal(r.output.ok,true);
      const rows=()=>foldLedger(f.session).records;
      assert.equal(rows().filter(r=>r.kind==='evidence').length,2);
      assert.equal(rows().filter(r=>r.data['phase']==='opened').length,1);
      assert.equal(f.git(['branch','--show-current'],f.integration),'dispatch/test/integration');
      const first=rows().find(r=>r.kind==='evidence')!.data;
      assert.equal(first['tree'],f.git(['rev-parse','HEAD^{tree}'],f.integration)); assert.equal(first['clean'],true); assert.equal(first['exit'],0); assert.match(first['commandDigest'],/^sha256:/);
      await f.run(['verify','run']); assert.equal(rows().length,4);
      fs.writeFileSync(path.join(f.integration,'ignored'),'ignored');
      await f.run(['verify','run','--criteria','SC1']); assert.equal(rows().length,4);
      fs.writeFileSync(path.join(f.integration,'new.txt'),'new');
      r=await f.run(['verify','run','--criteria','SC1']); assert.equal(r.output.reason,'dirty');
      assert.equal(rows().at(-1)!.data['clean'],false); assert.notEqual(rows().at(-1)!.data['tree'],first['tree']);
      assert.equal((await f.run(['verify','run','--criteria','SC99'])).output.reason,'invalid-input');
    } finally {f.cleanup();}
  });
  test('records mutation and stops a criterion at its first failing command', async () => {
    for (const [command,reason,exit] of [[`node -e "require('fs').writeFileSync('src/file.ts','changed')"`,'mutated',0],[`node -e "process.exit(7)"`,'checks-failed',7]] as const) {
      const source=planSource.replace('node -e "process.exit(0)"',command);
      const f=await toolkitRepo(reason==='checks-failed' ? source.replace('  - Evidence: verify', '  - Verify: `node -e "require(\'fs\').writeFileSync(\'src/should-not-run\',\'bad\')"`\n  - Evidence: verify') : source); try {
        const r=await f.run(['verify','run','--criteria','SC1']); assert.equal(r.exit,0); assert.equal(r.output.ok,false); assert.equal(r.output.reason,reason);
        const evidence=foldLedger(f.session).records.filter(r=>r.kind==='evidence'); assert.equal(evidence.length,1); assert.equal(evidence[0]!.data['exit'],exit);
        if(reason==='mutated') assert.notEqual(evidence[0]!.data['before'],evidence[0]!.data['after']);
        if(reason==='checks-failed') assert.equal(fs.existsSync(path.join(f.integration,'src/should-not-run')),false);
      } finally {f.cleanup();}
    }
  });
  test('recovers an evidence file written before a crash without duplicate records', async () => {
    const f=await toolkitRepo(); try {
      const crash=await f.run(['verify','run','--criteria','SC1'],point=>{if(point==='verify:after-evidence') throw new Error('crash');});
      assert.equal(crash.exit,2,JSON.stringify(crash)); assert.equal(crash.value.message,'crash',JSON.stringify(crash));
      assert.equal(foldLedger(f.session).records.filter(r=>r.kind==='evidence').length,0,JSON.stringify(crash));
      assert.ok(fs.readdirSync(path.join(f.session,'.state/evidence')).some(p=>p.endsWith('.json')),JSON.stringify(crash));
      const recovered=await f.run(['verify','run','--criteria','SC1']); const repeated=await f.run(['verify','run','--criteria','SC1']);
      assert.equal(recovered.exit,0,JSON.stringify(recovered)); assert.equal(repeated.exit,0,JSON.stringify(repeated));
      assert.equal(foldLedger(f.session).records.filter(r=>r.kind==='evidence').length,1,JSON.stringify({recovered,repeated}));
    } finally {f.cleanup();}
  });
  test('refuses a detached caller without creating an integration worktree', async () => {
    const f=await toolkitRepo(); try { f.git(['checkout','--detach']); const r=await f.run(['verify','run']); assert.equal(r.exit,4); assert.equal(r.output.reason,'caller-detached'); assert.equal(fs.existsSync(f.integration),false); } finally {f.cleanup();}
  });
});

test('final verification refuses invalid pruning', async()=>{const f=await toolkitRepo(planSource.replace('  - Evidence: verify','  - Retain: transient\n  - Covered by: FINAL\n  - Evidence: verify'));try {assert.equal((await f.run(['verify','run','--final'])).output.reason,'pruning-required');}finally{f.cleanup();}});


test('transient verification refuses artifact mutation during a successful command',async()=>{
 const source=planSource.replace('  - Evidence: verify','  - Retain: transient\n  - Covered by: FINAL\n  - Evidence: verify');
 const f=await toolkitRepo(source);try{
  const original=f.deps.run;let changed=false;
  f.deps.run=async(argv,options)=>{
   const result=await original(argv,options);
   if(!changed && argv[0]!=='git'){changed=true;fs.appendFileSync(path.join(f.root,'work.spec.md'),'\nChanged during command.\n');}
   return result;
  };
  const result=await f.run(['verify','run']);assert.equal(changed,true);assert.equal(result.output.reason,'artifacts-changed');
  assert.equal(foldLedger(f.session).records.filter(row=>row.kind==='evidence' && row.data['exit']===0).length,0);
 }finally{f.cleanup();}
});
