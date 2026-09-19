#!/usr/bin/env node
/**
 * Consensus gate for a plan or walkthrough.
 *
 * Usage:
 *   node check-consensus.mjs [--json] <artifact path>
 *
 * Exits 0 (`Consensus: settled`) when `## Review Findings & Resolutions` holds no `[Disputed]` or
 * `[Rejected — pending confirmation]` line, or the section is absent; exits 1 listing each
 * unsettled line; exits 2 on a usage error, unreadable file, or a log the strict parser rejects.
 */

import fs from 'node:fs';

import { isMainModule } from './common.mjs';
import {
  findUnsettledResolutionLines,
  scanResolutionLog,
} from './resolution-log.mjs';

const USAGE = `Usage:
  node check-consensus.mjs [--json] <artifact path>
`;

/**
 * Returns the unsettled resolution lines of an artifact.
 *
 * @param {string} markdown
 * @returns {string[]}
 */
export function findUnsettled(markdown) {
  return findUnsettledResolutionLines(markdown);
}

/**
 * Runs the gate's strict scan; preparation's checkpoint-preview shares it so both agree.
 *
 * @param {string} markdown
 * @returns {{ exit: 0|1|2, unsettled: string[], unsettledItems: object[], error?: string }}
 */
export function evaluateConsensus(markdown) {
  let scan;
  try {
    // NOTE: strict so the gate never settles a log that preparation rejects.
    scan = scanResolutionLog(markdown, { strict: true });
  } catch (err) {
    return { exit: 2, unsettled: [], unsettledItems: [], error: err.message };
  }
  return {
    exit: scan.unsettled.length === 0 ? 0 : 1,
    unsettled: scan.unsettled,
    unsettledItems: scan.unsettledItems,
  };
}

function main(args) {
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const json = args.includes('--json');
  const paths = args.filter((arg) => arg !== '--json');
  if (paths.length !== 1 || args.filter((arg) => arg === '--json').length > 1) {
    process.stderr.write(`Error: expected exactly one artifact path\n${USAGE}`);
    return 2;
  }
  let markdown;
  try {
    markdown = fs.readFileSync(paths[0], 'utf8');
  } catch (err) {
    process.stderr.write(`Error: cannot read ${paths[0]}: ${err.message}\n`);
    return 2;
  }
  const result = evaluateConsensus(markdown);
  if (result.exit === 2) {
    process.stderr.write(`Error: invalid resolution log: ${result.error}\n`);
    return 2;
  }
  const unsettled = json ? result.unsettledItems : result.unsettled;
  if (json) {
    process.stdout.write(`${JSON.stringify({
      settled: unsettled.length === 0,
      unsettled,
    }, null, 2)}\n`);
    return unsettled.length === 0 ? 0 : 1;
  }
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
