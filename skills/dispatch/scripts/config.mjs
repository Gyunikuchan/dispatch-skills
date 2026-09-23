/**
 * Unified dispatch config: schema validation, v0.4 rejection, and level resolution.
 *
 * One config (`config.local.jsonc`, else `config.jsonc`) holds three tables:
 * - `read-delegates`  platform → candidate or ordered candidate array (required)
 * - `write-subagents` platform → native write-subagent fields (optional)
 * - `phases`          review phase → `targets`/`rounds`/`consensus` level maps + `only` (optional)
 *
 * Every level-keyed value resolves the same way: exact → nearest lower → lowest higher (an
 * entry's flat fields stand in for levels below its lowest override).
 * Pure except `detectLegacyConfig`/`loadDispatchConfig`, which probe the filesystem.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  KNOWN_PROVIDERS,
  PROVIDER_ALIASES,
  SANDBOX_SUPPORTED_PROVIDERS,
  loadSkillConfig,
  validateEffortSpec,
  validateModelSpec,
} from './common.mjs';

/** Policy and model tiers, lowest first. */
export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Review phases the `phases` table may configure, in workflow order. */
export const REVIEW_PHASES = ['plan-review', 'design-review', 'code-review'];

export const TABLES = ['read-delegates', 'write-subagents', 'phases'];
const PHASE_KNOBS = ['targets', 'rounds', 'consensus'];
const LEGACY_TOP_LEVEL_KEYS = ['platforms', 'plan-review', 'code-review', 'design-review', 'implementation'];
const DIFF_HINT = 'diff against config.sample.jsonc';

export const LEGACY_CONFIG_CODE = 'LEGACY_DISPATCH_CONFIG';

const LEGACY_SIBLING_DIR = 'implement-dispatch'; // v0.4 config probe: retired sibling config directory

/** The v0.4 → v0.5 key map; shipped text names the retired config generically. */
const LEGACY_KEY_MAP =
  'Key map: top-level platforms → read-delegates; per-section platforms → only (membership) plus ' +
  'read-delegates (models); targetCount → targets; maxRounds → rounds; consensus → consensus; ' +
  'implementation → write-subagents; the retired implement config is replaced by the phases and ' +
  `write-subagents tables here (${DIFF_HINT}).`;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/** Canonical provider key for a config key or alias; unknown keys pass through unchanged. */
export function normalizeProviderKey(key) {
  return PROVIDER_ALIASES[String(key).toLowerCase()] ?? key;
}

// ============================================================================
// SECTION: Level resolution
// ============================================================================

/**
 * Picks which defined level applies: exact → nearest defined below → lowest defined above.
 * Sorts its input, so `definedLevels` may come in any order.
 *
 * @param {string[]} definedLevels
 * @param {string} level
 * @returns {string | undefined}
 */
export function selectLevel(definedLevels, level) {
  if (definedLevels.length === 0) return undefined;
  const requestedIndex = LEVELS.indexOf(level);
  const ordered = [...definedLevels].sort((a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b));
  return (
    ordered.findLast(l => LEVELS.indexOf(l) <= requestedIndex) ??
    ordered.find(l => LEVELS.indexOf(l) > requestedIndex)
  );
}

/**
 * Resolves a level-keyed scalar (`targets`, `rounds`, `consensus`).
 *
 * @param {Record<string, unknown>} knob
 * @param {string} level
 * @returns {unknown | undefined}
 */
export function resolveLevelScalar(knob, level) {
  if (!isPlainObject(knob)) return undefined;
  const chosen = selectLevel(LEVELS.filter(l => knob[l] !== undefined), level);
  return chosen === undefined ? undefined : knob[chosen];
}

/** Level key whose override applies to `entry` at `level`, or null (see chooseOverride). */
export function selectedLevelKey(entry, level) {
  if (!isPlainObject(entry)) return null;
  const isScalarKnob = !Object.keys(entry).some(k => !LEVELS.includes(k));
  if (isScalarKnob) return selectLevel(LEVELS.filter(l => entry[l] !== undefined), level) ?? null;
  return chooseOverride(entry, level, value => !!value && typeof value === 'object', pickFields(entry, CANDIDATE_FIELDS)) ?? null;
}

function pickFields(source, fields) {
  const picked = {};
  if (!isPlainObject(source)) return picked;
  for (const field of fields) {
    if (source[field] !== undefined) picked[field] = source[field];
  }
  return picked;
}

const CANDIDATE_FIELDS = ['model', 'effort', 'sandbox'];

/**
 * Level override that applies to an entry. Flat fields act as the entry's baseline, so the
 * lowest-higher fallback applies only to entries without any: `{ model: a, high: {...} }` at
 * `low` resolves `a`, while `{ high: {...} }` at `low` resolves the `high` override.
 */
function chooseOverride(entry, level, isOverride, base) {
  const defined = LEVELS.filter(l => isOverride(entry[l]));
  const chosen = selectLevel(defined, level);
  if (chosen === undefined) return undefined;
  const fellUpward = LEVELS.indexOf(chosen) > LEVELS.indexOf(level);
  return fellUpward && Object.keys(base).length > 0 ? undefined : chosen;
}

const WRITE_FIELDS = ['model', 'effort'];

/**
 * Resolves one write-subagent entry's `model`/`effort` at `level` (object overrides only).
 *
 * @param {object} entry
 * @param {string} level
 * @returns {{ model?: string | string[], effort?: string }}
 */
export function resolveLevelEntry(entry, level) {
  if (!isPlainObject(entry)) return {};
  const base = pickFields(entry, WRITE_FIELDS);
  const chosen = chooseOverride(entry, level, isPlainObject, base);
  if (chosen === undefined) return base;
  return { ...base, ...pickFields(entry[chosen], WRITE_FIELDS) };
}

/**
 * Resolves one read-delegate entry (candidate or candidate array) to its ordered candidates at
 * `level`. A level override may be an object or a candidate array; each inherits the base fields.
 *
 * @param {object | object[]} entry
 * @param {string} level
 * @returns {Array<{ model?: string | string[], effort?: string, sandbox?: boolean }>}
 */
export function resolvePlatformCandidates(entry, level) {
  if (!entry) return [];
  if (Array.isArray(entry)) return entry.flatMap(item => resolvePlatformCandidates(item, level));
  if (typeof entry !== 'object') return [];

  const base = pickFields(entry, CANDIDATE_FIELDS);
  const chosen = chooseOverride(entry, level, value => !!value && typeof value === 'object', base);
  if (chosen === undefined) return [base];
  const override = entry[chosen];
  const items = Array.isArray(override) ? override : [override];
  return items.map(item => ({ ...base, ...pickFields(item, CANDIDATE_FIELDS) }));
}

/**
 * Level-resolved read delegates, canonical keys in config order.
 *
 * @param {object} config
 * @param {string} level
 * @returns {{ platforms: Record<string, object[]> }}
 */
export function resolveReadDelegates(config, level) {
  const platforms = {};
  for (const [key, entry] of Object.entries(config?.['read-delegates'] ?? {})) {
    platforms[normalizeProviderKey(key)] = resolvePlatformCandidates(entry, level);
  }
  return { platforms };
}

/**
 * Canonical read-delegate keys a phase may target: filtered by its `only`, in read-delegate order.
 *
 * @param {object} config
 * @param {string} phase
 * @returns {string[]}
 */
export function phaseMembers(config, phase) {
  const keys = Object.keys(config?.['read-delegates'] ?? {}).map(normalizeProviderKey);
  const only = config?.phases?.[phase]?.only;
  if (!Array.isArray(only)) return keys;
  const allowed = new Set(only.map(normalizeProviderKey));
  return keys.filter(key => allowed.has(key));
}

// ============================================================================
// SECTION: Validation
// ============================================================================

function validateModel(where, value, problems) {
  try {
    if (value === null || value === undefined) throw new Error('missing');
    validateModelSpec(value, `${where}.model`);
  } catch {
    problems.push(`${where}.model must be a string or array of strings (${DIFF_HINT}).`);
  }
}

function validateEffort(where, value, problems) {
  try {
    if (typeof value !== 'string') throw new Error('not a string');
    validateEffortSpec(value, `${where}.effort`);
  } catch {
    problems.push(`${where}.effort must be a string and not blank (${DIFF_HINT}).`);
  }
}

/** Validates a flat candidate (no level keys): model, effort, and sandbox where supported. */
function validateCandidate(where, value, fields, problems) {
  if (!isPlainObject(value)) {
    problems.push(`${where} must be an object with ${fields.join('/')} (${DIFF_HINT}).`);
    return;
  }
  if (Object.keys(value).length === 0) {
    problems.push(`${where} must set at least one of ${fields.join(', ')} (${DIFF_HINT}).`);
  }
  for (const [field, fieldValue] of Object.entries(value)) {
    validateField(where, field, fieldValue, fields, problems, false);
  }
}

/** Validates one entry field; returns false when the field is not a known scalar field. */
function validateField(where, field, value, fields, problems, allowLevels) {
  if (field === 'model' && fields.includes('model')) return validateModel(where, value, problems);
  if (field === 'effort' && fields.includes('effort')) return validateEffort(where, value, problems);
  if (field === 'sandbox' && fields.includes('sandbox')) {
    if (typeof value !== 'boolean') problems.push(`${where}.sandbox must be a boolean (${DIFF_HINT}).`);
    return;
  }
  const valid = allowLevels ? [...fields, ...LEVELS] : fields;
  problems.push(`${where} has unrecognized key "${field}". Valid keys: ${valid.join(', ')} (${DIFF_HINT}).`);
}

/**
 * Validates one entry object with inline level overrides.
 * `allowArrayOverrides` permits a level override to be a candidate array (read delegates only).
 */
function validateEntry(where, entry, fields, problems, allowArrayOverrides) {
  if (!isPlainObject(entry)) {
    problems.push(`${where} must be an object (${DIFF_HINT}).`);
    return;
  }
  for (const [field, value] of Object.entries(entry)) {
    if (!LEVELS.includes(field)) {
      validateField(where, field, value, fields, problems, true);
      continue;
    }
    const levelWhere = `${where}.${field}`;
    if (Array.isArray(value) && allowArrayOverrides) {
      if (value.length === 0) {
        problems.push(`${levelWhere} must define at least one candidate (${DIFF_HINT}).`);
        continue;
      }
      value.forEach((item, i) => validateCandidate(`${levelWhere}[${i}]`, item, fields, problems));
      continue;
    }
    validateCandidate(levelWhere, value, fields, problems);
  }
}

/** Validates a platform-keyed table; returns the canonical keys present, in order. */
function validatePlatformTable(table, value, problems, validateOne) {
  if (!isPlainObject(value)) {
    problems.push(`"${table}" must be an object mapping platform key to settings (${DIFF_HINT}).`);
    return [];
  }
  const seen = new Map();
  for (const key of Object.keys(value)) {
    if (key === 'all') {
      problems.push(`${table} cannot use reserved pin keyword "all" as a platform key (${DIFF_HINT}).`);
      continue;
    }
    const canonical = normalizeProviderKey(key);
    // Anything non-canonical (a typo, the retired `local`) would otherwise validate clean and never run.
    if (!KNOWN_PROVIDERS.includes(canonical)) {
      problems.push(`${table}: unknown platform "${key}" (expected ${KNOWN_PROVIDERS.join(', ')}).`);
      continue;
    }
    if (seen.has(canonical)) {
      problems.push(
        `${table}: duplicate platform "${canonical}" (keys "${seen.get(canonical)}" and "${key}" normalize to the same provider).`
      );
      continue;
    }
    seen.set(canonical, key);
    validateOne(`${table}.${key}`, value[key], canonical);
  }
  return [...seen.keys()];
}

function validateReadDelegate(where, entry, canonical, problems) {
  const fields = SANDBOX_SUPPORTED_PROVIDERS.includes(canonical) ? CANDIDATE_FIELDS : WRITE_FIELDS;
  if (Array.isArray(entry)) {
    if (entry.length === 0) {
      problems.push(`${where} must define at least one candidate (${DIFF_HINT}).`);
      return;
    }
    // Array items are candidates with their own level overrides, but never nested arrays.
    entry.forEach((item, i) => validateEntry(`${where}[${i}]`, item, fields, problems, false));
    return;
  }
  validateEntry(where, entry, fields, problems, true);
}

function validateKnob(where, name, knob, problems) {
  if (!isPlainObject(knob)) {
    problems.push(`${where} must be an object keyed by level (${DIFF_HINT}).`);
    return;
  }
  const keys = Object.keys(knob);
  if (keys.length === 0) problems.push(`${where} must define at least one level (${DIFF_HINT}).`);
  for (const key of keys) {
    if (!LEVELS.includes(key)) {
      problems.push(`${where} has unrecognized level "${key}". Valid levels: ${LEVELS.join(', ')} (${DIFF_HINT}).`);
      continue;
    }
    const value = knob[key];
    if (name === 'rounds' && !isNonNegativeInteger(value)) {
      problems.push(`${where}.${key} must be a non-negative integer (${DIFF_HINT}).`);
    } else if (name === 'targets' && value !== 'all' && !isNonNegativeInteger(value)) {
      problems.push(`${where}.${key} must be a non-negative integer or "all" (${DIFF_HINT}).`);
    } else if (name === 'consensus' && typeof value !== 'boolean') {
      problems.push(`${where}.${key} must be a boolean (${DIFF_HINT}).`);
    }
  }
}

function validatePhases(phases, readKeys, problems) {
  if (!isPlainObject(phases)) {
    problems.push(`"phases" must be an object keyed by review phase (${DIFF_HINT}).`);
    return;
  }
  for (const [phase, policy] of Object.entries(phases)) {
    const where = `phases.${phase}`;
    if (!REVIEW_PHASES.includes(phase)) {
      problems.push(`phases has unrecognized phase "${phase}". Valid phases: ${REVIEW_PHASES.join(', ')} (${DIFF_HINT}).`);
      continue;
    }
    if (!isPlainObject(policy)) {
      problems.push(`${where} must be an object (${DIFF_HINT}).`);
      continue;
    }
    for (const key of Object.keys(policy)) {
      if (![...PHASE_KNOBS, 'only'].includes(key)) {
        problems.push(
          `${where} has unrecognized key "${key}". Valid keys: ${[...PHASE_KNOBS, 'only'].join(', ')} (${DIFF_HINT}).`
        );
      }
    }
    for (const knob of PHASE_KNOBS) {
      if (policy[knob] === undefined) {
        problems.push(`${where} is missing required knob "${knob}" (${DIFF_HINT}).`);
        continue;
      }
      validateKnob(`${where}.${knob}`, knob, policy[knob], problems);
    }
    if (policy.only !== undefined) validateOnly(`${where}.only`, policy.only, readKeys, problems);
  }
}

function validateOnly(where, only, readKeys, problems) {
  if (!Array.isArray(only) || only.length === 0 || only.some(k => typeof k !== 'string')) {
    problems.push(`${where} must be a non-empty array of read-delegates platform keys (${DIFF_HINT}).`);
    return;
  }
  const missing = only.filter(key => !readKeys.includes(normalizeProviderKey(key)));
  if (missing.length > 0) {
    problems.push(
      `${where} names platform(s) not in read-delegates: ${missing.join(', ')} (configured: ${readKeys.join(', ') || 'none'}).`
    );
  }
}

/**
 * Requires a non-blank `effort` at every level for a resolved candidate that names a `model`: an
 * entry with no model at all (an unconfigured placeholder) is exempt. `resolveAt(entry, level)`
 * returns the level's resolved candidate array (read-delegates) or one-candidate array
 * (write-subagents' `resolveLevelEntry`, wrapped by the caller).
 */
function validateResolvedEffort(where, entry, resolveAt, problems) {
  if (!entry || (!isPlainObject(entry) && !Array.isArray(entry))) return;
  for (const level of LEVELS) {
    let candidates;
    try {
      candidates = resolveAt(entry, level);
    } catch {
      continue; // Malformed entries are already reported by structural validation.
    }
    candidates.forEach((candidate, index) => {
      if (candidate?.model !== undefined && !candidate.effort) {
        const suffix = candidates.length > 1 ? `[${index}]` : '';
        problems.push(`${where}${suffix} effort is missing at level ${level}; add "effort" (e.g. "medium").`);
      }
    });
  }
}

/**
 * Validates a parsed config against the v0.5 schema, reporting every problem in one pass.
 *
 * @param {object} config
 * @returns {string[]} problem descriptions, empty when valid
 */
export function validateConfig(config) {
  if (!isPlainObject(config)) {
    return [`Config must be a JSON object with tables: ${TABLES.join(', ')} (${DIFF_HINT}).`];
  }
  const problems = [];
  for (const key of Object.keys(config)) {
    if (TABLES.includes(key)) continue;
    const legacy = LEGACY_TOP_LEVEL_KEYS.includes(key) ? ' (a v0.4 key; see the v0.4 key map)' : '';
    problems.push(`Unrecognized top-level key "${key}"${legacy}. Valid tables: ${TABLES.join(', ')} (${DIFF_HINT}).`);
  }

  let readKeys = [];
  if (config['read-delegates'] === undefined) {
    problems.push(`Missing required table "read-delegates" (${DIFF_HINT}).`);
  } else {
    readKeys = validatePlatformTable('read-delegates', config['read-delegates'], problems,
      (where, entry, canonical) => {
        validateReadDelegate(where, entry, canonical, problems);
        validateResolvedEffort(where, entry, resolvePlatformCandidates, problems);
      });
    if (isPlainObject(config['read-delegates']) && Object.keys(config['read-delegates']).length === 0) {
      problems.push(`read-delegates must define at least one platform (${DIFF_HINT}).`);
    }
  }

  if (config['write-subagents'] !== undefined) {
    validatePlatformTable('write-subagents', config['write-subagents'], problems, (where, entry) => {
      if (!isPlainObject(entry)) {
        problems.push(`${where} must be an object (${DIFF_HINT}).`);
        return;
      }
      validateEntry(where, entry, WRITE_FIELDS, problems, false);
      validateResolvedEffort(where, entry, (item, level) => [resolveLevelEntry(item, level)], problems);
    });
  }

  if (config.phases !== undefined) validatePhases(config.phases, readKeys, problems);
  return problems;
}

// ============================================================================
// SECTION: Loading and v0.4 rejection
// ============================================================================

/**
 * Detects a v0.4 config: a legacy top-level key, or a retired sibling implement config on disk.
 *
 * @param {object} config
 * @param {{ skillRoot?: string }} [options]
 * @returns {null | { reasons: string[], message: string }}
 */
export function detectLegacyConfig(config, { skillRoot } = {}) {
  const reasons = [];
  if (isPlainObject(config)) {
    const legacyKeys = LEGACY_TOP_LEVEL_KEYS.filter(key => config[key] !== undefined);
    if (legacyKeys.length > 0) reasons.push(`top-level v0.4 key(s): ${legacyKeys.join(', ')}`);
  }
  if (skillRoot) {
    const siblingDir = path.join(path.dirname(path.resolve(skillRoot)), LEGACY_SIBLING_DIR);
    for (const name of ['config.jsonc', 'config.local.jsonc']) {
      const candidate = path.join(siblingDir, name);
      if (fs.existsSync(candidate)) reasons.push(`the retired implement config exists: ${candidate}`);
    }
  }
  if (reasons.length === 0) return null;
  return { reasons, message: formatLegacyDiagnostic(reasons) };
}

/** The v0.4 rejection diagnostic for the given reasons, naming the key map. */
export function formatLegacyDiagnostic(reasons) {
  return `v0.4 dispatch config detected (${reasons.join('; ')}). v0.5 reads one dispatch config with ` +
    `the tables ${TABLES.join(', ')}; migrate and delete the retired file(s). ${LEGACY_KEY_MAP}`;
}

/**
 * Loads the dispatch config (first of `config.local.jsonc`, `config.jsonc`), rejecting v0.4
 * configs and normalizing absent optional tables to empty maps. Schema validation is the
 * caller's job (`validateConfig`).
 *
 * @param {{ skillRoot: string }} options
 * @returns {{ config: object, path: string }}
 */
export function loadDispatchConfig({ skillRoot } = {}) {
  const loaded = loadSkillConfig({ skillRoot });
  const legacy = detectLegacyConfig(loaded.config, { skillRoot });
  if (legacy) {
    const err = new Error(`${legacy.message} (loaded ${loaded.path})`);
    err.code = LEGACY_CONFIG_CODE;
    throw err;
  }
  const config = isPlainObject(loaded.config)
    ? { ...loaded.config, 'write-subagents': loaded.config['write-subagents'] ?? {}, phases: loaded.config.phases ?? {} }
    : loaded.config;
  return { config, path: loaded.path };
}
