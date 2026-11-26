import fs from "node:fs";
import path from "node:path";

import { isRecord } from "../lib/config.ts";
import { nodeErrorCode } from "../lib/fs-ext.ts";
import { ToolError } from "./output.ts";

interface LockOwner {
  pid: number;
  host: string;
  at: string;
  tool?: string;
}

export interface LockDeps {
  pid: number;
  host: string;
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  isAlive: (pid: number) => boolean;
}

const read = (file: string) => {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return null;
    }

    throw error;
  }
};

const isLockOwner = (value: unknown): value is LockOwner =>
  isRecord(value) &&
  typeof value["pid"] === "number" &&
  Number.isSafeInteger(value["pid"]) &&
  value["pid"] > 0 &&
  typeof value["host"] === "string" &&
  !!value["host"].trim() &&
  typeof value["at"] === "string" &&
  !!value["at"].trim();

const owner = (bytes: string) => {
  try {
    const value: unknown = JSON.parse(bytes);

    return isLockOwner(value) ? value : null;
  } catch {
    return null;
  }
};

const create = (file: string, bytes: string) => {
  try {
    fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });

    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "EEXIST") {
      return false;
    }

    throw error;
  }
};

// Breaker slots are `lock.break`, `lock.break.1`, ... A breaker that died mid-break never removes its slot, so contenders
// skip dead slots instead of deleting them; removing one could displace a live breaker that replaced it.
const activeBreaker = (breaker: string, deps: LockDeps) => {
  for (let n = 0; ; n += 1) {
    const file = n === 0 ? breaker : `${breaker}.${n}`;
    const bytes = read(file);
    const dead = bytes === null ? null : owner(bytes);

    if (dead && dead.host === deps.host && !deps.isAlive(dead.pid)) {
      continue;
    }

    return { file, bytes };
  }
};

export const withLock = async <T>(
  session: string,
  tool: string,
  deps: LockDeps,
  fn: (broken: LockOwner | null) => Promise<T>
) =>
  await withLockFile(
    path.join(session, ".state", "lock"),
    tool,
    deps,
    10_000,
    fn
  );

// oxlint-disable-next-line eslint/complexity -- acquisition branches per breaker slot, stale-owner liveness, and deadline retry.
export const withLockFile = async <T>(
  lock: string,
  tool: string,
  deps: LockDeps,
  waitMs: number,
  fn: (broken: LockOwner | null) => Promise<T>
) => {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const breaker = `${lock}.break`;

  const ours = JSON.stringify({
    pid: deps.pid,
    host: deps.host,
    at: new Date(deps.clock()).toISOString(),
    tool,
  });

  const start = deps.clock();
  let waited = 0;
  let broken: LockOwner | null = null;

  while (true) {
    const slot = activeBreaker(breaker, deps);
    let held = slot.bytes ?? read(lock);

    if (slot.bytes === null && held === null && create(lock, ours)) {
      break;
    }

    if (slot.bytes === null && held !== null) {
      const stale = owner(held);

      if (
        stale &&
        stale.host === deps.host &&
        !deps.isAlive(stale.pid) &&
        create(slot.file, ours)
      ) {
        try {
          if (read(lock) === held) {
            fs.unlinkSync(lock);

            if (create(lock, ours)) {
              broken = stale;
              break;
            }
          }
        } finally {
          if (read(slot.file) === ours) {
            fs.unlinkSync(slot.file);
          }
        }
      }
    }

    const current = activeBreaker(breaker, deps);
    held = current.bytes ?? read(lock) ?? held;

    if (waited >= waitMs || deps.clock() - start >= waitMs) {
      const holder = owner(held ?? "");
      const file = current.bytes === null ? lock : current.file;
      throw new ToolError(
        3,
        "lock-held",
        holder
          ? `lock held by pid ${holder.pid} on ${holder.host}`
          : `lock holder unreadable at ${file}`
      );
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- iterations share mutable orchestration state and control flow; sequential execution is by design.
    await deps.sleep(100);
    waited += 100;
  }

  try {
    return await fn(broken);
  } finally {
    if (read(lock) === ours) {
      fs.unlinkSync(lock);
    }
  }
};
