#!/usr/bin/env node

/**
 * Generates skill-hashes.json for the dispatch skill: SKILL.md, scripts/*.mjs, and
 * references/*.md. Config files (config*.jsonc) are excluded — user-edited/dynamic by design.
 * Run after modifying any skill file to update the integrity manifest.
 *
 * Usage: node scripts/generate-hashes.mjs [--check] [--out <path>]
 *   --check       compare against the committed manifest; print drifted keys and exit 1 on drift (no write)
 *   --out <path>  write the manifest to <path> instead of skills/dispatch/skill-hashes.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSkillHashes } from '../skills/dispatch/scripts/common.mjs';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(currentDir, '..', 'skills', 'dispatch');
const manifestPath = path.join(skillDir, 'skill-hashes.json');

const argv = process.argv.slice(2);
let check = false;
let outPath = manifestPath;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--check') {
    check = true;
  } else if (arg === '--out') {
    const value = argv[++i];
    if (!value || value.startsWith('--')) {
      console.error('--out requires a value');
      process.exit(2);
    }
    outPath = path.resolve(value);
  } else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
}

const manifest = generateSkillHashes(skillDir);

// SECTION: drift check (read-only)
if (check) {
  let committed = {};
  try {
    committed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    // Missing/corrupt manifest: every generated key counts as drifted.
  }
  const keys = new Set([...Object.keys(manifest), ...Object.keys(committed)]);
  const drifted = [...keys].filter((key) => manifest[key] !== committed[key]).sort();
  if (drifted.length > 0) {
    console.error(`skill-hashes.json is stale; run \`npm run hashes\`. Drifted: ${drifted.join(', ')}`);
    process.exit(1);
  }
  console.log(`skill-hashes.json is up to date (${Object.keys(manifest).length} entries).`);
  process.exit(0);
}

// SECTION: write
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`Generated ${outPath} with ${Object.keys(manifest).length} entries.`);
