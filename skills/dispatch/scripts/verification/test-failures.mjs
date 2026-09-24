// @ts-check
/**
 * Deterministic failure identities from test-runner output, so verification never depends on an
 * orchestrator re-reading logs. Recognizes the Node test runner's spec and TAP reporters and the
 * repository's quiet reporter (`✖ <name>` + `Location:`). Identifiers follow the RED-MATRIX
 * convention: `test:<leaf test name>`, or `error:load <test file>` when a file fails to load.
 */

import path from 'node:path';

const DURATION = /\s+\(\d+(?:\.\d+)?m?s\)\s*$/;
const TEST_FILE = /\.(?:[cm]?[jt]s|tsx?)$/;
const ANSI = /\u001b\[[0-9;]*m/g;

function leafIdentifier(name, repoRoot) {
  const trimmed = name.trim();
  // A file-level failure is named after the file: the file never reached its own tests.
  if (TEST_FILE.test(trimmed) && !/\s/.test(trimmed)) {
    const relative = repoRoot && path.isAbsolute(trimmed) ? path.relative(repoRoot, trimmed) : trimmed;
    return `error:load ${relative.split(path.sep).join('/').replace(/^\.\//, '')}`;
  }
  return `test:${trimmed}`;
}

// Spec reporter: the trailing "failing tests:" section lists leaves only, each after "test at <loc>".
function specFailingSection(lines) {
  const start = lines.findIndex(line => /^✖ failing tests:\s*$/.test(line));
  if (start === -1) return null;
  const names = [];
  for (let index = start + 1; index < lines.length; index++) {
    if (!/^test at \S/.test(lines[index])) continue;
    const next = lines[index + 1] ?? '';
    const match = /^✖ (.+)$/.exec(next);
    if (match) names.push(match[1].replace(DURATION, ''));
  }
  return names;
}

// Quiet reporter: "✖ <name>" immediately followed by "  Location: <file:line:col>".
function quietFailures(lines) {
  const names = [];
  for (let index = 0; index < lines.length - 1; index++) {
    const match = /^✖ (.+)$/.exec(lines[index]);
    if (match && /^\s+Location:\s/.test(lines[index + 1])) names.push(match[1]);
  }
  return names;
}

// TAP (names escape `\` and `#`): "not ok N - <name>" whose YAML block does not mark a parent (subtestsFailed).
function tapFailures(lines) {
  const names = [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^\s*not ok \d+ - (.+?)(?:\s+#\s+(?:SKIP|TODO)\b.*)?$/.exec(lines[index]);
    if (!match) continue;
    let parent = false;
    for (let cursor = index + 1; cursor < lines.length && !/^\s*\.\.\.\s*$/.test(lines[cursor]); cursor++) {
      if (/^\s*(?:not )?ok \d+ - /.test(lines[cursor])) break;
      if (/failureType:\s*'subtestsFailed'/.test(lines[cursor])) { parent = true; break; }
    }
    if (!parent) names.push(match[1].replace(/\\([\\#])/g, '$1'));
  }
  return names;
}

// Spec reporter without a failing-tests section: "✖ name (dur)" lines minus suites ("▶ name").
function specInline(lines) {
  const suites = new Set(lines.map(line => /^\s*▶ (.+)$/.exec(line)?.[1].trim()).filter(Boolean));
  return lines.map(line => /^\s*✖ (.+\(\d+(?:\.\d+)?m?s\))\s*$/.exec(line)?.[1].replace(DURATION, '').trim())
    .filter(name => name && !suites.has(name));
}

/**
 * Sorted unique failure identifiers found in `output`; empty when none are recognizable.
 *
 * @param {any} output
 * @param {{ repoRoot?: any }} [options]
 */
export function extractFailureIdentifiers(output, { repoRoot = null } = {}) {
  const lines = String(output ?? '').replace(ANSI, '').split(/\r?\n/);
  const names = specFailingSection(lines) ?? [];
  if (!names.length) names.push(...quietFailures(lines));
  if (!names.length) names.push(...tapFailures(lines));
  if (!names.length) names.push(...specInline(lines));
  return [...new Set(names.map(name => leafIdentifier(name, repoRoot)))].sort();
}

/** Pass/fail counts from the spec, TAP, or quiet reporter summary; null when absent. */
export function testCounts(output) {
  const text = String(output ?? '').replace(ANSI, '');
  const quietFail = /✖ (\d+) of (\d+) test\(s\) failed \((\d+) passed/.exec(text);
  if (quietFail) return { pass: Number(quietFail[3]), fail: Number(quietFail[1]) };
  const quietPass = /✔ All (\d+) test\(s\) passed/.exec(text);
  if (quietPass) return { pass: Number(quietPass[1]), fail: 0 };
  const pass = /^(?:ℹ|#) pass (\d+)\s*$/m.exec(text), fail = /^(?:ℹ|#) fail (\d+)\s*$/m.exec(text);
  return pass && fail ? { pass: Number(pass[1]), fail: Number(fail[1]) } : null;
}
