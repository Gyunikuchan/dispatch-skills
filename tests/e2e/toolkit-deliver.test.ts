import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {describe,it} from 'node:test';
import {toolkitRepo} from './helpers/toolkit-repo.ts';import {foldLedger,appendRecord} from '../../skills/dispatch/scripts/toolkit/ledger.ts';
type Repo=Awaited<ReturnType<typeof toolkitRepo>>;
const rows=(r:Repo,phase:string)=>foldLedger(r.session).records.filter(x=>x.kind==='integrate'&&x.data['phase']===phase);
const ref='refs/dispatch/test/delivery-prepared';
async function prepared(){const r=await toolkitRepo();await r.level();const made=await r.run(['worktree','create','T1']);const writer=path.join(r.session,made.value.path);fs.writeFileSync(path.join(writer,'src/file.ts'),'delivered\n');assert.equal((await r.run(['worktree','submit','T1'])).exit,0);assert.equal((await r.run(['worktree','integrate','T1'])).exit,0);return {r,writer};}
const caller=(r:Repo)=>({head:r.git(['rev-parse','HEAD']),index:r.git(['ls-files','--stage','-z']),flags:r.git(['ls-files','-v','-z']),bytes:fs.readFileSync(path.join(r.root,'src/file.ts'))});
describe('toolkit delivery and cleanup',()=>{
 it('squash commit delivers one exact final tree and cleanup preserves unrelated history',async()=>{const {r,writer}=await prepared();try{
 const base=r.git(['rev-parse','HEAD']);fs.writeFileSync(path.join(r.integration,'src/file.ts'),'final\n');assert.equal((await r.run(['worktree','commit','--reason','internal fix'])).exit,0);const source=r.git(['rev-parse','HEAD'],r.integration);
 const unowned=path.join(r.root,'outside');r.git(['worktree','add','--detach',unowned,'HEAD']);fs.writeFileSync(path.join(r.root,'scratch'),'scratch');fs.writeFileSync(path.join(r.root,'ignored'),'ignored');
 const first=await r.run(['worktree','deliver']);assert.equal(first.exit,0,JSON.stringify(first));const to=r.git(['rev-parse','HEAD']);assert.notEqual(to,source);assert.equal(first.value.source,source);assert.equal(first.value.to,to);assert.equal(first.value.from,base);assert.equal(r.git(['rev-list','--count',base+'..HEAD']),'1');assert.equal(r.git(['show','-s','--format=%P',to]),base);assert.equal(r.git(['rev-parse',to+'^{tree}']),r.git(['rev-parse',source+'^{tree}']));assert.match(r.git(['show','-s','--format=%B',to]),new RegExp('Dispatch-Source: '+source));assert.equal(r.git(['rev-parse','HEAD'],r.integration),source);
 r.git(['commit','--allow-empty','-m','later caller']);const later=r.git(['rev-parse','HEAD']);fs.writeFileSync(path.join(r.root,'src/file.ts'),'later edit');const again=await r.run(['worktree','deliver']);assert.equal(again.exit,0);assert.equal(again.value.delivered,false);assert.equal(r.git(['rev-parse','HEAD']),later);
 const beforeCleanup=caller(r),run=r.deps.run;let interrupted=0;
 r.deps.run=async(argv,opts)=>{const result=await run(argv,opts);if(argv[1]==='branch'&&argv[2]==='-D'&&result.exit===0){interrupted++;throw Error('interrupted after branch deletion');}return result;};
 const failedCleanup=await r.run(['worktree','cleanup']);r.deps.run=run;assert.equal(interrupted,1,JSON.stringify(failedCleanup));assert.equal(failedCleanup.exit,2);assert.ok(!fs.existsSync(writer));assert.ok(!fs.existsSync(r.integration));assert.equal(r.git(['branch','--list','dispatch/test/integration']),'');assert.ok(r.git(['for-each-ref','--format=%(refname)',ref]));assert.deepEqual(caller(r),beforeCleanup);
 const cleaned=await r.run(['worktree','cleanup']);assert.equal(cleaned.exit,0);assert.deepEqual(caller(r),beforeCleanup);assert.ok(!fs.existsSync(writer));assert.ok(!fs.existsSync(r.integration));assert.ok(fs.existsSync(unowned));assert.equal(r.git(['branch','--list','dispatch/test/integration']),'');assert.equal(r.git(['for-each-ref','--format=%(refname)',ref]),'');assert.equal(fs.readFileSync(path.join(r.root,'scratch'),'utf8'),'scratch');assert.equal(fs.readFileSync(path.join(r.root,'ignored'),'utf8'),'ignored');
 }finally{r.cleanup();}});
 it('squash commit records same-tree internal history without an empty caller commit',async()=>{const r=await toolkitRepo();try{await r.level();await r.run(['verify','run']);const base=r.git(['rev-parse','HEAD']);r.git(['commit','--allow-empty','-m','internal empty'],r.integration);const source=r.git(['rev-parse','HEAD'],r.integration);const first=await r.run(['worktree','deliver']);assert.equal(first.exit,0);assert.equal(first.value.noop,true);assert.equal(first.value.source,source);assert.equal(first.value.to,base);assert.equal(r.git(['rev-parse','HEAD']),base);assert.equal(r.git(['for-each-ref','--format=%(refname)',ref]),'');assert.equal((await r.run(['worktree','deliver'])).value.delivered,false);assert.equal(rows(r,'delivered').length,1);}finally{r.cleanup();}});
 it('squash safety refuses caller edits and overlapping scratch before and after the advancement hook',async()=>{
 for(const mode of ['unstaged','staged-restored','untracked','ignored','ancestor','moved','late-edit','late-index','noop-dirty']){const r=mode==='noop-dirty'?await toolkitRepo():(await prepared()).r;try{if(mode==='noop-dirty'){await r.level();await r.run(['verify','run']);}
 const tracked=path.join(r.root,'work.spec.md');if(['unstaged','noop-dirty'].includes(mode))fs.writeFileSync(tracked,'caller');if(mode==='staged-restored'){fs.writeFileSync(tracked,'staged');r.git(['add','work.spec.md']);fs.writeFileSync(tracked,r.git(['show','HEAD:work.spec.md'])+'\n');}
 if(['untracked','ignored','ancestor'].includes(mode)){fs.writeFileSync(path.join(r.integration,'new-file'),'new');await r.run(['worktree','commit','--reason','add']);if(mode==='ignored')fs.appendFileSync(path.join(r.root,'.git/info/exclude'),'\nnew-file\n');if(mode==='ancestor'){fs.mkdirSync(path.join(r.root,'new-file'));fs.writeFileSync(path.join(r.root,'new-file/child'),'caller');}else fs.writeFileSync(path.join(r.root,'new-file'),'caller');}
 if(mode==='moved')r.git(['commit','--allow-empty','-m','moved']);const before=caller(r);const result=await r.run(['worktree','deliver'],p=>{if(p==='deliver:before-ff'&&mode.startsWith('late-')){fs.writeFileSync(tracked,'late');if(mode==='late-index')r.git(['add','work.spec.md']);}});assert.equal(result.exit,4,mode+JSON.stringify(result));assert.equal(result.output.reason,mode==='moved'?'caller-moved':'caller-dirty');const after=caller(r);assert.equal(after.head,before.head);assert.deepEqual(after.bytes,before.bytes);if(!mode.startsWith('late-'))assert.deepEqual(after,before);assert.equal(rows(r,'delivered').length,0);
 }finally{r.cleanup();}}
 });
 it('squash safety resumes every durable boundary with the same retained identity',async()=>{
 for(const boundary of ['after-commit','after-preserve','after-started','before-ff','after-ff','after-delivered']){const {r}=await prepared();try{let fired=0,commits=0;const run=r.deps.run;r.deps.run=async(argv,opts)=>{if(argv[1]==='commit-tree')commits++;return run(argv,opts);};const base=r.git(['rev-parse','HEAD']);const crash=await r.run(['worktree','deliver'],p=>{if(p==='deliver:'+boundary){fired++;throw Error('injected '+boundary);}});assert.equal(fired,1,JSON.stringify(crash));assert.equal(crash.exit,2);const retained=r.git(['for-each-ref','--format=%(objectname)',ref]);const started=rows(r,'deliver-started')[0];const saved=retained||started?.data['to'];const beforeCount=commits;const retry=await r.run(['worktree','deliver']);assert.equal(retry.exit,0,JSON.stringify(retry));if(saved){assert.equal(retry.value.to,saved);assert.equal(commits,beforeCount);}assert.equal(rows(r,'deliver-started').length,1);assert.equal(rows(r,'delivered').length,1);assert.equal(r.git(['show','-s','--format=%P','HEAD']),base);assert.equal((await r.run(['worktree','deliver'])).value.delivered,false);assert.equal(rows(r,'delivered').length,1);
 }finally{r.cleanup();}}
 });
 it('squash safety blocks stale refs, conflicting starts and unfinished legacy recovery',async()=>{
 for(const mode of ['stale-source','conflicting-ref','legacy','start-only','ref-only','preparation-error','changed-completed']){const {r}=await prepared();try{const base=r.git(['rev-parse','HEAD']);const source=r.git(['rev-parse','HEAD'],r.integration);const dest={path:r.root,branch:r.git(['symbolic-ref','--short','HEAD'])};
 if(mode==='legacy')await appendRecord(r.session,{kind:'integrate',by:'tool',data:{phase:'deliver-started',dest,from:base,to:source}},r.deps);
 else if(mode==='preparation-error'){const run=r.deps.run;r.deps.run=async(argv,opts)=>argv[1]==='commit-tree'?{exit:1,stdout:'',stderr:'missing Git identity'}:run(argv,opts);}
 else if(mode==='changed-completed'){assert.equal((await r.run(['worktree','deliver'])).exit,0);}
 else {await r.run(['worktree','deliver'],p=>{if(p===(mode==='ref-only'?'deliver:after-preserve':'deliver:after-started'))throw Error('interrupt');});if(mode==='conflicting-ref')r.git(['update-ref',ref,base]);if(mode==='start-only')r.git(['update-ref','-d',ref]);}
 if(['stale-source','changed-completed'].includes(mode)){fs.writeFileSync(path.join(r.integration,'src/file.ts'),'new source');await r.run(['worktree','commit','--reason','later']);}
 const before=caller(r);const retry=await r.run(['worktree','deliver']);if(['start-only','ref-only'].includes(mode)){assert.equal(retry.exit,0,JSON.stringify(retry));}else{assert.equal(retry.exit,mode==='preparation-error'?2:4,mode+JSON.stringify(retry));assert.equal(retry.output.reason,mode==='preparation-error'?'fault':'recovery-blocked');if(mode==='preparation-error')assert.match(retry.output.summary,/missing Git identity/);assert.deepEqual(caller(r),before);}
 if(mode==='stale-source'||mode==='conflicting-ref'||mode==='legacy'){await r.run(['worktree','cleanup']);assert.ok(fs.existsSync(r.integration));assert.ok(r.git(['branch','--list','dispatch/test/integration']));if(mode!=='legacy')assert.ok(r.git(['for-each-ref','--format=%(refname)',ref]));}
 }finally{r.cleanup();}}
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
