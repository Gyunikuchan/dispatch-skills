#!/usr/bin/env node
/**
 * Builds the resolution-log `Sources:` line for one review round from a dispatch batch result, or
 * from --source entries for standalone runs that produce no batch result.
 *
 * Usage:
 *   node source-map.mjs --round <n> --batch <dispatch-json|-> [--extra <json-file>]
 *   node source-map.mjs --round <n> --kind <plan-review|code-review> [--source <provider>:<index>...] [--extra <json-file>]
 *
 * Exits 0 printing the line, 1 when the records are invalid, 2 on a usage or read error.
 */

import fs from 'node:fs';

import { isMainModule } from './common.mjs';
import { validateSourceMap } from './resolution-log.mjs';

const USAGE = `Usage:
  node source-map.mjs --round <n> --batch <dispatch-json|-> [--extra <json-file>]
  node source-map.mjs --round <n> --kind <plan-review|code-review> [--source <provider>:<index>...] [--extra <json-file>]

Prints the "- **Sources:** {...}" resolution-log line for round <n>, from a dispatch --batch-file
result (orchestrated) or, with --kind, from repeatable --source entries (standalone; one per
dispatched target, recorded as status "target" with null model/effort/session/substitutesFor).
--batch and --kind are exclusive. A standalone run with a model/effort override goes in --extra
alone, never also --source.
--extra is a JSON object mapping source keys (<plan-review|code-review>:R<n>:<provider>:
<candidate-index>) to complete records merged into the --batch or --source records:
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
  assertRound(round);
  if (!Array.isArray(batch?.targets)) throw new Error('batch result must contain a targets array.');
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
  return mergeExtra(map, extra, round, '--batch');
}

/**
 * @param {{ round: number, kind: 'plan-review'|'code-review', sources: Array<{provider: string, candidateIndex: number}>, extra?: Record<string, object> }} options
 * @returns {Record<string, object>} validated source map
 */
export function buildStandaloneSourceMap({ round, kind, sources, extra = {} }) {
  assertRound(round);
  if (!KINDS.includes(kind)) throw new UsageError(`kind must be one of ${KINDS.join(', ')}.`);
  if (sources.length === 0 && Object.keys(extra ?? {}).length === 0) {
    throw new UsageError('standalone mode needs at least one --source or --extra record.');
  }
  const map = {};
  for (const { provider, candidateIndex } of sources) {
    const key = `${kind}:R${round}:${provider}:${candidateIndex}`;
    if (Object.hasOwn(map, key)) throw new UsageError(`--source "${provider}:${candidateIndex}" is repeated.`);
    map[key] = { provider, candidateIndex, model: null, effort: null, status: 'target', session: null, substitutesFor: null };
  }
  return mergeExtra(map, extra, round, '--source');
}

const KINDS = ['plan-review', 'code-review', 'design-review'];
const SOURCE_PATTERN = /^([a-z][a-z0-9-]*):(0|[1-9][0-9]*)$/;

function assertRound(round) {
  if (!Number.isSafeInteger(round) || round < 1) throw new UsageError('round must be a positive integer.');
}

function mergeExtra(map, extra, round, origin) {
  if (!extra || Array.isArray(extra) || typeof extra !== 'object') {
    throw new Error('extra must be a JSON object mapping source keys to records.');
  }
  for (const [key, record] of Object.entries(extra)) {
    if (Object.hasOwn(map, key)) throw new Error(`extra source "${key}" duplicates a ${origin} record.`);
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
  const args = { round: null, batch: null, extra: null, kind: null, sources: [], help: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '-h' || flag === '--help') {
      args.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag === '--source' && value !== undefined) {
      const match = SOURCE_PATTERN.exec(value);
      if (!match) throw new UsageError(`--source "${value}" must be <provider>:<candidateIndex>.`);
      args.sources.push({ provider: match[1], candidateIndex: Number(match[2]) });
      index++;
      continue;
    }
    const name = { '--round': 'round', '--batch': 'batch', '--extra': 'extra', '--kind': 'kind' }[flag];
    if (!name || value === undefined || args[name] !== null) throw new UsageError(`unexpected argument "${flag}".`);
    args[name] = value;
    index++;
  }
  if (args.help) return args;
  if (args.round === null) throw new UsageError('--round is required.');
  // --kind marks standalone mode, which an --extra-only run of overridden sources also needs.
  const standalone = args.kind !== null;
  if (standalone === (args.batch !== null)) throw new UsageError('exactly one of --batch or --kind is required.');
  if (!standalone && args.sources.length > 0) throw new UsageError('--source requires --kind and excludes --batch.');
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
    const extra = args.extra ? readJson(args.extra, 'extra') : {};
    const map = args.batch !== null
      ? buildSourceMap(readJson(args.batch, 'batch'), { round, extra })
      : buildStandaloneSourceMap({ round, kind: args.kind, sources: args.sources, extra });
    process.stdout.write(`${formatSourceMapLine(map)}\n`);
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
