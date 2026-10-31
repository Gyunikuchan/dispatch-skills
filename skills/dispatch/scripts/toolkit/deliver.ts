import fs from 'node:fs';
import path from 'node:path';
import type { HandlerContext, HandlerResult, CliDeps } from './cli.ts';
import { withLedger } from './ledger.ts';
import { git, gitOk, changedPaths, testedTree } from './git.ts';
import { integrationRecord } from './integration.ts';
import { terminalWorktrees, launches, candidateRef, abandonedRef, deliveredSourceRef } from './writers.ts';
import { pending, reason, result, refuse } from './integrate.ts';
import { ToolError, capSummary } from './output.ts';

const overlaps=(p:string,q:string)=>p===q||p.startsWith(q+'/')||q.startsWith(p+'/');
const chunks=<T>(items:T[],size=100)=>Array.from({length:Math.ceil(items.length/size)},(_,i)=>items.slice(i*size,(i+1)*size));

import { loadRejections, applicableReviewIds } from './confirmations.ts';
export async function deliver(ctx: HandlerContext): Promise<HandlerResult> {
  if(ctx.args.length)throw new ToolError(1,'invalid-input','deliver takes no task');
  return withLedger(ctx.session,'worktree deliver',ctx.deps,async tx=>{
    const active=pending(tx.fold);if(active)refuse('integration-pending',active.data['task']);
    const opened=integrationRecord(tx.fold);if(!opened)refuse('no-integration');
    const cwd=path.resolve(ctx.session,opened.data['path']),dest=opened.data['dest'] as {path:string;branch:string};
    const read=(root:string,args:string[])=>gitOk(ctx.deps,root,args,{GIT_OPTIONAL_LOCKS:'0'});
    // NOTE: gitOk trims output; NUL-separated path lists need their exact bytes.
    const rawOut=async(root:string,args:string[],env:NodeJS.ProcessEnv={},stdin?:string)=>{
      const out=await ctx.deps.run(['git',...args],{cwd:root,env:{GIT_OPTIONAL_LOCKS:'0',...env},...(stdin!==undefined?{stdin}:{})});
      if(out.exit)throw new ToolError(2,'fault',out.stderr||out.stdout||'Git exited '+out.exit);
      return out.stdout;
    };
    const names=async(root:string,args:string[],env?:NodeJS.ProcessEnv)=>(await rawOut(root,args,env)).split('\0').filter(Boolean);
    const value=<T>(row:PromiseSettledResult<T>):T=>{if(row.status==='rejected')throw row.reason;return row.value;};
    const from=opened.data['base'] as string;
    // Cleanup may have removed the integration worktree after a completed delivery; the retry then relies on recorded identities.
    const integrationPresent=fs.existsSync(cwd);
    const source=integrationPresent?await read(cwd,['rev-parse','HEAD']):undefined;
    const ref=deliveredSourceRef(ctx.manifest.safeSessionId);
    const last=tx.fold.records.findLast(r=>r.kind==='integrate'&&r.data['phase']==='delivered'&&r.data['dest'].path===dest.path&&r.data['dest'].branch===dest.branch);
    const blocked=(message:string):never=>refuse('recovery-blocked',message+'; preserve session refs and worktrees, inspect recovery evidence or start a new run');
    // Recursive raw diff: every delivered path is a leaf entry (blob, symlink or gitlink) or absent.
    const entriesOf=async(root=cwd,target=source!)=>{
      const tokens=(await rawOut(root,['diff','--raw','-z','--no-renames','--no-abbrev',from,target,'--'])).split('\0').filter(Boolean);
      const rows:{path:string;modes:string[]}[]=[];
      for(let i=0;i+1<tokens.length;i+=2){const meta=tokens[i]!.slice(1).split(' ');rows.push({path:tokens[i+1]!,modes:[meta[0]!,meta[1]!]});}
      return rows;
    };
    if(last){
      const recorded=last.data['source'] as string;
      if(source!==undefined&&recorded!==source)blocked('Integration source changed after completed delivery');
      return result({mode:'uncommitted',dest,from:last.data['from'],source:recorded,ref,paths:(await entriesOf(dest.path,recorded)).map(e=>e.path),delivered:false,...(last.data['noop']?{noop:true}:{})});
    }
    if(source===undefined)refuse('no-integration','Integration worktree is missing and no completed delivery is recorded');
    const checkSource=async()=>{
      if(loadRejections(ctx.session,tx.fold,applicableReviewIds(ctx.manifest,tx.fold)).some(state=>state.state!=='confirmed'))refuse('review-confirmation-required');
      const [head,dirty,cached]=await Promise.allSettled([read(cwd,['rev-parse','HEAD']),changedPaths(ctx.deps,cwd,'HEAD'),read(cwd,['diff','--cached','--name-only','--no-renames','-z','HEAD','--'])]);
      if(value(head)!==source)blocked('Integration source changed during delivery');
      if(value(dirty).length||value(cached).length)refuse('integration-dirty');
    };
    await checkSource();
    const noop=(await read(cwd,['rev-parse',source+'^{tree}']))===(await read(cwd,['rev-parse',from+'^{tree}']));
    const entries=await entriesOf(),paths=entries.map(e=>e.path);
    const started=tx.fold.records.findLast(r=>r.kind==='integrate'&&r.data['phase']==='deliver-started'&&r.data['dest'].path===dest.path&&r.data['dest'].branch===dest.branch);
    if(started&&(started.data['source']!==source||started.data['from']!==from))blocked('Unfinished delivery has a different source or caller base');
    const retained=await git(ctx.deps,cwd,['rev-parse','--verify','--quiet',ref],{GIT_OPTIONAL_LOCKS:'0'});
    if(retained.exit===0&&retained.stdout.trim()!==source)blocked('Delivered-source ref points to a different commit');
    const zero='0'.repeat(source.length);

    // SECTION: path state against a tree, judged by Git through a session-owned temporary index
    const tempIndex=(name:string)=>{const file=path.join(ctx.session,'.state',name);fs.mkdirSync(path.dirname(file),{recursive:true});for(const f of [file,file+'.lock'])fs.rmSync(f,{force:true});return file;};
    const equalTo=async(tree:string,subset:string[]):Promise<Set<string>>=>{
      if(!subset.length)return new Set();
      const index=tempIndex('deliver-check-index'),env={GIT_INDEX_FILE:index};
      try{
        await rawOut(dest.path,['read-tree',tree],env);await rawOut(dest.path,['update-index','-q','--refresh'],env);
        const differing=new Set(await names(dest.path,['diff-files','--name-only','-z'],env)),others=await names(dest.path,['ls-files','--others','-z'],env);
        return new Set(subset.filter(p=>!differing.has(p)&&!others.some(o=>o===p||o.startsWith(p+'/'))));
      }finally{for(const f of [index,index+'.lock'])fs.rmSync(f,{force:true});}
    };

    // SECTION: caller guard
    const checkCaller=async(resuming:boolean)=>{
      const observed=await Promise.allSettled([
        git(ctx.deps,dest.path,['symbolic-ref','--quiet','--short','HEAD'],{GIT_OPTIONAL_LOCKS:'0'}),
        read(dest.path,['rev-parse','HEAD']),
        names(dest.path,['diff','--cached','--ita-visible-in-index','--name-only','--no-renames','-z','--']),
        git(ctx.deps,dest.path,['config','--bool','core.sparseCheckout']),
      ]);
      const branch=value(observed[0]);
      if(branch.exit||branch.stdout.trim()!==dest.branch||value(observed[1])!==from)refuse('caller-moved');
      if(value(observed[3]).stdout.trim()==='true')refuse('unsupported-sparse');
      if(entries.some(e=>e.modes.includes('160000')))refuse('unsupported-entry');
      if(value(observed[2]).length)refuse('caller-dirty');
      const dirty=[...new Set([
        ...await names(dest.path,['diff','--name-only','--no-renames','-z','HEAD','--']),
        ...await names(dest.path,['ls-files','--others','--exclude-standard','-z']),
        ...await names(dest.path,['ls-files','--others','--ignored','--exclude-standard','-z']),
      ])].filter(p=>paths.some(q=>overlaps(p,q)));
      if(!dirty.length)return;
      const named=(blocked:string[]):never=>refuse('caller-dirty','Caller paths overlap delivered paths: '+blocked.join(', ')+'; restore with git restore --source='+ref+' -- <path>, or move or discard them');
      if(!resuming)named(dirty);
      // Resuming: an earlier attempt may have written some delivered paths; only exact delivered paths still at `from` or `source` are ours.
      const known=new Set(paths);
      if(dirty.some(p=>!known.has(p)))named(dirty.filter(p=>!known.has(p)));
      const ours=new Set([...await equalTo(from,dirty),...await equalTo(source,dirty)]);
      if(dirty.some(p=>!ours.has(p)))named(dirty.filter(p=>!ours.has(p)));
    };

    // SECTION: apply through Git's two-tree merge so bytes, modes, symlinks, deletions and dir/file swaps are Git's own
    const apply=async()=>{
      if(!paths.length)return;
      const index=tempIndex('deliver-index'),env={GIT_INDEX_FILE:index};
      try{
        await rawOut(dest.path,['read-tree',from],env);
        // Paths a crashed attempt already wrote must enter the merge as `source`, or Git sees them as locally modified.
        const atSource=[...await equalTo(source,paths)];
        if(atSource.length){
          const wanted=new Set(atSource),found=new Map<string,string>();
          for(const part of chunks(atSource))for(const row of (await rawOut(cwd,['ls-tree','-z','-r','--full-tree',source,'--',...part])).split('\0').filter(Boolean)){
            const tab=row.indexOf('\t'),[mode,type,oid]=row.slice(0,tab).split(' '),name=row.slice(tab+1);
            if(wanted.has(name)&&type!=='tree')found.set(name,mode+' '+oid);
          }
          await rawOut(dest.path,['update-index','-z','--index-info'],env,atSource.map(p=>(found.get(p)??'0 '+zero)+'\t'+p+'\0').join(''));
        }
        await rawOut(dest.path,['update-index','-q','--refresh'],env);
        const merged=await git(ctx.deps,dest.path,['read-tree','-m','-u',from,source],{GIT_OPTIONAL_LOCKS:'0',...env});
        if(merged.exit){if(/overwritten|not uptodate|untracked|Entry '/i.test(merged.stderr))refuse('caller-dirty');throw new ToolError(2,'fault',merged.stderr||merged.stdout||'Git read-tree failed');}
      }finally{for(const f of [index,index+'.lock'])fs.rmSync(f,{force:true});}
    };
    const verifyApplied=async()=>{
      const [branch,head,cached]=await Promise.all([git(ctx.deps,dest.path,['symbolic-ref','--quiet','--short','HEAD']),read(dest.path,['rev-parse','HEAD']),names(dest.path,['diff','--cached','--ita-visible-in-index','--name-only','-z','--'])]);
      if(branch.exit||branch.stdout.trim()!==dest.branch||head!==from||cached.length||(await equalTo(source,paths)).size!==paths.length)refuse('caller-dirty');
    };

    // SECTION: delivery sequence
    await checkCaller(!!started);
    if(retained.exit!==0)await gitOk(ctx.deps,cwd,['update-ref',ref,source,zero]);
    await ctx.deps.hook?.('deliver:after-preserve');
    const data={mode:'uncommitted',dest,from,source};
    if(!started)await tx.append({kind:'integrate',by:'tool',data:{phase:'deliver-started',...data}});
    await ctx.deps.hook?.('deliver:after-started');
    await ctx.deps.hook?.('deliver:before-apply');
    await checkSource();await checkCaller(true);
    await apply();
    await ctx.deps.hook?.('deliver:after-apply');
    await checkSource();await verifyApplied();
    await tx.append({kind:'integrate',by:'tool',data:{phase:'delivered',...data,...(noop?{noop:true}:{})}});
    await ctx.deps.hook?.('deliver:after-delivered');
    return result({...data,ref,paths,delivered:true,...(noop?{noop:true}:{})});
  });
}
export async function close(ctx: HandlerContext): Promise<HandlerResult> {
  const why=reason(ctx); if(ctx.args.length)throw new ToolError(1,'invalid-input','close takes no task');
  return withLedger(ctx.session,'worktree close',ctx.deps,async tx=>{
    await tx.append({kind:'integrate',by:'tool',data:{phase:'closed',reason:why}}); return result({closed:true,reason:why});
  });
}
async function rmWorktreeDir(dir: string, deps: CliDeps, attempts = 20, delayMs = 100): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === 'EPERM' || code === 'EBUSY') && i < attempts - 1) {
        await (deps.sleep ? deps.sleep(delayMs) : new Promise(r => setTimeout(r, delayMs)));
        continue;
      }
      throw error;
    }
  }
}
function samePath(a: string, b: string): boolean {
  const left=path.resolve(a).replace(/^\\\\\?\\/,''),right=path.resolve(b).replace(/^\\\\\?\\/,'');
  return process.platform==='win32' ? left.toLowerCase()===right.toLowerCase() : left===right;
}
function recoverySibling(cwd: string): string { return path.join(path.dirname(cwd),'.'+path.basename(cwd)+'.cleanup-recovery'); }
function hasPathEntry(file: string): boolean {
  try { fs.lstatSync(file);return true; }
  catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error; }
}
async function worktreeControl(root: string, cwd: string, deps: CliDeps, linkCwd=cwd, restoreMissing=true): Promise<void> {
  const common=fs.realpathSync(path.resolve(root,await gitOk(deps,root,['rev-parse','--path-format=absolute','--git-common-dir'])));
  const worktrees=path.join(common,'worktrees'),registeredLink=path.join(cwd,'.git'),linkFile=path.join(linkCwd,'.git'),matches:string[]=[];
  for(const entry of fs.readdirSync(worktrees,{withFileTypes:true})) {
    if(!entry.isDirectory())continue;
    try {
      const admin=fs.realpathSync(path.join(worktrees,entry.name));
      const relative=path.relative(worktrees,admin);
      if(!relative||relative.startsWith('..')||path.isAbsolute(relative))continue;
      const commonText=fs.readFileSync(path.join(admin,'commondir'),'utf8').trim();
      if(!samePath(path.resolve(admin,commonText),common))continue;
      const target=fs.readFileSync(path.join(admin,'gitdir'),'utf8').trim();
      if(target&&samePath(path.resolve(admin,target),registeredLink)&&fs.existsSync(path.join(admin,'HEAD')))matches.push(admin);
    } catch { continue; }
  }
  if(matches.length!==1)throw Object.assign(new Error('Git worktree control metadata is missing or ambiguous'),{code:'CONTROL_METADATA_UNVERIFIABLE'});
  const admin=matches[0]!,file=linkFile;
  let link:string|undefined;
  try {
    if(!fs.lstatSync(file).isFile())throw Object.assign(new Error('Git worktree control link is not a regular file'),{code:'CONTROL_METADATA_UNVERIFIABLE'});
    link=fs.readFileSync(file,'utf8');
  } catch(error) {
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  }
  if(link!==undefined) {
    const match=/^gitdir:\s*(.+?)\s*$/m.exec(link);
    if(!match||!samePath(path.resolve(linkCwd,match[1]!),admin))throw Object.assign(new Error('Git worktree control link does not match registered metadata'),{code:'CONTROL_METADATA_UNVERIFIABLE'});
  } else {
    if(!restoreMissing)throw Object.assign(new Error('Recovery directory has no registered Git control link'),{code:'CONTROL_METADATA_UNVERIFIABLE'});
    link='gitdir: '+path.relative(linkCwd,admin).replace(/\\/g,'/')+'\n';
    fs.writeFileSync(file,link,{flag:'wx'});
  }
}
function probeWorktreeMove(cwd: string): void {
  const probe=recoverySibling(cwd);
  if(hasPathEntry(probe))throw Object.assign(new Error('A cleanup recovery path already exists: '+probe),{code:'WORKTREE_RECOVERY_PATH_OCCUPIED',recoveryPath:probe});
  // Keep a failed rename round trip at one deterministic sibling for retry discovery.
  fs.renameSync(cwd,probe);
  try { fs.renameSync(probe,cwd); }
  catch(error) {
    try { fs.renameSync(probe,cwd); }
    catch(restoreError) { throw Object.assign(new Error('Could not restore worktree path after removal preflight; recovery path: '+probe+'; '+String(restoreError)),{code:'WORKTREE_RESTORE_FAILED',recoveryPath:probe}); }
    throw error;
  }
}
export async function cleanup(ctx: HandlerContext): Promise<HandlerResult> {
  if(ctx.args.length)throw new ToolError(1,'invalid-input','cleanup takes no task');
  return withLedger(ctx.session,'worktree cleanup',ctx.deps,async tx=>{
    const root=ctx.manifest.repositoryRoot, boundary=path.resolve(ctx.session,'.state/worktrees');
    const physicalBoundary=path.join(fs.realpathSync(ctx.session),'.state/worktrees');
    const listRegistered=async()=> (await gitOk(ctx.deps,root,['worktree','list','--porcelain'])).split(/\r?\n\r?\n/).map(block=>block.split(/\r?\n/).find(l=>l.startsWith('worktree '))?.slice(9)).filter((v): v is string=>!!v).map(p=>path.resolve(p));
    const registered=await listRegistered(),isRegistered=(paths:string[],cwd:string)=>paths.some(p=>samePath(p,cwd));
    const verifyRecovery=async(cwd:string,recovery:string):Promise<void>=>{
      if(!samePath(recovery,recoverySibling(cwd)))throw Object.assign(new Error('Cleanup recovery path does not match its owned worktree'),{code:'WORKTREE_RECOVERY_UNVERIFIABLE'});
      const stat=fs.lstatSync(recovery);
      if(!stat.isDirectory()||stat.isSymbolicLink())throw Object.assign(new Error('Cleanup recovery path is not a regular directory'),{code:'WORKTREE_RECOVERY_UNVERIFIABLE'});
      const parent=fs.realpathSync(path.dirname(recovery)),parentRelative=path.relative(physicalBoundary,parent);
      if(parentRelative.startsWith('..')||path.isAbsolute(parentRelative))throw Object.assign(new Error('Cleanup recovery parent resolves outside the worktree boundary'),{code:'WORKTREE_RECOVERY_OUTSIDE_BOUNDARY'});
      const real=fs.realpathSync(recovery),physical=path.relative(physicalBoundary,real);
      if(!physical||physical.startsWith('..')||path.isAbsolute(physical))throw Object.assign(new Error('Cleanup recovery path resolves outside the worktree boundary'),{code:'WORKTREE_RECOVERY_OUTSIDE_BOUNDARY'});
      if(!isRegistered(registered,cwd))throw Object.assign(new Error('Git no longer registers the worktree for this recovery path'),{code:'WORKTREE_RECOVERY_UNREGISTERED'});
      await worktreeControl(root,cwd,ctx.deps,recovery,false);
      await gitOk(ctx.deps,recovery,['rev-parse','HEAD']);
    };
    const opened=integrationRecord(tx.fold);
    const tasks=[...new Set(tx.fold.records.filter(r=>r.kind==='writer').map(r=>r.data['task'] as string))];
    const writers=tasks.flatMap(t=>launches(tx.fold,t));
    const owned=[...new Set([...writers.map(w=>w.record.data['path'] as string),...(opened?[opened.data['path'] as string]:[])])];
    const removed: string[]=[],kept: {path:string;reason:string;paths?:string[];code?:string;message?:string;recoveryPath?:string}[]=[],ready: string[]=[],missing: string[]=[],deregistered: string[]=[];
    const failed=new Set<string>();
    const fail=(relative:string,reason:string,error:unknown)=>{
      const row=error&&typeof error==='object'?error as {code?:unknown;exit?:unknown;message?:unknown;stderr?:unknown;stdout?:unknown;recoveryPath?:unknown}:{};
      const code=typeof row.code==='string'&&row.code?row.code:Number.isInteger(row.exit)?'GIT_EXIT_'+row.exit:'CLEANUP_FAILED';
      const detail=[row.message,row.stderr,row.stdout].find(value=>typeof value==='string'&&value.trim()) as string|undefined;
      const recoveryPath=typeof row.recoveryPath==='string'?path.relative(ctx.session,row.recoveryPath).replace(/\\/g,'/'):undefined;
      const message=capSummary('Close processes using this path or fix its permissions, then retry cleanup. '+(detail??String(error))+(recoveryPath?' Recovery path: '+recoveryPath+'.':''));
      kept.push({path:relative,reason,code,message,...(recoveryPath?{recoveryPath}:{})});failed.add(relative);
    };
    const observed: Record<string,{head:string}>={};
    const integrated=(w: typeof writers[number])=>!!w.finished && tx.fold.records.some(r=>r.kind==='integrate' && r.seq>w.finished!.seq && r.data['phase']==='done' && r.data['task']===w.record.data['task']);
    const delivered=tx.fold.records.findLast(r=>r.kind==='integrate' && r.data['phase']==='delivered');
    const finishGone=async(relative:string,cwd:string):Promise<void>=>{
      let removeError:unknown;
      try {
        let current=await listRegistered();
        if(isRegistered(current,cwd)) {
          try {
            const remove=await git(ctx.deps,root,['worktree','remove','--force',cwd]);
            if(remove.exit)removeError={exit:remove.exit,message:remove.stderr||remove.stdout||'Git refused to deregister the removed worktree'};
          } catch(error) { removeError=error; }
        }
        // Prune is global, so it would also delete admin metadata for a stranded recovery worktree.
        if(kept.some(row=>row.recoveryPath)) {
          current=await listRegistered();
          if(isRegistered(current,cwd))fail(relative,'deregister-failed',removeError??Object.assign(new Error('Git still lists the worktree after its path was removed'),{code:'WORKTREE_STILL_REGISTERED'}));
          return;
        }
        const prune=await git(ctx.deps,root,['worktree','prune']);
        if(prune.exit) { fail(relative,'prune-failed',{exit:prune.exit,message:prune.stderr||prune.stdout||'Git worktree prune failed'});return; }
        current=await listRegistered();
        if(isRegistered(current,cwd))fail(relative,'deregister-failed',removeError??Object.assign(new Error('Git still lists the worktree after its path was removed'),{code:'WORKTREE_STILL_REGISTERED'}));
      } catch(error) { fail(relative,'deregister-failed',error); }
    };
    const missingIntegrationIsSafe=async(relative:string):Promise<boolean>=>{
      if(!opened||relative!==opened.data['path']||!delivered||writers.some(w=>!w.abandoned&&!w.superseded&&!w.finished)||writers.some(w=>w.finished&&!integrated(w)))return false;
      let branch:{exit:number;stdout:string;stderr:string};
      try { branch=await git(ctx.deps,root,['rev-parse','--verify','--quiet','refs/heads/'+opened.data['branch']]); }
      catch(error) { fail(relative,'registration-check-failed',error);return false; }
      if(branch.exit===1)return true;
      if(branch.exit===0)return branch.stdout.trim()===delivered.data['source'];
      fail(relative,'registration-check-failed',{exit:branch.exit,message:branch.stderr||branch.stdout||'Could not verify the delivered integration branch'});
      return false;
    };
    for(const relative of owned) {
      const cwd=path.resolve(ctx.session,relative),local=path.relative(boundary,cwd);
      if(!local || local.startsWith('..') || path.isAbsolute(local)) { fail(relative,'containment-unverifiable',Object.assign(new Error('Owned worktree is outside the cleanup boundary'),{code:'WORKTREE_OUTSIDE_BOUNDARY'}));continue; }
      const recovery=recoverySibling(cwd);
      let recoveryExists:boolean;
      try { recoveryExists=hasPathEntry(recovery); }
      catch(error) { fail(relative,'recovery-failed',Object.assign(new Error(String(error)),{code:'WORKTREE_RECOVERY_UNVERIFIABLE',recoveryPath:recovery}));continue; }
      if(recoveryExists) {
        try {
          if(hasPathEntry(cwd))throw Object.assign(new Error('Both the worktree path and its cleanup recovery path exist'),{code:'WORKTREE_RECOVERY_PATH_CONFLICT'});
          await verifyRecovery(cwd,recovery);
          fs.renameSync(recovery,cwd);
        } catch(error) {
          const row=error&&typeof error==='object'?error as {code?:unknown;message?:unknown}:{};
          fail(relative,'recovery-failed',{code:typeof row.code==='string'?row.code:'WORKTREE_RECOVERY_FAILED',message:typeof row.message==='string'?row.message:String(error),recoveryPath:recovery});continue;
        }
      }
      if(!fs.existsSync(cwd))continue;
      let real:string;
      try { real=fs.realpathSync(cwd); }
      catch(error) { fail(relative,'containment-unverifiable',error);continue; }
      const physical=path.relative(physicalBoundary,real);
      if(!physical || physical.startsWith('..') || path.isAbsolute(physical)) { fail(relative,'containment-unverifiable',Object.assign(new Error('Owned worktree resolves outside the cleanup boundary'),{code:'WORKTREE_OUTSIDE_BOUNDARY'}));continue; }
      if(isRegistered(registered,cwd)) {
        try { await worktreeControl(root,cwd,ctx.deps); }
        catch(error) { fail(relative,'control-metadata-unverifiable',error);continue; }
        try { observed[relative]={head:await gitOk(ctx.deps,cwd,['rev-parse','HEAD'])}; }
        catch(error) { fail(relative,'head-check-failed',error);continue; }
      } else if(!fs.existsSync(path.join(cwd,'.git')))deregistered.push(relative);
      else fail(relative,'control-metadata-unverifiable',Object.assign(new Error('Git control link exists but this path is not registered'),{code:'WORKTREE_REGISTRATION_UNVERIFIABLE'}));
    }
    const terminal=new Set(terminalWorktrees(tx.fold,observed));
    // Git cannot report a deregistered directory's state (e.g. after an interrupted removal), so only ledger-merged remnants are removed.
    const remnants=deregistered.filter(relative=>{
      const writer=writers.findLast(w=>w.record.data['path']===relative);
      const merged=writer ? integrated(writer) : !!delivered && !tx.fold.records.some(r=>r.kind==='integrate' && r.seq>delivered.seq && r.data['phase']!=='closed') &&
        terminalWorktrees(tx.fold,{[relative]:{head:delivered.data['source']}}).includes(relative);
      if(!merged)kept.push({path:relative,reason:'unpreserved'});
      return merged;
    });
    for(const cwd of registered) {
      const relative=owned.find(p=>samePath(path.resolve(ctx.session,p),cwd));
      if(!relative) {kept.push({path:cwd,reason:'unowned'}); continue;}
      if(!fs.existsSync(cwd)) {
        if(failed.has(relative))continue;
        if(terminal.has(relative))missing.push(relative);
        else {
          const safe=await missingIntegrationIsSafe(relative);
          if(safe)missing.push(relative);
          else if(!failed.has(relative))kept.push({path:relative,reason:'non-terminal'});
        }
        continue;
      }
      if(!observed[relative]) {if(!failed.has(relative))kept.push({path:relative,reason:'unverified'});continue;}
      if(!terminal.has(relative)){kept.push({path:relative,reason:'non-terminal'}); continue;}
      const writer=writers.findLast(w=>w.record.data['path']===relative);
      // Merged work already lives in the integration branch or the caller, so its worktree needs no restoration.
      if(writer ? integrated(writer) : !!delivered && observed[relative]!.head===delivered.data['source']) {ready.push(relative); continue;}
      try {
        const ignored=(await gitOk(ctx.deps,cwd,['ls-files','--others','--ignored','--exclude-standard','-z'])).split('\0').filter(Boolean);
        let snapshot=observed[relative]!.head;
        if(writer) {
          const preserved=await git(ctx.deps,root,['rev-parse','--verify','--quiet',abandonedRef(ctx.manifest.safeSessionId,writer.record.data['task'],writer.launch)]);
          if(writer.finished)snapshot=writer.finished.data['candidate'] as string;
          else if(preserved.exit===0)snapshot=preserved.stdout.trim();
          else if(preserved.exit===1)snapshot=writer.record.data['base'].commit;
          else throw new ToolError(2,'fault',preserved.stderr||preserved.stdout||'Git exited '+preserved.exit);
        }
        const tree=await testedTree(ctx.deps,ctx.session,cwd),expected=await gitOk(ctx.deps,root,['rev-parse',snapshot+'^{tree}']);
        if(tree!==expected || ignored.length || (await gitOk(ctx.deps,cwd,['diff','--cached','--name-only','--no-renames','-z','HEAD','--'])).length) {
          const differing=(await gitOk(ctx.deps,cwd,['diff','--name-only','--no-renames','-z',expected,tree])).split('\0').filter(Boolean);
          kept.push({path:relative,reason:'unpreserved',paths:[...new Set([...differing,...ignored])]});
        } else ready.push(relative);
      } catch(error) { fail(relative,'preservation-check-failed',error);continue; }
    }
    // Preserve all snapshots until every worktree has passed its preservation check.
    for(const relative of remnants){
      const cwd=path.resolve(ctx.session,relative);
      try {
        await rmWorktreeDir(cwd,ctx.deps);
        if(fs.existsSync(cwd))throw Object.assign(new Error('Worktree path remains after removal'),{code:'WORKTREE_REMAINS'});
        removed.push(relative);
      } catch(error) {
        if(!fs.existsSync(cwd))removed.push(relative);
        else fail(relative,'removal-failed',error);
      }
    }
    for(const relative of missing) {
      const cwd=path.resolve(ctx.session,relative);removed.push(relative);
      await finishGone(relative,cwd);
    }
    for(const relative of ready){
      const cwd=path.resolve(ctx.session,relative);
      const writer=writers.findLast(w=>w.record.data['path']===relative),preservedWriter=!!writer&&!integrated(writer);
      if(preservedWriter) {
        // Keep Git's recovery metadata registered until the preserved directory is gone.
        try {
          if(process.platform==='win32')probeWorktreeMove(cwd);
          await rmWorktreeDir(cwd,ctx.deps);
          if(fs.existsSync(cwd))throw Object.assign(new Error('Worktree path remains after removal'),{code:'WORKTREE_REMAINS'});
        } catch(error) {
          if(fs.existsSync(cwd)) {
            try { if(isRegistered(await listRegistered(),cwd))await worktreeControl(root,cwd,ctx.deps); }
            catch(controlError) { fail(relative,'control-metadata-unverifiable',controlError);continue; }
            fail(relative,'removal-failed',error);continue;
          }
          const recovery=recoverySibling(cwd);
          let recoveryExists:boolean;
          try { recoveryExists=hasPathEntry(recovery); }
          catch(recoveryError) { fail(relative,'recovery-failed',{code:'WORKTREE_RECOVERY_UNVERIFIABLE',message:String(recoveryError),recoveryPath:recovery});continue; }
          if(recoveryExists) {
            try { await verifyRecovery(cwd,recovery); }
            catch(recoveryError) {
              const row=recoveryError&&typeof recoveryError==='object'?recoveryError as {code?:unknown;message?:unknown}:{};
              fail(relative,'recovery-failed',{code:typeof row.code==='string'?row.code:'WORKTREE_RECOVERY_FAILED',message:typeof row.message==='string'?row.message:String(recoveryError),recoveryPath:recovery});continue;
            }
            const row=error&&typeof error==='object'?error as {code?:unknown;message?:unknown}:{};
            fail(relative,'removal-failed',{code:typeof row.code==='string'?row.code:'WORKTREE_RESTORE_FAILED',message:typeof row.message==='string'?row.message:String(error),recoveryPath:recovery});continue;
          }
          fail(relative,'removal-failed',error);continue;
        }
      } else {
        let remove:{exit:number;stdout:string;stderr:string}={exit:0,stdout:'',stderr:''},removeError:unknown;
        try { remove=await git(ctx.deps,root,['worktree','remove','--force',cwd]); }
        catch(error) { removeError=error;remove={exit:1,stdout:'',stderr:String(error)}; }
        let after: string[];
        try { after=await listRegistered(); }
        catch(error) { fail(relative,'registration-check-failed',error);continue; }
        if(isRegistered(after,cwd)&&fs.existsSync(cwd)) {
          try { await worktreeControl(root,cwd,ctx.deps); }
          catch(error) { fail(relative,'control-metadata-unverifiable',error);continue; }
          const reason=remove.exit?'removal-failed':'registration-check-failed';
          fail(relative,reason,removeError??{exit:remove.exit,message:remove.stderr||remove.stdout||'Git still registers the worktree after removal'});continue;
        }
        if(fs.existsSync(cwd)) {
          try { await rmWorktreeDir(cwd,ctx.deps); }
          catch(error) { fail(relative,'removal-failed',error);continue; }
        }
        if(fs.existsSync(cwd)) { fail(relative,'removal-failed',Object.assign(new Error('Worktree path remains after removal'),{code:'WORKTREE_REMAINS'}));continue; }
      }
      removed.push(relative);
      await finishGone(relative,cwd);
    }
    for(const writer of writers) {
      const relative=writer.record.data['path'] as string;
      if(integrated(writer)&&!kept.some(row=>row.path===relative)) {
        try { await gitOk(ctx.deps,root,['update-ref','-d',candidateRef(ctx.manifest.safeSessionId,writer.record.data['task'],writer.launch)]); }
        catch(error) { fail(relative,'ref-release-failed',error); }
      }
    }
    const openedPath=opened&&path.resolve(ctx.session,opened.data['path']);
    if(opened && (removed.includes(opened.data['path']) || !isRegistered(registered,openedPath!))) {
      if(delivered && !kept.some(k=>owned.includes(k.path))) {
        try {
          const branch=await git(ctx.deps,root,['rev-parse','--verify','--quiet','refs/heads/'+opened.data['branch']]);
          if(branch.exit===0&&branch.stdout.trim()===delivered.data['source']) {
            try { await gitOk(ctx.deps,root,['branch','-D',opened.data['branch']]); }
            catch(error) { fail(opened.data['path'],'ref-release-failed',error); }
          } else if(branch.exit!==0&&branch.exit!==1)fail(opened.data['path'],'ref-release-failed',{exit:branch.exit,message:branch.stderr||branch.stdout||'Could not verify the integration branch before cleanup'});
        } catch(error) { fail(opened.data['path'],'ref-release-failed',error); }
      }
    }
    const value={removed,kept};
    return failed.size ? {ok:false,value,exit:2,reason:'cleanup-incomplete',summary:capSummary(JSON.stringify(value))} : result(value);
  });
}
