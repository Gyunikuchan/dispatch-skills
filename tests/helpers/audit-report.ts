import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './fake-ports.ts';
// @ts-expect-error -- local .mjs helper is checked through its public commands
import * as status from '../../.agents/skills/audit-dispatch-skills-fix/scripts/status.mjs';

export const SENTINEL = 'No defect findings.';
export const finding = (id: string, severity = 'medium', state = '') => [
  `#### ${id}: Title of ${id}`, `- **${severity}** · correctness · Verified · review`,
  ...(state ? [`- **Status**: ${state}`] : []),
  '- **Location**: `skills/dispatch/SKILL.md:10`', '- **Claim**: claim.',
  '- **Evidence**: evidence.', '- **Proposal**: proposal.', '',
].join('\n');
export const opportunity = (id = 'O-1') => [
  `#### ${id}: Improvement ${id}`, '- **Hypothesis**: preserve diagnostics.',
  '- **Benefit**: unmeasured — compare repair success.', '- **Cost**: state and frame changes.', '',
].join('\n');
export function report(defects = finding('A-1'), opportunities = '') {
  const root = tempDir(), file = path.join(root, '2026-10-07-0000-audit.md');
  fs.writeFileSync(file, ['# Audit', '## 1. Summary', '', '## 2. Dispatch platforms', '',
    '## 3. Findings', '', defects, '## 4. Opportunities', '', opportunities,
    '## 5. Coverage and budget', '', '## 6. Appendix', ''].join('\n'));
  return { root, file };
}
export function captured(run: () => void) {
  const out: string[] = [], log = console.log, error = console.error;
  console.log = (...args: unknown[]) => { out.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { out.push(args.join(' ')); };
  try { run(); } finally { console.log = log; console.error = error; }
  return out.join('\n');
}
function json(root: string, data: unknown) {
  const file = path.join(root, 'reply.json'); fs.writeFileSync(file, JSON.stringify(data)); return file;
}
const triage = (changes: Record<string, unknown> = {}) => ({
  ruling: 'accept', evidence: 'Current source confirms the defect.', impact: 'Retry loses diagnostics.',
  recommendation: 'Retain diagnostics and verify the retry frame.', group: 'revision-diagnostics', priority: 'medium',
  affectedPaths: ['skills/dispatch/SKILL.md'], dependsOn: [], verification: ['node --test focused.test.ts'], ...changes,
});
export function recordTriage(root: string, file: string, id: string, changes: Record<string, unknown> = {}) {
  return captured(() => status.cmdTriage(root, file, ['triage', id, '--from', json(root, triage(changes))]));
}
export function recordProgress(root: string, file: string, ids: string, data: Record<string, unknown>) {
  return captured(() => status.cmdProgress(root, file, ['progress', ids, '--from', json(root, data)]));
}
export function artifact(root: string, name: string) { fs.writeFileSync(path.join(root, name), 'Evidence'); return name; }
export function unchanged(file: string, run: () => void, pattern: RegExp) {
  const before = fs.readFileSync(file, 'utf8'); assert.throws(run, pattern); assert.equal(fs.readFileSync(file, 'utf8'), before);
}


export { status };
