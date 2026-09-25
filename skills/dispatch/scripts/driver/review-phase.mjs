// @ts-check
/**
 * Standalone review phase (`--run review`): a state machine over the closed action set. It reuses
 * the review modules in-process (preparation, parsing, source maps, rebuttal packets, consensus,
 * clustering, checkpoint); the agent only verifies, rules, edits under `--fix`, and asks the user.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRebuttalPackets } from '../review/rebuttal-packets.mjs';
import { evaluateConsensus } from '../review/consensus.mjs';
import { loadDispatchConfig, policyPhase } from '../lib/config.mjs';
import { inferReviewKind, resolveReviewLevel } from './review-policy.mjs';
import { createIndependenceClusters, formatOptInSections, parseOptInResponse } from '../review/fix-clustering.mjs';
import { parseRebuttal, parseReport } from '../review/parse-report.mjs';
import { prepareReview } from '../review/prepare.mjs';
import { getCurrentBranch, resolveArtifacts, resolveSlug } from '../artifacts/resolve-paths.mjs';
import { formatApplicationRecord, formatSourceMapLine, nextFindingId, scanResolutionLog, validateSourceMap } from '../review/resolution-log.mjs';
import { defaultLiveness, probeCandidates, resolveFlow } from '../lib/resolve-flow.mjs';
import { InvalidReviewReportError, normalizeLocus } from '../review/report.mjs';
import { reviewKind } from '../review/kinds.mjs';
import { integrityDiagnostic, regenerateOwnedHashes, skillDirInRepo } from '../lib/integrity.mjs';
import { NATIVE_AGENT_TYPES, emitAction } from './actions.mjs';
import {
  FOLLOW_UPS,
  LOG_HEADING,
  REPO_RELATIVE,
  appendToSection,
  cleanText,
  readArtifactText,
  setEntryStatus,
  writeArtifactText,
} from './review-artifact.mjs';
import {
  PENDING_FIX_REASON,
  REEMITTED,
  createRunState,
  finish,
  gitRoot,
  reemit,
  pruneFinishedStates,
  rebuildFromArtifact,
  runFile,
  unappliedFixesFromArtifact,
  writeRunSidecar,
} from './state.mjs';

const DISPATCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const today = () => new Date().toISOString().slice(0, 10);
const toSlash = (value) => value.split(path.sep).join('/');

// SECTION: Phase entry

/**
 * Starts `--run review`; returns the first action.
 *
 * @param {{ invocation: Record<string, any>, cwd: string, resumeCommand: string, dispatchScript?: string }} options
 */
export async function startReview({ invocation, cwd, resumeCommand }) {
  const repoRoot = gitRoot(cwd);
  /** @type {Record<string, any>} */
  const inferred = invocation.kind
    ? { kind: invocation.kind, ...(invocation.argument ? kindTarget(invocation.kind, invocation.argument) : {}) }
    : inferReviewKind(invocation.argument, { cwd });
  const kind = inferred.kind;
  const { config } = loadDispatchConfig({ skillRoot: DISPATCH_DIR });
  const levelInfo = resolveReviewLevel({ config, kind, level: invocation.level, levelSource: invocation.levelSource });
  /** @type {Record<string, any>} */
  const normalized = { ...invocation, kind };
  const state = createRunState({
    invocation: normalized,
    resumeCommand,
    repoRoot,
    kind,
    phase: levelInfo.phase,
    level: levelInfo.level,
    target: {
      artifactPath: inferred.artifactPath ? path.resolve(cwd, inferred.artifactPath) : null,
      walkthroughPath: inferred.walkthroughPath ? path.resolve(cwd, inferred.walkthroughPath) : null,
      range: inferred.range ?? null,
    },
    artifactPath: inferred.artifactPath ? path.resolve(cwd, inferred.artifactPath) : (inferred.walkthroughPath ? path.resolve(cwd, inferred.walkthroughPath) : null),
    cleanup: [],
    invocationContext: null,
    reviewWaves: 0,
    rebuttalAt: null,
    capAsked: false,
    finalDone: false,
    changed: false,
    optInOffered: false,
    driftRestarted: false,
    authorAttempts: 0,
    inputs: null,
    fix: { pending: [], active: [], attempts: {} },
    adjacent: [],
    pending: null,
  });
  pruneFinishedStates();
  writeRunSidecar(state, normalized);
  if (levelInfo.skipped) {
    return finish(state, done(state, 'skipped', `Review skipped: ${levelInfo.skipped.reason}`, { reason: levelInfo.skipped.reason }));
  }
  state.policy = await resolvePolicy(config, levelInfo, normalized);
  state.roundLimit = state.policy.rounds;
  state.artifactPath ??= existingWalkthrough(state);
  const unapplied = normalized.fix ? unappliedFixesFromArtifact(state.artifactPath) : null;
  if (unapplied) {
    // Fixes queued in the log before the cache was lost: apply them (and re-offer the opt-in) before any new wave.
    state.reviewWaves = unapplied.rounds;
    state.fix.pending = unapplied.pending;
    state.adjacent = unapplied.adjacent;
    return finish(state, nextStep(state));
  }
  const rebuilt = rebuildFromArtifact(state.artifactPath);
  if (rebuilt) {
    // Resume from the unsettled log: the state cache is only a cache.
    state.reviewWaves = rebuilt.rounds;
    return finish(state, nextStep(state));
  }
  return finish(state, prepareWave(state, 'review'));
}

/** A code review's existing walkthrough, resolved as preparation would, so a lost cache can resume from its log. */
function existingWalkthrough(state) {
  // Range reviews resolve the same branch walkthrough in preparation, so they resume from it too.
  if (state.kind !== 'code') return null;
  try {
    const { slug, slugSource } = resolveSlug({ branch: getCurrentBranch(state.repoRoot), orchestrator: state.invocation.orchestrator });
    if (!slug) return null;
    const { walkthrough } = resolveArtifacts({
      slug, slugSource, kinds: ['walkthrough'], projectRoot: state.repoRoot,
      native: { orchestrator: state.invocation.orchestrator },
    });
    return walkthrough.exists ? path.resolve(state.repoRoot, walkthrough.path) : null;
  } catch {
    // NOTE: an unresolvable slug only means there is nothing to resume; preparation reports it.
    return null;
  }
}

function kindTarget(kind, argument) {
  if (kind === 'code') {
    return /-walkthrough\.md$/i.test(argument) ? { walkthroughPath: argument } : { range: argument };
  }
  return { artifactPath: argument };
}

/** Advances a run with a validated reply; returns the next action. */
export function advanceReview(state, reply) {
  const handler = HANDLERS[state.pending.action];
  const action = handler(state, reply);
  return finish(state, action);
}

function recordReviewFailure(state, sourceKey, kind) {
  state.reviewFailed ??= [];
  if (!state.reviewFailed.some((item) => item.sourceKey === sourceKey)) state.reviewFailed.push({ sourceKey, kind });
}

function done(state, outcome, summary, extra = {}) {
  return emitAction(state, 'done', {
    outcome,
    summary,
    ...(state.artifactPath ? { artifactPath: toSlash(path.relative(state.repoRoot, state.artifactPath)) } : {}),
    ...(state.reviewFailed?.length ? { failed: state.reviewFailed } : {}),
    ...extra,
  }, ['Report the summary to the user; the run is finished.']);
}

async function resolvePolicy(config, levelInfo, invocation) {
  const phase = levelInfo.phase;
  // An unconfigured phase falls back to one target through resolveFlow's own ordering (orchestrator
  // demotion and liveness filter included), one round, host-final rulings.
  const policyKey = policyPhase(phase);
  const effective = levelInfo.configured
    ? config
    : { ...config, phases: { ...(config.phases ?? {}), [policyKey]: { rounds: { low: 1 }, targets: { low: 1 }, consensus: { low: false } } } };
  const pins = invocation.pins ? invocation.pins.split(',').map((pin) => pin.trim()).filter(Boolean) : undefined;
  const options = {
    platform: invocation.orchestrator,
    level: levelInfo.level,
    pins,
    orchestratorModel: invocation.orchestratorModel,
    tolerateMissingImplementationModel: true,
  };
  const { liveness, source } = await defaultLiveness(probeCandidates(options, effective));
  const flow = resolveFlow({ ...options, livenessSource: source }, liveness, effective)[phase];
  const entry = (target) => {
    const index = Number(target.candidateId.split(':').at(-1));
    return {
      candidateId: target.candidateId,
      platform: target.platform,
      candidateIndex: index,
      ...(target.model ? { model: target.model } : {}),
      ...(target.effort ? { effort: target.effort } : {}),
    };
  };
  return {
    configured: levelInfo.configured,
    rounds: flow.rounds,
    consensus: levelInfo.configured ? Boolean(flow.consensus) : false,
    targets: flow.targets.map(entry),
    reserves: flow.reserves.map(entry),
  };
}

// SECTION: preparation and waves

function prepareRequest(state, { reviewMode = 'full', targets, reserves = [], packetPath = null, keys = [] }) {
  const dispatchEntry = ({ candidateId, platform, candidateIndex }) => ({ candidateId, platform, candidateIndex });
  const request = {
    mode: 'orchestrated',
    orchestrator: state.invocation.orchestrator,
    targets: targets.map(dispatchEntry),
    reserves: reserves.map(dispatchEntry),
  };
  if (state.invocation.orchestratorModel) request.orchestratorModel = state.invocation.orchestratorModel;
  if (state.invocationContext) request.invocationContext = state.invocationContext;
  if (reviewMode === 'rebuttal') Object.assign(request, { reviewMode, findingPacketPath: packetPath, findingKeys: keys });
  if (state.kind === 'code') {
    if (state.target.walkthroughPath) request.walkthroughPath = state.target.walkthroughPath;
    if (state.target.range) request.range = state.target.range;
    if (state.inputs) Object.assign(request, state.inputs);
  } else {
    request.artifactPath = state.artifactPath ?? state.target.artifactPath;
  }
  return request;
}

function prepareWave(state, type, rebuttal = null) {
  if (state.policy.targets.length === 0) {
    return done(state, 'failed', 'No live read delegate is available for this review.', { command: state.resumeCommand });
  }
  let manifest;
  try {
    manifest = prepareReview(state.kind, prepareRequest(state, rebuttal ?? {
      targets: state.policy.targets,
      reserves: state.policy.reserves,
    }), { repoRoot: state.repoRoot });
  } catch (err) {
    return done(state, 'failed', `Review preparation failed: ${err.message}`, { command: state.resumeCommand });
  }
  if (manifest.status === 'authoring-required') {
    const producer = state.kind === 'design' ? 'design' : 'plan';
    return done(state, 'refused', `No ${state.kind} artifact at ${manifest.artifact.canonicalPath}; the ${producer} phase produces it (run the ${producer} verb first). Standalone review never authors it.`);
  }
  if (manifest.status === 'no-reviewable-changes') {
    return done(state, 'no-reviewable-changes', manifest.message);
  }
  if (manifest.status === 'decision-required' && manifest.decision === 'walkthrough-inputs') {
    return emitAction(state, 'ask-user', {
      question: 'inputs',
      text: 'No walkthrough exists for these changes. Provide a one-line summary and the verification command you ran with its result.',
      missing: manifest.missing,
    }, ['Answer with {"answer": {"summary": "...", "verification": {"command": "...", "result": "..."}}}.']);
  }
  if (manifest.status === 'decision-required') {
    const artifactPath = path.resolve(state.repoRoot, manifest.artifact.canonicalPath);
    state.artifactPath = artifactPath;
    if (state.invocation.fix && state.authorAttempts < 2) {
      state.authorAttempts += 1;
      return emitAction(state, 'author', {
        path: manifest.artifact.canonicalPath,
        template: `references/templates/${state.kind}.md`,
        defects: manifest.defects,
      }, ['Repair the listed lint defects in place using the named template; reply with {"path": "<artifact path>"}.']);
    }
    return done(state, 'lint-defects', `${state.kind} lint failed; the review did not run.`, { defects: manifest.defects });
  }
  state.cleanup.push(...(manifest.cleanupPaths ?? []), manifest.invocationCleanupPath);
  state.invocationContext = manifest.invocationContext;
  state.artifactPath = path.resolve(state.repoRoot, manifest.artifact.canonicalPath);
  const round = Number(manifest.roundId.split(':R')[1]);
  if (type === 'review') state.reviewWaves += 1;
  if (type === 'final') state.finalDone = true;
  const earlyFallbacks = state.policy.targets
    .filter((target) => target.platform === state.invocation.orchestrator && target.model && target.effort)
    .map((target, index) => {
      const sourceKey = `${manifest.roundId}:${target.platform}:${target.candidateIndex}`;
      const modelCascade = Array.isArray(target.model) ? target.model : [target.model];
      return {
        slot: sourceKey,
        promptPath: manifest.promptPath,
        outputPath: runFile(state, `early-fallback-${index + 1}.txt`),
        descriptor: {
          sourceKey,
          agentType: NATIVE_AGENT_TYPES[target.platform] ?? 'explore',
          model: modelCascade[0],
          reasoningEffort: target.effort,
          substitutesFor: null,
          cascadePosition: 0,
          modelCascade,
        },
      };
    });
  const slotsPath = runFile(state, 'slots.jsonl');
  state.wave = {
    type,
    round,
    argv: [...manifest.dispatch.argv, '--level', state.level, '--slots-file', slotsPath],
    outputPath: manifest.dispatch.outputPath,
    promptPath: manifest.promptPath,
    slotsPath,
    earlyFallbacks,
    retried: false,
    keys: rebuttal?.keys ?? null,
  };
  return launchAction(state);
}

function launchReplyAction(state, error) {
  const action = {
    ...state.pending,
    replyOnly: true,
    error,
    guidance: ['The wave is complete; do not rerun argv. Correct only the earlyFallbacks reply and call --next again.'],
  };
  REEMITTED.add(action);
  return action;
}

function launchAction(state, error) {
  const guidance = state.wave.earlyFallbacks.length > 0
    ? [
      'Run argv as one background command. Once, run `node dispatch.mjs --slots <slotsPath>` after launch and inspect the failed slots it prints; do not poll again.',
      'For every failed slot matching earlyFallbacks, immediately launch its native fallback in one parallel tool-call round while the wave continues.',
      'Return only successful non-empty captures with exact descriptor metadata. Omit an unproductive launch so ordinary post-wave fallback can retry it.',
      'After the wave and launched fallbacks finish, call --next once with {"earlyFallbacks":[...]} (empty when none succeeded).',
    ]
    : ['Run argv as one background command, wait for it to exit, then call --next with no --input.'];
  if (state.wave.type === 'rebuttal') {
    guidance.push('Delegates answer each key: CONFIRM accepts the rejection, REBUT keeps the finding live, INTENT-DISPUTE records a dispute.');
  }
  return emitAction(state, 'launch', {
    argv: state.wave.argv,
    wave: { type: state.wave.type, round: state.wave.round },
    ...(state.wave.slotsPath ? { slotsPath: state.wave.slotsPath } : {}),
    ...(state.wave.keys ? { keys: state.wave.keys } : {}),
    ...(state.wave.earlyFallbacks.length > 0 ? { earlyFallbacks: state.wave.earlyFallbacks } : {}),
    ...(error ? { error } : {}),
  }, guidance);
}

function onLaunch(state, reply) {
  let envelope = null;
  try {
    const text = fs.readFileSync(state.wave.outputPath, 'utf8');
    envelope = text.trim() ? JSON.parse(text) : null;
  } catch {
    envelope = null;
  }
  if (!envelope || !Array.isArray(envelope.targets)) {
    // A relaunch would fail the same integrity check, so report the remedy instead.
    const integrity = integrityDiagnostic(DISPATCH_DIR);
    if (integrity) return done(state, 'failed', integrity, { command: state.resumeCommand });
    if (!state.wave.retried) {
      state.wave.retried = true;
      return launchAction(state, 'The wave envelope is missing: relaunch argv and wait for the process to exit before --next.');
    }
    return done(state, 'failed', 'The wave envelope is missing after one relaunch.', { command: state.resumeCommand });
  }
  const sourceMap = {};
  for (const record of envelope.targets) {
    sourceMap[record.sourceKey] = {
      provider: record.platform,
      candidateIndex: record.candidateIndex,
      model: record.model ?? null,
      effort: record.effort ?? null,
      status: record.role ?? (record.substitutesFor ? 'reserve' : 'target'),
      session: record.session ?? null,
      substitutesFor: record.substitutesFor ?? null,
    };
  }
  const earlyBySlot = new Map((reply?.earlyFallbacks ?? []).map((fallback) => [fallback.slot, fallback]));
  const failuresBySlot = new Map((envelope.failures ?? []).map((failure) => [failure.sourceKey, failure]));
  for (const [slot, fallback] of earlyBySlot) {
    const planned = state.wave.earlyFallbacks.find((candidate) => candidate.slot === slot);
    const actual = fallback.actual;
    if (!planned || !failuresBySlot.has(slot) || actual.agentType !== planned.descriptor.agentType || actual.model !== planned.descriptor.model || actual.reasoningEffort !== planned.descriptor.reasoningEffort) {
      return launchReplyAction(state, `Early fallback metadata or failed-slot identity does not match the descriptor for ${slot}.`);
    }
    const text = fs.existsSync(fallback.outputPath) ? fs.readFileSync(fallback.outputPath, 'utf8') : '';
    fallback.text = text;
  }
  // Split early outcomes: a success is final; an empty capture is requeued exactly once below.
  const earlySucceeded = new Map([...earlyBySlot].filter(([, fallback]) => fallback.text.trim()));
  const earlyFailed = [...earlyBySlot.keys()].filter((slot) => !earlySucceeded.has(slot));
  const unresolvedAll = (envelope.failures ?? []).filter((failure) =>
    !earlyBySlot.has(failure.sourceKey) && !failure.substitutesFor && !envelope.targets.some((record) => record.substitutesFor === failure.sourceKey));
  // Native fallback substitutes a same-platform subagent only; other platforms' failures are recorded
  // in run state (the resolution-log sourceMap has no failed status).
  const unresolved = unresolvedAll.filter((failure) => failure.platform === state.invocation.orchestrator);
  for (const failure of unresolvedAll) if (!unresolved.includes(failure)) recordReviewFailure(state, failure.sourceKey, failure.failureKind ?? 'cross-platform');
  state.collect = {
    reports: [
      ...envelope.targets.map((record) => ({ sourceKey: record.sourceKey, text: record.report ?? '', fallback: false })),
      ...[...earlySucceeded].map(([sourceKey, fallback]) => ({ sourceKey, text: fallback.text, fallback: true })),
    ],
    sourceMap,
    // The batch record's own `model` is null for an array candidate; the cascade's model list
    // always comes from the resolved policy target/reserve for this (platform, candidateIndex).
    queue: unresolved.map((failure) => cascadeSlot(state, failure, 0)),
    fallbackTried: [...earlySucceeded.keys()],
  };
  // A failed early fallback already ran model[0]: a multi-model cascade resumes at position 1; a
  // single-model cascade keeps one post-wave native retry of model[0], since the early run was a
  // different path from the CLI dispatch that failed first.
  for (const sourceKey of earlyFailed) {
    const planned = state.wave.earlyFallbacks.find((candidate) => candidate.slot === sourceKey);
    const failure = failuresBySlot.get(sourceKey);
    state.collect.queue.push(cascadeSlot(state, failure, planned.descriptor.modelCascade.length > 1 ? 1 : 0));
  }
  for (const [sourceKey, fallback] of earlySucceeded) {
    const failure = (envelope.failures ?? []).find((candidate) => candidate.sourceKey === sourceKey);
    state.collect.sourceMap[sourceKey] = {
      provider: failure?.platform ?? state.invocation.orchestrator,
      candidateIndex: failure?.candidateIndex ?? Number(sourceKey.split(':').at(-1)),
      model: fallback.actual.model,
      effort: fallback.actual.reasoningEffort,
      status: 'fallback',
      session: null,
      substitutesFor: null,
    };
  }
  return processCollected(state);
}

/** Resolves a failed slot's own model cascade from the policy target/reserve identified by
 * `(platform, candidateIndex)` — never from the batch failure record, whose `model` is null for
 * an array candidate. */
function cascadeSlot(state, failure, cascadePosition) {
  const match = [...state.policy.targets, ...state.policy.reserves]
    .find((candidate) => candidate.platform === failure.platform && candidate.candidateIndex === failure.candidateIndex);
  const models = match?.model ? (Array.isArray(match.model) ? match.model : [match.model]) : (failure.model ? [failure.model] : []);
  return {
    sourceKey: failure.sourceKey,
    platform: failure.platform,
    candidateIndex: failure.candidateIndex,
    models,
    cascadePosition,
    effort: match?.effort ?? failure.effort ?? null,
    substitutesFor: failure.substitutesFor ?? null,
  };
}

function nativeFallbackAction(state) {
  const slot = state.collect.queue[0];
  if (!slot.models[slot.cascadePosition] || !slot.effort) {
    state.collect.queue.shift();
    state.collect.fallbackTried.push(slot.sourceKey);
    return processCollected(state);
  }
  const outputPath = runFile(state, `fallback-${state.collect.fallbackTried.length + 1}.txt`);
  const descriptor = {
    sourceKey: slot.sourceKey,
    agentType: NATIVE_AGENT_TYPES[slot.platform] ?? 'explore',
    model: slot.models[slot.cascadePosition],
    reasoningEffort: slot.effort,
    substitutesFor: slot.substitutesFor,
    cascadePosition: slot.cascadePosition,
    modelCascade: slot.models,
  };
  state.collect.current = { ...slot, outputPath, descriptor };
  return emitAction(state, 'native-fallback', { slot: slot.sourceKey, promptPath: state.wave.promptPath, outputPath, descriptor }, [
    'Launch the named read-only native subagent using descriptor.agentType, descriptor.model, and descriptor.reasoningEffort exactly; never use launcher defaults.',
    'Tell the native subagent: Read promptPath in full and follow it as the authoritative instructions.',
    'If the launcher cannot accept the configured model or effort, do not launch: re-resolve or exclude this source.',
    'Write its final reply verbatim to outputPath, then report the actual launch metadata with the captured reply, or a {kind, reason} failure.',
  ]);
}

function onNativeFallback(state, reply) {
  const current = state.collect.current;
  if (reply.slot !== current.sourceKey) return reemit(state, `slot must be ${current.sourceKey}.`);
  const expected = current.descriptor;
  if (reply.failed) {
    // A failed hop advances to the next model in this candidate's own cascade; sibling candidates
    // are never substituted in. Exhaustion drops the slot and records it failed.
    const nextPosition = current.cascadePosition + 1;
    if (nextPosition < current.models.length) {
      state.collect.queue[0] = { ...current, cascadePosition: nextPosition };
    } else {
      state.collect.queue.shift();
      state.collect.fallbackTried.push(current.sourceKey);
      delete state.collect.sourceMap[current.sourceKey];
      recordReviewFailure(state, current.sourceKey, reply.failed.kind);
    }
    return processCollected(state);
  }
  const actual = reply.actual;
  if (!actual || actual.agentType !== expected.agentType || actual.model !== expected.model || actual.reasoningEffort !== expected.reasoningEffort) {
    return reemit(state, `Native fallback launch metadata must match the descriptor exactly; expected ${JSON.stringify({ agentType: expected.agentType, model: expected.model, reasoningEffort: expected.reasoningEffort })}.`);
  }
  state.collect.queue.shift();
  state.collect.fallbackTried.push(current.sourceKey);
  const text = fs.existsSync(current.outputPath) ? fs.readFileSync(current.outputPath, 'utf8') : '';
  if (text.trim()) {
    state.collect.reports.push({ sourceKey: current.sourceKey, text, fallback: true });
    state.collect.sourceMap[current.sourceKey] = {
      provider: current.platform,
      candidateIndex: current.candidateIndex,
      model: actual.model,
      effort: actual.reasoningEffort,
      status: 'fallback',
      session: null,
      substitutesFor: expected.substitutesFor,
    };
  }
  return processCollected(state);
}

function processCollected(state) {
  if (state.collect.queue.length > 0) return nativeFallbackAction(state);
  if (state.wave.type === 'rebuttal') return applyRebuttals(state);
  const findings = [];
  const byContent = new Map();
  for (const report of [...state.collect.reports]) {
    let parsed;
    try {
      parsed = parseReport(state.kind, report.text);
    } catch (err) {
      if (err instanceof InvalidReviewReportError && err.prose) {
        const reportPath = runFile(state, `report-${findings.length + 1}.txt`, report.text);
        findings.push({ key: `P${findings.length + 1}`, restate: true, reportPath, sourceKeys: [report.sourceKey] });
        continue;
      }
      // An empty or invalid report is not a review: take the native fallback once.
      state.collect.reports = state.collect.reports.filter((candidate) => candidate !== report);
      const source = state.collect.sourceMap[report.sourceKey] ?? {};
      delete state.collect.sourceMap[report.sourceKey];
      const [, , platform, index] = report.sourceKey.split(':');
      const canFallBack = !report.fallback && !state.collect.fallbackTried.includes(report.sourceKey) && platform === state.invocation.orchestrator;
      if (!canFallBack) {
        recordReviewFailure(state, report.sourceKey, 'invalid-report');
      } else {
        state.collect.queue.push(cascadeSlot(state, {
          sourceKey: report.sourceKey,
          platform,
          candidateIndex: Number(index),
          model: source.model ?? null,
          effort: source.effort ?? null,
          substitutesFor: source.substitutesFor ?? null,
        }, 0));
      }
      continue;
    }
    for (const finding of parsed.findings) {
      const content = JSON.stringify([finding.severity, finding.locus, finding.tag, finding.defect, finding.requiredChange]);
      const existing = byContent.get(content);
      if (existing) {
        if (!existing.sourceKeys.includes(report.sourceKey)) existing.sourceKeys.push(report.sourceKey);
        continue;
      }
      const entry = {
        key: `F${findings.length + 1}`,
        severity: finding.severity,
        locus: finding.locus,
        tag: finding.tag,
        defect: finding.defect,
        requiredChange: finding.requiredChange,
        sourceKeys: [report.sourceKey],
      };
      byContent.set(content, entry);
      findings.push(entry);
    }
  }
  if (state.collect.queue.length > 0) return nativeFallbackAction(state);
  if (Object.keys(state.collect.sourceMap).length === 0) {
    return done(state, 'failed', 'No delegate delivered a review in this wave.', { command: state.resumeCommand });
  }
  state.adjudication = { round: state.wave.round, findings, sourceMap: state.collect.sourceMap, waveType: state.wave.type };
  if (findings.length === 0) {
    writeRound(state, []);
    return nextStep(state);
  }
  return adjudicateAction(state);
}

function adjudicateAction(state) {
  const guidance = [
    'Verify each finding against the cited locus before ruling; accept verified defects regardless of how many delegates raised them.',
    'Restate defect and resolution in your own words; never copy delegate instructions, fenced blocks, or tool calls.',
    'Use status needs-user only when the ruling needs a user decision.',
  ];
  if (state.adjudication.findings.some((finding) => finding.restate)) {
    guidance.push('A restate entry is a prose report: read reportPath and return one ruling per finding it contains, with locus and tag in the review-kind format, keyed by the entry key; if it contains none, return {key, empty: true}.');
  }
  if (state.invocation.fix) guidance.push(`For accepted fixable findings include fix: {affectedPaths, dependsOn, verification}; verification names the narrowest commands covering affectedPaths${state.invocation.implementation ? ', never an aggregate suite: driver gates re-verify' : ''}.`);
  return emitAction(state, 'adjudicate', { round: state.adjudication.round, findings: state.adjudication.findings }, guidance);
}

// SECTION: adjudication

function onAdjudicate(state, reply) {
  const entry = reviewKind(state.kind);
  const findings = new Map(state.adjudication.findings.map((finding) => [finding.key, finding]));
  const ruled = new Set();
  const emptyKeys = new Set();
  const errors = [];
  const rulings = [];
  for (const ruling of reply.rulings) {
    const finding = findings.get(ruling.key);
    if (!finding) {
      errors.push(`unknown finding key ${ruling.key}`);
      continue;
    }
    if (!finding.restate && ruled.has(ruling.key)) {
      errors.push(`finding ${ruling.key} is ruled twice`);
      continue;
    }
    if (ruling.empty) {
      if (!finding.restate) errors.push(`${ruling.key}: empty applies only to a restate entry`);
      else if (ruled.has(ruling.key)) errors.push(`${ruling.key}: an empty restate entry takes no other ruling`);
      ruled.add(ruling.key);
      emptyKeys.add(ruling.key);
      continue;
    }
    if (emptyKeys.has(ruling.key)) errors.push(`${ruling.key}: an empty restate entry takes no other ruling`);
    ruled.add(ruling.key);
    const locus = normalizeLocus(entry.kind, ruling.locus);
    if (!entry.locusPattern.test(locus)) errors.push(`${ruling.key}: locus must match ${entry.locusDescription}`);
    if (!entry.tags.has(ruling.tag)) errors.push(`${ruling.key}: tag "${ruling.tag}" is not a ${entry.kind} review tag`);
    rulings.push({ ...ruling, locus });
  }
  for (const key of findings.keys()) if (!ruled.has(key)) errors.push(`finding ${key} has no ruling`);
  if (state.invocation.fix) {
    for (const ruling of rulings) {
      if (ruling.status === 'accepted' && ruling.scope !== 'adjacent' && ruling.severity !== 'CONSIDER' && !ruling.fix?.affectedPaths?.length) {
        errors.push(`${ruling.key}: an accepted in-scope ${ruling.severity} under --fix needs fix.affectedPaths`);
      }
      const badPath = (ruling.fix?.affectedPaths ?? []).find((p) => !REPO_RELATIVE.test(p));
      if (badPath !== undefined) errors.push(`${ruling.key}: fix.affectedPaths entry "${badPath}" must be a repository-relative slash path`);
    }
  }
  if (errors.length) return reemit(state, errors.join('; '));
  if (rulings.some((ruling) => ruling.status === 'needs-user')) {
    state.rulings = rulings;
    return emitAction(state, 'ask-user', {
      question: 'rulings',
      text: 'These findings need your ruling: answer accepted or rejected for each key.',
      items: rulings.filter((ruling) => ruling.status === 'needs-user').map((ruling) => ({
        key: ruling.key, severity: ruling.severity, locus: ruling.locus, defect: cleanText(ruling.defect, ruling.key),
      })),
    }, ['Relay the question; answer with {"answer": {"<key>": "accepted"|"rejected"}}.']);
  }
  writeRound(state, rulings);
  return nextStep(state);
}

function statusLabel(state, ruling, userFinal) {
  if (ruling.status === 'accepted') return 'Accepted';
  const pending = state.policy.consensus && !userFinal && state.adjudication.waveType === 'review' &&
    ruling.scope === 'in-scope' && ruling.severity !== 'CONSIDER';
  return pending ? 'Rejected — Pending Confirmation' : 'Rejected / Downgraded';
}

function writeRound(state, rulings, userFinalKeys = new Set()) {
  const { round, findings, sourceMap } = state.adjudication;
  let markdown = readArtifactText(state);
  const first = Number(nextFindingId(markdown, round).split('-F')[1]);
  const byKey = new Map(findings.map((finding) => [finding.key, finding]));
  const lines = [`### Round ${round} — ${today()}`, formatSourceMapLine(validateSourceMap(sourceMap, round))];
  const unfixable = [];
  rulings.forEach((ruling, index) => {
    const id = `R${round}-F${String(first + index).padStart(3, '0')}`;
    const sources = byKey.get(ruling.key).sourceKeys.filter((key) => Object.hasOwn(sourceMap, key));
    const defect = cleanText(ruling.defect, 'Restated finding.');
    const resolution = cleanText(ruling.resolution, 'Ruled by the host.');
    lines.push(`- **[${statusLabel(state, ruling, userFinalKeys.has(ruling.key))}]** [${id}] [${ruling.severity}] [sources=${sources.join(',')}] ${ruling.locus} — ${ruling.tag}: ${defect} → ${resolution}`);
    if (ruling.status !== 'accepted' || !state.invocation.fix) return;
    const tracked = { id, severity: ruling.severity, scope: ruling.scope, defect, fix: ruling.fix ?? null };
    if (ruling.scope === 'adjacent') state.adjacent.push(tracked);
    else if (ruling.severity === 'CONSIDER') return;
    else if (ruling.fix?.affectedPaths?.length) state.fix.pending.push(tracked);
    // User-accepted findings (needs-user, round cap) can arrive without fix details: defer, never drop.
    else unfixable.push({ ...tracked, fix: { affectedPaths: [locusPath(state, ruling.locus)], dependsOn: [], verification: [] } });
  });
  markdown = appendToSection(markdown, LOG_HEADING, '## Review Findings & Resolutions', lines, /^\*No reviews conducted yet\.\*\s*$/);
  writeArtifactText(state, markdown);
  // Mark queued work in the log itself, so a lost cache resumes exactly these fixes and no others.
  const queued = [...state.fix.pending, ...state.adjacent].filter((finding) => finding.fix?.affectedPaths?.length && !finding.recorded);
  writeApplicationRecords(state, queued, 'unapplied', PENDING_FIX_REASON);
  for (const finding of queued) finding.recorded = true;
  if (unfixable.length) deferCluster(state, { findings: unfixable }, 'accepted without fix details; apply manually');
}

// Code loci carry a path; plan and design loci are sections of the artifact itself.
function locusPath(state, locus) {
  const match = /^([^\s:§]+):L\d+/.exec(locus ?? '');
  return match ? match[1] : toSlash(path.relative(state.repoRoot, state.artifactPath));
}

function onAskUser(state, reply) {
  const question = state.pending.question;
  if (question === 'inputs') {
    const answer = reply.answer;
    if (!answer || typeof answer !== 'object' || typeof answer.summary !== 'string' || !answer.summary.trim() ||
        typeof answer.verification?.command !== 'string' || typeof answer.verification?.result !== 'string') {
      return reemit(state, 'answer must be {"summary": "...", "verification": {"command": "...", "result": "..."}}.');
    }
    state.inputs = { summary: answer.summary, verification: { command: answer.verification.command, result: answer.verification.result } };
    return prepareWave(state, 'review');
  }
  if (question === 'opt-in') return onOptIn(state, reply);
  if (reply.extend === true) {
    if (state.rulings || !state.pending.options?.includes('extend')) return reemit(state, 'extend is only available at the round cap.');
    state.roundLimit = (state.roundLimit ?? state.policy.rounds) + state.policy.rounds;
    return nextStep(state);
  }
  if (reply.stop === true && state.pending.options?.includes('stop')) {
    if (state.pending.items.length) {
      return emitAction(state, 'ask-user', {
        question: 'rulings',
        text: 'To stop, rule each unresolved finding accepted or rejected; one final verification wave follows.',
        items: state.pending.items,
      }, ['Answer with {"answer": {"<key>": "accepted"|"rejected"}}.']);
    }
    state.capAsked = true;
    return nextStep(state);
  }
  const answer = reply.answer;
  const keys = state.pending.items.map((item) => item.key);
  const verdicts = {};
  for (const key of keys) {
    const value = answer && typeof answer === 'object' ? String(answer[key] ?? '').toLowerCase() : '';
    if (!['accepted', 'rejected', 'downgraded'].includes(value)) return reemit(state, `answer must rule ${key} as accepted or rejected.`);
    verdicts[key] = value;
  }
  if (state.rulings) {
    // needs-user rulings: the user's answer is final for those keys.
    const rulings = state.rulings.map((ruling) => (ruling.status === 'needs-user' ? { ...ruling, status: verdicts[ruling.key] } : ruling));
    state.rulings = null;
    writeRound(state, rulings, new Set(keys));
    return nextStep(state);
  }
  // Round cap: rule unresolved entries, then run one final verification wave.
  let markdown = readArtifactText(state);
  const statuses = new Map(state.pending.items.map((item) => [item.key, item.status]));
  const accepted = [];
  for (const key of keys) {
    const label = verdicts[key] === 'accepted'
      ? (statuses.get(key) === 'disputed' ? 'Resolved dispute' : 'Accepted')
      : 'Rejected / Downgraded';
    markdown = setEntryStatus(markdown, key, label);
    if (verdicts[key] === 'accepted' && state.invocation.fix) accepted.push(key);
  }
  writeArtifactText(state, markdown);
  if (accepted.length) {
    const entries = scanResolutionLog(markdown, { strict: true }).rounds.flatMap((round) => round.entries);
    const findings = accepted.map((key) => {
      const entry = entries.find((item) => item.key === key);
      const locus = /\[sources=[^\]]*\]\s+(.+?)\s+—/.exec(entry.originalLine)?.[1] ?? '';
      const defect = /\s+—\s+[^:]+:\s+(.*?)\s+→/.exec(entry.originalLine)?.[1] ?? key;
      return { id: key, severity: entry.severity, scope: 'in-scope', defect,
        fix: { affectedPaths: [locusPath(state, locus)], dependsOn: [], verification: [] } };
    });
    deferCluster(state, { findings }, 'accepted at round cap without fix details; apply manually');
  }
  state.capAsked = true;
  return nextStep(state);
}

// SECTION: consensus and rebuttal

function prepareRebuttal(state, markdown, logRounds) {
  const unsettled = evaluateConsensus(markdown).unsettledItems;
  const resolutionOf = (line) => line.split(' → ').slice(1).join(' → ').trim() || 'See the resolution log.';
  const packets = buildRebuttalPackets(markdown, {
    findings: unsettled.map((item) => ({
      key: item.key,
      orchestratorVerdict: item.status === 'disputed' ? 'disputed' : 'reject',
      counterEvidence: resolutionOf(item.originalLine),
      changedExcerpts: [],
    })),
  });
  const findings = new Map();
  for (const group of packets) for (const finding of group.packet.findings) findings.set(finding.key, finding);
  const keys = [...findings.keys()];
  const packetPath = runFile(state, `rebuttal-${logRounds}.json`, `${JSON.stringify({
    schemaVersion: 1,
    sourceKey: 'rebuttal',
    canonicalLogHash: packets[0]?.packet.canonicalLogHash ?? null,
    findings: [...findings.values()],
  }, null, 2)}\n`);
  const targets = [];
  const seen = new Set();
  for (const group of packets) {
    const [, , platform, index] = group.sourceKey.split(':');
    const id = `${platform}:${index}`;
    if (seen.has(id) || !state.policy.targets.concat(state.policy.reserves).some((t) => t.platform === platform)) continue;
    seen.add(id);
    targets.push({ candidateId: `${state.phase}:${platform}:${index}`, platform, candidateIndex: Number(index) });
  }
  state.rebuttalAt = logRounds;
  state.rebuttal = { keys, citing: Object.fromEntries(unsettled.map((item) => [item.key, item.sourceKeys])) };
  if (targets.length === 0) return nextStep(state);
  return prepareWave(state, 'rebuttal', { reviewMode: 'rebuttal', targets, reserves: [], packetPath, keys });
}

function applyRebuttals(state) {
  const verdicts = new Map();
  for (const report of state.collect.reports) {
    let parsed;
    try {
      parsed = parseRebuttal(state.kind, report.text, state.rebuttal.keys);
    } catch {
      continue; // An unusable rebuttal leaves its keys live.
    }
    const [, , platform, index] = report.sourceKey.split(':');
    for (const response of parsed.responses) {
      if (!verdicts.has(response.key)) verdicts.set(response.key, new Map());
      verdicts.get(response.key).set(`${platform}:${index}`, response.verdict);
    }
  }
  let markdown = readArtifactText(state);
  const pending = new Map(evaluateConsensus(markdown).unsettledItems.map((item) => [item.key, item.status]));
  for (const key of state.rebuttal.keys) {
    const citing = (state.rebuttal.citing[key] ?? []).map((source) => source.split(':').slice(2).join(':'));
    const answers = verdicts.get(key) ?? new Map();
    const given = citing.map((source) => answers.get(source)).filter(Boolean);
    if (given.includes('INTENT-DISPUTE')) markdown = setEntryStatus(markdown, key, 'Disputed');
    else if (pending.get(key) === 'pendingConfirmation' && given.length === citing.length && given.every((v) => v === 'CONFIRM')) {
      markdown = setEntryStatus(markdown, key, 'Rejected / Downgraded');
    }
  }
  writeArtifactText(state, markdown);
  return nextStep(state);
}

function askCap(state, entries, extend = true, accepted = []) {
  const items = entries.map((item) => ({
    key: item.key, severity: item.severity, status: item.status, line: item.originalLine,
  }));
  const counts = Object.fromEntries(['MUST', 'SHOULD', 'CONSIDER'].map((severity) => [severity, [...entries, ...accepted].filter((item) => item.severity === severity).length]));
  return emitAction(state, 'ask-user', {
    question: 'rulings',
    text: extend
      ? `The review reached round ${state.roundLimit} with ${counts.MUST} MUST / ${counts.SHOULD} SHOULD / ${counts.CONSIDER} CONSIDER open findings. Extend by ${state.policy.rounds} rounds (default), or stop, rule unresolved keys, and run one final verification wave. Already accepted findings retain their rulings.`
      : `The review has ${counts.MUST} MUST / ${counts.SHOULD} SHOULD / ${counts.CONSIDER} CONSIDER unresolved findings. Rule each key before settlement; no additional review round is needed.`,
    ...(extend ? { options: ['extend', 'stop'] } : {}),
    counts,
    items,
  }, [extend ? 'Relay the question; answer with {"extend": true} or {"stop": true} (which asks for rulings when items remain).' : 'Relay the question; answer with {"answer": {"<key>": "accepted"|"rejected"}}.']);
}

/** Chooses the next action from the artifact log and run flags. */
function nextStep(state) {
  if (state.invocation.fix && state.fix.pending.length > 0) return applyFixesAction(state, state.fix.pending.splice(0));
  const markdown = readArtifactText(state);
  const consensus = evaluateConsensus(markdown);
  if (consensus.exit === 2) return done(state, 'failed', `The resolution log is invalid: ${consensus.error}`);
  const cap = state.policy.rounds;
  const rounds = scanResolutionLog(markdown, { strict: true }).rounds;
  const latest = rounds[rounds.length - 1];
  const recent = latest && (state.adjudication?.round === latest.number || (!state.adjudication && state.reviewWaves === latest.number)) ? latest.entries : [];
  const accepted = state.finalDone ? [] : recent.filter((item) =>
    (item.status === 'accepted' || item.status === 'resolvedDispute') && item.application?.state !== 'applied');
  const open = consensus.unsettledItems;
  const hasMust = [...accepted, ...open].some((item) => item.severity === 'MUST');
  const hasShould = [...accepted, ...open].some((item) => item.severity === 'SHOULD');
  if (consensus.exit === 1) {
    const hasPending = open.some((item) => item.status === 'pendingConfirmation');
    if (!state.finalDone && state.policy.consensus && hasPending && state.rebuttalAt !== rounds.length) return prepareRebuttal(state, markdown, rounds.length);
  }
  if (state.capAsked && !state.finalDone) return prepareWave(state, 'final');
  if (!state.finalDone && state.changed && state.reviewWaves < (state.roundLimit ?? cap)) {
    state.changed = false;
    return prepareWave(state, 'review');
  }
  const triggers = !state.finalDone && (state.reviewWaves <= cap ? hasMust || hasShould : hasMust);
  if (triggers && state.reviewWaves < (state.roundLimit ?? cap)) return prepareWave(state, 'review');
  if (!state.finalDone && hasMust && state.reviewWaves >= (state.roundLimit ?? cap)) {
    return askCap(state, open, true, accepted.filter((item) => !open.some((entry) => entry.key === item.key)));
  }
  if (consensus.exit === 1) {
    // Unresolved rebuttals and disputes require a host ruling, not a silent status rewrite.
    return askCap(state, open, false);
  }
  if (state.invocation.fix && !state.optInOffered && state.adjacent.length > 0) return optInAction(state);
  return state.invocation.implementation ? settle(state) : checkpoint(state);
}

// SECTION: fixes

const NARROWEST_CHECK = 'Run at most the narrowest check for the touched locus; the driver runs the gates.';

function applyFixesAction(state, findings) {
  const clusters = createIndependenceClusters(findings.map((finding) => ({
    findingId: finding.id,
    affectedPaths: finding.fix.affectedPaths,
    dependsOn: finding.fix.dependsOn,
    verification: finding.fix.verification,
  })), { runId: state.runId });
  state.fix.active = clusters.map((cluster) => ({
    clusterId: cluster.clusterId,
    findingIds: cluster.findingIds,
    affectedPaths: cluster.affectedPaths,
    verification: cluster.verification,
    findings: findings.filter((finding) => cluster.findingIds.includes(finding.id)),
  }));
  return emitAction(state, 'apply-fixes', {
    clusters: state.fix.active.map(({ clusterId, findingIds, affectedPaths, verification }) => ({ clusterId, findingIds, affectedPaths, verification })),
  }, [
    'Edit inline (no subagent) to resolve each cluster, touching only its affectedPaths; reply with each cluster status.',
    NARROWEST_CHECK,
  ]);
}

function reapplyAction(state) {
  return emitAction(state, 'apply-fixes', {
    clusters: state.fix.active.map(({ clusterId, findingIds, affectedPaths, verification }) => ({ clusterId, findingIds, affectedPaths, verification })),
  }, ['Verification failed for these clusters; fix them again and reply with each cluster status.', NARROWEST_CHECK]);
}

function onApplyFixes(state, reply) {
  const statuses = new Map(reply.clusters.map((cluster) => [cluster.clusterId, cluster]));
  const missing = state.fix.active.filter((cluster) => !statuses.has(cluster.clusterId)).map((c) => c.clusterId);
  if (missing.length) return reemit(state, `missing cluster status for ${missing.join(', ')}`);
  state.changed = true;
  for (const cluster of state.fix.active) {
    const status = statuses.get(cluster.clusterId);
    cluster.applyFailure = status.status === 'failed' ? `apply failed: ${cleanText(status.note, 'no detail')}` : null;
  }
  if (state.kind !== 'code') {
    // Plan and design verify with the in-process lint: no host command runs (AC1).
    const defects = reviewKind(state.kind).lint(readArtifactText(state)).defects;
    const failure = defects.length ? `lint: ${defects.map((defect) => defect.rule).join(', ')}` : null;
    return settleVerification(state, () => failure);
  }
  const integrity = regenerateRepoHashes(state.repoRoot, state.fix.active.filter((c) => !c.applyFailure).flatMap((c) => c.affectedPaths ?? []));
  if (integrity) return done(state, 'failed', integrity, { command: state.resumeCommand });
  const commands = [...new Set(state.fix.active.filter((c) => !c.applyFailure).flatMap((c) => c.verification))];
  if (commands.length === 0) return settleVerification(state, () => null);
  state.fix.commands = commands;
  return emitAction(state, 'verify', { commands }, ['Run each command from the repository root; reply with its exit code and concise evidence.']);
}

/**
 * Regenerates the skill manifest when every integrity violation is one of `ownedPaths` (repo-relative);
 * returns the failure diagnostic otherwise. Installed skills outside the repository are never rewritten.
 *
 * @param {string} repoRoot
 * @param {string[]} ownedPaths
 * @returns {string | null}
 */
export function regenerateRepoHashes(repoRoot, ownedPaths) {
  const relative = skillDirInRepo(repoRoot, DISPATCH_DIR);
  if (relative === null) return null;
  const root = fs.realpathSync.native(repoRoot);
  const edited = ownedPaths.map((value) => path.join(root, value));
  const skillDir = path.join(root, relative);
  const result = regenerateOwnedHashes(skillDir, edited);
  return result.violations.length && !result.regenerated ? integrityDiagnostic(skillDir) : null;
}

function onVerify(state, reply) {
  const failures = reply.results.filter((result) => result.exit !== 0);
  return settleVerification(state, (cluster) => {
    // A cluster fails only on its own commands; one with none never fails verification.
    const own = failures.filter((result) => cluster.verification.includes(result.command));
    return own.length ? own.map((result) => `${result.command} exit ${result.exit}: ${cleanText(result.evidence, 'no evidence')}`).join('; ') : null;
  });
}

const MAX_VERIFY_FAILURES = 3;

/** Two identical failures (or three of any kind) stop a cluster and defer its findings; others retry. */
function settleVerification(state, failureOf) {
  const retry = [];
  for (const cluster of state.fix.active) {
    const failure = cluster.applyFailure ?? failureOf(cluster);
    if (!failure) {
      // The record marks the fix done, so a resumed `--run --fix` never re-applies it.
      writeApplicationRecords(state, cluster.findings, 'applied', cluster.verification.length ? 'verified' : 'applied; no verification commands');
      continue;
    }
    // Identical text stops at two; flaky evidence still stops at MAX_VERIFY_FAILURES.
    state.fix.failureCounts ??= {};
    const count = (state.fix.failureCounts[cluster.clusterId] ?? 0) + 1;
    state.fix.failureCounts[cluster.clusterId] = count;
    if (state.fix.attempts[cluster.clusterId] === failure || count >= MAX_VERIFY_FAILURES) {
      deferCluster(state, cluster, `verification failed ${count} times: ${failure}`);
    } else {
      state.fix.attempts[cluster.clusterId] = failure;
      retry.push(cluster);
    }
  }
  state.fix.active = retry;
  if (retry.length) return reapplyAction(state);
  return nextStep(state);
}

function deferCluster(state, cluster, reason) {
  writeApplicationRecords(state, cluster.findings, 'unapplied', cleanText(reason, 'verification failed twice'));
  addFollowUps(state, cluster.findings.map((finding) => `- [${finding.id}] ${finding.defect} — deferred: ${cleanText(reason, 'verification failed')}`));
}

/** Writes or replaces each finding's application record; an unrecordable finding degrades to a stderr note. */
function writeApplicationRecords(state, findings, applicationState, reason) {
  if (findings.length === 0) return;
  let markdown = readArtifactText(state);
  const lines = markdown.split('\n');
  for (const finding of findings) {
    const index = lines.findIndex((line) => /^\s*[-*]\s+\*\*\[/.test(line) && line.includes(`[${finding.id}]`));
    if (index === -1) continue;
    let record;
    try {
      record = formatApplicationRecord({
        v: 1,
        findingId: finding.id,
        state: applicationState,
        scope: finding.scope,
        affectedPaths: [...new Set(finding.fix.affectedPaths)].sort(),
        dependsOn: [...new Set(finding.fix.dependsOn)].sort(),
        verification: [...new Set(finding.fix.verification)],
        reason,
      });
    } catch (err) {
      // NOTE: e.g. an artifact outside the repo root has no repo-relative path; never wedge the run on a record.
      process.stderr.write(`[dispatch] application record skipped for ${finding.id}: ${err.message}\n`);
      continue;
    }
    const hasRecord = /^\s+-\s+application:/.test(lines[index + 1] ?? '');
    lines.splice(index + 1, hasRecord ? 1 : 0, record);
  }
  markdown = lines.join('\n');
  writeArtifactText(state, markdown);
}

function addFollowUps(state, bullets) {
  if (bullets.length === 0) return;
  const markdown = appendToSection(readArtifactText(state), FOLLOW_UPS, '## Follow-ups', bullets, /^(None\.?|Accepted SHOULD-FIX.*)$/);
  writeArtifactText(state, markdown);
}

function optInAction(state) {
  const sections = formatOptInSections({
    outOfScope: state.adjacent.map((finding) => ({ findingId: finding.id, summary: finding.defect })),
  });
  state.optIn = { aliases: sections.aliases, items: sections.items };
  return emitAction(state, 'ask-user', {
    question: 'opt-in',
    text: sections.text,
    items: sections.items,
  }, ['Relay the list; answer with {"answer": "<the user\'s choice text>"} (for example "include O1", "all", or "none").']);
}

function onOptIn(state, reply) {
  if (typeof reply.answer !== 'string') return reemit(state, 'answer must be the user\'s choice text.');
  const parsed = parseOptInResponse(reply.answer, state.optIn);
  const chosen = new Set(parsed.includedFindingIds);
  state.optInOffered = true;
  const deferred = [];
  const declined = [];
  for (const finding of state.adjacent) {
    if (chosen.has(finding.id) && finding.fix?.affectedPaths?.length) state.fix.pending.push(finding);
    else {
      declined.push(finding);
      deferred.push(`- [${finding.id}] ${finding.defect} — adjacent; not selected for this run.`);
    }
  }
  // Clear the pending marker so a resumed run never re-offers a declined item.
  writeApplicationRecords(state, declined.filter((finding) => finding.fix?.affectedPaths?.length), 'unapplied', 'adjacent; declined in opt-in');
  addFollowUps(state, deferred);
  // The offer is settled; later rounds must not re-queue these items.
  state.adjacent = [];
  // The opt-in loop gets a fresh round cap.
  if (state.fix.pending.length) {
    state.reviewWaves = 0;
    state.roundLimit = state.policy.rounds;
  }
  return nextStep(state);
}

// SECTION: checkpoint

/** An implementation code review defers its checkpoint until the implement driver's final gate renders evidence. */
function settle(state) {
  const preview = prepareReview(state.kind, { action: 'checkpoint-preview', invocationContext: state.invocationContext }, { repoRoot: state.repoRoot });
  if (preview.settlement.consensusExit !== 0) return done(state, 'failed', 'Consensus did not settle before checkpoint.');
  // The checkpoint still needs the invocation state, so its cleanup waits for writeCheckpoint.
  state.deferredCleanup = state.cleanup.splice(0);
  return done(state, 'complete', 'Review settled; checkpoint deferred to the final verification gate.', { checkpointed: false });
}

/** Records the deferred checkpoint of a settled implementation code review. */
export function writeCheckpoint(state) {
  state.cleanup.push(...(state.deferredCleanup ?? []).filter(item => !state.cleanup.includes(item)));
  delete state.deferredCleanup;
  return finish(state, checkpoint(state));
}

function checkpoint(state) {
  try {
    const preview = prepareReview(state.kind, { action: 'checkpoint-preview', invocationContext: state.invocationContext }, { repoRoot: state.repoRoot });
    if (preview.settlement.consensusExit !== 0) return done(state, 'failed', 'Consensus did not settle before checkpoint.');
    const result = prepareReview(state.kind, {
      action: 'checkpoint',
      invocationContext: state.invocationContext,
      settlement: preview.settlement,
      settledWrites: preview.settledWrites,
    }, { repoRoot: state.repoRoot });
    state.cleanup.push(...(result.cleanupPaths ?? []));
    return done(state, 'complete', `Review settled and checkpointed (${result.artifactPath}).`, { checkpointed: true });
  } catch (err) {
    // Drift restarts preparation once; the driver never forces a stale checkpoint.
    if (!state.driftRestarted) {
      state.driftRestarted = true;
      state.invocationContext = null;
      state.reviewWaves = Math.min(state.reviewWaves, Math.max(0, (state.roundLimit ?? state.policy.rounds) - 1));
      return prepareWave(state, 'review');
    }
    return done(state, 'failed', `Checkpoint failed: ${err.message}`, { command: state.resumeCommand });
  }
}

const HANDLERS = {
  launch: onLaunch,
  'native-fallback': onNativeFallback,
  adjudicate: onAdjudicate,
  'ask-user': onAskUser,
  'apply-fixes': onApplyFixes,
  verify: onVerify,
  author: (state) => prepareWave(state, 'review'),
};
