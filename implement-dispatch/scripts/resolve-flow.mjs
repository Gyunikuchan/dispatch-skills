#!/usr/bin/env node
/**
 * Resolves the implement-dispatch execution flow plan.
 *
 * Usage:
 *   node resolve-flow.mjs --platform <key> [--level <low|medium|high|max>] [--pins <key,key,...>]
 *
 * Outputs JSON to stdout describing plan-review, implementation, and code-review targets.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DISPATCH_SCRIPTS = path.resolve(__dirname, '../../dispatch/scripts');

const LEVELS = ['low', 'medium', 'high', 'max'];

// Per-level config table
//   planTargets: 'none' | 'one' | 'all'
//   planRounds: number
//   codeTargets: 'one' | 'all'
//   codeRounds: number
//   consensus: boolean
const LEVEL_CONFIG = {
  low:    { planTargets: 'none', planRounds: 0, codeTargets: 'one', codeRounds: 1, consensus: false, includeSelf: false },
  medium: { planTargets: 'one',  planRounds: 1, codeTargets: 'one', codeRounds: 3, consensus: false, includeSelf: false },
  high:   { planTargets: 'one',  planRounds: 1, codeTargets: 'all', codeRounds: 3, consensus: true,  includeSelf: false },
  max:    { planTargets: 'all',  planRounds: 3, codeTargets: 'all', codeRounds: 5, consensus: true,  includeSelf: true  },
};

// --- JSONC parsing ---

function stripJsonComments(text) {
  // Remove single-line comments (// ...) and block comments (/* ... */)
  // Handles strings correctly by tracking quote state.
  let result = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      // String literal — copy until closing unescaped quote
      result += text[i++];
      while (i < text.length) {
        if (text[i] === '\\') {
          result += text[i++];
          if (i < text.length) result += text[i++];
        } else if (text[i] === '"') {
          result += text[i++];
          break;
        } else {
          result += text[i++];
        }
      }
    } else if (text[i] === '/' && text[i + 1] === '/') {
      // Line comment
      while (i < text.length && text[i] !== '\n') i++;
    } else if (text[i] === '/' && text[i + 1] === '*') {
      // Block comment
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      if (i >= text.length) throw new SyntaxError('Unterminated block comment in JSONC');
      i += 2;
    } else {
      result += text[i++];
    }
  }
  // Remove trailing commas before } or ]
  return result.replace(/,(\s*[}\]])/g, '$1');
}

function parseJsonc(text) {
  return JSON.parse(stripJsonComments(text));
}

// --- Config loading ---

export function loadConfig(scriptDir = __dirname) {
  const root = path.resolve(scriptDir, '..');
  const localPath = path.join(root, 'config.jsonc');
  const defaultPath = path.join(root, 'config.default.jsonc');
  const configPath = existsSync(localPath) ? localPath : defaultPath;
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: tried ${localPath} and ${defaultPath}`);
  }
  return parseJsonc(readFileSync(configPath, 'utf8'));
}

// --- Liveness ---

export async function defaultLiveness() {
  const results = {};
  const runners = {
    claude: 'claude-run.mjs',
    agy: 'agy-run.mjs',
    copilot: 'copilot-run.mjs',
    local: 'local-run.mjs',
  };
  await Promise.all(
    Object.entries(runners).map(async ([key, file]) => {
      try {
        const mod = await import(path.join(DISPATCH_SCRIPTS, file));
        const fnName = `is${key.charAt(0).toUpperCase()}${key.slice(1)}Available`;
        results[key] = !!(await mod[fnName]?.());
      } catch {
        results[key] = false;
      }
    })
  );
  return results;
}

// --- Core resolution ---

/**
 * Resolves the flow plan.
 *
 * @param {{ platform: string, level?: string, pins?: string[] }} options
 * @param {Record<string, boolean>} liveness  - map of platform key → available
 * @param {object} config                     - parsed config object
 * @returns {object} flow plan JSON
 */
export function resolveFlow(options, liveness, config) {
  const { platform, level = 'medium', pins } = options;

  if (!LEVELS.includes(level)) {
    throw new Error(`Unknown level "${level}". Valid levels: ${LEVELS.join(', ')}`);
  }

  const levelCfg = LEVEL_CONFIG[level];

  // Validate pins against known config keys
  if (pins && pins.length > 0) {
    const allKeys = new Set([
      ...Object.keys(config['plan-review'] ?? {}),
      ...Object.keys(config['code-review'] ?? {}),
    ]);
    const unknown = pins.filter(p => !allKeys.has(p));
    if (unknown.length > 0) {
      throw new Error(
        `Unrecognized pin key(s): ${unknown.join(', ')}. Valid keys: ${[...allKeys].sort().join(', ')}`
      );
    }
  }

  // Build a filtered+live candidate list for a given section config
  function getCandidates(sectionConfig, forReview, includeSelf = false) {
    // Start from config order; if pinned, filter to pins (in pin order)
    let keys = Object.keys(sectionConfig ?? {});
    if (pins && pins.length > 0) {
      keys = pins.filter(p => keys.includes(p));
    }

    // Liveness filter — require explicit true; undefined (unknown platform) is treated as unavailable
    keys = keys.filter(k => liveness[k] === true);

    // For review sections: error when all pinned platforms are unavailable (pins present in this section's config)
    // Note: pins absent from this section's config silently produce no targets — this is by design (best-effort per section)
    if (forReview && pins && pins.length > 0) {
      const validPins = pins.filter(p => Object.keys(sectionConfig ?? {}).includes(p));
      const livePins = validPins.filter(p => liveness[p] === true);
      if (validPins.length > 0 && livePins.length === 0) {
        throw new Error(
          `All pinned platforms unavailable: ${validPins.join(', ')}`
        );
      }
    }

    // Exclude orchestrator from reviews unless explicitly pinned or includeSelf is set (max level)
    if (forReview) {
      const orchestratorPinned = pins && pins.includes(platform);
      if (!orchestratorPinned && !includeSelf) {
        keys = keys.filter(k => k !== platform);
      }
    }

    return keys;
  }

  function buildTarget(sectionConfig, key) {
    const entry = sectionConfig[key] ?? {};
    const target = { platform: key };
    if (entry.model !== undefined) target.model = entry.model;
    if (entry.effort !== undefined) target.effort = entry.effort;
    // Flag same-agent reviews (orchestrator pinned)
    if (key === platform) target.allowSameAgent = true;
    return target;
  }

  function buildReviewSection(sectionConfig, targetCount, rounds, consensus, includeSelf = false) {
    // Skip candidate resolution (including the all-unavailable error) when the phase is skipped
    const targets = (targetCount === 'none' || targetCount === 0)
      ? []
      : (() => {
          const keys = getCandidates(sectionConfig, true, includeSelf);
          return targetCount === 'one'
            ? (keys.length > 0 ? [buildTarget(sectionConfig, keys[0])] : [])
            : keys.map(k => buildTarget(sectionConfig, k));
        })();

    const section = { targets, rounds: rounds === undefined ? undefined : rounds, consensus };
    // Omit rounds when undefined (high/max code-review)
    if (section.rounds === undefined) delete section.rounds;
    return section;
  }

  // plan-review
  const planReview = buildReviewSection(
    config['plan-review'] ?? {},
    levelCfg.planTargets,
    levelCfg.planRounds,
    levelCfg.consensus,
    levelCfg.includeSelf
  );

  // implementation
  const implEntry = (config.implementation ?? {})[platform] ?? {};
  const implementation = { platform };
  if (implEntry.model !== undefined) implementation.model = implEntry.model;
  if (implEntry.effort !== undefined) implementation.effort = implEntry.effort;

  // code-review
  const codeReview = buildReviewSection(
    config['code-review'] ?? {},
    levelCfg.codeTargets,
    levelCfg.codeRounds,
    levelCfg.consensus,
    levelCfg.includeSelf
  );

  return { 'plan-review': planReview, implementation, 'code-review': codeReview };
}

// --- CLI entry point ---

async function main() {
  const args = process.argv.slice(2);
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--platform': opts.platform = args[++i]; break;
      case '--level':    opts.level = args[++i]; break;
      case '--pins':     opts.pins = args[++i].split(',').map(s => s.trim()).filter(Boolean); break;
    }
  }

  if (!opts.platform) {
    process.stderr.write('Error: --platform is required\n');
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`Error loading config: ${err.message}\n`);
    process.exit(1);
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
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    process.stderr.write(`Unexpected error: ${err.message}\n`);
    process.exit(1);
  });
}
