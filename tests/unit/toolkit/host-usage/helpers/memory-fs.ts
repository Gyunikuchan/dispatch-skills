import path from 'node:path';
import type { HostUsageFs } from '../../../../../skills/dispatch/scripts/toolkit/host-usage/types.ts';
export function memoryFs(files: Record<string, string | Buffer>, times: Record<string, number> = {}): HostUsageFs & { reads: string[] } {
  const entries = new Map(Object.entries(files).map(([name, data]) => [path.normalize(name), Buffer.from(data)])); const mtimes = new Map(Object.entries(times).map(([name, value]) => [path.normalize(name), value])); const reads: string[] = [];
  return { reads, list(dir) { const prefix = path.normalize(dir) + path.sep; return [...new Set([...entries.keys()].filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length).split(path.sep)[0]!).filter(Boolean))]; }, stat(file) { const data = entries.get(path.normalize(file)); return data ? { size: data.length, mtimeMs: mtimes.get(path.normalize(file)) ?? 10000 } : null; }, read(file, max) { reads.push(path.normalize(file)); return entries.get(path.normalize(file))!.subarray(0, max); }, decompress: null };
}
export const lines = (...values: unknown[]) => values.map(value => JSON.stringify(value)).join('\n');
export const query = { sessionId: 'host', startMs: 0, endMs: 10000, home: '/home', env: (_: string) => undefined, stages: [{ stage: 'spec' as const, atMs: 0 }, { stage: 'plan' as const, atMs: 2000 }], budget: { remaining: 1024 * 1024 } };
