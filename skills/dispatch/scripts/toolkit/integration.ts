import fs from 'node:fs';
import path from 'node:path';
import type { HandlerContext } from './cli.ts';
import type { Fold, LedgerTransaction } from './ledger.ts';
import { git, gitOk } from './git.ts';
import { ToolError } from './output.ts';
export const integrationRecord = (fold: Fold) => fold.records.findLast(r=>r.kind==='integrate' && r.data['phase']==='opened');
export async function ensureIntegration(tx: LedgerTransaction, ctx: HandlerContext) {
  const {session,manifest,deps}=ctx;
  const record=integrationRecord(tx.fold);
  const relative=record?.data['path'] ?? '.state/worktrees/integration';
  const cwd=path.resolve(session,relative);
  const branch=record?.data['branch'] ?? 'dispatch/' + manifest.safeSessionId + '/integration';
  const root=manifest.repositoryRoot;
  if(record) {
    if(!fs.existsSync(cwd)) { await gitOk(deps,root,['worktree','prune']); await gitOk(deps,root,['worktree','add',cwd,branch]); }
    return {path:cwd,branch,record};
  }
  const caller=await git(deps,root,['symbolic-ref','--quiet','--short','HEAD']);
  if(caller.exit!==0) throw new ToolError(4,'caller-detached','Caller HEAD is detached');
  const registered=await gitOk(deps,root,['worktree','list','--porcelain']);
  const adopted=registered.split(/\r?\n\r?\n/).some(block=>block.includes('branch refs/heads/'+branch+'\n') || block.endsWith('branch refs/heads/'+branch));
  let base: string;
  if(adopted) {
    const block=registered.split(/\r?\n\r?\n/).find(b=>b.includes('branch refs/heads/'+branch))!;
    const registeredPath=block.split(/\r?\n/).find(l=>l.startsWith('worktree '))!.slice(9);
    if(path.resolve(registeredPath)!==cwd) throw new ToolError(2,'fault','Integration branch is registered at another path');
    base=await gitOk(deps,cwd,['rev-parse','HEAD']);
  } else {
    base=await gitOk(deps,root,['rev-parse','HEAD']);
    fs.mkdirSync(path.dirname(cwd),{recursive:true});
    await gitOk(deps,root,['worktree','add','-b',branch,cwd,base]);
  }
  await tx.append({kind:'integrate',by:'tool',data:{phase:'opened',path:relative,branch,base,dest:{path:root,branch:caller.stdout.trim()}}});
  return {path:cwd,branch,record:integrationRecord(tx.fold)!};
}
