// @ts-check
/**
 * @file test-reporter.mjs
 * @description Quiet test reporter for Node.js test runner (node --test).
 * Silences all passing test output to preserve agent context windows.
 * Outputs concise summary on success, or full actionable diagnostics on failure.
 * Names the slowest files when one crosses SLOW_FILE_MS, since one serial file bounds the wall time.
 */

import path from 'node:path';

const SLOW_FILE_MS = 10_000;

/**
 * Format duration in milliseconds to human-readable string.
 *
 * @param {number} [ms=0]
 * @returns {string}
 */
export function formatDuration(ms = 0) {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Formats a failure event into a clear, actionable string for display.
 *
 * @param {Record<string, any>} eventData
 * @param {string} [projectRoot=process.cwd()]
 * @returns {string}
 */
export function formatFailure(eventData, projectRoot = process.cwd()) {
  const name = eventData.name || 'unnamed test';
  const rawFile = eventData.file || '';
  const relFile = rawFile ? path.relative(projectRoot, rawFile).replace(/\\/g, '/') : '';
  const line = eventData.line;
  const col = eventData.column;

  let location = relFile;
  if (line !== undefined) {
    location += `:${line}`;
    if (col !== undefined) {
      location += `:${col}`;
    }
  }

  const lines = [`✖ ${name}`];
  if (location) {
    lines.push(`  Location: ${location}`);
  }

  const details = eventData.details || {};
  const error = details.error || eventData.error;

  if (error) {
    // If wrapped in ERR_TEST_FAILURE with cause, prefer cause for details
    const cause = error.cause;
    const isAssertion = cause?.code === 'ERR_ASSERTION' || error.code === 'ERR_ASSERTION';

    if (cause && typeof cause === 'object' && cause.message) {
      lines.push(`  ${cause.stack || cause.message}`);
    } else if (error.stack) {
      lines.push(`  ${error.stack}`);
    } else if (error.message) {
      lines.push(`  Error: ${error.message}`);
    }

    if (isAssertion && cause && (cause.actual !== undefined || cause.expected !== undefined)) {
      if (cause.operator) {
        lines.push(`  Operator: ${cause.operator}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Formats the slowest files when any crosses SLOW_FILE_MS, or returns an empty string.
 *
 * @param {Map<string, number>} fileDurations Summed top-level test durations per file
 * @param {string} [projectRoot=process.cwd()]
 * @returns {string}
 */
export function formatSlowFiles(fileDurations, projectRoot = process.cwd()) {
  const slowest = [...fileDurations].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (!slowest.length || slowest[0][1] < SLOW_FILE_MS) return '';
  const entries = slowest.map(([file, ms]) => `${path.relative(projectRoot, file).replace(/\\/g, '/')} ${formatDuration(ms)}`);
  return `  Slowest files: ${entries.join(', ')}
`;
}

/**
 * Node.js test reporter generator.
 *
 * @param {AsyncIterable<Record<string, any>>} source Stream of test events
 * @returns {AsyncGenerator<string>}
 */
export default async function* quietReporter(source) {
  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;
  let skippedTests = 0;
  let todoTests = 0;
  let totalSuites = 0;
  let totalDurationMs = 0;
  const failures = [];
  const files = new Set();
  const fileDurations = new Map();

  for await (const event of source) {
    const { type, data } = event;

    if (data?.file) {
      files.add(data.file);
    }

    // NOTE: A file's top-level tests run serially, so their summed durations approximate the file's wall time.
    if ((type === 'test:pass' || type === 'test:fail') && data?.file && (data.nesting ?? 0) === 0) {
      fileDurations.set(data.file, (fileDurations.get(data.file) ?? 0) + (data.details?.duration_ms ?? 0));
    }

    switch (type) {
      case 'test:pass': {
        if (data?.details?.type !== 'suite') {
          passedTests++;
          totalTests++;
        }
        break;
      }
      case 'test:fail': {
        const isSubtestFailure =
          data?.details?.type === 'suite' &&
          (data?.details?.error?.failureType === 'subtestsFailed' ||
            data?.details?.error?.message === '1 subtest failed');

        // Only record if it's an actual test failure or a direct suite/hook error
        if (!isSubtestFailure) {
          failedTests++;
          totalTests++;
          failures.push(data);
        }
        break;
      }
      case 'test:summary': {
        if (data?.counts) {
          const counts = data.counts;
          if (counts.topLevel !== undefined || data.file === undefined) {
            // Global summary event
            if (counts.passed !== undefined) passedTests = counts.passed;
            else if (counts.pass !== undefined) passedTests = counts.pass;

            if (counts.failed !== undefined) failedTests = counts.failed;
            else if (counts.fail !== undefined) failedTests = counts.fail;

            if (counts.tests !== undefined) totalTests = counts.tests;
            if (counts.skipped !== undefined) skippedTests = counts.skipped;
            if (counts.todo !== undefined) todoTests = counts.todo;
            if (counts.suites !== undefined) totalSuites = counts.suites;
          }
        }
        if (data?.duration_ms !== undefined) {
          totalDurationMs = Math.max(totalDurationMs, data.duration_ms);
        }
        break;
      }
      default:
        break;
    }
  }

  // If there are failures, output full details
  if (failures.length > 0) {
    yield '\n--- Test Failures ---\n\n';
    for (const fail of failures) {
      yield formatFailure(fail);
      yield '\n';
    }
    const fileCountStr = files.size > 0 ? ` across ${files.size} file(s)` : '';
    yield `✖ ${failedTests} of ${totalTests} test(s) failed (${passedTests} passed, ${formatDuration(totalDurationMs)}${fileCountStr})\n`;
  } else {
    // Clean, quiet summary on success
    const skippedStr = skippedTests > 0 ? `, ${skippedTests} skipped` : '';
    const todoStr = todoTests > 0 ? `, ${todoTests} todo` : '';
    const fileCountStr = files.size > 0 ? ` across ${files.size} file(s)` : '';
    yield `✔ All ${totalTests || passedTests} test(s) passed (${formatDuration(totalDurationMs)}${fileCountStr}${skippedStr}${todoStr})\n`;
  }
  const slowFiles = formatSlowFiles(fileDurations);
  if (slowFiles) yield slowFiles;
}
