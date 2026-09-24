#!/usr/bin/env node
// @ts-check

/**
 * Generates skill-hashes.json for `dispatch`, the only skill that ships one — covering SKILL.md,
 * scripts/*.mjs, and every .md/.json under references/ (nested templates included). Config files
 * (config*.jsonc) are excluded — user-edited/dynamic by design. `review/fill-template.mjs` checks the
 * review templates under references/templates/ against it before filling.
 * Run after modifying any skill file to update the integrity manifest.
 *
 * Usage: node scripts/generate-hashes.mjs [--check] [--skill <name>] [--out <path>]
 *   --check        compare against the committed manifests; print drifted keys and exit 1 on drift
 *                  (no write; cannot combine with --out, which would narrow what gets checked)
 *   --skill <name> restrict to one hashed skill (default: all of them)
 *   --out <path>   write a single skill's manifest to <path> instead of <skill>/skill-hashes.json
 *                  (implies one skill; defaults to `dispatch` when `--skill` is omitted)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSkillHashes } from '../skills/dispatch/scripts/lib/integrity.mjs';
import { isMainModule } from '../skills/dispatch/scripts/lib/platform.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(SCRIPT_DIR, '..', 'skills');
const HASHED_SKILLS = ['dispatch'];
const DEFAULT_SKILL = 'dispatch';
const MANIFEST_NAME = 'skill-hashes.json';

// SECTION: Arguments

/** @typedef {{ check: boolean, outPath: string | null, skillName: string | null }} CliOptions */

/**
 * Parses CLI arguments without terminating the process.
 *
 * @param {string[]} argv arguments without the node/script prefix
 * @returns {{ options?: CliOptions, error?: string }}
 */
function parseArgs(argv) {
  /** @type {CliOptions} */
  const options = { check: false, outPath: null, skillName: null };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--check') {
      options.check = true;
      continue;
    }
    if (arg !== '--out' && arg !== '--skill') return { error: `Unknown argument: ${arg}` };

    const value = argv[++index];
    if (!value || value.startsWith('--')) return { error: `${arg} requires a value` };
    const key = arg === '--out' ? 'outPath' : 'skillName';
    if (options[key]) return { error: `${arg} may be given only once` };
    options[key] = arg === '--out' ? path.resolve(value) : value;
  }

  if (options.check && options.outPath) {
    // `--out` narrows the run and could otherwise hide drift in another manifest.
    return { error: '--out cannot combine with --check' };
  }
  return { options };
}

/** @param {CliOptions} options */
function resolveTargets(options) {
  const targets = options.outPath || options.skillName
    ? [options.skillName ?? DEFAULT_SKILL]
    : HASHED_SKILLS;
  const unknown = targets.find((name) => !HASHED_SKILLS.includes(name));
  return unknown
    ? { error: `Unknown skill "${unknown}"; hashed skills: ${HASHED_SKILLS.join(', ')}` }
    : { targets };
}

// SECTION: Manifest operations

/** @param {string[]} targets */
function findDrift(targets) {
  const drifted = [];
  for (const name of targets) {
    const generated = generateSkillHashes(path.join(SKILLS_ROOT, name));
    /** @type {Record<string, string>} */
    let committed = {};
    try {
      committed = JSON.parse(fs.readFileSync(path.join(SKILLS_ROOT, name, MANIFEST_NAME), 'utf8'));
    } catch {
      // An unreadable manifest differs from every generated entry.
    }
    const keys = new Set([...Object.keys(generated), ...Object.keys(committed)]);
    for (const key of keys) {
      if (generated[key] !== committed[key]) drifted.push(`${name}/${key}`);
    }
  }
  return drifted.sort();
}

/** @param {string[]} targets @param {string | null} outPath */
function writeManifests(targets, outPath) {
  for (const name of targets) {
    const manifest = generateSkillHashes(path.join(SKILLS_ROOT, name));
    const target = outPath ?? path.join(SKILLS_ROOT, name, MANIFEST_NAME);
    fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`Generated ${target} with ${Object.keys(manifest).length} entries.`);
  }
}

// SECTION: Main flow

/**
 * @param {string[]} [argv=process.argv.slice(2)]
 * @returns {number} process exit code
 */
export function runCli(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (!parsed.options) {
    console.error(parsed.error);
    return 2;
  }

  const resolved = resolveTargets(parsed.options);
  if (!resolved.targets) {
    console.error(resolved.error);
    return 2;
  }

  if (parsed.options.check) {
    const drifted = findDrift(resolved.targets);
    if (drifted.length > 0) {
      console.error(`skill-hashes.json is stale; run \`npm run hashes\`. Drifted: ${drifted.join(', ')}`);
      return 1;
    }
    console.log(`skill-hashes.json is up to date (${resolved.targets.join(', ')}).`);
    return 0;
  }

  writeManifests(resolved.targets, parsed.options.outPath);
  return 0;
}

if (isMainModule(import.meta.url)) process.exit(runCli());
