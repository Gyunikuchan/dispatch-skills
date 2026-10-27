import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Manifest } from '../lib/session.ts';
import type { Finding, RosterSlot } from './domain/types.ts';
import type { SlotOutcome } from './fanout.ts';
import type { FindingsValue, ReviewTarget } from './findings.ts';
import { latest, type Fold } from './ledger.ts';
import type { LedgerRecord } from './records.ts';
import { ToolError } from './output.ts';
import { parseReport } from './domain/report.ts';

export type RejectionRequest = {
  requestId: string; review: string; finding: string; rulingSeq: number; claim: Finding;
  rationale: string; target: ReviewTarget; spec: {path: string; hash: string}; sourceSlots: string[];
};
export type RejectionReply = RejectionRequest & {
  sourceSlot: string; responder?: Extract<SlotOutcome, {state:'done'}>['responder'];
  decision: 'agree' | 'disagree'; replyRationale: string;
};
export type RejectionState = {request: RejectionRequest; state: 'pending' | 'confirmed' | 'escalated'; disagreements: number; noResponses: number};
export type ConfirmationRound = {review: string; metadata: {round: number; cap?: number; generation: number; startSeq: number; target: ReviewTarget; spec: {path:string;hash:string}; artifactPath?: string; roster: RosterSlot[]; requests?: readonly RejectionRequest[]}; findings: FindingsValue};
const identity = (request: Omit<RejectionRequest,'requestId'|'claim'|'rationale'|'sourceSlots'>) => crypto.createHash('sha256').update(JSON.stringify([request.review,request.finding,request.rulingSeq,request.target,request.spec])).digest('hex');
export function rejectionRequest(request: Omit<RejectionRequest,'requestId'>): RejectionRequest {return {...request,requestId:identity(request)};}

/** Only attributed replies to the captured ruling can close a rejection. */
export function rejectionState(rounds: readonly ConfirmationRound[], rulings: readonly LedgerRecord[], escalations: readonly LedgerRecord[]): RejectionState[] {
  const states: RejectionState[] = [];
  for (const round of rounds) for (const finding of round.findings.findings) {
    if (finding.severity !== 'MUST') continue;
    const history = rulings.filter(row => row.kind === 'ruling' && row.data['subject'] === 'review:'+round.review+':'+finding.id);
    const ruling = history.findLast(row=>row.data['ruling']==='accepted' || row.data['ruling']==='rejected');
    if (ruling?.data['ruling'] !== 'rejected') continue;
    const current = rounds.filter(value => value.review === round.review).at(-1)!.metadata;
    const sources=finding.sources.filter(slot=>slot!=='tool');
    const sourceSlots=sources.length?sources:round.metadata.roster.filter(slot=>!slot.reserve).slice(0,1).map(slot=>slot.slot);
    if(!sourceSlots.length)throw new ToolError(4,'review-confirmation-required','No saved reviewer can confirm tool finding '+finding.id);
    let request = rejectionRequest({review:round.review,finding:finding.id,rulingSeq:ruling.seq,claim:finding,rationale:ruling.data['rationale'],target:current.target,spec:current.spec,sourceSlots});
    const accepted = history.findLast(row=>row.data['ruling']==='accepted')?.seq ?? 0;
    const resolved=escalations.findLast(row=>row.kind==='escalation' && row.data['id']==='rejection:'+round.review+':'+finding.id && row.data['state']==='resolved')?.seq ?? 0;
    let disagreements=0;
    const unanswered=new Map<string,number>();
    const agreements = new Map<string,Set<string>>();
    let confirmed=false;
    for (const replyRound of rounds.filter(value=>value.review===round.review)) {
      let disagreed=false, agreement=false;
      const responded=new Set<string>();
      for (const reply of replyRound.findings.confirmations ?? []) {
        if(!replyRound.metadata.requests?.some(request=>request.requestId===reply.requestId && request.sourceSlots.includes(reply.sourceSlot)) || reply.rulingSeq>replyRound.metadata.startSeq)continue;
        if (reply.review !== round.review || reply.finding !== finding.id || reply.rulingSeq <= accepted || !history.some(row=>row.seq===reply.rulingSeq && row.data['ruling']==='rejected') || !request.sourceSlots.includes(reply.sourceSlot) || !reply.replyRationale?.trim() || reply.requestId !== identity(reply)) continue;
        if (JSON.stringify(reply.target)!==JSON.stringify(replyRound.metadata.target) || JSON.stringify(reply.spec)!==JSON.stringify(replyRound.metadata.spec)) continue;
        const responder=reply.responder;
        if (!responder || !replyRound.metadata.roster.some(slot=>slot.slot===reply.sourceSlot && !slot.reserve)) continue;
        if (!responder.native && !replyRound.metadata.roster.some(slot=>slot.slot===responder.slot && slot.provider===responder.provider && (slot.slot===reply.sourceSlot || slot.reserve))) continue;
        if (responder.native && responder.slot !== reply.sourceSlot) continue;
        responded.add(reply.sourceSlot);
        const agreed=agreements.get(reply.requestId) ?? new Set<string>();agreements.set(reply.requestId,agreed);
        if (reply.decision==='agree') {agreement=true;if(reply.rulingSeq===ruling.seq)agreed.add(reply.sourceSlot);}
        else if(reply.decision==='disagree') {disagreed=true;agreed.delete(reply.sourceSlot);}
        if(!confirmed && sourceSlots.every(slot=>agreed.has(slot))) {confirmed=true;request=rejectionRequest({...request,target:reply.target,spec:reply.spec});}
      }
      if(disagreed)disagreements++;else if(agreement)disagreements=0;
      if(replyRound.metadata.startSeq>=Math.max(accepted,resolved))for(const slot of sourceSlots) {
        if(!replyRound.metadata.requests?.some(value=>value.finding===finding.id && value.sourceSlots.includes(slot)))continue;
        const previous=unanswered.get(slot) ?? 0;
        unanswered.set(slot,responded.has(slot)?0:previous+Number(replyRound.metadata.round>(replyRound.metadata.cap ?? Infinity)));
      }
    }
    const escalation=escalations.findLast(row=>row.kind==='escalation' && row.data['id']==='rejection:'+round.review+':'+finding.id);
    states.push({request,state:confirmed?'confirmed':escalation?.data['state']==='open'?'escalated':'pending',disagreements,noResponses:Math.max(0,...unanswered.values())});
  }
  return states;
}

export function reviewId(kind: string, artifact: string, gitSeries?: string): string {
  let slug=(kind==='code'?artifact:path.basename(artifact,'.md')).replace(/[^A-Za-z0-9_.-]/g,'-');
  if(gitSeries!==undefined)slug+='-'+crypto.createHash('sha256').update(artifact+gitSeries).digest('hex');
  if(!slug || slug==='.' || slug==='..')throw new ToolError(1,'invalid-input','Invalid review target');
  return kind+'-'+slug;
}
const canonical=(file:string)=>{try{return fs.realpathSync.native(file);}catch{return path.resolve(file);}};
type Selection = ReadonlyMap<string,(metadata:ConfirmationRound['metadata'])=>boolean>;
export function applicableReviewIds(session:string,manifest:Manifest,fold:Fold): Selection {
  const bind=latest(fold,'bind'), selected=new Map<string,(metadata:ConfirmationRound['metadata'])=>boolean>();
  if(!bind)return selected;
  const spec=canonical(path.resolve(manifest.repositoryRoot,bind.data['spec']));
  for(const kind of ['plan','design'] as const)if(typeof bind.data[kind]==='string') {
    const artifact=canonical(path.resolve(manifest.repositoryRoot,bind.data[kind]));
    selected.set(reviewId(kind,artifact),metadata=>canonical(metadata.spec.path)===spec && (!metadata.artifactPath || canonical(metadata.artifactPath)===artifact));
  }
  const opened=fold.records.findLast(row=>row.kind==='integrate' && row.data['phase']==='opened');
  if(opened)selected.set('code-integration',metadata=>canonical(metadata.spec.path)===spec && typeof metadata.target!=='string' && metadata.target.base===opened.data['base']);
  return selected;
}
export function loadRejections(session:string,fold:Fold,selected: readonly string[] | Selection): RejectionState[] {
  const rounds:ConfirmationRound[]=[];
  const entries=Array.isArray(selected)?selected.map(id=>[id,()=>true] as const):[...(selected as Selection)];
  for(const [review,applies] of entries) {
    if(!fold.records.some(row=>row.kind==='ruling' && row.data['subject'].startsWith('review:'+review+':') && row.data['ruling']==='rejected'))continue;
    const directory=path.join(session,'.state/reviews',review);
    if(!fs.existsSync(directory))continue;
    for(const name of fs.readdirSync(directory).filter(name=>/^round-\d+$/.test(name)).sort((a,b)=>Number(a.slice(6))-Number(b.slice(6)))) {
      const dir=path.join(directory,name);
      if(!fs.existsSync(path.join(dir,'round.json')) && fs.readdirSync(dir).length===0)continue;
      try {
        const metadata=JSON.parse(fs.readFileSync(path.join(dir,'round.json'),'utf8'));
        if(!metadata.spec?.path || !metadata.target)throw new Error('Invalid round');
        if(!applies(metadata))continue;
        if(!metadata.spec?.hash || !Array.isArray(metadata.roster))throw new Error('Invalid round');
        if(!fs.existsSync(path.join(dir,'findings.json')))continue;
        const findings=JSON.parse(fs.readFileSync(path.join(dir,'findings.json'),'utf8'));
        if(!Array.isArray(findings.findings) || findings.findings.some((f:Finding)=>!f || typeof f.id!=='string' || !['MUST','SHOULD','CONSIDER'].includes(f.severity) || !Array.isArray(f.sources) || f.sources.some(source=>typeof source!=='string')))throw new Error('Invalid findings');
        findings.confirmations=(Array.isArray(findings.confirmations)?findings.confirmations:[]).filter((reply:RejectionReply)=>{
          try {
            const saved=JSON.parse(fs.readFileSync(path.join(dir,'gen-'+metadata.generation,'slots',reply.sourceSlot+'.json'),'utf8'));
            if(saved.state!=='done' || saved.slot!==reply.sourceSlot || JSON.stringify(saved.responder)!==JSON.stringify(reply.responder))return false;
            const expectedRequestIds=(metadata.requests ?? []).filter((request:RejectionRequest)=>request.sourceSlots.includes(reply.sourceSlot)).map((request:RejectionRequest)=>request.requestId);
            const parsed=parseReport({kind:review.startsWith('code-')?'code':review.startsWith('design-')?'design':'plan',source:reply.sourceSlot,text:saved.text,expectedRequestIds});
            return parsed.ok && parsed.confirmations?.some(value=>value.requestId===reply.requestId && value.decision===reply.decision && value.rationale===reply.replyRationale);
          } catch {return false;}
        });
        rounds.push({review,metadata,findings});
      } catch {throw new ToolError(4,'review-confirmation-required','Cannot establish rejection confirmation for '+review+'/'+name);}
    }
  }
  return rejectionState(rounds,fold.records,fold.records);
}
