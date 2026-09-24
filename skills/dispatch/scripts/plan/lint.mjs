// @ts-check
import {
  extractActionHeadingRecords,
  extractGeneratedPaths,
  normalizePlanPath,
  structuralLines,
} from './structure.mjs';

const ACCEPTED_EVIDENCE = ['red', 'verify', 'review'];
// Mirrors lib/git-state.mjs normalizeTaskPath: approval rejects these, so lint fails them first.
const EXCLUDED_CHANGE_PATH = /^(?:\.git|\.scratch)(?:\/|$)/;
const PLACEHOLDER = /\b(?:TODO|TBD|implement later|fill in)\b/i;

/** @typedef {{rule: string, locus: string, message: string, severity?: string}} PlanDiagnostic */

// SECTION: Public lint API

/**
 * Validates the executable plan contract without interpreting Markdown examples.
 * @param {string} source
 * @returns {{defects: PlanDiagnostic[], warnings: PlanDiagnostic[]}}
 */
export function lintPlan(source) {
  const context = createLintContext(source);
  lintProposedChanges(context);
  lintVerificationPlan(context);
  lintSuccessCriteria(context);
  lintGeneratedPaths(context);
  lintPlaceholders(context);
  return { defects: context.defects, warnings: context.warnings };
}

// SECTION: Section rules

function lintProposedChanges(context) {
  const { lines, records, proposed, defects } = context;
  if (proposed.length !== 1) defects.push(diagnostic('proposed-changes', null, 'Expected exactly one ## Proposed Changes section.'));
  if (proposed.length === 1 && records.length === 0) defects.push(diagnostic('change-heading', lines[proposed[0].start].line, 'Proposed Changes requires an H4 action heading.'));

  for (const record of records.filter(({ rejectionReason }) => rejectionReason)) {
    defects.push(diagnostic('invalid-change-path', record.line, `Invalid change path: ${record.rejectionReason}.`));
  }

  const seen = new Set();
  for (const record of records.filter(({ path: value }) => value)) {
    if (seen.has(record.path)) defects.push(diagnostic('duplicate-change-path', record.line, `Change path "${record.path}" appears more than once.`));
    seen.add(record.path);
    if (EXCLUDED_CHANGE_PATH.test(record.path)) defects.push(excludedPathDefect(record.line, record.path));
  }
}

function lintVerificationPlan(context) {
  const { lines, verification, defects, warnings } = context;
  if (verification.length !== 1) defects.push(diagnostic('verification-plan', null, 'Expected exactly one ## Verification Plan section.'));

  const automated = findExactHeadings(lines, '### Automated Tests');
  const owned = verification.length === 1
    ? automated.filter(({ index }) => index > verification[0].start && index < verification[0].end)
    : [];
  if (owned.length !== 1) defects.push(diagnostic('automated-tests', null, 'Expected exactly one ### Automated Tests under Verification Plan.'));
  if (automated.some(({ index }) => !owned.some(candidate => candidate.index === index))) {
    defects.push(diagnostic('automated-tests-owner', null, 'Automated Tests must belong to Verification Plan.'));
  }
  if (owned.length !== 1) return;

  const sectionLines = automatedTestLines(lines, verification[0], owned[0].index);
  const direct = sectionLines.filter(({ text }) => /^-\s+`[^`]+`\s*$/.test(text));
  const ambiguous = sectionLines.filter(({ text }) => /^-\s+.*`[^`]+`.*`[^`]+`/.test(text));
  for (const entry of ambiguous) warnings.push(diagnostic('ambiguous-command', entry.line, 'Automated-test bullet contains multiple inline-code spans.', 'warning'));

  const none = sectionLines.find(({ text }) => /^-\s+None:\s*\S.*$/.test(text));
  const fencedCommand = sectionLines.some(isFencedCommand);
  if (none) warnings.push(diagnostic('automated-tests-unavailable', none.line, 'Automated tests are explicitly unavailable.', 'warning'));
  if (!direct.length && !fencedCommand && !none) {
    defects.push(diagnostic('automated-command', owned[0].entry.line, 'Automated Tests requires a command or - None: <reason>.'));
  }
}

function lintSuccessCriteria(context) {
  const { criteria, warnings, defects } = context;
  if (criteria.length === 0) {
    warnings.push(diagnostic('missing-success-criteria', null, 'Plan has no Success Criteria section.', 'warning'));
    return;
  }
  if (criteria.length > 1) {
    defects.push(diagnostic('success-criteria', null, 'Expected at most one Success Criteria section.'));
    return;
  }
  lintCriteria(context, criteria[0]);
}

function lintGeneratedPaths({ source, defects }) {
  for (const generated of extractGeneratedPaths(source)) {
    if (!generated.command) defects.push(diagnostic('generated-command', generated.line, 'A [GENERATED] path requires a "- Command: `<generator>`" bullet.'));
  }
}

function lintPlaceholders({ lines, warnings }) {
  for (const entry of lines) {
    const prose = entry.text.replace(/`[^`]*`/g, '');
    if (PLACEHOLDER.test(prose)) warnings.push(diagnostic('placeholder', entry.line, 'Plan contains a prose placeholder.', 'warning'));
  }
}

// SECTION: Success criteria

function lintCriteria(context, range) {
  const { lines, records, defects } = context;
  const approved = new Set(records.filter(({ path: value }) => value).map(({ path: value }) => value));
  const ids = new Set();
  let current = null;

  const finish = () => {
    if (current) finishCriterion(current, defects);
  };
  for (const entry of lines.slice(range.start + 1, range.end)) {
    const item = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(entry.text);
    if (item) {
      finish();
      current = startCriterion(item[1], entry.line, ids, defects);
      continue;
    }
    if (!current) continue;
    readCriterionMapping(current, entry, approved, defects);
  }
  finish();
}

function startCriterion(text, line, ids, defects) {
  const id = /^\[SC([1-9]\d*)\]\s+/.exec(text);
  const criterion = { line, hasMapping: false, critical: /\b(?:correctness|safety|recovery|durability|protocol)\b/i.test(text) };
  if (!id) {
    defects.push(diagnostic('criterion-id', line, 'Success criterion requires a stable [SC#] identifier.'));
    return criterion;
  }
  if (ids.has(id[1])) defects.push(diagnostic('criterion-id', line, `Duplicate criterion SC${id[1]}.`));
  ids.add(id[1]);
  return { ...criterion, id: `SC${id[1]}` };
}

function readCriterionMapping(current, entry, approved, defects) {
  const changes = /^ {2,}[-*+] Changes:\s*(.+)$/.exec(entry.text);
  if (changes) {
    current.hasMapping = true;
    for (const value of changes[1].split(',')) lintCriterionPath(value, entry.line, approved, defects);
  }

  const verify = /^ {2,}[-*+] Verify:\s*(.+)$/.exec(entry.text);
  if (verify) {
    current.hasMapping = true;
    if (!/^`[^`]+`\s*$/.test(verify[1])) defects.push(diagnostic('criterion-verify', entry.line, 'Verify requires exactly one inline-code command.'));
  }

  const evidence = /^ {2,}[-*+] Evidence:\s*(\S+)\s*$/.exec(entry.text);
  if (evidence) {
    if (current.evidence) defects.push(diagnostic('criterion-evidence', entry.line, 'Criterion requires exactly one Evidence mapping.'));
    current.evidence = evidence[1].toLowerCase();
    current.evidenceLine = entry.line;
  }

  const rationale = /^ {2,}[-*+] Test rationale:\s*(.*)$/.exec(entry.text);
  if (rationale) {
    if (current.testRationale) defects.push(diagnostic('criterion-test-rationale', entry.line, 'Criterion requires exactly one Test rationale.'));
    if (rationale[1].trim().length < 12) defects.push(diagnostic('criterion-test-rationale', entry.line, 'Test rationale must concretely explain signal and regression value or why a retained test is low-signal.'));
    current.testRationale = rationale[1].trim();
  }

  const review = /^ {2,}[-*+] Review:\s*(.*)$/.exec(entry.text);
  if (review) {
    current.review = review[1].trim();
    current.reviewLine = entry.line;
  }
  const enforcement = /^ {2,}[-*+] Enforcement infeasibility:\s*(.*)$/.exec(entry.text);
  if (enforcement) current.enforcementRationale = enforcement[1].trim();
}

function lintCriterionPath(value, line, approved, defects) {
  const normalized = normalizePlanPath(value);
  if (normalized.path && EXCLUDED_CHANGE_PATH.test(normalized.path)) defects.push(excludedPathDefect(line, normalized.path));
  else if (!normalized.path || !approved.has(normalized.path)) defects.push(diagnostic('criterion-change-path', line, `Criterion references unknown change path "${value.trim()}".`));
}

function finishCriterion(current, defects) {
  if (!current.hasMapping) defects.push(diagnostic('criterion-mapping', current.line, 'Criterion requires Changes or Verify mapping.'));
  if (!current.evidence) defects.push(diagnostic('criterion-evidence', current.line, `Criterion ${current.id ?? 'without an ID'} requires exactly one Evidence mapping: red, verify, or review.`));
  else if (!ACCEPTED_EVIDENCE.includes(current.evidence)) defects.push(diagnostic('criterion-evidence', current.evidenceLine, `Unknown Evidence class "${current.evidence}"; accepted classes are red, verify, review.`));
  if (!current.testRationale) defects.push(diagnostic('criterion-test-rationale', current.line, 'Criterion requires a concrete Test rationale describing retained RED signal or why a new retained test is low-signal.'));
  if (current.evidence !== 'review') return;
  if (!current.review) defects.push(diagnostic('criterion-review', current.line, 'Review evidence requires Review: <artifact>; scenario: <scenario>; pass: <observable condition>.'));
  if (current.review && !/(?:artifact|file|path)\s*:/i.test(current.review)) defects.push(diagnostic('criterion-review', current.reviewLine, 'Review must name the artifact with artifact:, file:, or path:.'));
  if (current.review && !/scenario\s*:/i.test(current.review)) defects.push(diagnostic('criterion-review', current.reviewLine, 'Review must name a bounded scenario with scenario:.'));
  if (current.review && !/(?:pass|observable)\s*:/i.test(current.review)) defects.push(diagnostic('criterion-review', current.reviewLine, 'Review must name the observable pass condition with pass: or observable:.'));
  if (current.critical && !current.enforcementRationale) defects.push(diagnostic('criterion-critical-review', current.line, 'Critical correctness, safety, recovery, durability, or protocol review evidence requires Enforcement infeasibility: <reason>.'));
}

// SECTION: Shared lint utilities

function createLintContext(source) {
  const lines = structuralLines(source);
  return {
    source,
    lines,
    records: extractActionHeadingRecords(source),
    proposed: sectionRanges(lines, '## Proposed Changes'),
    verification: sectionRanges(lines, '## Verification Plan'),
    criteria: sectionRanges(lines, '## Success Criteria'),
    defects: [],
    warnings: [],
  };
}

function sectionRanges(lines, heading) {
  return findExactHeadings(lines, heading).map(({ index }) => {
    const next = lines.findIndex((entry, laterIndex) => laterIndex > index && /^##\s+/.test(entry.text));
    return { start: index, end: next === -1 ? lines.length : next };
  });
}

function findExactHeadings(lines, heading) {
  return lines.flatMap((entry, index) => entry.text.trimEnd() === heading ? [{ entry, index }] : []);
}

function automatedTestLines(lines, verification, start) {
  let end = verification.end;
  for (let index = start + 1; index < end; index += 1) {
    if (/^#{2,3}\s+/.test(lines[index].text)) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

function isFencedCommand({ fenced, original }) {
  return fenced &&
    !/^ {0,3}(`{3,}|~{3,})/.test(original) &&
    original.trim() &&
    !original.trim().startsWith('#') &&
    !/^<!--[\s\S]*-->$/.test(original.trim());
}

function diagnostic(rule, line, message, severity) {
  return { rule, locus: line ? `line ${line}` : 'plan', message, ...(severity ? { severity } : {}) };
}

function excludedPathDefect(line, value) {
  return diagnostic('change-path-excluded', line, `Change path "${value}" is under .git/ or .scratch/; implementation never writes there.`);
}
