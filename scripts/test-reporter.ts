// Quiet reporter for `node --test`.
// Silences passing output, expands the first failure, and lists the slowest files.
// A per-file budget overrun outside tests/e2e/ warns but never fails a passing run (spec §15.2): it fails only alongside a test failure.

import path from "node:path";

export const FILE_BUDGET_MS = 1000;
const SLOW_FILE_LIMIT = 5;

// Every `node --test` payload field read here; each stays unvalidated until narrowed at its use.
interface Data {
  name?: unknown;
  file?: unknown;
  line?: unknown;
  column?: unknown;
  nesting?: unknown;
  duration_ms?: unknown;
  details?: unknown;
  counts?: unknown;
  type?: unknown;
  error?: unknown;
  cause?: unknown;
  message?: unknown;
  stack?: unknown;
  failureType?: unknown;
  tests?: unknown;
  topLevel?: unknown;
  passed?: unknown;
  pass?: unknown;
  failed?: unknown;
  fail?: unknown;
  skipped?: unknown;
  todo?: unknown;
}

export interface ReporterEvent {
  type: string;
  data?: Data;
}

export interface ReporterOptions {
  stderr?: { write: (text: string) => void };
  exit?: (code: number) => void;
  projectRoot?: string;
}

// SECTION: Formatting

export const formatDuration = (ms = 0) =>
  ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;

const rel = (file: string, root: string) =>
  path.relative(root, file).replaceAll("\\", "/");

const isData = (value: unknown): value is Data =>
  typeof value === "object" && value !== null;

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number => typeof value === "number";

const record = (value: unknown) => (isData(value) ? value : {});

const asLineColumn = (value: unknown) => {
  let text: string | undefined;

  if (isString(value)) {
    text = value;
  } else if (isNumber(value)) {
    text = String(value);
  }

  return text;
};

export const formatFailure = (
  data: Data,
  projectRoot = process.cwd(),
  expand = true
) => {
  const name = isString(data.name) ? data.name : "unnamed test";

  let location = isString(data.file) ? rel(data.file, projectRoot) : "";

  if (data.line !== undefined) {
    const lineText = asLineColumn(data.line);

    const columnText =
      data.column === undefined ? undefined : asLineColumn(data.column);

    if (lineText !== undefined) {
      location += `:${lineText}${columnText === undefined ? "" : `:${columnText}`}`;
    }
  }

  const lines = [`✖ ${name}`];

  if (location) {
    lines.push(`  Location: ${location}`);
  }

  if (expand) {
    const error = record(record(data.details).error ?? data.error);
    const cause = record(error.cause);

    if (isString(cause.message)) {
      lines.push(`  ${asLineColumn(cause.stack) ?? cause.message}`);
    } else if (isString(error.stack)) {
      lines.push(`  ${error.stack}`);
    } else if (isString(error.message)) {
      lines.push(`  Error: ${error.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
};

export const isE2eFile = (file: string) =>
  file.replaceAll("\\", "/").includes("/tests/e2e/");

export interface SlowFiles {
  slowest: [string, number][];
  overBudget: string[];
}

export const slowFiles = (fileDurations: ReadonlyMap<string, number>) => {
  const slowest = [...fileDurations]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, SLOW_FILE_LIMIT);

  const overBudget = [...fileDurations].flatMap(([file, ms]) =>
    ms > FILE_BUDGET_MS && !isE2eFile(file) ? [file] : []
  );

  return { slowest, overBudget };
};

// SECTION: Reporter flow

interface ReportState {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  durationMs: number;
  failures: Data[];
  emptyFiles: Set<string>;
  files: Set<string>;
  fileDurations: Map<string, number>;
}

const createReportState = () => ({
  total: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  todo: 0,
  durationMs: 0,
  failures: [],
  emptyFiles: new Set<string>(),
  files: new Set<string>(),
  fileDurations: new Map<string, number>(),
});

const observeDurations = (
  state: ReportState,
  type: string,
  file: string | undefined,
  data: Data,
  details: Data
) => {
  // NOTE: a file's top-level tests run serially, so their summed durations approximate its wall time.
  if (
    (type === "test:pass" || type === "test:fail") &&
    file !== undefined &&
    (data.nesting ?? 0) === 0
  ) {
    const increment = isNumber(details.duration_ms) ? details.duration_ms : 0;

    state.fileDurations.set(
      file,
      (state.fileDurations.get(file) ?? 0) + increment
    );
  }
};

const observeOutcome = (
  state: ReportState,
  type: string,
  data: Data,
  details: Data
) => {
  if (type === "test:pass" && details.type !== "suite") {
    state.passed += 1;
    state.total += 1;
  }

  if (type === "test:fail") {
    const error = record(details.error);

    const subtests =
      details.type === "suite" &&
      (error.failureType === "subtestsFailed" ||
        error.message === "1 subtest failed");

    if (!subtests) {
      state.failures.push(data);
    }
  }
};

const observeSummary = (
  state: ReportState,
  data: Data,
  file: string | undefined
) => {
  const counts = record(data.counts);

  if (file !== undefined && counts.tests === 0) {
    state.emptyFiles.add(file);
  }

  if (counts.topLevel !== undefined || file === undefined) {
    const pick = (...keys: (keyof Data)[]) =>
      keys
        .map((key) => counts[key])
        .find((value): value is number => isNumber(value));

    state.passed = pick("passed", "pass") ?? state.passed;
    state.failed = pick("failed", "fail") ?? state.failed;
    state.total = pick("tests") ?? state.total;
    state.skipped = pick("skipped") ?? state.skipped;
    state.todo = pick("todo") ?? state.todo;
  }

  if (isNumber(data.duration_ms)) {
    state.durationMs = Math.max(state.durationMs, data.duration_ms);
  }
};

const observeEvent = (state: ReportState, type: string, data: Data) => {
  const file = isString(data.file) ? data.file : undefined;
  const details = record(data.details);

  if (file !== undefined) {
    state.files.add(file);
  }

  observeDurations(state, type, file, data, details);
  observeOutcome(state, type, data, details);

  if (type === "test:summary") {
    observeSummary(state, data, file);
  }
};

const reportPerformance = function* reportPerformance(
  state: ReportState,
  root: string,
  failedRun: boolean
) {
  const { slowest, overBudget } = slowFiles(state.fileDurations);

  if (slowest.length) {
    yield `  Slowest files: ${slowest.map(([file, ms]) => `${rel(file, root)} ${formatDuration(ms)}`).join(", ")}\n`;
  }

  if (overBudget.length) {
    yield (
      `${failedRun ? "✖" : "⚠"} Over the ${formatDuration(FILE_BUDGET_MS)} per-file budget: ${overBudget.map((file) => rel(file, root)).join(", ")}; ` +
      "split the file, remove waits and processes, or move a true end-to-end test under tests/e2e/\n"
    );
  }
};

const quietReporter = async function* quietReporter(
  source: AsyncIterable<ReporterEvent>,
  options: ReporterOptions = {}
) {
  const stderr = options.stderr ?? process.stderr;

  const exit =
    options.exit ??
    ((code: number) => {
      process.exitCode = code;
    });

  const root = options.projectRoot ?? process.cwd();
  const state: ReportState = createReportState();

  for await (const { type, data = {} } of source) {
    observeEvent(state, type, data);
  }

  const { failures, emptyFiles, files } = state;
  const fileCount = files.size ? ` across ${files.size} file(s)` : "";

  if (failures.length) {
    yield "\n--- Test Failures ---\n\n";

    for (const [index, failure] of failures.entries()) {
      yield `${formatFailure(failure, root, index === 0)}\n`;
    }

    yield `✖ ${state.failed || failures.length} of ${state.total} test(s) failed (${state.passed} passed, ${formatDuration(state.durationMs)}${fileCount})\n`;
  } else if (!emptyFiles.size) {
    yield `✔ All ${state.total || state.passed} test(s) passed (${formatDuration(state.durationMs)}${fileCount}${state.skipped ? `, ${state.skipped} skipped` : ""}${state.todo ? `, ${state.todo} todo` : ""})\n`;
  }

  if (emptyFiles.size) {
    stderr.write(
      `✖ Selected no tests: ${[...emptyFiles]
        .map((file) => rel(file, root))
        .toSorted()
        .join(", ")}\n`
    );
  }

  const failedRun =
    failures.length > 0 || emptyFiles.size > 0 || state.failed > 0;

  yield* reportPerformance(state, root, failedRun);

  // NOTE: the per-file budget is a hint. It fails only with a test failure; a passing run warns.
  if (failedRun) {
    exit(1);
  }
};

export default quietReporter;
