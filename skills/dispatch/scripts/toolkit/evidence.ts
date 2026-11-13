import type { PlanCriterion } from './domain/types.ts';
import type { Fold } from './ledger.ts';
import type { Check } from './plan-view.ts';

/** Criteria whose tests a cleanup commit removed keep their evidence at their recorded tree. */
export type CleanupBinding = {from:string; fromTree:string; removed:string[]; trees:Record<string,string>};
export type CleanupEvidenceResult =
  | { ok: true; trees: Record<string, string> }
  | { ok: false; stale: string[] };
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

export function strictEvidence(fold: Fold, check: Check): EvidenceRecord | undefined {
  if (check.evidenceClass === 'review') return undefined;
  const row = fold.records.findLast((r) => r.kind === 'evidence' && r.data['criterion'] === check.criterion && r.data['commandDigest'] === check.commandDigest);
  return row && row.data['exit'] === 0 && row.data['clean'] === true && row.data['before'] === row.data['after'] && typeof row.data['tree'] === 'string' && row.data['tree'] ? row : undefined;
}

const normalizePath = (value: string) => value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');

export function matchesDeclared(diffPath: string, declared: readonly string[]): boolean {
  const target = normalizePath(diffPath);
  return declared.some((entry) => {
    const base = normalizePath(entry);
    return !!base && (target === base || target.startsWith(base + '/'));
  });
}

/** Cleanup evidence rule: latest clean passing evidence per criterion, with no declared-own or undeclared path changes since that tree. */
export function cleanupEvidence(
  fold: Fold,
  checks: readonly Check[],
  criteria: readonly Pick<PlanCriterion, 'id' | 'changes' | 'tests'>[],
  removed: readonly string[],
  fromTree: string,
  diffs: ReadonlyMap<string, readonly string[]>,
): CleanupEvidenceResult {
  const checkById = new Map(checks.map((check) => [check.criterion, check]));
  const criterionById = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const allDeclared = criteria.flatMap((criterion) => [...criterion.changes, ...criterion.tests]);
  const trees: Record<string, string> = {};
  const stale: string[] = [];

  for (const id of removed) {
    const criterion = criterionById.get(id);
    const check = checkById.get(id);
    const record = criterion && check ? strictEvidence(fold, check) : undefined;
    if (!criterion || !record) {
      stale.push(id);
      continue;
    }
    const tree = String(record.data['tree']);
    if (tree === fromTree) {
      trees[id] = tree;
      continue;
    }
    const changed = diffs.get(tree);
    if (!changed) {
      stale.push(id);
      continue;
    }
    const own = [...criterion.changes, ...criterion.tests];
    if (changed.some((file) => matchesDeclared(file, own) || !matchesDeclared(file, allDeclared))) {
      stale.push(id);
      continue;
    }
    trees[id] = tree;
  }

  return stale.length ? { ok: false, stale } : { ok: true, trees };
}

function eligibleEvidence(fold: Fold, check: Check, current: CurrentTree, strict=false): EvidenceRecord | undefined {
  if (check.evidenceClass === 'review') return undefined;
  if (current.testedTree !== current.headTree) return undefined;
  if (strict) {
    const row = strictEvidence(fold, check);
    return row && row.data['tree'] === current.headTree ? row : undefined;
  }
  return fold.records.findLast(({ kind, data }) => kind === 'evidence' &&
    data['criterion'] === check.criterion && data['exit'] === 0 && data['clean'] === true &&
    data['before'] === data['after'] && data['tree'] === current.headTree &&
    data['commandDigest'] === check.commandDigest);
}

export function eligibility(fold: Fold, checks: readonly Check[], current: CurrentTree, strict=false) {
  return checks.map((check) => ({
    criterion: check.criterion,
    state: eligibleEvidence(fold, check, current,strict) ? 'verified' as const : 'missing' as const,
  }));
}

export function latestCleanup(fold: Fold): EvidenceRecord | undefined {
  return fold.records.findLast(r=>r.kind==='integrate'&&r.data['phase']==='test-cleanup');
}

export function cleanupBinding(fold: Fold): CleanupBinding | null {
  const record=latestCleanup(fold);
  return record ? {from:record.data['from'],fromTree:record.data['fromTree'],removed:record.data['removed'],trees:record.data['trees']??{}} : null;
}

function boundEvidence(fold: Fold, check: Check, current: CurrentTree | null, cleanup: CleanupBinding | null | undefined, strict: boolean): EvidenceRecord | undefined {
  const row=current ? eligibleEvidence(fold,check,current,strict) : undefined;
  if(row || !cleanup?.removed.includes(check.criterion)) return row;
  const tree=cleanup.trees&&Object.hasOwn(cleanup.trees,check.criterion)?cleanup.trees[check.criterion]:undefined;
  if(!tree) return undefined;
  return eligibleEvidence(fold,check,{headTree:tree,testedTree:tree},true);
}

export function verifiedStage(fold:Fold, checks:readonly Check[], current:CurrentTree, cleanup?:CleanupBinding|null):boolean {
  return checks.filter(check=>check.evidenceClass!=='review').every(check=>!!boundEvidence(fold,check,current,cleanup,true));
}

export function criterionStatuses(fold: Fold, checks: readonly Check[], current: CurrentTree | null, cleanup?: CleanupBinding | null): CriterionStatus[] {
  return checks.map((check) => {
    const evidence = boundEvidence(fold,check,current,cleanup,false);
    if (evidence) {
      return {
        criterion: check.criterion,
        state: 'verified',
        ...(cleanup?.removed.includes(check.criterion) ? {reason:'verified at '+cleanup.trees[check.criterion]+'; tests removed in cleanup'} : {}),
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
