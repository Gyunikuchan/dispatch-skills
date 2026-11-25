import path from 'node:path';
import type { DiagnosticModelUsage, DiagnosticUsage } from './rows.ts';
import { boundModels } from './bands.ts';
import { count, counter, counters, note, readErrorReason, readRoleTranscript, row, stageAt } from './read.ts';
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

export const claudeCode: HostUsageAdapter = {
  sessionEnv: ['CLAUDE_CODE_SESSION_ID'],
  read(query, fs, delegate) {
    if (!delegate) return collectClaudeUsage(query, fs);
    if (!delegate.cwd) return { rows: [], unavailable: 'host id file missing' };
    return collectClaudeUsage(query, fs, {
      projectDir: delegate.cwd.replace(/[^A-Za-z0-9]/g, '-'),
      rootRole: 'delegate',
      ...(delegate.collectResponses ? { responseStartMs: delegate.startMs } : {}),
    });
  },
};
export function collectClaudeUsage(query: HostUsageQuery, fs: HostUsageFs, options?: { projectDir?: string; rootRole?: 'host' | 'delegate'; responseStartMs?: number }): HostUsageResult {
  const result: HostUsageResult = { rows: [], notes: {} }; const notes = result.notes!;
  const rootRole = options?.rootRole ?? 'host';
  if (query.collectResponses) result.response = { basis: 'claude-assistant-message' };
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
  let userTurns = 0;
  const userTurnsByStage: Partial<Record<HostStage, number>> = {};
  function read(file: string, role: HostRole, depth = 0) {
    try {
      const text = readRoleTranscript(fs, file, query.budget, result, role);
      if (text === undefined) return;
      const messages = new Map<string, { at: number; firstAt: number; model: string; effort: string | null; usage: Record<string, unknown> }>();
      const toolUseById = new Map<string, { ids: Set<string>; unnamed: number }>();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let entry: any; try { entry = JSON.parse(line); } catch { note(notes, role, 'unparsed lines'); continue; }
        if (!entry || typeof entry !== 'object') continue;
        if (entry.type === 'user' && role === 'host' && rootRole === 'host') {
          if (entry.isMeta === true || entry.toolUseResult !== undefined) continue;
          const content = entry.message?.content;
          if (Array.isArray(content) && content.length > 0 && content.every((b: any) => b && typeof b === 'object' && b.type === 'tool_result')) continue;
          const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
          if (!Number.isFinite(at) || !(at >= query.startMs && at <= query.endMs)) continue;
          userTurns++;
          const stage = stageAt(query.stages, at);
          userTurnsByStage[stage] = (userTurnsByStage[stage] ?? 0) + 1;
          continue;
        }
        if (entry.type !== 'assistant' || !entry.message || typeof entry.message !== 'object') continue;
        const message = entry.message;
        if (typeof message.id === 'string' && message.id && Array.isArray(message.content)) {
          let tracker = toolUseById.get(message.id);
          if (!tracker) { tracker = { ids: new Set<string>(), unnamed: 0 }; toolUseById.set(message.id, tracker); }
          let unnamed = 0;
          for (const block of message.content) {
            if (!block || typeof block !== 'object' || block.type !== 'tool_use') continue;
            if (typeof block.id === 'string' && block.id) tracker.ids.add(block.id);
            else unnamed++;
          }
          if (unnamed > tracker.unnamed) tracker.unnamed = unnamed;
        }
        if (!('usage' in message)) continue;
        const usage = message.usage; const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
        if (typeof message.id !== 'string' || !message.id || typeof message.model !== 'string' || !message.model || !Number.isFinite(at) || !usage || typeof usage !== 'object' || !counter(usage.input_tokens) || !counter(usage.output_tokens) || ['cache_read_input_tokens', 'cache_creation_input_tokens'].some(key => usage[key] !== undefined && !counter(usage[key]))) { note(notes, role, 'unparsed lines'); continue; }
        messages.set(message.id, { at, firstAt: messages.get(message.id)?.firstAt ?? at, model: message.model, effort: typeof entry.effort === 'string' ? entry.effort : null, usage });
      }
      let count = 0;
      for (const [id, entry] of messages) {
        if (entry.model === '<synthetic>' || !(entry.at >= query.startMs && entry.at <= query.endMs)) continue;
        const u = entry.usage;
        if (typeof u['input_tokens'] !== 'number' || typeof u['output_tokens'] !== 'number') continue;
        count++;
        const tracker = toolUseById.get(id);
        const toolCalls = tracker ? tracker.ids.size + tracker.unnamed : 0;
        const hostRow: UsageRow & { stage: HostStage } = {
          stage: stageAt(query.stages, entry.at), role: role === 'host' ? rootRole : role,
          model: entry.model, effort: entry.effort, depth, atMs: entry.at, reasoningInOutput: true,
          turns: 1, toolCalls, toolTurns: toolCalls > 0 ? 1 : 0,
          input: u['input_tokens'], output: u['output_tokens'],
        };
        if (typeof u['cache_read_input_tokens'] === 'number') hostRow.cacheRead = u['cache_read_input_tokens'];
        if (typeof u['cache_creation_input_tokens'] === 'number') hostRow.cacheWrite = u['cache_creation_input_tokens'];
        applyCacheSplit(hostRow, u, counter);
        if (result.response) {
          hostRow.responseActor = file;
          // A streaming update can cross the boundary of the launch that owns the message.
          const start = options?.responseStartMs;
          if (start !== undefined && (entry.firstAt < start || entry.firstAt > query.endMs)) hostRow.skipResponse = true;
        }
        result.rows.push(hostRow);
      }
      if (role === 'host' && !count && !result.unavailable) result.unavailable = 'no usage records';
    } catch (error) { if (role === 'host') result.unavailable = readErrorReason(error); else note(notes, role, 'unreadable files'); }
  }
  read(host, 'host', 0);
  if (rootRole === 'host' && !result.unavailable && !Object.keys(notes.host ?? {}).length) {
    result.userTurns = userTurns;
    result.userTurnsByStage = userTurnsByStage;
  }
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

export const CLAUDE_INVOCATION_USAGE = 'claude.result.usage';

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
  const out = counters(event['usage'], { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' }, CLAUDE_INVOCATION_USAGE, 'uncached');
  if (out) applyCacheSplit(out, event['usage'], count);
  return out;
}
