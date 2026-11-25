import path from 'node:path';
import type { HostUsageFs } from '../../../../../skills/dispatch/scripts/lib/usage/rows.ts';
export function memoryFs(
  files: Record<string, string | Buffer>,
  times: Record<string, number> = {},
): HostUsageFs & { reads: Array<string> } {
  const entries = new Map(Object.entries(files).map(([name, data]) => [path.normalize(name), Buffer.from(data)]));
  const mtimes = new Map(Object.entries(times).map(([name, value]) => [path.normalize(name), value]));
  const reads: Array<string> = [];
  return {
    reads,
    list(dir) {
      const prefix = path.normalize(dir) + path.sep;
      const names = new Set<string>();
      for (const file of entries.keys()) {
        const name = file.startsWith(prefix) && file.slice(prefix.length).split(path.sep)[0];
        if (name) {
          names.add(name);
        }
      }
      return [...names];
    },
    stat(file) {
      const data = entries.get(path.normalize(file));
      return data ? { size: data.length, mtimeMs: mtimes.get(path.normalize(file)) ?? 10_000 } : null;
    },
    read(file, max) {
      const name = path.normalize(file);
      reads.push(name);
      const data = entries.get(name);
      if (!data) {
        throw new Error(`Missing fixture file ${file}`);
      }
      return data.subarray(0, max);
    },
    decompress: null,
  };
}
export const lines = (...values: Array<unknown>) => values.map((value) => JSON.stringify(value)).join('\n');
export const query = {
  sessionId: 'host',
  startMs: 0,
  endMs: 10_000,
  home: '/home',
  env: (_: string) => undefined,
  stages: [
    { stage: 'spec' as const, atMs: 0 },
    { stage: 'plan' as const, atMs: 2000 },
  ],
  budget: { remaining: 1024 * 1024 },
};
