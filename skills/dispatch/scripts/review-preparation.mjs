import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { verifySkillIntegrity } from './common.mjs';
import { RESPONSE_SCHEMA_PROVIDERS } from './dispatch.mjs';
import {
  scanResolutionLog,
  splitDispatchFrontmatter,
  withDispatchFrontmatter,
} from './resolution-log.mjs';

const MAX_REQUEST_BYTES = 64 * 1024;
const METADATA_KEYS = new Set([
  'schemaVersion',
  'kind',
  'slug',
  'invocationId',
  'baseSha',
  'headSha',
  'worktreeHash',
  'contentHash',
  'sectionHashes',
  'pathHashes',
  'reviewedAt',
  'approvedContentHash',
  'approvedAt',
]);

export function requireNode22(version = process.versions.node) {
  const major = Number.parseInt(String(version).split('.')[0], 10);
  if (!Number.isSafeInteger(major) || major < 22) {
    throw new Error(`Node.js 22+ is required; current runtime is ${version}.`);
  }
}

export function assertPreparationIntegrity(ownerDir, dispatchDir) {
  for (const [label, dir] of [['owner', ownerDir], ['dispatch', dispatchDir]]) {
    const result = verifySkillIntegrity(dir);
    if (!result.valid && !result.missing) {
      throw new Error(`${label} skill integrity failure: ${result.violations.join(', ')}`);
    }
  }
}

function assertRegularJsonFile(file, label) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file, not a symbolic link.`);
  }
  if (stat.size > MAX_REQUEST_BYTES) {
    throw new Error(`${label} exceeds ${MAX_REQUEST_BYTES / 1024} KiB.`);
  }
  return resolved;
}

export function readJsonRequest(source, { stdin = process.stdin } = {}) {
  if (!source) throw new Error('--request <json-file|-> is required.');
  let raw;
  let label;
  if (source === '-') {
    if (stdin.isTTY) throw new Error('--request - requires a JSON object on stdin.');
    raw = fs.readFileSync(0, 'utf8');
    label = 'request stdin';
    if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) {
      throw new Error(`request stdin exceeds ${MAX_REQUEST_BYTES / 1024} KiB.`);
    }
  } else {
    const resolved = assertRegularJsonFile(source, 'request file');
    raw = fs.readFileSync(resolved, 'utf8');
    label = `request file ${resolved}`;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${label} must contain one JSON object.`);
  }
  return parsed;
}

// Guessed request fields seen in practice; a hint is offered only when the receiver accepts it.
export const FIELD_HINTS = Object.freeze({
  plan: 'artifactPath',
  planFile: 'artifactPath',
  walkthrough: 'walkthroughPath',
  round: 'roundId',
  context: 'invocationContext',
});

function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

function fieldHint(key, allowed, hints) {
  if (Object.hasOwn(hints, key) && allowed.includes(hints[key])) return hints[key];
  let best = null;
  let bestDistance = 3;
  for (const candidate of allowed) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) [best, bestDistance] = [candidate, distance];
  }
  return best;
}

export function assertObjectKeys(value, allowed, label, hints = {}) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${label} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const hint = fieldHint(key, allowed, hints);
      throw new Error(`${label} contains unsupported field "${key}"${hint ? `; did you mean "${hint}"?` : ''}; allowed: ${allowed.join(', ')}.`);
    }
  }
}

export function normalizeText(value) {
  return String(value ?? '').normalize('NFC').replace(/\r\n?/g, '\n');
}

export function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(normalizeText(value), 'utf8').digest('hex')}`;
}

export function rawSha256(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')}`;
}

export function changedKeys(previous = {}, current = {}) {
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter((key) => previous[key] !== current[key])
    .sort();
}

// SECTION: checkpoint diagnostics
// Checkpoint is the last write of a settled run, so a rejection must name the delta and the one
// legal recovery. Observed state is authoritative: the caller corrects its declaration, never the
// repository. The `do not match observed` head is load-bearing for existing callers and tests.

const orNone = (entries) => (entries.length > 0 ? entries.join(', ') : 'none');
const RESOLUTION_LOG_SECTION = 'Review Findings & Resolutions';

// Write subjects phrase the delta as change state; bare "missing" read as "you forgot this" when the
// fix was to drop the entry. Source keys are not changes, so they keep missing/unexpected.
export function settledWritesMismatch(label, subject, observed, declared) {
  const missing = declared.filter((entry) => !observed.includes(entry));
  const unexpected = observed.filter((entry) => !declared.includes(entry));
  const delta = subject === 'invocation targets'
    ? `missing: ${orNone(missing)}; unexpected: ${orNone(unexpected)}`
    : `declared but unchanged: ${orNone(missing)}; changed but undeclared: ${orNone(unexpected)}`;
  const hint = missing.includes(RESOLUTION_LOG_SECTION)
    ? ' The resolution-log section is excluded from settled writes.'
    : '';
  return `${label} do not match observed ${subject} — ${delta}. Resend checkpoint with ${label} set to ` +
    `${JSON.stringify(observed)}; rerun preparation instead if the workspace changed after adjudication.${hint}`;
}

export function checkpointDriftRemedy(detail) {
  return `${detail} Rerun preparation; the prior checkpoint is retained.`;
}

export function validateDispatchMetadata(metadata, { kind = null, slug = null } = {}) {
  if (metadata === null) return null;
  assertObjectKeys(metadata, [...METADATA_KEYS], 'dispatch metadata');
  if (metadata.schemaVersion !== 1) throw new Error(`Unsupported dispatch metadata schemaVersion "${metadata.schemaVersion}".`);
  if (!['plan', 'code', 'design'].includes(metadata.kind)) throw new Error('Dispatch metadata kind must be "plan", "code", or "design".');
  if (kind && metadata.kind !== kind) throw new Error(`Dispatch metadata kind "${metadata.kind}" does not match "${kind}".`);
  if (typeof metadata.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.slug)) {
    throw new Error('Dispatch metadata slug must be kebab-case.');
  }
  if (slug && metadata.slug !== slug) {
    throw new Error(`Dispatch metadata slug "${metadata.slug}" does not match resolved slug "${slug}".`);
  }
  if (typeof metadata.invocationId !== 'string' || metadata.invocationId.length < 8) {
    throw new Error('Dispatch metadata invocationId is required.');
  }
  if (
    typeof metadata.reviewedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(metadata.reviewedAt) ||
    Number.isNaN(Date.parse(metadata.reviewedAt))
  ) {
    throw new Error('Dispatch metadata reviewedAt must be an ISO timestamp.');
  }
  const canonicalTime = new Date(metadata.reviewedAt).toISOString();
  if (metadata.reviewedAt !== canonicalTime && metadata.reviewedAt !== canonicalTime.replace('.000Z', 'Z')) {
    throw new Error('Dispatch metadata reviewedAt must be a canonical UTC timestamp.');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(metadata.contentHash ?? '')) {
    throw new Error('Dispatch metadata contentHash is required.');
  }
  if (metadata.kind === 'design' && !metadata.sectionHashes) {
    throw new Error('Design dispatch metadata requires sectionHashes.');
  }
  if (metadata.kind === 'plan' && !metadata.sectionHashes) {
    throw new Error('Plan dispatch metadata requires sectionHashes.');
  }
  if (metadata.kind === 'design') {
    if (metadata.approvedContentHash !== undefined && metadata.approvedContentHash !== null && !/^sha256:[a-f0-9]{64}$/.test(metadata.approvedContentHash)) {
      throw new Error('Design approvedContentHash must be a SHA-256 digest or null.');
    }
    if (metadata.approvedAt !== undefined && metadata.approvedAt !== null) {
      if (typeof metadata.approvedAt !== 'string' || new Date(metadata.approvedAt).toISOString() !== metadata.approvedAt) {
        throw new Error('Design approvedAt must be a canonical UTC timestamp or null.');
      }
    }
  } else if ('approvedContentHash' in metadata || 'approvedAt' in metadata) {
    throw new Error('Only design dispatch metadata may contain approval fields.');
  }
  if (metadata.kind === 'code') {
    if (!metadata.pathHashes) throw new Error('Code dispatch metadata requires pathHashes.');
    for (const key of ['baseSha', 'headSha']) {
      if (metadata[key] !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(metadata[key] ?? '')) {
        throw new Error(`Code dispatch metadata ${key} must be a commit SHA or null.`);
      }
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(metadata.worktreeHash ?? '')) {
      throw new Error('Code dispatch metadata worktreeHash is required.');
    }
  }
  for (const key of ['contentHash', 'worktreeHash']) {
    if (metadata[key] !== undefined && !/^sha256:[a-f0-9]{64}$/.test(metadata[key])) {
      throw new Error(`Dispatch metadata ${key} must be a SHA-256 digest.`);
    }
  }
  for (const key of ['sectionHashes', 'pathHashes']) {
    if (metadata[key] === undefined) continue;
    if (!metadata[key] || Array.isArray(metadata[key]) || typeof metadata[key] !== 'object') {
      throw new Error(`Dispatch metadata ${key} must be an object.`);
    }
    if (Object.keys(metadata[key]).length === 0) {
      throw new Error(`Dispatch metadata ${key} must not be empty.`);
    }
    for (const [name, digest] of Object.entries(metadata[key])) {
      if (!name || path.isAbsolute(name) || name.split(/[\\/]/).includes('..') || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
        throw new Error(`Dispatch metadata ${key}.${name} must be a SHA-256 digest.`);
      }
    }
  }
  if (metadata.kind === 'plan' && ('pathHashes' in metadata || 'worktreeHash' in metadata || 'baseSha' in metadata || 'headSha' in metadata)) {
    throw new Error('Plan dispatch metadata contains code-only fields.');
  }
  if (metadata.kind === 'code' && 'sectionHashes' in metadata) {
    throw new Error('Code dispatch metadata contains plan-only fields.');
  }
  if (metadata.kind === 'design' && ('pathHashes' in metadata || 'worktreeHash' in metadata || 'baseSha' in metadata || 'headSha' in metadata)) {
    throw new Error('Design dispatch metadata contains code-only fields.');
  }
  return metadata;
}

export function readArtifact(file, expected = {}) {
  const resolved = path.resolve(file);
  const source = fs.readFileSync(resolved, 'utf8');
  const split = splitDispatchFrontmatter(source);
  return {
    path: resolved,
    source,
    body: split.body,
    metadata: validateDispatchMetadata(split.metadata, expected),
    documentHash: rawSha256(source),
  };
}

export function writeArtifactMetadata(file, metadata, { expectedDocumentHash = null } = {}) {
  const resolved = path.resolve(file);
  const lock = path.join(os.tmpdir(), `dispatch-metadata-${rawSha256(resolved).slice(7)}.lock`);
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (err) {
    if (err.code === 'EEXIST') {
      const age = Date.now() - fs.statSync(lock).mtimeMs;
      if (age > 10 * 60 * 1000) {
        fs.rmSync(lock, { recursive: true, force: true });
        fs.mkdirSync(lock, { mode: 0o700 });
      } else {
        throw new Error(`Artifact metadata checkpoint is already in progress; remove stale lock ${lock} after ten minutes.`);
      }
    } else {
      throw err;
    }
  }
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Artifact must be a regular file.');
    const source = fs.readFileSync(resolved, 'utf8');
    if (expectedDocumentHash && rawSha256(source) !== expectedDocumentHash) {
      throw new Error('Artifact changed before metadata checkpoint; rerun preparation.');
    }
    validateDispatchMetadata(metadata, { kind: metadata.kind, slug: metadata.slug });
    const next = withDispatchFrontmatter(source, metadata);
    const temp = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temp, next, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      safeRenameSync(temp, resolved);
    } finally {
      if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
    }
    return { path: resolved, documentHash: rawSha256(next) };
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function summaryLine(round) {
  const { accepted, rejected, resolvedDispute, disputed, pendingConfirmation, unknown } = round.counts;
  return `- R${round.number} settled accepted=${accepted} rejected=${rejected} resolved=${resolvedDispute} disputed=${disputed + pendingConfirmation} unknown=${unknown} hash=${round.hash.slice(0, 12)}`;
}

function withoutSourceMap(roundText) {
  return roundText.split('\n').filter((line) => !/^\s*[-*]\s+\*\*Sources:\*\*/.test(line)).join('\n');
}

export function buildReviewView(markdown, { canonicalPath, nextRound }) {
  if (!Number.isSafeInteger(nextRound) || nextRound < 1) throw new Error('nextRound must be a positive integer.');
  const scan = scanResolutionLog(markdown, { strict: true });
  const expectedRound = (scan.rounds.at(-1)?.number ?? 0) + 1;
  if (nextRound !== expectedRound) {
    throw new Error(`nextRound ${nextRound} does not follow canonical round ${expectedRound - 1}.`);
  }
  const previous = scan.rounds.at(-1) ?? null;
  const older = previous ? scan.rounds.slice(0, -1) : [];
  const summaries = older.filter((round) =>
    round.counts.disputed === 0 && round.counts.pendingConfirmation === 0);
  const live = older.flatMap((round) =>
    round.entries
      .filter((entry) => entry.status === 'disputed' || entry.status === 'pendingConfirmation')
      .map((entry) => `- R${round.number}: ${entry.line.replace(/^\s*[-*]\s+/, '')}`));
  const parts = [
    '> Bounded read-only review projection.',
    `> Canonical artifact: ${canonicalPath}`,
    '> Apply adjudication and edits only to the canonical artifact.',
    '',
    scan.semanticBody,
    '',
    '## Review Findings & Resolutions (bounded view)',
  ];
  if (summaries.length) parts.push('', '### Older settled rounds', '', ...summaries.map(summaryLine));
  if (live.length) parts.push('', '### Live findings from older rounds', '', ...live);
  if (previous) parts.push('', '### Immediately preceding round', '', withoutSourceMap(previous.text));
  return {
    contents: `${parts.join('\n').trim()}\n`,
    sourceRoundCount: scan.rounds.length,
    canonicalLogHash: scan.canonicalLogHash,
  };
}

export function createTempFile(prefix, filename, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, filename);
  fs.writeFileSync(file, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { path: file, cleanupPath: dir };
}

export function createReviewView({ artifact, nextRound }) {
  const built = buildReviewView(fs.readFileSync(artifact, 'utf8'), {
    canonicalPath: artifact,
    nextRound,
  });
  const written = createTempFile(
    'dispatch-review-view-',
    `${path.basename(artifact, path.extname(artifact))}-review-view.md`,
    built.contents,
  );
  return { ...built, viewPath: written.path, cleanupPath: written.cleanupPath };
}

function contextFor(state) {
  return {
    schemaVersion: 1,
    invocationId: state.invocationId,
    statePath: state.statePath,
    generation: state.generation,
    token: state.token,
  };
}

function safeRenameSync(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err?.code === 'EPERM' && process.platform === 'win32') {
      fs.rmSync(dest, { force: true });
      fs.renameSync(src, dest);
    } else {
      throw err;
    }
  }
}

function writeState(state, { exclusive = false } = {}) {
  const temp = `${state.statePath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    if (exclusive) fs.linkSync(temp, state.statePath);
    else safeRenameSync(temp, state.statePath);
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
}

export function createInvocationState({ kind, artifactPath, snapshot, expectedSourceKeys = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dispatch-${kind}-invocation-`));
  fs.chmodSync(dir, 0o700);
  const statePath = path.join(dir, 'state.json');
  const state = {
    schemaVersion: 1,
    invocationId: crypto.randomUUID(),
    statePath,
    generation: 0,
    token: crypto.randomBytes(24).toString('hex'),
    status: 'active',
    kind,
    artifactPath: path.resolve(artifactPath),
    expectedSourceKeys: [...expectedSourceKeys].sort(),
    snapshot,
    initialMetadata: readArtifact(artifactPath).metadata,
  };
  writeState(state, { exclusive: true });
  return { context: contextFor(state), cleanupPath: dir };
}

// Containment is checked lexically first so a forged missing path never earns the recovery hint.
function missingInvocationState(resolved, tempRoot) {
  const dir = path.dirname(resolved);
  let container;
  try {
    container = fs.realpathSync(path.dirname(dir));
  } catch {
    return new Error('invocationContext statePath is invalid.');
  }
  if (
    container !== tempRoot ||
    path.basename(resolved) !== 'state.json' ||
    !/^dispatch-(?:plan|code|design)-invocation-/.test(path.basename(dir))
  ) return new Error('invocationContext statePath is invalid.');
  return new Error(
    `Invocation state ${dir} no longer exists; it was removed before checkpoint. The prior checkpoint ` +
    'is retained. Remove invocationCleanupPath only after checkpoint or abort; rerun preparation to ' +
    'start a fresh invocation.',
  );
}

export function readInvocationState(context) {
  assertObjectKeys(context, ['schemaVersion', 'invocationId', 'statePath', 'generation', 'token'], 'invocationContext');
  if (context.schemaVersion !== 1) throw new Error('Unsupported invocationContext schemaVersion.');
  const resolved = path.resolve(context.statePath);
  const tempRoot = fs.realpathSync(os.tmpdir());
  // NOTE: lstat-based so a dangling symlink still reaches the symlink rejection below.
  let present = true;
  try {
    fs.lstatSync(resolved);
  } catch {
    present = false;
  }
  if (!present) throw missingInvocationState(resolved, tempRoot);
  const parent = fs.realpathSync(path.dirname(resolved));
  if (parent !== tempRoot && !parent.startsWith(`${tempRoot}${path.sep}`)) {
    throw new Error('invocationContext statePath must be beneath OS temp.');
  }
  let stat;
  let parentStat;
  try {
    stat = fs.lstatSync(resolved);
    parentStat = fs.lstatSync(parent);
  } catch {
    throw new Error('invocationContext statePath is invalid.');
  }
  if (
    stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 ||
    parentStat.isSymbolicLink() || !parentStat.isDirectory() ||
    !/^dispatch-(?:plan|code|design)-invocation-/.test(path.basename(parent))
  ) throw new Error('invocationContext statePath is invalid.');
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (parentStat.mode & 0o077) !== 0)) {
    throw new Error('invocationContext state must be owner-only.');
  }
  const state = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (
    path.resolve(state.statePath ?? '') !== resolved ||
    state.status !== 'active' ||
    state.invocationId !== context.invocationId ||
    state.generation !== context.generation ||
    state.token !== context.token
  ) {
    throw new Error('Invocation context is stale, replayed, forked, or already completed.');
  }
  return state;
}

export function advanceInvocationState(context, updates = {}) {
  readInvocationState(context);
  const lock = `${path.resolve(context.statePath)}.lock`;
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (err) {
    if (err.code === 'EEXIST') throw new Error('Invocation context transition is already in progress.');
    throw err;
  }
  try {
    const state = readInvocationState(context);
    const normalized = updates.expectedSourceKeys
      ? { ...updates, expectedSourceKeys: [...new Set(updates.expectedSourceKeys)].sort() }
      : updates;
    const next = {
      ...state,
      ...normalized,
      generation: state.generation + 1,
      token: crypto.randomBytes(24).toString('hex'),
    };
    writeState(next);
    return { state: next, context: contextFor(next), cleanupPath: path.dirname(next.statePath) };
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export function completeInvocationState(context) {
  const advanced = advanceInvocationState(context, { status: 'complete' });
  return { state: advanced.state, cleanupPath: advanced.cleanupPath };
}

/** Fence-aware removal of one `## <section>` block: a fenced `## <section>` heading inside a
 *  code fence never starts a section. A fenced `## ` line inside the excluded section fails
 *  closed: a stray fence pairing with a later one would otherwise hide governed sections. */
function stripExcludedSection(body, section) {
  const lines = body.split('\n');
  const out = [];
  let fence = null;
  let skipping = false;
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    }
    if (!fence && !skipping && /^##\s+/.test(line)) {
      const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`^##\\s+${escaped}\\s*$`).test(line)) { skipping = true; continue; }
    }
    if (skipping) {
      if (fence && /^##\s/.test(line)) throw new Error(`Fenced \`## \` heading inside ## ${section}`);
      if (!fence && /^##\s/.test(line)) skipping = false;
      else continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

export function semanticSectionHashes(source, { excludedSections = [] } = {}) {
  let body = scanResolutionLog(source, { strict: true }).semanticBody;
  for (const section of excludedSections) {
    body = stripExcludedSection(body, section);
  }
  if (excludedSections.length > 0) {
    body = body.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  }
  const sections = {};
  const headingCounts = new Map();
  let fence = null;
  let current = '__preamble__';
  let buffer = [];
  const flush = () => {
    if (buffer.length > 0) sections[current] = sha256(buffer.join('\n').replace(/\s+$/, ''));
    buffer = [];
  };
  for (const line of body.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    }
    const heading = !fence && /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const rawHeading = heading[1];
      const count = (headingCounts.get(rawHeading) ?? 0) + 1;
      headingCounts.set(rawHeading, count);
      current = count === 1 ? rawHeading : `${rawHeading}#${count}`;
    }
    buffer.push(line);
  }
  flush();
  return { contentHash: sha256(body), sectionHashes: sections };
}

/** Shared governed-design excerpt: strips the dispatch frontmatter, the resolution log, and
 *  `## Execution Status` (fence-aware at both boundaries), then bounds the remaining governed
 *  content per section (each heading plus its first lines) and pairs the excerpt with the
 *  explicit approved revision and the recomputed governed hash. */
export function governingDesignExcerpt(source, { revision = null, maxChars = 4000, maxLinesPerSection = 12 } = {}) {
  const { contentHash } = semanticSectionHashes(source, { excludedSections: ['Execution Status'] });
  const semantic = scanResolutionLog(source, { strict: false }).semanticBody;
  const withoutFrontmatter = semantic.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const lines = withoutFrontmatter.split('\n');
  const excerptLines = [];
  let fence = null;
  let skipping = false;
  let linesInSection = 0;
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    }
    if (!fence && !skipping && /^##\s+Execution Status\s*$/.test(line)) { skipping = true; continue; }
    if (skipping) {
      if (!fence && /^##\s/.test(line)) skipping = false;
      else continue;
    }
    if (/^##\s/.test(line) && !fence) {
      excerptLines.push('');
      linesInSection = 0;
    } else if (!fence && ++linesInSection > maxLinesPerSection) {
      continue;
    }
    excerptLines.push(line);
    if (excerptLines.join('\n').length >= maxChars) break;
  }
  let excerpt = excerptLines.join('\n').replace(/\s+$/, '');
  if (excerpt.length > maxChars) excerpt = `${excerpt.slice(0, maxChars)}…`;
  return { revision, governedHash: contentHash, excerpt };
}

export function createDispatchFiles({
  prompt,
  batch = null,
  attachments,
  responseSchemaPath,
  selector = null,
  dispatchScriptPath,
  orchestrator = null,
  orchestratorModel = null,
}) {
  const promptFile = createTempFile('dispatch-review-prompt-', 'prompt.md', prompt);
  const cleanupPaths = [promptFile.cleanupPath];
  const argv = [process.execPath, path.resolve(dispatchScriptPath)];
  if (batch) {
    const batchFile = createTempFile('dispatch-review-batch-', 'batch.json', `${JSON.stringify(batch, null, 2)}\n`);
    cleanupPaths.push(batchFile.cleanupPath);
    argv.push('--batch-file', batchFile.path);
  } else if (selector) {
    if (selector.provider) argv.push('--provider', selector.provider);
    if (selector.candidateIndex !== undefined) argv.push('--candidate-index', String(selector.candidateIndex));
    if (selector.model) argv.push('--model', selector.model);
    if (selector.effort) argv.push('--effort', selector.effort);
  }
  const supportsSchema = batch || !selector || !selector.provider || RESPONSE_SCHEMA_PROVIDERS.has(selector.provider);
  if (supportsSchema) {
    argv.push('--response-schema-file', path.resolve(responseSchemaPath));
  }
  argv.push('--prompt-file', promptFile.path);
  for (const attachment of attachments) argv.push('-f', attachment);
  if (orchestrator) argv.push('--orchestrator', orchestrator);
  if (orchestratorModel) argv.push('--orchestrator-model', orchestratorModel);
  const outputFile = createTempFile('dispatch-review-output-', 'output.txt', '');
  cleanupPaths.push(outputFile.cleanupPath);
  argv.push('--output-file', outputFile.path);
  return {
    promptPath: promptFile.path,
    dispatch: { argv, outputPath: outputFile.path },
    cleanupPaths,
  };
}
