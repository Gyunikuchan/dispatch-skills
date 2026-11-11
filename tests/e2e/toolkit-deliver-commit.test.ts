import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {describe,it} from 'node:test';
import {toolkitRepo,planSource} from './helpers/toolkit-repo.ts';import {foldLedger} from '../../skills/dispatch/scripts/toolkit/ledger.ts';
type Repo=Awaited<ReturnType<typeof toolkitRepo>>;
type Session=Pick<Repo,'session'|'run'|'level'>;
const rows=(r:Pick<Repo,'session'>,phase:string)=>foldLedger(r.session).records.filter(x=>x.kind==='integrate'&&x.data['phase']===phase);
const base={'keep.txt':'keep\n','del.txt':'del\n','exec.sh':'#!/bin/sh\n','swap-a':'file\n','swap-b/inner.txt':'inner\n'};
const binary=Buffer.from([0,255,254,10,32,32,13,10,32,32]);
const subject='deliver increment';
// Cases use independent repositories, so run them concurrently and name the failing case.
const each=(modes:string[],fn:(mode:string)=>Promise<void>)=>Promise.all(modes.map(mode=>fn(mode).catch((error:unknown)=>{throw Object.assign(new Error(mode+': '+String(error)),{cause:error});})));
async function integrate(r:Repo,files:Record<string,string>={}){
 await r.level();const made=await r.run(['worktree','create','T1']);const writer=path.join(r.session,made.value.path);
 fs.writeFileSync(path.join(writer,'src/file.ts'),'delivered\n');for(const [name,text] of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(writer,name)),{recursive:true});fs.writeFileSync(path.join(writer,name),text);}
 assert.equal((await r.run(['worktree','submit','T1'])).exit,0);assert.equal((await r.run(['worktree','integrate','T1'])).exit,0);}
// Integration fix touching add, edit, delete, mode, binary bytes and both directory/file swaps.
async function change(r:Repo){const w=r.integration;
 fs.writeFileSync(path.join(w,'src/file.ts'),'final\n');fs.mkdirSync(path.join(w,'bin'));fs.writeFileSync(path.join(w,'bin/blob.bin'),binary);fs.rmSync(path.join(w,'del.txt'));
 fs.rmSync(path.join(w,'swap-a'));fs.mkdirSync(path.join(w,'swap-a'));fs.writeFileSync(path.join(w,'swap-a/child'),'child\n');
 fs.rmSync(path.join(w,'swap-b'),{recursive:true});fs.writeFileSync(path.join(w,'swap-b'),'now a file\n');
 r.git(['update-index','--chmod=+x','exec.sh'],w);
 assert.equal((await r.run(['worktree','commit','--reason','final'])).exit,0);return r.git(['rev-parse','HEAD'],w);}
async function delivered(){const r=await toolkitRepo(planSource,base);await integrate(r);const from=r.git(['rev-parse','HEAD']),source=await change(r);
 const done=await r.run(['worktree','deliver']);assert.equal(done.exit,0,JSON.stringify(done));return {r,from,source};}
const message=(r:Pick<Repo,'session'>,text=subject+'\n')=>{const file=path.join(r.session,'message.txt');fs.writeFileSync(file,text);return file;};
const commit=(r:Pick<Session,'session'|'run'>,hook?:Parameters<Repo['run']>[1])=>r.run(['worktree','deliver','--commit',message(r)],hook);
const hook=(r:Repo,name:string,body:string)=>fs.writeFileSync(path.join(r.root,'.git/hooks',name),'#!/bin/sh\n'+body+'\n',{mode:0o755});
const deliveredPaths=(r:Pick<Repo,'git'>,from:string,source:string)=>r.git(['diff','--name-only','--no-renames',from,source]).split('\n').filter(Boolean);
const head=(r:Pick<Repo,'git'>)=>r.git(['rev-parse','HEAD']);
const noCommit=(r:Pick<Repo,'git'>)=>assert.ok(!r.git(['log','--all','--format=%s']).includes(subject),'no commit was made');
const refused=(result:{exit:number;output:{reason:string}},reason:string)=>{assert.equal(result.exit,4,JSON.stringify(result));assert.equal(result.output.reason,reason);};

describe('worktree deliver --commit',()=>{
 it('commits exactly the delivered paths on the caller branch, runs hooks and records the commit',async()=>{
  const {r,from,source}=await delivered();try{
  hook(r,'pre-commit','echo ran > .git/hook-ran');
  fs.writeFileSync(path.join(r.root,'scratch'),'scratch');
  const branch=r.git(['symbolic-ref','--short','HEAD']),result=await commit(r);
  assert.equal(result.exit,0,JSON.stringify(result));
  const made=head(r);
  assert.deepEqual({committed:result.value.committed,recordOnly:result.value.recordOnly,commit:result.value.commit,source:result.value.source,from:result.value.from},{committed:true,recordOnly:false,commit:made,source,from});
  assert.equal(r.git(['rev-parse',made+'^']),from);assert.equal(r.git(['rev-list','--count',from+'..HEAD']),'1');
  assert.equal(r.git(['rev-parse',made+'^{tree}']),r.git(['rev-parse',source+'^{tree}']));
  assert.deepEqual(r.git(['diff-tree','-r','--no-commit-id','--name-only','--no-renames',from,made]).split('\n').sort(),deliveredPaths(r,from,source).sort());
  assert.equal(r.git(['symbolic-ref','--short','HEAD']),branch);assert.equal(r.git(['log','-1','--format=%s']),subject);
  assert.ok(fs.existsSync(path.join(r.root,'.git/hook-ran')));
  assert.equal(r.git(['status','--porcelain','--untracked-files=no']),'');assert.match(r.git(['status','--porcelain']),/\?\? scratch/);
  assert.deepEqual(rows(r,'committed').map(x=>x.data),[{phase:'committed',commit:made,source}]);
  }finally{r.cleanup();}});

 it('refuses without a record or commit when the caller state blocks it',async()=>{
  await each(['not-delivered','other-branch','staged-other','staged-edit','changed-content','head-not-descendant','late-index','late-head','late-branch','failed-hook','uncommitted-after-move'],async mode=>{
   if(mode==='not-delivered'){const r=await toolkitRepo();try{refused(await commit(r),'not-delivered');assert.equal(rows(r,'committed').length,0);}finally{r.cleanup();}return;}
   const {r}=await delivered();try{
   const file=path.join(r.root,'src/file.ts'),from=head(r);
   if(mode==='other-branch')r.git(['switch','-q','-c','other']);
   if(mode==='staged-other'){fs.writeFileSync(path.join(r.root,'keep.txt'),'staged');r.git(['add','keep.txt']);}
   if(mode==='staged-edit'){fs.writeFileSync(file,'different');r.git(['add','src/file.ts']);}
   if(mode==='changed-content')fs.writeFileSync(file,'different');
   if(mode==='head-not-descendant')r.git(['commit','-q','--amend','--allow-empty','-m','rewritten']);
   if(mode==='uncommitted-after-move')r.git(['commit','-q','--allow-empty','-m','moved']);
   if(mode==='failed-hook')hook(r,'pre-commit','echo blocked >&2; exit 1');
   if(mode==='failed-hook')r.git(['add','src/file.ts']);
   const staged=r.git(['write-tree']);
   const result=await commit(r,p=>{if(p!=='deliver:before-commit')return;
    if(mode==='late-index'){fs.writeFileSync(path.join(r.root,'keep.txt'),'late');r.git(['add','keep.txt']);}
    if(mode==='late-head')r.git(['commit','-q','--allow-empty','-m','late']);
    if(mode==='late-branch')r.git(['switch','-q','-c','other']);});
   const reason={'other-branch':'caller-moved','staged-other':'staged-changes','staged-edit':'staged-changes','changed-content':'delivered-content-changed','head-not-descendant':'head-not-descendant','late-index':'staged-changes','late-head':'caller-moved','late-branch':'caller-moved','failed-hook':'commit-failed','uncommitted-after-move':'delivered-uncommitted'}[mode]!;
   refused(result,reason);assert.equal(rows(r,'committed').length,0);noCommit(r);
   if(mode==='failed-hook'){
    assert.equal(head(r),from);assert.equal(r.git(['write-tree']),staged);assert.equal(r.git(['diff','--cached','--name-only']),'src/file.ts');
    fs.rmSync(path.join(r.root,'.git/hooks/pre-commit'));
    const again=await commit(r);assert.equal(again.exit,0,JSON.stringify(again));assert.equal(rows(r,'committed').length,1);
   }
   }finally{r.cleanup();}});
 });

 it('warns and records differing paths when hooks change the commit or edit a delivered file',async()=>{
  await each(['amend','unstaged-edit'],async mode=>{const {r,source}=await delivered();try{
   if(mode==='amend')hook(r,'post-commit','[ -f .git/amended ] && exit 0\necho extra > extra.txt && git add extra.txt && : > .git/amended && git commit -q --amend --no-edit');
   else hook(r,'pre-commit','echo edited >> src/file.ts');
   const result=await commit(r);assert.equal(result.exit,0,JSON.stringify(result));
   const expected=mode==='amend'?'extra.txt':'src/file.ts';
   assert.deepEqual(result.value.differing,[expected]);assert.match(result.value.warning,new RegExp(expected.replace('.','\\.')));
   assert.equal(result.value.commit,head(r));assert.deepEqual(rows(r,'committed')[0]!.data['differing'],[expected]);assert.equal(rows(r,'committed')[0]!.data['source'],source);
  }finally{r.cleanup();}});});

 it('refuses and names the commit when a hook moves the caller to another branch',async()=>{
  const {r}=await delivered();try{
   hook(r,'post-commit','git switch -q -c other');
   const result=await commit(r);refused(result,'caller-moved');
   assert.match(JSON.stringify(result.output),new RegExp(r.git(['rev-parse','other'])));
   assert.equal(rows(r,'committed').length,0);
  }finally{r.cleanup();}});

 it('makes one empty commit for a delivery with no changes',async()=>{
  const r=await toolkitRepo();try{
   await r.level();await r.run(['verify','run']);const from=head(r);r.git(['commit','--allow-empty','-m','internal empty'],r.integration);
   assert.equal((await r.run(['worktree','deliver'])).exit,0);
   const result=await commit(r);assert.equal(result.exit,0,JSON.stringify(result));
   assert.equal(r.git(['rev-list','--count',from+'..HEAD']),'1');assert.equal(r.git(['rev-parse','HEAD^']),from);assert.equal(r.git(['rev-parse','HEAD^{tree}']),r.git(['rev-parse',from+'^{tree}']));
   assert.equal(rows(r,'committed').length,1);
  }finally{r.cleanup();}});

 it('recovers a stop between the commit and its record without a second commit',async()=>{
  const {r,from}=await delivered();try{
   const stopped=await commit(r,p=>{if(p==='deliver:after-commit')throw Error('stop');});assert.equal(stopped.exit,2);
   const made=head(r);assert.notEqual(made,from);assert.equal(rows(r,'committed').length,0);
   const retry=await commit(r);assert.equal(retry.exit,0,JSON.stringify(retry));
   assert.equal(retry.value.recordOnly,true);assert.equal(retry.value.commit,made);assert.equal(head(r),made);assert.equal(r.git(['rev-list','--count',from+'..HEAD']),'1');
   assert.deepEqual(rows(r,'committed').map(x=>x.data['commit']),[made]);
  }finally{r.cleanup();}});

 describe('record-only path',()=>{
  const userCommit=(r:Repo,from:string,source:string)=>{r.git(['add','-A','--',...deliveredPaths(r,from,source)]);r.git(['update-index','--chmod=+x','exec.sh']);r.git(['commit','-q','-m','user commit']);return head(r);};
  it('records the HEAD the user committed without making a commit, and warns only for delivered paths that changed',async()=>{
   await each(['same-content','changed-delivered','later-other-paths'],async mode=>{const {r,from,source}=await delivered();try{
    if(mode==='changed-delivered')fs.writeFileSync(path.join(r.root,'src/file.ts'),'user change\n');
    let made=userCommit(r,from,source);
    if(mode==='later-other-paths'){fs.writeFileSync(path.join(r.root,'keep.txt'),'later\n');r.git(['commit','-q','-am','other paths']);made=head(r);}
    const result=await commit(r);assert.equal(result.exit,0,JSON.stringify(result));
    assert.equal(result.value.recordOnly,true);assert.equal(result.value.commit,made);assert.equal(head(r),made);assert.equal(r.git(['log','--all','--format=%s']).includes(subject),false);
    if(mode==='changed-delivered'){assert.deepEqual(result.value.differing,['src/file.ts']);assert.match(result.value.warning,/src\/file\.ts/);}
    else{assert.equal(result.value.differing,undefined);assert.equal(result.value.warning,undefined);}
    assert.deepEqual(rows(r,'committed').map(x=>x.data['commit']),[made]);
   }finally{r.cleanup();}});});
 });

 it('removes owned worktrees after a committed record and after an interrupted cleanup leaves a remnant',async()=>{
  await each(['plain','remnant'],async mode=>{const {r}=await delivered();try{
   assert.equal((await commit(r)).exit,0);
   if(mode==='remnant'){r.git(['worktree','remove','--force',r.integration]);fs.mkdirSync(r.integration);fs.writeFileSync(path.join(r.integration,'interrupted.tmp'),'left over');}
   const cleaned=await r.run(['worktree','cleanup']);assert.equal(cleaned.exit,0,JSON.stringify(cleaned));
   assert.ok(!fs.existsSync(r.integration));assert.equal(r.git(['branch','--list','dispatch/test/integration']),'');
  }finally{r.cleanup();}});});

 it('returns the recorded identities on a second run and refuses misuse',async()=>{
  const {r}=await delivered();try{
   const first=await commit(r),count=foldLedger(r.session).records.length,made=head(r);
   const again=await commit(r);assert.equal(again.exit,0);assert.deepEqual({committed:again.value.committed,commit:again.value.commit,source:again.value.source},{committed:false,commit:first.value.commit,source:first.value.source});
   assert.equal(foldLedger(r.session).records.length,count);assert.equal(head(r),made);
   const other=await r.run(['worktree','cleanup','--commit',message(r)]);assert.equal(other.exit,1);assert.equal(other.output.reason,'invalid-input');
   for(const text of ['',' \n']){const blank=await r.run(['worktree','deliver','--commit',message(r,text)]);assert.equal(blank.exit,1);assert.equal(blank.output.reason,'invalid-input');}
   const missing=await r.run(['worktree','deliver','--commit',path.join(r.session,'absent.txt')]);assert.equal(missing.exit,1);assert.equal(missing.output.reason,'invalid-input');
   assert.equal(foldLedger(r.session).records.length,count);
  }finally{r.cleanup();}});

 it('commits two increments of one design from two session folders, the second on top of the first',async()=>{
  const plan=planSource.replace('node -e "process.exit(0)"','node -e "require(\'assert\').match(require(\'fs\').readFileSync(\'src/file.ts\',\'utf8\'),/first[^]*second/)"');
  const r=await toolkitRepo(plan);try{
   const start=head(r),stale=await r.second('stale-increment');
   const open=async(s:Session,text:(current:string)=>string)=>{await s.level();const made=await s.run(['worktree','create','T1']);const file=path.join(s.session,made.value.path,'src/file.ts');fs.writeFileSync(file,text(fs.readFileSync(file,'utf8')));assert.equal((await s.run(['worktree','submit','T1'])).exit,0);assert.equal((await s.run(['worktree','integrate','T1'])).exit,0);};
   await open(r,()=>'first\n');await open(stale,current=>current+'second\n');
   assert.equal((await r.run(['worktree','deliver'])).exit,0);
   const first=await commit(r);assert.equal(first.exit,0,JSON.stringify(first));const one=head(r);
   assert.equal(r.git(['rev-parse',one+'^']),start);
   // An increment built without the first one fails its verification.
   assert.equal((await stale.run(['verify','run'])).output.reason,'checks-failed');
   const second=await r.second('next-increment');await open(second,current=>current+'second\n');
   r.git(['merge-base','--is-ancestor',one,'HEAD'],second.integration);
   assert.equal((await second.run(['verify','run'])).output.ok,true);
   assert.equal((await second.run(['worktree','deliver'])).exit,0);
   const next=await commit(second);assert.equal(next.exit,0,JSON.stringify(next));
   assert.equal(r.git(['rev-parse','HEAD^']),one);assert.equal(r.git(['rev-list','--count',start+'..HEAD']),'2');
   assert.equal(fs.readFileSync(path.join(r.root,'src/file.ts'),'utf8'),'first\nsecond\n');
   assert.equal(rows(r,'committed').length,1);assert.equal(rows(second,'committed').length,1);
  }finally{r.cleanup();}});
});
