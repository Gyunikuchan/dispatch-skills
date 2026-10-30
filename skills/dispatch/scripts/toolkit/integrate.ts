import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { HandlerContext, HandlerResult } from './cli.ts';
import { withLedger, gate, currentHashes, latest, type Fold, type LedgerTransaction } from './ledger.ts';
import { validateReviewFix, type LedgerRecord, type ReviewFix } from './records.ts';
import { git, gitOk, changedPaths } from './git.ts';
import { ensureIntegration } from './integration.ts';
import { launches, isStale, abandonedRef } from './writers.ts';
import { checks, loadPlan, taskSection } from './plan-view.ts';
import { eligibility } from './evidence.ts';
import { ToolError } from './output.ts';
import { stableValue } from './domain/stable-value.ts';

export const result=(value: unknown): HandlerResult=>({ok:true,value,exit:0,summary:JSON.stringify(value)});
export function refuse(reason: string,message=reason): never {throw new ToolError(4,reason,message);}
export function reason(ctx: HandlerContext): string {
  const value=ctx.values['reason'];
  if(typeof value!=='string'||!value.trim())throw new ToolError(1,'invalid-input','A non-blank --reason is required');
  return value;
}
export function reviewFixIdentity(value: ReviewFix): { digest: string; data: string } {
  const canonical = stableValue(value);
  return {
    digest: 'sha256:' + crypto.createHash('sha256').update(canonical).digest('hex'),
    data: Buffer.from(canonical).toString('base64url'),
  };
}
export function reviewFixFromCommit(message: string): ReviewFix | undefined {
  const digests = message.split(/\r?\n/).filter(line => line.startsWith('Dispatch-Review-Fix: '));
  const values = message.split(/\r?\n/).filter(line => line.startsWith('Dispatch-Review-Fix-Data: '));
  if (!digests.length && !values.length) return undefined;
  if (digests.length !== 1 || values.length !== 1) throw new ToolError(1, 'invalid-review-fix', 'Expected one correction digest and metadata trailer');
  const digest = digests[0]!.slice('Dispatch-Review-Fix: '.length);
  const encoded = values[0]!.slice('Dispatch-Review-Fix-Data: '.length);
  try {
    const parsed = validateReviewFix(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
    if (digest !== reviewFixIdentity(parsed).digest) throw new Error('Correction digest mismatch');
    return parsed;
  } catch {
    throw new ToolError(1, 'invalid-review-fix', 'Correction metadata is malformed or differs from its digest');
  }
}
function readReviewFix(ctx: HandlerContext): ReviewFix | undefined {
  const file = ctx.values['review-fix'];
  if (file === undefined) return undefined;
  if (typeof file !== 'string' || !file.trim()) throw new ToolError(1, 'invalid-input', 'A JSON file is required for --review-fix');
  try { return validateReviewFix(JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))); }
  catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(1, 'invalid-input', 'input requires a readable review-fix JSON object');
  }
}
type TestCleanup = { removed: string[]; deleted: number; merged: number };
const TRAILER = 'Dispatch-Test-Cleanup-Data: ';
function readTestCleanup(ctx: HandlerContext): TestCleanup | undefined {
  const file = ctx.values['test-cleanup'];
  if (file === undefined) return undefined;
  const invalid = () => new ToolError(1, 'invalid-input', 'input requires a readable test-cleanup JSON object: {"removed": ["SC<n>"], "deleted": <count>, "merged": <count>}');
  if (typeof file !== 'string' || !file.trim()) throw invalid();
  let value: any;
  try { value = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); } catch { throw invalid(); }
  const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'deleted,merged,removed' ||
      !Array.isArray(value.removed) || value.removed.some((id: unknown) => typeof id !== 'string' || !id.trim()) || new Set(value.removed).size !== value.removed.length ||
      !count(value.deleted) || !count(value.merged)) throw invalid();
  if (!value.removed.length && !value.deleted && !value.merged) refuse('test-cleanup-empty');
  return { removed: value.removed, deleted: value.deleted, merged: value.merged };
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
  const why=reason(ctx); let reviewFix=readReviewFix(ctx); const cleanup=readTestCleanup(ctx); if(ctx.args.length)throw new ToolError(1,'invalid-input','commit takes no task');
  if(cleanup && reviewFix)throw new ToolError(1,'invalid-input','--test-cleanup and --review-fix are mutually exclusive');
  return withLedger(ctx.session,'worktree commit',ctx.deps,async tx=>{
    const active=pending(tx.fold); if(active)refuse('integration-pending',active.data['task']);
    const integration=await ensureIntegration(tx,ctx),cwd=integration.path;
    let hash=await gitOk(ctx.deps,cwd,['rev-parse','HEAD']);
    const dirty=(await changedPaths(ctx.deps,cwd,'HEAD')).length>0;
    const message=dirty?'':await gitOk(ctx.deps,cwd,['log','-1','--format=%B']);
    const lines=message.split('\n');
    const cleanupTrailer=lines.find(line=>line.startsWith(TRAILER));
    if(cleanup) {
      // SECTION: test cleanup commit; a clean tree recovers an interrupted commit from its trailer
      if(tx.fold.records.some(r=>r.kind==='integrate' && r.data['phase']==='test-cleanup'))refuse('test-cleanup-recorded');
      const trailer=TRAILER+stableValue(cleanup);
      if(!dirty && (lines[0]!=='fix(dispatch): '+why || !lines.includes('Dispatch-Fix: '+ctx.manifest.safeSessionId) || cleanupTrailer!==trailer))refuse('no-changes');
      const from=dirty?hash:await gitOk(ctx.deps,cwd,['rev-parse','HEAD^']);
      const fromTree=await gitOk(ctx.deps,cwd,['rev-parse',from+'^{tree}']);
      const plan=loadPlan(ctx.session,ctx.manifest);
      const known=cleanup.removed.filter(id=>plan.criteria.some(c=>c.id===id));
      const verified=eligibility(tx.fold,checks(plan).filter(c=>known.includes(c.criterion)),{headTree:fromTree,testedTree:fromTree},true);
      if(known.length!==cleanup.removed.length || verified.some(row=>row.state!=='verified'))refuse('test-cleanup-evidence-required','Every removed criterion needs a plan criterion with successful current evidence on the pre-cleanup tree');
      const changed=new Set((await gitOk(ctx.deps,cwd,dirty?['diff','-z','--name-only','--no-renames','HEAD','--']:['diff','-z','--name-only','--no-renames',from,'HEAD','--'])).split('\0').filter(Boolean));
      const untouched=cleanup.removed.filter(id=>!plan.criteria.find(c=>c.id===id)!.tests.some(file=>changed.has(file)));
      if(untouched.length)refuse('test-cleanup-paths-unchanged','No declared Tests path changed for '+untouched.join(', '));
      if(dirty) {
        await gitOk(ctx.deps,cwd,['add','-A']); await gitOk(ctx.deps,cwd,['commit','-m','fix(dispatch): '+why,'-m','Dispatch-Fix: '+ctx.manifest.safeSessionId,'-m',trailer]);
        await ctx.deps.hook?.('commit:after-commit'); hash=await gitOk(ctx.deps,cwd,['rev-parse','HEAD']);
      }
      await tx.append({kind:'integrate',by:'tool',data:{phase:'test-cleanup',from,fromTree,to:hash,...cleanup}});
      return result({commit:hash,reason:why,from,...cleanup});
    }
    if(dirty) {
      const metadata=reviewFix?reviewFixIdentity(reviewFix):undefined;
      const identity=metadata?['-m','Dispatch-Review-Fix: '+metadata.digest,'-m','Dispatch-Review-Fix-Data: '+metadata.data]:[];
      await gitOk(ctx.deps,cwd,['add','-A']); await gitOk(ctx.deps,cwd,['commit','-m','fix(dispatch): '+why,'-m','Dispatch-Fix: '+ctx.manifest.safeSessionId,...identity]);
      await ctx.deps.hook?.('commit:after-commit'); hash=await gitOk(ctx.deps,cwd,['rev-parse','HEAD']);
    } else {
      if(cleanupTrailer!==undefined || tx.fold.records.some(r=>r.kind==='integrate' && r.data['phase']==='test-cleanup' && r.data['to']===hash))refuse('no-changes');
      if(lines[0]!=='fix(dispatch): '+why || !lines.includes('Dispatch-Fix: '+ctx.manifest.safeSessionId) || tx.fold.records.some(r=>r.kind==='integrate' && r.data['phase']==='fix' && r.data['commit']===hash))refuse('no-changes');
      const recorded=reviewFixFromCommit(message);
      if(recorded && reviewFix && stableValue(recorded)!==stableValue(reviewFix))refuse('no-changes');
      if(recorded)reviewFix=recorded;
      else if(reviewFix)refuse('no-changes');
    }
    await tx.append({kind:'integrate',by:'tool',data:{phase:'fix',commit:hash,reason:why,...(reviewFix?{reviewFix}:{})}}); return result({commit:hash,reason:why});
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
