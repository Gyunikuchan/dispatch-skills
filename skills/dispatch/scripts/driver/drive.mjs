// @ts-check
/**
 * Drive loop (`dispatch.mjs --drive --state <file> [--input <json>]`): executes the host-side actions
 * the driver fully specifies — a `launch` with no early fallbacks and every driver-run `verify` — and
 * advances until an action needs host judgment. Banners go to stderr; stdout carries only that action.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { bindStateSession, readRunState } from './state.mjs';
import { runVerification } from './verify-run.mjs';

// Guards a driver bug from looping forever; a real run stops for judgment far sooner.
const MAX_STEPS = 50;

// SECTION: Mechanical actions

const elapsed = (start) => {
  const seconds = Math.round((Date.now() - start) / 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
};

function mechanical(action) {
  if (action.action === 'launch') return !action.replyOnly && !action.earlyFallbacks?.length;
  return action.action === 'verify' && Array.isArray(action.argv);
}

/** Completion evidence for verify/review criteria is host judgment, so the drive stops after running it. */
function needsEvidence(action) {
  return action.purpose === 'completion' && (action.criteria ?? []).some(item => item.evidenceClass !== 'red');
}

function launch(action, stderr) {
  const state = readRunState(action.stateFile);
  const logPath = path.join(path.dirname(path.resolve(action.stateFile)), `${state.runId}-drive-${action.wave.type}-r${action.wave.round}-${Date.now()}.log`);
  const fd = fs.openSync(logPath, 'w', 0o600);
  const start = Date.now();
  let result;
  try {
    result = spawnSync(action.argv[0], action.argv.slice(1), { cwd: state.repoRoot ?? process.cwd(), stdio: ['ignore', fd, fd], windowsHide: true });
  } finally {
    fs.closeSync(fd);
  }
  if (result.error) fs.appendFileSync(logPath, `\n[dispatch drive] spawn failed: ${result.error.message}\n`);
  stderr.write(`[dispatch drive] launch ${action.wave.type} R${action.wave.round}: exit ${result.status ?? 'none'} in ${elapsed(start)}; log ${logPath}\n`);
}

function verify(action, stderr) {
  const start = Date.now();
  const summary = runVerification(action.stateFile);
  const failed = summary.results.filter(item => item.exit !== 0).length;
  stderr.write(`[dispatch drive] verify ${summary.purpose}: ${summary.results.length} command(s), ${failed} nonzero${summary.reused ? ', reused unchanged-tree results' : ''} in ${elapsed(start)}; results ${summary.resultsPath}\n`);
  return summary;
}

/**
 * Returns the stopping action. `advance(stateFile, input)` is the `--next` transition; with `input`
 * undefined the drive starts from the pending action instead of replying to it.
 *
 * @param {{ state?: string, input?: any } & Record<string, any>} options
 * @param {{ advance: (state: string, input: any) => any, stderr: NodeJS.WritableStream }} deps
 */
export async function drive({ state: stateFile, input }, { advance, stderr }) {
  let action;
  if (input !== undefined) action = await advance(stateFile, input);
  else {
    bindStateSession(stateFile);
    action = readRunState(stateFile).pending;
    if (!action) throw new Error('No pending action to drive; start a run with --run.');
  }
  for (let step = 0; step < MAX_STEPS && mechanical(action); step++) {
    if (action.action === 'launch') launch(action, stderr);
    else {
      const summary = verify(action, stderr);
      if (needsEvidence(action)) {
        return { ...action, summary, guidance: [`The driver already ran argv; do not rerun it. Its summary is in summary; logs are at each result's logPath.`, ...action.guidance.slice(1)] };
      }
    }
    const next = await advance(action.stateFile, undefined);
    // The same gate failing twice is not transient; hand it to the host.
    if (next.error && action.error && next.action === action.action) return next;
    action = next;
  }
  return action;
}
