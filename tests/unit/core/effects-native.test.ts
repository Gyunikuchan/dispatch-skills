import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Effect, Handler } from '../../../skills/dispatch/scripts/core/types.ts';
import { createHandlers } from '../../../skills/dispatch/scripts/effects/index.ts';
import { createGit } from '../../../skills/dispatch/scripts/effects/git.ts';
import { createWaveHandler } from '../../../skills/dispatch/scripts/effects/wave.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';

const FINDING = JSON.stringify({ status: 'FINDINGS', findings: [{ severity: 'MUST', locus: 'src/a.ts:L3', tag: 'correctness', defect: 'null deref', requiredChange: 'guard it' }] });
const neverCli: Handler<Extract<Effect, { kind: 'wave' }>> = async () => { throw new Error('the CLI wave must not run for an all-native roster'); };
const handlers = createHandlers({
  skillRoot: '/skill', cwd: '/repo', os: 'linux', git: createGit({ run: async () => '' }), tempRoot: '/tmp', workspaceRoot: '/ws', orchestratorPlatform: 'claude', wave: neverCli,
});

test('an all-native wave roster reconciles captures through the report parse path', async () => {
  const dir = tempDir();
  const good = path.join(dir, 'good.md');
  const bad = path.join(dir, 'bad.md');
  fs.writeFileSync(good, FINDING);
  fs.writeFileSync(bad, '');
  const row = (slot: string, outputPath: string) => ({ slot, provider: 'native', index: 0, native: true, reserve: false, review: 'code', capture: { slot, sourceKey: `${slot}#fallback`, outputPath } });
  const events = await handlers.wave?.({ kind: 'wave', id: 'review.wave.2', round: 1, roster: [row('claude[0]', good), row('claude[1]', bad)], timeoutMs: 1 }, fakePorts(), { runDir: dir, attempt: 1 }) ?? [];
  assert.equal(events.filter((event) => event.type === 'WAVE_DONE').length, 1);
  const done = events.at(-1);
  assert.ok(done?.type === 'WAVE_DONE');
  assert.deepEqual(done.slots.map((slot) => [slot['slot'], slot['state'], slot['sourceKey'] ?? slot['cls']]), [['claude[0]', 'native', 'claude[0]#fallback'], ['claude[1]', 'failed', 'empty-output']]);
  assert.deepEqual(done.findings.map((finding) => [finding['id'], finding['locus'], finding['sources']]), [['R1-F001', 'src/a.ts:L3', ['claude[0]']]]);
});

test('wave 1 marks a nativeSubagentsOnly slot state native with its descriptor for the host', async () => {
  const boom = () => { throw new Error('no worker for a native-only roster'); };
  const marking = createHandlers({
    skillRoot: '/skill', cwd: '/repo', os: 'linux', git: createGit({ run: async () => '' }), tempRoot: '/tmp', workspaceRoot: '/ws', orchestratorPlatform: 'claude',
    wave: { fs: { writeTemp: boom, link: boom, writeAtomic: boom, readText: () => null, list: () => [], remove: boom }, proc: { host: 'h', isAlive: () => true }, clock: { now: () => 0 }, launchWorker: boom, awaitWorker: boom },
  });
  const roster = [{ slot: 'claude[0]', provider: 'claude', index: 0, native: true, reserve: false, model: 'opus', review: 'code', promptPath: '/run/w.1.claude-0.prompt.md' }];
  const events = await marking.wave?.({ kind: 'wave', id: 'review.wave.1', round: 1, roster, timeoutMs: 1 }, fakePorts(), { runDir: '/run', attempt: 1 }) ?? [];
  const done = events.at(-1);
  assert.ok(done?.type === 'WAVE_DONE');
  const descriptor = done.slots[0]?.['descriptor'] as Record<string, unknown>;
  assert.deepEqual([done.slots[0]?.['state'], descriptor['sourceKey'], descriptor['substitutesFor'], descriptor['model'], descriptor['promptPath']],
    ['native', 'claude[0]', null, 'opus', '/run/w.1.claude-0.prompt.md']);
});

test('an ask native capture becomes one sanitized claim', async () => {
  const dir = tempDir();
  const out = path.join(dir, 'ask.md');
  fs.writeFileSync(out, 'The lock is released in finally.');
  const roster = [{ slot: 'claude[0]', provider: 'native', index: 0, native: true, reserve: false, review: 'ask', capture: { slot: 'claude[0]', outputPath: out } }];
  const events = await handlers.wave?.({ kind: 'wave', id: 'ask.wave.2', round: 1, roster, timeoutMs: 1 }, fakePorts(), { runDir: dir, attempt: 1 }) ?? [];
  const done = events.at(-1);
  assert.deepEqual(done?.type === 'WAVE_DONE' && done.slots.map((slot) => slot['claim']), ['The lock is released in finally.']);
});

test('a native capture read failure is one EFFECT_FAILED io', async () => {
  const ports = fakePorts();
  ports.fs = { ...ports.fs, exists: () => true, readText: () => { throw new Error('EACCES'); } };
  const capture = { slot: 'claude[0]', sourceKey: 'claude[0]#fallback', outputPath: '/x.md' };
  const events = await handlers.wave?.({ kind: 'wave', id: 'review.wave.2', round: 1, roster: [{ slot: 'claude[0]', native: true, review: 'code', capture }], timeoutMs: 1 }, ports, { runDir: tempDir(), attempt: 1 }) ?? [];
  assert.equal(events.length, 1);
  assert.ok(events[0]?.type === 'EFFECT_FAILED' && events[0].cls === 'io' && /EACCES/.test(events[0].detail));
});

test('a wave worker launch failure is one EFFECT_FAILED io', async () => {
  const deps = {
    fs: { readText: () => null, writeAtomic: () => { throw new Error('EROFS'); }, writeTemp: () => '', link: () => {}, list: () => [], remove: () => {} },
    proc: { host: 'h', isAlive: () => true }, clock: { now: () => 1000 },
    context: () => ({ review: 'code' as const, orchestratorPlatform: null, cwd: '/repo', paths: {} }),
    launchWorker: () => {}, awaitWorker: async () => {},
  };
  const roster = [{ slot: 'codex[0]', provider: 'codex', index: 0, native: false, reserve: false }];
  const events = await createWaveHandler(deps as never)({ kind: 'wave', id: 'review.wave.1', round: 1, roster, timeoutMs: 1 }, fakePorts(), { runDir: '/run', attempt: 1 });
  assert.equal(events.length, 1);
  assert.ok(events[0]?.type === 'EFFECT_FAILED' && events[0].cls === 'io' && /EROFS/.test(events[0].detail));
});
