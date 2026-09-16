import fs from 'node:fs';

const SEVERITIES = new Set(['MUST', 'SHOULD', 'CONSIDER']);
const SUMMARY_STATUSES = new Set(['CLEAN', 'FINDINGS']);
const REPORT_FIELDS = ['findings', 'status'];
const FINDING_FIELDS = ['defect', 'locus', 'requiredChange', 'severity', 'tag'];

export class InvalidReviewReportError extends Error {
  constructor(diagnostics) {
    super('Invalid delegate report.');
    this.name = 'InvalidReviewReportError';
    this.diagnostics = diagnostics;
  }
}

function exactFields(value, expected) {
  return Object.keys(value).sort().join('\0') === expected.join('\0');
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function diagnostic(index, field, message) {
  return { index, field, message };
}

export function parseReviewReport(text, { kind, tags, locusPattern, locusDescription }) {
  const diagnostics = [];
  let value;
  try {
    value = JSON.parse(String(text));
  } catch (err) {
    throw new InvalidReviewReportError([
      diagnostic(null, '$', `malformed JSON: ${err.message}`),
    ]);
  }

  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new InvalidReviewReportError([
      diagnostic(null, '$', 'report must be a JSON object'),
    ]);
  }
  if (!exactFields(value, REPORT_FIELDS)) {
    diagnostics.push(diagnostic(null, '$', 'report fields must be exactly: status, findings'));
  }
  if (!SUMMARY_STATUSES.has(value.status)) {
    diagnostics.push(diagnostic(null, 'status', 'must be CLEAN or FINDINGS'));
  }
  if (!Array.isArray(value.findings)) {
    diagnostics.push(diagnostic(null, 'findings', 'must be an array'));
  }

  const findings = [];
  const seenFindings = new Set();
  if (Array.isArray(value.findings)) {
    for (const [index, findingValue] of value.findings.entries()) {
      if (!findingValue || Array.isArray(findingValue) || typeof findingValue !== 'object') {
        diagnostics.push(diagnostic(index, '$', 'finding must be a JSON object'));
        continue;
      }
      if (!exactFields(findingValue, FINDING_FIELDS)) {
        diagnostics.push(
          diagnostic(
            index,
            '$',
            'finding fields must be exactly: severity, locus, tag, defect, requiredChange',
          ),
        );
      }
      for (const field of ['locus', 'tag', 'defect', 'requiredChange']) {
        if (!nonEmptyString(findingValue[field])) {
          diagnostics.push(diagnostic(index, field, 'must be a non-empty string'));
        }
      }
      if (!SEVERITIES.has(findingValue.severity)) {
        diagnostics.push(diagnostic(index, 'severity', 'must be MUST, SHOULD, or CONSIDER'));
      }
      if (typeof findingValue.tag === 'string' && !tags.has(findingValue.tag)) {
        diagnostics.push(diagnostic(index, 'tag', `is not an allowed ${kind} review tag`));
      }
      if (
        typeof findingValue.locus === 'string' &&
        !locusPattern.test(findingValue.locus.trim())
      ) {
        diagnostics.push(diagnostic(index, 'locus', `must match ${locusDescription}`));
      }

      if (
        SEVERITIES.has(findingValue.severity) &&
        ['locus', 'tag', 'defect', 'requiredChange'].every((field) =>
          nonEmptyString(findingValue[field])) &&
        tags.has(findingValue.tag) &&
        locusPattern.test(findingValue.locus.trim())
      ) {
        const finding = {
          type: 'finding',
          severity: findingValue.severity,
          locus: findingValue.locus.trim(),
          tag: findingValue.tag.trim(),
          defect: findingValue.defect.trim(),
          requiredChange: findingValue.requiredChange.trim(),
        };
        const key = JSON.stringify(finding);
        if (seenFindings.has(key)) {
          diagnostics.push(diagnostic(index, '$', 'duplicate finding'));
        } else {
          seenFindings.add(key);
          findings.push(finding);
        }
      }
    }
  }

  if (value.status === 'CLEAN' && findings.length > 0) {
    diagnostics.push(diagnostic(null, 'status', 'CLEAN requires an empty findings array'));
  }
  if (value.status === 'FINDINGS' && findings.length === 0) {
    diagnostics.push(diagnostic(null, 'status', 'FINDINGS requires at least one valid finding'));
  }

  if (diagnostics.length > 0) throw new InvalidReviewReportError(diagnostics);
  return {
    schemaVersion: 1,
    reportKind: kind,
    summary: { type: 'summary', status: value.status },
    findings,
  };
}

export function parseReportArgs(argv) {
  let file = '-';
  let help = false;
  let sawFile = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--file') {
      const value = argv[++index];
      if (!value || sawFile) throw new Error('--file requires one path or -');
      file = value;
      sawFile = true;
    } else if (arg === '-h' || arg === '--help') {
      help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { file, help };
}

export function readReportInput(file) {
  try {
    return fs.readFileSync(file === '-' ? 0 : file, 'utf8');
  } catch (err) {
    throw new Error(`could not read ${file === '-' ? 'stdin' : file}: ${err.message}`);
  }
}
