import fs from "node:fs";
import path from "node:path";

interface Data {
  file?: unknown;
  name?: unknown;
  nesting?: unknown;
  line?: unknown;
  duration_ms?: unknown;
  details?: unknown;
  type?: unknown;
  summary?: unknown;
  files?: unknown;
  path?: unknown;
  coveredLineCount?: unknown;
  totalLineCount?: unknown;
}

export interface ReporterEvent {
  type: string;
  data?: Data;
}

export interface TestLine {
  kind: "test";
  status: "pass" | "fail";
  file: string;
  name: string;
  nesting: number;
  line: number;
  durationMs: number;
  suite: boolean;
}

export interface CoverageLine {
  kind: "coverage";
  files: { path: string; covered: number; total: number }[];
}

export interface SummaryLine {
  kind: "summary";
  durationMs: number;
}

export type EventLine = TestLine | CoverageLine | SummaryLine;

const isData = (value: unknown): value is Data => {
  if (value === null || value === undefined) {
    return false;
  }

  return Object.prototype.toString.call(value) === "[object Object]";
};

const textOf = (value: unknown): value is string =>
  Object.prototype.toString.call(value) === "[object String]";

const num = (data: Data, field: keyof Data) => {
  const value = data[field];

  return Number.isFinite(value) ? Number(value) : 0;
};

export const toLine = (type: string, data: Data) => {
  if (type === "test:pass" || type === "test:fail") {
    const details: Data = isData(data.details) ? data.details : {};

    if (!textOf(data.file)) {
      return null;
    }

    return {
      kind: "test",
      status: type === "test:pass" ? "pass" : "fail",
      file: data.file,
      name: textOf(data.name) ? data.name : "",
      nesting: num(data, "nesting"),
      line: num(data, "line"),
      durationMs: num(details, "duration_ms"),
      suite: details.type === "suite",
    };
  }

  if (type === "test:coverage") {
    const summary: Data = isData(data.summary) ? data.summary : {};
    const { files } = summary;

    if (!Array.isArray(files)) {
      return null;
    }

    return {
      kind: "coverage",
      files: files.map((file) => {
        const raw: unknown = file;
        const entry: Data = isData(raw) ? raw : {};

        return {
          path: textOf(entry.path) ? entry.path : "",
          covered: num(entry, "coveredLineCount"),
          total: num(entry, "totalLineCount"),
        };
      }),
    };
  }

  if (type === "test:summary" && data.file === undefined) {
    return { kind: "summary", durationMs: num(data, "duration_ms") };
  }

  return null;
};

export default async function* timingReporter(
  source: AsyncIterable<ReporterEvent>
) {
  const out = process.env["OPTIMISE_TESTS_OUT"];

  if (out === undefined || out === "") {
    throw new Error(
      "timing-reporter: set OPTIMISE_TESTS_OUT to the events output path"
    );
  }

  const lines: string[] = [];
  let passed = 0;
  let failed = 0;

  for await (const { type, data = {} } of source) {
    const line = toLine(type, data);

    if (line === null) {
      continue;
    }

    if (line.kind === "test" && line.suite === false) {
      if (line.status === "pass") {
        passed += 1;
      } else {
        failed += 1;
      }
    }

    lines.push(JSON.stringify(line));
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.length ? `${lines.join("\n")}\n` : "");
  yield `optimise-tests: ${passed} passed, ${failed} failed\n`;
}
