// Quiet reporter for `node --test` (ported from legacy scripts/test-reporter.mjs, not imported).
// Silences passing output, expands the first failure, lists the slowest files, and fails any file
// outside tests/e2e/ whose top-level tests exceed the per-file budget (spec §15.2).

import path from 'node:path';

export const FILE_BUDGET_MS = 1000;
const SLOW_FILE_LIMIT = 3;

type Data = Record<string, unknown>;
export interface ReporterEvent { type: string; data?: Data }
export interface ReporterOptions {
  stderr?: { write(text: string): unknown };
  exit?: (code: number) => void;
  projectRoot?: string;
}

// SECTION: Formatting

export function formatDuration(ms = 0): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

const rel = (file: string, root: string) => path.relative(root, file).replace(/\\/g, '/');

function record(value: unknown): Data {
  return typeof value === 'object' && value !== null ? value as Data : {};
}

export function formatFailure(data: Data, projectRoot = process.cwd(), expand = true): string {
  const name = typeof data['name'] === 'string' ? data['name'] : 'unnamed test';
  let location = typeof data['file'] === 'string' ? rel(data['file'], projectRoot) : '';
  if (data['line'] !== undefined) location += `:${String(data['line'])}${data['column'] !== undefined ? `:${String(data['column'])}` : ''}`;
  const lines = [`✖ ${name}`];
  if (location) lines.push(`  Location: ${location}`);
  if (expand) {
    const error = record(record(data['details'])['error'] ?? data['error']);
    const cause = record(error['cause']);
    if (typeof cause['message'] === 'string') lines.push(`  ${String(cause['stack'] ?? cause['message'])}`);
    else if (typeof error['stack'] === 'string') lines.push(`  ${error['stack']}`);
    else if (typeof error['message'] === 'string') lines.push(`  Error: ${error['message']}`);
  }
  return `${lines.join('\n')}\n`;
}

export function isE2eFile(file: string): boolean {
  return file.replace(/\\/g, '/').includes('/tests/e2e/');
}

export function slowFiles(fileDurations: ReadonlyMap<string, number>): { slowest: [string, number][]; overBudget: string[] } {
  const slowest = [...fileDurations].sort((a, b) => b[1] - a[1]).slice(0, SLOW_FILE_LIMIT);
  const overBudget = [...fileDurations].filter(([file, ms]) => ms > FILE_BUDGET_MS && !isE2eFile(file)).map(([file]) => file);
  return { slowest, overBudget };
}

// SECTION: Reporter flow

export default async function* quietReporter(source: AsyncIterable<ReporterEvent>, options: ReporterOptions = {}): AsyncGenerator<string> {
  const stderr = options.stderr ?? process.stderr;
  const exit = options.exit ?? ((code: number) => { process.exitCode = code; });
  const root = options.projectRoot ?? process.cwd();
  let total = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let todo = 0;
  let durationMs = 0;
  const failures: Data[] = [];
  const emptyFiles = new Set<string>();
  const files = new Set<string>();
  const fileDurations = new Map<string, number>();

  for await (const { type, data = {} } of source) {
    const file = typeof data['file'] === 'string' ? data['file'] : undefined;
    const details = record(data['details']);
    if (file) files.add(file);
    // NOTE: a file's top-level tests run serially, so their summed durations approximate its wall time.
    if ((type === 'test:pass' || type === 'test:fail') && file && (data['nesting'] ?? 0) === 0) {
      fileDurations.set(file, (fileDurations.get(file) ?? 0) + (typeof details['duration_ms'] === 'number' ? details['duration_ms'] : 0));
    }
    if (type === 'test:pass' && details['type'] !== 'suite') { passed++; total++; }
    if (type === 'test:fail') {
      const error = record(details['error']);
      const subtests = details['type'] === 'suite' && (error['failureType'] === 'subtestsFailed' || error['message'] === '1 subtest failed');
      if (!subtests) failures.push(data);
    }
    if (type === 'test:summary') {
      const counts = record(data['counts']);
      if (file && counts['tests'] === 0) emptyFiles.add(file);
      if (counts['topLevel'] !== undefined || file === undefined) {
        const pick = (...keys: string[]) => keys.map((key) => counts[key]).find((value): value is number => typeof value === 'number');
        passed = pick('passed', 'pass') ?? passed;
        failed = pick('failed', 'fail') ?? failed;
        total = pick('tests') ?? total;
        skipped = pick('skipped') ?? skipped;
        todo = pick('todo') ?? todo;
      }
      if (typeof data['duration_ms'] === 'number') durationMs = Math.max(durationMs, data['duration_ms']);
    }
  }

  const fileCount = files.size ? ` across ${files.size} file(s)` : '';
  if (failures.length) {
    yield '\n--- Test Failures ---\n\n';
    for (const [index, failure] of failures.entries()) yield `${formatFailure(failure, root, index === 0)}\n`;
    yield `✖ ${failed || failures.length} of ${total} test(s) failed (${passed} passed, ${formatDuration(durationMs)}${fileCount})\n`;
  } else if (!emptyFiles.size) {
    yield `✔ All ${total || passed} test(s) passed (${formatDuration(durationMs)}${fileCount}${skipped ? `, ${skipped} skipped` : ''}${todo ? `, ${todo} todo` : ''})\n`;
  }
  if (emptyFiles.size) stderr.write(`✖ Selected no tests: ${[...emptyFiles].map((file) => rel(file, root)).sort().join(', ')}\n`);
  const { slowest, overBudget } = slowFiles(fileDurations);
  if (slowest.length) yield `  Slowest files: ${slowest.map(([file, ms]) => `${rel(file, root)} ${formatDuration(ms)}`).join(', ')}\n`;
  if (overBudget.length) {
    yield `✖ Over the ${formatDuration(FILE_BUDGET_MS)} per-file budget: ${overBudget.map((file) => rel(file, root)).join(', ')}; `
      + 'split the file, remove waits and processes, or move a true end-to-end test under tests/e2e/\n';
  }
  if (failures.length || emptyFiles.size || failed || overBudget.length) exit(1);
}
