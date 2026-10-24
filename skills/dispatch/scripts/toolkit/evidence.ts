import type { Fold } from './ledger.ts';
import type { Check } from './plan-view.ts';

type CurrentTree = { headTree: string; testedTree: string };
type EvidenceRecord = Fold['records'][number];
export type CriterionStatus = {
  criterion: string;
  state: 'verified' | 'manual' | 'waived' | 'missing';
  seq?: number;
  quote?: string;
  evidence?: string;
  reason?: string;
};

function eligibleEvidence(fold: Fold, check: Check, current: CurrentTree): EvidenceRecord | undefined {
  if (current.testedTree !== current.headTree) return undefined;
  return fold.records.findLast(({ kind, data }) => kind === 'evidence' &&
    data['criterion'] === check.criterion && data['exit'] === 0 && data['clean'] === true &&
    data['before'] === data['after'] && data['tree'] === current.headTree &&
    data['commandDigest'] === check.commandDigest);
}

export function eligibility(fold: Fold, checks: readonly Check[], current: CurrentTree) {
  return checks.map((check) => ({
    criterion: check.criterion,
    state: eligibleEvidence(fold, check, current) ? 'verified' as const : 'missing' as const,
  }));
}

export function criterionStatuses(fold: Fold, checks: readonly Check[], current: CurrentTree | null): CriterionStatus[] {
  return checks.map((check) => {
    const evidence = current && eligibleEvidence(fold, check, current);
    if (evidence) {
      return {
        criterion: check.criterion,
        state: 'verified',
        ...(typeof evidence.data['path'] === 'string' ? { evidence: evidence.data['path'] } : {}),
      };
    }

    const manual = fold.records.findLast((record) => record.kind === 'manual-complete' && record.data['criterion'] === check.criterion);
    if (manual) {
      return {
        criterion: check.criterion,
        state: 'manual',
        seq: manual.seq,
        ...(typeof manual.quote === 'string' ? { quote: manual.quote } : {}),
        ...(typeof manual.data['evidence'] === 'string' ? { evidence: manual.data['evidence'] } : {}),
      };
    }

    const waiver = fold.records.findLast((record) => record.kind === 'waiver' && record.data['criterion'] === check.criterion);
    if (waiver) {
      return {
        criterion: check.criterion,
        state: 'waived',
        seq: waiver.seq,
        ...(typeof waiver.quote === 'string' ? { quote: waiver.quote } : {}),
        ...(typeof waiver.data['reason'] === 'string' ? { reason: waiver.data['reason'] } : {}),
      };
    }

    return { criterion: check.criterion, state: 'missing' };
  });
}
