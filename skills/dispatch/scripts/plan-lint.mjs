import {
  extractActionHeadingRecords,
  normalizePlanPath,
  structuralLines,
} from './plan-structure.mjs';

const diagnostic = (rule, line, message, severity) => ({
  rule,
  locus: line ? `line ${line}` : 'plan',
  message,
  ...(severity ? { severity } : {}),
});

// Mirrors git-state.mjs normalizeTaskPath: approval rejects these, so lint fails them first.
const EXCLUDED_CHANGE_PATH = /^(?:\.git|\.scratch)(?:\/|$)/;
const excludedPathDefect = (line, value) => diagnostic('change-path-excluded', line, `Change path "${value}" is under .git/ or .scratch/; implementation never writes there.`);

function sectionRanges(lines, heading) {
  return lines.flatMap((entry, index) => entry.text.trimEnd() === heading ? [{
    start: index,
    end: lines.findIndex((later, laterIndex) => laterIndex > index && /^##\s+/.test(later.text)),
  }] : []).map(range => ({ ...range, end: range.end === -1 ? lines.length : range.end }));
}

export function lintPlan(source) {
  const lines = structuralLines(source);
  const defects = [];
  const warnings = [];
  const proposed = sectionRanges(lines, '## Proposed Changes');
  const verification = sectionRanges(lines, '## Verification Plan');
  const criteria = sectionRanges(lines, '## Success Criteria');
  const records = extractActionHeadingRecords(source);

  if (proposed.length !== 1) defects.push(diagnostic('proposed-changes', null, 'Expected exactly one ## Proposed Changes section.'));
  if (proposed.length === 1 && records.length === 0) defects.push(diagnostic('change-heading', lines[proposed[0].start].line, 'Proposed Changes requires an H4 action heading.'));
  for (const record of records.filter(({ rejectionReason }) => rejectionReason)) {
    defects.push(diagnostic('invalid-change-path', record.line, `Invalid change path: ${record.rejectionReason}.`));
  }
  const seen = new Set();
  for (const record of records.filter(({ path: value }) => value)) {
    if (seen.has(record.path)) defects.push(diagnostic('duplicate-change-path', record.line, `Change path "${record.path}" appears more than once.`));
    seen.add(record.path);
  }

  if (verification.length !== 1) defects.push(diagnostic('verification-plan', null, 'Expected exactly one ## Verification Plan section.'));
  const automated = lines.flatMap((entry, index) => entry.text.trimEnd() === '### Automated Tests' ? [{ entry, index }] : []);
  const ownedAutomated = verification.length === 1
    ? automated.filter(({ index }) => index > verification[0].start && index < verification[0].end)
    : [];
  if (ownedAutomated.length !== 1) defects.push(diagnostic('automated-tests', null, 'Expected exactly one ### Automated Tests under Verification Plan.'));
  if (automated.some(({ index }) => !ownedAutomated.some(owned => owned.index === index))) {
    defects.push(diagnostic('automated-tests-owner', null, 'Automated Tests must belong to Verification Plan.'));
  }
  if (ownedAutomated.length === 1) {
    const start = ownedAutomated[0].index;
    let end = verification[0].end;
    for (let index = start + 1; index < end; index += 1) {
      if (/^#{2,3}\s+/.test(lines[index].text)) { end = index; break; }
    }
    const sectionLines = lines.slice(start + 1, end);
    const direct = sectionLines.filter(({ text }) => /^-\s+`[^`]+`\s*$/.test(text));
    const ambiguous = sectionLines.filter(({ text }) => /^-\s+.*`[^`]+`.*`[^`]+`/.test(text));
    for (const entry of ambiguous) {
      warnings.push(diagnostic('ambiguous-command', entry.line, 'Automated-test bullet contains multiple inline-code spans.', 'warning'));
    }
    const none = sectionLines.find(({ text }) => /^-\s+None:\s*\S.*$/.test(text));
    const fencedCommand = sectionLines.some(({ fenced, original }) => fenced &&
      !/^ {0,3}(`{3,}|~{3,})/.test(original) &&
      original.trim() &&
      !original.trim().startsWith('#') &&
      !/^<!--[\s\S]*-->$/.test(original.trim()));
    if (none) warnings.push(diagnostic('automated-tests-unavailable', none.line, 'Automated tests are explicitly unavailable.', 'warning'));
    if (!direct.length && !fencedCommand && !none) {
      defects.push(diagnostic('automated-command', ownedAutomated[0].entry.line, 'Automated Tests requires a command or - None: <reason>.'));
    }
  }

  if (criteria.length === 0) {
    warnings.push(diagnostic('missing-success-criteria', null, 'Legacy plan has no Success Criteria section.', 'warning'));
  } else if (criteria.length > 1) {
    defects.push(diagnostic('success-criteria', null, 'Expected at most one Success Criteria section.'));
  }

  for (const record of records) if (record.path && EXCLUDED_CHANGE_PATH.test(record.path)) defects.push(excludedPathDefect(record.line, record.path));

  if (criteria.length === 1) {
    const { start, end } = criteria[0];
    const ids = new Set();
    let current = null;
    const approved = new Set(records.filter(record => record.path).map(record => record.path));
    const finish = () => {
      if (!current) return;
      if (!current.hasMapping) defects.push(diagnostic('criterion-mapping', current.line, 'Criterion requires Changes or Verify mapping.'));
      if (!current.evidence) defects.push(diagnostic('criterion-evidence', current.line, `Criterion ${current.id ?? 'without an ID'} requires exactly one Evidence mapping: red, verify, or review.`));
      else if (!['red', 'verify', 'review'].includes(current.evidence)) defects.push(diagnostic('criterion-evidence', current.evidenceLine, `Unknown Evidence class "${current.evidence}"; accepted classes are red, verify, review.`));
      if (!current.testRationale) defects.push(diagnostic('criterion-test-rationale', current.line, 'Criterion requires a concrete Test rationale describing retained RED signal or why a new retained test is low-signal.'));
      if (current.evidence === 'review' && !current.review) defects.push(diagnostic('criterion-review', current.line, 'Review evidence requires Review: <artifact>; scenario: <scenario>; pass: <observable condition>.'));
      if (current.evidence === 'review' && current.review && !/(?:artifact|file|path)\s*:/i.test(current.review)) defects.push(diagnostic('criterion-review', current.reviewLine, 'Review must name the artifact with artifact:, file:, or path:.'));
      if (current.evidence === 'review' && current.review && !/scenario\s*:/i.test(current.review)) defects.push(diagnostic('criterion-review', current.reviewLine, 'Review must name a bounded scenario with scenario:.'));
      if (current.evidence === 'review' && current.review && !/(?:pass|observable)\s*:/i.test(current.review)) defects.push(diagnostic('criterion-review', current.reviewLine, 'Review must name the observable pass condition with pass: or observable:.'));
      if (current.evidence === 'review' && current.critical && !current.enforcementRationale) defects.push(diagnostic('criterion-critical-review', current.line, 'Critical correctness, safety, recovery, durability, or protocol review evidence requires Enforcement infeasibility: <reason>.'));
    };
    for (const entry of lines.slice(start + 1, end)) {
      const item = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(entry.text);
      if (item) {
        finish();
        const id = /^\[SC([1-9]\d*)\]\s+/.exec(item[1]);
        if (!id) {
          defects.push(diagnostic('criterion-id', entry.line, 'Success criterion requires a stable [SC#] identifier.'));
          current = { line: entry.line, hasMapping: false, critical: /\b(?:correctness|safety|recovery|durability|protocol)\b/i.test(item[1]) };
        } else {
          if (ids.has(id[1])) defects.push(diagnostic('criterion-id', entry.line, `Duplicate criterion SC${id[1]}.`));
          ids.add(id[1]);
          current = { id: `SC${id[1]}`, line: entry.line, hasMapping: false, critical: /\b(?:correctness|safety|recovery|durability|protocol)\b/i.test(item[1]) };
        }
        continue;
      }
      if (!current) continue;
      const changes = /^ {2,}[-*+] Changes:\s*(.+)$/.exec(entry.text);
      if (changes) {
        current.hasMapping = true;
        for (const value of changes[1].split(',')) {
          const normalized = normalizePlanPath(value);
          if (normalized.path && EXCLUDED_CHANGE_PATH.test(normalized.path)) defects.push(excludedPathDefect(entry.line, normalized.path));
          else if (!normalized.path || !approved.has(normalized.path)) {
            defects.push(diagnostic('criterion-change-path', entry.line, `Criterion references unknown change path "${value.trim()}".`));
          }
        }
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
      if (review) { current.review = review[1].trim(); current.reviewLine = entry.line; }
      const enforcement = /^ {2,}[-*+] Enforcement infeasibility:\s*(.*)$/.exec(entry.text);
      if (enforcement) current.enforcementRationale = enforcement[1].trim();
    }
    finish();
  }

  for (const entry of lines) {
    const prose = entry.text.replace(/`[^`]*`/g, '');
    if (/\b(?:TODO|TBD|implement later|fill in)\b/i.test(prose)) {
      warnings.push(diagnostic('placeholder', entry.line, 'Plan contains a prose placeholder.', 'warning'));
    }
  }
  return { defects, warnings };
}
