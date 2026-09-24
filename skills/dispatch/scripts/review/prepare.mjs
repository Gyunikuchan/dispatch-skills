// @ts-check
/**
 * Review preparation for every kind: `--kind plan|design` run the shared document path below,
 * `--kind code` delegates to `review/prepare-code.mjs`. Per-kind differences come from the
 * `review/kinds.mjs` registry.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleTemplate, fillTemplate } from './fill-template.mjs';
import {
  getCurrentBranch,
  isNativeArtifactPath,
  resolveArtifacts,
  resolveSlug,
} from '../artifacts/resolve-paths.mjs';
import { evaluateConsensus } from './consensus.mjs';
import { scanResolutionLog } from './resolution-log.mjs';
import {
  advanceInvocationState,
  assertObjectKeys,
  changedKeys,
  checkpointDriftRemedy,
  completeInvocationState,
  createDispatchFiles,
  createInvocationState,
  createReviewView,
  FIELD_HINTS,
  governingDesignExcerpt,
  readArtifact,
  readInvocationState,
  semanticSectionHashes,
  settledWritesMismatch,
  slugFromPath,
  writeArtifactMetadata,
  validateRequestAction,
} from './preparation.mjs';
import { PROMPT_FRAME, REBUTTAL_FRAME, REVIEW_KINDS, reviewKind } from './kinds.mjs';
import { prepareCodeReview } from './prepare-code.mjs';

export { prepareCodeReview };

// SECTION: Document review configuration

const DISPATCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCUMENT_REQUEST_KEYS = [
  'action', 'mode', 'reviewMode', 'artifactPath', 'slug', 'date', 'orchestrator',
  'orchestratorModel', 'requirement', 'focus', 'trailingText', 'reviewScope',
  'toolTurnBudget', 'targets', 'reserves', 'roundId', 'consensus',
  'findingPacketPath', 'findingKeys', 'selector',
  'invocationContext', 'settlement', 'settledWrites',
];
const DESIGN_CONTEXT_KEYS = ['designPath', 'designRevision', 'incrementId'];

// SECTION: Shared preparation helpers

function toManifestPath(file, repoRoot) {
  const relative = path.relative(repoRoot, file);
  return !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : file.split(path.sep).join('/');
}

function documentSnapshot(entry, source) {
  return semanticSectionHashes(source, entry.excludedSections.length ? { excludedSections: entry.excludedSections } : undefined);
}

export function planSnapshot(source) {
  return documentSnapshot(REVIEW_KINDS.plan, source);
}

export function designSnapshot(source) {
  return documentSnapshot(REVIEW_KINDS.design, source);
}

function parseRound(entry, roundId, scan) {
  const expected = (scan.rounds.at(-1)?.number ?? 0) + 1;
  if (!roundId) return { roundId: `${entry.kind}-review:R${expected}`, round: expected };
  const match = new RegExp(`^${entry.kind}-review:R([1-9]\\d*)$`).exec(roundId);
  if (!match || Number(match[1]) !== expected) {
    throw new Error(`roundId must be ${entry.kind}-review:R${expected}.`);
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

// SECTION: Request validation

function validateRequest(entry, request) {
  const allowed = entry.acceptsDesignContext ? [...DOCUMENT_REQUEST_KEYS, ...DESIGN_CONTEXT_KEYS] : DOCUMENT_REQUEST_KEYS;
  assertObjectKeys(request, allowed, `${entry.kind} review request`, FIELD_HINTS);
  const action = validateRequestAction(request);
  if (action === 'checkpoint-preview') return action;
  validateSelector(request.selector);
  if (action === 'checkpoint') {
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
  if (request.targets !== undefined) validateTargets(entry, request.targets, request.roundId, 'targets');
  if (request.reserves !== undefined) validateTargets(entry, request.reserves, request.roundId, 'reserves');
  validateCombinedEntries(request.targets ?? [], request.reserves ?? []);
  if (action === 'prepare' && request.mode === 'orchestrated' && request.targets?.length === 0) {
    throw new Error('orchestrated mode requires targets.');
  }

  function validateCombinedEntries(targets, reserves) {
    const sources = new Set();
    for (const target of [...targets, ...reserves]) {
      const source = `${target.platform}:${target.candidateId.split(':')[2]}`;
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

function validateTargets(kindEntry, entries, roundId, label) {
  if (!Array.isArray(entries)) throw new Error(`${label} must be an array.`);
  const roundPattern = new RegExp(`^${kindEntry.kind}-review:R[1-9]\\d*$`);
  const candidatePattern = new RegExp(`^${kindEntry.kind}-review:[a-z][a-z0-9-]*:\\d+$`);
  const sources = new Set();
  for (const [index, entry] of entries.entries()) {
    assertObjectKeys(entry, ['roundId', 'candidateId', 'platform', 'candidateIndex', 'model', 'effort'], `${label}[${index}]`);
    // roundId is optional per entry — it is implied by the request's (resolved) round; when
    // present it must still look right and, if the request pins a roundId, agree with it.
    if (entry.roundId !== undefined) {
      if (!roundPattern.test(entry.roundId)) throw new Error(`${label}[${index}].roundId is invalid.`);
      if (roundId !== undefined && entry.roundId !== roundId) throw new Error(`${label}[${index}].roundId is invalid.`);
    }
    if (!candidatePattern.test(entry.candidateId ?? '')) throw new Error(`${label}[${index}].candidateId is invalid.`);
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

// SECTION: Artifact and prompt resolution

function resolveDocument(entry, request, repoRoot) {
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
    slugSource: resolvedSlug.slugSource,
    date: request.date,
    kinds: [entry.artifactKind],
    projectRoot: repoRoot,
    native: request.orchestrator ? { orchestrator: request.orchestrator } : undefined,
  });
  const artifact = result[entry.artifactKind];
  return { slug: result.slug, ...artifact, path: path.resolve(repoRoot, artifact.path) };
}

function loadPrompt(framePath, kindPath, values) {
  const { variables, template } = assembleTemplate(framePath, kindPath);
  return fillTemplate(template, variables, values);
}

// SECTION: Checkpointing

function validateSettlement(state, request) {
  const settlement = request.settlement;
  assertObjectKeys(settlement, ['consensusExit', 'terminalSourceKeys'], 'settlement');
  if (settlement.consensusExit !== 0) throw new Error('checkpoint requires consensusExit 0; continue review rounds until consensus settles (exit 0), then checkpoint.');
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

function readCheckpointState(entry, request) {
  const state = readInvocationState(request.invocationContext);
  if (state.kind !== entry.kind) throw new Error(`Invocation context kind is not ${entry.kind}.`);
  return state;
}

// Shared by checkpoint and preview so the preview reports exactly what checkpoint verifies.
function observeSettledWrites(entry, state) {
  const artifact = readArtifact(state.artifactPath, { kind: entry.kind });
  if (JSON.stringify(artifact.metadata) !== JSON.stringify(state.initialMetadata ?? null)) {
    throw new Error(checkpointDriftRemedy('Artifact checkpoint metadata was superseded by another invocation.'));
  }
  const snapshot = documentSnapshot(entry, artifact.source);
  return { artifact, snapshot, sections: changedKeys(state.snapshot.sectionHashes, snapshot.sectionHashes) };
}

function checkpointPreview(entry, request) {
  const state = readCheckpointState(entry, request);
  const consensus = evaluateConsensus(readArtifact(state.artifactPath, { kind: entry.kind }).source);
  // NOTE: an unsettled or strict-invalid log stops before snapshotting, which parses strictly and would throw.
  const sections = consensus.exit === 0 ? observeSettledWrites(entry, state).sections : [];
  return {
    schemaVersion: 1,
    kind: entry.kind,
    action: 'checkpoint-preview',
    status: 'preview',
    settlement: { consensusExit: consensus.exit, terminalSourceKeys: state.expectedSourceKeys },
    settledWrites: { sections },
    unsettled: consensus.unsettled,
    ...(consensus.error ? { error: consensus.error } : {}),
  };
}

function checkpoint(entry, request, { now }) {
  if (!request.invocationContext) throw new Error('checkpoint requires invocationContext.');
  const state = readCheckpointState(entry, request);
  validateSettlement(state, request);
  const { artifact, snapshot, sections: observed } = observeSettledWrites(entry, state);
  const declared = [...(request.settledWrites?.sections ?? [])].sort();
  if (JSON.stringify(observed) !== JSON.stringify(declared)) {
    throw new Error(settledWritesMismatch('settledWrites.sections', `${entry.kind} changes`, observed, declared));
  }
  const metadata = entry.metadata({
    slug: state.slug,
    invocationId: state.invocationId,
    snapshot,
    previous: artifact.metadata,
    now,
  });
  const written = writeArtifactMetadata(state.artifactPath, metadata, {
    expectedDocumentHash: artifact.documentHash,
  });
  const completed = completeInvocationState(request.invocationContext);
  return {
    schemaVersion: 1,
    kind: entry.kind,
    action: 'checkpoint',
    status: 'checkpointed',
    artifactPath: toManifestPath(written.path, state.repoRoot),
    metadata,
    cleanupPaths: [completed.cleanupPath],
  };
}

// SECTION: Optional design context

function resolveDesignContext(request, repoRoot) {
  if (request.designPath === undefined && request.incrementId === undefined) return null;
  if (!request.designPath || request.incrementId === undefined) {
    throw new Error('Design context requires both designPath and incrementId.');
  }
  const designAbsolute = path.resolve(repoRoot, request.designPath);
  const containment = path.relative(path.resolve(repoRoot), designAbsolute);
  if (containment.startsWith('..') || path.isAbsolute(containment)) {
    throw new Error(`Design artifact must stay inside the repository: ${request.designPath}`);
  }
  if (!fs.existsSync(designAbsolute) || !fs.statSync(designAbsolute).isFile()) {
    throw new Error(`Design artifact not found: ${request.designPath}`);
  }
  const designSource = fs.readFileSync(designAbsolute, 'utf8');
  const excerpt = governingDesignExcerpt(designSource, { revision: request.designRevision ?? null });
  if (request.designRevision !== undefined && request.designRevision !== null &&
      excerpt.governedHash !== request.designRevision) {
    throw new Error(`Design revision mismatch: governed hash ${excerpt.governedHash} does not match the explicit designRevision`);
  }
  return {
    designPath: toManifestPath(designAbsolute, repoRoot),
    revision: request.designRevision ?? null,
    governedHash: excerpt.governedHash,
    incrementId: request.incrementId ?? null,
    excerpt: excerpt.excerpt,
  };
}

/**
 * @param {Record<string, any>} entry
 * @param {Record<string, any>} request
 * @param {{ repoRoot?: string, now?: Date, nativeRoots?: string[] }} [options]
 */
// SECTION: Document preparation

function prepareDocumentReview(entry, request, {
  repoRoot = process.cwd(),
  now = new Date(),
  nativeRoots,
} = {}) {
  repoRoot = path.resolve(repoRoot);
  const action = validateRequest(entry, request);
  if (action === 'checkpoint') return checkpoint(entry, request, { now });
  if (action === 'checkpoint-preview') return checkpointPreview(entry, request);

  const resolved = resolveDocument(entry, request, repoRoot);
  const manifestPath = toManifestPath(resolved.path, repoRoot);
  if (!resolved.exists) {
    return {
      schemaVersion: 1,
      kind: entry.kind,
      action,
      status: 'authoring-required',
      artifact: { canonicalPath: manifestPath, tier: resolved.tier, slug: resolved.slug },
      requirement: request.requirement ?? request.trailingText ?? null,
      cleanupPaths: [],
    };
  }
  const artifact = readArtifact(resolved.path, { kind: entry.kind, slug: resolved.slug });
  const lint = entry.lint(artifact.source);
  const persisted = artifact.metadata;
  const native = resolved.tier === 'native' ||
    isNativeArtifactPath(resolved.path, entry.artifactKind, nativeRoots ? { roots: nativeRoots } : undefined);
  if (lint.defects.length && !native) {
    return {
      schemaVersion: 1,
      kind: entry.kind,
      action,
      status: 'decision-required',
      decision: entry.lintDecision,
      artifact: { canonicalPath: manifestPath, tier: resolved.tier, slug: resolved.slug },
      freshness: { status: persisted ? 'changed' : 'untracked', changedSections: [] },
      defects: lint.defects,
      cleanupPaths: [],
    };
  }
  const snapshot = documentSnapshot(entry, artifact.source);
  const changedSections = persisted ? changedKeys(persisted.sectionHashes, snapshot.sectionHashes) : [];
  // Checkpoints land only at settlement, so later waves diff against the prior wave's snapshot.
  const priorSnapshot = request.invocationContext ? readInvocationState(request.invocationContext).snapshot : null;
  const reReviewSections = priorSnapshot?.sectionHashes
    ? changedKeys(priorSnapshot.sectionHashes, snapshot.sectionHashes)
    : changedSections;
  const freshness = {
    status: !persisted ? 'untracked' : changedSections.length || persisted.contentHash !== snapshot.contentHash ? 'changed' : 'current',
    changedSections,
  };
  const scan = scanResolutionLog(artifact.source, { strict: true });
  const { roundId, round } = parseRound(entry, request.roundId, scan);
  const mode = request.mode ?? 'standalone';
  const reviewMode = request.reviewMode ?? 'full';
  if (reviewMode === 'rebuttal' && !request.findingPacketPath) {
    throw new Error('rebuttal review requires findingPacketPath.');
  }
  // Every round reads the projection, so round-1 and re-review briefs share one shape.
  const view = createReviewView({ artifact: resolved.path, nextRound: round });
  const reviewPath = view.viewPath;
  const cleanupPaths = [view.cleanupPath];
  const derivedScope = reviewMode === 'rebuttal'
    ? `Finding keys only: ${(request.findingKeys ?? []).join(', ')}`
    : round === 1
      ? 'Full review'
      : `Re-review round ${round} — changed sections: ${reReviewSections.join(', ') || 'review resolutions only'}`;
  const lintWarnings = [
    ...lint.warnings,
    ...(native ? lint.defects.map(defect => ({ ...defect, severity: 'warning' })) : []),
  ];
  const warningScope = lintWarnings.length
    ? `${entry.lintLabel}: ${lintWarnings.map(({ rule, locus, message }) => `${rule} (${locus}): ${message}`).join(' | ')}`
    : '';
  const scope = [derivedScope, request.reviewScope, warningScope].filter(Boolean).join('; ');
  const designContext = entry.acceptsDesignContext ? resolveDesignContext(request, repoRoot) : null;
  const promptBase = reviewMode === 'full'
    ? loadPrompt(PROMPT_FRAME, entry.promptBlock, {
      [entry.pathVariable]: toManifestPath(reviewPath, repoRoot),
      Requirement: request.requirement ?? artifact.body.match(/^#\s+(.+)$/m)?.[1] ?? entry.fallbackRequirement,
      'User Focus Areas': request.focus ?? 'General review',
      'Review Scope': scope,
      'Tool Turn Budget': request.toolTurnBudget ?? 'Unspecified',
    })
    : loadPrompt(REBUTTAL_FRAME, entry.rebuttalBlock, {
      [entry.pathVariable]: toManifestPath(reviewPath, repoRoot),
      'Finding Packet Path': request.findingPacketPath,
      'Review Scope': scope,
      'Tool Turn Budget': request.toolTurnBudget ?? 'Unspecified',
    });

  const prompt = designContext
    ? `${promptBase}\n\nApproved technical-design context (increment ${designContext.incrementId ?? 'unknown'}, revision ${designContext.revision ?? designContext.governedHash}):\n\n${designContext.excerpt}\n`
    : promptBase;

  // A present entry roundId must agree with the resolved round; then every entry (whether it
  // carried one or not) is normalized to the resolved roundId — `loadBatchFile` in dispatch.mjs
  // requires roundId on every batch entry.
  for (const target of [...(request.targets ?? []), ...(request.reserves ?? [])]) {
    if (target.roundId !== undefined && target.roundId !== roundId) {
      throw new Error(`Entry roundId "${target.roundId}" does not match resolved round ${roundId}.`);
    }
  }
  const targets = (request.targets ?? []).map((target) => ({ ...target, roundId }));
  const reserves = (request.reserves ?? []).map((target) => ({ ...target, roundId }));
  if (mode === 'orchestrated' && targets.length === 0) throw new Error('orchestrated mode requires targets.');
  const keys = mode === 'orchestrated' ? sourceKeys(roundId, targets) : [];
  let invocation;
  if (request.invocationContext) {
    const previous = readInvocationState(request.invocationContext);
    if (previous.kind !== entry.kind || previous.artifactPath !== path.resolve(resolved.path)) {
      throw new Error(`Invocation context does not match the ${entry.kind} artifact.`);
    }
    invocation = advanceInvocationState(request.invocationContext, { snapshot, round, expectedSourceKeys: keys });
  } else {
    const created = createInvocationState({
      kind: entry.kind,
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
    responseSchemaPath: reviewMode === 'rebuttal' ? entry.rebuttalSchema : entry.reportSchema,
    selector: request.selector,
    dispatchScriptPath: path.join(DISPATCH_DIR, 'scripts', 'dispatch.mjs'),
    orchestrator: request.orchestrator,
    orchestratorModel: request.orchestratorModel,
  });
  return {
    schemaVersion: 1,
    kind: entry.kind,
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
    ...(designContext ? { designContext } : {}),
    advisoryTarget: request.toolTurnBudget ?? 'Unspecified',
    invocationContext: invocation.context,
    promptPath: files.promptPath,
    dispatch: files.dispatch,
    invocationCleanupPath: invocation.cleanupPath,
    cleanupPaths: [...cleanupPaths, ...files.cleanupPaths],
  };
}

// SECTION: Public preparation API

/** @param {Record<string, any>} request @param {Record<string, any>} [opts] */
export function preparePlanReview(request, opts) {
  return prepareDocumentReview(REVIEW_KINDS.plan, request, opts);
}

/** @param {Record<string, any>} request @param {Record<string, any>} [opts] */
export function prepareDesignReview(request, opts) {
  return prepareDocumentReview(REVIEW_KINDS.design, request, opts);
}

/**
 * Prepares one review of `kind` (`plan|code|design`).
 *
 * @param {string} kind
 * @param {Record<string, any>} request
 * @param {Record<string, any>} [opts]
 * @returns {Record<string, any>}
 */
export function prepareReview(kind, request, opts) {
  const entry = reviewKind(kind);
  return entry.kind === 'code' ? prepareCodeReview(request, opts) : prepareDocumentReview(entry, request, opts);
}
