/**
 * Standalone review phase (`--run review`): a state machine over the closed action set. It reuses
 * the review modules in-process (preparation, parsing, source maps, rebuttal packets, consensus,
 * clustering, checkpoint); the agent only verifies, rules, edits under `--fix`, and asks the user.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRebuttalPackets } from '../build-rebuttal-packets.mjs';
import { evaluateConsensus } from '../check-consensus.mjs';
import { LEVELS, loadDispatchConfig, resolveLevelScalar } from '../config.mjs';
import { createIndependenceClusters, formatOptInSections, parseOptInResponse } from '../fix-clustering.mjs';
import { parseRebuttal, parseReport } from '../parse-report.mjs';
import { prepareReview } from '../prepare-review.mjs';
import { getCurrentBranch, resolveArtifacts, resolveSlug } from '../resolve-artifact-paths.mjs';
import { formatApplicationRecord, nextFindingId, scanResolutionLog, validateSourceMap } from '../resolution-log.mjs';
import { defaultLiveness, probeCandidates, resolveFlow } from '../resolve-flow.mjs';
import { resolveExplicitRange } from '../resolve-review-range.mjs';
import { InvalidReviewReportError, normalizeLocus } from '../review-report.mjs';
import { reviewKind } from '../review-kinds.mjs';
import { formatSourceMapLine } from '../source-map.mjs';
import { safeRenameSync } from '../common.mjs';
import { NATIVE_AGENT_TYPES, emitAction, sanitizeReplyText } from './actions.mjs';
import {
  PENDING_FIX_REASON, REEMITTED, createRunState, finish, gitRoot, reemit, pruneFinishedStates, rebuildFromArtifact, runFile, unappliedFixesFromArtifact, writeRunSidecar, writeRunState,
} from './state.mjs';

const DISPATCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// SECTION: kind and level

/** Review kind inference, design order 1–6. */
export function inferReviewKind(argument, { cwd = process.cwd() } = {}) {
  if (!argument) return { kind: 'code', range: null };
  const normalized = String(argument).replace(/\\/g, '/');
  if (/-design\.md$/i.test(normalized)) return { kind: 'design', artifactPath: argument };
  if (/-walkthrough\.md$/i.test(normalized)) return { kind: 'code', walkthroughPath: argument };
  if (/\.md$/i.test(normalized)) return { kind: 'plan', artifactPath: argument };
  try {
    resolveExplicitRange(gitRoot(cwd), argument);
    return { kind: 'code', range: argument };
  } catch {
    throw new Error(
      `Cannot review "${argument}": pass a plan (*.md), design (*-design.md), or walkthrough (*-walkthrough.md) path, ` +
      'a Git revision or range, or no argument for uncommitted changes.',
    );
  }
}

function phaseEnabled(policy, level) {
  const rounds = resolveLevelScalar(policy.rounds, level) ?? 0;
  const targets = resolveLevelScalar(policy.targets, level);
  return rounds > 0 && targets !== 0;
}

/**
 * Applies the raise rule: `classified`/`default` levels rise to the lowest level enabling the
 * `<kind>-review` phase; an explicit level is honored and may skip it.
 */
export function resolveReviewLevel({ config, kind, level = 'medium', levelSource = 'default' }) {
  const phase = `${kind}-review`;
  const policy = config?.phases?.[phase];
  const base = { level, levelSource, raised: false, skipped: null, phase, configured: true };
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return { ...base, configured: false };
  const enabled = LEVELS.filter((candidate) => phaseEnabled(policy, candidate));
  if (enabled.length === 0) {
    return { ...base, skipped: { reason: `phases['${phase}'] disables ${phase} at every level (rounds or targets is 0).` } };
  }
  if (enabled.includes(level)) return base;
  if (levelSource === 'explicit') {
    return { ...base, skipped: { reason: `${phase} is disabled at explicit level "${level}" by phases['${phase}'] (rounds or targets is 0).` } };
  }
  const index = LEVELS.indexOf(level);
  const raisedTo = enabled.find((candidate) => LEVELS.indexOf(candidate) > index);
  // Never demote a classified level: with no enabled level above it, skip with a reason.
  if (!raisedTo) {
    return { ...base, skipped: { reason: `${phase} is disabled at "${level}" and every higher level by phases['${phase}'].` } };
  }
  return { ...base, level: raisedTo, raised: true };
}

// SECTION: helpers

const today = () => new Date().toISOString().slice(0, 10);
const toSlash = (value) => value.split(path.sep).join('/');

function readArtifactText(state) {
  return fs.readFileSync(state.artifactPath, 'utf8');
}

function writeArtifactText(state, text) {
  // Atomic like review-preparation.mjs: a crash mid-write must not corrupt the canonical artifact.
  const temp = `${state.artifactPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, text);
  try {
    safeRenameSync(temp, state.artifactPath);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function section(lines, heading) {
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  let end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  if (end === -1) end = lines.length;
  return { start, end };
}

/** Appends `block` lines at the end of an H2 section, creating it at the end when absent. */
function appendToSection(markdown, heading, title, block, placeholder) {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let range = section(lines, heading);
  if (!range) {
    while (lines.length && lines.at(-1) === '') lines.pop();
    lines.push('', title, '');
    range = { start: lines.length - 2, end: lines.length };
  }
  const body = lines.slice(range.start + 1, range.end).filter((line) => !placeholder.test(line));
  while (body.length && body.at(-1).trim() === '') body.pop();
  const next = [...lines.slice(0, range.start + 1), ...body, ...(body.length ? [''] : []), ...block, ...(range.end < lines.length ? [''] : []), ...lines.slice(range.end)];
  let text = next.join('\n');
  if (!text.endsWith('\n')) text += '\n';
  return eol === '\n' ? text : text.replace(/\n/g, eol);
}

// Mirrors resolution-log.mjs application-record path rules: no absolute, drive, `..`, `./`, `//`, or backslash.
const REPO_RELATIVE = /^(?!\/)(?![A-Za-z]:)(?!\.\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[\x00-\x1f\x7f\\]).+$/;

const LOG_HEADING = /^##\s+Review Findings & Resolutions\b/;
const FOLLOW_UPS = /^##\s+Follow-ups\s*$/;

function setEntryStatus(markdown, id, label) {
  const escaped = id.replace(/[-]/g, '\\-');
  return markdown.replace(new RegExp(`^(\\s*[-*]\\s+\\*\\*\\[)[^\\]]+(\\]\\*\\*\\s+\\[${escaped}\\])`, 'm'), `$1${label}$2`);
}

function cleanText(text, fallback) {
  const clean = sanitizeReplyText(text);
  return clean || fallback;
}

// SECTION: entry points

/** Starts `--run review`; returns the first action. */
export async function startReview({ invocation, cwd, resumeCommand, transient = false }) {
  const repoRoot = gitRoot(cwd);
  const inferred = invocation.kind
    ? { kind: invocation.kind, ...(invocation.argument ? kindTarget(invocation.kind, invocation.argument) : {}) }
    : inferReviewKind(invocation.argument, { cwd });
  const kind = inferred.kind;
  const { config } = loadDispatchConfig({ skillRoot: DISPATCH_DIR });
  const levelInfo = resolveReviewLevel({ config, kind, level: invocation.level, levelSource: invocation.levelSource });
  const normalized = { ...invocation, kind };
  const state = createRunState({
    invocation: normalized,
    transient,
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
  state.artifactPath ??= existingWalkthrough(state);
  if (transient) return finish(state, prepareWave(state, 'review'));
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
  const effective = levelInfo.configured
    ? config
    : { ...config, phases: { ...(config.phases ?? {}), [phase]: { rounds: { low: 1 }, targets: { low: 1 }, consensus: { low: false } } } };
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
    }, ['Answer with {"summary": "...", "verification": {"command": "...", "result": "..."}}.']);
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
  if (state.transient) {
    fs.appendFileSync(manifest.promptPath, '\nBounded pre-production RED review: inspect only the changed tests and the RED matrix table under the walkthrough Verification & Validation section. Verify criterion coverage, negative assertions, test isolation, attribution to missing production behavior, and interruption/recovery coverage. Report raw claims; do not implement or certify production code.\n');
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
    'Launch the named read-only native agent using descriptor.agentType, descriptor.model, and descriptor.reasoningEffort exactly; never use launcher defaults.',
    'Tell the native agent: Read promptPath in full and follow it as the authoritative instructions.',
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
    if (state.transient) return done(state, 'complete', 'Bounded read review delivered no findings.');
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
    guidance.push('A restate entry is a prose report: read reportPath and return one ruling per finding it contains, with locus and tag in the review-kind format, keyed by the entry key.');
  }
  if (state.invocation.fix) guidance.push('For accepted fixable findings include fix: {affectedPaths, dependsOn, verification}.');
  return emitAction(state, 'adjudicate', { round: state.adjudication.round, findings: state.adjudication.findings }, guidance);
}

// SECTION: adjudication

function onAdjudicate(state, reply) {
  const entry = reviewKind(state.kind);
  const findings = new Map(state.adjudication.findings.map((finding) => [finding.key, finding]));
  const ruled = new Set();
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
  if (state.transient) {
    // An accepted CONSIDER is advice for the production writer, never a RED-gate blocker.
    const accepted = rulings.filter(ruling => ruling.status === 'accepted');
    const blocking = rulings.filter(ruling => ruling.status !== 'rejected' && !(ruling.status === 'accepted' && ruling.severity === 'CONSIDER'));
    // Only fully accepted findings are repairable test defects; unresolved ones stay terminal.
    const carried = accepted.length && blocking.every(ruling => ruling.status === 'accepted')
      ? { defects: accepted.map(ruling => ({ key: ruling.key, severity: ruling.severity, tag: ruling.tag, locus: ruling.locus, defect: cleanText(ruling.defect, ruling.key) })) } : {};
    return done(state, blocking.length ? 'refused' : 'complete', blocking.length ? 'Bounded test review has verified or unresolved findings.' : accepted.length ? 'Bounded test review accepted advisory findings only.' : 'Bounded test review claims were verified and rejected.', carried);
  }
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
  // Round cap: the user rules every live item, then one final verification wave runs.
  let markdown = readArtifactText(state);
  const statuses = new Map(evaluateConsensus(markdown).unsettledItems.map((item) => [item.key, item.status]));
  for (const key of keys) {
    const label = verdicts[key] === 'accepted'
      ? (statuses.get(key) === 'disputed' ? 'Resolved dispute' : 'Accepted')
      : 'Rejected / Downgraded';
    markdown = setEntryStatus(markdown, key, label);
  }
  writeArtifactText(state, markdown);
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
  if (targets.length === 0) return askCap(state, markdown);
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

function askCap(state, markdown) {
  const items = evaluateConsensus(markdown).unsettledItems.map((item) => ({
    key: item.key, severity: item.severity, status: item.status, line: item.originalLine,
  }));
  return emitAction(state, 'ask-user', {
    question: 'rulings',
    text: 'The review reached its round cap with live findings. Rule each key accepted or rejected; one final verification wave follows.',
    items,
  }, ['Relay the question; answer with {"answer": {"<key>": "accepted"|"rejected"}}.']);
}

/** Chooses the next action from the artifact log and run flags. */
function nextStep(state) {
  if (state.invocation.fix && state.fix.pending.length > 0) return applyFixesAction(state, state.fix.pending.splice(0));
  const markdown = readArtifactText(state);
  const consensus = evaluateConsensus(markdown);
  if (consensus.exit === 2) return done(state, 'failed', `The resolution log is invalid: ${consensus.error}`);
  const cap = state.policy.rounds;
  if (consensus.exit === 1) {
    const logRounds = scanResolutionLog(markdown, { strict: true }).rounds.length;
    const hasPending = consensus.unsettledItems.some((item) => item.status === 'pendingConfirmation');
    if (state.policy.consensus && hasPending && state.rebuttalAt !== logRounds) return prepareRebuttal(state, markdown, logRounds);
    if (state.reviewWaves < cap) return prepareWave(state, 'review');
    return askCap(state, markdown);
  }
  if (state.capAsked && !state.finalDone) return prepareWave(state, 'final');
  if (state.changed && state.reviewWaves < cap) {
    state.changed = false;
    return prepareWave(state, 'review');
  }
  if (state.invocation.fix && !state.optInOffered && state.adjacent.length > 0) return optInAction(state);
  return checkpoint(state);
}

// SECTION: fixes

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
  ]);
}

function reapplyAction(state) {
  return emitAction(state, 'apply-fixes', {
    clusters: state.fix.active.map(({ clusterId, findingIds, affectedPaths, verification }) => ({ clusterId, findingIds, affectedPaths, verification })),
  }, ['Verification failed for these clusters; fix them again and reply with each cluster status.']);
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
  const commands = [...new Set(state.fix.active.filter((c) => !c.applyFailure).flatMap((c) => c.verification))];
  if (commands.length === 0) return settleVerification(state, () => null);
  state.fix.commands = commands;
  return emitAction(state, 'verify', { commands }, ['Run each command from the repository root; reply with its exit code and concise evidence.']);
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
  }, ['Relay the list; answer with the user\'s choice text (for example "include O1", "all", or "none").']);
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
  if (state.fix.pending.length) state.reviewWaves = 0;
  return nextStep(state);
}

// SECTION: checkpoint

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
      state.reviewWaves = Math.min(state.reviewWaves, Math.max(0, state.policy.rounds - 1));
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
