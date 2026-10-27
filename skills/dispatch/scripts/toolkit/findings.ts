import { collectFindings, matchFinding, parseReport } from './domain/report.ts';
import type { Finding, ReviewKind } from './domain/types.ts';
import type { SlotOutcome } from './fanout.ts';
import type { LedgerRecord, RecordInput } from './records.ts';
import { rejectionState, type RejectionRequest, type RejectionReply, type ConfirmationRound } from './confirmations.ts';
export type ReviewTarget = string | {base: string; head: string};
export type ReviewedFinding = Finding & {recurrence?: {of: string}; unresolved?: {of: string}};
export type FindingsValue = {
  review: string; round: number; cap: number; level: string; findings: ReviewedFinding[];
  clusters: {file: string; findings: string[]}[]; failed: Extract<SlotOutcome, {state: 'failed'}>[];
  confirmations?: RejectionReply[];
};
export type Finalized = FindingsValue & {escalations: RecordInput[]};
const key = (finding: Finding) => ({locus: finding.locus, category: finding.category, text: finding.defect + ' ' + finding.requiredChange});
export function finalizeRound(input: {
  review: string; round: number; generation: number; cap: number; level: string; startSeq: number;
  replies: readonly SlotOutcome[]; redGaps?: readonly Finding[]; prior: readonly FindingsValue[];
  priorTargets: Record<number, ReviewTarget>; changedSince?: Record<number, readonly string[]>;
  owners?: Record<string, readonly string[]>; escalationRecords?: readonly LedgerRecord[]; rulings: readonly LedgerRecord[];
  kind: ReviewKind; artifact: string; target: ReviewTarget;
  requests?: readonly RejectionRequest[]; confirmationRounds?: readonly ConfirmationRound[]; spec?: {path:string;hash:string}; roster?: ConfirmationRound['metadata']['roster'];
}): Finalized {
  const confirmations: RejectionReply[] = [];
  const drafts = input.replies.flatMap(reply => {
    if (reply.state !== 'done') return [];
    const requests=(input.requests ?? []).filter(request=>request.sourceSlots.includes(reply.slot));
    const parsed = parseReport({kind: input.kind, source: reply.slot, text: reply.text,expectedRequestIds:requests.map(request=>request.requestId)});
    if (!parsed.ok) throw new Error('Saved report is invalid: ' + parsed.failure.detail);
    for(const confirmation of parsed.confirmations ?? []) {
      const request=requests.find(request=>request.requestId===confirmation.requestId)!;
      confirmations.push({...request,sourceSlot:reply.slot,responder:reply.responder,decision:confirmation.decision,replyRationale:confirmation.rationale});
    }
    return parsed.findings;
  });
  const findings: ReviewedFinding[] = [...collectFindings(input.round, drafts).filter(finding => !finding.dupOf), ...(input.redGaps ?? [])];
  const escalations: RecordInput[] = [];
  if(input.spec && input.roster) {
    const current:ConfirmationRound={review:input.review,metadata:{round:input.round,cap:input.cap,generation:input.generation,startSeq:input.startSeq,target:input.target,spec:input.spec,roster:input.roster,requests:input.requests ?? []},findings:{review:input.review,round:input.round,cap:input.cap,level:input.level,findings:[],clusters:[],failed:[],confirmations}};
    for(const state of rejectionState([...(input.confirmationRounds ?? []),current],input.rulings,input.escalationRecords ?? []))if(state.state!=='confirmed' && (state.noResponses>=2 || state.disagreements>=2 && confirmations.some(reply=>reply.finding===state.request.finding && reply.decision==='disagree'))) {
      const id='rejection:'+input.review+':'+state.request.finding;
      escalations.push({kind:'escalation',by:'tool',key:id+':R'+input.round+':g'+input.generation,data:{id,state:'open',summary:state.noResponses>=2?'An assigned source did not reply to MUST rejection '+state.request.finding+' in two consecutive past-cap rounds':'Reviewer disputed MUST rejection '+state.request.finding+' '+state.disagreements+' consecutive times'}});
    }
  }
  for (const finding of findings) {
    const previous = [...input.prior].reverse().flatMap(round => round.findings.map(value => ({round: round.round, value}))).find(prior => matchFinding(key(prior.value), key(finding)));
    if (!previous) continue;
    const ruling = input.rulings.findLast(row => row.seq <= input.startSeq && row.data['subject'] === 'review:' + input.review + ':' + previous.value.id);
    const priorTarget = input.priorTargets[previous.round];
    let changed = typeof input.target === 'string' ? input.target !== priorTarget : typeof priorTarget !== 'string' && input.target.head !== priorTarget?.head;
    if (input.kind === 'code' && input.artifact === 'integration') {
      const file = finding.locus.replace(/:L\d+$/, '');
      const owned = Object.values(input.owners ?? {}).find(paths => paths.includes(file)) ?? [file];
      changed = (input.changedSince?.[previous.round] ?? []).some(file => owned.includes(file));
    }
    if (changed && ruling?.data['ruling'] === 'accepted') {
      finding.recurrence = {of: previous.value.id};
      const id = 'recurrence:' + input.review + ':' + finding.id + ':g' + input.generation;
      escalations.push({kind: 'escalation', by: 'tool', key: id, data: {id, state: 'open', summary: finding.defect}});
    } else finding.unresolved = {of: previous.value.id};
  }
  const clusters = new Map<string, string[]>();
  for (const finding of findings) {
    const file = input.kind === 'code' ? finding.locus.replace(/:L\d+$/, '') : input.artifact;
    clusters.set(file, [...(clusters.get(file) ?? []), finding.id]);
  }
  return {review: input.review, round: input.round, cap: input.cap, level: input.level, findings,
    clusters: [...clusters].map(([file, findings]) => ({file, findings})),
    failed: input.replies.filter((reply): reply is Extract<SlotOutcome, {state: 'failed'}> => reply.state === 'failed'), confirmations, escalations};
}
