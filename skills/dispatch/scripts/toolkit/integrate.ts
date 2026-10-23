import type { HandlerContext, HandlerResult } from './cli.ts';
import { withLedger, gate, currentHashes, latest, type Fold, type LedgerTransaction } from './ledger.ts';
import type { LedgerRecord } from './records.ts';
import { git, gitOk, changedPaths } from './git.ts';
import { ensureIntegration } from './integration.ts';
import { launches, isStale, abandonedRef } from './writers.ts';
import { loadPlan, taskSection } from './plan-view.ts';
import { ToolError } from './output.ts';

export const result=(value: unknown): HandlerResult=>({ok:true,value,exit:0,summary:JSON.stringify(value)});
export function refuse(reason: string,message=reason): never {throw new ToolError(4,reason,message);}
export function reason(ctx: HandlerContext): string {
  const value=ctx.values['reason'];
  if(typeof value!=='string'||!value.trim())throw new ToolError(1,'invalid-input','A non-blank --reason is required');
  return value;
}
function task(ctx: HandlerContext): string {
  if(ctx.args.length!==1)throw new ToolError(1,'invalid-input','One task ID is required');
  taskSection(loadPlan(ctx.session,ctx.manifest),ctx.args[0]!);
  return ctx.args[0]!;
}
export function pending(fold: Fold): LedgerRecord | undefined {
  return fold.records.findLast(row=>row.kind==='integrate' && row.data['phase']==='started' && !fold.records.some(end=>end.kind==='integrate' && end.seq>row.seq && end.data['task']===row.data['task'] && (end.data['phase']==='done'||end.data['phase']==='abandoned')));
}
function candidate(fold: Fold,id: string) {
  const launch=launches(fold,id).at(-1);
  if(!launch?.finished)return undefined;
  if(fold.records.some(r=>r.kind==='integrate' && r.seq>launch.finished!.seq && r.data['task']===id && (r.data['phase']==='done'||r.data['phase']==='abandoned')))return undefined;
  return launch;
}
function checkGate(ctx: HandlerContext,fold: Fold) {
  const checked=gate(fold,currentHashes(ctx.manifest.repositoryRoot,latest(fold,'bind')));
  if(!checked.allowed)refuse(checked.reason!,JSON.stringify(checked));
}
async function cherryHead(ctx: HandlerContext,cwd: string): Promise<string | undefined> {
  const picked=await git(ctx.deps,cwd,['rev-parse','--verify','CHERRY_PICK_HEAD']);
  return picked.exit===0 ? picked.stdout.trim():undefined;
}
export async function pickedCommit(ctx: HandlerContext,cwd: string,hash: string): Promise<string | undefined> {
  const head=await gitOk(ctx.deps,cwd,['rev-parse','HEAD']);
  const message=await gitOk(ctx.deps,cwd,['log','-1','--format=%B']);
  if(message.includes('(cherry picked from commit '+hash+')'))return head;
  const patchId=async(commit: string)=>{
    const patch=await gitOk(ctx.deps,cwd,['show','--format=','--no-ext-diff',commit]);
    const value=await ctx.deps.run(['git','patch-id','--stable'],{cwd,stdin:patch+'\n'});
    if(value.exit)throw new ToolError(2,'fault',value.stderr);
    return value.stdout.split(/\s/)[0];
  };
  const expected=await patchId(hash);
  return expected && expected===await patchId(head) ? head:undefined;
}
async function done(tx: LedgerTransaction,id: string,commit: string) {
  await tx.append({kind:'integrate',by:'tool',data:{phase:'done',task:id,commit}});
  return result({task:id,commit});
}
async function conflicts(ctx: HandlerContext,tx: LedgerTransaction,cwd: string,id: string): Promise<HandlerResult> {
  const paths=(await gitOk(ctx.deps,cwd,['diff','--name-only','--diff-filter=U','-z'])).split('\0').filter(Boolean);
  await tx.append({kind:'integrate',by:'tool',data:{phase:'conflict',task:id,paths}});
  return {ok:false,exit:0,reason:'conflict',summary:JSON.stringify({task:id,paths}),value:{task:id,paths,reason:'conflict'}};
}
export async function integrate(ctx: HandlerContext): Promise<HandlerResult> {
  const id=task(ctx);
  return withLedger(ctx.session,'worktree integrate',ctx.deps,async tx=>{
    checkGate(ctx,tx.fold);
    const active=pending(tx.fold);
    if(active && active.data['task']!==id)refuse('integration-pending',active.data['task']);
    const launch=candidate(tx.fold,id); if(!launch)refuse('no-candidate');
    const hash=launch.finished!.data['candidate'] as string;
    const integration=await ensureIntegration(tx,ctx), cwd=integration.path;
    const cherry=await cherryHead(ctx,cwd);
    if(active && cherry===hash)return conflicts(ctx,tx,cwd,id);
    if(cherry)refuse('integration-dirty');
    if(active) {const commit=await pickedCommit(ctx,cwd,hash); if(commit)return done(tx,id,commit);}
    if((await changedPaths(ctx.deps,cwd,'HEAD')).length)refuse('integration-dirty');
    if(isStale(tx.fold,launch.record,taskSection(loadPlan(ctx.session,ctx.manifest),id))) {
      const ack=ctx.values['ack-stale']; if(typeof ack!=='string'||!ack.trim())refuse('stale-candidate');
      await tx.append({kind:'ruling',by:'orchestrator',key:'ack-stale:'+hash,data:{subject:'stale-candidate '+id+' '+hash,ruling:'accept',rationale:ack}});
    }
    if(!active)await tx.append({kind:'integrate',by:'tool',key:'integrate-started:'+id+':'+launch.launch+':'+hash,data:{phase:'started',task:id,candidate:hash}});
    const picked=await git(ctx.deps,cwd,['cherry-pick','-x',hash]);
    if(picked.exit) {
      const paths=await gitOk(ctx.deps,cwd,['diff','--name-only','--diff-filter=U']);
      if(paths)return conflicts(ctx,tx,cwd,id);
      throw new ToolError(2,'fault',picked.stderr||picked.stdout);
    }
    await ctx.deps.hook?.('integrate:after-pick');
    return done(tx,id,await gitOk(ctx.deps,cwd,['rev-parse','HEAD']));
  });
}
export async function continueIntegration(ctx: HandlerContext): Promise<HandlerResult> {
  const id=task(ctx);
  return withLedger(ctx.session,'worktree continue',ctx.deps,async tx=>{
    checkGate(ctx,tx.fold);
    const active=pending(tx.fold);
    const integration=await ensureIntegration(tx,ctx), cwd=integration.path;
    const cherry=await cherryHead(ctx,cwd);
    if(cherry && active?.data['task']!==id)refuse('wrong-task');
    if(!active || active.data['task']!==id)refuse('no-pending-integration');
    const hash=active.data['candidate'] as string;
    if(cherry) {
      if(cherry!==hash)refuse('wrong-task');
      if(await gitOk(ctx.deps,cwd,['diff','--name-only','--diff-filter=U']))refuse('unresolved-conflict');
      await gitOk(ctx.deps,cwd,['add','-A']);
      await gitOk(ctx.deps,cwd,['-c','core.editor=true','cherry-pick','--continue'],{GIT_EDITOR:'true'});
      await ctx.deps.hook?.('continue:after-commit');
      return done(tx,id,await gitOk(ctx.deps,cwd,['rev-parse','HEAD']));
    }
    const commit=await pickedCommit(ctx,cwd,hash); if(commit)return done(tx,id,commit);
    return refuse('no-pending-integration');
  });
}
export async function commit(ctx: HandlerContext): Promise<HandlerResult> {
  const why=reason(ctx); if(ctx.args.length)throw new ToolError(1,'invalid-input','commit takes no task');
  return withLedger(ctx.session,'worktree commit',ctx.deps,async tx=>{
    const active=pending(tx.fold); if(active)refuse('integration-pending',active.data['task']);
    const integration=await ensureIntegration(tx,ctx),cwd=integration.path;
    let hash=await gitOk(ctx.deps,cwd,['rev-parse','HEAD']);
    if((await changedPaths(ctx.deps,cwd,'HEAD')).length) {
      await gitOk(ctx.deps,cwd,['add','-A']); await gitOk(ctx.deps,cwd,['commit','-m','dispatch fix: '+why,'-m','Dispatch-Fix: '+ctx.manifest.safeSessionId]);
      await ctx.deps.hook?.('commit:after-commit'); hash=await gitOk(ctx.deps,cwd,['rev-parse','HEAD']);
    } else {
      const message=await gitOk(ctx.deps,cwd,['log','-1','--format=%B']);
      if(message.split('\n')[0]!=='dispatch fix: '+why || !message.split('\n').includes('Dispatch-Fix: '+ctx.manifest.safeSessionId) || tx.fold.records.some(r=>r.kind==='integrate' && r.data['phase']==='fix' && r.data['commit']===hash))refuse('no-changes');
    }
    await tx.append({kind:'integrate',by:'tool',data:{phase:'fix',commit:hash,reason:why}}); return result({commit:hash,reason:why});
  });
}
export async function abort(ctx: HandlerContext): Promise<HandlerResult> {
  const id=task(ctx),why=reason(ctx);
  return withLedger(ctx.session,'worktree abort',ctx.deps,async tx=>{
    const active=pending(tx.fold),launch=candidate(tx.fold,id);
    const integration=await ensureIntegration(tx,ctx),cwd=integration.path;
    const cherry=await cherryHead(ctx,cwd);
    if(cherry && active?.data['task']!==id)refuse('wrong-task');
    if(!launch)refuse('no-candidate');
    const hash=launch.finished!.data['candidate'] as string;
    if(cherry && cherry!==hash)refuse('wrong-task');
    if(!cherry && active?.data['task']===id) {
      const picked=await pickedCommit(ctx,cwd,hash);
      if(picked){await done(tx,id,picked); refuse('already-integrated');}
    }
    if(cherry)await gitOk(ctx.deps,cwd,['cherry-pick','--abort']);
    await gitOk(ctx.deps,cwd,['update-ref',abandonedRef(ctx.manifest.safeSessionId,id,launch.launch),hash]);
    await tx.append({kind:'integrate',by:'tool',key:'integrate-abandoned:'+id+':'+launch.launch+':'+hash,data:{phase:'abandoned',task:id,candidate:hash,reason:why}});
    return result({task:id,candidate:hash,abandoned:true});
  });
}
