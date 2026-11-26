import { isRecord } from "../lib/config.ts";
import type {
  PhasePolicy,
  ReadDelegate,
  LevelMap,
  SubagentEntry,
  UtilityEntry,
} from "../policy/roster.ts";
import { LEVELS } from "./types.ts";
import type { Level } from "./types.ts";

export const isLevel = (value: unknown): value is Level =>
  LEVELS.some((level) => level === value);

/** A value its writer already validated as a string; a violation is a fault, never coerced. */
export const textValue = (value: unknown) => {
  if (typeof value !== "string") {
    throw new TypeError(`Expected a string value, received ${typeof value}`);
  }

  return value;
};

/** A value an earlier invariant guarantees; a violation names what is missing. */
export const present = <T>(value: T | null | undefined, what: string) => {
  if (value === null || value === undefined) {
    throw new TypeError(`Missing ${what}`);
  }

  return value;
};

export const isPhaseTable = (
  value: unknown
): value is Readonly<Record<string, PhasePolicy>> => isRecord(value);

export const isReadDelegateTable = (
  value: unknown
): value is Readonly<Record<string, ReadDelegate>> => isRecord(value);

export const isWriterTable = (
  value: unknown
): value is Readonly<Record<string, LevelMap<SubagentEntry>>> =>
  isRecord(value);

export const isUtilityTable = (
  value: unknown
): value is Record<string, UtilityEntry> => isRecord(value);

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isStringMap = (value: unknown): value is Record<string, string> =>
  isRecord(value) &&
  Object.values(value).every((item) => typeof item === "string");

export const stringList = (value: unknown) => {
  if (!isStringList(value)) {
    throw new TypeError("Expected an array of strings");
  }

  return value;
};

export const stringMap = (value: unknown) => {
  if (!isStringMap(value)) {
    throw new TypeError("Expected a string map");
  }

  return value;
};
