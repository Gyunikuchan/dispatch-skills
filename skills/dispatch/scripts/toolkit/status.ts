import { currentHashes, foldLedger, gate, latest } from './ledger.ts';

export function statusReport(session: string, repositoryRoot: string) {
  const fold = foldLedger(session);
  const level = latest(fold, 'level')?.data['level'] ?? 'medium';
  const bound = latest(fold, 'bind')?.data ?? {};
  const current = currentHashes(repositoryRoot, bound);
  const escalations = new Map<string, Record<string, unknown>>();
  for (const record of fold.records) {
    if (record.kind === 'escalation') escalations.set(record.data['id'], record.data);
  }
  return {
    level, bound, current, approved: latest(fold, 'approval')?.data ?? {},
    gate: gate(fold, current, level),
    escalations: [...escalations.values()].filter(record => record['state'] === 'open'),
    recordCount: fold.records.length, tornTail: fold.torn !== null,
  };
}
