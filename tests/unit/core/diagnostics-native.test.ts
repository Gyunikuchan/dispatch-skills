import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { phaseFixture } from './fixtures/diagnostics.ts';
test('SC2: repeated native review rounds count distinct captures without replay recounting', async () => {
  const f = phaseFixture('review', 2);
  const options = { ...f.options, handlers: { ...f.options.handlers,
    'wave-start': async (effect: Extract<import('../../../skills/dispatch/scripts/core/types.ts').Effect, { kind: 'wave-start' }>) => [{ type: 'WAVE_STARTED' as const, effectId: effect.id, waveKey: effect.id, attempt: 1, roster: effect.roster, native: [{ sourceKey: 'codex[0]', outputPath: 'output' }], early: [], claimPath: null, inputPath: 'input' }],
    'wave-finish': async (effect: Extract<import('../../../skills/dispatch/scripts/core/types.ts').Effect, { kind: 'wave-finish' }>) => [{ type: 'WAVE_DONE' as const, effectId: effect.id, round: effect.round, slots: [{ slot: 'codex[0]', state: 'native', claim: 'Reviewed' }], findings: effect.round === 1 ? [{ id: 'R1-F001', severity: 'MUST', category: 'correctness', locus: 'src/a.ts:L1', defect: 'claim', requiredChange: 'repair', sources: ['codex[0]'], scope: 'in' }] : [] }],
  } };
  let result = await start({ ...options, runStarted: f.runStarted });
  assert.equal(result.frame?.await, 'native', JSON.stringify(result.frame));
  result = await send({ ...options, rawEvent: { type: 'NATIVE_RESULTS', slots: [{ slot: 'codex[0]', sourceKey: 'codex[0]', outputPath: 'output' }] } });
  assert.equal(result.frame?.await, 'rule', JSON.stringify(result.frame));
  result = await send({ ...options, rawEvent: { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'reject', reason: 'Unsupported claim' } } } });
  assert.equal(result.frame?.await, 'native', JSON.stringify(result.frame));
  result = await send({ ...options, rawEvent: { type: 'NATIVE_RESULTS', slots: [{ slot: 'codex[0]', sourceKey: 'codex[0]', outputPath: 'output' }] } });
  assert.equal(result.frame?.await, 'done', JSON.stringify(result.frame));
  await send(options);
  assert.match(fs.readFileSync(path.join(f.session, 'diagnostics.md'), 'utf8'), /Native captures observed: 2;/);
});
