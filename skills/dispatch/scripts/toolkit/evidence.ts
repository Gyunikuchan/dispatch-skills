import { stableValue } from './domain/stable-value.ts';
import type { Fold } from './ledger.ts';
import type { Check } from './plan-view.ts';

export type PruneEvidence = {sourceTree:string; tree:string; pre:Check[]; final:Check[]; transient:string[]; sourceSeq:number; artifacts:unknown};
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

function eligibleEvidence(fold: Fold, check: Check, current: CurrentTree, strict=false): EvidenceRecord | undefined {
  if (current.testedTree !== current.headTree) return undefined;
  if(strict || check.criterion.startsWith('final:')) {
    const row=fold.records.findLast(r=>r.kind==='evidence'&&r.data['criterion']===check.criterion&&r.data['commandDigest']===check.commandDigest);
    return row && row.data['exit']===0 && row.data['clean']===true && row.data['before']===row.data['after'] && row.data['tree']===current.headTree ? row : undefined;
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

export function verifiedStage(fold:Fold, checks:readonly Check[], current:CurrentTree, artifacts:unknown):boolean {
  return checks.every(check=>{
    const row=eligibleEvidence(fold,check,current,true);
    return !!row && stableValue(row.data['artifacts'])===stableValue(artifacts);
  });
}

export function criterionStatuses(fold: Fold, checks: readonly Check[], current: CurrentTree | null, prune?: PruneEvidence | null): CriterionStatus[] {
  const history=prune ? {...fold,records:fold.records.filter(r=>r.seq<prune.sourceSeq)} : fold;
  const source=prune ? {headTree:prune.sourceTree,testedTree:prune.sourceTree} : null;
  const allFinal=prune && current && current.headTree===prune.tree && verifiedStage(fold,prune.final,current,prune.artifacts);
  return checks.filter(check=>!prune || check.criterion!=='contract' || check.commands.length).map((check) => {
    const projected=prune?.final.find(c=>c.criterion==='final:'+check.criterion);
    const historical=prune?.transient.includes(check.criterion);
    const original=prune?.pre.find(c=>c.criterion===check.criterion && c.commandDigest===check.commandDigest);
    const evidence = prune ? allFinal && (historical ? original && verifiedStage(history,[original],source!,prune.artifacts) && eligibleEvidence(history,original,source!,true) : projected && current && eligibleEvidence(fold,projected,current)) : current && eligibleEvidence(fold,check,current);
    if (evidence) {
      return {
        criterion: check.criterion,
        state: 'verified',
        ...(historical ? {reason:'historical pre-prune evidence via validated pruning; source tree '+prune!.sourceTree+'; final evidence '+prune!.final.map(c=>'['+c.criterion+']('+eligibleEvidence(fold,c,current!)?.data['path']+')').join(', ')} : {}),
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
