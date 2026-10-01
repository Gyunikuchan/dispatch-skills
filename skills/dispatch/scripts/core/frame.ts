// Frame projection: one JSON line per invocation on stdout (spec §4.6).

import type { Frame, Machine } from './types.ts';

export function replyTemplate(runRel: string): string {
  // NOTE: `@<file>` sidesteps JSON quoting differences across bash, zsh, and PowerShell.
  return `node <skills-dir>/dispatch/scripts/dispatch.ts send --run ${runRel} --event @<event-file>`;
}

export function projectFrame<S>(machine: Machine<S>, state: S, runRel: string, error?: string): Frame {
  const { at, data } = machine.project(state);
  const frame: Frame = { v: 1, run: runRel, at, await: machine.awaitOf(state) ?? 'done', data, reply: replyTemplate(runRel) };
  if (error !== undefined) frame.error = error;
  return frame;
}

export function faultFrame(runRel: string, error: string): Frame {
  return { v: 1, run: runRel, at: 'fault', await: 'done', data: { outcome: 'fault' }, reply: replyTemplate(runRel), error: oneLine(error) };
}

export function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim();
}
