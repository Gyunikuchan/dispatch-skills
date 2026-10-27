import { neutralizeComments } from './domain/sanitize.ts';
import type { CriterionStatus } from './evidence.ts';
import { renderFindingsSection, type RoundLink } from './review-findings.ts';

type Status = CriterionStatus;
type Owner = { id: string; title: string };

export type WalkthroughView = {
  title: string;
  specPath: string;
  specHash: string;
  planPath: string;
  delivered: { integrated: number; total: number; source: string | null; branch: string; ref: string } | null;
  glance?: { what: string; how: string } | null;
  tasks?: readonly { id: string; title: string; outcome: string; behaviour: readonly string[] }[];
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
  reviewRounds: readonly RoundLink[];
};

const line = (value: unknown): string => neutralizeComments(String(value ?? '').replace(/\r\n?/g, '\n').replace(/\n/g, ' ').trim());
const cell = (value: unknown): string => neutralizeComments(String(value ?? '')
  .replace(/\r\n?/g, '\n').replace(/\n/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').trim());
const code = (value: string): string => `\`${line(value)}\``;
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

export function renderWalkthrough(view: WalkthroughView, fromDir = '.'): string {
  const statuses = view.statuses;
  const verified = statuses.filter((row) => row.state === 'verified').length;
  const manual = statuses.filter((row) => row.state === 'manual').length;
  const waived = statuses.filter((row) => row.state === 'waived').length;
  const satisfied = verified + manual + waived;
  const missing = statuses.filter((row) => row.state === 'missing').length;
  const added = view.changes.filter((change) => change.action === 'NEW').length;
  const modified = view.changes.filter((change) => change.action === 'MODIFY').length;
  const deleted = view.changes.filter((change) => change.action === 'DELETE').length;
  const changeSummary = `${view.changes.length} files (${added} new · ${modified} modified · ${deleted} deleted)`;
  const openReviews = view.reviewRows.filter((row) => row.ruling === null).length;
  const integration = view.delivered === null
    ? 'not delivered'
    : view.delivered.source === null
    ? `${view.delivered.integrated} of ${view.delivered.total} tasks integrated; not delivered`
    : `${view.delivered.integrated} of ${view.delivered.total} tasks integrated; uncommitted changes from source ${line(view.delivered.source).slice(0, 12)} in ${line(view.delivered.branch)} working tree; ref ${line(view.delivered.ref)}`;
  const delivered = line(view.glance?.what) || integration;
  const out = [
    `# ${line(view.title)}`,
    '',
    `> **Delivered:** ${delivered}`,
    `> **Integration:** ${integration}`,
    `> **Spec:** ${line(view.specPath)} · ${line(view.specHash)}`,
    `> **Plan:** ${line(view.planPath)}`,
    `> **Status:** ${satisfied}/${statuses.length} SC satisfied (verified ${verified} · manual ${manual} · waived ${waived})`,
    `> **Deviations:** ${view.edits.length ? `${view.edits.length} recorded` : 'none'}`,
    '',
    '## At a Glance',
    '',
    `- **Delivered:** ${delivered}`,
    ...(view.glance?.how ? [`- **How it works:** ${line(view.glance.how)}`] : []),
    `- **Criteria:** ${satisfied}/${statuses.length} satisfied (verified ${verified} · manual ${manual} · waived ${waived} · missing ${missing})`,
    `- **Changes:** ${changeSummary}`,
    `- **Deviations:** ${view.edits.length} recorded edits · ${view.unplannedPaths.length} unplanned paths`,
    `- **Follow-ups:** ${view.openEscalations.length} open escalations · ${view.deferredRulings.length} deferred rulings`,
    `- **Review:** ${view.reviewRows.length} findings (${openReviews} open)`,
    '',
  ];
  if (view.openEscalations.length) out.push('> [!IMPORTANT]', `> ${view.openEscalations.length} open escalations need a user decision.`, '');
  const notes = [
    missing && `${missing} missing criteria`,
    manual && `${manual} manual criteria`,
    waived && `${waived} waived criteria`,
    view.unplannedPaths.length && `${view.unplannedPaths.length} unplanned paths`,
    view.edits.length && `${view.edits.length} recorded deviations`,
    view.deferredRulings.length && `${view.deferredRulings.length} deferred rulings`,
  ].filter(Boolean);
  if (notes.length) out.push('> [!NOTE]', `> ${notes.join('; ')}. See Verification and Deviations & Follow-ups.`, '');
  out.push('## Changes Made', '');
  if (!view.changes.length) out.push('None.', '');
  const tasks = view.tasks ?? [];
  const fileEntry = (change: WalkthroughView['changes'][number]): string[] => {
    const owners = change.owners.map((owner) => `${line(owner.id)} — ${line(owner.title)}`);
    return [`#### [${change.action}] ${code(change.path)}`, '', `- Changes: ${owners.length ? owners.join(', ') : 'unplanned'}`, ''];
  };
  for (const task of tasks) {
    out.push(`### ${line(task.id)} — ${line(task.title)}`, '');
    const behaviour = task.behaviour.map(line).filter(Boolean);
    out.push(...(behaviour.length ? behaviour.map((item) => `- ${item}`) : [`- ${line(task.outcome)}`]), '', '<details>', '');
    const taskChanges = view.changes.filter((change) => change.owners.some((owner) => owner.id === task.id));
    if (taskChanges.length) for (const change of taskChanges) out.push(...fileEntry(change));
    else out.push('None.', '');
    out.push('</details>', '');
  }
  const taskIds = new Set(tasks.map((task) => task.id));
  const unplannedChanges = view.changes.filter((change) => !change.owners.some((owner) => taskIds.has(owner.id)));
  if (unplannedChanges.length) {
    out.push('### Unplanned changes', '', '<details>', '');
    for (const change of unplannedChanges) out.push(...fileEntry(change));
    out.push('</details>', '');
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

  out.push('## Review Findings & Resolutions', '', renderFindingsSection(view.reviewRows, view.reviewRounds, fromDir));
  return `${out.join('\n').replace(/\s+$/, '')}\n`;
}
