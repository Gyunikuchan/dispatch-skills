import type { Fold } from './ledger.ts';
import type { LedgerRecord } from './records.ts';

export const integrationRecord = (fold: Fold) => fold.records.findLast(r=>r.kind==='integrate' && r.data['phase']==='opened');
export function integrationEnded(fold: Fold, task: string, after: number): boolean {
  return fold.records.some(row => row.kind === 'integrate' && row.seq > after &&
    row.data['task'] === task && ['done', 'abandoned'].includes(row.data['phase']));
}

export function pendingIntegration(fold: Fold): LedgerRecord | undefined {
  return fold.records.findLast(row => row.kind === 'integrate' && row.data['phase'] === 'started' &&
    !integrationEnded(fold, row.data['task'], row.seq));
}

export function currentRuntimeVerification(fold: Fold, openingSeq: number): LedgerRecord | undefined {
  const proof = fold.records.findLast(row => row.seq > openingSeq && row.kind === 'integrate' && row.data['phase'] === 'verification');
  if (!proof || proof.data['open'].length) return undefined;
  const invalidated = fold.records.some(row => row.seq > proof.seq && row.kind === 'ruling' &&
    row.data['subject'].startsWith('verification:') && row.data['ruling'] === 'accepted');
  return invalidated ? undefined : proof;
}
