import fs from 'node:fs';
import * as zlib from 'node:zlib';
import type { ProviderKey } from '../platform.ts';
import { readOpencodeMessages } from '../opencode-db.ts';
import { validSessionId } from '../session.ts';
import { agy, readAgySqliteGenMetadata } from './agy.ts';
import { claudeCode } from './claude.ts';
import { codex } from './codex.ts';
import { opencode } from './opencode.ts';
import { MAX_TOTAL_BYTES, readErrorReason } from './read.ts';
import type { HostRole, HostStage, HostUsageAdapter, HostUsageFacts, HostUsageFs, HostUsageRow, Milestone, UsageRow } from './rows.ts';

const toHostUsageRow = (r: UsageRow & { stage: HostStage }): HostUsageRow => ({
  stage: r.stage,
  role: r.role as HostRole,
  model: r.model,
  effort: r.effort,
  input: r.input,
  output: r.output,
  ...(r.cacheRead !== undefined ? { cacheRead: r.cacheRead } : {}),
  ...(r.cacheWrite !== undefined ? { cacheWrite: r.cacheWrite } : {}),
  ...(r.reasoning !== undefined ? { reasoning: r.reasoning } : {}),
});

export const ADAPTERS: Partial<Record<ProviderKey, HostUsageAdapter>> = { agy, claude: claudeCode, codex, opencode };
export type HostUsageInput = { startMs: number; endMs: number; home: string; env: (name: string) => string | undefined; stages: readonly Milestone[] };
export function readHostUsage(platform: ProviderKey | null, input: HostUsageInput, fsPort: HostUsageFs, adapters: Partial<Record<ProviderKey, HostUsageAdapter>> = ADAPTERS): HostUsageFacts {
  const adapter = platform ? adapters[platform] : undefined;
  if (!adapter) return { platform, rows: [], unavailable: 'no adapter' };
  const sessionId = adapter.sessionEnv.map(input.env).find(Boolean);
  if (!sessionId) return { platform, rows: [], unavailable: 'no host id' };
  if (!validSessionId(sessionId)) return { platform, rows: [], unavailable: 'invalid host id' };
  if (!Number.isFinite(input.startMs)) return { platform, rows: [], unavailable: 'invalid session start' };
  try {
    const res = adapter.read({ ...input, sessionId, budget: { remaining: MAX_TOTAL_BYTES } }, fsPort);
    return { platform, ...res, rows: res.rows.map(toHostUsageRow) };
  } catch (error) { return { platform, rows: [], unavailable: readErrorReason(error) }; }
}
export const nodeHostUsageFs: HostUsageFs = {
  list(dir) { try { return fs.readdirSync(dir); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return []; throw error; } },
  stat(file) { try { const s = fs.statSync(file); return { size: s.size, mtimeMs: s.mtimeMs }; } catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null; throw error; } },
  read(file, maxBytes) { const fd = fs.openSync(file, 'r'); try { const chunks: Buffer[] = []; let total = 0; while (total < maxBytes) { const data = Buffer.allocUnsafe(Math.min(1024 * 1024, maxBytes - total)); const count = fs.readSync(fd, data, 0, data.length, null); if (!count) break; chunks.push(data.subarray(0, count)); total += count; } return Buffer.concat(chunks, total); } finally { fs.closeSync(fd); } },
  decompress: typeof zlib.zstdDecompressSync === 'function' ? (data, maxBytes) => zlib.zstdDecompressSync(data, { maxOutputLength: maxBytes }) : null,
  sqliteGenMetadata: (file) => readAgySqliteGenMetadata(file, { throwOnError: true }),
  opencodeMessages: readOpencodeMessages,
};
