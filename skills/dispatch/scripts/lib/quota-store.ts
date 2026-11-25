import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { QuotaGeneration, QuotaKey, QuotaObservation } from '../toolkit/types.ts';
import { isRecord } from './config.ts';
import { parseJson } from './integrity.ts';
import type { JsonValue } from './integrity.ts';
import { nodeErrorCode, publishExclusive } from './fs-ext.ts';
import { nodeLinkFs } from './node-fs-ext.ts';
import { canonicalRepositoryRoot, readManifest } from './session.ts';

type QuotaStoreOptions = { sessionDir: string; repositoryRoot: string; bucketWidth: number };
type QuotaState = {
  generations: Array<QuotaGeneration>;
  observations: Array<QuotaObservation>;
  warnings: Array<string>;
};
const WARNING = 'Quota state unavailable; use the normal provider cascade.';
const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
const tuple = (key: QuotaKey): string => JSON.stringify([key.provider, key.model, key.mode]);
const copyKey = (key: QuotaKey): QuotaKey => ({ provider: key.provider, model: key.model, mode: key.mode });
const validKey = (key: QuotaKey): boolean =>
  typeof key.provider === 'string' &&
  !!key.provider.trim() &&
  typeof key.mode === 'string' &&
  !!key.mode.trim() &&
  (key.model === null || (typeof key.model === 'string' && !!key.model.trim())) &&
  Buffer.byteLength(tuple(key)) <= 2048;
const isKeyShape = (value: JsonValue | undefined): value is QuotaKey =>
  isRecord(value) &&
  typeof value['provider'] === 'string' &&
  typeof value['mode'] === 'string' &&
  (value['model'] === null || typeof value['model'] === 'string');
const isGenerationId = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const validGeneration = (value: JsonValue, key: QuotaKey): value is QuotaGeneration =>
  isRecord(value) &&
  value['schemaVersion'] === 1 &&
  isKeyShape(value['key']) &&
  validKey(value['key']) &&
  tuple(value['key']) === tuple(key) &&
  isGenerationId(value['generation']);
const isObservation = (row: QuotaGeneration): row is QuotaObservation =>
  'observedAt' in row &&
  typeof row.observedAt === 'number' &&
  Number.isSafeInteger(row.observedAt) &&
  'bucket' in row &&
  typeof row.bucket === 'number';
const missing = (error: unknown): boolean => nodeErrorCode(error) === 'ENOENT';

function realAncestors(file: string): void {
  const target = path.resolve(file),
    root = path.parse(target).root;
  let current = root;
  for (const part of target.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const info = fs.lstatSync(current);
      if (info.isSymbolicLink() || !samePath(fs.realpathSync(current), current)) {
        throw new Error('Linked quota path');
      }
    } catch (error) {
      if (!missing(error)) {
        throw error;
      }
    }
  }
}

function directory(options: QuotaStoreOptions, key: QuotaKey): string {
  if (!Number.isSafeInteger(options.bucketWidth) || options.bucketWidth <= 0 || !validKey(key)) {
    throw new Error('Invalid quota key or bucket width');
  }
  const repo = fs.realpathSync(options.repositoryRoot),
    session = path.resolve(options.sessionDir);
  realAncestors(session);
  realAncestors(path.join(session, 'manifest.json'));
  const manifest = readManifest(session);
  if (
    manifest.repositoryRoot !== canonicalRepositoryRoot(repo) ||
    !samePath(session, path.join(repo, '.scratch', 'dispatch-skills', manifest.folderName))
  ) {
    throw new Error('Quota session ownership mismatch');
  }
  const dir = path.join(session, '.state', 'quota', crypto.createHash('sha256').update(tuple(key)).digest('hex'));
  realAncestors(dir);
  return dir;
}

function readRecord(file: string, limit: number): JsonValue {
  realAncestors(file);
  let fd: number;
  try {
    if (!fs.lstatSync(file).isFile()) {
      throw new Error('Quota record is not a file');
    }
    fd = fs.openSync(file, 'r');
  } catch (error) {
    if (missing(error)) {
      return null;
    }
    throw error;
  }
  try {
    const bytes = Buffer.alloc(limit + 1);
    let total = 0,
      count: number;
    while (total < bytes.length && (count = fs.readSync(fd, bytes, total, bytes.length - total, null)) > 0) {
      total += count;
    }
    if (total > limit) {
      throw new Error('Oversized quota record');
    }
    return parseJson(bytes.subarray(0, total).toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

function marker(dir: string, key: QuotaKey, create: boolean): QuotaGeneration | null {
  const file = path.join(dir, 'generation.json');
  let value = readRecord(file, 8192);
  if (value === null && create) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fresh: QuotaGeneration = { schemaVersion: 1, key: copyKey(key), generation: crypto.randomUUID() };
    publishExclusive(nodeLinkFs, file, JSON.stringify(fresh));
    value = readRecord(file, 8192);
  }
  if (value === null) {
    return null;
  }
  if (!validGeneration(value, key)) {
    throw new Error('Invalid quota generation');
  }
  return value;
}

/** Read only the exact marker and two buckets for each configured key, including reserves. */
export function readQuotaState(options: QuotaStoreOptions, keys: ReadonlyArray<QuotaKey>, now: number): QuotaState {
  const result: QuotaState = { generations: [], observations: [], warnings: [] };
  if (!Number.isSafeInteger(now) || now < 0) {
    return { ...result, warnings: [WARNING] };
  }
  for (const key of keys) {
    try {
      const dir = directory(options, key),
        generation = marker(dir, key, true);
      if (!generation) {
        continue;
      }
      const observations: Array<QuotaObservation> = [];
      const bucket = Math.floor(now / options.bucketWidth);
      for (const number of [bucket, bucket - 1]) {
        if (number < 0) {
          continue;
        }
        try {
          const value = readRecord(path.join(dir, `${generation.generation}.${number}.json`), 4096);
          if (value === null) {
            continue;
          }
          if (
            !validGeneration(value, key) ||
            value.generation !== generation.generation ||
            !isObservation(value) ||
            value.bucket !== number ||
            value.observedAt < 0 ||
            Math.floor(value.observedAt / options.bucketWidth) !== number ||
            value.observedAt > now
          ) {
            throw new Error('Invalid quota observation');
          }
          if (now - value.observedAt < options.bucketWidth) {
            observations.push(value);
          }
        } catch {
          if (!result.warnings.length) {
            result.warnings.push(WARNING);
          }
        }
      }
      result.generations.push(generation);
      result.observations.push(...observations);
    } catch {
      if (!result.warnings.length) {
        result.warnings.push(WARNING);
      }
    }
  }
  return result;
}

type Publication = { published: boolean; warning?: string };

/** Publication never changes a marker, including for a late old-generation completion. */
export function publishQuotaFailure(
  options: QuotaStoreOptions,
  key: QuotaKey,
  generation: string,
  observedAt: number,
): Publication {
  try {
    const row: QuotaObservation = {
      schemaVersion: 1,
      key: copyKey(key),
      generation,
      observedAt,
      bucket: Math.floor(observedAt / options.bucketWidth),
    };
    if (!validKey(row.key) || !isGenerationId(row.generation) || !Number.isSafeInteger(observedAt) || observedAt < 0) {
      throw new Error('Invalid quota observation');
    }
    const dir = directory(options, key),
      file = path.join(dir, `${generation}.${row.bucket}.json`);
    realAncestors(path.join(dir, 'generation.json'));
    realAncestors(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { published: publishExclusive(nodeLinkFs, file, JSON.stringify(row)) };
  } catch {
    return { published: false, warning: WARNING };
  }
}

/** Reset one exact key; concurrent replacements retain the last complete generation. */
export function reprobeQuota(options: QuotaStoreOptions, key: QuotaKey): QuotaGeneration {
  const dir = directory(options, key),
    file = path.join(dir, 'generation.json');
  realAncestors(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let previous: JsonValue;
  try {
    previous = readRecord(file, 8192);
  } catch {
    previous = null;
  }
  const generation: QuotaGeneration = { schemaVersion: 1, key: copyKey(key), generation: crypto.randomUUID() };
  try {
    nodeLinkFs.writeAtomic(file, JSON.stringify(generation));
  } catch (error) {
    // NOTE: Windows can refuse an overlapping rename; a completed concurrent reset satisfies this reprobe.
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(String(nodeErrorCode(error)))) {
      const current = readRecord(file, 8192);
      if (
        validGeneration(current, key) &&
        (!validGeneration(previous, key) || current.generation !== previous.generation)
      ) {
        return current;
      }
    }
    throw error;
  }
  return generation;
}
