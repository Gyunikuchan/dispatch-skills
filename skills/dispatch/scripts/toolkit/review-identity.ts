import { loadRejections, applicableReviewIds } from './confirmations.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { HandlerContext } from './cli.ts';
import type { Fold } from './ledger.ts';
import { latest, currentHashes } from './ledger.ts';
import { stableValue } from './domain/stable-value.ts';
import { parseReport } from './domain/report.ts';
import { effectiveSeverity } from './domain/severity.ts';
import { reviewFixFromCommit } from './integrate.ts';
import { coverageState } from './coverage.ts';
import type { ReviewFix } from './records.ts';
import { gitOk, gitPaths } from './git.ts';
import { ToolError } from './output.ts';
function refuse(reason:string):never {throw new ToolError(4,reason,reason);}
function rejections(ctx:HandlerContext,fold:Fold) {
  try {return loadRejections(ctx.session,fold,applicableReviewIds(ctx.manifest,fold));}
  catch(error) {
    if(error instanceof ToolError && error.reason==='review-confirmation-required')return refuse('review-required');
    throw error;
  }
}
function reviewRead<T>(read:()=>T):T {
  try{return read();}
  catch(error) {
    if(error instanceof SyntaxError || (typeof error==='object' && error!==null && (error as NodeJS.ErrnoException).code==='ENOENT'))refuse('review-required');
    throw error;
  }
}
const digest = (value:unknown)=>'sha256:'+crypto.createHash('sha256').update(stableValue(value)).digest('hex');
const equal=(a:unknown,b:unknown)=>stableValue(a)===stableValue(b);
export type ReviewCorrection = { commit:string; seq:number; reason:string; reviewFix:ReviewFix; paths:string[] };
export type ReviewIdentity = { identity:string; baseline:string; round:number; generation:number; startSeq:number; corrections:ReviewCorrection[] };
function safeCorrectionPath(value:unknown):string|null {
  if(typeof value!=='string'||!value.trim())return null;
  const normalized=value.replaceAll('\\','/');
  if(normalized.startsWith('/')||/^[a-z]:/i.test(normalized)||normalized.split('/').some(part=>!part||part==='.'||part==='..')||path.posix.normalize(normalized)!==normalized)return null;
  return normalized;
}
function correctionScope(finding:any):string[]|null {
  if(Object.hasOwn(finding,'fix')) {
    const fix=finding.fix;
    if(!fix||typeof fix!=='object'||Array.isArray(fix)||!Array.isArray(fix.paths)||!fix.paths.length)return null;
    const paths:string[]=[];
    for(const value of fix.paths) {
      const normalized=safeCorrectionPath(value);
      if(!normalized)return null;
      paths.push(normalized);
    }
    return [...new Set(paths)];
  }
  const match=typeof finding.locus==='string'?/^(.+):L[1-9]\d*$/.exec(finding.locus):null;
  const file=match?safeCorrectionPath(match[1]):null;
  return file?[file]:null;
}
export async function reviewIdentity(ctx:HandlerContext,fold:Fold,cwd:string,head:string,base:string):Promise<ReviewIdentity> {
  const states=rejections(ctx,fold);
  if(states.some(state=>state.state!=='confirmed'))refuse('review-required');
  const directory=path.join(ctx.session,'.state/reviews/code-integration');
  const names=reviewRead(()=>fs.readdirSync(directory).filter(n=>/^round-\d+$/.test(n)).sort((a,b)=>Number(a.slice(6))-Number(b.slice(6))));
  const rounds=names.map(n=>{
    const dir=path.join(directory,n);
    return {dir,round:reviewRead(()=>JSON.parse(fs.readFileSync(path.join(dir,'round.json'),'utf8'))),findings:reviewRead(()=>JSON.parse(fs.readFileSync(path.join(dir,'findings.json'),'utf8')))};
  });
  const last=rounds.at(-1);
  // A confirmation-only round re-uses its predecessor's target, so identity and
  // settled findings anchor to the latest round that reviewed the target itself.
  const substantive=rounds.findLast(value=>!/\(confirmation-only\)/i.test(value.round.scope??''));
  if(!last||!substantive)refuse('review-required');
  const baseline=last.round.target?.head;
  const validHeader=(entry:{dir:string;round:any;findings:any},scope:RegExp):boolean=>
    typeof baseline==='string' && /^([a-f0-9]{40}|[a-f0-9]{64})$/.test(baseline) &&
    entry.round.target?.head===baseline &&
    entry.round.target?.base===base &&
    equal(entry.round.artifacts,currentHashes(ctx.manifest.repositoryRoot,latest(fold,'bind'))) &&
    entry.round.spec?.hash===entry.round.artifacts?.spec &&
    scope.test(entry.round.scope??'') &&
    Number.isSafeInteger(entry.round.round) && entry.round.round===Number(entry.dir.slice(entry.dir.lastIndexOf('round-')+6)) &&
    Number.isSafeInteger(entry.round.generation) && entry.round.generation>=1 &&
    Number.isSafeInteger(entry.round.startSeq) && entry.round.startSeq>=0 &&
    Array.isArray(entry.round.roster) &&
    entry.round.roster.length &&
    Array.isArray(entry.findings.findings) &&
    Array.isArray(entry.findings.failed);
  if(!validHeader(last,/^(?:Full review|Re-review round \d+ \((?:full|narrowed|coverage|confirmation-only)\))/i) ||
      !validHeader(substantive,/^(?:Full review|Re-review round \d+ \((?:full|narrowed|coverage)\))/i))refuse('review-required');
  // Coverage replaces the last-round failure check: majority or overridden slots pass; rerun, user and unreadable state refuse.
  let coverage;
  try {coverage=coverageState(ctx.session,fold,'code-integration',applicableReviewIds(ctx.manifest,fold).get('code-integration'));}
  catch(error) {if(error instanceof ToolError && error.reason==='coverage-required')refuse('review-required');throw error;}
  if(coverage.decision==='rerun'||coverage.decision==='user')refuse('review-required');
  const covered=new Set([...coverage.open,...coverage.overridden.map(item=>item.slot)]);
  const files:unknown[]=[];
  const validateSlots=(entry:{dir:string;round:any;findings:any},expected?:((slot:string)=>readonly string[])):unknown[]=>{
    const targets=entry.round.roster.filter((slot:any)=>!slot.reserve);
    if(!targets.length)refuse('review-required');
    const savedFiles:unknown[]=[];
    for(const slot of targets) {
      const saved=reviewRead(()=>JSON.parse(fs.readFileSync(path.join(entry.dir,'gen-'+entry.round.generation,'slots',slot.slot+'.json'),'utf8')));
      const requestIds=expected?.(slot.slot);
      if(saved.slot!==slot.slot ||
        !(saved.state==='done'?parseReport({kind:'code',source:slot.slot,text:saved.text,...(requestIds?{expectedRequestIds:requestIds}:{})}).ok:saved.state==='failed'&&covered.has(slot.slot)))refuse('review-required');
      savedFiles.push(saved);
    }
    return savedFiles;
  };
  files.push(...validateSlots(substantive));
  if(last!==substantive) {
    const lastFiles=validateSlots(last,slot=>(last.round.requests??[]).filter((request:any)=>request.sourceSlots.includes(slot)).map((request:any)=>request.requestId));
    files.push(...lastFiles);
    if(!lastFiles.some((saved:any)=>saved.state==='done'))refuse('review-required');
  }
  if(!files.some((saved:any)=>saved.state==='done'))refuse('review-required');
  const round=substantive.round,findings=substantive.findings;
  const escalations=new Map<string,string>();for(const r of fold.records)if(r.kind==='escalation')escalations.set(r.data['id'],r.data['state']);
  if([...escalations.values()].includes('open'))refuse('review-required');
  const all=rounds.flatMap(r=>r?.findings.findings??[]);
  if(findings.findings.some((finding:any)=>!finding||typeof finding.id!=='string'||!finding.id.trim()) ||
      new Set(findings.findings.map((finding:any)=>finding.id)).size!==findings.findings.length)refuse('review-required');
  // The corrected severity of a code-integration finding, from every ruling recorded for it.
  const effective=(finding:any)=>effectiveSeverity(finding,fold.records.filter(r=>r.kind==='ruling'&&r.data['subject']==='review:code-integration:'+finding.id));
  const settled=(finding:any,seen=new Set<string>()):boolean=>{
    if(seen.has(finding.id))return false;seen.add(finding.id);
    const ruling=fold.records.findLast(r=>r.kind==='ruling' &&
      r.data['subject']==='review:code-integration:'+finding.id);
    if(!ruling?.data['rationale']?.trim())return false;
    if(ruling.data['ruling']==='rejected')return effective(finding)!=='MUST' || states.some(state=>state.request.review==='code-integration' && state.request.finding===finding.id && state.state==='confirmed');
    if(ruling.data['ruling']==='duplicate') {const original=all.find(f=>f.id!==finding.id &&
      ruling.data['rationale'].includes(f.id));
    return !!original &&
      settled(original,seen);}
    if(ruling.data['ruling']==='accepted')return ruling.seq<=round.startSeq  &&
       rounds.some(r=>r &&
      r.round.round<round.round &&
      r.round.target?.head!==baseline &&
      r.findings.findings.some((f:any)=>f.id===finding.id))  &&
       !findings.findings.some((f:any)=>f.id===finding.id ||
      f.unresolved?.of===finding.id ||
      f.recurrence?.of===finding.id) &&
       !last.findings.findings.some((f:any)=>f.id===finding.id ||
      f.unresolved?.of===finding.id ||
      f.recurrence?.of===finding.id);
    return false;
  };
  if(all.some((f:any)=>effective(f)==='MUST' &&
      !settled(f)))refuse('review-required');
  const corrections:ReviewCorrection[]=[];
  if(head!==baseline) {
    if(!Number.isSafeInteger(round.cap)||round.cap<1||round.round<round.cap)refuse('review-required');
    const lines=await gitOk(ctx.deps,cwd,['rev-list','--reverse','--parents',baseline+'..'+head]);
    const commits=lines.split(/\r?\n/).filter(Boolean).map(line=>line.split(' '));
    if(!commits.length)refuse('review-required');
    let parent=baseline,lastSeq=round.startSeq;
    const finalFindings=new Map<string,any>(findings.findings.map((finding:any)=>[finding.id,finding]));
    for(const row of commits) {
      const [commit,...parents]=row;
      if(!commit||parents.length!==1||parents[0]!==parent)refuse('review-required');
      const matches=fold.records.filter(record=>record.kind==='integrate'&&record.data['phase']==='fix'&&record.data['commit']===commit);
      if(matches.length!==1)refuse('review-required');
      const record=matches[0]!;
      const metadata=record.data['reviewFix'] as ReviewFix|undefined;
      if(record.by!=='tool'||!metadata||metadata.review!=='code-integration'||metadata.round!==round.round||metadata.generation!==round.generation||metadata.from!==baseline||record.seq<=lastSeq)refuse('review-required');
      for(const id of metadata.findings) {
        const finding=finalFindings.get(id);
        const ruling=fold.records.findLast(candidate=>candidate.kind==='ruling'&&candidate.data['subject']==='review:code-integration:'+id);
        // NOTE: a finding corrected down to CONSIDER keeps its required fix; a reviewer-rated CONSIDER does not qualify.
        const qualifies=finding&&(effective(finding)==='SHOULD'||(effective(finding)==='CONSIDER'&&finding.severity!=='CONSIDER'));
        if(!qualifies||!ruling||ruling.data['ruling']!=='accepted'||!String(ruling.data['rationale']??'').trim()||ruling.seq<=round.startSeq||ruling.seq>=record.seq)refuse('review-required');
      }
      const allowed=new Set<string>();
      for(const id of metadata.findings) {
        const paths=correctionScope(finalFindings.get(id));
        if(!paths?.length)refuse('review-required');
        for(const file of paths)allowed.add(file);
      }
      const changes=await gitPaths(ctx.deps,cwd,['diff-tree','--no-commit-id','--name-only','--no-renames','-r','-z',commit]);
      if(!changes.length||changes.some(file=>!allowed.has(file.replaceAll('\\','/'))))refuse('review-required');
      const message=await gitOk(ctx.deps,cwd,['log','-1','--format=%B',commit]);
      if(message.split(/\r?\n/)[0]!=='fix(dispatch): '+record.data['reason']||!message.split(/\r?\n/).includes('Dispatch-Fix: '+ctx.manifest.safeSessionId))refuse('review-required');
      let committed:ReviewFix|undefined;
      try {committed=reviewFixFromCommit(message);}catch{refuse('review-required');}
      if(!committed||!equal(committed,metadata))refuse('review-required');
      corrections.push({commit,seq:record.seq,reason:String(record.data['reason']),reviewFix:metadata,paths:changes});
      parent=commit;lastSeq=record.seq;
    }
    if(parent!==head)refuse('review-required');
  }
  const identity=digest({rounds:rounds.map(r=>r && {round:r.round,findings:r.findings}),files,rulings:fold.records.filter(r=>r.kind==='ruling'&&r.data['subject'].startsWith('review:code-integration:')),baseline,corrections});
  return {identity,baseline,round:round.round,generation:round.generation,startSeq:round.startSeq,corrections};
}
