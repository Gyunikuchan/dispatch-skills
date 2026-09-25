// @ts-check
/**
 * @file providers.mjs
 * @description Provider registry and orchestrator awareness: provider/model/effort spec validation,
 * sandbox support, model identity, diversity ordering, and orchestrator detection.
 *
 * Supports Windows, macOS, Linux (bash, zsh, PowerShell).
 */


// SECTION: Provider registry

/** Canonical provider keys the dispatch config's platform tables may key on. */
export const KNOWN_PROVIDERS = ['claude', 'agy', 'copilot', 'opencode', 'codex'];

/** Accepted `--provider` aliases, normalized to their canonical Provider name. */
export const PROVIDER_ALIASES = {
  opencode: 'opencode',
  agy: 'agy',
  antigravity: 'agy',
  claude: 'claude',
  claudecode: 'claude',
  'claude-code': 'claude',
  copilot: 'copilot',
  'github-copilot': 'copilot',
  codex: 'codex',
  'openai-codex': 'codex',
};

/**
 * Validates a model override or configured candidate model before invocation.
 * Rejects empty strings, whitespace-only strings, strings with trailing colons (e.g. 'claude:'),
 * and empty or invalid arrays.
 *
 * @param {unknown} model
 * @param {string} [where='model']
 */
export function validateModelSpec(model, where = 'model') {
  if (model === null || model === undefined) return;
  if (typeof model === 'string') {
    const trimmed = model.trim();
    if (!trimmed || trimmed.endsWith(':')) {
      throw new Error(`Invalid ${where}: "${model}". Model cannot be empty, whitespace-only, or end with a colon.`);
    }
    if (model.includes(',')) {
      const parts = model.split(',').map((m) => m.trim());
      if (parts.length === 0 || parts.some((p) => !p || p.endsWith(':'))) {
        throw new Error(`Invalid ${where}: "${model}". Comma-separated models cannot contain empty or colon-suffixed entries.`);
      }
    }
    return;
  }
  if (Array.isArray(model)) {
    if (model.length === 0) {
      throw new Error(`Invalid ${where}: model list cannot be empty.`);
    }
    for (const item of model) {
      if (typeof item !== 'string' || !item.trim() || item.trim().endsWith(':')) {
        throw new Error(`Invalid ${where}: entry "${item}" cannot be empty, whitespace-only, or end with a colon.`);
      }
    }
    return;
  }
  throw new Error(`Invalid ${where}: must be a string or non-empty array of strings.`);
}

/**
 * Validates an effort override or configured candidate effort before invocation.
 *
 * @param {unknown} effort
 * @param {string} [where='effort']
 */
export function validateEffortSpec(effort, where = 'effort') {
  if (effort === null || effort === undefined) return;
  if (typeof effort !== 'string' || !effort.trim()) {
    throw new Error(`Invalid ${where}: "${effort}". Effort cannot be empty or whitespace-only.`);
  }
}

/**
 * Validates an explicit provider selection before invocation.
 *
 * @param {unknown} provider
 * @param {string} [where='provider']
 * @returns {string|null} canonical provider name
 */
export function validateProviderSpec(provider, where = 'provider') {
  if (provider === null || provider === undefined) return null;
  if (typeof provider !== 'string' || !provider.trim() || provider.trim().endsWith(':')) {
    throw new Error(`Invalid ${where}: "${provider}". Provider cannot be empty, whitespace-only, or end with a colon.`);
  }
  const normalized = provider.trim().toLowerCase();
  const canonical = PROVIDER_ALIASES[normalized];
  if (!canonical) {
    throw new Error(`Unknown provider specified: ${provider}`);
  }
  return canonical;
}

/** Providers whose `read-delegates.<key>` entry may set a `sandbox` boolean; rejected elsewhere. */
export const SANDBOX_SUPPORTED_PROVIDERS = ['claude', 'copilot', 'opencode', 'codex'];

// SECTION: Candidate ordering

/**
 * Stable first-occurrence partition shared by the ordering helpers below: items whose
 * key is seen for the first time land in `firsts` (input order), every repeat in `repeats`.
 */
function partitionFirstSeen(items, keyOf) {
  const seen = new Set();
  const firsts = [];
  const repeats = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) {
      repeats.push(item);
    } else {
      seen.add(key);
      firsts.push(item);
    }
  }
  return { firsts, repeats };
}

/**
 * Stable partition putting each key's first occurrence ahead of every repeat, so a platform
 * configured with several models cannot crowd other platforms out of the front of the order.
 *
 * @template {Record<string, any>} T
 * @param {T[]} candidates
 * @param {(candidate: T) => unknown} [key]
 * @returns {T[]} a new array; the input is not mutated
 */
export function diversitySort(candidates, key = (c) => c.platform) {
  const { firsts, repeats } = partitionFirstSeen(candidates, key);
  return [...firsts, ...repeats];
}

/**
 * Normalizes a model identifier by stripping provider prefixes (everything before the
 * last `/`), trailing 8-digit date suffixes matching `-YYYYMMDD`, and trimming/lowercasing.
 *
 * @param {string|null|undefined} model
 * @returns {string}
 */
export function normalizeModelId(model) {
  if (!model || typeof model !== 'string') return '';
  let id = model.trim();
  if (id.includes('/')) {
    id = id.slice(id.lastIndexOf('/') + 1);
  }
  id = id.replace(/-(?:20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))$/, '');
  return id.toLowerCase();
}

/**
 * Compares a candidate model (string or array of fallback strings) against an orchestrator model.
 * Returns false if orchestratorModel or candidateModel is nullish / empty.
 *
 * @param {string | string[] | null | undefined} candidateModel
 * @param {string | null | undefined} orchestratorModel
 * @returns {boolean}
 */
export function isSameModel(candidateModel, orchestratorModel) {
  if (!orchestratorModel || !candidateModel) return false;
  const target = normalizeModelId(orchestratorModel);
  if (!target) return false;

  if (Array.isArray(candidateModel)) {
    return candidateModel.some((m) => isSameModel(m, orchestratorModel));
  }
  if (typeof candidateModel !== 'string') return false;

  const candidate = normalizeModelId(candidateModel);
  return Boolean(candidate && candidate === target);
}

/**
 * Preserves configured target order while moving the orchestrator platform behind alternatives
 * and exact orchestrator platform/model matches to the end.
 *
 * @template {Record<string, any>} T
 * @param {T[]} candidates
 * @param {string|null|undefined} orchestrator
 * @param {string|null|undefined} orchestratorModel
 * @param {(candidate: T) => string} [platformOf]
 * @param {(candidate: T) => string|string[]|null|undefined} [modelOf]
 * @param {(group: T[]) => T[]} [sortGroup]
 * @returns {T[]}
 */
export function demoteOrchestratorTargets(
  candidates,
  orchestrator,
  orchestratorModel,
  platformOf = (candidate) => candidate.platform,
  modelOf = (candidate) => candidate.model,
  sortGroup = (group) => group,
) {
  if (!orchestrator) return sortGroup([...candidates]);
  const alternatives = candidates.filter((candidate) => platformOf(candidate) !== orchestrator);
  const orchestratorOtherModels = candidates.filter(
    (candidate) =>
      platformOf(candidate) === orchestrator && !isSameModel(modelOf(candidate), orchestratorModel),
  );
  const orchestratorSameModel = candidates.filter(
    (candidate) =>
      platformOf(candidate) === orchestrator && isSameModel(modelOf(candidate), orchestratorModel),
  );
  return [
    ...sortGroup(alternatives),
    ...sortGroup(orchestratorOtherModels),
    ...sortGroup(orchestratorSameModel),
  ];
}

// SECTION: Orchestrator detection

/**
 * Detects the orchestrator runtime from environment variables.
 *
 * Claude Code exports `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_ENTRYPOINT`;
 * probing only the `CLAUDE_CODE` / `CLAUDE_SESSION_ID` spellings once made detection return null
 * there, so the cascade delegated straight back to the orchestrator's own platform. Both are kept
 * below as belt-and-braces: two dead `process.env` reads cost nothing, a missed host costs a
 * delegate dispatched to itself. The VS Code heuristic was dropped instead, because `VSCODE_PID`
 * is set in any VS Code terminal whichever agent drives it — a false positive, not a miss.
 * `--orchestrator` overrides whatever this returns.
 * @returns {string|null} Provider key, or null when no host marker is present.
 */
export function detectOrchestrator(options = {}) {
  const env = options.env || process.env;
  if (
    env.ANTIGRAVITY_AGENT ||
    env.ANTIGRAVITY_CONVERSATION_ID ||
    env.ANTIGRAVITY_SESSION_ID ||
    env.GEMINI_CLI
  ) {
    return 'agy';
  }
  if (
    env.CLAUDECODE ||
    env.CLAUDE_CODE ||
    env.CLAUDE_CODE_SESSION_ID ||
    env.CLAUDE_SESSION_ID ||
    env.CLAUDE_CODE_ENTRYPOINT
  ) {
    return 'claude';
  }
  if (env.COPILOT_AGENT || env.COPILOT_CLI_SESSION_ID) {
    return 'copilot';
  }
  if (env.OPENCODE_PORT || env.OPENCODE_AGENT) {
    return 'opencode';
  }
  if (env.CODEX_THREAD_ID || env.CODEX_CLI || env.CODEX_APP_SERVER) {
    return 'codex';
  }
  return null;
}

/**
 * Detects the orchestrator model from environment variables, scoped to the detected orchestrator.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env=process.env]
 * @param {string|null} [options.orchestrator]
 * @returns {string|null} Detected model identifier, or null.
 */
export function detectOrchestratorModel(options = {}) {
  const env = options.env || process.env;
  const orchestrator = options.orchestrator !== undefined ? options.orchestrator : detectOrchestrator({ env });

  if (orchestrator === 'agy') {
    return env.ANTIGRAVITY_MODEL || env.GEMINI_MODEL || null;
  }
  if (orchestrator === 'claude') {
    return env.CLAUDE_MODEL || env.ANTHROPIC_MODEL || null;
  }
  if (orchestrator === 'copilot') {
    return env.COPILOT_MODEL || env.GITHUB_COPILOT_MODEL || null;
  }
  if (orchestrator === 'codex') {
    return env.CODEX_MODEL || null;
  }
  if (orchestrator === 'opencode') {
    return env.OPENCODE_MODEL || null;
  }
  return null;
}
