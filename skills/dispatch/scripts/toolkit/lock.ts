import fs from 'node:fs';
import path from 'node:path';
import { ToolError } from './output.ts';

export type LockOwner = { pid: number; host: string; at: string; tool?: string };
export type LockDeps = {
  pid: number; host: string; clock: () => number;
  sleep: (ms: number) => Promise<void>; isAlive: (pid: number) => boolean;
};

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function owner(bytes: string): LockOwner | null {
  try {
    const value = JSON.parse(bytes);
    return value && typeof value === 'object' && !Array.isArray(value) &&
      Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.host === 'string' && value.host.trim() &&
      typeof value.at === 'string' && value.at.trim() ? value : null;
  } catch {
    return null;
  }
}

function create(file: string, bytes: string): boolean {
  try {
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

export async function withLock<T>(session: string, tool: string, deps: LockDeps, fn: (broken: LockOwner | null) => Promise<T>): Promise<T> {
  const directory = path.join(session, '.state');
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, 'lock');
  const breaker = lock + '.break';
  const ours = JSON.stringify({ pid: deps.pid, host: deps.host, at: new Date(deps.clock()).toISOString(), tool });
  const start = deps.clock();
  let waited = 0;
  let broken: LockOwner | null = null;
  while (true) {
    const breaking = read(breaker);
    let held = breaking ?? read(lock);
    if (breaking === null && held === null && create(lock, ours)) break;
    if (breaking === null && held !== null) {
      const stale = owner(held);
      if (stale && stale.host === deps.host && !deps.isAlive(stale.pid) && create(breaker, ours)) {
        try {
          if (read(lock) === held) {
            fs.unlinkSync(lock);
            if (create(lock, ours)) {
              broken = stale;
              break;
            }
          }
        } finally {
          if (read(breaker) === ours) fs.unlinkSync(breaker);
        }
      }
    }
    const currentBreaker = read(breaker);
    held = currentBreaker ?? read(lock) ?? held;
    if (waited >= 10000 || deps.clock() - start >= 10000) {
      const holder = owner(held ?? '');
      const file = currentBreaker !== null ? breaker : lock;
      throw new ToolError(3, 'lock-held', holder ? 'lock held by pid ' + holder.pid + ' on ' + holder.host : 'lock holder unreadable at ' + file);
    }
    await deps.sleep(100);
    waited += 100;
  }
  try {
    return await fn(broken);
  } finally {
    if (read(lock) === ours) fs.unlinkSync(lock);
  }
}
