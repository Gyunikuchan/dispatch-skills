/** Narrows a value that a surrounding invariant guarantees; a broken invariant fails here. */
export const defined = <T>(value: T | null | undefined) => {
  if (value === null || value === undefined) {
    throw new TypeError("Expected a defined value.");
  }

  return value;
};
