import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { HandlerContext, HandlerResult } from './cli.ts';
import type { Fold } from './ledger.ts';
import { withLedger, latest, currentHashes, gate } from './ledger.ts';
import { checks, finalChecks, hasTransient, loadPlan, transientTargets } from './plan-view.ts';
import { isTestSupportPath } from './domain/plan.ts';
import type { ParsedPlan } from './domain/types.ts';
import { stableValue } from './domain/stable-value.ts';
import { parseReport } from './domain/report.ts';
import { integrationRecord } from './integration.ts';
import { pending } from './integrate.ts';
import { launches } from './writers.ts';
import { git, gitOk, headTree, testedTree } from './git.ts';
import { verifiedStage, type PruneEvidence } from './evidence.ts';
import { ToolError } from './output.ts';
function refuse(reason:string):never {throw new ToolError(4,reason,reason);}
const digest = (value:unknown)=>'sha256:'+crypto.createHash('sha256').update(stableValue(value)).digest('hex');
const equal=(a:unknown,b:unknown)=>stableValue(a)===stableValue(b);
const split=(s:string)=>s.split('\0').filter(Boolean);

export function validateTargets(plan:ParsedPlan):string[] {
  const targets=transientTargets(plan), lower=new Set<string>();
  for(const file of targets) {
    const parts=file.split('/');
    if(!file  ||
       file.includes('\\')  ||
       file.includes(':')  ||
       path.isAbsolute(file)  ||
       parts.some(p=>!p ||
      p==='.' ||
      p==='..' ||
      p.toLowerCase()==='.git')  ||
       lower.has(file.toLowerCase())) refuse('unsafe-transient-target');
    lower.add(file.toLowerCase());
    if([...plan.changes.map(change=>change.path),...plan.criteria.flatMap(criterion=>[...criterion.tests,...criterion.changes])].some(declared=>declared.toLowerCase()===file.toLowerCase()&&declared!==file))refuse('unsafe-transient-target');
    if(isTestSupportPath(file)  ||
       !plan.changes.some(c=>c.path===file &&
      c.action==='NEW')  ||
       plan.changes.some(c=>c.path===file &&
      c.action!=='NEW')  ||
       plan.criteria.some(c=>c.retain!=='transient' &&
      (c.tests.includes(file) ||
      c.changes.includes(file)))) refuse('unsafe-transient-target');
  }
  if(!targets.length) refuse('unsafe-transient-target');
  return targets;
}
export function pruneProjection(plan:ParsedPlan) {
  const targets=validateTargets(plan),pre=checks(plan),final=finalChecks(plan);
  if(!plan.finalCommands.some(command=>command.trim()))refuse('missing-final-command');
  if(final.some(check=>check.commands.some(command=>targets.some(target=>command.replaceAll('\\','/').toLowerCase().includes(target.toLowerCase())))))refuse('transient-command-dependency');
  return {targets,pre,final};
}
export function prunePreconditions(fold:Fold,plan:ParsedPlan,clean:boolean,green:boolean):void {
  if(pending(fold)) refuse('integration-pending');
  if(plan.tasks.some(t=>!fold.records.some(r=>r.kind==='integrate' &&
      r.data['phase']==='done' &&
      r.data['task']===t.id))) refuse('prune-unintegrated-tasks');
  if(plan.tasks.some(task=>{
    const candidate=launches(fold,task.id).findLast(launch=>launch.finished && !launch.abandoned && !launch.superseded);
    return candidate?.finished && !fold.records.some(record=>record.kind==='integrate' && record.data['phase']==='done' && record.data['task']===task.id && record.seq>candidate.finished!.seq);
  }))refuse('prune-unintegrated-tasks');
  const tasks=new Set(fold.records.filter(r=>r.kind==='writer').map(r=>r.data['task'] as string));
  if([...tasks].some(t=>launches(fold,t).some(l=>!l.finished &&
      !l.abandoned &&
      !l.superseded))) refuse('prune-open-writers');
  if(!clean) refuse('integration-dirty');
  if(!green) refuse('prune-prechecks-required');
}
function physical(root:string,file:string,absent:boolean):boolean {
  let current=root;
  const parts=file.split('/');
  for(const [i,part] of parts.entries()) {
    current=path.join(current,part);
    let stat:fs.Stats;
    try{stat=fs.lstatSync(current);}catch(error){if(absent &&
      i===parts.length-1 &&
      (error as NodeJS.ErrnoException).code==='ENOENT')return false;
    throw error;}
    if(stat.isSymbolicLink()  ||
       (i===parts.length-1?!stat.isFile():!stat.isDirectory()))refuse('unsafe-transient-target');
    const relative=path.relative(root,fs.realpathSync(current));
    if(relative.startsWith('..') ||
      path.isAbsolute(relative))refuse('unsafe-transient-target');
  }
  return true;
}
async function owned(ctx:HandlerContext,fold:Fold) {
  const opened=integrationRecord(fold);
    if(!opened)refuse('no-integration');
  const root=fs.realpathSync(ctx.session),boundary=path.join(root,'.state/worktrees'),logical=path.resolve(root,opened.data['path']);
  const cwd=fs.existsSync(logical)?fs.realpathSync(logical):logical;
  const relative=path.relative(boundary,cwd);
  if(!relative ||
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      !fs.existsSync(cwd) ||
      path.isAbsolute(path.relative(root,logical)))refuse('unsafe-integration');
  let component=root;
  for(const part of path.relative(root,logical).split(path.sep)){component=path.join(component,part);if(fs.lstatSync(component).isSymbolicLink())refuse('unsafe-integration');}
  const registered=(await gitOk(ctx.deps,ctx.manifest.repositoryRoot,['worktree','list','--porcelain'])).split(/\r?\n/).filter(l=>l.startsWith('worktree ')).map(l=>fs.existsSync(l.slice(9))?fs.realpathSync(l.slice(9)):path.resolve(l.slice(9)));
  if(!registered.includes(cwd) ||
      await gitOk(ctx.deps,cwd,['symbolic-ref','--short','HEAD'])!==opened.data['branch'])refuse('unsafe-integration');
  return {cwd,opened};
}
function reviewIdentity(ctx:HandlerContext,fold:Fold,head:string,base:string):string {
  const directory=path.join(ctx.session,'.state/reviews/code-integration');
  let names:string[];try{names=fs.readdirSync(directory).filter(n=>/^round-\d+$/.test(n)).sort((a,b)=>Number(a.slice(6))-Number(b.slice(6)));}catch{refuse('prune-review-required');}
  const rounds=names.map(n=>{
    const dir=path.join(directory,n);
    try{return {dir,round:JSON.parse(fs.readFileSync(path.join(dir,'round.json'),'utf8')),findings:JSON.parse(fs.readFileSync(path.join(dir,'findings.json'),'utf8'))};}catch{return null;}
  });
  if(rounds.some(r=>!r))refuse('prune-review-required');
  const last=rounds.at(-1);
    if(!last)refuse('prune-review-required');
  const {round,findings}=last;
  if(round.target?.head!==head ||
      round.target?.base!==base ||
      (!equal(round.artifacts,currentHashes(ctx.manifest.repositoryRoot,latest(fold,'bind'))) ||
      round.spec?.hash!==round.artifacts?.spec) ||
      ! /^(?:Full review|Re-review round \d+ \(full\))/i.test(round.scope??'') ||
      !Array.isArray(round.roster) ||
      !round.roster.length ||
      !Array.isArray(findings.findings) ||
      !Array.isArray(findings.failed) ||
      findings.failed.length)refuse('prune-review-required');
  const files:unknown[]=[];
  const targets=round.roster.filter((slot:any)=>!slot.reserve);
  if(!targets.length)refuse('prune-review-required');
  for(const slot of targets) {
    let saved;try{saved=JSON.parse(fs.readFileSync(path.join(last.dir,'gen-'+round.generation,'slots',slot.slot+'.json'),'utf8'));}catch{refuse('prune-review-required');}
    if(saved.slot!==slot.slot ||
      saved.state!=='done' ||
      !parseReport({kind:'code',source:slot.slot,text:saved.text}).ok)refuse('prune-review-required');files.push(saved);
  }
  const escalations=new Map<string,string>();for(const r of fold.records)if(r.kind==='escalation')escalations.set(r.data['id'],r.data['state']);
  if([...escalations.values()].includes('open'))refuse('prune-review-required');
  const all=rounds.flatMap(r=>r?.findings.findings??[]);
  const settled=(finding:any,seen=new Set<string>()):boolean=>{
    if(seen.has(finding.id))return false;seen.add(finding.id);
    const ruling=fold.records.findLast(r=>r.kind==='ruling' &&
      r.data['subject']==='review:code-integration:'+finding.id);
    if(!ruling?.data['rationale']?.trim())return false;
    if(ruling.data['ruling']==='rejected')return true;
    if(ruling.data['ruling']==='duplicate') {const original=all.find(f=>f.id!==finding.id &&
      ruling.data['rationale'].includes(f.id));
    return !!original &&
      settled(original,seen);}
    if(ruling.data['ruling']==='accepted')return ruling.seq<=round.startSeq  &&
       rounds.some(r=>r &&
      r.round.round<round.round &&
      r.round.target?.head!==head &&
      r.findings.findings.some((f:any)=>f.id===finding.id))  &&
       !findings.findings.some((f:any)=>f.id===finding.id ||
      f.unresolved?.of===finding.id ||
      f.recurrence?.of===finding.id);
    return false;
  };
  if(all.some((f:any)=>f.severity==='MUST' &&
      !settled(f)))refuse('prune-review-required');
  return digest({rounds:rounds.map(r=>r &&
      {round:r.round,findings:r.findings}),files,rulings:fold.records.filter(r=>r.kind==='ruling'&&r.data['subject'].startsWith('review:code-integration:'))});
}
async function deletionTree(ctx:HandlerContext,cwd:string,from:string,targets:string[]) {
  const directory=path.join(ctx.session,'.state/tmp');fs.mkdirSync(directory,{recursive:true});
  const index=path.join(directory,crypto.randomUUID()+'.index'),env={GIT_INDEX_FILE:index};
  try {await gitOk(ctx.deps,cwd,['read-tree',from],env);
    await gitOk(ctx.deps,cwd,['--literal-pathspecs','update-index','--force-remove','--',...targets],env);
    return await gitOk(ctx.deps,cwd,['write-tree'],env);}
  finally{fs.rmSync(index,{force:true});fs.rmSync(index+'.lock',{force:true});}
}
export async function pruneTransition(ctx:HandlerContext,fold:Fold,plan:ParsedPlan,requireFinal=false):Promise<PruneEvidence|null> {
  if(!hasTransient(plan))return null;
  const done=fold.records.findLast(r=>r.kind==='integrate' &&
      r.data['phase']==='pruned');
    if(!done)refuse('pruning-required');
  prunePreconditions(fold,plan,true,true);
  const d=done.data,started=fold.records.find(r=>r.kind==='integrate' &&
      r.data['phase']==='prune-started' &&
      r.data['operation']===d['operation']);
  const {cwd,opened}=await owned(ctx,fold),{targets}=pruneProjection(plan);
  const snapshot={artifacts:d['artifacts'],from:d['from'],sourceTree:d['sourceTree'],targets:d['targets'],pre:d['pre'],final:d['final'],review:d['review']};
  if(d['operation']!==digest(snapshot))refuse('prune-transition-stale');
  if(!started ||
      !equal({...d,phase:'prune-started',to:undefined,tree:undefined},{...started.data,to:undefined,tree:undefined}) ||
      !equal(d['artifacts'],currentHashes(ctx.manifest.repositoryRoot,latest(fold,'bind'))) ||
      !equal(d['targets'],targets) ||
      !equal(d['pre'],checks(plan)) ||
      !equal(d['final'],finalChecks(plan)) ||
      !plan.finalCommands.some(c=>c.trim()))refuse('prune-transition-stale');
  const to=await gitOk(ctx.deps,cwd,['rev-parse','HEAD']);
  if(to!==d['to'] ||
      await headTree(ctx.deps,cwd)!==d['tree'] ||
      await testedTree(ctx.deps,ctx.session,cwd)!==d['tree'] ||
      await gitOk(ctx.deps,cwd,['rev-parse',to+'^'])!==d['from'] ||
      await gitOk(ctx.deps,cwd,['rev-parse',d['from']+'^{tree}'])!==d['sourceTree'] ||
      await deletionTree(ctx,cwd,d['from'],targets)!==d['tree'] ||
      reviewIdentity(ctx,fold,d['from'],opened.data['base'])!==d['review'])refuse('prune-transition-stale');
  for(const target of targets)if(physical(cwd,target,true))refuse('prune-transition-stale');
  const historical={...fold,records:fold.records.filter(r=>r.seq<started.seq)};
  if(!verifiedStage(historical,d['pre'],{headTree:d['sourceTree'],testedTree:d['sourceTree']},d['artifacts']))refuse('prune-transition-stale');
  if(requireFinal  &&
       !verifiedStage(fold,d['final'],{headTree:d['tree'],testedTree:d['tree']},d['artifacts']))refuse('final-checks-required');
  return {sourceTree:d['sourceTree'],pre:d['pre'],final:d['final'],transient:plan.criteria.filter(c=>c.retain==='transient').map(c=>c.id),tree:d['tree'],sourceSeq:started.seq,artifacts:d['artifacts']};
}
export async function prune(ctx:HandlerContext):Promise<HandlerResult> {
  if(ctx.args.length)throw new ToolError(1,'invalid-input','prune takes no task');
  return withLedger(ctx.session,'worktree prune',ctx.deps,async tx=>{
    const plan=loadPlan(ctx.session,ctx.manifest);
    if(!hasTransient(plan))return {ok:true,exit:0,summary:'No transient tests',value:{pruned:false}};
    const {targets,pre,final}=pruneProjection(plan);
    const {cwd,opened}=await owned(ctx,tx.fold);
    const head=await gitOk(ctx.deps,cwd,['rev-parse','HEAD']),tree=await headTree(ctx.deps,cwd);
    const completed=tx.fold.records.findLast(r=>r.kind==='integrate' &&
      r.data['phase']==='pruned');
    if(completed?.data['to']===head) {await pruneTransition(ctx,tx.fold,plan);
    return {ok:true,exit:0,summary:'Pruning already complete',value:{pruned:false,to:head}};}
    const artifacts=currentHashes(ctx.manifest.repositoryRoot,latest(tx.fold,'bind'));
    const approval=gate(tx.fold,artifacts);
    if(!approval.allowed)refuse(approval.reason!);
    let started=tx.fold.records.findLast(r=>r.kind==='integrate' &&
      r.data['phase']==='prune-started' &&
      !tx.fold.records.some(d=>d.kind==='integrate' &&
      d.data['phase']==='pruned' &&
      d.data['operation']===r.data['operation']));
    if(started &&
      !equal(started.data['artifacts'],artifacts))refuse('prune-transition-stale');
    const from=started?.data['from']??head,sourceTree=await gitOk(ctx.deps,cwd,['rev-parse',from+'^{tree}']);
    const expected=await deletionTree(ctx,cwd,from,targets);
    const observed=await testedTree(ctx.deps,ctx.session,cwd);
    const sourceFold={...tx.fold,records:started?tx.fold.records.filter(r=>r.seq<started!.seq):tx.fold.records};
    const green=verifiedStage(sourceFold,pre,{headTree:sourceTree,testedTree:sourceTree},artifacts);
    prunePreconditions(tx.fold,plan,started?true:observed===tree,green);
    const review=reviewIdentity(ctx,tx.fold,from,opened.data['base']);
    const snapshot={artifacts,from,sourceTree,targets,pre,final,review};
    const operation=digest(snapshot);
    if(started &&
      started.data['operation']!==operation)refuse('prune-transition-stale');
    if(started  &&
       !recoveryAllowed({head,from,tree,expected,parent:head===from?'':await gitOk(ctx.deps,cwd,['rev-parse','HEAD^']),delta:split(await gitOk(ctx.deps,cwd,['diff','--name-status','--no-renames','-z',from,'--'])),targets,untracked:split(await gitOk(ctx.deps,cwd,['ls-files','--others','--exclude-standard','-z']))}))refuse('prune-transition-stale');
    const cached=split(await gitOk(ctx.deps,cwd,['diff','--cached','--name-status','--no-renames','-z',from,'--']));
    if(cached.some((v,i)=>i%2===0?v!=='D':!targets.includes(v)))refuse('integration-dirty');
    const validateFile=async(target:string,absent:boolean)=>{
      const exists=physical(cwd,target,absent);
      if(exists  &&
       await gitOk(ctx.deps,cwd,['hash-object','--path='+target,'--',target])!==await gitOk(ctx.deps,cwd,['rev-parse',from+':'+target]))refuse('prune-transition-stale');
      if(exists)physical(cwd,target,false);
      return exists;
    };
    for(const target of targets) {
      const baseline=await git(ctx.deps,cwd,['cat-file','-e',opened.data['base']+':'+target]);
    if(!baseline.exit)refuse('unsafe-transient-target');
      const tracked=await gitOk(ctx.deps,cwd,['--literal-pathspecs','ls-tree',from,'--',target]);
    if(!/^100(?:644|755) blob /.test(tracked))refuse('unsafe-transient-target');
      await validateFile(target,!!started);
    }
    if(!started) {await ctx.deps.hook?.('prune:before-journal');
    await tx.append({kind:'integrate',by:'tool',data:{phase:'prune-started',operation,...snapshot}});started=tx.fold.records.at(-1);
    await ctx.deps.hook?.('prune:after-journal');}
    for(const target of targets) {await ctx.deps.hook?.('prune:before-unlink');
    if(await gitOk(ctx.deps,cwd,['rev-parse','HEAD'])!==head ||
      !equal(artifacts,currentHashes(ctx.manifest.repositoryRoot,latest(tx.fold,'bind'))) ||
      reviewIdentity(ctx,tx.fold,from,opened.data['base'])!==review)refuse('prune-transition-stale');
    if(await validateFile(target,true))fs.unlinkSync(path.join(cwd,target));
    await ctx.deps.hook?.('prune:after-delete');}
    if(await gitOk(ctx.deps,cwd,['rev-parse','HEAD'])!==head  ||
       !equal(artifacts,currentHashes(ctx.manifest.repositoryRoot,latest(tx.fold,'bind')))  ||
       await testedTree(ctx.deps,ctx.session,cwd)!==expected)refuse('prune-transition-stale');
    if(head===from) {await gitOk(ctx.deps,cwd,['--literal-pathspecs','add','-u','--',...targets]);
    await gitOk(ctx.deps,cwd,['--literal-pathspecs','commit','--only','-m','dispatch: prune declared transient tests','--',...targets]);
    await ctx.deps.hook?.('prune:after-commit');}
    const to=await gitOk(ctx.deps,cwd,['rev-parse','HEAD']);
    if(await gitOk(ctx.deps,cwd,['rev-parse','HEAD^'])!==from  ||
       await headTree(ctx.deps,cwd)!==expected  ||
       await testedTree(ctx.deps,ctx.session,cwd)!==expected  ||
       !equal(artifacts,currentHashes(ctx.manifest.repositoryRoot,latest(tx.fold,'bind'))))refuse('prune-transition-stale');
    await tx.append({kind:'integrate',by:'tool',data:{phase:'pruned',operation,...snapshot,to,tree:expected}});
    return {ok:true,exit:0,summary:'Pruned '+targets.length+' transient files',value:{targets,from,to}};
  });
}

export function recoveryAllowed(input:{head:string;from:string;tree:string;expected:string;parent:string;delta:string[];targets:string[];untracked:string[]}):boolean {
  return (input.head===input.from  ||
       input.tree===input.expected &&
      input.parent===input.from)  &&
       !input.untracked.length  &&
       input.delta.every((v,i)=>i%2===0?v==='D':input.targets.includes(v));
}
