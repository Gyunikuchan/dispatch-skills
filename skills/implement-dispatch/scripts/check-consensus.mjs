#!/usr/bin/env node
/**
 * Consensus gate for a plan or walkthrough.
 *
 * Usage:
 *   node check-consensus.mjs <artifact path>
 *
 * Exits 0 (`Consensus: settled`) when `## Review Findings & Resolutions` holds no `[Disputed]` or
 * `[Rejected — pending confirmation]` line, or the section is absent; exits 1 listing each
 * unsettled line; exits 2 on a usage error or unreadable file.
 */

import fs from 'node:fs';

import { isMainModule } from '../../dispatch/scripts/common.mjs';

const USAGE = `Usage:
  node check-consensus.mjs <artifact path>
`;

const SECTION_HEADING = /^##\s+Review Findings & Resolutions\b/i;
// Dash variants are accepted because editors and delegates silently swap em-dash, en-dash and hyphen.
const UNSETTLED_LINE = /^\s*[-*]\s+\*\*\[(Disputed|Rejected\s*[—–-]+\s*pending confirmation)\]\*\*/i;
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;

/**
 * Returns the unsettled resolution lines of an artifact.
 *
 * @param {string} markdown
 * @returns {string[]}
 */
export function findUnsettled(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const { indices, unterminated } = scan(lines, true);
  // A stray unclosed fence would hide the real section; this is a safety gate, so fail closed.
  // Merged by line index so identical bullets still count once each.
  if (unterminated) for (const i of scan(lines, false).indices) indices.add(i);
  return [...indices].sort((a, b) => a - b).map((i) => lines[i].trim());
}

/**
 * One pass over the lines. With `honorFences`, fenced blocks (templates and examples, whose headings
 * and bullets are not real log lines) are skipped; a fence closes only on the same marker character
 * at least as long as its opener, per CommonMark.
 */
function scan(lines, honorFences) {
  const indices = new Set();
  let fence = null;
  let inSection = false;
  for (const [i, line] of lines.entries()) {
    const match = honorFences ? FENCE.exec(line) : null;
    if (match) {
      const [, marker, rest] = match;
      if (!fence) {
        // CommonMark: a backtick fence's info string may not contain a backtick, else it is inline code.
        if (!(marker[0] === '`' && rest.includes('`'))) {
          fence = marker;
          continue;
        }
      } else if (marker[0] === fence[0] && marker.length >= fence.length && !rest.trim()) {
        fence = null;
        continue;
      }
    }
    if (fence) continue;
    // Every findings section is checked: a duplicated or quoted section must not hide the real one.
    if (/^##\s/.test(line)) {
      inSection = SECTION_HEADING.test(line);
      continue;
    }
    if (inSection && UNSETTLED_LINE.test(line)) indices.add(i);
  }
  return { indices, unterminated: fence !== null };
}

function main(args) {
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.length !== 1) {
    process.stderr.write(`Error: expected exactly one artifact path\n${USAGE}`);
    return 2;
  }
  let markdown;
  try {
    markdown = fs.readFileSync(args[0], 'utf8');
  } catch (err) {
    process.stderr.write(`Error: cannot read ${args[0]}: ${err.message}\n`);
    return 2;
  }
  const unsettled = findUnsettled(markdown);
  if (unsettled.length === 0) {
    process.stdout.write('Consensus: settled\n');
    return 0;
  }
  process.stdout.write(`Consensus: ${unsettled.length} unsettled line(s)\n${unsettled.join('\n')}\n`);
  return 1;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
