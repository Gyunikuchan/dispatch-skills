#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  InvalidReviewReportError,
  parseReportArgs,
  parseRebuttalReport,
  parseReviewReport,
  readReportInput,
} from '../../dispatch/scripts/review-report.mjs';
import {
  isMainModule,
  verifySkillIntegrity,
} from '../../dispatch/scripts/common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, '..');
const DISPATCH_DIR = path.resolve(__dirname, '../../dispatch');

export const PLAN_TAGS = new Set([
  'adjacent',
  'approach',
  'architecture',
  'auth',
  'blast-radius',
  'coherence',
  'compat',
  'compatibility',
  'correctness',
  'domain-logic',
  'edge-case',
  'intent',
  'invariant',
  'migration',
  'rollback',
  'scope',
  'scope-creep',
  'security',
  'simplicity',
  'spec-gap',
  'standards',
  'state-machine',
  'testability',
  'traceability',
  'user-gap',
  'validation',
  'verification',
  'yagni',
]);
export const PLAN_LOCUS_PATTERN = /^§\s+\S.*$/;

export function parseReport(text) {
  return parseReviewReport(text, {
    kind: 'plan',
    tags: PLAN_TAGS,
    locusPattern: PLAN_LOCUS_PATTERN,
    locusDescription: '"§ <Plan heading>"',
  });
}

export function parseRebuttal(text, expectedKeys) {
  return parseRebuttalReport(text, { kind: 'plan', expectedKeys });
}

export function assertParserIntegrity(skillDir = SKILL_DIR, dispatchDir = DISPATCH_DIR) {
  for (const [label, directory] of [['dispatch-plan-review', skillDir], ['dispatch', dispatchDir]]) {
    const integrity = verifySkillIntegrity(directory);
    if (!integrity.valid && !integrity.missing) {
      throw new Error(`${label} integrity failure: ${integrity.violations.join(', ')}`);
    }
  }
}

const USAGE = `Usage:
  node scripts/parse-report.mjs [--file <path|->] [--rebuttal-packet <path>]

Reads a schema-constrained delegate JSON report from stdin by default and writes normalized JSON.
`;

function main() {
  assertParserIntegrity();
  const args = parseReportArgs(process.argv.slice(2));
  if (args.help) return process.stdout.write(USAGE);
  const expectedKeys = args.rebuttalPacket
    ? JSON.parse(readReportInput(args.rebuttalPacket)).findings.map((finding) => finding.key)
    : null;
  const normalized = expectedKeys
    ? parseRebuttal(readReportInput(args.file), expectedKeys)
    : parseReport(readReportInput(args.file));
  process.stdout.write(`${JSON.stringify(normalized, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    if (err instanceof InvalidReviewReportError) {
      process.stderr.write(`${JSON.stringify({
        error: 'invalid-report',
        diagnostics: err.diagnostics,
      }, null, 2)}\n`);
      process.exit(1);
    }
    process.stderr.write(`[parse-report] ${err.message}\n`);
    process.exit(2);
  }
}
