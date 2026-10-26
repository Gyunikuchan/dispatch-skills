import fs from 'node:fs';
import path from 'node:path';
import type { HandlerContext, HandlerResult } from './cli.ts';
import { withLedger, type Fold } from './ledger.ts';
import type { LedgerRecord } from './records.ts';
import { gitOk, changedPaths, testedTree, headTree } from './git.ts';
import { ensureIntegration, integrationRecord } from './integration.ts';
import { loadPlan, ownedPaths, taskSection } from './plan-view.ts';
import { ToolError } from './output.ts';

export type Launch = { launch: number; record: LedgerRecord; finished?: LedgerRecord; abandoned?: LedgerRecord; superseded: boolean };
export function launches(fold: Fold, task: string): Launch[] {
  const rows: Launch[]=[];
  for(const record of fold.records) {
    if(record.kind!=='writer' || record.data['task']!==task) continue;
    if(record.data['phase']==='launched') {
      const previous=rows.at(-1);
      if(previous && !previous.finished && !previous.abandoned) previous.superseded=true;
      rows.push({launch:rows.length+1,record,superseded:false});
    } else {
      const launch=rows.find(r=>r.launch===record.data['launch']);
      if(launch && record.data['phase']==='finished') launch.finished=record;
      if(launch && record.data['phase']==='abandoned') launch.abandoned=record;
    }
  }
  return rows;
}
export function isStale(fold: Fold, launch: LedgerRecord, currentTaskSection: string): boolean {
  return launch.data['base'].taskSection!==currentTaskSection || fold.records.some(r=>r.kind==='edit' && r.seq>launch.data['base'].seq && r.data['affects'].includes(launch.data['task']));
}
const open = (launch: Launch | undefined): launch is Launch => !!launch && !launch.finished && !launch.abandoned && !launch.superseded;
function completion(fold: Fold, launch: Launch) {
  return launch.finished && fold.records.findLast(r=>r.kind==='integrate' && r.seq>launch.finished!.seq && r.data['task']===launch.record.data['task'] && (r.data['phase']==='done' || (r.data['phase']==='abandoned' && r.data['candidate']===launch.finished!.data['candidate'])));
}
export type Observation = {exists: boolean; dirty: boolean; head: string};
export function writerStates(fold: Fold, tasks: string[], observe: (path: string)=>Observation) {
  return tasks.flatMap(task=>{
    const rows=launches(fold,task);
    if(!rows.length) return [{task,state:'unlaunched',liveness:'unknown'}];
    return rows.map(launch=>{
      const {record,finished}=launch;
      const done=completion(fold,launch);
      let state: string;
      if(launch.abandoned || launch.superseded) state='launch-abandoned';
      else if(done) state=done.data['phase']==='done' ? 'integrated' : 'integration-abandoned';
      else if(finished) state='candidate-unintegrated';
      else {
        const observed=observe(record.data['path']);
        state=!observed.exists ? 'missing-worktree' : observed.dirty || observed.head!==record.data['base'].commit ? 'ready-to-submit' : 'no-progress';
      }
      return {task,state,path:record.data['path'] as string,launch:launch.launch,...(finished ? {candidate:finished.data['candidate'] as string} : {}),liveness:'unknown'};
    });
  });
}
export function terminalWorktrees(fold: Fold, observed: Record<string,{head: string}>): string[] {
  const tasks=[...new Set(fold.records.filter(r=>r.kind==='writer').map(r=>r.data['task'] as string))];
  const all=tasks.flatMap(task=>launches(fold,task));
  const paths=[...new Set(all.map(r=>r.record.data['path'] as string))];
  const terminal=paths.filter(p=>{
    const launch=all.findLast(r=>r.record.data['path']===p)!;
    return !!launch.abandoned || !!completion(fold,launch);
  });
  const integration=integrationRecord(fold);
  const delivered=fold.records.findLast(r=>r.kind==='integrate' && r.data['phase']==='delivered');
  const closed=fold.records.some(r=>r.kind==='integrate' && r.data['phase']==='closed' && r.seq>(integration?.seq ?? 0));
  if(integration && (closed || (!all.some(open) && !all.some(r=>r.finished && !completion(fold,r)) && delivered && observed[integration.data['path']]?.head===(delivered.data['source']??delivered.data['to'])))) terminal.push(integration.data['path']);
  return terminal;
}
function taskId(ctx: HandlerContext) {
  if(ctx.args.length!==1) throw new ToolError(1,'invalid-input','One task ID is required');
  const id=ctx.args[0]!;
  const plan=loadPlan(ctx.session,ctx.manifest);
  const paths=ownedPaths(plan,id);
  return {id,paths,section:taskSection(plan,id)};
}
const result = (value: unknown): HandlerResult => ({ok:true,value,exit:0,summary:JSON.stringify(value)});
function refuse(reason: string, message=reason): never { throw new ToolError(4,reason,message); }
export const candidateRef = (sid: string, task: string, launch: number) => 'refs/dispatch/'+sid+'/candidates/'+task+'-'+launch;
export const abandonedRef = (sid: string, task: string, launch: number) => 'refs/dispatch/'+sid+'/abandoned/'+task+'-'+launch;
export const deliveredSourceRef=(session:string)=>'refs/dispatch/'+session+'/delivered-source';
// Squash delivery (earlier format) retained its prepared commit here; cleanup still removes it.
export const legacyPreparedRef=(session:string)=>'refs/dispatch/'+session+'/delivery-prepared';
export async function create(ctx: HandlerContext): Promise<HandlerResult> {
  const {id,section}=taskId(ctx);
  return withLedger(ctx.session,'worktree create',ctx.deps,async tx=>{
    const rows=launches(tx.fold,id); const previous=rows.at(-1);
    if(ctx.values['relaunch']) {
      if(!open(previous)) refuse('no-open-launch');
      const cwd=path.resolve(ctx.session,previous.record.data['path']);
      if(!fs.existsSync(cwd)) refuse('missing-worktree');
      if(await gitOk(ctx.deps,cwd,['rev-parse','HEAD'])!==previous.record.data['base'].commit) refuse('submit-pending');
      await tx.append({kind:'writer',by:'tool',data:{phase:'launched',task:id,path:previous.record.data['path'],base:{...previous.record.data['base'],taskSection:section,seq:tx.fold.lastSeq}}});
      return result({task:id,launch:rows.length+1,path:previous.record.data['path'],relaunch:true});
    }
    const integration=await ensureIntegration(tx,ctx);
    if(previous?.finished && !completion(tx.fold,previous)) refuse('candidate-pending');
    if(open(previous)) {
      const cwd=path.resolve(ctx.session,previous.record.data['path']);
      if(fs.existsSync(cwd)) refuse('writer-open');
      await gitOk(ctx.deps,ctx.manifest.repositoryRoot,['worktree','prune']);
      await gitOk(ctx.deps,ctx.manifest.repositoryRoot,['worktree','add','--detach',cwd,previous.record.data['base'].commit]);
      return result({task:id,launch:previous.launch,path:previous.record.data['path'],restored:true});
    }
    const n=rows.length+1; const relative='.state/worktrees/'+id+'-'+n; const cwd=path.resolve(ctx.session,relative);
    const listed=await gitOk(ctx.deps,ctx.manifest.repositoryRoot,['worktree','list','--porcelain']);
    const registered=listed.split(/\r?\n/).filter(l=>l.startsWith('worktree ')).some(l=>path.resolve(l.slice(9))===cwd);
    let base: string;
    if(registered && !tx.fold.records.some(r=>r.kind==='writer' && r.data['path']===relative)) base=await gitOk(ctx.deps,cwd,['rev-parse','HEAD']);
    else {
      base=await gitOk(ctx.deps,integration.path,['rev-parse','HEAD']);
      await gitOk(ctx.deps,ctx.manifest.repositoryRoot,['worktree','add','--detach',cwd,base]);
      await ctx.deps.hook?.('create:after-add');
    }
    await tx.append({kind:'writer',by:'tool',data:{phase:'launched',task:id,path:relative,base:{commit:base,taskSection:section,seq:tx.fold.lastSeq}}});
    return result({task:id,launch:n,path:relative});
  });
}
export async function submit(ctx: HandlerContext): Promise<HandlerResult> {
  const {id,paths}=taskId(ctx);
  return withLedger(ctx.session,'worktree submit',ctx.deps,async tx=>{
    const launch=launches(tx.fold,id).at(-1); if(!open(launch)) refuse('no-open-launch');
    const cwd=path.resolve(ctx.session,launch.record.data['path']); const base=launch.record.data['base'].commit;
    let candidate=await gitOk(ctx.deps,cwd,['rev-parse','HEAD']);
    if(candidate!==base) {
      const parent=await gitOk(ctx.deps,cwd,['rev-parse','HEAD^']);
      if(parent!==base) refuse('submit-pending','Writer HEAD is not one commit beyond its base');
      const diff=await gitOk(ctx.deps,cwd,['diff','--name-only','--no-renames','-z',base,candidate,'--']);
      const outside=diff.split('\0').filter(p=>p && !paths.includes(p));
      if(outside.length) { await gitOk(ctx.deps,cwd,['reset','--soft',base]); refuse('out-of-scope',JSON.stringify({paths:outside})); }
    } else {
      const changed=await changedPaths(ctx.deps,cwd,base);
      const outside=changed.filter(p=>!paths.includes(p));
      if(outside.length) refuse('out-of-scope',JSON.stringify({paths:outside}));
      if(!changed.length) refuse('no-changes');
      await gitOk(ctx.deps,cwd,['add','-A']);
      await gitOk(ctx.deps,cwd,['commit','-m','dispatch: '+id+' launch '+launch.launch]);
      candidate=await gitOk(ctx.deps,cwd,['rev-parse','HEAD']);
      await ctx.deps.hook?.('submit:after-commit');
    }
    await gitOk(ctx.deps,cwd,['update-ref',candidateRef(ctx.manifest.safeSessionId,id,launch.launch),candidate]);
    await tx.append({kind:'writer',by:'tool',data:{phase:'finished',task:id,launch:launch.launch,candidate}});
    return result({task:id,launch:launch.launch,candidate,uncommitted:await changedPaths(ctx.deps,cwd,candidate)});
  });
}
export async function abandon(ctx: HandlerContext): Promise<HandlerResult> {
  const {id}=taskId(ctx);
  const reason=ctx.values['reason'];
  if(typeof reason!=='string' || !reason.trim()) throw new ToolError(1,'invalid-input','A non-blank --reason is required');
  return withLedger(ctx.session,'worktree abandon',ctx.deps,async tx=>{
    const launch=launches(tx.fold,id).at(-1); if(!open(launch)) refuse('no-open-launch');
    const cwd=path.resolve(ctx.session,launch.record.data['path']);
    const head=await gitOk(ctx.deps,cwd,['rev-parse','HEAD']);
    if(head!==launch.record.data['base'].commit) refuse('submit-pending');
    const tree=await testedTree(ctx.deps,ctx.session,cwd);
    if(tree!==await headTree(ctx.deps,cwd)) {
      const commit=await gitOk(ctx.deps,cwd,['commit-tree',tree,'-p',head,'-m','dispatch abandoned: '+id]);
      await gitOk(ctx.deps,cwd,['update-ref',abandonedRef(ctx.manifest.safeSessionId,id,launch.launch),commit]);
    }
    await tx.append({kind:'writer',by:'tool',data:{phase:'abandoned',task:id,launch:launch.launch,reason}});
    return result({task:id,launch:launch.launch,path:launch.record.data['path'],abandoned:true});
  });
}
