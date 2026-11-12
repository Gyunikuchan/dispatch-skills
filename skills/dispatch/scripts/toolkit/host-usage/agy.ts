import path from 'node:path';
import { counter, note, readErrorReason, readTranscript, stageAt } from './read.ts';
import {
  MAX_FILE_BYTES,
  type HostRole,
  type HostUsageAdapter,
  type HostUsageFs,
  type HostUsageQuery,
  type HostUsageResult,
  type HostUsageRow,
} from './types.ts';
import { decodeAgyGenMetadata, normalizeAgyModelEffort } from '../../lib/diagnostic-usage.ts';

const ID_REGEX = /^[A-Za-z0-9-]+$/;

type ParsedStep = {
  step_index: number;
  atMs: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
};

export const agy: HostUsageAdapter = {
  sessionEnv: ['ANTIGRAVITY_CONVERSATION_ID'],
  read(query, fs) {
    return collect(query, fs);
  },
};

function collect(query: HostUsageQuery, fs: HostUsageFs): HostUsageResult {
  const result: HostUsageResult = { rows: [], notes: {} };
  const notes = result.notes!;

  if (!ID_REGEX.test(query.sessionId)) {
    return { ...result, unavailable: 'invalid host id' };
  }

  const root = query.env('ANTIGRAVITY_APP_DATA_DIR') || path.join(query.home, '.gemini', 'antigravity');
  const hostTranscriptFile = path.join(root, 'brain', query.sessionId, '.system_generated', 'logs', 'transcript.jsonl');

  let hostStat: { size: number; mtimeMs: number } | null = null;
  try {
    hostStat = fs.stat(hostTranscriptFile);
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
      names = fs.list(subDir);
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
        const stat = fs.stat(descFile);
        if (stat) {
          const capped = Math.min(stat.size, 65536);
          if (query.budget.remaining < capped) {
            query.budget.remaining = 0;
            note(notes, 'subagent', 'read budget reached');
            break;
          }
          const buf = fs.read(descFile, capped);
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
  ): { steps: ParsedStep[]; discoveredChildren: string[] } {
    const discoveredChildren: string[] = [];
    const transcriptFile = path.join(root, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
    let data: { text?: string; stop?: 'file cap' | 'budget' | 'zstd' };
    try {
      data = readTranscript(fs, transcriptFile, query.budget);
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
      if (fs.sqliteGenMetadata) {
        const statDb = fs.stat(dbFile);
        if (statDb) {
          let dbSize = statDb.size;
          const statWal = fs.stat(dbFile + '-wal');
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
            const rawBlobs = fs.sqliteGenMetadata(dbFile);
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

      const row: HostUsageRow = {
        stage: stageAt(query.stages, s.atMs),
        role,
        model,
        effort,
        input: s.input_tokens,
        output: s.output_tokens,
      };
      if (s.cache_read_tokens !== undefined) row.cacheRead = s.cache_read_tokens;
      if (reasoning !== undefined && counter(reasoning)) row.reasoning = reasoning;
      result.rows.push(row);
    }

    if (role === 'host' && !inWindowCount && !result.unavailable) {
      result.unavailable = 'no usage records';
    }

    return { steps, discoveredChildren };
  }

  const hostEnvModel = query.env('ANTIGRAVITY_MODEL') || query.env('GEMINI_MODEL');
  const hostFallbackModel = (hostEnvModel ? normalizeAgyModelEffort(hostEnvModel).model ?? hostEnvModel : null) || 'unknown';

  const hostResult = processConversation(query.sessionId, 'host', hostFallbackModel);
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

  while (currentQueue.length > 0) {
    if (notes.subagent?.['read budget reached']) break;

    const eligibleThisLevel: string[] = [];
    for (const childId of currentQueue) {
      const transcriptFile = path.join(root, 'brain', childId, '.system_generated', 'logs', 'transcript.jsonl');
      let stat: { size: number; mtimeMs: number } | null = null;
      try {
        stat = fs.stat(transcriptFile);
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
      const childRes = processConversation(childId, 'subagent', fallback);
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
  }

  if (excess > 0) {
    note(notes, 'subagent', 'too many candidates', excess);
  }

  return result;
}
