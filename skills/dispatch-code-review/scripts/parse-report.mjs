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

export const CODE_TAGS = new Set([
  'a11y',
  'adjacent',
  'auth',
  'breaking',
  'compatibility',
  'correctness',
  'coupling',
  'domain-logic',
  'edge-case',
  'intent',
  'invariant',
  'migration',
  'partial-failure',
  'perf',
  'race',
  'resource-leak',
  'reuse',
  'root-cause',
  'runtime',
  'scope-creep',
  'seam',
  'security',
  'shallow',
  'standards',
  'test-gap',
  'test-leak',
  'type',
  'ui',
  'yagni',
]);
export const CODE_LOCUS_PATTERN =
  /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[^:\\\r\n]+:L[1-9]\d*$/;

export function parseReport(text) {
  return parseReviewReport(text, {
    kind: 'code',
    tags: CODE_TAGS,
    locusPattern: CODE_LOCUS_PATTERN,
    locusDescription: '"<relative-file>:L<line>"',
  });
}

export function parseRebuttal(text, expectedKeys) {
  return parseRebuttalReport(text, { kind: 'code', expectedKeys });
}

export function assertParserIntegrity(skillDir = SKILL_DIR, dispatchDir = DISPATCH_DIR) {
  for (const [label, directory] of [['dispatch-code-review', skillDir], ['dispatch', dispatchDir]]) {
    const integrity = verifySkillIntegrity(directory);
    if (!integrity.valid && !integrity.missing) {
      throw new Error(`${label} integrity failure: ${integrity.violations.join(', ')}`);
    }
  }
}

const USAGE = `Usage:
  node scripts/parse-report.mjs [--file <path|->] [--rebuttal-packet <path>]

Reads a delegate JSON report from stdin by default and writes normalized JSON.
Exit 0 parsed, 1 empty or content-free report, 2 invocation failure, 3 prose or schema-mismatched report.
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
        error: err.prose ? 'prose-report' : 'invalid-report',
        diagnostics: err.diagnostics,
      }, null, 2)}\n`);
      process.exit(err.prose ? 3 : 1);
    }
    process.stderr.write(`[parse-report] ${err.message}\n`);
    process.exit(2);
  }
}
