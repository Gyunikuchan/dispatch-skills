import fs from 'node:fs';
import path from 'node:path';
import type { HandlerContext, HandlerResult } from './cli.ts';
import { withLedger } from './ledger.ts';
import { git, gitOk, changedPaths, testedTree } from './git.ts';
import { integrationRecord } from './integration.ts';
import { terminalWorktrees, launches, candidateRef, abandonedRef } from './writers.ts';
import { pending, reason, result, refuse } from './integrate.ts';
import { ToolError } from './output.ts';

export async function deliver(ctx: HandlerContext): Promise<HandlerResult> {
  if(ctx.args.length)throw new ToolError(1,'invalid-input','deliver takes no task');
  return withLedger(ctx.session,'worktree deliver',ctx.deps,async tx=>{
    const active=pending(tx.fold); if(active)refuse('integration-pending',active.data['task']);
    const opened=integrationRecord(tx.fold); if(!opened)refuse('no-integration');
    const cwd=path.resolve(ctx.session,opened.data['path']),dest=opened.data['dest'] as {path:string;branch:string};
    const to=await gitOk(ctx.deps,cwd,['rev-parse','HEAD']);
    const last=tx.fold.records.findLast(r=>r.kind==='integrate' && r.data['phase']==='delivered' && r.data['dest'].path===dest.path && r.data['dest'].branch===dest.branch);
    const from=(last?.data['to'] ?? opened.data['base']) as string;
    const check=async(expected: string, paths: readonly string[])=>{
      const branch=await git(ctx.deps,dest.path,['symbolic-ref','--quiet','--short','HEAD']);
      if(branch.exit || branch.stdout.trim()!==dest.branch || await gitOk(ctx.deps,dest.path,['rev-parse','HEAD'])!==expected)refuse('caller-moved');
      const dirty=await changedPaths(ctx.deps,dest.path,'HEAD');
      if(dirty.some(p=>paths.some(delivery=>p===delivery || p.startsWith(delivery+'/') || delivery.startsWith(p+'/'))))refuse('caller-dirty');
    };
    if(to===from) {
      if(last)return result({from,to,delivered:false});
      if((await changedPaths(ctx.deps,cwd,'HEAD')).length)refuse('integration-dirty');
      await check(to,[]);
      await tx.append({kind:'integrate',by:'tool',data:{phase:'delivered',dest,to}});
      return result({from,to,delivered:true,noop:true});
    }
    if((await changedPaths(ctx.deps,cwd,'HEAD')).length)refuse('integration-dirty');
    const paths=(await gitOk(ctx.deps,cwd,['diff','--name-only','--no-renames','-z',from,to])).split('\0').filter(Boolean);
    const current=await gitOk(ctx.deps,dest.path,['rev-parse','HEAD']);
    const started=tx.fold.records.findLast(r=>r.kind==='integrate' && r.data['phase']==='deliver-started' && r.data['from']===from && r.data['to']===to && r.data['dest'].path===dest.path && r.data['dest'].branch===dest.branch);
    if(current===to && started)await check(to,paths);
    else {
      await check(from,paths);
      await tx.append({kind:'integrate',by:'tool',data:{phase:'deliver-started',dest,from,to}});
      await ctx.deps.hook?.('deliver:before-ff');
      const merged=await git(ctx.deps,dest.path,['merge','--ff-only',to]);
      if(merged.exit) {
        if(/local changes.*overwritten|untracked working tree files.*overwritten|would be overwritten/is.test(merged.stderr))refuse('caller-dirty');
        throw new ToolError(2,'fault',merged.stderr||merged.stdout);
      }
      await ctx.deps.hook?.('deliver:after-ff');
      await check(to,paths);
    }
    await tx.append({kind:'integrate',by:'tool',data:{phase:'delivered',dest,to}});
    return result({from,to,delivered:true});
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
      if(tree!==expected || ignored.length) {
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
      const branch=await git(ctx.deps,root,['rev-parse','--verify','refs/heads/'+opened.data['branch']]);
      if(last && branch.exit===0 && branch.stdout.trim()===last.data['to'])await gitOk(ctx.deps,root,['branch','-D',opened.data['branch']]);
    }
    return result({removed,kept});
  });
}
