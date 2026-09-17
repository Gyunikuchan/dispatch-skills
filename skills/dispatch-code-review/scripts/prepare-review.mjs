#!/usr/bin/env node

import crypto from 'node:crypto';
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
import {
  scanResolutionLog,
  splitDispatchFrontmatter,
} from '../../dispatch/scripts/resolution-log.mjs';
import {
  advanceInvocationState,
  assertObjectKeys,
  assertPreparationIntegrity,
  completeInvocationState,
  createDispatchFiles,
  createInvocationState,
  createReviewView,
  readArtifact,
  readInvocationState,
  readJsonRequest,
  requireNode22,
  rawSha256,
  semanticSectionHashes,
  writeArtifactMetadata,
} from '../../dispatch/scripts/review-preparation.mjs';
import {
  captureReviewSnapshot,
  resolveReviewScope,
} from './resolve-review-range.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, '..');
const DISPATCH_DIR = path.resolve(__dirname, '../../dispatch');
const CHECKPOINT_KEYS = ['action', 'invocationContext', 'settlement', 'settledWrites'];
const REQUEST_KEYS = [
  'action', 'mode', 'reviewMode', 'artifactPath', 'walkthroughPath', 'planPath',
  'slug', 'date', 'orchestrator', 'orchestratorModel', 'summary', 'focus',
  'trailingText', 'reviewScope', 'toolTurnBudget', 'targets', 'reserves',
  'roundId', 'consensus', 'findingPacketPath', 'findingKeys', 'selector',
  'decision', 'artifactOwned', 'range', 'verification', 'invocationContext',
  'settlement', 'settledWrites',
];

function toManifestPath(file, repoRoot) {
  if (!file) return null;
  const relative = path.relative(repoRoot, file);
  return !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : file.split(path.sep).join('/');
}

function slugFromPath(file) {
  const match = /(?:^|\/)\d{4}-\d{2}-\d{2}-(.+?)(?:-walkthrough)?\.md$/.exec(file.replace(/\\/g, '/'));
  return match?.[1] ?? null;
}

function changedKeys(previous = {}, current = {}) {
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter((key) => previous[key] !== current[key])
    .sort();
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

function validateRequest(request) {
  assertObjectKeys(request, REQUEST_KEYS, 'code review request');
  const action = request.action ?? 'prepare';
  if (!['prepare', 'checkpoint'].includes(action)) throw new Error('action must be "prepare" or "checkpoint".');
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
    const metrics = new Set();
    for (const entry of [...targets, ...reserves]) {
      const source = `${entry.roundId}:${entry.platform}:${entry.candidateId.split(':')[2]}`;
      if (sources.has(source) || metrics.has(entry.metricsFile)) throw new Error('targets and reserves must have unique sources and metrics files.');
      sources.add(source);
      metrics.add(entry.metricsFile);
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
  const metrics = new Set();
  for (const [index, entry] of entries.entries()) {
    assertObjectKeys(entry, ['roundId', 'candidateId', 'platform', 'candidateIndex', 'model', 'effort', 'metricsFile'], `${label}[${index}]`);
    if (entry.roundId !== roundId || !/^code-review:R[1-9]\d*$/.test(entry.roundId ?? '')) throw new Error(`${label}[${index}].roundId is invalid.`);
    if (!/^code-review:[a-z][a-z0-9-]*:\d+$/.test(entry.candidateId ?? '')) throw new Error(`${label}[${index}].candidateId is invalid.`);
    if (entry.candidateId.split(':')[1] !== entry.platform) throw new Error(`${label}[${index}] platform does not match candidateId.`);
    if (!path.isAbsolute(entry.metricsFile ?? '')) throw new Error(`${label}[${index}].metricsFile must be absolute.`);
    const candidateIndex = Number(entry.candidateId.split(':')[2]);
    const byIndex = Number.isSafeInteger(entry.candidateIndex) && entry.candidateIndex >= 0;
    if (byIndex && entry.candidateIndex !== candidateIndex) throw new Error(`${label}[${index}].candidateIndex does not match candidateId.`);
    const byOverride = (typeof entry.model === 'string' && entry.model.length > 0) ||
      (typeof entry.effort === 'string' && entry.effort.length > 0);
    if (byIndex === byOverride) throw new Error(`${label}[${index}] requires candidateIndex or model/effort.`);
    const source = `${entry.roundId}:${entry.platform}:${candidateIndex}`;
    if (sources.has(source)) throw new Error(`${label} contains duplicate source ${source}.`);
    if (metrics.has(entry.metricsFile)) throw new Error(`${label} contains duplicate metricsFile.`);
    sources.add(source);
    metrics.add(entry.metricsFile);
  }
}

function resolvePair(request, repoRoot) {
  let walkthroughPath = request.walkthroughPath;
  let planPath = request.planPath;
  if (request.artifactPath) {
    if (/-walkthrough\.md$/i.test(request.artifactPath)) walkthroughPath = request.artifactPath;
    else planPath = request.artifactPath;
  }
  const supplied = walkthroughPath ?? planPath;
  const resolvedSlug = request.slug ?? (supplied && slugFromPath(supplied)) ?? resolveSlug({
    branch: getCurrentBranch(repoRoot),
    orchestrator: request.orchestrator,
  }).slug;
  if (!resolvedSlug) throw new Error('Could not derive an artifact slug; set request.slug.');
  const resolved = resolveArtifacts({
    slug: resolvedSlug,
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

function renderWalkthrough({ summary, paths, verification }) {
  const template = extractTemplate(fs.readFileSync(
    path.join(SKILL_DIR, 'references', 'walkthrough-template.md'),
    'utf8',
  ), 'Walkthrough template').template;
  const changes = paths.length > 0
    ? paths.map((file) => `- **[MODIFY]** \`${file}\` — Included in the selected review scope.`).join('\n')
    : '- No changed paths.';
  return `${template
    .replaceAll('<Goal Description>', summary)
    .replace('Summary of changes made, context, and what was accomplished.', summary)
    .replace(/### <Component Name>[\s\S]*?(?=\n## Verification & Validation)/, `### Selected review scope\n${changes}\n`)
    .replace('- Command: `<test command>` — Output/results (e.g. `X tests passed`).', `- Command: \`${verification.command}\` — ${verification.result}`)
    .replace('- Concrete manual verification performed and observed results.', '- None recorded.')
    .replace('Deviations from original plan or design intent, with rationale (or "None").', 'None.')
    .replace('Accepted SHOULD-FIX / CONSIDER items not applied in this pass, each with a one-line reason (or "None").', 'None.')
    .trim()}\n`;
}

function writeNewWalkthrough(file, contents, { overwrite = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    if (overwrite) {
      try {
        fs.renameSync(temp, file);
      } catch (err) {
        if (err?.code === 'EPERM' && process.platform === 'win32') {
          fs.rmSync(file, { force: true });
          fs.renameSync(temp, file);
        } else {
          throw err;
        }
      }
    } else {
      fs.linkSync(temp, file);
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function loadPrompt(templateName, values) {
  const templatePath = path.join(SKILL_DIR, 'references', templateName);
  const { variables, template } = extractTemplate(fs.readFileSync(templatePath, 'utf8'));
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

function validateSettlement(state, request) {
  const settlement = request.settlement;
  assertObjectKeys(settlement, ['consensusExit', 'terminalSourceKeys'], 'settlement');
  if (settlement.consensusExit !== 0) throw new Error('checkpoint requires consensusExit 0.');
  if (!Array.isArray(settlement.terminalSourceKeys) || settlement.terminalSourceKeys.some((value) => typeof value !== 'string')) {
    throw new Error('settlement.terminalSourceKeys must be an array of strings.');
  }
  const actual = [...(settlement.terminalSourceKeys ?? [])].sort();
  if (JSON.stringify(actual) !== JSON.stringify(state.expectedSourceKeys)) {
    throw new Error('checkpoint terminalSourceKeys do not match the invocation targets.');
  }
}

function checkpoint(request, { repoRoot, now }) {
  if (!request.invocationContext) throw new Error('checkpoint requires invocationContext.');
  const state = readInvocationState(request.invocationContext);
  if (state.kind !== 'code') throw new Error('Invocation context kind is not code.');
  if (!state.repoRoot) throw new Error('Invocation context is missing repoRoot.');
  repoRoot = state.repoRoot;
  validateSettlement(state, request);
  const scope = state.selectedScope ??
    (!state.explicitRange ? workingScope() : null);
  if (!scope?.reviewable) throw new Error('Invocation context is missing the selected review scope.');
  const gitSnapshot = captureReviewSnapshot({
    repoRoot,
    scope,
    includeWorkingTree: scope.kind === 'working-tree' ? [] : request.settledWrites?.paths ?? [],
  });
  const overlaySnapshot = captureReviewSnapshot({ repoRoot, scope: workingScope() });
  const artifact = readArtifact(state.artifactPath, { kind: 'code' });
  if (JSON.stringify(artifact.metadata) !== JSON.stringify(state.initialMetadata ?? null)) {
    throw new Error('Artifact checkpoint metadata was superseded by another invocation.');
  }
  const artifactSnapshot = semanticSectionHashes(artifact.source);
  if (
    state.snapshot.rawSemanticHash &&
    state.snapshot.artifact.contentHash === artifactSnapshot.contentHash &&
    state.snapshot.rawSemanticHash !== rawSemanticHash(artifact.source)
  ) {
    throw new Error('Walkthrough raw body changed without a declared semantic edit.');
  }
  const observedPaths = changedKeys(
    (state.snapshot.overlay ?? state.snapshot.git).pathHashes,
    overlaySnapshot.pathHashes,
  );
  const observedSections = changedKeys(state.snapshot.artifact.sectionHashes, artifactSnapshot.sectionHashes);
  const declaredPaths = [...(request.settledWrites?.paths ?? [])].sort();
  const declaredSections = [...(request.settledWrites?.walkthroughSections ?? [])].sort();
  if (gitSnapshot.baseSha !== state.snapshot.git.baseSha || gitSnapshot.headSha !== state.snapshot.git.headSha) {
    throw new Error('The selected review range changed during the invocation.');
  }
  if (gitSnapshot.worktreeHash !== state.snapshot.git.worktreeHash && observedPaths.length === 0) {
    throw new Error('The eligible worktree fingerprint changed without declared paths.');
  }
  if (JSON.stringify(observedPaths) !== JSON.stringify(declaredPaths)) {
    throw new Error(`settledWrites.paths do not match observed code changes: ${observedPaths.join(', ') || 'none'}.`);
  }
  if (JSON.stringify(observedSections) !== JSON.stringify(declaredSections)) {
    throw new Error(`settledWrites.walkthroughSections do not match observed changes: ${observedSections.join(', ') || 'none'}.`);
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

export function prepareCodeReview(request, {
  repoRoot = process.cwd(),
  now = new Date(),
} = {}) {
  repoRoot = path.resolve(repoRoot);
  const action = validateRequest(request);
  if (action === 'checkpoint') return checkpoint(request, { repoRoot, now });

  const priorState = request.invocationContext ? readInvocationState(request.invocationContext) : null;
  if (priorState && request.range !== undefined && request.range !== priorState.explicitRange) {
    throw new Error('A later wave cannot change the selected explicit range.');
  }
  const scopeResult = priorState?.selectedScope ??
    resolveReviewScope({ repoRoot, explicitRange: request.range ?? null });
  if (!scopeResult.reviewable) {
    return {
      schemaVersion: 1,
      kind: 'code',
      action,
      status: 'no-reviewable-changes',
      message: scopeResult.message,
      cleanupPaths: [],
    };
  }
  const gitSnapshot = captureReviewSnapshot({ repoRoot, scope: scopeResult });
  const overlaySnapshot = captureReviewSnapshot({ repoRoot, scope: workingScope() });
  const pair = resolvePair(request, repoRoot);
  const walkthroughPath = path.resolve(repoRoot, pair.walkthrough.path);
  let generated = false;
  if (request.decision === 'fresh-slug' && pair.walkthrough.exists) {
    throw new Error('fresh-slug requires a new request.slug that resolves to a missing walkthrough.');
  }
  const overwrite = request.decision === 'overwrite';
  if (!pair.walkthrough.exists || overwrite) {
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
    writeNewWalkthrough(walkthroughPath, renderWalkthrough({
      summary: request.summary,
      paths: gitSnapshot.paths,
      verification: request.verification,
    }), { overwrite });
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
    status: !persisted ? 'legacy' : contentChanged || gitChanged ? 'changed' : 'current',
    changedPaths,
    bodyOnly: contentChanged && !gitChanged && changedPaths.length === 0,
  };
  if (
    !generated &&
    !persisted &&
    pair.walkthrough.tier === 'scratch-existing' &&
    !request.artifactOwned &&
    !request.decision
  ) {
    return {
      schemaVersion: 1,
      kind: 'code',
      action,
      status: 'decision-required',
      decision: 'legacy-walkthrough-coverage',
      choices: ['overwrite', 'as-is', 'fresh-slug'],
      artifact: {
        canonicalPath: toManifestPath(walkthroughPath, repoRoot),
        tier: pair.walkthrough.tier,
        slug: pair.slug,
      },
      freshness,
      reviewRange: scopeResult,
      cleanupPaths: [],
    };
  }

  const scan = scanResolutionLog(walkthrough.source, { strict: true });
  const { roundId, round } = parseRound(request.roundId, scan);
  const mode = request.mode ?? 'standalone';
  const reviewMode = request.reviewMode ?? 'full';
  if (reviewMode === 'rebuttal' && !request.findingPacketPath) {
    throw new Error('rebuttal review requires findingPacketPath.');
  }
  const cleanupPaths = [];
  let reviewPath = walkthroughPath;
  if (walkthrough.metadata || round > 1 || reviewMode === 'rebuttal') {
    const view = createReviewView({ artifact: walkthroughPath, nextRound: round });
    reviewPath = view.viewPath;
    cleanupPaths.push(view.cleanupPath);
  }
  let planReviewPath = pair.plan.exists ? path.resolve(repoRoot, pair.plan.path) : null;
  if (planReviewPath) {
    const planScan = scanResolutionLog(fs.readFileSync(planReviewPath, 'utf8'), { strict: true });
    if (planScan.rounds.length > 0) {
      const planView = createReviewView({
        artifact: planReviewPath,
        nextRound: (planScan.rounds.at(-1)?.number ?? 0) + 1,
      });
      planReviewPath = planView.viewPath;
      cleanupPaths.push(planView.cleanupPath);
    }
  }
  const derivedScope = reviewMode === 'rebuttal'
    ? `Finding keys only: ${(request.findingKeys ?? []).join(', ')}`
    : round === 1
      ? scopeResult.reviewScope
      : freshness.bodyOnly
        ? `Re-review round ${round} — walkthrough body changed; review full selected range (${scopeResult.reviewScope})`
        : `Re-review round ${round} — changed paths: ${reReviewPaths.join(', ') || 'review resolutions only'}; ${scopeResult.reviewScope}`;
  const scope = request.reviewScope ? `${derivedScope}; ${request.reviewScope}` : derivedScope;
  const prompt = reviewMode === 'full'
    ? loadPrompt('prompt-template.md', {
      'Task Summary': request.summary ?? walkthrough.body.match(/^# Walkthrough — (.+)$/m)?.[1] ?? 'Review the changes',
      'Walkthrough Path': toManifestPath(reviewPath, repoRoot),
      'Plan Path': toManifestPath(planReviewPath, repoRoot) ?? 'None',
      'User Focus Areas': request.focus ?? 'General review',
      'Review Scope': scope,
      'Tool Turn Budget': request.toolTurnBudget ?? 'Unspecified',
    })
    : loadPrompt('rebuttal-template.md', {
      'Walkthrough Path': toManifestPath(reviewPath, repoRoot),
      'Plan Path': toManifestPath(planReviewPath, repoRoot) ?? 'None',
      'Finding Packet Path': request.findingPacketPath,
      'Review Scope': scope,
      'Tool Turn Budget': request.toolTurnBudget ?? 'Unspecified',
    });

  const targets = request.targets ?? [];
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
    });
  }
  const files = createDispatchFiles({
    prompt,
    batch: mode === 'orchestrated' ? { targets, reserves: request.reserves ?? [] } : null,
    attachments: [
      reviewPath,
      ...(planReviewPath ? [planReviewPath] : []),
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
  process.stdout.write(`${JSON.stringify(prepareCodeReview(readJsonRequest(args.request)), null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[prepare-review] ${err.message}\n`);
    process.exit(1);
  }
}
