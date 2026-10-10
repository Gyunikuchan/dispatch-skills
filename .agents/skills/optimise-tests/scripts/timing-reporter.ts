// `node --test` reporter for inventory.ts: writes one JSON line per test result, the coverage summary,
// and the run summary to the path in OPTIMISE_TESTS_OUT. Yields one short status line for the console.

import fs from 'node:fs';
import path from 'node:path';

type Data = Record<string, unknown>;
export interface ReporterEvent { type: string; data?: Data }

export interface TestLine { kind: 'test'; status: 'pass' | 'fail'; file: string; name: string; nesting: number; line: number; durationMs: number; suite: boolean }
export interface CoverageLine { kind: 'coverage'; files: { path: string; covered: number; total: number }[] }
export interface SummaryLine { kind: 'summary'; durationMs: number }
export type EventLine = TestLine | CoverageLine | SummaryLine;

const record = (value: unknown): Data => (typeof value === 'object' && value !== null ? value as Data : {});
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

// SECTION: Event mapping

export function toLine(type: string, data: Data): EventLine | undefined {
  if (type === 'test:pass' || type === 'test:fail') {
    const details = record(data['details']);
    if (typeof data['file'] !== 'string') return undefined;
    return {
      kind: 'test', status: type === 'test:pass' ? 'pass' : 'fail', file: data['file'], name: String(data['name'] ?? ''),
      nesting: num(data['nesting']), line: num(data['line']), durationMs: num(details['duration_ms']), suite: details['type'] === 'suite',
    };
  }
  if (type === 'test:coverage') {
    const files = record(data['summary'])['files'];
    if (!Array.isArray(files)) return undefined;
    return {
      kind: 'coverage',
      files: files.map((file) => record(file)).map((file) => ({ path: String(file['path']), covered: num(file['coveredLineCount']), total: num(file['totalLineCount']) })),
    };
  }
  // NOTE: only the run-level summary has no file; per-file summaries are skipped.
  if (type === 'test:summary' && data['file'] === undefined) return { kind: 'summary', durationMs: num(data['duration_ms']) };
  return undefined;
}

// SECTION: Reporter flow

export default async function* timingReporter(source: AsyncIterable<ReporterEvent>): AsyncGenerator<string> {
  const out = process.env['OPTIMISE_TESTS_OUT'];
  if (!out) throw new Error('timing-reporter: set OPTIMISE_TESTS_OUT to the events output path');
  const lines: string[] = [];
  let passed = 0;
  let failed = 0;
  for await (const { type, data = {} } of source) {
    const line = toLine(type, data);
    if (!line) continue;
    if (line.kind === 'test' && !line.suite) {
      if (line.status === 'pass') passed++;
      else failed++;
    }
    lines.push(JSON.stringify(line));
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.length ? `${lines.join('\n')}\n` : '');
  yield `optimise-tests: ${passed} passed, ${failed} failed\n`;
}
