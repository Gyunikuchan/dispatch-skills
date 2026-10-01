// Ask machine (spec §5.4): preparing → wave → [native → wave] → done { claims, failed }. Claims are untrusted.

import type { Event, HostEvent, Machine, RunStartedEvent } from '../core/types.ts';
import { nativeRoster, pendingNative, resolveSlots, validateNativeResults, waveRoster } from './review.ts';
import { answers, isString, never, nextId, stay, type AskSpec, type Claim, type Counters, type FailedSlot, type NativeSlot, type Step } from './types.ts';

type Row = Readonly<Record<string, unknown>>;

export type AskCtx = { spec: AskSpec; path: string; counters: Counters; effectId: string | null; rows: readonly Row[] };

export type AskState =
  | { tag: 'booting'; counters: Counters }
  | { tag: 'preparing'; c: AskCtx }
  | { tag: 'wave'; c: AskCtx; phase: 'cli' | 'native' }
  | { tag: 'native'; c: AskCtx; slots: readonly NativeSlot[] }
  | { tag: 'done'; c: AskCtx; claims: readonly Claim[]; failed: readonly FailedSlot[] }
  | { tag: 'failed'; c: AskCtx | null; detail: string };

type S = Step<AskState>;

export function askSpecFromRun(run: RunStartedEvent): { ok: true; spec: AskSpec } | { ok: false; error: string } {
  const slots = resolveSlots(run, undefined);
  if (!slots.ok) return slots;
  const context = isString(run.overrides['context']) ? run.overrides['context'] : '';
  return { ok: true, spec: { kind: 'ask', target: run.argument, breadth: slots.breadth, context, roster: slots.roster, timeoutMs: slots.timeoutMs } };
}

export function beginAsk(spec: AskSpec, path: string, counters: Counters): S {
  const { id, counters: next } = nextId(counters, path, 'prepare-review');
  const c: AskCtx = { spec, path, counters: next, effectId: id, rows: [] };
  return { state: { tag: 'preparing', c }, effects: [{ kind: 'prepare-review', id, review: spec, round: 1, scope: { scope: 'full', carried: [] } }] };
}

function launch(c0: AskCtx, roster: readonly Row[], phase: 'cli' | 'native'): S {
  const { id, counters } = nextId(c0.counters, c0.path, 'wave');
  const c = { ...c0, counters, effectId: id };
  return { state: { tag: 'wave', c, phase }, effects: [{ kind: 'wave', id, round: 1, roster: [...roster], timeoutMs: c0.spec.timeoutMs }] };
}

function finish(c: AskCtx): S {
  const claims = c.rows.flatMap((row): Claim[] => (typeof row['claim'] === 'string' && row['state'] !== 'failed' ? [{ text: row['claim'], source: String(row['slot']) }] : []));
  const failed = c.rows.filter((row) => row['state'] === 'failed').map((row): FailedSlot => ({ slot: String(row['slot']), cls: String(row['cls'] ?? 'failed') }));
  return stay({ tag: 'done', c, claims, failed });
}

export function stepAsk(state: AskState, event: Event): S {
  if (event.type === 'EFFECT_FAILED' && (state.tag === 'preparing' || state.tag === 'wave') && answers(event, state.c.effectId)) {
    return stay({ tag: 'failed', c: state.c, detail: `${event.cls}: ${event.detail}` });
  }
  switch (state.tag) {
    case 'booting': return stay(state);
    case 'preparing':
      if (event.type !== 'REVIEW_PREPARED' || !answers(event, state.c.effectId)) return stay(state);
      return launch(state.c, waveRoster(state.c.spec.roster, 'ask', event.promptPaths), 'cli');
    case 'wave': {
      if (event.type !== 'WAVE_DONE' || !answers(event, state.c.effectId)) return stay(state);
      if (state.phase === 'native') return finish({ ...state.c, rows: [...state.c.rows, ...event.slots] });
      const pending = pendingNative(event.slots);
      const c = { ...state.c, rows: event.slots.filter((row) => !(row['state'] === 'native' && row['descriptor'] !== undefined)) };
      return pending.length ? stay({ tag: 'native', c, slots: pending }) : finish(c);
    }
    case 'native':
      if (event.type !== 'NATIVE_RESULTS' || validateNativeResults(event.slots) !== null) return stay(state);
      return launch(state.c, nativeRoster(state.slots, event.slots, 'ask'), 'native');
    case 'done': case 'failed': return stay(state);
    default: return never(state, 'ask state');
  }
}

export function askAwait(state: AskState) {
  switch (state.tag) {
    case 'native': return 'native' as const;
    case 'done': case 'failed': return 'done' as const;
    case 'booting': case 'preparing': case 'wave': return null;
    default: return never(state, 'ask state');
  }
}

export function askData(state: AskState): Readonly<Record<string, unknown>> {
  switch (state.tag) {
    case 'native': return { round: 1, slots: state.slots };
    case 'done': return { outcome: 'complete', summary: `${state.claims.length} claim(s), ${state.failed.length} failed slot(s)`, claims: state.claims, failed: state.failed };
    case 'failed': return { outcome: 'failed', summary: state.detail };
    case 'booting': case 'preparing': case 'wave': return {};
    default: return never(state, 'ask state');
  }
}

export function validateAsk(state: AskState, event: HostEvent): string | null {
  if (event.type === 'REVISE') return 'event.type: REVISE is not available in ask';
  return state.tag === 'native' && event.type === 'NATIVE_RESULTS' ? validateNativeResults(event.slots) : null;
}

export const askTransitions = [
  { from: 'booting', on: 'RUN_STARTED', to: 'preparing' },
  { from: 'booting', on: 'RUN_STARTED', to: 'failed' },
  { from: 'preparing', on: 'REVIEW_PREPARED', to: 'wave' },
  { from: 'preparing', on: 'EFFECT_FAILED', to: 'failed' },
  { from: 'wave', on: 'WAVE_DONE', to: 'native' },
  { from: 'wave', on: 'WAVE_DONE', to: 'done' },
  { from: 'wave', on: 'EFFECT_FAILED', to: 'failed' },
  { from: 'native', on: 'NATIVE_RESULTS', to: 'wave' },
] as const;

export const askMachine: Machine<AskState> = {
  initial: () => ({ tag: 'booting', counters: {} }),
  step(state, event) {
    if (state.tag === 'booting' && event.type === 'RUN_STARTED') {
      const built = askSpecFromRun(event);
      return built.ok ? beginAsk(built.spec, 'ask', state.counters) : stay({ tag: 'failed', c: null, detail: built.error });
    }
    return stepAsk(state, event);
  },
  awaitOf: askAwait,
  project: (state) => ({ at: `ask › ${state.tag}`, data: askData(state) }),
  transitions: askTransitions,
  validate: validateAsk,
};
