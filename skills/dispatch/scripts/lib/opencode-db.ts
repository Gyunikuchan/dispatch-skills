import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export type OpencodeMessage = { depth: number; createdMs: number; model: string | null; effort: string | null;
  input: number; output: number; reasoning?: number; cacheRead?: number; cacheWrite?: number };
export type OpencodeRead = { messages: OpencodeMessage[]; skipped: number; truncated: 'sessions' | 'rows' | null };
export type OpencodeReadOptions = { fromMs: number; toMs: number; maxSessions?: number; maxRows?: number };

const DEFAULT_MAX_SESSIONS = 256;
const DEFAULT_MAX_ROWS = 100000;

type Row = Record<string, unknown>;

let sqliteModule: typeof import('node:sqlite') | null = null;
function getSqlite(): typeof import('node:sqlite') {
  if (!sqliteModule) {
    const req = createRequire(import.meta.url);
    sqliteModule = req('node:sqlite');
  }
  return sqliteModule!;
}

const token = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const optionalToken = (value: unknown): number | undefined | false => value === null ? undefined : (token(value) ? value : false);
const cap = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));

export function opencodeDbPath(home: string, env: (name: string) => string | undefined): string {
  const dataHome = env('XDG_DATA_HOME');
  return path.join(dataHome ? dataHome : path.join(home, '.local', 'share'), 'opencode', 'opencode.db');
}

export function readOpencodeMessages(dbPath: string, rootSessionId: string, options: OpencodeReadOptions): OpencodeRead {
  // A read-only open of a missing file must not create it; stat keeps the native ENOENT code for callers.
  fs.statSync(dbPath);
  const maxSessions = cap(options.maxSessions, DEFAULT_MAX_SESSIONS);
  const maxRows = cap(options.maxRows, DEFAULT_MAX_ROWS);
  const depths = new Map<string, number>([[rootSessionId, 0]]);
  const { DatabaseSync } = getSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    let truncated: OpencodeRead['truncated'] = null;
    let frontier = [rootSessionId];
    let depth = 0;
    let remaining = maxSessions;
    while (frontier.length > 0) {
      const placeholders = frontier.map(() => '?').join(',');
      // The extra row only signals that descendants exceed the cap; it never enters the visited set.
      const children = db.prepare(`SELECT id FROM session_v2 WHERE parent_id IN (${placeholders}) ORDER BY id LIMIT ?`)
        .all(...frontier, remaining + 1) as Row[];
      if (children.length === 0) break;
      const next: string[] = [];
      for (const child of children) {
        const id = child['id'];
        if (typeof id !== 'string' || depths.has(id)) continue;
        if (next.length >= remaining) { truncated = 'sessions'; break; }
        depths.set(id, depth + 1);
        next.push(id);
      }
      if (truncated) break;
      frontier = next;
      remaining -= next.length;
      depth++;
    }

    const ids = [...depths.keys()];
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT session_id, time_created,
        json_extract(data, '$.tokens.input') AS input,
        json_extract(data, '$.tokens.output') AS output,
        json_extract(data, '$.tokens.reasoning') AS reasoning,
        json_extract(data, '$.tokens.cache.read') AS cache_read,
        json_extract(data, '$.tokens.cache.write') AS cache_write,
        json_extract(data, '$.model.providerID') AS provider_id,
        json_extract(data, '$.model.id') AS model_id,
        json_extract(data, '$.model.variant') AS variant
      FROM session_message
      WHERE type = 'assistant' AND session_id IN (${placeholders})
        AND time_created >= ? AND time_created <= ?
      ORDER BY time_created, id
      LIMIT ?
    `).all(...ids, options.fromMs, options.toMs, maxRows + 1) as Row[];

    const messages: OpencodeMessage[] = [];
    let skipped = 0;
    for (const row of rows.slice(0, maxRows)) {
      const sessionId = row['session_id'];
      const createdMs = row['time_created'];
      const input = row['input'];
      const output = row['output'];
      const messageDepth = typeof sessionId === 'string' ? depths.get(sessionId) : undefined;
      if (messageDepth === undefined || !token(createdMs) || !token(input) || !token(output)) { skipped++; continue; }
      const reasoning = optionalToken(row['reasoning']);
      const cacheRead = optionalToken(row['cache_read']);
      const cacheWrite = optionalToken(row['cache_write']);
      if (reasoning === false || cacheRead === false || cacheWrite === false) { skipped++; continue; }
      const providerId = row['provider_id'];
      const modelId = row['model_id'];
      const variant = row['variant'];
      messages.push({
        depth: messageDepth,
        createdMs,
        model: typeof providerId === 'string' && typeof modelId === 'string' ? `${providerId}/${modelId}` : null,
        effort: typeof variant === 'string' ? variant : null,
        input,
        output,
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(cacheRead !== undefined ? { cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cacheWrite } : {}),
      });
    }
    // Session truncation wins: it limits which sessions the row cap is applied to.
    if (rows.length > maxRows && truncated === null) truncated = 'rows';
    return { messages, skipped, truncated };
  } finally {
    db.close();
  }
}
