import { loadPlan, hasTransient, checks } from './plan-view.ts';
import { pruneTransition } from './prune.ts';
import { criterionStatuses } from './evidence.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { HandlerContext, HandlerResult } from './cli.ts';
import { withLedger } from './ledger.ts';
import { git, gitOk, changedPaths, testedTree, headTree } from './git.ts';
import { integrationRecord } from './integration.ts';
import { terminalWorktrees, launches, candidateRef, abandonedRef, deliveredSourceRef } from './writers.ts';
import { pending, reason, result, refuse } from './integrate.ts';
import { ToolError } from './output.ts';

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
    const plan=loadPlan(ctx.session,ctx.manifest);
    const checkSource=async()=>{
      if(loadRejections(ctx.session,tx.fold,applicableReviewIds(ctx.manifest,tx.fold)).some(state=>state.state!=='confirmed'))refuse('review-confirmation-required');
      if(hasTransient(plan)){
        const transition=await pruneTransition(ctx,tx.fold,plan,true);
        const current={headTree:await headTree(ctx.deps,cwd),testedTree:await testedTree(ctx.deps,ctx.session,cwd)};
        if(criterionStatuses(tx.fold,checks(plan),current,transition).some(r=>(transition!.transient.includes(r.criterion)||transition!.final.some(c=>c.criterion==='final:'+r.criterion))&&r.state!=='verified'))refuse('final-checks-required');
      }
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
export async function cleanup(ctx: HandlerContext): Promise<HandlerResult> {
  if(ctx.args.length)throw new ToolError(1,'invalid-input','cleanup takes no task');
  return withLedger(ctx.session,'worktree cleanup',ctx.deps,async tx=>{
    const root=ctx.manifest.repositoryRoot, boundary=path.resolve(ctx.session,'.state/worktrees');
    const physicalBoundary=path.join(fs.realpathSync(ctx.session),'.state/worktrees');
    const registered=(await gitOk(ctx.deps,root,['worktree','list','--porcelain'])).split(/\r?\n\r?\n/).map(block=>block.split(/\r?\n/).find(l=>l.startsWith('worktree '))?.slice(9)).filter((v): v is string=>!!v).map(p=>path.resolve(p));
    const opened=integrationRecord(tx.fold);
    const tasks=[...new Set(tx.fold.records.filter(r=>r.kind==='writer').map(r=>r.data['task'] as string))];
    const writers=tasks.flatMap(t=>launches(tx.fold,t));
    const owned=[...new Set([...writers.map(w=>w.record.data['path'] as string),...(opened?[opened.data['path'] as string]:[])])];
    const observed: Record<string,{head:string}>={},deregistered: string[]=[];
    for(const relative of owned) {
      const cwd=path.resolve(ctx.session,relative),local=path.relative(boundary,cwd);
      if(!local || local.startsWith('..') || path.isAbsolute(local) || !fs.existsSync(cwd))continue;
      const physical=path.relative(physicalBoundary,fs.realpathSync(cwd));
      if(!physical || physical.startsWith('..') || path.isAbsolute(physical))continue;
      if(registered.includes(cwd))observed[relative]={head:await gitOk(ctx.deps,cwd,['rev-parse','HEAD'])};
      else if(!fs.existsSync(path.join(cwd,'.git')))deregistered.push(relative);
    }
    const terminal=new Set(terminalWorktrees(tx.fold,observed));
    const integrated=(w: typeof writers[number])=>!!w.finished && tx.fold.records.some(r=>r.kind==='integrate' && r.seq>w.finished!.seq && r.data['phase']==='done' && r.data['task']===w.record.data['task']);
    const delivered=tx.fold.records.findLast(r=>r.kind==='integrate' && r.data['phase']==='delivered');
    const removed: string[]=[],kept: {path:string;reason:string;paths?:string[]}[]=[],ready: string[]=[];
    // Git cannot report a deregistered directory's state (e.g. after an interrupted removal), so only ledger-merged remnants are removed.
    const remnants=deregistered.filter(relative=>{
      const writer=writers.findLast(w=>w.record.data['path']===relative);
      const merged=writer ? integrated(writer) : !!delivered && !tx.fold.records.some(r=>r.kind==='integrate' && r.seq>delivered.seq && r.data['phase']!=='closed') &&
        terminalWorktrees(tx.fold,{[relative]:{head:delivered.data['source']}}).includes(relative);
      if(!merged)kept.push({path:relative,reason:'unpreserved'});
      return merged;
    });
    for(const cwd of registered) {
      const relative=owned.find(p=>path.resolve(ctx.session,p)===cwd);
      if(!relative || !observed[relative]) {kept.push({path:cwd,reason:'unowned'}); continue;}
      if(!terminal.has(relative)){kept.push({path:relative,reason:'non-terminal'}); continue;}
      const writer=writers.findLast(w=>w.record.data['path']===relative);
      // Merged work already lives in the integration branch or the caller, so its worktree needs no restoration.
      if(writer ? integrated(writer) : !!delivered && observed[relative]!.head===delivered.data['source']) {ready.push(relative); continue;}
      const ignored=(await gitOk(ctx.deps,cwd,['ls-files','--others','--ignored','--exclude-standard','-z'])).split('\0').filter(Boolean);
      let snapshot=observed[relative]!.head;
      if(writer) {
        const preserved=await git(ctx.deps,root,['rev-parse','--verify',abandonedRef(ctx.manifest.safeSessionId,writer.record.data['task'],writer.launch)]);
        snapshot=writer.finished?.data['candidate'] ?? (preserved.exit===0?preserved.stdout.trim():writer.record.data['base'].commit);
      }
      const tree=await testedTree(ctx.deps,ctx.session,cwd),expected=await gitOk(ctx.deps,root,['rev-parse',snapshot+'^{tree}']);
      if(tree!==expected || ignored.length || (await gitOk(ctx.deps,cwd,['diff','--cached','--name-only','--no-renames','-z','HEAD','--'])).length) {
        const differing=(await gitOk(ctx.deps,cwd,['diff','--name-only','--no-renames','-z',expected,tree])).split('\0').filter(Boolean);
        kept.push({path:relative,reason:'unpreserved',paths:[...new Set([...differing,...ignored])]});
      } else ready.push(relative);
    }
    // Preserve all snapshots until every worktree has passed its preservation check.
    for(const relative of remnants){fs.rmSync(path.resolve(ctx.session,relative),{recursive:true,force:true});removed.push(relative);}
    for(const relative of ready){
      const cwd=path.resolve(ctx.session,relative);
      await gitOk(ctx.deps,root,['worktree','remove','--force',cwd]);
      // NOTE: Git for Windows leaves a directory holding a junction (e.g. a linked node_modules); rmSync unlinks junctions without following them.
      fs.rmSync(cwd,{recursive:true,force:true});
      removed.push(relative);
    }
    for(const writer of writers) {
      if(integrated(writer))await gitOk(ctx.deps,root,['update-ref','-d',candidateRef(ctx.manifest.safeSessionId,writer.record.data['task'],writer.launch)]);
    }
    if(opened && (removed.includes(opened.data['path']) || !registered.includes(path.resolve(ctx.session,opened.data['path'])))) {
      const branch=await git(ctx.deps,root,['rev-parse','--verify','--quiet','refs/heads/'+opened.data['branch']]);
      if(delivered && !kept.some(k=>owned.includes(k.path)) && (branch.exit===1 || (branch.exit===0 && branch.stdout.trim()===delivered.data['source']))) {
        if(branch.exit===0)await gitOk(ctx.deps,root,['branch','-D',opened.data['branch']]);
      }
    }
    return result({removed,kept});
  });
}
