import path from 'node:path';
import type { DiagnosticUsage } from '../../toolkit/types.ts';
import { counter, counters, note, readErrorReason, readTranscript, row, stageAt, type Row } from './read.ts';
import { addCounters, type HostRole, type HostStage, type HostUsageAdapter, type HostUsageFs, type HostUsageQuery, type HostUsageResult, type UsageRow } from './rows.ts';

const pattern = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl(?:\.zst)?$/;
type File = { file: string; id: string; mtime: number; date: string; failed?: boolean };
export const codex: HostUsageAdapter = { sessionEnv: ['CODEX_THREAD_ID'], read(query, fs) { return collectCodexUsage(query, fs); } };
export function collectCodexUsage(query: HostUsageQuery, fs: HostUsageFs, options?: { rootRole?: 'host' | 'delegate' }): HostUsageResult {
  const result: HostUsageResult = { rows: [], notes: {} }; const notes = result.notes!;
  const rootRole = options?.rootRole ?? 'host';
  const root = path.join(query.env('CODEX_HOME') || path.join(query.home, '.codex'), 'sessions');
  const dirs: { dir: string; date: string }[] = []; const failedLists = new Set<string>();
  function list(dir: string, role: HostRole): string[] { try { return fs.list(dir); } catch (error) { failedLists.add(dir); if (role === 'host') result.unavailable = readErrorReason(error); else note(notes, role, 'unreadable files'); return []; } }
  function stat(file: string, role: HostRole) { try { const info = fs.stat(file); if (!info) { if (role === 'host') result.unavailable = 'read-error:ENOENT'; else note(notes, role, 'unreadable files'); } return info; } catch (error) { if (role === 'host') result.unavailable = readErrorReason(error); else note(notes, role, 'unreadable files'); return null; } }
  for (const y of list(root, 'host').filter(x => /^\d{4}$/.test(x))) for (const m of list(path.join(root, y), 'host').filter(x => /^\d{2}$/.test(x))) for (const d of list(path.join(root, y, m), 'host').filter(x => /^\d{2}$/.test(x))) dirs.push({ dir: path.join(root, y, m, d), date: `${y}-${m}-${d}` });
  const hosts: File[] = [];
  for (const { dir, date } of dirs) for (const name of list(dir, 'host')) { const match = pattern.exec(name); if (!match || match[1] !== query.sessionId) continue; const file = path.join(dir, name); const info = stat(file, 'host'); hosts.push({ file, id: match[1]!, mtime: info?.mtimeMs ?? query.startMs, date, failed: !info }); }
  if (failedLists.size) return result;
  hosts.sort((a, b) => a.file.localeCompare(b.file)); if (!hosts.length) return { ...result, unavailable: result.unavailable ?? 'host id file missing' };
  const seen = new Set<number>(); let hostCount = 0;
  const acceptedDepths = new Map<string, number>([[query.sessionId, 0]]);
  type Deferred = { f: File; parentId: string };
  const deferred: Deferred[] = [];
  const deferredIds = new Set<string>();

  function parseLines(lines: string[], startIndex: number, role: HostRole, depth: number, totals: Set<number>, model = '', effort: string | null = null) {
    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i]!; if (!line.trim()) continue;
      let entry: any; try { entry = JSON.parse(line); } catch { note(notes, role, 'unparsed lines'); continue; }
      if (!entry || typeof entry !== 'object') continue;
      if (entry.type === 'turn_context') { model = typeof entry.payload?.model === 'string' ? entry.payload.model : ''; effort = typeof entry.payload?.effort === 'string' ? entry.payload.effort : null; }
      if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') continue;
      const info = entry.payload.info; const total = info?.total_token_usage?.total_tokens; const u = info?.last_token_usage;
      const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
      if (!counter(total) || !u || typeof u !== 'object' || !counter(u.input_tokens) || !counter(u.output_tokens) || (u.cached_input_tokens !== undefined && (!counter(u.cached_input_tokens) || u.cached_input_tokens > u.input_tokens)) || (u.reasoning_output_tokens !== undefined && !counter(u.reasoning_output_tokens)) || !Number.isFinite(at) || !model) { note(notes, role, 'unparsed lines'); continue; }
      if (totals.has(total)) continue; totals.add(total); if (!(at >= query.startMs && at <= query.endMs)) continue;
      const hostRow: UsageRow & { stage: HostStage } = { stage: stageAt(query.stages, at), role: role === 'host' ? rootRole : role, model, effort, depth, atMs: at, reasoningInOutput: true, input: u.input_tokens - (typeof u.cached_input_tokens === 'number' ? u.cached_input_tokens : 0), output: u.output_tokens };
      if (!/\.\d+/.test(entry.timestamp)) hostRow.wholeSecond = true;
      if (typeof u.cached_input_tokens === 'number') hostRow.cacheRead = u.cached_input_tokens;
      if (typeof u.reasoning_output_tokens === 'number') hostRow.reasoning = u.reasoning_output_tokens;
      result.rows.push(hostRow); if (role === 'host') hostCount++;
    }
  }

  function read(f: File, role: HostRole, totals: Set<number>, verify: boolean, forcedDepth?: number): boolean {
    try {
      const data = readTranscript(fs, f.file, query.budget);
      if (data.stop) { if (data.stop === 'budget') note(notes, role, 'read budget reached'); else if (role === 'host') result.unavailable = data.stop === 'zstd' ? 'zstd unavailable' : 'transcript over size cap'; else note(notes, role, data.stop === 'zstd' ? 'zstd unavailable' : 'unverified candidates'); return false; }
      if (data.text === undefined) { if (role === 'host') result.unavailable = 'read-error:ENOENT'; else note(notes, role, 'unreadable files'); return false; }
      const lines = data.text.split('\n');
      if (!verify) { parseLines(lines, 0, role, forcedDepth ?? 0, totals); return true; }
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!; if (!line.trim()) continue;
        let entry: any; try { entry = JSON.parse(line); } catch { note(notes, role, 'unparsed lines'); return false; }
        if (!entry || typeof entry !== 'object') return false;
        const parentId = entry.payload?.parent_thread_id;
        if (entry.type !== 'session_meta' || entry.payload?.thread_source !== 'subagent' || typeof parentId !== 'string' || !parentId) return false;
        const parentDepth = acceptedDepths.get(parentId);
        if (parentDepth === undefined || deferredIds.has(f.id)) {
          deferredIds.add(f.id);
          deferred.push({ f, parentId });
          return true;
        }
        const depth = parentDepth + 1;
        acceptedDepths.set(f.id, depth);
        parseLines(lines, i + 1, role, depth, totals);
        return true;
      }
      return false;
    } catch (error) { if (role === 'host') result.unavailable = readErrorReason(error); else note(notes, role, 'unreadable files'); return false; }
  }
  for (const host of hosts) { if (host.failed || !read(host, 'host', seen, false)) break; if (notes.host?.['read budget reached']) return result; }
  if (notes.host?.['read budget reached']) return result;
  if (!hostCount && !result.unavailable) result.unavailable = 'no usage records';
  const end = new Date(query.endMs + 86400000).toISOString().slice(0, 10); const candidates: File[] = [];
  for (const { dir, date } of dirs) {
    if (date < hosts[0]!.date || date > end) continue;
    for (const name of list(dir, 'subagent')) { const match = pattern.exec(name); if (!match || match[1] === query.sessionId) continue; const file = path.join(dir, name); const info = stat(file, 'subagent'); candidates.push({ file, id: match[1]!, mtime: info?.mtimeMs ?? query.startMs, date, failed: !info }); }
  }
  if (failedLists.size) return result;
  candidates.sort((a, b) => b.file.localeCompare(a.file));
  // Unknown mtimes count as live so incomplete history remains visible.
  const live = candidates.filter(f => f.mtime >= query.startMs).slice(0, 256); const liveIds = new Set(live.map(f => f.id));
  const eligible = candidates.filter(f => liveIds.has(f.id));
  const selected = eligible.slice(0, 256); const omitted = eligible.slice(256);
  const incomplete = new Set(omitted.map(f => f.id));
  const excess = candidates.filter(f => f.mtime >= query.startMs && !liveIds.has(f.id)).length + omitted.length;
  if (excess) note(notes, 'subagent', 'too many candidates', excess);
  const childSeen = new Map<string, Set<number>>();
  // Failed history blocks later files of the same thread.
  for (const f of selected.reverse()) { if (incomplete.has(f.id)) continue; const totals = childSeen.get(f.id) ?? new Set<number>(); if (!f.failed && read(f, 'subagent', totals, true)) childSeen.set(f.id, totals); else incomplete.add(f.id); if (notes.subagent?.['read budget reached']) break; }
  let pending = deferred;
  const deferredIncomplete = new Set<string>();
  while (pending.length && !notes.subagent?.['read budget reached']) {
    const next: Deferred[] = []; let added = false;
    for (const item of pending) {
      if (deferredIncomplete.has(item.f.id)) continue;
      const parentDepth = acceptedDepths.get(item.parentId);
      if (parentDepth === undefined) { next.push(item); continue; }
      const depth = parentDepth + 1;
      const totals = childSeen.get(item.f.id) ?? new Set<number>();
      if (read(item.f, 'subagent', totals, false, depth)) {
        acceptedDepths.set(item.f.id, depth);
        childSeen.set(item.f.id, totals);
        added = true;
      } else {
        deferredIncomplete.add(item.f.id);
      }
      if (notes.subagent?.['read budget reached']) break;
    }
    if (!added) break;
    pending = next;
  }
  return result;
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
    const usage = counters(event['usage'], { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cached_input_tokens', cacheWrite: 'cache_write_input_tokens', reasoning: 'reasoning_output_tokens' }, 'codex.turn.completed', 'uncached');
    if (!usage) return undefined;
    if (usage.cacheRead !== undefined) usage.input = Math.max(0, usage.input - usage.cacheRead);
    // The first completion counts; a later turn counts only when its own `turn.started` arrived after the prior one.
    if (!completed || started) {
      if (!total) total = { ...usage };
      else addCounters(total, usage);
      completed = true;
    }
    started = false;
  }
  return total;
}
