// Driver-owned Markdown renderers (spec §10.2): walkthrough minimum contract, standalone report, and the
// resolution section. Output carries no HTML comment markers; delegate-derived text is sanitized.

import { RESOLUTION_HEADING } from './plan.ts';
import { neutralizeComments, sanitizeText } from './sanitize.ts';
import type { ReportView, ResolutionRound, ResolutionStatus, WalkthroughView } from './types.ts';

export const walkthroughPathOf = (sessionDir: string, slug: string, increment?: string): string =>
  `${sessionDir}/${slug}${increment ? `-${increment.toLowerCase()}` : ''}.walkthrough.md`;

const unreachable = (value: never): never => { throw new Error(`unhandled resolution status: ${String(value)}`); };

export function statusLabel(status: ResolutionStatus): string {
  switch (status) {
    case 'accepted': return 'Accepted';
    case 'fixed': return 'Fixed';
    case 'rejected': return 'Rejected';
    case 'pending-rejection': return 'Rejected — Pending Confirmation';
    case 'downgraded': return 'Downgraded';
    case 'needs-user': return 'Needs User';
    case 'closed-by-reviewer': return 'Rejected — Closed by Reviewer';
    case 'closed-by-orchestrator': return 'Rejected — Closed by Orchestrator';
    case 'superseded': return 'Superseded';
    case 'duplicate': return 'Duplicate';
    case 'deferred': return 'Deferred';
    default: return unreachable(status);
  }
}

/** Table cells: one line, backslashes then pipes escaped, comments neutralised. */
const cell = (text: string) => neutralizeComments(text.replace(/\r?\n/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').trim());
const line = (text: string) => neutralizeComments(text.replace(/\r?\n/g, ' ').trim());
const noteLine = (text: string) => neutralizeComments(text)
  .replace(/^(\s*)([#>|`~*+=_<-])/, '$1\\$2')
  .replace(/^(\s*\d+)([.)])(?=\s|$)/, '$1\\$2');

// SECTION: Resolution section

/** The trailing `## Review Findings & Resolutions` section, heading included. */
export function renderResolutionSection(rounds: readonly ResolutionRound[]): string {
  const out = [RESOLUTION_HEADING, ''];
  if (!rounds.length) return [...out, '*No reviews conducted yet.*', ''].join('\n');
  for (const round of rounds) {
    out.push(`### Round ${round.round}${round.heading ? ` — ${line(round.heading)}` : ''}`, '');
    const reviewers = round.reviewers.map((reviewer) => {
      const detail = [reviewer.model, reviewer.effort && `(${reviewer.effort})`].filter(Boolean).join(' ');
      return detail ? `${reviewer.slot} ${line(detail)}` : reviewer.slot;
    });
    out.push(`- Reviewers: ${reviewers.join(', ') || 'none'}`);
    if (round.failed.length) out.push(`- Failed: ${round.failed.map((target) => `${target.slot} (${sanitizeText(target.reason)})`).join(', ')}`);
    if (!round.entries.length) out.push('- No findings.');
    for (const entry of round.entries) {
      out.push('', `#### ${entry.id}`, '',
        `- Status: **[${statusLabel(entry.status)}]**`, `- Severity: ${entry.severity}`,
        `- Sources: ${entry.sources.join(', ')}`, `- Location: ${line(entry.locus)}`, `- Category: ${line(entry.category)}`);
      if (entry.originalTag) out.push(`- Reviewer tag: ${line(entry.originalTag)}`);
      const defect = sanitizeText(entry.defect);
      out.push(`- Finding: ${defect}`);
      if (entry.requiredChange) out.push(`- Required change: ${sanitizeText(entry.requiredChange)}`);
      if (entry.dupOf) out.push(`- Duplicate: ${entry.dupOf} [dup=${entry.dupOf}]`);
      if (entry.resolution) out.push('- Ruling:', ...entry.resolution.split(/\r?\n/).map((text) => `  ${sanitizeText(text)}  `));
    }
    out.push('');
  }
  return out.join('\n');
}

function resolutionSectionRange(doc: string): { lines: string[]; start: number; end: number } {
  const lines = doc.replace(/\r\n/g, '\n').split('\n');
  let fence: string | null = null;
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index] ?? '';
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(text)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(`+|~+)\s*$/.test(text)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (start === -1 && text.trimEnd() === RESOLUTION_HEADING) start = index;
    else if (start !== -1 && /^##\s/.test(text)) { end = index; break; }
  }
  return { lines, start, end };
}

export function resolutionSectionOf(doc: string): string | null {
  const { lines, start, end } = resolutionSectionRange(doc);
  return start === -1 ? null : lines.slice(start, end).join('\n');
}

/** A review key updates only that run's block; otherwise replaces the section. Later sections survive. */
export function replaceResolutionSection(doc: string, rendered: string, reviewKey?: string): string {
  const { lines, start, end } = resolutionSectionRange(doc);
  let body = rendered.replace(/\s+$/, '');
  if (reviewKey !== undefined) {
    const heading = `### Review ${line(reviewKey)}`;
    const current = lines.slice(start + 1, end).join('\n').trim();
    const history = start === -1 || /^\*?No reviews conducted yet\.\*?$/.test(current) ? '' : current;
    const block = `${heading}\n\n${body.replace(/^## Review Findings & Resolutions\s*\n/, '').replace(/^(#{3,4}) /gm, '$1# ')}`;
    const blocks = history.split(/(?=^### Review )/m);
    const index = blocks.findIndex((entry) => entry.split('\n')[0] === heading);
    if (index === -1) blocks.push(block);
    else blocks[index] = block;
    body = `${RESOLUTION_HEADING}\n\n${blocks.map((entry) => entry.trim()).filter(Boolean).join('\n\n')}`;
  }
  if (start === -1) return `${doc.replace(/\s+$/, '')}\n\n${body}\n`;
  const before = lines.slice(0, start).join('\n').replace(/\s+$/, '');
  const after = lines.slice(end).join('\n').replace(/\s+$/, '');
  return `${before ? `${before}\n\n` : ''}${body}\n${after ? `\n${after}\n` : ''}`;
}

// SECTION: Walkthrough

/** Spec §10.2: H1 + box, Context only for a user-request Parent, Changes, Verification + Final gate,
 * Deviations & Follow-ups, a revision log only when revisions occurred, then the resolution section. */
export function renderWalkthrough(view: WalkthroughView): string {
  const userRequest = view.parent === 'user request';
  const out = [
    `# ${line(view.title)}`,
    '',
    `> **Delivered:** ${line(view.delivered)}`,
    '>',
    `> **Parent:** ${line(view.parent)}`,
    '>',
    `> **Status:** ${line(view.status)}`,
    '>',
    `> **Deviations:** ${view.deviations.length ? line(view.deviations.join('; ')) : 'none'}`,
    '>',
    '',
  ];
  if (userRequest && view.context) {
    const { ask, decisions = [], assumptions = [], outOfScope = [], focus } = view.context;
    out.push('## Context', '', `- Ask: ${line(ask)}`);
    for (const decision of decisions) out.push(`- Decisions: ${line(decision)}`);
    for (const assumption of assumptions) out.push(`- Assumptions: ${line(assumption)}`);
    for (const item of outOfScope) out.push(`- Out of scope: ${line(item)}`);
    if (focus) out.push(`- Focus: ${line(focus)}`);
    out.push('');
  }
  out.push('## Changes Made', '');
  if (!view.changes.length) out.push('None.');
  for (const change of view.changes) {
    const notes = neutralizeComments(change.note).split(/\r?\n/);
    out.push(`- #### [${change.action}] \`${line(change.path)}\``,
      `  - Changes: ${notes[0] ?? ''}${notes.length > 1 ? '  ' : ''}`,
      ...notes.slice(1).map((note) => `    ${noteLine(note)}  `), '');
  }
  if (!view.changes.length) out.push('');
  out.push('## Verification', '');
  if (view.verification.length) {
    out.push('| SC | Outcome | Evidence |', '| --- | --- | --- |');
    for (const row of view.verification) out.push(`| ${cell(row.sc)} | ${cell(row.outcome)} | ${cell(row.evidence)} |`);
    out.push('');
  }
  out.push(`Final gate: ${line(view.finalGate)}`, '', '## Deviations & Follow-ups', '');
  const bullets = [...view.deviations.map((item) => `- Deviation: ${line(item)}`), ...view.followUps.map((item) => `- Follow-up: ${line(item)}`)];
  out.push(...(bullets.length ? bullets : ['None.']), '');
  if (view.revisions.length) {
    out.push('## Revision Log', '');
    view.revisions.forEach((revision, index) => out.push(`${index + 1}. ${revision.artifact}: ${line(revision.reason)}`));
    out.push('');
  }
  out.push(renderResolutionSection(view.rounds));
  return `${out.join('\n').replace(/\s+$/, '')}\n`;
}

// SECTION: Standalone report

function requiredAction(rounds: readonly ResolutionRound[]): string {
  const actions: string[] = [];
  for (const round of rounds) {
    for (const entry of round.entries) {
      switch (entry.status) {
        case 'accepted': actions.push(`round ${round.round} ${entry.id}: apply or verify accepted change`); break;
        case 'pending-rejection': actions.push(`round ${round.round} ${entry.id}: confirm rejection`); break;
        case 'needs-user': actions.push(`round ${round.round} ${entry.id}: user decision required`); break;
        case 'deferred': actions.push(`round ${round.round} ${entry.id}: deferred follow-up`); break;
        case 'fixed': case 'rejected': case 'downgraded': case 'closed-by-reviewer':
        case 'closed-by-orchestrator': case 'superseded': case 'duplicate': break;
        default: unreachable(entry.status);
      }
    }
    if (round.failed.length) actions.push(`round ${round.round}: inspect failed reviewer coverage (${round.failed.map((target) => target.slot).join(', ')})`);
  }
  return actions.length ? actions.join('; ') : 'No action recorded; this is not an approval or coverage claim.';
}

export function renderReport(view: ReportView): string {
  const out = [
    `# ${line(view.title)}`,
    '',
    `> **Summary:** ${line(view.summary)}`,
    '>',
    `> **Kind:** ${view.kind} review`,
    '>',
    `> **Target:** ${line(view.target)}`,
    '>',
    '',
    `- Required action: ${requiredAction(view.rounds)}`,
    '',
    renderResolutionSection(view.rounds),
  ];
  return `${out.join('\n').replace(/\s+$/, '')}\n`;
}
