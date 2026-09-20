#!/usr/bin/env node
import fs from 'node:fs';
const REQUIRED = ['Architecture & Boundaries','Alternatives & Decisions','Risks, Security & Operations','Increment Dependency Graph'];
export function lintDesign(source) {
  const diagnostics = [];
  for (const heading of REQUIRED) if (!new RegExp(`^##\\s+${heading.replace(/[&]/g,'\\&')}\\s*$`, 'm').test(source)) diagnostics.push({ code:'missing-section', heading });
  const rows = [...source.matchAll(/^\|\s*(I\d{2})\s*\|\s*(\d+)\s*\|\s*([^|]+)\|\s*([^|]+)\|/gm)].map(m=>({id:m[1],priority:Number(m[2]),prerequisites:m[4].trim()}));
  const ids = new Set();
  for (const row of rows) { if (ids.has(row.id)) diagnostics.push({code:'duplicate-id',id:row.id}); ids.add(row.id); }
  if (rows.length === 0) diagnostics.push({code:'missing-increments'});
  const sequence = rows.map(row => Number(row.id.slice(1))).sort((a, b) => a - b);
  if (sequence.some((number, index) => number !== index + 1)) diagnostics.push({code:'invalid-id-sequence'});
  const priorities = rows.map(r=>r.priority).sort((a, b) => a - b);
  if (new Set(priorities).size !== priorities.length || priorities.some((priority, index) => priority !== index + 1)) diagnostics.push({code:'invalid-priority-order'});
  const edges = new Map(rows.map(row => [row.id, row.prerequisites.split(',').map(s => s.trim()).filter(Boolean).filter(p => p !== 'none')]));
  for (const row of rows) for (const prereq of edges.get(row.id) ?? []) if (!ids.has(prereq)) diagnostics.push({code:'missing-prerequisite',id:row.id,prerequisite:prereq});
  const visiting = new Set(); const visited = new Set();
  const visit = id => { if (visiting.has(id)) { diagnostics.push({code:'cycle',id}); return; } if (visited.has(id) || !edges.has(id)) return; visiting.add(id); for (const dep of edges.get(id)) visit(dep); visiting.delete(id); visited.add(id); };
  for (const row of rows) visit(row.id);
  return { valid: diagnostics.length === 0, diagnostics, increments: rows };
}
export function lintDesignFile(file) { return lintDesign(fs.readFileSync(file,'utf8')); }
if (import.meta.url === `file://${process.argv[1]}`) { const result=lintDesignFile(process.argv[2]); console.log(JSON.stringify(result,null,2)); process.exitCode=result.valid?0:1; }
