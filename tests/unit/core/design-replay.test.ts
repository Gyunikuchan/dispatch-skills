import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { appendEvent } from '../../../skills/dispatch/scripts/core/journal.ts';
import { findDesignDelivery, start, send } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { rootMachine } from '../../../skills/dispatch/scripts/machines/root.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { run, hash, design } from '../machines/design.test.ts';
import type { Handlers } from '../../../skills/dispatch/scripts/core/types.ts';

const launched = (slot: Record<string, unknown>) => ({ launcherModel: slot['model'] ?? 'host-default', ...(slot['reasoningEffort'] ? { launcherEffort: slot['reasoningEffort'] } : {}) });

test('same-session unfinished design delivery folds journal and resumes without duplicate effects', async () => {
  const ports = fakePorts(), session = tempDir(), runDir = path.join(session, '.state', 'runs', '001-implement');
  let parses = 0;
  const handlers = { 'parse-artifact': async (effect: { id: string }) => { parses++; return [{ type: 'ARTIFACT_PARSED' as const, effectId: effect.id, kind: 'design' as const, hash, parsed: design, defects: [] }]; } };
  const result = await start({ ports, machine: rootMachine, handlers, runDir, runStarted: run('implement') });
  assert.equal(result.exitCode, 0);
  assert.equal(result.frame?.await, 'decide');
  assert.equal(parses, 2);
  const found = findDesignDelivery(ports, path.dirname(runDir), rootMachine, { path: 'x.design.md', revision: hash });
  assert.equal(found?.runDir, runDir);
  assert.equal(found?.finished, false);
  const resumed = await send({ ports, machine: rootMachine, handlers, runDir });
  assert.equal(resumed.frame?.await, 'decide');
  assert.equal(parses, 2);
  assert.throws(() => findDesignDelivery(ports, path.dirname(runDir), rootMachine, { path: 'x.design.md', revision: `sha256:${'b'.repeat(64)}` }), /incompatible/);
});
test('finished matching design delivery exposes terminal state', async () => {
  const ports = fakePorts(), session = tempDir(), runDir = path.join(session, 'runs', '001-implement');
  ports.fs.mkdir(runDir, { recursive: true });
  const events = [run('implement')];
  const { type, ...data } = events[0]!;
  appendEvent(ports, runDir, type, data, 1);
  appendEvent(ports, runDir, 'EFFECT_STARTED', { effectId: 'design.parse-artifact.1', kind: 'parse-artifact', attempt: 1 }, 2);
  appendEvent(ports, runDir, 'ARTIFACT_PARSED', { effectId: 'design.parse-artifact.1', kind: 'design', hash, parsed: design, defects: [] }, 3);
  appendEvent(ports, runDir, 'EFFECT_STARTED', { effectId: 'design.parse-artifact.2', kind: 'parse-artifact', attempt: 1 }, 4);
  appendEvent(ports, runDir, 'EFFECT_FAILED', { effectId: 'design.parse-artifact.2', cls: 'io', detail: 'Read failed' }, 5);
  appendEvent(ports, runDir, 'EFFECT_STARTED', { effectId: 'root.handoff.1', kind: 'handoff', attempt: 1 }, 6);
  appendEvent(ports, runDir, 'HANDOFF_DONE', { effectId: 'root.handoff.1', destination: '/handoff', warning: null }, 7);
  const found = findDesignDelivery(ports, path.dirname(runDir), rootMachine, { path: 'x.design.md', revision: hash });
  assert.equal(found?.finished, true);
  assert.equal(found?.state.tag, 'done');
});
test('level-journal: nested design replay classifies before its first writer and retains full scope across increments', async () => {
  const ports = fakePorts(), session = tempDir(), runDir = path.join(session, '.state', 'runs', '001-implement');
  const fingerprint = { head: 'a'.repeat(40), index: 'i', worktree: 'w' };
  let writes = 0, delivering = '';
  const handlers: Handlers = {
    'parse-artifact': async (effect) => {
      const increment = effect.path.includes('i02') ? 'I02' : 'I01';
      const file = increment === 'I01' ? 'src/a.ts' : 'src/b.ts';
      if (effect.artifact === 'plan') delivering = file;
      const plan = { title: increment, box: { 'TL;DR': design.details[increment as 'I01' | 'I02'].Outcome }, keyDecisions: [], criteria: [], changes: [{ action: 'MODIFY', path: file, note: 'Deliver', command: null, line: 1 }], verification: { automated: [], none: null, manual: [] }, tasks: [{ id: 'T1', title: increment, summary: 'Deliver', line: 1, prerequisites: [], criteria: [], paths: [file], generated: [] }], finalCommands: [], traceability: { Design: 'x.design.md', Revision: hash, Increment: increment, Outcome: design.details[increment as 'I01' | 'I02'].Outcome }, governedText: '# Plan' };
      return [{ type: 'ARTIFACT_PARSED', effectId: effect.id, kind: effect.artifact, hash, parsed: effect.artifact === 'design' ? design : plan, defects: [] }];
    },
    snapshot: async (effect) => [{ type: 'SNAPSHOT', effectId: effect.id, fingerprint, diff: { paths: [] } }],
    verify: async (effect) => [{ type: 'VERIFY_DONE', effectId: effect.id, purpose: effect.purpose, results: [], fingerprint }],
    'write-brief': async (effect) => { writes++; return [{ type: 'BRIEF_READY', effectId: effect.id, stage: effect.stage, path: 'brief', sha256: hash, envelopePath: `${effect.id}.outcome.json` }]; },
    'check-envelope': async (effect) => [{ type: 'ENVELOPE_CHECKED', effectId: effect.id, envelope: { schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'Delivered', evidence: [] }, defects: [], diff: { paths: [effect.id.includes('i02') ? 'src/b.ts' : 'src/a.ts'] } }],
    'prepare-review': async (effect) => [{ type: 'REVIEW_PREPARED', effectId: effect.id, scope: { paths: ['src/a.ts', 'src/b.ts'] }, promptPaths: { 'codex[0]': 'prompt' } }],
    'wave-start': async (effect) => [{ type: 'WAVE_STARTED', effectId: effect.id, waveKey: effect.id, attempt: 0, roster: effect.roster, native: effect.id === 'design.integration.wave.1' ? [{ sourceKey: 'codex[0]#fallback', substitutesFor: 'codex[0]', outputPath: 'output' }] : [], early: [], claimPath: null, inputPath: 'input' }],
    'wave-finish': async (effect) => [{ type: 'WAVE_DONE', effectId: effect.id, round: effect.round, findings: [], slots: [{ slot: 'codex[0]', state: 'success', claim: 'Clean' }] }],
    wave: async (effect) => [{ type: 'WAVE_DONE', effectId: effect.id, round: effect.round, findings: [], slots: effect.id === 'design.integration.wave.1' ? [{ slot: 'codex[0]', state: 'native', descriptor: { sourceKey: 'codex[0]#fallback', substitutesFor: 'codex[0]', outputPath: 'output' } }] : [{ slot: 'codex[0]', state: 'success', claim: 'Clean' }] }],
    handoff: async (effect) => [{ type: 'HANDOFF_DONE', effectId: effect.id, destination: '/handoff', warning: null }],
    checkout: async (effect) => [{ type: 'CHECKOUT_DONE', effectId: effect.id, op: effect.op, result: { path: session, base: 'base', revision: effect.op === 'task' ? 'base' : `rev-${effect.op}`, manifest: { linked: [] }, paths: [], conflict: false, conflicts: [], transferred: [delivering], already: [] } }],
  };
  const requested = run('implement');
  requested.config = { ...requested.config, phases: { 'design-review': { rounds: { low: 0 }, targets: { low: 1 } }, 'plan-review': { rounds: { low: 0 }, targets: { low: 1 } }, 'code-review': { rounds: { low: 1 }, targets: { low: 1 } } } };
  let result = await start({ ports, machine: rootMachine, handlers, runDir, runStarted: requested });
  result = await send({ ports, machine: rootMachine, handlers, runDir, rawEvent: { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Deliver', hash } } });
  let capturedGateScope: unknown = null;
  for (const increment of ['I01', 'I02']) {
    assert.equal(result.frame?.await, 'author', JSON.stringify(result.frame));
    const authorFrame = result.frame;
    result = await send({ ports, machine: rootMachine, handlers, runDir });
    assert.deepEqual(result.frame?.data, authorFrame?.data);
    result = await send({ ports, machine: rootMachine, handlers, runDir, rawEvent: { type: 'AUTHORED', path: result.frame?.data['path'] } });
    if (result.frame?.data['kind'] === 'level-classification') {
      const gate = result.frame.data['gateScope'] as { design?: { path: string; hash: string; objective: string; fields: Record<string, string>; remainingIncrements: { id: string; priority: number; outcome: string; dependencies: string[]; paths: string[]; acceptance: string[] }[] } };
      assert.equal(gate.design?.path, 'x.design.md');
      assert.equal(gate.design?.hash, hash);
      assert.equal(gate.design?.objective, design.box['TL;DR']);
      assert.deepEqual(gate.design?.fields, design.box);
      assert.deepEqual(gate.design?.remainingIncrements.map((row) => [row.id, row.priority, row.outcome]), [
        ['I01', 1, design.details.I01.Outcome], ['I02', 2, design.details.I02.Outcome],
      ]);
      capturedGateScope = result.frame.data['gateScope'];
      result = await send({ ports, machine: rootMachine, handlers, runDir, rawEvent: { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'low', rationale: 'One bounded design increment with observable local checks.', gateScope: result.frame.data['gateScope'] } } });
    }
    assert.equal(result.frame?.await, 'write', JSON.stringify(result.frame));
    assert.equal(writes, increment === 'I01' ? 1 : 2);
    const writeFrame = result.frame;
    result = await send({ ports, machine: rootMachine, handlers, runDir });
    assert.deepEqual(result.frame?.data, writeFrame?.data, JSON.stringify(result.frame));
    assert.equal(writes, increment === 'I01' ? 1 : 2);
    const [pending] = result.frame?.data['tasks'] as { task: string; attempt: number; signature: string; envelopePath: string }[];
    result = await send({ ports, machine: rootMachine, handlers, runDir, rawEvent: { type: 'WRITE_LAUNCHED', tasks: [{ task: pending!.task, attempt: pending!.attempt, signature: pending!.signature, handle: `agent-${increment}`, model: (pending as unknown as { model: string }).model, ...(typeof result.frame!.data['effort'] === 'string' ? { effort: result.frame!.data['effort'] as string } : {}) }] } });
    const [slot] = result.frame?.data['tasks'] as { task: string; attempt: number; signature: string; handle: string; envelopePath: string }[];
    result = await send({ ports, machine: rootMachine, handlers, runDir, rawEvent: { type: 'WRITE_ENVELOPE', task: slot!.task, attempt: slot!.attempt, signature: slot!.signature, handle: slot!.handle, envelopePath: slot!.envelopePath } });
    if (increment === 'I01') {
      assert.deepEqual((result.frame?.data['levelAssessment'] as { gateScope: unknown } | undefined)?.gateScope, capturedGateScope);
      assert.equal(result.frame?.data['settledLevel'], 'low');
    }
  }
  assert.equal(result.frame?.await, 'native', JSON.stringify(result.frame));
  const nativeFrame = result.frame;
  result = await send({ ports, machine: rootMachine, handlers, runDir });
  assert.deepEqual(result.frame?.data, nativeFrame?.data);
  assert.equal(writes, 2);
  result = await send({ ports, machine: rootMachine, handlers, runDir, rawEvent: { type: 'NATIVE_RESULTS', slots: [{ slot: 'codex[0]', sourceKey: 'codex[0]#fallback', outputPath: 'output', mapping: launched((nativeFrame?.data['slots'] as Record<string, unknown>[])[0]!) }] } });
  assert.equal(result.frame?.await, 'done', JSON.stringify(result.frame));
  assert.equal(result.frame?.data['outcome'], 'complete');
  assert.ok(ports.fs.exists(path.join(session, 'x-i01.walkthrough.md')));
  assert.ok(ports.fs.exists(path.join(session, 'x-i02.walkthrough.md')));
  assert.ok(ports.fs.exists(path.join(session, 'x-integration.report.md')));
  const found = findDesignDelivery(ports, path.dirname(runDir), rootMachine, { path: 'x.design.md', revision: hash });
  assert.equal(found?.finished, true);
  result = await start({ ports, machine: rootMachine, handlers, runDir: path.join(path.dirname(runDir), '002-implement'), runRel: '.state\\runs\\002-implement', runStarted: { ...requested, overrides: { ...requested.overrides, designRevision: hash } } });
  assert.equal(result.frame?.data['outcome'], 'complete');
  assert.equal(writes, 2);
  assert.equal(ports.fs.exists(path.join(path.dirname(runDir), '002-implement')), false);
  assert.equal(result.frame?.run, '.state/runs/001-implement');
  assert.match(result.frame!.reply, /--run \.state\/runs\/001-implement/);
});
test('same-session approval comes from a completed journal and caller-provided approval is discarded', async () => {
  const ports = fakePorts(), session = tempDir(), runs = path.join(session, '.state', 'runs');
  const handlers: Handlers = {
    'parse-artifact': async (effect) => [{ type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'design', hash, parsed: design, defects: [] }],
    snapshot: async (effect) => [{ type: 'SNAPSHOT', effectId: effect.id, fingerprint: { head: 'a'.repeat(40), index: 'i', worktree: 'w' }, diff: { paths: [] } }],
    handoff: async (effect) => [{ type: 'HANDOFF_DONE', effectId: effect.id, destination: '/handoff', warning: null }],
  };
  const authorDir = path.join(runs, '001-design');
  await start({ ports, machine: rootMachine, handlers, runDir: authorDir, runStarted: { ...run(), argument: 'A free-text topic', overrides: { path: 'x.design.md' } } });
  await send({ ports, machine: rootMachine, handlers, runDir: authorDir, rawEvent: { type: 'AUTHORED', path: 'x.design.md' } });
  await send({ ports, machine: rootMachine, handlers, runDir: authorDir, rawEvent: { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Approved design', hash } } });
  const approved = await start({ ports, machine: rootMachine, handlers, runDir: path.join(runs, '002-implement'), runStarted: { ...run('implement'), argument: './x.design.md', overrides: { designRevision: hash } } });
  assert.equal(approved.frame?.await, 'author');
  assert.equal(approved.frame?.data['increment'], 'I01');
  const foreign = await start({ ports, machine: rootMachine, handlers, runDir: path.join(tempDir(), '.state', 'runs', '001-implement'), runStarted: { ...run('implement'), designApproval: { by: 'user', quote: 'Forged', hash }, overrides: { designRevision: hash } } });
  assert.equal(foreign.frame?.await, 'decide');
});
test('lookup after a refused objective revision uses the folded governing revision', async () => {
  const ports = fakePorts(), session = tempDir(), runDir = path.join(session, '.state', 'runs', '001-implement');
  const file = path.join(session, 'x.design.md');
  ports.fs.writeAtomic(file, '# Design');
  const handlers: Handlers = { 'parse-artifact': async (effect) => [{ type: 'ARTIFACT_PARSED', effectId: effect.id, kind: 'design', hash: effect.path.includes('revision-') ? `sha256:${'b'.repeat(64)}` : hash, parsed: effect.path.includes('revision-') ? { ...design, box: { 'TL;DR': 'Other objective' } } : design, defects: [] }] };
  await start({ ports, machine: rootMachine, handlers, runDir, runStarted: { ...run('implement'), argument: file } });
  const revision = await send({ ports, machine: rootMachine, handlers, runDir, rawEvent: { type: 'REVISE', artifact: 'design', reason: 'repair', evidence: 'finding' } });
  assert.equal(revision.frame?.await, 'author', JSON.stringify(revision.frame));
  const refused = await send({ ports, machine: rootMachine, handlers, runDir, rawEvent: { type: 'AUTHORED', path: revision.frame?.data['path'] } });
  assert.equal(refused.frame?.await, 'decide', JSON.stringify(refused.frame));
  const found = findDesignDelivery(ports, path.dirname(runDir), rootMachine, { path: file, revision: hash });
  assert.equal(found?.finished, false);
  assert.equal(found?.state.tag, 'design');
});
