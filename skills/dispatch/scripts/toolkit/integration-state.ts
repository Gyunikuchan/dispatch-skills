import type { Fold } from './ledger.ts';
import { textValue } from './narrow.ts';
import type { LedgerRecord } from './records.ts';

export const integrationRecord = (fold: Fold) =>
  fold.records.findLast((r) => r.kind === 'integrate' && r.data['phase'] === 'opened');
export function integrationEnded(fold: Fold, task: string, after: number): boolean {
  return fold.records.some(
    (row) =>
      row.kind === 'integrate' &&
      row.seq > after &&
      row.data['task'] === task &&
      (row.data['phase'] === 'done' || row.data['phase'] === 'abandoned'),
  );
}

export function pendingIntegration(fold: Fold): LedgerRecord | undefined {
  return fold.records.findLast(
    (row) =>
      row.kind === 'integrate' &&
      row.data['phase'] === 'started' &&
      !integrationEnded(fold, textValue(row.data['task']), row.seq),
  );
}

export function currentRuntimeVerification(fold: Fold, openingSeq: number): LedgerRecord | undefined {
  const proof = fold.records.findLast(
    (row) => row.seq > openingSeq && row.kind === 'integrate' && row.data['phase'] === 'verification',
  );
  const open: unknown = proof?.data['open'];
  if (!proof || !Array.isArray(open) || open.length) {
    return undefined;
  }
  const invalidated = fold.records.some(
    (row) =>
      row.seq > proof.seq &&
      row.kind === 'ruling' &&
      textValue(row.data['subject']).startsWith('verification:') &&
      row.data['ruling'] === 'accepted',
  );
  return invalidated ? undefined : proof;
}
