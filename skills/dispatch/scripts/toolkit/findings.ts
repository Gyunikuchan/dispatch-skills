import fs from 'node:fs';
import path from 'node:path';
import { collectFindings, matchFinding, parseReport } from './domain/report.ts';
import type { Finding, ReviewKind } from './domain/types.ts';
import type { SlotOutcome } from './fanout.ts';
import type { LedgerRecord, RecordInput } from './records.ts';
import { effectiveSeverity } from './domain/severity.ts';
import type { Fold } from './ledger.ts';
import { parseRepositoryNoteKey } from './ledger.ts';
import { coverageState, type CoverageApplies, type CoverageDecision, type CoverageState } from './coverage.ts';
import { ToolError } from './output.ts';
import { loadRejections, rejectionState, type RejectionRequest, type RejectionReply, type ConfirmationRound } from './confirmations.ts';
export type ReviewTarget = string | {base: string; head: string};
export type ReviewedFinding = Finding & {recurrence?: {of: string}; unresolved?: {of: string}};
export type RepositoryChange = { cwd: string; paths: string[] };
export type RepositoryCheckState = { state: 'unavailable'; reason: string };
export type FindingsValue = {
  review: string; round: number; cap: number; level: string; findings: ReviewedFinding[];
  clusters: {file: string; findings: string[]}[]; failed: Extract<SlotOutcome, {state: 'failed'}>[];
  confirmations?: RejectionReply[];
  repositoryChanges?: RepositoryChange[]; repositoryCheck?: RepositoryCheckState;
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
  repositoryChanges?: RepositoryChange[]; repositoryCheck?: RepositoryCheckState;
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
    failed: input.replies.filter((reply): reply is Extract<SlotOutcome, {state: 'failed'}> => reply.state === 'failed'), confirmations, escalations,
    ...(input.repositoryChanges ? {repositoryChanges: input.repositoryChanges} : {}),
    ...(input.repositoryCheck ? {repositoryCheck: input.repositoryCheck} : {})};
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
export type BudgetCoverage =
  | {state: 'readable'; open: string[]; decision: CoverageDecision; use?: 'free' | 'grant'}
  | {state: 'unreadable'};
export type ReviewBudget = {cap: number; ceiling: number; nextRound: number; asOfSeq: number; state: 'allowed' | 'requires-continuation' | 'requires-ceiling-resolution' | 'escalation-open' | 'requires-coverage-decision'; coverage?: BudgetCoverage};
/** The single admission policy: launch refuses by `state`; status and summaries only report it, opening and granting nothing. */
// Every content report for a round with its durable identity: findings.json
// first, then each generation in numeric order and each attempt file in
// numeric order. A clean generation contributes no identity. A report without
// a numeric asOfSeq keeps identity 0.
export type ReportContent = { seq: number; repositoryChanges?: RepositoryChange[]; repositoryCheck?: RepositoryCheckState };
export function contentReports(session: string, review: string, round: number): ReportContent[] {
  const out: ReportContent[] = [];
  const dir = path.join(session, '.state/reviews', review, 'round-' + round);
  const findings = read<FindingsValue & {asOfSeq?: number; budget?: {asOfSeq?: number}}>(path.join(dir, 'findings.json'));
  const findingsHas = (Array.isArray(findings?.repositoryChanges) && findings.repositoryChanges.length > 0) || !!findings?.repositoryCheck;
  // The finalized findings copy carries the same durable identity as its
  // per-generation checkout report: finalize persists asOfSeq into
  // findings.json, so one per-report decision closes both copies. The budget
  // fallback covers older and hand-written files.
  const findingsSeq = typeof findings?.asOfSeq === 'number' ? findings.asOfSeq
    : typeof findings?.budget?.asOfSeq === 'number' ? findings.budget.asOfSeq : 0;
  if (findingsHas) out.push({ seq: findingsSeq,
    ...(findings?.repositoryChanges ? {repositoryChanges: findings.repositoryChanges} : {}),
    ...(findings?.repositoryCheck ? {repositoryCheck: findings.repositoryCheck} : {}) });
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  const genNumber = (name: string): number => Number(name.slice(4));
  for (const entry of entries.filter(name => /^gen-\d+$/.test(name)).sort((left, right) => genNumber(left) - genNumber(right))) {
    for (const report of checkoutReportsFor(dir, entry)) {
      const reportHas = (Array.isArray(report?.repositoryChanges) && report.repositoryChanges.length > 0) || !!report?.repositoryCheck;
      if (!reportHas) continue;
      out.push({ seq: typeof report?.asOfSeq === 'number' ? report.asOfSeq : 0,
        ...(Array.isArray(report?.repositoryChanges) && report.repositoryChanges.length > 0 ? {repositoryChanges: report.repositoryChanges as RepositoryChange[]} : {}),
        ...(report?.repositoryCheck ? {repositoryCheck: report.repositoryCheck as RepositoryCheckState} : {}) });
    }
  }
  return out;
}

/** Numeric identities of every content report for a round, ascending. */
export function reportSeqs(session: string, review: string, round: number): number[] {
  return [...new Set(contentReports(session, review, round).map(report => report.seq))].sort((left, right) => left - right);
}

/** Closing decisions for a round: per-report suffixed keys. */
export function closingNotesFor(fold: Fold, review: string, round: number): {seq: number; reportSeq: number}[] {
  const out: {seq: number; reportSeq: number}[] = [];
  for (const row of fold.records) {
    if (row.kind !== 'note' || typeof row.key !== 'string') continue;
    const parsed = parseRepositoryNoteKey(row.key);
    if (!parsed || parsed.kind !== 'changes' || parsed.review !== review || parsed.round !== round) continue;
    out.push({seq: row.seq, reportSeq: parsed.reportSeq});
  }
  return out;
}

/** Quoted user rerun decisions for a round, per-report suffixed. */
export function rerunNotesFor(fold: Fold, review: string, round: number): {seq: number; reportSeq: number}[] {
  const out: {seq: number; reportSeq: number}[] = [];
  for (const row of fold.records) {
    if (row.kind !== 'note' || typeof row.key !== 'string') continue;
    const parsed = parseRepositoryNoteKey(row.key);
    if (!parsed || parsed.kind !== 'rerun' || parsed.review !== review || parsed.round !== round) continue;
    if (row.by !== 'user' || !row.quote?.trim()) continue;
    out.push({seq: row.seq, reportSeq: parsed.reportSeq});
  }
  return out;
}

// A suffixed note covers only its named report and needs a strictly later
// note sequence, so an equal-seq report under a reused number stays open.
export function coversReport(note: {seq: number; reportSeq: number}, seq: number): boolean {
  return note.reportSeq === seq && note.seq > seq;
}

/** A round is closed only when every content report has a covering decision. */
export function isReportsClosed(fold: Fold, review: string, round: number, seqs: readonly number[]): boolean {
  if (!seqs.length) return false;
  const notes = closingNotesFor(fold, review, round);
  return seqs.every(seq => notes.some(note => coversReport(note, seq)));
}

// The report a rerun decision acknowledges is its explicit suffix. A later
// report under the same number matches no stale decision.
export function rerunCoverSeq(session: string, review: string, round: number, note: {seq: number; reportSeq: number}): number {
  return note.reportSeq;
}

/** A rerun decision grants only the latest uncovered report of its round: a
 * quoted decision for an earlier or already-closed report grants
 * nothing for the still-open one. */
export function rerunGranted(session: string, fold: Fold, review: string, round: number): boolean {
  const seqs = reportSeqs(session, review, round);
  if (!seqs.length) return false;
  const notes = closingNotesFor(fold, review, round);
  const uncovered = seqs.filter(seq => !notes.some(note => coversReport(note, seq)));
  if (!uncovered.length) return false;
  const current = Math.max(...uncovered);
  return rerunNotesFor(fold, review, round).some(note => rerunCoverSeq(session, review, round, note) === current);
}

// Rerun admission counts per-report suffixed decisions: the shared
// repository-note parser recognizes the suffixed key form, so a documented
// suffixed decision grants its round. The pre-gate stays because admission
// and isRerunRound scope the grant to one named round before binding it to
// the current report via rerunGranted.
export function repositoryRerunRounds(fold: Fold, review: string): number[] {
  const rounds: number[] = [];
  for (const row of fold.records) {
    if (row.kind !== 'note' || typeof row.key !== 'string') continue;
    const parsed = parseRepositoryNoteKey(row.key);
    if (!parsed || parsed.kind !== 'rerun' || parsed.review !== review) continue;
    if (row.by !== 'user' || !row.quote?.trim()) continue;
    rounds.push(parsed.round);
  }
  return rounds;
}

// Every unacknowledged report file of one generation: the first write lands in
// checkout-report.json and each retry in checkout-report-<k>.json, so a later
// clean comparison never erases an earlier report. Numeric attempt order.
export type CheckoutReportRead = {repositoryChanges?: unknown; repositoryCheck?: unknown; asOfSeq?: number};
export function checkoutReportsFor(dir: string, gen: string): CheckoutReportRead[] {
  const attemptNumber = (file: string): number =>
    file === 'checkout-report.json' ? 1 : Number(file.slice('checkout-report-'.length, -'.json'.length));
  let files: string[] = [];
  try {
    files = fs.readdirSync(path.join(dir, gen));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return [];
  }
  return files
    .filter(file => /^checkout-report(-\d+)?\.json$/.test(file))
    .sort((left, right) => attemptNumber(left) - attemptNumber(right))
    .map(file => read<CheckoutReportRead>(path.join(dir, gen, file)))
    .filter((report): report is CheckoutReportRead => report !== null);
}

export function admission(session: string, fold: Fold, review: string, cap: number, applies?: CoverageApplies): {budget: ReviewBudget; rounds: number} {
  const directory = path.join(session, '.state/reviews', review), file = (round: number, name: string) => path.join(directory, 'round-' + round, name);
  const numbers = fs.readdirSync(directory).flatMap(name => /^round-(\d+)$/.test(name) ? [Number(name.slice(6))] : []).sort((a, b) => a - b);
  const last = numbers.at(-1) ?? 0;
  // An all-failed round has no findings.json but keeps its failed report: a
  // quoted rerun note naming it completes its number, so the next call starts
  // the authorized fresh whole-target rerun instead of retrying failed fan-out.
  let completed = last > 0 && fs.existsSync(file(last, 'findings.json'));
  if (!completed && last > 0 && repositoryRerunRounds(fold, review).includes(last)) {
    const seqs = reportSeqs(session, review, last);
    if (seqs.length && !isReportsClosed(fold, review, last, seqs) && rerunGranted(session, fold, review, last)) completed = true;
  }
  const n = completed ? last + 1 : last || 1;
  const cap1 = read<{cap: number}>(file(1, 'round.json'))?.cap ?? cap, ceiling = ceilingState(fold.records, review, cap1);
  const rulings = fold.records.filter(row => row.kind === 'ruling'), startSeq = read<{startSeq?: number}>(file(n - 1, 'round.json'))?.startSeq ?? 0;
  const rejections = loadRejections(session, fold, [review]), pending = rejections.some(state => state.state === 'pending');
  const fixed = numbers.some(number => read<FindingsValue>(file(number, 'findings.json'))?.findings.some(finding => {
    const history = rulings.filter(row => row.data['subject'] === 'review:' + review + ':' + finding.id), ruling = history.at(-1);
    return effectiveSeverity(finding, history) === 'MUST' && ruling?.data['ruling'] === 'accepted' && (number === n - 1 || ruling.seq > startSeq);
  }));
  const past = completed && n > ceiling.ceiling;
  // Defer grants no rounds; a pending MUST rejection keeps its confirmation round.
  let state: ReviewBudget['state'] = rejections.some(state => state.state === 'escalated') || (completed && ceiling.open) ? 'escalation-open'
    : n > cap1 && ((!fixed && !pending) || (past && ceiling.deferred && !pending)) ? 'requires-continuation'
    : past && !ceiling.deferred ? 'requires-ceiling-resolution' : 'allowed';
  // A user rerun note admits its named round + 1 once above the cap and below the
  // ceiling. Escalation and ceiling checks above stay first; other rounds keep no grant.
  if (state === 'requires-continuation' && n > cap1 && n <= ceiling.ceiling) {
    const reruns = repositoryRerunRounds(fold, review);
    const seqs = reportSeqs(session, review, n - 1);
    if (
      reruns.includes(n - 1) &&
      seqs.length > 0 &&
      !isReportsClosed(fold, review, n - 1, seqs) &&
      rerunGranted(session, fold, review, n - 1)
    ) {
      state = 'allowed';
    }
  }
  // SECTION: Coverage rows (code-integration only); escalation, ceiling and accepted-MUST rules stay first.
  let coverage: BudgetCoverage | undefined, use: 'free' | 'grant' | undefined, folded: CoverageState | undefined;
  if (review === 'code-integration') {
    try { folded = coverageState(session, fold, review, applies); }
    catch (error) { if (!(error instanceof ToolError && error.reason === 'coverage-required')) throw error; coverage = {state: 'unreadable'}; }
  }
  if (folded) {
    const saved = folded.incomplete === n ? read<{coverageUse?: 'free' | 'grant'}>(file(n, 'round.json'))?.coverageUse : undefined;
    if ((state === 'allowed' || state === 'requires-continuation') && !past) {
      if (saved) {state = 'allowed'; use = saved;}
      else if (!fixed && !pending && folded.open.length && n !== last) {
        const grant = folded.unusedGrant ? 'grant' as const : undefined;
        if (folded.decision === 'user') [state, use] = grant ? ['allowed', grant] : ['requires-coverage-decision', undefined];
        else if (n <= cap1) state = 'allowed';
        else if (!folded.freeUsed) [state, use] = ['allowed', 'free'];
        else if (grant) [state, use] = ['allowed', grant];
        else if (folded.decision === 'rerun') state = 'requires-coverage-decision';
      }
    }
    // NOTE: past the ceiling no round can run, so only the user's accept can settle a slot that delivery refuses.
    else if (state === 'requires-continuation' && past && folded.open.length && folded.decision !== 'majority') state = 'requires-coverage-decision';
    if (folded.open.length || folded.incomplete !== null) coverage = {state: 'readable', open: folded.open, decision: folded.decision, ...(use ? {use} : {})};
  }
  return {budget: {cap: cap1, ceiling: ceiling.ceiling, nextRound: n, asOfSeq: fold.lastSeq, state, ...(coverage ? {coverage} : {})}, rounds: numbers.length};
}
export const renderBudget = (budget: ReviewBudget) => `next round ${budget.nextRound} ${budget.state} (cap ${budget.cap}, ceiling ${budget.ceiling})`
  + (!budget.coverage ? '' : budget.coverage.state === 'unreadable' ? '; coverage unreadable' : `; coverage ${budget.coverage.decision}, open: ${budget.coverage.open.join(', ') || 'none'}`);
