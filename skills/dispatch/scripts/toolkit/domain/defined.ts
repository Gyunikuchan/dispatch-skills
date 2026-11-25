/** Narrows a value that a surrounding invariant guarantees; a broken invariant fails here. */
export function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new TypeError('Expected a defined value.');
  }
  return value;
}
