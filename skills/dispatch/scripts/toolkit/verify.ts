import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { HandlerContext, HandlerResult } from './cli.ts';
import { appendRecord, withLedger, currentHashes, latest, foldLedger } from './ledger.ts';
import { stableValue } from './domain/stable-value.ts';
import { pruneTransition } from './prune.ts';
import { checks, finalChecks, hasTransient, loadPlan } from './plan-view.ts';
import { ensureIntegration } from './integration.ts';
import { headTree, testedTree } from './git.ts';
import { ToolError } from './output.ts';
export function shellArgv(os: string, command: string): string[] {
  return os === 'win32' ? ['cmd.exe', '/d', '/s', '/c', command] : ['sh', '-c', command];
}
export async function verifyRun(ctx: HandlerContext): Promise<HandlerResult> {
  const {session,manifest,deps,values,args}=ctx;
  if(args.length) throw new ToolError(1,'invalid-input','verify takes only options');
  let plan=loadPlan(session,manifest);
  const artifacts=hasTransient(plan)?currentHashes(manifest.repositoryRoot,latest(foldLedger(session),'bind')):null;
  const assertArtifacts=()=>{if(artifacts && stableValue(currentHashes(manifest.repositoryRoot,latest(foldLedger(session),'bind')))!==stableValue(artifacts))throw new ToolError(4,'artifacts-changed','Governing artifacts changed during verification; rerun with the current plan');};
  if(artifacts){plan=loadPlan(session,manifest);assertArtifacts();}
  const final=values['final']===true;
  const all=final && hasTransient(plan)?finalChecks(plan):checks(plan);
  const ids=typeof values['criteria']==='string' ? values['criteria'].split(',') : all.map(c=>c.criterion);
  if(ids.some(id=>!all.some(c=>c.criterion===id))) throw new ToolError(1,'invalid-input','Unknown criterion');
  const selected=all.filter(c=>ids.includes(c.criterion));
  const integration=await withLedger(session,'verify run',deps,async tx=>{
    if(final && hasTransient(plan))await pruneTransition(ctx,tx.fold,plan);
    return ensureIntegration(tx,ctx);
  });
  const directory=path.join(session,'.state/evidence'); fs.mkdirSync(directory,{recursive:true});
  const records: Record<string,unknown>[]=[];
  for(const check of selected) {
    assertArtifacts();
    const before=await testedTree(deps,session,integration.path);
    const clean=before===await headTree(deps,integration.path);
    let exit=0; let log='';
    for(const command of check.commands) {
      assertArtifacts();
      const result=await deps.run(shellArgv(process.platform,command),{cwd:integration.path});
      assertArtifacts();
      log+='$ '+command+'\n'+result.stdout+result.stderr;
      exit=result.exit;
      if(exit!==0) break;
    }
    const after=await testedTree(deps,session,integration.path);
    assertArtifacts();
    const data={criterion:check.criterion,commandDigest:check.commandDigest,tree:before,clean,before,after,exit,...(artifacts?{artifacts}:{})};
    const digest=crypto.createHash('sha256').update(stableValue(data)).digest('hex');
    const file=path.join(directory,digest+'.json');
    const logPath=path.join(directory,digest+'.log');
    fs.writeFileSync(logPath,log);
    const temporary=file+'.'+crypto.randomUUID()+'.tmp';
    fs.writeFileSync(temporary,JSON.stringify(data)); fs.renameSync(temporary,file);
    await deps.hook?.('verify:after-evidence');
    assertArtifacts();
    const evidence={...data,path:path.relative(session,file).split(path.sep).join('/')};
    await appendRecord(session,{kind:'evidence',by:'tool',key:'evidence:'+digest,data:evidence},deps);
    records.push({...evidence,logPath});
  }
  const failed=records.filter(r=>r['exit']!==0).map(r=>r['criterion']);
  const mutated=records.filter(r=>r['before']!==r['after']).map(r=>r['criterion']);
  const dirty=records.filter(r=>!r['clean']).map(r=>r['criterion']);
  const reason=failed.length ? 'checks-failed' : mutated.length ? 'mutated' : dirty.length ? 'dirty' : undefined;
  return {ok:!reason,exit:0,...(reason ? {reason}:{}),summary:records.length+' checks; failed '+failed.join(',')+'; mutated '+mutated.join(',')+'; dirty '+dirty.join(','),value:{checks:records,failed,mutated,dirty}};
}
