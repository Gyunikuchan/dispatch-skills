#!/usr/bin/env node
import fs from 'node:fs';
import { parseIncrementGraph } from '../../dispatch/scripts/design-graph.mjs';
import { isMainModule } from '../../dispatch/scripts/common.mjs';
const REQUIRED = ['Context & Intent','Goals & Requirements','Architecture & Boundaries','Alternatives & Decisions','Risks, Security & Operations','Increment Dependency Graph','Increment Details','Final Integration'];
const INCREMENT_FIELDS = ['Outcome','Scope','Non-scope','Observable behavior','Affected contracts','Validation','Rollback boundary','Parallel safety'];
// Per-increment detail blocks: `### I<nn>` under `## Increment Details`, each carrying every field label.
function incrementDetails(source) {
  const lines = String(source).split(/\r?\n/);
  const start = lines.findIndex(line => /^##\s+Increment Details\s*$/.test(line));
  const blocks = new Map();
  if (start === -1) return blocks;
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    const heading = /^###\s+(I\d{2})\b/.exec(line);
    if (heading) { current = heading[1]; blocks.set(current, []); continue; }
    if (current) blocks.get(current).push(line);
  }
  return blocks;
}
export function lintDesign(source) {
  const diagnostics = [];
  for (const heading of REQUIRED) if (!new RegExp(`^##\\s+${heading.replace(/[&]/g,'\\&')}\\s*$`, 'm').test(source)) diagnostics.push({ code:'missing-section', heading });
  const graph = parseIncrementGraph(source);
  const details = incrementDetails(source);
  for (const { id } of graph.increments) {
    const block = details.get(id);
    if (!block) { diagnostics.push({ code: 'missing-increment-details', id }); continue; }
    for (const field of INCREMENT_FIELDS) {
      const pattern = new RegExp(`^\\s*[-*]\\s+${field}:\\s*\\S`, 'i');
      if (!block.some(line => pattern.test(line))) diagnostics.push({ code: 'missing-increment-field', id, field });
    }
  }
  const merged = [...diagnostics, ...graph.diagnostics];
  const increments = graph.increments.map(({ id, priority, prerequisites }) => ({ id, priority, prerequisites }));
  return { valid: merged.length === 0, diagnostics: merged, increments };
}
export function lintDesignFile(file) { return lintDesign(fs.readFileSync(file,'utf8')); }
// NOTE: isMainModule compares resolved paths; a raw `file://${argv[1]}` never matches on Windows.
if (isMainModule(import.meta.url)) { const result=lintDesignFile(process.argv[2]); console.log(JSON.stringify(result,null,2)); process.exitCode=result.valid?0:1; }
