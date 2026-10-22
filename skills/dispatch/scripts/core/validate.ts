// Host-event validation: shape guards plus await acceptance (spec §4.5, §5.2). Dependency-free.

import type { Await, HostEvent, HostEventType } from './types.ts';
import { validateConfig } from '../lib/config.ts';

export function validateExecutionUpdate(value: unknown): string | null {
  if (!isRecord(value) || value['type'] !== 'EXECUTION_CONFIG_UPDATED' || Object.keys(value).some((key) => !['type', 'revision', 'boundarySeq', 'delta'].includes(key))) return 'execution-config-invalid: expected update event';
  if (![value['revision'], value['boundarySeq']].every((v) => Number.isSafeInteger(v) && Number(v) > 0)) return 'execution-config-invalid: positive revision and boundarySeq required';
  const delta = value['delta'];
  if (!isRecord(delta) || Object.keys(delta).some((key) => !['read', 'write'].includes(key)) || !Array.isArray(delta['read']) || !Array.isArray(delta['write'])) return 'execution-config-invalid: expected read/write delta';
  const seen = new Set<string>();
  for (const kind of ['read', 'write'] as const) {
    for (const item of delta[kind] as unknown[]) {
      if (!isRecord(item) || Object.keys(item).some((key) => !(kind === 'read' ? ['slot', 'provider', 'levels'] : ['provider', 'levels']).includes(key)) || typeof item['provider'] !== 'string') return 'execution-config-invalid: invalid provider entry';
      if (kind === 'read' && (typeof item['slot'] !== 'string' || item['slot'] !== `${item['provider']}[${/\[(\d+)\]$/.exec(String(item['slot']))?.[1] ?? 'invalid'}]`)) return 'execution-config-invalid: invalid slot identity';
      const key = `${kind}:${String(item['slot'] ?? item['provider'])}`;
      if (seen.has(key)) return 'execution-config-invalid: duplicate identity';
      seen.add(key);
      const config = kind === 'read' ? { 'read-delegates': { [item['provider']]: { targets: [item['levels']] } } } : { 'read-delegates': { codex: { targets: [{ low: { model: 'validation' } }] } }, 'write-subagents': { [item['provider']]: item['levels'] } };
      if (validateConfig(config).length) return 'execution-config-invalid: invalid model/effort levels';
    }
  }
  return null;
}

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

/** Path segments before the error's `: `; deeper means the alternative matched further. */
const errorDepth = (error: string): number => error.slice(0, error.indexOf(': ')).split(/[.[]/).length;

/** Reports the alternative that failed deepest, so a known discriminator with a bad field names that field; ties keep the last. */
export function oneOf<T>(...options: readonly Validator<T>[]): Validator<T> {
  return (value, at) => {
    let best: Result<T> = fail(at, 'a matching alternative', value);
    for (const option of options) {
      const result = option(value, at);
      if (result.ok) return result;
      if (best.ok || errorDepth(result.error) >= errorDepth(best.error)) best = result;
    }
    return best;
  };
}

// SECTION: Host events

const payload = rec(any);
const LEGACY_DECIDE_KINDS = lit('approval', 'baseline', 'concerns', 'escalation', 'needs-user', 'opt-in');
const strings = arr(str);
const nullableString: Validator<string | null> = (value, at) => value === null ? ok(null) : str(value, at);
const nonBlank: Validator<string> = (value, at) => typeof value === 'string' && value.trim().length > 0 ? ok(value) : fail(at, 'non-empty trimmed string', value);
const boundedText = (max: number): Validator<string> => (value, at) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max ? ok(value) : fail(at, `non-empty trimmed string of at most ${max} characters`, value);
const scopeHash: Validator<string> = (value, at) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) ? ok(value) : fail(at, 'sha256:<64 hex>', value);
const positiveInt: Validator<number> = (value, at) => Number.isSafeInteger(value) && Number(value) > 0 ? ok(Number(value)) : fail(at, 'positive integer', value);
const nonNegativeInt: Validator<number> = (value, at) => Number.isSafeInteger(value) && Number(value) >= 0 ? ok(Number(value)) : fail(at, 'non-negative integer', value);
/** Optional host-attested figures (diagnostics, best effort); accepted whether or not diagnostics are enabled. */
const attestation = { tokens: opt(nonNegativeInt), durationMs: opt(nonNegativeInt) };
const nativeSlot: Validator<Record<string, unknown>> = (value, at) => {
  const shape = payload(value, at);
  if (!shape.ok) return shape;
  for (const key of Object.keys(attestation)) {
    if (!(key in shape.value)) continue;
    const result = nonNegativeInt(shape.value[key], `${at}.${key}`);
    if (!result.ok) return result;
  }
  return shape;
};
const nonEmptyArr = <T>(item: Validator<T>): Validator<T[]> => (value, at) => Array.isArray(value) && value.length === 0 ? fail(at, 'non-empty array', value) : arr(item)(value, at);
const identity = { task: str, attempt: positiveInt, signature: str, handle: str };
const launch = { model: nonBlank, effort: opt(str) };
/** Dispatches on a discriminator field, so an error names the field of the chosen shape rather than a sibling's. */
const byKey = (key: string, cases: Readonly<Record<string, Validator<Record<string, unknown>>>>): Validator<Record<string, unknown>> => (value, at) => {
  const tag = isRecord(value) ? value[key] : undefined;
  const shape = typeof tag === 'string' && Object.hasOwn(cases, tag) ? cases[tag] : undefined;
  if (shape) return shape(value, at);
  const named = lit(...Object.keys(cases))(tag, `${at}.${key}`);
  return isRecord(value) && !named.ok ? named : fail(at, 'object', value);
};
const receipt = (status: string, shape: Readonly<Record<string, Validator<unknown>>>) => obj({ type: lit('WRITE_RECEIPT'), status: lit(status), ...shape });
/** Orchestrator ruling: `rationale` replaces the former `rootCause`, and `amendment` names the AMEND a ruling relies on. */
const ruling = (actions: readonly string[], extra: Readonly<Record<string, Validator<unknown>>> = {}) =>
  obj({ by: lit('orchestrator'), action: lit(...actions), rationale: nonBlank, amendment: opt(nonBlank), ...extra });
const decision = (kind: string, answer: Validator<unknown>) => obj({ type: lit('DECISION'), kind: lit(kind), answer });
const planEdit = obj({ kind: lit('modify', 'remove', 'add'), target: nonBlank, current: opt(nonBlank), proposed: opt(nonBlank) });
const notice = obj({ task: str, notice: nonBlank });
const userQuote = obj({ by: lit('user'), quote: nonBlank });
const reconciliation = obj({ retained: strings, changed: strings, added: strings, retired: strings, intentChanged: lit(true, false), dependencyChanged: lit(true, false), compensating: opt(strings) });
const retirement = obj({ task: nonBlank, disposition: lit('stop', 'retain') });

export const HOST_EVENT_SHAPES: { readonly [K in HostEventType]: Validator<Record<string, unknown>> } = {
  AUTHORED: obj({ type: lit('AUTHORED'), path: str }),
  SPEC_REVISED: obj({ type: lit('SPEC_REVISED'), path: nonBlank }),
  NATIVE_RESULTS: obj({ type: lit('NATIVE_RESULTS'), slots: arr(nativeSlot) }),
  RULINGS: obj({ type: lit('RULINGS'), rulings: rec(payload) }),
  FIXES_APPLIED: obj({ type: lit('FIXES_APPLIED'), clusters: arr(payload) }),
  // NOTE: the taskless forms come first, so a receipt naming a task reports the identity form's error.
  WRITE_RECEIPT: byKey('status', {
    launched: receipt('launched', { ...identity, ...launch, substitution: opt(nonBlank) }),
    submitted: oneOf(
      receipt('submitted', { envelopePath: str, model: opt(nonBlank), effort: opt(str), ...attestation }),
      receipt('submitted', { ...identity, envelopePath: str, briefHash: str, ...launch, ...attestation }),
    ),
    failed: oneOf(
      receipt('failed', { detail: nonBlank, model: opt(nonBlank), effort: opt(str), ...attestation }),
      receipt('failed', { ...identity, detail: nonBlank, ...launch, ...attestation }),
    ),
    cancelled: receipt('cancelled', { ...identity, ...attestation }),
  }),
  REQUEST: obj({ type: lit('REQUEST'), task: str, attempt: positiveInt, need: nonBlank, paths: strings, rationale: nonBlank }),
  AMEND: obj({ type: lit('AMEND'), delta: nonEmptyArr(planEdit), notify: arr(notice), rationale: nonBlank, by: opt(userQuote), reconciliation: opt(reconciliation), retire: opt(arr(retirement)) }),
  REPLACE_PLAN: obj({ type: lit('REPLACE_PLAN'), path: nonBlank, expectedHash: nonBlank, rationale: nonBlank, notify: arr(notice), reconciliation, retire: opt(arr(retirement)), by: opt(userQuote) }),
  EVIDENCE: obj({ type: lit('EVIDENCE'), criteria: rec(payload), waiver: opt(obj({ by: lit('user'), quote: nonBlank })) }),
  DECISION: oneOf(
    obj({ type: lit('DECISION'), kind: lit('drift'), answer: obj({ by: lit('orchestrator'), noticeId: nonBlank, afterHash: nonBlank, action: lit('preserve', 'refresh', 'reconcile', 'escalate'), rationale: nonBlank, evidenceIds: strings }) }),
    obj({ type: lit('DECISION'), kind: lit('level-classification'), answer: obj({ evaluatedLevel: lit('low', 'medium', 'high'), rationale: boundedText(500), gateScopeHash: scopeHash }) }),
    decision('integration-conflict', ruling(['resolve', 'discard'])),
    decision('fix-verification', rec(obj({ verification: nonEmptyArr(nonBlank), by: lit('orchestrator'), rationale: nonBlank }))),
    decision('request', ruling(['approve', 'decline', 'escalate'])),
    decision('request-user', obj({ by: lit('user'), requestId: str, choice: lit('accept', 'decline'), quote: nonBlank })),
    decision('failure', byKey('action', {
      stop: ruling(['stop']),
      retry: ruling(['retry']),
      hotfix: ruling(['hotfix'], { mode: lit('inline', 'writer'), external: arr(obj({ path: str, reason: nonBlank })) }),
      'manual-complete': obj({ by: lit('user'), action: lit('manual-complete'), quote: nonBlank, criteria: rec(payload) }),
    })),
    obj({ type: lit('DECISION'), kind: lit('run-stop'), answer: obj({ by: lit('user'), quote: nonBlank }) }),
    decision('spec-approval', oneOf<unknown>(lit('stop'), obj({ by: lit('user'), quote: nonBlank, hash: nonBlank }))),
    obj({ type: lit('DECISION'), kind: LEGACY_DECIDE_KINDS, answer: any }),
  ),
  REVISE: obj({ type: lit('REVISE'), artifact: lit('plan', 'design'), reason: str, evidence: str }),
  // Per-item gating (item cap, dispatch-owned component, redaction) happens at render time, so a bad item never blocks completion.
  RETRO: obj({ type: lit('RETRO'), observations: arr(any) }),
  REVIEW_USE: obj({ type: lit('REVIEW_USE'), observationId: nonBlank, afterHash: nonBlank, action: lit('reuse', 'targeted', 'full'), rationale: nonBlank, paths: opt(strings) }),
};

const CHANGE_DISPOSITIONS = nonEmptyArr(obj({ observationId: nonBlank, afterHash: nonBlank, rationale: nonBlank, retain: opt(strings), refresh: opt(strings) }));

// NOTE: REVIEW_USE records an optional review applicability choice at any review await; the machine hook rejects it elsewhere.
// NOTE: REVISE is accepted at every live await but `write`, where AMEND changes the plan without draining writers;
// the machine's validate hook narrows both (spec §5.7).
// NOTE: SPEC_REVISED is excluded from native, write, and fix: delegate or host fix work is in flight there.
export const AWAIT_ACCEPTS: { readonly [K in Await]: readonly HostEventType[] } = {
  author: ['AUTHORED', 'REVISE', 'SPEC_REVISED'],
  native: ['NATIVE_RESULTS', 'REVISE', 'REVIEW_USE'],
  rule: ['RULINGS', 'REVISE', 'REVIEW_USE', 'SPEC_REVISED'],
  fix: ['FIXES_APPLIED', 'REVISE', 'REVIEW_USE'],
  write: ['WRITE_RECEIPT', 'REQUEST', 'AMEND', 'REPLACE_PLAN'],
  evidence: ['EVIDENCE', 'REVISE', 'SPEC_REVISED'],
  decide: ['DECISION', 'AMEND', 'REPLACE_PLAN', 'REVISE', 'REVIEW_USE', 'SPEC_REVISED'],
  retro: ['RETRO'],
  done: [],
};

function isHostEventType(value: unknown): value is HostEventType {
  return typeof value === 'string' && Object.hasOwn(HOST_EVENT_SHAPES, value);
}

/** Shape, then await acceptance, then the machine's context hook; the error is one line naming the field. */
export function validateHostEvent(current: Await, raw: unknown, check?: (event: HostEvent) => string | null): Result<HostEvent> {
  if (!isRecord(raw)) return fail('event', 'object', raw);
  const type = raw['type'];
  if (type === undefined && 'events' in raw) return { ok: false, error: 'event: send one event object from the frame events array, not the frame or an events wrapper.' };
  if (!isHostEventType(type)) return fail('event.type', `one of ${Object.keys(HOST_EVENT_SHAPES).join('|')}`, type);
  const accepted = AWAIT_ACCEPTS[current];
  if (!accepted.includes(type)) {
    return { ok: false, error: `event.type: ${type} is not accepted at await ${current}; expected ${accepted.length ? accepted.join('|') : 'no event'}` };
  }
  // NOTE: dispositions are metadata shared by every reply, so they are checked apart from the strict event shape.
  const { changeDispositions, ...body } = raw;
  if (changeDispositions !== undefined) {
    const dispositions = CHANGE_DISPOSITIONS(changeDispositions, 'event.changeDispositions');
    if (!dispositions.ok) return dispositions;
  }
  const shape = HOST_EVENT_SHAPES[type](body, 'event');
  if (!shape.ok) return shape;
  const event = raw as HostEvent;
  const context = check?.(event) ?? null;
  return context === null ? ok(event) : { ok: false, error: context };
}
export function validateRecoveryDisposition(value: unknown, effectId: string, attempt: number, descriptorHash: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'effect-recovery: expected a disposition object';
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !['type', 'effectId', 'attempt', 'descriptorHash', 'action', 'rationale'].includes(key))) return 'effect-recovery: result assertions and extra fields are forbidden';
  if (item['type'] !== 'EFFECT_RECOVERY' || item['effectId'] !== effectId || item['attempt'] !== attempt || item['descriptorHash'] !== descriptorHash) return 'effect-recovery: stale effect identity';
  if (!['retry', 'stop'].includes(String(item['action'])) || typeof item['rationale'] !== 'string' || !item['rationale'].trim()) return 'effect-recovery: retry or stop requires rationale';
  return null;
}
