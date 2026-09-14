#!/usr/bin/env node
/**
 * @file validate-configs.mjs
 * @description Validates all dispatch-related configuration files in the repository/project.
 * Discovers and tests all found config files (skipping missing optional files).
 *
 * Usage:
 *   node scripts/validate-configs.mjs [--project-root <path>] [--quiet] [file1 file2 ...]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseJsonc,
  PROJECT_ROOT,
  isMainModule,
  getConfigCandidates,
  validateDispatchConfig,
} from '../skills/dispatch/scripts/common.mjs';
import { resolveOpencodeConfigSources } from '../skills/dispatch/scripts/opencode-run.mjs';
import {
  validateConfig as validateImplementDispatchSchema,
  getImplementDispatchConfigCandidates,
} from '../skills/implement-dispatch/scripts/resolve-flow.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Discovers candidate config files across dispatch skills for a given project root.
 * Returns only those files that actually exist on disk.
 *
 * @param {string} [projectRoot=PROJECT_ROOT]
 * @returns {Array<{ path: string, type: 'dispatch' | 'implement-dispatch' | 'opencode' | 'skill-hashes' | 'skills-lock' | 'jsonc' }>}
 */
export function findConfigFiles(projectRoot = PROJECT_ROOT) {
  const found = [];
  const seenPaths = new Set();

  function addIfFound(filePath, type) {
    if (!filePath) return;
    const resolved = path.resolve(filePath);
    // Keyed on the real path so a symlinked or case-variant alias of one file is validated once.
    let identity = resolved;
    try {
      identity = fs.realpathSync(resolved);
    } catch {}
    if (!seenPaths.has(identity) && fs.existsSync(resolved)) {
      try {
        if (fs.statSync(resolved).isFile()) {
          seenPaths.add(identity);
          found.push({ path: resolved, type });
        }
      } catch {}
    }
  }

  // 1. dispatch configs across standard skill locations
  const dispatchSkillRoots = [
    path.join(projectRoot, 'skills', 'dispatch'),
    path.join(projectRoot, '.agents', 'skills', 'dispatch'),
    path.join(projectRoot, '.claude', 'skills', 'dispatch'),
  ];
  for (const skillRoot of dispatchSkillRoots) {
    for (const candidate of getConfigCandidates({ skillRoot })) {
      addIfFound(candidate, 'dispatch');
    }
  }

  // 1b. implement-dispatch configs across standard skill locations
  const implementDispatchScriptDirs = [
    path.join(projectRoot, 'skills', 'implement-dispatch', 'scripts'),
    path.join(projectRoot, '.agents', 'skills', 'implement-dispatch', 'scripts'),
    path.join(projectRoot, '.claude', 'skills', 'implement-dispatch', 'scripts'),
  ];

  for (const scriptDir of implementDispatchScriptDirs) {
    for (const candidate of getImplementDispatchConfigCandidates(scriptDir)) {
      addIfFound(candidate, 'implement-dispatch');
    }
  }

  // 2. OpenCode configs
  const isDefaultProjectRoot = path.resolve(projectRoot) === path.resolve(PROJECT_ROOT);
  const opencodeCandidates = resolveOpencodeConfigSources({
    projectRoot,
    homeDir: path.join(projectRoot, '.placeholder-skip-home'),
    env: isDefaultProjectRoot ? process.env : { ...process.env, OPENCODE_CONFIG: undefined, OPENCODE_CONFIG_DIR: undefined },
  });

  for (const candidate of opencodeCandidates) {
    if (
      (isDefaultProjectRoot && candidate === process.env.OPENCODE_CONFIG) ||
      candidate.startsWith(projectRoot)
    ) {
      addIfFound(candidate, 'opencode');
    }
  }

  addIfFound(path.join(projectRoot, 'opencode.jsonc'), 'opencode');
  addIfFound(path.join(projectRoot, 'opencode.json'), 'opencode');
  addIfFound(path.join(projectRoot, '.opencode', 'opencode.jsonc'), 'opencode');
  addIfFound(path.join(projectRoot, '.opencode', 'opencode.json'), 'opencode');

  // 3. Skill hash manifests, for every skill that ships one (same order as HASHED_SKILLS in
  // scripts/generate-hashes.mjs)
  for (const skill of ['dispatch', 'dispatch-code-review', 'dispatch-plan-review', 'implement-dispatch']) {
    for (const base of ['skills', path.join('.agents', 'skills'), path.join('.claude', 'skills')]) {
      addIfFound(path.join(projectRoot, base, skill, 'skill-hashes.json'), 'skill-hashes');
    }
  }

  // 4. Skills lockfile
  addIfFound(path.join(projectRoot, 'skills-lock.json'), 'skills-lock');

  return found;
}

/**
 * Validates a single configuration file based on its type.
 *
 * @param {string} filePath
 * @param {'dispatch' | 'implement-dispatch' | 'opencode' | 'skill-hashes' | 'skills-lock' | 'jsonc'} type
 * @returns {{ valid: boolean, problems: string[] }}
 */
export function validateConfigFile(filePath, type = 'jsonc') {
  if (!fs.existsSync(filePath)) {
    return { valid: false, problems: [`File not found: ${filePath}`] };
  }

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { valid: false, problems: [`Failed to read file: ${err.message}`] };
  }

  let parsed;
  try {
    parsed = parseJsonc(content);
  } catch (err) {
    return { valid: false, problems: [`Syntax error: ${err.message}`] };
  }

  const problems = [];

  switch (type) {
    case 'dispatch': {
      const schemaProblems = validateDispatchConfig(parsed);
      problems.push(...schemaProblems);
      break;
    }
    case 'implement-dispatch': {
      const schemaProblems = validateImplementDispatchSchema(parsed);
      problems.push(...schemaProblems);
      break;
    }
    case 'opencode': {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        problems.push('OpenCode config must be a JSON object.');
      } else {
        if (parsed.model !== undefined && typeof parsed.model !== 'string') {
          problems.push('Field "model" must be a string.');
        }
        if (
          parsed.agent !== undefined &&
          (typeof parsed.agent !== 'object' || parsed.agent === null || Array.isArray(parsed.agent))
        ) {
          problems.push('Field "agent" must be an object.');
        }
        if (
          parsed.provider !== undefined &&
          (typeof parsed.provider !== 'object' || parsed.provider === null || Array.isArray(parsed.provider))
        ) {
          problems.push('Field "provider" must be an object.');
        }
      }
      break;
    }
    case 'skill-hashes': {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        problems.push(
          'Skill hashes manifest must be a JSON object mapping relative paths to SHA-256 hashes.'
        );
      } else {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
            problems.push(`Entry "${key}" must be a 64-character SHA-256 hex string.`);
          }
        }
      }
      break;
    }
    case 'skills-lock': {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        problems.push('Skills lock must be a JSON object.');
      } else if (parsed.version === undefined) {
        problems.push('Skills lock must include a "version" property.');
      }
      break;
    }
    default: {
      if (!parsed || typeof parsed !== 'object') {
        problems.push('Config must be a valid JSON object.');
      }
      break;
    }
  }

  return { valid: problems.length === 0, problems };
}

/**
 * Validates all found config files or explicitly passed file list.
 *
 * @param {object} [options]
 * @param {string} [options.projectRoot=PROJECT_ROOT]
 * @param {string[]} [options.files]
 * @returns {{ valid: boolean, results: Array<{ path: string, relativePath: string, type: string, valid: boolean, problems: string[] }> }}
 */
export function validateAllConfigs(options = {}) {
  const projectRoot = options.projectRoot || PROJECT_ROOT;
  let fileEntries;

  if (options.files && options.files.length > 0) {
    fileEntries = options.files.map(filePath => {
      const absPath = path.resolve(projectRoot, filePath);
      const normalized = filePath.replace(/\\/g, '/');
      let type = 'jsonc';
      if (normalized.includes('implement-dispatch')) {
        type = 'implement-dispatch';
      } else if (normalized.includes('dispatch/config')) {
        // Checked before the generic 'opencode' substring match below and after
        // 'implement-dispatch' above, since "skills/dispatch/config*.jsonc" would
        // otherwise fall through unclassified.
        type = 'dispatch';
      } else if (normalized.includes('opencode')) {
        type = 'opencode';
      } else if (normalized.includes('skill-hashes')) {
        type = 'skill-hashes';
      } else if (normalized.includes('skills-lock')) {
        type = 'skills-lock';
      }
      return { path: absPath, type };
    });
  } else {
    fileEntries = findConfigFiles(projectRoot);
  }

  const results = fileEntries.map(({ path: filePath, type }) => {
    const relativePath = path.relative(projectRoot, filePath).replace(/\\/g, '/');
    const { valid, problems } = validateConfigFile(filePath, type);
    return {
      path: filePath,
      relativePath,
      type,
      valid,
      problems,
    };
  });

  const valid = results.every(r => r.valid);
  return { valid, results };
}

/**
 * CLI execution entrypoint.
 *
 * @param {string[]} [argv=process.argv.slice(2)]
 * @returns {number} Exit code (0 for success, 1 for failure)
 */
export function runCli(argv = process.argv.slice(2)) {
  let projectRoot = PROJECT_ROOT;
  let quiet = false;
  const positionalFiles = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node validate-configs.mjs [--project-root <path>] [--quiet] [file1 file2 ...]\n' +
        'Validates all found dispatch-related config files.\n'
      );
      return 0;
    } else if (arg === '--quiet' || arg === '-q') {
      quiet = true;
    } else if (arg === '--project-root' || arg === '--root') {
      projectRoot = path.resolve(argv[++i]);
    } else if (arg.startsWith('--project-root=')) {
      projectRoot = path.resolve(arg.slice('--project-root='.length));
    } else if (arg.startsWith('--root=')) {
      projectRoot = path.resolve(arg.slice('--root='.length));
    } else if (!arg.startsWith('-')) {
      positionalFiles.push(arg);
    } else {
      process.stderr.write(`Unknown argument: ${arg}\n`);
      return 1;
    }
  }

  const { valid, results } = validateAllConfigs({
    projectRoot,
    files: positionalFiles.length > 0 ? positionalFiles : undefined,
  });

  if (results.length === 0) {
    if (!quiet) {
      process.stdout.write('No dispatch config files found to validate.\n');
    }
    return 0;
  }

  let totalProblems = 0;
  let invalidFilesCount = 0;

  for (const result of results) {
    if (result.valid) {
      if (!quiet) {
        process.stdout.write(`✓ ${result.relativePath} (${result.type})\n`);
      }
    } else {
      invalidFilesCount++;
      totalProblems += result.problems.length;
      process.stderr.write(`✗ ${result.relativePath} (${result.type}):\n`);
      for (const problem of result.problems) {
        process.stderr.write(`  - ${problem}\n`);
      }
    }
  }

  if (!valid) {
    process.stderr.write(
      `\nValidation failed: ${totalProblems} problem(s) found across ${invalidFilesCount} file(s).\n`
    );
    return 1;
  }

  if (!quiet) {
    process.stdout.write(`\nAll ${results.length} dispatch config file(s) are valid.\n`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  const code = runCli();
  process.exit(code);
}
