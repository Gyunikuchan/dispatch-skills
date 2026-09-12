#!/usr/bin/env node

/**
 * @file status.mjs
 * @description Reads and writes finding status directly in an audit report, so a fix run survives
 * context loss: the report, not the conversation, holds what is open. There is no second state file.
 *
 * Status lives on each finding's own `- **Status**: <status> — <note>` line inside
 * `## 3. Findings`; `init` backfills the line on reports written without one and refreshes the
 * counts blockquote under the section heading.
 *
 * Usage:
 *   node <skill>/scripts/status.mjs init [--run <yyyy-mm-dd-hhmm>]
 *   node <skill>/scripts/status.mjs list [--run <run>] [--status open] [--severity critical,high] [--full]
 *   node <skill>/scripts/status.mjs batch [--run <run>] [--size 8]
 *   node <skill>/scripts/status.mjs set A-3 fixed [--note "..."] [--run <run>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const STATUSES = ['open', 'fixed', 'false-positive', 'decision', 'deferred'];
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'nit'];
const AUDIT_DIR = '.scratch/audits';
const COUNTS_PREFIX = '> Fix status:';

// ============================================================================
// SECTION: Paths
// ============================================================================

function repoRoot() {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error('Run from inside the dispatch-skills repository.');
  return path.resolve(res.stdout.trim());
}

/** Resolves `--run <yyyy-mm-dd-hhmm>` (or a report path), else the newest report in `.scratch/audits/`. */
function resolveReport(root, argv) {
  const auditDir = path.join(root, ...AUDIT_DIR.split('/'));
  const value = flag(argv, '--run');
  if (value) {
    const file = /^\d{4}-\d{2}-\d{2}-\d{4}$/.test(value)
      ? path.join(auditDir, `${value}-audit.md`)
      : path.resolve(root, value);
    if (!fs.existsSync(file)) throw new Error(`No audit report at ${value}`);
    return file;
  }
  if (!fs.existsSync(auditDir)) throw new Error(`No ${AUDIT_DIR}/ — run audit-dispatch-skills first.`);
  // Reports are named `yyyy-mm-dd-hhmm-audit.md`, so lexical order is chronological.
  const reports = fs.readdirSync(auditDir).filter((name) => /^\d{4}-\d{2}-\d{2}-\d{4}-audit\.md$/.test(name)).sort();
  if (reports.length === 0) throw new Error(`No <run>-audit.md under ${AUDIT_DIR}/ — run audit-dispatch-skills first.`);
  return path.join(auditDir, reports[reports.length - 1]);
}

function flag(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index === -1 || !argv[index + 1] ? fallback : argv[index + 1];
}

// ============================================================================
// SECTION: Report parsing
// ============================================================================

/**
 * Splits the report into lines plus the half-open line range of `## 3. Findings`, so every edit
 * rewrites one line in place and the rest of the report — summary, appendix — stays byte-identical.
 */
function loadReport(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => /^## 3\. Findings\s*$/.test(line));
  if (start === -1) throw new Error(`${file} has no "## 3. Findings" section.`);
  // Ends at the next top-level heading (numbered or not), or at EOF when Findings is last.
  const after = lines.findIndex((line, i) => i > start && /^## /.test(line));
  return { file, lines, start, end: after === -1 ? lines.length : after };
}

/**
 * Extracts findings from the `## 3. Findings` section only, so the appendix's already refuted
 * claims never enter the fix run. The shape parsed here is the report contract fixed in
 * audit-dispatch-skills § "5. Write the report"; a report that drifts from it fails loudly.
 */
function parseFindings(report) {
  const { lines, start, end } = report;
  const heads = [];
  for (let i = start; i < end; i += 1) {
    const head = /^#### (A-\d+):\s*(.+)$/.exec(lines[i]);
    if (head) heads.push({ id: head[1], title: head[2].trim(), line: i });
  }

  const findings = heads.map((head, n) => {
    const blockEnd = n + 1 < heads.length ? heads[n + 1].line : end;
    // A `### <Severity>` group heading sits between findings; it belongs to the next group, not this body.
    const block = lines.slice(head.line, blockEnd);
    while (block.length > 1 && /^(#{1,3} |-{3,}\s*$|\s*$)/.test(block[block.length - 1])) block.pop();
    const find = (re) => {
      for (let i = 0; i < block.length; i += 1) {
        const match = re.exec(block[i]);
        if (match) return { match, line: head.line + i };
      }
      return null;
    };
    const meta = find(/^-\s+\*\*(\w+)\*\*\s*·\s*([^·]+?)\s*·\s*([^·]+?)\s*·/);
    const location = find(/^-\s+\*\*Location\*\*:\s*(.+)$/);
    const status = find(/^-\s+\*\*Status\*\*:\s*([\w-]+)\s*(?:[—–-]\s*(.*))?$/);
    const severity = meta ? meta.match[1].toLowerCase() : null;
    return {
      id: head.id,
      title: head.title,
      severity,
      metaLine: meta ? meta.line : null,
      location: location ? location.match[1].trim() : '',
      status: status ? status.match[1] : 'open',
      note: status ? (status.match[2] ?? '').trim() : '',
      statusLine: status ? status.line : null,
      // Where a missing status line is inserted: right below the meta line, else below the heading.
      anchor: meta ? meta.line : head.line,
      body: block.join('\n').trim(),
    };
  });

  const malformed = findings.filter((f) => f.metaLine === null || !SEVERITIES.includes(f.severity));
  if (findings.length > 0 && malformed.length > 0) {
    // Silently defaulting the severity here would demote a critical finding on a stray delimiter.
    throw new Error(
      `Unreadable severity line in ${report.file}: ${malformed.map((f) => f.id).join(', ')}. ` +
        `Each finding needs \`- **<${SEVERITIES.join('|')}>** · <axis> · <verification> · <sources>\` ` +
        `directly under its heading, with \`·\` separators.`,
    );
  }
  if (findings.length === 0) {
    throw new Error(
      `${report.file} § "3. Findings" yielded no findings — expected \`#### A-<n>: <title>\` headings ` +
        `followed by a \`- **<severity>** · <axis> · <verification> · <sources>\` line. Fix the report, then re-run init.`,
    );
  }
  const unknown = findings.filter((f) => !STATUSES.includes(f.status));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown status in ${report.file}: ${unknown.map((f) => `${f.id} (${f.status})`).join(', ')}. ` +
        `Valid: ${STATUSES.join(', ')}.`,
    );
  }
  return findings;
}

/** First path in the `Location` field, used to batch findings that touch the same file. */
function primaryFile(location) {
  const match = /`([^`:]+)/.exec(location);
  return match ? match[1] : '(unlocated)';
}

function severityRank(severity) {
  const index = SEVERITIES.indexOf(severity);
  return index === -1 ? SEVERITIES.length : index;
}

/** Highest severity first, then stable by id, so a batch leads with what matters most. */
function ranked(findings) {
  return [...findings].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || a.id.localeCompare(b.id, 'en', { numeric: true }),
  );
}

// ============================================================================
// SECTION: Report writing
// ============================================================================

function statusLine(status, note) {
  return note ? `- **Status**: ${status} — ${note}` : `- **Status**: ${status}`;
}

/**
 * Applies status edits and the counts blockquote to the report. Edits are keyed by absolute line
 * index and inserts are applied last, back to front, so earlier indices stay valid.
 */
function writeReport(report, { replace = new Map(), insertAfter = new Map() } = {}) {
  const lines = [...report.lines];
  for (const [index, text] of replace) lines[index] = text;
  for (const [index, text] of [...insertAfter].sort((a, b) => b[0] - a[0])) lines.splice(index + 1, 0, text);
  fs.writeFileSync(report.file, lines.join('\n'), 'utf8');
}

/** Rewrites (or inserts) the counts blockquote directly under the `## 3. Findings` heading. */
function refreshCounts(reportFile) {
  const report = loadReport(reportFile);
  const findings = parseFindings(report);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, findings.filter((f) => f.status === s).length]));
  const text = `${COUNTS_PREFIX} ${STATUSES.map((s) => `${s} ${counts[s]}`).join(', ')} (total ${findings.length}).`;

  const lines = [...report.lines];
  const existing = lines.findIndex(
    (line, i) => i > report.start && i < report.start + 4 && line.startsWith(COUNTS_PREFIX),
  );
  if (existing !== -1) lines[existing] = text;
  else lines.splice(report.start + 1, 0, '', text);
  fs.writeFileSync(report.file, lines.join('\n'), 'utf8');
  return { counts, total: findings.length };
}

// ============================================================================
// SECTION: Commands
// ============================================================================

function cmdInit(root, reportFile) {
  const report = loadReport(reportFile);
  const findings = parseFindings(report);
  const insertAfter = new Map();
  for (const finding of findings) {
    if (finding.statusLine === null) insertAfter.set(finding.anchor, statusLine('open', ''));
  }
  writeReport(report, { insertAfter });
  const { counts, total } = refreshCounts(reportFile);
  console.log(`Report: ${path.relative(root, report.file).split(path.sep).join('/')}`);
  console.log(`${total} findings (${insertAfter.size} newly marked open) — ${STATUSES.map((s) => `${s} ${counts[s]}`).join(', ')}`);
}

function cmdList(root, reportFile, argv) {
  const status = flag(argv, '--status');
  const severities = flag(argv, '--severity')?.split(',').map((s) => s.trim());
  const full = argv.includes('--full');
  const all = ranked(parseFindings(loadReport(reportFile)));
  const rows = all.filter(
    (f) => (!status || f.status === status) && (!severities || severities.includes(f.severity)),
  );
  for (const row of rows) {
    if (full) console.log(`${row.body}\n`);
    else console.log(`${row.id}\t${row.severity}\t${row.status}\t${primaryFile(row.location)}\t${row.title}`);
  }
  console.error(`${rows.length} of ${all.length} findings listed.`);
}

/**
 * Prints the next batch of open findings: highest severity first, then grouped by the file they
 * touch, so one batch lands in one area of the tree.
 */
function cmdBatch(root, reportFile, argv) {
  const size = Number(flag(argv, '--size', '8'));
  const open = ranked(parseFindings(loadReport(reportFile))).filter((f) => f.status === 'open');
  if (open.length === 0) {
    console.log('No open findings.');
    return;
  }
  const lead = primaryFile(open[0].location);
  const sameFile = open.filter((f) => primaryFile(f.location) === lead);
  const batch = (sameFile.length >= 2 ? sameFile : open).slice(0, size);
  console.log(`# Batch: ${batch.map((f) => f.id).join(', ')} (${open.length} open)\n`);
  for (const row of batch) console.log(`${row.body}\n`);
}

/** Argv minus the command, every `--flag` and each flag's value — so `--run`/`--note` may sit anywhere. */
function positionals(argv) {
  const out = [];
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) i += 1;
    else out.push(argv[i]);
  }
  return out;
}

function cmdSet(root, reportFile, argv) {
  const [id, status] = positionals(argv);
  if (!id || !STATUSES.includes(status)) {
    throw new Error(`Usage: status.mjs set <A-n> <${STATUSES.join('|')}> [--note "..."]`);
  }
  const report = loadReport(reportFile);
  const finding = parseFindings(report).find((f) => f.id === id);
  if (!finding) throw new Error(`${id} is not in ${path.relative(root, report.file).split(path.sep).join('/')}.`);
  // A note given now replaces the old one; omitting --note keeps whatever the line already carried.
  const note = flag(argv, '--note') ?? finding.note;
  const text = statusLine(status, note.replace(/\r?\n/g, ' ').trim());
  if (finding.statusLine === null) writeReport(report, { insertAfter: new Map([[finding.anchor, text]]) });
  else writeReport(report, { replace: new Map([[finding.statusLine, text]]) });
  const { counts } = refreshCounts(reportFile);
  console.log(`${id} -> ${status}. Remaining open: ${counts.open}.`);
}

function main() {
  const root = repoRoot();
  const argv = process.argv.slice(2);
  const reportFile = resolveReport(root, argv);
  const command = argv[0];
  if (command === 'init') return cmdInit(root, reportFile);
  if (command === 'list') return cmdList(root, reportFile, argv);
  if (command === 'batch') return cmdBatch(root, reportFile, argv);
  if (command === 'set') return cmdSet(root, reportFile, argv);
  throw new Error('Usage: status.mjs <init|list|batch|set> [...]');
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
