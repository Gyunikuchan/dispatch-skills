import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { diagnosticWarning, publishInvocation, publishReport } from '../../../skills/dispatch/scripts/core/diagnostics.ts';
import { account, DIAGNOSTIC_LIMITS, emptyCapture, type Invocation } from '../../../skills/dispatch/scripts/domain/diagnostics.ts';
import { send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { awaitingMachine, fakeHandlers, RUN_STARTED } from './fixtures/machines.ts';
import { phaseFixture } from './fixtures/diagnostics.ts';
const invocation: Invocation = { id: 'a'.repeat(24), producer: 'b'.repeat(24), sequence: 1, phase: 'ask', surface: 'cli', provider: 'codex', configuredModel: null, mode: 'cli', start: 0, durationMs: 1000, outcome: 'ok', launched: true };
test('SC8: diagnostic I/O failure preserves accepted reply and completion', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), '.state/runs/001-plan');
  await start({ ports, runDir, machine: awaitingMachine, handlers: fakeHandlers, runStarted: RUN_STARTED });
  const normal = ports.fs.writeAtomic;
  ports.fs.writeAtomic = (file, text) => { if (/diagnostic/.test(file)) throw new Error('injected'); normal(file, text); };
  const result = await send({ ports, runDir, machine: awaitingMachine, handlers: fakeHandlers, rawEvent: { type: 'AUTHORED', path: 'plan.md' }, diagnosticToggle: () => true });
  assert.equal(result.exitCode, 0); assert.equal(result.frame?.await, 'done');
  assert.match(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8'), /AUTHORED/);
  assert.equal(ports.stderrLines.filter((line) => /diagnostics collection/.test(line)).length, 1);
});

test('SC8: toggle read failure retains the validated start setting without a prior capture', async () => {
  const ports = fakePorts(), runDir = path.join(tempDir(), '.state/runs/001-plan');
  const result = await start({ ports, runDir, machine: awaitingMachine, handlers: fakeHandlers, runStarted: { ...RUN_STARTED, config: { diagnostics: true } }, diagnosticToggle: () => { throw new Error('read failed'); } });
  assert.equal(result.frame?.await, 'author');
  assert.ok(result.frame?.data['diagnostics']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'diagnostics/capture.json'), 'utf8')).enabled, true);
  assert.equal(ports.stderrLines.filter((line) => /diagnostics collection/.test(line)).length, 1);
});
test('SC8: render contention preserves last good report', () => {
  const ports = fakePorts(), session = tempDir(), runDir = path.join(session, '.state/runs/001-plan');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(session, 'diagnostics.md'), 'last good');
  fs.writeFileSync(path.join(session, '.state/diagnostics.render.lock'), JSON.stringify({ pid: ports.proc.pid, host: ports.proc.host }));
  publishReport(ports, runDir, true, diagnosticWarning(ports));
  assert.equal(fs.readFileSync(path.join(session, 'diagnostics.md'), 'utf8'), 'last good');
  assert.equal(ports.stderrLines.length, 1);
});
test('SC8: bounded detail retains aggregate counters with deduplication', () => {
  const capture = emptyCapture(0);
  for (let sequence = 1; sequence <= 1000; sequence++) { account(capture, { ...invocation, sequence }); account(capture, { ...invocation, sequence }); }
  assert.equal(capture.totals.launched, 1000); assert.equal(capture.totals.workMs, 1000000);
  assert.equal(capture.invocations.length, DIAGNOSTIC_LIMITS.details);
  assert.ok(Buffer.byteLength(JSON.stringify(capture)) < DIAGNOSTIC_LIMITS.runBytes);
});
test('SC8: malformed diagnostic capture preserves existing report', () => {
  const ports = fakePorts(), session = tempDir(), runDir = path.join(session, '.state/runs/001-plan');
  fs.mkdirSync(path.join(runDir, 'diagnostics'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'diagnostics/capture.json'), '{');
  fs.writeFileSync(path.join(session, 'diagnostics.md'), 'last good');
  publishInvocation(ports, runDir, invocation);
  publishReport(ports, runDir, true, diagnosticWarning(ports));
  assert.equal(fs.readFileSync(path.join(session, 'diagnostics.md'), 'utf8'), 'last good');
});

test('SC8: engine fault preserves recorded instruction evidence and links the partial report', async () => {
  const f = phaseFixture('review', 2), source = fs.readFileSync(new URL('../../../skills/dispatch/references/diagnostics.md', import.meta.url), 'utf8');
  const options = { ...f.options, diagnosticInstruction: () => source, handlers: { ...f.options.handlers,
    'wave-start': async (effect: Extract<import('../../../skills/dispatch/scripts/core/types.ts').Effect, { kind: 'wave-start' }>) => [{ type: 'WAVE_STARTED' as const, effectId: effect.id, waveKey: effect.id, attempt: 1, roster: effect.roster, native: [{ sourceKey: 'codex[0]', outputPath: 'output' }], early: [], claimPath: null, inputPath: 'input' }],
    'wave-finish': async (effect: Extract<import('../../../skills/dispatch/scripts/core/types.ts').Effect, { kind: 'wave-finish' }>) => [{ type: 'WAVE_DONE' as const, effectId: effect.id, round: effect.round, slots: [{ slot: 'codex[0]', state: 'native', claim: 'Reviewed' }], findings: [{ id: 'R1-F001', severity: 'MUST', category: 'correctness', locus: 'src/a.ts:L1', defect: 'claim', requiredChange: 'repair', sources: ['codex[0]'], scope: 'in' }] }],
  } };
  await start({ ...options, runStarted: f.runStarted });
  const excerpt = 'Runtime metrics require no reply.';
  await send({ ...options, rawEvent: { v: 1, event: { type: 'NATIVE_RESULTS', slots: [{ slot: 'codex[0]', sourceKey: 'codex[0]', outputPath: 'output', mapping: { launcherModel: 'host-default' } }] }, diagnostics: { observations: [{ v: 1, id: 'one', component: 'core/interpreter.ts', category: 'driver protocol', trigger: excerpt, evidence: excerpt, impact: excerpt, proposedFix: excerpt, confidence: excerpt }] } } });
  const report = path.join(f.session, 'diagnostics.md');
  assert.ok(fs.readFileSync(report, 'utf8').includes(`Evidence: ${excerpt}`));
  options.handlers['prepare-review'] = async () => { throw new Error('injected operational fault'); };
  const fault = await send({ ...options, rawEvent: { type: 'RULINGS', rulings: { 'R1-F001': { ruling: 'reject', reason: 'Unsupported claim' } } } });
  assert.equal(fault.frame?.data['outcome'], 'fault');
  assert.ok(fs.readFileSync(report, 'utf8').includes(`Evidence: ${excerpt}`));
  assert.equal((fault.frame?.data['diagnostics'] as { path: string }).path, report.replaceAll('\\', '/'));
});
