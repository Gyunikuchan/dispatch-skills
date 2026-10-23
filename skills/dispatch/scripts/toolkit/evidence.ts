import type { Fold } from './ledger.ts';
import type { Check } from './plan-view.ts';
export function eligibility(fold: Fold, checks: readonly Check[], current: {headTree: string; testedTree: string}) {
  return checks.map(check=>({
    criterion:check.criterion,
    state: current.testedTree === current.headTree && fold.records.some(({kind,data})=>
      kind==='evidence' && data['criterion']===check.criterion && data['exit']===0 && data['clean']===true &&
      data['before']===data['after'] && data['tree']===current.headTree && data['commandDigest']===check.commandDigest) ? 'verified' as const : 'missing' as const,
  }));
}
