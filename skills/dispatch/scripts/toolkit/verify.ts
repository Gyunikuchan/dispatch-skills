import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { HandlerContext, HandlerResult } from './cli.ts';
import { appendRecord, withLedger, foldLedger } from './ledger.ts';
import { stableValue } from './domain/stable-value.ts';
import { checks, loadPlan } from './plan-view.ts';
import { cleanupBinding } from './evidence.ts';
import { ensureIntegration } from './integration.ts';
import { headTree, testedTree } from './git.ts';
import { ToolError } from './output.ts';
export function shellArgv(os: string, command: string): string[] {
  return os === 'win32' ? ['cmd.exe', '/d', '/s', '/c', command] : ['sh', '-c', command];
}
export async function verifyRun(ctx: HandlerContext): Promise<HandlerResult> {
  const {session,manifest,deps,values,args}=ctx;
  if(args.length) throw new ToolError(1,'invalid-input','verify takes only options');
  const all=checks(loadPlan(session,manifest));
  const removed=cleanupBinding(foldLedger(session))?.removed??[];
  const named=typeof values['criteria']==='string' ? values['criteria'].split(',').map(id=>id.trim()).filter(Boolean) : null;
  const ids=named ?? all.map(c=>c.criterion).filter(id=>!removed.includes(id));
  const unknown=ids.filter(id=>!all.some(c=>c.criterion===id));
  if(unknown.length) throw new ToolError(1,'invalid-input','Unknown criterion: '+unknown.join(', ')+'; valid: '+all.map(c=>c.criterion).join(', '));
  const gone=ids.filter(id=>removed.includes(id));
  if(gone.length) throw new ToolError(4,'test-cleanup-removed','Test cleanup removed the tests for '+gone.join(', ')+'; their evidence stays bound to the pre-cleanup tree');
  const selected=all.filter(c=>ids.includes(c.criterion));
  const integration=await withLedger(session,'verify run',deps,tx=>ensureIntegration(tx,ctx));
  const directory=path.join(session,'.state/evidence'); fs.mkdirSync(directory,{recursive:true});
  const records: Record<string,unknown>[]=[];
  for(const check of selected) {
    const before=await testedTree(deps,session,integration.path);
    const clean=before===await headTree(deps,integration.path);
    let exit=0; let log='';
    for(const command of check.commands) {
      const result=await deps.run(shellArgv(process.platform,command),{cwd:integration.path});
      log+='$ '+command+'\n'+result.stdout+result.stderr;
      exit=result.exit;
      if(exit!==0) break;
    }
    const after=await testedTree(deps,session,integration.path);
    const data={criterion:check.criterion,commandDigest:check.commandDigest,tree:before,clean,before,after,exit};
    const digest=crypto.createHash('sha256').update(stableValue(data)).digest('hex');
    const file=path.join(directory,digest+'.json');
    const logPath=path.join(directory,digest+'.log');
    fs.writeFileSync(logPath,log);
    const temporary=file+'.'+crypto.randomUUID()+'.tmp';
    fs.writeFileSync(temporary,JSON.stringify(data)); fs.renameSync(temporary,file);
    await deps.hook?.('verify:after-evidence');
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
