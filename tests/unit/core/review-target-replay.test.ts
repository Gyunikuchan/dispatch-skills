import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewMachine } from '../../../skills/dispatch/scripts/machines/review.ts';
import { createFolder, fold } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { JOURNAL_PROTOCOL_REVISION, type Event, type JournalLine, type RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
const started: RunStartedEvent = { type: 'RUN_STARTED', protocolRevision: JOURNAL_PROTOCOL_REVISION, verb: 'review', argument: '', level: 'low', levelSource: 'explicit', pins: null, fix: false, orchestrator: 'claude', orchestratorModel: null, overrides: {}, repo: {}, config: { 'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] } } } };


test('change receipt: recorded identity results replay without checking the live target', () => {
  const folder = createFolder(reviewMachine), events: Event[] = [started]; folder.apply(started);
  const apply = (event: Event) => { events.push(event); folder.apply(event); };
  const effect = folder.queue[0]!; apply({ type: 'EFFECT_STARTED', effectId: effect.id, kind: effect.kind, attempt: 1 });
  apply({ type: 'REVIEW_PREPARED', effectId: effect.id, scope: { manifestPath: 'prior.json' }, promptPaths: {} });
  const launched = folder.queue[0]!; apply({ type: 'EFFECT_STARTED', effectId: launched.id, kind: launched.kind, attempt: 1 });
  apply({ type: 'WAVE_STARTED', effectId: launched.id, waveKey: launched.id, attempt: 0, roster: [], native: [], early: [], claimPath: null, inputPath: '', completed: { type: 'WAVE_DONE', effectId: launched.id, round: 1, slots: [{ slot: 'codex[0]', state: 'success' }], findings: [] } } as Event);
  const check = folder.queue[0]!; apply({ type: 'EFFECT_STARTED', effectId: check.id, kind: check.kind, attempt: 1 });
  apply({ type: 'REVIEW_TARGET_CHECKED', effectId: check.id, manifestPath: 'checked.json' });
  const lines: JournalLine[] = events.map(({ type, ...data }, index) => ({ seq: index + 1, v: 1, at: 'now', type, data }));
  assert.deepEqual(fold(reviewMachine, lines).state, folder.state); assert.equal(folder.state.tag, 'settled');
});
