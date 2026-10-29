import fs from 'node:fs';
import path from 'node:path';
import { assembleTemplate, fillTemplate, qualityBar, rotateTags, settledSection, type Settled } from './domain/prompt.ts';
import type { RejectionRequest } from './confirmations.ts';
import type { ReviewKind } from './domain/types.ts';
import { structuralLines } from './domain/plan.ts';

export { settledSection, type Settled } from './domain/prompt.ts';

function sections(source: string, subsections: boolean): Map<string, string> {
  const sections = new Map<string, string>();
  let heading = '', body: string[] = [], ignored = false;
  const save = () => {if (heading) sections.set(heading, body.join('\n').trim());};
  for (const line of structuralLines(source)) {
    const match = !line.fenced ? /^(#{2,3})\s+(.+?)\s*$/.exec(line.text) : null;
    if (subsections && match?.[1] === '##') ignored = ['Review Findings & Resolutions', 'Execution Status'].includes(match[2]!);
    if (match && (subsections || match[1] === '##')) {
      save(); heading = ignored ? '' : match[2]!; body = [];
    } else if (!ignored) body.push(line.original);
  }
  save(); return sections;
}

export function artifactSections(source: string): Map<string, string> {return sections(source, false);}

export function changedHeadings(before: string, after: string): string[] {
  const previous = sections(before, true), current = sections(after, true);
  return [...new Set([...current.keys(), ...previous.keys()])].filter(heading =>
    !['Review Findings & Resolutions', 'Execution Status'].includes(heading) && previous.get(heading) !== current.get(heading));
}

export function reviewPrompt(kind: ReviewKind, context: {
  skillRoot: string; spec: {path: string; hash: string}; artifact: string; planPath?: string;
  taskSummary?: string; scope: string; settled?: readonly Settled[]; requests?: readonly RejectionRequest[]; rotation?: number;
}): string {
  const directory = path.join(context.skillRoot, 'references/templates');
  const read = (name: string) => fs.readFileSync(path.join(directory, name), 'utf8');
  const kindBlock = read('review-prompt-' + kind + '.md');
  const tags = sections(kindBlock, false).get('tags');
  const rotatedKindBlock = tags === undefined ? kindBlock : kindBlock.replace(tags, rotateTags(tags, context.rotation ?? 0));
  const template = assembleTemplate(read('review-prompt.md'), rotatedKindBlock, undefined, [qualityBar(read('quality-bar.md'), kind, context.rotation ?? 0)]);
  const values: Record<string, string> = {
    'Spec Path': context.spec.path, 'Spec Hash': context.spec.hash,
    'Review Scope': context.scope, 'User Focus Areas': 'General review', 'Tool Turn Budget': 'Unspecified',
    ...(kind === 'plan' ? {'Plan Path': context.artifact} : kind === 'design' ? {'Design Path': context.artifact} : {
      'Plan Path': context.planPath ?? 'None', 'Task Summary': context.taskSummary ?? 'Review the selected changes.',
    }),
  };
  const requests=context.requests ?? [];
  const confirmation=requests.length?'\n\n### Pending MUST rejection confirmation\nReview each original claim and the host evidence. Add confirmations to the JSON report: [{"requestId":"<assigned ID>","decision":"agree|disagree","rationale":"<nonblank evidence-based reason>"}]. Answer every assigned request exactly once. Ordinary findings remain required.\n'+requests.map(request=>`\nRequest ID: \`${request.requestId}\`\nOriginal finding: ${request.finding} ${request.claim.locus}: ${request.claim.defect}\nRequired change: ${request.claim.requiredChange}\nHost rejection: ${request.rationale}\n`).join(''):'';
  return fillTemplate(template.template, template.variables, values) + settledSection(context.settled ?? [])+confirmation;
}
