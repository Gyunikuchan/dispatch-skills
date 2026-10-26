import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toolkitRepo } from './helpers/toolkit-repo.ts';
import { foldLedger } from '../../skills/dispatch/scripts/toolkit/ledger.ts';
type Repo=Awaited<ReturnType<typeof toolkitRepo>>;
const rows=(r: Repo,phase: string)=>foldLedger(r.session).records.filter(x=>x.kind==='integrate' && x.data['phase']===phase);
async function prepared() {
  const r=await toolkitRepo(); await r.level(); const made=await r.run(['worktree','create','T1']);
  const writer=path.join(r.session,made.value.path); fs.writeFileSync(path.join(writer,'src/file.ts'),'delivered\n');
  assert.equal((await r.run(['worktree','submit','T1'])).exit,0); assert.equal((await r.run(['worktree','integrate','T1'])).exit,0); return {r,writer};
}
describe('toolkit delivery and cleanup',()=>{
  it('delivers twice using the last delivery as the next base and cleans owned terminal worktrees',async()=>{
    const {r,writer}=await prepared(); try {
      const unowned=path.join(r.session,'.state/worktrees/unowned'), outside=path.join(r.root,'outside'); r.git(['worktree','add','--detach',unowned,'HEAD']); r.git(['worktree','add','--detach',outside,'HEAD']);
      assert.equal((await r.run(['worktree','deliver'])).exit,0); const first=r.git(['rev-parse','HEAD']); assert.equal(fs.readFileSync(path.join(r.root,'src/file.ts'),'utf8'),'delivered\n');
      fs.writeFileSync(path.join(r.integration,'src/file.ts'),'second\n'); await r.run(['worktree','commit','--reason','second']); await r.run(['worktree','deliver']);
      assert.equal(rows(r,'deliver-started')[1]!.data['from'],first); assert.equal(rows(r,'delivered').length,2);
      const cleaned=await r.run(['worktree','cleanup']); assert.equal(cleaned.exit,0); assert.ok(!fs.existsSync(writer)); assert.ok(!fs.existsSync(r.integration)); assert.ok(fs.existsSync(unowned)); assert.ok(fs.existsSync(outside));
      assert.equal(r.git(['branch','--list','dispatch/test/integration']),''); assert.equal(r.git(['for-each-ref','--format=%(refname)','refs/dispatch/test/candidates']),'');
    }finally{r.cleanup();}
  });
  it('records a no-op delivery once when the integration has no new commits',async()=>{
    const r=await toolkitRepo(); try {
      await r.level(); assert.equal((await r.run(['verify','run'])).exit,0);
      const caller=r.git(['rev-parse','HEAD']), integration=r.git(['rev-parse','HEAD'],r.integration);
      const callerFile=path.join(r.root,'work.spec.md'), callerBytes=Buffer.from('# Caller work\nUnrelated no-op delivery edit.\n');
      fs.writeFileSync(callerFile,callerBytes);
      assert.equal(integration,caller);
      const first=await r.run(['worktree','deliver']);
      assert.equal(first.exit,0); assert.equal(first.value.from,integration); assert.equal(first.value.to,integration);
      assert.equal(first.value.delivered,true); assert.equal(first.value.noop,true);
      assert.equal(rows(r,'delivered').length,1); assert.equal(rows(r,'delivered')[0]!.data['to'],integration);
      assert.equal(rows(r,'deliver-started').length,0); assert.equal(r.git(['rev-parse','HEAD']),caller);
      assert.deepEqual(fs.readFileSync(callerFile),callerBytes);
      const second=await r.run(['worktree','deliver']);
      assert.equal(second.exit,0); assert.equal(second.value.delivered,false); assert.equal(rows(r,'delivered').length,1);
      const cleaned=await r.run(['worktree','cleanup']);
      assert.equal(cleaned.exit,0); assert.ok(!fs.existsSync(r.integration));
      assert.equal(r.git(['branch','--list','dispatch/test/integration']),'');
    }finally{r.cleanup();}
  });
  it('refuses no-op delivery with a dirty integration',async()=>{
    const r=await toolkitRepo(); try {
      await r.level(); assert.equal((await r.run(['verify','run'])).exit,0);
      const file=path.join(r.integration,'src/file.ts'), bytes=Buffer.from('uncommitted integration edit\n');
      fs.writeFileSync(file,bytes);
      const refused=await r.run(['worktree','deliver']);
      assert.equal(refused.exit,4); assert.equal(refused.output.reason,'integration-dirty');
      assert.equal(rows(r,'delivered').length,0); assert.equal(rows(r,'deliver-started').length,0);
      assert.deepEqual(fs.readFileSync(file),bytes);
    }finally{r.cleanup();}
  });
  it('refuses a no-op delivery when the caller moved',async()=>{
    const r=await toolkitRepo(); try {
      await r.level(); assert.equal((await r.run(['verify','run'])).exit,0);
      const integration=r.git(['rev-parse','HEAD'],r.integration);
      r.git(['commit','--allow-empty','-m','outside']);
      const caller=r.git(['rev-parse','HEAD']);
      const refused=await r.run(['worktree','deliver']);
      assert.equal(refused.exit,4); assert.equal(refused.output.reason,'caller-moved');
      assert.equal(rows(r,'delivered').length,0); assert.equal(rows(r,'deliver-started').length,0);
      assert.equal(r.git(['rev-parse','HEAD']),caller); assert.equal(r.git(['rev-parse','HEAD'],r.integration),integration);
    }finally{r.cleanup();}
  });
  it('reconciles a delivery crash exactly once without a second merge',async()=>{
    const {r}=await prepared(); try {
      assert.equal((await r.run(['worktree','deliver'],point=>{if(point==='deliver:after-ff') throw new Error('crash');})).exit,2);
      const head=r.git(['rev-parse','HEAD']); assert.equal(rows(r,'delivered').length,0);
      assert.equal((await r.run(['worktree','deliver'])).exit,0); assert.equal(rows(r,'delivered').length,1); assert.equal(r.git(['rev-parse','HEAD']),head);
      await r.run(['worktree','deliver']); assert.equal(rows(r,'delivered').length,1);
    }finally{r.cleanup();}
  });
  it('preserves unrelated tracked caller edits through fast-forward and crash recovery',async()=>{
    const {r}=await prepared(); try {
      const file=path.join(r.root,'work.spec.md');
      const bytes=Buffer.from('# Caller work\nUnrelated tracked edit.\n'); fs.writeFileSync(file,bytes);
      assert.equal((await r.run(['worktree','deliver'],point=>{if(point==='deliver:after-ff')throw new Error('crash');})).exit,2);
      const head=r.git(['rev-parse','HEAD']);
      assert.equal(head,r.git(['rev-parse','HEAD'],r.integration));
      assert.equal(fs.readFileSync(path.join(r.root,'src/file.ts'),'utf8'),'delivered\n');
      assert.deepEqual(fs.readFileSync(file),bytes); assert.equal(rows(r,'delivered').length,0);
      const recovered=await r.run(['worktree','deliver']); assert.equal(recovered.exit,0,JSON.stringify(recovered.output));
      assert.equal(recovered.value.delivered,true); assert.equal(r.git(['rev-parse','HEAD']),head);
      assert.deepEqual(fs.readFileSync(file),bytes); assert.equal(rows(r,'deliver-started').length,1); assert.equal(rows(r,'delivered').length,1);
      assert.equal(r.git(['diff','--name-only']),'work.spec.md');
    }finally{r.cleanup();}
  });
  it('preserves caller bytes on refused tracked delivery', async () => {
    for (const mode of ['tracked', 'after', 'crash-edit', 'moved']) {
      const { r } = await prepared(); try {
        const file = path.join(r.root, 'src/file.ts');
        if (mode === 'tracked') fs.writeFileSync(file, 'caller\n');
        if (mode === 'moved') r.git(['commit', '--allow-empty', '-m', 'outside']);
        if (mode === 'crash-edit') { await r.run(['worktree', 'deliver'], p => { if (p === 'deliver:after-ff') throw new Error('crash'); }); fs.writeFileSync(file, 'caller\n'); }
        const before = fs.readFileSync(file, 'utf8');
        const delivered = await r.run(['worktree', 'deliver'], p => { if (mode === 'after' && p === 'deliver:after-ff') fs.writeFileSync(file, 'caller\n'); });
        assert.equal(delivered.exit, 4); assert.equal(delivered.output.reason, mode === 'moved' ? 'caller-moved' : 'caller-dirty');
        assert.equal(fs.readFileSync(file, 'utf8'), mode === 'after' ? 'caller\n' : before); assert.equal(rows(r, 'delivered').length, 0);
        if (['tracked', 'moved'].includes(mode)) assert.equal(rows(r, 'deliver-started').length, 0);
      } finally { r.cleanup(); }
    }
  });
  it('keeps open writers and undelivered integration work until close',async()=>{
    const r=await toolkitRepo(); try {
      const made=await r.run(['worktree','create','T1']); const writer=path.join(r.session,made.value.path);
      await r.run(['worktree','cleanup']); assert.ok(fs.existsSync(writer)); assert.ok(fs.existsSync(r.integration));
      fs.writeFileSync(path.join(r.integration,'src/file.ts'),'fix\n'); await r.run(['worktree','commit','--reason','fix']); await r.run(['worktree','cleanup']); assert.ok(fs.existsSync(r.integration));
      await r.run(['worktree','close','--reason','stop']); await r.run(['worktree','cleanup']); assert.ok(!fs.existsSync(r.integration)); assert.ok(r.git(['branch','--list','dispatch/test/integration']));
    }finally{r.cleanup();}
  });
  it('keeps unpreserved submitted-edit bytes', async () => {
    for (const mode of ['submitted-edit', 'ignored-closed', 'dirty-delivered']) {
      const { r, writer } = await prepared(); try {
        let file: string;
        if (mode === 'submitted-edit') { file = path.join(writer, 'src/file.ts'); fs.writeFileSync(file, 'kept\n'); }
        else { await r.run(['worktree', 'deliver']); if (mode === 'ignored-closed') await r.run(['worktree', 'close', '--reason', 'stop']); file = path.join(r.integration, mode === 'dirty-delivered' ? 'src/file.ts' : 'ignored'); fs.writeFileSync(file, 'kept\n'); }
        const cleaned = await r.run(['worktree', 'cleanup']); assert.equal(cleaned.exit, 0); assert.equal(fs.readFileSync(file, 'utf8'), 'kept\n'); assert.ok(JSON.stringify(cleaned.value).includes('unpreserved'));
        if (mode === 'dirty-delivered') assert.ok(r.git(['branch', '--list', 'dispatch/test/integration']));
      } finally { r.cleanup(); }
    }
  });
  it('removes abandoned launches and rejected candidates after close',async()=>{
    const r=await toolkitRepo(); try {
      await r.level(); const first=await r.run(['worktree','create','T1']); fs.writeFileSync(path.join(r.session,first.value.path,'src/file.ts'),'abandoned\n'); await r.run(['worktree','abandon','T1','--reason','discard']);
      const second=await r.run(['worktree','create','T1']); fs.writeFileSync(path.join(r.session,second.value.path,'src/file.ts'),'rejected\n'); await r.run(['worktree','submit','T1']); await r.run(['worktree','abort','T1','--reason','reject']);
      await r.run(['worktree','close','--reason','stop']); const clean=await r.run(['worktree','cleanup']); assert.equal(clean.exit,0); assert.ok(!fs.existsSync(path.join(r.session,first.value.path))); assert.ok(!fs.existsSync(path.join(r.session,second.value.path))); assert.ok(!fs.existsSync(r.integration));
    }finally{r.cleanup();}
  });
});
