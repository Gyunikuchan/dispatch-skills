import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateNativeResults } from '../../../skills/dispatch/scripts/machines/review.ts';
import { asNativeSlot, type NativeSlot } from '../../../skills/dispatch/scripts/machines/types.ts';

const descriptor = asNativeSlot({ sourceKey: 'copilot:0', substitutesFor: null, outputPath: 'out.md', model: 'gpt-6-luna', reasoningEffort: 'max' }) as NativeSlot;
const capture = (mapping: Record<string, unknown>) => ({ slot: 'copilot:0', sourceKey: 'copilot:0', outputPath: 'out.md', mapping });

test('native results reject an undisclosed launcher model or effort mismatch', () => {
  assert.match(validateNativeResults([capture({ launcherModel: 'gpt-6-sol', launcherEffort: 'max' })], [descriptor]) ?? '', /model gpt-6-sol \(configured gpt-6-luna\)/);
  assert.match(validateNativeResults([capture({ launcherModel: 'gpt-6-luna' })], [descriptor]) ?? '', /report the actually launched effort/);
});

test('native results accept matching launches and disclosed substitutions', () => {
  assert.equal(validateNativeResults([capture({ launcherModel: 'gpt-6-luna', launcherEffort: 'max' })], [descriptor]), null);
  assert.equal(validateNativeResults([capture({ launcherModel: 'gpt-6-sol', launcherEffort: 'high', substitution: 'host cannot select models' })], [descriptor]), null);
});

test('native results require the launched values even when a substitution is disclosed', () => {
  assert.match(validateNativeResults([capture({ substitution: 'host cannot select models' })], [descriptor]) ?? '', /report the actually launched model and effort/);
});

test('native results require exactly one capture per pending slot', () => {
  const ok = capture({ launcherModel: 'gpt-6-luna', launcherEffort: 'max' });
  assert.match(validateNativeResults([], [descriptor]) ?? '', /missing captures for pending native slots copilot:0/);
  assert.match(validateNativeResults([ok, ok], [descriptor]) ?? '', /duplicate copilot:0/);
  assert.match(validateNativeResults([{ ...ok, slot: 'other', sourceKey: 'other' }], [descriptor]) ?? '', /unknown other/);
});

test('native results attest the launched model even when the slot configures none', () => {
  const unconfigured = asNativeSlot({ sourceKey: 'copilot:0', substitutesFor: null, outputPath: 'out.md', model: null }) as NativeSlot;
  assert.match(validateNativeResults([capture({})], [unconfigured]) ?? '', /report the actually launched model/);
  assert.equal(validateNativeResults([capture({ launcherModel: 'host-default' })], [unconfigured]), null);
});
