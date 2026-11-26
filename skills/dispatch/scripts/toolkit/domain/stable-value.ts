import { isRecord } from "../../lib/config.ts";

/** Canonical JSON value encoding makes protocol comparisons independent of object key order. */
export const stableValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableValue).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? String(value);
};
