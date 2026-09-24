// @ts-check

// SECTION: Report contracts

const SEVERITIES = new Set(['MUST', 'SHOULD', 'CONSIDER']);
const SUMMARY_STATUSES = new Set(['CLEAN', 'FINDINGS']);
const REPORT_FIELDS = ['findings', 'status'];
const FINDING_FIELDS = ['defect', 'locus', 'requiredChange', 'severity', 'tag'];
const REBUTTAL_FIELDS = ['responses'];
const RESPONSE_FIELDS = ['evidence', 'key', 'type', 'verdict'];
const REBUTTAL_VERDICTS = new Set(['CONFIRM', 'REBUT', 'INTENT-DISPUTE']);

/** Invalid structured report plus field-level diagnostics. */
export class InvalidReviewReportError extends Error {
  /** @param {Record<string, any>[]} diagnostics @param {{ prose?: boolean }} [options] */
  constructor(diagnostics, { prose = false } = {}) {
    super('Invalid delegate report.');
    this.name = 'InvalidReviewReportError';
    this.diagnostics = diagnostics;
    // Unparseable non-empty text is a prose report the orchestrator reads, not a schema violation.
    this.prose = prose;
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

// SECTION: Locus normalization

// Evidence is prose cited as written, so it accepts the same variants normalizeLocus rewrites; a
// bare `:<line>` needs a path-like token (a `/` or a file extension) so times and ratios never count;
// backslash paths are excluded as the finding-locus pattern excludes them.
function hasEvidenceLocus(kind, evidence) {
  if (!nonEmptyString(evidence)) return false;
  const codeLocus = /(?:^|\s)(?!\/)(?![A-Za-z]:)(?!\.\.\/)(?:[^:\s\\]+(?::L|#L)|[^:\s\\]*(?:\/|\.[A-Za-z])[^:\s\\]*:)[1-9]\d*\b/;
  // `§ <Plan heading>` is the template placeholder, echoed by delegates, never a citation.
  return kind === 'code' ? codeLocus.test(evidence) : /§\s*[^\s<]/.test(evidence) || codeLocus.test(evidence);
}

// Rewrites only the line prefix; ranges and columns keep their extent and fail validation, so
// the orchestrator restates them instead of the parser truncating the cited span.
export function normalizeLocus(kind, locus) {
  const trimmed = locus.trim();
  // A bare colon needs a path-like token so times and ratios (`10:30`, `2.5:1`) never become loci.
  if (kind === 'code') {
    return trimmed.replace(/^([^:#]+)#L([1-9]\d*)$/, '$1:L$2').replace(/^([^:#]*(?:\/|\.[A-Za-z])[^:#]*):([1-9]\d*)$/, '$1:L$2');
  }
  return trimmed.replace(/^§(?=\S)/, '§ ');
}

// Schema-mismatched JSON that still carries items is a prose report the orchestrator restates;
// only a content-free report is invalid, so an empty array never reads as a clean review.
function hasRestatableItems(value) {
  return Array.isArray(value) && value.some((item) =>
    nonEmptyString(item) ||
    (item && typeof item === 'object' && Object.values(item).some(nonEmptyString)));
}

// An explicit CLEAN verdict with an empty list is review content even when a field mismatches.
function hasReviewContent(value) {
  return hasRestatableItems(value.findings) ||
    (value.status === 'CLEAN' && Array.isArray(value.findings) && value.findings.length === 0);
}

function isContainerText(text) {
  return (text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'));
}

// String-aware so brackets inside JSON strings never close the container early.
// SECTION: JSON extraction

function balancedContainerEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth++;
    else if ((char === '}' || char === ']') && --depth === 0) return index + 1;
  }
  return -1;
}

// Non-schema providers wrap the report in banners, fences, or trailing notes; the report is the
// last candidate, so earlier cited snippets and fenced examples never win. Nothing is repaired.
export function extractJsonText(raw) {
  const str = String(raw ?? '').trim();
  if (isContainerText(str)) {
    return str;
  }
  // Fenced and bare candidates compete by position; the last one that parses is the report.
  const candidates = [];
  const fences = [...str.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
  for (const match of fences) {
    const candidate = match[1].trim();
    if (isContainerText(candidate)) candidates.push({ at: match.index, text: candidate });
  }
  const insideFence = (offset) => fences.some((match) => offset > match.index && offset < match.index + match[0].length);
  let resumeAt = 0;
  for (const match of str.matchAll(/^[ \t]*[{[]/gm)) {
    const start = match.index + match[0].length - 1;
    if (start < resumeAt || insideFence(start)) continue;
    const end = balancedContainerEnd(str, start);
    if (end === -1) continue;
    const candidate = str.slice(start, end);
    // A malformed container still owns its span and competes by position, so neither its elements
    // nor an earlier snippet stand in for it; its text then fails to parse and reads as prose.
    resumeAt = end;
    candidates.push({ at: start, text: candidate });
  }
  candidates.sort((left, right) => left.at - right.at);
  // A trailing report that fails to parse, fenced or bare, surfaces as malformed JSON; an earlier
  // snippet never stands in for it.
  return candidates.at(-1)?.text ?? str;
}

// Prose outside the extracted report (not just fences or whitespace) may carry the review itself;
// a content-free trailing block must not discard it, so the orchestrator reads the whole text.
function outsideText(raw, json) {
  const at = raw.lastIndexOf(json);
  return at === -1 ? '' : (raw.slice(0, at) + raw.slice(at + json.length)).replace(/```(?:json)?/gi, '');
}

// SECTION: Structured parsing

function parseJsonReport(text) {
  // A whole-text parse first keeps a pretty-printed bare array intact; extraction would split it
  // into its line-initial element objects.
  try {
    return { value: JSON.parse(String(text ?? '')), surrounded: false, outside: '' };
  } catch {
    // Fall through to extraction from banners, fences, and trailing notes.
  }
  const json = extractJsonText(text);
  if (json.length === 0) {
    throw new InvalidReviewReportError([diagnostic(null, '$', 'report is empty')]);
  }
  try {
    const outside = outsideText(String(text ?? ''), json);
    return { value: JSON.parse(json), surrounded: /[A-Za-z]{3}/.test(outside), outside };
  } catch (err) {
    throw new InvalidReviewReportError(
      [diagnostic(null, '$', `malformed JSON: ${err.message}`)],
      { prose: true },
    );
  }
}

/** @param {string} text @param {{ kind: string, tags: Set<string>, locusPattern: RegExp, locusDescription: string }} contract */
export function parseReviewReport(text, { kind, tags, locusPattern, locusDescription }) {
  const diagnostics = [];
  const { value, surrounded, outside } = parseJsonReport(text);

  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new InvalidReviewReportError(
      [diagnostic(null, '$', 'report must be a JSON object')],
      { prose: surrounded || hasRestatableItems(value) },
    );
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
      const locus = typeof findingValue.locus === 'string' ? normalizeLocus(kind, findingValue.locus) : null;
      if (locus !== null && !locusPattern.test(locus)) {
        diagnostics.push(diagnostic(index, 'locus', `must match ${locusDescription}`));
      }

      if (
        SEVERITIES.has(findingValue.severity) &&
        ['locus', 'tag', 'defect', 'requiredChange'].every((field) =>
          nonEmptyString(findingValue[field])) &&
        tags.has(findingValue.tag) &&
        locusPattern.test(locus)
      ) {
        const finding = {
          type: 'finding',
          severity: findingValue.severity,
          locus,
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

  // A locus cited outside a trailing CLEAN block is a prose finding; trusting the block drops it.
  if (value.status === 'CLEAN' && diagnostics.length === 0 && hasEvidenceLocus(kind, outside)) {
    diagnostics.push(diagnostic(null, '$', 'CLEAN report is surrounded by prose'));
  }
  if (diagnostics.length > 0) {
    throw new InvalidReviewReportError(diagnostics, { prose: surrounded || hasReviewContent(value) });
  }
  return {
    schemaVersion: 1,
    reportKind: kind,
    summary: { type: 'summary', status: value.status },
    findings,
  };
}

/** @param {string} text @param {{ kind: string, expectedKeys: string[] }} contract */
export function parseRebuttalReport(text, { kind, expectedKeys }) {
  const diagnostics = [];
  const { value, surrounded } = parseJsonReport(text);
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new InvalidReviewReportError(
      [diagnostic(null, '$', 'rebuttal report must be a JSON object')],
      { prose: surrounded || hasRestatableItems(value) },
    );
  }
  if (!exactFields(value, REBUTTAL_FIELDS)) {
    diagnostics.push(diagnostic(null, '$', 'rebuttal report fields must be exactly: responses'));
  }
  if (!Array.isArray(value.responses)) {
    diagnostics.push(diagnostic(null, 'responses', 'must be an array'));
  }
  const requiredKeys = new Set(expectedKeys);
  if (requiredKeys.size !== expectedKeys.length || expectedKeys.some((key) => !nonEmptyString(key))) {
    throw new Error('expected rebuttal keys must be unique non-empty strings');
  }
  const responses = [];
  const seen = new Set();
  if (Array.isArray(value.responses)) {
    for (const [index, response] of value.responses.entries()) {
      if (!response || Array.isArray(response) || typeof response !== 'object') {
        diagnostics.push(diagnostic(index, '$', 'response must be a JSON object'));
        continue;
      }
      if (!exactFields(response, RESPONSE_FIELDS)) {
        diagnostics.push(
          diagnostic(index, '$', 'response fields must be exactly: type, key, verdict, evidence'),
        );
      }
      if (response.type !== 'rebuttal') {
        diagnostics.push(diagnostic(index, 'type', 'must be rebuttal'));
      }
      if (!nonEmptyString(response.key)) {
        diagnostics.push(diagnostic(index, 'key', 'must be a non-empty string'));
      } else if (!requiredKeys.has(response.key)) {
        diagnostics.push(diagnostic(index, 'key', 'was not supplied in the finding packet'));
      } else if (seen.has(response.key)) {
        diagnostics.push(diagnostic(index, 'key', 'duplicate response key'));
      } else {
        seen.add(response.key);
      }
      if (!REBUTTAL_VERDICTS.has(response.verdict)) {
        diagnostics.push(
          diagnostic(index, 'verdict', 'must be CONFIRM, REBUT, or INTENT-DISPUTE'),
        );
      }
      if (!nonEmptyString(response.evidence)) {
        diagnostics.push(diagnostic(index, 'evidence', 'must be a non-empty string'));
      } else if (!hasEvidenceLocus(kind, response.evidence)) {
        diagnostics.push(
          diagnostic(index, 'evidence', `must cite a ${kind === 'code' ? 'code' : 'plan or code'} locus`),
        );
      }
      if (
        response.type === 'rebuttal' &&
        nonEmptyString(response.key) &&
        requiredKeys.has(response.key) &&
        REBUTTAL_VERDICTS.has(response.verdict) &&
        hasEvidenceLocus(kind, response.evidence)
      ) {
        responses.push({
          type: 'rebuttal',
          key: response.key,
          verdict: response.verdict,
          evidence: response.evidence.trim(),
        });
      }
    }
  }
  for (const key of requiredKeys) {
    if (!seen.has(key)) diagnostics.push(diagnostic(null, 'responses', `missing response for ${key}`));
  }
  if (diagnostics.length > 0) {
    throw new InvalidReviewReportError(diagnostics, { prose: surrounded || hasRestatableItems(value.responses) });
  }
  return {
    schemaVersion: 1,
    reportKind: kind,
    mode: 'rebuttal',
    responses,
  };
}
