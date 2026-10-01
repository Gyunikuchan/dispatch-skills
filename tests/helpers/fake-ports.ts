// Fake Ports for the core tier: real fs in the isolated temp dir, fixed clock, no processes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeFs } from '../../skills/dispatch/scripts/core/ports.ts';
import type { Ports } from '../../skills/dispatch/scripts/core/types.ts';

export const FIXED_NOW = Date.parse('2026-01-01T00:00:00.000Z');
export const FAKE_PID = 4242;
export const FAKE_HOST = 'test-host';

export interface FakePorts extends Ports {
  /** Pids reported alive by `proc.isAlive`. */
  alive: Set<number>;
  stderrLines: string[];
  timers: number;
}

export function fakePorts(): FakePorts {
  const alive = new Set<number>([FAKE_PID]);
  const stderrLines: string[] = [];
  const ports: FakePorts = {
    alive,
    stderrLines,
    timers: 0,
    // NOTE: plain writes without fsync or rename keep MAX_STEPS runs inside the per-file budget;
    // durability and atomicity belong to ports.ts (progress.test.ts exercises the real nodeFs).
    fs: {
      ...nodeFs,
      appendDurable: (file, text) => { fs.appendFileSync(file, text); },
      writeAtomic: (file, text) => { fs.writeFileSync(file, text); },
    },
    spawn: { run: () => { throw new Error('fake ports: spawn is not available in tiers 1-5'); } },
    git: { run: () => { throw new Error('fake ports: git is not available in tiers 1-5'); } },
    clock: {
      now: () => FIXED_NOW,
      every: () => { ports.timers++; return () => { ports.timers--; }; },
    },
    env: { get: () => undefined },
    proc: {
      pid: FAKE_PID,
      host: FAKE_HOST,
      isAlive: (pid) => alive.has(pid),
      stderr: (text) => { stderrLines.push(text); },
    },
  };
  return ports;
}

/** Fresh directory under the process's isolated temp dir; the run dir itself is not created. */
export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'core-'));
}
