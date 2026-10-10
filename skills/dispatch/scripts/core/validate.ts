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
const LEGACY_DECIDE_KINDS = lit('approval', 'baseline', 'failure', 'concerns', 'escalation', 'needs-user', 'opt-in');
const strings = arr(str);
const nullableString: Validator<string | null> = (value, at) => value === null ? ok(null) : str(value, at);
const nullableBoolean: Validator<boolean | null> = (value, at) => value === null || typeof value === 'boolean' ? ok(value) : fail(at, 'boolean or null', value);
const nonBlank: Validator<string> = (value, at) => typeof value === 'string' && value.trim().length > 0 ? ok(value) : fail(at, 'non-empty trimmed string', value);
const boundedText = (max: number): Validator<string> => (value, at) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max ? ok(value) : fail(at, `non-empty trimmed string of at most ${max} characters`, value);
const incrementDelta = obj({ id: str, prerequisites: strings, paths: strings, acceptance: strings });
const scopeCriterion = obj({ id: str, title: nonBlank, changes: strings, verify: arr(obj({ command: nonBlank, final: lit(true, false) })), evidence: oneOf(lit('red', 'verify', 'review'), (value, at) => value === null ? ok(null) : fail(at, 'evidence class or null', value)), preExisting: nullableBoolean, redException: nullableString, testRationale: nullableString, review: nullableString, enforcementInfeasibility: nullableString });
const scopeDelta = obj({ paths: strings, criteria: strings, criterionDefinitions: opt(arr(scopeCriterion)), obligations: strings, commands: strings, finalCommands: opt(strings), phaseDuties: strings, increments: arr(incrementDelta) });
const criterionScope = obj({ id: str, title: nonBlank, changes: strings, verify: strings, review: nullableString, evidence: str });
const commandScope = obj({ command: str, criteria: strings, paths: strings, final: lit(true, false) });
const baselineScope = obj({ command: str, status: str, exit: num, inputFingerprint: str });
const remainingIncrement = obj({ id: str, priority: num, outcome: nonBlank, dependencies: strings, paths: strings, acceptance: strings });
const designScope = obj({ path: str, hash: str, title: nullableString, objective: nonBlank, invariants: strings, fields: rec(str), remainingIncrements: arr(remainingIncrement) });
const levelGateScope = obj({
  planHash: str, objective: str, invariants: strings, criteria: arr(criterionScope), approvedPaths: strings,
  commandMappings: arr(commandScope), baselineEvidence: arr(baselineScope),
  phaseObligations: obj({ writer: strings, review: strings }), remainingIncrements: arr(remainingIncrement), design: oneOf(designScope, (value, at) => value === null ? ok(null) : fail(at, 'design object or null', value)),
});
const deviationTask = obj({ requestId: str, source: lit('task'), task: str, baseArtifactHash: str, writerRationale: nonBlank, delta: scopeDelta });
const deviationHotfix = obj({ requestId: str, source: lit('hotfix'), baseArtifactHash: str, writerRationale: nonBlank, delta: scopeDelta });
const revisionPlan = obj({ requestId: str, source: lit('plan-revision'), baseArtifactHash: str, proposedArtifactHash: str, affectedTasks: strings, rationale: nonBlank, delta: scopeDelta });
const revisionDesign = obj({ requestId: str, source: lit('design-revision'), baseArtifactHash: str, proposedArtifactHash: str, affectedIncrements: strings, rationale: nonBlank, delta: scopeDelta });
const scopeProposal = oneOf(deviationTask, deviationHotfix, revisionPlan, revisionDesign);
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

export const HOST_EVENT_SHAPES: { readonly [K in HostEventType]: Validator<Record<string, unknown>> } = {
  AUTHORED: obj({ type: lit('AUTHORED'), path: str }),
  NATIVE_RESULTS: obj({ type: lit('NATIVE_RESULTS'), slots: arr(nativeSlot) }),
  RULINGS: obj({ type: lit('RULINGS'), rulings: rec(payload) }),
  FIXES_APPLIED: obj({ type: lit('FIXES_APPLIED'), clusters: arr(payload) }),
  WRITE_LAUNCHED: obj({ type: lit('WRITE_LAUNCHED'), tasks: arr(obj({ task: str, attempt: positiveInt, signature: str, handle: str, model: nonBlank, effort: opt(str), substitution: opt(nonBlank) })) }),
  WRITE_ENVELOPE: oneOf(
    obj({ type: lit('WRITE_ENVELOPE'), envelopePath: str, ...attestation }),
    obj({ type: lit('WRITE_ENVELOPE'), envelopePath: str, task: str, attempt: positiveInt, signature: str, handle: str, ...attestation }),
  ),
  WRITE_FAILED: oneOf(
    obj({ type: lit('WRITE_FAILED'), model: str, kind: str, reason: str, ...attestation }),
    obj({ type: lit('WRITE_FAILED'), model: str, kind: str, reason: str, task: str, attempt: positiveInt, signature: str, handle: str, ...attestation }),
  ),
  WRITE_CANCELLED: obj({ type: lit('WRITE_CANCELLED'), task: str, attempt: positiveInt, signature: str, handle: str, reason: str, ...attestation }),
  EVIDENCE: obj({ type: lit('EVIDENCE'), criteria: rec(payload), waiver: opt(obj({ by: lit('user'), quote: nonBlank })) }),
  DECISION: oneOf(
    obj({ type: lit('DECISION'), kind: lit('drift'), answer: obj({ by: lit('orchestrator'), noticeId: nonBlank, afterHash: nonBlank, action: lit('preserve', 'refresh', 'reconcile', 'escalate'), rationale: nonBlank, evidenceIds: strings }) }),
    obj({ type: lit('DECISION'), kind: lit('level-classification'), answer: obj({ evaluatedLevel: lit('low', 'medium', 'high'), rationale: boundedText(500), gateScope: levelGateScope }) }),
    obj({ type: lit('DECISION'), kind: lit('level-recommendation'), answer: obj({ choice: lit('adopt', 'retain'), quote: nonBlank }) }),
    obj({ type: lit('DECISION'), kind: lit('scope-deviation'), answer: obj({ by: lit('orchestrator'), request: scopeProposal, ruling: lit('approve', 'disagree'), rationale: nonBlank }) }),
    obj({ type: lit('DECISION'), kind: lit('scope-deviation-user'), answer: obj({ by: lit('user'), requestId: str, choice: lit('accept', 'decline'), quote: nonBlank }) }),
    obj({ type: lit('DECISION'), kind: lit('run-stop'), answer: obj({ by: lit('user'), quote: nonBlank }) }),
    obj({ type: lit('DECISION'), kind: LEGACY_DECIDE_KINDS, answer: any }),
  ),
  REVISE: obj({ type: lit('REVISE'), artifact: lit('plan', 'design'), reason: str, evidence: str }),
  // Per-item gating (≤3 items, dispatch-owned component, redaction) happens at render time, so a bad item never blocks completion.
  RETRO: obj({ type: lit('RETRO'), observations: arr(any) }),
};

// NOTE: REVISE is accepted at every live await; the machine's validate hook narrows it (spec §5.7).
export const AWAIT_ACCEPTS: { readonly [K in Await]: readonly HostEventType[] } = {
  author: ['AUTHORED', 'REVISE'],
  native: ['NATIVE_RESULTS', 'REVISE'],
  rule: ['RULINGS', 'REVISE'],
  fix: ['FIXES_APPLIED', 'REVISE'],
  write: ['WRITE_LAUNCHED', 'WRITE_ENVELOPE', 'WRITE_FAILED', 'WRITE_CANCELLED', 'REVISE'],
  evidence: ['EVIDENCE', 'REVISE'],
  decide: ['DECISION', 'REVISE'],
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
