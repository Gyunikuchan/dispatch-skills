import path from 'node:path';
import type { DiagnosticUsage } from '../../toolkit/types.ts';
import { counter, counters, note, readErrorReason, readTranscript, row, stageAt } from './read.ts';
import { addCounters, type HostRole, type HostStage, type HostUsageAdapter, type HostUsageFs, type HostUsageQuery, type HostUsageResult, type UsageRow } from './rows.ts';

export const claudeCode: HostUsageAdapter = { sessionEnv: ['CLAUDE_CODE_SESSION_ID'], read(query, fs) { return collect(query, fs); } };
function collect(query: HostUsageQuery, fs: HostUsageFs): HostUsageResult {
  const result: HostUsageResult = { rows: [], notes: {} }; const notes = result.notes!;
  const root = path.join(query.env('CLAUDE_CONFIG_DIR') || path.join(query.home, '.claude'), 'projects');
  let projects: string[] = [];
  try { projects = fs.list(root); } catch (error) { result.unavailable = readErrorReason(error); }
  const hosts: { file: string; stat: { size: number; mtimeMs: number } }[] = [];
  for (const dir of projects) { const file = path.join(root, dir, `${query.sessionId}.jsonl`); try { const stat = fs.stat(file); if (stat) hosts.push({ file, stat }); } catch (error) { result.unavailable = readErrorReason(error); } }
  hosts.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  if (result.unavailable || !hosts.length) return { ...result, unavailable: result.unavailable ?? 'host id file missing' };
  const host = hosts[0]!.file;
  function read(file: string, role: HostRole) {
    try {
      const data = readTranscript(fs, file, query.budget);
      if (data.stop) { if (data.stop === 'budget') note(notes, role, 'read budget reached'); else if (role === 'host') result.unavailable = data.stop === 'zstd' ? 'zstd unavailable' : 'transcript over size cap'; else note(notes, role, data.stop === 'zstd' ? 'zstd unavailable' : 'subagents over size cap'); return; }
      if (data.text === undefined) { if (role === 'host') result.unavailable = 'read-error:ENOENT'; else note(notes, role, 'unreadable files'); return; }
      const messages = new Map<string, { at: number; model: string; effort: string | null; usage: Record<string, number> }>();
      for (const line of data.text.split('\n')) {
        if (!line.trim()) continue;
        let entry: any; try { entry = JSON.parse(line); } catch { note(notes, role, 'unparsed lines'); continue; }
        if (!entry || typeof entry !== 'object' || entry.type !== 'assistant' || !entry.message || typeof entry.message !== 'object' || !('usage' in entry.message)) continue;
        const message = entry.message; const usage = message.usage; const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
        if (typeof message.id !== 'string' || !message.id || typeof message.model !== 'string' || !message.model || !Number.isFinite(at) || !usage || typeof usage !== 'object' || !counter(usage.input_tokens) || !counter(usage.output_tokens) || ['cache_read_input_tokens', 'cache_creation_input_tokens'].some(key => usage[key] !== undefined && !counter(usage[key]))) { note(notes, role, 'unparsed lines'); continue; }
        messages.set(message.id, { at, model: message.model, effort: typeof entry.effort === 'string' ? entry.effort : null, usage });
      }
      let count = 0;
      for (const entry of messages.values()) { if (entry.model === '<synthetic>' || !(entry.at >= query.startMs && entry.at <= query.endMs)) continue; const u = entry.usage; if (typeof u['input_tokens'] !== 'number' || typeof u['output_tokens'] !== 'number') continue; count++; const hostRow: UsageRow & { stage: HostStage } = { stage: stageAt(query.stages, entry.at), role, model: entry.model, effort: entry.effort, depth: role === 'host' ? 0 : 1, atMs: entry.at, reasoningInOutput: true, input: u['input_tokens'], output: u['output_tokens'] }; if (typeof u['cache_read_input_tokens'] === 'number') hostRow.cacheRead = u['cache_read_input_tokens']; if (typeof u['cache_creation_input_tokens'] === 'number') hostRow.cacheWrite = u['cache_creation_input_tokens']; result.rows.push(hostRow); }
      if (role === 'host' && !count && !result.unavailable) result.unavailable = 'no usage records';
    } catch (error) { if (role === 'host') result.unavailable = readErrorReason(error); else note(notes, role, 'unreadable files'); }
  }
  read(host, 'host');
  if (!notes.host?.['read budget reached']) {
    const dir = path.join(path.dirname(host), query.sessionId, 'subagents'); let names: string[] = [];
    try { names = fs.list(dir); } catch { note(notes, 'subagent', 'unreadable files'); }
    for (const name of names) {
      if (!/^agent-.*\.jsonl$/.test(name)) continue; const file = path.join(dir, name);
      let stat: { size: number; mtimeMs: number } | null; try { stat = fs.stat(file); } catch { note(notes, 'subagent', 'unreadable files'); continue; }
      if (!stat) { note(notes, 'subagent', 'unreadable files'); continue; }
      if (stat.mtimeMs < query.startMs) continue; read(file, 'subagent'); if (notes.subagent?.['read budget reached']) break;
    }
  }
  return result;
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
    for (const part of parts) addCounters(out, part!);
    // Per-model counters let the report split a cascade's cost by the model that actually ran.
    out.models = Object.fromEntries(Object.keys(models).map((name, index) => {
      const part = parts[index]!;
      return [name, { input: part.input, output: part.output, ...(part.cacheRead === undefined ? {} : { cacheRead: part.cacheRead }), ...(part.cacheWrite === undefined ? {} : { cacheWrite: part.cacheWrite }), ...(part.reasoning === undefined ? {} : { reasoning: part.reasoning }) }];
    }));
    return Object.values(out).some((v) => typeof v === 'number' && !countNumber(v)) ? undefined : out;
  }
  return counters(event['usage'], { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' }, 'claude.result.usage', 'uncached');
}

const countNumber = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
