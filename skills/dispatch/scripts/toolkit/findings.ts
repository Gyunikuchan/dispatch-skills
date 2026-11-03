import fs from 'node:fs';
import path from 'node:path';
import { collectFindings, matchFinding, parseReport } from './domain/report.ts';
import type { Finding, ReviewKind } from './domain/types.ts';
import type { SlotOutcome } from './fanout.ts';
import type { LedgerRecord, RecordInput } from './records.ts';
import { effectiveSeverity } from './domain/severity.ts';
import type { Fold } from './ledger.ts';
import { loadRejections, rejectionState, type RejectionRequest, type RejectionReply, type ConfirmationRound } from './confirmations.ts';
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
// SECTION: Review budget
export function read<T>(file: string): T | null {
  try {return JSON.parse(fs.readFileSync(file, 'utf8')) as T;}
  catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;}
}
const CEILING_GRANT = /^(?:re-author|model-effort|relax-split):/;
/**
 * cap₁ + 2 + 2 × R, where R counts ceiling ids that a tool opened and a later quoted user grant resolved.
 * Defer grants nothing and applies only to the current ceiling id.
 */
function ceilingState(records: readonly LedgerRecord[], review: string, cap1: number) {
  const prefix = 'ceiling:' + review + ':';
  const opened = new Map<string, number>(), state = new Map<string, string>(), grants = new Set<string>(), defers = new Set<string>();
  for (const row of records) {
    if (row.kind !== 'escalation') continue;
    const id = row.data['id'];
    if (typeof id !== 'string' || !id.startsWith(prefix)) continue;
    state.set(id, row.data['state']);
    if (row.by === 'tool' && row.data['state'] === 'open' && !opened.has(id)) opened.set(id, row.seq);
    if (row.by !== 'user' || row.data['state'] !== 'resolved' || !row.quote?.trim() || row.seq <= (opened.get(id) ?? Infinity)) continue;
    const summary = String(row.data['summary'] ?? '');
    if (CEILING_GRANT.test(summary)) grants.add(id);
    else if (summary.startsWith('defer:')) defers.add(id);
  }
  const ceiling = cap1 + 2 + 2 * grants.size;
  return {ceiling, deferred: defers.has(prefix + ceiling), open: [...state.values()].includes('open')};
}
export type ReviewBudget = {cap: number; ceiling: number; nextRound: number; asOfSeq: number; state: 'allowed' | 'requires-continuation' | 'requires-ceiling-resolution' | 'escalation-open'};
/** The single admission policy: launch refuses by `state`; status and summaries only report it, opening and granting nothing. */
export function admission(session: string, fold: Fold, review: string, cap: number): {budget: ReviewBudget; rounds: number} {
  const directory = path.join(session, '.state/reviews', review), file = (round: number, name: string) => path.join(directory, 'round-' + round, name);
  const numbers = fs.readdirSync(directory).flatMap(name => /^round-(\d+)$/.test(name) ? [Number(name.slice(6))] : []).sort((a, b) => a - b);
  const last = numbers.at(-1) ?? 0, completed = last > 0 && fs.existsSync(file(last, 'findings.json')), n = completed ? last + 1 : last || 1;
  const cap1 = read<{cap: number}>(file(1, 'round.json'))?.cap ?? cap, ceiling = ceilingState(fold.records, review, cap1);
  const rulings = fold.records.filter(row => row.kind === 'ruling'), startSeq = read<{startSeq?: number}>(file(n - 1, 'round.json'))?.startSeq ?? 0;
  const rejections = loadRejections(session, fold, [review]), pending = rejections.some(state => state.state === 'pending');
  const fixed = numbers.some(number => read<FindingsValue>(file(number, 'findings.json'))?.findings.some(finding => {
    const history = rulings.filter(row => row.data['subject'] === 'review:' + review + ':' + finding.id), ruling = history.at(-1);
    return effectiveSeverity(finding, history) === 'MUST' && ruling?.data['ruling'] === 'accepted' && (number === n - 1 || ruling.seq > startSeq);
  }));
  const past = completed && n > ceiling.ceiling;
  // Defer grants no rounds; a pending MUST rejection keeps its confirmation round.
  const state: ReviewBudget['state'] = rejections.some(state => state.state === 'escalated') || (completed && ceiling.open) ? 'escalation-open'
    : n > cap1 && ((!fixed && !pending) || (past && ceiling.deferred && !pending)) ? 'requires-continuation'
    : past && !ceiling.deferred ? 'requires-ceiling-resolution' : 'allowed';
  return {budget: {cap: cap1, ceiling: ceiling.ceiling, nextRound: n, asOfSeq: fold.lastSeq, state}, rounds: numbers.length};
}
export const renderBudget = (budget: ReviewBudget) => `next round ${budget.nextRound} ${budget.state} (cap ${budget.cap}, ceiling ${budget.ceiling})`;
