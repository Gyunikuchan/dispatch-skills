/**
 * Driver-owned verification runner (`dispatch.mjs --verify --state <file>`). Executes the pending
 * gate's plan-approved commands on the host, one after another, capturing Git state around each,
 * logging output to the session directory, and extracting failure identities deterministically.
 * It writes the gate's results file and prints a compact summary; it never advances run state.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { extractFailureIdentifiers, testCounts } from '../test-failures.mjs';
import { diffRepositoryState } from '../verification-evidence.mjs';
import { bindStateSession, readRunState } from './state.mjs';
import { fingerprint, snapshot } from './verification.mjs';

// A single command beyond this is treated as hung; its partial log stays for inspection.
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const DIAGNOSTIC_TAIL = 2000;
const SUMMARY_IDENTIFIERS = 20;

function execute(command, { cwd, logPath }) {
  const fd = fs.openSync(logPath, 'w', 0o600);
  const env = { ...process.env };
  // NOTE: an inherited NODE_TEST_CONTEXT turns a nested `node --test` into a silent subtest.
  delete env.NODE_TEST_CONTEXT;
  let result;
  try {
    result = spawnSync(command, { cwd, shell: true, env, stdio: ['ignore', fd, fd], timeout: COMMAND_TIMEOUT_MS, windowsHide: true });
  } finally {
    fs.closeSync(fd);
  }
  const output = fs.readFileSync(logPath, 'utf8');
  const timedOut = result.error?.code === 'ETIMEDOUT';
  if (result.error && !timedOut) fs.appendFileSync(logPath, `\n[dispatch verify] spawn failed: ${result.error.message}\n`);
  return { exit: result.status ?? (timedOut ? 124 : 1), timedOut, output };
}

/** Results this gate already recorded, when the tree has not changed since they finished. */
function reusableRecord(state, pending) {
  let record;
  try { record = JSON.parse(fs.readFileSync(pending.resultsPath, 'utf8')); } catch { return null; }
  if (record.token !== pending.token || record.purpose !== pending.purpose || !record.final) return null;
  return diffRepositoryState(record.final, snapshot(state)).changed.length ? null : record;
}

/** Runs the pending driver-run verification of `stateFile`; returns the summary it prints. */
export function runVerification(stateFile) {
  bindStateSession(stateFile);
  const state = readRunState(stateFile);
  const data = state.ordinary, pending = data?.verification;
  if (state.pending?.action !== 'verify' || !pending?.token) throw new Error('No driver-run verification is pending for this state.');
  // A re-emitted gate (e.g. a reply that lacked criterion evidence) keeps its token; an unchanged tree reuses its results.
  const reused = reusableRecord(state, pending);
  if (reused) return summarize(pending, reused, { reused: true });
  const logDir = path.join(path.dirname(state.stateFile), 'verify');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logFor = name => path.join(logDir, `${state.runId}-${pending.purpose}-${pending.token.slice(0, 8)}-${name}.log`);
  let epoch = data.mutationEpoch ?? 0;
  let current = snapshot(state);

  // Plan-declared generators run first at completion, so mapped commands see regenerated outputs.
  const generatedPaths = new Set((pending.generators ?? []).map(item => item.path));
  const generated = [...new Set((pending.generators ?? []).map(item => item.command))].map((command, index) => {
    const logPath = logFor(`generate-${index + 1}`);
    const run = execute(command, { cwd: state.repoRoot, logPath });
    const after = snapshot(state), changed = diffRepositoryState(current, after).changed;
    current = after;
    if (changed.length) epoch++;
    return { command, exit: run.exit, changed, outside: changed.filter(file => !generatedPaths.has(file)), logPath };
  });

  const results = pending.commands.map((command, index) => {
    const ran = pending.substitutions?.[command] ?? command;
    const scopeHash = fingerprint(state, data.scopes?.[command]);
    const logPath = logFor(String(index + 1));
    const run = execute(ran, { cwd: state.repoRoot, logPath });
    const after = snapshot(state), changed = diffRepositoryState(current, after).changed;
    current = after;
    const result = {
      command, ran, exit: run.exit, ...(run.timedOut ? { timedOut: true } : {}), counts: testCounts(run.output),
      identifiers: run.exit === 0 ? [] : extractFailureIdentifiers(run.output, { repoRoot: state.repoRoot }),
      diagnostic: run.exit === 0 ? '' : run.output.slice(-DIAGNOSTIC_TAIL), logPath, scopeHash, mutationEpoch: epoch, changed,
    };
    if (changed.length) epoch++;
    return result;
  });

  const record = { v: 1, token: pending.token, purpose: pending.purpose, results, generated, mutationEpoch: epoch, final: current, finishedAt: new Date().toISOString() };
  const temp = `${pending.resultsPath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  fs.renameSync(temp, pending.resultsPath);
  return summarize(pending, record);
}

function summarize(pending, { results, generated, mutationEpoch }, extra = {}) {
  return {
    purpose: pending.purpose, resultsPath: pending.resultsPath, mutationEpoch, ...extra,
    results: results.map(({ command, ran, exit, timedOut, counts, identifiers, scopeHash, mutationEpoch, changed, logPath }) => ({
      command, ...(ran !== command ? { ran } : {}), exit, ...(timedOut ? { timedOut } : {}), ...(counts ?? {}),
      identifiers: identifiers.slice(0, SUMMARY_IDENTIFIERS), ...(identifiers.length > SUMMARY_IDENTIFIERS ? { moreIdentifiers: identifiers.length - SUMMARY_IDENTIFIERS } : {}),
      scopeHash, mutationEpoch, ...(changed.length ? { changed } : {}), logPath,
    })),
    ...(generated.length ? { generated: generated.map(({ command, exit, changed, outside, logPath }) => ({ command, exit, changed, ...(outside.length ? { outside } : {}), logPath })) } : {}),
    next: 'Call --next on the same state file.',
  };
}
