import { neutralizeComments } from './domain/sanitize.ts';
import type { CriterionStatus } from './evidence.ts';

type Status = CriterionStatus;
type Owner = { id: string; title: string };

export type WalkthroughView = {
  title: string;
  specPath: string;
  specHash: string;
  planPath: string;
  delivered: { integrated: number; total: number; to: string | null; source?: string | null; branch: string } | null;
  statuses: readonly Status[];
  changes: readonly { action: 'NEW' | 'MODIFY' | 'DELETE'; path: string; owners: readonly Owner[] }[];
  edits: readonly { seq: number; artifact: string; class: string; rationale: string; diffRef: string; affects: readonly string[] }[];
  unplannedPaths: readonly string[];
  openEscalations: readonly { id: string; summary: string }[];
  deferredRulings: readonly { review: string; finding: string }[];
  userRecords: readonly { seq: number; kind: string; summary: string; quote: string }[];
  reviewRows: readonly {
    review: string;
    id: string;
    round: number;
    severity: string;
    ruling: 'accepted' | 'rejected' | 'duplicate' | 'deferred' | null;
    rationale: string;
    recurrence?: string;
    unresolved?: string;
  }[];
  findingsPaths: readonly { review: string; path: string }[];
};

const line = (value: unknown): string => neutralizeComments(String(value ?? '').replace(/\r\n?/g, '\n').replace(/\n/g, ' ').trim());
const cell = (value: unknown): string => neutralizeComments(String(value ?? '')
  .replace(/\r\n?/g, '\n').replace(/\n/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').trim());
const code = (value: string): string => `\`${line(value)}\``;
const clip = (value: string, limit: number): string => {
  const chars = Array.from(line(value));
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : chars.join('');
};

function statusTable(statuses: readonly Status[], state: Status['state']): string[] {
  const rows = statuses.filter((row) => row.state === state);
  if (!rows.length) return ['None.'];
  const out = ['| SC | Evidence |', '| --- | --- |'];
  for (const row of rows) {
    let evidence = 'no eligible evidence';
    if (row.state === 'verified') evidence = (row.reason?.startsWith('historical pre-prune') && row.evidence ? '[source evidence]('+row.evidence+')' : row.evidence ?? 'verified evidence')+(row.reason ? '; '+row.reason : '');
    if (row.state === 'manual') evidence = `User evidence: ${row.evidence ?? 'not supplied'}; quote: ${row.quote ?? ''}`;
    if (row.state === 'waived') evidence = `Reason: ${row.reason ?? ''}; quote: ${row.quote ?? ''}`;
    out.push(`| ${cell(row.criterion)} | ${cell(evidence)} |`);
  }
  return out;
}

function reviewStatus(ruling: WalkthroughView['reviewRows'][number]['ruling']): string {
  if (!ruling) return 'Open';
  return ruling[0]!.toUpperCase() + ruling.slice(1);
}

export function renderWalkthrough(view: WalkthroughView): string {
  const statuses = view.statuses;
  const verified = statuses.filter((row) => row.state === 'verified').length;
  const manual = statuses.filter((row) => row.state === 'manual').length;
  const waived = statuses.filter((row) => row.state === 'waived').length;
  const satisfied = verified + manual + waived;
  const delivered = view.delivered === null
    ? 'not delivered'
    : `${view.delivered.integrated} of ${view.delivered.total} tasks integrated; ${view.delivered.to
      ? `delivered ${line(view.delivered.to).slice(0, 12)} to ${line(view.delivered.branch)}${view.delivered.source ? '; source '+line(view.delivered.source).slice(0,12) : ''}`
      : 'not delivered'}`;
  const out = [
    `# ${line(view.title)}`,
    '',
    `> **Delivered:** ${delivered}`,
    `> **Spec:** ${line(view.specPath)} · ${line(view.specHash)}`,
    `> **Plan:** ${line(view.planPath)}`,
    `> **Status:** ${satisfied}/${statuses.length} SC satisfied (verified ${verified} · manual ${manual} · waived ${waived})`,
    `> **Deviations:** ${view.edits.length ? `${view.edits.length} recorded` : 'none'}`,
    '',
    '## Changes Made',
    '',
  ];

  if (!view.changes.length) out.push('None.', '');
  for (const change of view.changes) {
    const owners = change.owners.map((owner) => `${line(owner.id)} — ${line(owner.title)}`);
    out.push(`#### [${change.action}] ${code(change.path)}`, '', `- Changes: ${owners.length ? owners.join(', ') : 'unplanned'}`, '');
  }

  out.push('## Verification', '', '### Verified', ...statusTable(statuses, 'verified'), '',
    '### Manual', ...statusTable(statuses, 'manual'), '',
    '### Waived', ...statusTable(statuses, 'waived'), '');
  if (statuses.some((row) => row.state === 'missing')) out.push('### Missing', ...statusTable(statuses, 'missing'), '');

  out.push('## Deviations & Follow-ups', '');
  const deviations = view.edits.map((edit) =>
    `- Deviation: ${line(edit.artifact)} edit (${line(edit.class)}) seq ${edit.seq}: ${line(edit.rationale)}; diff ${line(edit.diffRef)}; affects ${edit.affects.length ? edit.affects.map(line).join(', ') : 'none'}`);
  deviations.push(...view.unplannedPaths.map((path) => `- Deviation: unplanned change ${line(path)}`));
  const followUps = [
    ...view.openEscalations.map((item) => `- Follow-up: escalation ${line(item.id)}: ${line(item.summary)}`),
    ...view.deferredRulings.map((item) => `- Follow-up: deferred ${line(item.review)}:${line(item.finding)}`),
  ];
  out.push(...(deviations.length || followUps.length ? [...deviations, ...followUps] : ['None.']), '',
    '## User-Attributed Records', '');

  if (view.userRecords.length) {
    out.push('| Seq | Kind | Record | User quote |', '| --- | --- | --- | --- |');
    for (const record of view.userRecords) {
      out.push(`| ${record.seq} | ${cell(record.kind)} | ${cell(record.summary)} | ${cell(record.quote)} |`);
    }
    out.push('');
  } else out.push('None.', '');

  out.push('## Review Findings & Resolutions', '');
  if (view.reviewRows.length) {
    out.push('| Review | ID | Round | Severity | Status | Ruling |', '| --- | --- | --- | --- | --- | --- |');
    for (const row of view.reviewRows) {
      const markers = [row.recurrence && `(recurs ${line(row.recurrence)})`, row.unresolved && `(unresolved ${line(row.unresolved)})`].filter(Boolean);
      const status = [reviewStatus(row.ruling), ...markers].join(' ');
      out.push(`| ${cell(row.review)} | ${cell(row.id)} | ${row.round} | ${cell(row.severity)} | ${cell(status)} | ${cell(clip(row.rationale, 80))} |`);
    }
  } else out.push('*No reviews conducted yet.*');
  if (view.findingsPaths.length) {
    out.push('');
    for (const item of view.findingsPaths) out.push(`Findings: ${line(item.path)}`);
  }
  return `${out.join('\n').replace(/\s+$/, '')}\n`;
}
