import assert from "node:assert/strict";

import { isRecord } from "../../../skills/dispatch/scripts/lib/config.ts";
import type { JsonValue } from "../../../skills/dispatch/scripts/lib/config.ts";

export type Guard<T> = (candidate: unknown) => candidate is T;

type Guarded<G> = G extends Guard<infer T> ? T : never;

export const isString: Guard<string> = (candidate): candidate is string =>
  String(candidate) === candidate;

export const isNumber: Guard<number> = (candidate): candidate is number =>
  Number.isFinite(candidate);

export const isBoolean: Guard<boolean> = (candidate): candidate is boolean =>
  candidate === true || candidate === false;

export const maybe = <T>(guard: Guard<T>) => {
  const maybeGuard: Guard<T | undefined> = (
    candidate
  ): candidate is T | undefined => candidate === undefined || guard(candidate);

  return maybeGuard;
};

export const nullable = <T>(guard: Guard<T>) => {
  const nullableGuard: Guard<T | null> = (candidate): candidate is T | null =>
    candidate === null || guard(candidate);

  return nullableGuard;
};

export const arrayOf = <T>(guard: Guard<T>) => {
  const arrayGuard: Guard<T[]> = (candidate): candidate is T[] =>
    Array.isArray(candidate) && candidate.every((item) => guard(item));

  return arrayGuard;
};

export const objectWith = <S extends { [key: string]: Guard<unknown> }>(
  fields: S
) => {
  const objectGuard: Guard<{ [K in keyof S]: Guarded<S[K]> }> = (
    candidate
  ): candidate is { [K in keyof S]: Guarded<S[K]> } =>
    isRecord(candidate) &&
    Object.entries(fields).every(([key, guard]) => guard(candidate[key]));

  return objectGuard;
};

/** Returns the same value, typed; a mismatch fails the test and prints what arrived. */
export const narrow = <T>(candidate: JsonValue, guard: Guard<T>) => {
  if (guard(candidate)) {
    return candidate;
  }

  return assert.fail(`unexpected JSON shape: ${JSON.stringify(candidate)}`);
};

export const text = (candidate: JsonValue) => narrow(candidate, isString);

/** The element a test requires to exist. */
export const defined = <T>(candidate: T | null | undefined, what = "value") => {
  if (candidate === null || candidate === undefined) {
    assert.fail(`missing ${what}`);
  }

  return candidate;
};
