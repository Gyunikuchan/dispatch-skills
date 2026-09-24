// @ts-check
/**
 * Resolves the review and implementation flow plan from the dispatch config: plan-review,
 * design-review, and code-review targets filtered from `read-delegates` by each phase's `only`, the
 * implementation launch from `write-subagents[<platform>]`, and run diagnostics. Artifact paths are
 * resolved separately by artifacts/resolve-paths.mjs.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  KNOWN_PROVIDERS,
  PROVIDER_ALIASES,
  demoteOrchestratorTargets,
  diversitySort,
} from './providers.mjs';
import {
  LEVELS,
  REVIEW_PHASES,
  phaseMembers,
  resolveLevelEntry,
  resolveLevelScalar,
  resolveTargets,
  selectedLevelKey,
  validateConfig,
} from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PHASE_KNOBS = ['rounds', 'targets', 'consensus'];
const IMPLEMENTATION_FIELDS = ['model', 'effort'];

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalizes a raw pin string (provider key or alias, case-insensitive) to its
 * canonical provider key or the reserved "all" pin keyword.
 */
export function normalizePin(rawPin) {
  const lower = rawPin.toLowerCase();
  return PROVIDER_ALIASES[lower] ?? (lower === 'all' ? 'all' : rawPin);
}

export function parseImplementationFields(raw) {
  if (raw === undefined) return ['model'];
  if (raw === 'none' || raw === '') return [];
  const fields = [...new Set(String(raw).split(',').map(value => value.trim()).filter(Boolean))];
  const unknown = fields.filter(field => !IMPLEMENTATION_FIELDS.includes(field));
  if (unknown.length > 0 || !fields.includes('model')) {
    throw new Error(
      `--implementation-fields must be "model" or "model,effort" (or "none") (received "${raw}")`
    );
  }
  return IMPLEMENTATION_FIELDS.filter(field => fields.includes(field));
}

function writeSubagentModelKey(platform, entry, level) {
  const selected = selectedLevelKey(entry, level);
  return selected
    ? `write-subagents.${platform}.${selected}.model`
    : `write-subagents.${platform}.model`;
}

function applicableImplementationEntry(entry, fields) {
  return Object.fromEntries(
    fields
      .filter(field => entry[field] !== undefined)
      .map(field => [field, entry[field]])
  );
}

function normalizeFieldValue(value) {
  if (Array.isArray(value)) {
    return value.length === 1 ? value[0] : value;
  }
  return value;
}

function hasDistinctApplicableField(current, candidate, fields) {
  return fields.some(
    field => candidate[field] !== undefined && JSON.stringify(normalizeFieldValue(candidate[field])) !== JSON.stringify(normalizeFieldValue(current[field]))
  );
}

export function resolveImplementationEscalation(entry, requestedLevel, applicableFields) {
  const levelKeys = isPlainObject(entry)
    ? LEVELS.filter(level => isPlainObject(entry[level]))
    : [];
  if (levelKeys.length === 0) return { status: 'exhausted', reason: 'no-distinct-higher-level' };

  const current = resolveLevelEntry(entry, requestedLevel);
  const requestedIndex = LEVELS.indexOf(requestedLevel);
  for (const level of LEVELS.slice(requestedIndex + 1)) {
    if (!levelKeys.includes(level)) continue;
    const resolved = resolveLevelEntry(entry, level);
    if (resolved.model === undefined) continue;
    if (!hasDistinctApplicableField(current, resolved, applicableFields)) continue;
    return {
      status: 'available',
      level,
      ...applicableImplementationEntry(resolved, applicableFields),
    };
  }
  return { status: 'exhausted', reason: 'no-distinct-higher-level' };
}

/**
 * Splits a raw `--pins` list into either provider keys, "all", or a single read-delegate count.
 * The three forms never mix: "all" and a count both select from the ordered candidate pool,
 * while provider keys name an explicit read-delegate set.
 *
 * @param {Array<string|number>|undefined} rawPins
 * @returns {{ keys: string[] | undefined, count: number | undefined }}
 */
export function parsePins(rawPins) {
  if (!rawPins || rawPins.length === 0) return { keys: undefined, count: undefined };
  const trimmed = rawPins.map(p => String(p).trim());
  const isCountLike = s => /^-?\d+$/.test(s);
  if (trimmed.some(isCountLike) || trimmed.some(s => s.toLowerCase() === 'all')) {
    if (rawPins.length > 1) {
      throw new Error(`A count or "all" pin must stand alone: ${rawPins.join(', ')}`);
    }
    if (trimmed[0].toLowerCase() === 'all') {
      return { keys: ['all'], count: undefined };
    }
    const count = Number(trimmed[0]);
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error(`A count pin must be an integer from 1 to ${Number.MAX_SAFE_INTEGER}`);
    }
    return { keys: undefined, count };
  }
  return { keys: trimmed, count: undefined };
}

/** Canonical-keyed copy of a platform table (validation accepts alias keys). */
function canonicalTable(table) {
  return Object.fromEntries(Object.entries(table ?? {}).map(([key, value]) => [normalizePin(key), value]));
}

// ============================================================================
// SECTION: Liveness
// ============================================================================

export const RUNNER_FILES = {
  claude: 'runners/claude.mjs',
  agy: 'runners/agy.mjs',
  copilot: 'runners/copilot.mjs',
  opencode: 'runners/opencode.mjs',
};

/**
 * Test-only override: a JSON object of `{ provider: boolean }` replacing the real probes.
 *
 * Each real probe spawns a provider CLI and waits on it, so a CLI test suite that exercises a
 * dozen argument combinations spends most of its runtime re-discovering the same binaries — and
 * its assertions then depend on what happens to be installed on the machine running it.
 */
const LIVENESS_ENV_VAR = 'DISPATCH_LIVENESS_JSON';

/**
 * Explicit opt-in that arms the liveness seam above.
 *
 * A dedicated variable rather than `NODE_ENV=test`: ambient signals set by unrelated tooling are
 * exactly how an inherited payload silently replaces real probing in a production run.
 */
const TEST_MODE_ENV_VAR = 'DISPATCH_TEST_MODE';

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
        const mod = await import(pathToFileURL(path.join(__dirname, '..', RUNNER_FILES[key])).href);
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
  const configured = new Set(Object.keys(config?.['read-delegates'] ?? {}).map(normalizePin));
  const platform = opts.platform ? normalizePin(opts.platform) : undefined;
  if (platform) configured.add(platform);

  const excluded = new Set(normalizeExcludeKeys(opts.exclude));
  // A count pin probes like unpinned breadth: it names how many read delegates, not which ones, so
  // narrowing the probe set the way a provider-key pin does would starve candidate selection.
  const { keys: pinKeys, count } = parsePins(opts.pins);
  const pins = (pinKeys ?? []).map(normalizePin);
  const keys = count === undefined && pins.length > 0 && !pins.includes('all')
    ? [...configured].filter((key) => pins.includes(key) || key === platform)
    : [...configured];
  return keys.filter((key) => !excluded.has(key));
}

/**
 * Canonical keys pins and exclusions validate against: the union of `phaseMembers` over every
 * phase present in `phases` (every read-delegate key when the table is absent or empty),
 * independent of level.
 * @param {Record<string, any>} config
 * @returns {Set<string>}
 */
export function reviewPhaseKeys(config) {
  const present = REVIEW_PHASES.filter(phase => isPlainObject(config?.phases?.[phase]));
  if (present.length === 0) {
    return new Set(Object.keys(config?.['read-delegates'] ?? {}).map(normalizePin));
  }
  return new Set(present.flatMap(phase => phaseMembers(config, phase)));
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
 * orchestrator also hosts the write subagent, so excluding it is a contradiction whatever else the list holds.
 * @param {string[]} excluded normalized keys
 * @param {string|undefined} platform normalized orchestrator key
 */
export function assertOrchestratorNotExcluded(excluded, platform) {
  if (platform && excluded.includes(platform)) {
    throw new Error(`Cannot exclude the orchestrator platform "${platform}": it also hosts the write subagent`);
  }
}

/**
 * Throws when an excluded key names no review-phase platform.
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

function assertKnownPins(pins, reviewKeys) {
  const unknown = pins.filter(p => p !== 'all' && !reviewKeys.has(p));
  if (unknown.length > 0) {
    throw new Error(
      `Unrecognized pin key(s): ${unknown.join(', ')}. Valid keys: ${[...reviewKeys].sort().join(', ')}`
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
 *           orchestratorModel?: string | null, implementationFields?: string,
 *           tolerateMissingImplementationModel?: boolean,
 *           livenessSource?: 'env-override' | 'probe' }} options
 * @param {Record<string, boolean>} liveness - map of platform key → available
 * @param {Record<string, any>} config                    - parsed config object
 * @returns {Record<string, any>} flow plan JSON
 */
export function resolveFlow(options, liveness, config) {
  const { level = 'medium', pins: rawPins, orchestratorModel = null } = options;
  // Same alias normalization as pins, so `claudecode` still self-excludes `claude`.
  const platform = options.platform ? normalizePin(options.platform) : options.platform;
  // An unvalidated platform self-excludes nothing, so the orchestrator's own agent would be
  // emitted as an external read-delegate target and the bogus key would reach write-subagents.
  if (platform && !KNOWN_PROVIDERS.includes(platform)) {
    throw new Error(
      `Unknown platform "${options.platform}". Valid platforms: ${KNOWN_PROVIDERS.join(', ')}`
    );
  }
  // Count and "all" pins replace provider-key pins entirely; parsePins rejects mixed forms.
  const { keys: pinKeys, count } = parsePins(rawPins);
  // Normalize aliases then dedupe, so `antigravity,agy` collapses to one target.
  const pins = pinKeys ? [...new Set(pinKeys.map(normalizePin))] : pinKeys;
  const isAllPin = pins?.includes('all') === true;
  const hasExplicitBreadth = count !== undefined || isAllPin;
  const excluded = normalizeExcludeKeys(options.exclude);
  assertOrchestratorNotExcluded(excluded, platform);

  if (!LEVELS.includes(level)) {
    throw new Error(`Unknown level "${level}". Valid levels: ${LEVELS.join(', ')}`);
  }

  const problems = validateConfig(config);
  if (problems.length > 0) {
    throw new Error(`Invalid config:\n- ${problems.join('\n- ')}`);
  }

  const readDelegates = canonicalTable(config['read-delegates']);
  const writeSubagents = canonicalTable(config['write-subagents']);

  const reviewKeys = reviewPhaseKeys(config);
  if (pins && pins.length > 0) assertKnownPins(pins, reviewKeys);
  assertKnownExcludeKeys(excluded, reviewKeys);

  // An excluded platform fails liveness, so candidate selection and the live-pin filter skip it
  // without special cases; `unavailable` is computed from the raw map.
  const rawLiveness = liveness;
  liveness = { ...rawLiveness };
  for (const k of excluded) liveness[k] = false;

  const clamped = {};
  const droppedPins = {};

  /**
   * Builds the candidate list for one review phase over its `only`-filtered members.
   * Named pins dispatch every listed member platform. Count and "all" selection preserves
   * configured candidate order, moving the orchestrator platform behind alternatives and an exact
   * orchestrator platform/model match to the end.
   */
  function getCandidates(phase, targets) {
    const members = phaseMembers(config, phase);
    const namedPins = pins && !isAllPin ? pins : [];
    const configuredCandidates = members.flatMap((key) =>
      resolveTargets(readDelegates[key], level, key).map((candidate, candidateIndex) => {
        const target = { candidateId: `${phase}:${key}:${candidateIndex}`, platform: key };
        if (candidate.model !== undefined) target.model = candidate.model;
        if (candidate.effort !== undefined) target.effort = candidate.effort;
        return target;
      }));

    if (namedPins.length > 0) {
      const validPins = namedPins.filter(p => members.includes(p));
      const eligiblePins = validPins.filter(p => !excluded.includes(p));
      if (validPins.length > 0 && eligiblePins.length === 0) {
        throw new Error(`All pinned platforms excluded: ${validPins.join(', ')}`);
      }
      // Pins name the whole read-delegate set, so there is nothing to substitute from.
      return {
        targets: eligiblePins.flatMap((pin) => configuredCandidates.filter((c) => c.platform === pin)),
        reserves: [],
      };
    }

    // Explicit count/all uses every configured candidate. Unpinned selection keeps its liveness
    // filter and diversity ordering so a narrow configured `targets` prefers distinct platforms.
    const eligibleCandidates = configuredCandidates.filter((candidate) =>
      !excluded.includes(candidate.platform) &&
      (hasExplicitBreadth || liveness[candidate.platform] === true));

    const orderedCandidates = demoteOrchestratorTargets(
      eligibleCandidates,
      platform,
      orchestratorModel,
      undefined,
      undefined,
      hasExplicitBreadth ? undefined : diversitySort,
    );
    const requested = targets === 'all' ? orderedCandidates.length : targets;
    const resolved = Math.min(requested, orderedCandidates.length);
    if (resolved < requested) clamped[phase] = { requested, resolved };
    // Liveness only proves a CLI runs, not that it is authenticated or has quota, so the
    // candidates beyond `targets` are kept as ordered substitutes for a target that fails.
    return { targets: orderedCandidates.slice(0, resolved), reserves: orderedCandidates.slice(resolved) };
  }

  function buildReviewPhase(phase) {
    const policy = config.phases?.[phase];
    // An absent phase is off at every level; no pin revives it.
    if (!isPlainObject(policy)) {
      return { targets: [], reserves: [], rounds: 0, consensus: false, configured: false };
    }
    let rounds = resolveLevelScalar(policy.rounds, level);
    // Count and "all" override the level's targets; named pins override breadth by naming
    // the complete explicit platform set.
    const targets = isAllPin ? 'all' : count ?? resolveLevelScalar(policy.targets, level);
    const consensus = resolveLevelScalar(policy.consensus, level);

    // `targets: 0` means skip the phase; express it the way `rounds: 0` does so callers have a
    // single sentinel. Any pin overrides breadth, so a pinned phase still runs.
    if ((!pins || pins.length === 0) && targets === 0) rounds = 0;

    // `rounds === 0` means the phase is off; empty `targets` with `rounds > 0` means platforms are
    // unavailable — the in-process fallback applies. `rounds` caps total waves, each dispatching
    // every target.
    const selected = rounds === 0 ? { targets: [], reserves: [] } : getCandidates(phase, targets);

    // Only meaningful for a phase that runs: covers a named pin outside this phase's `only`.
    if (rounds > 0 && pins && pins.length > 0 && !isAllPin) {
      const resolvedKeys = new Set(selected.targets.map(t => t.platform));
      // An excluded pin is reported once, in `diagnostics.excluded`, not as a dropped pin.
      const dropped = pins.filter(p => !resolvedKeys.has(p) && !excluded.includes(p));
      if (dropped.length > 0) droppedPins[phase] = dropped;
    }

    return { ...selected, rounds, consensus, configured: true };
  }

  const implementation = resolveImplementation(options, platform, level, writeSubagents);

  const flow = {
    'plan-review': buildReviewPhase('plan-review'),
    'design-review': buildReviewPhase('design-review'),
    implementation,
    'code-review': buildReviewPhase('code-review'),
  };

  const unavailable = Object.keys(readDelegates).filter(k => rawLiveness[k] !== true && !excluded.includes(k)).sort();
  flow.diagnostics = {
    effectiveLevel: level,
    unavailable,
    excluded,
    droppedPins,
    clamped,
    targetCountPin: isAllPin ? 'all' : count ?? null,
    livenessSource: options.livenessSource ?? 'probe',
  };
  return flow;
}

/** Resolves the orchestrator's write-subagent launch fields and escalation. */
function resolveImplementation(options, platform, level, writeSubagents) {
  const implementation = { platform };
  const applicableFields = !platform ? [] : parseImplementationFields(options.implementationFields);
  implementation.applicableFields = applicableFields;

  const entry = platform ? writeSubagents[platform] : undefined;
  if (platform && entry === undefined) {
    const key = `write-subagents.${platform}`;
    const message = `${key} is not configured; add it to the dispatch config (diff against config.sample.jsonc)`;
    if (!options.tolerateMissingImplementationModel) throw new Error(message);
    implementation.ignoredConfiguredFields = [];
    implementation.diagnostic = { code: 'WRITE_SUBAGENT_NOT_CONFIGURED', message, key };
    implementation.escalation = { status: 'exhausted', reason: 'not-configured' };
    return implementation;
  }

  const hints = resolveLevelEntry(entry ?? {}, level);
  implementation.ignoredConfiguredFields = IMPLEMENTATION_FIELDS.filter(
    field => hints[field] !== undefined && !applicableFields.includes(field)
  );
  for (const field of applicableFields) {
    if (hints[field] !== undefined) implementation[field] = hints[field];
  }
  if (!platform || applicableFields.length === 0) {
    implementation.escalation = { status: 'exhausted', reason: !platform ? 'no-platform' : 'fieldless-launcher' };
    return implementation;
  }
  if (applicableFields.includes('model') && hints.model === undefined) {
    const key = writeSubagentModelKey(platform, entry, level);
    const message = `${key} must resolve an explicit model for implementation`;
    if (!options.tolerateMissingImplementationModel) throw new Error(message);
    implementation.diagnostic = { code: 'IMPLEMENTATION_MODEL_REQUIRED', message, key };
  }
  implementation.escalation = resolveImplementationEscalation(entry, level, applicableFields);
  return implementation;
}
