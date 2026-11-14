import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DiagnosticModelUsage, DiagnosticUsage } from '../../toolkit/types.ts';
import { MAX_FILE_BYTES, count, counter, counters, note, readErrorReason, readTranscript, row, stageAt } from './read.ts';
import { addCounters, type Counters, type HostRole, type HostStage, type HostUsageAdapter, type HostUsageFs, type HostUsageQuery, type HostUsageResult, type ReadBudget, type UsageRow } from './rows.ts';

const ID_REGEX = /^[A-Za-z0-9-]+$/;

type ParsedStep = {
  step_index: number;
  atMs: number;
  wholeSecond?: true;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
};

export const agy: HostUsageAdapter = {
  sessionEnv: ['ANTIGRAVITY_CONVERSATION_ID'],
  read(query, fsPort) {
    return collectAgyUsage(query, fsPort);
  },
};

export function collectAgyUsage(query: HostUsageQuery, fsPort: HostUsageFs, options?: { appDataDir?: string; rootRole?: 'host' | 'delegate' }): HostUsageResult {
  const result: HostUsageResult = { rows: [], notes: {} };
  const notes = result.notes!;
  const rootRole = options?.rootRole ?? 'host';

  if (!ID_REGEX.test(query.sessionId)) {
    return { ...result, unavailable: 'invalid host id' };
  }

  const root = options?.appDataDir || query.env('ANTIGRAVITY_APP_DATA_DIR') || path.join(query.home, '.gemini', 'antigravity');
  const hostTranscriptFile = path.join(root, 'brain', query.sessionId, '.system_generated', 'logs', 'transcript.jsonl');

  let hostStat: { size: number; mtimeMs: number } | null = null;
  try {
    hostStat = fsPort.stat(hostTranscriptFile);
  } catch (error) {
    result.unavailable = readErrorReason(error);
  }
  if (!hostStat) {
    return { ...result, unavailable: result.unavailable ?? 'host id file missing' };
  }

  const subagentFallbackModels = new Map<string, string>();
  const visited = new Set<string>();
  visited.add(query.sessionId);

  function getDescriptorChildren(parentId: string): string[] {
    const subDir = path.join(root, 'brain', parentId, '.system_generated', 'subagents');
    let names: string[] = [];
    try {
      names = fsPort.list(subDir);
    } catch {
      note(notes, 'subagent', 'unreadable files');
      return [];
    }
    const children: string[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      if (query.budget.remaining <= 0) {
        note(notes, 'subagent', 'read budget reached');
        break;
      }
      const descFile = path.join(subDir, name);
      let cid: string | null = null;
      try {
        const stat = fsPort.stat(descFile);
        if (stat) {
          const capped = Math.min(stat.size, 65536);
          if (query.budget.remaining < capped) {
            query.budget.remaining = 0;
            note(notes, 'subagent', 'read budget reached');
            break;
          }
          const buf = fsPort.read(descFile, capped);
          query.budget.remaining = Math.max(0, query.budget.remaining - buf.length);
          const obj = JSON.parse(buf.toString('utf8'));
          if (typeof obj?.conversationId === 'string') {
            cid = obj.conversationId;
          }
        }
      } catch {}
      if (!cid) {
        cid = path.basename(name, '.json');
      }
      if (ID_REGEX.test(cid)) {
        children.push(cid);
      }
    }
    return children;
  }

  function processConversation(
    id: string,
    role: HostRole,
    fallbackModel: string,
    depth: number,
  ): { steps: ParsedStep[]; discoveredChildren: string[] } {
    const discoveredChildren: string[] = [];
    const transcriptFile = path.join(root, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
    let data: { text?: string; stop?: 'file cap' | 'budget' | 'zstd' };
    try {
      data = readTranscript(fsPort, transcriptFile, query.budget);
    } catch (error) {
      if (role === 'host') result.unavailable = readErrorReason(error);
      else note(notes, role, 'unreadable files');
      return { steps: [], discoveredChildren };
    }

    if (data.stop) {
      if (data.stop === 'budget') note(notes, role, 'read budget reached');
      else if (role === 'host') result.unavailable = data.stop === 'zstd' ? 'zstd unavailable' : 'transcript over size cap';
      else note(notes, role, data.stop === 'zstd' ? 'zstd unavailable' : 'subagents over size cap');
      return { steps: [], discoveredChildren };
    }

    if (data.text === undefined) {
      if (role === 'host') result.unavailable = 'read-error:ENOENT';
      else note(notes, role, 'unreadable files');
      return { steps: [], discoveredChildren };
    }

    const steps: ParsedStep[] = [];
    const pendingInvokeModels: string[] = [];

    for (const line of data.text.split('\n')) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        note(notes, role, 'unparsed lines');
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;

      if (entry.type === 'PLANNER_RESPONSE') {
        const at = typeof entry.created_at === 'string' ? Date.parse(entry.created_at) : NaN;
        if (
          !counter(entry.step_index) ||
          !Number.isFinite(at) ||
          !counter(entry.input_tokens) ||
          !counter(entry.output_tokens) ||
          (entry.cache_read_tokens !== undefined && !counter(entry.cache_read_tokens))
        ) {
          note(notes, role, 'unparsed lines');
          continue;
        }

        const parsed: ParsedStep = {
          step_index: entry.step_index,
          atMs: at,
          ...(typeof entry.created_at === 'string' && !/\.\d+/.test(entry.created_at) ? { wholeSecond: true as const } : {}),
          input_tokens: entry.input_tokens,
          output_tokens: entry.output_tokens,
        };
        if (counter(entry.cache_read_tokens)) {
          parsed.cache_read_tokens = entry.cache_read_tokens;
        }
        steps.push(parsed);

        if (Array.isArray(entry.tool_calls)) {
          for (const call of entry.tool_calls) {
            if (call?.name === 'invoke_subagent') {
              let m = typeof call.args?.Model === 'string' ? call.args.Model.replace(/^"|"$/g, '').trim() : null;
              if (m) {
                const norm = normalizeAgyModelEffort(m);
                m = norm.model ?? m;
              }
              pendingInvokeModels.push(m || 'unknown');
            }
          }
        }
      } else if (entry.type === 'GENERIC') {
        if (typeof entry.content === 'string' && entry.content.includes('Created the following subagent:')) {
          const matches = entry.content.matchAll(/"conversationId"\s*:\s*"([A-Za-z0-9-]+)"/g);
          for (const match of matches) {
            const childId = match[1]!;
            const m = pendingInvokeModels.shift() ?? 'unknown';
            if (!subagentFallbackModels.has(childId)) {
              subagentFallbackModels.set(childId, m);
            }
            discoveredChildren.push(childId);
          }
        }
      }
    }

    const dbFile = path.join(root, 'conversations', `${id}.db`);
    let blobs: readonly Uint8Array[] | null = null;
    try {
      if (fsPort.sqliteGenMetadata) {
        const statDb = fsPort.stat(dbFile);
        if (statDb) {
          let dbSize = statDb.size;
          const statWal = fsPort.stat(dbFile + '-wal');
          if (statWal) dbSize += statWal.size;
          const limit = Math.min(MAX_FILE_BYTES, query.budget.remaining);
          if (dbSize > limit) {
            if (dbSize > MAX_FILE_BYTES) {
              note(notes, role, 'unreadable files');
            } else {
              query.budget.remaining = 0;
              note(notes, role, 'read budget reached');
            }
          } else if (limit > 0) {
            const rawBlobs = fsPort.sqliteGenMetadata(dbFile);
            if (rawBlobs && rawBlobs.length > 0) {
              const blobBytes = rawBlobs.reduce((sum, b) => sum + b.byteLength, 0);
              query.budget.remaining = Math.max(0, query.budget.remaining - blobBytes);
              blobs = rawBlobs;
            }
          }
        }
      }
    } catch {
      note(notes, role, 'unreadable files');
    }

    let k = 0;
    let rows: ReturnType<typeof decodeAgyGenMetadata>[] = [];
    if (blobs && blobs.length > 0) {
      rows = blobs.map(decodeAgyGenMetadata);
      while (k < Math.min(steps.length, rows.length)) {
        const r = rows[k]!;
        const s = steps[k]!;
        const intervalMatch =
          k === 0
            ? r.lastStepIndex !== undefined && r.lastStepIndex < s.step_index
            : r.lastStepIndex !== undefined &&
              r.lastStepIndex >= steps[k - 1]!.step_index &&
              r.lastStepIndex < s.step_index;
        if (
          r.input === s.input_tokens &&
          r.output === s.output_tokens &&
          intervalMatch &&
          r.model !== null
        ) {
          k++;
        } else {
          break;
        }
      }
      if (k < steps.length || rows.length !== steps.length) {
        note(notes, role, 'unparsed lines');
      }
    } else if (rootRole === 'delegate' && steps.length > 0 && !notes[role]?.['read budget reached'] && !notes[role]?.['unreadable files']) {
      note(notes, role, 'unreadable files');
    }

    let inWindowCount = 0;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!;
      if (!(s.atMs >= query.startMs && s.atMs <= query.endMs)) continue;
      inWindowCount++;
      let model: string;
      let effort: string | null = null;
      let reasoning: number | undefined;

      if (i < k) {
        const r = rows[i]!;
        model = r.model!;
        effort = r.effort;
        reasoning = r.reasoning;
      } else {
        model = fallbackModel;
        effort = null;
        reasoning = undefined;
      }

      const hostRow: UsageRow & { stage: HostStage } = {
        stage: stageAt(query.stages, s.atMs),
        role: role === 'host' ? rootRole : role,
        model,
        effort,
        depth,
        atMs: s.atMs,
        ...(s.wholeSecond ? { wholeSecond: true as const } : {}),
        reasoningInOutput: false,
        input: s.input_tokens,
        output: s.output_tokens,
      };
      if (s.cache_read_tokens !== undefined) hostRow.cacheRead = s.cache_read_tokens;
      if (reasoning !== undefined && counter(reasoning)) hostRow.reasoning = reasoning;
      result.rows.push(hostRow);
    }

    if (role === 'host' && !inWindowCount && !result.unavailable) {
      result.unavailable = 'no usage records';
    }

    return { steps, discoveredChildren };
  }

  const hostEnvModel = query.env('ANTIGRAVITY_MODEL') || query.env('GEMINI_MODEL');
  const hostFallbackModel = (hostEnvModel ? normalizeAgyModelEffort(hostEnvModel).model ?? hostEnvModel : null) || 'unknown';

  const hostResult = processConversation(query.sessionId, 'host', hostFallbackModel, 0);
  if (notes.host?.['read budget reached']) {
    return result;
  }

  let currentQueue: string[] = [];
  {
    const hostDescChildren = getDescriptorChildren(query.sessionId);
    const level1Set = new Set<string>();
    for (const cid of hostDescChildren) {
      if (!visited.has(cid)) level1Set.add(cid);
    }
    for (const cid of hostResult.discoveredChildren) {
      if (!visited.has(cid)) level1Set.add(cid);
    }
    const sorted = [...level1Set].sort((a, b) => a.localeCompare(b));
    for (const id of sorted) visited.add(id);
    currentQueue = sorted;
  }

  let liveCount = 0;
  let excess = 0;
  let depth = 1;

  while (currentQueue.length > 0) {
    if (notes.subagent?.['read budget reached']) break;

    const eligibleThisLevel: string[] = [];
    for (const childId of currentQueue) {
      const transcriptFile = path.join(root, 'brain', childId, '.system_generated', 'logs', 'transcript.jsonl');
      let stat: { size: number; mtimeMs: number } | null = null;
      try {
        stat = fsPort.stat(transcriptFile);
      } catch {
        note(notes, 'subagent', 'unreadable files');
        continue;
      }
      if (!stat) {
        note(notes, 'subagent', 'unreadable files');
        continue;
      }
      if (stat.mtimeMs < query.startMs) {
        continue;
      }
      if (liveCount < 256) {
        liveCount++;
        eligibleThisLevel.push(childId);
      } else {
        excess++;
      }
    }

    const nextLevelSet = new Set<string>();
    for (const childId of eligibleThisLevel) {
      if (notes.subagent?.['read budget reached']) break;
      const fallback = subagentFallbackModels.get(childId) ?? 'unknown';
      const childRes = processConversation(childId, 'subagent', fallback, depth);
      if (notes.subagent?.['read budget reached']) break;

      const descChildren = getDescriptorChildren(childId);
      for (const cid of descChildren) {
        if (!visited.has(cid)) nextLevelSet.add(cid);
      }
      for (const cid of childRes.discoveredChildren) {
        if (!visited.has(cid)) nextLevelSet.add(cid);
      }
    }

    const nextSorted = [...nextLevelSet].sort((a, b) => a.localeCompare(b));
    for (const id of nextSorted) visited.add(id);
    currentQueue = nextSorted;
    depth++;
  }

  if (excess > 0) {
    note(notes, 'subagent', 'too many candidates', excess);
  }

  return result;
}

export type AgyTurnMetadata = {
  model: string | null;
  effort: string | null;
  hasDisplayName?: boolean;
  lastStepIndex?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  reasoning?: number;
};

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const BACKEND_SUFFIXES = /-(trial|tiered|control|n)$/i;
const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/i;
const DISPLAY_EFFORT = /^(.*?)\s*\((low|medium|high|xhigh|max)\)\s*$/i;

function deriveBaseSlug(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const claudeMatch = /^Claude\s+([A-Za-z0-9]+)\s+(\d+)\.(\d+)$/i.exec(trimmed);
  if (claudeMatch) {
    return `claude-${claudeMatch[1]!.toLowerCase()}-${claudeMatch[2]}-${claudeMatch[3]}`;
  }
  const tokens = trimmed.match(/[A-Za-z0-9]+(?:\.[0-9]+)*/g);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t) => t.toLowerCase()).join('-');
}

export function normalizeAgyModelEffort(
  rawModel?: string | null,
  rawEffort?: string | null,
  displayName?: string | null,
): { model: string | null; effort: string | null } {
  let effortCandidate: string | null = null;
  let displayNameBase: string | null = null;

  if (displayName) {
    const m = DISPLAY_EFFORT.exec(displayName);
    if (m) {
      displayNameBase = m[1]!.trim();
      effortCandidate = m[2]!.toLowerCase();
    } else {
      displayNameBase = displayName.trim();
    }
  }

  let rawModelEffortSuffix: string | null = null;
  let modelCandidate = rawModel?.trim() || null;
  if (modelCandidate) {
    if (!displayName) {
      const dm = DISPLAY_EFFORT.exec(modelCandidate);
      if (dm) {
        displayNameBase = dm[1]!.trim();
        effortCandidate ??= dm[2]!.toLowerCase();
        modelCandidate = displayNameBase;
      }
    }
    const effortMatch = EFFORT_SUFFIX.exec(modelCandidate);
    if (effortMatch) {
      rawModelEffortSuffix = effortMatch[1]!.toLowerCase();
      modelCandidate = modelCandidate.slice(0, effortMatch.index);
    }
    modelCandidate = modelCandidate.replace(BACKEND_SUFFIXES, '');
    const secondaryEffort = EFFORT_SUFFIX.exec(modelCandidate);
    if (secondaryEffort) {
      rawModelEffortSuffix ??= secondaryEffort[1]!.toLowerCase();
      modelCandidate = modelCandidate.slice(0, secondaryEffort.index);
    }
  }

  const finalEffort = effortCandidate
    ?? (rawEffort && VALID_EFFORTS.has(rawEffort.trim().toLowerCase()) ? rawEffort.trim().toLowerCase() : null)
    ?? rawModelEffortSuffix;

  let finalModel: string | null = null;
  if (modelCandidate && modelCandidate.length >= 3 && !/\s/.test(modelCandidate) && !/[()]/.test(modelCandidate)) {
    finalModel = modelCandidate.toLowerCase();
  } else if (displayNameBase) {
    finalModel = deriveBaseSlug(displayNameBase);
  } else if (modelCandidate) {
    finalModel = deriveBaseSlug(modelCandidate) ?? modelCandidate.toLowerCase();
  }

  return {
    model: finalModel,
    effort: finalEffort,
  };
}

function readVarint(buf: Uint8Array, cur: [number]): number {
  let val = 0, shift = 0;
  while (cur[0] < buf.length) {
    const b = buf[cur[0]++]!;
    val += (b & 0x7f) * (2 ** shift);
    if (!(b & 0x80)) break;
    shift += 7;
    if (shift > 49) break;
  }
  return val;
}

function readSlice(buf: Uint8Array, cur: [number]): Uint8Array {
  const len = readVarint(buf, cur);
  if (len < 0 || len > buf.length - cur[0]) {
    cur[0] = buf.length;
    return new Uint8Array(0);
  }
  const start = cur[0];
  cur[0] += len;
  return buf.subarray(start, cur[0]);
}

function skipField(wire: number, buf: Uint8Array, cur: [number]): void {
  if (wire === 0) {
    while (cur[0] < buf.length && (buf[cur[0]++]! & 0x80)) {}
  } else if (wire === 1) {
    cur[0] = Math.min(cur[0] + 8, buf.length);
  } else if (wire === 2) {
    const len = readVarint(buf, cur);
    if (len < 0 || len > buf.length - cur[0]) {
      cur[0] = buf.length;
    } else {
      cur[0] += len;
    }
  } else if (wire === 5) {
    cur[0] = Math.min(cur[0] + 4, buf.length);
  } else {
    cur[0] = buf.length;
  }
}

export function decodeAgyGenMetadata(data: Uint8Array): AgyTurnMetadata {
  try {
    let tag19: string | null = null;
    let tag21: string | null = null;
    let lastStepIndex: number | undefined;
    let input: number | undefined;
    let output: number | undefined;
    let cacheRead: number | undefined;
    let reasoning: number | undefined;

    const cur: [number] = [0];
    while (cur[0] < data.length) {
      const tag = readVarint(data, cur);
      const fn = tag >>> 3, wire = tag & 7;
      if (fn === 1 && wire === 2) {
        const s1 = readSlice(data, cur);
        const c1: [number] = [0];
        while (c1[0] < s1.length) {
          const t1 = readVarint(s1, c1);
          const f1 = t1 >>> 3, w1 = t1 & 7;
          if (f1 === 4 && w1 === 2) {
            const s4 = readSlice(s1, c1);
            const c4: [number] = [0];
            while (c4[0] < s4.length) {
              const t4 = readVarint(s4, c4);
              const f4 = t4 >>> 3, w4 = t4 & 7;
              if (w4 === 0) {
                const val = readVarint(s4, c4);
                if (count(val)) {
                  if (f4 === 2) input = val;
                  else if (f4 === 3) output = val;
                  else if (f4 === 5) cacheRead = val;
                  else if (f4 === 9) reasoning = val;
                }
              } else {
                skipField(w4, s4, c4);
              }
            }
          } else if (f1 === 19 && w1 === 2) {
            tag19 = Buffer.from(readSlice(s1, c1)).toString('utf8');
          } else if (f1 === 20 && w1 === 2) {
            const s20 = readSlice(s1, c1);
            const c20: [number] = [0];
            let kText = '', vText = '';
            while (c20[0] < s20.length) {
              const t20 = readVarint(s20, c20);
              const f20 = t20 >>> 3, w20 = t20 & 7;
              if (w20 === 2) {
                const str = Buffer.from(readSlice(s20, c20)).toString('utf8');
                if (f20 === 1) kText = str;
                else if (f20 === 2) vText = str;
              } else if (w20 === 0) {
                const val = readVarint(s20, c20);
                if (f20 === 2) vText = String(val);
              } else {
                skipField(w20, s20, c20);
              }
            }
            if (kText === 'last_step_index' && vText) {
              const num = Number.parseInt(vText, 10);
              if (count(num)) lastStepIndex = num;
            }
          } else if (f1 === 21 && w1 === 2) {
            tag21 = Buffer.from(readSlice(s1, c1)).toString('utf8');
          } else {
            skipField(w1, s1, c1);
          }
        }
      } else {
        skipField(wire, data, cur);
      }
    }

    const { model, effort } = normalizeAgyModelEffort(tag19, null, tag21);
    const result: AgyTurnMetadata = { model, effort };
    if (tag21) result.hasDisplayName = true;
    if (lastStepIndex !== undefined) result.lastStepIndex = lastStepIndex;
    if (input !== undefined) result.input = input;
    if (output !== undefined) result.output = output;
    if (cacheRead !== undefined) result.cacheRead = cacheRead;
    if (reasoning !== undefined) result.reasoning = reasoning;
    return result;
  } catch {
    return { model: null, effort: null };
  }
}

let sqliteModule: typeof import('node:sqlite') | null = null;
function getSqlite(): typeof import('node:sqlite') {
  if (!sqliteModule) {
    const req = createRequire(import.meta.url);
    sqliteModule = req('node:sqlite');
  }
  return sqliteModule!;
}

export function readAgySqliteGenMetadata(
  dbPath: string,
  options?: { maxBytes?: number; throwOnError?: boolean },
): readonly Uint8Array[] | null {
  try {
    const maxBytes = options?.maxBytes;
    if (maxBytes !== undefined) {
      let totalSize = 0;
      try {
        const s = fs.statSync(dbPath);
        totalSize += s.size;
      } catch (err) {
        if (options?.throwOnError) throw err;
        return null;
      }
      try {
        const wal = fs.statSync(dbPath + '-wal');
        totalSize += wal.size;
      } catch {}
      if (totalSize > maxBytes) {
        if (options?.throwOnError) throw new Error(`file size ${totalSize} exceeds maxBytes ${maxBytes}`);
        return null;
      }
    }

    const { DatabaseSync } = getSqlite();
    let db: import('node:sqlite').DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const stmt = db.prepare('SELECT data FROM gen_metadata ORDER BY idx');
      const rows = stmt.all() as { data: Uint8Array | Buffer }[];
      return rows.map((r) => r.data instanceof Uint8Array ? r.data : new Uint8Array(r.data));
    } finally {
      try { db?.close(); } catch {}
    }
  } catch (error) {
    if (options?.throwOnError) throw error;
    return null;
  }
}

export type UsageContext = {
  appDataDir?: string;
  readSqliteGenMetadata?: (dbPath: string) => readonly Uint8Array[] | null;
  budget?: ReadBudget;
};

export function agyUsage(raw: string, context?: UsageContext): DiagnosticUsage | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  const envelope = row(parsed);
  // agy reports cache reads beside input_tokens, so input is uncached; agy has no cache-write counter.
  const out = counters(envelope?.['usage'], { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_tokens', reasoning: 'thinking_tokens' }, 'agy.usage', 'uncached');
  if (!out) return undefined;

  const usageRow = row(envelope?.['usage']);
  const rawModel = typeof envelope?.['model'] === 'string' ? envelope['model'] : (typeof usageRow?.['model'] === 'string' ? usageRow['model'] : null);
  const rawEffort = typeof envelope?.['effort'] === 'string' ? envelope['effort'] : (typeof usageRow?.['effort'] === 'string' ? usageRow['effort'] : null);

  const convIdRaw = envelope?.['conversation_id'] ?? envelope?.['conversationId'];
  const convId = typeof convIdRaw === 'string' && /^[A-Za-z0-9-]+$/.test(convIdRaw) ? convIdRaw : null;

  let sqliteBlobs: readonly Uint8Array[] | null = null;
  const budget = context?.budget;
  const maxBytes = budget ? Math.min(MAX_FILE_BYTES, budget.remaining) : MAX_FILE_BYTES;
  if (convId && maxBytes > 0 && (context?.appDataDir || context?.readSqliteGenMetadata)) {
    const dbPath = context.appDataDir ? path.join(context.appDataDir, 'conversations', `${convId}.db`) : '';
    try {
      sqliteBlobs = context.readSqliteGenMetadata
        ? context.readSqliteGenMetadata(dbPath || convId)
        : dbPath ? readAgySqliteGenMetadata(dbPath, { maxBytes }) : null;
    } catch {}
    if (budget && sqliteBlobs) {
      const blobBytes = sqliteBlobs.reduce((sum, b) => sum + b.byteLength, 0);
      budget.remaining = Math.max(0, budget.remaining - blobBytes);
    }
  }

  if (sqliteBlobs && sqliteBlobs.length > 0) {
    const rows = sqliteBlobs.map(decodeAgyGenMetadata);
    const modelsList: string[] = [];
    for (const r of rows) {
      if (r.model && !modelsList.includes(r.model)) modelsList.push(r.model);
    }
    if (modelsList.length > 0) {
      out.actualModels = modelsList.slice(0, 8);
      if (rows.every((r) => r.model !== null)) {
        if (modelsList.length === 1) {
          const m = modelsList[0]!;
          out.models = {
            [m]: {
              input: out.input,
              output: out.output,
              ...(out.cacheRead !== undefined ? { cacheRead: out.cacheRead } : {}),
              ...(out.reasoning !== undefined ? { reasoning: out.reasoning } : {}),
            },
          };
        } else {
          const perModel: Record<string, DiagnosticModelUsage> = Object.create(null);
          const sum: Counters = { input: 0, output: 0 };
          let canSum = true;
          for (const r of rows) {
            if (!r.model || r.input === undefined || r.output === undefined) { canSum = false; break; }
            const target = perModel[r.model] ??= { input: 0, output: 0 };
            addCounters(target, r as Counters);
            addCounters(sum, r as Counters);
          }
          const matchesEnvelope = canSum
            && sum.input === out.input
            && sum.output === out.output
            && (sum.cacheRead ?? 0) === (out.cacheRead ?? 0)
            && (sum.reasoning ?? 0) === (out.reasoning ?? 0);
          if (matchesEnvelope) out.models = perModel;
        }
      }
    }
    const lastRow = rows.at(-1)!;
    const lastEffort = lastRow.effort !== null ? lastRow.effort : (lastRow.hasDisplayName ? null : undefined);
    if (lastEffort !== undefined) out.actualEffort = lastEffort;
    return out;
  }

  const envelopeModelsRaw = row(envelope?.['models'] ?? envelope?.['model_usage'] ?? envelope?.['modelUsage'] ?? usageRow?.['models']);
  if (envelopeModelsRaw && Object.keys(envelopeModelsRaw).length > 0) {
    const perModel: Record<string, DiagnosticModelUsage> = Object.create(null);
    const activeModels: string[] = [];
    const keyEfforts: string[] = [];
    for (const [mName, mVal] of Object.entries(envelopeModelsRaw)) {
      const mRow = row(mVal);
      if (!mRow) continue;
      const parsed = normalizeAgyModelEffort(mName);
      const normalizedName = parsed.model ?? mName.toLowerCase();
      const mCounters = counters(mRow, { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_tokens', reasoning: 'thinking_tokens' }, 'agy.usage', 'uncached');
      if (mCounters) {
        if (parsed.effort !== null && !keyEfforts.includes(parsed.effort)) keyEfforts.push(parsed.effort);
        const entry = perModel[normalizedName] ??= { input: 0, output: 0 };
        addCounters(entry, mCounters);
        if (!activeModels.includes(normalizedName)) activeModels.push(normalizedName);
      }
    }
    if (activeModels.length > 0) {
      out.actualModels = activeModels;
      out.models = perModel;
      const norm = normalizeAgyModelEffort(rawModel, rawEffort);
      const consensusKeyEffort = keyEfforts.length === 1 ? keyEfforts[0]! : (keyEfforts.length > 1 ? null : undefined);
      if (norm.effort !== null) {
        out.actualEffort = norm.effort;
      } else if (rawEffort !== null && rawEffort !== undefined) {
        out.actualEffort = null;
      } else if (consensusKeyEffort !== undefined) {
        out.actualEffort = consensusKeyEffort;
      } else if (rawModel) {
        out.actualEffort = null;
      }
      out.provenance = 'agy.usage.envelope';
      return out;
    }
  }

  if (rawModel || rawEffort) {
    const norm = normalizeAgyModelEffort(rawModel, rawEffort);
    if (norm.model) {
      out.actualModels = [norm.model];
      out.models = {
        [norm.model]: {
          input: out.input,
          output: out.output,
          ...(out.cacheRead !== undefined ? { cacheRead: out.cacheRead } : {}),
          ...(out.reasoning !== undefined ? { reasoning: out.reasoning } : {}),
        },
      };
    }
    out.actualEffort = norm.effort;
    out.provenance = 'agy.usage.envelope';
  }

  return out;
}
