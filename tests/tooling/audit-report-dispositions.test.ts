import { test } from 'node:test';
import { finding, opportunity, report, captured, recordTriage, unchanged, status } from '../helpers/audit-report.ts';

test('audit report progress set enforces triage gating and terminal fixed state', () => {
  const { root, file } = report(finding('A-1') + finding('A-2', 'medium', 'fixed — retained commit'), opportunity());
  unchanged(file, () => captured(() => status.cmdSet(root, file, ['set', 'O-1', 'open'])), /triage|selection/i);
  unchanged(file, () => captured(() => status.cmdSet(root, file, ['set', 'A-1', 'fixed'])), /triage|code-reviewed/i);
  for (const state of ['open', 'deferred', 'decision', 'false-positive']) {
    unchanged(file, () => captured(() => status.cmdSet(root, file, ['set', 'A-2', state])), /fixed/);
  }
  unchanged(file, () => recordTriage(root, file, 'A-2'), /fixed/);
});
