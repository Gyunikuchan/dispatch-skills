import type {ParsedPlan} from './domain/types.ts';

export function redGaps(input: {plan: ParsedPlan; task: string; changed: readonly string[]; report?: string | undefined}): {criterion: string; line: number; testsTouched: boolean}[] {
  const task=input.plan.tasks.find(task=>task.id===input.task);
  const lines=(input.report??'').split(/\r?\n/);
  const start=lines.findIndex(line=>line==='## Observed RED failures');
  const section=start<0?'':lines.slice(start+1).join('\n').split(/^#{1,2} /m)[0]!;
  return input.plan.criteria.filter(c=>task?.criteria.includes(c.id)&&c.evidence==='red'&&c.red&&!c.redException)
    .filter(c=>!new RegExp('(?:^|[^A-Za-z0-9])'+c.id+'(?:$|[^A-Za-z0-9])').test(section)&&!c.tests.some(file=>section.includes(file)))
    .map(c=>({criterion:c.id,line:c.line,testsTouched:c.tests.some(file=>input.changed.includes(file))}));
}
