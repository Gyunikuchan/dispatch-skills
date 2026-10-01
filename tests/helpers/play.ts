// Tier-1 helper: fold events through a machine and return the projected frame after each event.

import { projectFrame } from '../../skills/dispatch/scripts/core/frame.ts';
import type { Event, Frame, Machine } from '../../skills/dispatch/scripts/core/types.ts';

export const PLAY_RUN = 'play';

export function play<S>(machine: Machine<S>, events: readonly Event[]): Frame[] {
  let state = machine.initial();
  return events.map((event) => {
    state = machine.step(state, event).state;
    return projectFrame(machine, state, PLAY_RUN);
  });
}
