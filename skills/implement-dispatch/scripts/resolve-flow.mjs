#!/usr/bin/env node
/**
 * Resolves the implement-dispatch execution flow plan.
 *
 * Usage:
 *   node resolve-flow.mjs --platform <key>
 *                         [--level <low|medium|high|xhigh|max>] [--pins <key,key,...|all>]
 *   node resolve-flow.mjs --validate-only
 *
 * Outputs JSON to stdout describing plan-review, implementation, and code-review
 * targets and run diagnostics. Artifact paths are resolved separately by
 * dispatch's resolve-artifact-paths.mjs (single source of truth shared with
 * dispatch-plan-review/dispatch-code-review) — not this script's concern.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PROJECT_ROOT, isMainModule, getConfigCandidates, loadSkillConfig } from '../../dispatch/scripts/common.mjs';
import { PROVIDER_ALIASES } from '../../dispatch/scripts/dispatch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DISPATCH_SCRIPTS = path.resolve(__dirname, '../../dispatch/scripts');

/** Invocation grammar for `/implement-dispatch <level>`; not a per-project preference. */
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

const REVIEW_SECTIONS = ['plan-review', 'code-review'];
const SECTIONS = ['plan-review', 'implementation', 'code-review'];
const REVIEW_KNOBS = ['maxRounds', 'targetCount', 'consensus', 'includeSelf', 'toolTurns'];
/** Knobs that may be omitted entirely; every other knob must define at least one level. */
const OPTIONAL_KNOBS = ['includeSelf'];

/**
 * Normalizes a raw pin string (provider key or alias, case-insensitive) to its
 * canonical provider key or the reserved "all" pin keyword.
 */
export function normalizePin(rawPin) {
  const lower = rawPin.toLowerCase();
  return PROVIDER_ALIASES[lower] ?? (lower === 'all' ? 'all' : rawPin);
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
 * (`low`/`medium`/`high`/`max`) overriding them, or both. Shape problems are fatal at
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
    const entry = platforms[key];
    if (!isPlainObject(entry)) {
      problems.push(`${where}.${key} must be an object (${DIFF_HINT}).`);
      continue;
    }
    for (const [field, value] of Object.entries(entry)) {
      if (field === 'model' || field === 'effort') {
        if (typeof value !== 'string') {
          problems.push(`${where}.${key}.${field} must be a string (${DIFF_HINT}).`);
        }
        continue;
      }
      if (!LEVELS.includes(field)) {
        problems.push(
          `${where}.${key} has unrecognized key "${field}". Valid keys: model, effort, ${LEVELS.join(', ')} (${DIFF_HINT}).`
        );
        continue;
      }
      if (!isPlainObject(value)) {
        problems.push(`${where}.${key}.${field} must be an object with model/effort (${DIFF_HINT}).`);
        continue;
      }
      // A level override carries only model/effort; a typo or an empty object here
      // would otherwise validate clean and silently resolve to no hint at all.
      if (Object.keys(value).length === 0) {
        problems.push(
          `${where}.${key}.${field} must set at least one of model, effort (${DIFF_HINT}).`
        );
      }
      for (const [inner, innerValue] of Object.entries(value)) {
        if (inner !== 'model' && inner !== 'effort') {
          problems.push(
            `${where}.${key}.${field} has unrecognized key "${inner}". Valid keys: model, effort (${DIFF_HINT}).`
          );
        } else if (typeof innerValue !== 'string') {
          problems.push(`${where}.${key}.${field}.${inner} must be a string (${DIFF_HINT}).`);
        }
      }
    }
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
      case 'includeSelf':
        if (typeof value !== 'boolean') {
          problems.push(`${where}.${key} must be a boolean (${DIFF_HINT}).`);
        }
        break;
      case 'toolTurns':
        if (!Number.isInteger(value) || value < 1) {
          problems.push(`${where}.${key} must be a positive integer (${DIFF_HINT}).`);
        }
        break;
    }
  }
}

/**
 * Validates a parsed config against the flow schema.
 *
 * Reports every problem found in one pass; callers join and throw.
 *
 * @param {object} config
 * @returns {string[]} problem descriptions, empty when the config is valid
 */
export function validateConfig(config) {
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
        if (!OPTIONAL_KNOBS.includes(knob)) {
          problems.push(`Section "${section}" is missing required knob "${knob}" (${DIFF_HINT}).`);
        }
        continue;
      }
      validateKnob(section, knob, value, problems);
    }
  }

  return problems;
}

// ============================================================================
// SECTION: Liveness
// ============================================================================

export async function defaultLiveness() {
  const results = {};
  const runners = {
    claude: 'claude-run.mjs',
    agy: 'agy-run.mjs',
    copilot: 'copilot-run.mjs',
    opencode: 'opencode-run.mjs',
  };
  await Promise.all(
    Object.entries(runners).map(async ([key, file]) => {
      try {
        const mod = await import(pathToFileURL(path.join(DISPATCH_SCRIPTS, file)).href);
        const fnName = `is${key.charAt(0).toUpperCase()}${key.slice(1)}Available`;
        results[key] = !!(await mod[fnName]?.());
      } catch {
        results[key] = false;
      }
    })
  );
  // NOTE: back-compat alias for stale config.jsonc files that still use the old 'local' key.
  results.local = results.opencode;
  return results;
}

// ============================================================================
// SECTION: Core resolution
// ============================================================================

/**
 * Resolves the flow plan.
 *
 * Pure over its inputs: no clock, filesystem, or process access.
 *
 * @param {{ platform: string, level?: string, pins?: string[] }} options
 * @param {Record<string, boolean>} liveness - map of platform key → available
 * @param {object} config                    - parsed config object
 * @returns {object} flow plan JSON
 */
export function resolveFlow(options, liveness, config) {
  const { platform, level = 'medium', pins: rawPins } = options;
  // Normalize through the same aliases `dispatch.mjs --provider` accepts (e.g.
  // `antigravity` -> `agy`) before deduping, so a pin spelled either way collapses
  // to one target instead of being treated as unrecognized or as two separate targets.
  const normalizedPins = rawPins?.map(normalizePin);
  // Dedupe once at entry so a repeated `--pins x,x` cannot produce duplicate
  // dispatch targets in the same wave.
  const pins = normalizedPins ? [...new Set(normalizedPins)] : normalizedPins;

  if (!LEVELS.includes(level)) {
    throw new Error(`Unknown level "${level}". Valid levels: ${LEVELS.join(', ')}`);
  }

  const problems = validateConfig(config);
  if (problems.length > 0) {
    throw new Error(`Invalid config:\n- ${problems.join('\n- ')}`);
  }

  const platformsOf = section => config[section].platforms;

  // Validate pins against the union of both review sections' platform keys
  if (pins && pins.length > 0) {
    const allKeys = new Set(REVIEW_SECTIONS.flatMap(s => Object.keys(platformsOf(s))));
    const unknown = pins.filter(p => p !== 'all' && !allKeys.has(p));
    if (unknown.length > 0) {
      throw new Error(
        `Unrecognized pin key(s): ${unknown.join(', ')}. Valid keys: ${[...allKeys].sort().join(', ')}`
      );
    }
  }

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
   * Pins override `targetCount` and `includeSelf`; unpinned runs sort the
   * orchestrator last so a narrow count cannot silently yield a self-only review.
   */
  function getCandidates(sectionName, targetCount, includeSelf) {
    const platforms = platformsOf(sectionName);
    const allKeys = Object.keys(platforms);

    if (pins && pins.length > 0) {
      const sectionPins = expandPins(sectionName);
      const validPins = sectionPins.filter(p => allKeys.includes(p));
      const livePins = validPins.filter(p => liveness[p] === true);
      if (validPins.length > 0 && livePins.length === 0) {
        throw new Error(`All pinned platforms unavailable: ${validPins.join(', ')}`);
      }
      return livePins;
    }

    // Liveness filter — require explicit true; undefined (unknown platform) is unavailable
    let keys = allKeys.filter(k => liveness[k] === true);
    if (includeSelf) {
      keys = [...keys.filter(k => k !== platform), ...keys.filter(k => k === platform)];
    } else {
      keys = keys.filter(k => k !== platform);
    }

    const requested = targetCount === 'all' ? keys.length : targetCount;
    const resolved = Math.min(requested, keys.length);
    if (resolved < requested) clamped[sectionName] = { requested, resolved };
    return keys.slice(0, resolved);
  }

  function buildTarget(sectionName, key) {
    const hints = resolveLevelEntry(platformsOf(sectionName)[key] ?? {}, level);
    const target = { platform: key };
    if (hints.model !== undefined) target.model = hints.model;
    if (hints.effort !== undefined) target.effort = hints.effort;
    // Flag same-agent reviews (orchestrator is a target)
    if (key === platform) target.allowSameAgent = true;
    return target;
  }

  function buildReviewSection(sectionName) {
    const section = config[sectionName];
    let maxRounds = resolveLevelScalar(section.maxRounds, level);
    const targetCount = resolveLevelScalar(section.targetCount, level);
    const consensus = resolveLevelScalar(section.consensus, level);
    const includeSelf = resolveLevelScalar(section.includeSelf, level) ?? false;
    const toolTurns = resolveLevelScalar(section.toolTurns, level);

    // `targetCount: 0` means skip the phase; express it the same way `maxRounds: 0`
    // does so callers have a single sentinel: `maxRounds === 0`. Pins override breadth
    // entirely (per the Invocation grammar), so an explicit pin still runs the phase
    // even when the level's targetCount is 0.
    if ((!pins || pins.length === 0) && targetCount === 0) maxRounds = 0;

    // `maxRounds === 0` means the phase is configured off; `targets` empty with
    // `maxRounds > 0` means platforms are unavailable — the in-process fallback applies.
    // `maxRounds` caps total fan-out waves including the first review; each wave
    // dispatches every target in `targets`.
    const targets =
      maxRounds === 0
        ? []
        : getCandidates(sectionName, targetCount, includeSelf).map(k => buildTarget(sectionName, k));

    // Only meaningful for a phase that actually runs: a phase with maxRounds 0 drops
    // every pin by construction, which is not a diagnostic worth reporting. Covers
    // both an unrecognized pin key and a pin that's configured but currently offline —
    // either way it's absent from the resolved targets and worth surfacing.
    if (maxRounds > 0 && pins && pins.length > 0) {
      const sectionPins = expandPins(sectionName);
      const liveKeys = new Set(targets.map(t => t.platform));
      const dropped = sectionPins.filter(p => !liveKeys.has(p));
      if (dropped.length > 0) droppedPins[sectionName] = dropped;
    }

    return { targets, maxRounds, consensus, toolTurns };
  }

  const planReview = buildReviewSection('plan-review');

  const implEntry = platformsOf('implementation')[platform] ?? {};
  const implHints = resolveLevelEntry(implEntry, level);
  const implementation = { platform };
  if (implHints.model !== undefined) implementation.model = implHints.model;
  if (implHints.effort !== undefined) implementation.effort = implHints.effort;

  const codeReview = buildReviewSection('code-review');

  const configured = new Set(SECTIONS.flatMap(s => Object.keys(platformsOf(s))));
  const unavailable = [...configured].filter(k => liveness[k] !== true).sort();

  const flow = {
    'plan-review': planReview,
    implementation,
    'code-review': codeReview,
    diagnostics: { effectiveLevel: level, unavailable, droppedPins, clamped },
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
        case '--level':    opts.level = val; continue;
        case '--pins':     setPins(val); continue;
        default:
          throw new Error(`Unrecognized argument "${flag}"`);
      }
    }
    switch (arg) {
      case '--platform': opts.platform = value(i); i++; break;
      case '--level':    opts.level = value(i); i++; break;
      case '--pins':
        setPins(value(i));
        i++;
        break;
      case '--validate-only': opts.validateOnly = true; break;
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

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`Error loading config: ${err.message}\n`);
    process.exit(1);
  }

  // `--validate-only` short-circuits before liveness so it spawns no provider probes.
  // Every other path lets `resolveFlow` validate, keeping one validation call per run.
  if (opts.validateOnly) {
    // Refuse the combination rather than silently ignoring flags the user believes
    // were checked: --validate-only inspects the config schema and nothing else.
    const ignored = ['platform', 'level', 'pins'].filter(k => opts[k] !== undefined);
    if (ignored.length > 0) {
      process.stderr.write(
        `Error: --validate-only checks the config schema alone and cannot be combined with: ${ignored
          .map(k => `--${k}`)
          .join(', ')}\n`
      );
      process.exit(1);
    }
    const problems = validateConfig(config);
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
  const configProblems = validateConfig(config);
  if (configProblems.length > 0) {
    process.stderr.write(`Invalid config:\n- ${configProblems.join('\n- ')}\n`);
    process.exit(1);
  }
  if (opts.pins && opts.pins.length > 0) {
    const normalizedPins = opts.pins.map(normalizePin);
    const allKeys = new Set(REVIEW_SECTIONS.flatMap(s => Object.keys(config[s]?.platforms ?? {})));
    const unknown = normalizedPins.filter(p => p !== 'all' && !allKeys.has(p));
    if (unknown.length > 0) {
      process.stderr.write(
        `Error: Unrecognized pin key(s): ${unknown.join(', ')}. Valid keys: ${[...allKeys].sort().join(', ')}\n`
      );
      process.exit(1);
    }
  }

  let liveness;
  try {
    liveness = await defaultLiveness();
  } catch (err) {
    process.stderr.write(`Error checking liveness: ${err.message}\n`);
    process.exit(1);
  }

  let result;
  try {
    result = resolveFlow(opts, liveness, config);
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
