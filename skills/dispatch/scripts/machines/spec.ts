// Spec stage: read a candidate (or author one), lint it through `parse-artifact`, and settle `{path, hash}`.
// Settlement never gates; root decides when an authoring await needs approval (`specApprovalRequired`) and enters
// `approval` through `beginSpecApproval`.

import type { Event, HostEvent, Level, Machine, SpecApproval, SpecIdentity } from '../core/types.ts';
import { pathIdentity } from '../domain/path-identity.ts';
import { answers, isRecord, never, nextId, stay, type Counters, type Step } from './types.ts';

export const SPEC_TEMPLATE = 'references/templates/spec.md';
const HASH = /^sha256:[0-9a-f]{64}$/;

export type SpecCtx = { path: string; level: Level; approvals: readonly SpecApproval[]; counters: Counters };
export type SpecState =
  | { tag: 'reading'; c: SpecCtx; effectId: string }
  | { tag: 'author'; c: SpecCtx; defects: readonly Readonly<Record<string, unknown>>[] }
  | { tag: 'approval'; c: SpecCtx; identity: SpecIdentity }
  | { tag: 'settled'; c: SpecCtx; identity: SpecIdentity }
  | { tag: 'stopped'; c: SpecCtx; summary: string }
  | { tag: 'failed'; c: SpecCtx; detail: string };

type S = Step<SpecState>;

/** True when `level` requires approval and no approval binds `hash`. */
export function specApprovalRequired(level: Level, hash: string, approvals: readonly SpecApproval[]): boolean {
  return level !== 'low' && !approvals.some((approval) => approval.hash === hash);
}

/** Reads `path` through `parse-artifact`; effect ids use the `spec` machine path so child ids do not shift. */
export function beginSpecRead(c: SpecCtx, path: string): S {
  const { id, counters } = nextId(c.counters, 'spec', 'parse-artifact');
  return { state: { tag: 'reading', c: { ...c, path, counters }, effectId: id }, effects: [{ kind: 'parse-artifact', id, path, artifact: 'spec', level: c.level }] };
}

export function beginSpec(input: { candidate: string | null; defaultPath: string; level: Level; approvals: readonly SpecApproval[] }, counters: Counters): S {
  const c: SpecCtx = { path: input.candidate ?? input.defaultPath, level: input.level, approvals: input.approvals, counters };
  return input.candidate ? beginSpecRead(c, input.candidate) : stay({ tag: 'author', c, defects: [] });
}

export function beginSpecApproval(c: SpecCtx, identity: SpecIdentity): S {
  return stay({ tag: 'approval', c, identity });
}

const userApproval = (answer: unknown): SpecApproval | null =>
  isRecord(answer) && answer['by'] === 'user' && typeof answer['quote'] === 'string' && typeof answer['hash'] === 'string'
    ? { by: 'user', quote: answer['quote'], hash: answer['hash'] } : null;

export function stepSpec(state: SpecState, event: Event): S {
  switch (state.tag) {
    case 'reading': {
      if (event.type === 'EFFECT_FAILED' && answers(event, state.effectId)) {
        return stay(/not found/.test(event.detail) ? { tag: 'author', c: state.c, defects: [] } : { tag: 'failed', c: state.c, detail: `${event.cls}: ${event.detail}` });
      }
      if (event.type !== 'ARTIFACT_PARSED' || !answers(event, state.effectId)) return stay(state);
      if (event.defects.length) return stay({ tag: 'author', c: state.c, defects: event.defects });
      if (!HASH.test(event.hash)) return stay({ tag: 'author', c: state.c, defects: [{ code: 'invalid-hash', message: `Spec hash ${event.hash} is not sha256:<hex>.` }] });
      return stay({ tag: 'settled', c: state.c, identity: { path: state.c.path, hash: event.hash } });
    }
    case 'author':
      return event.type === 'AUTHORED' && event.path === state.c.path ? beginSpecRead(state.c, event.path) : stay(state);
    case 'approval': {
      if (event.type === 'SPEC_REVISED' && pathIdentity(event.path) === pathIdentity(state.c.path)) return beginSpecRead(state.c, state.c.path);
      if (event.type !== 'DECISION' || event.kind !== 'spec-approval') return stay(state);
      if (event.answer === 'stop') return stay({ tag: 'stopped', c: state.c, summary: 'User declined spec approval.' });
      const approval = userApproval(event.answer);
      if (!approval || approval.hash !== state.identity.hash) return stay(state);
      return stay({ tag: 'settled', c: { ...state.c, approvals: [...state.c.approvals, approval] }, identity: state.identity });
    }
    case 'settled': case 'stopped': case 'failed': return stay(state);
    default: return never(state, 'spec state');
  }
}

/** Terminal states await nothing: root consumes them in the same step. */
export function specAwait(state: SpecState) {
  switch (state.tag) {
    case 'author': return 'author' as const;
    case 'approval': return 'decide' as const;
    case 'reading': case 'settled': case 'stopped': case 'failed': return null;
    default: return never(state, 'spec state');
  }
}

export function specData(state: SpecState): Readonly<Record<string, unknown>> {
  switch (state.tag) {
    case 'author':
      return { artifact: 'spec', path: state.c.path, template: SPEC_TEMPLATE, level: state.c.level, ...(state.defects.length ? { defects: state.defects } : {}) };
    case 'approval': {
      const { path, hash } = state.identity;
      return { kind: 'spec-approval', path, hash, question: 'Approve this governing spec revision.', options: ['approve', 'stop'], required: { by: 'user', quote: 'non-empty', hash } };
    }
    case 'stopped': return { outcome: 'failed', summary: state.summary };
    case 'failed': return { outcome: 'failed', summary: state.detail };
    case 'reading': case 'settled': return {};
    default: return never(state, 'spec state');
  }
}

export function validateSpec(state: SpecState, event: HostEvent): string | null {
  if (state.tag === 'author' && event.type === 'AUTHORED' && event.path !== state.c.path) return `event.path: author the spec at ${state.c.path}`;
  // NOTE: the spec stage consumes no other artifact edits; accepting one would journal an event it silently drops.
  if (state.tag === 'author' && event.type === 'REVISE') return 'event.type: REVISE is not accepted while the spec is authored; send AUTHORED for the spec.';
  if (state.tag === 'approval' && (event.type === 'REVISE' || event.type === 'AMEND' || event.type === 'REPLACE_PLAN')) return `event.type: ${event.type} is not accepted at the spec approval await; answer the spec-approval DECISION.`;
  if (state.tag === 'approval' && event.type === 'DECISION') {
    if (event.kind !== 'spec-approval') return 'event.kind: expected spec-approval';
    if (event.answer === 'stop') return null;
    const approval = userApproval(event.answer);
    if (!approval) return 'event.answer: expected "stop" or { by: "user", quote, hash }';
    if (approval.hash !== state.identity.hash) return `event.answer.hash: expected ${state.identity.hash}`;
  }
  return null;
}

export const specTransitions = [
  { from: 'reading', on: 'ARTIFACT_PARSED', to: 'author' },
  { from: 'reading', on: 'ARTIFACT_PARSED', to: 'settled' },
  { from: 'reading', on: 'EFFECT_FAILED', to: 'author' },
  { from: 'reading', on: 'EFFECT_FAILED', to: 'failed' },
  { from: 'author', on: 'AUTHORED', to: 'reading' },
  { from: 'approval', on: 'SPEC_REVISED', to: 'reading' },
  { from: 'approval', on: 'DECISION', to: 'settled' },
  { from: 'approval', on: 'DECISION', to: 'stopped' },
] as const;

export const specMachine: Machine<SpecState> = {
  initial: () => ({ tag: 'author', c: { path: 'dispatch.spec.md', level: 'low', approvals: [], counters: {} }, defects: [] }),
  step: stepSpec,
  awaitOf: specAwait,
  project: (state) => ({ at: `spec › ${state.tag}`, data: specData(state) }),
  transitions: specTransitions,
  validate: validateSpec,
};
