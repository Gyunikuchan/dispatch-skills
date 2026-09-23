#!/usr/bin/env node

const GRAPH_HEADING = 'Increment Dependency Graph';

/** Splits a source into lines between the graph heading and the next unfenced `^## ` heading. */
export function incrementGraphSection(source) {
  const lines = String(source).split(/\r?\n/);
  // Fence-aware so fenced example headings never bound the section.
  const unfenced = [];
  let fence = null;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? null : marker;
      unfenced.push(false);
    } else {
      unfenced.push(!fence);
    }
  }
  const start = lines.findIndex((line, index) => unfenced[index] && /^##\s+Increment Dependency Graph\s*$/.test(line));
  if (start === -1) return [];
  const end = lines.findIndex((line, index) => index > start && unfenced[index] && /^##\s/.test(line));
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

function splitColumns(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map(column => column.trim());
}

function prerequisiteList(value) {
  return String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => item !== 'none');
}

function pathList(value) {
  return String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

/**
 * Parses `| I<nn> | <priority> | <summary> | <prerequisites> | <paths> |` rows from the
 * `## Increment Dependency Graph` section only. A missing Paths column is tolerated as an
 * empty path set; rows outside the section are never matched.
 */
export function parseIncrementGraph(source) {
  const diagnostics = [];
  const sectionLines = incrementGraphSection(source);
  const rows = [];
  const ids = new Set();
  for (const line of sectionLines) {
    const match = /^\|\s*(I\d{2})\s*\|/.exec(line);
    if (!match) continue;
    const columns = splitColumns(line);
    const id = columns[0];
    const priority = Number(/^\|\s*I\d{2}\s*\|\s*(\d+)\s*\|/.exec(line)?.[1]);
    if (Number.isNaN(priority)) {
      diagnostics.push({ code: 'invalid-priority', id });
      continue;
    }
    if (ids.has(id)) diagnostics.push({ code: 'duplicate-id', id });
    ids.add(id);
    const summary = columns[2]?.trim() ?? '';
    const prerequisites = prerequisiteList(columns[3] ?? '');
    const paths = (columns.length > 4 ? columns.slice(4) : [])
      .flatMap(column => String(column).split(','))
      .map(item => item.trim())
      .filter(Boolean);
    rows.push({ id, priority, summary, prerequisites, paths });
  }
  if (rows.length === 0) diagnostics.push({ code: 'missing-increments' });
  const sequence = rows.map(row => Number(row.id.slice(1))).sort((a, b) => a - b);
  if (sequence.some((number, index) => number !== index + 1)) diagnostics.push({ code: 'invalid-id-sequence' });
  const priorities = rows.map(row => row.priority).sort((a, b) => a - b);
  if (new Set(priorities).size !== priorities.length || priorities.some((priority, index) => priority !== index + 1)) {
    diagnostics.push({ code: 'invalid-priority-order' });
  }
  const edges = new Map(rows.map(row => [row.id, row.prerequisites]));
  for (const row of rows) {
    for (const prerequisite of row.prerequisites) {
      if (!ids.has(prerequisite)) diagnostics.push({ code: 'missing-prerequisite', id: row.id, prerequisite });
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = id => {
    if (visiting.has(id)) { diagnostics.push({ code: 'cycle', id }); return; }
    if (visited.has(id) || !edges.has(id)) return;
    visiting.add(id);
    for (const dependency of edges.get(id)) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const row of rows) visit(row.id);
  return { valid: diagnostics.length === 0, diagnostics, increments: rows };
}
