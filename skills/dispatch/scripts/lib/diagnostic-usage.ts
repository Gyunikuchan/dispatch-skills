import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DiagnosticModelUsage, DiagnosticUsage } from '../toolkit/types.ts';
type Row = Record<string, unknown>;
const row = (v: unknown): Row | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
function counters(value: unknown, names: Record<string, string>, provenance: string, inputSemantics: DiagnosticUsage['inputSemantics']): DiagnosticUsage | undefined {
  const r = row(value);
  if (!r || !count(r[names['input']!]) || !count(r[names['output']!])) return undefined;
  const out: DiagnosticUsage = { input: r[names['input']!] as number, output: r[names['output']!] as number, scope: 'invocation', provenance, inputSemantics };
  for (const key of ['cacheRead', 'cacheWrite', 'reasoning'] as const) {
    const field = names[key];
    if (field && r[field] !== undefined) { if (!count(r[field])) return undefined; out[key] = r[field]; }
  }
  return out;
}
function addUsage(total: DiagnosticUsage, usage: DiagnosticUsage): void {
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const) {
    if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key];
  }
}
export function codexUsage(raw: string): DiagnosticUsage | undefined {
  let total: DiagnosticUsage | undefined;
  let completed = false;
  let started = false;
  for (const line of raw.split(/\r?\n/).filter((v) => v.trim())) {
    let event: Row | null;
    try { event = row(JSON.parse(line)); } catch { return undefined; }
    if (event?.['type'] === 'turn.started') { started = true; continue; }
    if (event?.['type'] !== 'turn.completed') continue;
    const usage = counters(event['usage'], { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cached_input_tokens', cacheWrite: 'cache_write_input_tokens', reasoning: 'reasoning_output_tokens' }, 'codex.turn.completed', 'includes-cache');
    if (!usage) return undefined;
    // The first completion counts; a later turn counts only when its own `turn.started` arrived after the prior one.
    if (!completed || started) {
      if (!total) total = { ...usage };
      else addUsage(total, usage);
      completed = true;
    }
    started = false;
  }
  return total;
}
/** OpenCode `run --format json`: one `step_finish` per turn carries usage; `tokens.input` already excludes cache reads. */
export function opencodeUsage(raw: string): DiagnosticUsage | undefined {
  let total: DiagnosticUsage | undefined;
  for (const line of raw.split(/\r?\n/).filter((v) => v.trim())) {
    let event: Row | null;
    try { event = row(JSON.parse(line)); } catch { return undefined; }
    if (event?.['type'] !== 'step_finish') continue;
    const tokens = row(row(event['part'])?.['tokens']);
    const rawInput = tokens?.['input'], rawOutput = tokens?.['output'];
    if (!tokens || !count(rawInput) || !count(rawOutput)) return undefined;
    const cache = row(tokens['cache']);
    const usage: DiagnosticUsage = { input: rawInput, output: rawOutput, scope: 'invocation', provenance: 'opencode.step.finish', inputSemantics: 'uncached' };
    for (const [key, value] of [['reasoning', tokens['reasoning']], ['cacheRead', cache?.['read']], ['cacheWrite', cache?.['write']]] as const) {
      if (value === undefined) continue;
      if (!count(value)) return undefined;
      usage[key] = value;
    }
    if (!total) total = usage;
    else addUsage(total, usage);
  }
  return total;
}
export function claudeUsage(raw: string): DiagnosticUsage | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  const event = row(Array.isArray(parsed) ? parsed.findLast((v: unknown) => row(v)?.['type'] === 'result') : parsed);
  if (event?.['type'] !== 'result') return undefined;
  const models = row(event['modelUsage']);
  if (models && Object.keys(models).length > 0 && Object.keys(models).length <= 8) {
    const parts = Object.values(models).map((v) => counters(v, { input: 'inputTokens', output: 'outputTokens', cacheRead: 'cacheReadInputTokens', cacheWrite: 'cacheCreationInputTokens', reasoning: 'thinkingTokens' }, 'claude.result.modelUsage', 'uncached'));
    if (parts.some((v) => !v)) return undefined;
    const out: DiagnosticUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, scope: 'invocation', provenance: 'claude.result.modelUsage', inputSemantics: 'uncached', actualModels: Object.keys(models) };
    for (const part of parts) for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const) if (part?.[key] !== undefined) out[key] = (out[key] ?? 0) + part[key];
    // Per-model counters let the report split a cascade's cost by the model that actually ran.
    out.models = Object.fromEntries(Object.keys(models).map((name, index) => {
      const part = parts[index]!;
      return [name, { input: part.input, output: part.output, ...(part.cacheRead === undefined ? {} : { cacheRead: part.cacheRead }), ...(part.cacheWrite === undefined ? {} : { cacheWrite: part.cacheWrite }), ...(part.reasoning === undefined ? {} : { reasoning: part.reasoning }) }];
    }));
    return Object.values(out).some((v) => typeof v === 'number' && !count(v)) ? undefined : out;
  }
  return counters(event['usage'], { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' }, 'claude.result.usage', 'uncached');
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
export const MAX_FILE_BYTES = 64 * 1024 * 1024; // 64 MiB

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
  if (convId && (context?.appDataDir || context?.readSqliteGenMetadata)) {
    const dbPath = context.appDataDir ? path.join(context.appDataDir, 'conversations', `${convId}.db`) : '';
    try {
      sqliteBlobs = context.readSqliteGenMetadata
        ? context.readSqliteGenMetadata(dbPath || convId)
        : dbPath ? readAgySqliteGenMetadata(dbPath, { maxBytes: MAX_FILE_BYTES }) : null;
    } catch {}
  }

  if (sqliteBlobs && sqliteBlobs.length > 0) {
    const rows = sqliteBlobs.map(decodeAgyGenMetadata);
    const modelsList: string[] = [];
    for (const r of rows) {
      if (r.model && !modelsList.includes(r.model)) modelsList.push(r.model);
    }
    if (modelsList.length > 0) {
      out.actualModels = modelsList.slice(0, 8);
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
        let canSum = true;
        for (const r of rows) {
          if (!r.model || r.input === undefined || r.output === undefined) { canSum = false; break; }
          perModel[r.model] ??= { input: 0, output: 0 };
          const target = perModel[r.model]!;
          target.input += r.input;
          target.output += r.output;
          if (r.cacheRead !== undefined) target.cacheRead = (target.cacheRead ?? 0) + r.cacheRead;
          if (r.reasoning !== undefined) target.reasoning = (target.reasoning ?? 0) + r.reasoning;
        }
        if (canSum) out.models = perModel;
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
        perModel[normalizedName] ??= { input: 0, output: 0 };
        const entry = perModel[normalizedName]!;
        entry.input += mCounters.input;
        entry.output += mCounters.output;
        if (mCounters.cacheRead !== undefined) entry.cacheRead = (entry.cacheRead ?? 0) + mCounters.cacheRead;
        if (mCounters.reasoning !== undefined) entry.reasoning = (entry.reasoning ?? 0) + mCounters.reasoning;
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
