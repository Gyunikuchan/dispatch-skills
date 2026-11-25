// Narrowing for values the toolkit reads from the open ledger, saved state and config shapes.
import { isRecord } from '../lib/config.ts';
import type { PhasePolicy, ReadDelegate } from '../policy/roster.ts';
import type { LevelMap, SubagentEntry, UtilityEntry } from '../policy/roster.ts';
import { LEVELS } from './types.ts';
import type { Level } from './types.ts';

export const isLevel = (value: unknown): value is Level => LEVELS.some((level) => level === value);

/** A value its writer already validated as a string; a violation is a fault, never coerced. */
export function textValue(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('Expected a string value, received ' + typeof value);
  }
  return value;
}

/** A value an earlier invariant guarantees; a violation names what is missing. */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new TypeError('Missing ' + what);
  }
  return value;
}

// SECTION: Config sections
// `validateConfig` owns the entry shapes; these guards only prove the section is a table.

export const isPhaseTable = (value: unknown): value is Readonly<Record<string, PhasePolicy>> => isRecord(value);
export const isReadDelegateTable = (value: unknown): value is Readonly<Record<string, ReadDelegate>> => isRecord(value);
export const isWriterTable = (value: unknown): value is Readonly<Record<string, LevelMap<SubagentEntry>>> =>
  isRecord(value);
export const isUtilityTable = (value: unknown): value is Record<string, UtilityEntry> => isRecord(value);

// SECTION: Ledger collections
// `validateRecord` owns element checks; a violation here is a fault.

const isStringList = (value: unknown): value is Array<string> =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const isStringMap = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === 'string');

export function stringList(value: unknown): Array<string> {
  if (!isStringList(value)) {
    throw new TypeError('Expected an array of strings');
  }
  return value;
}

export function stringMap(value: unknown): Record<string, string> {
  if (!isStringMap(value)) {
    throw new TypeError('Expected a string map');
  }
  return value;
}
