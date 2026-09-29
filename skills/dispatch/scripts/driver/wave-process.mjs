// @ts-check
/**
 * Driver-run review waves. `--drive` starts a wave detached so it can hand early native fallbacks to
 * the host while the wave continues; the next advance waits for that wave before reading its envelope.
 */

import fs from 'node:fs';
import { spawn } from 'node:child_process';

import { runFilePath } from '../lib/session-paths.mjs';

const POLL_MS = 250;

const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));

// Implement runs nest review waves, so the launch action, not run state, names the wave.
/** @param {Record<string, any>} state @param {Record<string, any>} action */
function pidPath(state, action) {
  return runFilePath(state.runId, { round: action.wave.round, kind: 'drive', ext: 'json' });
}

/** @param {string[]} argv */
function outputFile(argv) {
  const index = argv.indexOf('--output-file');
  return index === -1 ? null : argv[index + 1];
}

/** @param {number} pid */
function alive(pid) {
  // EPERM means the process exists under another owner.
  try { process.kill(pid, 0); return true; } catch (error) { return /** @type {any} */ (error).code === 'EPERM'; }
}

/** @param {string|null|undefined} file */
function envelopeWritten(file) {
  if (!file) return false;
  try { return Array.isArray(JSON.parse(fs.readFileSync(file, 'utf8')).targets); } catch { return false; }
}

/** Reads a `--slots-file` NDJSON log and returns only the slots recorded as failed so far. */
/** @param {string} file @returns {Record<string, any>[]} */
export function readFailedSlots(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  // A trailing line may be mid-append while the wave runs.
  return text.split('\n').flatMap(line => { try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; } }).filter(record => record.status !== 'ok');
}

/**
 * Starts argv detached with its output in `logPath` and records its pid for a later advance.
 * `exited` settles with the exit status while this process still owns the child; `detach` lets this
 * process exit first.
 *
 * @param {Record<string, any>} state @param {Record<string, any>} action @param {string} logPath
 */
export function startWave(state, action, logPath) {
  const { argv } = action;
  const fd = fs.openSync(logPath, 'w', 0o600);
  let child;
  try {
    child = spawn(argv[0], argv.slice(1), { cwd: state.repoRoot ?? process.cwd(), stdio: ['ignore', fd, fd], detached: true, windowsHide: true });
  } finally {
    fs.closeSync(fd);
  }
  /** @type {Promise<{ status: number|null }>} */
  const exited = new Promise(resolve => {
    child.on('exit', status => resolve({ status }));
    child.on('error', error => {
      fs.appendFileSync(logPath, `\n[dispatch drive] spawn failed: ${error.message}\n`);
      resolve({ status: null });
    });
  });
  if (child.pid) fs.writeFileSync(pidPath(state, action), JSON.stringify({ pid: child.pid, logPath }), { mode: 0o600 });
  return { exited, detach: () => child.unref(), clear: () => fs.rmSync(pidPath(state, action), { force: true }) };
}

/**
 * The live wave already tracked for this launch, if any: re-driving a pending launch while its wave
 * runs adopts that wave instead of spawning a duplicate.
 *
 * @param {Record<string, any>} state @param {Record<string, any>} action
 */
function trackedWave(state, action) {
  let tracked;
  try { tracked = JSON.parse(fs.readFileSync(pidPath(state, action), 'utf8')); } catch { return null; }
  const running = () => alive(tracked.pid) && !envelopeWritten(outputFile(action.argv));
  const clear = () => fs.rmSync(pidPath(state, action), { force: true });
  // A tracked wave that already wrote its envelope finished; reap it rather than rerun it.
  if (envelopeWritten(outputFile(action.argv))) {
    return { exited: Promise.resolve({ status: null }), logPath: tracked.logPath, detach: () => {}, clear };
  }
  if (!running()) return null;
  /** @type {Promise<{ status: number|null }>} */
  const exited = (async () => { while (running()) await sleep(POLL_MS); return { status: null }; })();
  return { exited, logPath: tracked.logPath, detach: () => {}, clear };
}

/**
 * Waits for a detached wave of the pending round to exit or write its envelope. A wave that dies
 * without an envelope surfaces through the launch reply's missing-envelope recovery.
 *
 * @param {Record<string, any>} state
 */
export async function awaitWave(state) {
  const action = state.pending;
  if (action?.action !== 'launch' || !action.wave?.round || !action.argv) return;
  const file = pidPath(state, action);
  let pid;
  try { ({ pid } = JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return; }
  while (alive(pid) && !envelopeWritten(outputFile(action.argv))) await sleep(POLL_MS);
  fs.rmSync(file, { force: true });
}

/**
 * Runs a launch wave until it exits, or until a slot with an early fallback fails; with native
 * launches the host starts those alongside the wave, so it returns at once.
 *
 * @param {Record<string, any>} state @param {Record<string, any>} action
 * @param {() => string} createLog allocates the log for a newly started wave
 * @returns {Promise<{ running: boolean, logPath: string, status?: number|null, failed?: string[] }>}
 */
export async function runWave(state, action, createLog) {
  let wave = trackedWave(state, action);
  if (!wave) {
    const logPath = createLog();
    wave = { ...startWave(state, action, logPath), logPath };
  }
  const { logPath } = wave;
  if (action.nativeLaunches?.length) {
    wave.detach();
    return { running: true, logPath, failed: [] };
  }
  const early = new Set((action.earlyFallbacks ?? []).map(fallback => fallback.slot));
  for (;;) {
    const result = await Promise.race([wave.exited, sleep(POLL_MS).then(() => null)]);
    if (result) {
      wave.clear();
      return { running: false, logPath, status: result.status };
    }
    if (!early.size || !action.slotsPath) continue;
    const failed = readFailedSlots(action.slotsPath).map(record => record.slot).filter(slot => early.has(slot));
    if (failed.length) {
      wave.detach();
      return { running: true, logPath, failed: [...new Set(failed)] };
    }
  }
}
