import assert from 'node:assert/strict';
import { test } from 'node:test';
import { account, elapsed, emptyCapture, renderDiagnostics, unionDuration, type Invocation } from '../../../skills/dispatch/scripts/domain/diagnostics.ts';
test('SC3: parallel invocation work is separate from elapsed time', () => {
  const c = emptyCapture(2000);
  const base: Invocation = { id: 'a'.repeat(24), producer: 'b'.repeat(24), sequence: 1, phase: 'implementation', surface: 'cli', provider: 'codex', configuredModel: 'reader', mode: 'cli', start: 0, durationMs: 1000, outcome: 'ok', launched: true };
  account(c, base); account(c, { ...base, producer: 'c'.repeat(24) });
  assert.equal(c.totals.workMs, 2000);
  assert.equal(unionDuration([{ start: 0, end: 1000 }, { start: 0, end: 1000 }]), 1000);
});
test('SC3: nested phases render inclusive and exclusive timing separately', () => {
  const c = emptyCapture(2000);
  c.phases = [{ id: 'implementation:1', name: 'implementation', start: 0, end: 2000, outcome: 'complete', approvalMs: 0 }, { id: 'implementation/code-review:2', name: 'code review', start: 1000, end: 1500, outcome: 'complete', approvalMs: 0 }];
  assert.match(renderDiagnostics([c], 2000), /implementation \| complete \| 2000 \| 1500/);
});
test('SC3: clock anomalies suppress negative durations', () => { assert.equal(elapsed(2000, 1000), null); });
test('SC3: duplicate failed attempts contribute once', () => {
  const c = emptyCapture(2000), item: Invocation = { id: 'a'.repeat(24), producer: 'b'.repeat(24), sequence: 1, phase: 'ask', surface: 'cli', provider: 'codex', configuredModel: null, mode: 'cli', start: 0, durationMs: 1000, outcome: 'quota', launched: true };
  account(c, item); account(c, item);
  assert.equal(c.totals.failures, 1); assert.equal(c.totals.workMs, 1000);
});
