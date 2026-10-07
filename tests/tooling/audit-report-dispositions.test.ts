import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finding, opportunity, report, captured, recordTriage, unchanged, status } from '../helpers/audit-report.ts';

test('audit report progress set open cannot bypass triage or opportunity selection', () => {
  const { root, file } = report(finding('A-1'), opportunity());
  unchanged(file, () => captured(() => status.cmdSet(root, file, ['set', 'O-1', 'open'])), /triage|selection/i);
  unchanged(file, () => captured(() => status.cmdSet(root, file, ['set', 'A-1', 'fixed'])), /triage|code-reviewed/i);
});

test('audit report progress legacy fixed disposition cannot be reset by triage', () => {
  const { root, file } = report(finding('A-1', 'high', 'fixed — abc123'));
  unchanged(file, () => recordTriage(root, file, 'A-1'), /fixed/);
});

test('audit report progress set cannot reopen or defer a fixed item', () => {
  const { root, file } = report(finding('A-1', 'medium', 'fixed — retained commit'));
  for (const state of ['open', 'deferred', 'decision', 'false-positive']) {
    unchanged(file, () => captured(() => status.cmdSet(root, file, ['set', 'A-1', state])), /fixed/);
  }
});
