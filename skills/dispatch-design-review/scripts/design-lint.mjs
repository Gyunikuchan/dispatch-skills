#!/usr/bin/env node
import fs from 'node:fs';
import { parseIncrementGraph } from '../../dispatch/scripts/design-graph.mjs';
const REQUIRED = ['Architecture & Boundaries','Alternatives & Decisions','Risks, Security & Operations','Increment Dependency Graph'];
export function lintDesign(source) {
  const diagnostics = [];
  for (const heading of REQUIRED) if (!new RegExp(`^##\\s+${heading.replace(/[&]/g,'\\&')}\\s*$`, 'm').test(source)) diagnostics.push({ code:'missing-section', heading });
  const graph = parseIncrementGraph(source);
  const merged = [...diagnostics, ...graph.diagnostics];
  const increments = graph.increments.map(({ id, priority, prerequisites }) => ({ id, priority, prerequisites }));
  return { valid: merged.length === 0, diagnostics: merged, increments };
}
export function lintDesignFile(file) { return lintDesign(fs.readFileSync(file,'utf8')); }
if (import.meta.url === `file://${process.argv[1]}`) { const result=lintDesignFile(process.argv[2]); console.log(JSON.stringify(result,null,2)); process.exitCode=result.valid?0:1; }
