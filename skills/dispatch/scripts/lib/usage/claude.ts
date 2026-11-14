import path from 'node:path';
import type { DiagnosticModelUsage, DiagnosticUsage } from '../../toolkit/types.ts';
import { boundModels } from './bands.ts';
import { count, counter, counters, note, readErrorReason, readTranscript, row, stageAt } from './read.ts';
import { addCounters, type Counters, type HostRole, type HostStage, type HostUsageAdapter, type HostUsageFs, type HostUsageQuery, type HostUsageResult, type UsageRow } from './rows.ts';

function applyCacheSplit(target: Counters, rawUsage: unknown, valid: (v: unknown) => v is number): void {
  const cc = row(row(rawUsage)?.['cache_creation']);
  if (!cc) return;
  const c5m = cc['ephemeral_5m_input_tokens'];
  const c1h = cc['ephemeral_1h_input_tokens'];
  if ((c5m !== undefined && !valid(c5m)) || (c1h !== undefined && !valid(c1h))) return;
  if (((c5m as number | undefined) ?? 0) + ((c1h as number | undefined) ?? 0) > (target.cacheWrite ?? 0)) return;
  if (typeof c5m === 'number') target.cacheWrite5m = c5m;
  if (typeof c1h === 'number') target.cacheWrite1h = c1h;
}

export const claudeCode: HostUsageAdapter = { sessionEnv: ['CLAUDE_CODE_SESSION_ID'], read(query, fs) { return collectClaudeUsage(query, fs); } };
export function collectClaudeUsage(query: HostUsageQuery, fs: HostUsageFs, options?: { projectDir?: string; rootRole?: 'host' | 'delegate' }): HostUsageResult {
  const result: HostUsageResult = { rows: [], notes: {} }; const notes = result.notes!;
  const rootRole = options?.rootRole ?? 'host';
  const root = path.join(query.env('CLAUDE_CONFIG_DIR') || path.join(query.home, '.claude'), 'projects');
  const hosts: { file: string; stat: { size: number; mtimeMs: number } }[] = [];
  if (options?.projectDir !== undefined) {
    const file = path.join(root, options.projectDir, `${query.sessionId}.jsonl`);
    try { const stat = fs.stat(file); if (stat) hosts.push({ file, stat }); } catch (error) { result.unavailable = readErrorReason(error); }
  } else {
    let projects: string[] = [];
    try { projects = fs.list(root); } catch (error) { result.unavailable = readErrorReason(error); }
    for (const dir of projects) { const file = path.join(root, dir, `${query.sessionId}.jsonl`); try { const stat = fs.stat(file); if (stat) hosts.push({ file, stat }); } catch (error) { result.unavailable = readErrorReason(error); } }
    hosts.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  }
  if (result.unavailable || !hosts.length) return { ...result, unavailable: result.unavailable ?? 'host id file missing' };
  const host = hosts[0]!.file;
  function read(file: string, role: HostRole, depth = 0) {
    try {
      const data = readTranscript(fs, file, query.budget);
      if (data.stop) { if (data.stop === 'budget') note(notes, role, 'read budget reached'); else if (role === 'host') result.unavailable = data.stop === 'zstd' ? 'zstd unavailable' : 'transcript over size cap'; else note(notes, role, data.stop === 'zstd' ? 'zstd unavailable' : 'subagents over size cap'); return; }
      if (data.text === undefined) { if (role === 'host') result.unavailable = 'read-error:ENOENT'; else note(notes, role, 'unreadable files'); return; }
      const messages = new Map<string, { at: number; model: string; effort: string | null; usage: Record<string, unknown> }>();
      for (const line of data.text.split('\n')) {
        if (!line.trim()) continue;
        let entry: any; try { entry = JSON.parse(line); } catch { note(notes, role, 'unparsed lines'); continue; }
        if (!entry || typeof entry !== 'object' || entry.type !== 'assistant' || !entry.message || typeof entry.message !== 'object' || !('usage' in entry.message)) continue;
        const message = entry.message; const usage = message.usage; const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
        if (typeof message.id !== 'string' || !message.id || typeof message.model !== 'string' || !message.model || !Number.isFinite(at) || !usage || typeof usage !== 'object' || !counter(usage.input_tokens) || !counter(usage.output_tokens) || ['cache_read_input_tokens', 'cache_creation_input_tokens'].some(key => usage[key] !== undefined && !counter(usage[key]))) { note(notes, role, 'unparsed lines'); continue; }
        messages.set(message.id, { at, model: message.model, effort: typeof entry.effort === 'string' ? entry.effort : null, usage });
      }
      let count = 0;
      for (const entry of messages.values()) { if (entry.model === '<synthetic>' || !(entry.at >= query.startMs && entry.at <= query.endMs)) continue; const u = entry.usage; if (typeof u['input_tokens'] !== 'number' || typeof u['output_tokens'] !== 'number') continue; count++; const hostRow: UsageRow & { stage: HostStage } = { stage: stageAt(query.stages, entry.at), role: role === 'host' ? rootRole : role, model: entry.model, effort: entry.effort, depth, atMs: entry.at, reasoningInOutput: true, input: u['input_tokens'], output: u['output_tokens'] }; if (typeof u['cache_read_input_tokens'] === 'number') hostRow.cacheRead = u['cache_read_input_tokens']; if (typeof u['cache_creation_input_tokens'] === 'number') hostRow.cacheWrite = u['cache_creation_input_tokens']; applyCacheSplit(hostRow, u, counter); result.rows.push(hostRow); }
      if (role === 'host' && !count && !result.unavailable) result.unavailable = 'no usage records';
    } catch (error) { if (role === 'host') result.unavailable = readErrorReason(error); else note(notes, role, 'unreadable files'); }
  }
  read(host, 'host', 0);
  function walkSubagents(dir: string, depth: number) {
    let names: string[] = [];
    try { names = fs.list(dir); } catch { note(notes, 'subagent', 'unreadable files'); return; }
    for (const name of names) {
      if (notes.subagent?.['read budget reached']) break;
      const entryPath = path.join(dir, name);
      if (/^agent-.*\.jsonl$/.test(name)) {
        let stat: { size: number; mtimeMs: number } | null; try { stat = fs.stat(entryPath); } catch { note(notes, 'subagent', 'unreadable files'); continue; }
        if (!stat) { note(notes, 'subagent', 'unreadable files'); continue; }
        if (stat.mtimeMs < query.startMs) continue; read(entryPath, 'subagent', depth);
      } else if (!name.endsWith('.jsonl')) {
        walkSubagents(entryPath, name === 'subagents' ? depth : depth + 1);
      }
    }
  }
  if (!notes.host?.['read budget reached']) {
    walkSubagents(path.join(path.dirname(host), query.sessionId, 'subagents'), 1);
  }
  return result;
}

export function claudeUsage(raw: string): DiagnosticUsage | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  const event = row(Array.isArray(parsed) ? parsed.findLast((v: unknown) => row(v)?.['type'] === 'result') : parsed);
  if (event?.['type'] !== 'result') return undefined;
  const models = row(event['modelUsage']);
  if (models && Object.keys(models).length > 0) {
    const parts = Object.values(models).map((v) => counters(v, { input: 'inputTokens', output: 'outputTokens', cacheRead: 'cacheReadInputTokens', cacheWrite: 'cacheCreationInputTokens', reasoning: 'thinkingTokens' }, 'claude.result.modelUsage', 'uncached'));
    if (parts.some((v) => !v)) return undefined;
    const out: DiagnosticUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, scope: 'invocation', provenance: 'claude.result.modelUsage', inputSemantics: 'uncached', actualModels: Object.keys(models).slice(0, 8) };
    for (const part of parts) addCounters(out, part!);
    // Per-model counters let the report split a cascade's cost by the model that actually ran.
    const rawModels: Record<string, DiagnosticModelUsage> = Object.fromEntries(Object.keys(models).map((name, index) => {
      const part = parts[index]!;
      return [name, { input: part.input, output: part.output, ...(part.cacheRead === undefined ? {} : { cacheRead: part.cacheRead }), ...(part.cacheWrite === undefined ? {} : { cacheWrite: part.cacheWrite }), ...(part.reasoning === undefined ? {} : { reasoning: part.reasoning }) }];
    }));
    out.models = boundModels(rawModels);
    return Object.values(out).some((v) => typeof v === 'number' && !count(v)) ? undefined : out;
  }
  const out = counters(event['usage'], { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' }, 'claude.result.usage', 'uncached');
  if (out) applyCacheSplit(out, event['usage'], count);
  return out;
}
