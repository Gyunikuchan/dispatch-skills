// Host-event validation: shape guards plus await acceptance (spec §4.5, §5.2). Dependency-free.

import type { Await, HostEvent, HostEventType } from './types.ts';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export type Validator<T> = (value: unknown, at: string) => Result<T>;

// SECTION: Combinators

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(at: string, expected: string, value: unknown): Result<T> =>
  ({ ok: false, error: `${at}: expected ${expected}, got ${describe(value)}` });

function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const str: Validator<string> = (value, at) => typeof value === 'string' && value.length > 0 ? ok(value) : fail(at, 'non-empty string', value);
export const num: Validator<number> = (value, at) => typeof value === 'number' && Number.isFinite(value) ? ok(value) : fail(at, 'number', value);
export const bool: Validator<boolean> = (value, at) => typeof value === 'boolean' ? ok(value) : fail(at, 'boolean', value);
export const any: Validator<unknown> = (value) => ok(value);

export function lit<const T extends string | number | boolean>(...values: readonly T[]): Validator<T> {
  return (value, at) => values.includes(value as T) ? ok(value as T) : fail(at, `one of ${values.map((v) => JSON.stringify(v)).join('|')}`, value);
}

export function arr<T>(item: Validator<T>): Validator<T[]> {
  return (value, at) => {
    if (!Array.isArray(value)) return fail(at, 'array', value);
    const out: T[] = [];
    for (const [index, entry] of value.entries()) {
      const result = item(entry, `${at}[${index}]`);
      if (!result.ok) return result;
      out.push(result.value);
    }
    return ok(out);
  };
}

export function rec<T>(item: Validator<T>): Validator<Record<string, T>> {
  return (value, at) => {
    if (!isRecord(value)) return fail(at, 'object', value);
    const out: Record<string, T> = {};
    for (const [key, entry] of Object.entries(value)) {
      const result = item(entry, `${at}.${key}`);
      if (!result.ok) return result;
      out[key] = result.value;
    }
    return ok(out);
  };
}

const OPTIONAL = Symbol('optional');
export type Optional<T> = Validator<T> & { [OPTIONAL]: true };

export function opt<T>(inner: Validator<T>): Optional<T> {
  return Object.assign((value: unknown, at: string) => inner(value, at), { [OPTIONAL]: true as const });
}

/** Strict object: unknown keys are rejected so typos surface at the field. */
export function obj(shape: Readonly<Record<string, Validator<unknown>>>): Validator<Record<string, unknown>> {
  return (value, at) => {
    if (!isRecord(value)) return fail(at, 'object', value);
    for (const key of Object.keys(value)) if (!(key in shape)) return { ok: false, error: `${at}.${key}: unexpected field` };
    for (const [key, check] of Object.entries(shape)) {
      if (!(key in value) && OPTIONAL in check) continue;
      const result = check(value[key], `${at}.${key}`);
      if (!result.ok) return result;
    }
    return ok(value);
  };
}

export function oneOf<T>(...options: readonly Validator<T>[]): Validator<T> {
  return (value, at) => {
    let last: Result<T> = fail(at, 'a matching alternative', value);
    for (const option of options) {
      last = option(value, at);
      if (last.ok) return last;
    }
    return last;
  };
}

// SECTION: Host events

const payload = rec(any);
const DECIDE_KINDS = lit('approval', 'baseline', 'failure', 'concerns', 'escalation', 'needs-user', 'opt-in', 'drift');

export const HOST_EVENT_SHAPES: { readonly [K in HostEventType]: Validator<Record<string, unknown>> } = {
  AUTHORED: obj({ type: lit('AUTHORED'), path: str }),
  NATIVE_RESULTS: obj({ type: lit('NATIVE_RESULTS'), slots: arr(payload) }),
  RULINGS: obj({ type: lit('RULINGS'), rulings: rec(payload) }),
  FIXES_APPLIED: obj({ type: lit('FIXES_APPLIED'), clusters: arr(payload) }),
  WRITE_ENVELOPE: obj({ type: lit('WRITE_ENVELOPE'), envelopePath: str }),
  WRITE_FAILED: obj({ type: lit('WRITE_FAILED'), model: str, kind: str, reason: str }),
  EVIDENCE: obj({ type: lit('EVIDENCE'), criteria: rec(payload) }),
  DECISION: obj({ type: lit('DECISION'), kind: DECIDE_KINDS, answer: any }),
  REVISE: obj({ type: lit('REVISE'), artifact: lit('plan', 'design'), reason: str, evidence: str }),
};

// NOTE: REVISE is accepted at every live await; the machine's validate hook narrows it (spec §5.7).
export const AWAIT_ACCEPTS: { readonly [K in Await]: readonly HostEventType[] } = {
  author: ['AUTHORED', 'REVISE'],
  native: ['NATIVE_RESULTS', 'REVISE'],
  rule: ['RULINGS', 'REVISE'],
  fix: ['FIXES_APPLIED', 'REVISE'],
  write: ['WRITE_ENVELOPE', 'WRITE_FAILED', 'REVISE'],
  evidence: ['EVIDENCE', 'REVISE'],
  decide: ['DECISION', 'REVISE'],
  done: [],
};

function isHostEventType(value: unknown): value is HostEventType {
  return typeof value === 'string' && Object.hasOwn(HOST_EVENT_SHAPES, value);
}

/** Shape, then await acceptance, then the machine's context hook; the error is one line naming the field. */
export function validateHostEvent(current: Await, raw: unknown, check?: (event: HostEvent) => string | null): Result<HostEvent> {
  if (!isRecord(raw)) return fail('event', 'object', raw);
  const type = raw['type'];
  if (!isHostEventType(type)) return fail('event.type', `one of ${Object.keys(HOST_EVENT_SHAPES).join('|')}`, type);
  const accepted = AWAIT_ACCEPTS[current];
  if (!accepted.includes(type)) {
    return { ok: false, error: `event.type: ${type} is not accepted at await ${current}; expected ${accepted.length ? accepted.join('|') : 'no event'}` };
  }
  const shape = HOST_EVENT_SHAPES[type](raw, 'event');
  if (!shape.ok) return shape;
  const event = raw as HostEvent;
  const context = check?.(event) ?? null;
  return context === null ? ok(event) : { ok: false, error: context };
}
