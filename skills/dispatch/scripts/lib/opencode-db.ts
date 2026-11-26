import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

export interface OpencodeMessage {
  depth: number;
  sessionId?: string;
  createdMs: number;
  model: string | null;
  effort: string | null;
  input: number;
  output: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  toolCalls?: number;
}

export interface OpencodeRead {
  messages: OpencodeMessage[];
  skipped: number;
  truncated: "sessions" | "rows" | null;
  userMessageTimes?: number[];
  userTurnsTruncated?: true;
}

export interface OpencodeReadOptions {
  fromMs: number;
  toMs: number;
  maxSessions?: number;
  maxRows?: number;
  includeSessionIdentity?: true;
}

const DEFAULT_MAX_SESSIONS = 256;
const DEFAULT_MAX_ROWS = 100_000;

interface SqliteModule {
  DatabaseSync: typeof DatabaseSync;
}

const isSqliteModule = (value: unknown): value is SqliteModule =>
  typeof value === "object" &&
  value !== null &&
  "DatabaseSync" in value &&
  typeof value.DatabaseSync === "function";

let sqliteModule: SqliteModule | null = null;

/** Loads `node:sqlite` on first use only, so runs that never open a database do not pay for it. */
export const getSqlite = () => {
  if (!sqliteModule) {
    const loaded: unknown = createRequire(import.meta.url)("node:sqlite");

    if (!isSqliteModule(loaded)) {
      throw new Error("node:sqlite does not provide DatabaseSync");
    }

    sqliteModule = loaded;
  }

  return sqliteModule;
};

type SqlCell = SQLOutputValue | undefined;

interface OpencodeRow {
  [field: string]: SqlCell;
}

const token = (value: SqlCell): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const optionalToken = (value: SqlCell): number | undefined | false => {
  if (value === null || value === undefined) {
    return undefined;
  }

  return token(value) ? value : false;
};

const cap = (value: number | undefined, fallback: number) =>
  value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(0, Math.floor(value));

export const opencodeDbPath = (
  home: string,
  env: (name: string) => string | undefined
) => {
  const dataHome = env("XDG_DATA_HOME");

  const dataDir =
    dataHome !== undefined && dataHome !== ""
      ? dataHome
      : path.join(home, ".local", "share");

  return path.join(dataDir, "opencode", "opencode.db");
};

interface DepthWalk {
  ids: string[];
  depths: Map<string, number>;
  truncated: "sessions" | null;
}

const walkDepths = (
  db: DatabaseSync,
  rootSessionId: string,
  maxSessions: number
): DepthWalk => {
  const depths = new Map<string, number>([[rootSessionId, 0]]);
  let truncated: "sessions" | null = null;
  let frontier = [rootSessionId];
  let depth = 0;
  let remaining = maxSessions;

  while (frontier.length > 0) {
    const placeholders = frontier.map(() => "?").join(",");

    const children = db
      .prepare(
        `SELECT id FROM session_v2 WHERE parent_id IN (${placeholders}) ORDER BY id LIMIT ?`
      )
      .all(...frontier, remaining + 1);

    if (children.length === 0) {
      break;
    }

    const next: string[] = [];

    for (const child of children) {
      const { id } = child;

      if (typeof id !== "string" || depths.has(id)) {
        continue;
      }

      if (next.length >= remaining) {
        truncated = "sessions";
        break;
      }

      depths.set(id, depth + 1);
      next.push(id);
    }

    if (truncated !== null) {
      break;
    }

    frontier = next;
    remaining -= next.length;
    depth += 1;
  }

  return { ids: [...depths.keys()], depths, truncated };
};

const readToolCounts = (
  db: DatabaseSync,
  placeholders: string,
  ids: string[],
  options: OpencodeReadOptions
) => {
  const tables = new Set(
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name IN ('part', 'session_part')`
      )
      .all()
      .map((r) => r["name"])
      .filter((n): n is string => typeof n === "string")
  );

  let partQuery: string | null;

  if (tables.has("part")) {
    partQuery = `SELECT message_id, COUNT(*) AS tool_calls FROM part WHERE message_id IN (SELECT id FROM session_message WHERE type = 'assistant' AND session_id IN (${placeholders}) AND time_created >= ? AND time_created <= ?) AND json_extract(data, '$.type') = 'tool' GROUP BY message_id`;
  } else if (tables.has("session_part")) {
    partQuery = `SELECT message_id, COUNT(*) AS tool_calls FROM session_part WHERE message_id IN (SELECT id FROM session_message WHERE type = 'assistant' AND session_id IN (${placeholders}) AND time_created >= ? AND time_created <= ?) AND type = 'tool' GROUP BY message_id`;
  } else {
    partQuery = null;
  }

  if (partQuery === null) {
    return null;
  }

  const counts = new Map<string, number>();

  const toolRows = db
    .prepare(partQuery)
    .all(...ids, options.fromMs, options.toMs);

  for (const tr of toolRows) {
    const msgId = tr["message_id"];
    const cnt = tr["tool_calls"];

    if (typeof msgId === "string" && token(cnt)) {
      counts.set(msgId, cnt);
    }
  }

  return counts;
};

const buildMessage = (
  row: OpencodeRow,
  depths: Map<string, number>,
  options: OpencodeReadOptions,
  toolCounts: Map<string, number> | null
): OpencodeMessage | null => {
  const sessionId = row["session_id"];

  if (typeof sessionId !== "string") {
    return null;
  }

  const createdMs = row["time_created"];
  const { input } = row;
  const { output } = row;
  const messageDepth = depths.get(sessionId);

  if (
    messageDepth === undefined ||
    !token(createdMs) ||
    !token(input) ||
    !token(output)
  ) {
    return null;
  }

  const reasoning = optionalToken(row["reasoning"]);
  const cacheRead = optionalToken(row["cache_read"]);
  const cacheWrite = optionalToken(row["cache_write"]);

  if (reasoning === false || cacheRead === false || cacheWrite === false) {
    return null;
  }

  const providerId = row["provider_id"];
  const modelId = row["model_id"];
  const { variant } = row;
  const msgId = row["id"];

  return {
    depth: messageDepth,
    ...(options.includeSessionIdentity && { sessionId }),
    createdMs,
    model:
      typeof providerId === "string" && typeof modelId === "string"
        ? `${providerId}/${modelId}`
        : null,
    effort: typeof variant === "string" ? variant : null,
    input,
    output,
    ...(reasoning !== undefined && { reasoning }),
    ...(cacheRead !== undefined && { cacheRead }),
    ...(cacheWrite !== undefined && { cacheWrite }),
    ...(toolCounts !== null &&
      typeof msgId === "string" && {
        toolCalls: toolCounts.get(msgId) ?? 0,
      }),
  };
};

export const readOpencodeMessages: (
  dbPath: string,
  rootSessionId: string,
  options: OpencodeReadOptions
) => OpencodeRead = (dbPath, rootSessionId, options) => {
  fs.statSync(dbPath);
  const maxSessions = cap(options.maxSessions, DEFAULT_MAX_SESSIONS);
  const maxRows = cap(options.maxRows, DEFAULT_MAX_ROWS);
  const { DatabaseSync } = getSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });

  try {
    const walk = walkDepths(db, rootSessionId, maxSessions);
    let truncated: OpencodeRead["truncated"] = walk.truncated;
    const { ids, depths } = walk;
    const placeholders = ids.map(() => "?").join(",");

    const rows = db
      .prepare(`
      SELECT id, session_id, time_created,
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
    `)
      .all(...ids, options.fromMs, options.toMs, maxRows + 1);

    const toolCounts = readToolCounts(db, placeholders, ids, options);

    const messages: OpencodeMessage[] = [];
    let skipped = 0;

    for (const row of rows.slice(0, maxRows)) {
      const message = buildMessage(row, depths, options, toolCounts);

      if (message === null) {
        skipped += 1;
        continue;
      }

      messages.push(message);
    }

    if (rows.length > maxRows && truncated === null) {
      truncated = "rows";
    }

    const userRows = db
      .prepare(`
      SELECT time_created
      FROM session_message
      WHERE type = 'user' AND session_id = ?
        AND time_created >= ? AND time_created <= ?
      ORDER BY time_created, id
      LIMIT ?
    `)
      .all(rootSessionId, options.fromMs, options.toMs, maxRows + 1);

    const userTurnsTruncated = userRows.length > maxRows;

    return {
      messages,
      skipped,
      truncated,
      ...(userTurnsTruncated
        ? { userTurnsTruncated: true as const }
        : {
            userMessageTimes: userRows
              .map((r) => r["time_created"])
              .filter(token),
          }),
    };
  } finally {
    db.close();
  }
};
