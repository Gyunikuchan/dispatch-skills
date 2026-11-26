// Runtime-checked readers for parsed JSON, so tests narrow values instead of casting them.
import assert from "node:assert/strict";
import fs from "node:fs";

export type JsonValue =
  | boolean
  | number
  | string
  | null
  | undefined
  | readonly JsonValue[]
  | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type Check<T> = (value: unknown) => value is T;

export type Checked<C> = C extends Check<infer T> ? T : never;

interface Fields {
  readonly [key: string]: Check<unknown>;
}

type WithFields<F extends Fields> = { -readonly [K in keyof F]: Checked<F[K]> };

export const anything: Check<unknown> = (_value): _value is unknown => true;

export const text: Check<string> = (value: unknown): value is string =>
  typeof value === "string";

export const numeric: Check<number> = (value: unknown): value is number =>
  typeof value === "number";

export const flag: Check<boolean> = (value: unknown): value is boolean =>
  typeof value === "boolean";

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const optional =
  <T>(check: Check<T>) =>
  (value: unknown): value is T | undefined =>
    value === undefined || check(value);

export const nullable =
  <T>(check: Check<T>) =>
  (value: unknown): value is T | null =>
    value === null || check(value);

export const listOf =
  <T>(check: Check<T>) =>
  (value: unknown): value is T[] =>
    Array.isArray(value) && value.every((item) => check(item));

export const dictionaryOf =
  <T>(check: Check<T>) =>
  (value: unknown): value is { [key: string]: T } =>
    isObject(value) && Object.values(value).every((item) => check(item));

export const literal =
  <const T extends readonly (boolean | number | string)[]>(...values: T) =>
  (value: unknown): value is T[number] =>
    values.some((candidate) => candidate === value);

/** Checks the named fields; other properties stay on the value untouched. */
export const withFields =
  <F extends Fields>(fields: F) =>
  (value: unknown): value is WithFields<F> => {
    if (!isObject(value)) {
      return false;
    }

    const present = new Map<string, unknown>(Object.entries(value));

    // NOTE: Error.message is a non-enumerable own property, so read it by name.
    if (value instanceof Error) {
      present.set("message", value.message);
    }

    return Object.entries(fields).every(([key, check]) =>
      check(present.get(key))
    );
  };

export const both =
  <A, B>(first: Check<A>, second: Check<B>) =>
  (value: unknown): value is A & B =>
    first(value) && second(value);

export const isError: Check<Error> = (value: unknown): value is Error =>
  value instanceof Error;

export const jsonValue: Check<JsonValue> = (
  value: unknown
): value is JsonValue =>
  value === null ||
  ["boolean", "number", "string", "undefined"].includes(typeof value) ||
  (typeof value === "object" &&
    Object.values(value).every((item) => jsonValue(item)));

export const jsonObject: Check<JsonObject> = (
  value: unknown
): value is JsonObject => isObject(value) && jsonValue(value);

/** The reason and message fields that toolkit refusals expose. */
export const refusal = withFields({
  reason: optional(text),
  message: optional(text),
});

/** A thrown toolkit refusal. */
export const toolFailure = both(isError, withFields({ reason: text }));

export const narrow = <T>(value: unknown, check: Check<T>) => {
  if (!check(value)) {
    return assert.fail(`Unexpected value withFields: ${JSON.stringify(value)}`);
  }

  return value;
};

export const parseJson = <T>(source: string, check: Check<T>) =>
  narrow(JSON.parse(source), check);

export const readJson = <T>(file: string, check: Check<T>) =>
  parseJson(fs.readFileSync(file, "utf-8"), check);
