import { neutralizeComments } from './domain/sanitize.ts';
import type { CriterionStatus } from './evidence.ts';
import { renderFindingsSection, type RoundLink } from './review-findings.ts';
import type { ReviewFix } from './records.ts';

type Status = CriterionStatus;
type Owner = { id: string; title: string };
type ReviewFixReport = {
  commit: string;
  reason: string;
  metadata: ReviewFix;
  status: 'verified but not re-reviewed' | 'not verified';
  paths: readonly string[];
  verification?: { tree: string; criteria: readonly string[]; contract: readonly string[]; finalTree?: string; finalChecks?: readonly string[] };
};

export type WalkthroughView = {
  title: string;
  specPath: string;
  specHash: string;
  planPath: string;
  planHash?: string;
  risk?: string;
  delivered: { integrated: number; total: number; source: string | null; branch: string; ref: string } | null;
  glance?: { what: string; how: string; visuals?: string } | null;
  /** Parent-design visuals used only when the bound plan has no At a Glance visuals. */
  visuals?: string;
  focus?: { bullets?: readonly { text: string; evidence: string }[]; visual?: string } | null;
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
    /** `model/effort` of each source slot, or the slot id when the roster lacks it. */
    sources?: readonly string[];
    ruling: 'accepted' | 'rejected' | 'duplicate' | 'deferred' | null;
    rationale: string;
    recurrence?: string;
    unresolved?: string;
  }[];
  reviewRounds: readonly RoundLink[];
  reviewFixes?: readonly ReviewFixReport[];
  reviewedCodeBaseline?: string;
};

const line = (value: unknown): string => neutralizeComments(String(value ?? '').replace(/\r\n?/g, '\n').replace(/\n/g, ' ').trim());
const cell = (value: unknown): string => neutralizeComments(String(value ?? '')
  .replace(/\r\n?/g, '\n').replace(/\n/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').trim());
const code = (value: string): string => {
  const text = line(value);
  const delimiter = '`'.repeat(Math.max(0, ...((text.match(/`+/g) ?? []).map((run) => run.length))) + 1);
  return `${delimiter}${text}${delimiter}`;
};
const codeSpan = (value: unknown): string => {
  const text = JSON.stringify(value) ?? String(value);
  const delimiter = '`'.repeat(Math.max(0, ...((text.match(/`+/g) ?? []).map((run) => run.length))) + 1);
  return `${delimiter}${text}${delimiter}`;
};
const visualLine = (value: string): string => {
  // Escaped comment openers are inert, so keep Mermaid arrows and similar `-->` text intact.
  return neutralizeComments(value).replace(/--&gt;/g, '-->');
};
const markdownLines = (value: string): string[] => value
  .replace(/\r\n?/g, '\n').replace(/^(?:\n)+|(?:\n)+$/g, '').split('\n').map(visualLine);
const hashPrefix = (value: string | undefined): string => {
  if (!value || value === 'unavailable') return 'unavailable';
  const hex = value.replace(/^sha256:/, '');
  return `sha256:${hex.slice(0, 12)}`;
};

function statusTable(statuses: readonly Status[], state: Status['state']): string[] {
  const rows = statuses.filter((row) => row.state === state);
  if (!rows.length) return ['None.'];
  const out = ['| SC | Evidence |', '| --- | --- |'];
  for (const row of rows) {
    let evidence = 'no eligible evidence';
    if (row.state === 'verified') evidence = (row.reason?.startsWith('historical pre-prune') && row.evidence ? '[source evidence]('+row.evidence+')' : row.evidence ?? 'verified evidence')+(row.reason ? '; '+row.reason : '');
    out.push(`| ${cell(row.criterion)} | ${cell(evidence)} |`);
  }
  return out;
}

function exceptionSection(statuses: readonly Status[], state: Extract<Status['state'], 'manual' | 'waived' | 'missing'>): string[] {
  const rows = statuses.filter((row) => row.state === state);
  if (!rows.length) return [];
  const title = state[0]!.toUpperCase() + state.slice(1);
  const details = rows.map((row) => {
    if (row.state === 'manual') return `- ${cell(row.criterion)} · User evidence: ${cell(row.evidence ?? 'not supplied')}; quote: ${cell(row.quote ?? '')}`;
    if (row.state === 'waived') return `- ${cell(row.criterion)} · Reason: ${cell(row.reason ?? '')}; quote: ${cell(row.quote ?? '')}`;
    return `- ${cell(row.criterion)} · ${cell(row.reason ?? 'no eligible evidence')}`;
  });
  return [`### ${title}`, '', ...details, ''];
}

function reviewFocus(view: WalkthroughView): string[] {
  const tier = view.risk ?? 'low';
  const departures: string[] = [];
  for (const edit of view.edits) {
    const artifact = edit.artifact === 'plan' ? 'Plan' : edit.artifact === 'design' ? 'Design' : line(edit.artifact);
    departures.push(`- ${artifact} edit (${line(edit.class)}): ${line(edit.rationale)}; diff ${line(edit.diffRef)}`);
  }
  for (const row of view.statuses) {
    if (row.state === 'verified') continue;
    const label = row.state[0]!.toUpperCase() + row.state.slice(1);
    departures.push(`- ${label} criterion ${line(row.criterion)}`);
  }
  for (const row of view.reviewRows) {
    if (row.ruling !== 'rejected' && row.ruling !== 'deferred') continue;
    const label = row.ruling[0]!.toUpperCase() + row.ruling.slice(1);
    departures.push(`- ${label} finding ${line(row.review)}:${line(row.id)}${row.rationale ? ` — ${line(row.rationale)}` : ''}`);
  }
  for (const fix of view.reviewFixes ?? []) {
    if (fix.status !== 'verified but not re-reviewed') continue;
    const findings = fix.metadata.findings.length ? fix.metadata.findings.map(line).join(', ') : line(fix.commit).slice(0, 12);
    departures.push(`- Cap-ending SHOULD fix ${findings}: verified but not re-reviewed`);
  }
  for (const file of view.unplannedPaths) departures.push(`- Unplanned path: ${line(file)}`);
  for (const item of view.openEscalations) departures.push(`- Open escalation ${line(item.id)}: ${line(item.summary)}`);
  const deferredRows = new Set(view.reviewRows.filter((row) => row.ruling === 'deferred').map((row) => `${row.review}:${row.id}`));
  for (const item of view.deferredRulings) {
    const key = `${item.review}:${item.finding}`;
    if (!deferredRows.has(key)) departures.push(`- Deferred follow-up ${line(key)}`);
  }

  const lines = departures.length
    ? [`- Risk: ${tier}`, ...departures]
    : [`- Risk: ${tier} · Delivery matched the plan and all criteria are verified.`];
  for (const bullet of view.focus?.bullets ?? []) {
    const evidence = line(bullet.evidence);
    lines.push(`- ${line(bullet.text)} — Evidence: [${evidence}](${evidence})`);
  }
  return lines;
}

function reviewFixDetails(view: WalkthroughView): string[] {
  const fixes = view.reviewFixes ?? [];
  if (!fixes.length) return [];
  const lines = ['### Review Fixes', ''];
  if (view.reviewedCodeBaseline) lines.push(`Reviewed code baseline: ${codeSpan(view.reviewedCodeBaseline)}.`, '');
  for (const fix of fixes) {
    lines.push(`- Correction ${codeSpan(fix.commit)} from ${codeSpan(fix.metadata.from)}; findings ${codeSpan(fix.metadata.findings)}; changed paths ${codeSpan(fix.paths)}; status: ${codeSpan(fix.status)}; reason ${codeSpan(fix.reason)}; metadata ${codeSpan(fix.metadata)}.`);
    if (fix.verification) lines.push(`  - Current evidence: tree ${codeSpan(fix.verification.tree)}; criteria ${codeSpan(fix.verification.criteria)}; contract ${codeSpan(fix.verification.contract)}${fix.verification.finalTree ? `; final tree ${codeSpan(fix.verification.finalTree)}; final checks ${codeSpan(fix.verification.finalChecks)}` : ''}.`);
  }
  lines.push('');
  return lines;
}

export function renderWalkthrough(view: WalkthroughView, fromDir = '.'): string {
  const statuses = view.statuses;
  const criteria = statuses.filter((row) => row.criterion !== 'contract');
  const verified = criteria.filter((row) => row.state === 'verified').length;
  const manual = criteria.filter((row) => row.state === 'manual').length;
  const waived = criteria.filter((row) => row.state === 'waived').length;
  const missing = criteria.filter((row) => row.state === 'missing').length;
  const satisfied = verified + manual + waived;
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
  const exceptionCount = statuses.filter((row) => row.state !== 'verified').length;
  const plannedVisuals = view.glance?.visuals || view.visuals || '';
  const replacement = view.focus?.visual?.trim() ? view.focus.visual : plannedVisuals;
  const out = [
    `# ${line(view.title)}`,
    '',
    '## At a Glance',
    '',
    `- **What:** ${delivered}`,
    ...(view.glance?.how ? [`- **How it works:** ${line(view.glance.how)}`] : []),
    `- **Counts:** ${satisfied}/${criteria.length} criteria (verified ${verified} · manual ${manual} · waived ${waived} · missing ${missing}); ${changeSummary}; ${view.edits.length} recorded edits; ${view.unplannedPaths.length} unplanned paths; ${view.openEscalations.length} open escalations; ${view.deferredRulings.length} deferred rulings; ${view.reviewRows.length} findings (${openReviews} open)`,
    '',
    '## Visuals',
    '',
    ...(replacement ? markdownLines(replacement) : ['None.']),
    '',
    '## Review Focus',
    '',
    ...reviewFocus(view),
    '',
    '## Behaviour Changes',
    '',
  ];

  const tasks = view.tasks ?? [];
  const actionLabel: Record<WalkthroughView['changes'][number]['action'], string> = { NEW: 'created', MODIFY: 'modified', DELETE: 'deleted' };
  const changeLine = (change: WalkthroughView['changes'][number]) => `- ${code(change.path)} · ${actionLabel[change.action]}`;
  if (!tasks.length && !view.changes.length) out.push('None.', '');
  for (const task of tasks) {
    out.push(`### ${line(task.id)} — ${line(task.title)}`, '');
    const behaviour = task.behaviour.map(line).filter(Boolean);
    out.push(...(behaviour.length ? behaviour.map((item) => `- ${item}`) : [`- ${line(task.outcome)}`]), '', '<details>', '');
    const taskChanges = view.changes.filter((change) => change.owners.some((owner) => owner.id === task.id));
    out.push(...(taskChanges.length ? taskChanges.map(changeLine) : ['None.']), '', '</details>', '');
  }
  const taskIds = new Set(tasks.map((task) => task.id));
  const unplannedChanges = view.changes.filter((change) => !change.owners.some((owner) => taskIds.has(owner.id)));
  if (unplannedChanges.length) {
    out.push('### Unplanned changes', '', '- No planned task owns these changed paths.', '', '<details>', '', ...unplannedChanges.map(changeLine), '', '</details>', '');
  }

  out.push('## Verification', '', `- **Status:** ${exceptionCount ? 'exceptions recorded' : 'complete'}`, '');
  out.push(...exceptionSection(statuses, 'manual'), ...exceptionSection(statuses, 'waived'), ...exceptionSection(statuses, 'missing'));

  const deviations = view.edits.map((edit) =>
    `- Deviation: ${line(edit.artifact)} edit (${line(edit.class)}) seq ${edit.seq}: ${line(edit.rationale)}; diff ${line(edit.diffRef)}; affects ${edit.affects.length ? edit.affects.map(line).join(', ') : 'none'}`);
  deviations.push(...view.unplannedPaths.map((path) => `- Deviation: unplanned change ${line(path)}`));
  const followUps = [
    ...view.openEscalations.map((item) => `- Follow-up: escalation ${line(item.id)}: ${line(item.summary)}`),
    ...view.deferredRulings.map((item) => `- Follow-up: deferred ${line(item.review)}:${line(item.finding)}`),
  ];
  const integrationRecord = view.delivered === null
    ? 'not delivered'
    : view.delivered.source === null
      ? `${view.delivered.integrated} of ${view.delivered.total} tasks integrated; not delivered`
      : `source ${line(view.delivered.source)} · branch ${line(view.delivered.branch)} · ref ${line(view.delivered.ref)}`;
  out.push(
    '## Appendix', '', '<details>', '', '<summary>Audit records</summary>', '',
    '### Provenance', '',
    `- Spec: ${line(view.specPath)} · ${hashPrefix(view.specHash)}`,
    `- Plan: ${line(view.planPath)} · ${hashPrefix(view.planHash)}`,
    `- Integration: ${integrationRecord}`,
    '',
    '### Verified Evidence', '', ...statusTable(statuses, 'verified'), '',
    '### User-Attributed Records', '',
  );
  if (view.userRecords.length) {
    out.push('| Seq | Kind | Record | User quote |', '| --- | --- | --- | --- |');
    for (const record of view.userRecords) out.push(`| ${record.seq} | ${cell(record.kind)} | ${cell(record.summary)} | ${cell(record.quote)} |`);
    out.push('');
  } else out.push('None.', '');
  out.push('### Deviations & Follow-ups', '', ...(deviations.length || followUps.length ? [...deviations, ...followUps] : ['None.']), '',
    '### Review Findings & Resolutions', '', renderFindingsSection(view.reviewRows, view.reviewRounds, fromDir), '',
    ...reviewFixDetails(view), '</details>');
  return `${out.join('\n').replace(/\s+$/, '')}\n`;
}
