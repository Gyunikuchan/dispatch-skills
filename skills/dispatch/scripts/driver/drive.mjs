// @ts-check
/**
 * Drive loop (`dispatch.mjs --drive --state <file> [--input <json>]`): executes the host-side actions
 * the driver fully specifies — every `launch` argv and driver-run `verify` — and advances until an
 * action needs host judgment. A wave with host-launched native entries keeps running detached.
 * Banners go to stderr; stdout carries only that action.
 */

import { runningWaveGuidance } from './review-phase.mjs';
import { bindStateSession, readRunState, runFile } from './state.mjs';
import { runVerification } from './verify-run.mjs';
import { runWave } from './wave-process.mjs';

// Guards a driver bug from looping forever; a real run stops for judgment far sooner.
const MAX_STEPS = 50;

// SECTION: Mechanical actions

const elapsed = (start) => {
  const seconds = Math.round((Date.now() - start) / 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
};

function mechanical(action) {
  // Errors need the host before work resumes, except a state-kind launch re-emit (missing wave envelope), whose recovery is the relaunch.
  if (action.error && !(action.action === 'launch' && action.error.kind === 'state')) return false;
  // An all-native launch has no argv; its native subagents need the host.
  if (action.action === 'launch') return Array.isArray(action.argv) && !action.replyOnly;
  return action.action === 'verify' && Array.isArray(action.argv);
}

/** Completion evidence for verify/review criteria is host judgment, so the drive stops after running it. */
function needsEvidence(action) {
  return ['scoped', 'final'].includes(action.purpose) &&(action.criteria ?? []).some(item => item.evidenceClass !== 'red');
}

/** Runs the wave; returns the host's launch action when native entries must start while it runs. */
async function launch(action, stderr) {
  const state = readRunState(action.stateFile);
  const start = Date.now();
  const result = await runWave(state, action, () => runFile(state, { round: action.wave.round, kind: 'drive', ext: 'log' }));
  const { logPath } = result;
  const label = `[dispatch drive] launch ${action.wave.type} R${action.wave.round}`;
  if (!result.running) {
    stderr.write(`${label}: exit ${result.status ?? 'none'} in ${elapsed(start)}; log ${logPath}\n`);
    return null;
  }
  const failed = (action.earlyFallbacks ?? []).filter(fallback => result.failed.includes(fallback.slot));
  stderr.write(`${label}: still running after ${elapsed(start)}${failed.length ? `; ${failed.length} early-fallback slot(s) failed` : ''}; log ${logPath}\n`);
  const { argv, earlyFallbacks, ...rest } = action;
  const host = { ...rest, ...(failed.length ? { earlyFallbacks: failed } : {}) };
  return { ...host, guidance: runningWaveGuidance(host) };
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
    if (action.action === 'launch') {
      const host = await launch(action, stderr);
      if (host) return host;
    } else {
      const summary = verify(action, stderr);
      if (needsEvidence(action)) {
        return { ...action, summary, guidance: [`The driver already ran argv; do not rerun it. Its summary is in summary; a failing result carries its output tail in diagnostic, and full logs are at each result's logPath.`, ...action.guidance.slice(1)] };
      }
    }
    const next = await advance(action.stateFile, undefined);
    // The same gate failing twice is not transient; hand it to the host.
    if (next.error && action.error && next.action === action.action && next.error.kind === action.error.kind) return next;
    action = next;
  }
  return action;
}
