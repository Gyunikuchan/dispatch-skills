/**
 * Unified dispatch config: schema validation and level resolution.
 *
 * One config (`config.local.jsonc`, else `config.jsonc`) holds three tables:
 * - `read-delegates`  provider → `{ sandbox?, targets: [levelMap, ...] }` (required)
 * - `write-subagents` provider → level map (optional)
 * - `phases`          review phase → `targets`/`rounds`/`consensus` level maps + `only` (optional)
 *
 * A level map maps levels to `{ model, effort? }`. Every level-keyed value resolves the same way:
 * exact → nearest lower → lowest higher, with no field inheritance across levels.
 * Pure except `loadDispatchConfig`, which reads the filesystem.
 */

import { loadSkillConfig } from './platform.mjs';
import {
  KNOWN_PROVIDERS,
  PROVIDER_ALIASES,
  SANDBOX_SUPPORTED_PROVIDERS,
  validateEffortSpec,
  validateModelSpec,
} from './providers.mjs';

/** Policy and model tiers, lowest first. */
export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Review phases the `phases` table may configure, in workflow order. */
export const REVIEW_PHASES = ['plan-review', 'design-review', 'code-review'];

export const TABLES = ['read-delegates', 'write-subagents', 'phases'];
const PHASE_KNOBS = ['targets', 'rounds', 'consensus'];
const DIFF_HINT = 'diff against config.sample.jsonc';

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

/** Level key a level map (or scalar knob) resolves to at `level`, or null. */
export function selectedLevelKey(entry, level) {
  if (!isPlainObject(entry)) return null;
  return selectLevel(LEVELS.filter(l => entry[l] !== undefined), level) ?? null;
}

/**
 * Resolves a level map (write-subagent entry or read target) to a copy of its selected level
 * configuration; no field inheritance, so an omitted `effort` stays omitted.
 *
 * @param {object} entry
 * @param {string} level
 * @returns {{ model?: string | string[], effort?: string }}
 */
export function resolveLevelEntry(entry, level) {
  const chosen = selectedLevelKey(entry, level);
  if (chosen === null || !isPlainObject(entry[chosen])) return {};
  const resolved = {};
  if (entry[chosen].model !== undefined) resolved.model = entry[chosen].model;
  if (entry[chosen].effort !== undefined) resolved.effort = entry[chosen].effort;
  return resolved;
}

/** Provider-wide sandbox: explicit boolean, else `true`; undefined for unsupported providers. */
export function effectiveSandbox(wrapper, canonical) {
  if (!SANDBOX_SUPPORTED_PROVIDERS.includes(canonical)) return undefined;
  return typeof wrapper?.sandbox === 'boolean' ? wrapper.sandbox : true;
}

/**
 * Resolves a read-provider wrapper to one candidate per target, in declaration order.
 *
 * @param {{ sandbox?: boolean, targets?: object[] }} wrapper
 * @param {string} level
 * @param {string} canonical
 * @returns {Array<{ model?: string | string[], effort?: string, sandbox?: boolean }>}
 */
export function resolveTargets(wrapper, level, canonical) {
  const targets = Array.isArray(wrapper?.targets) ? wrapper.targets : [];
  const sandbox = effectiveSandbox(wrapper, canonical);
  return targets.map(target => {
    const candidate = resolveLevelEntry(target, level);
    return sandbox === undefined ? candidate : { ...candidate, sandbox };
  });
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
  for (const [key, wrapper] of Object.entries(config?.['read-delegates'] ?? {})) {
    const canonical = normalizeProviderKey(key);
    platforms[canonical] = resolveTargets(wrapper, level, canonical);
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

/** Object key order is ignored; array order (alias fallback) is significant. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateModel(where, value, problems) {
  if (value === undefined) {
    problems.push(`${where}.model is required (${DIFF_HINT}).`);
    return;
  }
  try {
    if (value === null) throw new Error('null');
    validateModelSpec(value, `${where}.model`);
  } catch {
    problems.push(`${where}.model must be a nonblank string or non-empty array of nonblank strings (${DIFF_HINT}).`);
    return;
  }
  if (Array.isArray(value)) {
    const dup = value.find((item, i) => value.indexOf(item) !== i);
    if (dup !== undefined) problems.push(`${where}.model has duplicate alias "${dup}" (${DIFF_HINT}).`);
  }
}

function validateEffort(where, value, problems) {
  try {
    if (typeof value !== 'string') throw new Error('not a string');
    validateEffortSpec(value, `${where}.effort`);
  } catch {
    problems.push(`${where}.effort must be a string and not blank; omit it for the provider default (${DIFF_HINT}).`);
  }
}

/** Validates one `{ model, effort? }` level configuration. */
function validateLevelConfig(where, value, problems) {
  if (!isPlainObject(value)) {
    problems.push(`${where} must be an object with model and optional effort (${DIFF_HINT}).`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== 'model' && key !== 'effort') {
      problems.push(`${where} has unrecognized key "${key}". Valid keys: model, effort (${DIFF_HINT}).`);
    }
  }
  validateModel(where, value.model, problems);
  if ('effort' in value) validateEffort(where, value.effort, problems);
}

/** Validates a non-empty sparse level map whose values are level configurations. */
function validateLevelMap(where, value, problems) {
  if (!isPlainObject(value)) {
    problems.push(`${where} must be an object keyed by level (${DIFF_HINT}).`);
    return;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) problems.push(`${where} must define at least one level (${DIFF_HINT}).`);
  for (const key of keys) {
    if (!LEVELS.includes(key)) {
      problems.push(`${where} has unrecognized key "${key}". Valid keys: ${LEVELS.join(', ')} (${DIFF_HINT}).`);
      continue;
    }
    validateLevelConfig(`${where}.${key}`, value[key], problems);
  }
}

/** Validates one read-provider wrapper `{ sandbox?, targets }`, including duplicate targets. */
function validateReadProvider(where, value, canonical, problems) {
  const supportsSandbox = SANDBOX_SUPPORTED_PROVIDERS.includes(canonical);
  const validKeys = supportsSandbox ? 'sandbox, targets' : 'targets';
  if (!isPlainObject(value)) {
    problems.push(`${where} must be an object with keys ${validKeys} (${DIFF_HINT}).`);
    return;
  }
  for (const [key, field] of Object.entries(value)) {
    if (key === 'targets') continue;
    if (key === 'sandbox' && !supportsSandbox) {
      problems.push(`${where}.sandbox is not supported for ${canonical}; remove it (${DIFF_HINT}).`);
    } else if (key === 'sandbox') {
      if (typeof field !== 'boolean') problems.push(`${where}.sandbox must be a boolean (${DIFF_HINT}).`);
    } else {
      problems.push(`${where} has unrecognized key "${key}". Valid keys: ${validKeys} (${DIFF_HINT}).`);
    }
  }
  const { targets } = value;
  if (!Array.isArray(targets) || targets.length === 0) {
    problems.push(`${where}.targets must be a non-empty array of level maps (${DIFF_HINT}).`);
    return;
  }
  const seen = new Map();
  targets.forEach((target, j) => {
    validateLevelMap(`${where}.targets[${j}]`, target, problems);
    if (!isPlainObject(target)) return;
    const key = canonicalJson(target);
    if (seen.has(key)) problems.push(`${where}.targets[${j}] duplicates targets[${seen.get(key)}] (${DIFF_HINT}).`);
    else seen.set(key, j);
  });
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
 * Validates a parsed config against the schema, reporting every problem in one pass.
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
    problems.push(`Unrecognized top-level key "${key}". Valid tables: ${TABLES.join(', ')} (${DIFF_HINT}).`);
  }

  let readKeys = [];
  if (config['read-delegates'] === undefined) {
    problems.push(`Missing required table "read-delegates" (${DIFF_HINT}).`);
  } else {
    readKeys = validatePlatformTable('read-delegates', config['read-delegates'], problems,
      (where, entry, canonical) => validateReadProvider(where, entry, canonical, problems));
    if (isPlainObject(config['read-delegates']) && Object.keys(config['read-delegates']).length === 0) {
      problems.push(`read-delegates must define at least one platform (${DIFF_HINT}).`);
    }
  }

  if (config['write-subagents'] !== undefined) {
    validatePlatformTable('write-subagents', config['write-subagents'], problems,
      (where, entry) => validateLevelMap(where, entry, problems));
  }

  if (config.phases !== undefined) validatePhases(config.phases, readKeys, problems);
  return problems;
}

// ============================================================================
// SECTION: Loading
// ============================================================================

/**
 * Loads the dispatch config (first of `config.local.jsonc`, `config.jsonc`), normalizing absent optional
 * tables to empty maps. Schema validation is the caller's job (`validateConfig`).
 *
 * @param {{ skillRoot: string }} options
 * @returns {{ config: object, path: string }}
 */
export function loadDispatchConfig({ skillRoot } = {}) {
  const loaded = loadSkillConfig({ skillRoot });
  const config = isPlainObject(loaded.config)
    ? { ...loaded.config, 'write-subagents': loaded.config['write-subagents'] ?? {}, phases: loaded.config.phases ?? {} }
    : loaded.config;
  return { config, path: loaded.path };
}
