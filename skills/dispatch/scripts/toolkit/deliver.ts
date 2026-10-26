import { loadPlan, hasTransient, checks } from './plan-view.ts';
import { pruneTransition } from './prune.ts';
import { criterionStatuses } from './evidence.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { HandlerContext, HandlerResult } from './cli.ts';
import { withLedger } from './ledger.ts';
import { git, gitOk, changedPaths, testedTree, headTree } from './git.ts';
import { integrationRecord } from './integration.ts';
import { terminalWorktrees, launches, candidateRef, abandonedRef, preparedDeliveryRef } from './writers.ts';
import { pending, reason, result, refuse } from './integrate.ts';
import { ToolError } from './output.ts';

export async function deliver(ctx: HandlerContext): Promise<HandlerResult> {
  if(ctx.args.length)throw new ToolError(1,'invalid-input','deliver takes no task');
  return withLedger(ctx.session,'worktree deliver',ctx.deps,async tx=>{
    const active=pending(tx.fold);if(active)refuse('integration-pending',active.data['task']);
    const opened=integrationRecord(tx.fold);if(!opened)refuse('no-integration');
    const cwd=path.resolve(ctx.session,opened.data['path']),dest=opened.data['dest'] as {path:string;branch:string};
    const read=(root:string,args:string[])=>gitOk(ctx.deps,root,args,{GIT_OPTIONAL_LOCKS:'0'});
    const value=<T>(row:PromiseSettledResult<T>):T=>{if(row.status==='rejected')throw row.reason;return row.value;};
    const source=await read(cwd,['rev-parse','HEAD']),from=opened.data['base'] as string;
    const last=tx.fold.records.findLast(r=>r.kind==='integrate'&&r.data['phase']==='delivered'&&r.data['dest'].path===dest.path&&r.data['dest'].branch===dest.branch);
    const blocked=(message:string):never=>refuse('recovery-blocked',message+'; preserve session refs and worktrees, inspect recovery evidence or start a new run');
    if(last){if((last.data['source']??last.data['to'])!==source)blocked('Integration source changed after completed delivery');return result({from:last.data['from']??from,to:last.data['to'],source:last.data['source']??last.data['to'],mode:last.data['mode']??'legacy',delivered:false,noop:last.data['to']===(last.data['from']??from)});}
    const plan=loadPlan(ctx.session,ctx.manifest);
    const checkSource=async()=>{
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
    const tree=await read(cwd,['rev-parse',source+'^{tree}']),baseTree=await read(cwd,['rev-parse',from+'^{tree}']);
    const noop=tree===baseTree,ref=preparedDeliveryRef(ctx.manifest.safeSessionId);
    const started=tx.fold.records.findLast(r=>r.kind==='integrate'&&r.data['phase']==='deliver-started'&&r.data['dest'].path===dest.path&&r.data['dest'].branch===dest.branch);
    if(started&&(started.data['mode']!=='squash'||started.data['source']!==source||started.data['from']!==from))blocked('Unfinished delivery has a different source or legacy format');
    const retained=await git(ctx.deps,cwd,['rev-parse','--verify',ref],{GIT_OPTIONAL_LOCKS:'0'});
    const retainedTo=retained.exit===0?retained.stdout.trim():null;
    if(started&&retainedTo&&started.data['to']!==retainedTo)blocked('Prepared ref disagrees with deliver-started.to');
    let to=(started?.data['to']??retainedTo??(noop?from:null)) as string|null;
    if(noop&&retainedTo)blocked('Unexpected prepared ref for same-tree delivery');
    const validatePrepared=async(commit:string)=>{
      if(noop){if(commit!==from)blocked('Invalid same-tree delivery identity');return;}
      const inspected=await git(ctx.deps,cwd,['show','-s','--format=%P%n%T%n%B',commit],{GIT_OPTIONAL_LOCKS:'0'});
      if(inspected.exit)blocked('Prepared commit is missing');
      const [parents,preparedTree,...message]=inspected.stdout.trim().split(/\r?\n/);
      const trailers=message.filter(line=>line.startsWith('Dispatch-Source:'));
      if(parents!==from||preparedTree!==tree||trailers.length!==1||trailers[0]!=='Dispatch-Source: '+source)blocked('Prepared commit parent, tree or source trailer does not match');
    };
    if(to)await validatePrepared(to);
    const paths=(await read(cwd,['diff','--name-only','--no-renames','-z',from,source,'--'])).split('\0').filter(Boolean);
    const checkCaller=async(expected:string)=>{
      const observed=await Promise.allSettled([
        git(ctx.deps,dest.path,['symbolic-ref','--quiet','--short','HEAD'],{GIT_OPTIONAL_LOCKS:'0'}),
        read(dest.path,['rev-parse','HEAD']),
        git(ctx.deps,dest.path,['diff','--quiet','HEAD','--'],{GIT_OPTIONAL_LOCKS:'0'}),
        git(ctx.deps,dest.path,['diff','--cached','--quiet','--'],{GIT_OPTIONAL_LOCKS:'0'}),
        read(dest.path,['ls-files','--others','--exclude-standard','-z']),
        read(dest.path,['ls-files','--others','--ignored','--exclude-standard','-z']),
      ]);
      const branch=value(observed[0]);
      if(branch.exit||branch.stdout.trim()!==dest.branch||value(observed[1])!==expected)refuse('caller-moved');
      for(const row of [observed[2],observed[3]]){
        const clean=value(row);if(clean.exit===1)refuse('caller-dirty');if(clean.exit)throw new ToolError(2,'fault',clean.stderr||clean.stdout||'Git cleanliness check failed');
      }
      const scratch=[...value(observed[4]).split('\0'),...value(observed[5]).split('\0')].filter(Boolean);
      if(scratch.some(p=>paths.some(q=>p===q||p.startsWith(q+'/')||q.startsWith(p+'/'))))refuse('caller-dirty');
    };
    const current=await read(dest.path,['rev-parse','HEAD']);
    const advanced=!!started&&to!==null&&current===to;
    await checkCaller(advanced?to!:from);
    if(!to){to=await gitOk(ctx.deps,cwd,['commit-tree',tree,'-p',from,'-m','Dispatch delivery\n\nDispatch-Source: '+source]);await ctx.deps.hook?.('deliver:after-commit');}
    if(!noop&&!retainedTo)await gitOk(ctx.deps,cwd,['update-ref',ref,to,'0'.repeat(to.length)]);
    await ctx.deps.hook?.('deliver:after-preserve');
    const data={mode:'squash',dest,from,to,source};
    if(!started)await tx.append({kind:'integrate',by:'tool',data:{phase:'deliver-started',...data}});
    await ctx.deps.hook?.('deliver:after-started');
    if(!advanced){
      await ctx.deps.hook?.('deliver:before-ff');
      await checkSource();await checkCaller(from);
      if(!noop){const merged=await git(ctx.deps,dest.path,['merge','--ff-only','--no-overwrite-ignore',to]);if(merged.exit){if(/local changes.*overwritten|untracked working tree files.*overwritten|would be overwritten/is.test(merged.stderr))refuse('caller-dirty');throw new ToolError(2,'fault',merged.stderr||merged.stdout||'Git fast-forward failed');}}
      await ctx.deps.hook?.('deliver:after-ff');
    }
    await checkSource();await checkCaller(to);
    await tx.append({kind:'integrate',by:'tool',data:{phase:'delivered',...data}});
    await ctx.deps.hook?.('deliver:after-delivered');
    return result({...data,delivered:true,...(noop?{noop:true}:{})});
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
    const observed: Record<string,{head:string}>={};
    for(const relative of owned) {
      const cwd=path.resolve(ctx.session,relative),local=path.relative(boundary,cwd);
      if(!local || local.startsWith('..') || path.isAbsolute(local) || !registered.includes(cwd) || !fs.existsSync(cwd))continue;
      const physical=path.relative(physicalBoundary,fs.realpathSync(cwd));
      if(physical && !physical.startsWith('..') && !path.isAbsolute(physical))observed[relative]={head:await gitOk(ctx.deps,cwd,['rev-parse','HEAD'])};
    }
    const terminal=new Set(terminalWorktrees(tx.fold,observed));
    const removed: string[]=[],kept: {path:string;reason:string;paths?:string[]}[]=[],ready: string[]=[];
    for(const cwd of registered) {
      const relative=owned.find(p=>path.resolve(ctx.session,p)===cwd);
      if(!relative || !observed[relative]) {kept.push({path:cwd,reason:'unowned'}); continue;}
      if(!terminal.has(relative)){kept.push({path:relative,reason:'non-terminal'}); continue;}
      const ignored=(await gitOk(ctx.deps,cwd,['ls-files','--others','--ignored','--exclude-standard','-z'])).split('\0').filter(Boolean);
      const writer=writers.findLast(w=>w.record.data['path']===relative);
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
    for(const relative of ready){await gitOk(ctx.deps,root,['worktree','remove','--force',path.resolve(ctx.session,relative)]);removed.push(relative);}
    for(const writer of writers) {
      if(writer.finished && tx.fold.records.some(r=>r.kind==='integrate' && r.seq>writer.finished!.seq && r.data['phase']==='done' && r.data['task']===writer.record.data['task']))await gitOk(ctx.deps,root,['update-ref','-d',candidateRef(ctx.manifest.safeSessionId,writer.record.data['task'],writer.launch)]);
    }
    if(opened && (removed.includes(opened.data['path']) || !registered.includes(path.resolve(ctx.session,opened.data['path'])))) {
      const last=tx.fold.records.findLast(r=>r.kind==='integrate' && r.data['phase']==='delivered');
      const branch=await git(ctx.deps,root,['rev-parse','--verify','--quiet','refs/heads/'+opened.data['branch']]);
      if(last && !kept.some(k=>owned.includes(k.path)) && (branch.exit===1 || (branch.exit===0 && branch.stdout.trim()===(last.data['source']??last.data['to'])))) {
        if(branch.exit===0)await gitOk(ctx.deps,root,['branch','-D',opened.data['branch']]);
        await gitOk(ctx.deps,root,['update-ref','-d',preparedDeliveryRef(ctx.manifest.safeSessionId)]);
      }
    }
    return result({removed,kept});
  });
}
