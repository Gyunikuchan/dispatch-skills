import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {spawn,spawnSync} from 'node:child_process';import {describe,it} from 'node:test';
import {toolkitRepo,planSource,setupTestSkill} from './helpers/toolkit-repo.ts';import {foldLedger,appendRecord} from '../../skills/dispatch/scripts/toolkit/ledger.ts';
import {abandonedRef,candidateRef} from '../../skills/dispatch/scripts/toolkit/writers.ts';
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
const registered=(r:Repo,cwd:string)=>{const key=(value:string)=>{const resolved=path.resolve(value).replace(/^\\\\\?\\/,'');return process.platform==='win32'?resolved.toLowerCase():resolved;};return r.git(['worktree','list','--porcelain']).split(/\r?\n/).filter(line=>line.startsWith('worktree ')).some(line=>key(line.slice(9))===key(cwd));};
function assertMatchesSource(r:Repo,from:string,source:string){const names=r.git(['diff','--name-only','--no-renames','-z',from,source]).split('\0').filter(Boolean);assert.ok(names.length>=6,names.join());
 for(const name of names){const want=cat(r,source+':'+name),file=path.join(r.root,name);if(want===null)assert.equal(fs.existsSync(file),false,name);else if(want==='tree')assert.ok(fs.statSync(file).isDirectory(),name);else{assert.ok(fs.statSync(file).isFile(),name);assert.deepEqual(fs.readFileSync(file),want,name);}}}
// Cases use independent repositories, so run them concurrently and name the failing case.
const each=(modes:string[],fn:(mode:string)=>Promise<void>)=>Promise.all(modes.map(mode=>fn(mode).catch((error:unknown)=>{throw Object.assign(new Error(mode+': '+String(error)),{cause:error});})));
async function holdCwd(cwd:string){
 const child=spawn(process.execPath,['-e',"process.stdout.write('ready\\n');setInterval(()=>{},1000)"],{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});let ready=false;
 const exited=new Promise(resolve=>child.once('exit',resolve));
 await new Promise<void>((resolve,reject)=>{child.stdout!.once('data',()=>{ready=true;resolve();});child.once('error',reject);child.once('exit',code=>{if(!ready)reject(new Error('directory holder exited early: '+code));});});
 return {release:async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await exited;}};
}
describe('toolkit delivery and cleanup',()=>{
 it('pending MUST rejection blocks caller writes and delivered records until native agreement',async()=>{const {r}=await prepared();try {
  r.deps.skillRoot=setupTestSkill(r.deps,r.session,'confirmation-skill',{'read-delegates':{codex:{nativeSubagentsOnly:true,targets:[{low:{model:'native'}}]}},phases:{'code-review':{targets:{low:1},rounds:{low:1}}}});r.deps.orchestrator={platform:'codex',model:'native'};r.deps.liveness={};
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
 assert.equal(first.value.mode,'uncommitted');assert.equal(first.value.source,source);assert.equal(first.value.from,from);assert.equal(first.value.ref,ref);assert.equal(first.value.delivered,true);
 assert.deepEqual(caller(r),before);assert.equal(r.git(['rev-parse',ref]),source);assertMatchesSource(r,from,source);assert.equal(r.git(['diff','--cached','--name-only']),'');
 assert.ok(r.git(['status','--porcelain','-uall']).includes('src/file.ts'));assert.equal(r.git(['rev-parse','HEAD'],r.integration),source);
 if(process.platform!=='win32')assert.ok(fs.statSync(path.join(r.root,'exec.sh')).mode&0o111);
 assert.equal(fs.readFileSync(path.join(r.root,'scratch'),'utf8'),'scratch');assert.equal(fs.readFileSync(path.join(r.root,'ignored'),'utf8'),'ignored');
 const started=rows(r,'deliver-started')[0]!.data,done=rows(r,'delivered')[0]!.data;assert.deepEqual(Object.keys(started).sort(),['dest','from','mode','phase','source']);assert.equal(done['mode'],'uncommitted');
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
 // Refusals before deliver-started leave no ledger state, so caller-only modes share one repo and undo between cases; integration-shape and late modes need their own.
 const integrate=async(r:Repo,mode:string)=>{const from=r.git(['rev-parse','HEAD']),w=r.integration;
  if(mode==='gitlink'){fs.mkdirSync(path.join(w,'sub'));r.git(['update-index','--add','--cacheinfo','160000,'+from+',sub'],w);r.git(['commit','-m','gitlink'],w);return;}
  if(mode==='descendant'){fs.mkdirSync(path.join(w,'new-file'));fs.writeFileSync(path.join(w,'new-file/child'),'new');}else fs.writeFileSync(path.join(w,'new-file'),'new');
  fs.writeFileSync(path.join(w,'src/file.ts'),'final\n');assert.equal((await r.run(['worktree','commit','--reason','add'])).exit,0);};
 const refuses=async(r:Repo,mode:string)=>{const from=r.git(['rev-parse','HEAD']);
 const file=path.join(r.root,'src/file.ts'),keep=path.join(r.root,'keep.txt'),exclude=path.join(r.root,'.git/info/exclude');
 const initial=caller(r),srcBytes=fs.readFileSync(file),keepBytes=fs.readFileSync(keep),excludeBytes=fs.readFileSync(exclude);
 if(mode==='tracked-edit')fs.writeFileSync(file,'caller');
 if(mode==='untracked')fs.writeFileSync(path.join(r.root,'new-file'),'caller');
 if(mode==='ignored'){fs.appendFileSync(exclude,'\nnew-file\n');fs.writeFileSync(path.join(r.root,'new-file'),'caller');}
 if(mode==='ancestor'){fs.mkdirSync(path.join(r.root,'new-file'));fs.writeFileSync(path.join(r.root,'new-file/child'),'caller');}
 if(mode==='descendant')fs.writeFileSync(path.join(r.root,'new-file'),'caller');
 if(mode==='staged'){fs.writeFileSync(keep,'staged');r.git(['add','keep.txt']);}
 if(mode==='intent-to-add'){fs.writeFileSync(path.join(r.root,'extra.txt'),'x');r.git(['add','-N','extra.txt']);}
 if(mode==='moved')r.git(['commit','--allow-empty','-m','moved']);
 if(mode==='other-branch')r.git(['switch','-c','other']);
 if(mode==='sparse')r.git(['config','core.sparseCheckout','true']);
 const before=caller(r);
 const result=await r.run(['worktree','deliver'],p=>{if(p!=='deliver:before-apply')return;if(mode==='late-edit')fs.writeFileSync(file,'late');if(mode==='late-index'){fs.writeFileSync(keep,'late');r.git(['add','keep.txt']);}if(mode==='late-untracked')fs.writeFileSync(path.join(r.root,'new-file'),'late');});
 assert.equal(result.exit,4,mode+JSON.stringify(result));assert.equal(result.output.reason,mode==='moved'||mode==='other-branch'?'caller-moved':mode==='sparse'?'unsupported-sparse':mode==='gitlink'?'unsupported-entry':'caller-dirty',mode);
 const after=caller(r);assert.equal(after.head,before.head);assert.equal(after.branch,before.branch);if(!mode.startsWith('late-'))assert.deepEqual(after,before);
 if(mode==='tracked-edit')assert.deepEqual(fs.readFileSync(file),Buffer.from('caller'));if(mode==='late-edit')assert.equal(fs.readFileSync(file,'utf8'),'late');
 assert.equal(rows(r,'delivered').length,0,mode);
 if(mode==='descendant'||mode==='gitlink')return;
 // Undo the caller state so the next shared case starts from the same caller.
 if(mode==='staged'||mode==='late-index')r.git(['reset','-q','--','keep.txt']);
 if(mode==='intent-to-add')r.git(['rm','-q','--cached','extra.txt']);
 if(mode==='moved')r.git(['reset','-q','--soft',from]);
 if(mode==='other-branch'){r.git(['switch','-q',initial.branch]);r.git(['branch','-q','-D','other']);}
 if(mode==='sparse')r.git(['config','--unset','core.sparseCheckout']);
 for(const extra of ['new-file','extra.txt'])fs.rmSync(path.join(r.root,extra),{recursive:true,force:true});
 fs.writeFileSync(file,srcBytes);fs.writeFileSync(keep,keepBytes);fs.writeFileSync(exclude,excludeBytes);
 assert.deepEqual(caller(r),initial,mode+' undo');};
 const shared=async()=>{const {r}=await prepared();try{await integrate(r,'shared');
  for(const mode of ['tracked-edit','untracked','ignored','ancestor','staged','intent-to-add','moved','other-branch','sparse','late-edit','late-index','late-untracked'])await refuses(r,mode).catch((error:unknown)=>{throw Object.assign(new Error(mode+': '+String(error)),{cause:error});});
 }finally{r.cleanup();}};
 await Promise.all([shared(),each(['descendant','gitlink'],async mode=>{const {r}=await prepared();try{await integrate(r,mode);await refuses(r,mode);}finally{r.cleanup();}})]);
 });
 it('uncommitted safety preserves unrelated dirty and untracked files byte for byte',async()=>{const {r}=await prepared();try{
 await change(r);const dirty=Buffer.from([1,2,0,255,13,10]);fs.writeFileSync(path.join(r.root,'keep.txt'),dirty);fs.writeFileSync(path.join(r.root,'extra-untracked'),'u');
 const result=await r.run(['worktree','deliver']);assert.equal(result.exit,0,JSON.stringify(result));assert.deepEqual(fs.readFileSync(path.join(r.root,'keep.txt')),dirty);assert.equal(fs.readFileSync(path.join(r.root,'extra-untracked'),'utf8'),'u');assert.equal(r.git(['diff','--cached','--name-only']),'');
 assert.match(r.git(['status','--porcelain']),/^ M keep\.txt$/m);}finally{r.cleanup();}});
 it('uncommitted recovery resumes every durable boundary to the same caller state',async()=>{
 await each(['after-preserve','before-apply','after-apply','after-delivered'],async boundary=>{const {r}=await prepared();try{
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
  it('cleanup continues after an owned removal fault and retains recovery refs',{skip:process.platform!=='win32'},async()=>{
    const {r,writer}=await prepared();let holder:Awaited<ReturnType<typeof holdCwd>>|undefined;
    try {
      const next=await r.run(['worktree','create','T1']);const other=path.join(r.session,next.value.path);
      fs.writeFileSync(path.join(other,'src/file.ts'),'second delivered\n');assert.equal((await r.run(['worktree','submit','T1'])).exit,0);assert.equal((await r.run(['worktree','integrate','T1'])).exit,0);
      const delivered=await r.run(['worktree','deliver']);assert.equal(delivered.exit,0,JSON.stringify(delivered));
      const unrelated=path.join(r.root,'outside-worktree'),unrelatedRef='refs/dispatch/unrelated';
      r.git(['worktree','add','--detach',unrelated,'HEAD']);r.git(['update-ref',unrelatedRef,'HEAD']);
      // Model Git deregistering the integrated path before a held directory handle blocks cleanup.
      r.git(['worktree','remove','--force',writer]);fs.mkdirSync(writer);fs.writeFileSync(path.join(writer,'interrupted.tmp'),'retained until retry');
      holder=await holdCwd(writer);
      const partial=await r.run(['worktree','cleanup']);
      assert.equal(partial.exit,2,JSON.stringify(partial));assert.equal(partial.output.ok,false);assert.equal(partial.output.reason,'cleanup-incomplete');
      assert.ok(partial.value.removed.includes(next.value.path),JSON.stringify(partial.value));
      const writerRelative=path.relative(r.session,writer).replace(/\\/g,'/');
      const blocked=partial.value.kept.find((row:{path:string})=>row.path===writerRelative);
      assert.ok(blocked,JSON.stringify(partial.value));
      assert.equal(blocked.reason,'removal-failed');assert.ok(blocked.code);assert.ok(Buffer.byteLength(blocked.message,'utf8')<=1024);assert.match(blocked.message,/permission|busy|in use|remove/i);
      assert.ok(fs.existsSync(writer));
      const listed=registered(r,writer);
      assert.equal(fs.existsSync(path.join(writer,'.git')),listed);
      assert.equal(r.git(['rev-parse',candidateRef('test','T1',1)]).length,40);assert.notEqual(spawnSync('git',['show-ref','--verify','--quiet',candidateRef('test','T1',2)],{cwd:r.root}).status,0);
      assert.ok(r.git(['branch','--list','dispatch/test/integration']));assert.equal(r.git(['rev-parse',ref]).length,40);
      assert.ok(fs.existsSync(unrelated));assert.equal(r.git(['rev-parse',unrelatedRef]),r.git(['rev-parse','HEAD']));
      await holder.release();
      const retry=await r.run(['worktree','cleanup']);assert.equal(retry.exit,0,JSON.stringify(retry));assert.ok(!fs.existsSync(writer));assert.equal(r.git(['branch','--list','dispatch/test/integration']),'');
      assert.notEqual(spawnSync('git',['show-ref','--verify','--quiet',candidateRef('test','T1',1)],{cwd:r.root}).status,0);assert.equal(r.git(['rev-parse',ref]).length,40);
      assert.ok(fs.existsSync(unrelated));assert.equal(r.git(['rev-parse',unrelatedRef]),r.git(['rev-parse','HEAD']));
    } finally {await holder?.release();r.cleanup();}
  });
  it('keeps registered control metadata when Git refuses an owned removal',async()=>{
    const {r,writer}=await prepared();try {
      const next=await r.run(['worktree','create','T1']),other=path.join(r.session,next.value.path);
      fs.writeFileSync(path.join(other,'src/file.ts'),'second delivered\n');await r.run(['worktree','submit','T1']);await r.run(['worktree','integrate','T1']);await r.run(['worktree','deliver']);
      const run=r.deps.run;let refusals=0;
      r.deps.run=async(argv,opts)=>{if(argv[1]==='worktree'&&argv[2]==='remove'&&path.resolve(argv[4]!)===path.resolve(writer)){refusals++;return {exit:1,stdout:'',stderr:'fatal: simulated permission refusal'};}return run(argv,opts);};
      const partial=await r.run(['worktree','cleanup']);r.deps.run=run;
      assert.equal(refusals,1);assert.equal(partial.exit,2,JSON.stringify(partial));assert.equal(partial.output.reason,'cleanup-incomplete');
      const relative=path.relative(r.session,writer).replace(/\\/g,'/'),blocked=partial.value.kept.find((row:{path:string})=>row.path===relative);
      assert.equal(blocked.reason,'removal-failed');assert.ok(fs.existsSync(path.join(writer,'.git')));assert.ok(registered(r,writer));
      assert.equal(r.git(['rev-parse',candidateRef('test','T1',1)]).length,40);assert.ok(r.git(['branch','--list','dispatch/test/integration']));
      const retry=await r.run(['worktree','cleanup']);assert.equal(retry.exit,0,JSON.stringify(retry));assert.ok(!fs.existsSync(writer));assert.equal(r.git(['branch','--list','dispatch/test/integration']),'');
    } finally {r.cleanup();}
  });
  it('restores a missing registered control link before cleanup checks',async()=>{
    const {r,writer}=await prepared();try {
      const relative=path.relative(r.session,writer).replace(/\\/g,'/');fs.rmSync(path.join(writer,'.git'));
      const cleaned=await r.run(['worktree','cleanup']);assert.equal(cleaned.exit,0,JSON.stringify(cleaned));assert.ok(cleaned.value.removed.includes(relative));assert.ok(!fs.existsSync(writer));
    } finally {r.cleanup();}
  });
  it('finishes deregistration after an interrupted directory removal',async()=>{
    const r=await toolkitRepo();try {
      await r.level();const made=await r.run(['worktree','create','T1']),writer=path.join(r.session,made.value.path),relative=made.value.path;
      fs.writeFileSync(path.join(writer,'src/file.ts'),'preserved\n');await r.run(['worktree','abandon','T1','--reason','preserve snapshot']);await r.run(['worktree','close','--reason','stop']);
      fs.rmSync(writer,{recursive:true,force:true});assert.ok(registered(r,writer));
      const cleaned=await r.run(['worktree','cleanup']);assert.equal(cleaned.exit,0,JSON.stringify(cleaned));assert.ok(cleaned.value.removed.includes(relative));assert.ok(!registered(r,writer));
    } finally {r.cleanup();}
  });
  it('retains work when registered control metadata cannot be verified',async()=>{
    const {r,writer}=await prepared();try {
      const control=fs.readFileSync(path.join(writer,'.git'),'utf8'),target=/^gitdir:\s*(.+?)\s*$/m.exec(control)![1]!,admin=path.resolve(writer,target);
      fs.rmSync(path.join(writer,'.git'));fs.writeFileSync(path.join(admin,'commondir'),'../missing-common-dir\n');
      const result=await r.run(['worktree','cleanup']),relative=path.relative(r.session,writer).replace(/\\/g,'/');
      assert.equal(result.exit,2,JSON.stringify(result));assert.equal(result.output.reason,'cleanup-incomplete');assert.ok(fs.existsSync(writer));
      assert.ok(result.value.kept.some((row:{path:string;reason:string})=>row.path===relative&&row.reason==='control-metadata-unverifiable'));
      assert.equal(r.git(['rev-parse',candidateRef('test','T1',1)]).length,40);assert.ok(registered(r,writer));
    } finally {r.cleanup();}
  });
  it('keeps a preserved non-integrated writer registered across a lock and retries after release',{skip:process.platform!=='win32'},async()=>{
    const r=await toolkitRepo();let holder:Awaited<ReturnType<typeof holdCwd>>|undefined;
    try {
      await r.level();const made=await r.run(['worktree','create','T1']),writer=path.join(r.session,made.value.path),relative=made.value.path;
      fs.writeFileSync(path.join(writer,'src/file.ts'),'preserved\n');await r.run(['worktree','abandon','T1','--reason','preserve snapshot']);await r.run(['worktree','close','--reason','stop']);
      const ref=abandonedRef('test','T1',1),saved=r.git(['rev-parse',ref]);holder=await holdCwd(writer);
      const partial=await r.run(['worktree','cleanup']);assert.equal(partial.exit,2,JSON.stringify(partial));assert.equal(partial.output.reason,'cleanup-incomplete');
      assert.ok(partial.value.kept.some((row:{path:string;reason:string})=>row.path===relative&&row.reason==='removal-failed'));
      assert.ok(fs.existsSync(writer));assert.ok(fs.existsSync(path.join(writer,'.git')));assert.ok(registered(r,writer));assert.equal(r.git(['rev-parse',ref]),saved);
      await holder.release();const retry=await r.run(['worktree','cleanup']);assert.equal(retry.exit,0,JSON.stringify(retry));assert.ok(!fs.existsSync(writer));assert.ok(!registered(r,writer));assert.equal(r.git(['rev-parse',ref]),saved);
    } finally {await holder?.release();r.cleanup();}
  });
  it('reports a path-specific Git read fault and removes independent writers',async()=>{
    await each(['head','ls-files','tested-tree','snapshot-tree','tree-diff'],async failure=>{
      const r=await toolkitRepo();try {
        await r.level();
        const abandoned=async()=>{
          const made=await r.run(['worktree','create','T1']);assert.equal(made.exit,0,JSON.stringify(made));
          const writer=path.join(r.session,made.value.path);fs.writeFileSync(path.join(writer,'src/file.ts'),'preserved '+made.value.launch+'\n');
          const result=await r.run(['worktree','abandon','T1','--reason','preserve snapshot']);assert.equal(result.exit,0,JSON.stringify(result));
          const ref=abandonedRef('test','T1',made.value.launch);
          return {writer,relative:made.value.path,ref,saved:r.git(['rev-parse',ref])};
        };
        const blocked=await abandoned(),other=await abandoned();
        const closed=await r.run(['worktree','close','--reason','stop']);assert.equal(closed.exit,0,JSON.stringify(closed));
        if(failure==='tree-diff')fs.writeFileSync(path.join(blocked.writer,'ignored'),'ignored while checking preservation');
        const snapshotTree=r.git(['rev-parse',blocked.saved+'^{tree}']),run=r.deps.run;let faults=0;
        const matches=(argv:string[],opts:{cwd:string;env?:NodeJS.ProcessEnv})=>{
          const inBlocked=path.resolve(opts.cwd)===path.resolve(blocked.writer),inRoot=path.resolve(opts.cwd)===path.resolve(r.root);
          if(failure==='head')return inBlocked&&argv[1]==='rev-parse'&&argv[2]==='HEAD';
          if(failure==='ls-files')return inBlocked&&argv[1]==='ls-files'&&argv[2]==='--others'&&argv[3]==='--ignored';
          if(failure==='tested-tree')return inBlocked&&argv[1]==='read-tree'&&argv[2]==='HEAD'&&!!opts.env?.['GIT_INDEX_FILE'];
          if(failure==='snapshot-tree')return inRoot&&argv[1]==='rev-parse'&&argv[2]===blocked.saved+'^{tree}';
          return failure==='tree-diff'&&inBlocked&&argv[1]==='diff'&&argv[2]==='--name-only'&&argv.includes(snapshotTree);
        };
        r.deps.run=async(argv,opts)=>{if(!faults&&matches(argv,opts)){faults++;return {exit:1,stdout:'',stderr:'fatal: simulated '+failure+' read failure'};}return run(argv,opts);};
        let partial;try {partial=await r.run(['worktree','cleanup']);}finally {r.deps.run=run;}
        assert.equal(faults,1,failure);assert.equal(partial.exit,2,JSON.stringify(partial));assert.equal(partial.output.reason,'cleanup-incomplete');
        const row=partial.value.kept.find((entry:{path:string})=>entry.path===blocked.relative);
        assert.equal(row.reason,failure==='head'?'head-check-failed':'preservation-check-failed');assert.equal(row.code,'GIT_EXIT_2');assert.match(row.message,/simulated/);
        assert.ok(fs.existsSync(blocked.writer));assert.ok(registered(r,blocked.writer));assert.equal(r.git(['rev-parse',blocked.ref]),blocked.saved);
        assert.ok(partial.value.removed.includes(other.relative),JSON.stringify(partial.value));assert.ok(!fs.existsSync(other.writer));assert.ok(!registered(r,other.writer));
        if(failure==='tree-diff')fs.rmSync(path.join(blocked.writer,'ignored'),{force:true});
        const retry=await r.run(['worktree','cleanup']);assert.equal(retry.exit,0,JSON.stringify(retry));assert.ok(!fs.existsSync(blocked.writer));assert.ok(!registered(r,blocked.writer));assert.equal(r.git(['rev-parse',blocked.ref]),blocked.saved);
      } finally {r.cleanup();}
    });
  });
  it('continues cleanup when the missing integration branch probe throws',async()=>{
    const {r,writer}=await prepared();try {
      const delivered=await r.run(['worktree','deliver']);assert.equal(delivered.exit,0,JSON.stringify(delivered));
      const branch=r.git(['symbolic-ref','--short','HEAD'],r.integration),integrationRelative=path.relative(r.session,r.integration).replace(/\\/g,'/'),saved=r.git(['rev-parse',ref]);
      fs.rmSync(r.integration,{recursive:true,force:true});const run=r.deps.run;let probes=0;
      r.deps.run=async(argv,opts)=>{
        if(path.resolve(opts.cwd)===path.resolve(r.root)&&argv[1]==='rev-parse'&&argv[2]==='--verify'&&argv[3]==='--quiet'&&argv[4]==='refs/heads/'+branch){probes++;throw new Error('simulated integration branch verification failure');}
        return run(argv,opts);
      };
      let partial;try {partial=await r.run(['worktree','cleanup']);}finally {r.deps.run=run;}
      assert.equal(probes,1);assert.equal(partial.exit,2,JSON.stringify(partial));assert.equal(partial.output.reason,'cleanup-incomplete');
      const row=partial.value.kept.find((entry:{path:string})=>entry.path===integrationRelative);
      assert.equal(row.reason,'registration-check-failed');assert.equal(row.code,'CLEANUP_FAILED');assert.match(row.message,/simulated integration branch verification failure/);
      assert.ok(partial.value.removed.includes(path.relative(r.session,writer).replace(/\\/g,'/')));assert.ok(!fs.existsSync(writer));
      assert.ok(r.git(['branch','--list',branch]));assert.equal(r.git(['rev-parse',ref]),saved);
    } finally {r.cleanup();}
  });
  it('reports and recovers a stranded cleanup preflight path',{skip:process.platform!=='win32'},async()=>{
    const r=await toolkitRepo();let originalRename:typeof fs.renameSync|undefined,restoreFailures=0;
    try {
      await r.level();const made=await r.run(['worktree','create','T1']),writer=path.join(r.session,made.value.path),relative=made.value.path;
      fs.writeFileSync(path.join(writer,'src/file.ts'),'preserved\n');await r.run(['worktree','abandon','T1','--reason','preserve snapshot']);await r.run(['worktree','close','--reason','stop']);
      const recovery=path.join(path.dirname(writer),'.'+path.basename(writer)+'.cleanup-recovery'),ref=abandonedRef('test','T1',1),saved=r.git(['rev-parse',ref]);
      originalRename=fs.renameSync;
      fs.renameSync=((from,to)=>{
        const source=path.resolve(String(from)),target=path.resolve(String(to));
        if(target===path.resolve(writer)&&path.basename(source).startsWith('.'+path.basename(writer)+'.cleanup-')&&restoreFailures<2){restoreFailures++;throw Object.assign(new Error('simulated restore refusal'),{code:'EPERM'});}
        return originalRename!(from,to);
      }) as typeof fs.renameSync;
      let partial;try {partial=await r.run(['worktree','cleanup']);}finally {fs.renameSync=originalRename;}
      assert.equal(restoreFailures,2);assert.equal(partial.exit,2,JSON.stringify(partial));assert.equal(partial.output.reason,'cleanup-incomplete');
      const blocked=partial.value.kept.find((row:{path:string})=>row.path===relative);
      assert.equal(blocked.reason,'removal-failed');assert.equal(blocked.code,'WORKTREE_RESTORE_FAILED');assert.equal(blocked.recoveryPath,path.relative(r.session,recovery).replace(/\\/g,'/'));
      assert.ok(fs.existsSync(recovery));assert.ok(!fs.existsSync(writer));assert.ok(registered(r,writer));assert.equal(r.git(['rev-parse',ref]),saved);
      const retry=await r.run(['worktree','cleanup']);assert.equal(retry.exit,0,JSON.stringify(retry));assert.ok(!fs.existsSync(writer));assert.ok(!fs.existsSync(recovery));assert.ok(!registered(r,writer));assert.equal(r.git(['rev-parse',ref]),saved);
    } finally {if(originalRename)fs.renameSync=originalRename;r.cleanup();}
  });
  it('refuses a colliding cleanup recovery symlink without following it',async()=>{
    const r=await toolkitRepo();
    try {
      await r.level();const made=await r.run(['worktree','create','T1']),writer=path.join(r.session,made.value.path),relative=made.value.path;
      fs.writeFileSync(path.join(writer,'src/file.ts'),'preserved\n');await r.run(['worktree','abandon','T1','--reason','preserve snapshot']);await r.run(['worktree','close','--reason','stop']);
      const recovery=path.join(path.dirname(writer),'.'+path.basename(writer)+'.cleanup-recovery'),outside=path.join(r.root,'outside-recovery-target'),sentinel=path.join(outside,'keep.txt');
      fs.mkdirSync(outside);fs.writeFileSync(sentinel,'keep\n');fs.symlinkSync(outside,recovery,process.platform==='win32'?'junction':'dir');
      const ref=abandonedRef('test','T1',1),saved=r.git(['rev-parse',ref]),result=await r.run(['worktree','cleanup']);
      assert.equal(result.exit,2,JSON.stringify(result));assert.equal(result.output.reason,'cleanup-incomplete');
      const blocked=result.value.kept.find((row:{path:string})=>row.path===relative);
      assert.equal(blocked.reason,'recovery-failed');assert.equal(blocked.code,'WORKTREE_RECOVERY_PATH_CONFLICT');assert.equal(blocked.recoveryPath,path.relative(r.session,recovery).replace(/\\/g,'/'));
      assert.ok(fs.existsSync(writer));assert.equal(fs.lstatSync(recovery).isSymbolicLink(),true);assert.equal(fs.readFileSync(sentinel,'utf8'),'keep\n');assert.ok(registered(r,writer));assert.equal(r.git(['rev-parse',ref]),saved);
    } finally {r.cleanup();}
  });
  it('keeps changed writer bytes after a locked cleanup retry',{skip:process.platform!=='win32'},async()=>{
    const r=await toolkitRepo();let holder:Awaited<ReturnType<typeof holdCwd>>|undefined;
    try {
      await r.level();const made=await r.run(['worktree','create','T1']),writer=path.join(r.session,made.value.path),relative=made.value.path;
      fs.writeFileSync(path.join(writer,'src/file.ts'),'preserved\n');await r.run(['worktree','abandon','T1','--reason','preserve snapshot']);await r.run(['worktree','close','--reason','stop']);
      const ref=abandonedRef('test','T1',1),saved=r.git(['rev-parse',ref]);holder=await holdCwd(writer);assert.equal((await r.run(['worktree','cleanup'])).exit,2);
      await holder.release();fs.writeFileSync(path.join(writer,'src/file.ts'),'changed after interruption\n');
      const retry=await r.run(['worktree','cleanup']);assert.equal(retry.exit,0,JSON.stringify(retry));assert.ok(fs.existsSync(writer));
      assert.equal(fs.readFileSync(path.join(writer,'src/file.ts'),'utf8'),'changed after interruption\n');
      assert.ok(retry.value.kept.some((row:{path:string;reason:string;paths?:string[]})=>row.path===relative&&row.reason==='unpreserved'&&row.paths?.includes('src/file.ts')));
      assert.equal(r.git(['rev-parse',ref]),saved);assert.ok(registered(r,writer));
    } finally {await holder?.release();r.cleanup();}
  });
  it('reports incomplete cleanup when Git prune fails after a worktree is removed',async()=>{
    const {r,writer}=await prepared();try {
      const run=r.deps.run;let prunes=0;
      r.deps.run=async(argv,opts)=>{if(argv[1]==='worktree'&&argv[2]==='prune'&&++prunes===1)return {exit:1,stdout:'',stderr:'fatal: simulated prune failure'};return run(argv,opts);};
      const partial=await r.run(['worktree','cleanup']);r.deps.run=run;
      assert.equal(prunes,1);assert.equal(partial.exit,2,JSON.stringify(partial));assert.equal(partial.output.reason,'cleanup-incomplete');
      const relative=path.relative(r.session,writer).replace(/\\/g,'/');assert.ok(partial.value.removed.includes(relative),JSON.stringify(partial));
      assert.ok(partial.value.kept.some((row:{path:string;reason:string;code?:string})=>row.path===relative&&row.reason==='prune-failed'&&row.code==='GIT_EXIT_1'));
      assert.equal(r.git(['rev-parse',candidateRef('test','T1',1)]).length,40);assert.ok(r.git(['branch','--list','dispatch/test/integration']));
      const retry=await r.run(['worktree','cleanup']);assert.equal(retry.exit,0,JSON.stringify(retry));assert.notEqual(spawnSync('git',['show-ref','--verify','--quiet',candidateRef('test','T1',1)],{cwd:r.root}).status,0);
    } finally {r.cleanup();}
  });
  it('removes merged worktrees without preservation checks', async () => {
    await each(['writer', 'delivered'], async mode => {
      const { r, writer } = await prepared(); try {
        let dir = writer; const target = path.join(r.session, 'link-target');
        if (mode === 'writer') {
          fs.writeFileSync(path.join(writer, 'src/file.ts'), 'later\n');
          fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep'), 'keep'); fs.symlinkSync(target, path.join(writer, 'ignored'), 'junction');
        } else {
          await r.run(['worktree', 'deliver']); dir = r.integration;
          fs.writeFileSync(path.join(dir, 'src/file.ts'), 'later\n');
          fs.writeFileSync(path.join(dir, 'ignored'), 'later\n');
        }
        const cleaned = await r.run(['worktree', 'cleanup']); assert.equal(cleaned.exit, 0); assert.ok(!fs.existsSync(dir)); assert.ok(!JSON.stringify(cleaned.value).includes('unpreserved'));
        if (mode === 'writer') assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'keep');
        if (mode === 'delivered') assert.equal(r.git(['branch', '--list', 'dispatch/test/integration']), '');
      } finally { r.cleanup(); }
    });
  });
  it('retries removal of a deregistered worktree remnant without following links', async () => {
    const { r, writer } = await prepared(); try {
      const target = path.join(r.session, 'link-target'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep'), 'keep');
      // Simulate a cleanup interrupted after Git deregistered the worktree but before the directory was removed.
      r.git(['worktree', 'remove', '--force', writer]); fs.mkdirSync(writer); fs.symlinkSync(target, path.join(writer, 'ignored'), 'junction');
      const cleaned = await r.run(['worktree', 'cleanup']); assert.equal(cleaned.exit, 0);
      assert.ok(!fs.existsSync(writer)); assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'keep'); assert.ok(JSON.stringify(cleaned.value.removed).includes(path.basename(writer)));
    } finally { r.cleanup(); }
  });
  it('cleans up worktree when git worktree remove fails directory deletion on Windows', async () => {
    const { r, writer } = await prepared(); try {
      const run = r.deps.run;
      r.deps.run = async (argv, opts) => {
        if (argv[1] === 'worktree' && argv[2] === 'remove') {
          r.git(['worktree', 'remove', '--force', argv[4]!]);
          fs.mkdirSync(argv[4]!, { recursive: true });
          fs.writeFileSync(path.join(argv[4]!, 'unlinked.tmp'), 'held');
          return { exit: 255, stdout: '', stderr: `error: failed to delete '${argv[4]}': Permission denied\n` };
        }
        return run(argv, opts);
      };
      const cleaned = await r.run(['worktree', 'cleanup']); r.deps.run = run;
      assert.equal(cleaned.exit, 0);
      assert.ok(!fs.existsSync(writer));
      assert.ok(JSON.stringify(cleaned.value.removed).includes(path.basename(writer)));
    } finally { r.cleanup(); }
  });
  it('keeps deregistered remnants of unmerged work', async () => {
    await each(['active-writer', 'moved-integration'], async mode => {
      const r = await toolkitRepo(planSource, base); try {
        await r.level(); let dir: string;
        if (mode === 'active-writer') dir = path.join(r.session, (await r.run(['worktree', 'create', 'T1'])).value.path);
        else { const made = await r.run(['worktree', 'create', 'T1']); fs.writeFileSync(path.join(r.session, made.value.path, 'src/file.ts'), 'delivered\n'); await r.run(['worktree', 'submit', 'T1']); await r.run(['worktree', 'integrate', 'T1']); await r.run(['worktree', 'deliver']); fs.writeFileSync(path.join(r.integration, 'src/file.ts'), 'after\n'); assert.equal((await r.run(['worktree', 'commit', '--reason', 'after'])).exit, 0); dir = r.integration; }
        r.git(['worktree', 'remove', '--force', dir]); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'work'), 'kept');
        const cleaned = await r.run(['worktree', 'cleanup']); assert.equal(cleaned.exit, 0); assert.equal(fs.readFileSync(path.join(dir, 'work'), 'utf8'), 'kept'); assert.ok(JSON.stringify(cleaned.value.kept).includes('unpreserved'));
      } finally { r.cleanup(); }
    });
  });
  it('keeps unpreserved bytes in undelivered integration work', async () => {
    await each(['undelivered', 'moved-past-delivery'], async name => {
      const { r } = await prepared(); try {
        if (name === 'moved-past-delivery') { await r.run(['worktree', 'deliver']); fs.writeFileSync(path.join(r.integration, 'src/file.ts'), 'after delivery\n'); assert.equal((await r.run(['worktree', 'commit', '--reason', 'after delivery'])).exit, 0); name = 'ignored'; }
        await r.run(['worktree', 'close', '--reason', 'stop']); fs.writeFileSync(path.join(r.integration, 'ignored'), 'kept\n'); fs.writeFileSync(path.join(r.integration, 'src/file.ts'), 'kept\n');
        const cleaned = await r.run(['worktree', 'cleanup']); assert.equal(cleaned.exit, 0); assert.equal(fs.readFileSync(path.join(r.integration, 'ignored'), 'utf8'), 'kept\n'); assert.ok(JSON.stringify(cleaned.value).includes('unpreserved'));
        assert.ok(r.git(['branch', '--list', 'dispatch/test/integration']));
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
