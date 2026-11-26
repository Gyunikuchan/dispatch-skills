import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  QuotaGeneration,
  QuotaKey,
  QuotaObservation,
} from "../toolkit/types.ts";
import { isRecord } from "./config.ts";
import { nodeErrorCode, publishExclusive } from "./fs-ext.ts";
import { parseJson } from "./integrity.ts";
import type { JsonValue } from "./integrity.ts";
import { nodeLinkFs } from "./node-fs-ext.ts";
import { canonicalRepositoryRoot, readManifest } from "./session.ts";

interface QuotaStoreOptions {
  sessionDir: string;
  repositoryRoot: string;
  bucketWidth: number;
}

interface QuotaState {
  generations: QuotaGeneration[];
  observations: QuotaObservation[];
  warnings: string[];
}

const WARNING = "Quota state unavailable; use the normal provider cascade.";

const samePath = (a: string, b: string) =>
  process.platform === "win32"
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);

const tuple = (key: QuotaKey) =>
  JSON.stringify([key.provider, key.model, key.mode]);

const copyKey = (key: QuotaKey) => ({
  provider: key.provider,
  model: key.model,
  mode: key.mode,
});

const validKey = (key: QuotaKey) =>
  typeof key.provider === "string" &&
  !!key.provider.trim() &&
  typeof key.mode === "string" &&
  !!key.mode.trim() &&
  (key.model === null ||
    (typeof key.model === "string" && !!key.model.trim())) &&
  Buffer.byteLength(tuple(key)) <= 2048;

const isKeyShape = (value: unknown): value is QuotaKey =>
  isRecord(value) &&
  typeof value["provider"] === "string" &&
  typeof value["mode"] === "string" &&
  (value["model"] === null || typeof value["model"] === "string");

const isGenerationId = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9-]{36}$/u.test(value);

const validGeneration = (
  value: unknown,
  key: QuotaKey
): value is QuotaGeneration =>
  isRecord(value) &&
  value["schemaVersion"] === 1 &&
  isKeyShape(value["key"]) &&
  validKey(value["key"]) &&
  tuple(value["key"]) === tuple(key) &&
  isGenerationId(value["generation"]);

const isObservation = (row: QuotaGeneration): row is QuotaObservation =>
  "observedAt" in row &&
  typeof row.observedAt === "number" &&
  Number.isSafeInteger(row.observedAt) &&
  "bucket" in row &&
  typeof row.bucket === "number";

const missing = (error: unknown) => nodeErrorCode(error) === "ENOENT";

const realAncestors = (file: string) => {
  const target = path.resolve(file);
  const { root } = path.parse(target);

  let current = root;

  for (const part of target
    .slice(root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);

    try {
      const info = fs.lstatSync(current);

      if (
        info.isSymbolicLink() ||
        !samePath(fs.realpathSync(current), current)
      ) {
        throw new Error("Linked quota path");
      }
    } catch (error) {
      if (!missing(error)) {
        throw error;
      }
    }
  }
};

const directory = (options: QuotaStoreOptions, key: QuotaKey) => {
  if (
    !Number.isSafeInteger(options.bucketWidth) ||
    options.bucketWidth <= 0 ||
    !validKey(key)
  ) {
    throw new Error("Invalid quota key or bucket width");
  }

  const repo = fs.realpathSync(options.repositoryRoot);
  const session = path.resolve(options.sessionDir);

  realAncestors(session);
  realAncestors(path.join(session, "manifest.json"));
  const manifest = readManifest(session);

  if (
    manifest.repositoryRoot !== canonicalRepositoryRoot(repo) ||
    !samePath(
      session,
      path.join(repo, ".scratch", "dispatch-skills", manifest.folderName)
    )
  ) {
    throw new Error("Quota session ownership mismatch");
  }

  const dir = path.join(
    session,
    ".state",
    "quota",
    crypto.createHash("sha256").update(tuple(key)).digest("hex")
  );

  realAncestors(dir);

  return dir;
};

const readRecord = (file: string, limit: number) => {
  realAncestors(file);
  let fd: number;

  try {
    if (!fs.lstatSync(file).isFile()) {
      throw new Error("Quota record is not a file");
    }

    fd = fs.openSync(file, "r");
  } catch (error) {
    if (missing(error)) {
      return null;
    }

    throw error;
  }

  try {
    const bytes = Buffer.alloc(limit + 1);

    let count: number;
    let total = 0;

    while (
      total < bytes.length &&
      (count = fs.readSync(fd, bytes, total, bytes.length - total, null)) > 0
    ) {
      total += count;
    }

    if (total > limit) {
      throw new Error("Oversized quota record");
    }

    return parseJson(bytes.subarray(0, total).toString("utf-8"));
  } finally {
    fs.closeSync(fd);
  }
};

const marker = (dir: string, key: QuotaKey, create: boolean) => {
  const file = path.join(dir, "generation.json");
  let value = readRecord(file, 8192);

  if (value === null && create) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const fresh: QuotaGeneration = {
      schemaVersion: 1,
      key: copyKey(key),
      generation: crypto.randomUUID(),
    };

    publishExclusive(nodeLinkFs, file, JSON.stringify(fresh));
    value = readRecord(file, 8192);
  }

  if (value === null) {
    return null;
  }

  if (!validGeneration(value, key)) {
    throw new Error("Invalid quota generation");
  }

  return value;
};

/** Read only the exact marker and two buckets for each configured key, including reserves. */
export const readQuotaState = (
  options: QuotaStoreOptions,
  keys: readonly QuotaKey[],
  now: number
) => {
  const result: QuotaState = {
    generations: [],
    observations: [],
    warnings: [],
  };

  if (!Number.isSafeInteger(now) || now < 0) {
    return { ...result, warnings: [WARNING] };
  }

  for (const key of keys) {
    try {
      const dir = directory(options, key);
      const generation = marker(dir, key, true);

      if (generation === null) {
        continue;
      }

      const observations: QuotaObservation[] = [];
      const bucket = Math.floor(now / options.bucketWidth);

      for (const number of [bucket, bucket - 1]) {
        if (number < 0) {
          continue;
        }

        try {
          const value = readRecord(
            path.join(dir, `${generation.generation}.${number}.json`),
            4096
          );

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
            throw new Error("Invalid quota observation");
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
};

/** Publication never changes a marker, including for a late old-generation completion. */
export const publishQuotaFailure = (
  options: QuotaStoreOptions,
  key: QuotaKey,
  generation: string,
  observedAt: number
) => {
  try {
    const row: QuotaObservation = {
      schemaVersion: 1,
      key: copyKey(key),
      generation,
      observedAt,
      bucket: Math.floor(observedAt / options.bucketWidth),
    };

    if (
      !validKey(row.key) ||
      !isGenerationId(row.generation) ||
      !Number.isSafeInteger(observedAt) ||
      observedAt < 0
    ) {
      throw new Error("Invalid quota observation");
    }

    const dir = directory(options, key);
    const file = path.join(dir, `${generation}.${row.bucket}.json`);

    realAncestors(path.join(dir, "generation.json"));
    realAncestors(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    return {
      published: publishExclusive(nodeLinkFs, file, JSON.stringify(row)),
    };
  } catch {
    return { published: false, warning: WARNING };
  }
};

/** Reset one exact key; concurrent replacements retain the last complete generation. */
export const reprobeQuota = (options: QuotaStoreOptions, key: QuotaKey) => {
  const dir = directory(options, key);
  const file = path.join(dir, "generation.json");

  realAncestors(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let previous: JsonValue | null;

  try {
    previous = readRecord(file, 8192);
  } catch {
    previous = null;
  }

  const generation: QuotaGeneration = {
    schemaVersion: 1,
    key: copyKey(key),
    generation: crypto.randomUUID(),
  };

  try {
    nodeLinkFs.writeAtomic(file, JSON.stringify(generation));
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EPERM", "EACCES"].includes(String(nodeErrorCode(error)))
    ) {
      const current = readRecord(file, 8192);

      /* oxlint-disable anti-slop/no-known-value-widening -- previous is parsed JSON of the same generation schema; the unknown shape guard is intentional. */
      if (
        validGeneration(current, key) &&
        (!validGeneration(previous, key) ||
          current.generation !== previous.generation)
      ) {
        return current;
      }
      /* oxlint-enable anti-slop/no-known-value-widening */
    }

    throw error;
  }

  return generation;
};
