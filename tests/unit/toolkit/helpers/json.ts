// Runtime-checked readers for parsed JSON, so tests narrow values instead of casting them.
import assert from 'node:assert/strict';
import fs from 'node:fs';

export type JsonValue = boolean | number | string | null | undefined | ReadonlyArray<JsonValue> | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export type Check<T> = (value: unknown) => value is T;
export type Checked<C> = C extends Check<infer T> ? T : never;
type Fields = { readonly [key: string]: Check<unknown> };
type Shaped<F extends Fields> = { -readonly [K in keyof F]: Checked<F[K]> };

export const anything: Check<unknown> = (value): value is unknown => true;
export const text: Check<string> = (value): value is string => typeof value === 'string';
export const numeric: Check<number> = (value): value is number => typeof value === 'number';
export const flag: Check<boolean> = (value): value is boolean => typeof value === 'boolean';

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function optional<T>(check: Check<T>): Check<T | undefined> {
  return (value): value is T | undefined => value === undefined || check(value);
}

export function nullable<T>(check: Check<T>): Check<T | null> {
  return (value): value is T | null => value === null || check(value);
}

export function listOf<T>(check: Check<T>): Check<Array<T>> {
  return (value): value is Array<T> => Array.isArray(value) && value.every((item) => check(item));
}

export function dictionaryOf<T>(check: Check<T>): Check<{ [key: string]: T }> {
  return (value): value is { [key: string]: T } => isObject(value) && Object.values(value).every((item) => check(item));
}

export function literal<const T extends ReadonlyArray<boolean | number | string>>(...values: T): Check<T[number]> {
  return (value): value is T[number] => values.some((candidate) => candidate === value);
}

/** Checks the named fields; other properties stay on the value untouched. */
export function shape<F extends Fields>(fields: F): Check<Shaped<F>> {
  return (value): value is Shaped<F> => {
    if (!isObject(value)) {
      return false;
    }
    const present = new Map<string, unknown>(Object.entries(value));
    // NOTE: Error.message is a non-enumerable own property, so read it by name.
    if (value instanceof Error) {
      present.set('message', value.message);
    }
    return Object.entries(fields).every(([key, check]) => check(present.get(key)));
  };
}

export function both<A, B>(first: Check<A>, second: Check<B>): Check<A & B> {
  return (value): value is A & B => first(value) && second(value);
}

export const isError: Check<Error> = (value): value is Error => value instanceof Error;

export const jsonValue: Check<JsonValue> = (value): value is JsonValue =>
  value === null ||
  ['boolean', 'number', 'string', 'undefined'].includes(typeof value) ||
  (typeof value === 'object' && Object.values(value).every((item) => jsonValue(item)));

export const jsonObject: Check<JsonObject> = (value): value is JsonObject => isObject(value) && jsonValue(value);

/** The reason and message fields that toolkit refusals expose. */
export const refusal = shape({ reason: optional(text), message: optional(text) });

/** A thrown toolkit refusal. */
export const toolFailure = both(isError, shape({ reason: text }));

export function narrow<T>(value: unknown, check: Check<T>): T {
  if (!check(value)) {
    return assert.fail('Unexpected value shape: ' + String(JSON.stringify(value)));
  }
  return value;
}

export function parseJson<T>(source: string, check: Check<T>): T {
  return narrow(JSON.parse(source), check);
}

export function readJson<T>(file: string, check: Check<T>): T {
  return parseJson(fs.readFileSync(file, 'utf8'), check);
}
