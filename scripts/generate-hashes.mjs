#!/usr/bin/env node

/**
 * Generates skill-hashes.json for the dispatch skill.
 * Run after modifying any skill file to update the integrity manifest.
 *
 * Usage: node scripts/generate-hashes.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSkillHashes } from '../skills/dispatch/scripts/common.mjs';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(currentDir, '..', 'skills', 'dispatch');
const manifest = generateSkillHashes(skillDir);
const manifestPath = path.join(skillDir, 'skill-hashes.json');

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`Generated ${manifestPath} with ${Object.keys(manifest).length} entries.`);
