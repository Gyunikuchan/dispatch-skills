#!/usr/bin/env node
// @ts-check

// The report owns remediation state; Dispatch plans and reviews provide linked evidence.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const STATUSES = ['open', 'fixed', 'false-positive', 'decision', 'deferred'];
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'nit'];
export const PHASES = ['planned', 'plan-reviewed', 'implemented', 'code-reviewed'];
export const DEFAULT_BATCH_SIZE = 4;
export const MAX_SAFE_BATCH_SIZE = 25;
export const COUNTS_PREFIX = '> Fix status:';
export const OPPORTUNITY_COUNTS_PREFIX = '> Opportunity status:';
export const EMPTY_FINDINGS_SENTINEL = 'No defect findings.';
export const KNOWN_FLAGS = ['--run', '--status', '--severity', '--kind', '--full', '--size', '--note', '--from'];
const ITEM_ID = /^[AO]-[1-9]\d*$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRIORITIES = ['high', 'medium', 'low'];

export const toPosix = (value) => value.split(path.sep).join('/');
const nonblank = (value) => typeof value === 'string' && value.trim().length > 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// SECTION: CLI and paths

function repoRoot() {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Run from inside the dispatch-skills repository.');
  return path.resolve(result.stdout.trim());
}
function flag(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Flag ${name} requires a value.`);
  return value;
}
export function positionals(argv) {
  const result = [];
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--full') continue;
    if (argv[i].startsWith('--')) i += 1;
    else result.push(argv[i]);
  }
  return result;
}
function resolveReport(root, argv) {
  const auditDir = path.join(root, '.scratch', 'audits');
  const run = flag(argv, '--run');
  if (run) {
    const file = /^\d{4}-\d{2}-\d{2}-\d{4}$/.test(run)
      ? path.join(auditDir, `${run}-audit.md`) : path.resolve(root, run);
    if (!fs.existsSync(file)) throw new Error(`No audit report at ${run}`);
    return file;
  }
  const names = fs.existsSync(auditDir) ? fs.readdirSync(auditDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}-\d{4}-audit\.md$/.test(name)).sort() : [];
  if (!names.length) throw new Error('No audit report under .scratch/audits/ — run audit-dispatch-skills first.');
  return path.join(auditDir, names.at(-1));
}
function relativePath(value, label) {
  if (!nonblank(value) || value.includes('\\') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
    || value.split('/').some((part) => part === '..' || part === '.' || part === '') || value.includes(':')) {
    throw new Error(`${label}: require a forward-slash repository-relative path without traversal.`);
  }
  return value;
}
function evidenceFile(root, value, label) {
  relativePath(value, label);
  const target = path.resolve(root, value);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`${label}: evidence file does not exist: ${value}`);
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(target));
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`${label}: evidence path resolves outside the repository.`);
  }
}
function inputJson(root, argv) {
  const file = flag(argv, '--from');
  if (!file) throw new Error('Require --from <json-file>.');
  return JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'));
}

// SECTION: Report parsing

function section(lines, heading, required = true) {
  const starts = lines.flatMap((line, index) => line.trimEnd() === heading ? [index] : []);
  if (starts.length !== 1) {
    if (!required && starts.length === 0) return null;
    throw new Error(`Expected one "${heading}" section.`);
  }
  const start = starts[0];
  const next = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return { start, end: next === -1 ? lines.length : next };
}
export function loadReport(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  return { file, text, lines, ...section(lines, '## 3. Findings') };
}
function metadata(block, label, offset) {
  const matches = block.flatMap((line, index) => line.startsWith(`- **${label}**:`) ? [{ line: offset + index, text: line.slice(`- **${label}**:`.length).trim() }] : []);
  if (matches.length > 1) throw new Error(`Duplicate ${label} line at ${offset + 1}.`);
  return matches[0] ?? null;
}
function readJson(meta, label) {
  if (!meta) return null;
  try { return JSON.parse(meta.text); } catch { throw new Error(`Malformed ${label} JSON at line ${meta.line + 1}.`); }
}
function strings(value, label) {
  if (!Array.isArray(value) || !value.every(nonblank) || new Set(value).size !== value.length) {
    throw new Error(`${label}: require an array of distinct nonblank strings.`);
  }
}
function keys(value, allowed, label) {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label}: invalid fields.`);
}
function validateTriage(value, item) {
  keys(value, ['ruling', 'evidence', 'impact', 'recommendation', 'group', 'priority', 'affectedPaths', 'dependsOn', 'verification', 'selection', 'legacyInspection'], `${item.id} Triage`);
  if (!['accept', 'reject', 'decision', 'defer'].includes(value.ruling)) throw new Error(`${item.id} Triage ruling is invalid.`);
  for (const key of ['evidence', 'impact', 'recommendation']) if (!nonblank(value[key])) throw new Error(`${item.id} Triage ${key} must be nonblank.`);
  for (const key of ['affectedPaths', 'dependsOn', 'verification']) strings(value[key], `${item.id} ${key}`);
  value.affectedPaths.forEach((p) => relativePath(p, `${item.id} affectedPaths`));
  if (value.dependsOn.some((id) => !ITEM_ID.test(id) || id === item.id)) throw new Error(`${item.id} invalid dependency.`);
  if (value.selection !== undefined) {
    keys(value.selection, ['by', 'quote'], `${item.id} selection`);
    if (value.selection.by !== 'user' || !nonblank(value.selection.quote)) throw new Error(`${item.id} selection requires actual user quote.`);
  }
  if (value.legacyInspection !== undefined && !nonblank(value.legacyInspection)) throw new Error(`${item.id} legacyInspection must be nonblank.`);
  if (/^dispatched\b/.test(item.note) && !nonblank(value.legacyInspection)) throw new Error(`${item.id} requires legacyInspection before repeat work.`);
  if (value.ruling === 'accept') {
    if (!nonblank(value.group) || !SLUG.test(value.group)) throw new Error(`${item.id} accepted triage requires a group slug.`);
    if (!PRIORITIES.includes(value.priority)) throw new Error(`${item.id} accepted triage requires priority high|medium|low.`);
    if (!value.affectedPaths.length || !value.verification.length) throw new Error(`${item.id} accepted triage requires affectedPaths and verification.`);
    if (item.kind === 'opportunity' && !value.selection) throw new Error(`${item.id} opportunity requires explicit user selection.`);
  }
}
function validateExecution(value, label) {
  keys(value, ['batchId', 'phase', 'members', 'plan', 'planReview', 'implementation', 'codeReview', 'evidence'], label);
  if (!nonblank(value.batchId) || !SLUG.test(value.batchId)) throw new Error(`${label}: invalid batchId.`);
  if (![...PHASES, 'abandoned'].includes(value.phase) || !nonblank(value.evidence)) throw new Error(`${label}: require phase and evidence.`);
  strings(value.members, `${label} members`);
  if (!value.members.length || value.members.some((id) => !ITEM_ID.test(id))) throw new Error(`${label}: invalid members.`);
  relativePath(value.plan, `${label} plan`);
  for (const key of ['planReview', 'implementation', 'codeReview']) if (value[key] !== undefined) relativePath(value[key], `${label} ${key}`);
  const index = PHASES.indexOf(value.phase);
  for (const [at, key] of [[1, 'planReview'], [2, 'implementation'], [3, 'codeReview']]) {
    if (index >= at && !nonblank(value[key])) throw new Error(`${label}: ${key} is required.`);
  }
}
function parseSection(report, range, kind) {
  if (!range) return [];
  const headings = [], prefix = kind === 'defect' ? 'A' : 'O';
  let sentinel = false;
  for (let line = range.start + 1; line < range.end; line += 1) {
    const text = report.lines[line];
    if (/^#{1,6} [AO]-/.test(text)) {
      const match = /^#### ([AO]-[1-9]\d*):\s*(.+)$/.exec(text);
      if (!match || !match[1].startsWith(prefix)) throw new Error(`${kind} section contains malformed or misplaced opportunity/finding heading at line ${line + 1}.`);
      headings.push({ id: match[1], title: match[2], line });
    }
    if (text.trim() === EMPTY_FINDINGS_SENTINEL) sentinel = true;
  }
  if (kind === 'defect' && sentinel && headings.length) throw new Error('Findings section mixes sentinel with findings.');
  if (!headings.length) {
    const allowed = report.lines.slice(range.start + 1, range.end).filter((line) => line.trim()
      && !(kind === 'defect' && line.trim() === EMPTY_FINDINGS_SENTINEL)
      && !line.startsWith(kind === 'defect' ? COUNTS_PREFIX : OPPORTUNITY_COUNTS_PREFIX));
    if (kind === 'defect' && (!sentinel || allowed.length)) throw new Error(`Findings yielded no findings — expected headings or only "${EMPTY_FINDINGS_SENTINEL}".`);
    if (kind === 'opportunity' && allowed.some((line) => line.trim() !== 'None.')) throw new Error('Opportunities section has unreadable non-item content.');
    return [];
  }
  return headings.map((heading, index) => {
    const end = headings[index + 1]?.line ?? range.end;
    const block = report.lines.slice(heading.line, end);
    while (block.length > 1 && /^(#{1,3} |-{3,}\s*$|\s*$)/.test(block.at(-1))) block.pop();
    const meta = block.find((line) => /^- \*\*(\w+)\*\*\s*·/.test(line));
    const severity = kind === 'defect' ? /^- \*\*(\w+)\*\*\s*·\s*[^·]+·\s*[^·]+·/.exec(meta ?? '')?.[1].toLowerCase() : null;
    if (kind === 'defect' && !SEVERITIES.includes(severity)) throw new Error(`${heading.id}: unreadable severity line.`);
    const fields = {};
    for (const key of ['Status', 'Triage', 'Execution', 'Execution history']) fields[key] = metadata(block, key, heading.line);
    const state = fields.Status ? /^([\w-]+)(?:\s*[—–-]\s*(.*))?$/.exec(fields.Status.text) : null;
    if (fields.Status && (!state || !STATUSES.includes(state[1]))) throw new Error(`${heading.id}: Unknown status.`);
    const item = {
      id: heading.id, title: heading.title, kind, severity,
      anchor: kind === 'defect' ? heading.line + block.indexOf(meta) : heading.line,
      location: metadata(block, 'Location', heading.line)?.text ?? '',
      status: state?.[1] ?? (kind === 'defect' ? 'open' : 'decision'), note: state?.[2]?.trim() ?? '',
      fields, body: block.join('\n').trim(), triage: readJson(fields.Triage, 'Triage'),
      execution: readJson(fields.Execution, 'Execution'), history: readJson(fields['Execution history'], 'Execution history') ?? [],
    };
    for (const key of kind === 'defect' ? ['Location', 'Claim', 'Evidence', 'Proposal'] : ['Hypothesis', 'Benefit', 'Cost']) {
      if (!nonblank(metadata(block, key, heading.line)?.text)) throw new Error(`${heading.id}: missing ${key} field.`);
    }
    if (item.triage !== null) validateTriage(item.triage, item);
    if (item.execution !== null) validateExecution(item.execution, `${item.id} Execution`);
    if (!Array.isArray(item.history)) throw new Error(`${item.id}: Execution history must be an array.`);
    item.history.forEach((entry) => validateExecution(entry, `${item.id} Execution history`));
    return item;
  });
}
export const parseFindings = (report) => parseSection(report, report, 'defect');
export function parseItems(report) {
  const items = [...parseFindings(report), ...parseSection(report, section(report.lines, '## 4. Opportunities', false), 'opportunity')];
  const ids = new Set();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`Duplicate item ID ${item.id}.`);
    ids.add(item.id);
  }
  for (const item of items) {
    if (item.triage?.dependsOn.some((id) => !ids.has(id))) throw new Error(`${item.id}: dependency names an unknown item.`);
    if (item.execution && (!item.execution.members.includes(item.id) || item.execution.members.some((id) => !ids.has(id)))) throw new Error(`${item.id}: Execution members mismatch.`);
    if (item.execution && item.execution.members.some((id) => !same(items.find((other) => other.id === id)?.execution, item.execution))) throw new Error(`${item.id}: Execution membership/phase mismatch.`);
  }
  return items;
}
export function primaryFile(location) { return /`([^`:]+)/.exec(location)?.[1] ?? '(unlocated)'; }
export function severityRank(severity) { const rank = SEVERITIES.indexOf(severity); return rank < 0 ? SEVERITIES.length : rank; }
export function ranked(items) {
  const rank = (item) => item.kind === 'defect' ? severityRank(item.severity) : SEVERITIES.length + PRIORITIES.indexOf(item.triage?.priority ?? 'low');
  return [...items].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id, 'en', { numeric: true }));
}

// SECTION: Validated report mutation

export const statusLine = (state, note) => `- **Status**: ${state}${note ? ` — ${note}` : ''}`;
function setFields(report, updates) {
  const replace = new Map(), insertAfter = new Map();
  for (const [item, fields] of updates) {
    const inserts = [];
    for (const [key, value] of Object.entries(fields)) {
      const current = item.fields[key];
      const text = value === null ? null : `- **${key}**: ${typeof value === 'string' ? value : JSON.stringify(value)}`;
      if (current) replace.set(current.line, text);
      else if (text !== null) inserts.push(text);
    }
    if (inserts.length) insertAfter.set(item.anchor, inserts);
  }
  return report.lines.flatMap((line, index) => [
    ...(replace.has(index) ? (replace.get(index) === null ? [] : [replace.get(index)]) : [line]),
    ...(insertAfter.get(index) ?? []),
  ]);
}
function withCounts(report) {
  const items = parseItems(report), lines = [...report.lines];
  for (const [heading, kind, prefix] of [['## 4. Opportunities', 'opportunity', OPPORTUNITY_COUNTS_PREFIX], ['## 3. Findings', 'defect', COUNTS_PREFIX]]) {
    const range = section(lines, heading, false);
    if (!range) continue;
    const counts = Object.fromEntries(STATUSES.map((state) => [state, items.filter((item) => item.kind === kind && item.status === state).length]));
    const total = items.filter((item) => item.kind === kind).length;
    const banner = `${prefix} ${STATUSES.map((state) => `${state} ${counts[state]}`).join(', ')} (total ${total}).`;
    const limit = lines.findIndex((line, index) => index > range.start && index < range.end && /^#{1,4} /.test(line));
    const existing = [];
    for (let i = range.start + 1; i < (limit < 0 ? range.end : limit); i += 1) if (lines[i].startsWith(prefix)) existing.push(i);
    if (existing.length) {
      lines[existing[0]] = banner;
      existing.slice(1).reverse().forEach((index) => lines.splice(index, 1));
    } else lines.splice(range.start + 1, 0, '', banner);
  }
  return lines;
}
function commit(report, updates = []) {
  const lines = setFields(report, updates);
  const pending = { ...report, lines, ...section(lines, '## 3. Findings') };
  const next = withCounts(pending).join(report.text.includes('\r\n') ? '\r\n' : '\n');
  if (fs.readFileSync(report.file, 'utf8') !== report.text) throw new Error('Report changed concurrently; reload before retrying.');
  const temporary = `${report.file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, next, 'utf8'); fs.renameSync(temporary, report.file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function refreshCounts(file) {
  const report = loadReport(file), items = parseItems(report);
  commit(report);
  return { counts: Object.fromEntries(STATUSES.map((state) => [state, items.filter((item) => item.kind === 'defect' && item.status === state).length])), total: items.filter((item) => item.kind === 'defect').length };
}

// SECTION: Triage and dependency-safe batching

function ready(item) { return item.status === 'open' && item.triage?.ruling === 'accept'; }
function rulingStatus(item, ruling) { return ruling === 'accept' ? 'open' : ruling === 'reject' ? (item.kind === 'defect' ? 'false-positive' : 'deferred') : ruling === 'defer' ? 'deferred' : 'decision'; }
function groupBatch(items, group, size) {
  const members = ranked(items.filter((item) => item.status === 'open' && item.triage?.group === group));
  if (members.some((item) => !ready(item))) throw new Error(`${group}: untriaged or unresolved member.`);
  if (members.length > size) throw new Error(`${group}: group exceeds batch ceiling ${size}.`);
  const result = [], remaining = [...members];
  while (remaining.length) {
    const next = remaining.find((item) => item.triage.dependsOn.every((id) => items.find((other) => other.id === id)?.status === 'fixed' || result.some((other) => other.id === id)));
    if (!next) {
      const external = remaining.flatMap((item) => item.triage.dependsOn.filter((id) => !members.some((member) => member.id === id) && items.find((other) => other.id === id)?.status !== 'fixed').map((id) => `${item.id} depends on ${id}`));
      throw new Error(`${group}: ${external.length ? external.join('; ') : 'dependency cycle'}.`);
    }
    result.push(next); remaining.splice(remaining.indexOf(next), 1);
  }
  return result;
}
function batchSize(argv) {
  const raw = flag(argv, '--size');
  const size = raw === null ? DEFAULT_BATCH_SIZE : Number(raw);
  if (!Number.isInteger(size) || size < 1 || size > MAX_SAFE_BATCH_SIZE) throw new Error(`--size requires an integer from 1 to ${MAX_SAFE_BATCH_SIZE}.`);
  return size;
}
export function cmdInit(root, file) {
  const report = loadReport(file), items = parseItems(report);
  commit(report, items.filter((item) => !item.fields.Status).map((item) => [item, { Status: item.status }]));
  console.log(`Report: ${toPosix(path.relative(root, file))}`);
  console.log(`${items.filter((item) => item.kind === 'defect').length} findings, ${items.filter((item) => item.kind === 'opportunity').length} opportunities; statuses preserved.`);
}
export function cmdList(root, file, argv) {
  const items = ranked(parseItems(loadReport(file))), state = flag(argv, '--status'), kind = flag(argv, '--kind');
  const severities = flag(argv, '--severity')?.split(',');
  if (state && !STATUSES.includes(state)) throw new Error('Unknown --status.');
  if (kind && !['defect', 'opportunity'].includes(kind)) throw new Error('Unknown --kind.');
  if (severities?.some((value) => !SEVERITIES.includes(value))) throw new Error('Unknown --severity.');
  const rows = items.filter((item) => (!state || item.status === state) && (!kind || item.kind === kind) && (!severities || severities.includes(item.severity)));
  if (!rows.length) console.log(state === 'open' ? 'No open findings.' : 'No matching items.');
  for (const item of rows) console.log(argv.includes('--full') ? `${item.body}\n`
    : `${item.id}\t${item.kind}\t${item.severity ?? item.triage?.priority ?? 'unranked'}\t${item.status}\t${item.title}`);
  console.error(`${rows.length} of ${items.length} items listed.`);
}
export function cmdTriage(root, file, argv) {
  const report = loadReport(file), items = parseItems(report), [id] = positionals(argv), item = items.find((entry) => entry.id === id);
  if (!item) throw new Error(`Unknown item ${id}.`);
  if (item.status === 'fixed') throw new Error(`${id}: preserve fixed disposition; use a new audit item for new work.`);
  if (item.execution) throw new Error(`${id}: active Execution must be abandoned before re-triage.`);
  const value = inputJson(root, argv); validateTriage(value, item);
  if (value.dependsOn.some((dependency) => !items.some((entry) => entry.id === dependency))) throw new Error(`${id}: unknown dependency.`);
  commit(report, [[item, { Triage: value, Status: statusLine(rulingStatus(item, value.ruling), item.note).slice('- **Status**: '.length) }]]);
  console.log(`${id} -> ${rulingStatus(item, value.ruling)}: ${value.recommendation}`);
}
export function cmdBatch(root, file, argv) {
  const items = ranked(parseItems(loadReport(file))), size = batchSize(argv);
  const active = items.find((item) => item.execution && item.execution.members.some((id) => items.find((other) => other.id === id)?.status !== 'fixed'));
  if (active) {
    const record = active.execution;
    console.log(`Resume ${record.batchId}: ${record.members.join(', ')} — ${record.phase}; plan ${record.plan}`);
    return;
  }
  const seen = new Set();
  for (const item of items.filter(ready)) {
    if (seen.has(item.triage.group)) continue;
    seen.add(item.triage.group);
    try {
      const batch = groupBatch(items, item.triage.group, size);
      console.log(`# Batch: ${batch.map((entry) => entry.id).join(', ')} (group ${item.triage.group}, ceiling ${size})\n`);
      batch.forEach((entry) => console.log(`${entry.body}\n`));
      return;
    } catch (error) { console.log(`Blocked: ${error.message}`); }
  }
  const unsettled = items.filter((item) => item.status === 'open' || item.status === 'decision');
  if (!unsettled.length) console.log('No actionable items.');
  else {
    console.log('No ready batch.');
    const blocked = unsettled.filter(ready), pending = unsettled.filter((item) => !ready(item));
    if (blocked.length) console.log(`Blocked accepted items: ${blocked.map((item) => item.id).join(', ')}.`);
    if (pending.length) console.log(`Needs triage or decision: ${pending.map((item) => item.id).join(', ')}.`);
  }
}

// SECTION: Batch checkpoints and completion

export function cmdProgress(root, file, argv) {
  const report = loadReport(file), items = parseItems(report), [rawIds] = positionals(argv);
  const ids = rawIds?.split(',') ?? [];
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('progress requires distinct comma-separated member IDs.');
  const members = ids.map((id) => {
    const item = items.find((entry) => entry.id === id);
    if (!item) throw new Error(`Unknown member ${id}.`);
    return item;
  });
  const input = inputJson(root, argv);
  keys(input, ['batchId', 'phase', 'plan', 'planReview', 'implementation', 'codeReview', 'evidence'], 'progress');
  const previous = members[0].execution;
  if (members.some((item) => !same(item.execution, previous))) throw new Error('Execution membership/phase mismatch.');
  if (previous && !same([...previous.members].sort(), [...ids].sort())) throw new Error('Batch members must remain identical.');
  if (!previous) {
    if (input.phase !== 'planned') throw new Error('First Execution phase must be planned.');
    if (items.some((item) => item.execution?.members.some((id) => items.find((other) => other.id === id)?.status !== 'fixed'))) throw new Error('Resume or abandon the active batch before starting another.');
    if (members.some((item) => !ready(item)) || new Set(members.map((item) => item.triage.group)).size !== 1) throw new Error('Batch members require accepted triage in one coherent group.');
    const expected = groupBatch(items, members[0].triage.group, MAX_SAFE_BATCH_SIZE).map((item) => item.id).sort();
    if (!same(expected, [...ids].sort())) throw new Error('Batch must include every open group member.');
    if (items.some((item) => item.execution?.batchId === input.batchId || item.history.some((record) => record.batchId === input.batchId))) throw new Error('batchId already exists; use a new batch identity.');
  } else {
    if (input.batchId !== previous.batchId) throw new Error('batchId identity cannot change.');
    for (const key of ['plan', 'planReview', 'implementation', 'codeReview']) if (previous[key] && input[key] && previous[key] !== input[key]) throw new Error(`${key}: preserve prior artifact identity; abandon to revise scope.`);
    const before = PHASES.indexOf(previous.phase), after = PHASES.indexOf(input.phase);
    if (input.phase !== 'abandoned' && after !== before && after !== before + 1) throw new Error('Illegal Execution phase transition.');
    if (input.phase === 'abandoned' && members.every((item) => item.status === 'fixed')) throw new Error('Completed batch cannot be abandoned.');
  }
  const value = { ...previous, ...input, members: previous?.members ?? ids };
  validateExecution(value, 'Execution');
  for (const key of ['plan', 'planReview', 'implementation', 'codeReview']) if (value[key]) evidenceFile(root, value[key], key);
  const fixedIds = members.filter((item) => item.status === 'fixed').map((item) => item.id);
  const updates = members.map((item) => [item, input.phase === 'abandoned'
    ? { Execution: item.status === 'fixed' ? { ...previous, members: fixedIds } : null,
      'Execution history': [...item.history, previous, { ...previous, phase: 'abandoned', evidence: value.evidence }] }
    : { Execution: value }]);
  commit(report, updates);
  console.log(`${value.batchId} -> ${value.phase}: ${value.evidence}`);
}
export function cmdSet(root, file, argv) {
  const report = loadReport(file), items = parseItems(report), [id, state] = positionals(argv), item = items.find((entry) => entry.id === id);
  if (!item || !STATUSES.includes(state)) throw new Error('Usage: set <A-n|O-n> <open|fixed|false-positive|decision|deferred> [--note text].');
  if (item.status === 'fixed' && state !== 'fixed') throw new Error(`${id}: preserve fixed disposition; use a new audit item for new work.`);
  if (state === 'open' && item.triage?.ruling !== 'accept') throw new Error(`${id}: accepted triage and opportunity selection required before open.`);
  if (state === 'fixed') {
    if (item.triage?.ruling !== 'accept' || item.execution?.phase !== 'code-reviewed') throw new Error(`${id}: accepted triage and code-reviewed Execution required before fixed.`);
    for (const key of ['plan', 'planReview', 'implementation', 'codeReview']) evidenceFile(root, item.execution[key], key);
  } else if (item.execution && state !== 'open') throw new Error(`${id}: abandon active Execution before changing its disposition.`);
  if (item.kind === 'opportunity' && state === 'false-positive') throw new Error('Use deferred for a declined/refuted opportunity hypothesis.');
  const note = (flag(argv, '--note') ?? item.note).replace(/\r?\n/g, ' ').trim();
  commit(report, [[item, { Status: statusLine(state, note).slice('- **Status**: '.length) }]]);
  console.log(`${id} -> ${state}.`);
}

// SECTION: Entrypoint

export function isMain(importMetaUrl) {
  if (!process.argv[1] || !importMetaUrl) return false;
  // NOTE: Realpaths keep CLI detection correct through host skill-directory symlinks.
  try { return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(importMetaUrl)); }
  catch { return false; }
}
function main() {
  const argv = process.argv.slice(2);
  for (const value of argv.filter((arg) => arg.startsWith('--'))) if (!KNOWN_FLAGS.includes(value)) throw new Error(`Unknown flag ${value}.`);
  const command = { init: cmdInit, list: cmdList, triage: cmdTriage, batch: cmdBatch, progress: cmdProgress, set: cmdSet }[argv[0]];
  if (!command) throw new Error('Usage: status.mjs <init|list|triage|batch|progress|set> [...]');
  const root = repoRoot(); command(root, resolveReport(root, argv), argv);
}
if (isMain(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
