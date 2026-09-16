#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isMainModule,
  verifySkillIntegrity,
} from '../../dispatch/scripts/common.mjs';
import { scanResolutionLog } from '../../dispatch/scripts/resolution-log.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function summaryLine(round) {
  const { accepted, rejected, resolvedDispute, disputed, pendingConfirmation, unknown } = round.counts;
  return `- R${round.number} settled accepted=${accepted} rejected=${rejected} resolved=${resolvedDispute} disputed=${disputed + pendingConfirmation} unknown=${unknown} hash=${round.hash.slice(0, 12)}`;
}

export function buildReviewView(markdown, { canonicalPath, nextRound }) {
  if (!Number.isSafeInteger(nextRound) || nextRound < 1) throw new Error('nextRound must be a positive integer.');
  const scan = scanResolutionLog(markdown, { strict: true });
  const expectedRound = (scan.rounds.at(-1)?.number ?? 0) + 1;
  if (nextRound !== expectedRound) {
    throw new Error(`nextRound ${nextRound} does not follow canonical round ${expectedRound - 1}.`);
  }
  const previous = scan.rounds.at(-1) ?? null;
  const older = previous ? scan.rounds.slice(0, -1) : [];
  const summaries = older.filter((round) =>
    round.counts.disputed === 0 && round.counts.pendingConfirmation === 0);
  const live = older.flatMap((round) =>
    round.entries
      .filter((entry) => entry.status === 'disputed' || entry.status === 'pendingConfirmation')
      .map((entry) => `- R${round.number}: ${entry.line.replace(/^\s*[-*]\s+/, '')}`));
  const parts = [
    '> Bounded read-only review projection.',
    `> Canonical artifact: ${canonicalPath}`,
    '> Apply adjudication and edits only to the canonical artifact.',
    '',
    scan.semanticBody,
    '',
    '## Review Findings & Resolutions (bounded view)',
  ];
  if (summaries.length) parts.push('', '### Older settled rounds', '', ...summaries.map(summaryLine));
  if (live.length) parts.push('', '### Live findings from older rounds', '', ...live);
  if (previous) parts.push('', '### Immediately preceding round', '', previous.text);
  return {
    contents: `${parts.join('\n').trim()}\n`,
    sourceRoundCount: scan.rounds.length,
    canonicalLogHash: scan.canonicalLogHash,
  };
}

export function writeReviewView({ artifact, nextRound, outputPath = null }) {
  const markdown = fs.readFileSync(artifact, 'utf8');
  const built = buildReviewView(markdown, { canonicalPath: artifact, nextRound });
  let viewPath = outputPath;
  if (!viewPath) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-review-view-'));
    viewPath = path.join(dir, `${path.basename(artifact, path.extname(artifact))}-review-view.md`);
  }
  fs.mkdirSync(path.dirname(viewPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(viewPath, built.contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return {
    canonicalPath: artifact,
    viewPath,
    sourceRoundCount: built.sourceRoundCount,
    canonicalLogHash: built.canonicalLogHash,
  };
}

function parseArgs(argv) {
  const out = { artifact: null, nextRound: null, outputPath: null, tempOut: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--artifact') out.artifact = argv[++i] ?? null;
    else if (arg === '--next-round') out.nextRound = Number(argv[++i]);
    else if (arg === '--out') out.outputPath = path.resolve(argv[++i] ?? '');
    else if (arg === '--temp-out') out.tempOut = true;
    else if (arg === '-h' || arg === '--help') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (out.outputPath && out.tempOut) throw new Error('--out and --temp-out are mutually exclusive.');
  return out;
}

const USAGE = `Usage:
  node build-review-view.mjs --artifact <canonical-path> --next-round <n> (--out <path>|--temp-out)
`;

function main() {
  const own = verifySkillIntegrity(path.resolve(__dirname, '..'));
  const dispatch = verifySkillIntegrity(path.resolve(__dirname, '../../dispatch'));
  for (const [label, integrity] of [['implement-dispatch', own], ['dispatch', dispatch]]) {
    if (!integrity.valid && !integrity.missing) throw new Error(`${label} integrity failure: ${integrity.violations.join(', ')}`);
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return process.stdout.write(USAGE);
  if (!args.artifact || !args.nextRound || (!args.outputPath && !args.tempOut)) {
    throw new Error(`Missing required arguments.\n${USAGE}`);
  }
  process.stdout.write(`${JSON.stringify(writeReviewView({
    artifact: args.artifact,
    nextRound: args.nextRound,
    outputPath: args.outputPath,
  }), null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[build-review-view] ${err.message}\n`);
    process.exit(1);
  }
}
