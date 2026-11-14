import type { DiagnosticModelUsage, DiagnosticUsage } from '../../toolkit/types.ts';
import { opencodeDbPath, type OpencodeMessage } from '../opencode-db.ts';
import { count, note, row, stageAt, type Row } from './read.ts';
import { addCounters, usageKey, type HostStage, type HostUsageAdapter, type HostUsageFs, type HostUsageQuery, type HostUsageResult, type UsageRow } from './rows.ts';

export const opencode: HostUsageAdapter = {
  sessionEnv: ['OPENCODE_SESSION_ID'],
  read(query, fs) {
    return collect(query, fs);
  },
};

function collect(query: HostUsageQuery, fs: HostUsageFs): HostUsageResult {
  const result: HostUsageResult = { rows: [], notes: {} };
  const notes = result.notes!;
  if (!fs.opencodeMessages) return { rows: [], unavailable: 'read-error:EUNKNOWN' };

  const dbPath = opencodeDbPath(query.home, query.env);
  const read = fs.opencodeMessages(dbPath, query.sessionId, { fromMs: query.startMs, toMs: query.endMs });

  for (const message of read.messages) {
    const hostRow: UsageRow & { stage: HostStage } = {
      stage: stageAt(query.stages, message.createdMs),
      role: message.depth === 0 ? 'host' : 'subagent',
      // Empty parts fail the report gates and render as `—` without another label.
      model: message.model ?? '',
      effort: message.effort,
      depth: message.depth,
      atMs: message.createdMs,
      reasoningInOutput: false,
      input: message.input,
      output: message.output,
    };
    if (message.cacheRead !== undefined) hostRow.cacheRead = message.cacheRead;
    if (message.cacheWrite !== undefined) hostRow.cacheWrite = message.cacheWrite;
    if (message.reasoning !== undefined) hostRow.reasoning = message.reasoning;
    result.rows.push(hostRow);
  }

  // The reader sums skipped messages across the root and its descendants without a role split.
  if (read.skipped > 0) note(notes, 'host', 'unparsed lines', read.skipped);
  if (read.truncated === 'rows') note(notes, 'host', 'read budget reached');
  if (read.truncated === 'sessions') note(notes, 'subagent', 'too many candidates');
  if (read.messages.length === 0) result.unavailable = 'no usage records';
  return result;
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
    else addCounters(total, usage);
  }
  return total;
}

/**
 * Fold DB messages for one delegate session tree into one usage record.
 * Keys carry their own effort (`<model>#<effort>`) so a child running another model or variant keeps its counters.
 */
export function opencodeDbUsage(messages: readonly OpencodeMessage[]): DiagnosticUsage | undefined {
  if (messages.length === 0) return undefined;
  const out: DiagnosticUsage = { input: 0, output: 0, scope: 'invocation', provenance: 'opencode.db.messages', inputSemantics: 'uncached' };
  const models: Record<string, DiagnosticModelUsage> = Object.create(null) as Record<string, DiagnosticModelUsage>;
  const modelList: string[] = [];
  const efforts: (string | null)[] = [];
  for (const message of messages) {
    addCounters(out, message);
    // A null model or effort keeps its part empty, never inherited from another message.
    const key = usageKey(message.model, message.effort);
    const part = models[key] ?? (models[key] = { input: 0, output: 0 });
    addCounters(part, message);
    if (message.model !== null && !modelList.includes(message.model)) modelList.push(message.model);
    efforts.push(message.effort);
  }
  out.models = models;
  if (modelList.length > 0) out.actualModels = modelList.slice(0, 8);
  const firstEffort = efforts[0]!;
  out.actualEffort = efforts.every((effort) => effort === firstEffort) ? firstEffort : null;
  return out;
}
