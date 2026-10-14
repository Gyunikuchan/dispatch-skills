import { EngineFault } from './engine-fault.ts';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function fail(detail: string): never { throw new EngineFault(`checkpoint-invalid: ${detail}`); }

export function encodePrivate(value: unknown): unknown {
  if (value === undefined) return { $private: 'undefined' };
  if (value instanceof Map) return { $private: 'map', entries: [...value].map(([key, item]) => [encodePrivate(key), encodePrivate(item)]) };
  if (value instanceof Set) return { $private: 'set', entries: [...value].map(encodePrivate) };
  if (Array.isArray(value)) return value.map(encodePrivate);
  if (record(value)) {
    if ('$private' in value || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('unsupported private object');
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodePrivate(item)]));
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  return fail('unsupported private value');
}

export function decodePrivate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodePrivate);
  if (!record(value)) return value;
  if ('$private' in value) {
    if (value['$private'] === 'undefined' && Object.keys(value).length === 1) return undefined;
    if (!Array.isArray(value['entries']) || Object.keys(value).length !== 2) fail('private container');
    const entries = value['entries'] as unknown[];
    if (value['$private'] === 'set') {
      const decoded = entries.map(decodePrivate), result = new Set(decoded);
      if (result.size !== entries.length) fail('duplicate set entry');
      return result;
    }
    if (value['$private'] === 'map') {
      if (!entries.every((entry) => Array.isArray(entry) && entry.length === 2)) fail('map entry');
      const decoded = (entries as unknown[][]).map((entry) => [decodePrivate(entry[0]), decodePrivate(entry[1])] as const), result = new Map(decoded);
      if (result.size !== entries.length) fail('duplicate map entry');
      return result;
    }
    return fail('unknown private container');
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodePrivate(item)]));
}
