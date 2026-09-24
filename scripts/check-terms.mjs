#!/usr/bin/env node
/**
 * @file check-terms.mjs
 * @description Fails on the glossary's banned synonyms in shipped contracts and templates.
 *
 * Usage:
 *   node scripts/check-terms.mjs [--glossary <path>] [paths...]
 *
 * Reads the "Banned synonym" column of `skills/dispatch/references/glossary.md` (comma- or
 * slash-separated, blank cells skipped) and reports case-insensitive whole-word matches (plural
 * `s` allowed) outside fenced blocks and inline code spans. Default scan: `skills/<skill>/SKILL.md`
 * and `skills/<skill>/references/**\/*.md`, never the glossary itself.
 * Exit codes: 0 clean, 1 banned synonyms found (`<path>:<line>: <word> (use <term>)`), 2 usage or
 * glossary error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule } from '../skills/dispatch/scripts/lib/platform.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_GLOSSARY = path.join(REPO_ROOT, 'skills', 'dispatch', 'references', 'glossary.md');

const USAGE = `Usage: node scripts/check-terms.mjs [--glossary <path>] [paths...]

Reports banned glossary synonyms in shipped contracts and templates (default: every
skills/<skill>/SKILL.md and skills/<skill>/references/**/*.md except the glossary).
Exit 0 clean, 1 banned synonyms found, 2 usage or glossary error.
`;

/** Splits a markdown table row into trimmed cells (outer pipes dropped). */
function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

/**
 * Parses banned synonyms from every glossary table carrying a "Banned synonym" header column.
 *
 * @param {string} text glossary markdown
 * @returns {Array<{ word: string, term: string }>}
 */
export function parseBannedTerms(text) {
  const banned = [];
  let columns = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) {
      columns = null;
      continue;
    }
    const cells = tableCells(line);
    if (!columns) {
      const bannedIndex = cells.findIndex((cell) => /^banned synonyms?$/i.test(cell));
      columns = bannedIndex === -1 ? { banned: -1 } : { banned: bannedIndex, term: 0 };
      continue;
    }
    if (columns.banned === -1 || cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    const term = cells[columns.term].replace(/\*\*/g, '').trim();
    for (const word of (cells[columns.banned] ?? '').split(/[,/]/).map((w) => w.trim()).filter(Boolean)) {
      banned.push({ word, term });
    }
  }
  return banned;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds banned words in markdown prose, skipping fenced blocks and inline code spans.
 *
 * @param {string} text
 * @param {Array<{ word: string, term: string }>} banned
 * @returns {Array<{ line: number, word: string, term: string }>}
 */
export function findBannedTerms(text, banned) {
  const patterns = banned.map((entry) => ({
    ...entry,
    regex: new RegExp(`(?<![\\w-])${escapeRegExp(entry.word)}s?(?![\\w-])`, 'i'),
  }));
  const hits = [];
  let fence = null;
  text.split(/\r?\n/).forEach((line, index) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.character && marker[1].length >= fence.length) fence = null;
      return;
    }
    if (fence) return;
    const prose = line.replace(/(`+)[^`]*?\1/g, ' ');
    for (const { word, term, regex } of patterns) {
      if (regex.test(prose)) hits.push({ line: index + 1, word, term });
    }
  });
  return hits;
}

/** Default scan set: each skill's SKILL.md and references markdown. */
function defaultPaths() {
  const skillsDir = path.join(REPO_ROOT, 'skills');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) files.push(full);
    }
  };
  for (const skill of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!skill.isDirectory()) continue;
    const skillMd = path.join(skillsDir, skill.name, 'SKILL.md');
    if (fs.existsSync(skillMd)) files.push(skillMd);
    const references = path.join(skillsDir, skill.name, 'references');
    if (fs.existsSync(references)) walk(references);
  }
  return files;
}

/**
 * CLI entry point.
 * @param {string[]} argv arguments without the node/script prefix
 * @returns {number} exit code
 */
export function runCli(argv) {
  let glossary = DEFAULT_GLOSSARY;
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      return 0;
    }
    if (arg === '--glossary') {
      if (!argv[i + 1]) {
        process.stderr.write(`Error: --glossary requires a path\n${USAGE}`);
        return 2;
      }
      glossary = path.resolve(argv[++i]);
    } else if (arg.startsWith('--glossary=')) {
      glossary = path.resolve(arg.slice('--glossary='.length));
    } else if (arg.startsWith('-')) {
      process.stderr.write(`Error: unknown flag ${arg}\n${USAGE}`);
      return 2;
    } else {
      paths.push(path.resolve(arg));
    }
  }

  let banned;
  try {
    banned = parseBannedTerms(fs.readFileSync(glossary, 'utf8'));
  } catch (err) {
    process.stderr.write(`Error: cannot read glossary ${glossary}: ${err.message}\n`);
    return 2;
  }
  if (banned.length === 0) {
    process.stderr.write(`Error: no "Banned synonym" column entries found in ${glossary}\n`);
    return 2;
  }

  const glossaryIdentity = path.resolve(glossary).toLowerCase();
  const targets = (paths.length > 0 ? paths : defaultPaths())
    .filter((file) => path.resolve(file).toLowerCase() !== glossaryIdentity);
  let found = 0;
  for (const file of targets) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      process.stderr.write(`Error: cannot read ${file}: ${err.message}\n`);
      return 2;
    }
    const display = path.relative(process.cwd(), file).split(path.sep).join('/');
    for (const hit of findBannedTerms(text, banned)) {
      found++;
      process.stdout.write(`${display}:${hit.line}: ${hit.word} (use ${hit.term})\n`);
    }
  }
  return found > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(runCli(process.argv.slice(2)));
}
