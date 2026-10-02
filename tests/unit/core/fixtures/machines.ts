// Fixture machines and fake handlers for the core tier (test code, never shipped).

import { nextEffectId, type EffectCounters } from '../../../../skills/dispatch/scripts/core/effect-id.ts';
import type { Effect, Event, Handlers, Machine, ResultEvent, RunStartedEvent } from '../../../../skills/dispatch/scripts/core/types.ts';

export const RUN_STARTED: RunStartedEvent = {
  type: 'RUN_STARTED', protocolRevision: 3, verb: 'ask', argument: 'fixture', level: 'low', levelSource: 'explicit', pins: null, fix: false,
  orchestrator: 'claude', orchestratorModel: null, overrides: {}, config: {}, repo: {},
};

export const snapshotResult = (effectId: string): ResultEvent => ({ type: 'SNAPSHOT', effectId, fingerprint: {}, diff: {} });

/** Handlers answering every fixture effect with its terminal result. */
export const fakeHandlers: Handlers = {
  snapshot: async (effect) => [snapshotResult(effect.id)],
  verify: async (effect) => [{ type: 'VERIFY_DONE', effectId: effect.id, purpose: effect.purpose, results: [], fingerprint: {} }],
  wave: async (effect) => [
    { type: 'WAVE_PROGRESS', effectId: effect.id, slot: 'claude[0]', status: 'running' },
    { type: 'WAVE_DONE', effectId: effect.id, round: effect.round, slots: [], findings: [] },
  ],
};

// SECTION: Awaiting machine — RUN_STARTED → snapshot → author; AUTHORED → verify → done.

export type AwaitingState =
  | { tag: 'new'; counters: EffectCounters }
  | { tag: 'snapshotting'; counters: EffectCounters }
  | { tag: 'authoring'; counters: EffectCounters }
  | { tag: 'verifying'; counters: EffectCounters; path: string }
  | { tag: 'done'; counters: EffectCounters; path: string };

export const awaitingMachine: Machine<AwaitingState> = {
  initial: () => ({ tag: 'new', counters: {} }),
  step(state, event) {
    if (event.type === 'RUN_STARTED' && state.tag === 'new') {
      const { id, counters } = nextEffectId(state.counters, 'fixture', 'snapshot');
      return { state: { tag: 'snapshotting', counters }, effects: [{ kind: 'snapshot', id, since: null }] };
    }
    if (event.type === 'SNAPSHOT' && state.tag === 'snapshotting') return { state: { tag: 'authoring', counters: state.counters }, effects: [] };
    if (event.type === 'AUTHORED' && state.tag === 'authoring') {
      const { id, counters } = nextEffectId(state.counters, 'fixture', 'verify');
      return { state: { tag: 'verifying', counters, path: event.path }, effects: [{ kind: 'verify', id, purpose: 'final', commands: [] }] };
    }
    if (event.type === 'VERIFY_DONE' && state.tag === 'verifying') return { state: { tag: 'done', counters: state.counters, path: state.path }, effects: [] };
    return { state, effects: [] };
  },
  awaitOf: (state) => state.tag === 'authoring' ? 'author' : state.tag === 'done' ? 'done' : null,
  project: (state) => state.tag === 'done'
    ? { at: 'fixture › done', data: { outcome: 'complete', path: state.path } }
    : { at: `fixture › ${state.tag}`, data: { artifact: 'plan', path: 'plan.md' } },
  transitions: [
    { from: 'new', on: 'RUN_STARTED', to: 'snapshotting' },
    { from: 'snapshotting', on: 'SNAPSHOT', to: 'authoring' },
    { from: 'authoring', on: 'AUTHORED', to: 'verifying' },
    { from: 'verifying', on: 'VERIFY_DONE', to: 'done' },
  ],
  validate: (_state, event) => event.type === 'AUTHORED' && event.path.includes('..') ? `event.path: expected a path inside the session, got "${event.path}"` : null,
};

// SECTION: Never-awaiting machine — every step emits another effect.

export type LoopState = { counters: EffectCounters };

export const neverAwaitingMachine: Machine<LoopState> = {
  initial: () => ({ counters: {} }),
  step(state, event: Event) {
    if (event.type !== 'RUN_STARTED' && event.type !== 'SNAPSHOT') return { state, effects: [] };
    const { id, counters } = nextEffectId(state.counters, 'loop', 'snapshot');
    return { state: { counters }, effects: [{ kind: 'snapshot', id, since: null }] };
  },
  awaitOf: () => null,
  project: () => ({ at: 'loop', data: {} }),
  transitions: [{ from: 'loop', on: 'SNAPSHOT', to: 'loop' }],
};

// SECTION: Wave machine — RUN_STARTED → wave → done (in-flight and relaunch cases).

export type WaveState = { tag: 'new' | 'waving' | 'done' };

export const waveMachine: Machine<WaveState> = {
  initial: () => ({ tag: 'new' }),
  step(state, event) {
    if (event.type === 'RUN_STARTED') {
      const effect: Effect = { kind: 'wave', id: 'fixture.wave.1', round: 1, roster: [], timeoutMs: 1000 };
      return { state: { tag: 'waving' }, effects: [effect] };
    }
    if (event.type === 'WAVE_DONE') return { state: { tag: 'done' }, effects: [] };
    return { state, effects: [] };
  },
  awaitOf: (state) => state.tag === 'done' ? 'done' : null,
  project: (state) => ({ at: `wave › ${state.tag}`, data: state.tag === 'done' ? { outcome: 'complete' } : {} }),
  transitions: [{ from: 'waving', on: 'WAVE_DONE', to: 'done' }],
};

// SECTION: Nested machine — a child sub-machine re-entered after AUTHORED keeps run-global ordinals.

type Child = { tag: 'running' | 'settled' };
export type NestedState = { tag: 'child' | 'author' | 'done'; round: number; counters: EffectCounters; child: Child };

function enterChild(state: NestedState, round: number): { state: NestedState; effects: Effect[] } {
  const { id, counters } = nextEffectId(state.counters, 'root.child', 'snapshot');
  return { state: { tag: 'child', round, counters, child: { tag: 'running' } }, effects: [{ kind: 'snapshot', id, since: null }] };
}

export const nestedMachine: Machine<NestedState> = {
  initial: () => ({ tag: 'child', round: 0, counters: {}, child: { tag: 'settled' } }),
  step(state, event) {
    if (event.type === 'RUN_STARTED') return enterChild(state, 1);
    if (event.type === 'SNAPSHOT' && state.tag === 'child') {
      return { state: { ...state, tag: state.round === 1 ? 'author' : 'done', child: { tag: 'settled' } }, effects: [] };
    }
    if (event.type === 'AUTHORED' && state.tag === 'author') return enterChild(state, 2);
    return { state, effects: [] };
  },
  awaitOf: (state) => state.tag === 'author' ? 'author' : state.tag === 'done' ? 'done' : null,
  project: (state) => ({ at: `root › ${state.tag}`, data: state.tag === 'done' ? { outcome: 'complete' } : {} }),
  transitions: [
    { from: 'child', on: 'SNAPSHOT', to: 'author' },
    { from: 'author', on: 'AUTHORED', to: 'child' },
    { from: 'child', on: 'SNAPSHOT', to: 'done' },
  ],
};
