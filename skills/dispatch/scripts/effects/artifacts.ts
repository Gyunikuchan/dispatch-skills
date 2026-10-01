// File-write helper for handler outputs (prompts, briefs): idempotent overwrite so a replayed effect rewrites nothing.

import type { Ports } from '../core/types.ts';

/** Skips the write when `file` already holds `text`; otherwise writes it atomically. Returns whether it wrote. */
export function writeRendered(ports: Pick<Ports, 'fs'>, file: string, text: string): boolean {
  if (ports.fs.exists(file) && ports.fs.readText(file) === text) return false;
  ports.fs.writeAtomic(file, text);
  return true;
}
