#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  InvalidReviewReportError,
  parseReportArgs,
  parseRebuttalReport,
  parseReviewReport,
  readReportInput,
} from './review-report.mjs';
import { isMainModule, verifySkillIntegrity } from './common.mjs';
import { KIND_USAGE, reviewKind } from './review-kinds.mjs';

const DISPATCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseReport(kind, text) {
  const entry = reviewKind(kind);
  return parseReviewReport(text, {
    kind: entry.kind,
    tags: entry.tags,
    locusPattern: entry.locusPattern,
    locusDescription: entry.locusDescription,
  });
}

export function parseRebuttal(kind, text, expectedKeys) {
  return parseRebuttalReport(text, { kind: reviewKind(kind).kind, expectedKeys });
}

export function assertParserIntegrity(dispatchDir = DISPATCH_DIR) {
  const integrity = verifySkillIntegrity(dispatchDir);
  if (!integrity.valid && !integrity.missing) {
    throw new Error(`dispatch integrity failure: ${integrity.violations.join(', ')}`);
  }
}

const USAGE = `Usage:
  node parse-report.mjs --kind ${KIND_USAGE} [--file <path|->] [--rebuttal-packet <path>]

Reads a delegate JSON report from stdin by default and writes normalized JSON.
Exit 0 parsed, 1 empty or content-free report (or missing/unknown --kind), 2 invocation failure,
3 prose or schema-mismatched report.
`;

class UsageError extends Error {}

/** Splits `--kind <kind>` off the argument list; the rest keeps the shared report-args grammar. */
function splitKind(argv) {
  const rest = [];
  let kind = null;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--kind') {
      if (kind !== null) throw new UsageError(`--kind given twice.\n${USAGE}`);
      kind = argv[++index] ?? '';
    } else {
      rest.push(argv[index]);
    }
  }
  return { kind, rest };
}

function main() {
  const { kind, rest } = splitKind(process.argv.slice(2));
  const args = parseReportArgs(rest);
  if (args.help) return process.stdout.write(USAGE);
  try {
    reviewKind(kind);
  } catch (err) {
    throw new UsageError(`${err.message}\n${USAGE}`);
  }
  assertParserIntegrity();
  const expectedKeys = args.rebuttalPacket
    ? JSON.parse(readReportInput(args.rebuttalPacket)).findings.map((finding) => finding.key)
    : null;
  const normalized = expectedKeys
    ? parseRebuttal(kind, readReportInput(args.file), expectedKeys)
    : parseReport(kind, readReportInput(args.file));
  process.stdout.write(`${JSON.stringify(normalized, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`[parse-report] ${err.message}`);
      process.exit(1);
    }
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
