/**
 * `--run ask`: the driver's own ask flow. Resolves level-configured read delegates as one wave,
 * launches it, cascades a per-model native fallback on any failed slot (the same driver-owned
 * cascade `review-phase.mjs` runs for reads), and finishes with the collected claims.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadDispatchConfig, resolveReadDelegates } from '../config.mjs';
import { resolveConfiguredTargets } from '../dispatch.mjs';
import { createTempFile } from '../review-preparation.mjs';
import { emitAction, sanitizeReplyText } from './actions.mjs';
import { createRunState, writeRunSidecar, writeRunState } from './state.mjs';

const DISPATCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DISPATCH_SCRIPT = path.join(DISPATCH_DIR, 'scripts', 'dispatch.mjs');

const NATIVE_AGENT_TYPES = Object.freeze({ claude: 'explore', agy: 'research', copilot: 'explore', opencode: 'explore' });

function gitRoot(cwd) {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return res.status === 0 && res.stdout.trim() ? path.resolve(res.stdout.trim()) : path.resolve(cwd);
}

function runFile(state, name, contents = '') {
  const file = path.join(path.dirname(state.stateFile), `${state.runId}-${name}`);
  fs.writeFileSync(file, contents, { mode: 0o600 });
  state.cleanup.push(file);
  return file;
}

function finish(state, action) {
  state.pending = action;
  writeRunState(state);
  return action;
}

/** Starts `--run ask`; returns the first (`launch`) action. */
export async function startAsk({ invocation, cwd, resumeCommand }) {
  const repoRoot = gitRoot(cwd);
  const { config } = loadDispatchConfig({ skillRoot: DISPATCH_DIR });
  const resolved = resolveReadDelegates(config, invocation.level);
  const orderedTargets = resolveConfiguredTargets(resolved, invocation.orchestrator, invocation.orchestratorModel);
  const state = createRunState({
    invocation, repoRoot, resumeCommand, cleanup: [], pending: null,
    modelsByCandidate: Object.fromEntries(orderedTargets.map((target) => [
      `${target.platform}:${target.candidateIndex}`,
      { models: Array.isArray(target.model) ? target.model : [target.model].filter(Boolean), effort: target.effort ?? null },
    ])),
  });
  writeRunSidecar(state, invocation);
  if (orderedTargets.length === 0) {
    return finish(state, emitAction(state, 'done', {
      outcome: 'failed', summary: 'No read delegate is configured for ask.', command: resumeCommand,
    }, ['Report the summary to the user; the run is finished.']));
  }
  const roundId = 'ask:R1';
  const targets = orderedTargets.map((target) => ({
    roundId, candidateId: `ask:${target.platform}:${target.candidateIndex}`,
    platform: target.platform, candidateIndex: target.candidateIndex,
  }));
  const promptFile = createTempFile('dispatch-ask-prompt-', 'prompt.md', `${invocation.argument}\n`);
  const batchFile = createTempFile('dispatch-ask-batch-', 'batch.json', `${JSON.stringify({ targets, reserves: [] }, null, 2)}\n`);
  const outputFile = createTempFile('dispatch-ask-output-', 'output.txt', '');
  state.cleanup.push(promptFile.cleanupPath, batchFile.cleanupPath, outputFile.cleanupPath);
  const argv = [
    process.execPath, DISPATCH_SCRIPT,
    '--batch-file', batchFile.path,
    '--prompt-file', promptFile.path,
    '--level', invocation.level,
    '--orchestrator', invocation.orchestrator,
    ...(invocation.orchestratorModel ? ['--orchestrator-model', invocation.orchestratorModel] : []),
    '--output-file', outputFile.path,
  ];
  state.wave = { argv, outputPath: outputFile.path, promptPath: promptFile.path };
  return finish(state, launchAction(state));
}

function launchAction(state, error) {
  return emitAction(state, 'launch', {
    argv: state.wave.argv,
    wave: { type: 'review', round: 1 },
    ...(error ? { error } : {}),
  }, ['Run argv as one background command, wait for it to exit, then call --next with no --input.']);
}

/** Advances an in-flight ask run with a validated reply; returns the next action. */
export function advanceAsk(state, reply) {
  const handler = HANDLERS[state.pending.action];
  return finish(state, handler(state, reply));
}

function onLaunch(state) {
  let envelope = null;
  try {
    const text = fs.readFileSync(state.wave.outputPath, 'utf8');
    envelope = text.trim() ? JSON.parse(text) : null;
  } catch {
    envelope = null;
  }
  if (!envelope || !Array.isArray(envelope.targets)) {
    return emitAction(state, 'done', { outcome: 'failed', summary: 'The ask wave envelope is missing.', command: state.resumeCommand },
      ['Report the summary to the user; the run is finished.']);
  }
  // Native fallback runs only on the orchestrator's own platform; other platforms' failures are final.
  const failures = envelope.failures ?? [];
  const native = failures.filter((failure) => failure.platform === state.invocation.orchestrator);
  state.collect = {
    claims: envelope.targets.filter((record) => record.report).map((record) => ({ sourceKey: record.sourceKey, text: record.report })),
    failed: failures.filter((failure) => !native.includes(failure)).map((failure) => ({ sourceKey: failure.sourceKey, kind: failure.failureKind ?? 'cross-platform' })),
    queue: native.map((failure) => {
      const key = `${failure.platform}:${failure.candidateIndex}`;
      const resolved = state.modelsByCandidate[key] ?? { models: [], effort: null };
      return { sourceKey: failure.sourceKey, platform: failure.platform, candidateIndex: failure.candidateIndex, models: resolved.models, effort: resolved.effort, cascadePosition: 0 };
    }),
  };
  return processCollected(state);
}

function processCollected(state) {
  if (state.collect.queue.length === 0) {
    return emitAction(state, 'done', {
      outcome: state.collect.claims.length > 0 ? 'complete' : 'failed',
      summary: state.collect.claims.length > 0 ? 'Ask completed.' : 'No delegate answered the ask.',
      claims: state.collect.claims,
      failed: state.collect.failed,
    }, ['Report the summary and claims to the user; the run is finished.']);
  }
  return nativeFallbackAction(state);
}

function nativeFallbackAction(state) {
  const slot = state.collect.queue[0];
  if (!slot.models[slot.cascadePosition] || !slot.effort) {
    state.collect.queue.shift();
    state.collect.failed.push({ sourceKey: slot.sourceKey, kind: 'unresolved-model' });
    return processCollected(state);
  }
  const outputPath = runFile(state, `ask-fallback-${state.collect.failed.length + state.collect.claims.length + 1}.txt`);
  const descriptor = {
    sourceKey: slot.sourceKey,
    agentType: NATIVE_AGENT_TYPES[slot.platform] ?? 'explore',
    model: slot.models[slot.cascadePosition],
    reasoningEffort: slot.effort,
    substitutesFor: null,
    cascadePosition: slot.cascadePosition,
    modelCascade: slot.models,
  };
  state.collect.current = { ...slot, outputPath, descriptor };
  return emitAction(state, 'native-fallback', { slot: slot.sourceKey, promptPath: state.wave.promptPath, outputPath, descriptor }, [
    'Launch the named read-only native agent using descriptor.agentType, descriptor.model, and descriptor.reasoningEffort exactly; never use launcher defaults.',
    'Tell the native agent: Read promptPath in full and answer it directly.',
    'Write its final reply verbatim to outputPath, then report the actual launch metadata with the captured reply, or a {kind, reason} failure.',
  ]);
}

function onNativeFallback(state, reply) {
  const current = state.collect.current;
  if (reply.slot !== current.sourceKey) return { ...state.pending, error: `slot must be ${current.sourceKey}.` };
  if (reply.failed) {
    const nextPosition = current.cascadePosition + 1;
    state.collect.queue[0] = { ...current, cascadePosition: nextPosition };
    if (nextPosition >= current.models.length) {
      state.collect.queue.shift();
      state.collect.failed.push({ sourceKey: current.sourceKey, kind: reply.failed.kind });
    }
    return processCollected(state);
  }
  const expected = current.descriptor;
  const actual = reply.actual;
  if (!actual || actual.agentType !== expected.agentType || actual.model !== expected.model || actual.reasoningEffort !== expected.reasoningEffort) {
    return { ...state.pending, error: `Native fallback launch metadata must match the descriptor exactly; expected ${JSON.stringify({ agentType: expected.agentType, model: expected.model, reasoningEffort: expected.reasoningEffort })}.` };
  }
  state.collect.queue.shift();
  const text = fs.existsSync(current.outputPath) ? fs.readFileSync(current.outputPath, 'utf8') : '';
  state.collect.claims.push({ sourceKey: current.sourceKey, text: sanitizeReplyText(text) });
  return processCollected(state);
}

const HANDLERS = {
  launch: onLaunch,
  'native-fallback': onNativeFallback,
};
