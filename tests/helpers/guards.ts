import assert from "node:assert/strict";

/** The narrowed value, or throws when it is missing. */
export const defined = <T>(value: T | null | undefined) => {
  assert.ok(value !== null && value !== undefined);

  return value;
};

/** Whether the value is a string. */
export const isString = <T>(value: T): value is T & string =>
  typeof value === "string";

/** Whether the value is a number. */
export const isNumber = <T>(value: T): value is T & number =>
  typeof value === "number";

/** Whether the value is a non-null object. */
export const isObject = <T>(value: T): value is T & object =>
  typeof value === "object" && value !== null;

/** The `code` of a thrown value, when it carries one. */
export const errorCode = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  isString(error.code)
    ? error.code
    : undefined;
