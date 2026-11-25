import path from 'node:path';
import type { DiagnosticUsage } from './rows.ts';
import { counter, counters, note, readErrorReason, readRoleTranscript, row, stageAt } from './read.ts';
import type { Row } from './read.ts';
import { addCounters } from './rows.ts';
import type {
  HostNotes,
  HostRole,
  HostStage,
  HostUsageAdapter,
  HostUsageFs,
  HostUsageQuery,
  HostUsageResult,
  UsageRow,
} from './rows.ts';

const pattern = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl(?:\.zst)?$/;
type File = { file: string; id: string; mtime: number; date: string; failed?: boolean };
export const codex: HostUsageAdapter = {
  sessionEnv: ['CODEX_THREAD_ID'],
  read: (query, fs, delegate) => collectCodexUsage(query, fs, delegate ? { rootRole: 'delegate' } : undefined),
};
export function collectCodexUsage(
  query: HostUsageQuery,
  fs: HostUsageFs,
  options?: { rootRole?: 'host' | 'delegate' },
): HostUsageResult {
  const notes: HostNotes = {};
  const result: HostUsageResult = { rows: [], notes };
  const rootRole = options?.rootRole ?? 'host';
  if (query.collectResponses) {
    result.response = { basis: 'codex-token-count', limited: true };
  }
  const root = path.join(query.env('CODEX_HOME') || path.join(query.home, '.codex'), 'sessions');
  const dirs: Array<{ dir: string; date: string }> = [];
  const failedLists = new Set<string>();
  function list(dir: string, role: HostRole): Array<string> {
    try {
      return fs.list(dir);
    } catch (error) {
      failedLists.add(dir);
      if (role === 'host') {
        result.unavailable = readErrorReason(error);
      } else {
        note(notes, role, 'unreadable files');
      }
      return [];
    }
  }
  function stat(file: string, role: HostRole) {
    try {
      const info = fs.stat(file);
      if (!info) {
        if (role === 'host') {
          result.unavailable = 'read-error:ENOENT';
        } else {
          note(notes, role, 'unreadable files');
        }
      }
      return info;
    } catch (error) {
      if (role === 'host') {
        result.unavailable = readErrorReason(error);
      } else {
        note(notes, role, 'unreadable files');
      }
      return null;
    }
  }
  for (const y of list(root, 'host').filter((x) => /^\d{4}$/.test(x))) {
    for (const m of list(path.join(root, y), 'host').filter((x) => /^\d{2}$/.test(x))) {
      for (const d of list(path.join(root, y, m), 'host').filter((x) => /^\d{2}$/.test(x))) {
        dirs.push({ dir: path.join(root, y, m, d), date: `${y}-${m}-${d}` });
      }
    }
  }
  const hosts: Array<File> = [];
  for (const { dir, date } of dirs) {
    for (const name of list(dir, 'host')) {
      const match = pattern.exec(name);
      if (!match || match[1] !== query.sessionId) {
        continue;
      }
      const file = path.join(dir, name);
      const info = stat(file, 'host');
      hosts.push({ file, id: match[1], mtime: info?.mtimeMs ?? query.startMs, date, failed: !info });
    }
  }
  if (failedLists.size) {
    return result;
  }
  hosts.sort((a, b) => a.file.localeCompare(b.file));
  const [earliest] = hosts;
  if (!earliest) {
    return { ...result, unavailable: result.unavailable ?? 'host id file missing' };
  }
  const seen = new Set<number>();
  let hostCount = 0;
  let hostUserTurns = 0;
  const hostUserTurnsByStage: Partial<Record<HostStage, number>> = {};
  const acceptedDepths = new Map<string, number>([[query.sessionId, 0]]);
  type Deferred = { f: File; parentId: string };
  const deferred: Array<Deferred> = [];
  const deferredIds = new Set<string>();

  function parseLines(
    lines: Array<string>,
    startIndex: number,
    role: HostRole,
    depth: number,
    totals: Set<number>,
    actor: string,
    model = '',
    effort: string | null = null,
  ) {
    let hasResponseItems = false;
    let pendingToolCalls = 0;
    const fileRows: Array<UsageRow & { stage: HostStage }> = [];
    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!line.trim()) {
        continue;
      }
      let entry: ReturnType<typeof row>;
      try {
        entry = row(JSON.parse(line));
      } catch {
        note(notes, role, 'unparsed lines');
        continue;
      }
      if (!entry) {
        continue;
      }
      const payload = row(entry['payload']);
      if (entry['type'] === 'turn_context') {
        model = typeof payload?.['model'] === 'string' ? payload['model'] : '';
        effort = typeof payload?.['effort'] === 'string' ? payload['effort'] : null;
        continue;
      }
      if (entry['type'] === 'response_item') {
        hasResponseItems = true;
        if (payload?.['type'] === 'function_call' || payload?.['type'] === 'custom_tool_call') {
          pendingToolCalls++;
        }
        continue;
      }
      if (entry['type'] !== 'event_msg' || !payload) {
        continue;
      }
      if (payload['type'] === 'user_message' && role === 'host' && rootRole === 'host') {
        const at = typeof entry['timestamp'] === 'string' ? Date.parse(entry['timestamp']) : Number.NaN;
        if (Number.isFinite(at) && at >= query.startMs && at <= query.endMs) {
          hostUserTurns++;
          const stage = stageAt(query.stages, at);
          hostUserTurnsByStage[stage] = (hostUserTurnsByStage[stage] ?? 0) + 1;
        }
        continue;
      }
      if (payload['type'] !== 'token_count') {
        continue;
      }
      const info = row(payload['info']);
      const total = row(info?.['total_token_usage'])?.['total_tokens'];
      const u = row(info?.['last_token_usage']);
      const timestamp = typeof entry['timestamp'] === 'string' ? entry['timestamp'] : '';
      const at = Date.parse(timestamp);
      if (
        !counter(total) ||
        !u ||
        !counter(u['input_tokens']) ||
        !counter(u['output_tokens']) ||
        (u['cached_input_tokens'] !== undefined &&
          (!counter(u['cached_input_tokens']) || u['cached_input_tokens'] > u['input_tokens'])) ||
        (u['reasoning_output_tokens'] !== undefined && !counter(u['reasoning_output_tokens'])) ||
        !Number.isFinite(at) ||
        !model
      ) {
        note(notes, role, 'unparsed lines');
        continue;
      }
      if (totals.has(total)) {
        continue;
      }
      totals.add(total);
      const toolCalls = pendingToolCalls;
      pendingToolCalls = 0;
      if (!(at >= query.startMs && at <= query.endMs)) {
        continue;
      }
      const hostRow: UsageRow & { stage: HostStage } = {
        stage: stageAt(query.stages, at),
        role: role === 'host' ? rootRole : role,
        model,
        effort,
        depth,
        atMs: at,
        reasoningInOutput: true,
        turns: 1,
        toolCalls,
        toolTurns: toolCalls > 0 ? 1 : 0,
        input: u['input_tokens'] - (typeof u['cached_input_tokens'] === 'number' ? u['cached_input_tokens'] : 0),
        output: u['output_tokens'],
      };
      if (result.response) {
        hostRow.responseActor = actor;
      }
      if (!/\.\d+/.test(timestamp)) {
        hostRow.wholeSecond = true;
      }
      if (typeof u['cached_input_tokens'] === 'number') {
        hostRow.cacheRead = u['cached_input_tokens'];
      }
      if (typeof u['reasoning_output_tokens'] === 'number') {
        hostRow.reasoning = u['reasoning_output_tokens'];
      }
      fileRows.push(hostRow);
      if (role === 'host') {
        hostCount++;
      }
    }
    for (const r of fileRows) {
      if (!hasResponseItems) {
        delete r.toolCalls;
        delete r.toolTurns;
      }
      result.rows.push(r);
    }
  }

  function read(f: File, role: HostRole, totals: Set<number>, verify: boolean, forcedDepth?: number): boolean {
    try {
      const text = readRoleTranscript(fs, f.file, query.budget, result, role, 'unverified candidates');
      if (text === undefined) {
        return false;
      }
      const lines = text.split('\n');
      if (!verify) {
        parseLines(lines, 0, role, forcedDepth ?? 0, totals, f.id);
        return true;
      }
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (!line.trim()) {
          continue;
        }
        let entry: ReturnType<typeof row>;
        try {
          entry = row(JSON.parse(line));
        } catch {
          note(notes, role, 'unparsed lines');
          return false;
        }
        const payload = row(entry?.['payload']);
        const parentId = payload?.['parent_thread_id'];
        if (
          entry?.['type'] !== 'session_meta' ||
          payload?.['thread_source'] !== 'subagent' ||
          typeof parentId !== 'string' ||
          !parentId
        ) {
          return false;
        }
        const parentDepth = acceptedDepths.get(parentId);
        if (parentDepth === undefined || deferredIds.has(f.id)) {
          deferredIds.add(f.id);
          deferred.push({ f, parentId });
          return true;
        }
        const depth = parentDepth + 1;
        acceptedDepths.set(f.id, depth);
        parseLines(lines, i + 1, role, depth, totals, f.id);
        return true;
      }
      return false;
    } catch (error) {
      if (role === 'host') {
        result.unavailable = readErrorReason(error);
      } else {
        note(notes, role, 'unreadable files');
      }
      return false;
    }
  }
  for (const host of hosts) {
    if (host.failed || !read(host, 'host', seen, false)) {
      break;
    }
    if (notes.host?.['read budget reached']) {
      return result;
    }
  }
  if (notes.host?.['read budget reached']) {
    return result;
  }
  if (!hostCount && !result.unavailable) {
    result.unavailable = 'no usage records';
  }
  if (rootRole === 'host' && hostUserTurns > 0 && !result.unavailable && !Object.keys(notes.host ?? {}).length) {
    result.userTurns = hostUserTurns;
    result.userTurnsByStage = hostUserTurnsByStage;
  }
  const end = new Date(query.endMs + 86_400_000).toISOString().slice(0, 10);
  const candidates: Array<File> = [];
  for (const { dir, date } of dirs) {
    if (date < earliest.date || date > end) {
      continue;
    }
    for (const name of list(dir, 'subagent')) {
      const id = pattern.exec(name)?.[1];
      if (id === undefined || id === query.sessionId) {
        continue;
      }
      const file = path.join(dir, name);
      const info = stat(file, 'subagent');
      candidates.push({ file, id, mtime: info?.mtimeMs ?? query.startMs, date, failed: !info });
    }
  }
  if (failedLists.size) {
    return result;
  }
  candidates.sort((a, b) => b.file.localeCompare(a.file));
  // Unknown mtimes count as live so incomplete history remains visible.
  const live = candidates.filter((f) => f.mtime >= query.startMs).slice(0, 256);
  const liveIds = new Set(live.map((f) => f.id));
  const eligible = candidates.filter((f) => liveIds.has(f.id));
  const selected = eligible.slice(0, 256);
  const omitted = eligible.slice(256);
  const incomplete = new Set(omitted.map((f) => f.id));
  const excess = candidates.filter((f) => f.mtime >= query.startMs && !liveIds.has(f.id)).length + omitted.length;
  if (excess) {
    note(notes, 'subagent', 'too many candidates', excess);
  }
  const childSeen = new Map<string, Set<number>>();
  // Failed history blocks later files of the same thread.
  for (const f of selected.reverse()) {
    if (incomplete.has(f.id)) {
      continue;
    }
    const totals = childSeen.get(f.id) ?? new Set<number>();
    if (!f.failed && read(f, 'subagent', totals, true)) {
      childSeen.set(f.id, totals);
    } else {
      incomplete.add(f.id);
    }
    if (notes.subagent?.['read budget reached']) {
      break;
    }
  }
  let pending = deferred;
  const deferredIncomplete = new Set<string>();
  while (pending.length && !notes.subagent?.['read budget reached']) {
    const next: Array<Deferred> = [];
    let added = false;
    for (const item of pending) {
      if (deferredIncomplete.has(item.f.id)) {
        continue;
      }
      const parentDepth = acceptedDepths.get(item.parentId);
      if (parentDepth === undefined) {
        next.push(item);
        continue;
      }
      const depth = parentDepth + 1;
      const totals = childSeen.get(item.f.id) ?? new Set<number>();
      if (read(item.f, 'subagent', totals, false, depth)) {
        acceptedDepths.set(item.f.id, depth);
        childSeen.set(item.f.id, totals);
        added = true;
      } else {
        deferredIncomplete.add(item.f.id);
      }
      if (notes.subagent?.['read budget reached']) {
        break;
      }
    }
    if (!added) {
      break;
    }
    pending = next;
  }
  return result;
}

export const CODEX_COMPLETION_USAGE = 'codex.turn.completed';

export function codexUsage(raw: string): DiagnosticUsage | undefined {
  let total: DiagnosticUsage | undefined;
  let completed = false;
  let started = false;
  for (const line of raw.split(/\r?\n/).filter((v) => v.trim())) {
    let event: Row | null;
    try {
      event = row(JSON.parse(line));
    } catch {
      return undefined;
    }
    if (event?.['type'] === 'turn.started') {
      started = true;
      continue;
    }
    if (event?.['type'] !== 'turn.completed') {
      continue;
    }
    const usage = counters(
      event['usage'],
      {
        input: 'input_tokens',
        output: 'output_tokens',
        cacheRead: 'cached_input_tokens',
        cacheWrite: 'cache_write_input_tokens',
        reasoning: 'reasoning_output_tokens',
      },
      CODEX_COMPLETION_USAGE,
      'uncached',
    );
    if (!usage) {
      return undefined;
    }
    if (usage.cacheRead !== undefined) {
      usage.input = Math.max(0, usage.input - usage.cacheRead);
    }
    // The first completion counts; a later turn counts only when its own `turn.started` arrived after the prior one.
    if (!completed || started) {
      if (!total) {
        total = { ...usage };
      } else {
        addCounters(total, usage);
      }
      completed = true;
    }
    started = false;
  }
  return total;
}
