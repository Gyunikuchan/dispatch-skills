import { collectFindings, matchFinding, parseReport } from './domain/report.ts';
import type { Finding, ReviewKind } from './domain/types.ts';
import type { SlotOutcome } from './fanout.ts';
import type { LedgerRecord, RecordInput } from './records.ts';
export type ReviewTarget = string | {base: string; head: string};
export type ReviewedFinding = Finding & {recurrence?: {of: string}; unresolved?: {of: string}};
export type FindingsValue = {
  review: string; round: number; cap: number; level: string; findings: ReviewedFinding[];
  clusters: {file: string; findings: string[]}[]; failed: Extract<SlotOutcome, {state: 'failed'}>[];
};
export type Finalized = FindingsValue & {escalations: RecordInput[]};
const key = (finding: Finding) => ({locus: finding.locus, category: finding.category, text: finding.defect + ' ' + finding.requiredChange});
export function finalizeRound(input: {
  review: string; round: number; generation: number; cap: number; level: string; startSeq: number;
  replies: readonly SlotOutcome[]; redGaps?: readonly Finding[]; prior: readonly FindingsValue[];
  priorTargets: Record<number, ReviewTarget>; changedSince?: Record<number, readonly string[]>;
  owners?: Record<string, readonly string[]>; rulings: readonly LedgerRecord[];
  kind: ReviewKind; artifact: string; target: ReviewTarget;
}): Finalized {
  const drafts = input.replies.flatMap(reply => {
    if (reply.state !== 'done') return [];
    const parsed = parseReport({kind: input.kind, source: reply.slot, text: reply.text});
    if (!parsed.ok) throw new Error('Saved report is invalid: ' + parsed.failure.detail);
    return parsed.findings;
  });
  const findings: ReviewedFinding[] = [...collectFindings(input.round, drafts).filter(finding => !finding.dupOf), ...(input.redGaps ?? [])];
  const escalations: RecordInput[] = [];
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
    failed: input.replies.filter((reply): reply is Extract<SlotOutcome, {state: 'failed'}> => reply.state === 'failed'), escalations};
}
