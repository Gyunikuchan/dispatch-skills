// @ts-check
/**
 * The only builder of session file names (ADR 0003): root deliverables `<slug>.<type>.md`, machine
 * state under `.state/`, and flat run files named `<scope>.<kind>.<ext>`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { sessionDir } from './session-temp.mjs';

export const STATE_DIR = '.state';
export const SLUG_MAX = 40;
/** `<design-slug>-i<nn>-<slug>` or `<design-slug>-integration`; each slug is capped separately. */
const COMPOUND = /^([a-z0-9]+(?:-[a-z0-9]+)*?)-(?:i\d{2}-([a-z0-9]+(?:-[a-z0-9]+)*)|integration)$/;
export const DELIVERABLE_TYPES = Object.freeze(['spec', 'design', 'plan', 'walkthrough', 'report']);
export const RUN_KINDS = Object.freeze(['ask', 'plan', 'design', 'implement', 'plan-review', 'code-review', 'design-review']);
export const KINDS = Object.freeze(new Set([
  'prompt', 'view', 'batch', 'output', 'drive', 'rulings', 'verify', 'evidence', 'rebuttal', 'packet',
  'brief', 'report', 'trace', 'outcome', 'invocation', 'slots', 'state', 'inputs',
]));
export const EXTENSIONS = Object.freeze(['md', 'json', 'jsonl', 'log']);
export const RUN_ID_PATTERN = new RegExp(`^\\d{3}-(?:${RUN_KINDS.join('|')})$`);

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_RUNS = 999;

// SECTION: Validation

/** @param {unknown} value @param {string} label */
function positive(value, label) {
  if (!Number.isInteger(value) || /** @type {number} */ (value) < 1) throw new Error(`Invalid ${label} "${value}"; expected a positive integer.`);
  return /** @type {number} */ (value);
}

/** @param {unknown} value @param {string} label */
function kebab(value, label) {
  if (typeof value !== 'string' || !KEBAB.test(value)) throw new Error(`Invalid ${label} "${value}"; expected kebab-case.`);
  return value;
}

/** Truncates a kebab slug to `SLUG_MAX` characters at a word boundary. */
/** @param {string} slug */
export function truncateSlug(slug) {
  if (slug.length <= SLUG_MAX) return slug;
  const cut = slug.slice(0, SLUG_MAX + 1);
  const boundary = cut.lastIndexOf('-');
  return (boundary > 0 ? cut.slice(0, boundary) : slug.slice(0, SLUG_MAX)).replace(/-+$/, '');
}

/** Creates `child` under `parent`, refusing symlinks and escapes. */
/** @param {string} parent @param {string} child */
function ensureDirectory(parent, child) {
  const dir = path.join(parent, child);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe dispatch directory: ${dir}`);
  const real = fs.realpathSync(dir);
  const relative = path.relative(fs.realpathSync(parent), real);
  if (relative !== path.normalize(child) || path.isAbsolute(relative)) throw new Error(`Dispatch directory escaped its owner: ${dir}`);
  return real;
}

// SECTION: Session-level paths

/** Root deliverable `<slug>.<type>.md`. */
/** @param {string} slug @param {string} type @param {{ root?: string }} [options] */
export function deliverable(slug, type, { root = sessionDir() } = {}) {
  kebab(slug, 'deliverable slug');
  if (slug.length > SLUG_MAX) throw new Error(`Deliverable slug "${slug}" exceeds ${SLUG_MAX} characters.`);
  if (!DELIVERABLE_TYPES.includes(type)) throw new Error(`Unknown deliverable type "${type}".`);
  return path.join(root, `${slug}.${type}.md`);
}

/**
 * The deliverable a subject authors into. `.state/deliverables.json` records each name's subject:
 * the same subject reuses its file, and a different subject advances to `<slug>-2`, `<slug>-3`, …,
 * trimming the base to stay within SLUG_MAX. An unrecorded existing file is reused.
 * @param {string} slug @param {string} type @param {string} subject @param {{ root?: string }} [options]
 */
export function claimDeliverable(slug, type, subject, { root = sessionDir() } = {}) {
  const registry = stateFile('deliverables.json', root);
  /** @type {Record<string, string>} */
  const claims = fs.existsSync(registry) ? JSON.parse(fs.readFileSync(registry, 'utf8')) : {};
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const file = deliverable(`${slug.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`, type, { root });
    const name = path.basename(file);
    const owner = claims[name];
    if (owner === subject || (owner === undefined && fs.existsSync(file))) return file;
    if (owner !== undefined) continue;
    claims[name] = subject;
    fs.writeFileSync(registry, `${JSON.stringify(claims, null, 2)}\n`);
    return file;
  }
}

/**
 * A compound deliverable (`<design-slug>-i<nn>-<slug>`, `<design-slug>-integration`): each part is a capped slug, so the whole may exceed SLUG_MAX.
 * @param {string} name @param {string} type @param {{ root?: string }} [options]
 */
export function compoundDeliverable(name, type, { root = sessionDir() } = {}) {
  const match = COMPOUND.exec(name);
  if (!match) throw new Error(`Compound deliverable name "${name}" must be <design-slug>-i<nn>-<slug> or <design-slug>-integration.`);
  // Mirrors parseIncrementArtifactPath: a second marker makes the split ambiguous.
  if (match[2] && /(^|-)i\d{2}(-|$)/.test(match[2])) throw new Error(`Compound deliverable name "${name}" is ambiguous: the increment slug contains a second -i<nn> marker.`);
  for (const part of match.slice(1).filter(Boolean)) {
    if (part.length > SLUG_MAX) throw new Error(`Compound deliverable slug "${part}" exceeds ${SLUG_MAX} characters.`);
  }
  if (!DELIVERABLE_TYPES.includes(type)) throw new Error(`Unknown deliverable type "${type}".`);
  return path.join(root, `${name}.${type}.md`);
}

/** `.state/`, created on demand. */
/** @param {string} [root] */
export function stateDir(root = sessionDir()) { return ensureDirectory(root, STATE_DIR); }

/** A single-writer file directly under `.state/` (ledgers, telemetry). */
/** @param {string} name @param {string} [root] */
export function stateFile(name, root = sessionDir()) {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(name) || name.includes('..')) throw new Error(`Invalid state file name "${name}".`);
  return path.join(stateDir(root), name);
}

/** An entry under `.state/cache/`. */
/** @param {string} name @param {string} [root] */
export function stateCache(name, root = sessionDir()) {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(name) || name.includes('..')) throw new Error(`Invalid cache entry name "${name}".`);
  return path.join(ensureDirectory(stateDir(root), 'cache'), name);
}

/** Creates `.state/cache/<prefix>-<n>/` exclusively with the next free `n`. */
/** @param {string} prefix @param {string} [root] */
export function createCacheDir(prefix, root = sessionDir()) {
  kebab(prefix, 'cache prefix');
  const cache = path.dirname(stateCache(prefix, root));
  for (let n = 1; ; n++) {
    const dir = path.join(cache, `${prefix}-${n}`);
    try { fs.mkdirSync(dir, { mode: 0o700 }); return fs.realpathSync(dir); }
    catch (error) { if (/** @type {any} */ (error).code !== 'EEXIST') throw error; }
  }
}

/** `.state/runs/`. */
/** @param {string} [root] */
export function runsDir(root = sessionDir()) { return ensureDirectory(stateDir(root), 'runs'); }

/** Allocates the next `NNN-<kind>` run folder exclusively. */
/** @param {string} kind @param {string} [root] */
export function createRun(kind, root = sessionDir()) {
  if (!RUN_KINDS.includes(kind)) throw new Error(`Unknown run kind "${kind}".`);
  const runs = runsDir(root);
  for (;;) {
    const highest = fs.readdirSync(runs).reduce((max, name) => {
      const match = /^(\d{3})-/.exec(name);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    const next = highest + 1;
    if (next > MAX_RUNS) throw new Error('Run sequence exhausted for this session.');
    const id = `${String(next).padStart(3, '0')}-${kind}`;
    const dir = path.join(runs, id);
    try { fs.mkdirSync(dir, { mode: 0o700 }); return { id, dir: fs.realpathSync(dir) }; }
    catch (error) { if (/** @type {any} */ (error).code !== 'EEXIST') throw error; }
  }
}

/** Existing or new folder of run `id`. */
/** @param {string} id @param {string} [root] */
export function runFolder(id, root = sessionDir()) {
  if (!RUN_ID_PATTERN.test(id)) throw new Error(`Invalid run id "${id}".`);
  return ensureDirectory(runsDir(root), id);
}

/** The run's orchestrator helper folder. */
/** @param {string} id @param {string} [root] */
export function runScratch(id, root = sessionDir()) { return ensureDirectory(runFolder(id, root), 'scratch'); }

// SECTION: Run file names

/**
 * @typedef {{ round?: number, stage?: number, provider?: string, slot?: number, qualifier?: string,
 *   attempt?: number, kind: string, ext: string }} RunFileSpec
 */

/** Builds `<scope>.<kind>.<ext>`; attempt 1 is the unsuffixed original. */
/** @param {RunFileSpec} spec */
export function runFileName({ round, stage, provider, slot, qualifier, attempt, kind, ext }) {
  if (!KINDS.has(kind)) throw new Error(`Unknown run file kind "${kind}".`);
  if (!EXTENSIONS.includes(ext)) throw new Error(`Unknown run file extension "${ext}".`);
  if (round !== undefined && stage !== undefined) throw new Error('A run file takes a round or a stage, not both.');
  const parts = [];
  if (round !== undefined) parts.push(`r${positive(round, 'round')}`);
  if (stage !== undefined) parts.push(`s${positive(stage, 'stage')}`);
  if ((provider === undefined) !== (slot === undefined)) throw new Error('Provider and slot are given together.');
  if (provider !== undefined) {
    if (!parts.length) throw new Error('A provider slot needs a round or stage scope.');
    parts.push(kebab(provider, 'provider'), String(positive(slot, 'slot')));
  }
  if (qualifier !== undefined) {
    if (!parts.length) throw new Error('A qualifier needs a round or stage scope.');
    parts.push(kebab(qualifier, 'qualifier'));
  }
  if (attempt !== undefined && positive(attempt, 'attempt') > 1) {
    if (!parts.length) throw new Error('An attempt needs a round or stage scope.');
    parts.push(`a${attempt}`);
  }
  return parts.length ? `${parts.join('-')}.${kind}.${ext}` : `${kind}.${ext}`;
}

/** Path of a single-writer run file; the caller rewrites it atomically. */
/** @param {string} id @param {RunFileSpec} spec @param {string} [root] */
export function runFilePath(id, spec, root = sessionDir()) { return path.join(runFolder(id, root), runFileName(spec)); }

/** First attempt path that is neither on disk nor in `taken`, for a file another writer creates later. */
/** @param {string} id @param {RunFileSpec} spec @param {string[]} [taken] @param {string} [root] */
export function freeRunFilePath(id, spec, taken = [], root = sessionDir()) {
  const dir = runFolder(id, root);
  const used = new Set(taken.map(file => path.resolve(file)));
  for (let attempt = spec.attempt ?? 1; ; attempt++) {
    const file = path.join(dir, runFileName({ ...spec, attempt }));
    if (!used.has(path.resolve(file)) && !fs.existsSync(file)) return file;
  }
}

/** Creates a run file exclusively, advancing `-a<N>` on collision; returns its path. */
/** @param {string} id @param {RunFileSpec & { contents?: string }} spec @param {string} [root] */
export function runFile(id, { contents = '', ...spec }, root = sessionDir()) {
  const dir = runFolder(id, root);
  for (let attempt = spec.attempt ?? 1; ; attempt++) {
    const file = path.join(dir, runFileName({ ...spec, attempt }));
    try { fs.writeFileSync(file, contents, { mode: 0o600, flag: 'wx' }); return file; }
    catch (error) { if (/** @type {any} */ (error).code !== 'EEXIST') throw error; }
  }
}
