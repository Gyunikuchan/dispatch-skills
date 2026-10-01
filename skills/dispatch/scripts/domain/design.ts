// Design parse + lint + governed text. Increment selection by
// graph priority belongs to the design machine, not here.

import {
  boxValues, documentTitle, findPlaceholders, isFillerNote, lint, lintSummaryBox, RESOLUTION_HEADING, sectionRanges,
  structuralLines, withoutSections, type PlaceholderVocabulary, type StructuralLine,
} from './plan.ts';
import type { DesignIncrement, ExecutionStatusRow, IncrementState, LintDefect, ParsedDesign } from './types.ts';

const BOX_LABELS = ['TL;DR', 'Parent', 'Decide', 'Risk', 'Increments'];
const PARENT_VALUE = /^(?:user request|`?[^`\s]+`? · sha256:[0-9a-f]{64})$/;
export const EXECUTION_STATUS_HEADING = '## Execution Status';
const REQUIRED_SECTIONS = [
  'Context & Intent', 'Goals & Requirements', 'Architecture & Boundaries', 'Alternatives & Decisions',
  'Risks, Security & Operations', 'Increment Dependency Graph', 'Increment Details', 'Final Integration',
];
const INCREMENT_FIELDS = [
  'Outcome', 'Scope', 'Non-scope', 'Observable behavior', 'Affected contracts', 'Validation', 'Rollback boundary', 'Parallel safety',
];
const STATES: Readonly<Record<string, IncrementState>> = {
  complete: 'complete', completed: 'complete', active: 'active', ready: 'ready', blocked: 'blocked', invalidated: 'invalidated',
};

const splitColumns = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((column) => column.trim());
const sectionBody = (lines: readonly StructuralLine[], heading: string) => {
  const range = sectionRanges(lines, heading)[0];
  return range ? lines.slice(range.start + 1, range.end) : null;
};

// SECTION: Graph

/** `| I<nn> | <priority> | <summary> | <prerequisites> | <paths> |` rows of the graph section only. */
export function parseIncrementGraph(lines: readonly StructuralLine[]): { increments: DesignIncrement[]; defects: LintDefect[] } {
  const defects: LintDefect[] = [];
  const increments: DesignIncrement[] = [];
  const ids = new Set<string>();
  for (const { text, line } of sectionBody(lines, '## Increment Dependency Graph') ?? []) {
    if (!/^\|\s*I\d{2}\s*\|/.test(text)) continue;
    const columns = splitColumns(text);
    const id = columns[0] ?? '';
    const priority = Number(/^\|\s*I\d{2}\s*\|\s*(\d+)\s*\|/.exec(text)?.[1]);
    if (Number.isNaN(priority)) { defects.push(lint('invalid-priority', line, `Increment ${id} needs an integer priority.`)); continue; }
    if (ids.has(id)) defects.push(lint('duplicate-id', line, `Increment ${id} appears more than once.`));
    ids.add(id);
    const prerequisites = (columns[3] ?? '').split(',').map((item) => item.trim()).filter((item) => item && item !== 'none');
    const paths = columns.slice(4).flatMap((column) => column.split(',')).map((item) => item.trim()).filter(Boolean);
    increments.push({ id, priority, summary: columns[2] ?? '', prerequisites, paths });
  }
  if (!increments.length) defects.push(lint('missing-increments', null, 'Increment Dependency Graph requires at least one I<nn> row.'));
  const sequence = increments.map((row) => Number(row.id.slice(1))).sort((a, b) => a - b);
  if (sequence.some((number, index) => number !== index + 1)) defects.push(lint('invalid-id-sequence', null, 'Increment IDs must run I01, I02, … without gaps.'));
  const priorities = increments.map((row) => row.priority).sort((a, b) => a - b);
  if (new Set(priorities).size !== priorities.length || priorities.some((priority, index) => priority !== index + 1)) {
    defects.push(lint('invalid-priority-order', null, 'Increment priorities must be unique and run 1..n.'));
  }
  const edges = new Map(increments.map((row) => [row.id, row.prerequisites]));
  for (const row of increments) {
    for (const prerequisite of row.prerequisites) {
      if (!ids.has(prerequisite)) defects.push(lint('missing-prerequisite', null, `Increment ${row.id} names unknown prerequisite ${prerequisite}.`));
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { defects.push(lint('cycle', null, `Increment ${id} is part of a prerequisite cycle.`)); return; }
    if (visited.has(id) || !edges.has(id)) return;
    visiting.add(id);
    for (const dependency of edges.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const row of increments) visit(row.id);
  return { increments, defects };
}

// SECTION: Details and status

function incrementDetails(lines: readonly StructuralLine[]): Map<string, StructuralLine[]> {
  const blocks = new Map<string, StructuralLine[]>();
  let current: StructuralLine[] | null = null;
  for (const entry of sectionBody(lines, '## Increment Details') ?? []) {
    const heading = /^###\s+(I\d{2})\b/.exec(entry.text)?.[1];
    if (heading) { current = []; blocks.set(heading, current); continue; }
    current?.push(entry);
  }
  return blocks;
}

function parseExecutionStatus(lines: readonly StructuralLine[], ids: ReadonlySet<string>, out: LintDefect[]): ParsedDesign['executionStatus'] {
  const body = sectionBody(lines, EXECUTION_STATUS_HEADING);
  if (!body) return null;
  const rows: ExecutionStatusRow[] = [];
  let nextAction: string | null = null;
  for (const { text, line } of body) {
    const action = /^Next Action:\s*(.+)$/.exec(text.trim())?.[1];
    if (action) { nextAction = action.trim(); continue; }
    if (!/^\|\s*I\d{2}\s*\|/.test(text)) continue;
    const [id = '', rawState = '', summary = '', next = ''] = splitColumns(text);
    const state = STATES[rawState.toLowerCase()];
    if (!state) { out.push(lint('execution-status', line, `Execution Status ${id} has unknown state "${rawState}"; use complete, active, ready, blocked, or invalidated.`)); continue; }
    if (!ids.has(id)) out.push(lint('execution-status', line, `Execution Status names ${id}, which the graph does not define.`));
    if (rows.some((row) => row.id === id)) out.push(lint('execution-status', line, `Execution Status lists ${id} more than once.`));
    rows.push({ id, state, summary, nextAction: next });
  }
  // NOTE: full graph coverage is not required: the status section lists only active and ready increments.
  if (!nextAction) out.push(lint('execution-status', body[0]?.line ?? null, 'Execution Status requires a non-empty Next Action: line.'));
  return { rows, nextAction };
}

// SECTION: Public API

export type DesignResult =
  | { ok: true; design: ParsedDesign }
  | { ok: false; defects: LintDefect[] };
/** Concrete design guard at journal-consuming machine boundaries. */
export function asParsedDesign(value: unknown): ParsedDesign | null {
  const record = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!record(value) || !record(value['box']) || !Object.values(value['box']).every((v) => typeof v === 'string') || !record(value['details']) || typeof value['governedText'] !== 'string' || !Array.isArray(value['increments']) || !value['increments'].length) return null;
  const details = value['details'];
  if (typeof value['box']['TL;DR'] !== 'string' || !value['box']['TL;DR'].trim()) return null;
  if (!Object.values(details).every((row) => record(row) && Object.values(row).every((v) => typeof v === 'string'))) return null;
  if (!value['increments'].every((row) => record(row) && /^I\d{2}$/.test(String(row['id'])) && Number.isInteger(row['priority']) && typeof row['summary'] === 'string' && record(details[String(row['id'])]) && Array.isArray(row['prerequisites']) && row['prerequisites'].every((v) => typeof v === 'string') && Array.isArray(row['paths']) && row['paths'].length > 0 && row['paths'].every((v) => typeof v === 'string' && v.trim()))) return null;
  const design = value as unknown as ParsedDesign;
  const ids = new Set(design.increments.map((row) => row.id));
  const priorities = design.increments.map((row) => row.priority).sort((a, b) => a - b);
  if (ids.size !== design.increments.length || priorities.some((n, i) => n !== i + 1) || [...ids].sort().some((id, i) => id !== `I${String(i + 1).padStart(2, '0')}`)) return null;
  if (design.increments.some((row) => row.prerequisites.some((id) => !ids.has(id)))) return null;
  const graph = new Map(design.increments.map((row) => [row.id, row.prerequisites]));
  const visited = new Set<string>(), visiting = new Set<string>();
  const acyclic = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    if (!(graph.get(id) ?? []).every(acyclic)) return false;
    visiting.delete(id); visited.add(id);
    return true;
  };
  return [...ids].every(acyclic) ? design : null;
}

export function governedDesignText(source: string): string {
  return withoutSections(source, [EXECUTION_STATUS_HEADING, RESOLUTION_HEADING]);
}

export function sharedDesignSections(source: string): string {
  const lines = structuralLines(source);
  const sections = ['## Goals & Requirements', '## Architecture & Boundaries', '## Final Integration'];
  return sections.map((heading) => {
    const body = (sectionBody(lines, heading) ?? []).map((l) => l.text.trim()).filter(Boolean).join('\n');
    return `${heading}\n${body}`;
  }).join('\n\n');
}

const detailField = (details: Record<string, string> | undefined, field: string): string =>
  Object.entries(details ?? {}).find(([k]) => k.toLowerCase() === field.toLowerCase())?.[1] ?? '';

export function designScopeGrew(before: ParsedDesign, after: ParsedDesign): boolean {
  const beforePaths = new Set(before.increments.flatMap((row) => row.paths));
  for (const afterRow of after.increments) {
    for (const p of afterRow.paths) if (!beforePaths.has(p)) return true;
    const beforeRow = before.increments.find((row) => row.id === afterRow.id);
    if (!beforeRow) return true;
    const beforeVal = detailField(before.details[afterRow.id], 'Validation');
    const afterVal = detailField(after.details[afterRow.id], 'Validation');
    if (afterVal !== beforeVal) return true;
  }
  const beforeLines = structuralLines(before.governedText);
  const afterLines = structuralLines(after.governedText);
  const beforeIntegration = (sectionBody(beforeLines, '## Final Integration') ?? []).map((l) => l.text.trim()).filter(Boolean).join('\n');
  const afterIntegration = (sectionBody(afterLines, '## Final Integration') ?? []).map((l) => l.text.trim()).filter(Boolean).join('\n');
  if (beforeIntegration !== afterIntegration) return true;
  return false;
}

/** Parses and lints a design; any diagnostic fails the parse (design lint has no warnings). */
export function parseDesign(source: string, options: { placeholders?: PlaceholderVocabulary } = {}): DesignResult {
  const lines = structuralLines(source);
  const defects: LintDefect[] = [];
  for (const heading of REQUIRED_SECTIONS) {
    if (!sectionRanges(lines, `## ${heading}`).length) defects.push(lint('missing-section', null, `Design requires ## ${heading}.`));
  }
  const graph = parseIncrementGraph(lines);
  const blocks = incrementDetails(lines);
  const details: Record<string, Record<string, string>> = {};
  for (const { id } of graph.increments) {
    const block = blocks.get(id);
    if (!block) { defects.push(lint('missing-increment-details', null, `Increment ${id} needs a ### ${id} block under Increment Details.`)); continue; }
    const fields: Record<string, string> = {};
    for (const { text, line } of block) {
      const match = /^\s*[-*]\s+([^:]+):\s*(.*)$/.exec(text);
      if (!match?.[1]) continue;
      const value = (match[2] ?? '').trim();
      fields[match[1].trim()] = value;
      if (value && isFillerNote(value)) defects.push(lint('filler-note', line, `Increment ${id} field "${text.trim()}" is filler.`));
    }
    for (const field of INCREMENT_FIELDS) {
      const found = Object.entries(fields).some(([name, value]) => name.toLowerCase() === field.toLowerCase() && value);
      if (!found) defects.push(lint('missing-increment-field', null, `Increment ${id} requires "- ${field}: <value>".`));
    }
    details[id] = fields;
  }
  const count = graph.increments.length;
  const increments = (value: string) => /^[1-9]\d*$/.test(value)
    ? (Number(value) === count ? null : `Summary Increments ${value} must equal the graph increment count ${count}.`)
    : `Summary Increments value "${value}" must be a positive integer.`;
  defects.push(...lintSummaryBox(source, BOX_LABELS, { Parent: PARENT_VALUE, Increments: increments }));
  if (options.placeholders) {
    for (const { token, line } of findPlaceholders(source, options.placeholders)) defects.push(lint('leftover-placeholder', line, `Leftover template placeholder ${token}.`));
  }
  defects.push(...graph.defects);
  const executionStatus = parseExecutionStatus(lines, new Set(graph.increments.map((row) => row.id)), defects);
  if (defects.length) return { ok: false, defects };
  return {
    ok: true,
    design: { title: documentTitle(source), box: boxValues(source), increments: graph.increments, details, executionStatus, governedText: governedDesignText(source) },
  };
}
