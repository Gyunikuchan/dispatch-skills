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
import { explicitRangeBounds } from '../review/range.mjs';
import { getCurrentBranch, ledgerWalkthroughSlug, resolveArtifacts, resolveSlug } from '../artifacts/resolve-paths.mjs';
import { FAILURE_KINDS, formatApplicationRecord, formatFailedTargetsLine, formatRebuttalFailuresLine, formatReviewBudgetMarker, formatSourceMapLine, nextFindingId, scanResolutionLog, validateSourceMap } from '../review/resolution-log.mjs';
import { defaultLiveness, probeCandidates, resolveFlow } from '../lib/resolve-flow.mjs';
import { InvalidReviewReportError, normalizeLocus } from '../review/report.mjs';
import { reviewKind } from '../review/kinds.mjs';
import { parseChangesMade, renderChangesMade, replaceSection, sectionBody } from '../walkthrough/traceability.mjs';
import { withFixes } from '../lib/filler.mjs';
import { integrityDiagnostic, regenerateOwnedHashes, skillDirInRepo } from '../lib/integrity.mjs';
import { DriverError, NATIVE_AGENT_TYPES, emitAction, loadSchema, toError, sanitizeReplyText, validateAgainstSchema } from './actions.mjs';
import {
  DEVIATIONS_FOLLOW_UPS,
  LOG_HEADING,
  REPO_RELATIVE,
  appendToSection,
  cleanText,
  escapeLogText,
  readArtifactText,
  setEntryResolution,
  setEntryStatus,
  writeArtifactText,
} from './review-artifact.mjs';
import {
  PENDING_FIX_REASON,
  REEMITTED,
  createRunState,
  finish,
  gitRoot,
  writeRunState,
  reemit,
  pruneFinishedStates,
  rebuildFromArtifact,
  replyGuidance,
  runFile,
  unappliedFixesFromArtifact,
  writeRunSidecar,
} from './state.mjs';

const DISPATCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?|py)$/;
// Test-runner options whose separate next word is a name pattern, never a file (node, jest, vitest, mocha, pytest).
const PATTERN_OPTIONS = new Set(['--test-name-pattern', '--test-skip-pattern', '--testNamePattern', '-t', '--grep', '-g', '-k']);

/**
 * Script-file arguments of a verification command that exist neither on disk nor in `created`;
 * glob arguments are skipped because the runner expands them.
 * @param {string} repoRoot
 * @param {string} command
 * @param {string[]} [created] repository-relative paths the fix itself writes
 * @returns {string[]}
 */
export function missingVerificationFiles(repoRoot, command, created = []) {
  // Shell words: quoted runs and escaped whitespace join their word (`--opt="a b"`, `a\ b`); separators end it.
  // NOTE: only `\` before whitespace is an escape, so Windows `tests\x.mjs` keeps its separator.
  const words = [...command.matchAll(/(?:"[^"]*"|'[^']*'|\\\s|[^\s;|&<>()"'])+/g)]
    .map(([word]) => word.replace(/"([^"]*)"|'([^']*)'|\\(\s)/g, (_, dq, sq, ws) => dq ?? sq ?? ws));
  return words
    .filter((word, index) => !word.startsWith('-') && !PATTERN_OPTIONS.has(words[index - 1]))
    .map((word) => path.posix.normalize(word.replace(/\\/g, '/')))
    .filter((token) => SCRIPT_FILE.test(token) && !/[*?[\]{}]/.test(token))
    .filter((file) => !created.includes(file) && !fs.existsSync(path.resolve(repoRoot, file)));
}
const NATIVE_MAPPINGS = JSON.parse(fs.readFileSync(path.join(DISPATCH_DIR, 'references', 'native-model-mappings.json'), 'utf8'));
if (!Array.isArray(NATIVE_MAPPINGS) || new Set(NATIVE_MAPPINGS.map((entry) => entry.configuredModel)).size !== NATIVE_MAPPINGS.length ||
  NATIVE_MAPPINGS.some((entry) => !entry.configuredModel || !/^[^/]+\/.+/.test(entry.launcherModel) || !entry.provider || !entry.provenance ||
    Object.keys(entry).sort().join(',') !== 'configuredModel,launcherModel,provenance,provider')) {
  throw new Error('Invalid native-model-mappings registry.');
}

const today = () => new Date().toISOString().slice(0, 10);
const toSlash = (value) => value.split(path.sep).join('/');
const ENTRY_BODY = /\[sources=[^\]]*\]\s+.+? — [^:]+: (.*?) → /;

// SECTION: Phase entry

/**
 * Starts `--run review`; returns the first action.
 *
 * @param {{ invocation: Record<string, any>, cwd: string, resumeCommand: string, dispatchScript?: string, reviewBudget?: Record<string, any> }} options
 */
export async function startReview({ invocation, cwd, resumeCommand, reviewBudget = null }) {
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
    invocationContext: null,
    budgetId: reviewBudget?.budgetId ?? null,
    reviewWaves: reviewBudget?.reviewWaves ?? 0,
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
    pendingUser: [],
    skipReviewForDeferredConsider: false,
    pending: null,
  });
  pruneFinishedStates();
  writeRunSidecar(state, normalized);
  if (levelInfo.skipped) {
    return finish(state, done(state, 'skipped', `Review skipped: ${levelInfo.skipped.reason}`, { reason: levelInfo.skipped.reason }));
  }
  state.policy = await resolvePolicy(config, levelInfo, normalized);
  state.budgetId ??= state.runId;
  state.roundLimit = reviewBudget?.roundLimit ?? state.policy.rounds;
  state.artifactPath ??= existingWalkthrough(state);
  const budgetSeed = { phase: state.phase, budgetId: state.budgetId, reviewWaves: state.reviewWaves, roundLimit: reviewBudget?.roundLimit ?? 0 };
  const unapplied = normalized.fix ? unappliedFixesFromArtifact(state.artifactPath, budgetSeed) : null;
  if (unapplied) {
    // Fixes queued in the log before the cache was lost: apply them (and re-offer the opt-in) before any new wave.
    adoptReviewBudget(state, unapplied.reviewBudget, unapplied.rounds, reviewBudget);
    state.fix.pending = unapplied.pending;
    state.adjacent = unapplied.adjacent;
    state.pendingUser = unapplied.pendingUser ?? [];
    return finish(state, nextStep(state));
  }
  const rebuilt = rebuildFromArtifact(state.artifactPath, budgetSeed);
  if (rebuilt) {
    // Resume from the unsettled log: the state cache is only a cache.
    adoptReviewBudget(state, rebuilt.reviewBudget, rebuilt.rounds, reviewBudget);
    state.pendingUser = rebuilt.pendingUser ?? [];
    return finish(state, nextStep(state));
  }
  return finish(state, prepareWave(state, 'review'));
}

function adoptReviewBudget(state, recovered, fallbackWaves, seed = null) {
  if (recovered?.budgetId) state.budgetId = recovered.budgetId;
  state.reviewWaves = Math.max(state.reviewWaves ?? 0, recovered?.reviewWaves ?? fallbackWaves ?? 0);
  const limit = seed?.roundLimit ?? recovered?.roundLimit ?? 0;
  if (limit > 0) state.roundLimit = Math.max(limit, recovered?.roundLimit ?? 0);
}

function persistReviewBudget(state) {
  const markdown = readArtifactText(state);
  const current = {
    schemaVersion: 1,
    phase: state.phase,
    budgetId: state.budgetId,
    reviewWaves: state.reviewWaves,
    roundLimit: state.roundLimit,
  };
  const scan = scanResolutionLog(markdown, { strict: true });
  const previous = scan.reviewBudgetMarkers.filter((item) => item.phase === current.phase && item.budgetId === current.budgetId)
    .reduce((latest, item) => latest ? {
      ...latest,
      reviewWaves: Math.max(latest.reviewWaves, item.reviewWaves),
      roundLimit: Math.max(latest.roundLimit, item.roundLimit),
    } : item, null);
  if (previous) {
    current.reviewWaves = Math.max(current.reviewWaves, previous.reviewWaves);
    current.roundLimit = Math.max(current.roundLimit, previous.roundLimit);
    state.reviewWaves = current.reviewWaves;
    state.roundLimit = current.roundLimit;
    if (previous.reviewWaves === current.reviewWaves && previous.roundLimit === current.roundLimit) return;
  }
  const updated = appendToSection(markdown, LOG_HEADING, '## Review Findings & Resolutions', [formatReviewBudgetMarker(current)], /^\*No reviews conducted yet\.\*\s*$/);
  writeArtifactText(state, updated);
}

/** A code review's existing walkthrough, resolved as preparation would, so a lost cache can resume from its log. */
function existingWalkthrough(state) {
  // Range reviews resolve the same branch walkthrough in preparation, so they resume from it too.
  if (state.kind !== 'code') return null;
  try {
    const { slug, slugSource } = resolveSlug({ branch: getCurrentBranch(state.repoRoot), orchestrator: state.invocation.orchestrator });
    const native = { orchestrator: state.invocation.orchestrator };
    const walkthrough = slug && resolveArtifacts({ slug, slugSource, kinds: ['walkthrough'], projectRoot: state.repoRoot, native }).walkthrough;
    if (walkthrough?.exists) return path.resolve(state.repoRoot, walkthrough.path);
    // Mirrors preparation's fallback to the session implement run's plan-named walkthrough.
    const fromLedger = ledgerWalkthroughSlug(state.repoRoot, state.target?.range ? explicitRangeBounds(state.repoRoot, state.target.range) : {});
    if (!fromLedger) return null;
    const ledgerWalkthrough = resolveArtifacts({ slug: fromLedger, slugSource: 'explicit', kinds: ['walkthrough'], projectRoot: state.repoRoot, native }).walkthrough;
    return ledgerWalkthrough.exists ? path.resolve(state.repoRoot, ledgerWalkthrough.path) : null;
  } catch {
    // NOTE: an unresolvable slug only means there is nothing to resume; preparation reports it.
    return null;
  }
}

function kindTarget(kind, argument) {
  if (kind === 'code') {
    return /\.walkthrough\.md$/i.test(argument) ? { walkthroughPath: argument } : { range: argument };
  }
  return { artifactPath: argument };
}

/** Advances a run with a validated reply; returns the next action. */
export function advanceReview(state, reply) {
  const handler = HANDLERS[state.pending.action];
  const action = handler(state, reply);
  return finish(state, action);
}

function recordReviewFailure(state, sourceKey, kind, findingKeys = state.wave.type === 'rebuttal' ? citedKeys(state, sourceKey) : null) {
  state.reviewFailed ??= [];
  const wave = state.wave.type, round = state.wave.round;
  if (!state.reviewFailed.some((item) => item.wave === wave && item.round === round && item.sourceKey === sourceKey))
    state.reviewFailed.push({ wave, round, sourceKey, kind: FAILURE_KINDS.includes(kind) ? kind : 'execution', ...(findingKeys?.length ? { findingKeys } : {}) });
}

function currentFailures(state) {
  return (state.reviewFailed ?? []).filter((item) => item.wave === state.wave.type && item.round === state.wave.round)
    .map(({ sourceKey, kind, findingKeys }) => ({ sourceKey, kind, ...(findingKeys ? { findingKeys } : {}) }));
}

/** Keys a rebuttal delegate cites, matched by `platform:index` because the retry wave's roundId may differ. */
function citedKeys(state, sourceKey) {
  const slot = sourceKey.split(':').slice(2).join(':');
  return Object.entries(state.rebuttal?.citing ?? {})
    .filter(([, sources]) => sources.some((source) => source.split(':').slice(2).join(':') === slot)).map(([key]) => key);
}

function unfulfilledTargets(state) {
  return { wave: state.wave.type, round: state.wave.round, targets: currentFailures(state) };
}

function noticedNextStep(state) {
  const notice = unfulfilledTargets(state);
  const action = nextStep(state);
  if (action.action === 'done' && action.unfulfilledTargets?.wave === notice.wave && action.unfulfilledTargets?.round === notice.round) return action;
  const updated = { ...action, unfulfilledTargets: notice };
  const errors = validateAgainstSchema(loadSchema(action.action), updated);
  if (errors.length) throw new Error(`Invalid failure notice: ${errors.join('; ')}`);
  return updated;
}

function done(state, outcome, summary, extra = {}) {
  return emitAction(state, 'done', {
    outcome,
    summary,
    ...(state.artifactPath ? { artifactPath: toSlash(path.relative(state.repoRoot, state.artifactPath)) } : {}),
    ...(state.reviewFailed?.length ? { failed: state.reviewFailed.map((item) => ({ ...item })) } : {}),
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
      ...(target.nativeSubagentsOnly ? { nativeSubagentsOnly: true } : {}),
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

function prepareRequest(state, { reviewMode = 'full', targets, reserves = [], packetPath = null, keys = [], retryNote = null }) {
  const dispatchEntry = ({ candidateId, platform, candidateIndex }) => ({ candidateId, platform, candidateIndex });
  // Native-subagents-only targets never enter the CLI batch, and never serve as its reserves.
  const native = targets.filter((target) => isNativeSubagentsOnly(state, target));
  /** @type {Record<string, any>} */
  const request = {
    mode: 'orchestrated',
    orchestrator: state.invocation.orchestrator,
    targets: targets.filter((target) => !native.includes(target)).map(dispatchEntry),
    reserves: reserves.filter((target) => !isNativeSubagentsOnly(state, target)).map(dispatchEntry),
    ...(native.length ? { nativeTargets: native.map(dispatchEntry) } : {}),
  };
  if (state.invocation.orchestratorModel) request.orchestratorModel = state.invocation.orchestratorModel;
  if (state.invocationContext) request.invocationContext = state.invocationContext;
  if (reviewMode === 'rebuttal') Object.assign(request, { reviewMode, findingPacketPath: packetPath, findingKeys: keys, ...(retryNote ? { retryNote } : {}) });
  if (state.kind === 'code') {
    if (state.target.walkthroughPath) request.walkthroughPath = state.target.walkthroughPath;
    if (state.target.range) request.range = state.target.range;
    if (state.inputs) Object.assign(request, state.inputs);
  } else {
    request.artifactPath = state.artifactPath ?? state.target.artifactPath;
  }
  return request;
}

/** Whether a wave target resolves to a native-subagents-only policy candidate. */
function isNativeSubagentsOnly(state, target) {
  return [...state.policy.targets, ...state.policy.reserves]
    .some((entry) => entry.platform === target.platform && entry.candidateIndex === target.candidateIndex && entry.nativeSubagentsOnly);
}

/** Native subagent launch descriptor shared by early fallbacks and native-subagents-only launches. */
function nativeLaunch(target, sourceKey, promptPath, outputPath) {
  const modelCascade = Array.isArray(target.model) ? target.model : [target.model];
  return {
    slot: sourceKey,
    promptPath,
    outputPath,
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
}

function prepareCheckpointOnly(state) {
  if (state.invocationContext) return nextStep(state);
  const request = prepareRequest(state, { targets: state.policy.targets, reserves: state.policy.reserves });
  let manifest;
  try {
    manifest = prepareReview(state.kind, request, { repoRoot: state.repoRoot });
  } catch (err) {
    return done(state, 'failed', `Checkpoint-only preparation failed: ${err.message}`, { command: state.resumeCommand });
  }
  if (manifest.status !== 'ready') {
    return done(state, 'failed', `Checkpoint-only preparation requires a reviewable artifact; got ${manifest.status}.`, { command: state.resumeCommand });
  }
  state.invocationContext = manifest.invocationContext;
  state.artifactPath = path.resolve(state.repoRoot, manifest.artifact.canonicalPath);
  return nextStep(state);
}

function prepareWave(state, type, rebuttal = null) {
  if (type === 'review' && state.reviewWaves >= (state.roundLimit ?? state.policy.rounds)) {
    return prepareCheckpointOnly(state);
  }
  if ((rebuttal?.targets ?? state.policy.targets).length === 0) {
    return done(state, 'failed', 'No live read delegate is available for this review.', { command: state.resumeCommand });
  }
  let manifest;
  const request = prepareRequest(state, rebuttal ?? {
    targets: state.policy.targets,
    reserves: state.policy.reserves,
  });
  try {
    manifest = prepareReview(state.kind, request, { repoRoot: state.repoRoot });
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
  state.invocationContext = manifest.invocationContext;
  state.artifactPath = path.resolve(state.repoRoot, manifest.artifact.canonicalPath);
  if (type === 'review') {
    state.reviewWaves += 1;
    persistReviewBudget(state);
    // The marker is part of the canonical log, so bind the launch context to its saved revision.
    request.invocationContext = manifest.invocationContext;
    try {
      manifest = prepareReview(state.kind, request, { repoRoot: state.repoRoot });
    } catch (err) {
      return done(state, 'failed', `Review preparation failed after budget allocation: ${err.message}`, { command: state.resumeCommand });
    }
    if (manifest.status !== 'ready') return done(state, 'failed', 'Review preparation changed after budget allocation.', { command: state.resumeCommand });
    state.invocationContext = manifest.invocationContext;
    state.artifactPath = path.resolve(state.repoRoot, manifest.artifact.canonicalPath);
  }
  const round = Number(manifest.roundId.split(':R')[1]);
  if (type === 'final') state.finalDone = true;
  const waveTargets = (rebuttal?.targets ?? state.policy.targets).map((target) => {
    const configured = [...state.policy.targets, ...state.policy.reserves]
      .find((entry) => entry.platform === target.platform && entry.candidateIndex === target.candidateIndex);
    return { ...configured, ...target };
  });
  const nativeTargets = waveTargets.filter((target) => isNativeSubagentsOnly(state, target));
  const cliTargets = waveTargets.filter((target) => !nativeTargets.includes(target));
  const selectedTargets = cliTargets.map((target) => ({
    sourceKey: `${manifest.roundId}:${target.platform}:${target.candidateIndex}`,
    platform: target.platform, candidateIndex: target.candidateIndex,
  }));
  const sourceKeyOf = (target) => `${manifest.roundId}:${target.platform}:${target.candidateIndex}`;
  const earlyFallbacks = cliTargets
    .filter((target) => target.platform === state.invocation.orchestrator && target.model && target.effort)
    .map((target, index) => nativeLaunch(target, sourceKeyOf(target), manifest.promptPath, runFile(state, { round, provider: 'native', slot: index + 1, qualifier: 'early', kind: 'report', ext: 'md' })));
  // Resolution drops a native-subagents-only target unless the orchestrator shares its platform.
  const nativeLaunches = nativeTargets
    .map((target, index) => nativeLaunch(target, sourceKeyOf(target), manifest.promptPath, runFile(state, { round, provider: 'native', slot: index + 1, kind: 'report', ext: 'md' })));
  if (selectedTargets.length === 0 && nativeLaunches.length === 0) return done(state, 'failed', 'No selected target is available for this review wave.');
  const slotsPath = selectedTargets.length ? runFile(state, { round, kind: 'slots', ext: 'jsonl' }) : null;
  state.wave = {
    type,
    round,
    argv: manifest.dispatch ? [...manifest.dispatch.argv, '--level', state.level, '--slots-file', slotsPath] : null,
    outputPath: manifest.dispatch?.outputPath ?? null,
    promptPath: manifest.promptPath,
    slotsPath,
    earlyFallbacks,
    nativeLaunches,
    selectedTargets,
    retried: false,
    keys: rebuttal?.keys ?? null,
  };
  return launchAction(state);
}

function launchReplyAction(state, error) {
  const action = {
    ...state.pending,
    replyOnly: true,
    error: toError(error),
    guidance: ['The wave is complete; do not rerun argv. Correct only the earlyFallbacks reply and call --next again.'],
  };
  REEMITTED.add(action);
  return action;
}

function launchAction(state, error) {
  const early = state.wave.earlyFallbacks.length > 0;
  const native = (state.wave.nativeLaunches ?? []).length > 0;
  const guidance = early || native
    ? [
      ...(early ? ['Run argv as one background command. Once, run `node dispatch.mjs --slots <slotsPath>` after launch and inspect the failed slots it prints; do not poll again.']
        : state.wave.argv ? ['Run argv as one background command.'] : []),
      ...(native ? [`${state.wave.argv ? 'In the same tool-call round as argv, launch' : 'Launch'} every nativeLaunches entry as a read-only native subagent using descriptor.agentType, descriptor.model, and descriptor.reasoningEffort exactly; tell it to Read promptPath in full and follow it, and write its final reply verbatim to outputPath.`] : []),
      ...(early ? ['For every failed slot matching earlyFallbacks, immediately launch its native fallback in one parallel tool-call round while the wave continues.'] : []),
      'Return only successful non-empty captures with exact descriptor metadata. Omit an unproductive launch so ordinary post-wave fallback can retry it.',
      `After ${state.wave.argv ? 'the wave and ' : ''}launched subagents finish, call --next once with {"earlyFallbacks":[...]} covering ${[early && 'earlyFallbacks', native && 'nativeLaunches'].filter(Boolean).join(' and ')} (empty when none succeeded).`,
    ]
    : ['Run argv as one background command, wait for it to exit, then call --next with no --input.'];
  if (state.wave.type === 'rebuttal') {
    guidance.push('Delegates answer each key: CONFIRM accepts the rejection, REBUT keeps the finding live, INTENT-DISPUTE records a dispute.');
  }
  return emitAction(state, 'launch', {
    ...(state.wave.argv ? { argv: state.wave.argv } : {}),
    wave: { type: state.wave.type, round: state.wave.round },
    selectedTargets: state.wave.selectedTargets,
    ...(state.wave.slotsPath ? { slotsPath: state.wave.slotsPath } : {}),
    ...(state.wave.keys ? { keys: state.wave.keys } : {}),
    ...(state.wave.earlyFallbacks.length > 0 ? { earlyFallbacks: state.wave.earlyFallbacks } : {}),
    ...(state.wave.nativeLaunches?.length ? { nativeLaunches: state.wave.nativeLaunches } : {}),
    ...(error ? { error: toError(error) } : {}),
  }, guidance);
}

function onLaunch(state, reply) {
  // An all-native wave runs no CLI, so its envelope is empty by construction.
  let envelope = state.wave.argv ? null : { targets: [], failures: [] };
  if (state.wave.argv) try {
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
      return launchAction(state, new DriverError('state', 'The wave envelope is missing.', 'relaunch argv and wait for the process to exit before --next.'));
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
  const successSlots = new Set(envelope.targets.map((item) => item.sourceKey));
  const failedSlots = new Set((envelope.failures ?? []).map((item) => item.sourceKey));
  for (const target of state.wave.selectedTargets) {
    if (!successSlots.has(target.sourceKey) && !failedSlots.has(target.sourceKey) &&
      !envelope.targets.some((item) => item.substitutesFor === target.sourceKey)) {
      recordReviewFailure(state, target.sourceKey, 'missing-slot');
    }
  }
  const earlyBySlot = new Map((reply?.earlyFallbacks ?? []).map((fallback) => [fallback.slot, fallback]));
  const failuresBySlot = new Map((envelope.failures ?? []).map((failure) => [failure.sourceKey, failure]));
  const rejectedEarly = new Map();
  if (earlyBySlot.size !== (reply?.earlyFallbacks ?? []).length) return launchReplyAction(state, 'Early fallback slots must be unique.');
  for (const [slot, fallback] of earlyBySlot) {
    const planned = plannedLaunch(state, slot);
    // A native-subagents-only slot never ran its CLI, so it has no failure record to match.
    const isNative = (state.wave.nativeLaunches ?? []).includes(planned);
    if (!planned || (!isNative && !failuresBySlot.has(slot)) || fallback.outputPath !== planned.outputPath ||
      !fallback.actual || fallback.actual.agentType !== planned.descriptor.agentType || fallback.actual.reasoningEffort !== planned.descriptor.reasoningEffort) {
      return launchReplyAction(state, `Early fallback metadata or failed-slot identity does not match the descriptor for ${slot}.`);
    }
    const mapping = nativeMapping(planned.descriptor.model, fallback.actual.model, fallback.mapping, slot);
    if (mapping.error) return launchReplyAction(state, mapping.error);
    if (mapping.unavailable) {
      if (!state.wave.mappingWarnings?.includes(slot)) {
        (state.wave.mappingWarnings ??= []).push(slot);
        writeRunState(state);
        return launchReplyAction(state, `Unmapped native model for ${slot}; correct the capture or confirm its mapping to advance this slot.`);
      }
      rejectedEarly.set(slot, 'availability');
      recordAttempt(state, slot, planned.descriptor, fallback.actual.model, 'availability');
    }
    const text = fs.existsSync(fallback.outputPath) ? fs.readFileSync(fallback.outputPath, 'utf8') : '';
    fallback.text = text;
  }
  // Split early outcomes: a success is final; an empty capture is requeued exactly once below.
  const earlySucceeded = new Map([...earlyBySlot].filter(([slot, fallback]) => fallback.text.trim() && !rejectedEarly.has(slot)));
  const earlyFailed = [...earlyBySlot.keys()].filter((slot) => !earlySucceeded.has(slot));
  const unresolvedAll = (envelope.failures ?? []).filter((failure) =>
    !earlyBySlot.has(failure.sourceKey) && !failure.substitutesFor && !envelope.targets.some((record) => record.substitutesFor === failure.sourceKey));
  // Native fallback substitutes a same-platform subagent only; other platforms' failures are recorded
  // in run state (the resolution-log sourceMap has no failed status).
  const unresolved = unresolvedAll.filter((failure) => failure.platform === state.invocation.orchestrator);
  for (const failure of unresolvedAll) if (!unresolved.includes(failure))
    recordReviewFailure(state, failure.sourceKey, failure.failureKind ?? 'cross-platform');
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
  // An unavailable mapping consumes its native hop; an empty early capture retries normally.
  for (const sourceKey of earlyFailed) {
    const planned = plannedLaunch(state, sourceKey);
    const failure = failuresBySlot.get(sourceKey) ?? nativeFailure(planned);
    const earlyCapture = earlyBySlot.get(sourceKey);
    if (!earlyCapture.text.trim() && !rejectedEarly.has(sourceKey)) recordAttempt(state, sourceKey, planned.descriptor, earlyCapture.actual.model, 'empty-capture');
    const position = rejectedEarly.has(sourceKey) ? 1 : 0;
    if (position >= planned.descriptor.modelCascade.length) {
      recordReviewFailure(state, sourceKey, rejectedEarly.get(sourceKey));
    } else {
      state.collect.queue.push(cascadeSlot(state, failure, position));
    }
  }
  // A native-subagents-only slot omitted from the reply takes the ordinary post-wave fallback.
  for (const launch of state.wave.nativeLaunches ?? []) {
    if (!earlyBySlot.has(launch.slot)) state.collect.queue.push(cascadeSlot(state, nativeFailure(launch), 0));
  }
  for (const [sourceKey, fallback] of earlySucceeded) {
    const failure = (envelope.failures ?? []).find((candidate) => candidate.sourceKey === sourceKey);
    state.collect.sourceMap[sourceKey] = {
      provider: failure?.platform ?? state.invocation.orchestrator,
      candidateIndex: failure?.candidateIndex ?? Number(sourceKey.split(':').at(-1)),
      model: plannedLaunch(state, sourceKey).descriptor.model,
      launcherModel: fallback.actual.model,
      effort: fallback.actual.reasoningEffort,
      status: 'fallback',
      session: null,
      substitutesFor: null,
    };
  }
  for (const [sourceKey, fallback] of earlySucceeded) {
    recordAttempt(state, sourceKey, plannedLaunch(state, sourceKey).descriptor, fallback.actual.model, null);
  }
  return processCollected(state);
}

/** The early-fallback or native-subagents-only launch planned for `slot`. */
function plannedLaunch(state, slot) {
  return [...state.wave.earlyFallbacks, ...(state.wave.nativeLaunches ?? [])].find((candidate) => candidate.slot === slot);
}

/** A synthetic failure record that lets a native-subagents-only slot enter the fallback cascade. */
function nativeFailure(launch) {
  const [, platform, index] = launch.slot.split(':').slice(-3);
  return { sourceKey: launch.slot, platform, candidateIndex: Number(index) };
}

function recordAttempt(state, sourceKey, descriptor, launcherModel, kind) {
  (state.reviewAttempts ??= []).push({ wave: state.wave.type, round: state.wave.round, sourceKey,
    configuredModel: descriptor.model, launcherModel: launcherModel ?? null,
    cascadePosition: descriptor.cascadePosition, kind });
}

function nativeMapping(configuredModel, launcherModel, mapping, sourceKey) {
  if (launcherModel === configuredModel) return mapping ? { error: `Unexpected mapping for exact model ${sourceKey}.` } : {};
  const verified = NATIVE_MAPPINGS.find((entry) => entry.configuredModel === configuredModel);
  if (mapping && (mapping.configuredModel !== configuredModel || mapping.launcherModel !== launcherModel ||
    (verified && mapping.provider !== verified.provider))) return { error: `Native mapping metadata does not match ${sourceKey}.` };
  return verified?.launcherModel === launcherModel && mapping?.provider === verified.provider ? {} : { unavailable: true };
}

/** Resolves a failed slot's own model cascade from the policy target/reserve identified by
 * `(platform, candidateIndex)` — never from the batch failure record, whose `model` is null for
 * an array candidate. */
function cascadeSlot(state, failure, cascadePosition) {
  const match = [...state.policy.targets, ...state.policy.reserves]
    .find((candidate) => candidate.platform === failure.platform && candidate.candidateIndex === failure.candidateIndex);
  const models = match?.model ? (Array.isArray(match.model) ? match.model : [match.model])
    : (state.wave.type !== 'rebuttal' && failure.model ? [failure.model] : []);
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
    recordReviewFailure(state, slot.sourceKey, slot.models.length && slot.effort ? 'availability' : 'missing-configuration');
    return processCollected(state);
  }
  const outputPath = runFile(state, { round: state.wave.round, provider: 'native', slot: state.collect.fallbackTried.length + 1, qualifier: 'fallback', kind: 'report', ext: 'md' });
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
    'If the launcher cannot accept the configured model or effort, report availability for this hop; use only a verified registry mapping.',
    'Write its final reply verbatim to outputPath, then report the actual launch metadata with the captured reply, or a {kind, reason} failure.',
  ]);
}

function onNativeFallback(state, reply) {
  const current = state.collect.current;
  if (reply.slot !== current.sourceKey) return reemit(state, `slot must be ${current.sourceKey}.`);
  const expected = current.descriptor;
  if (reply.failed) {
    if (reply.actual || reply.mapping || reply.captured) return reemit(state, 'A failed hop must not claim successful launch metadata.');
    recordAttempt(state, current.sourceKey, expected, null, reply.failed.kind);
    // A failed hop advances to the next model in this candidate's own cascade; sibling candidates
    // are never substituted in. Exhaustion drops the slot and records it failed.
    return advanceFailedHop(state, current, reply.failed.kind);
  }
  const actual = reply.actual;
  if (!actual || actual.agentType !== expected.agentType || actual.reasoningEffort !== expected.reasoningEffort) {
    return reemit(state, `Native fallback launch metadata must match the descriptor exactly; expected ${JSON.stringify({ agentType: expected.agentType, model: expected.model, reasoningEffort: expected.reasoningEffort })}.`);
  }
  const mapping = nativeMapping(expected.model, actual.model, reply.mapping, current.sourceKey);
  if (mapping.error) return reemit(state, mapping.error);
  if (mapping.unavailable) {
    if (!current.mappingWarned) {
      state.collect.current.mappingWarned = true;
      writeRunState(state);
      return reemit(state, `Unmapped native model for ${current.sourceKey}; correct the metadata or confirm the mapping failure.`);
    }
    recordAttempt(state, current.sourceKey, expected, actual.model, 'availability');
    return advanceFailedHop(state, current, 'availability');
  }
  state.collect.queue.shift();
  state.collect.fallbackTried.push(current.sourceKey);
  const text = fs.existsSync(current.outputPath) ? fs.readFileSync(current.outputPath, 'utf8') : '';
  if (text.trim()) {
    recordAttempt(state, current.sourceKey, expected, actual.model, null);
    state.collect.reports.push({ sourceKey: current.sourceKey, text, fallback: true });
    state.collect.sourceMap[current.sourceKey] = {
      provider: current.platform,
      candidateIndex: current.candidateIndex,
      model: expected.model,
      launcherModel: actual.model,
      effort: actual.reasoningEffort,
      status: 'fallback',
      session: null,
      substitutesFor: expected.substitutesFor,
    };
  } else {
    recordAttempt(state, current.sourceKey, expected, actual.model, 'empty-capture');
    const nextPosition = current.cascadePosition + 1;
    if (nextPosition < current.models.length) {
      state.collect.queue.unshift({ ...current, cascadePosition: nextPosition, mappingWarned: false });
    } else {
      recordReviewFailure(state, current.sourceKey, 'empty-capture');
    }
  }
  return processCollected(state);
}

function advanceFailedHop(state, current, kind) {
  const nextPosition = current.cascadePosition + 1;
  if (nextPosition < current.models.length) {
    state.collect.queue[0] = { ...current, cascadePosition: nextPosition, mappingWarned: false };
  } else {
    state.collect.queue.shift();
    state.collect.fallbackTried.push(current.sourceKey);
    delete state.collect.sourceMap[current.sourceKey];
    recordReviewFailure(state, current.sourceKey, kind);
  }
  return processCollected(state);
}

function processCollected(state) {
  if (state.collect.queue.length > 0) return nativeFallbackAction(state);
  if (state.wave.type === 'rebuttal') {
    state.rebuttal.retried ??= [];
    state.rebuttal.pendingRetry ??= [];
    for (const report of [...state.collect.reports]) {
      try { parseRebuttal(state.kind, report.text, state.rebuttal.keys); }
      catch (err) {
        state.collect.reports = state.collect.reports.filter((item) => item !== report);
        delete state.collect.sourceMap[report.sourceKey];
        const [, , platform, candidateIndex] = report.sourceKey.split(':');
        const slot = `${platform}:${candidateIndex}`;
        if (!report.fallback && platform === state.invocation.orchestrator && !state.collect.fallbackTried.includes(report.sourceKey)) {
          state.collect.queue.push(cascadeSlot(state, { sourceKey: report.sourceKey, platform, candidateIndex: Number(candidateIndex) }, 0));
        } else if (!state.rebuttal.retried.includes(slot)) {
          state.rebuttal.retried.push(slot);
          state.rebuttal.pendingRetry.push({ platform, candidateIndex: Number(candidateIndex),
            error: String(err?.message ?? err).replace(/\s+/g, ' ').trim() || 'the report was not valid JSON' });
        } else recordReviewFailure(state, report.sourceKey, 'invalid-report', citedKeys(state, report.sourceKey));
      }
    }
    if (state.collect.queue.length) return nativeFallbackAction(state);
    if (state.rebuttal.pendingRetry.length) return prepareRebuttalRetry(state);
    return applyRebuttals(state);
  }
  const findings = [];
  const byContent = new Map();
  for (const report of [...state.collect.reports]) {
    let parsed;
    try {
      parsed = parseReport(state.kind, report.text);
    } catch (err) {
      if (err instanceof InvalidReviewReportError && err.prose) {
        const reportPath = runFile(state, { round: state.wave.round, qualifier: `prose-${findings.length + 1}`, kind: 'report', ext: 'md', contents: report.text });
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
        recordReviewFailure(state, report.sourceKey, report.fallback && !report.text.trim() ? 'empty-capture' : 'invalid-report');
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
    return done(state, 'failed', 'No delegate delivered a review in this wave.', { command: state.resumeCommand, unfulfilledTargets: unfulfilledTargets(state) });
  }
  state.adjudication = { round: state.wave.round, findings, sourceMap: state.collect.sourceMap, waveType: state.wave.type };
  if (findings.length === 0) {
    writeRound(state, []);
    return noticedNextStep(state);
  }
  return adjudicateAction(state);
}

function adjudicateAction(state) {
  const guidance = [
    'Verify each finding against the cited locus before ruling; accept verified defects regardless of how many delegates raised them.',
    'For accepted structured findings, omit defect text; the driver reuses the sanitized delegate defect. For accepted prose findings or an empty sanitized delegate defect, provide a host defect restatement. For rejected or downgraded findings, provide full defect reasoning and resolution.',
    'Use status needs-user only when the ruling needs a user decision.',
    `Every ruling locus must match ${reviewKind(state.kind).locusDescription}; cite the reviewed artifact, not supporting evidence. Tag is one of: ${[...reviewKind(state.kind).tags].join(', ')}.`,
  ];
  if (state.adjudication.findings.some((finding) => finding.restate)) {
    guidance.push('A restate entry is a prose report: read reportPath and return one ruling per finding it contains, with locus and tag in the review-kind format, keyed by the entry key; if it contains none, return {key, empty: true}.');
  }
  if (state.invocation.fix) guidance.push(`For accepted fixable findings include fix: {affectedPaths, dependsOn, verification}; affectedPaths are repository-relative slash paths; dependsOn lists this round's finding keys (F1) or earlier rounds' IDs (R1-F001); verification names the narrowest commands covering affectedPaths${state.invocation.implementation ? ', never an aggregate suite: driver gates re-verify' : ''}.`);
  guidance.push(replyGuidance(state, { round: state.adjudication.round, kind: 'rulings', ext: 'json' }));
  return emitAction(state, 'adjudicate', { round: state.adjudication.round, findings: state.adjudication.findings, unfulfilledTargets: unfulfilledTargets(state) }, guidance);
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
    if (!entry.tags.has(ruling.tag)) errors.push(`${ruling.key}: tag "${ruling.tag}" is not a ${entry.kind} review tag (${[...entry.tags].join(', ')})`);
    const delegateDefect = sanitizeReplyText(finding.defect);
    const hostDefect = sanitizeReplyText(ruling.defect);
    if (ruling.status === 'accepted' && (finding.restate || !delegateDefect) && !hostDefect) {
      errors.push(`${ruling.key}: an accepted prose or empty delegate finding needs a host defect restatement`);
    }
    rulings.push({ ...ruling, defect: ruling.status === 'accepted' ? (finding.restate || !delegateDefect ? hostDefect : delegateDefect) : ruling.defect, locus });
  }
  for (const key of findings.keys()) if (!ruled.has(key)) errors.push(`finding ${key} has no ruling`);
  if (state.invocation.fix) {
    for (const ruling of rulings) {
      if (ruling.status === 'accepted' && ruling.scope !== 'adjacent' && ruling.severity !== 'CONSIDER' && !ruling.fix?.affectedPaths?.length) {
        errors.push(`${ruling.key}: an accepted in-scope ${ruling.severity} under --fix needs fix.affectedPaths`);
      }
      const badPath = (ruling.fix?.affectedPaths ?? []).find((p) => !REPO_RELATIVE.test(p));
      if (badPath !== undefined) errors.push(`${ruling.key}: fix.affectedPaths entry "${badPath}" must be a repository-relative slash path`);
      // A command naming an absent test file can never pass; the fix itself may create it.
      for (const command of ruling.fix?.verification ?? []) {
        for (const file of missingVerificationFiles(state.repoRoot, command, ruling.fix.affectedPaths)) {
          errors.push(`${ruling.key}: verification "${command}" names missing test file ${file}`);
        }
      }
    }
  }
  if (errors.length) return reemit(state, errors.join('; '));
  const immediate = rulings.filter((ruling) => ruling.status === 'needs-user' && !isDeferredConsider(state, ruling));
  if (immediate.length) {
    state.rulings = rulings;
    return emitAction(state, 'ask-user', {
      question: 'rulings',
      unfulfilledTargets: unfulfilledTargets(state),
      text: 'These findings need your ruling: answer accepted or rejected for each key.',
      items: immediate.map((ruling) => ({
        key: ruling.key, severity: ruling.severity, locus: ruling.locus, defect: cleanText(ruling.defect, ruling.key),
      })),
    }, ['Relay the question; answer with {"answer": {"<key>": "accepted"|"rejected"}} or, to replace the resolution text, {"answer": {"<key>": {"verdict": "accepted"|"rejected", "resolution": "..."}}}.']);
  }
  writeRound(state, rulings);
  return noticedNextStep(state);
}

function isDeferredConsider(state, ruling) {
  return state.invocation.fix && ruling.status === 'needs-user' && ruling.scope === 'in-scope' &&
    ruling.severity === 'CONSIDER' && ruling.fix?.affectedPaths?.length > 0;
}

function statusLabel(state, ruling, userFinal) {
  if (ruling.status === 'accepted') return 'Accepted';
  if (isDeferredConsider(state, ruling)) return 'Pending User';
  const pending = state.policy.consensus && !userFinal && state.adjudication.waveType === 'review' &&
    ruling.scope === 'in-scope' && ruling.severity !== 'CONSIDER';
  return pending ? 'Rejected — Pending Confirmation' : 'Rejected / Downgraded';
}

function writeRound(state, rulings, userFinalKeys = new Set()) {
  const { round, findings, sourceMap } = state.adjudication;
  let markdown = readArtifactText(state);
  const first = Number(nextFindingId(markdown, round).split('-F')[1]);
  const byKey = new Map(findings.map((finding) => [finding.key, finding]));
  const lines = [`### Round ${round} — ${today()}`, ...formatSourceMapLine(validateSourceMap(sourceMap, round)).split('\n'), ...formatFailedTargetsLine(currentFailures(state), round).split('\n').filter(Boolean)];
  if (!rulings.length) lines.push('Clean — no findings.');
  // A repeat of an earlier same-round ruling (locus, tag, resolution, status) collapses to a pointer.
  const firstOf = new Map();
  const unfixable = [];
  const deferredUser = [];
  const unboundedConsider = [];
  const idOf = (index) => `R${round}-F${String(first + index).padStart(3, '0')}`;
  // IDs follow ruling order, so same-round dependencies arrive as finding keys and map here.
  const idByKey = new Map(rulings.map((ruling, index) => [ruling.key, idOf(index)]));
  const withIds = (fix) => fix && { ...fix, dependsOn: fix.dependsOn.map((dep) => idByKey.get(dep) ?? dep) };
  rulings.forEach((ruling, index) => {
    const id = idOf(index);
    ruling = { ...ruling, fix: withIds(ruling.fix) };
    const sources = byKey.get(ruling.key).sourceKeys.filter((key) => Object.hasOwn(sourceMap, key));
    const defect = cleanText(ruling.defect, 'Restated finding.');
    const resolution = cleanText(ruling.resolution, 'Ruled by the host.');
    const label = statusLabel(state, ruling, userFinalKeys.has(ruling.key));
    const same = [ruling.locus, ruling.tag, resolution, label].join('\0');
    const first = firstOf.get(same);
    if (!first) firstOf.set(same, id);
    lines.push(first
      ? `- **[${label}]** [${id}] [${ruling.severity}] [sources=${sources.join(',')}] [dup=${first}] ${escapeLogText(ruling.locus)} → see ${first}`
      : `- **[${label}]** [${id}] [${ruling.severity}] [sources=${sources.join(',')}] ${escapeLogText(ruling.locus)} — ${ruling.tag}: ${escapeLogText(defect)} → ${escapeLogText(resolution)}`);
    if (isDeferredConsider(state, ruling)) {
      deferredUser.push({ id, severity: ruling.severity, scope: ruling.scope, defect, fix: ruling.fix });
      return;
    }
    if (ruling.status !== 'accepted' || !state.invocation.fix) return;
    const tracked = { id, severity: ruling.severity, scope: ruling.scope, defect, fix: ruling.fix ?? null };
    if (ruling.scope === 'adjacent') state.adjacent.push(tracked);
    else if (ruling.fix?.affectedPaths?.length) state.fix.pending.push(tracked);
    else if (ruling.severity === 'CONSIDER') unboundedConsider.push(tracked);
    // User-accepted findings (needs-user, round cap) can arrive without fix details: defer, never drop.
    else unfixable.push({ ...tracked, fix: { affectedPaths: [locusPath(state, ruling.locus)], dependsOn: [], verification: [] } });
  });
  markdown = appendToSection(markdown, LOG_HEADING, '## Review Findings & Resolutions', lines, /^\*No reviews conducted yet\.\*\s*$/);
  writeArtifactText(state, markdown);
  // Mark queued work in the log itself, so a lost cache resumes exactly these fixes and no others.
  const queued = [...state.fix.pending, ...state.adjacent].filter((finding) => finding.fix?.affectedPaths?.length && !finding.recorded);
  writeApplicationRecords(state, queued, 'unapplied', PENDING_FIX_REASON);
  for (const finding of queued) finding.recorded = true;
  if (deferredUser.length) writeApplicationRecords(state, deferredUser, 'unapplied', 'awaiting deferred user ruling');
  if (unfixable.length) deferCluster(state, { findings: unfixable }, 'accepted without fix details; apply manually');
  if (unboundedConsider.length) addFollowUps(state, unboundedConsider.map((finding) => `- [${finding.id}] ${finding.defect} — accepted; no bounded fix was supplied.`));
}

// Code loci carry a path; design and plan loci are sections of the artifact itself.
function locusPath(state, locus) {
  const match = /^([^\s:§]+):L\d+/.exec(locus ?? '');
  return match ? match[1] : toSlash(path.relative(state.repoRoot, state.artifactPath));
}

/** Parses one ruling answer: a verdict string or {verdict, resolution?}; null when invalid. */
function parseRulingAnswer(value) {
  const object = value && typeof value === 'object';
  const verdict = String((object ? value.verdict : value) ?? '').toLowerCase();
  if (!['accepted', 'rejected', 'downgraded'].includes(verdict)) return null;
  if (object && value.resolution !== undefined && typeof value.resolution !== 'string') return null;
  return { verdict, resolution: object && value.resolution?.trim() ? value.resolution : null };
}

// Keeps the prior resolution as audit evidence and marks that the gate overruled it.
function appendOverruled(markdown, key, verdict) {
  const line = markdown.split(/\r?\n/).find((item) => item.includes(`[${key}]`) && item.includes(' → '));
  if (!line) return markdown;
  return setEntryResolution(markdown, key, `${line.split(' → ').slice(1).join(' → ')} (overruled at gate: ${verdict})`);
}

// An application record is its comment plus the derived line after it.
const APPLICATION_COMMENT = /^ {2}<!-- dispatch-application /;

function removeEntryApplication(markdown, key) {
  const lines = markdown.split('\n');
  const index = lines.findIndex((line) => /^\s*[-*]\s+\*\*\[/.test(line) && line.includes(`[${key}]`));
  if (index >= 0 && APPLICATION_COMMENT.test(lines[index + 1] ?? '')) lines.splice(index + 1, 2);
  return lines.join('\n');
}

function replaceEntryApplication(markdown, key, record) {
  const lines = markdown.split('\n');
  const index = lines.findIndex((line) => /^\s*[-*]\s+\*\*\[/.test(line) && line.includes(`[${key}]`));
  if (index < 0) return markdown;
  const hasRecord = APPLICATION_COMMENT.test(lines[index + 1] ?? '');
  lines.splice(index + 1, hasRecord ? 2 : 0, ...formatApplicationRecord(record).split('\n'));
  return lines.join('\n');
}

function askDeferredConsider(state, entries) {
  return emitAction(state, 'ask-user', {
    question: 'rulings',
    text: 'No further review wave is available. Rule each bounded in-scope CONSIDER finding accepted or rejected; accepted fixes will be applied and verified without another review wave.',
    items: entries.map((entry) => ({
      key: entry.key,
      severity: entry.severity,
      status: entry.status,
      line: entry.originalLine,
    })),
  }, ['Answer with {"answer": {"<key>": "accepted"|"rejected"}} or include a resolution: {"<key>": {"verdict": "accepted"|"rejected", "resolution": "..."}}.']);
}

function onDeferredConsider(state, reply) {
  const items = state.pending.items ?? [];
  const verdicts = new Map();
  const resolutions = new Map();
  for (const item of items) {
    const parsed = parseRulingAnswer(reply.answer && typeof reply.answer === 'object' ? reply.answer[item.key] : undefined);
    if (!parsed || parsed.verdict === 'downgraded') return reemit(state, `answer must rule ${item.key} as accepted or rejected.`);
    verdicts.set(item.key, parsed.verdict);
    if (parsed.resolution) resolutions.set(item.key, parsed.resolution);
  }
  let markdown = readArtifactText(state);
  const entries = scanResolutionLog(markdown, { strict: true }).rounds.flatMap((round) => round.entries);
  const accepted = [];
  for (const item of items) {
    const entry = entries.find((candidate) => candidate.key === item.key && candidate.status === 'pendingUser');
    if (!entry?.application) return reemit(state, `pending CONSIDER finding ${item.key} changed before its ruling was recorded.`);
    const verdict = verdicts.get(item.key);
    const label = verdict === 'accepted' ? 'Accepted' : 'Rejected / Downgraded';
    markdown = setEntryStatus(markdown, item.key, label);
    markdown = setEntryResolution(markdown, item.key, resolutions.get(item.key) ?? `${verdict} by user after review waves were exhausted`);
    if (verdict === 'accepted') {
      markdown = replaceEntryApplication(markdown, item.key, {
        ...entry.application,
        state: 'unapplied',
        reason: PENDING_FIX_REASON,
      });
      accepted.push({
        id: entry.id,
        severity: entry.severity,
        scope: entry.application.scope,
        // A dup entry's body is only a pointer; its defect lives on the first finding.
        defect: ENTRY_BODY.exec(((entry.duplicateOf && entries.find((candidate) => candidate.id === entry.duplicateOf)) || entry).originalLine)?.[1]?.trim() ?? entry.id,
        fix: {
          affectedPaths: entry.application.affectedPaths,
          dependsOn: entry.application.dependsOn,
          verification: entry.application.verification,
        },
      });
    } else {
      markdown = removeEntryApplication(markdown, item.key);
    }
  }
  writeArtifactText(state, markdown);
  if (accepted.length) {
    state.fix.pending.push(...accepted.map((finding) => ({ ...finding, recorded: true })));
    state.skipReviewForDeferredConsider = true;
  }
  return nextStep(state);
}

function onAskUser(state, reply) {
  const question = state.pending.question;
  if (question === 'rulings' && state.pending.items?.some((item) => item.status === 'pendingUser' && item.severity === 'CONSIDER')) {
    return onDeferredConsider(state, reply);
  }
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
    persistReviewBudget(state);
    return nextStep(state);
  }
  if (reply.stop === true && state.pending.options?.includes('stop')) {
    if (state.pending.items.length) {
      return emitAction(state, 'ask-user', {
        question: 'rulings',
        text: 'To stop, rule each unresolved finding accepted or rejected; one final verification wave follows.',
        items: state.pending.items,
      }, ['Answer with {"answer": {"<key>": "accepted"|"rejected"}} or, to replace the resolution text, {"answer": {"<key>": {"verdict": "accepted"|"rejected", "resolution": "..."}}}.']);
    }
    state.capAsked = true;
    return nextStep(state);
  }
  const answer = reply.answer;
  const keys = state.pending.items.map((item) => item.key);
  const verdicts = {};
  const resolutions = {};
  for (const key of keys) {
    const parsed = parseRulingAnswer(answer && typeof answer === 'object' ? answer[key] : undefined);
    if (!parsed) return reemit(state, `answer must rule ${key} as accepted or rejected, or {"verdict": ..., "resolution": "..."}.`);
    verdicts[key] = parsed.verdict;
    if (parsed.resolution) resolutions[key] = parsed.resolution;
  }
  if (state.rulings) {
    // needs-user rulings: the user's answer is final for those keys.
    const rulings = state.rulings.map((ruling) => (ruling.status === 'needs-user' && !isDeferredConsider(state, ruling)
      ? { ...ruling, status: verdicts[ruling.key], ...(resolutions[ruling.key] ? { resolution: resolutions[ruling.key] } : {}) }
      : ruling));
    state.rulings = null;
    writeRound(state, rulings, new Set(keys));
    return noticedNextStep(state);
  }
  // Round cap: rule unresolved entries, then run one final verification wave.
  let markdown = readArtifactText(state);
  const statuses = new Map(state.pending.items.map((item) => [item.key, item.status]));
  const accepted = [];
  for (const key of keys) {
    const label = verdicts[key] === 'accepted'
      ? (statuses.get(key) === 'disputed' ? 'Resolved dispute' : 'Accepted')
      : 'Rejected / Downgraded';
    const priorAccepted = ['accepted', 'resolvedDispute'].includes(statuses.get(key));
    if (resolutions[key]) markdown = setEntryResolution(markdown, key, resolutions[key]);
    else if (priorAccepted !== (verdicts[key] === 'accepted')) markdown = appendOverruled(markdown, key, verdicts[key]);
    markdown = setEntryStatus(markdown, key, label);
    if (verdicts[key] === 'accepted' && state.invocation.fix) accepted.push(key);
  }
  writeArtifactText(state, markdown);
  if (accepted.length) {
    const entries = scanResolutionLog(markdown, { strict: true }).rounds.flatMap((round) => round.entries);
    const findings = accepted.map((key) => {
      const entry = entries.find((item) => item.key === key);
      // A dup entry's body is only a pointer; its locus lives on the first finding.
      const origin = (entry.duplicateOf && entries.find((item) => item.id === entry.duplicateOf)) || entry;
      const locus = /\[sources=[^\]]*\]\s+(.+?)\s+—/.exec(origin.originalLine)?.[1] ?? '';
      const defect = /\s+—\s+[^:]+:\s+(.*?)\s+→/.exec(origin.originalLine)?.[1] ?? key;
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
  const packetPath = runFile(state, { round: logRounds, kind: 'rebuttal', ext: 'json', contents: `${JSON.stringify({
    schemaVersion: 1,
    sourceKey: 'rebuttal',
    canonicalLogHash: packets[0]?.packet.canonicalLogHash ?? null,
    findings: [...findings.values()],
  }, null, 2)}\n` });
  const targets = [];
  const seen = new Set();
  for (const group of packets) {
    const [, , platform, index] = group.sourceKey.split(':');
    const id = `${platform}:${index}`;
    if (seen.has(id) || !state.policy.targets.concat(state.policy.reserves).some((t) => t.platform === platform)) continue;
    seen.add(id);
    const configured = [...state.policy.targets, ...state.policy.reserves].find((t) => t.platform === platform && t.candidateIndex === Number(index));
    targets.push({ candidateId: `${state.phase}:${platform}:${index}`, platform, candidateIndex: Number(index),
      ...(configured?.model ? { model: configured.model } : {}), ...(configured?.effort ? { effort: configured.effort } : {}) });
  }
  state.rebuttalAt = logRounds;
  state.rebuttal = { keys, packetPath, citing: Object.fromEntries(unsettled.map((item) => [item.key, item.sourceKeys])) };
  if (targets.length === 0) return nextStep(state);
  return prepareWave(state, 'rebuttal', { reviewMode: 'rebuttal', targets, reserves: [], packetPath, keys });
}

// Relaunches every invalid rebuttal delegate once, holding the wave's valid reports until it returns.
function prepareRebuttalRetry(state) {
  const retries = state.rebuttal.pendingRetry.splice(0);
  state.rebuttal.held = [...(state.rebuttal.held ?? []), ...state.collect.reports];
  const configured = [...state.policy.targets, ...state.policy.reserves];
  const targets = retries.map(({ platform, candidateIndex }) => {
    const entry = configured.find((t) => t.platform === platform && t.candidateIndex === candidateIndex);
    return { candidateId: `${state.phase}:${platform}:${candidateIndex}`, platform, candidateIndex,
      ...(entry?.model ? { model: entry.model } : {}), ...(entry?.effort ? { effort: entry.effort } : {}) };
  });
  const errors = [...new Set(retries.map((retry) => retry.error))].join('; ');
  const retryNote = `Your previous report didn't parse because ${errors}; answer each key CONFIRM/REBUT/INTENT-DISPUTE.`;
  return prepareWave(state, 'rebuttal', { reviewMode: 'rebuttal', targets, reserves: [], packetPath: state.rebuttal.packetPath,
    keys: state.rebuttal.keys, retryNote });
}

function applyRebuttals(state) {
  const verdicts = new Map();
  const reports = [...(state.rebuttal.held ?? []), ...state.collect.reports];
  state.rebuttal.held = [];
  for (const report of reports) {
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
  if (currentFailures(state).length > 0) {
    const record = { wave: 'rebuttal', sourceRound: state.wave.round, findingKeys: state.rebuttal.keys,
      targets: currentFailures(state).map(({ sourceKey, kind }) => ({ sourceKey, kind })) };
    markdown = appendToSection(markdown, LOG_HEADING, '## Review Findings & Resolutions',
      [formatRebuttalFailuresLine(record)], /^\*No reviews conducted yet\.\*\s*$/);
  }
  writeArtifactText(state, markdown);
  return noticedNextStep(state);
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
  }, [extend ? 'Relay the question; answer with {"extend": true} or {"stop": true} (which asks for rulings when items remain).' : 'Relay the question; answer with {"answer": {"<key>": "accepted"|"rejected"}} or, to replace the resolution text, {"answer": {"<key>": {"verdict": "accepted"|"rejected", "resolution": "..."}}}.']);
}

/** Chooses the next action from the artifact log and run flags. */
function nextStep(state) {
  if (state.invocation.fix && state.fix.pending.length > 0) return applyFixesAction(state, state.fix.pending.splice(0));
  const markdown = readArtifactText(state);
  const consensus = evaluateConsensus(markdown);
  if (consensus.exit === 2) return done(state, 'failed', `The resolution log is invalid: ${consensus.error}`);
  const cap = state.policy.rounds;
  const scan = scanResolutionLog(markdown, { strict: true });
  const rounds = scan.rounds;
  const latest = rounds[rounds.length - 1];
  const recent = latest && (state.adjudication?.round === latest.number || (!state.adjudication && state.reviewWaves === latest.number)) ? latest.entries : [];
  const accepted = state.finalDone ? [] : recent.filter((item) =>
    (item.status === 'accepted' || item.status === 'resolvedDispute') && item.application?.state !== 'applied');
  const open = consensus.unsettledItems;
  const hasMust = [...accepted, ...open].some((item) => item.severity === 'MUST');
  const hasLiveMust = open.some((item) => item.severity === 'MUST');
  if (consensus.exit === 1) {
    const hasPending = open.some((item) => item.status === 'pendingConfirmation');
    if (!state.finalDone && state.policy.consensus && hasPending && state.rebuttalAt !== rounds.length) return prepareRebuttal(state, markdown, rounds.length);
  }
  if (state.capAsked && !state.finalDone) {
    const pendingUser = rounds.flatMap((round) => round.entries.filter((entry) => entry.status === 'pendingUser'));
    if (pendingUser.length) return askDeferredConsider(state, pendingUser);
    return prepareWave(state, 'final');
  }
  const changed = state.changed && !state.skipReviewForDeferredConsider;
  if (state.skipReviewForDeferredConsider) {
    state.changed = false;
    state.skipReviewForDeferredConsider = false;
  }
  if (!state.finalDone && changed && state.reviewWaves < (state.roundLimit ?? cap)) {
    state.changed = false;
    return prepareWave(state, 'review');
  }
  if (!state.finalDone && hasMust && state.reviewWaves < (state.roundLimit ?? cap)) return prepareWave(state, 'review');
  if (!state.finalDone && hasLiveMust && state.reviewWaves >= (state.roundLimit ?? cap)) {
    return askCap(state, open, true, accepted.filter((item) => !open.some((entry) => entry.key === item.key)));
  }
  if (consensus.exit === 1) {
    // Unresolved rebuttals and disputes require a host ruling, not a silent status rewrite.
    return askCap(state, open, false);
  }
  const pendingUser = rounds.flatMap((round) => round.entries.filter((entry) => entry.status === 'pendingUser'));
  if (pendingUser.length) return askDeferredConsider(state, pendingUser);
  if (state.invocation.fix && !state.optInOffered && state.adjacent.length > 0) return optInAction(state);
  return state.invocation.implementation ? settle(state) : checkpoint(state);
}

// SECTION: fixes

const NARROWEST_CHECK = 'Run at most the narrowest check for the touched locus; the driver runs the gates.';
const CLUSTER_REPLY = 'Reply {clusters: [{clusterId, status: "applied" | "failed", note}]}; note is required when failed.';

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
    'Edit inline (no subagent) to resolve each cluster, touching only its affectedPaths.',
    CLUSTER_REPLY,
    NARROWEST_CHECK,
  ]);
}

function reapplyAction(state) {
  return emitAction(state, 'apply-fixes', {
    clusters: state.fix.active.map(({ clusterId, findingIds, affectedPaths, verification }) => ({ clusterId, findingIds, affectedPaths, verification })),
  }, ['Verification failed for these clusters; fix them again.', CLUSTER_REPLY, NARROWEST_CHECK]);
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
    // Design and plan verify with the in-process lint: no host command runs (AC1).
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
    // A host-reported apply failure recurs with varying notes, so its second occurrence escalates.
    const repeatedApply = cluster.applyFailure && state.fix.attempts[cluster.clusterId]?.startsWith('apply failed:');
    if (state.fix.attempts[cluster.clusterId] === failure || repeatedApply || count >= MAX_VERIFY_FAILURES) {
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
    const hasRecord = APPLICATION_COMMENT.test(lines[index + 1] ?? '');
    lines.splice(index + 1, hasRecord ? 2 : 0, ...record.split('\n'));
  }
  markdown = lines.join('\n');
  if (applicationState === 'applied') markdown = withFixNotes(markdown, findings);
  writeArtifactText(state, markdown);
}

/** Appends `fixes <IDs>` to the walkthrough's Changes Made notes for fix-touched paths, adding rows for new paths. */
export function withFixNotes(markdown, findings) {
  const body = sectionBody(markdown, 'Changes Made');
  if (!body) return markdown;
  const ids = new Map();
  // Session artifacts are not production changes; renderChanges excludes them too.
  for (const finding of findings) for (const file of finding.fix.affectedPaths.filter((item) => !/^\.scratch(?:\/|$)/.test(item))) ids.set(file, [...(ids.get(file) ?? []), finding.id]);
  const entries = parseChangesMade(body).map(({ tag, path: file, note }) => ({ tag, path: file, note }));
  for (const [file, found] of ids) {
    const entry = entries.find((item) => item.path === file) ?? entries[entries.push({ tag: 'MODIFY', path: file, note: '' }) - 1];
    entry.note = withFixes(entry.note, found);
  }
  return replaceSection(markdown, 'Changes Made', renderChangesMade(entries));
}

function addFollowUps(state, bullets) {
  if (bullets.length === 0) return;
  // A walkthrough merges follow-ups with deviations; plans and designs keep their own Follow-ups section.
  const walkthrough = /\.walkthrough\.md$/.test(state.artifactPath);
  const lines = walkthrough ? bullets.map((bullet) => bullet.replace(/^- /, '- Follow-up: ')) : bullets;
  const markdown = walkthrough
    ? appendToSection(readArtifactText(state), DEVIATIONS_FOLLOW_UPS, '## Deviations & Follow-ups', lines.map(escapeLogText), /^None\.?$/)
    : appendToSection(readArtifactText(state), /^##\s+Follow-ups\s*$/, '## Follow-ups', lines.map(escapeLogText), /^None\.?$/);
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
    if (chosen.has(finding.id) && finding.fix?.affectedPaths?.length) {
      state.fix.pending.push(finding);
    } else if (chosen.has(finding.id)) {
      deferred.push(`- [${finding.id}] ${finding.defect} — adjacent; selected without a bounded fix.`);
    } else {
      declined.push(finding);
      deferred.push(`- [${finding.id}] ${finding.defect} — adjacent; not selected for this run.`);
    }
  }
  // Clear the pending marker so a resumed run never re-offers a declined item.
  writeApplicationRecords(state, declined.filter((finding) => finding.fix?.affectedPaths?.length), 'unapplied', 'adjacent; declined in opt-in');
  addFollowUps(state, deferred);
  // The offer is settled; later rounds must not re-queue these items.
  state.adjacent = [];
  return nextStep(state);
}

// SECTION: checkpoint

/** An implementation code review defers its checkpoint until the implement driver's final gate renders evidence. */
function settle(state) {
  const preview = prepareReview(state.kind, { action: 'checkpoint-preview', invocationContext: state.invocationContext }, { repoRoot: state.repoRoot });
  if (preview.settlement.consensusExit !== 0) return done(state, 'failed', 'Consensus did not settle before checkpoint.');
  return done(state, 'complete', 'Review settled; checkpoint deferred to the final verification gate.', { checkpointed: false });
}

/** Records the deferred checkpoint of a settled implementation code review. */
export function writeCheckpoint(state) {
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
    return done(state, 'complete', `Review settled and checkpointed (${result.artifactPath}).`, { checkpointed: true });
  } catch (err) {
    // Drift restarts preparation once; the driver never forces a stale checkpoint.
    if (!state.driftRestarted) {
      state.driftRestarted = true;
      state.invocationContext = null;
      if (state.reviewWaves >= (state.roundLimit ?? state.policy.rounds)) {
        return done(state, 'failed', `Checkpoint drift exhausted the ${state.roundLimit}-wave review budget.`, { command: state.resumeCommand });
      }
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
