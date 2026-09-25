// @ts-check
/**
 * Code-kind review preparation (range selection, walkthrough pairing, Git snapshots). Imported by
 * `review/prepare.mjs --kind code`; not a CLI.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateConsensus } from './consensus.mjs';
import { assembleTemplate, extractTemplate, fillTemplate } from './fill-template.mjs';
import { PROMPT_FRAME, REBUTTAL_FRAME, REVIEW_KINDS } from './kinds.mjs';
import { criterionMappings } from '../verification/evidence.mjs';
import { lintWalkthrough } from '../walkthrough/lint.mjs';
import { PLANLESS, cell, renderTraceability } from '../walkthrough/traceability.mjs';
import {
  getCurrentBranch,
  resolveArtifacts,
  resolveSlug,
} from '../artifacts/resolve-paths.mjs';
import {
  scanResolutionLog,
  splitDispatchFrontmatter,
} from './resolution-log.mjs';
import {
  advanceInvocationState,
  assertObjectKeys,
  changedKeys,
  checkpointDriftRemedy,
  completeInvocationState,
  createDispatchFiles,
  createInvocationState,
  createReviewView,
  resolutionPaths,
  toolTurnTarget,
  FIELD_HINTS,
  readArtifact,
  readInvocationState,
  governingDesignExcerpt,
  rawSha256,
  semanticSectionHashes,
  settledWritesMismatch,
  slugFromPath,
  writeArtifactMetadata,
  validateRequestAction,
} from './preparation.mjs';
import {
  captureReviewSnapshot,
  resolveReviewScope,
} from './range.mjs';

// SECTION: Code review configuration

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DISPATCH_DIR = path.resolve(__dirname, '..', '..');
const REQUEST_KEYS = [
  'action', 'mode', 'reviewMode', 'artifactPath', 'walkthroughPath', 'planPath',
  'slug', 'date', 'orchestrator', 'orchestratorModel', 'summary', 'focus',
  'trailingText', 'reviewScope', 'toolTurnBudget', 'targets', 'reserves',
  'roundId', 'consensus', 'findingPacketPath', 'findingKeys', 'selector',
  'range', 'verification', 'invocationContext',
  'settlement', 'settledWrites', 'designPath', 'designRevision', 'incrementId',
  'allowedPaths', 'baseRevision',
];

// SECTION: Shared preparation helpers

function toManifestPath(file, repoRoot) {
  if (!file) return null;
  const relative = path.relative(repoRoot, file);
  return !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : file.split(path.sep).join('/');
}

function workingScope() {
  return { reviewable: true, kind: 'working-tree', range: null, paths: [], reviewScope: 'Working-tree overlay' };
}

function rawSemanticHash(source) {
  const body = splitDispatchFrontmatter(source).body;
  const match = /^## Review Findings & Resolutions\b/m.exec(body);
  if (!match) return rawSha256(body);
  const tail = body.slice(match.index + match[0].length);
  const next = /\r?\n##\s+/.exec(tail);
  return rawSha256(body.slice(0, match.index) + (next ? tail.slice(next.index + 1) : ''));
}

function parseRound(roundId, scan) {
  const expected = (scan.rounds.at(-1)?.number ?? 0) + 1;
  if (!roundId) return { roundId: `code-review:R${expected}`, round: expected };
  const match = /^code-review:R([1-9]\d*)$/.exec(roundId);
  if (!match || Number(match[1]) !== expected) throw new Error(`roundId must be code-review:R${expected}.`);
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

function validateRequest(request) {
  assertObjectKeys(request, REQUEST_KEYS, 'code review request', FIELD_HINTS);
  const action = validateRequestAction(request);
  if (action === 'checkpoint-preview') return action;
  validateSelector(request.selector);
  if (action === 'checkpoint') {
    assertObjectKeys(request.settledWrites, ['paths', 'walkthroughSections'], 'settledWrites');
    for (const key of ['paths', 'walkthroughSections']) {
      if (!Array.isArray(request.settledWrites[key]) || request.settledWrites[key].some((value) => typeof value !== 'string')) {
        throw new Error(`settledWrites.${key} must be an array of strings.`);
      }
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
  if (request.verification !== undefined) {
    assertObjectKeys(request.verification, ['command', 'result'], 'verification');
    if (typeof request.verification.command !== 'string' || typeof request.verification.result !== 'string') {
      throw new Error('verification command and result must be strings.');
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
      if (!/^code-review:R[1-9]\d*$/.test(entry.roundId)) throw new Error(`${label}[${index}].roundId is invalid.`);
      if (roundId !== undefined && entry.roundId !== roundId) throw new Error(`${label}[${index}].roundId is invalid.`);
    }
    if (!/^code-review:[a-z][a-z0-9-]*:\d+$/.test(entry.candidateId ?? '')) throw new Error(`${label}[${index}].candidateId is invalid.`);
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

function resolvePair(request, repoRoot) {
  let walkthroughPath = request.walkthroughPath;
  let planPath = request.planPath;
  if (request.artifactPath) {
    if (/-walkthrough\.md$/i.test(request.artifactPath)) walkthroughPath = request.artifactPath;
    else planPath = request.artifactPath;
  }
  // NOTE: increment slugs are reserved for phased artifacts, so an explicit increment pair skips ordinary resolution.
  if (walkthroughPath && !planPath && /-i\d{2}-.+-walkthrough\.md$/i.test(walkthroughPath)) {
    planPath = walkthroughPath.replace(/-walkthrough\.md$/i, '-plan.md');
  }
  const explicitPair = (p) => ({ path: path.resolve(repoRoot, p), exists: fs.existsSync(path.resolve(repoRoot, p)), tier: 'explicit' });
  if (walkthroughPath && planPath && /-i\d{2}-/i.test(path.basename(walkthroughPath))) {
    return { slug: slugFromPath(walkthroughPath), plan: explicitPair(planPath), walkthrough: explicitPair(walkthroughPath) };
  }
  const supplied = walkthroughPath ?? planPath;
  const derived = resolveSlug({
    explicit: request.slug ?? (supplied && slugFromPath(supplied)) ?? undefined,
    branch: getCurrentBranch(repoRoot),
    orchestrator: request.orchestrator,
  });
  const resolvedSlug = derived.slug;
  if (!resolvedSlug) throw new Error('Could not derive an artifact slug; set request.slug.');
  const resolved = resolveArtifacts({
    slug: resolvedSlug,
    slugSource: derived.slugSource,
    date: request.date,
    kinds: ['plan', 'walkthrough'],
    projectRoot: repoRoot,
    native: request.orchestrator ? { orchestrator: request.orchestrator } : undefined,
  });
  return {
    slug: resolvedSlug,
    plan: planPath
      ? { path: path.resolve(repoRoot, planPath), exists: fs.existsSync(path.resolve(repoRoot, planPath)), tier: 'explicit' }
      : resolved.plan,
    walkthrough: walkthroughPath
      ? { path: path.resolve(repoRoot, walkthroughPath), exists: fs.existsSync(path.resolve(repoRoot, walkthroughPath)), tier: 'explicit' }
      : resolved.walkthrough,
  };
}

/** Renders the template with the box filled and Pending rows from paired-plan criteria, or the plan-less form. */
function renderWalkthrough({ summary, paths, verification, criteria }) {
  const template = extractTemplate(fs.readFileSync(
    path.join(DISPATCH_DIR, 'references', 'templates', 'walkthrough.md'),
    'utf8',
  ), 'Walkthrough template').template;
  const changes = paths.length > 0
    ? paths.map((file) => `- **[MODIFY]** \`${file}\` — Included in the selected review scope.`).join('\n')
    : '- No changed paths.';
  const verificationResult = /^exit\s+\S+\s*;/i.test(verification.result)
    ? verification.result
    : `exit unknown; ${verification.result}`;
  const trace = criteria
    ? renderTraceability(criteria.map((item) => ({ id: item.id, behavior: item.title, path: item.paths.filter(Boolean).map((file) => `\`${file}\``).join(', ') || '—', evidence: 'Pending' })))
    : PLANLESS;
  const status = criteria ? `0/${criteria.length} SC passing` : 'n/a';
  return `${template
    .replaceAll('<Goal Description>', summary)
    .replace(/^> \*\*TL;DR:\*\* .*$/m, `> **TL;DR:** ${cell(summary)}`)
    .replace(/^> \*\*Status:\*\* .*$/m, `> **Status:** ${status}`)
    .replace(/### <Component Name>[\s\S]*?(?=\n## Verification & Validation)/, `### Selected review scope\n${changes}\n`)
    .replace(/^- Command: `<test command>`.*$/m, `- Command: \`${verification.command}\` — ${verificationResult}`)
    .replace(/^- Per `verify`\/`review` criterion.*$/m, '- None recorded.')
    .replace(/## Outcome Traceability\n[\s\S]*?(?=\n\n## Key Deviations)/, `## Outcome Traceability\n${trace}`)
    .trim()}\n`;
}

function writeNewWalkthrough(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    // A hard link never replaces an existing walkthrough.
    fs.linkSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function loadPrompt(framePath, kindPath, values) {
  const { variables, template } = assembleTemplate(framePath, kindPath);
  return fillTemplate(template, variables, values);
}

function metadataFor({ slug, invocationId, artifactSnapshot, gitSnapshot, now }) {
  return {
    schemaVersion: 1,
    kind: 'code',
    slug,
    invocationId,
    baseSha: gitSnapshot.baseSha,
    headSha: gitSnapshot.headSha,
    worktreeHash: gitSnapshot.worktreeHash,
    contentHash: artifactSnapshot.contentHash,
    pathHashes: gitSnapshot.pathHashes,
    reviewedAt: now.toISOString(),
  };
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

function readCheckpointState(request) {
  const state = readInvocationState(request.invocationContext);
  if (state.kind !== 'code') throw new Error('Invocation context kind is not code.');
  if (!state.repoRoot) throw new Error('Invocation context is missing repoRoot.');
  return state;
}

/**
 * Shared by checkpoint and preview so the preview reports exactly what checkpoint verifies.
 * `includePaths` picks the worktree paths a range scope folds in: checkpoint passes the declared
 * paths (keeping its diagnostics unchanged), preview the observed ones.
 */
function observeSettledWrites(state, includePaths) {
  const repoRoot = state.repoRoot;
  const scope = state.selectedScope ??
    (!state.explicitRange ? workingScope() : null);
  if (!scope?.reviewable) throw new Error('Invocation context is missing the selected review scope.');
  const overlaySnapshot = captureReviewSnapshot({ repoRoot, scope: workingScope() });
  const observedPaths = changedKeys(
    (state.snapshot.overlay ?? state.snapshot.git).pathHashes,
    overlaySnapshot.pathHashes,
  );
  const gitSnapshot = captureReviewSnapshot({
    repoRoot,
    scope,
    includeWorkingTree: scope.kind === 'working-tree' ? [] : includePaths(observedPaths),
  });
  const artifact = readArtifact(state.artifactPath, { kind: 'code' });
  if (JSON.stringify(artifact.metadata) !== JSON.stringify(state.initialMetadata ?? null)) {
    throw new Error(checkpointDriftRemedy('Artifact checkpoint metadata was superseded by another invocation.'));
  }
  const artifactSnapshot = semanticSectionHashes(artifact.source);
  if (
    state.snapshot.rawSemanticHash &&
    state.snapshot.artifact.contentHash === artifactSnapshot.contentHash &&
    state.snapshot.rawSemanticHash !== rawSemanticHash(artifact.source)
  ) {
    throw new Error(checkpointDriftRemedy('Walkthrough raw body changed without a declared semantic edit.'));
  }
  if (gitSnapshot.baseSha !== state.snapshot.git.baseSha || gitSnapshot.headSha !== state.snapshot.git.headSha) {
    throw new Error(checkpointDriftRemedy('The selected review range changed during the invocation.'));
  }
  if (gitSnapshot.worktreeHash !== state.snapshot.git.worktreeHash && observedPaths.length === 0) {
    throw new Error(checkpointDriftRemedy('The eligible worktree fingerprint changed without declared paths.'));
  }
  const observedSections = changedKeys(state.snapshot.artifact.sectionHashes, artifactSnapshot.sectionHashes);
  return { artifact, artifactSnapshot, gitSnapshot, observedPaths, observedSections };
}

function checkpointPreview(request) {
  const state = readCheckpointState(request);
  const consensus = evaluateConsensus(readArtifact(state.artifactPath, { kind: 'code' }).source);
  // NOTE: an unsettled or strict-invalid log stops before snapshotting, which parses strictly and would throw.
  const observed = consensus.exit === 0
    ? observeSettledWrites(state, (paths) => paths)
    : { observedPaths: [], observedSections: [] };
  return {
    schemaVersion: 1,
    kind: 'code',
    action: 'checkpoint-preview',
    status: 'preview',
    settlement: { consensusExit: consensus.exit, terminalSourceKeys: state.expectedSourceKeys },
    settledWrites: { paths: observed.observedPaths, walkthroughSections: observed.observedSections },
    unsettled: consensus.unsettled,
    ...(consensus.error ? { error: consensus.error } : {}),
  };
}

function checkpoint(request, { now }) {
  if (!request.invocationContext) throw new Error('checkpoint requires invocationContext.');
  const state = readCheckpointState(request);
  const repoRoot = state.repoRoot;
  validateSettlement(state, request);
  const declaredPaths = [...(request.settledWrites?.paths ?? [])].sort();
  const declaredSections = [...(request.settledWrites?.walkthroughSections ?? [])].sort();
  const { artifact, artifactSnapshot, gitSnapshot, observedPaths, observedSections } =
    observeSettledWrites(state, () => request.settledWrites?.paths ?? []);
  if (JSON.stringify(observedPaths) !== JSON.stringify(declaredPaths)) {
    throw new Error(settledWritesMismatch('settledWrites.paths', 'code changes', observedPaths, declaredPaths));
  }
  if (JSON.stringify(observedSections) !== JSON.stringify(declaredSections)) {
    throw new Error(settledWritesMismatch('settledWrites.walkthroughSections', 'walkthrough changes', observedSections, declaredSections));
  }
  const metadata = metadataFor({
    slug: state.slug,
    invocationId: state.invocationId,
    artifactSnapshot,
    gitSnapshot,
    now,
  });
  const written = writeArtifactMetadata(state.artifactPath, metadata, {
    expectedDocumentHash: artifact.documentHash,
  });
  const completed = completeInvocationState(request.invocationContext);
  return {
    schemaVersion: 1,
    kind: 'code',
    action: 'checkpoint',
    status: 'checkpointed',
    artifactPath: toManifestPath(written.path, repoRoot),
    metadata,
    cleanupPaths: [completed.cleanupPath],
  };
}

/**
 * Prepares or checkpoints one code review.
 *
 * @param {Record<string, any>} request
 * @param {{ repoRoot?: string, now?: Date }} [options]
 */
// SECTION: Public preparation API

export function prepareCodeReview(request, {
  repoRoot = process.cwd(),
  now = new Date(),
} = {}) {
  repoRoot = path.resolve(repoRoot);
  const action = validateRequest(request);
  if (action === 'checkpoint') return checkpoint(request, { now });
  if (action === 'checkpoint-preview') return checkpointPreview(request);

  const priorState = request.invocationContext ? readInvocationState(request.invocationContext) : null;
  if (priorState && request.range !== undefined && request.range !== priorState.explicitRange) {
    throw new Error('A later wave cannot change the selected explicit range.');
  }
  if (priorState && request.allowedPaths !== undefined &&
      JSON.stringify(request.allowedPaths ?? null) !== JSON.stringify(priorState.allowedPaths ?? null)) {
    throw new Error('A later wave cannot change the owned allowedPaths set.');
  }
  if (priorState && request.baseRevision !== undefined && (request.baseRevision ?? null) !== (priorState.baseRevision ?? null)) {
    throw new Error('A later wave cannot change the selected base revision.');
  }
  const scopeResult = priorState?.selectedScope ??
    resolveReviewScope({
      repoRoot,
      explicitRange: request.range ?? null,
      allowedPaths: request.allowedPaths ?? null,
      baseRevision: request.baseRevision ?? null,
    });
  if (!scopeResult.reviewable) {
    return {
      schemaVersion: 1,
      kind: 'code',
      action,
      status: 'no-reviewable-changes',
      message: scopeResult.message,
      ...(scopeResult.kind === 'empty-owned-intersection' ? { scopeKind: scopeResult.kind } : {}),
      cleanupPaths: [],
    };
  }
  const gitSnapshot = captureReviewSnapshot({ repoRoot, scope: scopeResult });
  const overlaySnapshot = captureReviewSnapshot({ repoRoot, scope: workingScope() });
  const pair = resolvePair(request, repoRoot);
  const walkthroughPath = path.resolve(repoRoot, pair.walkthrough.path);
  let generated = false;
  if (!pair.walkthrough.exists) {
    if (!request.summary || !request.verification?.command || typeof request.verification.result !== 'string') {
      return {
        schemaVersion: 1,
        kind: 'code',
        action,
        status: 'decision-required',
        decision: 'walkthrough-inputs',
        missing: [
          ...(!request.summary ? ['summary'] : []),
          ...(!request.verification?.command ? ['verification.command'] : []),
          ...(typeof request.verification?.result !== 'string' ? ['verification.result'] : []),
        ],
        artifact: {
          canonicalPath: toManifestPath(walkthroughPath, repoRoot),
          tier: pair.walkthrough.tier,
          slug: pair.slug,
        },
        cleanupPaths: [],
      };
    }
    const criteria = pair.plan?.exists ? criterionMappings(fs.readFileSync(pair.plan.path, 'utf8')) : null;
    const rendered = renderWalkthrough({
      summary: request.summary,
      paths: gitSnapshot.paths,
      verification: request.verification,
      criteria: criteria?.length ? criteria : null,
    });
    // Lint before writing so a defective walkthrough never lands.
    const lint = lintWalkthrough(rendered, criteria?.length ? { criteria } : {});
    if (lint.defects.length) {
      return {
        schemaVersion: 1,
        kind: 'code',
        action,
        status: 'decision-required',
        decision: REVIEW_KINDS.code.lintDecision,
        artifact: {
          canonicalPath: toManifestPath(walkthroughPath, repoRoot),
          tier: pair.walkthrough.tier,
          slug: pair.slug,
        },
        defects: lint.defects,
        cleanupPaths: [],
      };
    }
    writeNewWalkthrough(walkthroughPath, rendered);
    generated = true;
  }

  const walkthrough = readArtifact(walkthroughPath, { kind: 'code', slug: pair.slug });
  const artifactSnapshot = semanticSectionHashes(walkthrough.source);
  const persisted = walkthrough.metadata;
  const changedPaths = persisted ? changedKeys(persisted.pathHashes, gitSnapshot.pathHashes) : [];
  const contentChanged = Boolean(persisted && persisted.contentHash !== artifactSnapshot.contentHash);
  const gitChanged = Boolean(
    persisted &&
    (persisted.worktreeHash !== gitSnapshot.worktreeHash ||
      persisted.baseSha !== gitSnapshot.baseSha ||
      persisted.headSha !== gitSnapshot.headSha),
  );
  // Checkpoints land only at settlement, so later waves diff against the prior wave's snapshot.
  const reReviewPaths = priorState?.snapshot?.git
    ? changedKeys(priorState.snapshot.git.pathHashes, gitSnapshot.pathHashes)
    : changedPaths;
  const freshness = {
    status: !persisted ? 'untracked' : contentChanged || gitChanged ? 'changed' : 'current',
    changedPaths,
    bodyOnly: contentChanged && !gitChanged && changedPaths.length === 0,
  };

  const scan = scanResolutionLog(walkthrough.source, { strict: true });
  const { roundId, round } = parseRound(request.roundId, scan);
  const mode = request.mode ?? 'standalone';
  const reviewMode = request.reviewMode ?? 'full';
  if (reviewMode === 'rebuttal' && !request.findingPacketPath) {
    throw new Error('rebuttal review requires findingPacketPath.');
  }
  const cleanupPaths = [];
  // Every round reads the projection, so round-1 and re-review briefs share one shape.
  const view = createReviewView({ artifact: walkthroughPath, nextRound: round });
  const reviewPath = view.viewPath;
  cleanupPaths.push(view.cleanupPath);
  let planReviewPath = pair.plan.exists ? path.resolve(repoRoot, pair.plan.path) : null;
  if (planReviewPath) {
    const planScan = scanResolutionLog(fs.readFileSync(planReviewPath, 'utf8'), { strict: true });
    const planView = createReviewView({
      artifact: planReviewPath,
      nextRound: (planScan.rounds.at(-1)?.number ?? 0) + 1,
    });
    planReviewPath = planView.viewPath;
    cleanupPaths.push(planView.cleanupPath);
  }
  // Resolutions can land before the prior wave's snapshot; their application records still name the paths.
  const scopedPaths = round === 1 ? gitSnapshot.paths
    : reReviewPaths.length ? reReviewPaths : resolutionPaths(walkthrough.source);
  const derivedScope = reviewMode === 'rebuttal'
    ? `Finding keys only: ${(request.findingKeys ?? []).join(', ')}`
    : round === 1
      ? scopeResult.reviewScope
      : freshness.bodyOnly
        ? `Re-review round ${round} — walkthrough body changed; review full selected range (${scopeResult.reviewScope})`
        : `Re-review round ${round} — changed paths: ${scopedPaths.join(', ') || 'review resolutions only'}; ${scopeResult.reviewScope}`;
  const scope = request.reviewScope ? `${derivedScope}; ${request.reviewScope}` : derivedScope;
  let designContext = null;
  if (request.designPath !== undefined || request.incrementId !== undefined) {
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
    designContext = {
      designPath: toManifestPath(designAbsolute, repoRoot),
      revision: request.designRevision ?? null,
      governedHash: excerpt.governedHash,
      incrementId: request.incrementId ?? null,
      excerpt: excerpt.excerpt,
    };
  }
  const prompt = reviewMode === 'full'
    ? loadPrompt(PROMPT_FRAME, REVIEW_KINDS.code.promptBlock, {
      'Task Summary': request.summary ?? walkthrough.body.match(/^# Walkthrough — (.+)$/m)?.[1] ?? 'Review the changes',
      'Walkthrough Path': toManifestPath(reviewPath, repoRoot),
      'Plan Path': toManifestPath(planReviewPath, repoRoot) ?? 'None',
      'User Focus Areas': request.focus ?? 'General review',
      'Review Scope': scope,
      'Tool Turn Budget': request.toolTurnBudget ?? toolTurnTarget(scopedPaths),
    })
    : loadPrompt(REBUTTAL_FRAME, REVIEW_KINDS.code.rebuttalBlock, {
      'Walkthrough Path': toManifestPath(reviewPath, repoRoot),
      'Plan Path': toManifestPath(planReviewPath, repoRoot) ?? 'None',
      'Finding Packet Path': request.findingPacketPath,
      'Review Scope': scope,
      'Tool Turn Budget': request.toolTurnBudget ?? toolTurnTarget(scopedPaths),
    });
  const promptWithDesignContext = designContext
    ? `${prompt}\n\nApproved technical-design context (increment ${designContext.incrementId ?? 'unknown'}, revision ${designContext.revision ?? designContext.governedHash}):\n\n${designContext.excerpt}\n`
    : prompt;

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
  const snapshot = {
    artifact: artifactSnapshot,
    git: gitSnapshot,
    overlay: overlaySnapshot,
    rawSemanticHash: rawSemanticHash(walkthrough.source),
  };
  let invocation;
  if (request.invocationContext) {
    const previous = readInvocationState(request.invocationContext);
    if (previous.kind !== 'code' || previous.artifactPath !== walkthroughPath) {
      throw new Error('Invocation context does not match the walkthrough artifact.');
    }
    invocation = advanceInvocationState(request.invocationContext, {
      snapshot,
      round,
      expectedSourceKeys: keys,
    });
  } else {
    const created = createInvocationState({
      kind: 'code',
      artifactPath: walkthroughPath,
      snapshot,
      expectedSourceKeys: keys,
    });
    invocation = advanceInvocationState(created.context, {
      repoRoot,
      slug: pair.slug,
      round,
      explicitRange: request.range ?? null,
      selectedScope: scopeResult,
      allowedPaths: request.allowedPaths ?? null,
      baseRevision: request.baseRevision ?? null,
    });
  }
  const files = createDispatchFiles({
    prompt: promptWithDesignContext,
    batch: mode === 'orchestrated' ? { targets, reserves } : null,
    attachments: [
      reviewPath,
      ...(planReviewPath ? [planReviewPath] : []),
      ...(reviewMode === 'rebuttal' ? [path.resolve(repoRoot, request.findingPacketPath)] : []),
    ],
    responseSchemaPath: reviewMode === 'rebuttal' ? REVIEW_KINDS.code.rebuttalSchema : REVIEW_KINDS.code.reportSchema,
    selector: request.selector,
    dispatchScriptPath: path.join(DISPATCH_DIR, 'scripts', 'dispatch.mjs'),
    orchestrator: request.orchestrator,
    orchestratorModel: request.orchestratorModel,
  });
  return {
    schemaVersion: 1,
    kind: 'code',
    action,
    status: 'ready',
    mode,
    reviewMode,
    roundId,
    artifact: {
      canonicalPath: toManifestPath(walkthroughPath, repoRoot),
      reviewPath: toManifestPath(reviewPath, repoRoot),
      planPath: toManifestPath(planReviewPath, repoRoot),
      tier: pair.walkthrough.tier,
      slug: pair.slug,
      generated,
    },
    freshness,
    reviewRange: scopeResult,
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
