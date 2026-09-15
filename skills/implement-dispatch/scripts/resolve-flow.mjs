#!/usr/bin/env node
/**
 * Resolves the implement-dispatch execution flow plan.
 *
 * Usage:
 *   node resolve-flow.mjs --platform <key>
 *                         [--level <low|medium|high|xhigh|max>]
 *                         [--pins <key,key,...|all|n>] [--exclude <key,key,...>]
 *   node resolve-flow.mjs --validate-only
 *   node resolve-flow.mjs --help
 *
 * Outputs JSON to stdout describing plan-review, implementation, and code-review
 * targets and run diagnostics. Artifact paths are resolved separately by
 * dispatch's resolve-artifact-paths.mjs (single source of truth shared with
 * dispatch-plan-review/dispatch-code-review) — not this script's concern.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  KNOWN_PROVIDERS,
  diversitySort,
  isMainModule,
  getConfigCandidates,
  loadSkillConfig,
  validateDispatchConfig,
  detectOrchestratorModel,
  isSameModel,
  verifySkillIntegrity,
} from '../../dispatch/scripts/common.mjs';
import { PROVIDER_ALIASES } from '../../dispatch/scripts/dispatch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DISPATCH_SCRIPTS = path.resolve(__dirname, '../../dispatch/scripts');

/** Invocation grammar for `/implement-dispatch <level>`; not a per-project preference. */
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

const REVIEW_SECTIONS = ['plan-review', 'code-review'];
const SECTIONS = ['plan-review', 'implementation', 'code-review'];
const REVIEW_KNOBS = ['maxRounds', 'targetCount', 'consensus'];

const USAGE = `Usage:
  node resolve-flow.mjs --platform <key> [--orchestrator-model <model>] [--level <level>]
                        [--pins <list>] [--exclude <list>] [--validate-only]

  --platform <key>            orchestrator's own provider key (${KNOWN_PROVIDERS.join(', ')})
  --orchestrator-model <name> orchestrator's active model (sorts same platform+model last)
  --level <level>             ${LEVELS.join(' | ')} (default: medium)
  --pins <list>               comma-separated provider keys, "all", or a single reviewer count
  --exclude <list>            comma-separated provider keys removed from every phase (e.g. after [auth]/[quota])
  --validate-only             validate the config schema and exit
  -h, --help                  show this help
`;

/**
 * Normalizes a raw pin string (provider key or alias, case-insensitive) to its
 * canonical provider key or the reserved "all" pin keyword.
 */
export function normalizePin(rawPin) {
  const lower = rawPin.toLowerCase();
  return PROVIDER_ALIASES[lower] ?? (lower === 'all' ? 'all' : rawPin);
}

/**
 * Splits a raw `--pins` list into either provider keys (and/or "all") or a single reviewer
 * count. The two forms never mix: a count pin replaces breadth entirely, so pairing it with a
 * provider key or a second count would be ambiguous about how many reviewers to run.
 *
 * @param {Array<string|number>|undefined} rawPins
 * @returns {{ keys: string[] | undefined, count: number | undefined }}
 */
export function parsePins(rawPins) {
  if (!rawPins || rawPins.length === 0) return { keys: undefined, count: undefined };
  const trimmed = rawPins.map(p => String(p).trim());
  const isCountLike = s => /^-?\d+$/.test(s);
  if (trimmed.some(isCountLike)) {
    if (rawPins.length > 1) {
      throw new Error(`A reviewer count pin must stand alone: ${rawPins.join(', ')}`);
    }
    const count = Number(trimmed[0]);
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error(`Reviewer count pin must be an integer from 1 to ${Number.MAX_SAFE_INTEGER}`);
    }
    return { keys: undefined, count };
  }
  return { keys: rawPins, count: undefined };
}

// ============================================================================
// SECTION: Level resolution
// ============================================================================

/**
 * Picks which defined level applies to the requested level:
 * exact match → nearest defined level below → lowest defined level above.
 *
 * Sorts its input, so callers need not pass `definedLevels` in LEVELS order.
 *
 * @param {string[]} definedLevels - defined level keys, in any order
 * @param {string} level           - requested level
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
 * Resolves the model/effort hints for one platform's entry in any `platforms` map.
 *
 * An entry may carry flat `model`/`effort` keys (applying to every level), level keys
 * (`low`/`medium`/`high`/`xhigh`/`max`) overriding them, or both. Shape problems are fatal at
 * validation time, so unrecognised keys are simply not level overrides here.
 *
 * @param {object} entry - config[section].platforms[platform]
 * @param {string} level - requested level
 * @returns {{ model?: string, effort?: string }}
 */
export function resolveLevelEntry(entry, level) {
  if (!entry || typeof entry !== 'object') return {};

  const base = {};
  if (entry.model !== undefined) base.model = entry.model;
  if (entry.effort !== undefined) base.effort = entry.effort;

  const overrides = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'model' || key === 'effort') continue;
    if (!LEVELS.includes(key)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    overrides[key] = value;
  }

  const chosen = selectLevel(LEVELS.filter(l => overrides[l] !== undefined), level);
  if (chosen === undefined) return base;

  const override = overrides[chosen];
  const resolved = { ...base };
  if (override.model !== undefined) resolved.model = override.model;
  if (override.effort !== undefined) resolved.effort = override.effort;
  return resolved;
}

/**
 * Resolves the candidates for one platform entry.
 * An entry may be:
 * - A single object: { model?, effort?, ...levelOverrides }
 * - An array of objects: [ { model?, effort?, ... }, ... ]
 * In addition, within a level override, the value may be an object or an array of objects.
 *
 * @param {object | object[]} entry
 * @param {string} level
 * @returns {Array<{ model?: string, effort?: string }>}
 */
export function resolvePlatformCandidates(entry, level) {
  if (!entry) return [];
  if (Array.isArray(entry)) {
    return entry.flatMap(item => resolvePlatformCandidates(item, level));
  }
  if (typeof entry !== 'object') return [];

  const base = {};
  if (entry.model !== undefined) base.model = entry.model;
  if (entry.effort !== undefined) base.effort = entry.effort;

  const overrides = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'model' || key === 'effort') continue;
    if (!LEVELS.includes(key)) continue;
    if (!value || typeof value !== 'object') continue;
    overrides[key] = value;
  }

  const chosen = selectLevel(LEVELS.filter(l => overrides[l] !== undefined), level);
  if (chosen === undefined) return [base];

  const override = overrides[chosen];
  if (Array.isArray(override)) {
    return override.map(item => {
      const resolved = { ...base };
      if (item && typeof item === 'object') {
        if (item.model !== undefined) resolved.model = item.model;
        if (item.effort !== undefined) resolved.effort = item.effort;
      }
      return resolved;
    });
  }

  const resolved = { ...base };
  if (override && typeof override === 'object') {
    if (override.model !== undefined) resolved.model = override.model;
    if (override.effort !== undefined) resolved.effort = override.effort;
  }
  return [resolved];
}

/**
 * Resolves a level-keyed scalar knob (`maxRounds`, `targetCount`, `consensus`, ...)
 * under the same exact → below → above rule as level entries.
 *
 * @param {Record<string, unknown>} knob - level key → scalar value
 * @param {string} level                 - requested level
 * @returns {unknown | undefined}
 */
export function resolveLevelScalar(knob, level) {
  if (!knob || typeof knob !== 'object') return undefined;
  const defined = LEVELS.filter(l => knob[l] !== undefined);
  const chosen = selectLevel(defined, level);
  return chosen === undefined ? undefined : knob[chosen];
}

// ============================================================================
// SECTION: Config loading
// ============================================================================

/**
 * Thin wrapper over the shared loader's candidate list, kept exported for
 * `scripts/validate-configs.mjs` (which discovers implement-dispatch configs by
 * path rather than importing `loadConfig` directly).
 */
export function getImplementDispatchConfigCandidates(scriptDir = __dirname) {
  return getConfigCandidates({
    skillRoot: path.resolve(scriptDir, '..'),
  });
}

export function loadConfig(scriptDir = __dirname, { defaultOnly = false } = {}) {
  const { config } = loadSkillConfig({
    skillRoot: path.resolve(scriptDir, '..'),
    defaultOnly,
  });
  return config;
}

/**
 * Reads the platform keys of `dispatch`'s effective config — the set this skill's review
 * platforms must be a subset of, since every review wave target is dispatched as
 * `dispatch --provider <key>`. Native implementation subagents are intentionally outside this
 * check.
 *
 * Yields `keys: null` instead of throwing when that config is unreadable or invalid (dispatch not
 * installed as a sibling, unparsable, or containing unsupported platform keys). The CLI treats
 * that as a fatal dependency error and refuses to resolve a flow without authoritative dispatch
 * membership.
 *
 * @param {string} [dispatchScripts] Directory holding dispatch's scripts.
 * @returns {{
 *   keys: string[] | null,
 *   path: string | null,
 *   error?: string,
 *   problems?: string[],
 * }}
 */
export function loadDispatchPlatformKeys(dispatchScripts = DISPATCH_SCRIPTS) {
  try {
    const { config, path: configPath } = loadSkillConfig({
      skillRoot: path.resolve(dispatchScripts, '..'),
    });
    const problems = validateDispatchConfig(config);
    if (problems.length > 0) return { keys: null, path: configPath, problems };
    return { keys: Object.keys(config.platforms).map(normalizePin), path: configPath };
  } catch (err) {
    return {
      keys: null,
      path: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// SECTION: Config validation
// ============================================================================

const DIFF_HINT = 'diff against config.default.jsonc';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function validateCandidateObject(where, value, problems) {
  if (!isPlainObject(value)) {
    problems.push(`${where} must be an object with model/effort (${DIFF_HINT}).`);
    return;
  }
  if (Object.keys(value).length === 0) {
    problems.push(`${where} must set at least one of model, effort (${DIFF_HINT}).`);
  }
  for (const [inner, innerValue] of Object.entries(value)) {
    if (inner !== 'model' && inner !== 'effort') {
      problems.push(
        `${where} has unrecognized key "${inner}". Valid keys: model, effort (${DIFF_HINT}).`
      );
    } else if (typeof innerValue !== 'string') {
      problems.push(`${where}.${inner} must be a string (${DIFF_HINT}).`);
    }
  }
}

function validateSinglePlatformEntry(where, entry, problems, allowArrays = true) {
  if (!isPlainObject(entry)) {
    problems.push(`${where} must be an object (${DIFF_HINT}).`);
    return;
  }
  for (const [field, value] of Object.entries(entry)) {
    if (field === 'model' || field === 'effort') {
      if (typeof value !== 'string') {
        problems.push(`${where}.${field} must be a string (${DIFF_HINT}).`);
      }
      continue;
    }
    if (!LEVELS.includes(field)) {
      problems.push(
        `${where} has unrecognized key "${field}". Valid keys: model, effort, ${LEVELS.join(', ')} (${DIFF_HINT}).`
      );
      continue;
    }
    if (Array.isArray(value)) {
      if (!allowArrays) {
        problems.push(`${where}.${field} must be an object with model/effort (${DIFF_HINT}).`);
        continue;
      }
      if (value.length === 0) {
        problems.push(`${where}.${field} must define at least one candidate (${DIFF_HINT}).`);
        continue;
      }
      for (let i = 0; i < value.length; i++) {
        validateCandidateObject(`${where}.${field}[${i}]`, value[i], problems);
      }
      continue;
    }
    if (!isPlainObject(value)) {
      problems.push(`${where}.${field} must be an object with model/effort (${DIFF_HINT}).`);
      continue;
    }
    validateCandidateObject(`${where}.${field}`, value, problems);
  }
}

function validatePlatforms(section, platforms, problems) {
  const where = `${section}.platforms`;
  if (!isPlainObject(platforms)) {
    problems.push(`${where} must be an object mapping platform key to model/effort settings (${DIFF_HINT}).`);
    return;
  }
  const keys = Object.keys(platforms);
  if (keys.length === 0) {
    problems.push(`${where} must define at least one platform (${DIFF_HINT}).`);
  }
  for (const key of keys) {
    if (key === 'all') {
      problems.push(`${where} cannot use reserved pin keyword "all" as a platform key (${DIFF_HINT}).`);
      continue;
    }
    // Aliases (e.g. `claudecode`) normalize first; anything else non-canonical (a typo, the
    // retired `local`) would otherwise validate clean and silently never be live.
    if (!KNOWN_PROVIDERS.includes(normalizePin(key))) {
      problems.push(`${where}: unknown platform "${key}" (expected ${KNOWN_PROVIDERS.join(', ')}).`);
      continue;
    }
    const entry = platforms[key];
    if (section === 'implementation') {
      if (!isPlainObject(entry)) {
        problems.push(`${where}.${key} must be an object (${DIFF_HINT}).`);
        continue;
      }
      validateSinglePlatformEntry(`${where}.${key}`, entry, problems, false);
      continue;
    }
    if (Array.isArray(entry)) {
      if (entry.length === 0) {
        problems.push(`${where}.${key} must define at least one candidate (${DIFF_HINT}).`);
        continue;
      }
      for (let i = 0; i < entry.length; i++) {
        validateSinglePlatformEntry(`${where}.${key}[${i}]`, entry[i], problems, false);
      }
      continue;
    }
    if (!isPlainObject(entry)) {
      problems.push(`${where}.${key} must be an object (${DIFF_HINT}).`);
      continue;
    }
    validateSinglePlatformEntry(`${where}.${key}`, entry, problems);
  }
}

function validateKnob(section, name, knob, problems) {
  const where = `${section}.${name}`;
  if (!isPlainObject(knob)) {
    problems.push(`${where} must be an object keyed by level (${DIFF_HINT}).`);
    return;
  }
  const keys = Object.keys(knob);
  if (keys.length === 0) {
    problems.push(`${where} must define at least one level (${DIFF_HINT}).`);
  }
  for (const key of keys) {
    if (!LEVELS.includes(key)) {
      problems.push(
        `${where} has unrecognized level "${key}". Valid levels: ${LEVELS.join(', ')} (${DIFF_HINT}).`
      );
      continue;
    }
    const value = knob[key];
    switch (name) {
      case 'maxRounds':
        if (!isNonNegativeInteger(value)) {
          problems.push(`${where}.${key} must be a non-negative integer (${DIFF_HINT}).`);
        }
        break;
      case 'targetCount':
        if (value !== 'all' && !isNonNegativeInteger(value)) {
          problems.push(`${where}.${key} must be a non-negative integer or "all" (${DIFF_HINT}).`);
        }
        break;
      case 'consensus':
        if (typeof value !== 'boolean') {
          problems.push(`${where}.${key} must be a boolean (${DIFF_HINT}).`);
        }
        break;
    }
  }
}

/**
 * Flags review platforms this skill configures that `dispatch` does not. Review sections plan
 * external dispatch targets that exit `PLATFORM_NOT_CONFIGURED` once dispatched. The
 * implementation section is intentionally excluded: its platforms select native write
 * subagents and do not need to be present in dispatch's external-provider config.
 *
 * @param {object} config
 * @param {{ keys: string[], path: string | null }} dispatchPlatforms
 * @param {string[]} problems Accumulator, appended in place.
 */
function crossCheckDispatchPlatforms(config, dispatchPlatforms, problems) {
  const allowed = new Set(dispatchPlatforms.keys);
  const where = dispatchPlatforms.path ?? "dispatch's config";
  const configured = allowed.size > 0 ? [...allowed].join(', ') : 'none';
  for (const section of REVIEW_SECTIONS) {
    const platforms = config?.[section]?.platforms;
    // Shape problems are already reported by validatePlatforms; only cross-check a usable map.
    if (!isPlainObject(platforms)) continue;
    for (const key of Object.keys(platforms)) {
      if (allowed.has(normalizePin(key))) continue;
      problems.push(
        `${section}.platforms."${key}" is not configured in ${where} (configured there: ${configured}). ` +
          `Dispatching to it exits PLATFORM_NOT_CONFIGURED; add it there or remove it here.`
      );
    }
  }
}

/**
 * Validates a parsed config against the flow schema.
 *
 * Reports every problem found in one pass; callers join and throw.
 *
 * @param {object} config
 * @param {object} [options]
 * @param {{ keys: string[] | null, path: string | null } | null} [options.dispatchPlatforms]
 *   `dispatch`'s effective platform membership, from {@link loadDispatchPlatformKeys}. Supplying it
 *   adds the subset cross-check; omitting it (or passing `keys: null`) validates this config's own
 *   schema alone, keeping this function pure for callers that have no filesystem access.
 * @returns {string[]} problem descriptions, empty when the config is valid
 */
export function validateConfig(config, { dispatchPlatforms = null } = {}) {
  const problems = [];

  if (!isPlainObject(config)) {
    return [`Config must be a JSON object with sections: ${SECTIONS.join(', ')} (${DIFF_HINT}).`];
  }

  for (const key of Object.keys(config)) {
    if (!SECTIONS.includes(key)) {
      problems.push(
        `Unrecognized top-level key "${key}". Valid sections: ${SECTIONS.join(', ')} (${DIFF_HINT}).`
      );
    }
  }

  for (const section of SECTIONS) {
    if (config[section] === undefined) {
      problems.push(`Missing required section "${section}" (${DIFF_HINT}).`);
      continue;
    }
    if (!isPlainObject(config[section])) {
      problems.push(`Section "${section}" must be an object (${DIFF_HINT}).`);
      continue;
    }

    const allowed = section === 'implementation' ? ['platforms'] : ['platforms', ...REVIEW_KNOBS];
    for (const key of Object.keys(config[section])) {
      if (!allowed.includes(key)) {
        problems.push(
          `Section "${section}" has unrecognized key "${key}". Valid keys: ${allowed.join(', ')} (${DIFF_HINT}).`
        );
      }
    }

    validatePlatforms(section, config[section].platforms, problems);

    if (section === 'implementation') continue;

    for (const knob of REVIEW_KNOBS) {
      const value = config[section][knob];
      if (value === undefined) {
        problems.push(`Section "${section}" is missing required knob "${knob}" (${DIFF_HINT}).`);
        continue;
      }
      validateKnob(section, knob, value, problems);
    }
  }

  if (dispatchPlatforms?.keys) {
    crossCheckDispatchPlatforms(config, dispatchPlatforms, problems);
  }

  return problems;
}

// ============================================================================
// SECTION: Liveness
// ============================================================================

export const RUNNER_FILES = {
  claude: 'claude-run.mjs',
  agy: 'agy-run.mjs',
  copilot: 'copilot-run.mjs',
  opencode: 'opencode-run.mjs',
};

/**
 * Test-only override: a JSON object of `{ provider: boolean }` replacing the real probes.
 *
 * Each real probe spawns a provider CLI and waits on it, so a CLI test suite that exercises a
 * dozen argument combinations spends most of its runtime re-discovering the same binaries — and
 * its assertions then depend on what happens to be installed on the machine running it.
 */
const LIVENESS_ENV_VAR = 'IMPLEMENT_DISPATCH_LIVENESS_JSON';

/**
 * Explicit opt-in that arms the liveness seam above.
 *
 * A dedicated variable rather than `NODE_ENV=test`: ambient signals set by unrelated tooling are
 * exactly how an inherited payload silently replaces real probing in a production run.
 */
const TEST_MODE_ENV_VAR = 'IMPLEMENT_DISPATCH_TEST_MODE';

/**
 * Probes which providers are reachable.
 *
 * @param {string[]} [only] Restrict probing to these provider keys; omit to probe all of them.
 *   Probing a provider no phase can dispatch to is wasted latency.
 * @returns {Promise<{ liveness: Record<string, boolean>, source: 'env-override' | 'probe' }>}
 */
export async function defaultLiveness(only) {
  const override = process.env[LIVENESS_ENV_VAR];
  if (override) {
    // Fail loudly rather than ignore the payload: an operator who believes liveness is pinned
    // while the resolver probes for real is the quieter version of the bug this gate closes.
    if (process.env[TEST_MODE_ENV_VAR] !== '1') {
      throw new Error(
        `${LIVENESS_ENV_VAR} is a test-only seam and requires ${TEST_MODE_ENV_VAR}=1. ` +
          `Set both variables or unset ${LIVENESS_ENV_VAR}.`
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(override);
    } catch {
      throw new Error(`${LIVENESS_ENV_VAR} is not valid JSON`);
    }
    return {
      liveness: Object.fromEntries(Object.keys(RUNNER_FILES).map((key) => [key, !!parsed[key]])),
      source: 'env-override',
    };
  }

  const keys = only?.length ? Object.keys(RUNNER_FILES).filter((k) => only.includes(k)) : Object.keys(RUNNER_FILES);
  const results = Object.fromEntries(Object.keys(RUNNER_FILES).map((key) => [key, false]));

  await Promise.all(
    keys.map(async (key) => {
      try {
        const mod = await import(pathToFileURL(path.join(DISPATCH_SCRIPTS, RUNNER_FILES[key])).href);
        const fnName = `is${key.charAt(0).toUpperCase()}${key.slice(1)}Available`;
        results[key] = !!(await mod[fnName]?.());
      } catch {
        results[key] = false;
      }
    })
  );
  return { liveness: results, source: 'probe' };
}

/**
 * Provider keys any enabled phase could actually dispatch to, given the config and pins.
 * Anything outside this set cannot appear in the resolved flow, so probing it is pure latency.
 */
export function probeCandidates(opts, config) {
  const configured = new Set(
    SECTIONS.flatMap((section) => Object.keys(config?.[section]?.platforms ?? {}).map(normalizePin))
  );
  const platform = opts.platform ? normalizePin(opts.platform) : undefined;
  if (platform) configured.add(platform);

  const excluded = new Set(normalizeExcludeKeys(opts.exclude));
  // A count pin probes like unpinned breadth: it names how many reviewers, not which ones, so
  // narrowing the probe set the way a provider-key pin does would starve candidate selection.
  const { keys: pinKeys, count } = parsePins(opts.pins);
  const pins = (pinKeys ?? []).map(normalizePin);
  const keys = count === undefined && pins.length > 0 && !pins.includes('all')
    ? [...configured].filter((key) => pins.includes(key) || key === platform)
    : [...configured];
  return keys.filter((key) => !excluded.has(key));
}

/**
 * Canonical platform keys of both review sections (aliases normalized), the set pins and
 * exclusions are validated against.
 * @param {object} config
 * @returns {Set<string>}
 */
export function reviewSectionKeys(config) {
  return new Set(REVIEW_SECTIONS.flatMap(s => Object.keys(config[s]?.platforms ?? {}).map(normalizePin)));
}

/**
 * Normalized, deduped, sorted exclude keys.
 * @param {string[]|undefined} exclude
 * @returns {string[]}
 */
export function normalizeExcludeKeys(exclude) {
  return [...new Set((exclude ?? []).map(normalizePin))].sort();
}

/**
 * Throws when the orchestrator's own platform is excluded. Checked before unknown keys: the
 * orchestrator is also the implementer, so excluding it is a contradiction whatever else the list holds.
 * @param {string[]} excluded normalized keys
 * @param {string|undefined} platform normalized orchestrator key
 */
export function assertOrchestratorNotExcluded(excluded, platform) {
  if (platform && excluded.includes(platform)) {
    throw new Error(`Cannot exclude the orchestrator platform "${platform}": it is also the implementer`);
  }
}

/**
 * Throws when an excluded key names no review-section platform.
 * @param {string[]} excluded normalized, sorted keys
 * @param {Set<string>} reviewKeys
 */
export function assertKnownExcludeKeys(excluded, reviewKeys) {
  const unknown = excluded.filter(k => !reviewKeys.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `Unrecognized exclude key(s): ${unknown.join(', ')}. Valid keys: ${[...reviewKeys].sort().join(', ')}`
    );
  }
}

// ============================================================================
// SECTION: Core resolution
// ============================================================================

/**
 * Resolves the flow plan.
 *
 * Pure over its inputs: no clock, filesystem, or process access.
 *
 * @param {{ platform: string, level?: string, pins?: string[], exclude?: string[],
 *           orchestratorModel?: string | null,
 *           dispatchPlatforms?: { keys: string[] | null, path: string | null } | null,
 *           livenessSource?: 'env-override' | 'probe' }} options
 *   `livenessSource` and `dispatchPlatforms` are passed in rather than read from the environment
 *   or disk, keeping this pure.
 * @param {Record<string, boolean>} liveness - map of platform key → available
 * @param {object} config                    - parsed config object
 * @returns {object} flow plan JSON
 */
export function resolveFlow(options, liveness, config) {
  const { level = 'medium', pins: rawPins, orchestratorModel = null, dispatchPlatforms = null } = options;
  // Same alias normalization as pins, so `claudecode` still self-excludes `claude`.
  const platform = options.platform ? normalizePin(options.platform) : options.platform;
  // An unvalidated platform self-excludes nothing, so the orchestrator's own agent would be
  // emitted as an "external" reviewer target and the bogus key would reach the write-subagent table.
  if (platform && !KNOWN_PROVIDERS.includes(platform)) {
    throw new Error(
      `Unknown platform "${options.platform}". Valid platforms: ${KNOWN_PROVIDERS.join(', ')}`
    );
  }
  // A count pin (e.g. `(3)`) replaces provider-key pins entirely; parsePins throws on any
  // mix of the two forms before either is normalized.
  const { keys: pinKeys, count } = parsePins(rawPins);
  // Normalize through the same aliases `dispatch.mjs --provider` accepts (e.g.
  // `antigravity` -> `agy`) before deduping, so a pin spelled either way collapses
  // to one target instead of being treated as unrecognized or as two separate targets.
  const normalizedPins = pinKeys?.map(normalizePin);
  // Dedupe once at entry so a repeated `--pins x,x` cannot produce duplicate
  // dispatch targets in the same wave.
  const pins = normalizedPins ? [...new Set(normalizedPins)] : normalizedPins;
  const excluded = normalizeExcludeKeys(options.exclude);
  assertOrchestratorNotExcluded(excluded, platform);

  if (!LEVELS.includes(level)) {
    throw new Error(`Unknown level "${level}". Valid levels: ${LEVELS.join(', ')}`);
  }

  const problems = validateConfig(config, { dispatchPlatforms });
  if (problems.length > 0) {
    throw new Error(`Invalid config:\n- ${problems.join('\n- ')}`);
  }

  // Validation accepts alias keys, so resolve over canonical keys to match liveness and pins.
  const canonicalPlatforms = Object.fromEntries(
    SECTIONS.map(s => [
      s,
      Object.fromEntries(Object.entries(config[s].platforms).map(([k, v]) => [normalizePin(k), v])),
    ])
  );
  const platformsOf = section => canonicalPlatforms[section];

  // Validate pins and exclusions against the union of both review sections' platform keys
  const reviewKeys = reviewSectionKeys(config);
  if (pins && pins.length > 0) {
    const unknown = pins.filter(p => p !== 'all' && !reviewKeys.has(p));
    if (unknown.length > 0) {
      throw new Error(
        `Unrecognized pin key(s): ${unknown.join(', ')}. Valid keys: ${[...reviewKeys].sort().join(', ')}`
      );
    }
  }
  assertKnownExcludeKeys(excluded, reviewKeys);

  // An excluded platform fails liveness, so candidate selection, `--pins all` expansion and the
  // live-pin filter all skip it without special cases; `unavailable` is computed from the raw map.
  const rawLiveness = liveness;
  liveness = { ...rawLiveness };
  for (const k of excluded) liveness[k] = false;

  const clamped = {};
  const droppedPins = {};

  function expandPins(sectionName) {
    if (!pins || pins.length === 0) return [];
    const sectionKeys = Object.keys(platformsOf(sectionName));
    return pins.includes('all')
      ? [...new Set(pins.flatMap(p => (p === 'all' ? sectionKeys : p)))]
      : pins;
  }

  /**
   * Builds the live candidate list for one review section.
   * Pins override `targetCount`. Unpinned runs diversity-sort externals (every platform's first
   * candidate before any platform's second), then the orchestrator's candidates sorted the same
   * way, so external reviewers are preferred while the orchestrator can still satisfy targetCount.
   */
  function getCandidates(sectionName, targetCount) {
    const platforms = platformsOf(sectionName);
    const allKeys = Object.keys(platforms);

    if (pins && pins.length > 0) {
      const sectionPins = expandPins(sectionName);
      const validPins = sectionPins.filter(p => allKeys.includes(p));
      const livePins = validPins.filter(p => liveness[p] === true);
      if (validPins.length > 0 && livePins.length === 0) {
        const cause = validPins.some(p => excluded.includes(p)) ? 'excluded or unavailable' : 'unavailable';
        throw new Error(`All pinned platforms ${cause}: ${validPins.join(', ')}`);
      }
      const targets = [];
      for (const p of livePins) {
        const candidates = resolvePlatformCandidates(platforms[p], level);
        for (const c of candidates) {
          const target = { platform: p };
          if (c.model !== undefined) target.model = c.model;
          if (c.effort !== undefined) target.effort = c.effort;
          targets.push(target);
        }
      }
      // Pins name the whole reviewer set, so there is nothing to substitute from.
      return { targets, reserves: [] };
    }

    // Unpinned: gather live candidates for each configured platform
    const externalCandidates = [];
    const orchestratorDiffModel = [];
    const orchestratorSameModel = [];

    for (const k of allKeys) {
      if (liveness[k] !== true) continue;
      const candidates = resolvePlatformCandidates(platforms[k], level);
      for (const c of candidates) {
        const target = { platform: k };
        if (c.model !== undefined) target.model = c.model;
        if (c.effort !== undefined) target.effort = c.effort;
        if (k === platform) {
          if (isSameModel(c.model, orchestratorModel)) {
            orchestratorSameModel.push(target);
          } else {
            orchestratorDiffModel.push(target);
          }
        } else {
          externalCandidates.push(target);
        }
      }
    }

    const orderedCandidates = [
      ...diversitySort(externalCandidates),
      ...diversitySort(orchestratorDiffModel),
      ...diversitySort(orchestratorSameModel),
    ];
    const requested = targetCount === 'all' ? orderedCandidates.length : targetCount;
    const resolved = Math.min(requested, orderedCandidates.length);
    if (resolved < requested) clamped[sectionName] = { requested, resolved };
    // Liveness only proves a CLI runs, not that it is authenticated or has quota, so the
    // candidates beyond targetCount are kept as ordered substitutes for a target that fails.
    return { targets: orderedCandidates.slice(0, resolved), reserves: orderedCandidates.slice(resolved) };
  }

  function buildReviewSection(sectionName) {
    const section = config[sectionName];
    let maxRounds = resolveLevelScalar(section.maxRounds, level);
    // A count pin overrides the level's targetCount outright, the same way a provider-key
    // pin overrides breadth by naming candidates instead of a count.
    const targetCount = count ?? resolveLevelScalar(section.targetCount, level);
    const consensus = resolveLevelScalar(section.consensus, level);

    // `targetCount: 0` means skip the phase; express it the same way `maxRounds: 0`
    // does so callers have a single sentinel: `maxRounds === 0`. Pins override breadth
    // entirely (per the Invocation grammar), so an explicit pin still runs the phase
    // even when the level's targetCount is 0; a count pin is always ≥ 1, so it never trips this.
    if ((!pins || pins.length === 0) && targetCount === 0) maxRounds = 0;

    // `maxRounds === 0` means the phase is configured off; `targets` empty with
    // `maxRounds > 0` means platforms are unavailable — the in-process fallback applies.
    // `maxRounds` caps total fan-out waves including the first review; each wave
    // dispatches every target in `targets`.
    const { targets, reserves } =
      maxRounds === 0 ? { targets: [], reserves: [] } : getCandidates(sectionName, targetCount);

    // Only meaningful for a phase that actually runs: a phase with maxRounds 0 drops
    // every pin by construction, which is not a diagnostic worth reporting. Covers
    // both an unrecognized pin key and a pin that's configured but currently offline —
    // either way it's absent from the resolved targets and worth surfacing.
    if (maxRounds > 0 && pins && pins.length > 0) {
      const sectionPins = expandPins(sectionName);
      const liveKeys = new Set(targets.map(t => t.platform));
      // An excluded pin is reported once, in `diagnostics.excluded`, not as a dropped pin.
      const dropped = sectionPins.filter(p => !liveKeys.has(p) && !excluded.includes(p));
      if (dropped.length > 0) droppedPins[sectionName] = dropped;
    }

    return { targets, reserves, maxRounds, consensus };
  }

  const planReview = buildReviewSection('plan-review');

  const implEntry = platformsOf('implementation')[platform] ?? {};
  const implHints = resolveLevelEntry(implEntry, level);
  const implementation = { platform };
  if (implHints.model !== undefined) implementation.model = implHints.model;
  if (implHints.effort !== undefined) implementation.effort = implHints.effort;

  const codeReview = buildReviewSection('code-review');

  const configured = new Set(SECTIONS.flatMap(s => Object.keys(platformsOf(s))));
  const unavailable = [...configured].filter(k => rawLiveness[k] !== true && !excluded.includes(k)).sort();

  const flow = {
    'plan-review': planReview,
    implementation,
    'code-review': codeReview,
    diagnostics: {
      effectiveLevel: level,
      unavailable,
      excluded,
      droppedPins,
      clamped,
      targetCountPin: count ?? null,
      livenessSource: options.livenessSource ?? 'probe',
    },
  };

  return flow;
}

// ============================================================================
// SECTION: CLI entry point
// ============================================================================

function parseArgs(args) {
  const opts = {};
  const value = i => {
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`Missing value for ${args[i]}`);
    }
    return next;
  };

  const setPins = raw => {
    opts.pins = raw.split(',').map(s => s.trim()).filter(Boolean);
  };
  const setExclude = raw => {
    opts.exclude = raw.split(',').map(s => s.trim()).filter(Boolean);
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    // `--flag=value` form, matching the `=`-form dispatch runners already accept
    // (via common.mjs's parseCommonArgs) so CLI ergonomics are consistent across scripts.
    if (arg.startsWith('--') && eq !== -1) {
      const flag = arg.slice(0, eq);
      const val = arg.slice(eq + 1);
      switch (flag) {
        case '--platform': opts.platform = val; continue;
        case '--orchestrator-model': opts.orchestratorModel = val; continue;
        case '--level':    opts.level = val; continue;
        case '--pins':     setPins(val); continue;
        case '--exclude':  setExclude(val); continue;
        default:
          throw new Error(`Unrecognized argument "${flag}"`);
      }
    }
    switch (arg) {
      case '--platform': opts.platform = value(i); i++; break;
      case '--orchestrator-model': opts.orchestratorModel = value(i); i++; break;
      case '--level':    opts.level = value(i); i++; break;
      case '--pins':
        setPins(value(i));
        i++;
        break;
      case '--exclude':
        setExclude(value(i));
        i++;
        break;
      case '--validate-only': opts.validateOnly = true; break;
      case '-h':
      case '--help': opts.help = true; break;
      default:
        throw new Error(`Unrecognized argument "${arg}"`);
    }
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }

  if (opts.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  // Integrity gate, mirroring `dispatch.mjs`'s `assertSkillIntegrity`: a missing manifest warns
  // and proceeds (e.g. an install that predates this manifest), a drifted one aborts before any
  // config load or provider probe.
  const integrity = verifySkillIntegrity(path.resolve(__dirname, '..'));
  if (!integrity.valid && !integrity.missing) {
    process.stderr.write(
      `[implement-dispatch] WARNING: Skill file integrity check failed! Modified files:\n` +
        integrity.violations.map((v) => `  - ${v}`).join('\n') +
        '\n' +
        `[implement-dispatch] This may indicate tampering. Aborting flow resolution.\n`
    );
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`Error loading config: ${err.message}\n`);
    process.exit(1);
  }

  // Read once and share: both the validate-only path and the resolve path cross-check this skill's
  // platforms against dispatch's, and neither should pay a second config read.
  const dispatchPlatforms = loadDispatchPlatformKeys();
  if (!dispatchPlatforms.keys) {
    const diagnostics = [];
    if (dispatchPlatforms.error) diagnostics.push(dispatchPlatforms.error);
    if (dispatchPlatforms.problems?.length) {
      const location = dispatchPlatforms.path ? ` (${dispatchPlatforms.path})` : '';
      diagnostics.push(`Invalid dispatch config${location}:`, ...dispatchPlatforms.problems);
    }
    const detail = diagnostics.length > 0 ? `\n- ${diagnostics.join('\n- ')}` : '';
    process.stderr.write(
      "[implement-dispatch] ERROR: dispatch's effective platform set could not be loaded; " +
        `refusing to resolve provider targets.${detail}\n`
    );
    process.exit(1);
  }

  // `--validate-only` short-circuits before liveness so it spawns no provider probes.
  if (opts.validateOnly) {
    // Refuse the combination rather than silently ignoring flags the user believes
    // were checked: --validate-only inspects the config schema and nothing else.
    const ignored = ['platform', 'orchestratorModel', 'level', 'pins', 'exclude'].filter(k => opts[k] !== undefined);
    if (ignored.length > 0) {
      process.stderr.write(
        `Error: --validate-only checks the config schema alone and cannot be combined with: ${ignored
          .map(k => (k === 'orchestratorModel' ? '--orchestrator-model' : `--${k}`))
          .join(', ')}\n`
      );
      process.exit(1);
    }
    const problems = validateConfig(config, { dispatchPlatforms });
    if (problems.length > 0) {
      process.stderr.write(`Invalid config:\n- ${problems.join('\n- ')}\n`);
      process.exit(1);
    }
    process.stdout.write('Config is valid.\n');
    return;
  }

  // Presence of the required flags is a CLI concern; their shape is checked by
  // `resolveFlow`, which enforces it for programmatic callers too.
  if (!opts.platform) {
    process.stderr.write('Error: --platform is required\n');
    process.exit(1);
  }

  // Pre-validate options before asynchronous liveness probing so invalid CLI
  // arguments fail fast without waiting for slow provider network/CLI probes.
  if (opts.level !== undefined && !LEVELS.includes(opts.level)) {
    process.stderr.write(`Error: Unknown level "${opts.level}". Valid levels: ${LEVELS.join(', ')}\n`);
    process.exit(1);
  }
  // Normalize first: this block runs before `resolveFlow`'s own normalizePin, so testing the raw
  // spelling would reject the documented aliases `claudecode` and `antigravity`. The message
  // still quotes what the user typed.
  if (!KNOWN_PROVIDERS.includes(normalizePin(opts.platform))) {
    process.stderr.write(
      `Error: Unknown platform "${opts.platform}". Valid platforms: ${KNOWN_PROVIDERS.join(', ')}\n`
    );
    process.exit(1);
  }
  const configProblems = validateConfig(config, { dispatchPlatforms });
  if (configProblems.length > 0) {
    process.stderr.write(`Invalid config:\n- ${configProblems.join('\n- ')}\n`);
    process.exit(1);
  }
  // parsePins throws on an invalid count (below 1, unsafe) or a count mixed with anything
  // else; surfacing that here keeps it ahead of liveness probing along with every other
  // pre-validation check.
  let pinKeys;
  try {
    ({ keys: pinKeys } = parsePins(opts.pins));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
  if (pinKeys && pinKeys.length > 0) {
    const normalizedPins = pinKeys.map(normalizePin);
    const allKeys = reviewSectionKeys(config);
    const unknown = normalizedPins.filter(p => p !== 'all' && !allKeys.has(p));
    if (unknown.length > 0) {
      process.stderr.write(
        `Error: Unrecognized pin key(s): ${unknown.join(', ')}. Valid keys: ${[...allKeys].sort().join(', ')}\n`
      );
      process.exit(1);
    }
  }

  // Same checks resolveFlow runs, repeated here only so a typo fails before the slow probes.
  if (opts.exclude && opts.exclude.length > 0) {
    const excluded = normalizeExcludeKeys(opts.exclude);
    try {
      assertOrchestratorNotExcluded(excluded, normalizePin(opts.platform));
      assertKnownExcludeKeys(excluded, reviewSectionKeys(config));
    } catch (err) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }
  }

  let liveness;
  let livenessSource;
  try {
    ({ liveness, source: livenessSource } = await defaultLiveness(probeCandidates(opts, config)));
  } catch (err) {
    process.stderr.write(`Error checking liveness: ${err.message}\n`);
    process.exit(1);
  }

  const orchestratorModel =
    opts.orchestratorModel !== undefined
      ? (opts.orchestratorModel || null)
      : detectOrchestratorModel({ orchestrator: normalizePin(opts.platform) });

  let result;
  try {
    result = resolveFlow({ ...opts, orchestratorModel, livenessSource, dispatchPlatforms }, liveness, config);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

// Run main only when invoked directly
if (isMainModule(import.meta.url)) {
  main().catch(err => {
    process.stderr.write(`Unexpected error: ${err.message}\n`);
    process.exit(1);
  });
}
