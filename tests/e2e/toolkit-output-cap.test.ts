import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {describe,test} from 'node:test';
import {toolkitRepo,planSource} from './helpers/toolkit-repo.ts';

describe('summary byte cap',()=>{
  test('preserves all conflict paths exceeding the summary cap in the result file',async()=>{
    const paths=Array.from({length:60},(_,i)=>'src/conflict-'+String(i).padStart(3,'0')+'.ts');
    const source=planSource.replace('#### [MODIFY] src/file.ts\n- Purpose: implements behavior.',paths.map(p=>'#### [MODIFY] '+p+'\n- Purpose: conflict.').join('\n')).replace('  - Changes: src/file.ts','  - Changes: '+paths.join(', '));
    const f=await toolkitRepo(source,Object.fromEntries(paths.map(p=>[p,'base\n']))); try {
      await f.level(); const created=await f.run(['worktree','create','T1']); assert.equal(created.exit,0,JSON.stringify(created));
      for(const p of paths) {fs.writeFileSync(path.resolve(f.session,created.value.path,p),'writer\n'); fs.writeFileSync(path.join(f.integration,p),'integration\n');}
      assert.equal((await f.run(['worktree','submit','T1'])).exit,0); assert.equal((await f.run(['worktree','commit','--reason','conflict'])).exit,0);
      const result=await f.concurrent(['worktree','integrate','T1']); assert.equal(result.exit,0); assert.equal(result.output.reason,'conflict'); assert.deepEqual([...result.value.paths].sort(),paths.sort());
    } finally {f.cleanup();}
  });
  test('keeps concurrent append results distinct and complete',async()=>{
    const f=await toolkitRepo(); try {
      const files=['first','second'].map(text=>{const file=path.join(f.session,text+'.json'); fs.writeFileSync(file,JSON.stringify({kind:'note',by:'tool',key:text,data:{text}})); return file;});
      const results=await Promise.all(files.map(file=>f.concurrent(['ledger','append',file])));
      assert.deepEqual(results.map(r=>r.exit),[0,0]); assert.notEqual(results[0]!.output.path,results[1]!.output.path);
      const rows=fs.readFileSync(path.join(f.session,'ledger.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
      assert.deepEqual(results.map(r=>rows.find(row=>row.seq===r.value.seq).data.text),['first','second']);
    } finally {f.cleanup();}
  });
  test('preserves all large verify checks and their command output',async()=>{
    const criteria=Array.from({length:5},(_,i)=>'- [SC'+(i+1)+'] Works\n  - Changes: src/file.ts\n  - Verify: `node -e "process.stdout.write(\'x\'.repeat(200000))"`\n  - Evidence: verify').join('\n');
    const source=planSource.replace('| none | SC1 |','| none | '+Array.from({length:5},(_,i)=>'SC'+(i+1)).join(', ')+' |').replace(/## Success Criteria[\s\S]*?## Verification Plan/,'## Success Criteria\n'+criteria+'\n\n## Verification Plan');
    const f=await toolkitRepo(source); try {
      const r=await f.concurrent(['verify','run']); assert.equal(r.exit,0,JSON.stringify(r)); assert.equal(r.output.ok,true,JSON.stringify(r));
      assert.equal(r.value.checks.length,6);
      for(const check of r.value.checks.filter((c:any)=>c.criterion!=='contract')) assert.ok(fs.statSync(check.logPath).size>=200000);
    } finally {f.cleanup();}
  });
});
