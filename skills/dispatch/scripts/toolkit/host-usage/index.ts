import fs from 'node:fs';
import * as zlib from 'node:zlib';
import type { ProviderKey } from '../../lib/platform.ts';
import { claudeCode } from './claude-code.ts';
import { codex } from './codex.ts';
import { MAX_TOTAL_BYTES, type HostUsageAdapter, type HostUsageFacts, type HostUsageFs, type Milestone } from './types.ts';
import { readErrorReason } from './read.ts';
export const ADAPTERS: Partial<Record<ProviderKey, HostUsageAdapter>> = { claude: claudeCode, codex };
export type HostUsageInput = { startMs: number; endMs: number; home: string; env: (name: string) => string | undefined; stages: readonly Milestone[] };
export function readHostUsage(platform: ProviderKey | null, input: HostUsageInput, fs: HostUsageFs, adapters: Partial<Record<ProviderKey, HostUsageAdapter>> = ADAPTERS): HostUsageFacts {
  const adapter = platform ? adapters[platform] : undefined;
  if (!adapter) return { platform, rows: [], unavailable: 'no adapter' };
  const sessionId = adapter.sessionEnv.map(input.env).find(Boolean);
  if (!sessionId) return { platform, rows: [], unavailable: 'no host id' };
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return { platform, rows: [], unavailable: 'invalid host id' };
  if (!Number.isFinite(input.startMs)) return { platform, rows: [], unavailable: 'invalid session start' };
  try { return { platform, ...adapter.read({ ...input, sessionId, budget: { remaining: MAX_TOTAL_BYTES } }, fs) }; }
  catch (error) { return { platform, rows: [], unavailable: readErrorReason(error) }; }
}
export const nodeHostUsageFs: HostUsageFs = {
  list(dir) { try { return fs.readdirSync(dir); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return []; throw error; } },
  stat(file) { try { const s = fs.statSync(file); return { size: s.size, mtimeMs: s.mtimeMs }; } catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null; throw error; } },
  read(file, maxBytes) { const fd = fs.openSync(file, 'r'); try { const chunks: Buffer[] = []; let total = 0; while (total < maxBytes) { const data = Buffer.allocUnsafe(Math.min(1024 * 1024, maxBytes - total)); const count = fs.readSync(fd, data, 0, data.length, null); if (!count) break; chunks.push(data.subarray(0, count)); total += count; } return Buffer.concat(chunks, total); } finally { fs.closeSync(fd); } },
  decompress: typeof zlib.zstdDecompressSync === 'function' ? (data, maxBytes) => zlib.zstdDecompressSync(data, { maxOutputLength: maxBytes }) : null,
};
