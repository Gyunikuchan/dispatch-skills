#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import { isMainModule } from '../../dispatch/scripts/common.mjs';
import { parseIncrementGraph } from '../../dispatch/scripts/design-graph.mjs';
import { governingHash } from './ledger.mjs';

/** Highest-priority increment that is ready to implement: its state is 'ready' or 'pending'
 *  (never started), every prerequisite is complete, and it is not blocked/invalidated/complete. */
export function selectReadyIncrement(increments, states) {
  const byId = new Map((increments ?? []).map(increment => [increment.id, increment]));
  const candidates = [...states.entries()]
    .filter(([, state]) => state === 'ready' || state === 'pending')
    .map(([id]) => id)
    .sort((left, right) => {
      const leftPriority = byId.get(left)?.priority ?? Number(left.slice(1));
      const rightPriority = byId.get(right)?.priority ?? Number(right.slice(1));
      return leftPriority - rightPriority;
    });
  for (const id of candidates) {
    const increment = byId.get(id);
    const prerequisites = increment?.prerequisites ?? [];
    if (prerequisites.every(prerequisite => states.get(prerequisite) === 'complete')) {
      return increment ?? { id };
    }
  }
  return null;
}

/** Renders the machine-managed `## Execution Status` section body: increment rows grouped
 *  by state plus exactly one explicit `Next Action` line. */
export function renderExecutionStatus(increments, states, nextAction) {
  const rows = (increments ?? []).map(increment => ({
    ...increment,
    state: states?.get(increment.id) ?? 'pending',
  }));
  const grouped = {
    Completed: rows.filter(row => row.state === 'complete'),
    Current: rows.filter(row => ['active', 'reopened'].includes(row.state)),
    Ready: rows.filter(row => row.state === 'ready'),
    Blocked: rows.filter(row => row.state === 'blocked'),
    Invalidated: rows.filter(row => row.state === 'invalidated'),
  };
  const lines = [];
  for (const [title, entries] of Object.entries(grouped)) {
    if (entries.length === 0) continue;
    lines.push(`### ${title}`, '');
    for (const entry of entries) {
      lines.push(`| ${entry.id} | ${entry.state} | ${entry.summary ?? ''} |`);
    }
    lines.push('');
  }
  lines.push(`Next Action: ${nextAction}`, '');
  return lines.join('\n');
}

/** Fence-aware section boundary helpers shared by the status splice. */
function scanFencedHeadings(lines) {
  const headings = [];
  let fence = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    }
    if (!fence && /^##\s/.test(line)) headings.push(index);
  }
  return { headings, unclosed: fence !== null };
}

/** Splices the rendered status into the design source, replacing only the real (unfenced)
 *  `## Execution Status` section and leaving every other byte governed-identical. When the
 *  design has no such section, the fallback appends a new `## Execution Status` heading. */
export function applyExecutionStatus(source, renderedStatus) {
  const sourceText = String(source);
  const newline = sourceText.includes('\r\n') ? '\r\n' : '\n';
  const lines = sourceText.split(/\r?\n/);
  const { headings, unclosed } = scanFencedHeadings(lines);
  // An unclosed fence would extend the splice to EOF and delete governed sections; fail closed.
  if (unclosed) throw new Error('Design contains an unclosed code fence; repair it before the status update.');
  const start = headings.findIndex(index => /^##\s+Execution Status\s*$/.test(lines[index]));
  if (start === -1) {
    const heading = newline === '\r\n' ? renderedStatus.split('\n').join('\r\n') : renderedStatus;
    return `${sourceText.replace(/\s+$/, '')}\n\n## Execution Status${newline}${heading}`;
  }
  const startLine = headings[start];
  const endLine = start + 1 < headings.length ? headings[start + 1] : lines.length;
  const before = lines.slice(0, startLine + 1);
  const after = lines.slice(endLine);
  const statusLines = renderedStatus.split('\n');
  const rebuilt = [...before, ...statusLines, '', ...after];
  return rebuilt.join(newline);
}

/** Guard: a status-only mirror write preserves the governed design hash (Execution Status is
 *  excluded from governed content) so approval metadata stays fresh. */
export function statusMirrorPreservesGovernedHash(beforeSource, afterSource) {
  const before = governingHash(beforeSource, { kind: 'design' });
  const after = governingHash(afterSource, { kind: 'design' });
  return before.status === 'ok' && after.status === 'ok' && before.hash === after.hash;
}

/** Default `Next Action`: the next ready increment, else final integration once every
 *  increment is complete; otherwise the caller must name the action explicitly. */
export function defaultNextAction(increments, states) {
  const ready = selectReadyIncrement(increments, states);
  if (ready) return `implement:${ready.id}`;
  if ((increments ?? []).length > 0 && increments.every(increment => states.get(increment.id) === 'complete')) {
    return 'final-integration';
  }
  return null;
}

/** Status-only mirror write: renders from the design's increment graph and ledger-derived
 *  states, refuses any write that would change the governed hash, and renames atomically. */
export function updateExecutionStatus({ designPath, states, nextAction = null }) {
  const source = fs.readFileSync(designPath, 'utf8');
  const graph = parseIncrementGraph(source);
  if (!graph.valid) throw new Error(`Increment graph is invalid: ${graph.diagnostics.join('; ')}`);
  const given = states instanceof Map ? states : new Map(Object.entries(states ?? {}));
  const known = new Set(graph.increments.map(increment => increment.id));
  for (const id of given.keys()) {
    if (!known.has(id)) throw new Error(`Unknown increment in states: ${id}`);
  }
  const stateMap = new Map(graph.increments.map(increment => [increment.id, given.get(increment.id) ?? 'pending']));
  const action = nextAction ?? defaultNextAction(graph.increments, stateMap);
  if (!action) throw new Error('No ready increment and not all complete; pass an explicit --next action.');
  const updated = applyExecutionStatus(source, renderExecutionStatus(graph.increments, stateMap, action));
  if (!statusMirrorPreservesGovernedHash(source, updated)) {
    throw new Error('Status update would change the governed design hash; refusing to write.');
  }
  const staging = path.join(path.dirname(designPath), `.${path.basename(designPath)}.status.tmp`);
  fs.writeFileSync(staging, updated);
  fs.renameSync(staging, designPath);
  return { designPath, nextAction: action };
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = flag => {
    const index = args.indexOf(flag);
    return index === -1 ? null : args[index + 1] ?? '';
  };
  const designPath = value('--design');
  const statesJson = value('--states');
  if (!designPath || statesJson === null) {
    process.stderr.write('Usage: node design-run.mjs --design <path> --states \'{"I01":"complete"}\' [--next <action>]\n');
    process.exit(2);
  }
  try {
    const result = updateExecutionStatus({ designPath, states: JSON.parse(statesJson), nextAction: value('--next') });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
