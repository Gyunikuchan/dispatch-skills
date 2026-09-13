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
 *   node <skill>/scripts/status.mjs batch [--run <run>] [--batches 5] [--size <n>]
 *   node <skill>/scripts/status.mjs set A-3 fixed [--note "..."] [--run <run>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const STATUSES = ['open', 'fixed', 'false-positive', 'decision', 'deferred'];
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'nit'];
const AUDIT_DIR = '.scratch/audits';
export const COUNTS_PREFIX = '> Fix status:';
export const DEFAULT_MAX_BATCHES = 5;
export const SEVERITY_BATCH_TARGETS = {
  critical: 6,
  high: 8,
  medium: 12,
  low: 20,
  nit: 25,
};
export const MAX_SAFE_BATCH_SIZE = 25;
export const MIN_SAFE_BATCH_SIZE = 4;

// ============================================================================
// SECTION: Paths
// ============================================================================

/** Converts platform path separators to forward slashes. */
export function toPosix(p) {
  return p.split(path.sep).join('/');
}

// NOTE: Duplicates `resolveRepoRoot` in the sibling audit-dispatch-skills' `shared.mjs`, deliberately.
// Importing it would reference another skill by path — which the repo guide forbids — and would make
// this skill fail to load wherever that one is not installed alongside it.
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

export const KNOWN_FLAGS = ['--run', '--status', '--severity', '--full', '--size', '--batches', '--note'];

function flag(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || KNOWN_FLAGS.includes(value)) {
    throw new Error(`Flag ${name} requires a value.`);
  }
  return value;
}

// ============================================================================
// SECTION: Report parsing
// ============================================================================

/**
 * Splits the report into lines plus the half-open line range of `## 3. Findings`, so every edit
 * rewrites one line in place and the rest of the report — summary, appendix — stays byte-identical.
 */
export function loadReport(file) {
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
export function parseFindings(report) {
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
export function primaryFile(location) {
  const match = /`([^`:]+)/.exec(location);
  return match ? match[1] : '(unlocated)';
}

export function severityRank(severity) {
  const index = SEVERITIES.indexOf(severity);
  return index === -1 ? SEVERITIES.length : index;
}

/** Highest severity first, then stable by id, so a batch leads with what matters most. */
export function ranked(findings) {
  return [...findings].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || a.id.localeCompare(b.id, 'en', { numeric: true }),
  );
}

// ============================================================================
// SECTION: Report writing
// ============================================================================

export function statusLine(status, note) {
  return note ? `- **Status**: ${status} — ${note}` : `- **Status**: ${status}`;
}

/**
 * Applies status edits and the counts blockquote to the report. Edits are keyed by absolute line
 * index and inserts are applied last, back to front, so earlier indices stay valid.
 */
export function writeReport(report, { replace = new Map(), insertAfter = new Map() } = {}) {
  const lines = [...report.lines];
  for (const [index, text] of replace) lines[index] = text;
  for (const [index, text] of [...insertAfter].sort((a, b) => b[0] - a[0])) lines.splice(index + 1, 0, text);
  fs.writeFileSync(report.file, lines.join('\n'), 'utf8');
}

/** Rewrites (or inserts) the counts blockquote directly under the `## 3. Findings` heading. */
export function refreshCounts(reportFile) {
  const report = loadReport(reportFile);
  const findings = parseFindings(report);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, findings.filter((f) => f.status === s).length]));
  const text = `${COUNTS_PREFIX} ${STATUSES.map((s) => `${s} ${counts[s]}`).join(', ')} (total ${findings.length}).`;

  const lines = [...report.lines];
  // Search the section preamble — heading to first `###`/`####` — not a fixed line window: prose
  // added under the heading (a legend) pushes the blockquote out of a window, and a second one then
  // gets inserted on every refresh. Stopping at the first heading keeps the search off finding
  // bodies, where a Claim or Evidence line quoting this script's own banner would otherwise be
  // matched and overwritten with the counts text.
  let limit = report.end;
  for (let i = report.start + 1; i < report.end; i += 1) {
    if (/^#{1,4} /.test(lines[i])) {
      limit = i;
      break;
    }
  }
  const existing = [];
  for (let i = report.start + 1; i < limit; i += 1) {
    if (lines[i].startsWith(COUNTS_PREFIX)) existing.push(i);
  }
  if (existing.length > 0) {
    lines[existing[0]] = text;
    // A report already carrying duplicates from the superseded fixed-window search converges back
    // to one line here; rewriting only the first would leave the contradicting ones in place.
    for (let i = existing.length - 1; i > 0; i -= 1) lines.splice(existing[i], 1);
  } else {
    lines.splice(report.start + 1, 0, '', text);
  }
  fs.writeFileSync(report.file, lines.join('\n'), 'utf8');
  return { counts, total: findings.length };
}

// ============================================================================
// SECTION: Commands
// ============================================================================

export function cmdInit(root, reportFile) {
  const report = loadReport(reportFile);
  const findings = parseFindings(report);
  const insertAfter = new Map();
  for (const finding of findings) {
    if (finding.statusLine === null) insertAfter.set(finding.anchor, statusLine('open', ''));
  }
  writeReport(report, { insertAfter });
  const { counts, total } = refreshCounts(reportFile);
  console.log(`Report: ${toPosix(path.relative(root, report.file))}`);
  console.log(`${total} findings (${insertAfter.size} newly marked open) — ${STATUSES.map((s) => `${s} ${counts[s]}`).join(', ')}`);
}

export function cmdList(root, reportFile, argv) {
  const status = flag(argv, '--status');
  const severities = flag(argv, '--severity')?.split(',').map((s) => s.trim());
  const full = argv.includes('--full');
  const all = ranked(parseFindings(loadReport(reportFile)));
  const rows = all.filter(
    (f) => (!status || f.status === status) && (!severities || severities.includes(f.severity)),
  );
  // Mirrors `cmdBatch`: an empty result says so on stdout, so a caller — or a SKILL.md completion
  // check — can test for it. The stderr tally below is always printed and so cannot serve.
  if (rows.length === 0) console.log(status === 'open' ? 'No open findings.' : 'No matching findings.');
  for (const row of rows) {
    if (full) console.log(`${row.body}\n`);
    else console.log(`${row.id}\t${row.severity}\t${row.status}\t${primaryFile(row.location)}\t${row.title}`);
  }
  console.error(`${rows.length} of ${all.length} findings listed.`);
}

/**
 * Composes a batch of `size` open findings: the group sharing the highest-severity finding's file
 * leads, then the rest of the pool in rank order tops it up. `size` is a size, not a ceiling the
 * lead group may silently undercut — a two-finding lead group must not turn `--size 8` into two.
 */
export function selectBatch(open, size) {
  if (open.length === 0) return [];
  const lead = primaryFile(open[0].location);
  const sameFile = open.filter((f) => primaryFile(f.location) === lead);
  // A lone finding in its file is not a group; fall back to plain rank order.
  const batch = (sameFile.length >= 2 ? sameFile : open).slice(0, size);
  if (batch.length < size) {
    const taken = new Set(batch.map((f) => f.id));
    for (const finding of open) {
      if (batch.length >= size) break;
      if (!taken.has(finding.id)) batch.push(finding);
    }
  }
  return batch;
}

/**
 * Resolves batch size: explicit `--size` wins; otherwise sizes dynamically based on the 5-batch
 * target (`ceil(total / batches)`), the lead finding's severity, and the lead-file cluster size.
 *
 * If the lead file has a cluster of findings (>= 2), the batch size expands up to MAX_SAFE_BATCH_SIZE
 * to keep the cluster intact in a single dispatch rather than fragmenting same-file edits.
 */
export function resolveBatchSize(allFindings, openFindings, argv = []) {
  const explicitSize = flag(argv, '--size');
  if (explicitSize !== null) {
    const parsed = Number(explicitSize);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`Invalid --size "${explicitSize}": expected a positive integer.`);
    }
    return parsed;
  }
  const explicitBatches = flag(argv, '--batches');
  let batches = DEFAULT_MAX_BATCHES;
  if (explicitBatches !== null) {
    const parsed = Number(explicitBatches);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`Invalid --batches "${explicitBatches}": expected a positive integer.`);
    }
    batches = parsed;
  }

  const total = allFindings.length;
  if (total === 0 || openFindings.length === 0) return 1;

  // 1. Base dynamic target to complete the report in at most `batches` (default 5) batches.
  // Uses total findings so batch size remains stable across resumptions rather than decaying exponentially.
  const dynamicTarget = Math.ceil(total / batches);

  // 2. Severity-informed target from the lead open finding
  const leadSeverity = openFindings[0].severity;
  const severityTarget = SEVERITY_BATCH_TARGETS[leadSeverity];

  // Bounded by severity target, with a minimum floor of MIN_SAFE_BATCH_SIZE (or total)
  let target = Math.min(dynamicTarget, severityTarget);
  target = Math.max(Math.min(MIN_SAFE_BATCH_SIZE, total), target);

  // 3. Lead-cluster expansion: if the lead file holds a cluster (>= 2), keep the cluster intact
  // rather than slicing same-file edits across multiple dispatches
  const leadFile = primaryFile(openFindings[0].location);
  const leadClusterSize = openFindings.filter((f) => primaryFile(f.location) === leadFile).length;
  if (leadClusterSize >= 2) {
    target = Math.max(target, Math.min(leadClusterSize, MAX_SAFE_BATCH_SIZE));
  }

  return Math.min(target, MAX_SAFE_BATCH_SIZE);
}

/**
 * Prints the next batch of open findings: highest severity first, then grouped by the file they
 * touch, so one batch lands in one area of the tree. Sized dynamically to finish the report in at
 * most 5 batches (or `--batches <n>`), unless overridden with `--size <n>`.
 */
export function cmdBatch(root, reportFile, argv) {
  const all = parseFindings(loadReport(reportFile));
  const open = ranked(all).filter((f) => f.status === 'open');
  if (open.length === 0) {
    console.log('No open findings.');
    return;
  }
  const size = resolveBatchSize(all, open, argv);
  const batch = selectBatch(open, size);
  console.log(`# Batch: ${batch.map((f) => f.id).join(', ')} (${open.length} open, batch size ${size})\n`);
  for (const row of batch) console.log(`${row.body}\n`);
}

/** Argv minus the command, every `--flag` and each flag's value — so `--run`/`--note` may sit anywhere. */
export function positionals(argv) {
  const out = [];
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) i += 1;
    else out.push(argv[i]);
  }
  return out;
}

export function cmdSet(root, reportFile, argv) {
  const [id, status] = positionals(argv);
  if (!id || !STATUSES.includes(status)) {
    throw new Error(`Usage: status.mjs set <A-n> <${STATUSES.join('|')}> [--note "..."]`);
  }
  const report = loadReport(reportFile);
  const finding = parseFindings(report).find((f) => f.id === id);
  if (!finding) throw new Error(`${id} is not in ${toPosix(path.relative(root, report.file))}.`);
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

/**
 * Whether this module is the process entry point, so importing it for tests does not run the CLI.
 * Compares realpaths, not URLs: Node resolves symlinks when computing a module's URL, so a plain
 * `import.meta.url === pathToFileURL(process.argv[1]).href` goes false whenever the script is
 * reached through a symlinked skills directory — and the CLI would exit 0 having done nothing.
 *
 * NOTE: mirrors `isMainModule` in the shipped dispatch skill's `common.mjs` rather than importing
 * it, for the reason recorded above `repoRoot`.
 */
export function isMain(importMetaUrl) {
  if (!process.argv[1] || !importMetaUrl) return false;
  try {
    const entry = path.resolve(process.argv[1]);
    const self = path.resolve(fileURLToPath(importMetaUrl));
    if (entry === self) return true;
    return fs.realpathSync(entry) === fs.realpathSync(self);
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
