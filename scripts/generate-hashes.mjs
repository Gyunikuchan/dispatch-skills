#!/usr/bin/env node

/**
 * Generates skill-hashes.json for every skill that ships one — `dispatch` and the two review
 * skills — covering SKILL.md, scripts/*.mjs, and references/*.md. Config files (config*.jsonc)
 * are excluded — user-edited/dynamic by design. The review skills' manifests cover their prompt
 * and walkthrough templates, which `fill-template.mjs` checks before filling.
 * Run after modifying any skill file to update the integrity manifests.
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
import { generateSkillHashes } from '../skills/dispatch/scripts/common.mjs';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const skillsRoot = path.resolve(currentDir, '..', 'skills');

// Skills carrying an integrity manifest. Keep in sync with `.husky/pre-commit`'s path pattern.
const HASHED_SKILLS = ['dispatch', 'dispatch-code-review', 'dispatch-plan-review'];

const argv = process.argv.slice(2);
let check = false;
let outPath = null;
let skillName = null;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--check') {
    check = true;
  } else if (arg === '--out' || arg === '--skill') {
    const value = argv[++i];
    if (!value || value.startsWith('--')) {
      console.error(`${arg} requires a value`);
      process.exit(2);
    }
    const seen = arg === '--out' ? outPath : skillName;
    if (seen) {
      console.error(`${arg} may be given only once`);
      process.exit(2);
    }
    if (arg === '--out') outPath = path.resolve(value);
    else skillName = value;
  } else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
}

// `--out` writes one file, so it pins the run to a single skill; `dispatch` is the default. It
// must never reach --check: that would silently narrow the drift check to one skill and report
// clean while another skill's committed manifest is stale.
if (check && outPath) {
  console.error('--out cannot combine with --check');
  process.exit(2);
}
const targets = outPath || skillName ? [skillName ?? 'dispatch'] : HASHED_SKILLS;
for (const name of targets) {
  if (!HASHED_SKILLS.includes(name)) {
    console.error(`Unknown skill "${name}"; hashed skills: ${HASHED_SKILLS.join(', ')}`);
    process.exit(2);
  }
}

// SECTION: drift check (read-only)
if (check) {
  const drifted = [];
  for (const name of targets) {
    const manifest = generateSkillHashes(path.join(skillsRoot, name));
    let committed = {};
    try {
      committed = JSON.parse(fs.readFileSync(path.join(skillsRoot, name, 'skill-hashes.json'), 'utf8'));
    } catch {
      // Missing/corrupt manifest: every generated key counts as drifted.
    }
    const keys = new Set([...Object.keys(manifest), ...Object.keys(committed)]);
    for (const key of keys) {
      if (manifest[key] !== committed[key]) drifted.push(`${name}/${key}`);
    }
  }
  if (drifted.length > 0) {
    console.error(`skill-hashes.json is stale; run \`npm run hashes\`. Drifted: ${drifted.sort().join(', ')}`);
    process.exit(1);
  }
  console.log(`skill-hashes.json is up to date (${targets.join(', ')}).`);
  process.exit(0);
}

// SECTION: write
for (const name of targets) {
  const manifest = generateSkillHashes(path.join(skillsRoot, name));
  const target = outPath ?? path.join(skillsRoot, name, 'skill-hashes.json');
  fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`Generated ${target} with ${Object.keys(manifest).length} entries.`);
}
