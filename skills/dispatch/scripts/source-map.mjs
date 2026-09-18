#!/usr/bin/env node
/**
 * Builds the resolution-log `Sources:` line for one review round from a dispatch batch result.
 *
 * Usage:
 *   node source-map.mjs --round <n> --batch <dispatch-json|-> [--extra <json-file>]
 *
 * Exits 0 printing the line, 1 when the records are invalid, 2 on a usage or read error.
 */

import fs from 'node:fs';

import { isMainModule } from './common.mjs';
import { validateSourceMap } from './resolution-log.mjs';

const USAGE = `Usage:
  node source-map.mjs --round <n> --batch <dispatch-json|-> [--extra <json-file>]

Reads a dispatch --batch-file result and prints the "- **Sources:** {...}" resolution-log line for
round <n>. --extra is a JSON object mapping source keys (<plan-review|code-review>:R<n>:<provider>:
<candidate-index>) to complete records merged into the batch records:
  {"provider": "<provider>", "candidateIndex": <n>, "model": <string|null>, "effort": <string|null>,
   "status": "fallback"|"replacement"|"target"|"reserve", "session": <string|null>,
   "substitutesFor": <same-round source key|null>}
Exit 0 printed, 1 invalid records, 2 usage or read error.
`;

class UsageError extends Error {}

/**
 * @param {{ targets?: object[] }} batch dispatch batch result; only terminal successes are sources.
 * @param {{ round: number, extra?: Record<string, object> }} options
 * @returns {Record<string, object>} validated source map
 */
export function buildSourceMap(batch, { round, extra = {} }) {
  if (!Number.isSafeInteger(round) || round < 1) throw new UsageError('round must be a positive integer.');
  if (!Array.isArray(batch?.targets)) throw new Error('batch result must contain a targets array.');
  if (!extra || Array.isArray(extra) || typeof extra !== 'object') {
    throw new Error('extra must be a JSON object mapping source keys to records.');
  }
  const map = {};
  for (const record of batch.targets) {
    if (Object.hasOwn(map, record.sourceKey)) throw new Error(`batch source "${record.sourceKey}" is duplicated.`);
    map[record.sourceKey] = {
      provider: record.platform,
      candidateIndex: record.candidateIndex,
      model: record.model ?? null,
      effort: record.effort ?? null,
      status: record.role ?? (record.substitutesFor ? 'reserve' : 'target'),
      session: record.session ?? null,
      substitutesFor: record.substitutesFor ?? null,
    };
  }
  for (const [key, record] of Object.entries(extra)) {
    if (Object.hasOwn(map, key)) throw new Error(`extra source "${key}" duplicates a batch source.`);
    map[key] = record;
  }
  return validateSourceMap(map, round);
}

export function formatSourceMapLine(map) {
  return `- **Sources:** ${JSON.stringify(map)}`;
}

function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file === '-' ? 0 : file, 'utf8');
  } catch (err) {
    throw new UsageError(`cannot read ${label} ${file}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UsageError(`${label} is not valid JSON: ${err.message}`);
  }
}

function parseArgs(argv) {
  const args = { round: null, batch: null, extra: null, help: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '-h' || flag === '--help') {
      args.help = true;
      continue;
    }
    const name = { '--round': 'round', '--batch': 'batch', '--extra': 'extra' }[flag];
    const value = argv[index + 1];
    if (!name || value === undefined || args[name] !== null) throw new UsageError(`unexpected argument "${flag}".`);
    args[name] = value;
    index++;
  }
  if (!args.help && (args.round === null || args.batch === null)) throw new UsageError('--round and --batch are required.');
  return args;
}

function main(argv) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    const round = /^[1-9]\d*$/.test(args.round) ? Number(args.round) : NaN;
    const batch = readJson(args.batch, 'batch');
    const extra = args.extra ? readJson(args.extra, 'extra') : {};
    process.stdout.write(`${formatSourceMapLine(buildSourceMap(batch, { round, extra }))}\n`);
    return 0;
  } catch (err) {
    const usage = err instanceof UsageError;
    process.stderr.write(`Error: ${err.message}\n${usage ? USAGE : ''}`);
    return usage ? 2 : 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
