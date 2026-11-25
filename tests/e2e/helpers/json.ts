// Runtime guards for the JSON that e2e tests read back, so each test names and verifies the fields it uses.
import assert from 'node:assert/strict';
import { isRecord } from '../../../skills/dispatch/scripts/lib/config.ts';

export type Guard<T> = (value: unknown) => value is T;
type Guarded<G> = G extends Guard<infer T> ? T : never;
export const isString: Guard<string> = (value) => typeof value === 'string';
export const isNumber: Guard<number> = (value) => typeof value === 'number';
export const isBoolean: Guard<boolean> = (value) => typeof value === 'boolean';

export function maybe<T>(guard: Guard<T>): Guard<T | undefined> {
  return (value): value is T | undefined => value === undefined || guard(value);
}

export function nullable<T>(guard: Guard<T>): Guard<T | null> {
  return (value): value is T | null => value === null || guard(value);
}

export function arrayOf<T>(guard: Guard<T>): Guard<Array<T>> {
  return (value): value is Array<T> => Array.isArray(value) && value.every((item) => guard(item));
}

export function objectWith<S extends { [key: string]: Guard<unknown> }>(
  shape: S,
): Guard<{ [K in keyof S]: Guarded<S[K]> }> {
  return (value): value is { [K in keyof S]: Guarded<S[K]> } =>
    isRecord(value) && Object.entries(shape).every(([key, guard]) => guard(value[key]));
}

/** Returns the same value, typed; a mismatch fails the test and prints what arrived. */
export function narrow<T>(value: unknown, guard: Guard<T>): T {
  assert.ok(guard(value), 'unexpected JSON shape: ' + JSON.stringify(value));
  return value;
}

export const text = (value: unknown): string => narrow(value, isString);

/** The element a test requires to exist. */
export function defined<T>(value: T | null | undefined, what = 'value'): T {
  assert.ok(value !== null && value !== undefined, 'missing ' + what);
  return value;
}
