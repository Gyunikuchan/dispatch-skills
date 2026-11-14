import type { DiagnosticUsage } from '../../toolkit/types.ts';
import { opencodeDbPath } from '../opencode-db.ts';
import { count, note, readErrorReason, row, stageAt, type Row } from './read.ts';
import { addCounters, type HostStage, type HostUsageAdapter, type HostUsageFs, type HostUsageQuery, type HostUsageResult, type UsageRow } from './rows.ts';

export const opencode: HostUsageAdapter = {
  sessionEnv: ['OPENCODE_SESSION_ID'],
  read(query, fs) {
    return collectOpencodeUsage(query, fs);
  },
};

export function collectOpencodeUsage(query: HostUsageQuery, fs: HostUsageFs, options?: { rootRole?: 'host' | 'delegate' }): HostUsageResult {
  const result: HostUsageResult = { rows: [], notes: {} };
  const notes = result.notes!;
  if (query.budget.remaining <= 0) {
    note(notes, 'host', 'read budget reached');
    return result;
  }
  if (!fs.opencodeMessages) return { rows: [], unavailable: 'read-error:EUNKNOWN' };

  const rootRole = options?.rootRole ?? 'host';
  const dbPath = opencodeDbPath(query.home, query.env);
  let read: ReturnType<NonNullable<HostUsageFs['opencodeMessages']>>;
  try {
    read = fs.opencodeMessages(dbPath, query.sessionId, { fromMs: query.startMs, toMs: query.endMs });
  } catch (error) {
    return { rows: [], unavailable: readErrorReason(error) };
  }

  for (const message of read.messages) {
    const hostRow: UsageRow & { stage: HostStage } = {
      stage: stageAt(query.stages, message.createdMs),
      role: message.depth === 0 ? rootRole : 'subagent',
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
