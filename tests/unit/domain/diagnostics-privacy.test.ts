import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { emptyCapture, invocation, observations, renderDiagnostics, shareableText, type Invocation } from '../../../skills/dispatch/scripts/domain/diagnostics.ts';
import { invocationObserver, publishReport } from '../../../skills/dispatch/scripts/core/diagnostics.ts';
import { dispatchMachine, send, start } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { createWaveStartHandler, createWaveFinishHandler, runWaveWorker, type WaveInput, type WorkerDeps, type WaveDeps, type SlotFinal } from '../../../skills/dispatch/scripts/effects/wave.ts';
import { nodeLinkFs } from '../../../skills/dispatch/scripts/lib/node-fs-ext.ts';
import { SPECS } from '../../../skills/dispatch/scripts/providers/index.ts';
import { runDelegate, type RunnerFs } from '../../../skills/dispatch/scripts/providers/runner.ts';
import type { DelegateRequest, ProcessResult, RunOutcome } from '../../../skills/dispatch/scripts/providers/types.ts';
import type { NativeDescriptor } from '../../../skills/dispatch/scripts/providers/native.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { RUN_STARTED } from '../core/fixtures/machines.ts';
test('SC7: projection discards raw provider paths and identities', () => {
  const raw = { id: 'a'.repeat(24), producer: 'b'.repeat(24), sequence: 1, phase: 'ask', surface: 'cli', provider: 'codex', configuredModel: 'reader', mode: 'cli', start: 0, durationMs: 1000, outcome: 'ok', launched: true, cwd: 'C:/private-canary', stdoutPath: 'C:/stdout-canary', sessionId: 'session-canary', promptPath: 'C:/prompt-canary', briefPath: 'C:/brief-canary', attachments: ['C:/attachment-canary'], resume: 'resume-canary', outputPath: 'C:/output-canary' };
  assert.doesNotMatch(JSON.stringify(invocation(raw as Invocation)), /canary/);
});
test('SC7: uncertain evidence is withheld and hostile fences are inert', () => {
  assert.equal(shareableText('arbitrary-secret-canary'), 'evidence withheld');
  assert.equal(shareableText('```dispatch```', ['```dispatch```']), 'dispatch');
});
test('SC7: allowed observation fields exclude arbitrary metadata', () => {
  const result = observations({ observations: [{ v: 1, id: 'one', component: 'core/frame.ts', category: 'driver protocol', trigger: 'secret-canary', evidence: 'secret-canary', impact: 'secret-canary', proposedFix: 'secret-canary', confidence: 'secret-canary', apiKey: 'secret-canary' }] });
  assert.equal(result.values?.length, 1); assert.doesNotMatch(JSON.stringify(result), /secret-canary|apiKey/);
});

test('SC7: structured dispatch errors preserve useful codes while withholding private detail', () => {
  const text = shareableText('model-not-found: private-project-canary C:/user-canary/model ```');
  assert.equal(text, 'dispatch error: model-not-found; detail withheld');
  const result = observations({ observations: [{ v: 1, id: 'one', component: 'effects/wave.ts', category: 'routing/delegation', trigger: 'quota: private-user-canary', evidence: text, impact: 'private-canary', proposedFix: 'private-canary', confidence: 'private-canary' }] });
  assert.match(JSON.stringify(result), /model-not-found/);
  assert.doesNotMatch(JSON.stringify(result), /canary|```/);
});

test('SC7: real instruction excerpts survive repeated sanitization and Markdown export', () => {
  const source = fs.readFileSync(new URL('../../../skills/dispatch/references/diagnostics.md', import.meta.url), 'utf8');
  const excerpt = '`{v:1,event:<existing event>,diagnostics:{observations:[]}}`. Bare events remain valid.';
  const raw = { v: 1, id: 'incident-identity-canary', component: 'domain/diagnostics.ts', category: 'routing/delegation', trigger: excerpt, evidence: excerpt, impact: 'routing/delegation', proposedFix: excerpt, confidence: excerpt };
  const projected = observations({ observations: [raw] }, [source]).values!;
  assert.equal(projected[0]?.evidence, shareableText(excerpt, [source]));
  assert.equal(projected[0]?.impact, 'routing/delegation');
  assert.deepEqual(observations({ observations: projected }, [source]).values, projected);
  const capture = emptyCapture(0);
  capture.phases = [{ id: 'review:1', name: 'code review', start: 0, outcome: 'partial', approvalMs: 0, observations: projected }];
  const rendered = renderDiagnostics([capture], 0, false, [source]);
  assert.match(rendered, /Evidence: \{v:1,event: existing event ,diagnostics:\{observations:\[\]\}\}/);
  assert.match(rendered, /Impact: routing\/delegation/);
  assert.match(rendered, /source: host/);
  assert.doesNotMatch(JSON.stringify(projected) + rendered, /incident-identity-canary|evidence withheld/);
});

test('SC7: new dispatch-owned modules are accepted as observation owners', () => {
  for (const component of ['domain/diagnostics.ts', 'domain/execution-config.ts', 'machines/diagnostics.ts', 'machines/execution-config.ts', 'lib/diagnostic-usage.ts']) {
    const result = observations({ observations: [{ v: 1, id: 'one', component, category: 'driver protocol', trigger: 'timeout', evidence: 'timeout', impact: 'timeout', proposedFix: 'timeout', confidence: 'timeout' }] });
    assert.equal(result.rejected, 0, component);
    assert.equal(result.values?.[0]?.component, component);
  }
});

test('SC7: real wave runner and coordinator publication excludes typed path and identity canaries', async () => {
  const ports = fakePorts(), session = tempDir(), runDir = path.join(session, '.state/runs/001-review');
  const canaries = ['cwd-canary', 'prompt-canary', 'log-canary', 'attachment-canary', 'session-canary', 'resume-canary', 'stdout-canary', 'objective-canary', 'native-output-canary', 'observer-canary'];
  const privatePath = (name: string) => path.join(session, name);
  const paths = { 'codex[0]': { promptPath: privatePath('prompt-canary.md'), logPath: privatePath('log-canary.log'), attachments: [privatePath('attachment-canary.md')] }, 'claude[0]': { promptPath: privatePath('native-prompt-canary.md'), logPath: privatePath('native-output-canary.log'), attachments: [privatePath('native-attachment-canary.md')] } };
  for (const entry of Object.values(paths)) { fs.writeFileSync(entry.promptPath, 'objective-canary'); for (const file of entry.attachments) fs.writeFileSync(file, 'source-canary'); }
  const context: Omit<WaveInput, 'effectId' | 'round' | 'timeoutMs' | 'roster'> = { cwd: privatePath('cwd-canary'), paths, review: 'code', orchestratorPlatform: 'claude' };
  const runnerFs: RunnerFs = { readText: (file) => fs.readFileSync(file, 'utf8'), writeText: (file, text) => fs.writeFileSync(file, text), realpath: (file) => file, size: (file) => fs.existsSync(file) ? fs.statSync(file).size : null, readPrefix: (file, n) => fs.readFileSync(file).subarray(0, n).toString() };
  const requests: DelegateRequest[] = [], outcomes: RunOutcome[] = [];
  const worker: WorkerDeps = { fs: nodeLinkFs, proc: ports.proc, clock: ports.clock, specs: SPECS, modes: () => ['cli'], async run(provider, request, mode) {
    requests.push(request);
    assert.ok(request.diagnostics);
    const processResult: ProcessResult = { exit: 0, signal: null, stdout: [JSON.stringify({ type: 'thread.started', thread_id: 'session-canary' }), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'CLEAN', findings: [] }) } }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 3, cached_input_tokens: 2 } })].join('\n'), stdoutPath: privatePath('stdout-canary.log'), stderrTail: 'observer-canary', durationMs: 17, timedOut: false, truncated: false };
    const result = await runDelegate(SPECS[provider], request, mode, { fs: runnerFs, process: { start: () => ({ pid: 1, done: Promise.resolve(processResult) }), signal: () => {} }, clock: ports.clock, platform: { os: 'linux', arch: 'x64', wsl: false, bubblewrap: true, argvLimit: 100000, home: '/home/user-canary', path: [], pathExt: [] }, binary: 'codex', nonce: () => 'nonce', env: { USER: 'observer-canary' }, observe: invocationObserver(ports, request.diagnostics!, provider, request.model, mode) });
    const outcome: RunOutcome = result.outcome.status === 'ok' ? { ...result.outcome, sessionId: 'session-canary', resume: 'resume-canary' } : result.outcome;
    outcomes.push(outcome); return outcome;
  } };
  const workers: Promise<unknown>[] = [];
  const deps: WaveDeps = { fs: nodeLinkFs, proc: ports.proc, clock: ports.clock, context: () => context, launchWorker: (dir, id, attempt) => { workers.push(runWaveWorker(dir, id, attempt, worker)); }, awaitWorker: async () => { await Promise.all(workers); } };
  const options = { ports, runDir, machine: dispatchMachine, diagnosticToggle: () => true, handlers: {
    'prepare-review': async (effect: Extract<import('../../../skills/dispatch/scripts/core/types.ts').Effect, { kind: 'prepare-review' }>) => [{ type: 'REVIEW_PREPARED' as const, effectId: effect.id, scope: { paths: ['src/a.ts'] }, promptPaths: Object.fromEntries(Object.entries(paths).map(([slot, p]) => [slot, p.promptPath])) }],
    'wave-start': createWaveStartHandler(deps), 'wave-finish': createWaveFinishHandler(deps),
    handoff: async (effect: { id: string }) => [{ type: 'HANDOFF_DONE' as const, effectId: effect.id, destination: session, warning: null }],
  } };
  const result = await start({ ...options, runStarted: { ...RUN_STARTED, verb: 'review', argument: 'objective-canary', orchestrator: 'claude', overrides: { sessionDir: session }, config: { diagnostics: true, phases: { 'code-review': { targets: { low: 2 }, rounds: { low: 1 } } }, 'read-delegates': { codex: { targets: [{ low: { model: 'reader' } }] }, claude: { nativeSubagentsOnly: true, targets: [{ low: { model: 'native', effort: 'medium' } }] } } } } });
  assert.equal(result.frame?.await, 'native', JSON.stringify(result.frame));
  const descriptors = result.frame?.data['slots'] as NativeDescriptor[];
  assert.ok(descriptors.some((d) => d.promptPath.includes('canary') && d.attachments.some((v) => v.includes('canary'))));
  for (const d of descriptors) fs.writeFileSync(d.outputPath, JSON.stringify({ status: 'CLEAN', findings: [] }));
  const done = await send({ ...options, rawEvent: { v: 1, event: { type: 'NATIVE_RESULTS', slots: descriptors.map((d) => ({ slot: d.sourceKey.split('#')[0], sourceKey: d.sourceKey, outputPath: d.outputPath, mapping: { launcherModel: d.model, ...(d.reasoningEffort ? { launcherEffort: d.reasoningEffort } : {}) } })) }, diagnostics: { observations: [{ v: 1, id: 'one', component: 'effects/wave.ts', category: 'routing/delegation', trigger: 'objective-canary', evidence: 'session-canary ```', impact: 'source-canary', proposedFix: 'resume-canary', confidence: 'observer-canary' }] } } });
  assert.equal(done.frame?.await, 'done', JSON.stringify(done.frame));
  assert.ok(requests.some((r) => r.cwd.includes('cwd-canary') && r.briefPath.includes('log-canary.spill.md') && r.attachments.some((v) => v.includes('attachment-canary'))));
  assert.ok(outcomes.some((o) => o.status === 'ok' && o.sessionId === 'session-canary'));
  const finals = fs.readdirSync(runDir, { recursive: true, encoding: 'utf8' }).filter((f) => /\.outcome\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8')) as SlotFinal);
  assert.ok(finals.some((f) => f.state === 'success' && f.resume === 'resume-canary' && f.outputPath?.includes('log-canary')));
  publishReport(ports, runDir, true, () => assert.fail('unexpected diagnostic warning'));
  const files = [path.join(session, 'diagnostics.md'), ...fs.readdirSync(path.join(runDir, 'diagnostics')).map((f) => path.join(runDir, 'diagnostics', f))];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const canary of [...canaries, 'source-canary']) assert.ok(!text.includes(canary), `${path.basename(file)} leaked ${canary}`);
    assert.ok(!text.includes(session) && !text.includes(session.replaceAll('\\', '/')));
    assert.doesNotMatch(text, /[A-Za-z]:[\\/]|\/home\/|session-canary/);
  }
  assert.match(fs.readFileSync(path.join(session, 'diagnostics.md'), 'utf8'), /12\/3|input 12, output 3/);
});
