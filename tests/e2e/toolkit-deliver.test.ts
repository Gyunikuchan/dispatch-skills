import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {describe,it} from 'node:test';
import {toolkitRepo,planSource} from './helpers/toolkit-repo.ts';import {foldLedger,appendRecord} from '../../skills/dispatch/scripts/toolkit/ledger.ts';
type Repo=Awaited<ReturnType<typeof toolkitRepo>>;
const rows=(r:Repo,phase:string)=>foldLedger(r.session).records.filter(x=>x.kind==='integrate'&&x.data['phase']===phase);
const ref='refs/dispatch/test/delivered-source';
const base={'keep.txt':'keep\n','del.txt':'del\n','exec.sh':'#!/bin/sh\n','swap-a':'file\n','swap-b/inner.txt':'inner\n'};
const binary=Buffer.from([0,255,254,10,32,32,13,10,32,32]);
async function prepared(files:Record<string,string>=base){const r=await toolkitRepo(planSource,files);await r.level();const made=await r.run(['worktree','create','T1']);const writer=path.join(r.session,made.value.path);fs.writeFileSync(path.join(writer,'src/file.ts'),'delivered\n');assert.equal((await r.run(['worktree','submit','T1'])).exit,0);assert.equal((await r.run(['worktree','integrate','T1'])).exit,0);return {r,writer};}
// Integration fix touching add, edit, delete, mode, binary bytes and both directory/file swaps.
async function change(r:Repo){const w=r.integration;
 fs.writeFileSync(path.join(w,'src/file.ts'),'final\n');fs.mkdirSync(path.join(w,'bin'));fs.writeFileSync(path.join(w,'bin/blob.bin'),binary);fs.rmSync(path.join(w,'del.txt'));
 fs.rmSync(path.join(w,'swap-a'));fs.mkdirSync(path.join(w,'swap-a'));fs.writeFileSync(path.join(w,'swap-a/child'),'child\n');
 fs.rmSync(path.join(w,'swap-b'),{recursive:true});fs.writeFileSync(path.join(w,'swap-b'),'now a file\n');
 r.git(['update-index','--chmod=+x','exec.sh'],w);
 assert.equal((await r.run(['worktree','commit','--reason','final'])).exit,0);return r.git(['rev-parse','HEAD'],r.integration);}
const caller=(r:Repo)=>({head:r.git(['rev-parse','HEAD']),branch:r.git(['symbolic-ref','--short','HEAD']),index:r.git(['ls-files','--stage','-z']),keep:fs.existsSync(path.join(r.root,'keep.txt'))?fs.readFileSync(path.join(r.root,'keep.txt')):null});
const cat=(r:Repo,spec:string)=>{const t=spawnSync('git',['cat-file','-t',spec],{cwd:r.root,encoding:'utf8'});if(t.status)return null;const type=t.stdout.trim();return type==='blob'?spawnSync('git',['cat-file','blob',spec],{cwd:r.root}).stdout:type;};
function assertMatchesSource(r:Repo,from:string,source:string){const names=r.git(['diff','--name-only','--no-renames','-z',from,source]).split('\0').filter(Boolean);assert.ok(names.length>=6,names.join());
 for(const name of names){const want=cat(r,source+':'+name),file=path.join(r.root,name);if(want===null)assert.equal(fs.existsSync(file),false,name);else if(want==='tree')assert.ok(fs.statSync(file).isDirectory(),name);else{assert.ok(fs.statSync(file).isFile(),name);assert.deepEqual(fs.readFileSync(file),want,name);}}}
// Cases use independent repositories, so run them concurrently and name the failing case.
const each=(modes:string[],fn:(mode:string)=>Promise<void>)=>Promise.all(modes.map(mode=>fn(mode).catch((error:unknown)=>{throw Object.assign(new Error(mode+': '+String(error)),{cause:error});})));
describe('toolkit delivery and cleanup',{concurrency:true},()=>{
 it('pending MUST rejection blocks caller writes and delivered records until native agreement',async()=>{const {r}=await prepared();try {
  const skill=path.join(r.session,'confirmation-skill');fs.mkdirSync(skill);fs.cpSync(path.join(r.deps.skillRoot,'references'),path.join(skill,'references'),{recursive:true});
  fs.writeFileSync(path.join(skill,'config.jsonc'),JSON.stringify({'read-delegates':{codex:{nativeSubagentsOnly:true,targets:[{low:{model:'native'}}]}},phases:{'code-review':{targets:{low:1},rounds:{low:1}}}}));
  r.deps.skillRoot=skill;r.deps.orchestrator={platform:'codex',model:'native'};r.deps.liveness={};
  const review=()=>r.run(['review','run','integration','--kind','code','--level','low']);
  const first=await review();assert.equal(first.output.reason,'native-pending');fs.writeFileSync(first.value.pending[0].replyPath,JSON.stringify({status:'FINDINGS',findings:[{severity:'MUST',tag:'correctness',locus:'src/file.ts:L1',defect:'Unbounded writes',requiredChange:'Bound writes'}]}));
  assert.equal((await review()).exit,0);
  await appendRecord(r.session,{kind:'ruling',by:'orchestrator',key:'reject-delivery',data:{subject:'review:code-integration:R1-F001',ruling:'rejected',rationale:'Captured writes have a bound'}},r.deps);
  const before=caller(r),bytes=fs.readFileSync(path.join(r.root,'src/file.ts'));
  const blocked=await r.run(['worktree','deliver']);assert.equal(blocked.output.reason,'review-confirmation-required');assert.deepEqual(caller(r),before);assert.deepEqual(fs.readFileSync(path.join(r.root,'src/file.ts')),bytes);assert.equal(rows(r,'delivered').length,0);assert.equal(rows(r,'deliver-started').length,0);
  const id='rejection:code-integration:R1-F001';await appendRecord(r.session,{kind:'escalation',by:'tool',key:'delivery-dispute',data:{id,state:'open',summary:'Reviewer disputes rejection'}},r.deps);
  assert.equal((await r.run(['worktree','deliver'])).output.reason,'review-confirmation-required');assert.deepEqual(caller(r),before);
  await appendRecord(r.session,{kind:'escalation',by:'orchestrator',key:'delivery-resolution',data:{id,state:'resolved',summary:'User decided the bounded writes evidence must be rechecked'}},r.deps);
  const confirm=await review();assert.equal(confirm.output.reason,'native-pending');const prompt=fs.readFileSync(confirm.value.pending[0].promptPath,'utf8'),requestId=/Request ID: `([^`]+)`/.exec(prompt)![1]!;
  fs.writeFileSync(confirm.value.pending[0].replyPath,JSON.stringify({status:'CLEAN',findings:[],confirmations:[{requestId,decision:'agree',rationale:'The captured implementation bounds each write'}]}));assert.equal((await review()).exit,0);
  assert.equal((await r.run(['worktree','deliver'])).exit,0);assert.equal(rows(r,'delivered').length,1);assert.deepEqual(caller(r),before);
 }finally{r.cleanup();}});
 it('uncommitted delivery restores the verified tree as unstaged changes and retains the source ref',async()=>{const {r,writer}=await prepared();try{
 const from=r.git(['rev-parse','HEAD']);const source=await change(r);fs.writeFileSync(path.join(r.root,'keep.txt'),'dirty keep');fs.writeFileSync(path.join(r.root,'scratch'),'scratch');fs.writeFileSync(path.join(r.root,'ignored'),'ignored');
 const before=caller(r);const first=await r.run(['worktree','deliver']);assert.equal(first.exit,0,JSON.stringify(first));
 assert.equal(first.value.mode,'uncommitted');assert.equal(first.value.source,source);assert.equal(first.value.from,from);assert.equal(first.value.ref,ref);assert.equal(first.value.delivered,true);assert.equal('to' in first.value,false);
 assert.deepEqual(caller(r),before);assert.equal(r.git(['rev-parse',ref]),source);assertMatchesSource(r,from,source);assert.equal(r.git(['diff','--cached','--name-only']),'');
 assert.ok(r.git(['status','--porcelain','-uall']).includes('src/file.ts'));assert.equal(r.git(['rev-parse','HEAD'],r.integration),source);
 if(process.platform!=='win32')assert.ok(fs.statSync(path.join(r.root,'exec.sh')).mode&0o111);
 assert.equal(fs.readFileSync(path.join(r.root,'scratch'),'utf8'),'scratch');assert.equal(fs.readFileSync(path.join(r.root,'ignored'),'utf8'),'ignored');
 const started=rows(r,'deliver-started')[0]!.data,done=rows(r,'delivered')[0]!.data;assert.deepEqual(Object.keys(started).sort(),['dest','from','mode','phase','source']);assert.equal(done['mode'],'uncommitted');assert.equal('to' in done,false);
 fs.writeFileSync(path.join(r.root,'src/file.ts'),'later edit');fs.unlinkSync(path.join(r.root,'bin/blob.bin'));const again=await r.run(['worktree','deliver']);assert.equal(again.exit,0);assert.equal(again.value.delivered,false);assert.equal(fs.readFileSync(path.join(r.root,'src/file.ts'),'utf8'),'later edit');assert.equal(rows(r,'delivered').length,1);
 const unowned=path.join(r.root,'outside');r.git(['worktree','add','--detach',unowned,'HEAD']);
 const beforeCleanup=caller(r),run=r.deps.run;let interrupted=0;
 r.deps.run=async(argv,opts)=>{const result=await run(argv,opts);if(argv[1]==='branch'&&argv[2]==='-D'&&result.exit===0){interrupted++;throw Error('interrupted after branch deletion');}return result;};
 const failedCleanup=await r.run(['worktree','cleanup']);r.deps.run=run;assert.equal(interrupted,1,JSON.stringify(failedCleanup));assert.equal(failedCleanup.exit,2);assert.equal(r.git(['branch','--list','dispatch/test/integration']),'');assert.equal(r.git(['rev-parse',ref]),source);
 const cleaned=await r.run(['worktree','cleanup']);assert.equal(cleaned.exit,0);assert.deepEqual(caller(r),beforeCleanup);assert.ok(!fs.existsSync(writer));assert.ok(!fs.existsSync(r.integration));assert.ok(fs.existsSync(unowned));assert.equal(r.git(['branch','--list','dispatch/test/integration']),'');assert.equal(r.git(['rev-parse',ref]),source);assert.equal(r.git(['rev-parse','--verify',source+'^{commit}']),source);
 }finally{r.cleanup();}});
 it('uncommitted delivery of a same-tree integration retains the source ref without touching the caller',async()=>{const r=await toolkitRepo();try{await r.level();await r.run(['verify','run']);const from=r.git(['rev-parse','HEAD']);r.git(['commit','--allow-empty','-m','internal empty'],r.integration);const source=r.git(['rev-parse','HEAD'],r.integration);
 fs.writeFileSync(path.join(r.root,'src/file.ts'),'caller edit');const before=caller(r);
 const first=await r.run(['worktree','deliver']);assert.equal(first.exit,0,JSON.stringify(first));assert.equal(first.value.noop,true);assert.equal(first.value.source,source);assert.equal(first.value.from,from);assert.deepEqual(first.value.paths,[]);assert.deepEqual(caller(r),before);assert.equal(fs.readFileSync(path.join(r.root,'src/file.ts'),'utf8'),'caller edit');assert.equal(r.git(['rev-parse',ref]),source);
 assert.equal(rows(r,'delivered')[0]!.data['noop'],true);assert.equal((await r.run(['worktree','deliver'])).value.delivered,false);assert.equal(rows(r,'delivered').length,1);
 assert.equal((await r.run(['worktree','cleanup'])).exit,0);assert.equal(r.git(['rev-parse',ref]),source);assert.equal(r.git(['branch','--list','dispatch/test/integration']),'');}finally{r.cleanup();}});
 it('uncommitted safety refuses overlapping caller state and keeps the caller unchanged',async()=>{
 await each(['tracked-edit','untracked','ignored','ancestor','descendant','staged','intent-to-add','moved','other-branch','late-edit','late-index','late-untracked','sparse','gitlink'],async mode=>{const {r}=await prepared();try{
 const from=r.git(['rev-parse','HEAD']);const w=r.integration;
 if(mode==='gitlink'){fs.mkdirSync(path.join(w,'sub'));r.git(['update-index','--add','--cacheinfo','160000,'+from+',sub'],w);r.git(['commit','-m','gitlink'],w);}
 else{
  if(mode==='descendant'){fs.mkdirSync(path.join(w,'new-file'));fs.writeFileSync(path.join(w,'new-file/child'),'new');}else fs.writeFileSync(path.join(w,'new-file'),'new');
  fs.writeFileSync(path.join(w,'src/file.ts'),'final\n');assert.equal((await r.run(['worktree','commit','--reason','add'])).exit,0);}
 const file=path.join(r.root,'src/file.ts'),keep=path.join(r.root,'keep.txt');
 if(mode==='tracked-edit')fs.writeFileSync(file,'caller');
 if(mode==='untracked')fs.writeFileSync(path.join(r.root,'new-file'),'caller');
 if(mode==='ignored'){fs.appendFileSync(path.join(r.root,'.git/info/exclude'),'\nnew-file\n');fs.writeFileSync(path.join(r.root,'new-file'),'caller');}
 if(mode==='ancestor'){fs.mkdirSync(path.join(r.root,'new-file'));fs.writeFileSync(path.join(r.root,'new-file/child'),'caller');}
 if(mode==='descendant')fs.writeFileSync(path.join(r.root,'new-file'),'caller');
 if(mode==='staged'){fs.writeFileSync(keep,'staged');r.git(['add','keep.txt']);}
 if(mode==='intent-to-add'){fs.writeFileSync(path.join(r.root,'extra.txt'),'x');r.git(['add','-N','extra.txt']);}
 if(mode==='moved')r.git(['commit','--allow-empty','-m','moved']);
 if(mode==='other-branch')r.git(['switch','-c','other']);
 if(mode==='sparse')r.git(['config','core.sparseCheckout','true']);
 const before=caller(r),srcBytes=fs.readFileSync(file);
 const result=await r.run(['worktree','deliver'],p=>{if(p!=='deliver:before-apply')return;if(mode==='late-edit')fs.writeFileSync(file,'late');if(mode==='late-index'){fs.writeFileSync(keep,'late');r.git(['add','keep.txt']);}if(mode==='late-untracked')fs.writeFileSync(path.join(r.root,'new-file'),'late');});
 assert.equal(result.exit,4,mode+JSON.stringify(result));assert.equal(result.output.reason,mode==='moved'||mode==='other-branch'?'caller-moved':mode==='sparse'?'unsupported-sparse':mode==='gitlink'?'unsupported-entry':'caller-dirty',mode);
 const after=caller(r);assert.equal(after.head,before.head);assert.equal(after.branch,before.branch);if(!mode.startsWith('late-'))assert.deepEqual(after,before);
 if(mode==='tracked-edit')assert.deepEqual(fs.readFileSync(file),Buffer.from('caller'));if(mode==='late-edit')assert.equal(fs.readFileSync(file,'utf8'),'late');void srcBytes;
 assert.equal(rows(r,'delivered').length,0,mode);
 }finally{r.cleanup();}});
 });
 it('uncommitted safety preserves unrelated dirty and untracked files byte for byte',async()=>{const {r}=await prepared();try{
 await change(r);const dirty=Buffer.from([1,2,0,255,13,10]);fs.writeFileSync(path.join(r.root,'keep.txt'),dirty);fs.writeFileSync(path.join(r.root,'extra-untracked'),'u');
 const result=await r.run(['worktree','deliver']);assert.equal(result.exit,0,JSON.stringify(result));assert.deepEqual(fs.readFileSync(path.join(r.root,'keep.txt')),dirty);assert.equal(fs.readFileSync(path.join(r.root,'extra-untracked'),'utf8'),'u');assert.equal(r.git(['diff','--cached','--name-only']),'');
 assert.match(r.git(['status','--porcelain']),/^ M keep\.txt$/m);}finally{r.cleanup();}});
 it('uncommitted recovery resumes every durable boundary to the same caller state',async()=>{
 await each(['after-preserve','after-started','before-apply','after-apply','after-delivered'],async boundary=>{const {r}=await prepared();try{
 const from=r.git(['rev-parse','HEAD']);const source=await change(r);let fired=0;
 const crash=await r.run(['worktree','deliver'],p=>{if(p==='deliver:'+boundary){fired++;throw Error('injected '+boundary);}});assert.equal(fired,1,JSON.stringify(crash));assert.equal(crash.exit,2);
 const retry=await r.run(['worktree','deliver']);assert.equal(retry.exit,0,boundary+JSON.stringify(retry));assert.equal(retry.value.delivered,boundary!=='after-delivered');
 assertMatchesSource(r,from,source);assert.equal(r.git(['rev-parse','HEAD']),from);assert.equal(r.git(['rev-parse',ref]),source);assert.equal(rows(r,'deliver-started').length,1);assert.equal(rows(r,'delivered').length,1);
 assert.equal((await r.run(['worktree','deliver'])).value.delivered,false);assert.equal(rows(r,'delivered').length,1);
 }finally{r.cleanup();}});
 });
 it('uncommitted recovery completes a partly applied tree and refuses a path edited since',async()=>{
 await each(['partial','edited'],async mode=>{const {r}=await prepared();try{
 const from=r.git(['rev-parse','HEAD']);const source=await change(r);
 const crash=await r.run(['worktree','deliver'],p=>{if(p!=='deliver:before-apply')return;
  // Simulate Git interrupted mid-write: a mixed set of delivered paths already at source, including both directory/file swaps.
  fs.writeFileSync(path.join(r.root,'src/file.ts'),'final\n');fs.mkdirSync(path.join(r.root,'bin'));fs.writeFileSync(path.join(r.root,'bin/blob.bin'),binary);fs.rmSync(path.join(r.root,'del.txt'));
  fs.rmSync(path.join(r.root,'swap-b'),{recursive:true});fs.writeFileSync(path.join(r.root,'swap-b'),'now a file\n');
  fs.rmSync(path.join(r.root,'swap-a'));fs.mkdirSync(path.join(r.root,'swap-a'));fs.writeFileSync(path.join(r.root,'swap-a/child'),'child\n');throw Error('crash mid apply');});
 assert.equal(crash.exit,2,JSON.stringify(crash));
 if(mode==='edited'){fs.writeFileSync(path.join(r.root,'src/file.ts'),'user edit');const before=caller(r);const refused=await r.run(['worktree','deliver']);assert.equal(refused.exit,4,JSON.stringify(refused));assert.equal(refused.output.reason,'caller-dirty');assert.match(JSON.stringify(refused.output),/src\/file\.ts/);assert.deepEqual(caller(r),before);assert.equal(fs.readFileSync(path.join(r.root,'src/file.ts'),'utf8'),'user edit');assert.equal(rows(r,'delivered').length,0);}
 else{const retry=await r.run(['worktree','deliver']);assert.equal(retry.exit,0,JSON.stringify(retry));assertMatchesSource(r,from,source);assert.equal(r.git(['rev-parse','HEAD']),from);assert.equal(r.git(['diff','--cached','--name-only']),'');}
 }finally{r.cleanup();}});
 });
 it('uncommitted recovery blocks conflicting refs, unfinished deliveries and changed sources',async()=>{
 await each(['conflicting-ref','other-source','changed-completed'],async mode=>{const {r}=await prepared();try{const from=r.git(['rev-parse','HEAD']);const dest={path:r.root,branch:r.git(['symbolic-ref','--short','HEAD'])};
 if(mode==='conflicting-ref')r.git(['update-ref',ref,from]);
 if(mode==='other-source')await appendRecord(r.session,{kind:'integrate',by:'tool',data:{phase:'deliver-started',mode:'uncommitted',dest,from,source:from}},r.deps);
 if(mode==='changed-completed'){assert.equal((await r.run(['worktree','deliver'])).exit,0);fs.writeFileSync(path.join(r.integration,'src/file.ts'),'later');assert.equal((await r.run(['worktree','commit','--reason','later'])).exit,0);}
 const before=caller(r),bytes=fs.readFileSync(path.join(r.root,'src/file.ts'));const retry=await r.run(['worktree','deliver']);assert.equal(retry.exit,4,mode+JSON.stringify(retry));assert.equal(retry.output.reason,'recovery-blocked');assert.deepEqual(caller(r),before);assert.deepEqual(fs.readFileSync(path.join(r.root,'src/file.ts')),bytes);
 if(mode==='conflicting-ref')assert.equal(r.git(['rev-parse',ref]),from);
 await r.run(['worktree','cleanup']);assert.ok(fs.existsSync(r.integration));assert.ok(r.git(['branch','--list','dispatch/test/integration']));
 }finally{r.cleanup();}});
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
    await each(['submitted-edit', 'ignored-closed', 'dirty-delivered'], async mode => {
      const { r, writer } = await prepared(); try {
        let file: string;
        if (mode === 'submitted-edit') { file = path.join(writer, 'src/file.ts'); fs.writeFileSync(file, 'kept\n'); }
        else { await r.run(['worktree', 'deliver']); if (mode === 'ignored-closed') await r.run(['worktree', 'close', '--reason', 'stop']); file = path.join(r.integration, mode === 'dirty-delivered' ? 'src/file.ts' : 'ignored'); fs.writeFileSync(file, 'kept\n'); }
        const cleaned = await r.run(['worktree', 'cleanup']); assert.equal(cleaned.exit, 0); assert.equal(fs.readFileSync(file, 'utf8'), 'kept\n'); assert.ok(JSON.stringify(cleaned.value).includes('unpreserved'));
        if (mode === 'dirty-delivered') assert.ok(r.git(['branch', '--list', 'dispatch/test/integration']));
      } finally { r.cleanup(); }
    });
  });
  it('removes abandoned launches and rejected candidates after close',async()=>{
    const r=await toolkitRepo(); try {
      await r.level(); const first=await r.run(['worktree','create','T1']); fs.writeFileSync(path.join(r.session,first.value.path,'src/file.ts'),'abandoned\n'); await r.run(['worktree','abandon','T1','--reason','discard']);
      const second=await r.run(['worktree','create','T1']); fs.writeFileSync(path.join(r.session,second.value.path,'src/file.ts'),'rejected\n'); await r.run(['worktree','submit','T1']); await r.run(['worktree','abort','T1','--reason','reject']);
      await r.run(['worktree','close','--reason','stop']); const clean=await r.run(['worktree','cleanup']); assert.equal(clean.exit,0); assert.ok(!fs.existsSync(path.join(r.session,first.value.path))); assert.ok(!fs.existsSync(path.join(r.session,second.value.path))); assert.ok(!fs.existsSync(r.integration));
    }finally{r.cleanup();}
  });
});
