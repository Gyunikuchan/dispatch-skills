import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { appendEvent } from '../../../skills/dispatch/scripts/core/journal.ts';
import { findDesignDelivery, start, send } from '../../../skills/dispatch/scripts/core/interpreter.ts';
import { rootMachine } from '../../../skills/dispatch/scripts/machines/root.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { run, hash, design } from '../machines/design.test.ts';
import type { Handlers } from '../../../skills/dispatch/scripts/core/types.ts';

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
test('real nested two-increment delivery replays author, write and native integration awaits without duplicate writes', async () => {
  const ports = fakePorts(), session = tempDir(), runDir = path.join(session, '.state', 'runs', '001-implement');
  const fingerprint = { head: 'a'.repeat(40), index: 'i', worktree: 'w' };
  let writes = 0;
  const handlers: Handlers = {
    'parse-artifact': async (effect) => {
      const increment = effect.path.includes('i02') ? 'I02' : 'I01';
      const file = increment === 'I01' ? 'src/a.ts' : 'src/b.ts';
      const plan = { title: increment, box: { 'TL;DR': design.details[increment as 'I01' | 'I02'].Outcome }, keyDecisions: [], criteria: [], changes: [{ action: 'MODIFY', path: file, note: 'Deliver', command: null, line: 1 }], verification: { automated: [], none: null, manual: [] }, tasks: [], finalCommands: [], traceability: { Design: 'x.design.md', Revision: hash, Increment: increment, Outcome: design.details[increment as 'I01' | 'I02'].Outcome }, governedText: '# Plan' };
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
  };
  const requested = run('implement');
  requested.config = { ...requested.config, phases: { 'design-review': { rounds: { low: 0 }, targets: { low: 1 } }, 'plan-review': { rounds: { low: 0 }, targets: { low: 1 } }, 'code-review': { rounds: { low: 1 }, targets: { low: 1 } } } };
  let result = await start({ ports, machine: rootMachine, handlers, runDir, runStarted: requested });
  result = await send({ ports, machine: rootMachine, handlers, runDir, rawEvent: { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Deliver', hash } } });
  for (const increment of ['I01', 'I02']) {
    assert.equal(result.frame?.await, 'author', JSON.stringify(result.frame));
    const authorFrame = result.frame;
    result = await send({ ports, machine: rootMachine, handlers, runDir });
    assert.deepEqual(result.frame?.data, authorFrame?.data);
    result = await send({ ports, machine: rootMachine, handlers, runDir, rawEvent: { type: 'AUTHORED', path: result.frame?.data['path'] } });
    assert.equal(result.frame?.await, 'write', JSON.stringify(result.frame));
    assert.equal(writes, increment === 'I01' ? 1 : 2);
    const writeFrame = result.frame;
    result = await send({ ports, machine: rootMachine, handlers, runDir });
    assert.deepEqual(result.frame?.data, writeFrame?.data, JSON.stringify(result.frame));
    assert.equal(writes, increment === 'I01' ? 1 : 2);
    const writeData = result.frame?.data;
    result = await send({ ports, machine: rootMachine, handlers, runDir, rawEvent: { type: 'WRITE_ENVELOPE', envelopePath: writeData?.['envelopePath'] } });
  }
  assert.equal(result.frame?.await, 'native', JSON.stringify(result.frame));
  const nativeFrame = result.frame;
  result = await send({ ports, machine: rootMachine, handlers, runDir });
  assert.deepEqual(result.frame?.data, nativeFrame?.data);
  assert.equal(writes, 2);
  result = await send({ ports, machine: rootMachine, handlers, runDir, rawEvent: { type: 'NATIVE_RESULTS', slots: [{ slot: 'codex[0]', sourceKey: 'codex[0]#fallback', outputPath: 'output' }] } });
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
