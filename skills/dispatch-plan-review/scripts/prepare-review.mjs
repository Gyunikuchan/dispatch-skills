#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule } from '../../dispatch/scripts/common.mjs';
import { extractTemplate, fillTemplate } from '../../dispatch/scripts/fill-template.mjs';
import {
  getCurrentBranch,
  resolveArtifacts,
  resolveSlug,
} from '../../dispatch/scripts/resolve-artifact-paths.mjs';
import { evaluateConsensus } from '../../dispatch/scripts/check-consensus.mjs';
import { scanResolutionLog } from '../../dispatch/scripts/resolution-log.mjs';
import {
  advanceInvocationState,
  assertObjectKeys,
  assertPreparationIntegrity,
  checkpointDriftRemedy,
  completeInvocationState,
  createDispatchFiles,
  createInvocationState,
  createReviewView,
  FIELD_HINTS,
  readArtifact,
  readInvocationState,
  readJsonRequest,
  requireNode22,
  semanticSectionHashes,
  settledWritesMismatch,
  writeArtifactMetadata,
} from '../../dispatch/scripts/review-preparation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, '..');
const DISPATCH_DIR = path.resolve(__dirname, '../../dispatch');
const CHECKPOINT_KEYS = ['action', 'invocationContext', 'settlement', 'settledWrites'];
const PREVIEW_KEYS = ['action', 'invocationContext'];
const REQUEST_KEYS = [
  'action', 'mode', 'reviewMode', 'artifactPath', 'slug', 'date', 'orchestrator',
  'orchestratorModel', 'requirement', 'focus', 'trailingText', 'reviewScope',
  'toolTurnBudget', 'targets', 'reserves', 'roundId', 'consensus',
  'findingPacketPath', 'findingKeys', 'selector', 'decision', 'artifactOwned',
  'invocationContext', 'settlement', 'settledWrites',
];

function toManifestPath(file, repoRoot) {
  const relative = path.relative(repoRoot, file);
  return !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : file.split(path.sep).join('/');
}

function slugFromPath(file) {
  const match = /(?:^|\/)\d{4}-\d{2}-\d{2}-(.+?)(?:-walkthrough)?\.md$/.exec(file.replace(/\\/g, '/'));
  return match?.[1] ?? null;
}

export function planSnapshot(source) {
  return semanticSectionHashes(source);
}

function changedKeys(previous = {}, current = {}) {
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter((key) => previous[key] !== current[key])
    .sort();
}

function parseRound(roundId, scan) {
  const expected = (scan.rounds.at(-1)?.number ?? 0) + 1;
  if (!roundId) return { roundId: `plan-review:R${expected}`, round: expected };
  const match = /^plan-review:R([1-9]\d*)$/.exec(roundId);
  if (!match || Number(match[1]) !== expected) {
    throw new Error(`roundId must be plan-review:R${expected}.`);
  }
  return { roundId, round: expected };
}

function sourceKeys(roundId, targets = []) {
  return targets.map((target) => {
    if (!target?.candidateId) throw new Error('Every target requires candidateId.');
    const [, platform, index] = target.candidateId.split(':');
    return `${roundId}:${platform}:${index}`;
  });
}

function validateRequest(request) {
  assertObjectKeys(request, REQUEST_KEYS, 'plan review request', FIELD_HINTS);
  const action = request.action ?? 'prepare';
  if (!['prepare', 'checkpoint', 'checkpoint-preview'].includes(action)) {
    throw new Error('action must be "prepare", "checkpoint", or "checkpoint-preview".');
  }
  if (action === 'checkpoint-preview') {
    for (const key of Object.keys(request)) {
      if (!PREVIEW_KEYS.includes(key)) {
        throw new Error(`checkpoint-preview request contains inapplicable field "${key}"; allowed: ${PREVIEW_KEYS.join(', ')}.`);
      }
    }
    if (!request.invocationContext) throw new Error('checkpoint-preview requires invocationContext.');
    return action;
  }
  if (request.mode !== undefined && !['standalone', 'orchestrated'].includes(request.mode)) {
    throw new Error('mode must be "standalone" or "orchestrated".');
  }
  if (request.reviewMode !== undefined && !['full', 'rebuttal'].includes(request.reviewMode)) {
    throw new Error('reviewMode must be "full" or "rebuttal".');
  }
  if (request.decision !== undefined && !['overwrite', 'as-is', 'fresh-slug'].includes(request.decision)) {
    throw new Error('decision must be overwrite, as-is, or fresh-slug.');
  }
  if (action === 'checkpoint') {
    for (const key of Object.keys(request)) {
      if (!CHECKPOINT_KEYS.includes(key)) {
        throw new Error(`checkpoint request contains inapplicable field "${key}"; allowed: ${CHECKPOINT_KEYS.join(', ')}.`);
      }
    }
  } else if (request.settlement !== undefined || request.settledWrites !== undefined) {
    throw new Error('prepare request cannot contain settlement or settledWrites.');
  }
  if (request.consensus !== undefined && typeof request.consensus !== 'boolean') throw new Error('consensus must be boolean.');
  validateSelector(request.selector);
  if ((request.action ?? 'prepare') === 'checkpoint') {
    assertObjectKeys(request.settledWrites, ['sections'], 'settledWrites');
    if (!Array.isArray(request.settledWrites.sections) || request.settledWrites.sections.some((value) => typeof value !== 'string')) {
      throw new Error('settledWrites.sections must be an array of strings.');
    }
  }
  // Batches need an initialized run directory that only orchestrators own.
  if (action === 'prepare' && request.mode !== 'orchestrated' && (request.targets !== undefined || request.reserves !== undefined)) {
    throw new Error('standalone requests cannot carry targets or reserves; prepare once per `dispatch.mjs --list-targets` entry with selector {provider: entry.platform, candidateIndex: entry.candidateIndex}.');
  }
  if (action === 'prepare' && request.mode === 'orchestrated' && request.selector !== undefined) {
    throw new Error('orchestrated requests select sources through targets, not selector.');
  }
  if (request.targets !== undefined) validateTargets(request.targets, request.roundId, 'targets');
  if (request.reserves !== undefined) validateTargets(request.reserves, request.roundId, 'reserves');
  validateCombinedEntries(request.targets ?? [], request.reserves ?? []);
  if (action === 'prepare' && request.mode === 'orchestrated' && request.targets?.length === 0) {
    throw new Error('orchestrated mode requires targets.');
  }

  function validateCombinedEntries(targets, reserves) {
    const sources = new Set();
    for (const entry of [...targets, ...reserves]) {
      const source = `${entry.platform}:${entry.candidateId.split(':')[2]}`;
      if (sources.has(source)) throw new Error('targets and reserves must have unique sources.');
      sources.add(source);
    }
  }
  return action;
}

function validateSelector(selector) {
  if (selector === undefined) return;
  assertObjectKeys(selector, ['provider', 'candidateIndex', 'model', 'effort'], 'selector');
  if (typeof selector.provider !== 'string' || !selector.provider) throw new Error('selector.provider is required.');
  const byIndex = Number.isSafeInteger(selector.candidateIndex) && selector.candidateIndex >= 0;
  const byOverride = (typeof selector.model === 'string' && selector.model.length > 0) ||
    (typeof selector.effort === 'string' && selector.effort.length > 0);
  if (byIndex === byOverride) throw new Error('selector requires candidateIndex or model/effort.');
}

function validateTargets(entries, roundId, label) {
  if (!Array.isArray(entries)) throw new Error(`${label} must be an array.`);
  const sources = new Set();
  for (const [index, entry] of entries.entries()) {
    assertObjectKeys(entry, ['roundId', 'candidateId', 'platform', 'candidateIndex', 'model', 'effort'], `${label}[${index}]`);
    // roundId is optional per entry — it is implied by the request's (resolved) round; when
    // present it must still look right and, if the request pins a roundId, agree with it.
    if (entry.roundId !== undefined) {
      if (!/^plan-review:R[1-9]\d*$/.test(entry.roundId)) throw new Error(`${label}[${index}].roundId is invalid.`);
      if (roundId !== undefined && entry.roundId !== roundId) throw new Error(`${label}[${index}].roundId is invalid.`);
    }
    if (!/^plan-review:[a-z][a-z0-9-]*:\d+$/.test(entry.candidateId ?? '')) throw new Error(`${label}[${index}].candidateId is invalid.`);
    if (entry.candidateId.split(':')[1] !== entry.platform) throw new Error(`${label}[${index}] platform does not match candidateId.`);
    const candidateIndex = Number(entry.candidateId.split(':')[2]);
    const byIndex = Number.isSafeInteger(entry.candidateIndex) && entry.candidateIndex >= 0;
    if (byIndex && entry.candidateIndex !== candidateIndex) throw new Error(`${label}[${index}].candidateIndex does not match candidateId.`);
    const byOverride = (typeof entry.model === 'string' && entry.model.length > 0) ||
      (typeof entry.effort === 'string' && entry.effort.length > 0);
    if (byIndex === byOverride) throw new Error(`${label}[${index}] requires candidateIndex or model/effort.`);
    // Keyed on platform:candidateIndex, not roundId — the round is fixed per request, so a
    // per-entry roundId (present or not) carries no extra information for duplicate detection.
    const source = `${entry.platform}:${candidateIndex}`;
    if (sources.has(source)) throw new Error(`${label} contains duplicate source ${source}.`);
    sources.add(source);
  }
}

function resolvePlan(request, repoRoot) {
  if (request.artifactPath) {
    const absolute = path.resolve(repoRoot, request.artifactPath);
    return {
      slug: request.slug ?? slugFromPath(absolute) ?? resolveSlug({
        branch: getCurrentBranch(repoRoot),
        orchestrator: request.orchestrator,
      }).slug,
      tier: 'explicit',
      path: absolute,
      exists: fs.existsSync(absolute),
    };
  }
  const resolvedSlug = resolveSlug({
    explicit: request.slug,
    branch: getCurrentBranch(repoRoot),
    orchestrator: request.orchestrator,
  });
  if (!resolvedSlug.slug) throw new Error('Could not derive an artifact slug; set request.slug.');
  const result = resolveArtifacts({
    slug: resolvedSlug.slug,
    date: request.date,
    kinds: ['plan'],
    projectRoot: repoRoot,
    native: request.orchestrator ? { orchestrator: request.orchestrator } : undefined,
  });
  return { slug: result.slug, ...result.plan, path: path.resolve(repoRoot, result.plan.path) };
}

function loadPrompt(values) {
  const templatePath = path.join(SKILL_DIR, 'references', 'prompt-template.md');
  const { variables, template } = extractTemplate(fs.readFileSync(templatePath, 'utf8'));
  return fillTemplate(template, variables, values);
}

function planMetadata({ slug, invocationId, snapshot, now }) {
  return {
    schemaVersion: 1,
    kind: 'plan',
    slug,
    invocationId,
    contentHash: snapshot.contentHash,
    sectionHashes: snapshot.sectionHashes,
    reviewedAt: now.toISOString(),
  };
}

function validateSettlement(state, request) {
  const settlement = request.settlement;
  assertObjectKeys(settlement, ['consensusExit', 'terminalSourceKeys'], 'settlement');
  if (settlement.consensusExit !== 0) throw new Error('checkpoint requires consensusExit 0; run dispatch/scripts/check-consensus.mjs until it exits 0, then checkpoint.');
  if (!Array.isArray(settlement.terminalSourceKeys) || settlement.terminalSourceKeys.some((value) => typeof value !== 'string')) {
    throw new Error('settlement.terminalSourceKeys must be an array of strings.');
  }
  const actual = [...(settlement.terminalSourceKeys ?? [])].sort();
  if (JSON.stringify(actual) !== JSON.stringify(state.expectedSourceKeys)) {
    // Standalone preparation records no expected keys, so a standalone checkpoint supplies [].
    throw new Error(settledWritesMismatch(
      'settlement.terminalSourceKeys',
      'invocation targets',
      state.expectedSourceKeys,
      actual,
    ));
  }
}

function readCheckpointState(request) {
  const state = readInvocationState(request.invocationContext);
  if (state.kind !== 'plan') throw new Error('Invocation context kind is not plan.');
  return state;
}

// Shared by checkpoint and preview so the preview reports exactly what checkpoint verifies.
function observeSettledWrites(state) {
  const artifact = readArtifact(state.artifactPath, { kind: 'plan' });
  if (JSON.stringify(artifact.metadata) !== JSON.stringify(state.initialMetadata ?? null)) {
    throw new Error(checkpointDriftRemedy('Artifact checkpoint metadata was superseded by another invocation.'));
  }
  const snapshot = planSnapshot(artifact.source);
  return { artifact, snapshot, sections: changedKeys(state.snapshot.sectionHashes, snapshot.sectionHashes) };
}

function checkpointPreview(request) {
  const state = readCheckpointState(request);
  const consensus = evaluateConsensus(readArtifact(state.artifactPath, { kind: 'plan' }).source);
  // NOTE: an unsettled or strict-invalid log stops before snapshotting, which parses strictly and would throw.
  const sections = consensus.exit === 0 ? observeSettledWrites(state).sections : [];
  return {
    schemaVersion: 1,
    kind: 'plan',
    action: 'checkpoint-preview',
    status: 'preview',
    settlement: { consensusExit: consensus.exit, terminalSourceKeys: state.expectedSourceKeys },
    settledWrites: { sections },
    unsettled: consensus.unsettled,
    ...(consensus.error ? { error: consensus.error } : {}),
  };
}

function checkpoint(request, { now }) {
  if (!request.invocationContext) throw new Error('checkpoint requires invocationContext.');
  const state = readCheckpointState(request);
  validateSettlement(state, request);
  const { artifact, snapshot, sections: observed } = observeSettledWrites(state);
  const declared = [...(request.settledWrites?.sections ?? [])].sort();
  if (JSON.stringify(observed) !== JSON.stringify(declared)) {
    throw new Error(settledWritesMismatch('settledWrites.sections', 'plan changes', observed, declared));
  }
  const metadata = planMetadata({
    slug: state.slug,
    invocationId: state.invocationId,
    snapshot,
    now,
  });
  const written = writeArtifactMetadata(state.artifactPath, metadata, {
    expectedDocumentHash: artifact.documentHash,
  });
  const completed = completeInvocationState(request.invocationContext);
  return {
    schemaVersion: 1,
    kind: 'plan',
    action: 'checkpoint',
    status: 'checkpointed',
    artifactPath: toManifestPath(written.path, state.repoRoot),
    metadata,
    cleanupPaths: [completed.cleanupPath],
  };
}

export function preparePlanReview(request, {
  repoRoot = process.cwd(),
  now = new Date(),
} = {}) {
  repoRoot = path.resolve(repoRoot);
  const action = validateRequest(request);
  if (action === 'checkpoint') return checkpoint(request, { now });
  if (action === 'checkpoint-preview') return checkpointPreview(request);

  const resolved = resolvePlan(request, repoRoot);
  const manifestPath = toManifestPath(resolved.path, repoRoot);
  if (!resolved.exists) {
    return {
      schemaVersion: 1,
      kind: 'plan',
      action,
      status: 'authoring-required',
      artifact: { canonicalPath: manifestPath, tier: resolved.tier, slug: resolved.slug },
      requirement: request.requirement ?? request.trailingText ?? null,
      cleanupPaths: [],
    };
  }
  if (request.decision === 'overwrite') {
    return {
      schemaVersion: 1,
      kind: 'plan',
      action,
      status: 'authoring-required',
      overwrite: true,
      artifact: { canonicalPath: manifestPath, tier: resolved.tier, slug: resolved.slug },
      requirement: request.requirement ?? request.trailingText ?? null,
      cleanupPaths: [],
    };
  }
  if (request.decision === 'fresh-slug') {
    throw new Error('fresh-slug requires a new request.slug that resolves to a missing artifact.');
  }
  const artifact = readArtifact(resolved.path, { kind: 'plan', slug: resolved.slug });
  const snapshot = planSnapshot(artifact.source);
  const persisted = artifact.metadata;
  const changedSections = persisted ? changedKeys(persisted.sectionHashes, snapshot.sectionHashes) : [];
  // Checkpoints land only at settlement, so later waves diff against the prior wave's snapshot.
  const priorSnapshot = request.invocationContext ? readInvocationState(request.invocationContext).snapshot : null;
  const reReviewSections = priorSnapshot?.sectionHashes
    ? changedKeys(priorSnapshot.sectionHashes, snapshot.sectionHashes)
    : changedSections;
  const freshness = {
    status: !persisted ? 'legacy' : changedSections.length || persisted.contentHash !== snapshot.contentHash ? 'changed' : 'current',
    changedSections,
  };
  if (
    !persisted &&
    resolved.tier === 'scratch-existing' &&
    request.requirement &&
    !request.artifactOwned &&
    !request.decision
  ) {
    return {
      schemaVersion: 1,
      kind: 'plan',
      action,
      status: 'decision-required',
      decision: 'legacy-plan-coverage',
      choices: ['overwrite', 'as-is', 'fresh-slug'],
      artifact: { canonicalPath: manifestPath, tier: resolved.tier, slug: resolved.slug },
      freshness,
      cleanupPaths: [],
    };
  }

  const scan = scanResolutionLog(artifact.source, { strict: true });
  const { roundId, round } = parseRound(request.roundId, scan);
  const mode = request.mode ?? 'standalone';
  const reviewMode = request.reviewMode ?? 'full';
  if (reviewMode === 'rebuttal' && !request.findingPacketPath) {
    throw new Error('rebuttal review requires findingPacketPath.');
  }
  let reviewPath = resolved.path;
  const cleanupPaths = [];
  if (artifact.metadata || round > 1 || reviewMode === 'rebuttal') {
    const view = createReviewView({ artifact: resolved.path, nextRound: round });
    reviewPath = view.viewPath;
    cleanupPaths.push(view.cleanupPath);
  }
  const derivedScope = reviewMode === 'rebuttal'
    ? `Finding keys only: ${(request.findingKeys ?? []).join(', ')}`
    : round === 1
      ? 'Full review'
      : `Re-review round ${round} — changed sections: ${reReviewSections.join(', ') || 'review resolutions only'}`;
  const scope = request.reviewScope ? `${derivedScope}; ${request.reviewScope}` : derivedScope;
  const prompt = reviewMode === 'full'
    ? loadPrompt({
      'Plan Path': toManifestPath(reviewPath, repoRoot),
      Requirement: request.requirement ?? artifact.body.match(/^#\s+(.+)$/m)?.[1] ?? 'Review the plan',
      'User Focus Areas': request.focus ?? 'General review',
      'Review Scope': scope,
      'Tool Turn Budget': request.toolTurnBudget ?? 'Unspecified',
    })
    : (() => {
      const templatePath = path.join(SKILL_DIR, 'references', 'rebuttal-template.md');
      const { variables, template } = extractTemplate(fs.readFileSync(templatePath, 'utf8'));
      return fillTemplate(template, variables, {
        'Plan Path': toManifestPath(reviewPath, repoRoot),
        'Finding Packet Path': request.findingPacketPath,
        'Review Scope': scope,
        'Tool Turn Budget': request.toolTurnBudget ?? 'Unspecified',
      });
    })();

  // A present entry roundId must agree with the resolved round; then every entry (whether it
  // carried one or not) is normalized to the resolved roundId — `loadBatchFile` in dispatch.mjs
  // requires roundId on every batch entry.
  for (const entry of [...(request.targets ?? []), ...(request.reserves ?? [])]) {
    if (entry.roundId !== undefined && entry.roundId !== roundId) {
      throw new Error(`Entry roundId "${entry.roundId}" does not match resolved round ${roundId}.`);
    }
  }
  const targets = (request.targets ?? []).map((entry) => ({ ...entry, roundId }));
  const reserves = (request.reserves ?? []).map((entry) => ({ ...entry, roundId }));
  if (mode === 'orchestrated' && targets.length === 0) throw new Error('orchestrated mode requires targets.');
  const keys = mode === 'orchestrated' ? sourceKeys(roundId, targets) : [];
  let invocation;
  if (request.invocationContext) {
    const previous = readInvocationState(request.invocationContext);
    if (previous.kind !== 'plan' || previous.artifactPath !== path.resolve(resolved.path)) {
      throw new Error('Invocation context does not match the plan artifact.');
    }
    invocation = advanceInvocationState(request.invocationContext, { snapshot, round, expectedSourceKeys: keys });
  } else {
    const created = createInvocationState({
      kind: 'plan',
      artifactPath: resolved.path,
      snapshot,
      expectedSourceKeys: keys,
    });
    invocation = advanceInvocationState(created.context, { repoRoot, slug: resolved.slug, round });
  }
  const batch = mode === 'orchestrated' ? { targets, reserves } : null;
  const files = createDispatchFiles({
    prompt,
    batch,
    attachments: [
      reviewPath,
      ...(reviewMode === 'rebuttal' ? [path.resolve(repoRoot, request.findingPacketPath)] : []),
    ],
    responseSchemaPath: path.join(
      SKILL_DIR,
      'references',
      reviewMode === 'rebuttal' ? 'rebuttal-schema.json' : 'report-schema.json',
    ),
    selector: request.selector,
    dispatchScriptPath: path.join(DISPATCH_DIR, 'scripts', 'dispatch.mjs'),
    orchestrator: request.orchestrator,
    orchestratorModel: request.orchestratorModel,
  });
  return {
    schemaVersion: 1,
    kind: 'plan',
    action,
    status: 'ready',
    mode,
    reviewMode,
    roundId,
    artifact: {
      canonicalPath: manifestPath,
      reviewPath: toManifestPath(reviewPath, repoRoot),
      tier: resolved.tier,
      slug: resolved.slug,
    },
    freshness,
    scope,
    advisoryTarget: request.toolTurnBudget ?? 'Unspecified',
    invocationContext: invocation.context,
    promptPath: files.promptPath,
    dispatch: files.dispatch,
    invocationCleanupPath: invocation.cleanupPath,
    cleanupPaths: [...cleanupPaths, ...files.cleanupPaths],
  };
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  if (argv.length !== 2 || argv[0] !== '--request') throw new Error('Usage: node prepare-review.mjs --request <json-file|->');
  return { request: argv[1] };
}

function main() {
  requireNode22();
  assertPreparationIntegrity(SKILL_DIR, DISPATCH_DIR);
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return process.stdout.write('Usage: node prepare-review.mjs --request <json-file|->\n');
  process.stdout.write(`${JSON.stringify(preparePlanReview(readJsonRequest(args.request)), null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[prepare-review] ${err.message}\n`);
    process.exit(1);
  }
}
