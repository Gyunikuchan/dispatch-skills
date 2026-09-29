// Exclusive run lock `<run>/lock` (spec §4.7); single-host runs.

import path from 'node:path';
import type { Ports } from './types.ts';

export const LOCK_FILE = 'lock';

export class LockHeld extends Error {
  override name = 'LockHeld';
  readonly pid: number;
  readonly host: string;
  constructor(pid: number, host: string, message: string) {
    super(message);
    this.pid = pid;
    this.host = host;
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

/** Returns `broken` = stale pid replaced, or null; throws `LockHeld` for a live or foreign-host lock. */
export function acquireLock(ports: Ports, runDir: string): { broken: number | null } {
  const file = path.join(runDir, LOCK_FILE);
  const body = `${JSON.stringify({ pid: ports.proc.pid, startedAt: new Date(ports.clock.now()).toISOString(), host: ports.proc.host })}\n`;
  let broken: number | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      ports.fs.writeExclusive(file, body);
      return { broken };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST' || attempt > 0) throw error;
    }
    let held: { pid?: unknown; host?: unknown };
    try {
      held = JSON.parse(ports.fs.readText(file)) as { pid?: unknown; host?: unknown };
    } catch {
      throw new LockHeld(-1, '', `run is locked by an unreadable lock file ${file}; remove it only if no send is running`);
    }
    const pid = typeof held.pid === 'number' ? held.pid : -1;
    const host = typeof held.host === 'string' ? held.host : '';
    if (host !== ports.proc.host) throw new LockHeld(pid, host, `run is locked by pid ${pid} on host ${host}; runs are single-host`);
    if (ports.proc.isAlive(pid)) throw new LockHeld(pid, host, `run is locked by live pid ${pid}; wait for that send to finish`);
    ports.fs.remove(file);
    broken = pid;
  }
  throw new Error('unreachable');
}

export function releaseLock(ports: Ports, runDir: string): void {
  const file = path.join(runDir, LOCK_FILE);
  try {
    const held = JSON.parse(ports.fs.readText(file)) as { pid?: unknown; host?: unknown };
    if (held.pid === ports.proc.pid && held.host === ports.proc.host) ports.fs.remove(file);
  } catch { /* No lock of ours to release. */ }
}
