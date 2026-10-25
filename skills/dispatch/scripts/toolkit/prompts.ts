import fs from 'node:fs';
import path from 'node:path';
import { assembleTemplate, fillTemplate, qualityBar } from './domain/prompt.ts';
import type { ReviewKind } from './domain/types.ts';
import { structuralLines } from './domain/plan.ts';

export type Settled = {id: string; locus: string; defect: string; ruling: string; reason: string};

export function settledSection(settled: readonly Settled[]): string {
  if (!settled.length) return '';
  const clip = (value: string) => value.length > 200 ? `${value.slice(0, 199)}…` : value;
  const rows = settled.map(entry => `- ${entry.id} ${entry.locus}: ${clip(entry.defect)} — ${entry.ruling}: ${entry.reason || 'no reason recorded'}`);
  return `\n\n### Settled in earlier rounds\nRe-raise a settled point only with new evidence that the ruling missed.\n${rows.join('\n')}\n`;
}

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
  taskSummary?: string; scope: string; settled?: readonly Settled[];
}): string {
  const directory = path.join(context.skillRoot, 'references/templates');
  const read = (name: string) => fs.readFileSync(path.join(directory, name), 'utf8');
  const template = assembleTemplate(read('review-prompt.md'), read('review-prompt-' + kind + '.md'), undefined, [qualityBar(read('quality-bar.md'), kind)]);
  const values: Record<string, string> = {
    'Spec Path': context.spec.path, 'Spec Hash': context.spec.hash,
    'Review Scope': context.scope, 'User Focus Areas': 'General review', 'Tool Turn Budget': 'Unspecified',
    ...(kind === 'plan' ? {'Plan Path': context.artifact} : kind === 'design' ? {'Design Path': context.artifact} : {
      'Plan Path': context.planPath ?? 'None', 'Walkthrough Path': 'None', 'Task Summary': context.taskSummary ?? 'Review the selected changes.',
    }),
  };
  return fillTemplate(template.template, template.variables, values) + settledSection(context.settled ?? []);
}
