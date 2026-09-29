// Progress snapshot `<run>/progress.json` and stderr milestones (spec §4.8).

import path from 'node:path';
import type { EffectKind, Ports } from './types.ts';

export const PROGRESS_FILE = 'progress.json';
export const HEARTBEAT_MS = 30_000;
export const STALL_HINT_MS = 5 * 60_000;

export interface ProgressSnapshot {
  at: string;
  effect: { id: string; kind: EffectKind; startedAt: string; expectedMs?: number };
  slots?: readonly Readonly<Record<string, unknown>>[];
  command?: Readonly<Record<string, unknown>>;
}

export function writeProgress(ports: Ports, runDir: string, snapshot: ProgressSnapshot): void {
  ports.fs.writeAtomic(path.join(runDir, PROGRESS_FILE), `${JSON.stringify(snapshot)}\n`);
}

export function milestone(ports: Ports, line: string): void {
  ports.proc.stderr(`[dispatch] ${line}\n`);
}
