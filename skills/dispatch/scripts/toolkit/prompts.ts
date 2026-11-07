import fs from 'node:fs';
import path from 'node:path';
import { assembleTemplate, fillTemplate, qualityBar, rotateTags, settledSection, type Settled } from './domain/prompt.ts';
import type { RejectionRequest } from './confirmations.ts';
import type { ReviewKind } from './domain/types.ts';
import type { ReviewTarget } from './findings.ts';
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
  taskSummary?: string; scope: string; turnTarget: number; contextMapPath?: string; settled?: readonly Settled[]; requests?: readonly RejectionRequest[]; rotation?: number;
}): string {
  const directory = path.join(context.skillRoot, 'references/templates');
  const read = (name: string) => fs.readFileSync(path.join(directory, name), 'utf8');
  const kindBlock = read('review-prompt-' + kind + '.md');
  const tags = sections(kindBlock, false).get('tags');
  const rotatedKindBlock = tags === undefined ? kindBlock : kindBlock.replace(tags, rotateTags(tags, context.rotation ?? 0));
  const template = assembleTemplate(read('review-prompt.md'), rotatedKindBlock, undefined, [qualityBar(read('quality-bar.md'), kind, context.rotation ?? 0), read('review-severity.md')]);
  // NOTE: the map is a pre-change index, so code reviews never receive it; a leading newline keeps an absent map from leaving a blank line.
  const contextMap = context.contextMapPath ? `\n- Context Map: ${context.contextMapPath} — pre-change index; verify claims at source.` : '';
  const values: Record<string, string> = {
    'Spec Path': context.spec.path, 'Spec Hash': context.spec.hash,
    'Review Scope': context.scope, 'User Focus Areas': 'General review', 'Tool Turn Budget': String(context.turnTarget),
    ...(kind === 'plan' ? {'Plan Path': context.artifact, 'Context Map': contextMap} : kind === 'design' ? {'Design Path': context.artifact, 'Context Map': contextMap} : {
      'Plan Path': context.planPath ?? 'None', 'Task Summary': context.taskSummary ?? 'Review the selected changes.',
    }),
  };
  const requests=context.requests ?? [];
  const confirmation=requests.length?'\n\n### Pending MUST rejection confirmation\nReview each original claim and the host evidence. Add `confirmations` to the JSON report with exactly `requestId`, `decision` (`agree|disagree`), and a nonblank evidence-backed `rationale`: [{"requestId":"<assigned ID>","decision":"agree|disagree","rationale":"<nonblank evidence-based reason>"}]. Answer every assigned request exactly once. Keep ordinary `status` and `findings`. A pending MUST rejection is open until explicit agreement; omission is not confirmation.\n'+requests.map(request=>`\nRequest ID: \`${request.requestId}\`\nOriginal finding: ${request.finding} ${request.claim.locus}: ${request.claim.defect}\nRequired change: ${request.claim.requiredChange}\nHost rejection: ${request.rationale}\n`).join(''):'';
  return fillTemplate(template.template, template.variables, values) + settledSection(context.settled ?? [])+confirmation;
}

/** A compact round that asks the assigned source slots to confirm or dispute one rejection each. */
export function confirmationPrompt(kind: ReviewKind, context: {
  spec: {path: string; hash: string}; artifact: string; target: ReviewTarget; cwd?: string;
  planPath?: string; taskSummary?: string; scope: string; requests: readonly RejectionRequest[];
}): string {
  const revision = typeof context.target === 'string' ? context.target : context.target.base + '..' + context.target.head;
  const kindContext = kind === 'plan' ? ['- Plan: ' + context.artifact]
    : kind === 'design' ? ['- Design: ' + context.artifact]
    : ['- Plan: ' + (context.planPath ?? 'None'), '- Task: ' + (context.taskSummary ?? 'Review the selected changes.')];
  const requests = context.requests.flatMap(request => [
    'Request ID: `' + request.requestId + '`',
    '- Finding: ' + request.finding,
    '- Target: ' + request.claim.locus,
    '- Spec: ' + context.spec.path,
    '- Original finding: ' + request.claim.defect,
    '- Required change: ' + request.claim.requiredChange,
    '- Host rejection: ' + request.rationale,
    '',
  ]);
  return [
    "Confirm or dispute the host's evidence-backed rejection of your earlier MUST finding(s) on this unchanged target.",
    '',
    '### Context',
    '- Spec Path: ' + context.spec.path,
    '- Spec Hash: ' + context.spec.hash,
    '- Target: ' + context.artifact,
    '- Target Revision: ' + revision,
    ...(context.cwd ? ['- Checkout Path: ' + context.cwd] : []),
    ...kindContext,
    '- Scope: ' + context.scope,
    '',
    '### Inspection',
    'Inspect read-only: read files and run Git inspection commands in the foreground only. Do not edit or create files, write the ledger, launch subagents, or change the target, the session or the repository. Do not raise new findings; answer only the assigned requests below.',
    '',
    '### Pending MUST rejection confirmation',
    'Review each original claim and the host evidence. Add `confirmations` to the JSON report with exactly `requestId` (the assigned Request ID), `decision` (`agree|disagree`), and a nonblank evidence-backed `rationale`. Answer every assigned request exactly once. A pending MUST rejection is open until explicit agreement; omission is not confirmation. Reply with one JSON object and no other text:',
    '{"status":"CLEAN","findings":[],"confirmations":[{"requestId":"<assigned ID>","decision":"agree|disagree","rationale":"<nonblank evidence-based reason>"}]}',
    '',
    ...requests,
  ].join('\n').trimEnd() + '\n';
}
