import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createFolder, dispatchMachine, fold, send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { appendEvent, readJournal } from '../../../skills/dispatch/scripts/core/journal.ts';
import { parseCommand } from '../../../skills/dispatch/scripts/lib/cli.ts';
import type { Handlers, RunStartedEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { awaitingMachine, fakeHandlers, RUN_STARTED } from './fixtures/machines.ts';
import { hash, parsedPlan } from './fixtures/diagnostics.ts';

const config = (model = 'first') => ({ 'read-delegates': { codex: { targets: [{ low: { model } }] } } });
async function fixture() {
  const ports = fakePorts(), runDir = path.join(tempDir(), '.state/runs/001-plan');
  const runStarted: RunStartedEvent = { type: 'RUN_STARTED', verb: 'plan', argument: 'fixture', level: 'low', levelSource: 'explicit', pins: null, fix: false, orchestrator: 'codex', orchestratorModel: null, overrides: {}, config: config(), repo: {} };
  await start({ runDir, ports, machine: dispatchMachine, handlers: {}, runStarted });
  return { ports, runDir, machine: dispatchMachine, handlers: {} };
}
test('SC5: CLI rejects refresh and event including the dry-run triple', () => {
  for (const extra of [[], ['--dry-run']]) assert.throws(() => parseCommand(['send', '--run', 'run', '--refresh-config', '--event', '{}', ...extra], { levels: [], pins: () => null, provider: () => null }), /cannot be combined/);
});
test('SC5: direct refresh and event rejection creates no files', async () => {
  const f = await fixture(), before = fs.readFileSync(path.join(f.runDir, 'events.jsonl'));
  const result = await send({ ...f, refreshConfig: true, rawEvent: {}, configSource: () => config('second'), dryRun: true });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(fs.readFileSync(path.join(f.runDir, 'events.jsonl')), before);
});
test('SC5: refresh is journaled and changes future plan review defaults on replay', async () => {
  const f = await fixture();
  const result = await send({ ...f, refreshConfig: true, configSource: () => config('second') });
  assert.equal(result.frame?.progress?.['executionConfig'] && (result.frame.progress['executionConfig'] as { status: string }).status, 'applied');
  const lines = readJournal(f.ports, f.runDir).lines;
  assert.equal(lines.filter((line) => line.type === 'EXECUTION_CONFIG_UPDATED').length, 1);
  const author = await send({ ...f, dryRun: true });
  const handlers: Handlers = {
    'parse-artifact': async (effect) => [{ type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'plan', hash, parsed: parsedPlan, defects: [] }],
    'prepare-review': async (effect) => [{ type: 'REVIEW_PREPARED', effectId: effect.id, scope: { paths: ['src/a.ts'] }, promptPaths: { 'codex[0]': 'prompt' } }],
    'wave-start': async (effect) => [{ type: 'WAVE_STARTED', effectId: effect.id, waveKey: effect.id, attempt: 1, roster: effect.roster, native: [{ sourceKey: 'codex[0]', model: effect.roster[0]!['model'], outputPath: 'output' }], early: [], claimPath: null, inputPath: 'input' }],
  };
  const review = await send({ ...f, handlers, rawEvent: { type: 'AUTHORED', path: author.frame?.data['path'] } });
  assert.equal(review.frame?.await, 'native', JSON.stringify(review.frame));
  assert.equal((review.frame?.data['slots'] as Array<{ model: string }>)[0]?.model, 'second');
});
test('SC5: dry-run refresh validates without journal or binding changes', async () => {
  const f = await fixture(), before = fs.readFileSync(path.join(f.runDir, 'events.jsonl'));
  const result = await send({ ...f, refreshConfig: true, configSource: () => config('second'), dryRun: true });
  assert.equal(result.frame?.error, undefined);
  assert.deepEqual(fs.readFileSync(path.join(f.runDir, 'events.jsonl')), before);
});
test('SC5: no-op refresh records no update', async () => {
  const f = await fixture();
  const result = await send({ ...f, refreshConfig: true, configSource: () => config() });
  assert.equal((result.frame?.progress?.['executionConfig'] as { status: string }).status, 'unchanged');
  assert.equal(readJournal(f.ports, f.runDir).lines.length, 1);
});

test('SC5: no-op refresh resumes queued work and records a broken stale lock', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), '.state/runs/001-review');
  ports.fs.mkdir(runDir, { recursive: true });
  const { type, ...data } = { ...RUN_STARTED, verb: 'review', config: config(), protocolRevision: 3 };
  appendEvent(ports, runDir, type, data, 1);
  ports.fs.writeAtomic(path.join(runDir, 'lock'), JSON.stringify({ pid: 999999, host: ports.proc.host, startedAt: new Date().toISOString() }));
  const handlers = { 'prepare-review': async (effect: { id: string }) => [{ type: 'REVIEW_PREPARED' as const, effectId: effect.id, scope: { empty: true }, promptPaths: {} }], handoff: async (effect: { id: string }) => [{ type: 'HANDOFF_DONE' as const, effectId: effect.id, destination: 'session', warning: null }] };
  const result = await send({ ports, runDir, machine: dispatchMachine, handlers, refreshConfig: true, configSource: () => config() });
  assert.equal(result.frame?.await, 'done', JSON.stringify(result.frame));
  assert.equal((result.frame?.progress?.['executionConfig'] as { status: string }).status, 'unchanged');
  const types = readJournal(ports, runDir).lines.map((line) => line.type);
  assert.ok(types.includes('LOCK_BROKEN') && types.includes('REVIEW_PREPARED'));
  assert.ok(!types.includes('EXECUTION_CONFIG_UPDATED'));
});
test('SC5: policy refresh rejection preserves journal', async () => {
  const f = await fixture(), before = fs.readFileSync(path.join(f.runDir, 'events.jsonl'));
  const result = await send({ ...f, refreshConfig: true, configSource: () => ({ ...config('second'), phases: { 'plan-review': { targets: { low: 1 }, rounds: { low: 2 } } } }) });
  assert.match(result.frame?.error ?? '', /execution-config-topology/);
  assert.deepEqual(fs.readFileSync(path.join(f.runDir, 'events.jsonl')), before);
});

test('SC5: refresh preserves materialized queue and its wave model', () => {
  const folder = createFolder(dispatchMachine);
  folder.apply({ ...RUN_STARTED, verb: 'review', protocolRevision: 3, config: config(), orchestrator: 'codex' });
  const queued = JSON.stringify(folder.queue), effect = folder.queue[0]!;
  folder.apply({ type: 'EXECUTION_CONFIG_UPDATED', revision: 1, boundarySeq: 2, delta: { read: [{ slot: 'codex[0]', provider: 'codex', levels: { low: { model: 'second' } } }], write: [] } });
  assert.equal(JSON.stringify(folder.queue), queued);
  folder.apply({ type: 'EFFECT_STARTED', effectId: effect.id, kind: effect.kind, attempt: 1 });
  folder.apply({ type: 'REVIEW_PREPARED', effectId: effect.id, scope: { paths: ['src/a.ts'] }, promptPaths: { 'codex[0]': 'prompt.md' } });
  const wave = folder.queue[0];
  assert.ok(wave?.kind === 'wave-start');
  if (wave?.kind === 'wave-start') assert.equal(wave.roster[0]?.['model'], 'first');
});
test('SC5: toggle intervals persist gaps and omit future instructions when disabled', async () => {
  const f = await fixture();
  const session = path.dirname(path.dirname(path.dirname(f.runDir)));
  for (const enabled of [true, false, true]) {
    const result = await send({ ...f, diagnosticToggle: () => enabled, diagnosticInstruction: () => 'Dispatch observations' });
    assert.equal('diagnostics' in (result.frame?.data ?? {}), enabled);
  }
  const record = JSON.parse(fs.readFileSync(path.join(f.runDir, 'diagnostics/capture.json'), 'utf8'));
  assert.deepEqual(record.intervals.map((v: { enabled: boolean }) => v.enabled), [true, false, true]);
  assert.match(fs.readFileSync(path.join(session, 'diagnostics.md'), 'utf8'), /on.*off.*on/);
});
test('SC5: revision-2 refresh is rejected without changing history', async () => {
  const f = await fixture(), journal = path.join(f.runDir, 'events.jsonl');
  fs.writeFileSync(journal, fs.readFileSync(journal, 'utf8').replace('"protocolRevision":3', '"protocolRevision":2'));
  const before = fs.readFileSync(journal);
  const result = await send({ ...f, refreshConfig: true, configSource: () => config('second') });
  assert.match(result.frame?.error ?? '', /unsupported-journal-protocol/);
  assert.deepEqual(fs.readFileSync(journal), before);
});

test('SC5: every machine rejects omitted and obsolete journal revisions', () => {
  const { type, protocolRevision: _protocolRevision, ...data } = RUN_STARTED;
  for (const machine of [dispatchMachine, awaitingMachine] as const) for (const protocolRevision of [undefined, 2]) assert.throws(() => fold(machine as import('../../../skills/dispatch/scripts/core/types.ts').Machine<unknown>, [{ seq: 1, v: 1, at: new Date().toISOString(), type, data: { ...data, ...(protocolRevision !== undefined ? { protocolRevision } : {}) } }]), /unsupported-journal-protocol/);
});
test('SC5: terminal refresh requires a new run', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), '.state/runs/001-plan');
  await start({ ports, runDir, machine: awaitingMachine, handlers: fakeHandlers, runStarted: RUN_STARTED });
  await send({ ports, runDir, machine: awaitingMachine, handlers: fakeHandlers, rawEvent: { type: 'AUTHORED', path: 'plan.md' } });
  const result = await send({ ports, runDir, machine: awaitingMachine, handlers: fakeHandlers, refreshConfig: true, configSource: () => config() });
  assert.match(result.frame?.error ?? '', /execution-config-terminal/);
});

test('SC5: a subsequent native wave uses refreshed defaults and reports applied', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), '.state/runs/001-review');
  const settings = (model: string) => ({ 'read-delegates': { codex: { nativeSubagentsOnly: true, targets: [{ low: { model, effort: 'low' } }] } }, phases: { 'code-review': { rounds: { low: 2 }, targets: { low: 1 } } } });
  const handlers: import('../../../skills/dispatch/scripts/core/types.ts').Handlers = {
    'prepare-review': async (effect) => [{ type: 'REVIEW_PREPARED', effectId: effect.id, scope: { paths: ['src/a.ts'] }, promptPaths: { 'codex[0]': 'prompt' } }],
    'wave-start': async (effect) => [{ type: 'WAVE_STARTED', effectId: effect.id, waveKey: effect.id, attempt: 1, roster: effect.roster, native: [{ sourceKey: 'codex[0]', model: effect.roster[0]!['model'], reasoningEffort: 'low', outputPath: 'output' }], early: [], claimPath: null, inputPath: 'input' }],
    'wave-finish': async (effect) => [{ type: 'WAVE_DONE', effectId: effect.id, round: effect.round, slots: [{ slot: 'codex[0]', state: 'native', claim: 'Reviewed' }], findings: effect.round === 1 ? [{ id: 'R1-F001', severity: 'MUST', category: 'correctness', locus: 'src/a.ts:L1', defect: 'claim', requiredChange: 'repair', sources: ['codex[0]'], scope: 'in' }] : [] }],
  };
  const options = { ports, runDir, machine: dispatchMachine, handlers };
  let result = await start({ ...options, runStarted: { ...RUN_STARTED, verb: 'review', orchestrator: 'codex', config: settings('first') } });
  result = await send({ ...options, refreshConfig: true, configSource: () => settings('second') });
  assert.equal((result.frame!.data['slots'] as Array<{ model: string }>)[0]?.model, 'first');
  assert.equal((result.frame!.progress!['executionConfig'] as { status: string }).status, 'deferred');
  result = await send({ ...options, rawEvent: { type: 'NATIVE_RESULTS', slots: [{ slot: 'codex[0]', sourceKey: 'codex[0]', outputPath: 'output' }] } });
  result = await send({ ...options, rawEvent: { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'reject', reason: 'Unsupported claim' } } } });
  assert.equal((result.frame!.data['slots'] as Array<{ model: string }>)[0]?.model, 'second');
  assert.equal((result.frame!.progress!['executionConfig'] as { status: string }).status, 'applied');
});
